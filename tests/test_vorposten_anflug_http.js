// Echter HTTP-Test: DIE VORWARNUNG BEIM ANFLUG auf einen Vorposten (03.09.2026).
//
//   node tests/test_vorposten_anflug_http.js
//   KEPLER_VA_SABOTAGE=<offen|bleibt|verfall> node tests/test_vorposten_anflug_http.js
//
// WARUM ES DIESE ETAPPE GIBT. Das Vorposten-Konzept sagt dem Besitzer zu, er koenne mit einer
// Garnison gegenhalten. Einloesbar war das nicht: Er erfuhr vom Verband erst beim ERSTEN SCHLAG,
// also nach der Ankunft - da ist Verstaerken zu spaet. Seit dem 02.09.2026 gibt es die Meldung
// beim Schlag; hier kommt die Vorwarnung waehrend des Anflugs dazu.
//
// WO SIE WOHNT UND WARUM DORT. Ein Vorposten gehoert einem SPIELER, nicht einer Allianz - der
// Weg ueber `alliance:<tag>:incomingmuster` steht also nicht offen. Der Vermerk haengt deshalb am
// Vorposten-Dokument selbst und wird in vorpostenFuerClient ausgespielt, das ohnehin je Nutzer
// entscheidet, was es zeigt.
//
// GEPRUEFT WIRD:
//   1. `checkdispatch` gegen einen Vorposten schreibt einen Anflug-Vermerk mit Angreifer-Tag,
//      Ankunftszeit und Schiffszahl.
//   2. NUR DER BESITZER sieht ihn. Verteidigung, Garnisonszahl und Steckplaetze stehen jedem
//      offen - ein Anflug verriete dagegen den Plan eines Dritten.
//   3. `resolve` raeumt den EIGENEN Vermerk weg.
//   4. DER KERN: Zwei Verbaende koennen denselben Vorposten anfliegen. Loest der erste auf, MUSS
//      der Vermerk des zweiten stehen bleiben - sonst saehe der Besitzer den zweiten nicht mehr
//      kommen. Ein einzelnes Feld statt einer Liste faellt genau hier.
//   5. VERFALL: Ein Verband, dessen resolve nie kommt, warnt nicht ewig. Eintraege, deren Ankunft
//      laenger als die Gnadenfrist zurueckliegt, gelten beim LESEN als erledigt.
//
// GEGENPROBEN (je mit gemessener "was fallen MUSS"-Liste, Regel 1/71 - die Listen unten sind
// gemessen, nicht geraten):
//   * offen   : der Besitzer-Vorbehalt in vorpostenFuerClient entfaellt (jeder sieht den Anflug).
//   * bleibt  : das Aufraeumen bei resolve entfaellt.
//   * verfall : der Verfallsfilter entfaellt.
//
// Port 3252 (belegt bis 3251, gemessen mit grep -hoE "3[12][0-9][0-9]" tests/*.js | sort -un).
// Startet eine KOPIE von server.js mit umgelegtem VORPOSTEN_AKTIV - welche Stellung gerade
// committet ist, darf das Ergebnis nicht verschieben.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3252;
const QUELLE = path.join(WURZEL, 'server_vorpostenanflug_tmp.js');
const SAB = process.env.KEPLER_VA_SABOTAGE || '';
/* GEMESSEN, nicht geraten. Bei `bleibt` faellt NUR 3a, nicht auch 4a - und das ist kein Mangel,
   sondern die Eigenschaft des Paars: 4a prueft, dass der FREMDE Vermerk stehen bleibt, und das tut
   er auch, wenn gar nichts geraeumt wird. 4a allein beweist also nichts; erst zusammen mit 3a
   ("der eigene ist weg") pinnt es das Verhalten fest. Erwartet man hier 4a mit, meldet der Lauf zu
   Recht einen Werkzeugfehler - so gemessen am 03.09.2026. */
const MUSS_FALLEN = { offen: ['2b'], bleibt: ['3a'], verfall: ['5a'] };

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
const SYS = 'vpsys-a';

const FLOTTE_A = { cruisers: 300, destroyers: 200, jaeger: 400 };
const FLOTTE_B = { cruisers: 100, destroyers: 60, jaeger: 120 };

function spielstand(id, name, flotte, tag) {
  return {
    resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {},
    fleet: Object.assign({ missions: [] }, flotte),
    player: { id, name, allianceTag: tag || null }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  };
}
const rolle = (uid, role) => JSON.stringify({ role, joinedAt: Date.now(), userId: uid });

