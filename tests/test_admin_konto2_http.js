// Vier weitere Admin-Faehigkeiten am Konto (02.09.2026, Auftrag Sascha "Weitere Ideen fuer Admin
// Funktionen" - alle vier Vorschlaege gewaehlt): Kampfverlauf als Beweis fuer Meldungen,
// Anmelde-Forensik, E-Mail an Spieler, Konto endgueltig loeschen mit Frist.
//
// KERNMESSUNGEN ALS PAARE (Arbeitsregel 61):
//   1c/1d  der Verlauf ueberlebt, wenn der Spieler seine EIGENEN Berichte loescht - genau der Fall,
//          wegen dem er nicht in db.private liegt (dort kann der Verdaechtige ihn wegwischen)
//   2a/2b  Fehlversuche zaehlen hoch UND eine gelungene Anmeldung setzt sie zurueck, mit der
//          Zahl von vorher erhalten
//   2d     ein UNBEKANNTER Name zaehlt nirgends mit und antwortet woertlich gleich (keine
//          Konto-Erkennung ueber die Fehlermeldung)
//   3c/3d  eine Mail an ein Konto ohne bestaetigte Adresse wird abgelehnt UND eine mit Adresse
//          wird wirklich versucht (der 502 nennt den Grund des Mail-Dienstes)
//   4f/4g  die Frist laeuft ab und raeumt SECHS Stellen auf UND laesst die eines anderen Kontos
//          unangetastet (der Aufraeumlauf ist gezielt, nicht gierig)
//
// GEGENPROBEN (sabotierte Kopien ueber KEPLER_SERVER_JS, gemessen 02.09.2026 - alle sechs treffen,
// 0 Werkzeugfehler; links die Sabotage, rechts die Pruefung, die sie fallen laesst):
//   Verlauf nur beim Angreifer, nicht beim Verteidiger              -> 1b
//   Verlauf-Route liest die BERICHTE statt den Verlauf am Konto     -> 1d (und 1e)
//   Fehlversuche werden bei gelungener Anmeldung nicht zurueckgesetzt -> 2b
//   Der unbekannte Name bekommt eine eigene Fehlermeldung           -> 2d
//   Mail wird auch ohne bestaetigte Adresse versucht                -> 3c
//   Der Aufraeumlauf loescht ALLE Vorposten statt nur die des Kontos -> 4h
// Die zweite Sabotage ist die wichtigste: Sie baut genau die naheliegende Fassung, die hier
// VERWORFEN wurde (den Verlauf aus db.private lesen), und 1d faellt - weil der Spieler seine
// Berichte selbst loeschen kann.
//
// PORT 3247: gemessen belegt sind 3195-3246 (Backend, `grep -hoE "3[12][0-9][0-9]" tests/*.js`) und
// bis 3243 im Frontend-Repo - ein neuer Test nimmt 3248.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3247);

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ADMIN = crypto.randomUUID(), ANNA = crypto.randomUUID(), BEN = crypto.randomUUID(), CARL = crypto.randomUUID();

