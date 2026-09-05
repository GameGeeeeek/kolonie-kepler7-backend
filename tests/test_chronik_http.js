// Galaxie-Chronik, Etappe C1 (05.09.2026): das Ereignisbuch in db.galaxy.chronik.
//
// Konzept: gamegeeeeek-ai-core/docs/AI-HUB-ROADMAP.md, Superprojekt 3. Gemessen wird der
// Roadmap-Waechter ("ein Weltboss-Sieg erzeugt genau einen Eintrag, ein Client kann keinen
// schreiben") plus das, was am Deckel und an den Routen kaputtgehen KANN:
//   1  Weltboss-Fall -> genau EIN Eintrag mit Stufe, bestem Beitrag und Anteil; /api/health zaehlt ihn.
//   2  Ein Client schreibt NICHT ins Buch: PUT /api/storage/chronik?shared=true landet in db.shared,
//      das Buch bleibt; die Admin-Route verlangt den Admin.
//   3  Allianz-Gruendung -> ein Eintrag, Name durch die 40-Zeichen-Whitelist; ein zweites Schreiben
//      desselben info-Schluessels ist keine Gruendung.
//   4  Abhol-Route fuer den M715q: 401 ohne/mit falschem Token (mit Laenge), 200 mit richtigem,
//      und `tage` filtert.
//   5  Der Deckel (500) kuerzt nur ALTE Eintraege - juengere als acht Tage bleiben auch ueber 500.
//   6  Ohne BACKUP_PULL_TOKEN gibt es die Abholung nicht (503, fail-closed).
//
// GEGENPROBE (05.09.2026, Pruefnamen per diff, Kopie der alten server.js IM Repo-Verzeichnis - nur
// dort loest require('./mailer') auf): Am Stand vor C1 (server.js 4e87e01) fallen 1a, 1b, 1c, 2a,
// 2b (404 statt 403 - die Route fehlt), 3a, 3b, 3c, 4a, 4b, 4c, danach bricht der Lauf ab, weil die
// DB kein Buch hat, in das Abschnitt 4d schreiben koennte. Ohne das Schutzfenster im Deckel
// (CHRONIK_SCHUTZ_MS = 0) faellt genau 5c.
//
// Port 3262 (belegt bis 3261, gemessen mit `grep -hoE "3[12][0-9][0-9]" tests/*.js | sort -un`).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');

const WURZEL = path.resolve(__dirname, '..');
const QUELLE = process.env.KEPLER_BACKEND_SERVER || path.join(WURZEL, 'server.js');
const PORT = Number(process.env.TEST_PORT || 3262);
const TOKEN = 'abholtoken-chronik-test';
let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));
const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const hash = bcrypt.hashSync('test1234', 10);
const ANNA = crypto.randomUUID(), BEN = crypto.randomUUID(), ADMIN = crypto.randomUUID();
const BOSS_ID = 'wb-chronik';
const jetzt = Date.now();

function spielstand(uid, name, missionen) {
  return JSON.stringify({
    resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {},
    fleet: { jaeger: 5000, cruisers: 2000, missions: missionen || [] },
    player: { id: uid, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: jetzt,
    worldBossLastAttack: 0
  });
}
const weltbossMission = { id: 'wbm1', type: 'worldboss', targetId: BOSS_ID, bossLevel: 3,
  startTime: jetzt - 20 * 60000, endTime: jetzt - 60000, composition: { jaeger: 5000, cruisers: 2000 } };
function grunddb() {
  return {
    users: {
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, emailVerified: true, createdAt: jetzt },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, emailVerified: true, createdAt: jetzt },
      gamegeeeeek: { userId: ADMIN, username: 'gamegeeeeek', passwordHash: hash, emailVerified: true, createdAt: jetzt }
    },
    private: { [ANNA]: { 'kepler7-save-v3': spielstand(ANNA, 'Anna', [weltbossMission]) }, [BEN]: { 'kepler7-save-v3': spielstand(BEN, 'Ben') } },
    // Ein Boss mit 1000 HP - 5000 Jaeger erlegen ihn im ersten Schlag.
    shared: { 'worldboss:current': JSON.stringify({ bossId: BOSS_ID, level: 3, maxHp: 1000, hp: 1000, spawnedAt: jetzt - 3600000, contributions: {}, defeatedAt: null }) },
    resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {}, news: [], activeWar: null, activeWormhole: null, lastTick: jetzt, factions: {} }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-chronik-' + process.pid + '.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-chronik-'));
