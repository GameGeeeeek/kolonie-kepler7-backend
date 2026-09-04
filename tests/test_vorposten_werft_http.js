// Der Werftrabatt (Etappe V2, 03.09.2026) - gegen einen ECHT gestarteten Server.
//
// Auftrag Sascha: alle Punkte der Vorposten-Auswahl umsetzen. Dieser stand als Schuld im eigenen
// Quelltext: Der Kommentar ueber VORPOSTEN_ZWEIGE nennt seit dem 02.09.2026 „Werftrabatt" und
// „Marktgebuehr" als Kanaele, die spaeter ZUSAMMEN mit ihrer Wirkung kommen. Bis dahin war die
// „Werft" ein Flugzeit-Multiplikator mit duennerem Kern - sie baute nichts.
//
// GEPRUEFT WIRD DIE WIRKUNG DES SCHALTERS, NICHT SEINE STELLUNG (Lehre aus
// test_hort_meldung_http.js): Ein Test, der den ausgelieferten Zustand als Voraussetzung nimmt,
// faellt bei genau der Aenderung, die er begleiten soll. Deshalb laeuft er ZWEIMAL - einmal mit
// umgelegtem, einmal mit ausgeschaltetem Schalter, beide Male an einer Kopie.
//
// Gegenprobe: siehe Fuss der Datei.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3255;
const QUELLE = path.join(WURZEL, 'server_vpwerft_tmp.js');
const SAB = process.env.KEPLER_VPWERFT_SABOTAGE || '';
/* Was bei welcher Sabotage fallen MUSS - GEMESSEN, nicht geschaetzt. Bei `leiter` stand hier
   zuerst nur ['1c']; der Lauf zeigte ['1b','1c']. Der Grund ist kein Zufall, sondern die Bauart
   des Tests: Die Erwartung in 1b kommt aus dem UNVERSEHRTEN Quelltext (leiter[7][1] = 0,16),
   waehrend der laufende Server die flachgedrueckte Leiter fuehrt - genau so soll ein unabhaengiger
   Anker wirken. Die Folge gehoert deshalb in die Liste, nicht in einen Kommentar. */
const MUSS_FALLEN = { zweigmult: ['1b'], leiter: ['1b', '1c'], schalter: ['2a'] };

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
const ANNA = crypto.randomUUID();
const dbPfad = path.join(os.tmpdir(), 'kepler-vpwerft-' + process.pid + '.json');
let srv = null;

function grunddb() {
  const save = { resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {}, fleet: { missions: [] },
    player: { id: ANNA, name: 'anna' }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now() };
  return {
    users: { anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() } },
    private: { [ANNA]: { 'kepler7-save-v3': JSON.stringify(save) } },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {}, wrackKonvois: [], a2Verlauf: [] }
  };
}
const vpDoc = (sys, stufe, zweig) => ({ id: 'vp_' + crypto.randomUUID(), sys, besitzer: ANNA, besitzerName: 'anna',
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
  const login = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'anna', password: 'test1234' }) });
  return { j, token: login.body && login.body.token };
}
async function stoppeServer() { if (!srv) return; srv.kill('SIGTERM'); await warte(700); srv = null; }

