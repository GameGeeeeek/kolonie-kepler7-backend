// Der Deploy startet den Server selbst neu, statt sich von nodemon abwuergen zu lassen
// (28.08.2026, Entscheidung Sascha: "finde eine loesung das jeder chat mit dem backend arbeiten
// kann und sich nicht selbst blockiert").
//
//   node tests/test_deploy_neustart.js
//
// DER ANLASS IST GEMESSEN. Dreizehn Deploy-Ausfaelle, alle mit demselben Fingerabdruck: neuer
// Arbeitsbaum, altes .git/HEAD, eine Sperre liegengeblieben. Ursache im Container-Log belegt -
// `git pull` schreibt server.js, nodemon startet daraufhin neu und raeumt den laufenden
// git-Prozess mit ab, bevor er den Ref gesetzt hat.
//
// Der BELEG fuer die Ursache ist die Asymmetrie, nicht das Log allein: Der Frontend-Deploy laeuft
// ueber denselben Webhook, dieselben Pushes und dieselben parallel arbeitenden Sitzungen - und
// hatte NULL Ausfaelle. Der einzige Unterschied ist, dass dort niemand das gepullte Verzeichnis
// beobachtet. Die Parallelitaet hat die Haeufigkeit erhoeht, nicht den Fehler erzeugt.
//
// WAS GEPRUEFT WIRD - jede Zeile als PAAR, weil ein Neustart, der IMMER feuert, genauso kaputt
// ist wie einer, der nie feuert:
//   1  Schalter aus  -> kein Neustart (der Vorgabezustand: ohne Container-Umbau aendert sich nichts)
//   1b Schalter an, Code geaendert, eigenes Verzeichnis -> Neustart
//   1c Schalter an, aber NICHTS geaendert (Doku-Commit) -> kein Neustart
//   1d Schalter an, aber FREMDES Verzeichnis (Frontend-Ziel) -> kein Neustart
//   2  der Neustart laeuft ueber handleTerminate, nicht ueber ein nacktes process.exit
//      (sonst waere ein Datenverlust gegen einen Deploy-Ausfall getauscht)
//   3  geaenderteModule() misst wirklich den Dateiinhalt - an einer echten Datei gemessen
//   4  Verdrahtung: der vorgemerkte Push wird VOR dem Neustart nachgeholt
//   5  ein beim Start gefundener .pending-Marker wird nachgeholt
//
// GEMESSEN WIRD AUSGEFUEHRT, nicht gegreppt: Die Funktion wird aus server.js geschnitten und mit
// beobachteten Bindings gefahren. Ein Test, der bei einer Neustart-Entscheidung nur nach
// Zeichenketten sucht, belegt nicht, WANN sie feuert.
//
// GEGENPROBE gegen den Stand davor (KEPLER_BACKEND_SERVER): dort gibt es die Funktion nicht,
// 0-bau faellt und mit ihm alles, was sie ausfuehrt.
const fs = require('fs');
const path = require('path');
const os = require('os');

const SERVER_JS = process.env.KEPLER_BACKEND_SERVER || path.join(__dirname, '..', 'server.js');
let okZahl = 0, failZahl = 0;
function check(name, bedingung, beleg) {
  console.log((bedingung ? 'OK   - ' : 'FAIL - ') + name + (beleg !== undefined ? ' | ' + JSON.stringify(beleg) : ''));
  if (bedingung) okZahl++; else failZahl++;
}

const S = fs.readFileSync(SERVER_JS, 'utf8');
// Zeilenkommentare ZUERST, dann Bloecke - server.js enthaelt Zeilenkommentare mit einem `/*`
// darin, und wer zuerst nach Bloecken sucht, leert echten Code mit (die Lehre aus
// test_deploy_selbstheilung).
const OHNE_KOMMENTARE = S.replace(/^([ \t]*)\/\/.*$/gm, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))
                         .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));

function schneide(name) {
  const i = OHNE_KOMMENTARE.indexOf('function ' + name + '(');
  if (i < 0) return null;
  let tiefe = 0, start = OHNE_KOMMENTARE.indexOf('{', i);
  for (let j = start; j < OHNE_KOMMENTARE.length; j++) {
    const c = OHNE_KOMMENTARE[j];
    if (c === '{') tiefe++;
    else if (c === '}') { tiefe--; if (tiefe === 0) return S.slice(i, j + 1); }
  }
  return null;
}

