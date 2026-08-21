// Echter HTTP-Test: der koordinierte Verbandsangriff auf ein Alien-Nest (Phase 5).
//
//   node tests/test_muster_nest_http.js
//
// GEPRUEFT WIRD:
//   1. `create` mit zielArt 'alien-nest' legt ein Ziel ohne Allianz an - und lehnt eine
//      erfundene Nest-ID ab.
//   2. DIE SICHERHEITSPRUEFUNG, und sie ist der Grund, warum dieser Test existiert: Bei einem
//      Nest darf der VERTEIDIGER-Zweig von `resolve` gar nicht erst betreten werden.
//      `allianceRoleOf` baut seinen Schluessel per Verkettung; mit `targetTag === null/undefined`
//      entstuende `alliance:undefined:role:<uid>` bzw. `alliance:null:role:<uid>` - ein
//      Schluessel, der wie ein normaler Rolleneintrag aussieht. Der Test LEGT einen solchen
//      Eintrag fuer einen Aussenstehenden an und verlangt trotzdem 403. Ohne den eigenen Zweig
//      duerfte dieser Fremde jeden Nest-Verbandsangriff aufloesen.
//   3. `checkdispatch` schreibt fuer ein Nest KEIN incomingmuster-Dokument (es gibt keinen
//      Verteidiger, der gewarnt werden koennte) - und friert die Einzelkraefte ein.
//   4. `resolve` richtet Schaden an, und der Beitrag landet bei ALLEN Teilnehmern, gewichtet nach
//      ihrer Kraft - nicht beim Ausloeser. Die Abklingzeit steht danach bei allen.
//   5. `claim` gibt die Schiffe zurueck und zahlt NICHT zusaetzlich die Basisangriffs-Waehrung:
//      Die Nest-Belohnung liegt anteilig in __pendingRewards. Zwei Wege waeren eine Doppelzahlung.
//   6. Ist das Nest weg, kostet der Anflug NICHTS und die Antwort nennt den Grund.
//
// GEGENPROBEN (in beide Richtungen ausfuehren, Arbeitsregel 1):
//   * Den Nest-Zweig der Rechtepruefung entfernen (wieder allianceRoleOf(doc.targetTag, ...))
//     -> 2c faellt: der Fremde mit dem praeparierten Rolleneintrag darf aufloesen.
//   * Im Kern nur den Ausloeser gutschreiben statt aller Teilnehmer -> 4c faellt.
//   * claim auch fuer ein Nest die Waehrung zahlen lassen -> 5b faellt.
//
// Port 3228: 3195-3200 und 3210-3227 sind belegt (Arbeitsregel 29).
//
// Wie test_alien_nester_http startet der Test eine KOPIE von server.js mit umgelegtem
// NEST_SPAWN_AKTIV - der Gegenstand haengt am Schalter, und welche Stellung gerade committet ist,
// darf das Ergebnis nicht verschieben.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3228;
const QUELLE = path.join(WURZEL, 'server_musternest_tmp.js');

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ANNA = crypto.randomUUID(), BEN = crypto.randomUUID(), CARL = crypto.randomUUID();
const TAG = 'TST';
const SAVE_KEY = 'kepler7-save-v3';

// Anna traegt die dreifache Kraft von Ben - damit ist der Beitrag MESSBAR gewichtet und nicht
// bloss "beide haben etwas bekommen" (Arbeitsregel 61: die Wirkung messen, nicht das Etikett).
const FLOTTE_A = { cruisers: 300, destroyers: 200, jaeger: 400 };
const FLOTTE_B = { cruisers: 100, destroyers: 60, jaeger: 120 };

function spielstand(id, name, flotte) {
  return {
    resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {},
    fleet: Object.assign({ missions: [] }, flotte),
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  };
}
const rolle = (tag, uid, role) => JSON.stringify({ role, joinedAt: Date.now(), userId: uid });

function grunddb() {
  return {
    users: {
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: Date.now() },
      carl: { userId: CARL, username: 'carl', passwordHash: hash, createdAt: Date.now() }
    },
    private: {
      [ANNA]: { [SAVE_KEY]: JSON.stringify(spielstand(ANNA, 'anna', FLOTTE_A)) },
      [BEN]:  { [SAVE_KEY]: JSON.stringify(spielstand(BEN, 'ben', FLOTTE_B)) },
      [CARL]: { [SAVE_KEY]: JSON.stringify(spielstand(CARL, 'carl', FLOTTE_B)) }
    },
    shared: {
      ['alliance:' + TAG + ':role:' + ANNA]: rolle(TAG, ANNA, 'admin'),
      ['alliance:' + TAG + ':role:' + BEN]: rolle(TAG, BEN, 'member'),
      ['alliance:' + TAG + ':base']: JSON.stringify({ foundedAt: Date.now(), sector: 'vega', level: 3 })
    },
    resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {} }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-musternest-' + process.pid + '.json');
