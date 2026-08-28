// Chat-Buendel-Abruf GET /api/chat/:kanal (28.08.2026, Chat-Grossetappe A).
//
// DER ANLASS IST GEMESSEN, NICHT VERMUTET: Das Frontend las einen Chat-Kanal bis dahin in ~1+50
// Anfragen (storage-list fuer die Schluessel, dann storageGet je Nachricht) - gegen das globale
// Rate-Limit von 240/min je Verbindung. Ein Panel-Oeffnen mit beiden Kanaelen verbrauchte davon
// rund 100. Diese Route liefert denselben Inhalt in EINER Antwort und ist die Grundlage der
// Live-Aktualisierung im Frontend (Poll bei offenem Panel).
//
// WAS DIE ROUTE AUSDRUECKLICH NICHT AENDERT: die Leserechte. Das Lesen von Chat-Schluesseln war
// im generischen Storage schon immer fuer jedes angemeldete Konto offen (checkChatKeyPermission
// prueft nur das SCHREIBEN). Pruefung 3c haelt genau das als bewusste Haltung fest - ein
// Nicht-Mitglied darf den Allianz-Kanal lesen, wie beim alten Weg auch. Wer das je aendern will,
// aendert BEIDE Wege, sonst ist die Sperre eine Attrappe neben einer offenen Tuer.
//
// DIE SORTIER-PRUEFUNG 3a HAT EINEN PRUEFSTEIN, DEN NUR DIE NUMERISCHE SORTIERUNG BESTEHT:
// einen Schluessel mit ZEHNSTELLIGEM Zeitstempel (9999999999 ms = April 1970, also numerisch
// uralt) zwischen dreizehnstelligen. Eine String-Sortierung stellte ihn ans ENDE (als neueste
// Nachricht), die numerische an den ANFANG. Er liegt bewusst im ALLIANZ-Kanal - im globalen
// wuerde ihn die Aufbewahrungs-Beschneidung (er ist ja der aelteste) sofort loeschen.
//
// RETENTION (Abschnitt 5): Die Fixture legt 309 globale Nachrichten plus einen kaputten Eintrag
// an (310 Schluessel); der galaxyTick beim Serverstart (setImmediate) ruft pruneChatKeys und
// schneidet auf CHAT_KEEP_PER_CHANNEL = 300 - die aeltesten 10 (g0..g9) muessen weg sein, g10
// muss stehen. 5c misst dieselbe Wahrheit ueber den ALTEN Weg (storage-list), damit Buendel-Abruf
// und Altweg nicht zwei verschiedene Welten zeigen koennen.
//
// GEGENPROBEN (via CHAT_TEST_SERVER auf eine Server-Kopie im REPO-Verzeichnis - require('./mailer')
// loest sonst nicht auf; dasselbe Muster wie URMATERIE_TEST_SERVER):
//   * alter Stand (origin/master vor dieser Etappe): Route fehlt (404 statt 200/400/401) UND
//     Retention 100 statt 300 - es fallen 1a, 1b, 1c, 1d, 2a, 2b, 2c, 3a, 3b, 3c, 4a, 4b, 4c,
//     4d, 4e, 5a, 5b, 5c; gruen bleibt nur 0-vorab.
//   * Sortier-Sabotage (keys.sort() ohne Komparator in der Route): es fallen GENAU 3a und 3b
//     (gemessen - neuesteTs liest den LETZTEN Schluessel und meldet dann 9999999999). Im
//     globalen Kanal sind alle Zeitstempel gleich lang, dort ist lexikografisch = numerisch,
//     nur der zehnstellige Allianz-Pruefstein unterscheidet die beiden.
//   * Rueckfall-Sabotage (limit-Absicherung entfernt): es fallen GENAU 1a, 1b und 2b (gemessen -
//     ohne Parameter wird parseInt(undefined) zu NaN, slice(-NaN) liefert ALLES; limit=5 bleibt
//     als 2a gruen, weil ein gueltiger Wert die Absicherung nie brauchte).
// Jede Gegenprobe braucht ihre "was muss fallen"-Liste im Messlauf (Regel 71) - bleibt eine
// Pflicht-Pruefung gruen, ist das ein WERKZEUGFEHLER, kein Beleg.
//
// Port 3233 (3195-3232 sind belegt; gemessen mit
// `grep -hoE "3[12][0-9][0-9]" tests/*.js | sort -un`).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const SERVER_DATEI = process.env.CHAT_TEST_SERVER || 'server.js';
const PORT = Number(process.env.TEST_PORT || 3233);

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const EINS = crypto.randomUUID(), ZWEI = crypto.randomUUID();

// Feste Zeitbasis fuer die Fixture-Schluessel - deterministisch, damit jede Erwartung aus der
// Konstruktion folgt statt aus einer Momentaufnahme (Regel 2). Abstand 10 ms je Nachricht, damit
// zwischen g250 und g251 Platz fuer den kaputten Eintrag ist (BASIS + 2505).
const BASIS = 1756000000000;
const gTs = i => BASIS + i * 10;

