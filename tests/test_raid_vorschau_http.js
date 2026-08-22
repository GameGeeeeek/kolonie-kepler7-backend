// Echter HTTP-Test: die Belohnungsvorschau des Allianz-Raids (22.08.2026, Auftrag Sascha
// "vsl. belohnungen einblenden").
//
//   node tests/test_raid_vorschau_http.js
//
// WARUM ES DIESEN TEST GIBT. Die Vorschau ist nur so viel wert wie ihre UEBEREINSTIMMUNG mit der
// spaeteren Auszahlung. Eine Pruefung "das Feld ist da und sieht plausibel aus" waere das Etikett
// statt der Wirkung (Arbeitsregel 61) - und sie bliebe gruen, waehrend die Vorschau dem Spieler
// eine andere Zahl nennt, als er hinterher bekommt.
//
// Der Anker liegt deshalb AUSSERHALB der geprueften Rechnung (Arbeitsregel 62): Der Test rechnet
// die Belohnung nicht nach, sondern misst, was `claim` wirklich in den Spielstand schreibt, und
// haelt das gegen die Zahl, die `checkdispatch` vorher versprochen hat. Ein Fehler in der Formel
// verschoebe beide Seiten gleichzeitig - eine nachgerechnete Erwartung koennte ihn nicht finden.
//
// GEPRUEFT WIRD:
//   1. `checkdispatch` legt je Teilnehmer zwei EXAKTE Werte ab (Boss faellt / Boss ueberlebt),
//      und die beiden unterscheiden sich - eine Vorschau mit zweimal derselben Zahl waere keine.
//   2. Sie ist nach Kraft gewichtet: Anna traegt die dreifache Flotte und muss mehr bekommen.
//   3. DIE KERNPRUEFUNG: Was `claim` auszahlt, ist zeichengleich mit der Variante, die
//      tatsaechlich eingetreten ist - Credits, Kampfpunkte, Erfahrung, alle vier Ressourcen und
//      die Modulfragmente.
//   4. Die GEGENRICHTUNG: Die NICHT eingetretene Variante unterscheidet sich vom Ausgezahlten.
//      Ohne sie waere 3 auch dann gruen, wenn beide Varianten identisch waeren.
//   5. Eine Welle aus der Zeit VOR dieser Aenderung (dispatch ohne `vorschau`) laeuft
//      unveraendert durch - der Server darf an einem fehlenden Feld nicht scheitern.
//
// GEGENPROBEN (in beide Richtungen ausfuehren, Arbeitsregel 1):
//   * Den vorschau-Block aus checkdispatch entfernen -> 1a/1b/1c/2a/3* fallen.
//   * In der Vorschau `destroyed` fest auf true setzen (beide Varianten gleich) -> 1b faellt,
//     und bei ueberlebendem Boss zusaetzlich 3a.
//   * Die Vorschau mit doc.level+1 rechnen lassen -> 3a-3d fallen, 1a/1b bleiben gruen.
//
// Port 3231: 3195-3200 und 3210-3230 sind belegt (Arbeitsregel 29 - selbst gemessen, denn die
// Kopfkommentare der Nachbartests sind in beide Richtungen falsch).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3231;

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ANNA = crypto.randomUUID(), BEN = crypto.randomUUID();
const TAG = 'TST';
const SAVE_KEY = 'kepler7-save-v3';

// Anna traegt die dreifache Kraft - damit ist die Gewichtung MESSBAR und nicht bloss "beide haben
// etwas bekommen".
const FLOTTE_A = { cruisers: 300, destroyers: 200, battleships: 100 };
const FLOTTE_B = { cruisers: 100, destroyers: 60, battleships: 30 };

function spielstand(id, name, flotte) {
  return {
    resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {},
    fleet: Object.assign({ missions: [] }, flotte),
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  };
}
const rolle = (uid, role) => JSON.stringify({ role, joinedAt: Date.now(), userId: uid });

