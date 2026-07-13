// ============ Gemeinsames Mail-Modul ============
// Wird von server.js (Kontobestätigung, Passwort-Reset, E-Mail-Wechsel) UND vom Standalone-Skript
// send_patchnotes.js genutzt, damit das Void-Signal-Layout nur an EINER Stelle gepflegt wird.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Kolonie Kepler-7 <onboarding@resend.dev>';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://gamegeeeeek.de';

// Sendet eine E-Mail über Resend. html ist Pflicht, text ein Klartext-Fallback für Clients, die kein
// HTML rendern (Resend verschickt dann eine Multipart-Mail mit beiden Varianten).
async function sendEmail(to, subject, html, text, attachments) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY nicht gesetzt - siehe ANLEITUNG.md');
  const body = { from: MAIL_FROM, to: [to], subject, html };
  if (text) body.text = text;
  if (attachments && attachments.length) body.attachments = attachments; // [{ filename, content: base64 }]
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error('Resend-Fehler: ' + resp.status + ' ' + (await resp.text()));
}

// ============ E-Mail-Layout "Void Signal" ============
// Gemeinsames Terminal-artiges Layout für alle Mails an Spieler (Kontobestätigung, Passwort-Reset,
// künftig Patchnotes). eyebrow = kleine Kennzeichnung oben ("Eingehendes Signal" etc.), statusLabel/
// statusColor = der [STATUS]-Wert im Kopfblock, bodyHtml = der Fließtext (schon als HTML-Absätze),
// ctaLabel/ctaUrl = optionaler Haupt-Button, footerNote = kleine Zusatzzeile über dem Footer.
function voidSignalEmail({ eyebrow, username, statusLabel, statusColor, bodyHtml, ctaLabel, ctaUrl, footerNote }) {
  const ctaBlock = ctaUrl ? `
          <tr>
            <td style="padding:32px 40px;" align="center">
              <a href="${ctaUrl}" style="display:inline-block; background-color:#7f77dd; color:#060812; font-size:13px; font-weight:bold; letter-spacing:1px; text-transform:uppercase; text-decoration:none; padding:14px 32px; border-radius:2px; font-family:'Courier New', Consolas, monospace;">
                &gt;&gt; ${ctaLabel}
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 40px 28px 40px;">
              <div style="background-color:#060812; border:1px solid rgba(127,119,221,0.2); border-radius:3px; padding:12px 14px;">
                <div style="color:#5a5f7a; font-size:10px; letter-spacing:1px; text-transform:uppercase; margin-bottom:4px;">Direktlink</div>
                <div style="color:#5dcaa5; font-size:11px; word-break:break-all; font-family:'Courier New', Consolas, monospace;">${ctaUrl}</div>
              </div>
            </td>
          </tr>` : '';
  return `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Kolonie Kepler-7</title></head>
<body style="margin:0; padding:0; background-color:#060812; font-family:'Courier New', Consolas, monospace;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#060812; padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px; width:100%; background-color:#0a0f1e; border:1px solid rgba(127,119,221,0.25); border-radius:4px;">
          <tr><td style="padding:0;"><div style="height:3px; background:linear-gradient(90deg, #7f77dd, #5dcaa5, #7f77dd); background-size:200% 100%;"></div></td></tr>
          <tr>
            <td style="padding:36px 40px 0 40px;">
              <div style="color:#5dcaa5; font-size:11px; letter-spacing:3px; text-transform:uppercase; margin-bottom:6px;">&gt; ${eyebrow}</div>
              <div style="color:#e9ecf5; font-size:22px; font-weight:bold; letter-spacing:0.5px;">KOLONIE KEPLER-7</div>
              <div style="color:#5a5f7a; font-size:12px; margin-top:4px; border-bottom:1px solid rgba(127,119,221,0.2); padding-bottom:24px;">Galaktisches Kommandonetzwerk</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 40px 8px 40px;">
              <div style="color:#8489a0; font-size:13px; line-height:1.5;">
                <span style="color:#7f77dd;">[SYSTEM]</span> Nachricht empfangen.<br>
                <span style="color:#7f77dd;">[ZIEL]</span> <span style="color:#e9ecf5;">Kommandant ${username}</span><br>
                <span style="color:#7f77dd;">[STATUS]</span> <span style="color:${statusColor};">${statusLabel}</span>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 40px 0 40px;">
              <div style="color:#c7cbe0; font-size:14px; line-height:1.7;">${bodyHtml}</div>
            </td>
          </tr>
          ${ctaBlock}
          ${footerNote ? `<tr><td style="padding:${ctaUrl?'0':'20px'} 40px 32px 40px;"><div style="color:#5a5f7a; font-size:11px; line-height:1.6; border-top:1px solid rgba(127,119,221,0.15); padding-top:16px;">${footerNote}</div></td></tr>` : ''}
          <tr>
            <td style="padding:20px 40px; background-color:#080b16; border-top:1px solid rgba(127,119,221,0.15);">
              <div style="color:#3d4258; font-size:10px; letter-spacing:1px;">KOLONIE KEPLER-7 · GALAKTISCHES KOMMANDONETZWERK</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
// Klartext-Fallback für Clients ohne HTML-Rendering (grob, aber lesbar).
function voidSignalPlainText({ username, statusLabel, plainBody, ctaUrl }) {
  return `KOLONIE KEPLER-7\n\n[ZIEL] Kommandant ${username}\n[STATUS] ${statusLabel}\n\n${plainBody}${ctaUrl ? '\n\n' + ctaUrl : ''}`;
}

// Patchnotes-Mail (Void-Signal-Layout) — AUF VORRAT, wird aktuell noch nirgends automatisch
// ausgelöst. changes ist ein Array von Strings (die einzelnen Änderungspunkte). Zum Verschicken
// später z.B. eine Route/ein Skript bauen, das über alle Nutzer mit user.emailVerified !== false
// iteriert und sendEmail(user.email, ..., html, text) aufruft.
function buildPatchnotesEmail({ username, version, changes }) {
  const changesHtml = '<ul style="margin:0; padding-left:18px; color:#c7cbe0;">' +
    changes.map(c => `<li style="margin-bottom:6px; line-height:1.5;">${c}</li>`).join('') + '</ul>';
  const html = voidSignalEmail({
    eyebrow: 'Patch-Übertragung',
    username,
    statusLabel: 'Update v' + version + ' verfügbar',
    statusColor: '#5dcaa5',
    bodyHtml: 'Ein neues Update für Kolonie Kepler-7 ist eingetroffen:<br><br>' + changesHtml,
    ctaLabel: 'Kolonie jetzt öffnen',
    ctaUrl: PUBLIC_URL,
    footerNote: 'Du erhältst diese Nachricht, weil dein Konto bestätigt ist. Abmelden künftig über die Kontoeinstellungen möglich.'
  });
  const text = voidSignalPlainText({
    username, statusLabel: 'Update v' + version + ' verfügbar',
    plainBody: 'Ein neues Update ist eingetroffen:\n' + changes.map(c => '- ' + c.replace(/<[^>]+>/g,'')).join('\n'),
    ctaUrl: PUBLIC_URL
  });
  return { html, text };
}

module.exports = { sendEmail, voidSignalEmail, voidSignalPlainText, buildPatchnotesEmail, PUBLIC_URL };
