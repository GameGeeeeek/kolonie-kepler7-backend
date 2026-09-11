// Stimmen-Belohnung von browsermmorpg.com (11.09.2026, Auftrag Sascha).
//
// DER AUFTRAG, woertlich: "Voting Script in Kepler einbauen. Spieler sollen nach 6 Stunden ein Popup
// bekommen bitte voten fuer mehr Spieler und vergib nach dem Voten dem Spieler eine kleine Belohnung."
//
// Das Verzeichnis bietet dafuer selbst den Weg ("Postback & callback reward systems - pay players for
// voting"): Nach einer Stimme ruft browsermmorpg.com eine Adresse auf, die WIR ihm nennen. Diese
// Route ist GET /api/stimme/rueckruf. Was sie kann und vor allem, was sie NICHT kann, misst dieser
// Test - ein Test nur ueber den Erfolgsweg waere auch bei einer Route gruen, die jedem, der die
// Adresse kennt, Kredite schenkt.
//
// DIE DREI ZUSAGEN:
//   * Belohnung nur mit richtigem Schluessel, und ohne eingerichteten Schluessel gibt es die Route
//     gar nicht (fail-closed wie der Ko-fi-Webhook und der Maschinenzugang des Social Hub) -> 1, 2
//   * Hoechstens eine Belohnung je sechs Stunden je Konto, und die Sperre liegt am KONTO
//     (user.stimmeBelohntZuletzt), nie im klientenautoritativen Spielstand -> 4, 5
//   * Der Spieler sieht die Sperre vorher: /api/me nennt naechsteAb und die Belohnung -> 6
//
// WARUM 200 STATT 4xx bei "unbekannt"/"Sperre": Der Aufrufer ist eine fremde Maschine, die auf
// Fehlercodes womoeglich mit Wiederholungen reagiert. Der Grund steht im Body und im Protokoll.
//
// Gegenprobe beidseitig: am alten server.js (ohne Route) antwortet 1a mit 404 statt 503 - rot.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
// Gemessen frei in BEIDEN Repos am 11.09.2026 (grep -hoE "\b3[12][0-9][0-9]\b" tests/*.js ../kolonie-kepler7/tests/*.js | sort -un).
const PORT = Number(process.env.TEST_PORT || 3267);
const SCHLUESSEL = 'stimme-testschluessel-0123456789abcdef';
const SECHS_STUNDEN = 6 * 3600 * 1000;

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ADMIN = crypto.randomUUID(), ANNA = crypto.randomUUID(), OHNE = crypto.randomUUID();

