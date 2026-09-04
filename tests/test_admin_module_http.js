// Modul-Verwaltung im Admin-Bereich (04.09.2026, Idee Sascha "Module-Editor"): stellbare
// Drop-Chancen an den serverseitigen Vergabestellen und eigene Modul-Eintraege.
//
// KERNMESSUNG, und der Grund fuer den ganzen Aufbau mit echtem Konvoi-Angriff:
//   1c/1d  Chance 0 laesst KEIN Modul fallen UND Chance 1 laesst beide fallen - gemessen an der
//          ECHTEN Vergabestelle, nicht an der Anzeige. Ein Regler, der nur die Abfrage aendert,
//          waere eine Anzeige ohne Wirkung, und genau das faellt sonst niemandem auf.
//
// WEITERE PAARE (Arbeitsregel 61):
//   1e/1f  Zuruecknehmen loescht den Ueberschreibwert UND friert den Code-Wert NICHT ein
//          (sonst bliebe eine spaetere Balance-Aenderung im Code wirkungslos)
//   2a/2b  ein eigenes Modul wird angelegt UND traegt in JEDER Antwort wirkung:'keine'
//   2c     ein Schluessel ohne 'eigen_' wird abgelehnt - die Sperre, die eine Kollision mit einem
//          der 99 Code-Module bauartbedingt unmoeglich macht
//
// GEGENPROBEN (sabotierte Kopien ueber KEPLER_SERVER_JS, gemessen 04.09.2026 - alle sechs treffen,
// 0 Werkzeugfehler; links die Sabotage, rechts die Pruefung, die sie fallen laesst):
//   Die Vergabestelle liest die Konstante statt des Reglers      -> 1d (und 1c)
//   Zuruecknehmen friert den Code-Wert ein                       -> 1f
//   Der Wertebereich wird nicht geprueft                         -> 1b
//   Die Schluessel-Sperre 'eigen_' faellt weg                    -> 2c (und der halbe Abschnitt 2)
//   wirkung:'keine' reist nicht mit                              -> 2b
//   Derselbe Schluessel legt einen ZWEITEN Eintrag an            -> 2e
// Die erste ist die wichtigste: Sie stellt genau den Zustand her, den es VOR dieser Aenderung gab -
// eine Konstante ohne Regler - und 1c/1d fallen. Ohne diese Messung waere der Regler eine Anzeige.
//
// PORT 3257. Gemessen gegen frisch geholtes origin/master (zweite Messung unmittelbar vor dem Push,
// siehe die Begruendung im Kopf von test_admin_konto2_http.js): belegt sind 3195-3256.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3257);

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ADMIN = crypto.randomUUID(), ANNA = crypto.randomUUID();

const MISSION = 'm-konvoi-1';
const ZIEL = 'ziel-konvoi-1';
// Eine Flotte mit Kampfkraft und eine bereits ANGEKOMMENE Mission (endTime in der Vergangenheit) -
// so ist der Schlag ohne Warten ausloesbar. composition ist die eingefrorene Zusammensetzung, aus
// der der Server die Kraft rechnet; er nimmt keinen Kampfparameter aus dem Request.
function spielstand(id, name) {
  return {
    resources: { energie: 1e5, erz: 1e5, kristalle: 1e5, deuterium: 1e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: { mine: 7 }, research: {}, colonies: {},
    fleet: { jaeger: 500, cruisers: 100, missions: [
      { id: MISSION, type: 'konvoi-angriff', zielId: ZIEL, endTime: Date.now() - 60000,
        composition: { jaeger: 500, cruisers: 100 } }
    ] },
    player: { id, name }, credits: 5000, xp: 1000, prestige: 0, battlePoints: 10, lastTick: Date.now()
  };
}
// Der Konvoi hat absichtlich WENIGE Lebenspunkte: Ein Schlag faellt ihn, der Schadensanteil des
// einzigen Angreifers ist damit 1, und die Fallchance ist unverfaelscht die eingestellte.
function konvoi(jetzt) {
  return { id: ZIEL, sys: 'sys_test', lp: 1, lpMax: 1, seit: jetzt - 60000,
    naechsteWanderung: jetzt + 9e8, beitraege: {}, schlaege: {},
    beute: { essenz: 4, kampfpunkte: 20, xp: 150, credits: 600, modulChance: 0.3 } };
}
function grunddb() {
  const jetzt = Date.now();
  return {
    users: {
      gamegeeeeek: { userId: ADMIN, username: 'GameGeeeeek', passwordHash: hash, createdAt: jetzt },
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: jetzt }
    },
    private: {
      [ADMIN]: { 'kepler7-save-v3': JSON.stringify(spielstand(ADMIN, 'GameGeeeeek')) },
      [ANNA]:  { 'kepler7-save-v3': JSON.stringify(spielstand(ANNA, 'anna')) }
    },
    shared: {}, resetTokens: {}, feedback: [],
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: jetzt, factions: {},
      alienPause: { kryll: jetzt + 9e8, xantheer: jetzt + 9e8, vex: jetzt + 9e8, verglueht: jetzt + 9e8 },
      alienNester: [], wrackKonvois: [konvoi(jetzt)] }
  };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-modul-'));
