// Vergeltung / Rache-Knopf (Feature D, 11.09.2026) - gegen einen ECHT gestarteten Server.
//
// DIE REGEL: Wer angegriffen wurde, darf 24 Stunden lang zurueckschlagen. Ein GEWONNENER
// Vergeltungsschlag bringt +25 % auf den Beute-Anteil und +10 Kampfpunkte und verbraucht das Recht;
// eine Niederlage laesst es stehen. Das Recht liegt am NUTZEROBJEKT des Verteidigers (user.rache),
// nie im Spielstand - daran haengt eine Belohnung.
//
// DER MESSAUFBAU (Muster test_bonuscodes_http.js: DB direkt schreiben, Server spawnen, aendereDb bei
// GESTOPPTEM Server; Kampf-Fixtures aus test_pvp_standorte_http.js):
//   anna, carl  - stark (60 Jaeger, 20 Kreuzer); ben, dora - schwach (schild 7, GENAU 1 Mio Erz).
//   DER WURF IST FESTGENAGELT: Die Kopie des Servers setzt Math.random auf 0,5. resolveBattlePhases
//   liest den Wurf je Aufruf (`rng || Math.random`), und die Phasenchance ist auf [0,196; 0,804]
//   geklemmt - stark gegen schwach gewinnt damit IMMER alle drei Phasen, ein Jaeger gegen die Festung
//   verliert IMMER. Ohne das war der Test eine Wuerfelrunde: Der erste Entwurf wiederholte bis zum
//   Sieg, und in einer Gegenprobe gewann die "Niederlage" im ersten Anlauf (10 %), setzte dem Opfer
//   den Schild und liess jede Wiederholung mit 403 abprallen - die Gegenprobe fiel an einer Stelle,
//   die mit der Sabotage nichts zu tun hatte. Der feste Wurf macht ausserdem die Beutequote exakt
//   (0,12 + 0,5 * 0,13 = 18,5 %), sodass die Beute ABSOLUT geprueft werden kann: 231.250 Erz mit
//   Vergeltung, 185.000 ohne. Die Anti-Farming-Bremse ist 1, weil scoreOf() den Bestenlisten-Eintrag
//   im geteilten Speicher liest und es den in dieser DB nicht gibt.
//   Das Rate-Limit (20 Angriffe/min je IP+Pfad) ist Teil des Aufbaus: bei 429 wird gewartet.
//
// GEPRUEFT WIRD:
//   1  Ein Angriff (hier: eine Niederlage des Angreifers) erzeugt das Rachrecht beim OPFER:
//      am Nutzerobjekt, in /api/me, und die Berichte tragen attackerId bzw. targetUserId.
//   2  Der Vergeltungsschlag (Sieg): Antwort und beide Berichte tragen rache/racheBonus, die Beute
//      liegt um den Faktor 1,25 ueber der gewoehnlichen (Verhaeltnis UND absolute Zahl), +35 statt
//      +25 Kampfpunkte, das Recht ist danach weg. Der Schutzschild des Opfers blockt weiterhin -
//      auch einen Raecher mit Recht.
//   3  Abgelaufenes Recht: kein Bonus, keine Felder, Faktor 1,0, +25 Punkte. Ein Dritter ohne
//      Recht ebenso (Vergleichsangriff).
//   4  Eine NIEDERLAGE verbraucht das Recht nicht; 5: die Liste am Nutzer waechst nie ueber 5,
//      abgelaufene Eintraege fliegen beim Schreiben raus.
//
// GEGENPROBE per Env-Sabotage (Muster test_vorposten_endprojekte_http.js): Der Test startet IMMER
// die Kopie (server_rache_tmp.js) und ersetzt bei KEPLER_RACHE_SABOTAGE=<name> genau eine Stelle.
// Was dann fallen MUSS, steht GEMESSEN in MUSS_FALLEN; der Test prueft am Ende selbst, ob genau
// diese Liste gefallen ist (ein Ersatz, der ins Leere geht, faellt schon in 0-sabotage).
//   KEPLER_RACHE_SABOTAGE=bonus     node tests/test_rache_http.js    # Beute-Faktor bleibt 1
//   KEPLER_RACHE_SABOTAGE=punkte    node tests/test_rache_http.js    # keine +10
//   KEPLER_RACHE_SABOTAGE=verbrauch node tests/test_rache_http.js    # Recht ueberlebt den Sieg
//   KEPLER_RACHE_SABOTAGE=ablauf    node tests/test_rache_http.js    # `bis` wird ignoriert
//   KEPLER_RACHE_SABOTAGE=felder    node tests/test_rache_http.js    # rache/racheBonus fehlen
//   KEPLER_RACHE_SABOTAGE=vermerk   node tests/test_rache_http.js    # kein Recht entsteht
//   KEPLER_RACHE_SABOTAGE=deckel    node tests/test_rache_http.js    # Liste waechst ueber 5
//
// Port 3276 (Abschnitt 4 der Spec vom 11.09.2026; gemessen bis 3272 belegt, 3273-3275 vergeben).
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3276);
const BASIS = 'http://127.0.0.1:' + PORT;
const QUELLE = path.join(WURZEL, 'server_rache_tmp.js');
const SAB = process.env.KEPLER_RACHE_SABOTAGE || '';
/* GEMESSEN am 11.09.2026, je Sabotage ein Lauf. `vermerk` reisst die ganze Phase 2 mit: Ohne das
   Recht aus Phase 1 ist annas Schlag in Phase 2 ein gewoehnlicher Sieg - genau die Kette, die der
   Knopf im Client verspricht. 4b/4c bleiben dort gruen, weil Phase 4 das Recht per DB setzt.
   `ablauf` faellt NICHT in 3f: /api/me filtert selbst nach `bis`, nur der Kampfpfad las es nicht. */
