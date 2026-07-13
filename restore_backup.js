// Kepler-7: Backup-Wiederherstellung
//
// Auflisten der verfügbaren Backups:
//   node restore_backup.js
//
// Ein bestimmtes Backup wiederherstellen (Dateiname aus der Liste oben):
//   node restore_backup.js db-2026-07-13T14-30-00-000Z.json
//
// WICHTIG: Vor dem Wiederherstellen den Backend-Container stoppen, sonst überschreibt der
// laufende Server die wiederhergestellte Datei sofort wieder mit seinem Speicherstand im
// Arbeitsspeicher:
//   docker stop kepler7-backend
//   node restore_backup.js db-<Zeitstempel>.json
//   docker start kepler7-backend

const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');
const BACKUP_DIR = path.join(path.dirname(DB_FILE), 'backups');

const target = process.argv[2];

if (!fs.existsSync(BACKUP_DIR)) {
  console.log('Kein Backup-Ordner gefunden unter:', BACKUP_DIR);
  process.exit(1);
}

const files = fs.readdirSync(BACKUP_DIR)
  .filter(f => f.startsWith('db-') && f.endsWith('.json'))
  .sort();

if (!target) {
  console.log(`${files.length} Backups verfügbar (älteste zuerst):\n`);
  for (const f of files) {
    const stat = fs.statSync(path.join(BACKUP_DIR, f));
    console.log(`  ${f}  (${(stat.size / 1024).toFixed(1)} KB)`);
  }
  console.log('\nZum Wiederherstellen: node restore_backup.js <Dateiname>');
  console.log('Vorher den Container stoppen: docker stop kepler7-backend');
  process.exit(0);
}

const src = path.join(BACKUP_DIR, target);
if (!fs.existsSync(src)) {
  console.log('Backup nicht gefunden:', target);
  process.exit(1);
}

// Sicherheitskopie der AKTUELLEN (evtl. defekten) db.json, bevor überschrieben wird
if (fs.existsSync(DB_FILE)) {
  const safetyCopy = DB_FILE + '.before-restore-' + Date.now();
  fs.copyFileSync(DB_FILE, safetyCopy);
  console.log('Sicherheitskopie der aktuellen db.json erstellt:', safetyCopy);
}

fs.copyFileSync(src, DB_FILE);
console.log('Wiederhergestellt:', target, '->', DB_FILE);
console.log('Jetzt den Container wieder starten: docker start kepler7-backend');
