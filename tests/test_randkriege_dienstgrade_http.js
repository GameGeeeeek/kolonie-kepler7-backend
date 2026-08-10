// Dienstpunkte, Frontmarken und das Frontlager am laufenden Server.
//
// Was hier gemessen wird und statisch nicht messbar wäre: Ob ein Beitrag WIRKLICH beides
// fortschreibt, ob der Wochendeckel greift, ob ein angefangener Rest mitgenommen statt verworfen
// wird, und ob das Lager Dienstgrad und Bestand prüft, bevor es abbucht. Das sind alles
// Nebenwirkungen über mehrere Aufrufe mit einer echten Datenbank dahinter.
//
// AUSFÜHREN: node tests/test_randkriege_dienstgrade_http.js
//
// GEGENPROBE (beide Richtungen, 10.08.2026) - gemessene Ergebnisse am Dateiende.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3195;
const BASIS = 'http://127.0.0.1:' + PORT + '/api';
const DB = path.join(os.tmpdir(), 'kepler-dienstgrade-' + process.pid + '.json');

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };

// ---- Echte Serverwerte statt geratener -----------------------------------------------------------
const quelle = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
function literalNach(name, oeffner, schliesser) {
  const start = quelle.indexOf('const ' + name + ' = ' + oeffner);
  if (start < 0) return null;
  let tiefe = 0, i = quelle.indexOf(oeffner, start);
  for (; i < quelle.length; i++) {
    if (quelle[i] === oeffner) tiefe++;
    else if (quelle[i] === schliesser) { tiefe--; if (tiefe === 0) break; }
  }
  return tiefe === 0 ? quelle.slice(quelle.indexOf(oeffner, start), i + 1) : null;
}
function funktionNach(name) {
  const start = quelle.indexOf('function ' + name + '(');
  if (start < 0) return null;
  const stop = quelle.indexOf('\n}', start);
  return stop < 0 ? null : quelle.slice(start, stop + 2);
}
const koords = new Function('return ' + literalNach('SYSTEM_COORDS', '[', ']') + ';')();
const GRADE = new Function('return ' + literalNach('RK_DIENSTGRADE', '[', ']') + ';')();
const LAGER = new Function('return ' + literalNach('RK_LAGER', '{', '}') + ';')();
const MARKE_JE = new Function('return ' + (quelle.match(/^const RK_MARKE_JE_PUNKTE = ([^;]+);/m) || [])[1] + ';')();
const WOCHE_DECKEL = new Function('return ' + (quelle.match(/^const RK_MARKEN_WOCHE = ([^;]+);/m) || [])[1] + ';')();
// Der Wochenschlüssel wird NICHT nachgebaut, sondern aus dem Server herausgeschnitten und
// ausgeführt - sonst prüfte das Fixture gegen eine eigene Vorstellung davon, wann die Woche beginnt.
const serverWeekKey = new Function(funktionNach('serverWeekKey') + '; return serverWeekKey;')();
const WOCHE = serverWeekKey(Date.now());

let paarA = null, paarB = null, engste = Infinity;
for (const a of koords) for (const b of koords) {
  if (a.id === b.id) continue;
  const d = Math.hypot(a.gx - b.gx, a.gy - b.gy);
  if (d < engste) { engste = d; paarA = a.id; paarB = b.id; }
}
const weitere = koords.map(s => s.id).filter(id => id !== paarA && id !== paarB);

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ID = { anna: crypto.randomUUID(), bert: crypto.randomUUID(), carl: crypto.randomUUID(), dora: crypto.randomUUID() };

function spielstand(felder) {
  return Object.assign({
    resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, fleet: { missions: [] }, colonies: {},
    player: { id: 'p', name: 'A' }, credits: 1000, xp: 1000, prestige: 0,
    expeditionsCompleted: 0, fundmeldungenGesamt: 0, piratennesterGeraeumt: 0,
    tradeRouteLifetimeCredits: 0, lastTick: Date.now()
  }, felder || {});
}