const MUSS_FALLEN = {
  bonus: ['2c', '2c2'],
  punkte: ['2d'],
  verbrauch: ['2e', '2f'],
  ablauf: ['3a', '3b', '3c', '3d'],
  felder: ['2a', '2b'],
  vermerk: ['1a', '1b', '2a', '2b', '2c', '2c2', '2d', '4d', '5a'],
  deckel: ['5a']
};

let fail = false;
const ergebnis = {};
const check = (n, c, x) => {
  ergebnis[n.split(':')[0]] = !!c;
  console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : ''));
  fail = fail || !c;
};
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ANNA = crypto.randomUUID(), BEN = crypto.randomUUID(), CARL = crypto.randomUUID(), DORA = crypto.randomUUID();
const H24 = 24 * 3600 * 1000;
const POOL = 1000000;
// Beutequote bei festem Wurf 0,5: lootPct = 0,12 + 0,5 * 0,13. Die Erwartung wird aus derselben
// Formel gerechnet wie im Server, nicht eingetippt; +-1 wegen Math.floor auf Gleitkomma.
const LOOT_PCT = 0.12 + 0.5 * 0.13;
const ERZ_NORMAL = Math.floor(POOL * LOOT_PCT);
const ERZ_RACHE = Math.floor(POOL * LOOT_PCT * 1.25);

// --- Fixtures (aus test_pvp_standorte_http.js: stark ist gegen schwach uebermaechtig) ----------
const stark = (id, name) => ({
  resources: { erz: 1e5, kristalle: 1e5, deuterium: 1e5, energie: 1e5, antimaterie: 1e4, forschungspunkte: 1000 },
  credits: 1000, buildings: { lager: 60, werft: 10 }, research: {}, colonies: {},
  fleet: { fighters: 60, cruisers: 20, missions: [] },
  player: { id, name }, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
});
const schwach = (id, name) => ({
  resources: { erz: POOL }, credits: 0, buildings: { schild: 7 }, research: {}, colonies: {},
  fleet: { missions: [] }, player: { id, name }, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
});
// Fuer die Niederlage: ein einzelner Jaeger gegen eine Festung (Phasenchance auf der Untergrenze).
const winzig = (id, name) => Object.assign(stark(id, name), { fleet: { fighters: 1, missions: [] } });
const festung = (id, name) => Object.assign(schwach(id, name), { buildings: { lager: 60, turm: 200, schild: 200, festung: 100 } });

