// Saison-Auftragsbuch (Feature B, 11.09.2026) - gegen einen ECHT gestarteten Server.
//
// WAS DAS BUCH IST: ein Monatsfortschritt aus Taten, die der Server SELBST gesehen hat (Angriff,
// Abwehr, Festung, Nest, Konvoi, Weltboss, Vorposten, Markt), mit zwanzig Stufen und Belohnungen
// ueber die Warteschlange. Der Zustand liegt am Nutzerobjekt, nie im Spielstand.
//
// DIE SECHS ZUSAGEN, die dieser Test misst (jede mit Abschnitt):
//   1  Eine Tat zaehlt Punkte - und zwar NUR im Erfolgspfad der Route (Abschnitt 2).
//   2  Der Tagesdeckel je Art greift (Abschnitt 5, am Markt: Deckel 10, elf Verkaeufe).
//   3  Ein am Schild abgeprallter Angriff zaehlt nicht - kein Kampf, keine Tat (Abschnitt 3).
//   4  Abholen reiht jede erreichte Stufe GENAU EINMAL ein (Abschnitt 6).
//   5  Der Saisonwechsel reiht die erreichten, nicht abgeholten Stufen der alten Saison ein, bucht
//      den Sternenstaub serverseitig und legt das Buch neu an - idempotent (Abschnitt 7).
//   6  Die Punkte liegen am NUTZER, nicht im Spielstand: Ein Spielstand-PUT mit einem gefaelschten
//      `auftragsbuch` aendert nichts (Abschnitt 8). Dazu der Schalter (Abschnitt 9): Code-Schalter
//      aus -> 404 mit inaktiv:true und KEINE Zaehlung; Notaus des Admins -> dasselbe zur Laufzeit.
//
// GEGENPROBE per Env-Sabotage an einer KOPIE von server.js (Vorbild test_vorposten_endprojekte_http.js):
//   KEPLER_AUFTRAGSBUCH_SABOTAGE=<name> node tests/test_auftragsbuch_http.js
// MUSS_FALLEN unten nennt je Sabotage die Pruefungen, die GEMESSEN fallen (11.09.2026). Am Stand
// OHNE das Feature (Routen fehlen) fallen alle Pruefungen ab 1a, weil jede Antwort 404 ist.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3274);
const QUELLE = path.join(WURZEL, 'server_auftragsbuch_tmp.js');
const SAB = process.env.KEPLER_AUFTRAGSBUCH_SABOTAGE || '';
/* GEMESSEN am 11.09.2026, nicht geschaetzt - die erste Fassung dieser Liste riet bei vier von sechs
   Sabotagen daneben. Was NICHT faellt, sagt genauso viel wie das, was faellt:
   zaehlung  (der Angriffs-Hook fehlt): 6a-6d bleiben gruen, weil Abwehr (8) + Markt (20) Stufe 1
             trotzdem erreichen - die Stufenpruefung haengt nicht an EINER Tatenart.
   deckel    (kein Tagesdeckel): nur der Markt-Abschnitt faellt; drei Angriffe liegen unter Deckel 5.
   schild    (Zaehlung VOR der Schildpruefung): 4b faellt MIT, und das ist die Folge, nicht ein
             Nebenschaden - der Bezugswert `punkteVor3` wird vor dem Schildangriff gelesen, der
             sabotierte Server zaehlt danach 10 zu viel.
   doppelt   (Stufe wird nicht als abgeholt vermerkt): das zweite Abholen reiht erneut ein.
   saison    (alte Saison wird nicht abgeschlossen): 7c bleibt gruen - das NEUE Buch entsteht
             trotzdem, nur die Belohnungen der alten fehlen. Genau der stille Verlust, den 7a misst.
   schalter  (Routen ignorieren den Schalter): 9c bleibt gruen, weil der HOOK den Schalter weiterhin
             prueft; 9e, weil die Notaus-Liste unangetastet ist. */
