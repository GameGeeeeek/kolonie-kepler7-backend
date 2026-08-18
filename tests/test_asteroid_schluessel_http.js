// Echter HTTP-Test: 'asteroids:<sys>' ist im geteilten Speicher gegen fremdes SCHREIBEN gesperrt.
//
//   node tests/test_asteroid_schluessel_http.js
//
// DER BEFUND, den dieser Test festhaelt (18.08.2026, beim Entwurf der Asteroidenfestungen):
// Die Schreibpruefung der generischen Storage-Route ist eine Kette EXPLIZITER Erlaubnisregeln
// (checkAllianceKeyPermission || checkPactKeyPermission || … ). 'asteroids:' stand in keiner davon
// und war damit die einzige Schluesselfamilie im geteilten Speicher ohne Regel.
//
// Gemessen am Stand DAVOR: Ein beliebiges zweites Konto schreibt mit EINER Anfrage die
// Zeichenkette "kaputt" auf 'asteroids:<sys>' und bekommt HTTP 200. Danach ist das Feld weg -
// astAlleFelder() prueft `typeof feld !== 'object'`, findet eine Zeichenkette und erzeugt das
// Guertelfeld komplett neu. Alle Schuerfrechte ALLER Spieler in diesem System sind geloescht,
// ihre stationierten Eskorten stranden. Zwanzig Anfragen raeumen die ganze Galaxie ab.
//
// Das ist genau die Grenze, die dieses Projekt verteidigt (CLAUDE.md, "Wo die Sicherheitsgrenze
// wirklich verlaeuft"): "Kann ich etwas anfassen, das ANDEREN gehoert oder allen gemeinsam?"
// Hier beides. Dieselbe Klasse wie der Weltboss-Schluessel (tests/test_weltboss_schluessel_http.js).
//
// GEPRUEFT WIRD:
//   1. Aufbau: zwei Konten, das Opfer meldet ein Schuerfrecht an, es steht im Felddokument.
//   2. Der Taeter schreibt per generischer Route auf 'asteroids:<sys>' -> 403 MIT GRUND im
//      Fehlertext (Arbeitsregel 28: nicht nur den Statuscode pruefen - eine Ablehnung aus dem
//      falschen Grund, etwa dem Mengendeckel, waere hier nicht zu unterscheiden).
//   3. Das Schuerfrecht des Opfers ueberlebt, und das Feld ist noch dasselbe (dieselben Plaetze,
//      derselbe Vorrat) - der eigentliche Schaden, nicht der Statuscode.
//   4. Auch der HALTER selbst darf nicht ueber die generische Route schreiben. Die Sperre ist
//      vollstaendig, keine Eigentumspruefung: es gibt keinen legitimen Schreibweg dorthin.
//   5. LESEN bleibt offen - der Guertel ist oeffentlich, und die Sperre darf ihn nicht zumauern.
//   6. Die dedizierten Endpunkte funktionieren unveraendert weiter (mine buchte ab, claim/release
//      wirken) - die Sperre trifft keinen echten Aufruf.
//   7. Andere Schluessel im geteilten Speicher bleiben unberuehrt (ein frei gewaehlter Schluessel
//      laesst sich weiterhin schreiben) - die neue Regel greift nur ihr Praefix.
//
// GEGENPROBE (in beide Richtungen ausgefuehrt):
//   * Gegen den Stand OHNE checkAsteroidKeyPermission fallen 2a, 2b, 3a und 3b:
//       FAIL - 2a: fremdes Schreiben wird abgewiesen | {"status":200}
//       FAIL - 3a: das Schuerfrecht des Opfers ueberlebt | {"halterNachher":undefined}
//     Genau das ist der Befund - der Test IST die Messung.
//   * Nimmt man das `if (!isWrite) return null;` aus der neuen Funktion heraus, faellt 5a
//     (Lesen waere dann mitgesperrt) und mit ihm 6a-6c.
//   * Sperrt man statt des Praefixes pauschal alles, faellt 7a.
//
// Port 3219: 3195-3200 und 3210-3218 sind belegt (Arbeitsregel 29, `grep -rho "3[12][0-9][0-9]" tests/*.js`).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3219;

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const OPFER = crypto.randomUUID(), TAETER = crypto.randomUUID();

