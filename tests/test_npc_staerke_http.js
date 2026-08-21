// Echter HTTP-Test: die galaktische Gegnerstaerke wird beweglich (Phase 4).
//
//   node tests/test_npc_staerke_http.js
//
// Bis Phase 4 wuchs `npcEmpireStrength` monoton bis 2,5 und blieb dort - ein Schwierigkeitsregler,
// den niemand bewegen kann. Neu leitet der galaxyTick einen ZIELWERT aus dem Nestbestand ab und
// laesst den Ist-Wert dorthin driften.
//
// GEPRUEFT WIRD:
//   1. Der ZIELWERT leitet sich aus dem Nestbestand ab - gemessen an drei eingefrorenen
//      Bestaenden (keiner, mittel, ueber dem Deckel), nicht am Quelltext.
//   2. Die Drift ist ein SCHRITT, kein Sprung: ein Tick bewegt den Ist-Wert um genau 4 % des
//      Abstands. Zwei Ticks nacheinander belegen, dass es sich wiederholt und nicht einrastet.
//   3. DAS TOR. Mit ausgeschaltetem NEST_SPAWN_AKTIV bleibt das ALTE monotone Wachstum - der
//      Wert WAECHST, statt ohne Nester auf die Basis zu fallen. Das ist die Messung, die den
//      Merge schuetzt: Ohne dieses Tor faellt die NPC-Verteidigung um 44 %, allein dadurch, dass
//      diese Phase gemergt wird, waehrend Phase 3 noch schlaeft.
//   4. Der Zielwert reist zum Client - und nur dann, wenn es ihn gibt. Ein Server mit
//      ausgeschaltetem Tor darf das Feld GAR NICHT fuehren, sonst behauptet die Anzeige eine
//      Weltlage, die nirgends gilt.
//   5. Der Deckel bindet in BEIDE Richtungen: nie ueber 2,5, nie unter 1.
//
// GEGENPROBEN (in beide Richtungen ausfuehren, Arbeitsregel 1):
//   * Das `if (NEST_SPAWN_AKTIV)` ausgebaut  -> 3a faellt (der Wert faellt statt zu wachsen).
//   * `g.npcEmpireStrength = ziel` statt der Drift -> 2a/2b fallen.
//   * Den Deckel aus npcStaerkeZiel entfernt -> 1c faellt.
//
// Port 3227: 3195-3200 und 3210-3226 sind belegt (Arbeitsregel 29).
//
// WARUM DER TEST ZWEI KOPIEN VON server.js STARTET: Der Gegenstand ist ein SCHALTER. Beide
// Stellungen gehoeren gemessen, und welche gerade committet ist, darf das Ergebnis nicht
// verschieben - genau wie bei test_alien_nester_http.js. Die Kopien liegen im Repo-Verzeichnis
// (damit `require('./mailer')` aufloest) und werden im process.on('exit') weggeraeumt.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3227;
const AN  = path.join(WURZEL, 'server_p4an_tmp.js');
const AUS = path.join(WURZEL, 'server_p4aus_tmp.js');

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));
const rund = (v, n) => Math.round(v * Math.pow(10, n)) / Math.pow(10, n);

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ANNA = crypto.randomUUID();

/* Die Erwartung wird HIER neu ausgerechnet, nicht aus dem Server gelesen - sonst prueft der Test
   die Formel gegen sich selbst (Frontend-Arbeitsregel 62). Die Eingabe dagegen wird BEOBACHTET:
   der Nestbestand kommt aus der DB nach dem Tick, weil der Tick ihn theoretisch veraendern kann.
   Damit er es nicht tut, friert `einfrieren()` ihn unten ein. */
const STUFEN_PUNKTE = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 };
const BASIS = 1.4, JE_PUNKT = 0.046, DECKEL = 2.5, DRIFT = 0.04;
const zielAus = nester => Math.min(DECKEL, BASIS + JE_PUNKT *
  nester.reduce((a, n) => a + (STUFEN_PUNKTE[n.stufe] || 0), 0));

function spielstand(id, name) {
  return {
    resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {},
    fleet: { missions: [], cruisers: 300 },
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  };
}
function grunddb() {
  return {
    users: { anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() } },
    private: { [ANNA]: { 'kepler7-save-v3': JSON.stringify(spielstand(ANNA, 'anna')) } },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 2.5, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {} }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-npcstaerke-' + process.pid + '.json');
