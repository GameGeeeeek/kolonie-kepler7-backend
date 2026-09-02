// Echter HTTP-Test: Erreicht die vollständige Systemliste wirklich Spawn, Fraktionssimulation und
// den Angriffs-Endpunkt – oder steht sie nur in einer Konstante?
//
// Hintergrund: SYSTEM_COORDS kannte bis zum 10.08.2026 nur 41 der 69 Basissysteme, und die
// wöchentlich wachsende Galaxie fehlte ganz. Der statische Vergleich beider Listen läuft im
// Frontend-Prüflauf (tests/test_systemparitaet.js dort); DIESER Test prüft die Wirkung.
//
// AUSFÜHREN (Serverstart und Test müssen im selben Bash-Aufruf laufen, sonst verliert die Sandbox
// den Hintergrundprozess – CLAUDE.md, Punkt 2 der Commit-Pflichten):
//
//   DB=$(mktemp /tmp/kepler-test-XXXX.json); rm -f "$DB"
//   DB_FILE=$DB PORT=3199 JWT_SECRET=test node server.js > /tmp/srv.log 2>&1 &
//   PID=$!; sleep 2; DB_FILE=$DB node tests/test_systemliste_http.js; kill $PID; rm -f "$DB"
//
// GEGENPROBE, in beide Richtungen ausgeführt (10.08.2026):
//   Gegen den alten server.js (git show HEAD:server.js in einen Ordner mit mailer.js legen):
//     FAIL - Spawns landen in vorher unerreichbaren Sektoren           | 0
//     FAIL - Fraktionsterritorium reicht in vorher tote Sektoren       | []
//     FAIL - faction/attack lehnt sys_meridian_kern nicht mehr ab      | 400 Ungültiges Zielsystem
//   Gegen den neuen Stand: alles grün, 9 von 12 Spawns in vorher toten Sektoren.
//   Die Kontrollprüfung ("erfundenes System wird weiterhin abgelehnt") ist in BEIDEN Läufen grün –
//   der Test misst also den Unterschied und nicht bloß, dass der Server überhaupt antwortet.

const BASIS = 'http://127.0.0.1:3199/api';
const NEU_AUSSEN = ['sys_pandora_saum','sys_tychos_kluft','sys_ashen_bogen','sys_valeska_spirale',
  'sys_boreas_schwelle','sys_indra_tiefe','sys_calyx_grat','sys_meridian_kern'];
const vorherTot = (id) => id.startsWith('sysn_') || id.startsWith('sysw_') || NEU_AUSSEN.includes(id);

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };

async function j(pfad, opt) {
  const r = await fetch(BASIS + pfad, opt);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; }
  catch (e) { return { status: r.status, body: t.slice(0, 200) }; }
}