function grunddb() {
  return {
    users: {
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: Date.now() },
      carl: { userId: CARL, username: 'carl', passwordHash: hash, createdAt: Date.now() },
      dora: { userId: DORA, username: 'dora', passwordHash: hash, createdAt: Date.now() }
    },
    private: {
      [ANNA]: { 'kepler7-save-v3': JSON.stringify(stark(ANNA, 'anna')) },
      [BEN]:  { 'kepler7-save-v3': JSON.stringify(schwach(BEN, 'ben')) },
      [CARL]: { 'kepler7-save-v3': JSON.stringify(stark(CARL, 'carl')) },
      [DORA]: { 'kepler7-save-v3': JSON.stringify(schwach(DORA, 'dora')) }
    },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {} }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-rache-' + process.pid + '.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-rache-'));
let srv = null;
const tok = {};
function aufraeumen() {
  try { if (srv) srv.kill(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.unlinkSync(QUELLE); } catch (e) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', aufraeumen);

// --- Die Kopie (immer, mit festem Wurf) und die Sabotage (nur mit SAB) ------------------------
function schreibeQuelle() {
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  let basis = roh;
  if (SAB === 'bonus') basis = basis.replace('const racheBeuteMult = istRache ? 1 + RACHE_BEUTE_BONUS : 1;', 'const racheBeuteMult = 1;');
  if (SAB === 'punkte') basis = basis.replace('      attacker.battlePoints = (attacker.battlePoints || 0) + RACHE_KAMPFPUNKTE;\n', '');
  if (SAB === 'verbrauch') basis = basis.replace('      racheVerbrauchen(attackerUser, targetUserId);\n', '');
  if (SAB === 'ablauf') basis = basis.replace("  return e && typeof e === 'object' && e.bis > now ? e : null;", "  return e && typeof e === 'object' ? e : null;");
  if (SAB === 'felder') basis = basis.replace('const racheFelder = istRache ? { rache: true, racheBonus: RACHE_BEUTE_BONUS } : {};', 'const racheFelder = {};');
  if (SAB === 'vermerk') basis = basis.split('    racheVermerken(targetUser, req.userId, req.username, racheJetzt);\n').join('');
  if (SAB === 'deckel') basis = basis.replace('  if (ids.length > RACHE_MAX_EINTRAEGE) {', '  if (false) {');
  // Ein Ersatz, der ins Leere geht, waere eine Gegenprobe, die nichts prueft (Vorbild endprojekte 132).
  check('0-sabotage: ' + (SAB ? 'Ersatz „' + SAB + '" hat gegriffen' : 'keine Sabotage, Kopie ist bis auf den festen Wurf byte-gleich'),
    SAB ? (basis !== roh && !!MUSS_FALLEN[SAB]) : basis === roh, { sab: SAB, geaendert: basis !== roh });
  fs.writeFileSync(QUELLE, '// TESTKOPIE (test_rache_http.js): fester Wurf, siehe Dateikopf des Tests.\nMath.random = () => 0.5;\n' + basis);
}

async function starteServer() {
  let log = '';
  srv = spawn(process.execPath, [QUELLE], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, {
      DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret',
      JWT_SECRET_FILE: path.join(tmpDir, 'jwt.txt'),
      VAPID_PUBLIC_FILE: path.join(tmpDir, 'vapid-pub.txt'),
      VAPID_PRIVATE_FILE: path.join(tmpDir, 'vapid-priv.txt')
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASIS + '/api/health'); if (r.ok) break; } catch (e) {}
    await warte(250);
  }
  for (const name of ['anna', 'ben', 'carl', 'dora']) {
    const r = await anfrage('POST', '/api/login', null, { username: name, password: 'test1234' });
    tok[name] = r.body && r.body.token;
  }
  return () => log;
}
async function stoppeServer() {
  if (!srv) return;
  srv.kill('SIGTERM');            // flusht die DB (Graceful Shutdown)
  await warte(700);
  srv = null;
}
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
// Jede DB-Aenderung bei GESTOPPTEM Server (sonst flusht der Graceful Shutdown sie wieder weg).
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  await starteServer();
}
const liesSave = (d, id) => {
  const roh = (d.private[id] || {})['kepler7-save-v3'];
  if (!roh) return null;
  try { return JSON.parse(typeof roh === 'string' ? roh : roh.value); } catch (e) { return null; }
};
const schildeNullen = d => { for (const id of [ANNA, BEN, CARL, DORA]) if (d.private[id]) d.private[id].__attackShieldUntil = 0; };
const bericht = (d, id) => ((d.private[id] || {}).__reports || [])[0] || {};

