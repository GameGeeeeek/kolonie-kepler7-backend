// Das Lager am Vorposten und die Beute beim Fall (Etappe V4, 03.09.2026).
//
// Auftrag Sascha: alle Punkte der Vorposten-Auswahl umsetzen. Bis hierher war ein Vorposten ein
// Bonus auf Zahlen - man flog nie hin, holte nie etwas ab, und sein Verlust kostete nur diesen
// Bonus. Jetzt sammelt er, und wer ihn stuermt, nimmt das Lager mit.
//
// DREI DINGE SIND DIE GANZE MECHANIK, und alle drei werden hier gemessen:
//   1. KEIN TICKEN - der Stand wird aus der verstrichenen Zeit GERECHNET (Abschnitt 2).
//   2. DER DECKEL   - nach VP_LAGER_STUNDEN ist Schluss, sonst waere ein vergessener Vorposten
//                     eine Bank, die mit der Abwesenheit waechst (2b).
//   3. DIE BEUTE    - beim Fall wandert das Lager nach Schadensanteil an die Angreifer (4a).
//
// Gegenprobe: siehe Fuss der Datei.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3257;
const QUELLE = path.join(WURZEL, 'server_vplager_tmp.js');
const SAB = process.env.KEPLER_VPLAGER_SABOTAGE || '';
// Was bei welcher Sabotage fallen MUSS - GEMESSEN, nicht geschaetzt (die Listen stehen am Fuss).
/* GEMESSEN am 03.09.2026. `schalter` bricht die Gatterung in vorpostenLagerRate und reisst
   deshalb nur 5a mit: 5b prueft den EIGENEN Riegel des Abhol-Endpunkts, und der ist mit Absicht
   eine zweite Stelle - er gibt eine verstaendliche Auskunft („Vorposten fuehren derzeit kein
   Lager") statt der irrefuehrenden „Im Lager liegt noch nichts". */
