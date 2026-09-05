// Ein eigener Name fuer den Vorposten (Etappe V9, Backend-Haelfte, 05.09.2026).
//
//   node tests/test_vorposten_name_http.js
//
// Bis hierher hiess jeder Vorposten nach Stufe und Zweig - „Sternenfestung", „Sternenmarkt". Das
// sagt, WAS er ist, nie WELCHER er ist. Ein selbst vergebener Name macht aus einer Zahlenkarte
// einen Ort.
//
// FUENF DINGE SIND DIE MECHANIK, und alle fuenf werden hier gemessen:
//   1. DER STUFENNAME BLEIBT   - `name` ist weiter „Sternenfestung", der eigene Name kommt als
//                                EIGENES Feld daneben (3b). Die Stufe ist die Information, die ein
//                                Angreifer braucht; sie darf nicht verschwinden.
//   2. TEXT VOR ANDEREN        - also gilt die Stummschaltung, fail-closed (2d).
//   3. LOESCHEN GEHT IMMER     - ohne Stufenschwelle, ohne Stummschaltung, ohne Abklingzeit (4a).
//                                Wer seinen eigenen Text zurueckninmt, missbraucht nichts.
//   4. DIE ABKLINGZEIT BREMST DEN WECHSEL, nicht die erste Taufe (3a gegen 3d).
//   5. DER ADMIN KANN IHN ENTFERNEN, im selben Handgriff mit einer Stummschaltung - und die
//                                Abklingzeit laeuft dabei NICHT neu an (5b), sonst waere die
//                                Loeschung zugleich ein Geschenk.
//
// Gegenprobe: siehe Fuss der Datei.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3265;
const QUELLE = path.join(WURZEL, 'server_vpname_tmp.js');
const SAB = process.env.KEPLER_VPNAME_SABOTAGE || '';
/* Was bei welcher Sabotage fallen MUSS - GEMESSEN, nicht geschaetzt, einschliesslich der
   MITLAEUFER. Vier Sabotagen reissen Pruefungen mit, und jedes Mal ist das eine Folge:
     muster      Der in 2c abgewiesene Name geht durch -> die Station traegt danach einen Namen UND
                 eine laufende Abklingzeit; 3a laeuft in die Frist, 3b/3c/4c haengen daran.
     stumm       Dasselbe ueber 2d: der Name steht schon, 3a meldet „schonSo", 4c liest 3a.
     saeuberung  Der ungetrimmte Name faellt durchs Muster -> 3a wird abgelehnt, 3b/3c folgen.
     loeschsperre 4a loescht nicht mehr, also findet 4b noch etwas zu loeschen. */
const MUSS_FALLEN = { schalter: ['1a'], stufe: ['2a'], muster: ['2c', '3a', '3b', '3c', '4c'],
  stumm: ['2d', '3a', '4c'], abkling: ['3d'], loeschsperre: ['4a', '4b'],
  saeuberung: ['4c', '3a', '3b', '3c'], adminfrist: ['5b'], meldung: ['6a'] };

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
const ADMIN = crypto.randomUUID();  // gamegeeeeek (Admin-Konto dieses Projekts)
const dbPfad = path.join(os.tmpdir(), 'kepler-vpname-' + process.pid + '.json');
let srv = null;

const save = (id, name) => ({ resources: { energie: 5e6, erz: 5e6, kristalle: 5e6, deuterium: 5e6 },
  buildings: {}, research: {}, colonies: {}, fleet: { missions: [] },
  player: { id, name }, credits: 9000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now() });
