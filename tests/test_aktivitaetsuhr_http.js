// Aktivitaets-Uhr und Reaktionszeit (28.08.2026, Auftrag Sascha: "da ist ein Spieler, der ist
// wirklich Tag und Nacht online - kann man nachvollziehen, ob da ein Bot dahintersteckt?").
//
// WAS VORHER GEMESSEN WURDE, weil es den ganzen Zuschnitt bestimmt hat:
//   Das Offline-Fenster ist 8 h (mit vollem Autonomiekern 14). Wer den Tab schliesst und 24 h
//   wegbleibt, verliert zehn Stunden Produktion; wer ihn offen laesst, verliert nichts, und der
//   Autosave schreibt dabei alle 10 Sekunden. "Immer online" ist damit das rational richtige
//   Verhalten und beweist nichts. Die Uhr zaehlt deshalb HANDLUNGEN, nicht Anwesenheit.
//
// DIE KERNMESSUNG IST 1a/1b ALS PAAR. Eine Bedienhandlung muss ein Bit setzen UND der Autosave
// darf keines setzen. Jede Haelfte allein ist wertlos: 1a waere auch bei einer Uhr gruen, die bei
// JEDER Anfrage tickt (also 24/7 anzeigt und nichts unterscheidet), 1b auch bei einer Uhr, die
// nie tickt. Erst zusammen messen sie die Regel.
//
// 1c misst die Annahme, an der die ganze Ausnahmeliste haengt: dass `req.path` in authMiddleware
// wirklich '/api/...' traegt und nicht '/...'. Waere sie falsch, griffe kein einziger Eintrag der
// Liste - 1b faellt dann zwar auch, aber 1c nennt den GRUND (Arbeitsregel 37).
//
// 2b ist die Wache gegen eine Pruefung, die aus dem falschen Grund gruen ist: Die Uhr faengt erst
// mit ihrer Auslieferung an zu schreiben. Ohne den Anfang bei der ersten aufgezeichneten Stunde
// zaehlte die Zeit davor als eine gewaltige Pause, und JEDES Konto saehe menschlich aus.
//
// 3a/3b als Paar: Die Reaktionszeit wird beim ERSTEN Schlag vermerkt und beim zweiten NICHT -
// danach misst die Differenz nur noch die Abklingzeit statt der Aufmerksamkeit.
//
// PORT 3236: gemessen belegt sind 3195-3200 und 3210-3235
// (`grep -hoE "3[12][0-9][0-9]" tests/*.js | sort -un`) - ein neuer Test nimmt 3237.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3236);

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ADMIN = crypto.randomUUID(), ANNA = crypto.randomUUID(), BEN = crypto.randomUUID();

function spielstand(id, name) {
  return {
    resources: { energie: 1e5, erz: 1e5, kristalle: 1e5, deuterium: 1e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {}, fleet: { missions: [] },
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  };
}
function grunddb() {
  const jetzt = Date.now();
  return {
    users: {
      gamegeeeeek: { userId: ADMIN, username: 'GameGeeeeek', passwordHash: hash, createdAt: jetzt },
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: jetzt - 5 * 86400000 },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: jetzt }
    },
    private: {
      [ADMIN]: { 'kepler7-save-v3': JSON.stringify(spielstand(ADMIN, 'GameGeeeeek')) },
      [ANNA]:  { 'kepler7-save-v3': JSON.stringify(spielstand(ANNA, 'anna')) },
      [BEN]:   { 'kepler7-save-v3': JSON.stringify(spielstand(BEN, 'ben')) }
    },
    shared: {}, resetTokens: {}, feedback: [],
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: jetzt, factions: {},
      // Alle vier Voelker pausiert - der galaxyTick legt sonst mitten in der Messung ein Nest an.
      alienPause: { kryll: jetzt + 9e8, xantheer: jetzt + 9e8, vex: jetzt + 9e8, verglueht: jetzt + 9e8 },
      alienNester: [] }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-aktivuhr-' + process.pid + '.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-aktivuhr-'));
