// Echter HTTP-Test der fünf Frontbeiträge: Verbraucht der Endpunkt wirklich nur, was er gutschreibt –
// und erkennt er ein zurückgesetztes Konto?
//
// Warum das nicht statisch prüfbar ist: Die interessanten Eigenschaften sind Nebenwirkungen über
// mehrere Aufrufe hinweg. Ob nach einem Prestige weitergezählt statt gesperrt wird, ob am Tagesdeckel
// Rohstoffe abgebucht werden, ohne dass Punkte ankommen, ob eine nicht aufgebaute Front den
// Basiswert stehen lässt – all das sieht man erst, wenn man denselben Endpunkt mehrfach mit einer
// echten Datenbank dahinter aufruft.
//
// EIN FEHLER IM ERSTEN ANLAUF, der hier festgehalten bleibt: Das Fixture setzte die Front von Hand in
// db.galaxy.randkriege. Der Server ruft galaxyTick() aber EINMAL SOFORT BEIM START auf (server.js,
// direkt hinter dem setInterval), und rkTick baut die Frontliste dabei aus dem echten
// Fraktionsterritorium neu auf – die handgesetzte Front war eine Sekunde später weg, und der Test
// meldete für jeden Beitrag 409. Jetzt bekommen zwei verfeindete Fraktionen ECHTES, aneinander
// grenzendes Gebiet, und der Server baut seine Front selbst. Das Systempaar wird dafür nicht geraten,
// sondern aus SYSTEM_COORDS und rebuildSystemTables() des Servers berechnet (Quelltext
// herausgeschnitten und ausgeführt, kein Nachbau).
//
// AUSFÜHREN (Serverstart und Test laufen hier im selben Aufruf):
//   node tests/test_randkriege_handlungen_http.js
//
// GEGENPROBE (beide Richtungen, 10.08.2026) – gemessen, nicht vorhergesagt; Ergebnisse am Dateiende.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3197;
const BASIS = 'http://127.0.0.1:' + PORT + '/api';
const DB = path.join(os.tmpdir(), 'kepler-rk-handlungen-' + process.pid + '.json');

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };

// ---- Ein echtes Nachbarpaar aus den Serverdaten ------------------------------------------------
// Gewählt wird das Paar mit dem KLEINSTEN Abstand überhaupt. Die beiden sind damit gegenseitig
// nächster Nachbar und stehen in SYSTEM_NEIGHBORS (K=4) auf Platz eins – auch dann noch, wenn die
// wöchentlich wachsende Galaxie später weitere Systeme dazwischenschiebt.
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
const koords = new Function('return ' + literalNach('SYSTEM_COORDS', '[', ']') + ';')();
let paarA = null, paarB = null, engste = Infinity;
for (const a of koords) for (const b of koords) {
  if (a.id === b.id) continue;
  const d = Math.hypot(a.gx - b.gx, a.gy - b.gy);
  if (d < engste) { engste = d; paarA = a.id; paarB = b.id; }
}
// Zwei weitere Systeme je Seite, damit keine Fraktion bei einem Besitzwechsel ihr letztes verlöre
// (rkTick lässt so einen Wechsel sonst gar nicht zu, und der Test misst dann etwas anderes).
const weitere = koords.map(s => s.id).filter(id => id !== paarA && id !== paarB);

// ---- Test-Datenbank -----------------------------------------------------------------------------
const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ID = { anna: crypto.randomUUID(), bert: crypto.randomUUID(), carl: crypto.randomUUID() };

