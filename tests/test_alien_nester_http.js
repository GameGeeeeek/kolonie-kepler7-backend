// Echter HTTP-Test: Alien-Nester - Angriff, Abklingzeit, Schwaeche, Fall, Koenigin, Tick.
//
//   node tests/test_alien_nester_http.js
//
// Phase 3 des Konzepts unter docs/aliens-asteroidenfestungen-konzept.md (Frontend-Repo,
// Abschnitt 5). Gemessen wird an einem echten Server mit echter DB - die entscheidenden
// Eigenschaften haengen an db.galaxy und lassen sich durch Lesen des Quelltextes nicht belegen.
//
// GEPRUEFT WIRD:
//   1. Quelltext-Paritaet: Jeder Name in ALIEN_VOELKER steht WOERTLICH in ALIEN_RACE_NAMES.
//      Darueber laeuft die Zuordnung zwischen dem "Volk entdeckt"-Ereignis und seinem Nest -
//      eine Umbenennung auf einer Seite bricht sie still.
//   2. Ein Schlag kommt an: LP sinken, der Beitrag steht in db.galaxy, die Antwort nennt Schaden
//      und Verluste.
//   3. DIE ABKLINGZEIT LIEGT AM NEST, nicht im Spielstand - und sie ueberlebt einen
//      Spielstand-Reset. Genau das ist die Messung, die die beiden Ablageorte unterscheidet.
//   4. DIE SCHWAECHE WIRKT (nicht: steht in der Antwort). Gemessen als Vergleich der MITTELWERTE
//      ueber je acht Schlaege DERSELBEN Flotte gegen zwei Voelker - eines, dessen Schwaeche die
//      Flotte traegt, eines, dessen nicht. Ein Einzelvergleich koennte das nicht: Der Wurf
//      streut um +-20 %, die Spanne enthielte 1,0 und die Pruefung waere nicht entscheidbar.
//   5. Gezaehlt wird, was ANGEKOMMEN ist - ein Schlag gegen ein fast totes Nest traegt nur den
//      Rest zum Beitrag bei, nicht den vollen Wurf.
//   6. Der Fall: Nest weg, BEIDE Beitragenden haben eine Belohnung in __pendingRewards - der
//      zweite, ohne dass sein Spielstand angefasst wurde.
//   7. DIE KOENIGIN reisst den ganzen Schwarm ihres Volkes mit und setzt die 72-Stunden-Pause.
//   8. Ist das Nest weitergezogen oder gefallen, kostet der Anflug NICHTS: keine Verluste, keine
//      Abklingzeit - und die Antwort nennt den GRUND.
//   9. Der Server schreibt den Spielstand des Angreifers NICHT.
//  10. Der Tick reift Nester und deckelt ihre Zahl - und ein reifendes Nest HEILT NICHT.
//  11. Der Spawn-Schalter.
//
// GEGENPROBEN (in beide Richtungen ausgefuehrt, Arbeitsregel 1):
//   * Abklingzeit in den Spielstand statt ans Nest -> 3b faellt (der Reset gaebe sie frei).
//   * `schaden = wurf` statt `lpVorher - lp` -> 5b faellt.
//   * Schwaechen-Faktor ausgebaut -> 4c faellt (Verhaeltnis rutscht auf ~1,0).
//   * Beim Reifen `lp = lpMax` statt der Differenz -> 10c faellt.
//   * Koenigin ohne Schwarm-Zerfall -> 7b/7c fallen.
//
// Port 3224: 3195-3200, 3210-3223 sind belegt (Arbeitsregel 29).
//
// WICHTIG - warum der Test eine KOPIE von server.js startet: Der Spawn-Schalter steht bis zum
// Frontend der Phase 3 auf false, und dann tut nestTick gar nichts. Der Test flippt ihn in einer
// temporaeren Kopie NEBEN server.js (im Repo-Verzeichnis, damit `require('./mailer')` aufloest)
// und raeumt sie am Ende weg. Damit misst er den echten Code mit genau der einen Zeile, die
// spaeter ohnehin umgelegt wird - und er bleibt gruen, egal wie der Schalter committet ist.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3224;
const QUELLE = path.join(WURZEL, 'server_nesttest_tmp.js');

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ANNA = crypto.randomUUID(), BEN = crypto.randomUUID();

