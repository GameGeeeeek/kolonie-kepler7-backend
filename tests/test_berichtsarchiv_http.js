// Berichts-Archiv: größer für Unterstützer, aber es räumt NIE ab (16.08.2026).
//
// DIE EIGENTLICHE FRAGE WAR NICHT DIE ZAHL, SONDERN DER ABLAUF
// -----------------------------------------------------------
// Ein schlichtes `list.slice(0, deckel)` hätte einem ehemaligen Unterstützer beim nächsten Kampf
// über hundert Kampfberichte gelöscht - unbemerkt, denn er sieht es erst, wenn er nachsehen will.
// Ein Deckel, der Historie vernichtet, sobald jemand aufhört zu spenden, bestraft das Aufhören,
// statt das Unterstützen zu belohnen. Der Deckel begrenzt deshalb nur das WACHSTUM: behalten wird
// immer mindestens so viel, wie vor dem neuen Bericht schon dalag.
//
// GEPRÜFT WIRD:
//   1. Ohne Rang deckelt das Archiv bei REPORTS_MAX_STANDARD.
//   2. Mit Rang wächst es über diesen Wert hinaus.
//   3. NACH ABLAUF des Rangs bleibt es stehen - kein einziger Bericht verschwindet. Das ist der
//      Kern der Datei und nur mit einem zweiten Serverstart prüfbar, weil die Bedingung an der
//      Uhr hängt.
//   4. Nach oben ist trotzdem Schluss: über REPORTS_MAX_SUPPORTER wächst nichts.
//
// AUSFÜHREN (Serverstart und Test im selben Bash-Aufruf):
//   DB=$(mktemp /tmp/kepler-arch-XXXX.json); rm -f "$DB"; export DB_FILE="$DB"
//   PORT=3216 JWT_SECRET=test node server.js > /tmp/a1.log 2>&1 &
//   PID=$!; sleep 3; node tests/test_berichtsarchiv_http.js teil1; kill $PID; sleep 1
//   node -e "...supporterGrantUntil in die ZUKUNFT setzen..."
//   PORT=3216 JWT_SECRET=test node server.js > /tmp/a2.log 2>&1 &
//   PID=$!; sleep 3; node tests/test_berichtsarchiv_http.js teil2; kill $PID; sleep 1
//   node -e "...supporterGrantUntil in die VERGANGENHEIT setzen..."
//   PORT=3216 JWT_SECRET=test node server.js > /tmp/a3.log 2>&1 &
//   PID=$!; sleep 3; node tests/test_berichtsarchiv_http.js teil3; kill $PID; rm -f "$DB"
//
// GEGENPROBE, in beide Richtungen gefahren (16.08.2026):
//   Gegen den alten server.js:  FAIL - 2: mit Rang wächst das Archiv über den Standard hinaus
//   Gegen eine Kopie mit `list.slice(0, reportLimitFor(userId))` (also OHNE die Wachstumsregel):
//     Teil 1+2 grün, Teil 3 rot - "3: nach Ablauf verschwindet kein Bericht" meldet 40 statt 60.
//     Genau der Datenverlust, den die Regel verhindert.

const BASIS = 'http://127.0.0.1:3216/api';
const TEIL = process.argv[2] || 'teil1';
const NUTZER = 'archivpruef';
const PASSWORT = 'geheim12345';

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };

async function j(pfad, opt) {
  const r = await fetch(BASIS + pfad, opt);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; }
  catch (e) { return { status: r.status, body: t.slice(0, 200) }; }
}
const alsNutzer = (token, extra) => Object.assign({ 'Authorization': 'Bearer ' + token }, extra || {});
const anmelden = async () => {
  const r = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: NUTZER, password: PASSWORT }) });
  return (r.body && r.body.token) || null;
};
const archivVon = async (token) => {
  const r = await j('/reports', { headers: alsNutzer(token) });
  return { anzahl: ((r.body || {}).reports || []).length, archiv: (r.body || {}).archiv || {} };
};
// Berichte über den öffentlichen Endpunkt anlegen - derselbe Weg, den das Spiel nimmt.
async function berichteAnlegen(token, wieviele, praefix) {
  for (let i = 0; i < wieviele; i++) {
    await j('/reports', { method: 'POST', headers: alsNutzer(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ report: { type: 'test', marke: praefix + '-' + i } }) });
  }
}

