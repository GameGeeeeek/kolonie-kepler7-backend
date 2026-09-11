// Patenschaft: Mentor und Schuetzling (Feature G, 11.09.2026) - gegen einen ECHT gestarteten Server.
//
// Wer sich ueber einen Einladungs-Link registriert, ist 30 Tage lang der Schuetzling seines
// Einladenden. Jeder Meilenstein, den er in dieser Zeit ZUM ERSTEN MAL schafft, zahlt beiden
// Seiten Kredite (200 / 150) und Sternenstaub (3 / 3). Alles liegt am NUTZEROBJEKT - der
// Spielstand ist klientenautoritativ, und an dieser Verknuepfung haengen Belohnungen fuer ein
// fremdes Konto.
//
// GEPRUEFT WIRD:
//   1  Redeem verknuepft BEIDE Seiten - und nur beim ersten Aufruf (vor Level 5 ruft der
//      Schuetzling die Route mehrfach; `seit` bleibt stehen). Die Antwort nennt den Paten.
//   2  Die Route zeigt den Stand: Pate, Schuetzlinge, Katalog in Anzeigereihenfolge.
//   3  Der erste gewonnene Spielerangriff zahlt beide Seiten GENAU EINMAL: Zeitstempel auf beiden
//      Seiten, Reward-Form (rolle, credits, staub, partnerName), Staub vom Server gebucht,
//      Postfach-Eintrag beim Paten.
//   4  Der zweite Sieg zahlt nichts mehr.
//   5  Nach Ablauf (`bis` in der Vergangenheit) zahlt ein Meilenstein nichts - und derselbe
//      Meilenstein zahlt wieder, sobald `bis` wieder in der Zukunft liegt (Gegenrichtung: der
//      Markt-Hook wird damit auch positiv gemessen).
//   6  Ein Spieler ohne Paten bekommt nichts - auch nicht sein vermeintlicher Pate.
//   7  Ein selbst in den Spielstand geschriebener `pate` ist wirkungslos (Spielstand-PUT).
//   8  Die erste erfolgreiche Abwehr zahlt beide Seiten; der geschlagene Angreifer nichts.
//   9  Fuenf Tage in Folge (Serie ueber /api/me) zahlt beide Seiten.
//  10  Nest- und Festungs-Hook stehen im Quelltext in ihren Routen (der Aufbau eines echten
//      Nestschlags braucht Mission + Galaxiezustand - hier nur der Anker).
//  11  Der Deckel: zehn LAUFENDE Schuetzlinge -> kein Platz (beide Seiten leer, Bonus bleibt);
//      abgelaufene fliegen zuerst, dann passt der naechste wieder.
//
// AUFBAU: Muster test_bonuscodes_http.js (Konten direkt in der DB, damit kein Anfaengerschutz
// entsteht - der wird nur bei /api/register gesetzt), Angriffe wie test_pvp_standorte_http.js
// (uebermaechtiger Angreifer, P(Sieg) ~90 % je Anlauf wegen PVP_PHASE_MAX - deshalb wiederholen
// bis zum gewuenschten Ausgang; ein Sieg setzt beim Opfer einen Schild, deshalb je Siegmessung ein
// frisches Opfer; eine Niederlage setzt keinen). Das attackRateLimit (20/min je IP+Pfad) ist Teil
// des Messaufbaus: bei 429 wird Retry-After abgewartet.
//
// GEGENPROBE (per Env-Sabotage an einer Kopie von server.js, Vorbild test_vorposten_endprojekte_http.js):
//   KEPLER_PATENSCHAFT_SABOTAGE=<name> node tests/test_patenschaft_http.js
//   Der Lauf endet dann NUR gruen, wenn GENAU die in MUSS_FALLEN genannten Pruefungen fallen.
//   Die Listen sind GEMESSEN (11.09.2026), nicht geschaetzt.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3277);
const QUELLE = path.join(WURZEL, 'server_patenschaft_tmp.js');
const SAB = process.env.KEPLER_PATENSCHAFT_SABOTAGE || '';
const MUSS_FALLEN = {
  /* Schalter aus: die Route ist 404 (2a, 2b), nichts wird verknuepft, nichts gezaehlt, nichts
     gezahlt. 3a/4a (Sieg erzwungen) und die "nichts"-Pruefungen bleiben gruen. 5a, 7a, 11-bau und
     11b fallen als FOLGE mit: Sie setzen voraus, dass ueberhaupt je verknuepft wurde (ein
     abgelaufener Pate, ein Schuetzling bei anna, zehn statt neun Eintraege). GEMESSEN 11.09.2026. */
  schalter: ['11-bau', '11b', '11c', '11d', '1a', '1b', '1c', '2a', '2b', '3b', '3c', '3d', '3f', '3g', '5a', '5d', '5e', '7a', '8b', '8c', '8d', '9b', '9c'],
  /* Ohne die Einmaligkeits-Sperre zahlt der zweite Sieg noch einmal (4a, 4b). */
  einmal: ['4a', '4b'],
  /* Ohne die Ablaufpruefung zahlt der Handel trotz `bis` in der Vergangenheit (5a-5c) - und reisst
     5d/5e MIT, als Folge: der erste Handel hat den Meilenstein dann schon gesetzt, der zweite (mit
     Laufzeit) findet ihn gesetzt vor und zahlt nichts mehr. GEMESSEN am 11.09.2026. */
  ablauf: ['5a', '5b', '5c', '5d', '5e'],
  /* Ohne den Sieg-Hook bleibt der erste Sieg stumm (3b-3g); alles andere laeuft weiter. */
  sieg: ['3b', '3c', '3d', '3f', '3g'],
  /* Ohne den Aufruf im Redeem wird nie verknuepft - dieselbe Liste wie `schalter` ohne die
     Route (2a/2b bleiben gruen: die Route selbst lebt, sie hat nur nichts zu zeigen). GEMESSEN. */
  verknuepfung: ['11-bau', '11b', '11c', '11d', '1a', '1b', '1c', '3b', '3c', '3d', '3f', '3g', '5a', '5d', '5e', '7a', '8b', '8c', '8d', '9b', '9c']
};