// Dora ist die BESITZERIN und bewusst NICHT in der Allianz - so misst 2a einen echten Fremdbesitz,
// und Carl ist der Dritte, der nichts sehen darf.
function vorposten() {
  return {
    id: 'vp-a1', sys: SYS, besitzer: DORA, besitzerName: 'dora',
    seit: Date.now() - 30 * 3600 * 1000,   // Bauschutz laengst abgelaufen
    stufe: 3,
    kern: { lp: 400000, lpMax: 400000 },
    garnison: { jaeger: 100 }, schlaege: {}, beitraege: {},
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
      [ANNA]: { [SAVE_KEY]: JSON.stringify(spielstand(ANNA, 'anna', FLOTTE_A, TAG)) },
      [BEN]:  { [SAVE_KEY]: JSON.stringify(spielstand(BEN, 'ben', FLOTTE_B, TAG)) },
      [CARL]: { [SAVE_KEY]: JSON.stringify(spielstand(CARL, 'carl', FLOTTE_B, null)) },
      [DORA]: { [SAVE_KEY]: JSON.stringify(spielstand(DORA, 'dora', FLOTTE_B, null)) }
    },
    shared: {
      ['alliance:' + TAG + ':role:' + ANNA]: rolle(ANNA, 'admin'),
      ['alliance:' + TAG + ':role:' + BEN]: rolle(BEN, 'member'),
      ['alliance:' + TAG + ':base']: JSON.stringify({ foundedAt: Date.now(), sector: 'vega', level: 3 }),
      ['vorposten:' + SYS]: JSON.stringify(vorposten())
    },
    resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {} }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-vorpostenanflug-' + process.pid + '.json');
let srv = null, s = null, tokA = null, tokC = null, tokD = null;
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
const liesDoc = d => { const raw = d.shared['vorposten:' + SYS]; return typeof raw === 'string' ? JSON.parse(raw) : null; };
const schreibDoc = (d, doc) => { d.shared['vorposten:' + SYS] = JSON.stringify(doc); };
// Eine DB-Aenderung bei laufendem Server ist beim naechsten Stopp weg (der Flush ueberschreibt sie):
// stoppen -> aendern -> starten. Steht so in CLAUDE.md, hier eingehalten.
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  try { await fn(d); }
  catch (e) { check('aufbau: die DB-Aenderung liess sich ausfuehren', false, { fehler: String(e).slice(0, 200) }); }
  schreibDb(d);
  s = await starteServer();
  tokA = await s.anmelden('anna'); tokC = await s.anmelden('carl'); tokD = await s.anmelden('dora');
}

