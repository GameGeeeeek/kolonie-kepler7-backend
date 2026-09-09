// Spielerzahl fuer die Kopfzeile des Betreibers (09.09.2026, Wunsch Sascha: "nur bei mir
// gamegeeeeek ... wieviele online von wieviel registrierten").
//
// GEPRUEFT WIRD DIE REGEL, und die Messungen sind PAARE - jede Haelfte allein waere auch bei
// einem Zaehler gruen, der immer oder nie zaehlt:
//   1a/1b  der Admin bekommt die Zahlen UND ein gewoehnlicher Spieler bekommt 403
//   1c     ohne Anmeldung gar nichts (401)
//   2a/2b  wer frisch gespeichert hat, zaehlt als online UND wer lange weg ist, zaehlt nicht
//   2c     `registriert` zaehlt ALLE Konten, auch die nie gespielt haben - sonst waere die
//          zweite Zahl eine andere Groesse, als das Wort sagt
//   3a     die Schwelle kommt aus dem Server (REMINDER_ONLINE_THRESHOLD_MS), nicht aus dem Test:
//          Eine hier getippte Zahl waere die zweite Definition von "online", genau die
//          Kopie-Familie, die spaeter auseinanderlaeuft
//   3b     die Route liest KEINEN Spielstand - sie soll billig genug fuer eine Kopfzeile sein,
//          die regelmaessig auffrischt. Gemessen an der Antwortzeit gegen /api/health, nicht an
//          einer getippten Millisekundenzahl.
//
// GEGENPROBE (sabotierte Kopie ueber KEPLER_SERVER_JS):
//   isAdmin-Pruefung entfernt  -> 1b faellt
//   Online-Schwelle auf 100 Tage -> 2b faellt
//   registriert = nur Konten mit Spielstand -> 2c faellt
//
// PORT 3271: gemessen belegt sind 3100, 3187, 3195-3265 und 3270
// (`grep -hoE "3[12][0-9][0-9]" tests/*.js | sort -un`) - ein neuer Test nimmt 3272.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3271);

let fail = false;
const ergebnis = {};
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const merke = (name, bed, zusatz) => { ergebnis[String(name).split(':')[0]] = !!bed; check(name, bed, zusatz); };
const warte = ms => new Promise(r => setTimeout(r, ms));

const SAB = process.env.KEPLER_SPIELERZAHL_GEGENPROBE || '';
const MUSS_FALLEN = { adminfrei: ['1b'], schwelle: ['2b'], nurmitstand: ['2c'] };

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ADMIN = crypto.randomUUID(), ANNA = crypto.randomUUID(), BEN = crypto.randomUUID(),
      CARL = crypto.randomUUID(), ERIK = crypto.randomUUID();

