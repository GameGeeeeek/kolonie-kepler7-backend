// KI-Kampfberichte: die Selbstpruefung des Servers gegen AI Core (04.09.2026).
//
//   node tests/test_kampftext_selbstpruefung_http.js
//
// ANLASS: Die Etappe E1b hatte drei Vorbedingungen am Pi, alle als SSH-Befehle fuer Sascha:
// Adresse setzen, Schluessel setzen, Erreichbarkeit AUS DEM CONTAINER heraus messen. Der Server
// misst das jetzt selbst (beim Start und im Takt) und meldet es in /api/health unter `kampftext` -
// von aussen ohne Anmeldung lesbar. Dieser Test misst die Messung: gegen einen gefaelschten AI Core,
// der /health und /ai/embed so beantwortet wie der echte, einschliesslich der 401-Meldung mit der
// Zeichenzahl (AI-Core-Lektion 7: "fehlt" und "falsch" sind zwei Befunde).
//
// Port 3260 (Server) und 3261 (gefaelschter AI Core); belegt sind 3187 und 3195-3259, gemessen mit
// `grep -hoE "3[12][0-9][0-9]" tests/*.js | sort -un`. Erst 3258/3259 - die nahm #226 zeitgleich (Vorposten-
// Tests), gemerkt beim zweiten Messen nach dem Merge von master, genau der Fall der Hausregel.
//
// GEPRUEFT WIRD (vier Serverstaende, weil der Schluessel nur ueber die Umgebung wechselt):
//   A  alles richtig: erreichbar, Ollama online, Modell da, Schluessel passt, als Bearer an
//      /ai/embed, /health ohne Schluessel, NIE an /ai/chat, weder Adresse noch Schluessel in
//      /api/health, kein Takt-Fehler. Dann aendert sich die Welt unter dem laufenden Server:
//      Modell weg, AI Core weg, AI Core wieder da - und die Messung folgt (das ist der Takt).
//   B  falscher Schluessel: "falsch" mit der Zeichenzahl aus AI Cores Antwort; erreichbar bleibt ja.
//   C  fehlender Schluessel: "fehlt", 0 Zeichen - und es wird gar nicht erst gefragt.
//   D  AI Core nicht erreichbar: erreichbar nein mit Fehlercode, Ollama/Modell "nicht messbar"
//      (null, nicht false), Schluessel "ungeprueft" - und auch der Fehlercode nennt keine Adresse.
//
// GEGENPROBE (in beide Richtungen ausgefuehrt, 04.09.2026; Pruefnamen per diff verglichen, nicht
// gezaehlt - die Schlusszeile "FAIL - ..." zaehlt sonst mit):
//   * Am Stand vor der Selbstpruefung (origin/master, server.js ohne Block und Health-Feld) fallen
//     16: A1-A5, A9-A12, B1-B2, C1-C2, D1-D3. Gruen bleiben A6, A7, A8 und D4 - sie messen das
//     AUSBLEIBEN von etwas (kein /ai/chat, keine Adresse, kein Takt-Fehler), und Abwesenheit ist
//     auch ohne die Funktion wahr. Deshalb stehen sie nie allein, sondern neben A2-A5.
//   * Ohne die setInterval-Zeile (nur der Startlauf) fallen genau A9, A10, A11. A12 NICHT: Ein Stand,
//     der nie auf "weg" gekippt ist, meldet "zurueck" auch ohne Messung - A12 belegt nur zusammen
//     mit A10, dass die Messung folgt.
//   * Wird der Schluessel auch bei 0 Zeichen abgefragt (Zweig `!stand.schluessel.zeichen` entfernt),
//     fallen genau C1 und C2.
//   * Mit der rohen Node-Meldung statt kampftextFehlerKurz faellt genau D4: "connect ECONNREFUSED
//     127.0.0.1:3261" - live waere das die Adresse des M715q in einer oeffentlichen Antwort.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3260);
const AI_PORT = PORT + 1;

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const dbPfad = path.join(os.tmpdir(), 'kepler-selbstpruefung-' + process.pid + '.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-selbstpruefung-'));
let srv = null, aiSrv = null;
const sockets = new Set();