function spielstand(felder) {
  return Object.assign({
    resources: { energie: 50000, erz: 50000, kristalle: 50000, deuterium: 50000, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, fleet: { missions: [] }, colonies: {},
    player: { id: 'p', name: 'A' }, credits: 1000, xp: 1000, prestige: 0,
    expeditionsCompleted: 0, fundmeldungenGesamt: 0, piratennesterGeraeumt: 0,
    tradeRouteLifetimeCredits: 0, lastTick: Date.now()
  }, felder || {});
}
const nutzer = (name, id, save) => ({ name, id, save });
const konten = [
  nutzer('anna', ID.anna, spielstand({ expeditionsCompleted: 5 })),
  nutzer('bert', ID.bert, spielstand({})),
  nutzer('carl', ID.carl, spielstand({ resources: { erz: 10, kristalle: 10, deuterium: 10 } }))
];
const db = { users: {}, private: {}, shared: {}, resetTokens: {},
  galaxy: {
    npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
    news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(),
    // ECHTES Territorium. Gleiche Stärke auf beiden Seiten: Dann ist die Grundbewegung im Takt
    // exakt 0 und jede gemessene Veränderung stammt wirklich aus den Beiträgen.
    factions: {
      kartell:  { id: 'kartell',  name: 'Aschen-Kartell', color: '#fac775', systems: [paarA, weitere[0], weitere[1]], strength: 1 },
      schatten: { id: 'schatten', name: 'Schattenbund',   color: '#6fd0c0', systems: [paarB, weitere[2], weitere[3]], strength: 1 },
      // Legion und Void bleiben OHNE Gebiet - an ihrer Front gibt es dadurch keine Systeme, und
      // daran wird geprüft, dass ein Beitrag dorthin nichts verbraucht.
      legion:   { id: 'legion',   name: 'Eisenlegion',    color: '#85b7eb', systems: [], strength: 1 },
      void:     { id: 'void',     name: 'Void-Marodeure', color: '#e24b4a', systems: [], strength: 1 }
    }
  }
};
for (const k of konten) {
  db.users[k.name] = { userId: k.id, username: k.name, passwordHash: hash, createdAt: Date.now() };
  db.private[k.id] = { 'kepler7-save-v3': JSON.stringify(k.save) };
  db.shared['leaderboard:' + k.id] = JSON.stringify({ name: k.name, score: 10, lastSeen: Date.now() - 60000 });
}
fs.writeFileSync(DB, JSON.stringify(db, null, 1));

// ---- Server ------------------------------------------------------------------------------------
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
const alsUser = (token, koerper) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify(koerper)
});
const warte = ms => new Promise(r => setTimeout(r, ms));
const lies = () => JSON.parse(fs.readFileSync(DB, 'utf8'));
// Der Spielstand liegt in ZWEI Formen in der Datenbank: als roher JSON-String (so legt ihn dieses
// Fixture an) und als { value, version } (so schreibt ihn setSaveValue nach jeder serverseitigen
// Änderung). Genau diese Fallunterscheidung macht getSaveValue im Server auch - der erste Anlauf
// hier las stur JSON.parse(entry) und starb mit '"[object Object]" is not valid JSON', sobald der
// Nachschub den Spielstand einmal angefasst hatte.
function saveVon(id) {
  const e = lies().private[id]['kepler7-save-v3'];
  return JSON.parse(typeof e === 'string' ? e : e.value);
}
async function anmelden(name) {
  const r = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, password: 'test1234' }) });
  return r.body && r.body.token;
}
async function setzeSpielstand(token, felder) {
  return j('/storage/kepler7-save-v3', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ value: spielstand(felder) })
  });
}
// Der Frontabschnitt, den der Server für einen Beitrag gewählt hat - über die gemeldete System-ID,
// nicht über einen geratenen Index.
function eintrag(sys) {
  const f = (lies().galaxy.randkriege.fronten || []).find(x => x.a === 'kartell');
  return (f && (f.systeme || []).find(e => e.sys === sys)) || null;
}

