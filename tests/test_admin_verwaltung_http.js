// Vier weitere Admin-Faehigkeiten (02.09.2026, Auftrag Sascha "Ideen fuer noch mehr admin
// Funktionen jeglicher Art" - alle vier Vorschlaege gewaehlt): Protokoll aller Admin-Handlungen,
// Sperre mit Grund und Frist plus Stummschaltung, Spielstand-Blatt mit Backups und Ruecksicherung,
// Allianz-Uebersicht mit Anfuehrer-Uebertragung und Aufloesung.
//
// DIE KERNMESSUNGEN SIND PAARE (Arbeitsregel 61):
//   1a/1b  eine gelungene Admin-Handlung steht im Protokoll UND ein abgewiesener Versuch nicht
//   2a/2c  eine befristete Sperre sperrt UND laeuft von selbst ab
//   3a/3b  der Stummgeschaltete kann nicht schreiben UND ein anderer kann es weiterhin
//   4d/4e  die Ruecksicherung setzt den Stand UND entwertet die Sitzung (sonst schriebe der
//          laufende Client seinen alten Stand binnen zehn Sekunden zurueck)
//   5b/5c  der Anfuehrer geht an ein Mitglied UND nicht an einen Fremden
//
// 4d MISST PERSISTENZ MIT SIGKILL (Arbeitsregel 78) - die Ruecksicherung muss selbst speichern.
//
// GEGENPROBEN (sabotierte Kopien ueber KEPLER_SERVER_JS, 33 Pruefungen in beide Richtungen,
// Prueflisten per diff identisch; Pflichtlisten NACH der Messung):
//   Protokoll-Middleware nicht registriert     -> 1a, 1c, 1d, 5g
//   Frist laeuft nie ab                        -> 2c, 3a, 3c, 3e  (ben bleibt gesperrt, der Chat faellt
//                                                 dann aus dem ANDEREN Grund - die Sperre, nicht die Stummschaltung)
//   Stummschaltung nicht am globalen Chat      -> 3a
//   Ruecksicherung ohne Sitzungsentwertung     -> 4e, 5g
//   Ruecksicherung ohne Schatten               -> 4d, 4f, 5g
//   Dateinamen-Muster nicht geprueft           -> 4g
//   Aufloesen laesst die Rollen stehen         -> 5d, 5e
//
// PORT 3244: gemessen belegt sind im Backend 3195-3242, und 3243 nimmt test_sitzungscookie_front
// im FRONTEND-Repo fuer den Server, den es selbst startet (`grep -hoE "3[12][0-9][0-9]"
// tests/*.js | sort -un` in BEIDEN Repos) - ein neuer Test nimmt 3245.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3244);

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ADMIN = crypto.randomUUID(), ANNA = crypto.randomUUID(), BEN = crypto.randomUUID(), CARL = crypto.randomUUID(), FRITZ = crypto.randomUUID();