let srv = null;
function aufraeumen() { try { if (srv) srv.kill(); } catch (e) {} try { fs.unlinkSync(dbPfad); } catch (e) {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} }
process.on('exit', aufraeumen);

async function starteServer(mitToken) {
  const env = Object.assign({}, process.env, {
    DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret',
    JWT_SECRET_FILE: path.join(tmpDir, 'jwt.txt'),
    VAPID_PUBLIC_FILE: path.join(tmpDir, 'vapid-pub.txt'), VAPID_PRIVATE_FILE: path.join(tmpDir, 'vapid-priv.txt'),
    AI_CORE_URL: 'http://127.0.0.1:9'
  });
  if (mitToken) env.BACKUP_PULL_TOKEN = TOKEN; else delete env.BACKUP_PULL_TOKEN;
  srv = spawn(process.execPath, [QUELLE], { cwd: WURZEL, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; });
  const basis = 'http://127.0.0.1:' + PORT + '/api';
  for (let i = 0; i < 80; i++) { try { const r = await fetch(basis + '/health'); if (r.ok) break; } catch (e) {} await warte(250); }
  async function j(pfad, opt) {
    const r = await fetch(basis + pfad, opt);
    const t = await r.text();
    try { return { status: r.status, body: JSON.parse(t) }; } catch (e) { return { status: r.status, body: t.slice(0, 300) }; }
  }
  async function anmelden(name) {
    const r = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'test1234' }) });
    return r.body && r.body.token;
  }
  const auth = tok => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok });
  return { j, anmelden, auth, protokoll: () => log };
}
async function stoppeServer() { if (!srv) return; srv.kill('SIGTERM'); await warte(800); srv = null; }
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));

