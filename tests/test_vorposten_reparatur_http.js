// Die Reparatur des Vorposten-Kerns (Etappe V10, 14.09.2026).
//
// Bis hierher war jeder Treffer am Kern endgueltig; die einzige Erholung waere der Ausbau gewesen,
// und der heilt ausdruecklich NICHT. Diese Etappe gibt dem Besitzer einen EIGENEN, bezahlten Weg:
// Geheilt wird aus dem Lager derselben Station, 1 Rohstoff = 1 LP.
//
// DREI DINGE SIND DIE GANZE MECHANIK, und alle drei werden hier gemessen:
//   1. DIE SPERRE - abgeleitet aus VORPOSTEN_ABKLING_MS, keine zweite Zahl (Abschnitt 5). Sie ist
//      der einzige wirksame Hebel der Balance: Ein belagerter Vorposten heilt gar nicht, weil die
//      erste erlaubte Reparatur mit dem naechsten erlaubten Schlag zusammenfaellt (5c).
//   2. DER TEILVERBRAUCH - der Lagerstand ist GERECHNET, nicht gespeichert; Verbrauch heisst,
//      `lagerSeit` nach vorn zu schieben. Der Reststand wird NACHGEMESSEN, nicht nachgerechnet
//      (Abschnitt 2). Das ist die Stelle, an der ein Rechenfehler Rohstoffe erzeugt oder frisst.
//   3. DER SERVER RECHNET DEN BETRAG - kein Kampf- oder Mengenparameter aus dem Request (2e).
//
// DAZU EINE REGEL UEBER DIE AUSKUNFT (seit 14.09.2026, Abschnitt 4d/4e): Ein Lager mit Inhalt wird
// NIE als leer gemeldet. Weil jeder der drei Rohstoffe einzeln abgerundet wird, kann bei genau
// einem fehlenden Lebenspunkt nichts entnehmbar sein, obwohl das Lager voll ist - die Antwort
// nennt dann ihren eigenen Grund (`zuWenig`) statt „hier liegt nichts" (`leer`).
//
// Gegenprobe: siehe Fuss der Datei.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3278;
const QUELLE = path.join(WURZEL, 'server_vprep_tmp.js');
const SAB = process.env.KEPLER_VPREP_SABOTAGE || '';
/* WAS BEI WELCHER SABOTAGE FALLEN MUSS. GEMESSEN am 14.09.2026, jede Liste aus dem Lauf selbst - nicht geschaetzt. Drei Beobachtungen
   dazu, die man beim naechsten Anfassen kennen sollte:
   - `kostenlos` und `altstempel` fallen IDENTISCH: Beide lassen den Lagerstand stehen, der eine
     durch Nichtstun, der andere durch einen Schub, der ueber dem Deckel nichts bewirkt. Dass der
     zweite genauso auffaellt wie der erste, ist der eigentliche Zweck von 2c.
   - `ohnedeckel` reisst 1b mit, nicht erst 2b: Schon die VORSCHAU nennt dann die falschen Kosten -
     genau so soll es sein, denn sie ist dieselbe Rechnung.
   - `griff` reisst 7a UND 7b mit: Beide Wege, die Reparatur zu schliessen, laufen ueber denselben
     Riegel am ausfuehrenden Endpunkt.
   - `ohnesperre` reisst 5d mit, und das ist Folge, kein Nebenschaden: Ohne durchgesetzte Sperre ist
     der Kern schon bei 5a wieder voll, und 5d findet nichts mehr zu heilen.
   - `ohnedeckel` und `leerdurch` reissen 4d mit, und beide zu Recht: Wer immer das GANZE Lager
     nimmt, hat auch im knappen Fenster genug zusammen und repariert (200 statt 400); wer den
     Riegel ganz herausnimmt, laesst die Reparatur mit heilung 0 durchlaufen. Beides ist genau der
     Zustand, den 4d ausschliesst - eine Antwort, die nicht zum Lagerstand passt.
   - `eingrund` faellt NUR auf 4d, nicht auf 4c oder 4e: Das ist der Beleg, dass die Trennung der
     beiden Gruende gemessen wird und nicht der Riegel als solcher (den messen 4c und `leerdurch`).
   - `sperre` und `ohnesperre` sind ZWEI verschiedene Fehler und brauchen beide ihre Probe: Der eine
     rechnet die Frist falsch (5b/5c), der andere setzt sie gar nicht durch (5a). `sperre` allein
     laesst 5a gruen, weil auch seine 60 Sekunden im Messmoment noch nicht abgelaufen sind. */
const MUSS_FALLEN = {
  besitzer: ['4a'],
  sperre: ['5b', '5c'],
  kostenlos: ['2c', '3b'],
  vollverbrauch: ['2c'],
  altstempel: ['2c', '3b'],
  ohnedeckel: ['1b', '2b', '2c', '4d'],
  griff: ['7a', '7b'],
  persistenz: ['6a'],
  ohnesperre: ['5a', '5b', '5c', '5d'],
  volldurch: ['4b'],
  leerdurch: ['4c', '4d'],
  betrag: ['1c', '2a', '2b', '2e'],
  eingrund: ['4d']
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
const ANNA = crypto.randomUUID();   // Besitzerin
const BEN = crypto.randomUUID();    // Angreifer
const dbPfad = path.join(os.tmpdir(), 'kepler-vprep-' + process.pid + '.json');
const FLOTTE = { cruisers: 3000, destroyers: 2000, jaeger: 4000, schlachtschiff: 800 };
let srv = null;

const save = (id, name) => ({ resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
  buildings: {}, research: {}, colonies: {}, fleet: Object.assign({ missions: [] }, FLOTTE),
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
    shared: {}, resetTokens: {}, notAus: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {}, wrackKonvois: [], a2Verlauf: [] }
  };
}
const vpDoc = (sys, stufe, lp, extra) => Object.assign({ id: 'vp_' + crypto.randomUUID(), sys,
  besitzer: ANNA, besitzerName: 'anna', seit: Date.now() - 30 * 24 * 3600 * 1000,
  stufe, zweig: null, kern: { lp, lpMax: lp }, garnison: {}, schlaege: {}, beitraege: {},
  ausbauSeit: Date.now() - 13 * 3600 * 1000, kampfverlauf: [] }, extra || {});