const MUSS_FALLEN = {
  zaehlung: ['2b', '2c', '4c'],
  deckel:   ['5b', '5c'],
  schild:   ['3b', '4b'],
  doppelt:  ['6c', '6d', '6e'],
  saison:   ['7a', '7b', '7d'],
  schalter: ['9a', '9b', '9f']
};

let fail = false;
const ergebnis = {};
const check = (n, c, x) => {
  ergebnis[n] = !!c;
  console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : ''));
  fail = fail || !c;
};
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ADMIN = crypto.randomUUID(), ANNA = crypto.randomUUID(), BEN = crypto.randomUUID(), CARL = crypto.randomUUID();

// Anna ist stark in beide Richtungen (Flotte fuer den Angriff, Anlagen fuer die Abwehr), Ben ist
// das schwache Opfer (Beute-Pool, fast keine Verteidigung), Carl der chancenlose Angreifer.
function spielstand(id, name, extra) {
  return Object.assign({
    resources: { energie: 1e5, erz: 1e5, kristalle: 1e5, deuterium: 1e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {}, fleet: {},
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  }, extra || {});
}
const SAVES = {
  [ADMIN]: () => spielstand(ADMIN, 'GameGeeeeek'),
  [ANNA]:  () => spielstand(ANNA, 'anna', { buildings: { lager: 60, turm: 200, schild: 200, festung: 100 }, fleet: { fighters: 60, cruisers: 20 } }),
  [BEN]:   () => spielstand(BEN, 'ben', { resources: { erz: 1000000 }, credits: 0, buildings: { schild: 7 } }),
  [CARL]:  () => spielstand(CARL, 'carl', { fleet: { fighters: 1 } })
};
function grunddb() {
  const priv = {};
  for (const id of Object.keys(SAVES)) priv[id] = { 'kepler7-save-v3': JSON.stringify(SAVES[id]()) };
  return {
    users: {
      gamegeeeeek: { userId: ADMIN, username: 'GameGeeeeek', passwordHash: hash, createdAt: Date.now() },
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: Date.now() },
      carl: { userId: CARL, username: 'carl', passwordHash: hash, createdAt: Date.now() }
    },
    private: priv, shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {} }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-auftragsbuch-' + process.pid + '.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-auftragsbuch-'));
let srv = null;
let s = null, tokAdmin = null, tokA = null, tokB = null, tokC = null;
function aufraeumen() {
  try { if (srv) srv.kill(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.unlinkSync(QUELLE); } catch (e) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', aufraeumen);

/* Die Kopie: Schalter je Abschnitt umlegbar, Sabotage nur hier - server.js selbst bleibt unberuehrt.
   Jede Sabotage prueft, dass ihr Anker WIRKLICH getroffen hat (sonst misst die Gegenprobe nichts). */
function schreibeKopie(schalterAn) {
  let basis = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  const ersetze = (alt, neu) => {
    if (basis.indexOf(alt) < 0) { console.log('FAIL - Sabotage-Anker nicht gefunden: ' + alt.slice(0, 60)); process.exit(1); }
    basis = basis.split(alt).join(neu);
  };
  if (SAB === 'zaehlung') ersetze("auftragsbuchTat(req.userId, 'angriff');", '');
  if (SAB === 'deckel') ersetze("  if ((b.tag.zaehler[art] || 0) >= def.tagesDeckel) return false;\n", '');
  if (SAB === 'schild') ersetze("  if (shieldLeft > 0) return res.status(403).json({ error: 'Ziel steht unter Angriffs-Schutzschild.', shieldMs: shieldLeft });",
    "  if (shieldLeft > 0) { auftragsbuchTat(req.userId, 'angriff'); await saveDb(); return res.status(403).json({ error: 'Ziel steht unter Angriffs-Schutzschild.', shieldMs: shieldLeft }); }");
  if (SAB === 'doppelt') ersetze("  if (!st || b.abgeholt.indexOf(stufenNr) !== -1) return false;\n  b.abgeholt.push(stufenNr);\n", "  if (!st) return false;\n");
  if (SAB === 'saison') ersetze("    if (b && typeof b === 'object' && b.saison && Array.isArray(b.abgeholt)) auftragsbuchSaisonAbschliessen(user, b);\n", '');
  if (SAB === 'schalter') ersetze("  if (!spawnAktiv('auftragsbuch')) return res.status(404).json({ error: 'Das Auftragsbuch ist nicht aktiv.', inaktiv: true });\n", '');
  const vorher = basis;
  basis = basis.replace(/const AUFTRAGSBUCH_AKTIV = (true|false);/, 'const AUFTRAGSBUCH_AKTIV = ' + (schalterAn ? 'true' : 'false') + ';');
  if (basis === vorher && !/const AUFTRAGSBUCH_AKTIV = (true|false);/.test(basis)) { console.log('FAIL - AUFTRAGSBUCH_AKTIV nicht gefunden'); process.exit(1); }
  fs.writeFileSync(QUELLE, basis);
}

async function starteServer(schalterAn) {
  schreibeKopie(schalterAn !== false);
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
  const basis = 'http://127.0.0.1:' + PORT + '/api';
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(basis + '/health'); if (r.ok) break; } catch (e) {}
    await warte(250);
  }
  async function j(pfad, opt) {
    const r = await fetch(basis + pfad, opt);
    const t = await r.text();
    let body; try { body = JSON.parse(t); } catch (e) { body = t.slice(0, 300); }
    return { status: r.status, body, headers: r.headers };
  }
  async function anmelden(name) {
    const r = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name, password: 'test1234' }) });
    return r.body && r.body.token;
  }
  return { j, anmelden, protokoll: () => log };
}
async function stoppeServer() {
  if (!srv) return;
  srv.kill('SIGTERM');            // flusht die DB (Graceful Shutdown)
  await warte(700);
  srv = null;
}
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
async function anmeldenAlle() {
  tokAdmin = await s.anmelden('GameGeeeeek');
  tokA = await s.anmelden('anna');
  tokB = await s.anmelden('ben');
  tokC = await s.anmelden('carl');
}
// Jede Aenderung an der DB-DATEI laeuft hier durch: stoppen (flusht), aendern, starten.
async function aendereDb(fn, schalterAn) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  s = await starteServer(schalterAn);
  await anmeldenAlle();
}
const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
const buchVon = (d, name) => (d.users[name] || {}).auftragsbuch || null;
// Der Spielstand liegt in ZWEI Formen vor: als blanke Zeichenkette oder als { value, version }.
const liesSave = (d, id) => {
  const roh = (d.private[id] || {})['kepler7-save-v3'];
  if (!roh) return null;
  try { return JSON.parse(typeof roh === 'string' ? roh : roh.value); } catch (e) { return null; }
};
const rewardsVon = (d, id) => ((d.private[id] || {}).__pendingRewards || []).filter(r => r && r.type === 'auftragsbuch');
// Angriff mit 429-Wartelogik (attackRateLimit ist Messaufbau, nicht Messgegenstand - wie in
// test_pvp_standorte_http.js).
async function angriff(token, zielId) {
  for (let i = 0; i < 3; i++) {
    const r = await s.j('/attack', { method: 'POST', headers: kopf(token), body: JSON.stringify({ targetUserId: zielId }) });
    if (r.status !== 429) return r;
    const wartezeit = (parseInt(r.headers.get('retry-after'), 10) || 61) + 1;
    console.log('     (429 vom attackRateLimit - warte ' + wartezeit + 's)');
    await warte(wartezeit * 1000);
  }
  return { status: 429, body: null };
}
const spielstandSchreiben = (token, save) => s.j('/storage/kepler7-save-v3', { method: 'PUT', headers: kopf(token), body: JSON.stringify({ value: JSON.stringify(save) }) });
const verkauf = token => s.j('/market/trade', { method: 'POST', headers: kopf(token), body: JSON.stringify({ action: 'sell', resource: 'erz', amount: 10 }) });
const buchHolen = token => s.j('/auftragsbuch', { headers: kopf(token) });
const abholen = token => s.j('/auftragsbuch/abholen', { method: 'POST', headers: kopf(token), body: '{}' });
const saisonJetzt = () => new Date().toISOString().slice(0, 7);