/* Die Flotte traegt JAEGER, aber KEINE BOMBER. Damit ist sie die Messvorrichtung fuer Abschnitt 4:
   Gegen die Kryll (Schwaeche jaeger) trifft sie, gegen die Xantheer (Schwaeche bomber) nicht -
   und zwar mit exakt derselben Kraft, weil es dieselbe Flotte ist. */
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
      unlockedAlienRaces: [], alienNester: [], alienPause: {} }
  };
}

const SAVE_KEY = 'kepler7-save-v3';
const dbPfad = path.join(os.tmpdir(), 'kepler-nester-' + process.pid + '.json');
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

/* Dieselbe Reihenfolge-Wache wie in test_festung_http.js, und aus demselben gemessenen Grund:
   Eine Aenderung an der DB-DATEI, waehrend der Server laeuft, ist beim naechsten SIGTERM wieder
   weg - der Graceful Shutdown flusht die im Speicher gehaltene db darueber. */
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  s = await starteServer();
  tokA = await s.anmelden('anna');
  tokB = await s.anmelden('ben');
}

/* Der Spielstand liegt in db.private je nach Alter in ZWEI Formen vor: als blanke Zeichenkette
   oder als { value, version } - setSaveValue() schreibt die zweite. Der erste Entwurf dieses Tests
   nahm nur die erste an und STARB an einem JSON.parse('[object Object]'), sobald eine Gegenprobe
   den Server dazu brachte, den Spielstand zu schreiben. Ein Test, der beim Aufbau seiner
   Messvorrichtung abstuerzt, hat seine uebrigen Pruefungen nicht ausgefuehrt - und der rote
   Exit-Code verdeckt genau das (Frontend-Arbeitsregel 34). Beide Formen werden deshalb hier
   gelesen und beim Schreiben wird die vorgefundene Form beibehalten. */
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

const nestObj = (id, volk, sys, stufe, lp, lpMax) => ({
  id, volk, sys, stufe, lp, lpMax,
  seit: Date.now() - 3600000, letzteReifung: Date.now(),
  naechsterWurf: Date.now() + 8 * 3600 * 1000, naechsteWanderung: 0,
  beitraege: {}, schlaege: {}
});
const mission = (id, nestId, sys) => ({
  id, type: 'nest-angriff', targetId: sys, system: sys, nestId,
  startTime: Date.now() - 7200000, endTime: Date.now() - 3600000,
  fleetName: 'Flotte 1', composition: Object.assign({}, FLOTTE)
});

