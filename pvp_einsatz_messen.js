#!/usr/bin/env node
// ============ PvP-Mindesteinsatz: die Schwelle messen (Standalone, NUR LESEND) ============
//
// WOZU. `PVP_MINDESTEINSATZ` in server.js steht auf 25 %, und das ist ein GERATENER Startwert.
// Bevor der Schalter `PVP_MINDESTEINSATZ_AKTIV` umgelegt wird, muss beantwortet sein: Welchen
// Anteil an der Reichs-Rohkraft haelt der staerkste Standort eines Kontos ueblicherweise? Wer
// seine Flotte auf sechs Kolonien verteilt hat, kommt von KEINEM Standort ueber die Schwelle -
// eine Regel gegen den Ein-Jaeger-Angriff wuerde dann ehrliche Spieler mit verteilter Flotte
// treffen, und zwar dauerhaft und unsichtbar (der Angriff laeuft ja, er bringt nur nichts).
// Dieses Skript beantwortet die Frage an den echten Spielstaenden statt am Bauchgefuehl.
//
// WAS GEMESSEN WIRD. Ein Angriff startet von EINEM Standort. Die groesstmoegliche ehrliche
// Zusammensetzung ist also die komplette Flotte des staerksten Standorts. Deren Anteil an der
// Reichs-Rohkraft ist die Obergrenze dessen, was ein Konto ueberhaupt erreichen kann - liegt
// sie unter der Schwelle, ist das Konto vom vollen Ertrag ausgesperrt.
//
// WARUM KEINE ZWEITE FORMEL. Der Anteil wird mit dem ECHTEN `pvpEinsatzAnteil` aus server.js
// gerechnet, nicht mit einer hier abgeschriebenen Kopie. Eine Kopie waere genau die Bauform, die
// in diesem Projekt schon mehrfach still veraltet ist (siehe die Kopie-Familien in CLAUDE.md):
// Sie wuerde eine plausible Zahl liefern, die zur ausgelieferten Regel nicht passt - und die
// Schwelle wuerde auf einer Messung festgelegt, die den Kampf gar nicht beschreibt.
// Stattdessen wird server.js als Text gelesen, VOR `app.listen` abgeschnitten und in einem
// vm-Kontext ausgewertet. Die Funktionen darin sind dann die ausgelieferten, Zeile fuer Zeile.
//
// SICHERHEIT. Das Skript schreibt NICHTS. Die geladene server.js bekommt DB_FILE und SECRET_FILE
// in ein frisches Wegwerf-Verzeichnis gebogen - ihre eigenen Intervalle (saveDb alle 5 Minuten,
// backupDb alle 30) koennen die gemessene Datei damit gar nicht erreichen, selbst wenn der
// Prozess laenger liefe als geplant. Die zu messende Datei wird ausschliesslich mit fs.readFileSync
// gelesen. Trotzdem gilt die Hausregel: gegen eine KOPIE der db.json messen, nicht gegen das
// Original im laufenden Container.
//
// Aufruf:
//   node pvp_einsatz_messen.js --db /tmp/db-kopie.json
//   node pvp_einsatz_messen.js --db /tmp/db-kopie.json --schwellen 0.10,0.15,0.20,0.25
//   node pvp_einsatz_messen.js --db /tmp/db-kopie.json --top 20     (die 20 knappsten Konten)
//
// Exit-Code: 0 = gemessen, 2 = Selbsttest der Extraktion gescheitert (die Zahlen sind dann
// WERTLOS, nicht "ungefaehr richtig"), 1 = Aufrufsfehler.

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const Module = require('module');

