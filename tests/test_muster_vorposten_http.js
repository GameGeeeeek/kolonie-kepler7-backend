// Echter HTTP-Test: der koordinierte Verbandsangriff auf einen VORPOSTEN (02.09.2026).
//
//   node tests/test_muster_vorposten_http.js
//   KEPLER_MV_SABOTAGE=<schutz|gewicht|meldung|eigen> node tests/test_muster_vorposten_http.js
//
// Gebaut nach test_muster_festung_http.js. Der Grund fuer diesen Weg ist gemessen: Eine Bastion hat
// 400.000 Kern-LP und 60.000 Verteidigung - bei der Einsteiger-Schlagkraft von 7.500 sind das 53
// Schlaege bei vier Stunden Abklingzeit. Solo ist sie nicht zu schleifen.
//
// WAS DIESE ZIELART VON NEST UND FESTUNG UNTERSCHEIDET: Ein Vorposten gehoert einem SPIELER. Er
// verhaelt sich in `resolve` trotzdem wie ein PvE-Ziel (kein Verteidiger-Zweig, kein
// incomingmuster), weil sein Besitzer keine ALLIANZ ist - genau das sagt der neue Name
// musterZielOhneAllianz. Daraus folgen die drei Pruefungen, die es bei Nest und Festung nicht gibt:
// der Bauschutz gilt auch fuer den Verband, den EIGENEN greift man auch im Verband nicht an, und
// der Besitzer wird benachrichtigt.
//
// GEPRUEFT WIRD:
//   1. `create` mit zielArt 'vorposten' legt ein Ziel ohne Allianz an; erfundene Kennung (404),
//      eigener Vorposten (400), Vorposten unter Bauschutz (403).
//   2. DIE SICHERHEITSPRUEFUNG: Bei einem Vorposten darf der VERTEIDIGER-Zweig von `resolve` nicht
//      betreten werden - ein Aussenstehender mit praepariertem `alliance:null:role:<uid>` bekommt
//      403 (dieselbe Verkettungsfalle wie bei Nest und Festung).
//   3. `checkdispatch` schreibt KEIN incomingmuster-Dokument und friert die Einzelkraefte ein.
//   4. `resolve` richtet Schaden am Kern an, der Beitrag landet bei ALLEN Teilnehmern gewichtet
//      nach Kraft (nicht beim Ausloeser), die Abklingzeit steht bei allen, die Verluste reisen als
//      Quote - und DER BESITZER WIRD BENACHRICHTIGT (mit Kernstand).
//   5. `claim` gibt nur die Schiffe zurueck, zahlt keine Basisangriffs-Waehrung.
//   6. DER BAUSCHUTZ GILT AUCH BEI DER ANKUNFT: Wurde der Vorposten waehrend der Sammelphase neu
//      gebaut, kommt der Verband an und richtet NICHTS an (verpasst, Grund 'schutz').
//   7. Ist der Vorposten weg, kostet der Anflug nichts und die Antwort nennt den Grund.
//
// GEGENPROBEN (je mit "was fallen MUSS"-Liste, Regel 1/71):
//   * schutz  : die Bauschutz-Pruefung bei der Ankunft entfaellt -> 6a faellt (der Verband schlaegt zu).
//   * gewicht : im Kern nur der Ausloeser gutgeschrieben          -> 4c und 4d fallen.
//   * meldung : die Benachrichtigung an den Besitzer entfaellt    -> 4h faellt.
//   * eigen   : die Eigenbesitz-Pruefung in create entfaellt      -> 1b faellt.
//
// Port 3247 (belegt bis 3246, gemessen). Startet eine KOPIE von server.js mit umgelegtem
// VORPOSTEN_AKTIV - welche Stellung gerade committet ist, darf das Ergebnis nicht verschieben.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3247;
const QUELLE = path.join(WURZEL, 'server_mustervorposten_tmp.js');
const SAB = process.env.KEPLER_MV_SABOTAGE || '';
const MUSS_FALLEN = { schutz: ['6a'], gewicht: ['4c', '4d'], meldung: ['4h'], eigen: ['1b'] };

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
const ANNA = crypto.randomUUID(), BEN = crypto.randomUUID(), CARL = crypto.randomUUID(), DORA = crypto.randomUUID();
const TAG = 'TST';
const SAVE_KEY = 'kepler7-save-v3';
const SYS = 'vpsys-m';

// Anna traegt die dreifache Kraft von Ben - damit ist der Beitrag MESSBAR gewichtet (4c).
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