function grunddb() {
  return {
    users: {
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: Date.now() },
      // Das Admin-Konto dieses Projekts heisst `gamegeeeeek` (CLAUDE.md).
      gamegeeeeek: { userId: ADMIN, username: 'gamegeeeeek', passwordHash: hash, createdAt: Date.now() }
    },
    private: {
      [ANNA]: { 'kepler7-save-v3': JSON.stringify(save(ANNA, 'anna')) },
      [BEN]:  { 'kepler7-save-v3': JSON.stringify(save(BEN, 'ben')) },
      [ADMIN]:{ 'kepler7-save-v3': JSON.stringify(save(ADMIN, 'gamegeeeeek')) }
    },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {}, wrackKonvois: [], a2Verlauf: [] }
  };
}
const vpDoc = (sys, stufe, extra) => Object.assign({ id: 'vp_' + crypto.randomUUID(), sys,
  besitzer: ANNA, besitzerName: 'anna', seit: Date.now() - 30 * 24 * 3600 * 1000,
  stufe, zweig: stufe >= 4 ? 'festung' : null, kern: { lp: 300000, lpMax: 300000 },
  garnison: {}, garnisonVon: {}, schlaege: {}, beitraege: {}, module: [], projekte: [],
  ausbauSeit: Date.now() - 13 * 3600 * 1000, lagerSeit: Date.now() - 1 * 3600 * 1000,
  kampfverlauf: [] }, extra || {});

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
  const abStufe = Number((roh.match(/const VP_NAME_AB_STUFE = (\d+);/) || [])[1]);
  const maxLen = Number((roh.match(/const VP_NAME_MAX = (\d+);/) || [])[1]);
  const abklingRoh = (roh.match(/const VP_NAME_ABKLING_MS = ([^;]+);/) || [])[1];
  const musterRoh = (roh.match(/const VP_NAME_MUSTER = (\/.*\/);/) || [])[1];
  const schalter = (roh.match(/const VP_NAME_AKTIV = (\w+);/) || [])[1];
  check('0a: Schwelle, Laenge, Frist und Muster stehen im Quelltext',
    abStufe >= 2 && maxLen >= 12 && !!abklingRoh && !!musterRoh,
    { abStufe, maxLen, abkling: abklingRoh, muster: musterRoh });
  /* 0b HAT SEINE RICHTUNG GEWECHSELT (05.09.2026) - wie zuvor bei den Modul-Sets und der
     Umruestung. Bis zum Umlegen stand hier „der Schalter ist false": die Wache ueber die
     Auslieferungsreihenfolge (ein Server, der Namen fuehrt, die niemand sieht und niemand melden
     kann, waere kein Nutzen, sondern eine Falle). Sie ist eingehalten, das Spiel zeigt und bedient
     den Namen seit v8.686.0, und ab jetzt waere ein zurueckgefallener Schalter der Fehler.
     Die beiden Laeufe unten erzwingen ihren Zustand ohnehin SELBST (ausQuelle/anQuelle) - ohne
     diese Bauart haette genau dieser Commit den Aus-Lauf still in einen zweiten An-Lauf
     verwandelt. */
  check('0b: der Schalter steht ausgeliefert auf true - die Frontend-Haelfte ist live',
    schalter === 'true', { gefunden: schalter });
  /* Das Muster darf NICHT `NAME_MUSTER` sein: Das gehoert den Konten und kennt kein Leerzeichen.
     Ein Stationsname mit zwei Woertern ist der Fall, fuer den es diese Etappe gibt. */
  const muster = new RegExp(musterRoh.slice(1, -1));
  check('0c: das Muster ist ein EIGENES - es laesst mehrere Woerter zu und ist nicht das Kontomuster',
    muster.test('Roter Hafen') && !/const VP_NAME_MUSTER = NAME_MUSTER/.test(roh),
    { zweiWoerter: muster.test('Roter Hafen') });
  check('0d: es weist ab, was in einer Liste stoeren wuerde: zu kurz, zu lang, fuehrende Satzzeichen',
    !muster.test('ab') && !muster.test('A'.repeat(maxLen + 1)) && !muster.test('-Hafen')
    && muster.test('A'.repeat(maxLen)) && muster.test('Wächter Öst'),
    { kurz: muster.test('ab'), lang: muster.test('A'.repeat(maxLen + 1)), satzzeichen: muster.test('-Hafen') });

  const basis = roh.replace(/const VORPOSTEN_AKTIV = (true|false);/, 'const VORPOSTEN_AKTIV = true;')
    .replace(/setInterval\(galaxyTick, 15 \* 60 \* 1000\)/, 'setInterval(galaxyTick, 1500)');
  let ausQuelle = basis.replace(/const VP_NAME_AKTIV = (true|false);/, 'const VP_NAME_AKTIV = false;');
  let anQuelle = basis.replace(/const VP_NAME_AKTIV = (true|false);/, 'const VP_NAME_AKTIV = true;');
  if (SAB === 'schalter') {
    ausQuelle = ausQuelle.replace("  if (!VP_NAME_AKTIV || notAusGesetzt('vorposten')) {\n    return res.status(404).json({ error: 'Vorposten benennen ist derzeit nicht verfügbar.', inaktiv: true });\n  }", '');
  }
  if (SAB === 'stufe') {
    anQuelle = anQuelle.replace('  if ((doc.stufe || 1) < VP_NAME_AB_STUFE) {', '  if (false) {');
  }
  if (SAB === 'muster') {
    anQuelle = anQuelle.replace('  if (!vpNameOk(name)) {', '  if (false) {');
  }
  if (SAB === 'stumm') {
    anQuelle = anQuelle.replace("  if (stummAktiv(userN)) return res.status(403).json({ error: stummText(userN), stumm: true });", '');
  }
  if (SAB === 'abkling') {
    anQuelle = anQuelle.replace('  if (doc.eigenName && jetztN < freiAb) {', '  if (false) {');
  }
  /* Der Loesch-Zweig wandert HINTER Stufe, Stummschaltung und Abklingzeit - genau die Reihenfolge,
     die jemanden an einem Namen festhaelt, den er zuruecknehmen will. */
  if (SAB === 'loeschsperre') {
    const block = anQuelle.match(/  if \(!name\) \{[\s\S]*?\n  \}\n/)[0];
    anQuelle = anQuelle.replace(block, '');
    anQuelle = anQuelle.replace('  doc.eigenName = name;\n  doc.nameSeit = jetztN;', block + '  doc.eigenName = name;\n  doc.nameSeit = jetztN;');
  }
  if (SAB === 'saeuberung') {
    anQuelle = anQuelle.replace("  return String(roh || '').replace(/[\\u0000-\\u001f\\u007f-\\u009f]/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, VP_NAME_MAX);",
      "  return String(roh || '').slice(0, VP_NAME_MAX);");
  }
  if (SAB === 'adminfrist') {
    anQuelle = anQuelle.replace("  const war = doc.eigenName;\n  delete doc.eigenName;",
      "  const war = doc.eigenName;\n  delete doc.eigenName;\n  delete doc.nameSeit;");
  }
  if (SAB === 'meldung') {
    anQuelle = anQuelle.replace("        type: 'vorposten-abbau', system: doc.sys, stufe: doc.stufe || 1, name: st.name,\n        eigenName: doc.eigenName || null,",
      "        type: 'vorposten-abbau', system: doc.sys, stufe: doc.stufe || 1, name: st.name,");
  }
  // Eine Sabotage, die NICHTS ersetzt, laesst einen unsabotierten Server laufen und belegt nichts.
  if (SAB) {
    const anRein = basis.replace(/const VP_NAME_AKTIV = (true|false);/, 'const VP_NAME_AKTIV = true;');
    const ausRein = basis.replace(/const VP_NAME_AKTIV = (true|false);/, 'const VP_NAME_AKTIV = false;');
    check('0e: die Sabotage „' + SAB + '" hat den Quelltext wirklich veraendert',
      anQuelle !== anRein || ausQuelle !== ausRein, { SAB });
  }

  // ---- 1. Der Schalter liegt: den Weg gibt es nicht ---------------------------------------------
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  fs.writeFileSync(QUELLE, ausQuelle);
  let api = await starteServer();
  let tokA = await api.anmelden('anna');
  api = await schreibeDb(d => { setzeDoc(d, vpDoc('aus-1', 6)); });
  let r = await api.sende('/vorposten/name', tokA, { system: 'aus-1', name: 'Roter Hafen' });
  let nachAus = JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
  check('1a: mit liegendem Schalter antwortet der Endpunkt mit 404 und aendert nichts',
    r.status === 404 && r.body && r.body.inaktiv === true && !liesDoc(nachAus, 'aus-1').eigenName,
    { status: r.status, body: r.body });
  let g = await api.hole('/vorposten', tokA);
  check('1b: und die Liste sagt nameAktiv:false',
    g.body && g.body.nameAktiv === false, { aktiv: g.body && g.body.nameAktiv });
  await stoppeServer();

  // ---- 2. Die Riegel ---------------------------------------------------------------------------
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  fs.writeFileSync(QUELLE, anQuelle);
  api = await starteServer();
  tokA = await api.anmelden('anna');
  let tokB = await api.anmelden('ben');
  let tokAdmin = await api.anmelden('gamegeeeeek');
  api = await schreibeDb(d => {
    setzeDoc(d, vpDoc('zu-klein', abStufe - 1));
    setzeDoc(d, vpDoc('normal', 6));
    setzeDoc(d, vpDoc('stumm-test', 6, { eigenName: 'Altname', nameSeit: Date.now() - 99 * 3600 * 1000 }));
    setzeDoc(d, vpDoc('admin-test', 6, { eigenName: 'Schimpfwort', nameSeit: Date.now() - 1000 }));
    setzeDoc(d, vpDoc('abbau-test', 6, { eigenName: 'Bastion', nameSeit: Date.now() - 99 * 3600 * 1000,
      abbauAb: Date.now() - 1000 }));
  });
  const zuKlein = await api.sende('/vorposten/name', tokA, { system: 'zu-klein', name: 'Roter Hafen' });
  check('2a: unter der Mindeststufe wird abgelehnt, mit der Stufe im Klartext',
    zuKlein.status === 400 && zuKlein.body.abStufe === abStufe, { status: zuKlein.status, body: zuKlein.body });
  const fremd = await api.sende('/vorposten/name', tokB, { system: 'normal', name: 'Meins jetzt' });
  check('2b: ein Fremder kann den Vorposten nicht benennen', fremd.status === 403, { status: fremd.status });
  const kaputt = await api.sende('/vorposten/name', tokA, { system: 'normal', name: '-<script>' });
  check('2c: ein Name, der dem Muster nicht genuegt, wird abgelehnt',
    kaputt.status === 400 && kaputt.body.musterFehlt === true, { status: kaputt.status, body: kaputt.body });

  // ---- 2d/4a: die Stummschaltung, und was sie NICHT verhindert ----------------------------------
  api = await schreibeDb(d => { d.users.anna.stummBis = Date.now() + 3600000; d.users.anna.stummGrund = 'Test'; });
  const stumm = await api.sende('/vorposten/name', tokA, { system: 'normal', name: 'Roter Hafen' });
  check('2d: wer stumm ist, taufte sonst dieselbe Zeile vor dieselben Leute - abgelehnt',
    stumm.status === 403 && stumm.body.stumm === true, { status: stumm.status, body: stumm.body });
  /* 4a: LOESCHEN GEHT TROTZDEM - und zwar hier gleich doppelt gesperrt: Anna ist stumm UND die
     Abklingzeit der Station laeuft (nameSeit ist eben erst gesetzt worden). Wer seinen eigenen
     Text zuruecknimmt, missbraucht nichts. */
  const loeschStumm = await api.sende('/vorposten/name', tokA, { system: 'stumm-test', name: '' });
  let nachLoesch = null;
  api = await schreibeDb(d => { nachLoesch = liesDoc(d, 'stumm-test'); delete d.users.anna.stummBis; });
  check('4a: loeschen geht auch stumm - ohne Stufenschwelle, ohne Stummschaltung, ohne Frist',
    loeschStumm.status === 200 && loeschStumm.body.geloescht === true
    && loeschStumm.body.eigenName === null && !nachLoesch.eigenName,
    /* Nur die drei Felder, nicht die ganze Antwort: `vorposten` haengt vollstaendig daran, und ein
       Beleg, den niemand liest, ist keiner. */
    { status: loeschStumm.status, geloescht: loeschStumm.body && loeschStumm.body.geloescht,
      gemeldet: loeschStumm.body && loeschStumm.body.eigenName, doc: nachLoesch && nachLoesch.eigenName });
  const leer = await api.sende('/vorposten/name', tokA, { system: 'stumm-test', name: '' });
  check('4b: ein zweites Loeschen sagt, dass es nichts zu loeschen gibt',
    leer.status === 400 && leer.body.schonLeer === true, { status: leer.status, body: leer.body });

  // ---- 3. Die Taufe ----------------------------------------------------------------------------
  const taufe = await api.sende('/vorposten/name', tokA, { system: 'normal', name: '  Roter\tHafen  ' });
  check('3a: die erste Taufe geht durch und nennt, wann der naechste Wechsel moeglich ist',
    taufe.status === 200 && taufe.body.eigenName === 'Roter Hafen' && taufe.body.nameFreiAb > Date.now(),
    { status: taufe.status, body: taufe.body && { name: taufe.body.eigenName, frei: taufe.body.nameFreiAb } });
  /* 4c: DIE SAEUBERUNG. Tabulator und doppelte Leerzeichen kommen sonst durch das Muster und
     stehen danach zerrissen in der Karte. Gemessen am ERGEBNIS, nicht an der Funktion. */
  check('4c: Steuerzeichen und doppelter Weissraum werden vorher zusammengezogen',
    taufe.body.eigenName === 'Roter Hafen', { gespeichert: taufe.body && taufe.body.eigenName });
  g = await api.hole('/vorposten', tokA);
  const fremdSicht = await api.hole('/vorposten', tokB);
  const meins = vpVon(g.body.liste, 'normal');
  const fuerBen = vpVon(fremdSicht.body.liste, 'normal');
  check('3b: der eigene Name steht NEBEN dem Stufennamen und ist fuer jeden sichtbar - die Frist nur fuer den Besitzer',
    !!meins && meins.eigenName === 'Roter Hafen' && meins.name !== 'Roter Hafen' && meins.name.length > 3
    && !!fuerBen && fuerBen.eigenName === 'Roter Hafen' && fuerBen.nameFreiAb === undefined
    && meins.nameFreiAb > Date.now(),
    { eigen: meins && meins.eigenName, stufe: meins && meins.name,
      fremdSiehtNamen: fuerBen && fuerBen.eigenName, fremdSiehtFrist: fuerBen && fuerBen.nameFreiAb });
  const nochmal = await api.sende('/vorposten/name', tokA, { system: 'normal', name: 'Roter Hafen' });
  check('3c: derselbe Name noch einmal ist keine Taufe',
    nochmal.status === 400 && nochmal.body.schonSo === true, { status: nochmal.status, body: nochmal.body });
  const zuFrueh = await api.sende('/vorposten/name', tokA, { system: 'normal', name: 'Blauer Hafen' });
  check('3d: der Wechsel innerhalb der Frist wird abgelehnt und nennt, wann es geht',
    zuFrueh.status === 429 && zuFrueh.body.abklingzeit === true && zuFrueh.body.nameFreiAb > Date.now(),
    { status: zuFrueh.status, body: zuFrueh.body });

  // ---- 5. Der Admin ----------------------------------------------------------------------------
  const adminWeg = await api.sende('/admin/vorposten/name-loeschen', tokAdmin,
    { system: 'admin-test', stummStunden: 24, grund: 'Test' });
  let adminDoc = null, adminUser = null;
  api = await schreibeDb(d => { adminDoc = liesDoc(d, 'admin-test'); adminUser = d.users.anna; });
  check('5a: der Admin entfernt den Namen und schaltet den Besitzer im selben Handgriff stumm',
    adminWeg.status === 200 && adminWeg.body.war === 'Schimpfwort' && !adminDoc.eigenName
    && adminUser.stummBis > Date.now(),
    { body: adminWeg.body, doc: adminDoc && adminDoc.eigenName, stummBis: adminUser && adminUser.stummBis });
  /* 5b: `nameSeit` BLEIBT. Sonst waere die Loeschung durch den Admin zugleich ein Geschenk - die
     Abklingzeit finge von vorn an und der Besitzer taufte sofort neu. */
  check('5b: die Abklingzeit laeuft dabei NICHT neu an - sonst waere die Loeschung ein Geschenk',
    !!adminDoc && typeof adminDoc.nameSeit === 'number' && adminDoc.nameSeit > 0,
    { nameSeit: adminDoc && adminDoc.nameSeit });

  // ---- 6. Der Name reist in den Meldungen mit ---------------------------------------------------
  await warte(4500);
  await stoppeServer();
  const nach = JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
  const belohnungen = (nach.private[ANNA].__pendingRewards || []);
  const abbau = belohnungen.find(x => x.type === 'vorposten-abbau' && x.system === 'abbau-test') || null;
  check('6-anker: der Abbau-Tick hat die Station wirklich abgetragen (sonst misst 6a nichts)',
    !liesDoc(nach, 'abbau-test'), { docDanach: !!liesDoc(nach, 'abbau-test') });
  check('6a: die Meldung nennt BEIDE Namen - den eigenen und den der Stufe',
    !!abbau && abbau.eigenName === 'Bastion' && !!abbau.name && abbau.name !== 'Bastion',
    { meldung: abbau && { eigen: abbau.eigenName, stufe: abbau.name } });

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