let srv = null, s = null, tokA = null, tokB = null, tokC = null;
function ende() {
  try { if (srv) srv.kill(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.unlinkSync(QUELLE); } catch (e) {}
}
process.on('exit', ende);

async function starteServer() {
  let log = '';
  srv = spawn(process.execPath, [QUELLE], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, { DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret',
      ALLIANCE_RAID_TEST_MODE: '1' }),
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
/* Der Spielstand liegt je nach Alter als blanke Zeichenkette ODER als { value, version } vor -
   setSaveValue schreibt die zweite Form. Ein Test, der nur die erste annimmt, stirbt an einem
   JSON.parse('[object Object]'), sobald der Server den Spielstand einmal geschrieben hat, und
   fuehrt seine uebrigen Pruefungen nie aus (Arbeitsregel 34). Genau das ist hier passiert. */
function liesSave(d, uid) {
  const roh = d.private[uid][SAVE_KEY];
  if (roh === undefined) return null;
  return JSON.parse(typeof roh === 'string' ? roh : roh.value);
}
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));

// Dieselbe Reihenfolge-Wache wie in den Nachbartests: Eine Aenderung an der DB-DATEI, waehrend der
// Server laeuft, ist beim naechsten SIGTERM wieder weg (der Graceful Shutdown flusht darueber).
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  try { await fn(d); }
  catch (e) { check('aufbau: die DB-Aenderung liess sich ausfuehren', false, { fehler: String(e).slice(0, 200) }); }
  schreibDb(d);
  s = await starteServer();
  tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben'); tokC = await s.anmelden('carl');
}

const nestObj = (id, volk, sys, stufe, lp) => ({
  id, volk, sys, stufe, lp, lpMax: lp,
  seit: Date.now() - 3600000, letzteReifung: Date.now(),
  naechsterWurf: Date.now() + 30 * 24 * 3600 * 1000, naechsteWanderung: 0,
  beitraege: {}, schlaege: {}
});

