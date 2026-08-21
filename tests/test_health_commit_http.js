// /api/health nennt den Stand, mit dem der Prozess laeuft (21.08.2026).
//
// ANLASS: Sieben Deploy-Ausfaelle in zwei Wochen. Die Eingrenzung von aussen lief jedes Mal
// ueber dieselbe Bastelei - eine Route suchen, die es im neuen Stand gibt und im alten nicht
// (404 vorher, 401 nachher, dazu eine alte Route als Gegenkontrolle und /api/gibtesnicht als
// Negativkontrolle). Das traegt nur, solange ein Merge ueberhaupt eine neue Route mitbringt.
// Gemessen am 21.08.2026 ueber alle Commits seit #142: #143 bis #151 brachten zusammen KEINE
// EINZIGE neue Route, allein #149-#151 aendern dabei 363 Zeilen in server.js. Der Pi-Stand war
// in dieser ganzen Zeit von aussen schlicht nicht messbar.
//
// GEPRUEFT WIRD (der Server laeuft dabei WIRKLICH, es ist kein Quelltext-Test):
//   1. /api/health nennt einen Kurzhash, und zwar den ECHTEN Kopf des Repos, aus dem der
//      Server gestartet wurde - nicht irgendeine Zeichenkette, die nur wie ein Hash aussieht.
//   2. commit und checkout sind beim Start gleich.
//   3. Waechst der Plattenstand unter dem laufenden Prozess weiter, bleibt `commit` stehen und
//      `checkout` zieht mit. Das ist die eigentliche Aussage des Paares: Pull durch, nodemon
//      nicht neu gestartet. Ein einzelnes Feld koennte diesen Fall gar nicht beschreiben.
//   4. Die Route bleibt oeffentlich (kein Token noetig) - sie soll von aussen messbar sein.
//   5. Faellt .git weg, antwortet der Endpunkt weiter und meldet null statt zu sterben. Der
//      Diagnosefall ist ja gerade der, in dem im Repo etwas nicht stimmt.
//   6. Die Umleitung per KEPLER_GIT_DIR GREIFT WIRKLICH. Eine still ignorierte Env-Variable
//      sieht aus wie eine bestandene Pruefung (Frontend-Arbeitsregel 14, Korrektur 15.08.).
//      Belegt an einem Hash, der im echten Repo nicht vorkommen kann.
//
// START (Server extern im SELBEN Bash-Aufruf, Muster der uebrigen HTTP-Tests):
//   DB=$(mktemp /tmp/kepler-health-XXXX.json); rm -f "$DB"
//   G=$(mktemp -d /tmp/kepler-gitdir-XXXX)
//   DB_FILE=$DB PORT=3229 JWT_SECRET=test KEPLER_GIT_DIR=$G node server.js &
//   KEPLER_GIT_DIR=$G node tests/test_health_commit_http.js
//
// GEGENPROBE (Regel 1): Gegen den Stand vor dem Umbau fallen 1a-1c, 2a, 3a-3c, 5a und 6a-6b -
// die Felder gibt es dort nicht. Gruen bleiben dort nur 1a, 1d und 4a - alle drei beschreiben
// Verhalten, das schon vorher richtig war (die Route antwortet, ihre alten Felder stehen noch,
// sie ist oeffentlich); sie sichern, dass der Umbau nichts davon mitgenommen hat.
// 2a und 6b waren im ersten Anlauf am alten Stand AUS DEM FALSCHEN GRUND gruen: Dort sind beide
// Felder undefined, und undefined === undefined bzw. undefined !== '<hash>' ist trivial erfuellt.
// Beide verlangen jetzt zuerst einen WERT (Frontend-Arbeitsregel 28).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.TEST_PORT || 3229;
const BASIS = 'http://127.0.0.1:' + PORT;
const GIT_DIR = process.env.KEPLER_GIT_DIR;

let fehl = 0;
function check(name, ok, detail) {
  console.log((ok ? 'OK   - ' : 'FAIL - ') + name + (detail !== undefined ? ' | ' + JSON.stringify(detail) : ''));
  if (!ok) fehl = 1;
}
function hole(pfad, kopf) {
  return new Promise((resolve) => {
    const req = http.request(BASIS + pfad, { method: 'GET', headers: kopf || {} }, (res) => {
      let roh = '';
      res.on('data', (c) => roh += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(roh); } catch (e) {} resolve({ status: res.statusCode, body: j, roh }); });
    });
    req.on('error', (e) => resolve({ status: 0, fehler: e.message }));
    req.end();
  });
}
const warte = (ms) => new Promise((r) => setTimeout(r, ms));