function spielstand(id, name) {
  return {
    resources: { energie: 1e5, erz: 1e5, kristalle: 1e5, deuterium: 1e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {}, fleet: { missions: [] },
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  };
}
function grunddb() {
  const vorAchtStunden = Date.now() - 8 * 3600 * 1000;
  return {
    users: {
      gamegeeeeek: { userId: ADMIN, username: 'GameGeeeeek', passwordHash: hash, createdAt: vorAchtStunden },
      anna: { userId: ANNA, username: 'Anna', passwordHash: hash, createdAt: vorAchtStunden },
      // Konto OHNE Spielstand: eine Belohnung haette nichts, worin sie landen koennte.
      ohne: { userId: OHNE, username: 'ohne', passwordHash: hash, createdAt: vorAchtStunden }
    },
    private: {
      [ADMIN]: { 'kepler7-save-v3': JSON.stringify(spielstand(ADMIN, 'GameGeeeeek')) },
      [ANNA]:  { 'kepler7-save-v3': JSON.stringify(spielstand(ANNA, 'Anna')) }
    },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {} }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-stimme-' + process.pid + '.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-stimme-'));
let srv = null, s = null, tokAdmin = null, tokA = null;
function aufraeumen() {
  try { if (srv) srv.kill(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', aufraeumen);

async function starteServer(extraEnv) {
  let log = '';
  const env = Object.assign({}, process.env, {
    DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret',
    JWT_SECRET_FILE: path.join(tmpDir, 'jwt.txt'),
    VAPID_PUBLIC_FILE: path.join(tmpDir, 'vapid-pub.txt'),
    VAPID_PRIVATE_FILE: path.join(tmpDir, 'vapid-priv.txt')
  }, extraEnv || {});
  // Der Schluessel darf aus der Umgebung des Testrechners NICHT hereinwandern (Abschnitt 1 misst
  // gerade den Fall OHNE Schluessel).
  if (!extraEnv || !('STIMME_RUECKRUF_KEY' in extraEnv)) delete env.STIMME_RUECKRUF_KEY;
  srv = spawn(process.execPath, [path.join(WURZEL, 'server.js')], { cwd: WURZEL, env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
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
  return { j, anmelden, protokoll: () => log };
}
async function stoppeServer() {
  if (!srv) return;
  srv.kill('SIGTERM');            // flusht die DB (Graceful Shutdown)
  await warte(700);
  srv = null;
}
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
// Jede Aenderung an der DB-DATEI laeuft ueber stoppen -> aendern -> starten (der Flush beim Stopp
// ueberschriebe eine Aenderung am laufenden Server, Vorbild test_bonuscodes_http.js).
async function aendereDb(fn, extraEnv) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  s = await starteServer(extraEnv);
  tokAdmin = await s.anmelden('GameGeeeeek');
  tokA = await s.anmelden('anna');
}
const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
const rueckruf = (query) => s.j('/stimme/rueckruf?' + new URLSearchParams(query).toString());
const fach = async (tok) => (await s.j('/pending-rewards', { headers: kopf(tok) })).body.rewards || [];

(async () => {
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));

  // ---------------------------------------------------------------- 1. Ohne Schluessel: fail-closed
  s = await starteServer({});
  let r = await rueckruf({ key: SCHLUESSEL, spieler: 'Anna' });
  check('1a: ohne STIMME_RUECKRUF_KEY gibt es die Route nicht (503), auch mit "richtigem" Schluessel',
    r.status === 503, { status: r.status, body: r.body });
  const health0 = await s.j('/health');
  check('1b: /api/health sagt, dass der Rueckruf NICHT eingerichtet ist', health0.body && health0.body.stimmenRueckruf === false, health0.body && health0.body.stimmenRueckruf);

  // ---------------------------------------------------------------- 2. Mit Schluessel: Fehlend und falsch
  await aendereDb(() => {}, { STIMME_RUECKRUF_KEY: SCHLUESSEL, STIMME_BELOHNUNG_KREDITE: '25' });
  check('2-vorab: Admin und Anna angemeldet', !!tokAdmin && !!tokA);
  if (!tokAdmin || !tokA) { console.log(s.protokoll().slice(-800)); console.log('\nFAIL'); process.exit(1); }
  const health1 = await s.j('/health');
  check('2a: /api/health sagt jetzt, dass der Rueckruf eingerichtet ist', health1.body && health1.body.stimmenRueckruf === true);
  r = await rueckruf({ spieler: 'Anna' });
  check('2b: ohne Schluessel 401 - und die Meldung nennt 0 Zeichen (fehlend, nicht falsch)',
    r.status === 401 && /0 Zeichen/.test(String(r.body && r.body.error)), r.body);
  r = await rueckruf({ key: 'x'.repeat(SCHLUESSEL.length), spieler: 'Anna' });
  check('2c: falscher Schluessel 401 - Meldung nennt die Laenge, nie den Wert',
    r.status === 401 && new RegExp(SCHLUESSEL.length + ' Zeichen').test(String(r.body && r.body.error)) && !String(r.body && r.body.error).includes('x'.repeat(8)), r.body);
  check('2d: bis hierher hat Anna KEINE Belohnung im Fach', (await fach(tokA)).length === 0);

  // ---------------------------------------------------------------- 3. Richtiger Schluessel
  r = await rueckruf({ key: SCHLUESSEL, spieler: 'niemand-hier' });
  check('3a: unbekannter Spieler -> 200 ohne Belohnung, Grund "unbekannt" (die fremde Maschine soll nicht wiederholen)',
    r.status === 200 && r.body && r.body.belohnt === false && r.body.grund === 'unbekannt', r.body);
  r = await rueckruf({ key: SCHLUESSEL, spieler: 'ohne' });
  check('3b: Konto ohne Spielstand -> keine Belohnung, Grund "kein-spielstand"',
    r.status === 200 && r.body && r.body.belohnt === false && r.body.grund === 'kein-spielstand', r.body);
  r = await rueckruf({ key: SCHLUESSEL, spieler: 'ANNA' });
  check('3c: bekannter Spieler (Gross-/Kleinschreibung egal) -> belohnt',
    r.status === 200 && r.body && r.body.belohnt === true && typeof r.body.naechsteAb === 'number', r.body);
  let liste = await fach(tokA);
  check('3d: genau EINE Belohnung im Fach, eigener Typ, 25 Kredite',
    liste.length === 1 && liste[0].type === 'verzeichnis-stimme' && liste[0].credits === 25, liste);
  r = await rueckruf({ key: SCHLUESSEL, username: 'Anna' });
  check('3e: "username" ist ein zugelassener Zweitname fuer den Spieler-Parameter (Sperre greift, kein 4xx)',
    r.status === 200 && r.body && r.body.belohnt === false && r.body.grund === 'sperre', r.body);

  // ---------------------------------------------------------------- 4. Die Sperre
  r = await rueckruf({ key: SCHLUESSEL, spieler: 'Anna' });
  check('4a: sofort noch einmal -> keine zweite Belohnung, Grund "sperre", naechsteAb in der Zukunft',
    r.status === 200 && r.body && r.body.belohnt === false && r.body.grund === 'sperre' && r.body.naechsteAb > Date.now(), r.body);
  liste = await fach(tokA);
  check('4b: das Fach hat weiterhin genau eine Belohnung', liste.length === 1, liste.length);
  await stoppeServer();
  let d = liesDb();
  check('4c: die Sperre liegt am KONTO (user.stimmeBelohntZuletzt), nicht im Spielstand',
    typeof d.users.anna.stimmeBelohntZuletzt === 'number' && !/stimme/i.test(String(d.private[ANNA]['kepler7-save-v3'])),
    { konto: d.users.anna.stimmeBelohntZuletzt });

  // ---------------------------------------------------------------- 5. Nach sechs Stunden wieder
  await aendereDb(db => { db.users.anna.stimmeBelohntZuletzt = Date.now() - SECHS_STUNDEN - 60000; }, { STIMME_RUECKRUF_KEY: SCHLUESSEL, STIMME_BELOHNUNG_KREDITE: '25' });
  r = await rueckruf({ key: SCHLUESSEL, spieler: 'Anna' });
  check('5a: sechs Stunden spaeter wird wieder belohnt', r.status === 200 && r.body && r.body.belohnt === true, r.body);
  liste = await fach(tokA);
  check('5b: jetzt zwei Belohnungen im Fach', liste.length === 2, liste.length);

  // ---------------------------------------------------------------- 6. Was der Spieler vorher sieht
  const me = await s.j('/me', { headers: kopf(tokA) });
  check('6a: /api/me nennt die Belohnung (25 Kredite) ...', me.body && me.body.stimme && me.body.stimme.belohnung && me.body.stimme.belohnung.credits === 25, me.body && me.body.stimme);
  check('6b: ... und naechsteAb rund sechs Stunden nach der letzten Belohnung',
    me.body && me.body.stimme && Math.abs(me.body.stimme.naechsteAb - (Date.now() + SECHS_STUNDEN)) < 120000, me.body && me.body.stimme && me.body.stimme.naechsteAb);
  // Ein frisches Konto sieht die erste Erinnerung erst sechs Stunden nach der Registrierung
  // ("nach 6 Stunden ein Popup") - naechsteAb haengt dann an createdAt.
  await aendereDb(db => { db.users.anna.stimmeBelohntZuletzt = 0; db.users.anna.createdAt = Date.now() - 3600000; }, { STIMME_RUECKRUF_KEY: SCHLUESSEL, STIMME_BELOHNUNG_KREDITE: '25' });
  const meNeu = await s.j('/me', { headers: kopf(tokA) });
  check('6c: ein Konto, das erst eine Stunde alt ist, bekommt naechsteAb = Registrierung + 6 h',
    meNeu.body && meNeu.body.stimme && Math.abs(meNeu.body.stimme.naechsteAb - (Date.now() + 5 * 3600000)) < 120000, meNeu.body && meNeu.body.stimme);
  r = await rueckruf({ key: SCHLUESSEL, spieler: 'Anna' });
  check('6d: der Rueckruf selbst haengt NICHT an createdAt - wer trotzdem frueh abstimmt, wird belohnt',
    r.status === 200 && r.body && r.body.belohnt === true, r.body);

  // ---------------------------------------------------------------- 7. Notaus des Betreibers
  const schalter = await s.j('/admin/schalter', { method: 'POST', headers: kopf(tokAdmin), body: JSON.stringify({ name: 'stimme', aus: true, grund: 'Test' }) });
  check('7a: der Admin kann den Schalter "stimme" umlegen', schalter.status === 200, schalter.body);
  await aendereDb(db => { db.users.anna.stimmeBelohntZuletzt = 0; }, { STIMME_RUECKRUF_KEY: SCHLUESSEL, STIMME_BELOHNUNG_KREDITE: '25' });
  r = await rueckruf({ key: SCHLUESSEL, spieler: 'Anna' });
  check('7b: bei gesetztem Notaus wird nicht belohnt, Grund "notaus"', r.status === 200 && r.body && r.body.belohnt === false && r.body.grund === 'notaus', r.body);
  const meAus = await s.j('/me', { headers: kopf(tokA) });
  check('7c: /api/me verspricht dann auch keine Belohnung mehr (belohnung: null)', meAus.body && meAus.body.stimme && meAus.body.stimme.belohnung === null, meAus.body && meAus.body.stimme);
  const healthAus = await s.j('/health');
  check('7d: /api/health zeigt den Rueckruf bei Notaus als nicht aktiv', healthAus.body && healthAus.body.stimmenRueckruf === false, healthAus.body && healthAus.body.stimmenRueckruf);

  await stoppeServer();
  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ABSTURZ: ' + (e && e.stack || e)); try { console.log((s && s.protokoll() || '').slice(-600)); } catch (e2) {} process.exit(1); });
