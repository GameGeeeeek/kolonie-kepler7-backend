// Kepler-7 Backend-Server
// Login + Speicher-API (privat/geteilt) + echtes serverseitiges PvP + Berichte + Passwort-Reset per E-Mail
// Läuft als eigener Node-Prozess, NGINX leitet /api/* per Reverse-Proxy hierher weiter.

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3001;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');
const SECRET_FILE = process.env.SECRET_FILE || path.join(__dirname, 'jwt-secret.txt');

// Für Passwort-Reset-E-Mails (siehe ANLEITUNG.md, Abschnitt "Passwort-Reset einrichten")
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Kolonie Kepler-7 <onboarding@resend.dev>';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://gamegeeeeek.de';
const FEEDBACK_EMAIL = process.env.FEEDBACK_EMAIL || 'gamegeeeeek@outlook.de'; // Empfänger für Bug-Reports & Vorschläge aus dem Spiel. Diese eine Adresse darf laut Sascha im Quelltext stehen - sie ist die öffentliche Melde-Adresse des Projekts, keine private Kontaktadresse, und ohne Vorgabe müsste auf dem Pi eine Env-Var gesetzt werden, damit Meldungen überhaupt per Mail ankommen. Fehlt sie (leer gesetzt), wird Feedback weiterhin gespeichert und per Push gemeldet, nur nicht zugestellt.

for (const f of [DB_FILE, SECRET_FILE]) {
  const dir = path.dirname(f);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadOrCreateSecret() {
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}
const JWT_SECRET = loadOrCreateSecret();

// --- Push-Benachrichtigungen (Web Push / VAPID) ---
// Schlüsselpaar wird beim allerersten Start automatisch erzeugt und dauerhaft gespeichert (gleiches
// Muster wie das JWT-Secret oben) - kein manueller Schritt auf dem Server nötig.
const webpush = require('web-push');
const VAPID_PUBLIC_FILE = process.env.VAPID_PUBLIC_FILE || path.join(__dirname, 'vapid-public.txt');
const VAPID_PRIVATE_FILE = process.env.VAPID_PRIVATE_FILE || path.join(__dirname, 'vapid-private.txt');
function loadOrCreateVapidKeys() {
  if (fs.existsSync(VAPID_PUBLIC_FILE) && fs.existsSync(VAPID_PRIVATE_FILE)) {
    return { publicKey: fs.readFileSync(VAPID_PUBLIC_FILE, 'utf8').trim(), privateKey: fs.readFileSync(VAPID_PRIVATE_FILE, 'utf8').trim() };
  }
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_PUBLIC_FILE, keys.publicKey, { mode: 0o600 });
  fs.writeFileSync(VAPID_PRIVATE_FILE, keys.privateKey, { mode: 0o600 });
  return keys;
}
const VAPID_KEYS = loadOrCreateVapidKeys();
// VAPID-Subject: laut Spezifikation ist eine mailto:- ODER https-Adresse zulässig. Bewusst die
// öffentliche Spiel-Adresse - sie hängt an keiner Konfiguration und kann deshalb nie leer sein.
// Vorher stand hier 'mailto:' + FEEDBACK_EMAIL; wird diese Variable per Env auf leer gesetzt,
// entstünde daraus ein ungültiges 'mailto:', das der Push-Dienst zurückweist.
webpush.setVapidDetails(PUBLIC_URL, VAPID_KEYS.publicKey, VAPID_KEYS.privateKey);

function loadDb() {
  if (!fs.existsSync(DB_FILE)) return { users: {}, private: {}, shared: {}, resetTokens: {} };
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!d.resetTokens) d.resetTokens = {};
    return d;
  } catch (e) { console.error('DB konnte nicht gelesen werden, starte mit leerer DB:', e); return { users: {}, private: {}, shared: {}, resetTokens: {} }; }
}
let db = loadDb();

// saveDb() mit In-Flight-Coalescing: Bisher reihte jeder Aufruf einen EIGENEN vollständigen Schreib-
// vorgang der gesamten db.json in eine Kette - bei mehreren gleichzeitigen Requests also N teure
// JSON.stringify+write-Durchläufe. Jetzt läuft immer nur EIN Schreibvorgang; alle Aufrufe, die während
// eines laufenden Writes eintreffen, werden zu genau EINEM Folge-Write zusammengefasst (der den dann
// aktuellsten db-Stand schreibt). Kein künstlicher Delay im Leerlauf, und die await-Semantik bleibt
// erhalten: das zurückgegebene Promise löst erst auf, nachdem ein Write gelaufen ist, der die
// Änderung des Aufrufers enthält (der Waiter wird frühestens vom nächsten startenden Write eingelöst).
let saveInFlight = false;
let saveWaiters = [];
function performDbWrite() {
  saveInFlight = true;
  const claimed = saveWaiters;
  saveWaiters = [];
  const data = JSON.stringify(db); // Snapshot des aktuellen Standes (synchron, enthält alle bisherigen Mutationen)
  const tmp = DB_FILE + '.tmp';
  const finish = (err) => {
    if (err) console.error('DB-Speichern fehlgeschlagen:', err);
    saveInFlight = false;
    claimed.forEach(r => r());
    // Kamen während des Schreibens neue saveDb()-Aufrufe rein? Dann genau EIN weiterer Write.
    if (saveWaiters.length) performDbWrite();
  };
  fs.writeFile(tmp, data, (err) => {
    if (err) return finish(err);
    fs.rename(tmp, DB_FILE, (err2) => finish(err2));
  });
}
function saveDb() {
  return new Promise((resolve) => {
    saveWaiters.push(resolve);
    if (!saveInFlight) performDbWrite();
  });
}

const app = express();
// WICHTIG hinter nginx (Reverse Proxy): ohne trust proxy würde req.ip für ALLE Spieler dieselbe
// interne nginx-Adresse zeigen statt der echten Client-IP - ein IP-basierter Rate-Limiter würde dann
// alle Spieler faelschlich als eine einzige Quelle behandeln und sich gegenseitig aussperren lassen.
// "1" = nur dem unmittelbaren ersten Hop (nginx) vertrauen, nicht beliebig vielen dahinterliegenden -
// setzt voraus, dass nginx den X-Forwarded-For-Header korrekt weiterreicht (Standard-Verhalten bei
// proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; - im vorhandenen nginx-Setup bitte
// einmal gegenpruefen, falls Rate-Limiting nicht wie erwartet greift).
app.set('trust proxy', 1);
// CORS auf die eigenen Spiel-Domains beschränken (statt für JEDE Website offen zu stehen). Das Frontend
// wird same-origin über den nginx-Proxy ausgeliefert, braucht also keinen Fremd-Origin-Zugriff. Anfragen
// OHNE Origin-Header (native Apps, curl, Server-zu-Server wie Ko-fi-/GitHub-Webhooks, same-origin) werden
// weiterhin zugelassen - nur fremde Browser-Websites bekommen keinen CORS-Freibrief mehr. Die erlaubten
// Origins lassen sich per Env-Var CORS_ORIGINS (kommagetrennt) überschreiben.
const CORS_ALLOWED = (process.env.CORS_ORIGINS || 'https://www.gamegeeeeek.de,https://gamegeeeeek.de')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || CORS_ALLOWED.includes(origin)) return cb(null, true);
    return cb(null, false); // kein Access-Control-Allow-Origin-Header -> Browser blockt die fremde Seite
  }
}));
// --- Rate-Limiting (13.07.2026, Feature-Wunsch: Vorbereitung auf plötzlichen Ansturm/TikTok-viral) ---
// Bewusst ohne zusätzliche npm-Abhängigkeit (express-rate-limit) - ein einfacher In-Memory-Zähler
// pro IP reicht für einen einzelnen Server voll aus und erspart einen zusätzlichen npm-install-
// Schritt beim Deploy. NICHT für einen Multi-Server-Betrieb hinter einem Load-Balancer gedacht (dort
// bräuchte es einen geteilten Speicher wie Redis) - für den aktuellen Ein-Server-Aufbau passend.
const rateLimitBuckets = new Map();
// Räumt abgelaufene Einträge regelmäßig auf, damit die Map nicht unbegrenzt wächst (jede neue IP
// erzeugt sonst dauerhaft einen Eintrag, auch nach Ablauf des Zeitfensters).
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets.entries()) if (now > bucket.resetAt) rateLimitBuckets.delete(key);
}, 5 * 60 * 1000);
function rateLimit(windowMs, max, message) {
  return (req, res, next) => {
    const key = req.ip + ':' + (req.rateLimitScope || req.path);
    const now = Date.now();
    let bucket = rateLimitBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateLimitBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: message || 'Zu viele Anfragen - bitte kurz warten.' });
    }
    next();
  };
}
// Strenger Login-/Registrierungs-Limiter: verhindert Brute-Force-Passwortraten und Massen-
// Account-Erstellung durch Bots, ohne normale Spieler (die sich vielleicht 2-3x vertippen) zu stören.
const authRateLimit = rateLimit(15 * 60 * 1000, 15, 'Zu viele Versuche - bitte in ein paar Minuten erneut versuchen.');
// Moderater Angriffs-Limiter: ein Mensch klickt realistisch nicht öfter als alle paar Sekunden auf
// "Angreifen", ein Bot/Skript könnte das aber in einer Schleife tun.
const attackRateLimit = rateLimit(60 * 1000, 20, 'Zu viele Angriffe in kurzer Zeit - bitte kurz warten.');
// Großzügiger, globaler Auffang-Limiter über ALLE API-Routen - greift nur bei echtem Flood/DoS-
// Verhalten, nicht bei normaler Nutzung (auch nicht beim schnellen Wechseln zwischen Tabs).
const globalApiRateLimit = rateLimit(60 * 1000, 240, 'Zu viele Anfragen von dieser Verbindung - bitte kurz warten.');
// --- Automatische Backups ---
// Alle Spielstände liegen in einer einzigen db.json - ein Bug, ein versehentliches Überschreiben
// oder eine Beschädigung würde ALLE Spieler gleichzeitig treffen (siehe Vorfall vom 13.07.2026,
// als ein Frontend-Bug fälschlich wie kompletter Datenverlust aussah). Backups sichern gegen genau
// dieses Szenario ab: alle 30 Minuten + einmal beim Serverstart eine Kopie im selben persistenten
// Volume, älteste Backups über dem Limit werden automatisch gelöscht.
const BACKUP_DIR = path.join(path.dirname(DB_FILE), 'backups');
const BACKUP_RETENTION = 48; // ca. 1 Tag bei 30-Minuten-Takt
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
function backupDb() {
  try {
    if (!fs.existsSync(DB_FILE)) return; // beim allerersten Start evtl. noch keine DB vorhanden
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `db-${ts}.json`);
    fs.copyFileSync(DB_FILE, dest);
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('db-') && f.endsWith('.json')).sort();
    while (files.length > BACKUP_RETENTION) {
      const oldest = files.shift();
      fs.unlinkSync(path.join(BACKUP_DIR, oldest));
    }
  } catch (e) { console.error('Backup fehlgeschlagen:', e); }
}
backupDb();
setInterval(backupDb, 30 * 60 * 1000);
setInterval(() => { saveDb(); }, 5 * 60 * 1000);
// verify-Callback speichert den ROHEN Body zusätzlich (req.rawBody) - wird für die
// GitHub-Webhook-Signaturprüfung gebraucht, da express.json() den Body normalerweise nur geparst
// bereitstellt. Für alle anderen Routen ändert sich dadurch nichts.
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use('/api', globalApiRateLimit);

// --- Sitzungs-Cookie (Sicherheits-Audit P3, Etappe a: 19.08.2026) ---------------------------
// Der Token liegt im Frontend in localStorage und ist damit in JS-Reichweite: Die erste
// XSS-Luecke, die je entsteht, ist sofort eine vollstaendige Kontouebernahme. Diese Etappe
// bereitet die Behebung vor - sie legt den Token ZUSAETZLICH in ein HttpOnly-Cookie, das
// JavaScript gar nicht erst lesen kann.
//
// SIE IST FUER SICH GENOMMEN KEIN SICHERHEITSGEWINN, und das gehoert klar gesagt: Solange das
// Frontend den Token weiter in localStorage legt und per Bearer schickt, ist die Angriffsflaeche
// unveraendert. Der Gewinn entsteht erst mit Etappe b im Frontend. Was diese Etappe leistet, ist
// die REIHENFOLGE: Sie ist rein additiv und aendert fuer jeden bestehenden Client exakt nichts -
// sie darf also jederzeit allein live gehen, auch wenn die Auslieferung gerade auseinanderlaeuft.
// Etappe b darf das NICHT: Ein Frontend, das nur noch auf das Cookie setzt, waere gegen einen
// Server ohne diesen Block sofort abgemeldet - jeder Spieler, gleichzeitig. Genau deshalb diese
// Teilung und nicht ein einzelner grosser Umbau.
const SESSION_COOKIE = 'kepler7_sid';
// 180 Tage, dieselbe Frist wie das JWT selbst - ein Cookie, das frueher ablaeuft als sein Token,
// meldet den Spieler ohne erkennbaren Grund ab.
const SESSION_COOKIE_MAX_AGE = 180 * 24 * 60 * 60;

// Eigener Parser statt cookie-parser: Eine neue Abhaengigkeit aendert package.json, und die
// verlangt auf dem Pi zusaetzlich ein `docker restart` von Hand (nodemon installiert nichts nach).
// Fuer das Lesen EINES Namens ist das ein schlechter Tausch.
function leseCookie(req, name) {
  const roh = req.headers.cookie;
  if (!roh) return null;
  for (const teil of roh.split(';')) {
    const i = teil.indexOf('=');
    if (i < 0) continue;
    if (teil.slice(0, i).trim() !== name) continue;
    const wert = teil.slice(i + 1).trim();
    try { return decodeURIComponent(wert); } catch (e) { return wert; }
  }
  return null;
}

// `Secure` haengt an der TATSAECHLICHEN Verbindung (`req.secure`), nicht an einer Konfiguration.
// Der erste Entwurf prüfte `PUBLIC_URL.startsWith('https://')` - das sah nach einer Entscheidung
// aus und war keine: `web-push` verlangt fuer das VAPID-Subject zwingend `https:` oder `mailto:`
// und laesst den Server sonst gar nicht erst starten (gemessen: "Vapid subject is not an https:
// or mailto: URL"). Die Bedingung waere also IMMER wahr gewesen - eine Zeile, die eine Fallun-
// terscheidung behauptet, die es nicht gibt. `req.secure` misst stattdessen, was wirklich
// anliegt, und ist dank `app.set('trust proxy', 1)` auch hinter dem nginx des Pi korrekt.
//
// SameSite=Lax statt Strict: Das Spiel wird auch aus Mails heraus geoeffnet (Bestaetigungs- und
// Reset-Links), und Strict schickt bei genau diesem Aufruf kein Cookie mit.
function cookieTeile(req, wert, maxAge) {
  const teile = [
    SESSION_COOKIE + '=' + wert,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    'Max-Age=' + maxAge
  ];
  if (req.secure) teile.push('Secure');
  return teile.join('; ');
}

function setzeSitzungsCookie(req, res, token) {
  res.append('Set-Cookie', cookieTeile(req, encodeURIComponent(token), SESSION_COOKIE_MAX_AGE));
}

function loescheSitzungsCookie(req, res) {
  // Erst jede schon angehaengte Zeile FUER DIESES COOKIE wegwerfen, dann die Loeschung setzen.
  // Der Grund ist gemessen (test_logout_cookie_http.js 8, 19.08.2026): Die Cookie-Nachreichung in
  // authMiddleware feuert auch auf "Alle Sitzungen beenden" - dort kommt ein Bearer ohne Cookie
  // an. Die Antwort trug danach ZWEI Set-Cookie-Zeilen: erst eine frische Sitzung ueber 180 Tage,
  // dann deren Loeschung. Welche am Ende gewinnt, entscheidet die Reihenfolge im Browser; darauf
  // zu bauen waere in einer Abmeldung der falsche Ort. Wer dieses Cookie loescht, meint es - und
  // nichts weiter oben in derselben Antwort darf ihm widersprechen. Das gilt ab jetzt fuer jede
  // kuenftige Route, nicht nur fuer die beiden von heute.
  const bisher = res.getHeader('Set-Cookie');
  const behalten = (Array.isArray(bisher) ? bisher : (bisher ? [bisher] : []))
    .filter(z => !String(z).startsWith(SESSION_COOKIE + '='));
  res.setHeader('Set-Cookie', behalten.concat(cookieTeile(req, '', 0)));
}

/* ===== Aktivitaets-Uhr je Konto (28.08.2026, Auftrag Sascha: "da ist ein Spieler, der ist
   wirklich Tag und Nacht online - kann man nachvollziehen, ob da ein Bot dahintersteckt?") =====

   WAS SIE MISST - und was ausdruecklich NICHT.

   Das Spiel hat ein Offline-Fenster von 8 Stunden (mit vollem Autonomiekern hoechstens 14). Wer
   den Tab schliesst und 24 h wegbleibt, verliert zehn Stunden Produktion; wer ihn offen laesst,
   verliert nichts, und der Autosave schreibt dabei alle 10 Sekunden. "Immer online" ist in diesem
   Spiel also das rational richtige Verhalten und beweist gar nichts - es misst nur, ob jemand
   einen Browser-Tab schliesst.

   Die Uhr zaehlt deshalb NICHT die Anwesenheit, sondern die HANDLUNG: in welchen Stunden dieses
   Konto etwas getan hat, das eine Bedienung erfordert. Ein Mensch schlaeft; eine Pause von fuenf
   bis neun Stunden am Stueck ist der Normalfall. Erst eine Pause nahe null ueber viele Tage ist
   nicht mehr menschlich erklaerbar - und selbst dann bleiben zwei harmlose Erklaerungen, die man
   kennen muss: ein geteiltes Konto (zwei Personen, ein Login) und ein Konto, das auf zwei Geraeten
   in verschiedenen Zeitzonen laeuft. Die Uhr ist ein Hinweis, kein Beweis.

   WARUM SIE IN authMiddleware HAENGT und nicht an einer Liste von Routen: Eine Positivliste findet
   nur, woran man beim Schreiben gedacht hat (Frontend-Arbeitsregel 40) - eine neue Angriffsroute
   waere still nicht dabei. Hier ist die Regel umgedreht: Gezaehlt wird JEDE Nicht-GET-Anfrage eines
   angemeldeten Kontos, ausser den wenigen, die der Client von selbst feuert.

   DIE AUSNAHMELISTE IST GEMESSEN, nicht aus dem Quelltext geraten: Das Spiel lief im Browser
   90 und 240 Sekunden ohne eine einzige Bedienung, mit Handelsrouten und Allianz im Spielstand.
   Von selbst feuern genau drei Dinge - und das mittlere haette ich nie erraten:
     PUT  /api/storage/*            27x in 240 s  (Autosave, alle ~9 s)
     POST /api/pending-rewards/claim 17x in 240 s  (alle ~14 s - NICHT nur beim Start)
     POST /api/reminders              1x           (beim Boot)
   Alles andere unter Nicht-GET ist eine Bedienhandlung. Wer hier eine Automatik ergaenzt, misst
   sie genauso nach, statt sie zu vermuten - `tests/test_aktivitaetsuhr_http.js` 1c haelt die Form
   der Liste fest.

   /api/analytics/event steht bewusst NICHT in der Uhr, obwohl es nur bei Bedienung feuert: Es ist
   klientengemeldet und damit faelschbar. Ein Bot, der es unterschlaegt, saehe untaetig aus; einer,
   der es schickt, saehe menschlich aus - es traegt in keiner Richtung etwas bei. Die Uhr zeigt nur,
   was der Server SELBST ausgefuehrt hat (dieselbe Grenze wie beim Sternenstaub).

   ABLAGE: am Nutzerobjekt, nicht im Spielstand - der ist klientenautoritativ und in fuenf Sekunden
   gefaelscht. Je Tag eine 24-Bit-Zahl (Bit n = Stunde n UTC), 14 Tage; das sind rund 30 Byte je
   Konto. GESPEICHERT WIRD NICHT EIGENS: wie die Analytics laeuft die Uhr im Speicher mit und wird
   vom naechsten ohnehin anfallenden saveDb() mitgenommen. Die zaehlenden Routen (Angriff, Schlag,
   Handel) speichern ohnehin; ein eigener Schreibzugriff je Anfrage waere der teuerste Weg zum
   selben Ergebnis. Ein harter Absturz kann die letzte Stunde kosten - das ist verschmerzbar,
   und es steht hier, damit niemand die Uhr fuer lueckenlos haelt. */
const AKTIV_TAGE = 14;
const AKTIV_AUSNAHMEN = [
  { start: '/api/storage/',            grund: 'Autosave, alle ~9 s ohne jede Bedienung' },
  { pfad:  '/api/pending-rewards/claim', grund: 'laeuft im Takt, gemessen alle ~14 s' },
  { pfad:  '/api/reminders',           grund: 'einmal beim Boot' },
  { pfad:  '/api/analytics/event',     grund: 'klientengemeldet und damit faelschbar' }
];
function aktivTagesschluessel(zeit) { return new Date(zeit || Date.now()).toISOString().slice(0, 10); }
function aktivGezaehlt(methode, pfad) {
  if (!methode || methode === 'GET' || methode === 'HEAD' || methode === 'OPTIONS') return false;
  for (const a of AKTIV_AUSNAHMEN) {
    if (a.pfad && pfad === a.pfad) return false;
    if (a.start && pfad.startsWith(a.start)) return false;
  }
  return true;
}
function aktivVermerken(user, zeit) {
  if (!user) return;
  const t = zeit || Date.now();
  const k = aktivTagesschluessel(t);
  if (!user.aktiv || typeof user.aktiv !== 'object') user.aktiv = {};
  const stunde = new Date(t).getUTCHours();
  user.aktiv[k] = (user.aktiv[k] || 0) | (1 << stunde);
  // Aufraeumen an derselben Stelle, an der geschrieben wird - kein Cron, dasselbe Muster wie bei
  // user.marktTag und user.staub. Verglichen wird als Zeichenkette; ISO-Datumsschluessel sind
  // dafuer sortierbar, ein Date-Parse je Eintrag waere hier nur teurer.
  const aeltester = aktivTagesschluessel(t - AKTIV_TAGE * 86400000);
  for (const alt of Object.keys(user.aktiv)) if (alt < aeltester) delete user.aktiv[alt];
}
/* Reaktionszeit auf ein Ereignis, das der SERVER erzeugt hat.

   Eine Festung und ein Nest entstehen im galaxyTick und tragen ihren Entstehungszeitpunkt (`seit`).
   Wie lange es danach dauert, bis ein bestimmtes Konto zum ERSTEN Mal zuschlaegt, ist die zweite
   Kennzahl - und sie misst etwas, das die Uhr nicht kann: Ein Mensch muss das Ereignis erst
   bemerken, also die Karte oeffnen; wer regelmaessig binnen Sekunden da ist, fragt den Server im
   Takt ab. Aussagekraft liegt in der WIEDERHOLUNG, nicht im Einzelwert - ein Spieler, der zufaellig
   gerade die Karte offen hat, ist auch mal in zwei Minuten da. Deshalb ein Ringpuffer.

   NUR beim ERSTEN Schlag dieses Kontos auf dieses Ziel (`letzter` ist dann 0), und NUR beim
   Einzelangriff: Beim Verbandsangriff steht die Flotte seit dem Beitritt fest, der Zeitpunkt des
   Ausloesens sagt ueber den Ausloeser nichts. */
const REAKTION_MERKEN = 10;
/* Wertet die Uhr aus. Gibt die Stundenreihe zurueck UND die eine Zahl, auf die es ankommt:
   die laengste zusammenhaengende Pause.

   Gerechnet wird ausdruecklich ERST AB DER ERSTEN aufgezeichneten Stunde. Die Uhr faengt mit ihrer
   Auslieferung an zu schreiben; ohne diesen Anfang zaehlten die Jahre davor als eine gewaltige
   Pause, und jedes Konto saehe menschlich aus - eine Pruefung, die aus dem falschen Grund gruen
   ist (Frontend-Arbeitsregel 28). Solange weniger als 24 Stunden beobachtet sind, traegt die
   Aussage nicht, und `belastbar` sagt das. */
function aktivAuswerten(user, jetzt) {
  const t = jetzt || Date.now();
  const karte = (user && user.aktiv) || {};
  const stunden = [];
  for (let i = AKTIV_TAGE * 24 - 1; i >= 0; i--) {
    const z = t - i * 3600000;
    const maske = karte[aktivTagesschluessel(z)] || 0;
    stunden.push((maske >> new Date(z).getUTCHours()) & 1 ? 1 : 0);
  }
  const ersteAktive = stunden.indexOf(1);
  if (ersteAktive < 0) return { stunden, aktiv: 0, beobachtet: 0, laengstePause: null, belastbar: false };
  const beobachtet = stunden.length - ersteAktive;
  let pause = 0, max = 0, aktiv = 0;
  for (let i = ersteAktive; i < stunden.length; i++) {
    if (stunden[i]) { aktiv++; pause = 0; } else { pause++; if (pause > max) max = pause; }
  }
  return { stunden, aktiv, beobachtet, laengstePause: max, belastbar: beobachtet >= 24 };
}
function reaktionVermerken(user, art, sekunden) {
  if (!user || !(sekunden >= 0)) return;
  if (!Array.isArray(user.reaktionen)) user.reaktionen = [];
  user.reaktionen.push({ zeit: Date.now(), art, sek: Math.round(sekunden) });
  if (user.reaktionen.length > REAKTION_MERKEN) user.reaktionen = user.reaktionen.slice(-REAKTION_MERKEN);
}

function authMiddleware(req, res, next) {
  // Der Bearer-Header hat VORRANG vor dem Cookie, nicht umgekehrt. Grund: Solange Etappe a und b
  // auseinander liegen, traegt ein Browser beides - und massgeblich muss das sein, was das
  // Frontend bewusst mitschickt. Ein alter Cookie-Rest wuerde sonst ein frisch angemeldetes
  // Geraet ueberstimmen und den Spieler mit einer fremden Sitzung weiterlaufen lassen.
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : leseCookie(req, SESSION_COOKIE);
  if (!token) return res.status(401).json({ error: 'Nicht angemeldet.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Sperr-Prüfung (13.07.2026, Feature-Wunsch: Moderation vorbereiten) - läuft bei JEDER
    // authentifizierten Anfrage, nicht nur beim Login: ein bereits ausgestelltes Token (180 Tage
    // gültig, wird sonst nie serverseitig invalidiert - siehe Kommentar bei /api/login) würde eine
    // Sperrung sonst erst beim nächsten Login-Versuch wirksam werden lassen, nicht sofort.
    const user = findUserById(payload.userId);
    if (user && user.banned) return res.status(403).json({ error: 'Dieses Konto wurde gesperrt.' });
    // Token-Versions-Prüfung: nach einem Passwort-Reset zählt user.tokenVersion hoch, wodurch ältere
    // Tokens (mit kleinerem tv) ungültig werden - ein gestohlenes/geleaktes Token verliert so beim
    // Passwortwechsel sofort seine Gültigkeit, statt bis zu 180 Tage weiterzuleben. Fehlende Felder
    // (Bestandskonten / alte Tokens) gelten beidseitig als 0, bleiben also gültig.
    if (user && (user.tokenVersion || 0) !== (payload.tv || 0)) {
      return res.status(401).json({ error: 'Sitzung abgelaufen oder ungültig.' });
    }
    // Sitzungs-Prüfung (25.07.2026): pro Konto ist immer nur EINE Sitzung aktiv. Jede Anmeldung
    // vergibt eine neue Sitzungs-ID (user.activeSessionId) und schreibt sie als sid ins Token; ein
    // Token mit abweichender/fehlender sid gehört damit zu einem älteren Gerät und wird hier
    // abgewiesen. Das Frontend erkennt sessionSuperseded und meldet das alte Gerät sauber ab -
    // vorher liefen zwei Geräte parallel weiter und überschrieben sich gegenseitig den Spielstand.
    // Bestandskonten, die sich seit dem Update noch nie angemeldet haben, haben kein
    // activeSessionId und bleiben mit ihrem alten (sid-losen) Token gültig - der Umstieg passiert
    // beim nächsten Login von selbst, niemand wird durch das Deployment ausgeloggt.
    if (user && user.activeSessionId && payload.sid !== user.activeSessionId) {
      return res.status(401).json({
        error: 'Dieses Konto ist inzwischen auf einem anderen Gerät angemeldet.',
        sessionSuperseded: true
      });
    }
    // Cookie-Nachreichung fuer Bestandssitzungen (Etappe b). Wer sich vor dem 19.08.2026 zuletzt
    // angemeldet hat, traegt seinen Token nur in localStorage - dort, wo die erste XSS-Luecke ihn
    // abholen wuerde. Ohne diese drei Zeilen kaeme er da erst wieder heraus, wenn er sich von
    // sich aus neu anmeldet; das JWT laeuft 180 Tage, die Behebung haette also ein halbes Jahr
    // gebraucht. Hier holt der Server sie beim naechsten Seitenaufruf von selbst nach.
    //
    // NUR wenn gar kein Cookie anliegt: Ein vorhandenes zu ueberschreiben koennte sonst eine
    // frische Anmeldung durch einen aelteren Bearer-Rest ersetzen. Die Sitzung ist an dieser
    // Stelle vollstaendig geprueft (Signatur, Sperre, tokenVersion, sid) - es wandert also nichts
    // ins Cookie, was nicht ohnehin gerade eine Anfrage beantworten darf.
    if (header.startsWith('Bearer ') && !leseCookie(req, SESSION_COOKIE)) {
      setzeSitzungsCookie(req, res, token);
    }
    req.userId = payload.userId;
    req.username = payload.username;
    // Aktivitaets-Uhr (siehe den Block ueber dieser Funktion). Steht HINTER der
    // vollstaendigen Pruefung: Ein abgewiesener Aufruf ist keine Handlung dieses Kontos.
    if (user && aktivGezaehlt(req.method, req.path)) aktivVermerken(user);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sitzung abgelaufen oder ungültig.' });
  }
}

function findUserById(userId) {
  return Object.values(db.users).find(u => u.userId === userId) || null;
}
// Muss exakt der Frontend-Formel commanderLevel(xp) entsprechen (siehe weltraum_kolonie.html) -
// wird für die Level-5-Schwelle beim verzögerten Freunde-einladen-Bonus gebraucht.
function commanderLevelFromXp(xp) {
  return Math.floor(Math.sqrt((xp || 0) / 50));
}
const REFERRAL_LEVEL_THRESHOLD = 5;
// Werbe-Meilensteine für den Einladenden: zusätzlich zum +50-Kredite-Bonus je Einladung gibt es bei
// bestimmten Gesamtzahlen geworbener Spieler eine spürbare Extra-Belohnung. Nutzt das ohnehin getrackte
// referralCount; da es je Einlösung um genau 1 steigt, feuert jeder Meilenstein exakt einmal.
const REFERRAL_MILESTONES = [
  { n: 3,  credits: 500,  fragments: 3 },
  { n: 5,  credits: 1200, fragments: 6 },
  { n: 10, credits: 3000, fragments: 15 },
  { n: 25, credits: 8000, fragments: 40 }
];
function referralMilestoneFor(count) { return REFERRAL_MILESTONES.find(m => m.n === count) || null; }

// --- Wortfilter (13.07.2026, Feature-Wunsch: Moderation vorbereiten) ---
// Moderate Liste eindeutig unangemessener Begriffe (gängige Beleidigungen, bekannte Hassbegriffe,
// NS-Bezug) für Spieler-/Allianznamen. Bewusst kein Anspruch auf Vollständigkeit oder Perfektion -
// ein einfacher Wortfilter lässt sich immer mit Sonderzeichen/Zahlen umgehen, das Ziel ist ein
// Deterrent gegen offensichtlich unangemessene Namen, kein umfassender Moderationsersatz (dafür gibt
// es die Melde-Funktion). Normalisiert Groß-/Kleinschreibung sowie gängige Leetspeak-Ersetzungen
// (0→o, 1→i, 3→e, 4→a, 5→s, @→a) vor dem Vergleich.
const BANNED_TERMS = [
  'hurensohn', 'wichser', 'fotze', 'nazi', 'hitler', 'ss-', 'kanake', 'neger', 'nigger',
  'schwuchtel', 'missgeburt', 'untermensch', 'fuck', 'nutte', 'bimbo', 'zigeuner'
];
function containsBannedTerm(text) {
  if (!text) return false;
  const normalized = String(text).toLowerCase()
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/@/g, 'a')
    .replace(/[^a-zäöüß]/g, '');
  return BANNED_TERMS.some(term => normalized.includes(term));
}

// --- Mengenschutz für den geteilten Speicher (25.07.2026) ---
// db.shared lag komplett im Arbeitsspeicher und wurde bei jedem saveDb() als eine JSON-Datei neu
// geschrieben - ohne jede Obergrenze: weder für die Größe eines einzelnen Wertes noch für die Zahl
// der Schlüssel. Die einzigen Schranken waren express.json({limit:'2mb'}) pro Anfrage und der
// globale 240/min-Ratenbegrenzer je IP. Ein Konto in einer Schleife (böswillig oder schlicht ein
// Client-Bug) konnte die Datei damit unbegrenzt wachsen lassen - und das trifft nicht ein Konto,
// sondern Arbeitsspeicher, Speicherdauer und Plattenplatz des ganzen Servers.
//
// Wichtig für die Auslegung: Ein ÜBERSCHREIBEN vorhandener Schlüssel lässt den Speicher nicht
// wachsen - das ist die normale Spielschleife (Bestenlisten-Eintrag, Allianzdokumente, Missionen).
// Gedeckelt wird deshalb nur das ANLEGEN neuer Schlüssel. Selbst am harten Deckel bleibt das Spiel
// dadurch bedienbar, statt komplett zu blockieren.
const MAX_SHARED_VALUE_BYTES = 64 * 1024;   // größte echte Nutzlast (Allianzdokumente) liegt weit darunter
const MAX_SHARED_KEYS = 200000;             // harte Notbremse, blockiert nur neue Schlüssel

// Chat-Nachrichten legen JE NACHRICHT einen eigenen geteilten Schlüssel an (globalchat:msg:<id>,
// alliance:<TAG>:msg:<id>) und wurden nirgends aufgeräumt - der eigentliche Wachstumstreiber im
// NORMALEN Betrieb, ganz ohne Angreifer. 300 statt 100 seit dem 28.08.2026 (Chat-Großetappe):
// Bis dahin las der Client ohnehin nur die neuesten 50 Schlüssel je Kanal, und die 100 lagen klar
// über allem Sichtbaren. Seit dem Bündel-Abruf (GET /api/chat/:kanal, siehe dort) kann das Panel
// über „Ältere anzeigen" bis zur vollen Tiefe lesen - und zwar in EINER Antwort statt je Schlüssel
// einzeln, das alte Größenargument (jede Abfrage überträgt alles mit) gilt also nicht mehr. Die
// Obergrenze des Bündel-Abrufs hängt an DIESER Konstante; wer sie ändert, ändert beides zugleich.
const CHAT_KEEP_PER_CHANNEL = 300;
// Sortiert nach dem Zeitstempel AUS DEM SCHLÜSSEL (Format "<Date.now()>-<zufall>"), nicht
// lexikografisch - sonst stünde "9..." vor "10...", sobald die Millisekunden eine Stelle zulegen.
function chatKeyTimestamp(key) {
  const id = key.slice(key.lastIndexOf(':') + 1);
  const ts = parseInt(id, 10);
  return Number.isFinite(ts) ? ts : 0;
}
function pruneChatKeys() {
  const kanaele = new Map();
  for (const k of Object.keys(db.shared)) {
    const i = k.lastIndexOf(':msg:');
    if (i < 0) continue;
    const prefix = k.slice(0, i + 5);
    if (!kanaele.has(prefix)) kanaele.set(prefix, []);
    kanaele.get(prefix).push(k);
  }
  let geloescht = 0;
  for (const [, keys] of kanaele) {
    if (keys.length <= CHAT_KEEP_PER_CHANNEL) continue;
    keys.sort((a, b) => chatKeyTimestamp(a) - chatKeyTimestamp(b));
    for (const k of keys.slice(0, keys.length - CHAT_KEEP_PER_CHANNEL)) { delete db.shared[k]; geloescht++; }
  }
  if (geloescht) console.log('[shared-prune] ' + geloescht + ' alte Chat-Schlüssel entfernt');
  return geloescht;
}

// --- Allianz-Berechtigungen ---
// Das Allianz-System läuft komplett über den generischen geteilten Speicher (alliance:<TAG>:...) -
// der lief bisher OHNE jede serverseitige Rechte-Prüfung, jedes eingeloggte Konto konnte JEDEN
// geteilten Schlüssel lesen/schreiben (die Admin-Beschränkung im Frontend war rein kosmetisch und
// z.B. über die Browser-Konsole trivial umgehbar - Bug-Report 13.07.2026: jedes Mitglied konnte den
// Allianz-Banner ändern). Die folgenden Funktionen kapseln die Prüfung an einer Stelle und werden
// unten in GET/PUT /api/storage/:key sowie GET /api/storage-list für alliance:-Schlüssel angewendet.
// Rollen: 'admin' (Gründer, alle Rechte) > 'officer' (alles außer Allianz-Einstellungen und
// Admin/Offizier-Ernennung/-Entfernung) > 'member'. Bewusst NICHT auf alle alliance:-Unterressourcen
// ausgeweitet (z.B. Chat/Beiträge/Kriege bleiben wie bisher offen für alle Mitglieder) - nur die
// tatsächlich sicherheitsrelevanten: info, banner, role, applications, auditlog.
function allianceRoleOf(tag, userId) {
  const raw = db.shared['alliance:' + tag + ':role:' + userId];
  if (typeof raw !== 'string') return null;
  try {
    const r = JSON.parse(raw);
    return (r.role && r.role !== 'left') ? r.role : null;
  } catch (e) { return null; }
}
function allianceHasAdmin(tag) {
  const prefix = 'alliance:' + tag + ':role:';
  for (const k of Object.keys(db.shared)) {
    if (!k.startsWith(prefix)) continue;
    try { if (JSON.parse(db.shared[k]).role === 'admin') return true; } catch (e) {}
  }
  return false;
}
// Wie allianceHasAdmin, aber schließt eine bestimmte Person aus - genutzt, um zu prüfen, ob JEMAND
// ANDERES außer dem gerade austretenden/zurücktretenden Admin noch die Führung übernehmen kann.
function allianceHasOtherAdmin(tag, excludeUserId) {
  const prefix = 'alliance:' + tag + ':role:';
  for (const k of Object.keys(db.shared)) {
    if (!k.startsWith(prefix)) continue;
    const userId = k.slice(prefix.length);
    if (userId === excludeUserId) continue;
    try { if (JSON.parse(db.shared[k]).role === 'admin') return true; } catch (e) {}
  }
  return false;
}
// Den Allianz-Tag finden, in dem diese Person Admin ist (es gibt für jeden Account höchstens einen -
// man kann nur einer Allianz gleichzeitig angehören). Für die wars-Berechtigungsprüfung unten: wenn
// ein Admin einen Krieg erklärt/beendet, schreibt der Client GEGENSEITIG in beide Kriegslisten (siehe
// declareWar()/makePeace() im Frontend), man muss also unabhängig vom Tag der Ziel-Kriegsliste
// herausfinden können, welcher Allianz der schreibende Account selbst vorsteht.
function allianceTagWhereAdmin(userId) {
  const suffix = ':role:' + userId;
  for (const k of Object.keys(db.shared)) {
    if (!k.endsWith(suffix)) continue;
    const m = k.match(/^alliance:([^:]+):role:/);
    if (!m) continue;
    try { if (JSON.parse(db.shared[k]).role === 'admin') return m[1]; } catch (e) {}
  }
  return null;
}
// Aktive Mitglieder zählen (jede Rolle außer 'left') - für das Mitgliederlimit.
function allianceMemberCount(tag) {
  const prefix = 'alliance:' + tag + ':role:';
  let n = 0;
  for (const k of Object.keys(db.shared)) {
    if (!k.startsWith(prefix)) continue;
    try { const r = JSON.parse(db.shared[k]); if (r.role && r.role !== 'left') n++; } catch (e) {}
  }
  return n;
}
// userIds aller Admins/Offiziere einer Allianz - für die Bewerbungs-Push-Benachrichtigung.
function allianceAdminsAndOfficers(tag) {
  const prefix = 'alliance:' + tag + ':role:';
  const out = [];
  for (const k of Object.keys(db.shared)) {
    if (!k.startsWith(prefix)) continue;
    try {
      const r = JSON.parse(db.shared[k]);
      if (r.role === 'admin' || r.role === 'officer') out.push(k.slice(prefix.length));
    } catch (e) {}
  }
  return out;
}
// Alle AKTIVEN Mitglieder einer Allianz (Rolle 'left' zaehlt nicht mehr mit - dieselbe Regel wie in
// allianceRoleOf). Die Schluessel sind mit der Konto-userId gebildet, nicht mit einer separaten
// Spieler-Id: Das Frontend setzt state.player.id beim Anmelden auf data.userId.
function allianceMemberIds(tag) {
  const prefix = 'alliance:' + tag + ':role:';
  const out = [];
  for (const k of Object.keys(db.shared)) {
    if (!k.startsWith(prefix)) continue;
    try {
      const r = JSON.parse(db.shared[k]);
      if (r.role && r.role !== 'left') out.push(k.slice(prefix.length));
    } catch (e) {}
  }
  return out;
}
// Minimale Kopie der Kostendaten aus ALLIANCE_TECH_DEFS/ALLIANCE_BUILDING_DEFS im Frontend - nur die
// für die Validierung nötigen Zahlen (Namen/Beschreibungen bleiben reine Frontend-Sache). MUSS bei
// Kostenänderungen im Frontend mitgepflegt werden, sonst lehnt der Server sonst legitime
// Freischaltungen ab (bzw. lässt bei veralteten, zu niedrigen Werten hier zu viel durch).
const ALLIANCE_STRUCTURE_COSTS = {
  a_prod:{cost:32000,costMult:2.0,maxLevel:20}, a_def:{cost:24000,costMult:2.0,maxLevel:20},
  a_atk:{cost:28000,costMult:2.0,maxLevel:20}, a_res:{cost:36000,costMult:2.0,maxLevel:20},
  a_trade:{cost:20000,costMult:2.0,maxLevel:20}, a_storage:{cost:24000,costMult:2.0,maxLevel:20},
  a_speed:{cost:34000,costMult:2.0,maxLevel:20}, a_scanner:{cost:40000,costMult:2.0,maxLevel:20},
  // a_abgrund (Tiefenkartierung) fehlte hier bis zum 01.08.2026 - als einzige der 23
  // Allianz-Strukturen. Die Freischaltpruefung ueberspringt unbekannte Schluessel stillschweigend
  // (`if (!def) continue;`), die Tech wurde also nie gegen die echten Allianzbeitraege validiert,
  // obwohl sie im Frontend voll wirkt. Werte zeichengleich zur Frontend-Definition.
  a_abgrund:{cost:45000,costMult:2.0,maxLevel:20},
  a_atk2:{cost:75000,costMult:2.0,maxLevel:20,requires:'a_atk'}, a_def2:{cost:70000,costMult:2.0,maxLevel:20,requires:'a_def'},
  a_expand1:{cost:60000}, a_expand2:{cost:150000,requires:'a_expand1'}, a_expand3:{cost:350000,requires:'a_expand2'},
  a_expand4:{cost:800000,requires:'a_expand3'}, a_expand5:{cost:2500000,requires:'a_expand4'},
  ab_hq:{cost:40000,costMult:2.0,maxLevel:20}, ab_werft:{cost:48000,costMult:2.0,maxLevel:20},
  ab_bollwerk:{cost:36000,costMult:2.0,maxLevel:20}, ab_lager:{cost:32000,costMult:2.0,maxLevel:20},
  ab_expedition:{cost:44000,costMult:2.0,maxLevel:20},
  ab_forschungszentrum:{cost:80000,costMult:2.0,maxLevel:20,requires:'ab_hq'},
  ab_flotte2:{cost:90000,costMult:2.0,maxLevel:20,requires:'ab_werft'}
};
function allianceContribTotals(tag) {
  const prefix = 'alliance:' + tag + ':contrib:';
  const totals = {};
  for (const k of Object.keys(db.shared)) {
    if (!k.startsWith(prefix)) continue;
    try {
      const doc = JSON.parse(db.shared[k]);
      for (const [techKey, amt] of Object.entries(doc)) totals[techKey] = (totals[techKey] || 0) + (Number(amt) || 0);
    } catch (e) {}
  }
  return totals;
}
// Errechnet denselben "korrekten" unlocked-Zustand wie loadAllianceTechData() im Frontend, rein aus
// den tatsächlichen (server-eigenen) Beitragssummen - Grundlage, um einen geschriebenen Wert zu
// validieren, statt ihn blind zu übernehmen.
function allianceCorrectUnlocked(tag) {
  const totals = allianceContribTotals(tag);
  const out = {};
  // Reihenfolge wichtig: Voraussetzungen (z.B. a_atk vor a_atk2) müssen VOR der abhängigen Tech
  // berechnet sein. Object.entries behält Einfügereihenfolge, und ALLIANCE_STRUCTURE_COSTS ist
  // bereits so sortiert (Tier-1 vor Tier-2), das hier trotzdem defensiv nochmal geprüft statt
  // blind vorausgesetzt.
  for (const [key, def] of Object.entries(ALLIANCE_STRUCTURE_COSTS)) {
    // Bug behoben (13.07.2026): Voraussetzung wurde bisher nur beim Rendern im Frontend geprüft
    // (versteckte den Beitrags-Button), nicht aber bei der tatsächlichen Stufen-/Freischaltungs-
    // Berechnung selbst - ein direkt eingetragener Beitrag zu z.B. "Elite-Flottendoktrin" hätte
    // sofort gewirkt, auch wenn "Vereinte Flottendoktrin" noch gar nicht erforscht war.
    if (def.requires){
      const reqDef = ALLIANCE_STRUCTURE_COSTS[def.requires];
      const reqMet = reqDef && reqDef.maxLevel ? (out[def.requires]||0) > 0 : !!out[def.requires];
      if (!reqMet){ out[key] = def.maxLevel ? 0 : false; continue; }
    }
    const total = totals[key] || 0;
    if (def.maxLevel) {
      let lvl = 0, cumulative = 0, levelCost = def.cost;
      while (lvl < def.maxLevel) {
        cumulative += levelCost;
        if (total < cumulative) break;
        lvl++;
        levelCost = Math.round(levelCost * def.costMult);
      }
      out[key] = lvl;
    } else {
      out[key] = total >= def.cost;
    }
  }
  return out;
}
function allianceInfoOf(tag) {
  const raw = db.shared['alliance:' + tag + ':info'];
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
// Mitgliederlimit ist an die "Allianz-Expansion"-Forschungskette gekoppelt (siehe ALLIANCE_TECH_DEFS
// im Frontend) - Basis 10, jede freigeschaltete Stufe erhöht das erlaubte Maximum. Liest den
// geteilten "unlocked"-Datensatz derselben Allianz. Kein manuelles Admin-Limit mehr (13.07.2026
// entfernt) - der Wert hier IST das tatsächliche Limit, ohne weiteren Vergleich.
const ALLIANCE_EXPANSION_BONUSES = { a_expand1:5, a_expand2:5, a_expand3:8, a_expand4:8, a_expand5:14 };
function allianceMemberLimitMax(tag) {
  let limit = 10;
  try {
    const raw = db.shared['alliance:' + tag + ':unlocked'];
    if (raw) {
      const unlocked = JSON.parse(raw);
      for (const [k, bonus] of Object.entries(ALLIANCE_EXPANSION_BONUSES)) if (unlocked[k]) limit += bonus;
    }
  } catch (e) {}
  return limit;
}
// Rauswurf-Sperrfrist: wer von einem Admin/Offizier explizit entfernt wurde (kickedAt gesetzt,
// anders als freiwilliges Verlassen ohne dieses Feld), kann 24h lang weder erneut beitreten noch
// sich bewerben. Gibt bei aktiver Sperre einen Hinweistext zurück, sonst null.
function checkKickCooldown(tag, userId) {
  const raw = db.shared['alliance:' + tag + ':role:' + userId];
  if (!raw) return null;
  try {
    const r = JSON.parse(raw);
    if (r.role === 'left' && r.kickedAt) {
      const KICK_COOLDOWN_MS = 24 * 60 * 60 * 1000;
      const remain = r.kickedAt + KICK_COOLDOWN_MS - Date.now();
      if (remain > 0) {
        const hours = Math.ceil(remain / 3600000);
        return 'Du wurdest aus dieser Allianz entfernt und kannst erst in ' + hours + ' Stunde' + (hours === 1 ? '' : 'n') + ' wieder beitreten oder dich bewerben.';
      }
    }
  } catch (e) {}
  return null;
}
// Nichtangriffspakt-Schlüssel (Format: pact:<idA>_<idB>, sortiert) - waren bisher komplett offen
// beschreibbar (Bug behoben 13.07.2026): jeder hätte sich einen fingierten "aktiven" Pakt mit einer
// beliebigen (auch nicht zustimmenden) ID eintragen können, für den Friedensdividende-Produktions-
// bonus (+5%/Pakt, gedeckelt bei +10%). Nur die zwei tatsächlich im Schlüssel genannten Parteien
// dürfen jetzt schreiben, ein Angebot muss vom Schreibenden selbst stammen, und "annehmen" (Wechsel
// zu 'active') erfordert ein echtes, noch offenes Angebot der JEWEILS ANDEREN Partei - kein direktes
// Selbst-Eintragen eines "aktiven" Pakts mehr möglich.
function checkPactKeyPermission(req, key, isWrite) {
  if (!key.startsWith('pact:')) return null;
  if (!isWrite) return null; // Lesen bleibt offen (nichts Sensibles, nötig für beide Seiten zur Anzeige)
  const parts = key.slice('pact:'.length).split('_');
  if (parts.length !== 2) return 'Ungültiger Pakt-Schlüssel.';
  const [idA, idB] = parts;
  if (req.userId !== idA && req.userId !== idB) return 'Du bist nicht Teil dieses Pakts.';
  let submitted = null;
  try { submitted = JSON.parse(req.body && req.body.value); } catch (e) { return 'Ungültiges Format.'; }
  if (!submitted || [submitted.a, submitted.b].sort().join('_') !== idA + '_' + idB) return 'Pakt-Parteien stimmen nicht mit dem Schlüssel überein.';
  if (submitted.status === 'offered' && submitted.offeredBy !== req.userId) return 'Du kannst nur selbst ein Angebot machen.';
  if (submitted.status === 'active') {
    let existing = null;
    try { const raw = db.shared[key]; existing = raw ? JSON.parse(raw) : null; } catch (e) {}
    if (!existing || existing.status !== 'offered') return 'Kein offenes Angebot zum Annehmen vorhanden.';
    if (existing.offeredBy === req.userId) return 'Du kannst dein eigenes Angebot nicht selbst annehmen.';
  }
  return null;
}
// Globaler Chat: reine Identitätsprüfung (Bug behoben 13.07.2026) - authorId wurde bisher vom
// Client mitgeschickt und ungeprüft übernommen, jeder hätte sich in fremdem Namen ausgeben können.
function checkChatKeyPermission(req, key, isWrite) {
  if (!key.startsWith('globalchat:msg:')) return null;
  if (!isWrite) return null;
  let submitted = null;
  try { submitted = JSON.parse(req.body && req.body.value); } catch (e) { return 'Ungültiges Format.'; }
  if (!submitted || submitted.authorId !== req.userId) return 'Du kannst nur Nachrichten in deinem eigenen Namen senden.';
  return null;
}
// Ruhmeshalle: rein kosmetisch (kein direkter Belohnungswert), aber gehärtet (13.07.2026) - war
// komplett offen beschreibbar, jeder hätte sich für einen beliebigen Monat als Champion mit
// beliebigem Score eintragen können. Vergangene Monate dürfen nicht mehr verändert werden, der
// aktuelle Monat darf nie über dem tatsächlichen Bestenlisten-Höchstwert liegen (dieser ist seit dem
// Bestenlisten-Fix bereits serverseitig garantiert korrekt).
function checkHallOfFamePermission(req, key, isWrite) {
  if (key !== 'halloffame:records') return null;
  if (!isWrite) return null;
  let submitted = null;
  try { submitted = JSON.parse(req.body && req.body.value); } catch (e) { return 'Ungültiges Format.'; }
  if (!Array.isArray(submitted)) return 'Ungültiges Format.';
  let prevRecords = [];
  try { const raw = db.shared[key]; prevRecords = raw ? JSON.parse(raw) : []; } catch (e) {}
  const prevByMonth = {};
  for (const r of prevRecords) if (r && r.month) prevByMonth[r.month] = r;
  const thisMonth = new Date().toISOString().slice(0, 7);
  for (const r of submitted) {
    if (!r || !r.month || r.month === thisMonth) continue;
    const prev = prevByMonth[r.month];
    if (!prev || prev.score !== r.score || prev.name !== r.name || prev.allianceTag !== r.allianceTag) {
      return 'Vergangene Monate der Ruhmeshalle können nicht verändert werden.';
    }
  }
  const curEntry = submitted.find(r => r && r.month === thisMonth);
  if (curEntry) {
    let maxScore = 0;
    for (const k of Object.keys(db.shared)) {
      if (!k.startsWith('leaderboard:')) continue;
      try { const v = JSON.parse(db.shared[k]); if ((v.score || 0) > maxScore) maxScore = v.score || 0; } catch (e) {}
    }
    if ((curEntry.score || 0) > maxScore) return 'Ruhmeshallen-Eintrag übersteigt den tatsächlichen Bestenlisten-Höchstwert.';
  }
  return null;
}
// moondefense:<playerId>/moonsiegelog:<playerId> (19.07.2026, Härtung): liefen bisher OHNE jede
// Sonderregel - jeder eingeloggte Nutzer konnte den Mondbestand JEDES Spielers direkt überschreiben
// (Monde einfach verschwinden lassen) oder sich einen frei erfundenen Sieges-Logeintrag eintragen.
// Lesen bleibt offen (Ziel-Auswahl für neue Belagerungen braucht das). moonsiegelog: ist NUR noch
// vom Server selbst beschreibbar (Ereignisse kommen ausschließlich aus /api/moonsiege/resolve).
// moondefense: darf weiterhin vom Besitzer selbst beschrieben werden (eigene Mond-Liste bekannt
// geben, siehe publishAllianceBaseDefense-Analogon im Frontend), aber NICHT mehr von fremden
// Accounts - das Entfernen eines zerstörten Mondes passiert jetzt ausschließlich serverseitig.
function checkMoonDefensePermission(req, key, isWrite) {
  if (key.startsWith('moonsiegelog:')) {
    return isWrite ? 'moonsiegelog wird nur vom Server geschrieben.' : null;
  }
  if (key.startsWith('moondefense:')) {
    if (!isWrite) return null;
    const targetId = key.slice('moondefense:'.length);
    return targetId === req.userId ? null : 'Du kannst nur deine eigene Mond-Liste bekannt geben.';
  }
  return null;
}
// missions:<playerId> (10.08.2026, derselbe Audit): die Flottenbewegungen, die die Abhorchposten
// anderer Spieler anzeigen. Lief ebenfalls ohne jede Regel - jeder konnte unter FREMDEM Namen
// beliebige Flottenbewegungen veröffentlichen und damit in den Abhorchposten der ganzen Galaxie
// Angriffe erscheinen lassen, die es nie gab (oder die echten eines Dritten überschreiben).
// Lesen bleibt offen: Die Auswertung, welcher Posten was sieht, macht der Client (loadDetectedFleets)
// und braucht dafür die Liste aller Meldungen.
function checkMissionsKeyPermission(req, key, isWrite) {
  if (!key.startsWith('missions:')) return null;
  if (!isWrite) return null;
  const targetId = key.slice('missions:'.length);
  return targetId === req.userId ? null : 'Du kannst nur deine eigenen Flottenbewegungen melden.';
}
// worldboss:current (10.08.2026, Fund beim Audit des geteilten Speichers): der gemeinsame Weltboss
// lief bisher durch KEINE der Rechteprüfungen - jeder eingeloggte Nutzer konnte das Dokument
// vollständig überschreiben. Die Schadensauflösung ist zwar seit dem 13.07.2026 serverseitig
// (/api/worldboss/resolve), der Schlüssel selbst blieb dabei aber offen. Drei Folgen, alle gemessen
// in tests/test_weltboss_schluessel_http.js:
//   1. Ein Boss mit erfundener Stufe hat 50000*1,6^(Stufe-1) HP (Stufe 200 = 2,08e45) und ist nie
//      tötbar. Da das Frontend einen neuen Boss NUR nach einem Kill setzt (loadWorldBoss), wäre der
//      Weltboss damit für ALLE Spieler dauerhaft erledigt - eine einzige Anfrage genügt.
//   2. In `contributions` ließen sich fremde Konten mit beliebigem Schaden eintragen. Die
//      Auszahlung (Kredite, Kampfpunkte, Modulwurf, Unikat "Leviathanherz") läuft rein im Frontend
//      über maybeClaimWorldBossReward() und liest genau diese Liste.
//   3. `defeatedAt` ließ sich ohne einen einzigen Kampf setzen.
// Der eigene Spielstand ist in diesem Spiel bauartbedingt klientenautoritativ - wer sich SELBST
// bereichern will, braucht dafür keine Lücke hier. Was diese Prüfung schützt, ist der gemeinsame
// Zustand, also dieselbe Grenze wie bei Pakt, Chat, Bestenliste und Mondverteidigung.
//
// Erlaubt bleibt genau das, was das Frontend legitim tut: den ERSTEN Boss anlegen und nach einem
// gefallenen Boss den Nachfolger setzen (beides in loadWorldBoss, die einzigen zwei Aufrufer von
// saveWorldBoss). Alles andere am laufenden Boss - Schaden, Beiträge, Kill - schreibt
// /api/worldboss/resolve direkt in db.shared und läuft an dieser Prüfung ohnehin vorbei.
const WORLDBOSS_BASE_HP = 50000;                  // Spiegel von WORLDBOSS_BASE_HP im Frontend
const WORLDBOSS_RESPAWN_DELAY_MS = 10 * 60 * 1000; // Spiegel von WORLDBOSS_RESPAWN_DELAY_MS
// Zeitzugeständnis für die Respawn-Frist: Die Frist läuft im Frontend gegen die Uhr des SPIELERS.
// Geht die ein paar Sekunden vor, hielte der Server den Respawn sonst für verfrüht und lehnte ihn
// ab. Das wäre kein Beinbruch (loadWorldBoss versucht es beim nächsten Durchlauf erneut), aber es
// gibt keinen Grund, es überhaupt eng zu machen - eine Minute Vorlauf verschenkt nichts.
const WORLDBOSS_RESPAWN_TOLERANZ_MS = 60 * 1000;
function worldBossHpForLevel(level) {
  return Math.round(WORLDBOSS_BASE_HP * Math.pow(1.6, Math.max(0, level - 1)));
}
function checkWorldBossPermission(req, key, isWrite) {
  if (key !== 'worldboss:current') return null;
  if (!isWrite) return null; // Lesen bleibt offen - jeder sieht denselben Boss

  let neu = null;
  try { neu = JSON.parse(req.body && req.body.value); } catch (e) { return 'Ungültiges Format.'; }
  if (!neu || typeof neu !== 'object') return 'Ungültiges Format.';

  let alt = null;
  try { const roh = db.shared[key]; alt = roh ? JSON.parse(roh) : null; } catch (e) {}

  // Welche Stufe darf an dieser Stelle überhaupt geschrieben werden?
  let erlaubteStufe;
  if (!alt || !alt.bossId) {
    erlaubteStufe = 1; // noch nie ein Boss da gewesen
  } else if (alt.defeatedAt && Date.now() - alt.defeatedAt > WORLDBOSS_RESPAWN_DELAY_MS - WORLDBOSS_RESPAWN_TOLERANZ_MS) {
    erlaubteStufe = (alt.level || 1) + 1;
  } else {
    return 'Der laufende Weltboss wird nur über den Kampf verändert.';
  }

  if (typeof neu.bossId !== 'string' || !neu.bossId) return 'Dem Weltboss fehlt eine Kennung.';
  if (neu.level !== erlaubteStufe) return 'Der nächste Weltboss steht auf Stufe ' + erlaubteStufe + '.';
  const sollHp = worldBossHpForLevel(erlaubteStufe);
  if (neu.maxHp !== sollHp || neu.hp !== sollHp) return 'Der Weltboss der Stufe ' + erlaubteStufe + ' startet mit ' + sollHp + ' HP.';
  if (neu.defeatedAt) return 'Ein frisch erschienener Weltboss gilt nicht als besiegt.';
  if (neu.contributions && Object.keys(neu.contributions).length) return 'Ein frisch erschienener Weltboss hat noch keine Beitragenden.';
  return null;
}
// asteroids:<sys> (18.08.2026, Fund beim Entwurf der Asteroidenfestungen): das Gürtelfeld eines
// Systems lief durch KEINE der Rechteprüfungen - es war die einzige Schlüsselfamilie im geteilten
// Speicher ohne Regel (nachgezählt über `grep -o "db.shared\[[^]]*\]"`, entdoppelt).
//
// Gemessen an einem echten Server (tests/test_asteroid_schluessel_http.js), bevor diese Funktion
// existierte: Ein beliebiges zweites Konto schreibt mit EINER Anfrage die Zeichenkette "kaputt"
// auf `asteroids:abyss` und bekommt HTTP 200. Danach ist das Feld weg - astAlleFelder() prüft
// `typeof feld !== 'object'`, findet eine Zeichenkette und erzeugt das Gürtelfeld komplett neu.
// Alle Schürfrechte ALLER Spieler in diesem System sind damit gelöscht, ihre stationierten
// Eskorten stranden. Zwanzig Anfragen räumen die Schürfrechte der ganzen Galaxie ab.
//
// Das ist genau die Grenze, die dieses Projekt verteidigt: "Kann ich etwas anfassen, das ANDEREN
// gehört oder allen gemeinsam?" - hier beides. Dieselbe Klasse wie der Weltboss-Schlüssel darüber.
//
// SCHREIBEN ist deshalb vollständig gesperrt, nicht eingeschränkt: Es gibt keinen legitimen
// Schreibzugriff über die generische Route. Alle echten Schreibwege laufen über eigene Endpunkte
// (/api/asteroid/mine|claim|release|contest|escort), die den Spielstand selbst lesen und die
// Menge selbst begrenzen. Nachgeprüft im Frontend: `storageSet('asteroids:…')` kommt dort NICHT
// vor, die Spieldatei ruft ausschließlich die dedizierten Endpunkte.
// LESEN bleibt offen - der Gürtel ist öffentlich, und /api/asteroid/field liefert ihn ohnehin.
function checkAsteroidKeyPermission(req, key, isWrite) {
  if (!key.startsWith('asteroids:')) return null;
  if (!isWrite) return null;
  return 'Das Asteroidenfeld wird ausschließlich über die Asteroiden-Endpunkte verändert.';
}
// Gibt bei erlaubtem Zugriff null zurück, sonst einen Fehlertext für die 403-Antwort.
function checkAllianceKeyPermission(req, key, isWrite) {
  const m = key.match(/^alliance:([^:]+):(.+)$/);
  if (!m) return null; // kein Allianz-Schlüssel, keine Sonderregel
  const tag = m[1];
  const rest = m[2];
  const myRole = allianceRoleOf(tag, req.userId);
  const isAdmin = myRole === 'admin';
  const isOfficerPlus = myRole === 'admin' || myRole === 'officer';

  if (rest === 'banner') {
    return (isWrite && !isOfficerPlus) ? 'Nur Admins/Offiziere dürfen den Allianz-Banner ändern.' : null;
  }
  if (rest === 'info') {
    if (!isWrite) return null; // Lesen bleibt für alle offen (z.B. Allianzliste)
    const existing = allianceInfoOf(tag);
    const foundable = !existing || existing.disbanded === true; // neu ODER aufgelöst -> Neugründung erlaubt
    if (foundable) return null;
    return isAdmin ? null : 'Nur Admins dürfen die Allianz-Einstellungen ändern.';
  }
  if (rest.startsWith('role:')) {
    const targetId = rest.slice('role:'.length);
    if (!isWrite) return null;
    let requestedRole = null;
    try { requestedRole = JSON.parse(req.body && req.body.value).role; } catch (e) {}
    if (targetId === req.userId) {
      // Eigene Rolle: Beitreten/Verlassen bleibt selbstständig möglich, aber keine Selbst-Beförderung
      // zum Admin - außer man ist laut info.creatorId der tatsächliche Gründer UND es gibt noch
      // KEINEN Admin für diese Allianz (echte Gründung in zwei Schritten: erst info anlegen, dann
      // die eigene Rolle setzen). Ebenso keine Selbst-Beförderung zum Offizier.
      if (requestedRole === 'admin' && !isAdmin) {
        let isFounder = false;
        try {
          const info = allianceInfoOf(tag);
          if (info) isFounder = info.creatorId === req.userId && !info.disbanded;
        } catch (e) {}
        if (!isFounder || allianceHasAdmin(tag)) return 'Du kannst dich nicht selbst zum Admin machen.';
      }
      if (requestedRole === 'officer' && myRole !== 'officer') {
        return 'Du kannst dich nicht selbst zum Offizier machen.';
      }
      // Bug behoben (13.07.2026): der letzte Admin konnte die Allianz jederzeit über den normalen
      // "Verlassen"-Weg (role:'left' für sich selbst) dauerhaft führungslos zurücklassen - niemand
      // hätte je wieder befördern, Einstellungen ändern oder Bewerbungen entscheiden können (außer
      // zufällig der ursprüngliche Gründer kehrt zurück, die einzige eingebaute Notfall-Klausel).
      // Blockiert das jetzt, WENN noch andere Mitglieder da sind (bei einer Ein-Personen-Allianz
      // richtet Verlassen keinen Schaden an, das bleibt erlaubt).
      if (isAdmin && requestedRole !== 'admin' && !allianceHasOtherAdmin(tag, req.userId) && allianceMemberCount(tag) > 1) {
        return 'Du bist der einzige Admin - befördere zuerst jemanden, bevor du gehst oder zurücktrittst, oder löse die Allianz stattdessen auf.';
      }
      // Beitreten (member) als noch-nicht-aktives Mitglied: Rauswurf-Sperrfrist + Mitgliederlimit
      // prüfen. Kein erneuter Check, wenn man ohnehin schon aktives Mitglied ist (z.B. Klient
      // schreibt denselben Zustand nochmal).
      if (requestedRole === 'member' && !myRole) {
        const cooldownMsg = checkKickCooldown(tag, req.userId);
        if (cooldownMsg) return cooldownMsg;
        const limit = allianceMemberLimitMax(tag);
        if (allianceMemberCount(tag) >= limit) return 'Diese Allianz hat ihr Mitgliederlimit erreicht.';
      }
      return null;
    }
    // Rolle eines ANDEREN Spielers ändern:
    if (requestedRole === 'admin' || requestedRole === 'officer') {
      return isAdmin ? null : 'Nur Admins dürfen jemanden zum Admin oder Offizier machen.';
    }
    // Entfernen/Herabstufen zu 'member' oder 'left':
    if (isAdmin) return null;
    const targetRole = allianceRoleOf(tag, targetId);
    if (myRole === 'officer' && (!targetRole || targetRole === 'member')) return null;
    return 'Keine Berechtigung, diese Rolle zu ändern.';
  }
  if (rest.startsWith('applications:')) {
    const targetId = rest.slice('applications:'.length);
    if (isWrite) {
      if (targetId === req.userId) {
        const cooldownMsg = checkKickCooldown(tag, req.userId);
        if (cooldownMsg) return cooldownMsg;
        return null; // eigene Bewerbung einreichen/zurückziehen
      }
      return isOfficerPlus ? null : 'Nur Admins/Offiziere dürfen über Bewerbungen entscheiden.';
    }
    // Lesen einer einzelnen Bewerbung: nur Admin/Offizier der Allianz oder die bewerbende Person selbst
    return (isOfficerPlus || targetId === req.userId) ? null : 'Keine Berechtigung, diese Bewerbung zu sehen.';
  }
  if (rest.startsWith('contrib:')) {
    // Beiträge zu Allianz-Forschung/-Gebäuden: nur echte Mitglieder dürfen schreiben, und jeder nur
    // seinen EIGENEN Beitrags-Datensatz (sonst könnte man beliebige Fantasiebeträge für andere
    // eintragen und so künstlich Fortschritt vortäuschen). Lesen bleibt offen (Gesamtsumme wird
    // clientseitig aus allen Beiträgen aufsummiert, siehe loadAllianceTechData im Frontend).
    if (!isWrite) return null;
    const targetId = rest.slice('contrib:'.length);
    if (targetId !== req.userId) return 'Du kannst nur deinen eigenen Beitrag eintragen.';
    return myRole ? null : 'Nur Mitglieder dieser Allianz dürfen beitragen.';
  }
  if (rest === 'unlocked') {
    // Wird geschrieben, sobald ein Client feststellt, dass die Summe aller Beiträge die Kosten
    // erreicht hat (siehe loadAllianceTechData) - nur echte Mitglieder dürfen das auslösen. Zusätzlich
    // (Bug behoben 13.07.2026): der geschriebene Wert wird gegen die serverseitig aus den echten
    // contrib-Datensätzen berechnete korrekte Stufe geprüft - vorher konnte jedes Mitglied per
    // direktem API-Aufruf (z.B. Browser-Konsole) JEDE Technologie auf JEDE Stufe setzen, ganz ohne
    // jeden Beitrag geleistet zu haben. Ein Wert DARF niedriger sein als korrekt (z.B. während ein
    // anderer Client noch nicht das Update mitbekommen hat), aber nie höher.
    if (!isWrite) return null;
    if (!myRole) return 'Nur Mitglieder dieser Allianz dürfen Freischaltungen auslösen.';
    let claimed = null;
    try { claimed = JSON.parse(req.body && req.body.value); } catch (e) { return 'Ungültiges Format.'; }
    if (!claimed || typeof claimed !== 'object') return 'Ungültiges Format.';
    const correct = allianceCorrectUnlocked(tag);
    for (const [key, val] of Object.entries(claimed)) {
      const def = ALLIANCE_STRUCTURE_COSTS[key];
      if (!def) continue; // unbekannter Schlüssel - ignorieren statt hart abzulehnen (Vorwärtskompatibilität)
      if (def.maxLevel) {
        if ((Number(val) || 0) > (correct[key] || 0)) return 'Stufe übersteigt die tatsächlichen Beiträge für "' + key + '".';
      } else {
        if (val && !correct[key]) return 'Freischaltung übersteigt die tatsächlichen Beiträge für "' + key + '".';
      }
    }
    return null;
  }
  if (rest.startsWith('auditlog')) {
    // Aktivitätsprotokoll: nur Admins/Offiziere schreiben (führen die auditierbaren Aktionen aus)
    // und lesen (interne Angelegenheit der Allianzleitung).
    if (isOfficerPlus) return null;
    return isWrite ? 'Nur Admins/Offiziere dürfen Protokolleinträge schreiben.' : 'Nur Admins/Offiziere dürfen das Protokoll einsehen.';
  }
  if (rest === 'wars') {
    // Bug behoben (Fund vom 13.07.2026, bisher nie gemerged): alliance:<TAG>:wars lief komplett ohne
    // Berechtigungsprüfung - jeder eingeloggte Client konnte per direktem API-Aufruf für eine
    // beliebige fremde Allianz einen Krieg erklären/beenden, unabhängig von der eigenen Rolle.
    if (!isWrite) return null; // Lesen bleibt offen (Kriegsliste ist für alle sichtbar)
    if (isAdmin) return null; // Admin verwaltet die Kriegsliste der eigenen Allianz direkt
    // declareWar()/makePeace() im Frontend tragen einen Krieg GEGENSEITIG in beide Kriegslisten ein -
    // der Admin der bekriegenden/befriedenden Allianz schreibt dafür auch in die FREMDE Kriegsliste
    // alliance:<TAG>:wars (TAG = die von ihm bekriegte Allianz, nicht die eigene). Das ist gewollt,
    // aber nur erlaubt, wenn genau die eigene Allianz im enemies-Array hinzugefügt/entfernt wird -
    // keine andere Änderung an dieser fremden Liste.
    const requesterTag = allianceTagWhereAdmin(req.userId);
    if (!requesterTag) return 'Nur Admins dürfen Kriegs-Listen ändern.';
    let prevEnemies = [], nextEnemies = [];
    try { const pr = db.shared[key]; if (pr) prevEnemies = JSON.parse(pr).enemies || []; } catch (e) {}
    try { nextEnemies = JSON.parse(req.body && req.body.value).enemies || []; } catch (e) { return 'Ungültiges Format.'; }
    const diff = prevEnemies.filter(e => !nextEnemies.includes(e)).concat(nextEnemies.filter(e => !prevEnemies.includes(e)));
    return (diff.length === 1 && diff[0] === requesterTag) ? null : 'Nur Admins dürfen Kriegs-Listen ändern.';
  }
  if (rest.startsWith('warscore:') || rest.startsWith('warcontrib:')) {
    // Allianz-Kriegspunkte: rein kosmetisch (keine direkte Kredit-/Ressourcen-Belohnung daran
    // gebunden), aber aus Konsistenz zu den übrigen Allianz-Ressourcen gehärtet (13.07.2026) - nur
    // echte Mitglieder der Allianz dürfen schreiben, warcontrib zusätzlich nur den eigenen Beitrag.
    if (!isWrite) return null;
    if (!myRole) return 'Nur Mitglieder dieser Allianz dürfen Kriegspunkte eintragen.';
    if (rest.startsWith('warcontrib:')) {
      const parts = rest.split(':'); // warcontrib:<enemyTag>:<playerId>
      const targetId = parts[2];
      if (targetId && targetId !== req.userId) return 'Du kannst nur deinen eigenen Kriegsbeitrag eintragen.';
    }
    return null;
  }
  if (rest === 'raid' || rest.startsWith('raidjoin:')) {
    // Allianz-Raid (19.07.2026, Härtung): Lesen bleibt offen (Sammelphase-Anzeige/Teilnehmerliste),
    // aber Schreiben NUR noch über die dedizierten /api/allianceraid/*-Endpunkte - sonst könnte ein
    // manipulierter Client die dortige Validierung (echte Flotte, serverseitig berechnete
    // Angriffskraft, Belohnungsauflösung) komplett umgehen, indem er einfach direkt hierher
    // schreibt. Ohne diese Sperre wäre die gesamte Härtung der neuen Endpunkte wirkungslos.
    return isWrite ? 'Allianz-Raid-Daten werden nur über die dedizierten Endpunkte geschrieben.' : null;
  }
  // Ab hier (19.07.2026, Fund beim Allianz-Raid-Audit): eine ganze Reihe von alliance:-
  // Unterressourcen lief bisher komplett ohne Sonderregel - schreibbar für JEDEN eingeloggten
  // Nutzer, nicht nur Mitglieder der jeweiligen Allianz. Für die meisten reicht hier (vorerst) ein
  // reiner Mitgliedschafts-/Eigentums-Check (analog contrib:/warscore:/warcontrib: oben) - er
  // verhindert Vandalismus durch fremde Accounts, verhindert aber NICHT, dass ein böswilliges
  // EIGENES Mitglied sich selbst einen erfundenen Wert einträgt (gleiches akzeptiertes Restrisiko
  // wie bei contrib:). musterattack/musterjoin/basewar/incomingmuster bleiben hier bewusst NUR
  // mitgliedschafts-, nicht wertgeprüft - eine vollständige Härtung (serverseitig berechnete
  // Angriffskraft/Schadensauflösung wie beim Allianz-Raid) ist als eigenes, größeres Vorhaben
  // vorgesehen und würde diese Zwischenregel dann ersetzen.
  if (rest === 'base') {
    // Allianzbasis-Dokument (Gründung/Ausbaustufen-Freigabe): granuläre Prüfung "Stufe deckt sich
    // mit echten Beiträgen" wäre wünschenswert (analog unlocked oben), fehlt hier aber noch (eigene
    // Kostentabelle allianceBaseCumCost ist bisher nicht serverseitig gespiegelt) - vorerst
    // zumindest kein Zugriff für Nicht-Mitglieder.
    if (!isWrite) return null;
    return myRole ? null : 'Nur Mitglieder dieser Allianz dürfen die Allianzbasis ändern.';
  }
  if (rest.startsWith('basedef:')) {
    if (!isWrite) return null;
    const targetId = rest.slice('basedef:'.length);
    if (targetId !== req.userId) return 'Du kannst nur deine eigene Basisverteidigung eintragen.';
    return myRole ? null : 'Nur Mitglieder dieser Allianz dürfen Schiffe zur Basisverteidigung melden.';
  }
  if (rest === 'buildready' || rest === 'points' || rest === 'endgameactive' || rest === 'worldactive' || rest === 'paradebest') {
    if (!isWrite) return null;
    return myRole ? null : 'Nur Mitglieder dieser Allianz dürfen das ändern.';
  }
  if (rest.startsWith('donation:')) {
    if (!isWrite) return null;
    const parts = rest.split(':'); // donation:<weekKey>:<playerId>
    const targetId = parts[2];
    if (targetId && targetId !== req.userId) return 'Du kannst nur deine eigene Spende eintragen.';
    return myRole ? null : 'Nur Mitglieder dieser Allianz dürfen Spenden eintragen.';
  }
  if (rest.startsWith('dominance:')) {
    if (!isWrite) return null;
    const targetId = rest.slice('dominance:'.length);
    if (targetId !== req.userId) return 'Du kannst nur deinen eigenen Dominanz-Wert eintragen.';
    return myRole ? null : 'Nur Mitglieder dieser Allianz dürfen das eintragen.';
  }
  if (rest.startsWith('paradesnapshot:')) {
    if (!isWrite) return null;
    const targetId = rest.slice('paradesnapshot:'.length);
    if (targetId !== req.userId) return 'Du kannst nur deine eigene Flotte melden.';
    return myRole ? null : 'Nur Mitglieder dieser Allianz dürfen ihre Flotte für die Parade melden.';
  }
  if (rest === 'msg' || rest.startsWith('msg:')) {
    // Allianz-Chat/System-Neuigkeiten: wird immer nur in die EIGENE Allianz geschrieben (auch die
    // automatischen "Allianzbasis"/"Spendenwertung"-Systemnachrichten laufen über die eigene
    // myAllianceTag()) - kein legitimer Fall, in dem ein Nicht-Mitglied hier schreiben müsste.
    if (!isWrite) return null;
    return myRole ? null : 'Nur Mitglieder dieser Allianz dürfen hier schreiben.';
  }
  if (rest === 'musterattack' || rest.startsWith('musterjoin:') || rest === 'basewar' || rest === 'incomingmuster') {
    // Koordinierter Allianz-Angriff (19.07.2026, vollständige Härtung wie beim Allianz-Raid): Lesen
    // bleibt offen (Sammelphase-Anzeige/Teilnehmerliste/Kriegsbericht), Schreiben nur noch über die
    // dedizierten /api/musterattack/*-Endpunkte. basewar/incomingmuster gehörten VORHER hierher NICHT
    // (der Angreifer schrieb legitim direkt in den Namensraum der angegriffenen fremden Allianz -
    // kein einfacher Mitgliedschafts-Check möglich) - jetzt schreibt dort ausschließlich der Server
    // selbst (innerhalb von /api/musterattack/checkdispatch bzw. /resolve), der generische
    // Speicher-Endpunkt ist für beide komplett gesperrt.
    return isWrite ? 'Musterangriff-Daten werden nur über die dedizierten Endpunkte geschrieben.' : null;
  }
  if (rest.startsWith('sharedintel:')) {
    // Geteilte Aufklärung (Spionage-Vertiefung): ein Mitglied teilt einen Spähbericht mit der eigenen
    // Allianz. Lesen bleibt offen (Mitglieder rufen die gesammelte Aufklärung ab), Schreiben nur für
    // Mitglieder - sonst könnte ein Fremder den Allianz-Namensraum mit gefälschter Aufklärung fluten.
    if (!isWrite) return null;
    return myRole ? null : 'Nur Mitglieder dieser Allianz dürfen Aufklärung teilen.';
  }
  return null; // andere alliance:-Unterressourcen (Chat existiert separat als globalchat:, nicht hier) bleiben wie bisher offen
}

// --- Server-Ereignis-Benachrichtigungen (Vorstufe für Push) ---
// Der generische Key-Value-Speicher (storage/:key) bleibt unverändert die Quelle der Wahrheit für
// Pakte und Weltboss - der Server liest hier bei jedem SHARED-Schreibvorgang bewusstungsvoll mit,
// um daraus Benachrichtigungs-Ereignisse für betroffene Spieler abzuleiten. Kein Client-Code muss
// dafür geändert werden. Überfälle laufen anders (rein lokal beim Spieler) und bekommen einen
// eigenen, expliziten "Erinnere mich"-Endpunkt weiter unten.
function getNotifPrefs(user) {
  const p = (user && user.notifPrefs) || {};
  return {
    enabled: p.enabled !== false,
    messages: p.messages !== false,
    pact: p.pact !== false,
    weltboss: p.weltboss !== false,
    raid: p.raid !== false,
    // 'allianceraid' = Aufruf einer Allianz-Raid-Welle (02.08.2026). Bewusst eine EIGENE Kategorie
    // und nicht unter 'raid' mitgeführt: 'raid' meint den anfliegenden Überfall auf die eigene
    // Kolonie - eine Warnung. Der Allianz-Raid ist das Gegenteil, nämlich eine Einladung, und wer
    // Angriffswarnungen abschaltet, will deshalb nicht zwangsläufig auch die Einladungen los sein.
    allianceraid: p.allianceraid !== false,
    // 'alliancebase' = Angriff auf die Allianzbasis und "Ressourcen der nächsten Stufe vollständig".
    // Getrennt von 'attack' (das ist der Angriff auf die eigene Kolonie): Wer die PvP-Meldungen satt
    // hat, will die gemeinsame Basis trotzdem nicht stillschweigend verlieren.
    alliancebase: p.alliancebase !== false,
    // 'chat' = jemand hat im GLOBALEN Chat geschrieben (10.08.2026, Wunsch Sascha). Eigene
    // Kategorie und bewusst NICHT unter 'messages' geführt: 'messages' ist eine Nachricht AN DICH,
    // der globale Chat ist ein öffentlicher Raum. Wer Direktnachrichten will, will deshalb nicht
    // zwangsläufig jedes Wort im Chat - und umgekehrt.
    chat: p.chat !== false,
    patchnotes: p.patchnotes !== false,
    application: p.application !== false,
    spy: p.spy !== false,
    attack: p.attack !== false,
    leaderboard: p.leaderboard !== false,
    completion: p.completion !== false,
    // 'neuspieler' = ein neu angelegtes Konto hat das Spiel zum ersten Mal geoeffnet (22.08.2026,
    // Auftrag Sascha). Betrifft praktisch nur das Betreiberkonto - aber genau deshalb braucht es
    // die Kategorie: Sascha hat die Buendelung ausdruecklich abgewaehlt ("immer sofort, eine
    // Meldung je Neuling"), und /api/register laesst gemessen 1.440 Konten je Tag und IP zu. Das
    // Postfach haelt 30 Eintraege ohne Bevorzugung; eine Flut verdraengt also feedback-received
    // und player-reported, also den einzigen Meldungskanal, den der Betreiber im Spiel hat. Der
    // Schalter ist die Notbremse fuer genau diesen Fall - er ersetzt keine Drosselung, er macht
    // den Schaden abstellbar.
    neuspieler: p.neuspieler !== false
  };
}
function pushNotificationEvent(userId, type, payload, opts) {
  if (!userId) return;
  if (!db.private[userId]) db.private[userId] = {};
  const list = db.private[userId].__notificationEvents || [];
  list.unshift({ id: crypto.randomUUID(), type, time: Date.now(), payload });
  db.private[userId].__notificationEvents = list.slice(0, 30);
  // opts.skipWebPush: den Postfach-Eintrag trotzdem speichern (volle Historie), aber die echte
  // Handy-Push unterdrücken - genutzt für die Anti-Flut-Drosselung bei wiederholten Angriffen.
  if (!(opts && opts.skipWebPush)) sendWebPushToUser(userId, type, payload); // schluckt eigene Fehler, blockiert nie den Aufrufer
}
// Anti-Push-Flut bei Angriffen (Retention-Feinschliff, 21.07.2026): ein Dauer-Angreifer soll den
// Verteidiger nicht mit Handy-Pushes zuspammen. Gibt true zurück (und merkt sich den Zeitpunkt), wenn
// seit der letzten Angriffs-Push genug Zeit vergangen ist - sonst false (Postfach-Eintrag kommt
// trotzdem, nur die Push wird unterdrückt).
const ATTACK_PUSH_COOLDOWN_MS = 30 * 60 * 1000;
function allowAttackPush(targetUserId) {
  if (!db.private[targetUserId]) db.private[targetUserId] = {};
  const now = Date.now();
  if (now - (db.private[targetUserId].__lastAttackPush || 0) < ATTACK_PUSH_COOLDOWN_MS) return false;
  db.private[targetUserId].__lastAttackPush = now;
  return true;
}
// Dasselbe Ruhefenster für den globalen Chat (10.08.2026). Ein Chat ist naturgemäß gesprächig:
// Ohne Drosselung würde eine lebhafte Viertelstunde zwanzig Pushes auf jedem Handy erzeugen, und
// das Ergebnis wäre nicht mehr Beteiligung, sondern eine abgeschaltete Kategorie. Eine Meldung je
// halbe Stunde reicht für den Zweck - sie sagt "im Chat ist etwas los", den Rest liest man dort.
//
// UNTERSCHIED ZU allowAttackPush: Dort wird bei gesperrter Push der Postfach-Eintrag TROTZDEM
// geschrieben, weil der Angriff sonst spurlos bliebe. Beim Chat wäre das falsch - die Nachrichten
// stehen ja im Chat, ein zweiter Eintrag je Nachricht wäre reine Dopplung. Hier entfällt deshalb
// der ganze Vorgang, nicht nur die Push.
const CHAT_PUSH_COOLDOWN_MS = 30 * 60 * 1000;
function allowChatPush(targetUserId) {
  if (!db.private[targetUserId]) db.private[targetUserId] = {};
  const now = Date.now();
  if (now - (db.private[targetUserId].__lastChatPush || 0) < CHAT_PUSH_COOLDOWN_MS) return false;
  db.private[targetUserId].__lastChatPush = now;
  return true;
}
// Lesbarer Titel/Text je Ereignistyp für die eigentliche Push-Nachricht (Postfach-Anzeige im
// Client hat ihre eigene, leicht andere Formulierung - hier bewusst kompakter fürs Benachrichtigungsfenster).
function pushNotificationText(type, payload) {
  if (type === 'pact-offer') return { title: 'Neues Pakt-Angebot', body: (payload.fromName || 'Ein Spieler') + ' bietet dir einen Nichtangriffspakt an.' };
  if (type === 'weltboss-kill') return { title: 'Weltboss besiegt!', body: 'Leviathan Stufe ' + (payload.level || 1) + ' erlegt - dein Beitrag: ' + (payload.share || 0) + '%.' };
  if (type === 'raid-incoming') return { title: 'Überfall!', body: 'Eine feindliche Flotte greift deine Kolonie an.' };
  if (type === 'attack-received') return payload.defended
    ? { title: 'Angriff abgewehrt!', body: (payload.attackerName || 'Ein Spieler') + ' hat dich angegriffen - deine Verteidigung hat gehalten. Sieh dir den Bericht an.' }
    : { title: 'Du wurdest angegriffen!', body: (payload.attackerName || 'Ein Spieler') + ' hat deine Kolonie überfallen' + (payload.looted ? ' und Ressourcen erbeutet' : '') + '. Rüste auf oder schlage zurück!' };
  if (type === 'asteroid-contested') return payload.verloren
    ? { title: 'Schürfrecht verloren!', body: (payload.angreiferName || 'Ein Kommandant') + ' hat dir das Schürfrecht abgenommen. Deine überlebende Eskorte kehrt zurück - das Vorkommen gehört jetzt ihm.' }
    : { title: 'Angriff auf dein Schürfrecht abgewehrt', body: 'Deine Eskorte hat ' + (payload.angreiferName || 'einen Angreifer') + ' zurückgeschlagen. Das Vorkommen bleibt deins - sieh nach, was von der Wache übrig ist.' };
  if (type === 'spy-detected') return payload.sabotage
    ? { title: 'Störmanöver!', body: (payload.fromName || 'Ein Spieler') + ' hat ein Sabotage-Störmanöver gegen dich geflogen - prüfe deine Ressourcen und Spionageabwehr.' }
    : { title: 'Spionage entdeckt', body: (payload.fromName || 'Ein Spieler') + ' hat deine Kolonie ausgespäht' + (payload.deep ? ' (Tiefen-Aufklärung inkl. Beute-Schätzung).' : '.') };
  if (type === 'sabotaged') return payload.kind === 'defense'
    ? { title: 'Verteidigung sabotiert!', body: (payload.fromName || 'Ein Spieler') + ' hat deine Verteidigung um 30% geschwächt (' + (payload.durationMin || 30) + ' Min). Repariere oder rüste auf!' }
    : { title: 'Produktion sabotiert!', body: (payload.fromName || 'Ein Spieler') + ' hat eine Produktion lahmgelegt (-50% für ' + (payload.durationMin || 30) + ' Min). Repariere im Verteidigungs-Tab.' };
  if (type === 'leaderboard-overtaken') return { title: 'Du wurdest überholt!', body: (payload.aheadName || 'Ein Spieler') + ' ist an dir vorbeigezogen - du bist jetzt auf Platz ' + (payload.rank || '?') + '. Zeit, zurückzuschlagen!' };
  if (type === 'job-complete') {
    const labels = { research: 'Deine Forschung ist abgeschlossen', construction: 'Ein Bauauftrag ist fertiggestellt', expedition: 'Eine Expedition ist zurückgekehrt', mission: 'Eine Mission ist zurückgekehrt', terraform: 'Ein Terraforming-Projekt ist fertig', exotic: 'Eine exotische Forschung ist abgeschlossen', veteran: 'Eine Veteranen-Ausbildung ist abgeschlossen' };
    return { title: 'Kolonie Kepler-7', body: (labels[payload.jobType] || 'Etwas in deiner Kolonie ist fertig') + ' - komm zurück und mach weiter!' };
  }
  if (type === 'message') return { title: 'Neue Nachricht', body: (payload.fromName || 'Ein Spieler') + ' hat dir geschrieben.' };
  // BEWUSST OHNE DEN NACHRICHTENTEXT. Der Text ist frei tippbar und ginge damit ungefiltert auf
  // die Sperrbildschirme aller Spieler - eine Beleidigung im Chat wäre eine Beleidigung auf jedem
  // Handy. Der Name steht ohnehin im Chat neben jeder Zeile und ist hart gekappt (siehe
  // handleSharedStorageWrite). Dieselbe Zurückhaltung wie bei 'message' oben, die den Text von
  // Direktnachrichten ebenfalls nicht mitschickt.
  if (type === 'chat') return { title: 'Globaler Chat', body: (payload.authorName || 'Jemand') + ' hat im globalen Chat geschrieben.' };
  if (type === 'weltboss-spawn') return { title: 'Neuer Weltboss!', body: 'Leviathan Stufe ' + (payload.level || 1) +
    ' ist erschienen - schließ dich dem Angriff an, bevor er wieder verschwindet.' };
  if (type === 'alliance-muster') {
    const min = Math.max(1, Math.round((payload.gatherSeconds || 0) / 60));
    return { title: 'Koordinierter Angriff!', body: (payload.byName || 'Ein Kommandant') + ' greift [' + (payload.targetTag || '?') +
      '] an - Sammelphase ' + min + ' Min. Schließ deine Flotte an!' };
  }
  if (type === 'alliance-base-attacked') return payload.destroyed
    ? { title: 'Allianzbasis ZERSTÖRT!', body: '[' + (payload.attackerTag || '?') + '] hat eure Basis zerstört - alle Boni sind deaktiviert, bis sie repariert ist.' }
    : { title: 'Allianzbasis angegriffen!', body: '[' + (payload.attackerTag || '?') + '] hat eure Basis angegriffen. Schickt Schiffe zur Verteidigung.' };
  if (type === 'alliance-base-ready') return { title: 'Allianzbasis baubereit', body: 'Die Ressourcen für Stufe ' + (payload.level || '?') +
    ' sind vollständig - die Bauzeit läuft jetzt.' };
  if (type === 'patchnotes') return { title: 'Kolonie Kepler-7 aktualisiert', body: 'Version ' + (payload.version || '') + ' ist da - tippen für die Neuigkeiten.' };
  if (type === 'alliance-application') return { title: 'Neue Bewerbung', body: (payload.name || 'Ein Spieler') + ' möchte [' + (payload.tag || '') + '] beitreten.' };
  // Die Sammelphase ist der eigentliche Inhalt der Meldung: Sie ist der Grund, warum diese
  // Benachrichtigung ueberhaupt eine sein muss und kein Eintrag im Chat, den man spaeter liest.
  // Wer sie verpasst, ist bei der Welle nicht dabei - die Flotte muss vorher an der Basis sein.
  if (type === 'alliance-raid') {
    const min = Math.max(1, Math.round((payload.gatherSeconds || 0) / 60));
    return {
      title: payload.waveNumber > 1 ? 'Nächste Raid-Welle!' : 'Allianz-Raid ausgerufen!',
      body: (payload.byName || 'Ein Kommandant') + ' ruft ' + (payload.waveNumber > 1 ? 'die nächste Welle gegen' : 'zum Angriff auf') + ' "' +
            (payload.bossName || 'den Sternenfresser') + '" - Sammelphase ' + min + ' Min. Schließ deine Flotte an!'
    };
  }
  if (type === 'feedback-received') {
    const label = payload.type === 'idee' ? 'Verbesserungsvorschlag' : 'Bug-Report';
    return { title: 'Neuer ' + label, body: (payload.username || 'Ein Spieler') + ': ' + (payload.text || '') };
  }
  if (type === 'referral-redeemed') return { title: 'Einladungs-Bonus erhalten', body: (payload.username || 'Ein Spieler') + ' hat deinen Einladungscode eingelöst - +50 Kredite für dich!' };
  if (type === 'referral-milestone') return { title: 'Werbe-Meilenstein erreicht!', body: 'Schon ' + (payload.count || '?') + ' Spieler geworben! Bonus: +' + (payload.credits || 0) + ' Kredite und +' + (payload.fragments || 0) + ' Modulfragmente.' };
  if (type === 'player-reported') return { title: 'Spieler gemeldet', body: (payload.reporterName||'Jemand') + ' hat ' + (payload.targetName||'einen Spieler') + ' gemeldet: ' + (payload.reason||'') };
  if (type === 'neuer-spieler') {
    // 'gesamt' ist die Zahl der Konten, die je einen Spielstand angelegt haben - NICHT die Zahl
    // der Registrierungen. Der Unterschied ist der ganze Punkt dieser Meldung: Zwischen
    // Registrierung und erstem Oeffnen liegt die E-Mail-Bestaetigung, und ein Konto, das den Link
    // nie anklickt, hat nie gespielt. Eine Meldung mit Object.keys(db.users).length haette eine
    // Zahl genannt, die etwas anderes sagt als der Satz um sie herum.
    const wieVielte = payload.gesamt ? ' (' + payload.gesamt + '. Kommandant insgesamt)' : '';
    return { title: 'Neuer Spieler hat angefangen', body: (payload.username || 'Ein Kommandant') + ' hat die Kolonie zum ersten Mal geoeffnet' + wieVielte + '.' };
  }
  return { title: 'Kolonie Kepler-7', body: 'Es gibt Neuigkeiten.' };
}
// Wohin führt ein Ereignis? (02.08.2026, Wunsch: "wenn man auf die Push klickt, das entsprechende
// öffnen - Expedition fertig drückt man drauf, geht Expedition auf")
//
// Format: '<reiter>' oder '<reiter>:<unterreiter>'. null heißt "kein sinnvolles Ziel" - dann bleibt
// es beim bisherigen Verhalten (Fenster nur in den Vordergrund holen).
//
// Die Abbildung liegt bewusst HIER und nicht im Service Worker oder im Spiel:
//   - Der Service Worker ist eine eigene Datei ohne Zugriff auf die Spiellogik. Eine Tabelle dort
//     wäre eine zweite Kopie, die beim nächsten neuen Ereignistyp veraltet.
//   - Das Postfach im Spiel braucht dasselbe Ziel. Der Server berechnet es beim AUSLIEFERN
//     (GET /api/notifications) und nicht beim Speichern, damit auch alte, vor dieser Änderung
//     abgelegte Ereignisse ein Ziel bekommen, statt tot im Postfach zu liegen.
//
// Die Reiter- und Unterreiter-Namen stammen aus weltraum_kolonie.html (id="tab-…",
// data-alliance-subtab, data-galaxy-subtab); tests/test_pushziele.js im Frontend-Repo prüft jeden
// hier genannten Namen gegen die Spieldatei - ein Tippfehler wäre sonst ein Klick ins Leere.
function notificationTarget(type, payload) {
  const p = payload || {};
  switch (type) {
    case 'pact-offer': return 'galaxie:diplo';
    case 'weltboss-kill': return 'galaxie:kampf';
    case 'weltboss-spawn': return 'galaxie:kampf';
    case 'leaderboard-overtaken': return 'galaxie:rang';
    // Der Neuling steht in der Bestenliste, sobald er gespeichert hat - das ist die Flaeche, auf
    // der man ihn wirklich ANSEHEN kann. Ein Ziel 'berichte' waere nur das Postfach selbst, aus
    // dem der Klick ohnehin kommt.
    case 'neuer-spieler': return 'galaxie:rang';
    case 'raid-incoming': return 'verteidigung';
    case 'spy-detected': return 'verteidigung';
    case 'attack-received': return 'berichte';
    case 'asteroid-contested': return 'karte';
    case 'sabotaged': return 'berichte';
    case 'message': return 'berichte';
    // Der Chat ist kein Reiter, sondern ein Einschub-Fenster - 'chat:global' oeffnet es und stellt
    // auf den globalen Kanal um (geheZuZiel im Frontend kennt diesen Sonderfall).
    case 'chat': return 'chat:global';
    case 'alliance-application': return 'allianz:verwaltung';
    case 'alliance-raid': return 'allianz:uebersicht';
    case 'alliance-muster': return 'allianz:uebersicht';
    case 'alliance-base-attacked': return 'allianz:uebersicht';
    case 'alliance-base-ready': return 'allianz:uebersicht';
    case 'referral-redeemed': return 'fortschritt';
    case 'referral-milestone': return 'fortschritt';
    case 'job-complete': return {
      research: 'forschung', construction: 'basis', expedition: 'expedition',
      mission: 'flotte', terraform: 'basis', exotic: 'forschung', veteran: 'flotte'
    }[p.jobType] || null;
    default: return null;   // patchnotes, feedback-received, player-reported
  }
}
// Verschickt eine echte Push-Benachrichtigung an ALLE registrierten Geräte eines Spielers. Abgelaufene
// Abos (Browser deinstalliert, Berechtigung entzogen - erkennbar an HTTP 404/410 vom Push-Dienst)
// werden automatisch aus der DB entfernt, damit die Liste nicht endlos mit toten Einträgen wächst.
async function sendWebPushToUser(userId, type, payload) {
  try {
    const subs = (db.private[userId] && db.private[userId].__pushSubscriptions) || [];
    if (!subs.length) return;
    const { title, body } = pushNotificationText(type, payload);
    // `ziel` reist mit der Push mit, damit der Service Worker beim Klick weiß, wohin - ohne eine
    // eigene Tabelle führen zu müssen, die still veraltet.
    const message = JSON.stringify({ title, body, type, payload, ziel: notificationTarget(type, payload), time: Date.now() });
    let changed = false;
    const survivors = [];
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub, message);
        survivors.push(sub);
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { changed = true; /* Abo verworfen */ }
        else survivors.push(sub); // anderer Fehler (z.B. kurzzeitig offline) - Abo behalten
      }
    }
    if (changed) { db.private[userId].__pushSubscriptions = survivors; await saveDb(); }
  } catch (e) { console.error('Web-Push fehlgeschlagen:', e.message); }
}
function handleSharedStorageWrite(key, prevRaw, newRaw) {
  try {
    // Allianzbasis: Ressourcen für die nächste Ausbaustufe sind vollständig (02.08.2026).
    //
    // Warum das eine Meldung wert ist: Die Bauzeit einer Stufe startet ERST, wenn ihre Ressourcen
    // komplett beisammen sind - und sie ist lang (ab 8 Std., je Stufe ×1,5, Stufe 10 allein rund 19
    // Tage). Wer den Moment verpasst, verschenkt nichts Geringeres als diese Zeit. Bisher stand er
    // nur als System-Nachricht im Allianz-Chat.
    //
    // Abgeleitet aus dem Schreibvorgang und nicht aus einem eigenen Endpunkt, weil dieses Dokument
    // vom Client geschrieben wird (maybeMarkAllianceBaseResourcesReady): Ein neuer Schlüssel in
    // readyAtByLevel ist genau das Ereignis. Nur ECHTE Zuwächse zählen - beim allerersten Schreiben
    // einer Bestandsbasis trägt der Client rückwirkend alle bereits erfüllten Stufen auf einmal
    // ein, und daraus zehn Meldungen zu machen wäre das Gegenteil von hilfreich.
    const baseMatch = /^alliance:([A-Z0-9]+):base$/.exec(key);
    if (baseMatch) {
      let prev = null, next = null;
      try { prev = prevRaw ? JSON.parse(prevRaw) : null; } catch (e) {}
      try { next = JSON.parse(newRaw); } catch (e) { return; }
      if (!next || !next.readyAtByLevel) return;
      const vorher = Object.keys((prev && prev.readyAtByLevel) || {});
      const nachher = Object.keys(next.readyAtByLevel);
      const neueStufen = nachher.filter(l => !vorher.includes(l)).map(Number).filter(n => n > 0);
      // Erstmalige Rückdatierung einer Bestandsbasis (mehrere Stufen auf einen Schlag): still.
      if (!neueStufen.length || (!vorher.length && neueStufen.length > 1)) return;
      const stufe = Math.max(...neueStufen);
      for (const memberId of allianceMemberIds(baseMatch[1])) {
        const user = findUserById(memberId);
        if (!user) continue;
        const prefs = getNotifPrefs(user);
        if (!prefs.enabled || !prefs.alliancebase) continue;
        pushNotificationEvent(memberId, 'alliance-base-ready', { tag: baseMatch[1], level: stufe });
      }
      return;
    }
    // Globaler Chat: jemand hat geschrieben (10.08.2026, Wunsch Sascha).
    //
    // Jede Nachricht legt einen EIGENEN Schlüssel an (globalchat:msg:<ts>-<zufall>), ein Schreiben
    // mit prevRaw === undefined ist also genau eine neue Nachricht. Ein vorhandener prevRaw wäre
    // eine Änderung an einer bestehenden - dafür gibt es keinen legitimen Weg im Spiel, und eine
    // Push dafür schon gar nicht.
    if (key.startsWith('globalchat:msg:') && !prevRaw) {
      let msg = null;
      try { msg = JSON.parse(newRaw); } catch (e) { return; }
      if (!msg || !msg.authorId) return;
      // Der Name kommt aus der Nachricht (dort steht der Kommandantenname, den auch der Chat
      // anzeigt - der Registrierungsname wäre für Mitleser ein anderer und damit verwirrend).
      // Er ist frei wählbar, deshalb hart gekappt und von Steuerzeichen befreit, bevor er auf
      // einem fremden Sperrbildschirm landet.
      const autor = String(msg.authorName || 'Jemand').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Jemand';
      const AKTIV_MS = 7 * 24 * 60 * 60 * 1000;
      const jetzt = Date.now();
      for (const user of Object.values(db.users)) {
        if (!user || !user.userId) continue;
        if (user.userId === msg.authorId) continue;          // nie an den Verfasser selbst
        const prefs = getNotifPrefs(user);
        if (!prefs.enabled || !prefs.chat) continue;
        // Wer gerade spielt, sieht die Nachricht im Chat - eine Push wäre dann nur ein Duplikat
        // auf dem Handy, das direkt daneben liegt.
        if (userIsOnline(user.userId)) continue;
        // Und wer seit über einer Woche nicht da war, bekommt keine - das wäre keine Information
        // mehr, sondern Werbung (dieselbe Abwägung wie beim Weltboss-Spawn weiter unten).
        let lastSeen = 0;
        try { lastSeen = JSON.parse(db.shared['leaderboard:' + user.userId] || '{}').lastSeen || 0; } catch (e) {}
        if (jetzt - lastSeen > AKTIV_MS) continue;
        if (!allowChatPush(user.userId)) continue;           // höchstens eine je halbe Stunde
        pushNotificationEvent(user.userId, 'chat', { authorName: autor });
      }
      return;
    }
    if (key.startsWith('pact:')) {
      let prev = null, next = null;
      try { prev = prevRaw ? JSON.parse(prevRaw) : null; } catch (e) {}
      try { next = JSON.parse(newRaw); } catch (e) { return; }
      if (!next || !next.a || !next.b) return;
      const wasOffered = prev && prev.status === 'offered';
      if (next.status === 'offered' && !wasOffered) {
        const targetId = next.offeredBy === next.a ? next.b : next.a;
        const targetUser = findUserById(targetId);
        if (targetUser) {
          const prefs = getNotifPrefs(targetUser);
          if (prefs.enabled && prefs.pact) {
            const fromName = (next.names && next.names[next.offeredBy]) || 'Ein Spieler';
            pushNotificationEvent(targetId, 'pact-offer', { fromName });
          }
        }
      }
    } else if (key === 'worldboss:current') {
      let prev = null, next = null;
      try { prev = prevRaw ? JSON.parse(prevRaw) : null; } catch (e) {}
      try { next = JSON.parse(newRaw); } catch (e) { return; }
      if (!next) return;
      const wasDefeated = prev && prev.defeatedAt;
      if (next.defeatedAt && !wasDefeated) {
        const contributions = next.contributions || {};
        const total = Object.values(contributions).reduce((a, x) => a + (x.dmg || 0), 0) || 1;
        for (const [contribUserId, contrib] of Object.entries(contributions)) {
          const user = findUserById(contribUserId);
          if (!user) continue;
          const prefs = getNotifPrefs(user);
          if (!prefs.enabled || !prefs.weltboss) continue;
          const share = Math.round(((contrib.dmg || 0) / total) * 100);
          pushNotificationEvent(contribUserId, 'weltboss-kill', { level: next.level || 1, share });
        }
      }
      // Ein NEUER Weltboss ist erschienen (02.08.2026). Bisher gab es nur die Meldung nach dem Kill
      // - also ausgerechnet für die, die ohnehin dabei waren. Wer nicht zufällig online war, hat den
      // Boss nie gesehen: Er ist serverweit und hat ein Zeitfenster.
      //
      // Erkannt an der gewechselten bossId bei noch nicht besiegtem Boss. Kein eigener Endpunkt
      // nötig, weil das Dokument ohnehin vom Client geschrieben wird (loadWorldBoss legt den
      // Nachfolger an, sobald die Respawn-Sperre abgelaufen ist).
      //
      // NUR AN AKTIVE KONTEN: Eine serverweite Push an jeden je registrierten Spieler wäre bei einem
      // Ereignis, das sich regelmäßig wiederholt, keine Information mehr, sondern Werbung. Wer seit
      // über einer Woche nicht da war, bekommt sie nicht - `weltboss` ist ohnehin einzeln
      // abschaltbar, aber eine Kategorie, die man erst abschalten MUSS, ist schon zu viel.
      const wechsel = next.bossId && (!prev || prev.bossId !== next.bossId);
      if (wechsel && !next.defeatedAt) {
        const AKTIV_MS = 7 * 24 * 60 * 60 * 1000;
        const jetzt = Date.now();
        for (const [userId] of Object.entries(db.users).map(([, u]) => [u.userId]).filter(([id]) => id)) {
          let lastSeen = 0;
          try { lastSeen = JSON.parse(db.shared['leaderboard:' + userId] || '{}').lastSeen || 0; } catch (e) {}
          if (jetzt - lastSeen > AKTIV_MS) continue;
          const user = findUserById(userId);
          if (!user) continue;
          const prefs = getNotifPrefs(user);
          if (!prefs.enabled || !prefs.weltboss) continue;
          pushNotificationEvent(userId, 'weltboss-spawn', { level: next.level || 1, maxHp: next.maxHp || 0 });
        }
      }
    } else {
      // alliance:<TAG>:info - erkennt den Übergang "aufgelöst" -> "aktiv" (Neugründung unter
      // demselben, freigewordenen Tag) und setzt dabei automatisch den kompletten Forschungs-/
      // Gebäude-Fortschritt zurück. Bug behoben (13.07.2026): vorher blieben "unlocked" und alle
      // "contrib:"-Beiträge nach einer Auflösung unangetastet bestehen - eine brandneue Allianz unter
      // demselben Tag hätte den alten Fortschritt (inkl. der für das Mitgliederlimit relevanten
      // Allianz-Expansion-Stufen) komplett kostenlos geerbt, ohne dass ein einziges neues Mitglied
      // je etwas beigetragen hätte.
      const infoMatch = key.match(/^alliance:([^:]+):info$/);
      if (infoMatch) {
        let prev = null, next = null;
        try { prev = prevRaw ? JSON.parse(prevRaw) : null; } catch (e) {}
        try { next = JSON.parse(newRaw); } catch (e) { return; }
        const wasDisbanded = prev && prev.disbanded === true;
        const isRefound = wasDisbanded && next && next.disbanded !== true;
        if (isRefound) {
          const tag = infoMatch[1];
          const contribPrefix = 'alliance:' + tag + ':contrib:';
          const appPrefix = 'alliance:' + tag + ':applications:';
          const auditPrefix = 'alliance:' + tag + ':auditlog:';
          db.shared['alliance:' + tag + ':unlocked'] = '{}';
          for (const k of Object.keys(db.shared)) {
            if (k.startsWith(contribPrefix) || k.startsWith(appPrefix) || k.startsWith(auditPrefix)) db.shared[k] = '{}';
          }
          delete db.shared['alliance:' + tag + ':banner'];
        }
        return;
      }
      // alliance:<TAG>:applications:<playerId> - neue (oder erneute nach Ablehnung) Bewerbung
      // benachrichtigt alle Admins/Offiziere dieser Allianz. "Neu" heißt: Status wechselt zu
      // 'pending', während er es vorher nicht war (deckt sowohl Erstbewerbung als auch eine erneute
      // Bewerbung nach vorheriger Ablehnung ab).
      const appMatch = key.match(/^alliance:([^:]+):applications:/);
      if (appMatch) {
        let prev = null, next = null;
        try { prev = prevRaw ? JSON.parse(prevRaw) : null; } catch (e) {}
        try { next = JSON.parse(newRaw); } catch (e) { return; }
        if (!next) return;
        const wasPending = prev && prev.status === 'pending';
        if (next.status === 'pending' && !wasPending) {
          const tag = appMatch[1];
          for (const adminId of allianceAdminsAndOfficers(tag)) {
            const user = findUserById(adminId);
            if (!user) continue;
            const prefs = getNotifPrefs(user);
            if (prefs.enabled && prefs.application) {
              pushNotificationEvent(adminId, 'alliance-application', { name: next.name || 'Ein Spieler', tag });
            }
          }
        }
      }
    }
  } catch (e) { console.error('Benachrichtigungs-Ableitung fehlgeschlagen (Speicherwrite selbst war ok):', e.message); }
}
// Periodischer Sweep für geplante Überfall-Erinnerungen (Client meldet fireAt aktiv, siehe
// /api/schedule-raid-alert weiter unten - eine lokale NPC-Bedrohung, von der der Server sonst nie
// erfährt). Alle 30s geprüft, damit ein Server-Neustart nichts Endgültiges verpasst.
setInterval(async () => {
  try {
    let changed = false;
    const now = Date.now();
    for (const [userId, bucket] of Object.entries(db.private)) {
      const alert = bucket && bucket.__raidAlert;
      if (alert && alert.fireAt && alert.fireAt <= now) {
        const user = findUserById(userId);
        const prefs = getNotifPrefs(user || {});
        if (user && prefs.enabled && prefs.raid) {
          pushNotificationEvent(userId, 'raid-incoming', { planet: alert.planet || null });
          changed = true;
        }
        delete bucket.__raidAlert;
        changed = true;
      }
    }
    if (changed) await saveDb();
  } catch (e) { console.error('Überfall-Erinnerungs-Sweep fehlgeschlagen:', e.message); }
}, 30000);
const SAVE_KEY = 'kepler7-save-v3';
function getSaveValue(userId) {
  const entry = db.private[userId] && db.private[userId][SAVE_KEY];
  if (entry === undefined) return null;
  return typeof entry === 'string' ? entry : entry.value;
}
function setSaveValue(userId, jsonString) {
  db.private[userId] = db.private[userId] || {};
  const existing = db.private[userId][SAVE_KEY];
  const existingVersion = existing === undefined ? -1 : (typeof existing === 'string' ? 0 : (existing.version || 0));
  const newVersion = existingVersion + 1;
  db.private[userId][SAVE_KEY] = { value: jsonString, version: newVersion };
  return newVersion;
}

// --- Zufalls-Spawn für neue Spieler ---
// Vollständige Systemliste mit Karten-Koordinaten, identisch zu STAR_SYSTEMS im Frontend
// (weltraum_kolonie.html), damit die NPC-Territorium-Simulation Nachbarschaften über die
// tatsächliche Kartenposition berechnen kann.
//
// HIER LAG EIN ECHTER FEHLER, behoben am 10.08.2026. Die Liste kannte 41 der 69 Basissysteme;
// es fehlten alle acht äußersten (sys_pandora_saum … sys_meridian_kern) und alle 20 sysn_*.
// Der Kommentar darüber behauptete dagegen Gleichheit, und test_paritaet_tabellen.js deckte die
// Systemliste als einzige der gespiegelten Tabellen NICHT ab.
//
// Die Folge war groß und still: In diesen 28 Systemen konnte kein neuer Spieler spawnen, keine
// Fraktion Territorium halten oder expandieren, keine Supernova und kein Wurmloch entstehen,
// keine Piratenbasis gegründet und kein Allianz-Raid angesetzt werden. Rund 40 % der Karte waren
// für jeden serverseitigen Galaxie-Inhalt tot – und zwar genau die äußeren Randsektoren.
//
// Auffällig ist, WIE die 41 zustande kamen: Es sind exakt die Systeme, die es vor der letzten
// Karten-Erweiterung gab. Die Liste ist nie falsch geschrieben, sondern schlicht nicht
// mitgewachsen worden. Genau dagegen prüft jetzt test_systemparitaet.js.
const SYSTEM_COORDS = [
  { id: 'kepler', gx: 510.2, gy: 242.9 },
  { id: 'vega', gx: 518.3, gy: 276.5 },
  { id: 'orion', gx: 455.8, gy: 296.2 },
  { id: 'nebel', gx: 348.6, gy: 270 },
  { id: 'rand', gx: 309.1, gy: 181.4 },
  { id: 'krux', gx: 462.3, gy: 272 },
  { id: 'aether', gx: 395.9, gy: 244.7 },
  { id: 'vortex', gx: 393.1, gy: 211.1 },
  { id: 'chronos', gx: 477.5, gy: 144.9 },
  { id: 'solmark', gx: 635, gy: 153.5 },
  { id: 'drachenmark', gx: 457.9, gy: 207.4 },
  { id: 'abyss', gx: 505, gy: 192.9 },
  { id: 'nyra', gx: 599.5, gy: 218.5 },
  { id: 'pulsar', gx: 593.8, gy: 304.9 },
  { id: 'sigma', gx: 466.2, gy: 355.9 },
  { id: 'sys_corvus_weite', gx: 688.4, gy: 236.9 },
  { id: 'sys_halcyon_feld', gx: 669.7, gy: 350.1 },
  { id: 'sys_meridian_bogen', gx: 500, gy: 416.3 },
  { id: 'sys_thule_reichweite', gx: 295.4, gy: 412.2 },
  { id: 'sys_oort_schleuse', gx: 142.3, gy: 282.3 },
  { id: 'sys_xerxes_zone', gx: 152.5, gy: 112.5 },
  { id: 'sys_ashen_grat', gx: 493.4, gy: 359 },
  { id: 'sys_ilyra_strom', gx: 321.5, gy: 342.1 },
  { id: 'sys_kessel_anomalie', gx: 206.6, gy: 274.6 },
  { id: 'sys_vantar_riff', gx: 215, gy: 145.2 },
  { id: 'sys_quorin_passage', gx: 377.6, gy: 35.1 },
  { id: 'sys_ember_reichweite', gx: 651.5, gy: 24.5 },
  { id: 'sys_silberbach', gx: 280.9, gy: 255.9 },
  { id: 'sys_nachtsegel_zone', gx: 292.5, gy: 145.9 },
  { id: 'sys_grendel_feld', gx: 426.9, gy: 73.3 },
  { id: 'sys_aurelia_bogen', gx: 660, gy: 91.3 },
  { id: 'sys_marek_schneise', gx: 832, gy: 175.7 },
  { id: 'sys_talon_ring', gx: 826.1, gy: 352.3 },
  { id: 'sys_wispern_nebel', gx: 448.8, gy: 100.5 },
  { id: 'sys_cinder_reichweite', gx: 602.4, gy: 98.3 },
  { id: 'sys_obsidian_guertel', gx: 760.4, gy: 181.7 },
  { id: 'sys_halvar_weite', gx: 757.8, gy: 322.9 },
  { id: 'sys_sernova_feld', gx: 628, gy: 429.2 },
  { id: 'sys_dunwich_passage', gx: 352.7, gy: 470.5 },
  { id: 'sys_pandora_saum', gx: 800, gy: 60 },
  { id: 'sys_tychos_kluft', gx: 807.3, gy: 207 },
  { id: 'sys_ashen_bogen', gx: 814.6, gy: 354 },
  { id: 'sys_valeska_spirale', gx: 821.9, gy: 461 },
  { id: 'sys_boreas_schwelle', gx: 829.2, gy: 88 },
  { id: 'sys_indra_tiefe', gx: 836.5, gy: 195 },
  { id: 'sys_calyx_grat', gx: 843.8, gy: 342 },
  { id: 'sys_meridian_kern', gx: 851.1, gy: 489 },
  { id: 'zenith', gx: 671.2, gy: 219.1 },
  { id: 'tiefsee', gx: 279.1, gy: 230.3 },
  { id: 'sysn_zephond', gx: 177.1, gy: 345.2 },
  { id: 'sysn_draora', gx: 581.5, gy: 274.6 },
  { id: 'sysn_selion', gx: 689.5, gy: 381.6 },
  { id: 'sysn_obenael', gx: 704.7, gy: 50.7 },
  { id: 'sysn_xenax', gx: 425.3, gy: 327.8 },
  { id: 'sysn_kelyra', gx: 627.7, gy: 339.6 },
  { id: 'sysn_ivaris', gx: 249.1, gy: 131.7 },
  { id: 'sysn_kazael', gx: 531.9, gy: 328.6 },
  { id: 'sysn_xenoth', gx: 161.1, gy: 149.8 },
  { id: 'sysn_veloth', gx: 378.1, gy: 111.5 },
  { id: 'sysn_noresh', gx: 551.3, gy: 368 },
  { id: 'sysn_lunyra', gx: 109.4, gy: 503.3 },
  { id: 'sysn_raelese', gx: 257.7, gy: 85.6 },
  { id: 'sysn_fenonde', gx: 252, gy: 393 },
  { id: 'sysn_selyx', gx: 534.5, gy: 71.1 },
  { id: 'sysn_vexora', gx: 568.2, gy: 236.3 },
  { id: 'sysn_joryn', gx: 438.4, gy: 391.6 },
  { id: 'sysn_karis', gx: 183.6, gy: 303.4 },
  { id: 'sysn_voroth', gx: 769.5, gy: 498.9 },
  { id: 'sysn_ophiar', gx: 445.9, gy: 448.9 }
];
const BASE_SYSTEM_COUNT = SYSTEM_COORDS.length;
// --- Wöchentlich wachsende Galaxie, serverseitig nachgerechnet ---------------------------------
// Das Frontend hängt jeden Montag zwei Systeme an (Abschnitt „Wöchentlich wachsende Galaxie" in
// weltraum_kolonie.html). Die 69 Basissysteme nachzutragen allein hätte die Lücke deshalb nur für
// einen Moment geschlossen: Heute laufen bereits Wochensysteme mit, und es werden jede Woche zwei
// mehr, bis zum Deckel 208. Ein Paritätstest über die statischen Listen hätte am Montag darauf
// nicht angeschlagen, obwohl die Galaxien wieder auseinandergelaufen wären.
//
// Übernommen wird NUR, was der Server braucht: id, gx, gy. Namen und Planeten bleiben im Frontend.
// Die hängen an einem Zufallsgenerator mit festem Startwert, und den hier zu spiegeln hieße, eine
// zweite Kopie zu pflegen, die abdriften kann – genau der Fallstrick, der diese Datei schon dreimal
// erwischt hat. Position und ID dagegen sind reine Geometrie aus dem Index und deshalb beidseitig
// gefahrlos berechenbar; test_systemparitaet.js vergleicht sie Zahl für Zahl.
const WEEKLY_SYSTEMS_PER_WEEK = 2;
const WEEKLY_SYSTEM_EPOCH = Date.UTC(2026, 6, 20);   // Montag, 20.07.2026, 00:00 UTC – wie im Frontend
const WEEKLY_SYSTEM_MAX = 208;
const WEEK_MS = 7 * 24 * 3600 * 1000;
function weeklySystemCount(now) {
  const wochen = Math.floor(((now || Date.now()) - WEEKLY_SYSTEM_EPOCH) / WEEK_MS);
  if (wochen < 0) return 0;
  return Math.min(WEEKLY_SYSTEM_MAX, (wochen + 1) * WEEKLY_SYSTEMS_PER_WEEK);
}
// Mittelpunkt und Außenradius der BASIS-Galaxie. Bewusst über die ersten BASE_SYSTEM_COUNT
// Einträge statt über SYSTEM_COORDS: Sonst würde der Ring mit jedem angehängten Wochensystem
// wandern, und dieselbe Systemnummer läge nächste Woche woanders als im Frontend.
const WEEKLY_RING = (function () {
  const basis = SYSTEM_COORDS.slice(0, BASE_SYSTEM_COUNT);
  let sx = 0, sy = 0;
  for (const s of basis) { sx += s.gx; sy += s.gy; }
  const cx = sx / basis.length, cy = sy / basis.length;
  let rMax = 0;
  for (const s of basis) rMax = Math.max(rMax, Math.hypot(s.gx - cx, s.gy - cy));
  return { cx, cy, r0: rMax + 45 };
})();
// Goldener Winkel auf einem Ring, dessen Fläche linear mit der Systemzahl wächst – Zeile für Zeile
// dieselbe Formel wie buildWeeklySystem() im Frontend.
function weeklySystemCoord(i) {
  const winkel = i * 2.39996323;
  const radius = Math.sqrt(WEEKLY_RING.r0 * WEEKLY_RING.r0 + (i + 1) * 700);
  return {
    id: 'sysw_' + i,
    gx: Math.round((WEEKLY_RING.cx + Math.cos(winkel) * radius) * 10) / 10,
    gy: Math.round((WEEKLY_RING.cy + Math.sin(winkel) * radius) * 10) / 10
  };
}

const SYSTEMS = [];
// Nachbarn eines Systems: die k nächstgelegenen anderen Systeme (euklidische Distanz auf der Karte).
// Wird für Fraktions-Expansion (nur in benachbarte Systeme) genutzt.
const SYSTEM_NEIGHBORS = {};
const SYSTEM_COORD_BY_ID = {};
const SYSTEM_NEIGHBOR_K = 4;
// Die drei Tabellen werden IN PLACE neu befüllt, nie neu zugewiesen: An einem Dutzend Stellen im
// Server hängen Referenzen genau auf diese Objekte. Ein `SYSTEMS = [...]` ließe sie alle auf den
// alten Stand zeigen, und der Fehler wäre erst Wochen später an einer Expansion zu sehen.
function rebuildSystemTables() {
  SYSTEMS.length = 0;
  for (const k in SYSTEM_NEIGHBORS) delete SYSTEM_NEIGHBORS[k];
  for (const k in SYSTEM_COORD_BY_ID) delete SYSTEM_COORD_BY_ID[k];
  for (const s of SYSTEM_COORDS) { SYSTEMS.push(s.id); SYSTEM_COORD_BY_ID[s.id] = s; }
  for (const s of SYSTEM_COORDS) {
    const dists = SYSTEM_COORDS
      .filter(o => o.id !== s.id)
      .map(o => ({ id: o.id, d: Math.hypot(o.gx - s.gx, o.gy - s.gy) }))
      .sort((a, b) => a.d - b.d);
    SYSTEM_NEIGHBORS[s.id] = dists.slice(0, SYSTEM_NEIGHBOR_K).map(x => x.id);
  }
}
// Hängt die bis jetzt fälligen Wochensysteme an – nur anhängen, nie entfernen, damit ein einmal
// erobertes oder besiedeltes System nie unter jemandem weggeräumt wird. Der Neuaufbau der
// Nachbarschaften ist O(n²) und läuft deshalb nur beim Wochenwechsel, nicht in jedem Takt.
let weeklySystemsBuilt = 0;
function syncWeeklySystems(now) {
  const soll = weeklySystemCount(now);
  if (soll <= weeklySystemsBuilt) return 0;
  for (let i = weeklySystemsBuilt; i < soll; i++) SYSTEM_COORDS.push(weeklySystemCoord(i));
  const dazu = soll - weeklySystemsBuilt;
  weeklySystemsBuilt = soll;
  rebuildSystemTables();
  return dazu;
}
rebuildSystemTables();
syncWeeklySystems(Date.now());
const HOME_SLOTS_PER_SYSTEM = 8;
// Neue Spieler bewusst weit weg von bestehenden Kolonien einteilen, statt gleichverteilt-zufällig.
// Regeln (in dieser Reihenfolge): (1) Systeme mit den WENIGSTEN Bewohnern zuerst – so bekommt jedes
// System erst einen Spieler, bevor sich zwei ein System teilen; (2) bei gleicher Bewohnerzahl das
// System wählen, dessen NÄCHSTER bewohnter Nachbar am WEITESTEN entfernt ist (Farthest-Point-Streuung
// auf den echten Kartenkoordinaten). Ergebnis: der erste Spieler landet irgendwo, jeder weitere möglichst
// weit weg von allen bereits bewohnten Systemen.
function assignHomeSlot() {
  const occupancy = {}; // system -> Anzahl Spieler
  for (const u of Object.values(db.users)) {
    if (u.homeSystem) occupancy[u.homeSystem] = (occupancy[u.homeSystem] || 0) + 1;
  }
  const occupiedCoords = Object.keys(occupancy)
    .map(id => SYSTEM_COORD_BY_ID[id])
    .filter(Boolean);

  // Systeme mit noch freiem Slot
  const candidates = SYSTEMS.filter(sys => (occupancy[sys] || 0) < HOME_SLOTS_PER_SYSTEM);
  if (!candidates.length) {
    // Alle Systeme voll (praktisch nie: 69+ Systeme × 8 Slots) – irgendeinen Slot vergeben.
    return { system: SYSTEMS[Math.floor(Math.random() * SYSTEMS.length)], slot: Math.floor(Math.random() * HOME_SLOTS_PER_SYSTEM) };
  }

  // Distanz eines Kandidaten zum nächsten bewohnten System (Infinity, wenn noch niemand da ist).
  function minDistToOccupied(sys) {
    const c = SYSTEM_COORD_BY_ID[sys];
    if (!c) return 0;
    let best = Infinity;
    for (const o of occupiedCoords) {
      if (o.id === sys) continue; // eigenes System nicht mitzählen
      const d = Math.hypot(o.gx - c.gx, o.gy - c.gy);
      if (d < best) best = d;
    }
    return best;
  }

  // Beste Kombination aus wenigster Bewohnerzahl und größter Distanz suchen.
  let bestOcc = Infinity, bestDist = -Infinity;
  const distCache = {};
  for (const sys of candidates) {
    const occ = occupancy[sys] || 0;
    const dist = (distCache[sys] = minDistToOccupied(sys));
    if (occ < bestOcc || (occ === bestOcc && dist > bestDist)) { bestOcc = occ; bestDist = dist; }
  }
  // Gleich gute Systeme (gleiche Bewohnerzahl UND praktisch gleiche Distanz) – zufällig eines nehmen,
  // damit bei exakten Gleichständen nicht alle zeitgleichen Registrierungen dasselbe System bekommen.
  const topTier = candidates.filter(sys => {
    const occ = occupancy[sys] || 0;
    if (occ !== bestOcc) return false;
    const d = distCache[sys];
    return (d === Infinity && bestDist === Infinity) || Math.abs(d - bestDist) < 1e-6;
  });
  const chosenSystem = topTier[Math.floor(Math.random() * topTier.length)];

  // Freien Slot im gewählten System bestimmen.
  const takenSlots = new Set(
    Object.values(db.users).filter(u => u.homeSystem === chosenSystem).map(u => u.homeSlot)
  );
  const freeSlots = [];
  for (let slot = 0; slot < HOME_SLOTS_PER_SYSTEM; slot++) if (!takenSlots.has(slot)) freeSlots.push(slot);
  const chosenSlot = freeSlots.length ? freeSlots[Math.floor(Math.random() * freeSlots.length)] : Math.floor(Math.random() * HOME_SLOTS_PER_SYSTEM);
  return { system: chosenSystem, slot: chosenSlot };
}

// Migration: Bestandsaccounts ohne zugewiesenes Heimatsystem nachträglich einteilen
(function migrateHomeSlots(){
  let changed = false;
  for (const u of Object.values(db.users)) {
    if (!u.homeSystem) {
      const home = assignHomeSlot();
      u.homeSystem = home.system; u.homeSlot = home.slot;
      changed = true;
    }
  }
  if (changed) saveDb();
})();

// --- Passwort-Regeln (Sicherheits-Audit 18.08.2026, Vorschlag P5) --------------------------
// Bis hierher galt nur "mindestens 6 Zeichen". Das ist unter dem heutigen OWASP-/NIST-Stand, und
// die dritte Zeile aus dem Ausloeser-Video ("Bekanntes PW") wurde ueberhaupt nicht geprueft.
//
// DIE WICHTIGSTE EIGENSCHAFT DIESES BLOCKS IST, WO ER *NICHT* AUFGERUFEN WIRD: niemals im Login.
// Wer heute ein 6-Zeichen-Passwort hat, muss sich weiter anmelden koennen - eine neue Regel
// begrenzt das HINZUFUEGEN, nie den Bestand. Das ist dieselbe Ueberlegung wie bei den Deckeln im
// Unterstuetzer-Bereich ("Deckel duerfen niemals Daten loeschen"), nur auf eine Zugangsregel
// angewandt: Ein Bestandskonto auszusperren waere ein weit groesserer Schaden als das schwache
// Passwort, das man damit beheben wollte. Die vier bcrypt.compare-Stellen bleiben deshalb
// unberuehrt; geprueft wird ausschliesslich an den zwei bcrypt.hash-Stellen (Registrierung, Reset).
const PASSWORT_MIN = 8;
const PASSWORT_LISTE_DATEI = process.env.PASSWORT_LISTE_DATEI || path.join(__dirname, 'passwoerter-bekannt.txt');

// Begriffe, die fuer DIESES Spiel das sind, was "password" allgemein ist. Sie stehen in keiner
// allgemeinen Haeufigkeitsliste - eine Liste allein waere hier also blind.
const PASSWORT_SPIELBEGRIFFE = ['kepler', 'kolonie', 'gamegeeeeek'];

// Fehlt die Datei, laeuft der Dienst weiter - anders als beim API_KEY in AI Core, und der
// Unterschied ist der Grund: Dort WAR die Konfiguration die Sicherung, ihr Ausfall hob den ganzen
// Schutz auf. Hier ist die Liste EINE von sechs Regeln; die anderen fuenf greifen weiter. Ein
// Serverstart zu verweigern wuerde das Spiel fuer alle abschalten, um eine Teilregel zu erzwingen.
// Damit der Ausfall trotzdem nicht wie Normalbetrieb aussieht, wird er laut protokolliert - und
// tests/test_passwortregeln_http.js prueft die Anzahl der Eintraege, nicht nur ihre Existenz.
const BEKANNTE_PASSWOERTER = (() => {
  try {
    const roh = fs.readFileSync(PASSWORT_LISTE_DATEI, 'utf8');
    const menge = new Set();
    for (const zeile of roh.split('\n')) {
      const w = zeile.trim().toLowerCase();
      if (w && !w.startsWith('#')) menge.add(w);
    }
    console.log('[passwort] ' + menge.size + ' bekannte Passwoerter geladen.');
    return menge;
  } catch (e) {
    console.error('[passwort] WARNUNG: ' + PASSWORT_LISTE_DATEI + ' nicht lesbar (' + e.message +
      '). Die Pruefung gegen bekannte Passwoerter ist damit AUS; alle uebrigen Regeln greifen weiter.');
    return new Set();
  }
})();

/**
 * Prueft ein NEU gesetztes Passwort. Liefert null, wenn es in Ordnung ist, sonst den Fehlertext.
 *
 * Der Text nennt immer den konkreten Grund und sagt, was zu tun ist. Eine Meldung, die mehrere
 * Ursachen zusammenfasst ("ungueltig"), ist im Fehlerfall keine Diagnose - genau diese Lehre hat
 * das Nachbarprojekt am 17.08.2026 eine ganze Fehlersuche gekostet.
 *
 * `username` ist optional und darf fehlen; ist er da, wird er mitgeprueft.
 */
function passwortProblem(passwort, username) {
  const pw = String(passwort == null ? '' : passwort);

  if (pw.length < PASSWORT_MIN) {
    return 'Passwort muss mindestens ' + PASSWORT_MIN + ' Zeichen haben.';
  }
  const klein = pw.toLowerCase();

  if (BEKANNTE_PASSWOERTER.has(klein)) {
    return 'Dieses Passwort steht auf den Listen der haeufigsten Passwoerter und waere in Sekunden geraten. Bitte waehle ein anderes.';
  }
  // Ein einziges wiederholtes Zeichen ("aaaaaaaa", acht Leerzeichen).
  if (/^(.)\1*$/.test(pw)) {
    return 'Ein Passwort aus lauter gleichen Zeichen ist zu leicht zu raten. Bitte mische Buchstaben und Zahlen.';
  }
  // Reine Ziffernfolgen sind fast immer ein Datum. Ein einziger Buchstabe genuegt als Abhilfe.
  if (/^[0-9]+$/.test(pw)) {
    return 'Ein Passwort nur aus Ziffern ist zu leicht zu raten (Geburtsdaten sind der erste Versuch). Bitte nimm mindestens einen Buchstaben dazu.';
  }
  const name = String(username || '').trim().toLowerCase();
  if (name) {
    // Ab vier Zeichen auf ENTHALTENSEIN pruefen, darunter nur auf Gleichheit: Bei einem
    // Drei-Zeichen-Namen wie "Bob" wuerde sonst jedes Passwort mit "bob" darin abgelehnt.
    const trifft = name.length >= 4 ? klein.includes(name) : klein === name;
    if (trifft) {
      return 'Das Passwort darf deinen Spielernamen nicht enthalten - er ist oeffentlich sichtbar und damit der erste Rateversuch.';
    }
  }
  for (const begriff of PASSWORT_SPIELBEGRIFFE) {
    if (klein.includes(begriff)) {
      return 'Das Passwort darf den Namen des Spiels nicht enthalten - genau danach wird bei einem Spiel-Konto zuerst gesucht.';
    }
  }
  return null;
}

// --- Registrierung (E-Mail optional, aber nötig für Passwort-Reset) ---
app.post('/api/register', authRateLimit, async (req, res) => {
  const { username, password, email } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Name und Passwort erforderlich.' });
  const cleanName = String(username).trim();
  if (!/^[a-zA-Z0-9_\-äöüÄÖÜß]{3,18}$/.test(cleanName)) {
    return res.status(400).json({ error: cleanName.includes('@') ? 'Das erste Feld ist dein Spielername (kein @-Zeichen) - deine E-Mail-Adresse gehört ins E-Mail-Feld darunter. Beispiel-Name: Sternenjäger_7' : 'Bitte wähle einen Spielernamen mit 3 bis 18 Zeichen. Erlaubt sind Buchstaben, Zahlen sowie _ und - (keine Leer- oder Sonderzeichen). Beispiel: Sternenjäger_7' });
  }
  const pwProblem = passwortProblem(password, cleanName);
  if (pwProblem) return res.status(400).json({ error: pwProblem });
  if (containsBannedTerm(cleanName)) return res.status(400).json({ error: 'Dieser Spielername ist nicht erlaubt. Bitte wähle einen anderen.' });
  const key = cleanName.toLowerCase();
  if (db.users[key]) return res.status(409).json({ error: 'Dieser Name ist schon vergeben.' });
  // E-Mail ist seit dem Double-Opt-In PFLICHT: der Account wird erst nutzbar, nachdem der
  // Bestätigungslink aus der E-Mail geklickt wurde. Bestandskonten (ohne emailVerified-Feld)
  // sind davon nicht betroffen und bleiben normal nutzbar.
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) return res.status(400).json({ error: 'E-Mail-Adresse ist erforderlich (für die Konto-Bestätigung).' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'E-Mail-Adresse sieht ungültig aus.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const userId = crypto.randomUUID();
  const home = assignHomeSlot();
  db.users[key] = { userId, username: cleanName, passwordHash, email: cleanEmail, emailVerified: false, createdAt: Date.now(), homeSystem: home.system, homeSlot: home.slot };
  grantNewbieShield(userId); // 4 Tage Anfängerschutz ab Registrierung
  recordAnalyticsEvent(userId, 'funnel:register'); // Onboarding-Trichter: Konto angelegt

  if (!db.verifyTokens) db.verifyTokens = {};
  const verifyToken = crypto.randomBytes(32).toString('hex');
  db.verifyTokens[verifyToken] = { userId, expires: Date.now() + 24 * 60 * 60 * 1000 };
  await saveDb();

  const link = PUBLIC_URL + '/?verify=' + verifyToken;
  try {
    const html = voidSignalEmail({
      eyebrow: 'Eingehendes Signal',
      username: cleanName,
      statusLabel: 'Bestätigung ausstehend',
      statusColor: '#e0a548',
      bodyHtml: 'Willkommen, Kommandant. Deine Kolonie wartet auf Freischaltung. Bestätige den Kanal, um Zugriff auf dein Kommandozentrum zu erhalten.',
      ctaLabel: 'Konto Freischalten',
      ctaUrl: link,
      footerNote: 'Gültig für 24 Stunden. Danach verfällt das Signal automatisch.<br>Diese Registrierung nicht angefordert? Ignoriere diese Nachricht — dein Name bleibt ungeschützt.'
    });
    const text = voidSignalPlainText({
      username: cleanName, statusLabel: 'Bestätigung ausstehend',
      plainBody: 'Willkommen bei Kolonie Kepler-7! Bitte bestätige dein Konto über den folgenden Link (24 Stunden gültig). Erst danach kannst du dich anmelden. Wenn du dich nicht registriert hast, kannst du diese E-Mail ignorieren.',
      ctaUrl: link
    });
    await sendEmail(cleanEmail, 'Konto bestätigen – Kolonie Kepler-7', html, text);
  } catch (e) {
    console.error('Bestätigungsmail fehlgeschlagen:', e.message);
    // Konto trotzdem angelegt lassen - der Spieler kann über "erneut senden" einen neuen Versuch starten.
  }
  // Bewusst KEIN Token: der Account ist erst nach der E-Mail-Bestätigung nutzbar.
  res.status(201).json({ ok: true, needsVerification: true, username: cleanName });
});

// Konto über den Link aus der Bestätigungs-E-Mail freischalten.
app.post('/api/verify-email', async (req, res) => {
  const { token } = req.body || {};
  if (!db.verifyTokens) db.verifyTokens = {};
  const entry = db.verifyTokens[String(token || '')];
  if (!entry || entry.expires < Date.now()) return res.status(400).json({ error: 'Bestätigungslink ungültig oder abgelaufen. Fordere über den Login-Bildschirm bzw. die Kontoeinstellungen einen neuen an.' });
  const user = findUserById(entry.userId);
  if (!user) return res.status(404).json({ error: 'Konto nicht gefunden.' });
  let type = 'signup';
  if (entry.type === 'change') {
    type = 'change';
    if (user.pendingEmail) { user.email = user.pendingEmail; delete user.pendingEmail; }
    user.emailVerified = true; // eine bestätigte neue Adresse zählt auch als bestätigtes Konto
  } else {
    user.emailVerified = true;
    recordAnalyticsEvent(user.userId, 'funnel:verify'); // Onboarding-Trichter: Konto per E-Mail bestätigt (Aktivierung)
  }
  delete db.verifyTokens[token];
  await saveDb();
  res.json({ ok: true, username: user.username, type, email: user.email });
});

// Bestätigungs-E-Mail erneut senden. Braucht Name UND Passwort, damit niemand fremde Postfächer
// mit Mails fluten kann.
app.post('/api/resend-verification', authRateLimit, async (req, res) => {
  const { username, password } = req.body || {};
  const key = String(username || '').trim().toLowerCase();
  const user = db.users[key];
  if (!user) return res.json({ ok: true }); // keine Namens-Enumeration ermöglichen
  const valid = await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Falsches Passwort.' });
  if (user.emailVerified !== false) return res.json({ ok: true, alreadyVerified: true });
  if (!db.verifyTokens) db.verifyTokens = {};
  const verifyToken = crypto.randomBytes(32).toString('hex');
  db.verifyTokens[verifyToken] = { userId: user.userId, expires: Date.now() + 24 * 60 * 60 * 1000 };
  await saveDb();
  const link = PUBLIC_URL + '/?verify=' + verifyToken;
  try {
    const html = voidSignalEmail({
      eyebrow: 'Eingehendes Signal',
      username: user.username,
      statusLabel: 'Bestätigung ausstehend',
      statusColor: '#e0a548',
      bodyHtml: 'Hier ist dein neuer Bestätigungslink für dein Kommandozentrum.',
      ctaLabel: 'Konto Freischalten',
      ctaUrl: link,
      footerNote: 'Gültig für 24 Stunden. Danach verfällt das Signal automatisch.'
    });
    const text = voidSignalPlainText({
      username: user.username, statusLabel: 'Bestätigung ausstehend',
      plainBody: 'Hier ist dein neuer Bestätigungslink (24 Stunden gültig).', ctaUrl: link
    });
    await sendEmail(user.email, 'Konto bestätigen – Kolonie Kepler-7', html, text);
  } catch (e) { console.error('Bestätigungsmail fehlgeschlagen:', e.message); }
  res.json({ ok: true });
});

// --- Anmeldung ---
app.post('/api/login', authRateLimit, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Name und Passwort erforderlich.' });
  const key = String(username).trim().toLowerCase();
  const user = db.users[key];
  if (!user) return res.status(401).json({ error: 'Unbekannter Name oder falsches Passwort.' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Unbekannter Name oder falsches Passwort.' });
  if (user.banned) return res.status(403).json({ error: 'Dieses Konto wurde gesperrt.' });
  // Double-Opt-In: neue Konten (emailVerified === false) sind erst nach Klick auf den
  // Bestätigungslink nutzbar. Bestandskonten haben das Feld nicht und sind nicht betroffen.
  if (user.emailVerified === false) {
    return res.status(403).json({ error: 'Konto noch nicht bestätigt. Bitte klicke auf den Link in der Bestätigungs-E-Mail.', needsVerification: true });
  }

  // tv (tokenVersion) wird bei jedem Passwort-Reset hochgezählt und in authMiddleware gegengeprüft -
  // dadurch werden nach einem Passwortwechsel ALLE zuvor ausgestellten (bis zu 180 Tage gültigen)
  // Tokens sofort ungültig. Bestandskonten ohne Feld gelten als Version 0 (kein Zwangs-Logout).
  // sid (Sitzungs-ID) macht diese Anmeldung zur einzig gültigen: authMiddleware vergleicht die sid
  // im Token mit user.activeSessionId, ältere Geräte fliegen dadurch sofort raus (siehe dort).
  const sid = crypto.randomBytes(16).toString('hex');
  const previousSessionAt = user.activeSessionAt || null;
  user.activeSessionId = sid;
  user.activeSessionAt = Date.now();
  const token = jwt.sign({ userId: user.userId, username: user.username, tv: user.tokenVersion || 0, sid }, JWT_SECRET, { expiresIn: '180d' });
  await saveDb();
  recordAnalyticsEvent(user.userId, 'funnel:login'); // Onboarding-Trichter: erfolgreiche Anmeldung
  // supersededPrevious sagt dem Frontend, dass diese Anmeldung ein anderes Gerät verdrängt hat -
  // damit kann es einen Hinweis zeigen, statt dass der Spieler am alten Gerät rätselt.
  // Der Token reist WEITERHIN im Body mit - das ausgelieferte Frontend liest ihn dort, und ohne
  // ihn waere diese Etappe nicht mehr additiv.
  setzeSitzungsCookie(req, res, token);
  res.json({ token, userId: user.userId, username: user.username, supersededPrevious: !!previousSessionAt });
});

// Hinweis Mehrgeräte-Login: seit 25.07.2026 ist pro Konto immer nur EINE Sitzung aktiv. Jede
// Anmeldung erzeugt eine neue Sitzungs-ID (oben) und entwertet damit das Token des zuvor
// angemeldeten Geräts; authMiddleware antwortet diesem Gerät mit 401 + sessionSuperseded:true.
// Mehrere Tabs auf DEMSELBEN Gerät teilen sich localStorage und damit dasselbe Token - sie
// verdrängen sich gegenseitig also nicht. Nur ein erneuter Login (anderes Gerät, anderer Browser,
// privates Fenster) erzeugt eine neue Sitzung.

// Maskiert eine E-Mail für die Anzeige im Frontend (z.B. "an***@example.com"), damit sie nicht im
// Klartext über die API rausgeht, aber trotzdem wiedererkennbar bleibt.
function maskEmail(email) {
  if (!email) return '';
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const visible = local.slice(0, Math.min(2, local.length));
  return visible + '***@' + domain;
}
app.get('/api/me', authMiddleware, (req, res) => {
  const user = findUserById(req.userId);
  // Sternenstaub für die tägliche Anmeldung (15.08.2026). Bewusst HIER und nicht in /api/login:
  // Das Token überlebt Tage, ein Spieler mit gespeicherter Anmeldung durchläuft /api/login unter
  // Umständen wochenlang nicht - er bekäme seine Tagesgutschrift nie. /api/me läuft bei jedem
  // Spielstart. Die Gutschrift ist über den Tagesschlüssel idempotent, mehrfache Aufrufe am selben
  // Tag ändern also nichts.
  // Geschrieben wird nur, wenn wirklich etwas gutgeschrieben wurde - eine GET-Route soll nicht bei
  // jedem Aufruf einen Schreibvorgang auslösen.
  const staubNeu = staubAnmeldungGutschreiben(user);
  // Höchstmarke für die Meilenstein-Embleme fortschreiben, solange ein Rang LÄUFT (17.08.2026).
  // Dieselbe Stelle und derselbe Gedanke wie beim Sternenstaub darüber: /api/me ist der Moment, in
  // dem der Server den Spieler tatsächlich sieht. Damit erwischt es auch die Ränge, die vor der
  // Einführung dieser Marke vergeben wurden - sie werden beim nächsten Spielstart nachgetragen,
  // solange sie noch aktiv sind. Geschrieben wird wie beim Staub nur bei echter Änderung.
  const rangJetzt = supporterStatusCombined(req.userId);
  const stufeNeu = rangJetzt.active && spenderStufeJeFortschreiben(user, rangJetzt.tier);
  if (staubNeu > 0 || stufeNeu) saveDb();
  res.json({
    userId: req.userId, username: req.username,
    hasEmail: !!(user && user.email),
    maskedEmail: user ? maskEmail(user.email) : '',
    pendingEmail: user && user.pendingEmail ? maskEmail(user.pendingEmail) : null,
    wantsPatchnotes: user ? (user.wantsPatchnotes !== false) : true,
    // Zeitpunkt der Anmeldung, die die aktuell laufende Sitzung eröffnet hat. Im Spiel als
    // "Zuletzt angemeldet" sichtbar - die einzige Möglichkeit für Spieler zu erkennen, ob sich
    // jemand anderes an ihrem Konto angemeldet hat. null bei Konten, die sich seit Einführung
    // der Sitzungsführung noch nicht neu angemeldet haben.
    lastLoginAt: (user && user.activeSessionAt) || null,
    homeSystem: user && user.homeSystem, homeSlot: user && user.homeSlot,
    attackShieldMs: attackShieldRemaining(req.userId),
    season: seasonInfoForUser(req.userId),
    // Unterstützer-Rang (05.08.2026): schaltet die Unterstützer-Automatiken im Verteidigung-Tab
    // frei. Seit dem 15.08.2026 steckt darin auch die einmalige Testphase (`trial`), die dieselben
    // Funktionen ohne Spende freischaltet - der Server ist für beides die Autorität, siehe
    // supporterFeaturesFor().
    supporter: supporterFeaturesFor(req.userId),
    // `neu` sagt dem Spiel, ob es die Gutschrift ansagen soll - ohne das müsste es den Stand mit
    // dem letzten Start vergleichen, den es nach einem Neuladen gar nicht mehr kennt.
    staub: Object.assign({ neu: staubNeu }, staubStand(user || {}))
  });
});

// --- Abmelden auf DIESEM Geraet (Sicherheits-Audit P3, Etappe b: 19.08.2026) ---------------
// Bis hierher war Abmelden reine Client-Arbeit: localStorage leeren, neu laden, fertig. Mit dem
// Sitzungs-Cookie geht das nicht mehr - es ist HttpOnly, JavaScript kann es gar nicht erst
// anfassen. Ohne diese Route wuerde ein Klick auf "Abmelden" den Spieler beim naechsten Laden
// stillschweigend wieder ANMELDEN, und das waere schlimmer als kein Abmeldeknopf.
//
// BEWUSST OHNE authMiddleware. Der Zweck ist, ein Sitzungsgeheimnis loszuwerden - wer das will,
// darf daran nicht scheitern, weil genau dieses Geheimnis schon abgelaufen oder ungueltig ist.
// Zu holen gibt es hier nichts: Die Route liest nichts, schreibt nichts und kann nur die eigene
// Kopfzeile des Aufrufers loeschen. Ein fremder Ausloeser kaeme wegen SameSite=Lax ohnehin ohne
// Cookie an und traefe damit gar keine Sitzung.
//
// Sie beendet die Sitzung BEWUSST NICHT serverseitig, und das ist die ehrliche Grenze dieser
// Etappe: Sie uebersetzt, WO der Token liegt, nicht was Abmelden bedeutet. Vorher blieb das
// ausgestellte Token nach dem Abmelden ebenfalls gueltig, es hatte nur niemand mehr. Wer die
// Sitzung wirklich entwerten will, hat dafuer "Alle Sitzungen beenden" darunter.
app.post('/api/logout', (req, res) => {
  loescheSitzungsCookie(req, res);
  res.json({ ok: true });
});

// --- Alle Sitzungen beenden ---
// Für den Fall "jemand anderes ist an meinem Konto": zählt tokenVersion hoch (entwertet damit JEDES
// bisher ausgestellte Token, auch alte sid-lose aus der Zeit vor der Sitzungsführung) und löscht die
// aktive Sitzung. Danach ist NIEMAND mehr angemeldet - auch das aufrufende Gerät nicht, das ist so
// gewollt und wird im Spiel auch so angekündigt.
// Passwort-Bestätigung wie bei /api/update-email: verhindert, dass ein gestohlenes Token allein
// reicht, um den rechtmäßigen Besitzer auszusperren.
// Wichtig für die Erwartungshaltung: das allein schützt nicht dauerhaft, wenn das Passwort bekannt
// ist - dann kann sich derselbe Fremde direkt wieder anmelden. Das Spiel empfiehlt deshalb an der
// Stelle zusätzlich einen Passwortwechsel.
app.post('/api/logout-all', authMiddleware, authRateLimit, async (req, res) => {
  const { password } = req.body || {};
  const user = findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'Account nicht gefunden.' });
  const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Passwort stimmt nicht.' });
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  delete user.activeSessionId;
  delete user.activeSessionAt;
  await saveDb();
  // Das hochgezählte tokenVersion entwertet das Cookie ohnehin - authMiddleware lehnt es ab dem
  // nächsten Aufruf ab. Es trotzdem zu löschen ist kein Schmuck: Ein abgemeldeter Browser soll
  // kein totes Sitzungsgeheimnis mit sich herumtragen, auch kein wirkungsloses. Genau dafür ist
  // "alle Sitzungen beenden" da.
  loescheSitzungsCookie(req, res);
  res.json({ ok: true });
});

// --- E-Mail hinterlegen oder ändern (mit Bestätigung auf der NEUEN Adresse + Passwort-Check) ---
// Die neue Adresse wird erst nach Klick auf den Bestätigungslink aktiv (verhindert Tippfehler und dass
// ein gekaperter Login allein reicht, um Passwort-Reset-Mails auf eine fremde Adresse umzuleiten).
app.post('/api/update-email', authMiddleware, async (req, res) => {
  const { email, password } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ error: 'E-Mail-Adresse sieht ungültig aus.' });
  const user = findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'Account nicht gefunden.' });
  const valid = await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Falsches Passwort.' });
  if (cleanEmail === user.email) return res.status(400).json({ error: 'Das ist bereits deine hinterlegte E-Mail-Adresse.' });

  user.pendingEmail = cleanEmail;
  if (!db.verifyTokens) db.verifyTokens = {};
  const changeToken = crypto.randomBytes(32).toString('hex');
  db.verifyTokens[changeToken] = { userId: user.userId, type: 'change', expires: Date.now() + 24 * 60 * 60 * 1000 };
  await saveDb();

  const link = PUBLIC_URL + '/?verify=' + changeToken;
  try {
    const html = voidSignalEmail({
      eyebrow: 'E-Mail-Wechsel',
      username: user.username,
      statusLabel: 'Neue Adresse bestätigen',
      statusColor: '#5dcaa5',
      bodyHtml: 'Für dein Kommandozentrum wurde diese Adresse als neuer Kommunikationskanal hinterlegt. Bestätige sie, damit sie aktiv wird.',
      ctaLabel: 'Neue E-Mail bestätigen',
      ctaUrl: link,
      footerNote: 'Gültig für 24 Stunden.<br>Diese Änderung nicht angefordert? Ignoriere diese Nachricht — an deinem Konto ändert sich nichts, bis der Link geklickt wird.'
    });
    const text = voidSignalPlainText({
      username: user.username, statusLabel: 'Neue Adresse bestätigen',
      plainBody: 'Bitte bestätige deine neue E-Mail-Adresse für dein Kommandozentrum über den folgenden Link (24 Stunden gültig).',
      ctaUrl: link
    });
    await sendEmail(cleanEmail, 'Neue E-Mail bestätigen – Kolonie Kepler-7', html, text);
  } catch (e) {
    console.error('Bestätigungsmail (E-Mail-Wechsel) fehlgeschlagen:', e.message);
    return res.status(502).json({ error: 'Bestätigungsmail konnte nicht versendet werden. Bitte später erneut versuchen.' });
  }
  res.json({ ok: true, pending: true });
});

// --- Mail-Präferenzen (z.B. Patchnotes-Abo) ---
app.post('/api/email-preferences', authMiddleware, async (req, res) => {
  const { wantsPatchnotes } = req.body || {};
  const user = findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'Account nicht gefunden.' });
  user.wantsPatchnotes = !!wantsPatchnotes;
  await saveDb();
  res.json({ ok: true, wantsPatchnotes: user.wantsPatchnotes });
});

// --- Passwort-Reset anfordern ---
app.post('/api/request-password-reset', authRateLimit, async (req, res) => {
  const { username } = req.body || {};
  const key = String(username || '').trim().toLowerCase();
  const user = db.users[key];
  // Absichtlich immer "ok" zurückgeben, auch wenn's den Namen nicht gibt - sonst könnte man
  // durch Ausprobieren herausfinden, welche Namen existieren.
  if (!user || !user.email) return res.json({ ok: true });

  const token = crypto.randomBytes(32).toString('hex');
  db.resetTokens[token] = { userId: user.userId, expires: Date.now() + 60 * 60 * 1000 };
  await saveDb();

  const link = PUBLIC_URL + '/?reset=' + token;
  try {
    const html = voidSignalEmail({
      eyebrow: 'Sicherheitsprotokoll',
      username: user.username,
      statusLabel: 'Zugangsanfrage erkannt',
      statusColor: '#e24b4a',
      bodyHtml: 'Für dein Kommandozentrum wurde ein neuer Zugang angefordert. Vergib über den folgenden Kanal ein neues Passwort.',
      ctaLabel: 'Neues Passwort vergeben',
      ctaUrl: link,
      footerNote: 'Gültig für 1 Stunde. Danach verfällt das Signal automatisch.<br>Diese Anfrage nicht gestellt? Ignoriere diese Nachricht — dein Passwort bleibt unverändert.'
    });
    const text = voidSignalPlainText({
      username: user.username, statusLabel: 'Zugangsanfrage erkannt',
      plainBody: 'Du hast einen neuen Zugang zu deiner Kolonie angefordert. Vergib über den folgenden Link ein neues Passwort (1 Stunde gültig). Wenn du das nicht warst, kannst du diese E-Mail ignorieren.',
      ctaUrl: link
    });
    await sendEmail(user.email, 'Passwort zurücksetzen – Kolonie Kepler-7', html, text);
  } catch (e) {
    console.error('Mailversand fehlgeschlagen:', e.message);
  }
  res.json({ ok: true });
});

// --- Neues Passwort mit Token setzen ---
app.post('/api/reset-password', authRateLimit, async (req, res) => {
  const { token, newPassword } = req.body || {};
  const entry = db.resetTokens[token];
  if (!entry || entry.expires < Date.now()) return res.status(400).json({ error: 'Link ist ungültig oder abgelaufen. Fordere einen neuen an.' });
  const user = findUserById(entry.userId);
  if (!user) return res.status(404).json({ error: 'Account nicht gefunden.' });
  // Die Pruefung steht bewusst HINTER findUserById: Nur so kennt sie den Spielernamen und
  // kann ihn im Passwort abweisen. Der Token ist an dieser Stelle laengst geprueft.
  const pwProblem = passwortProblem(newPassword, user.username);
  if (pwProblem) return res.status(400).json({ error: pwProblem });
  user.passwordHash = await bcrypt.hash(newPassword, 10);
  // Alle bisher ausgestellten Tokens dieses Kontos ungültig machen (siehe authMiddleware) - wer das
  // Passwort zurücksetzt, wirft damit auch mögliche fremde/gekaperte Sitzungen sofort raus.
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  // Auch die aktive Sitzung zurücksetzen: nach dem Reset ist kein Gerät mehr angemeldet, die
  // nächste Anmeldung startet also sauber (und meldet nicht fälschlich "anderes Gerät verdrängt").
  delete user.activeSessionId;
  delete user.activeSessionAt;
  delete db.resetTokens[token];
  await saveDb();
  res.json({ ok: true });
});

// Mail-Versand und Void-Signal-Vorlagen liegen in mailer.js (gemeinsam mit send_patchnotes.js genutzt).
const { sendEmail, voidSignalEmail, voidSignalPlainText, buildPatchnotesEmail } = require('./mailer');

// --- Speicher lesen/schreiben (privat pro Account / geteilt für alle) ---
// Private Werte (shared=false) werden mit einer Versionsnummer gespeichert, damit ein
// veraltetes Gerät (z.B. ein Tab, der seit Stunden offen war) nicht versehentlich den
// neueren Spielstand eines anderen Geräts überschreibt.
app.get('/api/storage/:key', authMiddleware, (req, res) => {
  const shared = req.query.shared === 'true';
  const key = req.params.key;
  if (shared) {
    const denyReason = checkAllianceKeyPermission(req, key, false) || checkPactKeyPermission(req, key, false) || checkChatKeyPermission(req, key, false) || checkHallOfFamePermission(req, key, false) || checkMoonDefensePermission(req, key, false) || checkWorldBossPermission(req, key, false) || checkMissionsKeyPermission(req, key, false) || checkAsteroidKeyPermission(req, key, false);
    if (denyReason) return res.status(403).json({ error: denyReason });
  }
  const store = shared ? db.shared : (db.private[req.userId] || {});
  const entry = store[key];
  if (entry === undefined) return res.status(404).json({ error: 'not found' });
  // Unterstützer-Abzeichen wird bei JEDEM Lesen frisch berechnet (nicht nur beim Schreiben, siehe
  // PUT unten) - sonst würde ein Eintrag, der beim Ablaufen der 30 Tage gerade nicht neu geschrieben
  // wird (Spieler pausiert), das Abzeichen fälschlich unbegrenzt weitertragen.
  if (shared && key.startsWith('leaderboard:') && typeof entry === 'string') {
    try {
      const parsed = JSON.parse(entry);
      // supporterStatusCombined (05.08.2026): Spende ODER manuell vergebener Rang - beides ist ein
      // Rang und traegt deshalb dasselbe Abzeichen. Die gamegeeeeek-Ausnahme steckt bewusst NICHT
      // darin, die schaltet nur Funktionen frei.
      const besitzerId = key.slice('leaderboard:'.length);
      const status = supporterStatusCombined(besitzerId);
      parsed.isSupporter = status.active;
      parsed.supporterTier = status.active ? status.tier : null;
      // Kosmetik (15.08.2026) aus derselben Erwägung wie isSupporter darüber: Namensfarbe und
      // Emblem stehen in einer Liste, die alle sehen - der Client darf sie nicht selbst setzen.
      // Was hier hineingeschrieben wird, ist die serverseitig geprüfte Auswahl; ein abgelaufenes
      // Spender-Stück fällt dabei von selbst auf die Vorgabe zurück (siehe kosmetikGetragen).
      parsed.cosmetics = kosmetikGetragen(besitzerId);
      return res.json({ key, value: JSON.stringify(parsed), shared, version: 0 });
    } catch (e) { /* kaputter Eintrag - unverändert durchreichen, kein Absturz */ }
  }
  if (shared || typeof entry === 'string') return res.json({ key, value: entry, shared, version: 0 });
  res.json({ key, value: entry.value, shared, version: entry.version || 0 });
});

app.put('/api/storage/:key', authMiddleware, async (req, res) => {
  const shared = req.query.shared === 'true';
  const key = req.params.key;
  const value = (req.body && typeof req.body.value === 'string') ? req.body.value : JSON.stringify(req.body ? req.body.value : null);
  const expectedVersion = req.body ? req.body.expectedVersion : undefined;

  if (shared) {
    const denyReason = checkAllianceKeyPermission(req, key, true) || checkPactKeyPermission(req, key, true) || checkChatKeyPermission(req, key, true) || checkHallOfFamePermission(req, key, true) || checkMoonDefensePermission(req, key, true) || checkWorldBossPermission(req, key, true) || checkMissionsKeyPermission(req, key, true) || checkAsteroidKeyPermission(req, key, true);
    if (denyReason) return res.status(403).json({ error: denyReason });
    // Mengenschutz (siehe MAX_SHARED_VALUE_BYTES oben). Bewusst NACH der Rechteprüfung und VOR jedem
    // Schreibzugriff - und bewusst nur für NEUE Schlüssel, damit die normale Spielschleife
    // (Überschreiben vorhandener Dokumente) auch am Deckel weiterläuft.
    const wertBytes = Buffer.byteLength(value || '', 'utf8');
    if (wertBytes > MAX_SHARED_VALUE_BYTES) {
      console.log('[shared-reject] userId=' + req.userId + ' key=' + key + ' bytes=' + wertBytes);
      return res.status(413).json({ error: 'Wert zu groß für den geteilten Speicher (' + Math.round(wertBytes / 1024) + ' KB, erlaubt sind ' + (MAX_SHARED_VALUE_BYTES / 1024) + ' KB).' });
    }
    if (db.shared[key] === undefined && Object.keys(db.shared).length >= MAX_SHARED_KEYS) {
      console.log('[shared-reject] userId=' + req.userId + ' key=' + key + ' reason=keylimit');
      return res.status(507).json({ error: 'Der geteilte Speicher ist voll - neue Einträge sind vorübergehend gesperrt. Bestehende lassen sich weiter aktualisieren.' });
    }
    // Spionage-Ping (Gegenspionage-Feedback): reiner Info-Ping, der dem ausgespähten Spieler eine
    // "du wurdest ausgespäht"-Benachrichtigung zustellt. Wird NICHT persistent gespeichert (kein
    // Datenmüll im geteilten Speicher) und ist gegen Fälschung abgesichert: nur der eingeloggte
    // Absender darf pingen (payload.fromId muss == req.userId sein), das Ziel muss existieren und darf
    // nicht man selbst sein. So kann niemand fremde Namen unterschieben oder sich selbst pingen.
    if (key.startsWith('spyping:')) {
      const targetId = key.slice('spyping:'.length);
      try {
        const payload = JSON.parse(value);
        if (payload && payload.fromId === req.userId && targetId && targetId !== req.userId) {
          const targetUser = findUserById(targetId);
          if (targetUser) {
            const prefs = getNotifPrefs(targetUser);
            if (prefs.enabled && prefs.spy) {
              pushNotificationEvent(targetId, 'spy-detected', { fromName: String(payload.fromName || 'Ein Spieler').slice(0, 40), deep: !!payload.deep });
            }
          }
        }
      } catch (e) { /* kaputter Ping - ignorieren, kein Absturz */ }
      return res.json({ ok: true });
    }
    // Wortfilter (13.07.2026, Feature-Wunsch: Moderation vorbereiten) - Allianz-Tag (aus dem
    // Schlüssel) und -Name (aus dem Wert) auf unangemessene Begriffe prüfen, bevor eine Gründung/
    // Umbenennung überhaupt gespeichert wird.
    const allianceInfoMatch = key.match(/^alliance:([^:]+):info$/);
    if (allianceInfoMatch) {
      if (containsBannedTerm(allianceInfoMatch[1])) return res.status(400).json({ error: 'Dieser Allianz-Tag ist nicht erlaubt.' });
      try {
        const parsedInfo = JSON.parse(value);
        if (parsedInfo && containsBannedTerm(parsedInfo.name)) return res.status(400).json({ error: 'Dieser Allianz-Name ist nicht erlaubt.' });
      } catch (e) {}
    }
    // Bestenlisten-Eintrag: nur der eigene, und Score/Wochen-Score werden IMMER serverseitig aus dem
    // echten Spielstand nachgerechnet und überschrieben - der vom Client mitgeschickte Wert wird nur
    // für die übrigen (kosmetischen) Felder wie Name/Avatar/Online-Zeitstempel übernommen.
    let finalValue = value;
    if (key.startsWith('leaderboard:')) {
      const targetId = key.slice('leaderboard:'.length);
      if (targetId !== req.userId) return res.status(403).json({ error: 'Du kannst nur deinen eigenen Bestenlisten-Eintrag schreiben.' });
      const mySaveRaw = getSaveValue(req.userId);
      if (mySaveRaw) {
        try {
          const mySave = JSON.parse(mySaveRaw);
          const correctScore = computeScoreServer(mySave);
          const correctWeekScore = Math.max(0, correctScore - ((mySave.weeklyLeague && mySave.weeklyLeague.startScore) || 0));
          const submitted = JSON.parse(value);
          submitted.score = correctScore;
          submitted.weekScore = correctWeekScore;
          // Wie Score/Wochenscore darüber: der Client könnte isSupporter sonst einfach selbst auf
          // true setzen. GET überschreibt das ohnehin bei jedem Lesen erneut (siehe oben), das hier
          // ist nur Verteidigung in der Tiefe, damit der gespeicherte Wert auch für sich stimmt.
          const submittedStatus = supporterStatusCombined(targetId);
          submitted.isSupporter = submittedStatus.active;
          submitted.supporterTier = submittedStatus.active ? submittedStatus.tier : null;
          // Wie isSupporter: GET überschreibt das ohnehin bei jedem Lesen erneut, das hier ist
          // Verteidigung in der Tiefe, damit auch der gespeicherte Wert für sich stimmt.
          submitted.cosmetics = kosmetikGetragen(targetId);
          finalValue = JSON.stringify(submitted);
        } catch (e) { /* Spielstand/Wert kaputt - unverändert durchreichen, kein Absturz */ }
      }
    }
    const prevValue = db.shared[key];
    db.shared[key] = finalValue;
    handleSharedStorageWrite(key, prevValue, finalValue);
    await saveDb();
    return res.json({ key, value: finalValue, shared });
  }

  // ===== Serverinterne Felder sind für den Client tabu (10.08.2026) ==============================
  // Der private Bereich enthält nicht nur den Spielstand des Kontos, sondern siebzehn Felder, die
  // AUSSCHLIESSLICH der Server führt und denen er beim Lesen vertraut: __rkBasis (wie viel
  // Zählerfortschritt schon in Kriegspunkte umgetauscht wurde), __rkNachschubAt (die
  // Vier-Stunden-Sperre der Nachschubspende), __pendingRewards (die Belohnungs-Warteschlange, deren
  // ganzer Zweck es ist, dass der Server entscheidet und der Client nur ausführt),
  // __attackShieldUntil, __lastAttackPush, __sabotageCooldowns und weitere.
  //
  // Diese Route schrieb bis heute JEDEN Schlüssel. Gemessen (tests/test_privatschluessel_http.js,
  // Lauf am alten Stand) waren die Folgen konkret:
  //   - Nach `PUT /api/storage/__rkBasis` mit {} ließ sich derselbe Zählerstand ein zweites Mal in
  //     Kriegspunkte umtauschen (72 Punkte für Expeditionen, die schon abgerechnet waren) - der
  //     Zusammenhang "du musst wirklich gespielt haben" war damit aufgehoben.
  //   - Nach `PUT /api/storage/__rkNachschubAt` mit 0 lief die Nachschubspende erneut durch: Der
  //     gefälschte Wert wird als { value, version } abgelegt, der Server rechnet damit
  //     `objekt + MS - Date.now()`, das ergibt NaN, und `NaN > 0` ist falsch - der Vergleich fällt
  //     also nach DURCHLASSEN.
  //   - `GET /api/pending-rewards` lieferte danach `{ rewards: { value:"0", version:0 } }` statt
  //     einer Liste. Fremde Belohnungen lassen sich so zwar nicht erzeugen (die Abholroute prüft
  //     `list.length` und liefert dann null), aber die eigene Warteschlange wird zerstört.
  //
  // Die Sperre ist eng gezogen: Sie trifft nur das '__'-Präfix, unter dem der Server seine eigenen
  // Felder führt. Der Spielstand (kepler7-save-v3) und jeder gewöhnliche Schlüssel bleiben
  // schreibbar - nachgeprüft ist auch, dass das Frontend keinen einzigen '__'-Schlüssel schreibt
  // (Suche in weltraum_kolonie.html: null Treffer). LESEN bleibt erlaubt: Es sind die eigenen Daten
  // des Kontos, ein Lesezugriff ist keine Rechteausweitung, und eine Sperre dort würde nur
  // Angriffsfläche gegen eine Funktion schaffen, die niemandem etwas gibt.
  if (key.startsWith('__')) {
    console.warn('[privat-reject] userId=' + req.userId + ' key=' + key);
    return res.status(403).json({ error: 'Dieser Schlüssel wird vom Server geführt und kann nicht überschrieben werden.' });
  }

  // Plausibilitäts-Check NUR für den eigentlichen Spielstand (siehe saveSanityViolation oben) - andere
  // private Schlüssel (Einstellungen o.ä.) sind kein PvP-/Bestenlisten-relevanter Zustand und werden
  // bewusst nicht eingeschränkt.
  if (key === SAVE_KEY) {
    try {
      const violation = saveSanityViolation(JSON.parse(value));
      if (violation) {
        // Sichtbar loggen: eine Ablehnung bedeutet für den Spieler faktisch kompletten Speicherverlust,
        // das darf nie unbemerkt passieren. So lässt sich im docker-log sofort sehen, WELCHER Wert bei
        // WELCHEM Konto anschlägt (falls trotz angehobener Grenzen noch etwas rejected wird, z.B. ein
        // NaN/negativer Wert aus einem Client-Bug).
        console.warn('[save-reject] userId=' + req.userId + ' reason=' + violation);
        return res.status(400).json({ error: 'Spielstand abgelehnt (unplausibler Wert): ' + violation });
      }
    } catch (e) { return res.status(400).json({ error: 'Spielstand ist kein gültiges JSON.' }); }
  }

  db.private[req.userId] = db.private[req.userId] || {};
  const existing = db.private[req.userId][key];
  const existingVersion = existing === undefined ? -1 : (typeof existing === 'string' ? 0 : (existing.version || 0));

  if (typeof expectedVersion === 'number' && existing !== undefined && expectedVersion !== existingVersion) {
    const existingValue = typeof existing === 'string' ? existing : existing.value;
    return res.status(409).json({
      error: 'Konflikt: Ein anderes Gerät hat zwischenzeitlich gespeichert.',
      currentValue: existingValue, currentVersion: existingVersion
    });
  }

  const newVersion = existingVersion + 1;
  const istErsterSpielstand = key === SAVE_KEY && existing === undefined;
  db.private[req.userId][key] = { value, version: newVersion };
  // Ein neuer Spieler hat die Kolonie zum ersten Mal geoeffnet -> Push an das Betreiberkonto
  // (22.08.2026, Auftrag Sascha: "wenn sich neuer spieler anmeldet und spielt bekommt gamegeeeeek
  // eine push nachricht"; Ausloesepunkt und Buendelung von ihm gewaehlt).
  //
  // WARUM HIER und nicht bei /api/register: Die Registrierung stellt bewusst kein Token aus, und
  // /api/login lehnt emailVerified === false mit 403 ab. Erst dieser Endpunkt ist also hinter der
  // E-Mail-Bestaetigung erreichbar. An /api/register gehaengt waere die Meldung mit gemessen 1.440
  // Aufrufen je Tag und IP flutbar, ohne dass der Absender je eine Mail lesen muesste.
  //
  // WARUM ES KEINE ZUSAETZLICHE MARKE BRAUCHT: 'existing === undefined' bei SAVE_KEY ist einmalig
  // je Konto - gemessen gibt es keinen Pfad, der einen Spielstand LOESCHT (kein 'delete
  // db.private[...]', kein Ueberschreiben des Kontos mit {}), und kein Fremdzugriff kann dem
  // ersten Save zuvorkommen: /api/attack bricht mit 404 ab, wenn das Ziel keinen Spielstand hat.
  // Die Bedingung ist damit selbst die Idempotenz-Marke.
  //
  // Und die ehrliche Grenze der Aussage: Der erste Save feuert automatisch beim ersten Boot des
  // Spiels ('Neue Kolonie gestartet'), also Sekunden nach dem ersten Login. Die Meldung sagt
  // deshalb "hat die Kolonie zum ersten Mal geoeffnet" und nicht "spielt" - sie behauptet nur,
  // was sie belegen kann.
  if (istErsterSpielstand) {
    // In try/catch UND vor saveDb(): Der Save des Spielers darf an einer Betreiber-Meldung nie
    // scheitern (er ist der Vorgang, um den es hier geht), und pushNotificationEvent schreibt den
    // Postfach-Eintrag nur in den Arbeitsspeicher - hinter dem saveDb() eingebaut waere er beim
    // naechsten Neustart weg. Genau dieser Fehler ist bei der Feedback-Push schon einmal passiert.
    try {
      const devUser = db.users['gamegeeeeek'];
      if (devUser) {
        const prefs = getNotifPrefs(devUser);
        if (prefs.enabled && prefs.neuspieler) {
          const gesamt = Object.keys(db.private).filter(uid => db.private[uid] && db.private[uid][SAVE_KEY] !== undefined).length;
          pushNotificationEvent(devUser.userId, 'neuer-spieler', { username: req.username, gesamt });
        }
      }
    } catch (e) { console.error('Neuer-Spieler-Push fehlgeschlagen (der Spielstand ist gespeichert):', e.message); }
  }
  await saveDb();
  res.json({ key, value, shared, version: newVersion });
});

app.get('/api/storage-list', authMiddleware, (req, res) => {
  const prefix = req.query.prefix || '';
  // Bewerbungs- und Protokolllisten sind wie einzelne Einträge geschützt (siehe
  // checkAllianceKeyPermission) - ohne diese Prüfung könnte jeder per Präfix-Auflistung alle
  // Bewerbernamen bzw. das Aktivitätsprotokoll fremder Allianzen sehen, selbst wenn das Lesen eines
  // einzelnen Eintrags schon korrekt blockiert wäre.
  const appMatch = prefix.match(/^alliance:([^:]+):applications:$/);
  const logMatch = prefix.match(/^alliance:([^:]+):auditlog/);
  const guarded = appMatch || logMatch;
  if (guarded) {
    const tag = guarded[1];
    const role = allianceRoleOf(tag, req.userId);
    if (role !== 'admin' && role !== 'officer') {
      return res.status(403).json({ error: 'Nur Admins/Offiziere dürfen das einsehen.' });
    }
  }
  const keys = Object.keys(db.shared).filter(k => k.startsWith(prefix));
  res.json({ keys });
});

// --- Chat: Bündel-Abruf (28.08.2026, Chat-Großetappe A) ---
// Bis hierher las das Frontend einen Chat-Kanal in ~1+50 Anfragen: storage-list für die Schlüssel,
// dann storageGet je Nachricht - gegen das globale Rate-Limit von 240/min je Verbindung (ein
// Panel-Öffnen mit beiden Kanälen verbrauchte davon ~100). Diese Route liefert denselben Inhalt in
// EINER Antwort und ist die Grundlage der Live-Aktualisierung im Frontend (Poll bei offenem Panel).
// Leserechte exakt wie der alte Weg: authMiddleware, mehr nicht - das Lesen von Chat-Schlüsseln war
// im generischen Storage schon immer für jedes angemeldete Konto offen (checkChatKeyPermission
// prüft nur das SCHREIBEN, authorId === req.userId). Diese Route öffnet also nichts, sie bündelt.
// Der Allianz-Tag wird nur FORMAL geprüft (kein Doppelpunkt, Länge <= 16): Er landet als Präfix in
// einer In-Memory-Suche über Object.keys, nie in einem Pfad oder Befehl - ein erfundener Tag
// liefert schlicht eine leere Liste, genau wie beim alten storage-list-Weg.
// Sortiert wird über chatKeyTimestamp (numerisch nach dem Zeitstempel im Schlüssel, wie
// pruneChatKeys) - eine String-Sortierung wäre bei zehnstelligen gegen dreizehnstellige
// Zeitstempel falsch. `neuesteTs` erlaubt dem Poll die billige Frage "gibt es Neues?", ohne die
// Antwort selbst zu vergleichen.
app.get('/api/chat/:kanal', authMiddleware, (req, res) => {
  const kanal = req.params.kanal;
  let prefix = null;
  if (kanal === 'global') {
    prefix = 'globalchat:msg:';
  } else if (kanal === 'allianz') {
    const tag = String(req.query.tag || '').trim();
    if (!tag || tag.length > 16 || tag.includes(':')) return res.status(400).json({ error: 'Ungültiger Allianz-Tag.' });
    prefix = 'alliance:' + tag + ':msg:';
  } else {
    return res.status(400).json({ error: 'Unbekannter Kanal.' });
  }
  // Der Deckel hängt an CHAT_KEEP_PER_CHANNEL: mehr als die Aufbewahrung hält, kann es nicht geben,
  // und eine eigene zweite Obergrenze daneben liefe beim nächsten Umbau auseinander.
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > CHAT_KEEP_PER_CHANNEL) limit = CHAT_KEEP_PER_CHANNEL;
  const keys = Object.keys(db.shared).filter(k => k.startsWith(prefix));
  keys.sort((a, b) => chatKeyTimestamp(a) - chatKeyTimestamp(b));
  const nachrichten = [];
  for (const k of keys.slice(-limit)) {
    // Ein einzelner kaputter Eintrag (kein JSON) darf nicht den ganzen Kanal unlesbar machen -
    // er wird übersprungen, genau wie ihn das Frontend beim Einzel-Lesen verworfen hätte.
    try { const m = JSON.parse(db.shared[k]); if (m && typeof m === 'object') nachrichten.push(m); } catch (e) {}
  }
  res.json({ ok: true, nachrichten, neuesteTs: keys.length ? chatKeyTimestamp(keys[keys.length - 1]) : 0 });
});

// --- Berichte (Angriffs-/Überfall-Protokolle) ---
app.get('/api/reports', authMiddleware, (req, res) => {
  const list = (db.private[req.userId] && db.private[req.userId].__reports) || [];
  // `archiv` wandert mit, damit das Spiel "37 von 150" zeigen kann, ohne die Zahl selbst zu kennen -
  // sonst stünde die Grenze an einer zweiten Stelle und veraltete beim nächsten Umbau.
  // `platz` ist der tatsächlich gültige Deckel, nicht der nominelle: Bei einem ehemaligen
  // Unterstützer ist das Archiv auf seiner erreichten Größe eingefroren und damit größer als
  // REPORTS_MAX_STANDARD (siehe addReport).
  res.json({
    reports: list,
    archiv: { belegt: list.length, platz: Math.max(reportLimitFor(req.userId), list.length),
              standard: REPORTS_MAX_STANDARD, unterstuetzer: REPORTS_MAX_SUPPORTER }
  });
});

app.post('/api/reports', authMiddleware, async (req, res) => {
  const report = req.body && req.body.report;
  if (!report) return res.status(400).json({ error: 'Kein Bericht übergeben.' });
  addReport(req.userId, report);
  await saveDb();
  res.json({ ok: true });
});

// ===== Berichts-Archiv (16.08.2026) =====
// Unterstützer bekommen ein größeres Archiv. Die interessante Frage war nicht die Zahl, sondern was
// beim ABLAUF eines Rangs passiert: Ein schlichtes `slice(0, deckel)` hätte einem ehemaligen
// Unterstützer beim nächsten Kampf über hundert Kampfberichte GELÖSCHT. Ein Deckel, der Historie
// vernichtet, sobald jemand aufhört zu spenden, ist der falsche Anreiz - er bestraft das Aufhören,
// statt das Unterstützen zu belohnen, und der Betroffene merkt es erst, wenn er nachsehen will.
//
// Der Deckel begrenzt deshalb nur das WACHSTUM und räumt nie ab: behalten wird immer mindestens so
// viel, wie vor diesem Bericht schon dalag. Ein abgelaufener Rang friert das Archiv damit auf
// seiner erreichten Größe ein, statt es zu kürzen. Nach oben ist alles trotzdem begrenzt - mehr als
// REPORTS_MAX_SUPPORTER kann so nie entstehen.
const REPORTS_MAX_STANDARD = 40;
const REPORTS_MAX_SUPPORTER = 150;
function reportLimitFor(userId) {
  try { return supporterFeaturesFor(userId).active ? REPORTS_MAX_SUPPORTER : REPORTS_MAX_STANDARD; }
  catch (e) { return REPORTS_MAX_STANDARD; }
}
function addReport(userId, report) {
  db.private[userId] = db.private[userId] || {};
  const list = db.private[userId].__reports || [];
  const vorher = list.length;
  list.unshift(Object.assign({ id: crypto.randomUUID(), time: Date.now() }, report));
  db.private[userId].__reports = list.slice(0, Math.max(reportLimitFor(userId), vorher));
}

app.delete('/api/reports/:id', authMiddleware, async (req, res) => {
  const list = (db.private[req.userId] && db.private[req.userId].__reports) || [];
  db.private[req.userId].__reports = list.filter(r => r.id !== req.params.id);
  await saveDb();
  res.json({ ok: true });
});

app.delete('/api/reports', authMiddleware, async (req, res) => {
  if (db.private[req.userId]) db.private[req.userId].__reports = [];
  await saveDb();
  res.json({ ok: true });
});

// ============ Echtes PvP: serverseitige Kampfberechnung ============
// WICHTIG: Diese Formeln MÜSSEN mit den Formeln in weltraum_kolonie.html (Frontend) übereinstimmen,
// sonst rechnet echtes PvP über den Server nach anderen Regeln als alles andere im Spiel. Stand:
// 12.07.2026, synchron zu Frontend v7.64.0 (Kontersystem, Taktik-Haltung, Heimatbasis-Bonus,
// Mega-Flotten-Grenznutzen, Anti-Farming). Bekannte, noch NICHT synchronisierte Frontend-Boni, die
// hier bewusst fehlen (vorbestehende Lücke, nicht neu): Doktrin, Prestige-Perks, Skill-Baum,
// Allianzforschung, Buffs, Planeten-Rollen, Mega-Projekte, Artefakt-Bonus. Ebenfalls fehlend: die
// Verteidigungsgebäude – defVal EXAKT wie im Frontend (BUILDING_DEFS, category:'defense'). 23.07.2026:
// Tabelle war stark veraltet (nur 8 Gebäude, festung/flak falsch) – dadurch zählten die meisten
// modernen Verteidigungsgebäude im server-autoritativen PvP GAR NICHT. Jetzt vollständig gespiegelt.
// (abhorchposten/mondschild haben defVal 0 – reine Utility, tragen wie im Frontend nichts bei.)
const DEFENSE_VALUES = {
  turm: 15, flak: 10, schild: 30, ionenschild: 45, laser: 25, plasma: 50, raketen: 40, gauss: 65,
  railgun: 85, voidbarriere: 110, festung: 350, bunker: 135, nanoplattform: 150, sensorphalanx: 20,
  schildkuppel: 220, fusionsbastion: 250, kiverteidigung: 300, metamaterialwall: 340, singularitaetsturm: 330,
  // 01.08.2026: resonanzschild fehlte hier - mit defVal 420 der HOECHSTE Verteidigungswert des
  // ganzen Spiels (ueber Festung 350 und Metamaterialwall 340). Da das server-autoritative PvP
  // ausschliesslich ueber Object.entries(DEFENSE_VALUES) summiert, zaehlte das teuerste
  // Verteidigungsgebaeude im echten Kampf mit NULL - samt des 40%-Schildzuschlags darauf. Das
  // Frontend zeigte es in der Verteidigungssumme an (es summiert ueber BUILDING_DEFS selbst), der
  // Angreifer raeumte den Spieler trotzdem ab.
  resonanzschild: 420,
  // Diese beiden haben defVal 0 und aendern die Summe nicht - sie stehen hier, damit die
  // Schluesselmenge beider Seiten deckungsgleich ist und der Paritaetstest sie vergleichen kann.
  // Ohne sie muesste der Test eine Ausnahmeliste pflegen, und genau solche Listen veralten.
  abhorchposten: 0, mondschild: 0
};
// Gebäude-Schildanteil: im Frontend trägt jedes Verteidigungsgebäude defVal + round(defVal*0.4) bei
// (der Schild-Zuschlag). Serverseitig als Faktor 1.4 auf die Gebäude-Summe abgebildet.
const BUILDING_SHIELD_FACTOR = 1.4;
// Bastionsmarken (18.08.2026, V2a des Verteidigungs-Konzepts) - die Server-Kopie der
// Frontend-Formel, dieselbe Kopie-Familie wie SHIP_SCORE_WEIGHTS/computeScoreServer und
// DEFENSE_VALUES selbst.
//
// SIE MUSS HIER SEIN. Das Konzept hat behauptet, V2 brauche "weder Backend-Paritaet noch
// Bestandsschutz" - das ist beim Nachrechnen falsch: computeDefensePower() summiert
// server-autoritativ ueber DEFENSE_VALUES und entscheidet damit jeden PvP-Angriff. Ohne die
// Marke hier zeigte das Spiel dem Verteidiger eine hoehere Verteidigung an, als im Kampf
// tatsaechlich gerechnet wird - genau der Fehler, den die PvP-Vorschau schon zweimal hatte
// (und derselbe, an dem 'resonanzschild' bis zum 01.08.2026 mit NULL zaehlte).
//
// Die Zahlen stehen bewusst als Zahlen da und nicht abgeleitet: Es gibt keinen gemeinsamen
// Quelltext zwischen den Repos. tests/test_bastionsmarken.js im FRONTEND-Repo vergleicht beide
// Seiten und schlaegt an, sobald eine wandert.
const BASTION_MARK_MAX = 10;
const BASTION_MARK_PER_STEP = 0.03;
// Der Deckel steht hier aus demselben Grund wie in bastionMarkOf(): Ein manipulierter Spielstand
// mit bastionMarks.flak = 900 liefe sonst durch die Kampfrechnung. Der Spielstand ist
// klientenautoritativ - was der Server aus ihm liest, prueft er selbst.
function bastionMarkMultServer(save, buildingKey) {
  const v = ((save && save.bastionMarks) || {})[buildingKey];
  if (typeof v !== 'number' || !isFinite(v)) return 1;
  const mk = Math.max(1, Math.min(BASTION_MARK_MAX, Math.floor(v)));
  return 1 + (mk - 1) * BASTION_MARK_PER_STEP;
}
// Schiffs-Schildpunkte – wie im Frontend (SHIP_DEFS): explizite Werte, sonst round(atk*0.5).
const SHIP_SHIELD_EXPLICIT = { enterschiff: 32, phantomschiff: 5, waechter: 14, quantenkreuzer: 20, metamaterialtitan: 80, superschlachtschiff: 110, kausalitaetsbrecher: 120, paktkorvette: 14, bundeskreuzer: 60, sternenbanner: 100 };
// marks (31.07.2026): +3% Schild je Werftmarke, identisch zum Frontend (defensePower/shieldSum).
/* Schildsumme - Spiegel von shipDefenseContribution() im Frontend. Der entscheidende Unterschied
   zum Stand davor: Schiffe OHNE eigenen Schildwert bekommen keine erfundene Basis mehr. Das
   Frontend gibt ihnen 0 und benutzt (atk*0.5) ausschliesslich als Bezugsgroesse fuer einen
   prozentualen Modulbonus; shipShield() hatte daraus eine echte Basis gemacht und dem Server im
   gemessenen Beispiel das 3,1-fache an Schild beschert.
   Hier stand "shipShield() selbst bleibt unangetastet - es hat weitere Aufrufer". Am 22.08.2026
   nachgemessen (Kommentare vorher GELEERT, Regel 33) war das falsch: genau EINE Fundstelle
   ausserhalb von Kommentaren, und das war die Definition selbst. Die Funktion ist deshalb
   entfernt; SHIP_SHIELD_EXPLICIT bleibt und wird zwanzig Zeilen weiter unten wirklich gelesen. */
function fleetShieldSum(f, marks, save) {
  if (!f) return 0;
  const schild = save ? shipModulKlassenBoni(save, 'shield') : null;
  const df = einsatzbereiteJaeger(f);
  let s = 0;
  for (const k of Object.keys(SHIP_ATK_VALUES)) {
    const count = k === 'jaeger' ? df.jaeger : k === 'bomber' ? df.bomber : (f[k] || 0);
    if (!count) continue;
    const klasse = SHIP_KLASSE_VON[k];
    const sb = schild && klasse ? (schild[klasse] || 0) : 0;   // bewusst UNGEDECKELT, wie im Frontend
    const eigen = SHIP_SHIELD_EXPLICIT[k];
    s += count * (eigen !== undefined ? eigen * (shipMarkShieldMult(marks, k) + sb)
                                      : (SHIP_ATK_VALUES[k] || 0) * sb * 0.5);
  }
  return s;
}
// Doktrin-Multiplikatoren (DOCTRINE_DEFS im Frontend). Neutral, wenn keine Doktrin aktiv.
const DOCTRINE_MULTS = { doc_offensive: { atk: 1.20, def: 0.85 }, doc_defensive: { atk: 0.85, def: 1.20 }, doc_logistics: { atk: 1, def: 1 },
  // Die drei wirtschaftlichen Doktrinen (18.08.2026) sind im Kampf NEUTRAL. Sie stehen hier
  // trotzdem, und zwar aus genau dem Grund, der schon bei doc_logistics steht: damit die Tabelle
  // vollstaendig neben der Frontend-Kopie liegt und beim naechsten Balance-Pass niemand denkt,
  // sie seien vergessen worden. Ihre Wirkung (Produktion, Expeditions-Ausbeute, Abgrundsplitter)
  // rechnet der Server ohnehin nicht nach - keine davon beruehrt einen PvP-Kampf.
  doc_erschliessung: { atk: 1, def: 1 }, doc_aufklaerung: { atk: 1, def: 1 }, doc_bergung: { atk: 1, def: 1 } };
// Doktrin-Synergie (01.08.2026, Frontend: DOCTRINE_DEFS[].syn + doctrineMultOf/doctrineSynActive).
// Greift nur, wenn IRGENDEINE Welt des Spielers die passende Rolle hat - im Frontend hasRoleAnywhere(),
// hier dieselbe Prüfung über save.planetSpecialization. Der Logistik-Zweig hat serverseitig keine
// Wirkung (seine Synergie sind Treibstoff und Lager, die der Server nicht rechnet) und steht hier
// trotzdem, damit die Tabelle vollständig neben der Frontend-Kopie liegt und beim nächsten
// Balance-Pass nicht der Eindruck entsteht, doc_logistics habe gar keine.
const DOCTRINE_SYN = {
  doc_offensive: { rolle: 'shipyard', atk: 1.08, def: 1 },
  doc_defensive: { rolle: 'fortress', atk: 1, def: 1.08 },
  doc_logistics: { rolle: 'trade', atk: 1, def: 1 },
  // Dieselbe Begruendung wie bei DOCTRINE_MULTS: kampfneutral, aber vollstaendig gefuehrt. Die
  // Rollen sind die im Frontend hinterlegten - ein Auseinanderlaufen faellt dem Paritaetstest auf,
  // der seit dem 18.08.2026 JEDE Doktrin aus DOCTRINE_DEFS prueft statt einer festen Dreierliste.
  doc_erschliessung: { rolle: 'mining', atk: 1, def: 1 },
  doc_aufklaerung: { rolle: 'science', atk: 1, def: 1 },
  doc_bergung: { rolle: 'deepport', atk: 1, def: 1 }
};
function hasRoleAnywhereServer(save, roleKey) {
  const spec = (save && save.planetSpecialization) || {};
  for (const k in spec) if (spec[k] === roleKey) return true;
  return false;
}
function doctrineMult(save, side) {
  const d = DOCTRINE_MULTS[save && save.doctrine];
  if (!d) return 1;
  const syn = DOCTRINE_SYN[save.doctrine];
  const synMult = (syn && hasRoleAnywhereServer(save, syn.rolle)) ? (syn[side] || 1) : 1;
  return d[side] * synMult;
}
// Temporäre Buffs (state.buffs) – atk/def-Multiplikatoren, solange nicht abgelaufen. Wie im Frontend.
function buffMult(save, kind) { let m = 1; const now = Date.now(); for (const b of (save && save.buffs) || []) { if (b && b.kind === kind && b.expiresAt > now && typeof b.mult === 'number') m *= b.mult; } return m; }
// Gedeckelte Kampf-Bonus-Gruppen – die serverseitig zuverlässig aus dem Save ableitbaren, GLOBALEN Terme
// aus attackCombatBonusRaw/defenseCombatBonusRaw (Frontend). JE SEITE separat bei +100% gedeckelt
// (identische Logik: 1 + Math.min(1.0, ...)). Angriff und Verteidigung sind bewusst NICHT identisch:
// Piratennest-Prestige wirkt nur auf Angriff, der Admiral voll auf Angriff und nur halb auf Verteidigung.
// Portierte Konstanten identisch zum Frontend (FLAGSHIP_BONUS_PER_LEVEL, VETERAN_TRAINING, SKILL_TREE
// 'war', OFFICER_BONUS_PER_LEVEL/OFFICER_TALENT_LEVEL, Mega-Projekt 'voidreaktor' +10% bis +20%
// je nach Ausbaustufe - Stufenkurve identisch zum Frontend-megaStageFactor).
// Weiterhin NICHT gespiegelt (bräuchten Allianz-Shared-Storage-Lookups bzw. per-Planet-Granularität, die
// die aggregierten compute*-Funktionen nicht haben): Allianz-Kampftechs (a_atk/a_def/…), Allianz-Projekte
// (ap_kriegsrat, ep_verteidigung), Allianzbasis-Verteidigungsbonus, Veteranen-Rang je Planet, Schiffs-
// Module je Planet.
const FLAGSHIP_BONUS_PER_LEVEL = 0.015;
const VETERAN_COMBAT_BONUS = { vet1: 0.02, vet2: 0.02, vet3: 0.03 };
// war4/war5 kamen im Frontend am 01.08.2026 dazu (zweite Baumstufe) und fehlten hier bis zum
// 07.08.2026 - der Server rechnete die Kampfkraft ausgebauter Konten um bis zu 7 Prozentpunkte zu
// niedrig. Die Knoten war6/war7 der dritten Baumstufe sind ABSICHTLICH nicht dabei: sie geben
// Veteranen-XP bzw. Vorwarnzeit, keine Kampfkraft (bonus:0 im Frontend-SKILL_TREE).
// tests/test_faehigkeitsbaum.js im Frontend-Repo prueft diese Liste gegen SKILL_TREE.
const SKILL_WAR_BONUS = { war1: 0.02, war2: 0.02, war3: 0.03, war4: 0.03, war5: 0.04 };
const OFFICER_BONUS_PER_LEVEL = 0.02, OFFICER_TALENT_LEVEL = 5;
function admiralBonus(save) {
  const lvl = (save.officers || {}).admiral || 0;
  const baseLvls = Math.min(lvl, OFFICER_TALENT_LEVEL);
  const extraLvls = Math.max(0, lvl - OFFICER_TALENT_LEVEL);
  const extraRate = OFFICER_BONUS_PER_LEVEL * (((save.officerTalents || {}).admiral) === 'power' ? 1.5 : 1);
  return baseLvls * OFFICER_BONUS_PER_LEVEL + extraLvls * extraRate;
}
// Gemeinsame, seitenunabhängige Terme (in Angriff UND Verteidigung identisch, Frontend attack/defenseCombatBonusRaw).
function combatBonusCommon(save) {
  let b = 0;
  b += ((save.prestigePerks || []).filter(k => k === 'combat').length) * 0.03;
  // Die beiden Perks mit Preis (Fehlerbehebung 01.08.2026): "Schwarmtaktiker" gibt Angriff und
  // kostet Verteidigung, "Sparwerft" macht Schiffe billiger und schwächer. Beide stehen im Frontend
  // in attackCombatBonusRaw UND defenseCombatBonusRaw, beide sind STAPELBAR (prestigePerkCount zählt
  // Vorkommen) - hier fehlten sie komplett. Bei drei Stapeln Schwarmtaktiker rechnete der Server die
  // Angriffskraft um 30 Prozentpunkte niedriger als die Vorschau anzeigte, also das Zehnfache der
  // Abweichung, die der Legion-Bonus daneben verursacht hätte. Gefunden bei der Nachprüfung von
  // v8.372.0; der Fehler ist deutlich älter als dieser Änderungssatz.
  b += ((save.prestigePerks || []).filter(k => k === 'schwarm').length) * 0.10;
  b -= ((save.prestigePerks || []).filter(k => k === 'sparwerft').length) * 0.05;
  b += (((save.flagship && save.flagship.level) || 0)) * FLAGSHIP_BONUS_PER_LEVEL;
  b += (((save.ascension && save.ascension.tree && save.ascension.tree.combat) || 0)) * 0.02;
  const st = save.skillTree || {};
  for (const k in SKILL_WAR_BONUS) if (st[k]) b += SKILL_WAR_BONUS[k];
  // Void-Reaktor MIT Ausbaustufen (Frontend megaStageFactor: Stufe n gibt Faktor 2 - 0.5^(n-1),
  // konvergiert gegen 2 - der Bonus laeuft also von +10% auf bis zu +20%). Hier stand pauschal
  // +0.10, der Server rechnete ausgebaute Reaktoren zu niedrig. Stufenquelle wie im Frontend:
  // megaProjectStages[key], Altstaende ohne Stufenfeld zaehlen als Stufe 1.
  const vrStage = ((save.megaProjectStages || {}).voidreaktor) || ((save.megaProjects && save.megaProjects.voidreaktor) ? 1 : 0);
  if (vrStage > 0) b += 0.10 * (2 - Math.pow(0.5, vrStage - 1));
  const vt = save.veteranTraining || {};
  for (const k in VETERAN_COMBAT_BONUS) if (vt[k]) b += VETERAN_COMBAT_BONUS[k];
  if (save.achievements && save.achievements.artifactset) b += 0.05;
  b += legionAllianceBonus(save);
  return b;
}
// Bündnis mit der Eisenlegion (01.08.2026, Frontend: FACTION_OUTSIDE.legion + factionOutsideBonus()).
// Der einzige der vier neuen "Wirkung außerhalb des Fraktionsreiters"-Effekte, der hier auftaucht -
// die anderen drei (Handelsrouten, Abgrundsplitter, Spionage-Tarnung) rechnet ausschließlich der
// Client. Dieser hier MUSS gespiegelt werden, weil der PvP-Kampf serverseitig entschieden wird und
// eine nur im Frontend addierte Kampfkraft eine Vorschau wäre, die der Kampf nicht einlöst.
// Die Schwellen 30/70 sind dieselben wie in repTierOf()/factionEffectLevel() im Frontend.
const LEGION_ALLY_ATK = { freundlich: 0.03, verbuendet: 0.06 };
function legionAllianceBonus(save) {
  const rep = Math.max(-100, Math.min(100, (save.factionRep && save.factionRep.legion) || 0));
  if (rep >= 70) return LEGION_ALLY_ATK.verbuendet;
  if (rep >= 30) return LEGION_ALLY_ATK.freundlich;
  return 0;
}
// Aufklärungsvorteil (01.08.2026, Frontend: SPY_EDGE_BONUS/spyIntelEdge()). Zielabhängig, deshalb
// NICHT in combatBonusCommon: computeAttackPower() kennt nur den eigenen Spielstand. Er wird in
// resolveAttack auf die rohe Angriffskraft angewandt, an genau der Stelle, an der die Vorschau im
// Spielerprofil ihn auch anwendet. Entdeckte Aufklärung zählt bewusst nicht - der ertappte Späher
// bekommt vom Ziel ohnehin aufgeblähte Verteidigungswerte untergeschoben.
const SPY_EDGE_MS = 30 * 60 * 1000;
const SPY_EDGE_BONUS = 0.08;
function spyIntelEdge(save, targetUserId) {
  const it = (save && save.spyIntel) ? save.spyIntel[targetUserId] : null;
  if (!it || it.detected) return 0;
  if (Date.now() - (it.capturedAt || 0) >= SPY_EDGE_MS) return 0;
  return SPY_EDGE_BONUS;
}
// ===== Allianzforschung (05.08.2026, Frontend: ALLIANCE_RESEARCH_DEFS/allianzForschungFrac) =====
//
// Diese fünf Zweige werden vom Spieler SELBST erforscht und liegen deshalb - anders als die
// Allianz-Techs (a_atk/a_def/…), die aus geteilten Beiträgen entstehen - direkt in save.research.
// Sie brauchen keinen Shared-Storage-Lookup und sind hier deshalb spiegelbar, während der Kommentar
// über combatBonusCommon für die alten Allianz-Techs unverändert gilt.
//
// Die Wirkung hängt an der MITGLIEDSCHAFT, nicht nur an der Stufe: Wer die Allianz verlässt, behält
// die erforschten Stufen, aber nicht ihren Nutzen. Genauso rechnet das Frontend.
const ALLIANZ_FORSCHUNG_MAX = 10;
const ALLIANZ_FORSCHUNG_ATK = { ra_verbund: 0.08, ra_sternenschmiede: 0.12 };
const ALLIANZ_FORSCHUNG_DEF = { ra_schildnetz: 0.12 };
function allianzForschungBonus(save, tabelle) {
  const tag = ((save.player && save.player.allianceTag) || '').trim();
  if (!tag) return 0;
  let b = 0;
  for (const [key, voll] of Object.entries(tabelle)) {
    const lvl = Math.max(0, Math.min(ALLIANZ_FORSCHUNG_MAX, ((save.research || {})[key]) || 0));
    b += voll * (lvl / ALLIANZ_FORSCHUNG_MAX);
  }
  return b;
}
// WEICHER DECKEL - MUSS ZEICHENGLEICH ZUM FRONTEND BLEIBEN (weltraum_kolonie.html,
// `function weicherDeckel`). Seit v8.468.0 laufen dort die Nicht-PvP-Töpfe darüber; die
// PvP-Töpfe (Angriff, Verteidigung, Schiffsmodul-Angriff, Überfall-Schutz) blieben bewusst hart,
// WEIL dieser Server sie mitrechnet und eine einseitige Umstellung Client und Server im Kampf
// verschieden rechnen ließe. Mit dieser Änderung wechseln beide Seiten gemeinsam.
//
// Wer die Formel hier ODER dort anfasst, muss die andere Seite mitziehen - tests/test_pvp_deckel.js
// im Frontend zieht BEIDE Fassungen aus den Dateien und vergleicht sie über einen Wertebereich,
// schlägt also an, sobald sie auseinanderlaufen.
const UEBERLAUF_ANTEIL = 0.25;
function weicherDeckel(roh, deckel, spielraum) {
  const r = Math.max(0, roh || 0);
  if (!(deckel > 0)) return r;
  if (r <= deckel) return r;
  const sp = (spielraum === undefined) ? deckel * UEBERLAUF_ANTEIL : spielraum;
  if (!(sp > 0)) return deckel;
  return deckel + sp * (1 - Math.exp(-(r - deckel) / sp));
}
// AUSBAUBARER DECKEL (Schritt 2) - MUSS zeichengleich zum Frontend bleiben (dort ascBonus() und
// deckelAusbauFn). Der Aufstiegs-Zweig 'grenzen' hebt jede Bonus-Obergrenze an; da der Server die
// PvP-Toepfe mitrechnet, MUSS er denselben Faktor kennen - sonst gilt die verschobene Grenze nur
// in der Anzeige und nicht im Kampf.
//
// Der Faktor steht bewusst an den AUFRUFSTELLEN und nicht in weicherDeckel: Die Paritaetspruefung
// vergleicht genau diese Funktion. Steckte der Ausbau darin und auf der anderen Seite nicht, waeren
// beide ohne Aufstieg identisch und mit Aufstieg verschieden - eine Abweichung, die der Test nicht
// faende.
const ASCENSION_SOFT_CAP = 10;
const ASCENSION_LATE_RATE = 0.2;
const DECKEL_AUSBAU_PRO_STUFE = 0.03;
function ascBonusServer(save, key) {
  const lvl = ((save && save.ascension && save.ascension.tree) || {})[key] || 0;
  return lvl <= ASCENSION_SOFT_CAP ? lvl
       : ASCENSION_SOFT_CAP + (lvl - ASCENSION_SOFT_CAP) * ASCENSION_LATE_RATE;
}
function deckelAusbauServer(save) { return 1 + DECKEL_AUSBAU_PRO_STUFE * ascBonusServer(save, 'grenzen'); }
function attackBonusGroup(save) {
  let b = combatBonusCommon(save);
  b += Math.min(5, save.pirateLairPrestige || 0) * 0.02; // Piratennest-Prestige: NUR Angriff
  b += admiralBonus(save);                               // Admiral: voll auf Angriff
  b += allianzForschungBonus(save, ALLIANZ_FORSCHUNG_ATK);
  return weicherDeckel(b, 1.0 * deckelAusbauServer(save));
}
function defenseBonusGroup(save) {
  let b = combatBonusCommon(save);
  b += admiralBonus(save) * 0.5; // Admiral: halbe Rate auf Verteidigung
  b += allianzForschungBonus(save, ALLIANZ_FORSCHUNG_DEF);
  return weicherDeckel(b, 1.0 * deckelAusbauServer(save));
}
// Muss exakt synchron zu SHIP_SCORE_WEIGHTS im Frontend bleiben (dort die eigentliche Quelle für
// computeScore()) - bei Änderungen dort immer auch hier nachpflegen, sonst weicht der serverseitig
// validierte Score vom eigentlich beabsichtigten Wert ab.
// 19.07.2026 synchronisiert zu Frontend v8.121.0: es fehlten 7 neuere Schiffstypen (Leerenjäger +
// die 5 Event-Schiffe + Spionagekreuzer-Nachzügler) - deren Besitzer bekamen serverseitig zu
// NIEDRIGE Scores validiert (exakt der CLAUDE.md-Fallstrick "Backend-Kopie mitpflegen"). Dazu die
// drei neuen Tier-2-Schiffe (nanoklinge/quantenkreuzer/fusionsdreadnought).
const SHIP_SCORE_WEIGHTS = {
  ships:15, cruisers:25, jaeger:12, destroyers:35, bomber:45,
  schlachtschiff:70, carrier:30, superschlachtschiff:180, waechter:20,
  leerenjaeger:120, kometenjaeger:18, enterschiff:28, phantomschiff:26, riftwaechter:22, gesandtenschiff:15, schuerfschiff:15,
  nanoklinge:45, quantenkreuzer:65, fusionsdreadnought:150, hyperjaeger:30, hyperbomber:110,
  // Apex-Schiffe (23.07.2026): Metamaterial-Titan + Singularitäts-Vernichter fehlten bisher komplett
  // (Score-Untervalidierung ihrer Besitzer, exakt der CLAUDE.md-Fallstrick). Gewichte identisch zur
  // Frontend-Kopie SHIP_SCORE_WEIGHTS (weltraum_kolonie.html).
  metamaterialtitan:135, singularitaetsvernichter:200,
  // Kausalitätsbrecher (16.08.2026): das Tier-3-Apex-Schiff. Ohne diese Zeile bewertet der
  // Server den Score seiner Besitzer zu niedrig - derselbe Fallstrick wie bei den beiden
  // Apex-Schiffen darüber, und in CLAUDE.md ausdrücklich als wiederkehrend vermerkt.
  // Gewicht identisch zur Frontend-Kopie (weltraum_kolonie.html).
  kausalitaetsbrecher:260,
  forscher:20, frachter:10, frachtergross:40, bergungsfrachter:80, spaeher:15, spionageschiff:22, colonyShips:5, recycler:12,
  // Bugfix (20.07.2026, Bug-Sweep): mondzerstoerer fehlte komplett - maxOwned:1, 10 Tage Bauzeit,
  // Top-Tier-Forschung nötig, atk 300 (höchster Wert im Spiel), Gewicht identisch zur Frontend-Kopie
  // (weltraum_kolonie.html SHIP_SCORE_WEIGHTS) synchron gehalten.
  mondzerstoerer:250,
  // Allianzflotte (05.08.2026) - Gewichte identisch zur Frontend-Kopie SHIP_SCORE_WEIGHTS.
  paktkorvette:42, bundeskreuzer:105, sternenbanner:195,
  // Urmaterie-Koloss (21.08.2026, Etappe D): der erste wiederkehrende Protomaterie-Abnehmer.
  // Ohne diese Zeile bewertet der Server den Score seiner Besitzer zu niedrig - derselbe
  // Fallstrick wie bei den drei Apex-Schiffen darueber, und in beiden CLAUDE.md ausdruecklich
  // als WIEDERKEHREND vermerkt. Gewicht identisch zur Frontend-Kopie (weltraum_kolonie.html).
  urmateriekoloss:175
};
// Bug/Sicherheitslücke behoben (13.07.2026, danke an Sascha für den Hinweis): der Bestenlisten-Score
// wurde bisher komplett clientseitig berechnet und ungeprüft übernommen - jeder hätte sich per
// Browser-Entwicklertools einen beliebigen Score eintragen und sich damit auch die wöchentliche
// Liga-Einstufung (samt echter Belohnung) erschummeln können. Rechnet jetzt exakt dieselbe Formel wie
// computeScore() im Frontend nach, aber aus dem tatsächlichen gespeicherten Spielstand.
// 50 Punkte je Rekordtiefe im Abgrund - identisch zu ABGRUND_SCORE_JE_TIEFE im Frontend.
const ABGRUND_SCORE_JE_TIEFE = 50;
function computeScoreServer(save) {
  const buildLvl = allBuildingsOf(save).reduce((sum, b) => sum + Object.values(b).reduce((a, v) => a + (Number(v) || 0), 0), 0);
  // Werftmarken (31.07.2026): Ein Mk X-Jaeger zaehlt +27% - derselbe Faktor, den auch rawFleetPower()
  // auf die Angriffskraft legt (shipMarkAtkMult). Ohne ihn wuerde der Server jedem Spieler mit
  // aufgeruesteter Flotte einen zu NIEDRIGEN Score validieren und den eingereichten ueberschreiben:
  // exakt der CLAUDE.md-Fallstrick "Backend-Kopie mitpflegen", der hier schon zweimal zugeschlagen hat.
  const marks = save.shipMarks;
  let shipScore = 0;
  // Schiffe unterwegs zaehlen mit (01.08.2026) - siehe awayShipTotalsServer(). Bewusst als eigener
  // Eintrag in derselben Schleifenquelle statt als zweite Summenzeile: So kann keine kuenftige
  // Aenderung an der Gewichtung die eine Haelfte treffen und die andere vergessen.
  for (const f of allFleetsOf(save).concat([awayShipTotalsServer(save)])) for (const [key, weight] of Object.entries(SHIP_SCORE_WEIGHTS)) shipScore += (f[key] || 0) * weight * shipMarkAtkMult(marks, key);
  const researchScore = Object.values(save.research || {}).reduce((a, lvl) => a + (Number(lvl) || 0), 0) * 8;
  const colonyKeys = Object.keys(save.colonies || {});
  const moonCount = colonyKeys.filter(k => typeof k === 'string' && k.indexOf('moon_') === 0).length;
  const colonyCount = colonyKeys.length - moonCount;
  const expansionScore = colonyCount * 200 + moonCount * 150;
  // Rekordtiefe im Abgrund. FEHLTE HIER SEIT v8.343.0: Das Frontend vergibt 50 Punkte je Tiefe, der
  // Server kannte den Abgrund gar nicht und hat den eingereichten Score entsprechend nach unten
  // korrigiert - wer Tiefe 60 erreicht hatte, verlor in der Bestenliste stillschweigend 3.000 Punkte.
  // Aufgefallen beim Nachziehen der Werftmarken in genau dieser Funktion.
  const abgrundScore = Number((save.abgrund && save.abgrund.best) || 0) * ABGRUND_SCORE_JE_TIEFE;
  return Math.floor(buildLvl * 10 + shipScore + researchScore + expansionScore + abgrundScore + (save.battlePoints || 0) * 3 + (save.prestige || 0) * 500 + ((save.ascension && save.ascension.count) || 0) * 5000);
}

// Schiffs-Kontersystem (Schere-Stein-Papier) – identisch zum Frontend. Bei echtem PvP sind BEIDE
// Flottenzusammensetzungen bekannt (anders als bei NPC-Kämpfen), wirkt hier also immer.
// Konterrollen (25.07.2026) – MUSS zeichengleich zum Frontend bleiben (weltraum_kolonie.html,
// COUNTER_ROLE_DEFS/COUNTER_ROLE_OF). Weicht eine Seite ab, rechnet der Server einen anderen
// Kampfausgang aus als die Vorschau im Spiel anzeigt – der Spieler sieht dann eine Gewinnchance,
// die nicht stimmt. test_konter_paritaet.js vergleicht beide Tabellen automatisch.
// Vorher hatten nur vier Schiffe eine Konterrolle; alle Tier-2- und Event-Schiffe waren
// konterneutral, ausgerechnet die teuerste Flotte also nicht konterbar.
const COUNTER_ROLE_DEFS = [
  { key: 'abfang', name: 'Abfangjäger', schlaegt: 'bomber' },
  { key: 'bomber', name: 'Bomber', schlaegt: 'kapital' },
  { key: 'kapital', name: 'Großkampfschiff', schlaegt: 'abfang' }
];
const COUNTER_ROLE_OF = {
  jaeger: 'abfang', hyperjaeger: 'abfang', kometenjaeger: 'abfang', phantomschiff: 'abfang', leerenjaeger: 'abfang',
  bomber: 'bomber', hyperbomber: 'bomber', nanoklinge: 'bomber', singularitaetsvernichter: 'bomber', mondzerstoerer: 'bomber',
  cruisers: 'kapital', destroyers: 'kapital', schlachtschiff: 'kapital', superschlachtschiff: 'kapital',
  waechter: 'kapital', quantenkreuzer: 'kapital', fusionsdreadnought: 'kapital', metamaterialtitan: 'kapital',
  // Urmaterie-Koloss (21.08.2026, Etappe D): KAPITAL - breiter, langsamer Belagerungsrumpf mit
  // Frachtraum, kein Praezisionsangreifer. Die Rolle entscheidet hier nicht nur das Konter-
  // verhaeltnis, sondern ueber shipMarkShieldPerStep auch den Werftmarken-Schildzuwachs
  // (kapital 0,04 statt 0,03). Genau daran hat tests/test_werftmarken.js im Frontend die Luecke
  // gefunden: Frontend 1,04 gegen Backend 1,03 bei Mk 2 - der Server haette den Schild jedes
  // Koloss-Besitzers zu niedrig gerechnet.
  urmateriekoloss: 'kapital',
  // Umwidmung 02.08.2026 (Frontend: COUNTER_ROLE_OF, dort steht die ausfuehrliche Begruendung).
  // Kurz: Die Verteilung war 5/5/11, und die elf Grosskampfschiffe waren ausgerechnet die spaeten
  // Klassen - im Endspiel fiel Schere-Stein-Papier damit auf "Stein gegen Stein" zusammen. Carrier
  // (Traeger, bringt Jaeger ins Gefecht) und Riftwaechter (leichter, schneller Rumpf) sind jetzt
  // Abfangjaeger, das Enterschiff (greift grosse, traege Ziele an) ein Bomber. Neu: 7/6/8.
  //
  // ACHTUNG: Diese Tabelle bestimmt im Frontend AUCH die Werftmarken-Familie (shipMarkFamily liest
  // sie als Erstes) und damit die Zuwaechse je Marke - shipMarkAtkPerStep/shipMarkShieldPerStep hier
  // haengen an derselben Rolle. Ein Rollenwechsel muss deshalb immer auf beiden Seiten passieren.
  carrier: 'abfang', riftwaechter: 'abfang', enterschiff: 'bomber',
  // Allianzflotte (05.08.2026): bewusst auf alle drei Rollen verteilt statt geschlossen ins
  // Kapital-Lager - sonst waere die muehsam auf 7/6/8 gebrachte Verteilung sofort wieder schief.
  paktkorvette: 'abfang', bundeskreuzer: 'kapital', sternenbanner: 'bomber'
};
const SHIP_COUNTERS = (() => {
  const byRole = {}; for (const r of COUNTER_ROLE_DEFS) byRole[r.key] = [];
  for (const [ship, role] of Object.entries(COUNTER_ROLE_OF)) if (byRole[role]) byRole[role].push(ship);
  const beatsOf = {}; for (const r of COUNTER_ROLE_DEFS) beatsOf[r.key] = r.schlaegt;
  const out = {};
  for (const [ship, role] of Object.entries(COUNTER_ROLE_OF)) {
    const beatenBy = COUNTER_ROLE_DEFS.filter(r => r.schlaegt === role).map(r => r.key);
    out[ship] = {
      strongVs: byRole[beatsOf[role]] || [],
      weakVs: beatenBy.reduce((acc, r) => acc.concat(byRole[r] || []), [])
    };
  }
  return out;
})();
// ===== Kampfphasen (25.07.2026) - identisch zum Frontend (BATTLE_PHASES/resolveBattlePhases) =====
// Statt eines einzelnen Wurfs drei Phasen mit unterschiedlicher Kontergewichtung; wer zwei davon
// gewinnt, gewinnt den Kampf.
const BATTLE_PHASES = [
  { key: 'anflug', name: 'Anflug', konterGewicht: 1.5 },
  { key: 'haupt', name: 'Hauptgefecht', konterGewicht: 1.0 },
  { key: 'rueckzug', name: 'Rückzug', konterGewicht: 0.5 }
];
// "Zwei von drei" verschärft die Wahrscheinlichkeit: p_gesamt = 3p²(1-p) + p³. Damit der Kampf
// INSGESAMT denselben Spielraum behält wie vorher, müssen die Phasen-Deckel zurückgerechnet werden.
// PvP lief bisher mit [0,10 … 0,90]; das ergibt je Phase [0,196 … 0,804]:
//   p=0,196 -> 3·0,0384·0,804 + 0,00753 = 0,100
//   p=0,804 -> 3·0,6464·0,196 + 0,5197  = 0,900
// Das Frontend nutzt für NPC-Kämpfe andere Grenzen ([0,05 … 0,95] -> [0,14 … 0,86]), deshalb sind
// die Deckel Parameter und keine Konstanten. Wer daran dreht, muss neu zurückrechnen.
const PVP_PHASE_MIN = 0.196, PVP_PHASE_MAX = 0.804;
/* ===== Gefechtsvorraete (18.08.2026, Etappe B1) - KOPIE aus dem Frontend =====
   Dieselbe Kopie-Familie wie SHIP_SCORE_WEIGHTS/computeScoreServer und DEFENSE_VALUES: Wer die
   Frontend-Tabelle GEFECHTSVORRAETE aendert, aendert diese mit. tests/test_gefechtsvorrat_http.js
   im Backend und tests/test_gefechtsvorrat.js im Frontend vergleichen beide Seiten Wert fuer Wert.

   WARUM DER SERVER DAS UEBERHAUPT RECHNET: Ein Vorrat veraendert den Ausgang eines Kampfes gegen
   einen ECHTEN Spieler - er faellt damit auf die Seite der Grenze, die dieses Projekt verteidigt
   ("kann ich etwas anfassen, das anderen gehoert?"). Der Client darf ihn deshalb weder melden noch
   selbst abbuchen; /api/attack nimmt bewusst keinen einzigen Kampfparameter entgegen. Der Server
   liest die WAHL aus dem Spielstand, prueft den Bestand, wendet den Bonus an und bucht im selben
   synchronen Block ab, bevor er speichert. */
const GEFECHTSVORRAETE = [
  { key: 'gefechtskoepfe', name: 'Nano-Gefechtsköpfe', seite: 'angriff', res: 'nanolegierungen', menge: 40, bonus: 0.08 },
  { key: 'schildkondensatoren', name: 'Schildkondensatoren', seite: 'verteidigung', res: 'hochenergiekristalle', menge: 25, bonus: 0.08 }
];
/* Setzt die eingeschalteten Vorraete einer Seite ein und MUTIERT dabei save.resources. Der Aufrufer
   muss den Spielstand danach speichern - beide /api/attack-Ausgaenge tun das ohnehin fuer Beute und
   Verluste. Rueckgabe: der Multiplikator und die Liste fuer den Kampfbericht. */
function gefechtsvorratEinsetzenServer(save, seite) {
  const gewaehlt = (save && save.gefechtsvorrat) || {};
  const res = (save && save.resources) || {};
  const eingesetzt = [];
  let summe = 0;
  for (const v of GEFECHTSVORRAETE) {
    if (v.seite !== seite || !gewaehlt[v.key]) continue;
    if (!(Number(res[v.res]) >= v.menge)) continue;   // deckt auch undefined/NaN ab
    res[v.res] = Number(res[v.res]) - v.menge;
    summe += v.bonus;
    eingesetzt.push({ key: v.key, name: v.name, res: v.res, menge: v.menge, bonus: v.bonus });
  }
  return { mult: 1 + summe, eingesetzt };
}
function resolveBattlePhases(basePower, defense, counterMult, minC, maxC, rng) {
  const wurf = rng || Math.random;
  const mult = (typeof counterMult === 'number' && counterMult > 0) ? counterMult : 1;
  const phasen = [];
  let siege = 0;
  for (const ph of BATTLE_PHASES) {
    const p = Math.max(0, basePower * (1 + (mult - 1) * ph.konterGewicht));
    const roh = (p + defense) > 0 ? p / (p + defense) : 0;
    const chance = Math.max(minC, Math.min(maxC, roh));
    const gewonnen = wurf() < chance;
    if (gewonnen) siege++;
    phasen.push({ key: ph.key, name: ph.name, chance, gewonnen, power: Math.round(p) });
  }
  return { success: siege >= 2, siege, phasen };
}
function battleWinChance(basePower, defense, counterMult, minC, maxC) {
  const mult = (typeof counterMult === 'number' && counterMult > 0) ? counterMult : 1;
  const ps = BATTLE_PHASES.map(ph => {
    const p = Math.max(0, basePower * (1 + (mult - 1) * ph.konterGewicht));
    const roh = (p + defense) > 0 ? p / (p + defense) : 0;
    return Math.max(minC, Math.min(maxC, roh));
  });
  const [a, b, c] = ps;
  return a * b * (1 - c) + a * (1 - b) * c + (1 - a) * b * c + a * b * c;
}

// ===== Verteidigungs-Aufstellung (25.07.2026) - identisch zum Frontend (DEFENSE_FORMATIONS) =====
// Der Verteidiger legt sich vorab fest, gegen welche Art Angriffsflotte er gerüstet sein will.
// MUSS serverseitig gelesen werden, sonst hätte die Wahl im PvP - dem einzigen Kampf, in dem ein
// echter Gegner die Zusammensetzung wählt - überhaupt keine Wirkung.
const DEFENSE_FORMATIONS = {
  ausgewogen: { stark: null, schwach: null },
  schilde: { stark: 'bomber', schwach: 'abfang' },
  geschuetze: { stark: 'abfang', schwach: 'bomber' }
};
const FORMATION_BONUS = 0.15, FORMATION_MALUS = 0.10;
function formationDefenseMult(attackerFleet, formationKey) {
  const f = DEFENSE_FORMATIONS[formationKey || 'ausgewogen'];
  if (!f || !f.stark || !attackerFleet) return 1;
  let total = 0; const perRole = {};
  for (const [k, atk] of Object.entries(COUNTER_ROLE_ATK)) {
    const rolle = COUNTER_ROLE_OF[k]; if (!rolle) continue;
    const n = attackerFleet[k] || 0; if (!(n > 0)) continue;
    const g = n * (atk || 1);
    perRole[rolle] = (perRole[rolle] || 0) + g; total += g;
  }
  if (total <= 0) return 1;
  return 1 + ((perRole[f.stark] || 0) / total) * FORMATION_BONUS - ((perRole[f.schwach] || 0) / total) * FORMATION_MALUS;
}
const COUNTER_BONUS = 0.25, COUNTER_MALUS = 0.15;
function counterMultiplier(ownFleet, enemyFleet) {
  if (!ownFleet || !enemyFleet) return 1;
  const enemyTotal = Object.values(enemyFleet).reduce((a, b) => a + (typeof b === 'number' && b > 0 ? b : 0), 0);
  if (!enemyTotal) return 1;
  let weightedMult = 0, ownTotal = 0;
  for (const [k, v] of Object.entries(ownFleet)) {
    if (!(typeof v === 'number' && v > 0)) continue;
    const rule = SHIP_COUNTERS[k];
    let mult = 1;
    if (rule) {
      const strongShare = rule.strongVs.reduce((a, t) => a + (enemyFleet[t] || 0), 0) / enemyTotal;
      const weakShare = rule.weakVs.reduce((a, t) => a + (enemyFleet[t] || 0), 0) / enemyTotal;
      mult = 1 + strongShare * COUNTER_BONUS - weakShare * COUNTER_MALUS;
    }
    weightedMult += mult * v;
    ownTotal += v;
  }
  return ownTotal > 0 ? weightedMult / ownTotal : 1;
}

// Abnehmender Grenznutzen bei Mega-Einzelflotten – identisch zum Frontend.
const MEGA_FLEET_THRESHOLD = 300, MEGA_FLEET_DIMINISH_RATE = 0.5;
function diminishingShipCount(count) {
  if (count <= MEGA_FLEET_THRESHOLD) return count;
  return MEGA_FLEET_THRESHOLD + (count - MEGA_FLEET_THRESHOLD) * MEGA_FLEET_DIMINISH_RATE;
}

// Taktik-Haltung – identisch zum Frontend.
const COMBAT_STANCES = { aggressiv: { atkMult: 1.10, defMult: 0.90 }, ausgewogen: { atkMult: 1.00, defMult: 1.00 }, defensiv: { atkMult: 0.90, defMult: 1.15 } };
function stanceOf(save) { return COMBAT_STANCES[save.combatStance || 'ausgewogen'] || COMBAT_STANCES.ausgewogen; }

const HOME_DEFENSE_BONUS = 1.20;

function allFleetsOf(save) {
  const list = [save.fleet].filter(Boolean);
  for (const c of Object.values(save.colonies || {})) if (c && c.fleet) list.push(c.fleet);
  return list;
}
// Schiffe, die gerade NICHT an einem Standort stehen (01.08.2026). Spiegelung von
// awayShipTotalsForScore() im Frontend - dort steht der Kommentar, dass der Punktestand sonst
// "scheinbar grundlos um zehntausende Punkte" faellt.
//
// Warum das zaehlt: allFleetsOf() kennt nur save.fleet plus die Koloniefloten. Wer Schiffe verlegt,
// sie an die Allianzbasis schickt oder einem Musterangriff beitritt, dessen Schiffe sind aus dieser
// Sicht verschwunden. Da der Server den eingereichten Punktestand BEDINGUNGSLOS ueberschreibt
// (`submitted.score = correctScore;`), war das kein reiner Anzeigefehler: Der Spieler verlor die
// Punkte in der Bestenliste real, solange seine Flotte unterwegs war, und bekam sie erst bei
// Rueckkehr wieder. Genau dagegen zaehlt das Frontend sie mit - der Server tat es nicht.
function awayShipTotalsServer(save) {
  const away = {};
  const add = (k, v) => { if (typeof v === 'number' && v > 0) away[k] = (away[k] || 0) + v; };
  for (const fleet of allFleetsOf(save)) {
    for (const m of (fleet.missions || [])) {
      if (!m) continue;
      if (m.type === 'relocate') add(m.shipKey, m.qty);
      else if (m.type === 'defend-base' || m.type === 'defend-base-return' || m.type === 'attack-alliance-base') {
        for (const [k, v] of Object.entries(m.composition || {})) add(k, v);
      }
    }
  }
  for (const [k, v] of Object.entries(save.shipsAtAllianceBase || {})) add(k, v);
  const contrib = save.allianceMusterContribution;
  if (contrib && contrib.composition) for (const [k, v] of Object.entries(contrib.composition)) add(k, v);
  return away;
}
function allBuildingsOf(save) {
  const list = [save.buildings].filter(Boolean);
  for (const c of Object.values(save.colonies || {})) if (c && c.buildings) list.push(c.buildings);
  return list;
}
// Plausibilitäts-Grenzwerte für den privaten Spielstand (20.07.2026, Security-Audit-Fund: PUT
// /api/storage/kepler7-save-v3 speicherte den kompletten Save bisher ungeprüft, nur die
// Versionsnummer wurde abgeglichen - jede Stelle, die laut Architektur-Doku "serverseitig aus dem
// gespeicherten Spielstand neu berechnet" (Kampfkraft, Bestenlisten-Score, Weltboss-Beitrag), rechnete
// also in Wahrheit mit frei erfundenen Werten weiter, z.B. fleet.jaeger:999999). Bewusst GROSSZÜGIGE,
// pauschale Grenzwerte statt einer vollen Nachbildung der Spiellogik (Baukosten/Produktionsraten) - das
// wäre ein zweiter Spiel-Client auf dem Server und ein Wartungsalbtraum bei jeder künftigen
// Mechanik-Änderung. Reales Maximum bei Gebäuden/Forschung liegt bei Stufe 20 (paar Ausnahmen
// niedriger) - 60 lässt reichlich Luft für künftige Erweiterungen, ohne offensichtlichen Unsinn
// durchzulassen.
// Plausibilitäts-Obergrenzen (Anti-Cheat gegen injizierte Absurd-Werte). WICHTIG (Spieler-Report
// 21.07.2026): Diese Grenzen dürfen legitimes, langjähriges Spiel NIE blockieren - ein einziger
// überschrittener Wert lässt den GESAMTEN Spielstand serverseitig ablehnen (HTTP 400), was faktisch
// kompletten Speicherverlust bedeutet (jeder Reload lädt den letzten akzeptierten Stand -> "immer 8h
// offline"). Die alten Grenzen (Gebäude/Forschung Stufe 60, Kredite 1e8) wurden von entwickelten
// Konten real überschritten und froren deren Speichern ein. Jetzt klar oberhalb jedes realistischen
// Spielfortschritts angesetzt - sie fangen weiterhin offensichtlich gefälschte Werte ab, sperren aber
// keine echten Spieler mehr aus.
const SAVE_SANITY_LIMITS = {
  maxBuildingLevel: 10000,
  maxResearchLevel: 10000,
  maxShipsPerType: 1e9,
  maxResourceValue: 1e15,
  maxCredits: 1e12,
  maxPrestige: 100000,
  maxXp: 1e14,
  // Werftmarken (31.07.2026): Das Frontend deckelt bei 10 (SHIP_MARK_MAX) und schreibt nie mehr.
  // Hier steht trotzdem 1000 und nicht 10 - nach demselben Grundsatz wie die Werte darueber: Ein
  // zu enges Limit sperrt im Zweifel einen echten Spieler komplett vom Speichern aus, ein
  // grosszuegiges faengt offensichtliche Faelschungen trotzdem ab. Sollte der Deckel im Spiel
  // jemals ueber 1000 steigen, muss dieser Wert VORHER mitwachsen.
  maxShipMark: 1000,
  // Bastionsmarken (18.08.2026): dieselbe Groessenordnung und dieselbe Begruendung wie die
  // Werftmarke darueber. Das Frontend deckelt bei 10 (BASTION_MARK_MAX) und schreibt nie mehr;
  // 1000 faengt offensichtliche Faelschungen ab, ohne einen echten Spieler vom Speichern
  // auszusperren. Steigt BASTION_MARK_MAX je ueber 1000, muss dieser Wert VORHER mitwachsen.
  maxBastionMark: 1000
};
function numberOutOfRange(v, max) {
  return typeof v === 'number' && (!Number.isFinite(v) || v < 0 || v > max);
}
function saveSanityViolation(save) {
  if (!save || typeof save !== 'object') return null;
  for (const b of allBuildingsOf(save)) {
    for (const [k, v] of Object.entries(b || {})) {
      if (numberOutOfRange(v, SAVE_SANITY_LIMITS.maxBuildingLevel)) return 'Gebäudestufe "' + k + '" unplausibel: ' + v;
    }
  }
  for (const [k, v] of Object.entries(save.research || {})) {
    if (numberOutOfRange(v, SAVE_SANITY_LIMITS.maxResearchLevel)) return 'Forschungsstufe "' + k + '" unplausibel: ' + v;
  }
  for (const f of allFleetsOf(save)) {
    for (const [k, v] of Object.entries(f || {})) {
      if (numberOutOfRange(v, SAVE_SANITY_LIMITS.maxShipsPerType)) return 'Schiffszahl "' + k + '" unplausibel: ' + v;
    }
  }
  for (const [k, v] of Object.entries(save.resources || {})) {
    if (numberOutOfRange(v, SAVE_SANITY_LIMITS.maxResourceValue)) return 'Ressource "' + k + '" unplausibel: ' + v;
  }
  if (numberOutOfRange(save.credits, SAVE_SANITY_LIMITS.maxCredits)) return 'Kredite unplausibel: ' + save.credits;
  if (numberOutOfRange(save.prestige, SAVE_SANITY_LIMITS.maxPrestige)) return 'Prestige unplausibel: ' + save.prestige;
  if (numberOutOfRange(save.xp, SAVE_SANITY_LIMITS.maxXp)) return 'XP unplausibel: ' + save.xp;
  for (const [k, v] of Object.entries(save.shipMarks || {})) {
    if (numberOutOfRange(v, SAVE_SANITY_LIMITS.maxShipMark)) return 'Werftmarke "' + k + '" unplausibel: ' + v;
  }
  /* Bastionsmarken - Verteidigung in der Tiefe, genau wie eine Zeile darueber. Sie ist NICHT
     der Schutz der Kampfrechnung (den macht bastionMarkMultServer mit seinem eigenen Deckel),
     sondern verhindert, dass ein absurder Wert ueberhaupt im Spielstand liegen bleibt. Ohne
     diese Schleife waere bastionMarks das einzige Markenfeld ohne Pruefung - und eine
     Ungleichbehandlung, die niemand begruendet hat, ist die Sorte Luecke, die spaeter jemand
     fuer Absicht haelt. */
  for (const [k, v] of Object.entries(save.bastionMarks || {})) {
    if (numberOutOfRange(v, SAVE_SANITY_LIMITS.maxBastionMark)) return 'Bastionsmarke "' + k + '" unplausibel: ' + v;
  }
  return null;
}
// Rohe Flottenkraft EINES Flottenobjekts, mit Grenznutzen-Deckel, aber OHNE Taktik-Haltung/Konter –
// wird für den Verteidigungsbeitrag der eigenen Flotte gebraucht (analog Frontend attackPowerRaw),
// damit Taktik-Haltung dort nicht doppelt bzw. falsch (Angriffs- statt Verteidigungsmultiplikator)
// einfließt.
// ssAtkMult/t2AtkMult (24.07.2026, Modul-Verdrahtung): Klassen-Angriffsmodule des Angreifers
// (Zielcomputer auf Schlachtschiffe, Singularitäts-Fokusarray auf die Tier-2-Klasse) - werden nur
// von computeAttackPower() mit echten Werten befüllt (aus save.equippedShipModules), alle anderen
// Aufrufer (Verteidigungsbeitrag, Raid-/Muster-Kompositionen) bleiben neutral bei 1.
// Werftmarken (31.07.2026, Frontend v8.350.0): Jede Schiffsklasse hat zehn Ausbaustufen. Der Wert
// steht als save.shipMarks[schluessel] im Spielstand, genau wie equippedShipModules - der Server
// liest ihn und rechnet ihn selbst nach.
//
// SEIT 01.08.2026 HAENGT DER ZUWACHS AN DER SCHIFFSFAMILIE (Frontend v8.370.0). Fuer den Server
// sind nur atk und shield relevant - Tempo, Treibstoff und Bauzeit rechnet er nie nach. Von den
// sechs Familien des Frontends weichen bei diesen beiden Feldern GENAU ZWEI vom Vorgabewert 0.03
// ab: der Bomber beim Angriff und das Grosskampfschiff beim Schild. Beide kennt der Server ueber
// sein eigenes COUNTER_ROLE_OF (weiter oben, gespiegelt gegen das Frontend).
// Alle uebrigen Familien - Tiefe, Spaeher, Zivil und der Abfangjaeger - liegen bei atk/shield
// unveraendert auf 0.03 und werden hier vom Fallback korrekt bedient. Deshalb braucht der Server
// KEINE eigene Familientabelle; kaeme eine dazu, waere sie sofort die zweite Liste, die veraltet.
//
// Ohne diesen Spiegel wuerde die Frontend-Vorschau mehr Angriffskraft anzeigen, als der Server im
// PvP tatsaechlich rechnet: attackPowerRaw() im Frontend und rawFleetPower() hier MUESSEN dieselbe
// Zahl liefern. Genau diese Sorte Abweichung ist im Projekt schon mehrfach als Bug aufgeschlagen
// (siehe die Kommentare zum Bug-Sweep 20.07.2026 weiter unten).
const SHIP_MARK_MAX = 10;
const SHIP_MARK_ATK_PER_STEP = 0.03;
const SHIP_MARK_SHIELD_PER_STEP = 0.03;
// Abweichungen vom Vorgabewert, nach Konterrolle. Wer hier etwas aendert, MUSS
// SHIP_MARK_PER_STEP_FAMILIE im Frontend mitziehen - tests/test_werftmarken.js prueft beide Seiten
// gegeneinander und schlaegt sonst an.
const SHIP_MARK_ROLE_ATK_PER_STEP = { bomber: 0.04 };
const SHIP_MARK_ROLE_SHIELD_PER_STEP = { kapital: 0.04 };
function shipMarkAtkPerStep(key) {
  const rolle = COUNTER_ROLE_OF[key];
  const v = rolle && SHIP_MARK_ROLE_ATK_PER_STEP[rolle];
  return (typeof v === 'number') ? v : SHIP_MARK_ATK_PER_STEP;
}
function shipMarkShieldPerStep(key) {
  const rolle = COUNTER_ROLE_OF[key];
  const v = rolle && SHIP_MARK_ROLE_SHIELD_PER_STEP[rolle];
  return (typeof v === 'number') ? v : SHIP_MARK_SHIELD_PER_STEP;
}
function shipMarkLevel(marks, key) {
  const v = marks && marks[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
  return Math.max(1, Math.min(SHIP_MARK_MAX, Math.floor(v)));
}
function shipMarkAtkMult(marks, key) { return 1 + (shipMarkLevel(marks, key) - 1) * shipMarkAtkPerStep(key); }
function shipMarkShieldMult(marks, key) { return 1 + (shipMarkLevel(marks, key) - 1) * shipMarkShieldPerStep(key); }
function rawFleetPower(f, ssAtkMult, t2AtkMult, marks) {
  if (!f) return 0;
  const ssM = ssAtkMult || 1, t2M = t2AtkMult || 1;
  // dm() ist diminishingShipCount() plus dem Markenfaktor DIESER Klasse - dieselbe Konstruktion wie
  // im Frontend, damit jede Zeile ihren Angriffswert exakt dort behaelt, wo er vorher stand.
  const dm = (key, count) => diminishingShipCount(count || 0) * shipMarkAtkMult(marks, key);
  return dm('cruisers', f.cruisers) * 20 + dm('destroyers', f.destroyers) * 45 + dm('ships', f.ships) * 5 +
    dm('jaeger', f.jaeger) * 10 + dm('bomber', f.bomber) * 60 + dm('schlachtschiff', f.schlachtschiff) * 90 * ssM +
    dm('carrier', f.carrier) * 15 + dm('superschlachtschiff', f.superschlachtschiff) * 220 + dm('waechter', f.waechter) * 8 +
    (dm('nanoklinge', f.nanoklinge) * 55 + dm('quantenkreuzer', f.quantenkreuzer) * 80 + dm('fusionsdreadnought', f.fusionsdreadnought) * 180) * t2M +
    // Leerenjäger + Event-Kampfschiffe (19.07.2026, Balance-Entscheidung Sascha: "Ja in Tabelle") -
    // Angriffswerte identisch zum Frontend (SHIP_DEFS). Die beiden reinen Utility-Event-Schiffe
    // (gesandtenschiff/schuerfschiff, atk 0, nicht in ATTACK_SHIP_KEYS des Frontends) bleiben
    // bewusst draußen - sie kämpfen auch clientseitig nicht.
    dm('leerenjaeger', f.leerenjaeger) * 140 + dm('kometenjaeger', f.kometenjaeger) * 18 +
    dm('enterschiff', f.enterschiff) * 25 + dm('phantomschiff', f.phantomschiff) * 35 +
    dm('riftwaechter', f.riftwaechter) * 20 +
    // Tier-2-Hyperjäger/-bomber (22.07.2026, Spieler-Wunsch) - Angriffswerte identisch zum Frontend
    // (SHIP_DEFS). Anders als reguläre Jäger/Bomber KEIN Trägerhangar nötig, daher hier ohne
    // deployableFighters-Kappung direkt gewertet (das Backend kennt den Hangar-Mechanismus ohnehin nicht).
    dm('hyperjaeger', f.hyperjaeger) * 30 + dm('hyperbomber', f.hyperbomber) * 130 +
    // Singularitäts-Vernichter (24.07.2026, Balance-Entscheidung Sascha: "Ja, angreifen lassen") -
    // Apex-Flaggschiff, stärkster regulärer Angriffswert (280). War bisher NUR in der Verteidigung
    // (SHIP_ATK_VALUES/SHIP_DEF_WEIGHTS), trug hier 0 Angriff bei - identisch zum Frontend nachgezogen
    // (attackPowerRaw/ATTACK_SHIP_KEYS). Metamaterial-Titan bleibt bewusst draußen (reine Verteidigung).
    dm('singularitaetsvernichter', f.singularitaetsvernichter) * 280 * t2M +
    // Urmaterie-Koloss (21.08.2026, Etappe D) - Angriffswert identisch zum Frontend (SHIP_DEFS,
    // atk 250). Bewusst OHNE t2M: Der Multiplikator kommt aus der Modulgruppe 'raffiniert', und
    // die fuehrt den Koloss nicht - siehe die ausfuehrliche Begruendung an derselben Zeile in
    // attackPowerRaw des Frontends.
    dm('urmateriekoloss', f.urmateriekoloss) * 250;
}
// Verteidigungsspezialisierung (13.07.2026) - defWeight-Gewichte identisch zum Frontend (SHIP_DEFS),
// wirken NUR hier auf die Verteidigung, nie auf die Angriffskraft. Keine Schilde hier (der Backend-
// Ansatz kennt generell keine Schilde, vorbestehende Vereinfachung gegenüber dem Frontend).
// Apex-Schiffe metamaterialtitan/singularitaetsvernichter (23.07.2026): defWeight/atk identisch zum
// Frontend (SHIP_DEFS). Sie fehlten hier komplett und trugen serverseitig 0 zur Verteidigung bei,
// obwohl der Metamaterial-Titan der schwerste Verteidigungs-Titan des Spiels ist. Werte NUR für die
// Verteidigungs-/Schildberechnung (weightedFleetDefensePower/fleetShieldSum) - bewusst NICHT in
// rawFleetPower, exakt wie das Frontend beide aus attackPowerRaw/ATTACK_SHIP_KEYS ausschließt.
// Allianzflotte (05.08.2026): Paktkorvette/Bundeskreuzer/Sternenbanner. Sie sind im Frontend an
// Allianzmitgliedschaft, Allianzforschung und die Stufe der Gemeinsamen Flottenwerft gebunden -
// dieser Server prueft das NICHT nach (der Schiffsbau ist wie bei allen anderen Klassen
// clientseitig). Was er tut, ist dasselbe wie fuer jede andere Klasse: Er kennt ihre Kampf- und
// Punktwerte, damit ein PvP-Angriff und der Bestenlisten-Score sie nicht stillschweigend mit 0
// bewerten - genau der Fallstrick, an dem SHIP_SCORE_WEIGHTS hier schon dreimal veraltet ist.
const SHIP_DEF_WEIGHTS = { jaeger:0.7, carrier:0.8, destroyers:0.9, bomber:0.5, waechter:2.0, schlachtschiff:1.3, superschlachtschiff:1.3, nanoklinge:0.8, quantenkreuzer:1.4, fusionsdreadnought:1.5, leerenjaeger:1.1, kometenjaeger:0.6, enterschiff:1.6, phantomschiff:0.3, riftwaechter:0.8, hyperjaeger:0.6, hyperbomber:0.9, metamaterialtitan:2.0, singularitaetsvernichter:1.6, kausalitaetsbrecher:1.8, urmateriekoloss:1.8, paktkorvette:0.7, bundeskreuzer:1.7, sternenbanner:1.5 };
const SHIP_ATK_VALUES = { cruisers:20, destroyers:45, ships:5, jaeger:10, bomber:60, schlachtschiff:90, carrier:15, superschlachtschiff:220, waechter:8, nanoklinge:55, quantenkreuzer:80, fusionsdreadnought:180, leerenjaeger:140, kometenjaeger:18, enterschiff:25, phantomschiff:35, riftwaechter:20, hyperjaeger:30, hyperbomber:130, metamaterialtitan:150, singularitaetsvernichter:280, kausalitaetsbrecher:340, urmateriekoloss:250, paktkorvette:40, bundeskreuzer:110, sternenbanner:240 };
// marks (31.07.2026): derselbe atk-Markenfaktor wie in rawFleetPower - es ist derselbe
// Angriffswert, hier nur mit defWeight verrechnet.
/* save ist OPTIONAL: Die Asteroiden-Anfechtung ruft mit der Eskorte eines FREMDEN Spielers auf und
   hat dessen Spielstand nicht zur Hand - dort bleibt es (wie schon bei den Marken) beim blanken
   Flottenwert. Mit save spiegelt die Funktion shipDefenseContribution() im Frontend vollstaendig:
   Huellen-Module, Traegerhangar und die Kampfforschung. */
function weightedFleetDefensePower(f, marks, save) {
  if (!f) return 0;
  const huelle = save ? shipModulKlassenBoni(save, 'hull') : null;
  const df = einsatzbereiteJaeger(f);
  let sum = 0;
  for (const [k, atk] of Object.entries(SHIP_ATK_VALUES)) {
    // Jaeger und Bomber fliegen nur, soweit Traegerhangars sie fassen - genau wie im Frontend.
    let count = k === 'jaeger' ? df.jaeger : k === 'bomber' ? df.bomber : (f[k] || 0);
    if (!count) continue;
    // Hart bei +100 % gedeckelt, NICHT weicherDeckel: Das Frontend schreibt an dieser Stelle
    // Math.min(1.0, ...) - die weiche Form gilt dort nur fuer den atk-Kanal.
    const klasse = SHIP_KLASSE_VON[k];
    const hb = huelle && klasse ? Math.min(1.0, huelle[klasse] || 0) : 0;
    sum += diminishingShipCount(count) * atk * (SHIP_DEF_WEIGHTS[k] !== undefined ? SHIP_DEF_WEIGHTS[k] : 1)
         * (shipMarkAtkMult(marks, k) + hb);
  }
  if (save) {
    const r = save.research || {};
    if (r.rkampf) sum *= (1 + r.rkampf * 0.02);
    if (r.rkampf2) sum *= (1 + r.rkampf2 * 0.02);
  }
  return sum;
}
// Flottenaufbau-Bonus - identisch zum Frontend (fleetDiversityMult, siehe dortigen Kommentar).
// Vorher: +2% je unterschiedlichem Schiffstyp (eine Checkliste). Jetzt: wie gleichmäßig sich die
// Angriffskraft der Flotte über die drei Konterrollen verteilt. Ausgewogen = +8% und konterneutral,
// spezialisiert = +0% und dafür der volle Konterbonus/-malus. Höchstwert unverändert +8%.
const FLEET_BALANCE_MAX_BONUS = 0.08;
// Angriffsgewichte NUR für die Rollenbalance. Bewusst eine eigene Tabelle statt SHIP_ATK_VALUES:
// dort fehlt der Mondzerstörer absichtlich (Spezialschiff mit eigenem Belagerungs-Endpunkt, zählt
// nicht in rawFleetPower/fleetShieldSum) - ihn dort nachzutragen wäre eine ungewollte Änderung der
// PvP-Kampfkraft. Diese Tabelle spiegelt die atk-Werte aus SHIP_DEFS des Frontends, aus denen die
// dortige Balance-Rechnung sie direkt zieht; test_flottenbalance.js vergleicht beide Seiten.
const COUNTER_ROLE_ATK = {
  jaeger: 10, hyperjaeger: 30, kometenjaeger: 18, phantomschiff: 35, leerenjaeger: 140,
  bomber: 60, hyperbomber: 130, nanoklinge: 55, singularitaetsvernichter: 280, mondzerstoerer: 300, urmateriekoloss: 250,
  cruisers: 20, destroyers: 45, schlachtschiff: 90, superschlachtschiff: 220, carrier: 15,
  waechter: 8, quantenkreuzer: 80, fusionsdreadnought: 180, metamaterialtitan: 150,
  enterschiff: 25, riftwaechter: 20,
  paktkorvette: 40, bundeskreuzer: 110, sternenbanner: 240
};
function fleetDiversityMult(fleet) {
  if (!fleet) return 1;
  const perRole = {};
  let total = 0;
  for (const [k, atk] of Object.entries(COUNTER_ROLE_ATK)) {
    const rolle = COUNTER_ROLE_OF[k];
    if (!rolle) continue;
    const n = fleet[k] || 0;
    if (!(n > 0)) continue;
    const gewicht = n * (atk || 1);
    perRole[rolle] = (perRole[rolle] || 0) + gewicht;
    total += gewicht;
  }
  if (total <= 0) return 1;
  const rollen = COUNTER_ROLE_DEFS.length;
  const ideal = 1 / rollen;
  let abweichung = 0;
  for (const r of COUNTER_ROLE_DEFS) abweichung += Math.abs((perRole[r.key] || 0) / total - ideal);
  const maxAbweichung = 2 * (1 - ideal);
  const balance = maxAbweichung > 0 ? Math.max(0, 1 - abweichung / maxAbweichung) : 1;
  return 1 + balance * FLEET_BALANCE_MAX_BONUS;
}
// enemyFleetForCounter: die GESAMTE gegnerische Flotte (fleetSummary), optional – nur bei echtem PvP
// bekannt und übergeben, macht das Kontersystem wirksam.
// ===== Tier-2-Schiffs-Kampfauren (einzigartige Fähigkeiten) =====
// IDENTISCH zum Frontend (weltraum_kolonie.html, t2OffenseAuraMult/t2DefenseAuraMult) - gedeckelte,
// additive Auren, damit der server-autoritative PvP-Kampf nicht von der Client-Vorschau abweicht.
// Ohne diese Schiffe ist der Multiplikator exakt 1.0 (keine Balance-Verschiebung an bestehenden Kämpfen).
//  - Offensiv (Schild-Penetration): Nanoklinge +2%/Schiff, Singularitäts-Vernichter +5%/Schiff, max +30%.
//  - Defensiv (Schildprojektion): Quantenkreuzer +3%/Schiff, Metamaterial-Titan +5%/Schiff, max +30%.
const T2_OFFENSE_AURA = { nanoklinge: 0.02, singularitaetsvernichter: 0.05 }, T2_OFFENSE_AURA_CAP = 0.30;
const T2_DEFENSE_AURA = { quantenkreuzer: 0.03, metamaterialtitan: 0.05 }, T2_DEFENSE_AURA_CAP = 0.30;
function t2AuraSum(fleet, tbl, cap) { if (!fleet) return 0; let s = 0; for (const k in tbl) s += (fleet[k] || 0) * tbl[k]; return Math.min(cap, s); }
function t2OffenseAuraMult(fleet) { return 1 + t2AuraSum(fleet, T2_OFFENSE_AURA, T2_OFFENSE_AURA_CAP); }
function t2DefenseAuraMult(fleet) { return 1 + t2AuraSum(fleet, T2_DEFENSE_AURA, T2_DEFENSE_AURA_CAP); }
function computeAttackPower(save, enemyFleetForCounter) {
  const research = save.research || {};
  // Klassen-Angriffsmodule aus dem Spielstand (Zielcomputer/Fokusarray, siehe SHIP_MODULE_COMBAT_BASE).
  const ssAtkMult = 1 + shipModuleBonus(save, 'schlachtschiff', 'atk');
  const t2AtkMult = 1 + shipModuleBonus(save, 'raffiniert', 'atk');
  let power = 0;
  for (const f of allFleetsOf(save)) {
    let fp = rawFleetPower(f, ssAtkMult, t2AtkMult, save.shipMarks) * fleetDiversityMult(f);
    if (enemyFleetForCounter) fp *= counterMultiplier(f, enemyFleetForCounter);
    power += fp;
  }
  const k = research.rkampf || 0, k2 = research.rkampf2 || 0;
  if (k) power *= (1 + k * 0.02);
  if (k2) power *= (1 + k2 * 0.02);
  power *= doctrineMult(save, 'atk');
  power *= stanceOf(save).atkMult;
  power *= (1 + attackBonusGroup(save)); // gedeckelte Angriffs-Bonus-Gruppe (Teil-Port, siehe Kommentar)
  power *= buffMult(save, 'atk');        // temporäre Angriffs-Buffs
  power *= t2OffenseAuraMult(fleetSummary(save)); // Tier-2 Offensiv-Aura (Nanoklinge/Vernichter), gedeckelt
  return Math.round(power);
}
function computeDefensePower(save) {
  const research = save.research || {};
  let power = 0;
  // Heimatbasis (save.buildings/save.fleet) bekommt +20% ggü. Kolonien - getrennt behandeln.
  const homeBuildings = save.buildings || {};
  let homeBuildingSub = 0;
  // Bastionsmarke je Anlagenklasse - identisch zum Frontend (defensePower), wo derselbe Faktor an
  // der Summierstelle steht. Sie gilt fuer ALLE Standorte, deshalb dieselbe Zeile in beiden
  // Schleifen; der Schildanteil (BUILDING_SHIELD_FACTOR) laeuft mit, weil er ein Faktor auf
  // dieselbe Summe ist.
  for (const [k, v] of Object.entries(DEFENSE_VALUES)) homeBuildingSub += (homeBuildings[k] || 0) * v * bastionMarkMultServer(save, k);
  power += homeBuildingSub * BUILDING_SHIELD_FACTOR * HOME_DEFENSE_BONUS; // Gebäude + Schildanteil
  for (const c of Object.values(save.colonies || {})) {
    if (!c || !c.buildings) continue;
    let sub = 0;
    for (const [k, v] of Object.entries(DEFENSE_VALUES)) sub += (c.buildings[k] || 0) * v * bastionMarkMultServer(save, k);
    power += sub * BUILDING_SHIELD_FACTOR;
  }
  // Flotten-Verteidigung = Angriffs-abgeleiteter Anteil (×0,4) + Schildsumme, wie im Frontend.
  /* Rundung wie im Frontend: dort steht `Math.round(atkDerivedSum * 0.4) + shieldSum` INNERHALB von
     shipDefenseContribution, der Vielfalts-Faktor wirkt danach auf die fertige Summe. Vorher rundete
     der Server erst nach dem Faktor - ein Unterschied von unter einer Einheit, aber eine
     Paritaetspruefung muesste ihn sonst mit Spielraum umgehen statt die Regel zu messen. */
  power += (Math.round(weightedFleetDefensePower(save.fleet, save.shipMarks, save) * 0.4)
            + fleetShieldSum(save.fleet, save.shipMarks, save)) * fleetDiversityMult(save.fleet) * HOME_DEFENSE_BONUS;
  for (const c of Object.values(save.colonies || {})) {
    if (!c || !c.fleet) continue;
    power += (Math.round(weightedFleetDefensePower(c.fleet, save.shipMarks, save) * 0.4)
              + fleetShieldSum(c.fleet, save.shipMarks, save)) * fleetDiversityMult(c.fleet);
  }
  const p = research.rpanzer || 0, s = research.rschildmatrix || 0;
  if (p) power *= (1 + p * 0.02);
  if (s) power *= (1 + s * 0.02);
  // Kehrseite des Perks "Schwarmtaktiker" (Fehlerbehebung 01.08.2026): Angriff rauf, Verteidigung
  // runter. Steht im Frontend (defensePower) als eigener Multiplikator AUSSERHALB der gedeckelten
  // Gruppe, mit derselben Untergrenze 0.5 - hier fehlte er, der Server hielt die Verteidigung eines
  // Schwarmtaktikers also für höher, als sie im Spiel ausgewiesen wird.
  power *= Math.max(0.5, 1 - ((save.prestigePerks || []).filter(k => k === 'schwarm').length) * 0.06);
  power *= doctrineMult(save, 'def');
  power *= stanceOf(save).defMult;
  power *= (1 + defenseBonusGroup(save)); // gedeckelte Verteidigungs-Bonus-Gruppe (Teil-Port, siehe Kommentar)
  power *= buffMult(save, 'def');        // temporäre Verteidigungs-Buffs
  // Feindliche Sabotage (Störmanöver): der /api/sabotage-Endpunkt schreibt defenseSabotage
  // (-30% für 30 Min) zwar in den Ziel-Save, hier wurde es aber NIE gelesen - der Malus hatte auf
  // server-entschiedene Folgeangriffe keine Wirkung, obwohl genau das sein Zweck ist (Bonus-Audit
  // 24.07.2026). Identisch zum Frontend (defensePower): power *= (1 - pct), nur solange aktiv.
  if (save.defenseSabotage && save.defenseSabotage.until > Date.now() && typeof save.defenseSabotage.pct === 'number') {
    power *= (1 - Math.max(0, Math.min(0.9, save.defenseSabotage.pct)));
  }
  power *= t2DefenseAuraMult(fleetSummary(save)); // Tier-2 Defensiv-Aura (Quantenkreuzer/Titan), gedeckelt
  return Math.round(power);
}
// Anti-Farming: Punktestand aus der Bestenliste lesen, für die Beute-Reduktion bei großem Gefälle.
function scoreOf(userId) {
  try {
    const lb = db.shared['leaderboard:' + userId];
    if (lb) return (JSON.parse(lb).score) || 0;
  } catch (e) {}
  return 0;
}
function farmingPenaltyFor(attackerUserId, targetUserId) {
  const myScore = scoreOf(attackerUserId), targetScore = scoreOf(targetUserId);
  const ratio = targetScore > 0 ? myScore / targetScore : 1;
  return ratio > 3 ? Math.max(0.3, 1 - (ratio - 3) * 0.1) : 1;
}
// Schildmodul ('schild', Effekt raidloss, MODULE_DEFS im Frontend): senkt clientseitig den
// Ressourcenverlust bei NPC-Überfällen je Standort (lossPct *= max(0.4, 1 - moduleBonusAt)).
// Serverseitig wirkte es bisher GAR NICHT - ausgerechnet beim echten PvP, wo der Schutz am
// wichtigsten wäre (Bonus-Audit 24.07.2026). Da die Server-Beute KONTOWEIT abgezogen wird (keine
// Ziel-Planet-Auflösung im Angriff), wird der Schutz als MITTELWERT der Standort-Boni über alle
// Standorte (Heimat + Kolonien) angewendet - ein voll bestücktes Lager schützt also anteilig,
// kann aber nicht das ganze Imperium mit den Modulen EINES Standorts abdecken. Gleicher
// 0.4-Boden wie im Frontend. Modul-Instanzen sind als "typ:seltenheit" kodiert.
// Sieben Stufen seit v8.443.0 (Build-System Etappe 1): ungewoehnlich und exotisch ergaenzt.
// Diese Kopie MUSS mit MODULE_RARITY im Frontend uebereinstimmen - der ||1-Fallback wuerde
// eine fehlende Stufe sonst still mit Faktor 1 auszahlen (tests/test_seltenheiten.js im
// Frontend-Repo prueft beide Seiten gegeneinander).
// primordial (16.08.2026): achte Stufe, nur aus Tier-3-Material schmiedbar. Muss hier stehen -
// ohne Eintrag zahlt der Ueberfall-Schutz sie mit Faktor 1 aus, also wie ein gewoehnliches Modul.
// Genau davor warnt der Kommentar an der Frontend-Kopie (MODULE_RARITY in weltraum_kolonie.html).
const MODULE_RARITY_MULT = { gewoehnlich: 1.0, ungewoehnlich: 1.3, selten: 1.6, episch: 2.4, legendaer: 3.5, mythisch: 5.0, exotisch: 7.0, primordial: 9.5 };
const RAIDLOSS_MODULE_BASE = 0.05;
// Schiffsklassen-Kampfmodule (SHIP_MODULE_DEFS im Frontend, nur die kampfrelevanten Einträge).
// Bugfix (24.07.2026, Modul-Text-Audit): Zielcomputer wirkte nur in der Client-Vorschau, Reaktorkern-
// Upgrade und Singularitäts-Fokusarray wirkten NIRGENDS (kein Verbraucher) - Spieler zahlten
// z.B. 10 Singularitätskerne für ein totes Modul. Der Server liest die ausgerüsteten Module jetzt
// direkt aus dem (server-validierten) Spielstand - kein Cheat-Vektor, und FE-Vorschau und Server-PvP
// bleiben synchron. Basiswerte × Seltenheits-Multiplikator, atk je Klasse bei +100% gedeckelt
// (identisch zur Frontend-Deckelung von Zielcomputer/Fokusarray).
const SHIP_MODULE_COMBAT_BASE = {
  ss_zielcomputer: { klasse: 'schlachtschiff', effect: 'atk', base: 0.05 },
  mz_reaktorkern: { klasse: 'mondzerstoerer', effect: 'atk', base: 0.05 },
  t2_singularitaetsfokus: { klasse: 'raffiniert', effect: 'atk', base: 0.14 },
  mz_praezisionslaser: { klasse: 'mondzerstoerer', effect: 'siegechance', base: 0.05 },
  /* hull/shield (21.08.2026): Bis dahin fuehrte diese Tabelle 4 von 44 Modulen, und die
     Flottenverteidigung des Servers kannte die Klassenmodule deshalb gar nicht - siehe den langen
     Kommentar bei SHIP_KLASSE_VON. Die Basiswerte sind aus SHIP_MODULE_DEFS im Frontend erzeugt,
     nicht abgetippt; tests/test_schiffsmodul_paritaet.js dort haelt beide Seiten zusammen. */
  ss_panzerung: { klasse: 'schlachtschiff', effect: 'hull', base: 0.10 },
  ss_schildverstaerker: { klasse: 'schlachtschiff', effect: 'shield', base: 0.08 },
  au_scanner: { klasse: 'aufklaerer', effect: 'hull', base: 0.10 },
  mz_huelle: { klasse: 'mondzerstoerer', effect: 'hull', base: 0.10 },
  fr_notpanzerung: { klasse: 'frachter', effect: 'hull', base: 0.10 },
  au_deflektor: { klasse: 'aufklaerer', effect: 'shield', base: 0.08 },
  mz_schildmatrix: { klasse: 'mondzerstoerer', effect: 'shield', base: 0.08 },
  t2_kristallhuelle: { klasse: 'raffiniert', effect: 'hull', base: 0.10 },
  jg_staffelpanzer: { klasse: 'jagdgeschwader', effect: 'hull', base: 0.10 },
  jg_deflektor: { klasse: 'jagdgeschwader', effect: 'shield', base: 0.08 },
  sl_kompositpanzer: { klasse: 'schwerelinie', effect: 'hull', base: 0.10 },
  sl_schildgitter: { klasse: 'schwerelinie', effect: 'shield', base: 0.08 },
  t2_metamaterialpanzer: { klasse: 'raffiniert', effect: 'hull', base: 0.14 },
  ev_kometenschild: { klasse: 'jagdgeschwader', effect: 'shield', base: 0.12 },
  ev_enterhaken: { klasse: 'eventflotte', effect: 'hull', base: 0.12 },
  ev_risskern: { klasse: 'eventflotte', effect: 'shield', base: 0.12 },
  // Wrackkonvoi-Beute (A2, quelle:'konvoi'). Basis 0.12 = die Exklusiv-Stufe der Event-Module
  // daneben, NICHT erhoeht - der Exklusiv-Reiz liegt an der episch-Seltenheit des Fundes, nicht an
  // einer hoeheren Basis. Diese Zeile ist die PvP-Paritaet (Regel 60, Backend-zuerst); das Frontend
  // fuehrt kv_bergungspanzer in SHIP_MODULE_DEFS, test_schiffsmodul_paritaet.js haelt beide zusammen.
  kv_bergungspanzer: { klasse: 'schwerelinie', effect: 'hull', base: 0.12 },
};
/* ===== Schiffsklassen-Module in der VERTEIDIGUNG (21.08.2026, Auftrag Sascha) ===============
   Bis hierher war die serverseitige Flottenverteidigung eine VEREINFACHUNG des Frontends, und
   sie war ueber Monate weit auseinandergelaufen. Gemessen an einer Flotte aus 200 Schlachtschiffen,
   300 Kreuzern, 200 Zerstoerern und 100 Metamaterial-Titanen:

     Frontend OHNE Module   35.000        Server (immer)   51.600   -> +47 % zu VIEL
     Frontend MIT  Modulen  68.552        Server (immer)   51.600   -> -25 % zu WENIG
     (die zweite Zeile mit je drei epischen Huellen- UND Schildmodulen auf allen drei beteiligten
      Klassen - eine Zahl ohne genannte Messvorrichtung fuehrt beim naechsten Lesen in die Irre,
      und genau das ist beim Nachrechnen dieser Zeile schon einmal passiert)

   NACH der Angleichung gemessen, dieselbe Flotte, Frontend gegen Backend: 35.000 zu 35.000 ohne
   Module und 63.944 zu 63.944 mit drei epischen Huellenmodulen je Klasse - Abweichung NULL.

   Die beiden Fehler haben einander verdeckt - ein mittelmaessig ausgeruesteter Spieler landete
   zufaellig nahe der Paritaet. Vier Ursachen, alle einzeln gemessen:

   1. SCHILD-BASIS. Von 43 Schiffstypen haben 34 keinen eigenen `shield`-Wert. Das Frontend gibt
      ihnen die Basis NULL - seine Konstruktion `(def.atk||0)*shieldBonus*0.5` existiert nur, damit
      ein prozentualer Modulbonus ueberhaupt etwas zum Verstaerken hat (der Kommentar dort sagt es
      woertlich). Der Server erfand ihnen ueber shipShield() eine Basis von atk*0.5 - im Beispiel
      das 3,1-fache an Schild. Das war die groesste der vier Abweichungen.
   2. MODULE. hull/shield der Schiffsklassen-Module kannte der Server gar nicht; SHIP_MODULE_COMBAT_BASE
      fuehrte 4 von 44 Modulen, alle mit atk/siegechance.
   3. FORSCHUNG. Das Frontend multipliziert den Flotten-Angriffsanteil der Verteidigung mit
      rkampf/rkampf2 (je 2 %/Stufe, max 20) - bei einem ausgebauten Konto bis zum 1,96-fachen.
      Der Server wandte auf die Verteidigung nur rpanzer/rschildmatrix an.
   4. HANGAR. Das Frontend wertet Jaeger/Bomber nur bis zur Traegerkapazitaet (deployableFighters).
      Der Server zaehlte sie voll - 2000 Jaeger ohne einen einzigen Traeger trugen 8.050 statt 0.

   ENTSCHIEDEN (Sascha, 21.08.2026): alle vier angleichen, und zwar auf das FRONTEND. Es ist die
   Seite, die der Spieler sieht, und seine Konstruktionen sind im Quelltext begruendet, waehrend die
   Server-Vereinfachungen erfunden waren (ihre eigenen Kommentare sagen das: "der Backend-Ansatz
   kennt generell keine Schilde, vorbestehende Vereinfachung" und "das Backend kennt den
   Hangar-Mechanismus ohnehin nicht"). Folge fuer die Balance: Verteidigung wird MODULABHAENGIG -
   wer ausgeruestet ist, gewinnt, wer nichts ausgeruestet hat, verliert.

   WAS SICH DABEI AUCH AENDERT, und es steht hier, damit es niemanden ueberrascht: Die
   Asteroiden-Anfechtung ruft dieselben zwei Funktionen mit `null` auf (der Halter-Spielstand liegt
   dort nicht vor). Seine Eskorte verliert damit ebenfalls die erfundene Schild-Basis. Die Vorschau
   der Anfechtung zeigt bewusst KEINE Zahl, es gibt dort also keine Anzeigestelle, die falsch
   wuerde - aber die Kraefteverhaeltnisse verschieben sich. */
const SHIP_KLASSE_VON = (() => {
  // Kopie von SHIP_CLASS_DEFS[].shipKeys im Frontend - dieselbe Kopie-Familie wie SHIP_ATK_VALUES.
  const k = {
    schlachtschiff: ['schlachtschiff'],
    frachter: ['frachter', 'frachtergross', 'bergungsfrachter'],
    aufklaerer: ['ships', 'spaeher'],
    mondzerstoerer: ['mondzerstoerer'],
    raffiniert: ['nanoklinge', 'quantenkreuzer', 'fusionsdreadnought', 'metamaterialtitan', 'singularitaetsvernichter'],
    jagdgeschwader: ['jaeger', 'hyperjaeger', 'leerenjaeger', 'kometenjaeger'],
    schwerelinie: ['cruisers', 'destroyers', 'bomber', 'hyperbomber'],
    eventflotte: ['enterschiff', 'phantomschiff', 'riftwaechter', 'gesandtenschiff', 'schuerfschiff']
  };
  const raus = {};
  for (const kl of Object.keys(k)) for (const sk of k[kl]) raus[sk] = kl;
  return raus;
})();
// Zweitwerte (Substats) - Spiegel von moduleSubsOf() im Frontend. Sie sind bewusst atk-frei, tragen
// aber sehr wohl hull/shield (MODULE_SUB_POOL_SHIP), und ohne sie waere die Spiegelung unvollstaendig.
function moduleSubsServer(instKey) {
  const seg = String(instKey || '').split(':')[3] || '';
  if (!seg) return [];
  const out = [];
  for (const tok of seg.split('.')) {
    const m = tok.match(/^([a-z]+)(\d+)$/);
    if (m && m[1] !== 'w') out.push({ effect: m[1], value: parseInt(m[2], 10) / 1000 });  // 'w' = Hauptwert-Wurf
  }
  return out;
}
/* Die Klassen-Boni EINMAL je Aufruf sammeln statt je Schiffstyp - weightedFleetDefensePower laeuft
   ueber 40+ Typen, und shipModuleBonus iteriert jedes Mal die ausgeruesteten Module.
   Die SYNERGIEN des Frontends (shipSynergyBonusFor) fehlen hier bewusst: gemessen tragen alle sechs
   ausschliesslich speed/fuel/cargo, keine einzige hull/shield/atk. Wer dort je eine anlegt, muss sie
   hier nachziehen - tests/test_schiffsmodul_paritaet.js im FRONTEND-Repo haelt das fest. */
function shipModulKlassenBoni(save, effect) {
  const raus = {};
  const eq = ((save || {}).equippedShipModules) || {};
  for (const klasse of Object.keys(eq)) {
    let sum = 0;
    for (const instKey of (eq[klasse] || [])) {
      if (typeof instKey !== 'string') continue;
      const [key, rarity] = instKey.split(':');
      const def = SHIP_MODULE_COMBAT_BASE[key];
      const mult = (MODULE_RARITY_MULT[rarity] || 1) * moduleLevelMultServer(instKey) * moduleWertMultServer(instKey);
      if (def && def.klasse === klasse && def.effect === effect) sum += def.base * mult;
      for (const sub of moduleSubsServer(instKey)) if (sub.effect === effect) sum += sub.value;
    }
    // Der Set-Bonus faellt VOR den Deckel, genau wie im Frontend (dort steckt er in
    // shipModuleBonusFor, und Math.min(1.0, ...) greift erst an der Verbrauchsstelle).
    raus[klasse] = sum + shipModulSetBonusServer(save, klasse, effect);
  }
  /* Eine Klasse ohne ein einziges ausgeruestetes Modul steht gar nicht in equippedShipModules und
     bekaeme oben nichts - fuer den Set-Bonus ist das folgenlos (er braucht mindestens zwei Teile),
     die Zeile bleibt trotzdem hier stehen, damit beim naechsten Lesen niemand danach sucht. */
  return raus;
}
/* ===== Klassen-Sets der Schiffsmodule (21.08.2026) - Kopie von SHIP_MODULE_SET_DEFS im Frontend.
   Hier stehen nur die maschinell noetigen Felder; Name, Symbol und Beschreibung bleiben vorne.
   Der Set-Bonus traegt `atk`, `hull` und `shield` und entscheidet damit PvP - deshalb MUSS er
   gespiegelt sein. tests/test_schiffsmodul_paritaet.js im FRONTEND-Repo haelt beide Seiten
   zusammen, Feld fuer Feld.
   Die uebrigen Kanaele (speed/fuel/cargo) rechnet der Server ohnehin nicht nach; sie stehen
   trotzdem in der Tabelle, damit sie vollstaendig neben der Frontend-Kopie liegt und beim
   naechsten Balance-Pass niemand denkt, sie seien vergessen worden - dieselbe Begruendung wie bei
   den drei wirtschaftlichen Doktrinen in DOCTRINE_MULTS. */
const SHIP_MODULE_SET_DEFS = [
  { key: 'linienschiff', klasse: 'schlachtschiff', req: ['ss_panzerung', 'ss_zielcomputer', 'ss_schildverstaerker'], stufen: [{ teile: 2, bonuses: { hull: 0.08 } }, { teile: 3, bonuses: { atk: 0.06 } }] },
  { key: 'handelskonvoi', klasse: 'frachter', req: ['fr_frachtraum', 'fr_treibstoff', 'fr_triebwerke'], stufen: [{ teile: 2, bonuses: { cargo: 0.1 } }, { teile: 3, bonuses: { fuel: 0.08 } }] },
  { key: 'spaehverband', klasse: 'aufklaerer', req: ['au_sensoren', 'au_tarnmodul', 'au_scanner'], stufen: [{ teile: 2, bonuses: { speed: 0.1 } }, { teile: 3, bonuses: { fuel: 0.08 } }] },
  { key: 'belagerungsflotte', klasse: 'mondzerstoerer', req: ['mz_huelle', 'mz_schildmatrix', 'mz_antrieb'], stufen: [{ teile: 2, bonuses: { hull: 0.08 } }, { teile: 3, bonuses: { shield: 0.08 } }] },
  { key: 'singularitaet', klasse: 'raffiniert', req: ['t2_kristallhuelle', 't2_singularitaetsfokus', 't2_quantenkondensator'], stufen: [{ teile: 2, bonuses: { hull: 0.08 } }, { teile: 3, bonuses: { atk: 0.06 } }] },
  { key: 'schwarmtaktik', klasse: 'jagdgeschwader', req: ['jg_leichtbau', 'jg_staffelpanzer', 'jg_deflektor'], stufen: [{ teile: 2, bonuses: { speed: 0.1 } }, { teile: 3, bonuses: { shield: 0.08 } }] },
  { key: 'sturmlinie', klasse: 'schwerelinie', req: ['sl_kompositpanzer', 'sl_schildgitter', 'sl_marschtriebwerk'], stufen: [{ teile: 2, bonuses: { hull: 0.08 } }, { teile: 3, bonuses: { shield: 0.08 } }] },
  { key: 'beutezug', klasse: 'eventflotte', req: ['ev_enterhaken', 'ev_risskern', 'ev_phasenfeld'], stufen: [{ teile: 2, bonuses: { hull: 0.08 } }, { teile: 3, bonuses: { speed: 0.1 } }] }
];
/* Wie viele Teile des Klassen-Sets sind ausgeruestet? Verglichen wird der TYP (erstes Segment des
   Instanzschluessels) - das Frontend verbietet zwei Module desselben Typs je Klasse ohnehin. */
function shipModulSetBonusServer(save, klasse, effect) {
  const def = SHIP_MODULE_SET_DEFS.find(x => x.klasse === klasse);
  if (!def) return 0;
  const typen = (((save || {}).equippedShipModules || {})[klasse] || [])
    .filter(k => typeof k === 'string').map(k => k.split(':')[0]);
  const teile = def.req.filter(r => typen.indexOf(r) >= 0).length;
  let sum = 0;
  for (const st of def.stufen) if (teile >= st.teile) sum += (st.bonuses[effect] || 0);
  return sum;
}
// Traegerhangar - Spiegel von hangarCapacity()/deployableFighters() im Frontend.
const SUPER_HANGAR_SLOTS_SERVER = 2, CARRIER_HANGAR_SLOTS_SERVER = 6;
function einsatzbereiteJaeger(f) {
  const cap = (f.carrier || 0) * CARRIER_HANGAR_SLOTS_SERVER + (f.superschlachtschiff || 0) * SUPER_HANGAR_SLOTS_SERVER;
  const jaeger = Math.min(f.jaeger || 0, cap);
  return { jaeger, bomber: Math.min(f.bomber || 0, Math.max(0, cap - jaeger)) };
}
// Modul-Level (FE/BE-Parität, Modul-Overhaul Runde 1): Instanzen sind als "typ:seltenheit:level"
// kodiert; fehlt das Level-Segment, gilt Level 1. Der Level-Multiplikator (+10% je Stufe, max. Lvl 10)
// muss serverseitig identisch wie im Frontend (moduleLevelMult) angewendet werden, sonst weicht die
// server-validierte PvP-Kampfkraft von der Frontend-Vorschau ab.
const MODULE_LEVEL_PER = 0.10, MODULE_LEVEL_MAX = 10;
function moduleLevelMultServer(instKey) {
  const l = parseInt(String(instKey).split(':')[2] || '1', 10);
  const lvl = Math.max(1, Math.min(MODULE_LEVEL_MAX, isNaN(l) ? 1 : l));
  return 1 + (lvl - 1) * MODULE_LEVEL_PER;
}
// Hauptwert-Streuung (FE v8.444.0, Build-System Etappe 2): Funde tragen ein "wNN"-Token
// (90..110) im Substat-Segment; gefertigte Module und Altbestand haben keins und gelten
// als 100%. MUSS ueberall dort mitmultipliziert werden, wo der Server Modulwirkung aus dem
// instKey nachrechnet (PvP-Kampfmodule, Ueberfall-Schutz) - sonst zeigte der Client einen
// Wurf, den der Server nie auszahlt. Spanne identisch zu MODULE_WERT_MIN/MAX im Frontend.
function moduleWertMultServer(instKey) {
  const seg = String(instKey).split(':')[3] || '';
  const m = seg.match(/(?:^|\.)w(\d{2,3})(?:\.|$)/);
  if (!m) return 1;
  return Math.max(90, Math.min(110, parseInt(m[1], 10))) / 100;
}
function shipModuleBonus(save, klasse, effect) {
  let sum = 0;
  for (const instKey of (((save || {}).equippedShipModules || {})[klasse] || [])) {
    if (typeof instKey !== 'string') continue;
    const [key, rarity] = instKey.split(':');
    const def = SHIP_MODULE_COMBAT_BASE[key];
    if (!def || def.klasse !== klasse || def.effect !== effect) continue;
    sum += def.base * (MODULE_RARITY_MULT[rarity] || 1) * moduleLevelMultServer(instKey) * moduleWertMultServer(instKey);
  }
  sum += shipModulSetBonusServer(save, klasse, effect);   // Klassen-Set, vor dem Deckel wie vorne
  // Schiffsmodul-Angriff: derselbe Deckel wie im Frontend an seinen beiden Verbrauchsstellen
  // (schlachtschiffAtkMult, t2AtkMult) - dort steht dieselbe Umstellung.
  return effect === 'atk' ? weicherDeckel(sum, 1.0 * deckelAusbauServer(save)) : sum;
}
function raidlossProtectionMult(save) {
  const eq = save.equippedModules || {};
  const locations = 1 + Object.keys(save.colonies || {}).length;
  let total = 0;
  for (const pk of Object.keys(eq)) {
    for (const instKey of (eq[pk] || [])) {
      if (typeof instKey !== 'string') continue;
      const [type, rarity] = instKey.split(':');
      if (type !== 'schild') continue;
      total += RAIDLOSS_MODULE_BASE * (MODULE_RARITY_MULT[rarity] || 1) * moduleLevelMultServer(instKey) * moduleWertMultServer(instKey);
    }
  }
  // Überfall-Schutz: Der Boden 0,4 auf dem Multiplikator entsprach einem harten Deckel von 60 %
  // auf dem BONUS. Jetzt derselbe weiche Deckel wie überall - am Bonus gerechnet, nicht am
  // Multiplikator (sonst am falschen Ende, siehe die vier Zeit-Ersparnisse in v8.468.0).
  // Der Multiplikator kann dadurch bis 0,25 sinken statt nur bis 0,40; erreicht wird das erst
  // mit weit über der bisherigen Obergrenze gestapelten Schildmodulen.
  const roh = locations > 0 ? total / locations : 0;
  return 1 - weicherDeckel(roh, 0.6 * deckelAusbauServer(save));
}
function defenseBreakdown(save) {
  const totals = {};
  for (const b of allBuildingsOf(save)) for (const k of Object.keys(DEFENSE_VALUES)) totals[k] = (totals[k] || 0) + (b[k] || 0);
  for (const k of Object.keys(totals)) if (!totals[k]) delete totals[k];
  return totals;
}
function fleetSummary(save) {
  const totals = {};
  for (const f of allFleetsOf(save)) for (const [k, v] of Object.entries(f)) {
    if (k === 'missions' || typeof v !== 'number') continue;
    totals[k] = (totals[k] || 0) + v;
  }
  return totals;
}

// --- Angriffs-Schutzschild (Anti-Ganking) ---
// Wer erfolgreich überfallen (Beute) ODER sabotiert wird, bekommt einen zeitlich begrenzten Schild:
// Solange er aktiv ist, prallen weitere PvP-Angriffe/Störmanöver gegen dieses Konto ab. Das bremst das
// Dauer-Farmen frisch geschlagener (oft schwächerer/abwesender) Spieler. Selbst offensiv zu werden
// (eigener Angriff/Sabotage) verwirkt den eigenen Schild sofort - der Schutz ist für Opfer gedacht,
// nicht als Immunitäts-Trick für Angreifer. Serverautoritativ in db.private[userId].__attackShieldUntil.
const ATTACK_SHIELD_MS = 30 * 60 * 1000;
function attackShieldRemaining(userId) {
  const until = (db.private[userId] && db.private[userId].__attackShieldUntil) || 0;
  return Math.max(0, until - Date.now());
}
function grantAttackShield(userId) {
  if (!db.private[userId]) db.private[userId] = {};
  // Nicht verlängern, wenn schon ein längerer Schild läuft - immer auf mind. ATTACK_SHIELD_MS setzen.
  db.private[userId].__attackShieldUntil = Math.max(db.private[userId].__attackShieldUntil || 0, Date.now() + ATTACK_SHIELD_MS);
}
function breakOwnAttackShield(userId) {
  if (db.private[userId]) db.private[userId].__attackShieldUntil = 0;
}
// Anfängerschutz: frisch registrierte Konten bekommen einen langen Start-Schild (4 Tage), damit
// Neueinsteiger in Ruhe aufbauen können, statt sofort von etablierten Spielern gefarmt zu werden.
// Nutzt denselben __attackShieldUntil-Mechanismus wie der reaktive Schild – bricht also ebenfalls,
// sobald der Neuling selbst offensiv wird (breakOwnAttackShield in /attack und /sabotage).
const NEWBIE_SHIELD_MS = 4 * 24 * 60 * 60 * 1000;
function grantNewbieShield(userId) {
  if (!db.private[userId]) db.private[userId] = {};
  db.private[userId].__attackShieldUntil = Math.max(db.private[userId].__attackShieldUntil || 0, Date.now() + NEWBIE_SHIELD_MS);
}

app.post('/api/attack', attackRateLimit, authMiddleware, async (req, res) => {
  const { targetUserId } = req.body || {};
  if (!targetUserId || targetUserId === req.userId) return res.status(400).json({ error: 'Ungültiges Ziel.' });
  // Ziel unter Schutzschild? -> Angriff prallt ab (kein Kampf, keine Beute, kein Punktgewinn).
  const shieldLeft = attackShieldRemaining(targetUserId);
  if (shieldLeft > 0) return res.status(403).json({ error: 'Ziel steht unter Angriffs-Schutzschild.', shieldMs: shieldLeft });
  // Selbst offensiv werden verwirkt den eigenen Schild.
  breakOwnAttackShield(req.userId);

  const attackerRaw = getSaveValue(req.userId);
  const targetRaw = getSaveValue(targetUserId);
  if (!attackerRaw || !targetRaw) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });

  let attacker, target;
  try { attacker = JSON.parse(attackerRaw); target = JSON.parse(targetRaw); }
  catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }

  const targetUser = findUserById(targetUserId);
  const attackerFleetSummary = fleetSummary(attacker);
  const targetFleetSummary = fleetSummary(target);
  // Kontersystem: die Zusammensetzung der Angreifer-Flotte gegen die des Ziels bestimmt einen
  // Bonus/Malus. Bei echtem PvP sind (anders als bei NPC-Kämpfen) beide Flotten bekannt.
  // Aufklärungsvorteil: frische, unentdeckte Spionage gegen genau dieses Ziel. Wird auf BEIDE
  // Angriffskraft-Werte angewandt (mit und ohne Konter), damit der abgeleitete Konterfaktor
  // unverändert bleibt - er ist das Verhältnis der beiden und darf sich davon nicht verschieben.
  const spyEdgeMult = 1 + spyIntelEdge(attacker, targetUserId);
  const attackPowerMitKonter = Math.round(computeAttackPower(attacker, targetFleetSummary) * spyEdgeMult);
  // Für die Phasen wird die Kontergewichtung je Phase eigen gesetzt - dafür braucht es die
  // Angriffskraft OHNE Konter und den effektiven Konterfaktor getrennt. computeAttackPower wendet
  // den Konter pro Teilflotte an; das Verhältnis der beiden Aufrufe ist genau der aggregierte
  // Faktor, ohne dass die Funktion selbst umgebaut werden muss.
  const attackPowerRoh = Math.round(computeAttackPower(attacker, null) * spyEdgeMult);
  const effektiverKonter = attackPowerRoh > 0 ? attackPowerMitKonter / attackPowerRoh : 1;
  // Verteidigungs-Aufstellung des ZIELS: die Wahl des Verteidigers wirkt genau hier, im einzigen
  // Kampf, in dem ein echter Gegner die Angriffszusammensetzung bestimmt.
  const attackerFleetForFormation = fleetSummary(attacker);
  const formationKey = target.defenseFormation || 'ausgewogen';
  const formationMult = formationDefenseMult(attackerFleetForFormation, formationKey);
  /* Gefechtsvorraete beider Seiten (Etappe B1). Sie werden GENAU HIER eingesetzt - nach allen
     Kraftberechnungen und vor dem Wurf -, und zwar je Kampf genau einmal je Seite. Die Funktion
     bucht ab; beide Spielstaende werden am Ende dieses Handlers ohnehin geschrieben.
     Der Angriffs-Vorrat wirkt auf attackPowerRoh, nicht auf attackPower: resolveBattlePhases
     gewichtet den Konter je Phase selbst, und attackPower ist nur der abgeleitete Anzeigewert.
     effektiverKonter bleibt unveraendert - er ist das VERHAELTNIS der beiden Werte und darf sich
     durch einen flachen Aufschlag nicht verschieben (dieselbe Ueberlegung wie beim spyEdgeMult). */
  const vorratAngriff = gefechtsvorratEinsetzenServer(attacker, 'angriff');
  const vorratVerteidigung = gefechtsvorratEinsetzenServer(target, 'verteidigung');
  const attackPowerMitVorrat = Math.round(attackPowerRoh * vorratAngriff.mult);
  /* Der ANGEZEIGTE Wert traegt den Vorrat ebenfalls. Er wird an sechs Stellen ausgegeben (zwei
     Berichte je Ausgang plus die Antwort an den Angreifer); haenge ich ihn hier an EINE Definition,
     kann keine davon veralten - genau der Fehlertyp, an dem dieses Projekt wiederholt haengengeblieben
     ist (Hausregel 6). Das Konterverhaeltnis darueber ist schon berechnet und bleibt unberuehrt. */
  const attackPower = Math.round(attackPowerMitKonter * vorratAngriff.mult);
  const defensePower = Math.round(computeDefensePower(target) * formationMult * vorratVerteidigung.mult);
  const phasenErgebnis = resolveBattlePhases(attackPowerMitVorrat, defensePower, effektiverKonter, PVP_PHASE_MIN, PVP_PHASE_MAX);
  const chance = battleWinChance(attackPowerMitVorrat, defensePower, effektiverKonter, PVP_PHASE_MIN, PVP_PHASE_MAX);
  const success = phasenErgebnis.success;

  const defenseBefore = defenseBreakdown(target);

  // Kampf-Einzelheiten für den Bericht des Angreifers (02.08.2026).
  //
  // WARUM: All das wurde hier schon immer BERECHNET und in die serverseitigen Berichte geschrieben -
  // die Antwort an den Client enthielt es aber nicht. Der Angreifer bekam nur "gewonnen/verloren"
  // samt zweier Kraftzahlen zurück, weshalb ein `player-attack`-Bericht als einziger Kampftyp weder
  // die Flotte des Gegners noch dessen Anlagen noch die drei Phasenurteile führte. Für jede Anzeige,
  // die den Kampf nachzeichnet, war PvP damit der ärmste Fall - obwohl der Server am meisten weiß.
  //
  // KEINE Balance-Änderung: Es wird nichts neu gewürfelt und nichts anders gerechnet, es wird
  // ausgeliefert, was ohnehin entstand.
  //
  // BEWUSSTE SPIELENTSCHEIDUNG: Damit erfährt der Angreifer die Flottenzusammensetzung des Ziels
  // NACH dem Kampf, ohne vorher spioniert zu haben. Das ist gewollt (der Kampf hat stattgefunden,
  // man hat gesehen, was einem gegenüberstand) und entspricht dem, was ein eingehender Überfall dem
  // Verteidigern längst zeigt. Es entwertet die Spionage nicht, weil die VOR dem Angriff aufklärt -
  // genau dann, wenn die Auskunft die Entscheidung noch beeinflussen kann.
  //
  // Verluste der Verteidigerflotte (02.08.2026): Ein gewonnener Angriff kostet das Ziel seit jetzt
  // auch SCHIFFE, nicht mehr nur Verteidigungsgebäude.
  //
  // WARUM NUR EIN PROZENTSATZ UND KEINE STÜCKZAHLEN, und warum der Server sie NICHT selbst abzieht -
  // beides folgt aus zwei harten Gegebenheiten dieses Projekts:
  //
  // (1) Ein direkter Eingriff in den Spielstand des Ziels wird still zurückgenommen, sobald das Ziel
  //     online ist. saveGameStateVersioned() im Frontend lädt bei HTTP 409 nur die neue
  //     Versionsnummer nach und schickt seinen EIGENEN, älteren Wert erneut - bis zu drei Mal, und
  //     der dritte Versuch gelingt. Die Schiffe wären wieder da. Genau dafür gibt es hier bereits
  //     die etablierte Warteschlange (siehe die Begründung beim Modulbörsen-Erlös weiter unten):
  //     der Server sagt WAS passiert ist, der Client des Betroffenen wendet es an.
  // (2) Stückzahlen würden eine zweite Kopie der Schiffsliste (ATTACK_SHIP_KEYS) im Backend
  //     erzwingen. SHIP_SCORE_WEIGHTS ist hier schon zweimal aus genau diesem Grund veraltet; ein
  //     künftiges Schiff, das nur im Frontend in die Liste wandert, wäre im PvP unzerstörbar.
  //     Der Prozentsatz braucht keine Liste und kann nicht veralten.
  //
  // Die Höhe ist von der bestehenden Überfall-Regel abgeleitet, nicht erfunden: Dort verliert die
  // stationierte Flotte die HÄLFTE des Ressourcenverlust-Prozentsatzes. lootPct liegt hier bei
  // 12-25%, macht also 6-12,5% Flottenverlust. Der Client dämpft zusätzlich wie beim Überfall
  // (Rückzugs-Mechanik) und deckelt an seinem echten Bestand - eine eingereihte Meldung kann also
  // niemals mehr Schiffe kosten, als wirklich dastehen.
  //
  // `defenderLostShips` gibt es weiterhin NICHT: Der Server kennt zum Zeitpunkt des Kampfes keine
  // verlässlichen Stückzahlen für einen Abzug, der erst später beim Ziel stattfindet. Eine Zahl in
  // den Bericht des Angreifers zu schreiben, die beim Verteidiger anders ausfällt, wäre schlechter
  // als der ehrliche Prozentsatz.
  // Bleibt im Niederlage-Zweig null: Ein abgewehrter Angriff kostet die Verteidigerflotte nichts.
  let defenderLossPct = null;
  const kampfDetails = () => ({
    phasen: phasenErgebnis.phasen,
    chancePct: Math.round(chance * 100),
    counterMult: effektiverKonter,
    formation: formationKey,
    formationMult,
    defenseBefore,
    defenderFleet: targetFleetSummary,
    // Nur im Sieg-Zweig belegt; im Niederlage-Zweig bleibt es undefiniert, weil ein
    // abgewehrter Angriff der Verteidigerflotte nichts kostet.
    defenderLossPct: defenderLossPct === null ? undefined : defenderLossPct
  });

  if (success) {
    const lootPct = 0.12 + Math.random() * 0.13; // 12-25%
    // Flottenverlust des Verteidigers: halber Ressourcenverlust, wie beim Ueberfall.
    // Die Variable ist WEITER OBEN deklariert, damit kampfDetails() sie sieht - eine hier
    // deklarierte const laege ausserhalb der Sichtbarkeit dieser Funktion, und `typeof` haette
    // dort still "undefined" geliefert, ohne Fehler und ohne Wirkung.
    defenderLossPct = Math.round(lootPct * 0.5 * 1000) / 1000;
    // Anti-Farming: deutlich stärkere Angreifer bekommen anteilig weniger Beute (nie unter 30%).
    const farmPenalty = farmingPenaltyFor(req.userId, targetUserId);
    // Schildmodule des Ziels senken die Beute (siehe raidlossProtectionMult - vorher wirkungslos im PvP).
    const lootProtection = raidlossProtectionMult(target);
    const stolen = {};
    for (const [r, amt] of Object.entries(target.resources || {})) {
      const take = Math.floor((amt || 0) * lootPct * farmPenalty * lootProtection);
      if (take > 0) {
        stolen[r] = take;
        target.resources[r] = Math.max(0, (target.resources[r] || 0) - take);
        attacker.resources[r] = (attacker.resources[r] || 0) + take;
      }
    }
    let destroyedBuilding = null, destroyedBuildingCount = 0;
    // Hyperbomber – einzigartige Tier-2-Fähigkeit „Sprengladungen": je 4 Hyperbomber in der
    // Angriffsflotte wird ein ZUSÄTZLICHES Verteidigungsgebäude zerstört (max +2, also bis zu 3 statt 1).
    // destroyedBuilding bleibt das ERSTE zerstörte (Abwärtskompatibilität der Berichte), Anzahl separat.
    const hbCount = attackerFleetSummary.hyperbomber || 0;
    const buildingHits = 1 + Math.min(2, Math.floor(hbCount / 4));
    for (let hbi = 0; hbi < buildingHits; hbi++) {
      const buildingSets = allBuildingsOf(target);
      const candidates = [];
      for (const b of buildingSets) for (const k of Object.keys(DEFENSE_VALUES)) if ((b[k] || 0) > 0) candidates.push([b, k]);
      if (!candidates.length) break;
      const [b, k] = candidates[Math.floor(Math.random() * candidates.length)];
      b[k] = Math.max(0, b[k] - 1);
      if (!destroyedBuilding) destroyedBuilding = k;
      destroyedBuildingCount++;
    }
    attacker.battlePoints = (attacker.battlePoints || 0) + 25;

    const mySaveVersion = setSaveValue(req.userId, JSON.stringify(attacker));
    setSaveValue(targetUserId, JSON.stringify(target));
    // Der Flottenverlust wird EINGEREIHT, nicht in den fremden Spielstand geschrieben - siehe die
    // ausführliche Begründung bei kampfDetails() weiter oben (der Client des Ziels würde einen
    // direkten Eingriff bei seinem nächsten Auto-Save still zurücknehmen).
    if (defenderLossPct > 0) {
      pushPendingReward(targetUserId, {
        type: 'pvp-fleet-loss',
        pct: defenderLossPct,
        attackerName: req.username,
        at: Date.now()
      });
    }
    // Opfer wurde beraubt ODER hat Schiffe verloren -> Schutzschild gewähren.
    // Die zweite Bedingung ist seit dem Flottenverlust nötig: Ein leergeräumtes Ziel hat keine
    // Beute mehr, wäre ohne sie also ab jetzt unbegrenzt auf reine Schiffszerstörung farmbar -
    // genau das Dauer-Farmen schwächerer Konten, gegen das der Schild eingeführt wurde.
    if (Object.keys(stolen).length > 0 || defenderLossPct > 0) grantAttackShield(targetUserId);
    // Kopfgeld (#2): Wer den aktuellen Kopfgeld-Träger (Bestenlisten-Erster) schlägt, kassiert die Prämie
    // - nur einmal pro Woche, nicht auf sich selbst.
    {
      const gB = loadOrInitGalaxy();
      if (gB.bounty && !gB.bounty.claimed && gB.bounty.targetUserId === targetUserId && req.userId !== targetUserId) {
        gB.bounty.claimed = true; gB.bounty.claimedBy = req.username;
        pushPendingReward(req.userId, { type: 'bounty', targetName: gB.bounty.targetName, credits: gB.bounty.reward });
        pushGalaxyNews('ti-award', 'Kopfgeld kassiert: ' + req.username + ' hat ' + gB.bounty.targetName + ' bezwungen (+' + gB.bounty.reward + ' Kredite).');
      }
    }

    addReport(req.userId, {
      type: 'attack-sent', result: 'win', targetName: targetUser ? targetUser.username : 'Unbekannt',
      attackPower, defensePower, vorratAngriff: vorratAngriff.eingesetzt, vorratVerteidigung: vorratVerteidigung.eingesetzt,
      phasen: phasenErgebnis.phasen, counterMult: effektiverKonter, formation: formationKey, formationMult, stolen, destroyedBuilding, destroyedBuildingCount, defenseBefore, fleet: attackerFleetSummary, defenderFleet: targetFleetSummary, defenderLossPct
    });
    addReport(targetUserId, {
      type: 'attack-received', result: 'loss', attackerName: req.username,
      attackPower, defensePower, vorratAngriff: vorratAngriff.eingesetzt, vorratVerteidigung: vorratVerteidigung.eingesetzt,
      phasen: phasenErgebnis.phasen, counterMult: effektiverKonter, formation: formationKey, formationMult, stolen, destroyedBuilding, destroyedBuildingCount, defenseBefore, fleet: attackerFleetSummary, defenderFleet: targetFleetSummary, defenderLossPct
    });
    // Verteidiger benachrichtigen (Retention-Trigger 21.07.2026): angegriffen zu werden ist einer der
    // stärksten Rückkehr-Anlässe. Server hat den Kampf ohnehin aufgelöst - hier nur der Push obendrauf.
    if (targetUser) { const dPrefs = getNotifPrefs(targetUser); if (dPrefs.enabled && dPrefs.attack) pushNotificationEvent(targetUserId, 'attack-received', { attackerName: req.username, defended: false, looted: Object.keys(stolen).length > 0 }, { skipWebPush: !allowAttackPush(targetUserId) }); }
    await saveDb();
    return res.json({ success: true, stolen, destroyedBuilding, destroyedBuildingCount, attackPower, defensePower, vorratAngriff: vorratAngriff.eingesetzt, vorratVerteidigung: vorratVerteidigung.eingesetzt, saveVersion: mySaveVersion, ...kampfDetails() });
  } else {
    attacker.battlePoints = (attacker.battlePoints || 0) + 3;
    const mySaveVersion = setSaveValue(req.userId, JSON.stringify(attacker));

    // ===== Der erfolgreiche Verteidiger bekommt endlich etwas (02.08.2026) =====
    // Bis hierher war die Belohnungslage grotesk: Der siegreiche Angreifer bekam +25 Kampfpunkte,
    // der GESCHLAGENE Angreifer +3 (Zeile darüber) - und der erfolgreiche Verteidiger nichts.
    // Der Verlierer wurde also besser bezahlt als der Sieger. Es gab im ganzen Spiel keine andere
    // gewonnene Auseinandersetzung ohne Ertrag.
    //
    // Bewusst KOMMANDOPUNKTE statt Kampfpunkte: Kampfpunkte gehen in den Punktestand und damit in
    // die Bestenliste - eine Verteidigung, die den Rang hebt, würde zum Anreiz, sich angreifen zu
    // lassen (und wäre über abgesprochene Angriffe farmbar). Kommandopunkte sind punkteneutral und
    // die Währung, mit der das Spiel den Offiziersausbau bezahlt: Damit steht das Offizierssystem
    // erstmals auch dem Spieler offen, der nie selbst angreift.
    //
    // Die Höhe richtet sich danach, WIE STARK der abgewehrte Angriff im Verhältnis zur eigenen
    // Verteidigung war - eine chancenlose Belästigung bringt das Minimum, ein knapp gescheiterter
    // Großangriff das Maximum. Hart gedeckelt und ausdrücklich NICHT nach dem Muster "N Minuten
    // eigene Produktion" gebaut (CLAUDE.md-Verbot): Die Spanne ist eine feste Zahl, unabhängig
    // davon, wie weit das Konto entwickelt ist.
    const DEFEND_CP_MIN = 5, DEFEND_CP_MAX = 40;
    const abwehrVerhaeltnis = defensePower > 0 ? Math.min(2, attackPower / defensePower) : 0;
    const abwehrCp = Math.round(DEFEND_CP_MIN + (DEFEND_CP_MAX - DEFEND_CP_MIN) * (abwehrVerhaeltnis / 2));
    target.commandPoints = (target.commandPoints || 0) + abwehrCp;
    // Zähler für abgewehrte Spielerangriffe. Er hat von Anfang an einen Abnehmer (die Kampf-Bilanz
    // im Berichte-Reiter zeigt ihn an) - ein Zähler ohne Anzeige wäre nur Ballast im Spielstand.
    target.pvpDefended = (target.pvpDefended || 0) + 1;
    setSaveValue(targetUserId, JSON.stringify(target));
    // Sternenstaub für die erfolgreiche Abwehr (15.08.2026). Der Kampf ist hier gerade
    // SERVERSEITIG ausgewürfelt worden - der Verteidiger konnte ihn weder auslösen noch sein
    // Ergebnis beeinflussen. Genau deshalb taugt er als Quelle, anders als alles, was aus dem
    // Spielstand gemeldet wird. Gegen Absprache zählt je Angreifer nur ein Angriff pro Tag.
    const staubAbwehr = staubAbwehrGutschreiben(targetUser, req.userId);

    addReport(req.userId, {
      type: 'attack-sent', result: 'loss', targetName: targetUser ? targetUser.username : 'Unbekannt',
      attackPower, defensePower, vorratAngriff: vorratAngriff.eingesetzt, vorratVerteidigung: vorratVerteidigung.eingesetzt,
      phasen: phasenErgebnis.phasen, counterMult: effektiverKonter, formation: formationKey, formationMult, defenseBefore, fleet: attackerFleetSummary, defenderFleet: targetFleetSummary
    });
    addReport(targetUserId, {
      // staubReward steht im Bericht, damit die Gutschrift nicht unsichtbar bleibt: Der Verteidiger
      // war beim Kampf per Definition nicht dabei, der Bericht ist seine einzige Quelle.
      type: 'attack-received', result: 'win', attackerName: req.username, defendReward: abwehrCp, staubReward: staubAbwehr,
      attackPower, defensePower, vorratAngriff: vorratAngriff.eingesetzt, vorratVerteidigung: vorratVerteidigung.eingesetzt,
      phasen: phasenErgebnis.phasen, counterMult: effektiverKonter, formation: formationKey, formationMult, defenseBefore, fleet: attackerFleetSummary, defenderFleet: targetFleetSummary
    });
    if (targetUser) { const dPrefs = getNotifPrefs(targetUser); if (dPrefs.enabled && dPrefs.attack) pushNotificationEvent(targetUserId, 'attack-received', { attackerName: req.username, defended: true, looted: false }, { skipWebPush: !allowAttackPush(targetUserId) }); }
    await saveDb();
    return res.json({ success: false, attackPower, defensePower, vorratAngriff: vorratAngriff.eingesetzt, vorratVerteidigung: vorratVerteidigung.eingesetzt, saveVersion: mySaveVersion, ...kampfDetails() });
  }
});

// Störmanöver (Sabotage, Spionage-Vertiefung 20.07.2026): ein Spionagekreuzer stiehlt VERDECKT eine
// kleine, gedeckelte Menge Ressourcen (4-8%, deutlich weniger als der echte Angriff mit 12-25%), ganz
// ohne Flottenkampf - der Erfolg hängt an der Spionageabwehr-Forschung des Ziels, nicht an Flottenstärke.
// Pro Ziel gilt eine 2-Stunden-Abklingzeit gegen Spam. Serverseitig aufgelöst und gehärtet wie /api/attack
// (Beute wird aus dem echten Spielstand berechnet, nie clientseitig gemeldet), inkl. Anti-Farming-Abschlag.
const SABOTAGE_COOLDOWN_MS = 2 * 60 * 60 * 1000;
app.post('/api/sabotage', attackRateLimit, authMiddleware, async (req, res) => {
  const { targetUserId } = req.body || {};
  if (!targetUserId || targetUserId === req.userId) return res.status(400).json({ error: 'Ungültiges Ziel.' });
  // Schutzschild des Ziels respektieren; selbst offensiv werden verwirkt den eigenen Schild.
  const sabShieldLeft = attackShieldRemaining(targetUserId);
  if (sabShieldLeft > 0) return res.status(403).json({ error: 'Ziel steht unter Angriffs-Schutzschild.', shieldMs: sabShieldLeft });
  breakOwnAttackShield(req.userId);
  const attackerRaw = getSaveValue(req.userId);
  const targetRaw = getSaveValue(targetUserId);
  if (!attackerRaw || !targetRaw) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });
  let attacker, target;
  try { attacker = JSON.parse(attackerRaw); target = JSON.parse(targetRaw); }
  catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }
  // Spionagekreuzer nötig - aus dem ECHTEN Spielstand gezählt, nicht dem verschleierten Bestenlisten-Wert.
  const scouts = fleetSummary(attacker).spionageschiff || 0;
  if (scouts < 1) return res.status(400).json({ error: 'Du brauchst mindestens einen Spionagekreuzer für ein Störmanöver.' });
  // Abklingzeit pro Ziel.
  if (!db.private[req.userId]) db.private[req.userId] = {};
  const cds = db.private[req.userId].__sabotageCooldowns || {};
  const cdLeft = Math.max(0, (cds[targetUserId] || 0) + SABOTAGE_COOLDOWN_MS - Date.now());
  if (cdLeft > 0) return res.status(429).json({ error: 'Störmanöver-Abklingzeit gegen dieses Ziel noch aktiv.', cooldownMs: cdLeft });
  // Erfolgschance sinkt mit der Spionageabwehr-Stufe des Ziels (0,85 minus 6% je Stufe, mind. 0,25).
  const shieldLvl = (target.research && target.research.rspyshield) || 0;
  const chance = Math.max(0.25, 0.85 - shieldLvl * 0.06);
  const success = Math.random() < chance;
  cds[targetUserId] = Date.now();
  db.private[req.userId].__sabotageCooldowns = cds;
  const targetUser = findUserById(targetUserId);
  if (success) {
    // Echte Sabotage statt Ressourcenklau (Spieler-Wunsch 21.07.2026): zufällig entweder ein
    // Produktionsgebäude des Ziels 30 Min lang -50% (mineDebuff, vom Client wie die NPC-Sabotage
    // angewendet/angezeigt/reparierbar) ODER die Verteidigung 30 Min lang -30% (defenseSabotage).
    // Wird direkt in den Ziel-Spielstand geschrieben; der Angreifer bekommt keine Beute mehr, nur
    // Kampfpunkte. Keine Ressourcen wechseln den Besitzer.
    const now = Date.now();
    const DUR_MS = 30 * 60 * 1000;
    let effect;
    if (Math.random() < 0.5) {
      // Produktion lahmlegen: ein Kern-Produktionsgebäude wählen, das das Ziel tatsächlich besitzt.
      const prodKeys = ['solar', 'mine', 'raffinerie', 'synth', 'fusionsreaktor'];
      const owned = prodKeys.filter(k => target.buildings && (target.buildings[k] || 0) > 0);
      const key = owned.length ? owned[Math.floor(Math.random() * owned.length)] : 'mine';
      target.mineDebuff = { key, planet: 'home', pct: 0.5, until: now + DUR_MS, sabotage: true };
      effect = { kind: 'production', buildingKey: key, pct: 0.5, durationMin: 30 };
    } else {
      target.defenseSabotage = { pct: 0.3, until: now + DUR_MS, sabotage: true };
      effect = { kind: 'defense', pct: 0.3, durationMin: 30 };
    }
    attacker.battlePoints = (attacker.battlePoints || 0) + 8;
    const mySaveVersion = setSaveValue(req.userId, JSON.stringify(attacker));
    setSaveValue(targetUserId, JSON.stringify(target));
    grantAttackShield(targetUserId); // Opfer erhält Schutzschild gegen weiteres Nachtreten
    addReport(req.userId, { type: 'sabotage-sent', result: 'win', targetName: targetUser ? targetUser.username : 'Unbekannt', effect });
    addReport(targetUserId, { type: 'sabotage-received', result: 'loss', attackerName: req.username, effect });
    if (targetUser) { const prefs = getNotifPrefs(targetUser); if (prefs.enabled && prefs.spy) pushNotificationEvent(targetUserId, 'sabotaged', { fromName: req.username, kind: effect.kind, durationMin: effect.durationMin }); }
    await saveDb();
    return res.json({ success: true, effect, saveVersion: mySaveVersion });
  } else {
    addReport(req.userId, { type: 'sabotage-sent', result: 'loss', targetName: targetUser ? targetUser.username : 'Unbekannt' });
    addReport(targetUserId, { type: 'sabotage-received', result: 'win', attackerName: req.username });
    if (targetUser) { const prefs = getNotifPrefs(targetUser); if (prefs.enabled && prefs.spy) pushNotificationEvent(targetUserId, 'spy-detected', { fromName: req.username, sabotage: true }); }
    await saveDb();
    return res.json({ success: false });
  }
});

// --- Welchen Stand fährt dieser Prozess wirklich? (21.08.2026) ---
// Sieben Deploy-Ausfälle in zwei Wochen, und jedes Mal lief die Eingrenzung von außen über
// dieselbe Bastelei: eine Route suchen, die es im neuen Stand gibt und im alten nicht. Das
// trägt nur, solange ein Merge überhaupt eine neue Route mitbringt - #143 bis #151 brachten
// zusammen KEINE EINZIGE (allein #149-#151 ändern 363 Zeilen in dieser Datei), der Pi-Stand
// war in dieser ganzen Zeit von außen gar nicht messbar. Deshalb nennt der Server ihn selbst.
//
// ZWEI Felder, und der Unterschied zwischen ihnen ist der ganze Zweck:
//   commit   - beim Start EINMAL gelesen, also der Stand, mit dem dieser Prozess läuft.
//   checkout - jetzt von der Platte gelesen, also der Stand, den der letzte Pull hinterließ.
// Laufen sie auseinander, ist der Pull durch und nodemon hat nicht neu gestartet - genau der
// Fall, für den die Doku bisher "docker restart" empfiehlt und den man von außen nicht sehen
// konnte. Sind beide gleich und alt, hängt der Pull selbst.
//
// git wird dafür NICHT aufgerufen: Der Diagnosefall ist ja gerade der, in dem git im Repo
// nicht mehr durchkommt (liegengebliebene Sperrdatei, root-eigene Objekte). Gelesen wird nur
// .git/HEAD - eine Datei, die auch dann noch dasteht. Ein Kurzhash aus einem öffentlichen
// Repo gibt nichts preis, was nicht ohnehin auf GitHub steht.
const GIT_DIR = process.env.KEPLER_GIT_DIR || path.join(__dirname, '.git');
function gitKopf() {
  try {
    let dir = GIT_DIR;
    // .git kann eine DATEI sein (Worktree/Submodul), die auf das echte Verzeichnis zeigt
    if (fs.statSync(dir).isFile()) {
      const zeiger = fs.readFileSync(dir, 'utf8').trim();
      if (!zeiger.startsWith('gitdir:')) return null;
      dir = path.resolve(path.dirname(GIT_DIR), zeiger.slice(7).trim());
    }
    const head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return /^[0-9a-f]{40}$/.test(head) ? head.slice(0, 7) : null;
    const ref = head.slice(4).trim();
    try {
      const hash = fs.readFileSync(path.join(dir, ref), 'utf8').trim();
      if (/^[0-9a-f]{40}$/.test(hash)) return hash.slice(0, 7);
    } catch (e) {}
    // gepackte Referenzen - git räumt lose refs beim gc dorthin weg
    const packed = fs.readFileSync(path.join(dir, 'packed-refs'), 'utf8');
    const zeile = packed.split('\n').find(z => z.endsWith(' ' + ref));
    return (zeile && /^[0-9a-f]{40} /.test(zeile)) ? zeile.slice(0, 7) : null;
  } catch (e) { return null; }
}
const LAUFENDER_COMMIT = gitKopf();
// Der git-Blob-Hash der Datei, die dieser Prozess WIRKLICH ausfuehrt (21.08.2026, nach dem
// achten Deploy-Ausfall). Anlass: Der Arbeitsbaum auf dem Pi war kein "alter Stand", sondern ein
// FLICKENTEPPICH - CLAUDE.md stammte aus #146, server.js aus #145, ein Test aus #143, waehrend
// .git/HEAD unveraendert auf #141 zeigte. `commit` und `checkout` melden in dieser Lage beide
// denselben alten Stand, obwohl der laufende Code ein ganz anderer ist; von aussen sah man nur
// den Widerspruch, dass eine Route antwortete, die es im gemeldeten Commit gar nicht gibt.
// Der Blob loest das auf: Er ist exakt der Wert von `git rev-parse <commit>:server.js`, laesst
// sich also gegen jeden Commit halten, bis einer passt - genau die Analyse, die sonst einen
// SSH-Zugang braucht. Gerechnet wird ueber __filename, also ueber die tatsaechlich geladene
// Datei, nicht ueber einen Pfad aus der Konfiguration.
const LAUFENDE_DATEI = (() => {
  try {
    const roh = fs.readFileSync(__filename);
    return crypto.createHash('sha1').update('blob ' + roh.length + '\0').update(roh).digest('hex').slice(0, 7);
  } catch (e) { return null; }
})();
// Dieselbe Rechnung fuer JEDE eigene Datei, die dieser Prozess geladen hat (28.08.2026). Sie
// beantwortet die Frage, die frueher nodemon beantwortet hat: Laeuft hier noch der Code, der auf
// Platte liegt? Gelesen wird require.cache, also die tatsaechlich geladene Menge - nicht ein
// Verzeichnis-Sweep, der auch Dateien zaehlt, die niemand ausfuehrt. node_modules bleibt draussen:
// Neue Abhaengigkeiten brauchen ohnehin `npm install` und damit einen echten Neustart von Hand.
function eigeneModulHashes() {
  const map = {};
  for (const datei of Object.keys(require.cache)) {
    if (!datei.startsWith(__dirname + path.sep)) continue;
    if (datei.includes(path.sep + 'node_modules' + path.sep)) continue;
    const name = path.relative(__dirname, datei);
    try {
      const roh = fs.readFileSync(datei);
      map[name] = crypto.createHash('sha1').update('blob ' + roh.length + '\0').update(roh).digest('hex').slice(0, 7);
    } catch (e) { map[name] = 'WEG'; }
  }
  return map;
}
const LAUFENDE_MODULE = eigeneModulHashes();
// Welche der geladenen Dateien sich seit dem Start geaendert haben. Eine NEUE Datei taucht hier
// bewusst nicht auf - sie ist noch nicht geladen, und wenn server.js sie braucht, hat sich
// server.js mitgeaendert.
function geaenderteModule() {
  const jetzt = eigeneModulHashes();
  return Object.keys(LAUFENDE_MODULE).filter(name => jetzt[name] !== LAUFENDE_MODULE[name]);
}

// Der Plattenstand wird gepuffert: /api/health ist unauthentifiziert, und ein Dateizugriff je
// Anfrage wäre der einzige Grund, warum ausgerechnet die Diagnoseroute Last erzeugt.
let gitKopfCache = { stand: LAUFENDER_COMMIT, zeit: Date.now() };
function gitKopfJetzt() {
  const jetzt = Date.now();
  if (jetzt - gitKopfCache.zeit < 10000) return gitKopfCache.stand;
  gitKopfCache = { stand: gitKopf(), zeit: jetzt };
  return gitKopfCache.stand;
}

app.get('/api/health', (req, res) => res.json({
  ok: true,
  users: Object.keys(db.users).length,
  commit: LAUFENDER_COMMIT,
  checkout: gitKopfJetzt(),
  blob: LAUFENDE_DATEI,
  uptimeSec: Math.round(process.uptime()),
  // Ob der Container umgebaut ist (nodemon raus, Selbst-Neustart an), war von aussen bisher gar
  // nicht erkennbar - man musste `docker inspect` fahren, also einen SSH-Zugang haben. Genau
  // diese Luecke hatten `commit` und `blob` vorher auch. Der Wert ist ein blankes Ja/Nein und
  // verraet nichts, was nicht ohnehin im oeffentlichen Repo steht.
  // Der Zugriff auf die weiter unten definierte Konstante ist unkritisch: Dieser Rumpf laeuft
  // erst zur Anfragezeit, also lange nach der Modulauswertung (anders als ein Array-Literal, das
  // beim LADEN ausgewertet wird - die Falle, die den Serverstart schon einmal gekostet hat).
  selbstNeustart: DEPLOY_SELBST_NEUSTART
}));

// --- Andere Spieler in einem Sternensystem (für die Sektorkarte) ---
app.get('/api/players-map', authMiddleware, (req, res) => {
  const system = req.query.system;
  if (!system) return res.status(400).json({ error: 'system fehlt.' });
  const players = Object.values(db.users).filter(u => u.homeSystem === system).map(u => {
    let avatarKey = null, score = 0;
    try {
      const raw = getSaveValue(u.userId);
      if (raw) {
        const save = JSON.parse(raw);
        avatarKey = save.player && save.player.avatarKey;
      }
    } catch (e) {}
    try {
      const lb = db.shared['leaderboard:' + u.userId];
      if (lb) score = (JSON.parse(lb).score) || 0;
    } catch (e) {}
    return { userId: u.userId, username: u.username, slot: u.homeSlot, avatarKey, score, isMe: u.userId === req.userId };
  });
  res.json({ players });
});

// --- Nachrichten zwischen Spielern ---
app.get('/api/messages', authMiddleware, (req, res) => {
  const list = (db.private[req.userId] && db.private[req.userId].__messages) || [];
  res.json({ messages: list });
});

app.post('/api/messages', authMiddleware, async (req, res) => {
  const { toUserId, text } = req.body || {};
  const cleanText = String(text || '').trim().slice(0, 500);
  if (!toUserId || !cleanText) return res.status(400).json({ error: 'Empfänger und Nachricht erforderlich.' });
  if (!db.private[toUserId]) db.private[toUserId] = {};
  const list = db.private[toUserId].__messages || [];
  list.unshift({ id: crypto.randomUUID(), time: Date.now(), fromUserId: req.userId, fromName: req.username, text: cleanText });
  db.private[toUserId].__messages = list.slice(0, 60);
  await saveDb();
  const targetUser = findUserById(toUserId);
  if (targetUser) {
    const prefs = getNotifPrefs(targetUser);
    if (prefs.enabled && prefs.messages) pushNotificationEvent(toUserId, 'message', { fromName: req.username });
  }
  res.json({ ok: true });
});

// --- Ausstehende Belohnungen (z.B. Bugfix-Dankeschön) ---
// Bewusst NICHT direkt in den Spielstand (SAVE_KEY) geschrieben: Wäre der Spieler gerade online,
// würde sein nächster normaler Auto-Save (alle 15s, mit dem alten Client-Stand) die Gutschrift
// wieder überschreiben (siehe saveGameStateVersioned-Konfliktlogik weiter unten). Stattdessen liegt
// die Belohnung hier in einer kleinen Warteschlange und wird vom Client selbst beim nächsten Laden
// abgeholt und ganz normal in seinen eigenen state.credits + regulären Speichervorgang eingebaut.
app.get('/api/pending-rewards', authMiddleware, (req, res) => {
  const list = (db.private[req.userId] && db.private[req.userId].__pendingRewards) || [];
  res.json({ rewards: list });
});

// Holt genau eine ausstehende Belohnung ab und entfernt sie dabei sofort aus der Warteschlange
// (atomar innerhalb dieses einen Requests) - dadurch kann derselbe Eintrag nie doppelt geclaimt
// werden, selbst wenn der Client aus irgendeinem Grund zweimal hintereinander abfragt.
app.post('/api/pending-rewards/claim', authMiddleware, async (req, res) => {
  const list = (db.private[req.userId] && db.private[req.userId].__pendingRewards) || [];
  if (!list.length) return res.json({ reward: null });
  const reward = list.shift();
  db.private[req.userId].__pendingRewards = list;
  await saveDb();
  res.json({ reward });
});

// --- Feedback aus dem Spiel: Bugs & Vorschläge ---
// Wird in der DB gesichert (db.feedback, letzte 500) und - falls FEEDBACK_EMAIL gesetzt ist - per
// E-Mail an den Entwickler geschickt. Sanftes Limit: max. 10 Einsendungen pro Spieler und Tag.
const FEEDBACK_IMG_DIR = process.env.FEEDBACK_IMG_DIR || path.join(__dirname, 'feedback-images');
app.post('/api/feedback', authMiddleware, async (req, res) => {
  const { type, text, version, image } = req.body || {};
  const cleanType = type === 'idee' ? 'idee' : 'bug';
  const cleanText = String(text || '').trim().slice(0, 2000);
  if (cleanText.length < 5) return res.status(400).json({ error: 'Bitte beschreibe dein Anliegen etwas ausführlicher.' });
  if (!db.feedback) db.feedback = [];
  const dayAgo = Date.now() - 24*3600*1000;
  const recent = db.feedback.filter(f => f.userId === req.userId && f.time > dayAgo).length;
  if (recent >= 10) return res.status(429).json({ error: 'Limit erreicht: maximal 10 Einsendungen pro Tag - danke für dein Engagement!' });
  const entry = { id: crypto.randomUUID(), time: Date.now(), userId: req.userId, username: req.username, type: cleanType, text: cleanText, version: String(version || '').slice(0, 20) };
  // Optionaler Screenshot: kommt als Daten-URL (jpeg/png, vom Client bereits verkleinert). Wird auf
  // Platte gesichert (nicht in db.json - die bliebe sonst nicht schlank) und an die Mail angehängt.
  let mailAttachment = null;
  if (typeof image === 'string' && image.length > 0) {
    const match = image.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return res.status(400).json({ error: 'Screenshot-Format nicht erkannt (nur JPG/PNG).' });
    if (match[2].length > 1600000) return res.status(400).json({ error: 'Screenshot zu groß - bitte einen kleineren Ausschnitt anhängen.' });
    const ext = match[1] === 'png' ? 'png' : 'jpg';
    const fileName = entry.id + '.' + ext;
    try {
      if (!fs.existsSync(FEEDBACK_IMG_DIR)) fs.mkdirSync(FEEDBACK_IMG_DIR, { recursive: true });
      fs.writeFileSync(path.join(FEEDBACK_IMG_DIR, fileName), Buffer.from(match[2], 'base64'));
      entry.imageFile = fileName;
    } catch (e) { console.error('Screenshot konnte nicht gespeichert werden:', e.message); }
    mailAttachment = { filename: 'screenshot.' + ext, content: match[2] };
  }
  db.feedback.unshift(entry);
  db.feedback = db.feedback.slice(0, 500);
  // Push-Benachrichtigung NUR an den eigenen Account (GameGeeeeek) - andere Spieler/Admins bekommen
  // bei Feedback-Einsendungen keine Push-Nachricht, das ist bewusst kein allianzweites Ereignis.
  // Muss VOR saveDb() passieren, sonst wird die Benachrichtigung nur im Arbeitsspeicher geschrieben
  // und nie tatsächlich persistiert (Bug beim ersten Test hier gefunden und behoben).
  try {
    const devUser = db.users['gamegeeeeek'];
    if (devUser) pushNotificationEvent(devUser.userId, 'feedback-received', { username: req.username, type: cleanType, text: cleanText.slice(0, 150) });
  } catch (e) { console.error('Feedback-Push fehlgeschlagen (Eintrag ist gespeichert):', e.message); }
  await saveDb();
  if (FEEDBACK_EMAIL) {
    try {
      const label = cleanType === 'bug' ? 'Bug-Report' : 'Vorschlag';
      const subject = '[Kepler-7 ' + label + '] von ' + req.username + (entry.version ? ' (v' + entry.version + ')' : '');
      const safeText = cleanText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
      const html = '<h2>' + label + ' aus Kolonie Kepler-7</h2>'
        + '<p><strong>Spieler:</strong> ' + req.username + '<br><strong>Version:</strong> ' + (entry.version || 'unbekannt') + '<br><strong>Zeit:</strong> ' + new Date(entry.time).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }) + '</p>'
        + '<p style="white-space:pre-wrap; border-left:3px solid #7f77dd; padding-left:12px;">' + safeText + '</p>';
      await sendEmail(FEEDBACK_EMAIL, subject, html + (mailAttachment ? '<p><em>Screenshot im Anhang.</em></p>' : ''), label + ' von ' + req.username + ':\n\n' + cleanText, mailAttachment ? [mailAttachment] : null);
    } catch (e) { console.error('Feedback-Mail fehlgeschlagen (Eintrag ist gespeichert):', e.message); }
  }
  res.json({ ok: true });
});

// --- Analytics (13.07.2026, Feature-Wunsch: echte Nutzungsdaten statt reiner Code-Vermutung) ---
// Bewusst selbst gehostet statt Drittanbieter (Google Analytics o.ä.) - keine Daten verlassen den
// eigenen Server. Reine TAGES-AGGREGATE (Zähler pro Ereignistyp + Liste der an diesem Tag aktiven
// User-IDs für die Unique-Zählung) - KEINE Einzelverfolgung von "User X hat um Uhrzeit Y Aktion Z
// gemacht". Automatische Bereinigung nach 60 Tagen, damit die db.json nicht unbegrenzt wächst.
//
// Erweiterung (16.07.2026, Feature-Wunsch: echte 24h-Ansicht im Analytics-Dashboard): zusätzlich zu
// den Tages-Aggregaten jetzt auch STUNDEN-Aggregate (gleiche Struktur, nur feinere Bucket-Größe) -
// bewusst getrennt aufbewahrt statt die Tages-Aggregate abzulösen, da für 7/30-Tage-Ansichten die
// grobe Tages-Auflösung völlig ausreicht und deutlich weniger Speicherplatz braucht. Stunden-Daten
// werden viel aggressiver bereinigt (72 Std. statt 60 Tage) - das reicht für eine 24h-Ansicht plus
// Puffer, hält den zusätzlichen Speicherbedarf aber gering (kein unbegrenztes Wachstum). Prinzip
// bleibt identisch: reine Aggregate, keine Einzelverfolgung einzelner Nutzeraktionen mit Zeitstempel.
function analyticsDateKey(d) { return (d || new Date()).toISOString().slice(0, 10); }
function analyticsHourKey(d) { return (d || new Date()).toISOString().slice(0, 13); } // z.B. "2026-07-16T14"
function pruneOldAnalytics() {
  if (db.analytics && db.analytics.daily) {
    const cutoffDay = Date.now() - 60 * 86400000;
    for (const key of Object.keys(db.analytics.daily)) {
      if (new Date(key + 'T00:00:00Z').getTime() < cutoffDay) delete db.analytics.daily[key];
    }
  }
  if (db.analytics && db.analytics.hourly) {
    const cutoffHour = Date.now() - 72 * 3600000;
    for (const key of Object.keys(db.analytics.hourly)) {
      if (new Date(key + ':00:00Z').getTime() < cutoffHour) delete db.analytics.hourly[key];
    }
  }
}
function recordAnalyticsEvent(userId, eventName) {
  if (!db.analytics) db.analytics = { daily: {}, hourly: {} };
  if (!db.analytics.daily) db.analytics.daily = {};
  if (!db.analytics.hourly) db.analytics.hourly = {};
  const dayKey = analyticsDateKey();
  const hourKey = analyticsHourKey();
  if (!db.analytics.daily[dayKey]) db.analytics.daily[dayKey] = { events: {}, uniqueUsers: [] };
  if (!db.analytics.hourly[hourKey]) db.analytics.hourly[hourKey] = { events: {}, uniqueUsers: [] };
  const day = db.analytics.daily[dayKey];
  const hour = db.analytics.hourly[hourKey];
  day.events[eventName] = (day.events[eventName] || 0) + 1;
  hour.events[eventName] = (hour.events[eventName] || 0) + 1;
  if (userId && !day.uniqueUsers.includes(userId)) day.uniqueUsers.push(userId);
  if (userId && !hour.uniqueUsers.includes(userId)) hour.uniqueUsers.push(userId);
  pruneOldAnalytics();
}
// Absichtlich KEIN await saveDb() bei jedem einzelnen Ereignis - Analytics sind bei einem Server-
// Neustart verschmerzbar zu verlieren (anders als Spielstände), ein Schreibzugriff auf die Festplatte
// bei JEDEM Tab-Wechsel wäre unnötig teuer. Läuft im Speicher mit, wird beim naechsten ohnehin
// anfallenden saveDb() (z.B. durch eine andere Aktion) automatisch mitgespeichert; zusätzlich alle 5
// Minuten ein eigener Sicherungs-Speicherpunkt (siehe setInterval weiter unten).
app.post('/api/analytics/event', authMiddleware, (req, res) => {
  const { event } = req.body || {};
  const cleanEvent = String(event || '').slice(0, 60).replace(/[^a-zA-Z0-9_:.-]/g, '');
  if (!cleanEvent) return res.status(400).json({ error: 'Ereignisname erforderlich.' });
  recordAnalyticsEvent(req.userId, cleanEvent);
  res.json({ ok: true });
});
// Zeitraum-Parameter ersetzt das bisherige starre "days" (13.07.2026-Version) - unterstützt jetzt
// 24h (Stunden-Auflösung, siehe oben), 7d/30d (Tages-Auflösung wie bisher) und all (alles, was noch
// nicht bereinigt wurde, faktisch bis zu 60 Tage zurück). "granularity" im Response sagt dem Frontend,
// ob "label" eine Stunde oder ein Datum ist, ohne dass es range erneut selbst auswerten müsste.
app.get('/api/admin/analytics', authMiddleware, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const range = ['24h', '7d', '30d', 'all'].includes(req.query.range) ? req.query.range : '7d';
  if (range === '24h') {
    const hourly = (db.analytics && db.analytics.hourly) || {};
    const result = [];
    for (let i = 23; i >= 0; i--) {
      const key = analyticsHourKey(new Date(Date.now() - i * 3600000));
      const hour = hourly[key] || { events: {}, uniqueUsers: [] };
      result.push({ label: key, uniqueUsers: hour.uniqueUsers.length, events: hour.events });
    }
    return res.json({ granularity: 'hour', points: result });
  }
  const days = range === '30d' ? 30 : range === 'all' ? 60 : 7;
  const daily = (db.analytics && db.analytics.daily) || {};
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = analyticsDateKey(new Date(Date.now() - i * 86400000));
    const day = daily[key] || { events: {}, uniqueUsers: [] };
    result.push({ label: key, uniqueUsers: day.uniqueUsers.length, events: day.events });
  }
  res.json({ granularity: 'day', points: result });
});

// --- Wiederkehr-Quote / Retention (25.07.2026) ---
// WARUM: Es gab bisher nur "wie viele waren heute da" (DAU). Ohne die Frage "kommen sie WIEDER"
// laesst sich keine einzige Aenderung am Spiel beurteilen - man sieht Ausschlaege, aber nie, ob sie
// etwas getragen haben. Die Rohdaten liegen laengst vor (db.analytics.daily[tag].uniqueUsers),
// es fehlte nur die Auswertung. Deshalb kein neues Tracking, nur eine neue Sicht.
//
// KOHORTEN-ANKER ist user.createdAt (Registrierung), NICHT der erste Analytics-Tag eines Spielers.
// Ueber die Analytics-Tage waere jeder Bestandsspieler faelschlich "neu", sobald die aelteren Tage
// weggeraeumt sind (pruneOldAnalytics haelt 60 Tage) - die Retention saehe kuenstlich gut aus.
//
// EHRLICHKEIT BEI LUECKEN: Wo das 60-Tage-Fenster die Frage nicht beantworten kann, steht null und
// nicht 0. Eine Kohorte von gestern HAT noch keine D7-Quote; sie als "0%" auszuweisen waere eine
// Falschaussage, auf deren Basis man dann Entscheidungen trifft.
const ANALYTICS_WINDOW_DAYS = 60; // muss zu pruneOldAnalytics passen
function activeSetForDay(dayKey) {
  const day = db.analytics && db.analytics.daily && db.analytics.daily[dayKey];
  return new Set((day && day.uniqueUsers) || []);
}
function analyticsWindowStartKey() {
  return analyticsDateKey(new Date(Date.now() - (ANALYTICS_WINDOW_DAYS - 1) * 86400000));
}
app.get('/api/admin/retention', authMiddleware, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const tage = Math.max(7, Math.min(60, parseInt(req.query.days, 10) || 30));
  const heuteKey = analyticsDateKey();
  const fensterStart = analyticsWindowStartKey();

  // Aktive je Tag einmal vorberechnen - sonst wird pro Kohorte erneut ueber die Tabelle gelaufen.
  const aktive = {};
  for (let i = 0; i <= ANALYTICS_WINDOW_DAYS; i++) {
    const k = analyticsDateKey(new Date(Date.now() - i * 86400000));
    aktive[k] = activeSetForDay(k);
  }

  // Registrierungen nach Tag buendeln.
  const kohorten = {};
  let ohneCreatedAt = 0;
  for (const u of Object.values(db.users || {})) {
    if (!u || !u.userId) continue;
    if (!u.createdAt) { ohneCreatedAt++; continue; } // Altkonten von vor der createdAt-Einfuehrung
    const k = analyticsDateKey(new Date(u.createdAt));
    (kohorten[k] = kohorten[k] || []).push(u.userId);
  }

  const quote = (ids, zielKey) => {
    // Liegt der Zieltag in der Zukunft oder ausserhalb des Analytics-Fensters, ist die Frage
    // schlicht nicht beantwortbar - dann null statt einer erfundenen 0.
    if (zielKey > heuteKey) return null;
    if (zielKey < fensterStart) return null;
    const set = aktive[zielKey];
    if (!set) return null;
    let wieder = 0;
    for (const id of ids) if (set.has(id)) wieder++;
    return { wieder, quote: ids.length ? Math.round((wieder / ids.length) * 1000) / 10 : 0 };
  };

  const punkte = [];
  for (let i = tage - 1; i >= 0; i--) {
    const tagKey = analyticsDateKey(new Date(Date.now() - i * 86400000));
    const ids = kohorten[tagKey] || [];
    const plus = n => analyticsDateKey(new Date(new Date(tagKey + 'T00:00:00Z').getTime() + n * 86400000));
    punkte.push({
      tag: tagKey,
      neu: ids.length,
      d1: ids.length ? quote(ids, plus(1)) : null,
      d7: ids.length ? quote(ids, plus(7)) : null
    });
  }

  // Tageshaftung ("kommen die von gestern heute wieder?"). Braucht keine Kohorten und funktioniert
  // deshalb auch fuer Bestandsspieler - in einem kleinen Spiel oft die aussagekraeftigere Zahl.
  const haftung = [];
  for (let i = tage - 1; i >= 1; i--) {
    const vorKey = analyticsDateKey(new Date(Date.now() - i * 86400000));
    const tagKey = analyticsDateKey(new Date(Date.now() - (i - 1) * 86400000));
    const vor = aktive[vorKey], heute = aktive[tagKey];
    if (!vor || !heute || vor.size === 0) { haftung.push({ tag: tagKey, aktiv: heute ? heute.size : 0, wieder: null, quote: null }); continue; }
    let wieder = 0;
    for (const id of vor) if (heute.has(id)) wieder++;
    haftung.push({ tag: tagKey, aktiv: heute.size, wieder, quote: Math.round((wieder / vor.size) * 1000) / 10 });
  }

  // Gesamtbild: wie viele registrierte Konten haben ueberhaupt je gespielt (im Fenster)?
  const jeAktiv = new Set();
  for (const k of Object.keys(aktive)) for (const id of aktive[k]) jeAktiv.add(id);
  const konten = Object.values(db.users || {}).filter(u => u && u.userId).length;

  res.json({
    fenster: { tage: ANALYTICS_WINDOW_DAYS, von: fensterStart, bis: heuteKey },
    konten,
    imFensterAktiv: jeAktiv.size,
    kontenOhneRegistrierungsdatum: ohneCreatedAt,
    kohorten: punkte,
    haftung
  });
});

// --- Spieler melden + Admin-Moderation (13.07.2026, Feature-Wunsch: Moderation vorbereiten) ---
// Admin-Zugriff ist fest auf das eigene Konto beschränkt (analog zum bestehenden Muster bei
// Feedback-Push-Benachrichtigungen an 'gamegeeeeek') - kein eigenes Rollensystem, da es bewusst nur
// einen Admin gibt.
function isAdmin(req) {
  const devUser = db.users['gamegeeeeek'];
  return !!(devUser && req.userId === devUser.userId);
}
app.post('/api/report-player', authMiddleware, async (req, res) => {
  const { targetUsername, reason } = req.body || {};
  const cleanTarget = String(targetUsername || '').trim();
  const cleanReason = String(reason || '').trim().slice(0, 500);
  if (!cleanTarget) return res.status(400).json({ error: 'Zielspieler erforderlich.' });
  if (cleanReason.length < 3) return res.status(400).json({ error: 'Bitte kurz begründen, worum es geht.' });
  const target = db.users[cleanTarget.toLowerCase()];
  if (!target) return res.status(404).json({ error: 'Kein Spieler mit diesem Namen gefunden.' });
  if (!db.playerReports) db.playerReports = [];
  db.playerReports.unshift({
    id: crypto.randomUUID(), time: Date.now(),
    reporterUserId: req.userId, reporterName: req.username,
    targetUserId: target.userId, targetName: target.username,
    reason: cleanReason
  });
  db.playerReports = db.playerReports.slice(0, 500);
  try {
    const devUser = db.users['gamegeeeeek'];
    if (devUser) pushNotificationEvent(devUser.userId, 'player-reported', { reporterName: req.username, targetName: target.username, reason: cleanReason.slice(0, 150) });
  } catch (e) { console.error('Melde-Push fehlgeschlagen (Meldung ist gespeichert):', e.message); }
  await saveDb();
  res.json({ ok: true });
});
app.get('/api/admin/reports', authMiddleware, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const reports = (db.playerReports || []).slice(0, 200).map(r => {
    const target = findUserById(r.targetUserId);
    return { ...r, targetBanned: !!(target && target.banned) };
  });
  res.json({ reports });
});
app.post('/api/admin/set-banned', authMiddleware, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const { targetUsername, banned } = req.body || {};
  const key = String(targetUsername || '').trim().toLowerCase();
  const target = db.users[key];
  if (!target) return res.status(404).json({ error: 'Kein Spieler mit diesem Namen gefunden.' });
  target.banned = !!banned;
  await saveDb();
  res.json({ ok: true, username: target.username, banned: target.banned });
});
app.post('/api/admin/dismiss-report', authMiddleware, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const { reportId } = req.body || {};
  db.playerReports = (db.playerReports || []).filter(r => r.id !== reportId);
  await saveDb();
  res.json({ ok: true });
});

// --- Freunde einladen (13.07.2026, Feature-Wunsch) ---
// Einfaches Referral-System: nutzt den bestehenden Benutzernamen als "Einladungscode" statt eine
// eigene Code-Generierung einzuführen. Einmalig einlösbar pro Konto (save.referralRedeemed), kein
// Eigen-Referral möglich. Muss serverseitig laufen, da hier der Spielstand eines ANDEREN Nutzers
// (des Einladenden) verändert wird - das kann kein Client-seitiger Code manipulationssicher tun.
app.post('/api/referral/redeem', authMiddleware, async (req, res) => {
  const { referrerUsername } = req.body || {};
  const cleanName = String(referrerUsername || '').trim();

  const saveRaw = getSaveValue(req.userId);
  if (!saveRaw) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });
  let save;
  try { save = JSON.parse(saveRaw); } catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }

  if (save.referralRedeemed) return res.status(400).json({ error: 'Du hast bereits einen Einladungs-Bonus eingelöst.' });

  let referrer;
  if (save.referredBy) {
    // Bereits verknüpft (aus einem früheren Aufruf) - Verknüpfung ist fest, referrerUsername aus
    // dieser Anfrage wird ignoriert. Das hier ist ein erneuter Versuch nach einem Level-Aufstieg.
    referrer = db.users[save.referredBy.toLowerCase()];
    if (!referrer) return res.status(404).json({ error: 'Der verknüpfte Einladende existiert nicht mehr.' });
  } else {
    if (!cleanName) return res.status(400).json({ error: 'Name des Einladenden erforderlich.' });
    referrer = db.users[cleanName.toLowerCase()];
    if (!referrer) return res.status(404).json({ error: 'Kein Spieler mit diesem Namen gefunden.' });
    if (referrer.userId === req.userId) return res.status(400).json({ error: 'Du kannst dich nicht selbst einladen.' });
    // Verknüpfung fest speichern - unabhängig davon, ob die Levelschwelle schon erreicht ist.
    save.referredBy = referrer.username;
    setSaveValue(req.userId, JSON.stringify(save));
  }

  const myLevel = commanderLevelFromXp(save.xp || 0);
  if (myLevel < REFERRAL_LEVEL_THRESHOLD) {
    await saveDb();
    return res.json({ ok: true, status: 'pending', referrerName: referrer.username, levelNeeded: REFERRAL_LEVEL_THRESHOLD, currentLevel: myLevel });
  }

  // Levelschwelle erreicht - jetzt tatsächlich auszahlen.
  save.resources = save.resources || {};
  save.resources.erz = (save.resources.erz || 0) + 500;
  save.resources.kristalle = (save.resources.kristalle || 0) + 500;
  save.referralRedeemed = true;
  const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));

  // Bonus für den Einladenden: 50 Kredite. Eigener Spielstand, muss separat geladen/gespeichert
  // werden - schlägt der Lade-/Parse-Vorgang fehl, bekommt der neue Spieler seinen Bonus trotzdem
  // (besser als beide Boni an einem fremden, evtl. beschädigten Spielstand scheitern zu lassen).
  const referrerSaveRaw = getSaveValue(referrer.userId);
  if (referrerSaveRaw) {
    try {
      const referrerSave = JSON.parse(referrerSaveRaw);
      referrerSave.credits = (referrerSave.credits || 0) + 50;
      referrerSave.referralCount = (referrerSave.referralCount || 0) + 1;
      // Werbe-Meilenstein erreicht? -> Extra-Belohnung obendrauf.
      const milestone = referralMilestoneFor(referrerSave.referralCount);
      if (milestone) {
        referrerSave.credits = (referrerSave.credits || 0) + milestone.credits;
        referrerSave.moduleFragments = (referrerSave.moduleFragments || 0) + milestone.fragments;
      }
      setSaveValue(referrer.userId, JSON.stringify(referrerSave));
      try {
        if (milestone) pushNotificationEvent(referrer.userId, 'referral-milestone', { username: req.username, count: referrerSave.referralCount, credits: milestone.credits, fragments: milestone.fragments });
        else pushNotificationEvent(referrer.userId, 'referral-redeemed', { username: req.username });
      } catch (e) {}
    } catch (e) { console.error('Einladungs-Bonus für Einladenden fehlgeschlagen:', e.message); }
  }

  await saveDb();
  res.json({ ok: true, status: 'paid', referrerName: referrer.username, newResources: save.resources, saveVersion: mySaveVersion });
});

// --- Server-Ereignis-Benachrichtigungen: Einstellungen, Postfach, Überfall-Terminierung ---
app.get('/api/notification-prefs', authMiddleware, (req, res) => {
  const user = findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'Konto nicht gefunden.' });
  res.json(getNotifPrefs(user));
});
app.post('/api/notification-prefs', authMiddleware, async (req, res) => {
  const user = findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'Konto nicht gefunden.' });
  const b = req.body || {};
  user.notifPrefs = {
    enabled: b.enabled !== false,
    messages: b.messages !== false,
    pact: b.pact !== false,
    weltboss: b.weltboss !== false,
    raid: b.raid !== false,
    // Muss hier UND in getNotifPrefs() stehen: Diese Route baut die Einstellungen komplett neu auf,
    // ein hier fehlender Schlüssel würde beim ersten Speichern still auf die Vorgabe zurückfallen -
    // der Schalter im Spiel ließe sich dann scheinbar umlegen, ohne Wirkung.
    allianceraid: b.allianceraid !== false,
    alliancebase: b.alliancebase !== false,
    chat: b.chat !== false,
    patchnotes: b.patchnotes !== false,
    application: b.application !== false,
    spy: b.spy !== false,
    attack: b.attack !== false,
    leaderboard: b.leaderboard !== false,
    completion: b.completion !== false,
    neuspieler: b.neuspieler !== false
  };
  await saveDb();
  res.json(getNotifPrefs(user));
});
app.get('/api/notifications', authMiddleware, (req, res) => {
  const list = (db.private[req.userId] && db.private[req.userId].__notificationEvents) || [];
  // `ziel` wird beim Ausliefern berechnet und nicht beim Speichern (02.08.2026): So bekommen auch
  // die Ereignisse ein Ziel, die vor dieser Änderung abgelegt wurden - sonst läge im Postfach jedes
  // Mitglied älteren Datums unanklickbar herum. Kostet nichts (die Liste ist auf 30 Einträge
  // begrenzt) und kann nicht veralten.
  res.json({ notifications: list.map(n => Object.assign({}, n, { ziel: notificationTarget(n.type, n.payload) })) });
});
app.post('/api/notifications/dismiss', authMiddleware, async (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
  if (db.private[req.userId] && db.private[req.userId].__notificationEvents) {
    db.private[req.userId].__notificationEvents = db.private[req.userId].__notificationEvents.filter(n => !ids.includes(n.id));
  }
  await saveDb();
  res.json({ ok: true });
});
// Fertigstellungs-Erinnerungen (Retention, 21.07.2026): Der Client kennt die Endzeiten seiner
// laufenden Aufträge (Forschung, Bau, Expeditionen, Terraforming etc.), der Server nicht. Der Client
// meldet daher die anstehenden Fertigstellungen als Ersatz-Termine (replace-all). Läuft ein Termin
// ab, während der Spieler NICHT online ist (erkannt am lastSeen-Zeitstempel der Bestenliste), schickt
// checkCompletionReminders() eine Push-Benachrichtigung. Nur Zeitstempel + Typ, keine sensiblen Daten.
const VALID_REMINDER_TYPES = new Set(['research', 'construction', 'expedition', 'mission', 'terraform', 'exotic', 'veteran']);
const REMINDER_MAX = 10;
const REMINDER_MAX_HORIZON_MS = 14 * 24 * 3600 * 1000; // keine Termine weiter als 14 Tage in der Zukunft
app.post('/api/reminders', authMiddleware, async (req, res) => {
  const inList = Array.isArray((req.body || {}).reminders) ? req.body.reminders : [];
  const now = Date.now();
  const clean = [];
  for (const r of inList) {
    if (!r || typeof r !== 'object') continue;
    const type = String(r.type || '');
    const endTime = Number(r.endTime);
    if (!VALID_REMINDER_TYPES.has(type)) continue;
    if (!Number.isFinite(endTime) || endTime <= now || endTime > now + REMINDER_MAX_HORIZON_MS) continue;
    clean.push({ type, endTime });
    if (clean.length >= REMINDER_MAX) break;
  }
  if (!db.private[req.userId]) db.private[req.userId] = {};
  db.private[req.userId].__reminders = clean;
  await saveDb();
  res.json({ ok: true, count: clean.length });
});
// Client meldet eine bevorstehende NPC-Überfall-Erkennung an (rein lokal berechnet, der Server
// bekäme sonst nie etwas davon mit). Ein aktiver Alarm je Spieler, überschreibt einen alten.
app.post('/api/schedule-raid-alert', authMiddleware, async (req, res) => {
  const fireAt = Number((req.body || {}).fireAt);
  if (!fireAt || fireAt < Date.now()) return res.status(400).json({ error: 'Ungültiger Zeitpunkt.' });
  if (!db.private[req.userId]) db.private[req.userId] = {};
  db.private[req.userId].__raidAlert = { fireAt, planet: (req.body || {}).planet || null };
  await saveDb();
  res.json({ ok: true });
});

app.get('/api/push/public-key', (req, res) => {
  res.json({ publicKey: VAPID_KEYS.publicKey });
});
// Allowlist bekannter Web-Push-Dienst-Domains (20.07.2026, Security-Audit-Fund): sendWebPushToUser()
// schickt später eine echte serverseitige HTTP-Anfrage genau an die hier registrierte endpoint-URL
// (siehe webpush.sendNotification()). Ohne Prüfung könnte ein Spieler eine beliebige interne/private
// Adresse (z.B. im LAN des Pi) als "Push-Endpoint" hinterlegen und den Server per Benachrichtigung
// (z.B. über /api/schedule-raid-alert) dazu bringen, dorthin zuzugreifen (SSRF). Nur echte
// Browser-Push-Dienste akzeptieren.
const PUSH_ENDPOINT_ALLOWED_HOSTS = [
  'fcm.googleapis.com', 'android.googleapis.com', // Chrome/Edge/Samsung Internet (FCM)
  'updates.push.services.mozilla.com', // Firefox
  'web.push.apple.com' // Safari (macOS/iOS ab 16.4)
];
const PUSH_ENDPOINT_ALLOWED_SUFFIXES = ['.notify.windows.com']; // ältere Edge/Windows-Push-Server (wns#.notify.windows.com)
function isAllowedPushEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch (e) { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (PUSH_ENDPOINT_ALLOWED_HOSTS.includes(host)) return true;
  return PUSH_ENDPOINT_ALLOWED_SUFFIXES.some(suf => host.endsWith(suf));
}
app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
  const sub = req.body || {};
  if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'Ungültiges Push-Abonnement.' });
  }
  if (!isAllowedPushEndpoint(sub.endpoint)) {
    return res.status(400).json({ error: 'Push-Endpoint wird nicht unterstützt.' });
  }
  if (!db.private[req.userId]) db.private[req.userId] = {};
  const subs = db.private[req.userId].__pushSubscriptions || [];
  // Dedupe über den Endpoint (ein Browser/Gerät kann sich mehrfach registrieren, z.B. nach Neuladen).
  const filtered = subs.filter(s => s.endpoint !== sub.endpoint);
  filtered.push({ endpoint: sub.endpoint, keys: sub.keys, addedAt: Date.now() });
  db.private[req.userId].__pushSubscriptions = filtered.slice(-10); // max 10 Geräte je Spieler
  await saveDb();
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', authMiddleware, async (req, res) => {
  const endpoint = (req.body || {}).endpoint;
  if (db.private[req.userId] && db.private[req.userId].__pushSubscriptions) {
    db.private[req.userId].__pushSubscriptions = db.private[req.userId].__pushSubscriptions.filter(s => s.endpoint !== endpoint);
  }
  await saveDb();
  res.json({ ok: true });
});

// --- Healthcheck (13.07.2026, Feature-Wunsch: Vorbereitung auf plötzlichen Ansturm) ---
// Bewusst AUSSERHALB von /api (kein Rate-Limiting, keine Authentifizierung) und ohne teure
// Verarbeitung (kein JSON.parse der ganzen DB) - für externe Monitoring-Dienste wie UptimeRobot
// gedacht, die diesen Endpunkt alle paar Minuten anfragen und bei Ausfall (kein 200 OK / Timeout)
// automatisch benachrichtigen. Prüft nur, ob der Prozess antwortet und die DB-Datei grundsätzlich
// existiert/lesbar ist.
app.get('/health', (req, res) => {
  let dbOk = false;
  try { dbOk = fs.existsSync(DB_FILE) && fs.statSync(DB_FILE).size > 0; } catch (e) {}
  const status = dbOk ? 200 : 503;
  res.status(status).json({ ok: dbOk, uptimeSec: Math.round(process.uptime()), time: new Date().toISOString() });
});

const httpServer = app.listen(PORT, () => {
  console.log('Kepler-7 Server läuft auf Port ' + PORT);
  // Läuft bei jedem Start, tut aber nur beim ersten Mal etwas (siehe `braucht`-Prüfung darin) -
  // eine Migration, die man von Hand anstoßen muss, wird auf einem Pi ohne Wartungsfenster nie
  // angestoßen.
  try { kofiSupporterMigration(); } catch (e) { console.error('[kofi-migration] fehlgeschlagen:', e.message); }
});

// --- Sauberes Herunterfahren: bei Neustart/Stop ausstehende In-Memory-Änderungen flushen ---
// Ohne dies gehen bei jedem Neustart bis zu 5 Minuten (Intervall des periodischen saveDb) an nur im
// RAM gehaltenen Daten verloren - v.a. Analytics (die bewusst nicht pro Event gespeichert werden) und
// alles seit dem letzten saveDb. Passiert real bei JEDEM Deploy: nodemon startet bei Code-Änderungen
// im Bind-Mount per SIGUSR2 neu, ein `docker restart`/`docker stop` sendet SIGTERM. Hier wird jeweils
// einmal die DB auf Platte geschrieben, bevor der Prozess endet.
let shutdownFlush = null;
function flushBeforeExit() {
  // saveDb() reiht sich in die Write-Chain ein und liefert ein Promise, das erst nach dem
  // vollständigen atomaren Schreiben (tmp -> rename) auflöst. Nur einmal pro Shutdown starten.
  if (!shutdownFlush) {
    shutdownFlush = saveDb().catch(e => console.error('Flush beim Herunterfahren fehlgeschlagen:', e));
  }
  return shutdownFlush;
}
async function handleTerminate(signal) {
  console.log(signal + ' empfangen - flushe DB und beende...');
  httpServer.close(); // keine neuen Verbindungen mehr annehmen
  await flushBeforeExit();
  process.exit(0);
}
process.on('SIGTERM', () => handleTerminate('SIGTERM'));
process.on('SIGINT', () => handleTerminate('SIGINT'));
// nodemon signalisiert einen Neustart per SIGUSR2. Wir flushen erst und lösen das Signal danach erneut
// aus (Handler ist per `once` schon entfernt), damit nodemon seinen Neustart wie gewohnt durchführt -
// dieser Prozess darf sich hier NICHT selbst per process.exit beenden, sonst bleibt nodemon hängen.
process.once('SIGUSR2', async () => {
  console.log('SIGUSR2 (nodemon-Neustart) - flushe DB...');
  await flushBeforeExit();
  process.kill(process.pid, 'SIGUSR2');
});

// ============ Lebendige Galaxie: gemeinsame Hintergrund-Simulation ============
// Läuft permanent im Backend-Prozess (setInterval), unabhängig davon ob gerade ein Spieler online
// ist. Alle Spieler sehen denselben Zustand über GET /api/galaxy. Persistiert in db.galaxy, über
// dieselbe saveDb()-Mechanik wie alles andere.
const GALAXY_TICK_MS = 15 * 60 * 1000; // alle 15 Minuten
const NPC_FACTION_NAMES = ['Void-Marodeure', 'Piratenflotte', 'Aschen-Kartell', 'Rote Klaue', 'Schattenbund', 'Eisenlegion'];
const ALIEN_RACE_NAMES = ['Kryll-Schwarm', 'Xantheer-Kollektiv', 'Nomaden von Vex', 'Die Verglühten'];

// ============ Geteilter galaktischer Marktplatz ============
// Handelbare Ressourcen mit ihrem "Normalpreis" (Referenzwert in einer abstrakten Kreditwährung).
// forschungspunkte sind bewusst NICHT handelbar (nicht als Ware gedacht). Der aktuelle Preis jeder
// Ressource lebt in db.galaxy.market[key] und bewegt sich um diesen Normalpreis: Käufe treiben ihn
// hoch, Verkäufe drücken ihn, und im galaxyTick driftet er langsam zum Normalwert zurück. Alle Spieler
// teilen sich denselben Markt.
// Balance-Wunsch 13.07.2026: Basispreise verdoppelt (Markt war zu günstig). Die Preisbewegung
// (Slippage) selbst war entgegen meiner ersten (fehlerhaften) Einschätzung bereits gut kalibriert -
// die Formel unten multipliziert MARKET_IMPACT_PER_1000 zusätzlich mit dem Basispreis der Ressource,
// das hatte ich bei meiner ersten Abschätzung übersehen. Ein 50.000-Einheiten-Trade bewegte den Preis
// mit dem ursprünglichen Wert bereits um ~75% der gesamten Spanne - spürbare Reibung, kein "fast
// kostenloses" Großhandeln. Deshalb NICHT verändert, nur die Basispreise wurden angepasst.
// Weiterer Balance-Wunsch (13.07.2026): Minimum-Preise deutlich tiefer gesetzt (~15% des Basispreises
// statt ~35%) - wer zu viel verkauft, soll den Preis richtig weit drücken können, nicht nur moderat.
// Tier-2-Ressourcen waren vom 19.07. bis 20.07.2026 kurzzeitig handelbar (Tier-2-Konzept Block 4,
// mit 60x-Slippage und serverseitigen Tages-Kauflimits) und wurden auf Sascha-Entscheidung wieder
// KOMPLETT entfernt: Tier-2 soll ausschließlich aus den eigenen Fabriken kommen, auch nicht in
// kleinen Mengen kaufbar sein. Der Handels-Endpunkt lehnt unbekannte Ressourcen ohnehin als
// 'nicht handelbare Ressource' ab - Entfernen aus dieser Tabelle genügt. Eventuelle Alt-Einträge
// in db.galaxy.market/db.marketTier2Buys bleiben als tote Daten liegen (werden nirgends mehr
// gelesen), gekaufte Bestände bleiben den Spielern erhalten.
const MARKET_RESOURCES = {
  erz:        { basePrice: 2.0,  min: 0.3,  max: 6.0 },
  kristalle:  { basePrice: 3.2,  min: 0.5,  max: 9.0 },
  deuterium:  { basePrice: 4.8,  min: 0.7,  max: 14.0 },
  energie:    { basePrice: 2.4,  min: 0.35, max: 7.0 },
  antimaterie:{ basePrice: 24.0, min: 3.5,  max: 80.0 }
};
// Wie stark eine gehandelte Menge den Preis bewegt (pro 1000 Einheiten, zusätzlich mit dem
// Basispreis der Ressource multipliziert - siehe Formel im Handels-Endpunkt). Käufe +, Verkäufe −.
const MARKET_IMPACT_PER_1000 = 0.04;
// Tagesumsatz-Deckel fuer VERKAUFSERLOESE (17.08.2026, Auftrag Sascha). Der Anlass, komplett
// durchgemessen: 400 Mio Erz liessen sich in ~6 Minuten fuer 66 Mio Credits verkaufen - die
// Slippage schuetzt nur die ERSTE Tranche (eine einzige 1-Mio-Tranche drueckt den Preis um 80
// Punkte auf den Boden 0,30, wo er fuer alle 399 weiteren bleibt), und 66 Mio Credits sind im
// Credit-Shop 16.500 Modulfragmente = 206 legendaere Module auf einen Schlag. Das strukturelle
// Problem ist dasselbe wie bei der Protomaterie-Entscheidung (Frontend-CLAUDE.md, Regel 41):
// Rohstoffe skalieren mit dem Imperium, die Modulwirtschaft nicht - jeder ungedeckelte Kanal
// dazwischen bricht, egal wie der Preis modelliert ist. Der Deckel sitzt deshalb an der QUELLE
// der Credits, nicht an einem der Abnehmer. Er zaehlt nur VERKAUFS-Erloese; Kaeufe bleiben frei
// (die vernichten Credits, sie erzeugen keine). Gefuehrt wird er serverautoritativ am
// user-Objekt (user.marktTag, Muster user.staub) - der Spielstand scheidet aus, der ist
// klientenautoritativ und beim naechsten regulaeren Speichern ueberschrieben.
const MARKT_TAGES_ERLOES_MAX = 5000000;
// Markt-Vertiefung (20.07.2026): Preisverlauf + Angebots-/Nachfrageschock-Ereignisse. Labels/Namen hier
// zentral, damit die galaktische News dieselbe Bezeichnung nutzt wie der Client.
const MARKET_RES_LABELS = { erz:'Erz', kristalle:'Kristalle', deuterium:'Deuterium', energie:'Energie', antimaterie:'Antimaterie' };
const MARKET_EVENT_SHORTAGE_NAMES = ['{res}-Knappheit', 'Lieferengpass bei {res}', 'Run auf {res}'];
const MARKET_EVENT_GLUT_NAMES = ['{res}-Schwemme', 'Überproduktion von {res}', '{res}-Ausverkauf'];
const MARKET_HISTORY_LEN = 24;            // ~6h Verlauf bei 15-Min-Ticks
const MARKET_EVENT_CHANCE = 0.04;         // pro Tick, solange kein Ereignis aktiv (~1 alle 6h)
const MARKET_EVENT_DRIFT_RATE = 0.08;     // Erholungstempo Richtung Schock-Ziel (unabhängig von der Richtung)
function loadOrInitMarket(g) {
  if (!g.market) g.market = {};
  for (const [key, info] of Object.entries(MARKET_RESOURCES)) {
    if (typeof g.market[key] !== 'number') g.market[key] = info.basePrice;
  }
  return g.market;
}
function clampMarketPrice(key, price) {
  const info = MARKET_RESOURCES[key];
  return Math.max(info.min, Math.min(info.max, price));
}

function loadOrInitGalaxy() {
  if (!db.galaxy) {
    db.galaxy = {
      npcEmpireStrength: 1.0,
      marketTrend: 1.0,
      activePirateFaction: { name: NPC_FACTION_NAMES[0], system: pickRandomFreeSystem() },
      unlockedAlienRaces: [],
      activeWar: null,
      collapsedSystems: {},
      activeWormhole: null,
      news: [],
      lastTick: Date.now()
    };
  }
  // Migration für Bestandsdaten (falls Felder aus einer älteren Version fehlen oder noch das alte,
  // ortlose Format haben - activePirateFaction/unlockedAlienRaces waren zuerst nur Namen ohne Ort).
  if (db.galaxy.npcEmpireStrength === undefined) db.galaxy.npcEmpireStrength = 1.0;
  if (db.galaxy.marketTrend === undefined) db.galaxy.marketTrend = 1.0;
  if (typeof db.galaxy.activePirateFaction === 'string') {
    db.galaxy.activePirateFaction = { name: db.galaxy.activePirateFaction, system: pickRandomFreeSystem() };
  } else if (!db.galaxy.activePirateFaction) {
    db.galaxy.activePirateFaction = { name: NPC_FACTION_NAMES[0], system: pickRandomFreeSystem() };
  }
  if (!db.galaxy.unlockedAlienRaces) db.galaxy.unlockedAlienRaces = [];
  db.galaxy.unlockedAlienRaces = db.galaxy.unlockedAlienRaces.map(r => typeof r === 'string' ? { name: r, system: pickRandomFreeSystem() } : r);
  // Die Nester (Phase 3). Ein Bestand ohne diese Felder ist der Normalfall, nicht der Sonderfall -
  // sie entstehen erst, wenn NEST_SPAWN_AKTIV an ist.
  if (!Array.isArray(db.galaxy.alienNester)) db.galaxy.alienNester = [];
  if (!db.galaxy.alienPause || typeof db.galaxy.alienPause !== 'object') db.galaxy.alienPause = {};
  // Die wandernden Beute-Ziele (A2, Wrackkonvois). Wie die Nester: leerer Normalfall, entsteht erst
  // mit A2_SPAWN_AKTIV. Liegt in db.galaxy, weil das ueber PUT /api/storage gar nicht schreibbar ist
  // (kein offener Shared-Storage) und galaxyFuerClient() alles aus db.galaxy automatisch lesend
  // an den Client schickt.
  if (!Array.isArray(db.galaxy.wrackKonvois)) db.galaxy.wrackKonvois = [];
  if (db.galaxy.activeWar === undefined) db.galaxy.activeWar = null;
  if (!db.galaxy.collapsedSystems) db.galaxy.collapsedSystems = {};
  if (db.galaxy.activeWormhole === undefined) db.galaxy.activeWormhole = null;
  if (!db.galaxy.news) db.galaxy.news = [];
  if (!db.galaxy.lastTick) db.galaxy.lastTick = Date.now();
  if (!db.galaxy.controlledSystems) db.galaxy.controlledSystems = {}; // systemId -> userId (vom Spieler eroberte Systeme)
  delete db.galaxy.worldBoss;   // vestigial, siehe Kommentar bei galaxyTick (18.08.2026)
  if (!db.galaxy.marketHistory) db.galaxy.marketHistory = {}; // key -> rollender Preisverlauf (Sparkline)
  if (db.galaxy.marketEvent === undefined) db.galaxy.marketEvent = null; // aktiver Angebots-/Nachfrageschock
  loadOrInitMarket(db.galaxy);
  loadOrInitFactions(db.galaxy);
  return db.galaxy;
}

// ============ Galaktischer Weltboss: ENTFERNT (18.08.2026) ============
// Hier stand bis heute ein ZWEITER Weltboss - `db.galaxy.worldBoss`, gespawnt vom galaxyTick, mit
// eigenem HP-Pool, eigenem Archetyp, eigener Ablauffrist und einem echten Ort aus
// pickRandomFreeSystem(). Er wurde NIRGENDS gelesen: nur angelegt, angekündigt und wieder
// abgeräumt. Sein gesamter Effekt waren zwei Galaxie-Nachrichten.
//
// Der ANGREIFBARE Weltboss ist ein anderes Objekt - db.shared['worldboss:current'] (WORLDBOSS_KEY
// weiter unten), vom Client angelegt und über /api/worldboss/resolve gehärtet. Beide zogen ihre
// Namen aus derselben Fünferliste, hatten aber verschiedene HP-Formeln
// (40000*(1+users*0.4)*hpMult hier gegen 50000*1,6^(Stufe-1) dort). Im Galaxie-Tab stand deshalb
// die Nachricht "… ist bei nyra erschienen! … Gemeinsam bekämpfbar (312.000 HP)" neben einer
// Boss-Karte, die denselben Namen mit einer ganz anderen Zahl und ohne Ort führte. Wer die
// Nachricht las und dann die Karte ansah, fand nichts, was zusammenpasste.
//
// Entfernt statt angeschlossen: Die Anschluss-Variante hätte eine zweite Wahrheit über die
// Weltboss-HP eingeführt, und mit zwei Wahrheiten über dieselbe Größe hat dieses Projekt
// schlechte Erfahrungen. Zwei Zeilen weniger Weltgeschichte sind besser als zwei erfundene.
// Der Zustand wird in loadOrInitGalaxy aus Bestandsdatenbanken gelöscht.

// ============ NPC-Fraktionen mit echtem Territorium ============
// Vier Fraktionen besitzen jeweils eine Menge Systeme, haben eine Militärstärke und expandieren im
// galaxyTick in freie Nachbarsysteme bzw. erobern schwächeren Nachbarn Grenzsysteme ab. Spieler-
// Heimatsysteme sind tabu (werden nie erobert). Der Zustand liegt in db.galaxy.factions.
const FACTION_DEFS = [
  { id: 'void', name: 'Void-Marodeure', color: '#e24b4a' },
  { id: 'kartell', name: 'Aschen-Kartell', color: '#fac775' },
  { id: 'legion', name: 'Eisenlegion', color: '#85b7eb' },
  { id: 'schatten', name: 'Schattenbund', color: '#af7ce6' }
];
function loadOrInitFactions(g) {
  if (!g.factions) {
    const occupied = occupiedSystems();
    // Startsysteme: für jede Fraktion ein freies System als Hauptwelt, möglichst weit gestreut.
    const free = SYSTEMS.filter(s => !occupied.has(s));
    // Deterministisch streuen: nach Kartenposition sortieren und gleichmäßig verteilen.
    const spread = free.slice();
    g.factions = {};
    FACTION_DEFS.forEach((def, i) => {
      const capital = spread.length ? spread[Math.floor(i * spread.length / FACTION_DEFS.length)] : null;
      g.factions[def.id] = {
        id: def.id, name: def.name, color: def.color,
        systems: capital ? [capital] : [],
        strength: 1.0 + Math.random() * 0.5
      };
    });
  }
  // Migration: fehlende Felder auffüllen.
  for (const def of FACTION_DEFS) {
    if (!g.factions[def.id]) g.factions[def.id] = { id: def.id, name: def.name, color: def.color, systems: [], strength: 1.0 };
    if (!Array.isArray(g.factions[def.id].systems)) g.factions[def.id].systems = [];
    if (typeof g.factions[def.id].strength !== 'number') g.factions[def.id].strength = 1.0;
  }
  return g.factions;
}
// Map: systemId -> factionId (welche Fraktion besitzt welches System). Spieler-Heimatsysteme kommen NICHT vor.
function systemOwnershipMap(g) {
  const map = {};
  for (const f of Object.values(g.factions || {})) {
    for (const sys of f.systems) map[sys] = f.id;
  }
  return map;
}
function pushGalaxyNews(icon, text) {
  const g = loadOrInitGalaxy();
  g.news.unshift({ id: crypto.randomUUID(), time: Date.now(), icon, text });
  g.news = g.news.slice(0, 40);
}
// Nie ein System zerstören/besetzen, in dem tatsächlich ein Spieler zuhause ist - gilt für ALLE
// ortsgebundenen Ereignisse (nicht nur Supernova), damit kein Spieler den Eindruck bekommt, sein
// eigenes Heimatsystem sei plötzlich "Piratengebiet" o.ä.
function occupiedSystems() {
  return new Set(Object.values(db.users).filter(u => u.homeSystem).map(u => u.homeSystem));
}
// ===== Die Randkriege: Kontrollpunkte an zwei Fronten (10.08.2026) =============================
//
// Bis hierher bewegte sich Territorium in Spruengen: Expansion nimmt ein System, ein Krieg nimmt
// eines. Dazwischen passiert nichts Sichtbares. Die Randkriege legen eine LANGSAME Groesse darueber:
// je umkaempftem Grenzsystem ein Wert von 0 bis 1000, der sich im Weltentakt bewegt.
//
//    0 ────────── 300 ─────────────────── 700 ────────── 1000
//    Seite B haelt   umkaempft: niemand zieht Nutzen     Seite A haelt
//
// Die breite Mitte ist Absicht: Dem Gegner ein System WEGzunehmen kostet 300 Punkte und ist damit
// ein erreichbares Zwischenziel; es zu HALTEN verlangt 700. Fronten bewegen sich dadurch spuerbar,
// ohne dass Besitz staendig hin- und herkippt.
//
// Die Paarungen stehen fest (FACTION_RIVALS, gespiegelt aus dem Frontend): Kartell gegen Schatten,
// Legion gegen Void. Zwei Fronten statt sechs Paarungen - das haelt die Karte lesbar.
const FACTION_RIVALS = { kartell: 'schatten', schatten: 'kartell', legion: 'void', void: 'legion' };
const RK_FRONT_PAARE = [['kartell', 'schatten'], ['legion', 'void']];
const RK_SYSTEME_JE_FRONT = 5;
const RK_MAX = 1000;
const RK_UNTEN = 300, RK_OBEN = 700;
const RK_TICK_DECKEL = 3;        // hoechstens 3 Kontrollpunkte je System und Weltentakt
const RK_MIN_BEITRAGENDE = 3;    // verschiedene Spieler, damit eine Schwelle faellt
const RK_BEITRAG_FENSTER = 24 * 3600 * 1000;

// Grenzsysteme zwischen zwei Fraktionen: gehalten von einer, angrenzend an die andere. Dieselbe
// Bedingung wie beim Krieg - nur dort verschiebt eine Bewegung wirklich eine Grenze.
function rkGrenzsysteme(g, factions, aId, bId) {
  const a = factions[aId], b = factions[bId];
  if (!a || !b) return [];
  const tabu = new Set([...occupiedSystems(), ...Object.keys(g.controlledSystems || {})]);
  const treffer = [];
  for (const [halter, gegner] of [[a, b], [b, a]]) {
    for (const sys of halter.systems) {
      if (tabu.has(sys) || g.collapsedSystems[sys]) continue;
      if ((SYSTEM_NEIGHBORS[sys] || []).some(nb => gegner.systems.includes(nb))) {
        treffer.push({ sys, halter: halter.id });
      }
    }
  }
  return treffer;
}
function loadOrInitRandkriege(g) {
  if (!g.randkriege) g.randkriege = { fronten: [], stand: 0 };
  if (!Array.isArray(g.randkriege.fronten)) g.randkriege.fronten = [];
  return g.randkriege;
}
// Wie viele verschiedene Konten in den letzten 24 Stunden ueberhaupt gespielt haben. Die Sperre
// gegen das Grosskonto skaliert damit - dasselbe Vorgehen wie bei Wochen- und Saisonliga, die
// ihre Teilnehmerschwellen ebenfalls an der tatsaechlichen Beteiligung ausrichten. Auf einem
// kleinen Server soll eine Front nicht deshalb stillstehen, weil es gar keine drei Spieler gibt.
//
// FEHLER AUS DEM EIGENEN VORLAUF (behoben 10.08.2026): Hier stand `u.lastSeen`. Dieses Feld gibt es
// auf den Benutzerobjekten gar nicht - der Zeitstempel liegt in db.shared['leaderboard:<id>'], und
// jede andere Stelle im Server liest ihn ueber getUserLastSeen(). Die Funktion lieferte deshalb
// IMMER 0, damit war `gebraucht` im Tick auf 1 geklemmt und die staerkste Sperre des ganzen
// Entwurfs - "eine Schwelle faellt nur mit mehreren Konten" - praktisch aus. Der zugehoerige Test
// hat es nicht gemerkt, weil sein Fixture das erfundene Feld einfach mitgesetzt hat: eine Annahme
// gegen sich selbst geprueft. Seit der Behebung liest der Test denselben Weg wie der Server.
function rkAktiveSpieler() {
  const grenze = Date.now() - RK_BEITRAG_FENSTER;
  let n = 0;
  for (const u of Object.values(db.users)) if (getUserLastSeen(u.userId) > grenze) n++;
  return n;
}

// ===== Wie ein Spieler auf die Front wirkt (10.08.2026) =======================================
// Ein Beitrag bewegt NIE sofort einen Kontrollpunkt. Er landet im Puffer seiner Seite und wird erst
// im naechsten Weltentakt gegen den Puffer der Gegenseite ausgeloescht (rkTick, Schritt 3). Wer
// zuletzt klickt, gewinnt dadurch nichts, und ein Ansturm auf die letzte Minute vor dem Takt bringt
// genauso viel wie derselbe Beitrag eine Viertelstunde vorher.
//
// Tagesdegression: die ersten hundert Kriegspunkte je Front und Tag zaehlen voll, die naechsten
// hundert zu 70 %, die dritten zu 40 %, danach nichts mehr. Der wirksame Tagesdeckel je Konto und
// Front ist damit 100 + 70 + 40 = 210 Kriegspunkte, also gut 52 Kontrollpunkte (vier Kriegspunkte
// ergeben einen). Der Entwurf hatte hier "265" stehen - das war schlicht falsch gerechnet und ist
// im Konzeptpapier korrigiert; die Zahl steht jetzt an genau EINER Stelle, naemlich hier.
const RK_TAGESSTUFEN = [[100, 1.0], [100, 0.7], [100, 0.4]];
// Das Bollwerk ist die einzige Handlung, deren Ausgang ohnehin serverseitig faellt (Angriffskraft
// gegen Fraktionsverteidigung in /api/faction/attack). Nur deshalb darf sie schwer wiegen. Alle
// uebrigen Handlungen haengen am clientseitig gefuehrten Spielstand und bekommen bewusst kleine
// Gewichte, statt einer Scheinvalidierung, die keine waere.
const RK_BOLLWERK_ERFOLG = 250;
const RK_BOLLWERK_FEHLSCHLAG = 60;

// Bewusst mehrzeilig: Der Testextraktor schneidet Funktionen bis zur ersten Zeile, die nur aus `}`
// besteht - eine Einzeiler-Funktion wuerde die naechste mitverschlucken.
// ===== Dienstgrade, Frontmarken, Wochendeckel (10.08.2026) ====================================
// Die sechs Handlungen zahlen Kriegspunkte an die Front. Sie erzeugen aber bisher nichts, was ueber
// den einzelnen Frontabschnitt hinaus BLEIBT - und ein Balken, der irgendwann kippt, ist als
// einziges Langzeitziel duenn. Zwei Groessen kommen deshalb dazu, beide serverseitig gefuehrt:
//
//   DIENSTPUNKTE je Fraktion (rk.dienst[userId][fid]) - die Lebenszeitsumme aller WIRKSAMEN
//   Kriegspunkte, die ein Konto fuer diese Fraktion beigetragen hat. Sie wird nie zurueckgesetzt.
//   Daraus faellt der Dienstgrad, sechs Stufen.
//
//   FRONTMARKEN (rk.marken[userId]) - eine Waehrung mit WOCHENdeckel. Sie ist der Grund, ueberhaupt
//   weiterzumachen, wenn die Front gerade steht.
//
// WARUM IN db.galaxy UND NICHT IN db.private: Beides ist wertvoll und darf vom Client nicht
// beschreibbar sein. db.galaxy wird von keinem Request-Body angefasst. Der private Bereich war es
// bis heute ebenfalls nicht - genau das hat sich als falsch herausgestellt (siehe die '__'-Sperre
// in PUT /api/storage/:key); der Weltzustand ist der prinzipiell richtige Ort und braucht kein
// zusaetzliches Vertrauen in eine Praefix-Regel.
//
// Die Schwellen stehen bewusst hoch. Ein Konto kann an EINER Front hoechstens 210 wirksame Punkte
// am Tag beitragen (Tagesdegression), der Marschall bei 11.000 ist damit rund zweiundfuenfzig Tage
// taeglichen Beitragens fuer EINE Fraktion. Das Konzeptpapier nannte 25/75/175/350/650/1100 - diese
// Zahlen waeren in weniger als einem Tag durchlaufen gewesen; korrigiert und im Papier vermerkt.
const RK_DIENSTGRADE = [
  { nr: 1, key: 'melder',     name: 'Melder',              schwelle: 250 },
  { nr: 2, key: 'feldwacht',  name: 'Feldwacht',           schwelle: 750 },
  { nr: 3, key: 'grenzwacht', name: 'Grenzwächter',        schwelle: 1750 },
  { nr: 4, key: 'hauptmann',  name: 'Frontenhauptmann',    schwelle: 3500 },
  { nr: 5, key: 'oberst',     name: 'Frontoberst',         schwelle: 6500 },
  { nr: 6, key: 'marschall',  name: 'Marschall der Ränder', schwelle: 11000 }
];
// Eine Frontmarke je 200 wirksame Kriegspunkte, hoechstens zwoelf in der Woche. Ein Konto, das an
// beiden Fronten taeglich ausschoepft, kommt auf rund 420 wirksame Punkte am Tag und damit nach gut
// fuenf Tagen an den Wochendeckel - wer gelegentlich beitraegt, sammelt drei bis sechs.
const RK_MARKE_JE_PUNKTE = 200;
const RK_MARKEN_WOCHE = 12;
// Das Frontlager. Hier stehen nur PREIS und Dienstgrad-Schranke; WAS ein Posten gibt, weiss allein
// das Frontend (FRONT_LAGER). Der Server muss den Inhalt nicht kennen, um die Waehrung zu
// schuetzen - und eine zweite Katalogkopie waere genau die Doppelpflege, vor der die Hausregeln
// warnen. Geprueft wird die Uebereinstimmung in tests/test_randkriege_dienstgrade.js.
const RK_LAGER = {
  depot:      { kosten: 2,  grad: 1 },
  patrouille: { kosten: 3,  grad: 2 },
  peilung:    { kosten: 3,  grad: 3 },
  lazarett:   { kosten: 4,  grad: 3 },
  bergung:    { kosten: 5,  grad: 4 },
  anleihe:    { kosten: 6,  grad: 5 },
  abzeichen:  { kosten: 10, grad: 6 }
};
function rkGradAus(punkte) {
  let treffer = 0;
  for (const g of RK_DIENSTGRADE) if ((punkte || 0) >= g.schwelle) treffer = g.nr;
  return treffer;
}
// Der hoechste Dienstgrad ueber alle Fraktionen. Die Grade selbst sind je Fraktion getrennt - das
// Lager oeffnet aber, sobald man IRGENDWO so weit ist; sonst muesste man sich fuer eine Fraktion
// entscheiden, bevor man weiss, was es dort zu holen gibt.
function rkBesterGrad(rk, userId) {
  const d = (rk.dienst || {})[userId] || {};
  let best = 0;
  for (const fid in d) best = Math.max(best, rkGradAus(d[fid]));
  return best;
}
// Wochenkonto, gebaut wie rkTagesKonto - nur mit serverWeekKey als Stempel. Es zaehlt, wie viele
// Marken in dieser Woche schon verdient wurden; der Bestand selbst liegt daneben in rk.marken und
// wird vom Wochenwechsel NICHT angefasst.
function rkWochenKonto(rk) {
  const woche = serverWeekKey(Date.now());
  if (!rk.woche || rk.woche.stempel !== woche) rk.woche = { stempel: woche, konten: {} };
  if (!rk.woche.konten) rk.woche.konten = {};
  return rk.woche;
}
// Schreibt beides fort. Wird NUR aus rkBeitrag heraus aufgerufen, unmittelbar nachdem der Beitrag
// wirklich im Puffer gelandet ist - eine zweite Aufrufstelle waere die naechste Doppelbuchung.
function rkGutschrift(rk, userId, seiteId, wirksam) {
  if (!(wirksam > 0)) return;
  if (!rk.dienst) rk.dienst = {};
  const d = rk.dienst[userId] || (rk.dienst[userId] = {});
  d[seiteId] = (d[seiteId] || 0) + wirksam;

  const w = rkWochenKonto(rk);
  const k = w.konten[userId] || (w.konten[userId] = { marken: 0, rest: 0 });
  if (k.marken >= RK_MARKEN_WOCHE) return;   // am Deckel laeuft nichts mehr auf
  k.rest += wirksam;
  while (k.rest >= RK_MARKE_JE_PUNKTE && k.marken < RK_MARKEN_WOCHE) {
    k.rest -= RK_MARKE_JE_PUNKTE;
    k.marken++;
    if (!rk.marken) rk.marken = {};
    rk.marken[userId] = (rk.marken[userId] || 0) + 1;
  }
  // Der Rest wird MITGENOMMEN, nicht verworfen: Wer 199 Punkte beitraegt, hat sie beim naechsten
  // Mal noch. Nur am Wochendeckel bleibt er stehen, sonst spraenge in der neuen Woche sofort eine
  // Marke heraus, die niemand in dieser Woche verdient hat.
  if (k.marken >= RK_MARKEN_WOCHE) k.rest = 0;
}

function rkTagesSchluessel() {
  return new Date().toISOString().slice(0, 10);   // UTC-Tag, damit der Schnitt fuer alle gleich faellt
}
function rkTagesKonto(rk) {
  const heute = rkTagesSchluessel();
  if (!rk.tag || rk.tag.stempel !== heute) rk.tag = { stempel: heute, konten: {} };
  if (!rk.tag.konten) rk.tag.konten = {};
  return rk.tag;
}
// Wirksame Punkte aus rohen, gegeben was das Konto heute an dieser Front schon beigetragen hat.
// Rein rechnend, ohne Zustand - deshalb einzeln pruefbar.
function rkDegression(bisher, roh) {
  let rest = roh, ab = Math.max(0, bisher), wirksam = 0;
  for (const [breite, faktor] of RK_TAGESSTUFEN) {
    if (rest <= 0) break;
    const belegt = Math.min(breite, ab);
    ab -= belegt;
    const nimm = Math.min(rest, breite - belegt);
    wirksam += nimm * faktor;
    rest -= nimm;
  }
  return wirksam;
}
// Welcher Frontabschnitt bekommt den Beitrag? Erste Wahl ist das System, an dem der Spieler wirklich
// gehandelt hat. Fehlt es (weil er es gerade selbst erobert hat und es damit aus der Front faellt),
// geht der Beitrag an den Abschnitt, an dem die eigene Seite dem naechsten Schritt am naechsten ist -
// so verfaellt kein Beitrag stillschweigend. Steht die eigene Seite ueberall schon oben, stuetzt er
// den schwaechsten Abschnitt.
function rkZielEintrag(front, seiteId, opt) {
  const o = opt || {};
  const kandidaten = (front.systeme || []).filter(e => e.sys !== o.ausserSys);
  if (!kandidaten.length) return null;
  if (o.wunschSys) {
    const treffer = kandidaten.find(e => e.sys === o.wunschSys);
    if (treffer) return treffer;
  }
  const istA = front.a === seiteId;
  const offen = kandidaten.filter(e => istA ? e.kp < RK_OBEN : e.kp > RK_UNTEN);
  const menge = offen.length ? offen : kandidaten;
  return menge.reduce((best, e) => {
    if (!best) return e;
    if (offen.length) return (istA ? e.kp > best.kp : e.kp < best.kp) ? e : best;
    return (istA ? e.kp < best.kp : e.kp > best.kp) ? e : best;
  }, null);
}
// Traegt fuer `seiteId` bei. Gibt zurueck, was wirklich angekommen ist - der Aufrufer soll dem
// Spieler die wirksame Zahl zeigen koennen und nicht die rohe, sonst waere die Degression unsichtbar.
function rkBeitrag(g, seiteId, userId, rohPunkte, opt) {
  if (!userId || !(rohPunkte > 0)) return null;
  const paar = RK_FRONT_PAARE.find(p => p[0] === seiteId || p[1] === seiteId);
  if (!paar) return null;
  const rk = loadOrInitRandkriege(g);
  const front = rk.fronten.find(f => f.a === paar[0] && f.b === paar[1]);
  // Vor dem ersten Weltentakt gibt es die Front noch nicht. Dann gibt es auch nichts zu bewegen -
  // ein Beitrag auf Vorrat waere eine Zahl ohne Ort.
  if (!front || !(front.systeme || []).length) return null;
  const eintrag = rkZielEintrag(front, seiteId, opt);
  if (!eintrag) return null;

  const frontKey = paar[0] + '|' + paar[1];
  const tag = rkTagesKonto(rk);
  const konto = tag.konten[userId] || (tag.konten[userId] = {});
  const bisher = konto[frontKey] || 0;
  const wirksam = Math.round(rkDegression(bisher, rohPunkte));
  konto[frontKey] = bisher + rohPunkte;
  if (wirksam <= 0) return { sys: eintrag.sys, punkte: 0, roh: rohPunkte, tagesSumme: konto[frontKey] };

  if (!eintrag.puffer) eintrag.puffer = { a: 0, b: 0 };
  if (seiteId === front.a) eintrag.puffer.a += wirksam; else eintrag.puffer.b += wirksam;
  // Erst hier wird das Konto als Beitragender gefuehrt - wer nichts Wirksames beitraegt, zaehlt auch
  // nicht fuer die Mehr-Konten-Sperre im Tick.
  if (!eintrag.beitragende) eintrag.beitragende = {};
  eintrag.beitragende[userId] = { seite: seiteId, ts: Date.now() };
  // Dienstpunkte und Frontmarken haengen an genau dieser Stelle - hier ist der Beitrag angekommen.
  // Nicht in den Endpunkten: es gibt zwei davon (Bollwerk und Handlungen), und der naechste haette
  // es vergessen.
  rkGutschrift(rk, userId, seiteId, wirksam);
  return { sys: eintrag.sys, punkte: wirksam, roh: rohPunkte, tagesSumme: konto[frontKey] };
}

// ===== Die fuenf uebrigen Handlungen (10.08.2026) ==============================================
// Das Bollwerk ist server-autoritativ, weil sein Ausgang hier faellt. Die uebrigen Handlungen
// passieren im Client. Statt eine Scheinvalidierung zu bauen, misst der Server sie so, wie es das
// Spiel bei den Fraktionsauftraegen seit dem 26.07.2026 schon tut: ueber die DIFFERENZ eines
// Lebenszeit-Zaehlers im gespeicherten Spielstand. Der Client kann den Zaehler faelschen - aber
// nur in seinem eigenen, dauerhaft gespeicherten Spielstand, und das ist derselbe Vertrauensrahmen
// wie fuer alles andere im Spiel. Er kann die Handlung nicht WIEDERHOLEN, ohne dass der Zaehler
// weiterlaeuft, und genau das ist der Punkt.
//
// DER BASISWERT LIEGT IM PRIVATEN SERVERBEREICH, NICHT IM SPIELSTAND. Stuende er im Save, wuerde
// der Client ihn mitschreiben und die Differenz sich selbst messen. db.private[userId].__rkBasis
// folgt dem etablierten __-Feld-Muster (__lastAttackPush, __lastChatPush, __sabotageCooldowns).
//
// VERWORFENE ALTERNATIVE: Der Server bekommt jede aufgeloeste Expedition ohnehin als Bericht
// (POST /api/reports -> db.private[userId].__reports). Man koennte statt der Save-Differenz die
// Berichte seit einem gemerkten Zeitstempel zaehlen - das braeuchte keine Reset-Erkennung. Dagegen
// spricht: die Liste ist auf 40 Eintraege gedeckelt (addReport), ein Rueckstand ginge also still
// verloren, sie deckt nur eine der fuenf Handlungen ab, und der Bericht wird vom selben Client
// geschickt, ist also kein Stueck vertrauenswuerdiger. Die Save-Differenz bleibt.
const RK_HANDLUNGEN = {
  // einheit = wie viel Zaehlerfortschritt EINE Handlung ist. Bei Konvois ist das ein Kreditbetrag,
  // bei allem anderen ein Stueck.
  aufklaerung: { feld: 'expeditionsCompleted',      einheit: 1,    punkte: 40, name: 'Aufklärungsertrag' },
  fundmeldung: { feld: 'fundmeldungenGesamt',       einheit: 1,    punkte: 45, name: 'Fundmeldung' },
  piratennest: { feld: 'piratennesterGeraeumt',     einheit: 1,    punkte: 30, name: 'geräumtes Piratennest' },
  konvoi:      { feld: 'tradeRouteLifetimeCredits', einheit: 2000, punkte: 25, name: 'umgeleiteter Konvoi' }
};
// Die Nachschubspende ist die einzige der fuenf, die der Server WIRKLICH pruefen kann: Er haelt den
// Spielstand, kann die Rohstoffe darin nachzaehlen und selbst abbuchen - dieselbe Bauform wie beim
// Markt (save.resources[resource] -= amt) und beim Fraktionsangriff, der Flottenverluste
// serverseitig bucht und dem Client die neue saveVersion zurueckgibt.
// Feste Mengen, keine "N Minuten Produktion": Das Muster ist im Projekt als explosiv vermerkt.
const RK_NACHSCHUB_KOSTEN = { erz: 4000, kristalle: 2500, deuterium: 1200 };
const RK_NACHSCHUB_PUNKTE = 60;
const RK_NACHSCHUB_SPERRE_MS = 4 * 3600 * 1000;

function rkBasisVon(userId) {
  if (!db.private[userId]) db.private[userId] = {};
  if (!db.private[userId].__rkBasis) db.private[userId].__rkBasis = {};
  return db.private[userId].__rkBasis;
}
// Wie viele ROHE Kriegspunkte an dieser Front heute ueberhaupt noch etwas bewirken. Alles darueber
// hinaus faellt in die Nullstufe der Degression. Der Wert wird gebraucht, damit ein Rueckstand
// nicht in einem Zug verbrannt wird: Es wird nur so viel Zaehlerfortschritt VERBRAUCHT, wie heute
// noch wirken kann - der Rest bleibt liegen und ist morgen wieder da.
function rkTagesRoh(rk, userId, frontKey) {
  const tag = (rk.tag && rk.tag.stempel === rkTagesSchluessel()) ? rk.tag : null;
  return (tag && tag.konten && tag.konten[userId] && tag.konten[userId][frontKey]) || 0;
}
function rkNochNutzbar(rk, userId, frontKey) {
  const breite = RK_TAGESSTUFEN.reduce((a, st) => a + st[0], 0);
  return Math.max(0, breite - rkTagesRoh(rk, userId, frontKey));
}
// Was ein Beitrag HEUTE noch brächte, ohne ihn zu buchen. Gebraucht, weil rkBeitrag das Tageskonto
// auch dann belastet, wenn nach der Degression nichts mehr uebrig bleibt - eine Nachschubspende
// wuerde sonst 4.000 Erz kosten und null Kriegspunkte bringen. Geprueft wird deshalb VOR jeder
// Handlung, ob wenigstens ein ganzer Punkt herauskommt.
function rkVorschau(rk, userId, frontKey, rohPunkte) {
  return Math.round(rkDegression(rkTagesRoh(rk, userId, frontKey), rohPunkte));
}
function rkFrontKeyFuer(seiteId) {
  const paar = RK_FRONT_PAARE.find(p => p[0] === seiteId || p[1] === seiteId);
  return paar ? paar[0] + '|' + paar[1] : null;
}
// Ein Takt der Front. Reihenfolge ist wichtig:
//   1. ungueltig gewordene Frontsysteme ersetzen (Besitzer gewechselt, kollabiert, Spieler drauf)
//   2. auffuellen, falls die Front noch nicht fuenf Systeme hat
//   3. Puffer beider Seiten gegeneinander AUSLOESCHEN - gleich starke Gegenseiten bewegen nichts
//   4. Grundbewegung aus dem Staerkeverhaeltnis dazu, alles zusammen auf den Tickdeckel klemmen
//   5. Schwellen pruefen
function rkTick(g) {
  const rk = loadOrInitRandkriege(g);
  const factions = loadOrInitFactions(g);
  const aktive = rkAktiveSpieler();
  const jetzt = Date.now();
  rk.stand = jetzt;

  for (const [aId, bId] of RK_FRONT_PAARE) {
    let front = rk.fronten.find(f => f.a === aId && f.b === bId);
    if (!front) { front = { a: aId, b: bId, systeme: [] }; rk.fronten.push(front); }
    const grenze = rkGrenzsysteme(g, factions, aId, bId);
    const gueltig = new Set(grenze.map(x => x.sys));

    // (1) Was keine Grenze mehr ist, faellt raus. Der Wert wandert NICHT mit an ein anderes System -
    // er gehoert zu diesem einen Sektor, und das Ringen darum ist vorbei.
    front.systeme = front.systeme.filter(e => gueltig.has(e.sys));

    // (2) Auffuellen. Die Reihenfolge der Kandidaten ist stabil (Systemliste), damit dieselbe Lage
    // nicht bei jedem Takt eine andere Front ergibt.
    for (const kand of grenze) {
      if (front.systeme.length >= RK_SYSTEME_JE_FRONT) break;
      if (front.systeme.some(e => e.sys === kand.sys)) continue;
      // Startwert: knapp im Besitz dessen, der es haelt - nicht am Anschlag, damit die erste
      // Bewegung sofort sichtbar ist.
      front.systeme.push({ sys: kand.sys, kp: kand.halter === aId ? RK_OBEN + 50 : RK_UNTEN - 50,
        puffer: { a: 0, b: 0 }, beitragende: {} });
    }

    const strA = (factions[aId] || {}).strength || 1;
    const strB = (factions[bId] || {}).strength || 1;
    for (const e of front.systeme) {
      if (!e.puffer) e.puffer = { a: 0, b: 0 };
      if (!e.beitragende) e.beitragende = {};
      // (3) Ausloeschen. Was uebrig bleibt, sind Kriegspunkte; vier davon ergeben einen Kontrollpunkt.
      const netto = (e.puffer.a - e.puffer.b) / 4;
      e.puffer.a = 0; e.puffer.b = 0;
      // (4) Grundbewegung aus dem Staerkeverhaeltnis. Ohne sie stuende jede Front still, solange
      // niemand beitraegt - und der Spieler saehe eine Anzeige, die sich nie ruehrt.
      const grund = Math.max(-1, Math.min(1, (strA - strB) * 0.25));
      const bewegung = Math.max(-RK_TICK_DECKEL, Math.min(RK_TICK_DECKEL, netto + grund));
      const vorher = e.kp;
      e.kp = Math.max(0, Math.min(RK_MAX, e.kp + bewegung));

      // Alte Beitraege aus dem 24-Stunden-Fenster werfen. Format je Eintrag: { seite, ts } - die
      // Seite wird gebraucht, weil die Sperre unten nur die GEWINNENDE Seite zaehlt.
      for (const uid in e.beitragende) {
        const b = e.beitragende[uid];
        if (!b || typeof b !== 'object' || (b.ts || 0) < jetzt - RK_BEITRAG_FENSTER) delete e.beitragende[uid];
      }

      // (5) Schwellen. Geprueft wird nur der UEBERGANG, nicht der Zustand - sonst wuerde bei jedem
      // Takt erneut eine Meldung erzeugt, solange der Wert oben steht.
      const zielId = e.kp >= RK_OBEN && vorher < RK_OBEN ? aId
                   : (e.kp <= RK_UNTEN && vorher > RK_UNTEN ? bId : null);
      if (!zielId) continue;
      const gewinner = factions[zielId], verlierer = factions[zielId === aId ? bId : aId];
      if (!gewinner || !verlierer || !verlierer.systems.includes(e.sys)) continue;
      if (verlierer.systems.length < 2) continue;   // niemand wird von der Karte geloescht

      // Die strukturelle Sperre: Ein Besitzwechsel, an dem Spieler beteiligt waren, braucht
      // MEHRERE. Ein Einzelkonto drueckt bis 699 und bleibt dort stehen.
      //
      // Gezaehlt wird nur die GEWINNENDE Seite. Wuerde man alle Beitragenden zaehlen, koennte ein
      // einzelner Gegner die Front einfrieren, indem er einen einzigen Punkt beitraegt.
      //
      // Und die Schranke skaliert mit der Beteiligung: min(3, aktive Spieler). Auf einem Server mit
      // zwei aktiven Konten soll die Front nicht deshalb stehenbleiben, weil es gar keine drei gibt.
      const aufGewinnerseite = Object.values(e.beitragende).filter(v => v && v.seite === zielId).length;
      const gebraucht = Math.min(RK_MIN_BEITRAGENDE, Math.max(1, aktive));
      const spielerBeteiligt = Object.keys(e.beitragende).length > 0;
      if (spielerBeteiligt && aufGewinnerseite < gebraucht) {
        // Kurz unter der Schwelle festhalten, sonst laeuft der Wert an den Anschlag und die Sperre
        // waere beim naechsten Beitrag sofort wieder ueberschritten.
        e.kp = zielId === aId ? RK_OBEN - 1 : RK_UNTEN + 1;
        continue;
      }
      verlierer.systems = verlierer.systems.filter(x => x !== e.sys);
      gewinner.systems.push(e.sys);
      pushGalaxyNews('ti-flag', gewinner.name + ' hat die Front bei ' + e.sys + ' durchbrochen und das System von ' + verlierer.name + ' übernommen.');
    }
  }
}

// ===== Fraktionskrieg mit echtem Einsatz (10.08.2026) ==========================================
// Vorher war activeWar Kulisse. Diese beiden Funktionen verbinden ihn mit f.systems.
//
// Ein Krieg braucht einen Ort, um den es sich zu streiten LOHNT: ein Grenzsystem, das eine der
// beiden Parteien haelt und das an das Gebiet der anderen grenzt. Nur dann verschiebt ein Sieg die
// Grenze wirklich. Findet sich keine solche Grenze - etwa weil die Gebiete weit auseinanderliegen -,
// gibt es weiterhin das alte Scharmuetzel ohne Einsatz; es faerbt die Galaxie, behauptet aber nichts.
function findWarBorder(g, factions) {
  const occupiedByPlayers = occupiedSystems();
  const controlled = g.controlledSystems || {};
  const tabu = new Set([...occupiedByPlayers, ...Object.keys(controlled)]);
  const ownership = systemOwnershipMap(g);
  const kandidaten = [];
  for (const halter of Object.values(factions)) {
    for (const sys of halter.systems) {
      if (tabu.has(sys) || g.collapsedSystems[sys]) continue;
      // Wer das System haelt, muss noch ein zweites besitzen - sonst wuerde ein verlorener Krieg
      // eine Fraktion von der Karte loeschen, und das Spiel haette drei statt vier.
      if (halter.systems.length < 2) continue;
      for (const nb of (SYSTEM_NEIGHBORS[sys] || [])) {
        const nachbarId = ownership[nb];
        if (!nachbarId || nachbarId === halter.id) continue;
        const angreifer = factions[nachbarId];
        if (!angreifer) continue;
        kandidaten.push({ halter, angreifer, system: sys });
      }
    }
  }
  if (!kandidaten.length) return null;
  return kandidaten[Math.floor(Math.random() * kandidaten.length)];
}
function startFactionWar(g) {
  const factions = loadOrInitFactions(g);
  const grenze = findWarBorder(g, factions);
  if (grenze) {
    g.activeWar = {
      factionA: grenze.angreifer.name, factionB: grenze.halter.name,
      aId: grenze.angreifer.id, bId: grenze.halter.id,
      holderId: grenze.halter.id,
      system: grenze.system, stakes: true,
      expiresAt: Date.now() + 36 * 3600 * 1000
    };
    pushGalaxyNews('ti-sword', grenze.angreifer.name + ' greift ' + grenze.halter.name
      + ' an: Um ' + grenze.system + ' wird gekämpft. Wer das System nach 36 Stunden hält, behält es.');
    return;
  }
  // Rueckfall: keine gemeinsame Grenze. Dann bleibt es beim Scharmuetzel von frueher - aber ohne
  // zu behaupten, es ginge um Besitz.
  const a = NPC_FACTION_NAMES[Math.floor(Math.random() * NPC_FACTION_NAMES.length)];
  let b = NPC_FACTION_NAMES[Math.floor(Math.random() * NPC_FACTION_NAMES.length)];
  if (b === a) b = NPC_FACTION_NAMES[(NPC_FACTION_NAMES.indexOf(a) + 1) % NPC_FACTION_NAMES.length];
  const sys = pickRandomFreeSystem();
  g.activeWar = { factionA: a, factionB: b, system: sys, stakes: false,
    expiresAt: Date.now() + 36 * 3600 * 1000 };
  pushGalaxyNews('ti-sword', 'Krieg ausgebrochen: ' + a + ' und ' + b + ' liefern sich Gefechte um ' + sys + '.');
}
function resolveFactionWar(g) {
  const w = g.activeWar;
  g.activeWar = null;
  if (!w) return;
  if (!w.stakes) {
    pushGalaxyNews('ti-flag', 'Das Gefecht um ' + w.system + ' ist ohne Ergebnis beigelegt.');
    return;
  }
  const factions = loadOrInitFactions(g);
  const angreifer = factions[w.aId], halter = factions[w.bId];
  // Zwischen Kriegsbeginn und Ablauf liegen 36 Stunden. In der Zeit kann sich viel geaendert haben:
  // Der Halter kann das System laengst an eine dritte Fraktion verloren haben, ein Spieler kann es
  // erobert haben, es kann kollabiert sein. Der Ausgang wird deshalb gegen den JETZIGEN Zustand
  // geprueft, nie gegen den beim Kriegsbeginn gemerkten.
  const ownership = systemOwnershipMap(g);
  const jetzigerHalter = ownership[w.system];
  const tabu = new Set([...occupiedSystems(), ...Object.keys(g.controlledSystems || {})]);
  if (!angreifer || !halter || tabu.has(w.system) || g.collapsedSystems[w.system]
      || (jetzigerHalter !== w.aId && jetzigerHalter !== w.bId)) {
    pushGalaxyNews('ti-flag', 'Der Krieg um ' + w.system + ' ist ohne Entscheidung ausgelaufen - '
      + 'die Lage vor Ort hat sich inzwischen geändert.');
    return;
  }
  const verteidiger = factions[jetzigerHalter];
  const herausforderer = jetzigerHalter === w.aId ? halter : angreifer;
  // Der Verteidiger hat einen Standvorteil: Er muss nur halten, der Angreifer muss nehmen. Ohne ihn
  // wechselte fast jedes Grenzsystem bei jedem Krieg den Besitzer, und die Karte fluete.
  const staerkeA = (herausforderer.strength || 1);
  const staerkeV = (verteidiger.strength || 1) * 1.35;
  const chance = staerkeA / (staerkeA + staerkeV);
  if (Math.random() < chance && verteidiger.systems.length >= 2) {
    verteidiger.systems = verteidiger.systems.filter(x => x !== w.system);
    herausforderer.systems.push(w.system);
    pushGalaxyNews('ti-sword', herausforderer.name + ' hat den Krieg um ' + w.system + ' gewonnen und '
      + 'das System von ' + verteidiger.name + ' übernommen.');
  } else {
    pushGalaxyNews('ti-shield', verteidiger.name + ' hat ' + w.system + ' gegen '
      + herausforderer.name + ' gehalten.');
  }
}
function pickRandomFreeSystem() {
  const occupied = occupiedSystems();
  const free = SYSTEMS.filter(s => !occupied.has(s));
  return free.length ? free[Math.floor(Math.random()*free.length)] : SYSTEMS[Math.floor(Math.random()*SYSTEMS.length)];
}
// Ruhmeshalle serverseitig pflegen (#7): Bisher hielt nur der Client den Eintrag des aktuellen Monats
// aktuell (beim Bestenlisten-Laden) - lud in den letzten Stunden vor Monatswechsel niemand die Liste,
// fror ein veralteter Champion ein. Jetzt aktualisiert der galaxyTick (alle 15 Min, auch ohne Online-
// Spieler) den Eintrag des laufenden Monats mit dem tatsächlichen Bestenlisten-Spitzenreiter. Vergangene
// Monate bleiben unangetastet (sie werden nie überschrieben) und frieren am Monatswechsel automatisch auf
// dem letzten Stand ein. Schreibt direkt in db.shared (Server ist autoritativ, keine Permission-Prüfung).
function updateHallOfFameServer() {
  let champion = null;
  for (const k of Object.keys(db.shared)) {
    if (!k.startsWith('leaderboard:')) continue;
    try {
      const v = JSON.parse(db.shared[k]);
      if (!champion || (v.score || 0) > (champion.score || 0)) champion = v;
    } catch (e) {}
  }
  if (!champion) return;
  const thisMonth = new Date().toISOString().slice(0, 7);
  let records = [];
  try { records = db.shared['halloffame:records'] ? JSON.parse(db.shared['halloffame:records']) : []; } catch (e) { records = []; }
  const entry = { month: thisMonth, name: champion.name || 'Unbekannt', allianceTag: champion.allianceTag || '', score: champion.score || 0 };
  const idx = records.findIndex(r => r && r.month === thisMonth);
  if (idx >= 0) {
    // Nur überschreiben, wenn sich wirklich etwas ändert (spart unnötige DB-Writes je Tick).
    const p = records[idx];
    if (p.name === entry.name && p.allianceTag === entry.allianceTag && p.score === entry.score) return;
    records[idx] = entry;
  } else {
    records.push(entry);
  }
  records.sort((a, b) => a.month.localeCompare(b.month));
  records = records.slice(-24);
  db.shared['halloffame:records'] = JSON.stringify(records);
}

// --- Wochenliga serverseitig abrechnen (#6) ---
// Bisher bestimmte jeder CLIENT selbst seine Liga-Platzierung UND zahlte sich die Belohnung aus - beides
// manipulierbar. Jetzt hält der Server für die laufende Woche je Spieler den START-Score (aus der bereits
// serverseitig validierten Bestenliste) und rechnet am Wochenwechsel autoritativ ab: Rang nach echtem
// Punktezuwachs, Liga nach Rang, Belohnung als pending-reward vom Typ 'weekly-league' (der Client wendet
// nur noch die vom Server zugewiesene Liga-Stufe an, siehe claimPendingRewards). Läuft im galaxyTick, also
// auch ohne Online-Spieler exakt am Wochenwechsel.
const WEEKLY_LEAGUE_KEYS = ['platin', 'gold', 'silber', 'bronze'];
function serverWeekKey(ts) {
  const d = new Date(ts);
  const day = (d.getDay() + 6) % 7; // Mo=0 ... So=6
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  return monday.getFullYear() + '-' + String(monday.getMonth() + 1).padStart(2, '0') + '-' + String(monday.getDate()).padStart(2, '0');
}
function leagueIndexForRankServer(rank, total) {
  if (total >= 8) {
    const q = Math.ceil(total * 0.25);
    if (rank <= q) return 0;
    if (rank <= 2 * q) return 1;
    if (rank <= 3 * q) return 2;
    return 3;
  }
  return Math.min(Math.max(0, rank - 1), 3);
}
function pushPendingReward(userId, reward) {
  if (!db.private[userId]) db.private[userId] = {};
  const list = db.private[userId].__pendingRewards || [];
  // Idempotenz: dieselbe Wochenliga-/Saison-Belohnung nie doppelt einreihen.
  if (reward.type === 'weekly-league' && list.some(r => r.type === 'weekly-league' && r.weekKey === reward.weekKey)) return;
  if (reward.type === 'season-league' && list.some(r => r.type === 'season-league' && r.seasonKey === reward.seasonKey)) return;
  reward.id = crypto.randomUUID();
  list.push(reward);
  db.private[userId].__pendingRewards = list.slice(-20);
}
function resolveWeeklyLeagueServer() {
  const g = loadOrInitGalaxy();
  if (!g.weeklyLeague || typeof g.weeklyLeague !== 'object') g.weeklyLeague = { weekKey: null, startScores: {} };
  const wl = g.weeklyLeague;
  if (!wl.startScores || typeof wl.startScores !== 'object') wl.startScores = {};
  const nowKey = serverWeekKey(Date.now());
  // Aktuelle (validierte) Scores der Bestenliste einsammeln.
  const current = {};
  for (const k of Object.keys(db.shared)) {
    if (!k.startsWith('leaderboard:')) continue;
    const uid = k.slice('leaderboard:'.length);
    try { current[uid] = (JSON.parse(db.shared[k]).score) || 0; } catch (e) {}
  }
  if (wl.weekKey === nowKey) {
    // Gleiche Woche: neu aufgetauchte Spieler mit ihrem aktuellen Score als Startwert erfassen.
    for (const uid of Object.keys(current)) if (!(uid in wl.startScores)) wl.startScores[uid] = current[uid];
    return;
  }
  // Wochenwechsel -> Vorwoche abrechnen (nur wenn es eine gab und Teilnehmer existieren).
  if (wl.weekKey) {
    const participants = [];
    for (const uid of Object.keys(wl.startScores)) {
      if (!(uid in current)) continue; // nicht mehr in der Bestenliste
      participants.push({ uid, weekScore: Math.max(0, current[uid] - (wl.startScores[uid] || 0)) });
    }
    if (participants.length) {
      participants.sort((a, b) => b.weekScore - a.weekScore);
      const total = participants.length;
      participants.forEach((p, i) => {
        const league = WEEKLY_LEAGUE_KEYS[leagueIndexForRankServer(i + 1, total)];
        pushPendingReward(p.uid, { type: 'weekly-league', league, rank: i + 1, total, weekKey: wl.weekKey });
      });
      pushGalaxyNews('ti-trophy', 'Wochenliga abgerechnet: ' + total + ' Kommandanten haben um den Aufstieg gekämpft. Belohnungen warten beim nächsten Login.');
    }
  }
  // Neue Woche starten: alle aktuellen Scores als Startwerte festhalten.
  wl.weekKey = nowKey;
  wl.startScores = {};
  for (const uid of Object.keys(current)) wl.startScores[uid] = current[uid];
}

// --- Saison-Liga (langfristiger, prestigeträchtiger Wettbewerbs-Loop) ---
// Wie die Wochenliga, aber über einen KALENDERMONAT und mit exklusiven, dauerhaften Belohnungen
// (Saison-Titel je Liga) statt Ressourcen. Genau derselbe serverautoritative Ablauf: der Server hält
// je Spieler den Start-Score der Saison, rechnet am Monatswechsel nach echtem Punktezuwachs ab, weist
// die Liga nach Rang zu und reiht eine pending-reward vom Typ 'season-league' ein. Läuft im galaxyTick.
const SEASON_LEAGUE_TIERS = ['diamant', 'platin', 'gold', 'silber', 'bronze'];
function serverSeasonKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function seasonEndsAt(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(); // Beginn des Folgemonats
}
function seasonTierForRankServer(rank, total) {
  // Fünf Ligen nach Quintil-Grenzen (20/40/60/80 %). Grenzen einzeln aufgerundet, damit auch bei
  // kleineren Feldern die UNTERSTE Liga (Bronze) erreichbar bleibt statt durch Rundung leerzulaufen.
  if (total < 5) return Math.min(Math.max(0, rank - 1), 4);
  for (let t = 0; t < 4; t++) { if (rank <= Math.ceil(total * (t + 1) / 5)) return t; }
  return 4;
}
function resolveSeasonLeagueServer() {
  const g = loadOrInitGalaxy();
  if (!g.seasonLeague || typeof g.seasonLeague !== 'object') g.seasonLeague = { seasonKey: null, startScores: {} };
  const sl = g.seasonLeague;
  if (!sl.startScores || typeof sl.startScores !== 'object') sl.startScores = {};
  const nowKey = serverSeasonKey(Date.now());
  const current = {};
  for (const k of Object.keys(db.shared)) {
    if (!k.startsWith('leaderboard:')) continue;
    const uid = k.slice('leaderboard:'.length);
    try { current[uid] = (JSON.parse(db.shared[k]).score) || 0; } catch (e) {}
  }
  if (sl.seasonKey === nowKey) {
    for (const uid of Object.keys(current)) if (!(uid in sl.startScores)) sl.startScores[uid] = current[uid];
    return;
  }
  // Saisonwechsel -> Vorsaison abrechnen.
  if (sl.seasonKey) {
    const participants = [];
    for (const uid of Object.keys(sl.startScores)) {
      if (!(uid in current)) continue;
      participants.push({ uid, seasonScore: Math.max(0, current[uid] - (sl.startScores[uid] || 0)) });
    }
    if (participants.length) {
      participants.sort((a, b) => b.seasonScore - a.seasonScore);
      const total = participants.length;
      participants.forEach((p, i) => {
        const tier = SEASON_LEAGUE_TIERS[seasonTierForRankServer(i + 1, total)];
        pushPendingReward(p.uid, { type: 'season-league', tier, rank: i + 1, total, seasonKey: sl.seasonKey });
      });
      const champ = participants[0];
      const champName = (() => { try { return JSON.parse(db.shared['leaderboard:' + champ.uid]).name || 'Unbekannt'; } catch (e) { return 'Unbekannt'; } })();
      pushGalaxyNews('ti-trophy', 'Saison ' + sl.seasonKey + ' beendet! ' + total + ' Kommandanten kämpften um den Aufstieg – Saison-Champion: ' + champName + '. Deine Saison-Belohnung wartet beim nächsten Login.');
    }
  }
  // Neue Saison starten.
  sl.seasonKey = nowKey;
  sl.startScores = {};
  for (const uid of Object.keys(current)) sl.startScores[uid] = current[uid];
}
// Kompakte Saison-Info fürs Frontend (/me): aktueller Saison-Schlüssel, Ende und der eigene Start-Score.
// startScore === null bedeutet „für diese Saison noch nicht erfasst" (der Client behandelt das als 0-Zuwachs,
// bis der nächste galaxyTick den Startwert festhält).
function seasonInfoForUser(userId) {
  const g = loadOrInitGalaxy();
  const sl = (g && g.seasonLeague) || {};
  const key = sl.seasonKey || serverSeasonKey(Date.now());
  const startScore = (sl.startScores && sl.startScores[userId] != null) ? sl.startScores[userId] : null;
  return { key, endsAt: seasonEndsAt(Date.now()), startScore };
}

// --- Erklärte Allianz-Kriege auflösen (#4) ---
// Ein Krieg (Frontend: declareWar) läuft 7 Tage und liegt komplett in db.shared: die Kriegslisten
// (alliance:<TAG>:wars = {enemies:[...]}), die Punktestände (alliance:<TAG>:warscore:<ENEMY>) und die
// individuellen Beiträge (alliance:<TAG>:warcontrib:<ENEMY>:<playerId>). Zusätzlich schreibt der Client
// jetzt ein Zeitfenster (alliance:<TAG>:warmeta:<ENEMY> = {endsAt}). Ist es abgelaufen UND der Krieg noch
// in beiden Kriegslisten aktiv, kürt der Server anhand der Kriegspunkte einen Sieger, schüttet dessen
// beteiligten Kämpfern eine flache Kredit-Prämie aus (bewusst KEINE "N-Min-Produktion", um Explosionen zu
// vermeiden) und räumt alle Kriegsdaten auf. Bei Frieden (Client entwertet das Zeitfenster + entfernt aus
// den Kriegslisten) wird nur aufgeräumt, ohne Belohnung.
const WAR_VICTORY_CREDITS = 1200;
function warEnemiesOf(tag) {
  try { const raw = db.shared['alliance:' + tag + ':wars']; return raw ? (JSON.parse(raw).enemies || []) : []; } catch (e) { return []; }
}
function warScoreOf(tag, enemy) {
  try { const raw = db.shared['alliance:' + tag + ':warscore:' + enemy]; return raw ? (JSON.parse(raw).score || 0) : 0; } catch (e) { return 0; }
}
function warContributorIds(tag, enemy) {
  const prefix = 'alliance:' + tag + ':warcontrib:' + enemy + ':';
  return Object.keys(db.shared).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
}
function removeWarEnemy(tag, enemy) {
  const list = warEnemiesOf(tag).filter(e => e !== enemy);
  db.shared['alliance:' + tag + ':wars'] = JSON.stringify({ enemies: list });
}
function cleanupWarKeys(a, b) {
  const del = [
    'alliance:' + a + ':warmeta:' + b, 'alliance:' + b + ':warmeta:' + a,
    'alliance:' + a + ':warscore:' + b, 'alliance:' + b + ':warscore:' + a
  ];
  for (const k of del) delete db.shared[k];
  const cp1 = 'alliance:' + a + ':warcontrib:' + b + ':', cp2 = 'alliance:' + b + ':warcontrib:' + a + ':';
  for (const k of Object.keys(db.shared)) if (k.startsWith(cp1) || k.startsWith(cp2)) delete db.shared[k];
}
function resolveAllianceWarsServer() {
  const now = Date.now();
  const metaKeys = Object.keys(db.shared).filter(k => /^alliance:[^:]+:warmeta:[^:]+$/.test(k));
  const seenPairs = new Set();
  for (const key of metaKeys) {
    const parts = key.split(':'); // ['alliance', A, 'warmeta', B]
    const A = parts[1], B = parts[3];
    let meta = null; try { meta = JSON.parse(db.shared[key]); } catch (e) {}
    if (!meta) { delete db.shared[key]; continue; }
    if ((meta.endsAt || 0) > now) continue; // Krieg läuft noch
    const pair = [A, B].sort().join('|');
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    const stillActive = warEnemiesOf(A).includes(B) && warEnemiesOf(B).includes(A);
    if (stillActive) {
      const scoreA = warScoreOf(A, B), scoreB = warScoreOf(B, A);
      const winner = scoreA > scoreB ? A : (scoreB > scoreA ? B : null);
      if (winner) {
        const loser = winner === A ? B : A;
        const wS = winner === A ? scoreA : scoreB, lS = winner === A ? scoreB : scoreA;
        const members = warContributorIds(winner, loser);
        for (const uid of members) pushPendingReward(uid, { type: 'war-victory', enemyTag: loser, credits: WAR_VICTORY_CREDITS, myScore: wS, theirScore: lS });
        pushGalaxyNews('ti-trophy', 'Allianz-Krieg beendet: [' + winner + '] besiegt [' + loser + '] mit ' + wS + ':' + lS + ' Kriegspunkten.');
      } else {
        pushGalaxyNews('ti-flag', 'Allianz-Krieg zwischen [' + A + '] und [' + B + '] endet unentschieden (' + scoreA + ':' + scoreB + ').');
      }
      removeWarEnemy(A, B); removeWarEnemy(B, A);
    }
    cleanupWarKeys(A, B);
  }
}

// --- Kopfgeld-System (#2) ---
// Jede Woche liegt ein Kopfgeld auf dem aktuellen Bestenlisten-Ersten (der stärkste, sichtbarste
// Spieler). Wer ihn per PvP-Angriff schlägt, kassiert eine flache Kredit-Prämie - danach ist das
// Kopfgeld für diese Woche vergeben (nur ein Kassierer). Man kann kein Kopfgeld auf sich selbst
// kassieren. Der Angriffs-Schutzschild (#5) begrenzt ohnehin das Nachtreten, sodass der Anführer nicht
// beliebig oft gejagt werden kann. Liegt komplett in db.galaxy.bounty und wird über /api/galaxy sichtbar.
const BOUNTY_REWARD = 2000;
function resolveBountyServer() {
  const g = loadOrInitGalaxy();
  const nowKey = serverWeekKey(Date.now());
  if (g.bounty && g.bounty.weekKey === nowKey) return; // diese Woche bereits gesetzt (ob kassiert oder nicht)
  let top = null, topId = null;
  for (const k of Object.keys(db.shared)) {
    if (!k.startsWith('leaderboard:')) continue;
    try { const v = JSON.parse(db.shared[k]); if (!top || (v.score || 0) > (top.score || 0)) { top = v; topId = k.slice('leaderboard:'.length); } } catch (e) {}
  }
  if (top && topId) g.bounty = { targetUserId: topId, targetName: top.name || 'Unbekannt', reward: BOUNTY_REWARD, weekKey: nowKey, claimed: false, claimedBy: null };
}

function galaxyTick() {
  const g = loadOrInitGalaxy();
  g.lastTick = Date.now();
  // Wochenwechsel im laufenden Server: Ohne diese Zeile kämen die neuen Systeme erst beim nächsten
  // Neustart dazu – und der Server läuft zwischen zwei Deploys durchaus wochenlang durch. Dann
  // hätte das Frontend Montagfrüh zwei Systeme mehr als der Server, also wieder genau die Lücke,
  // die hier gerade geschlossen wurde.
  const neueSysteme = syncWeeklySystems(Date.now());
  if (neueSysteme) console.log(`[galaxy] ${neueSysteme} Wochensystem(e) nachgezogen, jetzt ${SYSTEMS.length} Systeme`);
  pruneChatKeys();   // alte Chat-Schlüssel wegräumen - siehe CHAT_KEEP_PER_CHANNEL
  updateHallOfFameServer();
  resolveWeeklyLeagueServer();
  resolveSeasonLeagueServer();
  resolveAllianceWarsServer();
  resolveBountyServer();

  // Die Alien-Nester reifen, breiten sich aus und bringen Koeniginnen hervor (Phase 3). Steht der
  // Schalter aus, kehrt nestTick sofort zurueck. Bewusst VOR npcEmpireStrength: Ab Phase 4 leitet
  // sich dessen Zielwert aus der Stufensumme der Nester ab, und die soll dann die des aktuellen
  // Takts sein, nicht die des vorigen.
  nestTick(g);

  // Die wandernden Beute-Ziele (A2). Steht A2_SPAWN_AKTIV aus, kehrt A2Tick sofort zurueck - genau
  // wie nestTick. Bewusst NACH nestTick, damit die Freiheitspruefung der A2-Platzierung die Nester
  // dieses Takts kennt (ein A2-Ziel darf nicht auf einem gerade entstandenen Nest landen).
  A2Tick(g);

  /* Die galaktische Gegnerstaerke. Mit aktiven Nestern ein TAUZIEHEN gegen ihren Bestand
     (Phase 4, Begruendung und Messung bei NPC_STAERKE_BASIS); ohne sie das alte monotone
     Wachstum - sonst baute diese Phase die Galaxie um, obwohl Phase 3 noch schlaeft. */
  // BEWUSST die Konstante und NICHT spawnAktiv('nester'): Die Drift wertet den BESTAND aus, und
  // der bleibt bei einer Notabschaltung unveraendert stehen (sie stoppt nur den Nachschub). Sie
  // hier mitzustoppen liesse `g.npcStaerkeZiel` auf einem Wert einfrieren, den niemand mehr
  // anstrebt - das Frontend zeigte dann eine Weltlage an, die nicht mehr gilt.
  if (NEST_SPAWN_AKTIV) {
    const ziel = npcStaerkeZiel(g);
    g.npcEmpireStrength += (ziel - g.npcEmpireStrength) * NPC_STAERKE_DRIFT;
    g.npcEmpireStrength = Math.max(1, Math.min(NPC_STAERKE_DECKEL, g.npcEmpireStrength));
    // Reist ueber galaxyFuerClient() mit, damit das Frontend die Weltlage BENENNEN kann statt sie
    // den Spieler an schwankenden Gegnerwerten erraten zu lassen.
    g.npcStaerkeZiel = Math.round(ziel * 1000) / 1000;
  } else {
    g.npcEmpireStrength = Math.min(2.5, g.npcEmpireStrength * (1 + 0.002 + Math.random() * 0.003));
  }
  // Handelsmarkt: leichter Random Walk zwischen 0.75x und 1.30x.
  g.marketTrend = Math.max(0.75, Math.min(1.30, g.marketTrend + (Math.random() - 0.5) * 0.08));

  // Geteilter Marktplatz: Preise driften pro Tick zurück zum Normalpreis (etwas Rauschen dazu, damit
  // der Markt auch ohne Spieleraktivität leicht lebendig wirkt).
  // Balance-Wunsch 13.07.2026: Erholung ist jetzt ASYMMETRISCH. Vorher erholte sich JEDE Abweichung
  // gleich schnell (15%/Tick, nach ~4-6h fast komplett zurück) - ein Spieler konnte einen durch
  // Massenverkauf gedrückten Preis einfach aussitzen und dann erneut nahe am Normalpreis verkaufen,
  // beliebig oft, da die eigene Produktion laufend neue Ware nachliefert. Ein gedrückter Preis (unter
  // Normalpreis, durch Verkäufe) erholt sich viel langsamer als ein erhöhter Preis (über Normalpreis,
  // durch Käufe, unverändert 15%/Tick) - Problem liegt gezielt beim Verkaufen, nicht beim Kaufen.
  // Weiter verlangsamt (13.07.2026, war zunächst 4%/Tick = ~1 Tag): wer zu viel verkauft, soll eine
  // SEHR lange Erholungszeit spüren, nicht nur einen Tag - jetzt ~1,5%/Tick, mehrere Tage bis zur
  // fast vollständigen Erholung.
  const MARKET_SELL_RECOVERY_RATE = 0.015;
  const MARKET_BUY_RECOVERY_RATE = 0.15;
  const market = loadOrInitMarket(g);

  // Markt-Ereignisse (20.07.2026 "Markt vertiefen"): gelegentlicher Angebots-/Nachfrageschock auf EINE
  // Ressource. Statt eines harten Preissprungs verschiebt das Ereignis nur das Erholungs-ZIEL
  // (basePrice*mult) für seine Laufzeit - der Preis driftet organisch zum Schockniveau und nach Ablauf
  // wieder zurück. Immer nur ein Ereignis gleichzeitig.
  if (g.marketEvent && g.marketEvent.endsAt <= Date.now()) {
    pushGalaxyNews('ti-truck', 'Marktlage normalisiert: „' + g.marketEvent.label + '" ist vorbei, die Preise beruhigen sich.');
    g.marketEvent = null;
  }
  if (!g.marketEvent && Math.random() < MARKET_EVENT_CHANCE) {
    const keys = Object.keys(MARKET_RESOURCES);
    const rkey = keys[Math.floor(Math.random() * keys.length)];
    const rlabel = MARKET_RES_LABELS[rkey] || rkey;
    const shortage = Math.random() < 0.5;
    const mult = shortage ? (1.35 + Math.random() * 0.35) : (0.5 + Math.random() * 0.2);
    const names = shortage ? MARKET_EVENT_SHORTAGE_NAMES : MARKET_EVENT_GLUT_NAMES;
    const durH = 2 + Math.floor(Math.random() * 3); // 2-4h
    g.marketEvent = {
      resource: rkey, kind: shortage ? 'shortage' : 'glut', mult: Math.round(mult * 100) / 100,
      label: names[Math.floor(Math.random() * names.length)].replace('{res}', rlabel),
      startedAt: Date.now(), endsAt: Date.now() + durH * 3600 * 1000
    };
    pushGalaxyNews(shortage ? 'ti-arrow-up' : 'ti-box',
      'MARKT: ' + g.marketEvent.label + ' – ' + rlabel + (shortage ? ' wird knapp, die Preise steigen deutlich.' : ' überschwemmt den Markt, die Preise fallen.'));
  }

  for (const [key, info] of Object.entries(MARKET_RESOURCES)) {
    const cur = market[key];
    const evHere = g.marketEvent && g.marketEvent.resource === key;
    // Ereignis verschiebt das Erholungsziel dieser Ressource; sonst zurück zum Normalpreis.
    const target = evHere ? clampMarketPrice(key, info.basePrice * g.marketEvent.mult) : info.basePrice;
    // Während eines Ereignisses ein festes, richtungsunabhängiges Drift-Tempo (spürbare Bewegung in
    // beide Richtungen); sonst die bewährte asymmetrische Erholung (gedrückte Preise erholen sich langsam).
    const recoverRate = evHere ? MARKET_EVENT_DRIFT_RATE : (cur < target ? MARKET_SELL_RECOVERY_RATE : MARKET_BUY_RECOVERY_RATE);
    const towardBase = cur + (target - cur) * recoverRate;
    const noise = towardBase * (Math.random() - 0.5) * 0.05;
    market[key] = clampMarketPrice(key, towardBase + noise);
  }

  // Preisverlauf mitschreiben (rollend, letzte MARKET_HISTORY_LEN Ticks) für den Sparkline-Chart im Client.
  if (!g.marketHistory) g.marketHistory = {};
  for (const key of Object.keys(MARKET_RESOURCES)) {
    const h = g.marketHistory[key] || [];
    h.push(Math.round(market[key] * 100) / 100);
    while (h.length > MARKET_HISTORY_LEN) h.shift();
    g.marketHistory[key] = h;
  }

  // Abgelaufene kollabierte Systeme wieder freigeben.
  for (const [sysId, expiresAt] of Object.entries(g.collapsedSystems)) {
    if (expiresAt < Date.now()) {
      delete g.collapsedSystems[sysId];
      pushGalaxyNews('ti-sun', 'Das System ' + sysId + ' hat sich nach dem Supernova-Kollaps stabilisiert.');
    }
  }
  // Abgelaufenes Wurmloch schließen.
  if (g.activeWormhole && g.activeWormhole.expiresAt < Date.now()) {
    pushGalaxyNews('ti-infinity', 'Das Wurmloch nach ' + g.activeWormhole.to + ' hat sich wieder geschlossen.');
    g.activeWormhole = null;
  }
  // Abgelaufenen Krieg beilegen - und ihn erstmals ENTSCHEIDEN.
  //
  // Bis zum 10.08.2026 war activeWar reine Kulisse: Die Parteien kamen aus NPC_FACTION_NAMES (sechs
  // Namen, zwei davon ohne Fraktionseintrag), der Krieg spielte in einem zufaellig gewaehlten
  // System, und er veraenderte f.systems mit KEINER Zeile. Krieg und Territorium waren vollstaendig
  // entkoppelt - man konnte 36 Stunden zusehen, wie zwei Namen um ein System "kaempfen", das
  // danach genauso dastand wie vorher.
  //
  // Jetzt hat ein Krieg zwischen zwei ECHTEN Fraktionen einen Einsatz (stakes). Laeuft er ab,
  // entscheidet das Staerkeverhaeltnis, wer das umkaempfte System haelt.
  if (g.activeWar && g.activeWar.expiresAt < Date.now()) {
    resolveFactionWar(g);
  }

  // Zufällige galaktische Ereignisse, jeweils unabhängige Chance pro Tick (alle 15 Min.). Jedes
  // ortsgebundene Ereignis bekommt jetzt ein echtes, freies (unbesiedeltes) System zugewiesen, damit
  // es auf der Sektorkarte sichtbar gemacht werden kann.
  if (Math.random() < 0.12 && !g.activeWar) {
    startFactionWar(g);
  }
  if (Math.random() < 0.06 && g.unlockedAlienRaces.length < ALIEN_RACE_NAMES.length) {
    const next = ALIEN_RACE_NAMES[g.unlockedAlienRaces.length];
    const sys = pickRandomFreeSystem();
    g.unlockedAlienRaces.push({ name: next, system: sys, unlockedAt: Date.now() });
    pushGalaxyNews('ti-alien', 'Ein neues Volk wurde entdeckt: die ' + next + ' treten erstmals bei ' + sys + ' in Erscheinung.');
  }
  if (Math.random() < 0.10) {
    const candidates = NPC_FACTION_NAMES.filter(n => n !== g.activePirateFaction.name);
    const sys = pickRandomFreeSystem();
    g.activePirateFaction = { name: candidates[Math.floor(Math.random() * candidates.length)], system: sys };
    pushGalaxyNews('ti-skull', g.activePirateFaction.name + ' gründet eine neue Operationsbasis bei ' + sys + '.');
  }
  if (Math.random() < 0.04) {
    const occupied = occupiedSystems();
    const free = SYSTEMS.filter(s => !occupied.has(s) && !g.collapsedSystems[s]);
    if (free.length) {
      const target = free[Math.floor(Math.random() * free.length)];
      g.collapsedSystems[target] = Date.now() + 48 * 3600 * 1000;
      pushGalaxyNews('ti-sun', 'Supernova! Das unbesiedelte System ' + target + ' ist kollabiert und für 48 Stunden unzugänglich.');
    }
  }
  if (Math.random() < 0.06 && !g.activeWormhole) {
    const occupiedForWormhole = occupiedSystems();
    const options = SYSTEMS.filter(s => s !== 'kepler' && !occupiedForWormhole.has(s));
    if (options.length) {
      const to = options[Math.floor(Math.random() * options.length)];
      g.activeWormhole = { from: 'kepler', to, expiresAt: Date.now() + 12 * 3600 * 1000 };
      pushGalaxyNews('ti-infinity', 'Ein neues Wurmloch ist entstanden: Kepler-System ↔ ' + to + ' (für 12 Stunden geöffnet).');
    }
  }

  // ===== NPC-Fraktionen: Territorium-Simulation =====
  // Jede Fraktion wächst in ihrer Militärstärke und versucht pro Tick zu expandieren: bevorzugt in ein
  // freies Nachbarsystem, sonst greift sie ein schwächer gehaltenes Nachbar-Fraktionssystem an. Spieler-
  // Heimatsysteme sind immer tabu. Ergebnisse werden als Galaxie-Nachrichten gemeldet.
  const factions = loadOrInitFactions(g);
  const occupiedByPlayers = occupiedSystems();
  const controlled = g.controlledSystems || {};
  // Vom Spieler eroberte Systeme sind für Fraktionen ebenfalls tabu (wie Heimatsysteme).
  const playerBlocked = new Set([...occupiedByPlayers, ...Object.keys(controlled)]);
  // Das umkaempfte System waehrend eines Krieges mit Einsatz aus der normalen Expansion nehmen.
  // Ohne diese Zeile koennte es der Expansionsschleife im selben Takt beilaeufig zufallen - der
  // Krieg waere dann schon entschieden, bevor er ueberhaupt ablaeuft, und die Meldung am Ende
  // wuerde etwas verkuenden, das gar nicht mehr zur Debatte stand.
  if (g.activeWar && g.activeWar.stakes && g.activeWar.system) playerBlocked.add(g.activeWar.system);
  for (const f of Object.values(factions)) {
    // Stärke wächst langsam, skaliert leicht mit Territoriumsgröße (größere Reiche werden stärker).
    f.strength = Math.min(6.0, f.strength * (1 + 0.01 + Math.random() * 0.02) + f.systems.length * 0.002);
  }
  // Expansions-Reihenfolge zufällig, damit nicht immer dieselbe Fraktion zuerst zieht.
  const factionOrder = Object.values(factions).sort(() => Math.random() - 0.5);
  for (const f of factionOrder) {
    if (Math.random() > 0.5) continue; // nicht jede Fraktion expandiert jeden Tick
    const ownership = systemOwnershipMap(g);
    // Alle Nachbarsysteme des eigenen Territoriums sammeln.
    const frontier = new Set();
    for (const sys of f.systems) {
      for (const nb of (SYSTEM_NEIGHBORS[sys] || [])) {
        if (f.systems.includes(nb)) continue;
        if (playerBlocked.has(nb)) continue;              // Spieler-Heimat & eroberte Systeme tabu
        if (g.collapsedSystems[nb]) continue;             // kollabierte Systeme überspringen
        frontier.add(nb);
      }
    }
    if (!frontier.size) continue;
    const frontierArr = [...frontier];
    // Freie (herrenlose) Nachbarn bevorzugen.
    const freeTargets = frontierArr.filter(s => !ownership[s]);
    if (freeTargets.length) {
      const target = freeTargets[Math.floor(Math.random() * freeTargets.length)];
      f.systems.push(target);
      pushGalaxyNews('ti-flag', f.name + ' hat das System ' + target + ' besetzt und dehnt sein Gebiet aus.');
    } else {
      // Sonst ein Nachbar-Fraktionssystem angreifen, wenn wir stärker sind.
      const enemyTargets = frontierArr.filter(s => ownership[s] && ownership[s] !== f.id);
      if (!enemyTargets.length) continue;
      const target = enemyTargets[Math.floor(Math.random() * enemyTargets.length)];
      const defender = factions[ownership[target]];
      if (!defender) continue;
      // Angriffschance steigt mit Stärkeverhältnis.
      const ratio = f.strength / (defender.strength || 1);
      if (Math.random() < Math.min(0.85, ratio * 0.4)) {
        defender.systems = defender.systems.filter(s => s !== target);
        f.systems.push(target);
        pushGalaxyNews('ti-sword', f.name + ' hat ' + target + ' im Kampf von ' + defender.name + ' erobert!');
      }
    }
  }

  // ===== Rückeroberung: Fraktionen versuchen, verlorene Systeme vom Spieler zurückzuholen =====
  // Nur Systeme, die direkt an das Territorium der Fraktion grenzen, sind gefährdet. Die Erfolgschance
  // hängt von der Fraktionsstärke gegen die GESAMTVERTEIDIGUNG des besitzenden Spielers ab (wer stark
  // verteidigt, verliert praktisch nie) und ist bei 50% gedeckelt. Versuche sind selten (15% pro
  // Fraktion pro Tick), damit kontrollierte Systeme nicht zur Frust-Quelle werden. Heimatsysteme sind
  // hiervon NICHT betroffen (nur eroberte Fraktionssysteme).
  for (const f of factionOrder) {
    if (Math.random() > 0.15) continue;
    const retakeTargets = Object.keys(g.controlledSystems).filter(sys =>
      (SYSTEM_NEIGHBORS[sys] || []).some(nb => f.systems.includes(nb)) && !g.collapsedSystems[sys]
    );
    if (!retakeTargets.length) continue;
    const target = retakeTargets[Math.floor(Math.random() * retakeTargets.length)];
    const ownerId = g.controlledSystems[target];
    let defense = 500;
    const saveRaw = getSaveValue(ownerId);
    if (saveRaw) { try { defense = Math.max(200, computeDefensePower(JSON.parse(saveRaw))); } catch (e) {} }
    const atk = 1200 * f.strength;
    const chance = Math.min(0.5, Math.max(0.05, atk / (atk + defense)) * 0.6);
    if (Math.random() < chance) {
      delete g.controlledSystems[target];
      f.systems.push(target);
      pushGalaxyNews('ti-sword', f.name + ' hat das System ' + target + ' vom bisherigen Besitzer zurückerobert!');
    } else {
      pushGalaxyNews('ti-shield', 'Ein Rückeroberungsversuch der ' + f.name + ' auf ' + target + ' wurde abgewehrt.');
    }
  }

  // Die Front zuletzt: Expansion, Rueckeroberung und Kriegsauflösung haben den Besitzstand dieses
  // Takts bereits festgelegt. Rechnete die Front davor, wuerde sie auf einem Stand arbeiten, den es
  // am Ende des Takts gar nicht mehr gibt - und ein gerade eroberter Sektor stuende einen Takt lang
  // mit dem Kontrollwert seines Vorbesitzers da.
  rkTick(g);

  // Asteroidenfestungen: Entstehen und Verfallen. Bewusst HIER und nicht beim Lesen des Feldes -
  // eine Festung ist ein Ereignis der Galaxie, kein Nebeneffekt eines Kartenaufrufs. Der Hort
  // dagegen wächst beim Lesen (festungReifen), weil er zwischen zwei Takten sonst stillstünde.
  if (Math.random() < FESTUNG_SPAWN_CHANCE) {
    const { felder } = astAlleFelder();
    const neu = festungSpawn(felder);
    if (neu) { for (const sysId of Object.keys(felder)) db.shared[astFeldKey(sysId)] = felder[sysId]; }
  }

  checkLeaderboardOvertakes();

  saveDb();
}
// Bestenlisten-Überholt-Push (Retention, 21.07.2026): erkennt einmal pro Galaxie-Tick, wenn ein
// Spieler in der Rangliste zurückgefallen ist (jemand hat ihn überholt), und schickt ihm eine
// Benachrichtigung. Nur für die vorderen Ränge (LIMIT), damit es ein motivierendes Wettkampfsignal
// bleibt und nicht bei jeder Mini-Schwankung tief im Feld feuert. Pro Spieler ein Cooldown gegen
// Spam. Der gespeicherte Rang (__lastRank) wird für ALLE Einträge aktualisiert, damit die Baseline
// stimmt, auch wenn kein Push ausgelöst wird.
const OVERTAKE_RANK_LIMIT = 50;
const OVERTAKE_PUSH_COOLDOWN_MS = 6 * 3600 * 1000;
function checkLeaderboardOvertakes() {
  try {
    const entries = [];
    for (const key of Object.keys(db.shared)) {
      if (!key.startsWith('leaderboard:')) continue;
      const userId = key.slice('leaderboard:'.length);
      let v = null;
      try { v = JSON.parse(db.shared[key]); } catch (e) { continue; }
      if (!v) continue;
      entries.push({ userId, score: v.score || 0, name: v.name || 'Kommandant' });
    }
    if (entries.length < 2) return;
    entries.sort((a, b) => b.score - a.score);
    const now = Date.now();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const rank = i + 1;
      const user = findUserById(e.userId);
      if (!user) continue;
      if (!db.private[e.userId]) db.private[e.userId] = {};
      const priv = db.private[e.userId];
      const prevRank = priv.__lastRank;
      // Nur pushen, wenn: vorheriger Rang bekannt, jetzt schlechter (höhere Zahl), im vorderen Feld,
      // Push-Kategorie aktiv und Cooldown abgelaufen.
      if (typeof prevRank === 'number' && rank > prevRank && rank <= OVERTAKE_RANK_LIMIT) {
        const prefs = getNotifPrefs(user);
        if (prefs.enabled && prefs.leaderboard && (now - (priv.__lastOvertakenPush || 0)) >= OVERTAKE_PUSH_COOLDOWN_MS) {
          const aheadName = (entries[i - 1] && entries[i - 1].name) || 'Ein Spieler';
          pushNotificationEvent(e.userId, 'leaderboard-overtaken', { rank, prevRank, aheadName });
          priv.__lastOvertakenPush = now;
        }
      }
      priv.__lastRank = rank;
    }
  } catch (e) { console.error('checkLeaderboardOvertakes fehlgeschlagen:', e.message); }
}
// "Online"-Näherung über den lastSeen-Zeitstempel der Bestenliste (wird bei jedem Client-Speichern
// gesetzt, auch alle 10s im offenen Tab). Wer kürzlich gespeichert hat, ist gerade da und braucht
// keine Fertigstellungs-Push (er sieht es im Spiel selbst).
const REMINDER_ONLINE_THRESHOLD_MS = 2 * 60 * 1000;
function userIsOnline(userId) {
  try {
    const lb = db.shared['leaderboard:' + userId];
    if (!lb) return false;
    const v = JSON.parse(lb);
    return (Date.now() - (v.lastSeen || 0)) < REMINDER_ONLINE_THRESHOLD_MS;
  } catch (e) { return false; }
}
function checkCompletionReminders() {
  try {
    const now = Date.now();
    let changed = false;
    for (const [userId, priv] of Object.entries(db.private)) {
      if (!priv || !Array.isArray(priv.__reminders) || !priv.__reminders.length) continue;
      const due = priv.__reminders.filter(r => r.endTime <= now);
      if (!due.length) continue;
      priv.__reminders = priv.__reminders.filter(r => r.endTime > now);
      changed = true;
      if (userIsOnline(userId)) continue; // im Spiel selbst gesehen - keine Push nötig
      const user = findUserById(userId);
      if (!user) continue;
      const prefs = getNotifPrefs(user);
      if (!prefs.enabled || !prefs.completion) continue;
      // Nur EINE Push je Durchlauf und Spieler (der früheste fällige Typ), auch wenn mehrere Aufträge
      // gleichzeitig fällig werden - verhindert eine Benachrichtigungs-Flut nach langer Abwesenheit.
      due.sort((a, b) => a.endTime - b.endTime);
      pushNotificationEvent(userId, 'job-complete', { jobType: due[0].type });
    }
    if (changed) saveDb();
  } catch (e) { console.error('checkCompletionReminders fehlgeschlagen:', e.message); }
}
setInterval(checkCompletionReminders, 60 * 1000);

// --- Reaktivierung: Winback-E-Mails für inaktive Spieler ---
// Push deckt bereits laufende Ereignisse ab (Überfall, überholt, Bau fertig ...), erreicht aber nur
// Spieler, die ihre Push-Erlaubnis erteilt haben und deren Gerät das Abo behalten hat. Wer das Spiel
// länger nicht geöffnet hat, bekommt sonst GAR nichts, das ihn zurückholt. Diese Winback-Mails schließen
// genau diese Lücke: gestaffelt nach Inaktivitätsdauer, pro Stufe nur einmal, mit Opt-out über die
// bestehende „Neuigkeiten per E-Mail"-Einstellung (wantsPatchnotes) - kein neuer Abmelde-Mechanismus nötig.
const WINBACK_TIERS = [ { key: 'd3', days: 3 }, { key: 'd10', days: 10 } ];
const WINBACK_MAX_PER_RUN = 40;      // Sende-Burst je Durchlauf deckeln (Mail-Rate schonen)
const WINBACK_MIN_GAP_MS = 3 * 24 * 60 * 60 * 1000; // Mindestabstand zwischen zwei Winback-Mails je Spieler
function getUserLastSeen(userId) {
  try {
    const lb = db.shared['leaderboard:' + userId];
    if (!lb) return 0;
    const v = JSON.parse(lb);
    return v.lastSeen || 0;
  } catch (e) { return 0; }
}
// Reine, testbare Entscheidung: höchste erreichte, noch nicht gesendete Inaktivitätsstufe (oder null).
function winbackTierToSend(daysAway, sentTiers) {
  let pick = null;
  for (const t of WINBACK_TIERS) { if (daysAway >= t.days && !sentTiers.includes(t.key)) pick = t.key; }
  return pick;
}
async function checkDormantWinback() {
  try {
    const now = Date.now();
    let changed = false, sent = 0;
    for (const user of Object.values(db.users)) {
      if (sent >= WINBACK_MAX_PER_RUN) break;
      if (!user || !user.emailVerified || !user.email) continue;
      if (user.wantsPatchnotes === false) continue; // Opt-out respektieren
      const lastSeen = getUserLastSeen(user.userId);
      if (!lastSeen) continue; // nie richtig gespielt - keine Winback-Mail an tote Registrierungen
      const daysAway = (now - lastSeen) / 86400000;
      const priv = db.private[user.userId] || (db.private[user.userId] = {});
      const wb = priv.__winback || (priv.__winback = { sent: [], lastSentAt: 0 });
      // Zurückgekehrt (kürzlich gespielt)? -> Zustand zurücksetzen, damit spätere Inaktivität wieder greift.
      if (daysAway < 1) { if (wb.sent.length) { priv.__winback = { sent: [], lastSentAt: 0 }; changed = true; } continue; }
      const tier = winbackTierToSend(daysAway, wb.sent);
      if (!tier) continue;
      if (wb.lastSentAt && (now - wb.lastSentAt) < WINBACK_MIN_GAP_MS) continue; // Sicherheitsnetz gegen Spam
      const days = Math.floor(daysAway);
      try {
        const link = PUBLIC_URL + '/';
        const html = voidSignalEmail({
          eyebrow: 'Signal aus dem Tiefenraum',
          username: user.username,
          statusLabel: 'Deine Kolonie hält die Stellung',
          statusColor: '#7f77dd',
          bodyHtml: 'Kommandant, deine Kolonie hält seit ' + days + ' Tagen die Stellung – Produktion, Forschung und Flotten laufen auch ohne dich weiter, und der Offline-Ertrag stapelt sich. Doch Rivalen rücken auf deine Position vor. Kehr zurück und sichere, was dir gehört, bevor es jemand anderes tut.',
          ctaLabel: 'Zur Kolonie zurückkehren',
          ctaUrl: link,
          footerNote: 'Du bekommst diese Erinnerung, weil dein Konto längere Zeit inaktiv war. Nicht mehr erwünscht? Deaktiviere „Neuigkeiten per E-Mail" in den Einstellungen.'
        });
        const text = voidSignalPlainText({
          username: user.username, statusLabel: 'Deine Kolonie hält die Stellung',
          plainBody: 'Deine Kolonie hält seit ' + days + ' Tagen die Stellung und der Offline-Ertrag stapelt sich. Kehr zurück, bevor Rivalen aufrücken.',
          ctaUrl: link
        });
        await sendEmail(user.email, 'Deine Kolonie wartet auf dich – Kolonie Kepler-7', html, text);
        wb.sent.push(tier); wb.lastSentAt = now; changed = true; sent++;
        console.log('[winback] userId=' + user.userId + ' tier=' + tier + ' daysAway=' + days);
      } catch (e) { console.error('Winback-Mail fehlgeschlagen:', e.message); }
    }
    if (changed) await saveDb();
  } catch (e) { console.error('checkDormantWinback fehlgeschlagen:', e.message); }
}
setInterval(checkDormantWinback, 60 * 60 * 1000);   // stündlich prüfen
setTimeout(checkDormantWinback, 2 * 60 * 1000);     // erster Lauf ~2 Min nach Start (blockiert den Boot nicht)

setInterval(galaxyTick, GALAXY_TICK_MS);
/* Der Startlauf liegt in setImmediate und NICHT direkt hier - gemessen, nicht vermutet (18.08.2026).
   Diese Zeile steht bei 5526, der Rest der Datei geht bis 9100+. Ein direkter Aufruf führt den
   Rumpf von galaxyTick MITTEN in der Modulauswertung aus; jede `const`, die weiter unten steht,
   liegt zu diesem Zeitpunkt in ihrer temporalen Todeszone. Konkret passiert beim Einbau der
   Asteroidenfestungen: `FESTUNG_SPAWN_CHANCE` steht bei 7908, und der Server startete gar nicht
   mehr ("Cannot access 'FESTUNG_SPAWN_CHANCE' before initialization") - bei JEDEM Start, nicht
   nur in 8 % der Fälle, denn der rechte Operand eines `<` wird immer ausgewertet.
   `node --check` findet das NICHT: es parst nur und führt nie aus.
   setImmediate löst das für alle künftigen Fälle mit: Es feuert, sobald die Modulauswertung fertig
   ist, also Millisekunden später - die Absicht "nicht 15 Minuten auf den ersten Zustand warten"
   bleibt vollständig erhalten. Nach der Zeile stehen ohnehin nur noch Funktions-, Konstanten- und
   Routendefinitionen, nichts, was den Takt vorher gelaufen sehen müsste (nachgesehen). */
setImmediate(galaxyTick);

// Die Front fuehrt zwei Dinge, die ausserhalb des Servers niemanden etwas angehen: die Pufferstaende
// beider Seiten (wer sie sieht, kennt das Ergebnis des naechsten Takts, bevor er faellt) und je Konto
// den Zeitpunkt seines letzten Beitrags samt Tagessumme. Bis hierher ging das Galaxie-Objekt 1:1 an
// jeden eingeloggten Client. Statt der Rohdaten bekommt jeder Aufrufer jetzt genau das, was seine
// Anzeige braucht: den Stand, wie viele verschiedene Konten je Seite dahinterstehen, und was er
// SELBST heute beigetragen hat.
function galaxyFuerClient(g, userId) {
  const rk = g.randkriege;
  if (!rk || !Array.isArray(rk.fronten)) return g;
  const fronten = rk.fronten.map(f => ({
    a: f.a, b: f.b,
    systeme: (f.systeme || []).map(e => {
      const bei = Object.values(e.beitragende || {});
      return {
        sys: e.sys, kp: e.kp,
        beitragendeA: bei.filter(v => v && v.seite === f.a).length,
        beitragendeB: bei.filter(v => v && v.seite === f.b).length,
        dabei: !!(e.beitragende && e.beitragende[userId])
      };
    })
  }));
  const tag = (rk.tag && rk.tag.stempel === rkTagesSchluessel()) ? rk.tag : null;
  const meinTag = (tag && tag.konten && tag.konten[userId]) || {};
  // Der Client soll ohne zweite Anfrage anzeigen koennen, wie viel Zaehlerfortschritt noch offen
  // ist. Dafuer bekommt er SEINEN Basiswert (nicht den anderer Konten) und die Breite der
  // Tagesstufen - er rechnet die offene Menge dann gegen seinen eigenen, lebenden Spielstand aus.
  // Der Basiswert bleibt dabei serverseitig gefuehrt; was hier rausgeht, ist eine Kopie zur Anzeige.
  const basis = (db.private[userId] && db.private[userId].__rkBasis) || {};
  const meineBasis = {};
  for (const h of Object.values(RK_HANDLUNGEN)) meineBasis[h.feld] = basis[h.feld] || 0;
  // Dienstpunkte und Markenbestand gehen NUR fuer den Abrufenden raus - fremde Staende sind
  // niemandes Sache und waeren zugleich eine Einladung, Konten gezielt auszusitzen.
  const wocheKonto = (rk.woche && rk.woche.stempel === serverWeekKey(Date.now())
    && rk.woche.konten && rk.woche.konten[userId]) || { marken: 0, rest: 0 };
  const meinKonto = {
    marken: (rk.marken || {})[userId] || 0,
    dienst: Object.assign({}, (rk.dienst || {})[userId] || {}),
    wocheMarken: wocheKonto.marken || 0,
    wocheDeckel: RK_MARKEN_WOCHE,
    markeJePunkte: RK_MARKE_JE_PUNKTE
  };
  return Object.assign({}, g, { randkriege: {
    stand: rk.stand, fronten, meinTag, meineBasis, meinKonto,
    tagesBreite: RK_TAGESSTUFEN.reduce((a, st) => a + st[0], 0),
    nachschubZuletzt: (db.private[userId] && db.private[userId].__rkNachschubAt) || 0
  } });
}
app.get('/api/galaxy', authMiddleware, (req, res) => {
  res.json(galaxyFuerClient(loadOrInitGalaxy(), req.userId));
});

// Aktuelle Marktpreise abrufen (inkl. Normalpreis, damit das Frontend "teuer/billig" anzeigen kann).
app.get('/api/market', authMiddleware, (req, res) => {
  const g = loadOrInitGalaxy();
  const market = loadOrInitMarket(g);
  // impactScale mitliefern, damit die Client-Vorschau dieselbe Slippage rechnet wie der Server
  // (eine Quelle der Wahrheit statt gespiegelter Konstanten - aktuell überall 1, der Mechanismus
  // bleibt für künftige Sonder-Ressourcen erhalten).
  const out = {};
  for (const key of Object.keys(MARKET_RESOURCES)) {
    out[key] = { price: market[key], basePrice: MARKET_RESOURCES[key].basePrice, min: MARKET_RESOURCES[key].min, max: MARKET_RESOURCES[key].max, impactScale: MARKET_RESOURCES[key].impactScale || 1, history: (g.marketHistory && g.marketHistory[key]) || [] };
  }
  // Tagesrest des Verkaufserloes-Deckels mitliefern (17.08.2026): Die Markt-Box zeigt damit von
  // Anfang an "heute noch X frei", statt dass der Spieler es erst an einer Ablehnung erfaehrt.
  const marktUser = findUserById(req.userId);
  const marktHeute = staubTagesschluessel();
  const marktRest = (marktUser && marktUser.marktTag && marktUser.marktTag.stempel === marktHeute)
    ? Math.max(0, MARKT_TAGES_ERLOES_MAX - marktUser.marktTag.erloes) : MARKT_TAGES_ERLOES_MAX;
  res.json({ market: out, event: g.marketEvent || null, tagesRest: marktRest, tagesMax: MARKT_TAGES_ERLOES_MAX });
});

// Ermittelt den Markt-Rabatt (Kartell-Ruf + Allianz-Handelsabkommen) SERVERSEITIG aus dem echten
// Spielstand bzw. den geteilten Allianz-Daten - Bug/Sicherheitslücke behoben (13.07.2026): vorher
// berechnete der CLIENT diesen Rabatt selbst und wendete ihn selbst auf die (ebenfalls clientseitig
// geführten) Kredit-/Ressourcen-Bestände an. Jeder mit Browser-Entwicklertools hätte sich dadurch
// einen beliebigen "Rabatt" (auch über 100%, auch negativ = Gratis-Ressourcen) selbst eintragen
// können, unabhängig davon, wie oft die Preisformel selbst nachgeschärft wird. Gleichzeitig
// Rabattdeckel von 20% auf 12% gesenkt (Balance-Wunsch).
const MARKET_DISCOUNT_CAP = 0.12;
function marketDiscountPctFor(save) {
  const rep = Math.max(-100, Math.min(100, (save.factionRep && save.factionRep.kartell) || 0));
  let pct = rep >= 70 ? 0.10 : (rep >= 30 ? 0.05 : 0);
  const tag = ((save.player && save.player.allianceTag) || '').trim().toUpperCase();
  if (tag) {
    try {
      const raw = db.shared['alliance:' + tag + ':unlocked'];
      if (raw) {
        const unlocked = JSON.parse(raw);
        const lvl = Number(unlocked.a_trade) || 0;
        const maxLevel = (ALLIANCE_STRUCTURE_COSTS.a_trade && ALLIANCE_STRUCTURE_COSTS.a_trade.maxLevel) || 20;
        pct += 0.08 * (lvl / maxLevel);
      }
    } catch (e) {}
  }
  return Math.min(MARKET_DISCOUNT_CAP, pct);
}

/* Routen-Erloese auf das Tageskontingent anrechnen (17.08.2026, Entscheidung Sascha: "Auf
   dasselbe Tageskontingent anrechnen"). VERKAUFSROUTEN verbuchen ihre Credits klientenseitig
   (processTradeRoutes im Frontend, ohne jeden Server-Aufruf) und liefen damit am Deckel vorbei -
   gemessen ~63k Credits je gebundenem Frachter und Tag, ohne Slippage; ab ~80 Frachtern
   ueberholte der Tropf den Deckel. Damit es EIN Kontingent ist, meldet der Client seine
   Routen-Erloese gebuendelt hierher, und sie zaehlen in denselben user.marktTag-Zaehler wie die
   direkten Verkaeufe.
   ZUR EINORDNUNG DER MISSBRAUCHSRICHTUNG (dieselbe Frage wie beim Sternenstaub, andere Antwort):
   Das ist eine KLIENTENGEMELDETE Zahl - aber sie kann das Kontingent nur VERKLEINERN, nie
   vergroessern. Wer die Meldung unterschlaegt, hat exakt den Stand von vor dieser Aenderung
   (Routen klientenautoritativ am Deckel vorbei - die Routen selbst verbucht ohnehin der Client);
   wer zu viel meldet, sperrt sich selbst den Direktverkauf. Es gibt hier nichts zu holen.
   Validierung trotzdem: ganzzahlig, positiv, je Meldung hoechstens ein Tages-Maximum. */
app.post('/api/market/routen-erloes', authMiddleware, (req, res) => {
  const credits = Math.floor(Number((req.body || {}).credits));
  if (!Number.isFinite(credits) || credits <= 0) return res.status(400).json({ error: 'ungültige Menge' });
  if (credits > MARKT_TAGES_ERLOES_MAX) return res.status(400).json({ error: 'Menge zu groß' });
  const user = findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'Konto nicht gefunden.' });
  const heute = staubTagesschluessel();
  if (!user.marktTag || user.marktTag.stempel !== heute) user.marktTag = { stempel: heute, erloes: 0 };
  user.marktTag.erloes += credits;
  saveDb();
  res.json({ ok: true, tagesRest: Math.max(0, MARKT_TAGES_ERLOES_MAX - user.marktTag.erloes), tagesMax: MARKT_TAGES_ERLOES_MAX });
});

// Handeln auf dem geteilten Markt. Body: { action:'buy'|'sell', resource, amount }.
// Server ist jetzt vollständig autoritativ: liest den echten Spielstand, prüft Kredite/Ressourcen
// dort, berechnet Preis UND Rabatt selbst, schreibt das Ergebnis direkt in den Spielstand zurück und
// gibt nur die neuen Gesamtwerte zurück - der Client übernimmt sie nur noch, rechnet nichts mehr
// selbst nach (siehe Kommentar bei marketDiscountPctFor für den Grund dieses Umbaus).
app.post('/api/market/trade', authMiddleware, async (req, res) => {
  const { action, resource, amount } = req.body || {};
  if (action !== 'buy' && action !== 'sell') return res.status(400).json({ error: 'ungültige Aktion' });
  if (!MARKET_RESOURCES[resource]) return res.status(400).json({ error: 'nicht handelbare Ressource' });
  const amt = Math.floor(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'ungültige Menge' });
  if (amt > 1000000) return res.status(400).json({ error: 'Menge zu groß (max. 1.000.000)' });

  const saveRaw = getSaveValue(req.userId);
  if (!saveRaw) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });
  let save;
  try { save = JSON.parse(saveRaw); } catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }
  save.resources = save.resources || {};

  const g = loadOrInitGalaxy();
  const market = loadOrInitMarket(g);
  const priceBefore = market[resource];
  // Durchschnittspreis über die gehandelte Menge (der Preis bewegt sich WÄHREND des Handels linear,
  // große Trades bekommen dadurch einen spürbar schlechteren Schnitt – realistische Slippage).
  const impact = (amt / 1000) * MARKET_IMPACT_PER_1000 * MARKET_RESOURCES[resource].basePrice * (MARKET_RESOURCES[resource].impactScale || 1);
  const priceAfterRaw = action === 'buy' ? priceBefore + impact : priceBefore - impact;
  const priceAfter = clampMarketPrice(resource, priceAfterRaw);
  // Klemm-korrekter Durchschnittspreis (Balance 21.07.2026, Spieler-Report "beim Verkauf von 900k gibt
  // es viel zu viele Kredite"): Ein sehr großer Trade drückt den Preis oft WEIT über den Boden/Deckel
  // hinaus. Bisher wurde trotzdem stur zwischen priceBefore und dem geklemmten Preis gemittelt - das
  // überzahlte Mega-Verkäufe massiv, weil die große Masse der Einheiten real am Boden gehandelt wird,
  // aber wie zum Mittelwert (priceBefore+Boden)/2 vergütet wurde. Jetzt: linear NUR bis die Grenze
  // erreicht ist, alle weiteren Einheiten zur Grenze. Kleine Trades (ohne Klemmung) bleiben unverändert.
  let avgPrice;
  if (priceAfterRaw === priceAfter) {
    avgPrice = (priceBefore + priceAfter) / 2;
  } else {
    const total = Math.abs(priceBefore - priceAfterRaw);
    const toBound = Math.abs(priceBefore - priceAfter);
    const f = total > 0 ? Math.min(1, toBound / total) : 0; // Anteil der Einheiten VOR dem Anschlag
    avgPrice = f * ((priceBefore + priceAfter) / 2) + (1 - f) * priceAfter;
  }
  const discount = marketDiscountPctFor(save);
  // Verkaufserlös reduziert (Geld-Brief-Spread), Kartell-/Allianz-Rabatt wirkt beim Verkauf als Bonus
  // obendrauf, beim Kauf als Abzug von den Kosten. Balance (21.07.2026, Spieler-Report "zu viele Kredite
  // beim Verkauf"): von 0.80 auf 0.55 gesenkt - Ressourcen zu Krediten zu machen ist damit deutlich
  // weniger lukrativ. Muss mit der Frontend-Vorschau estimateTradeCredits() übereinstimmen.
  const MARKET_SELL_SPREAD = 0.55;
  let credits;
  if (action === 'sell') {
    if ((save.resources[resource] || 0) < amt) return res.status(400).json({ error: 'Nicht genug ' + resource + ' zum Verkaufen.' });
    credits = Math.round(avgPrice * amt * MARKET_SELL_SPREAD * (1 + discount));
    /* Tagesumsatz-Deckel (17.08.2026, Begruendung bei MARKT_TAGES_ERLOES_MAX). Der Zaehler lebt
       am user-Objekt nach dem staub-Muster: Stempel pruefen, bei Tageswechsel zuruecksetzen, dann
       zaehlen - kein Cron, der Reset passiert beim ersten Zugriff des neuen UTC-Tages
       (staubTagesschluessel; fuer deutsche Spieler ist das 1 bzw. 2 Uhr nachts, das Frontend
       zeigt deshalb eine Restzeit statt "Mitternacht" zu behaupten).
       Die Pruefung steht VOR der ersten Mutation und die Fortschreibung im selben synchronen
       Block vor saveDb() - zwei parallele Verkaeufe koennen den Deckel so nicht gemeinsam
       durchbrechen (dieselbe Race-Begruendung wie bei der Modulboerse weiter unten).
       Abgelehnt wird mit 400, NICHT mit 429: Den 429 deutet der Sammelauftrag des Frontends
       als voruebergehend und wiederholte dieselbe Tranche bis zu dreimal mit je 20 s Wartezeit -
       ein erschoepftes Tageskontingent ist aber nicht voruebergehend, die Schleife soll sofort
       sauber stoppen. Die Ablehnung nennt Zahlen und traegt tagesRest als Feld, damit das
       Frontend den Rest anzeigen kann statt nur "fehlgeschlagen" zu sagen. */
    const traderUser = findUserById(req.userId);
    if (!traderUser) return res.status(404).json({ error: 'Konto nicht gefunden.' });
    const heute = staubTagesschluessel();
    if (!traderUser.marktTag || traderUser.marktTag.stempel !== heute) traderUser.marktTag = { stempel: heute, erloes: 0 };
    const tagesRest = Math.max(0, MARKT_TAGES_ERLOES_MAX - traderUser.marktTag.erloes);
    if (credits > tagesRest) {
      return res.status(400).json({
        error: tagesRest > 0
          ? 'Tageskontingent fast erreicht: Dieser Verkauf brächte ' + credits.toLocaleString('de-DE') + ' Credits, heute sind aber nur noch ' + tagesRest.toLocaleString('de-DE') + ' von ' + MARKT_TAGES_ERLOES_MAX.toLocaleString('de-DE') + ' frei. Verkaufe entsprechend weniger - morgen geht es weiter.'
          : 'Tageskontingent erreicht: ' + MARKT_TAGES_ERLOES_MAX.toLocaleString('de-DE') + ' Credits Verkaufserlös je Tag. Morgen geht es weiter.',
        tagesRest, tagesMax: MARKT_TAGES_ERLOES_MAX
      });
    }
    traderUser.marktTag.erloes += credits;
    save.resources[resource] -= amt;
    save.credits = (save.credits || 0) + credits;
  } else {
    credits = Math.round(avgPrice * amt * (1 - discount));
    if ((save.credits || 0) < credits) return res.status(400).json({ error: 'Nicht genug Kredite.' });
    save.credits -= credits;
    save.resources[resource] = (save.resources[resource] || 0) + amt;
  }

  market[resource] = priceAfter;
  const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));
  saveDb();

  // Das Restkontingent reist in JEDER Antwort mit (auch beim Kauf, dort nur informativ) - das
  // Frontend zeigt es an, statt dass der Spieler erst an einer Ablehnung erfaehrt, wo er steht.
  const antwortUser = findUserById(req.userId);
  const antwortHeute = staubTagesschluessel();
  const antwortRest = (antwortUser && antwortUser.marktTag && antwortUser.marktTag.stempel === antwortHeute)
    ? Math.max(0, MARKT_TAGES_ERLOES_MAX - antwortUser.marktTag.erloes) : MARKT_TAGES_ERLOES_MAX;
  res.json({
    ok: true,
    action, resource, amount: amt,
    credits,                 // beim Kauf: Kosten; beim Verkauf: Erlös (Rabatt bereits eingerechnet)
    discount,
    avgPrice,
    priceBefore, priceAfter,
    saveVersion: mySaveVersion,
    newCredits: save.credits,
    newResourceAmount: save.resources[resource],
    tagesRest: antwortRest, tagesMax: MARKT_TAGES_ERLOES_MAX
  });
});

// ===== Modulbörse: Spieler-zu-Spieler-Handel mit Modulen (25.07.2026) =====
// Bis hierher gab es keinen Weg, ein Modul an einen anderen Spieler abzugeben - Duplikate konnte man
// nur zerlegen oder verschmelzen. Die Börse arbeitet mit ECHTER TREUHAND: beim Einstellen verlässt
// das Modul sofort das Inventar des Verkäufers und liegt bis zum Kauf oder Rückzug ausschließlich im
// Angebot. Damit ist die gefährlichste Klasse von Fehlern - dasselbe Modul zweimal verkaufen oder es
// durch Einstellen zu verdoppeln - konstruktiv ausgeschlossen statt nur unwahrscheinlich gemacht.
//
// Warum das sicher ist, obwohl Node mehrere Requests bedient: Der gesamte Zustandswechsel eines
// Endpunkts (Listing prüfen, entfernen, Save schreiben) läuft synchron in EINEM Tick, ohne dazwischen-
// liegendes await. Zwei gleichzeitige Käufe desselben Angebots können sich deshalb nicht überlappen -
// der zweite findet das Listing bereits nicht mehr. Das erste await steht bewusst erst nach dem
// vollständigen Zustandswechsel (saveDb()).
//
// Ehrliche Grenze: Der Server kennt die Modul-Definitionen des Frontends nicht und kann nicht prüfen,
// ob ein instKey ein "legitimes" Modul beschreibt - er prüft nur Format und tatsächlichen BESITZ im
// gespeicherten Inventar. Wer seinen eigenen Spielstand manipuliert, könnte damit ein erfundenes
// Modul einstellen. Das ist dieselbe Vertrauensgrenze wie beim übrigen Spielstand (der Client
// schreibt ihn) und wird durch die Sanity-Limits gedeckelt, nicht durch diese Börse.
const MODULE_MARKET_MAX_LISTINGS_PER_USER = 5;   // gleichzeitig offene Angebote je Spieler
const MODULE_MARKET_MIN_PRICE = 1000;
const MODULE_MARKET_MAX_PRICE = 5000000;
const MODULE_MARKET_FEE_PCT = 0.05;              // Einstellgebühr, wird beim Verkauf vom Erlös abgezogen
const MODULE_MARKET_MAX_TOTAL = 300;             // Gesamtgröße der Börse (Schutz vor Zumüllen)
// instKey-Format aus dem Frontend: "<typ>:<seltenheit>[:<level>[:<substats>]]". Bewusst streng, damit
// keine beliebigen Zeichenketten in den geteilten Zustand wandern.
const MODULE_INSTKEY_RE = /^[a-z0-9_]{2,40}:[a-z]{4,14}(:\d{1,2})?(:[a-zA-Z0-9,._-]{1,60})?$/;
function loadOrInitModuleMarket() {
  if (!db.shared) db.shared = {};
  if (!Array.isArray(db.shared.__moduleMarket)) db.shared.__moduleMarket = [];
  return db.shared.__moduleMarket;
}
// Zählt ein Modul im Inventar des übergebenen Spielstands (nur NICHT ausgerüstete liegen dort - das
// Frontend nimmt ausgerüstete Module aus der Zählkarte heraus, siehe equipModule).
function moduleInvOf(save, isShip) {
  const key = isShip ? 'shipModules' : 'modules';
  if (!save[key] || typeof save[key] !== 'object') save[key] = {};
  return save[key];
}
function publicListing(l, viewerId) {
  return {
    id: l.id, isShip: !!l.isShip, instKey: l.instKey, price: l.price,
    sellerName: l.sellerName, createdAt: l.createdAt, mine: l.sellerId === viewerId
  };
}

// Offene Angebote ansehen. Bewusst ohne Auth-Zwang auf fremde Daten: es werden nur Modulschlüssel,
// Preis und Verkäufername ausgeliefert, keine Spielstände.
app.get('/api/modulemarket', authMiddleware, (req, res) => {
  const listings = loadOrInitModuleMarket();
  res.json({
    listings: listings.map(l => publicListing(l, req.userId)),
    limits: {
      maxPerUser: MODULE_MARKET_MAX_LISTINGS_PER_USER,
      minPrice: MODULE_MARKET_MIN_PRICE,
      maxPrice: MODULE_MARKET_MAX_PRICE,
      feePct: MODULE_MARKET_FEE_PCT
    }
  });
});

// Modul einstellen: wandert SOFORT aus dem Inventar in die Treuhand.
app.post('/api/modulemarket/list', authMiddleware, async (req, res) => {
  const { isShip, instKey, price } = req.body || {};
  const key = String(instKey || '');
  if (!MODULE_INSTKEY_RE.test(key)) return res.status(400).json({ error: 'Ungültiger Modulschlüssel.' });
  const p = Math.floor(Number(price));
  if (!Number.isFinite(p) || p < MODULE_MARKET_MIN_PRICE || p > MODULE_MARKET_MAX_PRICE) {
    return res.status(400).json({ error: 'Preis muss zwischen ' + MODULE_MARKET_MIN_PRICE + ' und ' + MODULE_MARKET_MAX_PRICE + ' Krediten liegen.' });
  }
  const listings = loadOrInitModuleMarket();
  if (listings.length >= MODULE_MARKET_MAX_TOTAL) return res.status(429).json({ error: 'Die Modulbörse ist gerade voll - bitte später erneut versuchen.' });
  const mine = listings.filter(l => l.sellerId === req.userId).length;
  if (mine >= MODULE_MARKET_MAX_LISTINGS_PER_USER) {
    return res.status(400).json({ error: 'Maximal ' + MODULE_MARKET_MAX_LISTINGS_PER_USER + ' eigene Angebote gleichzeitig.' });
  }
  const saveRaw = getSaveValue(req.userId);
  if (!saveRaw) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });
  let save;
  try { save = JSON.parse(saveRaw); } catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }
  const inv = moduleInvOf(save, !!isShip);
  if ((inv[key] || 0) < 1) return res.status(400).json({ error: 'Dieses Modul liegt nicht (mehr) in deinem Inventar. Ausgerüstete Module musst du erst abnehmen.' });
  // Treuhand: erst aus dem Inventar nehmen, dann einstellen - in dieser Reihenfolge, damit ein
  // Fehler beim Speichern niemals ein Angebot ohne Gegenwert hinterlässt.
  inv[key] -= 1;
  if (inv[key] <= 0) delete inv[key];
  const listing = {
    id: crypto.randomUUID(),
    sellerId: req.userId,
    sellerName: req.username,
    isShip: !!isShip,
    instKey: key,
    price: p,
    createdAt: Date.now()
  };
  listings.push(listing);
  const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));
  await saveDb();
  res.json({ ok: true, listing: publicListing(listing, req.userId), saveVersion: mySaveVersion });
});

// Eigenes Angebot zurückziehen: Modul kehrt ins Inventar zurück.
app.post('/api/modulemarket/cancel', authMiddleware, async (req, res) => {
  const { id } = req.body || {};
  const listings = loadOrInitModuleMarket();
  const idx = listings.findIndex(l => l.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Angebot nicht gefunden (vielleicht wurde es gerade gekauft).' });
  const listing = listings[idx];
  if (listing.sellerId !== req.userId) return res.status(403).json({ error: 'Das ist nicht dein Angebot.' });
  const saveRaw = getSaveValue(req.userId);
  if (!saveRaw) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });
  let save;
  try { save = JSON.parse(saveRaw); } catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }
  // Erst aus der Börse entfernen, dann zurücklegen - so kann das Modul nie gleichzeitig im Angebot
  // UND im Inventar liegen.
  listings.splice(idx, 1);
  const inv = moduleInvOf(save, listing.isShip);
  inv[listing.instKey] = (inv[listing.instKey] || 0) + 1;
  const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));
  await saveDb();
  res.json({ ok: true, instKey: listing.instKey, isShip: listing.isShip, saveVersion: mySaveVersion });
});

// Angebot kaufen.
app.post('/api/modulemarket/buy', authMiddleware, async (req, res) => {
  const { id } = req.body || {};
  const listings = loadOrInitModuleMarket();
  const idx = listings.findIndex(l => l.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Angebot nicht mehr verfügbar.' });
  const listing = listings[idx];
  if (listing.sellerId === req.userId) return res.status(400).json({ error: 'Du kannst dein eigenes Angebot nicht kaufen - zieh es stattdessen zurück.' });
  const saveRaw = getSaveValue(req.userId);
  if (!saveRaw) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });
  let save;
  try { save = JSON.parse(saveRaw); } catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }
  if ((save.credits || 0) < listing.price) return res.status(400).json({ error: 'Nicht genug Kredite (' + listing.price + ' nötig).' });
  // Ab hier bis saveDb() kein await: der komplette Übergang (Angebot weg, Käufer zahlt und erhält,
  // Verkäufer bekommt seine Gutschrift eingereiht) passiert in einem Tick und ist damit unteilbar.
  listings.splice(idx, 1);
  save.credits -= listing.price;
  const inv = moduleInvOf(save, listing.isShip);
  inv[listing.instKey] = (inv[listing.instKey] || 0) + 1;
  const fee = Math.round(listing.price * MODULE_MARKET_FEE_PCT);
  const payout = listing.price - fee;
  // Der Erlös geht NICHT direkt in den Spielstand des Verkäufers: der kann online sein, und sein
  // nächster Auto-Save würde die Gutschrift mit seinem älteren Client-Stand überschreiben (siehe
  // ausführliche Begründung bei /api/pending-rewards). Stattdessen die etablierte Warteschlange.
  pushPendingReward(listing.sellerId, {
    type: 'module-sale',
    credits: payout,
    instKey: listing.instKey,
    isShip: listing.isShip,
    price: listing.price,
    fee,
    buyerName: req.username,
    time: Date.now()
  });
  const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));
  await saveDb();
  res.json({
    ok: true,
    instKey: listing.instKey, isShip: listing.isShip, price: listing.price, fee,
    sellerName: listing.sellerName,
    saveVersion: mySaveVersion,
    newCredits: save.credits
  });
});

// Löst eine abgeschlossene Weltboss-Mission serverseitig auf. Bug/Sicherheitslücke behoben
// (13.07.2026): der komplette Schaden (inkl. "Tötung" des gemeinsamen Bosses) wurde bisher rein
// clientseitig berechnet und ungeprüft in den geteilten Speicher (worldboss:current) geschrieben -
// jeder hätte den Boss beliebig manipulieren (sofort töten, gefälschte Beitragswerte für sich selbst
// eintragen) und sich dabei echte, dauerhafte Kredite/Kampfpunkte verschaffen können. Der Server
// liest jetzt die tatsächliche, bereits gespeicherte Mission aus dem echten Spielstand, würfelt den
// Schaden selbst (aus der beim Missionsstart eingefrorenen Flottenzusammensetzung, nicht der
// aktuellen - sonst könnte man mit wenig Flotte starten und während der Flugzeit aufrüsten), wendet
// Verluste/Belohnungen serverseitig an und entfernt die Mission sofort aus der Liste (verhindert
// Mehrfachauflösung derselben Mission durch Doppelklick, Netzwerk-Retry oder Missbrauch).
const WORLDBOSS_KEY = 'worldboss:current';
// Rotierende Weltboss-Schwäche je Level (13.07.2026, Feature-Wunsch: Kontersystem auf mehr Kontexte
// ausweiten) - identisch zum Frontend (siehe pirateLairWeakness/WORLDBOSS_WEAKNESS dort). +25%
// Schaden bei passendem Schiffstyp in der Zusammensetzung.
const WORLDBOSS_WEAKNESS = ['jaeger','cruiser','bomber','destroyer','jaeger','schlachtschiff','cruiser','bomber','destroyer','jaeger'];
function worldBossWeakness(level) { return WORLDBOSS_WEAKNESS[(Math.max(1,level)-1) % WORLDBOSS_WEAKNESS.length]; }
// Archetypen des ANGREIFBAREN Weltbosses (02.08.2026). Spiegel von WORLDBOSS_ARCHETYPEN im Frontend -
// dort steht die ausführliche Begründung. Kurz: Die vier Varianten gab es bis zum 02.08.2026 nur
// beim Galaxie-Nachrichten-Boss, den niemand angreifen konnte (seit dem 18.08.2026 ganz entfernt,
// siehe den Block bei loadOrInitGalaxy); der angreifbare Boss hatte genau eine Ausprägung, obwohl
// Patchnote v8.211.0 die Varianten als Kampf-Feature angekündigt hatte.
//
// Ableitung DETERMINISTISCH aus der Stufe, nicht aus einem Feld des Boss-Dokuments: Das Dokument
// liegt im geteilten Speicher und wird von Clients geschrieben - ein dort mitgeführter Archetyp wäre
// fälschbar. Aus der Stufe gerechnet sind Client und Server zwangsläufig einig.
//
// Die HP bleiben bewusst unberührt (kein hpMult): Die Belohnung hängt an der Stufe, nicht an den HP -
// ein zäherer oder dünnerer Boss würde also still die Belohnungsrate verschieben. Die Varianten
// wirken stattdessen auf Schwächen-Bonus und Verlustquote, beides ertragsneutral.
const WORLDBOSS_ARCHETYPES_PLAYABLE = [
  { key: 'koloss',  schwaecheMult: 1.25, verlustMult: 1.0  },
  { key: 'bastion', schwaecheMult: 1.15, verlustMult: 1.35 },
  { key: 'schwarm', schwaecheMult: 1.25, verlustMult: 0.70 },
  { key: 'phantom', schwaecheMult: 1.50, verlustMult: 1.0  },
  { key: 'piraten', schwaecheMult: 1.40, verlustMult: 1.20 }
];
// Die REIHENFOLGE steht bewusst in einer eigenen Tabelle und ist NICHT die Reihenfolge der
// Archetypen selbst. Grund ist ein Zusammenspiel, das man leicht uebersieht: Der Bossname laeuft
// mit `% 5` durch WORLDBOSS_NAMES, der Archetyp lief bisher mit `% 4` - die KOMBINATION aus beidem
// wiederholte sich also erst nach kgV(5,4) = 20 Stufen. Ein fuenfter Archetyp haette daraus
// kgV(5,5) = 5 gemacht: Wer Stufe 6 sah, saehe dieselbe Paarung wie auf Stufe 1. Die Erweiterung
// haette die Abwechslung also VERVIERFACHT reduziert, obwohl sie eine Variante HINZUFUEGT.
// 20 Positionen, jeder Archetyp genau viermal, nie zweimal hintereinander (auch nicht ueber den
// Rundenwechsel 20 -> 1). Die Stufen 1-4 behalten ihre bisherige Zuordnung.
const WORLDBOSS_ARCHETYPE_FOLGE = [
  'koloss', 'bastion', 'schwarm', 'phantom', 'piraten',
  'bastion', 'koloss', 'phantom', 'schwarm', 'piraten',
  'schwarm', 'phantom', 'koloss', 'piraten', 'bastion',
  'phantom', 'piraten', 'bastion', 'koloss', 'schwarm'
];
function worldBossArchetypeOf(level) {
  const key = WORLDBOSS_ARCHETYPE_FOLGE[(Math.max(1, level | 0) - 1) % WORLDBOSS_ARCHETYPE_FOLGE.length];
  return WORLDBOSS_ARCHETYPES_PLAYABLE.find(a => a.key === key) || WORLDBOSS_ARCHETYPES_PLAYABLE[0];
}
function fleetHasShipType(fleet, type) {
  if (!fleet) return false;
  const fleetKey = { jaeger:'jaeger', bomber:'bomber', cruiser:'cruisers', destroyer:'destroyers', schlachtschiff:'schlachtschiff' }[type] || type;
  return (fleet[fleetKey] || 0) > 0;
}
function computeAttackPowerFromComposition(save, composition, bossLevel) {
  const research = save.research || {};
  let power = rawFleetPower(composition, 1, 1, save.shipMarks) * fleetDiversityMult(composition);
  const k = research.rkampf || 0, k2 = research.rkampf2 || 0;
  if (k) power *= (1 + k * 0.02);
  if (k2) power *= (1 + k2 * 0.02);
  power *= stanceOf(save).atkMult;
  // Der Schwächen-Bonus richtet sich seit dem 02.08.2026 nach dem Archetyp der Stufe: 1,15 beim
  // Panzer-Bastion, 1,50 beim Phasen-Phantom, sonst die bisherigen 1,25. Das Frontend zeigt genau
  // diese Zahl vor dem Angriff an (renderWorldBoss).
  if (bossLevel && fleetHasShipType(composition, worldBossWeakness(bossLevel))) power *= worldBossArchetypeOf(bossLevel).schwaecheMult;
  return Math.round(power);
}
app.post('/api/worldboss/resolve', authMiddleware, async (req, res) => {
  const { missionId, planetKey } = req.body || {};
  if (!missionId || !planetKey) return res.status(400).json({ error: 'missionId und planetKey erforderlich.' });

  const saveRaw = getSaveValue(req.userId);
  if (!saveRaw) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });
  let save;
  try { save = JSON.parse(saveRaw); } catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }

  const fleetObj = planetKey === 'home' ? save.fleet : (save.colonies && save.colonies[planetKey] && save.colonies[planetKey].fleet);
  if (!fleetObj || !Array.isArray(fleetObj.missions)) return res.status(404).json({ error: 'Kein Flottenstandort gefunden.' });
  const missionIdx = fleetObj.missions.findIndex(m => m.id === missionId && m.type === 'worldboss');
  if (missionIdx === -1) return res.status(404).json({ error: 'Mission nicht gefunden (evtl. bereits aufgelöst).' });
  const mission = fleetObj.missions[missionIdx];
  if (Date.now() < (mission.endTime || 0)) return res.status(400).json({ error: 'Mission ist noch nicht angekommen.' });

  fleetObj.missions.splice(missionIdx, 1);

  // 24h-Cooldown serverseitig durchgesetzt (nicht nur clientseitig beim Missionsstart geprüft) - im
  // eigenen Spielstand gespeichert (nicht am Boss-Objekt), damit die Sperre auch über einen
  // Boss-Respawn hinweg bestehen bleibt. Ohne diese Prüfung hier könnte man die Sperre umgehen, indem
  // man eine bereits "angekommene" Mission direkt im Spielstand präpariert und diesen Endpoint beliebig
  // oft aufruft.
  const cdLeft = Math.max(0, (save.worldBossLastAttack || 0) + 24 * 60 * 60 * 1000 - Date.now());
  if (cdLeft > 0) {
    save.credits = (save.credits || 0) + 50;
    const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));
    await saveDb();
    return res.json({ ok: true, arrivedTooLate: true, onCooldown: true, killed: false, damage: 0, bossHp: null, bossMaxHp: null, lostShips: {}, saveVersion: mySaveVersion, newCredits: save.credits, newBattlePoints: save.battlePoints });
  }
  save.worldBossLastAttack = Date.now();

  const bLevel = mission.bossLevel || 1;
  const composition = mission.composition || {};
  const power = computeAttackPowerFromComposition(save, composition, bLevel);
  const bossWeakness = worldBossWeakness(bLevel);
  const bossHasWeakness = fleetHasShipType(composition, bossWeakness);
  const dmg = Math.round(power * (0.8 + Math.random() * 0.4));

  const bossRaw = db.shared[WORLDBOSS_KEY];
  let boss = null;
  try { boss = bossRaw ? JSON.parse(bossRaw) : null; } catch (e) {}

  let killed = false, bossHpAfter = null, bossMaxHp = null, arrivedTooLate = false;
  const lostShips = {};
  if (!boss || boss.bossId !== mission.targetId || boss.defeatedAt) {
    arrivedTooLate = true;
    save.credits = (save.credits || 0) + 50;
  } else {
    boss.hp = Math.max(0, (boss.hp || 0) - dmg);
    boss.contributions = boss.contributions || {};
    const me = boss.contributions[req.userId] || { name: req.username || 'Kommandant', dmg: 0 };
    me.dmg = (me.dmg || 0) + dmg;
    me.name = req.username || me.name;
    boss.contributions[req.userId] = me;
    killed = boss.hp <= 0;
    if (killed) boss.defeatedAt = Date.now();
    bossHpAfter = boss.hp;
    bossMaxHp = boss.maxHp;
    db.shared[WORLDBOSS_KEY] = JSON.stringify(boss);

    // Verluste (8+Stufe% bis 15+Stufe%, gedeckelt bei 50%) - Prozentsatz aus der beim Start
    // eingefrorenen Zusammensetzung, angewendet auf die AKTUELLE Flotte am Standort.
    // Verlustquote mit dem Archetyp-Faktor (02.08.2026): Panzer-Bastion +35%, Schwarm-Titan -30%.
    // Der 50%-Deckel bleibt außen, damit auch die Bastion die Flotte nicht über die alte Obergrenze
    // hinaus abräumen kann.
    const lossPct = Math.min(0.5, ((0.08 + bLevel * 0.01) + Math.random() * 0.07) * worldBossArchetypeOf(bLevel).verlustMult);
    for (const k of ['jaeger','cruisers','destroyers','bomber','schlachtschiff','carrier','superschlachtschiff','frachter','frachtergross','bergungsfrachter','waechter']) {
      const sentCount = composition[k] || 0;
      if (sentCount <= 0) continue;
      const loseNow = Math.min(fleetObj[k] || 0, Math.round(sentCount * lossPct));
      if (loseNow > 0) { fleetObj[k] = Math.max(0, (fleetObj[k] || 0) - loseNow); lostShips[k] = loseNow; }
    }
    save.battlePoints = (save.battlePoints || 0) + 3 + bLevel;
  }

  const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));
  await saveDb();

  // Etappe B: das Boss-Set-Teil am Weltboss. Der Anteil kommt aus den SERVERSEITIG gefuehrten
  // Beitraegen, nicht aus einer gemeldeten Zahl - dieselbe Quelle, aus der auch der Unikat-Wurf im
  // Client seinen `share` bezieht. Gewuerfelt wird hier, damit der Client nur noch den Typ zieht
  // (Raid-Muster).
  //
  // Je SCHLAG, nicht je Kill - zwei Gruende, beide gemessen. (a) Der letzte Schlag ist Zufall; ihn
  // allein zu belohnen ist genau die Kritik, die beim Hort der Festung zum anteiligen Modell
  // gefuehrt hat. (b) Der `resolve`-Weg erreicht bauartbedingt nur den Anfragenden - "an alle
  // Beitragenden" braeuchte die Warteschlange, und die haelt nur 20 Eintraege (`slice(-20)`), ein
  // zweiter Eintrag je Fall verdraengte dort im Grenzfall einen Hort.
  //
  // `contributions[uid]` ist ein OBJEKT { name, dmg } - der erste Entwurf las `Number(b2)` und
  // bekam damit NaN, also Summe 0 und Anteil IMMER 0: der Anteilsfaktor waere still auf seinem
  // Sockel 0,4 eingefroren gewesen, ohne dass irgendetwas fehlgeschlagen waere.
  let bosssetWb = null;
  if (dmg > 0 && !arrivedTooLate && boss && boss.contributions) {
    const summe = Object.values(boss.contributions).reduce((a, c) => a + (Number(c && c.dmg) || 0), 0);
    const meinAnteilWb = summe > 0 ? (Number((boss.contributions[req.userId] || {}).dmg) || 0) / summe : 0;
    bosssetWb = bosssetPveWurf(BOSSSET_PVE_CHANCE.weltboss, meinAnteilWb, bLevel);
  }

  res.json({
    ok: true, arrivedTooLate, killed, damage: dmg,
    bossHp: bossHpAfter, bossMaxHp, lostShips, bossset: bosssetWb,
    hasWeakness: bossHasWeakness, weaknessType: bossWeakness,
    saveVersion: mySaveVersion,
    newCredits: save.credits, newBattlePoints: save.battlePoints
  });
});

// ===== Allianz-Raid: serverseitige Härtung (19.07.2026, Spieler-Wunsch "sicherer machen") =====
// Der Allianz-Raid lief bisher (wie der Musterangriff) rein clientseitig über generische
// storageSet-Aufrufe: jedes Mitglied konnte im eigenen Beitritts-Dokument einen frei erfundenen
// "power"-Wert eintragen und sich damit einen überproportionalen Belohnungsanteil UND den
// Top-Schädiger-Bonus (+50%) verschaffen, ohne dass die gemeldete Flotte je gegen den echten
// Spielstand geprüft wurde. Analog zur Weltboss-Härtung oben (/api/worldboss/resolve) verlagert
// dies die Beitritts-Validierung UND die komplette Wellen-Auflösung in den Server: Schiffszahlen
// werden gegen die tatsächliche Flotte des Standorts geprüft und dort abgezogen, Angriffskraft wird
// serverseitig aus der GEPRÜFTEN Zusammensetzung berechnet (nie vom Client übernommen), und die
// gesamte Wellen-Auflösung (Schaden, Verluste, Belohnung für ALLE Teilnehmer) läuft in EINEM
// serverseitigen Aufruf statt über einen client-seitigen "claim"-Schritt pro Spieler.
// Bewusst NICHT gehärtet: die Flugzeit zum Treffpunkt (travelSec/arrivesAtBaseAt) bleibt clientseitig
// gesetzt - exakt dieselbe Vertrauensannahme wie bei JEDER anderen Missionsart in diesem Spiel
// (Angriff, Expedition, auch der Weltboss-Anflug: mission.endTime wird dort ebenfalls ungeprüft vom
// Client übernommen, siehe oben) - keine raid-spezifische neue Lücke, nur Konsistenz mit dem
// bestehenden Modell.
const ALLIANCE_RAID_HP_BASE = 20000, ALLIANCE_RAID_HP_GROWTH = 1.4;
const ALLIANCE_RAID_COUNTER_BASE = 4000;
const ALLIANCE_RAID_DURATION_MS = 72 * 60 * 60 * 1000;
const ALLIANCE_RAID_RESTART_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const ALLIANCE_RAID_WAVE_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const ALLIANCE_RAID_GATHER_DURATIONS = [30 * 60, 60 * 60, 120 * 60];
// Test-Modus (19.07.2026): NUR aktiv, wenn die Umgebungsvariable explizit gesetzt ist (nie in
// Produktion) - erlaubt Integrationstests, die Sammel-/Flugzeiten OHNE echtes Warten von 30+ Minuten
// prüfen, ohne die Produktionswerte selbst anzutasten. Siehe test_allianceraid.js.
const ALLIANCE_RAID_TEST_MODE = process.env.ALLIANCE_RAID_TEST_MODE === '1';
const ALLIANCE_RAID_TEST_DISPATCH_SEC = 2;
// Leerenjäger + 4 Event-Kampfschiffe seit 19.07.2026 dabei (Balance-Entscheidung) - Utility-Schiffe
// ohne Angriffswert (gesandtenschiff/schuerfschiff) bewusst weiterhin nicht.
const ALLIANCE_RAID_ATTACK_SHIP_KEYS = ['jaeger', 'bomber', 'cruisers', 'destroyers', 'schlachtschiff', 'carrier', 'superschlachtschiff', 'waechter', 'nanoklinge', 'quantenkreuzer', 'fusionsdreadnought', 'leerenjaeger', 'kometenjaeger', 'enterschiff', 'phantomschiff', 'riftwaechter', 'hyperjaeger', 'hyperbomber'];
const ALLIANCE_RAID_RETREAT_THRESHOLD = 0.4, ALLIANCE_RAID_RETREAT_SAVE_FACTOR = 0.5;
// ===== Boss-Statuseffekte (07.08.2026, Frontend v8.438.0, Modul-Ausbau Etappe 2) =====
// Haengen an der VERBANDSZUSAMMENSETZUNG - dieselbe Sprache wie die Trefferschwaeche: Was die
// Allianz schickt, entscheidet, nicht wie viel. Beim Aufloesen einer Welle wird geprueft, ob die
// Schiffsanteile die Schwellen reissen; der Status wirkt dann in der NAECHSTEN Welle desselben
// Raids und wird dort verbraucht. Vollstaendig server-autoritativ: /resolve rechnet alles aus
// doc.dispatch.totalComposition, der Client zeigt nur die server-gesetzten Felder an (doc.status,
// waveResult.brandSchaden/statusVorher/statusNeu) - kein Spiegel, der driften kann. doc.status
// teilt das Vertrauensmodell von doc.hp (siehe Kommentar am Boss: das Dokument liegt im geteilten
// Speicher; belohnungsrelevant bleibt allein die server-gerechnete power).
// WER DIESE WERTE AENDERT, zieht den Status-Absatz der Allianz-Raid-Hilfe im Frontend mit -
// tests/test_bossstatus.js prueft die Prozentzahlen beider Seiten gegeneinander.
const ALLIANCE_RAID_STATUS = {
  brand:  { schiffe: ['bomber', 'hyperbomber'],  anteil: 0.15, wirkung: 0.06 }, // Boss verliert 6% Rest-HP zu Beginn der naechsten Welle
  frost:  { schiffe: ['cruisers', 'destroyers'], anteil: 0.25, wirkung: 0.20 }, // Gegenwehr der naechsten Welle -20% (weniger Verluste)
  schock: { schiffe: ['jaeger', 'hyperjaeger'],  anteil: 0.30 }                 // Trefferschwaeche gilt in der naechsten Welle als gedeckt
};
function allianceRaidHpFor(level) { return Math.round(ALLIANCE_RAID_HP_BASE * Math.pow(ALLIANCE_RAID_HP_GROWTH, Math.max(0, level - 1))); }
function allianceRaidCounterFor(level) { return Math.round(ALLIANCE_RAID_COUNTER_BASE * Math.pow(ALLIANCE_RAID_HP_GROWTH, Math.max(0, level - 1))); }
// Raid-Bosse (02.08.2026): Spiegel von ALLIANCE_RAID_BOSSE im Frontend, dort steht die ausfuehrliche
// Begruendung. Keine Regel fasst die Lebenspunkte an - die Belohnung faellt je WELLE an, ein zaeherer
// Boss braucht mehr Wellen und zahlt damit oefter.
// `name` nur für den Text der Push-Benachrichtigung (02.08.2026) - die Mechanik braucht ihn nicht.
// Die Namen MÜSSEN mit ALLIANCE_RAID_BOSSE im Frontend übereinstimmen, sonst kündigt die Push einen
// anderen Gegner an als der, der im Spiel steht. tests/test_allianzraid_anzeige.js im Frontend-Repo
// vergleicht beide Listen Eintrag für Eintrag.
// beuteMult/schwerpunkt (05.08.2026, Wunsch Sascha "mehrere raid bosse auswaehlbar mit
// verschiedenen belohnungen"): Seit die Allianz den Gegner WAEHLEN kann, braucht die Wahl einen
// Grund - sonst nimmt jeder immer den mit den geringsten Verlusten.
//   beuteMult  folgt dem RISIKO: Wer sich den haerteren Gegner vornimmt (hoeherer verlustMult),
//              bekommt mehr. Die zahmen 0,90er zahlen entsprechend etwas weniger.
//   schwerpunkt verschiebt, WAS faellt - diese Ressource kommt reichlicher, die uebrigen etwas
//              knapper. Die Gesamtmenge bleibt dadurch ungefaehr gleich; die Wahl ist also eine
//              Frage des Bedarfs ("wir brauchen diese Woche Kristalle"), nicht des Ertrags.
const ALLIANCE_RAID_BOSSES = [
  { key: 'sternenfresser', name: 'Sternenfresser', schwaeche: null,             ohneMult: 1.0,  verlustMult: 1.0,  beuteMult: 1.00, schwerpunkt: null },
  { key: 'panzerhuelle',   name: 'Panzerhülle',    schwaeche: 'bomber',         ohneMult: 0.75, verlustMult: 0.90, beuteMult: 0.92, schwerpunkt: 'erz' },
  { key: 'schwarmmutter',  name: 'Schwarmmutter',  schwaeche: 'jaeger',         ohneMult: 0.80, verlustMult: 1.25, beuteMult: 1.20, schwerpunkt: 'kristalle' },
  { key: 'phasenwandler',  name: 'Phasenwandler',  schwaeche: 'destroyers',     ohneMult: 0.75, verlustMult: 0.90, beuteMult: 0.92, schwerpunkt: 'deuterium' },
  { key: 'gluthorn',       name: 'Gluthorn',       schwaeche: 'schlachtschiff', ohneMult: 0.80, verlustMult: 1.20, beuteMult: 1.15, schwerpunkt: 'antimaterie' }
];
function allianceRaidBossOf(level) { return ALLIANCE_RAID_BOSSES[(Math.max(1, level | 0) - 1) % ALLIANCE_RAID_BOSSES.length]; }

// ===== Etappe B: die Boss-Set-Teile fallen auch ausserhalb der Allianz (28.08.2026) =====
// Auftrag Sascha, aus vier vorgelegten Quellen gewaehlt: ALLE VIER. Bis hierher fielen die 20
// Teile ausschliesslich nach einer Allianz-Raid-Welle (gemessen: `grantBossSetModule` hatte genau
// EINEN Aufrufer). Wer keine grosse Allianz hat, konnte sie also nie erreichen - die groesste
// inhaltliche Sperre des ganzen Modulsystems.
//
// Die Vorgabe des Konzepts lautet "langsamer und muehsamer, aber erreichbar" UND "der Raid soll
// der schnelle Weg bleiben, nicht der einzige". Beides ist GERECHNET, nicht geschaetzt:
//
//   Coupon-Collector ueber die 20 Teile, 20.000 Laeufe simuliert:
//     bis zum ERSTEN vollstaendigen Set : 19,3 erfolgreiche Wuerfe
//     bis ALLE 20 Teile                 : 71,9
//   Gelegenheiten eines Solo-Spielers je Tag (Abklingzeiten 6 h bzw. 4 h, 5 bzw. 4 Schlaege
//   je gefallenem Ziel): Festung 0,80 + Nest 1,50 = 2,30
//   Mit der Staffelung unten (gewichtet 0,130): erstes Set nach 65 Tagen, alle 20 nach 241 -
//   der Raid bleibt bei einer Welle je Tag 2,6-mal schneller, bei zweien 5,2-mal.
//
// Die erste Rechnung hatte 0,30 vorgesehen; gemessen waere der Raid damit nur 1,1-mal schneller
// gewesen, die Vorgabe also faktisch verletzt. Wer diese Zahlen anfasst, rechnet sie nach.
//
// GESTAFFELT nach Aufwand, nicht eine Zahl fuer alles: Wer eine Sternenfeste schleift, hat mehr
// verdient als wer eine Schanze knackt.
const BOSSSET_PVE_CHANCE = {
  festung: { 1: 0.08, 2: 0.16, 3: 0.30 },                    // Schanze / Kastell / Sternenfeste
  nest:    { 1: 0.05, 2: 0.09, 3: 0.15, 4: 0.24, 5: 0.45 },  // Sporenherd .. Koenigin
  // Der Weltboss bekommt die KLEINSTE Grundchance - und die erste Fassung dieses Kommentars
  // behauptete genau das Gegenteil ("die GROESSTE, weil er eine endliche Quelle ist"). Das war auf
  // die Annahme "je KILL" gerechnet; gewuerfelt wird aber je SCHLAG (Begruendung an der
  // Aufrufstelle). Damit ist er die einzige der drei Quellen mit einer GARANTIERTEN taeglichen
  // Gelegenheit - der 24-Stunden-Riegel des Weltboss-Angriffs -, waehrend Festungen und Nester
  // erst entstehen muessen. Nachgerechnet gegen die zwei anderen (0,333 Teile/Tag zusammen):
  // 0,07 gibt solo +0,070/Tag, also +21 %; 0,22 haette +66 % ergeben und die anderen beiden
  // Quellen dominiert.
  weltboss: 0.07
};
// Der Anteil staffelt wie im Raid (dort ueber `rShare`): Wer ein Zehntel des Schadens getragen
// hat, soll nicht dieselbe Chance haben wie der Hauptschaediger. Der Sockel von 0,4 ist Absicht -
// auch ein kleiner Beitrag soll sich lohnen, sonst floegen kleine Konten gar nicht erst mit.
function bosssetAnteilFaktor(anteil) {
  const a = Math.max(0, Math.min(1, Number(anteil) || 0));
  return 0.4 + 0.6 * a;
}
// DIE eine Stelle, an der ein PvE-Ziel ueber ein Boss-Set-Teil wuerfelt. Drei Aufrufer (Festung,
// Nest, Weltboss) - eine zweite Kopie waere die uebliche zweite Wahrheit, und bei einer Groesse,
// die PvP entscheidet, waere sie besonders teuer.
//
// Rueckgabe: null (nichts gefallen) oder { bossKey, seltenheit } - GENAU die zwei Felder, die
// `grantBossSetModule(bossKey, seltenheit)` im Frontend braucht. Der Server waehlt den Boss, weil
// die PvE-Ziele keinem zugeordnet sind; im Raid tut das der bekaempfte Boss selbst.
function bosssetPveWurf(basis, anteil, stufe) {
  const b = Number(basis) || 0;
  if (b <= 0) return null;
  if (Math.random() >= b * bosssetAnteilFaktor(anteil)) return null;
  const boss = ALLIANCE_RAID_BOSSES[Math.floor(Math.random() * ALLIANCE_RAID_BOSSES.length)];
  // Seltenheit nach Haerte des Ziels. 'mythisch' faellt hier so wenig wie im Raid - die Stufe ist
  // im ganzen Spiel kein Fundgegenstand.
  const roll = Math.random() + Math.max(0, (Number(stufe) || 1) - 1) * 0.06;
  const seltenheit = roll > 1.05 ? 'legendaer' : roll > 0.80 ? 'episch' : roll > 0.45 ? 'selten' : 'gewoehnlich';
  return { bossKey: boss.key, seltenheit };
}
// Der Boss EINES Dokuments. Die gewaehlte Sorte steht in doc.bossKey - das ist seit dem 19.07.2026
// gefahrlos, weil `alliance:<TAG>:raid` fuer Clients SCHREIBGESCHUETZT ist (siehe
// checkAllianceKeyPermission: "Allianz-Raid-Daten werden nur ueber die dedizierten Endpunkte
// geschrieben"). Vorher waere ein im Dokument mitgefuehrter Boss faelschbar gewesen, und genau
// deshalb leitete er sich stur aus der Stufe ab.
// Ohne bossKey bleibt es bei der Stufen-Ableitung: alte, noch laufende Raids aendern ihren Gegner
// nicht mitten im Zeitfenster.
function allianceRaidBossFor(doc) {
  const gewaehlt = doc && doc.bossKey && ALLIANCE_RAID_BOSSES.find(b => b.key === doc.bossKey);
  return gewaehlt || allianceRaidBossOf(doc ? doc.level : 1);
}

// ===== Raid-Belohnung nach RANG (05.08.2026, Wunsch Sascha) =====
//
// WUNSCH: "platz 1 bekommt am meisten nach unten immer weniger auch der schwächste bekommt
// belohnung ... es soll dort wertvolle belohnungen geben".
//
// BEFUND VORHER, nachgerechnet mit der alten Formel (Stufe 8, zehn Teilnehmer mit realistischen
// Anteilen 22/16/13/11/9/8/7/6/5/3 %):
//     Platz  1 ....... 1197 Kredite   (1,00x)
//     Platz  2 .......  744           (0,62x)
//     Platz 10 .......  627           (0,52x)
// Eine Staffelung GAB es also rechnerisch - aber Platz 2 bis Platz 10 lagen nur 19 % auseinander.
// Das ganze Gefaelle steckte in einem einzigen Sprung bei Platz 1 (`isTop ? x1,5`), danach war die
// Kurve flach: Wer Zweiter wurde, merkte keinen Unterschied zum Letzten.
//
// JETZT zwei Faktoren, die sich multiplizieren:
//   ANTEIL  (0,35 .. 1,00) - was jemand tatsaechlich beigetragen hat. Bleibt drin, damit nicht
//           zehn Mitlaeufer dasselbe bekommen wie zehn, die wirklich Flotte geschickt haben.
//   RANG    (1,00 .. 1,90) - gleitend ueber die Platzierung. Platz 1 bekommt das obere Ende, der
//           LETZTE genau 1,00 - nicht 0. Das ist die Zusage "auch der Schwaechste bekommt etwas":
//           Sie ist jetzt eine feste Untergrenze und keine Nebenwirkung der Anteilsformel mehr.
// Damit spannt sich Platz 2 bis Letzter ueber rund 120 % statt ueber 19 %, und jeder Platz
// unterscheidet sich sichtbar vom naechsten.
//
// DECKELUNG (bewusst, siehe CLAUDE.md-Fallstrick "N Minuten eigene Produktion"): Alle Mengen
// haengen NUR an der Bossstufe und am Rang, NIE an der eigenen Wirtschaft. Eine starke Allianz
// bekommt fuer denselben Boss dasselbe wie eine schwache - der Raid kann sich also nicht mit dem
// Reichtum der Teilnehmer aufschaukeln.
const ALLIANCE_RAID_RANK_SPREAD = 0.9;
// Rangfaktor: Platz 1 -> 1 + SPREAD, letzter Platz -> exakt 1. Bei nur einem Teilnehmer gibt es
// keine Rangordnung, der bekommt das obere Ende (er ist Erster UND Letzter, und er hat den Boss
// allein gestellt).
function allianceRaidRankFactor(platz, anzahl) {
  if (!(anzahl > 1)) return 1 + ALLIANCE_RAID_RANK_SPREAD;
  const p = Math.max(1, Math.min(anzahl, platz | 0));
  return 1 + ALLIANCE_RAID_RANK_SPREAD * ((anzahl - p) / (anzahl - 1));
}
// Rang-Anteil 0..1 (letzter = 0, erster = 1) - fuer die Beute, die es NUR oben gibt.
function allianceRaidRankShare(platz, anzahl) {
  if (!(anzahl > 1)) return 1;
  return (anzahl - Math.max(1, Math.min(anzahl, platz | 0))) / (anzahl - 1);
}
// Die vollstaendige Belohnung eines Teilnehmers. Eine Funktion, ein Rueckgabewert - damit die
// Vorschau im Spiel (Frontend) und die Auszahlung nicht auseinanderlaufen koennen, und damit ein
// Test sie ohne HTTP-Aufruf durchrechnen kann.
//
// ABSICHTLICH NICHT DABEI: Tier-2-Ressourcen. Das Spiel sagt an mehreren Stellen ausdruecklich zu,
// dass sie ausschliesslich aus den eigenen Fabriken kommen und nicht einmal handelbar sind - eine
// Raid-Ausschuettung wuerde genau diese Regel aushebeln. Stattdessen Antimaterie (knapp, und aus
// einem Kampf zu holen ist stimmig) und Modulfragmente.
function allianceRaidRewardFor(level, share, platz, anzahl, destroyed, boss) {
  const lvl = Math.max(1, level | 0);
  const rang = allianceRaidRankFactor(platz, anzahl);
  const rShare = allianceRaidRankShare(platz, anzahl);
  const anteil = 0.35 + 0.65 * Math.max(0, Math.min(1, share));
  const siegMult = destroyed ? 1 : 0.6;
  // Boss-Faktoren (05.08.2026). Ohne uebergebenen Boss bleibt alles wie vorher - der Parameter ist
  // optional, damit ein Aufrufer ohne Boss-Kenntnis (und der Test) weiterhin rechnen kann.
  const bMult = (boss && boss.beuteMult) || 1;
  const schwer = (boss && boss.schwerpunkt) || null;
  const gesamt = anteil * rang * siegMult * bMult;
  // ===== Der Schwerpunkt verschiebt die ZUSAMMENSETZUNG, nicht die Gesamtmenge =====
  // ERSTER ANLAUF WAR FALSCH und der eigene Test hat es gefangen: feste Faktoren (betonte
  // Ressource x1,7, uebrige x0,8) sind NICHT mengenneutral, weil die drei Grundmengen sehr
  // verschieden gross sind (Erz 600+500L gegen Deuterium 180+160L). Erz zu betonen brachte dadurch
  // +26 % Gesamtertrag, Deuterium nur +5 % - die Panzerhuelle waere stillschweigend die beste
  // Ressourcenwahl gewesen, und die Boss-Wahl haette wieder eine offensichtlich richtige Antwort
  // gehabt.
  // Jetzt wird UMVERTEILT: Die betonte Ressource bekommt 70 % ihrer eigenen Grundmenge dazu, und
  // genau dieser Betrag wird den anderen beiden im Verhaeltnis ihrer Grundmengen abgezogen. Die
  // Summe der drei bleibt damit exakt gleich, egal welche betont wird.
  const basis = { erz: 600 + lvl * 500, kristalle: 380 + lvl * 320, deuterium: 180 + lvl * 160 };
  const anteilig = Object.assign({}, basis);
  if (schwer && basis[schwer] !== undefined){
    const extra = basis[schwer] * 0.7;
    const restSumme = Object.keys(basis).reduce((s, k) => k === schwer ? s : s + basis[k], 0);
    anteilig[schwer] = basis[schwer] + extra;
    for (const k of Object.keys(basis)){
      if (k === schwer) continue;
      anteilig[k] = Math.max(0, basis[k] - extra * (basis[k] / restSumme));
    }
  }
  // Antimaterie steht ausserhalb dieser Umverteilung: Sie faellt nur bei erlegtem Boss und ist
  // die knappste Belohnung ueberhaupt. Ein Gegner mit Antimaterie-Schwerpunkt betont sie deshalb
  // zusaetzlich, ohne den drei Grundressourcen etwas wegzunehmen - das ist gewollt und der Grund,
  // warum genau dieser Gegner den zweithoechsten Ertragsfaktor traegt.
  const amFaktor = schwer === 'antimaterie' ? 1.7 : 1;
  return {
    credits: Math.round((300 + lvl * 150) * gesamt),
    battlePoints: Math.round((8 + lvl * 4) * gesamt),
    // War bis hierher FLACH: 20 bei Sieg, 12 sonst - unabhaengig von Bossstufe UND Beitrag. Ein
    // Stufe-20-Boss gab genauso viel wie Stufe 1. Jetzt an beidem haengend.
    xp: Math.round((10 + lvl * 6) * gesamt),
    resources: {
      erz: Math.round(anteilig.erz * gesamt),
      kristalle: Math.round(anteilig.kristalle * gesamt),
      deuterium: Math.round(anteilig.deuterium * gesamt),
      // Antimaterie nur bei erlegtem Boss. Die 0,15 als Sockel: Auch der Letzte bekommt etwas,
      // aber die Spitze bekommt ein Vielfaches - das ist der Anreiz, wirklich Flotte zu schicken.
      // Math.ceil statt round beim Sockel: Bei kleinen Stufen wuerde der letzte Platz sonst auf 0
      // abgerundet, und die Zusage "auch der Schwaechste bekommt etwas" waere gebrochen.
      antimaterie: destroyed ? Math.max(1, Math.round((2 + lvl * 1.2) * (0.15 + 0.85 * rShare) * bMult * amFaktor)) : 0
    },
    // Modulfragmente: die eigentliche "wertvolle" Beute. Sie zahlen direkt auf Modul-Aufwertung,
    // Neu-Wuerfeln und Schmelze ein und sind sonst nur muehsam zu bekommen.
    fragments: destroyed ? (1 + Math.round((2 + lvl * 0.7) * rShare * bMult)) : 0
  };
}
// Modulfund: Chance und Seltenheit entscheidet ab jetzt der SERVER.
// Vorher lag beides im Browser (`Math.random()` im Client, und der Client vergab das Modul selbst) -
// als einziges Stueck einer sonst durchgehend server-autoritativen Kette. Der Client zieht weiterhin
// den konkreten TYP aus seinen eigenen Tabellen (MODULE_DEFS samt Herkunfts-Filtern); ihn hierher zu
// spiegeln waere eine zweite Kopie einer Frontend-Tabelle, und genau davor warnt CLAUDE.md. Die
// balancerelevanten Groessen - ob ueberhaupt etwas faellt und wie selten - liegen jetzt hier.
// ===== Etappe C1: die Bossstufe entscheidet ueber die SPITZE des Beutetischs (28.08.2026) =====
// Anlass: Das Beute-Konzept nennt den Raid-Beutetisch "stufenunabhaengig". Gemessen stimmt das
// nicht - Fallchance (+1 Pp/Stufe) und Seltenheitswurf (+0,4 Pp/Stufe) haengen laengst an der
// Stufe. Was fehlte, war eine Stufe, die man ueberhaupt noch erreichen kann: Die Fallchance laeuft
// ab Stufe 15 in ihren Deckel (Math.min(0.75, ...)), und weiter als Stufe ~18 kommt niemand, weil
// die Boss-HP mit 1,4 je Stufe wachsen (Stufe 20 = 54 Wellen a 2 h > 72-h-Fenster des Raids). Ein
// staerkerer Auftrieb auf die Fallchance waere damit ein Rabatt auf eine Schranke, die schon
// bindet - genau die Falle aus der Festungs-Blockade und aus Abgrund C2.
//
// Der freie Kanal ist die SELTENHEIT: Sie hat keinen Deckel, endet aber bei 'legendaer'.
//
// DIE SCHWELLE 10 IST GELIEHEN, NICHT GEGRIFFEN: Es ist dieselbe Stufe, ab der das Grossprojekt
// (ALLIANCE_MISSION_CADENCES.monthly, minLevel: 10) mythische Module ausschuetten kann - die eine
// vergleichbare Quelle, die es im Spiel gibt.
//
// KALIBRIERT gegen die Frequenz, nicht gegen die Einzelchance (die Bezugsgroesse zuerst pruefen):
// Ein Modul faellt nur bei der KILL-Welle (destroyed), also genau einmal je Raid, und ein Raid auf
// Stufe 15 dauert gemessen 29 h (1 h Sammelphase + 11 Wellen a 2 h + 6 h Restart-Sperre). Fuer den
// Hauptschaediger ergibt das je Monat:
//     Stufe 10: 0,14   Stufe 12: 0,33   Stufe 15: 0,37   Stufe 18: 0,24 Stueck
// Das MAXIMUM liegt bei Stufe 15, nicht oben - die HP wachsen schneller, als die Chance steigt.
// Wer die Stufe hochtreibt, bekommt bessere Chancen JE KILL, aber nicht mehr Module je Monat; eine
// Farm-Spitze am oberen Ende entsteht dadurch gar nicht erst.
//
// WARUM DAS TROTZ 0,37/MONAT UNBEDENKLICH IST, gemessen statt behauptet: Mythische Module an sich
// sind fuer ein Endspiel-Konto keine Raritaet - die Mythische Modulschmiede fertigt sie
// deterministisch fuer 15 Metamaterial-Gewebe + 8 Singularitaetskerne, unbegrenzt oft. Was sie
// NICHT kann, ist ein Boss-Set-Teil: Die tragen HERKUNFT_BOSS und sind aus jeder Schmiede, aus
// jedem Fundtopf und aus dem Verschmelzen ausgeschlossen. "Mythisch UND Boss-Set-Teil" gibt es auf
// keinem anderen Weg im Spiel - und bei 20 Teilen dauert ein einzelnes VOLLSTAENDIGES mythisches
// Set im Erwartungswert rund 11 Monate.
//
// Der SET-Bonus bleibt dabei unberuehrt: setBonusAt im Frontend liest nur den TYP des Moduls
// (k.split(':')[0]), nicht seine Seltenheit. Mythisch aendert allein den Einzelbonus des Stuecks
// (MODULE_RARITY_MULT 3,5 -> 5,0, also +43 %) - eine begrenzte und benennbare Balance-Folge.
const ALLIANCE_RAID_MYTHISCH_AB = 10;
const ALLIANCE_RAID_MYTHISCH_JE_STUFE = 0.015;
const ALLIANCE_RAID_MYTHISCH_MAX = 0.12;
// KOPIE-FAMILIE: Dieselbe Funktion steht im Frontend (Belohnungsvorschau des Raids, seit
// v8.607.0), und tests/test_raid_belohnung_paritaet.js rechnet beide Fassungen AUSGEFUEHRT
// gegeneinander. Wer eine der drei Zahlen anfasst, fasst beide Repos an.
function allianceRaidMythischChance(level) {
  const lvl = Math.max(1, level | 0);
  if (lvl < ALLIANCE_RAID_MYTHISCH_AB) return 0;
  return Math.min(ALLIANCE_RAID_MYTHISCH_MAX, (lvl - ALLIANCE_RAID_MYTHISCH_AB + 1) * ALLIANCE_RAID_MYTHISCH_JE_STUFE);
}
function allianceRaidModuleDrop(level, platz, anzahl, destroyed) {
  if (!destroyed) return null;
  const rShare = allianceRaidRankShare(platz, anzahl);
  const chance = Math.min(0.75, 0.15 + 0.45 * rShare + Math.max(1, level | 0) * 0.01);
  if (Math.random() >= chance) return null;
  // Auftrieb der Seltenheit durch Rang und Bossstufe.
  const roll = Math.random() + rShare * 0.18 + Math.max(1, level | 0) * 0.004;
  if (roll > 1.02) {
    // Ab ALLIANCE_RAID_MYTHISCH_AB steigt ein legendaeres Teil mit wachsender Chance zu MYTHISCH auf
    // (Etappe C1). Hier stand vorher, 'mythisch' sei "im ganzen Spiel kein Fundgegenstand" - das war
    // gemessen falsch und haette diese Etappe beinahe blockiert: MODULE_RARITY im Frontend sagt
    // "bewusst NICHT im normalen Fundpool", nennt aber die hochstufigen Allianzmissionen
    // ausdruecklich als Weg (grantAllianceMissionBonusModule wertet legendaer mit 8% auf mythisch
    // auf). Aus "nicht im normalen Fundpool" war im Kommentar ein "gibt es nirgends" geworden.
    //
    // WARUM DIE SPITZE UND NICHT DIE BREITE: Aufgewertet wird nur der LEGENDAERE Ast. Ein
    // gewoehnlicher Wurf soll durch die Bossstufe nicht ploetzlich mythisch werden - die Stufe
    // verbessert, was oben herauskommt, nicht den Durchschnitt. Dasselbe Muster wie beim
    // Praezedenzfall, wo die 8% ebenfalls nur auf 'legendaer' greifen.
    // Der Wurf wird nur gezogen, wenn die Stufe ihn ueberhaupt zulaesst - sonst verschoebe ein
    // Aufruf unterhalb der Schwelle die Zufallsfolge, ohne je etwas zu entscheiden.
    const pMyth = allianceRaidMythischChance(level);
    if (pMyth > 0 && Math.random() < pMyth) return 'mythisch';
    return 'legendaer';
  }
  if (roll > 0.86) return 'episch';
  if (roll > 0.55) return 'selten';
  return 'gewoehnlich';
}
function allianceRaidDampenLoss(pct) {
  if (pct <= ALLIANCE_RAID_RETREAT_THRESHOLD) return pct;
  const excess = pct - ALLIANCE_RAID_RETREAT_THRESHOLD;
  return ALLIANCE_RAID_RETREAT_THRESHOLD + excess * (1 - ALLIANCE_RAID_RETREAT_SAVE_FACTOR);
}
function computeAllianceRaidPower(save, composition) {
  const research = save.research || {};
  let power = rawFleetPower(composition, 1, 1, save.shipMarks) * fleetDiversityMult(composition);
  if (research.rkampf) power *= (1 + research.rkampf * 0.02);
  if (research.rkampf2) power *= (1 + research.rkampf2 * 0.02);
  power *= stanceOf(save).atkMult;
  return Math.round(power);
}
function allianceRaidFleetObj(save, planetKey) {
  if (planetKey === 'home') return save.fleet;
  return save.colonies && save.colonies[planetKey] && save.colonies[planetKey].fleet;
}
function getAllianceRaidDoc(tag) {
  const raw = db.shared['alliance:' + tag + ':raid'];
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function setAllianceRaidDoc(tag, doc) { db.shared['alliance:' + tag + ':raid'] = JSON.stringify(doc); }
// Spiegel von allianceRaidVorbei() im Frontend (02.08.2026). Beide Seiten MUESSEN dieselbe Antwort
// geben: Die Oberflaeche entscheidet damit, ob sie "Raid ausrufen" anbietet, der Server, ob er es
// erlaubt und ob /cleanup aufraeumen darf. Laufen sie auseinander, zeigt das Spiel einen Knopf, den
// der Server ablehnt - oder umgekehrt.
//
// Positiv formuliert: NUR die erkennbar laufenden Faelle gelten als laufend. Ein unbekannter oder
// halb geschriebener Zustand faellt damit automatisch auf "vorbei", statt in einer Sackgasse zu
// enden. Das ist die sichere Richtung, denn "vorbei" heisst hier nur "ein neuer Raid darf
// ausgerufen werden" - Belohnungen haengen ausschliesslich an lastWaveResult/result.
function allianceRaidVorbeiServer(doc) {
  if (!doc) return true;
  if (doc.phase === 'gathering') return false;
  if (doc.phase === 'enroute' && doc.dispatch) return false;
  if (doc.phase === 'resolved') return true;
  if ((doc.hp || 0) <= 0) return true;
  if ((doc.expiresAt || 0) <= Date.now()) return true;
  return doc.phase !== 'idle';
}
function allianceRaidWaveKey(doc) { return doc ? doc.id + '-w' + (doc.waveNumber || 1) : null; }
function listAllianceRaidJoins(tag, waveKey) {
  const prefix = 'alliance:' + tag + ':raidjoin:' + waveKey + ':';
  const out = [];
  for (const k of Object.keys(db.shared)) {
    if (!k.startsWith(prefix)) continue;
    try {
      const doc = JSON.parse(db.shared[k]);
      if (doc && !doc.cancelled) out.push(Object.assign({ playerId: k.slice(prefix.length) }, doc));
    } catch (e) {}
  }
  return out;
}

// Neuen Boss ausrufen ODER die nächste Welle gegen einen angeschlagenen ('idle') Boss starten - nur
// Admin/Offizier, exakt dieselbe Zustandsmaschine wie vorher im Frontend (Stufe steigt nur nach
// echtem Sieg, kein Straf-Sprung bei ungenutztem Entkommen).
app.post('/api/allianceraid/create', authMiddleware, async (req, res) => {
  const { tag, gatherSeconds, bossKey } = req.body || {};
  const gatherOk = ALLIANCE_RAID_GATHER_DURATIONS.includes(gatherSeconds) || (ALLIANCE_RAID_TEST_MODE && Number(gatherSeconds) > 0);
  if (!tag || !gatherOk) return res.status(400).json({ error: 'Ungültige Anfrage.' });
  // Gegner-Wahl (05.08.2026). Gegen die feste Liste geprueft statt uebernommen - ein erfundener
  // Schluessel wuerde sonst in allianceRaidBossFor auf die Stufen-Ableitung zurueckfallen und dort
  // still einen anderen Gegner ergeben, als die Allianz gewaehlt hat.
  if (bossKey !== undefined && bossKey !== null && bossKey !== '' && !ALLIANCE_RAID_BOSSES.some(b => b.key === bossKey)) {
    return res.status(400).json({ error: 'Unbekannter Raid-Gegner.' });
  }
  const myRole = allianceRoleOf(tag, req.userId);
  if (myRole !== 'admin' && myRole !== 'officer') return res.status(403).json({ error: 'Nur Admins/Offiziere können einen Allianz-Raid ausrufen.' });
  const baseRaw = db.shared['alliance:' + tag + ':base'];
  let base = null;
  try { base = baseRaw ? JSON.parse(baseRaw) : null; } catch (e) {}
  if (!base || !base.foundedAt) return res.status(400).json({ error: 'Der Allianz-Raid braucht eine gegründete Allianzbasis als Treffpunkt.' });

  const now = Date.now();
  const existing = getAllianceRaidDoc(tag);
  // "Laeuft schon eine Welle?" - ein 'enroute' OHNE dispatch zaehlt NICHT als laufend (02.08.2026,
  // Spieler-Report "Allianz-Raid nicht startbar"). Ein solches Dokument beschreibt keinen fliegenden
  // Verband: Es gibt keine Ankunftszeit, keine Teilnehmer und keine Zusammensetzung, /resolve kann
  // damit nichts anfangen (`doc.phase !== 'enroute' || !doc.dispatch` -> Abbruch) und bleibt deshalb
  // fuer immer stehen. Bisher lehnte /create trotzdem mit 409 ab, womit die Allianz dauerhaft ohne
  // Raid dastand. Das Frontend beurteilt es seit v8.379.1 genauso (allianceRaidVorbei) - beide
  // Seiten muessen dieselbe Antwort geben, sonst zeigt die Oberflaeche einen Knopf, den der Server
  // ablehnt.
  const laeuftNoch = existing && (existing.phase === 'gathering' || (existing.phase === 'enroute' && existing.dispatch));
  if (laeuftNoch) {
    return res.status(409).json({ error: 'Es läuft bereits eine Angriffswelle gegen den Sternenfresser.' });
  }
  let doc;
  if (existing && existing.phase === 'idle' && existing.expiresAt > now) {
    const waveCdLeft = Math.max(0, (existing.lastWaveEndedAt || 0) + ALLIANCE_RAID_WAVE_COOLDOWN_MS - now);
    if (waveCdLeft > 0) return res.status(429).json({ error: 'Nächste Welle noch nicht bereit.', waveCdLeft });
    doc = existing;
    doc.waveNumber = (doc.waveNumber || 1) + 1;
    doc.phase = 'gathering'; doc.gatherEndsAt = now + gatherSeconds * 1000; doc.dispatch = null;
    // bossKey wird hier ABSICHTLICH NICHT uebernommen: Das ist eine Folgewelle gegen denselben,
    // bereits angeschlagenen Gegner. Ihn zwischen zwei Wellen zu tauschen waere weder erklaerbar
    // (die HP laufen weiter) noch fair - man koennte sich nach der ersten Welle den Gegner mit der
    // besseren Beute aussuchen. Gewaehlt wird beim AUSRUFEN eines neuen Raids.
  } else {
    // Ohne `result` auf "jetzt" begrenzen (02.08.2026) - gleiche Korrektur wie im Frontend. Ein
    // kaputtes Dokument, dessen Zeitfenster noch in der Zukunft liegt, haette sonst eine Sperre von
    // 6 Stunden AB diesem kuenftigen Zeitpunkt erzeugt, also eine Wartezeit, die es nie gab. Fuer
    // regulaer beendete Raids aendert sich nichts: die haben immer ein `result` mit `resolvedAt`.
    const endedAt = existing ? (existing.result ? existing.result.resolvedAt : Math.min(existing.expiresAt || 0, now)) : 0;
    const restartCdLeft = existing ? Math.max(0, (endedAt || 0) + ALLIANCE_RAID_RESTART_COOLDOWN_MS - now) : 0;
    if (restartCdLeft > 0) return res.status(429).json({ error: 'Nächster Allianz-Raid noch nicht bereit.', restartCdLeft });
    const level = existing && existing.result && existing.result.destroyed ? (existing.level || 1) + 1 : (existing ? (existing.level || 1) : 1);
    const pool = SYSTEMS.filter(s => s !== base.sector);
    const sourceList = pool.length ? pool : SYSTEMS;
    const targetSector = sourceList[Math.floor(Math.random() * sourceList.length)];
    doc = {
      id: 'raid' + now, level, maxHp: allianceRaidHpFor(level), hp: allianceRaidHpFor(level), targetSector,
      waveNumber: 1, startedAt: now, expiresAt: now + ALLIANCE_RAID_DURATION_MS, gatherEndsAt: now + gatherSeconds * 1000,
      phase: 'gathering', dispatch: null, lastWaveResult: null, lastWaveEndedAt: null, result: null,
      // Ohne Wahl bleibt es bei der bisherigen Ableitung aus der Stufe - wer nichts auswaehlt,
      // bekommt genau das, was er vor dem Update bekommen haette.
      bossKey: bossKey || allianceRaidBossOf(level).key
    };
  }
  setAllianceRaidDoc(tag, doc);
  await saveDb();

  // Alle Mitglieder benachrichtigen (02.08.2026, Wunsch).
  //
  // WARUM GERADE HIER: Ein Allianz-Raid hat als einziges Gemeinschaftsereignis eine harte Frist, die
  // man verpassen kann, ohne etwas falsch gemacht zu haben - die Sammelphase dauert 30 bis 120
  // Minuten, und wer seine Flotte nicht rechtzeitig an der Basis hat, ist bei der Welle nicht dabei.
  // Bis hierher wurde der Aufruf ausschließlich in den Allianz-Chat geschrieben, also genau dorthin,
  // wo man ihn nur sieht, wenn man ohnehin schon im Spiel ist. Für jeden, der es nicht ist - und das
  // sind bei einem Idle-Spiel die meisten - existierte der Aufruf schlicht nicht.
  //
  // NICHT an den Ausrufenden selbst: Er hat den Knopf gerade gedrückt.
  // Der Versand steht bewusst NACH saveDb() und ohne await: Eine hängende Push-Zustellung darf die
  // Antwort auf den Ausruf nicht verzögern, und der Raid ist zu diesem Zeitpunkt schon sicher
  // gespeichert. sendWebPushToUser() schluckt seine Fehler ohnehin selbst.
  try {
    const boss = allianceRaidBossFor(doc);   // die GEWAEHLTE Sorte, sonst kuendigt die Push einen anderen Gegner an
    for (const memberId of allianceMemberIds(tag)) {
      if (memberId === req.userId) continue;
      const user = findUserById(memberId);
      if (!user) continue;
      const prefs = getNotifPrefs(user);
      if (!prefs.enabled || !prefs.allianceraid) continue;
      pushNotificationEvent(memberId, 'alliance-raid', {
        tag, byName: req.username, bossName: (boss && boss.name) || 'Sternenfresser',
        level: doc.level, waveNumber: doc.waveNumber, gatherSeconds
      });
    }
  } catch (e) { console.error('Raid-Benachrichtigung fehlgeschlagen (der Raid selbst läuft):', e.message); }

  res.json({ ok: true, doc });
});

// Abgelaufenen/toten Raid abschließen (02.08.2026, Spieler-Report "Allianz-Raid nicht startbar").
//
// WARUM ES DEN ENDPUNKT BRAUCHT: Das Frontend hat ein abgelaufenes Raid-Dokument bisher SELBST auf
// 'resolved' gesetzt und per PUT /api/storage/alliance:<TAG>:raid zurückgeschrieben. Seit der
// Härtung vom 19.07.2026 lehnt checkAllianceKeyPermission genau diesen Schreibvorgang mit 403 ab
// ("Allianz-Raid-Daten werden nur über die dedizierten Endpunkte geschrieben") - richtig so, aber
// die aufrufende Stelle im Frontend fing den Fehler stillschweigend ab, setzte ihren LOKALEN Cache
// trotzdem auf 'resolved' und schrieb sogar eine Chat-Meldung "ist ungenutzt entkommen". Für den
// einzelnen Spieler sah es damit aufgeräumt aus, im geteilten Speicher blieb das Dokument aber
// unverändert stehen - für die ganze Allianz, dauerhaft. Empirisch bestätigt (403 auf PUT).
//
// Die Prüfung liegt bewusst hier und nicht beim Aufrufer: allianceRaidVorbeiServer() entscheidet
// serverseitig, ob wirklich nichts mehr läuft. Ein Mitglied kann damit KEINE laufende Welle
// abbrechen - dafür gibt es keinen Weg, auch nicht über einen manipulierten Client.
app.post('/api/allianceraid/cleanup', authMiddleware, async (req, res) => {
  const { tag } = req.body || {};
  if (!tag) return res.status(400).json({ error: 'Ungültige Anfrage.' });
  if (!allianceRoleOf(tag, req.userId)) return res.status(403).json({ error: 'Nur Mitglieder dieser Allianz.' });
  const doc = getAllianceRaidDoc(tag);
  // Nichts zu tun ist kein Fehler: Mehrere Clients pollen gleichzeitig, der zweite soll denselben
  // aufgeräumten Zustand zurückbekommen statt einer Fehlermeldung (idempotent wie /checkdispatch).
  if (!doc || doc.result) return res.json({ ok: true, doc: doc || null, changed: false });
  if (!allianceRaidVorbeiServer(doc)) return res.json({ ok: true, doc, changed: false });
  doc.result = { destroyed: false, escaped: true, resolvedAt: Date.now() };
  doc.phase = 'resolved';
  setAllianceRaidDoc(tag, doc);
  await saveDb();
  res.json({ ok: true, doc, changed: true });
});

// Flotte der Sammelphase anschließen: Schiffszahlen werden auf das gekappt, was am gemeldeten
// Standort TATSÄCHLICH vorhanden ist (stiller Kapp statt harter Ablehnung - verzeihender bei knappen
// Rundungsdifferenzen), dort sofort abgezogen, und die Angriffskraft wird aus der geprüften
// Zusammensetzung UND dem echten Forschungs-/Taktikstand serverseitig berechnet.
app.post('/api/allianceraid/join', authMiddleware, async (req, res) => {
  const { tag, raidId, waveNumber, composition, originPlanet, travelSec } = req.body || {};
  if (!tag || !raidId || typeof waveNumber !== 'number' || !composition || typeof composition !== 'object' || !originPlanet) {
    return res.status(400).json({ error: 'Ungültige Anfrage.' });
  }
  const myRole = allianceRoleOf(tag, req.userId);
  if (!myRole) return res.status(403).json({ error: 'Nur Mitglieder dieser Allianz können beitreten.' });

  const doc = getAllianceRaidDoc(tag);
  if (!doc || doc.id !== raidId || doc.waveNumber !== waveNumber || doc.phase !== 'gathering' || doc.gatherEndsAt <= Date.now()) {
    return res.status(409).json({ error: 'Gerade keine offene Sammelphase für diese Welle.' });
  }
  const waveKey = allianceRaidWaveKey(doc);
  const existingJoinRaw = db.shared['alliance:' + tag + ':raidjoin:' + waveKey + ':' + req.userId];
  if (existingJoinRaw) {
    try { if (!JSON.parse(existingJoinRaw).cancelled) return res.status(409).json({ error: 'Du hast dieser Welle bereits eine Flotte angeschlossen.' }); } catch (e) {}
  }

  const saveRaw = getSaveValue(req.userId);
  if (!saveRaw) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });
  let save;
  try { save = JSON.parse(saveRaw); } catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }
  const fleetObj = allianceRaidFleetObj(save, originPlanet);
  if (!fleetObj) return res.status(404).json({ error: 'Kein Flottenstandort gefunden.' });

  const clampedComposition = {};
  let totalShips = 0;
  for (const k of ALLIANCE_RAID_ATTACK_SHIP_KEYS) {
    const requested = Math.max(0, Math.floor(Number(composition[k]) || 0));
    const available = Math.max(0, Math.floor(fleetObj[k] || 0));
    const n = Math.min(requested, available);
    if (n > 0) { clampedComposition[k] = n; totalShips += n; }
  }
  if (totalShips < 1) return res.status(400).json({ error: 'Keine gültige Flotte am angegebenen Standort verfügbar.' });

  for (const [k, n] of Object.entries(clampedComposition)) fleetObj[k] = Math.max(0, (fleetObj[k] || 0) - n);

  const power = computeAllianceRaidPower(save, clampedComposition);
  const safeTravelSec = Math.max(1, Number(travelSec) || 1);
  const arrivesAtBaseAt = Date.now() + safeTravelSec * 1000;

  const joinDoc = {
    name: req.username || 'Kommandant', composition: clampedComposition, power, originPlanet,
    shipCount: totalShips, joinedAt: Date.now(), travelSec: safeTravelSec, arrivesAtBaseAt,
    // Momentaufnahme der zum Beitrittszeitpunkt gültigen Sammelphasen-Deadline - macht die
    // "rechtzeitig angekommen?"-Prüfung beim späteren /claim vollständig aus dem eigenen
    // Beitritts-Dokument beantwortbar, unabhängig davon, ob doc.gatherEndsAt inzwischen (durch eine
    // neue Welle) einen anderen Wert hat.
    gatherEndsAt: doc.gatherEndsAt, cancelled: false, claimed: false
  };
  db.shared['alliance:' + tag + ':raidjoin:' + waveKey + ':' + req.userId] = JSON.stringify(joinDoc);
  const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));
  await saveDb();
  res.json({ ok: true, join: joinDoc, saveVersion: mySaveVersion });
});

// Rückzug während der laufenden Sammelphase: Schiffe kehren sofort und vollständig zum gemeldeten
// Standort zurück.
app.post('/api/allianceraid/cancel', authMiddleware, async (req, res) => {
  const { tag, raidId, waveNumber } = req.body || {};
  if (!tag || !raidId || typeof waveNumber !== 'number') return res.status(400).json({ error: 'Ungültige Anfrage.' });
  if (!allianceRoleOf(tag, req.userId)) return res.status(403).json({ error: 'Nur Mitglieder dieser Allianz.' });

  const waveKey = raidId + '-w' + waveNumber;
  const joinKey = 'alliance:' + tag + ':raidjoin:' + waveKey + ':' + req.userId;
  const joinRaw = db.shared[joinKey];
  if (!joinRaw) return res.status(404).json({ error: 'Kein Beitritt gefunden.' });
  let join; try { join = JSON.parse(joinRaw); } catch (e) { return res.status(500).json({ error: 'Beitritts-Dokument beschädigt.' }); }
  if (join.cancelled) return res.status(409).json({ error: 'Bereits zurückgezogen.' });

  const doc = getAllianceRaidDoc(tag);
  if (!doc || doc.id !== raidId || doc.waveNumber !== waveNumber || doc.phase !== 'gathering' || doc.gatherEndsAt <= Date.now()) {
    return res.status(409).json({ error: 'Ein Rückzug ist nur während der laufenden Sammelphase möglich.' });
  }

  const saveRaw = getSaveValue(req.userId);
  if (!saveRaw) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });
  let save; try { save = JSON.parse(saveRaw); } catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }
  const fleetObj = allianceRaidFleetObj(save, join.originPlanet);
  if (fleetObj) { for (const [k, n] of Object.entries(join.composition || {})) fleetObj[k] = (fleetObj[k] || 0) + n; }

  db.shared[joinKey] = JSON.stringify({ cancelled: true });
  const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));
  await saveDb();
  res.json({ ok: true, saveVersion: mySaveVersion });
});

// Sammelphase abgelaufen -> Verband zusammenstellen und abfliegen lassen. Race-tolerant wie alle
// anderen Poll-Endpunkte hier (jeder online Client kann das auslösen; ein no-op, falls eine andere
// Anfrage bereits gewonnen hat). Nur rechtzeitig eingetroffene Teilnehmer (arrivesAtBaseAt <=
// gatherEndsAt, beide bereits serverseitig aus dem echten Beitritts-Zeitpunkt gesetzt) zählen zum
// abfliegenden Verband.
app.post('/api/allianceraid/checkdispatch', authMiddleware, async (req, res) => {
  const { tag } = req.body || {};
  if (!tag) return res.status(400).json({ error: 'Ungültige Anfrage.' });
  if (!allianceRoleOf(tag, req.userId)) return res.status(403).json({ error: 'Nur Mitglieder dieser Allianz.' });

  const doc = getAllianceRaidDoc(tag);
  if (!doc || doc.phase !== 'gathering' || doc.gatherEndsAt > Date.now()) return res.json({ ok: true, doc });

  const waveKey = allianceRaidWaveKey(doc);
  const allParts = listAllianceRaidJoins(tag, waveKey);
  const onTime = allParts.filter(p => (p.arrivesAtBaseAt || Infinity) <= doc.gatherEndsAt);

  if (!onTime.length) {
    doc.phase = 'idle'; doc.lastWaveEndedAt = Date.now();
    doc.lastWaveResult = { waveNumber: doc.waveNumber, noParticipants: true, resolvedAt: Date.now() };
    setAllianceRaidDoc(tag, doc);
    await saveDb();
    return res.json({ ok: true, doc });
  }

  const totalComposition = {};
  let totalPower = 0, totalShips = 0, topPower = -1, topId = null;
  for (const p of onTime) {
    for (const [k, n] of Object.entries(p.composition || {})) totalComposition[k] = (totalComposition[k] || 0) + n;
    totalPower += p.power || 0; totalShips += p.shipCount || 0;
    if ((p.power || 0) > topPower) { topPower = p.power || 0; topId = p.playerId; }
  }

  const baseRaw = db.shared['alliance:' + tag + ':base'];
  let base = null; try { base = baseRaw ? JSON.parse(baseRaw) : null; } catch (e) {}
  const sameSys = !!(base && base.sector === doc.targetSector);
  // Zweite Flugetappe (Basis -> Boss-Standort): bewusst OHNE personenbezogenen Geschwindigkeits-
  // Multiplikator - ein gemeinsamer Verband hat keine "eine" persönliche Forschung, ein fester
  // Wert ist hier korrekter als der Zufall, wessen Client die Sammelphase zuerst als abgelaufen
  // bemerkt (das war eine Inkonsistenz der bisherigen clientseitigen Umsetzung).
  const dispatchSec = ALLIANCE_RAID_TEST_MODE ? ALLIANCE_RAID_TEST_DISPATCH_SEC : (sameSys ? 150 : 600);
  const now = Date.now();
  doc.dispatch = {
    departedAt: now, arrivalAt: now + dispatchSec * 1000, totalComposition,
    totalPower: Math.round(totalPower), totalShips, participantCount: onTime.length,
    topParticipantId: topId, topParticipantPower: Math.round(Math.max(0, topPower)),
    // Wer tatsächlich im abgeflogenen Verband steckt (nur rechtzeitig Eingetroffene) - resolve MUSS
    // sich hierauf stützen, nicht erneut alle Beitritts-Dokumente der Welle auflisten, sonst würden
    // Zuspätkommer (die beim Dispatch korrekt ausgeschlossen wurden) trotzdem eine Belohnung/Verluste
    // aus der Wellen-Auflösung bekommen, obwohl sie nie am Kampf teilgenommen haben.
    participantIds: onTime.map(p => p.playerId),
    // ===== Die Rangliste des Verbands (05.08.2026, Wunsch Sascha) =====
    // Hier und nirgends sonst: Der Rang muss im Moment des ABFLUGS feststehen, aus denselben
    // serverseitig berechneten Angriffskräften, die auch den Kampf entscheiden. Später aus den
    // Beitritts-Dokumenten nachzuzählen wäre nicht dasselbe - wer nach dem Abflug beitritt oder
    // storniert, dürfte die Platzierung der anderen nicht mehr verschieben.
    // `name` kommt aus dem Beitritts-Dokument (dort vom Server aus req.username gesetzt), damit die
    // Wiedergabe im Spiel die Rangliste zeigen kann, ohne 20 Profile nachzuladen.
    ranking: onTime.slice()
      .sort((a, b) => (b.power || 0) - (a.power || 0))
      .map(p => ({ id: p.playerId, name: p.name || 'Kommandant', power: Math.round(p.power || 0) }))
  };
  doc.phase = 'enroute';
  setAllianceRaidDoc(tag, doc);
  await saveDb();
  res.json({ ok: true, doc });
});

// Ankunft am Boss-Standort -> Kampf auflösen. Schaden = Gesamt-Angriffskraft des Verbands (gedeckelt
// auf die Rest-HP), eigene Verluste anhand des Machtverhältnisses zur bosseigenen Gegenwehr. Anders
// als vorher (client-seitiger "claim" pro Spieler) werden HIER die Belohnungen/Verluste für ALLE
// Teilnehmer der Welle in EINEM serverseitigen Durchlauf direkt in deren jeweiligen Spielstand
// geschrieben - kein Spieler kann sich mehr selbst einen höheren Anteil zuschreiben, als ihm laut
// der (serverseitig berechneten) Angriffskraft zusteht.
// Bewusst OHNE Belohnungsverteilung hier (anders als eine frühere Fassung dieses Endpunkts) - eine
// EINZELNE Anfrage in fremde Spielstände ALLER Teilnehmer zu schreiben, ausgelöst von wem auch immer
// zufällig zuerst pollt, hätte bei jedem NICHT-aufrufenden Teilnehmer die serverseitige Versions-
// nummer seines Spielstands im Hintergrund erhöht, ohne dass dessen eigener Client das mitbekommt -
// beim nächsten regulären Speichern dieses Spielers wäre das (harmlos, aber unnötig) als
// Versionskonflikt aufgeschlagen. Sauberer: /resolve macht NUR die gemeinsame, einmalige
// Kampfauflösung (Schaden/HP/Phase), jeder Teilnehmer holt seine EIGENE Belohnung über den
// separaten /claim-Endpunkt unten selbst ab (exakt wie /api/worldboss/resolve: der Server schreibt
// dabei ausschließlich in den Spielstand des jeweils AUFRUFENDEN Spielers).
app.post('/api/allianceraid/resolve', authMiddleware, async (req, res) => {
  const { tag } = req.body || {};
  if (!tag) return res.status(400).json({ error: 'Ungültige Anfrage.' });
  if (!allianceRoleOf(tag, req.userId)) return res.status(403).json({ error: 'Nur Mitglieder dieser Allianz.' });

  const doc = getAllianceRaidDoc(tag);
  if (!doc || doc.phase !== 'enroute' || !doc.dispatch || doc.dispatch.arrivalAt > Date.now()) return res.json({ ok: true, doc });

  const power = doc.dispatch.totalPower;
  // Raid-Boss-Regel (02.08.2026, Frontend: ALLIANCE_RAID_BOSSE - dort steht die Begruendung).
  // Deterministisch aus der Stufe, nicht aus einem Feld des Dokuments: Das Raid-Dokument liegt im
  // geteilten Speicher und wird von Clients geschrieben, ein dort mitgefuehrter Boss waere faelschbar.
  // Die Trefferschwaeche ist bewusst ein MALUS bei fehlendem Schiffstyp und kein Bonus bei
  // vorhandenem: Ein gut zusammengestellter Verband richtet genau so viel Schaden an wie vorher.
  // 05.08.2026: die GEWAEHLTE Sorte (doc.bossKey), sonst kaempft der Verband gegen einen anderen
  // Gegner als den, der beim Ausrufen angekuendigt und in der Karte angezeigt wurde.
  const raidBoss = allianceRaidBossFor(doc);
  const comp = (doc.dispatch && doc.dispatch.totalComposition) || {};
  // ===== Boss-Status der VORHERIGEN Welle anwenden und verbrauchen (v8.438.0) =====
  // Brand frisst Rest-HP, BEVOR der Verband schiesst (der Boss brannte waehrend des Cooldowns);
  // Schock deckt die Trefferschwaeche unabhaengig von der Zusammensetzung; Frost senkt unten die
  // Gegenwehr. Alle drei stammen aus dem Aufloesen der Welle davor (doc.status) und gelten genau
  // einmal - am Ende dieses Handlers wird doc.status mit den NEUEN Ausloesern ueberschrieben.
  const statusVorher = (doc.status && typeof doc.status === 'object') ? doc.status : {};
  const hpVorBrand = doc.hp;
  let brandSchaden = 0;
  if (statusVorher.brand) {
    brandSchaden = Math.min(doc.hp, Math.round(doc.hp * ALLIANCE_RAID_STATUS.brand.wirkung));
    doc.hp = Math.max(0, doc.hp - brandSchaden);
  }
  const hatSchwaeche = statusVorher.schock ? true : (!raidBoss.schwaeche || (comp[raidBoss.schwaeche] || 0) > 0);
  const schadenMult = hatSchwaeche ? 1 : raidBoss.ohneMult;
  const damage = Math.min(doc.hp, Math.round(power * schadenMult));
  const newHp = Math.max(0, doc.hp - damage);
  const destroyed = newHp <= 0;
  const counterRoh = allianceRaidCounterFor(doc.level);
  const counter = statusVorher.frost ? Math.round(counterRoh * (1 - ALLIANCE_RAID_STATUS.frost.wirkung)) : counterRoh;
  // Verlustquote mit dem Boss-Faktor, die alte Spanne [0,05; 0,60] bleibt aussen: Auch der haerteste
  // Boss kann den Verband nicht ueber die bisherige Obergrenze hinaus abraeumen.
  const rawLossPct = Math.max(0.05, Math.min(0.6, (counter / (counter + power)) * raidBoss.verlustMult));
  const lossPct = allianceRaidDampenLoss(rawLossPct);
  const now = Date.now();

  // Neue Status aus DIESER Welle fuer die naechste: Anteile an der Gesamtschiffszahl des Verbands.
  const gesamtSchiffe = Math.max(1, doc.dispatch.totalShips || 0);
  const statusNeu = {};
  for (const [sk, sdef] of Object.entries(ALLIANCE_RAID_STATUS)) {
    const n = sdef.schiffe.reduce((a, k) => a + (comp[k] || 0), 0);
    if (n / gesamtSchiffe >= sdef.anteil) statusNeu[sk] = true;
  }
  doc.status = destroyed ? null : statusNeu;

  const hpVorher = hpVorBrand;
  doc.hp = newHp;
  const waveResult = {
    waveNumber: doc.waveNumber, damage: Math.round(damage), destroyed, lossPct,
    // ===== Kampfdaten fuer den klassischen Bericht (07.08.2026, Frontend v8.430.0) =====
    // Reine Durchreichung bereits berechneter Groessen ins Wellen-Ergebnis - /claim liest NUR
    // dieses Dokument (doc.dispatch kann dort schon der naechsten Welle gehoeren, siehe den
    // ranking-Kommentar unten). maxHp aus der Server-Formel, nicht aus dem client-geschriebenen
    // Raid-Dokument - fuer die Anzeige "Rest-Huelle X von Y" soll Y die echte Groesse sein.
    totalComposition: comp, bossKey: raidBoss.key, bossName: raidBoss.name,
    hatSchwaeche, schadenMult, hpVorher, hpNachher: newHp, maxHp: allianceRaidHpFor(doc.level),
    // Boss-Status (v8.438.0): was aus der Vorwelle WIRKTE und was diese Welle fuer die naechste
    // HINTERLAESST - beides fuer den Bericht; brandSchaden ist der HP-Verlust vor dem Beschuss.
    brandSchaden, statusVorher: Object.keys(statusVorher).filter(k => statusVorher[k]),
    statusNeu: Object.keys(statusNeu),
    totalPower: power, totalShips: doc.dispatch.totalShips, participantCount: doc.dispatch.participantCount,
    topParticipantId: doc.dispatch.topParticipantId, resolvedAt: now,
    // Die beim Abflug festgehaltene Rangliste wandert ins Wellen-Ergebnis: /claim liest den eigenen
    // Platz daraus, und die Anzeige im Spiel zeigt die ganze Tafel. Ohne diese Kopie muesste /claim
    // auf doc.dispatch zugreifen - das aber schon der naechsten Welle gehoeren kann.
    ranking: (doc.dispatch.ranking || []).slice()
  };
  doc.lastWaveResult = waveResult;
  doc.lastWaveEndedAt = now;
  if (destroyed) { doc.phase = 'resolved'; doc.result = waveResult; } else { doc.phase = 'idle'; }
  setAllianceRaidDoc(tag, doc);
  await saveDb();
  res.json({ ok: true, doc });
});

// Eigene Belohnung einer abgeschlossenen Welle abholen - jeder Teilnehmer ruft das für sich selbst
// auf (Server schreibt ausschließlich in DESSEN eigenen Spielstand, nie in den eines anderen
// Spielers). Verluste/Belohnung werden aus dem bereits serverseitig berechneten lastWaveResult/
// result UND dem eigenen, ebenfalls serverseitig berechneten Beitritts-Dokument abgeleitet - der
// Client kann hier nichts mehr vortäuschen. Ein "claimed"-Flag im eigenen Beitritts-Dokument
// verhindert Mehrfachauszahlung (Doppelklick, Netzwerk-Retry).
app.post('/api/allianceraid/claim', authMiddleware, async (req, res) => {
  const { tag, raidId, waveNumber } = req.body || {};
  if (!tag || !raidId || typeof waveNumber !== 'number') return res.status(400).json({ error: 'Ungültige Anfrage.' });
  if (!allianceRoleOf(tag, req.userId)) return res.status(403).json({ error: 'Nur Mitglieder dieser Allianz.' });

  const waveKey = raidId + '-w' + waveNumber;
  const joinKey = 'alliance:' + tag + ':raidjoin:' + waveKey + ':' + req.userId;
  const joinRaw = db.shared[joinKey];
  if (!joinRaw) return res.status(404).json({ error: 'Kein Beitritt zu dieser Welle gefunden.' });
  let join; try { join = JSON.parse(joinRaw); } catch (e) { return res.status(500).json({ error: 'Beitritts-Dokument beschädigt.' }); }
  if (join.cancelled) return res.json({ ok: true, missedWave: false, cancelled: true });
  if (join.claimed) return res.json({ ok: true, alreadyClaimed: true });

  const saveRaw = getSaveValue(req.userId);
  if (!saveRaw) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });
  let save; try { save = JSON.parse(saveRaw); } catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }
  const fleetObj = allianceRaidFleetObj(save, join.originPlanet);

  // "Rechtzeitig angekommen?" ist vollständig aus dem EIGENEN Beitritts-Dokument beantwortbar
  // (arrivesAtBaseAt vs. die dort gespeicherte Momentaufnahme von gatherEndsAt, siehe join()) -
  // unabhängig davon, ob der Raid inzwischen in einer neueren Welle steckt.
  const missedWave = (join.arrivesAtBaseAt || Infinity) > (join.gatherEndsAt != null ? join.gatherEndsAt : -Infinity);
  if (missedWave) {
    if (fleetObj) { for (const [k, n] of Object.entries(join.composition || {})) fleetObj[k] = (fleetObj[k] || 0) + n; }
    join.claimed = true;
    db.shared[joinKey] = JSON.stringify(join);
    const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));
    await saveDb();
    return res.json({ ok: true, missedWave: true, saveVersion: mySaveVersion, newCredits: save.credits, newBattlePoints: save.battlePoints });
  }

  const doc = getAllianceRaidDoc(tag);
  // Das WELLEN-Ergebnis (lastWaveResult/result) muss noch zu GENAU dieser waveNumber passen - ist
  // inzwischen schon eine neuere Welle gestartet/aufgelöst worden (seltene Race, siehe Kommentar bei
  // der früheren clientseitigen Fassung dieser Logik), gibt es kein passendes Ergebnis mehr. Dann
  // sicherheitshalber die Flotte unversehrt zurückgeben statt sie verschwinden zu lassen ODER eine
  // falsche (neuere) Belohnung auszuzahlen.
  const res_ = doc && doc.lastWaveResult && doc.lastWaveResult.waveNumber === waveNumber ? doc.lastWaveResult
    : (doc && doc.result && doc.result.waveNumber === waveNumber ? doc.result : null);
  if (!res_) {
    if (fleetObj) { for (const [k, n] of Object.entries(join.composition || {})) fleetObj[k] = (fleetObj[k] || 0) + n; }
    join.claimed = true;
    db.shared[joinKey] = JSON.stringify(join);
    const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));
    await saveDb();
    return res.json({ ok: true, missedWave: true, staleResult: true, saveVersion: mySaveVersion, newCredits: save.credits, newBattlePoints: save.battlePoints });
  }

  const share = res_.totalPower > 0 ? Math.min(1, (join.power || 0) / res_.totalPower) : 0;
  const isTop = res_.topParticipantId === req.userId;
  const level = doc.level;
  // ===== Platzierung im Verband (05.08.2026) =====
  // Aus der beim Abflug festgehaltenen Rangliste. Fehlt sie (Welle war schon vor dem Update
  // unterwegs), faellt die Rechnung auf "einziger Teilnehmer" zurueck - das ergibt denselben
  // Faktor wie frueher der Top-Bonus und benachteiligt niemanden waehrend des Uebergangs.
  const rangListe = Array.isArray(res_.ranking) ? res_.ranking : [];
  const anzahl = rangListe.length || 1;
  const idx = rangListe.findIndex(e => e && e.id === req.userId);
  const platz = idx >= 0 ? idx + 1 : anzahl;   // nicht gefunden -> hinten einsortieren
  // Der Boss bestimmt Ertrag und Schwerpunkt der Beute (beuteMult/schwerpunkt). Er kommt aus
  // demselben allianceRaidBossFor wie der Kampf selbst - sonst kaempfte man gegen den einen und
  // wuerde nach dem anderen bezahlt.
  const lohnBoss = allianceRaidBossFor(doc);
  const lohn = allianceRaidRewardFor(level, share, platz, anzahl, res_.destroyed, lohnBoss);
  const credits = lohn.credits;
  const bp = lohn.battlePoints;
  // WICHTIG: anders als beim Weltboss (wo die Flotte bis zur Missionsauflösung im Spielstand bleibt
  // und Verluste von dort abgezogen werden) wurden die gesendeten Schiffe hier bereits BEIM BEITRITT
  // aus fleetObj entfernt (siehe /join). Der Verlust wird deshalb direkt aus der gesendeten Menge
  // berechnet, und nur die ÜBERLEBENDEN kommen zurück - NICHT von der (für diese Schiffstypen
  // bereits leeren) aktuellen Flotte abgezogen, sonst wäre der Verlust immer 0.
  const lostShips = {};
  if (fleetObj) {
    for (const [k, sentCount] of Object.entries(join.composition || {})) {
      if (!sentCount) continue;
      const lost = Math.min(sentCount, Math.round(sentCount * (res_.lossPct || 0)));
      const survivors = sentCount - lost;
      if (survivors > 0) fleetObj[k] = (fleetObj[k] || 0) + survivors;
      if (lost > 0) lostShips[k] = lost;
    }
  }
  save.credits = (save.credits || 0) + credits;
  save.battlePoints = (save.battlePoints || 0) + bp;
  save.xp = (save.xp || 0) + lohn.xp;
  // Ressourcen: DIREKT im Spielstand gutschreiben, damit sie nicht vom Client "nachgetragen" werden
  // muessen. Der Lagerdeckel wird hier bewusst NICHT nachgebildet - er haengt an Gebaeuden, Schiffen,
  // Modulen und Planetenrollen, und eine zweite Kopie dieser Formel im Backend waere genau die Art
  // von Doppelpflege, vor der CLAUDE.md warnt. Das Frontend deckelt beim naechsten Tick ohnehin.
  save.resources = save.resources || {};
  for (const [res, menge] of Object.entries(lohn.resources)){
    if (menge > 0) save.resources[res] = (save.resources[res] || 0) + menge;
  }
  if (lohn.fragments > 0) save.moduleFragments = (save.moduleFragments || 0) + lohn.fragments;
  // Modulfund: Chance UND Seltenheit entscheidet der Server (siehe allianceRaidModuleDrop). Den
  // konkreten Typ zieht der Client aus seinen eigenen Tabellen - eine Spiegelung der 21 Modul-
  // Definitionen samt Herkunfts-Filtern hierher waere eine zweite Kopie, die stillschweigend
  // veraltet. Balancerelevant ist, OB und WIE SELTEN etwas faellt, und das steht jetzt hier.
  const modulSeltenheit = allianceRaidModuleDrop(level, platz, anzahl, res_.destroyed);
  join.claimed = true;
  db.shared[joinKey] = JSON.stringify(join);
  const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));
  await saveDb();
  res.json({
    ok: true, missedWave: false, destroyed: res_.destroyed, isTop, share: Math.round(share * 100),
    credits, battlePoints: bp, xp: lohn.xp, lostShips,
    // ===== Kampfdaten fuer den klassischen Bericht (07.08.2026, Frontend v8.430.0) =====
    // Durchreichung aus dem Wellen-Ergebnis. Wellen, die VOR diesem Update aufgeloest wurden,
    // haben die Felder nicht - dann null, der Client prueft jedes Feld einzeln (kein Erfinden).
    damage: (typeof res_.damage === 'number') ? res_.damage : null,
    lossPct: (typeof res_.lossPct === 'number') ? res_.lossPct : null,
    totalPower: res_.totalPower || 0, totalShips: res_.totalShips || 0, participantCount: res_.participantCount || 0,
    totalComposition: res_.totalComposition || null,
    hatSchwaeche: (typeof res_.hatSchwaeche === 'boolean') ? res_.hatSchwaeche : null,
    schadenMult: (typeof res_.schadenMult === 'number') ? res_.schadenMult : null,
    hpNachher: (typeof res_.hpNachher === 'number') ? res_.hpNachher : null,
    maxHp: (typeof res_.maxHp === 'number') ? res_.maxHp : null,
    brandSchaden: (typeof res_.brandSchaden === 'number') ? res_.brandSchaden : 0,
    statusVorher: Array.isArray(res_.statusVorher) ? res_.statusVorher : [],
    statusNeu: Array.isArray(res_.statusNeu) ? res_.statusNeu : [],
    platz, teilnehmer: anzahl,
    // Welcher Gegner es war - die Meldung im Spiel nennt ihn, und die Beute haengt an ihm.
    boss: { key: lohnBoss.key, name: lohnBoss.name, schwerpunkt: lohnBoss.schwerpunkt || null },
    resources: lohn.resources, fragmente: lohn.fragments,
    modulSeltenheit,
    // Die ganze Tafel mit - so kann das Spiel zeigen, wer wo stand, ohne 20 Profile nachzuladen.
    ranking: rangListe.map((e, i) => ({ platz: i + 1, name: e.name, power: e.power, ich: e.id === req.userId })),
    saveVersion: mySaveVersion, newCredits: save.credits, newBattlePoints: save.battlePoints
  });
});

// ===== Koordinierter Allianz-Angriff auf eine fremde Allianzbasis ("Musterangriff") - Härtung =====
// (19.07.2026, Fortsetzung der Allianz-Raid-Härtung): lief bisher komplett clientseitig - Client
// berechnete Angriffskraft/Kampfausgang/Belohnung selbst und schrieb sie direkt in geteilte
// Dokumente, auch in den Namensraum der ANGEGRIFFENEN (fremden) Allianz (basewar/incomingmuster).
// Nach demselben Muster wie beim Allianz-Raid jetzt server-autoritativ: create/join/cancel/
// checkdispatch/resolve machen dasselbe wie dort (siehe deren Kommentare), claim übernimmt wieder
// das "jeder holt seine eigene Belohnung selbst ab"-Prinzip.
//
// Bewusst NICHT vollständig gehärtet (siehe Taskliste, eigenes Vorhaben): die Ausbaustufe der
// ZIEL-Allianzbasis (allianceMusterBaseLevel unten) und deren stationierte Verteidigung
// (allianceMusterDefenseApprox) werden zwar aus echten geteilten Dokumenten (contrib:/base/basedef:)
// berechnet, aber diese Dokumente selbst könnten von einem böswilligen MITGLIED der VERTEIDIGENDEN
// Allianz noch mit Fantasiewerten befüllt sein (gleiches akzeptiertes Restrisiko wie bei contrib:
// oben) - das betrifft nur die eigene Verteidigungsstärke einer Allianz, nicht die Fähigkeit eines
// Angreifers, sich selbst unbegrenzt Kredite/Forschungspunkte/Kampfpunkte zu erschleichen (DAS ist
// hier geschlossen). Verteidigung nutzt außerdem eine vereinfachte Formel (40% der rohen
// Flottenangriffskraft, ohne das volle defWeight-/Hülle-/Schild-Modulsystem des Frontends) - analog
// zur bereits akzeptierten Vereinfachung von computeAllianceRaidPower (ohne Doktrin/Gebäude-/
// Offiziers-Kampfbonus/Buffs).
const ALLIANCE_MUSTER_DURATIONS = [30 * 60, 60 * 60, 120 * 60];
const ALLIANCE_MUSTER_COOLDOWN_MS = 24 * 3600 * 1000;
const ALLIANCE_MUSTER_TEST_MODE = process.env.ALLIANCE_RAID_TEST_MODE === '1'; // gleicher Schalter wie beim Raid
const ALLIANCE_MUSTER_TEST_DISPATCH_SEC = 2;
const ALLIANCE_BASE_MAX_LEVEL = 10;
const ALLIANCE_BASE_BASE_COST = { energie: 2000000, erz: 2000000, kristalle: 1200000, deuterium: 600000, antimaterie: 60000 };
const ALLIANCE_BASE_COST_MULT = 2.2;
const ALLIANCE_BASE_BUILD_H_L1 = 8;
const ALLIANCE_BASE_BUILD_MULT = 1.5;
const ALLIANCE_BASE_HP_PER_LEVEL = 12000;
const ALLIANCE_BASE_DEF_PER_LEVEL = 600;
const ALLIANCE_BASE_DAMAGE_DECAY_PER_H = 0.03;

function allianceBaseLevelCost(level) {
  const f = Math.pow(ALLIANCE_BASE_COST_MULT, level - 1);
  const c = {};
  for (const [r, a] of Object.entries(ALLIANCE_BASE_BASE_COST)) c[r] = Math.round(a * f);
  return c;
}
function allianceBaseCumCost(level) {
  const c = { energie: 0, erz: 0, kristalle: 0, deuterium: 0, antimaterie: 0 };
  for (let l = 1; l <= level; l++) { const lc = allianceBaseLevelCost(l); for (const r of Object.keys(c)) c[r] += lc[r]; }
  return c;
}
function allianceBaseLevelBuildSeconds(level) { return Math.round(ALLIANCE_BASE_BUILD_H_L1 * 3600 * Math.pow(ALLIANCE_BASE_BUILD_MULT, level - 1)); }
// Exakte Portierung von allianceBaseProgress()/allianceBaseLevelFromDoc() im Frontend (siehe deren
// ausführlichen Kommentar dort zur sequentiellen Bauzeit-Kette) - Sammelsumme aller "base_"-
// präfixierten contrib:-Einträge der Allianz gegen die Kosten-/Bauzeit-Tabelle geprüft.
function allianceMusterBaseLevel(tag) {
  const baseRaw = db.shared['alliance:' + tag + ':base'];
  let base = null; try { base = baseRaw ? JSON.parse(baseRaw) : null; } catch (e) {}
  if (!base || !base.foundedAt) return 0;
  const prefix = 'alliance:' + tag + ':contrib:';
  const tot = { energie: 0, erz: 0, kristalle: 0, deuterium: 0, antimaterie: 0 };
  for (const k of Object.keys(db.shared)) {
    if (!k.startsWith(prefix)) continue;
    try { const d = JSON.parse(db.shared[k]); for (const rk of Object.keys(tot)) tot[rk] += d['base_' + rk] || 0; } catch (e) {}
  }
  const readyAtByLevel = base.readyAtByLevel || {};
  let completedAt = 0, lvl = 0;
  for (let l = 1; l <= ALLIANCE_BASE_MAX_LEVEL; l++) {
    const cum = allianceBaseCumCost(l);
    const resOk = Object.entries(cum).every(([r, a]) => (tot[r] || 0) >= a);
    const readyAt = readyAtByLevel[l];
    if (!resOk || !readyAt) return lvl;
    const buildStart = Math.max(readyAt, completedAt);
    const buildComplete = buildStart + allianceBaseLevelBuildSeconds(l) * 1000;
    if (Date.now() >= buildComplete) { lvl = l; completedAt = buildComplete; } else return lvl;
  }
  return lvl;
}
function allianceBaseMaxHp(level) { return ALLIANCE_BASE_HP_PER_LEVEL * Math.max(1, level); }
function allianceBaseEffDamage(warDoc, level) {
  if (!warDoc || !warDoc.damage) return 0;
  if (warDoc.destroyedAt) return allianceBaseMaxHp(level);
  const hSince = Math.max(0, (Date.now() - (warDoc.lastDamageAt || 0)) / 3600000);
  return Math.max(0, warDoc.damage - allianceBaseMaxHp(level) * ALLIANCE_BASE_DAMAGE_DECAY_PER_H * hSince);
}
// Vereinfachte Verteidigungssumme (siehe Kommentar oben): 40% der rohen Angriffskraft aller
// gemeldeten basedef:-Flotten, ohne das volle defWeight-/Modulsystem des Frontends.
function allianceMusterDefenseApprox(tag) {
  const prefix = 'alliance:' + tag + ':basedef:';
  const combined = {};
  for (const k of Object.keys(db.shared)) {
    if (!k.startsWith(prefix)) continue;
    try { const d = JSON.parse(db.shared[k]); for (const [sk, v] of Object.entries(d)) if (typeof v === 'number' && v > 0) combined[sk] = (combined[sk] || 0) + v; } catch (e) {}
  }
  // BEWUSST ohne Werftmarken: combined addiert die basedef-Flotten MEHRERER Allianzmitglieder in
  // ein Objekt. Es gibt hier keinen einzelnen Spielstand und damit keine eine richtige Markenstufe -
  // die eines beliebigen Mitglieds anzusetzen waere schlechter als gar keine. Das ist keine
  // vergessene Stelle, sondern die einzige, an der die Marke nicht bestimmbar ist.
  return Math.round(rawFleetPower(combined) * 0.4);
}
function getMusterAttackDoc(tag) {
  const raw = db.shared['alliance:' + tag + ':musterattack'];
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function setMusterAttackDoc(tag, doc) { db.shared['alliance:' + tag + ':musterattack'] = JSON.stringify(doc); }
function listMusterJoins(tag, musterAttackId) {
  const prefix = 'alliance:' + tag + ':musterjoin:' + musterAttackId + ':';
  const out = [];
  for (const k of Object.keys(db.shared)) {
    if (!k.startsWith(prefix)) continue;
    try { const doc = JSON.parse(db.shared[k]); if (doc && !doc.cancelled) out.push(Object.assign({ playerId: k.slice(prefix.length) }, doc)); } catch (e) {}
  }
  return out;
}

app.post('/api/musterattack/create', authMiddleware, async (req, res) => {
  const { tag, targetTag: targetTagRaw, gatherSeconds, message } = req.body || {};
  /* ZIELART (Phase 5). Ohne das Feld ist alles wie bisher - eine fremde Allianzbasis. Mit
     'alien-nest' faellt der halbe Prueflauf darunter weg, und zwar nicht aus Bequemlichkeit:
     Ein Nest hat keine Allianz, keine Basis, kein incomingmuster-Dokument und keinen
     Schutzschild. Was stattdessen geprueft wird, steht im Zweig darunter. */
  const zielArt = String((req.body && req.body.zielArt) || 'allianz');
  const istNest = zielArt === 'alien-nest';
  const targetTag = istNest ? null : String(targetTagRaw || '').trim().toUpperCase();
  const gatherOk = ALLIANCE_MUSTER_DURATIONS.includes(gatherSeconds) || (ALLIANCE_MUSTER_TEST_MODE && Number(gatherSeconds) > 0);
  if (!tag || !gatherOk) return res.status(400).json({ error: 'Ungültige Anfrage.' });
  if (!istNest && (!targetTag || targetTag === tag)) return res.status(400).json({ error: 'Ungültige Anfrage.' });
  const myRole = allianceRoleOf(tag, req.userId);
  if (myRole !== 'admin' && myRole !== 'officer') return res.status(403).json({ error: 'Nur Admins/Offiziere können einen koordinierten Angriff starten.' });

  const mine = getMusterAttackDoc(tag);
  if (mine && (mine.phase === 'gathering' || mine.phase === 'enroute')) {
    const gegen = mine.zielArt === 'alien-nest' ? 'ein Alien-Nest bei ' + (mine.nestSystem || '?') : '[' + mine.targetTag + ']';
    return res.status(409).json({ error: 'Es läuft bereits ein koordinierter Angriff eurer Allianz (gegen ' + gegen + ').' });
  }

  let nestZiel = null;
  if (istNest) {
    /* Der Schalter gilt hier mit: Ohne aktive Nester gibt es kein Ziel, der ganze Zweig ist dann
       unerreichbar - deshalb braucht Phase 5 keinen EIGENEN Schalter. */
    // BEWUSST die Konstante und NICHT spawnAktiv('nester'): Eine Notabschaltung stoppt den
    // Nachschub, sie enteignet niemanden. Haenge dieser 404 am Schalter, staenden nach dem
    // Abschalten unangreifbare Nester auf der Karte - und die Meldung "es gibt derzeit keine"
    // waere eine Falschaussage gegenueber einem Spieler, der eines vor sich sieht.
    if (!NEST_SPAWN_AKTIV) return res.status(404).json({ error: 'Es gibt derzeit keine Alien-Nester in der Galaxie.' });
    const nestId = String((req.body && req.body.nestId) || '');
    const g0 = loadOrInitGalaxy();
    nestZiel = nestListe(g0).find(n => n.id === nestId);
    if (!nestZiel) return res.status(404).json({ error: 'Dieses Alien-Nest gibt es nicht (mehr).' });
  }

  if (!istNest) {
  const targetBaseRaw = db.shared['alliance:' + targetTag + ':base'];
  let targetBase = null; try { targetBase = targetBaseRaw ? JSON.parse(targetBaseRaw) : null; } catch (e) {}
  if (!targetBase || !targetBase.foundedAt) return res.status(404).json({ error: 'Die Allianz [' + targetTag + '] hat keine (auffindbare) Allianzbasis.' });

  const incomingRaw = db.shared['alliance:' + targetTag + ':incomingmuster'];
  let incoming = null; try { incoming = incomingRaw ? JSON.parse(incomingRaw) : null; } catch (e) {}
  if (incoming) {
    if (incoming.phase === 'enroute') return res.status(409).json({ error: 'Gegen [' + targetTag + '] ist bereits ein koordinierter Angriff unterwegs.' });
    const cdLeft = Math.max(0, (incoming.lastAttackAt || 0) + ALLIANCE_MUSTER_COOLDOWN_MS - Date.now());
    if (cdLeft > 0) return res.status(429).json({ error: 'Die Allianzbasis von [' + targetTag + '] steht noch unter Schutz (Abklingzeit).', cdLeft });
  }
  }

  const now = Date.now();
  const doc = {
    id: 'muster' + now, targetTag, createdBy: req.userId, createdByName: req.username || 'Kommandant',
    zielArt,
    nestId: nestZiel ? nestZiel.id : null,
    nestSystem: nestZiel ? nestZiel.sys : null,
    nestVolk: nestZiel ? nestZiel.volk : null,
    nestVolkName: nestZiel ? ((ALIEN_VOELKER[nestZiel.volk] || {}).name || nestZiel.volk) : null,
    nestStufeName: nestZiel ? nestStufe(nestZiel.stufe).name : null,
    message: String(message || '').replace(/[<>]/g, '').slice(0, 140),
    createdAt: now, museterEndsAt: now + gatherSeconds * 1000,
    phase: 'gathering', dispatch: null, result: null
  };
  setMusterAttackDoc(tag, doc);
  await saveDb();

  // Dieselbe Begründung wie beim Allianz-Raid (02.08.2026): eine Sammelphase mit harter Frist, die
  // bisher nur im Allianz-Chat stand. Wer nicht ohnehin gerade spielt, hat vom Aufruf nie erfahren.
  // Bewusst dieselbe Einstellungs-Kategorie 'allianceraid' wie der Raid: Für den Spieler ist beides
  // dasselbe Bedürfnis ("sag mir Bescheid, wenn meine Allianz gemeinsam losschlägt") - zwei
  // Schalter dafür wären eine Unterscheidung ohne Unterschied.
  try {
    for (const memberId of allianceMemberIds(tag)) {
      if (memberId === req.userId) continue;
      const user = findUserById(memberId);
      if (!user) continue;
      const prefs = getNotifPrefs(user);
      if (!prefs.enabled || !prefs.allianceraid) continue;
      pushNotificationEvent(memberId, 'alliance-muster', {
        tag, byName: req.username, targetTag, gatherSeconds
      });
    }
  } catch (e) { console.error('Musterangriff-Benachrichtigung fehlgeschlagen (der Angriff selbst läuft):', e.message); }

  res.json({ ok: true, doc });
});

app.post('/api/musterattack/join', authMiddleware, async (req, res) => {
  const { tag, musterAttackId, composition, originPlanet } = req.body || {};
  if (!tag || !musterAttackId || !composition || typeof composition !== 'object' || !originPlanet) return res.status(400).json({ error: 'Ungültige Anfrage.' });
  const myRole = allianceRoleOf(tag, req.userId);
  if (!myRole) return res.status(403).json({ error: 'Nur Mitglieder dieser Allianz können beitreten.' });

  const doc = getMusterAttackDoc(tag);
  if (!doc || doc.id !== musterAttackId || doc.phase !== 'gathering' || doc.museterEndsAt <= Date.now()) {
    return res.status(409).json({ error: 'Gerade keine offene Sammelphase für diesen Angriff.' });
  }
  const existingJoinRaw = db.shared['alliance:' + tag + ':musterjoin:' + musterAttackId + ':' + req.userId];
  if (existingJoinRaw) {
    try { if (!JSON.parse(existingJoinRaw).cancelled) return res.status(409).json({ error: 'Du hast diesem Angriff bereits eine Flotte angeschlossen.' }); } catch (e) {}
  }

  const saveRaw = getSaveValue(req.userId);
  if (!saveRaw) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });
  let save; try { save = JSON.parse(saveRaw); } catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }
  const fleetObj = allianceRaidFleetObj(save, originPlanet);
  if (!fleetObj) return res.status(404).json({ error: 'Kein Flottenstandort gefunden.' });

  const clampedComposition = {};
  let totalShips = 0;
  for (const k of ALLIANCE_RAID_ATTACK_SHIP_KEYS) {
    const requested = Math.max(0, Math.floor(Number(composition[k]) || 0));
    const available = Math.max(0, Math.floor(fleetObj[k] || 0));
    const n = Math.min(requested, available);
    if (n > 0) { clampedComposition[k] = n; totalShips += n; }
  }
  if (totalShips < 1) return res.status(400).json({ error: 'Keine gültige Flotte am angegebenen Standort verfügbar.' });

  for (const [k, n] of Object.entries(clampedComposition)) fleetObj[k] = Math.max(0, (fleetObj[k] || 0) - n);
  const power = computeAllianceRaidPower(save, clampedComposition);

  const joinDoc = {
    name: req.username || 'Kommandant', composition: clampedComposition, power, originPlanet,
    shipCount: totalShips, joinedAt: Date.now(), cancelled: false, claimed: false
  };
  db.shared['alliance:' + tag + ':musterjoin:' + musterAttackId + ':' + req.userId] = JSON.stringify(joinDoc);
  const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));
  await saveDb();
  res.json({ ok: true, join: joinDoc, saveVersion: mySaveVersion });
});

app.post('/api/musterattack/cancel', authMiddleware, async (req, res) => {
  const { tag, musterAttackId } = req.body || {};
  if (!tag || !musterAttackId) return res.status(400).json({ error: 'Ungültige Anfrage.' });
  if (!allianceRoleOf(tag, req.userId)) return res.status(403).json({ error: 'Nur Mitglieder dieser Allianz.' });

  const doc = getMusterAttackDoc(tag);
  if (!doc || doc.id !== musterAttackId || doc.phase !== 'gathering' || doc.museterEndsAt <= Date.now()) {
    return res.status(409).json({ error: 'Ein Rückzug ist nur während der laufenden Sammelphase möglich.' });
  }
  const joinKey = 'alliance:' + tag + ':musterjoin:' + musterAttackId + ':' + req.userId;
  const joinRaw = db.shared[joinKey];
  if (!joinRaw) return res.status(404).json({ error: 'Kein Beitritt zu diesem Angriff gefunden.' });
  let join; try { join = JSON.parse(joinRaw); } catch (e) { return res.status(500).json({ error: 'Beitritts-Dokument beschädigt.' }); }
  if (join.cancelled) return res.json({ ok: true, alreadyCancelled: true });

  const saveRaw = getSaveValue(req.userId);
  if (!saveRaw) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });
  let save; try { save = JSON.parse(saveRaw); } catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }
  const fleetObj = allianceRaidFleetObj(save, join.originPlanet);
  if (fleetObj) { for (const [k, n] of Object.entries(join.composition || {})) fleetObj[k] = (fleetObj[k] || 0) + n; }
  join.cancelled = true;
  db.shared[joinKey] = JSON.stringify(join);
  const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));
  await saveDb();
  res.json({ ok: true, saveVersion: mySaveVersion });
});

app.post('/api/musterattack/checkdispatch', authMiddleware, async (req, res) => {
  const { tag } = req.body || {};
  if (!tag) return res.status(400).json({ error: 'Ungültige Anfrage.' });
  if (!allianceRoleOf(tag, req.userId)) return res.status(403).json({ error: 'Nur Mitglieder dieser Allianz.' });

  const doc = getMusterAttackDoc(tag);
  if (!doc || doc.phase !== 'gathering' || doc.museterEndsAt > Date.now()) return res.json({ ok: true, doc });

  const parts = listMusterJoins(tag, doc.id);
  if (!parts.length) {
    doc.phase = 'resolved'; doc.result = { noParticipants: true, resolvedAt: Date.now() };
    setMusterAttackDoc(tag, doc);
    await saveDb();
    return res.json({ ok: true, doc });
  }

  const totalComposition = {};
  let totalPower = 0, totalShips = 0, topPower = -1, topId = null;
  for (const p of parts) {
    for (const [k, n] of Object.entries(p.composition || {})) totalComposition[k] = (totalComposition[k] || 0) + n;
    totalPower += p.power || 0; totalShips += p.shipCount || 0;
    if ((p.power || 0) > topPower) { topPower = p.power || 0; topId = p.playerId; }
  }

  const myBaseRaw = db.shared['alliance:' + tag + ':base'];
  let myBase = null; try { myBase = myBaseRaw ? JSON.parse(myBaseRaw) : null; } catch (e) {}
  let sameSys;
  if (doc.zielArt === 'alien-nest') {
    // Dieselbe Regel wie bei einer fremden Basis, nur mit dem SYSTEM des Nestes als Gegenstueck:
    // gleicher Sektor = kurzer Anflug. Eine zweite Entfernungsrechnung waere eine zweite Wahrheit.
    sameSys = !!(myBase && doc.nestSystem && myBase.sector === doc.nestSystem);
  } else {
    const targetBaseRaw = db.shared['alliance:' + doc.targetTag + ':base'];
    let targetBase = null; try { targetBase = targetBaseRaw ? JSON.parse(targetBaseRaw) : null; } catch (e) {}
    sameSys = !!(myBase && targetBase && myBase.sector === targetBase.sector);
  }
  // Fester Wert statt personenbezogener Geschwindigkeit (gleicher Grund wie beim Allianz-Raid: ein
  // gemeinsamer Verband hat keine "eine" persönliche Forschung).
  const dispatchSec = ALLIANCE_MUSTER_TEST_MODE ? ALLIANCE_MUSTER_TEST_DISPATCH_SEC : (sameSys ? 120 : 480);
  const now = Date.now();
  doc.dispatch = {
    departedAt: now, arrivalAt: now + dispatchSec * 1000, totalComposition,
    totalPower: Math.round(totalPower), totalShips, participantCount: parts.length,
    topParticipantId: topId, topParticipantPower: Math.round(Math.max(0, topPower)),
    participantIds: parts.map(p => p.playerId),
    /* Die EINZELKRAEFTE frieren hier mit ein (Phase 5). Der Nest-Zweig der Aufloesung verteilt
       den angerichteten Schaden danach; sie beim Aufloesen erneut aus den Beitritts-Dokumenten
       zu lesen waere eine zweite Quelle, die sich inzwischen geaendert haben kann (ein Beitritt
       laesst sich zurueckziehen). Der Versand ist der Zeitpunkt, an dem der Verband feststeht. */
    participants: parts.map(p => ({ id: p.playerId, name: p.playerName || null, power: Math.round(p.power || 0) }))
  };
  doc.phase = 'enroute';
  setMusterAttackDoc(tag, doc);
  // Ein Nest wird nicht gewarnt - es gibt keinen Verteidiger, der ein incomingmuster-Dokument
  // lesen koennte, und ein Eintrag unter `alliance:null:incomingmuster` waere schlicht Muell.
  if (doc.zielArt !== 'alien-nest') {
    db.shared['alliance:' + doc.targetTag + ':incomingmuster'] = JSON.stringify({
      attackerTag: tag, musterAttackId: doc.id, phase: 'enroute', dispatchedAt: now,
      arrivalAt: doc.dispatch.arrivalAt, lastAttackAt: now, totalShips, resolvedAt: null
    });
  }
  await saveDb();
  res.json({ ok: true, doc });
});

// Kampf-Auflösung bei Ankunft: identische Formel wie zuvor im Frontend (resolveAllianceMusterAttack).
// Schreibt Schaden/Zerstörung/Verlustquote in das geteilte alliance:<targetTag>:basewar-Dokument -
// die Verteidiger-Infrastruktur (Verlust-Anwendung je Mitglied, Bericht, Chat-Ankündigung, Alarm)
// bleibt unverändert clientseitig (liest dieses Dokument nur, schreibt es nicht mehr selbst).
app.post('/api/musterattack/resolve', authMiddleware, async (req, res) => {
  const { tag } = req.body || {};
  if (!tag) return res.status(400).json({ error: 'Ungültige Anfrage.' });
  const doc = getMusterAttackDoc(tag);
  // Anders als bei allen anderen musterattack-Endpunkten darf resolve auch vom VERTEIDIGER ausgelöst
  // werden (dessen eigener Client bemerkt die Ankunft über sein eigenes incomingmuster-Dokument,
  // siehe checkIncomingAllianceMuster im Frontend) - deshalb Mitgliedschaft in tag ODER in
  // doc.targetTag akzeptieren, nicht nur in tag wie sonst.
  const myRoleAttacker = allianceRoleOf(tag, req.userId);
  /* BEI EINEM NEST WIRD DER VERTEIDIGER-ZWEIG GAR NICHT ERST BETRETEN, und das ist keine
     Bequemlichkeit: `allianceRoleOf` baut seinen Schluessel per Verkettung
     ('alliance:' + tag + ':role:' + userId). Ein Nest hat kein targetTag; mit `undefined` entstuende
     woertlich `alliance:undefined:role:<uid>` - ein Schluessel, der wie ein ganz normaler
     Rolleneintrag aussieht. Wer einen solchen anlegen kann, duerfte damit JEDEN
     Nest-Verbandsangriff aufloesen. Ein Nest hat keinen Verteidiger; also gibt es hier auch
     keine Verteidiger-Rolle zu pruefen. */
  const istNestZiel = !!(doc && doc.zielArt === 'alien-nest');
  const myRoleDefender = (doc && !istNestZiel) ? allianceRoleOf(doc.targetTag, req.userId) : null;
  if (!myRoleAttacker && !myRoleDefender) return res.status(403).json({ error: 'Nur Mitglieder der angreifenden oder verteidigenden Allianz.' });

  if (!doc || doc.phase !== 'enroute' || !doc.dispatch || doc.dispatch.arrivalAt > Date.now()) return res.json({ ok: true, doc });

  if (istNestZiel) {
    const g = loadOrInitGalaxy();
    const nest = nestListe(g).find(n => n.id === doc.nestId);
    const jetzt = Date.now();

    /* Weg oder weitergezogen: dieselbe Entscheidung wie beim Einzelangriff - es kostet NICHTS,
       und die Antwort nennt den Grund. Ein stilles "erfolglos" waere hier die Falschaussage. */
    if (!nest || (doc.nestSystem && nest.sys !== doc.nestSystem)) {
      doc.phase = 'resolved';
      doc.result = { nest: true, verpasst: true, grund: nest ? 'weitergezogen' : 'gefallen',
        neuesSystem: nest ? nest.sys : null, success: false, destroyed: false, damage: 0,
        defensePower: 0, ownLossPct: 0, resolvedAt: jetzt };
      setMusterAttackDoc(tag, doc);
      await saveDb();
      return res.json({ ok: true, doc });
    }

    /* Die Teilnehmer kommen aus dem VERSAND, nicht aus den Beitritts-Dokumenten: Der Verband steht
       seit dem Abflug fest, ein Beitritt laesst sich bis dahin zurueckziehen. Der Rueckfall auf
       participantIds deckt Dokumente ab, die vor Phase 5 abgeflogen sind - dort zaehlen alle
       gleich, weil ihre Einzelkraefte nicht mitgeschrieben wurden. */
    const roh = doc.dispatch.participants;
    const beteiligte = (Array.isArray(roh) && roh.length)
      ? roh.map(p => ({ userId: p.id, name: p.name || 'Kommandant', gewicht: p.power || 0 }))
      : (doc.dispatch.participantIds || []).map(id => ({ userId: id, name: 'Kommandant', gewicht: 1 }));
    if (!beteiligte.length) {
      doc.phase = 'resolved';
      doc.result = { nest: true, noParticipants: true, success: false, destroyed: false, damage: 0,
        defensePower: 0, ownLossPct: 0, resolvedAt: jetzt };
      setMusterAttackDoc(tag, doc);
      await saveDb();
      return res.json({ ok: true, doc });
    }

    const erg = nestSchlagAusfuehren(g, nest, doc.dispatch.totalPower,
      doc.dispatch.totalComposition || {}, beteiligte, jetzt);

    doc.phase = 'resolved';
    doc.result = {
      nest: true, verpasst: false,
      volkName: erg.volkName, stufeName: erg.stufeName, system: doc.nestSystem,
      damage: erg.schaden, destroyed: erg.gefallen, success: erg.schaden > 0,
      trifftSchwaeche: erg.trifftSchwaeche, schwaeche: erg.schwaeche,
      lp: erg.lp, lpMax: erg.lpMax,
      // Als QUOTE, nicht als Stueckzahlen: Jeder Client wendet sie auf SEINEN Beitrag an.
      ownLossPct: Math.round(erg.quote * 1000) / 1000,
      defensePower: 0, chancePct: null,
      teilnehmer: erg.teilnehmer, schwarmGefallen: erg.schwarmGefallen, mitgerissen: erg.mitgerissen,
      /* Die BELOHNUNG liegt bereits in __pendingRewards jedes Beitragenden (anteilig, ueber
         nestSchlagAusfuehren). claim gibt deshalb nur die Schiffe zurueck und zahlt NICHT
         zusaetzlich die Basisangriffs-Waehrung - zwei Belohnungswege fuer dasselbe Ereignis
         waeren genau die Dopplung, die dieses Projekt sonst ueberall vermeidet. */
      belohnungUeberPendingRewards: true,
      resolvedAt: jetzt
    };
    setMusterAttackDoc(tag, doc);
    console.log('[muster-nest] tag=' + tag + ' nest=' + doc.nestId + ' teilnehmer=' + beteiligte.length +
      ' kraft=' + doc.dispatch.totalPower + ' schaden=' + erg.schaden +
      ' lp=' + (erg.gefallen ? 'gefallen' : erg.lp) + '/' + erg.lpMax +
      (erg.schwarmGefallen ? ' SCHWARM ZERFALLEN (+' + erg.mitgerissen + ')' : ''));
    await saveDb();
    return res.json({ ok: true, doc });
  }

  const targetTag = doc.targetTag;
  const targetBaseRaw = db.shared['alliance:' + targetTag + ':base'];
  let targetBase = null; try { targetBase = targetBaseRaw ? JSON.parse(targetBaseRaw) : null; } catch (e) {}
  if (!targetBase || !targetBase.foundedAt) {
    doc.phase = 'resolved';
    doc.result = { success: false, damage: 0, destroyed: false, defensePower: 0, ownLossPct: 0.05, note: 'target-gone', resolvedAt: Date.now() };
    setMusterAttackDoc(tag, doc);
    await saveDb();
    return res.json({ ok: true, doc });
  }

  const warRaw = db.shared['alliance:' + targetTag + ':basewar'];
  let war = null; try { war = warRaw ? JSON.parse(warRaw) : null; } catch (e) {}
  war = war || { damage: 0, lastDamageAt: 0, destroyedAt: null, destroyedCount: 0, attacks: [] };

  const targetLevel = allianceMusterBaseLevel(targetTag);
  if (targetLevel < 1 || war.destroyedAt) {
    doc.phase = 'resolved';
    doc.result = { success: false, damage: 0, destroyed: false, defensePower: 0, ownLossPct: 0.05, note: targetLevel < 1 ? 'target-not-built' : 'target-already-destroyed', resolvedAt: Date.now() };
    setMusterAttackDoc(tag, doc);
    await saveDb();
    return res.json({ ok: true, doc });
  }

  const defense = ALLIANCE_BASE_DEF_PER_LEVEL * targetLevel + allianceMusterDefenseApprox(targetTag);
  const power = doc.dispatch.totalPower;
  const chance = Math.max(0.10, Math.min(0.92, power / (power + defense)));
  const success = Math.random() < chance;
  const maxHp = allianceBaseMaxHp(targetLevel);
  const effDmgBefore = allianceBaseEffDamage(war, targetLevel);
  const now = Date.now();
  let dealt = 0, destroyed = false;
  if (success) {
    dealt = Math.round(power * (0.8 + Math.random() * 0.4));
    const newDamage = Math.min(maxHp, effDmgBefore + dealt);
    war.damage = newDamage; war.lastDamageAt = now;
    if (newDamage >= maxHp) { destroyed = true; war.destroyedAt = now; war.destroyedCount = (war.destroyedCount || 0) + 1; }
  } else {
    dealt = Math.round(power * 0.15);
    war.damage = Math.min(maxHp, effDmgBefore + dealt); war.lastDamageAt = now;
  }
  const defLossPct = success ? Math.max(0.08, Math.min(0.35, power / (power + defense * 1.5))) : Math.max(0.03, Math.min(0.12, power / (power + defense * 3)));
  war.attacks = war.attacks || [];
  war.attacks.unshift({ id: 'atk' + now, ts: now, attackerTag: tag, attackerName: '[' + tag + ']-Verband (' + doc.dispatch.participantCount + ' Kommandanten)', power: Math.round(power), damage: dealt, defLossPct: Math.round(defLossPct * 100) / 100, destroyed, isMusterAttack: true });
  war.attacks = war.attacks.slice(0, 25);
  db.shared['alliance:' + targetTag + ':basewar'] = JSON.stringify(war);

  const ownLossPct = allianceRaidDampenLoss(success ? 0.10 + Math.random() * 0.12 : 0.25 + Math.random() * 0.20);
  doc.phase = 'resolved';
  doc.result = {
    success, damage: dealt, destroyed, defensePower: Math.round(defense), ownLossPct,
    chancePct: Math.round(chance * 100), targetLevel, topParticipantId: doc.dispatch.topParticipantId,
    totalPower: power, resolvedAt: now
  };
  setMusterAttackDoc(tag, doc);

  const incomingRaw = db.shared['alliance:' + targetTag + ':incomingmuster'];
  try {
    const incoming = incomingRaw ? JSON.parse(incomingRaw) : null;
    if (incoming && incoming.musterAttackId === doc.id) { incoming.phase = 'resolved'; incoming.resolvedAt = now; db.shared['alliance:' + targetTag + ':incomingmuster'] = JSON.stringify(incoming); }
  } catch (e) {}

  await saveDb();

  // Die ANGEGRIFFENE Allianz benachrichtigen (02.08.2026). Bisher erfuhr sie es nur über eine
  // System-Nachricht im eigenen Chat - also erst beim nächsten Blick ins Spiel, unter Umständen
  // Stunden später und mit zerstörter Basis.
  //
  // Was auf dem Spiel steht, rechtfertigt die Meldung: Fällt die Hülle auf 0, sind ALLE Boni der
  // Allianz deaktiviert, bis 30% der kumulierten Baukosten gemeinsam wieder aufgebracht sind.
  // Mitglieder können Schiffe zur Basis entsenden - aber nur, wenn sie rechtzeitig davon erfahren.
  //
  // Eigene Kategorie 'alliancebase' statt 'attack': 'attack' meint den Angriff auf die eigene
  // Kolonie. Wer den abschaltet, weil er die PvP-Meldungen satt hat, will die Basis trotzdem nicht
  // stillschweigend verlieren.
  try {
    for (const memberId of allianceMemberIds(targetTag)) {
      const user = findUserById(memberId);
      if (!user) continue;
      const prefs = getNotifPrefs(user);
      if (!prefs.enabled || !prefs.alliancebase) continue;
      pushNotificationEvent(memberId, 'alliance-base-attacked', {
        attackerTag: tag, destroyed, damage: dealt, level: targetLevel
      });
    }
  } catch (e) { console.error('Basis-Angriffs-Benachrichtigung fehlgeschlagen (der Angriff selbst ist ausgewertet):', e.message); }

  res.json({ ok: true, doc });
});

// Eigene Belohnung eines abgeschlossenen koordinierten Angriffs abholen - jeder Teilnehmer ruft das
// für sich selbst auf, exakt wie /api/allianceraid/claim (Server schreibt ausschließlich in den
// eigenen Spielstand).
app.post('/api/musterattack/claim', authMiddleware, async (req, res) => {
  const { tag, musterAttackId } = req.body || {};
  if (!tag || !musterAttackId) return res.status(400).json({ error: 'Ungültige Anfrage.' });
  if (!allianceRoleOf(tag, req.userId)) return res.status(403).json({ error: 'Nur Mitglieder dieser Allianz.' });

  const joinKey = 'alliance:' + tag + ':musterjoin:' + musterAttackId + ':' + req.userId;
  const joinRaw = db.shared[joinKey];
  if (!joinRaw) return res.status(404).json({ error: 'Kein Beitritt zu diesem Angriff gefunden.' });
  let join; try { join = JSON.parse(joinRaw); } catch (e) { return res.status(500).json({ error: 'Beitritts-Dokument beschädigt.' }); }
  if (join.cancelled) return res.json({ ok: true, cancelled: true });
  if (join.claimed) return res.json({ ok: true, alreadyClaimed: true });

  const doc = getMusterAttackDoc(tag);
  if (!doc || doc.id !== musterAttackId || doc.phase !== 'resolved' || !doc.result) return res.status(409).json({ error: 'Angriff ist noch nicht abgeschlossen.' });

  const saveRaw = getSaveValue(req.userId);
  if (!saveRaw) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });
  let save; try { save = JSON.parse(saveRaw); } catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }
  const fleetObj = allianceRaidFleetObj(save, join.originPlanet);
  const res_ = doc.result;

  if (res_.noParticipants) {
    if (fleetObj) { for (const [k, n] of Object.entries(join.composition || {})) fleetObj[k] = (fleetObj[k] || 0) + n; }
    join.claimed = true; db.shared[joinKey] = JSON.stringify(join);
    const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));
    await saveDb();
    return res.json({ ok: true, noParticipants: true, saveVersion: mySaveVersion, newCredits: save.credits, newBattlePoints: save.battlePoints });
  }

  if (res_.nest) {
    /* Bei einem Nest gibt claim NUR die Schiffe zurueck. Die eigentliche Belohnung liegt anteilig
       in __pendingRewards (siehe Kommentar im Ergebnis) - sie hier ein zweites Mal auszuzahlen
       waere eine Doppelzahlung fuer dasselbe Ereignis. Bei `verpasst` ist die Quote 0, der Verband
       kommt also vollzaehlig heim: Das Nest war nicht da, das ist kein Fehler des Spielers. */
    const verloren = {};
    if (fleetObj) {
      for (const [k, sentCount] of Object.entries(join.composition || {})) {
        if (!sentCount) continue;
        const lost = Math.min(sentCount, Math.round(sentCount * (res_.ownLossPct || 0)));
        const survivors = sentCount - lost;
        if (survivors > 0) fleetObj[k] = (fleetObj[k] || 0) + survivors;
        if (lost > 0) verloren[k] = lost;
      }
    }
    join.claimed = true;
    db.shared[joinKey] = JSON.stringify(join);
    const nestSaveVersion = setSaveValue(req.userId, JSON.stringify(save));
    await saveDb();
    return res.json({ ok: true, nest: true, verpasst: !!res_.verpasst, grund: res_.grund || null,
      destroyed: !!res_.destroyed, damage: res_.damage || 0, volkName: res_.volkName || null,
      stufeName: res_.stufeName || null, lostShips: verloren,
      belohnungUeberPendingRewards: true,
      saveVersion: nestSaveVersion, newCredits: save.credits, newBattlePoints: save.battlePoints });
  }

  const totalPower = (doc.dispatch && doc.dispatch.totalPower) || 0;
  const share = totalPower > 0 ? Math.min(1, (join.power || 0) / totalPower) : 0;
  const isTop = res_.topParticipantId === req.userId;
  const bp = Math.round((res_.destroyed ? 150 : (res_.success ? 60 : 15)) * (0.5 + share * 1.5));
  const credits = Math.round((res_.destroyed ? 400 : (res_.success ? 150 : 40)) * (0.5 + share * 1.5));
  const fp = Math.round((res_.destroyed ? 200 : (res_.success ? 80 : 20)) * (0.5 + share * 1.5));
  const lostShips = {};
  if (fleetObj) {
    for (const [k, sentCount] of Object.entries(join.composition || {})) {
      if (!sentCount) continue;
      const lost = Math.min(sentCount, Math.round(sentCount * (res_.ownLossPct || 0)));
      const survivors = sentCount - lost;
      if (survivors > 0) fleetObj[k] = (fleetObj[k] || 0) + survivors;
      if (lost > 0) lostShips[k] = lost;
    }
  }
  save.credits = (save.credits || 0) + credits;
  save.battlePoints = (save.battlePoints || 0) + bp;
  save.resources = save.resources || {};
  save.resources.forschungspunkte = (save.resources.forschungspunkte || 0) + fp;
  join.claimed = true;
  db.shared[joinKey] = JSON.stringify(join);
  const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));
  await saveDb();
  res.json({
    ok: true, destroyed: res_.destroyed, success: res_.success, isTop, share: Math.round(share * 100),
    credits, battlePoints: bp, forschungspunkte: fp, lostShips, damage: res_.damage, defensePower: res_.defensePower, chancePct: res_.chancePct,
    saveVersion: mySaveVersion, newCredits: save.credits, newBattlePoints: save.battlePoints, newForschungspunkte: save.resources.forschungspunkte
  });
});

// Solo-Angriff EINES einzelnen Spielers auf eine fremde Allianzbasis (separat vom koordinierten
// Musterangriff oben - älterer, einfacherer Mechanismus ohne Sammelphase). Regressions-Fix
// (19.07.2026): schrieb bisher direkt über den generischen Speicher-Endpunkt in
// alliance:<targetTag>:basewar - seit dessen vollständiger Sperre (Musterangriff-Härtung) wäre das
// ohne diesen dedizierten Endpunkt kaputt. Löst Beitritt+Auflösung+Belohnung in EINEM Aufruf auf
// (keine Mehrspieler-Koordination nötig wie beim Musterangriff), sonst identische Formeln wie dort.
app.post('/api/basedamage/solo', authMiddleware, async (req, res) => {
  const { tag, targetTag: targetTagRaw, composition, originPlanet } = req.body || {};
  const targetTag = String(targetTagRaw || '').trim().toUpperCase();
  if (!tag || !targetTag || targetTag === tag || !composition || typeof composition !== 'object' || !originPlanet) {
    return res.status(400).json({ error: 'Ungültige Anfrage.' });
  }
  if (!allianceRoleOf(tag, req.userId)) return res.status(403).json({ error: 'Nur Mitglieder einer Allianz können Basis-Angriffe starten.' });

  const targetBaseRaw = db.shared['alliance:' + targetTag + ':base'];
  let targetBase = null; try { targetBase = targetBaseRaw ? JSON.parse(targetBaseRaw) : null; } catch (e) {}
  if (!targetBase || !targetBase.foundedAt) return res.status(404).json({ error: 'Die Allianz [' + targetTag + '] hat keine (auffindbare) Allianzbasis.' });

  const warRaw = db.shared['alliance:' + targetTag + ':basewar'];
  let war = null; try { war = warRaw ? JSON.parse(warRaw) : null; } catch (e) {}
  war = war || { damage: 0, lastDamageAt: 0, destroyedAt: null, destroyedCount: 0, attacks: [] };
  if (war.destroyedAt) return res.status(409).json({ error: 'Die Allianzbasis von [' + targetTag + '] liegt bereits in Trümmern.' });

  const targetLevel = allianceMusterBaseLevel(targetTag);
  if (targetLevel < 1) return res.status(409).json({ error: 'Die Allianzbasis von [' + targetTag + '] ist noch im Aufbau (Stufe 0).' });

  const saveRaw = getSaveValue(req.userId);
  if (!saveRaw) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });
  let save; try { save = JSON.parse(saveRaw); } catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }
  const fleetObj = allianceRaidFleetObj(save, originPlanet);
  if (!fleetObj) return res.status(404).json({ error: 'Kein Flottenstandort gefunden.' });

  const clampedComposition = {};
  let totalShips = 0;
  for (const k of ALLIANCE_RAID_ATTACK_SHIP_KEYS) {
    const requested = Math.max(0, Math.floor(Number(composition[k]) || 0));
    const available = Math.max(0, Math.floor(fleetObj[k] || 0));
    const n = Math.min(requested, available);
    if (n > 0) { clampedComposition[k] = n; totalShips += n; }
  }
  if (totalShips < 1) return res.status(400).json({ error: 'Keine gültige Flotte am angegebenen Standort verfügbar.' });
  // WICHTIG, anders als bei /musterattack/join: dieser Missionstyp zieht die gesendeten Schiffe NICHT
  // beim Abflug aus der Flotte ab (computeAwayByType zählt sie clientseitig nur als "unterwegs", der
  // Frontend-Flottenzähler bleibt währenddessen unverändert) - deshalb hier NICHT abziehen, sonst
  // würden die Schiffe doppelt verschwinden (einmal durch diesen Abzug, einmal weil sie ohnehin nie
  // "zurückgegeben" werden). Nur die tatsächlichen KAMPFVERLUSTE werden unten direkt abgezogen.
  const power = computeAllianceRaidPower(save, clampedComposition);
  const defense = ALLIANCE_BASE_DEF_PER_LEVEL * targetLevel + allianceMusterDefenseApprox(targetTag);
  const chance = Math.max(0.10, Math.min(0.92, power / (power + defense)));
  const success = Math.random() < chance;
  const maxHp = allianceBaseMaxHp(targetLevel);
  const effDmgBefore = allianceBaseEffDamage(war, targetLevel);
  const now = Date.now();
  let dealt = 0, destroyed = false;
  if (success) {
    dealt = Math.round(power * (0.8 + Math.random() * 0.4));
    const newDamage = Math.min(maxHp, effDmgBefore + dealt);
    war.damage = newDamage; war.lastDamageAt = now;
    if (newDamage >= maxHp) { destroyed = true; war.destroyedAt = now; war.destroyedCount = (war.destroyedCount || 0) + 1; }
  } else {
    dealt = Math.round(power * 0.15);
    war.damage = Math.min(maxHp, effDmgBefore + dealt); war.lastDamageAt = now;
  }
  const defLossPct = success ? Math.max(0.08, Math.min(0.35, power / (power + defense * 1.5))) : Math.max(0.03, Math.min(0.12, power / (power + defense * 3)));
  war.attacks = war.attacks || [];
  war.attacks.unshift({ id: 'solo' + now, ts: now, attackerTag: tag, attackerName: req.username || 'Kommandant', power: Math.round(power), damage: dealt, defLossPct: Math.round(defLossPct * 100) / 100, destroyed, isSolo: true });
  war.attacks = war.attacks.slice(0, 25);
  db.shared['alliance:' + targetTag + ':basewar'] = JSON.stringify(war);

  const ownLossPct = allianceRaidDampenLoss(success ? 0.10 + Math.random() * 0.12 : 0.25 + Math.random() * 0.20);
  const lostShips = {};
  for (const [k, sentCount] of Object.entries(clampedComposition)) {
    // Verluste direkt von der AKTUELLEN Flotte abziehen (dort sind die gesendeten Schiffe die ganze
    // Zeit über mitgezählt geblieben, siehe Kommentar oben) - gedeckelt auf das, was tatsächlich noch
    // da ist, falls sich der Bestand seit dem Abflug durch andere Aktionen verändert hat.
    const lost = Math.min(sentCount, Math.round(sentCount * ownLossPct), fleetObj[k] || 0);
    if (lost > 0) { fleetObj[k] = Math.max(0, (fleetObj[k] || 0) - lost); lostShips[k] = lost; }
  }
  const bp = destroyed ? 60 : (success ? 15 : 4);
  save.battlePoints = (save.battlePoints || 0) + bp;
  save.resources = save.resources || {};
  save.resources.hochenergiekristalle = Math.max(0, (save.resources.hochenergiekristalle || 0) - MOONSIEGE_AMMO_HEK);
  const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));
  await saveDb();
  res.json({
    ok: true, success, destroyed, damage: dealt, defensePower: Math.round(defense), chancePct: Math.round(chance * 100),
    attackPower: Math.round(power), battlePoints: bp, lostShips, ownLossPct, hullAfter: Math.round(maxHp - war.damage), hullMax: maxHp,
    saveVersion: mySaveVersion, newBattlePoints: save.battlePoints
  });
});

// Mondbelagerung (19.07.2026, Härtung - vorher rein clientseitig, siehe Frontend-Kommentar bei
// resolveMoonSiege): der angreifende Client berechnete Zerstörungschance/Erfolg selbst und schrieb
// das Ergebnis direkt in moondefense:<targetId>/moonsiegelog:<targetId>, inklusive eigener
// Kampfpunkte-Gutschrift, komplett ohne Serverprüfung. Löst Beitritt+Auflösung+Belohnung in einem
// Aufruf auf (der Mondzerstörer wird bei diesem Missionstyp nie aus der Flotte entfernt und läuft
// bei Misserfolg auch kein Verlustrisiko - die einzige "Kosten" sind Treibstoff und die 48-Std.-
// Abklingzeit, beide bleiben client-seitig wie bisher, da rein selbstbezogen und nicht
// PvP-relevant). Vereinfachte Angriffskraft ohne Schiffsmodul-Bonus (analog computeAllianceRaidPower
// ohne Doktrin/Gebäude-Bonus) - akzeptierte Vereinfachung, siehe dortiger Kommentar.
const MOONSIEGE_AMMO_HEK = 25; // Hochenergiekristalle je Belagerungsschuss (Tier-2-Munition)
app.post('/api/moonsiege/resolve', authMiddleware, async (req, res) => {
  const { targetPlayerId, targetMoonKey, originPlanet } = req.body || {};
  if (!targetPlayerId || !targetMoonKey || !originPlanet) return res.status(400).json({ error: 'Ungültige Anfrage.' });

  const saveRaw = getSaveValue(req.userId);
  if (!saveRaw) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });
  let save; try { save = JSON.parse(saveRaw); } catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }
  const fleetObj = allianceRaidFleetObj(save, originPlanet);
  if (!fleetObj || (fleetObj.mondzerstoerer || 0) < 1) return res.status(400).json({ error: 'Kein einsatzbereiter Mondzerstörer an diesem Standort.' });
  const targetRaw = db.shared['moondefense:' + targetPlayerId];
  let targetDoc = null; try { targetDoc = targetRaw ? JSON.parse(targetRaw) : null; } catch (e) {}
  const targetMoon = targetDoc && Array.isArray(targetDoc.moons) ? targetDoc.moons.find(mo => mo.moonKey === targetMoonKey) : null;
  if (!targetMoon) return res.status(404).json({ error: 'Dieses Mond-Ziel ist nicht (mehr) auffindbar.' });
  // Hochenergie-Ladung (19.07.2026, Tier-2-Verbrauchs-Sink): jeder Belagerungsschuss kostet
  // MOONSIEGE_AMMO_HEK Hochenergiekristalle - serverseitig geprüft und abgebucht, damit die
  // Munitionspflicht nicht clientseitig umgangen werden kann (der Endpunkt ist ohnehin die
  // einzige Auflösungs-Autorität).
  if (((save.resources || {}).hochenergiekristalle || 0) < MOONSIEGE_AMMO_HEK) {
    return res.status(400).json({ error: 'Nicht genug Hochenergiekristalle für die Belagerungs-Ladung (' + MOONSIEGE_AMMO_HEK + ' benötigt) - das Kristalllabor stellt sie her.' });
  }


  // Mondzerstörer-Klassenmodule (24.07.2026, Modul-Text-Audit): Reaktorkern-Upgrade (atk) und
  // Präzisionslaser (siegechance) versprachen ihre Wirkung seit Einführung, wurden aber NIRGENDS
  // verrechnet. Jetzt aus dem (server-validierten) Angreifer-Save gelesen: atk verstärkt die
  // Belagerungskraft (gedeckelt +100%), der Laser addiert direkt Erfolgschance NACH dem regulären
  // 50%-Deckel (sonst wäre er gegen starke Ziele wirkungslos), harter Gesamt-Deckel bei 65%.
  const mzAtkMult = 1 + shipModuleBonus(save, 'mondzerstoerer', 'atk');
  const siegeChanceBonus = shipModuleBonus(save, 'mondzerstoerer', 'siegechance');
  const power = 300 * mzAtkMult * (0.85 + Math.random() * 0.3);
  const reduction = Math.min(0.75, (targetMoon.shieldLevel || 0) * 0.04 + (targetMoon.stabilityLevel || 0) * 0.02 + (targetMoon.allianceTag ? 0.05 : 0));
  const baseChance = power / (power + Math.max(1, targetMoon.defense || 0) * 2.2);
  const chance = Math.max(0.03, Math.min(0.65, Math.min(0.5, baseChance * (1 - reduction)) + siegeChanceBonus));
  const destroyed = Math.random() < chance;
  const bp = destroyed ? 150 : 20;

  save.battlePoints = (save.battlePoints || 0) + bp;
  save.resources = save.resources || {};
  save.resources.hochenergiekristalle = Math.max(0, (save.resources.hochenergiekristalle || 0) - MOONSIEGE_AMMO_HEK);
  const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));

  const freshRaw = db.shared['moondefense:' + targetPlayerId];
  let fresh = null; try { fresh = freshRaw ? JSON.parse(freshRaw) : targetDoc; } catch (e) { fresh = targetDoc; }
  if (fresh && Array.isArray(fresh.moons)) {
    if (destroyed) fresh.moons = fresh.moons.filter(mo => mo.moonKey !== targetMoonKey);
    db.shared['moondefense:' + targetPlayerId] = JSON.stringify(fresh);
  }
  const logRaw = db.shared['moonsiegelog:' + targetPlayerId];
  let log2 = null; try { log2 = logRaw ? JSON.parse(logRaw) : null; } catch (e) {}
  log2 = log2 || { events: [] };
  log2.events = log2.events || [];
  log2.events.unshift({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), ts: Date.now(), attackerName: req.username || 'Kommandant', moonKey: targetMoonKey, moonName: targetMoon.name, destroyed, chancePct: Math.round(chance * 100) });
  log2.events = log2.events.slice(0, 25);
  db.shared['moonsiegelog:' + targetPlayerId] = JSON.stringify(log2);

  await saveDb();
  res.json({ ok: true, destroyed, chancePct: Math.round(chance * 100), battlePoints: bp, targetMoonName: targetMoon.name, saveVersion: mySaveVersion, newBattlePoints: save.battlePoints, ammoUsed: MOONSIEGE_AMMO_HEK, newHochenergiekristalle: save.resources.hochenergiekristalle });
});

// Spieler greift ein NPC-Fraktionssystem an. Der Server ist autoritativ: er prüft die Flotte des
// Angreifers gegen die Militärstärke der besitzenden Fraktion, würfelt den Ausgang, und bei Erfolg
// wechselt das System in den Besitz des Spielers (controlledSystems). Bei Misserfolg verliert der
// Angreifer einen Teil seiner Flotte (Verluste werden in seinen Spielstand geschrieben).
app.post('/api/faction/attack', authMiddleware, async (req, res) => {
  const { systemId } = req.body || {};
  if (!systemId || !SYSTEMS.includes(systemId)) return res.status(400).json({ error: 'Ungültiges Zielsystem.' });

  const g = loadOrInitGalaxy();
  const factions = loadOrInitFactions(g);
  // Welche Fraktion besitzt das System?
  let owner = null;
  for (const f of Object.values(factions)) { if (f.systems.includes(systemId)) { owner = f; break; } }
  if (!owner) return res.status(400).json({ error: 'Dieses System gehört keiner Fraktion.' });

  const attackerRaw = getSaveValue(req.userId);
  if (!attackerRaw) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });
  let attacker;
  try { attacker = JSON.parse(attackerRaw); } catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }

  // Angriffskraft des Spielers vs. Verteidigungskraft der Fraktion (skaliert mit ihrer Militärstärke
  // und der Größe ihres Reiches, damit große Fraktionen härtere Ziele sind).
  const attackPower = computeAttackPower(attacker, null);
  const factionDefense = Math.round(1500 * owner.strength * (1 + owner.systems.length * 0.05));
  const chance = Math.max(0.08, Math.min(0.92, attackPower / (attackPower + factionDefense)));
  const success = Math.random() < chance;

  // Bollwerk schleifen: Der Angriff drueckt die Front gegen den Besitzer, also fuer dessen Rivalen.
  // Bei Erfolg faellt das System an den Spieler und damit aus der Front heraus (rkGrenzsysteme
  // schliesst controlledSystems aus) - der Beitrag geht dann an den naechstgelegenen Abschnitt
  // derselben Front, statt in einem Eintrag zu verpuffen, den der naechste Takt ohnehin wegwirft.
  const rkSeite = FACTION_RIVALS[owner.id];
  const rkErgebnis = rkSeite ? rkBeitrag(g, rkSeite, req.userId,
    success ? RK_BOLLWERK_ERFOLG : RK_BOLLWERK_FEHLSCHLAG,
    success ? { ausserSys: systemId } : { wunschSys: systemId }) : null;

  if (success) {
    // System der Fraktion entziehen und dem Spieler zuschreiben.
    owner.systems = owner.systems.filter(s => s !== systemId);
    g.controlledSystems[systemId] = req.userId;
    attacker.battlePoints = (attacker.battlePoints || 0) + 40;
    // Beute: Kredite + etwas Ressourcen als Eroberungsbelohnung.
    const creditReward = 500 + Math.floor(Math.random() * 500);
    attacker.credits = (attacker.credits || 0) + creditReward;
    const mySaveVersion = setSaveValue(req.userId, JSON.stringify(attacker));
    pushGalaxyNews('ti-flag', (req.username || 'Ein Kommandant') + ' hat ' + systemId + ' von den ' + owner.name + ' erobert!');
    await saveDb();
    return res.json({ success: true, systemId, attackPower, factionDefense, creditReward, factionName: owner.name, saveVersion: mySaveVersion, front: rkErgebnis });
  } else {
    // Misserfolg: Flottenverluste (10-25% jeder Schiffsart der Heimatflotte).
    const lossPct = 0.10 + Math.random() * 0.15;
    const lost = {};
    const fleet = attacker.fleet || {};
    for (const [k, v] of Object.entries(fleet)) {
      if (k === 'missions' || typeof v !== 'number' || v <= 0) continue;
      const l = Math.floor(v * lossPct);
      if (l > 0) { lost[k] = l; fleet[k] = v - l; }
    }
    attacker.battlePoints = (attacker.battlePoints || 0) + 5;
    const mySaveVersion = setSaveValue(req.userId, JSON.stringify(attacker));
    await saveDb();
    return res.json({ success: false, systemId, attackPower, factionDefense, lost, factionName: owner.name, saveVersion: mySaveVersion, front: rkErgebnis });
  }
});

// ===== Die fuenf Handlungen an der Front =======================================================
// EIN Endpunkt fuer alle, weil sie sich nur in Traeger und Gewicht unterscheiden. Was fuer jede
// gilt: Der Beitrag wird ERST verbucht, wenn rkBeitrag ihn angenommen hat - gibt es die Front noch
// gar nicht, bleibt der Zaehlerfortschritt (bzw. das Rohstofflager) unangetastet. Ein Beitrag darf
// nie verschwinden, nur weil der Weltentakt noch keine Front aufgebaut hat.
app.post('/api/randkriege/handlung', authMiddleware, async (req, res) => {
  const art = String((req.body || {}).art || '');
  const fraktion = String((req.body || {}).fraktion || '');
  if (!FACTION_RIVALS[fraktion]) return res.status(400).json({ error: 'Unbekannte Fraktion.' });
  const frontKey = rkFrontKeyFuer(fraktion);
  if (!frontKey) return res.status(400).json({ error: 'Diese Fraktion steht an keiner Front.' });

  if (art !== 'nachschub' && !RK_HANDLUNGEN[art]) return res.status(400).json({ error: 'Unbekannte Handlung.' });

  const g = loadOrInitGalaxy();
  const rk = loadOrInitRandkriege(g);
  const nutzbar = rkNochNutzbar(rk, req.userId, frontKey);
  if (nutzbar <= 0) return res.json({ ok: true, punkte: 0, grund: 'tagesdeckel' });

  const rohSave = getSaveValue(req.userId);
  if (!rohSave) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });
  let save;
  try { save = JSON.parse(rohSave); } catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }

  // ---- Nachschubspende: der Server zaehlt nach und bucht selbst ab -----------------------------
  if (art === 'nachschub') {
    const zuletzt = (db.private[req.userId] && db.private[req.userId].__rkNachschubAt) || 0;
    const wartet = zuletzt + RK_NACHSCHUB_SPERRE_MS - Date.now();
    if (wartet > 0) return res.status(429).json({ error: 'Der nächste Nachschub geht erst später raus.', wartetMs: wartet });
    save.resources = save.resources || {};
    for (const [r, menge] of Object.entries(RK_NACHSCHUB_KOSTEN)) {
      if ((save.resources[r] || 0) < menge) {
        return res.status(400).json({ error: 'Nicht genug ' + r + ' für den Nachschub.', kosten: RK_NACHSCHUB_KOSTEN });
      }
    }
    // Erst rechnen, dann abbuchen: Bringt die Spende heute keinen ganzen Punkt mehr, kostet sie
    // auch nichts. Sonst waere der Tagesdeckel eine Falle statt einer Grenze.
    if (rkVorschau(rk, req.userId, frontKey, RK_NACHSCHUB_PUNKTE) <= 0) {
      return res.json({ ok: true, art, punkte: 0, grund: 'tagesdeckel' });
    }
    const erg = rkBeitrag(g, fraktion, req.userId, RK_NACHSCHUB_PUNKTE, {});
    if (!erg) return res.status(409).json({ error: 'An dieser Front wird gerade nicht gekämpft.' });
    for (const [r, menge] of Object.entries(RK_NACHSCHUB_KOSTEN)) save.resources[r] -= menge;
    if (!db.private[req.userId]) db.private[req.userId] = {};
    db.private[req.userId].__rkNachschubAt = Date.now();
    const saveVersion = setSaveValue(req.userId, JSON.stringify(save));
    await saveDb();
    return res.json({ ok: true, art, punkte: erg.punkte, roh: erg.roh, sys: erg.sys,
      kosten: RK_NACHSCHUB_KOSTEN, saveVersion, naechsteSperreMs: RK_NACHSCHUB_SPERRE_MS });
  }

  // ---- Die vier Differenz-Handlungen -----------------------------------------------------------
  const def = RK_HANDLUNGEN[art];
  if (!def) return res.status(400).json({ error: 'Unbekannte Handlung.' });
  const basis = rkBasisVon(req.userId);
  const jetzt = Number(save[def.feld]) || 0;
  const gemerkt = Number(basis[def.feld]) || 0;

  // RESET-ERKENNUNG. Prestige, Aufstieg und der Zuruecksetzen-Knopf bauen den Spielstand neu auf
  // und setzen diese Zaehler auf 0. Ohne diesen Zweig waere ein Konto nach dem Prestige so lange
  // gesperrt, bis es seinen alten Stand wieder erreicht hat - bei 400 Expeditionen dauerhaft.
  // Der Basiswert wandert dann einfach nach unten mit; gutgeschrieben wird dabei nichts.
  if (jetzt < gemerkt) {
    basis[def.feld] = jetzt;
    await saveDb();
    return res.json({ ok: true, art, punkte: 0, grund: 'zurueckgesetzt', offen: 0 });
  }

  const offen = Math.floor((jetzt - gemerkt) / def.einheit);
  if (offen <= 0) return res.json({ ok: true, art, punkte: 0, grund: 'nichts_offen', offen: 0 });
  // Nur so viel verbrauchen, wie heute noch wirken kann - der Rest bleibt liegen und ist morgen
  // wieder da. Eine einzelne Einheit darf den Rest ueberschiessen (Math.max(1, ...)), sonst bliebe
  // ein knappes Restbudget fuer immer unbenutzbar; mehr als eine Einheit wird nie verbrannt.
  const maxEinheiten = Math.max(1, Math.ceil(nutzbar / def.punkte));
  const einheiten = Math.min(offen, maxEinheiten);
  if (rkVorschau(rk, req.userId, frontKey, einheiten * def.punkte) <= 0) {
    return res.json({ ok: true, art, punkte: 0, grund: 'tagesdeckel', offen });
  }

  const erg = rkBeitrag(g, fraktion, req.userId, einheiten * def.punkte, {});
  if (!erg) return res.status(409).json({ error: 'An dieser Front wird gerade nicht gekämpft.' });
  basis[def.feld] = gemerkt + einheiten * def.einheit;
  await saveDb();
  return res.json({ ok: true, art, punkte: erg.punkte, roh: erg.roh, sys: erg.sys,
    einheiten, offenDanach: offen - einheiten, name: def.name });
});

// ===== Das Frontlager: Frontmarken gegen Sachwerte ==============================================
// Der Server prueft Dienstgrad und Preis und bucht ab. WAS der Posten gibt, wendet der Client an -
// dieselbe Aufteilung wie beim Fraktionsladen, nur dass die Waehrung hier serverseitig gefuehrt
// wird. Wer den Preis unterschieben wollte, kommt nicht durch: er steht in RK_LAGER, nicht im
// Request. Was der Client mit dem gekauften Posten macht, ist wie ueberall im Spiel seine Sache -
// die knappe Groesse ist die Marke, und die kontrolliert der Server.
app.post('/api/randkriege/lager', authMiddleware, async (req, res) => {
  const posten = String((req.body || {}).posten || '');
  const def = RK_LAGER[posten];
  if (!def) return res.status(400).json({ error: 'Unbekannter Posten.' });

  const g = loadOrInitGalaxy();
  const rk = loadOrInitRandkriege(g);
  const grad = rkBesterGrad(rk, req.userId);
  if (grad < def.grad) {
    return res.status(403).json({ error: 'Dafür fehlt dir der Dienstgrad.', noetig: def.grad, deiner: grad });
  }
  const bestand = (rk.marken || {})[req.userId] || 0;
  if (bestand < def.kosten) {
    return res.status(400).json({ error: 'Nicht genug Frontmarken.', kosten: def.kosten, bestand });
  }
  if (!rk.marken) rk.marken = {};
  rk.marken[req.userId] = bestand - def.kosten;
  await saveDb();
  return res.json({ ok: true, posten, kosten: def.kosten, bestand: rk.marken[req.userId] });
});

// ============ GitHub-Deploy-Webhook: sofortiges Update statt Warten auf den Cron-Job ============
// GitHub ruft diese URL direkt nach einem Push auf. Sicherheit über HMAC-SHA256-Signaturprüfung
// (GITHUB_WEBHOOK_SECRET muss identisch in den GitHub-Repo-Einstellungen UND hier als
// Umgebungsvariable hinterlegt sein). WICHTIG: Die auszuführenden Befehle sind fest verdrahtet
// (DEPLOY_TARGETS) und werden NIEMALS aus dem Request-Body übernommen - nur der Repo-NAME aus dem
// GitHub-Payload entscheidet, welcher der zwei festen Befehle läuft. Das verhindert Command-
// Injection über einen manipulierten Payload, selbst wenn die Signaturprüfung umgangen würde.
const { exec, execSync } = require('child_process');
const DEPLOY_WEBHOOK_SECRET = process.env.DEPLOY_WEBHOOK_SECRET || '';
// Die Kopierliste war bis zum 05.08.2026 von Hand gepflegt - und genau deshalb veraltet. Gemessen
// am echten Ausgabeverzeichnis (`docker exec kepler7-nginx ls -la /usr/share/nginx/html/`) lagen
// dort nur weltraum_kolonie.html, die Icons, manifest.json und service-worker.js. Von den ACHT
// Seiten, die die Spieldatei verlinkt, war KEINE EINZIGE vorhanden: impressum.html,
// datenschutzerklaerung.html, nutzungsbedingungen.html, patchnotes.html, spielanleitung.html und
// die drei SEO-Seiten liefen alle ins Leere. Bei Impressum und Datenschutzerklaerung ist das kein
// Schoenheitsfehler, sondern eine Pflichtangabe. Dazu stand index.html noch auf dem Stand vom
// 21.07.2026 (Handkopie, an den Besitzverhaeltnissen erkennbar: uid 1000 statt root).
//
// Deshalb jetzt MUSTER statt einer Aufzaehlung: Jede neue Seite und jedes neue Bild wird von selbst
// mit ausgeliefert. Eine Liste, die jemand pflegen muss, veraltet wieder - das ist der eigentliche
// Fehler gewesen, nicht die einzelne fehlende Zeile.
// Die vier namentlich genannten Dateien sind stabil und rechtfertigen keinen *.js/*.json-Platzhalter:
// der wuerde die Bauskripte (check-icons.js, build-patchnotes.js, build-icon-subset.js) mit auf den
// oeffentlichen Server legen.
// `|| true` an jedem Schritt: Fehlt eine der Einzeldateien im Repo, soll trotzdem alles andere
// ausgeliefert werden - ein Teil-Deploy ist besser als gar keiner.
// Die Seiten sind der eigentliche Deploy und bleiben deshalb UNGESCHUETZT: Scheitert dieser Schritt,
// soll der Webhook den Fehler melden statt einen halben Erfolg zu protokollieren. Alles danach ist
// einzeln abgesichert - `cp` bricht mit Fehlercode ab, sobald EINE Quelle fehlt, und ohne die
// Trennung haette ein fehlendes Bild die Auslieferung von robots.txt und manifest.json verhindert.
const DEPLOY_WEB_COPY = 'cp -f *.html /deploy/web/ && (cp -f *.png /deploy/web/ || true) && (cp -f robots.txt sitemap.xml /deploy/web/ || true) && (cp -f manifest.json service-worker.js /deploy/web/ || true)';
// Das VERZEICHNIS steht seit der Selbstheilung (28.08.2026) benannt daneben, statt nur im
// Befehlsstring: deployAufraeumen() arbeitet darin, und ein aus dem String geparster Pfad waere
// genau die Sorte Ableitung, die beim naechsten Umbau still danebengreift. Der `command` bleibt
// unveraendert fest verdrahtet - er ist die Sicherheitsentscheidung, nichts daran kommt je aus
// einem Request.
const DEPLOY_TARGETS = {
  'kolonie-kepler7': { dir: '/deploy/kolonie-kepler7', command: 'cd /deploy/kolonie-kepler7 && git pull -q && ' + DEPLOY_WEB_COPY },
  // `chown` nach dem Pull, weil dieser Container als root laeuft und /app per Bind-Mount
  // /DATA/kepler7/backend auf dem Host IST. Ohne die Zeile gehoeren die von hier erzeugten Objekte
  // in .git/objects root - und Sascha kann in seinem eigenen Repo kein git mehr ausfuehren
  // ("Unzureichende Berechtigung zum Hinzufuegen eines Objektes zur Repository-Datenbank").
  // Genau so entstand am 05.08.2026 ein Zustand, in dem der Pi 16 Commits zurueckhing: ein
  // abgebrochener Webhook-Pull hinterliess Sperrdateien und einen halb angewendeten, vorgemerkten
  // Stand, den niemand mehr aufraeumen konnte. uid/gid 1000 ist Sascha (am Ausgabeverzeichnis
  // verifiziert). Numerisch und nicht per Name, weil der Container den Benutzer nicht kennt.
  'kolonie-kepler7-backend': { dir: '/app', command: 'cd /app && git pull -q && (chown -R 1000:1000 .git || true)' }
};
// Der Deploy-Timeout darf NICHT knapp sein, und das ist keine Geschmacksfrage, sondern gemessen
// (18.08.2026, Nachbau in Node): exec() schickt beim Ablauf SIGTERM an die SHELL - nicht an das
// `git` darunter. Der Enkelprozess lief im Versuch weiter und schrieb seine Datei zu Ende
// (killed=true, signal=SIGTERM, Marke trotzdem angelegt). Auf dem Pi bedeutet das: Ein
// abgewuergter Deploy laesst ein `git` weiterschreiben, das niemand mehr beobachtet - also genau
// den Zustand, der den Backend-Deploy am 16.08.2026 fuer 49 Stunden lahmgelegt hat (halb
// geschriebener Arbeitsbaum plus liegengebliebene .git/index.lock).
// Der saubere Hebel waere ein Kill an die PROZESSGRUPPE. Der steht hier bewusst NICHT: `detached`
// erzeugte im selben Versuch keine eigene Gruppe (gemessen: PGID des Kindes = PID des
// Elternprozesses, der Gruppenkill scheiterte mit ESRCH). Eine Behebung, die sich auf eine
// Annahme stuetzt, die schon im Nachbau nicht haelt, waere schlimmer als keine.
// Also: so grosszuegig, dass nur ein ECHTER Haenger ihn ausloest. Ein `git pull` samt `cp` des
// 6-MB-Spielstands und `chown -R` ueber .git kann auf einem Raspberry Pi die alten 30 Sekunden
// ueberschreiten, ohne dass irgendetwas kaputt ist.
const DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;

// ===== Ein Deploy je Ziel gleichzeitig (19.08.2026) =====
// GEMESSEN am echten Vorfall: Der Webhook feuert bei JEDEM Push - auch auf Feature-Branches.
// Wer einen Branch pusht und Sekunden spaeter den PR merged, loest ZWEI Ereignisse aus, und zwei
// `git pull` im selben Repo sind genau die Kollision, die eine halb geschriebene Sperre
// hinterlaesst. Am 19.08. um 05:41 UTC gemessen: .git/HEAD.lock (0 Bytes) und
// .git/refs/heads/master.lock (41 Bytes = fertiger Hash plus Zeilenumbruch), dazu ein
// VORGEMERKTER Stand, der byte-genau einem der eingehenden Commits entsprach. Der Pull war also
// mit den Dateien fertig und wurde waehrend der Ref-Aktualisierung abgeschnitten. Danach
// scheitert JEDER weitere Pull an "Your local changes would be overwritten" - der Deploy steht,
// bis jemand von Hand aufraeumt. Am 16.08. war der zweite Schreiber ein Cron-Job, hier der
// Webhook gegen sich selbst.
//
// Die Sperre liegt bewusst als DATEI vor und nicht als Variable im Prozess: Ein erfolgreicher
// Backend-Pull aendert server.js, nodemon startet daraufhin neu - und der neue Prozess haette
// eine leere Variable, waehrend der alte `git`-Enkel noch laeuft (nachgemessen: ein
// nodemon-Neustart toetet den exec-Enkel NICHT, er laeuft zu Ende). Genau in diesem Fenster
// entsteht die Kollision, und nur eine Datei ueberlebt den Neustart.
//
// Ein uebersprungener Deploy ist ungefaehrlich: `git pull` ist kumulativ, der naechste Lauf holt
// alles mit. Deshalb wird ein waehrenddessen eingegangener Push nur VORGEMERKT und einmal am Ende
// nachgeholt - kein Stapel, keine Warteschlange, die auflaufen kann.
const DEPLOY_LOCK_DIR = process.env.DEPLOY_LOCK_DIR || '/tmp';
// Ein Vorsprung auf den Timeout: Erst wenn eine Sperre aelter ist, als ein Deploy ueberhaupt
// dauern DARF, gilt sie als Leiche. Sonst wuerde ein langsamer Pull sich selbst ueberholen.
const DEPLOY_LOCK_STALE_MS = DEPLOY_TIMEOUT_MS + 60 * 1000;
function deployPfad(repoName, endung) {
  return path.join(DEPLOY_LOCK_DIR, 'kepler7-deploy-' + repoName.replace(/[^A-Za-z0-9._-]/g, '_') + endung);
}
// Exklusives Anlegen ist die eigentliche Sperre: 'wx' schlaegt fehl, wenn die Datei existiert -
// atomar im Dateisystem, ohne Zusatzpaket und ohne Nachlese-Rennen zwischen Pruefen und Anlegen.
function deploySperreNehmen(repoName) {
  const pfad = deployPfad(repoName, '.lock');
  try {
    fs.writeFileSync(pfad, JSON.stringify({ pid: process.pid, seit: new Date().toISOString() }), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') { console.error('Deploy-Sperre nicht anlegbar (' + pfad + '):', e.message); return true; }
    let alter = null;
    try { alter = Date.now() - fs.statSync(pfad).mtimeMs; } catch (e2) {}
    if (alter !== null && alter > DEPLOY_LOCK_STALE_MS) {
      console.warn('Deploy-Sperre fuer ' + repoName + ' ist ' + Math.round(alter / 1000) + 's alt und gilt als verwaist - wird uebernommen.');
      try { fs.unlinkSync(pfad); fs.writeFileSync(pfad, JSON.stringify({ pid: process.pid, seit: new Date().toISOString() }), { flag: 'wx' }); return true; } catch (e3) { return false; }
    }
    return false;
  }
}
function deploySperreFreigeben(repoName) {
  try { fs.unlinkSync(deployPfad(repoName, '.lock')); } catch (e) {}
}
// ---- Deploy-Alarm (22.08.2026, Auftrag Sascha) ----
// NEUN Deploy-Ausfaelle in Folge (14.08.-22.08.) wurden alle erst zufaellig bemerkt, weil der
// Fehler ausschliesslich im Container-Log stand, das niemand liest. Ein gescheiterter Deploy
// meldet sich seither selbst: Mail an DEPLOY_ALARM_MAIL ueber denselben Resend-Mailer wie
// Verify/Reset. Bewusst FAIL-OPEN - der Alarm ist eine Benachrichtigung, keine Sicherung
// (Gegenstueck zur fail-closed Signaturpruefung darunter): Fehlt die Adresse oder scheitert der
// Versand, laeuft der Deploy-Weg unveraendert, und der Grund steht benannt im Log.
const DEPLOY_ALARM_MAIL = process.env.DEPLOY_ALARM_MAIL || '';
// Hoechstens eine Mail je Repo und Stunde: Ein dauerhaft kaputter Deploy feuert bei JEDEM Push
// (Branch-Push UND Merge, siehe Serialisierung), und ein Postfach voller identischer Alarme ist
// so unlesbar wie das Container-Log. Der Speicher ist bewusst nur im RAM - im Fehlerfall aendert
// sich server.js gerade NICHT, nodemon startet also nicht neu und die Stunde haelt.
const DEPLOY_ALARM_PAUSE_MS = 60 * 60 * 1000;
const deployAlarmZuletzt = {};
function deployAlarm(repoName, betreff, detail) {
  console.error('Deploy-Alarm für ' + repoName + ': ' + betreff);
  if (!DEPLOY_ALARM_MAIL) { console.error('Deploy-Alarm: DEPLOY_ALARM_MAIL ist nicht gesetzt - keine Mail verschickt.'); return; }
  const jetzt = Date.now();
  if (deployAlarmZuletzt[repoName] && jetzt - deployAlarmZuletzt[repoName] < DEPLOY_ALARM_PAUSE_MS) return;
  deployAlarmZuletzt[repoName] = jetzt;
  const text = 'Deploy-Webhook für ' + repoName + ' ist gescheitert.\n\n' + betreff +
    (detail ? '\n\n' + String(detail).slice(0, 2000) : '') +
    '\n\nNächste Schritte:\n' +
    '- docker logs --tail 80 kepler7-backend | grep -i deploy-webhook\n' +
    '- Stand von außen: curl -s https://gamegeeeeek.de/api/health (commit/checkout/blob vergleichen)\n' +
    '- Rettungsweg: CLAUDE.md des Backend-Repos, Abschnitt "Der Wiederherstellungsweg"';
  sendEmail(DEPLOY_ALARM_MAIL, '[Kepler-7] Deploy-Fehler: ' + repoName,
    '<pre style="font-family:monospace;white-space:pre-wrap">' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>', text)
    .then(() => console.log('Deploy-Alarm-Mail für ' + repoName + ' verschickt.'))
    .catch((e) => console.error('Deploy-Alarm-Mail für ' + repoName + ' fehlgeschlagen:', e.message));
}
// ===== Selbstheilung vor dem Pull (28.08.2026, Auftrag Sascha) ===============================
// ZWOELF Deploy-Ausfaelle, und sechs davon (Nr. 6, 7, 8, 9, 11, 12) hatten denselben
// Fingerabdruck: Arbeitsbaum neu, .git/HEAD alt, eine *.lock liegengeblieben. Ab da bricht JEDER
// weitere Pull ab, und der Deploy steht bis zum naechsten SSH-Zugang - beim schlimmsten Mal
// 49 Stunden, beim letzten fuenf Tage.
//
// DIE URSACHE IST SEIT NR. 12 BELEGT und steht im Container-Log: `git pull` schreibt server.js,
// nodemon sieht die Aenderung, wartet kurz auf den Subprozess ("still waiting for 1 sub-process
// to finish") und beendet ihn - BEVOR git den Ref aktualisiert hat. Der Deploy sabotiert sich
// also ueber seinen eigenen Neustart; die Sperrdatei je Ziel (#147) kann das nicht abfangen, sie
// serialisiert zwei WEBHOOKS gegeneinander und hier gab es nur einen.
//
// Diese Funktion behebt nicht die Ursache - sie macht den Zustand danach reparabel, ohne dass
// jemand sich einloggen muss. Sie laeuft VOR jedem Pull und raeumt genau zwei Dinge weg, beide
// nur unter Beweis:
//   (1) eine verwaiste *.lock - aber ausschliesslich, wenn KEIN git-Prozess lebt und die Sperre
//       aelter ist, als ein Deploy ueberhaupt dauern darf;
//   (2) eine geaenderte Datei, deren Inhalt NACHWEISLICH schon im Ursprung steht (der Blob
//       stimmt mit FETCH_HEAD ueberein) - also genau der halb angewendete Pull.
// Alles andere bleibt liegen und wird gemeldet. Eine Handaenderung an server.js auf dem Pi hat
// den Deploy am 18.08.2026 schon einmal blockiert; sie automatisch wegzuwerfen waere die
// teurere Fehlerrichtung als ein stehender Deploy.
const GIT_LOCK_STALE_MS = DEPLOY_TIMEOUT_MS + 60 * 1000;
// Lebt ein git-Prozess? ueber /proc, nicht ueber `ps` oder `pgrep`: Der Container sammelt
// verwaiste `[git] <defunct>`-Zombies (gemessen: mehrere hundert, der aelteste zweieinhalb Tage),
// und `pgrep -x git` findet einen Zombie ueber den Prozessnamen. Wer eine Leiche fuer einen
// laufenden Pull haelt, raeumt nie auf - deshalb wird der ZUSTAND mitgelesen (Feld 3 in
// /proc/<pid>/stat, 'Z' = Zombie).
function lebenderGitProzess() {
  let pids;
  try { pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)); } catch (e) { return false; }
  for (const pid of pids) {
    let roh;
    try { roh = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); } catch (e) { continue; }
    // comm steht in Klammern und kann selbst Leerzeichen enthalten - deshalb ab der SCHLIESSENDEN
    // Klammer zerlegen, nie den ganzen String splitten.
    const zu = roh.lastIndexOf(')');
    if (zu < 0) continue;
    const comm = roh.slice(roh.indexOf('(') + 1, zu);
    const zustand = (roh.slice(zu + 2).trim().split(/\s+/)[0] || '');
    if (comm === 'git' && zustand !== 'Z') return true;
  }
  return false;
}
function gitSperrenFinden(gitDir) {
  const treffer = [];
  const gehe = (d, tiefe) => {
    if (tiefe > 4) return;
    let eintraege;
    try { eintraege = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of eintraege) {
      const voll = path.join(d, e.name);
      if (e.isDirectory()) gehe(voll, tiefe + 1);
      else if (e.name.endsWith('.lock')) treffer.push(voll);
    }
  };
  gehe(gitDir, 0);
  return treffer;
}
function deployAufraeumen(repoName, dir) {
  const bericht = [];
  if (!dir) return bericht;
  const gitDir = path.join(dir, '.git');
  try { if (!fs.statSync(gitDir).isDirectory()) return bericht; } catch (e) { return bericht; }
  // Laeuft ein echter Pull, ist JEDE Sperre und jede Aenderung seine - nichts anfassen.
  if (lebenderGitProzess()) { bericht.push('ein git-Prozess laeuft - nicht aufgeraeumt'); return bericht; }

  for (const pfad of gitSperrenFinden(gitDir)) {
    let alter = null;
    try { alter = Date.now() - fs.statSync(pfad).mtimeMs; } catch (e) { continue; }
    if (alter === null || alter < GIT_LOCK_STALE_MS) {
      bericht.push('Sperre ' + path.relative(dir, pfad) + ' ist erst ' + Math.round((alter||0)/1000) + 's alt - bleibt liegen');
      continue;
    }
    try { fs.unlinkSync(pfad); bericht.push('verwaiste Sperre entfernt: ' + path.relative(dir, pfad) + ' (' + Math.round(alter/1000) + 's alt)'); }
    catch (e) { bericht.push('Sperre ' + path.relative(dir, pfad) + ' nicht entfernbar: ' + e.message); }
  }

  // Der halb angewendete Pull: geaenderte Dateien, deren Blob schon dem eingehenden Stand
  // entspricht. Der Vergleich laeuft gegen FETCH_HEAD, nicht gegen einen geratenen Commit -
  // und je Datei EINZELN, damit eine fremde Handaenderung daneben unangetastet bleibt.
  const git = (args) => execSync('git ' + args, { cwd: dir, timeout: 60000, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  try {
    git('fetch -q');
    const geaendert = git('diff --name-only -z').split('\0').filter(Boolean);
    for (const datei of geaendert) {
      let ist, soll;
      try { ist = git('hash-object -- "' + datei + '"'); } catch (e) { continue; }
      try { soll = git('rev-parse FETCH_HEAD:"' + datei + '"'); } catch (e) { soll = null; }
      if (soll && ist === soll) {
        try { git('checkout HEAD -- "' + datei + '"'); bericht.push('halb angewendeter Pull zurueckgesetzt: ' + datei + ' (Blob ' + ist.slice(0,7) + ' steht bereits im Ursprung)'); }
        catch (e) { bericht.push(datei + ' nicht zuruecksetzbar: ' + e.message); }
      } else {
        bericht.push(datei + ' ist eine FREMDE Aenderung (Blob ' + String(ist).slice(0,7) + ', Ursprung ' + String(soll).slice(0,7) + ') - bleibt liegen, der Pull wird daran scheitern');
      }
    }

    // Der dritte Fall, gemessen am 28.08.2026: Ein abgeschnittener Pull laesst auch DATEIEN
    // liegen, die der eingehende Stand erst ANLEGT - sie sind unversioniert und fallen durch
    // beide Wachen oben. git bricht an ihnen ab ("untracked working tree files would be
    // overwritten by merge"), und die Heilung half deshalb ausgerechnet bei jedem Commit nicht,
    // der eine Datei hinzufuegt - bei diesem Projekt fast jedem, weil zu jeder Etappe ein neuer
    // Waechter gehoert. Weggelegt wird, nie geloescht, und nur mit demselben Beweis wie oben:
    // der Pfad muss im eingehenden Stand vorkommen. Alles andere ist eine fremde Datei.
    const unversioniert = git('ls-files --others --exclude-standard -z').split('\0').filter(Boolean);
    for (const datei of unversioniert) {
      let soll = null;
      try { soll = git('rev-parse FETCH_HEAD:"' + datei + '"'); } catch (e) { soll = null; }
      if (!soll) continue; // der eingehende Stand kennt sie nicht - der Pull stoert sich nicht an ihr
      const ziel = path.join(os.tmpdir(), 'kepler7-deploy-beiseite', String(Date.now()), datei);
      try {
        fs.mkdirSync(path.dirname(ziel), { recursive: true });
        fs.renameSync(path.join(dir, datei), ziel);
        bericht.push('unversionierte Datei beiseitegelegt: ' + datei + ' -> ' + ziel + ' (der eingehende Stand legt sie an)');
      } catch (e) {
        bericht.push(datei + ' nicht beiseitezulegen: ' + e.message + ' - der Pull wird daran scheitern');
      }
    }
  } catch (e) {
    bericht.push('Arbeitsbaum nicht pruefbar: ' + e.message);
  }
  return bericht;
}
// ---- Selbst-Neustart nach einem erfolgreichen Deploy (28.08.2026, Entscheidung Sascha) -------
// WARUM es das gibt, ist gemessen und nicht vermutet: Bis hierher lief dieser Container mit
// `nodemon --watch . --ext js,json`. `git pull` schreibt server.js, nodemon sieht das SOFORT und
// startet neu - und raeumt dabei den noch laufenden git-Prozess mit ab, BEVOR er den Ref gesetzt
// hat. Zurueck bleiben ein neuer Arbeitsbaum bei altem HEAD und eine liegengebliebene Sperre; ab
// da prallt jeder weitere Pull ab. Dreizehn Deploy-Ausfaelle, alle mit diesem Fingerabdruck.
//
// Der BELEG fuer die Ursache ist die Asymmetrie: Der Frontend-Deploy laeuft ueber denselben
// Webhook, dieselben Pushes und dieselben parallel arbeitenden Sitzungen - und hatte NULL
// Ausfaelle. Der einzige Unterschied ist, dass dort niemand das gepullte Verzeichnis beobachtet.
// Die Parallelitaet war also nie die Ursache, sie hat die Haeufigkeit erhoeht.
//
// Ohne nodemon gibt es dieses Fenster nicht: Der Pull laeuft vollstaendig durch, und ERST DANACH
// beendet sich der Prozess selbst - ueber handleTerminate, damit die DB geflusht wird (ein nacktes
// process.exit haette hier einen Datenverlust gegen einen Deploy-Ausfall getauscht). Docker
// startet ihn per restart-policy `unless-stopped` neu.
//
// DER SCHALTER IST PFLICHT, keine Vorsicht: Solange nodemon laeuft, ist ein Selbst-Exit fuer
// nodemon ein CRASH, nach dem es ausdruecklich auf eine Dateiaenderung WARTET
// ("app crashed - waiting for file changes") - der Server bliebe unten, bis jemand eine Datei
// anfasst. Er gehoert deshalb gemeinsam mit dem Container-Umbau gesetzt, nie vorher.
const DEPLOY_SELBST_NEUSTART = process.env.DEPLOY_SELBST_NEUSTART === '1';

function deploySelbstNeustart(repoName, dir) {
  if (!DEPLOY_SELBST_NEUSTART) return false;
  // Nur das EIGENE Verzeichnis: Der Frontend-Deploy zieht ein fremdes Repo, dessen Dateien mit
  // diesem Prozess nichts zu tun haben - ein Neustart darauf waere grundlose Unruhe.
  try { if (path.resolve(dir || '') !== path.resolve(__dirname)) return false; } catch (e) { return false; }
  const geaendert = geaenderteModule();
  if (!geaendert.length) return false;   // z.B. ein reiner Doku-Commit: kein Neustart
  console.log('Deploy-Webhook: geaenderter Code (' + geaendert.join(', ') + ') - dieser Prozess beendet sich, Docker startet ihn neu.');
  handleTerminate('DEPLOY-NEUSTART');
  return true;
}

function starteDeploy(repoName, command, dir) {
  if (!deploySperreNehmen(repoName)) {
    // Nicht abweisen, sondern vormerken - sonst ginge ausgerechnet der Push verloren, der
    // waehrend eines laufenden Deploys ankommt (also der haeufigste Fall bei Push + Merge).
    try { fs.writeFileSync(deployPfad(repoName, '.pending'), String(Date.now())); } catch (e) {}
    console.log('Deploy-Webhook: fuer ' + repoName + ' laeuft bereits ein Deploy - dieser Push wird nachgeholt.');
    return;
  }
  // Die Selbstheilung steht HINTER der Sperre und VOR dem Pull: Waere sie davor, koennte sie
  // einem parallel laufenden Deploy ins Verzeichnis greifen; danach waere sie wirkungslos, weil
  // der Pull an genau dem Zustand scheitert, den sie aufraeumen soll.
  try {
    for (const zeile of deployAufraeumen(repoName, dir)) console.warn('Deploy-Aufraeumen (' + repoName + '): ' + zeile);
  } catch (e) { console.error('Deploy-Aufraeumen (' + repoName + ') fehlgeschlagen:', e.message); }
  exec(command, { timeout: DEPLOY_TIMEOUT_MS }, (err, stdout, stderr) => {
    deploySperreFreigeben(repoName);
    // Eine Zeitueberschreitung bekommt eine EIGENE Meldung: Sie bedeutet etwas anderes als ein
    // gescheiterter Befehl - der git-Prozess darunter kann weiterlaufen und muss von Hand geprueft
    // werden. Als generisches "Fehler" gemeldet, sieht der gefaehrlichste Ausgang aus wie der
    // harmloseste.
    if (err && err.killed) {
      console.error('Deploy-Webhook ZEITUEBERSCHREITUNG für ' + repoName + ' nach ' + Math.round(DEPLOY_TIMEOUT_MS/1000) + 's (' + err.signal + '). ACHTUNG: der git-Prozess darunter laeuft moeglicherweise weiter und schreibt in .git - vor dem naechsten Deploy pruefen (ps nach lebendem git, find .git -name "*.lock").');
      deployAlarm(repoName, 'ZEITUEBERSCHREITUNG nach ' + Math.round(DEPLOY_TIMEOUT_MS/1000) + 's (' + err.signal + ') - der git-Prozess darunter laeuft moeglicherweise weiter und schreibt in .git.', stderr);
    }
    else if (err) {
      console.error('Deploy-Webhook Fehler für ' + repoName + ':', err.message);
      deployAlarm(repoName, err.message, stderr);
    }
    else console.log('Deploy-Webhook erfolgreich für ' + repoName + ':', stdout.trim() || '(keine Änderungen)');
    const pending = deployPfad(repoName, '.pending');
    if (fs.existsSync(pending)) {
      try { fs.unlinkSync(pending); } catch (e) {}
      console.log('Deploy-Webhook: hole den waehrenddessen eingegangenen Push fuer ' + repoName + ' nach.');
      starteDeploy(repoName, command, dir);
      return;   // ueber den Neustart entscheidet der nachgeholte Lauf - sonst ginge er verloren
    }
    if (!err) deploySelbstNeustart(repoName, dir);
  });

// Ein vorgemerkter Push darf den Neustart nicht ueberleben, ohne dass ihn jemand nachholt: Der
// .pending-Marker ist eine DATEI, sie ueberdauert den Prozess - gelesen wurde sie bisher aber nur
// im laufenden Deploy. Ohne diese Zeilen risse der Selbst-Neustart genau die Luecke auf, die die
// Vormerkung schliessen soll (ein Push, der in der Spanne zwischen Pruefung und Exit ankommt).
// setImmediate, damit der Rumpf keine Konstante in ihrer temporalen Todeszone trifft - dieselbe
// Falle, die den Startlauf von galaxyTick einmal den ganzen Serverstart gekostet hat.
setImmediate(() => {
  for (const [repoName, ziel] of Object.entries(DEPLOY_TARGETS)) {
    try {
      if (!fs.existsSync(deployPfad(repoName, '.pending'))) continue;
      console.log('Deploy-Webhook: beim Start einen vorgemerkten Push fuer ' + repoName + ' gefunden - wird nachgeholt.');
      fs.unlinkSync(deployPfad(repoName, '.pending'));
      starteDeploy(repoName, ziel.command, ziel.dir);
    } catch (e) { console.error('Deploy-Webhook: vorgemerkten Push fuer ' + repoName + ' nicht nachholbar:', e.message); }
  }
});
}
function verifyGithubSignature(req) {
  if (!DEPLOY_WEBHOOK_SECRET) return false;
  const sig = req.headers['x-hub-signature-256'];
  if (!sig || !req.rawBody) return false;
  const hmac = crypto.createHmac('sha256', DEPLOY_WEBHOOK_SECRET);
  const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');
  try {
    const a = Buffer.from(sig), b = Buffer.from(digest);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}
/* =============================================================================================
   Asteroidenfeld - der geteilte, umkämpfte Vorrat (Konzept docs/asteroiden-konzept.md 3.3.2/6.4)

   WARUM DER SERVER DAS FELD ERZEUGT UND NICHT NACHRECHNET. Die erste Idee war, dass Client und
   Server dasselbe Feld unabhängig aus einem Seed ausrechnen und nur die Abweichung gespeichert
   wird. Seit der Nachschub WANDERT (Konzept 3.3.1) geht das nicht mehr: Ein Feld, das sich bei
   jeder Erschöpfung an einer zufälligen anderen Stelle neu bildet, ist Geschichte, keine Formel.
   Zwei Implementierungen derselben Geschichte müssten dauerhaft synchron bleiben - genau die
   Fehlerklasse, an der dieses Projekt schon mehrfach hing (CLAUDE.md: "Backend hat teils eigene
   Kopien von Frontend-Formeln").
   Deshalb: **Der Server erzeugt und führt das Feld, der Client zeigt nur an, was er bekommt.**
   Die einzige verbleibende Parität sind die SCHLÜSSEL der Sorten und Größen - der Client muss
   wissen, wie ein 'magnetit' aussieht. Genau das prüft tests/test_asteroid_paritaet_http.js.

   FAUL STATT TIMER. Ein erschöpfter Platz bekommt einen Termin (`nachschubAb`); beim nächsten
   LESEN des Feldes prüft der Server, welche Termine fällig sind, und würfelt dort neu aus. Auf dem
   Pi läuft kein Hintergrundjob, und es gibt nichts, was bei einem Neustart hängenbleiben kann.
   Liest wochenlang niemand ein System, holt der erste Blick alles auf einmal nach.

   OHNE SPERREN SICHER, aus demselben Grund wie die Modulbörse weiter oben: Der gesamte
   Zustandswechsel eines Endpunkts läuft synchron in EINEM Tick, das erste await steht erst hinter
   saveDb(). Zwei gleichzeitige Abbaumissionen auf denselben Brocken können sich nicht überlappen -
   der zweite bekommt, was der erste übrig gelassen hat. Dieser Grund gehört hierher als Kommentar,
   sonst "repariert" ihn irgendwann jemand kaputt.
============================================================================================= */
const AST_SEED = 'kepler7-asteroiden-v1';
const AST_GUERTEL_ZAHL = 20;            // von 69 Systemen - bei wachsender Spielerschaft erhöhen
const AST_PLAETZE_JE_GUERTEL = 10;      // feste Positionen auf der Gürtelbahn
const AST_VORKOMMEN_MIN = 4, AST_VORKOMMEN_MAX = 6;   // Startbelegung je Gürtelsystem
const AST_GRENZE_MIN = 3, AST_GRENZE_MAX = 8;         // Schranken beim Wandern des Nachschubs
const AST_SYSTEMWECHSEL = 0.30;         // Anteil des Nachschubs, der in ein anderes System wandert
// Sorten und Größen: NUR die Felder, die der Server für Erzeugung und Buchführung braucht. Namen,
// Icons, Farben und die Rohstoff-Aufteilung bleiben im Frontend - der Server verteilt keine
// Ressourcen, er führt nur Vorrat. Die Schlüssel müssen mit ASTEROID_SORTEN/ASTEROID_GROESSEN
// im Frontend übereinstimmen; test_asteroid_paritaet_http.js prüft genau das.
const AST_SORTEN = [
  { key: 'eisen', gewicht: 22 }, { key: 'prisma', gewicht: 18 }, { key: 'eiskern', gewicht: 15 },
  { key: 'magnetit', gewicht: 12 }, { key: 'hydrat', gewicht: 11 }, { key: 'klathrat', gewicht: 9 },
  { key: 'pechblende', gewicht: 5 }, { key: 'resonanz', gewicht: 5 }, { key: 'kometenkern', gewicht: 3 },
  // Urmateriekern (17.08.2026): die einzige Sorte, die Protomaterie fuehrt. Fuer den Server ist sie
  // eine Sorte wie jede andere - er verteilt keine Ressourcen, er zieht nur Sorte und Groesse und
  // fuehrt den Vorrat. Wieviel Protomaterie sie hergibt, steht allein im Frontend
  // (PROTOMATERIE_JE_FUHRE); hier zaehlt nur, dass der Schluessel und das Gewicht uebereinstimmen -
  // test_asteroid_paritaet.js im Frontend-Repo prueft genau das.
  { key: 'urmaterie', gewicht: 3 }
];
const AST_GROESSEN = [
  { key: 'splitter', vorrat: 50000, plaetze: 4, gewicht: 46, nachschubStd: 3 },
  { key: 'brocken', vorrat: 150000, plaetze: 8, gewicht: 34, nachschubStd: 8 },
  { key: 'kern', vorrat: 500000, plaetze: 16, gewicht: 16, nachschubStd: 20 },
  { key: 'koloss', vorrat: 1500000, plaetze: 30, gewicht: 4, nachschubStd: 48 }
];
// Obergrenze für eine einzelne Ladung, hergeleitet aus der WIRKLICH gespeicherten Flotte. Das ist
// bewusst KEIN Nachbau der Client-Formel (die hängt an Cargo-Modulen, Werftmarken und Forschung -
// sie hier zu spiegeln hieße, zwei Formeln dauerhaft synchron zu halten). Es ist eine großzügige
// Schranke, die kein ehrlicher Spieler je erreicht, und sie schließt trotzdem genau das Loch, auf
// das es ankommt: dass ein manipulierter Client mit einem einzigen Minenschiff einen Kern leersaugt.
// WICHTIG: Die Schlüssel unten müssen die SPIELSTAND-Schlüssel des Frontends sein. Der große
// Frachter heißt dort 'frachtergross'; bis zum 15.08.2026 stand hier 'grossfrachter', also ein
// Feld, das es im Spielstand nie gab - der Term war damit immer 0 und die Schranke zählte den
// größten Frachter des Spiels gar nicht mit. Zusammen mit dem seit v8.495.0 fehlenden
// Bergungsfrachter wurde eine ehrliche Kolossflotte um über die Hälfte ihrer Ladung gekürzt,
// ohne dass irgendwo ein Fehler erschien: menge = min(wunsch, vorrat, obergrenze) schneidet
// stillschweigend ab, und der Client übernimmt die Server-Zahl.
// tests/test_abbau_obergrenze.js (Frontend-Repo) vergleicht diese Liste jetzt maschinell gegen
// die Frachttabellen der Spieldatei und schlägt an, sobald ein Ladungsträger hier fehlt.
const AST_MAX_JE_SCHUERFSCHIFF = 2000;    // Bunker 400 * Fördertechnik 1,4 -> 560; Faktor 3,5 Luft
const AST_MAX_JE_FRACHTER = 1500;         // Frachter 300 * Modul-/Markenspielraum
const AST_MAX_JE_GROSSFRACHTER = 7500;    // grosser Frachter 1500, derselbe Spielraum
const AST_MAX_JE_BERGUNGSFRACHTER = 15000; // Bergungsfrachter 3000, derselbe Spielraum
function astFeldKey(sysId) { return 'asteroids:' + sysId; }
// Deterministische Auswahl der Gürtelsysteme: dieselbe 5x4-Rasterstreuung wie im Frontend, damit
// die Gürtel über die ganze Karte verteilt liegen statt in einer Ecke zu klumpen. Sie ist hier NICHT
// paritätspflichtig (der Client bekommt die Liste vom Server), sondern nur stabil - dieselbe
// Galaxie soll bei jedem Serverstart dieselben Gürtel haben.
let _astGuertelCache = null;
function astGuertelSysteme() {
  if (_astGuertelCache) return _astGuertelCache;
  const sys = SYSTEM_COORDS;
  const xs = sys.map(s => s.gx), ys = sys.map(s => s.gy);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const SPALTEN = 5, ZEILEN = 4;
  const zellen = new Map();
  const hash = s => astHash(AST_SEED + ':' + s.id);
  for (const s of sys) {
    const cx = Math.min(SPALTEN - 1, Math.floor((s.gx - x0) / ((x1 - x0) || 1) * SPALTEN));
    const cy = Math.min(ZEILEN - 1, Math.floor((s.gy - y0) / ((y1 - y0) || 1) * ZEILEN));
    const k = cx + ':' + cy;
    const h = hash(s);
    const bisher = zellen.get(k);
    if (!bisher || h < bisher.h) zellen.set(k, { id: s.id, h });
  }
  let gewaehlt = [...zellen.values()];
  if (gewaehlt.length > AST_GUERTEL_ZAHL) {
    gewaehlt = gewaehlt.sort((a, b) => a.h - b.h).slice(0, AST_GUERTEL_ZAHL);
  } else if (gewaehlt.length < AST_GUERTEL_ZAHL) {
    const drin = new Set(gewaehlt.map(g => g.id));
    const rest = sys.filter(s => !drin.has(s.id)).map(s => ({ id: s.id, h: hash(s) })).sort((a, b) => a.h - b.h);
    gewaehlt = gewaehlt.concat(rest.slice(0, AST_GUERTEL_ZAHL - gewaehlt.length));
  }
  _astGuertelCache = gewaehlt.map(g => g.id).sort();
  return _astGuertelCache;
}
// Stabiler Hash 0..1 für die Systemauswahl. Nur dafür - der Feldinhalt selbst wird echt gewürfelt
// (er ist Geschichte, siehe Kopfkommentar) und darf gerade NICHT reproduzierbar sein.
function astHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}
function astZieheGewichtet(liste) {
  const summe = liste.reduce((a, x) => a + x.gewicht, 0);
  let r = Math.random() * summe;
  for (const x of liste) { r -= x.gewicht; if (r <= 0) return x; }
  return liste[liste.length - 1];
}
// Wie weit liegt das System von der Heimat? 0 = Zentrum, 1 = äußerster Rand. Draußen liegen die
// dickeren Brocken - das ist der Grund, überhaupt weit zu fliegen.
function astFerne(sysId) {
  const heimat = SYSTEM_COORDS.find(s => s.id === 'kepler') || SYSTEM_COORDS[0];
  const s = SYSTEM_COORDS.find(x => x.id === sysId);
  if (!s || !heimat) return 0.5;
  const d = Math.hypot(s.gx - heimat.gx, s.gy - heimat.gy);
  const max = Math.max(...SYSTEM_COORDS.map(x => Math.hypot(x.gx - heimat.gx, x.gy - heimat.gy))) || 1;
  return Math.min(1, d / max);
}
function astZieheGroesse(sysId) {
  const f = astFerne(sysId);
  // fernBonus wie im Frontend: draußen verschiebt sich die Verteilung zu den großen Brocken.
  const bonus = { splitter: -0.5, brocken: 0, kern: 0.8, koloss: 2.0 };
  const gewichtet = AST_GROESSEN.map(g => ({
    key: g.key, gewicht: Math.max(0.2, g.gewicht * (1 + (bonus[g.key] || 0) * f))
  }));
  // EINMAL ziehen, dann suchen. Stünde der Zug im find()-Rückruf, würde er für JEDES Element neu
  // gewürfelt - dann trifft die Suche nur zufällig, liefert oft undefined und verzerrt nebenbei die
  // Verteilung. Genau so war die erste Fassung, und der Server stürzte beim ersten Feldaufbau ab.
  const gezogen = astZieheGewichtet(gewichtet);
  return AST_GROESSEN.find(g => g.key === gezogen.key) || AST_GROESSEN[0];
}
function astNeuesVorkommen(sysId) {
  const g = astZieheGroesse(sysId);
  const s = astZieheGewichtet(AST_SORTEN);
  // Vorrat streut um +-20%, damit zwei Kerne nicht identisch aussehen.
  const vorrat = Math.round(g.vorrat * (0.8 + Math.random() * 0.4));
  return { sorte: s.key, groesse: g.key, vorrat };
}
function astLeeresFeld() { return { plaetze: {} }; }
// Erstbelegung eines Gürtelsystems.
function astErzeugeFeld(sysId) {
  const feld = astLeeresFeld();
  const anzahl = AST_VORKOMMEN_MIN + Math.floor(Math.random() * (AST_VORKOMMEN_MAX - AST_VORKOMMEN_MIN + 1));
  const plaetze = [];
  for (let i = 0; i < AST_PLAETZE_JE_GUERTEL; i++) plaetze.push(String(i));
  for (let i = plaetze.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [plaetze[i], plaetze[j]] = [plaetze[j], plaetze[i]]; }
  for (const p of plaetze.slice(0, anzahl)) feld.plaetze[p] = astNeuesVorkommen(sysId);
  return feld;
}
function astBelegtZahl(feld) {
  return Object.values(feld.plaetze || {}).filter(p => p && !p.frei && (p.vorrat || 0) > 0).length;
}

/* ===== Asteroidenfestungen (18.08.2026, docs/aliens-asteroidenfestungen-konzept.md Abschnitt 4)
   ============================================================================================
   Eine Festung besetzt EINEN freien Platz auf der Gürtelbahn eines Gürtelsystems - dieselben zehn
   Positionen, auf denen die Vorkommen liegen. Sie lebt IM SELBEN Felddokument (asteroids:<sys>);
   das ist keine Bequemlichkeit, sondern hat zwei Gründe: /api/asteroid/field liefert sie ohne
   neuen Endpunkt mit, und der Sekunden-Auffangcache der Karte im Frontend führt das Feld bereits
   in seiner Signatur - eine Festung, die woanders läge, erschiene bis zu fünf Sekunden zu spät.

   Höchstens EINE je System (sie wirkt auf das ganze System - zwei würden ihre Blockaden stapeln,
   und der Spieler stünde vor einer Rechnung statt vor einer Entscheidung) und höchstens sechs
   galaxieweit: Bei zwanzig gäbe es kein unblockiertes Gürtelsystem mehr, und die Blockade wäre
   keine Bedrohung, sondern eine Steuer. Bei sechs bleibt immer die Wahl "woanders schürfen oder
   die Festung schleifen" - und genau diese Wahl ist der Inhalt.

   Die Stufe hängt an astFerne() - dem vorhandenen Maß, das schon die Größenverteilung der
   Vorkommen steuert. Anfänger finden in Reichweite eine Festung, die sie knacken können; die
   harten stehen dort, wo Flugzeit und Treibstoff ohnehin wehtun. Keine zweite Schwierigkeitszahl.

   LEBENSPUNKTE, nachgerechnet gegen computeAttackPowerFromComposition (nicht geschätzt):
   ein Mittelfeld-Konto bringt rund 7.000 Angriffskraft, ein Endspiel-Konto 90.000-120.000. Bei
   Schaden = Kraft * 0,8-1,2 und sechs Stunden Abklingzeit JE FESTUNG heisst das: Schanze = ein
   Solo-Ziel (1-2 Schläge im Endspiel, ~4 Tage im Mittelfeld), Kastell = zwei bis drei Tage oder
   zwei Mitspieler, Sternenfeste = ohne Allianz eine Zumutung. Absicht: Eine Festung soll NICHT an
   einem Nachmittag verschwinden - sie soll lange genug stehen, dass die Blockade spürbar ist.

   DER HORT ist der eigentliche Anreiz, und er hängt an der PROTOMATERIE, nicht an der Tonnage.
   Der Grund steht im Frontend bei PROTOMATERIE_SORTE und ist gemessen: Ein entwickeltes Konto
   produziert 8,81 Mio. Erz je STUNDE, die beste Abbaufuhre des Spiels entspricht davon 73
   SEKUNDEN. Ein T1-Hort von 900.000 wäre im Endspiel sechs Minuten Produktion - unsichtbar.
   Protomaterie dagegen kann keine Fabrik herstellen; gemessen sind es 11 je Stunde mit einer
   Schürfflotte, 32 mit dreien. Ein Sternenfesten-Hort von 480 ist damit 44 Stunden Förderung,
   aufgeteilt unter allen Angreifern. Die T1-Beute bleibt als Belohnung für das junge Konto, das
   die Schanze in Heimatnähe schleift - dort sind 120.000 Einheiten tatsächlich Geld. */
/* DER SCHALTER, DER DIESE PHASE ALLEIN AUSLIEFERBAR MACHT (18.08.2026).
   Steht er auf false, entsteht keine Festung - und ohne Festung tut der ganze Rest dieses
   Abschnitts nichts: Die Blockade in /api/asteroid/mine findet keine, /api/festung/angriff
   antwortet "steht keine Festung mehr", astFreiePlaetze verhält sich wie zuvor.

   WARUM ES IHN BRAUCHT: Backend und Frontend gehen über zwei GETRENNTE fest verdrahtete Befehle
   desselben Webhooks live (siehe "Deploy"), und historisch sind sie dreimal auseinandergelaufen.
   Ginge dieses Backend allein live, entstünde binnen Stunden eine Festung, und die Blockade
   kürzte die Abbauladung um bis zu 55 % - während das Frontend die UNGEKÜRZTE Vorschau zeigt,
   das Feld `festung` gar nicht kennt und nichts davon erklären kann. Gemessen am Frontend-Code
   (`echt = daten.menge`, Z. 55880): Der Spieler bekommt still weniger, als die Vorschau ihm
   versprochen hat, ohne einen einzigen Hinweis worauf. Das ist genau die Sorte stiller
   Verschlechterung, für die ein Spieler zu Recht einen Fehlerbericht schreibt.
   Dazu käme eine ausdrückliche Falschaussage: Die Galaxie-Nachricht beim Entstehen KÜNDIGT die
   Protomaterie-Drosselung an, und die kann ohne das Frontend gar nicht wirken (siehe
   `protoBlockade` in /api/asteroid/mine).

   UMGELEGT AM 18.08.2026 mit dem Frontend der Phase 1 (v8.569.0). Die Bedingung, die hier stand,
   ist damit erfüllt und nachgemessen: Die Karte zeichnet die Festung als eigenen Knoten, das
   Kartenmenü nennt Kern/Blockade/Hort und trägt den Angriff, die Abbau-Vorschau BENENNT die
   Drosselung und zeigt die gekürzte Ladung (gemessen 2,4k statt 5,4k), und der Missionsstart
   schickt weiterhin den ROHEN Wunsch, damit nicht doppelt gekürzt wird.
   Der Schalter bleibt trotzdem stehen: Er ist der Ausschalter, falls sich an den Festungen etwas
   als schädlich erweist - eine Zeile umzulegen ist schneller und sicherer, als einen Merge
   zurückzunehmen, und alles andere (Endpunkte, Härtungen, Tests) bleibt dabei unangetastet. */
const FESTUNG_SPAWN_AKTIV = true;
const FESTUNG_MAX_AKTIV = 6;              // von 20 Gürtelsystemen
const FESTUNG_SPAWN_CHANCE = 0.08;        // je galaxyTick (15 Min) -> im Mittel eine je 3,1 Stunden
const FESTUNG_ABKLING_MS = 6 * 3600 * 1000;   // je Festung UND Spieler, nicht global
const FESTUNG_GERAEUMT_MS = 24 * 3600 * 1000; // Bonusfenster nach dem Fall
const FESTUNG_GERAEUMT_BONUS = 0.15;      // +15 % Abbau-Ladung im geräumten System
// Die Stufen. `fernBis` ist die Obergrenze von astFerne(), bei der diese Stufe entsteht.
/* DIE KERN-LEBENSPUNKTE sind gegen echte Flottenkraefte gerechnet, nicht geschaetzt (18.08.2026).
   Gemessen an rawFleetPower + diminishingShipCount (Schwelle 300, danach halber Wert) fuer drei
   Ausbaustufen, danach die ueblichen Multiplikatoren aus computeAttackPowerFromComposition
   (Vielfalt, rkampf/rkampf2, Haltung) - je Schlag rund:
     junges Konto      6.200 roh  ->  ~7.500
     mittleres Konto  29.400 roh  -> ~44.000
     entwickeltes    85.650 roh  -> ~240.000
   Daraus die Kerne, so dass ein Konto der PASSENDEN Stufe allein etwa vier bis sieben Schlaege
   braucht - bei 6 h Abklingzeit also ein bis zwei Tage, mit Mitstreitern entsprechend weniger.
   Der erste Entwurf stand bei 120.000 fuer die Schanze; das waeren fuer ihr eigentliches Publikum
   NEUNZEHN Schlaege gewesen, also fast fuenf Tage allein - ausgerechnet an dem Ziel, das das
   heimatnahe, junge Konto einladen soll. Zur Einordnung der Groessenordnung: Der Weltboss startet
   bei 50.000 LP und waechst um Faktor 1,6 je Stufe; die Schanze liegt darunter, das Kastell etwa
   bei Weltboss-Stufe 5, die Sternenfeste bei Stufe 8. */
const FESTUNG_STUFEN = {
  schanze:      { name: 'Schanze',      fernBis: 0.40, kern: 30000,   blockade: 0.25, proto: 0.50, hortStd: 2000,  hortDeckel: 120000, protoStd: 1.5, protoDeckel: 90,  verlust: 0.06, kampfpunkte: 15 },
  kastell:      { name: 'Kastell',      fernBis: 0.75, kern: 250000,  blockade: 0.40, proto: 0.75, hortStd: 6000,  hortDeckel: 400000, protoStd: 4,   protoDeckel: 240, verlust: 0.09, kampfpunkte: 40 },
  sternenfeste: { name: 'Sternenfeste', fernBis: 1.01, kern: 1200000, blockade: 0.55, proto: 1.00, hortStd: 15000, hortDeckel: 900000, protoStd: 8,   protoDeckel: 480, verlust: 0.12, kampfpunkte: 90 }
};
/* `verlust` ist der GRUNDANTEIL der eigenen Verluste je Schlag, dazu bis zu 6 % Streuung. Er liegt
   bewusst in derselben Familie wie der Weltboss (dort 8 % + Stufe + Streuung, gedeckelt bei 50 %)
   und bewusst NIEDRIG: In Phase 2 kommen die Geschuetztuerme dazu, und die heben die Quote laut
   Konzept auf das Drei- bis Vierfache, solange sie stehen. Waere der Grundwert schon jetzt hoch,
   haetten die Tuerme keinen Spielraum mehr - der Wert, den man sich mit dem Turmbeschuss erkauft,
   ist der ganze Zweck der Bauteile. */
const FESTUNG_STUFEN_ORDNUNG = ['schanze', 'kastell', 'sternenfeste'];
function festungStufeFuer(sysId) {
  const f = astFerne(sysId);
  for (const k of FESTUNG_STUFEN_ORDNUNG) if (f < FESTUNG_STUFEN[k].fernBis) return k;
  return 'sternenfeste';
}
/* ===== Die drei Bauteile (Phase 2, 18.08.2026) ===============================================
   Eine Festung hat neben dem Kern zwei angreifbare Teile, und die drei vorhandenen Konterrollen
   entscheiden, wie gut man sie trifft. Es wird KEINE neue Rolle und keine neue Tabelle erfunden -
   COUNTER_ROLE_OF ordnet bereits 24 Schiffsklassen einer der drei Rollen zu.

   DIE LEBENSPUNKTE SIND ANTEILE DES KERNS, keine eigenen Zahlen. Damit gibt es eine Größe zu
   pflegen statt drei, und die Bauteile skalieren automatisch mit der Stufe.
   Gerechnet gegen die gemessenen Schlagkräfte (7.500 / 44.000 / 240.000 je Stufe, siehe Kommentar
   bei FESTUNG_STUFEN) - mit einer PASSEND spezialisierten Flotte, also Rollenfaktor 1,6:

     Schild 40 % des Kerns  ->  1,0 bis 1,4 Schläge
     Türme  25 % des Kerns  ->  0,6 bis 0,9 Schläge

   Der erste Entwurf stand bei 30 % / 20 % - damit fielen beide in UNTER einem Schlag, und der
   ganze Abschnitt wäre eine Formalität statt einer Entscheidung gewesen. Mit einer gemischten
   Flotte (Faktor ~1,0) sind es rund 1,6 bis 2,2 bzw. 1,0 bis 1,4 Schläge; Spezialisierung zahlt
   sich also sichtbar aus, ohne dass der Umweg die Belagerung verdoppelt.

   WARUM SICH DER UMWEG ÜBER DEN SCHILD ÜBERHAUPT LOHNT, nachgerechnet: Solange er steht, zählen
   Kerntreffer nur zu 35 %, der Kern kostet also das 2,86-fache. Ihn zu brechen lohnt, solange
   seine LP unter dem 2,98-fachen des Kerns liegen - bei 40 % ist das mit großem Abstand erfüllt.
   Die Mechanik ist damit tragfähig, ohne dass die Zahl fein justiert werden müsste.

   ROLLENFAKTOR NACH ANTEIL, nicht nach Anwesenheit: Ein einzelner Bomber in einer Flotte aus
   zweihundert Kreuzern darf den Schildbonus nicht auslösen. Der Faktor läuft linear zwischen
   `min` (keine passende Rolle) und `max` (reine passende Flotte); `anteil` ist der Anteil an der
   ANGRIFFSKRAFT, nicht an der Schiffszahl - sonst wären hundert Jäger mehr wert als zehn
   Superschlachtschiffe. Dieselbe "nach Anteil"-Konstruktion nutzt der reguläre Kampf bereits. */
/* DERSELBE SCHUTZ WIE BEI FESTUNG_SPAWN_AKTIV, und aus demselben gemessenen Grund. Ginge dieses
   Backend allein live, bekaeme jede neue Festung eine Schildkuppel - und ein Kernschlag richtete
   dann nur noch 35 % an, waehrend die Verluste von 12 % auf 30 % springen. Das Frontend kennt
   `bauteile` nicht, kann also weder das eine erklaeren noch das andere: keine Zielwahl, keine
   Balken, kein Hinweis. Der Spieler saehe nur, dass sein Verband ploetzlich dreimal so teuer ist
   und ein Drittel ausrichtet.
   Steht der Schalter auf false, entsteht KEINE Festung mit Bauteilen - und eine Festung ohne
   `bauteile` verhaelt sich exakt wie in Phase 1 (festungTeilSteht liefert false, jeder Zweig
   faellt zurueck; test_festung_bauteile_http.js Abschnitt 8 haelt das fest).

   SEIT DEM 18.08.2026 STEHT ER AUF TRUE - das Frontend der Phase 2 ist ausgeliefert (v8.575.0),
   und damit ist die Bedingung erfuellt, unter der er auf false stehen musste: Die Zielwahl steht,
   die Bauteil-Balken stehen, und der Hilfetext nennt Durchlass, Verlustquote und Rollenfaktoren
   aus DIESER Tabelle (ueber die Frontend-Kopie, die tests/test_festung_paritaet.js dagegenhaelt).
   Der Schalter bleibt trotzdem stehen - als Notausschalter. Eine Zeile umzulegen ist schneller und
   sicherer als einen Merge zurueckzunehmen, und Endpunkte, Haertungen und Tests bleiben dabei
   unangetastet. test_festung_bauteile_http.js 1d prueft jetzt, dass er auf true steht; ein Wechsel
   auf false ist damit eine bewusste Notabschaltung, die auffaellt statt still zu geschehen - und
   ihr Grund gehoert dann in die CLAUDE.md. */
const FESTUNG_BAUTEILE_AKTIV = true;
const FESTUNG_BAUTEILE = {
  schild: { name: 'Schildkuppel',  anteilKern: 0.40, rolle: 'bomber', min: 0.70, max: 1.60,
            regenProStd: 0.02, kernDurchlass: 0.35 },
  tuerme: { name: 'Geschütztürme', anteilKern: 0.25, rolle: 'abfang', min: 0.70, max: 1.60,
            verlustQuote: 0.30 }
};
// Der Kern selbst traegt ebenfalls einen Rollenfaktor, nur flacher - er ist das Ziel, das man
// auch ohne Spezialisierung sinnvoll angreifen kann.
const FESTUNG_KERN_ROLLE = { rolle: 'kapital', min: 0.85, max: 1.30 };
// Schaden an Schild und Tuermen zaehlt zu 60 % auf den Hortanteil. Ohne diesen Ausgleich wuerde
// niemand den Schild angreifen - die Arbeit nuetzt dem Verband, nicht dem eigenen Zaehler, und die
// ganze Rollen-Mechanik waere tot.
const FESTUNG_BAUTEIL_BEITRAG = 0.60;
/* Der ANTEIL einer Rolle an der Angriffskraft einer Zusammensetzung. Gerechnet ueber
   rawFleetPower je Teilmenge - damit zaehlt dasselbe Gewicht wie im echten Kampf, statt dass eine
   zweite Bewertung danebensteht. */
function festungRollenAnteil(composition, rolle, marks) {
  const ganz = rawFleetPower(composition, 1, 1, marks);
  if (!(ganz > 0)) return 0;
  const nurRolle = {};
  for (const [k, n] of Object.entries(composition || {})) {
    if (typeof n === 'number' && n > 0 && COUNTER_ROLE_OF[k] === rolle) nurRolle[k] = n;
  }
  return Math.max(0, Math.min(1, rawFleetPower(nurRolle, 1, 1, marks) / ganz));
}
function festungRollenFaktor(composition, spec, marks) {
  const anteil = festungRollenAnteil(composition, spec.rolle, marks);
  return spec.min + (spec.max - spec.min) * anteil;
}
// Steht das Bauteil noch? `lp > 0` - der Eintrag bleibt nach der Zerstoerung mit lp 0 stehen,
// damit die Anzeige "zerstoert" von "gab es nie" unterscheiden kann.
function festungTeilSteht(fest, key) {
  const t = fest && fest.bauteile && fest.bauteile[key];
  return !!(t && (t.lp || 0) > 0);
}
/* DIE EINE Stelle, die "welche Plätze sind frei" beantwortet - und die einzige, die von der
   Festung weiss. astNachschub() suchte das an ZWEI Stellen selbst und hätte ein neues Vorkommen
   auf die Festung gesetzt, die damit still verschwunden wäre. Eine Funktion statt zweier Kopien,
   damit ein dritter Aufrufer das Verhalten automatisch erbt (dieselbe Behandlung wie
   kbMarkerFrei im Frontend). */
function astFreiePlaetze(feld) {
  const belegtDurchFestung = feld && feld.festung ? String(feld.festung.platz) : null;
  const frei = [];
  for (let i = 0; i < AST_PLAETZE_JE_GUERTEL; i++) {
    const k = String(i);
    if (k === belegtDurchFestung) continue;
    const q = (feld.plaetze || {})[k];
    if (!q || q.frei) frei.push(k);
  }
  return frei;
}
// Der Hort wächst LAZY beim Lesen, nicht in einem eigenen Takt: Der galaxyTick läuft alle 15
// Minuten, das Feld wird viel häufiger gelesen, und ein Zähler, der nur beim Tick wächst, wäre
// zwischen zwei Ticks eingefroren. Gerechnet wird aus `letzteReifung` - vergangene Stunden mal
// Rate, gedeckelt. Dasselbe Muster wie die Tageszähler an user.marktTag.
function festungReifen(feld, now) {
  const f = feld && feld.festung;
  if (!f) return false;
  const st = FESTUNG_STUFEN[f.stufe] || FESTUNG_STUFEN.schanze;
  const seit = Math.max(0, now - (f.letzteReifung || f.seit || now));
  if (seit < 60000) return false;                 // unter einer Minute lohnt das Schreiben nicht
  const stunden = seit / 3600000;
  const vorherT = f.hort || 0, vorherP = f.hortProto || 0;
  f.hort = Math.min(st.hortDeckel, vorherT + st.hortStd * stunden);
  f.hortProto = Math.min(st.protoDeckel, vorherP + st.protoStd * stunden);
  /* DER SCHILD REGENERIERT, die Tuerme nie. Damit ist "einmal anfangen und drei Wochen liegen
     lassen" kein Weg, und eine Belagerung bleibt eine Belagerung. Zerstoert ist zerstoert: Ein
     gefallener Schild kommt NICHT wieder (lp 0 bleibt 0) - sonst waere der Vorteil, den man sich
     erkaempft hat, vor der zweiten Welle wieder weg.
     2 % der Maximal-LP je Stunde, im selben Lazy-Takt wie der Hort. */
  const sch = f.bauteile && f.bauteile.schild;
  if (sch && (sch.lp || 0) > 0 && (sch.lp || 0) < (sch.lpMax || 0)) {
    const seitS = Math.max(0, now - (sch.letzteReifung || f.seit || now));
    sch.lp = Math.min(sch.lpMax, sch.lp + sch.lpMax * FESTUNG_BAUTEILE.schild.regenProStd * (seitS / 3600000));
    sch.lp = Math.round(sch.lp);
    sch.letzteReifung = now;
  }
  f.letzteReifung = now;
  // Immer true: Auch wenn beide Horte am Deckel stehen und sich die ZAHLEN nicht ändern, ist
  // `letzteReifung` fortgeschrieben - das Feld muss geschrieben werden, sonst rechnet der nächste
  // Aufruf dieselbe Spanne erneut und der Deckel wäre die einzige Bremse.
  return true;
}
// Entstehen: im galaxyTick, in ein Gürtelsystem OHNE Festung und MIT einem freien Platz.
function festungSpawn(felder) {
  // Konstante UND Notabschaltung (siehe /api/admin/schalter); die Konstante bleibt die
  // Grundstellung, der Schalter kann nur ABschalten. Vorhandene Festungen bleiben stehen.
  if (!spawnAktiv('festung')) return null;   // siehe die Begründung bei der Konstante
  const aktive = Object.values(felder).filter(x => x && x.festung).length;
  if (aktive >= FESTUNG_MAX_AKTIV) return null;
  const now = Date.now();
  // Kein Festung-Spawn auf einem wandernden A2-Ziel: zwei angreifbare Objekte auf einem
  // Kartenknoten waeren nicht auseinanderzuhalten (Gegenrichtung zu a2SystemFrei).
  const a2Systeme = new Set(a2Liste(loadOrInitGalaxy()).map(z => z.sys));
  const kandidaten = Object.keys(felder).filter(sysId => {
    const feld = felder[sysId];
    if (!feld || feld.festung) return false;
    if ((feld.geraeumtBis || 0) > now) return false;       // 24 h Ruhe nach einem Fall
    if (a2Systeme.has(sysId)) return false;
    return astFreiePlaetze(feld).length > 0;
  });
  if (!kandidaten.length) return null;
  const sysId = kandidaten[Math.floor(Math.random() * kandidaten.length)];
  const feld = felder[sysId];
  const frei = astFreiePlaetze(feld);
  const stufe = festungStufeFuer(sysId);
  const st = FESTUNG_STUFEN[stufe];
  /* Der Hort traegt eine SORTE aus derselben Tabelle wie die Vorkommen (AST_SORTEN). Das ist keine
     Verzierung, sondern die Vermeidung eines zweiten Begriffs: Der Server verteilt in diesem ganzen
     Modul keine Ressourcen, er fuehrt nur Sorte und Menge - das Frontend bildet daraus seine
     T1-Ressourcen ab (Kommentar bei AST_SORTEN). Eine Festung mit Sorte laeuft damit durch dieselbe
     Abbildung wie jede Abbaufuhre, und es entsteht kein zweiter Weg, der auseinanderlaufen kann.
     Die PROTOMATERIE dagegen fuehrt der Hort IMMER und unabhaengig von der Sorte - bei den Vorkommen
     traegt sie nur 'urmaterie'. Das ist Absicht und der Kern der ganzen Belohnung: Sie ist die
     einzige Groesse, die im Endspiel nicht in der Eigenproduktion untergeht (Rechnung im Kommentar
     oben bei FESTUNG_MAX_AKTIV). Haenge sie an die Sorte, waere die Belohnung in neun von zehn
     Faellen wertlos, und die Festung waere fuer entwickelte Konten kein Ziel. */
  feld.festung = {
    id: crypto.randomUUID(),
    stufe, platz: frei[Math.floor(Math.random() * frei.length)],
    sorte: astZieheGewichtet(AST_SORTEN).key,
    kernMax: st.kern, kern: st.kern,
    // Die Bauteile entstehen MIT der Festung und leiten ihre LP aus dem Kern ab (siehe
    // FESTUNG_BAUTEILE). Eine Festung OHNE `bauteile` - also jede aus Phase 1 und jede, solange
    // FESTUNG_BAUTEILE_AKTIV aus ist - verhaelt sich weiterhin genau wie vorher: festungTeilSteht()
    // liefert false, und jeder Zweig darunter faellt auf das Verhalten ohne Bauteile zurueck.
    // Damit braucht es keine Wanderung des Bestands, und ein halb ausgerollter Stand tut niemandem weh.
    bauteile: !spawnAktiv('bauteile') ? undefined : {
      schild: { lp: Math.round(st.kern * FESTUNG_BAUTEILE.schild.anteilKern),
                lpMax: Math.round(st.kern * FESTUNG_BAUTEILE.schild.anteilKern), letzteReifung: now },
      tuerme: { lp: Math.round(st.kern * FESTUNG_BAUTEILE.tuerme.anteilKern),
                lpMax: Math.round(st.kern * FESTUNG_BAUTEILE.tuerme.anteilKern) }
    },
    hort: 0, hortProto: 0,
    seit: now, letzteReifung: now,
    beitraege: {}
  };
  pushGalaxyNews('ti-building-fortress', 'Bei ' + sysId + ' hat sich eine Asteroidenfestung (' + st.name +
    ') auf der Gürtelbahn eingenistet. Sie drosselt den Abbau im ganzen System um ' +
    Math.round(st.blockade * 100) + ' % und die Protomaterie um ' + Math.round(st.proto * 100) + ' %.');
  return sysId;
}
// Fällige Nachschub-Termine auflösen. Gibt zurück, ob sich etwas geändert hat.
function astNachschub(sysId, feld, alleFelder) {
  const now = Date.now();
  let geaendert = false;
  for (const [platz, p] of Object.entries(feld.plaetze || {})) {
    if (!p || !p.frei || !p.nachschubAb || p.nachschubAb > now) continue;
    delete feld.plaetze[platz];
    geaendert = true;
    // Wandernder Nachschub: Der Brocken kommt NICHT an derselben Stelle wieder. Zu 30% sogar in
    // einem anderen Gürtelsystem - der Gürtel ist ein Revier, das man absuchen muss, kein Fahrplan.
    let zielSys = sysId, zielFeld = feld;
    if (Math.random() < AST_SYSTEMWECHSEL) {
      const andere = astGuertelSysteme().filter(x => x !== sysId);
      const kandidat = andere[Math.floor(Math.random() * andere.length)];
      if (kandidat && alleFelder[kandidat]) { zielSys = kandidat; zielFeld = alleFelder[kandidat]; }
    }
    if (astBelegtZahl(zielFeld) >= AST_GRENZE_MAX) continue;   // dort ist kein Platz mehr
    const frei = astFreiePlaetze(zielFeld);   // kennt die Festung und setzt nichts auf sie
    if (!frei.length) continue;
    const ziel = frei[Math.floor(Math.random() * frei.length)];
    zielFeld.plaetze[ziel] = astNeuesVorkommen(zielSys);
  }
  // Untergrenze halten: Ein Gürtelsystem, das unter das Minimum gefallen ist, bekommt sofort auf.
  while (astBelegtZahl(feld) < AST_GRENZE_MIN) {
    const frei = astFreiePlaetze(feld);
    if (!frei.length) break;
    feld.plaetze[frei[Math.floor(Math.random() * frei.length)]] = astNeuesVorkommen(sysId);
    geaendert = true;
  }
  return geaendert;
}
// Alle Gürtelfelder lesen, dabei fällige Termine auflösen und fehlende Systeme erstbelegen.
/* Urmaterie-Nachsaat und -Boden (28.08.2026, Spieler-Report: "alle Systeme durchgeschaut,
   kein einziger Urmaterie-Asteroid"). Die Ursache war deterministisch, kein Pech: Die Felder
   wurden am 16.08. erzeugt, als der Pi noch auf #109 stand - die Sorte kam erst mit #117
   (17.08.) in AST_SORTEN, und eine Migration gab es nie. Die gesamte Startpopulation konnte
   also bauartbedingt keinen Urmateriekern enthalten; neue Sorten entstehen nur nach
   vollstaendiger Leerfoerderung (Neuwurf mit p = 3/103 je Vorkommen).
   Zwei Mechanismen, beide ADDITIV (nichts wird geloescht oder umgewuerfelt - dieselbe Regel
   wie bei den Komfort-Grenzen: nur das Hinzufuegen), beide an EINER Stelle statt an den
   Aufrufern (Hausregel 43):
   - Nachsaat: EINMALIG auf 3 Stueck auffuellen - der stationaere Erwartungswert
     (rund 100 Vorkommen x 3/103 = 2,9). Der Marker liegt in db.galaxy, weil db.galaxy ueber
     die Storage-Route nicht erreichbar ist - ein Marker in db.shared waere von jedem Konto
     loeschbar und die Nachsaat liefe erneut.
   - Boden: Steht der galaxieweite Bestand auf 0, wird EIN Vorkommen gesetzt statt gewuerfelt.
     Urmaterie ist die einzige Asteroiden-Protomateriequelle; ohne den Boden kann sie nach dem
     Leerschuerfen wieder wochenlang verschwinden (fuer 95 % Wiederkehr-Sicherheit braeuchte es
     ~102 Neuwuerfe). Er greift NUR bei 0 - die Verteilung aller uebrigen Wuerfe bleibt
     unberuehrt. */
function astUrmaterieBestand(felder) {
  let n = 0;
  for (const feld of Object.values(felder)) {
    for (const p of Object.values(feld.plaetze || {})) {
      if (p && !p.frei && p.sorte === 'urmaterie' && (p.vorrat || 0) > 0) n++;
    }
  }
  return n;
}
function astUrmaterieSetzen(felder, anzahl) {
  // Je Durchgang hoechstens EIN Kern je System, damit sich die Nachsaat verteilt statt einen
  // Guertel zu fluten. Kapazitaet und Festungsplatz respektieren AST_GRENZE_MAX/astFreiePlaetze -
  // dieselben Schranken wie beim regulaeren Nachschub.
  const systeme = Object.keys(felder).sort(() => Math.random() - 0.5);
  let gesetzt = 0;
  for (const sysId of systeme) {
    if (gesetzt >= anzahl) break;
    const feld = felder[sysId];
    if (astBelegtZahl(feld) >= AST_GRENZE_MAX) continue;
    const frei = astFreiePlaetze(feld);
    if (!frei.length) continue;
    const v = astNeuesVorkommen(sysId);
    v.sorte = 'urmaterie';
    feld.plaetze[frei[Math.floor(Math.random() * frei.length)]] = v;
    gesetzt++;
  }
  return gesetzt;
}
function astAlleFelder() {
  if (!db.shared) db.shared = {};
  const felder = {};
  let geaendert = false;
  for (const sysId of astGuertelSysteme()) {
    const key = astFeldKey(sysId);
    let feld = db.shared[key];
    if (!feld || typeof feld !== 'object' || !feld.plaetze) { feld = astErzeugeFeld(sysId); geaendert = true; }
    felder[sysId] = feld;
  }
  // Nachschub NACH dem Einsammeln aller Felder: Ein wandernder Brocken braucht das Zielsystem.
  for (const sysId of Object.keys(felder)) if (astNachschub(sysId, felder[sysId], felder)) geaendert = true;
  // Urmaterie-Nachsaat (einmalig) und -Boden (dauerhaft) - Begruendung am Kommentar der Helfer.
  // Der Marker wird nur gesetzt, wenn db.galaxy schon existiert: Ein leeres Objekt von hier aus
  // wuerde die vollstaendige Galaxy-Erstbelegung im galaxyTick aushebeln (dort haengt sie an
  // `if (!db.galaxy)`); im schlimmsten Fall verschiebt sich die Nachsaat um einen Aufruf.
  if (db.galaxy && !db.galaxy.urmaterieNachsaat) {
    const fehlen = Math.max(0, 3 - astUrmaterieBestand(felder));
    if (fehlen > 0 && astUrmaterieSetzen(felder, fehlen) > 0) geaendert = true;
    db.galaxy.urmaterieNachsaat = Date.now();
  }
  if (astUrmaterieBestand(felder) < 1 && astUrmaterieSetzen(felder, 1) > 0) geaendert = true;
  // Der Hort der Festungen wächst beim Lesen mit (siehe festungReifen).
  const jetztR = Date.now();
  for (const sysId of Object.keys(felder)) if (festungReifen(felder[sysId], jetztR)) geaendert = true;
  if (geaendert) { for (const sysId of Object.keys(felder)) db.shared[astFeldKey(sysId)] = felder[sysId]; }
  return { felder, geaendert };
}

// Das ganze Feld lesen. Bewusst alle Gürtelsysteme auf einmal statt eines je Anfrage: Es sind rund
// 16 KB, die Sektorkarte zeigt ohnehin alle, und zwanzig Einzelanfragen je Kartenaufruf wären auf
// einem Raspberry Pi die teurere Lösung.
app.get('/api/asteroid/field', authMiddleware, async (req, res) => {
  const { felder, geaendert } = astAlleFelder();
  if (geaendert) await saveDb();
  res.json({ systeme: astGuertelSysteme(), felder });
});

// Beim START einer Abbaumission: Ladung aus dem Vorkommen entnehmen. DER SERVER ENTSCHEIDET DIE
// MENGE - der Client nennt nur seinen Wunsch, und der wird gegen zwei Schranken geklemmt: den
// tatsächlichen Restvorrat und eine großzügige Obergrenze aus der wirklich gespeicherten Flotte.
//
// Die Entnahme passiert beim START, nicht bei der Rückkehr. Damit kann derselbe Brocken nicht
// zweimal vergeben werden, und wer als Zweiter losfliegt, erfährt es SOFORT statt nach einer halben
// Stunde Flug. Der Preis ist ehrlich zu benennen: Bricht die Verbindung zwischen diesem Aufruf und
// dem tatsächlichen Missionsstart ab, ist die Ladung entnommen, ohne dass eine Flotte fliegt.
// Deshalb ruft der Client ihn erst, wenn Treibstoff und Slots bereits geprüft sind.
//
// Der Server schreibt NIE den Spielstand. Er führt Buch über den geteilten Vorrat und nichts sonst;
// die Gutschrift beim Spieler macht der Client bei Heimkehr über gainResources(), wie bei jeder
// anderen Mission. Das Wettrennen zwischen Server-Gutschrift und Client-Save entsteht hier gar nicht.
app.post('/api/asteroid/mine', authMiddleware, async (req, res) => {
  const sysId = String((req.body && req.body.system) || '');
  const platz = String((req.body && req.body.platz) !== undefined ? req.body.platz : '');
  const wunsch = Math.floor(Number((req.body && req.body.wunsch) || 0));
  if (!sysId || !platz) return res.status(400).json({ error: 'System und Platz fehlen.' });
  if (!(wunsch > 0)) return res.status(400).json({ error: 'Ungültige Wunschmenge.' });
  if (astGuertelSysteme().indexOf(sysId) < 0) return res.status(400).json({ error: 'Dieses System trägt keinen Asteroidengürtel.' });

  const { felder } = astAlleFelder();
  const feld = felder[sysId];
  const vork = feld && feld.plaetze && feld.plaetze[platz];
  if (!vork || vork.frei || !(vork.vorrat > 0)) {
    return res.status(409).json({ error: 'Dieses Vorkommen ist nicht mehr da.', weg: true });
  }

  // Schürfrecht (Konzept 6.1): Ein reserviertes Vorkommen darf nur sein Halter abbauen. Der
  // Fehlertext nennt den Halter, damit der Client dem Spieler sagen kann, WER es reserviert hat.
  if (vork.halter && vork.halter !== req.userId) {
    return res.status(403).json({ error: 'Reserviert von ' + (vork.halterName || 'einem anderen Kommandanten') + (vork.tag ? ' [' + vork.tag + ']' : '') + '.', reserviert: true });
  }

  // Obergrenze aus der gespeicherten Flotte. Ehrliche Grenze (wie bei der Modulbörse): Der Client
  // schreibt seinen Spielstand selbst, wer ihn manipuliert, kann Schiffe behaupten. Der Server prüft
  // BESITZ im gespeicherten Stand - mehr nicht, und mehr behauptet das Konzept auch nicht.
  let obergrenze = 0;
  try {
    const roh = getSaveValue(req.userId);
    const save = roh ? JSON.parse(roh) : null;
    const flotten = [];
    if (save && save.fleet) flotten.push(save.fleet);
    if (save && save.colonies) for (const c of Object.values(save.colonies)) if (c && c.fleet) flotten.push(c.fleet);
    for (const f of flotten) {
      obergrenze += (Number(f.schuerfschiff) || 0) * AST_MAX_JE_SCHUERFSCHIFF;
      obergrenze += (Number(f.frachter) || 0) * AST_MAX_JE_FRACHTER;
      obergrenze += (Number(f.frachtergross) || 0) * AST_MAX_JE_GROSSFRACHTER;
      obergrenze += (Number(f.bergungsfrachter) || 0) * AST_MAX_JE_BERGUNGSFRACHTER;
    }
  } catch (e) { obergrenze = 0; }
  if (!(obergrenze > 0)) {
    return res.status(403).json({ error: 'Kein Minenschiff im gespeicherten Spielstand - erst speichern, dann losfliegen.' });
  }

  /* BLOCKADE und GERAEUMT-BONUS (18.08.2026): Solange eine Festung in diesem Guertelsystem steht,
     faellt die Ladung jeder Abbaumission um 25/40/55 %. Angewandt wird das HIER, an der Obergrenze,
     die der Server ohnehin aus dem gespeicherten Spielstand rechnet - eine Blockade, die nur im
     Client rechnet, waere eine Anzeige und keine Regel. Nach dem Fall einer Festung laeuft 24
     Stunden lang der Gegenbonus (+15 %), damit sich das Schleifen auch fuer den lohnt, der beim
     Hort nur einen kleinen Anteil hatte.
     Bewusst auf die LADUNG und nicht auf die Rate: Eine gedrosselte Rate verlaengert nur die
     Abbauzeit, und der Spieler bekaeme am Ende dieselbe Fuhre nach laengerem Warten - eine
     Blockade, die man aussitzen kann, ist keine. Das Frontend rechnet in abbauPlan() mit demselben
     Faktor, damit die Vorschau nicht eine andere Zahl nennt als die Abbuchung (test_festung_
     paritaet.js im Frontend-Repo vergleicht beide Tabellen). */
  const festungHier = feld.festung;
  const blockade = festungHier ? (FESTUNG_STUFEN[festungHier.stufe] || FESTUNG_STUFEN.schanze).blockade : 0;
  const geraeumt = !festungHier && (feld.geraeumtBis || 0) > Date.now() ? FESTUNG_GERAEUMT_BONUS : 0;
  /* DIE BLOCKADE GREIFT AN DER GEWAEHRTEN MENGE, NICHT AN DER OBERGRENZE - und das ist die
     Korrektur eines Fehlers, den der erste Entwurf hatte und den sein eigener Test nicht sah.

     `obergrenze` ist die ANTI-BETRUGS-Schranke aus dem gespeicherten Spielstand, und sie hat
     bewusst reichlich Luft (der Kommentar bei AST_MAX_JE_SCHUERFSCHIFF nennt "Faktor 3,5").
     Sie bindet im echten Spiel praktisch nie - der Laderaum des Frontends ist deutlich kleiner.
     Gemessen fuer vier typische Flotten (Frontend-Laderaum gegen `obergrenze * 0,45`):

       50 Schuerfschiffe, keine Forschung     20.000  gegen  45.000   Blockade wirkungslos
       50 Schuerfschiffe, Foerderung max      28.000  gegen  45.000   Blockade wirkungslos
       16 Schuerf + 20 Frachter               14.960  gegen  27.900   Blockade wirkungslos
       50 Schuerf + 100 Grossfrachter        178.000  gegen 382.500   Blockade wirkungslos

     In KEINEM Fall haette der Spieler etwas von der Blockade gemerkt. Der erste HTTP-Test war nur
     deshalb gruen, weil er `wunsch: 999999999` schickte und damit genau den Deckel mass statt der
     Wirkung - Arbeitsregel 7 der Frontend-CLAUDE.md ("Messen, was gemessen werden soll, nicht den
     Deckel") in Reinform.

     Deshalb: erst die drei Schranken anwenden, DANN den Faktor auf das Ergebnis. Damit kuerzt die
     Blockade das, was der Spieler wirklich bekommt, egal welche Schranke gerade bindet.
     Zum Schluss noch einmal gegen den Vorrat gedeckelt: Der Geraeumt-Bonus (+15 %) darf einem
     Brocken nicht mehr entnehmen, als er ueberhaupt enthaelt.

     Math.round statt Math.floor, weil `1 - 0.55` in Gleitkomma 0.44999999999999996 ist - sonst
     stuenden aus 100.000 krumme 44.999 da, und das Frontend muesste fuer seine Vorschau dasselbe
     Rauschen zeichengenau nachbauen statt die Regel. */
  const roh = Math.max(0, Math.min(wunsch, vork.vorrat, obergrenze));
  const menge = Math.max(0, Math.min(vork.vorrat,
    Math.round(roh * (1 - blockade) * (1 + geraeumt))));
  if (menge <= 0) return res.status(409).json({ error: 'Dieses Vorkommen ist erschöpft.', weg: true });

  vork.vorrat -= menge;
  const groesse = AST_GROESSEN.find(g => g.key === vork.groesse) || AST_GROESSEN[0];
  if (vork.vorrat <= 0) {
    // Erschöpft: Der Platz wird frei und bekommt einen Nachschub-Termin. Der Brocken kommt woanders
    // wieder (siehe astNachschub) - nie am selben Fleck.
    feld.plaetze[platz] = { frei: true, nachschubAb: Date.now() + groesse.nachschubStd * 3600 * 1000 };
  }
  db.shared[astFeldKey(sysId)] = feld;
  console.log('[asteroid-mine] userId=' + req.userId + ' sys=' + sysId + ' platz=' + platz + ' menge=' + menge + ' rest=' + Math.max(0, vork.vorrat));
  await saveDb();
  /* `protoBlockade` reist MIT, obwohl der Server die Protomaterie gar nicht bucht - und genau
     deshalb muss sie mit. Die Menge je Fuhre hängt im Frontend allein an der GRÖSSE des
     Vorkommens (`proto: protoJeFuhre(a)`, weltraum_kolonie.html Z. 55912), nicht an der Ladung;
     die Ladungskürzung oben erreicht sie also nie. Ohne dieses Feld wäre die
     Protomaterie-Drosselung, die das Konzept als eigentlichen Zahn der Blockade beschreibt und
     die die Galaxie-Nachricht beim Entstehen ausdrücklich ANKÜNDIGT, schlicht nicht vorhanden -
     eine Zahl in einer Tabelle, die niemand liest (nachgemessen: `st.proto` wurde vor dieser
     Zeile ausschliesslich im Ankündigungstext verwendet).
     Der Server bleibt damit die Autorität über den Faktor, das Frontend multipliziert ihn nur -
     dieselbe Arbeitsteilung wie bei `menge`. Ein Client, der das Feld nicht kennt, verhält sich
     wie bisher; deshalb ist die Blockade ohne das Frontend wirkungslos und der Spawn-Schalter
     FESTUNG_SPAWN_AKTIV steht bis dahin auf false. */
  const protoBlockade = festungHier ? 1 - (FESTUNG_STUFEN[festungHier.stufe] || FESTUNG_STUFEN.schanze).proto : 1;
  res.json({ ok: true, menge, sorte: vork.sorte, groesse: vork.groesse, rest: Math.max(0, vork.vorrat),
    blockade, geraeumtBonus: geraeumt, protoBlockade });
});

// ===== Schürfrechte (Konzept 6.1/6.2/6.4): ein Vorkommen für genau einen Spieler reservieren =====
//
// WARUM DAS OHNE SPERREN SICHER IST (dasselbe Muster wie die Modulbörse, Z. 5202 ff., und
// /api/asteroid/mine direkt darüber): Der gesamte Zustandswechsel eines Aufrufs läuft synchron in
// einem Tick - das erste await steht erst hinter der Mutation (saveDb). Zwei gleichzeitige
// Ansprüche auf denselben Platz können sich nicht überlappen; der zweite findet ihn belegt.
// Dieses Muster nicht "aufräumen".
const AST_RECHTE_BASIS = 2;          // Grundstock je Spieler (Konzept 6.1)
const AST_RECHTE_MAX = 5;            // Deckel inkl. Forschung (Konzept 3.6: ~90 Vorkommen, gemessen)
const AST_RECHTE_FORSCHUNG_MAX = 3;  // Forschung rschuerfrecht: 3 Stufen à +1 Recht

function astLeseSave(userId) {
  try { const roh = getSaveValue(userId); return roh ? JSON.parse(roh) : null; } catch (e) { return null; }
}
function astRechteLimit(save) {
  const stufe = Math.max(0, Math.floor(Number(save && save.research && save.research.rschuerfrecht) || 0));
  return Math.min(AST_RECHTE_MAX, AST_RECHTE_BASIS + Math.min(AST_RECHTE_FORSCHUNG_MAX, stufe));
}
function astGehalteneRechte(felder, userId) {
  let n = 0;
  for (const feld of Object.values(felder)) {
    for (const p of Object.values((feld && feld.plaetze) || {})) if (p && p.halter === userId) n++;
  }
  return n;
}
// Die Eskorte kommt NICHT aus dem Request, sondern aus dem gespeicherten Spielstand
// (save.asteroidEskorten['<sys>:<platz>'].schiffe). Der Client schickt bewusst keine Schiffszahlen:
// Beim Stationieren haben die Schiffe seine Heimflotte längst verlassen - eine Prüfung gegen
// save.fleet würde genau den ehrlichen Fall ablehnen. So ist "Eskorte wirklich im Spielstand?"
// (Konzept 6.4) wörtlich implementiert, und es steht nichts im Request, dem man glauben müsste.
function astEskorteAusSave(save, sysId, platz) {
  const e = save && save.asteroidEskorten && save.asteroidEskorten[sysId + ':' + platz];
  const schiffe = (e && e.schiffe) || {};
  const sauber = {};
  for (const typ of Object.keys(schiffe)) {
    const n = Math.floor(Number(schiffe[typ]) || 0);
    if (n > 0 && n <= 1e9) sauber[typ] = n;
  }
  return sauber;
}

// Anmelden ODER Eskorte abgleichen: Der erste Aufruf eines freien Vorkommens reserviert es (mit
// Limit-Prüfung), jeder weitere Aufruf des Halters übernimmt nur die aktuelle Eskorte aus seinem
// gespeicherten Spielstand ins Felddokument. Die Limit-Prüfung läuft bewusst NUR bei der Anmeldung -
// ein Eskorten-Abgleich am Limit darf nie scheitern.
app.post('/api/asteroid/claim', authMiddleware, async (req, res) => {
  const sysId = String((req.body && req.body.system) || '');
  const platz = String((req.body && req.body.platz) !== undefined ? req.body.platz : '');
  if (!sysId || !platz) return res.status(400).json({ error: 'System und Platz fehlen.' });
  if (astGuertelSysteme().indexOf(sysId) < 0) return res.status(400).json({ error: 'Dieses System trägt keinen Asteroidengürtel.' });
  const { felder } = astAlleFelder();
  const feld = felder[sysId];
  const vork = feld && feld.plaetze && feld.plaetze[platz];
  if (!vork || vork.frei || !(vork.vorrat > 0)) return res.status(409).json({ error: 'Dieses Vorkommen ist nicht mehr da.', weg: true });
  if (vork.halter && vork.halter !== req.userId) {
    return res.status(409).json({ error: 'Bereits reserviert von ' + (vork.halterName || 'einem anderen Kommandanten') + '.' });
  }
  const save = astLeseSave(req.userId);
  if (!save) return res.status(403).json({ error: 'Kein gespeicherter Spielstand - erst speichern, dann reservieren.' });
  if (!vork.halter) {
    const limit = astRechteLimit(save);
    const gehalten = astGehalteneRechte(felder, req.userId);
    if (gehalten >= limit) {
      return res.status(403).json({ error: 'Anspruchslimit erreicht: ' + gehalten + ' von ' + limit + ' Schürfrechten belegt. Die Forschung Bergbaurecht hebt das Limit auf höchstens ' + AST_RECHTE_MAX + '.' });
    }
    vork.halter = req.userId;
    vork.halterName = req.username || 'Unbekannt';
    vork.tag = ((save.player && save.player.allianceTag) || '').trim().toUpperCase();
    vork.seit = Date.now();
  }
  vork.eskorte = astEskorteAusSave(save, sysId, platz);
  db.shared[astFeldKey(sysId)] = feld;
  console.log('[asteroid-claim] userId=' + req.userId + ' sys=' + sysId + ' platz=' + platz + ' eskorte=' + JSON.stringify(vork.eskorte));
  await saveDb();
  res.json({ ok: true, halter: vork.halter, halterName: vork.halterName, tag: vork.tag, seit: vork.seit, eskorte: vork.eskorte });
});

// Aufgeben: nur der Halter. Der Heimflug einer stationierten Eskorte ist Sache des Clients - die
// Schiffe stehen in SEINEM Spielstand (asteroidEskorten), das Felddokument vergisst sie hier nur.
app.post('/api/asteroid/release', authMiddleware, async (req, res) => {
  const sysId = String((req.body && req.body.system) || '');
  const platz = String((req.body && req.body.platz) !== undefined ? req.body.platz : '');
  if (!sysId || !platz) return res.status(400).json({ error: 'System und Platz fehlen.' });
  if (astGuertelSysteme().indexOf(sysId) < 0) return res.status(400).json({ error: 'Dieses System trägt keinen Asteroidengürtel.' });
  const { felder } = astAlleFelder();
  const feld = felder[sysId];
  const vork = feld && feld.plaetze && feld.plaetze[platz];
  if (!vork || vork.frei) return res.status(409).json({ error: 'Dieses Vorkommen ist nicht mehr da.', weg: true });
  if (!vork.halter) return res.status(409).json({ error: 'Dieses Vorkommen ist gar nicht reserviert.' });
  if (vork.halter !== req.userId) return res.status(403).json({ error: 'Nur der Halter kann ein Schürfrecht aufgeben.' });
  delete vork.halter; delete vork.halterName; delete vork.tag; delete vork.seit; delete vork.eskorte;
  db.shared[astFeldKey(sysId)] = feld;
  console.log('[asteroid-release] userId=' + req.userId + ' sys=' + sysId + ' platz=' + platz);
  await saveDb();
  res.json({ ok: true });
});

const AST_SCHUTZ_MS = 2 * 3600 * 1000;      // Schutzfrist nach jedem Besitzwechsel (Konzept 6.3)
const AST_ABKLING_MS = 4 * 3600 * 1000;     // Abklingzeit je Angreifer und Vorkommen
const AST_CHANCE_MIN = 0.10, AST_CHANCE_MAX = 0.90;   // Deckel wie im PvP - nichts ist sicher, nichts sinnlos

// Die Angriffsflotte steht NICHT in save.fleet - sie ist ja unterwegs. Sie steht in der Mission,
// die der Client vor dem Abflug gespeichert hat. Deshalb liest der Server sie von dort: Der
// Angreifer schickt weiterhin KEINE Stärke mit (Konzept 6.3), sondern nur, welche seiner Missionen
// gemeint ist. Gesucht wird in der Heimatflotte UND in allen Kolonieflotten.
function astFindeAngriffsmission(save, missionId, sysId, platz) {
  const ziel = sysId + ':' + platz;
  const flotten = [];
  if (save && save.fleet) flotten.push(save.fleet);
  if (save && save.colonies) for (const c of Object.values(save.colonies)) if (c && c.fleet) flotten.push(c.fleet);
  for (const f of flotten) {
    for (const m of (f.missions || [])) {
      if (String(m.id) === String(missionId) && m.type === 'asteroid-contest' && m.targetId === ziel) return m;
    }
  }
  return null;
}

// Anfechten: eine Kampfflotte gegen die stationierte Eskorte des Halters.
//
// WARUM DAS OHNE SPERREN SICHER IST: derselbe Grund wie bei claim/release/mine darüber - der
// gesamte Zustandswechsel läuft synchron in einem Tick, das erste await steht erst hinter der
// Mutation (saveDb). Zwei gleichzeitige Anfechtungen desselben Vorkommens können sich nicht
// überlappen; die zweite findet den bereits gewechselten Halter und die geschrumpfte Eskorte vor.
//
// UND WARUM DER SERVER HIER KEINEN SPIELSTAND SCHREIBT (anders als /api/moonsiege/resolve, das
// setSaveValue ruft): Die Verluste des Angreifers stehen in der Antwort, sein eigener Client bucht
// sie - dasselbe Muster wie bei /api/asteroid/mine. Der Halter erfährt seine Verluste über das
// Felddokument, das ihm der nächste Feld-Abruf liefert. Damit entsteht das Wettrennen zwischen
// Server-Schreibung und Client-Save gar nicht erst.
app.post('/api/asteroid/contest', authMiddleware, async (req, res) => {
  const sysId = String((req.body && req.body.system) || '');
  const platz = String((req.body && req.body.platz) !== undefined ? req.body.platz : '');
  const missionId = (req.body && req.body.missionId) !== undefined ? String(req.body.missionId) : '';
  if (!sysId || !platz || !missionId) return res.status(400).json({ error: 'System, Platz und Mission fehlen.' });
  if (astGuertelSysteme().indexOf(sysId) < 0) return res.status(400).json({ error: 'Dieses System trägt keinen Asteroidengürtel.' });

  const { felder } = astAlleFelder();
  const feld = felder[sysId];
  const vork = feld && feld.plaetze && feld.plaetze[platz];
  if (!vork || vork.frei) return res.status(409).json({ error: 'Dieses Vorkommen ist nicht mehr da.', weg: true });
  if (!vork.halter) return res.status(409).json({ error: 'Dieses Vorkommen ist gar nicht reserviert - es lässt sich einfach abbauen.' });
  if (vork.halter === req.userId) return res.status(400).json({ error: 'Das ist dein eigenes Schürfrecht.' });
  // Derselbe Anflug darf nicht zweimal eingelöst werden. Was das WIRKLICH abdeckt (gemessen an den
  // Gegenproben, nicht angenommen): Das unmittelbare Wiederholen fangen Schutzfrist und Abklingzeit
  // schon ab. Diese Prüfung schließt den Fall DANACH - eine alte Missions-ID lässt sich sonst vier
  // Stunden später erneut einlösen, mit einer Flotte, die längst heimgeflogen ist oder die es nie
  // gab. Sie steht bewusst VOR Schutzfrist und Abklingzeit: Ein doppelt eingelöster Anflug ist ein
  // Fehler des Clients, kein Timing-Problem, und "bereits abgerechnet" ist die Auskunft, die weiterhilft.
  if (vork.abgerechnet && vork.abgerechnet[missionId]) {
    return res.status(409).json({ error: 'Dieser Anflug wurde bereits abgerechnet.' });
  }

  const save = astLeseSave(req.userId);
  if (!save) return res.status(403).json({ error: 'Kein gespeicherter Spielstand - erst speichern, dann angreifen.' });

  const jetzt = Date.now();
  // Jede Sperre nennt ihren eigenen Grund: ein blosser Statuscode sagt dem Spieler nicht, ob er
  // warten muss, den falschen Gegner hat oder etwas anderes falsch läuft.
  if (vork.schutzBis && vork.schutzBis > jetzt) {
    return res.status(403).json({ error: 'Dieses Vorkommen steht nach dem letzten Besitzwechsel noch ' + Math.ceil((vork.schutzBis - jetzt) / 60000) + ' Minuten unter Schutz.', schutz: true });
  }
  const letzterAngriff = (vork.angriffe || {})[req.userId] || 0;
  if (letzterAngriff + AST_ABKLING_MS > jetzt) {
    return res.status(403).json({ error: 'Du hast dieses Vorkommen erst vor Kurzem angegriffen - nächster Versuch in ' + Math.ceil((letzterAngriff + AST_ABKLING_MS - jetzt) / 60000) + ' Minuten.', abklingzeit: true });
  }
  const meinTag = ((save.player && save.player.allianceTag) || '').trim().toUpperCase();
  if (meinTag && vork.tag && meinTag === vork.tag) {
    return res.status(403).json({ error: 'Mitglieder derselben Allianz können sich ihre Schürfrechte nicht abnehmen.', allianz: true });
  }
  const mission = astFindeAngriffsmission(save, missionId, sysId, platz);
  if (!mission || !mission.composition) {
    return res.status(403).json({ error: 'Zu dieser Anfechtung ist keine Flotte im gespeicherten Spielstand unterwegs.' });
  }

  const angriff = rawFleetPower(mission.composition, 1, 1, save.shipMarks);
  const verteidigung = weightedFleetDefensePower(vork.eskorte || {}, null) + fleetShieldSum(vork.eskorte || {}, null);
  if (!(angriff > 0)) return res.status(400).json({ error: 'Diese Flotte trägt keine Kampfkraft.' });

  // Zufallsband wie bei der Mondbelagerung, Deckel wie im PvP: Überzahl gewinnt meist, aber nie
  // sicher - und ein unterlegener Angriff ist nicht von vornherein sinnlos.
  const wurf = 0.85 + Math.random() * 0.3;
  const chance = Math.max(AST_CHANCE_MIN, Math.min(AST_CHANCE_MAX, (angriff * wurf) / (angriff * wurf + Math.max(1, verteidigung))));
  const gewonnen = Math.random() < chance;

  // Verluste: der Verlierer trägt schwerer. Anteilig auf beide Seiten, damit auch ein gewonnener
  // Angriff etwas kostet - sonst wäre eine Übermacht ein Freifahrtschein.
  const eigenerVerlustAnteil = gewonnen ? Math.min(0.5, verteidigung / Math.max(1, angriff) * 0.35) : Math.min(0.85, 0.45 + verteidigung / Math.max(1, angriff) * 0.2);
  const gegnerVerlustAnteil = gewonnen ? 1 : Math.min(0.6, angriff / Math.max(1, verteidigung) * 0.35);

  const gegnerVerluste = {};
  const neueEskorte = {};
  for (const [typ, n] of Object.entries(vork.eskorte || {})) {
    const weg = Math.min(n, Math.round(n * gegnerVerlustAnteil));
    if (weg > 0) gegnerVerluste[typ] = weg;
    const rest = n - weg;
    if (rest > 0) neueEskorte[typ] = rest;
  }
  const eigeneVerluste = {};
  for (const [typ, n] of Object.entries(mission.composition)) {
    if (typeof n !== 'number' || n <= 0) continue;
    const weg = Math.min(n, Math.round(n * eigenerVerlustAnteil));
    if (weg > 0) eigeneVerluste[typ] = weg;
  }

  const halterVorher = vork.halterName || 'Unbekannt';
  // Die Empfaenger-ID VOR der Aufloesung sichern: Bei einem Sieg wird vork.halter mit dem
  // Angreifer ueberschrieben, und die Benachrichtigung ginge dann an den Falschen - naemlich an
  // den, der gerade gewonnen hat.
  const halterIdVorher = vork.halter;
  vork.angriffe = vork.angriffe || {};
  vork.angriffe[req.userId] = jetzt;
  vork.abgerechnet = vork.abgerechnet || {};
  vork.abgerechnet[missionId] = jetzt;
  if (gewonnen) {
    // Der Vorrat bleibt, wo er ist: man erobert eine Quelle, keine Beute (Konzept 6.3). Die
    // überlebende Eskorte des Verlierers fliegt heim - sein Client erzeugt daraus den Rückflug,
    // sobald er das Felddokument liest.
    vork.halter = req.userId;
    vork.halterName = req.username || 'Unbekannt';
    vork.tag = meinTag;
    vork.seit = jetzt;
    vork.schutzBis = jetzt + AST_SCHUTZ_MS;
    vork.eskorte = {};
  } else {
    vork.eskorte = neueEskorte;
  }

  /* Der Kampf wird AM VORKOMMEN vermerkt, damit der Verteidiger ihn nachvollziehen kann (21.08.2026).
     Vorher erfuhr er ihn nur ueber das Postfach - und das gibt es nur mit Server, es laesst sich
     wegwischen und es nennt weder die verlorenen Schiffstypen noch einen Bericht. Vor allem aber
     fehlte dem CLIENT jeder Anhaltspunkt, ob ein Recht durch KAMPF oder durch eigene Aufgabe weg
     ist: Er hat seine stationierte Eskorte deshalb bei einem verlorenen Recht stehenlassen, samt
     der Schiffe, die hier gerade vernichtet wurden (gemessen im Browser: 20 Kreuzer stationiert,
     Recht verloren, Rueckruf gab 20 zurueck).

     WARUM AM VORKOMMEN und nicht im Spielstand des Verteidigers: Der Server schreibt hier
     grundsaetzlich keinen fremden Spielstand (siehe der Kommentar am Festungsschlag). Das
     Felddokument gehoert dagegen den Asteroiden-Endpunkten, der Client liest es ohnehin bei jedem
     Kartenaufruf, und ein neu nachwachsendes Vorkommen ist ein frisches Objekt - der Vermerk stirbt
     also mit dem Brocken, an dem er haengt.

     ES WIRD IN BEIDEN AUSGAENGEN GESCHRIEBEN, nicht nur beim Besitzwechsel: Auch ein ABGEWEHRTER
     Angriff kostet den Verteidiger Schiffe, und bis hierher stand darueber nur eine Protokollzeile
     ohne Angreifer und ohne Schiffstypen.

     'verluste' ist die Verlustliste des VERTEIDIGERS (gegnerVerluste aus SICHT des Angreifers) -
     der Client bucht daraus seinen Bericht. Neue Information gibt der Vermerk niemandem preis:
     vork.halter ist schon eine Nutzer-ID, und vork.eskorte fuehrt die Wache des Halters ohnehin
     vollstaendig und oeffentlich. */
  vork.letzterKampf = {
    zeit: jetzt,
    verlierer: halterIdVorher || '',
    verloren: gewonnen,                       // aus Sicht des Verteidigers: Recht weg?
    angreifer: req.username || 'Ein Kommandant',
    verluste: gegnerVerluste
  };
  db.shared[astFeldKey(sysId)] = feld;

  /* Der Halter erfaehrt den Angriff, auch wenn sein Spiel geschlossen ist (Konzept 6.3). Ohne das
     merkt er ihn erst, wenn sein Client das Feld das naechste Mal liest - bei einem verlorenen
     Recht kann das Stunden dauern.
     KATEGORIE 'attack' statt einer eigenen Einstellung: Es IST ein Angriff auf ihn, und wer
     Angriffs-Pushes abgestellt hat, will auch diesen nicht. Eine eigene Einstellung fuer eine
     einzelne Angriffsart waere eine, die niemand findet - im Konzept steht sie, hier ist bewusst
     abgewichen. Dieselbe Anti-Flut-Drosselung wie bei /api/attack: Der Postfach-Eintrag kommt
     immer, die Handy-Push hoechstens alle 30 Minuten.
     VOR saveDb(), genau wie in /api/attack: pushNotificationEvent schreibt den Postfach-Eintrag
     nach db.private, allowAttackPush den Drossel-Zeitstempel. Nach dem Schreibvorgang gesetzt
     haengen beide bis zum naechsten saveDb irgendeines anderen Aufrufers in der Luft - die
     Hausregel "db immer VOR saveDb synchron mutieren" meint genau diesen Fall. Der eigentliche
     Handy-Versand darin ist Feuer-und-Vergessen und blockiert nichts. */
  try {
    const halterUser = halterIdVorher ? findUserById(halterIdVorher) : null;
    if (halterUser) {
      const hPrefs = getNotifPrefs(halterUser);
      if (hPrefs.enabled && hPrefs.attack) {
        pushNotificationEvent(halterIdVorher, 'asteroid-contested', {
          angreiferName: req.username || 'Ein Kommandant', verloren: gewonnen,
          sorte: vork.sorte || '', system: sysId
        }, { skipWebPush: !allowAttackPush(halterIdVorher) });
      }
    }
  } catch (e) { console.warn('[asteroid-contest] Push fehlgeschlagen:', e.message); }

  console.log('[asteroid-contest] userId=' + req.userId + ' sys=' + sysId + ' platz=' + platz + ' chance=' + chance.toFixed(2) + ' gewonnen=' + gewonnen);
  await saveDb();
  res.json({ ok: true, gewonnen, chance, eigeneVerluste, gegnerVerluste, halterVorher,
    halter: vork.halter, halterName: vork.halterName, schutzBis: vork.schutzBis || 0 });
});

/* ===== Die Festung angreifen ==================================================================
   Gebaut als Kreuzung der beiden vorhandenen Muster, und die Wahl je Punkt ist begruendet:

   VOM WELTBOSS (/api/worldboss/resolve) kommt die Schadensrechnung - ein gemeinsames Ziel mit
   Lebenspunkten, an dem viele Spieler nacheinander arbeiten, und ein `beitraege`-Verzeichnis, aus
   dem beim Fall die Anteile folgen.

   VON DER ANFECHTUNG (/api/asteroid/contest) kommt, dass der Server den SPIELSTAND DES ANGREIFERS
   NICHT SCHREIBT. Die Verluste stehen in der Antwort, sein eigener Client bucht sie - damit
   entsteht das Wettrennen zwischen Server-Schreibung und Autosave gar nicht erst. Der Weltboss
   macht es andersherum (setSaveValue); hier liegt das benachbarte Asteroiden-Modul naeher, und
   zwei Muster im selben Modul waeren die Dopplung, die spaeter auseinanderlaeuft.

   DREI ENTSCHEIDUNGEN, DIE MAN BEIM ANFASSEN KENNEN MUSS:

   1. DIE ABKLINGZEIT LEBT AN DER FESTUNG, NICHT IM SPIELSTAND. Der Entwurf im Konzept sah
      `save.festungLetzterSchlag[sysId]` vor - das waere wertlos gewesen: Der Spielstand ist in
      diesem Spiel bauartbedingt klientenautoritativ, ein geloeschtes Feld gibt den naechsten
      Schlag sofort frei, und die einzige Bremse der ganzen Mechanik waere per Entwicklerkonsole
      abschaltbar. `festung.schlaege[userId]` liegt dagegen im geteilten Speicher, den nur dieser
      Endpunkt schreibt (die Schreibsperre dafuer steht in checkAsteroidKeyPermission). Genau so
      macht es die Anfechtung nebenan mit `vork.angriffe[userId]`.
      Der Weltboss legt seine 24-Stunden-Sperre bewusst in den Spielstand, weil sie einen
      Boss-Respawn ueberleben soll - dort ist das die richtige Wahl, hier nicht: Faellt die
      Festung, ist ihre Abklingzeit gegenstandslos.

   2. `mission.endTime` WIRD GEPRUEFT, IST ABER KEINE SICHERHEITSPRUEFUNG. Sie steht im
      klientenautoritativen Spielstand und ist in fuenf Sekunden auf 0 gesetzt. Sie fangt einen
      ehrlichen Client-Fehler ab (Aufloesung vor der Heimkehr), mehr nicht. Was die Haeufigkeit
      wirklich begrenzt, ist Punkt 1.

   3. GEZAEHLT WIRD, WAS ANGEKOMMEN IST - nicht, was gewuerfelt wurde. Ein Schlag von 900.000 gegen
      einen Kernrest von 40.000 traegt 40.000 zum Anteil bei, nicht 900.000. Sonst risse der letzte
      Angreifer mit einem einzigen Schlag den halben Hort an sich, obwohl der Rest der Arbeit von
      anderen kam. Dieselbe Ueberlegung fehlt beim Weltboss (dort zaehlt der volle Wurf) - hier ist
      bewusst abgewichen, weil der Hort anders als die Weltboss-Belohnung REIN anteilig ausgezahlt
      wird. */

/* ===== ALIEN-NESTER (Phase 3, 18.08.2026) =====================================================
   Konzept: docs/aliens-asteroidenfestungen-konzept.md im FRONTEND-Repo, Abschnitt 5.
   Die Nester sind das Gegenstueck zu den Festungen: Die Festung STEHT und drosselt, das Nest
   WAECHST und breitet sich aus. Wer nichts tut, hat in zwei Tagen mehr davon als gestern.

   WO SIE WOHNEN: in `db.galaxy.alienNester`. Das ist keine Geschmacksfrage - db.galaxy ist fuer
   Clients ueber `PUT /api/storage/:key` gar nicht erreichbar, anders als der Weltboss, dessen
   Schluessel `worldboss:current` im geteilten Speicher liegt und deshalb 2026 eigens abgesichert
   werden musste. Die Nester dorthin zu legen umgeht diese ganze Fehlerklasse von vornherein.
   Nebeneffekt, der Arbeit spart: galaxyFuerClient() macht Object.assign({}, g, ...) - alles aus
   db.galaxy geht damit automatisch an den Client, ohne eine Zeile Verdrahtung.

   DER SCHALTER, wieder: Solange NEST_SPAWN_AKTIV aus ist, entsteht kein Nest, und der ganze
   Abschnitt tut nichts. Dieselbe Begruendung wie bei FESTUNG_SPAWN_AKTIV/FESTUNG_BAUTEILE_AKTIV -
   Backend und Frontend gehen ueber zwei getrennte fest verdrahtete Befehle desselben Webhooks
   live und sind historisch mehrfach auseinandergelaufen.

   UMGELEGT am 19.08.2026 mit dem Frontend der Phase 3 (v8.582.0): Karte, Kartenmenue,
   Angriffsmission, Bericht und Hilfetext stehen, die Bedingung ist also erfuellt. Der
   Schalter BLEIBT trotzdem stehen - als Notausschalter, aus demselben Grund wie
   FESTUNG_SPAWN_AKTIV: Eine Zeile umzulegen ist schneller und sicherer, als einen Merge
   zurueckzunehmen, und Endpunkte, Haertungen und Tests bleiben dabei unangetastet.
   test_alien_nester_http.js 11c prueft jetzt, dass er auf true steht; ein Wechsel auf
   false ist damit eine bewusste Notabschaltung, die auffaellt statt still zu geschehen. */
const NEST_SPAWN_AKTIV = true;

/* Die vier Voelker. Der `name` muss WOERTLICH zu ALIEN_RACE_NAMES passen - darueber laeuft die
   Zuordnung zwischen dem vorhandenen "Volk entdeckt"-Ereignis und seinem Nestbestand. Eine
   Umbenennung dort ohne hier bricht die Verbindung still.
   Die `schwaeche` folgt der Schreibweise von fleetHasShipType() (also 'destroyer', nicht
   'destroyers') - dieselbe Kette wie beim Weltboss, damit keine zweite Bewertung danebensteht. */
const ALIEN_VOELKER = {
  kryll:     { name: 'Kryll-Schwarm',      schwaeche: 'jaeger',         reifeStd: 6,  lpFaktor: 0.8, ausbreitMult: 1.5, wandert: false },
  xantheer:  { name: 'Xantheer-Kollektiv', schwaeche: 'bomber',         reifeStd: 10, lpFaktor: 1.4, ausbreitMult: 1.0, wandert: false },
  vex:       { name: 'Nomaden von Vex',    schwaeche: 'destroyer',      reifeStd: 8,  lpFaktor: 1.0, ausbreitMult: 0,   wandert: true  },
  verglueht: { name: 'Die Verglühten',     schwaeche: 'schlachtschiff', reifeStd: 8,  lpFaktor: 1.1, ausbreitMult: 1.0, wandert: false }
};
const ALIEN_SCHWAECHE_MULT = 1.25;   // wie beim Weltboss-Grundfall

/* Die fuenf Stufen. DIE LP SIND GEGEN DIE BEREITS KALIBRIERTEN FESTUNGEN GERECHNET, nicht gegen
   eine neu erfundene Referenzflotte - der erste Anlauf tat genau das und lieferte fuer die
   Sternenfeste 18,8 Endspiel-Schlaege statt der 5, mit denen sie ausgeliefert ist. Der Massstab
   war ein anderer (Forschung, Marken, Haltung), nicht die Zahl.
   Gemessen an den Schlagkraeften des Festungs-Kapitels (7.500 / 44.000 / 240.000 je Schlag):

     Sporenherd    40.000  ->  5,3 / 0,9 / 0,2 Schlaege   (Gegenstueck zur Schanze)
     Brutkammer   120.000  -> 16,0 / 2,7 / 0,5
     Schwarmstock 400.000  -> 53,3 / 9,1 / 1,7
     Hochnest     1,2 Mio  -> 160  / 27,3 / 5,0           (exakt die Sternenfeste)
     Koenigin       4 Mio  -> 533  / 90,9 / 16,7

   Das Konzept sagt zur Koenigin "mit 40 Endspiel-Schlaegen ausgelegt" - gemessen sind es 16,7.
   Bei 4 Stunden Abklingzeit je Spieler heisst das drei Kommandanten an einem Tag oder eine
   Allianz an einem Abend; naeher am beschriebenen Gefuehl als vierzig Schlaege. Die ZAHLEN des
   Konzepts bleiben, der Satz daneben war falsch (Frontend-Arbeitsregel 41).

   `punkte` ist die einzige Groesse, mit der ein Nest auf die Galaxie wirkt - ihre Summe ueber
   alle Nester steuert ab Phase 4 den Zielwert von npcEmpireStrength. Sie steht schon hier, damit
   Phase 4 nichts an dieser Tabelle aendern muss. */
const NEST_STUFEN = [
  null,
  { name: 'Sporenherd',   lp: 40000,   punkte: 1, kampfpunkte: 15,   xp: 120,  credits: 400 },
  { name: 'Brutkammer',   lp: 120000,  punkte: 2, kampfpunkte: 45,   xp: 360,  credits: 1200 },
  { name: 'Schwarmstock', lp: 400000,  punkte: 3, kampfpunkte: 130,  xp: 1000, credits: 3500 },
  { name: 'Hochnest',     lp: 1200000, punkte: 4, kampfpunkte: 380,  xp: 3000, credits: 10000 },
  { name: 'Königin',      lp: 4000000, punkte: 5, kampfpunkte: 1200, xp: 9000, credits: 30000 }
];
const NEST_MAX = 12;                      // galaxieweit gleichzeitig
const NEST_ABKLING_MS = 4 * 3600 * 1000;  // je Nest und Spieler - kuerzer als bei der Festung, weil ein Nest davonlaeuft
const NEST_WURF_MS = 8 * 3600 * 1000;
const NEST_WURF_CHANCE = 0.35;
const NEST_KOENIGIN_AB = 4;               // Nester eines Volkes, ab denen die Koenigin schluepft
const NEST_PAUSE_MS = 72 * 3600 * 1000;   // Sperre des Volkes nach einem Koeniginnen-Fall
const NEST_WANDER_MS = 12 * 3600 * 1000;  // nur die Nomaden von Vex
const NEST_VERLUST = 0.10;

/* ===== PHASE 4: die galaktische Gegnerstaerke wird beweglich ==================================
   Bis hierher wuchs `npcEmpireStrength` monoton bis 2,5 und blieb dort - ein Schwierigkeitsregler,
   den niemand bewegen kann. Neu leitet der galaxyTick einen ZIELWERT aus dem Nestbestand ab und
   laesst den Ist-Wert dorthin driften: Wer aufraeumt, macht die Galaxie fuer alle leichter; wer
   die Nester wachsen laesst, bezahlt es mit haerteren NPC-Gegnern.

   DIE DRIFT LAEUFT NUR, WENN NEST_SPAWN_AKTIV AN IST - und das ist keine Vorsicht, sondern
   gemessen: Ohne Nester ist die Stufensumme 0, der Zielwert waere die Basis, und die
   NPC-Verteidigung fiele sofort um 44 %. Allein dadurch, dass diese Phase gemergt wird, waehrend
   Phase 3 noch schlaeft. Steht der Schalter aus, bleibt deshalb das alte monotone Wachstum.

   DIE BASIS IST DIE KONSERVATIVE VARIANTE (Konzept 11.2 fuehrt sie als offene Entscheidung).
   Gerechnet gegen den heutigen Stand 2,5:

     Lage                        Summe   Konzept (1,0 + 0,080)   gewaehlt (1,4 + 0,046)
     geraeumt                        0   1,00  (-60 %)           1,40  (-44 %)
     ruhig (4 Nester Stufe 2)        8   1,64  (-34 %)           1,77  (-29 %)
     angespannt (8 Nester Stufe 3)  24   2,50  (+-0)             2,50  (+-0)

   Beide Kurven enden am selben Deckel, aber NICHT bei derselben Dichte: Die Konzept-Kurve ist
   schon bei 18,75 Stufenpunkten oben, die gewaehlte erst bei 23,9 - sie laesst der Galaxie also
   ein Stueck mehr Luft, bevor sie nichts mehr haerter machen kann. Der eigentliche Unterschied
   liegt am unteren Ende, und genau dort steht der Spieler AM TAG DER UMSTELLUNG, wenn es null bis
   ein Nest gibt: Die Konzept-Basis verschenkte in den ersten 19 Stunden 60 % der
   NPC-Verteidigung, ohne dass jemand etwas dafuer getan haette.

   4 % Annaeherung je Tick (96 Ticks/Tag): halber Abstand nach 4,2 h, 95 % nach 18,3 h. Die
   Galaxie reagiert also innerhalb eines Tages sichtbar, aber ein einzelner Angriff schaltet die
   Weltlage nicht um. */
const NPC_STAERKE_BASIS = 1.4;
const NPC_STAERKE_JE_STUFENPUNKT = 0.046;
const NPC_STAERKE_DECKEL = 2.5;
const NPC_STAERKE_DRIFT = 0.04;
/* Bewusst OHNE Helfer `nestStufen(n)` daneben: Der haette sich von `nestStufe(zahl)` um einen
   Buchstaben unterschieden und ein Nest-OBJEKT statt einer Stufenzahl genommen - genau die Sorte
   Namenspaar, die spaeter jemand verwechselt. Die Summe steht deshalb hier ausgeschrieben. */
function nestStufenSumme(g) {
  return nestListe(g).reduce((a, n) => a + (nestStufe(n && n.stufe).punkte || 0), 0);
}
function npcStaerkeZiel(g) {
  return Math.min(NPC_STAERKE_DECKEL, NPC_STAERKE_BASIS + NPC_STAERKE_JE_STUFENPUNKT * nestStufenSumme(g));
}                // Grundverlust des Angreifers je Schlag

function nestVolkVonName(name) {
  for (const [k, v] of Object.entries(ALIEN_VOELKER)) if (v.name === name) return k;
  return null;
}
function nestStufe(n) { return NEST_STUFEN[Math.max(1, Math.min(5, n || 1))]; }
function nestLpMax(volk, stufe) {
  const v = ALIEN_VOELKER[volk] || { lpFaktor: 1 };
  return Math.round(nestStufe(stufe).lp * v.lpFaktor);
}
function nestListe(g) {
  if (!Array.isArray(g.alienNester)) g.alienNester = [];
  return g.alienNester;
}
/* Wo darf ein Nest entstehen? Nach DERSELBEN Regel wie jedes andere ortsgebundene Ereignis -
   occupiedSystems() haelt jedes System frei, in dem ein Spieler zu Hause ist. Dazu kein zweites
   Nest im selben System und keines dort, wo eine Festung steht: Zwei angreifbare Ziele auf einem
   Kartenknoten waeren fuer den Spieler nicht auseinanderzuhalten. */
function nestSystemFrei(g, sysId) {
  if (!sysId || !SYSTEMS.includes(sysId)) return false;
  if (occupiedSystems().has(sysId)) return false;
  if (g.collapsedSystems && g.collapsedSystems[sysId]) return false;
  if (nestListe(g).some(n => n.sys === sysId)) return false;
  if (a2Liste(g).some(z => z.sys === sysId)) return false;   // kein Nest auf einem A2-Ziel (Gegenrichtung zu a2SystemFrei)
  const feld = db.shared[astFeldKey(sysId)];
  if (feld && feld.festung) return false;
  return true;
}
function nestNeu(g, volk, sysId, now) {
  const nest = {
    id: crypto.randomUUID(),
    volk, sys: sysId, stufe: 1,
    lp: nestLpMax(volk, 1), lpMax: nestLpMax(volk, 1),
    seit: now, letzteReifung: now,
    naechsterWurf: now + NEST_WURF_MS,
    naechsteWanderung: ALIEN_VOELKER[volk] && ALIEN_VOELKER[volk].wandert ? now + NEST_WANDER_MS : 0,
    beitraege: {}, schlaege: {}
  };
  nestListe(g).push(nest);
  return nest;
}
/* Das `system`-Feld des vorhandenen "Volk entdeckt"-Eintrags auf das STAERKSTE Nest des Volkes
   nachfuehren. Reine Ruecksicht auf den Deploy: Ein Frontend, das die Nester noch nicht kennt,
   zeigt so weiterhin ein sinnvolles Alien-Abzeichen am richtigen Ort statt gar keins - und wenn
   das Volk keine Nester mehr hat, bleibt der letzte bekannte Ort stehen statt zu verschwinden. */
function nestOrteNachfuehren(g) {
  for (const eintrag of (g.unlockedAlienRaces || [])) {
    const volk = nestVolkVonName(eintrag && eintrag.name);
    if (!volk) continue;
    let bestes = null;
    for (const n of nestListe(g)) {
      if (n.volk !== volk) continue;
      if (!bestes || n.stufe > bestes.stufe || (n.stufe === bestes.stufe && n.seit < bestes.seit)) bestes = n;
    }
    if (bestes) eintrag.system = bestes.sys;
  }
}
/* DER TAKT. Laeuft im galaxyTick (alle 15 Minuten) - anders als der Hort der Festung, der LAZY
   beim Lesen waechst. Der Unterschied hat einen Grund: Der Hort ist ein Zaehler, den nur der
   Leser sieht; ein Nest VERAENDERT die Galaxie (es reift, es breitet sich aus, es bringt eine
   Koenigin hervor), und diese Ereignisse gehoeren in den Weltentakt, nicht in einen
   Kartenaufruf. Sonst haengt die Weltlage daran, wer wie oft die Karte oeffnet. */
function nestTick(g) {
  // spawnAktiv() statt der blanken Konstante: Damit greift zusaetzlich die Notabschaltung ueber
  // /api/admin/schalter (siehe dort). Sie stoppt bewusst nur den NACHSCHUB - vorhandene Nester
  // bleiben stehen und angreifbar, sonst staenden nach dem Abschalten unerreichbare Ziele herum.
  if (!spawnAktiv('nester')) return;
  const now = Date.now();
  const liste = nestListe(g);
  g.alienPause = g.alienPause || {};

  // 1) Reifen. Die LP wachsen MIT der Stufe, aber bereits angerichteter Schaden bleibt
  //    angerichtet: lp steigt um dieselbe Differenz wie lpMax. Ein Nest, das beim Reifen voll
  //    heilte, machte jeden Schlag wertlos, der vor dem Reifen fiel - und Warten waere die
  //    beste Strategie fuer den Schwarm, nicht fuer den Spieler.
  for (const n of liste) {
    const v = ALIEN_VOELKER[n.volk];
    if (!v || n.stufe >= 4) continue;                    // Stufe 5 ist die Koenigin, sie entsteht anders
    const faellig = (n.letzteReifung || n.seit || now) + v.reifeStd * 3600 * 1000;
    if (now < faellig) continue;
    const alt = n.lpMax;
    n.stufe += 1;
    n.lpMax = nestLpMax(n.volk, n.stufe);
    n.lp = Math.max(1, Math.round((n.lp || 0) + (n.lpMax - alt)));
    n.letzteReifung = now;
    pushGalaxyNews('ti-alien', 'Das Nest der ' + v.name + ' bei ' + n.sys + ' ist zum ' +
      nestStufe(n.stufe).name + ' herangewachsen.');
  }

  // 2) Ausbreiten. Ab Stufe 3, alle 8 Stunden ein Wurf, in ein BENACHBARTES freies System.
  //    "Benachbart" ist keine neue Rechnung: SYSTEM_NEIGHBORS fuehrt zu jedem System die vier
  //    naechstgelegenen und wird beim Wochenwechsel mitgezogen - dieselbe Tabelle, nach der die
  //    NPC-Fraktionen expandieren. Eine zweite Distanzregel waere eine zweite Wahrheit.
  for (const n of liste.slice()) {
    const v = ALIEN_VOELKER[n.volk];
    if (!v || !(v.ausbreitMult > 0) || n.stufe < 3) continue;
    if (now < (n.naechsterWurf || 0)) continue;
    n.naechsterWurf = now + NEST_WURF_MS;
    if (liste.length >= NEST_MAX) continue;              // Deckel: der Wurf verfaellt
    if (Math.random() >= NEST_WURF_CHANCE * v.ausbreitMult) continue;
    const frei = (SYSTEM_NEIGHBORS[n.sys] || []).filter(s => nestSystemFrei(g, s));
    if (!frei.length) continue;
    const ziel = frei[Math.floor(Math.random() * frei.length)];
    nestNeu(g, n.volk, ziel, now);
    pushGalaxyNews('ti-alien', 'Die ' + v.name + ' haben sich von ' + n.sys + ' nach ' + ziel +
      ' ausgebreitet. Dort waechst ein neuer ' + NEST_STUFEN[1].name + '.');
  }

  // 3) Die Nomaden wandern, statt sich zu teilen. Ein Ziel, das man VERLIEREN kann, wenn man zu
  //    lange zoegert - der Angriff fliegt dann ins Leere und die Flotte kommt ohne Kampf zurueck.
  //    Die Beitraege reisen MIT: Wer Schaden angerichtet hat, hat ihn angerichtet.
  for (const n of liste) {
    const v = ALIEN_VOELKER[n.volk];
    if (!v || !v.wandert || !n.naechsteWanderung || now < n.naechsteWanderung) continue;
    n.naechsteWanderung = now + NEST_WANDER_MS;
    const frei = (SYSTEM_NEIGHBORS[n.sys] || []).filter(s => nestSystemFrei(g, s));
    if (!frei.length) continue;
    const alt = n.sys;
    n.sys = frei[Math.floor(Math.random() * frei.length)];
    pushGalaxyNews('ti-alien', 'Die ' + v.name + ' sind von ' + alt + ' nach ' + n.sys +
      ' weitergezogen - ihr Nest ist dort nicht mehr zu finden.');
  }

  // 4) Die Koenigin. Ab NEST_KOENIGIN_AB Nestern eines Volkes schluepft sie am AELTESTEN; ab da
  //    breitet sich dieses Volk nicht weiter aus - der Schwarm sammelt sich.
  for (const volk of Object.keys(ALIEN_VOELKER)) {
    const eigene = liste.filter(n => n.volk === volk);
    if (eigene.length < NEST_KOENIGIN_AB) continue;
    if (eigene.some(n => n.stufe === 5)) continue;
    const aeltestes = eigene.reduce((a, b) => (a.seit <= b.seit ? a : b));
    const alt = aeltestes.lpMax;
    aeltestes.stufe = 5;
    aeltestes.lpMax = nestLpMax(volk, 5);
    aeltestes.lp = Math.max(1, Math.round((aeltestes.lp || 0) + (aeltestes.lpMax - alt)));
    aeltestes.letzteReifung = now;
    pushGalaxyNews('ti-alien', 'Bei ' + aeltestes.sys + ' ist die Königin der ' +
      ALIEN_VOELKER[volk].name + ' geschlüpft. Faellt sie, faellt der ganze Schwarm.');
  }

  // 5) Erster Nachschub: Ein entdecktes Volk ohne Nest und ohne laufende Pause bekommt eines.
  for (const eintrag of (g.unlockedAlienRaces || [])) {
    const volk = nestVolkVonName(eintrag && eintrag.name);
    if (!volk) continue;
    if (liste.some(n => n.volk === volk)) continue;
    if ((g.alienPause[volk] || 0) > now) continue;
    if (liste.length >= NEST_MAX) continue;
    const kandidat = nestSystemFrei(g, eintrag.system) ? eintrag.system : pickRandomFreeSystem();
    if (!nestSystemFrei(g, kandidat)) continue;
    nestNeu(g, volk, kandidat, now);
    pushGalaxyNews('ti-alien', 'Die ' + ALIEN_VOELKER[volk].name + ' haben bei ' + kandidat +
      ' einen ' + NEST_STUFEN[1].name + ' angelegt.');
  }

  nestOrteNachfuehren(g);
}

/* ===== A2: die wandernden Beute-Ziele (Wrackkonvois) ==========================================
   Konzept: docs/wandernde-beute-ziele-konzept.md im FRONTEND-Repo. Hier steht nur, was man kennen
   muss, bevor man etwas aendert.

   A2 ist NICHT ein dritter Nomaden-Klon (Konzept Abschnitt 0). Es hebt sich vom Vex-Nest ueber
   ZWEI Achsen ab, die dem Nest gemessen fehlen:
     1. EXKLUSIVE BEUTE ueber das Herkunfts-Schloss (quelle:'konvoi') - Task 2, hier noch nicht.
     2. DAS ENTKOMMEN - der Kern-Reiz. Das Nest kann durchs Ignorieren NICHT verschwinden
        ('weitergezogen' heisst dort 'ins Nachbarsystem, weiter angreifbar'). Ein A2-Ziel dagegen
        wird bei erreichter Lebensdauer GANZ aus db.galaxy.wrackKonvois entfernt (Zweig 1 des Ticks).
        Der Endpunkt braucht dafuer einen DRITTEN verpasst-Grund 'entkommen' - Task 2.

   Ablageort ist db.galaxy.wrackKonvois (Feld-Init in loadOrInitGalaxy): ueber PUT /api/storage gar
   nicht schreibbar, und galaxyFuerClient() schickt alles aus db.galaxy automatisch lesend an den
   Client. Damit ist die ganze Fehlerklasse 'offener Shared-Storage' umgangen (kein
   checkKeyPermission noetig), und die Abklingzeit liegt AN DAS ZIEL (ziel.schlaege[uid]), nie im
   Spielstand - genau wie bei Nest und Festung.

   DIE ZAHLEN SIND GEGEN DIE BEREITS KALIBRIERTEN NEST-/FESTUNGS-LP GERECHNET (Regel 41), nicht
   gegen ein Gefuehl. Massstab sind die gemessenen Schlagkraefte je Schlag: 7.500 (Einsteiger) /
   44.000 (Mittelfeld) / 240.000 (Endspiel).
     - A2_LP = 40.000 ist die Groessenordnung des Sporenherds (dem Einsteiger-Nest): rund
       5,3 / 0,9 / 0,2 Schlaege. Solo-tauglich, das ist der Auftrag.
     - A2_ABKLING_MS = 2 h. In der Lebensdauer von 18 h bekommt ein Solo-Konto damit 9 Schlaege
       (t = 0, 2, ..., 16 h) - deutlich mehr als die noetigen ~5,3, plus Luft fuer Hin- und
       Rueckflug. Das ist die Bedingung aus Konzept Abschnitt 4: das Ziel darf nicht entkommen,
       bevor seine Zielgruppe es realistisch stellen kann.
     - A2_WANDER_MS = 6 h: driftet in der Lebensdauer bis zu zweimal (Beitraege und schlaege reisen
       mit), bleibt also verfolgbar, ohne zu kleben.
     - A2_LEBENSDAUER_MS = 18 h ist die Frist, nach der es ENTKOMMT. Gegen Abklingzeit und
       Schlagbedarf gerechnet (siehe oben), nicht geraten.
     - A2_WURF_MS = 3 h, A2_WURF_CHANCE = 0,5, A2_MAX = 2: im Schnitt ein neues Ziel je ~6 h,
       galaxieweit hoechstens zwei gleichzeitig. Selten genug, dass die Karte abzusuchen ein Grund
       ist ('findbar'), praesent genug, dass es sich lohnt.
     - A2_VERLUST = 0,08: Grundverlust des Angreifers je Schlag, wie beim Nest.

   A2_SPAWN_AKTIV STEHT AUF false - NOTAUSSCHALTER und Auslieferungs-Riegel (Regel 60): A2 wirft
   ein Kampf-Modul-Set ab (Beute-Variante 3, PvP-relevant), also muss das Backend vor dem Frontend
   live sein und der Schalter im Frontend-PR umgelegt werden. Solange er aus ist, kehrt A2Tick in
   Zeile 1 zurueck und der ganze Abschnitt tut nichts. */
const A2_SPAWN_AKTIV = false;
const A2_ART = 'wrackkonvoi';
const A2_ART_NAME = 'Wrackkonvoi';
const A2_LP = 40000;
const A2_ABKLING_MS = 2 * 3600 * 1000;   // je Ziel und Spieler
const A2_WANDER_MS = 6 * 3600 * 1000;    // Drift in ein freies Nachbarsystem
const A2_LEBENSDAUER_MS = 18 * 3600 * 1000; // danach ENTKOMMT das Ziel (ganz entfernt)
const A2_WURF_MS = 3 * 3600 * 1000;      // Entstehungs-Versuch je Intervall
const A2_WURF_CHANCE = 0.5;
const A2_MAX = 2;                        // galaxieweit gleichzeitig
const A2_VERLUST = 0.08;                 // Grundverlust des Angreifers je Schlag

function a2Liste(g) {
  // Client-Feldname bewusst als Spielbegriff (wrackKonvois), nicht als Etappencode: galaxyFuerClient
  // schickt db.galaxy roh an den Client, das Feld IST damit Teil des Client-Vertrags (wie alienNester).
  // Die internen Helfer (A2Tick, a2Neu, a2Liste, A2_*) behalten den Etappen-Prefix - sie sind intern.
  if (!Array.isArray(g.wrackKonvois)) g.wrackKonvois = [];
  return g.wrackKonvois;
}
/* Eine kurze Spur der zuletzt verschwundenen Ziele (id -> grund), gedeckelt. Sie hat EINEN Zweck:
   Ist das Ziel bei der Ankunft weg, unterscheidet der Endpunkt damit "gefallen" von "entkommen" -
   beides kostet nichts, aber die Antwort soll den WAHREN Grund nennen (die Kernwahrheit dieses
   Projekts: eine Anzeigestelle luegt nicht). Ein Miss faellt auf "gefallen" zurueck - harmlos, weil
   beide Ausgaenge folgenlos sind. */
function a2VerlaufVermerken(g, id, grund) {
  if (!Array.isArray(g.a2Verlauf)) g.a2Verlauf = [];
  g.a2Verlauf.push({ id: id, grund: grund, zeit: Date.now() });
  if (g.a2Verlauf.length > 40) g.a2Verlauf = g.a2Verlauf.slice(-40);
}
function a2VerlaufGrund(g, id) {
  const arr = Array.isArray(g.a2Verlauf) ? g.a2Verlauf : [];
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i].id === id) return arr[i].grund;
  return 'gefallen';
}
/* Wo darf ein A2-Ziel entstehen oder hindriften? Nach DERSELBEN Regel wie Nest und Festung: kein
   bewohntes System, kein kollabiertes, und kein zweites angreifbares Objekt auf demselben
   Kartenknoten (anderes A2-Ziel, Nest, Festung) - sonst stapeln sich Abzeichen und Marker. Die
   Gegenrichtung steht bei nestSystemFrei (kein Nest auf A2) und festungSpawn (keine Festung auf
   A2), damit die Sperre in beide Richtungen greift. */
function a2SystemFrei(g, sysId) {
  if (!sysId || !SYSTEMS.includes(sysId)) return false;
  if (occupiedSystems().has(sysId)) return false;
  if (g.collapsedSystems && g.collapsedSystems[sysId]) return false;
  if (a2Liste(g).some(z => z.sys === sysId)) return false;
  if (nestListe(g).some(n => n.sys === sysId)) return false;
  const feld = db.shared[astFeldKey(sysId)];
  if (feld && feld.festung) return false;
  return true;
}
/* Ein freies System aus der ganzen Galaxie ziehen. Bewusst NICHT pickRandomFreeSystem(): das faellt
   bei erschoepfter Auswahl auf IRGENDEIN System zurueck und traefe dann ein Nest oder eine Festung.
   Hier ist null der richtige Ausgang - der Entstehungs-Versuch dieses Takts verfaellt einfach. */
function a2FreiesSystem(g) {
  const frei = SYSTEMS.filter(s => a2SystemFrei(g, s));
  return frei.length ? frei[Math.floor(Math.random() * frei.length)] : null;
}
function a2Neu(g, sysId, now) {
  const ziel = {
    id: crypto.randomUUID(),
    sys: sysId,
    lp: A2_LP, lpMax: A2_LP,
    seit: now,
    naechsteWanderung: now + A2_WANDER_MS,
    beitraege: {}, schlaege: {},
    // Die BEUTE reist im Objekt mit (Konzept Abschnitt 10): das Frontend zeigt die Vorschau daraus,
    // statt eine zweite, driftende Kopie der Zahlen zu fuehren. A2 ist einstufig - deshalb genuegt
    // EIN flacher Deskriptor je Konvoi (keine Stufentabelle wie beim Nest, keine Paritaetspflicht).
    // Die Werte sind der VOLLE Konvoi; jeder Angreifer bekommt seinen Schadensanteil davon.
    beute: { essenz: A2_ESSENZ, kampfpunkte: A2_KAMPFPUNKTE, xp: A2_XP, credits: A2_CREDITS, modulChance: A2_MODUL_CHANCE }
  };
  a2Liste(g).push(ziel);
  return ziel;
}
/* DER TAKT. Laeuft im galaxyTick (alle 15 Minuten), wie nestTick - ein A2-Ziel VERAENDERT die
   Galaxie (es entsteht, driftet, entkommt), und diese Ereignisse gehoeren in den Weltentakt.
   Drei Zweige; der Endpunkt (Angriff, Fall) ist Task 2 und lebt woanders. */
function A2Tick(g) {
  if (!A2_SPAWN_AKTIV) return;
  const now = Date.now();
  const liste = a2Liste(g);

  // 1) ENTKOMMEN. Lebensdauer erreicht, ohne gefallen zu sein -> GANZ entfernen (nicht verschieben).
  //    Das ist die eine Mechanik, die A2 vom Nest strukturell unterscheidet. Rueckwaerts iteriert,
  //    weil gespleisst wird.
  for (let i = liste.length - 1; i >= 0; i--) {
    const z = liste[i];
    if (now >= (z.seit || now) + A2_LEBENSDAUER_MS) {
      liste.splice(i, 1);
      a2VerlaufVermerken(g, z.id, 'entkommen');
      pushGalaxyNews('ti-recycle', 'Der ' + A2_ART_NAME + ' bei ' + z.sys +
        ' ist aus der Sektorkarte verschwunden - niemand hat ihn rechtzeitig aufgebracht.');
    }
  }

  // 2) DRIFTEN. Alle A2_WANDER_MS in ein freies Nachbarsystem. Beitraege und schlaege reisen MIT
  //    (sie haengen am Ziel, nicht am Ort) - dieselbe Freiheitspruefung wie bei der Entstehung.
  for (const z of liste) {
    if (now < (z.naechsteWanderung || 0)) continue;
    z.naechsteWanderung = now + A2_WANDER_MS;
    const frei = (SYSTEM_NEIGHBORS[z.sys] || []).filter(s => a2SystemFrei(g, s));
    if (!frei.length) continue;
    const alt = z.sys;
    z.sys = frei[Math.floor(Math.random() * frei.length)];
    pushGalaxyNews('ti-recycle', 'Der ' + A2_ART_NAME + ' ist von ' + alt + ' nach ' + z.sys +
      ' weitergedriftet.');
  }

  // 3) ENTSTEHEN. Alle A2_WURF_MS ein Versuch, galaxieweit gedeckelt auf A2_MAX. Ein galaxie-weiter
  //    Zaehler (g.a2NaechsterWurf) statt der volk-gebundenen Nest-Zeiten - A2 hat keine Kopplung.
  //    Findet a2FreiesSystem nichts, verfaellt der Versuch (null), statt auf ein belegtes System
  //    auszuweichen.
  if (now >= (g.a2NaechsterWurf || 0)) {
    g.a2NaechsterWurf = now + A2_WURF_MS;
    if (liste.length < A2_MAX && Math.random() < A2_WURF_CHANCE) {
      const sysId = a2FreiesSystem(g);
      if (sysId) {
        a2Neu(g, sysId, now);
        pushGalaxyNews('ti-recycle', 'Ein ' + A2_ART_NAME + ' ist bei ' + sysId +
          ' auf der Sektorkarte aufgetaucht. Er treibt weiter oder entkommt - wer die Bergung will, muss ihn stellen.');
      }
    }
  }
}

/* ===== A2: Angriff und Belohnung (Task 2) ===================================================
   Der Endpunkt und der Belohnungsweg. Gebaut nach dem Muster von /api/alien/nest-angriff - die
   drei Entscheidungen von dort (Abklingzeit AM ZIEL, angekommener Schaden statt Wurf, der Server
   schreibt keinen fremden Spielstand) gelten hier genauso. Zwei Dinge sind ANDERS als beim Nest:

   1. DIE BEUTE ("alle 3", Entscheidung Sascha). Anteilig an ALLE Beitragenden ueber
      pushPendingReward, mit EIGENEM type:'wrackkonvoi' (sonst faellt sie in den "+500 Kredite
      Bug-Report"-Rueckfall des Clients, bei fehlendem credits "+NaN Kredite"):
        - GARANTIERT anteilig: essenz (Sternenessenz) + kampfpunkte + xp + credits. Sternenessenz
          ist der eigentliche Reiz - die einzige Waehrung, die Prestige UND Aufstieg uebersteht;
          bewusst KLEIN gehalten (4 fuer einen ganzen Konvoi), weil sie sonst als wiederkehrende
          Quelle das Aufstiegs-Gefuege flutet (gemessen: eine Abgrund-Tiefe-180 zahlt 58, ein
          ganzer Aufstieg "ueber 100" - ein A2-Kill darf davon nur einen Bruchteil geben).
        - CHANCE JE ANTEIL: ein exklusives Standort-Modul (kv_bergungslogik) und ein exklusives
          Kampf-Modul (kv_bergungspanzer), quelle:'konvoi'. Der Server WUERFELT die Chance
          (Math.random() < anteil * A2_MODUL_CHANCE) - so ist das Modul nicht F5-druckbar, und die
          Exklusivitaet bleibt knapp (ein Modul je ~3 Kills solo). Der Server GRANTET das Modul
          nicht - die Grant-Funktionen liegen im Frontend; er reiht nur die SPEZIFIKATION ein, und
          der A2-Zweig in claimPendingRewards materialisiert sie und ruft save() (Regel 73).
      Weil das Kampf-Modul atk/hull/shield traegt, ist es PvP-relevant: SHIP_MODULE_COMBAT_BASE
      fuehrt kv_bergungspanzer (Paritaet, Task 3), und die Auslieferung ist Backend-zuerst (Regel 60).

   2. DER DRITTE verpasst-GRUND 'entkommen'. Ist das Ziel bei der Ankunft weg, unterscheidet
      a2VerlaufGrund zwischen 'gefallen' (jemand hat es gestellt) und 'entkommen' (Lebensdauer
      abgelaufen, GANZ verschwunden) - der Zug, den A2 vom Nest strukturell unterscheidet. Ein
      driftendes Ziel steht dagegen noch und wird wie beim Nest ueber ziel.sys erkannt. */
const A2_ESSENZ = 4;         // Sternenessenz je ganzem Konvoi, anteilig - klein gegen die Essenz-Wirtschaft
const A2_KAMPFPUNKTE = 20;
const A2_XP = 150;
const A2_CREDITS = 600;
const A2_MODUL_CHANCE = 0.3; // Basis-Fallchance je Modul, multipliziert mit dem Schadensanteil
const A2_MODUL_DEF = { defKey: 'kv_bergungslogik', seltenheit: 'episch', quelle: 'konvoi', art: 'standort' };
const A2_KAMPFMODUL_DEF = { defKey: 'kv_bergungspanzer', seltenheit: 'episch', quelle: 'konvoi', art: 'schiff' };

function A2FindeMission(save, missionId, zielId) {
  const flotten = [];
  if (save && save.fleet) flotten.push(save.fleet);
  if (save && save.colonies) for (const c of Object.values(save.colonies)) if (c && c.fleet) flotten.push(c.fleet);
  for (const f of flotten) {
    for (const m of (f.missions || [])) {
      if (String(m.id) === String(missionId) && m.type === 'konvoi-angriff' && String(m.zielId) === String(zielId)) return m;
    }
  }
  return null;
}
/* Der GEMEINSAME KERN eines A2-Schlags. Heute nur der Einzelangriff (unten); der Verbandsangriff
   koennte spaeter denselben Kern nutzen (wie nestSchlagAusfuehren). `beteiligte` ist
   [{ userId, name, gewicht }] - beim Einzelangriff ein Eintrag mit Gewicht 1. Ein Wrackkonvoi hat
   KEINE Schwaeche (anders als das Alien-Nest): flacher Wurf, kein Konterschiff. */
function A2SchlagAusfuehren(g, ziel, kraft, composition, beteiligte, jetzt) {
  const liste = a2Liste(g);
  const wurf = Math.round(kraft * (0.8 + Math.random() * 0.4));

  const lpVorher = ziel.lp || 0;
  ziel.lp = Math.max(0, lpVorher - wurf);
  const schaden = lpVorher - ziel.lp;          // was ANGEKOMMEN ist, nicht der Wurf

  ziel.beitraege = ziel.beitraege || {};
  ziel.schlaege = ziel.schlaege || {};
  const gewichtSumme = beteiligte.reduce((a, b) => a + (b.gewicht > 0 ? b.gewicht : 0), 0) || 1;
  for (const t of beteiligte) {
    const anteil = (t.gewicht > 0 ? t.gewicht : 0) / gewichtSumme;
    const b = ziel.beitraege[t.userId] || { name: t.name || 'Kommandant', schaden: 0 };
    b.schaden = (b.schaden || 0) + schaden * anteil;
    b.name = t.name || b.name;
    ziel.beitraege[t.userId] = b;
    ziel.schlaege[t.userId] = jetzt;
  }

  // Der Konvoi wehrt sich - als QUOTE, nicht als Stueckzahl (der Server schreibt keinen fremden
  // Spielstand; jeder Client wendet die Quote auf SEINEN Beitrag an).
  const quote = Math.min(0.5, A2_VERLUST + Math.random() * 0.06);

  const gefallen = ziel.lp <= 0;
  const anteile = {};
  let teilnehmer = 0;
  if (gefallen) {
    const summe = Object.values(ziel.beitraege).reduce((a, b) => a + (b.schaden || 0), 0) || 1;
    for (const [uid, b] of Object.entries(ziel.beitraege)) {
      const anteil = (b.schaden || 0) / summe;
      if (!(anteil > 0)) continue;
      teilnehmer++;
      anteile[uid] = anteil;
      const reward = {
        type: A2_ART,               // 'wrackkonvoi' - eigener Typ, sonst Bug-Report-Rueckfall im Client
        system: ziel.sys,
        anteil: Math.round(anteil * 1000) / 1000,
        essenz: Math.max(1, Math.round(A2_ESSENZ * anteil)),
        kampfpunkte: Math.max(1, Math.round(A2_KAMPFPUNKTE * anteil)),
        xp: Math.max(1, Math.round(A2_XP * anteil)),
        credits: Math.max(1, Math.round(A2_CREDITS * anteil)),
        zeit: jetzt
      };
      // Chance je Anteil - der Server wuerfelt, das Modul ist damit nicht F5-druckbar.
      if (Math.random() < anteil * A2_MODUL_CHANCE) reward.modul = Object.assign({}, A2_MODUL_DEF);
      if (Math.random() < anteil * A2_MODUL_CHANCE) reward.kampfmodul = Object.assign({}, A2_KAMPFMODUL_DEF);
      pushPendingReward(uid, reward);
    }
    const idx = liste.indexOf(ziel);
    if (idx >= 0) liste.splice(idx, 1);
    a2VerlaufVermerken(g, ziel.id, 'gefallen');
    pushGalaxyNews('ti-recycle', 'Der ' + A2_ART_NAME + ' bei ' + ziel.sys + ' ist aufgebracht - ' +
      teilnehmer + ' Kommandant' + (teilnehmer === 1 ? '' : 'en') + ' teilen sich die Bergung.');
  }

  return { wurf, schaden, quote, gefallen, anteile, teilnehmer,
           lp: gefallen ? 0 : ziel.lp, lpMax: ziel.lpMax };
}
app.post('/api/konvoi/angriff', authMiddleware, async (req, res) => {
  const zielId = String((req.body && req.body.zielId) || '');
  const missionId = String((req.body && req.body.missionId) || '');
  if (!zielId || !missionId) return res.status(400).json({ error: 'zielId und missionId erforderlich.' });

  const g = loadOrInitGalaxy();
  const liste = a2Liste(g);
  const ziel = liste.find(z => z.id === zielId);
  const save = astLeseSave(req.userId);
  if (!save) return res.status(403).json({ error: 'Kein gespeicherter Spielstand - erst speichern, dann angreifen.' });
  const mission = A2FindeMission(save, missionId, zielId);
  if (!mission || !mission.composition) {
    return res.status(403).json({ error: 'Zu diesem Angriff ist keine Flotte im gespeicherten Spielstand unterwegs.' });
  }
  if (mission.endTime && mission.endTime > Date.now()) {
    return res.status(400).json({ error: 'Deine Flotte ist noch unterwegs.', unterwegs: true });
  }

  /* Das Ziel ist weg. Beides ist KEIN Fehler des Spielers, kostet also nichts - aber die Antwort
     nennt den WAHREN Grund: aufgebracht (gefallen) oder entkommen (Lebensdauer abgelaufen). */
  if (!ziel) {
    const grund = a2VerlaufGrund(g, zielId);
    const text = grund === 'entkommen'
      ? 'Der ' + A2_ART_NAME + ' ist entkommen, bevor dein Verband ihn stellen konnte - er kehrt vollzählig zurück.'
      : 'Der ' + A2_ART_NAME + ' war bei der Ankunft bereits aufgebracht - dein Verband kehrt vollzählig zurück.';
    return res.status(200).json({ ok: true, verpasst: true, grund: grund, text: text });
  }
  if (mission.system && ziel.sys !== mission.system) {
    return res.status(200).json({ ok: true, verpasst: true, grund: 'weitergezogen', neuesSystem: ziel.sys,
      text: 'Der ' + A2_ART_NAME + ' ist weitergedriftet - dein Verband findet bei ' + mission.system + ' nichts mehr vor und kehrt zurück.' });
  }

  const jetzt = Date.now();
  ziel.schlaege = ziel.schlaege || {};
  const letzter = ziel.schlaege[req.userId] || 0;
  if (letzter && jetzt - letzter < A2_ABKLING_MS) {
    return res.status(403).json({ error: 'Deine Verbände haben diesen Konvoi erst vor Kurzem beschossen - der nächste Schlag ist in ' +
      Math.ceil((letzter + A2_ABKLING_MS - jetzt) / 60000) + ' Minuten möglich.', abklingzeit: true });
  }

  const kraft = computeAttackPowerFromComposition(save, mission.composition, 0);
  if (!(kraft > 0)) return res.status(400).json({ error: 'Diese Flotte trägt keine Kampfkraft.' });
  const erg = A2SchlagAusfuehren(g, ziel, kraft, mission.composition,
    [{ userId: req.userId, name: req.username || 'Kommandant', gewicht: 1 }], jetzt);

  // Aus der Quote werden hier - und NUR hier - konkrete Verluste (der Einzelangreifer hat genau eine
  // Zusammensetzung; ein spaeterer Verband bekaeme die Quote selbst).
  const eigeneVerluste = {};
  for (const [typ, n] of Object.entries(mission.composition)) {
    if (typeof n !== 'number' || n <= 0) continue;
    const weg = Math.min(n, Math.round(n * erg.quote));
    if (weg > 0) eigeneVerluste[typ] = weg;
  }
  const meinAnteil = erg.anteile[req.userId] || 0;
  console.log('[konvoi-angriff] userId=' + req.userId + ' ziel=' + zielId + ' sys=' + ziel.sys +
    ' schaden=' + erg.schaden + ' lp=' + (erg.gefallen ? 'gefallen' : erg.lp) + '/' + erg.lpMax);
  await saveDb();
  res.json({
    ok: true, schaden: erg.schaden, gefallen: erg.gefallen,
    lp: erg.lp, lpMax: erg.lpMax,
    eigeneVerluste,
    anteil: erg.gefallen ? Math.round(meinAnteil * 1000) / 1000 : 0,
    teilnehmer: erg.gefallen ? erg.teilnehmer : Object.keys(ziel.beitraege).length,
    naechsterSchlagAb: jetzt + A2_ABKLING_MS
  });
});

function festungFindeMission(save, missionId, sysId) {
  const flotten = [];
  if (save && save.fleet) flotten.push(save.fleet);
  if (save && save.colonies) for (const c of Object.values(save.colonies)) if (c && c.fleet) flotten.push(c.fleet);
  for (const f of flotten) {
    for (const m of (f.missions || [])) {
      if (String(m.id) === String(missionId) && m.type === 'festung-angriff' && m.targetId === sysId) return m;
    }
  }
  return null;
}
app.post('/api/festung/angriff', authMiddleware, async (req, res) => {
  const sysId = String((req.body && req.body.system) || '');
  const missionId = (req.body && req.body.missionId) !== undefined ? String(req.body.missionId) : '';
  const festungId = String((req.body && req.body.festungId) || '');
  if (!sysId || !missionId) return res.status(400).json({ error: 'System und Mission fehlen.' });
  if (astGuertelSysteme().indexOf(sysId) < 0) return res.status(400).json({ error: 'Dieses System trägt keinen Asteroidengürtel.' });

  const { felder } = astAlleFelder();          // reift den Hort auf den Stand dieser Sekunde
  const feld = felder[sysId];
  const fest = feld && feld.festung;
  if (!fest) return res.status(409).json({ error: 'In diesem System steht keine Festung mehr - sie ist bereits gefallen.', weg: true });
  // Die Kennung ist der Schutz gegen den seltenen, aber echten Fall: Die Festung faellt, waehrend
  // die eigene Flotte unterwegs ist, und der galaxyTick setzt spaeter eine NEUE ins selbe System.
  // Ohne diese Zeile schlueg der Anflug gegen ein Ziel ein, das es beim Start nicht gab.
  if (festungId && fest.id !== festungId) {
    return res.status(409).json({ error: 'Die Festung, gegen die du geflogen bist, ist gefallen - an ihrer Stelle steht bereits eine neue.', weg: true });
  }

  fest.abgerechnet = fest.abgerechnet || {};
  if (fest.abgerechnet[missionId]) return res.status(409).json({ error: 'Dieser Anflug wurde bereits abgerechnet.' });

  const jetzt = Date.now();
  fest.schlaege = fest.schlaege || {};
  const letzter = fest.schlaege[req.userId] || 0;
  if (letzter + FESTUNG_ABKLING_MS > jetzt) {
    return res.status(403).json({ error: 'Deine Verbände haben diese Festung erst vor Kurzem beschossen - der nächste Schlag ist in ' + Math.ceil((letzter + FESTUNG_ABKLING_MS - jetzt) / 60000) + ' Minuten möglich.', abklingzeit: true });
  }

  const save = astLeseSave(req.userId);
  if (!save) return res.status(403).json({ error: 'Kein gespeicherter Spielstand - erst speichern, dann angreifen.' });
  const mission = festungFindeMission(save, missionId, sysId);
  if (!mission || !mission.composition) {
    return res.status(403).json({ error: 'Zu diesem Angriff ist keine Flotte im gespeicherten Spielstand unterwegs.' });
  }
  if (mission.endTime && mission.endTime > jetzt) {
    return res.status(400).json({ error: 'Deine Flotte ist noch unterwegs.', unterwegs: true });
  }

  const st = FESTUNG_STUFEN[fest.stufe] || FESTUNG_STUFEN.schanze;
  // Dritter Parameter 0: Der Weltboss-Schwaechenbonus gilt hier nicht - eine Festung hat keinen
  // Archetyp.
  const kraft = computeAttackPowerFromComposition(save, mission.composition, 0);
  if (!(kraft > 0)) return res.status(400).json({ error: 'Diese Flotte trägt keine Kampfkraft.' });
  const wurf = Math.round(kraft * (0.8 + Math.random() * 0.4));

  /* ZIELWAHL (Phase 2). Sie steht in der MISSION, nicht im Request - genau wie der
     Gefechtsvorrat und aus demselben Grund: /api/festung/angriff nimmt keinen einzigen
     Kampfparameter aus dem Body entgegen, das ist eine Eigenschaft dieses Endpunkts.
     Ist das gewaehlte Bauteil schon zerstoert (ein Mitstreiter war schneller), geht der Schaden
     OHNE Rollenfaktor auf den Kern: Die Flotte wird nicht dafuer bestraft, dass jemand anders
     schneller war - aber sie bekommt auch nicht den Bonus fuer ein Ziel, das sie nicht trifft. */
  let ziel = String(mission.ziel || 'kern');
  if (ziel !== 'kern' && !festungTeilSteht(fest, ziel)) ziel = 'kern-ersatz';

  let schaden = 0, teilSchaden = 0, zerstoert = null, rollenFaktor = 1;
  const marks = save.shipMarks;
  const kernVorher = fest.kern;

  if (ziel === 'schild' || ziel === 'tuerme') {
    const spec = FESTUNG_BAUTEILE[ziel];
    rollenFaktor = festungRollenFaktor(mission.composition, spec, marks);
    const teil = fest.bauteile[ziel];
    const vorher = teil.lp || 0;
    teil.lp = Math.max(0, vorher - Math.round(wurf * rollenFaktor));
    teilSchaden = vorher - teil.lp;              // wieder: was ANGEKOMMEN ist
    if (teil.lp <= 0 && vorher > 0) zerstoert = ziel;
  } else {
    // Auf den Kern - mit Rollenfaktor, ausser das Ersatzziel greift.
    rollenFaktor = ziel === 'kern' ? festungRollenFaktor(mission.composition, FESTUNG_KERN_ROLLE, marks) : 1;
    // Solange die Schildkuppel steht, kommt nur ein Bruchteil durch. DAS ist ihr Zweck, und
    // deshalb lohnt der Umweg ueber sie (Rechnung im Kommentar bei FESTUNG_BAUTEILE).
    const durchlass = festungTeilSteht(fest, 'schild') ? FESTUNG_BAUTEILE.schild.kernDurchlass : 1;
    fest.kern = Math.max(0, kernVorher - Math.round(wurf * rollenFaktor * durchlass));
    schaden = kernVorher - fest.kern;
  }

  fest.beitraege = fest.beitraege || {};
  const mein = fest.beitraege[req.userId] || { name: req.username || 'Kommandant', schaden: 0 };
  /* Schaden an Schild und Tuermen zaehlt zu 60 % auf den Hortanteil. Ohne diesen Ausgleich wuerde
     niemand den Schild angreifen - die Arbeit nuetzt dem VERBAND, nicht dem eigenen Zaehler.
     Gewichtet, nicht voll: Wer den Kern zerlegt, hat die Festung gestuerzt; wer den Schild
     gebrochen hat, hat es ermoeglicht. Beides zaehlt, nicht gleich viel. */
  mein.schaden = (mein.schaden || 0) + schaden + Math.round(teilSchaden * FESTUNG_BAUTEIL_BEITRAG);
  mein.name = req.username || mein.name;
  fest.beitraege[req.userId] = mein;
  // Reaktionszeit: nur beim ERSTEN Schlag dieses Kontos auf diese Festung (`letzter` ist dann
  // 0). Danach misst die Differenz nur noch die Abklingzeit, nicht die Aufmerksamkeit.
  if (!letzter && fest.seit) reaktionVermerken(findUserById(req.userId), 'festung', (jetzt - fest.seit) / 1000);
  fest.schlaege[req.userId] = jetzt;
  fest.abgerechnet[missionId] = jetzt;

  // Die Festung schiesst zurueck. Anteilig auf die LOSGESCHICKTE Zusammensetzung; abgebucht wird
  // im Client, deshalb steht hier nur die Liste.
  /* Stehen die Geschuetztuerme, kostet der Anflug ein Vielfaches. Das ist ihr Zweck und der
     Grund, warum es sich lohnt, sie zuerst zu brechen: Der Wert, den man sich damit erkauft,
     ist der ganze Sinn der Bauteile. Der 50-%-Deckel bleibt aussen. */
  const quote = Math.min(0.5, (festungTeilSteht(fest, 'tuerme')
    ? FESTUNG_BAUTEILE.tuerme.verlustQuote
    : st.verlust) + Math.random() * 0.06);
  const eigeneVerluste = {};
  for (const [typ, n] of Object.entries(mission.composition)) {
    if (typeof n !== 'number' || n <= 0) continue;
    const weg = Math.min(n, Math.round(n * quote));
    if (weg > 0) eigeneVerluste[typ] = weg;
  }

  const gefallen = fest.kern <= 0;
  let meinAnteil = 0, teilnehmer = 0;
  if (gefallen) {
    /* Ausschuettung an ALLE Beitragenden - auch an den, der gerade anfragt. Bewusst EIN Weg fuer
       alle statt "die anderen ueber die Warteschlange, ich ueber die Antwort": Zwei Wege waeren
       zwei Rechnungen, die auseinanderlaufen koennen, und die Belohnung des Anfragenden ginge
       verloren, wenn sein Client zwischen Antwort und Verbuchung abstuerzt.
       pushPendingReward schreibt nach db.private[uid].__pendingRewards - also NICHT in fremde
       Spielstaende. Das ist der ganze Grund, warum es diese Warteschlange gibt: Ein Schreibzugriff
       auf den Spielstand eines gerade online spielenden Mitstreiters kollidiert mit dessen
       Autosave. Doppelt einreihen kann sich das nicht, weil die Festung im selben synchronen Block
       geloescht wird - ein zweiter Aufruf findet sie nicht mehr vor. */
    const summe = Object.values(fest.beitraege).reduce((a, b) => a + (b.schaden || 0), 0) || 1;
    for (const [uid, b] of Object.entries(fest.beitraege)) {
      const anteil = (b.schaden || 0) / summe;
      if (!(anteil > 0)) continue;
      teilnehmer++;
      if (uid === req.userId) meinAnteil = anteil;
      pveKillZaehlen(uid, 'festungen');          // Meilenstein-Emblem, Phase 6
      // Etappe B: ein Boss-Set-Teil kann hier fallen. Der Wurf liegt beim SERVER (wie im Raid),
      // der Client zieht daraus nur den Typ - das Herkunfts-Schloss bleibt damit unberuehrt.
      const bsFest = bosssetPveWurf(BOSSSET_PVE_CHANCE.festung[fest.stufe], anteil, fest.stufe);
      pushPendingReward(uid, Object.assign(bsFest ? { bossset: bsFest } : {}, {
        type: 'festung',
        system: sysId, stufe: fest.stufe, stufeName: st.name,
        sorte: fest.sorte, anteil: Math.round(anteil * 1000) / 1000,
        menge: Math.round((fest.hort || 0) * anteil),
        protomaterie: Math.round((fest.hortProto || 0) * anteil * 10) / 10,
        kampfpunkte: Math.max(1, Math.round(st.kampfpunkte * anteil)),
        zeit: jetzt
      }));
    }
    delete feld.festung;
    feld.geraeumtBis = jetzt + FESTUNG_GERAEUMT_MS;
    pushGalaxyNews('ti-building-fortress', 'Die ' + st.name + ' bei ' + sysId + ' ist gefallen - ' +
      teilnehmer + ' Kommandant' + (teilnehmer === 1 ? '' : 'en') + ' teilen sich den Hort. Der Gürtel ist ' +
      Math.round(FESTUNG_GERAEUMT_MS / 3600000) + ' Stunden lang frei, der Abbau dort um ' +
      Math.round(FESTUNG_GERAEUMT_BONUS * 100) + ' % ergiebiger.');
  }
  db.shared[astFeldKey(sysId)] = feld;

  console.log('[festung-angriff] userId=' + req.userId + ' sys=' + sysId + ' stufe=' + st.name +
    ' ziel=' + ziel + ' rolle=' + rollenFaktor.toFixed(2) +
    ' kernschaden=' + schaden + ' teilschaden=' + teilSchaden + (zerstoert ? ' ZERSTOERT:' + zerstoert : '') +
    ' kern=' + (gefallen ? 'gefallen' : fest.kern) + '/' + st.kern);
  await saveDb();
  // Der Zustand der Bauteile reist MIT - das Frontend zeigt daraus die Balken und weiss, welche
  // Ziele es ueberhaupt anbieten darf. Ein Client, der das Feld nicht kennt, ignoriert es.
  const bauteileAus = {};
  for (const k of Object.keys(FESTUNG_BAUTEILE)) {
    const t = fest.bauteile && fest.bauteile[k];
    if (t) bauteileAus[k] = { lp: Math.max(0, Math.round(t.lp || 0)), lpMax: t.lpMax || 0 };
  }
  res.json({
    ok: true, schaden, teilSchaden, ziel, zerstoert,
    rollenFaktor: Math.round(rollenFaktor * 100) / 100,
    bauteile: gefallen ? {} : bauteileAus,
    gefallen, eigeneVerluste,
    kern: gefallen ? 0 : fest.kern, kernMax: st.kern,
    stufe: gefallen ? null : fest.stufe, stufeName: st.name,
    anteil: gefallen ? Math.round(meinAnteil * 1000) / 1000 : 0,
    teilnehmer: gefallen ? teilnehmer : Object.keys(fest.beitraege).length,
    naechsterSchlagAb: jetzt + FESTUNG_ABKLING_MS
  });
});


function nestFindeMission(save, missionId, nestId) {
  const flotten = [];
  if (save && save.fleet) flotten.push(save.fleet);
  if (save && save.colonies) for (const c of Object.values(save.colonies)) if (c && c.fleet) flotten.push(c.fleet);
  for (const f of flotten) {
    for (const m of (f.missions || [])) {
      if (String(m.id) === String(missionId) && m.type === 'nest-angriff' && String(m.nestId) === String(nestId)) return m;
    }
  }
  return null;
}
/* Ein Schlag gegen ein Nest. Gebaut nach dem Muster von /api/festung/angriff, NICHT nach
   /api/worldboss/resolve - die drei Entscheidungen von dort gelten hier genauso:
   (1) Die Abklingzeit liegt AM NEST (nest.schlaege[userId]), nicht im Spielstand. Der Spielstand
       ist klientenautoritativ; ein geloeschtes Feld gaebe den naechsten Schlag sofort frei, und
       die einzige Bremse der Mechanik waere per Entwicklerkonsole abschaltbar.
   (2) Gezaehlt wird, was ANGEKOMMEN ist (lpVorher - lpNachher), nicht der volle Wurf. Sonst
       stuende der letzte Angreifer bei einem Vielfachen des Anteils, der seiner Arbeit entspricht.
   (3) Der Server schreibt den Spielstand des Angreifers NICHT. Die Verluste stehen in der
       Antwort, sein Client bucht sie - damit entsteht das Wettrennen mit dem Autosave gar nicht.
   Die Belohnung beim Fall geht ueber pushPendingReward an ALLE Beitragenden, auch an den
   Anfragenden selbst: ein Weg fuer alle statt zweier, die auseinanderlaufen koennen. */
/* DER GEMEINSAME KERN EINES NEST-SCHLAGS. Zwei Wege fuehren hierher: der Einzelangriff
   (/api/alien/nest-angriff) und - seit Phase 5 - der koordinierte Verbandsangriff
   (/api/musterattack/resolve). Eine zweite Kopie der Rechnung waere die uebliche zweite Wahrheit;
   dieselbe Ueberlegung wie bei astFreiePlaetze.

   ZWEI ENTSCHEIDUNGEN AN DER SCHNITTSTELLE, beide aus dem Unterschied der zwei Wege:

   1. REIN GEHT DIE KRAFT, nicht der Spielstand. Der Einzelangriff bildet sie aus dem Spielstand
      des Angreifers; ein VERBAND hat keinen einen Spielstand - seine Kraft steht seit dem Beitritt
      fest (doc.dispatch.totalPower, je Mitglied gemessen und summiert). Sie hier neu zu bilden
      hiesse, sie aus dem Spielstand eines einzelnen Mitglieds zu raten.
   2. RAUS KOMMEN DIE VERLUSTE ALS QUOTE, nicht als Stueckzahlen. Der Server schreibt fremde
      Spielstaende nicht; jeder Client wendet die Quote auf SEINEN eigenen Beitrag an. Der
      Einzelangriff rechnet daraus wie bisher konkrete Verluste, der Verband legt sie als
      ownLossPct ins Ergebnisdokument - dasselbe Muster wie bei der Basisangriffs-Aufloesung.

   `beteiligte` ist [{ userId, name, gewicht }]. Beim Einzelangriff ein Eintrag mit Gewicht 1.
   Beim Verband ALLE Teilnehmer, gewichtet nach ihrer beim Beitritt gemessenen Kraft: Ein Verband,
   dessen ganzer Schaden auf den Ausloeser gebucht wird, machte den Hort-Anteil zur Frage, wer
   zufaellig auf den Knopf drueckt. Aus demselben Grund bekommen ALLE die Abklingzeit - sonst
   schlaegt man im Verband zu und unmittelbar danach noch einmal allein. */
function nestSchlagAusfuehren(g, nest, kraft, composition, beteiligte, jetzt) {
  const liste = nestListe(g);
  const volk = ALIEN_VOELKER[nest.volk] || { name: nest.volk, schwaeche: null };
  const st = nestStufe(nest.stufe);
  const trifftSchwaeche = !!(volk.schwaeche && fleetHasShipType(composition, volk.schwaeche));
  const wurf = Math.round(kraft * (0.8 + Math.random() * 0.4) * (trifftSchwaeche ? ALIEN_SCHWAECHE_MULT : 1));

  const lpVorher = nest.lp || 0;
  nest.lp = Math.max(0, lpVorher - wurf);
  const schaden = lpVorher - nest.lp;          // was ANGEKOMMEN ist

  nest.beitraege = nest.beitraege || {};
  nest.schlaege = nest.schlaege || {};
  const gewichtSumme = beteiligte.reduce((a, b) => a + (b.gewicht > 0 ? b.gewicht : 0), 0) || 1;
  for (const t of beteiligte) {
    const anteil = (t.gewicht > 0 ? t.gewicht : 0) / gewichtSumme;
    const b = nest.beitraege[t.userId] || { name: t.name || 'Kommandant', schaden: 0 };
    b.schaden = (b.schaden || 0) + schaden * anteil;
    b.name = t.name || b.name;
    nest.beitraege[t.userId] = b;
    nest.schlaege[t.userId] = jetzt;
  }

  // Das Nest wehrt sich. Als Quote - siehe Punkt 2 oben.
  const quote = Math.min(0.5, NEST_VERLUST + Math.random() * 0.06);

  const gefallen = nest.lp <= 0;
  const anteile = {};
  let teilnehmer = 0, schwarmGefallen = false, mitgerissen = 0;
  if (gefallen) {
    const summe = Object.values(nest.beitraege).reduce((a, b) => a + (b.schaden || 0), 0) || 1;
    for (const [uid, b] of Object.entries(nest.beitraege)) {
      const anteil = (b.schaden || 0) / summe;
      if (!(anteil > 0)) continue;
      teilnehmer++;
      anteile[uid] = anteil;
      // Nur die KOENIGIN zaehlt - ein Sporenherd ist kein Meilenstein. Gezaehlt wird vor dem
      // Loeschen des Nestes, solange `nest.stufe` noch dasteht.
      if (nest.stufe === 5) pveKillZaehlen(uid, 'koeniginnen');
      const bsNest = bosssetPveWurf(BOSSSET_PVE_CHANCE.nest[nest.stufe], anteil, nest.stufe);
      pushPendingReward(uid, Object.assign(bsNest ? { bossset: bsNest } : {}, {
        type: 'alien-nest',
        system: nest.sys, volk: nest.volk, volkName: volk.name,
        stufe: nest.stufe, stufeName: st.name,
        anteil: Math.round(anteil * 1000) / 1000,
        kampfpunkte: Math.max(1, Math.round(st.kampfpunkte * anteil)),
        xp: Math.max(1, Math.round(st.xp * anteil)),
        credits: Math.max(1, Math.round(st.credits * anteil)),
        koenigin: nest.stufe === 5,
        zeit: jetzt
      }));
    }
    const idx = liste.indexOf(nest);
    if (idx >= 0) liste.splice(idx, 1);

    /* Faellt die KOENIGIN, stirbt der ganze Schwarm dieses Volkes. Das ist die Ausschuettung, auf
       die eine Allianz hinarbeitet - und zugleich der Grund, warum Wachsenlassen eine ECHTE
       Entscheidung ist: Wer frueh raeumt, zahlt wenig und bekommt wenig. */
    if (nest.stufe === 5) {
      schwarmGefallen = true;
      for (let i = liste.length - 1; i >= 0; i--) {
        if (liste[i].volk === nest.volk) { liste.splice(i, 1); mitgerissen++; }
      }
      g.alienPause = g.alienPause || {};
      g.alienPause[nest.volk] = jetzt + NEST_PAUSE_MS;
      pushGalaxyNews('ti-alien', 'Die Königin der ' + volk.name + ' bei ' + nest.sys + ' ist gefallen - ' +
        'der ganze Schwarm zerfällt' + (mitgerissen ? ' (' + mitgerissen + ' weitere Nester)' : '') + '. ' +
        'Das Volk sammelt sich für ' + Math.round(NEST_PAUSE_MS / 3600000) + ' Stunden.');
    } else {
      pushGalaxyNews('ti-alien', 'Der ' + st.name + ' der ' + volk.name + ' bei ' + nest.sys +
        ' ist zerstört - ' + teilnehmer + ' Kommandant' + (teilnehmer === 1 ? '' : 'en') + ' teilen sich die Bergung.');
    }
    nestOrteNachfuehren(g);
  }

  return { wurf, schaden, trifftSchwaeche, schwaeche: volk.schwaeche, quote, gefallen,
           anteile, teilnehmer, schwarmGefallen, mitgerissen,
           volkName: volk.name, stufeName: st.name,
           lp: gefallen ? 0 : nest.lp, lpMax: nest.lpMax, stufe: gefallen ? null : nest.stufe };
}
app.post('/api/alien/nest-angriff', authMiddleware, async (req, res) => {
  const nestId = String((req.body && req.body.nestId) || '');
  const missionId = String((req.body && req.body.missionId) || '');
  if (!nestId || !missionId) return res.status(400).json({ error: 'nestId und missionId erforderlich.' });

  const g = loadOrInitGalaxy();
  const liste = nestListe(g);
  const nest = liste.find(n => n.id === nestId);
  const save = astLeseSave(req.userId);
  if (!save) return res.status(403).json({ error: 'Kein gespeicherter Spielstand - erst speichern, dann angreifen.' });
  const mission = nestFindeMission(save, missionId, nestId);
  if (!mission || !mission.composition) {
    return res.status(403).json({ error: 'Zu diesem Angriff ist keine Flotte im gespeicherten Spielstand unterwegs.' });
  }
  if (mission.endTime && mission.endTime > Date.now()) {
    return res.status(400).json({ error: 'Deine Flotte ist noch unterwegs.', unterwegs: true });
  }

  /* Das Nest ist weg - gefallen oder weitergezogen. Beides ist KEIN Fehler des Spielers, also
     kostet es ihn auch nichts: kein Schaden, keine Verluste, keine Abklingzeit. Die Flotte kommt
     vollzaehlig zurueck, und die Antwort sagt WARUM. Ein stilles "ok" waere hier die
     Falschaussage, vor der das ganze Projekt seine Anzeigestellen schuetzt. */
  if (!nest) {
    return res.status(200).json({ ok: true, verpasst: true, grund: 'gefallen',
      text: 'Das Nest war bei der Ankunft bereits zerstört - dein Verband kehrt vollzählig zurück.' });
  }
  if (mission.system && nest.sys !== mission.system) {
    return res.status(200).json({ ok: true, verpasst: true, grund: 'weitergezogen', neuesSystem: nest.sys,
      text: 'Der Schwarm ist weitergezogen - dein Verband findet bei ' + mission.system + ' nichts mehr vor und kehrt zurück.' });
  }

  const jetzt = Date.now();
  nest.schlaege = nest.schlaege || {};
  const letzter = nest.schlaege[req.userId] || 0;
  if (letzter && jetzt - letzter < NEST_ABKLING_MS) {
    return res.status(403).json({ error: 'Deine Verbände haben dieses Nest erst vor Kurzem beschossen - der nächste Schlag ist in ' +
      Math.ceil((letzter + NEST_ABKLING_MS - jetzt) / 60000) + ' Minuten möglich.', abklingzeit: true });
  }

  const kraft = computeAttackPowerFromComposition(save, mission.composition, 0);
  if (!(kraft > 0)) return res.status(400).json({ error: 'Diese Flotte trägt keine Kampfkraft.' });
  const erg = nestSchlagAusfuehren(g, nest, kraft, mission.composition,
    [{ userId: req.userId, name: req.username || 'Kommandant', gewicht: 1 }], jetzt);
  // Dieselbe Messung wie bei der Festung. Sie steht hier und nicht im gemeinsamen Kern:
  // Der Kern bedient auch den VERBAND, und dort sagt der Ausloesezeitpunkt ueber den
  // Ausloeser nichts - die Flotte steht seit dem Beitritt fest.
  if (!letzter && nest.seit) reaktionVermerken(findUserById(req.userId), 'nest', (jetzt - nest.seit) / 1000);

  /* Aus der Quote werden hier - und NUR hier - konkrete Verluste: Der Einzelangreifer hat genau
     eine Zusammensetzung, der Verband hat viele und bekommt deshalb die Quote selbst. */
  const eigeneVerluste = {};
  for (const [typ, n] of Object.entries(mission.composition)) {
    if (typeof n !== 'number' || n <= 0) continue;
    const weg = Math.min(n, Math.round(n * erg.quote));
    if (weg > 0) eigeneVerluste[typ] = weg;
  }
  const { schaden, gefallen, trifftSchwaeche, schwarmGefallen, mitgerissen } = erg;
  const meinAnteil = erg.anteile[req.userId] || 0;
  const teilnehmer = erg.teilnehmer;
  console.log('[nest-angriff] userId=' + req.userId + ' nest=' + nestId + ' volk=' + nest.volk +
    ' stufe=' + (erg.stufe === null ? 'gefallen' : erg.stufe) + ' schwaeche=' + trifftSchwaeche + ' schaden=' + schaden +
    ' lp=' + (gefallen ? 'gefallen' : erg.lp) + '/' + erg.lpMax +
    (schwarmGefallen ? ' SCHWARM ZERFALLEN (+' + mitgerissen + ')' : ''));
  await saveDb();
  res.json({
    ok: true, schaden, gefallen,
    trifftSchwaeche, schwaeche: erg.schwaeche,
    lp: erg.lp, lpMax: erg.lpMax,
    stufe: erg.stufe, stufeName: erg.stufeName,
    volk: nest.volk, volkName: erg.volkName,
    eigeneVerluste,
    anteil: gefallen ? Math.round(meinAnteil * 1000) / 1000 : 0,
    teilnehmer: gefallen ? teilnehmer : Object.keys(nest.beitraege).length,
    schwarmGefallen, mitgerissen,
    naechsterSchlagAb: jetzt + NEST_ABKLING_MS
  });
});

app.post('/api/deploy-webhook', (req, res) => {
  if (!verifyGithubSignature(req)) {
    console.warn('Deploy-Webhook: ungültige oder fehlende Signatur, Anfrage abgelehnt.');
    return res.status(401).json({ error: 'invalid signature' });
  }
  const repoName = req.body && req.body.repository && req.body.repository.name;
  const ziel = DEPLOY_TARGETS[repoName];
  if (!ziel) {
    console.warn('Deploy-Webhook: unbekanntes Repo im Payload:', repoName);
    return res.status(400).json({ error: 'unknown repo' });
  }
  // Sofort antworten, git pull läuft asynchron im Hintergrund weiter - GitHub erwartet eine
  // schnelle Antwort und markiert den Webhook sonst als fehlgeschlagen.
  res.json({ ok: true, repo: repoName });
  starteDeploy(repoName, ziel.command, ziel.dir);
});

// ===== Ko-fi-Spenden: Top-Unterstützer im Spiel anzeigen =====
// Ko-fi schickt bei jeder Zahlung einen Webhook als application/x-www-form-urlencoded mit einem
// Feld "data", das JSON als String enthält - braucht deshalb eine eigene, auf diese Route
// beschränkte urlencoded-Middleware (die App nutzt global sonst nur express.json()). Der
// verification_token im Payload (aus ko-fi.com/manage/webhooks, Bereich "Advanced") wird zeitkonstant
// gegen KOFI_VERIFICATION_TOKEN geprüft - ohne gültigen, passenden Token wird jede Anfrage verworfen,
// damit niemand gefälschte Spenden einschleusen und sich so an die Spitze der Rangliste schummeln
// kann. Anonyme Spenden (is_public:false) zählen zur Gesamtsumme, werden aber NIE mit Namen
// gespeichert oder angezeigt - respektiert die Anonymitäts-Wahl der Spender aus Ko-fi.
const KOFI_VERIFICATION_TOKEN = process.env.KOFI_VERIFICATION_TOKEN || '';
function verifyKofiToken(given) {
  if (!KOFI_VERIFICATION_TOKEN) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(KOFI_VERIFICATION_TOKEN);
  try { return a.length === b.length && crypto.timingSafeEqual(a, b); } catch (e) { return false; }
}
// Ein Eintrag in db.kofiSupporters. Die ALTE Form war eine nackte Zahl unter dem Namen als
// Schlüssel, die neue ein { name, total } unter dem kleingeschriebenen Namen. Diese Funktion liest
// beide - so ist kein Datenverlust möglich, falls die Zusammenführung unten je übersprungen wird.
function kofiSupporterRec(v, key) {
  if (typeof v === 'number') return { name: key || '', total: v };
  if (v && typeof v === 'object') return { name: v.name || key || '', total: Number(v.total) || 0 };
  return { name: key || '', total: 0 };
}
// Einmalige Zusammenführung beim Serverstart: Was durch die frühere Groß-/Kleinschreibung auf zwei
// Einträge aufgeteilt wurde, wird addiert. Ohne diesen Schritt blieben bereits entstandene
// Doppeleinträge für immer getrennt - der Fehler ist behoben, seine Spuren wären geblieben.
function kofiSupporterMigration() {
  const alt = db.kofiSupporters;
  if (!alt || !Object.keys(alt).length) return;
  const braucht = Object.entries(alt).some(([k, v]) => typeof v === 'number' || k !== k.toLowerCase());
  if (!braucht) return;
  const neu = {};
  for (const [k, v] of Object.entries(alt)) {
    const rec = kofiSupporterRec(v, k);
    const key = (rec.name || k).toLowerCase();
    const bisher = neu[key];
    neu[key] = { name: rec.name || k, total: (bisher ? bisher.total : 0) + rec.total };
  }
  const vorher = Object.keys(alt).length, nachher = Object.keys(neu).length;
  db.kofiSupporters = neu;
  console.log('[kofi-migration] Unterstützer-Namen vereinheitlicht: ' + vorher + ' Einträge -> ' + nachher +
    (vorher !== nachher ? ' (' + (vorher - nachher) + ' Doppeleintrag/Doppeleinträge zusammengeführt)' : ''));
  saveDb();
}

app.post('/api/kofi-webhook', express.urlencoded({ extended: true, limit: '256kb' }), (req, res) => {
  // Sofort antworten, wie beim Deploy-Webhook - Ko-fi erwartet eine schnelle Antwort und markiert
  // den Webhook sonst als fehlgeschlagen. Die eigentliche Verarbeitung läuft danach.
  res.json({ ok: true });
  try {
    if (!req.body || !req.body.data) return;
    const payload = JSON.parse(req.body.data);
    if (!verifyKofiToken(payload.verification_token)) {
      console.warn('Ko-fi-Webhook: ungültiger oder fehlender verification_token, Anfrage verworfen.');
      return;
    }
    const amount = parseFloat(payload.amount);
    if (!isFinite(amount) || amount <= 0) return;
    if (!db.kofiSupporters) db.kofiSupporters = {};
    if (payload.is_public && payload.from_name) {
      // ===== Der Schlüssel wird kleingeschrieben, der Anzeigename nicht (05.08.2026) =====
      // Elf Zeilen tiefer wird die E-Mail sauber mit .trim().toLowerCase() normalisiert, der Name
      // hier bisher nur mit .trim(). Bei Gast-Zahlungen ohne Ko-fi-Konto tippt der Zahler seinen
      // Namen jedes Mal neu ein - "Max Mustermann" und "max mustermann" landeten deshalb unter zwei
      // Schlüsseln und ihre Summen addierten sich nicht. Folge: Der Kasten "Aktueller
      // Top-Unterstützer" nennt eine zu kleine Summe und kann bei mehreren Spendern den Falschen an
      // die Spitze setzen, weil der wahre Spitzenreiter auf zwei Einträge aufgeteilt ist.
      // Abzeichen und Medaillenstufe waren davon NICHT betroffen (die hängen an der E-Mail).
      //
      // Der Anzeigename wird bewusst mit der ZULETZT gesehenen Schreibweise überschrieben - so
      // gewinnt die aktuellste Eingabe des Spenders, statt dass die erste für immer festklebt.
      const name = String(payload.from_name).trim().slice(0, 60) || 'Anonym';
      const key = name.toLowerCase();
      const rec = kofiSupporterRec(db.kofiSupporters[key]);
      db.kofiSupporters[key] = { name, total: rec.total + amount };
    } else {
      db.kofiSupportersAnonymousTotal = (db.kofiSupportersAnonymousTotal || 0) + amount;
    }
    // Unterstützer-Kennzeichnung in der Bestenliste (20.07.2026, Spieler-Wunsch, Verknüpfung C
    // "E-Mail-Verifizierung"): Ko-fi schickt bei JEDER Zahlung eine E-Mail mit, unabhängig von der
    // öffentlich/anonym-Einstellung des Namens - das ist die zuverlässige, nicht fälschbare
    // Verknüpfung zu einem Spiel-Account (der Kommandantenname wäre frei wählbar und damit
    // nachbaubar durch Umbenennen, siehe /api/claim-supporter unten). Wird NIRGENDS öffentlich
    // ausgegeben, nur intern für den Abgleich beim Freischalten genutzt. total treibt die
    // Medaillen-Stufe (siehe supporterTierFor).
    const email = String(payload.email || '').trim().toLowerCase();
    if (email) {
      if (!db.kofiDonationsByEmail) db.kofiDonationsByEmail = {};
      const rec = db.kofiDonationsByEmail[email] || { total: 0, lastDonationAt: 0 };
      rec.total += amount;
      rec.lastDonationAt = Date.now();
      db.kofiDonationsByEmail[email] = rec;
      // Höchstmarke für die Meilenstein-Embleme gleich hier festhalten (17.08.2026). Sie ließe sich
      // zwar aus rec.total ableiten - aber nur solange die E-Mail mit diesem Konto verknüpft
      // BLEIBT. Wird sie später gelöst oder geändert, wäre die Historie weg und ein Emblem, das
      // "hat unterstützt" sagt, verschwände wieder. Deshalb zusätzlich am Konto selbst.
      const spenderKonto = Object.values(db.users).find(u => u.kofiEmail === email);
      if (spenderKonto) spenderStufeJeFortschreiben(spenderKonto, supporterTierFor(rec.total));
    } else {
      // ===== Spende ohne E-Mail (05.08.2026, Spieler-Report über Sascha) =====
      //
      // GEMESSEN AUF DEM PI: db.kofiDonationsByEmail hatte 0 Einträge, db.kofiSupporters 2 Namen.
      // Beide entstehen in DIESEM Handler, wenige Zeilen auseinander - der Name wurde also verbucht,
      // die E-Mail nie. Der `if (email)` darüber wurde kein einziges Mal betreten. Folge: Niemand
      // konnte je das Unterstützer-Abzeichen bekommen, obwohl die Spende ankam und in der
      // Unterstützer-Box erschien. Aufgefallen ist es erst, weil ein Spender (lumekx) in der Box
      // stand, in der Bestenliste aber keine Tasse trug.
      //
      // Der Fehler war nicht die fehlende E-Mail, sondern dass NICHTS es gemeldet hat: Der Zweig
      // fiel still durch, und beide Hälften derselben Spende widersprachen sich, ohne dass es je
      // irgendwo auftauchte. Seit dem 05.08.2026 hängen zudem drei Spielfunktionen am Rang - eine
      // stille Lücke kostet einen Spender jetzt Funktionen, für die er bezahlt hat.
      //
      // WARUM NICHT EINFACH ÜBER DEN NAMEN VERKNÜPFEN: Der Kommandantenname ist frei wählbar. Wer
      // sich in "lumekx" umbenennt, bekäme dessen Rang. Genau deshalb fiel die Wahl damals auf die
      // E-Mail. Die Zuordnung bleibt deshalb eine bewusste Entscheidung eines Menschen - der Server
      // legt sie nur vor.
      //
      // `felder` speichert ausschließlich die NAMEN der vom Webhook gelieferten Felder, nie deren
      // Inhalte. Das beantwortet beim nächsten Fall in einem Blick, ob Ko-fi das Feld überhaupt
      // schickt und wie es heißt - ohne irgendwelche personenbezogenen Daten aufzubewahren.
      // Der Spendername wird NUR bei öffentlichen Spenden übernommen; bei anonymen bleibt er leer,
      // wie überall sonst in dieser Datei auch.
      if (!db.kofiUnlinked) db.kofiUnlinked = [];
      db.kofiUnlinked.unshift({
        id: crypto.randomUUID(),
        at: Date.now(),
        name: (payload.is_public && payload.from_name) ? String(payload.from_name).trim().slice(0, 60) : null,
        amount,
        currency: String(payload.currency || '').slice(0, 8),
        type: String(payload.type || '').slice(0, 32),
        felder: Object.keys(payload || {}).slice(0, 40)
      });
      db.kofiUnlinked = db.kofiUnlinked.slice(0, 200);
      console.warn('[kofi-ohne-email] Spende über ' + amount + ' ' + (payload.currency || '') +
        ' verbucht, aber OHNE E-Mail - der Unterstützer-Rang lässt sich nicht automatisch zuordnen.' +
        ' Gelieferte Felder: ' + Object.keys(payload || {}).join(',') +
        ' | Zuordnung von Hand im Admin-Bereich unter "Unterstützer".');
    }
    saveDb();
    console.log('Ko-fi-Webhook verarbeitet: ' + (payload.type || 'Zahlung') + ' über ' + amount + ' ' + (payload.currency || '') + (payload.is_public ? ' von ' + payload.from_name : ' (anonym)'));
  } catch (e) { console.error('Ko-fi-Webhook Fehler:', e.message); }
});
// Öffentlicher, unauthentifizierter Endpunkt - liefert NUR den Namen und Gesamtbetrag des aktuellen
// Top-Unterstützers, keine sensiblen Daten wie E-Mail oder einzelne Zahlungen.
app.get('/api/kofi-top-supporter', (req, res) => {
  const supporters = db.kofiSupporters || {};
  const entries = Object.entries(supporters).map(([k, v]) => kofiSupporterRec(v, k));
  if (!entries.length) return res.json({ topSupporter: null });
  entries.sort((a, b) => b.total - a.total);
  res.json({ topSupporter: { name: entries[0].name, total: Math.round(entries[0].total * 100) / 100 } });
});
// Unterstützer-Abzeichen (20.07.2026, Spieler-Wunsch "farblich/mit Medaille kennzeichnen", Verknüpfung
// C "E-Mail-Verifizierung"): bewusst zeitlich befristet (30 Tage ab der letzten Spende) statt
// dauerhaft - ein einzelner Kaffee vor einem Jahr soll nicht für immer ein Abzeichen tragen,
// regelmäßige Unterstützer bleiben durchgehend markiert, da jede neue Spende das Fenster verlängert
// (lastDonationAt wird beim Webhook überschrieben, nicht addiert). Die Stufe (Bronze/Silber/Gold,
// siehe supporterTierFor) ergibt sich aus der GESAMTSUMME aller Spenden dieser E-Mail, nicht nur der
// letzten - ein früherer großzügiger Spender behält seine Stufe auch bei einer kleinen Folgespende.
const SUPPORTER_BADGE_DAYS = 30;
function supporterTierFor(total) {
  if (total >= 50) return 'gold';
  if (total >= 15) return 'silver';
  return 'bronze';
}
function supporterStatusFor(userId) {
  const user = findUserById(userId);
  if (!user || !user.kofiEmail) return { active: false };
  const rec = (db.kofiDonationsByEmail || {})[user.kofiEmail];
  if (!rec) return { active: false };
  const ageDays = (Date.now() - rec.lastDonationAt) / 86400000;
  return { active: ageDays <= SUPPORTER_BADGE_DAYS, lastDonationAt: rec.lastDonationAt, tier: supporterTierFor(rec.total) };
}
// ===== Unterstützer-Funktionen (05.08.2026) =====
// Die drei Automatiken im Verteidigung-Tab (Automatische Verstärkung, Automatische Reparatur,
// KI-Abfangautomatik) sind seit heute an den Unterstützer-Rang gebunden. Die Entscheidung fällt
// HIER und nicht im Frontend: `state` liegt beim Spieler und ist frei bearbeitbar, das
// Spendenverzeichnis liegt nur hier. Das Frontend liest die Antwort von /api/me und richtet
// ausschließlich die Anzeige danach.
//
// Die Ausnahme ist namentlich und bewusst hart verdrahtet: Der Betreiber des Spiels braucht die
// Automatiken zum Prüfen, ohne an sich selbst zu spenden. Sie hängt am Benutzernamen, weil
// Benutzernamen eindeutig vergeben werden - der echte Name ist damit belegt und niemand kann ihn
// sich nachträglich zulegen (Groß-/Kleinschreibung wird ignoriert, siehe Vergleich unten).
const SUPPORTER_EXEMPT_USERNAMES = ['gamegeeeeek'];
// ===== Manuell vergebener Unterstützer-Rang (05.08.2026) =====
// Zweiter Weg zum Rang neben der Ko-fi-Spende: Der Admin kann ihn direkt vergeben - für Spenden,
// die außerhalb von Ko-fi ankamen (Überweisung, bar, Sachleistung), für Fehlerfälle bei der
// E-Mail-Zuordnung und als Dankeschön. Bewusst BEFRISTET wie die gespendete Variante, sonst wäre
// er eine dauerhafte Sonderklasse, die niemand mehr überblickt. Ein zweiter Aufruf verlängert
// nicht, sondern SETZT NEU - das ist beim Korrigieren eines Vertippers das erwartete Verhalten.
const SUPPORTER_GRANT_DAYS = [30, 60, 90];
function supporterGrantActive(user) { return !!(user && (user.supporterGrantUntil || 0) > Date.now()); }
// Der RANG (Abzeichen in der Bestenliste): Spende oder manuelle Vergabe. Die gamegeeeeek-Ausnahme
// gehört hier ausdrücklich NICHT hinein - sie schaltet Funktionen frei, sie ist keine Spende, und
// ein Abzeichen dafür wäre schlicht unwahr.
function supporterStatusCombined(userId) {
  const st = supporterStatusFor(userId);
  if (st.active) return st;
  const user = findUserById(userId);
  if (supporterGrantActive(user)) {
    return { active: true, lastDonationAt: 0, tier: user.supporterGrantTier || 'bronze', granted: true, until: user.supporterGrantUntil };
  }
  return { active: false };
}
// ===== Die HÖCHSTE JE ERREICHTE Spender-Stufe (17.08.2026) =====
// Grundlage der Meilenstein-Embleme, und die einzige Größe im Unterstützer-Bereich, die bewusst
// NIE abläuft. Der Gedanke ist derselbe wie beim wachstumsbegrenzten `addReport`: Wer aufhört zu
// spenden, verliert die laufenden Vorteile - aber nicht die Auszeichnung dafür, dass er es getan
// hat. Ein Ehrenzeichen, das beim Ablauf verschwindet, bestraft das Aufhören statt das
// Unterstützen, und der Betroffene merkt es erst, wenn er nachsehen will.
//
// Die Datenbasis lag längst da und musste nur richtig gelesen werden: `rec.total` im
// Spendenverzeichnis wird beim Webhook ADDIERT (`rec.total += amount`), wächst also monoton und
// schrumpft nie. `supporterTierFor(rec.total)` OHNE die 30-Tage-Prüfung ist damit exakt die
// höchste je erreichte Stufe. Was abläuft, ist ausschließlich das `active`-Flag.
//
// ES REICHT ABER NICHT, das nur ABZULEITEN - und das hat der Test bewiesen, nicht die Überlegung.
// Der erste Entwurf las die Stufe bei jedem Aufruf frisch aus Spendensumme und laufendem Rang
// zusammen. Damit war sie NICHT monoton, sondern nur meistens:
//   - Ein von Hand vergebener Rang aus der Zeit vor dieser Änderung hat keine Historie. Läuft er
//     ab, war die Stufe "nie erreicht" - gemessen im HTTP-Test: das Emblem fiel aus dem Besitz,
//     wurde aber weiter GETRAGEN (der Lesepfad prüft unbefristete Bedingungen ja nicht erneut).
//     Genau der Zustand, vor dem der Kopfkommentar zu kosmetikBefristet warnt.
//   - Dieselbe Lücke bei einer gelösten oder geänderten Ko-fi-Adresse: Die Spendensumme hängt an
//     `user.kofiEmail`; ist die weg, ist die Historie weg.
// Deshalb wird die Höchstmarke PERSISTIERT statt abgeleitet: `supporterStufeJeMax` steigt nur und
// wird überall dort fortgeschrieben, wo der Server einen Rang tatsächlich BEOBACHTET (Spende,
// Vergabe, und bei jedem /api/me für den Altbestand). Abgeleitet wird nur noch zusätzlich aus der
// Spendensumme - die ist von sich aus monoton und deckt den Fall ab, dass jemand seit der
// Umstellung gespendet, sich aber nie wieder angemeldet hat.
function spenderStufeJeFortschreiben(user, stufe) {
  if (!user || !stufe) return false;
  if ((KOSMETIK_STUFEN_RANG[stufe] || 0) <= (KOSMETIK_STUFEN_RANG[user.supporterStufeJeMax] || 0)) return false;
  user.supporterStufeJeMax = stufe;
  return true;
}
function spenderStufeJeErreicht(userId) {
  const user = findUserById(userId);
  if (!user) return null;
  let rang = 0;
  const nimm = (stufe) => { const r = KOSMETIK_STUFEN_RANG[stufe] || 0; if (r > rang) rang = r; };
  const rec = user.kofiEmail ? (db.kofiDonationsByEmail || {})[user.kofiEmail] : null;
  if (rec && rec.total > 0) nimm(supporterTierFor(rec.total));
  if (user.supporterStufeJeMax) nimm(user.supporterStufeJeMax);
  return rang ? (Object.keys(KOSMETIK_STUFEN_RANG).find(k => KOSMETIK_STUFEN_RANG[k] === rang) || null) : null;
}
// ===== Testphase (15.08.2026) =====
// Dritter Weg zur FUNKTIONSFREIGABE - und der einzige, der nichts kostet. Wer die
// Unterstützer-Funktionen noch nie hatte, schaltet sie einmalig für SUPPORTER_TRIAL_DAYS Tage frei
// und sieht, was sie ihm bringen. Ein Beschreibungstext leistet das nachweislich nicht: Die drei
// Automatiken erklären sich erst, wenn sie einmal von selbst zur richtigen Sekunde eingegriffen
// haben - genau dann, wenn man gerade nicht im Spiel war.
//
// Drei Eigenschaften sind bewusst so und nicht anders:
//  - EINMALIG je Konto. `supporterTrialAt` bleibt nach Ablauf für immer stehen und ist das
//    Verbrauchszeichen; abgefragt wird NIE `supporterTrialUntil` (das liegt nach Ablauf in der
//    Vergangenheit und würde die Testphase wieder freigeben - aus einer Testphase wäre damit ein
//    Dauerabo mit Klickzwang geworden).
//  - KEIN Abzeichen. Die Testphase steht deshalb hier in supporterFeaturesFor und NICHT in
//    supporterStatusCombined - dieselbe Trennung wie bei der gamegeeeeek-Ausnahme und aus demselben
//    Grund: ein Abzeichen für eine Unterstützung, die es nie gab, wäre schlicht unwahr. Aus dem
//    gleichen Grund bleibt `tier` null; die Stufe gehört zur Spendensumme.
//  - Sie VERLÄNGERT nichts. Wer bereits Rang hat, kann sie starten, ohne etwas zu verlieren, aber
//    sie schiebt kein aktives Fenster nach hinten - beide Fenster laufen unabhängig, und
//    supporterFeaturesFor meldet immer das SPÄTER endende (siehe `until` unten).
const SUPPORTER_TRIAL_DAYS = 5;
function supporterTrialActive(user) { return !!(user && (user.supporterTrialUntil || 0) > Date.now()); }
// Die FUNKTIONSFREIGABE (die Unterstützer-Automatiken): Rang, Ausnahme oder laufende Testphase.
function supporterFeaturesFor(userId) {
  const user = findUserById(userId);
  const name = String((user && user.username) || '').trim().toLowerCase();
  // Ob die Testphase noch zu HABEN ist, gehört in JEDE Antwort - auch in die eines aktiven
  // Unterstützers. Sonst müsste das Frontend aus "aktiv" schließen, sie sei verbraucht, und würde
  // sie einem Spender nach Ablauf seiner Spende fälschlich als schon genutzt anzeigen.
  const trialUsedAt = (user && user.supporterTrialAt) || 0;
  const trialUntil = (user && user.supporterTrialUntil) || 0;
  const trialAktiv = supporterTrialActive(user);
  const trial = { verfuegbar: !trialUsedAt, genutztAm: trialUsedAt, aktiv: trialAktiv, bis: trialUntil, tage: SUPPORTER_TRIAL_DAYS };
  if (SUPPORTER_EXEMPT_USERNAMES.indexOf(name) !== -1) return { active: true, tier: 'gold', exempt: true, until: 0, quelle: 'betreiber', trial };
  const st = supporterStatusCombined(userId);
  if (!st.active) {
    if (trialAktiv) return { active: true, tier: null, exempt: false, until: trialUntil, quelle: 'testphase', trial };
    return { active: false, tier: null, exempt: false, until: 0, quelle: null, trial };
  }
  const rangUntil = st.granted ? st.until : ((st.lastDonationAt || 0) + SUPPORTER_BADGE_DAYS * 86400000);
  return {
    active: true, tier: st.tier || 'bronze', exempt: false, granted: !!st.granted,
    // Das SPÄTER endende der beiden Fenster - eine laufende Testphase darf einen Rang nicht
    // verkürzen und umgekehrt (siehe Kommentar oben, dritte Eigenschaft).
    until: Math.max(rangUntil, trialAktiv ? trialUntil : 0),
    quelle: st.granted ? 'vergeben' : 'kofi', trial
  };
}
// Testphase starten. Einmalig je Konto, ohne Admin, ohne Zahlung - der einzige Selbstbedienungsweg
// zu den Unterstützer-Funktionen. Bewusst als eigene Route und nicht als Nebenwirkung von /api/me:
// Sie soll ein bewusster Klick des Spielers sein, kein stiller Verbrauch beim Vorbeischauen.
app.post('/api/supporter/trial', authMiddleware, async (req, res) => {
  const user = findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'Account nicht gefunden.' });
  if (user.supporterTrialAt) {
    return res.status(409).json({ error: 'Die Testphase wurde für dieses Konto bereits genutzt.', genutztAm: user.supporterTrialAt, bis: user.supporterTrialUntil || 0 });
  }
  const jetzt = Date.now();
  user.supporterTrialAt = jetzt;
  user.supporterTrialUntil = jetzt + SUPPORTER_TRIAL_DAYS * 86400000;
  await saveDb();
  res.json({ ok: true, tage: SUPPORTER_TRIAL_DAYS, bis: user.supporterTrialUntil, supporter: supporterFeaturesFor(req.userId) });
});

// ===== Sternenstaub (15.08.2026): die Währung für Kosmetik =====
//
// WARUM SIE NUR AUS ZWEI QUELLEN KOMMT - und warum die naheliegenden fehlen
// ------------------------------------------------------------------------
// Der erste Entwurf sah Tagesaufgaben und Wochenliga als Quellen vor. Das wäre eine Währung
// gewesen, die nur so AUSSIEHT, als läge sie sicher auf dem Server: Beide Größen stehen im
// Spielstand, und der ist bauartbedingt klientenautoritativ. "Ich habe meine Tagesaufgabe erledigt"
// kann der Server so wenig nachprüfen wie "ich habe 10^9 Erz" - er würde eine gemeldete Zahl
// entgegennehmen und feierlich in sein eigenes Konto schreiben. Damit wäre die ganze serverseitige
// Verankerung der Kosmetik über den Umweg der Währung wieder offen.
//
// Es zählt deshalb nur, was der Server SELBST beobachtet:
//   1. Die tägliche Anmeldung. Der Zeitstempel entsteht hier, nicht im Spielstand.
//   2. Ein ABGEWEHRTER Spielerangriff. /api/attack löst den Kampf serverseitig auf; der
//      Verteidiger kann ihn weder auslösen noch sein Ergebnis beeinflussen.
//
// Gegen die offensichtliche Absprache (zwei Konten, eines greift immer wieder an und verliert)
// stehen zwei Grenzen: je Angreifer zählt höchstens EIN abgewehrter Angriff pro Tag, und insgesamt
// höchstens STAUB_ABWEHR_MAX_PRO_TAG. Das macht Absprache nicht unmöglich, aber unlohnend - mehr
// als der ehrliche Tagesertrag springt dabei nicht heraus.
const STAUB_ANMELDUNG = 5;
const STAUB_SERIE_BONUS = 1;          // je Tag Serie zusätzlich
const STAUB_SERIE_MAX = 5;            // Deckel des Serienbonus -> 5..10 je Tag
const STAUB_ABWEHR = 3;
const STAUB_ABWEHR_MAX_PRO_TAG = 3;   // verschiedene Angreifer je Tag
function staubTagesschluessel(zeit) { return new Date(zeit || Date.now()).toISOString().slice(0, 10); }
// Wochenschlüssel nach ISO-8601 in UTC (Montag als Wochenanfang).
//
// ER IST NICHT DERSELBE WIE DER DES SPIELS, und das ist Absicht: `weekKeyOf()` im Frontend bildet
// den lokalen Montag als Datum ab ("2026-08-10"), rechnet also in der Zeitzone des Spielers. Der
// Server kennt die nicht - er kann diese Grenze grundsätzlich nicht nachbilden, und ein aus der
// Client-Uhr gemeldeter Wochenschlüssel wäre wieder eine Angabe, die sich frei setzen lässt.
// Bei UTC+2 laufen die beiden Grenzen also rund zwei Stunden auseinander.
//
// Tragbar ist das, weil diese Woche NUR eine Anzeige speist ("diese Woche verdient: 42") und an
// ihr keine Belohnung hängt: Der Sternenstaub selbst wird pro Tag und pro Angreifer gedeckelt, nicht
// pro Woche. Sollte hier je eine Wochenbelohnung drankommen, muss diese Entscheidung neu getroffen
// werden - dann wäre die Abweichung ein echter Unterschied und keine Fußnote mehr.
function staubWochenschluessel(zeit) {
  const d = new Date(zeit || Date.now());
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Donnerstag derselben Woche bestimmt das Jahr (ISO-Regel), sonst zählt die Jahreswechsel-Woche
  // je nach Wochentag zum falschen Jahr.
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const jahresanfang = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const woche = Math.ceil(((t - jahresanfang) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + '-W' + String(woche).padStart(2, '0');
}
function staubKonto(user) {
  // abwehrGesamt (18.08.2026): der KUMULATIVE Zähler abgewehrter Spielerangriffe. Er ist neu und
  // beginnt für JEDES Konto bei 0 - auch für ein altes mit langer Abwehrbilanz. Das ist Absicht
  // und keine Nachlässigkeit: Die einzige vorhandene Historie steht als `pvpDefended` im
  // SPIELSTAND, und der ist klientenautoritativ. Wer sie als Startwert übernähme, importierte
  // eine Zahl, die sich in fünf Sekunden fälschen lässt - und hinge damit ausgerechnet die
  // Kosmetik daran, also die Fläche, die allen gemeinsam gehört. Dieselbe Entscheidung wie beim
  // Sternenstaub selbst, der ebenfalls nicht rückwirkend gutgeschrieben wurde.
  if (!user.staub) user.staub = { menge: 0, serie: 0, letzterTag: null, abwehrTag: null, abwehrVon: [], abwehrGesamt: 0 };
  return user.staub;
}
// Jede Gutschrift läuft hier durch. EINE Stelle, damit die Wochensumme nicht an einer der beiden
// Quellen vorbeigezählt werden kann - genau der Fehler, den eine zweite Additionsstelle macht.
function staubGutschreiben(k, menge) {
  if (!(menge > 0)) return 0;
  k.menge += menge;
  const w = staubWochenschluessel();
  if (!k.woche || k.woche.key !== w) k.woche = { key: w, menge: 0 };
  k.woche.menge += menge;
  return menge;
}
// Tagesgutschrift für die Anmeldung. Idempotent über den Tagesschlüssel: Ein zweiter Aufruf am
// selben Tag tut nichts, egal wie oft das Spiel /api/me aufruft.
// Rückgabe: die gutgeschriebene Menge (0 = heute schon geschehen).
function staubAnmeldungGutschreiben(user) {
  if (!user) return 0;
  const k = staubKonto(user);
  const heute = staubTagesschluessel();
  if (k.letzterTag === heute) return 0;
  // Serie: nur ein LÜCKENLOS folgender Tag verlängert sie. Ein ausgelassener Tag setzt auf 1
  // zurück, nicht auf 0 - der heutige Tag zählt ja bereits.
  const gestern = staubTagesschluessel(Date.now() - 86400000);
  k.serie = (k.letzterTag === gestern) ? Math.min(k.serie + 1, STAUB_SERIE_MAX) : 1;
  const menge = STAUB_ANMELDUNG + (k.serie - 1) * STAUB_SERIE_BONUS;
  staubGutschreiben(k, menge);
  k.letzterTag = heute;
  return menge;
}
// Gutschrift für einen abgewehrten Angriff. `angreiferId` wird mitgeführt, damit derselbe Gegner
// nicht mehrfach am Tag zählt.
function staubAbwehrGutschreiben(user, angreiferId) {
  if (!user) return 0;
  const k = staubKonto(user);
  const heute = staubTagesschluessel();
  if (k.abwehrTag !== heute) { k.abwehrTag = heute; k.abwehrVon = []; }
  if (k.abwehrVon.length >= STAUB_ABWEHR_MAX_PRO_TAG) return 0;
  if (k.abwehrVon.indexOf(angreiferId) !== -1) return 0;
  k.abwehrVon.push(angreiferId);
  // Der kumulative Zähler steht BEWUSST hinter denselben zwei Riegeln wie die Gutschrift, nicht
  // davor: Er zählt also nur, was auch Sternenstaub bringt - höchstens STAUB_ABWEHR_MAX_PRO_TAG
  // Angriffe je Tag und je Angreifer nur einen. Ein Zähler ohne diese Riegel wäre über abgesprochene
  // Angriffe beliebig hochzutreiben, und daran hängt eine Kosmetik in der Bestenliste.
  // Er wächst nur - `kosmetikBefristet` führt 'abgewehrt' deshalb zu Recht nicht.
  k.abwehrGesamt = (k.abwehrGesamt || 0) + 1;
  staubGutschreiben(k, STAUB_ABWEHR);
  return STAUB_ABWEHR;
}
function staubStand(user) {
  const k = staubKonto(user);
  const w = staubWochenschluessel();
  return {
    menge: k.menge || 0, serie: k.serie || 0,
    // Diese Woche verdient. Gehört zu einer ANDEREN Woche als der aktuellen, ist die Antwort 0 -
    // nicht der alte Stand: Der Zähler wird erst bei der nächsten Gutschrift zurückgesetzt, und bis
    // dahin würde er sonst die Vorwoche als "diese Woche" ausgeben.
    dieseWoche: (k.woche && k.woche.key === w) ? k.woche.menge : 0,
    heuteAngemeldet: k.letzterTag === staubTagesschluessel(),
    abwehrHeute: (k.abwehrTag === staubTagesschluessel()) ? k.abwehrVon.length : 0,
    // Reist mit, damit das Spiel den Fortschritt zur Verteidigungs-Kosmetik ANZEIGEN kann. Eine
    // Freischaltbedingung, deren Stand der Spieler nirgends sieht, ist eine Fläche, auf die er
    // hinspielt, ohne zu wissen, wie weit er ist.
    abwehrGesamt: k.abwehrGesamt || 0,
    saetze: {
      anmeldung: STAUB_ANMELDUNG, serieBonus: STAUB_SERIE_BONUS, serieMax: STAUB_SERIE_MAX,
      abwehr: STAUB_ABWEHR, abwehrMaxProTag: STAUB_ABWEHR_MAX_PRO_TAG
    }
  };
}

// ===== Kosmetik: Namensfarbe und Emblem (15.08.2026) =====
//
// WARUM DAS HIER LIEGT UND NICHT IM SPIELSTAND
// -------------------------------------------
// Der Spielstand ist bauartbedingt klientenautoritativ - wer sich Kredite geben will, braucht dafür
// keine Lücke. Bei Kosmetik ist die Lage aber eine andere, und zwar genau die, an der in diesem
// Projekt die Sicherheitsgrenze verläuft: Eine Namensfarbe steht in der BESTENLISTE, also auf einer
// Fläche, die allen gemeinsam gehört. "Ich habe mir selbst Erz gegeben" trifft niemanden außer den
// Spieler selbst; "ich trage die Goldspender-Farbe, ohne je gespendet zu haben" entwertet sie für
// alle, die dafür bezahlt haben. Besitz und Auswahl liegen deshalb hier.
//
// ZWEI STUFEN DER PRÜFUNG, UND WARUM ES ZWEI SIND
// ----------------------------------------------
// (a) Beim AUSRÜSTEN wird vollständig geprüft, inklusive der Fortschritts-Bedingungen. Das kostet
//     einmal das Einlesen des Spielstands - selten genug, um es sich zu leisten.
// (b) Beim LESEN (Bestenliste, jede Sekunde, von jedem) werden nur die BEFRISTETEN Bedingungen
//     erneut geprüft, also die Spender-Stufen. Der Spielstand wird dabei NICHT eingelesen; das wäre
//     ein mehrere hundert Kilobyte großer JSON.parse pro Bestenlisten-Zeile.
//     Das ist tragfähig, weil die Fortschritts-Bedingungen MONOTON sind: Prestige, Aufstiege,
//     Kampfpunkte und Rekordtiefe wachsen, sie schrumpfen nicht. Was beim Ausrüsten galt, gilt
//     später weiter. Eine Spende läuft dagegen ab - und genau dann muss die Farbe von selbst
//     verschwinden, ohne dass jemand aufräumt.
// Die gespeicherte Auswahl bleibt beim Ablauf bewusst STEHEN. Spendet derselbe Spieler später
// erneut, trägt er sofort wieder seine alte Farbe, ohne sie neu suchen zu müssen.
//
// Die Definitionen sind eine bewusste Kopie: Das Frontend kennt dieselben Schlüssel mit Aussehen
// und Beschreibungstext, hier stehen die Freischalt-Bedingungen. Das ist derselbe Fall wie
// SHIP_SCORE_WEIGHTS/computeScoreServer (siehe CLAUDE.md, "Backend hat teils eigene Kopien von
// Frontend-Formeln") - und wie dort wacht ein Test im Frontend-Repo darüber, dass die
// Schlüsselmengen nicht auseinanderlaufen (tests/test_kosmetik_paritaet.js).
const KOSMETIK_DEFS = [
  // --- Namensfarben ---
  { key: 'nf_standard',   art: 'namensfarbe', bedingung: { typ: 'immer' } },
  { key: 'nf_kupfer',     art: 'namensfarbe', bedingung: { typ: 'spender', stufe: 'bronze' } },
  { key: 'nf_silber',     art: 'namensfarbe', bedingung: { typ: 'spender', stufe: 'silver' } },
  { key: 'nf_gold',       art: 'namensfarbe', bedingung: { typ: 'spender', stufe: 'gold' } },
  { key: 'nf_asche',      art: 'namensfarbe', bedingung: { typ: 'prestige', wert: 1 } },
  { key: 'nf_glut',       art: 'namensfarbe', bedingung: { typ: 'prestige', wert: 5 } },
  { key: 'nf_leere',      art: 'namensfarbe', bedingung: { typ: 'aufstieg', wert: 1 } },
  { key: 'nf_stahl',      art: 'namensfarbe', bedingung: { typ: 'kampfpunkte', wert: 2000 } },
  { key: 'nf_tiefe',      art: 'namensfarbe', bedingung: { typ: 'abgrund', wert: 40 } },
  // --- Embleme ---
  { key: 'em_keins',      art: 'emblem',      bedingung: { typ: 'immer' } },
  { key: 'em_tasse',      art: 'emblem',      bedingung: { typ: 'spender', stufe: 'bronze' } },
  { key: 'em_komet',      art: 'emblem',      bedingung: { typ: 'spender', stufe: 'gold' } },
  { key: 'em_zirkel',     art: 'emblem',      bedingung: { typ: 'prestige', wert: 3 } },
  { key: 'em_aufstieg',   art: 'emblem',      bedingung: { typ: 'aufstieg', wert: 1 } },
  { key: 'em_klinge',     art: 'emblem',      bedingung: { typ: 'kampfpunkte', wert: 5000 } },
  { key: 'em_lot',        art: 'emblem',      bedingung: { typ: 'abgrund', wert: 60 } },
  // --- Für Sternenstaub zu kaufen (15.08.2026) ---
  // Der dritte Weg neben Fortschritt und Unterstützung, und der einzige, der jedem offensteht:
  // Sternenstaub kommt aus der täglichen Anmeldung und aus abgewehrten Angriffen. Die Preise sind
  // an den Tagesertrag gerechnet (5-10 aus der Anmeldung, bis 9 aus Abwehr): Das billigste Stück
  // ist nach wenigen Tagen erreichbar, das teuerste bleibt ein Ziel für ein paar Wochen.
  { key: 'nf_koralle',    art: 'namensfarbe', bedingung: { typ: 'kauf', preis: 40 } },
  { key: 'nf_nebel',      art: 'namensfarbe', bedingung: { typ: 'kauf', preis: 90 } },
  { key: 'nf_signal',     art: 'namensfarbe', bedingung: { typ: 'kauf', preis: 200 } },
  { key: 'em_ring',       art: 'emblem',      bedingung: { typ: 'kauf', preis: 60 } },
  { key: 'em_saat',       art: 'emblem',      bedingung: { typ: 'kauf', preis: 150 } },
  // --- Zwei weitere Fortschritts-Wege (16.08.2026) ---
  // Bis hierher hing der Fortschritts-Zweig allein an Prestige, Aufstieg, Kampfpunkten und
  // Rekordtiefe - also an den Größen der SPÄTEN Laufbahn. Wer sammelt oder Bosse jagt, statt zu
  // prestigen, hatte gar keinen Weg zu einem eigenen Stück. Erfolge (102 im Spiel) und besiegte
  // Sektor-Bosse schließen genau diese Lücke; beide wachsen monoton wie die übrigen und werden
  // deshalb ebenfalls nur beim Ausrüsten geprüft.
  { key: 'nf_chronik',    art: 'namensfarbe', bedingung: { typ: 'erfolge', wert: 25 } },
  { key: 'em_kranz',      art: 'emblem',      bedingung: { typ: 'erfolge', wert: 60 } },
  { key: 'nf_trophae',    art: 'namensfarbe', bedingung: { typ: 'bosse', wert: 10 } },
  { key: 'em_schaedel',   art: 'emblem',      bedingung: { typ: 'bosse', wert: 30 } },
  // --- PvE-Meilensteine (21.08.2026, Phase 6 der Asteroidenfestungen/Alien-Nester) ---
  // Der Katalog kannte bis hierher keinen einzigen Weg ueber die neuen PvE-Ziele. Beide Zaehler
  // liest der Server aus dem NUTZEROBJEKT (`pveKills`), nicht aus dem Spielstand - Begruendung
  // bei pveKillZaehlen. Sie wachsen nur, gehoeren also NICHT in kosmetikBefristet.
  //
  // Die Schwellen sind an der gemessenen Kampfdauer gerechnet, nicht geschaetzt: Eine Festung
  // braucht vier bis sieben Schlaege bei 6 h Abklingzeit, also ein bis zwei Tage fuer EINE. 25
  // Stueck sind damit ein Ziel ueber Wochen - vergleichbar mit em_schaedel (30 Sektor-Bosse).
  // Die Koenigin dagegen ZAEHLT NUR EINMAL, und das ist Absicht: Sie erscheint erst, wenn ein
  // Volk vier Nester beisammen hat, faellt mit 4 Mio LP praktisch nur im Verband, und reisst
  // dabei den ganzen Schwarm mit. Wer das einmal geschafft hat, hat die Aussage verdient.
  { key: 'em_festungsbrecher', art: 'emblem', bedingung: { typ: 'festungen', wert: 25 } },
  { key: 'em_schwarmbrecher',  art: 'emblem', bedingung: { typ: 'koeniginnen', wert: 1 } },
  // --- Meilenstein-Embleme (17.08.2026) ---
  // Die Gegenstücke zu em_tasse/em_komet, und der Unterschied ist der ganze Punkt: Jene tragen den
  // AKTUELLEN Rang und verschwinden, wenn er ausläuft. Diese hier bleiben. Sie sagen nicht
  // "unterstützt gerade", sondern "hat unterstützt" - eine Aussage, die nicht falsch werden kann
  // und die niemandem weggenommen werden sollte, weil er irgendwann aufhört.
  //
  // Drei Stufen, damit auch die kleine Spende ihr Zeichen bekommt; die Schwellen sind dieselben
  // wie bei supporterTierFor (Bronze ab der ersten Spende, Silber ab 15, Gold ab 50) - also KEINE
  // zweite Zahlenliste, die veralten kann.
  // --- Verteidigung (18.08.2026) ---
  // Der Fortschritts-Zweig deckte bis hierher Prestige, Aufstieg, Kampfpunkte, Rekordtiefe, Erfolge
  // und Bosse ab - also ausnahmslos Größen, die beim ANGREIFEN oder Sammeln wachsen. Kampfpunkte
  // gibt es ausschließlich fürs Angreifen; wer sein Imperium verteidigt, hatte im ganzen Katalog
  // kein einziges Stück. Das schließt diese Bedingungsart.
  //
  // Sie liest `staub.abwehrGesamt` und damit das NUTZEROBJEKT, nicht den Spielstand. Der Zähler im
  // Spielstand (`pvpDefended`) wird zwar ebenfalls vom Server geschrieben, ist danach aber
  // klientenautoritativ und taugt für eine Fläche, die allen gemeinsam gehört, deshalb nicht.
  // `abwehrGesamt` entsteht dort, wo der Server den Kampf SELBST auswürfelt, und trägt die
  // Absprache-Riegel des Sternenstaubs bereits mit sich (siehe staubAbwehrGutschreiben).
  //
  // Die Schwellen sind bewusst niedrig gegenüber den Kampfpunkt-Stücken (2.000/5.000): Ein
  // abgewehrter Angriff verlangt, dass jemand anderes angreift - man kann ihn nicht selbst
  // herbeiführen, und je Tag zählen höchstens STAUB_ABWEHR_MAX_PRO_TAG davon.
  //
  // Der Tagesriegel gehört in den Erklärtext, damit niemand rätselt, warum der Zähler langsamer
  // steigt als die Zahl der abgewehrten Angriffe. Er steht aber BEWUSST NICHT hier im Literal,
  // sondern wird beim Ausliefern des Katalogs angehängt (`proTag` in GET /api/cosmetics): Dieses
  // Array wird von zwei Tests als reines Literal ausgewertet, und eine Konstante darin macht es
  // unauswertbar - der Paritätstest zwischen Frontend und Backend fiele mit einem
  // ReferenceError aus, also ausgerechnet der Wächter über diese beiden Listen.
  { key: 'nf_bastion',    art: 'namensfarbe', bedingung: { typ: 'abgewehrt', wert: 10 } },
  { key: 'em_zinne',      art: 'emblem',      bedingung: { typ: 'abgewehrt', wert: 40 } },
  { key: 'em_funke',      art: 'emblem',      bedingung: { typ: 'spender_je', stufe: 'bronze' } },
  { key: 'em_leitstern',      art: 'emblem',      bedingung: { typ: 'spender_je', stufe: 'silver' } },
  { key: 'em_leuchtfeuer',art: 'emblem',      bedingung: { typ: 'spender_je', stufe: 'gold' } }
];
const KOSMETIK_ARTEN = ['namensfarbe', 'emblem'];
const KOSMETIK_VORGABE = { namensfarbe: 'nf_standard', emblem: 'em_keins' };
// Spender-Stufen sind aufsteigend: Wer Gold hat, besitzt auch die Bronze- und Silber-Farbe. Ohne
// diese Ordnung verlöre ein großzügiger Spender ausgerechnet die einfacheren Stücke.
const KOSMETIK_STUFEN_RANG = { bronze: 1, silver: 2, gold: 3 };
/* PVE-MEILENSTEINE (Phase 6). Zwei Zaehler am NUTZEROBJEKT, nicht im Spielstand - dieselbe
   Entscheidung wie bei `staub.abwehrGesamt` und aus demselben Grund: Eine Namensfarbe oder ein
   Emblem steht in der BESTENLISTE, also auf einer Flaeche, die allen gehoert. Der Spielstand ist
   bauartbedingt klientenautoritativ; ein Zaehler darin waere in fuenf Sekunden gefaelscht.

   Gezaehlt wird dort, wo der Server das Ereignis SELBST beobachtet: beim Fall einer Festung und
   beim Fall einer Koenigin. Beide Male fuer JEDEN Beitragenden - wer ein Drittel des Schadens
   getragen hat, hat die Festung genauso geschleift wie der, der zufaellig den letzten Schlag
   fuehrte. Das ist dieselbe Ueberlegung, die den Hort anteilig auszahlt. */
function pveKillZaehlen(userId, art) {
  const u = findUserById(userId);
  if (!u) return;
  u.pveKills = u.pveKills || {};
  u.pveKills[art] = (Number(u.pveKills[art]) || 0) + 1;
}
function kosmetikDef(key) { return KOSMETIK_DEFS.find(d => d.key === key) || null; }
// Ist die Bedingung BEFRISTET? Nur solche werden beim Lesen erneut geprüft (siehe Kopfkommentar).
// `spender_je` gehört ausdrücklich NICHT dazu, und das ist keine Nachlässigkeit, sondern der
// ganze Zweck: Die höchste je erreichte Stufe kann nicht sinken (siehe spenderStufeJeErreicht),
// ist damit monoton wie Prestige oder Kampfpunkte - und ein Meilenstein-Emblem, das nach 30 Tagen
// von selbst verschwände, wäre kein Meilenstein.
function kosmetikBefristet(def) { return !!def && def.bedingung.typ === 'spender'; }
function kosmetikSpenderErfuellt(userId, stufe) {
  // Bewusst supporterStatusCombined (der RANG) und nicht supporterFeaturesFor: Die Testphase gibt
  // kein Abzeichen, also auch keine Spender-Kosmetik - sonst trüge jeder nach fünf Gratistagen die
  // Farbe, die für eine Spende steht. Aus demselben Grund ist die gamegeeeeek-Ausnahme nicht drin.
  const st = supporterStatusCombined(userId);
  if (!st.active) return false;
  return (KOSMETIK_STUFEN_RANG[st.tier] || 0) >= (KOSMETIK_STUFEN_RANG[stufe] || 99);
}
function kosmetikBedingungErfuellt(userId, def, save) {
  const b = def.bedingung;
  if (b.typ === 'immer') return true;
  if (b.typ === 'spender') return kosmetikSpenderErfuellt(userId, b.stufe);
  // Meilenstein: einmal erreicht, für immer besessen. Bewusst OHNE Ablaufprüfung - der Unterschied
  // zu 'spender' ist genau der, und er ist der Grund für den eigenen Typ statt eines Zusatzfeldes.
  if (b.typ === 'spender_je') {
    const je = spenderStufeJeErreicht(userId);
    return (KOSMETIK_STUFEN_RANG[je] || 0) >= (KOSMETIK_STUFEN_RANG[b.stufe] || 99);
  }
  // Gekauft wird einmal und bleibt. Damit ist die Bedingung MONOTON wie die Fortschritts-Werte und
  // muss im Lesepfad nicht erneut geprüft werden (siehe kosmetikBefristet). Der Kauf selbst wird
  // gegen ein serverseitiges Konto abgerechnet - kein Feld aus dem Spielstand ist daran beteiligt.
  if (b.typ === 'kauf') {
    const u = findUserById(userId);
    return !!(u && (u.cosmeticsGekauft || []).indexOf(def.key) !== -1);
  }
  // Abgewehrte Spielerangriffe. Wie 'kauf' aus dem NUTZEROBJEKT, nicht aus dem Spielstand - die
  // Begründung steht bei den Einträgen in KOSMETIK_DEFS. Der Zähler wächst nur, ist also monoton
  // wie die Fortschritts-Werte und gehört deshalb nicht in kosmetikBefristet.
  if (b.typ === 'abgewehrt') {
    const u = findUserById(userId);
    return !!u && (Number((u.staub || {}).abwehrGesamt) || 0) >= b.wert;
  }
  // PvE-Meilensteine, ebenfalls aus dem Nutzerobjekt (Begruendung bei pveKillZaehlen). Beide
  // Zaehler steigen nur - deshalb kein Eintrag in kosmetikBefristet.
  if (b.typ === 'festungen' || b.typ === 'koeniginnen') {
    const u = findUserById(userId);
    return !!u && (Number((u.pveKills || {})[b.typ]) || 0) >= b.wert;
  }
  const s = save || {};
  if (b.typ === 'prestige') return (Number(s.prestige) || 0) >= b.wert;
  if (b.typ === 'aufstieg') return (Number((s.ascension || {}).count) || 0) >= b.wert;
  if (b.typ === 'kampfpunkte') return (Number(s.battlePoints) || 0) >= b.wert;
  if (b.typ === 'abgrund') return (Number((s.abgrund || {}).best) || 0) >= b.wert;
  // Erfolge liegen als Objekt vor (Schlüssel -> true), gezählt wird die Zahl der Schlüssel - genau
  // so, wie es auch das Frontend für seine Kompendium-Anzeige tut.
  if (b.typ === 'erfolge') return Object.keys(s.achievements || {}).length >= b.wert;
  if (b.typ === 'bosse') return (Number(s.bossKills) || 0) >= b.wert;
  return false;   // unbekannte Bedingung sperrt, statt versehentlich freizugeben
}
// Die vollständige Prüfung - liest den Spielstand ein und ist deshalb nur für /api/cosmetics und
// das Ausrüsten gedacht, nicht für den Lesepfad der Bestenliste.
function kosmetikBesitz(userId) {
  let save = {};
  try { save = JSON.parse(getSaveValue(userId) || '{}') || {}; } catch (e) { save = {}; }
  const besitz = [];
  for (const def of KOSMETIK_DEFS) if (kosmetikBedingungErfuellt(userId, def, save)) besitz.push(def.key);
  return besitz;
}
// Was ein Spieler gerade TRÄGT, aus fremder Sicht. Der Lesepfad: billig, ohne Spielstand, und er
// lässt abgelaufene Spender-Stücke von selbst wegfallen (siehe Kopfkommentar, Stufe b).
function kosmetikGetragen(userId) {
  const user = findUserById(userId);
  const gewaehlt = (user && user.cosmetics) || {};
  const raus = {};
  for (const art of KOSMETIK_ARTEN) {
    const key = gewaehlt[art];
    const def = key ? kosmetikDef(key) : null;
    if (!def || def.art !== art) { raus[art] = KOSMETIK_VORGABE[art]; continue; }
    // Nur die befristeten Bedingungen erneut prüfen; die monotonen galten beim Ausrüsten und gelten
    // weiter. Fällt eine weg, greift still die Vorgabe - kein Aufräumen, kein Datenverlust.
    if (kosmetikBefristet(def) && !kosmetikBedingungErfuellt(userId, def, null)) { raus[art] = KOSMETIK_VORGABE[art]; continue; }
    raus[art] = key;
  }
  return raus;
}
// Katalog + eigener Besitz + eigene Auswahl. Ein Aufruf, damit das Frontend die Auswahlfläche in
// einem Zug zeichnen kann, statt drei Anfragen zu stellen.
app.get('/api/cosmetics', authMiddleware, (req, res) => {
  res.json({
    // Der Tagesriegel der Abwehr reist am Katalog mit, statt im Frontend abgeschrieben zu werden -
    // sonst wäre die Zahl im Erklärtext die zweite Anzeigestelle, die beim nächsten Justieren von
    // STAUB_ABWEHR_MAX_PRO_TAG zurückbleibt. Angehängt wird hier und nicht im Literal, damit
    // KOSMETIK_DEFS ein reines, von den Tests auswertbares Literal bleibt.
    katalog: KOSMETIK_DEFS.map(d => ({ key: d.key, art: d.art,
      bedingung: d.bedingung.typ === 'abgewehrt'
        ? Object.assign({}, d.bedingung, { proTag: STAUB_ABWEHR_MAX_PRO_TAG })
        : d.bedingung })),
    besitz: kosmetikBesitz(req.userId),
    getragen: kosmetikGetragen(req.userId),
    vorgabe: KOSMETIK_VORGABE,
    staub: staubStand(findUserById(req.userId) || {})
  });
});
// Kaufen. Die einzige Stelle, an der Sternenstaub abgeht.
app.post('/api/cosmetics/buy', authMiddleware, async (req, res) => {
  const user = findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'Account nicht gefunden.' });
  const key = String((req.body && req.body.key) || '');
  const def = kosmetikDef(key);
  if (!def) return res.status(400).json({ error: 'Unbekanntes Kosmetik-Stück: ' + key });
  if (def.bedingung.typ !== 'kauf') return res.status(400).json({ error: 'Dieses Stück ist nicht käuflich – es wird über Fortschritt oder Unterstützung freigeschaltet.' });
  const gekauft = user.cosmeticsGekauft || [];
  if (gekauft.indexOf(key) !== -1) return res.status(409).json({ error: 'Dieses Stück besitzt du bereits.' });
  const k = staubKonto(user);
  if ((k.menge || 0) < def.bedingung.preis) {
    return res.status(402).json({ error: 'Nicht genug Sternenstaub.', fehlt: def.bedingung.preis - (k.menge || 0) });
  }
  // Erst abbuchen, dann eintragen, dann EINMAL speichern - beide Mutationen laufen synchron vor
  // saveDb(), sonst könnte eine davon einen Schreibvorgang verpassen (CLAUDE.md-Fallstrick).
  k.menge -= def.bedingung.preis;
  user.cosmeticsGekauft = gekauft.concat([key]);
  await saveDb();
  res.json({ ok: true, key, staub: staubStand(user), besitz: kosmetikBesitz(req.userId) });
});
app.post('/api/cosmetics/equip', authMiddleware, async (req, res) => {
  const user = findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'Account nicht gefunden.' });
  const wunsch = (req.body && req.body.auswahl) || {};
  const besitz = kosmetikBesitz(req.userId);
  const neu = Object.assign({}, user.cosmetics || {});
  for (const art of KOSMETIK_ARTEN) {
    if (!Object.prototype.hasOwnProperty.call(wunsch, art)) continue;   // nicht genannt = unverändert
    const key = String(wunsch[art] || '');
    const def = kosmetikDef(key);
    if (!def || def.art !== art) return res.status(400).json({ error: 'Unbekanntes Kosmetik-Stück: ' + key });
    if (besitz.indexOf(key) === -1) {
      // Der eigentliche Zweck dieser Route. Ohne diese Zeile wäre die ganze Kosmetik so
      // fälschungssicher wie ein Feld im Spielstand - also gar nicht.
      console.warn('[kosmetik-reject] userId=' + req.userId + ' username=' + req.username + ' wollte ' + key + ' tragen, ohne es zu besitzen.');
      return res.status(403).json({ error: 'Dieses Stück hast du noch nicht freigeschaltet.' });
    }
    neu[art] = key;
  }
  user.cosmetics = neu;
  await saveDb();
  res.json({ ok: true, getragen: kosmetikGetragen(req.userId), besitz });
});
// --- Admin: Rang vergeben / entziehen / auflisten ---
app.post('/api/admin/grant-supporter', authMiddleware, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const { targetUsername, days, tier } = req.body || {};
  const target = db.users[String(targetUsername || '').trim().toLowerCase()];
  if (!target) return res.status(404).json({ error: 'Kein Spieler mit diesem Namen gefunden.' });
  const tage = Number(days);
  // Nur die drei vorgesehenen Laufzeiten. Ein freies Zahlenfeld hätte hier nichts gewonnen und
  // wäre die Stelle, an der ein Vertipper einen Rang auf 3000 Tage setzt.
  if (SUPPORTER_GRANT_DAYS.indexOf(tage) === -1) {
    return res.status(400).json({ error: 'Laufzeit muss 30, 60 oder 90 Tage sein.' });
  }
  const stufe = ['bronze', 'silver', 'gold'].indexOf(String(tier || '')) !== -1 ? String(tier) : 'bronze';
  target.supporterGrantUntil = Date.now() + tage * 86400000;
  target.supporterGrantTier = stufe;
  // Historie für die Meilenstein-Embleme (17.08.2026): steigt nur, sinkt nie. `supporterGrantTier`
  // taugt dafür nicht - es wird beim Widerruf gelöscht und beim Korrigieren eines Vertippers nach
  // UNTEN überschrieben (ein zweiter Aufruf setzt neu statt zu verlängern, siehe Kommentar oben).
  spenderStufeJeFortschreiben(target, stufe);
  target.supporterGrantBy = req.username;
  target.supporterGrantAt = Date.now();
  await saveDb();
  res.json({ ok: true, username: target.username, until: target.supporterGrantUntil, tier: stufe, days: tage });
});
app.post('/api/admin/revoke-supporter', authMiddleware, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const target = db.users[String((req.body || {}).targetUsername || '').trim().toLowerCase()];
  if (!target) return res.status(404).json({ error: 'Kein Spieler mit diesem Namen gefunden.' });
  delete target.supporterGrantUntil;
  delete target.supporterGrantTier;
  delete target.supporterGrantBy;
  delete target.supporterGrantAt;
  // `supporterStufeJeMax` bleibt bewusst STEHEN. Der Widerruf nimmt den laufenden Rang zurück,
  // nicht die Tatsache, dass er einmal vergeben war - dieselbe Haltung wie beim Berichts-Archiv:
  // ein Deckel (oder hier ein Widerruf) darf Historie nicht vernichten. Wer eine Fehlvergabe
  // restlos tilgen will, muss das Feld bewusst von Hand entfernen.
  await saveDb();
  // Eine per Ko-fi verdiente Unterstützung bleibt davon unberührt - deshalb wird der verbleibende
  // Stand zurückgemeldet und nicht einfach "weg" behauptet.
  res.json({ ok: true, username: target.username, nochAktiv: supporterStatusCombined(target.userId).active });
});
// Spenden, die ohne E-Mail ankamen und deshalb keinem Konto zugeordnet werden konnten. Liegt
// bewusst neben der Rang-Vergabe: Die Liste ist keine Statistik, sie ist eine Arbeitsliste.
app.get('/api/admin/kofi-unlinked', authMiddleware, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  res.json({ offen: (db.kofiUnlinked || []).slice(0, 100) });
});
app.post('/api/admin/kofi-unlinked/dismiss', authMiddleware, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const id = String((req.body || {}).id || '');
  db.kofiUnlinked = (db.kofiUnlinked || []).filter(e => e.id !== id);
  await saveDb();
  res.json({ ok: true, offen: db.kofiUnlinked.length });
});
app.get('/api/admin/supporters', authMiddleware, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const jetzt = Date.now();
  const liste = [];
  for (const key of Object.keys(db.users)) {
    const u = db.users[key];
    if (!u) continue;
    const gespendet = supporterStatusFor(u.userId);
    const vergeben = (u.supporterGrantUntil || 0) > 0;
    if (!gespendet.active && !vergeben) continue;
    liste.push({
      username: u.username,
      gespendet: !!gespendet.active,
      gespendetStufe: gespendet.active ? gespendet.tier : null,
      gespendetBis: gespendet.active ? (gespendet.lastDonationAt + SUPPORTER_BADGE_DAYS * 86400000) : 0,
      vergeben,
      vergebenAktiv: (u.supporterGrantUntil || 0) > jetzt,
      vergebenBis: u.supporterGrantUntil || 0,
      vergebenStufe: u.supporterGrantTier || null,
      vergebenVon: u.supporterGrantBy || null
    });
  }
  liste.sort((a, b) => Math.max(b.vergebenBis, b.gespendetBis) - Math.max(a.vergebenBis, a.gespendetBis));
  res.json({ supporters: liste.slice(0, 200), laufzeiten: SUPPORTER_GRANT_DAYS });
});
/* ===== Bonuscodes (21.08.2026, Auftrag Sascha) ==================================================
   "ich will ab und zu mal bonuscodes posten wo die spieler kleine geschenke bekommen die codes
   sollen aber nur eine gewisse gueltigkeit haben also max 1 mal pro account einloesbar und nur
   1 woche etc aktiv am liebsten baust du mir das in den admin bereich ein."

   WO DIE DATEN LIEGEN, und warum genau dort:
   - Der KATALOG in `db.bonusCodes`. Ausdruecklich NICHT in db.shared: Der generische
     Storage-Endpunkt ist fuer jeden eingeloggten Nutzer schreibbar, solange keine Sonderregel
     greift - ein Code liesse sich dort anlegen. `db.galaxy` ist das Vorbild: von aussen gar nicht
     erreichbar.
   - Die EINLOESESPERRE am user-Objekt (`user.bonusCodes`), nicht im Spielstand. Das Vorbild
     /api/referral/redeem merkt sie sich in `save.referralRedeemed` - und der Spielstand ist
     bauartbedingt klientenautoritativ. Wer das Feld in der Entwicklerkonsole loescht, loest erneut
     ein. Bei einem Code, der OEFFENTLICH gepostet wird, waere das die Selbstbedienung, vor der die
     CLAUDE.md bei jedem Belohnungssystem warnt (dieselbe Entscheidung wie bei user.marktTag und
     user.staub).

   DIE GABEN-TABELLE IST DIE EIGENTLICHE SICHERUNG. Sie sagt, welche Felder ein Code ueberhaupt
   tragen darf und wie gross jedes hoechstens sein kann. Ohne sie waere ein Tippfehler beim Anlegen
   (1000000 statt 1000) ein Wirtschaftsereignis - und ein zu grosser Wert reisst spaeter
   SAVE_SANITY_LIMITS, was den GESAMTEN Spielstand des Beschenkten mit HTTP 400 ablehnen laesst.
   Die Deckel sind bewusst klein gehalten: Der Auftrag sagt "kleine geschenke". */
const BONUSCODE_MIN_LAENGE = 8;      // kuerzer waere in Stunden durchprobierbar
const BONUSCODE_MAX_LAENGE = 24;
const BONUSCODE_LAUFZEITEN = [1, 3, 7, 14, 30];   // Tage, zur Auswahl im Admin-Bereich
const BONUSCODE_VERSUCHE_PRO_TAG = 12;            // FEHLversuche je Konto und Tag
const BONUSCODE_MAX_AKTIV = 50;                   // Katalog-Obergrenze, damit db.json nicht waechst
const BONUSCODE_GABEN = {
  credits:          { max: 25000,   name: 'Kredite' },
  erz:              { max: 2000000, name: 'Erz' },
  kristalle:        { max: 2000000, name: 'Kristalle' },
  deuterium:        { max: 2000000, name: 'Deuterium' },
  energie:          { max: 2000000, name: 'Energie' },
  antimaterie:      { max: 100000,  name: 'Antimaterie' },
  forschungspunkte: { max: 50000,   name: 'Forschungspunkte' },
  kampfpunkte:      { max: 25000,   name: 'Kampfpunkte' },
  xp:               { max: 50000,   name: 'Erfahrung' }
};

/* Gross-/Kleinschreibung, Bindestriche und Leerzeichen sind egal - wer "sternen-staub 25" tippt,
   hat den Code. Normalisiert wird beim VERGLEICHEN und beim Schluessel, die Anzeigeform bleibt
   erhalten (der Katalog fuehrt sie als `anzeige`). */
function bonuscodeNormal(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function bonusCodes() { return (db.bonusCodes = db.bonusCodes || {}); }

/* Die Gaben eines Codes pruefen und saeubern. Gibt { gaben, fehler } zurueck - `fehler` nennt den
   GRUND, damit der Admin-Bereich ihn anzeigen kann statt eines pauschalen "ungueltig". */
function bonuscodeGabenPruefen(roh) {
  const gaben = {};
  let anzahl = 0;
  for (const [feld, wert] of Object.entries(roh || {})) {
    const def = BONUSCODE_GABEN[feld];
    if (!def) return { fehler: 'Unbekannte Gabe: ' + String(feld).slice(0, 30) + '.' };
    const n = Math.floor(Number(wert));
    if (!Number.isFinite(n) || n <= 0) return { fehler: def.name + ': Bitte eine ganze Zahl groesser als 0.' };
    if (n > def.max) return { fehler: def.name + ': hoechstens ' + def.max + ' je Code.' };
    gaben[feld] = n;
    anzahl++;
  }
  if (!anzahl) return { fehler: 'Der Code verschenkt nichts - mindestens eine Gabe angeben.' };
  return { gaben };
}

// Anlegen. Der Code selbst wird vom Admin vorgegeben (er soll ihn ja posten koennen), nicht erzeugt.
app.post('/api/admin/bonuscode', authMiddleware, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const { code, gaben, tage, maxGesamt, notiz } = req.body || {};
  const schluessel = bonuscodeNormal(code);
  if (schluessel.length < BONUSCODE_MIN_LAENGE || schluessel.length > BONUSCODE_MAX_LAENGE) {
    return res.status(400).json({ error: 'Der Code braucht ' + BONUSCODE_MIN_LAENGE + ' bis ' + BONUSCODE_MAX_LAENGE + ' Zeichen (Buchstaben und Ziffern).' });
  }
  const katalog = bonusCodes();
  if (katalog[schluessel]) return res.status(409).json({ error: 'Diesen Code gibt es schon.' });
  if (Object.keys(katalog).length >= BONUSCODE_MAX_AKTIV) {
    return res.status(400).json({ error: 'Es sind bereits ' + BONUSCODE_MAX_AKTIV + ' Codes angelegt - bitte alte entfernen.' });
  }
  const t = Number(tage);
  if (BONUSCODE_LAUFZEITEN.indexOf(t) === -1) {
    return res.status(400).json({ error: 'Laufzeit muss eine von ' + BONUSCODE_LAUFZEITEN.join(', ') + ' Tagen sein.' });
  }
  const geprueft = bonuscodeGabenPruefen(gaben);
  if (geprueft.fehler) return res.status(400).json({ error: geprueft.fehler });
  const gesamt = Math.max(0, Math.floor(Number(maxGesamt) || 0));   // 0 = unbegrenzt
  const jetzt = Date.now();
  katalog[schluessel] = {
    anzeige: String(code || '').trim().slice(0, BONUSCODE_MAX_LAENGE + 8),
    gaben: geprueft.gaben,
    angelegt: jetzt,
    gueltigBis: jetzt + t * 86400000,
    maxGesamt: gesamt,
    eingeloest: 0,
    aktiv: true,
    notiz: String(notiz || '').trim().slice(0, 120)
  };
  console.log('[bonuscode] angelegt code=' + schluessel + ' tage=' + t + ' gesamt=' + gesamt);
  await saveDb();
  res.json({ ok: true, code: schluessel, gueltigBis: katalog[schluessel].gueltigBis });
});

// Auflisten. Nennt auch die Tabellen, damit der Admin-Bereich keine zweite Kopie der Grenzen fuehrt.
app.get('/api/admin/bonuscodes', authMiddleware, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const katalog = bonusCodes();
  const liste = Object.keys(katalog).map(k => Object.assign({ code: k }, katalog[k]));
  liste.sort((a, b) => b.angelegt - a.angelegt);
  res.json({ codes: liste, gaben: BONUSCODE_GABEN, laufzeiten: BONUSCODE_LAUFZEITEN, maxAktiv: BONUSCODE_MAX_AKTIV });
});

// An/aus schalten bzw. endgueltig entfernen. Abschalten laesst die Einloesungen stehen (der Zaehler
// ist die einzige Auswertung, die es gibt); Entfernen gibt den Platz im Katalog frei.
app.post('/api/admin/bonuscode/aktiv', authMiddleware, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const { code, aktiv, entfernen } = req.body || {};
  const schluessel = bonuscodeNormal(code);
  const katalog = bonusCodes();
  if (!katalog[schluessel]) return res.status(404).json({ error: 'Diesen Code gibt es nicht.' });
  if (entfernen) { delete katalog[schluessel]; }
  else { katalog[schluessel].aktiv = !!aktiv; }
  await saveDb();
  res.json({ ok: true });
});

/* ===== Vier Admin-Faehigkeiten (28.08.2026, Auftrag Sascha "mehr adminfaehigkeiten in admin
   bereich hinzu") =================================================================================

   GEMESSEN VORHER, damit klar ist, was hier NICHT das Problem war: Der Admin-Bereich hatte 13
   Routen, und ALLE 13 waren im Frontend verdrahtet. Es fehlte keine Anzeigestelle zu einer
   vorhandenen Route - es fehlten Faehigkeiten. Die vier hier decken die vier gemessenen Luecken:

   1. FEEDBACK        - `db.feedback` haelt die letzten 500 Einsendungen und hatte NULL Leser
                        (gemessen: nur Schreibstellen). Der einzige Weg dorthin war die Resend-Mail
                        plus eine Push-Meldung; wer die Mail loescht, kommt nie wieder dran. Die
                        Daten liegen laengst da - das hier ist keine neue Erfassung, nur eine neue
                        Sicht (dieselbe Entscheidung wie bei /api/admin/retention).
   2. NOTABSCHALTUNG  - FESTUNG_SPAWN_AKTIV, FESTUNG_BAUTEILE_AKTIV und NEST_SPAWN_AKTIV sind in
                        ihren eigenen Kommentaren dreimal als "Notausschalter" beschrieben. Sie
                        umzulegen brauchte bis hierher einen MERGE samt Deploy - also genau den
                        Weg, der in dieser Datei dreizehnmal dokumentiert ausgefallen ist, zuletzt
                        fuenf Tage lang unbemerkt. Ein Notausschalter, der einen funktionierenden
                        Deploy voraussetzt, ist im Ernstfall keiner.
   3. KONTO-BLATT     - Sperren ging ausschliesslich ueber eine vorhandene MELDUNG (der Knopf
                        haengt an der Meldungszeile), obwohl /api/admin/set-banned einen Namen
                        entgegennimmt. Ohne Meldung war ein Konto gar nicht erreichbar - weder zum
                        Sperren noch zum blossen Nachsehen.
   4. SYSTEMSTAND     - commit/checkout/blob stehen in /api/health, die Pruefung brauchte aber ein
                        curl von aussen. Und `DEPLOY_ALARM_MAIL` war am Container nicht gesetzt:
                        der Alarm aus #166 ist gebaut und still, ohne dass das irgendwo auffaellt.

   ALLE VIER liegen hinter isAdmin() - also hinter genau EINEM Konto (db.users['gamegeeeeek']).  */

// --- 1. Feedback ------------------------------------------------------------------------------
// `erledigt` ist eine MARKE, kein Loeschen: Die Liste ist ohnehin auf 500 gedeckelt und rollt von
// selbst weiter. Ein Eintrag, den man abgehakt hat, soll nachlesbar bleiben - eine Idee von vor
// zwei Monaten ist beim naechsten Konzept wieder interessant.
app.get('/api/admin/feedback', authMiddleware, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const alle = db.feedback || [];
  const nurOffen = req.query.offen === '1';
  const nurTyp = (req.query.typ === 'bug' || req.query.typ === 'idee') ? req.query.typ : null;
  const gefiltert = alle.filter(f => (!nurOffen || !f.erledigt) && (!nurTyp || f.type === nurTyp));
  res.json({
    feedback: gefiltert.slice(0, 200).map(f => ({
      id: f.id, time: f.time, username: f.username, type: f.type,
      text: f.text, version: f.version || null,
      // NICHT der Dateiname, sondern nur ob es eins gibt - abgeholt wird ueber die ID (siehe
      // unten). Damit kann die Route strukturell nicht zum Pfad-Ausbruch missbraucht werden.
      hatBild: !!f.imageFile,
      erledigt: !!f.erledigt, erledigtAm: f.erledigtAm || 0
    })),
    gesamt: alle.length,
    offen: alle.filter(f => !f.erledigt).length,
    angezeigt: Math.min(gefiltert.length, 200)
  });
});

app.post('/api/admin/feedback/erledigt', authMiddleware, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const { id, erledigt } = req.body || {};
  const eintrag = (db.feedback || []).find(f => f.id === id);
  if (!eintrag) return res.status(404).json({ error: 'Diese Einsendung gibt es nicht (mehr).' });
  if (erledigt === false) { delete eintrag.erledigt; delete eintrag.erledigtAm; }
  else { eintrag.erledigt = true; eintrag.erledigtAm = Date.now(); }
  await saveDb();
  res.json({ ok: true, offen: (db.feedback || []).filter(f => !f.erledigt).length });
});

/* Der angehaengte Screenshot. Er ging bisher NUR als Mail-Anhang raus - eine Feedback-Ansicht ohne
   ihn waere die halbe Auskunft, und gerade bei einem Fehlerbericht ist das Bild der Inhalt.

   DIE ROUTE NIMMT DIE FEEDBACK-ID, NICHT DEN DATEINAMEN, und das ist die eigentliche Entscheidung:
   Der Server schlaegt `imageFile` selbst im eigenen Bestand nach. Ein Pfad-Ausbruch ("../../")
   ist damit strukturell unmoeglich statt durch eine Pruefung abgefangen, die man beim naechsten
   Umbau vergessen kann. `path.basename` steht trotzdem davor - doppelt, weil der Wert einmal aus
   einer alten db.json stammen koennte. */
app.get('/api/admin/feedback/bild/:id', authMiddleware, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const eintrag = (db.feedback || []).find(f => f.id === req.params.id);
  if (!eintrag || !eintrag.imageFile) return res.status(404).json({ error: 'Zu dieser Einsendung gibt es kein Bild.' });
  const datei = path.join(FEEDBACK_IMG_DIR, path.basename(String(eintrag.imageFile)));
  if (!fs.existsSync(datei)) return res.status(404).json({ error: 'Die Bilddatei liegt nicht mehr auf der Platte.' });
  res.type(datei.endsWith('.png') ? 'image/png' : 'image/jpeg');
  res.sendFile(datei);
});


// --- 2. Notabschaltung der PvE-Spawns ---------------------------------------------------------
/* ==================================

   Die drei Konstanten darueber (FESTUNG_SPAWN_AKTIV, FESTUNG_BAUTEILE_AKTIV, NEST_SPAWN_AKTIV)
   nennen sich in ihren eigenen Kommentaren dreimal "Notausschalter" - und brauchten bis hierher
   einen MERGE samt Deploy, um umgelegt zu werden. Das ist genau der Weg, der in der CLAUDE.md
   dieses Repos dreizehnmal als ausgefallen dokumentiert ist; der letzte Ausfall lief fuenf Tage
   unbemerkt. Ein Notausschalter, der einen funktionierenden Deploy voraussetzt, ist im Ernstfall
   keiner. Deshalb liegt der Zustand zusaetzlich in der DB und ist ueber /api/admin/schalter
   erreichbar.

   DIE RICHTUNG IST EINSEITIG, UND DAS IST DIE EIGENTLICHE ENTSCHEIDUNG: Der Admin kann nur
   ABSCHALTEN, nie einschalten. Die Konstante bleibt die Grundstellung - steht sie auf false, ist
   die Mechanik aus und kein Knopf holt sie zurueck. Der Grund ist derselbe, aus dem es die
   Konstanten ueberhaupt gibt: Sie schuetzen davor, dass eine Backend-Mechanik ohne ihr Frontend
   live geht und dem Spieler still eine Zahl verschiebt (Frontend-Regel 60). Ein DB-Schalter, der
   etwas EINschalten koennte, haette genau dieses Tor wieder geoeffnet - und zwar an einer Stelle,
   an der kein Merge und kein Test mehr dazwischensteht.

   WO DER ZUSTAND LIEGT: in `db.notAus`, einem eigenen Feld auf oberster Ebene - ausdruecklich
   NICHT in `db.shared` (dort schreibt jeder eingeloggte Nutzer, solange keine Sonderregel greift)
   und auch nicht in `db.galaxy`: `galaxyFuerClient()` reicht dessen Inhalt an JEDEN Client weiter,
   der Schalterzustand ginge also ungefragt an alle. `db.bonusCodes` ist das Vorbild.

   KEIN NEUSTART NOETIG, und das ist der Zweck: `spawnAktiv()` liest bei jedem Aufruf frisch. Die
   Funktionen sind bewusst `function`-Deklarationen (hochgezogen) und lesen die Konstanten erst im
   RUMPF - ein Objektliteral mit direkten Verweisen waere hier die temporale Todeszone, die den
   Serverstart in diesem Repo schon einmal gekostet hat. */
const NOTAUS_NAMEN = {
  festung:  'Asteroidenfestungen entstehen',
  bauteile: 'Neue Festungen bekommen Schild und Tuerme',
  nester:   'Alien-Nester entstehen, reifen und wandern'
};
function notAusGesetzt(name) {
  return !!(db.notAus && db.notAus[name] && db.notAus[name].aus === true);
}
function spawnAktiv(name) {
  // EINE Kette, nicht zwei: `spawnAktivImCode` ist die Grundstellung, hier kommt nur die
  // Notabschaltung davor. Zwei Kopien liefen beim naechsten Schalter auseinander.
  return spawnAktivImCode(name) && !notAusGesetzt(name);
}

app.get('/api/admin/schalter', authMiddleware, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  res.json({
    schalter: Object.keys(NOTAUS_NAMEN).map(name => {
      const eintrag = (db.notAus && db.notAus[name]) || null;
      return {
        name, beschreibung: NOTAUS_NAMEN[name],
        // Die drei Felder beantworten drei verschiedene Fragen, und genau ihr Unterschied ist die
        // Auskunft: `imCode` = was ausgeliefert ist, `notAus` = was der Admin gesetzt hat,
        // `wirksam` = was der Server JETZT tut. Ein einzelnes "an/aus" koennte nicht sagen, ob
        // etwas abgeschaltet oder nie ausgeliefert wurde.
        imCode: spawnAktivImCode(name),
        notAus: notAusGesetzt(name),
        wirksam: spawnAktiv(name),
        seit: eintrag ? (eintrag.seit || 0) : 0,
        grund: eintrag ? (eintrag.grund || null) : null
      };
    })
  });
});
function spawnAktivImCode(name) {
  if (name === 'festung') return FESTUNG_SPAWN_AKTIV;
  if (name === 'bauteile') return FESTUNG_BAUTEILE_AKTIV;
  if (name === 'nester') return NEST_SPAWN_AKTIV;
  return false;
}

/* Der GRUND ist Pflicht beim Abschalten und steht spaeter in der Antwort. Eine Notabschaltung ohne
   Begruendung ist in zwei Wochen nicht mehr von einem Versehen zu unterscheiden - und dieses Repo
   dokumentiert bei allen drei Schaltern ausdruecklich, dass ihr Grund "dann hierher gehoert". */
app.post('/api/admin/schalter', authMiddleware, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const { name, aus, grund } = req.body || {};
  if (!Object.prototype.hasOwnProperty.call(NOTAUS_NAMEN, name)) {
    return res.status(400).json({ error: 'Diesen Schalter gibt es nicht: ' + String(name).slice(0, 40) });
  }
  if (aus === true && !spawnAktivImCode(name)) {
    return res.status(400).json({ error: 'Das ist im ausgelieferten Stand ohnehin aus - hier gibt es nichts abzuschalten.' });
  }
  if (!db.notAus) db.notAus = {};
  if (aus === true) {
    const text = String(grund || '').trim().slice(0, 200);
    if (text.length < 3) return res.status(400).json({ error: 'Bitte kurz begruenden, warum abgeschaltet wird.' });
    db.notAus[name] = { aus: true, seit: Date.now(), grund: text };
  } else {
    delete db.notAus[name];
  }
  console.warn('[notaus] ' + name + ' -> ' + (aus === true ? 'ABGESCHALTET (' + (db.notAus[name].grund) + ')' : 'wieder frei'));
  await saveDb();
  res.json({ ok: true, name, notAus: notAusGesetzt(name), wirksam: spawnAktiv(name) });
});

// --- 3. Konto-Blatt ---------------------------------------------------------------------------
/* Was hier NICHT drinsteht: `passwordHash`, `email` im Klartext und der Spielstand selbst. Der
   Hash gehoert nirgendwo hin, wo er mitgeschnitten werden kann; die Adresse wird auf ihre Form
   reduziert (erstes Zeichen + Domain), weil die Frage im Betrieb "hat er ueberhaupt eine und ist
   sie bestaetigt" lautet und nicht "wie lautet sie". Wer sie wirklich braucht, kommt an die
   db.json ohnehin heran - aber sie faellt dann nicht nebenbei in einem Screenshot an. */
function emailForm(adresse) {
  const s = String(adresse || '');
  const at = s.indexOf('@');
  if (at < 1) return null;
  return s[0] + '***' + s.slice(at);
}
app.get('/api/admin/konto', authMiddleware, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const suche = String(req.query.name || '').trim().toLowerCase();
  if (suche.length < 2) return res.status(400).json({ error: 'Bitte mindestens zwei Zeichen suchen.' });
  // Teiltreffer, damit man einen Namen nicht exakt kennen muss. Bei einem Volltreffer steht der
  // vorn - sonst waere ausgerechnet der gesuchte Name irgendwo in der Liste.
  const treffer = Object.keys(db.users).filter(k => k.includes(suche)).sort((a, b) => {
    if (a === suche) return -1;
    if (b === suche) return 1;
    return a.localeCompare(b);
  }).slice(0, 20);
  const jetzt = Date.now();
  const konten = treffer.map(k => {
    const u = db.users[k];
    const rang = supporterStatusCombined(u.userId);
    const priv = db.private[u.userId] || {};
    const save = priv[SAVE_KEY];
    const staub = u.staub || {};
    return {
      username: u.username,
      gesperrt: !!u.banned,
      registriert: u.createdAt || 0,
      emailForm: emailForm(u.email),
      emailBestaetigt: !!u.emailVerified,
      letzteSitzung: u.activeSessionAt || 0,
      hatSpielstand: save !== undefined,
      heimatsystem: u.homeSystem || null,
      unterstuetzer: rang && rang.active ? (rang.tier || 'aktiv') : null,
      // `granted` unterscheidet manuell vergeben von echt gespendet - die Trennung, auf der das
      // ganze Unterstuetzer-Programm beruht (Rang != Funktionsfreigabe).
      unterstuetzerVergeben: !!(rang && rang.active && rang.granted),
      testphaseGenutzt: !!u.supporterTrialAt,
      stufeJeMax: u.supporterStufeJeMax || null,
      sternenstaub: staub.menge || 0,
      abgewehrteAngriffe: staub.abwehrGesamt || 0,
      pveKills: u.pveKills || null,
      bonusCodes: Object.keys(u.bonusCodes || {}).length,
      bonusFehlversuche: (u.bonusVersuche && u.bonusVersuche.n) || 0,
      marktErloesHeute: (u.marktTag && u.marktTag.stempel === staubTagesschluessel()) ? (u.marktTag.erloes || 0) : 0,
      offeneBelohnungen: (priv.__pendingRewards || []).length,
      // Die Zahl sagt, ob "alle Sitzungen beenden" hier schon einmal gelaufen ist; sie ist die
      // einzige Spur, die ein Passwort-Reset im Konto hinterlaesst.
      tokenVersion: u.tokenVersion || 0,
      angemeldet: !!(u.activeSessionId && (jetzt - (u.activeSessionAt || 0)) < 86400000),
      // Aktivitaets-Uhr und Reaktionszeiten (siehe den Block bei aktivVermerken). Die
      // Stundenreihe kommt als Zeichenkette aus 0/1 - ein Array aus 336 Zahlen waere in JSON
      // rund fuenfmal so gross, und gezeichnet wird sie ohnehin Zeichen fuer Zeichen.
      aktiv: (() => { const a = aktivAuswerten(u, jetzt);
        return { reihe: a.stunden.join(''), aktiv: a.aktiv, beobachtet: a.beobachtet,
                 laengstePause: a.laengstePause, belastbar: a.belastbar, tage: AKTIV_TAGE }; })(),
      reaktionen: (u.reaktionen || []).slice(-REAKTION_MERKEN)
    };
  });
  res.json({ konten, gefunden: Object.keys(db.users).filter(k => k.includes(suche)).length });
});

/* Alle Sitzungen eines FREMDEN Kontos beenden. Der Weg dorthin ist derselbe wie beim Spieler
   selbst (/api/logout-all): tokenVersion hochzaehlen entwertet JEDES ausgestellte Token, auch die
   alten sid-losen. Der Unterschied ist die Begruendung, warum es hier KEINE Passwort-Abfrage gibt:
   Der Admin kennt das fremde Passwort per Konstruktion nicht. Die Sperre ist isAdmin() selbst.

   WOFUER: Ein uebernommenes Konto (der Spieler meldet "da war jemand dran") laesst sich damit
   sofort aus allen Geraeten werfen, ohne dass der rechtmaessige Besitzer erst sein Passwort
   zuruecksetzen muss - und ohne dass jemand in die db.json greifen muss. */
app.post('/api/admin/konto/sitzungen-beenden', authMiddleware, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const key = String((req.body && req.body.targetUsername) || '').trim().toLowerCase();
  const ziel = db.users[key];
  if (!ziel) return res.status(404).json({ error: 'Kein Spieler mit diesem Namen gefunden.' });
  ziel.tokenVersion = (ziel.tokenVersion || 0) + 1;
  delete ziel.activeSessionId;
  delete ziel.activeSessionAt;
  await saveDb();
  res.json({ ok: true, username: ziel.username, tokenVersion: ziel.tokenVersion });
});

// --- 4. Systemstand ----------------------------------------------------------------------------
/* Die vier Deploy-Felder aus /api/health plus die Frage, die bisher nur ein SSH-Zugang beantworten
   konnte: welche Konfiguration fehlt.

   ES WERDEN NIE WERTE AUSGEGEBEN, nur Ja/Nein. Der Grund steht in der Doku dieses Repos: Der
   Compose-Stack fuehrt Resend-Schluessel, Deploy-Secret und Ko-fi-Token im Klartext, und die
   gehoeren in keinen Screenshot und keinen Fehlerbericht. Ein Ja/Nein beantwortet die Frage
   "warum kommt keine Alarm-Mail" vollstaendig, ohne irgendetwas preiszugeben. */
app.get('/api/admin/systemstand', authMiddleware, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Kein Admin-Zugriff.' });
  const gesetzt = (name) => !!(process.env[name] && String(process.env[name]).trim());
  const spielstaende = Object.keys(db.private).filter(uid => db.private[uid] && db.private[uid][SAVE_KEY] !== undefined).length;
  res.json({
    deploy: {
      commit: LAUFENDER_COMMIT,
      checkout: gitKopfJetzt(),
      blob: LAUFENDE_DATEI,
      selbstNeustart: DEPLOY_SELBST_NEUSTART,
      uptimeSec: Math.round(process.uptime())
    },
    bestand: {
      konten: Object.keys(db.users).length,
      spielstaende,
      offenesFeedback: (db.feedback || []).filter(f => !f.erledigt).length,
      offeneMeldungen: (db.playerReports || []).length,
      offeneKofiZuordnungen: (db.kofiUnlinked || []).length
    },
    konfiguration: [
      { name: 'RESEND_API_KEY', gesetzt: gesetzt('RESEND_API_KEY'), zweck: 'Bestaetigungs- und Reset-Mails, Deploy-Alarm' },
      { name: 'DEPLOY_ALARM_MAIL', gesetzt: gesetzt('DEPLOY_ALARM_MAIL'), zweck: 'Empfaenger der Alarm-Mail bei gescheitertem Deploy' },
      { name: 'DEPLOY_WEBHOOK_SECRET', gesetzt: gesetzt('DEPLOY_WEBHOOK_SECRET'), zweck: 'Ohne ihn weist der Deploy-Webhook JEDEN Aufruf ab' },
      { name: 'KOFI_VERIFICATION_TOKEN', gesetzt: gesetzt('KOFI_VERIFICATION_TOKEN'), zweck: 'Ohne ihn wird jede Ko-fi-Spende verworfen' },
      { name: 'FEEDBACK_EMAIL', gesetzt: gesetzt('FEEDBACK_EMAIL'), zweck: 'Feedback zusaetzlich per Mail (die Ansicht hier ist davon unabhaengig)' },
      { name: 'PUBLIC_URL', gesetzt: gesetzt('PUBLIC_URL'), zweck: 'Adresse in Mail-Links und VAPID-Subject' }
    ],
    // Abgeleitete Betriebszustaende - sie beantworten dieselbe Art Frage wie die Liste darueber,
    // haengen aber nicht an einer Env-Variablen, sondern daran, ob etwas WIRKLICH geladen ist.
    laufzeit: {
      passwortlisteEintraege: BEKANNTE_PASSWOERTER.size,
      pushSchluesselDa: !!(VAPID_KEYS && VAPID_KEYS.publicKey),
      selbstheilungDa: typeof deployAufraeumen === 'function'
    }
  });
});

/* Einloesen. Die Sperre gegen das Durchprobieren ist der FEHLVERSUCHS-Zaehler am Konto darunter -
   und zwar BEWUSST OHNE `authRateLimit`, obwohl das der naheliegende Griff waere.

   GEMESSEN, warum: `authRateLimit` deckelt 15 Aufrufe je 15 Minuten und IP-Adresse und zaehlt
   dabei JEDEN Aufruf, auch die erfolgreichen. Im Test hatte ein Konto nach vier eingeloesten Codes
   und elf Rateversuchen die IP-Grenze erreicht - der Spieler bekam dann "Zu viele Versuche - bitte
   in ein paar Minuten erneut versuchen", eine Meldung, die mit Bonuscodes nichts zu tun hat und
   ihm nicht sagt, was los ist. Beim Login ist jeder Aufruf ein Versuch; hier ist ein Erfolg keiner.

   Der Konto-Zaehler ist die praezisere Sperre: Er zaehlt AUSSCHLIESSLICH Fehlversuche, wer seine
   Codes einloest laeuft nie hinein, und er greift auch bei wechselnden IPs. Nachgerechnet reicht er:
   Ein Code hat mindestens acht Zeichen aus 36 moeglichen, also 2,8 Billionen Kombinationen - bei
   zwoelf Fehlversuchen je Konto und Tag waere selbst mit tausend Konten nichts zu holen. Der
   Grundschutz gegen das blosse Zuschuetten des Servers bleibt `globalApiRateLimit` (240/Min fuer
   alle /api-Routen). */
app.post('/api/bonuscode/einloesen', authMiddleware, async (req, res) => {
  const schluessel = bonuscodeNormal((req.body || {}).code);
  const user = findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'Konto nicht gefunden.' });

  const heute = staubTagesschluessel();
  if (!user.bonusVersuche || user.bonusVersuche.stempel !== heute) user.bonusVersuche = { stempel: heute, n: 0 };
  if (user.bonusVersuche.n >= BONUSCODE_VERSUCHE_PRO_TAG) {
    return res.status(429).json({ error: 'Zu viele Fehlversuche heute. Versuch es morgen wieder.', gesperrt: true });
  }
  const fehlversuch = async (status, fehler, extra) => {
    user.bonusVersuche.n++;
    await saveDb();
    return res.status(status).json(Object.assign({ error: fehler, restVersuche: Math.max(0, BONUSCODE_VERSUCHE_PRO_TAG - user.bonusVersuche.n) }, extra || {}));
  };

  if (!schluessel) return fehlversuch(400, 'Bitte einen Code eingeben.');
  const eintrag = bonusCodes()[schluessel];
  if (!eintrag) return fehlversuch(404, 'Diesen Code gibt es nicht.');

  /* Ab hier ist der Code ECHT - die Ablehnungen darunter zaehlen deshalb NICHT als Fehlversuch.
     Wer einen gueltigen, aber abgelaufenen Code eintippt, hat nichts falsch gemacht. Und jede
     Ablehnung nennt den GRUND: Ein pauschales "ungueltig" macht aus einem abgelaufenen Code einen
     Fehlerbericht. */
  if (!eintrag.aktiv) return res.status(410).json({ error: 'Dieser Code ist nicht mehr aktiv.' });
  if (Date.now() > eintrag.gueltigBis) return res.status(410).json({ error: 'Dieser Code ist abgelaufen.', abgelaufen: true });
  user.bonusCodes = user.bonusCodes || {};
  if (user.bonusCodes[schluessel]) return res.status(409).json({ error: 'Diesen Code hast du bereits eingelöst.', schonEingeloest: true });
  if (eintrag.maxGesamt > 0 && eintrag.eingeloest >= eintrag.maxGesamt) {
    return res.status(409).json({ error: 'Dieser Code ist aufgebraucht - er galt nur für die ersten ' + eintrag.maxGesamt + ' Spieler.', aufgebraucht: true });
  }

  /* Buchung: Sperre und Zaehler VOR der Belohnung, beides im selben synchronen Block vor saveDb().
     Zwei parallele Anfragen koennen den Deckel so nicht gemeinsam durchbrechen - dieselbe
     Reihenfolge-Begruendung wie beim Markt-Tageskontingent. */
  user.bonusCodes[schluessel] = Date.now();
  eintrag.eingeloest++;
  pushPendingReward(req.userId, Object.assign({ type: 'bonuscode', code: eintrag.anzeige || schluessel }, eintrag.gaben));
  console.log('[bonuscode] eingeloest code=' + schluessel + ' userId=' + req.userId + ' gesamt=' + eintrag.eingeloest);
  await saveDb();
  res.json({ ok: true, code: eintrag.anzeige || schluessel, gaben: eintrag.gaben });
});

// Authentifizierter Selbstbedienungs-Endpunkt: Spieler trägt seine Ko-fi-E-Mail ein, Server gleicht
// sie mit den beim Webhook gespeicherten Spenden ab. Absichtlich KEIN Enumerations-Leck - die
// Fehlermeldung bei Nichttreffer verrät nicht, ob die E-Mail überhaupt schon einmal gespendet hat vs.
// falsch geschrieben wurde, beides derselbe generische Text.
app.post('/api/claim-supporter', authMiddleware, authRateLimit, async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Bitte eine gültige E-Mail-Adresse angeben.' });
  }
  const rec = (db.kofiDonationsByEmail || {})[email];
  if (!rec) return res.status(404).json({ error: 'Keine Ko-fi-Spende mit dieser E-Mail-Adresse gefunden.' });
  const user = findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'Account nicht gefunden.' });
  // ===== Eine Spende gehört zu EINEM Konto (05.08.2026) =====
  //
  // Bis hierher schrieb diese Route user.kofiEmail ohne zu prüfen, ob dieselbe Adresse schon einem
  // anderen Konto zugeordnet ist. Mit zwei Konten nachgestellt: Konto A spendet, Konto B trägt
  // dieselbe Adresse ein und bekommt Abzeichen UND - seit dem 05.08.2026 - die drei Automatiken,
  // ohne einen Cent gezahlt zu haben. Beliebig oft wiederholbar: Eine einmal bekannt gewordene
  // Spender-Adresse hätte unbegrenzt viele Konten freigeschaltet.
  //
  // Das widerspricht direkt der Zusicherung im Kommentar beim Webhook, die E-Mail sei "die
  // zuverlässige, nicht fälschbare Verknüpfung zu einem Spiel-Account" - fälschungssicher ist sie
  // nur, wenn sie auch EXKLUSIV ist. Ohne diese Prüfung war die E-Mail gegenüber dem verworfenen
  // Namens-Abgleich kein bisschen sicherer, sie war nur unbequemer.
  //
  // Der Fehlerfall (Adresse aus Versehen doppelt, Konto neu angelegt) ist kein Sackgassenfall:
  // Der Betreiber kann den Rang über /api/admin/grant-supporter direkt vergeben, und die Meldung
  // sagt genau das.
  const belegt = Object.values(db.users || {}).find(u => u && u.kofiEmail === email && u.userId !== req.userId);
  if (belegt) {
    console.warn('[claim-reject] userId=' + req.userId + ' username=' + req.username +
      ' wollte eine bereits vergebene Ko-fi-Adresse beanspruchen (gehört zu userId=' + belegt.userId + ').');
    return res.status(409).json({ error: 'Diese Ko-fi-Adresse ist bereits einem anderen Konto zugeordnet. Wenn das ein Versehen ist, melde dich beim Betreiber - er kann den Rang direkt vergeben.' });
  }
  user.kofiEmail = email;
  await saveDb();
  const status = supporterStatusFor(req.userId);
  res.json({ ok: true, active: status.active, tier: status.tier || null, daysLeft: status.active ? Math.max(0, Math.ceil(SUPPORTER_BADGE_DAYS - (Date.now() - status.lastDonationAt) / 86400000)) : 0 });
});
