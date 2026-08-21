// Deploy-Webhook: Signaturpruefung, feste Befehlszuordnung und der Umgang mit einer
// Zeitueberschreitung (18.08.2026).
//
// ANLASS: Der Backend-Deploy hing vom 16.08. bis zum 18.08.2026 49 Stunden, weil eine
// liegengebliebene .git/index.lock jeden Pull scheitern liess. Beim Aufraeumen kam ein ZWEITER,
// unabhaengiger Weg ans Licht, auf dem der Webhook denselben Schaden selbst erzeugen kann:
// exec() schickt beim Timeout SIGTERM an die SHELL, nicht an das `git` darunter. Im Nachbau lief
// der Enkelprozess weiter und schrieb seine Datei zu Ende (killed=true/SIGTERM, Marke trotzdem
// angelegt) - auf dem Pi waere das ein unbeobachtetes git, das in .git schreibt.
//
// GEPRUEFT WIRD (der Endpunkt lauefft dabei WIRKLICH, es ist kein Quelltext-Test):
//   1. Ohne Signatur -> 401, und der Befehl laeuft NICHT an.
//   2. Falsche Signatur -> 401.
//   3. Gueltige Signatur, aber unbekanntes Repo -> 400. Der Repo-NAME waehlt einen von zwei fest
//      verdrahteten Befehlen; nichts aus dem Body wird je ausgefuehrt.
//   4. Gueltige Signatur, bekanntes Repo -> 200 und SOFORT (der Deploy laeuft asynchron weiter,
//      GitHub erwartet eine schnelle Antwort). Gemessen wird die Antwortzeit, nicht behauptet.
//   5. Der Timeout ist grosszuegig genug, dass nur ein echter Haenger ihn ausloest, und der
//      Zeitueberschreitungs-Fall hat eine EIGENE Meldung - als generisches "Fehler" gemeldet
//      saehe der gefaehrlichste Ausgang aus wie der harmloseste.
//   6. SERIALISIERUNG (19.08.2026): Laeuft fuer ein Ziel bereits ein Deploy, wird kein zweiter
//      gestartet - der Push wird nur VORGEMERKT. Gemessen an der Sperrdatei, nicht am Zufall:
//      Der Test haelt die Sperre selbst, damit nichts von Timing abhaengt.
//   7. Eine VERWAISTE Sperre (aelter als ein Deploy dauern darf) wird uebernommen - sonst
//      blockierte ein einziger abgestuerzter Lauf den Deploy fuer immer.
//
// ANLASS FUER 6/7, gemessen am 19.08.2026 um 05:41 UTC: Ein Branch-Push und der Merge Sekunden
// spaeter loesten ZWEI Webhook-Ereignisse aus. Zwei `git pull` im selben Repo kollidierten; zurueck
// blieben .git/HEAD.lock (0 Bytes) und .git/refs/heads/master.lock (41 Bytes - der fertige Hash
// war schon geschrieben) sowie ein VORGEMERKTER Stand, der byte-genau einem eingehenden Commit
// entsprach. Danach scheiterte jeder weitere Pull an "Your local changes would be overwritten".
//
// START (Server extern im SELBEN Bash-Aufruf, Muster der uebrigen HTTP-Tests):
//   DB=$(mktemp /tmp/kepler-deploy-XXXX.json); rm -f "$DB"
//   LOCKS=$(mktemp -d /tmp/kepler-deploylock-XXXX)
//   DB_FILE=$DB PORT=3223 JWT_SECRET=test DEPLOY_WEBHOOK_SECRET=geheim DEPLOY_LOCK_DIR=$LOCKS node server.js &
//   DEPLOY_LOCK_DIR=$LOCKS TEST_SERVER_LOG=/tmp/srv.log node tests/test_deploy_webhook_http.js
// (der Server schreibt nach /tmp/srv.log; 6b liest dort mit, siehe dort)
//
// GEGENPROBE (Regel 1): Gegen den Stand vor dem Umbau faellt 5 (Timeout 30000, keine eigene
// Meldung fuer die Zeitueberschreitung). 1-4 bleiben dort gruen - sie beschreiben Verhalten, das
// schon vorher richtig war, und stehen hier als Absicherung gegen ein Abrutschen beim naechsten
// Umbau des Endpunkts.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.TEST_PORT || 3223;
const BASIS = 'http://127.0.0.1:' + PORT;
const SECRET = process.env.DEPLOY_WEBHOOK_SECRET || 'geheim';

