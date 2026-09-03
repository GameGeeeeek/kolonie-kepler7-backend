// Der Verbuendete am Vorposten (Etappe V5, 03.09.2026) - gegen einen ECHT gestarteten Server.
//
// Auftrag Sascha: alle Punkte der Vorposten-Auswahl umsetzen. Bis hierher stand an JEDER
// Vorposten-Route `doc.besitzer !== req.userId` -> 403: Ein Allianzpartner konnte nichts. Kein
// Beisteuern, keine Nutzung, kein Mitbauen - reines Einzeleigentum in einem Allianzspiel.
//
// DIE MECHANIK IST EINE DATENFRAGE: `doc.garnisonVon` schluesselt auf, WER was gestellt hat, und
// `doc.garnison` wird daraus nachgezogen. Alles, was hier geprueft wird, haengt daran, dass die
// beiden nie auseinanderlaufen - deshalb misst der Test beide Seiten (Abschnitt 2b und 7a).
//
// DIE RECHTEPRUEFUNG LIEST DEN GETEILTEN SPEICHER, nicht `save.player.allianceTag`: Der Spielstand
// ist klientenautoritativ, und eine Rechtepruefung, die ihn glaubt, ist keine (Abschnitt 2e).
//
// Gegenprobe: siehe Fuss der Datei.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3258;
const QUELLE = path.join(WURZEL, 'server_vpallianz_tmp.js');
const SAB = process.env.KEPLER_VPALLIANZ_SABOTAGE || '';
// Was bei welcher Sabotage fallen MUSS - gemessen, siehe Fuss.
/* GEMESSEN am 03.09.2026 - alle vier Listen waren im ersten Entwurf falsch. `spielstand` reisst
   3b mit, und das ist keine Ungenauigkeit, sondern die Folge: Carl darf dann stationieren, seine
   zehn Schiffe stehen in der Garnison, und die Zahl, die 3b prueft, stimmt nicht mehr. */
const MUSS_FALLEN = { schalter: ['1a'], rueckruf: ['3a', '3b'], spielstand: ['2e', '3b'], nachziehen: ['2b', '2c'] };

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
const ANNA = crypto.randomUUID();   // Besitzerin, Allianz KEP
const BEN = crypto.randomUUID();    // Verbuendeter, Allianz KEP
const CARL = crypto.randomUUID();   // Fremder, keine Allianz
const TAG = 'KEP';
const dbPfad = path.join(os.tmpdir(), 'kepler-vpallianz-' + process.pid + '.json');
const FLOTTE = { cruisers: 500, destroyers: 300, jaeger: 900, schlachtschiff: 120 };
let srv = null;

const save = (id, name, tag) => ({ resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
  buildings: {}, research: {}, colonies: {}, fleet: Object.assign({ missions: [] }, FLOTTE),
  player: { id, name, allianceTag: tag }, credits: 9000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now() });
function grunddb(rollen) {
  const shared = {};
  for (const [uid, rolle] of Object.entries(rollen || {})) shared['alliance:' + TAG + ':role:' + uid] = JSON.stringify({ role: rolle });
  return {
    users: {
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: Date.now() },
      carl: { userId: CARL, username: 'carl', passwordHash: hash, createdAt: Date.now() }
    },
    private: {
      /* CARL traegt den Allianz-Tag in seinem SPIELSTAND, hat aber KEINE Rolle im geteilten
         Speicher. Genau das ist die Falle, die 2e misst: Wer dem Spielstand glaubt, laesst ihn
         durch - er ist klientenautoritativ, jeder kann sich dort jeden Tag eintragen. */
      [ANNA]: { 'kepler7-save-v3': JSON.stringify(save(ANNA, 'anna', TAG)) },
      [BEN]:  { 'kepler7-save-v3': JSON.stringify(save(BEN, 'ben', TAG)) },
      [CARL]: { 'kepler7-save-v3': JSON.stringify(save(CARL, 'carl', TAG)) }
    },
    shared, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {}, wrackKonvois: [], a2Verlauf: [] }
  };
}
const vpDoc = (sys, extra) => Object.assign({ id: 'vp_' + crypto.randomUUID(), sys,
  besitzer: ANNA, besitzerName: 'anna', seit: Date.now() - 30 * 3600 * 1000,
  stufe: 6, zweig: 'festung', kern: { lp: 2000000, lpMax: 2000000 }, garnison: {}, schlaege: {},
  beitraege: {}, ausbauSeit: Date.now() - 13 * 3600 * 1000, kampfverlauf: [] }, extra || {});

