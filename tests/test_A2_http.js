// Echter HTTP-Test: A2 - die wandernden Beute-Ziele (Wrackkonvois).
//
//   node tests/test_A2_http.js
//   KEPLER_A2_SABOTAGE=<name> node tests/test_A2_http.js     (Gegenprobe, siehe unten)
//
// Konzept: docs/wandernde-beute-ziele-konzept.md (Frontend-Repo). A2 ist das Gegenstueck zum
// Alien-Nest: Es lebt in db.galaxy.wrackKonvois, driftet und ENTKOMMT (die eine Mechanik, die es vom
// Nest strukturell unterscheidet), und seine Belohnung ist "alle 3" (Sternenessenz + Standort-Modul
// + Kampf-Modul, Entscheidung Sascha). Gemessen wird an einem echten Server mit echter DB - die
// entscheidenden Eigenschaften haengen an db.galaxy und lassen sich durch Lesen des Quelltextes
// nicht belegen.
//
// GEPRUEFT WIRD:
//   1. Ein Schlag kommt an: LP sinken, der Beitrag steht in db.galaxy, die Antwort nennt Schaden
//      und Verluste.
//   2. DIE ABKLINGZEIT LIEGT AM ZIEL (ziel.schlaege), nicht im Spielstand - ein zweiter Schlag
//      prallt ab, mit GRUND im Text (Regel 28), und ein Spielstand-Reset gibt sie NICHT frei.
//   3. Gezaehlt wird, was ANGEKOMMEN ist (lpVorher - lp), nicht der volle Wurf.
//   4. Der Fall zahlt anteilig an ALLE Beitragenden, mit EIGENEM type:'wrackkonvoi' und
//      Sternenessenz - und das Ziel verschwindet aus db.galaxy.
//   5. DIE DREI verpasst-GRUENDE: weitergezogen (Ziel driftet, ueber die Mission erkannt), gefallen
//      (Ziel gestellt) und ENTKOMMEN (Lebensdauer abgelaufen, ganz verschwunden). Jeder kostet
//      NICHTS und nennt den WAHREN Grund. Das 'entkommen' ist das Neue.
//   6. Der Server schreibt den Spielstand des Angreifers NICHT.
//   7. DER TICK: ein Ziel entkommt nach A2_LEBENSDAUER_MS (splice + Verlaufs-Vermerk), und der
//      galaxieweite Deckel A2_MAX haelt.
//   8. DIE MODUL-BEUTE faellt mit CHANCE JE ANTEIL (server-gewuerfelt), traegt quelle:'konvoi',
//      und das Kampf-Modul (kv_bergungspanzer) steht in SHIP_MODULE_COMBAT_BASE (PvP-Paritaet).
//   9. DER SCHALTER A2_SPAWN_AKTIV steht auf false (Auslieferungs-Riegel, Regel 60) - er wird erst
//      im Frontend-PR umgelegt. Ein voreiliges true faellt hier auf.
//
// GEGENPROBEN (KEPLER_A2_SABOTAGE, je mit "was fallen MUSS"-Liste, Regel 1/71 - der Lauf exit-0t,
// WENN genau die erwarteten Pruefungen fielen, sonst WERKZEUGFEHLER):
//   * schaden   : `schaden = wurf` statt `lpVorher - lp`   -> 3a faellt.
//   * abkling   : Abklingzeit NICHT am Ziel vermerkt        -> 2a faellt (zweiter Schlag geht durch).
//   * entkommen : der 'entkommen'-Vermerk entfaellt         -> 5e-grund faellt (meldet 'gefallen').
//   * typ       : Belohnung traegt einen fremden type       -> 4b faellt (Bug-Report-Rueckfall).
//
// Port 3234 (belegt bis 3233, Regel 29).
//
// Der Test startet eine KOPIE von server.js mit umgelegtem Schalter (A2_SPAWN_AKTIV = true), sonst
// tut A2Tick gar nichts. Die Kopie liegt im Repo-Verzeichnis (damit require('./mailer') aufloest)
// und wird am Ende weggeraeumt.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3234;
const QUELLE = path.join(WURZEL, 'server_a2test_tmp.js');
const SAB = process.env.KEPLER_A2_SABOTAGE || '';
const MUSS_FALLEN = { schaden: ['3a'], abkling: ['2a'], entkommen: ['5e-grund'], typ: ['4b'] };

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
const ANNA = crypto.randomUUID(), BEN = crypto.randomUUID();

