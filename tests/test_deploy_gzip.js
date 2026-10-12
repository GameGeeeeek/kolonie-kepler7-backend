// Vorkompression im Deploy (02.09.2026, Strukturpruefung A1).
//
// BEFUND: nginx auf dem Pi lieferte alle Textdateien unkomprimiert aus - die Spieldatei mit 5,87 MB
// statt 1,74 MB. `gzip_static on` liefert stattdessen datei.gz, wenn sie danebenliegt; erzeugt wird
// sie im Deploy, damit der Pi nicht bei jedem Aufruf rechnet.
//
// DIE FALLE, um die es hier geht: nginx vergleicht bei gzip_static KEINE Zeitstempel. Bleibt eine
// alte .gz liegen, liefert es sie weiter aus - der Spieler saehe dauerhaft einen veralteten Stand,
// und zwar still. Genau dieselbe Familie wie die frueher mitgeschleppte index.html-Kopie. Der
// Deploy muss die .gz deshalb bei JEDEM Lauf neu schreiben, und ein Fehlschlag dabei muss den
// Deploy sichtbar reissen statt ihn als halben Erfolg zu protokollieren.
//
// Geprueft wird der ECHTE Befehl aus server.js, ausgefuehrt in einem Wegwerf-Verzeichnis - nicht
// eine nachgebaute Zeichenkette. Ein Test, der nur den Befehlstext auf Teilworte absucht, waere
// gruen, sobald irgendwo "gzip" steht, und saehe weder die Reihenfolge noch das Verhalten.
//
//   1. Jede kopierte Textdatei bekommt eine .gz, das Original bleibt liegen (nginx braucht beide).
//   2. Eine VERALTETE .gz wird ueberschrieben - der eigentliche Anlass des Tests.
//   3. Binaerdateien (*.png) bekommen KEINE .gz - gzip macht sie nur groesser.
//   4. Eine fehlende optionale Datei ueberspringt den Schritt, statt den Deploy zu reissen.
//   5. Scheitert das gzip bei VORHANDENER Datei, bricht die Kette ab (Exit != 0).
//   6. Jede Datei, die der Kopierbefehl ausliefert und die Text ist, steht auch in der gzip-Liste.
//      Das ist die Regel, die beim naechsten neuen Dateityp bricht, nicht eine Momentaufnahme.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { gunzipSync } = require('zlib');
const SHELL = process.env.KEPLER_DEPLOY_SHELL || 'sh';
const shellPath = file => "'" + file.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'";