function ende() {
  try { if (srv) srv.kill(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.unlinkSync(QUELLE); } catch (e) {}
}
process.on('exit', ende);

async function starteServer() {
  srv = spawn(process.execPath, [QUELLE], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, { DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const basis = 'http://127.0.0.1:' + PORT + '/api';
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(basis + '/health'); if (r.ok) break; } catch (e) {}
    await warte(250);
  }
  const j = async (pfad, opt) => {
    const r = await fetch(basis + pfad, opt);
    const t = await r.text();
    try { return { status: r.status, body: JSON.parse(t) }; } catch (e) { return { status: r.status, body: t.slice(0, 300) }; }
  };
  const anmelden = async (name) => {
    const r = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name, password: 'test1234' }) });
    return r.body && r.body.token;
  };
  const hole = (pfad, tok) => j(pfad, { headers: { Authorization: 'Bearer ' + tok } });
  const sende = (pfad, tok, body) => j(pfad, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(body) });
  return { j, anmelden, hole, sende };
}
async function stoppeServer() { if (!srv) return; srv.kill('SIGTERM'); await warte(700); srv = null; }
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const liesDoc = (sys) => JSON.parse(liesDb().shared['vorposten:' + sys]);
const belohnungen = (uid) => ((liesDb().private[uid] || {}).__pendingRewards) || [];
const summe = (o) => Object.values(o || {}).reduce((a, n) => a + (Number(n) || 0), 0);

