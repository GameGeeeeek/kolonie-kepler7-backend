// Die Marktgebuehr (Etappe V3, 03.09.2026) - gegen einen ECHT gestarteten Server.
//
// Der zweite von zwei Kanaelen, die der Quelltext seit dem 02.09.2026 schuldet (der Kommentar ueber
// VORPOSTEN_ZWEIGE nennt „Werftrabatt" und „Marktgebuehr"). Der Handelsknoten war bis hierher
// Produktion mal 1,8 und die duennste Huelle - er handelte nicht.
//
// GEMESSEN WIRD UEBER DIE ECHTEN ENDPUNKTE: einstellen, kaufen, Gutschrift lesen. Ein Test, der die
// Gebuehr selbst nachrechnet, prueft seine eigene Formel; hier zahlt der Kaeufer wirklich und der
// Verkaeufer bekommt wirklich seine Gutschrift in die Warteschlange.
//
// DIE WICHTIGSTE PRUEFUNG ist 2c: Die Gebuehr haengt am VERKAEUFER, nicht am Kaeufer. Die
// naheliegende Verwechslung (req.userId statt listing.sellerId) haette dem Kaeufer den Rabatt eines
// fremden Handelsknotens gegeben - und waere im Normalbetrieb nie aufgefallen.
//
// Gegenprobe: siehe Fuss der Datei.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3256;
const QUELLE = path.join(WURZEL, 'server_vpmarkt_tmp.js');
const SAB = process.env.KEPLER_VPMARKT_SABOTAGE || '';
/* Was bei welcher Sabotage fallen MUSS - GEMESSEN, nicht geschaetzt. Die Listen stammen aus dem
   Lauf vom 03.09.2026 und fuehren die Folgen mit, nicht nur den Kern der Sabotage. */
const MUSS_FALLEN = {
  /* GEMESSEN am 03.09.2026, nicht geschaetzt - alle vier Listen waren im ersten Entwurf falsch:
     `verkaeufer` reisst 2a mit (Annas Verkauf zahlt dann die volle Gebuehr), `gebuehr` laesst 2b
     stehen (die volle Gebuehr ist dort ja richtig) und reisst statt dessen 2c mit. Beide Sabotagen
     fallen damit auf dieselben zwei Pruefungen - 2c ist die, die BEIDE faengt. */
  verkaeufer: ['2a', '2c'], gebuehr: ['2a', '2c'], slots: ['1c', '3a'], schalter: ['4a', '4b'] };

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
const ANNA = crypto.randomUUID();   // Verkaeuferin MIT Handelsknoten
const BEN = crypto.randomUUID();    // Kaeufer OHNE Vorposten
const CARL = crypto.randomUUID();   // Verkaeufer OHNE Vorposten (die Vergleichsmessung)
const dbPfad = path.join(os.tmpdir(), 'kepler-vpmarkt-' + process.pid + '.json');
const MODUL = 'kernpanzer:episch';
let srv = null;

const save = (id, name) => ({ resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
  buildings: {}, research: {}, colonies: {}, fleet: { missions: [] }, modules: { [MODUL]: 8 }, shipModules: {},
  player: { id, name }, credits: 900000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now() });
function grunddb() {
  return {
    users: {
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: Date.now() },
      carl: { userId: CARL, username: 'carl', passwordHash: hash, createdAt: Date.now() }
    },
    private: {
      [ANNA]: { 'kepler7-save-v3': JSON.stringify(save(ANNA, 'anna')) },
      [BEN]:  { 'kepler7-save-v3': JSON.stringify(save(BEN, 'ben')) },
      [CARL]: { 'kepler7-save-v3': JSON.stringify(save(CARL, 'carl')) }
    },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {}, wrackKonvois: [], a2Verlauf: [] }
  };
}
const vpDoc = (sys, besitzer, name, stufe, zweig) => ({ id: 'vp_' + crypto.randomUUID(), sys, besitzer, besitzerName: name,
  seit: Date.now() - 13 * 3600 * 1000, stufe, zweig, kern: { lp: 20000, lpMax: 20000 },
  garnison: {}, schlaege: {}, beitraege: {}, ausbauSeit: Date.now() - 13 * 3600 * 1000, kampfverlauf: [] });

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