const dbPfad = path.join(tmpDir, 'db.json');
let srv = null, s = null, tok = {};
function aufraeumen() {
  try { if (srv) srv.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', aufraeumen);

async function starteServer() {
  let log = '';
  srv = spawn(process.execPath, [process.env.KEPLER_SERVER_JS || path.join(WURZEL, 'server.js')], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, {
      DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret', PUBLIC_URL: 'https://test.example',
      JWT_SECRET_FILE: path.join(tmpDir, 'jwt.txt'),
      VAPID_PUBLIC_FILE: path.join(tmpDir, 'vapid-pub.txt'),
      VAPID_PRIVATE_FILE: path.join(tmpDir, 'vapid-priv.txt'),
      RESEND_API_KEY: ''
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
  const basis = 'http://127.0.0.1:' + PORT + '/api';
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(basis + '/health'); if (r.ok) break; } catch (e) {}
    await warte(250);
  }
  await warte(400);
  async function j(pfad, opt) {
    const r = await fetch(basis + pfad, opt);
    const t = await r.text();
    try { return { status: r.status, body: JSON.parse(t) }; }
    catch (e) { return { status: r.status, body: t.slice(0, 300) }; }
  }
  async function anmelden(name) {
    const r = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name, password: 'test1234' }) });
    return { token: r.body && r.body.token, status: r.status, error: r.body && r.body.error };
  }
  return { j, anmelden, protokoll: () => log };
}
async function alleAnmelden() { tok = {}; for (const n of ['GameGeeeeek', 'anna']) tok[n] = (await s.anmelden(n)).token; }
async function stoppeServer() { if (!srv) return; srv.kill('SIGTERM'); await warte(700); srv = null; }
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
async function aendereDb(fn) { await stoppeServer(); const d = liesDb(); await fn(d); schreibDb(d); s = await starteServer(); await alleAnmelden(); }
const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
const admin = (pfad, body) => s.j(pfad, { method: 'POST', headers: kopf(tok.GameGeeeeek), body: JSON.stringify(body || {}) });
const holen = pfad => s.j(pfad, { headers: kopf(tok.GameGeeeeek) });
const protokoll = async () => ((await holen('/admin/protokoll')).body || {}).eintraege || [];

/* EIN Konvoi-Schlag als Spieler anna, danach das Belohnungsfach leeren und zaehlen, welche der
   beiden Modul-Belohnungen dabei waren. Der Konvoi wird vor jedem Lauf frisch gesetzt (er ist beim
   Fall aus der Galaxie verschwunden) und der Spielstand mit ihm - eine Messung, ein frisches Ziel. */
async function konvoiSchlagUndBeute() {
  await aendereDb(d => {
    d.galaxy.wrackKonvois = [konvoi(Date.now())];
    d.private[ANNA]['kepler7-save-v3'] = JSON.stringify(spielstand(ANNA, 'anna'));
    d.private[ANNA].__pendingRewards = [];
  });
  const r = await s.j('/konvoi/angriff', { method: 'POST', headers: kopf(tok.anna),
    body: JSON.stringify({ zielId: ZIEL, missionId: MISSION }) });
  const faecher = [];
  for (let i = 0; i < 6; i++) {
    const f = (await s.j('/pending-rewards/claim', { method: 'POST', headers: kopf(tok.anna), body: '{}' })).body || {};
    if (!f.reward) break;
    faecher.push(f.reward);
  }
  return { angriff: r, module: faecher.filter(x => x && (x.modul || x.kampfmodul)).length,
    standort: faecher.filter(x => x && x.modul).length, schiff: faecher.filter(x => x && x.kampfmodul).length,
    gefallen: r.body && r.body.gefallen, status: r.status };
}

