// Echter HTTP-Test: Urmaterie-Nachsaat (einmalig) und -Boden (dauerhaft) in astAlleFelder.
//
//   node tests/test_urmaterie_boden_http.js
//
// Anlass (Spieler-Report Sascha, 22.08.2026): "kein einziger Urmaterie-Asteroid". Die Felder
// wurden am 16.08. mit der Sortentabelle VOR Backend #117 erzeugt und nie migriert - die
// Startpopulation konnte bauartbedingt keinen Urmateriekern enthalten, und neue Sorten
// entstehen nur nach vollstaendiger Leerfoerderung (p = 3/103 je Neuwurf).
//
// GEPRUEFT WIRD:
//   1. Der ANLASSFALL, deterministisch gestellt: Felder existieren, KEIN urmaterie, kein
//      Marker (exakt der Live-Zustand vor dieser Etappe). Ein Feld-Abruf sät genau 3 nach -
//      in drei VERSCHIEDENEN Systemen, ohne ein bestehendes Vorkommen anzufassen.
//   2. Idempotenz: Der Marker (db.galaxy, ueber die Storage-Route nicht erreichbar) verhindert
//      eine zweite Nachsaat - auch ueber einen Server-Neustart hinweg.
//   3. Der BODEN: Verschwindet der letzte Urmateriekern (Marker steht laengst), setzt der
//      naechste Abruf genau EINEN - und bei Bestand >= 1 keinen weiteren. Beide Haelften
//      gehoeren zusammen: Die erste allein waere auch von einer Dauer-Nachsaat erfuellt,
//      die zweite allein von gar keiner Mechanik (Regel 28).
//   4. Das Gesetzte ist ein normales Vorkommen (Groesse aus AST_GROESSEN, Vorrat > 0) - kein
//      Sonderobjekt, das an einer anderen Stelle sofort auffiele.
//
// GEGENPROBE (Regel 71 mit Pflichtliste, GEMESSEN am 28.08.2026): server.js-Kopie ohne den
// Nachsaat/Boden-Block im Repo-Verzeichnis (wegen require('./mailer'), wie
// test_alien_nester_http), via URMATERIE_TEST_SERVER. Am alten Stand fallen
// 1a, 1b, 1d, 1e, 2a, 3a, 3b und 3c; gruen bleiben nur 0, 0b und 1c.
// Die erste Fassung dieser Liste war doppelt falsch und ist selbst die Lehre:
// 1b/1d/3c waren am alten Stand aus dem FALSCHEN Grund gruen (leere Liste bzw.
// undefined === undefined, Regel 28) und sind seither geschaerft; und 3b faellt dort
// sehr wohl, weil es gegen den in 3a GEMESSENEN Bestand 1 prueft - "bleibt gruen" hatte
// die Mechanik-Abwesenheit mit "unveraendert 0" verwechselt.
//
// Port 3232: 3195-3200 und 3210-3231 sind belegt (Arbeitsregel 29, breit gemessen mit
// grep -rhoE "32[0-9]{2}" tests/*.js - die schmale "PORT ="-Suche uebersieht drei Dateien).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
// Fuer die Gegenprobe umleitbar - die Kopie MUSS im Repo-Verzeichnis liegen (require('./mailer')).
const SERVER_DATEI = process.env.URMATERIE_TEST_SERVER || 'server.js';
const PORT = 3232;

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ANNA = crypto.randomUUID();

function grunddb() {
  return {
    users: { anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() } },
    private: { [ANNA]: { 'kepler7-save-v3': JSON.stringify({
      resources: { energie: 1e5, erz: 1e5, kristalle: 1e5, deuterium: 1e5, antimaterie: 10, forschungspunkte: 10 },
      buildings: {}, research: {}, colonies: {}, fleet: { missions: [], schuerfschiff: 10 },
      player: { id: ANNA, name: 'anna' }, credits: 100, xp: 100, lastTick: Date.now()
    }) } },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {} }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-urmaterie-' + process.pid + '.json');
