// Der Anflug (Tarnwert Etappe 2, 03.09.2026) - gegen einen ECHT gestarteten Server.
//
//   node tests/test_anflug_http.js
//
// ANLASS: Der Flug eines Spielerangriffs existierte bisher ausschliesslich im Client des
// Angreifers. Der Server sah davon nichts und konnte niemanden vorwarnen. Eine Meldung, die der
// angreifende Client selbst schreibt, waere freiwillig gewesen - wer nicht gemeldet werden will,
// meldet nicht. Deshalb schreibt den Kanal jetzt der Server, und deshalb wird er hier ueber die
// ECHTEN Endpunkte gemessen: anmelden, abfliegen, lesen, schreiben-versuchen, angreifen.
//
// DIE WICHTIGSTEN PRUEFUNGEN:
//   2a  Der Kanal ist fuer Clients SCHREIBGESPERRT. Faellt sie, kann sich jeder Angreifer selbst
//       aus der Vorwarnung streichen - dann ist die ganze Etappe wirkungslos, und zwar unsichtbar.
//   3b  Die Signatur im Kanal ist das MAXIMUM des Verbands, nicht die Summe. Bei der Summe waeren
//       500 Jaeger sichtbarer als ein Schlachtschiff.
//   3c  Der Kanal traegt WEDER Zusammensetzung NOCH Angreifernamen. Er ist absichtlich arm; was
//       ein Verteidiger sieht, entscheidet sein Sensor im Client.
//   5b  Der Eintrag wird beim Aufloesen gestrichen - auch bei ausgeschalteter Pflicht. Sonst staut
//       sich der Kanal mit Anfluegen voll, die laengst angekommen sind, und der Verteidiger sieht
//       Gespenster.
//
// GEGENPROBE ueber KEPLER_ANFLUG_SABOTAGE, gemessen (siehe MUSS_FALLEN):
//   KEPLER_ANFLUG_SABOTAGE=schreibfrei  node tests/test_anflug_http.js
//   KEPLER_ANFLUG_SABOTAGE=summe        node tests/test_anflug_http.js
//   KEPLER_ANFLUG_SABOTAGE=kein_aufraeumen node tests/test_anflug_http.js
//   KEPLER_ANFLUG_SABOTAGE=pflicht_aus_trotz_schalter node tests/test_anflug_http.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3257;
const QUELLE = path.join(WURZEL, 'server_anflug_tmp.js');
const SAB = process.env.KEPLER_ANFLUG_SABOTAGE || '';
/* Was bei welcher Sabotage fallen MUSS - GEMESSEN, nicht geschaetzt. Die Listen stehen unten am
   Dateifuss noch einmal mit dem Lauf, aus dem sie stammen. */
const MUSS_FALLEN = {
  schreibfrei: ['2a'],
  summe: ['3b'],
  kein_aufraeumen: ['5b'],
  pflicht_aus_trotz_schalter: ['6a', '6b'],
  kein_deckel: ['7a']
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
const ANNA = crypto.randomUUID();   // Angreiferin
const BEN = crypto.randomUUID();    // Ziel
const dbPfad = path.join(os.tmpdir(), 'kepler-anflug-' + process.pid + '.json');
const MISSION_ID = 'm-anflug-1';
let srv = null;

/* Der Verband ist bewusst GEMISCHT: viele kleine Jaeger und EIN Schlachtschiff. Nur so laesst sich
   Maximum von Summe unterscheiden - bei 40 Jaegern (je 10) waere die Summe 400+600=1000 und damit
   zufaellig groesser als jedes einzelne Schiff, das Maximum aber genau 600. */
const VERBAND = { jaeger: 40, schlachtschiff: 1 };
const ANKUNFT_VORAUS_MS = 60 * 60 * 1000;

const save = (id, name, missionen) => ({
  resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 1000, forschungspunkte: 100 },
  buildings: {}, research: {}, colonies: {}, shipModules: {}, modules: {},
  fleet: Object.assign({ missions: missionen || [] }, VERBAND),
  player: { id, name }, credits: 9000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now(),
  __attackShieldUntil: 0
});
function grunddb(ankunftAt) {
  const mission = { id: MISSION_ID, type: 'attack-player', targetId: BEN, endTime: ankunftAt,
    startTime: Date.now(), composition: VERBAND, fleetName: 'Testflotte' };
  return {
    users: {
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: Date.now() }
    },
    private: {
      [ANNA]: { 'kepler7-save-v3': JSON.stringify(save(ANNA, 'anna', [mission])) },
      [BEN]:  { 'kepler7-save-v3': JSON.stringify(save(BEN, 'ben', [])) }
    },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {}, wrackKonvois: [], a2Verlauf: [] }
  };
}

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
  const schreibe = (pfad, tok, body) => j(pfad, { method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(body) });
  return { j, anmelden, hole, sende, schreibe };
}
async function stoppeServer() { if (!srv) return; srv.kill('SIGTERM'); await warte(700); srv = null; }