(async () => {
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  let api = await starteServer(true);
  const anna = await api.anmelden('anna');
  const ben = await api.anmelden('ben');
  const admin = await api.anmelden('gamegeeeeek');
  check('0-vorab: drei Konten angemeldet', !!anna && !!ben && !!admin);
  const chronik = async (tok, tage) => api.j('/admin/chronik' + (tage ? '?tage=' + tage : ''), { headers: api.auth(tok) });

  // ---- 1: der Weltboss-Fall ---------------------------------------------------------------
  {
    const r = await api.j('/worldboss/resolve', { method: 'POST', headers: api.auth(anna), body: JSON.stringify({ missionId: 'wbm1', planetKey: 'home' }) });
    check('1-vorab: der Schlag wird gewertet und erlegt den Boss', r.status === 200 && r.body && r.body.ok === true && r.body.killed === true, { status: r.status, body: r.body && { ok: r.body.ok, killed: r.body.killed, error: r.body.error } });
    const c = await chronik(admin);
    const eintraege = ((c.body && c.body.eintraege) || []).filter(e => e.art === 'weltboss-gefallen');
    check('1a: genau EIN Eintrag weltboss-gefallen', c.status === 200 && eintraege.length === 1, { status: c.status, anzahl: eintraege.length });
    const e = eintraege[0] || {};
    check('1b: mit Stufe, bestem Beitrag, Anteil und Teilnehmern - feste Felder, kein Freitext',
      e.stufe === 3 && e.bester === 'anna' && e.anteil === 100 && e.teilnehmer === 1 && typeof e.zeit === 'number' && !('text' in e), e);
    const h = await api.j('/health');
    check('1c: /api/health zaehlt das Buch (eintraege, woche, letzterEintrag)',
      h.body && h.body.chronik && h.body.chronik.eintraege === 1 && h.body.chronik.woche === 1 && typeof h.body.chronik.letzterEintrag === 'number', h.body && h.body.chronik);
  }

  // ---- 2: ein Client schreibt nicht ins Buch -----------------------------------------------
  {
    const w = await api.j('/storage/chronik?shared=true', { method: 'PUT', headers: api.auth(ben), body: JSON.stringify({ value: JSON.stringify([{ art: 'weltboss-gefallen', bester: 'ben' }]) }) });
    const c = await chronik(admin);
    const d = liesDb();
    check('2a: PUT /api/storage/chronik?shared=true landet im geteilten Speicher, das Buch in db.galaxy bleibt unberuehrt',
      w.status === 200 && c.body && c.body.gesamt === 1 && !!d.shared.chronik && Array.isArray(d.galaxy.chronik) && d.galaxy.chronik.length === 1,
      { put: w.status, gesamt: c.body && c.body.gesamt, imShared: !!d.shared.chronik });
    const fremd = await chronik(ben);
    check('2b: die Admin-Route verlangt den Admin (403)', fremd.status === 403, { status: fremd.status });
  }

  // ---- 3: Allianz-Gruendung und die Whitelist ------------------------------------------------
  {
    const info = { name: 'Böse "Bande" <script>alert(1)</script>', creatorName: 'ben', createdAt: Date.now() };
    const w = await api.j('/storage/alliance:BSE:info?shared=true', { method: 'PUT', headers: api.auth(ben), body: JSON.stringify({ value: JSON.stringify(info) }) });
    const c = await chronik(admin);
    const g = ((c.body && c.body.eintraege) || []).filter(e => e.art === 'allianz-gegruendet');
    check('3a: eine neue Allianz ergibt genau einen Eintrag mit Tag und Gruender', w.status === 200 && g.length === 1 && g[0].tag === 'BSE' && g[0].gruender === 'ben', { put: w.status, body: w.body, g });
    check('3b: der Name laeuft durch die 40-Zeichen-Whitelist (keine Anfuehrungszeichen, keine Klammern, kein Skript-Tag)',
      g.length === 1 && g[0].name === 'Böse Bande script alert 1 script', g[0] && g[0].name);
    await api.j('/storage/alliance:BSE:info?shared=true', { method: 'PUT', headers: api.auth(ben), body: JSON.stringify({ value: JSON.stringify(Object.assign({}, info, { name: 'Neu' })) }) });
    const c2 = await chronik(admin);
    check('3c: ein zweites Schreiben desselben info-Schluessels ist keine Gruendung', ((c2.body && c2.body.eintraege) || []).filter(e => e.art === 'allianz-gegruendet').length === 1);
  }

  // ---- 4: die Abhol-Route fuer den M715q ---------------------------------------------------
  {
    const ohne = await api.j('/chronik/abholen');
    const falsch = await api.j('/chronik/abholen', { headers: { Authorization: 'Bearer falsch' } });
    const richtig = await api.j('/chronik/abholen?tage=7', { headers: { Authorization: 'Bearer ' + TOKEN } });
    check('4a: ohne Token 401', ohne.status === 401, { status: ohne.status });
    check('4b: falscher Token 401 - mit der LAENGE des Empfangenen, nie dem Wert', falsch.status === 401 && /6 Zeichen/.test(JSON.stringify(falsch.body)) && !/falsch/.test(JSON.stringify(falsch.body)), falsch.body);
    check('4c: richtiger Token 200 mit Eintraegen, Arten-Liste und Zeitraum',
      richtig.status === 200 && richtig.body && richtig.body.tage === 7 && richtig.body.anzahl === 2 && richtig.body.gesamt === 2 && richtig.body.arten && !!richtig.body.arten['weltboss-gefallen'],
      richtig.body && { status: richtig.status, anzahl: richtig.body.anzahl, gesamt: richtig.body.gesamt });
    // `tage` filtert: ein Eintrag von vor 20 Tagen (bei gestopptem Server eingetragen) faellt bei tage=7 weg.
    await stoppeServer();
    const d = liesDb();
    d.galaxy.chronik.push({ id: 'alt-1', zeit: Date.now() - 20 * 24 * 3600 * 1000, art: 'hort-gefunden', spieler: 'anna', ressource: 'Erz', betrag: 5 });
    fs.writeFileSync(dbPfad, JSON.stringify(d));
    api = await starteServer(true);
    const woche = await api.j('/chronik/abholen?tage=7', { headers: { Authorization: 'Bearer ' + TOKEN } });
    const monat = await api.j('/chronik/abholen?tage=30', { headers: { Authorization: 'Bearer ' + TOKEN } });
    check('4d: tage=7 liefert 2 von 3, tage=30 alle 3 - gesamt nennt immer das ganze Buch',
      woche.body && woche.body.anzahl === 2 && woche.body.gesamt === 3 && monat.body && monat.body.anzahl === 3,
      { woche: woche.body && woche.body.anzahl, monat: monat.body && monat.body.anzahl, gesamt: woche.body && woche.body.gesamt });
  }

  // ---- 5: der Deckel kuerzt nur Altes ------------------------------------------------------
  {
    await stoppeServer();
    let d = liesDb();
    const alt = [];
    for (let i = 0; i < 600; i++) alt.push({ id: 'alt-' + i, zeit: Date.now() - (30 + i) * 24 * 3600 * 1000, art: 'hort-gefunden', spieler: 'anna', ressource: 'Erz', betrag: i });
    d.galaxy.chronik = d.galaxy.chronik.concat(alt);   // 3 + 600
    fs.writeFileSync(dbPfad, JSON.stringify(d));
    const admin2 = await (async () => { api = await starteServer(true); return api.anmelden('gamegeeeeek'); })();
    const ben2 = await api.anmelden('ben');
    // Ein neues Ereignis loest den Deckel aus.
    await api.j('/storage/alliance:CAP:info?shared=true', { method: 'PUT', headers: api.auth(ben2), body: JSON.stringify({ value: JSON.stringify({ name: 'Deckel', creatorName: 'ben', createdAt: Date.now() }) }) });
    let c = await api.j('/admin/chronik?tage=60', { headers: api.auth(admin2) });
    check('5a: ueber 500 Eintraege kuerzt der Deckel auf 500', c.body && c.body.gesamt === 500, { gesamt: c.body && c.body.gesamt });
    check('5b: ... und zwar die AELTESTEN - die vier juengsten stehen alle noch drin',
      c.body && ['weltboss-gefallen', 'allianz-gegruendet'].every(a => c.body.eintraege.some(e => e.art === a)) && c.body.eintraege.filter(e => e.art === 'allianz-gegruendet').length === 2,
      c.body && { arten: [...new Set(c.body.eintraege.map(e => e.art))] });
    // Die Gegenrichtung: 600 JUNGE Eintraege (innerhalb von acht Tagen) - keiner darf fallen.
    await stoppeServer();
    d = liesDb();
    const jung = [];
    for (let i = 0; i < 600; i++) jung.push({ id: 'jung-' + i, zeit: Date.now() - i * 60000, art: 'hort-gefunden', spieler: 'ben', ressource: 'Erz', betrag: i });
    d.galaxy.chronik = jung.concat(d.galaxy.chronik);   // 600 + 500
    fs.writeFileSync(dbPfad, JSON.stringify(d));
    api = await starteServer(true);
    const admin3 = await api.anmelden('gamegeeeeek');
    const ben3 = await api.anmelden('ben');
    await api.j('/storage/alliance:CAP2:info?shared=true', { method: 'PUT', headers: api.auth(ben3), body: JSON.stringify({ value: JSON.stringify({ name: 'Deckel zwei', creatorName: 'ben', createdAt: Date.now() }) }) });
    c = await api.j('/admin/chronik?tage=60', { headers: api.auth(admin3) });
    // Erwartung abgeleitet, nicht getippt: alle jungen Eintraege (600 neue plus die aus den
    // Abschnitten 1, 3 und 5a plus dieser) bleiben, jeder alte faellt - das Buch besteht danach
    // NUR aus Eintraegen im Schutzfenster, und es sind mehr als 500.
    const grenze = Date.now() - 8 * 24 * 3600 * 1000;
    check('5c: der Deckel loescht NIE, was die laufende Woche braucht - alle jungen Eintraege bleiben, auch weit ueber 500',
      c.body && c.body.gesamt > 500 && c.body.eintraege.filter(e => e.art === 'hort-gefunden' && e.zeit >= grenze).length === 600
        && c.body.eintraege.every(e => e.zeit >= grenze) && c.body.gesamt === c.body.eintraege.length,
      { gesamt: c.body && c.body.gesamt, alt: c.body && c.body.eintraege.filter(e => e.zeit < grenze).length });
    const h = await api.j('/health');
    check('5d: kein Takt-Fehler durch das Ganze', h.body && h.body.taktFehler === 0, h.body && { taktFehler: h.body.taktFehler });
  }

  // ---- 6: ohne BACKUP_PULL_TOKEN keine Abholung --------------------------------------------
  {
    await stoppeServer();
    api = await starteServer(false);
    const r = await api.j('/chronik/abholen', { headers: { Authorization: 'Bearer ' + TOKEN } });
    check('6a: ohne BACKUP_PULL_TOKEN antwortet die Abhol-Route 503 (fail-closed), auch mit dem "richtigen" Token', r.status === 503, { status: r.status, body: r.body });
    await stoppeServer();
  }

  console.log('');
  console.log(fail ? 'FEHLGESCHLAGEN' : 'Alles gruen.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ABBRUCH:', e); process.exit(1); });
