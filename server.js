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
app.use(cors());
// verify-Callback speichert den ROHEN Body zusätzlich (req.rawBody) - wird für die
// GitHub-Webhook-Signaturprüfung gebraucht, da express.json() den Body normalerweise nur geparst
// bereitstellt. Für alle anderen Routen ändert sich dadurch nichts.
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Nicht angemeldet.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
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
    patchnotes: p.patchnotes !== false
  };
}
function pushNotificationEvent(userId, type, payload) {
  if (!userId) return;
  if (!db.private[userId]) db.private[userId] = {};
  const list = db.private[userId].__notificationEvents || [];
  list.unshift({ id: crypto.randomUUID(), type, time: Date.now(), payload });
  db.private[userId].__notificationEvents = list.slice(0, 30);
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
  db.private[userId][SAVE_KEY] = { value: jsonString, version: existingVersion + 1 };
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
app.post('/api/register', async (req, res) => {
  const { username, password, email } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Name und Passwort erforderlich.' });
  const cleanName = String(username).trim();
  if (!/^[a-zA-Z0-9_\-äöüÄÖÜß]{3,18}$/.test(cleanName)) {
    return res.status(400).json({ error: cleanName.includes('@') ? 'Das erste Feld ist dein Spielername (kein @-Zeichen) - deine E-Mail-Adresse gehört ins E-Mail-Feld darunter. Beispiel-Name: Sternenjäger_7' : 'Bitte wähle einen Spielernamen mit 3 bis 18 Zeichen. Erlaubt sind Buchstaben, Zahlen sowie _ und - (keine Leer- oder Sonderzeichen). Beispiel: Sternenjäger_7' });
  }
  if (String(password).length < 6) return res.status(400).json({ error: 'Passwort muss mindestens 6 Zeichen haben.' });
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
app.post('/api/resend-verification', async (req, res) => {
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
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Name und Passwort erforderlich.' });
  const key = String(username).trim().toLowerCase();
  const user = db.users[key];
  if (!user) return res.status(401).json({ error: 'Unbekannter Name oder falsches Passwort.' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Unbekannter Name oder falsches Passwort.' });
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
app.post('/api/request-password-reset', async (req, res) => {
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
app.post('/api/reset-password', async (req, res) => {
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
    const prevValue = db.shared[key];
    db.shared[key] = value;
    handleSharedStorageWrite(key, prevValue, value);
    await saveDb();
    return res.json({ key, value, shared });
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
    diminishingShipCount(f.carrier || 0) * 15 + diminishingShipCount(f.superschlachtschiff || 0) * 220;
}
// enemyFleetForCounter: die GESAMTE gegnerische Flotte (fleetSummary), optional – nur bei echtem PvP
// bekannt und übergeben, macht das Kontersystem wirksam.
function computeAttackPower(save, enemyFleetForCounter) {
  const research = save.research || {};
  let power = 0;
  for (const f of allFleetsOf(save)) {
    let fp = rawFleetPower(f);
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
  power += Math.round(rawFleetPower(save.fleet) * 0.4) * HOME_DEFENSE_BONUS;
  for (const c of Object.values(save.colonies || {})) {
    if (!c || !c.fleet) continue;
    power += Math.round(rawFleetPower(c.fleet) * 0.4);
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

app.post('/api/attack', authMiddleware, async (req, res) => {
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

    setSaveValue(req.userId, JSON.stringify(attacker));
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
    return res.json({ success: true, stolen, destroyedBuilding, attackPower, defensePower });
  } else {
    attacker.battlePoints = (attacker.battlePoints || 0) + 3;
    setSaveValue(req.userId, JSON.stringify(attacker));

    addReport(req.userId, {
      type: 'attack-sent', result: 'loss', targetName: targetUser ? targetUser.username : 'Unbekannt',
      attackPower, defensePower, defenseBefore, fleet: attackerFleetSummary
    });
    addReport(targetUserId, {
      type: 'attack-received', result: 'win', attackerName: req.username,
      attackPower, defensePower, defenseBefore, fleet: attackerFleetSummary
    });
    await saveDb();
    return res.json({ success: false, attackPower, defensePower });
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
  res.json({ ok: true });
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
    patchnotes: b.patchnotes !== false
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
const MARKET_RESOURCES = {
  erz:        { basePrice: 1.0,  min: 0.35, max: 3.0 },
  kristalle:  { basePrice: 1.6,  min: 0.55, max: 4.5 },
  deuterium:  { basePrice: 2.4,  min: 0.85, max: 7.0 },
  energie:    { basePrice: 1.2,  min: 0.45, max: 3.5 },
  antimaterie:{ basePrice: 12.0, min: 4.0,  max: 40.0 }
};
// Wie stark eine gehandelte Menge den Preis bewegt (pro 1000 Einheiten). Käufe +, Verkäufe −.
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
const WORLD_BOSS_ATTACK_COOLDOWN_MS = 30 * 60 * 1000;
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

  // Geteilter Marktplatz: jeder Preis driftet pro Tick 15% des Weges zurück zu seinem Normalpreis
  // (so erholen sich Preise nach großen Käufen/Verkäufen langsam) und bekommt etwas Rauschen, damit
  // der Markt auch ohne Spieleraktivität leicht lebendig wirkt.
  const market = loadOrInitMarket(g);
  for (const [key, info] of Object.entries(MARKET_RESOURCES)) {
    const cur = market[key];
    const towardBase = cur + (info.basePrice - cur) * 0.15;
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

// Handeln auf dem geteilten Markt. Body: { action:'buy'|'sell', resource, amount }.
// Der Server ist die Autorität über den PREIS (verhindert manipulierte Preise vom Client), rechnet die
// Kreditkosten/-erlöse aus, bewegt den Preis nach Angebot/Nachfrage und gibt das Ergebnis zurück. Die
// eigentlichen Ressourcen-/Kredit-Bestände des Spielers liegen im clientseitigen Speicherstand; der
// Client bucht sie nach einer erfolgreichen Antwort. Amount wird serverseitig begrenzt.
app.post('/api/market/trade', authMiddleware, async (req, res) => {
  const { action, resource, amount } = req.body || {};
  if (action !== 'buy' && action !== 'sell') return res.status(400).json({ error: 'ungültige Aktion' });
  if (!MARKET_RESOURCES[resource]) return res.status(400).json({ error: 'nicht handelbare Ressource' });
  const amt = Math.floor(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'ungültige Menge' });
  if (amt > 1000000) return res.status(400).json({ error: 'Menge zu groß (max. 1.000.000)' });

  const g = loadOrInitGalaxy();
  const market = loadOrInitMarket(g);
  const priceBefore = market[resource];
  // Durchschnittspreis über die gehandelte Menge (der Preis bewegt sich WÄHREND des Handels linear,
  // große Trades bekommen dadurch einen spürbar schlechteren Schnitt – realistische Slippage).
  const impact = (amt / 1000) * MARKET_IMPACT_PER_1000 * MARKET_RESOURCES[resource].basePrice;
  const priceAfterRaw = action === 'buy' ? priceBefore + impact : priceBefore - impact;
  const priceAfter = clampMarketPrice(resource, priceAfterRaw);
  const avgPrice = (priceBefore + priceAfter) / 2;
  const credits = Math.round(avgPrice * amt);

  market[resource] = priceAfter;
  saveDb();

  res.json({
    ok: true,
    action, resource, amount: amt,
    credits,                 // beim Kauf: Kosten; beim Verkauf: Erlös
    avgPrice,
    priceBefore, priceAfter
  });
});

// Weltboss angreifen. Abklingzeit 30 Min. pro Spieler, Schaden = Angriffskraft des Spielers mit
// leichter Streuung. Jeder Angriff gibt eine kleine Belohnung, der Todesstoß eine große. Belohnungen
// werden NUR in den Spielstand des Anfragenden geschrieben (keine fremden Spielstände anfassen).
app.post('/api/worldboss/attack', authMiddleware, async (req, res) => {
  const g = loadOrInitGalaxy();
  const boss = g.worldBoss;
  if (!boss || boss.hp <= 0) return res.status(400).json({ error: 'Kein aktiver Weltboss.' });
  const last = boss.lastAttack[req.userId] || 0;
  const cooldownLeft = last + WORLD_BOSS_ATTACK_COOLDOWN_MS - Date.now();
  if (cooldownLeft > 0) return res.status(429).json({ error: 'Abklingzeit aktiv.', cooldownLeftMs: cooldownLeft });

  const attackerRaw = getSaveValue(req.userId);
  if (!attackerRaw) return res.status(404).json({ error: 'Spielstand nicht gefunden.' });
  let attacker;
  try { attacker = JSON.parse(attackerRaw); } catch (e) { return res.status(500).json({ error: 'Spielstand beschädigt.' }); }

  const power = computeAttackPower(attacker, null);
  const damage = Math.max(50, Math.round(power * (0.8 + Math.random() * 0.4)));
  boss.hp = Math.max(0, boss.hp - damage);
  boss.participants[req.userId] = (boss.participants[req.userId] || 0) + damage;
  boss.lastAttack[req.userId] = Date.now();

  const killed = boss.hp <= 0;
  // Kleine Belohnung pro Angriff, große für den Todesstoß.
  const bpGain = killed ? 100 : 8;
  const creditGain = killed ? 1000 : 40;
  attacker.battlePoints = (attacker.battlePoints || 0) + bpGain;
  attacker.credits = (attacker.credits || 0) + creditGain;
  setSaveValue(req.userId, JSON.stringify(attacker));

  let topDamage = null;
  if (killed) {
    const entries = Object.entries(boss.participants).sort((a, b) => b[1] - a[1]);
    const topUser = entries.length ? findUserById(entries[0][0]) : null;
    topDamage = entries.slice(0, 3).map(([uid, dmg]) => { const u = findUserById(uid); return { name: u ? u.username : 'Unbekannt', damage: dmg }; });
    pushGalaxyNews('ti-alien', boss.name + ' wurde BESIEGT! Todesstoß: ' + (req.username || 'Unbekannt') + '. Meister Schaden: ' + (topUser ? topUser.username : 'Unbekannt') + '.');
    g.worldBoss = null;
  }
  await saveDb();
  res.json({ ok: true, damage, bossHp: killed ? 0 : boss.hp, bossMaxHp: boss.maxHp, killed, bpGain, creditGain, topDamage });
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
    setSaveValue(req.userId, JSON.stringify(attacker));
    pushGalaxyNews('ti-flag', (req.username || 'Ein Kommandant') + ' hat ' + systemId + ' von den ' + owner.name + ' erobert!');
    await saveDb();
    return res.json({ success: true, systemId, attackPower, factionDefense, creditReward, factionName: owner.name });
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
    setSaveValue(req.userId, JSON.stringify(attacker));
    await saveDb();
    return res.json({ success: false, systemId, attackPower, factionDefense, lost, factionName: owner.name });
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
