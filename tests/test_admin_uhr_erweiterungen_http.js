// Vier Erweiterungen der Aktivitaets-Uhr (28.08.2026, Auftrag Sascha "Funktionen weiter
// ausbauen"): Uebersicht aller Konten nach Auffaelligkeit, Rate-Limit-Treffer je Konto,
// Geschenk an alle Spieler, abgelehnte Spielstaende je Konto - plus die Betreiber-Push
// 'verdacht', die aus der Uebersicht erst eine Meldung macht.
//
// DIE VIER KERNMESSUNGEN SIND PAARE (Arbeitsregel 61):
//   1a/1e  eine Ablehnung wird vermerkt UND ein gueltiger Save geht weiter durch
//   2a/2b  wer flutet, bekommt den Zaehler UND wer nicht flutet, bekommt keinen
//   3b/3b2 acht Tage lueckenlos ist Verdacht UND drei Tage lueckenlos sind keiner
//   4a/4a2 die Push nennt das auffaellige Konto UND nicht das unauffaellige
// Jede Haelfte allein waere auch bei einem Zaehler gruen, der immer oder nie zaehlt.
//
// 1c MISST PERSISTENZ MIT SIGKILL, nicht mit SIGTERM: Der Graceful Shutdown flusht die db und
// schriebe genau den Eintrag mit, dessen Verlust gemessen werden soll (Arbeitsregel 78). Die
// Ablehnungsstelle muss selbst saveDb() rufen - der abgelehnte Spieler loest sonst nie eines aus.
//
// GEGENPROBEN (an sabotierten Kopien ueber KEPLER_SERVER_JS, alle mit 38 Pruefungen in beide
// Richtungen und identischer Pruefliste per diff; Pflichtlisten NACH der Messung):
//   Save-Reject-Vermerk ohne saveDb            -> 1c, 1d, 1e
//   429 wird nicht vermerkt                    -> 2a, 2c, 2d
//   verdachtTick nicht im galaxyTick           -> 4a, 4b, 4c2, 4d
//   Wochenregel entfernt (Pause <= 2 h genuegt) -> 3b2, 4a, 4a2, 4e
//   Meldepause entfernt                        -> 4a, 4b
//   Geschenk-Deckel entfernt                   -> 5c, 5d, 5e, 5g
//   Geschenk ohne saveDb vor der Antwort       -> 5b, 5f2, 5g, 5j
// Vier der sieben Listen waren beim ersten Entwurf zu ENG (1d/1e, 4a, 5g, 5f2/5g/5j fielen
// zusaetzlich) - eine Pflichtliste ist selbst eine Behauptung, bis die Gegenprobe sie gemessen hat.
//
// PORT 3238: gemessen belegt sind 3195-3200 und 3210-3237
// (`grep -hoE "3[12][0-9][0-9]" tests/*.js | sort -un`) - ein neuer Test nimmt 3239.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3238);

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ADMIN = crypto.randomUUID(), ANNA = crypto.randomUUID(), BEN = crypto.randomUUID(),
      CARL = crypto.randomUUID(), ERIK = crypto.randomUUID(), FRITZ = crypto.randomUUID();

