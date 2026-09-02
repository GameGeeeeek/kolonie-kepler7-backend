// Vier weitere Admin-Faehigkeiten (02.09.2026, Auftrag Sascha "Weitere Ideen fuer Admin Funktionen"
// - alle vier gewaehlt): Alarm an den Betreiber, Geschenk an EIN Konto, Galaxie-Eingriff,
// Chat-Moderation.
//
// KERNMESSUNGEN ALS PAARE (Arbeitsregel 61):
//   1a/1b  der Alarm loest ueber der Schwelle aus UND ein zweites Mal innerhalb der Ruhefrist nicht
//   1e/1f  die Abfrage nennt die aktuellen Messwerte AUCH ohne Alarm - ein schweigender Waechter
//          muss sich von einem toten unterscheiden lassen
//   2a/2b  das Geschenk landet im Fach des EINEN Kontos UND bei keinem anderen
//   3c/3d  ein gesetztes Nest steht mit Kennung in der Galaxie UND ist danach wieder weg
//   3g     das Kopfgeld ueberlebt den naechsten Takt (Wochenschluessel mitgeschrieben)
//   4a/4b  die Chat-Nachricht ist weg UND jeder NICHT-Chat-Schluessel wird abgelehnt (die Sperre,
//          ohne die das hier ein Loeschknopf fuer den ganzen geteilten Speicher waere)
//
// GEGENPROBEN (sabotierte Kopien ueber KEPLER_SERVER_JS): siehe die gemessene Liste im Kopf des
// Gegenprobe-Skripts; jede Sabotage steht dort mit der Pruefung, die sie fallen lassen MUSS.
//
// PORT 3250. Gemessen gegen frisch geholtes origin/master (nicht nur gegen den eigenen Stand -
// siehe die Begruendung im Kopf von test_admin_konto2_http.js): belegt sind 3195-3249.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3250);

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ADMIN = crypto.randomUUID(), ANNA = crypto.randomUUID(), BEN = crypto.randomUUID(), CARL = crypto.randomUUID();