function aufraeumen() {
  try { if (srv) srv.kill('SIGKILL'); } catch (e) {}
  try { for (const s of sockets) s.destroy(); if (aiSrv) aiSrv.close(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', aufraeumen);

// --- der gefaelschte AI Core ----------------------------------------------------------------
// Antwortet wie der echte: /health ohne Schluessel, alles andere prueft den Schluessel VOR jeder
// weiteren Arbeit und nennt bei 401 die empfangene Zeichenzahl. `aufrufe` schreibt jeden Aufruf mit -
// daran haengt, dass die Pruefung /ai/embed nimmt und nie /ai/chat.
const fake = { schluessel: 'testschluessel', modelle: ['qwen3.5:4b', 'nomic-embed-text'], ollamaOnline: true, aufrufe: [] };
function starteFake() {
  return new Promise(resolve => {
    aiSrv = http.createServer((req, res) => {
      let roh = '';
      req.on('data', d => { roh += d; });
      req.on('end', () => {
        const auth = req.headers.authorization || '';
        fake.aufrufe.push({ methode: req.method, pfad: req.url, auth });
        const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (req.method === 'GET' && req.url === '/health') {
          return json(200, { ok: true, ollama_online: fake.ollamaOnline, model: 'qwen3.5:2b', vision_model: 'qwen3.5:2b', models: fake.modelle });
        }
        if (!auth) return json(401, { detail: "Kein API-Key mitgeschickt. Erwartet wird der Header 'Authorization: Bearer <API_KEY>'." });
        const wert = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (wert !== fake.schluessel) return json(401, { detail: 'Ungültiger API-Key (' + wert.length + ' Zeichen empfangen).' });
        if (req.method === 'POST' && req.url === '/ai/embed') return json(200, { embeddings: [[0.1, 0.2]], model: 'nomic-embed-text' });
        if (req.method === 'POST' && req.url === '/ai/chat') return json(200, { response: 'Dieser Aufruf darf nie passieren.' });
        json(404, { detail: 'Not Found' });
      });
    });
    aiSrv.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    aiSrv.listen(AI_PORT, '127.0.0.1', resolve);
  });
}
function stoppeFake() {
  return new Promise(resolve => {
    if (!aiSrv) return resolve();
    // Offene Keep-Alive-Verbindungen halten close() sonst auf - erst kappen, dann schliessen.
    for (const s of sockets) s.destroy();
    aiSrv.close(() => { aiSrv = null; resolve(); });
  });
}

// --- der Server -----------------------------------------------------------------------------
function grunddb() {
  return { users: {}, private: {}, shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {} } };
}

async function starteServer(umgebung) {
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb()));
  let log = '';
  srv = spawn(process.execPath, [path.join(WURZEL, 'server.js')], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, {
      DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret',
      JWT_SECRET_FILE: path.join(tmpDir, 'jwt.txt'),
      VAPID_PUBLIC_FILE: path.join(tmpDir, 'vapid-pub.txt'),
      VAPID_PRIVATE_FILE: path.join(tmpDir, 'vapid-priv.txt'),
      AI_CORE_URL: 'http://127.0.0.1:' + AI_PORT,
      // 1,5 s statt zehn Minuten: Abschnitt A misst, dass die Messung der Welt FOLGT.
      KAMPFTEXT_PRUEF_TAKT_MS: '1500'
    }, umgebung),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
  const basis = 'http://127.0.0.1:' + PORT + '/api';
  let oben = false;
  for (let i = 0; i < 80 && !oben; i++) {
    try { const r = await fetch(basis + '/health'); oben = r.ok; } catch (e) {}
    if (!oben) await warte(250);
  }
  if (!oben) throw new Error('Server kam nicht hoch:\n' + log.slice(-2000));
  const prozess = srv;
  return {
    health: async () => (await fetch(basis + '/health')).json(),
    // Wartet, bis das Feld `kampftext` die Bedingung erfuellt - oder gibt nach `ms` den letzten Stand
    // zurueck. Die Bedingung wird im check() noch einmal ausgewertet, nie das Warten allein.
    warteBis: async function (bedingung, ms) {
      const ende = Date.now() + (ms || 8000);
      let h = null;
      while (Date.now() < ende) {
        h = await (await fetch(basis + '/health')).json();
        if (h.kampftext && bedingung(h.kampftext)) return h;
        await warte(250);
      }
      return h;
    },
    log: () => log,
    stop: () => new Promise(resolve => {
      if (prozess.exitCode !== null) return resolve();
      const notbremse = setTimeout(() => { try { prozess.kill('SIGKILL'); } catch (e) {} }, 3000);
      prozess.on('exit', () => { clearTimeout(notbremse); srv = null; resolve(); });
      prozess.kill('SIGTERM');
    })
  };
}