function spielstand(id, name, extra) {
  return Object.assign({
    resources: { energie: 1e5, erz: 1e5, kristalle: 1e5, deuterium: 1e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: { mine: 7, solar: 5 }, research: { energietechnik: 2 }, colonies: {}, fleet: { jaeger: 12, missions: [] },
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  }, extra || {});
}
const rolle = (id, name, role) => JSON.stringify({ playerId: id, name, role, joinedAt: 1756000000000 });
function grunddb() {
  const jetzt = Date.now();
  return {
    users: {
      gamegeeeeek: { userId: ADMIN, username: 'GameGeeeeek', passwordHash: hash, createdAt: jetzt },
      anna:  { userId: ANNA,  username: 'anna',  passwordHash: hash, createdAt: jetzt },
      ben:   { userId: BEN,   username: 'ben',   passwordHash: hash, createdAt: jetzt },
      carl:  { userId: CARL,  username: 'carl',  passwordHash: hash, createdAt: jetzt },
      fritz: { userId: FRITZ, username: 'fritz', passwordHash: hash, createdAt: jetzt }
    },
    private: {
      [ADMIN]: { 'kepler7-save-v3': JSON.stringify(spielstand(ADMIN, 'GameGeeeeek')) },
      [ANNA]:  { 'kepler7-save-v3': JSON.stringify(spielstand(ANNA, 'anna')) },
      [BEN]:   { 'kepler7-save-v3': JSON.stringify(spielstand(BEN, 'ben')) },
      [CARL]:  { 'kepler7-save-v3': JSON.stringify(spielstand(CARL, 'carl')) },
      [FRITZ]: { 'kepler7-save-v3': JSON.stringify(spielstand(FRITZ, 'fritz')) }
    },
    shared: {
      'alliance:T1:info': JSON.stringify({ tag: 'T1', name: 'Erste', creatorId: BEN, creatorName: 'ben', createdAt: 1755000000000, joinMode: 'open' }),
      ['alliance:T1:role:' + BEN]: rolle(BEN, 'ben', 'admin'),
      ['alliance:T1:role:' + ANNA]: rolle(ANNA, 'anna', 'member'),
      ['alliance:T1:role:' + CARL]: rolle(CARL, 'carl', 'officer'),
      'alliance:T1:base': JSON.stringify({ level: 3 }),
      'alliance:T1:applications:x1': JSON.stringify({ status: 'pending', playerId: FRITZ }),
      'alliance:T2:info': JSON.stringify({ tag: 'T2', creatorId: FRITZ, creatorName: 'fritz', createdAt: 1754000000000, joinMode: 'open', disbanded: true, disbandedAt: 1755500000000 }),
      ['alliance:T2:role:' + FRITZ]: rolle(FRITZ, 'fritz', 'left')
    },
    resetTokens: {}, feedback: [],
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: jetzt, factions: {},
      alienPause: { kryll: jetzt + 9e8, xantheer: jetzt + 9e8, vex: jetzt + 9e8, verglueht: jetzt + 9e8 },
      alienNester: [] }
  };
}

// DB und Backups in einem eigenen Verzeichnis - BACKUP_DIR liegt neben DB_FILE.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-verw-'));
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
  await warte(300);
  async function j(pfad, opt) {
    const r = await fetch(basis + pfad, opt);
    const t = await r.text();
    try { return { status: r.status, body: JSON.parse(t) }; }
    catch (e) { return { status: r.status, body: t.slice(0, 300) }; }
  }
  async function anmelden(name) {
    const r = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name, password: 'test1234' }) });
    return { token: r.body && r.body.token, status: r.status, error: r.body && r.body.error };
  }
  return { j, anmelden, protokoll: () => log };
}
async function alleAnmelden() {
  tok = {};
  for (const n of ['GameGeeeeek', 'anna', 'ben', 'carl', 'fritz']) tok[n] = (await s.anmelden(n)).token;
}
async function stoppeServer() { if (!srv) return; srv.kill('SIGTERM'); await warte(700); srv = null; }
async function stoppeHart() { if (!srv) return; srv.kill('SIGKILL'); await warte(400); srv = null; }
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  s = await starteServer();
  await alleAnmelden();
}
const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
const admin = (pfad, body, methode) => s.j(pfad, { method: methode || 'POST', headers: kopf(tok.GameGeeeeek), body: body === undefined ? undefined : JSON.stringify(body) });
const blatt = async name => { const b = (await s.j('/admin/konto?name=' + name, { headers: kopf(tok.GameGeeeeek) })).body; return (b.konten || []).find(k => k.username === name) || {}; };
const chat = (t, key, text) => s.j('/storage/' + encodeURIComponent(key) + '?shared=true', { method: 'PUT', headers: kopf(t),
  body: JSON.stringify({ value: JSON.stringify({ authorId: t === tok.ben ? BEN : ANNA, authorName: 'x', text, ts: Date.now() }) }) });
const protokoll = async () => ((await s.j('/admin/protokoll', { headers: kopf(tok.GameGeeeeek) })).body || {}).eintraege || [];
const credits = z => z && z.zusammenfassung ? z.zusammenfassung.credits : null;