function spielstand(id, name, credits) {
  return {
    resources: { energie: 1e5, erz: 1e5, kristalle: 1e5, deuterium: 1e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: { mine: 7 }, research: {}, colonies: {}, fleet: { jaeger: 40, missions: [] },
    player: { id, name }, credits, xp: 1000, prestige: 0, battlePoints: 10, lastTick: Date.now()
  };
}
// Ein Kampfverlauf ueber der Schwelle (15 Angriffe in einer Stunde) - so entsteht der Alarm aus
// echten Feldern des Nutzerobjekts und nicht aus einem erfundenen Zaehler.
function verlauf(n, alterMs) {
  const jetzt = Date.now();
  return Array.from({ length: n }, (_, i) => ({ zeit: jetzt - (alterMs || 60000) - i * 1000, rolle: 'angriff', gegner: 'ben', ziel: 'home', erfolg: true, angriff: 100, verteidigung: 10, beute: 0 }));
}
function grunddb(extra) {
  const jetzt = Date.now();
  const d = {
    users: {
      gamegeeeeek: { userId: ADMIN, username: 'GameGeeeeek', passwordHash: hash, createdAt: jetzt },
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: jetzt, email: 'anna@example.org', emailVerified: true },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: jetzt },
      // carl wird NIE angemeldet. Das ist Absicht: Eine gelungene Anmeldung setzt
      // loginFehlversuche auf 0 zurueck (Anmelde-Forensik, #203) - an einem angemeldeten Konto
      // laesst sich der Fehlversuch-Alarm also gar nicht messen.
      carl: { userId: CARL, username: 'carl', passwordHash: hash, createdAt: jetzt }
    },
    private: {
      [ADMIN]: { 'kepler7-save-v3': JSON.stringify(spielstand(ADMIN, 'GameGeeeeek', 1000)) },
      [ANNA]:  { 'kepler7-save-v3': JSON.stringify(spielstand(ANNA, 'anna', 5000)) },
      [BEN]:   { 'kepler7-save-v3': JSON.stringify(spielstand(BEN, 'ben', 3000)) },
      [CARL]:  { 'kepler7-save-v3': JSON.stringify(spielstand(CARL, 'carl', 100)) }
    },
    shared: {
      'worldboss:current': JSON.stringify({ bossId: 'boss-1', level: 2, hp: 800, maxHp: 1000, contributions: {} }),
      ['leaderboard:' + ANNA]: JSON.stringify({ name: 'anna', score: 10, lastSeen: jetzt }),
      ['leaderboard:' + BEN]: JSON.stringify({ name: 'ben', score: 99, lastSeen: jetzt }),
      'alliance:T1:info': JSON.stringify({ tag: 'T1', creatorId: BEN, creatorName: 'ben', createdAt: 1755000000000, joinMode: 'open' }),
      'globalchat:msg:1756000000000-aaa': JSON.stringify({ authorId: ANNA, authorName: 'anna', text: 'Beleidigung im Chat', time: jetzt - 60000 }),
      'globalchat:msg:1756000000001-bbb': JSON.stringify({ authorId: BEN, authorName: 'ben', text: 'Harmlos', time: jetzt - 30000 }),
      'alliance:T1:msg:1756000000002-ccc': JSON.stringify({ authorId: ANNA, authorName: 'anna', text: 'Im Allianzchat', time: jetzt - 20000 })
    },
    resetTokens: {}, feedback: [],
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: jetzt, factions: {},
      marketEvent: { resource: 'erz', kind: 'shortage', mult: 1.4, label: 'Erzknappheit', startedAt: jetzt - 1000, endsAt: jetzt + 3600000 },
      alienPause: { kryll: jetzt + 9e8, xantheer: jetzt + 9e8, vex: jetzt + 9e8, verglueht: jetzt + 9e8 },
      alienNester: [], wrackKonvois: [] }
  };
  return Object.assign(d, extra || {});
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-r6-'));
const dbPfad = path.join(tmpDir, 'db.json');
let srv = null, s = null, tok = {};
function aufraeumen() {
  try { if (srv) srv.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', aufraeumen);

async function starteServer() {
  let log = '';
  srv = spawn(process.execPath, [process.env.KEPLER_SERVER_JS || path.join(WURZEL, 'server.js')], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, {
      DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret', PUBLIC_URL: 'https://test.example',
      JWT_SECRET_FILE: path.join(tmpDir, 'jwt.txt'),
      VAPID_PUBLIC_FILE: path.join(tmpDir, 'vapid-pub.txt'),
      VAPID_PRIVATE_FILE: path.join(tmpDir, 'vapid-priv.txt'),
      RESEND_API_KEY: ''
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
  const basis = 'http://127.0.0.1:' + PORT + '/api';
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(basis + '/health'); if (r.ok) break; } catch (e) {}
    await warte(250);
  }
  await warte(400);
  async function j(pfad, opt) {
    const r = await fetch(basis + pfad, opt);
    const t = await r.text();
    try { return { status: r.status, body: JSON.parse(t) }; }
    catch (e) { return { status: r.status, body: t.slice(0, 300) }; }
  }
  async function anmelden(name, pw) {
    const r = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name, password: pw || 'test1234' }) });
    return { token: r.body && r.body.token, status: r.status, error: r.body && r.body.error };
  }
  return { j, anmelden, protokoll: () => log };
}
// carl fehlt hier mit Absicht - siehe die Begruendung an seinem Eintrag in grunddb().
async function alleAnmelden() { tok = {}; for (const n of ['GameGeeeeek', 'anna', 'ben']) tok[n] = (await s.anmelden(n)).token; }
async function stoppeServer() { if (!srv) return; srv.kill('SIGTERM'); await warte(700); srv = null; }
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
async function aendereDb(fn) { await stoppeServer(); const d = liesDb(); await fn(d); schreibDb(d); s = await starteServer(); await alleAnmelden(); }
const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
const admin = (pfad, body) => s.j(pfad, { method: 'POST', headers: kopf(tok.GameGeeeeek), body: JSON.stringify(body || {}) });
const holen = pfad => s.j(pfad, { headers: kopf(tok.GameGeeeeek) });
const postfach = async t => { const b = (await s.j('/notifications', { headers: kopf(t) })).body || {}; return b.notifications || []; };
const protokoll = async () => ((await holen('/admin/protokoll')).body || {}).eintraege || [];