const db = {
  users: {}, private: {}, shared: {}, resetTokens: {},
  galaxy: {
    npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
    news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(),
    factions: {
      kartell:  { id: 'kartell',  name: 'Aschen-Kartell', color: '#fac775', systems: [paarA, weitere[0], weitere[1]], strength: 1 },
      schatten: { id: 'schatten', name: 'Schattenbund',   color: '#6fd0c0', systems: [paarB, weitere[2], weitere[3]], strength: 1 },
      legion:   { id: 'legion',   name: 'Eisenlegion',    color: '#85b7eb', systems: [], strength: 1 },
      void:     { id: 'void',     name: 'Void-Marodeure', color: '#e24b4a', systems: [], strength: 1 }
    },
    // Vorbelegt, was sich in einem Test nicht in Echtzeit erspielen lässt. Das ist SERVERSEITIGER
    // Zustand - das Fixture legt ihn direkt an, statt ihn über die API zu fälschen (das ginge seit
    // der '__'-Sperre ohnehin nicht mehr, und es wäre auch nicht das, was geprüft werden soll).
    randkriege: {
      // bert ist Marschall und hat acht Marken - er prüft das Lager.
      // carl hat seinen Wochendeckel schon ausgeschöpft.
      dienst: { [ID.bert]: { kartell: GRADE[GRADE.length - 1].schwelle + 500 } },
      marken: { [ID.bert]: 8 },
      // dora steht KNAPP unter dem Deckel und hat schon einen angefangenen Rest liegen. Sie prüft
      // zwei Dinge, die carl nicht prüfen kann: dass der Rest AUFADDIERT wird (nicht überschrieben)
      // und dass der Deckel auch dann greift, wenn er im selben Beitrag erst erreicht wird.
      woche: { stempel: WOCHE, konten: {
        [ID.carl]: { marken: WOCHE_DECKEL, rest: 0 },
        [ID.dora]: { marken: WOCHE_DECKEL - 3, rest: MARKE_JE - 10 }
      } }
    }
  }
};
for (const [name, id, save] of [
  ['anna', ID.anna, spielstand({ expeditionsCompleted: 8 })],
  ['bert', ID.bert, spielstand({})],
  ['carl', ID.carl, spielstand({ expeditionsCompleted: 8 })],
  ['dora', ID.dora, spielstand({ expeditionsCompleted: 8 })]
]) {
  db.users[name] = { userId: id, username: name, passwordHash: hash, createdAt: Date.now() };
  db.private[id] = { 'kepler7-save-v3': JSON.stringify(save) };
  db.shared['leaderboard:' + id] = JSON.stringify({ name, score: 10, lastSeen: Date.now() - 60000 });
}
fs.writeFileSync(DB, JSON.stringify(db, null, 1));

let serverLog = '';
const srv = spawn(process.execPath, [path.join(WURZEL, 'server.js')], {
  cwd: WURZEL,
  env: Object.assign({}, process.env, { DB_FILE: DB, PORT: String(PORT), JWT_SECRET: 'testsecret' }),
  stdio: ['ignore', 'pipe', 'pipe']
});
srv.stdout.on('data', d => { serverLog += d; });
srv.stderr.on('data', d => { serverLog += d; });
function aufraeumen() {
  try { srv.kill(); } catch (e) {}
  try { fs.unlinkSync(DB); } catch (e) {}
}
process.on('exit', aufraeumen);

async function j(pfad, opt) {
  const r = await fetch(BASIS + pfad, opt);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; }
  catch (e) { return { status: r.status, body: t.slice(0, 300) }; }
}
const warte = ms => new Promise(r => setTimeout(r, ms));
const lies = () => JSON.parse(fs.readFileSync(DB, 'utf8'));
const rkVon = () => lies().galaxy.randkriege;
async function anmelden(name) {
  const r = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, password: 'test1234' }) });
  return r.body && r.body.token;
}
const alsUser = (token, koerper) => ({
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify(koerper)
});