(async () => {
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  const muster = /const NEST_SPAWN_AKTIV = (true|false);/;
  check('0-kopie: der Schalter ist auffindbar', muster.test(roh), { gefunden: (roh.match(muster) || [])[1] });
  fs.writeFileSync(QUELLE, roh.replace(muster, 'const NEST_SPAWN_AKTIV = true;'));

  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  {
    const d = liesDb();
    // Ein Nest mit viel LP: Es soll den Schlag ueberleben, damit 4b/4c den TEILschaden messen
    // koennen statt des Falls (dann waere das Nest weg und die Beitraege mit ihm).
    d.galaxy.alienNester = [nestObj('nest1', 'kryll', 'rigel', 3, 5000000)];
    for (const volk of ['kryll', 'xantheer', 'vex', 'verglueht']) d.galaxy.alienPause[volk] = Date.now() + 30 * 24 * 3600 * 1000;
    schreibDb(d);
  }
  s = await starteServer();
  tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben'); tokC = await s.anmelden('carl');
  check('0: drei Konten angemeldet', !!tokA && !!tokB && !!tokC);
  if (!tokA || !tokB || !tokC) { console.log(s.protokoll().slice(-1500)); process.exit(1); }
  const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
  const post = (pfad, tok, body) => s.j(pfad, { method: 'POST', headers: kopf(tok), body: JSON.stringify(body || {}) });

  // ---- 1) create ------------------------------------------------------------------------------
  {
    const r = await post('/musterattack/create', tokA,
      { tag: TAG, zielArt: 'alien-nest', nestId: 'gibtsnicht', gatherSeconds: 2 });
    check('1a: eine erfundene Nest-ID wird abgelehnt', r.status === 404, { status: r.status, body: r.body });
  }
  {
    const r = await post('/musterattack/create', tokA,
      { tag: TAG, zielArt: 'alien-nest', nestId: 'nest1', gatherSeconds: 2, message: 'Alle mit!' });
    check('1b: ein Nest-Ziel laesst sich ohne targetTag anlegen', r.status === 200 && r.body && r.body.ok,
      { status: r.status, error: r.body && r.body.error });
    const d = liesDb();
    let doc = null; try { doc = JSON.parse(d.shared['alliance:' + TAG + ':musterattack']); } catch (e) {}
    check('1c: das Dokument fuehrt Zielart, Nest und System', !!doc && doc.zielArt === 'alien-nest' &&
      doc.nestId === 'nest1' && doc.nestSystem === 'rigel' && !doc.targetTag,
      { zielArt: doc && doc.zielArt, nestId: doc && doc.nestId, nestSystem: doc && doc.nestSystem, targetTag: doc && doc.targetTag });
  }

  // ---- Beitritt beider Mitglieder -------------------------------------------------------------
  {
    // Die Angriffs-ID aus dem Dokument lesen statt sie zu raten (Arbeitsregel 4).
    let docId = null;
    try { docId = JSON.parse(liesDb().shared['alliance:' + TAG + ':musterattack']).id; } catch (e) {}
    check('1d-vorab: die Angriffs-ID ist lesbar', !!docId, { id: docId });
    const rA = await post('/musterattack/join', tokA, { tag: TAG, musterAttackId: docId, composition: FLOTTE_A, originPlanet: 'home' });
    const rB = await post('/musterattack/join', tokB, { tag: TAG, musterAttackId: docId, composition: FLOTTE_B, originPlanet: 'home' });
    check('1d: beide Mitglieder sind beigetreten', rA.status === 200 && rB.status === 200,
      { anna: rA.status, ben: rB.status, fehlerA: rA.body && rA.body.error, fehlerB: rB.body && rB.body.error });
  }

  // ---- 3) checkdispatch -----------------------------------------------------------------------
  await warte(2600);                       // die Sammelphase ablaufen lassen
  {
    const r = await post('/musterattack/checkdispatch', tokA, { tag: TAG });
    check('3a: der Verband fliegt los', r.status === 200 && r.body && r.body.doc && r.body.doc.phase === 'enroute',
      { status: r.status, phase: r.body && r.body.doc && r.body.doc.phase });
    const d = liesDb();
    const incoming = Object.keys(d.shared).filter(k => k.indexOf(':incomingmuster') >= 0);
    check('3b: fuer ein Nest wird KEIN incomingmuster-Dokument geschrieben', incoming.length === 0,
      { gefunden: incoming, hinweis: 'ein Nest hat keinen Verteidiger, der gewarnt werden koennte' });
    let doc = null; try { doc = JSON.parse(d.shared['alliance:' + TAG + ':musterattack']); } catch (e) {}
    const teil = (doc && doc.dispatch && doc.dispatch.participants) || [];
    check('3c: die Einzelkraefte frieren beim Versand mit ein', teil.length === 2 && teil.every(p => p.power > 0),
      { teilnehmer: teil.map(p => p.id.slice(0, 4) + ':' + p.power) });
    check('3d: und Annas Verband ist der staerkere (die Messvorrichtung fuer 4c)',
      teil.length === 2 && (teil.find(p => p.id === ANNA) || {}).power > (teil.find(p => p.id === BEN) || {}).power,
      { anna: (teil.find(p => p.id === ANNA) || {}).power, ben: (teil.find(p => p.id === BEN) || {}).power });
  }

  // ---- 2) DIE SICHERHEITSPRUEFUNG -------------------------------------------------------------
  /* Carl ist in KEINER Allianz. Praepariert wird ihm ein Rolleneintrag unter genau den beiden
     Schluesseln, die durch Verkettung entstuenden, wenn der Verteidiger-Zweig mit einem fehlenden
     targetTag aufgerufen wuerde. Er muss trotzdem 403 bekommen. */
  await aendereDb(d => {
    d.shared['alliance:undefined:role:' + CARL] = rolle('undefined', CARL, 'admin');
    d.shared['alliance:null:role:' + CARL] = rolle('null', CARL, 'admin');
  });
  {
    const r = await post('/musterattack/resolve', tokC, { tag: TAG });
    check('2c: ein Aussenstehender mit praepariertem "alliance:undefined"-Rolleneintrag darf NICHT aufloesen',
      r.status === 403, { status: r.status, body: r.body,
        hinweis: 'allianceRoleOf verkettet seinen Schluessel - ohne eigenen Nest-Zweig waere das die Luecke' });
  }

  // ---- 4) resolve -----------------------------------------------------------------------------
  const lpVorher = (liesDb().galaxy.alienNester.find(n => n.id === 'nest1') || {}).lp;
  {
    // Die Ankunft vorziehen, statt zu warten.
    await aendereDb(d => {
      const doc = JSON.parse(d.shared['alliance:' + TAG + ':musterattack'] || 'null'); if (!doc) return;
      doc.dispatch.arrivalAt = Date.now() - 1000;
      d.shared['alliance:' + TAG + ':musterattack'] = JSON.stringify(doc);
    });
    const r = await post('/musterattack/resolve', tokB, { tag: TAG });   // BEN loest aus, nicht Anna
    const doc = r.body && r.body.doc;
    check('4a: der Verband loest auf und richtet Schaden an',
      r.status === 200 && doc && doc.phase === 'resolved' && doc.result && doc.result.nest === true && doc.result.damage > 0,
      { status: r.status, phase: doc && doc.phase, damage: doc && doc.result && doc.result.damage });
    const nest = liesDb().galaxy.alienNester.find(n => n.id === 'nest1');
    check('4b: die Lebenspunkte des Nestes sind wirklich gesunken',
      !!nest && nest.lp < lpVorher, { vorher: lpVorher, nachher: nest && nest.lp });

    const b = (nest && nest.beitraege) || {};
    const bA = (b[ANNA] || {}).schaden || 0, bB = (b[BEN] || {}).schaden || 0;
    check('4c: BEIDE Teilnehmer haben einen Beitrag - und Annas ist der groessere',
      bA > 0 && bB > 0 && bA > bB,
      { anna: Math.round(bA), ben: Math.round(bB),
        hinweis: 'Ben hat ausgeloest; wuerde nur der Ausloeser gutgeschrieben, waere Annas Beitrag 0' });
    const sch = (nest && nest.schlaege) || {};
    check('4d: die Abklingzeit steht bei BEIDEN, nicht nur beim Ausloeser',
      !!sch[ANNA] && !!sch[BEN], { anna: !!sch[ANNA], ben: !!sch[BEN] });
    check('4e: die Verluste reisen als QUOTE mit, nicht als Stueckzahlen',
      doc && doc.result && typeof doc.result.ownLossPct === 'number' && doc.result.ownLossPct > 0 && doc.result.ownLossPct < 1,
      { ownLossPct: doc && doc.result && doc.result.ownLossPct });
  }

  // ---- 5) claim -------------------------------------------------------------------------------
  {
    const vorher = liesSave(liesDb(), ANNA);
    const doc = JSON.parse(liesDb().shared['alliance:' + TAG + ':musterattack'] || '{}');
    const r = await post('/musterattack/claim', tokA, { tag: TAG, musterAttackId: doc.id });
    check('5a: claim gibt die Schiffe zurueck', r.status === 200 && r.body && r.body.nest === true,
      { status: r.status, body: r.body && { nest: r.body.nest, lostShips: r.body.lostShips } });
    const nachher = liesSave(liesDb(), ANNA);
    check('5b: und zahlt NICHT zusaetzlich die Basisangriffs-Waehrung',
      nachher.credits === vorher.credits && nachher.battlePoints === vorher.battlePoints,
      { creditsVorher: vorher.credits, creditsNachher: nachher.credits,
        bpVorher: vorher.battlePoints, bpNachher: nachher.battlePoints,
        hinweis: 'die Nest-Belohnung liegt anteilig in __pendingRewards - zwei Wege waeren eine Doppelzahlung' });
    const kreuzerZurueck = (nachher.fleet.cruisers || 0) > 0;
    check('5c: die ueberlebenden Schiffe sind wieder in der Flotte', kreuzerZurueck,
      { cruisers: nachher.fleet.cruisers });
    const pend = (liesDb().private[ANNA].__pendingRewards) || [];
    check('5d: die Nest-Belohnung liegt (bei einem Fall) im Belohnungsfach - hier noch nicht, weil das Nest steht',
      Array.isArray(pend), { anzahl: pend.length });
  }

  // ---- 6) Das Nest ist weg ---------------------------------------------------------------------
  {
    await aendereDb(d => {
      d.galaxy.alienNester = [];                                     // gefallen
      const doc = JSON.parse(d.shared['alliance:' + TAG + ':musterattack'] || 'null'); if (!doc) return;
      doc.phase = 'enroute'; doc.result = null;
      doc.dispatch.arrivalAt = Date.now() - 1000;
      d.shared['alliance:' + TAG + ':musterattack'] = JSON.stringify(doc);
    });
    const r = await post('/musterattack/resolve', tokA, { tag: TAG });
    const rs = r.body && r.body.doc && r.body.doc.result;
    check('6a: ein verschwundenes Nest kostet NICHTS und nennt den Grund',
      r.status === 200 && rs && rs.verpasst === true && rs.grund === 'gefallen' && rs.ownLossPct === 0,
      { status: r.status, verpasst: rs && rs.verpasst, grund: rs && rs.grund, ownLossPct: rs && rs.ownLossPct });
  }

  await stoppeServer();
  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})();
