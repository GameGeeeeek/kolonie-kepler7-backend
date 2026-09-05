// Die Umruestung: den Zweig eines Vorpostens neu waehlen (Etappe V8, 05.09.2026).
//
//   node tests/test_vorposten_umruesten_http.js
//
// Die Ausrichtung fiel bisher EINMAL, beim Sprung auf Stufe 4, und galt fuer immer. Das war
// richtig, solange die Zweige sich nur in Multiplikatoren unterschieden - seit V6 haengen
// Endprojekte daran und seit V7 sogar die Steckplatzzahl. Eine Fehlwahl kostet inzwischen ein
// halbes Spiel.
//
// VIER DINGE SIND DIE MECHANIK, und alle vier werden hier gemessen:
//   1. DIE FRIST     - die Werte aendern sich ERST beim Abschluss (4a). Wer eine Festung bestellt,
//                      hat 24 Stunden lang die alte Verteidigung, und der Angreifer, der es sieht,
//                      hat genau dieses Fenster (4b: er sieht es).
//   2. DIE ABLEHNUNG - wer mit sechs Modulen wegruestet, laesst eines wirkungslos zurueck. Deshalb
//                      lehnt der Server VORHER ab und sagt, wie viele raus muessen (3d).
//   3. WAS BLEIBT    - ein zweiggebundenes Projekt wird NICHT geloescht, es SCHLAEFT (5c). Wer
//                      zurueckruestet, hat sein Sternendock wieder.
//   4. DER SCHALTER  - solange VP_UMRUESTEN_AKTIV liegt, gibt es den Weg gar nicht (1a), und zwar
//                      an der Stelle, die die Wahl AUSFUEHRT, nicht nur an der Anzeige.
//
// Gegenprobe: siehe Fuss der Datei.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3264;
const QUELLE = path.join(WURZEL, 'server_vpumr_tmp.js');
const SAB = process.env.KEPLER_VPUMR_SABOTAGE || '';
// Was bei welcher Sabotage fallen MUSS - GEMESSEN, nicht geschaetzt (die Listen stehen am Fuss).
/* GEMESSEN, nicht geschaetzt. `sofort` reisst 5a und 5b mit, und das ist Folge, kein
   Nebenschaden: Steht der Zweig schon beim Start, ist `vorher` im Tick bereits der neue (5a liest
   beide Namen), und das Kern-Dach ist schon vor der Vergleichsmessung gefallen (5b vergleicht
   gegen den Stand waehrend der Frist). */
const MUSS_FALLEN = { schalter: ['1a'], module: ['3d'], sofort: ['4a', '5a', '5b'], projektweg: ['5c'], lager: ['5d'] };

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
const ANNA = crypto.randomUUID();   // Besitzerin
const BEN = crypto.randomUUID();    // Fremder
const dbPfad = path.join(os.tmpdir(), 'kepler-vpumr-' + process.pid + '.json');
let srv = null;

const save = (id, name) => ({ resources: { energie: 5e6, erz: 5e6, kristalle: 5e6, deuterium: 5e6, antimaterie: 1000, forschungspunkte: 100 },
  buildings: {}, research: {}, colonies: {}, fleet: { missions: [] },
  player: { id, name }, credits: 9000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now() });
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
  besitzer: ANNA, besitzerName: 'anna', seit: Date.now() - 30 * 24 * 3600 * 1000,
  stufe, zweig, kern: { lp: 3000000, lpMax: 3000000 }, garnison: {}, garnisonVon: {}, schlaege: {},
  beitraege: {}, module: [], projekte: [], ausbauSeit: Date.now() - 13 * 3600 * 1000,
  lagerSeit: Date.now() - 6 * 3600 * 1000, kampfverlauf: [] }, extra || {});

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
const liesDoc = (d, sys) => { const r = d.shared['vorposten:' + sys]; return r ? JSON.parse(r) : null; };
const vpVon = (liste, sys) => (liste || []).find(v => v.sys === sys) || null;

