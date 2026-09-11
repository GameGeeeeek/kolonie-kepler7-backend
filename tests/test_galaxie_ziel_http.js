// Galaxie-Ziel der Woche (Feature A, 11.09.2026) - gegen einen ECHT gestarteten Server.
//
// Ein gemeinsames Wochenziel: "Schlagt diese Woche zusammen N-mal gegen Alien-Nester" (rotierend
// ueber Nester, Festungen, Konvois, Weltboss). Gezaehlt wird NUR im Erfolgspfad der Angriffsroute,
// gedeckelt je Spieler und Tag, bezahlt wird beim Wochenwechsel - und nur, wenn erreicht.
//
// WAS DIESER TEST ABSICHERT, in der Reihenfolge der Abschnitte:
//   1) Das Ziel entsteht von selbst mit dem Wochenschluessel des Servers (Montag), die Hoehe folgt
//      der Formel aktive Spieler x Faktor der Art, und die Client-Form traegt KEIN Beitrags-
//      Verzeichnis fremder Konten - nur den eigenen Beitrag.
//   2) Ein gewerteter Nestschlag zaehlt eins; ein abgelehnter (Abklingzeit) zaehlt nichts; das
//      Erreichen setzt erreichtAm, Galaxie-News und Chronik-Eintrag; der Tagesdeckel (10) greift je
//      SPIELER, nicht global.
//   3) Ein Client kann das Ziel nicht schreiben - PUT /api/storage/galaxieZiel?shared=true landet
//      im generischen Speicher und aendert am Ziel nichts.
//   4) Ein Schlag der FALSCHEN Art zaehlt nicht (Festungswoche, Nestschlag).
//   5) Wochenwechsel beim Serverstart: nur Beitragende bekommen den Reward 'galaxie-ziel' mit den
//      Krediten nach Beitrag (200 + 50 je Beitrag, Deckel 400) und 5 Sternenstaub, den der SERVER
//      bucht; nur einmal (zweiter Start reiht nichts nach); ein NICHT erreichtes Ziel zahlt nichts.
//   6) Der Notaus 'galaxieziel' nimmt Anzeige UND Zaehlung weg, ohne Deploy.
//
// GEGENPROBE - Sabotage per KEPLER_GZ_SABOTAGE=<name> auf der Kopie (Vorbild
// test_vorposten_endprojekte_http.js). Jede Sabotage belegt ueber 0b zuerst, dass sie GEGRIFFEN hat;
// eine Ersetzung ins Leere saehe sonst aus wie eine bestandene Gegenprobe. GEMESSEN am 11.09.2026:
//   zaehlung   -> 2a 2b 2c 2d 2e 2f 3a  (kein Hook in der Nest-Route: nichts zaehlt mehr; 2b, 2f und 3a
//                                    lesen denselben Stand und fallen als FOLGE mit, nicht als Nebenschaden)
//   deckel     -> 2d 2e 2f 3a        (13 statt 10 Beitraege; 2e/2f/3a rechnen mit dem Deckel weiter)
//   auszahlung -> 5i                 (ein verfehltes Ziel zahlt trotzdem)
//   staub      -> 5d                 (der Reward nennt 5 Staub, gebucht ist nichts)
//   transport  -> 5e 6a              (ohne das Ausblenden in chronikAusClient geht das rohe Ziel samt
//                                    Beitrags-Verzeichnis raus, sobald KEINE Client-Form daruebergelegt
//                                    wird: Notaus (6a) - und die Vorwoche (5e) immer. 1c sieht das NICHT,
//                                    weil galaxyFuerClient die Client-Form ueber das rohe Feld schreibt;
//                                    die erste Fassung dieser Liste nannte 1c und fiel selbst durch.)
//   notaus     -> 6b 6c              (Zaehlung laeuft trotz Notaus; 6c erwartet danach Stand 0)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3273;
const QUELLE = path.join(WURZEL, 'server_gz_tmp.js');
const SAB = process.env.KEPLER_GZ_SABOTAGE || '';
const MUSS_FALLEN = { zaehlung: ['2a', '2b', '2c', '2d', '2e', '2f', '3a'], deckel: ['2d', '2e', '2f', '3a'], auszahlung: ['5i'],
  staub: ['5d'], transport: ['5e', '6a'], notaus: ['6b', '6c'] };

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
const ADMIN = crypto.randomUUID();
const NAMEN = ['anna', 'ben', 'cora', 'dirk', 'emil', 'fritz'];
const ID = {}; for (const n of NAMEN) ID[n] = crypto.randomUUID();
const FLOTTE = { cruisers: 300, destroyers: 200, jaeger: 400, schlachtschiff: 80 };
const SAVE_KEY = 'kepler7-save-v3';

