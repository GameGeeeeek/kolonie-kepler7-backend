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
//   6  der Neustart merkt die ANDEREN Ziele vor, und zwar VOR dem Beenden - und nur dann,
//      wenn er wirklich feuert (die drei Nein-Faelle aus 1 duerfen nichts vormerken)
//   7  deployAndereVormerken selbst, an einem echten Verzeichnis gemessen: Marker fuer das
//      FREMDE Ziel, dessen liegengebliebene Sperre weg, das eigene unangetastet
//   8  waehrend des Neustarts wird kein Marker mehr VERBRAUCHT (sonst stirbt der Nachhol-Lauf
//      mit dem Prozess, und der Marker ist trotzdem weg)
//   9  waehrend des Neustarts wird auch kein Lauf mehr GESTARTET - sonst liefe ein zweites `git`
//      im selben Arbeitsbaum, sobald die Sperre entfernt ist (Codex-Befund zu #260)
//  10  und die Marke ist keine Einbahn-Sperre: scheitert das Beenden, lebt der Prozess weiter
//      und muss weiter deployen koennen
//
// ANLASS FUER 6-8, gemessen am 06.09.2026: Backend-Merge 11:12:39Z, Frontend-Merge 11:12:44Z,
// Neustart 11:12:44Z. Der Frontend-Webhook fiel in die Auszeit, live blieb eine Version zurueck,
// und das Log meldete fuer das Backend "erfolgreich". Die alte Vormerkung griff nicht: Sie deckt
// nur zwei Pushs DESSELBEN Repos ab.
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
    'deployAndereVormerken', 'deployBeendetSich',
    teil + '\nreturn deploySelbstNeustart;');
} catch (e) { baufehler = e.message; }
check('0-bau: deploySelbstNeustart laesst sich aus server.js schneiden', !!bau, { fehler: baufehler });
if (!bau) { console.log('\nFEHLGESCHLAGEN'); process.exit(1); }