(async () => {
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  // ANKER aus dem QUELLTEXT, nicht aus der Antwort, die geprueft werden soll.
  const gnade = Number((roh.match(/const ANFLUG_GNADE_MS = ([^;]+);/) || [])[1] ? eval((roh.match(/const ANFLUG_GNADE_MS = ([^;]+);/) || [])[1]) : 0);
  /* Die Signaturwerte MUESSEN aus dem SHIP_SIGNATUR-Block kommen, nicht aus der ganzen Datei.
     Beim ersten Anlauf stand hier ein ungescoptes /\bjaeger:(\d+)/ - das traf den ersten
     jaeger:-Treffer irgendwo in server.js (12 statt 10) und liess 3b fallen, obwohl der Server
     voellig richtig 600 gemeldet hatte. Ein Test, der sich selbst falsch verankert, meldet einen
     Fehler im Messgegenstand, den es nicht gibt. */
  const sigBlock = (roh.match(/const SHIP_SIGNATUR = \{([\s\S]*?)\n\};/) || [])[1] || '';
  const sigJaeger = Number((sigBlock.match(/\bjaeger:(\d+)/) || [])[1]);
  const sigSchlacht = Number((sigBlock.match(/\bschlachtschiff:(\d+)/) || [])[1]);
  check('0z: der SHIP_SIGNATUR-Block ist auffindbar', sigBlock.length > 200, sigBlock.length);
  check('0a: Konstanten und Signaturwerte sind im Quelltext auffindbar',
    gnade > 0 && sigJaeger > 0 && sigSchlacht > sigJaeger, { gnade, sigJaeger, sigSchlacht });
  const ERWARTET_MAX = Math.max(sigJaeger, sigSchlacht);
  const ERWARTET_SUMME = VERBAND.jaeger * sigJaeger + VERBAND.schlachtschiff * sigSchlacht;
  check('0b: Maximum und Summe sind bei diesem Verband unterscheidbar',
    ERWARTET_MAX !== ERWARTET_SUMME, { max: ERWARTET_MAX, summe: ERWARTET_SUMME });

  let basis = roh;
  if (SAB === 'schreibfrei') basis = basis.replace(
    "  if (!key.startsWith('anflug:')) return null;\n  if (!isWrite) return null;",
    "  if (!key.startsWith('anflug:')) return null;\n  if (!isWrite) return null;\n  if (true) return null;");
  if (SAB === 'summe') basis = basis.replace(
    '    if (s > hoechste) hoechste = s;\n  }\n  return hoechste;',
    '    hoechste += s * (fleet[k] || 0);\n  }\n  return hoechste;');
  if (SAB === 'kein_aufraeumen') basis = basis.replace(
    '  if (meinAnflug) anflugSchreiben(targetUserId, anflugListe.filter(e => e !== meinAnflug));', '');
  if (SAB === 'pflicht_aus_trotz_schalter') basis = basis.replace(
    '  if (ANFLUG_PFLICHT) {', '  if (false) {');
  if (SAB === 'kein_deckel') basis = basis.replace(
    '  const arrivalAt = Math.min(roheAnkunft, Date.now() + ANFLUG_MAX_FLUG_MS);',
    '  const arrivalAt = roheAnkunft;');
  // Der Schalter wird fuer den Pflicht-Abschnitt gleich umgelegt; Grundlauf mit false.
  fs.writeFileSync(QUELLE, basis);

  const ankunft = Date.now() + ANKUNFT_VORAUS_MS;
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(ankunft)));
  let api = await starteServer();
  const tokAnna = await api.anmelden('anna');
  const tokBen = await api.anmelden('ben');
  check('1a: beide Konten sind angemeldet', !!tokAnna && !!tokBen);

  // ---- 2: der Kanal ist schreibgesperrt --------------------------------------------------------
  const fremdSchreiben = await api.schreibe('/storage/anflug:' + BEN + '?shared=true', tokAnna, { value: '{"gefaelscht":true}' });
  check('2a: ein Client kann den Anflug-Kanal NICHT beschreiben',
    fremdSchreiben.status === 403, { status: fremdSchreiben.status, body: fremdSchreiben.body });

  // ---- 3: der Abflug schreibt, was er soll - und nur das ----------------------------------------
  const abflug = await api.sende('/attack/abflug', tokAnna, { targetUserId: BEN, missionId: MISSION_ID });
  check('3a: der Abflug wird angenommen', abflug.status === 200 && abflug.body && abflug.body.ok === true,
    { status: abflug.status, body: abflug.body });
  const gelesen = await api.hole('/storage/anflug:' + BEN + '?shared=true', tokBen);
  let doc = null;
  try { doc = JSON.parse(gelesen.body && gelesen.body.value); } catch (e) {}
  const eintrag = doc && doc.anfluege && doc.anfluege[0];
  check('3b: die gemeldete Signatur ist das MAXIMUM des Verbands, nicht die Summe',
    !!eintrag && eintrag.signatur === ERWARTET_MAX,
    { gemeldet: eintrag && eintrag.signatur, max: ERWARTET_MAX, summe: ERWARTET_SUMME });
  const felder = eintrag ? Object.keys(eintrag).sort() : [];
  check('3c: der Eintrag traegt weder Zusammensetzung noch Angreifernamen',
    !!eintrag && !('composition' in eintrag) && !('name' in eintrag) && !('username' in eintrag)
      && !('staerke' in eintrag) && !('atk' in eintrag), felder);
  check('3d: er traegt die Ankunftszeit', !!eintrag && Math.abs(eintrag.arrivalAt - ankunft) < 2000,
    { gemeldet: eintrag && eintrag.arrivalAt, erwartet: ankunft });

  // ---- 4: Nachmelden verdoppelt nicht ----------------------------------------------------------
  await api.sende('/attack/abflug', tokAnna, { targetUserId: BEN, missionId: MISSION_ID });
  const gelesen2 = await api.hole('/storage/anflug:' + BEN + '?shared=true', tokBen);
  let doc2 = null;
  try { doc2 = JSON.parse(gelesen2.body && gelesen2.body.value); } catch (e) {}
  check('4a: derselbe Abflug zweimal gemeldet ergibt EINEN Eintrag',
    !!doc2 && (doc2.anfluege || []).length === 1, doc2 ? (doc2.anfluege || []).length : null);

  // ---- 5: das Aufloesen streicht den Eintrag - auch bei ausgeschalteter Pflicht -----------------
  const angriff = await api.sende('/attack', tokAnna, { targetUserId: BEN, missionId: MISSION_ID });
  check('5a: der Angriff laeuft bei ausgeschalteter Pflicht durch (Altpfad bleibt heil)',
    angriff.status === 200, { status: angriff.status, fehler: angriff.body && angriff.body.error });
  const gelesen3 = await api.hole('/storage/anflug:' + BEN + '?shared=true', tokBen);
  let doc3 = null;
  try { doc3 = JSON.parse(gelesen3.body && gelesen3.body.value); } catch (e) {}
  const restEintraege = doc3 ? (doc3.anfluege || []).length : 0;
  check('5b: der gelandete Anflug ist danach aus dem Kanal verschwunden',
    restEintraege === 0, { rest: restEintraege, roh: gelesen3.body && String(gelesen3.body.value || '').slice(0, 120) });

  // ---- 6: mit umgelegtem Schalter wird der Abflug zur Pflicht -----------------------------------
  await stoppeServer();
  let mitPflicht = basis.replace('const ANFLUG_PFLICHT = false;', 'const ANFLUG_PFLICHT = true;');
  check('6z: der Schalter liess sich umlegen', mitPflicht !== basis);
  fs.writeFileSync(QUELLE, mitPflicht);
  const ankunft2 = Date.now() + ANKUNFT_VORAUS_MS;
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(ankunft2)));
  api = await starteServer();
  const tokAnna2 = await api.anmelden('anna');
  const ohneAbflug = await api.sende('/attack', tokAnna2, { targetUserId: BEN, missionId: MISSION_ID });
  check('6a: ohne gemeldeten Abflug wird der Angriff abgewiesen',
    ohneAbflug.status === 409 && ohneAbflug.body && ohneAbflug.body.anflugFehlt === true,
    { status: ohneAbflug.status, body: ohneAbflug.body });
  await api.sende('/attack/abflug', tokAnna2, { targetUserId: BEN, missionId: MISSION_ID });
  const zuFrueh = await api.sende('/attack', tokAnna2, { targetUserId: BEN, missionId: MISSION_ID });
  check('6b: waehrend der Flugzeit wird der Angriff ebenfalls abgewiesen',
    zuFrueh.status === 425, { status: zuFrueh.status, body: zuFrueh.body });
  await stoppeServer();

  // ---- 7: die Ankunftszeit ist gedeckelt --------------------------------------------------------
  /* OHNE DECKEL WAERE DIE STARTSPERRE EINE WAFFE. Die Ankunftszeit kommt aus einem
     klientenautoritativen Spielstand; ein Angreifer setzt endTime auf in dreissig Tagen, meldet den
     Abflug und haelt sein Ziel damit einen Monat am Boden - ohne je anzugreifen und ohne dass
     irgendetwas davon nach einem Angriff aussieht.
     Gemessen wird ueber den ECHTEN Endpunkt mit einer echten Wucher-Mission im Spielstand, nicht
     durch Nachrechnen der Deckel-Formel. */
  await stoppeServer();
  const deckel = Number((roh.match(/const ANFLUG_MAX_FLUG_MS = ([^;]+);/) || [])[1]
    ? eval((roh.match(/const ANFLUG_MAX_FLUG_MS = ([^;]+);/) || [])[1]) : 0);
  check('7z: der Deckel ist im Quelltext auffindbar', deckel > 0, deckel);
  fs.writeFileSync(QUELLE, basis);
  const wucher = Date.now() + 30 * 24 * 60 * 60 * 1000;   // dreissig Tage
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(wucher)));
  api = await starteServer();
  const tokAnna3 = await api.anmelden('anna');
  const abflugWucher = await api.sende('/attack/abflug', tokAnna3, { targetUserId: BEN, missionId: MISSION_ID });
  const gemeldet = abflugWucher.body && abflugWucher.body.arrivalAt;
  check('7a: eine Wucher-Ankunftszeit wird auf den Deckel gekuerzt',
    abflugWucher.status === 200 && gemeldet > 0 && gemeldet < wucher - 1000
      && gemeldet <= Date.now() + deckel + 5000,
    { gemeldet, eingereicht: wucher, deckel });
  await stoppeServer();

  // ---- Schlussurteil: bei Sabotage MUSS genau die gemessene Liste fallen ------------------------
  if (SAB) {
    const soll = MUSS_FALLEN[SAB] || [];
    /* Verglichen wird ueber das KUERZEL am Zeilenanfang, nicht ueber den ganzen Pruefnamen -
       ergebnis ist mit dem vollen Text verschluesselt ("3b: die gemeldete Signatur ist ..."),
       MUSS_FALLEN fuehrt nur "3b". Beim ersten Anlauf verglich der Test die beiden direkt und
       meldete jede Sabotage als Abweichung, obwohl alle vier exakt richtig gefallen waren. */
    const gefallen = Object.keys(ergebnis).filter(k => !ergebnis[k])
      .map(k => (k.split(':')[0] || '').trim()).sort();
    const fehlt = soll.filter(k => !gefallen.includes(k));
    const zuviel = gefallen.filter(k => !soll.includes(k));
    console.log('\nSABOTAGE ' + SAB + ' - gefallen: ' + JSON.stringify(gefallen)
      + ' | erwartet: ' + JSON.stringify(soll));
    if (fehlt.length || zuviel.length) {
      console.log('ABWEICHUNG - fehlt: ' + JSON.stringify(fehlt) + ', zuviel: ' + JSON.stringify(zuviel));
      process.exit(1);
    }
    console.log('Gegenprobe stimmt.');
    process.exit(0);
  }
  console.log(fail ? '\nFAIL' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
