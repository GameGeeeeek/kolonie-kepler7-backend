// Der Deploy heilt sich selbst, bevor er pullt (28.08.2026, Auftrag Sascha).
//
//   node tests/test_deploy_selbstheilung.js
//
// DER ANLASS IST BELEGT, nicht vermutet. Zwoelf Deploy-Ausfaelle, sechs davon (Nr. 6, 7, 8, 9,
// 11, 12) mit demselben Fingerabdruck: Arbeitsbaum neu, .git/HEAD alt, eine *.lock
// liegengeblieben - ab da bricht jeder weitere Pull ab. Bei Nr. 12 stand die Ursache im
// Container-Log: `git pull` schreibt server.js, nodemon startet daraufhin neu und beendet den
// Subprozess ("still waiting for 1 sub-process to finish"), BEVOR git den Ref aktualisiert hat.
//
// WAS GEPRUEFT WIRD - und warum jede Zeile ihre Gegenrichtung hat: Eine Aufraeumfunktion, die zu
// viel wegwirft, ist gefaehrlicher als der stehende Deploy, den sie behebt. Eine Handaenderung an
// server.js auf dem Pi hat den Deploy am 18.08.2026 schon einmal blockiert; sie automatisch zu
// verwerfen waere Datenverlust mit gutem Gewissen.
//   1  eine VERWAISTE Sperre wird entfernt   / 1b eine FRISCHE bleibt liegen
//   2  ein halb angewendeter Pull wird zurueckgesetzt (Blob == FETCH_HEAD)
//   2b eine FREMDE Aenderung bleibt unangetastet und wird als solche benannt
//   2c eine unversionierte Datei, die der eingehende Stand ANLEGT, wird beiseitegelegt
//   2d eine FREMDE unversionierte Datei bleibt liegen (die wichtigere Haelfte)
//   3  laeuft ein git-Prozess, wird GAR NICHTS angefasst
//   4  die Funktion ist im Deploy-Weg verdrahtet und steht hinter der Sperre, vor dem Pull
//
// GEMESSEN WIRD AUSGEFUEHRT, nicht gegreppt: Die Funktion wird samt ihrer Abhaengigkeiten aus
// server.js geschnitten und gegen ein echtes Wegwerf-Repo in /tmp gefahren, in dem der
// Ausfall-Fingerabdruck von Hand hergestellt wird. Ein Test, der nur nach Zeichenketten sucht,
// belegt bei einer Aufraeumfunktion gar nichts.
//
// GEGENPROBE gegen den Stand davor (KEPLER_BACKEND_SERVER): dort gibt es die Funktion nicht,
// 0-bau faellt und mit ihm alles, was sie ausfuehrt.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const SERVER_JS = process.env.KEPLER_BACKEND_SERVER || path.join(__dirname, '..', 'server.js');
let okZahl = 0, failZahl = 0;
function check(name, bedingung, beleg) {
  const zeile = (bedingung ? 'OK   - ' : 'FAIL - ') + name + (beleg !== undefined ? ' | ' + JSON.stringify(beleg) : '');
  console.log(zeile);
  if (bedingung) okZahl++; else failZahl++;
}

const S = fs.readFileSync(SERVER_JS, 'utf8');
// Kommentare leeren (nicht entfernen), damit Zeilennummern und Suchtreffer stimmen und die
// Erklaerbloecke dieser Etappe nicht ihre eigenen Bezeichner zitieren (Arbeitsregel 33).
//
// DIE REIHENFOLGE IST NICHT BELIEBIG, und der erste Entwurf hatte sie falsch herum: Zuerst die
// ZEILEN-Kommentare, dann die Bloecke. server.js enthaelt gemessen mehrere Zeilenkommentare mit
// einem `/*` darin ("NGINX leitet /api/* per Reverse-Proxy", "*.js/*.json-Platzhalter"). Wer
// zuerst nach Bloecken sucht, oeffnet dort ein Fenster bis zum naechsten `*/` - gemessen 77.612
// bzw. 20.018 Zeichen - und leert echten Code mit. Genau daran fand dieser Test seine eigenen
// Funktionen nicht mehr (Familie "Naive Regex ueber die ganze Datei").
const OHNE_KOMMENTARE = S.replace(/^([ \t]*)\/\/.*$/gm, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))
                         .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));

