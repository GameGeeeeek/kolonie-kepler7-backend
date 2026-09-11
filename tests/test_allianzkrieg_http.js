// Allianzkriege mit Einsatz (Feature C, 11.09.2026) - gegen einen ECHT gestarteten Server.
//
// DER BEFUND, den dieser Test absichert: Bis Feature C schrieb der CLIENT die Kriegspunkte selbst
// (addWarScore im Frontend, PUT auf alliance:<TAG>:warscore:<GEGNER>) und setzte das Zeitfenster -
// und an genau diesem Punktestand haengt seit #4 eine Kredit-Praemie fuer alle Beitragenden. Jetzt
// vergibt der Server die Punkte dort, wo er den Kampf auswuerfelt (/api/attack, /api/vorposten/angriff),
// der generische Speicher lehnt Client-Schreibzugriffe ab (Lesen bleibt offen), Erklaerung und
// Frieden laufen ueber eigene Routen, und die Abrechnung zahlt Staub (Server bucht), Trostpreis und
// pflegt den Kriegsruhm in db.galaxy.
//
// GEPRUEFT WIRD:
//   1  Erklaerung: Mitglied 403, Dritter 403, gegen sich selbst 400, unbekannter Gegner 400,
//      Anfuehrer 200 (beide Listen, beide Zeitfenster, Chronik, News), doppelt 409, Deckel 2 Kriege.
//   2  Client-Schreibsperre: PUT auf warscore/warcontrib/warmeta/wars -> 403 mit dem Servertext;
//      GET bleibt 200.
//   3  /api/attack zwischen Kriegsparteien: Sieg +10 (Beitrag Angreifer), Niederlage +2 / Abwehr +6
//      (Beitrag Verteidiger) - je nach GEWUERFELTEM Ausgang die passende Regel; Vermerk in Antwort und
//      Bericht; GET /api/allianzkrieg zeigt Punkte und Top-Beitraege; ohne Krieg keine Punkte;
//      der Tagesriegel liegt am Nutzerobjekt, nicht im Spielstand.
//   4  Tagesriegel: der vierte Angriff auf dasselbe Ziel ist gedeckelt (0 Punkte, gedeckelt:true),
//      ein anderes Ziel zaehlt weiter.
//   5  Frieden: Mitglied/Dritter/Unbeteiligter abgelehnt, der Anfuehrer der GEGENSEITE darf; raeumt auf.
//   6  Aufloesung beim Serverstart (galaxyTick-start): Sieger war-victory mit staub:15 UND gebuchtem
//      Staub am Konto, Verlierer war-defeat 200, Nicht-Beitragende nichts, Ruhm zaehlt, Unentschieden
//      zaehlt beidseitig ohne Belohnung, Schluessel geraeumt.
//
// DER KAMPFAUSGANG IST GEWUERFELT (PVP_PHASE_MIN/MAX 0,196/0,804 -> 10 % / 90 %). Die Regel wird
// deshalb je Anlauf gegen den TATSAECHLICHEN Ausgang geprueft (3b fuer Sieg, 3c fuer Niederlage), und
// jede Seite bekommt bis zu drei Anlaeufe (= Tagesdeckel). Pruefnamen sind stabil (nicht je Anlauf
// nummeriert), damit die Gegenprobe-Listen unten deterministisch bleiben; ein Name, der einmal
// gefallen ist, bleibt gefallen (siehe check).
//
// AUFBAU: Der Test startet eine KOPIE von server.js im Repo-Verzeichnis (require('./mailer') loest
// nur dort auf), mit dem Schalter auf true gezwungen - gemessen wird der EIN-Zustand, unabhaengig von
// der Stellung im Repo. Nach einem gewonnenen Angriff hat das Ziel einen Schutzschild; er wird bei
// GESTOPPTEM Server genullt (aendereDb - eine Aenderung am laufenden Server flusht der Graceful
// Shutdown wieder weg). Alle Kontonamen kleingeschrieben (db.users speichert die Schluessel so).
//
// GEGENPROBE per Env KEPLER_ALLIANZKRIEG_SABOTAGE=<name> (Vorbild test_vorposten_endprojekte_http.js).
// GEMESSEN am 11.09.2026, nicht geschaetzt:
//   schalter  Schalter aus (alter Zustand): die drei Routen antworten JEDEM mit 404 (deshalb fallen auch
//             1a-1d, die eine andere Ablehnung erwarten), der Speicher ist offen (2a-2d), keine Serverpunkte
//             (3a-3g, 4a-4e; 3f faellt, weil kein Punktestand zum Lesen entsteht), kein Frieden ueber die
//             Route (5a-5f), keine Staub-/Trostpreis-/Ruhm-Auszahlung (6a-6c, 6e, 6f, 6h). NICHT fallen
//             3h (beide Ausgaenge kommen auch ohne Wertung vor) und 6g/6g2 (die alte Abrechnung raeumt und
//             meldet wie bisher - Abschnitt 6 setzt seine Listen selbst); 1e2 faellt (keine News, keine Chronik).
//   riegel    Tagesdeckel entfernt: 4b und 4c fallen (der vierte Angriff wird gewertet, Zaehler 4).
//   staub     Staub wird im Reward genannt, aber nicht gebucht: nur 6b faellt (6a sieht die Zahl).
const MUSS_FALLEN = {
  schalter: ['1a', '1b', '1c', '1d', '1e', '1e2', '1f', '1g', '1h', '1i', '2a', '2b', '2c', '2d', '3a', '3b', '3c', '3d', '3e', '3f', '3g', '4a', '4b', '4c', '4e', '5a', '5b', '5c', '5d', '5e', '5f', '6a', '6b', '6c', '6e', '6f', '6h'],
  riegel: ['4b', '4c'],
  staub: ['6b']
};
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3275);
const QUELLE = path.join(WURZEL, 'server_allianzkrieg_tmp.js');
const SAB = process.env.KEPLER_ALLIANZKRIEG_SABOTAGE || '';