(async () => {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASIS + '/health'); if (r.ok) break; } catch (e) {}
    await warte(250);
  }
  const tokenA = await anmelden('anna');
  check('Anmeldung erfolgreich', !!tokenA);
  if (!tokenA) { console.log(serverLog.slice(-1500)); aufraeumen(); process.exit(1); }

  // ---- 0. Der Server hat aus dem Territorium selbst eine Front gebaut ---------------------------
  {
    const g = await fetch(BASIS + '/galaxy', { headers: { Authorization: 'Bearer ' + tokenA } }).then(r => r.json());
    const f = (g.randkriege.fronten || []).find(x => x.a === 'kartell');
    check('0: die Kartell/Schatten-Front existiert', !!f && (f.systeme || []).length > 0,
      { paar: [paarA, paarB], systeme: f && f.systeme.map(e => e.sys) });
    const leer = (g.randkriege.fronten || []).find(x => x.a === 'legion');
    check('0: die Legion/Void-Front hat kein System', !!leer && (leer.systeme || []).length === 0,
      leer && leer.systeme);
    if (!f || !f.systeme.length) { console.log(serverLog.slice(-1200)); aufraeumen(); process.exit(1); }
  }

  // ---- 1. Aufklärungsertrag: fünf Expeditionen, einmal abgeholt ---------------------------------
  let sysGetroffen = null;
  {
    const r = await j('/randkriege/handlung', alsUser(tokenA, { art: 'aufklaerung', fraktion: 'kartell' }));
    check('1: der Beitrag wird angenommen', r.status === 200 && r.body.ok, { status: r.status, body: r.body });
    check('1: alle fünf Expeditionen auf einmal', r.body.einheiten === 5, r.body.einheiten);
    check('1: danach ist nichts mehr offen', r.body.offenDanach === 0, r.body.offenDanach);
    // 5 x 40 = 200 roh. Degression: die ersten 100 voll, die nächsten 100 zu 70% -> 170.
    check('1: die Degression greift schon beim ersten Mal', r.body.punkte === 170,
      { roh: 5 * 40, wirksam: r.body.punkte });
    sysGetroffen = r.body.sys;
    check('1: der Beitrag nennt ein Frontsystem', !!sysGetroffen, sysGetroffen);

    await warte(500);
    const d = lies();
    check('1: der Basiswert liegt im privaten Serverbereich',
      d.private[ID.anna].__rkBasis && d.private[ID.anna].__rkBasis.expeditionsCompleted === 5,
      d.private[ID.anna].__rkBasis);
    check('1: der Spielstand selbst wurde NICHT angefasst',
      saveVon(ID.anna).expeditionsCompleted === 5);
    const e = eintrag(sysGetroffen);
    check('1: die Punkte liegen im Puffer, nicht im Kontrollwert', !!e && e.puffer.a === 170,
      e && { puffer: e.puffer, kp: e.kp });
    check('1: das Konto ist als Beitragender vermerkt', !!(e && e.beitragende[ID.anna]),
      e && Object.keys(e.beitragende));
  }

  // ---- 2. Ein zweites Mal gibt es nichts ---------------------------------------------------------
  {
    const r = await j('/randkriege/handlung', alsUser(tokenA, { art: 'aufklaerung', fraktion: 'kartell' }));
    check('2: nichts offen, nichts gutgeschrieben', r.body.punkte === 0 && r.body.grund === 'nichts_offen', r.body);
    await warte(300);
    const e = eintrag(sysGetroffen);
    check('2: und der Puffer ist unverändert', !!e && e.puffer.a === 170, e && e.puffer);
  }

  // ---- 3. Prestige: der Zähler fällt auf 0 -------------------------------------------------------
  // Ohne Reset-Erkennung wäre das Konto ab hier dauerhaft gesperrt - es müsste erst wieder fünf
  // Expeditionen aufholen, bevor die Differenz überhaupt positiv würde.
  {
    await setzeSpielstand(tokenA, { expeditionsCompleted: 0 });
    const r = await j('/randkriege/handlung', alsUser(tokenA, { art: 'aufklaerung', fraktion: 'kartell' }));
    check('3: die Rücksetzung wird erkannt', r.body.grund === 'zurueckgesetzt', r.body);
    check('3: dabei wird nichts gutgeschrieben', r.body.punkte === 0, r.body.punkte);
    await warte(400);
    check('3: der Basiswert wandert mit nach unten',
      lies().private[ID.anna].__rkBasis.expeditionsCompleted === 0, lies().private[ID.anna].__rkBasis);

    await setzeSpielstand(tokenA, { expeditionsCompleted: 2 });
    const r2 = await j('/randkriege/handlung', alsUser(tokenA, { art: 'aufklaerung', fraktion: 'kartell' }));
    check('3: nach der Rücksetzung zählt wieder alles Neue', r2.body.einheiten === 2 && r2.body.punkte > 0, r2.body);
  }

  // ---- 4. Der Tagesdeckel verbrennt keinen Rückstand ----------------------------------------------
  // Stand jetzt: 200 + 80 = 280 rohe Punkte verbraucht, 20 von 300 übrig. Ein Rückstand von zehn
  // Nestern (10 x 30 = 300 roh) darf davon höchstens EINE Einheit verbrauchen.
  {
    await setzeSpielstand(tokenA, { expeditionsCompleted: 2, piratennesterGeraeumt: 10 });
    const r = await j('/randkriege/handlung', alsUser(tokenA, { art: 'piratennest', fraktion: 'kartell' }));
    check('4: nur eine Einheit wird verbraucht', r.body.einheiten === 1, r.body);
    check('4: der Rest bleibt für morgen stehen', r.body.offenDanach === 9, r.body.offenDanach);
    await warte(400);
    check('4: der Basiswert ist nur um eine Einheit gewandert',
      lies().private[ID.anna].__rkBasis.piratennesterGeraeumt === 1, lies().private[ID.anna].__rkBasis);

    const r2 = await j('/randkriege/handlung', alsUser(tokenA, { art: 'piratennest', fraktion: 'kartell' }));
    check('4: am Deckel wird nichts mehr angenommen', r2.body.punkte === 0 && r2.body.grund === 'tagesdeckel', r2.body);
    await warte(300);
    check('4: und der Basiswert steht still',
      lies().private[ID.anna].__rkBasis.piratennesterGeraeumt === 1, lies().private[ID.anna].__rkBasis);
  }

  // ---- 5. Nachschub: der Server bucht selbst ab ---------------------------------------------------
  // Bert ist frisch - zugleich der Beleg, dass die Tagesbudgets je KONTO geführt werden.
  {
    const tokenB = await anmelden('bert');
    check('5: zweites Konto angemeldet', !!tokenB);
    const vorher = saveVon(ID.bert).resources;
    const r = await j('/randkriege/handlung', alsUser(tokenB, { art: 'nachschub', fraktion: 'schatten' }));
    check('5: die Spende wird angenommen', r.status === 200 && r.body.punkte === 60, { status: r.status, body: r.body });
    check('5: der Spielstand bekommt eine neue Versionsnummer', typeof r.body.saveVersion === 'number', r.body.saveVersion);
    await warte(500);
    const nachher = saveVon(ID.bert).resources;
    check('5: der Server hat die Rohstoffe selbst abgebucht',
      nachher.erz === vorher.erz - 4000 && nachher.kristalle === vorher.kristalle - 2500
      && nachher.deuterium === vorher.deuterium - 1200, { vorher, nachher });
    const e = eintrag(r.body.sys);
    check('5: die Spende ging auf die Gegenseite (Puffer b)', !!e && e.puffer.b === 60, e && e.puffer);

    const r2 = await j('/randkriege/handlung', alsUser(tokenB, { art: 'nachschub', fraktion: 'schatten' }));
    check('5: die Sperrzeit greift', r2.status === 429, { status: r2.status, body: r2.body });
    await warte(300);
    const nochmal = saveVon(ID.bert).resources;
    check('5: der abgelehnte zweite Versuch kostet nichts',
      nochmal.erz === nachher.erz, { nach1: nachher.erz, nach2: nochmal.erz });
  }

  // ---- 6. Zu wenig Rohstoffe: keine Abbuchung, kein Beitrag ---------------------------------------
  {
    const tokenC = await anmelden('carl');
    const r = await j('/randkriege/handlung', alsUser(tokenC, { art: 'nachschub', fraktion: 'schatten' }));
    check('6: zu wenig Rohstoffe wird abgelehnt', r.status === 400, { status: r.status, body: r.body });
    await warte(400);
    const res = saveVon(ID.carl).resources;
    check('6: und es wird nichts abgebucht', res.erz === 10, res);
    check('6: die Sperrzeit wurde nicht gesetzt', !(lies().private[ID.carl] || {}).__rkNachschubAt);

    // ---- 7. Randfälle ---------------------------------------------------------------------------
    const u1 = await j('/randkriege/handlung', alsUser(tokenC, { art: 'gibtsnicht', fraktion: 'kartell' }));
    check('7: unbekannte Handlung wird abgelehnt', u1.status === 400, u1.status);
    const u2 = await j('/randkriege/handlung', alsUser(tokenC, { art: 'aufklaerung', fraktion: 'piraten' }));
    check('7: unbekannte Fraktion wird abgelehnt', u2.status === 400, u2.status);
    const u3 = await j('/randkriege/handlung', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('7: ohne Anmeldung geht gar nichts', u3.status === 401, u3.status);

    // Front ohne Systeme (Legion/Void): darf den Basiswert nicht verbrauchen.
    await setzeSpielstand(tokenC, { expeditionsCompleted: 3, resources: { erz: 10, kristalle: 10, deuterium: 10 } });
    const leer = await j('/randkriege/handlung', alsUser(tokenC, { art: 'aufklaerung', fraktion: 'legion' }));
    check('7: eine Front ohne Systeme nimmt nichts an', leer.status === 409, { status: leer.status, body: leer.body });
    await warte(400);
    const basisC = lies().private[ID.carl].__rkBasis || {};
    check('7: und der Basiswert bleibt unangetastet', !basisC.expeditionsCompleted, basisC);

    // ---- 8. Was der Client zu sehen bekommt ------------------------------------------------------
    const g = await fetch(BASIS + '/galaxy', { headers: { Authorization: 'Bearer ' + tokenC } }).then(r => r.json());
    const roh = JSON.stringify(g);
    check('8: meineBasis wird mitgeliefert', !!g.randkriege.meineBasis, g.randkriege.meineBasis);
    check('8: die Tagesbreite ebenfalls', g.randkriege.tagesBreite > 0, g.randkriege.tagesBreite);
    check('8: aber keine Pufferstände und keine Beitragendenliste',
      !/"puffer"/.test(roh) && !/"beitragende"/.test(roh));
    // Gescopet auf den Randkriegs-Block: Die Galaxie enthaelt an anderer Stelle sehr wohl eine
    // fremde Konto-ID - g.bounty.targetUserId, das Kopfgeld auf den Tabellenersten. Das ist seit
    // jeher oeffentlich und gehoert nicht hierher. Der erste Anlauf prueft die GANZE Antwort und
    // schlug genau daran an; die Pruefung meinte aber die Beitragsdaten.
    check('8: keine fremde Konto-ID in den Randkriegsdaten',
      !JSON.stringify(g.randkriege).includes(ID.anna), ID.anna);
    check('8: die fremde ID stammt aus dem Kopfgeld, nicht aus der Front',
      !roh.includes(ID.anna) || (g.bounty && g.bounty.targetUserId === ID.anna),
      g.bounty && g.bounty.targetUserId);
    check('8: die Zahl der Beitragenden je Seite steht drin',
      (g.randkriege.fronten || []).some(f => (f.systeme || []).some(e => e.beitragendeA > 0)),
      (g.randkriege.fronten || []).map(f => (f.systeme || []).map(e => [e.sys, e.beitragendeA, e.beitragendeB])));
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

// GEMESSENE GEGENPROBEN (10.08.2026) - jede Sabotage einzeln gefahren, notiert ist das ERGEBNIS,
// nicht meine Vorhersage:
//
//   Reset-Erkennung entfernt (`if (jetzt < gemerkt)` gestrichen):
//     FAIL 3: die Rücksetzung wird erkannt        | grund 'nichts_offen' statt 'zurueckgesetzt'
//     FAIL 3: der Basiswert wandert mit nach unten| bleibt auf 5 stehen
//     FAIL 3: nach der Rücksetzung zählt wieder alles Neue
//     und in der Folge FAIL 4 (dreimal) - genau die Sperre, um die es geht: Das Konto kommt aus
//     'nichts_offen' nicht mehr heraus, bis es seine alten fünf Expeditionen aufgeholt hat.
//
//   Deckelung der Einheiten entfernt (`const einheiten = offen;`):
//     FAIL 4: nur eine Einheit wird verbraucht    | einheiten 10, roh 300, wirksam 8
//     FAIL 4: der Rest bleibt für morgen stehen   | offenDanach 0
//     Das ist der Fehler in Reinform: zehn geräumte Nester für acht Kriegspunkte verbrannt.
//
//   galaxyFuerClient in /api/galaxy übersprungen (`res.json(loadOrInitGalaxy())`):
//     FAIL 8 (fünfmal), darunter „aber keine Pufferstände und keine Beitragendenliste".
//
//   NICHT gefahren (und deshalb hier auch nicht behauptet): eine Sabotage der rkVorschau-Wache im
//   Nachschub. Sie greift erst, wenn das Tagesbudget des spendenden Kontos fast erschöpft ist; der
//   Test führt dieses Konto bewusst frisch, damit Abbuchung und Sperrzeit sauber messbar bleiben.
//   Die Wache selbst ist statisch in tests/test_randkriege_handlungen.js im Frontend-Prüflauf
//   abgesichert („4: der Ertrag wird VOR dem Abbuchen der Rohstoffe geprüft").