let fail = false, checks = 0, failures = 0;
const check = (n, c, x) => { checks++; if (!c) failures++; console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
// Notbremse in der MESSVORRICHTUNG, nicht nur im Pruefling: Faellt eine Voraussetzung weg (etwa
// weil die .gz gar nicht entstanden ist), soll die Pruefung ROT werden und der Lauf weitergehen -
// nicht mit einer Ausnahme sterben. Sonst ist der Sabotage-Fall genau der, den man nicht messen
// kann: Die Gegenprobe brach frueher bei 1e ab und lieferte eine unvollstaendige Pflichtliste.
const messe = (fn, standard) => { try { return fn(); } catch (e) { return standard; } };

const SERVER = fs.readFileSync(process.env.KEPLER_BACKEND_SERVER || path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');

// Die beiden Konstanten aus server.js holen und ausfuehren - dieselbe Quelle, die der Webhook nutzt.
function konstante(name){
  const m = SERVER.match(new RegExp('const ' + name + ' = ([\\s\\S]*?);\\n'));
  if (!m) throw new Error(name + ' nicht in server.js gefunden');
  return m[1];
}
let DEPLOY_WEB_COPY, DEPLOY_WEB_GZIP_DATEIEN;
try {
  const f = new Function(
    'const DEPLOY_WEB_GZIP_DATEIEN = ' + konstante('DEPLOY_WEB_GZIP_DATEIEN') + ';\n' +
    'const DEPLOY_WEB_GZIP = ' + konstante('DEPLOY_WEB_GZIP') + ';\n' +
    'const DEPLOY_WEB_COPY = ' + konstante('DEPLOY_WEB_COPY') + ';\n' +
    'return { DEPLOY_WEB_COPY, DEPLOY_WEB_GZIP_DATEIEN };');
  ({ DEPLOY_WEB_COPY, DEPLOY_WEB_GZIP_DATEIEN } = f());
} catch (e) {
  check('vorab: DEPLOY_WEB_COPY und die gzip-Liste sind aus server.js lesbar', false, String(e.message).slice(0, 140));
  // Nicht abbrechen: Fehlt nur die gzip-Konstante, sollen die Verhaltenspruefungen unten trotzdem
  // laufen und zeigen, WAS dadurch nicht mehr passiert. Nur ohne DEPLOY_WEB_COPY geht gar nichts.
  try { DEPLOY_WEB_COPY = new Function('return ' + konstante('DEPLOY_WEB_COPY') + ';')(); } catch (e2) {
    console.log('\nFEHLGESCHLAGEN'); process.exit(1);
  }
  DEPLOY_WEB_GZIP_DATEIEN = DEPLOY_WEB_GZIP_DATEIEN || '';
}
check('vorab: DEPLOY_WEB_COPY und die gzip-Liste sind aus server.js lesbar',
  typeof DEPLOY_WEB_COPY === 'string' && /gzip/.test(DEPLOY_WEB_COPY), DEPLOY_WEB_GZIP_DATEIEN);

// Der Befehl arbeitet mit dem festen Pfad /deploy/web. Fuer den Test wird er auf ein
// Wegwerf-Verzeichnis umgebogen - die einzige Anpassung, alles andere laeuft woertlich.
function baueUmgebung(){
  const wurzel = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler7-gzip-'));
  const quelle = path.join(wurzel, 'repo');
  const ziel = path.join(wurzel, 'web');
  fs.mkdirSync(quelle); fs.mkdirSync(ziel);
  return { wurzel, quelle, ziel };
}
function fuehreAus(u, extraEnv){
  const befehl = DEPLOY_WEB_COPY.split('/deploy/web').join(shellPath(u.ziel));
  return spawnSync(SHELL, ['-c', befehl], { cwd: u.quelle, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, ...extraEnv } });
}
function schreibe(u, name, inhalt){ fs.writeFileSync(path.join(u.quelle, name), inhalt); }

// Ein Inhalt, der sich lohnt zu komprimieren - sonst wird die .gz groesser als das Original und
// die Groessenpruefung unten misst das Gegenteil dessen, was sie soll.
const TEXT = 'Kolonie Kepler-7 '.repeat(500);
const TEXT2 = 'Zweiter Stand, klar unterscheidbar. '.repeat(500);
function grundbestand(u, text){
  schreibe(u, 'weltraum_kolonie.html', text);
  schreibe(u, 'patchnotes.html', text);
  schreibe(u, 'robots.txt', text);
  schreibe(u, 'sitemap.xml', text);
  schreibe(u, 'seiten.css', text);
  schreibe(u, 'patchnotes.xml', text);
  schreibe(u, 'manifest.json', text);
  schreibe(u, 'service-worker.js', text);
  schreibe(u, 'version.txt', '8.638.0\n');
  schreibe(u, 'patchnotes-archiv.json', text);
  // Ein PNG-Platzhalter: Inhalt egal, es geht nur darum, dass er KEINE .gz bekommt.
  schreibe(u, 'icon-192.png', text);
}

// ---------------------------------------------------------------- 1. Jede Textdatei bekommt eine .gz
{
  const u = baueUmgebung();
  grundbestand(u, TEXT);
  const r = fuehreAus(u);
  check('1a: der Deploy-Befehl laeuft durch', r.status === 0, (r.stderr || '').slice(0, 160));
  // seiten.css seit dem 11.09.2026: das Stylesheet der Themenseiten fehlte in der Kopierliste (live gemessen);
  // ausgeliefert wird es ueber das Muster *.css.
  const erwartet = ['weltraum_kolonie.html', 'patchnotes.html', 'robots.txt', 'sitemap.xml', 'patchnotes.xml', 'seiten.css',
    'manifest.json', 'service-worker.js', 'version.txt', 'patchnotes-archiv.json'];
  const fehlend = erwartet.filter(f => !fs.existsSync(path.join(u.ziel, f + '.gz')));
  check('1b: jede ausgelieferte Textdatei hat eine .gz', fehlend.length === 0, fehlend);
  const ohneOriginal = erwartet.filter(f => !fs.existsSync(path.join(u.ziel, f)));
  check('1c: das Original bleibt liegen (nginx braucht beide)', ohneOriginal.length === 0, ohneOriginal);
  const roh = messe(() => fs.statSync(path.join(u.ziel, 'weltraum_kolonie.html')).size, -1);
  const gz = messe(() => fs.statSync(path.join(u.ziel, 'weltraum_kolonie.html.gz')).size, -1);
  check('1d: die .gz ist deutlich kleiner als das Original', gz > 0 && roh > 0 && gz < roh / 2, { roh, gz });
  // Und sie ist wirklich der Inhalt, nicht irgendetwas: entpacken und vergleichen.
  const entpackt = messe(() => gunzipSync(fs.readFileSync(path.join(u.ziel, 'weltraum_kolonie.html.gz'))).toString('utf8'), null);
  check('1e: die .gz enthaelt genau den ausgelieferten Inhalt', entpackt === TEXT,
    entpackt === null ? 'keine .gz vorhanden' : undefined);
  fs.rmSync(u.wurzel, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 2. Veraltete .gz wird ueberschrieben
// Der eigentliche Anlass: nginx liefert eine alte .gz ohne Zeitstempelvergleich weiter aus.
{
  const u = baueUmgebung();
  grundbestand(u, TEXT);
  fuehreAus(u);                                    // erster Deploy
  grundbestand(u, TEXT2);                          // neuer Stand im Repo
  const r = fuehreAus(u);                          // zweiter Deploy
  check('2a: der zweite Deploy laeuft durch', r.status === 0, (r.stderr || '').slice(0, 160));
  const entpackt = messe(() => gunzipSync(fs.readFileSync(path.join(u.ziel, 'weltraum_kolonie.html.gz'))).toString('utf8'), null);
  check('2b: die .gz traegt den NEUEN Stand, nicht den alten', entpackt === TEXT2,
    { anfang: entpackt === null ? 'keine .gz vorhanden' : entpackt.slice(0, 40) });
  fs.rmSync(u.wurzel, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 3. Binaerdateien bleiben aussen vor
{
  const u = baueUmgebung();
  grundbestand(u, TEXT);
  fuehreAus(u);
  check('3a: das PNG wird ausgeliefert', fs.existsSync(path.join(u.ziel, 'icon-192.png')));
  check('3b: aber ohne .gz - gzip macht Bilder nur groesser',
    !fs.existsSync(path.join(u.ziel, 'icon-192.png.gz')));
  fs.rmSync(u.wurzel, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 4. Fehlende optionale Datei
// Die Kopierschritte tragen `|| true`, damit ein fehlendes sitemap.xml die Auslieferung nicht
// reisst. Das gzip darf daraus keinen Fehlschlag machen.
{
  const u = baueUmgebung();
  grundbestand(u, TEXT);
  fs.unlinkSync(path.join(u.quelle, 'sitemap.xml'));
  const r = fuehreAus(u);
  check('4a: eine fehlende optionale Datei reisst den Deploy nicht', r.status === 0,
    { status: r.status, stderr: (r.stderr || '').slice(0, 140) });
  check('4b: die uebrigen Dateien sind trotzdem komprimiert',
    fs.existsSync(path.join(u.ziel, 'weltraum_kolonie.html.gz')) &&
    fs.existsSync(path.join(u.ziel, 'version.txt.gz')));
  fs.rmSync(u.wurzel, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 5. Gescheitertes gzip bricht ab
// Gegenprobe zu 4: Ist die Datei DA und das gzip scheitert trotzdem, muss die Kette abbrechen -
// sonst laege im Zielverzeichnis womoeglich eine alte .gz, die nginx weiter ausliefert.
// Nachgestellt ueber ein gzip im PATH, das immer scheitert.
{
  const u = baueUmgebung();
  grundbestand(u, TEXT);
  const bin = path.join(u.wurzel, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gzip'), '#!/bin/sh\necho "kein Platz auf dem Geraet" >&2\nexit 1\n');
  fs.chmodSync(path.join(bin, 'gzip'), 0o755);
  const r = fuehreAus(u, { PATH: bin + path.delimiter + process.env.PATH });
  check('5a: ein gescheitertes gzip reisst den Deploy (Exit != 0)', r.status !== 0, { status: r.status });
  check('5b: ... und der Grund steht im Protokoll', /kein Platz/.test(r.stderr || ''), (r.stderr || '').slice(0, 120));
  fs.rmSync(u.wurzel, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 6. Die Listen bleiben deckungsgleich
// Die REGEL, nicht die heutige Liste: Was der Kopierbefehl als Textdatei ausliefert, muss auch in
// der gzip-Liste stehen. Wer morgen eine neue Textdatei kopiert und das gzip vergisst, faellt hier.
{
  const kopiert = new Set();
  for (const m of DEPLOY_WEB_COPY.matchAll(/cp -f ([^|&]+?) \S*\/?web\//g)) {
    for (const t of m[1].trim().split(/\s+/)) kopiert.add(t);
  }
  const gezippt = new Set(DEPLOY_WEB_GZIP_DATEIEN.trim().split(/\s+/));
  const BINAER = new Set(['*.png', '*.woff2', '*.jpg', '*.ico']);
  const vergessen = [...kopiert].filter(t => !BINAER.has(t) && !gezippt.has(t));
  check('6a: jede kopierte Textdatei steht in der gzip-Liste', vergessen.length === 0, vergessen);
  const ueberfluessig = [...gezippt].filter(t => !kopiert.has(t));
  check('6b: die gzip-Liste nennt nichts, was gar nicht ausgeliefert wird', ueberfluessig.length === 0, ueberfluessig);
  check('6c: die Kopierliste wurde ueberhaupt erkannt (sonst waere 6a hohl)', kopiert.size >= 5, [...kopiert]);
}

// ------------------------------------------------------------- 7. Der englische Katalog ist ein eigenes Deploy-Artefakt
// Originale und gzip-Inhalte werden gelesen, nicht aus der Kopierliste abgeleitet.
const CATALOG = 'kepler-english.json';
const KATALOG1 = JSON.stringify({ version: 1, translations: { 'Kolonie Kepler-7': TEXT } });
const KATALOG2 = JSON.stringify({ version: 1, translations: { 'Kolonie Kepler-7': TEXT2 } });
const lies = (u, name) => messe(() => fs.readFileSync(path.join(u.ziel, name), 'utf8'), null);
const entpacke = (u, name) => messe(() => gunzipSync(fs.readFileSync(path.join(u.ziel, name + '.gz'))).toString('utf8'), null);
const regulär = (r, status) => r.status === status && !r.signal && !r.error;
{
  const u = baueUmgebung();
  try {
    grundbestand(u, TEXT); schreibe(u, CATALOG, KATALOG1); schreibe(u, 'unrelated.json', 'bleibt privat');
    const r = fuehreAus(u);
    check('7a: ein Frontend mit englischem Katalog wird regulaer ausgeliefert', regulär(r, 0), { status: r.status, error: r.error?.message });
    check('7b: der englische Katalog wird bytegenau kopiert', lies(u, CATALOG) === KATALOG1);
    check('7c: seine gzip-Datei enthaelt genau denselben Katalog', entpacke(u, CATALOG) === KATALOG1);
    check('7d: beliebige andere JSON-Dateien werden nicht mitveroeffentlicht', !fs.existsSync(path.join(u.ziel, 'unrelated.json')));
    schreibe(u, CATALOG, KATALOG2);
    const update = fuehreAus(u);
    check('7e: ein aktualisierter englischer Katalog wird regulaer ausgeliefert', regulär(update, 0), { status: update.status });
    check('7f: das Katalogoriginal traegt den neuen Inhalt', lies(u, CATALOG) === KATALOG2);
    check('7g: die Katalog-gzip-Datei traegt den neuen Inhalt', entpacke(u, CATALOG) === KATALOG2);
  } finally { fs.rmSync(u.wurzel, { recursive: true, force: true }); }
}
{
  const u = baueUmgebung();
  try {
    grundbestand(u, TEXT);
    const r = fuehreAus(u);
    check('8a: ein altes Frontend ohne englischen Katalog bleibt deploybar', regulär(r, 0), { status: r.status });
    check('8b: dessen normale Spiel- und Versionsdateien bleiben komprimiert', entpacke(u, 'weltraum_kolonie.html') === TEXT && entpacke(u, 'version.txt') === '8.638.0\n');
  } finally { fs.rmSync(u.wurzel, { recursive: true, force: true }); }
}
function sabotierterBefehl(u, name, marker){
  const program = spawnSync(SHELL, ['-c', 'command -v ' + name], { encoding: 'utf8', timeout: 5000 });
  if (!regulär(program, 0) || !program.stdout.trim()) throw new Error('native ' + name + ' unavailable');
  const bin = path.join(u.wurzel, 'bin'); fs.mkdirSync(bin);
  const script = '#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = "' + CATALOG + '" ]; then echo "' + marker + '" >&2; exit 73; fi; done\nexec ' + shellPath(program.stdout.trim()) + ' "$@"\n';
  fs.writeFileSync(path.join(bin, name), script); fs.chmodSync(path.join(bin, name), 0o755);
  return { PATH: bin + path.delimiter + process.env.PATH };
}
{
  const u = baueUmgebung();
  try {
    grundbestand(u, TEXT); schreibe(u, CATALOG, KATALOG2);
    fs.writeFileSync(path.join(u.ziel, CATALOG), KATALOG1);
    const r = fuehreAus(u, sabotierterBefehl(u, 'cp', 'catalog-copy-failed'));
    check('9a: ein Kopierfehler des vorhandenen Katalogs bricht den Deploy regulaer ab', regulär(r, 1), { status: r.status, signal: r.signal, error: r.error?.message });
    check('9b: der wirkliche Katalog-Kopierfehler bleibt im Protokoll', /catalog-copy-failed/.test(r.stderr || ''));
    check('9c: der fehlgeschlagene Katalog-Kopierversuch ueberschreibt keinen alten Inhalt', lies(u, CATALOG) === KATALOG1);
  } finally { fs.rmSync(u.wurzel, { recursive: true, force: true }); }
}
{
  const u = baueUmgebung();
  try {
    grundbestand(u, TEXT); schreibe(u, CATALOG, KATALOG1);
    fuehreAus(u);
    // Der Altbestand wird unabhängig vom Prüfling vorbereitet; auch die Gegenprobe muss bis zum gzip kommen.
    const { gzipSync } = require('zlib');
    fs.writeFileSync(path.join(u.ziel, CATALOG), KATALOG1);
    fs.writeFileSync(path.join(u.ziel, CATALOG + '.gz'), gzipSync(KATALOG1));
    schreibe(u, CATALOG, KATALOG2);
    const r = fuehreAus(u, sabotierterBefehl(u, 'gzip', 'catalog-gzip-failed'));
    check('10a: ein gzip-Fehler des vorhandenen Katalogs bricht den Deploy regulaer ab', regulär(r, 1), { status: r.status, signal: r.signal, error: r.error?.message });
    check('10b: der wirkliche Katalog-gzip-Fehler bleibt im Protokoll', /catalog-gzip-failed/.test(r.stderr || ''));
    check('10c: eine alte Katalog-gzip-Datei ist nicht als neuer Erfolg umgeschrieben', entpacke(u, CATALOG) === KATALOG1);
  } finally { fs.rmSync(u.wurzel, { recursive: true, force: true }); }
}
{
  const u = baueUmgebung();
  try {
    grundbestand(u, TEXT); fs.mkdirSync(path.join(u.quelle, CATALOG));
    const r = fuehreAus(u);
    check('11a: ein vorhandener Katalogpfad als Verzeichnis wird nicht als fehlende Altdatei behandelt', regulär(r, 1), { status: r.status });
  } finally { fs.rmSync(u.wurzel, { recursive: true, force: true }); }
}
{
  const u = baueUmgebung();
  try {
    grundbestand(u, TEXT); schreibe(u, CATALOG, KATALOG1); fs.mkdirSync(path.join(u.ziel, CATALOG));
    const r = fuehreAus(u);
    check('12a: ein Verzeichnis am Katalogziel wird nicht als erfolgreiches Kopieren behandelt', regulär(r, 1), { status: r.status });
  } finally { fs.rmSync(u.wurzel, { recursive: true, force: true }); }
}

console.log('\n' + checks + ' Pruefungen, ' + failures + ' fehlgeschlagen');
console.log(fail ? 'FEHLGESCHLAGEN' : 'Alles gruen');
process.exit(fail ? 1 : 0);
