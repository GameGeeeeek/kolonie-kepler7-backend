// Echter HTTP-Test: der koordinierte Verbandsangriff auf eine ASTEROIDENFESTUNG (01.09.2026).
//
//   node tests/test_muster_festung_http.js
//   KEPLER_MF_SABOTAGE=<rechte|gewicht|claim> node tests/test_muster_festung_http.js   (Gegenproben)
//
// Gebaut nach test_muster_nest_http.js (Phase 5) - der Verband gegen ein Nest ist das Vorbild, und
// der Festungsschlag laeuft ueber DENSELBEN Rechenkern wie der Einzelangriff
// (festungSchlagAusfuehren), so wie das Nest ueber nestSchlagAusfuehren.
//
// GEPRUEFT WIRD:
//   1. `create` mit zielArt 'festung' legt ein Ziel ohne Allianz an, lehnt eine erfundene Kennung
//      (404), eine unbekannte Zielart (400) und ein unbekanntes Bauteil (400) ab.
//   2. DIE SICHERHEITSPRUEFUNG: Bei einer Festung darf der VERTEIDIGER-Zweig von `resolve` nicht
//      betreten werden - `allianceRoleOf` verkettet seinen Schluessel, und mit targetTag null
//      entstuende `alliance:null:role:<uid>`. Ein Aussenstehender mit genau diesem praeparierten
//      Eintrag muss trotzdem 403 bekommen.
//   3. `checkdispatch` schreibt fuer eine Festung KEIN incomingmuster-Dokument und friert die
//      Einzelkraefte ein.
//   4. `resolve` richtet Schaden am Kern an, der Beitrag landet bei ALLEN Teilnehmern gewichtet
//      nach Kraft (nicht beim Ausloeser), die Abklingzeit steht bei allen, die Verluste reisen
//      als Quote.
//   5. `claim` gibt nur die Schiffe zurueck und zahlt KEINE Basisangriffs-Waehrung (der Hort liegt
//      anteilig in __pendingRewards).
//   6. Die ZIELWAHL des Verbands (Schildkuppel) trifft das Bauteil statt des Kerns.
//   7. Ist die Festung weg, kostet der Anflug NICHTS und die Antwort nennt den Grund.
//
// GEGENPROBEN (KEPLER_MF_SABOTAGE, je mit "was fallen MUSS"-Liste; der Lauf exit-0t nur, wenn genau
// die erwarteten Pruefungen fielen, sonst WERKZEUGFEHLER - Frontend-Arbeitsregel 71):
//   * rechte  : der Verteidiger-Zweig wird fuer die Festung wieder betreten -> 2c faellt.
//   * gewicht : im Kern nur der Ausloeser gutgeschrieben                    -> 4c und 4d fallen.
//   * claim   : claim zahlt auch fuer eine Festung die Waehrung             -> 5a und 5b fallen.
//
// Port 3241 (belegt bis 3240, Arbeitsregel 29). Startet eine KOPIE von server.js mit umgelegtem
// FESTUNG_SPAWN_AKTIV - welche Stellung gerade committet ist, darf das Ergebnis nicht verschieben.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3241;
const QUELLE = path.join(WURZEL, 'server_musterfestung_tmp.js');
const SAB = process.env.KEPLER_MF_SABOTAGE || '';
/* GEMESSEN, nicht vorhergesagt: `gewicht` reisst auch 4d (nur der Ausloeser bekommt die Abklingzeit),
   `claim` auch 5a (die Antwort traegt dann weder `festung` noch `pve`). Die erste Fassung dieser
   Liste nannte je nur eine Pruefung - eine Pflichtliste ist selbst eine Behauptung, bis die
   Gegenprobe sie gemessen hat. */
const MUSS_FALLEN = { rechte: ['2c'], gewicht: ['4c', '4d'], claim: ['5a', '5b'] };

