// Echter HTTP-Test der einmaligen Unterstützer-Testphase (15.08.2026).
//
// Geprüft werden die vier Eigenschaften, die still kaputtgehen können, ohne dass irgendwo ein
// Fehler auftaucht:
//   1. Sie schaltet die Funktionsfreigabe wirklich frei (active=true, quelle='testphase').
//   2. Sie vergibt KEIN Abzeichen - die Bestenliste muss isSupporter=false liefern. Das ist die
//      Trennung zwischen supporterFeaturesFor (Funktionen) und supporterStatusCombined (Rang);
//      wer sie eines Tages zusammenlegt, bekommt hier einen roten Test statt eines stillen
//      "Unterstützer"-Abzeichens für Leute, die nie unterstützt haben.
//   3. Sie ist EINMALIG - der zweite Aufruf wird abgelehnt.
//   4. Und zwar auch NACH ABLAUF. Das ist der eigentliche Grund für diesen Test: Die Sperre hängt
//      an `supporterTrialAt` (bleibt für immer stehen) und nicht an `supporterTrialUntil` (liegt
//      nach Ablauf in der Vergangenheit). Wer das verwechselt, baut aus der Testphase ein
//      unbegrenztes Gratisabo, und zwar unsichtbar - im Neuzustand verhält sich beides gleich.
//      Geprüft wird das mit einem ZWEITEN Serverstart auf derselben DB, deren Ablaufzeitpunkt
//      dazwischen in die Vergangenheit gesetzt wird.
//
// AUSFÜHREN (Serverstart und Test müssen im selben Bash-Aufruf laufen, sonst verliert die Sandbox
// den Hintergrundprozess - CLAUDE.md, Punkt 2 der Commit-Pflichten). Der Test startet den Server
// SELBST nicht; er läuft in zwei Abschnitten, gesteuert über das Argument:
//
//   DB=$(mktemp /tmp/kepler-trial-XXXX.json); rm -f "$DB"
//   DB_FILE=$DB PORT=3213 JWT_SECRET=test node server.js > /tmp/srv1.log 2>&1 &
//   PID=$!; sleep 2; DB_FILE=$DB node tests/test_unterstuetzer_testphase_http.js teil1; kill $PID
//   sleep 1
//   node -e "const f=process.env.DB_FILE,d=JSON.parse(require('fs').readFileSync(f,'utf8'));\
//     for(const k of Object.keys(d.users)) if(d.users[k].supporterTrialUntil) d.users[k].supporterTrialUntil=Date.now()-1000;\
//     require('fs').writeFileSync(f,JSON.stringify(d));" # Testphase künstlich ablaufen lassen
//   DB_FILE=$DB PORT=3213 JWT_SECRET=test node server.js > /tmp/srv2.log 2>&1 &
//   PID=$!; sleep 2; DB_FILE=$DB node tests/test_unterstuetzer_testphase_http.js teil2; kill $PID; rm -f "$DB"
//
// GEGENPROBE, in beide Richtungen ausgeführt (15.08.2026):
//   Gegen den alten server.js (git show HEAD:server.js in einen Ordner mit mailer.js gelegt):
//     FAIL - /api/me kennt die Testphase             | {"trial":null}
//     FAIL - Testphase laesst sich starten           | 404
//   Gegen den neuen Stand: alle Prüfungen grün.

const BASIS = 'http://127.0.0.1:3213/api';
const TEIL = process.argv[2] || 'teil1';
const NUTZER = 'trialpruef';
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

async function anmelden() {
  const r = await j('/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: NUTZER, password: PASSWORT })
  });
  return r.body && r.body.token;
}