// path.resolve ist Pflicht, kein Schoenheitsfehler: Module.createRequire() weist einen relativen
// Pfad mit ERR_INVALID_ARG_VALUE ab, und der Abbruch kaeme dann VOR dem Selbsttest - eine
// Gegenprobe mit `SERVER_JS=./kopie.js` haette wie ein bestandener Abbruch ausgesehen.
const SERVER_JS = path.resolve(process.env.SERVER_JS || path.join(__dirname, 'server.js'));
// Kein hart gepfadetes db.json - dieselbe Regel wie in jedem Skript dieses Repos. Hier ist die
// Datei aber ohnehin ein Pflichtargument: Eine Messung, die versehentlich die LIVE-Datei nimmt,
// waere genau der Griff, den die Hausregel verbietet.
const DEFAULT_DB = process.env.DB_FILE || null;

function parseArgs(argv) {
  const args = { db: DEFAULT_DB, schwellen: [0.10, 0.15, 0.20, 0.25, 0.30, 0.40], top: 10 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--db') args.db = argv[++i] || null;
    else if (argv[i] === '--schwellen') args.schwellen = String(argv[++i] || '').split(',').map(Number).filter(n => n > 0 && n <= 1);
    else if (argv[i] === '--top') args.top = Math.max(0, parseInt(argv[++i], 10) || 0);
    else { console.error('Unbekanntes Argument: ' + argv[i]); process.exit(1); }
  }
  return args;
}

/* server.js laden, ohne sie zu starten.
   Der Schnitt sitzt an `app.listen` - alles davor sind Konstanten, Tabellen, Funktionen und
   Routenregistrierungen (harmlos ohne lauschenden Server), alles danach ist Betrieb
   (Shutdown-Handler, galaxyTick-Startaufruf). Der Anker wird VOR dem Schneiden auf Existenz
   und Eindeutigkeit geprueft: Ein `indexOf`, das -1 liefert, wuerde sonst die ganze Datei
   durchlassen, und ein zweiter Treffer wuerde stillschweigend zu frueh schneiden. */
function ladeServerFunktionen() {
  const quelle = fs.readFileSync(SERVER_JS, 'utf8');
  const ANKER = 'const httpServer = app.listen(';
  const erster = quelle.indexOf(ANKER);
  if (erster < 0) throw new Error('Anker "' + ANKER + '" nicht in ' + SERVER_JS + ' gefunden - server.js hat sich geaendert, das Skript muss nachgezogen werden.');
  if (quelle.indexOf(ANKER, erster + 1) >= 0) throw new Error('Anker "' + ANKER + '" kommt mehrfach vor - der Schnitt waere nicht mehr eindeutig.');
  /* Ein `const` auf oberster Ebene eines vm-Skripts landet NICHT als Eigenschaft am Kontext -
     nur `function`-Deklarationen tun das. Ohne diesen Anhang waeren PVP_MINDESTEINSATZ und der
     Schalter von aussen unsichtbar, und der Bericht koennte die gemessene Schwelle nicht gegen
     die AUSGELIEFERTE halten. Der Anhang laeuft im selben Bereich und sieht sie deshalb.
     `typeof` davor: Sind die Namen eines Tages weg, soll hier "unbekannt" stehen und nicht ein
     ReferenceError die ganze Messung verhindern. */
  const kopf = quelle.slice(0, erster)
    + '\n;globalThis.__messwerte = {'
    + ' schwelle: typeof PVP_MINDESTEINSATZ === "number" ? PVP_MINDESTEINSATZ : null,'
    + ' aktiv: typeof PVP_MINDESTEINSATZ_AKTIV === "boolean" ? PVP_MINDESTEINSATZ_AKTIV : null };\n';

  // Wegwerf-Verzeichnis: Die geladene server.js legt hier ihr jwt-secret und ihre (leere) db.json
  // an und schreibt ausschliesslich hierher.
  const sandkasten = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-messen-'));
  const alt = { DB_FILE: process.env.DB_FILE, SECRET_FILE: process.env.SECRET_FILE };
  process.env.DB_FILE = path.join(sandkasten, 'db.json');
  process.env.SECRET_FILE = path.join(sandkasten, 'jwt-secret.txt');

  const ctx = {
    require: Module.createRequire(SERVER_JS),
    module: { exports: {} }, exports: {},
    __dirname: path.dirname(SERVER_JS), __filename: SERVER_JS,
    process, console, Buffer, URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
    TextEncoder, TextDecoder, fetch: typeof fetch === 'function' ? fetch : undefined
  };
  ctx.global = ctx; ctx.globalThis = ctx;
  // server.js meldet beim Laden ein paar Zeilen (z. B. die Passwortliste). Sie gehoeren nicht in
  // einen Messbericht - Warnungen und Fehler bleiben sichtbar, nur das Geplauder wird geschluckt.
  ctx.console = Object.assign(Object.create(console), { log: () => {} });
  vm.createContext(ctx);
  try {
    vm.runInContext(kopf, ctx, { filename: SERVER_JS, displayErrors: true });
    ctx.console = console;
  } finally {
    if (alt.DB_FILE === undefined) delete process.env.DB_FILE; else process.env.DB_FILE = alt.DB_FILE;
    if (alt.SECRET_FILE === undefined) delete process.env.SECRET_FILE; else process.env.SECRET_FILE = alt.SECRET_FILE;
  }
  return { ctx, sandkasten };
}

