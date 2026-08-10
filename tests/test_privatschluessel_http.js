// Darf ein eingeloggter Client die SERVERINTERNEN Felder seines eigenen privaten Bereichs
// überschreiben? Er darf nicht – und bis zum 10.08.2026 konnte er es.
//
// PUT /api/storage/:key?shared=false schrieb `db.private[req.userId][key]` für JEDEN Schlüssel.
// Der private Bereich enthält aber nicht nur den Spielstand, sondern siebzehn Felder, die
// ausschließlich der Server führt und denen er beim Lesen vertraut: __rkBasis (wie viel
// Zählerfortschritt ein Konto schon in Kriegspunkte umgetauscht hat), __rkNachschubAt (die
// Vier-Stunden-Sperre der Nachschubspende), __attackShieldUntil, __pendingRewards, __lastAttackPush,
// __sabotageCooldowns und weitere.
//
// Der Spielstand selbst (kepler7-save-v3) ist davon ausdrücklich NICHT betroffen – ihn schreibt der
// Client völlig zu Recht, er ist der einzige private Schlüssel, den das Frontend überhaupt anfasst
// (nachgeprüft: keine einzige Stelle in weltraum_kolonie.html schreibt einen '__'-Schlüssel).
//
// GEMESSEN, NICHT BEHAUPTET: Dieser Test zeigt die Folgen an den echten Endpunkten, statt sie aus
// dem Quelltext zu erschließen. Die interessante Eigenschaft ist, dass ein gefälschter Wert als
// { value, version } abgelegt wird – der Server liest dann ein OBJEKT, wo er eine Zahl erwartet,
// und die üblichen Vergleiche fallen auf „undefined"/NaN, also nach PERMISSIV.
//
// AUSFÜHREN: node tests/test_privatschluessel_http.js
//
// GEGENPROBE (beide Richtungen, 10.08.2026): Am Stand VOR der Behebung sind die drei
// „wird abgelehnt"-Prüfungen rot und die drei Folgeprüfungen zeigen die Ausnutzung; danach ist
// alles grün. Die Kontrollprüfung („der Spielstand selbst bleibt schreibbar") ist in BEIDEN Läufen
// grün – der Test misst den Unterschied und nicht bloß, dass der Server antwortet.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3196;
const BASIS = 'http://127.0.0.1:' + PORT + '/api';
const DB = path.join(os.tmpdir(), 'kepler-privat-' + process.pid + '.json');

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const UID = crypto.randomUUID();

// Ein echtes Nachbarpaar, damit der Server eine Front aufbaut - sonst nimmt kein Beitrag etwas an
// und die Ausnutzung ließe sich gar nicht messen (derselbe Fallstrick wie in
// test_randkriege_handlungen_http.js, dort ausführlich kommentiert).
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
const weitere = koords.map(s => s.id).filter(id => id !== paarA && id !== paarB);

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
  users: { anna: { userId: UID, username: 'anna', passwordHash: hash, createdAt: Date.now() } },
  private: { [UID]: { 'kepler7-save-v3': JSON.stringify(spielstand({ expeditionsCompleted: 3 })) } },
  shared: { ['leaderboard:' + UID]: JSON.stringify({ name: 'anna', score: 10, lastSeen: Date.now() - 60000 }) },
  resetTokens: {},
  galaxy: {
    npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
    news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(),
    factions: {
      kartell:  { id: 'kartell',  name: 'Aschen-Kartell', color: '#fac775', systems: [paarA, weitere[0], weitere[1]], strength: 1 },
      schatten: { id: 'schatten', name: 'Schattenbund',   color: '#6fd0c0', systems: [paarB, weitere[2], weitere[3]], strength: 1 },
      legion:   { id: 'legion',   name: 'Eisenlegion',    color: '#85b7eb', systems: [], strength: 1 },
      void:     { id: 'void',     name: 'Void-Marodeure', color: '#e24b4a', systems: [], strength: 1 }
    }
  }
};
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