// ---- 0) Die Funktion samt Abhaengigkeiten schneiden und ausfuehrbar machen -------------------
function schneide(name) {
  const i = OHNE_KOMMENTARE.indexOf('function ' + name + '(');
  if (i < 0) return null;
  // Bis zur schliessenden Klammer auf Tiefe 0 - kein geratenes Zeichenfenster (die Lehre aus
  // "Ein GERATENES Fenster ist kein Scope").
  let tiefe = 0, start = OHNE_KOMMENTARE.indexOf('{', i);
  for (let j = start; j < OHNE_KOMMENTARE.length; j++) {
    const c = OHNE_KOMMENTARE[j];
    if (c === '{') tiefe++;
    else if (c === '}') { tiefe--; if (tiefe === 0) return S.slice(i, j + 1); }
  }
  return null;
}
// Die Konstanten werden GESAMMELT, nicht benannt: Eine Namensliste ist beim naechsten Umbau
// unvollstaendig, und dann bricht der Test beim AUFRUF ab statt an der geprueften Zeile - genau
// so ist der erste Entwurf an GIT_LOCK_STALE_MS gestorben. Gesucht wird nach jedem GROSS_
// geschriebenen Bezeichner in den geschnittenen Bloecken, transitiv aufgeloest.
function sammleKonstanten(code, schonDa) {
  let text = code, runde = 0;
  const gefunden = new Map();
  while (runde++ < 5) {
    const namen = new Set((text.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) || []));
    let neu = false;
    for (const name of namen) {
      if (gefunden.has(name) || schonDa.includes(name)) continue;
      const m = OHNE_KOMMENTARE.match(new RegExp('^const ' + name + ' = ([^;]+);', 'm'));
      if (!m) continue;
      gefunden.set(name, { code: 'const ' + name + ' = ' + m[1] + ';', pos: OHNE_KOMMENTARE.indexOf(m[0]) });
      neu = true;
    }
    if (!neu) break;
    text = [...gefunden.values()].map(x => x.code).join('\n');
  }
  // In der Reihenfolge der DATEI ausgeben, nicht in der des Findens: GIT_LOCK_STALE_MS leitet
  // sich aus DEPLOY_TIMEOUT_MS ab, und umgekehrt eingesetzt wirft es "Cannot access ... before
  // initialization". Die Datei kennt die richtige Reihenfolge, der Sammler nicht.
  return [...gefunden.values()].sort((a, b) => a.pos - b.pos).map(x => x.code).join('\n');
}
let heilen = null, baufehler = null;
try {
  const namen = ['lebenderGitProzess', 'gitSperrenFinden', 'deployAufraeumen'];
  const teile = namen.map(schneide);
  if (teile.some(t => !t)) throw new Error('nicht gefunden: ' + namen.filter((n,i) => !teile[i]).join(', '));
  const konstanten = sammleKonstanten(teile.join('\n'), []);
  // os gehoert seit dem 28.08.2026 dazu (die beiseitegelegten Dateien landen unter os.tmpdir()).
  // Fehlt ein Modul hier, wirft der Zweig zur LAUFZEIT, der innere catch von deployAufraeumen
  // schluckt es in den Bericht - und ein gefilterter Beleg versteckt es vollends. Deshalb misst
  // 0-bau2 unten, dass der Arbeitsbaum ueberhaupt pruefbar war.
  heilen = new Function('fs', 'path', 'os', 'execSync',
    konstanten + '\n' + teile.join('\n') + '\nreturn { deployAufraeumen, lebenderGitProzess };')(fs, path, os, execSync);
} catch (e) { baufehler = e.message; }
check('0-bau: die Selbstheilung laesst sich aus server.js schneiden und ausfuehren', !!heilen, { fehler: baufehler });
if (!heilen) { console.log('\nFEHLGESCHLAGEN'); process.exit(1); }
// Jeder AUFRUF wird gefasst und der Fehlschlag als eigene Pruefung gemeldet. Ein try/catch um
// den Aufbau allein genuegt nicht - eine geschnittene Funktion kann erst beim Ausfuehren werfen,
// und dann stirbt der Lauf mittendrin mit rotem Exit-Code und ohne eine einzige FAIL-Zeile.
let laufFehler = null;
const aufraeumen = (repo, dir) => {
  try { return heilen.deployAufraeumen(repo, dir); }
  catch (e) { laufFehler = laufFehler || e.message; return ['LAUFZEITFEHLER: ' + e.message]; }
};