function spielstand(id, name) {
  return {
    resources: { energie: 1e5, erz: 1e5, kristalle: 1e5, deuterium: 1e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {}, fleet: { missions: [] },
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  };
}

/* Die Bestenliste ist die Quelle des lastSeen-Zeitstempels, an dem der Server "online" misst.
   GESETZT WIRD SIE HIER DIREKT, weil ein echtes Speichern durch den Client sie auf JETZT setzen
   wuerde - dann waere jeder online und 2b haette nichts zu messen. */
function bestenliste(name, punkte, lastSeen) {
  return JSON.stringify({ username: name, score: punkte, lastSeen });
}

function grunddb() {
  const jetzt = Date.now();
  return {
    users: {
      gamegeeeeek: { userId: ADMIN, username: 'GameGeeeeek', passwordHash: hash, createdAt: jetzt },
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: jetzt },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: jetzt },
      carl: { userId: CARL, username: 'carl', passwordHash: hash, createdAt: jetzt },
      // erik: registriert, aber NIE gespielt - kein Spielstand, keine Bestenliste. Er ist der
      // Grund fuer 2c: `registriert` muss ihn mitzaehlen.
      erik: { userId: ERIK, username: 'erik', passwordHash: hash, createdAt: jetzt }
    },
    private: {
      [ADMIN]: { 'kepler7-save-v3': JSON.stringify(spielstand(ADMIN, 'GameGeeeeek')) },
      [ANNA]:  { 'kepler7-save-v3': JSON.stringify(spielstand(ANNA, 'anna')) },
      [BEN]:   { 'kepler7-save-v3': JSON.stringify(spielstand(BEN, 'ben')) },
      [CARL]:  { 'kepler7-save-v3': JSON.stringify(spielstand(CARL, 'carl')) }
    },
    shared: {
      // anna und ben: gerade eben gespeichert -> online.
      ['leaderboard:' + ANNA]: bestenliste('anna', 100, jetzt - 5000),
      ['leaderboard:' + BEN]:  bestenliste('ben', 90, jetzt - 30000),
      // carl: vor zwei Stunden -> nicht online.
      ['leaderboard:' + CARL]: bestenliste('carl', 80, jetzt - 2 * 3600000),
      // Der Admin selbst zaehlt mit, sobald er sich anmeldet und speichert - hier bewusst ALT,
      // damit die erwartete Zahl aus dem Fixture folgt und nicht aus dem Testablauf.
      ['leaderboard:' + ADMIN]: bestenliste('GameGeeeeek', 500, jetzt - 3 * 3600000)
    },
    resetTokens: {}, feedback: [],
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: jetzt, factions: {},
      alienPause: { kryll: jetzt + 9e8, xantheer: jetzt + 9e8, vex: jetzt + 9e8, verglueht: jetzt + 9e8 },
      alienNester: [] }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-spielerzahl-' + process.pid + '.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-spielerzahl-'));
let srv = null;
function aufraeumen() {
  try { if (srv) srv.kill('SIGKILL'); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', aufraeumen);

async function starteServer() {
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb()));
  // KEPLER_SERVER_JS leitet auf eine sabotierte KOPIE um (Gegenproben). Die Kopie MUSS im
  // Repo-Verzeichnis liegen, damit require('./mailer') aufloest.
  srv = spawn(process.execPath, [process.env.KEPLER_SERVER_JS || path.join(WURZEL, 'server.js')], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, {
      DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret',
      JWT_SECRET_FILE: path.join(tmpDir, 'jwt.txt'),
      VAPID_PUBLIC_FILE: path.join(tmpDir, 'vapid-pub.txt'),
      VAPID_PRIVATE_FILE: path.join(tmpDir, 'vapid-priv.txt')
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const basis = 'http://127.0.0.1:' + PORT + '/api';
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(basis + '/health'); if (r.ok) break; } catch (e) {}
    await warte(250);
  }
  async function j(pfad, opt) {
    const r = await fetch(basis + pfad, opt);
    const t = await r.text();
    try { return { status: r.status, body: JSON.parse(t) }; }
    catch (e) { return { status: r.status, body: t.slice(0, 300) }; }
  }
  async function anmelden(name) {
    const r = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name, password: 'test1234' }) });
    return r.body && r.body.token;
  }
  return { j, anmelden, basis };
}