// ---- 0) Schneiden und ausfuehrbar machen ------------------------------------------------------
// Die Bindings sind BEOBACHTET, nicht echt: geaenderteModule und handleTerminate werden vom Test
// gestellt, damit jede der vier Bedingungen einzeln gestellt werden kann. Der Schalter ist im
// Rumpf eine freie Variable und wird je Lauf neu gesetzt.
let bau = null, baufehler = null;
try {
  const teil = schneide('deploySelbstNeustart');
  if (!teil) throw new Error('deploySelbstNeustart nicht gefunden');
  bau = new Function('DEPLOY_SELBST_NEUSTART', '__dirname', 'path', 'geaenderteModule', 'handleTerminate', 'console', 'process',
    teil + '\nreturn deploySelbstNeustart;');
} catch (e) { baufehler = e.message; }
check('0-bau: deploySelbstNeustart laesst sich aus server.js schneiden', !!bau, { fehler: baufehler });
if (!bau) { console.log('\nFEHLGESCHLAGEN'); process.exit(1); }

const STILL = { log: () => {} };
// Ein Lauf: Schalter, eigenes Verzeichnis, uebergebenes Verzeichnis, gemeldete Aenderungen.
function lauf(schalter, eigenes, dir, geaendert) {
  const gerufen = [];
  let fehler = null, ergebnis = null;
  // `process` wird MITGEGEBEN und sein exit abgefangen. Ohne das beendet eine Sabotage, die
  // handleTerminate durch process.exit ersetzt, den TESTPROZESS - gemessen: 2 statt 18
  // Pruefungen und EXIT=0, also eine Gegenprobe, die wie ein sauberer Lauf aussieht (Regel 34).
  const gefaelscht = Object.create(process);
  gefaelscht.exit = (code) => gerufen.push('process.exit(' + code + ')');
  try {
    const fn = bau(schalter, eigenes, path, () => geaendert, (grund) => gerufen.push(grund), STILL, gefaelscht);
    ergebnis = fn('kolonie-kepler7-backend', dir);
  } catch (e) { fehler = e.message; }
  return { ergebnis, gerufen, fehler };
}
const EIGEN = '/app', FREMD = '/deploy/kolonie-kepler7';

// ---- 1) Die vier Bedingungen, jede einzeln gestellt -------------------------------------------
{
  const aus = lauf(false, EIGEN, EIGEN, ['server.js']);
  check('1: Schalter aus -> kein Neustart (der Vorgabezustand)',
    aus.ergebnis === false && aus.gerufen.length === 0, aus);

  const an = lauf(true, EIGEN, EIGEN, ['server.js']);
  check('1b: Schalter an, Code geaendert, eigenes Verzeichnis -> Neustart',
    an.ergebnis === true && an.gerufen.length === 1, an);

  const ruhig = lauf(true, EIGEN, EIGEN, []);
  check('1c: nichts geaendert (Doku-Commit) -> kein Neustart',
    ruhig.ergebnis === false && ruhig.gerufen.length === 0, ruhig);

  const fremd = lauf(true, EIGEN, FREMD, ['server.js']);
  check('1d: fremdes Verzeichnis (Frontend-Ziel) -> kein Neustart',
    fremd.ergebnis === false && fremd.gerufen.length === 0, fremd);

  // Ohne diese Zeile koennte 1b auch dann gruen sein, wenn die Funktion IMMER true liefert.
  check('1-paar: die vier Laeufe unterscheiden sich wirklich',
    [aus, an, ruhig, fremd].filter(r => r.ergebnis === true).length === 1,
    { ergebnisse: [aus.ergebnis, an.ergebnis, ruhig.ergebnis, fremd.ergebnis] });
}