(async () => {
  schreibDb(grunddb());
  s = await starteServer();
  await alleAnmelden();
  check('0-vorab: beide Konten angemeldet', !!tok.GameGeeeeek && !!tok.anna);
  if (!tok.anna) { console.log(s.protokoll().slice(-1500)); process.exit(1); }

  // ---- 1) Stellbare Drop-Chancen -------------------------------------------------------------------
  const m0 = await holen('/admin/module');
  const q0 = (m0.body.quellen || []);
  check('1a: die Abfrage nennt die serverseitigen Quellen mit Basiswert und aktuellem Wert',
    m0.status === 200 && q0.length === 2 && q0.every(q => q.basis === 0.3 && q.aktuell === 0.3 && q.gestellt === false)
    && q0.map(q => q.quelle).sort().join(',') === 'konvoi_schiff,konvoi_standort',
    { quellen: q0 });
  check('1a2: sie sagt ausdruecklich, dass der Server nur diese Module vergibt',
    /nur diese Module/.test(m0.body.hinweisQuellen || ''), { hinweis: m0.body.hinweisQuellen });
  const b1 = await admin('/admin/module/chance', { quelle: 'konvoi_standort', wert: 1.5 });
  const b2 = await admin('/admin/module/chance', { quelle: 'konvoi_standort', wert: -0.1 });
  const b3 = await admin('/admin/module/chance', { quelle: 'gibtsnicht', wert: 0.5 });
  check('1b: Werte ausserhalb 0..1 und unbekannte Quellen werden je mit Grund abgelehnt',
    b1.status === 400 && b2.status === 400 && b3.status === 400 && /zwischen 0 und 1/.test(b1.body.error || '')
    && /Unbekannte Quelle/.test(b3.body.error || ''), { status: [b1.status, b2.status, b3.status] });

  // Die Kernmessung: Chance 0 an der ECHTEN Vergabestelle.
  await admin('/admin/module/chance', { quelle: 'konvoi_standort', wert: 0 });
  await admin('/admin/module/chance', { quelle: 'konvoi_schiff', wert: 0 });
  const null0 = await konvoiSchlagUndBeute();
  check('1c: bei Chance 0 faellt der Konvoi, aber KEIN Modul',
    null0.status === 200 && null0.gefallen === true && null0.module === 0,
    { status: null0.status, gefallen: null0.gefallen, module: null0.module });
  await admin('/admin/module/chance', { quelle: 'konvoi_standort', wert: 1 });
  await admin('/admin/module/chance', { quelle: 'konvoi_schiff', wert: 1 });
  const eins = await konvoiSchlagUndBeute();
  check('1d: bei Chance 1 fallen BEIDE Module - der Regler wirkt an der Vergabestelle (PAAR zu 1c)',
    eins.gefallen === true && eins.standort === 1 && eins.schiff === 1,
    { standort: eins.standort, schiff: eins.schiff, gefallen: eins.gefallen });

  const zurueck = await admin('/admin/module/chance', { quelle: 'konvoi_standort', wert: null });
  const m1 = await holen('/admin/module');
  const qStandort = (m1.body.quellen || []).find(q => q.quelle === 'konvoi_standort') || {};
  check('1e: Zuruecknehmen setzt auf den Code-Wert zurueck',
    zurueck.status === 200 && zurueck.body.zurueckgesetzt === true && qStandort.aktuell === 0.3, { quelle: qStandort });
  check('1f: und es FRIERT den Code-Wert nicht ein - der Ueberschreibwert ist wirklich weg (PAAR zu 1e)',
    qStandort.gestellt === false && (liesDb().modulChancen || {}).konvoi_standort === undefined,
    { gestellt: qStandort.gestellt, inDb: (liesDb().modulChancen || {}).konvoi_standort });
  const nichtAdmin = await s.j('/admin/module', { headers: kopf(tok.anna) });
  check('1g: ein Nicht-Admin kommt nicht an die Modul-Verwaltung', nichtAdmin.status === 403, { status: nichtAdmin.status });

  // ---- 2) Eigene Module ----------------------------------------------------------------------------
  const e2a = await admin('/admin/module/eigen', { key: 'waffen', name: 'Kaperung', beschreibung: 'Ein Testmodul mit Text.' });
  const e2b = await admin('/admin/module/eigen', { key: 'eigen_x', name: 'Kaperung', beschreibung: 'Ein Testmodul mit Text.' });
  check('2c: ein Schluessel ohne "eigen_" wird abgelehnt - eine Kollision mit einem Code-Modul ist damit unmoeglich',
    e2a.status === 400 && /eigen_/.test(e2a.body.error || '') && e2b.status === 400,
    { ohnePrefix: e2a.status, zuKurz: e2b.status });
  const e2c = await admin('/admin/module/eigen', { key: 'eigen_kaperhaken', name: 'Ka', beschreibung: 'Ein Testmodul mit Text.' });
  const e2d = await admin('/admin/module/eigen', { key: 'eigen_kaperhaken', name: 'Kaperhaken', beschreibung: 'kurz' });
  check('2d: Name und Beschreibung haben Mindestlaengen, beide mit Grund',
    e2c.status === 400 && /Namen/.test(e2c.body.error || '') && e2d.status === 400 && /Beschreibung/.test(e2d.body.error || ''),
    { name: e2c.body.error, text: e2d.body.error });
  const e2 = await admin('/admin/module/eigen', { key: 'eigen_kaperhaken', name: 'Kaperhaken',
    beschreibung: 'Zieht gegnerische Frachter heran.', icon: 'ti-anchor', art: 'schiff', seltenheit: 'episch', notiz: 'Entwurf' });
  check('2a: ein eigenes Modul wird angelegt und kommt mit allen Feldern zurueck',
    e2.status === 200 && e2.body.modul.key === 'eigen_kaperhaken' && e2.body.modul.art === 'schiff'
    && e2.body.modul.icon === 'ti-anchor' && e2.body.ersetzt === false && e2.body.anzahl === 1,
    { modul: e2.body.modul });
  const m2 = await holen('/admin/module');
  check('2b: es traegt in JEDER Antwort wirkung:"keine" - Anlegen und Liste (PAAR zu 2a)',
    e2.body.modul.wirkung === 'keine' && (m2.body.eigene || []).length === 1 && m2.body.eigene[0].wirkung === 'keine',
    { anlegen: e2.body.modul.wirkung, liste: (m2.body.eigene || [])[0] });
  const e2e = await admin('/admin/module/eigen', { key: 'eigen_kaperhaken', name: 'Kaperhaken II',
    beschreibung: 'Zieht gegnerische Frachter heran, jetzt staerker.' });
  const m2b = await holen('/admin/module');
  check('2e: derselbe Schluessel ERSETZT den Eintrag, statt ihn zu verdoppeln',
    e2e.body.ersetzt === true && e2e.body.anzahl === 1 && (m2b.body.eigene || []).length === 1
    && m2b.body.eigene[0].name === 'Kaperhaken II', { anzahl: (m2b.body.eigene || []).length });
  const w2 = await admin('/admin/module/eigen/loeschen', { key: 'gibtsnicht' });
  const w2b = await admin('/admin/module/eigen/loeschen', { key: 'eigen_kaperhaken' });
  check('2f: Loeschen entfernt den Eintrag, ein unbekannter Schluessel ergibt 404 statt eines stillen ok',
    w2.status === 404 && w2b.status === 200 && ((await holen('/admin/module')).body.eigene || []).length === 0,
    { unbekannt: w2.status, geloescht: w2b.status });

  // ---- 3) Protokoll --------------------------------------------------------------------------------
  const p3 = await protokoll();
  const arten = p3.map(e => e.art);
  check('3a: die Eingriffe stehen im Protokoll', arten.includes('module/chance') && arten.includes('module/eigen')
    && arten.includes('module/eigen/loeschen'), { arten: arten.slice(0, 8) });
  check('3b: die abgelehnten Versuche stehen NICHT drin (die Middleware haelt nur Statthabendes fest)',
    arten.filter(a => a === 'module/eigen').length === 2, { anzahl: arten.filter(a => a === 'module/eigen').length });

  await stoppeServer();
  console.log(fail ? 'FAIL - es gab rote Pruefungen.' : 'Alles gruen.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAIL - Testlauf abgebrochen: ' + (e && e.stack || e)); process.exit(1); });
