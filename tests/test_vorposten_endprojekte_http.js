// Die Endprojekte und die Dominanz (Etappe V6, 03.09.2026) - gegen einen ECHT gestarteten Server.
//
// Ab Stufe 7 gab es nichts mehr zu entscheiden: Die drei Zweige unterschieden sich in
// Multiplikatoren und je einem Projekt der Stufe 5. Jetzt hat jeder Zweig auf der ENDSTUFE etwas,
// das nur er kann - und jedes ist eine andere ART von Wirkung, nicht ein weiterer Prozentpunkt:
//   Sternendock     (Werft)   PRODUZIERT   - ein Kreuzer je 24 Stunden, hoechstens sieben.
//   Sternenmarkt    (Handel)  ERWEITERT    - zwei Angebotsplaetze UEBER dem Deckel.
//   Sperrfeuerstand (Festung) KOSTET       - jeder Angriff kostet den Angreifer mehr Schiffe.
//
// Gegenprobe: siehe Fuss der Datei.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3259;
const QUELLE = path.join(WURZEL, 'server_vpend_tmp.js');
const SAB = process.env.KEPLER_VPEND_SABOTAGE || '';
/* GEMESSEN am 04.09.2026. `dockdeckel` reisst 4c mit, und das ist die Folge, nicht ein Nebenschaden:
   Ohne Deckel liefert das Abholen 40 statt 7 Schiffe, und 4c prueft genau diese Zahl. */
const MUSS_FALLEN = { schalter: ['1a'], sperrfeuer: ['2a'], plaetze: ['3a'], dockdeckel: ['4b', '4c'], dockseit: ['4d'],
  /* GEMESSEN, nicht geschaetzt: `endstart` reisst 1a3 MIT, und das ist die Folge, nicht ein
     Nebenschaden. Ohne die Sperre geht `sternendock` in 1a2 durch und belegt den EINZIGEN
     Projektplatz - das gewoehnliche Projekt in 1a3 wird danach mit „laeuft bereits" abgelehnt.
     Genau der Schaden, den der Befund beschreibt, hier als Kette sichtbar. Die erste Fassung
     dieser Liste nannte nur 1a2 und 1a4 und fiel deshalb selbst durch. */
  endstart: ['1a2', '1a3', '1a4'] };

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
const ANNA = crypto.randomUUID();   // haelt alle drei Endstufen
const BEN = crypto.randomUUID();    // Angreifer
const dbPfad = path.join(os.tmpdir(), 'kepler-vpend-' + process.pid + '.json');
const FLOTTE = { cruisers: 4000, destroyers: 3000, jaeger: 6000, schlachtschiff: 900 };
const MODUL = 'kernpanzer:episch';
let srv = null;

const save = (id, name) => ({ resources: { energie: 9e6, erz: 9e6, kristalle: 9e6, deuterium: 9e6, antimaterie: 9e5, forschungspunkte: 9e5 },
  buildings: {}, research: {}, colonies: {}, fleet: Object.assign({ missions: [] }, FLOTTE), modules: { [MODUL]: 9 }, shipModules: {},
  player: { id, name }, credits: 9e5, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now() });
function grunddb() {
  return {
    users: {
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: Date.now() }
    },
    private: {
      [ANNA]: { 'kepler7-save-v3': JSON.stringify(save(ANNA, 'anna')) },
      [BEN]:  { 'kepler7-save-v3': JSON.stringify(save(BEN, 'ben')) }
    },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {}, wrackKonvois: [], a2Verlauf: [] }
  };
}
const vpDoc = (sys, stufe, zweig, extra) => Object.assign({ id: 'vp_' + crypto.randomUUID(), sys,
  besitzer: ANNA, besitzerName: 'anna', seit: Date.now() - 60 * 24 * 3600 * 1000,
  stufe, zweig, kern: { lp: 6000000, lpMax: 6000000 }, garnison: {}, schlaege: {}, beitraege: {},
  ausbauSeit: Date.now() - 13 * 3600 * 1000, kampfverlauf: [] }, extra || {});
const fertig = (key, vorStunden) => ({ key, fertigAb: Date.now() - vorStunden * 3600 * 1000 });

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