let srv = null;
let s = null, tokA = null;
function ende() { try { if (srv) srv.kill(); } catch (e) {} try { fs.unlinkSync(dbPfad); } catch (e) {} }
process.on('exit', ende);

async function starteServer() {
  let log = '';
  srv = spawn(process.execPath, [path.join(WURZEL, SERVER_DATEI)], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, { DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret' }),
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
  srv.kill('SIGTERM');            // flusht die DB - hier gewollt: gemessen wird ZUSTAND, nicht Persistenz
  await warte(700);
  srv = null;
}
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  s = await starteServer();
  tokA = await s.anmelden('anna');
}

// Urmaterie-Vorkommen aus einer Felder-Antwort bzw. der DB zaehlen - dieselbe Filterung wie
// astBelegtZahl (belegt, Vorrat > 0), damit der Test nicht eine eigene Definition erfindet.
function zaehle(felder) {
  const funde = [];
  for (const [sys, feld] of Object.entries(felder || {})) {
    for (const [platz, p] of Object.entries((feld && feld.plaetze) || {})) {
      if (p && !p.frei && p.sorte === 'urmaterie' && (p.vorrat || 0) > 0) funde.push({ sys, platz, groesse: p.groesse, vorrat: p.vorrat });
    }
  }
  return funde;
}
function felderAusDb(d) {
  const felder = {};
  for (const [k, v] of Object.entries(d.shared || {})) {
    if (k.indexOf('asteroids:') === 0) felder[k.slice(10)] = typeof v === 'string' ? JSON.parse(v) : v;
  }
  return felder;
}

(async () => {
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  s = await starteServer();
  tokA = await s.anmelden('anna');
  check('0: Konto angemeldet', !!tokA);
  if (!tokA) { console.log(s.protokoll().slice(-1500)); process.exit(1); }
  const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });

  // Erstabruf erzeugt die Felder (lazy) - danach stellen wir den ANLASSFALL deterministisch her.
  const f0 = await s.j('/asteroid/field', { headers: kopf(tokA) });
  check('0b: Guertelfeld lesbar', f0.status === 200 && !!(f0.body && f0.body.felder), f0.status);
  if (f0.status !== 200) { console.log(s.protokoll().slice(-1500)); process.exit(1); }

  // ---- 1) Der Anlassfall: Population ohne urmaterie, kein Marker ---------------------------
  let vorher = { belegt: 0 };
  await aendereDb(d => {
    for (const [k, v] of Object.entries(d.shared)) {
      if (k.indexOf('asteroids:') !== 0) continue;
      const feld = typeof v === 'string' ? JSON.parse(v) : v;
      for (const p of Object.values(feld.plaetze || {})) {
        if (p && !p.frei && (p.vorrat || 0) > 0) { if (p.sorte === 'urmaterie') p.sorte = 'eisen'; vorher.belegt++; }
      }
      d.shared[k] = feld;
    }
    if (d.galaxy) delete d.galaxy.urmaterieNachsaat;
  });
  const f1 = await s.j('/asteroid/field', { headers: kopf(tokA) });
  const u1 = zaehle(f1.body && f1.body.felder);
  check('1a: die Nachsaat setzt genau 3 Urmateriekerne', u1.length === 3, u1);
  // u1.length === 3 gehoert HIERHER, nicht nur in 1a: ueber der leeren Liste ist
  // "alle verschieden" trivial wahr - genau so war 1b in der ersten Gegenprobe am alten
  // Stand gruen, ohne etwas zu belegen (Regel 28).
  check('1b: in drei VERSCHIEDENEN Systemen (verteilt, kein gefluteter Guertel)',
    u1.length === 3 && new Set(u1.map(x => x.sys)).size === 3, u1.map(x => x.sys));
  const belegt1 = Object.values(f1.body.felder).reduce((n, feld) =>
    n + Object.values(feld.plaetze || {}).filter(p => p && !p.frei && (p.vorrat || 0) > 0).length, 0);
  check('1c: nichts Bestehendes wurde geloescht oder umgewuerfelt - nur hinzugefuegt',
    belegt1 >= vorher.belegt + u1.length - 0 && belegt1 <= vorher.belegt + 3,
    { vorher: vorher.belegt, nachher: belegt1 });
  check('1d: jedes gesetzte Vorkommen ist ein normales (Groesse bekannt, Vorrat > 0)',
    u1.length > 0 && u1.every(x => ['splitter','brocken','kern','koloss'].includes(x.groesse) && x.vorrat > 0), u1);

  await stoppeServer();
  const d1 = liesDb();
  check('1e: der Marker steht in db.galaxy (von der Storage-Route aus unerreichbar)',
    !!(d1.galaxy && d1.galaxy.urmaterieNachsaat > 0), d1.galaxy && d1.galaxy.urmaterieNachsaat);

  // ---- 2) Idempotenz ueber einen Neustart --------------------------------------------------
  s = await starteServer(); tokA = await s.anmelden('anna');
  const f2 = await s.j('/asteroid/field', { headers: kopf(tokA) });
  const u2 = zaehle(f2.body && f2.body.felder);
  check('2a: ein zweiter Abruf nach Neustart saet NICHT erneut (weiterhin 3)', u2.length === 3, u2.length);

  // ---- 3) Der Boden: Bestand 0 -> genau 1; Bestand >= 1 -> nichts --------------------------
  let markerVorher = null;
  await aendereDb(d => {
    for (const [k, v] of Object.entries(d.shared)) {
      if (k.indexOf('asteroids:') !== 0) continue;
      const feld = typeof v === 'string' ? JSON.parse(v) : v;
      for (const p of Object.values(feld.plaetze || {})) {
        if (p && !p.frei && p.sorte === 'urmaterie') p.sorte = 'eisen';
      }
      d.shared[k] = feld;
    }
    // Marker bleibt AUSDRUECKLICH stehen - gemessen wird der Boden, nicht die Nachsaat.
    // Der Vergleichswert kommt aus DIESEM Schreibvorgang, nicht aus einem spaeteren Dateilesen
    // bei laufendem Server - ein Messwerkzeug darf sich nicht selbst im Weg stehen (Regel 15/17/19).
    markerVorher = d.galaxy && d.galaxy.urmaterieNachsaat;
  });
  const f3 = await s.j('/asteroid/field', { headers: kopf(tokA) });
  const u3 = zaehle(f3.body && f3.body.felder);
  check('3a: Bestand 0 -> der Boden setzt genau EINEN Urmateriekern', u3.length === 1, u3);
  const f4 = await s.j('/asteroid/field', { headers: kopf(tokA) });
  const u4 = zaehle(f4.body && f4.body.felder);
  check('3b: Bestand >= 1 -> kein weiterer (der Boden greift nur bei 0)', u4.length === 1, u4.length);
  await stoppeServer();
  const d3 = liesDb();
  // Erst einen WERT verlangen, dann die Beziehung - undefined === undefined ist auch
  // "unveraendert" (dieselbe Lehre wie in test_health_commit_http: eine Prüfung über
  // Felder, die es am Vergleichsstand gar nicht gibt, prüft sonst nur, dass beide fehlen).
  check('3c: die Nachsaat lief dabei NICHT erneut (Marker-Zeitstempel unveraendert)',
    markerVorher > 0 && d3.galaxy && d3.galaxy.urmaterieNachsaat === markerVorher, { vorher: markerVorher, nachher: d3.galaxy && d3.galaxy.urmaterieNachsaat });

  process.exitCode = fail ? 1 : 0;
  console.log(fail ? 'FAIL - es gab rote Pruefungen.' : 'PASS - alle Pruefungen gruen.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL - Testlauf abgebrochen | ' + (e && e.message)); process.exit(1); });