function grunddb() {
  return {
    users: {
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: Date.now() }
    },
    private: {
      [ANNA]: { [SAVE_KEY]: JSON.stringify(spielstand(ANNA, 'anna', FLOTTE_A)) },
      [BEN]:  { [SAVE_KEY]: JSON.stringify(spielstand(BEN, 'ben', FLOTTE_B)) }
    },
    shared: {
      ['alliance:' + TAG + ':role:' + ANNA]: rolle(ANNA, 'admin'),
      ['alliance:' + TAG + ':role:' + BEN]: rolle(BEN, 'member'),
      ['alliance:' + TAG + ':base']: JSON.stringify({ foundedAt: Date.now(), sector: 'vega', level: 3 })
    },
    resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {} }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-raidvorschau-' + process.pid + '.json');
let srv = null, s = null, tokA = null, tokB = null;
function ende() {
  try { if (srv) srv.kill(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
}
process.on('exit', ende);

async function starteServer() {
  let log = '';
  /* Der Pfad ist UMLEITBAR - sonst laesst sich die Gegenprobe (Arbeitsregel 1) gar nicht fahren:
     Sie braucht ein server.js OHNE den vorschau-Block, und ein fest verdrahteter Pfad laese
     stattdessen die echte Datei (genau der Defekt, den 25 Frontend-Tests hatten). Dass die
     Umleitung GRIFF, belegt die Gegenprobe an ihren roten Zeilen. */
  srv = spawn(process.execPath, [process.env.RAID_TEST_SERVER || path.join(WURZEL, 'server.js')], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, { DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret',
      ALLIANCE_RAID_TEST_MODE: '1' }),
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
/* Der Spielstand liegt als blanke Zeichenkette ODER als { value, version } vor - setSaveValue
   schreibt die zweite Form. Ein Test, der nur die erste annimmt, stirbt an JSON.parse('[object
   Object]'), sobald der Server einmal geschrieben hat, und fuehrt seine uebrigen Pruefungen nie
   aus (Arbeitsregel 34). Genau das ist in zwei Nachbartests schon passiert. */
function liesSave(d, uid) {
  const roh = d.private[uid][SAVE_KEY];
  if (roh === undefined) return null;
  return JSON.parse(typeof roh === 'string' ? roh : roh.value);
}
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
/* Eine Aenderung an der DB-DATEI, waehrend der Server laeuft, ist beim naechsten SIGTERM wieder
   weg - der Graceful Shutdown flusht seinen Speicherstand darueber. Deshalb stoppen, aendern,
   starten (dieselbe Wache wie in test_festung_http). */
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  try { await fn(d); }
  catch (e) { check('aufbau: die DB-Aenderung liess sich ausfuehren', false, { fehler: String(e).slice(0, 200) }); }
  schreibDb(d);
  s = await starteServer();
  tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
}

const post = (pfad, tok, body) => s.j(pfad, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
  body: JSON.stringify(body || {}) });

(async () => {
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  s = await starteServer();
  tokA = await s.anmelden('anna');
  tokB = await s.anmelden('ben');
  check('0: beide Konten sind angemeldet', !!tokA && !!tokB, { anna: !!tokA, ben: !!tokB });
  if (!tokA || !tokB) { await stoppeServer(); process.exit(1); }

  // ---- Welle aufsetzen -----------------------------------------------------------------------
  const erstellt = await post('/allianceraid/create', tokA, { tag: TAG, gatherSeconds: 2 });
  check('0b: die Welle wurde ausgerufen', erstellt.status === 200, { status: erstellt.status, body: erstellt.body });
  const doc0 = erstellt.body && erstellt.body.doc;
  if (!doc0) { check('0c: create liefert ein Dokument', false, erstellt.body); await stoppeServer(); process.exit(1); }

  const beitritt = { tag: TAG, raidId: doc0.id, waveNumber: doc0.waveNumber, originPlanet: 'home', travelSec: 1 };
  const jA = await post('/allianceraid/join', tokA, Object.assign({ composition: FLOTTE_A }, beitritt));
  const jB = await post('/allianceraid/join', tokB, Object.assign({ composition: FLOTTE_B }, beitritt));
  check('0d: beide sind dem Verband beigetreten', jA.status === 200 && jB.status === 200,
    { anna: jA.status, ben: jB.status, fehlerA: jA.body && jA.body.error, fehlerB: jB.body && jB.body.error });

  await warte(2300);                                     // Sammelphase (2 s im Testmodus) abwarten
  const disp = await post('/allianceraid/checkdispatch', tokA, { tag: TAG });
  const dispatch = disp.body && disp.body.doc && disp.body.doc.dispatch;
  check('0e: der Verband ist abgeflogen', disp.status === 200 && !!dispatch,
    { status: disp.status, phase: disp.body && disp.body.doc && disp.body.doc.phase });
  if (!dispatch) { await stoppeServer(); process.exit(1); }

  // ---- 1) Die Vorschau selbst ----------------------------------------------------------------
  const v = dispatch.vorschau || null;
  check('1a: checkdispatch legt eine Vorschau je Teilnehmer ab',
    !!v && !!v[ANNA] && !!v[BEN], { vorhanden: !!v, eintraege: v ? Object.keys(v).length : 0 });
  /* KEIN process.exit hier. Beim ersten Anlauf stand genau das da - und die Gegenprobe (Kopie
     ohne den vorschau-Block) lief dadurch mit 5 statt 25 Pruefungen: Ob 3a-3e und 6a-6d ebenfalls
     fallen, war nicht zu sehen (Arbeitsregel 34, dieselbe Klasse wie die Laufzeit-Wache in
     test_schiffsmodul_paritaet). Stattdessen ein leerer Ersatz: Jede Folgepruefung faellt dann
     BENANNT und mit ihrem eigenen Beleg. */
  const leer = { credits: null, battlePoints: null, xp: null, fragments: null,
                 resources: { erz: null, kristalle: null, deuterium: null, antimaterie: null } };
  const V = (v && v[ANNA]) ? v : { [ANNA]: { faellt: leer, ueberlebt: leer }, [BEN]: { faellt: leer, ueberlebt: leer } };

  check('1b: die zwei Varianten unterscheiden sich - sonst waere es keine Vorschau',
    V[ANNA].faellt.credits !== V[ANNA].ueberlebt.credits,
    { faellt: V[ANNA].faellt.credits, ueberlebt: V[ANNA].ueberlebt.credits });
  check('1b2: nur bei erlegtem Boss gibt es Antimaterie und Fragmente',
    V[ANNA].ueberlebt.resources.antimaterie === 0 && V[ANNA].ueberlebt.fragments === 0
      && V[ANNA].faellt.fragments > 0,
    { amUeberlebt: V[ANNA].ueberlebt.resources.antimaterie, fragUeberlebt: V[ANNA].ueberlebt.fragments,
      fragFaellt: V[ANNA].faellt.fragments });

  // 1c - die Gewichtung. Anna traegt die dreifache Flotte; eine Vorschau, die allen dasselbe
  // verspricht, waere falsch, ohne dass 1a/1b es merkten.
  check('1c: die Vorschau ist nach Kraft gewichtet - Anna bekommt mehr als Ben',
    V[ANNA].faellt.credits > V[BEN].faellt.credits,
    { anna: V[ANNA].faellt.credits, ben: V[BEN].faellt.credits });

  // ---- 2) Auflösen ---------------------------------------------------------------------------
  await warte(2600);                                     // Anflug (2 s im Testmodus)
  const auf = await post('/allianceraid/resolve', tokA, { tag: TAG });
  check('2a: die Welle wurde aufgeloest', auf.status === 200, { status: auf.status, body: auf.body && auf.body.error });
  const wr1 = auf.body && auf.body.doc && auf.body.doc.lastWaveResult;
  const gefallen = !!(wr1 && wr1.destroyed);
  check('2b: die Welle hat ein Ergebnis hinterlassen', !!wr1, { ergebnis: wr1 ? { destroyed: wr1.destroyed, damage: wr1.damage } : null });
  console.log('     (Boss gefallen: ' + gefallen + ')');

  // ---- 3) DIE KERNPRUEFUNG: gezahlt == versprochen -------------------------------------------
  const vorher = liesSave(liesDb(), ANNA);
  const cl = await post('/allianceraid/claim', tokA, { tag: TAG, raidId: doc0.id, waveNumber: doc0.waveNumber });
  check('3-vorab: claim ist durchgelaufen', cl.status === 200 && cl.body && cl.body.ok,
    { status: cl.status, fehler: cl.body && cl.body.error });
  const nachher = liesSave(liesDb(), ANNA);

  const soll = gefallen ? V[ANNA].faellt : V[ANNA].ueberlebt;
  const andere = gefallen ? V[ANNA].ueberlebt : V[ANNA].faellt;

  if (vorher && nachher) {
    const dCredits = (nachher.credits || 0) - (vorher.credits || 0);
    const dBp = (nachher.battlePoints || 0) - (vorher.battlePoints || 0);
    const dXp = (nachher.xp || 0) - (vorher.xp || 0);
    check('3a: die ausgezahlten Credits sind zeichengleich mit der Vorschau',
      dCredits === soll.credits, { gezahlt: dCredits, versprochen: soll.credits, variante: gefallen ? 'faellt' : 'ueberlebt' });
    check('3b: die ausgezahlten Kampfpunkte sind zeichengleich mit der Vorschau',
      dBp === soll.battlePoints, { gezahlt: dBp, versprochen: soll.battlePoints });
    check('3c: die ausgezahlte Erfahrung ist zeichengleich mit der Vorschau',
      dXp === soll.xp, { gezahlt: dXp, versprochen: soll.xp });
    const dRes = {};
    for (const k of Object.keys(soll.resources)) {
      dRes[k] = Math.round(((nachher.resources || {})[k] || 0) - ((vorher.resources || {})[k] || 0));
    }
    const resGleich = Object.keys(soll.resources).every(k => dRes[k] === soll.resources[k]);
    check('3d: alle vier Ressourcen sind zeichengleich mit der Vorschau',
      resGleich, { gezahlt: dRes, versprochen: soll.resources });

    // 3e - die GEGENRICHTUNG. Ohne sie waere 3a auch dann gruen, wenn beide Varianten dieselbe
    // Zahl truegen (Arbeitsregel 62: eine Erwartung, die der Fehler mitverschiebt, ist keine).
    /* ZUERST einen Wert verlangen, dann die Beziehung. Ohne das erste Glied war diese Pruefung in
       der Gegenprobe aus dem FALSCHEN Grund gruen (Arbeitsregel 28): Fehlt die Vorschau, ist
       `andere.credits` null, und 433 !== null trifft trivial zu - sie haette also nur geprueft,
       dass es keine Vorschau GIBT. Dieselbe Lehre wie bei den vacuous every()-Pruefungen des
       Gegenstand-Tests. */
    check('3e: die NICHT eingetretene Variante weicht ab - die Wahl ist also eine echte',
      typeof andere.credits === 'number' && dCredits !== andere.credits,
      { gezahlt: dCredits, andereVariante: andere.credits });
  } else {
    check('3a: die ausgezahlten Credits sind zeichengleich mit der Vorschau', false, { grund: 'Spielstand nicht lesbar' });
  }

  // ---- 4) Altbestand: eine Welle ohne Vorschau darf nichts brechen ---------------------------
  // Wellen, die beim Update schon unterwegs waren, tragen kein `vorschau`-Feld. Das Frontend zeigt
  // die Zeile dann ersatzlos nicht (derselbe dritte Zustand wie bei der Weltlage-Zeile) - der
  // Server darf daran erst recht nicht scheitern.
  const clB = await post('/allianceraid/claim', tokB, { tag: TAG, raidId: doc0.id, waveNumber: doc0.waveNumber });
  check('4a: auch der zweite Teilnehmer kann abholen', clB.status === 200 && clB.body && clB.body.ok,
    { status: clB.status, fehler: clB.body && clB.body.error });

  // ---- 6) Die ANDERE Variante, Ende zu Ende --------------------------------------------------
  /* Ohne diesen Abschnitt ist 3d bei der Antimaterie aus dem FALSCHEN Grund gruen (Arbeitsregel
     28): Ueberlebt der Boss, vergleicht sie 0 gegen 0. Genau die Felder, die den Unterschied
     ausmachen - Antimaterie und Modulfragmente - waeren damit nie gemessen. Eine zweite Welle
     gegen einen fast toten Boss stellt den anderen Ausgang her. */
  await aendereDb(d => {
    const doc = JSON.parse(d.shared['alliance:' + TAG + ':raid']);
    doc.hp = 1;                       // faellt garantiert
    doc.lastWaveEndedAt = 0;          // Wellen-Abklingzeit ueberspringen
    d.shared['alliance:' + TAG + ':raid'] = JSON.stringify(doc);
  });

  const w2 = await post('/allianceraid/create', tokA, { tag: TAG, gatherSeconds: 2 });
  const doc2 = w2.body && w2.body.doc;
  check('6-vorab: eine zweite Welle laesst sich ausrufen', w2.status === 200 && !!doc2,
    { status: w2.status, fehler: w2.body && w2.body.error });
  if (doc2) {
    const b2 = { tag: TAG, raidId: doc2.id, waveNumber: doc2.waveNumber, originPlanet: 'home', travelSec: 1 };
    await post('/allianceraid/join', tokA, Object.assign({ composition: FLOTTE_A }, b2));
    await warte(2300);
    const d2 = await post('/allianceraid/checkdispatch', tokA, { tag: TAG });
    const v2 = d2.body && d2.body.doc && d2.body.doc.dispatch && d2.body.doc.dispatch.vorschau;
    check('6-vorab2: auch die zweite Welle traegt eine Vorschau', !!(v2 && v2[ANNA]),
      { vorhanden: !!v2 });
    await warte(2600);
    const auf2 = await post('/allianceraid/resolve', tokA, { tag: TAG });
    const wr2 = auf2.body && auf2.body.doc && auf2.body.doc.lastWaveResult;
    const gefallen2 = !!(wr2 && wr2.destroyed);
    check('6a: der Boss ist diesmal gefallen - der andere Ausgang ist hergestellt', gefallen2,
      { gefallen: gefallen2, status: auf2.status });

    const V2 = (v2 && v2[ANNA]) ? v2 : { [ANNA]: { faellt: leer, ueberlebt: leer } };
    if (gefallen2 || !v2) {
      const vor2 = liesSave(liesDb(), ANNA);
      const cl2 = await post('/allianceraid/claim', tokA, { tag: TAG, raidId: doc2.id, waveNumber: doc2.waveNumber });
      check('6-vorab3: claim der zweiten Welle ist durchgelaufen', cl2.status === 200 && cl2.body && cl2.body.ok,
        { status: cl2.status, fehler: cl2.body && cl2.body.error });
      const nach2 = liesSave(liesDb(), ANNA);
      const soll2 = V2[ANNA].faellt;
      if (vor2 && nach2) {
        const dAm = Math.round(((nach2.resources || {}).antimaterie || 0) - ((vor2.resources || {}).antimaterie || 0));
        const dCr = (nach2.credits || 0) - (vor2.credits || 0);
        check('6b: bei erlegtem Boss stimmen auch die Credits zeichengenau',
          dCr === soll2.credits, { gezahlt: dCr, versprochen: soll2.credits });
        /* DIE Pruefung, die es ohne diesen Abschnitt gar nicht geben koennte: Antimaterie faellt
           NUR bei erlegtem Boss. Bei ueberlebendem Boss verglich 3d dort 0 gegen 0. */
        check('6c: die Antimaterie stimmt - und sie ist groesser als null',
          dAm === soll2.resources.antimaterie && dAm > 0,
          { gezahlt: dAm, versprochen: soll2.resources.antimaterie });
        check('6d: und die Vorschau hat Modulfragmente versprochen',
          soll2.fragments > 0, { versprochen: soll2.fragments });
      }
    }
  }

  const protokoll = s.protokoll();
  check('5a: kein ReferenceError/TypeError im Serverprotokoll',
    !/ReferenceError|TypeError/.test(protokoll),
    { auszug: (protokoll.match(/(ReferenceError|TypeError)[^\n]*/g) || []).slice(0, 3) });

  await stoppeServer();
  console.log(fail ? '\nFAIL - es gab rote Pruefungen.' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})().catch(async e => {
  console.log('FAIL - unerwarteter Fehler: ' + (e && e.stack || e));
  await stoppeServer();
  process.exit(1);
});