function spielstand(id, name) {
  return {
    resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {},
    fleet: Object.assign({ missions: [] }, FLOTTE),
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  };
}
function grunddb() {
  const users = { gamegeeeeek: { userId: ADMIN, username: 'GameGeeeeek', passwordHash: hash, createdAt: Date.now() } };
  const priv = { [ADMIN]: { [SAVE_KEY]: JSON.stringify(spielstand(ADMIN, 'GameGeeeeek')) } };
  const shared = {};
  for (const n of NAMEN) {
    users[n] = { userId: ID[n], username: n, passwordHash: hash, createdAt: Date.now() };
    priv[ID[n]] = { [SAVE_KEY]: JSON.stringify(spielstand(ID[n], n)) };
  }
  // AKTIV heisst fuer den Server: Bestenlisten-Eintrag mit lastSeen in den letzten 24 h - derselbe
  // Weg, den rkAktiveSpieler liest (getUserLastSeen). Admin + sechs Spieler = sieben Aktive.
  for (const uid of [ADMIN].concat(NAMEN.map(n => ID[n]))) shared['leaderboard:' + uid] = JSON.stringify({ score: 1000, lastSeen: Date.now() });
  return {
    users, private: priv, shared, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], chronik: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {} }
  };
}
const AKTIVE = NAMEN.length + 1;

const dbPfad = path.join(os.tmpdir(), 'kepler-galaxieziel-' + process.pid + '.json');
let srv = null, s = null;
const tok = {};
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
async function alleAnmelden() {
  tok.admin = await s.anmelden('GameGeeeeek');
  for (const n of NAMEN) tok[n] = await s.anmelden(n);
}
/* Reihenfolge-Wache wie in test_festung_http.js: Eine Aenderung an der DB-DATEI bei laufendem Server
   ist beim naechsten SIGTERM wieder weg (der Graceful Shutdown flusht die im Speicher gehaltene db
   darueber). Also: stoppen, aendern, starten. */
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  s = await starteServer();
  await alleAnmelden();
}
// Der Spielstand liegt je nach Alter in ZWEI Formen vor (Zeichenkette oder { value, version }).
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
const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
const hole = (pfad, t) => s.j(pfad, { headers: kopf(t) });
const sende = (pfad, t, body) => s.j(pfad, { method: 'POST', headers: kopf(t), body: JSON.stringify(body) });
const galaxie = async (t) => (await hole('/galaxy', t)).body.galaxieZiel;
const rewards = async (t) => ((await hole('/pending-rewards', t)).body.rewards || []).filter(r => r.type === 'galaxie-ziel');

// Ein Nest, das weder faellt noch wandert (naechsteWanderung 0 = nie), und die Mission dazu.
const nestObj = (id, sys) => ({ id, volk: 'kryll', sys, stufe: 3, lp: 5e7, lpMax: 5e7,
  seit: Date.now() - 3600000, letzteReifung: Date.now(), naechsterWurf: Date.now() + 8 * 3600 * 1000,
  naechsteWanderung: 0, beitraege: {}, schlaege: {} });
const mission = (id, nestId, sys) => ({ id, type: 'nest-angriff', targetId: sys, system: sys, nestId,
  startTime: Date.now() - 7200000, endTime: Date.now() - 3600000, fleetName: 'Flotte 1', composition: Object.assign({}, FLOTTE) });
const schlag = (t, nestId, missionId) => sende('/alien/nest-angriff', t, { nestId, missionId });
const pad = n => String(n).padStart(2, '0');
const wochenKey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
// Ein Ziel in der Server-Form, mit allen Feldern, die galaxieZielAnlegen schreibt.
function zielObj(woche, art, ziel, extra) {
  const [y, m, d] = woche.split('-').map(Number);
  return Object.assign({ woche, art, ziel, stand: 0, beitraege: {}, beitraegeTag: { stempel: null, konten: {} },
    erreichtAm: null, ausgezahlt: false, beginn: new Date(y, m - 1, d).getTime(), ende: new Date(y, m - 1, d + 7).getTime() }, extra || {});
}