(async () => {
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  /* ANKER AUS DEM QUELLTEXT - nicht aus der Antwort, die geprueft werden soll. */
  const abStufe = Number((roh.match(/const VP_UMRUESTEN_AB_STUFE = (\d+);/) || [])[1]);
  const dauerRoh = (roh.match(/const VP_UMRUESTEN_MS = ([^;]+);/) || [])[1];
  const kostenRoh = (roh.match(/const VP_UMRUESTEN_KOSTEN = (\{[^}]*\});/) || ['', '{}'])[1];
  const kosten = JSON.parse(kostenRoh.replace(/([a-z]+):/g, '"$1":'));
  const schalterAn = /const VP_UMRUESTEN_AKTIV = true;/.test(roh);
  const zweigAb = Number((roh.match(/const VORPOSTEN_ZWEIG_AB = (\d+);/) || [])[1]);
  check('0a: Stufe, Dauer und Kosten der Umruestung sind im Quelltext auffindbar',
    abStufe > zweigAb && !!dauerRoh && Object.keys(kosten).length >= 3,
    { abStufe, dauer: dauerRoh, kosten });
  /* Sie muss TEURER sein als ein regulaerer Ausbau - sonst waere die einmalige Wahl auf Stufe 4
     keine Entscheidung mehr, sondern eine Voreinstellung. */
  /* SIE MUSS TEURER SEIN ALS DER WEG DORTHIN - in JEDEM Rohstoff, den der teuerste Stufenausbau
     verlangt. Sonst waere die einmalige Wahl auf Stufe 4 keine Entscheidung mehr, sondern eine
     Voreinstellung. Der erste Entwurf war billiger als der Ausbau auf Stufe 6; genau das hat diese
     Pruefung gefangen, bevor irgendetwas ausgeliefert war. */
  const alleKosten = [...roh.matchAll(/kosten: (\{ erz: \d+[^}]*\})/g)]
    .map(m => JSON.parse(m[1].replace(/([a-z]+):/g, '"$1":')));
  /* DAS MAXIMUM JE ROHSTOFF, nicht der LETZTE Block. Die erste Fassung nahm
     `alleKosten[alleKosten.length - 1]` - und das ist, wer zuletzt in der Datei steht, nicht wer am
     teuersten ist (der Anker zeigte 6 Mio Erz statt der 9 Mio des Stufe-8-Ausbaus). Wieder eine
     Momentaufnahme statt einer Regel, diesmal in meiner eigenen Messvorrichtung. */
  const hoechste = {};
  for (const k of alleKosten) for (const [r, w] of Object.entries(k)) hoechste[r] = Math.max(hoechste[r] || 0, w);
  const zuBillig = Object.keys(hoechste).filter(r => !(kosten[r] > hoechste[r]));
  check('0b-anker: alle Kostenbloecke sind lesbar und das Maximum je Rohstoff gebildet (sonst misst 0b nichts)',
    alleKosten.length >= 7 && Object.keys(hoechste).length >= 5 && hoechste.erz >= 9000000,
    { bloecke: alleKosten.length, hoechste });
  check('0b: sie kostet in JEDEM Rohstoff mehr als der teuerste Posten der Vorposten-Tabellen',
    zuBillig.length === 0, { zuBillig, umruesten: kosten, hoechste });
  /* 0c HAT SEINE RICHTUNG GEWECHSELT (05.09.2026). Bis zum Umlegen stand hier „der Schalter ist
     false" - die Wache ueber die Auslieferungsreihenfolge. Sie ist eingehalten, das Spiel bietet
     die Wahl an, und ab jetzt waere ein zurueckgefallener Schalter der Fehler. Die beiden Laeufe
     unten erzwingen ihren Zustand ohnehin SELBST (ausQuelle/anQuelle) - dieselbe Umstellung wie
     bei den Modul-Sets, und aus demselben Grund: Sonst haette genau dieser Commit den Aus-Lauf
     still in einen zweiten An-Lauf verwandelt. */
  check('0c: der Schalter steht ausgeliefert auf true - die Frontend-Haelfte ist live',
    schalterAn, { gefunden: (roh.match(/const VP_UMRUESTEN_AKTIV = (\w+);/) || [])[1] });

  const basis = roh.replace(/const VORPOSTEN_AKTIV = (true|false);/, 'const VORPOSTEN_AKTIV = true;')
    .replace(/const VP_ENDPROJEKTE_AKTIV = (true|false);/, 'const VP_ENDPROJEKTE_AKTIV = true;')
    /* Der galaxyTick laeuft ausgeliefert alle 15 Minuten - fuer einen Test unbrauchbar. Dieselbe
       Verkuerzung wie in test_vorposten_http (dort „0-kopie3"). */
    .replace(/setInterval\(galaxyTick, 15 \* 60 \* 1000\)/, 'setInterval(galaxyTick, 1500)');
  let ausQuelle = basis.replace(/const VP_UMRUESTEN_AKTIV = (true|false);/, 'const VP_UMRUESTEN_AKTIV = false;');
  let anQuelle = basis.replace(/const VP_UMRUESTEN_AKTIV = (true|false);/, 'const VP_UMRUESTEN_AKTIV = true;');
  if (SAB === 'schalter') {
    ausQuelle = ausQuelle.replace("  if (!VP_UMRUESTEN_AKTIV || notAusGesetzt('vorposten')) {\n    return res.status(404).json({ error: 'Umrüsten ist derzeit nicht verfügbar.', inaktiv: true });\n  }", '');
  }
  if (SAB === 'module') {
    anQuelle = anQuelle.replace('  if (drinU > plaetzeZiel) {', '  if (false) {');
  }
  if (SAB === 'sofort') {
    anQuelle = anQuelle.replace('  doc.umruestenAb = jetztU + VP_UMRUESTEN_MS;',
      '  doc.zweig = ziel;\n  doc.umruestenAb = jetztU + VP_UMRUESTEN_MS;');
  }
  if (SAB === 'projektweg') {
    anQuelle = anQuelle.replace('    doc.zweig = l.ziel;',
      '    doc.zweig = l.ziel;\n    doc.projekte = (doc.projekte || []).filter(p => !(vpProjektDef(p && p.key) || {}).zweig);');
  }
  if (SAB === 'lager') {
    anQuelle = anQuelle.replace('    const standVor = vorpostenLagerStand(doc, jetzt);', '    const standVor = {};');
  }
  // Eine Sabotage, die NICHTS ersetzt, laesst einen unsabotierten Server laufen und belegt nichts.
  if (SAB) {
    const anRein = basis.replace(/const VP_UMRUESTEN_AKTIV = (true|false);/, 'const VP_UMRUESTEN_AKTIV = true;');
    const ausRein = basis.replace(/const VP_UMRUESTEN_AKTIV = (true|false);/, 'const VP_UMRUESTEN_AKTIV = false;');
    check('0d: die Sabotage „' + SAB + '" hat den Quelltext wirklich veraendert',
      anQuelle !== anRein || ausQuelle !== ausRein, { SAB });
  }

  // ---- 1. Der Schalter liegt: den Weg gibt es nicht ---------------------------------------------
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  fs.writeFileSync(QUELLE, ausQuelle);
  let api = await starteServer();
  let tokA = await api.anmelden('anna');
  let tokB = await api.anmelden('ben');
  api = await schreibeDb(d => { setzeDoc(d, vpDoc('aus-1', 8, 'festung')); });
  let r = await api.sende('/vorposten/umruesten', tokA, { system: 'aus-1', zweig: 'handel' });
  check('1a: mit liegendem Schalter antwortet der Endpunkt mit 404 und aendert nichts',
    r.status === 404 && r.body && r.body.inaktiv === true, { status: r.status, body: r.body });
  let g = await api.hole('/vorposten', tokA);
  check('1b: und die Liste sagt umruestenAktiv:false',
    g.body && g.body.umruestenAktiv === false, { aktiv: g.body && g.body.umruestenAktiv });
  await stoppeServer();

  // ---- 2. Die Riegel ---------------------------------------------------------------------------
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  fs.writeFileSync(QUELLE, anQuelle);
  api = await starteServer();
  tokA = await api.anmelden('anna');
  tokB = await api.anmelden('ben');
  api = await schreibeDb(d => {
    setzeDoc(d, vpDoc('zu-klein', abStufe - 1, 'festung'));
    setzeDoc(d, vpDoc('ohne-zweig', 8, null));
    setzeDoc(d, vpDoc('normal', 8, 'festung'));
    setzeDoc(d, vpDoc('im-abbau', 8, 'festung', { abbauAb: Date.now() + 3600000 }));
    setzeDoc(d, vpDoc('voll-modul', 8, 'festung', { module: [
      'kernpanzer:selten', 'geschuetz:selten', 'hangar:selten', 'sprungrechner:selten',
      'raffinerie:selten', 'horchposten:selten'] }));
    setzeDoc(d, vpDoc('mit-projekt', 8, 'werft', {
      projekte: [{ key: 'sternendock', fertigAb: Date.now() - 3600000 }], dockSeit: Date.now() - 3600000 }));
  });
  const zuKlein = await api.sende('/vorposten/umruesten', tokA, { system: 'zu-klein', zweig: 'handel' });
  check('2a: unter der Mindeststufe wird abgelehnt, mit der Stufe im Klartext',
    zuKlein.status === 400 && zuKlein.body.abStufe === abStufe, { status: zuKlein.status, body: zuKlein.body });
  const ohneZweig = await api.sende('/vorposten/umruesten', tokA, { system: 'ohne-zweig', zweig: 'handel' });
  check('2b: ohne bestehende Ausrichtung gibt es nichts umzuruesten',
    ohneZweig.status === 400 && ohneZweig.body.ohneZweig === true, { status: ohneZweig.status, body: ohneZweig.body });
  const gleich = await api.sende('/vorposten/umruesten', tokA, { system: 'normal', zweig: 'festung' });
  check('2c: dieselbe Ausrichtung noch einmal ist kein Vorhaben',
    gleich.status === 400 && gleich.body.schonSo === true, { status: gleich.status, body: gleich.body });
  const erfunden = await api.sende('/vorposten/umruesten', tokA, { system: 'normal', zweig: 'gibtsnicht' });
  check('2d: ein erfundener Zweig wird abgelehnt und die echten werden genannt',
    erfunden.status === 400 && erfunden.body.zweigNoetig === true && (erfunden.body.zweige || []).length === 3,
    { status: erfunden.status, zweige: (erfunden.body.zweige || []).map(z => z.key) });
  const fremd = await api.sende('/vorposten/umruesten', tokB, { system: 'normal', zweig: 'handel' });
  check('2e: ein Fremder kann den Vorposten nicht umruesten', fremd.status === 403, { status: fremd.status });

  // ---- 3. Der Start, und die Steckplatz-Ablehnung -----------------------------------------------
  const imAbbau = await api.sende('/vorposten/umruesten', tokA, { system: 'im-abbau', zweig: 'handel' });
  check('3c: eine Station, die abgebaut wird, wird nicht umgebaut',
    imAbbau.status === 400 && imAbbau.body.abbau === true, { status: imAbbau.status, body: imAbbau.body });
  /* DIE WICHTIGSTE ABLEHNUNG. Ein Festungsring hat sechs Steckplaetze, ein Handelsknoten fuenf -
     wegruesten mit sechs Modulen liesse eines wirkungslos zurueck und aus der Anzeige fallen. */
  const zuViele = await api.sende('/vorposten/umruesten', tokA, { system: 'voll-modul', zweig: 'handel' });
  check('3d: mit mehr Modulen als Ziel-Steckplaetzen wird abgelehnt - und gesagt, wie viele raus muessen',
    zuViele.status === 400 && zuViele.body.zuVieleModule === true
    && zuViele.body.module === 6 && zuViele.body.plaetze === 5
    && /Bau erst 1 aus/.test(String(zuViele.body.error)),
    { status: zuViele.status, body: zuViele.body });
  const start = await api.sende('/vorposten/umruesten', tokA, { system: 'normal', zweig: 'handel' });
  check('3a: der Start setzt Frist und Ziel und nennt die Kosten',
    start.status === 200 && start.body.umruestenAb > Date.now() && start.body.umruestenZiel === 'handel'
    && start.body.kosten && start.body.kosten.erz === kosten.erz,
    { status: start.status, body: start.body && { ab: start.body.umruestenAb, ziel: start.body.umruestenZiel } });
  const nochmal = await api.sende('/vorposten/umruesten', tokA, { system: 'normal', zweig: 'werft' });
  check('3b: ein zweiter Start nennt die Restzeit, statt das Ziel zu wechseln',
    nochmal.status === 400 && nochmal.body.laeuft === true && nochmal.body.umruestenZiel === 'handel',
    { status: nochmal.status, body: nochmal.body });

  // ---- 4. Die Frist: die Werte aendern sich NICHT vor dem Abschluss -----------------------------
  g = await api.hole('/vorposten', tokA);
  const laufend = vpVon(g.body.liste, 'normal');
  const unberuehrt = vpVon(g.body.liste, 'im-abbau');
  check('4-anker: beide Vorposten kommen in der Liste an', !!laufend && !!unberuehrt,
    { laufend: !!laufend, unberuehrt: !!unberuehrt });
  check('4a: waehrend der Frist gilt noch die ALTE Ausrichtung - Werte und Name unveraendert',
    !!laufend && laufend.zweig === 'festung' && laufend.umruestenZiel === 'handel'
    && laufend.verteidigung === unberuehrt.verteidigung && laufend.kern.lpMax === unberuehrt.kern.lpMax,
    { zweig: laufend && laufend.zweig, ziel: laufend && laufend.umruestenZiel,
      verteidigung: laufend && laufend.verteidigung, vergleich: unberuehrt && unberuehrt.verteidigung });
  const fremdSicht = await api.hole('/vorposten', tokB);
  const fuerBen = vpVon(fremdSicht.body.liste, 'normal');
  check('4b: und ein FREMDER sieht die laufende Umruestung - wie den Abbau',
    !!fuerBen && fuerBen.umruestenAb === laufend.umruestenAb && fuerBen.umruestenZiel === 'handel',
    { ab: fuerBen && fuerBen.umruestenAb, ziel: fuerBen && fuerBen.umruestenZiel });

  // ---- 5. Der Abschluss ------------------------------------------------------------------------
  const vorLpMax = laufend.kern.lpMax;
  api = await schreibeDb(d => {
    const a = liesDoc(d, 'normal'); a.umruestenAb = Date.now() - 1000; setzeDoc(d, a);
    const b = liesDoc(d, 'mit-projekt'); b.umruestenAb = Date.now() - 1000; b.umruestenZiel = 'festung'; setzeDoc(d, b);
  });
  await warte(4500);
  await stoppeServer();
  const nach = JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
  const docNach = liesDoc(nach, 'normal');
  const projNach = liesDoc(nach, 'mit-projekt');
  const belohnungen = (nach.private[ANNA].__pendingRewards || []);
  const meldung = belohnungen.find(x => x.type === 'vorposten-umruestung' && x.system === 'normal') || null;
  check('5-anker: der Tick hat beide Umruestungen abgeschlossen',
    !!docNach && !docNach.umruestenAb && !!projNach && !projNach.umruestenAb,
    { normal: docNach && docNach.zweig, projekt: projNach && projNach.zweig });
  check('5a: die Ausrichtung ist gewechselt, und der Besitzer bekommt eine eigene Meldung mit BEIDEN Namen',
    !!docNach && docNach.zweig === 'handel' && !!meldung
    && meldung.vonZweig === 'festung' && meldung.zweig === 'handel'
    && !!meldung.vonZweigName && !!meldung.zweigName,
    { zweig: docNach && docNach.zweig, meldung });
  check('5b: das Kern-Dach ist auf den neuen Zweig gefallen, und die LP wurden mit gedeckelt - nicht geheilt',
    !!docNach && docNach.kern.lpMax < vorLpMax && docNach.kern.lp <= docNach.kern.lpMax,
    { vorher: vorLpMax, nachher: docNach && docNach.kern.lpMax, lp: docNach && docNach.kern.lp });
  /* 5c: DAS PROJEKT SCHLAEFT, ES STIRBT NICHT. Der Eintrag bleibt im Dokument; nur seine Wirkung
     haengt seit V6 an Projekt UND Ausrichtung. Wer zurueckruestet, hat sein Sternendock wieder. */
  check('5c: ein zweiggebundenes Projekt bleibt im Dokument stehen, wenn der Zweig wechselt',
    !!projNach && (projNach.projekte || []).some(p => p && p.key === 'sternendock'),
    { zweig: projNach && projNach.zweig, projekte: projNach && (projNach.projekte || []).map(p => p && p.key) });
  /* 5d: Das Lager wird VOR dem Wechsel abgerechnet - der Satz haengt am Zweig. Ohne diese
     Abrechnung waeren die Stunden davor rueckwirkend zum neuen Satz bewertet. */
  const lagerMeldung = belohnungen.find(x => x.type === 'vorposten-lager' && x.system === 'normal') || null;
  check('5d: das Lager wurde VOR dem Wechsel abgerechnet',
    !!lagerMeldung && (lagerMeldung.erz > 0 || lagerMeldung.kristalle > 0 || lagerMeldung.deuterium > 0),
    { meldung: lagerMeldung });

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