// Das Verzeichnis, das der Server liest, wird hier BESCHRIEBEN - so laesst sich der Plattenstand
// unter dem laufenden Prozess veraendern, ohne das echte Repo anzufassen.
function setzeKopf(hash) {
  fs.writeFileSync(path.join(GIT_DIR, 'HEAD'), 'ref: refs/heads/master\n');
  fs.mkdirSync(path.join(GIT_DIR, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(GIT_DIR, 'refs', 'heads', 'master'), hash + '\n');
}

(async () => {
  if (!GIT_DIR) { console.log('FAIL - Aufbau: KEPLER_GIT_DIR ist nicht gesetzt, der Test misst sonst das echte Repo.'); process.exit(1); }

  // Ein Hash, der im echten Repo nicht vorkommen kann - er belegt, dass die Umleitung greift.
  const ERFUNDEN = 'abcdef1234567890abcdef1234567890abcdef12';
  // (der Server hat ihn beim Start gelesen, siehe Startzeile im Kopf dieser Datei)

  const a = await hole('/api/health');
  check('1a: /api/health antwortet mit 200', a.status === 200, { status: a.status, roh: a.roh.slice(0, 160) });
  check('1b: das Feld commit ist da und ist ein Kurzhash', typeof a.body?.commit === 'string' && /^[0-9a-f]{7}$/.test(a.body.commit), { commit: a.body?.commit });
  check('1c: das Feld checkout ist da und ist ein Kurzhash', typeof a.body?.checkout === 'string' && /^[0-9a-f]{7}$/.test(a.body.checkout), { checkout: a.body?.checkout });
  check('1d: die alten Felder sind unveraendert da', a.body?.ok === true && typeof a.body?.users === 'number', { ok: a.body?.ok, users: a.body?.users });

  // Nicht bloss "gleich": Am Stand ohne die Felder waeren beide undefined, und die Pruefung
  // waere trivial gruen gewesen (Frontend-Arbeitsregel 28). Verlangt wird ein WERT.
  check('2a: commit und checkout sind beim Start gleich', typeof a.body?.commit === 'string' && a.body.commit === a.body.checkout, { commit: a.body?.commit, checkout: a.body?.checkout });

  // 6: Greift die Umleitung ueberhaupt? Der Server wurde mit dem erfundenen Hash gestartet.
  check('6a: KEPLER_GIT_DIR greift (der erfundene Hash steht in der Antwort)', a.body?.commit === ERFUNDEN.slice(0, 7), { gemeldet: a.body?.commit, erwartet: ERFUNDEN.slice(0, 7) });
  // Ebenso hier: ohne die Typpruefung waere undefined !== '<echter Hash>' trivial erfuellt.
  check('6b: und er stammt nicht zufaellig aus dem echten Repo', typeof a.body?.commit === 'string' && a.body.commit !== eigenerKopf(), { gemeldet: a.body?.commit, echtesRepo: eigenerKopf() });

  // 3: der Plattenstand waechst unter dem laufenden Prozess weiter
  const NEUER = '0f1e2d3c4b5a69780f1e2d3c4b5a69780f1e2d3c';
  setzeKopf(NEUER);
  await warte(10200); // der Puffer im Server haelt 10 s - laenger warten misst die Regel, nicht den Puffer
  const b = await hole('/api/health');
  check('3a: commit bleibt der Stand, mit dem der Prozess startete', b.body?.commit === ERFUNDEN.slice(0, 7), { commit: b.body?.commit, erwartet: ERFUNDEN.slice(0, 7) });
  check('3b: checkout zieht auf den neuen Plattenstand nach', b.body?.checkout === NEUER.slice(0, 7), { checkout: b.body?.checkout, erwartet: NEUER.slice(0, 7) });
  check('3c: die beiden laufen damit sichtbar auseinander', b.body?.commit !== b.body?.checkout, { commit: b.body?.commit, checkout: b.body?.checkout });

  // 4: oeffentlich, also ohne Token messbar - genau dafuer ist die Route da
  const c = await hole('/api/health', { Authorization: 'Bearer unsinn' });
  check('4a: die Route bleibt ohne gueltiges Token erreichbar', c.status === 200 && c.body?.ok === true, { status: c.status });

  // 5: kaputtes .git - der Endpunkt muss weiter antworten
  fs.rmSync(path.join(GIT_DIR, 'refs', 'heads', 'master'), { force: true });
  fs.writeFileSync(path.join(GIT_DIR, 'HEAD'), 'ref: refs/heads/master\n');
  await warte(10200);
  const d = await hole('/api/health');
  check('5a: ohne lesbaren Kopf antwortet der Endpunkt weiter und meldet null', d.status === 200 && d.body?.ok === true && d.body?.checkout === null, { status: d.status, checkout: d.body?.checkout });

  console.log(fehl ? '\nFAIL - es gab rote Pruefungen.' : '\nAlles gruen.');
  process.exit(fehl);
})();

// Der Kopf des ECHTEN Repos, in dem dieser Test liegt - fuer 6b.
function eigenerKopf() {
  try {
    const dir = path.join(__dirname, '..', '.git');
    const head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head.slice(0, 7);
    return fs.readFileSync(path.join(dir, head.slice(4).trim()), 'utf8').trim().slice(0, 7);
  } catch (e) { return null; }
}