function spielstand(id, name, credits, flotte) {
  return {
    resources: { energie: 1e5, erz: 1e5, kristalle: 1e5, deuterium: 1e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: { mine: 7 }, research: {}, colonies: {}, fleet: Object.assign({ missions: [] }, flotte || { jaeger: 40 }),
    player: { id, name }, credits, xp: 1000, prestige: 0, battlePoints: 10, lastTick: Date.now()
  };
}
const rolle = (id, name, role) => JSON.stringify({ playerId: id, name, role, joinedAt: 1756000000000 });
function grunddb() {
  const jetzt = Date.now();
  return {
    users: {
      gamegeeeeek: { userId: ADMIN, username: 'GameGeeeeek', passwordHash: hash, createdAt: jetzt },
      // anna traegt ALLE Spuren, die der Aufraeumlauf treffen soll (Abschnitt 4): Spielstand,
      // Bestenliste, Allianz-Rolle, Vorposten, Chat-Nachricht, Feedback, Reset-Token.
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: jetzt, email: 'anna@example.org', emailVerified: true },
      // ben traegt dieselben Arten von Spuren und wird NICHT geloescht - er ist die Gegenprobe
      // dazu, dass der Aufraeumlauf gezielt arbeitet.
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: jetzt, email: 'ben@example.org', emailVerified: true },
      carl: { userId: CARL, username: 'carl', passwordHash: hash, createdAt: jetzt }
    },
    private: {
      [ADMIN]: { 'kepler7-save-v3': JSON.stringify(spielstand(ADMIN, 'GameGeeeeek', 1000)) },
      [ANNA]:  { 'kepler7-save-v3': JSON.stringify(spielstand(ANNA, 'anna', 5000, { jaeger: 200, kreuzer: 40 })) },
      [BEN]:   { 'kepler7-save-v3': JSON.stringify(spielstand(BEN, 'ben', 3000, { jaeger: 3 })) },
      [CARL]:  { 'kepler7-save-v3': JSON.stringify(spielstand(CARL, 'carl', 100, { jaeger: 3 })) }
    },
    shared: {
      'worldboss:current': JSON.stringify({ level: 2, hp: 500, maxHp: 1000, contributions: {} }),
      ['leaderboard:' + ANNA]: JSON.stringify({ name: 'anna', score: 10, lastSeen: jetzt }),
      ['leaderboard:' + BEN]: JSON.stringify({ name: 'ben', score: 8, lastSeen: jetzt }),
      'alliance:T1:info': JSON.stringify({ tag: 'T1', creatorId: BEN, creatorName: 'ben', createdAt: 1755000000000, joinMode: 'open' }),
      ['alliance:T1:role:' + BEN]: rolle(BEN, 'ben', 'admin'),
      ['alliance:T1:role:' + ANNA]: rolle(ANNA, 'anna', 'member'),
      'vorposten:sys_anna': JSON.stringify({ id: 'vp_a', sys: 'sys_anna', besitzer: ANNA, besitzerName: 'anna', stufe: 1, kern: { lp: 100, lpMax: 100 }, seit: jetzt - 3600000 }),
      'vorposten:sys_ben': JSON.stringify({ id: 'vp_b', sys: 'sys_ben', besitzer: BEN, besitzerName: 'ben', stufe: 1, kern: { lp: 100, lpMax: 100 }, seit: jetzt - 3600000 }),
      'globalchat:msg:1756000000000-aaa': JSON.stringify({ authorId: ANNA, authorName: 'anna', text: 'Hallo zusammen', time: jetzt - 120000 }),
      'globalchat:msg:1756000000001-bbb': JSON.stringify({ authorId: BEN, authorName: 'ben', text: 'Moin', time: jetzt - 60000 })
    },
    resetTokens: { tok_anna: { userId: ANNA, expires: jetzt + 3600000 }, tok_ben: { userId: BEN, expires: jetzt + 3600000 } },
    feedback: [{ id: 'fb1', time: jetzt - 60000, userId: ANNA, username: 'anna', type: 'idee', text: 'Mehr Schiffe bitte', version: '8.635.0' },
               { id: 'fb2', time: jetzt - 30000, userId: BEN, username: 'ben', type: 'bug', text: 'Knopf klemmt', version: '8.635.0' }],
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: jetzt, factions: {},
      alienPause: { kryll: jetzt + 9e8, xantheer: jetzt + 9e8, vex: jetzt + 9e8, verglueht: jetzt + 9e8 },
      alienNester: [] }
  };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-konto2-'));
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
      // Ausdruecklich LEER: Ohne Schluessel wirft mailer.sendEmail mit genau dieser Begruendung,
      // und das ist der Fehlerpfad, den Abschnitt 3 misst. Ein gesetzter Schluessel wuerde hier
      // echte Mails an erfundene Adressen schicken.
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
  await warte(300);
  async function j(pfad, opt) {
    const r = await fetch(basis + pfad, opt);
    const t = await r.text();
    try { return { status: r.status, body: JSON.parse(t) }; }
    catch (e) { return { status: r.status, body: t.slice(0, 300) }; }
  }
  async function anmelden(name, pw) {
    const r = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name, password: pw || 'test1234' }) });
    return { token: r.body && r.body.token, status: r.status, error: r.body && r.body.error };
  }
  return { j, anmelden, protokoll: () => log };
}
async function alleAnmelden() { tok = {}; for (const n of ['GameGeeeeek', 'anna', 'ben', 'carl']) tok[n] = (await s.anmelden(n)).token; }
async function stoppeServer() { if (!srv) return; srv.kill('SIGTERM'); await warte(700); srv = null; }
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
// Eine Aenderung an der DB bei LAUFENDEM Server ist beim naechsten Stopp weg (der Flush
// ueberschreibt sie): stoppen -> aendern -> starten. Regel aus CLAUDE.md.
async function aendereDb(fn) { await stoppeServer(); const d = liesDb(); await fn(d); schreibDb(d); s = await starteServer(); await alleAnmelden(); }
const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
const admin = (pfad, body) => s.j(pfad, { method: 'POST', headers: kopf(tok.GameGeeeeek), body: JSON.stringify(body || {}) });
const blatt = async name => (((await s.j('/admin/konto?name=' + name, { headers: kopf(tok.GameGeeeeek) })).body || {}).konten || [])[0] || {};
const protokoll = async () => ((await s.j('/admin/protokoll', { headers: kopf(tok.GameGeeeeek) })).body || {}).eintraege || [];
// Anfaengerschutz des Opfers nullen - jede Messung braucht ein frisches Opfer (CLAUDE.md).
const schildWeg = () => aendereDb(d => { for (const id of Object.keys(d.private || {})) delete d.private[id].__attackShieldUntil; });