(async () => {
  const s = await starteServer();
  const kopf = t => ({ headers: { Authorization: 'Bearer ' + t } });

  const adminTok = await s.anmelden('GameGeeeeek');
  const annaTok = await s.anmelden('anna');

  // ---- 1) Wer darf fragen -------------------------------------------------------------------
  const alsAdmin = await s.j('/admin/spielerzahl', kopf(adminTok));
  merke('1a: der Admin bekommt die Zahlen', alsAdmin.status === 200
    && typeof alsAdmin.body.online === 'number' && typeof alsAdmin.body.registriert === 'number',
    { status: alsAdmin.status, body: alsAdmin.body });

  const alsAnna = await s.j('/admin/spielerzahl', kopf(annaTok));
  merke('1b: ein gewoehnlicher Spieler bekommt 403 - die Sperre steht im Server',
    alsAnna.status === 403, { status: alsAnna.status, body: alsAnna.body });

  const ohne = await s.j('/admin/spielerzahl');
  merke('1c: ohne Anmeldung gar nichts', ohne.status === 401, { status: ohne.status });

  // ---- 2) Was gezaehlt wird ------------------------------------------------------------------
  /* anna (vor 5 s) und ben (vor 30 s) sind online; carl (vor 2 h), erik (nie) und der Admin
     (vor 3 h) sind es nicht. Der Admin hat sich zwar gerade angemeldet - eine Anmeldung schreibt
     aber keine Bestenliste, und genau darauf misst der Server. */
  merke('2a: wer frisch gespeichert hat, zaehlt als online', alsAdmin.body.online === 2,
    { online: alsAdmin.body.online, erwartet: 2 });
  merke('2b: wer lange weg ist, zaehlt nicht mit', alsAdmin.body.online < 4,
    { online: alsAdmin.body.online });
  merke('2c: registriert zaehlt ALLE Konten, auch die nie gespielt haben',
    alsAdmin.body.registriert === 5, { registriert: alsAdmin.body.registriert, erwartet: 5 });

  // ---- 3) Die Zusagen der Route ---------------------------------------------------------------
  /* Die Schwelle kommt AUS DEM SERVER. Verglichen wird sie mit der Konstante im Quelltext -
     nicht mit einer hier getippten Zahl, sonst stuende die Definition von "online" zweimal da. */
  const quelle = fs.readFileSync(process.env.KEPLER_SERVER_JS || path.join(WURZEL, 'server.js'), 'utf8');
  const m = quelle.match(/const REMINDER_ONLINE_THRESHOLD_MS = ([^;]+);/);
  const ausQuelle = m ? Function('return (' + m[1] + ')')() : null;
  merke('3a: die gemeldete Schwelle ist die des Servers, keine zweite Definition',
    ausQuelle !== null && alsAdmin.body.schwelleMs === ausQuelle,
    { gemeldet: alsAdmin.body.schwelleMs, ausQuelle });

  /* 3b: Die Route soll billig sein - sie liest keinen Spielstand. Gemessen als Vielfaches von
     /api/health, dem billigsten Endpunkt des Servers, statt an einer getippten Millisekundenzahl,
     die auf einer langsameren Maschine bedeutungslos waere. Drei Laeufe, damit ein einzelner
     Ausreisser die Messung nicht traegt. */
  async function dauer(pfad, opt){
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 3; i++) await s.j(pfad, opt);
    return Number(process.hrtime.bigint() - t0) / 1e6;
  }
  const tHealth = await dauer('/health');
  const tZahl = await dauer('/admin/spielerzahl', kopf(adminTok));
  merke('3b: die Route ist billig genug fuer eine Kopfzeile (kein Spielstand wird gelesen)',
    tZahl < Math.max(30, tHealth * 8), { health: Math.round(tHealth), zahl: Math.round(tZahl) });

  try { srv.kill('SIGTERM'); } catch (e) {}
  await warte(400);

  if (SAB){
    const soll = MUSS_FALLEN[SAB] || [];
    const gefallen = soll.filter(n => ergebnis[n] === false);
    console.log('GEGENPROBE ' + SAB + ': ' + gefallen.length + '/' + soll.length + ' gefallen (' +
      soll.map(n => n + '=' + (ergebnis[n] === false ? 'rot' : 'gruen')).join(' ') + ')');
    if (gefallen.length !== soll.length){
      console.log('FAIL - Gegenprobe unvollstaendig: ' + soll.filter(n => ergebnis[n] !== false).join(', ') + ' blieben gruen');
      process.exit(1);
    }
    process.exit(0);
  }
  console.log(fail ? 'FEHLGESCHLAGEN' : 'Alles gruen.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAIL - Abbruch:', e); process.exit(1); });
