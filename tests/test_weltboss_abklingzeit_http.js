// Weltboss: Die Tagessperre darf den EIGENEN Schlag nicht verschlucken (02.09.2026).
//
// Spieler-Report Sascha: "weltboss da stimmt was nicht habe mehrmals angegriffen immer an mehreren
// tagen aber hp sinken nicht". Gemessen: Das Frontend stempelt `state.worldBossLastAttack` beim
// LOSFLIEGEN (sendWorldBossMission) und speichert; /api/worldboss/resolve las bei der ANKUNFT
// denselben Stempel aus dem Spielstand, sah "vor fünf Minuten angegriffen" und wertete jeden
// Schlag als Abklingzeit (onCooldown, 0 Schaden, 50 Kredite Spesen). Seit die Prüfung am
// 04.08.2026 in den Server kam, hat kein regulärer Angriff den Boss getroffen.
//
// Behebung: Die Sperre liegt AM NUTZEROBJEKT (user.weltbossLetzterSchlag), gesetzt vom Server
// bei einem gewerteten Schlag - wie CLAUDE.md es für belohnungsrelevante Zähler verlangt - und
// wird gegen 24 h minus eine Stunde Toleranz geprüft (Startstempel des Clients und Ankunftsstempel
// des Servers liegen eine Flugzeit auseinander).
//
// Port 3246 (belegt bis 3245, Arbeitsregel 29). Gegenprobe siehe Fuß der Datei.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');

const WURZEL = path.resolve(__dirname, '..');
const QUELLE = process.env.KEPLER_BACKEND_SERVER || path.join(WURZEL, 'server.js');
const PORT = 3246;
let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const hash = bcrypt.hashSync('test1234', 10);
const ANNA = crypto.randomUUID(), BERT = crypto.randomUUID(), CARL = crypto.randomUUID();
const STUNDE = 3600 * 1000;
const BOSS_ID = 'wb1_abkling';
const hpFuer = stufe => Math.round(50000 * Math.pow(1.6, Math.max(0, stufe - 1)));