(async () => {
  schreibDb(grunddb());
  s = await starteServer();
  await alleAnmelden();
  check('0-vorab: alle Konten angemeldet', ['GameGeeeeek', 'anna', 'ben', 'carl'].every(n => !!tok[n]), Object.fromEntries(Object.entries(tok).map(([k, v]) => [k, !!v])));
  if (!tok.anna) { console.log(s.protokoll().slice(-1500)); process.exit(1); }

  // ---- 1) Kampfverlauf am Konto ------------------------------------------------------------------
  const a1 = await s.j('/attack', { method: 'POST', headers: kopf(tok.anna), body: JSON.stringify({ targetUserId: BEN }) });
  check('1-vorab: der Angriff wurde ausgewertet', a1.status === 200 && typeof a1.body.success === 'boolean',
    { status: a1.status, fehler: a1.body && a1.body.error });
  const v1 = await s.j('/admin/konto/verlauf?targetUsername=anna', { headers: kopf(tok.GameGeeeeek) });
  const e1 = (v1.body.verlauf || [])[0] || {};
  check('1a: der Angreifer traegt den Angriff mit Gegner, Ausgang und beiden Kraeften',
    v1.status === 200 && e1.rolle === 'angriff' && e1.gegner === 'ben' && typeof e1.erfolg === 'boolean' && e1.angriff > 0 && e1.verteidigung >= 0,
    { status: v1.status, eintrag: e1 });
  const v1b = await s.j('/admin/konto/verlauf?targetUsername=ben', { headers: kopf(tok.GameGeeeeek) });
  const e1b = (v1b.body.verlauf || [])[0] || {};
  check('1b: der VERTEIDIGER traegt denselben Kampf aus seiner Sicht (Gegenrichtung)',
    e1b.rolle === 'verteidigung' && e1b.gegner === 'anna' && e1b.erfolg === !e1.erfolg && e1b.angriff === e1.angriff,
    { eintrag: e1b });
  // Der Kern der ganzen Fassung: Der Spieler loescht seine eigenen Berichte - und der Verlauf bleibt.
  const berV = (await s.j('/reports', { headers: kopf(tok.anna) })).body;
  const berVorher = ((berV && berV.reports) || []).length;
  await s.j('/reports', { method: 'DELETE', headers: kopf(tok.anna) });
  const berN = (await s.j('/reports', { headers: kopf(tok.anna) })).body;
  const v1c = await s.j('/admin/konto/verlauf?targetUsername=anna', { headers: kopf(tok.GameGeeeeek) });
  check('1c: der Spieler kann seine eigenen Berichte loeschen (Ausgangslage der Messung)',
    berVorher > 0 && ((berN && berN.reports) || []).length === 0, { vorher: berVorher, nachher: ((berN && berN.reports) || []).length });
  check('1d: der Kampfverlauf ueberlebt das Loeschen der Berichte (PAAR zu 1c)',
    (v1c.body.verlauf || []).length === (v1.body.verlauf || []).length && (v1c.body.verlauf || []).length > 0,
    { verlauf: (v1c.body.verlauf || []).length });
  // Zweiter Angriff auf DASSELBE Ziel - das ist das Muster, das eine Ganking-Meldung meint.
  await schildWeg();
  const a2 = await s.j('/attack', { method: 'POST', headers: kopf(tok.anna), body: JSON.stringify({ targetUserId: BEN }) });
  const v1d = await s.j('/admin/konto/verlauf?targetUsername=anna', { headers: kopf(tok.GameGeeeeek) });
  check('1e: zwei Angriffe auf dasselbe Ziel werden als haeufigstes Ziel gezaehlt',
    a2.status === 200 && v1d.body.haeufigstesZiel && v1d.body.haeufigstesZiel.name === 'ben' && v1d.body.haeufigstesZiel.anzahl === 2
    && v1d.body.angriffeGesamt === 2 && v1d.body.letzteStunde >= 2,
    { ziel: v1d.body.haeufigstesZiel, gesamt: v1d.body.angriffeGesamt, letzteStunde: v1d.body.letzteStunde });
  check('1f: das Konto-Blatt nennt die Zahl der Verlaufseintraege', (await blatt('anna')).kampfVerlauf === 2, { n: (await blatt('anna')).kampfVerlauf });
  const v1e = await s.j('/admin/konto/verlauf?targetUsername=gibtsnicht', { headers: kopf(tok.GameGeeeeek) });
  check('1g: ein unbekannter Name ergibt 404 mit Grund', v1e.status === 404 && /Kein Spieler mit diesem Namen/.test(v1e.body.error || ''), { status: v1e.status, fehler: v1e.body.error });
  const v1f = await s.j('/admin/konto/verlauf?targetUsername=anna', { headers: kopf(tok.ben) });
  check('1h: ein Nicht-Admin kommt nicht an den Verlauf', v1f.status === 403, { status: v1f.status });

  // ---- 2) Anmelde-Forensik -----------------------------------------------------------------------
  const falsch = [];
  for (let i = 0; i < 3; i++) falsch.push((await s.anmelden('carl', 'falsch' + i)).status);
  const b2 = await blatt('carl');
  check('2a: drei Fehlversuche werden am Konto gezaehlt, mit Zeitpunkt',
    falsch.every(x => x === 401) && b2.anmeldung && b2.anmeldung.fehlversuche === 3 && b2.anmeldung.fehlerZuletzt > 0,
    { status: falsch, anmeldung: b2.anmeldung });
  const okAnm = await s.anmelden('carl');
  const b2b = await blatt('carl');
  check('2b: die gelungene Anmeldung setzt den Zaehler zurueck und haelt die Zahl von vorher fest (PAAR zu 2a)',
    !!okAnm.token && b2b.anmeldung.fehlversuche === 0 && b2b.anmeldung.fehlversucheVorher === 3
    && b2b.anmeldung.letzte > 0 && b2b.anmeldung.gesamt >= 2,
    { anmeldung: b2b.anmeldung });
  check('2c: die offene Sitzung steht mit Zeitpunkt im Blatt', b2b.anmeldung.sitzungOffen === true && b2b.anmeldung.sitzungSeit > 0,
    { offen: b2b.anmeldung.sitzungOffen, seit: b2b.anmeldung.sitzungSeit });
  const unbekannt = await s.anmelden('gibtsnichtxyz', 'falsch');
  const falschDa = await s.anmelden('carl', 'falsch');
  check('2d: ein unbekannter Name antwortet WOERTLICH wie ein falsches Passwort (keine Konto-Erkennung)',
    unbekannt.status === 401 && falschDa.status === 401 && unbekannt.error === falschDa.error,
    { unbekannt: unbekannt.error, falsch: falschDa.error });
  const alleKonten = liesDb().users;
  check('2e: fuer den unbekannten Namen wurde NIRGENDS ein Zaehler angelegt (PAAR zu 2d)',
    !alleKonten.gibtsnichtxyz && Object.keys(alleKonten).length === 4, { konten: Object.keys(alleKonten) });

  // ---- 3) E-Mail an Spieler ----------------------------------------------------------------------
  const m3a = await admin('/admin/mail', { targetUsername: 'anna', betreff: 'Wartung', text: 'zu kurz' });
  check('3a: ein zu kurzer Text wird abgelehnt', m3a.status === 400 && /zehn Zeichen/.test(m3a.body.error || ''), { status: m3a.status, fehler: m3a.body.error });
  const m3b = await admin('/admin/mail', { targetUsername: 'anna', betreff: '', text: 'Das ist ein langer genug Text.' });
  check('3b: ohne Betreff wird abgelehnt', m3b.status === 400 && /Betreff/.test(m3b.body.error || ''), { status: m3b.status });
  const m3c = await admin('/admin/mail', { targetUsername: 'carl', betreff: 'Wartung', text: 'Wir machen heute Abend Wartung.' });
  check('3c: ein Konto OHNE bestaetigte Adresse wird abgelehnt, ohne dass etwas versucht wird',
    m3c.status === 400 && /bestaetigte E-Mail/.test(m3c.body.error || ''), { status: m3c.status, fehler: m3c.body.error });
  const m3d = await admin('/admin/mail', { targetUsername: 'anna', betreff: 'Wartung', text: 'Wir machen heute Abend Wartung.' });
  check('3d: mit Adresse wird wirklich versucht - der 502 nennt den GRUND des Mail-Dienstes (PAAR zu 3c)',
    m3d.status === 502 && /RESEND_API_KEY/.test(m3d.body.error || ''), { status: m3d.status, fehler: m3d.body.error });
  await aendereDb(d => { d.users.ben.wantsPatchnotes = false; });
  const m3e = await admin('/admin/mail-alle', { betreff: 'Wartung', text: 'Wir machen heute Abend Wartung.' });
  check('3e: der Rundlauf trennt abgemeldet, ohne Adresse und versucht - und meldet den Totalausfall als 502',
    m3e.status === 502 && m3e.body.gesendet === 0 && m3e.body.abgemeldet === 1 && m3e.body.ohneAdresse === 2 && m3e.body.fehlgeschlagen === 1,
    { body: m3e.body });
  const m3f = JSON.stringify(m3d.body) + JSON.stringify(m3e.body);
  check('3f: keine Antwort enthaelt eine Adresse im Klartext', !/anna@example\.org|ben@example\.org/.test(m3f), { auszug: m3f.slice(0, 120) });

  // ---- 4) Konto endgueltig loeschen mit Frist -----------------------------------------------------
  const l4a = await admin('/admin/konto/loeschen', { targetUsername: 'anna', grund: '' });
  check('4a: ohne Begruendung wird abgelehnt', l4a.status === 400 && /begruenden/.test(l4a.body.error || ''), { status: l4a.status });
  const l4b = await admin('/admin/konto/loeschen', { targetUsername: 'GameGeeeeek', grund: 'aus Versehen' });
  check('4b: das Betreiberkonto wird nicht geloescht', l4b.status === 400 && /Betreiberkonto/.test(l4b.body.error || ''), { status: l4b.status });
  const vorherAb = Date.now();
  const l4c = await admin('/admin/konto/loeschen', { targetUsername: 'anna', grund: 'Loeschbitte des Spielers' });
  check('4c: die Vormerkung setzt eine Frist von sieben Tagen',
    l4c.status === 200 && l4c.body.fristTage === 7 && l4c.body.ab > vorherAb + 6 * 86400000 && l4c.body.ab < vorherAb + 8 * 86400000,
    { status: l4c.status, tage: l4c.body.fristTage });
  const altesToken = await s.j('/me', { headers: kopf(tok.anna) });
  check('4c2: das laufende Geraet ist sofort abgemeldet', altesToken.status === 401, { status: altesToken.status });
  const anm4 = await s.anmelden('anna');
  check('4d: die Anmeldung nennt Frist UND Grund - nicht "falsches Passwort"',
    anm4.status === 403 && /geloescht/.test(anm4.error || '') && /Loeschbitte des Spielers/.test(anm4.error || ''),
    { status: anm4.status, fehler: anm4.error });
  const l4e = await admin('/admin/konto/loeschen', { targetUsername: 'anna', grund: 'noch einmal' });
  check('4e: eine zweite Vormerkung wird abgelehnt, statt die Frist zu verlaengern', l4e.status === 409, { status: l4e.status });
  const b4 = await blatt('anna');
  check('4e2: das Blatt zeigt die laufende Loeschung mit Grund', !!b4.loeschung && b4.loeschung.grund === 'Loeschbitte des Spielers' && b4.loeschung.ab > 0, { loeschung: b4.loeschung });
  const l4f = await admin('/admin/konto/loeschen-abbrechen', { targetUsername: 'anna' });
  const anm4b = await s.anmelden('anna');
  check('4f: Abbrechen macht das Konto wieder benutzbar', l4f.status === 200 && l4f.body.lief === true && anm4b.status === 200 && !!anm4b.token,
    { abbruch: l4f.body, anmeldung: anm4b.status });
  // Der Aufraeumlauf: Frist in die Vergangenheit legen, Server neu starten (setImmediate laeuft beim Start).
  await admin('/admin/konto/loeschen', { targetUsername: 'anna', grund: 'Loeschbitte des Spielers' });
  await aendereDb(d => { d.users.anna.loeschungAb = Date.now() - 60000; });
  await warte(600);
  const nach = liesDb();
  const chatAnna = JSON.parse(nach.shared['globalchat:msg:1756000000000-aaa'] || '{}');
  const chatBen = JSON.parse(nach.shared['globalchat:msg:1756000000001-bbb'] || '{}');
  const fbAnna = (nach.feedback || []).find(f => f.id === 'fb1') || {};
  const fbBen = (nach.feedback || []).find(f => f.id === 'fb2') || {};
  check('4g: nach Ablauf sind Konto, Spielstand, Bestenliste, Allianz-Rolle, Vorposten und Reset-Token weg',
    !nach.users.anna && !nach.private[ANNA] && !nach.shared['leaderboard:' + ANNA]
    && !nach.shared['alliance:T1:role:' + ANNA] && !nach.shared['vorposten:sys_anna'] && !nach.resetTokens.tok_anna,
    { konto: !!nach.users.anna, spielstand: !!nach.private[ANNA], bestenliste: !!nach.shared['leaderboard:' + ANNA],
      rolle: !!nach.shared['alliance:T1:role:' + ANNA], vorposten: !!nach.shared['vorposten:sys_anna'], token: !!nach.resetTokens.tok_anna });
  check('4g2: Chat und Feedback bleiben stehen, tragen aber nicht mehr den Namen',
    chatAnna.text === 'Hallo zusammen' && chatAnna.authorName === 'Geloeschtes Konto' && !chatAnna.authorId
    && fbAnna.text === 'Mehr Schiffe bitte' && fbAnna.username === 'Geloeschtes Konto' && !fbAnna.userId,
    { chat: chatAnna, feedback: fbAnna });
  check('4h: das Konto eines ANDEREN ist unangetastet - der Aufraeumlauf ist gezielt, nicht gierig (PAAR zu 4g)',
    !!nach.users.ben && !!nach.private[BEN] && !!nach.shared['leaderboard:' + BEN] && !!nach.shared['alliance:T1:role:' + BEN]
    && !!nach.shared['vorposten:sys_ben'] && !!nach.resetTokens.tok_ben
    && chatBen.authorId === BEN && chatBen.authorName === 'ben' && fbBen.username === 'ben',
    { konto: !!nach.users.ben, vorposten: !!nach.shared['vorposten:sys_ben'], chat: chatBen.authorName, feedback: fbBen.username });
  const anm4c = await s.anmelden('anna');
  check('4h2: der Name ist danach wieder frei - die Anmeldung findet kein Konto mehr', anm4c.status === 401, { status: anm4c.status });

  // ---- 5) Protokoll ------------------------------------------------------------------------------
  const p5 = await protokoll();
  const arten = p5.map(e => e.art);
  check('5a: Vormerkung und Abbruch stehen im Protokoll mit Ziel und Grund',
    arten.filter(a => a === 'konto/loeschen').length === 2 && arten.includes('konto/loeschen-abbrechen')
    && (p5.find(e => e.art === 'konto/loeschen') || {}).ziel === 'anna'
    && /Loeschbitte/.test(JSON.stringify((p5.find(e => e.art === 'konto/loeschen') || {}).details || {})),
    { arten: arten.slice(0, 8) });
  // Die abgewiesene zweite Vormerkung (409) und die gescheiterten Mails (502) stehen NICHT drin: Die
  // Protokoll-Middleware haelt nur fest, was auch stattgefunden hat (statusCode < 300). Das ist die
  // Aussage, die das Protokoll ueberhaupt tragfaehig macht - es ist kein Versuchs-Mitschnitt.
  check('5a2: was NICHT stattgefunden hat, steht auch nicht im Protokoll (PAAR zu 5a)',
    !arten.includes('mail') && !arten.includes('mail-alle') && arten.filter(a => a === 'konto/loeschen').length === 2,
    { arten });
  const roh5 = JSON.stringify(p5);
  check('5b: im Protokoll steht kein Passwort und keine Adresse', !/test1234|@example\.org/.test(roh5), { laenge: roh5.length });

  await stoppeServer();
  console.log(fail ? 'FAIL - es gab rote Pruefungen.' : 'Alles gruen.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAIL - Testlauf abgebrochen: ' + (e && e.stack || e)); process.exit(1); });
