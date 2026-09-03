// Woher ein Konto kam (03.09.2026, Auftrag Sascha).
//
// DER ANLASS, woertlich: "macht es sinn auf tiktok werbung zu schalten ?" - und die Antwort war
// nein, unter anderem weil im ganzen Spiel NULL Kampagnen-Messung existierte (gemessen: 0 Treffer
// fuer utm_source, utm_campaign, document.referrer, gtag(, ttq, fbq(, dataLayer). Wer Geld fuer
// Klicks ausgibt und hinterher nicht sagen kann, wie viele davon ein Konto angelegt haben, spendet.
//
// DIE ENTSCHEIDUNG, DIE DIESER TEST ABSICHERT (Abschnitt 2b): Die Herkunft liegt am NUTZEROBJEKT,
// nicht im Spielstand. Der Spielstand ist bauartbedingt klientenautoritativ und wird beim naechsten
// regulaeren Speichern ueberschrieben - die Herkunft waere nach der ersten Sitzung weg, und die
// Auswertung haette still nur noch Konten von heute Vormittag gezaehlt. Dieselbe Begruendung wie
// bei `user.staub` und der Bonuscode-Einloesesperre.
//
// DIE ZWEITE ENTSCHEIDUNG (Abschnitt 4c): Ein Konto OHNE Feld zaehlt als "(unbekannt)", nie als
// "direkt". Alle Konten von vor dieser Aenderung haben kein Feld; sie als Direktzugriffe zu zaehlen
// waere eine erfundene Zahl - und zwar ausgerechnet in der Ansicht, die eine Kaufentscheidung
// tragen soll.
//
// WAS DIESER TEST NICHT KANN: pruefen, ob der Browser die UTM-Parameter wirklich einsammelt. Das
// ist die Frontend-Haelfte und hat dort ihren eigenen Waechter (test_herkunft.js). Hier wird
// ausschliesslich gemessen, was der Server aus dem entgegengenommenen Feld macht.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3253);

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ADMIN = crypto.randomUUID(), ANNA = crypto.randomUUID();