let srv = null, s = null, tok = null;
function ende() {
  try { if (srv) srv.kill(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  for (const f of [AN, AUS]) { try { fs.unlinkSync(f); } catch (e) {} }
}
process.on('exit', ende);

async function starteServer(quelle) {
  let log = '';
  srv = spawn(process.execPath, [quelle], {
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
async function stoppeServer() { if (!srv) return; srv.kill('SIGTERM'); await warte(700); srv = null; }
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));

/* Dieselbe Reihenfolge-Wache wie in test_festung_http.js / test_alien_nester_http.js: Eine
   Aenderung an der DB-DATEI, waehrend der Server laeuft, ist beim naechsten SIGTERM wieder weg -
   der Graceful Shutdown flusht die im Speicher gehaltene db darueber. */
async function aendereDb(quelle, fn) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  s = await starteServer(quelle);
  tok = await s.anmelden('anna');
}

/* DEN BESTAND EINFRIEREN. Ohne das misst der Test eine bewegliche Eingabe: Der galaxyTick laesst
   Nester reifen (Stufe +1), sich ausbreiten (ein Nest mehr), wandern, und er entdeckt mit 6 %
   Wahrscheinlichkeit je Takt ein neues Volk - dem der Nachschub-Zweig SOFORT ein Nest anlegt.
   Genau daran ist im Nest-Test schon einmal eine Pruefung an einem Zufall gescheitert.
   Vier Riegel, einer je Zweig des nestTick. */
function einfrieren(g) {
  const spaeter = Date.now() + 30 * 24 * 3600 * 1000;
  for (const n of (g.alienNester || [])) {
    n.letzteReifung = Date.now();       // 1) reift nicht
    n.naechsterWurf = spaeter;          // 2) breitet sich nicht aus
    n.naechsteWanderung = spaeter;      // 3) wandert nicht
  }
  g.alienPause = g.alienPause || {};
  for (const volk of ['kryll', 'xantheer', 'vex', 'verglueht']) g.alienPause[volk] = spaeter; // 5) kein Nachschub
  // 4) Die Koenigin schluepft ab vier Nestern EINES Volkes - die Bestaende unten bleiben darunter
  //    bzw. tragen bereits eine.
}
const nestObj = (volk, sys, stufe) => ({
  id: crypto.randomUUID(), volk, sys, stufe,
  lp: 100000, lpMax: 100000, seit: Date.now() - 3600000, letzteReifung: Date.now(),
  naechsterWurf: Date.now() + 30 * 24 * 3600 * 1000,
  naechsteWanderung: 0, beitraege: {}, schlaege: {}
});

(async () => {
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  const muster = /const NEST_SPAWN_AKTIV = (true|false);/;
  check('0-kopie: der Schalter ist auffindbar', muster.test(roh), { gefunden: (roh.match(muster) || [])[1] });
  fs.writeFileSync(AN,  roh.replace(muster, 'const NEST_SPAWN_AKTIV = true;'));
  fs.writeFileSync(AUS, roh.replace(muster, 'const NEST_SPAWN_AKTIV = false;'));
  check('0-kopie2: die beiden Kopien unterscheiden sich wirklich',
    fs.readFileSync(AN, 'utf8') !== fs.readFileSync(AUS, 'utf8'));

  // ================================================================================================
  // 1) Der Zielwert leitet sich aus dem Nestbestand ab
  // ================================================================================================
  const faelle = [
    { name: '1a: ohne Nester steht der Zielwert auf der Basis', nester: [] },
    { name: '1b: mittlerer Bestand - der Zielwert liegt dazwischen',
      nester: [nestObj('kryll', 'vega', 2), nestObj('xantheer', 'rigel', 2),
               nestObj('vex', 'altair', 2), nestObj('verglueht', 'deneb', 2)] },
    { name: '1c: ueber dem Deckel bleibt der Zielwert bei 2,5',
      nester: [nestObj('kryll', 'vega', 5), nestObj('kryll', 'rigel', 5), nestObj('kryll', 'altair', 5),
               nestObj('xantheer', 'deneb', 5), nestObj('vex', 'sirius', 5), nestObj('verglueht', 'procyon', 5)] }
  ];
  for (const f of faelle) {
    fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
    {
      const d = liesDb();
      d.galaxy.alienNester = f.nester;
      einfrieren(d.galaxy);
      schreibDb(d);
    }
    s = await starteServer(AN);
    tok = await s.anmelden('anna');
    await warte(500);                       // der setImmediate-Tick des Starts
    await stoppeServer();
    const g = liesDb().galaxy;
    const erwartet = zielAus(g.alienNester || []);
    check(f.name, rund(g.npcStaerkeZiel, 3) === rund(erwartet, 3),
      { gemessen: g.npcStaerkeZiel, erwartet: rund(erwartet, 3),
        nester: (g.alienNester || []).map(n => n.volk + ':' + n.stufe) });
  }

  // ================================================================================================
  // 2) Die Drift ist ein SCHRITT, kein Sprung
  // ================================================================================================
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  {
    const d = liesDb();
    d.galaxy.npcEmpireStrength = 2.5;
    d.galaxy.alienNester = [];
    einfrieren(d.galaxy);
    schreibDb(d);
  }
  s = await starteServer(AN); tok = await s.anmelden('anna'); await warte(500);
  await stoppeServer();
  const nach1 = liesDb().galaxy.npcEmpireStrength;
  const soll1 = 2.5 + (BASIS - 2.5) * DRIFT;
  check('2a: ein Tick bewegt den Ist-Wert um genau 4 % des Abstands',
    rund(nach1, 4) === rund(soll1, 4), { gemessen: rund(nach1, 4), erwartet: rund(soll1, 4) });
  check('2b: und er springt NICHT auf den Zielwert',
    nach1 > BASIS + 0.5, { gemessen: rund(nach1, 4), zielwert: BASIS });

  s = await starteServer(AN); tok = await s.anmelden('anna'); await warte(500);
  await stoppeServer();
  const nach2 = liesDb().galaxy.npcEmpireStrength;
  const soll2 = nach1 + (BASIS - nach1) * DRIFT;
  check('2c: der zweite Tick tut dasselbe noch einmal (es rastet nicht ein)',
    rund(nach2, 4) === rund(soll2, 4) && nach2 < nach1,
    { erst: rund(nach1, 4), dann: rund(nach2, 4), erwartet: rund(soll2, 4) });

  // ================================================================================================
  // 3) DAS TOR - die Messung, die den Merge schuetzt
  // ================================================================================================
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  {
    const d = liesDb();
    d.galaxy.npcEmpireStrength = 2.0;
    d.galaxy.alienNester = [];
    einfrieren(d.galaxy);
    schreibDb(d);
  }
  s = await starteServer(AUS); tok = await s.anmelden('anna'); await warte(500);
  await stoppeServer();
  const ausGalaxy = liesDb().galaxy;
  check('3a: mit ausgeschaltetem Schalter WAECHST der Wert weiter (altes Verhalten)',
    ausGalaxy.npcEmpireStrength > 2.0,
    { vorher: 2.0, nachher: rund(ausGalaxy.npcEmpireStrength, 4),
      hinweis: 'faellt er stattdessen Richtung 1,4, ist das Tor weg - und die NPC-Verteidigung bricht beim Merge um 44 % ein' });
  check('3b: und er faellt nicht Richtung Basis',
    ausGalaxy.npcEmpireStrength > BASIS + 0.5, { gemessen: rund(ausGalaxy.npcEmpireStrength, 4) });

  // ================================================================================================
  // 4) Der Zielwert reist zum Client - und nur, wenn es ihn gibt
  // ================================================================================================
  check('4a: ohne Tor fuehrt die Galaxie das Feld GAR NICHT',
    ausGalaxy.npcStaerkeZiel === undefined,
    { gemessen: ausGalaxy.npcStaerkeZiel,
      hinweis: 'ein gefuehrtes Feld ohne wirkende Drift waere eine Weltlage-Anzeige, die nichts anzeigt' });

  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  {
    const d = liesDb();
    d.galaxy.alienNester = [nestObj('kryll', 'vega', 3), nestObj('xantheer', 'rigel', 2)];
    einfrieren(d.galaxy);
    schreibDb(d);
  }
  s = await starteServer(AN); tok = await s.anmelden('anna'); await warte(500);
  const antwort = await s.j('/galaxy', { headers: { Authorization: 'Bearer ' + tok } });
  check('4b: mit Tor traegt die Galaxie-Antwort den Zielwert',
    antwort.status === 200 && typeof antwort.body.npcStaerkeZiel === 'number',
    { status: antwort.status, npcStaerkeZiel: antwort.body && antwort.body.npcStaerkeZiel });
  await stoppeServer();

  // ================================================================================================
  // 5) Der Deckel bindet in beide Richtungen
  // ================================================================================================
  {
    const g = liesDb().galaxy;
    check('5a: der Ist-Wert bleibt im Band [1 ; 2,5]',
      g.npcEmpireStrength >= 1 && g.npcEmpireStrength <= DECKEL, { gemessen: rund(g.npcEmpireStrength, 4) });
    check('5b: der Zielwert ueberschreitet den Deckel nie',
      g.npcStaerkeZiel <= DECKEL, { gemessen: g.npcStaerkeZiel });
  }

  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})();
