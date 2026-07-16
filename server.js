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

const PORT = process.env.PORT || 3001;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');
const SECRET_FILE = process.env.SECRET_FILE || path.join(__dirname, 'jwt-secret.txt');

// Für Passwort-Reset-E-Mails (siehe ANLEITUNG.md, Abschnitt "Passwort-Reset einrichten")
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Kolonie Kepler-7 <onboarding@resend.dev>';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://gamegeeeeek.de';
const FEEDBACK_EMAIL = process.env.FEEDBACK_EMAIL || 'gamegeeeeek@outlook.de'; // Empfänger für Bug-Reports & Vorschläge aus dem Spiel (per .env überschreibbar)

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
webpush.setVapidDetails('mailto:' + FEEDBACK_EMAIL, VAPID_KEYS.publicKey, VAPID_KEYS.privateKey);

function loadDb() {
  if (!fs.existsSync(DB_FILE)) return { users: {}, private: {}, shared: {}, resetTokens: {} };
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!d.resetTokens) d.resetTokens = {};
    return d;
  } catch (e) { console.error('DB konnte nicht gelesen werden, starte mit leerer DB:', e); return { users: {}, private: {}, shared: {}, resetTokens: {} }; }
}
let db = loadDb();

let writeChain = Promise.resolve();
function saveDb() {
  writeChain = writeChain.then(() => new Promise((resolve, reject) => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), (err) => {
      if (err) return reject(err);
      fs.rename(tmp, DB_FILE, (err2) => err2 ? reject(err2) : resolve());
    });
  }));
  return writeChain;
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
app.use(cors());
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
// verify-Callback speichert den ROHEN Body zusätzlich (req.rawBody) - wird für die
// GitHub-Webhook-Signaturprüfung gebraucht, da express.json() den Body normalerweise nur geparst
// bereitstellt. Für alle anderen Routen ändert sich dadurch nichts.
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use('/api', globalApiRateLimit);

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Nicht angemeldet.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Sperr-Prüfung (13.07.2026, Feature-Wunsch: Moderation vorbereiten) - läuft bei JEDER
    // authentifizierten Anfrage, nicht nur beim Login: ein bereits ausgestelltes Token (180 Tage
    // gültig, wird sonst nie serverseitig invalidiert - siehe Kommentar bei /api/login) würde eine
    // Sperrung sonst erst beim nächsten Login-Versuch wirksam werden lassen, nicht sofort.
    const user = findUserById(payload.userId);
    if (user && user.banned) return res.status(403).json({ error: 'Dieses Konto wurde gesperrt.' });
    req.userId = payload.userId;
    req.username = payload.username;
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
// Minimale Kopie der Kostendaten aus ALLIANCE_TECH_DEFS/ALLIANCE_BUILDING_DEFS im Frontend - nur die
// für die Validierung nötigen Zahlen (Namen/Beschreibungen bleiben reine Frontend-Sache). MUSS bei
// Kostenänderungen im Frontend mitgepflegt werden, sonst lehnt der Server sonst legitime
// Freischaltungen ab (bzw. lässt bei veralteten, zu niedrigen Werten hier zu viel durch).
const ALLIANCE_STRUCTURE_COSTS = {
  a_prod:{cost:32000,costMult:2.0,maxLevel:20}, a_def:{cost:24000,costMult:2.0,maxLevel:20},
  a_atk:{cost:28000,costMult:2.0,maxLevel:20}, a_res:{cost:36000,costMult:2.0,maxLevel:20},
  a_trade:{cost:20000,costMult:2.0,maxLevel:20}, a_storage:{cost:24000,costMult:2.0,maxLevel:20},
  a_speed:{cost:34000,costMult:2.0,maxLevel:20}, a_scanner:{cost:40000,costMult:2.0,maxLevel:20},
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
    patchnotes: p.patchnotes !== false,
    application: p.application !== false
  };
}
function pushNotificationEvent(userId, type, payload) {
  if (!userId) return;
  if (!db.private[userId]) db.private[userId] = {};
  const list = db.private[userId].__notificationEvents || [];
  list.unshift({ id: crypto.randomUUID(), type, time: Date.now(), payload });
  db.private[userId].__notificationEvents = list.slice(0, 30);
  sendWebPushToUser(userId, type, payload); // schluckt eigene Fehler, blockiert nie den Aufrufer
}
// Lesbarer Titel/Text je Ereignistyp für die eigentliche Push-Nachricht (Postfach-Anzeige im
// Client hat ihre eigene, leicht andere Formulierung - hier bewusst kompakter fürs Benachrichtigungsfenster).
function pushNotificationText(type, payload) {
  if (type === 'pact-offer') return { title: 'Neues Pakt-Angebot', body: (payload.fromName || 'Ein Spieler') + ' bietet dir einen Nichtangriffspakt an.' };
  if (type === 'weltboss-kill') return { title: 'Weltboss besiegt!', body: 'Leviathan Stufe ' + (payload.level || 1) + ' erlegt - dein Beitrag: ' + (payload.share || 0) + '%.' };
  if (type === 'raid-incoming') return { title: 'Überfall!', body: 'Eine feindliche Flotte greift deine Kolonie an.' };
  if (type === 'message') return { title: 'Neue Nachricht', body: (payload.fromName || 'Ein Spieler') + ' hat dir geschrieben.' };
  if (type === 'patchnotes') return { title: 'Kolonie Kepler-7 aktualisiert', body: 'Version ' + (payload.version || '') + ' ist da - tippen für die Neuigkeiten.' };
  if (type === 'alliance-application') return { title: 'Neue Bewerbung', body: (payload.name || 'Ein Spieler') + ' möchte [' + (payload.tag || '') + '] beitreten.' };
  if (type === 'feedback-received') {
    const label = payload.type === 'idee' ? 'Verbesserungsvorschlag' : 'Bug-Report';
    return { title: 'Neuer ' + label, body: (payload.username || 'Ein Spieler') + ': ' + (payload.text || '') };
  }
  if (type === 'referral-redeemed') return { title: 'Einladungs-Bonus erhalten', body: (payload.username || 'Ein Spieler') + ' hat deinen Einladungscode eingelöst - +50 Kredite für dich!' };
  if (type === 'player-reported') return { title: 'Spieler gemeldet', body: (payload.reporterName||'Jemand') + ' hat ' + (payload.targetName||'einen Spieler') + ' gemeldet: ' + (payload.reason||'') };
  return { title: 'Kolonie Kepler-7', body: 'Es gibt Neuigkeiten.' };
}
// Verschickt eine echte Push-Benachrichtigung an ALLE registrierten Geräte eines Spielers. Abgelaufene
// Abos (Browser deinstalliert, Berechtigung entzogen - erkennbar an HTTP 404/410 vom Push-Dienst)
// werden automatisch aus der DB entfernt, damit die Liste nicht endlos mit toten Einträgen wächst.
async function sendWebPushToUser(userId, type, payload) {
  try {
    const subs = (db.private[userId] && db.private[userId].__pushSubscriptions) || [];
    if (!subs.length) return;
    const { title, body } = pushNotificationText(type, payload);
    const message = JSON.stringify({ title, body, type, payload, time: Date.now() });
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
// Muss zur STAR_SYSTEMS-Liste im Frontend (weltraum_kolonie.html) passen.
// Vollständige Systemliste mit Karten-Koordinaten (identisch zu STAR_SYSTEMS im Frontend), damit die
// NPC-Territorium-Simulation Nachbarschaften über die tatsächliche Kartenposition berechnen kann.
const SYSTEM_COORDS = [
  { id: 'kepler', gx: 510.2, gy: 242.9 },
  { id: 'vega', gx: 518.3, gy: 276.5 },
  { id: 'orion', gx: 455.8, gy: 296.2 },
  { id: 'nebel', gx: 348.6, gy: 270.0 },
  { id: 'rand', gx: 309.1, gy: 181.4 },
  { id: 'krux', gx: 462.3, gy: 272.0 },
  { id: 'aether', gx: 395.9, gy: 244.7 },
  { id: 'vortex', gx: 393.1, gy: 211.1 },
  { id: 'chronos', gx: 477.5, gy: 144.9 },
  { id: 'solmark', gx: 635.0, gy: 153.5 },
  { id: 'drachenmark', gx: 457.9, gy: 207.4 },
  { id: 'abyss', gx: 505.0, gy: 192.9 },
  { id: 'nyra', gx: 599.5, gy: 218.5 },
  { id: 'pulsar', gx: 593.8, gy: 304.9 },
  { id: 'sigma', gx: 466.2, gy: 355.9 },
  { id: 'sys_corvus_weite', gx: 688.4, gy: 236.9 },
  { id: 'sys_halcyon_feld', gx: 669.7, gy: 350.1 },
  { id: 'sys_meridian_bogen', gx: 500.0, gy: 416.3 },
  { id: 'sys_thule_reichweite', gx: 295.4, gy: 412.2 },
  { id: 'sys_oort_schleuse', gx: 142.3, gy: 282.3 },
  { id: 'sys_xerxes_zone', gx: 152.5, gy: 112.5 },
  { id: 'sys_ashen_grat', gx: 493.4, gy: 359.0 },
  { id: 'sys_ilyra_strom', gx: 321.5, gy: 342.1 },
  { id: 'sys_kessel_anomalie', gx: 206.6, gy: 274.6 },
  { id: 'sys_vantar_riff', gx: 215.0, gy: 145.2 },
  { id: 'sys_quorin_passage', gx: 377.6, gy: 35.1 },
  { id: 'sys_ember_reichweite', gx: 651.5, gy: 24.5 },
  { id: 'sys_silberbach', gx: 280.9, gy: 255.9 },
  { id: 'sys_nachtsegel_zone', gx: 292.5, gy: 145.9 },
  { id: 'sys_grendel_feld', gx: 426.9, gy: 73.3 },
  { id: 'sys_aurelia_bogen', gx: 660.0, gy: 91.3 },
  { id: 'sys_marek_schneise', gx: 832.0, gy: 175.7 },
  { id: 'sys_talon_ring', gx: 826.1, gy: 352.3 },
  { id: 'sys_wispern_nebel', gx: 448.8, gy: 100.5 },
  { id: 'sys_cinder_reichweite', gx: 602.4, gy: 98.3 },
  { id: 'sys_obsidian_guertel', gx: 760.4, gy: 181.7 },
  { id: 'sys_halvar_weite', gx: 757.8, gy: 322.9 },
  { id: 'sys_sernova_feld', gx: 628.0, gy: 429.2 },
  { id: 'sys_dunwich_passage', gx: 352.7, gy: 470.5 },
  { id: 'zenith', gx: 671.2, gy: 219.1 },
  { id: 'tiefsee', gx: 279.1, gy: 230.3 }
];
const SYSTEMS = SYSTEM_COORDS.map(s => s.id);
// Nachbarn eines Systems: die k nächstgelegenen anderen Systeme (euklidische Distanz auf der Karte).
// Wird für Fraktions-Expansion (nur in benachbarte Systeme) genutzt.
const SYSTEM_NEIGHBORS = {};
(function computeNeighbors() {
  const K = 4;
  for (const s of SYSTEM_COORDS) {
    const dists = SYSTEM_COORDS
      .filter(o => o.id !== s.id)
      .map(o => ({ id: o.id, d: Math.hypot(o.gx - s.gx, o.gy - s.gy) }))
      .sort((a, b) => a.d - b.d);
    SYSTEM_NEIGHBORS[s.id] = dists.slice(0, K).map(x => x.id);
  }
})();
const HOME_SLOTS_PER_SYSTEM = 8;
function assignHomeSlot() {
  const taken = new Set(Object.values(db.users).filter(u => u.homeSystem).map(u => u.homeSystem + ':' + u.homeSlot));
  const free = [];
  for (const sys of SYSTEMS) for (let slot = 0; slot < HOME_SLOTS_PER_SYSTEM; slot++) {
    const key = sys + ':' + slot;
    if (!taken.has(key)) free.push({ system: sys, slot });
  }
  if (!free.length) return { system: SYSTEMS[Math.floor(Math.random() * SYSTEMS.length)], slot: Math.floor(Math.random() * HOME_SLOTS_PER_SYSTEM) };
  return free[Math.floor(Math.random() * free.length)];
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

// --- Registrierung (E-Mail optional, aber nötig für Passwort-Reset) ---
app.post('/api/register', authRateLimit, async (req, res) => {
  const { username, password, email } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Name und Passwort erforderlich.' });
  const cleanName = String(username).trim();
  if (!/^[a-zA-Z0-9_\-äöüÄÖÜß]{3,18}$/.test(cleanName)) {
    return res.status(400).json({ error: cleanName.includes('@') ? 'Das erste Feld ist dein Spielername (kein @-Zeichen) - deine E-Mail-Adresse gehört ins E-Mail-Feld darunter. Beispiel-Name: Sternenjäger_7' : 'Bitte wähle einen Spielernamen mit 3 bis 18 Zeichen. Erlaubt sind Buchstaben, Zahlen sowie _ und - (keine Leer- oder Sonderzeichen). Beispiel: Sternenjäger_7' });
  }
  if (String(password).length < 6) return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben.' });
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

  const token = jwt.sign({ userId: user.userId, username: user.username }, JWT_SECRET, { expiresIn: '180d' });
  res.json({ token, userId: user.userId, username: user.username });
});

// Hinweis Mehrgeräte-Login: JWTs werden hier nicht serverseitig "verbraucht" oder invalidiert -
// jede Anmeldung erzeugt ein unabhängiges, gültiges Token. Man kann sich also auf beliebig
// vielen Geräten gleichzeitig einloggen, ohne dass sich die Geräte gegenseitig ausloggen.

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
  res.json({
    userId: req.userId, username: req.username,
    hasEmail: !!(user && user.email),
    maskedEmail: user ? maskEmail(user.email) : '',
    pendingEmail: user && user.pendingEmail ? maskEmail(user.pendingEmail) : null,
    wantsPatchnotes: user ? (user.wantsPatchnotes !== false) : true,
    homeSystem: user && user.homeSystem, homeSlot: user && user.homeSlot
  });
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
  if (String(newPassword || '').length < 6) return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben.' });
  const user = findUserById(entry.userId);
  if (!user) return res.status(404).json({ error: 'Account nicht gefunden.' });
  user.passwordHash = await bcrypt.hash(newPassword, 10);
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
    const denyReason = checkAllianceKeyPermission(req, key, false) || checkPactKeyPermission(req, key, false) || checkChatKeyPermission(req, key, false) || checkHallOfFamePermission(req, key, false);
    if (denyReason) return res.status(403).json({ error: denyReason });
  }
  const store = shared ? db.shared : (db.private[req.userId] || {});
  const entry = store[key];
  if (entry === undefined) return res.status(404).json({ error: 'not found' });
  if (shared || typeof entry === 'string') return res.json({ key, value: entry, shared, version: 0 });
  res.json({ key, value: entry.value, shared, version: entry.version || 0 });
});

