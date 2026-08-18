// Der Server startet ueberhaupt - und zwar bis zur horchenden Route.
//
//   node tests/test_serverstart.js
//
// DER BEFUND, der diesen Test ausgeloest hat (18.08.2026, Asteroidenfestungen Phase 1):
// `galaxyTick()` wurde bei Zeile 5526 MITTEN in der Modulauswertung einmal aufgerufen, damit nach
// einem Neustart nicht 15 Minuten auf den ersten Galaxie-Zustand gewartet werden muss. Der Rumpf
// dieser Funktion sieht damit jede `const`, die weiter unten in der Datei steht, in ihrer
// temporalen Todeszone. Beim Einbau von `FESTUNG_SPAWN_CHANCE` (Zeile 7908) war die Folge:
//
//   ReferenceError: Cannot access 'FESTUNG_SPAWN_CHANCE' before initialization
//       at galaxyTick (server.js:5364:23)
//       at Object.<anonymous> (server.js:5526:1)
//
// Bei JEDEM Start, nicht nur in 8 % der Faelle - der rechte Operand eines `<` wird immer
// ausgewertet. Der Deploy-Webhook zieht, nodemon startet neu, und das Backend waere weg gewesen,
// bis es jemandem auffaellt. Behoben, indem der Startlauf in `setImmediate` liegt: Er feuert,
// sobald die Modulauswertung fertig ist - also Millisekunden spaeter, die Absicht bleibt, und die
// ganze Fehlerklasse ist fuer jede kuenftige Konstante mit erledigt.
//
// WARUM ES DIESEN TEST BRAUCHT, obwohl es Pflichtpruefungen gibt:
// `node --check server.js` PARST nur und fuehrt nie aus - es hat den Fehler nicht gesehen. Genau
// dieselbe Luecke beschreibt die Frontend-CLAUDE.md als Arbeitsregel 38, dort fuer Array-Literale
// wie CREDIT_SHOP/HELP_SECTIONS; im Backend ist der Ausloeser ein Funktionsaufruf zur Ladezeit.
// Die HTTP-Tests dieses Repos wuerden es fangen, aber sie laufen laut CLAUDE.md nur "bei
// sicherheitsrelevanten Aenderungen an geteiltem Speicher". Dieser Test hier kostet ~3 Sekunden
// und gehoert deshalb vor JEDEN Commit, direkt hinter `node --check`.
//
// GEPRUEFT WIRD:
//   1. Der Prozess laeuft nach dem Start noch (kein Absturz waehrend der Modulauswertung).
//   2. Er horcht wirklich - /api/health antwortet mit 200.
//   3. Er ueberlebt eine volle Runde des Ereignis-Zyklus, in der `setImmediate` gefeuert hat.
//      Ohne diese Pruefung waere der setImmediate-Fix selbst nicht belegt: Ein Fehler DARIN
//      taucht erst nach der Modulauswertung auf, der Start saehe trotzdem gelungen aus.
//   4. Die Standardausgabe enthaelt keinen ReferenceError/TypeError.
//
// GEGENPROBE (in beide Richtungen ausgefuehrt):
//   * Gegen den Stand mit direktem `galaxyTick()` statt `setImmediate(galaxyTick)` fallen 1a, 2a
//     und 3a, und 4a nennt den ReferenceError im Klartext.
//   * Verschiebt man nur den Aufruf, laesst aber eine Konstante fehlen, faellt 3a allein - genau
//     die Aussage, fuer die Pruefung 3 da ist.
//
// Port 3220: 3195-3200 und 3210-3219 sind belegt (Arbeitsregel 29).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3220;

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-start-'));
  const dbDatei = path.join(dir, 'db.json');
  // Eine leere, aber gueltige DB - der Server soll seinen Normalweg gehen, nicht den Reparaturweg.
  fs.writeFileSync(dbDatei, JSON.stringify({ users: {}, private: {}, shared: {} }));

  let ausgabe = '';
  const srv = spawn('node', [path.join(WURZEL, 'server.js')], {
    cwd: WURZEL,
    env: {
      ...process.env,
      DB_FILE: dbDatei,
      PORT: String(PORT),
      JWT_SECRET_FILE: path.join(dir, 'jwt.txt'),
      VAPID_PUBLIC_FILE: path.join(dir, 'vapid-pub.txt'),
      VAPID_PRIVATE_FILE: path.join(dir, 'vapid-priv.txt')
    }
  });
  srv.stdout.on('data', d => { ausgabe += d.toString(); });
  srv.stderr.on('data', d => { ausgabe += d.toString(); });

  let beendetMit = null;
  srv.on('exit', (code, signal) => { beendetMit = signal || code; });

  // Warten, bis er horcht - oder bis er gestorben ist. Nicht blind schlafen: Bei einem Absturz
  // waere die Wartezeit sonst reine Verzoegerung, und der Fehlertext soll frueh vorliegen.
  let horcht = false;
  for (let i = 0; i < 40 && beendetMit === null && !horcht; i++) {
    await warte(250);
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/api/health');
      if (r.ok) horcht = true;
    } catch (e) { /* noch nicht oben */ }
  }

  check('1a: der Prozess laeuft nach dem Start noch', beendetMit === null,
    { beendetMit, ausgabe: beendetMit === null ? undefined : ausgabe.slice(-600) });
  check('2a: /api/health antwortet', horcht, { horcht, ausgabe: horcht ? undefined : ausgabe.slice(-600) });

  // Punkt 3: Der setImmediate-Startlauf feuert NACH der Modulauswertung. Ein Fehler darin toetet
  // den Prozess erst danach - ein Test, der nur den Start prueft, saehe ihn nicht. Deshalb hier
  // eine zweite Messung, nachdem die Ereignisschleife mehrfach durchgelaufen ist.
  await warte(1500);
  let lebtNoch = false;
  try { const r = await fetch('http://127.0.0.1:' + PORT + '/api/health'); lebtNoch = r.ok; } catch (e) {}
  check('3a: lebt auch nach dem setImmediate-Startlauf noch', lebtNoch && beendetMit === null,
    { lebtNoch, beendetMit, ausgabe: lebtNoch ? undefined : ausgabe.slice(-800) });

  // Punkt 4: Auch wenn der Prozess ueberlebt - ein gefangener ReferenceError im Log ist ein Befund.
  const schlimm = ausgabe.match(/ReferenceError[^\n]*|TypeError[^\n]*/g) || [];
  check('4a: keine ReferenceError/TypeError in der Ausgabe', schlimm.length === 0, schlimm.slice(0, 3));

  srv.kill('SIGTERM');
  await warte(400);
  if (beendetMit === null) srv.kill('SIGKILL');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}

  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})();