function spielstand(id, name) {
  return {
    resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {},
    fleet: { missions: [], cruisers: 300, destroyers: 200, jaeger: 400, schlachtschiff: 80 },
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  };
}
const FLOTTE = { cruisers: 300, destroyers: 200, jaeger: 400, schlachtschiff: 80 };

function grunddb() {
  return {
    users: {
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: Date.now() }
    },
    private: {
      [ANNA]: { 'kepler7-save-v3': JSON.stringify(spielstand(ANNA, 'anna')) },
      [BEN]:  { 'kepler7-save-v3': JSON.stringify(spielstand(BEN, 'ben')) }
    },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {}, wrackKonvois: [], a2Verlauf: [] }
  };
}

const SAVE_KEY = 'kepler7-save-v3';
const dbPfad = path.join(os.tmpdir(), 'kepler-a2-' + process.pid + '.json');
let srv = null, s = null, tokA = null, tokB = null;
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

/* Dieselbe Reihenfolge-Wache wie in test_alien_nester_http.js: Eine Aenderung an der DB-DATEI,
   waehrend der Server laeuft, ist beim naechsten SIGTERM wieder weg (der Graceful Shutdown flusht
   die im Speicher gehaltene db darueber). */
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  s = await starteServer();
  tokA = await s.anmelden('anna');
  tokB = await s.anmelden('ben');
}
/* Der Spielstand liegt in db.private in ZWEI Formen vor (blanke Zeichenkette oder { value, version }).
   Beide werden gelesen, die vorgefundene Form beim Schreiben beibehalten. */
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

const zielObj = (id, sys, lp, lpMax) => ({
  id, sys, lp, lpMax,
  seit: Date.now() - 3600000, naechsteWanderung: Date.now() + 6 * 3600 * 1000,
  beitraege: {}, schlaege: {}
});
const a2mission = (id, zielId, sys) => ({
  id, type: 'konvoi-angriff', targetId: sys, system: sys, zielId,
  startTime: Date.now() - 7200000, endTime: Date.now() - 3600000,
  fleetName: 'Flotte 1', composition: Object.assign({}, FLOTTE)
});