/* GEGENPROBE, fuenf Richtungen (jeweils KEPLER_VPUMR_SABOTAGE=<name> setzen).

   schalter    Die Schalterpruefung im Endpunkt entfernt          -> 1a faellt.
               Ein Schalter, der nur die ANZEIGE gattert, ist kein Schalter - er muss an der Stelle
               stehen, die die Wahl AUSFUEHRT (teuer gelernt am Projekt-Endpunkt, 04.09.2026).
   module      Die Steckplatz-Ablehnung ausgehebelt               -> 3d faellt.
               Danach liesse eine Umruestung weg vom Festungsring ein eingebautes Modul wirkungslos
               zurueck und aus der Anzeige fallen.
   sofort      Der Zweig wird schon beim START gesetzt            -> 4a, 5a UND 5b fallen.
               Das ist die ganze Frist: Wer eine Festung bestellt, hat 24 Stunden lang die alte
               Verteidigung, und der Angreifer, der es sieht, hat genau dieses Fenster. 5a und 5b
               fallen als Folge mit - der Tick meldet dann den falschen Ausgangszweig, und das
               Kern-Dach ist schon vor der Vergleichsmessung gefallen.
   projektweg  Der Tick loescht zweiggebundene Projekte           -> 5c faellt.
   lager       Der Tick rechnet das Lager nicht ab                -> 5d faellt.
*/