(async () => {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASIS + '/health'); if (r.ok) break; } catch (e) {}
    await warte(250);
  }
  const login = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'anna', password: 'test1234' }) });
  const token = login.body && login.body.token;
  check('Anmeldung erfolgreich', !!token);
  if (!token) { console.log(serverLog.slice(-1500)); aufraeumen(); process.exit(1); }
  const kopf = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  const schreibe = (key, value) => j('/storage/' + encodeURIComponent(key) + '?shared=false',
    { method: 'PUT', headers: kopf, body: JSON.stringify({ value }) });

  // ---- 0. Kontrollprüfung: der Spielstand bleibt schreibbar --------------------------------------
  // Sie ist an BEIDEN Ständen grün. Ohne sie könnte eine Sperre, die einfach ALLES ablehnt, den Test
  // bestehen und dabei das Spiel unspielbar machen.
  {
    const r = await schreibe('kepler7-save-v3', spielstand({ expeditionsCompleted: 3 }));
    check('0: der eigene Spielstand bleibt schreibbar', r.status === 200, { status: r.status, body: r.body });
    const r2 = await schreibe('meinevorlieben', { thema: 'dunkel' });
    check('0: ein gewöhnlicher eigener Schlüssel bleibt schreibbar', r2.status === 200, r2.status);
  }

  // ---- 1. Serverinterne Schlüssel werden abgelehnt ----------------------------------------------
  {
    for (const key of ['__rkBasis', '__rkNachschubAt', '__pendingRewards', '__attackShieldUntil']) {
      const r = await schreibe(key, 0);
      check('1: ' + key + ' wird abgelehnt', r.status === 403, { status: r.status, body: r.body });
    }
    await warte(400);
    const priv = lies().private[UID];
    check('1: kein serverinterner Schlüssel wurde angelegt',
      !priv.__rkBasis && !priv.__rkNachschubAt && !priv.__pendingRewards && !priv.__attackShieldUntil,
      Object.keys(priv));
  }

  // ---- 2. Die Folge, gegen die die Sperre schützt: Beiträge doppelt einlösen ---------------------
  // Ohne die Sperre setzt ein Konto seinen Basiswert zurück und tauscht denselben Zählerstand
  // beliebig oft in Kriegspunkte um - der Zusammenhang „du musst wirklich gespielt haben" wäre weg.
  {
    const erste = await j('/randkriege/handlung', { method: 'POST', headers: kopf,
      body: JSON.stringify({ art: 'aufklaerung', fraktion: 'kartell' }) });
    check('2: der erste, ehrliche Beitrag zählt', erste.body && erste.body.einheiten === 3, erste.body);

    const zweite = await j('/randkriege/handlung', { method: 'POST', headers: kopf,
      body: JSON.stringify({ art: 'aufklaerung', fraktion: 'kartell' }) });
    check('2: der zweite ohne neue Expeditionen zählt nicht', zweite.body && zweite.body.punkte === 0, zweite.body);

    await schreibe('__rkBasis', {});                    // der Fälschungsversuch
    const dritte = await j('/randkriege/handlung', { method: 'POST', headers: kopf,
      body: JSON.stringify({ art: 'aufklaerung', fraktion: 'kartell' }) });
    check('2: nach dem Fälschungsversuch bleibt es dabei', dritte.body && dritte.body.punkte === 0,
      { antwort: dritte.body, hinweis: 'ohne die Sperre stünden hier wieder 3 Einheiten' });
  }

  // ---- 3. Die zweite Folge: die Sperrzeit der Nachschubspende --------------------------------------
  {
    const eins = await j('/randkriege/handlung', { method: 'POST', headers: kopf,
      body: JSON.stringify({ art: 'nachschub', fraktion: 'kartell' }) });
    check('3: die erste Spende geht durch', eins.status === 200 && eins.body.punkte > 0, { status: eins.status, body: eins.body });
    const zwei = await j('/randkriege/handlung', { method: 'POST', headers: kopf,
      body: JSON.stringify({ art: 'nachschub', fraktion: 'kartell' }) });
    check('3: die zweite läuft in die Sperrzeit', zwei.status === 429, zwei.status);

    await schreibe('__rkNachschubAt', 0);               // der Fälschungsversuch
    const drei = await j('/randkriege/handlung', { method: 'POST', headers: kopf,
      body: JSON.stringify({ art: 'nachschub', fraktion: 'kartell' }) });
    check('3: nach dem Fälschungsversuch greift die Sperrzeit weiter', drei.status === 429,
      { status: drei.status, hinweis: 'ohne die Sperre stünde hier 200 - der Vergleich fiele auf NaN und damit auf durchlassen' });
  }

  // ---- 4. Und der Server läuft noch --------------------------------------------------------------
  // __pendingRewards ist eine LISTE, auf die der Server push() aufruft. Ein gefälschter Wert macht
  // daraus ein Objekt. Ob das den Weltentakt zerlegt, wird hier nicht behauptet, sondern gemessen:
  // nach allen Versuchen muss der Server noch antworten.
  {
    const g = await j('/galaxy', { headers: { Authorization: 'Bearer ' + token } });
    check('4: der Server antwortet nach allen Versuchen normal', g.status === 200 && !!g.body.randkriege, g.status);
    const abholen = await j('/pending-rewards', { headers: { Authorization: 'Bearer ' + token } });
    check('4: die Belohnungs-Warteschlange ist intakt',
      abholen.status === 200 && Array.isArray(abholen.body.rewards), abholen.body);
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