// ---- 2) Der Neustart geht ueber handleTerminate, nicht ueber process.exit ---------------------
// Das ist keine Stilfrage: handleTerminate schliesst den HTTP-Server und FLUSHT die Datenbank.
// Ein nacktes process.exit haette hier einen Datenverlust gegen einen Deploy-Ausfall getauscht.
{
  const rumpf = schneide('deploySelbstNeustart') || '';
  check('2: der Neustart ruft handleTerminate', /handleTerminate\s*\(/.test(rumpf), { rumpfLaenge: rumpf.length });
  check('2b: und KEIN nacktes process.exit', !/process\.exit\s*\(/.test(rumpf));
  // Und die Gegenrichtung: handleTerminate muss die DB wirklich flushen, sonst ist 2 ein Etikett.
  const term = schneide('handleTerminate') || '';
  check('2c: handleTerminate flusht die DB und schliesst den Server',
    /flushBeforeExit\s*\(/.test(term) && /httpServer\.close\s*\(/.test(term), { termLaenge: term.length });
}

// ---- 3) geaenderteModule misst wirklich den Dateiinhalt ---------------------------------------
// An einer ECHTEN Datei gemessen: Die Hash-Rechnung muss auf eine Aenderung reagieren und bei
// unveraendertem Inhalt still bleiben. Ohne den zweiten Teil waere jede Rechnung "gruen", die
// einfach immer etwas meldet.
{
  const teil = schneide('eigeneModulHashes');
  let hashes = null, fehler = null;
  try {
    if (!teil) throw new Error('eigeneModulHashes nicht gefunden');
    hashes = new Function('fs', 'path', 'crypto', '__dirname', 'require',
      teil + '\nreturn eigeneModulHashes;')(fs, path, require('crypto'), os.tmpdir(), { cache: {} });
  } catch (e) { fehler = e.message; }
  check('3-bau: eigeneModulHashes laesst sich schneiden und ausfuehren', !!hashes, { fehler });
  if (hashes) {
    // Ein Wegwerf-"Modul" unter dem vorgegebenen __dirname, ueber einen gefaelschten require.cache.
    const raum = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler7-neustart-'));
    const datei = path.join(raum, 'modul.js');
    fs.writeFileSync(datei, 'alt\n');
    const fn = new Function('fs', 'path', 'crypto', '__dirname', 'require',
      teil + '\nreturn eigeneModulHashes;')(fs, path, require('crypto'), raum, { cache: { [datei]: {} } });
    const vorher = fn();
    const gleich = fn();
    fs.writeFileSync(datei, 'neu\n');
    const nachher = fn();
    check('3: derselbe Inhalt ergibt denselben Hash',
      vorher['modul.js'] && vorher['modul.js'] === gleich['modul.js'], { vorher: vorher['modul.js'] });
    check('3b: geaenderter Inhalt ergibt einen anderen Hash',
      !!nachher['modul.js'] && nachher['modul.js'] !== vorher['modul.js'],
      { vorher: vorher['modul.js'], nachher: nachher['modul.js'] });
    fs.rmSync(raum, { recursive: true, force: true });
  }
}

// ---- 4) Verdrahtung: der vorgemerkte Push kommt VOR dem Neustart ------------------------------
// Ein Neustart mitten drin verliert genau den Push, den die Vormerkung retten soll.
{
  const i = OHNE_KOMMENTARE.indexOf('function starteDeploy(');
  // NICHT auf '.pending' suchen: Der Marker wird schon ganz oben im Sperr-Zweig GESCHRIEBEN, und
  // indexOf faende diesen ersten Treffer - eine Sabotage, die den Neustart davorzieht, blieb damit
  // gemessen gruen. Gescopt wird auf die NACHHOL-Stelle, also den rekursiven Aufruf.
  const nachholen = OHNE_KOMMENTARE.indexOf('starteDeploy(repoName, command, dir)', i + 10);
  const neustart = OHNE_KOMMENTARE.indexOf('deploySelbstNeustart(repoName, dir)', i);
  check('4-anker: starteDeploy und seine Nachhol-Stelle sind auffindbar', i > 0 && nachholen > i, { i, nachholen });
  check('4: der vorgemerkte Push wird VOR dem Neustart nachgeholt',
    nachholen > 0 && neustart > 0 && nachholen < neustart, { nachholen, neustart });
  // Und der Nachhol-Zweig muss danach AUSSTEIGEN - sonst liefe der Neustart trotzdem und der
  // gerade angestossene Deploy verloere seinen Prozess mitten im Pull.
  check('4b2: der Nachhol-Zweig steigt danach aus (return)',
    /starteDeploy\(repoName, command, dir\);\s*\n\s*return;/.test(OHNE_KOMMENTARE.slice(i)),
    { ausschnitt: OHNE_KOMMENTARE.slice(nachholen, nachholen + 90).replace(/\s+/g, ' ') });
  // Und der Neustart haengt am ERFOLG - ein gescheiterter Deploy startet nichts neu.
  const zeile = (OHNE_KOMMENTARE.slice(i).split('\n').find(z => z.includes('deploySelbstNeustart(repoName, dir)')) || '');
  check('4b: der Neustart feuert nur bei erfolgreichem Deploy', /!err/.test(zeile), { zeile: zeile.trim() });
}

// ---- 5) Ein beim Start gefundener .pending-Marker wird nachgeholt -----------------------------
// Der Marker ist eine DATEI und ueberlebt den Neustart - gelesen wurde er bisher nur im laufenden
// Deploy. Ohne diese Stelle risse der Selbst-Neustart die Luecke auf, die die Vormerkung schliesst.
{
  const stelle = OHNE_KOMMENTARE.indexOf('vorgemerkten Push');
  check('5: beim Start wird ein vorgemerkter Push nachgeholt', stelle > 0, { stelle });
  const block = stelle > 0 ? OHNE_KOMMENTARE.slice(stelle - 400, stelle + 700) : '';
  check('5b: und zwar per setImmediate (sonst trifft der Rumpf eine Konstante in ihrer TDZ)',
    /setImmediate\s*\(/.test(block));
  check('5c: der Marker wird dabei entfernt, sonst liefe es bei jedem Start erneut',
    /unlinkSync/.test(block));
}

console.log('\n' + (okZahl + failZahl) + ' Pruefungen, ' + failZahl + ' fehlgeschlagen');
console.log(failZahl === 0 ? 'Alles gruen.' : 'FEHLGESCHLAGEN');
process.exit(failZahl === 0 ? 0 : 1);