const MUSS_FALLEN = { deckel: ['2b'], zurueckdrehen: ['3a'], beute: ['4a'], schalter: ['5a'] };

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
const dbPfad = path.join(os.tmpdir(), 'kepler-vplager-' + process.pid + '.json');
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
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {}, wrackKonvois: [], a2Verlauf: [] }
  };
}
const vpDoc = (sys, stufe, zweig, extra) => Object.assign({ id: 'vp_' + crypto.randomUUID(), sys,
  besitzer: ANNA, besitzerName: 'anna', seit: Date.now() - 30 * 24 * 3600 * 1000,
  stufe, zweig, kern: { lp: 20000, lpMax: 20000 }, garnison: {}, schlaege: {}, beitraege: {},
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
const liesDoc = (d, sys) => JSON.parse(d.shared['vorposten:' + sys]);
const schreibDoc = (d, doc) => { d.shared['vorposten:' + doc.sys] = JSON.stringify(doc); };
const liesSave = (d, uid) => { const r = d.private[uid]['kepler7-save-v3']; return JSON.parse(typeof r === 'string' ? r : r.value); };
const schreibSave = (d, uid, sv) => { const r = d.private[uid]['kepler7-save-v3']; const t = JSON.stringify(sv);
  d.private[uid]['kepler7-save-v3'] = (r && typeof r === 'object') ? { value: t, version: (r.version || 0) + 1 } : t; };

(async () => {
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  /* ANKER aus dem QUELLTEXT. Die Leiter, die Zweig-Multiplikatoren, der Deckel und die drei
     Foerderanteile - nichts davon aus der Antwort, die geprueft werden soll. */
  const leiter = [...roh.matchAll(/\{ stufe: (\d), name: '[^']*',[^}]*lager: (\d+),/g)].map(m => Number(m[2]));
  const multHandel = Number((roh.match(/key: 'handel',[\s\S]{0,500}?lager: ([\d.]+) \}/) || [])[1]);
  const multFestung = Number((roh.match(/key: 'festung',[\s\S]{0,500}?lager: ([\d.]+) \}/) || [])[1]);
  const stunden = Number((roh.match(/const VP_LAGER_STUNDEN = (\d+);/) || [])[1]);
  const anteile = JSON.parse((roh.match(/const VP_LAGER_ANTEILE = (\{[^}]*\});/) || [])[1]
    .replace(/([a-z]+):/g, '"$1":'));
  const summeAnteile = anteile.erz + anteile.kristalle + anteile.deuterium;
  const rateVon = (stufe, mult) => {
    const basis = Math.round(leiter[stufe - 1] * mult);
    const aus = {};
    for (const k of Object.keys(anteile)) aus[k] = Math.round(basis * anteile[k] / summeAnteile);
    return aus;
  };
  check('0a: Leiter, Multiplikatoren, Deckel und Foerderanteile sind im Quelltext auffindbar',
    leiter.length === 8 && multHandel > 0 && multFestung > 0 && stunden > 0 && summeAnteile > 0,
    { stufen: leiter.length, handel: multHandel, festung: multFestung, stunden, anteile });

  let basis = roh.replace(/const VORPOSTEN_AKTIV = (true|false);/, 'const VORPOSTEN_AKTIV = true;');
  if (SAB === 'deckel') basis = basis.replace('Math.max(0, Math.min(VP_LAGER_STUNDEN, (t - seit) / 3600000))', 'Math.max(0, (t - seit) / 3600000)');
  if (SAB === 'zurueckdrehen') basis = basis.replace('  doc.lagerSeit = jetzt;', '  doc.lagerSeit = (doc.lagerSeit || doc.seit || jetzt);');
  if (SAB === 'beute') basis = basis.replace(/lagerBeute: lagerBeimFall \? [^\n]*,\n/, 'lagerBeute: null,\n');
  if (SAB === 'schalter') basis = basis.replace('const basis = VP_LAGER_AKTIV ? (st.lager || 0) : 0;', 'const basis = (st.lager || 0);');
  const an = basis.replace(/const VP_LAGER_AKTIV = (true|false);/, 'const VP_LAGER_AKTIV = true;');
  check('0b: der Lager-Schalter liess sich in der Kopie umlegen', /const VP_LAGER_AKTIV = true;/.test(an),
    { gefunden: /const VP_LAGER_AKTIV = (true|false);/.test(roh) });

  // ---- 1) Die Rate ------------------------------------------------------------------------------
  fs.writeFileSync(QUELLE, an);
  const db = grunddb();
  const jetzt = Date.now();
  db.shared['vorposten:h-acht'] = JSON.stringify(vpDoc('h-acht', 8, 'handel', { lagerSeit: jetzt }));
  db.shared['vorposten:f-acht'] = JSON.stringify(vpDoc('f-acht', 8, 'festung', { lagerSeit: jetzt }));
  fs.writeFileSync(dbPfad, JSON.stringify(db, null, 1));
  let s = await starteServer();
  let tokA = await s.anmelden('anna'), tokB = await s.anmelden('ben');
  const kat = await s.hole('/vorposten', tokA);
  const vpVon = (sys) => (kat.body.liste || []).find(x => x.sys === sys) || {};
  check('1a: der Katalog nennt Schalter und Deckel',
    kat.status === 200 && kat.body.lagerAktiv === true && kat.body.lagerStunden === stunden,
    { aktiv: kat.body.lagerAktiv, stunden: kat.body.lagerStunden });
  check('1b: die Foerderrate steht am Vorposten und stimmt mit Stufe und Ausrichtung ueberein',
    JSON.stringify(vpVon('h-acht').lagerRate) === JSON.stringify(rateVon(8, multHandel)),
    { gemessen: vpVon('h-acht').lagerRate, erwartet: rateVon(8, multHandel) });
  check('1c: der Handelsknoten foerdert deutlich mehr als ein Festungsring derselben Stufe',
    vpVon('h-acht').lagerRate.erz > vpVon('f-acht').lagerRate.erz * 2,
    { handel: vpVon('h-acht').lagerRate.erz, festung: vpVon('f-acht').lagerRate.erz });
  /* „Leer" heisst hier nicht „exakt null": Zwischen dem Schreiben der DB-Datei und der Anfrage
     vergehen Sekunden, und das Lager RECHNET (genau das ist die Mechanik) - es sammelt in dieser
     Zeit weiter. Geprueft wird die Regel: weit unter einer Stundenrate. */
  check('1d: ein frisch geleerter Vorposten hat ein praktisch leeres Lager',
    Object.keys(rateVon(8, multHandel)).every(k => vpVon('h-acht').lager[k] < rateVon(8, multHandel)[k] / 60),
    { lager: vpVon('h-acht').lager, einStundenwert: rateVon(8, multHandel) });

  // ---- 2) Kein Ticken, sondern Rechnen - und der Deckel -----------------------------------------
  /* Der Stand wird NICHT hochgezaehlt, sondern aus `lagerSeit` gerechnet. Genau deshalb laesst sich
     er durch Rueckdatieren pruefen, ohne zu warten - und genau deshalb gibt es keinen
     Zustandsuebergang, der bei einem Absturz verlorengehen koennte. */
  s = await aendereDb(d => { const dd = liesDoc(d, 'h-acht'); dd.lagerSeit = Date.now() - 3 * 3600 * 1000; schreibDoc(d, dd); });
  tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  const nach3 = ((await s.hole('/vorposten', tokA)).body.liste || []).find(x => x.sys === 'h-acht');
  const rate8 = rateVon(8, multHandel);
  check('2a: nach drei Stunden liegt das Dreifache der Stundenrate im Lager', (() => {
    return Object.keys(rate8).every(k => Math.abs(nach3.lager[k] - rate8[k] * 3) <= rate8[k] / 360 + 2);
  })(), { gemessen: nach3.lager, erwartet: Object.fromEntries(Object.entries(rate8).map(([k, v]) => [k, v * 3])) });
  s = await aendereDb(d => { const dd = liesDoc(d, 'h-acht'); dd.lagerSeit = Date.now() - 3 * stunden * 3600 * 1000; schreibDoc(d, dd); });
  tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  const nachLange = ((await s.hole('/vorposten', tokA)).body.liste || []).find(x => x.sys === 'h-acht');
  check('2b: nach dem DREIFACHEN der Deckelzeit liegt trotzdem nur der Deckel drin - ein vergessener Vorposten ist keine Bank', (() => {
    return Object.keys(rate8).every(k => Math.abs(nachLange.lager[k] - rate8[k] * stunden) <= rate8[k] / 360 + 2);
  })(), { gemessen: nachLange.lager, deckel: Object.fromEntries(Object.entries(rate8).map(([k, v]) => [k, v * stunden])) });

  // ---- 3) Abholen -------------------------------------------------------------------------------
  const geholtAb = Date.now();
  const geholt = await s.sende('/vorposten/lager/holen', tokA, { system: 'h-acht' });
  check('3-vorab: das Abholen geht durch und nennt, was geholt wurde',
    geholt.status === 200 && geholt.body.geholt && geholt.body.geholt.erz > 0, { status: geholt.status, geholt: geholt.body.geholt });
  /* 3a MISST DEN ZUSTAND, nicht eine zweite Antwort. Der erste Entwurf holte gleich noch einmal ab
     und erwartete 400 „leer" - das war ZEITABHAENGIG und damit ein Muenzwurf: Ein Handelsknoten der
     Stufe 8 foerdert 7,8 Erz je SEKUNDE, nach einer Zehntelsekunde ist das Lager also nicht mehr
     leer. Aufgefallen ist es an der Gegenprobe `beute`, die 3a mitriss, obwohl sie mit dem Abholen
     nichts zu tun hat. Geprueft wird jetzt die REGEL: `lagerSeit` steht danach auf JETZT und nicht
     mehr auf dem zurueckdatierten Wert. */
  const vorAbholung = geholtAb;
  const docNach = liesDoc(JSON.parse(fs.readFileSync(dbPfad, 'utf8')), 'h-acht');
  check('3a: das Abholen setzt `lagerSeit` auf JETZT - es wird nicht um die geholten Stunden zurueckgedreht',
    docNach.lagerSeit >= vorAbholung && docNach.lagerSeit <= Date.now(),
    { lagerSeit: docNach.lagerSeit, vorDerAbholung: vorAbholung, jetzt: Date.now(),
      zurueckgedrehtWaere: Date.now() - stunden * 3600 * 1000 });
  const fremd = await s.sende('/vorposten/lager/holen', tokB, { system: 'h-acht' });
  check('3b: ein Fremder holt hier nichts ab', fremd.status === 403, { status: fremd.status });
  const dbNach = JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
  const wartend = ((dbNach.private[ANNA] || {}).__pendingRewards) || [];
  check('3c: der Ertrag geht ueber die Warteschlange mit EIGENEM Typ, nicht direkt in den Spielstand',
    wartend.some(r => r && r.type === 'vorposten-lager' && r.erz > 0),
    { typen: wartend.map(r => r && r.type) });

  // ---- 4) Die Beute beim Fall -------------------------------------------------------------------
  /* Der Vorposten wird auf einen Kern gesetzt, den ein Schlag sicher bricht, und sein Lager voll
     zurueckdatiert. Anschliessend faellt er wirklich - kein Nachrechnen der Beuteformel im Test. */
  s = await aendereDb(d => {
    const dd = liesDoc(d, 'f-acht');
    dd.kern = { lp: 1, lpMax: 1 };
    dd.lagerSeit = Date.now() - stunden * 3600 * 1000;
    schreibDoc(d, dd);
    const sv = liesSave(d, BEN);
    sv.fleet.missions = [angriffMission('m-lager', 'f-acht')];
    sv.__attackShieldUntil = 0;
    schreibSave(d, BEN, sv);
    const u = Object.values(d.users).find(x => x.userId === BEN); if (u) u.attackShieldUntil = 0;
  });
  tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  const vorFall = ((await s.hole('/vorposten', tokB)).body.liste || []).find(x => x.sys === 'f-acht');
  const angriff = await s.sende('/vorposten/angriff', tokB, { system: 'f-acht', missionId: 'm-lager' });
  check('4-vorab: der Vorposten ist wirklich gefallen', angriff.status === 200 && angriff.body.gefallen === true,
    { status: angriff.status, gefallen: angriff.body && angriff.body.gefallen, fehler: angriff.body && angriff.body.error });
  const dbFall = JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
  const beuteBen = (((dbFall.private[BEN] || {}).__pendingRewards) || []).find(r => r && r.type === 'vorposten');
  check('4a: der Angreifer bekommt das Lager - vollstaendig, weil er allein geschlagen hat', (() => {
    if (!beuteBen || !beuteBen.lagerBeute || !vorFall) return false;
    return Object.keys(vorFall.lager).every(k => Math.abs(beuteBen.lagerBeute[k] - vorFall.lager[k]) <= vorFall.lager[k] / 360 + 2)
      && beuteBen.lagerBeute.erz > 0;
  })(), { erbeutet: beuteBen && beuteBen.lagerBeute, lagVorher: vorFall && vorFall.lager });
  const verlustAnna = (((dbFall.private[ANNA] || {}).__pendingRewards) || []).find(r => r && r.type === 'vorposten-verlust');
  check('4b: die Besitzerin erfaehrt, WAS sie verloren hat - nicht nur DASS',
    !!verlustAnna && !!verlustAnna.lagerVerloren && verlustAnna.lagerVerloren.erz > 0,
    { verlust: verlustAnna && verlustAnna.lagerVerloren });

  // ---- 5) Mit ausgeschaltetem Schalter ----------------------------------------------------------
  await stoppeServer();
  fs.writeFileSync(QUELLE, basis.replace(/const VP_LAGER_AKTIV = (true|false);/, 'const VP_LAGER_AKTIV = false;'));
  const db2 = grunddb();
  db2.shared['vorposten:h-acht'] = JSON.stringify(vpDoc('h-acht', 8, 'handel', { lagerSeit: Date.now() - stunden * 3600 * 1000 }));
  fs.writeFileSync(dbPfad, JSON.stringify(db2, null, 1));
  s = await starteServer();
  const tokA2 = await s.anmelden('anna');
  const katAus = await s.hole('/vorposten', tokA2);
  const ausVp = (katAus.body.liste || []).find(x => x.sys === 'h-acht') || {};
  check('5a: ausgeschaltet foerdert kein Vorposten etwas, auch ein voll zurueckdatierter nicht',
    katAus.body.lagerAktiv === false
    && Object.values(ausVp.lagerRate || {}).every(v => v === 0)
    && Object.values(ausVp.lager || {}).every(v => v === 0),
    { aktiv: katAus.body.lagerAktiv, rate: ausVp.lagerRate, lager: ausVp.lager });
  const holenAus = await s.sende('/vorposten/lager/holen', tokA2, { system: 'h-acht' });
  check('5b: und der Abhol-Endpunkt sagt, dass es ihn noch nicht gibt',
    holenAus.status === 404 && holenAus.body.inaktiv === true, { status: holenAus.status, body: holenAus.body });
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