// Der Stellvertreter muss ALLE Kanaele kennen, die der geschnittene Code benutzt - sonst wirft
// ausgerechnet der Fehlerpfad an `console.error is not a function`, und der Test misst seinen
// eigenen Stellvertreter statt den Pruefling. Genau so ist 7f beim ersten Lauf gefallen.
const STILL = { log: () => {}, warn: () => {}, error: () => {} };
// Ein Lauf: Schalter, eigenes Verzeichnis, uebergebenes Verzeichnis, gemeldete Aenderungen.
function lauf(schalter, eigenes, dir, geaendert) {
  const gerufen = [];
  // `ablauf` haelt zusaetzlich die REIHENFOLGE fest. Ohne sie waere "es wird vorgemerkt UND
  // beendet" gruen, auch wenn die Vormerkung erst nach dem Exit kaeme - also nie.
  const ablauf = [];
  let fehler = null, ergebnis = null;
  // `process` wird MITGEGEBEN und sein exit abgefangen. Ohne das beendet eine Sabotage, die
  // handleTerminate durch process.exit ersetzt, den TESTPROZESS - gemessen: 2 statt 18
  // Pruefungen und EXIT=0, also eine Gegenprobe, die wie ein sauberer Lauf aussieht (Regel 34).
  const gefaelscht = Object.create(process);
  gefaelscht.exit = (code) => { gerufen.push('process.exit(' + code + ')'); ablauf.push('exit'); };
  try {
    const fn = bau(schalter, eigenes, path, () => geaendert,
      // handleTerminate ist in server.js `async` und liefert damit IMMER eine Zusage; der Aufrufer
      // haengt seit #260 ein .catch daran. Ein Stellvertreter, der undefined liefert, stirbt dort
      // an "Cannot read properties of undefined" - gemessen. Ein Stellvertreter muss den
      // Pruefling spiegeln, sonst misst der Test sich selbst.
      (grund) => { gerufen.push(grund); ablauf.push('beenden:' + grund); return Promise.resolve(); },
      STILL, gefaelscht,
      (name) => ablauf.push('vormerken:' + name),
      false);
    ergebnis = fn('kolonie-kepler7-backend', dir);
  } catch (e) { fehler = e.message; }
  return { ergebnis, gerufen, ablauf, fehler };
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

// ---- 6) Der Neustart merkt die ANDEREN Ziele vor - vorher, und nur wenn er wirklich feuert ----
// Der gemessene Ausfall: Der Frontend-Deploy hing an einem Prozess, der sich gerade beendete.
// Die Reihenfolge ist der Kern - eine Vormerkung NACH handleTerminate faende nie statt.
{
  const an     = lauf(true,  EIGEN, EIGEN, ['server.js']);
  const aus    = lauf(false, EIGEN, EIGEN, ['server.js']);
  const ruhig  = lauf(true,  EIGEN, EIGEN, []);
  const fremd  = lauf(true,  EIGEN, FREMD, ['server.js']);

  check('6: der Neustart merkt genau einmal vor, und zwar VOR dem Beenden',
    JSON.stringify(an.ablauf) === JSON.stringify(['vormerken:kolonie-kepler7-backend', 'beenden:DEPLOY-NEUSTART']),
    an.ablauf);
  // Die drei Nein-Faelle: Wer nicht neu startet, nimmt auch keinen fremden Deploy mit - eine
  // Vormerkung waere dort ein ueberfluessiger Pull bei JEDEM Doku-Commit und jedem Frontend-Push.
  check('6b: Schalter aus -> keine Vormerkung', aus.ablauf.length === 0, aus.ablauf);
  check('6c: nichts geaendert -> keine Vormerkung', ruhig.ablauf.length === 0, ruhig.ablauf);
  check('6d: fremdes Verzeichnis -> keine Vormerkung', fremd.ablauf.length === 0, fremd.ablauf);
  // Dass das EIGENE Repo dabei keinen Marker bekommt (sonst holte der Start den gerade gelaufenen
  // Backend-Deploy nach, und dessen Erfolg startete wieder neu - eine Schleife), ist an dieser
  // Stelle nicht messbar: deployAndereVormerken ist hier ein Stellvertreter. Das misst 7c/7d.
}

// ---- 7) deployAndereVormerken selbst, an einem ECHTEN Verzeichnis gemessen --------------------
// Nicht gegreppt: Die Funktion wird geschnitten und mit einem echten deployPfad auf ein
// Wegwerf-Verzeichnis gefahren. Die Ziel-NAMEN kommen aus server.js, nicht aus diesem Test -
// eine gepflegte Liste hier waere beim naechsten dritten Repo still veraltet.
{
  const zielBlock = OHNE_KOMMENTARE.slice(OHNE_KOMMENTARE.indexOf('const DEPLOY_TARGETS = {'));
  const zielNamen = (zielBlock.slice(0, zielBlock.indexOf('\n};')).match(/^\s*'([^']+)':/gm) || [])
    .map(z => z.trim().replace(/^'/, '').replace(/':$/, ''));
  check('7-anker: die Ziel-Namen sind aus server.js ablesbar', zielNamen.length >= 2, zielNamen);

  const teil = schneide('deployAndereVormerken');
  let fn = null, fehler = null;
  const raum = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler7-vormerken-'));
  const pfad = (repoName, endung) => path.join(raum, 'd-' + repoName + endung);
  try {
    if (!teil) throw new Error('deployAndereVormerken nicht gefunden');
    const ziele = {};
    for (const n of zielNamen) ziele[n] = {};
    fn = new Function('fs', 'DEPLOY_TARGETS', 'deployPfad', 'console',
      teil + '\nreturn deployAndereVormerken;')(fs, ziele, pfad, STILL);
  } catch (e) { fehler = e.message; }
  check('7-bau: deployAndereVormerken laesst sich schneiden und ausfuehren', !!fn, { fehler });

  if (fn && zielNamen.length >= 2) {
    const EIGENES = 'kolonie-kepler7-backend';
    const ANDERES = zielNamen.find(n => n !== EIGENES);
    // Beide Sperren liegen da - so, wie sie ein abgewuergter Prozess hinterlaesst.
    fs.writeFileSync(pfad(EIGENES, '.lock'), 'x');
    fs.writeFileSync(pfad(ANDERES, '.lock'), 'x');
    fn(EIGENES);
    check('7a: das FREMDE Ziel ist vorgemerkt', fs.existsSync(pfad(ANDERES, '.pending')), { ziel: ANDERES });
    check('7b: und seine liegengebliebene Sperre ist weg (sonst blockiert sie 11 Minuten lang)',
      !fs.existsSync(pfad(ANDERES, '.lock')));
    // Die Gegenrichtung, und sie ist der eigentliche Beleg: Ohne sie waere eine Fassung gruen,
    // die einfach ALLES vormerkt - und die brauechte nur einen Start, um sich im Kreis zu drehen.
    check('7c: das EIGENE Ziel bekommt keinen Marker', !fs.existsSync(pfad(EIGENES, '.pending')));
    check('7d: und seine Sperre wird nicht angefasst', fs.existsSync(pfad(EIGENES, '.lock')));

    // Und der Parameter wird wirklich BENUTZT: mit vertauschten Rollen dreht sich das Ergebnis um.
    const raum2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler7-vormerken2-'));
    const pfad2 = (repoName, endung) => path.join(raum2, 'd-' + repoName + endung);
    const ziele2 = {}; for (const n of zielNamen) ziele2[n] = {};
    const fn2 = new Function('fs', 'DEPLOY_TARGETS', 'deployPfad', 'console',
      teil + '\nreturn deployAndereVormerken;')(fs, ziele2, pfad2, STILL);
    fn2(ANDERES);
    check('7e: mit vertauschten Rollen kehrt sich die Vormerkung um (der Parameter wirkt)',
      fs.existsSync(pfad2(EIGENES, '.pending')) && !fs.existsSync(pfad2(ANDERES, '.pending')),
      { eigenes: fs.existsSync(pfad2(EIGENES, '.pending')), anderes: fs.existsSync(pfad2(ANDERES, '.pending')) });
    fs.rmSync(raum2, { recursive: true, force: true });

    // 7f: Sie steht unmittelbar VOR handleTerminate. Wuerfe sie, bliebe der Neustart aus - der Fix
    // haette dann einen selten verlorenen Frontend-Deploy gegen ein Backend getauscht, das nach
    // JEDEM Deploy auf altem Code stehen bleibt. Gemessen mit einem deployPfad, der wirft.
    const gemeldet = [];
    const LAUT = { log: () => {}, warn: () => {}, error: (...a) => gemeldet.push(a.join(' ')) };
    const kaputt = new Function('fs', 'DEPLOY_TARGETS', 'deployPfad', 'console',
      teil + '\nreturn deployAndereVormerken;')(fs, ziele2, () => { throw new Error('Platte voll'); }, LAUT);
    let geworfen = null;
    try { kaputt(EIGENES); } catch (e) { geworfen = e.message; }
    check('7f: ein Fehler beim Vormerken haelt den Neustart NICHT auf', geworfen === null, { geworfen });
    // Und er wird BENANNT, nicht verschluckt: Ein stiller Fang macht aus dem seltenen verlorenen
    // Deploy einen unauffindbaren.
    check('7g: und der Grund steht im Protokoll', gemeldet.some(z => /Platte voll/.test(z)), gemeldet);

  }
  fs.rmSync(raum, { recursive: true, force: true });
}

// ---- 8) Waehrend des Neustarts wird kein Marker mehr VERBRAUCHT -------------------------------
// handleTerminate ist async. Feuert der Rueckruf eines fremden Deploys zwischen der Entscheidung
// und dem Exit, verbrauchte er den gerade geschriebenen Marker und startete einen Lauf, der mit
// dem Prozess stirbt - der Marker waere weg und die Luecke wieder offen.
{
  const i = OHNE_KOMMENTARE.indexOf('function starteDeploy(');
  const sperre   = OHNE_KOMMENTARE.indexOf('if (deployBeendetSich) return;', i);
  const nachhol  = OHNE_KOMMENTARE.indexOf("const pending = deployPfad(repoName, '.pending')", i);
  check('8-anker: starteDeploy und seine Nachhol-Stelle sind auffindbar', i > 0 && nachhol > i, { i, nachhol });
  check('8: die Sperre gegen das Verbrauchen steht VOR der Nachhol-Stelle',
    sperre > i && sperre < nachhol, { sperre, nachhol });
  // Und sie steht HINTER dem Freigeben der eigenen Sperre - sonst bliebe die als Leiche liegen.
  const frei = OHNE_KOMMENTARE.indexOf('deploySperreFreigeben(repoName)', i);
  check('8b: und HINTER dem Freigeben der eigenen Sperre', frei > i && frei < sperre, { frei, sperre });
  // Gesetzt wird die Marke im Neustart, und zwar vor dem Vormerken.
  const rumpf = schneide('deploySelbstNeustart') || '';
  const gesetzt = rumpf.indexOf('deployBeendetSich = true');
  const vormerk = rumpf.indexOf('deployAndereVormerken(');
  check('8c: der Neustart setzt die Marke, bevor er vormerkt',
    gesetzt > 0 && vormerk > gesetzt, { gesetzt, vormerk });
}

// ---- 9) Waehrend des Neustarts startet starteDeploy KEINEN Lauf mehr ---------------------------
// Befund der Codex-Durchsicht zu #260, und er war berechtigt: httpServer.close() laesst bereits
// angenommene Anfragen zu Ende laufen. Eine davon erreicht starteDeploy, NACHDEM
// deployAndereVormerken die Sperre des anderen Ziels entfernt hat - sie ist frei, der Lauf startet
// ein ZWEITES `git` im selben Arbeitsbaum. Genau die Kollision, gegen die die Sperre gebaut ist,
// und vor dieser Aenderung hielt die liegengebliebene Sperre solche Anfragen auf.
// GEMESSEN, nicht gegreppt: starteDeploy wird geschnitten und mit beobachteten Bindungen gefahren.
{
  const teil = schneide('starteDeploy');
  check('9-bau: starteDeploy laesst sich schneiden', !!teil, { laenge: teil ? teil.length : 0 });
  if (teil) {
    const raum = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler7-starte-'));
    // Ein Lauf mit gestellter Marke. Alles, was starteDeploy anfassen koennte, wird beobachtet.
    function starte(beendetSich) {
      const gesehen = [];
      const pfad = (r, e) => path.join(raum, beendetSich + '-' + r + e);
      const fn = new Function('deployBeendetSich', 'fs', 'deployPfad', 'console', 'deploySperreNehmen',
        'deploySperreFreigeben', 'deployAufraeumen', 'exec', 'DEPLOY_TIMEOUT_MS', 'deployAlarm', 'deploySelbstNeustart',
        teil + '\nreturn starteDeploy;')(
        beendetSich, fs, pfad, STILL,
        (r) => { gesehen.push('sperreNehmen:' + r); return true; },
        (r) => gesehen.push('sperreFrei:' + r),
        () => [],
        (cmd) => { gesehen.push('exec'); },     // kein Rueckruf: der Lauf haenge, wie ein echtes git
        1000,
        () => gesehen.push('alarm'),
        () => gesehen.push('neustart'));
      fn('kolonie-kepler7', 'git pull', '/deploy/kolonie-kepler7');
      return { gesehen, marker: fs.existsSync(pfad('kolonie-kepler7', '.pending')) };
    }

    const imNeustart = starte(true);
    check('9: waehrend des Neustarts wird die Sperre gar nicht erst genommen',
      !imNeustart.gesehen.some(z => z.startsWith('sperreNehmen')), imNeustart.gesehen);
    check('9b: und kein zweites `git` gestartet (das ist der eigentliche Schaden)',
      !imNeustart.gesehen.includes('exec'), imNeustart.gesehen);
    check('9c: der Push geht trotzdem nicht verloren - er ist vorgemerkt',
      imNeustart.marker === true, imNeustart);

    // Die Gegenrichtung, und ohne sie belegt 9/9b nichts: Ein starteDeploy, das NIE etwas tut,
    // waere oben genauso gruen.
    const normal = starte(false);
    check('9d: ohne Neustart nimmt derselbe Aufruf die Sperre und startet den Lauf',
      normal.gesehen.includes('sperreNehmen:kolonie-kepler7') && normal.gesehen.includes('exec'), normal.gesehen);
    check('9e: und merkt dann nichts vor (der Marker ist die AUSNAHME, nicht der Normalfall)',
      normal.marker === false, normal);
    fs.rmSync(raum, { recursive: true, force: true });
  }
}

// ---- 10) Die Marke ist keine Einbahn-Sperre ---------------------------------------------------
// Sie sperrt jeden weiteren Deploy. Das ist richtig, solange der Prozess auch geht - scheitert
// handleTerminate, lebt er weiter (eine abgelehnte Zusage beendet diesen Server bewusst nicht) und
// haette nie wieder einen Deploy gemacht: ein lautloser Dauerausfall. Geprueft wird die
// VERDRAHTUNG, nicht die Wirkung: Der Ruecknahme-Zweig laeuft nur in einem Prozess, der eigentlich
// sterben sollte - den kann dieser Test nicht nachstellen, ohne mehr zu faelschen als er misst.
{
  const rumpf = schneide('deploySelbstNeustart') || '';
  check('10: am Beenden haengt ein Fang', /handleTerminate\([^)]*\)\s*\.catch\s*\(/.test(rumpf));
  const nachCatch = rumpf.slice(rumpf.indexOf('.catch'));
  check('10b: und er nimmt die Marke zurueck', /deployBeendetSich\s*=\s*false/.test(nachCatch),
    { ausschnitt: nachCatch.slice(0, 120).replace(/\s+/g, ' ') });
  check('10c: und sagt, dass der Neustart gescheitert ist', /console\.error/.test(nachCatch));
}

console.log('\n' + (okZahl + failZahl) + ' Pruefungen, ' + failZahl + ' fehlgeschlagen');
console.log(failZahl === 0 ? 'Alles gruen.' : 'FEHLGESCHLAGEN');
process.exit(failZahl === 0 ? 0 : 1);
