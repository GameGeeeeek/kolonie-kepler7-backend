#!/usr/bin/env node
// ============ Patchnotes-Versand (Standalone) ============
// Verschickt die Patchnotes-Mail im Void-Signal-Design an alle Spieler mit bestätigter E-Mail und
// aktiviertem Patchnotes-Abo. Bewusst KEIN Server-Endpunkt: nur wer SSH-Zugriff auf diesen Rechner
// hat, kann den Versand auslösen (keine öffentliche Angriffsfläche, kein Admin-Secret nötig).
//
// Aufruf (im Backend-Ordner, damit db.json und die Umgebungsvariablen stimmen):
//   node send_patchnotes.js --version 7.95.0 --changes "Erster Punkt" "Zweiter Punkt" "Dritter Punkt"
//
// Optionen:
//   --dry-run   zeigt nur, an wen versendet WÜRDE, ohne eine einzige Mail zu verschicken
//
// Braucht dieselben Umgebungsvariablen wie der Server (RESEND_API_KEY, optional MAIL_FROM/PUBLIC_URL).

const fs = require('fs');
const path = require('path');
const { sendEmail, buildPatchnotesEmail } = require('./mailer');

function parseArgs(argv){
  const args = { version: null, changes: [], dryRun: false };
  for (let i = 2; i < argv.length; i++){
    if (argv[i] === '--version'){ args.version = argv[++i]; }
    else if (argv[i] === '--dry-run'){ args.dryRun = true; }
    else if (argv[i] === '--changes'){
      while (i+1 < argv.length && !argv[i+1].startsWith('--')) args.changes.push(argv[++i]);
    }
  }
  return args;
}

async function main(){
  const { version, changes, dryRun } = parseArgs(process.argv);
  if (!version || !changes.length){
    console.error('Nutzung: node send_patchnotes.js --version X.Y.Z --changes "Punkt 1" "Punkt 2" [...] [--dry-run]');
    process.exit(1);
  }
  if (!process.env.RESEND_API_KEY && !dryRun){
    console.error('RESEND_API_KEY ist nicht gesetzt. Entweder setzen oder erst mit --dry-run testen.');
    process.exit(1);
  }

  const dbPath = path.join(__dirname, 'db.json');
  if (!fs.existsSync(dbPath)){
    console.error('db.json nicht gefunden - bitte im Backend-Ordner ausführen.');
    process.exit(1);
  }
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

  // Empfänger: bestätigte E-Mail (Bestandskonten ohne Feld gelten als bestätigt) + Abo nicht abbestellt.
  const recipients = Object.values(db.users || {}).filter(u =>
    u.email && u.emailVerified !== false && u.wantsPatchnotes !== false
  );

  console.log('Patchnotes v'+version+' mit '+changes.length+' Punkten.');
  console.log('Empfänger (bestätigt + Abo an): '+recipients.length);
  if (dryRun){
    for (const u of recipients) console.log('  [DRY-RUN] würde senden an: '+u.username+' <'+u.email+'>');
    console.log('Keine Mail versendet (--dry-run).');
    return;
  }

  let ok = 0, failed = 0;
  for (const u of recipients){
    try {
      const { html, text } = buildPatchnotesEmail({ username: u.username, version, changes });
      await sendEmail(u.email, 'Update v'+version+' – Kolonie Kepler-7', html, text);
      ok++;
      console.log('  ✓ '+u.username);
    } catch (e){
      failed++;
      console.error('  ✗ '+u.username+': '+e.message);
    }
    // Kleine Pause zwischen den Mails, um Resend-Rate-Limits nicht zu reizen.
    await new Promise(r => setTimeout(r, 600));
  }
  console.log('Fertig: '+ok+' versendet, '+failed+' fehlgeschlagen.');
}

main().catch(e => { console.error('Abbruch:', e.message); process.exit(1); });