(async () => {
  let roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  const muster = /const VORPOSTEN_AKTIV = (true|false);/;
  check('0-kopie: der Schalter ist auffindbar', muster.test(roh), { gefunden: (roh.match(muster) || [])[1] });
  roh = roh.replace(muster, 'const VORPOSTEN_AKTIV = true;');

  const sab = {
    // Jeder sieht den Anflug, nicht nur der Besitzer.
    offen: ['    anflug: eigener ? vorpostenAnflugAktiv(doc, jetzt).map(a => ({',
            '    anflug: (true) ? vorpostenAnflugAktiv(doc, jetzt).map(a => ({'],
    // Das Aufraeumen bei der Aufloesung entfaellt.
    bleibt: ['    if (vorpostenAnflugEntfernen(vp, doc.id)) vorpostenSchreib(vp);',
             '    if (false && vorpostenAnflugEntfernen(vp, doc.id)) vorpostenSchreib(vp);'],
    // Der Verfallsfilter entfaellt - abgelaufene Vermerke warnen weiter.
    verfall: ['  return liste.filter(a => a && typeof a.ankunftAt === \'number\' && (jetzt - a.ankunftAt) < VORPOSTEN_ANFLUG_GNADE);',
              '  return liste.filter(a => a && typeof a.ankunftAt === \'number\');']
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
  tokA = await s.anmelden('anna'); tokC = await s.anmelden('carl'); tokD = await s.anmelden('dora');
  check('0: drei Konten angemeldet', !!tokA && !!tokC && !!tokD);
  if (!tokA || !tokC || !tokD) { console.log(s.protokoll().slice(-1500)); process.exit(1); }
  const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
  const post = (pfad, tok, body) => s.j(pfad, { method: 'POST', headers: kopf(tok), body: JSON.stringify(body || {}) });
  const get = (pfad, tok) => s.j(pfad, { headers: kopf(tok) });
  const meinVorposten = async tok => {
    const r = await get('/vorposten', tok);
    const liste = (r.body && r.body.liste) || [];
    return liste.find(v => v.sys === SYS) || null;
  };

  // ---- 1) Der Versand schreibt den Vermerk ------------------------------------------------------
  let docId = null;
  {
    const r = await post('/musterattack/create', tokA, { tag: TAG, zielArt: 'vorposten', vorpostenSystem: SYS, vorpostenId: 'vp-a1', gatherSeconds: 2 });
    check('1a-vorab: der Verband gegen den fremden Vorposten laesst sich ausrufen', r.status === 200 && r.body && r.body.doc,
      { status: r.status, error: r.body && r.body.error });
    docId = r.body && r.body.doc && r.body.doc.id;
    await post('/musterattack/join', tokA, { tag: TAG, musterAttackId: docId, composition: FLOTTE_A, originPlanet: 'home' });
    await warte(2600);
    const cd = await post('/musterattack/checkdispatch', tokA, { tag: TAG });
    check('1a2-vorab: der Verband fliegt los', cd.status === 200 && cd.body && cd.body.doc && cd.body.doc.phase === 'enroute',
      { status: cd.status, phase: cd.body && cd.body.doc && cd.body.doc.phase });

    const doc = liesDoc(liesDb());
    const eintraege = (doc && doc.anflug) || [];
    const a0 = eintraege[0] || {};
    check('1a: der Versand schreibt einen Anflug-Vermerk an den Vorposten',
      eintraege.length === 1 && a0.tag === TAG && a0.musterId === docId && typeof a0.ankunftAt === 'number' && a0.ankunftAt > Date.now(),
      { anzahl: eintraege.length, tag: a0.tag, inZukunft: a0.ankunftAt > Date.now() });
    check('1b: er nennt die Schiffszahl - ohne sie waere die Warnung ein "irgendwer kommt"',
      typeof a0.schiffe === 'number' && a0.schiffe > 0, { schiffe: a0.schiffe });
  }

  // ---- 2) Wer ihn sehen darf --------------------------------------------------------------------
  {
    const beiDora = await meinVorposten(tokD);
    check('2a: die BESITZERIN sieht den Anflug in /api/vorposten',
      !!beiDora && Array.isArray(beiDora.anflug) && beiDora.anflug.length === 1 && beiDora.anflug[0].tag === TAG,
      { eigener: beiDora && beiDora.eigener, anflug: beiDora && beiDora.anflug });
    const beiCarl = await meinVorposten(tokC);
    check('2b: ein DRITTER sieht ihn NICHT - der Anflug verriete den Plan eines anderen',
      !!beiCarl && Array.isArray(beiCarl.anflug) && beiCarl.anflug.length === 0,
      { eigener: beiCarl && beiCarl.eigener, anflug: beiCarl && beiCarl.anflug });
    check('2c: dem Dritten bleiben Verteidigung und Garnisonszahl trotzdem offen (nur der Anflug ist eng)',
      !!beiCarl && typeof beiCarl.verteidigung === 'number' && typeof beiCarl.garnisonAnzahl === 'number',
      { verteidigung: beiCarl && beiCarl.verteidigung, garnison: beiCarl && beiCarl.garnisonAnzahl });
  }

  // ---- 3) und 4) Aufloesen raeumt den EIGENEN Vermerk, nicht den fremden -------------------------
  // Der zweite Eintrag steht fuer einen Verband einer ANDEREN Allianz. Er wird direkt gesetzt: Was
  // hier gemessen wird, ist das Aufraeumen, nicht das Schreiben (das misst schon 1a).
  const FREMD_ID = 'muster-fremd-1';
  {
    await aendereDb(d => {
      const doc = liesDoc(d);
      doc.anflug = (doc.anflug || []).concat([{ musterId: FREMD_ID, tag: 'XXX', ankunftAt: Date.now() + 3600 * 1000, schiffe: 42, seit: Date.now() }]);
      schreibDoc(d, doc);
      // Die Ankunft vorziehen, sonst weist `resolve` den noch fliegenden Verband ab und der
      // Aufraeum-Zweig wird gar nicht erst betreten (gemessen: damage null).
      const md = JSON.parse(d.shared['alliance:' + TAG + ':musterattack'] || 'null');
      if (md) { md.dispatch.arrivalAt = Date.now() - 1000; d.shared['alliance:' + TAG + ':musterattack'] = JSON.stringify(md); }
    });
    const vor = (liesDoc(liesDb()) || {}).anflug || [];
    check('3a-vorab: vor dem Aufloesen stehen ZWEI Vermerke', vor.length === 2, { anzahl: vor.length });

    const r = await post('/musterattack/resolve', tokA, { tag: TAG });
    check('3a2-vorab: der Verband loest auf und richtet Schaden an',
      r.status === 200 && r.body && r.body.doc && r.body.doc.result && r.body.doc.result.damage > 0,
      { status: r.status, damage: r.body && r.body.doc && r.body.doc.result && r.body.doc.result.damage });

    const nach = (liesDoc(liesDb()) || {}).anflug || [];
    check('3a: das Aufloesen raeumt den EIGENEN Vermerk weg',
      !nach.some(a => a.musterId === docId), { verbleibend: nach.map(a => a.musterId) });
    check('4a: der Vermerk des ZWEITEN Verbands bleibt stehen - sonst saehe der Besitzer ihn nicht mehr kommen',
      nach.some(a => a.musterId === FREMD_ID), { verbleibend: nach.map(a => a.musterId) });
  }

  // ---- 5) Verfall -------------------------------------------------------------------------------
  {
    await aendereDb(d => {
      const doc = liesDoc(d);
      // Ankunft liegt drei Stunden zurueck - die Gnadenfrist sind zwei.
      doc.anflug = [{ musterId: 'muster-alt', tag: 'ALT', ankunftAt: Date.now() - 3 * 3600 * 1000, schiffe: 7, seit: Date.now() - 4 * 3600 * 1000 }];
      schreibDoc(d, doc);
    });
    const beiDora = await meinVorposten(tokD);
    check('5a: ein Verband, dessen Ankunft laengst vorbei ist, warnt nicht weiter',
      !!beiDora && Array.isArray(beiDora.anflug) && beiDora.anflug.length === 0,
      { anflug: beiDora && beiDora.anflug });
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