/* GEGENPROBE, neun Richtungen (jeweils KEPLER_VPNAME_SABOTAGE=<name> setzen).

   schalter     Die Schalterpruefung im Endpunkt entfernt        -> 1a faellt.
                Ein Schalter, der nur die ANZEIGE gattert, ist kein Schalter - er muss an der
                Stelle stehen, die die Handlung AUSFUEHRT (teuer gelernt am Projekt-Endpunkt).
   stufe        Die Stufenschwelle ausgehebelt                   -> 2a faellt.
   muster       Die Musterpruefung ausgehebelt                   -> 2c faellt.
                Ohne sie stuende beliebiger Text auf der Karte.
   stumm        Die Stummschaltung im Endpunkt entfernt          -> 2d faellt.
                Ein Name ist Text vor anderen; wer stumm ist, stellte sonst denselben Satz vor
                dieselben Leute, den ihm der Chat gerade verwehrt.
   abkling      Die Abklingzeit ausgehebelt                      -> 3d faellt.
   loeschsperre Der Loesch-Zweig wandert HINTER Stufe, Stummschaltung und Abklingzeit -> 4a faellt.
                Genau die Reihenfolge, die jemanden an einem Namen festhaelt, den er zuruecknehmen
                will - eine Sperre, die Schaden anrichtet statt ihn zu verhindern.
   saeuberung   vpNameSauber schneidet nur noch ab               -> 4c faellt.
                Tabulator und doppelte Leerzeichen kaemen durch das Muster und stuenden danach
                zerrissen in der Karte.
   adminfrist   Die Admin-Loeschung entfernt auch `nameSeit`     -> 5b faellt.
                Die Loeschung waere zugleich ein Geschenk: Die Abklingzeit finge von vorn an.
   meldung      `eigenName` fehlt in der Abbau-Meldung           -> 6a faellt.
                Der Name muss die Station ueberleben - beim Abbau gibt es sie nicht mehr, und der
                Client kann ihn nirgends nachschlagen.
*/
