// B2 Vorposten (02.09.2026): spielergebaute PvP-Ziele in db.shared, hinter VORPOSTEN_AKTIV.
//
// GEPRUEFT WERDEN, gegen einen ECHT gestarteten Server (Port 3242, Kopie von server.js mit
// umgelegtem Schalter - sonst antwortet jeder Endpunkt mit 404 und der Test haette keinen Gegenstand):
//   1. RECHTE: Die generische Storage-Route schreibt `vorposten:*` NIE (auch nicht der Besitzer),
//      Lesen bleibt offen; GET /api/vorposten liefert Tabelle und Liste.
//   2. BAUEN: nur mit angekommener Baukolonne im gespeicherten Spielstand, ein Vorposten je System,
//      nicht im Heimatsystem (aus dem Bestenlisten-Eintrag), hoechstens VORPOSTEN_MAX_JE_KONTO.
//   3. STATIONIEREN: nur der Besitzer; der Server nimmt hoechstens an, was der Spielstand am Standort
//      hat, nur Kampfschiffe, bis garnisonMax; Fremde sehen die Zahl, nicht die Zusammensetzung.
//   4. ANGRIFF: Bauschutz, dann Schaden = ANGEKOMMEN (kernVorher - kernNachher), Garnison verliert
//      serverseitig, Abklingzeit AM OBJEKT, eigener Vorposten nicht angreifbar.
//   5. FALL: Dokument weg, Belohnung anteilig an ALLE Beitragenden mit type:'vorposten', der
//      Besitzer bekommt type:'vorposten-verlust' mit der verlorenen Restgarnison.
//   6. AUFGEBEN: nur der Besitzer, Garnison kommt zurueck, keine Rueckerstattung.
//   7. AUSBAU: Abklingzeit am Objekt, Stufe steigt, LP wachsen um die Differenz (kein Heilen), Endausbau.
//   8. SCHALTER: VORPOSTEN_AKTIV steht auf TRUE (seit dem 02.09.2026, Frontend live; vorher der
//      Frontend-PR legt ihn um), der Notaus `vorposten` ist verdrahtet, beide Rechte-Ketten kennen
//      checkVorpostenKeyPermission.
//
// GEGENPROBEN (KEPLER_VP_SABOTAGE, je mit "was fallen MUSS"-Liste, Regel 1/71 - der Lauf exit-0t,
// wenn GENAU die gelisteten Pruefungen fallen, und meldet WERKZEUGFEHLER, wenn eine gruen bleibt):
//   schaden  -> 4c  (der volle Wurf statt des angekommenen Schadens; gemessen: genau 4c)
//   meldung  -> 4h, 4h2 (die Benachrichtigung an den Besitzer entfaellt; gemessen: beide)
//   abkling  -> 4d  (keine Abklingzeit am Objekt; gemessen: genau 4d)
//   rechte   -> 1a  (die Storage-Route schreibt vorposten:* wieder; gemessen: 1a, und als FOLGE 1b/2b -
//                    das per Storage angelegte Dokument fuellt die Liste und macht den Bau zum 409)
//   typ      -> 5b  (die Belohnung traegt einen fremden Typ; gemessen: 5b, und als FOLGE 5c)
//   Alle vier mit identischer Pruefliste (40 Pruefungen + 0-sab), per diff verglichen - eine
//   Pflichtliste ist selbst eine Behauptung, bis die Gegenprobe sie gemessen hat.
//
// Die Kopie liegt im Repo-Verzeichnis (damit require('./mailer') aufloest) und wird am Ende weggeraeumt.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3242;
const QUELLE = path.join(WURZEL, 'server_vptest_tmp.js');
const SAB = process.env.KEPLER_VP_SABOTAGE || '';
// Was bei welcher Sabotage fallen MUSS - gemessen, nicht geschaetzt (Regel 71). Die Listen der zwei
// Zweig-Sabotagen stammen aus dem Lauf vom 02.09.2026: 'zweigwahl' 7e 7f 7g 7h, 'zweigwerte' nur 7g
// (die Wahl greift dort weiter, nur die Multiplikatoren wirken nicht - genau der stille Fall).
const MUSS_FALLEN = { schaden: ['4c'], abkling: ['4d'], rechte: ['1a'], typ: ['5b'], meldung: ['4h', '4h2'],
  zweigwahl: ['7e', '7f', '7g', '7h'], zweigwerte: ['7g'],
  // Etappe 3 (Stationsmodule): Die Listen sind gemessen, siehe Abschnitt 9.
  // GEMESSEN, nicht geschaetzt: Bei 'modulbestand' faellt 9d NICHT - der Einbau gelingt ja weiter,
  // er bucht nur nichts ab. Rot werden die drei Pruefungen, die den Bestand SELBST lesen.
  modulbestand: ['9e', '9e2', '9h'], modulwirkung: ['9f'] };

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
const ANNA = crypto.randomUUID(), BEN = crypto.randomUUID(), CARL = crypto.randomUUID();

function spielstand(id, name) {
  return {
    resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {},
    fleet: { missions: [], cruisers: 300, destroyers: 200, jaeger: 400, schlachtschiff: 80, frachter: 40, colonyShips: 2 },
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  };
}
const FLOTTE = { cruisers: 300, destroyers: 200, jaeger: 400, schlachtschiff: 80 };