function anfrage(methode, pfad, token, body) {
  return new Promise((resolve) => {
    const daten = body ? JSON.stringify(body) : null;
    const req = http.request(BASIS + pfad, {
      method: methode,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {},
        daten ? { 'Content-Length': Buffer.byteLength(daten) } : {})
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, body: j, roh: buf }); });
    });
    req.on('error', e => resolve({ status: 0, body: null, roh: String(e) }));
    if (daten) req.write(daten);
    req.end();
  });
}
async function angriff(von, zielId) {
  for (let i = 0; i < 3; i++) {
    const r = await anfrage('POST', '/api/attack', tok[von], { targetUserId: zielId });
    if (r.status !== 429) return r;
    const wartezeit = (parseInt((r.headers || {})['retry-after'], 10) || 61) + 1;
    console.log('     (429 vom attackRateLimit - warte ' + wartezeit + 's)');
    await warte(wartezeit * 1000);
  }
  return { status: 429, body: null };
}
const frisch = (name, save) => anfrage('PUT', '/api/storage/kepler7-save-v3', tok[name], { value: JSON.stringify(save) });
const ID = { anna: ANNA, ben: BEN, carl: CARL, dora: DORA };
// Beide Spielstaende FRISCH schreiben, dann EIN Angriff - der Wurf ist fest, der Ausgang folgt aus
// den Kraeften. `beschreibung` macht aus einem unerwarteten Ausgang eine lesbare Diagnose.
async function kampf(von, vonSave, ziel, zielSave) {
  await frisch(von, vonSave); await frisch(ziel, zielSave);
  const r = await angriff(von, ID[ziel]);
  return { r, beschreibung: r.status + ':' + ((r.body || {}).error || ((r.body || {}).success === true ? 'SIEG' : 'niederlage')) };
}
// Der Rache-Faktor als VERHAELTNIS: defenderLossPct = lootPct/2 traegt den Faktor nicht, stolen
// schon - der Quotient isoliert ihn (Toleranz wie im PvP-Test: Rundung von defenderLossPct auf
// drei Stellen). Dazu die absolute Zahl, die der feste Wurf moeglich macht.
const faktor = b => (b && b.defenderLossPct > 0) ? ((b.stolen && b.stolen.erz) || 0) / (POOL * b.defenderLossPct * 2) : null;
const me = name => anfrage('GET', '/api/me', tok[name], null);