(async () => {
  // ---- 0) Die Kopie, ggf. sabotiert ------------------------------------------------------------
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  const proSpieler = {};
  for (const m of roh.matchAll(/\{ key: '([a-z]+)',\s+name: '[^']+',\s+icon: '[a-z0-9-]+',\s+proSpieler: (\d+),/g)) proSpieler[m[1]] = Number(m[2]);
  const deckel = Number((roh.match(/const GALAXIE_ZIEL_TAGESDECKEL = (\d+);/) || [])[1]);
  const minZiel = Number((roh.match(/const GALAXIE_ZIEL_MIN = (\d+), GALAXIE_ZIEL_MAX = (\d+);/) || [])[1]);
  const maxZiel = Number((roh.match(/const GALAXIE_ZIEL_MIN = (\d+), GALAXIE_ZIEL_MAX = (\d+);/) || [])[2]);
  check('0a: Katalog-Faktoren, Tagesdeckel und Klemmen sind im Quelltext auffindbar',
    Object.keys(proSpieler).length === 4 && deckel > 0 && minZiel > 0 && maxZiel > minZiel, { proSpieler, deckel, minZiel, maxZiel });

  let basis = roh;
  const SABOTAGEN = {
    zaehlung:   ["  galaxieZielBeitrag(req.userId, 'nestschlaege');   // Galaxie-Ziel der Woche (Feature A): gewerteter Schlag\n", ''],
    deckel:     ['  if (heuteN >= GALAXIE_ZIEL_TAGESDECKEL) return', '  if (false) return'],
    auszahlung: ['  if (!z.erreichtAm) {\n    console.log', '  if (false) {\n    console.log'],
    staub:      ['    staubGutschreiben(staubKonto(user), GALAXIE_ZIEL_STAUB);', ''],
    transport:  ['const { chronik, chronikAusgabe, galaxieZiel, galaxieZielVorwoche, ...rest } = g;', 'const { chronik, chronikAusgabe, ...rest } = g;'],
    notaus:     ["function galaxieZielBeitrag(userId, art) {\n  if (!spawnAktiv('galaxieziel')) return null;", 'function galaxieZielBeitrag(userId, art) {\n  if (false) return null;']
  };
  if (SAB) {
    const sb = SABOTAGEN[SAB];
    check('0b: die Sabotage „' + SAB + '" ist bekannt und hat GEGRIFFEN', !!sb && basis.split(sb[0]).length === 2, { bekannt: !!sb, treffer: sb ? basis.split(sb[0]).length - 1 : 0 });
    if (sb) basis = basis.replace(sb[0], sb[1]);
  }
  fs.writeFileSync(QUELLE, basis);

  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  s = await starteServer();
  await alleAnmelden();
  check('0c: Admin und sechs Spieler angemeldet', !!tok.admin && NAMEN.every(n => !!tok[n]));
  if (!tok.admin || !tok.anna) { console.log(s.protokoll().slice(-1500)); process.exit(1); }

  // ---- 1) Das Ziel entsteht von selbst ---------------------------------------------------------
  const z1 = await galaxie(tok.anna);
  const jetzt = Date.now();
  const wocheJetzt = z1 && z1.woche;
  check('1a: GET /api/galaxy traegt ein Ziel mit Wochenschluessel (ein Montag), Art aus dem Katalog, Stand 0, Ende in der Zukunft',
    !!z1 && /^\d{4}-\d{2}-\d{2}$/.test(z1.woche) && (() => { const [y, m, d] = z1.woche.split('-').map(Number); const mo = new Date(y, m - 1, d); return mo.getDay() === 1 && mo.getTime() <= jetzt; })()
      && !!proSpieler[z1.art] && z1.stand === 0 && z1.erreicht === false && z1.meinBeitrag === 0 && z1.ende > jetzt && z1.beginn === undefined
      && typeof z1.name === 'string' && typeof z1.beschreibung === 'string' && /^ti-[a-z0-9-]+$/.test(z1.icon || ''),
    z1);
  check('1b: die Zielhoehe folgt der Formel aktive Spieler x Faktor der Art, geklemmt',
    !!z1 && z1.ziel === Math.max(minZiel, Math.min(maxZiel, Math.round(AKTIVE * (proSpieler[z1.art] || 0)))),
    { ziel: z1 && z1.ziel, aktive: AKTIVE, faktor: z1 && proSpieler[z1.art] });
  const roh1 = (await hole('/galaxy', tok.anna)).body;
  check('1c: die Client-Form traegt KEIN Beitrags-Verzeichnis fremder Konten - nur den eigenen Beitrag',
    !!z1 && z1.beitraege === undefined && z1.beitraegeTag === undefined && roh1.galaxieZielVorwoche === undefined
      && !(roh1.galaxieZiel && roh1.galaxieZiel.beitraege), { schluessel: z1 ? Object.keys(z1) : null });
  const h1 = (await s.j('/health')).body;
  check('1d: /api/health nennt das Ziel dieser Woche ohne Anmeldung',
    !!h1.galaxieZiel && h1.galaxieZiel.woche === wocheJetzt && h1.galaxieZiel.ziel === (z1 && z1.ziel) && h1.galaxieZiel.notAus === false, h1.galaxieZiel);

  // ---- 2) Der Nestschlag zaehlt - nur im Erfolgspfad, mit Tagesdeckel je Spieler ----------------
  const SYS = i => 'gz-sys-' + i;
  await aendereDb(d => {
    d.galaxy.galaxieZiel = zielObj(wocheJetzt, 'nestschlaege', 3);
    d.galaxy.alienNester = [];
    for (let i = 1; i <= 13; i++) d.galaxy.alienNester.push(nestObj('n' + i, SYS(i)));
    const svA = liesSave(d, ID.anna); svA.fleet.missions = []; for (let i = 1; i <= 13; i++) svA.fleet.missions.push(mission('m' + i, 'n' + i, SYS(i))); schreibSave(d, ID.anna, svA);
    const svB = liesSave(d, ID.ben); svB.fleet.missions = [mission('mb1', 'n1', SYS(1))]; schreibSave(d, ID.ben, svB);
  });
  const s1 = await schlag(tok.anna, 'n1', 'm1');
  const z2a = await galaxie(tok.anna), z2b = await galaxie(tok.ben);
  check('2a: ein gewerteter Nestschlag zaehlt eins - Stand 1, eigener Beitrag 1, fremder Beitrag 0',
    s1.status === 200 && s1.body.ok === true && !s1.body.verpasst && z2a.stand === 1 && z2a.meinBeitrag === 1 && z2b.stand === 1 && z2b.meinBeitrag === 0,
    { status: s1.status, fehler: s1.body && s1.body.error, anna: z2a, ben: z2b });
  const s1b = await schlag(tok.anna, 'n1', 'm1');
  const z2c = await galaxie(tok.anna);
  check('2b: ein ABGELEHNTER Schlag (Abklingzeit) zaehlt nichts', s1b.status === 403 && !!s1b.body.abklingzeit && z2c.stand === 1,
    { status: s1b.status, stand: z2c.stand });
  await schlag(tok.anna, 'n2', 'm2');
  const s3 = await schlag(tok.anna, 'n3', 'm3');
  const z2d = await galaxie(tok.anna);
  const news2 = ((await hole('/galaxy', tok.anna)).body.news || []).filter(n => n.art === 'galaxie-ziel');
  check('2c: das Erreichen setzt erreicht=true und eine Galaxie-Meldung der Art galaxie-ziel',
    s3.status === 200 && z2d.stand === 3 && z2d.erreicht === true && news2.length === 1 && /erreicht/i.test(news2[0].text),
    { stand: z2d.stand, erreicht: z2d.erreicht, news: news2.map(n => n.text) });
  for (let i = 4; i <= 13; i++) { const r = await schlag(tok.anna, 'n' + i, 'm' + i); if (r.status !== 200) console.log('   (Schlag ' + i + ': ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120) + ')'); }
  const z2e = await galaxie(tok.anna);
  check('2d: der Tagesdeckel greift - 13 gewertete Schlaege, ' + deckel + ' Beitraege', z2e.stand === deckel && z2e.meinBeitrag === deckel,
    { stand: z2e.stand, meinBeitrag: z2e.meinBeitrag, deckel });
  const sB = await schlag(tok.ben, 'n1', 'mb1');
  const z2f = await galaxie(tok.ben);
  check('2e: der Deckel gilt je SPIELER - Bens Schlag zaehlt weiter', sB.status === 200 && z2f.stand === deckel + 1 && z2f.meinBeitrag === 1 && z2f.kommandanten === 2,
    { status: sB.status, stand: z2f.stand, ben: z2f.meinBeitrag, kommandanten: z2f.kommandanten });
  await stoppeServer();
  const db2 = liesDb();
  const gz2 = db2.galaxy.galaxieZiel;
  const chr2 = (db2.galaxy.chronik || []).filter(e => e.art === 'galaxie-ziel-erreicht');
  check('2f: im Server-Zustand: erreichtAm gesetzt, Beitraege je Konto, Tageskonto, und genau ein Chronik-Eintrag mit festen Feldern',
    !!gz2 && gz2.erreichtAm > 0 && gz2.beitraege[ID.anna] === deckel && gz2.beitraege[ID.ben] === 1 && gz2.beitraegeTag.konten[ID.anna] === deckel
      && chr2.length === 1 && chr2[0].art === 'galaxie-ziel-erreicht' && chr2[0].zielArt === 'nestschlaege' && chr2[0].ziel === 3 && chr2[0].stand === 3 && chr2[0].kommandanten === 1,
    { erreichtAm: gz2 && gz2.erreichtAm, beitraege: gz2 && gz2.beitraege, chronik: chr2 });
  s = await starteServer(); await alleAnmelden();

  // ---- 3) Der Client kann das Ziel nicht schreiben ----------------------------------------------
  const put = await s.j('/storage/galaxieZiel?shared=true', { method: 'PUT', headers: kopf(tok.cora),
    body: JSON.stringify({ value: JSON.stringify({ stand: 999, ziel: 1, beitraege: { [ID.cora]: 50 } }) }) });
  const z3 = await galaxie(tok.cora);
  await stoppeServer();
  const db3 = liesDb();
  check('3a: PUT /api/storage/galaxieZiel?shared=true landet im generischen Speicher und aendert am Ziel NICHTS',
    z3.stand === deckel + 1 && z3.meinBeitrag === 0 && db3.galaxy.galaxieZiel.stand === deckel + 1 && !db3.galaxy.galaxieZiel.beitraege[ID.cora],
    { put: put.status, stand: z3.stand, cora: z3.meinBeitrag, imShared: db3.shared.galaxieZiel !== undefined });
  s = await starteServer(); await alleAnmelden();

  // ---- 4) Die falsche Art zaehlt nicht -----------------------------------------------------------
  await aendereDb(d => {
    d.galaxy.galaxieZiel = zielObj(wocheJetzt, 'festungsschlaege', 5);
    d.galaxy.alienNester.push(nestObj('n20', SYS(20)));
    const svA = liesSave(d, ID.anna); svA.fleet.missions = [mission('m20', 'n20', SYS(20))]; schreibSave(d, ID.anna, svA);
  });
  const s4 = await schlag(tok.anna, 'n20', 'm20');
  const z4 = await galaxie(tok.anna);
  check('4a: in einer Festungswoche zaehlt ein Nestschlag nicht', s4.status === 200 && z4.art === 'festungsschlaege' && z4.stand === 0 && z4.meinBeitrag === 0,
    { status: s4.status, art: z4.art, stand: z4.stand });

  // ---- 5) Wochenwechsel: Abrechnung beim Serverstart ----------------------------------------------
  const [wy, wm, wd] = wocheJetzt.split('-').map(Number);
  const vorwoche = wochenKey(new Date(wy, wm - 1, wd - 7));
  await aendereDb(d => {
    d.galaxy.galaxieZiel = zielObj(vorwoche, 'nestschlaege', 3, { stand: 4, beitraege: { [ID.anna]: 3, [ID.ben]: 1 }, erreichtAm: Date.now() - 2 * 86400000 });
    for (const n of NAMEN) delete d.users[n].staub;
  });
  const rA = await rewards(tok.anna), rB = await rewards(tok.ben), rC = await rewards(tok.cora);
  check('5a: Anna (3 Beitraege) bekommt GENAU EINEN Reward galaxie-ziel: 200 + 3x50 = 350 Kredite, 5 Staub, alle Felder',
    rA.length === 1 && rA[0].credits === 350 && rA[0].staub === 5 && rA[0].beitrag === 3 && rA[0].woche === vorwoche && rA[0].art === 'nestschlaege'
      && rA[0].name === 'Schläge gegen Alien-Nester' && rA[0].ziel === 3 && rA[0].stand === 4 && !!rA[0].id, rA);
  check('5b: Ben (1 Beitrag) bekommt 250 Kredite', rB.length === 1 && rB[0].credits === 250 && rB[0].beitrag === 1, rB);
  check('5c: Cora (kein Beitrag) bekommt nichts', rC.length === 0, rC);
  const roh5 = (await hole('/galaxy', tok.anna)).body;
  const z5 = roh5.galaxieZiel;
  const news5 = (roh5.news || []).filter(n => n.art === 'galaxie-ziel');
  check('5e: danach steht ein NEUES Ziel fuer diese Woche bei 0, die Weltlage meldet die Abrechnung - und die Vorwoche (mit allen Beitraegen) geht NICHT an den Client',
    !!z5 && z5.woche === wocheJetzt && z5.stand === 0 && z5.meinBeitrag === 0 && news5.some(n => /abgerechnet/.test(n.text)) && roh5.galaxieZielVorwoche === undefined,
    { woche: z5 && z5.woche, stand: z5 && z5.stand, news: news5.map(n => n.text), vorwocheImClient: roh5.galaxieZielVorwoche !== undefined });
  await stoppeServer();
  const db5 = liesDb();
  check('5d: den Sternenstaub hat der SERVER gebucht - Anna 5, Ben 5, Cora nichts',
    (db5.users.anna.staub || {}).menge === 5 && (db5.users.ben.staub || {}).menge === 5 && !(db5.users.cora.staub && db5.users.cora.staub.menge),
    { anna: db5.users.anna.staub, ben: db5.users.ben.staub, cora: db5.users.cora.staub });
  check('5f: das abgerechnete Ziel liegt als Vorwoche mit ausgezahlt=true im Server-Zustand',
    !!db5.galaxy.galaxieZielVorwoche && db5.galaxy.galaxieZielVorwoche.woche === vorwoche && db5.galaxy.galaxieZielVorwoche.ausgezahlt === true,
    db5.galaxy.galaxieZielVorwoche && { woche: db5.galaxy.galaxieZielVorwoche.woche, ausgezahlt: db5.galaxy.galaxieZielVorwoche.ausgezahlt });
  s = await starteServer(); await alleAnmelden();
  const rA2 = await rewards(tok.anna);
  check('5h: ein zweiter Serverstart reiht NICHTS nach - immer noch genau ein Reward', rA2.length === 1, { anzahl: rA2.length });
  // Nicht erreicht: kein Reward, kein Staub.
  await aendereDb(d => {
    d.galaxy.galaxieZiel = zielObj(vorwoche, 'nestschlaege', 50, { stand: 2, beitraege: { [ID.cora]: 2 }, erreichtAm: null });
  });
  const rC2 = await rewards(tok.cora);
  await stoppeServer();
  const db5i = liesDb();
  check('5i: ein NICHT erreichtes Ziel zahlt nichts - Cora hat zwei Beitraege und bekommt keinen Reward und keinen Staub',
    rC2.length === 0 && !(db5i.users.cora.staub && db5i.users.cora.staub.menge) && db5i.galaxy.galaxieZielVorwoche.ausgezahlt === true,
    { rewards: rC2, staub: db5i.users.cora.staub });
  s = await starteServer(); await alleAnmelden();

  // ---- 6) Der Notaus ------------------------------------------------------------------------------
  await aendereDb(d => {
    d.galaxy.galaxieZiel = zielObj(wocheJetzt, 'nestschlaege', 20);
    d.galaxy.alienNester.push(nestObj('n30', SYS(30)));
    const svA = liesSave(d, ID.anna); svA.fleet.missions = [mission('m30', 'n30', SYS(30))]; schreibSave(d, ID.anna, svA);
  });
  const aus = await sende('/admin/schalter', tok.admin, { name: 'galaxieziel', aus: true, grund: 'Gegenprobe im Test' });
  const z6 = (await hole('/galaxy', tok.anna)).body.galaxieZiel;
  const h6 = (await s.j('/health')).body.galaxieZiel;
  check('6a: mit gesetztem Notaus geht KEIN Ziel mehr an den Client, /api/health nennt notAus',
    aus.status === 200 && z6 === undefined && !!h6 && h6.notAus === true, { schalter: aus.status, fehler: aus.body && aus.body.error, ziel: z6, health: h6 });
  const s6 = await schlag(tok.anna, 'n30', 'm30');
  await stoppeServer();
  const db6 = liesDb();
  check('6b: der Angriff selbst laeuft, aber die Zaehlung steht', s6.status === 200 && db6.galaxy.galaxieZiel.stand === 0 && !db6.galaxy.galaxieZiel.beitraege[ID.anna],
    { status: s6.status, stand: db6.galaxy.galaxieZiel.stand });
  s = await starteServer(); await alleAnmelden();
  const an = await sende('/admin/schalter', tok.admin, { name: 'galaxieziel', aus: false });
  const z6b = await galaxie(tok.anna);
  check('6c: wieder freigegeben ist das Ziel wieder da', an.status === 200 && !!z6b && z6b.stand === 0, { status: an.status, ziel: z6b });
  await stoppeServer();

  // ---- Auswertung: Gruen-Lauf ODER Gegenprobe ----------------------------------------------------
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
