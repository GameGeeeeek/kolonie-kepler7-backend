// Off-Site-Sicherung: die Abholung durch den M715q (02.09.2026, Strukturpruefung C1).
//
// BEFUND: db.json und ALLE 48 Sicherungen liegen im selben Volume auf dem Pi. Sie schuetzen gegen
// Beschaedigung und Fehlbedienung - gegen den Verlust der Maschine schuetzen sie nicht, weil sie
// mit ihr verschwinden. Es gab bis hierher keine Kopie auf einer zweiten Maschine.
//
// GEMESSEN WIRD AN EINEM WIRKLICH LAUFENDEN SERVER (kein Quelltext-Test):
//   1) Die Wache: fehlender, falscher und nicht eingerichteter Token sind DREI unterscheidbare
//      Antworten. Die Zusammenfassung "ungueltig ODER fehlend" hat im AI-Core-Repo eine ganze
//      Fehlersuche gekostet; genannt wird die LAENGE des Empfangenen, nie der Wert.
//   2) Die Datei: was ankommt, ist byteweise die Datei aus BACKUP_DIR, und die mitgeschickte
//      Pruefsumme passt dazu. Eine unterwegs abgeschnittene Datei sieht sonst aus wie eine Sicherung.
//   3) Der Ausbruchschutz an ?datei= - und dass die Wache VOR ihm greift.
//   4) Der Vermerk auf dem Pi ueberlebt einen SIGKILL. Er ist die einzige Stelle, an der ein
//      toter Timer auf dem M715q ueberhaupt auffaellt (/api/health, ohne Anmeldung lesbar).
//   5) FAIL-CLOSED: ohne BACKUP_PULL_TOKEN gibt es keinen Datenweg, auch nicht versehentlich.
//   6) Die Drosselung gegen das Durchprobieren des Tokens.
//
// PAARE (Arbeitsregel 61): 1a/1b (fehlend vs. falsch), 4a/4b (vorher null, nachher eine Zahl),
// 5a/5b (ohne Einrichtung ist AUCH der richtig aussehende Token wirkungslos - sonst belegte 5a
// nur, dass irgendein Token nicht passt).
//
// GEGENPROBE (Arbeitsregel 1), gemessen: gegen origin/master vor dieser Aenderung fallen 29 der
// 30 Pruefungen; gruen bleibt allein 0-vorab, und das ist die Aufbau-Pruefung (Arbeitsregel 34) -
// sie sagt nur, dass das Messwerkzeug selbst laeuft. Prueflisten beider Laeufe per diff
// verglichen, nicht gezaehlt.
// Im ersten Anlauf blieben vier weitere gruen, und zwar AUS DEM FALSCHEN GRUND (Arbeitsregel 28):
// Wo es die Route nicht gibt, antwortet alles mit 404, und in einer 404 steht nun einmal kein
// Datenbankinhalt. 1c, 3a2, 3b und 5d verlangen deshalb zuerst einen WERT - die benannte Absage
// mit ihrem Grund - und erst danach die Abwesenheit von Daten.
//
// PORT 3249: gemessen belegt sind 3187-3248 in beiden Repos
// (`grep -hoE "3[12][0-9][0-9]" tests/*.js | sort -un`) - ein neuer Test nimmt 3250.
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3249);
const SERVER_JS = process.env.KEPLER_SERVER_JS || path.join(WURZEL, 'server.js');
const TOKEN = crypto.randomBytes(32).toString('hex');

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const hash = bcrypt.hashSync('test1234', 10);
const ADMIN = crypto.randomUUID(), ANNA = crypto.randomUUID(), BEN = crypto.randomUUID();
const jetzt = Date.now();
const grunddb = () => ({
  users: {
    gamegeeeeek: { userId: ADMIN, username: 'GameGeeeeek', passwordHash: hash, createdAt: jetzt },
    anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: jetzt },
    ben: { userId: BEN, username: 'ben', passwordHash: hash, createdAt: jetzt }
  },
  private: {}, shared: {}, resetTokens: {}, feedback: [],
  galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
    news: [], activeWar: null, activeWormhole: null, lastTick: jetzt, factions: {},
    alienPause: { kryll: jetzt + 9e8, xantheer: jetzt + 9e8, vex: jetzt + 9e8, verglueht: jetzt + 9e8 },
    alienNester: [] }
});