// Dora ist die BESITZERIN - bewusst ausserhalb der Allianz, damit 4h eine echte Fremdmeldung misst.
function vorposten(opt) {
  opt = opt || {};
  return {
    id: opt.id || 'vp-m1', sys: SYS, besitzer: opt.besitzer || DORA, besitzerName: opt.besitzerName || 'dora',
    seit: opt.seit !== undefined ? opt.seit : Date.now() - 30 * 3600 * 1000,   // Bauschutz (12 h) laengst abgelaufen
    stufe: opt.stufe || 3,
    kern: { lp: opt.lp || 400000, lpMax: 400000 },
    garnison: opt.garnison || { jaeger: 100 }, schlaege: {}, beitraege: {},
    ausbauSeit: Date.now() - 30 * 3600 * 1000, kampfverlauf: []
  };
}

function grunddb() {
  return {
    users: {
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: Date.now() },
      carl: { userId: CARL, username: 'carl', passwordHash: hash, createdAt: Date.now() },
      dora: { userId: DORA, username: 'dora', passwordHash: hash, createdAt: Date.now() }
    },
    private: {
      [ANNA]: { [SAVE_KEY]: JSON.stringify(spielstand(ANNA, 'anna', FLOTTE_A)) },
      [BEN]:  { [SAVE_KEY]: JSON.stringify(spielstand(BEN, 'ben', FLOTTE_B)) },
      [CARL]: { [SAVE_KEY]: JSON.stringify(spielstand(CARL, 'carl', FLOTTE_B)) },
      [DORA]: { [SAVE_KEY]: JSON.stringify(spielstand(DORA, 'dora', FLOTTE_B)) }
    },
    shared: {
      ['alliance:' + TAG + ':role:' + ANNA]: rolle(TAG, ANNA, 'admin'),
      ['alliance:' + TAG + ':role:' + BEN]: rolle(TAG, BEN, 'member'),
      ['alliance:' + TAG + ':base']: JSON.stringify({ foundedAt: Date.now(), sector: 'vega', level: 3 }),
      ['vorposten:' + SYS]: JSON.stringify(vorposten())
    },
    resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {} }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-mustervorposten-' + process.pid + '.json');
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
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
function liesSave(d, uid) {
  const roh = d.private[uid][SAVE_KEY];
  if (roh === undefined) return null;
  return JSON.parse(typeof roh === 'string' ? roh : roh.value);
}
const liesDoc = d => { const raw = d.shared['vorposten:' + SYS]; return typeof raw === 'string' ? JSON.parse(raw) : null; };
const schreibDoc = (d, doc) => { d.shared['vorposten:' + SYS] = JSON.stringify(doc); };
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  try { await fn(d); }
  catch (e) { check('aufbau: die DB-Aenderung liess sich ausfuehren', false, { fehler: String(e).slice(0, 200) }); }
  schreibDb(d);
  s = await starteServer();
  tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben'); tokC = await s.anmelden('carl');
}