function spielstand(id, name, fleet) {
  return JSON.stringify({
    resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {},
    fleet: Object.assign({ missions: [] }, fleet),
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  });
}
function grunddb() {
  return {
    users: {
      opfer: { userId: OPFER, username: 'opfer', passwordHash: hash, createdAt: Date.now() },
      taeter: { userId: TAETER, username: 'taeter', passwordHash: hash, createdAt: Date.now() }
    },
    private: {
      [OPFER]: { 'kepler7-save-v3': spielstand(OPFER, 'opfer', { schuerfschiff: 50 }) },
      [TAETER]: { 'kepler7-save-v3': spielstand(TAETER, 'taeter', { schuerfschiff: 50 }) }
    },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {} }
  };
}

async function starteServer() {
  const dbPfad = path.join(os.tmpdir(), 'kepler-astschluessel-' + process.pid + '.json');
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  let log = '';
  const srv = spawn(process.execPath, [path.join(WURZEL, 'server.js')], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, { DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
  const basis = 'http://127.0.0.1:' + PORT + '/api';
  const ende = () => { try { srv.kill(); } catch (e) {} try { fs.unlinkSync(dbPfad); } catch (e) {} };
  process.on('exit', ende);
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
  return { j, anmelden, ende, protokoll: () => log };
}

(async () => {
  const s = await starteServer();
  const tokO = await s.anmelden('opfer');
  const tokT = await s.anmelden('taeter');
  check('0: zwei Konten angemeldet', !!tokO && !!tokT);
  if (!tokO || !tokT) { console.log(s.protokoll().slice(-1500)); console.log('\nFAIL'); process.exit(1); }
  const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });

  // ---- 1) Aufbau: das Opfer haelt ein Schuerfrecht ------------------------------------------
  const f1 = await s.j('/asteroid/field', { headers: kopf(tokO) });
  check('1a: Gürtelfeld lesbar', f1.status === 200 && !!(f1.body && f1.body.felder), f1.status);
  if (f1.status !== 200) { console.log(s.protokoll().slice(-1500)); console.log('\nFAIL'); process.exit(1); }
  const sys = (f1.body.systeme || [])[0];
  const plaetzeVorher = Object.keys(f1.body.felder[sys].plaetze).sort();
  const platz = plaetzeVorher.find(p => { const v = f1.body.felder[sys].plaetze[p]; return v && !v.frei && v.vorrat > 0; });
  check('1b: ein belegter Platz gefunden', !!platz, { sys, platz, plaetze: plaetzeVorher.length });

  const claim = await s.j('/asteroid/claim', { method: 'POST', headers: kopf(tokO),
    body: JSON.stringify({ system: sys, platz }) });
  check('1c: Schürfrecht angemeldet', claim.status === 200 && claim.body.halterName === 'opfer',
    { status: claim.status, body: claim.body });

  const f2 = await s.j('/asteroid/field', { headers: kopf(tokO) });
  const vorher = f2.body.felder[sys];
  check('1d: der Halter steht im Felddokument', vorher.plaetze[platz].halterName === 'opfer',
    vorher.plaetze[platz].halterName);
  const vorratVorher = vorher.plaetze[platz].vorrat;

  // ---- 2) Der Angriff: fremdes Schreiben ueber die generische Route --------------------------
  const angriff = await s.j('/storage/asteroids:' + sys + '?shared=true', {
    method: 'PUT', headers: kopf(tokT), body: JSON.stringify({ value: 'kaputt' }) });
  check('2a: fremdes Schreiben wird abgewiesen', angriff.status === 403,
    { status: angriff.status, antwort: angriff.body });
  // Arbeitsregel 28: den GRUND pruefen, nicht nur den Statuscode - eine Ablehnung aus dem
  // Mengendeckel oder dem Schluessel-Limit waere sonst nicht zu unterscheiden.
  const grund = String((angriff.body && angriff.body.error) || '');
  check('2b: die Ablehnung nennt den Grund (Asteroiden-Endpunkte)', /Asteroidenfeld/i.test(grund) && /Endpunkt/i.test(grund), grund);

  // Auch ein wohlgeformtes Feld-Objekt darf nicht durch - es geht nicht um das Format.
  const angriff2 = await s.j('/storage/asteroids:' + sys + '?shared=true', {
    method: 'PUT', headers: kopf(tokT),
    body: JSON.stringify({ value: JSON.stringify({ plaetze: {} }) }) });
  check('2c: auch ein wohlgeformtes Feld wird abgewiesen', angriff2.status === 403, angriff2.status);

  // ---- 3) Der eigentliche Schaden: bleibt das Schürfrecht stehen? ---------------------------
  const f3 = await s.j('/asteroid/field', { headers: kopf(tokO) });
  const nachher = f3.body.felder[sys];
  check('3a: das Schürfrecht des Opfers überlebt',
    !!nachher && !!nachher.plaetze[platz] && nachher.plaetze[platz].halterName === 'opfer',
    { halterNachher: nachher && nachher.plaetze[platz] && nachher.plaetze[platz].halterName,
      plaetzeNachher: nachher ? Object.keys(nachher.plaetze).sort() : null });
  check('3b: das Feld wurde nicht neu gewürfelt',
    !!nachher && JSON.stringify(Object.keys(nachher.plaetze).sort()) === JSON.stringify(plaetzeVorher)
    && nachher.plaetze[platz] && nachher.plaetze[platz].vorrat === vorratVorher,
    { vorratVorher, vorratNachher: nachher && nachher.plaetze[platz] && nachher.plaetze[platz].vorrat });

  // ---- 4) Die Sperre ist vollständig, keine Eigentumsprüfung --------------------------------
  const selbst = await s.j('/storage/asteroids:' + sys + '?shared=true', {
    method: 'PUT', headers: kopf(tokO), body: JSON.stringify({ value: 'auch nicht' }) });
  check('4a: auch der Halter darf nicht über die generische Route schreiben', selbst.status === 403, selbst.status);

  // ---- 5) Lesen bleibt offen ----------------------------------------------------------------
  const lesen = await s.j('/storage/asteroids:' + sys + '?shared=true', { headers: kopf(tokT) });
  check('5a: Lesen bleibt erlaubt (der Gürtel ist öffentlich)', lesen.status === 200 || lesen.status === 404,
    { status: lesen.status });

  // ---- 6) Die echten Endpunkte funktionieren unverändert ------------------------------------
  const mine = await s.j('/asteroid/mine', { method: 'POST', headers: kopf(tokO),
    body: JSON.stringify({ system: sys, platz, wunsch: 500 }) });
  check('6a: der Halter darf weiterhin über /asteroid/mine abbauen', mine.status === 200 && mine.body.menge > 0,
    { status: mine.status, body: mine.body });
  const f4 = await s.j('/asteroid/field', { headers: kopf(tokO) });
  check('6b: der Vorrat ist um genau die entnommene Menge gesunken',
    f4.body.felder[sys].plaetze[platz].vorrat === vorratVorher - mine.body.menge,
    { vorher: vorratVorher, menge: mine.body.menge, nachher: f4.body.felder[sys].plaetze[platz].vorrat });
  const release = await s.j('/asteroid/release', { method: 'POST', headers: kopf(tokO),
    body: JSON.stringify({ system: sys, platz }) });
  check('6c: /asteroid/release wirkt weiterhin', release.status === 200, release.status);

  // ---- 7) Die Regel greift nur ihr Präfix ---------------------------------------------------
  const fremd = await s.j('/storage/testschluessel:xyz?shared=true', {
    method: 'PUT', headers: kopf(tokT), body: JSON.stringify({ value: 'egal' }) });
  check('7a: ein Schlüssel ohne Sonderregel bleibt schreibbar', fremd.status === 200, fremd.status);
  const fastAst = await s.j('/storage/asteroidenkarte?shared=true', {
    method: 'PUT', headers: kopf(tokT), body: JSON.stringify({ value: 'egal' }) });
  check('7b: ein Schlüssel, der nur ÄHNLICH heißt, ist nicht mitgesperrt', fastAst.status === 200, fastAst.status);

  s.ende();
  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nalles sauber');
  process.exit(fail ? 1 : 0);
})();