let fail = false;
const ergebnis = {};
// Ein Name, der einmal gefallen ist, bleibt gefallen - die Kampfpruefungen laufen je Anlauf unter
// demselben Namen, und ein spaeterer gruener Anlauf darf einen roten nicht ueberdecken.
const check = (n, c, x) => {
  const k = String(n).split(':')[0];
  ergebnis[k] = (ergebnis[k] !== false) && !!c;
  console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : ''));
  fail = fail || !c;
};
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const NAMEN = ['anna', 'ben', 'carl', 'dora', 'emil', 'fritz', 'gina'];
const ID = {}; for (const n of NAMEN) ID[n] = crypto.randomUUID();
const ANNA = ID.anna, BEN = ID.ben, CARL = ID.carl, DORA = ID.dora, EMIL = ID.emil, FRITZ = ID.fritz, GINA = ID.gina;
// AAA: anna (Anfuehrer), ben (Mitglied) - BBB: carl (Anfuehrer), dora (Mitglied) - CCC: emil - DDD: gina - fritz ohne Allianz.
const ROLLEN = { AAA: { [ANNA]: 'admin', [BEN]: 'member' }, BBB: { [CARL]: 'admin', [DORA]: 'member' }, CCC: { [EMIL]: 'admin' }, DDD: { [GINA]: 'admin' } };
const TAG_VON = { anna: 'AAA', ben: 'AAA', carl: 'BBB', dora: 'BBB', emil: 'CCC', gina: 'DDD' };

