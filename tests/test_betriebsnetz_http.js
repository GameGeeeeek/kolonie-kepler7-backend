// Das Betriebsnetz: ein gescheiterter Takt und ein Absturz (02.09.2026, Strukturpruefung C2).
//
// BEFUND, gemessen am Stand davor: `grep -n "process.on(" server.js` fand GENAU ZWEI Zeilen,
// beide fuer SIGTERM/SIGINT. Kein Handler fuer uncaughtException, keiner fuer unhandledRejection.
// Ein Wurf in irgendeinem der elf Takte beendete damit den ganzen Server - und weil ein Absturz
// kein Signal schickt, lief der vorhandene Flush dabei NICHT: bis zu fuenf Minuten Spielstand weg
// (so lange laeuft das periodische saveDb), dazu ein 502 fuer alle.
//
// GEPRUEFT WIRD AN EINEM WIRKLICH LAUFENDEN SERVER, mit KOPIEN von server.js im Repo-Verzeichnis
// (require('./mailer') loest nur dort auf), denen je ein absichtlicher Fehler angehaengt ist:
//   1) Ein Takt wirft -> der Server lebt weiter, der Takt LAEUFT WEITER, und der Fehler ist von
//      aussen sichtbar. 1c ist die eigentliche Aussage: Ein aufgefangener Fehler, von dem niemand
//      erfaehrt, waere schlechter als der laute Absturz, den er ersetzt.
//   2) Ein Wurf AUSSERHALB eines Takts -> der Prozess beendet sich (das ist Absicht: nach einem
//      uncaughtException ist der Zustand nicht mehr belastbar), aber die db.json auf der Platte
//      traegt danach eine Aenderung, die vorher NUR im RAM stand. 2b ist die Kernmessung.
//   3) Ohne Fehler meldet nichts einen Fehler - sonst belegte Abschnitt 1 nur, dass der Zaehler
//      immer zaehlt (Arbeitsregel 28).
//
// GEGENPROBEN, beide gemessen:
//   a) Gegen origin/master fallen 13 der 15 Pruefungen. Gruen bleiben nur "2-vorab" (der Server
//      kommt hoch - eine Aufbau-Pruefung) und 3b (er laeuft ohne Fehler weiter - Verhalten, das
//      auch vorher richtig war). Prueflisten beider Laeufe per diff verglichen; sie sind bis auf
//      die Schlusszeile identisch.
//      2a ist dabei bewusst zweiteilig: Node beendet einen Prozess mit unbehandeltem Wurf
//      ebenfalls mit Code 1, der Exit-Code allein waere am alten Stand also AUS DEM FALSCHEN
//      GRUND gruen. Verlangt wird zusaetzlich der Beleg, dass der Notfall-Flush gelaufen ist.
//   b) Sabotage des NEUEN Standes - takt() ohne sein try/catch: es fallen genau 1a bis 1g, und
//      zwar alle sieben. Das trennt das Netz von der blossen Sichtbarkeit: a) belegt, dass sich
//      etwas geaendert hat, b) belegt, dass es der Faenger IST.
//
// Die Notbremse in der Messvorrichtung (siehe j() weiter unten) ist Teil dieser Messung: Ohne sie
// brach der Lauf gegen den alten Stand nach drei Pruefungen ab, statt rot zu werden - ausgerechnet
// im Fehlerfall, den dieser Test misst, war er nicht messbar.
//
// PORT 3250: gemessen belegt sind 3187-3249 in beiden Repos
// (`grep -hoE "3[12][0-9][0-9]" tests/*.js | sort -un`) - ein neuer Test nimmt 3251.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3250);
const SERVER_JS = process.env.KEPLER_SERVER_JS || path.join(WURZEL, 'server.js');

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const hash = bcrypt.hashSync('test1234', 10);
const ADMIN = crypto.randomUUID();
const jetzt = Date.now();
const grunddb = () => ({
  users: { gamegeeeeek: { userId: ADMIN, username: 'GameGeeeeek', passwordHash: hash, createdAt: jetzt } },
  private: {}, shared: {}, resetTokens: {}, feedback: [],
  galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
    news: [], activeWar: null, activeWormhole: null, lastTick: jetzt, factions: {},
    alienPause: { kryll: jetzt + 9e8, xantheer: jetzt + 9e8, vex: jetzt + 9e8, verglueht: jetzt + 9e8 },
    alienNester: [] }
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-netz-'));
const dbPfad = path.join(tmpDir, 'db.json');
const kopien = [];
let srv = null;
function aufraeumen() {
  try { if (srv) srv.kill('SIGKILL'); } catch (e) {}
  for (const k of kopien) { try { fs.unlinkSync(k); } catch (e) {} }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', aufraeumen);

// Eine Kopie im REPO-Verzeichnis, mit angehaengtem Fehler. Der Name traegt "gegenprobe", damit
// eine liegengebliebene Datei sofort als Testartefakt erkennbar ist.
function kopieMitFehler(kennung, anhang) {
  const ziel = path.join(WURZEL, 'server_gegenprobe_' + kennung + '.js');
  fs.writeFileSync(ziel, fs.readFileSync(SERVER_JS, 'utf8') + '\n' + anhang + '\n');
  kopien.push(ziel);
  return ziel;
}

const basis = 'http://127.0.0.1:' + PORT + '/api';
async function starteServer(datei) {
  let log = '';
  srv = spawn(process.execPath, [datei], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, {
      DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret',
      JWT_SECRET_FILE: path.join(tmpDir, 'jwt.txt'),
      VAPID_PUBLIC_FILE: path.join(tmpDir, 'vapid-pub.txt'),
      VAPID_PRIVATE_FILE: path.join(tmpDir, 'vapid-priv.txt'),
      DEPLOY_ALARM_MAIL: ''           // kein Mailversand aus dem Test heraus
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
  let ende = null;
  srv.on('exit', code => { ende = code; });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(basis + '/health'); if (r.ok) break; } catch (e) {}
    if (ende !== null) break;
    await warte(250);
  }
  return { protokoll: () => log, exitCode: () => ende, lebtNoch: () => ende === null };
}
async function stoppeHart() { if (!srv) return; srv.kill('SIGKILL'); await warte(400); srv = null; }
// Notbremse in der MESSVORRICHTUNG, nicht nur im Pruefling (uebernommen aus dem AI-Core-Repo,
// Lektion 14): Ist der Server tot - und genau das ist der Fall, den dieser Test misst -, wirft
// jedes fetch. Ohne diesen Faenger BRICHT der Lauf an der ersten Abfrage AB, statt rot zu werden;
// die Gegenprobe gegen den alten Stand endete so nach drei von fuenfzehn Pruefungen, und die
// Prueflisten waren nicht mehr vergleichbar. Ein toter Server ergibt jetzt ein leeres Ergebnis,
// und die Pruefung faellt - sichtbar und an ihrem Platz in der Liste.
async function j(pfad, token) {
  try {
    const r = await fetch(basis + pfad, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    const t = await r.text();
    try { return { status: r.status, body: JSON.parse(t) }; } catch (e) { return { status: r.status, body: null, roh: t.slice(0, 200) }; }
  } catch (e) { return { status: 0, body: null, roh: 'nicht erreichbar: ' + e.message }; }
}
const health = async () => (await j('/health')).body || {};
async function anmelden() {
  try {
    const r = await fetch(basis + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'GameGeeeeek', password: 'test1234' }) });
    return ((await r.json()) || {}).token;
  } catch (e) { return null; }
}