app.put('/api/storage/:key', authMiddleware, async (req, res) => {
  const shared = req.query.shared === 'true';
  const key = req.params.key;
  const value = (req.body && typeof req.body.value === 'string') ? req.body.value : JSON.stringify(req.body ? req.body.value : null);
  const expectedVersion = req.body ? req.body.expectedVersion : undefined;

  if (shared) {
    const denyReason = checkAllianceKeyPermission(req, key, true) || checkPactKeyPermission(req, key, true) || checkChatKeyPermission(req, key, true) || checkHallOfFamePermission(req, key, true);
    if (denyReason) return res.status(403).json({ error: denyReason });
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
  db.private[req.userId][key] = { value, version: newVersion };
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

// --- Berichte (Angriffs-/Überfall-Protokolle) ---
app.get('/api/reports', authMiddleware, (req, res) => {
  const list = (db.private[req.userId] && db.private[req.userId].__reports) || [];
  res.json({ reports: list });
});

app.post('/api/reports', authMiddleware, async (req, res) => {
  const report = req.body && req.body.report;
  if (!report) return res.status(400).json({ error: 'Kein Bericht übergeben.' });
  addReport(req.userId, report);
  await saveDb();
  res.json({ ok: true });
});

function addReport(userId, report) {
  db.private[userId] = db.private[userId] || {};
  const list = db.private[userId].__reports || [];
  list.unshift(Object.assign({ id: crypto.randomUUID(), time: Date.now() }, report));
  db.private[userId].__reports = list.slice(0, 40);
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
// Verteidigungsanlage "flak" taucht im Frontend auf, war hier nie in DEFENSE_VALUES enthalten.
const DEFENSE_VALUES = { turm: 15, flak: 20, schild: 30, laser: 25, plasma: 50, raketen: 40, gauss: 65, festung: 150 };
// Muss exakt synchron zu SHIP_SCORE_WEIGHTS im Frontend bleiben (dort die eigentliche Quelle für
// computeScore()) - bei Änderungen dort immer auch hier nachpflegen, sonst weicht der serverseitig
// validierte Score vom eigentlich beabsichtigten Wert ab.
const SHIP_SCORE_WEIGHTS = {
  ships:15, cruisers:25, jaeger:12, destroyers:35, bomber:45,
  schlachtschiff:70, carrier:30, superschlachtschiff:180, waechter:20,
  forscher:20, frachter:10, frachtergross:40, spaeher:15, spionageschiff:22, colonyShips:5, recycler:12
};
// Bug/Sicherheitslücke behoben (13.07.2026, danke an Sascha für den Hinweis): der Bestenlisten-Score
// wurde bisher komplett clientseitig berechnet und ungeprüft übernommen - jeder hätte sich per
// Browser-Entwicklertools einen beliebigen Score eintragen und sich damit auch die wöchentliche
// Liga-Einstufung (samt echter Belohnung) erschummeln können. Rechnet jetzt exakt dieselbe Formel wie
// computeScore() im Frontend nach, aber aus dem tatsächlichen gespeicherten Spielstand.
function computeScoreServer(save) {
  const buildLvl = allBuildingsOf(save).reduce((sum, b) => sum + Object.values(b).reduce((a, v) => a + (Number(v) || 0), 0), 0);
  let shipScore = 0;
  for (const f of allFleetsOf(save)) for (const [key, weight] of Object.entries(SHIP_SCORE_WEIGHTS)) shipScore += (f[key] || 0) * weight;
  const researchScore = Object.values(save.research || {}).reduce((a, lvl) => a + (Number(lvl) || 0), 0) * 8;
  const colonyKeys = Object.keys(save.colonies || {});
  const moonCount = colonyKeys.filter(k => typeof k === 'string' && k.indexOf('moon_') === 0).length;
  const colonyCount = colonyKeys.length - moonCount;
  const expansionScore = colonyCount * 200 + moonCount * 150;
  return Math.floor(buildLvl * 10 + shipScore + researchScore + expansionScore + (save.battlePoints || 0) * 3 + (save.prestige || 0) * 500 + ((save.ascension && save.ascension.count) || 0) * 5000);
}

// Schiffs-Kontersystem (Schere-Stein-Papier) – identisch zum Frontend. Bei echtem PvP sind BEIDE
// Flottenzusammensetzungen bekannt (anders als bei NPC-Kämpfen), wirkt hier also immer.
const SHIP_COUNTERS = {
  jaeger: { strongVs: ['bomber'], weakVs: ['cruisers', 'destroyers'] },
  bomber: { strongVs: ['cruisers', 'destroyers'], weakVs: ['jaeger'] },
  cruisers: { strongVs: ['jaeger'], weakVs: ['bomber'] },
  destroyers: { strongVs: ['jaeger'], weakVs: ['bomber'] }
};
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
function allBuildingsOf(save) {
  const list = [save.buildings].filter(Boolean);
  for (const c of Object.values(save.colonies || {})) if (c && c.buildings) list.push(c.buildings);
  return list;
}
// Rohe Flottenkraft EINES Flottenobjekts, mit Grenznutzen-Deckel, aber OHNE Taktik-Haltung/Konter –
// wird für den Verteidigungsbeitrag der eigenen Flotte gebraucht (analog Frontend attackPowerRaw),
// damit Taktik-Haltung dort nicht doppelt bzw. falsch (Angriffs- statt Verteidigungsmultiplikator)
// einfließt.
function rawFleetPower(f) {
  if (!f) return 0;
  return diminishingShipCount(f.cruisers || 0) * 20 + diminishingShipCount(f.destroyers || 0) * 45 + diminishingShipCount(f.ships || 0) * 5 +
    diminishingShipCount(f.jaeger || 0) * 10 + diminishingShipCount(f.bomber || 0) * 60 + diminishingShipCount(f.schlachtschiff || 0) * 90 +
    diminishingShipCount(f.carrier || 0) * 15 + diminishingShipCount(f.superschlachtschiff || 0) * 220 + diminishingShipCount(f.waechter || 0) * 8;
}
// Verteidigungsspezialisierung (13.07.2026) - defWeight-Gewichte identisch zum Frontend (SHIP_DEFS),
// wirken NUR hier auf die Verteidigung, nie auf die Angriffskraft. Keine Schilde hier (der Backend-
// Ansatz kennt generell keine Schilde, vorbestehende Vereinfachung gegenüber dem Frontend).
const SHIP_DEF_WEIGHTS = { jaeger:0.7, carrier:0.8, destroyers:0.9, bomber:0.5, waechter:2.0, schlachtschiff:1.3, superschlachtschiff:1.3 };
const SHIP_ATK_VALUES = { cruisers:20, destroyers:45, ships:5, jaeger:10, bomber:60, schlachtschiff:90, carrier:15, superschlachtschiff:220, waechter:8 };
function weightedFleetDefensePower(f) {
  if (!f) return 0;
  let sum = 0;
  for (const [k, atk] of Object.entries(SHIP_ATK_VALUES)) {
    const count = f[k] || 0;
    if (!count) continue;
    sum += diminishingShipCount(count) * atk * (SHIP_DEF_WEIGHTS[k] !== undefined ? SHIP_DEF_WEIGHTS[k] : 1);
  }
  return sum;
}
// Flotten-Diversitäts-Bonus - identisch zum Frontend (fleetDiversityMult).
const FLEET_DIVERSITY_COMBAT_KEYS = ['jaeger','cruisers','destroyers','bomber','schlachtschiff','superschlachtschiff','carrier','waechter'];
const FLEET_DIVERSITY_BONUS_PER_TYPE = 0.02, FLEET_DIVERSITY_MAX_TYPES = 5;
function fleetDiversityMult(fleet) {
  if (!fleet) return 1;
  const distinctTypes = FLEET_DIVERSITY_COMBAT_KEYS.filter(k => (fleet[k] || 0) > 0).length;
  const bonusTypes = Math.max(0, Math.min(FLEET_DIVERSITY_MAX_TYPES, distinctTypes) - 1);
  return 1 + bonusTypes * FLEET_DIVERSITY_BONUS_PER_TYPE;
}
// enemyFleetForCounter: die GESAMTE gegnerische Flotte (fleetSummary), optional – nur bei echtem PvP
// bekannt und übergeben, macht das Kontersystem wirksam.
function computeAttackPower(save, enemyFleetForCounter) {
  const research = save.research || {};
  let power = 0;
  for (const f of allFleetsOf(save)) {
    let fp = rawFleetPower(f) * fleetDiversityMult(f);
    if (enemyFleetForCounter) fp *= counterMultiplier(f, enemyFleetForCounter);
    power += fp;
  }
  const k = research.rkampf || 0, k2 = research.rkampf2 || 0;
  if (k) power *= (1 + k * 0.02);
  if (k2) power *= (1 + k2 * 0.02);
  power *= stanceOf(save).atkMult;
  return Math.round(power);
}
function computeDefensePower(save) {
  const research = save.research || {};
  let power = 0;
  // Heimatbasis (save.buildings/save.fleet) bekommt +20% ggü. Kolonien - getrennt behandeln.
  const homeBuildings = save.buildings || {};
  let homeBuildingSub = 0;
  for (const [k, v] of Object.entries(DEFENSE_VALUES)) homeBuildingSub += (homeBuildings[k] || 0) * v;
  power += homeBuildingSub * HOME_DEFENSE_BONUS;
  for (const c of Object.values(save.colonies || {})) {
    if (!c || !c.buildings) continue;
    for (const [k, v] of Object.entries(DEFENSE_VALUES)) power += (c.buildings[k] || 0) * v;
  }
  power += Math.round(weightedFleetDefensePower(save.fleet) * fleetDiversityMult(save.fleet) * 0.4) * HOME_DEFENSE_BONUS;
  for (const c of Object.values(save.colonies || {})) {
    if (!c || !c.fleet) continue;
    power += Math.round(weightedFleetDefensePower(c.fleet) * fleetDiversityMult(c.fleet) * 0.4);
  }
  const p = research.rpanzer || 0, s = research.rschildmatrix || 0;
  if (p) power *= (1 + p * 0.02);
  if (s) power *= (1 + s * 0.02);
  power *= stanceOf(save).defMult;
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

app.post('/api/attack', attackRateLimit, authMiddleware, async (req, res) => {
  const { targetUserId } = req.body || {};
  if (!targetUserId || targetUserId === req.userId) return res.status(400).json({ error: 'Ungültiges Ziel.' });

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
  const attackPower = computeAttackPower(attacker, targetFleetSummary);
  const defensePower = computeDefensePower(target);
  const chance = Math.max(0.1, Math.min(0.9, attackPower / (attackPower + defensePower)));
  const success = Math.random() < chance;

  const defenseBefore = defenseBreakdown(target);

  if (success) {
    const lootPct = 0.12 + Math.random() * 0.13; // 12-25%
    // Anti-Farming: deutlich stärkere Angreifer bekommen anteilig weniger Beute (nie unter 30%).
    const farmPenalty = farmingPenaltyFor(req.userId, targetUserId);
    const stolen = {};
    for (const [r, amt] of Object.entries(target.resources || {})) {
      const take = Math.floor((amt || 0) * lootPct * farmPenalty);
      if (take > 0) {
        stolen[r] = take;
        target.resources[r] = Math.max(0, (target.resources[r] || 0) - take);
        attacker.resources[r] = (attacker.resources[r] || 0) + take;
      }
    }
    let destroyedBuilding = null;
    const buildingSets = allBuildingsOf(target);
    const candidates = [];
    for (const b of buildingSets) for (const k of Object.keys(DEFENSE_VALUES)) if ((b[k] || 0) > 0) candidates.push([b, k]);
    if (candidates.length) {
      const [b, k] = candidates[Math.floor(Math.random() * candidates.length)];
      b[k] = Math.max(0, b[k] - 1);
      destroyedBuilding = k;
    }
    attacker.battlePoints = (attacker.battlePoints || 0) + 25;

    const mySaveVersion = setSaveValue(req.userId, JSON.stringify(attacker));
    setSaveValue(targetUserId, JSON.stringify(target));

    addReport(req.userId, {
      type: 'attack-sent', result: 'win', targetName: targetUser ? targetUser.username : 'Unbekannt',
      attackPower, defensePower, stolen, destroyedBuilding, defenseBefore, fleet: attackerFleetSummary
    });
    addReport(targetUserId, {
      type: 'attack-received', result: 'loss', attackerName: req.username,
      attackPower, defensePower, stolen, destroyedBuilding, defenseBefore, fleet: attackerFleetSummary
    });
    await saveDb();
    return res.json({ success: true, stolen, destroyedBuilding, attackPower, defensePower, saveVersion: mySaveVersion });
  } else {
    attacker.battlePoints = (attacker.battlePoints || 0) + 3;
    const mySaveVersion = setSaveValue(req.userId, JSON.stringify(attacker));

    addReport(req.userId, {
      type: 'attack-sent', result: 'loss', targetName: targetUser ? targetUser.username : 'Unbekannt',
      attackPower, defensePower, defenseBefore, fleet: attackerFleetSummary
    });
    addReport(targetUserId, {
      type: 'attack-received', result: 'win', attackerName: req.username,
      attackPower, defensePower, defenseBefore, fleet: attackerFleetSummary
    });
    await saveDb();
    return res.json({ success: false, attackPower, defensePower, saveVersion: mySaveVersion });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, users: Object.keys(db.users).length }));

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
      setSaveValue(referrer.userId, JSON.stringify(referrerSave));
      try {
        pushNotificationEvent(referrer.userId, 'referral-redeemed', { username: req.username });
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
    patchnotes: b.patchnotes !== false,
    application: b.application !== false
  };
  await saveDb();
  res.json(getNotifPrefs(user));
});
app.get('/api/notifications', authMiddleware, (req, res) => {
  const list = (db.private[req.userId] && db.private[req.userId].__notificationEvents) || [];
  res.json({ notifications: list });
});
app.post('/api/notifications/dismiss', authMiddleware, async (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
  if (db.private[req.userId] && db.private[req.userId].__notificationEvents) {
    db.private[req.userId].__notificationEvents = db.private[req.userId].__notificationEvents.filter(n => !ids.includes(n.id));
  }
  await saveDb();
  res.json({ ok: true });
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
app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
  const sub = req.body || {};
  if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'Ungültiges Push-Abonnement.' });
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

app.listen(PORT, () => {
  console.log('Kepler-7 Server läuft auf Port ' + PORT);
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
  if (db.galaxy.activeWar === undefined) db.galaxy.activeWar = null;
  if (!db.galaxy.collapsedSystems) db.galaxy.collapsedSystems = {};
  if (db.galaxy.activeWormhole === undefined) db.galaxy.activeWormhole = null;
  if (!db.galaxy.news) db.galaxy.news = [];
  if (!db.galaxy.lastTick) db.galaxy.lastTick = Date.now();
  if (!db.galaxy.controlledSystems) db.galaxy.controlledSystems = {}; // systemId -> userId (vom Spieler eroberte Systeme)
  if (db.galaxy.worldBoss === undefined) db.galaxy.worldBoss = null;
  loadOrInitMarket(db.galaxy);
  loadOrInitFactions(db.galaxy);
  return db.galaxy;
}

// ============ Galaktischer Weltboss ============
// Ein gemeinsamer Server-Gegner für ALLE Spieler: er hat einen geteilten HP-Pool, jeder kann ihn (mit
// Abklingzeit) angreifen, jeder Angriff zieht echte HP ab. Wer den Todesstoß setzt, bekommt die große
// Belohnung; jeder Angriff gibt eine kleine. Belohnungen werden nur für den ANFRAGENDEN Spieler in
// dessen Spielstand geschrieben (keine Schreibzugriffe auf fremde Spielstände - die würden mit dem
// Autosave online spielender Nutzer kollidieren).
const WORLD_BOSS_NAMES = ['Leviathan der Leere', 'Chronos-Verschlinger', 'Die Singularität', 'Wächter des Abgrunds', 'Nova-Titan'];
function spawnWorldBoss(g) {
  const users = Math.max(1, Object.keys(db.users).length);
  const maxHp = Math.round(40000 * (1 + users * 0.4));
  g.worldBoss = {
    id: crypto.randomUUID(),
    name: WORLD_BOSS_NAMES[Math.floor(Math.random() * WORLD_BOSS_NAMES.length)],
    maxHp, hp: maxHp,
    system: pickRandomFreeSystem(),
    expiresAt: Date.now() + 72 * 3600 * 1000,
    participants: {},   // userId -> Gesamtschaden (für die Bestenliste)
    lastAttack: {}      // userId -> Zeitstempel des letzten Angriffs (Abklingzeit)
  };
  pushGalaxyNews('ti-alien', 'WELTBOSS: ' + g.worldBoss.name + ' ist bei ' + g.worldBoss.system + ' erschienen! Alle Kommandanten können ihn gemeinsam bekämpfen (' + maxHp.toLocaleString('de-DE') + ' HP).');
}

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
function pickRandomFreeSystem() {
  const occupied = occupiedSystems();
  const free = SYSTEMS.filter(s => !occupied.has(s));
  return free.length ? free[Math.floor(Math.random()*free.length)] : SYSTEMS[Math.floor(Math.random()*SYSTEMS.length)];
}
function galaxyTick() {
  const g = loadOrInitGalaxy();
  g.lastTick = Date.now();

  // NPC-Reiche wachsen langsam, gedeckelt bei 2.5x, damit es nicht unendlich eskaliert.
  g.npcEmpireStrength = Math.min(2.5, g.npcEmpireStrength * (1 + 0.002 + Math.random() * 0.003));
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
  for (const [key, info] of Object.entries(MARKET_RESOURCES)) {
    const cur = market[key];
    const recoverRate = cur < info.basePrice ? MARKET_SELL_RECOVERY_RATE : MARKET_BUY_RECOVERY_RATE;
    const towardBase = cur + (info.basePrice - cur) * recoverRate;
    const noise = towardBase * (Math.random() - 0.5) * 0.05;
    market[key] = clampMarketPrice(key, towardBase + noise);
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
  // Abgelaufenen Krieg beilegen.
  if (g.activeWar && g.activeWar.expiresAt < Date.now()) {
    pushGalaxyNews('ti-flag', 'Der Krieg um ' + g.activeWar.system + ' ist beigelegt.');
    g.activeWar = null;
  }

  // Zufällige galaktische Ereignisse, jeweils unabhängige Chance pro Tick (alle 15 Min.). Jedes
  // ortsgebundene Ereignis bekommt jetzt ein echtes, freies (unbesiedeltes) System zugewiesen, damit
  // es auf der Sektorkarte sichtbar gemacht werden kann.
  if (Math.random() < 0.12 && !g.activeWar) {
    const a = NPC_FACTION_NAMES[Math.floor(Math.random() * NPC_FACTION_NAMES.length)];
    let b = NPC_FACTION_NAMES[Math.floor(Math.random() * NPC_FACTION_NAMES.length)];
    if (b === a) b = NPC_FACTION_NAMES[(NPC_FACTION_NAMES.indexOf(a) + 1) % NPC_FACTION_NAMES.length];
    const sys = pickRandomFreeSystem();
    g.activeWar = { factionA: a, factionB: b, system: sys, expiresAt: Date.now() + 36 * 3600 * 1000 };
    pushGalaxyNews('ti-sword', 'Krieg ausgebrochen: ' + a + ' und ' + b + ' liefern sich Gefechte um ' + sys + '.');
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

  // ===== Weltboss: spawnen, wenn keiner aktiv; abgelaufene entfernen =====
  if (g.worldBoss && g.worldBoss.expiresAt < Date.now()) {
    pushGalaxyNews('ti-alien', g.worldBoss.name + ' hat sich zurückgezogen, ohne besiegt zu werden (' + Math.round((1 - g.worldBoss.hp / g.worldBoss.maxHp) * 100) + '% Schaden erlitten).');
    g.worldBoss = null;
  }
  if (!g.worldBoss && Math.random() < 0.10) spawnWorldBoss(g);

  saveDb();
}
setInterval(galaxyTick, GALAXY_TICK_MS);
galaxyTick(); // einmal sofort beim Serverstart, damit nicht 15 Min. auf den ersten Zustand gewartet wird

app.get('/api/galaxy', authMiddleware, (req, res) => {
  res.json(loadOrInitGalaxy());
});

// Aktuelle Marktpreise abrufen (inkl. Normalpreis, damit das Frontend "teuer/billig" anzeigen kann).
app.get('/api/market', authMiddleware, (req, res) => {
  const g = loadOrInitGalaxy();
  const market = loadOrInitMarket(g);
  const out = {};
  for (const key of Object.keys(MARKET_RESOURCES)) {
    out[key] = { price: market[key], basePrice: MARKET_RESOURCES[key].basePrice };
  }
  res.json({ market: out });
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
  const impact = (amt / 1000) * MARKET_IMPACT_PER_1000 * MARKET_RESOURCES[resource].basePrice;
  const priceAfterRaw = action === 'buy' ? priceBefore + impact : priceBefore - impact;
  const priceAfter = clampMarketPrice(resource, priceAfterRaw);
  const avgPrice = (priceBefore + priceAfter) / 2;
  const discount = marketDiscountPctFor(save);
  // Verkaufserlös zusätzlich um 20% reduziert (realistischer Geld-Brief-Spread), Kartell-/Allianz-
  // Rabatt wirkt beim Verkauf als Bonus obendrauf, beim Kauf als Abzug von den Kosten.
  const MARKET_SELL_SPREAD = 0.80;
  let credits;
  if (action === 'sell') {
    if ((save.resources[resource] || 0) < amt) return res.status(400).json({ error: 'Nicht genug ' + resource + ' zum Verkaufen.' });
    credits = Math.round(avgPrice * amt * MARKET_SELL_SPREAD * (1 + discount));
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

  res.json({
    ok: true,
    action, resource, amount: amt,
    credits,                 // beim Kauf: Kosten; beim Verkauf: Erlös (Rabatt bereits eingerechnet)
    discount,
    avgPrice,
    priceBefore, priceAfter,
    saveVersion: mySaveVersion,
    newCredits: save.credits,
    newResourceAmount: save.resources[resource]
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
function fleetHasShipType(fleet, type) {
  if (!fleet) return false;
  const fleetKey = { jaeger:'jaeger', bomber:'bomber', cruiser:'cruisers', destroyer:'destroyers', schlachtschiff:'schlachtschiff' }[type] || type;
  return (fleet[fleetKey] || 0) > 0;
}
function computeAttackPowerFromComposition(save, composition, bossLevel) {
  const research = save.research || {};
  let power = rawFleetPower(composition) * fleetDiversityMult(composition);
  const k = research.rkampf || 0, k2 = research.rkampf2 || 0;
  if (k) power *= (1 + k * 0.02);
  if (k2) power *= (1 + k2 * 0.02);
  power *= stanceOf(save).atkMult;
  if (bossLevel && fleetHasShipType(composition, worldBossWeakness(bossLevel))) power *= 1.25;
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
    const lossPct = Math.min(0.5, (0.08 + bLevel * 0.01) + Math.random() * 0.07);
    for (const k of ['jaeger','cruisers','destroyers','bomber','schlachtschiff','carrier','superschlachtschiff','frachter','frachtergross','waechter']) {
      const sentCount = composition[k] || 0;
      if (sentCount <= 0) continue;
      const loseNow = Math.min(fleetObj[k] || 0, Math.round(sentCount * lossPct));
      if (loseNow > 0) { fleetObj[k] = Math.max(0, (fleetObj[k] || 0) - loseNow); lostShips[k] = loseNow; }
    }
    save.battlePoints = (save.battlePoints || 0) + 3 + bLevel;
  }

  const mySaveVersion = setSaveValue(req.userId, JSON.stringify(save));
  await saveDb();

  res.json({
    ok: true, arrivedTooLate, killed, damage: dmg,
    bossHp: bossHpAfter, bossMaxHp, lostShips,
    hasWeakness: bossHasWeakness, weaknessType: bossWeakness,
    saveVersion: mySaveVersion,
    newCredits: save.credits, newBattlePoints: save.battlePoints
  });
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
    return res.json({ success: true, systemId, attackPower, factionDefense, creditReward, factionName: owner.name, saveVersion: mySaveVersion });
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
    return res.json({ success: false, systemId, attackPower, factionDefense, lost, factionName: owner.name, saveVersion: mySaveVersion });
  }
});

// ============ GitHub-Deploy-Webhook: sofortiges Update statt Warten auf den Cron-Job ============
// GitHub ruft diese URL direkt nach einem Push auf. Sicherheit über HMAC-SHA256-Signaturprüfung
// (GITHUB_WEBHOOK_SECRET muss identisch in den GitHub-Repo-Einstellungen UND hier als
// Umgebungsvariable hinterlegt sein). WICHTIG: Die auszuführenden Befehle sind fest verdrahtet
// (DEPLOY_TARGETS) und werden NIEMALS aus dem Request-Body übernommen - nur der Repo-NAME aus dem
// GitHub-Payload entscheidet, welcher der zwei festen Befehle läuft. Das verhindert Command-
// Injection über einen manipulierten Payload, selbst wenn die Signaturprüfung umgangen würde.
const { exec } = require('child_process');
const DEPLOY_WEBHOOK_SECRET = process.env.DEPLOY_WEBHOOK_SECRET || '';
const DEPLOY_TARGETS = {
  'kolonie-kepler7': 'cd /deploy/kolonie-kepler7 && git pull -q && cp weltraum_kolonie.html /deploy/web/ && (cp manifest.json /deploy/web/ || true) && (cp icon-*.png /deploy/web/ || true) && (cp apple-touch-icon.png /deploy/web/ || true) && (cp service-worker.js /deploy/web/ || true)',
  'kolonie-kepler7-backend': 'cd /app && git pull -q'
};
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
app.post('/api/deploy-webhook', (req, res) => {
  if (!verifyGithubSignature(req)) {
    console.warn('Deploy-Webhook: ungültige oder fehlende Signatur, Anfrage abgelehnt.');
    return res.status(401).json({ error: 'invalid signature' });
  }
  const repoName = req.body && req.body.repository && req.body.repository.name;
  const command = DEPLOY_TARGETS[repoName];
  if (!command) {
    console.warn('Deploy-Webhook: unbekanntes Repo im Payload:', repoName);
    return res.status(400).json({ error: 'unknown repo' });
  }
  // Sofort antworten, git pull läuft asynchron im Hintergrund weiter - GitHub erwartet eine
  // schnelle Antwort und markiert den Webhook sonst als fehlgeschlagen.
  res.json({ ok: true, repo: repoName });
  exec(command, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) console.error('Deploy-Webhook Fehler für ' + repoName + ':', err.message);
    else console.log('Deploy-Webhook erfolgreich für ' + repoName + ':', stdout.trim() || '(keine Änderungen)');
  });
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
      const name = String(payload.from_name).trim().slice(0, 60) || 'Anonym';
      db.kofiSupporters[name] = (db.kofiSupporters[name] || 0) + amount;
    } else {
      db.kofiSupportersAnonymousTotal = (db.kofiSupportersAnonymousTotal || 0) + amount;
    }
    saveDb();
    console.log('Ko-fi-Webhook verarbeitet: ' + (payload.type || 'Zahlung') + ' über ' + amount + ' ' + (payload.currency || '') + (payload.is_public ? ' von ' + payload.from_name : ' (anonym)'));
  } catch (e) { console.error('Ko-fi-Webhook Fehler:', e.message); }
});
// Öffentlicher, unauthentifizierter Endpunkt - liefert NUR den Namen und Gesamtbetrag des aktuellen
// Top-Unterstützers, keine sensiblen Daten wie E-Mail oder einzelne Zahlungen.
app.get('/api/kofi-top-supporter', (req, res) => {
  const supporters = db.kofiSupporters || {};
  const entries = Object.entries(supporters).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return res.json({ topSupporter: null });
  const [name, total] = entries[0];
  res.json({ topSupporter: { name, total: Math.round(total * 100) / 100 } });
});