function mission(id, vorMin) {
  return { id, type: 'worldboss', targetId: BOSS_ID, bossLevel: 1,
    startTime: Date.now() - vorMin * 60000, endTime: Date.now() - 60000,
    composition: { jaeger: 300, cruisers: 100 } };
}
function spielstand(uid, name, felder) {
  return Object.assign({
    resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {},
    fleet: { jaeger: 500, cruisers: 200, missions: [] },
    player: { id: uid, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  }, felder || {});
}
const jetzt = Date.now();
const db = {
  users: {
    anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: jetzt },
    // Bert hat vor 23,5 h einen gewerteten Schlag (Serverstempel) - innerhalb der Toleranz, darf.
    bert: { userId: BERT, username: 'bert', passwordHash: hash, createdAt: jetzt, weltbossLetzterSchlag: jetzt - 23.5 * STUNDE },
    // Carl vor 22 h - zu früh, wird abgewiesen.
    carl: { userId: CARL, username: 'carl', passwordHash: hash, createdAt: jetzt, weltbossLetzterSchlag: jetzt - 22 * STUNDE }
  },
  private: {
    // Anna: genau der Spielstand, den das Frontend erzeugt - Startstempel vor 5 Minuten, Mission angekommen.
    [ANNA]: { 'kepler7-save-v3': JSON.stringify(spielstand(ANNA, 'anna', {
      worldBossLastAttack: jetzt - 5 * 60000,
      fleet: { jaeger: 500, cruisers: 200, missions: [mission('m-anna-1', 5), mission('m-anna-2', 4)] } })) },
    [BERT]: { 'kepler7-save-v3': JSON.stringify(spielstand(BERT, 'bert', {
      worldBossLastAttack: jetzt - 5 * 60000,
      fleet: { jaeger: 500, cruisers: 200, missions: [mission('m-bert-1', 5)] } })) },
    [CARL]: { 'kepler7-save-v3': JSON.stringify(spielstand(CARL, 'carl', {
      worldBossLastAttack: jetzt - 5 * 60000,
      fleet: { jaeger: 500, cruisers: 200, missions: [mission('m-carl-1', 5)] } })) }
  },
  shared: { 'worldboss:current': JSON.stringify({ bossId: BOSS_ID, level: 1, maxHp: hpFuer(1), hp: hpFuer(1), spawnedAt: jetzt, contributions: {}, defeatedAt: null }) },
  resetTokens: {},
  galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {}, news: [], activeWar: null, activeWormhole: null, lastTick: jetzt, factions: {} }
};
const warte = ms => new Promise(r => setTimeout(r, ms));
const dbPfad = path.join(os.tmpdir(), 'kepler-weltboss-abkling-' + process.pid + '.json');
fs.writeFileSync(dbPfad, JSON.stringify(db, null, 1));
let log = '';
const srv = spawn(process.execPath, [QUELLE], { cwd: WURZEL,
  env: Object.assign({}, process.env, { DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret' }), stdio: ['ignore', 'pipe', 'pipe'] });
srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; });
const ende = () => { try { srv.kill(); } catch (e) {} try { fs.unlinkSync(dbPfad); } catch (e) {} };
process.on('exit', ende);
const basis = 'http://127.0.0.1:' + PORT + '/api';
async function j(pfad, opt) {
  const r = await fetch(basis + pfad, opt); const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch (e) { return { status: r.status, body: t.slice(0, 300) }; }
}
const dbLesen = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const bossHp = () => { try { return JSON.parse(dbLesen().shared['worldboss:current']).hp; } catch (e) { return null; } };

(async () => {
  for (let i = 0; i < 80; i++) { try { const r = await fetch(basis + '/health'); if (r.ok) break; } catch (e) {} await warte(250); }
  const kopf = {};
  for (const n of ['anna', 'bert', 'carl']) {
    const r = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: n, password: 'test1234' }) });
    kopf[n] = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (r.body && r.body.token) };
  }
  check('0: drei Konten angemeldet', ['anna', 'bert', 'carl'].every(n => /Bearer .{20,}/.test(kopf[n].Authorization)));
  const resolve = (n, id) => j('/worldboss/resolve', { method: 'POST', headers: kopf[n], body: JSON.stringify({ missionId: id, planetKey: 'home' }) });

  // ---- 1. Der Fall aus dem Spieler-Report: Startstempel im Spielstand, Mission angekommen ------
  const hpVorher = bossHp();
  const a1 = await resolve('anna', 'm-anna-1');
  check('1a: die Auflösung antwortet 200 ok', a1.status === 200 && a1.body && a1.body.ok === true, { status: a1.status, body: a1.body });
  check('1b: der Schlag wird GEWERTET - der eigene Startstempel ist keine Abklingzeit',
    !!a1.body && a1.body.onCooldown !== true && a1.body.arrivedTooLate !== true && a1.body.damage > 0,
    { onCooldown: a1.body && a1.body.onCooldown, damage: a1.body && a1.body.damage });
  await warte(400);
  const hpNachher = bossHp();
  check('1c: die HP des gemeinsamen Bosses sinken', hpNachher !== null && hpNachher < hpVorher, { vorher: hpVorher, nachher: hpNachher });
  const userAnna = dbLesen().users.anna;
  check('1d: die Sperre steht AM NUTZEROBJEKT (user.weltbossLetzterSchlag), nicht im Spielstand',
    typeof userAnna.weltbossLetzterSchlag === 'number' && Date.now() - userAnna.weltbossLetzterSchlag < 60000, userAnna.weltbossLetzterSchlag);
  const saveLesen = uid => { const r = dbLesen().private[uid]['kepler7-save-v3']; return JSON.parse(typeof r === 'string' ? r : r.value); }; // beide Formen (Zeichenkette / { value, version })
  const saveAnna = saveLesen(ANNA);
  check('1e: der Server lässt den Startstempel des Clients unangetastet (er gehört dem Client-Torwächter)',
    saveAnna.worldBossLastAttack === jetzt - 5 * 60000, saveAnna.worldBossLastAttack);

  // ---- 2. Die echte Sperre lebt weiter: eine zweite präparierte Mission direkt danach ---------
  const a2 = await resolve('anna', 'm-anna-2');
  check('2a: der zweite Schlag am selben Tag wird abgewiesen (onCooldown, 0 Schaden)',
    a2.status === 200 && !!a2.body && a2.body.onCooldown === true && a2.body.damage === 0, a2.body);
  await warte(300);
  check('2b: und die HP bleiben stehen', bossHp() === hpNachher, { hp: bossHp(), erwartet: hpNachher });

  // ---- 3. Die Toleranz: 23,5 h nach dem Serverstempel darf, 22 h nicht --------------------------
  const b1 = await resolve('bert', 'm-bert-1');
  check('3a: 23,5 h nach dem letzten gewerteten Schlag zählt der Schlag (Flugzeit-Toleranz)',
    !!b1.body && b1.body.onCooldown !== true && b1.body.damage > 0, b1.body && { onCooldown: b1.body.onCooldown, damage: b1.body.damage });
  const c1 = await resolve('carl', 'm-carl-1');
  check('3b: 22 h danach ist noch Abklingzeit', !!c1.body && c1.body.onCooldown === true && c1.body.damage === 0, c1.body && { onCooldown: c1.body.onCooldown, damage: c1.body.damage });
  await warte(300);
  const userCarl = dbLesen().users.carl;
  check('3c: ein abgewiesener Schlag verschiebt den Stempel nicht', userCarl.weltbossLetzterSchlag === jetzt - 22 * STUNDE, userCarl.weltbossLetzterSchlag);

  ende();
  console.log(fail ? '\nFAIL - mindestens eine Prüfung rot' : '\nAlles gruen.');
  if (fail && /Error/.test(log)) console.log(log.slice(-1200));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL - Ausnahme: ' + (e && e.stack || e)); console.log(log.slice(-800)); ende(); process.exit(1); });
// Gegenprobe gemessen 02.09.2026 (KEPLER_BACKEND_SERVER = Kopie von origin/master d5721a5 IM Repo-
// Verzeichnis, sonst löst require('./mailer') nicht auf): rot 1b 1c 1d 3a (4), grün 0 1a 1e 2a 2b 3b 3c (7);
// Prüflisten beider Läufe per diff identisch (11 Namen; die Schlusszeile "FAIL - mindestens" zählt nicht mit).
// 3b/3c sind am alten Stand grün, weil dort GAR KEIN Serverstempel gelesen wird und Carls Spielstand
// den Startstempel trägt - 3a fällt aus demselben Grund: Berts Startstempel sperrt ihn.