(async () => {
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  let basis = roh.replace(/const VORPOSTEN_AKTIV = (true|false);/, 'const VORPOSTEN_AKTIV = true;')
    .replace(/const VORPOSTEN_ABBAU_AKTIV = (true|false);/, 'const VORPOSTEN_ABBAU_AKTIV = true;')
    .replace(/const GALAXY_TICK_MS = [^;]+;/, 'const GALAXY_TICK_MS = 1500;');
  /* Die gefaehrliche Fassung ist nicht der falsche BERICHT, sondern der falsche ZUSTAND: ein
     Rueckruf, der die ganze Garnison einzieht - also auch die Schiffe der Verbuendeten. */
  if (SAB === 'rueckruf') basis = basis
    .replace('const garnison = Object.assign({}, von[req.userId] || {});', 'const garnison = Object.assign({}, doc.garnison || {});')
    .replace('  delete von[req.userId];', '  doc.garnisonVon = {};');
  if (SAB === 'spielstand') basis = basis.replace('const meiner = allianceTagOf(userId);', 'const meiner = (astLeseSave(userId) || {}).player && astLeseSave(userId).player.allianceTag;');
  /* `nachziehen` muss BEIDE Stellen treffen: vorpostenSchreib zieht die Gesamtzahl als
     Sicherheitsnetz nach, das Stationieren tut es zusaetzlich selbst. Der erste Entwurf entfernte
     nur das Netz - und nichts fiel, weil der gemessene Weg die andere Stelle benutzt. */
  if (SAB === 'nachziehen') basis = basis.replace('  if (doc) vorpostenGarnisonNachziehen(doc);\n', '')
    .replace('  vorpostenGarnisonNachziehen(doc);\n  if (!Object.keys(angenommen).length)', '  if (!Object.keys(angenommen).length)');
  /* `schalter` bricht die GATTERUNG in vorpostenVerbuendet - den Schalter selbst zu setzen brachte
     nichts, weil Abschnitt 1 ihn ohnehin ausdruecklich auf false schreibt. */
  if (SAB === 'schalter') basis = basis.replace('  if (!VP_ALLIANZ_AKTIV) return false;\n', '');
  const an = basis.replace(/const VP_ALLIANZ_AKTIV = (true|false);/, 'const VP_ALLIANZ_AKTIV = true;');
  check('0a: der Allianz-Schalter liess sich in der Kopie umlegen', /const VP_ALLIANZ_AKTIV = true;/.test(an),
    { gefunden: /const VP_ALLIANZ_AKTIV = (true|false);/.test(roh) });

  // ---- 1) Mit AUSGESCHALTETEM Schalter darf der Verbuendete nichts ------------------------------
  /* Geprueft wird die WIRKUNG des Schalters, nicht seine ausgelieferte Stellung: Ein Test, der die
     Auslieferung als Voraussetzung nimmt, faellt bei genau der Aenderung, die er begleiten soll. */
  fs.writeFileSync(QUELLE, basis.replace(/const VP_ALLIANZ_AKTIV = (true|false);/, 'const VP_ALLIANZ_AKTIV = false;'));
  const dbAus = grunddb({ [ANNA]: 'admin', [BEN]: 'member' });
  dbAus.shared['vorposten:aus'] = JSON.stringify(vpDoc('aus'));
  fs.writeFileSync(dbPfad, JSON.stringify(dbAus, null, 1));
  let s = await starteServer();
  let tokB = await s.anmelden('ben');
  const ausVersuch = await s.sende('/vorposten/stationieren', tokB, { system: 'aus', planetKey: 'home', composition: { cruisers: 10 } });
  check('1a: ausgeschaltet weist der Server den Verbuendeten ab - wie vor dieser Etappe',
    ausVersuch.status === 403, { status: ausVersuch.status, fehler: ausVersuch.body && ausVersuch.body.error });
  await stoppeServer();

  // ---- 2) Mit umgelegtem Schalter --------------------------------------------------------------
  fs.writeFileSync(QUELLE, an);
  const db = grunddb({ [ANNA]: 'admin', [BEN]: 'member' });
  db.shared['vorposten:kep'] = JSON.stringify(vpDoc('kep', { garnison: { jaeger: 40 } }));
  fs.writeFileSync(dbPfad, JSON.stringify(db, null, 1));
  s = await starteServer();
  const tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  const tokC = await s.anmelden('carl');

  const vorher = liesDoc('kep');
  const dazu = await s.sende('/vorposten/stationieren', tokB, { system: 'kep', planetKey: 'home', composition: { cruisers: 25 } });
  check('2a: der Verbuendete darf Garnison beisteuern', dazu.status === 200 && (dazu.body.angenommen || {}).cruisers === 25,
    { status: dazu.status, angenommen: dazu.body.angenommen, fehler: dazu.body && dazu.body.error });
  const nachDazu = liesDoc('kep');
  check('2b: die Gesamtzahl und die Aufschluesselung stimmen ueberein - keine zwei Wahrheiten', (() => {
    const vonSumme = Object.values(nachDazu.garnisonVon || {}).reduce((a, t) => a + summe(t), 0);
    return summe(nachDazu.garnison) === vonSumme
      && (nachDazu.garnisonVon[BEN] || {}).cruisers === 25
      && (nachDazu.garnisonVon[ANNA] || {}).jaeger === 40;
  })(), { garnison: nachDazu.garnison, garnisonVon: nachDazu.garnisonVon });
  check('2c: die alte Garnison ist dem BESITZER zugeordnet worden (Migration), nicht verlorengegangen',
    summe(nachDazu.garnison) === summe(vorher.garnison) + 25,
    { vorher: summe(vorher.garnison), nachher: summe(nachDazu.garnison) });
  const sichtB = ((await s.hole('/vorposten', tokB)).body.liste || []).find(v => v.sys === 'kep');
  const sichtA = ((await s.hole('/vorposten', tokA)).body.liste || []).find(v => v.sys === 'kep');
  check('2d: der Client erfaehrt, wer verbuendet ist - und was IHM dort gehoert',
    sichtB.verbuendet === true && sichtB.eigener === false && (sichtB.meineGarnison || {}).cruisers === 25
    && sichtA.eigener === true && sichtA.verbuendet === false,
    { ben: { verbuendet: sichtB.verbuendet, meine: sichtB.meineGarnison }, anna: { eigener: sichtA.eigener, verbuendet: sichtA.verbuendet } });
  const fremd = await s.sende('/vorposten/stationieren', tokC, { system: 'kep', planetKey: 'home', composition: { cruisers: 10 } });
  check('2e: Carl traegt den Tag in seinem SPIELSTAND, hat aber keine Rolle im geteilten Speicher - abgewiesen',
    fremd.status === 403, { status: fremd.status, fehler: fremd.body && fremd.body.error });

  // ---- 3) Zurueckrufen: jeder nur seins ---------------------------------------------------------
  const holtB = await s.sende('/vorposten/rueckruf', tokB, { system: 'kep' });
  const nachRueckruf = liesDoc('kep');
  check('3a: der Verbuendete holt NUR seine eigenen Schiffe zurueck',
    holtB.status === 200 && summe(holtB.body.garnison || holtB.body.zurueck || {}) === 25
    && (nachRueckruf.garnisonVon[ANNA] || {}).jaeger === 40 && !nachRueckruf.garnisonVon[BEN],
    { antwort: holtB.body, verbleibend: nachRueckruf.garnisonVon });
  check('3b: und die Schiffe der Besitzerin stehen unveraendert da - niemand zieht fremde Schiffe ein',
    summe(nachRueckruf.garnison) === 40, { garnison: nachRueckruf.garnison });

  // ---- 4) Verluste treffen beide ---------------------------------------------------------------
  await stoppeServer();
  const db4 = liesDb();
  const d4 = JSON.parse(db4.shared['vorposten:kep']);
  d4.garnisonVon = { [ANNA]: { jaeger: 100 }, [BEN]: { cruisers: 100 } };
  d4.garnison = { jaeger: 100, cruisers: 100 };
  d4.kern = { lp: 60, lpMax: 2000000 };
  db4.shared['vorposten:kep'] = JSON.stringify(d4);
  const svC = JSON.parse(db4.private[CARL]['kepler7-save-v3']);
  svC.fleet.missions = [{ id: 'm-a', type: 'vorposten-angriff', targetId: 'kep', system: 'kep',
    startTime: Date.now() - 7200000, endTime: Date.now() - 3600000, fleetName: 'Flotte', composition: Object.assign({}, FLOTTE) }];
  svC.__attackShieldUntil = 0;
  db4.private[CARL]['kepler7-save-v3'] = JSON.stringify(svC);
  fs.writeFileSync(dbPfad, JSON.stringify(db4, null, 1));
  s = await starteServer();
  const tokC2 = await s.anmelden('carl');
  const schlag = await s.sende('/vorposten/angriff', tokC2, { system: 'kep', missionId: 'm-a' });
  check('4-vorab: der Schlag ist durchgegangen und hat den Vorposten geschleift',
    schlag.status === 200 && schlag.body.gefallen === true,
    { status: schlag.status, gefallen: schlag.body && schlag.body.gefallen, fehler: schlag.body && schlag.body.error });
  const verlustA = belohnungen(ANNA).find(r => r && r.type === 'vorposten-verlust');
  const verlustB = belohnungen(BEN).find(r => r && r.type === 'vorposten-verlust');
  check('5a: beim Fall erfaehrt auch der Verbuendete, dass SEINE Schiffe weg sind', (() => {
    return !!verlustB && verlustB.alsVerbuendeter === true && summe(verlustB.garnisonVerloren) > 0
      && !!verlustA && verlustA.alsVerbuendeter === false;
  })(), { ben: verlustB && { alsVerbuendeter: verlustB.alsVerbuendeter, verloren: verlustB.garnisonVerloren },
          anna: verlustA && { alsVerbuendeter: verlustA.alsVerbuendeter, verloren: verlustA.garnisonVerloren } });
  check('5b: und jeder sieht NUR seine eigenen Schiffe in der Meldung, nicht die des anderen',
    !!verlustA && !!verlustB && !verlustA.garnisonVerloren.cruisers && !verlustB.garnisonVerloren.jaeger,
    { anna: verlustA && verlustA.garnisonVerloren, ben: verlustB && verlustB.garnisonVerloren });

  // ---- 6) Der Abbau gibt jedem seins zurueck ---------------------------------------------------
  await stoppeServer();
  const db6 = liesDb();
  db6.shared['vorposten:abb'] = JSON.stringify(vpDoc('abb', {
    garnisonVon: { [ANNA]: { jaeger: 30 }, [BEN]: { cruisers: 12 } }, garnison: { jaeger: 30, cruisers: 12 },
    abbauAb: Date.now() - 1000 }));
  db6.private[ANNA].__pendingRewards = []; db6.private[BEN].__pendingRewards = [];
  fs.writeFileSync(dbPfad, JSON.stringify(db6, null, 1));
  s = await starteServer();
  await warte(4000);   // der verkuerzte galaxyTick raeumt den Abbau ab
  const abbA = belohnungen(ANNA).find(r => r && r.type === 'vorposten-abbau');
  const abbB = belohnungen(BEN).find(r => r && r.type === 'vorposten-abbau');
  check('6a: beim Abbau bekommt JEDER Beitragende seine eigenen Schiffe zurueck', (() => {
    return !!abbA && !!abbB && (abbA.garnison || {}).jaeger === 30 && !(abbA.garnison || {}).cruisers
      && (abbB.garnison || {}).cruisers === 12 && !(abbB.garnison || {}).jaeger
      && abbB.alsVerbuendeter === true && abbA.alsVerbuendeter === false;
  })(), { anna: abbA && abbA.garnison, ben: abbB && abbB.garnison });
  await stoppeServer();

  // ---- 7) Die Migration eines alten Dokuments --------------------------------------------------
  const db7 = liesDb();
  db7.shared['vorposten:alt'] = JSON.stringify(vpDoc('alt', { garnison: { jaeger: 77 } }));   // KEIN garnisonVon
  fs.writeFileSync(dbPfad, JSON.stringify(db7, null, 1));
  s = await starteServer();
  const tokA7 = await s.anmelden('anna');
  const sicht7 = ((await s.hole('/vorposten', tokA7)).body.liste || []).find(v => v.sys === 'alt');
  check('7a: ein Dokument aus der Zeit vor dieser Etappe schreibt seine Garnison der Besitzerin zu',
    summe(sicht7.meineGarnison) === 77 && sicht7.garnisonAnzahl === 77,
    { meine: sicht7.meineGarnison, gesamt: sicht7.garnisonAnzahl });
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
})().catch(e => { console.log('FAIL - Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