(async () => {
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  s = await starteServer(true);
  await anmeldenAlle();
  check('0: Admin und drei Spieler angemeldet', !!tokAdmin && !!tokA && !!tokB && !!tokC,
    { admin: !!tokAdmin, anna: !!tokA, ben: !!tokB, carl: !!tokC });
  if (!tokA || !tokB || !tokC) { console.log(s.protokoll().slice(-800)); console.log('\nFAIL'); process.exit(1); }

  // ==== 1: das leere Buch ======================================================================
  const leer = await buchHolen(tokA);
  const lb = leer.body || {};
  check('1a: GET liefert das Buch der laufenden Saison (Monat YYYY-MM in UTC)',
    leer.status === 200 && lb.aktiv === true && lb.saison === saisonJetzt() && lb.punkte === 0,
    { status: leer.status, saison: lb.saison, erwartet: saisonJetzt(), punkte: lb.punkte });
  check('1b: zwanzig Stufen mit steigenden Schwellen, keine erreicht, keine abgeholt',
    Array.isArray(lb.stufen) && lb.stufen.length === 20 && lb.stufen[0].ab === 25 && lb.stufen[19].ab === 2310 &&
    lb.stufen.every((st, i) => st.stufe === i + 1 && !st.erreicht && !st.abgeholt && (i === 0 || st.ab > lb.stufen[i - 1].ab)),
    { anzahl: (lb.stufen || []).length, erste: lb.stufen && lb.stufen[0], letzte: lb.stufen && lb.stufen[19] });
  check('1c: die vier Meilensteine tragen Staub und Fragmente, die Endstufe den Titel',
    !!lb.stufen && [5, 10, 15, 20].every(n => lb.stufen[n - 1].belohnung.staub > 0 && lb.stufen[n - 1].belohnung.fragmente > 0) &&
    lb.stufen[19].belohnung.titel === 'Chronist der Saison' && !lb.stufen[0].belohnung.staub,
    { s5: lb.stufen && lb.stufen[4].belohnung, s20: lb.stufen && lb.stufen[19].belohnung });
  check('1d: der Katalog nennt acht Taten mit Punkten, Tagesdeckel und heutigem Zaehler 0',
    Array.isArray(lb.katalog) && lb.katalog.length === 8 &&
    ['angriff', 'abwehr', 'festung', 'nest', 'konvoi', 'weltboss', 'vorposten', 'markt'].every(a => lb.katalog.some(k => k.art === a)) &&
    lb.katalog.every(k => k.punkte > 0 && k.tagesDeckel > 0 && k.heute === 0 && typeof k.name === 'string'),
    { arten: (lb.katalog || []).map(k => k.art) });
  const [j, m] = saisonJetzt().split('-').map(Number);
  check('1e: endetAm ist der erste Tag des Folgemonats, 00:00 UTC',
    lb.endetAm === Date.UTC(j, m, 1), { endetAm: lb.endetAm, erwartet: Date.UTC(j, m, 1) });

  // ==== 2: die Tat zaehlt - beide Ausgaenge, aber nur der gefuehrte Angriff ===================
  // Bis zum Sieg wiederholen (Anna ist gegen Ben uebermaechtig, aber der Kampf wuerfelt): Jeder
  // Versuch ist ein gefuehrter Angriff und zaehlt - bis zum Tagesdeckel 5. Erwartet wird deshalb
  // 10 * min(Versuche, 5), nicht eine feste Zahl.
  let versuche = 0, sieg = null;
  for (let i = 0; i < 6 && !sieg; i++) {
    const r = await angriff(tokA, BEN);
    versuche++;
    if (r.status === 200 && r.body && r.body.success === true) sieg = r;
    else if (r.status !== 200) { console.log('     Angriff ' + versuche + ': ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120)); break; }
  }
  check('2a: Anna hat Ben besiegt (der Server hat gewuerfelt)', !!sieg, { versuche });
  const erwartetAngriffe = Math.min(versuche, 5);
  const db2 = liesDb();
  const bA2 = buchVon(db2, 'anna') || {};
  check('2b: jeder gefuehrte Angriff zaehlt 10 Punkte am NUTZEROBJEKT - Sieg wie Niederlage',
    bA2.punkte === 10 * erwartetAngriffe && (bA2.taten || {}).angriff === erwartetAngriffe,
    { punkte: bA2.punkte, taten: bA2.taten, versuche });
  const get2 = await buchHolen(tokA);
  check('2c: und GET zeigt dieselben Punkte samt Tageszaehler',
    get2.status === 200 && get2.body.punkte === 10 * erwartetAngriffe &&
    (get2.body.katalog.find(k => k.art === 'angriff') || {}).heute === erwartetAngriffe,
    { punkte: get2.body && get2.body.punkte, heute: get2.body && (get2.body.katalog.find(k => k.art === 'angriff') || {}).heute });
  // Jede Niederlage Annas VOR dem Sieg war eine gelungene Abwehr Bens - die zaehlt ihm (8 je
  // Abwehr, Deckel 3). Der verlorene Kampf am Ende zaehlt ihm NICHT: erwartet sind genau
  // (Versuche - 1) Abwehr-Taten, gemessen am ersten Lauf (zwei Niederlagen, dann der Sieg).
  const bB2 = buchVon(db2, 'ben') || {};
  const abwehrenBen = Math.min(versuche - 1, 3);
  check('2d: der Verteidiger bekommt je abgewehrtem Angriff eine Abwehr-Tat - fuer den verlorenen Kampf keine',
    ((bB2.taten || {}).abwehr || 0) === abwehrenBen && (bB2.punkte || 0) === 8 * abwehrenBen,
    { ben: bB2.taten, punkte: bB2.punkte, erwartetAbwehren: abwehrenBen });

  // ==== 3: der Schild - kein Kampf, keine Tat ==================================================
  await aendereDb(d => { d.private[BEN].__attackShieldUntil = Date.now() + 3600000; });
  const punkteVor3 = (buchVon(liesDb(), 'anna') || {}).punkte;
  const schild = await angriff(tokA, BEN);
  check('3a: der Angriff prallt am Schild ab (403)', schild.status === 403 && /Schutzschild/.test(String(schild.body && schild.body.error)),
    { status: schild.status, body: schild.body });
  await warte(300);
  const bA3 = buchVon(liesDb(), 'anna') || {};
  check('3b: und zaehlt NICHT - kein Kampf, keine Tat', bA3.punkte === punkteVor3, { vorher: punkteVor3, nachher: bA3.punkte });

  // ==== 4: die Abwehr zaehlt dem Verteidiger ===================================================
  // Carl ist chancenlos (ein Jaeger gegen 200 Tuerme), aber der Kampf wuerfelt: Bei einem Sieg
  // Carls bekaeme Anna einen Schild, der muss dann weg. Bis zur Abwehr wiederholen.
  let abwehr = null, carlVersuche = 0;
  for (let i = 0; i < 8 && !abwehr; i++) {
    const r = await angriff(tokC, ANNA);
    carlVersuche++;
    if (r.status === 200 && r.body && r.body.success === false) abwehr = r;
    else if (r.status === 200) await aendereDb(d => { d.private[ANNA].__attackShieldUntil = 0; });
    else { console.log('     Carl ' + carlVersuche + ': ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120)); break; }
  }
  check('4a: Anna hat Carls Angriff abgewehrt (der Server hat gewuerfelt)', !!abwehr, { carlVersuche });
  const db4 = liesDb();
  const bA4 = buchVon(db4, 'anna') || {}, bC4 = buchVon(db4, 'carl') || {};
  check('4b: die Abwehr zaehlt dem VERTEIDIGER 8 Punkte - er konnte den Kampf weder ausloesen noch beeinflussen',
    (bA4.taten || {}).abwehr === 1 && bA4.punkte === punkteVor3 + 8, { punkte: bA4.punkte, taten: bA4.taten, vorher: punkteVor3 });
  check('4c: und dem Angreifer seinen gefuehrten Angriff', (bC4.taten || {}).angriff === Math.min(carlVersuche, 5) && bC4.punkte === 10 * Math.min(carlVersuche, 5),
    { carl: bC4 });

  // ==== 5: der Tagesdeckel (am Markt: Deckel 10, elf Verkaeufe) ================================
  const punkteVor5 = bA4.punkte;
  const verkaeufe = [];
  for (let i = 0; i < 11; i++) verkaeufe.push((await verkauf(tokA)).status);
  await warte(400);
  check('5a: alle elf Verkaeufe kamen zustande - der Deckel bremst die Tat, nicht den Handel',
    verkaeufe.every(st => st === 200), { verkaeufe });
  const get5 = await buchHolen(tokA);
  const markt5 = (get5.body.katalog || []).find(k => k.art === 'markt') || {};
  check('5b: gezaehlt wurden genau 10 (Deckel) - der elfte Handel bringt keine Punkte',
    get5.body.punkte === punkteVor5 + 20 && markt5.heute === 10 && (get5.body.taten || {}).markt === 10,
    { punkte: get5.body.punkte, erwartet: punkteVor5 + 20, heute: markt5.heute, taten: get5.body.taten });
  check('5c: der Katalog zeigt "heute 10 von 10"', markt5.heute === markt5.tagesDeckel, { heute: markt5.heute, deckel: markt5.tagesDeckel });

  // ==== 6: Abholen reiht genau einmal ein ======================================================
  const get6 = await buchHolen(tokA);
  const erreicht6 = (get6.body.stufen || []).filter(st => st.erreicht).map(st => st.stufe);
  check('6a: mit ' + get6.body.punkte + ' Punkten sind Stufen erreicht (mindestens Stufe 1 ab 25)',
    erreicht6.length >= 1 && erreicht6[0] === 1, { punkte: get6.body.punkte, erreicht: erreicht6 });
  const offenVor6 = rewardsVon(liesDb(), ANNA).length;
  const creditsVor6 = (liesSave(liesDb(), ANNA) || {}).credits;
  const hol1 = await abholen(tokA);
  await warte(400);
  check('6b: POST /abholen nennt genau die erreichten Stufen',
    hol1.status === 200 && hol1.body.ok === true && JSON.stringify(hol1.body.abgeholt) === JSON.stringify(erreicht6),
    { status: hol1.status, body: hol1.body, erreicht: erreicht6 });
  const hol2 = await abholen(tokA);
  await warte(400);
  check('6c: ein zweites Abholen findet nichts mehr', hol2.status === 200 && Array.isArray(hol2.body.abgeholt) && hol2.body.abgeholt.length === 0,
    { body: hol2.body });
  const rw6 = rewardsVon(liesDb(), ANNA);
  check('6d: in der Warteschlange liegt je Stufe GENAU EIN Eintrag vom Typ auftragsbuch - mit Saison, Stufe und Krediten',
    rw6.length === offenVor6 + erreicht6.length && erreicht6.every(n => rw6.filter(r => r.stufe === n).length === 1) &&
    rw6.every(r => r.saison === saisonJetzt() && r.credits > 0),
    { vorher: offenVor6, eintraege: rw6.map(r => ({ stufe: r.stufe, credits: r.credits, saison: r.saison })) });
  const get6b = await buchHolen(tokA);
  check('6e: GET zeigt die Stufen als abgeholt', erreicht6.every(n => (get6b.body.stufen[n - 1] || {}).abgeholt === true) &&
    get6b.body.stufen.filter(st => st.abgeholt).length === erreicht6.length,
    { abgeholt: get6b.body.stufen.filter(st => st.abgeholt).map(st => st.stufe) });
  check('6f: der Server hat den Spielstand beim Abholen nicht angefasst - Kredite bucht der Client aus dem Reward',
    typeof creditsVor6 === 'number' && (liesSave(liesDb(), ANNA) || {}).credits === creditsVor6,
    { vorher: creditsVor6, nachher: (liesSave(liesDb(), ANNA) || {}).credits });

  // ==== 7: der Saisonwechsel - lazy, vollstaendig, idempotent ==================================
  // Ein Buch aus einer laengst vergangenen Saison mit 300 Punkten (Stufen 1-6 erreicht), 1 und 2
  // schon abgeholt: Beim naechsten Kontakt muessen GENAU 3, 4, 5, 6 eingereiht werden, Stufe 5
  // bringt 5 Sternenstaub - und der steht danach am Konto, nicht nur im Reward.
  await aendereDb(d => {
    d.users.anna.auftragsbuch = { saison: '2024-01', punkte: 300, taten: { markt: 150 }, tag: { datum: '2024-01-31', zaehler: { markt: 3 } }, abgeholt: [1, 2] };
    d.users.anna.staub = { menge: 40, serie: 0, letzterTag: null, abwehrTag: null, abwehrVon: [], abwehrGesamt: 0 };
    d.private[ANNA].__pendingRewards = [];
  });
  const get7 = await buchHolen(tokA);
  await warte(400);
  const db7 = liesDb();
  const rw7 = rewardsVon(db7, ANNA);
  check('7a: der Wechsel reiht die erreichten, nicht abgeholten Stufen der ALTEN Saison ein (3, 4, 5, 6)',
    rw7.map(r => r.stufe).sort((a, b) => a - b).join(',') === '3,4,5,6' && rw7.every(r => r.saison === '2024-01'),
    { eintraege: rw7.map(r => ({ stufe: r.stufe, saison: r.saison })) });
  const s5 = rw7.find(r => r.stufe === 5) || {};
  check('7b: Stufe 5 traegt Staub und Fragmente - und der Staub ist SERVERSEITIG gebucht (40 + 5)',
    s5.staub === 5 && s5.fragmente === 2 && ((db7.users.anna.staub || {}).menge === 45),
    { reward: { staub: s5.staub, fragmente: s5.fragmente }, konto: (db7.users.anna.staub || {}).menge });
  check('7c: das Buch ist neu angelegt - laufende Saison, 0 Punkte, nichts abgeholt',
    get7.status === 200 && get7.body.saison === saisonJetzt() && get7.body.punkte === 0 && get7.body.stufen.every(st => !st.abgeholt),
    { saison: get7.body.saison, punkte: get7.body.punkte });
  await buchHolen(tokA); await abholen(tokA); await warte(400);
  check('7d: ein zweiter Kontakt reiht NICHTS erneut ein - idempotent', rewardsVon(liesDb(), ANNA).length === 4,
    { eintraege: rewardsVon(liesDb(), ANNA).length });

  // ==== 8: die Punkte liegen am Nutzer, nicht im Spielstand ====================================
  const gefaelscht = Object.assign(SAVES[ANNA](), { auftragsbuch: { saison: saisonJetzt(), punkte: 9999, abgeholt: [] } });
  const put8 = await spielstandSchreiben(tokA, gefaelscht);
  const get8 = await buchHolen(tokA);
  check('8a: ein Spielstand mit gefaelschtem `auftragsbuch` wird gespeichert (er gehoert dem Spieler) ...',
    put8.status === 200, { status: put8.status, body: put8.body });
  check('8b: ... aendert am Buch aber nichts - der Server liest es vom Nutzerobjekt',
    get8.status === 200 && get8.body.punkte === 0 && (buchVon(liesDb(), 'anna') || {}).punkte === 0,
    { get: get8.body.punkte, konto: (buchVon(liesDb(), 'anna') || {}).punkte });
  await verkauf(tokA); await warte(400);
  check('8c: und die naechste echte Tat zaehlt vom Kontostand aus weiter (0 + 2)',
    (buchVon(liesDb(), 'anna') || {}).punkte === 2, { punkte: (buchVon(liesDb(), 'anna') || {}).punkte });

  // ==== 9: der Schalter - im Code und als Notaus ===============================================
  await aendereDb(() => {}, false);
  const aus1 = await buchHolen(tokA), aus2 = await abholen(tokA);
  check('9a: Schalter aus -> GET 404 mit inaktiv:true (der Client blendet die Box dann aus)',
    aus1.status === 404 && aus1.body.inaktiv === true, { status: aus1.status, body: aus1.body });
  check('9b: und POST ebenso', aus2.status === 404 && aus2.body.inaktiv === true, { status: aus2.status, body: aus2.body });
  const punkteVor9 = (buchVon(liesDb(), 'anna') || {}).punkte;
  const v9 = await verkauf(tokA); await warte(400);
  check('9c: der Handel selbst laeuft weiter, zaehlt aber nicht', v9.status === 200 && (buchVon(liesDb(), 'anna') || {}).punkte === punkteVor9,
    { status: v9.status, vorher: punkteVor9, nachher: (buchVon(liesDb(), 'anna') || {}).punkte });
  await aendereDb(() => {}, true);
  const an9 = await buchHolen(tokA);
  check('9d: Schalter an -> die Route ist wieder da', an9.status === 200 && an9.body.aktiv === true, { status: an9.status });
  const liste = await s.j('/admin/schalter', { headers: kopf(tokAdmin) });
  check('9e: der Notaus `auftragsbuch` steht in der Admin-Liste', liste.status === 200 &&
    (liste.body.schalter || []).some(x => x.name === 'auftragsbuch' && x.wirksam === true), { status: liste.status, namen: (liste.body.schalter || []).map(x => x.name) });
  const notaus = await s.j('/admin/schalter', { method: 'POST', headers: kopf(tokAdmin), body: JSON.stringify({ name: 'auftragsbuch', aus: true, grund: 'Testlauf' }) });
  const aus3 = await buchHolen(tokA);
  check('9f: der Admin schaltet zur Laufzeit ab -> 404 wie beim Code-Schalter', notaus.status === 200 && aus3.status === 404 && aus3.body.inaktiv === true,
    { notaus: notaus.body, status: aus3.status });
  await s.j('/admin/schalter', { method: 'POST', headers: kopf(tokAdmin), body: JSON.stringify({ name: 'auftragsbuch', aus: false }) });
  const an10 = await buchHolen(tokA);
  check('9g: und wieder frei', an10.status === 200, { status: an10.status });
  await stoppeServer();

  // ---- Auswertung: Gruen-Lauf ODER Gegenprobe --------------------------------------------------
  if (SAB) {
    const soll = MUSS_FALLEN[SAB] || [];
    const gefallen = [...new Set(Object.keys(ergebnis).filter(n => ergebnis[n] === false).map(n => String(n).split(':')[0]))].sort();
    const fehlt = soll.filter(k => gefallen.indexOf(k) < 0);
    const zuviel = gefallen.filter(k => soll.indexOf(k) < 0);
    console.log('\nGegenprobe „' + SAB + '": gefallen ' + JSON.stringify(gefallen) + ', erwartet ' + JSON.stringify(soll));
    if (fehlt.length || zuviel.length) {
      console.log('FAIL - Gegenprobe: nicht gefallen ' + JSON.stringify(fehlt) + ', unerwartet gefallen ' + JSON.stringify(zuviel));
      process.exit(1);
    }
    console.log('PASS - Gegenprobe: genau die erwarteten Pruefungen sind gefallen.');
    process.exit(0);
  }
  console.log(fail ? '\nFAIL - mindestens eine Pruefung ist gefallen.' : '\nPASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('FAIL - Ausnahme: ' + (e && e.stack || e)); process.exit(1); });