const angriffMission = (id, sys) => ({ id, type: 'vorposten-angriff', targetId: sys, system: sys,
  startTime: Date.now() - 7200000, endTime: Date.now() - 3600000, fleetName: 'Flotte 1', composition: Object.assign({}, FLOTTE) });

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
async function aendereDb(fn) {
  await stoppeServer();
  const d = JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
  fn(d);
  fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
  return starteServer();
}
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const liesDoc = (d, sys) => JSON.parse(d.shared['vorposten:' + sys]);
const schreibDoc = (d, doc) => { d.shared['vorposten:' + doc.sys] = JSON.stringify(doc); };
const liesSave = (d, uid) => { const r = d.private[uid]['kepler7-save-v3']; return JSON.parse(typeof r === 'string' ? r : r.value); };
const schreibSave = (d, uid, sv) => { const r = d.private[uid]['kepler7-save-v3']; const t = JSON.stringify(sv);
  d.private[uid]['kepler7-save-v3'] = (r && typeof r === 'object') ? { value: t, version: (r.version || 0) + 1 } : t; };

(async () => {
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  /* ANKER AUS DEM QUELLTEXT - Leiter, Deckel, Foerderanteile und Abklingzeit. Nichts davon aus der
     Antwort, die geprueft werden soll. */
  const leiter = [...roh.matchAll(/\{ stufe: (\d), name: '[^']*',\s*kernLp: (\d+),[^}]*lager: (\d+),/g)]
    .map(m => ({ stufe: Number(m[1]), kernLp: Number(m[2]), lager: Number(m[3]) }));
  const stundenDeckel = Number((roh.match(/const VP_LAGER_STUNDEN = (\d+);/) || [])[1]);
  const anteile = JSON.parse((roh.match(/const VP_LAGER_ANTEILE = (\{[^}]*\});/) || [])[1]
    .replace(/([a-z]+):/g, '"$1":'));
  const summeAnteile = anteile.erz + anteile.kristalle + anteile.deuterium;
  const abklingH = Number((roh.match(/const VORPOSTEN_ABKLING_MS = (\d+) \* 3600 \* 1000;/) || [])[1]);
  const rateAus = (lagerWert) => {
    const aus = {};
    for (const k of Object.keys(anteile)) aus[k] = Math.round(lagerWert * anteile[k] / summeAnteile);
    return aus;
  };
  const rateVon = (stufe) => rateAus(leiter[stufe - 1].lager);
  const proStunde = (stufe) => Object.values(rateVon(stufe)).reduce((a, b) => a + b, 0);
  check('0a: Leiter, Deckel, Foerderanteile und Abklingzeit sind im Quelltext auffindbar',
    leiter.length === 8 && stundenDeckel > 0 && summeAnteile > 0 && abklingH > 0
    && /const VORPOSTEN_REPARATUR_AKTIV = (true|false);/.test(roh),
    { stufen: leiter.length, stundenDeckel, abklingH });
  /* DIE SPERRE DARF KEINE ZWEITE ZAHL SEIN. Der Auftrag verlangt sie ABGELEITET von
     VORPOSTEN_ABKLING_MS; eine eigene Konstante daneben koennte sich davon loesen, und genau dann
     waere die Reparatur der Weg, eine Belagerung unendlich zu machen. Geprueft wird der Quelltext,
     nicht die Antwort: Eine zweite Zahl faellt hier auf, auch wenn sie HEUTE zufaellig denselben
     Wert traegt. */
  check('0d: es gibt keine eigene Reparatur-Abklingzeit im Quelltext - die Sperre ist abgeleitet',
    !/VORPOSTEN_REPARATUR_(ABKLING|SPERRE|WARTE)/.test(roh)
    && /gesperrtBis = letzterTreffer \? letzterTreffer \+ VORPOSTEN_ABKLING_MS : 0/.test(roh));

  let basis = roh.replace(/const VORPOSTEN_AKTIV = (true|false);/, 'const VORPOSTEN_AKTIV = true;')
    .replace(/const VP_LAGER_AKTIV = (true|false);/, 'const VP_LAGER_AKTIV = true;');
  /* DIE UNTERGRENZE IN DER KOPIE AUF NULL. Sie steht ausgeliefert auf dem Aktivierungs-Zeitstempel;
     dieser Test datiert `lagerSeit` aber zurueck, und gegen eine echte Untergrenze waere jeder
     dieser Staende null. Ohne diese Zeile pruefte der Test die AUSLIEFERUNG statt die Regel
     (dieselbe Lehre wie in test_vorposten_lager_http). */
  basis = basis.replace(/const VP_LAGER_AB = [^;]+;/, 'const VP_LAGER_AB = 0;');

  /* ---- Die Sabotagen. Jede stellt genau EINEN plausiblen Fehler her. -------------------------- */
  // Der Besitzerriegel faellt weg: jeder eingeloggte Nutzer repariert fremde Stationen.
  if (SAB === 'besitzer') basis = basis.replace(
    "  if (doc.besitzer !== req.userId) return res.status(403).json({ error: 'Nur der Besitzer kann hier reparieren.' });\n", '');
  // Die Sperre wird eine ZWEITE ZAHL statt einer Ableitung - genau der Fehler, den 0d verbietet.
  if (SAB === 'sperre') basis = basis.replace(
    'const gesperrtBis = letzterTreffer ? letzterTreffer + VORPOSTEN_ABKLING_MS : 0;',
    'const gesperrtBis = letzterTreffer ? letzterTreffer + 60000 : 0;');
  // Der Verbrauch wird nie gebucht: Rohstoffe aus dem Nichts, beliebig oft.
  if (SAB === 'kostenlos') basis = basis.replace(
    '  doc.lagerSeit = jetzt - Math.round(v.restStunden * 3600000);\n', '');
  // Vollverbrauch statt Teilverbrauch - der klassische Griff nach `lager/holen`.
  if (SAB === 'vollverbrauch') basis = basis.replace(
    'doc.lagerSeit = jetzt - Math.round(v.restStunden * 3600000);', 'doc.lagerSeit = jetzt;');
  /* Geschoben wird vom ALTEN Zeitstempel statt von JETZT. Sieht richtig aus und ist es unterhalb
     des Deckels auch - ueber dem Deckel senkt es den Stand ueberhaupt nicht, und die Reparatur ist
     gratis. Genau die Falle, vor der der Auftrag warnt. */
  if (SAB === 'altstempel') basis = basis.replace(
    'doc.lagerSeit = jetzt - Math.round(v.restStunden * 3600000);',
    'doc.lagerSeit = vorpostenLagerSeit(doc, jetzt) + Math.round((VP_LAGER_STUNDEN - v.restStunden) * 3600000);');
  // Es wird immer das GANZE Lager genommen, nicht nur so viel wie gebraucht.
  if (SAB === 'ohnedeckel') basis = basis.replace(
    'const wunsch = Math.min(fehlend, vorrat);', 'const wunsch = vorrat;');
  /* Das Schreiben auf die Platte faellt weg. Ohne Gegenprobe waere 6a eine Pruefung, die nie
     fallen kann - und damit keine. Alle Hintergrund-Speicherlaeufe dieses Servers takten in
     Minuten (kuerzester: 5 min), der gemessene Abschnitt dauert Sekunden: Es gibt in diesem
     Fenster keinen zweiten Schreiber, der den fehlenden `saveDb()` verdecken koennte. */
  if (SAB === 'persistenz') basis = basis.replace(
    '  doc.lagerSeit = jetzt - Math.round(v.restStunden * 3600000);\n  vorpostenSchreib(doc);\n  await saveDb();\n',
    '  doc.lagerSeit = jetzt - Math.round(v.restStunden * 3600000);\n  vorpostenSchreib(doc);\n');
  /* DIE SPERRE WIRD NICHT MEHR DURCHGESETZT - sie steht dann nur noch in der Anzeige. Ohne diese
     Gegenprobe belegte nichts, dass der ENDPUNKT waehrend der Abklingzeit wirklich ablehnt; die
     Sabotage `sperre` laesst 5a gruen, weil auch ihre 60 Sekunden noch nicht abgelaufen sind. */
  if (SAB === 'ohnesperre') basis = basis.replace('  if (v.gesperrt) {\n', '  if (false) {\n');
  // Der Riegel „Kern unversehrt" faellt weg.
  if (SAB === 'volldurch') basis = basis.replace('if (!(v.fehlend > 0)) return res.status(400)', 'if (false) return res.status(400)');
  // Der Riegel „Lager leer" faellt weg.
  if (SAB === 'leerdurch') basis = basis.replace('  if (!(v.heilung > 0)) {\n', '  if (false) {\n');
  /* DER BETRAG KOMMT AUS DEM REQUEST - genau die Hausregel-Verletzung, die 2e verbietet. Ohne diese
     Gegenprobe belegte nichts, dass 2e ueberhaupt etwas messen KANN. */
  if (SAB === 'betrag') basis = basis.replace(
    '  const v = vorpostenReparaturVorschau(doc, jetzt);\n',
    '  const v = vorpostenReparaturVorschau(doc, jetzt);\n  v.heilung = Number(req.body && req.body.menge) || v.heilung;\n');
  // Der Schalter am AUSFUEHRENDEN Endpunkt faellt weg (die Anzeige behaelt ihren).
  if (SAB === 'griff') basis = basis.replace(
    "  if (!VORPOSTEN_REPARATUR_AKTIV || notAusGesetzt('vorposten')) {\n    return res.status(404).json({ error: 'Reparaturen sind derzeit nicht verfügbar.', inaktiv: true });\n  }\n", '');
  /* DIE ZWEI GRUENDE WERDEN WIEDER EINER - der Stand vor dem 14.09.2026. Ein gefuelltes Lager, aus
     dem sich gerade kein GANZER Punkt loesen laesst, meldete sich dann wieder als „hier liegt
     nichts". Ohne diese Gegenprobe belegte 4d nichts: Sie ist die einzige Sabotage, die genau die
     alte, widerspruechliche Auskunft wiederherstellt. */
  if (SAB === 'eingrund') basis = basis.replace(
    "    if (v.vorrat > 0) {\n      return res.status(400).json({ error: 'Im Lager dieser Station liegt gerade zu wenig für einen ganzen Lebenspunkt - in ein paar Sekunden ist wieder genug da.', zuWenig: true });\n    }\n", '');
  /* 0c belegt, dass die verlangte Sabotage WIRKLICH gegriffen hat. Eine Ersetzung, die ins Leere
     greift, meldet keinen Fehler und saehe aus wie eine bestandene Gegenprobe (Lehre aus
     test_vorposten_endprojekte_http). */
  check('0c: die verlangte Sabotage hat den Quelltext wirklich veraendert',
    !SAB || basis !== roh.replace(/const VORPOSTEN_AKTIV = (true|false);/, 'const VORPOSTEN_AKTIV = true;')
      .replace(/const VP_LAGER_AKTIV = (true|false);/, 'const VP_LAGER_AKTIV = true;')
      .replace(/const VP_LAGER_AB = [^;]+;/, 'const VP_LAGER_AB = 0;'),
    { sabotage: SAB || '(keine)' });

  /* DIE STUFE 5 BEKOMMT IN DER KOPIE EIN WINZIGES LAGER (4 statt 11500). Der Fall, den 4d/4e
     messen, ist ein RUNDUNGSFENSTER: Es oeffnet und schliesst sich mit jeder Einheit Erz, die
     nachlaeuft. Bei den ausgelieferten Raten dauert eine Einheit Bruchteile einer Sekunde bis
     wenige Sekunden - ein HTTP-Test koennte den Zeitpunkt nicht zuverlaessig treffen und waere
     eine Wackelpruefung. Mit vier Einheiten Lager je Stunde dauert dasselbe Fenster acht Minuten,
     und der Test trifft es mit Minuten Reserve. Die REGEL haengt nicht an der Groesse der Rate:
     Sie sagt, dass ein Lager mit Inhalt nie als leer gemeldet wird - bei jeder Rate. Dieselbe
     Ueberlegung wie bei VP_LAGER_AB oben: Der Test stellt den Zustand her, den er messen will,
     statt auf ihn zu warten. Die Stufe 5 kommt in keiner anderen Pruefung dieser Datei vor. */
  const KNAPP_LAGER = 4;
  basis = basis.replace(/(\{ stufe: 5,[^}]*?)lager: \d+,/, '$1lager: ' + KNAPP_LAGER + ',');
  check('0e: das winzige Lager der Stufe 5 steht wirklich in der Kopie',
    new RegExp('\\{ stufe: 5,[^}]*lager: ' + KNAPP_LAGER + ',').test(basis) && leiter[4].lager !== KNAPP_LAGER,
    { ausgeliefert: leiter[4].lager, inDerKopie: KNAPP_LAGER });

  const an = basis.replace(/const VORPOSTEN_REPARATUR_AKTIV = (true|false);/, 'const VORPOSTEN_REPARATUR_AKTIV = true;');
  /* BEIDE STAENDE WERDEN SELBST HERGESTELLT (berichtigt 14.09.2026). Vorher las 7a den
     ausgelieferten Quelltext und setzte voraus, dass der Schalter dort auf `false` steht - die
     Pruefung hielt damit den AUSLIEFERUNGSZUSTAND fest, nicht die Regel. Als der Schalter mit der
     Frontend-Haelfte fiel, schlug sie auf richtigem Code an. Jetzt baut der Test sich den
     Aus-Zustand selbst; die Regel „ausgeschaltet heisst 404" gilt unabhaengig davon, was gerade
     ausgeliefert ist. */
  const aus = basis.replace(/const VORPOSTEN_REPARATUR_AKTIV = (true|false);/, 'const VORPOSTEN_REPARATUR_AKTIV = false;');
  check('0b: der Reparatur-Schalter liess sich in BEIDE Richtungen umlegen',
    /const VORPOSTEN_REPARATUR_AKTIV = true;/.test(an) && /const VORPOSTEN_REPARATUR_AKTIV = false;/.test(aus) && an !== aus,
    { anDa: /= true;/.test(an), ausDa: /= false;/.test(aus) });
  /* Der ausgelieferte Zustand als eigene Aussage, getrennt von der Regel: Die Frontend-Haelfte
     haengt daran. Faellt diese Pruefung, wurde der Schalter zurueckgedreht - und im Spiel stehen
     dann zwei Texte, die eine Faehigkeit versprechen, die der Server mit 404 abweist. */
  check('0c: der AUSGELIEFERTE Schalter steht auf true - die Frontend-Haelfte haengt daran',
    /const VORPOSTEN_REPARATUR_AKTIV = true;/.test(roh),
    { ausgeliefert: (roh.match(/const VORPOSTEN_REPARATUR_AKTIV = (true|false);/) || [])[1] });

  /* ---- Aufbau ---------------------------------------------------------------------------------
     ALLE Lager werden WEIT ueber den Deckel zurueckdatiert (30 h bei 12 h Deckel). Das macht den
     Vorrat DETERMINISTISCH - er haengt dann am Deckel und nicht an der Laufzeit des Tests - und es
     ist zugleich der gefaehrliche Fall: Wer `lagerSeit` vom alten Zeitstempel aus schiebt, senkt
     den Stand hier gar nicht. */
  const ALT = 30 * 3600 * 1000;
  const vorrat8 = proStunde(8) * stundenDeckel;
  const vorrat1 = proStunde(1) * stundenDeckel;
  const lpMax8 = leiter[7].kernLp;
  const lpMax1 = leiter[0].kernLp;
  const SCHADEN = Math.round(vorrat8 / 3);          // ein Drittel des vollen Lagers: Teilverbrauch
  fs.writeFileSync(QUELLE, an);
  const db0 = grunddb();
  const jetzt0 = Date.now();
  // Teilverbrauch: Kern fehlt ein Drittel des vollen Lagers, Lager am Deckel.
  db0.shared['vorposten:rep-teil'] = JSON.stringify(vpDoc('rep-teil', 8, lpMax8 - SCHADEN, { lagerSeit: jetzt0 - ALT }));
  // Lager reicht nicht: Stufe 1, Kern fast leer, volles Lager deckt nur einen Teil.
  db0.shared['vorposten:rep-arm'] = JSON.stringify(vpDoc('rep-arm', 1, 1000, { lagerSeit: jetzt0 - ALT }));
  // Unversehrt: nichts zu tun.
  db0.shared['vorposten:rep-voll'] = JSON.stringify(vpDoc('rep-voll', 8, lpMax8, { lagerSeit: jetzt0 - ALT }));
  // Leeres Lager: `lagerSeit` in der ZUKUNFT - die Stunden klemmen bei 0, der Stand ist leer.
  db0.shared['vorposten:rep-leer'] = JSON.stringify(vpDoc('rep-leer', 8, lpMax8 - SCHADEN, { lagerSeit: jetzt0 + 60000 }));
  /* DER KNAPPE FALL - zwei Stationen der Stufe 5, GLEICH aufgebaut bis auf den Zeitpunkt. Beiden
     fehlt genau EIN Lebenspunkt, beide haben ein gefuelltes Lager (27 bzw. 26 Einheiten). Bei
     5,90 Stunden liegen alle drei Rohstoffe so dicht unter der naechsten ganzen Einheit, dass der
     Schub von `lagerSeit` unter allen drei Abrundungen verschwindet - `genommen` faellt auf null.
     Bei 5,45 Stunden tut er das nicht. GEMESSEN am 14.09.2026 an der echten Funktion: Das Fenster
     reicht von 5,8667 bis 6,0 Stunden, der Test steht mit sechs Minuten Reserve darin; der
     Gegenpunkt hat fuenf Minuten, bis das naechste Fenster beginnt. Beide liegen unter dem
     Zwoelf-Stunden-Deckel - am Deckel selbst gibt es keine Bruchteile und damit auch den Fall
     nicht. */
  const KNAPP_H = 5.90, KNAPP_OK_H = 5.45;
  const lpMax5 = leiter[4].kernLp;
  db0.shared['vorposten:rep-knapp'] = JSON.stringify(vpDoc('rep-knapp', 5, lpMax5 - 1, { lagerSeit: jetzt0 - Math.round(KNAPP_H * 3600000) }));
  db0.shared['vorposten:rep-knapp-ok'] = JSON.stringify(vpDoc('rep-knapp-ok', 5, lpMax5 - 1, { lagerSeit: jetzt0 - Math.round(KNAPP_OK_H * 3600000) }));
  /* Das Ziel des Fremd-Versuchs: BESCHAEDIGT und mit vollem Lager. Ein unversehrter waere die
     schwaechere Probe - dort scheiterte ein Versuch ohne Besitzerriegel schon am „unversehrt" und
     der Riegel bliebe ungemessen. So wuerde ein fehlender Riegel wirklich eine fremde Station
     reparieren (200), und genau das misst 4a. */
  db0.shared['vorposten:rep-fremd'] = JSON.stringify(vpDoc('rep-fremd', 8, lpMax8 - SCHADEN, { lagerSeit: jetzt0 - ALT }));
  // Das Belagerungsziel: voller Kern, volles Lager, wird gleich wirklich beschossen.
  db0.shared['vorposten:rep-kampf'] = JSON.stringify(vpDoc('rep-kampf', 8, lpMax8, { lagerSeit: jetzt0 - ALT }));
  const svBen = liesSave(db0, BEN);
  svBen.fleet.missions = [angriffMission('m-rep', 'rep-kampf')];
  svBen.__attackShieldUntil = 0;
  schreibSave(db0, BEN, svBen);
  fs.writeFileSync(dbPfad, JSON.stringify(db0, null, 1));
  let s = await starteServer();
  let tokA = await s.anmelden('anna'), tokB = await s.anmelden('ben');

  // ---- 1) Was der Client erfaehrt --------------------------------------------------------------
  const kat = await s.hole('/vorposten', tokA);
  const vpVon = (k, sys) => (k.body.liste || []).find(x => x.sys === sys) || {};
  const teilVor = vpVon(kat, 'rep-teil');
  check('1a: der Katalog meldet die Reparatur als verfuegbar und nennt die Abklingzeit, aus der ihre Sperre stammt',
    kat.status === 200 && kat.body.reparaturAktiv === true && kat.body.abklingMs === abklingH * 3600 * 1000,
    { aktiv: kat.body.reparaturAktiv, abklingMs: kat.body.abklingMs });
  check('1b: jeder Vorposten traegt mit, was eine Reparatur kosten und bringen wuerde - ohne zweite Tabelle im Frontend',
    teilVor.reparatur && teilVor.reparatur.fehlend === SCHADEN && teilVor.reparatur.heilung === SCHADEN
    && teilVor.reparatur.vorrat === vorrat8 && teilVor.reparatur.moeglich === true
    && teilVor.reparatur.gesperrtBis === 0
    && Object.values(teilVor.reparatur.kosten).reduce((a, b) => a + b, 0) === SCHADEN,
    { vorschau: teilVor.reparatur, erwarteteHeilung: SCHADEN, erwarteterVorrat: vorrat8 });

  // ---- 2) Der Teilverbrauch ---------------------------------------------------------------------
  /* DER SERVER RECHNET DEN BETRAG. Die mitgeschickten Wunschzahlen sind Koeder: Nimmt der Endpunkt
     irgendeine davon, faellt 2e - und mit ihr die Hausregel „kein PvP-relevanter Wert aus dem
     Request". */
  const rep = await s.sende('/vorposten/reparieren', tokA,
    { system: 'rep-teil', menge: 999999999, betrag: 999999999, heilung: 999999999, lp: 999999999 });
  check('2a: die Reparatur geht durch und heilt GENAU die fehlenden LP - nicht mehr, obwohl das Lager das Dreifache traegt',
    rep.status === 200 && rep.body.geheilt === SCHADEN,
    { status: rep.status, geheilt: rep.body && rep.body.geheilt, fehlten: SCHADEN, imLager: vorrat8 });
  const kosten = (rep.body && rep.body.verbraucht) || {};
  const kostenSumme = Object.values(kosten).reduce((a, b) => a + b, 0);
  check('2b: 1 Rohstoff = 1 LP - die Summe des Verbrauchten deckt sich mit dem Geheilten',
    Math.abs(kostenSumme - (rep.body || {}).geheilt) <= 3,
    { verbraucht: kosten, summe: kostenSumme, geheilt: rep.body && rep.body.geheilt,
      hinweis: 'Toleranz 3: jeder der drei Rohstoffe wird einzeln abgerundet' });
  check('2d: der Kern steht danach am Dach - ueber lpMax wird nicht geheilt',
    rep.body.vorposten && rep.body.vorposten.kern.lp === rep.body.vorposten.kern.lpMax
    && rep.body.vorposten.kern.lp === lpMax8,
    { kern: rep.body && rep.body.vorposten && rep.body.vorposten.kern, lpMax: lpMax8 });
  check('2e: der Server hat KEINEN Betrag aus dem Request genommen',
    rep.body.geheilt === SCHADEN && rep.body.geheilt !== 999999999,
    { geschickt: 999999999, geheilt: rep.body && rep.body.geheilt });
  /* 2c MISST DEN RESTSTAND NACH, statt ihn zu glauben - der Lagerstand ist gerechnet, nicht
     gespeichert, und genau hier entstehen Rohstoffe aus dem Nichts oder verschwinden.
     Gemessen wird in STUNDEN, weil die Stunden der Zustand sind: Das Lager stand am Deckel (12 h),
     ein Drittel wurde verbraucht, also muessen acht Stunden uebrig sein. Der Vergleich in Stunden
     ist unabhaengig davon, wie lange der Test zwischen Aufruf und Messung braucht (die Toleranz
     entspricht einer Minute Foerderung). */
  const katNach = await s.hole('/vorposten', tokA);
  const teilNach = vpVon(katNach, 'rep-teil');
  const stundenAus = (vp, stufe) => (vp.lager || {}).erz / rateVon(stufe).erz;
  const restErwartet = stundenDeckel - SCHADEN / proStunde(8);
  check('2c: der Reststand stimmt - GEMESSEN, nicht gerechnet: von zwoelf Stunden sind acht uebrig',
    Math.abs(stundenAus(teilNach, 8) - restErwartet) < 0.03,
    { gemesseneStunden: Math.round(stundenAus(teilNach, 8) * 1000) / 1000, erwartet: restErwartet,
      lagerJetzt: teilNach.lager, lagerVorher: teilVor.lager });
  check('1c: die Vorschau hat vorher genau das angekuendigt, was der Endpunkt dann getan hat',
    teilVor.reparatur.heilung === rep.body.geheilt
    && JSON.stringify(teilVor.reparatur.kosten) === JSON.stringify(rep.body.verbraucht)
    && teilNach.reparatur.fehlend === 0 && teilNach.reparatur.moeglich === false,
    { vorher: teilVor.reparatur, getan: { geheilt: rep.body.geheilt, verbraucht: rep.body.verbraucht },
      nachher: teilNach.reparatur });

  // ---- 3) Wenn das Lager nicht reicht -----------------------------------------------------------
  const arm = await s.sende('/vorposten/reparieren', tokA, { system: 'rep-arm' });
  check('3a: reicht das Lager nicht, wird es vollstaendig verbraucht und 1:1 in LP verwandelt',
    arm.status === 200 && Math.abs(arm.body.geheilt - vorrat1) <= 3
    && arm.body.vorposten.kern.lp < arm.body.vorposten.kern.lpMax,
    { status: arm.status, geheilt: arm.body && arm.body.geheilt, vollesLager: vorrat1,
      kern: arm.body && arm.body.vorposten && arm.body.vorposten.kern, lpMax: lpMax1 });
  const armNach = vpVon(await s.hole('/vorposten', tokA), 'rep-arm');
  check('3b: und das Lager ist danach praktisch leer - weit unter einer Stundenrate',
    Object.keys(rateVon(1)).every(k => (armNach.lager || {})[k] < rateVon(1)[k] / 60),
    { lager: armNach.lager, einStundenwert: rateVon(1) });

  // ---- 4) Wer darf nicht, und wann passiert nichts ----------------------------------------------
  const fremdVor = vpVon(await s.hole('/vorposten', tokA), 'rep-fremd');
  const fremd = await s.sende('/vorposten/reparieren', tokB, { system: 'rep-fremd' });
  const fremdNach = vpVon(await s.hole('/vorposten', tokA), 'rep-fremd');
  check('4a: ein Fremder repariert hier nichts - nur der Besitzer, und die fremde Station bleibt unveraendert',
    fremd.status === 403 && fremdNach.kern.lp === fremdVor.kern.lp && fremdVor.kern.lp === lpMax8 - SCHADEN
    && Math.abs(stundenAus(fremdNach, 8) - stundenAus(fremdVor, 8)) < 0.03,
    { status: fremd.status, body: fremd.body, kernVorher: fremdVor.kern, kernNachher: fremdNach.kern });
  const vollVor = vpVon(await s.hole('/vorposten', tokA), 'rep-voll');
  const voll = await s.sende('/vorposten/reparieren', tokA, { system: 'rep-voll' });
  const vollNach = vpVon(await s.hole('/vorposten', tokA), 'rep-voll');
  check('4b: ein unversehrter Kern wird mit eigenem Grund abgewiesen und das Lager bleibt unangetastet',
    voll.status === 400 && voll.body.voll === true
    && Math.abs(stundenAus(vollNach, 8) - stundenAus(vollVor, 8)) < 0.03,
    { status: voll.status, body: voll.body,
      stundenVorher: Math.round(stundenAus(vollVor, 8) * 1000) / 1000,
      stundenNachher: Math.round(stundenAus(vollNach, 8) * 1000) / 1000 });
  const leer = await s.sende('/vorposten/reparieren', tokA, { system: 'rep-leer' });
  const leerNach = vpVon(await s.hole('/vorposten', tokA), 'rep-leer');
  check('4c: bei leerem Lager passiert nichts - eigener Grund, und der Kern bleibt, wie er war',
    leer.status === 400 && leer.body.leer === true && leerNach.kern.lp === lpMax8 - SCHADEN,
    { status: leer.status, body: leer.body, kern: leerNach.kern });
  /* 4d/4e SIND EIN PAAR und nur zusammen eine Aussage (Befund der Durchsicht, 14.09.2026). Die
     Ablehnung bei 4d darf sich NICHT als „hier liegt nichts" ausgeben: Die Stationstafel zeigt
     daneben ein gefuelltes Lager, und zwei Auskuenfte ueber dieselbe Station, die einander
     widersprechen, sind fuer den Spieler ein Fehler - auch wenn beide Zahlen stimmen. 4e ist der
     Beleg, dass die Ablehnung wirklich an der RUNDUNG haengt und nicht am Lager: dieselbe Stufe,
     dasselbe fehlende eine LP, ein Lager derselben Groessenordnung - nur ein anderer Zeitpunkt,
     und die Reparatur laeuft durch. Ohne 4e koennte 4d auch von einem kaputten Lager kommen. */
  const knappVor = vpVon(await s.hole('/vorposten', tokA), 'rep-knapp');
  const knappVorrat = Object.values(knappVor.lager || {}).reduce((a, b) => a + (b || 0), 0);
  const knapp = await s.sende('/vorposten/reparieren', tokA, { system: 'rep-knapp' });
  const knappNach = vpVon(await s.hole('/vorposten', tokA), 'rep-knapp');
  check('4d: ein gefuelltes Lager, aus dem gerade kein GANZER Punkt faellt, wird nicht als leer gemeldet',
    knapp.status === 400 && knapp.body.zuWenig === true && knapp.body.leer !== true
    && !/liegt nichts/.test(String(knapp.body.error || ''))
    && knappVorrat > 0 && knappNach.kern.lp === lpMax5 - 1,
    { status: knapp.status, body: knapp.body, vorratVorher: knappVorrat, lager: knappVor.lager, kern: knappNach.kern });
  const okVor = vpVon(await s.hole('/vorposten', tokA), 'rep-knapp-ok');
  const okVorrat = Object.values(okVor.lager || {}).reduce((a, b) => a + (b || 0), 0);
  const knappOk = await s.sende('/vorposten/reparieren', tokA, { system: 'rep-knapp-ok' });
  const okNach = vpVon(await s.hole('/vorposten', tokA), 'rep-knapp-ok');
  check('4e: dieselbe Station einen Moment frueher heilt den einen Punkt wirklich - die Ablehnung haengt an der Rundung, nicht am Lager',
    knappOk.status === 200 && knappOk.body.geheilt === 1 && okNach.kern.lp === lpMax5
    && okVorrat > 0 && Math.abs(okVorrat - knappVorrat) <= 3,
    { status: knappOk.status, body: knappOk.body, vorratVorher: okVorrat, kern: okNach.kern });

  // ---- 5) Die Sperre - der einzige wirksame Hebel der Balance -----------------------------------
  const angriff = await s.sende('/vorposten/angriff', tokB, { system: 'rep-kampf', missionId: 'm-rep' });
  check('5-vorab: der Vorposten ist wirklich getroffen worden und steht noch',
    angriff.status === 200 && angriff.body.gefallen === false && angriff.body.schaden > 0,
    { status: angriff.status, schaden: angriff.body && angriff.body.schaden, gefallen: angriff.body && angriff.body.gefallen });
  const kampfNach = vpVon(await s.hole('/vorposten', tokA), 'rep-kampf');
  const repGesperrt = await s.sende('/vorposten/reparieren', tokA, { system: 'rep-kampf' });
  check('5a: unmittelbar nach einem Treffer ist die Reparatur gesperrt',
    repGesperrt.status === 403 && repGesperrt.body.gesperrt === true,
    { status: repGesperrt.status, body: repGesperrt.body });
  const treffer = (kampfNach.letzterKampf || {}).zeit || 0;
  check('5b: die Sperre ist von der Abklingzeit ABGELEITET, keine zweite Zahl',
    treffer > 0 && repGesperrt.body.gesperrtBis === treffer + abklingH * 3600 * 1000
    && kampfNach.reparatur.gesperrtBis === treffer + abklingH * 3600 * 1000,
    { letzterTreffer: treffer, gesperrtBis: repGesperrt.body && repGesperrt.body.gesperrtBis,
      abklingMs: abklingH * 3600 * 1000, erwartet: treffer + abklingH * 3600 * 1000 });
  /* 5c IST DER BELEG DES GANZEN ZUSCHNITTS: Der naechste erlaubte SCHLAG und die erste erlaubte
     REPARATUR fallen auf dieselbe Millisekunde. Ein belagerter Vorposten heilt waehrend einer
     laufenden Belagerung also gar nicht, und die Netto-Belagerungsdauer ist identisch mit der ohne
     Heilung. Gemessen wird das gegen die Antwort des ANGRIFFS-Endpunkts, nicht gegen eine Zahl im
     Test - beide Fristen muessen aus derselben Konstante stammen. */
  const zweiterSchlag = await s.sende('/vorposten/angriff', tokB, { system: 'rep-kampf', missionId: 'm-rep' });
  check('5c: der belagerte Vorposten heilt nicht - die erste erlaubte Reparatur faellt mit dem naechsten erlaubten Schlag zusammen',
    zweiterSchlag.status === 403 && zweiterSchlag.body.abklingzeit === true
    && zweiterSchlag.body.naechsterSchlagAb === repGesperrt.body.gesperrtBis,
    { naechsterSchlagAb: zweiterSchlag.body && zweiterSchlag.body.naechsterSchlagAb,
      reparaturAb: repGesperrt.body && repGesperrt.body.gesperrtBis });
  const lpNachSchlag = kampfNach.kern.lp;
  /* Die Abklingzeit laeuft ab: Kampfvermerk UND Angreifer-Abklingzeit werden zurueckdatiert - so
     sieht der Zustand nach einer wirklich ueberstandenen Belagerung aus. */
  s = await aendereDb(d => {
    const dd = liesDoc(d, 'rep-kampf');
    const zurueck = abklingH * 3600 * 1000 + 60000;
    dd.letzterKampf.zeit -= zurueck;
    dd.kampfverlauf = (dd.kampfverlauf || []).map(v => Object.assign({}, v, { zeit: v.zeit - zurueck }));
    for (const k of Object.keys(dd.schlaege || {})) dd.schlaege[k] -= zurueck;
    dd.lagerSeit = Date.now() - ALT;
    schreibDoc(d, dd);
  });
  tokA = await s.anmelden('anna');
  const repFrei = await s.sende('/vorposten/reparieren', tokA, { system: 'rep-kampf' });
  check('5d: ist die Abklingzeit abgelaufen, wird repariert - der Kern steigt wirklich',
    repFrei.status === 200 && repFrei.body.geheilt > 0 && repFrei.body.vorposten.kern.lp > lpNachSchlag,
    { status: repFrei.status, geheilt: repFrei.body && repFrei.body.geheilt,
      lpVorher: lpNachSchlag, lpNachher: repFrei.body && repFrei.body.vorposten && repFrei.body.vorposten.kern.lp });

  // ---- 6) Persistenz: SIGKILL, nicht SIGTERM ----------------------------------------------------
  /* SIGTERM wuerde die im Speicher gehaltene db flushen und damit ein fehlendes `saveDb()`
     VERDECKEN. Nur ein harter Abschuss belegt, dass die Reparatur wirklich auf der Platte steht. */
  /* Der Ausgangswert kommt aus dem SERVER, nicht aus der Antwort von 5d: Faellt eine Pruefung davor,
     traegt jene Antwort kein `vorposten`-Objekt, und der Lauf braeche mit einer Ausnahme ab - eine
     Gegenprobe koennte dann gar nicht mehr auswerten, was gefallen ist (gemessen an `ohnesperre`). */
  const kampfVorKill = vpVon(await s.hole('/vorposten', tokA), 'rep-kampf');
  const lpVorKill = kampfVorKill.kern.lp;
  const stundenVorKill = stundenAus(kampfVorKill, 8);
  try { srv.kill('SIGKILL'); } catch (e) {}
  srv = null;
  await warte(500);
  const dbNachKill = liesDb();
  const docNachKill = liesDoc(dbNachKill, 'rep-kampf');
  const restStundenAufPlatte = Math.min(stundenDeckel, (Date.now() - docNachKill.lagerSeit) / 3600000);
  check('6a: die Reparatur ueberlebt einen harten Absturz - Kern UND verschobener Lagerstempel stehen auf der Platte',
    docNachKill.kern.lp === lpVorKill && Math.abs(restStundenAufPlatte - stundenVorKill) < 0.05,
    { lpAufPlatte: docNachKill.kern.lp, lpVorAbsturz: lpVorKill,
      stundenAufPlatte: Math.round(restStundenAufPlatte * 1000) / 1000,
      stundenVorAbsturz: Math.round(stundenVorKill * 1000) / 1000 });

  // ---- 7) Die beiden Wege, sie abzuschalten -----------------------------------------------------
  /* 7a: die REGEL, nicht der Auslieferungszustand. Geprueft wird die Kopie `aus`, in der der
     Schalter ausdruecklich auf false steht - unabhaengig davon, was gerade ausgeliefert ist. */
  fs.writeFileSync(QUELLE, aus);
  check('7-vorab: im Pruefling steht der Schalter wirklich auf false', /const VORPOSTEN_REPARATUR_AKTIV = false;/.test(aus));
  const dbAus = grunddb();
  dbAus.shared['vorposten:rep-teil'] = JSON.stringify(vpDoc('rep-teil', 8, lpMax8 - SCHADEN, { lagerSeit: Date.now() - ALT }));
  fs.writeFileSync(dbPfad, JSON.stringify(dbAus, null, 1));
  s = await starteServer();
  const tokAus = await s.anmelden('anna');
  const katAus = await s.hole('/vorposten', tokAus);
  const repAus = await s.sende('/vorposten/reparieren', tokAus, { system: 'rep-teil' });
  check('7a: mit ausgeschaltetem Schalter antwortet der Endpunkt 404 und der Katalog sagt es dem Client',
    repAus.status === 404 && repAus.body.inaktiv === true && katAus.body.reparaturAktiv === false
    && (vpVon(katAus, 'rep-teil').reparatur || {}).aktiv === false,
    { status: repAus.status, body: repAus.body, katalog: katAus.body.reparaturAktiv });
  /* 7b: der Notaus. Er haengt am Schluessel `vorposten`, wie bei Projekten, Umruesten und Benennen.
     Er wird hier direkt in die DB geschrieben statt ueber die Admin-Route: Geprueft wird die
     WIRKUNG des Notaus auf diesen Endpunkt, nicht die Admin-Route (die hat ihre eigenen Tests).
     Damit ist zugleich belegt, dass der Admin nur AB-schalten kann: Die Konstante liegt im Code,
     `db.notAus` kann sie nur weiter zumachen, nie oeffnen. */
  await stoppeServer();
  fs.writeFileSync(QUELLE, an);
  const dbNot = grunddb();
  dbNot.notAus = { vorposten: { aus: true, seit: Date.now(), grund: 'Pruefung' } };
  dbNot.shared['vorposten:rep-teil'] = JSON.stringify(vpDoc('rep-teil', 8, lpMax8 - SCHADEN, { lagerSeit: Date.now() - ALT }));
  fs.writeFileSync(dbPfad, JSON.stringify(dbNot, null, 1));
  s = await starteServer();
  const tokNot = await s.anmelden('anna');
  const katNot = await s.hole('/vorposten', tokNot);
  const repNot = await s.sende('/vorposten/reparieren', tokNot, { system: 'rep-teil' });
  check('7b: der Notaus `vorposten` schliesst die Reparatur, obwohl die Konstante im Code an ist - der Admin kann nur AB-schalten',
    repNot.status === 404 && repNot.body.inaktiv === true && katNot.body.reparaturAktiv === false,
    { status: repNot.status, body: repNot.body, katalog: katNot.body.reparaturAktiv });
  await stoppeServer();

  // ---- Auswertung: Gruen-Lauf ODER Gegenprobe --------------------------------------------------
  if (SAB) {
    const soll = MUSS_FALLEN[SAB] || [];
    const gefallen = [...new Set(Object.keys(ergebnis).filter(n => ergebnis[n] === false).map(n => String(n).split(':')[0]))].sort();
    const fehlt = soll.filter(k => gefallen.indexOf(k) < 0);
    const zuviel = gefallen.filter(k => soll.indexOf(k) < 0);
    console.log('\nGegenprobe „' + SAB + '": gefallen ' + JSON.stringify(gefallen) + ', erwartet ' + JSON.stringify(soll.slice().sort()));
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

/* ---------------------------------------------------------------------------------------------
   GEGENPROBEN (jede stellt genau einen plausiblen Fehler her; die Listen in MUSS_FALLEN sind
   GEMESSEN, nicht geschaetzt - siehe den Bericht zum Aenderungssatz):

     KEPLER_VPREP_SABOTAGE=besitzer       der Besitzerriegel faellt weg
     KEPLER_VPREP_SABOTAGE=sperre         die Sperre wird eine zweite Zahl (60 s) statt einer Ableitung
     KEPLER_VPREP_SABOTAGE=kostenlos      der Verbrauch wird nie gebucht (Rohstoffe aus dem Nichts)
     KEPLER_VPREP_SABOTAGE=vollverbrauch  Vollverbrauch statt Teilverbrauch (`lagerSeit = jetzt`)
     KEPLER_VPREP_SABOTAGE=altstempel     geschoben wird vom ALTEN Zeitstempel statt von JETZT
     KEPLER_VPREP_SABOTAGE=ohnedeckel     es wird immer das ganze Lager genommen
     KEPLER_VPREP_SABOTAGE=griff          der Schalter am ausfuehrenden Endpunkt faellt weg
     KEPLER_VPREP_SABOTAGE=persistenz     das Schreiben auf die Platte (`saveDb`) faellt weg
     KEPLER_VPREP_SABOTAGE=ohnesperre     die Sperre wird nicht mehr durchgesetzt (nur noch angezeigt)
     KEPLER_VPREP_SABOTAGE=volldurch      der Riegel „Kern unversehrt" faellt weg
     KEPLER_VPREP_SABOTAGE=leerdurch      der Riegel „Lager leer" faellt weg
     KEPLER_VPREP_SABOTAGE=eingrund       die zwei Ablehnungsgruende werden wieder einer (Stand vor dem 14.09.2026)
     KEPLER_VPREP_SABOTAGE=betrag         der Heilbetrag kommt aus dem Request statt vom Server

   Ein Lauf OHNE Umgebungsvariable muss gruen sein (Exit 0); jeder Lauf MIT muss genau die
   aufgefuehrten Pruefungen fallen lassen und sonst keine (Exit 0 = Gegenprobe bestanden).
   --------------------------------------------------------------------------------------------- */