function spielstand(id, name, extra) {
  return Object.assign({
    resources: { energie: 1e5, erz: 1e5, kristalle: 1e5, deuterium: 1e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {}, fleet: { missions: [] },
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  }, extra || {});
}
// Ein Muster in die Uhr legen: `tage` Kalendertage (heute eingeschlossen, plus einer davor),
// je Tag die Stunden von..bis aktiv. Lueckenlos = 0..23.
function aktivMuster(tage, von, bis) {
  const a = {};
  for (let t = 0; t <= tage; t++) {
    const k = new Date(Date.now() - t * 86400000).toISOString().slice(0, 10);
    let m = 0;
    for (let h = von; h <= bis; h++) m |= (1 << h);
    a[k] = m;
  }
  return a;
}
function grunddb() {
  const jetzt = Date.now();
  return {
    users: {
      gamegeeeeek: { userId: ADMIN, username: 'GameGeeeeek', passwordHash: hash, createdAt: jetzt },
      // anna: acht Tage lueckenlos - das Muster, um das es geht.
      anna:  { userId: ANNA,  username: 'anna',  passwordHash: hash, createdAt: jetzt - 20 * 86400000, aktiv: aktivMuster(8, 0, 23) },
      // ben: acht Tage, taeglich 8-22 Uhr - ein Mensch mit 9 h Nachtpause.
      ben:   { userId: BEN,   username: 'ben',   passwordHash: hash, createdAt: jetzt - 20 * 86400000, aktiv: aktivMuster(8, 8, 22) },
      // carl: frisch, ohne jede Aufzeichnung.
      carl:  { userId: CARL,  username: 'carl',  passwordHash: hash, createdAt: jetzt },
      // erik: registriert, aber nie gespielt (kein Spielstand).
      erik:  { userId: ERIK,  username: 'erik',  passwordHash: hash, createdAt: jetzt },
      // fritz: DREI Tage lueckenlos - lang genug fuer "belastbar", zu kurz fuer die Wochenregel.
      fritz: { userId: FRITZ, username: 'fritz', passwordHash: hash, createdAt: jetzt - 10 * 86400000, aktiv: aktivMuster(3, 0, 23) }
    },
    private: {
      [ADMIN]: { 'kepler7-save-v3': JSON.stringify(spielstand(ADMIN, 'GameGeeeeek')) },
      [ANNA]:  { 'kepler7-save-v3': JSON.stringify(spielstand(ANNA, 'anna')) },
      [BEN]:   { 'kepler7-save-v3': JSON.stringify(spielstand(BEN, 'ben')) },
      [CARL]:  { 'kepler7-save-v3': JSON.stringify(spielstand(CARL, 'carl')) },
      [FRITZ]: { 'kepler7-save-v3': JSON.stringify(spielstand(FRITZ, 'fritz')) }
    },
    shared: {}, resetTokens: {}, feedback: [],
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: jetzt, factions: {},
      alienPause: { kryll: jetzt + 9e8, xantheer: jetzt + 9e8, vex: jetzt + 9e8, verglueht: jetzt + 9e8 },
      alienNester: [] }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-uhrerw-' + process.pid + '.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-uhrerw-'));
let srv = null, s = null, tok = {};
function aufraeumen() {
  try { if (srv) srv.kill('SIGKILL'); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', aufraeumen);

async function starteServer() {
  let log = '';
  // KEPLER_SERVER_JS leitet auf eine sabotierte KOPIE um (Gegenproben). Die Kopie MUSS im
  // Repo-Verzeichnis liegen, damit require('./mailer') aufloest.
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
  // Der galaxyTick laeuft per setImmediate direkt nach dem Start und ruft verdachtTick - kurz
  // warten, damit die Verdachtsmeldung des Starts vor der ersten Messung steht.
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
    return r.body && r.body.token;
  }
  return { j, anmelden, protokoll: () => log };
}
async function alleAnmelden() {
  tok = {};
  for (const n of ['GameGeeeeek', 'anna', 'ben', 'carl', 'erik', 'fritz']) tok[n] = await s.anmelden(n);
}
async function stoppeServer() { if (!srv) return; srv.kill('SIGTERM'); await warte(700); srv = null; }
// HART stoppen: kein Graceful Shutdown, kein Flush - so stirbt der Prozess im Ernstfall.
async function stoppeHart() { if (!srv) return; srv.kill('SIGKILL'); await warte(400); srv = null; }
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  s = await starteServer();
  await alleAnmelden();
}
const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
const konto = async name => (await s.j('/admin/konto?name=' + name, { headers: kopf(tok.GameGeeeeek) })).body;
const blatt = async name => { const b = await konto(name); return (b.konten || []).find(k => k.username === name) || {}; };
const meldungen = async () => ((await s.j('/notifications', { headers: kopf(tok.GameGeeeeek) })).body || {});
const verdachtMeldungen = async () => {
  const b = await meldungen();
  const liste = Array.isArray(b) ? b : (b.events || b.list || b.notifications || []);
  return liste.filter(e => e && e.type === 'konto-verdacht');
};

(async () => {
  schreibDb(grunddb());
  s = await starteServer();
  await alleAnmelden();
  check('0-vorab: alle Konten angemeldet', ['GameGeeeeek', 'anna', 'ben', 'carl', 'erik', 'fritz'].every(n => !!tok[n]),
    Object.fromEntries(Object.entries(tok).map(([k, v]) => [k, !!v])));
  if (!tok.anna) { console.log(s.protokoll().slice(-1500)); process.exit(1); }

  // ---- 1) Abgelehnte Spielstaende --------------------------------------------------------------
  const kaputt = spielstand(ANNA, 'anna', { credits: -5 });
  const r1 = await s.j('/storage/kepler7-save-v3', { method: 'PUT', headers: kopf(tok.anna),
    body: JSON.stringify({ value: JSON.stringify(kaputt) }) });
  check('1-vorab: der Spielstand wird abgelehnt (400 mit Grund)',
    r1.status === 400 && /unplausibel/.test(String(r1.body && r1.body.error)), { status: r1.status, body: r1.body });
  const b1 = await blatt('anna');
  check('1a: die Ablehnung steht im Konto-Blatt mit Grund',
    b1.spielstandAbgelehnt && b1.spielstandAbgelehnt.n === 1 && /Kredite/.test(String(b1.spielstandAbgelehnt.letzterGrund)),
    b1.spielstandAbgelehnt);
  await s.j('/storage/kepler7-save-v3', { method: 'PUT', headers: kopf(tok.anna),
    body: JSON.stringify({ value: JSON.stringify(spielstand(ANNA, 'anna', { xp: -1 })) }) });
  const b1b = await blatt('anna');
  check('1b: die zweite Ablehnung zaehlt hoch und fuehrt beide Gruende',
    b1b.spielstandAbgelehnt && b1b.spielstandAbgelehnt.n === 2 && (b1b.spielstandAbgelehnt.letzte || []).length === 2 &&
    /XP/.test(String(b1b.spielstandAbgelehnt.letzterGrund)),
    { n: b1b.spielstandAbgelehnt && b1b.spielstandAbgelehnt.n, letzte: (b1b.spielstandAbgelehnt || {}).letzte });
  // 1c: PERSISTENZ. Hart gestoppt - ein SIGTERM schriebe den Eintrag selbst mit und die Pruefung
  // waere bei einer Stelle ohne saveDb() aus dem falschen Grund gruen.
  await stoppeHart();
  const dbHart = liesDb();
  check('1c: die Ablehnung ueberlebt einen HARTEN Stopp (die Stelle speichert selbst)',
    dbHart.users.anna.saveAblehnungen && dbHart.users.anna.saveAblehnungen.n === 2,
    { inDatei: dbHart.users.anna.saveAblehnungen || null });
  s = await starteServer(); await alleAnmelden();
  const sys1 = (await s.j('/admin/systemstand', { headers: kopf(tok.GameGeeeeek) })).body;
  check('1d: der Systemstand zaehlt das Konto (7-Tage-Fenster)',
    sys1.bestand && sys1.bestand.abgelehnteSpielstaende7Tage === 1, sys1.bestand);
  const rGut = await s.j('/storage/kepler7-save-v3', { method: 'PUT', headers: kopf(tok.anna),
    body: JSON.stringify({ value: JSON.stringify(spielstand(ANNA, 'anna')) }) });
  const b1e = await blatt('anna');
  check('1e: ein gueltiger Spielstand geht weiterhin durch und zaehlt NICHT',
    rGut.status === 200 && b1e.spielstandAbgelehnt && b1e.spielstandAbgelehnt.n === 2,
    { status: rGut.status, n: b1e.spielstandAbgelehnt && b1e.spielstandAbgelehnt.n });
  const b1f = await blatt('ben');
  check('1f: ein Konto ohne Ablehnung meldet 0 und keinen Grund',
    b1f.spielstandAbgelehnt && b1f.spielstandAbgelehnt.n === 0 && b1f.spielstandAbgelehnt.letzterGrund === null,
    b1f.spielstandAbgelehnt);

  // ---- 2) Rate-Limit-Treffer je Konto ---------------------------------------------------------
  // Ben flutet einen Pfad: 250 Anfragen auf denselben Schluessel, 240 sind je Minute erlaubt.
  let treffer429 = 0;
  for (let i = 0; i < 250; i++) {
    const r = await fetch('http://127.0.0.1:' + PORT + '/api/storage/flut-ben', { headers: kopf(tok.ben) });
    await r.text();
    if (r.status === 429) treffer429++;
  }
  check('2-vorab: der Flooder hat 429 bekommen', treffer429 > 0, { treffer429 });
  const b2 = await blatt('ben');
  check('2a: die Treffer stehen im Konto-Blatt, heute UND gesamt, mit dem Pfad',
    b2.rateLimitTreffer && b2.rateLimitTreffer.heute === treffer429 && b2.rateLimitTreffer.gesamt === treffer429 &&
    String(b2.rateLimitTreffer.letzterPfad).startsWith('/api/storage/'),
    { erwartet: treffer429, blatt: b2.rateLimitTreffer });
  const b2b = await blatt('anna');
  check('2b: wer nicht geflutet hat, hat 0', b2b.rateLimitTreffer && b2b.rateLimitTreffer.heute === 0 && b2b.rateLimitTreffer.gesamt === 0,
    b2b.rateLimitTreffer);
  // 2c: eine Flut OHNE Sitzung darf niemandem angerechnet werden.
  let anonym429 = 0;
  for (let i = 0; i < 250; i++) {
    const r = await fetch('http://127.0.0.1:' + PORT + '/api/gibtesnicht');
    await r.text();
    if (r.status === 429) anonym429++;
  }
  const uebersicht2 = (await s.j('/admin/aktivitaet', { headers: kopf(tok.GameGeeeeek) })).body;
  const summe2 = (uebersicht2.konten || []).reduce((n, k) => n + (k.rateLimitGesamt || 0), 0);
  check('2c: eine Flut ohne Sitzung landet an KEINEM Konto', anonym429 > 0 && summe2 === treffer429,
    { anonym429, summeAllerKonten: summe2, erwartet: treffer429 });
  const zeileBen = (uebersicht2.konten || []).find(k => k.username === 'ben') || {};
  check('2d: die Uebersicht traegt den Tageszaehler mit', zeileBen.rateLimitHeute === treffer429, { zeile: zeileBen.rateLimitHeute });

  // ---- 3) Uebersicht aller Konten nach Auffaelligkeit -----------------------------------------
  const u3 = uebersicht2;
  const namen3 = (u3.konten || []).map(k => k.username);
  // Belastbare zuerst (anna, fritz, ben - Pause 0, 0, 9), die zwei Unbelastbaren (carl, Admin) dahinter.
  const belastbare3 = (u3.konten || []).filter(k => k.belastbar).map(k => k.username);
  const unbelastbare3 = (u3.konten || []).filter(k => !k.belastbar).map(k => k.username);
  check('3a: sortiert nach laengster Pause, belastbare Konten zuerst',
    namen3.indexOf('anna') === 0 && namen3.indexOf('ben') === 2 && belastbare3.length === 3 &&
    unbelastbare3.every(n => namen3.indexOf(n) >= 3) && unbelastbare3.length === 2,
    { reihenfolge: namen3, pausen: (u3.konten || []).map(k => [k.username, k.laengstePause, k.belastbar]) });
  const zAnna = (u3.konten || []).find(k => k.username === 'anna') || {};
  const zBen = (u3.konten || []).find(k => k.username === 'ben') || {};
  const zFritz = (u3.konten || []).find(k => k.username === 'fritz') || {};
  check('3b: acht Tage lueckenlos ist Verdacht, neun Stunden Nachtpause nicht (PAAR)',
    zAnna.verdacht === true && zBen.verdacht === false,
    { anna: [zAnna.laengstePause, zAnna.verdacht], ben: [zBen.laengstePause, zBen.verdacht] });
  check('3b2: DREI Tage lueckenlos sind KEIN Verdacht - die Regel verlangt eine Woche',
    zFritz.belastbar === true && zFritz.laengstePause === 0 && zFritz.verdacht === false,
    { fritz: [zFritz.beobachtet, zFritz.laengstePause, zFritz.belastbar, zFritz.verdacht], regel: u3.regel });
  check('3c: nur Konten MIT Spielstand - erik fehlt, gesamt stimmt',
    namen3.indexOf('erik') < 0 && u3.gesamt === 5 && namen3.length === 5, { namen: namen3, gesamt: u3.gesamt });
  check('3d: jede Zeile traegt die volle Stundenreihe', (u3.konten || []).every(k => typeof k.reihe === 'string' && k.reihe.length === 14 * 24),
    { laengen: (u3.konten || []).map(k => (k.reihe || '').length) });
  const r3e = await s.j('/admin/aktivitaet', { headers: kopf(tok.anna) });
  check('3e: ohne Admin 403', r3e.status === 403, r3e.status);

  // ---- 4) Die Verdachtsmeldung an den Betreiber -----------------------------------------------
  // Der galaxyTick des Starts hat verdachtTick ausgefuehrt (setImmediate) - anna ist seit dem
  // ersten Serverstart auffaellig.
  const m4 = await verdachtMeldungen();
  check('4a: der Betreiber hat EINE Meldung fuer anna, mit Pause und Tagen',
    m4.filter(e => e.payload && e.payload.username === 'anna').length === 1 &&
    m4.every(e => e.payload && typeof e.payload.laengstePause === 'number' && e.payload.tage >= 7),
    { meldungen: m4.map(e => e.payload) });
  check('4a2: KEINE Meldung fuer ben, fritz oder carl (PAAR)',
    m4.every(e => e.payload && e.payload.username === 'anna'), { namen: m4.map(e => e.payload && e.payload.username) });
  // 4b: zwei weitere Starts, also zwei weitere Ticks - trotzdem bleibt es bei EINER Meldung.
  await aendereDb(() => {});
  await aendereDb(() => {});
  const m4b = await verdachtMeldungen();
  check('4b: nach zwei weiteren Ticks weiterhin genau eine Meldung (Meldepause, gespeichert)',
    m4b.filter(e => e.payload && e.payload.username === 'anna').length === 1, { anzahl: m4b.length });
  const b4d = await blatt('anna');
  check('4d: das Konto-Blatt zeigt Verdacht und den Meldezeitpunkt',
    b4d.aktiv && b4d.aktiv.verdacht === true && b4d.aktiv.verdachtGemeldet > 0, b4d.aktiv && { verdacht: b4d.aktiv.verdacht, gemeldet: b4d.aktiv.verdachtGemeldet });
  const sys4 = (await s.j('/admin/systemstand', { headers: kopf(tok.GameGeeeeek) })).body;
  check('4e: der Systemstand zaehlt genau ein Verdachtskonto', sys4.bestand && sys4.bestand.verdachtKonten === 1, sys4.bestand);
  // 4c: der Schalter. dora kommt neu und auffaellig dazu, die Kategorie ist AUS - keine Meldung.
  const DORA = crypto.randomUUID();
  await aendereDb(d => {
    d.users.gamegeeeeek.notifPrefs = { enabled: true, verdacht: false };
    d.users.dora = { userId: DORA, username: 'dora', passwordHash: hash, createdAt: Date.now() - 20 * 86400000, aktiv: aktivMuster(8, 0, 23) };
    d.private[DORA] = { 'kepler7-save-v3': JSON.stringify(spielstand(DORA, 'dora')) };
  });
  const m4c = await verdachtMeldungen();
  check('4c: Kategorie aus - dora wird NICHT gemeldet', !m4c.some(e => e.payload && e.payload.username === 'dora'),
    { namen: m4c.map(e => e.payload && e.payload.username) });
  await aendereDb(d => { d.users.gamegeeeeek.notifPrefs = { enabled: true, verdacht: true }; });
  const m4c2 = await verdachtMeldungen();
  check('4c2: Kategorie wieder an - dora wird beim naechsten Tick gemeldet',
    m4c2.filter(e => e.payload && e.payload.username === 'dora').length === 1, { namen: m4c2.map(e => e.payload && e.payload.username) });
  const p4 = (await s.j('/notification-prefs', { headers: kopf(tok.GameGeeeeek) })).body || {};
  check('4f: die Kategorie ist in den Einstellungen sichtbar und setzbar', p4.verdacht === true, { verdacht: p4.verdacht });
  const p4b = await s.j('/notification-prefs', { method: 'POST', headers: kopf(tok.GameGeeeeek),
    body: JSON.stringify(Object.assign({}, p4, { verdacht: false })) });
  check('4f2: ... und ueberlebt den Schreibweg (POST baut die Einstellungen neu auf)',
    p4b.status === 200 && p4b.body && p4b.body.verdacht === false, { verdacht: p4b.body && p4b.body.verdacht });
  await s.j('/notification-prefs', { method: 'POST', headers: kopf(tok.GameGeeeeek), body: JSON.stringify(Object.assign({}, p4, { verdacht: true })) });

  // ---- 5) Geschenk an alle Spieler ------------------------------------------------------------
  const empfaengerSoll = Object.values(liesDb().users).filter(u => !u.banned && liesDb().private[u.userId] && liesDb().private[u.userId]['kepler7-save-v3'] !== undefined).length;
  const g5 = await s.j('/admin/geschenk', { method: 'POST', headers: kopf(tok.GameGeeeeek),
    body: JSON.stringify({ gaben: { credits: 500, erz: 1000 }, text: 'Entschuldigung fuer den Ausfall.' }) });
  check('5a: das Geschenk geht an alle Konten mit Spielstand', g5.status === 200 && g5.body && g5.body.empfaenger === empfaengerSoll,
    { status: g5.status, body: g5.body, soll: empfaengerSoll });
  await stoppeHart();   // 5b misst die Persistenz gleich mit: die Route muss speichern, bevor sie antwortet
  const db5 = liesDb();
  const fach = uid => ((db5.private[uid] || {}).__pendingRewards || []);
  const gesch = uid => fach(uid).filter(r => r.type === 'geschenk');
  check('5b: jedes Konto mit Spielstand hat GENAU ein Geschenk im Fach - mit eigenem type, Gaben flach, Text',
    [ADMIN, ANNA, BEN, CARL, FRITZ, DORA].every(uid => gesch(uid).length === 1 && gesch(uid)[0].credits === 500 && gesch(uid)[0].erz === 1000 &&
      /Ausfall/.test(gesch(uid)[0].text)) && gesch(ERIK).length === 0,
    { anna: gesch(ANNA)[0] || null, erik: fach(ERIK).length });
  s = await starteServer(); await alleAnmelden();
  const g5c = await s.j('/admin/geschenk', { method: 'POST', headers: kopf(tok.GameGeeeeek), body: JSON.stringify({ gaben: { credits: 26000 } }) });
  check('5c: ueber dem Deckel wird abgelehnt und die Gabe im Grund genannt',
    g5c.status === 400 && /Kredite/.test(String(g5c.body && g5c.body.error)), g5c.body);
  const g5d = await s.j('/admin/geschenk', { method: 'POST', headers: kopf(tok.GameGeeeeek), body: JSON.stringify({ gaben: { schiffe: 5 } }) });
  check('5d: eine unbekannte Gabe wird abgelehnt', g5d.status === 400 && /Unbekannte Gabe/.test(String(g5d.body && g5d.body.error)), g5d.body);
  const g5e = await s.j('/admin/geschenk', { method: 'POST', headers: kopf(tok.GameGeeeeek), body: JSON.stringify({ gaben: {} }) });
  check('5e: ein leeres Geschenk wird abgelehnt', g5e.status === 400, g5e.body);
  const g5i = await s.j('/admin/geschenk', { method: 'POST', headers: kopf(tok.anna), body: JSON.stringify({ gaben: { credits: 1 } }) });
  check('5i: ohne Admin 403', g5i.status === 403, g5i.status);
  // 5f: nur aktive Konten. carl war seit 40 Tagen nicht angemeldet.
  await aendereDb(d => { d.users.carl.activeSessionAt = Date.now() - 40 * 86400000; });
  // aendereDb meldet alle an - das setzt activeSessionAt neu. carl also danach zuruecksetzen:
  await stoppeServer(); { const d = liesDb(); d.users.carl.activeSessionAt = Date.now() - 40 * 86400000; schreibDb(d); }
  s = await starteServer(); for (const n of ['GameGeeeeek', 'anna']) tok[n] = await s.anmelden(n);
  const g5f = await s.j('/admin/geschenk', { method: 'POST', headers: kopf(tok.GameGeeeeek),
    body: JSON.stringify({ gaben: { kristalle: 100 }, nurAktiveTage: 30 }) });
  // Zwei fallen heraus: carl (40 Tage still) und dora - sie hat sich in diesem Test NIE angemeldet,
  // traegt also kein activeSessionAt. Ein Konto ohne jede Anmeldung ist nicht "aktiv", und genau
  // das soll der Filter sagen; die erste Fassung dieser Pruefung hatte dora vergessen und war rot.
  check('5f: nurAktiveTage laesst ein seit 40 Tagen stilles und ein nie angemeldetes Konto aus',
    g5f.status === 200 && g5f.body && g5f.body.empfaenger === empfaengerSoll - 2, { body: g5f.body, soll: empfaengerSoll - 2 });
  await stoppeHart();
  const db5f = liesDb();
  const hatKristalle = uid => (((db5f.private[uid] || {}).__pendingRewards) || []).some(r => r.type === 'geschenk' && r.kristalle === 100);
  check('5f2: ... und zwar GENAU die zwei - anna hat das Geschenk, carl und dora nicht (gemessen im Fach)',
    hatKristalle(ANNA) && hatKristalle(BEN) && !hatKristalle(CARL) && !hatKristalle(DORA),
    { anna: hatKristalle(ANNA), ben: hatKristalle(BEN), carl: hatKristalle(CARL), dora: hatKristalle(DORA) });
  s = await starteServer(); for (const n of ['GameGeeeeek', 'anna']) tok[n] = await s.anmelden(n);
  const v5g = (await s.j('/admin/geschenke', { headers: kopf(tok.GameGeeeeek) })).body || {};
  check('5g: der Verlauf fuehrt beide Geschenke (neuestes zuerst) und die Deckel-Tabelle',
    Array.isArray(v5g.geschenke) && v5g.geschenke.length === 2 && v5g.geschenke[0].gaben.kristalle === 100 &&
    v5g.geschenke[1].empfaenger === empfaengerSoll && v5g.gaben && v5g.gaben.credits && v5g.gaben.credits.max === 25000,
    { verlauf: (v5g.geschenke || []).map(g => [g.empfaenger, g.gaben]), deckelKredite: v5g.gaben && v5g.gaben.credits });
  const c5j = await s.j('/pending-rewards/claim', { method: 'POST', headers: kopf(tok.anna) });
  check('5j: der Spieler holt das Geschenk ueber das normale Belohnungsfach ab',
    c5j.status === 200 && c5j.body && c5j.body.reward && c5j.body.reward.type === 'geschenk' && c5j.body.reward.credits === 500,
    c5j.body && c5j.body.reward);

  await stoppeServer();
  console.log(fail ? '\nFAIL - es gab rote Pruefungen.' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ABBRUCH:', e); try { console.log(s && s.protokoll().slice(-1500)); } catch (x) {} process.exit(1); });