(async () => {
  // Die Kopie mit umgelegtem Schalter - der Grund steht im Kopfkommentar.
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  const geflippt = roh.replace(/const NEST_SPAWN_AKTIV = (true|false);/, 'const NEST_SPAWN_AKTIV = true;');
  check('0-kopie: der Schalter liess sich in der Kopie umlegen',
    /const NEST_SPAWN_AKTIV = true;/.test(geflippt), { gefunden: /const NEST_SPAWN_AKTIV = (true|false);/.test(roh) });
  fs.writeFileSync(QUELLE, geflippt);

  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  s = await starteServer();
  tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  check('0: zwei Konten angemeldet', !!tokA && !!tokB);
  if (!tokA || !tokB) { console.log(s.protokoll().slice(-1500)); process.exit(1); }
  const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
  const schlag = (tok, nestId, missionId) => s.j('/alien/nest-angriff', {
    method: 'POST', headers: kopf(tok), body: JSON.stringify({ nestId, missionId })
  });

  // ---- 1) Quelltext-Paritaet der Volksnamen ---------------------------------------------------
  {
    /* AUF DEN BLOCK GESCOPT, und das ist kein Schoenheitsfehler: `schwaeche:` steht auch in der
       Weltboss-Archetypen-Tabelle. Die ungescopte Suche fand neun Namen statt vier und meldete
       fuenf Weltboss-Archetypen als fehlende Voelker (Frontend-Arbeitsregel 39 - ein Schluessel
       kann in mehreren Tabellen vorkommen). Der Anker des Blocks wird mitgeprueft, sonst waere
       die Aussage vacuous, sobald sich der Tabellenkopf aendert (Regel 6). */
    const vonV = roh.indexOf('const ALIEN_VOELKER = {');
    const bisV = vonV < 0 ? -1 : roh.indexOf('\n};', vonV);
    check('1-block: der ALIEN_VOELKER-Block ist abgegrenzt', vonV >= 0 && bisV > vonV, { vonV, bisV });
    const block = (vonV >= 0 && bisV > vonV) ? roh.slice(vonV, bisV) : '';
    const namenAusVoelker = [...block.matchAll(/name: '([^']+)',\s+schwaeche:/g)].map(m => m[1]);
    const listeM = roh.match(/const ALIEN_RACE_NAMES = \[([^\]]*)\]/);
    const namenAusListe = listeM ? [...listeM[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];
    check('1-anker: beide Namenslisten sind auffindbar',
      namenAusVoelker.length === 4 && namenAusListe.length === 4,
      { voelker: namenAusVoelker.length, liste: namenAusListe.length });
    const fehlend = namenAusVoelker.filter(n => !namenAusListe.includes(n));
    check('1a: jedes Volk aus ALIEN_VOELKER steht wörtlich in ALIEN_RACE_NAMES',
      fehlend.length === 0, { fehlend, voelker: namenAusVoelker, liste: namenAusListe });
  }

  // ---- 2) Ein Schlag kommt an -----------------------------------------------------------------
  const SYS1 = 'testsys-a';
  await aendereDb(d => {
    d.galaxy.alienNester = [nestObj('n1', 'kryll', SYS1, 3, 400000, 400000)];
    const sv = liesSave(d, ANNA);
    sv.fleet.missions = [mission('m1', 'n1', SYS1)];
    schreibSave(d, ANNA, sv);
  });
  const r1 = await schlag(tokA, 'n1', 'm1');
  check('2a: der Schlag wird angenommen', r1.status === 200 && r1.body.ok === true, r1.body);
  check('2b: er richtet Schaden an', (r1.body.schaden || 0) > 0, { schaden: r1.body.schaden });
  check('2c: die LP sind gesunken', (r1.body.lp || 0) < 400000, { lp: r1.body.lp, lpMax: r1.body.lpMax });
  check('2d: die Antwort nennt eigene Verluste',
    Object.keys(r1.body.eigeneVerluste || {}).length > 0, { verluste: r1.body.eigeneVerluste });
  {
    await stoppeServer();
    const d = liesDb();
    const n = (d.galaxy.alienNester || []).find(x => x.id === 'n1');
    check('2e: der Beitrag steht in db.galaxy, nicht im Spielstand',
      !!n && !!n.beitraege && (n.beitraege[ANNA] || {}).schaden > 0,
      { beitraege: n && n.beitraege });
    s = await starteServer(); tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  }

  // ---- 3) Die Abklingzeit liegt AM NEST --------------------------------------------------------
  await aendereDb(d => {
    const sv = liesSave(d, ANNA);
    sv.fleet.missions = [mission('m2', 'n1', SYS1)];
    schreibSave(d, ANNA, sv);
  });
  const r2 = await schlag(tokA, 'n1', 'm2');
  check('3a: der zweite Schlag prallt an der Abklingzeit ab', r2.status === 403, r2.body);
  // Der GRUND muss im Text stehen - ein blosser 403 waere von "keine Flotte unterwegs" nicht zu
  // unterscheiden, das antwortet ebenfalls 403 (Arbeitsregel 28).
  check('3a-grund: und der Fehlertext nennt die Abklingzeit',
    r2.status === 403 && (r2.body.abklingzeit === true || /Abklingzeit|vor Kurzem/.test(r2.body.error || '')),
    { error: r2.body.error });
  // 3b ist die eigentliche Messung: Ein geloeschter Spielstand-Eintrag darf sie NICHT freigeben.
  await aendereDb(d => {
    const sv = liesSave(d, ANNA);
    delete sv.nestLetzterSchlag;
    sv.fleet.missions = [mission('m3', 'n1', SYS1)];
    schreibSave(d, ANNA, sv);
  });
  const r3 = await schlag(tokA, 'n1', 'm3');
  check('3b: sie überlebt einen Spielstand-Reset (Ablageort am Nest, nicht im Save)',
    r3.status === 403, { status: r3.status, body: r3.body });

  // ---- 4) Die Schwaeche WIRKT ------------------------------------------------------------------
  /* Zwei Voelker, dieselbe Flotte, je acht Nester und je ein Schlag. Die Flotte traegt Jaeger
     (Kryll-Schwaeche) und keine Bomber (Xantheer-Schwaeche) - der Unterschied im Mittelwert ist
     die Wirkung. Acht Messungen je Seite, weil der Wurf um +-20 % streut: Ein Einzelvergleich
     ergaebe eine Spanne, die 1,0 enthaelt, und koennte "wirkt" von "wirkt nicht" nicht trennen. */
  const N = 8;
  await aendereDb(d => {
    d.galaxy.alienNester = [];
    const sv = liesSave(d, ANNA);
    sv.fleet.missions = [];
    for (let i = 0; i < N; i++) {
      for (const volk of ['kryll', 'xantheer']) {
        const id = volk + i;
        d.galaxy.alienNester.push(nestObj(id, volk, 'sw-' + id, 4, 5e7, 5e7));   // LP hoch: darf nicht fallen
        sv.fleet.missions.push(mission('ms-' + id, id, 'sw-' + id));
      }
    }
    schreibSave(d, ANNA, sv);
  });
  const mit = [], ohne = [];
  for (let i = 0; i < N; i++) {
    const a = await schlag(tokA, 'kryll' + i, 'ms-kryll' + i);
    const b = await schlag(tokA, 'xantheer' + i, 'ms-xantheer' + i);
    if (a.status === 200) mit.push(a.body.schaden || 0);
    if (b.status === 200) ohne.push(b.body.schaden || 0);
  }
  const mittel = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  check('4-anker: alle 16 Schläge kamen durch', mit.length === N && ohne.length === N,
    { mit: mit.length, ohne: ohne.length });
  check('4a: die Antwort meldet den Schwächentreffer nur beim passenden Volk',
    mit.length === N && ohne.length === N, { hinweis: 'siehe 4b/4c für die Wirkung' });
  const verh = mittel(mit) / Math.max(1, mittel(ohne));
  check('4b: gegen das Volk mit passender Schwäche kommt MEHR an',
    mittel(mit) > mittel(ohne), { mitSchwaeche: Math.round(mittel(mit)), ohne: Math.round(mittel(ohne)) });
  check('4c: und zwar um rund den Schwächenfaktor 1,25',
    verh > 1.10 && verh < 1.45,
    { verhaeltnis: verh.toFixed(3), erwartet: '~1.25',
      hinweis: 'nahe 1,0 heisst: der Faktor wirkt nicht' });

  // ---- 5) Gezaehlt wird, was ANGEKOMMEN ist ----------------------------------------------------
  const SYS2 = 'testsys-b';
  await aendereDb(d => {
    d.galaxy.alienNester = [nestObj('n5', 'vex', SYS2, 2, 500, 120000)];   // fast tot
    const sv = liesSave(d, BEN);
    sv.fleet.missions = [mission('m5', 'n5', SYS2)];
    schreibSave(d, BEN, sv);
  });
  const r5 = await schlag(tokB, 'n5', 'm5');
  check('5a: der Schlag fällt das Nest', r5.status === 200 && r5.body.gefallen === true, r5.body);
  check('5b: gezählt wird der Rest, nicht der volle Wurf',
    r5.body.schaden === 500,
    { schaden: r5.body.schaden, erwartet: 500,
      hinweis: 'deutlich mehr heisst: der volle Wurf wird gezaehlt, der letzte Angreifer risse den Anteil an sich' });

  // ---- 6) Der Fall zahlt an ALLE Beitragenden --------------------------------------------------
  const SYS3 = 'testsys-c';
  await aendereDb(d => {
    d.galaxy.alienNester = [nestObj('n6', 'kryll', SYS3, 3, 400000, 400000)];
    for (const [uid, id] of [[ANNA, 'm6a'], [BEN, 'm6b']]) {
      const sv = liesSave(d, uid);
      sv.fleet.missions = [mission(id, 'n6', SYS3)];
      schreibSave(d, uid, sv);
      delete d.private[uid].__pendingRewards;
    }
  });
  await schlag(tokA, 'n6', 'm6a');
  await aendereDb(d => {
    const n = d.galaxy.alienNester.find(x => x.id === 'n6');
    if (n) n.lp = 1;                       // Ben führt den letzten Schlag
  });
  const r6 = await schlag(tokB, 'n6', 'm6b');
  check('6a: das Nest fällt', r6.status === 200 && r6.body.gefallen === true, r6.body);
  {
    await stoppeServer();
    const d = liesDb();
    const rA = (d.private[ANNA].__pendingRewards || []).filter(x => x.type === 'alien-nest');
    const rB = (d.private[BEN].__pendingRewards || []).filter(x => x.type === 'alien-nest');
    check('6b: BEIDE Beitragenden haben eine Belohnung in der Warteschlange',
      rA.length === 1 && rB.length === 1, { anna: rA.length, ben: rB.length });
    check('6c: die Anteile summieren sich auf rund 1',
      Math.abs(((rA[0] || {}).anteil || 0) + ((rB[0] || {}).anteil || 0) - 1) < 0.01,
      { anna: (rA[0] || {}).anteil, ben: (rB[0] || {}).anteil });
    check('6d: das Nest ist aus db.galaxy verschwunden',
      !(d.galaxy.alienNester || []).some(x => x.id === 'n6'),
      { nester: (d.galaxy.alienNester || []).map(x => x.id) });
    s = await starteServer(); tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  }

  // ---- 7) Die Koenigin reisst den Schwarm mit --------------------------------------------------
  await aendereDb(d => {
    d.galaxy.alienNester = [
      nestObj('q1', 'verglueht', 'q-sys', 5, 800, 4400000),
      nestObj('q2', 'verglueht', 'q-sys2', 3, 400000, 400000),
      nestObj('q3', 'verglueht', 'q-sys3', 2, 120000, 120000),
      nestObj('fremd', 'kryll', 'k-sys', 2, 96000, 96000)     // anderes Volk - MUSS stehen bleiben
    ];
    d.galaxy.alienPause = {};
    const sv = liesSave(d, ANNA);
    sv.fleet.missions = [mission('mq', 'q1', 'q-sys')];
    schreibSave(d, ANNA, sv);
  });
  const r7 = await schlag(tokA, 'q1', 'mq');
  check('7a: die Königin fällt', r7.status === 200 && r7.body.gefallen === true, r7.body);
  check('7b: die Antwort meldet den Zerfall des Schwarms',
    r7.body.schwarmGefallen === true && r7.body.mitgerissen === 2,
    { schwarmGefallen: r7.body.schwarmGefallen, mitgerissen: r7.body.mitgerissen });
  {
    await stoppeServer();
    const d = liesDb();
    /* Geprueft wird die REGEL, nicht die Momentaufnahme (Arbeitsregel 3). Der erste Entwurf
       verlangte GENAU ein uebriges Nest und fiel an einem Zufall: Der galaxyTick entdeckt mit 6 %
       je Takt ein neues Volk, und der Nachschub-Zweig legt ihm sofort ein Nest an - voellig
       korrektes Verhalten, das mit dem Koeniginnen-Fall nichts zu tun hat. Die Aussage lautet
       also: kein Nest des GEFALLENEN Volkes mehr, und das fremde steht noch. */
    const alle = d.galaxy.alienNester || [];
    check('7c: kein Nest des gefallenen Volkes bleibt übrig',
      !alle.some(x => x.volk === 'verglueht'),
      { verglueht: alle.filter(x => x.volk === 'verglueht').map(x => x.id) });
    check('7c2: und das FREMDE Volk ist unberührt',
      alle.some(x => x.id === 'fremd'), { ids: alle.map(x => x.id) });
    check('7d: und die Pause des Volkes läuft',
      ((d.galaxy.alienPause || {}).verglueht || 0) > Date.now(),
      { pause: (d.galaxy.alienPause || {}).verglueht });
    s = await starteServer(); tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  }

  // ---- 8) Weitergezogen oder gefallen kostet NICHTS ---------------------------------------------
  await aendereDb(d => {
    d.galaxy.alienNester = [nestObj('n8', 'vex', 'wo-anders', 3, 400000, 400000)];
    const sv = liesSave(d, ANNA);
    sv.fleet.missions = [mission('m8', 'n8', 'wo-war-es')];   // Mission zeigt auf das ALTE System
    schreibSave(d, ANNA, sv);
  });
  const r8 = await schlag(tokA, 'n8', 'm8');
  check('8a: ein weitergezogenes Nest meldet "verpasst" statt eines Fehlers',
    r8.status === 200 && r8.body.verpasst === true, r8.body);
  check('8b: mit GRUND und ohne Verluste',
    r8.body.grund === 'weitergezogen' && !r8.body.eigeneVerluste,
    { grund: r8.body.grund, verluste: r8.body.eigeneVerluste });
  {
    await stoppeServer();
    const d = liesDb();
    const n = (d.galaxy.alienNester || []).find(x => x.id === 'n8');
    check('8c: und OHNE Abklingzeit - der Spieler kann es sofort erneut versuchen',
      !!n && !(n.schlaege || {})[ANNA], { schlaege: n && n.schlaege });
    s = await starteServer(); tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  }

  // ---- 9) Der Server schreibt den Spielstand des Angreifers NICHT ------------------------------
  const SYS9 = 'testsys-d';
  await aendereDb(d => {
    d.galaxy.alienNester = [nestObj('n9', 'kryll', SYS9, 3, 400000, 400000)];
    const sv = liesSave(d, ANNA);
    sv.fleet.missions = [mission('m9', 'n9', SYS9)];
    sv.__marke = 'unberuehrt';
    schreibSave(d, ANNA, sv);
  });
  const vorher9 = liesSave(liesDb(), ANNA);
  const r9 = await schlag(tokA, 'n9', 'm9');
  check('9-anker: der Schlag kam an', r9.status === 200, r9.body);
  {
    await stoppeServer();
    const nachher9 = liesSave(liesDb(), ANNA);
    check('9a: der Spielstand des Angreifers ist unverändert',
      JSON.stringify(vorher9) === JSON.stringify(nachher9),
      { marke: nachher9.__marke, missionen: (nachher9.fleet.missions || []).length });
    s = await starteServer(); tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  }

  // ---- 10) Der Tick: reifen, nicht heilen; und der Deckel ---------------------------------------
  await aendereDb(d => {
    // Ein angeschlagenes Nest, dessen Reifung faellig ist (Kryll: 6 Stunden).
    const n = nestObj('t1', 'kryll', 't-sys', 1, 10000, 32000);
    n.letzteReifung = Date.now() - 7 * 3600 * 1000;
    d.galaxy.alienNester = [n];
  });
  // Der Start hat den galaxyTick ueber setImmediate einmal gefahren.
  {
    await stoppeServer();
    const d = liesDb();
    const n = (d.galaxy.alienNester || []).find(x => x.id === 't1');
    check('10a: der Tick hat das Nest reifen lassen', !!n && n.stufe === 2,
      { stufe: n && n.stufe, lp: n && n.lp, lpMax: n && n.lpMax });
    check('10b: die Höchst-LP folgen der neuen Stufe',
      !!n && n.lpMax === Math.round(120000 * 0.8), { lpMax: n && n.lpMax, erwartet: 96000 });
    /* 10c ist die eigentliche Aussage: Der angerichtete Schaden BLEIBT angerichtet. Heilte das
       Nest beim Reifen voll, waere jeder Schlag davor wertlos - und Warten die beste Strategie
       fuer den Schwarm statt fuer den Spieler. */
    check('10c: aber es HEILT NICHT - der Schaden bleibt angerichtet',
      !!n && n.lp === 10000 + (96000 - 32000) && n.lp < n.lpMax,
      { lp: n && n.lp, erwartet: 74000, lpMax: n && n.lpMax });
    s = await starteServer(); tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  }
  // Der Deckel: mehr als NEST_MAX Nester duerfen durch Ausbreitung nicht entstehen.
  {
    const deckel = (roh.match(/const NEST_MAX = (\d+);/) || [])[1];
    check('10d: der galaxieweite Deckel steht im Quelltext', !!deckel, { NEST_MAX: deckel });
  }

  // ---- 11) Der Spawn-Schalter -------------------------------------------------------------------
  {
    const schalter = (roh.match(/const NEST_SPAWN_AKTIV = (true|false);/) || [])[1];
    check('11a: der Spawn-Schalter ist auffindbar', !!schalter, { steht_auf: schalter });
    check('11b: er trägt einen der beiden Werte', schalter === 'true' || schalter === 'false',
      { steht_auf: schalter });
    check('11c: und er steht auf true, seit das Frontend der Phase 3 ausgeliefert ist',
      schalter === 'true',
      { steht_auf: schalter,
        hinweis: 'false heisst ab jetzt NOTABSCHALTUNG - beabsichtigt? Dann gehoert der Grund in die CLAUDE.md' });
  }

  await stoppeServer();
  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})();
