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
const webpush = require('web-push');
const { sendEmail, buildPatchnotesEmail } = require('./mailer');

// Dieselbe Pfad-Ermittlung wie server.js und thank_bugreporter.js: respektiert DB_FILE, falls der
// Container/Prozess damit gestartet wird (z.B. wenn db.json auf einem separaten Docker-Volume
// liegt), sonst Fallback auf db.json direkt neben diesem Skript.
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');

// VAPID-Schlüssel für den optionalen Push-Broadcast - dieselben Dateien, die der laufende Server
// beim ersten Start erzeugt hat (siehe server.js). Ohne laufenden Server zuvor gäbe es sie nicht;
// das Skript bricht den Push-Teil dann einfach sauber ab, die Mail-Versendung bleibt unberührt.
function loadVapidKeysIfPresent() {
  const pubFile = process.env.VAPID_PUBLIC_FILE || path.join(__dirname, 'vapid-public.txt');
  const privFile = process.env.VAPID_PRIVATE_FILE || path.join(__dirname, 'vapid-private.txt');
  if (!fs.existsSync(pubFile) || !fs.existsSync(privFile)) return null;
  return { publicKey: fs.readFileSync(pubFile, 'utf8').trim(), privateKey: fs.readFileSync(privFile, 'utf8').trim() };
}

function parseArgs(argv){
  const args = { version: null, changes: [], dryRun: false, push: false };
  for (let i = 2; i < argv.length; i++){
    if (argv[i] === '--version'){ args.version = argv[++i]; }
    else if (argv[i] === '--dry-run'){ args.dryRun = true; }
    else if (argv[i] === '--push'){ args.push = true; }
    else if (argv[i] === '--changes'){
      while (i+1 < argv.length && !argv[i+1].startsWith('--')) args.changes.push(argv[++i]);
    }
  }
  return args;
}

async function main(){
  const { version, changes, dryRun } = parseArgs(process.argv);
  if (!version || !changes.length){
    console.error('Nutzung: node send_patchnotes.js --version X.Y.Z --changes "Punkt 1" "Punkt 2" [...] [--dry-run] [--push]');
    process.exit(1);
  }
  if (!process.env.RESEND_API_KEY && !dryRun){
    console.error('RESEND_API_KEY ist nicht gesetzt. Entweder setzen oder erst mit --dry-run testen.');
    process.exit(1);
  }

  const dbPath = DB_FILE;
  if (!fs.existsSync(dbPath)){
    console.error('db.json nicht gefunden unter: ' + dbPath + ' - läuft das Skript im richtigen Container/Ordner?');
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
  console.log('Fertig: '+ok+' Mails versendet, '+failed+' fehlgeschlagen.');

  if (!args.push) return;

  // --push: zusätzlich Web-Push an alle Spieler mit aktivierter Patchnotes-Kategorie und
  // mindestens einem registrierten Gerät. Nutzt dieselbe db.json und dieselben VAPID-Schlüssel
  // wie der laufende Server - kein separates Setup nötig.
  const vapid = loadVapidKeysIfPresent();
  if (!vapid) {
    console.log('Kein Push-Versand: VAPID-Schlüssel nicht gefunden (Server muss mindestens einmal gelaufen sein).');
    return;
  }
  webpush.setVapidDetails('mailto:' + (process.env.FEEDBACK_EMAIL || 'gamegeeeeek@outlook.de'), vapid.publicKey, vapid.privateKey);
  const priv = db.private || {};
  let pushOk = 0, pushFailed = 0, pushSkipped = 0;
  for (const [userId, bucket] of Object.entries(priv)) {
    const user = Object.values(db.users || {}).find(u => u.userId === userId);
    const prefs = (user && user.notifPrefs) || {};
    const wantsPatchPush = prefs.enabled !== false && prefs.patchnotes !== false;
    const subs = bucket.__pushSubscriptions || [];
    if (!wantsPatchPush || !subs.length) { pushSkipped++; continue; }
    const message = JSON.stringify({ title: 'Kolonie Kepler-7 aktualisiert', body: 'Version '+version+' ist da - tippen für die Neuigkeiten.', type: 'patchnotes', payload: { version }, time: Date.now() });
    for (const sub of subs) {
      try { await webpush.sendNotification(sub, message); pushOk++; }
      catch (e) { pushFailed++; }
    }
  }
  console.log('Push: '+pushOk+' Geräte benachrichtigt, '+pushFailed+' fehlgeschlagen, '+pushSkipped+' Spieler ohne Push-Abo/Opt-out übersprungen.');
}

main().catch(e => { console.error('Abbruch:', e.message); process.exit(1); });