function chatMsg(id, name, text, ts) {
  return JSON.stringify({ authorId: id, author: name, text, time: ts });
}

function grunddb() {
  const shared = {};
  // Globaler Kanal: g0..g308 (309 Nachrichten) plus ein kaputter Eintrag zwischen g250 und g251 -
  // zusammen 310 Schluessel, also 10 ueber der Aufbewahrung von 300. Der Start-Tick muss die
  // aeltesten 10 (g0..g9) entfernen; der kaputte liegt weit genug hinten und ueberlebt.
  for (let i = 0; i < 309; i++) {
    shared['globalchat:msg:' + gTs(i) + '-t' + i] = chatMsg(EINS, 'eins', 'g' + i, gTs(i));
  }
  shared['globalchat:msg:' + (BASIS + 2505) + '-kaputt'] = 'KEIN_JSON{{{';
  // Allianz-Kanal TESTA: vier normale Nachrichten plus der zehnstellige Pruefstein (numerisch
  // 1970, lexikografisch groesser als jede 13-stellige Zahl beginnend mit 1).
  shared['alliance:TESTA:msg:9999999999-alt'] = chatMsg(EINS, 'eins', 'uralt', 9999999999);
  for (let i = 0; i < 4; i++) {
    shared['alliance:TESTA:msg:' + gTs(1000 + i) + '-a' + i] = chatMsg(EINS, 'eins', 'a' + i, gTs(1000 + i));
  }
  return {
    users: {
      eins: { userId: EINS, username: 'eins', passwordHash: hash, emailVerified: true, createdAt: Date.now() },
      zwei: { userId: ZWEI, username: 'zwei', passwordHash: hash, emailVerified: true, createdAt: Date.now() }
    },
    private: {}, shared, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {} }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-chatbuendel-' + process.pid + '.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-chatb-'));
let srv = null;
function aufraeumen() {
  try { if (srv) srv.kill(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', aufraeumen);

async function starteServer() {
  let log = '';
  srv = spawn(process.execPath, [path.join(WURZEL, SERVER_DATEI)], {
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

(async () => {
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb()));
  const s = await starteServer();
  const tok = await s.anmelden('eins');
  const tokZwei = await s.anmelden('zwei');
  check('0-vorab: Server gestartet, beide Konten angemeldet', !!tok && !!tokZwei, { tok: !!tok, tokZwei: !!tokZwei });
  const auth = t => ({ headers: { Authorization: 'Bearer ' + t } });

  // Der Start-Tick (setImmediate) hat pruneChatKeys laengst gerufen, bevor /health antwortet -
  // trotzdem eine kurze Wartezeit als Puffer, damit die Retention-Messung nie ein Rennen ist.
  await warte(600);

  // --- 1: globaler Kanal, Vorgabe- und Volltiefe ---
  // Nach der Beschneidung stehen 300 Schluessel: g10..g308 (299 Nachrichten) + der kaputte.
  // Die letzten 50 Schluessel sind g259..g308 (der kaputte liegt bei Index 241 von 299 - siehe
  // Kopfkommentar-Rechnung), die Vorgabetiefe liefert also exakt 50 gueltige Nachrichten.
  const g50 = await s.j('/chat/global', auth(tok));
  const n50 = (g50.body && g50.body.nachrichten) || [];
  check('1a: global ohne limit liefert genau 50 Nachrichten', g50.status === 200 && n50.length === 50,
    { status: g50.status, anzahl: n50.length });
  check('1b: es sind die NEUESTEN 50, aufsteigend sortiert (g259..g308)',
    n50.length === 50 && n50[0].text === 'g259' && n50[49].text === 'g308' &&
    n50.every((m, i) => i === 0 || n50[i - 1].time <= m.time),
    { erste: n50[0] && n50[0].text, letzte: n50[49] && n50[49].text });
  check('1c: neuesteTs ist der groesste Zeitstempel des Kanals',
    g50.body && g50.body.neuesteTs === gTs(308), { neuesteTs: g50.body && g50.body.neuesteTs, erwartet: gTs(308) });
  const g300 = await s.j('/chat/global?limit=300', auth(tok));
  const n300 = (g300.body && g300.body.nachrichten) || [];
  check('1d: kaputter Eintrag wird uebersprungen, seine Nachbarn kommen an',
    n300.length === 299 && n300.some(m => m.text === 'g250') && n300.some(m => m.text === 'g251'),
    { anzahl: n300.length, g250: n300.some(m => m.text === 'g250'), g251: n300.some(m => m.text === 'g251') });

  // --- 2: limit-Verhalten ---
  const g5 = await s.j('/chat/global?limit=5', auth(tok));
  const n5 = (g5.body && g5.body.nachrichten) || [];
  check('2a: limit=5 liefert die neuesten 5 (g304..g308)',
    n5.length === 5 && n5[0].text === 'g304' && n5[4].text === 'g308',
    { anzahl: n5.length, erste: n5[0] && n5[0].text, letzte: n5[4] && n5[4].text });
  const gAbc = await s.j('/chat/global?limit=abc', auth(tok));
  const nAbc = (gAbc.body && gAbc.body.nachrichten) || [];
  check('2b: unbrauchbares limit faellt auf die Vorgabe 50 zurueck',
    gAbc.status === 200 && nAbc.length === 50, { status: gAbc.status, anzahl: nAbc.length });
  const gRiesig = await s.j('/chat/global?limit=999999', auth(tok));
  const nRiesig = (gRiesig.body && gRiesig.body.nachrichten) || [];
  check('2c: limit weit ueber dem Deckel wird nicht abgelehnt und liefert hoechstens die Aufbewahrungstiefe',
    gRiesig.status === 200 && nRiesig.length === 299, { status: gRiesig.status, anzahl: nRiesig.length });

  // --- 3: Allianz-Kanal ---
  const al = await s.j('/chat/allianz?tag=TESTA', auth(tok));
  const nAl = (al.body && al.body.nachrichten) || [];
  check('3a: Allianz-Kanal sortiert NUMERISCH - der zehnstellige Pruefstein steht vorne',
    al.status === 200 && nAl.length === 5 && nAl[0].text === 'uralt' && nAl[4].text === 'a3',
    { status: al.status, reihenfolge: nAl.map(m => m.text) });
  check('3b: neuesteTs des Allianz-Kanals ist der groesste echte Zeitstempel, nicht der Pruefstein',
    al.body && al.body.neuesteTs === gTs(1003), { neuesteTs: al.body && al.body.neuesteTs, erwartet: gTs(1003) });
  const alFremd = await s.j('/chat/allianz?tag=TESTA', auth(tokZwei));
  check('3c: ein Nicht-Mitglied darf lesen - Paritaet zum alten storage-Weg, bewusste Haltung',
    alFremd.status === 200 && (alFremd.body.nachrichten || []).length === 5,
    { status: alFremd.status, anzahl: (alFremd.body.nachrichten || []).length });

  // --- 4: Ablehnungen (jede nennt ihren Grund, Regel 37) ---
  const tagDoppelpunkt = await s.j('/chat/allianz?tag=' + encodeURIComponent('AB:CD'), auth(tok));
  check('4a: Tag mit Doppelpunkt wird mit 400 abgelehnt', tagDoppelpunkt.status === 400,
    { status: tagDoppelpunkt.status, body: tagDoppelpunkt.body });
  const tagLang = await s.j('/chat/allianz?tag=' + 'X'.repeat(17), auth(tok));
  check('4b: Tag ueber 16 Zeichen wird mit 400 abgelehnt', tagLang.status === 400, { status: tagLang.status });
  const tagLeer = await s.j('/chat/allianz', auth(tok));
  check('4c: fehlender Tag wird mit 400 abgelehnt', tagLeer.status === 400, { status: tagLeer.status });
  const kanalFalsch = await s.j('/chat/irgendwas', auth(tok));
  check('4d: unbekannter Kanal wird mit 400 abgelehnt', kanalFalsch.status === 400, { status: kanalFalsch.status });
  const ohneLogin = await s.j('/chat/global');
  check('4e: ohne Anmeldung 401', ohneLogin.status === 401, { status: ohneLogin.status });

  // --- 5: Retention 300 (der Start-Tick hat beschnitten) ---
  const liste = await s.j('/storage-list?prefix=' + encodeURIComponent('globalchat:msg:'), auth(tok));
  const keys = (liste.body && liste.body.keys) || [];
  check('5a: nach dem Start-Tick stehen genau 300 globale Chat-Schluessel', keys.length === 300,
    { anzahl: keys.length });
  check('5b: die aeltesten 10 sind weg (g9 fehlt), g10 ist die aelteste verbleibende',
    n300.length > 0 && n300[0].text === 'g10' && !n300.some(m => m.text === 'g9'),
    { aelteste: n300[0] && n300[0].text });
  check('5c: der alte Lese-Weg (storage-list) sieht dieselbe Wahrheit wie der Buendel-Abruf',
    keys.length === n300.length + 1, // +1 = der kaputte Eintrag, den der Buendel-Abruf ueberspringt
    { schluessel: keys.length, nachrichten: n300.length });

  if (fail) { console.log('\nFEHLGESCHLAGEN'); process.exitCode = 1; }
  else { console.log('\nAlles gruen (19 Pruefungen)'); }
  aufraeumen();
  process.exit(process.exitCode || 0);
})().catch(e => { console.log('FAIL - Testlauf abgestuerzt | ' + (e && e.message)); aufraeumen(); process.exit(1); });