let srv = null, s = null, tokAdmin = null, tokA = null, tokB = null;
function aufraeumen() {
  try { if (srv) srv.kill(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', aufraeumen);

async function starteServer() {
  let log = '';
  // KEPLER_SERVER_JS leitet auf eine sabotierte KOPIE um - so laufen die Gegenproben, ohne
  // das Original anzufassen (ein Edit daran macht jeden parallel laufenden Prueflauf
  // wertlos). Die Kopie MUSS im Repo-Verzeichnis liegen, damit require('./mailer') aufloest.
  srv = spawn(process.execPath, [process.env.KEPLER_SERVER_JS || path.join(WURZEL, 'server.js')], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, {
      DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret',
      JWT_SECRET_FILE: path.join(tmpDir, 'jwt.txt'),
      VAPID_PUBLIC_FILE: path.join(tmpDir, 'vapid-pub.txt'),
      VAPID_PRIVATE_FILE: path.join(tmpDir, 'vapid-priv.txt')
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
// Jede Aenderung an der DB-DATEI laeuft durch diesen Helfer: SIGTERM flusht die im Speicher
// gehaltene db darueber, eine Aenderung am laufenden Server waere also wieder weg.
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  s = await starteServer();
  tokAdmin = await s.anmelden('GameGeeeeek');
  tokA = await s.anmelden('anna');
  tokB = await s.anmelden('ben');
}
const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
// Die Stundenreihe eines Kontos direkt aus der DB - unabhaengig davon, ob die Admin-Route sie
// richtig ausgibt. Ein Anker von ausserhalb der geprueften Rechnung (Arbeitsregel 62).
function bitsAusDb(uid) {
  const u = Object.values(liesDb().users).find(x => x.userId === uid) || {};
  let n = 0;
  for (const m of Object.values(u.aktiv || {})) { let v = m; while (v) { n += v & 1; v >>>= 1; } }
  return n;
}

(async () => {
  schreibDb(grunddb());
  s = await starteServer();
  tokAdmin = await s.anmelden('GameGeeeeek');
  tokA = await s.anmelden('anna');
  tokB = await s.anmelden('ben');
  check('0-vorab: alle drei Konten angemeldet', !!tokAdmin && !!tokA && !!tokB,
    { admin: !!tokAdmin, anna: !!tokA, ben: !!tokB });
  if (!tokA) { console.log(s.protokoll().slice(-1500)); process.exit(1); }

  // ---- 1) Das PAAR: Handlung zaehlt, Autosave nicht -----------------------------------------
  // Ben ist das unberuehrte Gegenstueck: Er meldet sich an (das ist ein POST /api/login, aber
  // OHNE Token - authMiddleware laeuft dort gar nicht) und tut danach nur das, was jeder offene
  // Tab von selbst tut.
  await stoppeServer(); const d0 = liesDb(); s = await starteServer();
  tokAdmin = await s.anmelden('GameGeeeeek'); tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  const vorherA = bitsAusDb(ANNA), vorherB = bitsAusDb(BEN);

  // Anna handelt: ein Feedback abschicken ist eine Bedienhandlung wie jede andere.
  const handlung = await s.j('/feedback', { method: 'POST', headers: kopf(tokA),
    body: JSON.stringify({ type: 'idee', text: 'Eine Idee, die als Handlung zaehlt.', version: '8.619.0' }) });
  // Ben speichert nur - genau das, was der Autosave alle 10 Sekunden tut.
  const save = await s.j('/storage/kepler7-save-v3', { method: 'PUT', headers: kopf(tokB),
    body: JSON.stringify({ value: JSON.stringify(spielstand(BEN, 'ben')) }) });
  await warte(300);
  await stoppeServer();

  check('1-vorab: beide Anfragen kamen durch', handlung.status < 400 && save.status < 400,
    { handlung: handlung.status, save: save.status });
  const nachA = bitsAusDb(ANNA), nachB = bitsAusDb(BEN);
  check('1a: eine Bedienhandlung setzt ein Bit', nachA > vorherA, { vorher: vorherA, nach: nachA });
  check('1b: der Autosave setzt KEINS', nachB === vorherB, { vorher: vorherB, nach: nachB });

  const quelle = fs.readFileSync(process.env.KEPLER_SERVER_JS || path.join(WURZEL, 'server.js'), 'utf8');
  // 1c: die Annahme, an der die Ausnahmeliste haengt. Faellt sie, greift kein einziger Eintrag.
  const listeBlock = (quelle.match(/const AKTIV_AUSNAHMEN = \[[\s\S]*?\n\];/) || [''])[0];
  check('1c: die Ausnahmeliste vergleicht auf /api/-Pfade',
    listeBlock.indexOf("'/api/storage/'") > 0 && listeBlock.indexOf("'/api/pending-rewards/claim'") > 0,
    { gefunden: (listeBlock.match(/'\/api\/[a-z/-]+'/g) || []) });
  check('1c2: jeder Eintrag traegt seinen gemessenen Grund',
    (listeBlock.match(/grund:/g) || []).length === (listeBlock.match(/pfad:|start:/g) || []).length &&
    (listeBlock.match(/grund:/g) || []).length >= 3,
    { gruende: (listeBlock.match(/grund:/g) || []).length,
      eintraege: (listeBlock.match(/pfad:|start:/g) || []).length });

  s = await starteServer();
  tokAdmin = await s.anmelden('GameGeeeeek'); tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');

  // ---- 2) Die Auswertung ---------------------------------------------------------------------
  // Ein Muster von Hand legen: 14 Tage, taeglich Stunde 8-22 aktiv, also 9 h Pause je Nacht.
  await aendereDb(d => {
    const u = d.users.anna;
    u.aktiv = {};
    for (let t = 0; t <= 14; t++) {   // 15 Kalendertage - siehe die Begruendung bei 2c
      const k = new Date(Date.now() - t * 86400000).toISOString().slice(0, 10);
      let m = 0;
      for (let h = 8; h <= 22; h++) m |= (1 << h);
      u.aktiv[k] = m;
    }
  });
  const blatt = await s.j('/admin/konto?name=anna', { headers: kopf(tokAdmin) });
  const kA = ((blatt.body || {}).konten || []).find(x => x.username === 'anna') || {};
  check('2-vorab: das Konto-Blatt traegt die Uhr', !!(kA.aktiv && typeof kA.aktiv.reihe === 'string'),
    { hat: Object.keys(kA.aktiv || {}) });
  check('2a: die Reihe ist 14 Tage lang', (kA.aktiv || {}).reihe && kA.aktiv.reihe.length === 14 * 24,
    { laenge: (kA.aktiv || {}).reihe && kA.aktiv.reihe.length });
  // 9 h Pause je Nacht (23,0..7 UTC) - die Auswertung muss ueber die Tagesgrenze hinweg zaehlen,
  // nicht je Tag einzeln. Genau das unterscheidet eine Stundenreihe von 14 Einzelbildern.
  check('2a2: die laengste Pause geht ueber die Tagesgrenze', (kA.aktiv || {}).laengstePause === 9,
    { laengstePause: (kA.aktiv || {}).laengstePause });
  check('2a3: sie gilt als belastbar', (kA.aktiv || {}).belastbar === true,
    { beobachtet: (kA.aktiv || {}).beobachtet });

  // 2b: zu wenig Daten -> die Aussage traegt NICHT, und das sagt das Feld.
  await aendereDb(d => { d.users.ben.aktiv = {}; d.users.ben.aktiv[new Date().toISOString().slice(0,10)] =
    (1 << new Date().getUTCHours()); });
  const blattB = await s.j('/admin/konto?name=ben', { headers: kopf(tokAdmin) });
  const kB = ((blattB.body || {}).konten || []).find(x => x.username === 'ben') || {};
  check('2b: eine einzelne Stunde gilt NICHT als belastbar', (kB.aktiv || {}).belastbar === false,
    { beobachtet: (kB.aktiv || {}).beobachtet, belastbar: (kB.aktiv || {}).belastbar });
  check('2b2: und die Pause davor zaehlt nicht mit', (kB.aktiv || {}).laengstePause === 0,
    { laengstePause: (kB.aktiv || {}).laengstePause });

  // 2c: der Dauerlaeufer - 14 Tage lueckenlos.
  // FUENFZEHN Kalendertage, nicht vierzehn: Die Reihe geht 14*24 Stunden zurueck und beginnt
  // damit MITTEN im fuenfzehnten Tag. Der erste Anlauf setzte 14 und mass 333 statt 336 aktive
  // Stunden - ein Fixture-Fehler, der wie ein Rechenfehler in der Auswertung aussah.
  await aendereDb(d => {
    const u = d.users.ben; u.aktiv = {};
    for (let t = 0; t <= 14; t++) {
      const k = new Date(Date.now() - t * 86400000).toISOString().slice(0, 10);
      u.aktiv[k] = 0xFFFFFF;
    }
  });
  const blattB2 = await s.j('/admin/konto?name=ben', { headers: kopf(tokAdmin) });
  const kB2 = ((blattB2.body || {}).konten || []).find(x => x.username === 'ben') || {};
  /* Geprueft wird die REGEL, nicht die Zahl: JEDE beobachtete Stunde ist aktiv. Der erste Anlauf
     verlangte 14*24 und fiel mit 333 durch - voellig richtig, denn die Reihe deckt volle
     Kalendertage ab, und die Stunden des heutigen Tages nach der aktuellen sind noch gar nicht
     beobachtet ('-'). Eine feste Zahl haette hier je nach Uhrzeit ein anderes Ergebnis (Regel 3). */
  check('2c: ein lueckenloses Konto hat Pause 0 und keine ruhige Stunde',
    (kB2.aktiv || {}).laengstePause === 0 && (kB2.aktiv || {}).aktiv === (kB2.aktiv || {}).beobachtet &&
    (kB2.aktiv || {}).beobachtet > 300,
    { laengstePause: (kB2.aktiv || {}).laengstePause, aktiv: (kB2.aktiv || {}).aktiv,
      beobachtet: (kB2.aktiv || {}).beobachtet });
  // Die dritte Zeichenart ist der Grund, warum 2c ueberhaupt so formuliert ist - ohne sie zaehlte
  // die Zukunft als Pause, und ein lueckenloses Konto saehe nachts wie ein schlafender Mensch aus.
  check('2c2: die noch nicht beobachteten Stunden sind als solche markiert',
    ((kB2.aktiv || {}).reihe || '').indexOf('-') > 0 &&
    ((kB2.aktiv || {}).reihe || '').replace(/-/g, '').indexOf('0') < 0,
    { schluss: ((kB2.aktiv || {}).reihe || '').slice(-30) });

  // ---- 3) Reaktionszeit an einer echten Festung ----------------------------------------------
  const f0 = await s.j('/asteroid/field', { headers: kopf(tokA) });
  const sys = ((f0.body || {}).systeme || [])[0];
  check('3-vorab: ein Guertelsystem steht bereit', !!sys, { status: f0.status, sys });

  const FEST_ID = crypto.randomUUID();
  const ENTSTANDEN_VOR_SEK = 3600;   // die Festung steht seit einer Stunde
  await aendereDb(d => {
    const feldKey = 'asteroids:' + sys;
    const feld = d.shared[feldKey];
    let platz = null;
    for (let i = 0; i < 10; i++) { const q = feld.plaetze[String(i)]; if (!q || q.frei) { platz = String(i); break; } }
    if (platz === null) { platz = '0'; delete feld.plaetze['0']; }
    feld.festung = { id: FEST_ID, stufe: 'sternenfeste', platz, sorte: 'eisen',
      kernMax: 1200000, kern: 1200000, hort: 500000, hortProto: 400,
      seit: Date.now() - ENTSTANDEN_VOR_SEK * 1000, letzteReifung: Date.now(), beitraege: {} };
    d.shared[feldKey] = feld;
    for (const [uid, mid] of [[ANNA, 'm-anna-1'], [ANNA, 'm-anna-2']]) {
      const sv = JSON.parse(d.private[uid]['kepler7-save-v3']);
      sv.fleet.missions = (sv.fleet.missions || []).concat([{ id: mid, type: 'festung-angriff',
        targetId: sys, endTime: Date.now() - 1000,
        composition: { cruisers: 300, destroyers: 200, bomber: 120, schlachtschiff: 80 } }]);
      d.private[uid]['kepler7-save-v3'] = JSON.stringify(sv);
    }
  });
  const schlag1 = await s.j('/festung/angriff', { method: 'POST', headers: kopf(tokA),
    body: JSON.stringify({ system: sys, missionId: 'm-anna-1', festungId: FEST_ID }) });
  check('3-vorab2: der erste Schlag kommt an', schlag1.status === 200,
    { status: schlag1.status, body: schlag1.body });
  await warte(300);
  const rA = (Object.values(liesDb().users).find(x => x.userId === ANNA) || {}).reaktionen || [];
  check('3a: der erste Schlag vermerkt eine Reaktionszeit', rA.length === 1 && rA[0].art === 'festung',
    { reaktionen: rA });
  // Der Wert muss die GEMESSENE Zeit seit dem Entstehen sein, nicht irgendeine Zahl. Anker ist
  // der Fixture-Wert, der ausserhalb der geprueften Rechnung liegt (Arbeitsregel 62).
  check('3a2: und zwar die Zeit seit dem Entstehen',
    rA.length === 1 && Math.abs(rA[0].sek - ENTSTANDEN_VOR_SEK) < 30,
    { gemessen: rA.length ? rA[0].sek : null, erwartet: ENTSTANDEN_VOR_SEK });

  /* 3b: der zweite Schlag darf KEINE zweite Reaktionszeit vermerken.

     Der erste Anlauf hat dafuer `festung.schlaege` GELEERT, um die Abklingzeit zu umgehen - und
     damit die gepruefte Bedingung selbst zerstoert: Ohne Stempel ist `letzter` wieder 0, also war
     es aus Sicht des Servers voellig korrekt ein erster Schlag. Der Test fiel auf richtigem Code
     durch. Der Stempel wird deshalb ZURUECKDATIERT statt entfernt - Abklingzeit abgelaufen,
     `letzter` trotzdem gesetzt. Das ist genau die Lage, die im Spiel entsteht. */
  await aendereDb(d => {
    const feld = d.shared['asteroids:' + sys];
    if (feld && feld.festung && feld.festung.schlaege) {
      for (const uid of Object.keys(feld.festung.schlaege)) {
        feld.festung.schlaege[uid] = Date.now() - 7 * 3600000;
      }
    }
  });
  check('3-vorab2b: der Stempel steht noch, nur zurueckdatiert',
    Object.keys(((liesDb().shared['asteroids:' + sys] || {}).festung || {}).schlaege || {}).length > 0,
    { schlaege: ((liesDb().shared['asteroids:' + sys] || {}).festung || {}).schlaege });
  const schlag2 = await s.j('/festung/angriff', { method: 'POST', headers: kopf(tokA),
    body: JSON.stringify({ system: sys, missionId: 'm-anna-2', festungId: FEST_ID }) });
  check('3-vorab3: der zweite Schlag kommt ebenfalls an', schlag2.status === 200,
    { status: schlag2.status, body: schlag2.body });
  await warte(300);
  const rA2 = (Object.values(liesDb().users).find(x => x.userId === ANNA) || {}).reaktionen || [];
  check('3b: der zweite Schlag vermerkt KEINE zweite', rA2.length === 1, { reaktionen: rA2 });

  // ---- 4) Das Konto-Blatt reicht beides durch ------------------------------------------------
  const blatt2 = await s.j('/admin/konto?name=anna', { headers: kopf(tokAdmin) });
  const kA2 = ((blatt2.body || {}).konten || []).find(x => x.username === 'anna') || {};
  check('4a: das Blatt traegt die Reaktionszeiten', Array.isArray(kA2.reaktionen) && kA2.reaktionen.length === 1,
    { reaktionen: kA2.reaktionen });
  check('4b: es gibt weiterhin keine Klartext-Adresse und keinen Hash',
    JSON.stringify(blatt2.body).indexOf('passwordHash') < 0 && JSON.stringify(blatt2.body).indexOf('@example.org') < 0);
  const ohneAdmin = await s.j('/admin/konto?name=anna', { headers: kopf(tokA) });
  check('4c: ohne Admin-Recht kein Blatt', ohneAdmin.status === 403, { status: ohneAdmin.status });

  // ---- 5) Die Uhr raeumt auf ------------------------------------------------------------------
  await aendereDb(d => {
    const u = d.users.anna;
    u.aktiv = u.aktiv || {};
    u.aktiv[new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10)] = 0xFFFFFF;
  });
  const alterTag = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  check('5-vorab: der alte Tag steht in der DB',
    !!(Object.values(liesDb().users).find(x => x.userId === ANNA).aktiv || {})[alterTag]);
  await s.j('/feedback', { method: 'POST', headers: kopf(tokA),
    body: JSON.stringify({ type: 'idee', text: 'Eine weitere Idee zum Aufraeumen.', version: '8.619.0' }) });
  await warte(300);
  const nachAufraeumen = (Object.values(liesDb().users).find(x => x.userId === ANNA) || {}).aktiv || {};
  check('5a: ein Tag jenseits des Fensters wird beim naechsten Schreiben entfernt',
    nachAufraeumen[alterTag] === undefined, { tage: Object.keys(nachAufraeumen).length });

  await stoppeServer();
  console.log('');
  console.log(fail ? 'FAIL - es gab rote Pruefungen.' : 'Alles gruen.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FEHLER: ' + (e && e.stack || e)); process.exit(1); });