function spielstand(id, name) {
  return {
    resources: { energie: 1e5, erz: 1e5, kristalle: 1e5, deuterium: 1e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {}, fleet: { missions: [] },
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  };
}
function grunddb() {
  return {
    // Der Schluessel MUSS 'gamegeeeeek' kleingeschrieben sein - daran haengt isAdmin.
    users: {
      gamegeeeeek: { userId: ADMIN, username: 'GameGeeeeek', passwordHash: hash, createdAt: Date.now() },
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() }
    },
    private: {
      [ADMIN]: { 'kepler7-save-v3': JSON.stringify(spielstand(ADMIN, 'GameGeeeeek')) },
      [ANNA]:  { 'kepler7-save-v3': JSON.stringify(spielstand(ANNA, 'anna')) }
    },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {} }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-herkunft-' + process.pid + '.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-herk-'));
let srv = null;
let s = null, tokAdmin = null, tokAnna = null;
function aufraeumen() {
  try { if (srv) srv.kill(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', aufraeumen);

async function starteServer() {
  let log = '';
  srv = spawn(process.execPath, [path.join(WURZEL, 'server.js')], {
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
async function stoppeServer() {
  if (!srv) return;
  srv.kill('SIGTERM');            // flusht die DB (Graceful Shutdown)
  await warte(700);
  srv = null;
}
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
// Eine Aenderung an der DB-DATEI bei laufendem Server ist beim naechsten Stopp wieder weg (der
// Graceful Shutdown flusht darueber). Deshalb: stoppen -> aendern -> starten.
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  s = await starteServer();
  tokAdmin = await s.anmelden('GameGeeeeek');
  tokAnna = await s.anmelden('anna');
}
const liesSave = (d, id) => {
  const roh = (d.private[id] || {})['kepler7-save-v3'];
  if (!roh) return null;
  try { return JSON.parse(typeof roh === 'string' ? roh : roh.value); } catch (e) { return null; }
};
const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
const jsonKopf = { 'Content-Type': 'application/json' };

// NICHT 'test1234' wie in den Bestandskonten: Das steht auf der Liste der haeufigsten Passwoerter,
// und `passwortProblem` lehnt es beim SETZEN ab (nie beim Login - deshalb duerfen die Fixture-Konten
// es per bcrypt.hashSync weiter tragen und sich anmelden). Wer das uebersieht, bekommt ein 400 und
// haelt es fuer einen Fehler der eigenen Aenderung.
const NEU_PW = 'probelauf-9271';
async function registriere(name, herkunft) {
  const body = { username: name, password: NEU_PW, email: name + '@example.invalid' };
  if (herkunft !== undefined) body.herkunft = herkunft;
  return s.j('/register', { method: 'POST', headers: jsonKopf, body: JSON.stringify(body) });
}
// Ein fehlendes Konto darf den Testlauf NICHT beenden (Hausregel 34): Ein Absturz beim Aufbau
// laesst die restlichen Pruefungen ungefahren, und der rote Exit-Code sieht aus wie eine
// vollstaendige Gegenprobe. Deshalb liefert der Helfer ein leeres Objekt statt undefined.
const nutzer = (d, name) => (d.users && d.users[name.toLowerCase()]) || {};

(async () => {
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  s = await starteServer();
  tokAdmin = await s.anmelden('GameGeeeeek');
  tokAnna = await s.anmelden('anna');
  check('0-bau: Admin und Anna sind angemeldet', !!tokAdmin && !!tokAnna, { admin: !!tokAdmin, anna: !!tokAnna });

  // --- 1: der Endpunkt gehoert dem Admin --------------------------------------------------
  const fremd = await s.j('/admin/herkunft', { headers: kopf(tokAnna) });
  check('1a Ein normaler Spieler kommt nicht an die Herkunfts-Auswertung', fremd.status === 403, { status: fremd.status });
  const ohneToken = await s.j('/admin/herkunft');
  check('1b Ohne Anmeldung erst recht nicht', ohneToken.status === 401 || ohneToken.status === 403, { status: ohneToken.status });
  const alsAdmin = await s.j('/admin/herkunft', { headers: kopf(tokAdmin) });
  check('1c Der Admin bekommt eine Auswertung', alsAdmin.status === 200 && Array.isArray(alsAdmin.body.quellen), { status: alsAdmin.status });

  // --- 2: die Herkunft wird gespeichert, und zwar am richtigen Ort -------------------------
  const r1 = await registriere('tikuser', { quelle: 'tiktok', medium: 'cpc', kampagne: 'test-a', verweis: 'tiktok.com' });
  check('2a-bau Die Registrierung mit Herkunft geht durch', r1.status === 200 || r1.status === 201, { status: r1.status, body: r1.body });
  await stoppeServer();
  let d = liesDb();
  const u1 = nutzer(d, "tikuser");
  check('2a Die Herkunft steht am Konto', !!(u1 && u1.herkunft && u1.herkunft.quelle === 'tiktok'),
        { herkunft: u1 && u1.herkunft });
  check('2a2 Alle vier Felder sind angekommen',
        !!(u1 && u1.herkunft && u1.herkunft.medium === 'cpc' && u1.herkunft.kampagne === 'test-a' && u1.herkunft.verweis === 'tiktok.com'),
        { herkunft: u1 && u1.herkunft });
  check('2a3 Ein Zeitstempel ist dabei', !!(u1 && u1.herkunft && typeof u1.herkunft.zeit === 'number' && u1.herkunft.zeit > 0),
        { zeit: u1 && u1.herkunft && u1.herkunft.zeit });
  // DIE Entscheidung dieses Tests: nicht im Spielstand. Dort waere sie beim naechsten Speichern weg.
  const save1 = liesSave(d, u1 && u1.userId);
  const imSave = save1 ? JSON.stringify(save1).toLowerCase().includes('tiktok') : false;
  check('2b Die Herkunft steht NICHT im (klientenautoritativen) Spielstand', !imSave, { imSpielstand: imSave });
  s = await starteServer();
  tokAdmin = await s.anmelden('GameGeeeeek');

  // --- 3: gesaeubert und begrenzt ----------------------------------------------------------
  const r2 = await registriere('boesuser', {
    quelle: 'tik<script>alert(1)</script>tok',
    medium: 'a'.repeat(200),
    kampagne: 'gut-1.0',
    verweis: 'beispiel.de/pfad?such=geheim'
  });
  check('3a-bau Auch diese Registrierung geht durch', r2.status === 200 || r2.status === 201, { status: r2.status });
  await stoppeServer();
  d = liesDb();
  const u2 = nutzer(d, 'boesuser');
  const h2 = (u2 && u2.herkunft) || {};
  check('3a Spitze Klammern und Anfuehrungszeichen sind raus',
        typeof h2.quelle === 'string' && !/[<>"'()/]/.test(h2.quelle), { quelle: h2.quelle });
  check('3b Ueberlange Werte sind gekappt (hoechstens 40 Zeichen)',
        typeof h2.medium === 'string' && h2.medium.length <= 40, { laenge: h2.medium && h2.medium.length });
  check('3c Ein harmloser Wert bleibt unveraendert', h2.kampagne === 'gut-1.0', { kampagne: h2.kampagne });
  // Die Gegenrichtung: Saeubern darf nicht ALLES wegwerfen, sonst waere die Messung wertlos.
  check('3d Der gesaeuberte Wert traegt noch Inhalt',
        typeof h2.quelle === 'string' && h2.quelle.includes('tik') && h2.quelle.includes('tok'), { quelle: h2.quelle });
  s = await starteServer();
  tokAdmin = await s.anmelden('GameGeeeeek');

  // --- 4: ohne Angabe kein Feld, und "unbekannt" ist nicht "direkt" ------------------------
  const r3 = await registriere('leeruser');                       // gar kein Feld mitgeschickt
  const r4 = await registriere('muelluser', { quelle: '///', medium: '<<<' });  // nur Unbrauchbares
  check('4a-bau Beide Registrierungen gehen durch',
        (r3.status === 200 || r3.status === 201) && (r4.status === 200 || r4.status === 201),
        { leer: r3.status, muell: r4.status });
  await stoppeServer();
  d = liesDb();
  check('4a Ohne Angabe entsteht gar kein herkunft-Feld', nutzer(d, 'leeruser').herkunft === undefined,
        { herkunft: nutzer(d, 'leeruser').herkunft });
  check('4b Bleibt nach dem Saeubern nichts uebrig, entsteht auch kein Feld',
        nutzer(d, 'muelluser').herkunft === undefined, { herkunft: nutzer(d, 'muelluser').herkunft });
  s = await starteServer();
  tokAdmin = await s.anmelden('GameGeeeeek');

  const aus = await s.j('/admin/herkunft', { headers: kopf(tokAdmin) });
  const q = (aus.body && aus.body.quellen) || [];
  const finde = t => q.find(x => x.quelle === t);
  const unbekannt = finde('(unbekannt)');
  check('4c Konten ohne Feld zaehlen als "(unbekannt)", nicht als "direkt"',
        !!unbekannt && !q.some(x => /direkt/i.test(x.quelle)), { quellen: q.map(x => x.quelle) });
  check('4c2 Und zwar alle vier: Admin, Anna, leeruser, muelluser',
        !!unbekannt && unbekannt.konten === 4, { konten: unbekannt && unbekannt.konten });

  // --- 5: der Trichter je Quelle MISST, statt nur zu beschriften ---------------------------
  // Zwei Quellen mit absichtlich verschiedenem Verlauf: bei "gut" ist das Konto bestaetigt und hat
  // gespielt, bei "schlecht" nicht. Ein Test mit gleichen Werten waere auch von einem Endpunkt
  // erfuellt, der ueberall dieselbe Zahl schreibt (Hausregel 61).
  await registriere('gutuser', { quelle: 'gutkanal' });
  await registriere('schlechtuser', { quelle: 'schlechtkanal' });
  await aendereDb(d2 => {
    const gu = nutzer(d2, 'gutuser');
    gu.emailVerified = true;
    d2.private[gu.userId] = { 'kepler7-save-v3': JSON.stringify(spielstand(gu.userId, 'gutuser')) };
    // Aktivitaet: 14 Tage lueckenlos, damit `belastbar` traegt (verlangt 24 beobachtete Stunden).
    gu.aktiv = {};
    for (let t = 0; t < 14; t++) {
      const tag = new Date(Date.now() - t * 86400000).toISOString().slice(0, 10);
      gu.aktiv[tag] = 0xFFFFFF;
    }
    // schlechtuser bleibt unbestaetigt, ohne Spielstand und ohne Aktivitaet.
  });
  const aus2 = await s.j('/admin/herkunft', { headers: kopf(tokAdmin) });
  const q2 = (aus2.body && aus2.body.quellen) || [];
  const gut = q2.find(x => x.quelle.startsWith('gutkanal'));
  const schlecht = q2.find(x => x.quelle.startsWith('schlechtkanal'));
  check('5-bau Beide Quellen tauchen getrennt auf', !!gut && !!schlecht, { quellen: q2.map(x => x.quelle) });
  check('5a Der gute Kanal ist bestaetigt und hat gespielt',
        !!gut && gut.konten === 1 && gut.bestaetigt === 1 && gut.gespielt === 1,
        { gut: gut && { konten: gut.konten, bestaetigt: gut.bestaetigt, gespielt: gut.gespielt } });
  check('5b Der schlechte Kanal hat dieselbe Kontozahl, aber KEINE Bestaetigung und kein Spiel',
        !!schlecht && schlecht.konten === 1 && schlecht.bestaetigt === 0 && schlecht.gespielt === 0,
        { schlecht: schlecht && { konten: schlecht.konten, bestaetigt: schlecht.bestaetigt, gespielt: schlecht.gespielt } });
  // Die eigentliche Aussage: gleich viele Konten, verschiedener Trichter. Genau das entscheidet
  // ueber eine Kampagne - eine Kopfzahl allein taete es nicht.
  check('5c Gleich viele Konten, aber messbar verschiedener Verlauf',
        !!gut && !!schlecht && gut.konten === schlecht.konten && gut.gespielt !== schlecht.gespielt,
        { konten: [gut && gut.konten, schlecht && schlecht.konten], gespielt: [gut && gut.gespielt, schlecht && schlecht.gespielt] });
  check('5d Der aktive Spieler ist als aktiv gezaehlt, der andere nicht',
        !!gut && gut.aktiv14 === 1 && !!schlecht && schlecht.aktiv14 === 0,
        { aktiv14: [gut && gut.aktiv14, schlecht && schlecht.aktiv14], zuJung: [gut && gut.zuJung, schlecht && schlecht.zuJung] });

  // --- 6: die Antwort nennt keine Namen ----------------------------------------------------
  const roh = JSON.stringify(aus2.body);
  const namen = ['gutuser', 'schlechtuser', 'tikuser', 'anna'];
  const verraten = namen.filter(n => roh.toLowerCase().includes(n));
  check('6a Die Auswertung ist aggregiert und nennt keine Spielernamen', verraten.length === 0, { verraten });
  const idsDrin = [ADMIN, ANNA].filter(id => roh.includes(id));
  check('6b Und keine Nutzer-Kennungen', idsDrin.length === 0, { idsDrin });

  await stoppeServer();
  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