(async () => {
  // ---------- A: alles richtig, und dann aendert sich die Welt ----------
  await starteFake();
  let api = await starteServer({ AI_CORE_API_KEY: 'testschluessel' });
  let h = await api.warteBis(k => k.gemessenVorSek !== null);
  let k = h.kampftext || {};
  check('A1: /api/health traegt `kampftext`, Schalter aus, Modell benannt',
    !!h.kampftext && k.aktiv === false && k.modell === 'qwen3.5:4b' && typeof k.gemessenVorSek === 'number', h.kampftext);
  check('A2: AI Core erreichbar, Ollama online, Modell vorhanden',
    !!k.aiCore && k.aiCore.erreichbar === true && k.aiCore.ollamaOnline === true && k.aiCore.modellVorhanden === true && k.aiCore.fehler === '', k.aiCore);
  check('A3: Schluessel passt, Laenge stimmt (14), kein Hinweis',
    !!k.schluessel && k.schluessel.befund === 'passt' && k.schluessel.zeichen === 14 && k.schluessel.hinweis === '', k.schluessel);
  const embed = fake.aufrufe.filter(a => a.pfad === '/ai/embed');
  check('A4: der Schluessel ging als Bearer an POST /ai/embed',
    embed.length >= 1 && embed.every(a => a.methode === 'POST' && a.auth === 'Bearer testschluessel'), embed);
  check('A5: /health wurde OHNE Schluessel gefragt',
    fake.aufrufe.some(a => a.methode === 'GET' && a.pfad === '/health' && a.auth === ''), fake.aufrufe.map(a => a.pfad));
  check('A6: NIE ein Aufruf an /ai/chat - die Pruefung erzeugt keinen Text',
    !fake.aufrufe.some(a => a.pfad === '/ai/chat'), fake.aufrufe.map(a => a.pfad));
  const text = JSON.stringify(h);
  check('A7: /api/health nennt weder Schluessel noch Adresse',
    text.indexOf('testschluessel') < 0 && text.indexOf('127.0.0.1') < 0 && text.indexOf(String(AI_PORT)) < 0);
  check('A8: die Pruefung hinterlaesst keinen Takt-Fehler', h.taktFehler === 0, { taktFehler: h.taktFehler });

  fake.modelle = ['qwen3.5:2b'];
  h = await api.warteBis(x => x.aiCore && x.aiCore.modellVorhanden === false);
  k = h.kampftext || {};
  check('A9: das Modell verschwindet - die naechste Messung sieht es (Takt)',
    !!k.aiCore && k.aiCore.erreichbar === true && k.aiCore.modellVorhanden === false, k.aiCore);

  await stoppeFake();
  h = await api.warteBis(x => x.aiCore && x.aiCore.erreichbar === false);
  k = h.kampftext || {};
  check('A10: AI Core faellt aus - erreichbar nein, mit Fehlercode',
    !!k.aiCore && k.aiCore.erreichbar === false && /ECONNREFUSED/.test(k.aiCore.fehler || ''), k.aiCore);
  check('A11: ... und der Schluessel gilt als ungeprueft, nicht als falsch',
    !!k.schluessel && k.schluessel.befund === 'ungeprueft' && k.schluessel.zeichen === 14, k.schluessel);

  fake.modelle = ['qwen3.5:4b', 'nomic-embed-text'];
  await starteFake();
  h = await api.warteBis(x => x.aiCore && x.aiCore.erreichbar === true);
  k = h.kampftext || {};
  check('A12: AI Core ist zurueck - erreichbar ja, Schluessel wieder passt',
    !!k.aiCore && k.aiCore.erreichbar === true && !!k.schluessel && k.schluessel.befund === 'passt', k);
  await api.stop();

  // ---------- B: falscher Schluessel ----------
  fake.aufrufe = [];
  api = await starteServer({ AI_CORE_API_KEY: 'falsch' });
  h = await api.warteBis(x => x.gemessenVorSek !== null);
  k = h.kampftext || {};
  check('B1: falscher Schluessel heisst "falsch", mit Laenge (6) und der Zeichenzahl aus AI Cores Antwort',
    !!k.schluessel && k.schluessel.befund === 'falsch' && k.schluessel.zeichen === 6 && /6 Zeichen/.test(k.schluessel.hinweis || ''), k.schluessel);
  check('B2: erreichbar bleibt trotzdem ja - zwei Fragen, zwei Antworten',
    !!k.aiCore && k.aiCore.erreichbar === true && k.aiCore.ollamaOnline === true, k.aiCore);
  await api.stop();

  // ---------- C: fehlender Schluessel ----------
  fake.aufrufe = [];
  api = await starteServer({ AI_CORE_API_KEY: '' });
  h = await api.warteBis(x => x.gemessenVorSek !== null);
  k = h.kampftext || {};
  check('C1: fehlender Schluessel heisst "fehlt", 0 Zeichen - nicht "falsch"',
    !!k.schluessel && k.schluessel.befund === 'fehlt' && k.schluessel.zeichen === 0, k.schluessel);
  check('C2: ohne Schluessel wird /ai/embed gar nicht erst gefragt',
    fake.aufrufe.some(a => a.pfad === '/health') && !fake.aufrufe.some(a => a.pfad === '/ai/embed'), fake.aufrufe.map(a => a.pfad));
  await api.stop();

  // ---------- D: AI Core nicht erreichbar ----------
  await stoppeFake();
  fake.aufrufe = [];
  api = await starteServer({ AI_CORE_API_KEY: 'testschluessel' });
  h = await api.warteBis(x => x.gemessenVorSek !== null);
  k = h.kampftext || {};
  check('D1: nicht erreichbar, mit Fehlercode',
    !!k.aiCore && k.aiCore.erreichbar === false && /ECONNREFUSED/.test(k.aiCore.fehler || ''), k.aiCore);
  check('D2: Ollama und Modell sind dann "nicht messbar" (null), nicht "nein" (false)',
    !!k.aiCore && k.aiCore.ollamaOnline === null && k.aiCore.modellVorhanden === null, k.aiCore);
  check('D3: der Schluessel ist "ungeprueft" - niemand konnte gefragt werden',
    !!k.schluessel && k.schluessel.befund === 'ungeprueft' && k.schluessel.zeichen === 14, k.schluessel);
  const textD = JSON.stringify(h.kampftext || {});
  check('D4: auch der Fehlercode nennt keine Adresse',
    textD.indexOf('127.0.0.1') < 0 && textD.indexOf(String(AI_PORT)) < 0, textD);
  await api.stop();

  console.log(fail ? '\nFAIL - mindestens eine Pruefung ist rot' : '\nAlle Pruefungen gruen');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('Testlauf abgebrochen:', e); process.exit(1); });
