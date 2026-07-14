#!/usr/bin/env node
// ============ Allianz-Fortschritt zurücksetzen (Standalone) ============
// Setzt für eine (oder alle) Allianz(en) den Forschungs-/Gebäude-Fortschritt zurück:
// - alliance:<TAG>:unlocked  -> {} (alle Freischaltungen weg)
// - alliance:<TAG>:contrib:* -> jeder Beitrags-Datensatz auf {} (alle Beiträge weg)
// Mitgliedschaft, Rollen, Banner, Beitrittsmodus, Beschreibung, Mitgliederlimit-Einstellung, Kriege,
// Chat und Dominanz bleiben komplett unberührt - nur der Tech-/Gebäude-Fortschritt fängt neu an.
// Gedacht für den Fall einer Neubepreisung (Kosten geändert) - alte, zu günstig erkaufte
// Freischaltungen sollen nicht einfach unter der neuen Preisstruktur bestehen bleiben.
//
// Aufruf (im Backend-Ordner bzw. per docker exec, damit db.json/DB_FILE stimmt):
//   node reset_alliance_progress.js --tag GKK7 [--dry-run]
//   node reset_alliance_progress.js --all [--dry-run]     (ALLE Allianzen zurücksetzen)
//
// Bewusst KEIN Server-Endpunkt (wie thank_bugreporter.js/send_patchnotes.js) - nur per SSH auslösbar.

const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');

function parseArgs(argv) {
  const args = { tag: null, all: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--tag') args.tag = (argv[++i] || '').toUpperCase();
    else if (argv[i] === '--all') args.all = true;
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.tag && !args.all) {
    console.error('Nutzung: node reset_alliance_progress.js --tag TAG [--dry-run]');
    console.error('     oder: node reset_alliance_progress.js --all [--dry-run]');
    process.exit(1);
  }
  if (!fs.existsSync(DB_FILE)) {
    console.error('db.json nicht gefunden unter: ' + DB_FILE + ' - läuft das Skript im richtigen Container/Ordner?');
    process.exit(1);
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db.shared = db.shared || {};

  // Allianz-Tags aus den vorhandenen "...:info"-Schlüsseln ermitteln, statt sie raten zu müssen.
  const allTags = Object.keys(db.shared)
    .map(k => { const m = k.match(/^alliance:([^:]+):info$/); return m ? m[1] : null; })
    .filter(Boolean);

  const targets = args.all ? allTags : (allTags.includes(args.tag) ? [args.tag] : []);
  if (!targets.length) {
    console.error(args.all ? 'Keine Allianzen gefunden.' : 'Allianz "' + args.tag + '" nicht gefunden.');
    process.exit(1);
  }

  let totalCleared = 0;
  for (const tag of targets) {
    const unlockedKey = 'alliance:' + tag + ':unlocked';
    const contribPrefix = 'alliance:' + tag + ':contrib:';
    const contribKeys = Object.keys(db.shared).filter(k => k.startsWith(contribPrefix));

    const hadUnlocked = db.shared[unlockedKey] && db.shared[unlockedKey] !== '{}';
    console.log('[' + tag + '] Freischaltungen: ' + (hadUnlocked ? db.shared[unlockedKey] : '(keine)'));
    console.log('[' + tag + '] Beitrags-Datensätze: ' + contribKeys.length);

    if (!args.dryRun) {
      db.shared[unlockedKey] = '{}';
      for (const k of contribKeys) db.shared[k] = '{}';
    }
    totalCleared += contribKeys.length + (hadUnlocked ? 1 : 0);
  }

  if (args.dryRun) {
    console.log('Keine Änderung gespeichert (--dry-run). Betroffene Allianzen: ' + targets.join(', '));
    return;
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
  console.log('Zurückgesetzt: ' + targets.length + ' Allianz(en), ' + totalCleared + ' Datensätze geleert.');
}

main();