(async () => {
  // ---- 1. Spawn: landen neue Spieler in den vorher unerreichbaren Sektoren? --------------------
  // assignHomeSlot() laeuft schon bei der Registrierung, steht aber nicht in der Antwort
  // (die meldet nur needsVerification). Der Spawn wird deshalb aus der geschriebenen DB gelesen.
  const fs = require('fs');
  const DB = process.env.DB_FILE;
  // Zwoelf statt zwanzig, mit Pause: Die Registrierung hat eine eigene Ratenbremse, und ab dem
  // 16. Versuch kam nichts mehr durch - das war die Testschale, nicht der Server.
  for (let n = 1; n <= 12; n++) {
    await j('/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'pruef' + n, password: 'geheim12345', email: `p${n}@example.invalid` })
    });
    await new Promise(r => setTimeout(r, 120));
  }
  await new Promise(r => setTimeout(r, 900));   // saveDb() buendelt Schreibvorgaenge
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  const nutzer = Object.values(db.users || {});
  const heimat = nutzer.map(u => u.homeSystem).filter(Boolean);
  check('12 Konten angelegt', heimat.length === 12, heimat.length);
  const verschieden = new Set(heimat);
  check('jedes Konto in einem eigenen System', verschieden.size === heimat.length, heimat.length - verschieden.size);
  const inNeuen = heimat.filter(vorherTot);
  // Die Streuung setzt bewusst weit auseinander (Farthest-Point). Die aeusseren Sektoren sind genau
  // die weit entfernten - sie MUESSEN also unter den ersten Spawns auftauchen, wenn sie zaehlen.
  check('Spawns landen in vorher unerreichbaren Sektoren', inNeuen.length > 0,
    { davon: inNeuen.length, beispiele: inNeuen.slice(0, 6) });

  // ---- 2. Fraktionen: halten sie Territorium in den neuen Sektoren? ---------------------------
  // (wird nach der Anmeldung geholt - /api/galaxy laeuft hinter authMiddleware)
  let g = {}, f = {};

  // ---- 3. Der Endpunkt, der vorher 400 lieferte ------------------------------------------------
  // Erst bestaetigen (die Registrierung verlangt eine E-Mail-Bestaetigung), dann anmelden.
  // db.users ist nach KLEINGESCHRIEBENEM NAMEN geschluesselt, nicht nach userId - der direkte
  // Zugriff db.users[userId] lief ins Leere und der Login scheiterte an einem leeren Namen.
  const ziel = db.users['pruef1'];
  const eintrag = Object.entries(db.verifyTokens || {}).find(([, v]) => ziel && v.userId === ziel.userId);
  check('Bestaetigungs-Token vorhanden', !!eintrag);
  if (eintrag) await j('/verify-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: eintrag[0] }) });
  const wer = 'pruef1';
  const login = await j('/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: wer, password: 'geheim12345' })
  });
  const token = login.body && login.body.token;
  check('Anmeldung liefert Token', !!token, token ? undefined : { status: login.status, body: login.body, nutzer: wer });
  if (token) {
    const kopf = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
    g = (await j('/galaxy', { headers: kopf })).body || {};
    f = g.factions || {};
    check('Fraktionen initialisiert', Object.keys(f).length === 4, Object.keys(f));
    const belegt = Object.values(f).flatMap(x => x.systems || []);
    check('Fraktionen halten Systeme', belegt.length >= 4, belegt.length);
    check('Fraktionsterritorium reicht in vorher tote Sektoren', belegt.some(vorherTot),
      belegt.filter(vorherTot));
    // Ein vorher unbekanntes System darf jetzt NICHT mehr an der Systemprüfung scheitern.
    const a = await j('/faction/attack', { method: 'POST', headers: kopf, body: JSON.stringify({ systemId: 'sys_meridian_kern' }) });
    check('faction/attack lehnt sys_meridian_kern nicht mehr als unbekanntes System ab',
      !(a.status === 400 && /Ungültiges Zielsystem/.test(JSON.stringify(a.body))), { status: a.status, body: a.body });
    // Startschub (02.09.2026): die 30 fest verorteten Systeme muessen dem Server ebenso bekannt sein -
    // erstes und letztes der Tabelle, damit ein abgeschnittenes Ende auffiele.
    for (const sid of ['syss_01', 'syss_30']) {
      const c = await j('/faction/attack', { method: 'POST', headers: kopf, body: JSON.stringify({ systemId: sid }) });
      check('Startschub: faction/attack lehnt ' + sid + ' nicht als unbekanntes System ab',
        !(c.status === 400 && /Ungültiges Zielsystem/.test(JSON.stringify(c.body))), { status: c.status, body: c.body });
    }
    // Gegenprobe: ein wirklich erfundenes System muss weiterhin abgelehnt werden.
    const b = await j('/faction/attack', { method: 'POST', headers: kopf, body: JSON.stringify({ systemId: 'sys_gibt_es_nicht' }) });
    check('erfundenes System wird weiterhin mit 400 abgelehnt',
      b.status === 400 && /Ungültiges Zielsystem/.test(JSON.stringify(b.body)), { status: b.status, body: b.body });
  }

  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nAlles in Ordnung');
  process.exit(fail ? 1 : 0);
})();