(async () => {
  // anna liegt von Anfang an ueber allen drei Konto-Schwellen - der erste Alarmlauf beim
  // Serverstart (setImmediate) muss sie also finden, ohne dass der Test etwas anstossen muss.
  const d0 = grunddb();
  d0.users.carl.kampfVerlauf = verlauf(18);
  d0.users.carl.loginFehlversuche = 12;
  d0.users.carl.saveAblehnungen = { n: 7, letzteZeit: Date.now(), letzterGrund: 'Sanity' };
  schreibDb(d0);
  s = await starteServer();
  await alleAnmelden();
  check('0-vorab: alle Konten angemeldet', ['GameGeeeeek', 'anna', 'ben'].every(n => !!tok[n]), Object.fromEntries(Object.entries(tok).map(([k, v]) => [k, !!v])));
  if (!tok.anna) { console.log(s.protokoll().slice(-1500)); process.exit(1); }

  // ---- 1) Alarm an den Betreiber -----------------------------------------------------------------
  await warte(600);   // dem setImmediate-Lauf Zeit geben
  const pf1 = await postfach(tok.GameGeeeeek);
  const alarme1 = pf1.filter(n => n.type === 'admin-alarm');
  const arten1 = alarme1.map(n => (n.payload || {}).art).sort();
  check('1a: der erste Lauf meldet alle drei Konto-Schwellen an das Betreiberkonto',
    alarme1.length === 3 && arten1.join(',') === 'angriffe,fehlanmeldungen,spielstaende',
    { anzahl: alarme1.length, arten: arten1 });
  const einer = alarme1.find(n => (n.payload || {}).art === 'angriffe') || {};
  check('1a2: die Meldung nennt Konto, Messwert und Schwelle',
    (einer.payload || {}).konto === 'carl' && (einer.payload || {}).wert === 18 && (einer.payload || {}).schwelle === 15,
    { payload: einer.payload });
  const a1 = await holen('/admin/alarm');
  check('1c: die Abfrage nennt Schwellen, Ruhefrist und den Verlauf',
    a1.status === 200 && a1.body.schwellen && a1.body.schwellen.angriffe.schwelle === 15
    && a1.body.ruheStunden === 6 && (a1.body.verlauf || []).length === 3,
    { ruhe: a1.body.ruheStunden, verlauf: (a1.body.verlauf || []).length });
  const kontoFunde = l => (l || []).filter(f => f.art !== 'neustarts');
  check('1c2: sie nennt auch die OFFENEN Funde und den Zeitpunkt des letzten Laufs',
    kontoFunde(a1.body.offen).length === 3 && a1.body.letzterLauf > 0 && (a1.body.jetzt - a1.body.letzterLauf) < 120000,
    { offen: (a1.body.offen || []).length, alter: a1.body.jetzt - a1.body.letzterLauf });
  // 1b: derselbe Zustand, zweiter Lauf - die Ruhefrist verhindert die Wiederholung.
  await aendereDb(() => {});   // Neustart -> zweiter setImmediate-Lauf mit unveraendertem Zustand
  await warte(600);
  const alarme2 = (await postfach(tok.GameGeeeeek)).filter(n => n.type === 'admin-alarm');
  check('1b: derselbe Zustand meldet sich innerhalb der Ruhefrist NICHT erneut (PAAR zu 1a)',
    alarme2.length === 3, { anzahl: alarme2.length });
  // 1e/1f: ein Konto UNTER allen Schwellen - kein Alarm, aber die Messwerte stehen trotzdem da.
  await aendereDb(d => {
    d.users.carl.kampfVerlauf = verlauf(2);
    d.users.carl.loginFehlversuche = 1;
    d.users.carl.saveAblehnungen = { n: 0 };
    d.alarme = { letzterLauf: 0, gesendet: {}, verlauf: [] };
  });
  await warte(600);
  const a2 = await holen('/admin/alarm');
  check('1e: unter den Schwellen loest kein Konto-Alarm mehr aus', kontoFunde(a2.body.offen).length === 0,
    { offen: (a2.body.offen || []).map(f => f.art) });
  check('1f: die Messwerte stehen TROTZDEM da - Schweigen ist von "laeuft nicht" unterscheidbar (PAAR zu 1e)',
    a2.body.stand && a2.body.stand.angriffe === 2 && a2.body.stand.fehlanmeldungen === 1 && a2.body.stand.spielstaende === 0
    && a2.body.letzterLauf > 0,
    { stand: a2.body.stand, letzterLauf: !!a2.body.letzterLauf });
  /* Der VIERTE Alarmfall, und der einzige ohne Konto: Dieser Test startet den Server mehrfach neu,
     ueberschreitet die Schwelle von drei Starts je Stunde also von selbst. Genau deshalb wird er
     hier positiv gemessen und nicht weggefiltert - er ist der Beleg, dass der Waechter auch etwas
     findet, das nicht an einem Spieler haengt. */
  const neustartFund = (a2.body.offen || []).find(f => f.art === 'neustarts');
  check('1i: die Neustarts dieses Testlaufs loesen den vierten Alarmfall aus - ohne Konto',
    !!neustartFund && neustartFund.konto === null && neustartFund.wert >= 3 && neustartFund.schwelle === 3,
    { fund: neustartFund });
  const a3 = await s.j('/admin/alarm', { headers: kopf(tok.anna) });
  check('1g: ein Nicht-Admin kommt nicht an die Alarme', a3.status === 403, { status: a3.status });
  // Neustarts: drei Starts in einer Stunde sind der vierte Alarmfall.
  const neustarts = (liesDb().neustarts || []).length;
  check('1h: jeder Serverstart wird vermerkt', neustarts >= 3, { neustarts });

  // ---- 2) Geschenk an EIN Konto -------------------------------------------------------------------
  const g2a = await admin('/admin/geschenk-konto', { targetUsername: 'anna', gaben: { credits: 500 }, grund: '' });
  check('2c: ohne Begruendung wird abgelehnt', g2a.status === 400 && /begruenden/.test(g2a.body.error || ''), { status: g2a.status });
  const g2b = await admin('/admin/geschenk-konto', { targetUsername: 'anna', gaben: { credits: 99999999 }, grund: 'Entschaedigung' });
  check('2d: eine Gabe ueber dem Deckel der Tabelle wird abgelehnt', g2b.status === 400 && /Kredite/.test(g2b.body.error || ''), { fehler: g2b.body.error });
  const g2 = await admin('/admin/geschenk-konto', { targetUsername: 'anna', gaben: { credits: 500, erz: 1000 }, grund: 'Entschaedigung fuer den verlorenen Spielstand' });
  check('2a: das Geschenk geht an genau dieses Konto', g2.status === 200 && g2.body.username === 'anna' && g2.body.gaben.credits === 500, { body: g2.body });
  const fachAnna = (await s.j('/pending-rewards/claim', { method: 'POST', headers: kopf(tok.anna), body: '{}' })).body || {};
  check('2a2: es liegt im Belohnungsfach mit dem Grund als Text',
    fachAnna.reward && fachAnna.reward.type === 'geschenk' && fachAnna.reward.credits === 500 && /verlorenen Spielstand/.test(fachAnna.reward.text || ''),
    { reward: fachAnna.reward });
  const fachBen = (await s.j('/pending-rewards/claim', { method: 'POST', headers: kopf(tok.ben), body: '{}' })).body || {};
  check('2b: bei einem anderen Konto liegt nichts (PAAR zu 2a)', !fachBen.reward, { reward: fachBen.reward });
  const pfAnna = (await postfach(tok.anna)).filter(n => n.type === 'geschenk-konto');
  check('2a3: der Beschenkte findet den Grund in seinem Postfach',
    pfAnna.length === 1 && /verlorenen Spielstand/.test((pfAnna[0].payload || {}).grund || ''), { postfach: pfAnna.map(x => x.payload) });
  const g2e = await admin('/admin/geschenk-konto', { targetUsername: 'gibtsnicht', gaben: { credits: 5 }, grund: 'test test' });
  check('2e: ein unbekannter Name ergibt 404', g2e.status === 404, { status: g2e.status });

  // ---- 3) Galaxie-Eingriff ------------------------------------------------------------------------
  const gal0 = await holen('/admin/galaxie');
  check('3-vorab: die Abfrage nennt Weltboss, Marktereignis, Voelker und Systeme',
    gal0.status === 200 && gal0.body.weltboss && gal0.body.weltboss.hp === 800 && gal0.body.marktEreignis
    && (gal0.body.voelker || []).length === 4 && (gal0.body.systeme || []).length > 0,
    { boss: gal0.body.weltboss, voelker: (gal0.body.voelker || []).length, systeme: (gal0.body.systeme || []).length });
  const sysId = gal0.body.systeme[0];
  const b3a = await admin('/admin/galaxie', { bereich: 'weltboss', aktion: 'hp', hp: 5000 });
  check('3a: Lebenspunkte ueber dem Hoechstwert werden abgelehnt', b3a.status === 400 && /0 und 1000/.test(b3a.body.error || ''), { fehler: b3a.body.error });
  const b3b = await admin('/admin/galaxie', { bereich: 'weltboss', aktion: 'hp', hp: 0 });
  check('3b: auf null gesetzt gilt der Weltboss als besiegt, nicht als angreifbarer Nuller',
    b3b.status === 200 && b3b.body.besiegt === true && (await holen('/admin/galaxie')).body.weltboss.besiegt === true, { body: b3b.body });
  const n3 = await admin('/admin/galaxie', { bereich: 'nest', aktion: 'setzen', volk: 'kryll', sys: sysId });
  const galN = await holen('/admin/galaxie');
  // Ueber die KENNUNG messen, nicht ueber die Laenge der Liste: Nest- und Konvoi-Takt setzen von
  // sich aus welche (NEST_SPAWN_AKTIV/A2_SPAWN_AKTIV stehen auf true), eine "genau eins"-Pruefung
  // waere also von einem Zufall des Weltentakts abhaengig statt von dieser Route.
  const meinNest = (galN.body.nester || []).find(x => x.id === (n3.body || {}).id);
  check('3c: ein gesetztes Nest steht mit Kennung, Volk und Lebenspunkten in der Galaxie',
    n3.status === 200 && !!n3.body.id && !!meinNest && meinNest.volk === 'kryll' && meinNest.lp > 0,
    { status: n3.status, nest: meinNest });
  const n3b = await admin('/admin/galaxie', { bereich: 'nest', aktion: 'entfernen', id: n3.body.id });
  check('3d: dasselbe Nest laesst sich wieder entfernen (PAAR zu 3c)',
    n3b.status === 200 && !((await holen('/admin/galaxie')).body.nester || []).some(x => x.id === n3.body.id), { status: n3b.status });
  const n3c = await admin('/admin/galaxie', { bereich: 'nest', aktion: 'setzen', volk: 'gibtsnicht', sys: sysId });
  const n3d = await admin('/admin/galaxie', { bereich: 'nest', aktion: 'setzen', volk: 'kryll', sys: 'sys_gibtsnicht' });
  check('3e: unbekanntes Volk und unbekanntes System werden je mit Grund abgelehnt',
    n3c.status === 400 && /Volk/.test(n3c.body.error || '') && n3d.status === 400 && /System/.test(n3d.body.error || ''),
    { volk: n3c.body.error, sys: n3d.body.error });
  const k3 = await admin('/admin/galaxie', { bereich: 'konvoi', aktion: 'setzen', sys: sysId });
  const galK = await holen('/admin/galaxie');
  const meinKonvoi = (galK.body.konvois || []).find(x => x.id === (k3.body || {}).id);
  check('3f: ein Wrackkonvoi laesst sich setzen und steht mit Lebenspunkten da',
    k3.status === 200 && !!meinKonvoi && meinKonvoi.lp > 0 && meinKonvoi.sys === sysId,
    { status: k3.status, konvoi: meinKonvoi, gesamt: (galK.body.konvois || []).length });
  const m3 = await admin('/admin/galaxie', { bereich: 'marktereignis', aktion: 'beenden' });
  check('3f2: das Marktereignis laesst sich beenden', m3.status === 200 && m3.body.lief === true
    && (await holen('/admin/galaxie')).body.marktEreignis === null, { body: m3.body });
  // 3g: Das Kopfgeld muss den naechsten galaxyTick ueberleben - resolveBountyServer setzt sonst
  // sofort wieder den Bestenlisten-Ersten (hier ben mit 99 Punkten) daneben.
  const kg = await admin('/admin/galaxie', { bereich: 'kopfgeld', aktion: 'setzen', targetUsername: 'anna' });
  check('3g-vorab: das Kopfgeld liegt auf anna, nicht auf dem Bestenlisten-Ersten',
    kg.status === 200 && kg.body.ziel === 'anna' && (await holen('/admin/galaxie')).body.kopfgeld.targetName === 'anna', { body: kg.body });
  await aendereDb(() => {});   // Neustart loest resolveBountyServer aus
  await warte(400);
  const kgNach = (await holen('/admin/galaxie')).body.kopfgeld || {};
  check('3g: es steht auch nach dem naechsten Takt noch auf anna (Wochenschluessel mitgeschrieben)',
    kgNach.targetName === 'anna' && kgNach.durchAdmin === true, { kopfgeld: kgNach });
  const x3 = await admin('/admin/galaxie', { bereich: 'gibtsnicht', aktion: 'setzen' });
  check('3h: ein unbekannter Bereich wird mit der Liste der erlaubten abgelehnt',
    x3.status === 400 && /weltboss, nest, konvoi/.test(x3.body.error || ''), { fehler: x3.body.error });

  // ---- 4) Chat-Moderation --------------------------------------------------------------------------
  const c0 = await holen('/admin/chat');
  check('4-vorab: die Abfrage liefert beide Kanaele, neueste zuerst',
    c0.status === 200 && (c0.body.nachrichten || []).length === 3
    && c0.body.nachrichten[0].zeit >= c0.body.nachrichten[1].zeit
    && c0.body.nachrichten.some(n => n.kanal === 'global') && c0.body.nachrichten.some(n => n.kanal === 'T1'),
    { anzahl: (c0.body.nachrichten || []).length, kanaele: (c0.body.nachrichten || []).map(n => n.kanal) });
  const cAnna = await holen('/admin/chat?name=anna');
  check('4-vorab2: nach Konto gefiltert bleiben nur dessen Nachrichten',
    (cAnna.body.nachrichten || []).length === 2 && (cAnna.body.nachrichten || []).every(n => n.autor === 'anna'),
    { anzahl: (cAnna.body.nachrichten || []).length });
  const c4b = await admin('/admin/chat/loeschen', { key: 'leaderboard:' + BEN });
  const c4b2 = await admin('/admin/chat/loeschen', { key: 'alliance:T1:info' });
  check('4b: ein Schluessel, der KEIN Chat ist, wird abgelehnt - die Sperre haelt (PAAR zu 4a)',
    c4b.status === 400 && c4b2.status === 400 && /kein Chat-Schluessel/.test(c4b.body.error || '')
    && liesDb().shared['leaderboard:' + BEN] !== undefined && liesDb().shared['alliance:T1:info'] !== undefined,
    { status: [c4b.status, c4b2.status] });
  const c4 = await admin('/admin/chat/loeschen', { key: 'globalchat:msg:1756000000000-aaa', stummStunden: 24, grund: 'Beleidigung' });
  check('4a: die Nachricht ist weg und der Verfasser in EINEM Schritt stummgeschaltet',
    c4.status === 200 && c4.body.autor === 'anna' && c4.body.stummKonto === 'anna' && c4.body.stummBis > Date.now(),
    { body: c4.body });
  const nachC = liesDb();
  check('4a2: der Schluessel ist wirklich aus dem geteilten Speicher raus, die anderen stehen noch',
    nachC.shared['globalchat:msg:1756000000000-aaa'] === undefined
    && nachC.shared['globalchat:msg:1756000000001-bbb'] !== undefined
    && nachC.shared['alliance:T1:msg:1756000000002-ccc'] !== undefined,
    { rest: Object.keys(nachC.shared).filter(k => k.indexOf(':msg:') > 0) });
  check('4a3: die Stummschaltung steht mit Grund am Konto',
    nachC.users.anna.stummBis > Date.now() && nachC.users.anna.stummGrund === 'Beleidigung', { stumm: nachC.users.anna.stummGrund });
  const c4c = await admin('/admin/chat/loeschen', { key: 'globalchat:msg:1756000000000-aaa' });
  check('4c: dieselbe Nachricht ein zweites Mal ergibt 404 statt eines stillen ok', c4c.status === 404, { status: c4c.status });
  const c4d = await admin('/admin/chat/loeschen', { key: 'alliance:T1:msg:1756000000002-ccc' });
  check('4d: auch eine Allianz-Nachricht laesst sich entfernen, ohne Stummschaltung',
    c4d.status === 200 && c4d.body.stummKonto === null && liesDb().shared['alliance:T1:msg:1756000000002-ccc'] === undefined,
    { body: c4d.body });
  const c4e = await s.j('/admin/chat', { headers: kopf(tok.anna) });
  check('4e: ein Nicht-Admin sieht den Chat-Abruf nicht', c4e.status === 403, { status: c4e.status });

  // ---- 5) Protokoll ---------------------------------------------------------------------------------
  const p5 = await protokoll();
  const arten = p5.map(e => e.art);
  check('5a: Geschenk, Galaxie-Eingriffe und Chat-Loeschung stehen im Protokoll',
    arten.includes('geschenk-konto') && arten.includes('galaxie') && arten.includes('chat/loeschen')
    && (p5.find(e => e.art === 'geschenk-konto') || {}).ziel === 'anna',
    { arten: arten.slice(0, 10) });
  check('5b: im Protokoll steht kein Passwort', !/test1234/.test(JSON.stringify(p5)));

  await stoppeServer();
  console.log(fail ? 'FAIL - es gab rote Pruefungen.' : 'Alles gruen.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FAIL - Testlauf abgebrochen: ' + (e && e.stack || e)); process.exit(1); });