(async () => {
  schreibeQuelle();
  schreibDb(grunddb());
  await starteServer();
  check('0-vorab: vier Konten angemeldet', ['anna', 'ben', 'carl', 'dora'].every(n => !!tok[n]), Object.keys(tok).filter(n => tok[n]));

  // ==== 1: Der Angriff erzeugt das Rachrecht beim Opfer ======================================
  const t1 = Date.now();
  const erst = await angriff('ben', ANNA);      // ben (ohne Flotte) gegen anna: verliert - das Recht entsteht in beiden Ausgaengen
  check('1-vorab: bens Angriff auf anna wurde aufgeloest (Niederlage)', erst.status === 200 && (erst.body || {}).success === false,
    { status: erst.status, success: (erst.body || {}).success, fehler: (erst.body || {}).error });
  let d = liesDb();
  const r1 = ((d.users.anna || {}).rache || {})[BEN];
  check('1a: das Rachrecht liegt am NUTZEROBJEKT des Opfers (name, seit, bis = seit + 24 h)',
    !!r1 && r1.name === 'ben' && r1.seit >= t1 && r1.bis === r1.seit + H24, r1);
  const me1 = await me('anna');
  const me1r = ((me1.body || {}).rache || []).find(e => e.gegnerId === BEN);
  check('1b: /api/me nennt das Recht (gegnerId, gegnerName, bis)',
    Array.isArray((me1.body || {}).rache) && !!me1r && me1r.gegnerName === 'ben' && me1r.bis === (r1 || {}).bis, (me1.body || {}).rache);
  const meC = await me('carl');
  check('1c: /api/me eines Unbeteiligten traegt das Feld als LEERE Liste (nicht: gar nicht)',
    Array.isArray((meC.body || {}).rache) && (meC.body || {}).rache.length === 0, (meC.body || {}).rache);
  const bSent1 = bericht(d, BEN), bRecv1 = bericht(d, ANNA);
  check('1d: attack-sent traegt targetUserId, attack-received traegt attackerId - und KEIN rache-Feld (kein Vergeltungsschlag)',
    bSent1.type === 'attack-sent' && bSent1.targetUserId === ANNA && bRecv1.type === 'attack-received' && bRecv1.attackerId === BEN &&
    !('rache' in bSent1) && !('rache' in bRecv1),
    { sent: { type: bSent1.type, targetUserId: bSent1.targetUserId, rache: bSent1.rache }, recv: { type: bRecv1.type, attackerId: bRecv1.attackerId, rache: bRecv1.rache } });
  check('1e: der Spielstand des Opfers traegt das Recht NICHT (es haengt eine Belohnung daran)',
    !('rache' in (liesSave(d, ANNA) || {})), Object.keys(liesSave(d, ANNA) || {}).filter(k => /rache/i.test(k)));

  // ==== 2: Der Vergeltungsschlag =============================================================
  await aendereDb(async db => {
    schildeNullen(db);
    // carl bekommt ein Recht gegen ben - fuer 2g (der Schild blockt auch einen Raecher).
    db.users.carl.rache = { [BEN]: { name: 'ben', seit: Date.now(), bis: Date.now() + H24 } };
  });
  const s2 = await kampf('anna', stark(ANNA, 'anna'), 'ben', schwach(BEN, 'ben'));
  const a2 = s2.r.body || {};
  check('2-vorab: annas Vergeltungsschlag gegen ben gewonnen', a2.success === true, s2.beschreibung);
  check('2a: die Antwort traegt rache:true und racheBonus 0,25', a2.rache === true && a2.racheBonus === 0.25, { rache: a2.rache, racheBonus: a2.racheBonus });
  d = liesDb();
  const bSent2 = bericht(d, ANNA), bRecv2 = bericht(d, BEN);
  check('2b: beide Berichte tragen rache:true und racheBonus 0,25 (plus die Kennungen)',
    bSent2.type === 'attack-sent' && bSent2.rache === true && bSent2.racheBonus === 0.25 && bSent2.targetUserId === BEN &&
    bRecv2.type === 'attack-received' && bRecv2.rache === true && bRecv2.racheBonus === 0.25 && bRecv2.attackerId === ANNA,
    { sent: { rache: bSent2.rache, racheBonus: bSent2.racheBonus, targetUserId: bSent2.targetUserId }, recv: { rache: bRecv2.rache, racheBonus: bRecv2.racheBonus, attackerId: bRecv2.attackerId } });
  const f2 = faktor(a2);
  check('2c: die Beute liegt um den Faktor 1,25 ueber der gewoehnlichen Quote (gemessen als Verhaeltnis, nicht behauptet)',
    f2 !== null && Math.abs(f2 - 1.25) < 0.03, { faktor: f2, erz: a2.stolen && a2.stolen.erz, defenderLossPct: a2.defenderLossPct });
  check('2c2: und absolut: ' + ERZ_RACHE + ' Erz (1 Mio * 18,5 % * 1,25 bei festem Wurf)',
    !!a2.stolen && Math.abs(a2.stolen.erz - ERZ_RACHE) <= 1, { erz: a2.stolen && a2.stolen.erz, erwartet: ERZ_RACHE });
  check('2c3: der Bonus nimmt dem Ziel nicht mehr, als der Angreifer bekam (Pool - Beute = Rest)',
    (liesSave(d, BEN) || { resources: {} }).resources.erz === POOL - (a2.stolen || {}).erz, { rest: (liesSave(d, BEN) || { resources: {} }).resources.erz });
  const bp2 = (liesSave(d, ANNA) || {}).battlePoints;
  check('2d: +35 Kampfpunkte (25 fuer den Sieg + 10 Vergeltung) statt +25', bp2 === 35, { battlePoints: bp2 });
  check('2e: das Recht ist mit dem Sieg VERBRAUCHT', !((d.users.anna.rache || {})[BEN]), d.users.anna.rache);
  const me2 = await me('anna');
  check('2f: /api/me nennt ben nicht mehr', Array.isArray((me2.body || {}).rache) && !(me2.body || {}).rache.some(e => e.gegnerId === BEN), (me2.body || {}).rache);
  // 2g: bens Schild steht seit annas Sieg - carl hat ein Recht und prallt trotzdem ab.
  const g = await angriff('carl', BEN);
  check('2g: der Schutzschild blockt auch einen Raecher mit gueltigem Recht (403), das Recht bleibt',
    g.status === 403 && /Schutzschild/.test((g.body || {}).error || '') && !!((liesDb().users.carl.rache || {})[BEN]),
    { status: g.status, fehler: (g.body || {}).error, carlRecht: !!((liesDb().users.carl.rache || {})[BEN]) });

  // ==== 3: abgelaufen, und ein Dritter ohne Recht (Vergleichsangriff) =========================
  await aendereDb(async db => {
    schildeNullen(db);
    db.users.anna.rache = { [BEN]: { name: 'ben', seit: Date.now() - H24 - 5000, bis: Date.now() - 5000 } };
    delete db.users.carl.rache;
  });
  const s3 = await kampf('anna', stark(ANNA, 'anna'), 'ben', schwach(BEN, 'ben'));
  const a3 = s3.r.body || {};
  check('3-vorab: annas Sieg mit ABGELAUFENEM Recht', a3.success === true, s3.beschreibung);
  check('3a: abgelaufen -> die Antwort traegt KEIN rache-Feld', !('rache' in a3) && !('racheBonus' in a3), { rache: a3.rache, racheBonus: a3.racheBonus });
  d = liesDb();
  const bSent3 = bericht(d, ANNA);
  check('3b: abgelaufen -> der Bericht traegt KEIN rache-Feld', bSent3.type === 'attack-sent' && !('rache' in bSent3), { rache: bSent3.rache });
  check('3c: abgelaufen -> +25 Kampfpunkte, nicht +35', (liesSave(d, ANNA) || {}).battlePoints === 25, { battlePoints: (liesSave(d, ANNA) || {}).battlePoints });
  const f3 = faktor(a3);
  check('3d: abgelaufen -> Beute-Faktor 1,0 und absolut ' + ERZ_NORMAL + ' Erz',
    f3 !== null && Math.abs(f3 - 1.0) < 0.03 && !!a3.stolen && Math.abs(a3.stolen.erz - ERZ_NORMAL) <= 1, { faktor: f3, erz: a3.stolen && a3.stolen.erz });
  const s3c = await kampf('carl', stark(CARL, 'carl'), 'dora', schwach(DORA, 'dora'));
  const a3c = s3c.r.body || {};
  check('3e-vorab: carls Sieg ueber dora (ohne jedes Recht)', a3c.success === true, s3c.beschreibung);
  const f3c = faktor(a3c);
  check('3e: ein Dritter ohne Recht: kein rache-Feld, Faktor 1,0, +25 Punkte',
    !('rache' in a3c) && f3c !== null && Math.abs(f3c - 1.0) < 0.03 && (liesSave(liesDb(), CARL) || {}).battlePoints === 25,
    { rache: a3c.rache, faktor: f3c, battlePoints: (liesSave(liesDb(), CARL) || {}).battlePoints });
  const me3 = await me('anna');
  check('3f: /api/me filtert das abgelaufene Recht heraus', Array.isArray((me3.body || {}).rache) && !(me3.body || {}).rache.some(e => e.gegnerId === BEN), (me3.body || {}).rache);

  // ==== 4: Niederlage laesst das Recht stehen; 5: der Deckel ================================
  const jetzt4 = Date.now();
  await aendereDb(async db => {
    schildeNullen(db);
    db.users.anna.rache = {
      // Fuer 5a: ein abgelaufener und fuenf gueltige Fremd-Eintraege plus ben = sieben. Beim
      // naechsten Schreiben muss der abgelaufene weg und dann der aelteste gueltige (f1).
      f0: { name: 'f0', seit: jetzt4 - H24, bis: jetzt4 - 1 },
      f1: { name: 'f1', seit: jetzt4, bis: jetzt4 + 1 * 3600000 },
      f2: { name: 'f2', seit: jetzt4, bis: jetzt4 + 2 * 3600000 },
      f3: { name: 'f3', seit: jetzt4, bis: jetzt4 + 3 * 3600000 },
      f4: { name: 'f4', seit: jetzt4, bis: jetzt4 + 4 * 3600000 },
      f5: { name: 'f5', seit: jetzt4, bis: jetzt4 + 5 * 3600000 },
      [BEN]: { name: 'ben', seit: jetzt4, bis: jetzt4 + H24 }
    };
  });
  const s4 = await kampf('anna', winzig(ANNA, 'anna'), 'ben', festung(BEN, 'ben'));
  const a4 = s4.r.body || {};
  check('4-vorab: annas Niederlage mit gueltigem Recht (ein Jaeger gegen die Festung)', a4.success === false, s4.beschreibung);
  check('4a: die verlorene Antwort traegt KEIN rache-Feld (kein Bonus ohne Sieg)', !('rache' in a4), { rache: a4.rache });
  d = liesDb();
  const r4 = (d.users.anna.rache || {})[BEN];
  check('4b: das Recht ueberlebt die Niederlage unveraendert', !!r4 && r4.bis === jetzt4 + H24, r4);
  const me4 = await me('anna');
  check('4c: /api/me nennt ben weiterhin', ((me4.body || {}).rache || []).some(e => e.gegnerId === BEN), (me4.body || {}).rache);
  check('4d: die Niederlage hat umgekehrt bens Recht gegen anna erzeugt', !!((d.users.ben.rache || {})[ANNA]), d.users.ben.rache);
  // 5a: ben schlaegt zurueck (ohne Flotte, verliert) - annas Liste wird dabei geschrieben.
  await frisch('ben', festung(BEN, 'ben'));
  const z5 = await angriff('ben', ANNA);
  d = liesDb();
  const l5 = Object.keys(d.users.anna.rache || {});
  check('5a: beim Schreiben fliegen der abgelaufene (f0) und der aelteste gueltige (f1) raus - hoechstens 5 bleiben, ben ist dabei',
    z5.status === 200 && l5.length === 5 && !l5.includes('f0') && !l5.includes('f1') && l5.includes('f5') && l5.includes(BEN),
    { status: z5.status, liste: l5 });

  await stoppeServer();
  if (SAB) {
    const soll = MUSS_FALLEN[SAB] || [];
    const gefallen = Object.keys(ergebnis).filter(k => !ergebnis[k]);
    const genau = soll.every(k => gefallen.includes(k)) && gefallen.every(k => soll.includes(k));
    console.log('\nGegenprobe „' + SAB + '": gefallen ' + JSON.stringify(gefallen) + ', erwartet ' + JSON.stringify(soll));
    console.log(genau ? 'GEGENPROBE PASS' : 'GEGENPROBE FAIL');
    process.exit(genau ? 0 : 1);
  }
  console.log(fail ? '\nFAIL' : '\nPASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
