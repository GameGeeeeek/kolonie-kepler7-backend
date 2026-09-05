// Modul-Sets und der Steckplatz je Zweig (Etappe V7, 05.09.2026).
//
//   node tests/test_vorposten_sets_http.js
//
// Bis hierher war jedes Stationsmodul fuer sich allein wirksam, und die Steckplatzzahl hing nur an
// der Stufe. Wer bestueckte, beantwortete sechsmal dieselbe Frage („welcher Kanal ist mir am
// meisten wert?") und nie eine Kombination.
//
// DREI DINGE SIND DIE MECHANIK, und alle drei werden hier gemessen:
//   1. DAS SET      - zwei zusammengehoerende Module geben einen ZUSAETZLICHEN Bonus, unabhaengig
//                     von der Seltenheit (Abschnitt 3). Ein Set belohnt Breite, die Seltenheit
//                     belohnt Tiefe.
//   2. DER PLATZ    - der Festungsring bekommt einen sechsten Steckplatz, und NUR dort ist die
//                     „Sternwacht" mit allen sechs Modulen erreichbar (Abschnitt 4).
//   3. DER SCHALTER - solange VP_MODUL_SETS_AKTIV liegt, rechnet der Server Zahl fuer Zahl wie vor
//                     V7 (Abschnitt 1). Das ist die Voraussetzung dafuer, dass dieser Stand vor
//                     dem Frontend live gehen darf.
//
// DIE WICHTIGSTE PRUEFUNG IST 2b: Ein Zweig darf NIE weniger Steckplaetze haben als die Leiter
// hergibt. `vpModulBoni` und `vorpostenFuerClient` schneiden die Modulliste auf die
// Steckplatzzahl - ein Abzug haette ein bereits eingebautes Modul still wirkungslos gemacht und es
// dem Besitzer aus der Anzeige genommen, ohne Meldung und ohne Rueckgabe in den Bestand. Das ist
// die Hausregel „Deckel duerfen niemals Daten loeschen" in ihrer Wirkung.
//
// Gegenprobe: siehe Fuss der Datei.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3263;
const QUELLE = path.join(WURZEL, 'server_vpsets_tmp.js');
const SAB = process.env.KEPLER_VPSETS_SABOTAGE || '';
// Was bei welcher Sabotage fallen MUSS - GEMESSEN, nicht geschaetzt (die Listen stehen am Fuss).
/* GEMESSEN, nicht geschaetzt - und dreimal korrigiert, weil die erste Liste falsch war:
   `seltenheit` riss anfangs fuenf Pruefungen mit, weil ALLE Vorlagen gewoehnliche Module trugen
   (die Vorlagen sind jetzt gemischt, nur die eine fuer 3b bleibt gewoehnlich); `kanal` nahm 3a mit,
   weil 3a auch den BONUS las statt nur das Zustandekommen des Sets; und `abzug` fiel ins Leere,
   weil vpModulSlots den Zuschlag selbst auf >= 0 klemmt - die Sabotage muss diese Klemme mit
   entfernen, sonst laeuft ein unsabotierter Server. */
const MUSS_FALLEN = { abzug: ['2a', '2b'], seltenheit: ['3b'], scheibe: ['4b', '5a'], kanal: ['6a', '6b'],
  abbauscheibe: ['8a'] };

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
const ANNA = crypto.randomUUID();
/* Ein ZWEITES Konto, seit die Modulliste zwei Sichten hat (05.09.2026): Der Besitzer sieht ALLES,
   was in seiner Station steckt, ein Fremder nur die WIRKENDEN Stuecke. Ohne diesen Fremden misst
   4b nur noch die Besitzersicht - und die Scheibe waere unbeobachtet. */
const BEN = crypto.randomUUID();
const dbPfad = path.join(os.tmpdir(), 'kepler-vpsets-' + process.pid + '.json');
let srv = null;

const save = (id, name) => ({ resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
  buildings: {}, research: {}, colonies: {}, fleet: { missions: [] },
  player: { id, name }, credits: 9000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now() });