(async () => {
  // Die Kopie mit umgelegtem Schalter - der Grund steht im Kopfkommentar. Danach ggf. die Sabotage.
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  let geflippt = roh.replace(/const A2_SPAWN_AKTIV = (true|false);/, 'const A2_SPAWN_AKTIV = true;');
  check('0-kopie: der Schalter liess sich in der Kopie umlegen',
    /const A2_SPAWN_AKTIV = true;/.test(geflippt), { gefunden: /const A2_SPAWN_AKTIV = (true|false);/.test(roh) });

  if (SAB) {
    let vorher = geflippt;
    if (SAB === 'schaden') geflippt = geflippt.replace('const schaden = lpVorher - ziel.lp;', 'const schaden = wurf;');
    else if (SAB === 'abkling') geflippt = geflippt.replace('ziel.schlaege[t.userId] = jetzt;', '/* sabotiert: keine Abklingzeit am Ziel */;');
    else if (SAB === 'entkommen') geflippt = geflippt.replace("a2VerlaufVermerken(g, z.id, 'entkommen');", "/* sabotiert: kein entkommen-Vermerk */;");
    else if (SAB === 'typ') geflippt = geflippt.replace('type: A2_ART,               //', "type: 'alien-nest',        //");
    else { console.log('unbekannte Sabotage: ' + SAB); process.exit(2); }
    check('0-sab: die Sabotage "' + SAB + '" hat den Quelltext veraendert', geflippt !== vorher, { veraendert: geflippt !== vorher });
  }
  fs.writeFileSync(QUELLE, geflippt);

  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  s = await starteServer();
  tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  check('0: zwei Konten angemeldet', !!tokA && !!tokB);
  if (!tokA || !tokB) { console.log(s.protokoll().slice(-1500)); process.exit(1); }
  const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
  const schlag = (tok, zielId, missionId) => s.j('/konvoi/angriff', {
    method: 'POST', headers: kopf(tok), body: JSON.stringify({ zielId, missionId })
  });

  // ---- 1) Ein Schlag kommt an -----------------------------------------------------------------
  const SYS1 = 'testsys-a';
  await aendereDb(d => {
    d.galaxy.wrackKonvois = [zielObj('z1', SYS1, 40000, 40000)];
    const sv = liesSave(d, ANNA);
    sv.fleet.missions = [a2mission('m1', 'z1', SYS1)];
    schreibSave(d, ANNA, sv);
  });
  const r1 = await schlag(tokA, 'z1', 'm1');
  check('1a: der Schlag wird angenommen', r1.status === 200 && r1.body.ok === true, r1.body);
  check('1b: er richtet Schaden an', (r1.body.schaden || 0) > 0, { schaden: r1.body.schaden });
  check('1c: die LP sind gesunken', (r1.body.lp || 0) < 40000, { lp: r1.body.lp, lpMax: r1.body.lpMax });
  check('1d: die Antwort nennt eigene Verluste',
    Object.keys(r1.body.eigeneVerluste || {}).length > 0, { verluste: r1.body.eigeneVerluste });
  {
    await stoppeServer();
    const d = liesDb();
    const z = (d.galaxy.wrackKonvois || []).find(x => x.id === 'z1');
    check('1e: der Beitrag steht in db.galaxy, nicht im Spielstand',
      !!z && !!z.beitraege && (z.beitraege[ANNA] || {}).schaden > 0, { beitraege: z && z.beitraege });
    s = await starteServer(); tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  }

  // ---- 2) Die Abklingzeit liegt AM ZIEL -------------------------------------------------------
  await aendereDb(d => {
    const sv = liesSave(d, ANNA);
    sv.fleet.missions = [a2mission('m2', 'z1', SYS1)];
    schreibSave(d, ANNA, sv);
  });
  const r2 = await schlag(tokA, 'z1', 'm2');
  check('2a: der zweite Schlag prallt an der Abklingzeit ab', r2.status === 403, r2.body);
  check('2a-grund: und der Fehlertext nennt die Abklingzeit',
    r2.status === 403 && (r2.body.abklingzeit === true || /Abklingzeit|vor Kurzem/.test(r2.body.error || '')),
    { error: r2.body.error });
  await aendereDb(d => {
    const sv = liesSave(d, ANNA);
    delete sv.a2LetzterSchlag;                       // ein geloeschtes Save-Feld darf nichts freigeben
    sv.fleet.missions = [a2mission('m3', 'z1', SYS1)];
    schreibSave(d, ANNA, sv);
  });
  const r3 = await schlag(tokA, 'z1', 'm3');
  check('2b: sie überlebt einen Spielstand-Reset (Ablageort am Ziel, nicht im Save)',
    r3.status === 403, { status: r3.status, body: r3.body });

  // ---- 3) Gezaehlt wird, was ANGEKOMMEN ist ---------------------------------------------------
  const SYS2 = 'testsys-b';
  await aendereDb(d => {
    d.galaxy.wrackKonvois = [zielObj('z3', SYS2, 500, 40000)];   // fast tot
    const sv = liesSave(d, BEN);
    sv.fleet.missions = [a2mission('m3b', 'z3', SYS2)];
    schreibSave(d, BEN, sv);
  });
  const r3b = await schlag(tokB, 'z3', 'm3b');
  check('3-anker: der Schlag fällt das Ziel', r3b.status === 200 && r3b.body.gefallen === true, r3b.body);
  check('3a: gezählt wird der Rest, nicht der volle Wurf',
    r3b.body.schaden === 500,
    { schaden: r3b.body.schaden, erwartet: 500,
      hinweis: 'deutlich mehr heisst: der volle Wurf wird gezaehlt, der letzte Angreifer risse den Anteil an sich' });

  // ---- 4) Der Fall zahlt anteilig an ALLE, type:'wrackkonvoi', Sternenessenz -------------------
  const SYS4 = 'testsys-c';
  await aendereDb(d => {
    d.galaxy.wrackKonvois = [zielObj('z4', SYS4, 40000, 40000)];
    for (const [uid, id] of [[ANNA, 'm4a'], [BEN, 'm4b']]) {
      const sv = liesSave(d, uid);
      sv.fleet.missions = [a2mission(id, 'z4', SYS4)];
      schreibSave(d, uid, sv);
      delete d.private[uid].__pendingRewards;
    }
  });
  await schlag(tokA, 'z4', 'm4a');
  await aendereDb(d => {
    const z = d.galaxy.wrackKonvois.find(x => x.id === 'z4');
    if (z) z.lp = 1;                       // Ben führt den letzten Schlag
  });
  const r4 = await schlag(tokB, 'z4', 'm4b');
  check('4-anker: das Ziel fällt', r4.status === 200 && r4.body.gefallen === true, r4.body);
  {
    await stoppeServer();
    const d = liesDb();
    const rA = (d.private[ANNA].__pendingRewards || []).filter(x => x.type === 'wrackkonvoi');
    const rB = (d.private[BEN].__pendingRewards || []).filter(x => x.type === 'wrackkonvoi');
    check('4a: BEIDE Beitragenden haben eine Belohnung in der Warteschlange',
      rA.length === 1 && rB.length === 1, { anna: rA.length, ben: rB.length });
    check('4b: die Belohnung trägt den EIGENEN type:"wrackkonvoi" (kein Bug-Report-Rückfall)',
      (rA[0] || {}).type === 'wrackkonvoi' && (rB[0] || {}).type === 'wrackkonvoi',
      { anna: (rA[0] || {}).type, ben: (rB[0] || {}).type });
    check('4c: sie trägt Sternenessenz und Kampfpunkte',
      ((rA[0] || {}).essenz || 0) > 0 && ((rB[0] || {}).kampfpunkte || 0) > 0,
      { annaEssenz: (rA[0] || {}).essenz, benKp: (rB[0] || {}).kampfpunkte });
    check('4d: die Anteile summieren sich auf rund 1',
      Math.abs(((rA[0] || {}).anteil || 0) + ((rB[0] || {}).anteil || 0) - 1) < 0.01,
      { anna: (rA[0] || {}).anteil, ben: (rB[0] || {}).anteil });
    check('4e: das Ziel ist aus db.galaxy verschwunden',
      !(d.galaxy.wrackKonvois || []).some(x => x.id === 'z4'),
      { ziele: (d.galaxy.wrackKonvois || []).map(x => x.id) });
    s = await starteServer(); tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  }

  // ---- 5) Die drei verpasst-Gruende -----------------------------------------------------------
  // 5a: weitergezogen - die Mission zeigt auf das ALTE System, das Ziel steht woanders.
  await aendereDb(d => {
    d.galaxy.wrackKonvois = [zielObj('z5', 'jetzt-hier', 40000, 40000)];
    const sv = liesSave(d, ANNA);
    sv.fleet.missions = [a2mission('m5', 'z5', 'war-dort')];
    schreibSave(d, ANNA, sv);
  });
  const r5a = await schlag(tokA, 'z5', 'm5');
  check('5a: ein weitergedriftetes Ziel meldet "verpasst" mit Grund, ohne Verluste',
    r5a.status === 200 && r5a.body.verpasst === true && r5a.body.grund === 'weitergezogen' && !r5a.body.eigeneVerluste,
    { grund: r5a.body.grund, verluste: r5a.body.eigeneVerluste });
  // 5b: gefallen - das Ziel wurde gestellt (nicht mehr in der Liste), Verlaufsgrund 'gefallen'.
  await aendereDb(d => {
    d.galaxy.wrackKonvois = [];
    d.galaxy.a2Verlauf = [{ id: 'z6', grund: 'gefallen', zeit: Date.now() }];
    const sv = liesSave(d, ANNA);
    sv.fleet.missions = [a2mission('m6', 'z6', 'irgendwo')];
    schreibSave(d, ANNA, sv);
  });
  const r5b = await schlag(tokA, 'z6', 'm6');
  check('5c: ein gestelltes Ziel meldet "verpasst/gefallen", kostenlos',
    r5b.status === 200 && r5b.body.verpasst === true && r5b.body.grund === 'gefallen' && !r5b.body.eigeneVerluste,
    { grund: r5b.body.grund });
  // 5d/5e: ENTKOMMEN - der Tick entfernt ein ueberaltertes Ziel GANZ und vermerkt 'entkommen'.
  await aendereDb(d => {
    const z = zielObj('z7', 'testsys-e', 40000, 40000);
    z.seit = Date.now() - 19 * 3600 * 1000;   // aelter als A2_LEBENSDAUER_MS (18 h)
    d.galaxy.wrackKonvois = [z];
    d.galaxy.a2Verlauf = [];
    const sv = liesSave(d, ANNA);
    sv.fleet.missions = [a2mission('m7', 'z7', 'testsys-e')];
    schreibSave(d, ANNA, sv);
  });
  // Der Serverstart hat den galaxyTick ueber setImmediate einmal gefahren -> A2Tick entfernt z7.
  {
    await stoppeServer();
    const d = liesDb();
    check('5d: der Tick hat das überalterte Ziel GANZ entfernt (nicht verschoben)',
      !(d.galaxy.wrackKonvois || []).some(x => x.id === 'z7'), { ziele: (d.galaxy.wrackKonvois || []).map(x => x.id) });
    check('5d2: und einen Verlaufs-Vermerk "entkommen" hinterlassen',
      (d.galaxy.a2Verlauf || []).some(v => v.id === 'z7' && v.grund === 'entkommen'),
      { verlauf: d.galaxy.a2Verlauf });
    s = await starteServer(); tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  }
  const r5e = await schlag(tokA, 'z7', 'm7');
  check('5e-grund: der Anflug meldet "entkommen" (nicht "gefallen") - der WAHRE Grund',
    r5e.status === 200 && r5e.body.verpasst === true && r5e.body.grund === 'entkommen',
    { grund: r5e.body.grund, text: r5e.body.text });

  // ---- 6) Der Server schreibt den Spielstand des Angreifers NICHT -----------------------------
  const SYS6 = 'testsys-f';
  await aendereDb(d => {
    d.galaxy.wrackKonvois = [zielObj('z8', SYS6, 40000, 40000)];
    const sv = liesSave(d, ANNA);
    sv.fleet.missions = [a2mission('m8', 'z8', SYS6)];
    sv.__marke = 'unberuehrt';
    schreibSave(d, ANNA, sv);
  });
  const vorher6 = liesSave(liesDb(), ANNA);
  const r6 = await schlag(tokA, 'z8', 'm8');
  check('6-anker: der Schlag kam an', r6.status === 200, r6.body);
  {
    await stoppeServer();
    const nachher6 = liesSave(liesDb(), ANNA);
    check('6a: der Spielstand des Angreifers ist unverändert',
      JSON.stringify(vorher6) === JSON.stringify(nachher6),
      { marke: nachher6.__marke, missionen: (nachher6.fleet.missions || []).length });
    s = await starteServer(); tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  }

  // ---- 7) Der galaxieweite Deckel A2_MAX ------------------------------------------------------
  {
    const A2_MAX = parseInt((roh.match(/const A2_MAX = (\d+);/) || [])[1], 10);
    check('7-anker: A2_MAX steht im Quelltext', A2_MAX > 0, { A2_MAX });
    await aendereDb(d => {
      d.galaxy.wrackKonvois = [];
      for (let i = 0; i < A2_MAX; i++) d.galaxy.wrackKonvois.push(zielObj('cap' + i, 'cap-sys-' + i, 40000, 40000));
      d.galaxy.a2NaechsterWurf = 0;             // der Entstehungs-Zweig ist faellig
    });
    // Der Start hat den galaxyTick gefahren; der Deckel muss den Entstehungs-Versuch abgelehnt haben.
    await stoppeServer();
    const d = liesDb();
    check('7a: der Tick lässt die Zahl NICHT über A2_MAX steigen',
      (d.galaxy.wrackKonvois || []).length === A2_MAX, { anzahl: (d.galaxy.wrackKonvois || []).length, A2_MAX });
    s = await starteServer(); tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  }

  // ---- 8) Modul-Beute mit Chance je Anteil, quelle:'konvoi', PvP-Paritaet ----------------------
  /* Gemessen ueber viele Solo-Kills (anteil=1, Chance A2_MODUL_CHANCE je Modul). Kein Einzelwurf -
     der Wurf ist server-gewuerfelt, ein Kill kann leer ausgehen. Ueber ~30 Kills faellt jedes Modul
     mit an Sicherheit grenzender Wahrscheinlichkeit mindestens einmal (0.7^30 ~ 1e-5). */
  {
    let mitModul = 0, mitKampfModul = 0, gesamt = 0;
    let konvoiQuelle = true, richtigerKampfDef = true;
    const RUNDEN = 30;
    for (let i = 0; i < RUNDEN; i++) {
      await aendereDb(d => {
        d.galaxy.wrackKonvois = [zielObj('zm' + i, 'm-sys', 1, 40000)];   // ein Schlag faellt es
        const sv = liesSave(d, ANNA);
        sv.fleet.missions = [a2mission('mm' + i, 'zm' + i, 'm-sys')];
        schreibSave(d, ANNA, sv);
        delete d.private[ANNA].__pendingRewards;
      });
      const r = await schlag(tokA, 'zm' + i, 'mm' + i);
      if (!(r.status === 200 && r.body.gefallen)) continue;
      await stoppeServer();
      const d = liesDb();
      const rew = (d.private[ANNA].__pendingRewards || []).filter(x => x.type === 'wrackkonvoi')[0];
      s = await starteServer(); tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
      if (!rew) continue;
      gesamt++;
      if (rew.modul) { mitModul++; if (rew.modul.quelle !== 'konvoi') konvoiQuelle = false; }
      if (rew.kampfmodul) { mitKampfModul++; if (rew.kampfmodul.quelle !== 'konvoi') konvoiQuelle = false; if (rew.kampfmodul.defKey !== 'kv_bergungspanzer') richtigerKampfDef = false; }
    }
    check('8-anker: alle Kill-Belohnungen gelesen', gesamt === RUNDEN, { gesamt, RUNDEN });
    check('8a: das Standort-Modul fällt manchmal (Chance je Anteil, nicht immer, nicht nie)',
      mitModul > 0 && mitModul < RUNDEN, { mitModul, von: RUNDEN });
    check('8b: das Kampf-Modul fällt manchmal',
      mitKampfModul > 0 && mitKampfModul < RUNDEN, { mitKampfModul, von: RUNDEN });
    check('8c: jedes gefallene Modul trägt quelle:"konvoi"', konvoiQuelle, { konvoiQuelle });
    check('8d: das Kampf-Modul ist kv_bergungspanzer', richtigerKampfDef, { richtigerKampfDef });
    check('8e: kv_bergungspanzer steht in SHIP_MODULE_COMBAT_BASE (PvP-Parität)',
      /kv_bergungspanzer:\s*\{[^}]*effect:\s*'(atk|hull|shield)'/.test(roh),
      { gefunden: /kv_bergungspanzer/.test(roh) });
  }

  // ---- 9) Der Schalter A2_SPAWN_AKTIV ist der Auslieferungs-Riegel -----------------------------
  {
    const schalter = (roh.match(/const A2_SPAWN_AKTIV = (true|false);/) || [])[1];
    check('9a: der Spawn-Schalter ist auffindbar', !!schalter, { steht_auf: schalter });
    check('9b: und er steht auf FALSE (Auslieferungs-Riegel, Regel 60 - erst der Frontend-PR legt ihn um)',
      schalter === 'false',
      { steht_auf: schalter,
        hinweis: 'true heisst: A2 geht LIVE, obwohl das Frontend die Ziele evtl. noch nicht zeichnet - beabsichtigt?' });
  }

  await stoppeServer();

  // ---- Auswertung: Gruen-Lauf ODER Gegenprobe (Regel 71) --------------------------------------
  if (SAB) {
    const soll = MUSS_FALLEN[SAB] || [];
    // check() legt unter dem VOLLEN Namen ab ("3a: ..."), MUSS_FALLEN fuehrt den KURZEN ("3a").
    // Ein Treffer ist die exakte Kurzform ODER "<kurz>:..." - "2a" trifft so NICHT "2a-grund".
    // Kein Treffer = Pruefung existiert nicht mehr = ebenfalls WERKZEUGFEHLER (Regel 71 an sich selbst).
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