/* Selbsttest der Extraktion.
   Drei von Hand nachgerechnete Erwartungen, jede prueft einen ANDEREN Bestandteil der Formel.
   Faellt eine, ist nicht "die Zahl etwas daneben" - dann hat der vm-Kontext eine andere Funktion
   geliefert als die ausgelieferte, und jede Ausgabe dieses Skripts waere frei erfunden. Deshalb
   Abbruch mit eigenem Exit-Code statt einer Warnung, die man ueberliest. */
function selbsttest(ctx) {
  const P = ctx.pvpEinsatzAnteil, R = ctx.rawFleetPower, D = ctx.fleetDiversityMult;
  if (typeof P !== 'function' || typeof R !== 'function' || typeof D !== 'function') {
    return ['pvpEinsatzAnteil/rawFleetPower/fleetDiversityMult nicht im Kontext - der Schnitt sitzt falsch oder die Funktionen wurden umbenannt.'];
  }
  const fehler = [];
  const nahe = (name, ist, soll) => { if (!(Math.abs(ist - soll) < 1e-6)) fehler.push(name + ': ' + ist + ' statt ' + soll); };

  // (1) Rohkraft ohne Marken/Module: 100 Jaeger x atk 10. Prueft die Grundtabelle.
  nahe('rawFleetPower(100 Jaeger)', R({ jaeger: 100 }, 1, 1, null), 1000);
  // (2) Mengenabschlag: 400 Jaeger -> 300 + 100 x 0,5 = 350 wirksame Schiffe.
  //     Prueft, dass MEGA_FLEET_THRESHOLD/-DIMINISH_RATE wirklich mitgeladen wurden.
  nahe('rawFleetPower(400 Jaeger)', R({ jaeger: 400 }, 1, 1, null), 3500);
  // (3) Aufbau-Bonus: 60 Jaeger (abfang, 600) + 30 Kreuzer (kapital, 600) -> zwei von drei Rollen
  //     je zur Haelfte. balance 0,5 -> Faktor 1,04. Prueft COUNTER_ROLE_* und den Deckel.
  nahe('fleetDiversityMult(60 Jaeger + 30 Kreuzer)', D({ jaeger: 60, cruisers: 30 }), 1.04);
  // (4) Der Anteil selbst: zwei gleich starke Standorte -> genau die Haelfte.
  nahe('pvpEinsatzAnteil(zwei gleiche Standorte)',
    P({ fleet: { jaeger: 100 }, colonies: { k1: { fleet: { jaeger: 100 } } } }, { jaeger: 100 }), 0.5);
  // (5) Kein Reich, keine Schwelle: ohne Kampfschiffe darf nicht durch null geteilt werden.
  nahe('pvpEinsatzAnteil(leeres Reich)', P({ fleet: {}, colonies: {} }, {}), 1);
  return fehler;
}