// DB und Sicherungen in einem eigenen Verzeichnis - BACKUP_DIR liegt neben DB_FILE.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-offsite-'));
const dbPfad = path.join(tmpDir, 'db.json');
const backupDir = path.join(tmpDir, 'backups');
let srv = null;
function aufraeumen() {
  try { if (srv) srv.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', aufraeumen);

const basis = 'http://127.0.0.1:' + PORT + '/api';
async function starteServer(mitToken) {
  let log = '';
  const env = Object.assign({}, process.env, {
    DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret',
    JWT_SECRET_FILE: path.join(tmpDir, 'jwt.txt'),
    VAPID_PUBLIC_FILE: path.join(tmpDir, 'vapid-pub.txt'),
    VAPID_PRIVATE_FILE: path.join(tmpDir, 'vapid-priv.txt')
  });
  if (mitToken) env.BACKUP_PULL_TOKEN = TOKEN; else delete env.BACKUP_PULL_TOKEN;
  srv = spawn(process.execPath, [SERVER_JS], { cwd: WURZEL, env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(basis + '/health'); if (r.ok) break; } catch (e) {}
    await warte(250);
  }
  await warte(300);
  return { protokoll: () => log };
}
async function stoppeHart() { if (!srv) return; srv.kill('SIGKILL'); await warte(500); srv = null; }

const kopf = t => (t === null ? {} : { Authorization: 'Bearer ' + t });
async function j(pfad, t) {
  const r = await fetch(basis + pfad, { headers: kopf(t) });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text), roh: text }; }
  catch (e) { return { status: r.status, body: null, roh: text }; }
}
async function hole(pfad, t) {
  const r = await fetch(basis + pfad, { headers: kopf(t) });
  const buf = Buffer.from(await r.arrayBuffer());
  const h = {};
  r.headers.forEach((v, k) => { h[k] = v; });
  return { status: r.status, buf, h };
}
const health = async () => (await j('/health', null)).body || {};
// Rohe Anfrage ueber einen Socket: Ein konformer HTTP-Client weigert sich zu Recht, einen Umlaut
// in einer Kopfzeile zu senden (ERR_INVALID_CHAR) - genau der Fall muss aber messbar sein.
function rohAnfrage(pfad, kopfzeilen) {
  return new Promise((res, rej) => {
    const sock = net.connect(PORT, '127.0.0.1');
    let antwort = Buffer.alloc(0);
    const zeit = setTimeout(() => { sock.destroy(); rej(new Error('Zeitueberschreitung')); }, 8000);
    sock.on('connect', () => sock.write(Buffer.from(
      'GET ' + pfad + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n' +
      kopfzeilen.join('\r\n') + '\r\n\r\n', 'latin1')));
    sock.on('data', d => { antwort = Buffer.concat([antwort, d]); });
    sock.on('end', () => { clearTimeout(zeit); res(antwort.toString('latin1')); });
    sock.on('error', e => { clearTimeout(zeit); rej(e); });
  });
}
const enthaeltDaten = t => /passwordHash|resetTokens/.test(String(t || ''));