// ---- Wegwerf-Repos: ein "Ursprung" und ein "Pi" -----------------------------------------------
const WURZEL = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler7-heil-'));
const g = (dir, args) => execSync('git ' + args, { cwd: dir, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
// JEDER Abschnitt bekommt sein eigenes Repo-Paar. Ein gemeinsames waere ein Messwerkzeug, dessen
// erster Lauf den zweiten veraendert - dieselbe Falle wie zwei Messlaeufe mit einem Speicher.
let repoZaehler = 0;
function baueRepos(neueDateien) {
  const raum = path.join(WURZEL, 'r' + (++repoZaehler));
  fs.mkdirSync(raum, { recursive: true });
  const ursprung = path.join(raum, 'ursprung'), pi = path.join(raum, 'pi');
  fs.mkdirSync(ursprung);
  g(ursprung, 'init -q -b master');
  g(ursprung, 'config user.email t@t'); g(ursprung, 'config user.name T');
  fs.writeFileSync(path.join(ursprung, 'server.js'), 'alt\n');
  fs.writeFileSync(path.join(ursprung, 'CLAUDE.md'), 'doku alt\n');
  g(ursprung, 'add -A'); g(ursprung, 'commit -q -m alt');
  execSync('git clone -q "' + ursprung + '" "' + pi + '"', { encoding: 'utf8' });
  g(pi, 'config user.email t@t'); g(pi, 'config user.name T');
  // Der Ursprung laeuft weiter - das ist der eingehende Commit.
  fs.writeFileSync(path.join(ursprung, 'server.js'), 'neu\n');
  fs.writeFileSync(path.join(ursprung, 'CLAUDE.md'), 'doku neu\n');
  for (const d of (neueDateien || [])) {
    fs.mkdirSync(path.dirname(path.join(ursprung, d)), { recursive: true });
    fs.writeFileSync(path.join(ursprung, d), 'neue datei\n');
  }
  g(ursprung, 'add -A'); g(ursprung, 'commit -q -m neu');
  return { ursprung, pi };
}
// Der Ausfall-Fingerabdruck: die neuen Dateien liegen im Arbeitsbaum, HEAD steht noch auf alt,
// eine Sperre ist liegengeblieben.
function stelleAusfallHer(pi, ursprung, sperrAlterMs, neueDateien) {
  fs.writeFileSync(path.join(pi, 'server.js'), 'neu\n');
  fs.writeFileSync(path.join(pi, 'CLAUDE.md'), 'doku neu\n');
  for (const d of (neueDateien || [])) {
    fs.mkdirSync(path.dirname(path.join(pi, d)), { recursive: true });
    fs.writeFileSync(path.join(pi, d), 'neue datei\n');
  }
  const lock = path.join(pi, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const t = (Date.now() - sperrAlterMs) / 1000;
  fs.utimesSync(lock, t, t);
  return lock;
}

// ---- 1) Verwaiste Sperre weg, frische bleibt --------------------------------------------------
{
  const { ursprung, pi } = baueRepos();
  const lock = stelleAusfallHer(pi, ursprung, 20 * 60 * 1000);   // 20 Min - klar verwaist
  const bericht = aufraeumen('test', pi);
  check('1-vorab: der Ausfall-Fingerabdruck stand wirklich da', bericht.length > 0, { bericht });
  check('1: die verwaiste Sperre ist weg', !fs.existsSync(lock),
    { bericht: bericht.filter(z => /Sperre/.test(z)) });
  check('2: der halb angewendete Pull ist zurueckgesetzt (Blob stand schon im Ursprung)',
    fs.readFileSync(path.join(pi, 'server.js'), 'utf8') === 'alt\n'
    && fs.readFileSync(path.join(pi, 'CLAUDE.md'), 'utf8') === 'doku alt\n',
    { server: fs.readFileSync(path.join(pi, 'server.js'), 'utf8').trim(),
      bericht: bericht.filter(z => /Pull/.test(z)) });
  // Und die Sache selbst: der Pull kommt jetzt durch.
  let gezogen = null;
  try { g(pi, 'pull -q --ff-only origin master'); gezogen = fs.readFileSync(path.join(pi, 'server.js'), 'utf8').trim(); } catch (e) { gezogen = 'FEHLER: ' + e.message.split('\n')[0]; }
  check('2b: und der Pull laeuft danach durch (das ist der Zweck)', gezogen === 'neu', { server: gezogen });
}
// ---- 1b) Eine FRISCHE Sperre bleibt liegen ----------------------------------------------------
{
  const { ursprung, pi } = baueRepos();
  const lock = stelleAusfallHer(pi, ursprung, 5 * 1000);   // 5 s - ein laufender Pull
  const bericht = aufraeumen('test', pi);
  check('1b: eine frische Sperre wird NICHT entfernt', fs.existsSync(lock),
    { bericht: bericht.filter(z => /Sperre/.test(z)) });
}
// ---- 2b) Eine FREMDE Aenderung bleibt unangetastet --------------------------------------------
{
  const { ursprung, pi } = baueRepos();
  const lock = stelleAusfallHer(pi, ursprung, 20 * 60 * 1000);
  fs.writeFileSync(path.join(pi, 'server.js'), 'von Hand am Pi geaendert\n');   // kein Commit kennt das
  const bericht = aufraeumen('test', pi);
  check('3-vorab: die Sperre ist trotzdem weg (die zwei Dinge haengen nicht aneinander)', !fs.existsSync(lock));
  check('3: eine FREMDE Aenderung bleibt liegen - sie wird nicht weggeworfen',
    fs.readFileSync(path.join(pi, 'server.js'), 'utf8') === 'von Hand am Pi geaendert\n',
    { server: fs.readFileSync(path.join(pi, 'server.js'), 'utf8').trim() });
  check('3b: und der Bericht benennt sie als fremd',
    bericht.some(z => /FREMDE Aenderung/.test(z) && /server\.js/.test(z)), { bericht });
  // Die Datei daneben, die dem Ursprung entspricht, wird trotzdem versorgt - je Datei einzeln.
  check('3c: die Datei daneben wird trotzdem zurueckgesetzt (je Datei einzeln geprueft)',
    fs.readFileSync(path.join(pi, 'CLAUDE.md'), 'utf8') === 'doku alt\n',
    { doku: fs.readFileSync(path.join(pi, 'CLAUDE.md'), 'utf8').trim() });
}
// ---- 6) Eine unversionierte Datei, die der eingehende Stand ANLEGT ---------------------------
// Der Anlassfall vom 28.08.2026, am Pi gemessen: Ein abgeschnittener Pull laesst auch Dateien
// liegen, die es im alten Stand gar nicht GIBT (Status A im Diff). Sie sind unversioniert, fallen
// durch beide Wachen oben, und git bricht an ihnen ab. Ohne diesen Zweig half die Heilung
// ausgerechnet bei jedem Commit nicht, der eine Datei hinzufuegt - bei diesem Projekt fast jedem,
// weil zu jeder Etappe ein neuer Waechter gehoert.
const NEUE = ['tests/test_neu.js'];
{
  // 6-vorab misst den ANLASSFALL selbst: ohne Heilung scheitert der Pull wirklich an dieser
  // Datei. Ohne diese Zeile koennte 6b auch dann gruen sein, wenn es nie ein Problem gab.
  const { ursprung, pi } = baueRepos(NEUE);
  stelleAusfallHer(pi, ursprung, 20 * 60 * 1000, NEUE);
  fs.writeFileSync(path.join(pi, 'server.js'), 'alt\n');      // getrackte Reste selbst versorgen,
  fs.writeFileSync(path.join(pi, 'CLAUDE.md'), 'doku alt\n'); // damit ALLEIN die neue Datei stoert
  let fehler = null;
  try { g(pi, 'pull -q --ff-only origin master'); }
  catch (e) { fehler = (e.message.split('\n').find(z => /untracked|overwritten/i.test(z)) || e.message.split('\n')[0]).trim(); }
  check('6-vorab: ohne Heilung scheitert der Pull an der unversionierten Datei', fehler !== null, { fehler });
}
{
  const { ursprung, pi } = baueRepos(NEUE);
  stelleAusfallHer(pi, ursprung, 20 * 60 * 1000, NEUE);
  const bericht = aufraeumen('test', pi);
  const zeile = bericht.find(z => /beiseitegelegt/.test(z) && z.indexOf(NEUE[0]) >= 0);
  const ziel = zeile ? zeile.split(' -> ')[1].split(' (')[0] : null;
  check('6: die unversionierte Datei ist beiseitegelegt - nicht geloescht',
    !fs.existsSync(path.join(pi, NEUE[0])) && !!ziel && fs.existsSync(ziel),
    { bericht, zielExistiert: ziel ? fs.existsSync(ziel) : null });
  check('6-bau: der Arbeitsbaum war ueberhaupt pruefbar (kein verschluckter Laufzeitfehler)',
    !bericht.some(z => /nicht pruefbar/.test(z)), { bericht: bericht.filter(z => /nicht pruefbar/.test(z)) });
  let gezogen = null;
  try { g(pi, 'pull -q --ff-only origin master'); gezogen = fs.readFileSync(path.join(pi, NEUE[0]), 'utf8').trim(); }
  catch (e) { gezogen = 'FEHLER: ' + e.message.split('\n')[0]; }
  check('6b: und der Pull laeuft danach durch (das ist der Zweck)', gezogen === 'neue datei', { datei: gezogen });
}
{
  // Gegenrichtung, und sie ist die wichtigere Haelfte: Eine unversionierte Datei, die der
  // eingehende Stand NICHT kennt, ist eine fremde Datei - sie bleibt, wo sie ist. Ohne diese
  // Zeile duerfte die Heilung jede beliebige Datei aus dem Verzeichnis raeumen.
  const { ursprung, pi } = baueRepos(NEUE);
  stelleAusfallHer(pi, ursprung, 20 * 60 * 1000, NEUE);
  fs.writeFileSync(path.join(pi, 'notizen-vom-pi.txt'), 'gehoert niemandem\n');
  const bericht = aufraeumen('test', pi);
  check('6c: eine FREMDE unversionierte Datei bleibt liegen',
    fs.existsSync(path.join(pi, 'notizen-vom-pi.txt')) && !bericht.some(z => z.indexOf('notizen-vom-pi') >= 0),
    { bericht: bericht.filter(z => /beiseitegelegt|notizen/.test(z)) });
}
// ---- 4) Laeuft ein git-Prozess, wird gar nichts angefasst -------------------------------------
{
  const { ursprung, pi } = baueRepos();
  const lock = stelleAusfallHer(pi, ursprung, 20 * 60 * 1000);
  const { spawn } = require('child_process');
  // Ein echter, LEBENDER git-Prozess (kein Zombie). `git --paginate help -a` war der erste
  // Entwurf und ist zu kurzlebig - der Pager war durch, bevor gemessen wurde, und 4/4b waren
  // ueber ihre lief-Bedingung trivial gruen (Arbeitsregel 28). `hash-object --stdin` blockiert
  // dagegen zuverlaessig, solange stdin offen bleibt.
  const kind = spawn('git', ['hash-object', '--stdin'], { stdio: ['pipe','pipe','ignore'] });
  let bericht = [], lief = false;
  try {
    const bis = Date.now() + 3000;
    while (Date.now() < bis && !heilen.lebenderGitProzess()) execSync('sleep 0.05');
    lief = heilen.lebenderGitProzess();
    bericht = aufraeumen('test', pi);
  } finally { try { kind.kill('SIGKILL'); } catch (e) {} }
  // Ohne lebenden Prozess misst dieser Abschnitt nichts - dann fallen 4 und 4b MIT, statt ueber
  // eine lief-Bedingung trivial gruen zu sein.
  check('4-vorab: der Test hat wirklich einen LEBENDEN git-Prozess erzeugt', lief, { erkannt: lief });
  check('4: bei laufendem git wird nichts angefasst', lief && fs.existsSync(lock),
    { lebenderGit: lief, sperreNochDa: fs.existsSync(lock), bericht });
  check('4b: und der Bericht sagt, warum', lief && bericht.some(z => /git-Prozess laeuft/.test(z)), { bericht });
}
// ---- 5) Verdrahtung: hinter der Sperre, vor dem Pull ------------------------------------------
{
  const i = OHNE_KOMMENTARE.indexOf('function starteDeploy(');
  const block = i < 0 ? '' : OHNE_KOMMENTARE.slice(i, i + 2500);
  check('5-anker: starteDeploy ist auffindbar', block.length > 500);
  const posSperre = block.indexOf('deploySperreNehmen(');
  const posHeil = block.indexOf('deployAufraeumen(');
  const posPull = block.indexOf('exec(command');
  check('5: die Selbstheilung steht HINTER der Sperre und VOR dem Pull',
    posSperre >= 0 && posHeil > posSperre && posPull > posHeil,
    { sperre: posSperre, heilung: posHeil, pull: posPull });
  // Das Verzeichnis kommt aus der Tabelle, nicht aus dem Befehlsstring geparst.
  check('5b: jedes Deploy-Ziel nennt sein Verzeichnis benannt',
    /'kolonie-kepler7':\s*\{\s*dir:/.test(OHNE_KOMMENTARE) && /'kolonie-kepler7-backend':\s*\{\s*dir:/.test(OHNE_KOMMENTARE));
}

check('0-lauf: kein Laufzeitfehler in den Messaufrufen', laufFehler === null, { fehler: laufFehler });
try { fs.rmSync(WURZEL, { recursive: true, force: true }); } catch (e) {}
console.log('\n' + (okZahl + failZahl) + ' Pruefungen, ' + failZahl + ' fehlgeschlagen');
console.log(failZahl ? 'FEHLGESCHLAGEN' : 'Alles gruen.');
process.exit(failZahl ? 1 : 0);