function grunddb() {
  return {
    users: {
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: Date.now() },
      carl: { userId: CARL, username: 'carl', passwordHash: hash, createdAt: Date.now() }
    },
    private: {
      [ANNA]: { 'kepler7-save-v3': JSON.stringify(spielstand(ANNA, 'anna')) },
      [BEN]:  { 'kepler7-save-v3': JSON.stringify(spielstand(BEN, 'ben')) },
      [CARL]: { 'kepler7-save-v3': JSON.stringify(spielstand(CARL, 'carl')) }
    },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {}, wrackKonvois: [], a2Verlauf: [] }
  };
}

const SAVE_KEY = 'kepler7-save-v3';
const dbPfad = path.join(os.tmpdir(), 'kepler-vp-' + process.pid + '.json');
let srv = null, s = null, tokA = null, tokB = null, tokC = null;
function ende() {
  try { if (srv) srv.kill(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.unlinkSync(QUELLE); } catch (e) {}   // die Kopie NIE liegen lassen
}
process.on('exit', ende);

async function starteServer() {
  let log = '';
  srv = spawn(process.execPath, [QUELLE], {
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

/* Reihenfolge-Wache (test_festung_http.js): Eine Aenderung an der DB-DATEI bei laufendem Server ist
   beim naechsten SIGTERM wieder weg - der Graceful Shutdown flusht die im Speicher gehaltene db
   darueber. Deshalb: stoppen -> lesen -> aendern -> schreiben -> starten, in EINEM Helfer. */
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  s = await starteServer();
  tokA = await s.anmelden('anna');
  tokB = await s.anmelden('ben');
  tokC = await s.anmelden('carl');
}
/* Der Spielstand liegt in db.private in ZWEI Formen vor (blanke Zeichenkette oder { value, version }). */
function liesSave(d, uid) {
  const roh = d.private[uid][SAVE_KEY];
  if (roh === undefined) return null;
  return JSON.parse(typeof roh === 'string' ? roh : roh.value);
}
function schreibSave(d, uid, sv) {
  const roh = d.private[uid][SAVE_KEY];
  const txt = JSON.stringify(sv);
  d.private[uid][SAVE_KEY] = (roh && typeof roh === 'object') ? { value: txt, version: (roh.version || 0) + 1 } : txt;
}
const liesDoc = (d, sys) => { const raw = d.shared['vorposten:' + sys]; return typeof raw === 'string' ? JSON.parse(raw) : null; };
const schreibDoc = (d, doc) => { d.shared['vorposten:' + doc.sys] = JSON.stringify(doc); };
const doc = (sys, besitzer, name, extra) => Object.assign({
  id: 'vp_' + crypto.randomUUID(), sys, besitzer, besitzerName: name,
  seit: Date.now() - 13 * 3600 * 1000, stufe: 1, kern: { lp: 20000, lpMax: 20000 },
  garnison: {}, schlaege: {}, beitraege: {}, ausbauSeit: Date.now() - 13 * 3600 * 1000, kampfverlauf: []
}, extra || {});
const bauMission = (id, sys) => ({ id, type: 'vorposten-bau', targetId: sys, system: sys,
  startTime: Date.now() - 7200000, endTime: Date.now() - 3600000, fleetName: 'Baukolonne', composition: { colonyShips: 1 } });
const angriffMission = (id, sys) => ({ id, type: 'vorposten-angriff', targetId: sys, system: sys,
  startTime: Date.now() - 7200000, endTime: Date.now() - 3600000, fleetName: 'Flotte 1', composition: Object.assign({}, FLOTTE) });

(async () => {
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  let geflippt = roh.replace(/const VORPOSTEN_AKTIV = (true|false);/, 'const VORPOSTEN_AKTIV = true;');
  check('0-kopie: der Schalter liess sich in der Kopie umlegen',
    /const VORPOSTEN_AKTIV = true;/.test(geflippt), { gefunden: /const VORPOSTEN_AKTIV = (true|false);/.test(roh) });
  // Unabhaengige Anker fuer die Erwartungen (nicht aus der API-Antwort selbst, Regel 62): die
  // Stufentabelle aus dem QUELLTEXT.
  const kernLps = [...roh.matchAll(/kernLp:\s*(\d+)/g)].map(m => Number(m[1]));
  const KERN1 = kernLps[0], KERN2 = kernLps[1];
  const GARN_MAX1 = Number((roh.match(/garnisonMax:\s*(\d+)/) || [])[1]);
  const MAX_JE_KONTO = Number((roh.match(/const VORPOSTEN_MAX_JE_KONTO = (\d+);/) || [])[1]);
  check('0-anker: Stufentabelle und Deckel aus dem Quelltext gelesen',
    KERN1 > 0 && KERN2 > KERN1 && GARN_MAX1 > 0 && MAX_JE_KONTO > 0, { KERN1, KERN2, GARN_MAX1, MAX_JE_KONTO });

  if (SAB) {
    const vorher = geflippt;
    if (SAB === 'schaden') geflippt = geflippt.replace('const schaden = lpVorher - doc.kern.lp;', 'const schaden = wurf;');
    else if (SAB === 'abkling') geflippt = geflippt.replace('    doc.schlaege[t.userId] = jetzt;', '    /* sabotiert: keine Abklingzeit am Objekt */;');
    else if (SAB === 'rechte') geflippt = geflippt.replace("  return 'Vorposten werden ausschließlich über die Vorposten-Endpunkte verändert.';", '  return null;');
    else if (SAB === 'typ') geflippt = geflippt.replace("        type: 'vorposten',           // eigener Typ", "        type: 'alien-nest',          // eigener Typ");
    else if (SAB === 'meldung') geflippt = geflippt.replace("        pushNotificationEvent(doc.besitzer, 'vorposten-angegriffen', {", "        if (false) pushNotificationEvent(doc.besitzer, 'vorposten-angegriffen', {");
    // Die zwei Haelften der Spezialisierung (02.09.2026) einzeln sabotierbar: die WAHL beim Ausbau
    // und die WIRKUNG der Multiplikatoren. Beide zusammen waeren eine Sabotage, die zu viel trifft.
    else if (SAB === 'zweigwahl') geflippt = geflippt.replace('  const brauchtZweig = zielStufe === VORPOSTEN_ZWEIG_AB && !vorpostenZweigOk(doc.zweig);', '  const brauchtZweig = false;');
    else if (SAB === 'zweigwerte') geflippt = geflippt.replace('  if (!z || basis.stufe < VORPOSTEN_ZWEIG_AB) return basis;', '  return basis;');
    // Stationsmodule (02.09.2026), zwei Haelften: der BESTAND (nimmt der Einbau wirklich eines weg?)
    // und die WIRKUNG (aendert ein eingebautes Modul die Werte?).
    else if (SAB === 'modulbestand') geflippt = geflippt.replace('  if (!user || !vpModulNehmen(user, instKey)) return res.status(400)', '  if (!user) return res.status(400)');
    else if (SAB === 'modulwirkung') geflippt = geflippt.replace('  const b = vpModulBoni(doc);', '  const b = { kern:0, verteidigung:0, garnison:0, flug:0, prod:0, scan:0 };');
    else { console.log('unbekannte Sabotage: ' + SAB); process.exit(2); }
    check('0-sab: die Sabotage "' + SAB + '" hat den Quelltext veraendert', geflippt !== vorher, { veraendert: geflippt !== vorher });
  }
  fs.writeFileSync(QUELLE, geflippt);

  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  s = await starteServer();
  tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben'); tokC = await s.anmelden('carl');
  check('0: drei Konten angemeldet', !!tokA && !!tokB && !!tokC);
  if (!tokA || !tokB || !tokC) { console.log(s.protokoll().slice(-1500)); process.exit(1); }
  const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
  const post = (tok, pfad, body) => s.j(pfad, { method: 'POST', headers: kopf(tok), body: JSON.stringify(body) });

  // ---- 1) Rechte -------------------------------------------------------------------------------
  const SYS1 = 'vpsys-a';
  const put = await s.j('/storage/vorposten:' + SYS1 + '?shared=true', { method: 'PUT', headers: kopf(tokA),
    body: JSON.stringify({ value: JSON.stringify(doc(SYS1, ANNA, 'anna')) }) });
  check('1a: die Storage-Route schreibt vorposten:* NICHT (auch nicht fuer den kuenftigen Besitzer)',
    put.status === 403 && /Vorposten-Endpunkte/.test(String(put.body && put.body.error)), { status: put.status, body: put.body });
  const get0 = await s.j('/vorposten', { headers: kopf(tokA) });
  check('1b: GET /api/vorposten antwortet mit aktiv:true und leerer Liste',
    get0.status === 200 && get0.body.aktiv === true && Array.isArray(get0.body.liste) && get0.body.liste.length === 0, get0.body && { aktiv: get0.body.aktiv, n: (get0.body.liste || []).length });
  /* Die Leiter als REGEL, nicht als Momentaufnahme (die Zahl der Stufen waechst, 02.09.2026: 3 -> 8):
     jede Stufe traegt die Pflichtfelder, jede ausser der ersten hat Ausbaukosten, und die Werte
     STEIGEN streng. Ein Ausbau, der nichts verbessert, faellt damit auf. */
  check('1c: die Stufentabelle reist mit - jede Stufe mit kernLp/flug/prod/scan/garnisonMax, Kosten ab Stufe 2',
    Array.isArray(get0.body.stufen) && get0.body.stufen.length >= 3
    && get0.body.stufen.every(st => st.kernLp > 0 && st.flug > 0 && st.prod > 0 && st.scan > 0 && st.garnisonMax > 0)
    && get0.body.stufen.every((st, i) => i === 0 ? st.kosten === null : (st.kosten && Object.keys(st.kosten).length > 0)),
    get0.body.stufen && get0.body.stufen.map(st => st.name));
  check('1c2: die Leiter steigt streng (Kern, Verteidigung, Garnison) - kein Ausbau ohne Gewinn',
    get0.body.stufen.every((st, i) => i === 0 || (st.kernLp > get0.body.stufen[i-1].kernLp && st.verteidigung > get0.body.stufen[i-1].verteidigung && st.garnisonMax > get0.body.stufen[i-1].garnisonMax)),
    get0.body.stufen && get0.body.stufen.map(st => st.kernLp));
  check('1c3: die drei Zweige reisen mit, jeder mit Namen ab der Wahlstufe und Multiplikatoren',
    Array.isArray(get0.body.zweige) && get0.body.zweige.length === 3 && get0.body.zweigAb >= 2
    && get0.body.zweige.every(z => z.key && z.name && z.kurz && z.mult && z.namen && Object.keys(z.namen).length === (get0.body.maxStufe - get0.body.zweigAb + 1)),
    get0.body.zweige && get0.body.zweige.map(z => z.key));
  const lese = await s.j('/storage/vorposten:' + SYS1 + '?shared=true', { headers: kopf(tokB) });
  check('1d: Lesen bleibt offen (kein 403)', lese.status !== 403, { status: lese.status });

  // ---- 2) Bauen --------------------------------------------------------------------------------
  const ohne = await post(tokA, '/vorposten/bauen', { system: SYS1, missionId: 'gibtsnicht' });
  check('2a: ohne angekommene Baukolonne im Spielstand kein Bau', ohne.status === 403, { status: ohne.status, body: ohne.body });
  await aendereDb(d => {
    const sv = liesSave(d, ANNA); sv.fleet.missions = [bauMission('b1', SYS1)]; schreibSave(d, ANNA, sv);
    const sb = liesSave(d, BEN); sb.fleet.missions = [bauMission('b2', SYS1)]; schreibSave(d, BEN, sb);
  });
  const bau = await post(tokA, '/vorposten/bauen', { system: SYS1, missionId: 'b1' });
  check('2b: mit Baukolonne entsteht ein Feldlager mit dem Kern der ersten Stufe',
    bau.status === 200 && bau.body.ok === true && bau.body.vorposten && bau.body.vorposten.stufe === 1 && bau.body.vorposten.kern.lpMax === KERN1,
    bau.body && (bau.body.vorposten ? { stufe: bau.body.vorposten.stufe, lpMax: bau.body.vorposten.kern.lpMax } : bau.body));
  const belegt = await post(tokB, '/vorposten/bauen', { system: SYS1, missionId: 'b2' });
  check('2c: ein Vorposten je System - der zweite Bau dort wird mit 409 abgewiesen', belegt.status === 409 && belegt.body.belegt === true, { status: belegt.status });
  let d2 = null;
  await aendereDb(d => {
    d2 = liesDoc(d, SYS1);
    // Heimatsystem aus dem Bestenlisten-Eintrag; dazu zwei weitere Vorposten fuer den Deckel.
    d.shared['leaderboard:' + ANNA] = JSON.stringify({ name: 'anna', homeSystem: 'heim-a', score: 1 });
    schreibDoc(d, doc('vpsys-b', ANNA, 'anna')); schreibDoc(d, doc('vpsys-c', ANNA, 'anna'));
    const sv = liesSave(d, ANNA); sv.fleet.missions = [bauMission('b3', 'heim-a'), bauMission('b4', 'vpsys-d')]; schreibSave(d, ANNA, sv);
  });
  check('2d: das Dokument liegt in db.shared unter vorposten:<sys> mit dem Besitzer', !!d2 && d2.besitzer === ANNA && d2.stufe === 1, d2 && { besitzer: d2.besitzer === ANNA, stufe: d2.stufe });
  const heim = await post(tokA, '/vorposten/bauen', { system: 'heim-a', missionId: 'b3' });
  check('2e: im eigenen Heimatsystem (Bestenlisten-Eintrag) kein Bau', heim.status === 400 && heim.body.heimat === true, { status: heim.status, body: heim.body });
  const deckel = await post(tokA, '/vorposten/bauen', { system: 'vpsys-d', missionId: 'b4' });
  check('2f: hoechstens VORPOSTEN_MAX_JE_KONTO Vorposten je Konto', deckel.status === 400 && deckel.body.deckel === true && deckel.body.max === MAX_JE_KONTO, { status: deckel.status, body: deckel.body });

  // ---- 3) Stationieren -------------------------------------------------------------------------
  const st1 = await post(tokA, '/vorposten/stationieren', { system: SYS1, planetKey: 'home', composition: { cruisers: 50, frachter: 10 } });
  check('3a: der Besitzer stationiert Kampfschiffe; Frachter werden NICHT angenommen (kein sicherer Hafen)',
    st1.status === 200 && st1.body.angenommen && st1.body.angenommen.cruisers === 50 && st1.body.angenommen.frachter === undefined, st1.body && st1.body.angenommen);
  const st2 = await post(tokA, '/vorposten/stationieren', { system: SYS1, planetKey: 'home', composition: { cruisers: 10000 } });
  check('3b: angenommen wird hoechstens Bestand UND freier Platz bis garnisonMax',
    st2.status === 200 && st2.body.angenommen && st2.body.angenommen.cruisers === Math.min(300, GARN_MAX1 - 50), { angenommen: st2.body && st2.body.angenommen, erwartet: Math.min(300, GARN_MAX1 - 50) });
  const fremd = await post(tokB, '/vorposten/stationieren', { system: SYS1, planetKey: 'home', composition: { cruisers: 5 } });
  check('3c: ein Fremder kann dort nicht stationieren', fremd.status === 403, { status: fremd.status });
  const gA = await s.j('/vorposten', { headers: kopf(tokA) });
  const gB = await s.j('/vorposten', { headers: kopf(tokB) });
  const eigenA = (gA.body.liste || []).find(x => x.sys === SYS1) || {};
  const fremdB = (gB.body.liste || []).find(x => x.sys === SYS1) || {};
  check('3d: der Besitzer sieht die Zusammensetzung, der Fremde nur die Zahl',
    eigenA.eigener === true && eigenA.garnison && eigenA.garnison.cruisers === GARN_MAX1 && fremdB.eigener === false && fremdB.garnison === undefined && fremdB.garnisonAnzahl === GARN_MAX1,
    { eigen: eigenA.garnison, fremdZahl: fremdB.garnisonAnzahl, fremdListe: fremdB.garnison });
  check('3e: die Garnison hebt die Verteidigung ueber die der blossen Struktur',
    eigenA.verteidigung > get0.body.stufen[0].verteidigung, { verteidigung: eigenA.verteidigung, struktur: get0.body.stufen[0].verteidigung });

  // ---- 4) Angriff ------------------------------------------------------------------------------
  await aendereDb(d => {
    const sb = liesSave(d, BEN); sb.fleet.missions = [angriffMission('m1', SYS1), angriffMission('m2', SYS1)]; schreibSave(d, BEN, sb);
    const sc = liesSave(d, CARL); sc.fleet.missions = [angriffMission('m3', SYS1)]; schreibSave(d, CARL, sc);
    const dd = liesDoc(d, SYS1); dd.seit = Date.now() - 60000; schreibDoc(d, dd);   // frisch gebaut -> Bauschutz
  });
  const schutz = await post(tokB, '/vorposten/angriff', { system: SYS1, missionId: 'm1' });
  check('4a: unter Bauschutz kein Angriff (403, schutzBis genannt)', schutz.status === 403 && schutz.body.schutz === true && schutz.body.schutzBis > Date.now(), { status: schutz.status, body: schutz.body });
  let garnVorher = 0, lpVorher4b = 0;
  await aendereDb(d => {
    const dd = liesDoc(d, SYS1); dd.seit = Date.now() - 13 * 3600 * 1000;
    dd.kern = { lp: 900000, lpMax: 900000 };                        // faellt in 4b sicher NICHT
    garnVorher = Object.values(dd.garnison).reduce((a, n) => a + n, 0);
    lpVorher4b = dd.kern.lp;
    schreibDoc(d, dd);
  });
  const r4 = await post(tokB, '/vorposten/angriff', { system: SYS1, missionId: 'm1' });
  check('4b: der Schlag wird angenommen, richtet Schaden an und nennt eigene Verluste',
    r4.status === 200 && r4.body.ok === true && r4.body.schaden > 0 && r4.body.gefallen === false && Object.keys(r4.body.eigeneVerluste || {}).length > 0,
    r4.body && { status: r4.status, schaden: r4.body.schaden, lp: r4.body.lp, verluste: r4.body.eigeneVerluste });
  check('4b2: angekommen = kernVorher - kernNachher (auch ohne Fall)', r4.body.schaden === lpVorher4b - r4.body.lp, { schaden: r4.body.schaden, lpVorher: lpVorher4b, lp: r4.body.lp });
  let garnNachher = -1, docNach4b = null;
  await aendereDb(d => { docNach4b = liesDoc(d, SYS1); garnNachher = Object.values(docNach4b.garnison).reduce((a, n) => a + n, 0); });
  check('4f: die Garnison hat serverseitig verloren (im Dokument, nicht in einem Spielstand)',
    garnNachher < garnVorher && Object.keys(r4.body.garnisonVerluste || {}).length > 0, { vorher: garnVorher, nachher: garnNachher, gemeldet: r4.body.garnisonVerluste });
  check('4g: der Kampfvermerk steht am Objekt (letzterKampf mit Angreifer und Schaden)',
    !!docNach4b.letzterKampf && docNach4b.letzterKampf.angreifer === BEN && docNach4b.letzterKampf.schaden === r4.body.schaden, docNach4b.letzterKampf);
  /* 4h: DER BESITZER ERFAEHRT ES - bei diesem Schlag, nicht erst beim Fall. Das ist die
     Verteidigungs-Zusage des Konzepts (§2.6): Er soll mit einer Garnison gegenhalten koennen,
     und dafuer muss er den ERSTEN Schlag mitbekommen. Der Kampfvermerk (4g) steht nur im
     Dokument - sichtbar erst, wenn er das Kartenmenue oeffnet.
     Gemessen wird der Postfach-Eintrag in db.private[uid].__notificationEvents, nicht der
     Handy-Versand (der ist Feuer-und-Vergessen und in einem Test ohne VAPID-Schluessel ohnehin
     stumm) - und der TEXT wird mitgeprueft, denn eine Meldung ohne Kernstand nimmt dem Besitzer
     genau die Zahl, an der er die Dringlichkeit ablesen soll (Regel 28). */
  const meldungen = (liesDb().private[ANNA] || {}).__notificationEvents || [];
  const vpMeldung = meldungen.find(m => m.type === 'vorposten-angegriffen');
  check('4h: der Besitzer bekommt eine Meldung ueber den Angriff - beim Schlag, nicht erst beim Fall',
    !!vpMeldung && vpMeldung.payload.gefallen === false && vpMeldung.payload.angreiferName === 'ben',
    { gefunden: !!vpMeldung, payload: vpMeldung && vpMeldung.payload,
      hinweis: 'ohne sie erfaehrt er erst vom Verlust und kann nie reagieren' });
  check('4h2: und sie nennt den Kernstand, an dem er die Dringlichkeit ablesen kann',
    !!vpMeldung && typeof vpMeldung.payload.kernProzent === 'number' && vpMeldung.payload.kernProzent > 0 && vpMeldung.payload.kernProzent < 100,
    vpMeldung && { kernProzent: vpMeldung.payload.kernProzent, name: vpMeldung.payload.name, system: vpMeldung.payload.system });
  const r4d = await post(tokB, '/vorposten/angriff', { system: SYS1, missionId: 'm2' });
  check('4d: Abklingzeit AM OBJEKT - der zweite Schlag desselben Kontos wird abgewiesen', r4d.status === 403 && r4d.body.abklingzeit === true, { status: r4d.status, body: r4d.body });
  await aendereDb(d => { const sa = liesSave(d, ANNA); sa.fleet.missions = [angriffMission('m9', SYS1)]; schreibSave(d, ANNA, sa); });
  const eigen = await post(tokA, '/vorposten/angriff', { system: SYS1, missionId: 'm9' });
  check('4e: den eigenen Vorposten greift man nicht an', eigen.status === 400, { status: eigen.status, body: eigen.body });
  // 4c: der ANGEKOMMENE Schaden - gemessen dort, wo der Deckel greift (Regel 7): kern.lp = 500,
  // jeder Wurf liegt weit darueber. Mit dem vollen Wurf stuende hier eine fuenfstellige Zahl.
  await aendereDb(d => { const dd = liesDoc(d, SYS1); dd.kern.lp = 500; schreibDoc(d, dd); });
  const r4c = await post(tokC, '/vorposten/angriff', { system: SYS1, missionId: 'm3' });
  check('4c: gezaehlt wird, was ANGEKOMMEN ist - bei 500 Rest-LP genau 500, nicht der Wurf',
    r4c.status === 200 && r4c.body.gefallen === true && r4c.body.schaden === 500, r4c.body && { status: r4c.status, schaden: r4c.body.schaden, gefallen: r4c.body.gefallen });

  // ---- 5) Fall ---------------------------------------------------------------------------------
  let nachFall = null, belohnungB = null, belohnungC = null, verlustA = null;
  await aendereDb(d => {
    nachFall = liesDoc(d, SYS1);
    belohnungB = (d.private[BEN].__pendingRewards || []).find(r => r.type === 'vorposten') || null;
    belohnungC = (d.private[CARL].__pendingRewards || []).find(r => r.type === 'vorposten') || null;
    verlustA = (d.private[ANNA].__pendingRewards || []).find(r => r.type === 'vorposten-verlust') || null;
  });
  check('5a: das Dokument ist nach dem Fall weg', nachFall === null, { doc: nachFall && nachFall.id });
  check('5b: der letzte Angreifer bekommt eine Belohnung mit EIGENEM type vorposten und Anteil',
    !!belohnungC && belohnungC.anteil > 0 && belohnungC.kampfpunkte > 0 && belohnungC.credits > 0, belohnungC);
  check('5c: auch der fruehere Beitragende (ben) ist dabei, die Anteile summieren sich zu 1',
    !!belohnungB && belohnungB.anteil > 0 && Math.abs((belohnungB.anteil + belohnungC.anteil) - 1) < 0.003, { ben: belohnungB && belohnungB.anteil, carl: belohnungC && belohnungC.anteil });
  check('5d: der Besitzer erfaehrt vom Verlust (vorposten-verlust mit Restgarnison)',
    !!verlustA && verlustA.system === SYS1 && verlustA.garnisonVerloren && typeof verlustA.garnisonVerloren === 'object', verlustA);

  // ---- 6) Aufgeben -----------------------------------------------------------------------------
  const SYS6 = 'vpsys-f';
  await aendereDb(d => { schreibDoc(d, doc(SYS6, ANNA, 'anna', { garnison: { cruisers: 40 } })); });
  const fremdAuf = await post(tokB, '/vorposten/aufgeben', { system: SYS6 });
  check('6a: ein Fremder kann nicht aufgeben', fremdAuf.status === 403, { status: fremdAuf.status });
  const auf = await post(tokA, '/vorposten/aufgeben', { system: SYS6 });
  let nach6 = 'unbekannt';
  await aendereDb(d => { nach6 = liesDoc(d, SYS6); });
  check('6b: der Besitzer gibt auf - Garnison kommt zurueck, keine Rueckerstattung, Dokument weg',
    auf.status === 200 && auf.body.garnison && auf.body.garnison.cruisers === 40 && auf.body.rueckerstattung === 0 && nach6 === null, { body: auf.body, docDanach: nach6 });

  // ---- 7) Ausbau -------------------------------------------------------------------------------
  const SYS7 = 'vpsys-g';
  await aendereDb(d => { schreibDoc(d, doc(SYS7, ANNA, 'anna', { kern: { lp: 10000, lpMax: KERN1 }, ausbauSeit: Date.now() })); });
  const zuFrueh = await post(tokA, '/vorposten/ausbauen', { system: SYS7 });
  check('7a: Ausbau hat eine Abklingzeit am Objekt', zuFrueh.status === 400 && zuFrueh.body.abklingzeit === true, { status: zuFrueh.status, body: zuFrueh.body });
  await aendereDb(d => { const dd = liesDoc(d, SYS7); dd.ausbauSeit = Date.now() - 13 * 3600 * 1000; schreibDoc(d, dd); });
  const aus = await post(tokA, '/vorposten/ausbauen', { system: SYS7 });
  check('7b: Stufe 2 - das Maximum ist das der zweiten Stufe, die LP wachsen um die DIFFERENZ (kein Heilen)',
    aus.status === 200 && aus.body.vorposten.stufe === 2 && aus.body.vorposten.kern.lpMax === KERN2 && aus.body.vorposten.kern.lp === 10000 + (KERN2 - KERN1),
    aus.body && aus.body.vorposten && { stufe: aus.body.vorposten.stufe, lp: aus.body.vorposten.kern.lp, lpMax: aus.body.vorposten.kern.lpMax, erwartetLp: 10000 + (KERN2 - KERN1) });
  const fremdAus = await post(tokB, '/vorposten/ausbauen', { system: SYS7 });
  check('7c: ein Fremder kann nicht ausbauen', fremdAus.status === 403, { status: fremdAus.status });
  // ---- 7e-7h) Die Zweigwahl faellt beim Sprung auf die Wahlstufe, einmalig -----------------------
  const maxStufe = get0.body.maxStufe, zweigAb = get0.body.zweigAb;
  await aendereDb(d => { const dd = liesDoc(d, SYS7); dd.stufe = zweigAb - 1; delete dd.zweig; dd.ausbauSeit = Date.now() - 13 * 3600 * 1000; schreibDoc(d, dd); });
  const ohneZweig = await post(tokA, '/vorposten/ausbauen', { system: SYS7 });
  check('7e: der Ausbau auf die Wahlstufe verlangt eine Ausrichtung und nennt die drei Zweige',
    ohneZweig.status === 400 && ohneZweig.body.zweigNoetig === true && (ohneZweig.body.zweige || []).length === 3,
    { status: ohneZweig.status, zweige: (ohneZweig.body.zweige || []).map(z => z.key) });
  const falsch = await post(tokA, '/vorposten/ausbauen', { system: SYS7, zweig: 'gibtsnicht' });
  check('7f: ein erfundener Zweig wird abgelehnt', falsch.status === 400 && falsch.body.zweigNoetig === true, { status: falsch.status });
  const mitZweig = await post(tokA, '/vorposten/ausbauen', { system: SYS7, zweig: 'festung' });
  const basisWahl = get0.body.stufen[zweigAb - 1];
  check('7g: mit Ausrichtung geht der Ausbau durch - der Zweig steht im Dokument und praegt Namen und Werte',
    mitZweig.status === 200 && mitZweig.body.vorposten.zweig === 'festung'
    && mitZweig.body.vorposten.name !== basisWahl.name
    && mitZweig.body.vorposten.kern.lpMax > basisWahl.kernLp,   // Festungsring: dickerer Kern als die Leiter
    mitZweig.body && mitZweig.body.vorposten && { zweig: mitZweig.body.vorposten.zweig, name: mitZweig.body.vorposten.name, lpMax: mitZweig.body.vorposten.kern.lpMax, leiter: basisWahl.kernLp });
  await aendereDb(d => { const dd = liesDoc(d, SYS7); dd.ausbauSeit = Date.now() - 13 * 3600 * 1000; schreibDoc(d, dd); });
  const zweitWahl = await post(tokA, '/vorposten/ausbauen', { system: SYS7, zweig: 'handel' });
  check('7h: die Ausrichtung ist unveraenderlich - ein spaeter mitgeschickter Zweig aendert nichts',
    zweitWahl.status === 200 && zweitWahl.body.vorposten.zweig === 'festung', zweitWahl.body && zweitWahl.body.vorposten && { zweig: zweitWahl.body.vorposten.zweig, stufe: zweitWahl.body.vorposten.stufe });
  await aendereDb(d => { const dd = liesDoc(d, SYS7); dd.stufe = maxStufe; dd.ausbauSeit = Date.now() - 13 * 3600 * 1000; schreibDoc(d, dd); });
  const voll = await post(tokA, '/vorposten/ausbauen', { system: SYS7, zweig: 'festung' });
  check('7d: nach dem Endausbau (letzte Stufe der Leiter) kein weiterer', voll.status === 400 && voll.body.endausbau === true, { status: voll.status, maxStufe });

  // ---- 8) Der Schalter ist der Auslieferungs-Riegel ---------------------------------------------
  {
    const schalter = (roh.match(/const VORPOSTEN_AKTIV = (true|false);/) || [])[1];
    check('8a: der Schalter ist auffindbar', !!schalter, { steht_auf: schalter });
    check('8b: und er steht auf TRUE (Frontend mit dem Vorposten-Zweig ausgeliefert - false waere eine Notabschaltung, deren Grund nach docs/vorposten.md gehoert)',
      schalter === 'true', { steht_auf: schalter, hinweis: 'umgelegt am 02.09.2026 unmittelbar nach dem Frontend-Merge; der Admin-Notaus stoppt nur den BAU' });
    check('8c: der Admin-Notaus kennt vorposten (NOTAUS_NAMEN und spawnAktivImCode)',
      /vorposten:\s*'Neue Vorposten werden errichtet'/.test(roh) && roh.includes("if (name === 'vorposten') return VORPOSTEN_AKTIV;") && roh.includes("if (!spawnAktiv('vorposten'))"));
    check('8d: BEIDE Rechte-Ketten der Storage-Route kennen checkVorpostenKeyPermission',
      roh.includes('checkVorpostenKeyPermission(req, key, false)') && roh.includes('checkVorpostenKeyPermission(req, key, true)'));
  }

  // ---- 9) Stationsmodule: Bestand, Bau, Einbau, Ausbau, Wirkung ---------------------------------
  {
    const SYS9 = 'vpsys-i';
    const modKey = get0.body.modulDefs[1].key;          // 'geschuetz' - wirkt auf die Verteidigung
    const instKey = modKey + ':selten';
    check('9-anker: der Modulkatalog reist mit (Definitionen, Seltenheiten, was baubar ist)',
      Array.isArray(get0.body.modulDefs) && get0.body.modulDefs.length >= 4
      && get0.body.modulSeltenheiten && get0.body.modulSeltenheiten.selten
      && Array.isArray(get0.body.modulBaubar) && get0.body.modulBaubar.indexOf('legendaer') < 0,
      { defs: (get0.body.modulDefs||[]).map(d => d.key), baubar: get0.body.modulBaubar });
    // Ein Vorposten AUF der Wahlstufe, damit es ueberhaupt einen Steckplatz gibt.
    // Eine Stufe UEBER der Wahlstufe: zwei Steckplaetze. Mit nur einem scheiterte der zweite
    // Einbau am vollen Vorposten statt am leeren Bestand - die Pruefung 9e2 haette dann etwas
    // anderes gemessen als ihr Name sagt (erster Entwurf, im Lauf aufgefallen).
    await aendereDb(d => { const dd = doc(SYS9, ANNA, 'anna'); dd.stufe = get0.body.zweigAb + 1; dd.zweig = 'festung'; schreibDoc(d, dd); });
    const bau1 = await post(tokA, '/vorposten/modul/bauen', { modul: modKey, seltenheit: 'selten' });
    check('9a: bauen laesst sich nur bis „ungewoehnlich" - „selten" wird abgelehnt und sagt warum',
      bau1.status === 400 && bau1.body.nurFund === true && /Festungen, Nestern und Konvois/.test(String(bau1.body.error)), { status: bau1.status, body: bau1.body });
    const bau2 = await post(tokA, '/vorposten/modul/bauen', { modul: modKey, seltenheit: 'ungewoehnlich' });
    check('9b: ein baubares Modul landet im Bestand am NUTZEROBJEKT (nicht im Spielstand)',
      bau2.status === 200 && bau2.body.bestand && bau2.body.bestand[modKey + ':ungewoehnlich'] === 1, bau2.body && bau2.body.bestand);
    const bau3 = await post(tokA, '/vorposten/modul/bauen', { modul: modKey, seltenheit: 'gewoehnlich' });
    check('9c: die Schmiede hat eine Abklingzeit - sonst waere der Bau eine Endlosquelle',
      bau3.status === 400 && bau3.body.abklingzeit === true && bau3.body.bauAb > Date.now(), { status: bau3.status, body: bau3.body });

    // Einbauen: das Modul muss aus dem Bestand VERSCHWINDEN und im Dokument stehen.
    await aendereDb(d => { d.users.anna.vpModule = { [instKey]: 1 }; });
    const ein = await post(tokA, '/vorposten/modul/einbauen', { system: SYS9, modul: instKey });
    check('9d: einbauen steckt das Modul in den Vorposten', ein.status === 200 && (ein.body.vorposten.module || []).indexOf(instKey) === 0,
      { status: ein.status, module: ein.body.vorposten && ein.body.vorposten.module });
    check('9e: und nimmt es aus dem Bestand (kein Modul zweimal)', ein.status === 200 && !(ein.body.bestand || {})[instKey], ein.body && ein.body.bestand);
    const ohne = await post(tokA, '/vorposten/modul/einbauen', { system: SYS9, modul: instKey });
    check('9e2: ein zweiter Einbau desselben Stuecks scheitert am leeren BESTAND (nicht an den Slots)',
      ohne.status === 400 && /Bestand/.test(String(ohne.body && ohne.body.error)) && ohne.body.voll !== true,
      { status: ohne.status, body: ohne.body });

    // Wirkung: die Geschuetzbank hebt die Verteidigung UEBER den Stufenwert.
    const nurStufe = get0.body.stufen[get0.body.zweigAb].verteidigung;   // eine Stufe ueber der Wahlstufe, siehe oben
    check('9f: das eingebaute Modul hebt die Verteidigung ueber den reinen Stufenwert',
      ein.body.vorposten.verteidigung > nurStufe && ein.body.vorposten.modulBoni && ein.body.vorposten.modulBoni.verteidigung > 0,
      { verteidigung: ein.body.vorposten.verteidigung, nurStufe, boni: ein.body.vorposten.modulBoni });
    check('9g: die Steckplatzzahl kommt vom Server und waechst mit der Stufe (hier zwei)',
      ein.body.vorposten.slots === 2, ein.body.vorposten.slots);

    // Ausbauen kostet eine Kleinigkeit - und gibt das Modul heil zurueck.
    let krediteVorher = 0;
    await aendereDb(d => { const s = JSON.parse(d.private[ANNA]['kepler7-save-v3']); s.credits = 1000; krediteVorher = s.credits; d.private[ANNA]['kepler7-save-v3'] = JSON.stringify(s); });
    const raus = await post(tokA, '/vorposten/modul/ausbauen', { system: SYS9, platz: 0 });
    check('9h: ausbauen gibt das Modul heil in den Bestand zurueck',
      raus.status === 200 && raus.body.modul === instKey && (raus.body.bestand || {})[instKey] === 1 && (raus.body.vorposten.module || []).length === 0,
      { status: raus.status, modul: raus.body.modul, bestand: raus.body.bestand });
    check('9i: und kostet eine Kleinigkeit (Kredite aus dem Spielstand, zurueckgemeldet)',
      raus.body.kosten === get0.body.modulAusbauKosten && raus.body.newCredits === krediteVorher - get0.body.modulAusbauKosten,
      { kosten: raus.body.kosten, vorher: krediteVorher, nachher: raus.body.newCredits });
    const fremd = await post(tokB, '/vorposten/modul/einbauen', { system: SYS9, modul: instKey });
    check('9j: ein Fremder bestueckt den Vorposten nicht', fremd.status === 403, { status: fremd.status });
  }

  await stoppeServer();

  // ---- Auswertung: Gruen-Lauf ODER Gegenprobe (Regel 71) --------------------------------------
  if (SAB) {
    const soll = MUSS_FALLEN[SAB] || [];
    const nichtGefallen = soll.filter(kurz => {
      const treffer = Object.keys(ergebnis).filter(n => n === kurz || n.startsWith(kurz + ':'));
      return !treffer.some(n => ergebnis[n] === false);
    });
    if (nichtGefallen.length) {
      console.log('\nWERKZEUGFEHLER - diese Pruefung(en) haetten bei Sabotage "' + SAB + '" fallen MUESSEN, blieben aber gruen: ' + JSON.stringify(nichtGefallen));
      process.exit(1);
    }
    console.log('\nGegenprobe "' + SAB + '" korrekt: genau ' + JSON.stringify(soll) + ' gefallen.');
    process.exit(0);
  }
  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})();