async function teil1() {
  const fs = require('fs');
  await j('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: NUTZER, password: PASSWORT, email: 'arch@example.invalid' }) });
  await new Promise(r => setTimeout(r, 900));
  const db = JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8'));
  const u = db.users[NUTZER];
  check('Testkonto angelegt', !!u);
  const e = Object.entries(db.verifyTokens || {}).find(([, v]) => u && v.userId === u.userId);
  if (e) await j('/verify-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: e[0] }) });
  const token = await anmelden();
  check('Anmeldung erfolgreich', !!token);
  if (!token) return;

  // Die Grenzen kommen vom Server - nicht eingetippt (CLAUDE.md-Regel 2).
  const leer = await archivVon(token);
  const std = leer.archiv.standard, sup = leer.archiv.unterstuetzer;
  check('1-vorab: der Server nennt seine beiden Grenzen', typeof std === 'number' && typeof sup === 'number' && sup > std, leer.archiv);
  if (typeof std !== 'number') return;

  // ---- 1. Ohne Rang deckelt es beim Standard ---------------------------------------------------
  await berichteAnlegen(token, std + 15, 'a');
  const ohne = await archivVon(token);
  check('1: ohne Rang deckelt das Archiv beim Standard', ohne.anzahl === std, { anzahl: ohne.anzahl, standard: std });
  check('1: und meldet den Platz passend', ohne.archiv.platz === std, ohne.archiv);
  await new Promise(r => setTimeout(r, 900));
}

// Ab hier hat der Aufrufer dem Konto einen Unterstützer-Rang gegeben (in der Zukunft).
async function teil2() {
  const token = await anmelden();
  check('2: Anmeldung nach Neustart', !!token);
  if (!token) return;
  const vor = await archivVon(token);
  const std = vor.archiv.standard, sup = vor.archiv.unterstuetzer;
  check('2-vorab: der Rang ist angekommen', vor.archiv.platz === sup, vor.archiv);

  // ---- 2. Mit Rang wächst es über den Standard hinaus -------------------------------------------
  await berichteAnlegen(token, 20, 'b');
  const mit = await archivVon(token);
  check('2: mit Rang wächst das Archiv über den Standard hinaus', mit.anzahl > std, { anzahl: mit.anzahl, standard: std });

  // ---- 2b. Und die Unterstützer-Grenze hält AUCH WIRKLICH ---------------------------------------
  // Bewusst hier und nicht nach dem Ablauf: Dort ist das Wachstum ohnehin eingefroren, ein
  // "anzahl <= deckel" wäre trivial erfüllt und würde nichts belegen (CLAUDE.md-Regel 28).
  // Geprüft wird auf GLEICHHEIT, nicht auf "kleiner gleich" - genau der Deckel, nicht irgendeine
  // Zahl darunter.
  await berichteAnlegen(token, sup - mit.anzahl + 25, 'b2');
  const voll = await archivVon(token);
  check('2b: über die Unterstützer-Grenze wächst nichts', voll.anzahl === sup, { anzahl: voll.anzahl, deckel: sup });
  await new Promise(r => setTimeout(r, 900));
}

// Ab hier ist der Rang ABGELAUFEN.
async function teil3() {
  const token = await anmelden();
  check('3: Anmeldung nach Ablauf', !!token);
  if (!token) return;
  const vorher = await archivVon(token);
  const std = vorher.archiv.standard;
  // Vorab: Der Zustand, um den es geht, muss überhaupt vorliegen - sonst prüft der Rest nichts
  // (CLAUDE.md-Regel 37).
  check('3-vorab: das Archiv liegt über dem Standard', vorher.anzahl > std, { anzahl: vorher.anzahl, standard: std });

  // ---- 3. DER KERN: ein neuer Bericht darf nichts abräumen --------------------------------------
  // Auf GLEICHHEIT geprüft: eingefroren heißt weder kleiner (Datenverlust) noch größer (der Rang
  // ist abgelaufen, es darf auch nichts mehr dazukommen).
  await berichteAnlegen(token, 3, 'c');
  const nachher = await archivVon(token);
  check('3: nach Ablauf verschwindet kein Bericht', nachher.anzahl === vorher.anzahl,
    { vorher: vorher.anzahl, nachher: nachher.anzahl, standard: std });
  // Und der gemeldete Platz sagt die Wahrheit statt der nominellen Standard-Grenze.
  check('3: der gemeldete Platz spiegelt den eingefrorenen Stand', nachher.archiv.platz === nachher.anzahl,
    nachher.archiv);
  // Der neueste Bericht muss trotzdem angekommen sein - eingefroren heißt "so viele wie vorher",
  // nicht "keine neuen mehr". Sonst wäre die Prüfung darüber auch mit einem toten Endpunkt grün.
  const r = await j('/reports', { headers: alsNutzer(token) });
  const marken = ((r.body || {}).reports || []).map(x => x.marke);
  check('3: der neueste Bericht steht trotzdem vorn', marken[0] === 'c-2', { erste: marken.slice(0, 3) });
}

(async () => {
  try {
    if (TEIL === 'teil2') await teil2();
    else if (TEIL === 'teil3') await teil3();
    else await teil1();
  } catch (e) {
    check('Ablauf ohne Absturz', false, String((e && e.message) || e));
  }
  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nalles gruen');
  process.exit(fail ? 1 : 0);
})();