(async () => {
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  /* ANKER aus dem QUELLTEXT, nicht aus der Antwort, die geprueft werden soll. */
  const basisFee = Number((roh.match(/const MODULE_MARKET_FEE_PCT = ([\d.]+);/) || [])[1]);
  const basisSlots = Number((roh.match(/const MODULE_MARKET_MAX_LISTINGS_PER_USER = (\d+);/) || [])[1]);
  const marktDeckel = Number((roh.match(/const VP_MARKT_DECKEL = ([\d.]+);/) || [])[1]);
  const schritt = Number((roh.match(/const VP_MARKT_SLOT_SCHRITT = ([\d.]+);/) || [])[1]);
  const leiter = [...roh.matchAll(/\{ stufe: (\d), name: '[^']*',[^}]*markt: ([\d.]+),/g)].map(m => Number(m[2]));
  const multHandel = Number((roh.match(/key: 'handel',[\s\S]{0,400}?markt: ([\d.]+) \}/) || [])[1]);
  const erwarteterAnteil = Math.round(leiter[7] * multHandel * 1000) / 1000;
  check('0a: Grundgebuehr, Grundplaetze, Deckel, Schritt und Leiter sind im Quelltext auffindbar',
    basisFee > 0 && basisSlots > 0 && marktDeckel > 0 && schritt > 0 && leiter.length === 8 && multHandel > 0,
    { basisFee, basisSlots, marktDeckel, schritt, stufen: leiter.length, multHandel, erwarteterAnteil });

  let basis = roh.replace(/const VORPOSTEN_AKTIV = (true|false);/, 'const VORPOSTEN_AKTIV = true;');
  if (SAB === 'verkaeufer') basis = basis.replace('const marktVp = vorpostenMarktBonus(listing.sellerId);', 'const marktVp = vorpostenMarktBonus(req.userId);');
  if (SAB === 'gebuehr') basis = basis.replace(/const fee = Math\.round\(listing\.price \* MODULE_MARKET_FEE_PCT \* \(1 - marktVp\.anteil\)\);/, 'const fee = Math.round(listing.price * MODULE_MARKET_FEE_PCT);');
  if (SAB === 'slots') basis = basis.replace(/extraAngebote: Math\.min\(VP_MARKT_SLOTS_MAX, Math\.floor\(anteil \/ VP_MARKT_SLOT_SCHRITT\)\)/, 'extraAngebote: 0');
  // Nicht den Schalter umlegen (das tut der zweite Lauf selbst), sondern die Gatterung brechen.
  if (SAB === 'schalter') basis = basis.replace('markt: VP_MARKT_AKTIV ? ', 'markt: true ? ');
  const an = basis.replace(/const VP_MARKT_AKTIV = (true|false);/, 'const VP_MARKT_AKTIV = true;');
  check('0b: der Markt-Schalter liess sich in der Kopie umlegen', /const VP_MARKT_AKTIV = true;/.test(an),
    { gefunden: /const VP_MARKT_AKTIV = (true|false);/.test(roh) });

  // ---- 1) Mit umgelegtem Schalter: der Katalog rechnet fertig ----------------------------------
  fs.writeFileSync(QUELLE, an);
  const db = grunddb();
  db.shared['vorposten:markt-acht'] = JSON.stringify(vpDoc('markt-acht', ANNA, 'anna', 8, 'handel'));
  fs.writeFileSync(dbPfad, JSON.stringify(db, null, 1));
  let s = await starteServer();
  const tokA = await s.anmelden('anna'), tokB = await s.anmelden('ben'), tokC = await s.anmelden('carl');

  const katA = await s.hole('/modulemarket', tokA);
  const katC = await s.hole('/modulemarket', tokC);
  check('1a: der Handelsknoten senkt die Gebuehr, und der Katalog nennt die WIRKLICH geltende',
    katA.status === 200 && Math.abs(katA.body.limits.feePct - basisFee * (1 - erwarteterAnteil)) < 1e-6
    && katA.body.limits.basisFeePct === basisFee,
    { gilt: katA.body.limits.feePct, grund: katA.body.limits.basisFeePct, anteil: katA.body.limits.vorpostenRabatt, erwartet: erwarteterAnteil });
  check('1b: wer keinen Vorposten hat, zahlt unveraendert die Grundgebuehr',
    katC.status === 200 && katC.body.limits.feePct === basisFee && katC.body.limits.vorpostenRabatt === 0,
    { gilt: katC.body.limits.feePct, grund: basisFee, anteil: katC.body.limits.vorpostenRabatt });
  check('1c: und er haelt mehr Ware - die Angebotsplaetze sind aus demselben Anteil abgeleitet', (() => {
    const erwartet = Math.min(3, Math.floor(erwarteterAnteil / schritt));
    return katA.body.limits.maxPerUser === basisSlots + erwartet && erwartet > 0
      && katC.body.limits.maxPerUser === basisSlots;
  })(), { mitKnoten: katA.body.limits.maxPerUser, ohne: katC.body.limits.maxPerUser, grund: basisSlots,
          erwarteteExtra: Math.min(3, Math.floor(erwarteterAnteil / schritt)) });

  // ---- 2) Der echte Weg: einstellen, kaufen, Gutschrift lesen ----------------------------------
  const PREIS = 100000;
  const einA = await s.sende('/modulemarket/list', tokA, { isShip: false, instKey: MODUL, price: PREIS });
  const einC = await s.sende('/modulemarket/list', tokC, { isShip: false, instKey: MODUL, price: PREIS });
  check('2-vorab: beide Angebote stehen', einA.status === 200 && einC.status === 200,
    { anna: einA.status, carl: einC.status });
  const kaufA = await s.sende('/modulemarket/buy', tokB, { id: einA.body.listing.id });
  const kaufC = await s.sende('/modulemarket/buy', tokB, { id: einC.body.listing.id });
  check('2a: der Kauf beim Handelsknoten zieht die GESENKTE Gebuehr ab',
    kaufA.status === 200 && kaufA.body.fee === Math.round(PREIS * basisFee * (1 - erwarteterAnteil)),
    { gezahlt: kaufA.body.fee, erwartet: Math.round(PREIS * basisFee * (1 - erwarteterAnteil)), ohneRabatt: Math.round(PREIS * basisFee) });
  check('2b: der Kauf beim Vorpostenlosen zieht die volle Gebuehr ab',
    kaufC.status === 200 && kaufC.body.fee === Math.round(PREIS * basisFee),
    { gezahlt: kaufC.body.fee, erwartet: Math.round(PREIS * basisFee) });
  /* 2c ist der Kern: Beide Kaeufe macht DERSELBE Kaeufer (Ben, ohne Vorposten). Wuerde die Gebuehr
     am Kaeufer haengen, waeren beide gleich - und zwar beide voll. Sie unterscheiden sich nur,
     wenn der VERKAEUFER zaehlt. */
  check('2c: die Gebuehr haengt am VERKAEUFER - derselbe Kaeufer, zwei verschiedene Gebuehren',
    kaufA.body.fee < kaufC.body.fee,
    { beimKnoten: kaufA.body.fee, beimVorpostenlosen: kaufC.body.fee, kaeufer: 'ben (ohne Vorposten)' });

  // ---- 3) Die Angebotsgrenze ist eine REGEL, keine Bitte ---------------------------------------
  /* Carl hat die Grundzahl an Plaetzen. Er fuellt sie und stoesst dann an - Anna kaeme mit
     demselben Bestand noch durch. Gemessen wird der Endpunkt, nicht die Zahl im Katalog. */
  /* BEIDE fuellen erst die Grundzahl. Der erste Entwurf liess nur Carl fuellen und pruefte dann,
     ob Anna noch einstellen darf - sie hatte nach dem Verkauf aber null offene Angebote, also ging
     ihr Angebot mit UND ohne Bonus durch. Die Gegenprobe `slots` hat das aufgedeckt: Sie riss 3a
     nicht mit, obwohl sie den Bonus auf null setzte. */
  for (let i = 0; i < basisSlots; i++) {
    await s.sende('/modulemarket/list', tokC, { isShip: false, instKey: MODUL, price: PREIS + i });
    await s.sende('/modulemarket/list', tokA, { isShip: false, instKey: MODUL, price: PREIS + i });
  }
  const zuViel = await s.sende('/modulemarket/list', tokC, { isShip: false, instKey: MODUL, price: PREIS + 99 });
  const nochOk = await s.sende('/modulemarket/list', tokA, { isShip: false, instKey: MODUL, price: PREIS + 99 });
  check('3a: bei GLEICHEM Bestand ist der Vorpostenlose am Ende, der Handelsknoten nicht',
    zuViel.status === 400 && /Maximal/.test(String(zuViel.body.error || '')) && nochOk.status === 200,
    { ohne: zuViel.status, fehler: zuViel.body.error, mit: nochOk.status, mitFehler: nochOk.body && nochOk.body.error });

  // ---- 4) Mit ausgeschaltetem Schalter ----------------------------------------------------------
  /* Der Schalter wird AKTIV auf false gesetzt, statt sich auf den ausgelieferten Stand zu
     verlassen: Ein Test, der die Auslieferung als Voraussetzung nimmt, faellt bei genau der
     Aenderung, die er begleiten soll. */
  await stoppeServer();
  fs.writeFileSync(QUELLE, basis.replace(/const VP_MARKT_AKTIV = (true|false);/, 'const VP_MARKT_AKTIV = false;'));
  const db2 = grunddb();
  db2.shared['vorposten:markt-acht'] = JSON.stringify(vpDoc('markt-acht', ANNA, 'anna', 8, 'handel'));
  fs.writeFileSync(dbPfad, JSON.stringify(db2, null, 1));
  s = await starteServer();
  const tokA2 = await s.anmelden('anna'), tokB2 = await s.anmelden('ben');
  const katAus = await s.hole('/modulemarket', tokA2);
  check('4a: ausgeschaltet zahlt auch der Handelsknoten die volle Gebuehr und hat die Grundplaetze',
    katAus.body.limits.feePct === basisFee && katAus.body.limits.maxPerUser === basisSlots
    && katAus.body.limits.vorpostenRabatt === 0,
    { fee: katAus.body.limits.feePct, plaetze: katAus.body.limits.maxPerUser, anteil: katAus.body.limits.vorpostenRabatt });
  const einAus = await s.sende('/modulemarket/list', tokA2, { isShip: false, instKey: MODUL, price: PREIS });
  const kaufAus = await s.sende('/modulemarket/buy', tokB2, { id: einAus.body.listing.id });
  check('4b: und der echte Verkauf zieht ebenfalls die volle Gebuehr ab',
    kaufAus.status === 200 && kaufAus.body.fee === Math.round(PREIS * basisFee),
    { gezahlt: kaufAus.body.fee, erwartet: Math.round(PREIS * basisFee) });
  await stoppeServer();

  // ---- Auswertung: Gruen-Lauf ODER Gegenprobe --------------------------------------------------
  if (SAB) {
    const soll = MUSS_FALLEN[SAB] || [];
    const gefallen = [...new Set(Object.keys(ergebnis).filter(n => ergebnis[n] === false).map(n => String(n).split(':')[0]))].sort();
    const fehlt = soll.filter(k => gefallen.indexOf(k) < 0);
    const zuvielG = gefallen.filter(k => soll.indexOf(k) < 0);
    console.log('\nGegenprobe „' + SAB + '": gefallen ' + JSON.stringify(gefallen) + ', erwartet ' + JSON.stringify(soll));
    if (fehlt.length || zuvielG.length) {
      console.log('FAIL - Gegenprobe: nicht gefallen ' + JSON.stringify(fehlt) + ', unerwartet gefallen ' + JSON.stringify(zuvielG));
      process.exit(1);
    }
    console.log('PASS - Gegenprobe: genau die erwarteten Pruefungen sind gefallen.');
    process.exit(0);
  }
  console.log(fail ? '\nFAIL - mindestens eine Pruefung ist gefallen.' : '\nPASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL - Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
