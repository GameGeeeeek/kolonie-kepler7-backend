#!/usr/bin/env node
// ============ Bugfix-Danke (Standalone) ============
// Schickt einem Spieler, der einen Bug gemeldet hat, nach dessen Behebung eine System-Nachricht
// und legt ihm eine einmalige kleine Kredit-Belohnung in die "ausstehende Belohnungen"-Warteschlange
// (siehe /api/pending-rewards in server.js). Bewusst KEIN Server-Endpunkt (wie send_patchnotes.js):
// nur wer SSH-Zugriff auf diesen Rechner hat, kann das auslösen - kein Admin-Secret nötig, keine
// öffentliche Angriffsfläche.
//
// Aufruf (im Backend-Ordner, damit db.json stimmt):
//   node thank_bugreporter.js --username holyhenning --version 8.20.4 --credits 500 --bug "Habitat-Kuppel ueber Maximalstufe ausbaubar"
//
// Optionen:
//   --credits N     Anzahl Kredite (Standard: 300)
//   --dry-run       zeigt nur an, was passieren würde, ohne etwas zu speichern
//   --force         erlaubt eine zweite Belohnung für denselben Spieler+Version (sonst blockiert,
//                    damit "einmalig" auch wirklich einmalig bleibt, selbst bei versehentlichem
//                    zweitem Aufruf)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseArgs(argv) {
  const args = { username: null, version: null, bug: '', credits: 300, dryRun: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--username') args.username = argv[++i];
    else if (argv[i] === '--version') args.version = argv[++i];
    else if (argv[i] === '--bug') args.bug = argv[++i];
    else if (argv[i] === '--credits') args.credits = parseInt(argv[++i], 10);
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--force') args.force = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.username || !args.version) {
    console.error('Nutzung: node thank_bugreporter.js --username NAME --version X.Y.Z [--bug "Kurzbeschreibung"] [--credits 300] [--dry-run] [--force]');
    process.exit(1);
  }
  if (!Number.isFinite(args.credits) || args.credits <= 0) {
    console.error('Ungültiger --credits Wert.');
    process.exit(1);
  }

  const dbPath = path.join(__dirname, 'db.json');
  if (!fs.existsSync(dbPath)) {
    console.error('db.json nicht gefunden - bitte im Backend-Ordner ausführen.');
    process.exit(1);
  }
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

  const user = Object.values(db.users || {}).find(
    u => u.username && u.username.toLowerCase() === args.username.toLowerCase()
  );
  if (!user) {
    console.error('Spieler "' + args.username + '" nicht gefunden.');
    process.exit(1);
  }

  db.bugfixRewards = db.bugfixRewards || {};
  const already = db.bugfixRewards[user.userId] || [];
  const dup = already.find(r => r.version === args.version);
  if (dup && !args.force) {
    console.error(
      'Bereits belohnt: ' + user.username + ' hat für Version ' + args.version +
      ' schon eine Belohnung erhalten (am ' + new Date(dup.time).toLocaleString('de-DE') +
      '). Mit --force trotzdem nochmal auslösen.'
    );
    process.exit(1);
  }

  const bugLine = args.bug ? (' ("' + args.bug + '")') : '';
  const messageText =
    'Danke für deinen Bug-Report' + bugLine + '! Er wurde in Version ' + args.version +
    ' behoben. Als kleines Dankeschön warten ' + args.credits + ' Kredite auf dich, sobald du dich ' +
    'das nächste Mal einloggst - schönes Spielen! - Das Kolonie Kepler-7 Team';

  console.log('Spieler: ' + user.username + ' (userId: ' + user.userId + ')');
  console.log('Nachricht: ' + messageText);
  console.log('Kredit-Belohnung (wird beim nächsten Login gutgeschrieben): ' + args.credits);
  if (dup) console.log('(Hinweis: --force genutzt, es gab schon eine Belohnung für diese Version am ' + new Date(dup.time).toLocaleString('de-DE') + ')');

  if (args.dryRun) {
    console.log('Keine Änderung gespeichert (--dry-run).');
    return;
  }

  db.private[user.userId] = db.private[user.userId] || {};

  // System-Nachricht ins Postfach (gleiche Struktur wie /api/messages, aber fromUserId:null als
  // Marker für eine System-/Team-Nachricht statt eines echten Spielers - das Frontend zeigt
  // fromName direkt an, fromUserId wird für Absender-Aktionen wie "Antworten" nicht gebraucht).
  const msgList = db.private[user.userId].__messages || [];
  msgList.unshift({
    id: crypto.randomUUID(),
    time: Date.now(),
    fromUserId: null,
    fromName: 'Kolonie Kepler-7 Team',
    text: messageText
  });
  db.private[user.userId].__messages = msgList.slice(0, 60);

  // Kredit-Belohnung in die Warteschlange - der Client holt sie beim nächsten Laden über
  // POST /api/pending-rewards/claim ab und schreibt sie selbst in seinen state.credits.
  const rewardList = db.private[user.userId].__pendingRewards || [];
  rewardList.push({
    id: crypto.randomUUID(),
    time: Date.now(),
    credits: args.credits,
    reason: 'bugfix',
    version: args.version,
    bug: args.bug || null
  });
  db.private[user.userId].__pendingRewards = rewardList;

  db.bugfixRewards[user.userId] = already.concat([{
    version: args.version,
    time: Date.now(),
    credits: args.credits,
    bug: args.bug || null
  }]);

  fs.writeFileSync(dbPath, JSON.stringify(db));
  console.log('Gespeichert.');
}

main();