// db.private[userId] liegt in ZWEI Formen vor: als Zeichenkette oder als { value, version }.
// Wer nur eine liest, misst still die Haelfte der Konten (dieselbe Falle steht in CLAUDE.md).
function spielstandLesen(eintrag) {
  let roh = eintrag;
  if (roh && typeof roh === 'object' && typeof roh.value === 'string') roh = roh.value;
  if (typeof roh !== 'string') return null;
  try { return JSON.parse(roh); } catch (e) { return null; }
}

function balken(anteil, breite) {
  const n = Math.round(anteil * breite);
  return '#'.repeat(n) + '.'.repeat(Math.max(0, breite - n));
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.db) {
    console.error('Fehlt: --db <pfad zur db.json-KOPIE>. Bewusst ohne Vorgabe - eine Messung gegen die laufende Datei ist nicht vorgesehen.');
    process.exit(1);
  }
  if (!fs.existsSync(args.db)) { console.error('Nicht gefunden: ' + args.db); process.exit(1); }

  const { ctx, sandkasten } = ladeServerFunktionen();
  const fehler = selbsttest(ctx);
  if (fehler.length) {
    console.error('SELBSTTEST GESCHEITERT - die Extraktion liefert nicht die ausgelieferten Funktionen:');
    for (const f of fehler) console.error('  - ' + f);
    console.error('Es wird NICHTS gemessen. Eine Zahl aus einer kaputten Extraktion waere schlimmer als keine.');
    process.exit(2);
  }
  const mess = ctx.__messwerte || {};
  const SCHWELLE_LIVE = mess.schwelle;
  const SCHALTER_LIVE = mess.aktiv;

  const db = JSON.parse(fs.readFileSync(args.db, 'utf8'));
  const privat = db.private || {};
  const zeilen = [];
  let ohneSpielstand = 0, ohneFlotte = 0;

  for (const [uid, eintrag] of Object.entries(privat)) {
    const save = spielstandLesen(eintrag);
    if (!save) { ohneSpielstand++; continue; }
    /* Konten ohne jedes Kampfschiff zuerst aussortieren - und zwar mit der Nullwache der
       ausgelieferten Funktion selbst, nicht mit einer zweiten Kraftformel hier. Der Anteil einer
       LEEREN Zusammensetzung ist bei jedem Konto mit Flotte exakt 0; nur wenn das Reich gar keine
       Rohkraft hat, greift `if (!(gesamt > 0)) return 1`. Genau dieser Rueckgabewert 1 ist das
       Erkennungszeichen - ohne ihn haette ein flottenloses Konto im Bericht als "100 %" gestanden
       und die Verteilung nach oben verzerrt (im ersten Probelauf genau so passiert). */
    if (ctx.pvpEinsatzAnteil(save, {}) === 1) { ohneFlotte++; continue; }
    // Der Anteil JEDES Standorts, gerechnet mit der ausgelieferten Formel. Das Maximum ist die
    // Obergrenze des Kontos: mehr als eine ganze Standortflotte kann ein Angriff nicht tragen.
    let max = 0, standorte = 0;
    for (const f of ctx.allFleetsOf(save)) {
      const a = ctx.pvpEinsatzAnteil(save, f);
      if (a > 0) standorte++;
      if (a > max) max = a;
    }
    if (!(max > 0)) { ohneFlotte++; continue; }
    zeilen.push({ uid, max, standorte, punkte: (db.users && db.users[uid] && db.users[uid].battlePoints) || 0 });
  }

  zeilen.sort((a, b) => a.max - b.max);
  const n = zeilen.length;

  console.log('PvP-Mindesteinsatz - Schwellenmessung');
  console.log('  Quelle Formel : ' + SERVER_JS);
  console.log('  Quelle Daten  : ' + args.db);
  console.log('  Live-Schwelle : ' + (typeof SCHWELLE_LIVE === 'number' ? (SCHWELLE_LIVE * 100).toFixed(1) + ' %' : 'unbekannt')
            + '   Schalter: ' + (SCHALTER_LIVE === null ? 'unbekannt' : SCHALTER_LIVE ? 'AN' : 'aus'));
  console.log('  Selbsttest    : bestanden (5 Erwartungen)');
  console.log('');
  console.log('Konten gesamt in db.private : ' + Object.keys(privat).length);
  console.log('  davon unlesbar/leer       : ' + ohneSpielstand);
  console.log('  davon ohne Kampfflotte    : ' + ohneFlotte + '   (von der Regel gar nicht betroffen)');
  console.log('  gemessen                  : ' + n);
  if (!n) { console.log('\nKeine Konten mit Flotte - keine Aussage moeglich.'); fs.rmSync(sandkasten, { recursive: true, force: true }); return; }

  const q = (p) => zeilen[Math.min(n - 1, Math.floor(p * n))].max;
  console.log('');
  console.log('Staerkster Standort als Anteil an der Reichsflotte (Obergrenze je Konto):');
  console.log('  Minimum   ' + (zeilen[0].max * 100).toFixed(1) + ' %');
  console.log('  10 %-Q    ' + (q(0.10) * 100).toFixed(1) + ' %');
  console.log('  Median    ' + (q(0.50) * 100).toFixed(1) + ' %');
  console.log('  90 %-Q    ' + (q(0.90) * 100).toFixed(1) + ' %');
  console.log('  Maximum   ' + (zeilen[n - 1].max * 100).toFixed(1) + ' %');

  console.log('');
  console.log('Verteilung (Obergrenze je Konto):');
  const stufen = [[0, 0.10], [0.10, 0.20], [0.20, 0.25], [0.25, 0.34], [0.34, 0.50], [0.50, 0.75], [0.75, 1.01]];
  for (const [von, bis] of stufen) {
    const k = zeilen.filter(z => z.max >= von && z.max < bis).length;
    console.log('  ' + (von * 100).toFixed(0).padStart(3) + '-' + (Math.min(100, bis * 100)).toFixed(0).padStart(3) + ' %  '
              + String(k).padStart(4) + '  ' + balken(k / n, 40));
  }

  console.log('');
  console.log('Wirkung einer Schwelle - Konten, die von KEINEM Standort den vollen Ertrag erreichen:');
  for (const s of args.schwellen) {
    const k = zeilen.filter(z => z.max < s).length;
    console.log('  Schwelle ' + (s * 100).toFixed(0).padStart(3) + ' %  ->  ' + String(k).padStart(4) + ' von ' + n
              + '  (' + (k / n * 100).toFixed(1) + ' %)  ' + balken(k / n, 30));
  }
  console.log('');
  console.log('Lesart: Diese Konten wuerden bei jedem Angriff leer ausgehen, ohne dass ihnen etwas');
  console.log('auffaellt - der Kampf laeuft ja. Eine Schwelle ist nur brauchbar, wenn diese Spalte');
  console.log('nahe null bleibt. Wer viele Standorte hat, steht hier zwangslaeufig weiter unten:');
  console.log('Ein Konto mit sechs gleich starken Standorten kommt rechnerisch nie ueber 16,7 %.');

  if (args.top > 0) {
    console.log('');
    console.log('Die ' + Math.min(args.top, n) + ' knappsten Konten (Kennung gekuerzt, keine Namen):');
    console.log('  Anteil   Standorte  Kampfpunkte  Konto');
    for (const z of zeilen.slice(0, args.top)) {
      console.log('  ' + (z.max * 100).toFixed(1).padStart(5) + ' %  ' + String(z.standorte).padStart(9) + '  '
                + String(z.punkte).padStart(11) + '  ' + String(z.uid).slice(0, 8) + '…');
    }
  }

  fs.rmSync(sandkasten, { recursive: true, force: true });
}

main();
process.exit(0);