(async () => {
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  /* ANKER unabhaengig von der API-Antwort: Leiter und Multiplikator kommen aus dem QUELLTEXT.
     Eine Erwartung, die aus derselben Antwort stammt, die sie pruefen soll, belegt nichts. */
  const leiter = [...roh.matchAll(/\{ stufe: (\d), name: '[^']*',[^}]*werft: ([\d.]+),/g)].map(m => [Number(m[1]), Number(m[2])]);
  /* BEIDE SEITEN HABEN AM 04.09.2026 DIESELBE FRAGILITAET BEHOBEN, verschieden formuliert.
     Uebernommen ist die allgemeinere Fassung: ein Helfer multVon(zweig, kanal), der den Wert
     INNERHALB des mult-Objekts greift, ohne zu verlangen, dass er dort der letzte ist. Der
     urspruengliche Anker endete auf „werft: 2.20 \}" und fiel, sobald ein Kanal dahinterkam -
     erst `markt`, dann `lager`. Ein Anker, der die Reihenfolge festhaelt, ist eine
     Momentaufnahme, keine Regel; mit dem Helfer gilt das fuer JEDEN Kanal, nicht nur fuer werft. */
  const multVon = (zweig, kanal) => Number((roh.match(new RegExp("key: '" + zweig + "',[\\s\\S]{0,600}?mult: \\{[^}]*" + kanal + ": ([\\d.]+)")) || [])[1]);
  const multWerft = multVon('werft', 'werft');
  const multFestung = multVon('festung', 'werft');
  const deckel = Number((roh.match(/const VP_WERFT_DECKEL = ([\d.]+);/) || [])[1]);
  check('0a: Leiter, Multiplikatoren und Deckel sind im Quelltext auffindbar',
    leiter.length === 8 && multWerft > 0 && multFestung > 0 && deckel > 0,
    { stufen: leiter.length, werft: multWerft, festung: multFestung, deckel });

  let basis = roh.replace(/const VORPOSTEN_AKTIV = (true|false);/, 'const VORPOSTEN_AKTIV = true;');
  // Auch die SABOTAGE darf nicht daran haengen, dass der Wert der letzte im Objekt ist - sonst
  // greift sie eines Tages ins Leere und die Gegenprobe belegt nichts mehr (03.09.2026 passiert).
  if (SAB === 'zweigmult') basis = basis.replace(/(key: 'werft',[\s\S]{0,600}?mult: \{[^}]*)werft: [\d.]+/, '$1werft: 0.50');
  if (SAB === 'leiter') basis = basis.replace(/werft: [\d.]+,/g, 'werft: 0.02,');
  const an = basis.replace(/const VP_WERFT_AKTIV = (true|false);/, 'const VP_WERFT_AKTIV = true;');
  check('0b: der Werft-Schalter liess sich in der Kopie umlegen', /const VP_WERFT_AKTIV = true;/.test(an),
    { gefunden: /const VP_WERFT_AKTIV = (true|false);/.test(roh) });

  // ---- 1) Mit umgelegtem Schalter ---------------------------------------------------------------
  fs.writeFileSync(QUELLE, an);
  const db = grunddb();
  db.shared['vorposten:w-acht']  = JSON.stringify(vpDoc('w-acht', 8, 'werft'));
  db.shared['vorposten:f-acht']  = JSON.stringify(vpDoc('f-acht', 8, 'festung'));
  db.shared['vorposten:w-fuenf'] = JSON.stringify(vpDoc('w-fuenf', 5, 'werft'));
  fs.writeFileSync(dbPfad, JSON.stringify(db, null, 1));
  let s = await starteServer();
  const kat = await s.j('/vorposten', { headers: { Authorization: 'Bearer ' + s.token } });
  const nutzenVon = (sys) => {
    const v = (kat.body.liste || []).find(x => x.sys === sys);
    return v && v.nutzen ? v.nutzen : null;
  };
  check('1a: der Katalog nennt Deckel und Schalter - der Client soll beide nicht erraten muessen',
    kat.status === 200 && kat.body.werftDeckel === deckel && kat.body.werftAktiv === true,
    { deckel: kat.body.werftDeckel, aktiv: kat.body.werftAktiv, erwartet: deckel });
  check('1b: die Werft loest ihren Namen ein - sie spart DEUTLICH mehr Bauzeit als ein Festungsring derselben Stufe', (() => {
    const w = nutzenVon('w-acht'), f = nutzenVon('f-acht');
    if (!w || !f) return false;
    const basisAcht = leiter[7][1];
    return Math.abs(w.werft - basisAcht * multWerft) < 0.002
      && Math.abs(f.werft - basisAcht * multFestung) < 0.002
      && w.werft > f.werft * 2;
  })(), { werft: (nutzenVon('w-acht')||{}).werft, festung: (nutzenVon('f-acht')||{}).werft,
          erwartetWerft: leiter[7][1] * multWerft, erwartetFestung: leiter[7][1] * multFestung });
  check('1c: der Rabatt waechst mit der Stufe - dieselbe Ausrichtung, hoehere Stufe, mehr Ersparnis', (() => {
    const acht = nutzenVon('w-acht'), fuenf = nutzenVon('w-fuenf');
    return !!acht && !!fuenf && acht.werft > fuenf.werft;
  })(), { stufe8: (nutzenVon('w-acht')||{}).werft, stufe5: (nutzenVon('w-fuenf')||{}).werft });
  check('1d: der Deckel reist an JEDEM Vorposten mit - er gilt der Summe, nicht dem einzelnen',
    ['w-acht','f-acht','w-fuenf'].every(sy => (nutzenVon(sy)||{}).werftDeckel === deckel),
    { werte: ['w-acht','f-acht','w-fuenf'].map(sy => (nutzenVon(sy)||{}).werftDeckel) });
  check('1e: kein einzelner Vorposten erreicht den Deckel heute - er ist erst fuer die Summe da',
    ['w-acht','f-acht','w-fuenf'].every(sy => (nutzenVon(sy)||{}).werft < deckel),
    { werte: ['w-acht','f-acht','w-fuenf'].map(sy => (nutzenVon(sy)||{}).werft), deckel });

  // ---- 2) Mit ausgeschaltetem Schalter ----------------------------------------------------------
  /* Der Schalter wird AKTIV auf false gesetzt, statt sich auf den ausgelieferten Stand zu
     verlassen: Der wird umgelegt, sobald das Frontend den Kanal liest, und ein Test, der die
     Auslieferung als Voraussetzung nimmt, faellt bei genau der Aenderung, die er begleiten soll. */
  await stoppeServer();
  let aus = basis.replace(/const VP_WERFT_AKTIV = (true|false);/, 'const VP_WERFT_AKTIV = false;');
  if (SAB === 'schalter') aus = aus.replace(/werft: VP_WERFT_AKTIV \? /, 'werft: true ? ');
  fs.writeFileSync(QUELLE, aus);
  s = await starteServer();
  const katAus = await s.j('/vorposten', { headers: { Authorization: 'Bearer ' + s.token } });
  const ausWerft = ((katAus.body.liste || []).find(x => x.sys === 'w-acht') || {}).nutzen || {};
  check('2a: ausgeschaltet meldet derselbe Vorposten KEINEN Rabatt - ein Nutzen, der nirgends wirkt, waere eine Luege',
    katAus.status === 200 && ausWerft.werft === 0 && katAus.body.werftAktiv === false,
    { werft: ausWerft.werft, aktiv: katAus.body.werftAktiv });
  check('2b: der Deckel reist trotzdem mit - der Client baut seine Anzeige nicht auf einer fehlenden Zahl auf',
    ausWerft.werftDeckel === deckel && katAus.body.werftDeckel === deckel,
    { amVorposten: ausWerft.werftDeckel, imKatalog: katAus.body.werftDeckel });
  await stoppeServer();

  // ---- Auswertung: Gruen-Lauf ODER Gegenprobe --------------------------------------------------
  if (SAB) {
    // BEIDE Richtungen messen: was faellt, und was aus der Pflichtliste NICHT gefallen ist.
    const soll = MUSS_FALLEN[SAB] || [];
    const gefallen = Object.keys(ergebnis).filter(n => ergebnis[n] === false).map(n => String(n).split(':')[0]).sort();
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