(async () => {
  // ---- 1) Ein Takt wirft ------------------------------------------------------------------
  // GEGENPROBE (Sabotage des neuen Standes: takt() ohne try/catch) - dann fallen 1a bis 1g,
  // weil der Server schon am ersten Wurf stirbt. Gemessen, nicht geschaetzt.
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb()));
  const kaputt = kopieMitFehler('takt', [
    "setInterval(takt('testtakt', () => { throw new Error('absichtlicher Testfehler'); }), 250);",
    "setInterval(takt('testtakt-async', async () => { throw new Error('absichtliche Testablehnung'); }), 300);",
    "setTimeout(() => { Promise.reject(new Error('absichtlich unbehandelt')); }, 500);"
  ].join('\n'));
  let s = await starteServer(kaputt);
  await warte(1600);
  check('1a: der Server lebt, obwohl ein Takt bei jedem Durchlauf wirft', s.lebtNoch(), { exit: s.exitCode() });
  if (!s.lebtNoch()) { console.log(s.protokoll().slice(-1200)); }
  const h1 = await health();
  check('1b: /api/health zaehlt die gescheiterten Durchlaeufe', typeof h1.taktFehler === 'number' && h1.taktFehler >= 3, { taktFehler: h1.taktFehler });
  await warte(900);
  const h2 = await health();
  check('1c: der Takt laeuft WEITER - die Zahl steigt, ein kaputter Takt legt den Rest nicht still',
    typeof h2.taktFehler === 'number' && h2.taktFehler > h1.taktFehler, { vorher: h1.taktFehler, nachher: h2.taktFehler });
  const tok = await anmelden();
  const lage = (await j('/admin/systemstand', tok)).body || {};
  const jeTakt = (lage.laufzeit && lage.laufzeit.taktFehlerJeTakt) || {};
  check('1d: der werfende UND der ablehnende Takt stehen einzeln in der Lage',
    jeTakt['testtakt'] > 0 && jeTakt['testtakt-async'] > 0, jeTakt);
  check('1e: eine unbehandelte Zusage AUSSERHALB eines Takts ist ebenfalls gezaehlt - und beendet den Prozess nicht',
    jeTakt['unbehandelte-zusage'] > 0 && s.lebtNoch(), { zusagen: jeTakt['unbehandelte-zusage'], lebt: s.lebtNoch() });
  const letzte = (lage.laufzeit && lage.laufzeit.taktFehlerLetzte) || [];
  check('1f: die Lage nennt zu jedem Fehler Name, Zeit und Meldung - nicht nur eine Zahl',
    letzte.length > 0 && letzte[0].name && letzte[0].zeit > 0 && /absichtlich/.test(letzte[0].meldung || ''),
    letzte[0] && { name: letzte[0].name, meldung: String(letzte[0].meldung).slice(0, 60) });
  check('1g: ein aufgefangener Takt-Fehler wird NICHT als Absturz gemeldet',
    h2.letzterAbsturzMin === null, { letzterAbsturzMin: h2.letzterAbsturzMin });
  await stoppeHart();

  // ---- 2) Ein Wurf ausserhalb eines Takts ------------------------------------------------
  // GEGENPROBE gegen origin/master: 2a bis 2d fallen alle vier. Der Exit-Code ALLEIN waere dort
  // gruen (Node beendet mit 1) - deshalb verlangt 2a zusaetzlich den Beleg fuer den Notfall-Flush.
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb()));
  const absturz = kopieMitFehler('absturz',
    "setTimeout(() => { db.shared['test:notfall'] = 'nur im RAM'; throw new Error('absichtlicher Absturz'); }, 900);");
  s = await starteServer(absturz);
  check('2-vorab: der Server ist zunaechst hochgekommen', s.lebtNoch());
  for (let i = 0; i < 40 && s.lebtNoch(); i++) await warte(200);
  const log2 = s.protokoll();
  check('2a: der Prozess beendet sich mit 1 UND hat vorher die Datenbank geschrieben',
    s.exitCode() === 1 && /Notfall-Flush: db\.json geschrieben/.test(log2),
    { exit: s.exitCode(), flush: (log2.match(/Notfall-Flush: [^\n]*/) || [])[0] });
  let aufPlatte = {};
  try { aufPlatte = JSON.parse(fs.readFileSync(dbPfad, 'utf8')); } catch (e) { aufPlatte = { fehler: String(e.message) }; }
  check('2b: die nur im RAM stehende Aenderung liegt jetzt auf der Platte - genau das ging vorher verloren',
    aufPlatte.shared && aufPlatte.shared['test:notfall'] === 'nur im RAM', Object.keys(aufPlatte.shared || {}));
  check('2b2: und der Absturz selbst ist mitgeschrieben, samt Meldung',
    !!(aufPlatte.absturz && /absichtlicher Absturz/.test(aufPlatte.absturz.meldung || '')),
    aufPlatte.absturz && String(aufPlatte.absturz.meldung).slice(0, 70));
  srv = null;
  // Neustart auf DERSELBEN Datenbank - so wie Docker es tut.
  s = await starteServer(SERVER_JS);
  const h3 = await health();
  check('2c: nach dem Neustart nennt /api/health das Alter des letzten Absturzes',
    typeof h3.letzterAbsturzMin === 'number' && h3.letzterAbsturzMin >= 0, { letzterAbsturzMin: h3.letzterAbsturzMin });
  const tok2 = await anmelden();
  const lage2 = (await j('/admin/systemstand', tok2)).body || {};
  check('2d: die Lage nennt den Absturz mit seiner Meldung',
    /absichtlicher Absturz/.test(((lage2.laufzeit || {}).letzterAbsturz || {}).meldung || ''),
    ((lage2.laufzeit || {}).letzterAbsturz || {}).meldung);
  await stoppeHart();

  // ---- 3) Kein Fehler, keine Meldung -----------------------------------------------------
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb()));
  s = await starteServer(SERVER_JS);
  await warte(900);
  const h4 = await health();
  check('3a: ohne Fehler meldet nichts einen Fehler - der Zaehler zaehlt nicht einfach immer',
    h4.ok === true && h4.taktFehler === 0 && h4.letzterAbsturzMin === null,
    { ok: h4.ok, taktFehler: h4.taktFehler, letzterAbsturzMin: h4.letzterAbsturzMin });
  check('3b: und der Server laeuft nach dem Startlauf der Takte noch', s.lebtNoch());
  await stoppeHart();

  aufraeumen();
  console.log(fail ? '\nFAIL - mindestens eine Pruefung ist gefallen' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('Testlauf abgebrochen:', e); aufraeumen(); process.exit(1); });