let fail = false;
const ergebnis = {};
const check = (n, c, x) => {
  ergebnis[n] = !!c;
  console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : ''));
  fail = fail || !c;
};
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ID = {};
const NAMEN = ['anna', 'ben', 'carl', 'dora', 'emil', 'fritz', 'opfer1', 'opfer2', 'opfer3'];
for (const n of NAMEN) ID[n] = crypto.randomUUID();
const TAG = 86400000;

// Stark in beide Richtungen (gewinnt gegen ein leeres Opfer, haelt gegen drei Jaeger);
// xp 1000 = Level 4, also unter der Referral-Schwelle -> der Redeem bleibt 'pending'.
const stark = (id, name) => ({
  resources: { energie: 1e6, erz: 1e6, kristalle: 1e6, deuterium: 1e6, antimaterie: 1e4, forschungspunkte: 1000 },
  buildings: { lager: 60, turm: 200, schild: 200, festung: 100 }, research: {}, colonies: {},
  fleet: { fighters: 500, cruisers: 200, missions: [] },
  player: { id, name }, credits: 5000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
});
// Schwach: ein Erz-Pool als Beute, eine Anlage, keine Flotte.
const schwach = (id, name) => ({
  resources: { erz: 1000000 }, buildings: { schild: 1 }, research: {}, colonies: {},
  fleet: { missions: [] }, player: { id, name }, credits: 0, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
});
// Ein chancenloser Angreifer fuer die Abwehr-Messung.
const winzig = (id, name) => ({
  resources: { erz: 1e5, kristalle: 1e5, deuterium: 1e5, energie: 1e5 }, buildings: {}, research: {}, colonies: {},
  fleet: { fighters: 3, missions: [] }, player: { id, name }, credits: 0, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
});
function grunddb() {
  const users = {}, priv = {};
  const form = { anna: stark, ben: stark, carl: stark, dora: winzig, emil: stark, fritz: stark, opfer1: schwach, opfer2: schwach, opfer3: schwach };
  for (const n of NAMEN) {
    users[n] = { userId: ID[n], username: n, passwordHash: hash, createdAt: Date.now() };
    priv[ID[n]] = { 'kepler7-save-v3': JSON.stringify(form[n](ID[n], n)) };
  }
  return { users, private: priv, shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {} } };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-patenschaft-' + process.pid + '.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-paten-'));