let fail = false;
const ergebnis = {};
const check = (n, c, x) => {
  ergebnis[n.split(':')[0]] = !!c;
  console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : ''));
  fail = fail || !c;
};
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ANNA = crypto.randomUUID(), BEN = crypto.randomUUID(), CARL = crypto.randomUUID();
const TAG = 'TST';
const SAVE_KEY = 'kepler7-save-v3';

// Anna traegt die dreifache Kraft von Ben - damit ist der Beitrag MESSBAR gewichtet.
const FLOTTE_A = { cruisers: 300, destroyers: 200, jaeger: 400 };
const FLOTTE_B = { cruisers: 100, destroyers: 60, jaeger: 120 };

function spielstand(id, name, flotte) {
  return {
    resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {},
    fleet: Object.assign({ missions: [] }, flotte),
    player: { id, name, allianceTag: TAG }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
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

const dbPfad = path.join(os.tmpdir(), 'kepler-musterfestung-' + process.pid + '.json');
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
function liesSave(d, uid) {
  const roh = d.private[uid][SAVE_KEY];
  if (roh === undefined) return null;
  return JSON.parse(typeof roh === 'string' ? roh : roh.value);
}
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  try { await fn(d); }
  catch (e) { check('aufbau: die DB-Aenderung liess sich ausfuehren', false, { fehler: String(e).slice(0, 200) }); }
  schreibDb(d);
  s = await starteServer();
  tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben'); tokC = await s.anmelden('carl');
}

const KERN = 5000000;                 // gross genug, dass die Festung den Verband ueberlebt
const SCHILD = Math.round(KERN * 0.40), TUERME = Math.round(KERN * 0.25);
function festung(opt) {
  opt = opt || {};
  return {
    id: 'fest-1', stufe: 'sternenfeste', platz: '0', sorte: 'eisen',
    kernMax: KERN, kern: KERN, hort: 100000, hortProto: 100,
    seit: Date.now() - 3600000, letzteReifung: Date.now(), beitraege: {}, schlaege: {},
    bauteile: {
      schild: { lp: opt.schild === undefined ? SCHILD : opt.schild, lpMax: SCHILD, letzteReifung: Date.now() },
      tuerme: { lp: TUERME, lpMax: TUERME }
    }
  };
}

(async () => {
  let roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  const muster = /const FESTUNG_SPAWN_AKTIV = (true|false);/;
  check('0-kopie: der Schalter ist auffindbar', muster.test(roh), { gefunden: (roh.match(muster) || [])[1] });
  roh = roh.replace(muster, 'const FESTUNG_SPAWN_AKTIV = true;');
  const sab = {
    // Der Name wurde am 02.09.2026 zu musterZielOhneAllianz - ein Vorposten ist PvP-Inhalt, hat aber
    // ebenfalls keine verteidigende Allianz; genau das ist die Frage, die hier zaehlt.
    rechte: ["(doc && !musterZielOhneAllianz(doc.zielArt)) ? allianceRoleOf(doc.targetTag, req.userId) : null",
             "(doc && doc.zielArt !== 'alien-nest') ? allianceRoleOf(doc.targetTag, req.userId) : null"],
    gewicht: ["doc.dispatch.totalComposition || {}, beteiligteF, jetzt, doc.festungZiel || 'kern', null);",
              "doc.dispatch.totalComposition || {}, [beteiligteF.find(b => b.userId === req.userId) || beteiligteF[0]], jetzt, doc.festungZiel || 'kern', null);"],
    claim: ["if (res_.nest || res_.festung) {", "if (res_.nest) {"]
  };
  if (SAB) {
    const paar = sab[SAB];
    if (!paar) { console.log('Unbekannte Sabotage: ' + SAB); process.exit(2); }
    check('0-sabotage: die Stelle fuer ' + SAB + ' ist genau einmal auffindbar', roh.split(paar[0]).length === 2, { treffer: roh.split(paar[0]).length - 1 });
    roh = roh.replace(paar[0], paar[1]);
  }
  fs.writeFileSync(QUELLE, roh);

  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  s = await starteServer();
  tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben'); tokC = await s.anmelden('carl');
  check('0: drei Konten angemeldet', !!tokA && !!tokB && !!tokC);
  if (!tokA || !tokB || !tokC) { console.log(s.protokoll().slice(-1500)); process.exit(1); }
  const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
  const post = (pfad, tok, body) => s.j(pfad, { method: 'POST', headers: kopf(tok), body: JSON.stringify(body || {}) });

  const f0 = await s.j('/asteroid/field', { headers: kopf(tokA) });
  check('0b: Guertelfeld lesbar', f0.status === 200, f0.status);
  if (f0.status !== 200) { console.log(s.protokoll().slice(-1500)); process.exit(1); }
  const sys = (f0.body.systeme || [])[0];
  const feldKey = 'asteroids:' + sys;
  await aendereDb(d => { const feld = d.shared[feldKey]; feld.festung = festung(); d.shared[feldKey] = feld; });
  const docLesen = () => { try { return JSON.parse(liesDb().shared['alliance:' + TAG + ':musterattack']); } catch (e) { return null; } };
  const festLesen = () => (liesDb().shared[feldKey] || {}).festung || null;

  // ---- 1) create -------------------------------------------------------------------------------
  {
    const r = await post('/musterattack/create', tokA, { tag: TAG, zielArt: 'festung', festungSystem: sys, festungId: 'gibtsnicht', gatherSeconds: 2 });
    check('1a: eine erfundene Festungs-Kennung wird abgelehnt (404)', r.status === 404, { status: r.status, error: r.body && r.body.error });
    const r2 = await post('/musterattack/create', tokA, { tag: TAG, zielArt: 'mond', targetTag: 'XYZ', gatherSeconds: 2 });
    check('1b: eine unbekannte Zielart wird abgelehnt (400)', r2.status === 400, { status: r2.status, error: r2.body && r2.body.error });
    const r3 = await post('/musterattack/create', tokA, { tag: TAG, zielArt: 'festung', festungSystem: sys, festungId: 'fest-1', festungZiel: 'dach', gatherSeconds: 2 });
    check('1c: ein unbekanntes Bauteil als Ziel wird abgelehnt (400)', r3.status === 400, { status: r3.status, error: r3.body && r3.body.error });
    const r4 = await post('/musterattack/create', tokA, { tag: TAG, zielArt: 'festung', festungSystem: sys, festungId: 'fest-1', festungZiel: 'kern', gatherSeconds: 2, message: 'Alle mit!' });
    check('1d: ein Festungs-Ziel laesst sich ohne targetTag anlegen', r4.status === 200 && r4.body && r4.body.ok, { status: r4.status, error: r4.body && r4.body.error });
    const doc = docLesen();
    check('1e: das Dokument fuehrt Zielart, Festung, System, Stufenname und Zielwahl',
      !!doc && doc.zielArt === 'festung' && doc.festungId === 'fest-1' && doc.festungSystem === sys && !doc.targetTag
        && doc.festungStufeName === 'Sternenfeste' && doc.festungZiel === 'kern',
      doc && { zielArt: doc.zielArt, festungId: doc.festungId, festungSystem: doc.festungSystem, targetTag: doc.targetTag, stufe: doc.festungStufeName, ziel: doc.festungZiel });
    const r5 = await post('/musterattack/create', tokA, { tag: TAG, zielArt: 'alien-nest', nestId: 'x', gatherSeconds: 2 });
    check('1f: ein zweiter Angriff waehrend des laufenden nennt die Festung als Gegner (409)',
      r5.status === 409 && /Asteroidenfestung/.test((r5.body && r5.body.error) || ''), { status: r5.status, error: r5.body && r5.body.error });
  }

  // ---- Beitritt --------------------------------------------------------------------------------
  {
    const docId = (docLesen() || {}).id;
    check('1g-vorab: die Angriffs-ID ist lesbar', !!docId, { id: docId });
    const rA = await post('/musterattack/join', tokA, { tag: TAG, musterAttackId: docId, composition: FLOTTE_A, originPlanet: 'home' });
    const rB = await post('/musterattack/join', tokB, { tag: TAG, musterAttackId: docId, composition: FLOTTE_B, originPlanet: 'home' });
    check('1g: beide Mitglieder sind beigetreten', rA.status === 200 && rB.status === 200,
      { anna: rA.status, ben: rB.status, fehlerA: rA.body && rA.body.error, fehlerB: rB.body && rB.body.error });
  }

  // ---- 3) checkdispatch ------------------------------------------------------------------------
  await warte(2600);
  {
    const r = await post('/musterattack/checkdispatch', tokA, { tag: TAG });
    check('3a: der Verband fliegt los', r.status === 200 && r.body && r.body.doc && r.body.doc.phase === 'enroute',
      { status: r.status, phase: r.body && r.body.doc && r.body.doc.phase });
    const d = liesDb();
    const incoming = Object.keys(d.shared).filter(k => k.indexOf(':incomingmuster') >= 0);
    check('3b: fuer eine Festung wird KEIN incomingmuster-Dokument geschrieben', incoming.length === 0, { gefunden: incoming });
    const doc = docLesen();
    const teil = (doc && doc.dispatch && doc.dispatch.participants) || [];
    check('3c: die Einzelkraefte frieren beim Versand mit ein', teil.length === 2 && teil.every(p => p.power > 0),
      { teilnehmer: teil.map(p => p.id.slice(0, 4) + ':' + p.power) });
    check('3d: und Annas Verband ist der staerkere (Messvorrichtung fuer 4c)',
      teil.length === 2 && (teil.find(p => p.id === ANNA) || {}).power > (teil.find(p => p.id === BEN) || {}).power,
      { anna: (teil.find(p => p.id === ANNA) || {}).power, ben: (teil.find(p => p.id === BEN) || {}).power });
  }

  // ---- 2) DIE SICHERHEITSPRUEFUNG --------------------------------------------------------------
  await aendereDb(d => {
    d.shared['alliance:undefined:role:' + CARL] = rolle('undefined', CARL, 'admin');
    d.shared['alliance:null:role:' + CARL] = rolle('null', CARL, 'admin');
  });
  {
    const r = await post('/musterattack/resolve', tokC, { tag: TAG });
    check('2c: ein Aussenstehender mit praepariertem "alliance:null"-Rolleneintrag darf NICHT aufloesen',
      r.status === 403, { status: r.status, body: r.body });
  }

  // ---- 4) resolve ------------------------------------------------------------------------------
  const kernVorher = (festLesen() || {}).kern;
  {
    await aendereDb(d => {
      const doc = JSON.parse(d.shared['alliance:' + TAG + ':musterattack'] || 'null'); if (!doc) return;
      doc.dispatch.arrivalAt = Date.now() - 1000;
      d.shared['alliance:' + TAG + ':musterattack'] = JSON.stringify(doc);
    });
    const r = await post('/musterattack/resolve', tokB, { tag: TAG });   // BEN loest aus, nicht Anna
    const doc = r.body && r.body.doc;
    check('4a: der Verband loest auf und richtet Schaden am Kern an',
      r.status === 200 && doc && doc.phase === 'resolved' && doc.result && doc.result.festung === true && doc.result.damage > 0 && doc.result.ziel === 'kern',
      { status: r.status, phase: doc && doc.phase, result: doc && doc.result && { damage: doc.result.damage, ziel: doc.result.ziel, kern: doc.result.kern } });
    const fest = festLesen();
    check('4b: der Kern der Festung ist wirklich gesunken', !!fest && fest.kern < kernVorher, { vorher: kernVorher, nachher: fest && fest.kern });
    const b = (fest && fest.beitraege) || {};
    const bA = (b[ANNA] || {}).schaden || 0, bB = (b[BEN] || {}).schaden || 0;
    check('4c: BEIDE Teilnehmer haben einen Beitrag - und Annas ist der groessere (Ben hat ausgeloest)',
      bA > 0 && bB > 0 && bA > bB, { anna: Math.round(bA), ben: Math.round(bB) });
    const sch = (fest && fest.schlaege) || {};
    check('4d: die Abklingzeit steht bei BEIDEN, nicht nur beim Ausloeser', !!sch[ANNA] && !!sch[BEN], { anna: !!sch[ANNA], ben: !!sch[BEN] });
    check('4e: die Verluste reisen als QUOTE mit', doc && doc.result && doc.result.ownLossPct > 0 && doc.result.ownLossPct < 1, { ownLossPct: doc && doc.result && doc.result.ownLossPct });
    check('4f: das Ergebnis traegt den Bauteil-Zustand fuer die Anzeige', doc && doc.result && doc.result.bauteile && doc.result.bauteile.schild && doc.result.bauteile.schild.lp > 0,
      { bauteile: doc && doc.result && doc.result.bauteile });
  }

  // ---- 5) claim --------------------------------------------------------------------------------
  {
    const vorher = liesSave(liesDb(), BEN);
    const doc = docLesen() || {};
    const r = await post('/musterattack/claim', tokB, { tag: TAG, musterAttackId: doc.id });
    check('5a: claim gibt die Schiffe zurueck und nennt die Festung', r.status === 200 && r.body && r.body.festung === true && r.body.pve === true,
      { status: r.status, body: r.body && { festung: r.body.festung, lostShips: r.body.lostShips, error: r.body.error } });
    const nachher = liesSave(liesDb(), BEN);
    check('5b: und zahlt NICHT zusaetzlich die Basisangriffs-Waehrung',
      nachher.credits === vorher.credits && nachher.battlePoints === vorher.battlePoints
        && (nachher.resources.forschungspunkte || 0) === (vorher.resources.forschungspunkte || 0),
      { creditsVorher: vorher.credits, creditsNachher: nachher.credits, bpVorher: vorher.battlePoints, bpNachher: nachher.battlePoints });
    check('5c: die ueberlebenden Schiffe sind wieder in der Flotte', (nachher.fleet.cruisers || 0) > 0 && (nachher.fleet.cruisers || 0) <= FLOTTE_B.cruisers,
      { cruisers: nachher.fleet.cruisers });
    /* Anna holt ihre Schiffe ebenfalls zurueck - sonst steht sie fuer Abschnitt 6 ohne Kreuzer da
       (der Beitritt zieht die Flotte SOFORT vom Standort ab), ihr Beitritt schlaegt still fehl, der
       zweite Verband fliegt ohne Teilnehmer nie los, und 6b misst ein Dokument ohne `dispatch`.
       Genau so ist der erste Lauf dieses Tests gescheitert. */
    const rA = await post('/musterattack/claim', tokA, { tag: TAG, musterAttackId: doc.id });
    check('5d: auch Anna bekommt ihre Schiffe zurueck', rA.status === 200 && (liesSave(liesDb(), ANNA).fleet.cruisers || 0) > 100,
      { status: rA.status, cruisers: liesSave(liesDb(), ANNA).fleet.cruisers });
  }

  // ---- 6) die Zielwahl des Verbands ------------------------------------------------------------
  {
    const rA = await post('/musterattack/create', tokA, { tag: TAG, zielArt: 'festung', festungSystem: sys, festungId: 'fest-1', festungZiel: 'schild', gatherSeconds: 2 });
    check('6a: ein zweiter Verband mit Ziel Schildkuppel laesst sich planen', rA.status === 200 && rA.body && rA.body.ok, { status: rA.status, error: rA.body && rA.body.error });
    const docId = (docLesen() || {}).id;
    const rJ = await post('/musterattack/join', tokA, { tag: TAG, musterAttackId: docId, composition: { cruisers: 100 }, originPlanet: 'home' });
    check('6a2: Anna tritt dem zweiten Verband bei', rJ.status === 200, { status: rJ.status, error: rJ.body && rJ.body.error });
    await warte(2600);
    const rD = await post('/musterattack/checkdispatch', tokA, { tag: TAG });
    check('6a3: der zweite Verband fliegt los', rD.body && rD.body.doc && rD.body.doc.phase === 'enroute', { phase: rD.body && rD.body.doc && rD.body.doc.phase });
    const schildVorher = ((festLesen() || {}).bauteile || {}).schild;
    await aendereDb(d => {
      const doc = JSON.parse(d.shared['alliance:' + TAG + ':musterattack'] || 'null'); if (!doc) return;
      doc.dispatch.arrivalAt = Date.now() - 1000;
      d.shared['alliance:' + TAG + ':musterattack'] = JSON.stringify(doc);
    });
    const r = await post('/musterattack/resolve', tokA, { tag: TAG });
    const rs = r.body && r.body.doc && r.body.doc.result;
    const schildNachher = ((festLesen() || {}).bauteile || {}).schild;
    check('6b: der Verband trifft die Schildkuppel - Bauteilschaden > 0, Kernschaden 0',
      !!rs && rs.ziel === 'schild' && rs.teilSchaden > 0 && rs.damage === 0 && schildNachher && schildVorher && schildNachher.lp < schildVorher.lp,
      { ziel: rs && rs.ziel, teilSchaden: rs && rs.teilSchaden, kernschaden: rs && rs.damage, schildVorher: schildVorher && schildVorher.lp, schildNachher: schildNachher && schildNachher.lp });
    await post('/musterattack/claim', tokA, { tag: TAG, musterAttackId: docId });
  }

  // ---- 7) Die Festung ist weg -------------------------------------------------------------------
  {
    await aendereDb(d => {
      const feld = d.shared[feldKey]; delete feld.festung; d.shared[feldKey] = feld;   // gefallen
      const doc = JSON.parse(d.shared['alliance:' + TAG + ':musterattack'] || 'null'); if (!doc) return;
      doc.phase = 'enroute'; doc.result = null;
      doc.dispatch.arrivalAt = Date.now() - 1000;
      d.shared['alliance:' + TAG + ':musterattack'] = JSON.stringify(doc);
    });
    const r = await post('/musterattack/resolve', tokA, { tag: TAG });
    const rs = r.body && r.body.doc && r.body.doc.result;
    check('7a: eine verschwundene Festung kostet NICHTS und nennt den Grund',
      r.status === 200 && rs && rs.festung === true && rs.verpasst === true && rs.grund === 'gefallen' && rs.ownLossPct === 0,
      { status: r.status, verpasst: rs && rs.verpasst, grund: rs && rs.grund, ownLossPct: rs && rs.ownLossPct });
  }

  await stoppeServer();
  if (SAB) {
    const muss = MUSS_FALLEN[SAB] || [];
    const gefallen = Object.keys(ergebnis).filter(k => !ergebnis[k]);
    const fehlend = muss.filter(k => ergebnis[k] !== false);
    const zuviel = gefallen.filter(k => !muss.includes(k));
    if (!fehlend.length && !zuviel.length) { console.log('\nGEGENPROBE ' + SAB + ': genau ' + muss.join(', ') + ' gefallen - wie erwartet.'); process.exit(0); }
    console.log('\nWERKZEUGFEHLER Gegenprobe ' + SAB + ': erwartet ' + JSON.stringify(muss) + ', gefallen ' + JSON.stringify(gefallen));
    process.exit(1);
  }
  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})();