let fehl = 0;
function check(name, ok, detail) {
  console.log((ok ? 'OK   - ' : 'FAIL - ') + name + (detail !== undefined ? ' | ' + JSON.stringify(detail) : ''));
  if (!ok) fehl = 1;
}
function post(pfad, body, signatur) {
  return new Promise((resolve) => {
    const daten = Buffer.from(JSON.stringify(body));
    const req = http.request(BASIS + pfad, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': daten.length },
        signatur ? { 'X-Hub-Signature-256': signatur } : {})
    }, (res) => {
      let roh = '';
      res.on('data', (c) => roh += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(roh); } catch (e) {} resolve({ status: res.statusCode, body: j, roh }); });
    });
    req.on('error', (e) => resolve({ status: 0, fehler: e.message }));
    req.end(daten);
  });
}
const signiere = (body) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(Buffer.from(JSON.stringify(body))).digest('hex');

(async () => {
  const echt = { repository: { name: 'kolonie-kepler7' } };
  const fremd = { repository: { name: 'irgendein-anderes-repo' } };

  const ohne = await post('/api/deploy-webhook', echt, null);
  check('1 ohne Signatur wird abgelehnt', ohne.status === 401, { status: ohne.status });

  const falsch = await post('/api/deploy-webhook', echt, 'sha256=' + '0'.repeat(64));
  check('2 falsche Signatur wird abgelehnt', falsch.status === 401, { status: falsch.status });

  const unbekannt = await post('/api/deploy-webhook', fremd, signiere(fremd));
  check('3 gueltige Signatur, aber unbekanntes Repo -> 400', unbekannt.status === 400, { status: unbekannt.status, body: unbekannt.body });

  const t0 = Date.now();
  const ok = await post('/api/deploy-webhook', echt, signiere(echt));
  const dauer = Date.now() - t0;
  check('4a bekanntes Repo wird angenommen', ok.status === 200 && ok.body && ok.body.ok === true && ok.body.repo === 'kolonie-kepler7',
    { status: ok.status, body: ok.body });
  // Die Antwort darf NICHT auf den Deploy warten - sonst markiert GitHub den Webhook als
  // fehlgeschlagen. Gemessen statt behauptet; grosszuegige Schranke, damit der Test nicht an der
  // Maschinenlast haengt.
  check('4b und zwar SOFORT, ohne auf den Deploy zu warten', dauer < 3000, { antwortMs: dauer });

  // 5) Der Umgang mit der Zeitueberschreitung. Am Quelltext geprueft, weil ein echter Haenger im
  // Test zehn Minuten dauern wuerde - dafuer aber an der WIRKUNG formuliert (Zahl und eigener
  // Zweig), nicht an einer Schreibweise.
  const S = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const m = S.match(/const DEPLOY_TIMEOUT_MS = ([^;]+);/);
  const ms = m ? Function('return (' + m[1] + ')')() : null;
  check('5a der Deploy-Timeout ist grosszuegig (>= 5 Minuten)', typeof ms === 'number' && ms >= 5 * 60 * 1000, { timeoutMs: ms });
  check('5b exec benutzt genau diese Konstante', /exec\(command,\s*\{\s*timeout:\s*DEPLOY_TIMEOUT_MS\s*\}/.test(S));
  check('5c die Zeitueberschreitung hat einen EIGENEN Zweig mit eigener Meldung',
    /if \(err && err\.killed\)/.test(S) && /ZEITUEBERSCHREITUNG/.test(S));

  // ---- 6/7) Serialisierung, an der Sperrdatei gemessen -------------------------------------
  const sperrOrdner = process.env.DEPLOY_LOCK_DIR || '/tmp';
  const sperre = path.join(sperrOrdner, 'kepler7-deploy-kolonie-kepler7.lock');
  const vorgemerkt = path.join(sperrOrdner, 'kepler7-deploy-kolonie-kepler7.pending');
  const warte = (ms) => new Promise(r => setTimeout(r, ms));
  try { fs.unlinkSync(vorgemerkt); } catch (e) {}
  // Vor dem Halten abwarten, bis der Deploy aus Pruefung 4 durch ist - sonst misst 6 dessen
  // Sperre statt der eigenen.
  for (let i = 0; i < 30 && fs.existsSync(sperre); i++) await warte(200);
  try { fs.unlinkSync(vorgemerkt); } catch (e) {}

  // 6) Der Test HAELT die Sperre selbst. Damit haengt nichts an Timing: Der Endpunkt muss den
  //    zweiten Deploy ueberspringen, egal wie schnell die Maschine ist.
  fs.writeFileSync(sperre, JSON.stringify({ pid: -1, seit: new Date().toISOString() }));
  // 6b misst, ob wirklich ein zweiter Deploy GELAUFEN ist - nicht, ob die Sperrdatei unberuehrt
  // blieb. Die erste Fassung tat Letzteres und war am Stand OHNE Serialisierung gruen: Dort
  // kennt der Server die Datei gar nicht, fasst sie also auch nicht an (Arbeitsregel 28 - eine
  // Pruefung, die aus dem falschen Grund gruen ist, ist so schlecht wie eine rote). Gemessen wird
  // deshalb am Serverprotokoll: Jeder ANGELAUFENE Deploy hinterlaesst dort genau eine
  // Ergebniszeile ("erfolgreich" oder "Fehler").
  const logPfad = process.env.TEST_SERVER_LOG;
  const ergebnisZeilen = () => {
    try { return (fs.readFileSync(logPfad, 'utf8').match(/Deploy-Webhook (erfolgreich|Fehler|ZEITUEBERSCHREITUNG) für kolonie-kepler7:/g) || []).length; }
    catch (e) { return null; }
  };
  check('6b-vorab: TEST_SERVER_LOG zeigt auf das Serverprotokoll', !!logPfad && ergebnisZeilen() !== null,
    { TEST_SERVER_LOG: logPfad || '(nicht gesetzt)' });
  const vorherZeilen = ergebnisZeilen();
  const zweiter = await post('/api/deploy-webhook', echt, signiere(echt));
  await warte(1500);
  check('6a bei laufendem Deploy antwortet der Webhook trotzdem mit 200', zweiter.status === 200, { status: zweiter.status });
  check('6b der zweite Deploy laeuft NICHT an (keine neue Ergebniszeile im Protokoll)',
    ergebnisZeilen() === vorherZeilen, { vorher: vorherZeilen, nachher: ergebnisZeilen() });
  check('6c der Push geht nicht verloren, sondern wird vorgemerkt', fs.existsSync(vorgemerkt));

  // 7) Verwaiste Sperre: Zeitstempel weit in die Vergangenheit, dann muss sie uebernommen werden.
  //    Gegenrichtung zu 6 - ohne sie legte ein einziger abgestuerzter Lauf den Deploy fuer immer
  //    still, und die Behebung waere schlimmer als das Problem.
  try { fs.unlinkSync(vorgemerkt); } catch (e) {}
  const alt = new Date(Date.now() - 24 * 3600 * 1000);
  fs.utimesSync(sperre, alt, alt);
  const dritter = await post('/api/deploy-webhook', echt, signiere(echt));
  let uebernommen = false;
  for (let i = 0; i < 30; i++) {
    await warte(200);
    // Uebernommen heisst: entweder traegt sie einen frischen Zeitstempel (laeuft gerade),
    // oder sie ist nach dem Lauf wieder weg. Beides beweist, dass der Deploy angelaufen ist.
    if (!fs.existsSync(sperre) || fs.statSync(sperre).mtimeMs > alt.getTime() + 1000) { uebernommen = true; break; }
  }
  check('7a eine verwaiste Sperre wird uebernommen', uebernommen && dritter.status === 200,
    { status: dritter.status, sperreNochDa: fs.existsSync(sperre) });
  check('7b und dabei wird nichts vorgemerkt', !fs.existsSync(vorgemerkt));
  try { fs.unlinkSync(sperre); } catch (e) {}

  console.log(fehl ? 'FEHLGESCHLAGEN' : 'ALLES GRUEN');
  process.exit(fehl);
})();