(async () => {
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  // ANKER aus dem QUELLTEXT, nicht aus der Antwort.
  const dockStd = Number((roh.match(/const VP_DOCK_STUNDEN = (\d+);/) || [])[1]);
  const dockMax = Number((roh.match(/const VP_DOCK_MAX = (\d+);/) || [])[1]);
  const dockSchiff = (roh.match(/const VP_DOCK_SCHIFF = '([a-z]+)';/) || [])[1];
  const sperr = Number((roh.match(/key: 'sperrfeuer',[\s\S]{0,400}?verlust: ([\d.]+)/) || [])[1]);
  const plaetze = Number((roh.match(/key: 'sternenmarkt',[\s\S]{0,400}?marktPlaetze: (\d+)/) || [])[1]);
  const slotsMax = Number((roh.match(/const VP_MARKT_SLOTS_MAX = (\d+);/) || [])[1]);
  const basisSlots = Number((roh.match(/const MODULE_MARKET_MAX_LISTINGS_PER_USER = (\d+);/) || [])[1]);
  check('0a: Dock-Zahlen, Sperrfeuer-Aufschlag und Marktplaetze sind im Quelltext auffindbar',
    dockStd > 0 && dockMax > 0 && !!dockSchiff && sperr > 0 && plaetze > 0 && slotsMax > 0 && basisSlots > 0,
    { dockStd, dockMax, dockSchiff, sperr, plaetze, slotsMax, basisSlots });

  let basis = roh.replace(/const VORPOSTEN_AKTIV = (true|false);/, 'const VORPOSTEN_AKTIV = true;')
    .replace(/const VP_MARKT_AKTIV = (true|false);/, 'const VP_MARKT_AKTIV = true;');
  /* `endstart` nimmt die Schalterpruefung AM ENDPUNKT heraus (nicht die an der Liste - die ist
     `schalter`). Beide Sabotagen belegen sich selbst ueber 0c bzw. 0b: eine Ersetzung, die ins
     Leere greift, meldet keinen Fehler und sieht dann aus wie eine bestandene Gegenprobe. */
  if (SAB === 'endstart') basis = basis.replace('  if (!VP_ENDPROJEKTE_AKTIV && vpIstEndprojekt(key)) {\n', '  if (false) {\n');
  check('0c: die Sabotage `endstart` hat gegriffen (oder wurde gar nicht verlangt)',
    SAB !== 'endstart' || (!/if \(!VP_ENDPROJEKTE_AKTIV && vpIstEndprojekt\(key\)\) \{/.test(basis) && /if \(false\) \{/.test(basis)));
  if (SAB === 'schalter') basis = basis.replace('    (VP_ENDPROJEKTE_AKTIV || !vpIstEndprojekt(d.key)) &&\n', '');
  if (SAB === 'sperrfeuer') basis = basis.replace("const sperrfeuer = (vorpostenWerte(doc).projektBoni || {}).verlust || 0;", 'const sperrfeuer = 0;');
  if (SAB === 'plaetze') basis = basis.replace('+ Math.round(ausProjekt) };', '};');
  if (SAB === 'dockdeckel') basis = basis.replace('Math.max(0, Math.min(VP_DOCK_MAX, Math.floor(stunden / VP_DOCK_STUNDEN)))', 'Math.max(0, Math.floor(stunden / VP_DOCK_STUNDEN))');
  /* Die Sabotage muss den NEUEN Block treffen: Seit der Fortschritt uebertragen wird (statt
     dockSeit auf jetzt zu setzen), gibt es die alte Zeile nicht mehr - die erste Fassung griff
     ins Leere und sah dabei aus wie eine bestandene Gegenprobe. */
  if (SAB === 'dockseit') basis = basis.replace(/  if \(schiffe\) \{\n(.*\n)*?  \}\n/, '');
  const an = basis.replace(/const VP_ENDPROJEKTE_AKTIV = (true|false);/, 'const VP_ENDPROJEKTE_AKTIV = true;');
  check('0b: der Endprojekt-Schalter liess sich in der Kopie umlegen', /const VP_ENDPROJEKTE_AKTIV = true;/.test(an),
    { gefunden: /const VP_ENDPROJEKTE_AKTIV = (true|false);/.test(roh) });

  // ---- 1) Ausgeschaltet steht kein Endprojekt zur Wahl -----------------------------------------
  fs.writeFileSync(QUELLE, basis.replace(/const VP_ENDPROJEKTE_AKTIV = (true|false);/, 'const VP_ENDPROJEKTE_AKTIV = false;'));
  const dbAus = grunddb();
  dbAus.shared['vorposten:w8'] = JSON.stringify(vpDoc('w8', 8, 'werft'));
  fs.writeFileSync(dbPfad, JSON.stringify(dbAus, null, 1));
  let s = await starteServer();
  let tokA = await s.anmelden('anna');
  const ausListe = ((await s.hole('/vorposten', tokA)).body.liste || []).find(v => v.sys === 'w8');
  /* `projektMoeglich` ist eine Liste von SCHLUESSELN, keine Objekte (im Server nachgelesen). Der
     erste Entwurf las `p.key`, bekam ueberall null - und bestand deshalb, ohne etwas zu belegen.
     Ein falsches Gruen, aufgefallen erst daran, dass 1b mit derselben Lesart fiel. */
  const ausMoeglich = ausListe.projektMoeglich || [];
  check('1a: ausgeschaltet steht auf der Endstufe KEIN Endprojekt zur Wahl',
    ausMoeglich.length > 0 && !ausMoeglich.some(k => ['sternendock','sternenmarkt','sperrfeuer'].indexOf(k) >= 0),
    { moeglich: ausMoeglich });
  /* AUDIT-BEFUND 04.09.2026: 1a misst nur die ANGEBOTENE Liste. Der Endpunkt selbst war offen -
     wer den Schluessel direkt schickte, startete das Endprojekt trotz ausgeschaltetem Schalter,
     blockierte den einzigen Projektplatz 36 Stunden lang und liess beim spaeteren Umlegen des
     Schalters die ganze Wartezeit als Dock-Fortschritt gutschreiben. Ein Schalter, der nur die
     Anzeige einer Wahl gattert, ist kein Schalter. */
  const ausStart = await s.sende('/vorposten/projekt/starten', tokA, { system: 'w8', projekt: 'sternendock' });
  check('1a2: ausgeschaltet lehnt auch der ENDPUNKT ein Endprojekt ab, nicht nur die Liste',
    ausStart.status === 404 && !!(ausStart.body && ausStart.body.inaktiv),
    { status: ausStart.status, body: ausStart.body });
  const ausOffen = await s.sende('/vorposten/projekt/starten', tokA, { system: 'w8', projekt: ausMoeglich[0] });
  check('1a3: ein gewoehnliches Projekt geht weiter durch - die Sperre trifft NUR die Endprojekte',
    ausOffen.status === 200, { projekt: ausMoeglich[0], status: ausOffen.status });
  check('1a4: und das abgelehnte Endprojekt steht danach NICHT im Dokument',
    !(liesDoc('w8').projekte || []).some(p => p && p.key === 'sternendock'),
    { projekte: (liesDoc('w8').projekte || []).map(p => p && p.key) });
  await stoppeServer();

  // ---- 2) Mit umgelegtem Schalter: jeder Zweig genau seins --------------------------------------
  fs.writeFileSync(QUELLE, an);
  const db = grunddb();
  db.shared['vorposten:w8'] = JSON.stringify(vpDoc('w8', 8, 'werft'));
  db.shared['vorposten:h8'] = JSON.stringify(vpDoc('h8', 8, 'handel'));
  db.shared['vorposten:f8'] = JSON.stringify(vpDoc('f8', 8, 'festung'));
  fs.writeFileSync(dbPfad, JSON.stringify(db, null, 1));
  s = await starteServer();
  tokA = await s.anmelden('anna');
  const liste = (await s.hole('/vorposten', tokA)).body.liste || [];
  const moeglich = (sys) => ((liste.find(v => v.sys === sys) || {}).projektMoeglich || []);
  check('1b: jeder Zweig bekommt GENAU sein Endprojekt angeboten, keines der anderen', (() => {
    const w = moeglich('w8'), h = moeglich('h8'), f = moeglich('f8');
    return w.includes('sternendock') && !w.includes('sternenmarkt') && !w.includes('sperrfeuer')
      && h.includes('sternenmarkt') && !h.includes('sternendock') && !h.includes('sperrfeuer')
      && f.includes('sperrfeuer') && !f.includes('sternendock') && !f.includes('sternenmarkt');
  })(), { werft: moeglich('w8'), handel: moeglich('h8'), festung: moeglich('f8') });
  check('1c: die Endstufe dominiert ihr System - abgeleitet, nicht gespeichert',
    liste.filter(v => v.dominiert).length === 3, { dominiert: liste.map(v => v.sys + ':' + v.dominiert) });

  // ---- 3) Der Sternenmarkt hebt den Deckel ------------------------------------------------------
  const vorMarkt = (await s.hole('/modulemarket', tokA)).body.limits;
  await stoppeServer();
  const db3 = liesDb();
  const d3 = JSON.parse(db3.shared['vorposten:h8']); d3.projekte = [fertig('sternenmarkt', 1)];
  db3.shared['vorposten:h8'] = JSON.stringify(d3);
  fs.writeFileSync(dbPfad, JSON.stringify(db3, null, 1));
  s = await starteServer(); tokA = await s.anmelden('anna');
  const nachMarkt = (await s.hole('/modulemarket', tokA)).body.limits;
  check('3a: der Sternenmarkt gibt seine Plaetze UEBER dem Deckel - das ist der Sinn eines Endprojekts', (() => {
    return nachMarkt.maxPerUser === vorMarkt.maxPerUser + plaetze
      && nachMarkt.vorpostenAngebote === vorMarkt.vorpostenAngebote + plaetze
      && vorMarkt.vorpostenAngebote === slotsMax;   // der Deckel war vorher schon erreicht
  })(), { vorher: vorMarkt.maxPerUser, nachher: nachMarkt.maxPerUser, deckelVorher: vorMarkt.vorpostenAngebote, ausProjekt: plaetze });

  // ---- 4) Das Sternendock rechnet, es tickt nicht -----------------------------------------------
  await stoppeServer();
  const db4 = liesDb();
  const d4 = JSON.parse(db4.shared['vorposten:w8']);
  d4.projekte = [fertig('sternendock', 3 * dockStd)];   // drei Perioden her
  db4.shared['vorposten:w8'] = JSON.stringify(d4);
  const d4b = JSON.parse(db4.shared['vorposten:f8']);
  d4b.projekte = [fertig('sternendock', 3 * dockStd)];   // FESTUNG mit Dock: darf nichts liefern
  db4.shared['vorposten:f8'] = JSON.stringify(d4b);
  fs.writeFileSync(dbPfad, JSON.stringify(db4, null, 1));
  s = await starteServer(); tokA = await s.anmelden('anna');
  const l4 = (await s.hole('/vorposten', tokA)).body.liste || [];
  const w8 = l4.find(v => v.sys === 'w8'), f8 = l4.find(v => v.sys === 'f8');
  check('4a: nach drei Perioden liegen drei Schiffe bereit', w8.dockBereit === 3 && w8.dockSchiff === dockSchiff,
    { bereit: w8.dockBereit, schiff: w8.dockSchiff });
  await stoppeServer();
  const db4c = liesDb();
  const d4c = JSON.parse(db4c.shared['vorposten:w8']);
  d4c.projekte = [fertig('sternendock', 40 * dockStd)];   // weit ueber dem Deckel
  db4c.shared['vorposten:w8'] = JSON.stringify(d4c);
  fs.writeFileSync(dbPfad, JSON.stringify(db4c, null, 1));
  s = await starteServer(); tokA = await s.anmelden('anna');
  const w8b = ((await s.hole('/vorposten', tokA)).body.liste || []).find(v => v.sys === 'w8');
  check('4b: nach vierzig Perioden liegt trotzdem nur der Deckel bereit', w8b.dockBereit === dockMax,
    { bereit: w8b.dockBereit, deckel: dockMax });
  const geholt = await s.sende('/vorposten/lager/holen', tokA, { system: 'w8' });
  check('4c: das Abholen gibt die Schiffe heraus, ueber die Warteschlange mit dem Lager zusammen',
    geholt.status === 200 && geholt.body.schiffe === dockMax, { status: geholt.status, schiffe: geholt.body.schiffe });
  const w8c = ((await s.hole('/vorposten', tokA)).body.liste || []).find(v => v.sys === 'w8');
  check('4d: danach liegt nichts mehr bereit - `dockSeit` steht auf JETZT', w8c.dockBereit === 0,
    { bereit: w8c.dockBereit, dockSeit: liesDoc('w8').dockSeit });
  check('4e: ein Dock am FALSCHEN Zweig liefert nichts - die Wirkung haengt am Projekt, nicht am Wunsch',
    f8.dockBereit === 0, { festung: f8.dockBereit });

  // ---- 5) Das Sperrfeuer kostet den Angreifer ---------------------------------------------------
  /* Gemessen wird der ECHTE Schlag, zweimal: gegen eine Festung ohne und eine mit Leitstand. Die
     Quote hat einen Zufallsanteil (bis 0,04), deshalb wird sie nicht auf die Nachkommastelle
     verglichen, sondern der Aufschlag muss GROESSER sein als dieser Zufallsanteil. */
  await stoppeServer();
  const db5 = liesDb();
  for (const [sys, mitLeit] of [['ohne', false], ['mit', true]]) {
    const d = vpDoc(sys, 8, 'festung', { garnison: {}, kern: { lp: 6000000, lpMax: 6000000 } });
    if (mitLeit) d.projekte = [fertig('sperrfeuer', 1)];
    db5.shared['vorposten:' + sys] = JSON.stringify(d);
  }
  const svB = JSON.parse(db5.private[BEN]['kepler7-save-v3']);
  svB.fleet.missions = [
    { id: 'm1', type: 'vorposten-angriff', targetId: 'ohne', system: 'ohne', startTime: Date.now()-7200000, endTime: Date.now()-3600000, fleetName: 'F', composition: Object.assign({}, FLOTTE) },
    { id: 'm2', type: 'vorposten-angriff', targetId: 'mit', system: 'mit', startTime: Date.now()-7200000, endTime: Date.now()-3600000, fleetName: 'F', composition: Object.assign({}, FLOTTE) }
  ];
  svB.__attackShieldUntil = 0;
  db5.private[BEN]['kepler7-save-v3'] = JSON.stringify(svB);
  fs.writeFileSync(dbPfad, JSON.stringify(db5, null, 1));
  s = await starteServer();
  const tokB = await s.anmelden('ben');
  const ohne = await s.sende('/vorposten/angriff', tokB, { system: 'ohne', missionId: 'm1' });
  const mit  = await s.sende('/vorposten/angriff', tokB, { system: 'mit',  missionId: 'm2' });
  check('2-vorab: beide Schlaege sind durchgegangen', ohne.status === 200 && mit.status === 200,
    { ohne: ohne.status, mit: mit.status, fehlerOhne: ohne.body && ohne.body.error, fehlerMit: mit.body && mit.body.error });
  /* Gemessen werden die ECHTEN Schiffsverluste, nicht eine Quote: Die Antwort fuehrt keine
     (nachgelesen an /api/vorposten/angriff), und die Verluste sind ohnehin das, was der Spieler
     sieht. Beide Schlaege fliegen dieselbe Flotte gegen dieselbe Stufe mit leerer Garnison - der
     einzige Unterschied ist der Leitstand. Der Zufallsanteil der Quote liegt je Schlag in [0; 0,04],
     der Aufschlag betraegt 0,08: Die Differenz ist damit immer positiv, nie ein Muenzwurf. */
  const verluste = (b) => Object.values((b && b.eigeneVerluste) || {}).reduce((a, n) => a + (Number(n) || 0), 0);
  const flotteGesamt = Object.values(FLOTTE).reduce((a, n) => a + n, 0);
  check('2a: mit Sperrfeuerleitstand verliert der Angreifer sichtbar mehr Schiffe', (() => {
    const vO = verluste(ohne.body), vM = verluste(mit.body);
    return vO > 0 && vM > vO && (vM - vO) >= 0.04 * flotteGesamt;
  })(), { ohne: verluste(ohne.body), mit: verluste(mit.body), flotte: flotteGesamt,
          mindestensMehr: Math.round(0.04 * flotteGesamt), aufschlag: sperr });
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