(async () => {
  let roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  const muster = /const VORPOSTEN_AKTIV = (true|false);/;
  check('0-kopie: der Schalter ist auffindbar', muster.test(roh), { gefunden: (roh.match(muster) || [])[1] });
  roh = roh.replace(muster, 'const VORPOSTEN_AKTIV = true;');
  const sab = {
    schutz: ["    const schutzBisV = (vp.seit || 0) + VORPOSTEN_SCHUTZ_MS;\n    if (jetztV < schutzBisV) {",
             "    const schutzBisV = (vp.seit || 0) + VORPOSTEN_SCHUTZ_MS;\n    if (false) {"],
    gewicht: ["const ergV = vorpostenSchlagAusfuehren(vp, doc.dispatch.totalPower, doc.dispatch.totalComposition || {}, beteiligteV, jetztV);",
              "const ergV = vorpostenSchlagAusfuehren(vp, doc.dispatch.totalPower, doc.dispatch.totalComposition || {}, [beteiligteV[beteiligteV.length - 1]], jetztV);"],
    meldung: ["          pushNotificationEvent(besitzerV, 'vorposten-angegriffen', {",
              "          if (false) pushNotificationEvent(besitzerV, 'vorposten-angegriffen', {"],
    eigen: ["    if (vorpostenZiel.besitzer === req.userId) return res.status(400).json({ error: 'Den eigenen Vorposten greift man nicht an.' });", ""]
  };
  if (SAB) {
    const paar = sab[SAB];
    if (!paar) { console.log('Unbekannte Sabotage: ' + SAB); process.exit(2); }
    check('0-sab: die Stelle fuer ' + SAB + ' ist genau einmal auffindbar', roh.split(paar[0]).length === 2, { treffer: roh.split(paar[0]).length - 1 });
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
  const docLesen = () => { try { return JSON.parse(liesDb().shared['alliance:' + TAG + ':musterattack']); } catch (e) { return null; } };

  // ---- 1) create -------------------------------------------------------------------------------
  {
    const r = await post('/musterattack/create', tokA, { tag: TAG, zielArt: 'vorposten', vorpostenSystem: SYS, vorpostenId: 'gibtsnicht', gatherSeconds: 2 });
    check('1a: eine erfundene Vorposten-Kennung wird abgelehnt (404)', r.status === 404, { status: r.status, error: r.body && r.body.error });

    // 1b: der EIGENE Vorposten - Anna bekommt ihn kurz zugeschrieben.
    await aendereDb(d => { const doc = liesDoc(d); doc.besitzer = ANNA; doc.besitzerName = 'anna'; schreibDoc(d, doc); });
    const eig = await post('/musterattack/create', tokA, { tag: TAG, zielArt: 'vorposten', vorpostenSystem: SYS, gatherSeconds: 2 });
    check('1b: den EIGENEN Vorposten greift man auch im Verband nicht an (400)',
      eig.status === 400 && /eigenen/.test((eig.body && eig.body.error) || ''), { status: eig.status, error: eig.body && eig.body.error });
    /* Aufraeumen: GREIFT die Sperre nicht (Gegenprobe `eigen`), ist hier ein echter Angriff
       entstanden und blockiert als laufender jeden weiteren `create` mit 409 - der ganze Rest des
       Tests faellt dann aus dem falschen Grund. Gemessen beim ersten Lauf der Gegenprobe: statt 1b
       fielen 18 Pruefungen. Der Ablauf raeumt deshalb IMMER auf, egal ob die Sperre griff. */
    await aendereDb(d => {
      const doc = liesDoc(d); doc.besitzer = DORA; doc.besitzerName = 'dora'; schreibDoc(d, doc);
      delete d.shared['alliance:' + TAG + ':musterattack'];
    });

    // 1c: Bauschutz - frisch gebaut.
    await aendereDb(d => { const doc = liesDoc(d); doc.seit = Date.now(); schreibDoc(d, doc); });
    const schutz = await post('/musterattack/create', tokA, { tag: TAG, zielArt: 'vorposten', vorpostenSystem: SYS, gatherSeconds: 2 });
    check('1c: ein Vorposten unter Bauschutz laesst sich nicht als Verbandsziel ausrufen (403)',
      schutz.status === 403 && schutz.body && schutz.body.schutz === true, { status: schutz.status, error: schutz.body && schutz.body.error });
    await aendereDb(d => { const doc = liesDoc(d); doc.seit = Date.now() - 30 * 3600 * 1000; schreibDoc(d, doc); });

    const ok = await post('/musterattack/create', tokA, { tag: TAG, zielArt: 'vorposten', vorpostenSystem: SYS, vorpostenId: 'vp-m1', gatherSeconds: 2, message: 'Alle mit!' });
    check('1d: ein Vorposten-Ziel laesst sich ohne targetTag anlegen', ok.status === 200 && ok.body && ok.body.ok, { status: ok.status, error: ok.body && ok.body.error });
    const doc = docLesen();
    check('1e: das Dokument fuehrt Zielart, Kennung, System, Besitzer und Stufenname',
      !!doc && doc.zielArt === 'vorposten' && doc.vorpostenId === 'vp-m1' && doc.vorpostenSystem === SYS && !doc.targetTag
        && doc.vorpostenBesitzerName === 'dora' && !!doc.vorpostenStufeName,
      doc && { zielArt: doc.zielArt, id: doc.vorpostenId, sys: doc.vorpostenSystem, targetTag: doc.targetTag, besitzer: doc.vorpostenBesitzerName, stufe: doc.vorpostenStufeName });
    const zweit = await post('/musterattack/create', tokA, { tag: TAG, zielArt: 'alien-nest', nestId: 'x', gatherSeconds: 2 });
    check('1f: ein zweiter Angriff nennt den Vorposten als Gegner (409)',
      zweit.status === 409 && /Vorposten von dora/.test((zweit.body && zweit.body.error) || ''), { status: zweit.status, error: zweit.body && zweit.body.error });
  }

  // ---- Beitritt --------------------------------------------------------------------------------
  {
    const docId = (docLesen() || {}).id;
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
    const incoming = Object.keys(liesDb().shared).filter(k => k.indexOf(':incomingmuster') >= 0);
    check('3b: fuer einen Vorposten wird KEIN incomingmuster-Dokument geschrieben', incoming.length === 0, { gefunden: incoming });
    const teil = ((docLesen() || {}).dispatch || {}).participants || [];
    check('3c: die Einzelkraefte frieren beim Versand ein, Annas Verband ist der staerkere',
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
  const lpVorher = (liesDoc(liesDb()) || {}).kern.lp;
  {
    await aendereDb(d => {
      const doc = JSON.parse(d.shared['alliance:' + TAG + ':musterattack'] || 'null'); if (!doc) return;
      doc.dispatch.arrivalAt = Date.now() - 1000;
      d.shared['alliance:' + TAG + ':musterattack'] = JSON.stringify(doc);
    });
    const r = await post('/musterattack/resolve', tokB, { tag: TAG });   // BEN loest aus, nicht Anna
    const res_ = r.body && r.body.doc && r.body.doc.result;
    check('4a: der Verband loest auf und richtet Schaden am Kern an',
      r.status === 200 && res_ && res_.vorposten === true && res_.damage > 0 && res_.verpasst !== true,
      { status: r.status, result: res_ && { damage: res_.damage, lp: res_.lp, verteidigung: res_.defensePower } });
    const vpNach = liesDoc(liesDb());
    check('4b: der Kern ist wirklich gesunken', !!vpNach && vpNach.kern.lp < lpVorher, { vorher: lpVorher, nachher: vpNach && vpNach.kern.lp });
    const b = (vpNach && vpNach.beitraege) || {};
    const bA = (b[ANNA] || {}).schaden || 0, bB = (b[BEN] || {}).schaden || 0;
    check('4c: BEIDE Teilnehmer haben einen Beitrag - und Annas ist der groessere (Ben hat ausgeloest)',
      bA > 0 && bB > 0 && bA > bB, { anna: Math.round(bA), ben: Math.round(bB) });
    const sch = (vpNach && vpNach.schlaege) || {};
    check('4d: die Abklingzeit steht bei BEIDEN, nicht nur beim Ausloeser', !!sch[ANNA] && !!sch[BEN], { anna: !!sch[ANNA], ben: !!sch[BEN] });
    check('4e: die Verluste reisen als QUOTE mit', res_ && res_.ownLossPct > 0 && res_.ownLossPct < 1, { ownLossPct: res_ && res_.ownLossPct });
    check('4f: die Garnison hat serverseitig verloren', !!vpNach && (vpNach.garnison.jaeger || 0) < 100, { nachher: vpNach && vpNach.garnison });
    /* 4h: DER BESITZER ERFAEHRT ES AUCH BEIM VERBAND. Ohne diese Zeile waere die Luecke vom
       02.09.2026 ueber den Verbandsweg wieder offen - ausgerechnet fuer den Angriff, der ihn am
       ehesten kostet. Der Angreifername ist der TAG, nicht ein einzelner Spieler: Es war ein Verband. */
    const meldungen = (liesDb().private[DORA] || {}).__notificationEvents || [];
    const meldung = meldungen.find(m => m.type === 'vorposten-angegriffen');
    check('4h: der Besitzer wird auch beim Verbandsangriff benachrichtigt - mit Allianz-Tag und Kernstand',
      !!meldung && meldung.payload.angreiferName === '[' + TAG + ']' && typeof meldung.payload.kernProzent === 'number',
      { gefunden: !!meldung, payload: meldung && meldung.payload });
  }

  // ---- 5) claim --------------------------------------------------------------------------------
  {
    const vorher = liesSave(liesDb(), BEN);
    const doc = docLesen() || {};
    const r = await post('/musterattack/claim', tokB, { tag: TAG, musterAttackId: doc.id });
    check('5a: claim gibt die Schiffe zurueck und nennt den Vorposten',
      r.status === 200 && r.body && r.body.vorposten === true && r.body.pve === true,
      { status: r.status, body: r.body && { vorposten: r.body.vorposten, lostShips: r.body.lostShips, error: r.body.error } });
    const nachher = liesSave(liesDb(), BEN);
    check('5b: und zahlt NICHT zusaetzlich die Basisangriffs-Waehrung',
      nachher.credits === vorher.credits && nachher.battlePoints === vorher.battlePoints,
      { creditsVorher: vorher.credits, creditsNachher: nachher.credits });
    check('5c: die ueberlebenden Schiffe sind wieder in der Flotte',
      (nachher.fleet.cruisers || 0) > 0 && (nachher.fleet.cruisers || 0) <= FLOTTE_B.cruisers, { cruisers: nachher.fleet.cruisers });
    /* Anna holt ihre Schiffe ebenfalls ab - sonst hat sie fuer Abschnitt 6 keine mehr, ihr Beitritt
       scheitert still, und der Verband flaege ohne Teilnehmer los. Genau so ist der erste Lauf
       gescheitert: `dispatch` blieb null, und 6a/7a fielen aus dem falschen Grund. */
    const rA5 = await post('/musterattack/claim', tokA, { tag: TAG, musterAttackId: doc.id });
    check('5d: auch die Ausrufende bekommt ihre Schiffe zurueck', rA5.status === 200 && rA5.body && rA5.body.ok, { status: rA5.status });
  }

  // ---- 6) Der Bauschutz gilt AUCH bei der Ankunft -----------------------------------------------
  {
    const rNeu = await post('/musterattack/create', tokA, { tag: TAG, zielArt: 'vorposten', vorpostenSystem: SYS, gatherSeconds: 2 });
    check('6-vorab: ein zweiter Verband laesst sich planen', rNeu.status === 200, { status: rNeu.status, error: rNeu.body && rNeu.body.error });
    const docId = (docLesen() || {}).id;
    // Den Beitritt PRUEFEN, nicht annehmen: Ein stiller Fehlschlag hier laesst den Verband ohne
    // Teilnehmer losfliegen, und 6a faellt dann aus dem falschen Grund (Regel 16).
    const joinA6 = await post('/musterattack/join', tokA, { tag: TAG, musterAttackId: docId, composition: { cruisers: 50 }, originPlanet: 'home' });
    check('6-vorab2: der Beitritt zum zweiten Verband hat geklappt', joinA6.status === 200, { status: joinA6.status, error: joinA6.body && joinA6.body.error });
    await warte(2600);
    const cd6 = await post('/musterattack/checkdispatch', tokA, { tag: TAG });
    check('6-vorab3: und er ist unterwegs (dispatch steht)', !!(cd6.body && cd6.body.doc && cd6.body.doc.dispatch), { phase: cd6.body && cd6.body.doc && cd6.body.doc.phase });
    /* Der Vorposten wurde WAEHREND der Sammelphase neu gebaut (der alte fiel, jemand baute nach) -
       er steht jetzt unter Bauschutz. Ohne die Pruefung bei der Ankunft waere der Verband der Weg,
       den Bauschutz zu umgehen. */
    const lpVor6 = (liesDoc(liesDb()) || {}).kern.lp;
    await aendereDb(d => {
      const doc = JSON.parse(d.shared['alliance:' + TAG + ':musterattack'] || 'null'); if (doc) { doc.dispatch.arrivalAt = Date.now() - 1000; d.shared['alliance:' + TAG + ':musterattack'] = JSON.stringify(doc); }
      const vp = liesDoc(d); vp.seit = Date.now(); schreibDoc(d, vp);
    });
    const r = await post('/musterattack/resolve', tokA, { tag: TAG });
    const rs = r.body && r.body.doc && r.body.doc.result;
    const lpNach6 = (liesDoc(liesDb()) || {}).kern.lp;
    check('6a: ein frisch gebauter Vorposten ist auch fuer den Verband geschuetzt - kein Schaden, Grund genannt',
      !!rs && rs.verpasst === true && rs.grund === 'schutz' && rs.ownLossPct === 0 && lpNach6 === lpVor6,
      { verpasst: rs && rs.verpasst, grund: rs && rs.grund, lpVorher: lpVor6, lpNachher: lpNach6 });
    await post('/musterattack/claim', tokA, { tag: TAG, musterAttackId: docId });
  }

  // ---- 7) Der Vorposten ist weg -----------------------------------------------------------------
  {
    await aendereDb(d => {
      delete d.shared['vorposten:' + SYS];
      const doc = JSON.parse(d.shared['alliance:' + TAG + ':musterattack'] || 'null'); if (!doc) return;
      doc.phase = 'enroute'; doc.result = null; doc.dispatch.arrivalAt = Date.now() - 1000;
      d.shared['alliance:' + TAG + ':musterattack'] = JSON.stringify(doc);
    });
    const r = await post('/musterattack/resolve', tokA, { tag: TAG });
    const rs = r.body && r.body.doc && r.body.doc.result;
    check('7a: ein verschwundener Vorposten kostet NICHTS und nennt den Grund',
      r.status === 200 && rs && rs.vorposten === true && rs.verpasst === true && rs.grund === 'weg' && rs.ownLossPct === 0,
      { status: r.status, verpasst: rs && rs.verpasst, grund: rs && rs.grund });
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