let srv = null;
let s = null;
const tok = {};
function aufraeumen() {
  try { if (srv) srv.kill(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.unlinkSync(QUELLE); } catch (e) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', aufraeumen);
// Ein Absturz mitten im Lauf darf nie wie eine bestandene Gegenprobe aussehen: benennen, rot beenden.
process.on('unhandledRejection', e => { console.log('FAIL - Testabbruch: ' + (e && e.stack || e)); process.exit(1); });

async function starteServer() {
  let log = '';
  srv = spawn(process.execPath, [QUELLE], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, {
      DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret',
      JWT_SECRET_FILE: path.join(tmpDir, 'jwt.txt'),
      VAPID_PUBLIC_FILE: path.join(tmpDir, 'vapid-pub.txt'),
      VAPID_PRIVATE_FILE: path.join(tmpDir, 'vapid-priv.txt')
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
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
    let body; try { body = JSON.parse(t); } catch (e) { body = t.slice(0, 300); }
    return { status: r.status, body, headers: r.headers };
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
// Jede Aenderung an der DB-DATEI laeuft hier durch: stoppen (SIGTERM flusht), aendern, starten,
// neu anmelden - eine Aenderung am laufenden Server waere beim naechsten Flush wieder weg.
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  s = await starteServer();
  for (const n of NAMEN) tok[n] = await s.anmelden(n);
}
const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
const hole = (pfad, name) => s.j(pfad, { headers: kopf(tok[name]) });
const sende = (pfad, name, body) => s.j(pfad, { method: 'POST', headers: kopf(tok[name]), body: JSON.stringify(body || {}) });
const claim = async name => (await sende('/pending-rewards/claim', name)).body.reward || null;
const stand = async name => (await hole('/patenschaft', name)).body;
const staubMenge = async name => (((await hole('/me', name)).body || {}).staub || {}).menge;
// Sichere Sicht auf die Antwort - bei ausgeschaltetem Schalter ist der Body ein 404-Fehler ohne Listen.
const sl = st => (st && Array.isArray(st.schuetzlinge)) ? st.schuetzlinge : [];
const pt = st => (st && st.pate) || null;
// Holt den naechsten Reward des gewuenschten Typs und ueberspringt fremde (ein pvp-fleet-loss aus
// einem unerwuenschten Sieg des winzigen Angreifers). null = keiner da.
async function claimTyp(name, typ) {
  for (let i = 0; i < 6; i++) { const r = await claim(name); if (!r) return null; if (r.type === typ) return r; }
  return null;
}
// Angriff mit 429-Wartelogik (Vorbild test_pvp_standorte_http.js).
async function angriff(name, zielId) {
  for (let i = 0; i < 3; i++) {
    const r = await sende('/attack', name, { targetUserId: zielId });
    if (r.status !== 429) return r;
    const wartezeit = (parseInt(r.headers.get('retry-after'), 10) || 61) + 1;
    console.log('     (429 vom attackRateLimit - warte ' + wartezeit + 's)');
    await warte(wartezeit * 1000);
  }
  return { status: 429, body: null };
}
// Wiederholt, bis der gewuenschte Ausgang da ist (P ~90 % je Anlauf bei Uebermacht).
async function angriffBis(name, zielId, erfolg) {
  let letzte = null;
  for (let i = 0; i < 8; i++) {
    letzte = await angriff(name, zielId);
    if (letzte.status === 200 && !!letzte.body.success === erfolg) return { ok: true, versuche: i + 1, antwort: letzte };
    if (letzte.status !== 200) return { ok: false, versuche: i + 1, antwort: letzte };
  }
  return { ok: false, versuche: 8, antwort: letzte };
}
const heute = t => new Date(t || Date.now()).toISOString().slice(0, 10);

(async () => {
  // ---- 0) Kopie von server.js, ggf. sabotiert; jede Sabotage belegt sich selbst ---------------
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  let basis = roh;
  const ersetze = (alt, neu) => { if (basis.indexOf(alt) < 0) return false; basis = basis.replace(alt, neu); return true; };
  let griff = true;
  if (SAB === 'schalter') griff = ersetze('const PATENSCHAFT_AKTIV = true;', 'const PATENSCHAFT_AKTIV = false;');
  if (SAB === 'einmal') griff = ersetze('    if (user.pate.meilensteine[key]) return false;\n', '');
  if (SAB === 'ablauf') griff = ersetze('    if (!(user.pate.bis > jetzt)) return false;\n', '');
  if (SAB === 'sieg') griff = ersetze("    if (ertragStufe !== 'sockel') patenschaftMeilenstein(req.userId, 'erster-sieg');\n", '');
  if (SAB === 'verknuepfung') griff = ersetze('    patenschaftNeu = patenschaftVerknuepfen(findUserById(req.userId), referrer);\n', '');
  if (SAB && !(SAB in MUSS_FALLEN)) { console.log('FAIL - unbekannte Sabotage: ' + SAB); process.exit(1); }
  if (!griff) { console.log('FAIL - die Sabotage `' + SAB + '` hat nicht gegriffen (Anker nicht gefunden)'); process.exit(1); }
  fs.writeFileSync(QUELLE, basis);
  check('0a: die fuenf Meilensteine stehen im Quelltext in Anzeigereihenfolge',
    /key: 'erster-sieg'[\s\S]*key: 'erste-abwehr'[\s\S]*key: 'erster-schlag'[\s\S]*key: 'erster-handel'[\s\S]*key: 'serie-5'/.test(roh));

  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  s = await starteServer();
  for (const n of NAMEN) tok[n] = await s.anmelden(n);
  check('0b: alle neun Konten angemeldet', NAMEN.every(n => !!tok[n]), NAMEN.filter(n => !tok[n]));
  if (!NAMEN.every(n => !!tok[n])) { console.log(s.protokoll().slice(-800)); console.log('\nFAIL'); process.exit(1); }

  // ---- 1) Redeem verknuepft beide Seiten - einmal ---------------------------------------------
  const vorher = Date.now();
  const r1 = await sende('/referral/redeem', 'ben', { referrerUsername: 'anna' });
  check('1a: der Redeem bleibt pending (Level 4) UND nennt den neuen Paten mit 30 Tagen Laufzeit',
    r1.status === 200 && r1.body.status === 'pending' && r1.body.patenschaft && r1.body.patenschaft.name === 'anna' &&
    r1.body.patenschaft.tage === 30 && Math.abs(r1.body.patenschaft.bis - (vorher + 30 * TAG)) < 60000,
    { status: r1.status, body: r1.body });
  const benStand = await stand('ben');
  const annaStand = await stand('anna');
  check('1b: der Schuetzling sieht seinen Paten, der Pate seinen Schuetzling - derselbe Zeitpunkt',
    pt(benStand) && pt(benStand).name === 'anna' && pt(benStand).aktiv === true &&
    sl(annaStand).length === 1 && sl(annaStand)[0].name === 'ben' && sl(annaStand)[0].seit === pt(benStand).seit,
    { ben: pt(benStand), anna: sl(annaStand) });
  await warte(30);
  const r1b = await sende('/referral/redeem', 'ben', { referrerUsername: 'carl' });
  const benStand2 = await stand('ben');
  check('1c: der zweite Aufruf (vor Level 5 normal) verknuepft NICHT neu - kein Paten-Feld, `seit` steht',
    r1b.status === 200 && r1b.body.status === 'pending' && r1b.body.patenschaft === undefined &&
    pt(benStand2) && pt(benStand2).name === 'anna' && pt(benStand).seit && pt(benStand2).seit === pt(benStand).seit &&
    sl(await stand('anna')).length === 1,
    { antwort: r1b.body, pate: pt(benStand2) });

  // ---- 2) Die Route zeigt den Stand -------------------------------------------------------------
  const carlStand = await hole('/patenschaft', 'carl');
  check('2a: ohne Patenschaft antwortet die Route mit leerem Stand, nicht mit einem Fehler',
    carlStand.status === 200 && carlStand.body.aktiv === true && carlStand.body.pate === null &&
    Array.isArray(carlStand.body.schuetzlinge) && carlStand.body.schuetzlinge.length === 0,
    { status: carlStand.status, body: carlStand.body });
  const katalog = (carlStand.body && carlStand.body.katalog) || [];
  check('2b: der Katalog nennt die fuenf Meilensteine in Anzeigereihenfolge mit beiden Kreditsaetzen',
    katalog.map(k => k.key).join(',') === 'erster-sieg,erste-abwehr,erster-schlag,erster-handel,serie-5' &&
    katalog.every(k => k.name && k.credits && k.credits.pate === 150 && k.credits.schuetzling === 200 && k.staub === 3),
    { keys: katalog.map(k => k.key) });
  const r401 = await s.j('/patenschaft');
  check('2c: ohne Token 401', r401.status === 401, { status: r401.status });

  // ---- 3) Der erste Sieg zahlt beide Seiten genau einmal -----------------------------------------
  const staubBen0 = await staubMenge('ben');     // /api/me bucht hier die Tagesgutschrift - Basis danach
  const staubAnna0 = await staubMenge('anna');
  const sieg1 = await angriffBis('ben', ID.opfer1, true);
  check('3a: ein Sieg gegen das erste Opfer ist erzwungen', sieg1.ok, { versuche: sieg1.versuche, status: sieg1.antwort && sieg1.antwort.status, body: sieg1.antwort && sieg1.antwort.body && sieg1.antwort.body.error });
  const ben3 = await stand('ben');
  const anna3 = await stand('anna');
  const ts3 = pt(ben3) && pt(ben3).meilensteine && pt(ben3).meilensteine['erster-sieg'];
  check('3b: der Meilenstein steht mit demselben Zeitstempel auf BEIDEN Seiten',
    typeof ts3 === 'number' && ts3 > vorher && sl(anna3)[0] && (sl(anna3)[0].meilensteine || {})['erster-sieg'] === ts3,
    { ben: pt(ben3) && pt(ben3).meilensteine, anna: sl(anna3)[0] && sl(anna3)[0].meilensteine });
  const rwBen = await claim('ben');
  check('3c: der Schuetzling bekommt den Reward mit Rolle, Meilenstein, 200 Krediten, 3 Staub und dem Namen des Paten',
    !!rwBen && rwBen.type === 'patenschaft' && rwBen.rolle === 'schuetzling' && rwBen.meilenstein === 'erster-sieg' &&
    rwBen.credits === 200 && rwBen.staub === 3 && rwBen.partnerName === 'anna' && /Spielerangriff/.test(String(rwBen.name)),
    rwBen);
  const rwAnna = await claim('anna');
  check('3d: der Pate bekommt seinen Reward mit 150 Krediten und dem Namen des Schuetzlings',
    !!rwAnna && rwAnna.type === 'patenschaft' && rwAnna.rolle === 'pate' && rwAnna.meilenstein === 'erster-sieg' &&
    rwAnna.credits === 150 && rwAnna.staub === 3 && rwAnna.partnerName === 'ben', rwAnna);
  check('3e: danach ist die Warteschlange auf beiden Seiten leer - genau einmal',
    (await claim('ben')) === null && (await claim('anna')) === null);
  const staubBen1 = await staubMenge('ben');
  const staubAnna1 = await staubMenge('anna');
  check('3f: den Sternenstaub hat der SERVER gebucht - +3 auf beiden Seiten',
    staubBen1 === staubBen0 + 3 && staubAnna1 === staubAnna0 + 3,
    { ben: [staubBen0, staubBen1], anna: [staubAnna0, staubAnna1] });
  const post = await hole('/notifications', 'anna');
  const pe = ((post.body || {}).notifications || []).find(n => n.type === 'patenschaft');
  check('3g: der Pate hat einen Postfach-Eintrag mit Schuetzling, Meilenstein und Sprungziel Einstellungen',
    !!pe && pe.payload && pe.payload.schuetzling === 'ben' && pe.payload.meilenstein === 'erster-sieg' && pe.ziel === 'einstellungen',
    pe || { typen: ((post.body || {}).notifications || []).map(n => n.type) });

  // ---- 4) Der zweite Sieg zahlt nichts -----------------------------------------------------------
  const sieg2 = await angriffBis('ben', ID.opfer2, true);
  check('4-bau: ein zweiter Sieg gegen ein frisches Opfer ist erzwungen', sieg2.ok, { versuche: sieg2.versuche });
  check('4a: der Schuetzling bekommt fuer den zweiten Sieg nichts', (await claim('ben')) === null);
  check('4b: der Pate ebenfalls nichts', (await claim('anna')) === null);

  // ---- 5) Nach Ablauf nichts - und mit Laufzeit wieder ------------------------------------------
  await aendereDb(d => {
    if (d.users.ben.pate) d.users.ben.pate.bis = Date.now() - 1000;
    if (d.users.anna.schuetzlinge && d.users.anna.schuetzlinge[ID.ben]) d.users.anna.schuetzlinge[ID.ben].bis = Date.now() - 1000;
  });
  const h1 = await sende('/market/trade', 'ben', { action: 'buy', resource: 'erz', amount: 10 });
  check('5-bau: der Handel selbst geht durch', h1.status === 200 && h1.body.ok === true, { status: h1.status, body: h1.body && h1.body.error });
  const ben5 = await stand('ben');
  check('5a: nach Ablauf wird der Meilenstein nicht gesetzt - die Route zeigt ihn als abgelaufen',
    pt(ben5) && pt(ben5).aktiv === false && !(pt(ben5).meilensteine || {})['erster-handel'],
    { pate: pt(ben5) });
  check('5b: und der Schuetzling bekommt nichts', (await claim('ben')) === null);
  check('5c: der Pate auch nichts', (await claim('anna')) === null);
  await aendereDb(d => {
    if (d.users.ben.pate) d.users.ben.pate.bis = Date.now() + 30 * TAG;
    if (d.users.anna.schuetzlinge && d.users.anna.schuetzlinge[ID.ben]) d.users.anna.schuetzlinge[ID.ben].bis = Date.now() + 30 * TAG;
  });
  const h2 = await sende('/market/trade', 'ben', { action: 'sell', resource: 'erz', amount: 10 });
  const rwBen5 = await claim('ben');
  check('5d: mit Laufzeit zahlt derselbe Handel den Meilenstein "erster-handel" (Gegenrichtung zu 5a)',
    h2.status === 200 && !!rwBen5 && rwBen5.type === 'patenschaft' && rwBen5.meilenstein === 'erster-handel' && rwBen5.rolle === 'schuetzling',
    { status: h2.status, reward: rwBen5 });
  const rwAnna5 = await claim('anna');
  check('5e: und dem Paten', !!rwAnna5 && rwAnna5.type === 'patenschaft' && rwAnna5.meilenstein === 'erster-handel' && rwAnna5.rolle === 'pate', rwAnna5);

  // ---- 6/7) Ohne Paten nichts - auch nicht mit selbst geschriebenem Spielstand --------------------
  // Beide Speicherformen (Zeichenkette oder { value, version }) - die Datei ist nach aendereDb aktuell.
  const carlRoh = liesDb().private[ID.carl]['kepler7-save-v3'];
  const carlSave = JSON.parse(typeof carlRoh === 'string' ? carlRoh : carlRoh.value);
  carlSave.pate = { userId: ID.anna, name: 'anna', seit: Date.now(), bis: Date.now() + 30 * TAG, meilensteine: {} };
  carlSave.referredBy = 'anna';
  const put = await s.j('/storage/kepler7-save-v3', { method: 'PUT', headers: kopf(tok.carl), body: JSON.stringify({ value: JSON.stringify(carlSave) }) });
  check('7-bau: der Spielstand mit eingetragenem Paten wurde angenommen', put.status === 200, { status: put.status, body: put.body });
  const carl7 = await stand('carl');
  check('7a: ein selbst in den Spielstand geschriebener `pate` ist fuer den Server unsichtbar',
    carl7 && carl7.pate === null && sl(await stand('anna')).length === 1, { carl: pt(carl7) });
  const sieg3 = await angriffBis('carl', ID.opfer3, true);
  check('6-bau: ein Sieg des Spielers ohne Paten ist erzwungen', sieg3.ok, { versuche: sieg3.versuche });
  check('6a: ohne Paten zahlt der erste Sieg nichts', (await claim('carl')) === null);
  check('6b: und der vermeintliche Pate bekommt nichts', (await claim('anna')) === null);
  await sende('/market/trade', 'carl', { action: 'buy', resource: 'erz', amount: 10 });
  check('6c: auch der Handel ohne Paten zahlt nichts', (await claim('carl')) === null);

  // ---- 8) Die erste Abwehr ------------------------------------------------------------------------
  // Der winzige Angreifer GEWINNT mit ~10 % je Anlauf (PVP_PHASE_MIN = 0.196 je Phase, gemessen am
  // 11.09.2026 in der Gegenprobe `einmal`): Dann traegt der Schuetzling einen Schild (jeder weitere
  // Anlauf 403) und einen pvp-fleet-loss in der Warteschlange. Der Schild wird bei GESTOPPTEM Server
  // genullt (CLAUDE.md), der fremde Reward unten per claimTyp uebersprungen - dann noch einmal.
  let abwehr = null;
  for (let i = 0; i < 6 && !abwehr; i++) {
    const r = await angriff('dora', ID.ben);
    if (r.status === 200 && !r.body.success) { abwehr = { ok: true, versuche: i + 1 }; break; }
    if ((r.status === 200 && r.body.success) || (r.status === 403 && r.body && r.body.shieldMs)) {
      console.log('     (unerwuenschter Sieg des winzigen Angreifers - Schild des Schuetzlings nullen, noch einmal)');
      await aendereDb(d => { if (d.private[ID.ben]) d.private[ID.ben].__attackShieldUntil = 0; });
      continue;
    }
    abwehr = { ok: false, versuche: i + 1, antwort: r };
  }
  if (!abwehr) abwehr = { ok: false, versuche: 6 };
  check('8a: eine Niederlage des winzigen Angreifers gegen den Schuetzling ist erzwungen', abwehr.ok,
    { versuche: abwehr.versuche, status: abwehr.antwort && abwehr.antwort.status, body: abwehr.antwort && abwehr.antwort.body && abwehr.antwort.body.error });
  const ben8 = await stand('ben');
  check('8b: der Meilenstein "erste-abwehr" steht beim Schuetzling',
    pt(ben8) && typeof (pt(ben8).meilensteine || {})['erste-abwehr'] === 'number', pt(ben8) && pt(ben8).meilensteine);
  const rwBen8 = await claimTyp('ben', 'patenschaft');
  check('8c: der Verteidiger bekommt den Reward als Schuetzling', !!rwBen8 && rwBen8.meilenstein === 'erste-abwehr' && rwBen8.rolle === 'schuetzling', rwBen8);
  const rwAnna8 = await claimTyp('anna', 'patenschaft');
  check('8d: der Pate ebenfalls', !!rwAnna8 && rwAnna8.meilenstein === 'erste-abwehr' && rwAnna8.rolle === 'pate', rwAnna8);
  check('8e: der geschlagene Angreifer (ohne Paten) bekommt nichts', (await claimTyp('dora', 'patenschaft')) === null);

  // ---- 9) Fuenf Tage in Folge ---------------------------------------------------------------------
  await aendereDb(d => {
    d.users.ben.staub = Object.assign(d.users.ben.staub || {}, { serie: 4, letzterTag: heute(Date.now() - TAG) });
  });
  const me9 = await hole('/me', 'ben');
  check('9a: /api/me zaehlt die Serie auf 5', me9.status === 200 && me9.body.staub && me9.body.staub.serie === 5, me9.body && me9.body.staub);
  const rwBen9 = await claimTyp('ben', 'patenschaft');
  check('9b: und der Meilenstein "serie-5" zahlt den Schuetzling', !!rwBen9 && rwBen9.meilenstein === 'serie-5', rwBen9);
  const rwAnna9 = await claimTyp('anna', 'patenschaft');
  check('9c: und den Paten', !!rwAnna9 && rwAnna9.type === 'patenschaft' && rwAnna9.meilenstein === 'serie-5' && rwAnna9.rolle === 'pate', rwAnna9);
  await hole('/me', 'ben');
  check('9d: ein weiterer /api/me-Aufruf am selben Tag zahlt nichts noch einmal', (await claimTyp('ben', 'patenschaft')) === null);

  // ---- 10) Nest- und Festungs-Hook stehen in ihren Routen (Quelltext-Anker) ----------------------
  const route = (pfad) => { const a = roh.indexOf("app.post('" + pfad + "'"); const b = roh.indexOf('\napp.', a + 1); return a > 0 && b > a ? roh.slice(a, b) : ''; };
  check('10a: /api/alien/nest-angriff ruft den Meilenstein "erster-schlag" vor dem Speichern',
    /patenschaftMeilenstein\(req\.userId, 'erster-schlag'\);[\s\S]{0,120}await saveDb\(\);/.test(route('/api/alien/nest-angriff')));
  check('10b: /api/festung/angriff ebenfalls',
    /patenschaftMeilenstein\(req\.userId, 'erster-schlag'\);[\s\S]{0,120}await saveDb\(\);/.test(route('/api/festung/angriff')));

  // ---- 11) Der Deckel -----------------------------------------------------------------------------
  await aendereDb(d => {
    const jetzt = Date.now();
    d.users.anna.schuetzlinge = d.users.anna.schuetzlinge || {};
    for (let i = 0; i < 9; i++) d.users.anna.schuetzlinge['fake-' + i] = { name: 'fake' + i, seit: jetzt - (20 - i) * TAG, bis: jetzt + 5 * TAG, meilensteine: {} };
  });
  check('11-bau: der Pate hat jetzt zehn laufende Schuetzlinge', sl(await stand('anna')).length === 10);
  const r11 = await sende('/referral/redeem', 'emil', { referrerUsername: 'anna' });
  check('11a: bei zehn laufenden gibt es keinen Platz - der Redeem selbst bleibt in Ordnung, ohne Paten-Feld',
    r11.status === 200 && r11.body.status === 'pending' && r11.body.patenschaft === undefined, r11.body);
  check('11b: beide Seiten bleiben ohne Eintrag, kein laufender wurde verdraengt',
    pt(await stand('emil')) === null && sl(await stand('anna')).length === 10 &&
    sl(await stand('anna')).every(x => x.aktiv === true));
  await aendereDb(d => { for (let i = 0; i < 9; i++) if (d.users.anna.schuetzlinge['fake-' + i]) d.users.anna.schuetzlinge['fake-' + i].bis = Date.now() - 1000; });
  const r11c = await sende('/referral/redeem', 'fritz', { referrerUsername: 'anna' });
  const anna11 = sl(await stand('anna'));
  check('11c: sind welche abgelaufen, fliegt der aelteste abgelaufene und der naechste passt wieder',
    r11c.status === 200 && r11c.body.patenschaft && r11c.body.patenschaft.name === 'anna' &&
    anna11.length === 10 && anna11.some(x => x.name === 'fritz') && !anna11.some(x => x.name === 'fake0') && anna11.some(x => x.name === 'ben'),
    { anzahl: anna11.length, namen: anna11.map(x => x.name) });
  check('11d: der neue Schuetzling sieht seinen Paten', (pt(await stand('fritz')) || {}).name === 'anna');

  await stoppeServer();

  // ---- Auswertung: Gruen-Lauf ODER Gegenprobe --------------------------------------------------
  if (SAB) {
    const soll = MUSS_FALLEN[SAB] || [];
    const gefallen = [...new Set(Object.keys(ergebnis).filter(n => ergebnis[n] === false).map(n => String(n).split(':')[0]))].sort();
    const fehlt = soll.filter(k => gefallen.indexOf(k) < 0);
    const zuviel = gefallen.filter(k => soll.indexOf(k) < 0);
    console.log('\nGegenprobe „' + SAB + '": gefallen ' + JSON.stringify(gefallen) + ', erwartet ' + JSON.stringify(soll));
    if (fehlt.length || zuviel.length) {
      console.log('FAIL - Gegenprobe: nicht gefallen ' + JSON.stringify(fehlt) + ', unerwartet gefallen ' + JSON.stringify(zuviel));
      process.exit(1);
    }
    console.log('PASS - Gegenprobe: genau die erwarteten Pruefungen sind gefallen.');
    process.exit(0);
  }
  console.log(fail ? '\nFAIL - mindestens eine Pruefung ist gefallen.' : '\nPASS');
  process.exit(fail ? 1 : 0);
})();