function grunddb() {
  return {
    users: { anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() },
             ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: Date.now() } },
    private: { [ANNA]: { 'kepler7-save-v3': JSON.stringify(save(ANNA, 'anna')),
               },
               [BEN]:  { 'kepler7-save-v3': JSON.stringify(save(BEN, 'ben')) } },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {}, wrackKonvois: [], a2Verlauf: [] }
  };
}
const vpDoc = (sys, stufe, zweig, module) => ({ id: 'vp_' + crypto.randomUUID(), sys,
  besitzer: ANNA, besitzerName: 'anna', seit: Date.now() - 30 * 24 * 3600 * 1000,
  stufe, zweig, kern: { lp: 20000, lpMax: 20000 }, garnison: {}, garnisonVon: {}, schlaege: {},
  beitraege: {}, module: module || [], ausbauSeit: Date.now() - 13 * 3600 * 1000, kampfverlauf: [] });

function ende() {
  try { if (srv) srv.kill(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.unlinkSync(QUELLE); } catch (e) {}   // die Kopie NIE liegen lassen
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
/* Reihenfolge-Wache: Eine Aenderung an der DB-DATEI bei laufendem Server ist beim naechsten SIGTERM
   wieder weg - der Graceful Shutdown flusht die im Speicher gehaltene db darueber. */
async function schreibeDb(fn) {
  await stoppeServer();
  const d = JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
  fn(d);
  fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
  return starteServer();
}
const setzeDoc = (d, doc) => { d.shared['vorposten:' + doc.sys] = JSON.stringify(doc); };
const vpVon = (liste, sys) => (liste || []).find(v => v.sys === sys) || null;

(async () => {
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  /* ANKER AUS DEM QUELLTEXT - nicht aus der Antwort, die geprueft werden soll. Die Set-Tabelle,
     die Zweig-Zuschlaege und der Schalter. */
  const setBlock = (roh.match(/const VP_MODUL_SET_DEFS = \[[\s\S]*?\n\];/) || [''])[0];
  const setKeys = [...setBlock.matchAll(/\{ key: '([a-z]+)', name:/g)].map(m => m[1]);
  const zweigSlots = JSON.parse((roh.match(/const VP_ZWEIG_SLOTS = (\{[^}]*\});/) || ['', '{}'])[1]
    .replace(/([a-z]+):/g, '"$1":'));
  const slotsMax = Number((roh.match(/const VP_MODUL_SLOTS_MAX = (\d+);/) || [])[1]);
  const zweigAb = Number((roh.match(/const VORPOSTEN_ZWEIG_AB = (\d+);/) || [])[1]);
  const schalterAusgeliefert = /const VP_MODUL_SETS_AKTIV = true;/.test(roh);
  check('0a: Set-Tabelle, Zweig-Zuschlaege, Deckel und Wahlstufe sind im Quelltext auffindbar',
    setKeys.length >= 3 && Object.keys(zweigSlots).length === 3 && slotsMax > 5 && zweigAb > 0,
    { sets: setKeys, zweigSlots, slotsMax, zweigAb });
  /* DIE ZUSCHLAEGE DUERFEN NUR ADDIEREN - als Quelltextregel, nicht nur als Verhalten (2b misst
     dasselbe an der Antwort). Ein negativer Wert waere ein Deckel, der Daten unsichtbar macht. */
  check('0b: kein Zweig-Zuschlag ist negativ',
    Object.values(zweigSlots).every(n => Number(n) >= 0), zweigSlots);
  /* 0c HAT SEINE RICHTUNG GEWECHSELT (05.09.2026). Bis zum Umlegen stand hier „der Schalter ist
     false" - die Wache ueber die Auslieferungsreihenfolge: Backend zuerst live, Frontend danach.
     Die Reihenfolge ist eingehalten, das Spiel liest die Felder, und ab jetzt waere ein
     zurueckgefallener Schalter der Fehler. Die zwei Laeufe unten erzwingen ihren Zustand seitdem
     SELBST (`ausQuelle`/`anQuelle`), damit dieser Test nicht mehr am ausgelieferten Wert haengt. */
  check('0c: der Schalter steht ausgeliefert auf true - die Frontend-Haelfte ist live',
    schalterAusgeliefert, { gefunden: (roh.match(/const VP_MODUL_SETS_AKTIV = (\w+);/) || [])[1] });

  const basis = roh.replace(/const VORPOSTEN_AKTIV = (true|false);/, 'const VORPOSTEN_AKTIV = true;');
  /* BEIDE Laeufe erzwingen ihren Schalterzustand, statt einen davon vom ausgelieferten Wert zu
     erben: Sonst haette das Umlegen des Schalters den Aus-Lauf still in einen zweiten An-Lauf
     verwandelt, und Pruefung 1a („mit liegendem Schalter aendert sich nichts") haette ihre eigene
     Aussage geprueft. */
  let ausQuelle = basis.replace(/const VP_MODUL_SETS_AKTIV = (true|false);/, 'const VP_MODUL_SETS_AKTIV = false;');
  let anQuelle = basis.replace(/const VP_MODUL_SETS_AKTIV = (true|false);/, 'const VP_MODUL_SETS_AKTIV = true;');
  if (SAB === 'abzug') {
    /* ZWEI Handgriffe: die Tabelle UND die Klemme in vpModulSlots. Mit nur der Tabelle laeuft ein
       unsabotierter Server - `Math.max(0, ...)` faengt den negativen Wert ab, und die Gegenprobe
       belegte nichts (gemessen 05.09.2026). Genau der Fehler, den der Lager-Test schon einmal
       hatte, nur eine Ebene tiefer: nicht ein Muster, das nicht trifft, sondern ein Treffer ohne
       Wirkung. */
    anQuelle = anQuelle.replace(/const VP_ZWEIG_SLOTS = \{[^}]*\};/,
      "const VP_ZWEIG_SLOTS = { werft: 0, handel: -1, festung: 1 };")
      .replace('const dazu = Math.max(0, (vorpostenZweigOk(zweig) ? VP_ZWEIG_SLOTS[zweig] : 0) || 0);',
        'const dazu = (vorpostenZweigOk(zweig) ? VP_ZWEIG_SLOTS[zweig] : 0) || 0;');
  }
  if (SAB === 'seltenheit') {
    anQuelle = anQuelle.replace('if (teil) drin.add(teil.key);',
      "if (teil && teil.seltenheit !== 'gewoehnlich') drin.add(teil.key);");
  }
  if (SAB === 'scheibe') {
    anQuelle = anQuelle.replace(
      "for (const instKey of (doc && Array.isArray(doc.module) ? doc.module : []).slice(0, vpModulSlotsVon(doc))) {\n    const teil = vpModulTeile(instKey);\n    if (teil) drin.add(teil.key);",
      "for (const instKey of (doc && Array.isArray(doc.module) ? doc.module : [])) {\n    const teil = vpModulTeile(instKey);\n    if (teil) drin.add(teil.key);");
  }
  /* DIE SCHEIBE BEIM ABBAU. Sie stand dort und war der eine Weg, auf dem ein Modul VERNICHTET
     wird - siehe Abschnitt 8. */
  if (SAB === 'abbauscheibe') {
    /* IN BEIDE KOPIEN. Abschnitt 8 laeuft im AUS-Lauf - eine Sabotage nur in `anQuelle` haette dort
       einen unsabotierten Server laufen lassen und nichts belegt (gemessen 05.09.2026, derselbe
       Fehler wie bei `abzug`, nur an der anderen Kopie). */
    const mitScheibe = q => q.replace('const module = (Array.isArray(doc.module) ? doc.module : []).slice();',
      'const module = (Array.isArray(doc.module) ? doc.module : []).slice(0, vpModulSlotsVon(doc));');
    anQuelle = mitScheibe(anQuelle);
    ausQuelle = mitScheibe(ausQuelle);
  }
  if (SAB === 'kanal') {
    anQuelle = anQuelle.replace('const se = vpModulSetBoni(doc);',
      "const se = { kern: 0, verteidigung: 0, garnison: 0, flug: 0, prod: 0, scan: 0, werft: 0, markt: 0 };");
  }
  // Eine Sabotage, die NICHTS ersetzt, laesst einen unsabotierten Server laufen und belegt nichts
  // (gemessener Fehler im Lager-Test, 04.09.2026: `String.replace` meldet keinen Treffer).
  if (SAB) {
    /* Beide Kopien pruefen: `abbauscheibe` trifft den AUS-Lauf, alle anderen den AN-Lauf. */
    const anRein = basis.replace(/const VP_MODUL_SETS_AKTIV = (true|false);/, 'const VP_MODUL_SETS_AKTIV = true;');
    const ausRein = basis.replace(/const VP_MODUL_SETS_AKTIV = (true|false);/, 'const VP_MODUL_SETS_AKTIV = false;');
    check('0d: die Sabotage „' + SAB + '" hat den Quelltext wirklich veraendert',
      anQuelle !== anRein || ausQuelle !== ausRein, { SAB });
  }

  // ---- 1. Der Schalter liegt: alles rechnet wie vor V7 -----------------------------------------
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  fs.writeFileSync(QUELLE, ausQuelle);
  let api = await starteServer();
  let tok = await api.anmelden('anna');
  /* GEMISCHTE SELTENHEITEN mit Absicht: Traegen alle Vorlagen gewoehnliche Module, reisst die
     Sabotage „seltenheit" jede Set-Pruefung mit und isoliert gar nichts. Nur die Vorlage fuer 3b
     („die Seltenheit zaehlt nicht") bleibt bewusst gewoehnlich - das ist ihre Aussage. */
  const ALLE = ['kernpanzer:selten', 'geschuetz:episch', 'hangar:selten',
    'sprungrechner:ungewoehnlich', 'raffinerie:episch', 'horchposten:selten'];
  api = await schreibeDb(d => {
    setzeDoc(d, vpDoc('aus-fest', 8, 'festung', ALLE.slice(0, 2)));
    /* DIESELBE Bestueckung wie „an-fest-voll" - 6b vergleicht sonst zwei verschiedene Stationen
       und misst die Hangarerweiterung statt des Sets (gemessener eigener Fehler, 05.09.2026). */
    setzeDoc(d, vpDoc('aus-fest-voll', 8, 'festung', ALLE.slice()));
  });
  let r = await api.hole('/vorposten', tok);
  const ausFest = vpVon(r.body && r.body.liste, 'aus-fest');
  check('1-anker: der Vorposten kommt beim liegenden Schalter ueberhaupt an', !!ausFest,
    { liste: (r.body && r.body.liste || []).map(v => v.sys) });
  check('1a: mit liegendem Schalter gibt es keine Sets und keinen Zusatzplatz',
    !!ausFest && ausFest.slots === 5 && Array.isArray(ausFest.sets) && ausFest.sets.length === 0
    && r.body.modulSetsAktiv === false,
    { slots: ausFest && ausFest.slots, sets: ausFest && ausFest.sets, aktiv: r.body && r.body.modulSetsAktiv });
  const ausFestVoll = vpVon(r.body && r.body.liste, 'aus-fest-voll');
  const vertAus = ausFest ? ausFest.verteidigung : 0;
  const garnAus = ausFestVoll ? ausFestVoll.garnisonMax : 0;
  await stoppeServer();

  // ---- 2. Der Schalter steht: Steckplaetze je Zweig ---------------------------------------------
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  fs.writeFileSync(QUELLE, anQuelle);
  api = await starteServer();
  tok = await api.anmelden('anna');
  api = await schreibeDb(d => {
    for (const z of ['werft', 'handel', 'festung']) {
      for (let st = 1; st <= 8; st++) setzeDoc(d, vpDoc('s-' + z + '-' + st, st, z, []));
    }
    setzeDoc(d, vpDoc('an-fest', 8, 'festung', ALLE.slice(0, 2)));
    setzeDoc(d, vpDoc('an-fest-voll', 8, 'festung', ALLE.slice()));
    setzeDoc(d, vpDoc('an-werft-voll', 8, 'werft', ALLE.slice()));
    setzeDoc(d, vpDoc('an-halb', 8, 'festung', ['kernpanzer:legendaer']));
    setzeDoc(d, vpDoc('an-selten', 8, 'festung', ['kernpanzer:gewoehnlich', 'geschuetz:gewoehnlich']));
  });
  r = await api.hole('/vorposten', tok);
  const liste = (r.body && r.body.liste) || [];
  const tokFremd = await api.anmelden('ben');
  const listeFremd = ((await api.hole('/vorposten', tokFremd)).body || {}).liste || [];
  const slotsVon = (z, st) => (vpVon(liste, 's-' + z + '-' + st) || {}).slots;
  const leiterSlots = st => Math.max(0, Math.min(5, st - zweigAb + 1));
  check('2-anker: alle 24 Zweig/Stufe-Kombinationen sind gemessen',
    ['werft', 'handel', 'festung'].every(z => [1,2,3,4,5,6,7,8].every(st => typeof slotsVon(z, st) === 'number')),
    { fehlend: ['werft','handel','festung'].flatMap(z => [1,2,3,4,5,6,7,8]
      .filter(st => typeof slotsVon(z, st) !== 'number').map(st => z + ':' + st)) });
  check('2a: der Festungsring bekommt einen sechsten Steckplatz, die anderen bleiben bei fuenf',
    slotsVon('festung', 8) === 6 && slotsVon('werft', 8) === 5 && slotsVon('handel', 8) === 5,
    { festung: slotsVon('festung', 8), werft: slotsVon('werft', 8), handel: slotsVon('handel', 8) });
  /* DIE WICHTIGSTE PRUEFUNG. Ein Zweig, der WENIGER Plaetze haette als die Leiter, machte ein
     bereits eingebautes Modul still wirkungslos - `vpModulBoni` schneidet die Liste auf `slots`. */
  const zuWenig = [];
  for (const z of ['werft', 'handel', 'festung']) {
    for (let st = 1; st <= 8; st++) if (slotsVon(z, st) < leiterSlots(st)) zuWenig.push(z + ':' + st);
  }
  check('2b: KEIN Zweig hat auf irgendeiner Stufe weniger Steckplaetze als die Leiter',
    zuWenig.length === 0, { zuWenig, leiter: [1,2,3,4,5,6,7,8].map(leiterSlots) });
  check('2c: und keiner mehr als der Deckel', ['werft','handel','festung']
    .every(z => [1,2,3,4,5,6,7,8].every(st => slotsVon(z, st) <= slotsMax)), { slotsMax });

  // ---- 3. Das Set wirkt, und die Seltenheit zaehlt dabei nicht ----------------------------------
  const anFest = vpVon(liste, 'an-fest');
  const anHalb = vpVon(liste, 'an-halb');
  const anSelten = vpVon(liste, 'an-selten');
  check('3-anker: die drei Bestueckungen sind angekommen', !!anFest && !!anHalb && !!anSelten,
    { anFest: !!anFest, anHalb: !!anHalb, anSelten: !!anSelten });
  /* NUR das Zustandekommen - der Bonus ist die Aussage von 6a. Mit der Bonus-Bedingung hier fiel
     3a bei jeder Sabotage mit, die den Kanal betrifft, und sagte damit nichts Eigenes mehr. */
  check('3a: zwei zusammengehoerende Module ergeben das Set',
    !!anFest && anFest.sets.includes('trutzring'), { sets: anFest && anFest.sets });
  check('3b: die Seltenheit zaehlt dabei nicht - zwei gewoehnliche Module reichen',
    !!anSelten && anSelten.sets.includes('trutzring'), { sets: anSelten && anSelten.sets });
  /* `setBoni` muss DA SEIN und null sein - nicht fehlen. Die erste Fassung liess `!anHalb.setBoni`
     durchgehen; ein Feld, das gar nicht mehr geschickt wird, haette diese Pruefung bestanden. */
  check('3c: ein halbes Set gibt nichts - und `setBoni` steht trotzdem in der Antwort',
    !!anHalb && anHalb.sets.length === 0 && !!anHalb.setBoni
    && Object.values(anHalb.setBoni).every(w => w === 0),
    { sets: anHalb && anHalb.sets, boni: anHalb && anHalb.setBoni });

  // ---- 4. Die Sternwacht braucht den sechsten Platz ---------------------------------------------
  const festVoll = vpVon(liste, 'an-fest-voll');
  const werftVoll = vpVon(liste, 'an-werft-voll');
  check('4-anker: beide Vollbestueckungen sind angekommen', !!festVoll && !!werftVoll,
    { festVoll: !!festVoll, werftVoll: !!werftVoll });
  check('4a: auf dem Festungsring stecken alle sechs, und die Sternwacht steht',
    !!festVoll && festVoll.module.length === 6 && festVoll.sets.includes('sternwacht'),
    { module: festVoll && festVoll.module.length, sets: festVoll && festVoll.sets });
  /* Gemessen wird die SCHEIBE, nicht die Ablehnung des Einbau-Endpunkts (die steht in
     test_vorposten_http.js, Abschnitt 9): Das sechste Modul liegt hier absichtlich im Dokument,
     damit sichtbar wird, dass ein Modul ohne Steckplatz weder gezaehlt noch gezeigt wird.
     DIE SCHEIBE HAT SEIT 05.09.2026 ZWEI SEITEN. Sie begrenzt weiterhin die WIRKUNG (die
     Sternwacht steht nicht) und die Sicht eines FREMDEN - nur die wirkenden Stuecke erklaeren die
     Staerke. Der BESITZER dagegen sieht auch das ueberzaehlige Stueck: Es gehoert ihm weiter,
     /vorposten/modul/ausbauen gibt es heraus, und ohne die Zeile haette er dafuer keinen Knopf. */
  const werftFremd = vpVon(listeFremd, 'an-werft-voll');
  check('4b: die Wirkung und die Fremdsicht sind auf fuenf geschnitten, die Besitzersicht nicht',
    !!werftVoll && !!werftFremd && werftVoll.module.length === 6 && werftFremd.module.length === 5
    && !werftVoll.sets.includes('sternwacht') && werftVoll.sets.includes('trutzring'),
    { besitzer: werftVoll && werftVoll.module.length, fremd: werftFremd && werftFremd.module.length,
      sets: werftVoll && werftVoll.sets });

  // ---- 5. Was nicht in einem Steckplatz steckt, zaehlt auch nicht zum Set -----------------------
  check('5a: das sechste Modul einer Werft zaehlt nicht zum Set',
    !!werftVoll && !werftVoll.sets.includes('umschlagplatz'),
    { module: werftVoll && werftVoll.module, sets: werftVoll && werftVoll.sets });

  // ---- 6. Der Bonus kommt wirklich an den Zahlen an ---------------------------------------------
  check('6-anker: die Vergleichswerte vom liegenden Schalter sind gemessen - je aus DERSELBEN Bestueckung',
    vertAus > 0 && garnAus > 0 && !!ausFestVoll, { vertAus, garnAus });
  check('6a: dieselbe Bestueckung wehrt sich mit Set staerker als ohne',
    !!anFest && anFest.verteidigung > vertAus, { mit: anFest && anFest.verteidigung, ohne: vertAus });
  check('6b: und die Sternwacht hebt zusaetzlich die Garnisonsgrenze',
    !!festVoll && festVoll.garnisonMax > garnAus, { mit: festVoll && festVoll.garnisonMax, ohne: garnAus });

  /* ---- 7. Was der Client zum Anzeigen braucht, liegt WIRKLICH auf der Leitung ------------------
     0a liest die Tabelle aus dem QUELLTEXT - das belegt nicht, dass sie auch verschickt wird. Das
     Spiel hat keine eigene Set-Tabelle; faellt `modulSetDefs` aus der Antwort, kennt es die Namen
     nicht mehr, und beide Test-Suiten blieben gruen (die Frontend-Vorlage liefert sie selbst). */
  const defs = (r.body && r.body.modulSetDefs) || null;
  check('7a: die Set-Tabelle kommt mit der Antwort, nicht nur aus dem Quelltext',
    Array.isArray(defs) && defs.length === setKeys.length
    && defs.every(d => d && d.key && d.name && Array.isArray(d.teile) && d.teile.length && d.boni)
    && defs.map(d => d.key).join() === setKeys.join(),
    { gesendet: Array.isArray(defs) ? defs.map(d => d && d.key) : defs, imQuelltext: setKeys });
  check('7b: und die Zweig-Zuschlaege ebenso',
    r.body && r.body.zweigSlots && Object.keys(r.body.zweigSlots).join() === Object.keys(zweigSlots).join(),
    { gesendet: r.body && r.body.zweigSlots, imQuelltext: zweigSlots });

  /* ---- 8. DER ABBAU GIBT ALLES ZURUECK, auch was in keinem Steckplatz mehr steckt --------------
     Der gefaehrlichste Fall der ganzen Etappe, gefunden in der adversarischen Durchsicht: Faellt
     die Steckplatzzahl unter die Zahl der eingebauten Module - der Schalter zurueckgelegt,
     nachdem ein Festungsring sechs Stueck trug -, dann schnitt der Abbau-Tick das ueberzaehlige
     Stueck ab und der Besitzer verlor es ERSATZLOS. Gemessen wird deshalb im AUS-Lauf mit sechs
     eingebauten Modulen: alle sechs muessen im Bestand ankommen. */
  await stoppeServer();
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  fs.writeFileSync(QUELLE, ausQuelle);
  api = await starteServer();
  tok = await api.anmelden('anna');
  api = await schreibeDb(d => {
    const doc = vpDoc('abbau-fest', 8, 'festung', ALLE.slice());
    doc.abbauAb = Date.now() - 1000;
    setzeDoc(d, doc);
  });
  await warte(4000);
  await stoppeServer();
  const nachher = JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
  const bestand = (nachher.users.anna && nachher.users.anna.vpModule) || {};
  const fehlen = ALLE.filter(k => !bestand[k]);
  check('8-anker: der Abbau-Tick hat wirklich aufgeraeumt (sonst misst 8a nichts)',
    !nachher.shared['vorposten:abbau-fest'], { docDanach: !!nachher.shared['vorposten:abbau-fest'] });
  check('8a: ALLE sechs Module kommen zurueck - auch das, fuer das es keinen Steckplatz mehr gibt',
    fehlen.length === 0, { fehlen, bestand });

  if (SAB) {
    const soll = MUSS_FALLEN[SAB] || [];
    const gefallen = Object.keys(ergebnis).filter(n => !ergebnis[n]).map(n => n.split(':')[0]);
    const fehlend = soll.filter(n => !gefallen.includes(n));
    console.log('\nSABOTAGE ' + SAB + ' - gefallen: [' + gefallen.join(', ') + '], erwartet: [' + soll.join(', ') + ']');
    if (fehlend.length) { console.log('FEHLT: ' + fehlend.join(', ')); process.exit(1); }
    process.exit(0);
  }
  console.log(fail ? '\nFAIL' : '\nPASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

/* GEGENPROBE, vier Richtungen (jeweils KEPLER_VPSETS_SABOTAGE=<name> setzen).
   Die Pflichtlisten oben sind GEMESSEN, nicht geraten - siehe den Kommentar im Kopf.

   abzug       Negativer Zuschlag (handel: -1) UND die Klemme in vpModulSlots
               entfernt                                                 -> 2a und 2b fallen.
               Genau der Fall, den die Hausregel „Deckel duerfen niemals Daten loeschen" meint:
               Ein Handelsknoten auf Stufe 8 haette vier statt fuenf Plaetze, und das fuenfte
               eingebaute Modul waere ohne Meldung wirkungslos und aus der Anzeige verschwunden.
               Ohne den zweiten Handgriff faellt NICHTS - die Klemme faengt den Wert ab, und die
               Gegenprobe belegte nur, dass die Klemme da ist. 0b prueft die Tabelle selbst; sie
               liest den ausgelieferten Quelltext und kann die Klemme nicht sehen. Zwei Ebenen,
               zwei Waechter.
   seltenheit  Ein Set verlangt mehr als „gewoehnlich"                  -> 3b faellt, nur 3b.
   scheibe     vpModulSetsErfuellt liest die GANZE Modulliste statt der
               Steckplatz-Scheibe                                       -> 4b und 5a fallen (die
               Werft zeigt dann die Sternwacht, die sie nicht tragen kann).
   kanal       Die Set-Boni werden in vorpostenWerte nicht addiert      -> 6a UND 6b fallen.
   abbauscheibe Der Abbau-Tick schneidet die Modulliste wieder auf die
               Steckplatzzahl                                          -> 8a faellt.
               Das ist der gefaehrlichste Fall der Etappe, gefunden in der adversarischen
               Durchsicht: Faellt die Steckplatzzahl unter die Zahl der eingebauten Module (der
               Schalter zurueckgelegt, nachdem ein Festungsring sechs Stueck trug), verlor der
               Besitzer beim Abbau das ueberzaehlige Stueck ERSATZLOS. Die Scheibe gehoert in die
               Anzeige und in die Wirkung; beim Abbau geht es um Eigentum, und Eigentum begrenzt
               kein Deckel.
               DIESE SABOTAGE MUSS IN BEIDE KOPIEN - Abschnitt 8 laeuft im AUS-Lauf. Nur in
               `anQuelle` gesetzt, lief dort ein unsabotierter Server und nichts fiel.

   Ein Wort zu 0d: Eine Sabotage, die nichts ersetzt, laesst einen UNSABOTIERTEN Server laufen und
   sieht wie eine bestandene Gegenprobe aus. Genau das ist am 04.09.2026 im Lager-Test passiert,
   weil `String.replace` keinen Fehler meldet, wenn das Muster nicht trifft. 0d misst deshalb den
   Quelltext selbst, bevor der Server startet. */