(async () => {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASIS + '/health'); if (r.ok) break; } catch (e) {}
    await warte(250);
  }
  const tA = await anmelden('anna');
  check('Anmeldung erfolgreich', !!tA);
  if (!tA) { console.log(serverLog.slice(-1500)); aufraeumen(); process.exit(1); }

  // ---- 1. Ein Beitrag schreibt Dienstpunkte UND Marken fort ---------------------------------------
  {
    const r = await j('/randkriege/handlung', alsUser(tA, { art: 'aufklaerung', fraktion: 'kartell' }));
    check('1: der Beitrag wird angenommen', r.status === 200 && r.body.punkte > 0, { status: r.status, body: r.body });
    const wirksam = r.body.punkte;
    await warte(500);
    const rk = rkVon();
    check('1: die Dienstpunkte stehen bei der GELIEFERTEN Fraktion',
      (rk.dienst[ID.anna] || {}).kartell === wirksam, rk.dienst[ID.anna]);
    check('1: und bei keiner anderen',
      Object.keys(rk.dienst[ID.anna] || {}).length === 1, rk.dienst[ID.anna]);
    // Marken: floor(wirksam / MARKE_JE), Rest wandert ins Wochenkonto.
    const erwarteteMarken = Math.floor(wirksam / MARKE_JE);
    const erwarteterRest = wirksam - erwarteteMarken * MARKE_JE;
    check('1: die Marken folgen dem Umrechnungskurs',
      (rk.marken[ID.anna] || 0) === erwarteteMarken, { wirksam, kurs: MARKE_JE, marken: rk.marken[ID.anna], erwartet: erwarteteMarken });
    check('1: der angefangene Rest wird mitgenommen, nicht verworfen',
      (rk.woche.konten[ID.anna] || {}).rest === erwarteterRest,
      { rest: (rk.woche.konten[ID.anna] || {}).rest, erwartet: erwarteterRest });
    check('1: das Wochenkonto trägt den Server-Wochenschlüssel', rk.woche.stempel === WOCHE, rk.woche.stempel);
  }

  // ---- 2. Was der Client davon sieht ---------------------------------------------------------------
  {
    const g = await fetch(BASIS + '/galaxy', { headers: { Authorization: 'Bearer ' + tA } }).then(r => r.json());
    const k = g.randkriege.meinKonto;
    check('2: meinKonto wird mitgeliefert', !!k, k);
    check('2: mit Bestand, Dienstpunkten und Wochenstand',
      typeof k.marken === 'number' && typeof k.dienst === 'object'
      && typeof k.wocheMarken === 'number' && k.wocheDeckel === WOCHE_DECKEL, k);
    check('2: und dem Umrechnungskurs, damit die Anzeige ihn nicht doppelt führt',
      k.markeJePunkte === MARKE_JE, k.markeJePunkte);
    check('2: keine fremden Dienstpunkte in der Antwort',
      !JSON.stringify(g.randkriege).includes(ID.bert), ID.bert);
  }

  // ---- 3. Das Lager prüft den Dienstgrad -----------------------------------------------------------
  {
    const rk = rkVon();
    const punkte = (rk.dienst[ID.anna] || {}).kartell || 0;
    check('3: anna liegt noch unter der ersten Stufe', punkte < GRADE[0].schwelle, { punkte, erste: GRADE[0].schwelle });
    const r = await j('/randkriege/lager', alsUser(tA, { posten: 'depot' }));
    check('3: ohne Dienstgrad kein Kauf', r.status === 403, { status: r.status, body: r.body });
    await warte(300);
    check('3: und es wurde nichts abgebucht', (rkVon().marken[ID.anna] || 0) === (rk.marken[ID.anna] || 0));
  }

  // ---- 4. Das Lager prüft Bestand und Preis --------------------------------------------------------
  {
    const tB = await anmelden('bert');
    const vorher = rkVon().marken[ID.bert];
    check('4: bert startet mit acht Marken', vorher === 8, vorher);

    const kauf = await j('/randkriege/lager', alsUser(tB, { posten: 'depot' }));
    check('4: der Kauf geht durch', kauf.status === 200 && kauf.body.ok, { status: kauf.status, body: kauf.body });
    check('4: abgebucht wird der Preis aus RK_LAGER', kauf.body.kosten === LAGER.depot.kosten, kauf.body.kosten);
    check('4: der gemeldete Bestand stimmt', kauf.body.bestand === vorher - LAGER.depot.kosten, kauf.body.bestand);
    await warte(400);
    check('4: und er steht so auch in der Datenbank',
      rkVon().marken[ID.bert] === vorher - LAGER.depot.kosten, rkVon().marken[ID.bert]);

    // Der teuerste Posten ist jetzt unbezahlbar.
    const teuer = Object.entries(LAGER).sort((a, b) => b[1].kosten - a[1].kosten)[0];
    const zuTeuer = await j('/randkriege/lager', alsUser(tB, { posten: teuer[0] }));
    check('4: zu wenig Marken wird abgelehnt', zuTeuer.status === 400, { posten: teuer[0], status: zuTeuer.status, body: zuTeuer.body });
    await warte(300);
    check('4: und kostet nichts', rkVon().marken[ID.bert] === vorher - LAGER.depot.kosten, rkVon().marken[ID.bert]);

    const quatsch = await j('/randkriege/lager', alsUser(tB, { posten: 'gibtsnicht' }));
    check('4: ein unbekannter Posten wird abgelehnt', quatsch.status === 400, quatsch.status);
    const ohne = await j('/randkriege/lager', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('4: ohne Anmeldung geht gar nichts', ohne.status === 401, ohne.status);
  }

  // ---- 5. Der Wochendeckel ---------------------------------------------------------------------------
  // carl hat diese Woche schon zwölf Marken verdient. Ein weiterer Beitrag muss Dienstpunkte
  // schreiben - die sind ungedeckelt - aber KEINE Marke mehr.
  {
    const tC = await anmelden('carl');
    const vorher = rkVon().marken[ID.carl] || 0;
    const r = await j('/randkriege/handlung', alsUser(tC, { art: 'aufklaerung', fraktion: 'schatten' }));
    check('5: der Beitrag zählt trotzdem', r.status === 200 && r.body.punkte > 0, { status: r.status, body: r.body });
    await warte(500);
    const rk = rkVon();
    check('5: Dienstpunkte gibt es weiterhin',
      (rk.dienst[ID.carl] || {}).schatten === r.body.punkte, rk.dienst[ID.carl]);
    check('5: aber keine Marke mehr', (rk.marken[ID.carl] || 0) === vorher, { vorher, nachher: rk.marken[ID.carl] || 0 });
    check('5: und am Deckel läuft auch kein Rest mehr auf',
      (rk.woche.konten[ID.carl] || {}).rest === 0, rk.woche.konten[ID.carl]);
    check('5: der Wochenzähler steht auf dem Deckel',
      (rk.woche.konten[ID.carl] || {}).marken === WOCHE_DECKEL, rk.woche.konten[ID.carl]);
  }

  // ---- 6. Der angefangene Rest addiert sich auf ----------------------------------------------------
  // dora liegt DREI Marken unter dem Deckel (also nicht am Anschlag - sonst würde der Deckel die
  // Messung überdecken) und hat einen Rest von MARKE_JE-10 liegen. Ihr Beitrag bringt 210 wirksame
  // Punkte. Mit dem Aufaddieren sind das 190+210 = 400, also ZWEI Marken und Rest 0. Ohne das `+=`
  // wären es 210, also EINE Marke und Rest 10. Die beiden Fälle sind an Markenzahl UND Rest
  // unterscheidbar - der erste Anlauf setzte dora auf den Deckel und maß dadurch in beiden Fällen
  // dasselbe.
  {
    const tD = await anmelden('dora');
    const vorher = rkVon().marken[ID.dora] || 0;
    const restVorher = (rkVon().woche.konten[ID.dora] || {}).rest;
    const r = await j('/randkriege/handlung', alsUser(tD, { art: 'aufklaerung', fraktion: 'kartell' }));
    check('6: der Beitrag wird angenommen', r.status === 200 && r.body.punkte > 0, { status: r.status, body: r.body });
    await warte(500);
    const k = rkVon().woche.konten[ID.dora] || {};
    const gesamt = restVorher + r.body.punkte;
    const erwarteteMarken = Math.floor(gesamt / MARKE_JE);
    check('6: Rest und Beitrag werden zusammengerechnet',
      (rkVon().marken[ID.dora] || 0) === vorher + erwarteteMarken,
      { restVorher, wirksam: r.body.punkte, gesamt, erwartet: erwarteteMarken, gemessen: (rkVon().marken[ID.dora] || 0) - vorher });
    check('6: und der neue Rest ist der Überhang daraus',
      k.rest === gesamt - erwarteteMarken * MARKE_JE, { rest: k.rest, erwartet: gesamt - erwarteteMarken * MARKE_JE });
    check('6: dora bleibt unter dem Wochendeckel', k.marken < WOCHE_DECKEL, k);
  }

  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nAlles in Ordnung');
  aufraeumen();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('Testabbruch:', (e && e.stack) || e);
  console.error(serverLog.slice(-1500));
  aufraeumen();
  process.exit(1);
});