async function teil1() {
  const fs = require('fs');
  const DB = process.env.DB_FILE;
  await j('/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: NUTZER, password: PASSWORT, email: 'trial@example.invalid' })
  });
  await new Promise(r => setTimeout(r, 900));   // saveDb() buendelt Schreibvorgaenge
  // Die Registrierung verlangt eine E-Mail-Bestaetigung; das Token steht nur in der DB.
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  const ziel = db.users[NUTZER];
  check('Testkonto angelegt', !!ziel, ziel ? ziel.username : null);
  const eintrag = Object.entries(db.verifyTokens || {}).find(([, v]) => ziel && v.userId === ziel.userId);
  check('Bestaetigungs-Token vorhanden', !!eintrag);
  if (eintrag) await j('/verify-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: eintrag[0] }) });
  const token = await anmelden();
  check('Anmeldung erfolgreich', !!token);
  if (!token) return;

  // ---- 1. Ausgangslage: keine Freigabe, Testphase verfuegbar ---------------------------------
  const vorher = await j('/me', { headers: alsNutzer(token) });
  const sv = (vorher.body || {}).supporter || {};
  check('/api/me kennt die Testphase', !!sv.trial, { trial: sv.trial || null });
  check('1: ohne alles keine Funktionsfreigabe', sv.active === false, { active: sv.active, quelle: sv.quelle });
  check('1: Testphase ist verfuegbar', !!(sv.trial && sv.trial.verfuegbar === true && sv.trial.aktiv === false), sv.trial);
  const angeboteneTage = sv.trial && sv.trial.tage;

  // ---- 2. Starten: Funktionen frei, aber ohne Stufe -------------------------------------------
  const start = await j('/supporter/trial', { method: 'POST', headers: alsNutzer(token) });
  check('2: Testphase laesst sich starten', start.status === 200 && start.body.ok === true, { status: start.status, body: start.body && start.body.error });
  const ss = (start.body || {}).supporter || {};
  check('2: Funktionsfreigabe ist aktiv', ss.active === true && ss.quelle === 'testphase', { active: ss.active, quelle: ss.quelle });
  check('2: keine Stufe vergeben', ss.tier === null, { tier: ss.tier });
  // Die angekuendigte Laufzeit muss die tatsaechliche sein - gemessen, nicht eingetippt
  // (CLAUDE.md-Regel 2): erwartet wird die Zahl, die der Server im Schritt davor selbst genannt hat.
  const restTage = (start.body.bis - Date.now()) / 86400000;
  check('2: Laufzeit entspricht der angekuendigten', Math.abs(restTage - angeboteneTage) < 0.01,
    { angekuendigt: angeboteneTage, gemessen: Math.round(restTage * 1000) / 1000 });

  // ---- 3. KEIN Abzeichen ----------------------------------------------------------------------
  // Die Bestenliste liest ihren Eintrag ueber supporterStatusCombined - die Testphase darf dort
  // nicht ankommen. Geprueft am echten Lese-Weg, nicht an der Funktion.
  const uid = (vorher.body || {}).userId;
  await j('/storage/leaderboard:' + uid + '?shared=true', {
    method: 'PUT', headers: alsNutzer(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ value: JSON.stringify({ name: NUTZER, score: 1234, isSupporter: true, supporterTier: 'gold' }) })
  });
  const gelesen = await j('/storage/leaderboard:' + uid + '?shared=true', { headers: alsNutzer(token) });
  let eintragLb = null;
  try { eintragLb = JSON.parse((gelesen.body || {}).value || 'null'); } catch (e) { /* kaputt -> bleibt null */ }
  check('3: Bestenliste zeigt KEIN Abzeichen', !!eintragLb && eintragLb.isSupporter === false && eintragLb.supporterTier === null,
    { isSupporter: eintragLb && eintragLb.isSupporter, tier: eintragLb && eintragLb.supporterTier });

  // ---- 4. Einmalig (waehrend sie laeuft) ------------------------------------------------------
  const zweiter = await j('/supporter/trial', { method: 'POST', headers: alsNutzer(token) });
  check('4: zweiter Start wird abgelehnt', zweiter.status === 409, { status: zweiter.status });

  const nachher = await j('/me', { headers: alsNutzer(token) });
  const sn = (nachher.body || {}).supporter || {};
  check('4: /api/me meldet die Testphase als verbraucht', !!(sn.trial && sn.trial.verfuegbar === false && sn.trial.aktiv === true), sn.trial);
  await new Promise(r => setTimeout(r, 900));   // damit Teil 2 die geschriebene DB vorfindet
}

async function teil2() {
  // Der Ablaufzeitpunkt liegt jetzt in der Vergangenheit (vom Aufrufer gesetzt), `supporterTrialAt`
  // steht unveraendert. Erwartet: Funktionen wieder zu, Testphase aber verbraucht.
  const token = await anmelden();
  check('5: Anmeldung nach Neustart erfolgreich', !!token);
  if (!token) return;
  const me = await j('/me', { headers: alsNutzer(token) });
  const s = (me.body || {}).supporter || {};
  check('5: abgelaufene Testphase gibt keine Funktionen mehr frei', s.active === false, { active: s.active, quelle: s.quelle });
  check('5: sie bleibt trotzdem verbraucht', !!(s.trial && s.trial.verfuegbar === false && s.trial.aktiv === false), s.trial);
  const erneut = await j('/supporter/trial', { method: 'POST', headers: alsNutzer(token) });
  check('5: kein zweiter Anlauf nach Ablauf', erneut.status === 409, { status: erneut.status });
}

(async () => {
  if (TEIL === 'teil2') await teil2(); else await teil1();
  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nalles gruen');
  process.exit(fail ? 1 : 0);
})();