(async () => {
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb()));
  let s = await starteServer(true);

  // Der Startlauf legt aus der vorhandenen db.json sofort eine Sicherung an - genau die wird
  // gleich abgeholt. Ohne sie waere jede Messung hier eine Messung am leeren Verzeichnis.
  const dateien = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter(f => /^db-.*\.json$/.test(f)) : [];
  check('0-vorab: der Server laeuft und hat beim Start eine Sicherung angelegt', dateien.length === 1, dateien);
  if (!dateien.length) { console.log(s.protokoll().slice(-1500)); process.exit(1); }
  const backupName = dateien[0];
  const backupBytes = fs.readFileSync(path.join(backupDir, backupName));

  // ---- 4a zuerst: der Zustand VOR der ersten Abholung ----
  const h0 = await health();
  check('4a: vor der ersten Abholung meldet /api/health offsiteAlterMin = null',
    'offsiteAlterMin' in h0 && h0.offsiteAlterMin === null, { offsiteAlterMin: h0.offsiteAlterMin });

  // ---- 1) Die Wache ----
  const r1a = await j('/offsite/backup', null);
  check('1a: ohne Token 401, und die Meldung sagt FEHLEND',
    r1a.status === 401 && /Kein Abhol-Token/i.test(r1a.body && r1a.body.error), { status: r1a.status, fehler: r1a.body && r1a.body.error });
  const falsch = 'x'.repeat(TOKEN.length);
  const r1b = await j('/offsite/backup', falsch);
  check('1b: mit falschem Token 401, und die Meldung sagt FALSCH und nennt die LAENGE',
    r1b.status === 401 && /stimmt nicht/i.test(r1b.body && r1b.body.error) && String(r1b.body.error).includes(String(falsch.length)),
    { status: r1b.status, fehler: r1b.body && r1b.body.error });
  check('1c: beide Absagen sind UNSERE Absagen und nennen weder den echten Token noch Datenbankinhalt',
    !!(r1a.body && r1a.body.error) && !!(r1b.body && r1b.body.error) &&
    !r1a.roh.includes(TOKEN) && !r1b.roh.includes(TOKEN) && !enthaeltDaten(r1a.roh) && !enthaeltDaten(r1b.roh));
  let roh1d = '';
  try { roh1d = await rohAnfrage('/api/offsite/backup', ['Authorization: Bearer tökén-mit-umlaut']); }
  catch (e) { roh1d = 'FEHLER ' + e.message; }
  check('1d: ein Umlaut im Token ergibt eine saubere 401, keinen 500er',
    / 401 /.test(roh1d) && !/ 500 /.test(roh1d), roh1d.split('\r\n')[0]);
  const r1e = await hole('/offsite/backup', TOKEN);
  check('1e: mit richtigem Token 200', r1e.status === 200, { status: r1e.status });

  // ---- 2) Die Datei ----
  check('2a: der Koerper ist die Sicherung - byteweise dieselbe Datei wie in BACKUP_DIR',
    r1e.buf.equals(backupBytes), { empfangen: r1e.buf.length, aufPlatte: backupBytes.length });
  const summe = crypto.createHash('sha256').update(r1e.buf).digest('hex');
  check('2b: die mitgeschickte Pruefsumme passt zum Empfangenen',
    r1e.h['x-backup-sha256'] === summe, { kopf: r1e.h['x-backup-sha256'], nachgerechnet: summe });
  check('2c: X-Backup-Groesse nennt die tatsaechliche Byte-Zahl',
    Number(r1e.h['x-backup-groesse']) === r1e.buf.length, { kopf: r1e.h['x-backup-groesse'], wirklich: r1e.buf.length });
  check('2d: X-Backup-Datei nennt den Namen der Sicherung', r1e.h['x-backup-datei'] === backupName, r1e.h['x-backup-datei']);
  let inhalt = null;
  try { inhalt = JSON.parse(r1e.buf.toString('utf8')); } catch (e) {}
  check('2e: das Abgeholte ist gueltiges JSON mit allen drei Konten',
    !!inhalt && Object.keys(inhalt.users || {}).length === 3, inhalt ? Object.keys(inhalt.users || {}) : 'nicht lesbar');
  const st = await j('/offsite/stand', TOKEN);
  check('2f: /api/offsite/stand nennt dieselbe Kontenzahl - der Massstab, an dem die Gegenseite eine geschrumpfte Sicherung erkennt',
    st.status === 200 && st.body.konten === Object.keys(inhalt.users).length && st.body.neuestes && st.body.neuestes.datei === backupName,
    { status: st.status, konten: st.body && st.body.konten, neuestes: st.body && st.body.neuestes });
  check('2g: /api/offsite/stand verlangt denselben Token', (await j('/offsite/stand', null)).status === 401);

  // ---- 3) Auswahl und Ausbruchschutz ----
  const a3 = [];
  for (const p of ['../../db.json', '../db.json', 'db-x/../../../etc/passwd', 'db-a.json%00', '']) {
    a3.push({ p, r: await hole('/offsite/backup?datei=' + encodeURIComponent(p) + (p ? '' : '&leer=1'), TOKEN) });
  }
  const ausbrueche = a3.slice(0, 4);
  check('3a: jeder Ausbruchversuch an ?datei= wird mit 400 abgewiesen',
    ausbrueche.every(x => x.r.status === 400), ausbrueche.map(x => [x.p, x.r.status]));
  check('3a2: jede dieser Absagen ist eine benannte Absage mit Grund und ohne Dateiinhalt',
    ausbrueche.every(x => {
      let b = null; try { b = JSON.parse(x.r.buf.toString('utf8')); } catch (e) {}
      return !!(b && /Ungueltiger Backup-Name/.test(b.error)) && !enthaeltDaten(x.r.buf.toString('utf8'));
    }), ausbrueche.map(x => x.r.buf.toString('utf8').slice(0, 60)));
  const r3b = await hole('/offsite/backup?datei=db-gibtesnicht.json', TOKEN);
  check('3b: ein nicht vorhandener, gueltig benannter Name ergibt UNSERE 404 mit Begruendung - nicht die des Frameworks',
    r3b.status === 404 && /gibt es nicht/.test(r3b.buf.toString('utf8')), r3b.buf.toString('utf8').slice(0, 80));
  const r3c = await hole('/offsite/backup?datei=' + backupName, TOKEN);
  check('3c: der ausdrueckliche Name liefert dieselbe Datei wie die Vorgabe (neueste)',
    r3c.status === 200 && r3c.buf.equals(backupBytes));
  const r3d = await hole('/offsite/backup?datei=../../db.json', null);
  check('3d: der Ausbruchversuch OHNE Token endet an der WACHE (401), nicht erst an der Pruefung (400) - die Reihenfolge stimmt',
    r3d.status === 401, { status: r3d.status });

  // ---- 4) Der Vermerk auf dem Pi ----
  const h1 = await health();
  check('4b: nach der Abholung meldet /api/health ein Alter als Zahl',
    typeof h1.offsiteAlterMin === 'number' && h1.offsiteAlterMin >= 0 && h1.offsiteAlterMin < 5, { offsiteAlterMin: h1.offsiteAlterMin });
  const st2 = await j('/offsite/stand', TOKEN);
  check('4c: /api/offsite/stand nennt den Zeitpunkt der letzten Abholung',
    st2.body && typeof st2.body.letzteAbholung === 'number' && Math.abs(Date.now() - st2.body.letzteAbholung) < 60000,
    { letzteAbholung: st2.body && st2.body.letzteAbholung });
  // SIGKILL, nicht SIGTERM (Arbeitsregel 78): SIGTERM flusht die DB und verdeckt ein fehlendes
  // saveDb() im Vermerk. Ein Vermerk, der nur im RAM steht, waere nach jedem Deploy wieder null -
  // und der Waechter meldete dann bei JEDEM Neustart einen Ausfall, den es nicht gibt.
  await warte(900);
  await stoppeHart();
  s = await starteServer(true);
  const h2 = await health();
  check('4d: der Vermerk ueberlebt einen SIGKILL - er ist wirklich gespeichert',
    typeof h2.offsiteAlterMin === 'number' && h2.offsiteAlterMin >= 0, { offsiteAlterMin: h2.offsiteAlterMin });

  // ---- 6) Drosselung (vor dem Neustart ohne Token - die Zaehler leben nur im RAM) ----
  let letzte = null;
  for (let i = 0; i < 24; i++) letzte = await j('/offsite/backup', falsch);
  check('6a: nach genug Fehlversuchen kommt 429 statt einer weiteren 401',
    letzte.status === 429, { status: letzte.status, fehler: letzte.body && letzte.body.error });
  const r6b = await fetch(basis + '/offsite/backup', { headers: kopf(falsch) });
  check('6b: die Absage nennt Retry-After, sagt also WANN ein neuer Versuch Sinn hat',
    !!r6b.headers.get('retry-after'), r6b.headers.get('retry-after'));

  // ---- 5) Fail-closed: derselbe Server, nur ohne BACKUP_PULL_TOKEN ----
  await stoppeHart();
  s = await starteServer(false);
  const r5a = await hole('/offsite/backup', TOKEN);
  check('5a: OHNE Einrichtung ist auch der richtige Token wirkungslos - 503, kein Datenweg',
    r5a.status === 503, { status: r5a.status });
  const r5b = await j('/offsite/backup', null);
  check('5b: und ohne Token kommt DIESELBE 503, nicht 401 - "nicht eingerichtet" bleibt vom Zugriffsfehler unterscheidbar',
    r5b.status === 503, { status: r5b.status });
  check('5c: die Antwort benennt die fehlende Variable',
    /BACKUP_PULL_TOKEN/.test(r5b.body && r5b.body.error), r5b.body && r5b.body.error);
  check('5d: beide Absagen sind benannte Absagen ohne jeden Datenbankinhalt',
    /nicht eingerichtet/.test(r5a.buf.toString('utf8')) && !!(r5b.body && r5b.body.error) &&
    !enthaeltDaten(r5a.buf.toString('utf8')) && !enthaeltDaten(r5b.roh),
    r5a.buf.toString('utf8').slice(0, 80));
  check('5e: /api/offsite/stand ist ebenfalls zu', (await j('/offsite/stand', TOKEN)).status === 503);
  const h3 = await health();
  check('5f: /api/health antwortet weiter und nennt das Alter unveraendert',
    h3.ok === true && typeof h3.offsiteAlterMin === 'number', { ok: h3.ok, offsiteAlterMin: h3.offsiteAlterMin });

  await stoppeHart();
  console.log(fail ? '\nFAIL - mindestens eine Pruefung ist gefallen' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('Testlauf abgebrochen:', e); process.exit(1); });