(async () => {
  schreibDb(grunddb());
  s = await starteServer();
  await alleAnmelden();
  check('0-vorab: alle Konten angemeldet', ['GameGeeeeek', 'anna', 'ben', 'carl', 'fritz'].every(n => !!tok[n]),
    Object.fromEntries(Object.entries(tok).map(([k, v]) => [k, !!v])));
  if (!tok.anna) { console.log(s.protokoll().slice(-1500)); process.exit(1); }
  const quelle = fs.readFileSync(process.env.KEPLER_SERVER_JS || path.join(WURZEL, 'server.js'), 'utf8');

  // ---- 1) Das Protokoll ------------------------------------------------------------------------
  const p0 = await protokoll();
  const r1 = await admin('/admin/set-banned', { targetUsername: 'fritz', banned: true, grund: 'Testsperre', tage: 0 });
  const p1 = await protokoll();
  const e1 = p1[0] || {};
  check('1a: eine gelungene Admin-Handlung steht im Protokoll - Art, Wer, Ziel, Details',
    r1.status === 200 && p1.length === p0.length + 1 && e1.art === 'set-banned' && e1.von === 'GameGeeeeek' && e1.ziel === 'fritz' &&
    e1.details && e1.details.banned === true && e1.details.grund === 'Testsperre' && e1.zeit > 0,
    { status: r1.status, eintrag: e1 });
  const r1b = await s.j('/admin/set-banned', { method: 'POST', headers: kopf(tok.anna), body: JSON.stringify({ targetUsername: 'ben', banned: true }) });
  const p1b = await protokoll();
  check('1b: ein abgewiesener Versuch (kein Admin, 403) steht NICHT im Protokoll (PAAR)', r1b.status === 403 && p1b.length === p1.length,
    { status: r1b.status, vorher: p1.length, nachher: p1b.length });
  const r1c = await admin('/admin/set-banned', { targetUsername: 'gibtesnicht', banned: true });
  const p1c = await protokoll();
  check('1b2: auch ein Fehlschlag des Admins (404) ist keine Handlung', r1c.status === 404 && p1c.length === p1.length, { status: r1c.status });
  const mwStelle = quelle.indexOf("app.use('/api/admin', adminProtokollMiddleware)");
  const ersteRoute = quelle.indexOf("app.post('/api/admin/");
  const anzahlPosts = (quelle.match(/app\.post\('\/api\/admin\//g) || []).length;
  check('1c: die Middleware ist VOR jeder der Admin-POST-Routen registriert (sonst sieht sie keine Antwort)',
    mwStelle > 0 && ersteRoute > mwStelle && anzahlPosts >= 15, { middleware: mwStelle, ersteRoute, posts: anzahlPosts });
  await admin('/admin/set-banned', { targetUsername: 'fritz', banned: false });
  await stoppeHart();
  const dbP = liesDb();
  check('1d: das Protokoll ueberlebt einen HARTEN Stopp (die Middleware speichert selbst)',
    Array.isArray(dbP.adminProtokoll) && dbP.adminProtokoll.length >= 2 && dbP.adminProtokoll[0].art === 'set-banned' && dbP.adminProtokoll[0].details.banned === false,
    { inDatei: (dbP.adminProtokoll || []).slice(0, 2).map(e => [e.art, e.ziel]) });
  s = await starteServer(); await alleAnmelden();

  // ---- 2) Sperre mit Grund und Frist --------------------------------------------------------------
  const r2 = await admin('/admin/set-banned', { targetUsername: 'ben', banned: true, grund: 'Spam im Chat', tage: 1 });
  const l2 = await s.anmelden('ben');
  const b2 = await blatt('ben');
  check('2a: die befristete Sperre sperrt, und der Anmeldetext nennt Grund UND Frist',
    r2.status === 200 && r2.body.bannBis > Date.now() && l2.status === 403 && /Spam im Chat/.test(String(l2.error)) && /bis /.test(String(l2.error)),
    { antwort: r2.body, login: l2 });
  check('2a2: das Konto-Blatt fuehrt Grund, Frist und Beginn', b2.gesperrt === true && b2.sperre && b2.sperre.grund === 'Spam im Chat' && b2.sperre.bis > 0 && b2.sperre.seit > 0, b2.sperre);
  const r2e = await s.j('/me', { headers: kopf(tok.ben) });
  check('2e: auch ein bestehendes Token wird sofort abgewiesen - mit demselben Text', r2e.status === 403 && /Spam im Chat/.test(String(r2e.body && r2e.body.error)), r2e.body);
  const r2b = await admin('/admin/set-banned', { targetUsername: 'carl', banned: true, grund: '', tage: 0 });
  const l2b = await s.anmelden('carl');
  check('2b: unbefristet ohne Grund: Text ohne "bis" und ohne "Grund"', r2b.status === 200 && r2b.body.bannBis === 0 && l2b.status === 403 && !/bis /.test(String(l2b.error)) && !/Grund/.test(String(l2b.error)), l2b);
  await admin('/admin/set-banned', { targetUsername: 'carl', banned: false });
  // 2c: die Frist laeuft ab - zurueckdatiert in der DB, dann Anmeldung.
  await aendereDb(d => { d.users.ben.bannBis = Date.now() - 1000; });
  const l2c = await s.anmelden('ben');
  const b2c = await blatt('ben');
  await stoppeServer(); const dbc = liesDb(); s = await starteServer(); await alleAnmelden();
  check('2c: nach Ablauf der Frist meldet ben sich an, die Sperre ist aufgehoben und gespeichert (PAAR zu 2a)',
    l2c.status === 200 && !!l2c.token && b2c.gesperrt === false && b2c.sperre === null && dbc.users.ben.banned === false && dbc.users.ben.bannAbgelaufen > 0,
    { login: l2c.status, blatt: [b2c.gesperrt, b2c.sperre], datei: [dbc.users.ben.banned, !!dbc.users.ben.bannAbgelaufen] });
  const r2d = await admin('/admin/set-banned', { targetUsername: 'GameGeeeeek', banned: true });
  check('2d: das Betreiberkonto laesst sich nicht selbst sperren', r2d.status === 400, r2d.body);

  // ---- 3) Stummschaltung -------------------------------------------------------------------------
  const r3 = await admin('/admin/stumm', { targetUsername: 'ben', stunden: 2, grund: 'Beleidigung' });
  const c3 = await chat(tok.ben, 'globalchat:msg:t1', 'hallo');
  const a3 = await chat(tok.ben, 'alliance:T1:msg:t1', 'hallo allianz');
  const m3 = await s.j('/messages', { method: 'POST', headers: kopf(tok.ben), body: JSON.stringify({ toUserId: ANNA, text: 'psst' }) });
  check('3a: der Stummgeschaltete kann weder im globalen Chat noch im Allianz-Chat noch per Nachricht schreiben - jeweils mit Frist und Grund',
    r3.status === 200 && [c3, a3, m3].every(r => r.status === 403 && /stummgeschaltet/.test(String(r.body && r.body.error)) && /Beleidigung/.test(String(r.body && r.body.error))),
    { chat: [c3.status, c3.body], allianz: [a3.status], nachricht: [m3.status] });
  const c3b = await chat(tok.anna, 'globalchat:msg:t2', 'hallo von anna');
  const a3b = await chat(tok.anna, 'alliance:T1:msg:t2', 'hallo allianz von anna');
  check('3b: ein anderes Mitglied kann weiterhin schreiben (PAAR)', c3b.status === 200 && a3b.status === 200, { chat: c3b.status, allianz: a3b.status });
  const g3 = await s.j('/storage/' + encodeURIComponent('globalchat:msg:t2') + '?shared=true', { headers: kopf(tok.ben) });
  check('3e: Lesen bleibt dem Stummgeschalteten erlaubt', g3.status === 200, g3.status);
  const b3 = await blatt('ben');
  check('3d: das Konto-Blatt zeigt die Stummschaltung mit Frist und Grund', b3.stumm && b3.stumm.bis > Date.now() && b3.stumm.grund === 'Beleidigung', b3.stumm);
  await admin('/admin/stumm', { targetUsername: 'ben', stunden: 0 });
  const c3c = await chat(tok.ben, 'globalchat:msg:t3', 'wieder da');
  check('3c: stunden 0 hebt die Stummschaltung auf', c3c.status === 200, c3c.status);

  // ---- 4) Spielstand-Blatt, Backups, Ruecksicherung -----------------------------------------------
  const z4 = (await s.j('/admin/spielstand?name=anna', { headers: kopf(tok.GameGeeeeek) })).body;
  check('4a: das Blatt fasst den Spielstand zusammen - Kredite, Ressourcen, Gebaeude, Forschung, Flotte',
    z4.vorhanden === true && credits(z4) === 1000 && z4.zusammenfassung.ressourcen.erz === 1e5 && z4.zusammenfassung.gebaeude.mine === 7 &&
    z4.zusammenfassung.forschung.energietechnik === 2 && z4.zusammenfassung.flotte.jaeger === 12 && z4.zusammenfassung.spielerName === 'anna' && z4.schatten === null,
    z4.zusammenfassung);
  const l4 = (await s.j('/admin/backups', { headers: kopf(tok.GameGeeeeek) })).body;
  const r4b = await admin('/admin/backup-jetzt', {});
  const l4b = (await s.j('/admin/backups', { headers: kopf(tok.GameGeeeeek) })).body;
  check('4b: "Backup jetzt" legt eine weitere Sicherung an, die Liste fuehrt sie zuoberst',
    r4b.status === 200 && r4b.body.neuestes && /^db-.*\.json$/.test(r4b.body.neuestes.datei) && l4b.backups.length === l4.backups.length + 1 && l4b.backups[0].datei === r4b.body.neuestes.datei && l4b.backups[0].groesse > 1000,
    { vorher: l4.backups.length, nachher: l4b.backups.length, neuestes: r4b.body.neuestes });
  const datei = r4b.body.neuestes.datei;
  // anna spielt weiter: 5000 Kredite. Das Backup traegt noch 1000.
  const save4 = await s.j('/storage/kepler7-save-v3', { method: 'PUT', headers: kopf(tok.anna), body: JSON.stringify({ value: JSON.stringify(spielstand(ANNA, 'anna', { credits: 5000 })) }) });
  const z4c = (await s.j('/admin/backup-spielstand?name=anna&datei=' + encodeURIComponent(datei), { headers: kopf(tok.GameGeeeeek) })).body;
  const z4c2 = (await s.j('/admin/spielstand?name=anna', { headers: kopf(tok.GameGeeeeek) })).body;
  check('4c: der Stand aus dem Backup laesst sich VOR dem Zurueckholen ansehen - 1000 dort, 5000 heute',
    save4.status === 200 && z4c.vorhanden === true && credits(z4c) === 1000 && credits(z4c2) === 5000 && z4c.zeit > 0, { backup: credits(z4c), heute: credits(z4c2) });
  const altesToken = tok.anna;
  const r4d = await admin('/admin/spielstand-zurueckholen', { targetUsername: 'anna', datei });
  await stoppeHart();
  const db4 = liesDb();
  const eintrag4 = db4.private[ANNA]['kepler7-save-v3'];
  const wert4 = typeof eintrag4 === 'string' ? eintrag4 : eintrag4.value;
  const schatten4 = db4.private[ANNA].__spielstandSchatten;
  check('4d: die Ruecksicherung setzt den Backup-Stand (1000) und bewahrt den bisherigen (5000) als Schatten - auch nach HARTEM Stopp',
    r4d.status === 200 && r4d.body.schattenDa === true && JSON.parse(wert4).credits === 1000 && schatten4 && JSON.parse(schatten4.value).credits === 5000 && eintrag4.version >= 1,
    { antwort: r4d.body && [r4d.body.version, credits(r4d.body)], datei: [JSON.parse(wert4).credits, schatten4 && JSON.parse(schatten4.value).credits] });
  s = await starteServer(); tok.GameGeeeeek = (await s.anmelden('GameGeeeeek')).token;
  const me4 = await s.j('/me', { headers: kopf(altesToken) });
  check('4e: die bisherige Sitzung von anna ist entwertet (401) - ihr laufender Client kann den alten Stand nicht zurueckschreiben (PAAR zu 4d)',
    me4.status === 401 && db4.users.anna.tokenVersion === 1, { status: me4.status, tokenVersion: db4.users.anna.tokenVersion });
  tok.anna = (await s.anmelden('anna')).token;
  const g4 = await s.j('/storage/kepler7-save-v3', { headers: kopf(tok.anna) });
  check('4e2: nach neuer Anmeldung laedt anna den zurueckgeholten Stand', g4.status === 200 && JSON.parse(g4.body.value).credits === 1000, { credits: g4.body && g4.body.value && JSON.parse(g4.body.value).credits });
  const r4f = await admin('/admin/spielstand-schatten-zurueck', { targetUsername: 'anna' });
  const z4f = (await s.j('/admin/spielstand?name=anna', { headers: kopf(tok.GameGeeeeek) })).body;
  check('4f: Rueckgaengig setzt den Schatten wieder ein (5000) und behaelt 1000 als neuen Schatten',
    r4f.status === 200 && credits(z4f) === 5000 && z4f.schatten && z4f.schatten.zusammenfassung.credits === 1000, { heute: credits(z4f), schatten: z4f.schatten && z4f.schatten.zusammenfassung.credits });
  const r4g = await s.j('/admin/backup-spielstand?name=anna&datei=' + encodeURIComponent('../db.json'), { headers: kopf(tok.GameGeeeeek) });
  const r4g2 = await admin('/admin/spielstand-zurueckholen', { targetUsername: 'anna', datei: 'db-gibtesnicht.json' });
  check('4g: ein Dateiname ausserhalb des Musters oder ohne Datei wird abgewiesen (400), nichts geschrieben',
    r4g.status === 400 && r4g2.status === 400, { muster: r4g.status, fehlend: r4g2.status });
  // Auch das Rueckgaengig entwertet die Sitzungen - anna meldet sich fuer 4h neu an (der erste
  // Entwurf dieser Pruefung bekam hier 401 statt 403 und mass damit die Sitzungsentwertung, nicht
  // die Admin-Grenze).
  tok.anna = (await s.anmelden('anna')).token;
  const r4h = await s.j('/admin/spielstand?name=anna', { headers: kopf(tok.anna) });
  check('4h: ohne Admin 403', r4h.status === 403, r4h.status);

  // ---- 5) Allianzen ------------------------------------------------------------------------------
  await alleAnmelden();
  const a5 = (await s.j('/admin/allianzen', { headers: kopf(tok.GameGeeeeek) })).body;
  const t1 = (a5.allianzen || []).find(a => a.tag === 'T1') || {};
  const t2 = (a5.allianzen || []).find(a => a.tag === 'T2') || {};
  check('5a: die Uebersicht kennt beide Allianzen - T1 mit drei Mitgliedern (Anfuehrer zuerst), Basisstufe, offener Bewerbung; T2 aufgeloest',
    a5.gesamt === 2 && a5.aktiv === 1 && t1.mitglieder && t1.mitglieder.length === 3 && t1.mitglieder[0].name === 'ben' && t1.mitglieder[0].rolle === 'admin' &&
    t1.basisStufe === 3 && t1.bewerbungen === 1 && t1.aufgeloest === false && t2.aufgeloest === true && (t2.mitglieder || []).length === 0,
    { t1: t1.mitglieder && t1.mitglieder.map(m => [m.name, m.rolle]), basis: t1.basisStufe, bewerbungen: t1.bewerbungen, t2: t2.aufgeloest });
  const r5b = await admin('/admin/allianz/anfuehrer', { tag: 'T1', targetUsername: 'anna' });
  const a5b = (await s.j('/admin/allianzen', { headers: kopf(tok.GameGeeeeek) })).body;
  const t1b = (a5b.allianzen || []).find(a => a.tag === 'T1') || {};
  const rollen5b = Object.fromEntries((t1b.mitglieder || []).map(m => [m.name, m.rolle]));
  check('5b: der Anfuehrer geht an anna, ben wird Offizier, carl bleibt Offizier',
    r5b.status === 200 && r5b.body.herabgestuft === 1 && rollen5b.anna === 'admin' && rollen5b.ben === 'officer' && rollen5b.carl === 'officer', rollen5b);
  const r5c = await admin('/admin/allianz/anfuehrer', { tag: 'T1', targetUsername: 'fritz' });
  const r5c2 = await admin('/admin/allianz/anfuehrer', { tag: 'T9', targetUsername: 'anna' });
  check('5c: ein Fremder wird nicht Anfuehrer (400), eine unbekannte Allianz gibt 404 (PAAR zu 5b)', r5c.status === 400 && r5c2.status === 404, { fremd: r5c.status, unbekannt: r5c2.status });
  const r5d = await admin('/admin/allianz/aufloesen', { tag: 'T1' });
  const r5d2 = await admin('/admin/allianz/aufloesen', { tag: 'T1' });
  await stoppeServer(); const db5 = liesDb(); s = await starteServer(); await alleAnmelden();
  const info5 = JSON.parse(db5.shared['alliance:T1:info']);
  const rollen5 = ['anna', 'ben', 'carl'].map(n => JSON.parse(db5.shared['alliance:T1:role:' + { anna: ANNA, ben: BEN, carl: CARL }[n]]).role);
  check('5d: Aufloesen setzt info.disbanded und ALLE aktiven Rollen auf left - genau wie das Aufloesen durch den Anfuehrer; ein zweites Mal gibt 409',
    r5d.status === 200 && r5d.body.entfernt === 3 && info5.disbanded === true && info5.disbandedByAdmin === true && rollen5.every(r => r === 'left') && r5d2.status === 409,
    { antwort: r5d.body, rollen: rollen5, zweitesMal: r5d2.status });
  const a5e = (await s.j('/admin/allianzen', { headers: kopf(tok.GameGeeeeek) })).body;
  const t1e = (a5e.allianzen || []).find(a => a.tag === 'T1') || {};
  check('5e: die Uebersicht zeigt T1 danach als aufgeloest und ohne Mitglieder', t1e.aufgeloest === true && (t1e.mitglieder || []).length === 0 && a5e.aktiv === 0, { aufgeloest: t1e.aufgeloest, mitglieder: (t1e.mitglieder || []).length });
  // 5f: der Tag ist wieder frei - dieselbe Neugruendungs-Regel wie nach einer Spieler-Aufloesung.
  const r5f = await s.j('/storage/' + encodeURIComponent('alliance:T1:info') + '?shared=true', { method: 'PUT', headers: kopf(tok.fritz),
    body: JSON.stringify({ value: JSON.stringify({ tag: 'T1', creatorId: FRITZ, creatorName: 'fritz', createdAt: Date.now(), joinMode: 'open' }) }) });
  check('5f: der Tag ist danach fuer eine Neugruendung frei', r5f.status === 200, r5f.status);
  const p5 = await protokoll();
  check('5g: alle neuen Handlungen stehen im Protokoll (stumm, backup-jetzt, zurueckholen, anfuehrer, aufloesen)',
    ['stumm', 'backup-jetzt', 'spielstand-zurueckholen', 'spielstand-schatten-zurueck', 'allianz/anfuehrer', 'allianz/aufloesen'].every(a => p5.some(e => e.art === a)),
    { arten: [...new Set(p5.map(e => e.art))] });

  await stoppeServer();
  console.log(fail ? '\nFAIL - es gab rote Pruefungen.' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ABBRUCH:', e); try { console.log(s && s.protokoll().slice(-1500)); } catch (x) {} process.exit(1); });