const STARK = { cruisers: 500, destroyers: 300, jaeger: 900, schlachtschiff: 120 };
function spielstand(name, art) {
  const s = {
    resources: { energie: 1e5, erz: 1e5, kristalle: 1e5, deuterium: 1e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: { lager: 60, werft: 10 }, research: {}, colonies: {}, fleet: { missions: [] },
    player: { id: ID[name], name, allianceTag: TAG_VON[name] || '' }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  };
  if (art === 'angreifer') Object.assign(s.fleet, STARK);
  if (art === 'festung') s.buildings = { lager: 60, turm: 5000, schild: 5000, festung: 3000 };
  if (art === 'wehrlos') { s.buildings = { lager: 60 }; s.resources = { erz: 1000000, kristalle: 1000000, deuterium: 1000000 }; }
  return s;
}
const ART = { anna: 'angreifer', ben: 'angreifer', carl: 'festung', dora: 'wehrlos', emil: 'wehrlos', fritz: 'wehrlos', gina: 'wehrlos' };
function grunddb() {
  const users = {}, priv = {}, shared = {};
  for (const n of NAMEN) {
    users[n] = { userId: ID[n], username: n, passwordHash: hash, createdAt: Date.now() };
    priv[ID[n]] = { 'kepler7-save-v3': JSON.stringify(spielstand(n, ART[n])) };
  }
  for (const [tag, rollen] of Object.entries(ROLLEN)) {
    shared['alliance:' + tag + ':info'] = JSON.stringify({ name: 'Allianz ' + tag, tag });
    for (const [uid, rolle] of Object.entries(rollen)) shared['alliance:' + tag + ':role:' + uid] = JSON.stringify({ role: rolle });
  }
  return {
    users, private: priv, shared, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], chronik: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {} }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-allianzkrieg-' + process.pid + '.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-akrieg-'));
let srv = null;
let s = null;
const tok = {};
function aufraeumen() {
  try { if (srv) srv.kill(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.unlinkSync(QUELLE); } catch (e) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', aufraeumen);

async function starteServer() {
  let log = '';
  srv = spawn(process.execPath, [QUELLE], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, {
      DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret',
      JWT_SECRET_FILE: path.join(tmpDir, 'jwt.txt'),
      VAPID_PUBLIC_FILE: path.join(tmpDir, 'vapid-pub.txt'),
      VAPID_PRIVATE_FILE: path.join(tmpDir, 'vapid-priv.txt')
    }),
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
    try { return { status: r.status, headers: r.headers, body: JSON.parse(t) }; }
    catch (e) { return { status: r.status, headers: r.headers, body: t.slice(0, 300) }; }
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
  srv.kill('SIGTERM');            // flusht die DB (Graceful Shutdown)
  await warte(800);
  srv = null;
}
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
async function anmeldenAlle() { for (const n of NAMEN) tok[n] = await s.anmelden(n); }
// Jede Aenderung an der DB-DATEI laeuft hier durch: stoppen (SIGTERM flusht), aendern, starten.
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  s = await starteServer();
  await anmeldenAlle();
}
const liesSave = (d, id) => {
  const roh = (d.private[id] || {})['kepler7-save-v3'];
  if (!roh) return null;
  try { return JSON.parse(typeof roh === 'string' ? roh : roh.value); } catch (e) { return null; }
};
const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
const jsonWert = (d, k) => { try { return d.shared[k] ? JSON.parse(d.shared[k]) : null; } catch (e) { return null; } };
const kriegsliste = (d, tag) => ((jsonWert(d, 'alliance:' + tag + ':wars') || {}).enemies) || [];
const punkte = (d, tag, gegner) => (jsonWert(d, 'alliance:' + tag + ':warscore:' + gegner) || {}).score || 0;
const beitrag = (d, tag, gegner, uid) => (jsonWert(d, 'alliance:' + tag + ':warcontrib:' + gegner + ':' + uid) || {}).score || 0;
const stand = (d, tag, gegner) => ({ eigene: punkte(d, tag, gegner), gegner: punkte(d, gegner, tag) });
const belohnungen = (d, id, typ) => ((d.private[id] || {}).__pendingRewards || []).filter(r => r && r.type === typ);
const heute = () => new Date().toISOString().slice(0, 10);

(async () => {
  // ---- 0) Die Kopie: Schalter erzwungen an, Sabotage nach Wunsch --------------------------------
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  check('0a: der Schalter steht im Quelltext', /const ALLIANZKRIEG_SERVER_AKTIV = (true|false);/.test(roh));
  check('0b: die Sabotage ist bekannt (oder keine verlangt)', !SAB || !!MUSS_FALLEN[SAB], { SAB });
  const an = roh.replace(/const ALLIANZKRIEG_SERVER_AKTIV = (true|false);/, 'const ALLIANZKRIEG_SERVER_AKTIV = true;');
  let basis = an;
  if (SAB === 'schalter') basis = basis.replace('const ALLIANZKRIEG_SERVER_AKTIV = true;', 'const ALLIANZKRIEG_SERVER_AKTIV = false;');
  if (SAB === 'riegel') basis = basis.replace('  if (n >= ALLIANZKRIEG_TAGESDECKEL) return false;\n', '  if (false) return false;\n');
  if (SAB === 'staub') basis = basis.replace('if (u) { staubGutschreiben(staubKonto(u), WAR_VICTORY_STAUB); lohn.staub = WAR_VICTORY_STAUB; }', 'if (u) { lohn.staub = WAR_VICTORY_STAUB; }');
  // Eine Ersetzung, die ins Leere greift, meldet keinen Fehler und saehe aus wie eine bestandene Gegenprobe.
  check('0c: die Sabotage hat gegriffen (oder es wurde keine verlangt)', !SAB || basis !== an, { SAB });
  fs.writeFileSync(QUELLE, basis);

  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  s = await starteServer();
  await anmeldenAlle();
  check('0d: alle sieben Konten angemeldet', NAMEN.every(n => !!tok[n]), Object.fromEntries(NAMEN.map(n => [n, !!tok[n]])));
  if (!NAMEN.every(n => !!tok[n])) { console.log(s.protokoll().slice(-800)); console.log('\nFAIL'); process.exit(1); }

  const post = (pfad, token, body) => s.j(pfad, { method: 'POST', headers: kopf(token), body: JSON.stringify(body || {}) });
  const put = (key, token, value) => s.j('/storage/' + encodeURIComponent(key) + '?shared=true', { method: 'PUT', headers: kopf(token), body: JSON.stringify({ value }) });
  const get = (key, token) => s.j('/storage/' + encodeURIComponent(key) + '?shared=true', { headers: kopf(token) });
  const erklaeren = (token, gegnerTag) => post('/allianzkrieg/erklaeren', token, { gegnerTag });
  const frieden = (token, gegnerTag) => post('/allianzkrieg/frieden', token, { gegnerTag });
  const lage = token => s.j('/allianzkrieg', { headers: kopf(token) });
  // attackRateLimit (20/min je IP+Pfad) ist Messaufbau, nicht Messgegenstand: bei 429 Retry-After abwarten.
  async function angriff(token, zielId) {
    for (let i = 0; i < 3; i++) {
      const r = await post('/attack', token, { targetUserId: zielId });
      if (r.status !== 429) return r;
      const wartezeit = (parseInt(r.headers.get('retry-after'), 10) || 61) + 1;
      console.log('     (429 vom attackRateLimit - warte ' + wartezeit + 's)');
      await warte(wartezeit * 1000);
    }
    return { status: 429, body: null };
  }
  const schildLoeschen = zielId => aendereDb(d => { if (d.private[zielId]) d.private[zielId].__attackShieldUntil = 0; });

  // ---- 1) Erklaerung ------------------------------------------------------------------------------
  const mitglied = await erklaeren(tok.ben, 'BBB');
  check('1a: ein Mitglied kann keinen Krieg erklaeren - nur der Anfuehrer (wie im Frontend-Panel)',
    mitglied.status === 403 && /Anführer/.test(String(mitglied.body && mitglied.body.error)), { status: mitglied.status, body: mitglied.body });
  const dritter = await erklaeren(tok.fritz, 'BBB');
  check('1b: wer keiner Allianz angehoert, kann es auch nicht', dritter.status === 403, { status: dritter.status, body: dritter.body });
  const selbst = await erklaeren(tok.anna, 'aaa');
  check('1c: gegen sich selbst geht nicht - auch kleingeschrieben nicht', selbst.status === 400, { status: selbst.status, body: selbst.body });
  const niemand = await erklaeren(tok.anna, 'ZZZZ');
  check('1d: eine Allianz ohne Mitglieder ist kein Gegner - 400 mit dem Tag im Text (404 hiesse fuer den Client "alter Server")',
    niemand.status === 400 && niemand.body.unbekannt === true && /ZZZZ/.test(String(niemand.body && niemand.body.error)), { status: niemand.status, body: niemand.body });
  const vorher = Date.now();
  const krieg = await erklaeren(tok.anna, 'bbb');
  const d1 = liesDb();
  const metaA = jsonWert(d1, 'alliance:AAA:warmeta:BBB'), metaB = jsonWert(d1, 'alliance:BBB:warmeta:AAA');
  check('1e: der Anfuehrer erklaert den Krieg - beide Listen, beide Zeitfenster (7 Tage), erklaertVon',
    krieg.status === 200 && krieg.body.ok === true && krieg.body.gegnerTag === 'BBB' &&
    kriegsliste(d1, 'AAA').includes('BBB') && kriegsliste(d1, 'BBB').includes('AAA') &&
    !!metaA && !!metaB && metaA.endsAt === metaB.endsAt && metaA.erklaertVon === 'anna' && metaA.declaredBy === 'AAA' &&
    Math.abs(metaA.endsAt - (vorher + 7 * 24 * 3600 * 1000)) < 60000,
    { status: krieg.status, body: krieg.body, listen: [kriegsliste(d1, 'AAA'), kriegsliste(d1, 'BBB')], metaA });
  check('1e2: Galaxie-News und Chronik nennen die Erklaerung',
    (d1.galaxy.news || []).some(n => /\[AAA\].*\[BBB\].*Krieg/.test(n.text)) &&
    (d1.galaxy.chronik || []).some(c => c.art === 'allianzkrieg-erklaert' && c.angreifer === 'AAA' && c.verteidiger === 'BBB' && c.erklaertVon === 'anna'),
    { news: (d1.galaxy.news || []).slice(0, 2).map(n => n.text), chronik: (d1.galaxy.chronik || []).slice(0, 1) });
  const doppelt = await erklaeren(tok.anna, 'BBB');
  check('1f: dieselbe Erklaerung ein zweites Mal wird abgelehnt', doppelt.status === 409, { status: doppelt.status, body: doppelt.body });
  const zweiter = await erklaeren(tok.anna, 'CCC');
  const dritterKrieg = await erklaeren(tok.anna, 'DDD');
  check('1g: hoechstens zwei laufende Kriege je Allianz - der dritte wird abgelehnt, mit Zahl im Text',
    zweiter.status === 200 && dritterKrieg.status === 409 && /2 Kriege/.test(String(dritterKrieg.body && dritterKrieg.body.error)),
    { zweiter: zweiter.status, dritter: dritterKrieg.status, body: dritterKrieg.body });
  const lageBen = await lage(tok.ben);
  const kriegBBB = lageBen.status === 200 && (lageBen.body.kriege || []).find(k => k.gegnerTag === 'BBB');
  check('1h: GET /api/allianzkrieg zeigt dem Mitglied beide Kriege mit Zeit, Punkten 0:0, Erklaerer und Ruhm 0/0/0',
    lageBen.status === 200 && lageBen.body.aktiv === true && lageBen.body.tag === 'AAA' && (lageBen.body.kriege || []).length === 2 &&
    !!kriegBBB && kriegBBB.endsAt === metaA.endsAt && kriegBBB.laeuft === true && kriegBBB.erklaertVon === 'anna' &&
    kriegBBB.punkte.eigene === 0 && kriegBBB.punkte.gegner === 0 && Array.isArray(kriegBBB.topBeitraege) &&
    lageBen.body.ruhm.siege === 0 && lageBen.body.ruhm.niederlagen === 0 && lageBen.body.ruhm.unentschieden === 0,
    { status: lageBen.status, body: lageBen.body });
  const lageFritz = await lage(tok.fritz);
  check('1i: ohne Allianz: aktiv, aber kein Tag und keine Kriege - kein Fehler',
    lageFritz.status === 200 && lageFritz.body.aktiv === true && lageFritz.body.tag === null && (lageFritz.body.kriege || []).length === 0,
    { status: lageFritz.status, body: lageFritz.body });

  // ---- 2) Die Client-Schreibsperre ----------------------------------------------------------------
  const SPERRE = /Kriegspunkte vergibt der Server/;
  const putScore = await put('alliance:AAA:warscore:BBB', tok.anna, JSON.stringify({ score: 999 }));
  check('2a: der alte Client-Weg (PUT warscore) wird abgelehnt - mit dem Servertext, und der Wert bleibt weg',
    putScore.status === 403 && SPERRE.test(String(putScore.body && putScore.body.error)) && punkte(liesDb(), 'AAA', 'BBB') === 0,
    { status: putScore.status, body: putScore.body });
  const putContrib = await put('alliance:AAA:warcontrib:BBB:' + ANNA, tok.anna, JSON.stringify({ score: 50, name: 'anna' }));
  check('2b: auch der eigene Beitrag (PUT warcontrib) - bisher fuer Mitglieder erlaubt',
    putContrib.status === 403 && SPERRE.test(String(putContrib.body && putContrib.body.error)), { status: putContrib.status, body: putContrib.body });
  const putMeta = await put('alliance:AAA:warmeta:BBB', tok.anna, JSON.stringify({ endsAt: 1 }));
  check('2c: das Zeitfenster (PUT warmeta) - bisher voellig ohne Regel',
    putMeta.status === 403 && SPERRE.test(String(putMeta.body && putMeta.body.error)) && jsonWert(liesDb(), 'alliance:AAA:warmeta:BBB').endsAt === metaA.endsAt,
    { status: putMeta.status, body: putMeta.body });
  const putWars = await put('alliance:AAA:wars', tok.anna, JSON.stringify({ enemies: ['BBB', 'CCC', 'DDD'] }));
  check('2d: die Kriegsliste (PUT wars) - auch fuer den Anfuehrer, der sie bisher direkt fuehrte',
    putWars.status === 403 && SPERRE.test(String(putWars.body && putWars.body.error)) && kriegsliste(liesDb(), 'AAA').length === 2,
    { status: putWars.status, body: putWars.body });
  const getWars = await get('alliance:AAA:wars', tok.dora);
  check('2e: LESEN bleibt fuer jeden erlaubt - das Kriegspanel liest die Schluessel weiter',
    getWars.status === 200 && /BBB/.test(String(getWars.body && getWars.body.value)), { status: getWars.status, body: getWars.body });

  // ---- 3) Der Server vergibt die Punkte ----------------------------------------------------------
  const gesehen = { sieg: false, niederlage: false };
  // Antwort + DB-Differenz gegen die Regel, je nach GEWUERFELTEM Ausgang.
  async function angriffMitRegel(angreiferName, angreiferId, zielName, zielId, eigeneTag, gegnerTag) {
    const vor = liesDb();
    const r = await angriff(tok[angreiferName], zielId);
    const nach = liesDb();
    const ak = r.body && r.body.allianzkrieg;
    const sieg = !!(r.body && r.body.success === true);
    const vS = stand(vor, eigeneTag, gegnerTag), nS = stand(nach, eigeneTag, gegnerTag);
    check('3a: der Angriff kam durch und traegt den Kriegsvermerk mit beiden Tags',
      r.status === 200 && !!ak && ak.eigeneTag === eigeneTag && ak.gegnerTag === gegnerTag && ak.gedeckelt === false,
      { status: r.status, success: r.body && r.body.success, chancePct: r.body && r.body.chancePct, allianzkrieg: ak });
    if (r.status !== 200) return r;
    if (sieg) {
      gesehen.sieg = true;
      check('3b: SIEG - +10 fuer die eigene Allianz, Beitrag dem Angreifer, Gegner unveraendert',
        nS.eigene === vS.eigene + 10 && nS.gegner === vS.gegner &&
        beitrag(nach, eigeneTag, gegnerTag, angreiferId) === beitrag(vor, eigeneTag, gegnerTag, angreiferId) + 10 &&
        ak.angreifer === 10 && ak.verteidiger === 0,
        { vor: vS, nach: nS, beitrag: beitrag(nach, eigeneTag, gegnerTag, angreiferId), allianzkrieg: ak });
    } else {
      gesehen.niederlage = true;
      check('3c: NIEDERLAGE - +2 fuer die eigene Allianz, +6 Abwehr fuer die Gegner, Beitrag dem Verteidiger',
        nS.eigene === vS.eigene + 2 && nS.gegner === vS.gegner + 6 &&
        beitrag(nach, gegnerTag, eigeneTag, zielId) === beitrag(vor, gegnerTag, eigeneTag, zielId) + 6 &&
        beitrag(nach, eigeneTag, gegnerTag, angreiferId) === beitrag(vor, eigeneTag, gegnerTag, angreiferId) + 2 &&
        ak.angreifer === 2 && ak.verteidiger === 6,
        { vor: vS, nach: nS, beitragVerteidiger: beitrag(nach, gegnerTag, eigeneTag, zielId), allianzkrieg: ak });
    }
    const berichte = (nach.private[angreiferId] || {}).__reports || [];
    const bericht = berichte.find(b => b && b.type === 'attack-sent' && b.allianzkrieg);
    check('3d: der Bericht des Angreifers traegt denselben Vermerk',
      !!bericht && bericht.allianzkrieg.gegnerTag === gegnerTag && bericht.allianzkrieg.angreifer === ak.angreifer,
      bericht ? bericht.allianzkrieg : { berichte: berichte.map(b => b && b.type) });
    if (sieg) await schildLoeschen(zielId);
    return r;
  }
  // anna gegen die Festung carl: Niederlage ist der Regelfall (bis zu 3 Anlaeufe = Tagesdeckel).
  for (let i = 0; i < 3 && !gesehen.niederlage; i++) await angriffMitRegel('anna', ANNA, 'carl', CARL, 'AAA', 'BBB');
  // anna gegen die wehrlose dora: Sieg ist der Regelfall.
  for (let i = 0; i < 3 && !gesehen.sieg; i++) await angriffMitRegel('anna', ANNA, 'dora', DORA, 'AAA', 'BBB');
  check('3h: beide Ausgaenge sind in den Anlaeufen vorgekommen (sonst: Zufall, erneut laufen lassen)', gesehen.sieg && gesehen.niederlage, gesehen);
  const d3 = liesDb();
  const lage3 = await lage(tok.anna);
  const k3 = lage3.status === 200 && (lage3.body.kriege || []).find(k => k.gegnerTag === 'BBB');
  check('3e: GET /api/allianzkrieg zeigt die Serverpunkte, Top-Beitraege der eigenen Seite und den eigenen Beitrag',
    !!k3 && k3.punkte.eigene === punkte(d3, 'AAA', 'BBB') && k3.punkte.gegner === punkte(d3, 'BBB', 'AAA') && k3.punkte.eigene > 0 &&
    k3.topBeitraege.length >= 1 && k3.topBeitraege[0].userId === ANNA && k3.topBeitraege[0].name === 'anna' &&
    k3.topBeitraege[0].score === beitrag(d3, 'AAA', 'BBB', ANNA) && k3.meinBeitrag === beitrag(d3, 'AAA', 'BBB', ANNA) &&
    !k3.topBeitraege.some(t => t.userId === CARL),
    { krieg: k3, db: stand(d3, 'AAA', 'BBB') });
  const getScore = await get('alliance:AAA:warscore:BBB', tok.dora);
  check('3f: der Punktestand bleibt fuer den Client LESBAR - auch fuer die Gegenseite',
    getScore.status === 200 && (JSON.parse(getScore.body.value).score || 0) === punkte(d3, 'AAA', 'BBB'), { status: getScore.status, body: getScore.body });
  const riegelAnna = (d3.users.anna || {}).allianzkriegTag;
  check('3g: der Tagesriegel liegt am NUTZEROBJEKT (heutiger Stempel, Zaehler je Ziel), nicht im Spielstand',
    !!riegelAnna && riegelAnna.datum === heute() && (riegelAnna.ziele[CARL] || 0) >= 1 && (riegelAnna.ziele[DORA] || 0) >= 1 &&
    !(liesSave(d3, ANNA) || {}).allianzkriegTag,
    { riegel: riegelAnna, imSpielstand: !!(liesSave(d3, ANNA) || {}).allianzkriegTag });
  const ohneKrieg = await angriff(tok.anna, FRITZ);
  const d3b = liesDb();
  check('3i: ein Angriff auf jemanden ohne Kriegsgegnerschaft traegt keinen Vermerk und legt keine Schluessel an',
    ohneKrieg.status === 200 && ohneKrieg.body.allianzkrieg === undefined && !Object.keys(d3b.shared).some(k => /warscore:FRITZ|:warscore:$/.test(k)) &&
    !((d3b.users.anna || {}).allianzkriegTag || { ziele: {} }).ziele[FRITZ],
    { status: ohneKrieg.status, allianzkrieg: ohneKrieg.body && ohneKrieg.body.allianzkrieg });

  // ---- 4) Der Tagesriegel: drei gewertete Angriffe je Ziel, dann Schluss -----------------------
  let alleGewertet = true;
  for (let i = 1; i <= 3; i++) {
    const vor = stand(liesDb(), 'AAA', 'BBB');
    const r = await angriff(tok.ben, DORA);
    const nach = stand(liesDb(), 'AAA', 'BBB');
    const ak = r.body && r.body.allianzkrieg;
    const bewegt = (nach.eigene + nach.gegner) > (vor.eigene + vor.gegner);
    if (!(r.status === 200 && ak && ak.gedeckelt === false && bewegt)) alleGewertet = false;
    console.log('     Riegel-Anlauf ' + i + ': status ' + r.status + ', success ' + (r.body && r.body.success) + ', vermerk ' + JSON.stringify(ak));
    if (r.body && r.body.success === true) await schildLoeschen(DORA);
  }
  check('4a: die ersten drei Angriffe von ben auf dora werden alle gewertet', alleGewertet);
  const vor4 = stand(liesDb(), 'AAA', 'BBB');
  const vierter = await angriff(tok.ben, DORA);
  const nach4 = stand(liesDb(), 'AAA', 'BBB');
  const ak4 = vierter.body && vierter.body.allianzkrieg;
  check('4b: der VIERTE ist gedeckelt - Vermerk sagt es, kein Punkt bewegt sich',
    vierter.status === 200 && !!ak4 && ak4.gedeckelt === true && ak4.angreifer === 0 && ak4.verteidiger === 0 && ak4.deckel === 3 &&
    nach4.eigene === vor4.eigene && nach4.gegner === vor4.gegner,
    { status: vierter.status, success: vierter.body && vierter.body.success, vermerk: ak4, vor: vor4, nach: nach4 });
  if (vierter.body && vierter.body.success === true) await schildLoeschen(DORA);
  const d4 = liesDb();
  check('4c: der Zaehler am Nutzerobjekt steht auf genau 3 fuer dieses Ziel',
    ((d4.users.ben || {}).allianzkriegTag || { ziele: {} }).ziele[DORA] === 3, { riegel: (d4.users.ben || {}).allianzkriegTag });
  check('4d: und der Spielstand von ben kennt den Riegel nicht', !(liesSave(d4, BEN) || {}).allianzkriegTag);
  const anderesZiel = await angriff(tok.ben, CARL);
  check('4e: ein ANDERES Ziel derselben Allianz zaehlt weiter - der Riegel ist je Ziel',
    anderesZiel.status === 200 && !!anderesZiel.body.allianzkrieg && anderesZiel.body.allianzkrieg.gedeckelt === false,
    { status: anderesZiel.status, vermerk: anderesZiel.body && anderesZiel.body.allianzkrieg });
  if (anderesZiel.body && anderesZiel.body.success === true) await schildLoeschen(CARL);

  // ---- 5) Frieden --------------------------------------------------------------------------------
  const frMitglied = await frieden(tok.dora, 'AAA');
  check('5a: ein Mitglied kann keinen Frieden schliessen', frMitglied.status === 403, { status: frMitglied.status, body: frMitglied.body });
  const frDritter = await frieden(tok.fritz, 'AAA');
  check('5b: ohne Allianz auch nicht', frDritter.status === 403, { status: frDritter.status, body: frDritter.body });
  const frUnbeteiligt = await frieden(tok.gina, 'AAA');
  check('5c: der Anfuehrer einer UNBETEILIGTEN Allianz bekommt "nicht im Krieg"',
    frUnbeteiligt.status === 400 && /nicht im Krieg/.test(String(frUnbeteiligt.body && frUnbeteiligt.body.error)), { status: frUnbeteiligt.status, body: frUnbeteiligt.body });
  const frGegenseite = await frieden(tok.emil, 'aaa');
  const d5 = liesDb();
  check('5d: der Anfuehrer der GEGENSEITE (emil, CCC) darf - beide Listen und alle Schluessel des Paars sind weg',
    frGegenseite.status === 200 && frGegenseite.body.ok === true &&
    !kriegsliste(d5, 'AAA').includes('CCC') && !kriegsliste(d5, 'CCC').includes('AAA') &&
    !Object.keys(d5.shared).some(k => /^alliance:(AAA:war\w*:CCC|CCC:war\w*:AAA)/.test(k)),
    { status: frGegenseite.status, listen: [kriegsliste(d5, 'AAA'), kriegsliste(d5, 'CCC')], reste: Object.keys(d5.shared).filter(k => /CCC/.test(k) && /war/.test(k)) });
  check('5e: der Krieg gegen BBB laeuft davon unberuehrt weiter', kriegsliste(d5, 'AAA').includes('BBB') && !!jsonWert(d5, 'alliance:AAA:warmeta:BBB'));
  const frNochmal = await frieden(tok.anna, 'CCC');
  check('5f: Frieden mit einer Allianz, mit der man nicht (mehr) im Krieg ist - 400', frNochmal.status === 400 && frNochmal.body.keinKrieg === true, { status: frNochmal.status, body: frNochmal.body });

  // ---- 6) Die Aufloesung beim Serverstart -------------------------------------------------------
  // AAA:BBB 30:12 mit anna (30) und carl (12) als einzigen Beitragenden; CCC:DDD 5:5 als Unentschieden.
  await aendereDb(d => {
    const vorbei = Date.now() - 1000;
    for (const k of Object.keys(d.shared)) if (/^alliance:(AAA:warcontrib:BBB|BBB:warcontrib:AAA):/.test(k)) delete d.shared[k];
    const meta = JSON.stringify({ startedAt: vorbei - 7 * 24 * 3600 * 1000, endsAt: vorbei, declaredBy: 'AAA', erklaertVon: 'anna', erklaertAm: vorbei });
    // Die Listen werden hier ausdruecklich gesetzt, damit Abschnitt 6 nicht von 1e abhaengt (in der
    // Gegenprobe `schalter` gibt es die Erklaerung nicht - der Abschnitt soll trotzdem messen).
    d.shared['alliance:AAA:wars'] = JSON.stringify({ enemies: ['BBB'] });
    d.shared['alliance:BBB:wars'] = JSON.stringify({ enemies: ['AAA'] });
    d.shared['alliance:AAA:warmeta:BBB'] = meta; d.shared['alliance:BBB:warmeta:AAA'] = meta;
    d.shared['alliance:AAA:warscore:BBB'] = JSON.stringify({ score: 30 });
    d.shared['alliance:BBB:warscore:AAA'] = JSON.stringify({ score: 12 });
    d.shared['alliance:AAA:warcontrib:BBB:' + ANNA] = JSON.stringify({ score: 30, name: 'anna' });
    d.shared['alliance:BBB:warcontrib:AAA:' + CARL] = JSON.stringify({ score: 12, name: 'carl' });
    d.shared['alliance:CCC:wars'] = JSON.stringify({ enemies: ['DDD'] });
    d.shared['alliance:DDD:wars'] = JSON.stringify({ enemies: ['CCC'] });
    const meta2 = JSON.stringify({ startedAt: vorbei - 7 * 24 * 3600 * 1000, endsAt: vorbei, declaredBy: 'CCC' });
    d.shared['alliance:CCC:warmeta:DDD'] = meta2; d.shared['alliance:DDD:warmeta:CCC'] = meta2;
    d.shared['alliance:CCC:warscore:DDD'] = JSON.stringify({ score: 5 });
    d.shared['alliance:DDD:warscore:CCC'] = JSON.stringify({ score: 5 });
    d.shared['alliance:CCC:warcontrib:DDD:' + EMIL] = JSON.stringify({ score: 5, name: 'emil' });
    d.shared['alliance:DDD:warcontrib:CCC:' + GINA] = JSON.stringify({ score: 5, name: 'gina' });
    for (const n of NAMEN) { delete d.private[ID[n]].__pendingRewards; delete d.users[n].staub; }
  });
  await warte(1500);              // galaxyTick-start (setImmediate) hat laengst gerechnet und gespeichert
  await stoppeServer();           // ... und der Graceful Shutdown flusht sicherheitshalber noch einmal
  const d6 = liesDb();
  const sieg = belohnungen(d6, ANNA, 'war-victory')[0];
  check('6a: anna (Sieger-Beitragende) bekommt war-victory mit 1200 Krediten, staub 15 und Endstand 30:12',
    !!sieg && sieg.credits === 1200 && sieg.staub === 15 && sieg.enemyTag === 'BBB' && sieg.myScore === 30 && sieg.theirScore === 12,
    sieg || { offen: ((d6.private[ANNA] || {}).__pendingRewards || []).map(r => r.type) });
  check('6b: und der Staub ist am KONTO gebucht - vom Server, nicht vom Client',
    ((d6.users.anna || {}).staub || {}).menge === 15, { staub: (d6.users.anna || {}).staub });
  const trost = belohnungen(d6, CARL, 'war-defeat')[0];
  check('6c: carl (Verlierer-Beitragender) bekommt war-defeat mit 200 Krediten und Endstand 12:30 - und keinen Sieg',
    !!trost && trost.credits === 200 && trost.enemyTag === 'AAA' && trost.myScore === 12 && trost.theirScore === 30 && belohnungen(d6, CARL, 'war-victory').length === 0,
    trost || { offen: ((d6.private[CARL] || {}).__pendingRewards || []).map(r => r.type) });
  check('6d: ben und dora (keine Beitraege im Endstand) bekommen nichts',
    belohnungen(d6, BEN, 'war-victory').length === 0 && belohnungen(d6, BEN, 'war-defeat').length === 0 &&
    belohnungen(d6, DORA, 'war-defeat').length === 0 && !((d6.users.ben || {}).staub || {}).menge);
  const ruhm = d6.galaxy.allianzRuhm || {};
  check('6e: der Kriegsruhm zaehlt - AAA ein Sieg, BBB eine Niederlage',
    !!ruhm.AAA && ruhm.AAA.siege === 1 && ruhm.AAA.niederlagen === 0 && !!ruhm.BBB && ruhm.BBB.niederlagen === 1 && ruhm.BBB.siege === 0, ruhm);
  check('6f: Unentschieden zaehlt beidseitig - ohne Belohnung und ohne Staub',
    !!ruhm.CCC && ruhm.CCC.unentschieden === 1 && !!ruhm.DDD && ruhm.DDD.unentschieden === 1 &&
    belohnungen(d6, EMIL, 'war-victory').length === 0 && belohnungen(d6, EMIL, 'war-defeat').length === 0 &&
    belohnungen(d6, GINA, 'war-victory').length === 0 && !((d6.users.emil || {}).staub || {}).menge,
    { ruhm, emil: ((d6.private[EMIL] || {}).__pendingRewards || []).map(r => r.type) });
  check('6g: alle Kriegsschluessel der beiden Paare sind geraeumt, die Listen leer',
    !Object.keys(d6.shared).some(k => /^alliance:\w+:war(meta|score|contrib):/.test(k)) &&
    kriegsliste(d6, 'AAA').length === 0 && kriegsliste(d6, 'BBB').length === 0 && kriegsliste(d6, 'CCC').length === 0,
    { reste: Object.keys(d6.shared).filter(k => /war/.test(k)) });
  check('6g2: die Galaxie-News melden den Sieg mit Endstand',
    (d6.galaxy.news || []).some(n => /\[AAA\] besiegt \[BBB\] mit 30:12/.test(n.text)), { news: (d6.galaxy.news || []).slice(0, 3).map(n => n.text) });
  s = await starteServer();
  await anmeldenAlle();
  const lage6 = await lage(tok.anna), lage6b = await lage(tok.carl);
  check('6h: GET /api/allianzkrieg nennt den Ruhm beider Seiten',
    lage6.status === 200 && lage6.body.ruhm.siege === 1 && lage6b.status === 200 && lage6b.body.ruhm.niederlagen === 1 && (lage6.body.kriege || []).length === 0,
    { anna: lage6.body && lage6.body.ruhm, carl: lage6b.body && lage6b.body.ruhm });
  await stoppeServer();

  // ---- Auswertung: Gruen-Lauf ODER Gegenprobe --------------------------------------------------
  if (SAB) {
    const soll = MUSS_FALLEN[SAB] || [];
    const gefallen = Object.keys(ergebnis).filter(n => ergebnis[n] === false).sort();
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
