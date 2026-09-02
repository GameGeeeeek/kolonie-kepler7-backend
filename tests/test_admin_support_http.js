// Vier weitere Admin-Faehigkeiten (02.09.2026, Auftrag Sascha "Weitere Ideen fuer Admin Funktionen
// vorschlagen" - alle vier Vorschlaege gewaehlt): Feedback beantworten, Wartungsankuendigung mit
// Notaus 'angriffe', Support-Werkzeuge am Konto (E-Mail, Umbenennen, Reset-Link), Lage.
//
// KERNMESSUNGEN ALS PAARE (Arbeitsregel 61):
//   1a/1b  die Antwort erreicht den Einsender UND nicht die anderen
//   2a/2c  die Ankuendigung steht UND verschwindet nach Ablauf von selbst
//   2f/2g  bei gesetztem Notaus werden Angriffe abgewiesen UND danach wieder angenommen
//   3c     der neue Name meldet an UND der alte nicht mehr (und alle Namensstellen sind umgeschrieben)
//   3e     der Reset-Link fuehrt zu einem neuen Passwort, mit dem die Anmeldung gelingt (Ende zu Ende)
//
// GEGENPROBEN (sabotierte Kopien ueber KEPLER_SERVER_JS, 24 Pruefungen in beide Richtungen,
// Prueflisten per diff identisch, 0 Werkzeugfehler):
//   Antwort ohne Postfach-Eintrag beim Einsender  -> 1a
//   Ankuendigung laeuft nie ab                    -> 2c
//   Notaus angriffe greift an der Festung nicht   -> 2f
//   Umbenennen laesst den Spielstand-Namen stehen -> 3c2
//   Reset-Link ohne gespeichertes Token           -> 3e
//   Lage zaehlt Kredite nicht                     -> 4a
//
// PORT 3245: gemessen belegt sind 3195-3244 (Backend) und 3243 (Frontend, test_sitzungscookie_front)
// - ein neuer Test nimmt 3246.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3245);

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
    buildings: { mine: 7 }, research: {}, colonies: {}, fleet: { jaeger: 12, missions: [] },
    player: { id, name }, credits, xp: 1000, prestige: 0, battlePoints: 10, lastTick: Date.now()
  };
}
const rolle = (id, name, role) => JSON.stringify({ playerId: id, name, role, joinedAt: 1756000000000 });
function grunddb() {
  const jetzt = Date.now();
  return {
    users: {
      gamegeeeeek: { userId: ADMIN, username: 'GameGeeeeek', passwordHash: hash, createdAt: jetzt },
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: jetzt, email: 'anna@example.org', emailVerified: true },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: jetzt, email: 'ben@example.org', emailVerified: true },
      carl: { userId: CARL, username: 'carl', passwordHash: hash, createdAt: jetzt }
    },
    private: {
      [ADMIN]: { 'kepler7-save-v3': JSON.stringify(spielstand(ADMIN, 'GameGeeeeek', 1000)) },
      [ANNA]:  { 'kepler7-save-v3': JSON.stringify(spielstand(ANNA, 'anna', 5000)) },
      [BEN]:   { 'kepler7-save-v3': JSON.stringify(spielstand(BEN, 'ben', 3000)) },
      [CARL]:  { 'kepler7-save-v3': JSON.stringify(spielstand(CARL, 'carl', 100)) }
    },
    shared: {
      'worldboss:current': JSON.stringify({ level: 2, hp: 500, maxHp: 1000, contributions: {} }),
      ['leaderboard:' + ANNA]: JSON.stringify({ name: 'anna', score: 10, lastSeen: jetzt }),
      'alliance:T1:info': JSON.stringify({ tag: 'T1', creatorId: BEN, creatorName: 'ben', createdAt: 1755000000000, joinMode: 'open' }),
      ['alliance:T1:role:' + BEN]: rolle(BEN, 'ben', 'admin'),
      ['alliance:T1:role:' + ANNA]: rolle(ANNA, 'anna', 'member'),
      'vorposten:sys_test': JSON.stringify({ id: 'vp_1', sys: 'sys_test', besitzer: BEN, besitzerName: 'ben', stufe: 1, kern: { lp: 100, lpMax: 100 }, seit: jetzt - 3600000 })
    },
    resetTokens: {},
    feedback: [{ id: 'fb1', time: jetzt - 60000, userId: ANNA, username: 'anna', type: 'idee', text: 'Mehr Schiffe bitte', version: '8.628.0' }],
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: jetzt, factions: {},
      alienPause: { kryll: jetzt + 9e8, xantheer: jetzt + 9e8, vex: jetzt + 9e8, verglueht: jetzt + 9e8 },
      alienNester: [{ id: 'nest1', volk: 'kryll', sys: 'sys_nest', stufe: 2, lp: 800, lpMax: 1000, seit: jetzt - 7200000, letzteReifung: jetzt }] }
  };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-supp-'));
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
  async function anmelden(name, pw) {
    const r = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name, password: pw || 'test1234' }) });
    return { token: r.body && r.body.token, status: r.status, error: r.body && r.body.error };
  }
  return { j, anmelden, protokoll: () => log };
}
async function alleAnmelden() { tok = {}; for (const n of ['GameGeeeeek', 'anna', 'ben', 'carl']) tok[n] = (await s.anmelden(n)).token; }
async function stoppeServer() { if (!srv) return; srv.kill('SIGTERM'); await warte(700); srv = null; }
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
async function aendereDb(fn) { await stoppeServer(); const d = liesDb(); await fn(d); schreibDb(d); s = await starteServer(); await alleAnmelden(); }
const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
const admin = (pfad, body) => s.j(pfad, { method: 'POST', headers: kopf(tok.GameGeeeeek), body: JSON.stringify(body || {}) });
const postfach = async t => { const b = (await s.j('/notifications', { headers: kopf(t) })).body || {}; const l = Array.isArray(b) ? b : (b.events || b.list || b.notifications || []); return l; };
const protokoll = async () => ((await s.j('/admin/protokoll', { headers: kopf(tok.GameGeeeeek) })).body || {}).eintraege || [];

(async () => {
  schreibDb(grunddb());
  s = await starteServer();
  await alleAnmelden();
  check('0-vorab: alle Konten angemeldet', ['GameGeeeeek', 'anna', 'ben', 'carl'].every(n => !!tok[n]), Object.fromEntries(Object.entries(tok).map(([k, v]) => [k, !!v])));
  if (!tok.anna) { console.log(s.protokoll().slice(-1500)); process.exit(1); }

  // ---- 1) Feedback beantworten -------------------------------------------------------------------
  const r1 = await admin('/admin/feedback/antwort', { id: 'fb1', text: 'Danke - kommt mit der naechsten Etappe.' });
  const fb1 = (await s.j('/admin/feedback', { headers: kopf(tok.GameGeeeeek) })).body;
  const e1 = ((fb1 && fb1.feedback) || []).find(f => f.id === 'fb1') || {};
  const pA = (await postfach(tok.anna)).filter(e => e.type === 'feedback-antwort');
  check('1a: die Antwort steht am Eintrag UND im Postfach des Einsenders, mit Text und Auszug der Einsendung',
    r1.status === 200 && r1.body.zugestellt === true && e1.antwort && /naechsten Etappe/.test(e1.antwort.text) && e1.antwort.zeit > 0 &&
    pA.length === 1 && /naechsten Etappe/.test(pA[0].payload.text) && /Mehr Schiffe/.test(pA[0].payload.auszug),
    { antwort: e1.antwort, postfach: pA.map(e => e.payload) });
  const pB = (await postfach(tok.ben)).filter(e => e.type === 'feedback-antwort');
  check('1b: ein anderes Konto bekommt die Antwort NICHT (PAAR)', pB.length === 0, pB.length);
  const r1c = await admin('/admin/feedback/antwort', { id: 'gibtesnicht', text: 'x' });
  const r1d = await admin('/admin/feedback/antwort', { id: 'fb1', text: '   ' });
  const r1e = await s.j('/admin/feedback/antwort', { method: 'POST', headers: kopf(tok.anna), body: JSON.stringify({ id: 'fb1', text: 'x' }) });
  check('1c: unbekannte Einsendung 404, leerer Text 400, ohne Admin 403', r1c.status === 404 && r1d.status === 400 && r1e.status === 403, [r1c.status, r1d.status, r1e.status]);

  // ---- 2) Wartungsankuendigung und Notaus 'angriffe' ------------------------------------------------
  const r2 = await admin('/admin/ankuendigung', { text: 'Wartung: Server-Umzug, kurz nicht erreichbar', abInMinuten: 5, dauerMinuten: 10 });
  const o2 = await s.j('/ankuendigung');
  const a2 = o2.body && o2.body.ankuendigung;
  check('2a: die Ankuendigung steht und ist OHNE Sitzung lesbar - Text, Beginn in ~5 Minuten, Dauer, Serverzeit',
    r2.status === 200 && o2.status === 200 && a2 && /Server-Umzug/.test(a2.text) && a2.ab > Date.now() + 4 * 60000 && a2.ab < Date.now() + 6 * 60000 && a2.dauerMinuten === 10 && a2.jetzt > 0,
    { status: o2.status, ankuendigung: a2 });
  const r2d = await admin('/admin/ankuendigung', { text: '', abInMinuten: 5, dauerMinuten: 10 });
  check('2d: ohne Text wird nichts angekuendigt (400)', r2d.status === 400, r2d.body);
  const r2b = await admin('/admin/ankuendigung/aufheben', {});
  const o2b = await s.j('/ankuendigung');
  check('2b: Aufheben entfernt sie', r2b.status === 200 && r2b.body.aufgehoben === true && o2b.body.ankuendigung === null, o2b.body);
  await admin('/admin/ankuendigung', { text: 'Kurz', abInMinuten: 0, dauerMinuten: 1 });
  await aendereDb(d => { d.ankuendigung.ab = Date.now() - 10 * 60000; });   // begann vor 10 Minuten, dauerte 1
  const o2c = await s.j('/ankuendigung');
  check('2c: nach Ablauf (Beginn + Dauer) liefert der Server null - der Client muss nichts wegrechnen (PAAR zu 2a)', o2c.body.ankuendigung === null, o2c.body);
  const sch = (await s.j('/admin/schalter', { headers: kopf(tok.GameGeeeeek) })).body;
  const angriffe = ((sch && sch.schalter) || []).find(x => x.name === 'angriffe') || {};
  check('2e: der sechste Schalter "angriffe" steht in der Liste, im Code an, nicht ausgeschaltet', angriffe.imCode === true && angriffe.notAus !== true, angriffe);
  const r2f = await admin('/admin/schalter', { name: 'angriffe', aus: true, grund: 'Wartung' });
  const f2 = await s.j('/festung/angriff', { method: 'POST', headers: kopf(tok.anna), body: JSON.stringify({ system: 'x' }) });
  const p2 = await s.j('/attack', { method: 'POST', headers: kopf(tok.anna), body: JSON.stringify({ targetUserId: BEN }) });
  const n2 = await s.j('/alien/nest-angriff', { method: 'POST', headers: kopf(tok.anna), body: JSON.stringify({ nestId: 'nest1' }) });
  check('2f: bei gesetztem Notaus werden Festungs-, PvP- und Nest-Angriffe mit 503 "pausiert" abgewiesen',
    r2f.status === 200 && [f2, p2, n2].every(r => r.status === 503 && r.body && r.body.pausiert === true && /pausiert/.test(r.body.error)), { festung: f2.status, pvp: p2.status, nest: n2.status });
  await admin('/admin/schalter', { name: 'angriffe', aus: false, grund: 'Wartung vorbei' });
  const f2g = await s.j('/festung/angriff', { method: 'POST', headers: kopf(tok.anna), body: JSON.stringify({ system: 'x' }) });
  check('2g: nach dem Wiedereinschalten werden Angriffe wieder angenommen - die Pruefung des Ziels greift (kein 503) (PAAR zu 2f)', f2g.status !== 503 && f2g.status < 500, f2g.status);

  // ---- 3) Support-Werkzeuge -----------------------------------------------------------------------
  const r3a = await admin('/admin/konto/email', { targetUsername: 'carl', email: 'Carl.Neu@Example.org' });
  const r3b = await admin('/admin/konto/email', { targetUsername: 'carl', email: 'kein-mail' });
  const r3b2 = await admin('/admin/konto/email', { targetUsername: 'carl', email: 'ben@example.org' });
  await stoppeServer(); const db3 = liesDb(); s = await starteServer(); await alleAnmelden();
  check('3a: die E-Mail wird kleingeschrieben gesetzt und gilt als bestaetigt; ungueltig 400, fremde Adresse 409',
    r3a.status === 200 && r3a.body.emailForm && db3.users.carl.email === 'carl.neu@example.org' && db3.users.carl.emailVerified === true && db3.users.carl.emailGesetztDurchAdmin > 0 && r3b.status === 400 && r3b2.status === 409,
    { antwort: r3a.body, datei: db3.users.carl.email, ungueltig: r3b.status, fremd: r3b2.status });
  const altesTokenAnna = tok.anna;
  const r3c = await admin('/admin/konto/umbenennen', { targetUsername: 'anna', neuerName: 'Annalena' });
  const lNeu = await s.anmelden('Annalena');
  const lAlt = await s.anmelden('anna');
  const meAlt = await s.j('/me', { headers: kopf(altesTokenAnna) });
  await stoppeServer(); const db3c = liesDb(); s = await starteServer(); await alleAnmelden(); tok.anna = (await s.anmelden('Annalena')).token;
  const save3 = JSON.parse(typeof db3c.private[ANNA]['kepler7-save-v3'] === 'string' ? db3c.private[ANNA]['kepler7-save-v3'] : db3c.private[ANNA]['kepler7-save-v3'].value);
  check('3c: der neue Name meldet an, der alte nicht mehr, die alte Sitzung ist entwertet (PAAR)',
    r3c.status === 200 && r3c.body.spielstandGeaendert === true && lNeu.status === 200 && lAlt.status === 401 && meAlt.status === 401,
    { antwort: r3c.body, neu: lNeu.status, alt: lAlt.status, altesToken: meAlt.status });
  check('3c2: alle Namensstellen sind umgeschrieben - Konto, Spielstand, Bestenliste, Allianz-Rolle',
    !db3c.users.anna && db3c.users.annalena && db3c.users.annalena.username === 'Annalena' && db3c.users.annalena.vorherName === 'anna' &&
    save3.player.name === 'Annalena' && JSON.parse(db3c.shared['leaderboard:' + ANNA]).name === 'Annalena' && JSON.parse(db3c.shared['alliance:T1:role:' + ANNA]).name === 'Annalena',
    { konto: !!db3c.users.annalena, spielstand: save3.player.name, bestenliste: JSON.parse(db3c.shared['leaderboard:' + ANNA]).name, rolle: JSON.parse(db3c.shared['alliance:T1:role:' + ANNA]).name });
  const r3d = await admin('/admin/konto/umbenennen', { targetUsername: 'Annalena', neuerName: 'x' });
  const r3d2 = await admin('/admin/konto/umbenennen', { targetUsername: 'Annalena', neuerName: 'BEN' });
  const r3d3 = await admin('/admin/konto/umbenennen', { targetUsername: 'GameGeeeeek', neuerName: 'Chef' });
  check('3d: zu kurz 400, vergeben (auch anders geschrieben) 409, Betreiberkonto 400', r3d.status === 400 && r3d2.status === 409 && r3d3.status === 400, [r3d.status, r3d2.status, r3d3.status]);
  const r3e = await admin('/admin/konto/reset-link', { targetUsername: 'carl' });
  const token3 = r3e.body && r3e.body.link ? String(r3e.body.link).split('?reset=')[1] : '';
  const rs = await s.j('/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token3, newPassword: 'neuespasswort9' }) });
  const lCarl = await s.anmelden('carl', 'neuespasswort9');
  const lCarlAlt = await s.anmelden('carl', 'test1234');
  check('3e: der Reset-Link fuehrt Ende zu Ende zu einem neuen Passwort - Link unter PUBLIC_URL, Reset 200, neue Anmeldung 200, alte 401',
    r3e.status === 200 && /^https:\/\/test\.example\/\?reset=[0-9a-f]{64}$/.test(String(r3e.body.link)) && r3e.body.gueltigBis > Date.now() && rs.status === 200 && lCarl.status === 200 && lCarlAlt.status === 401,
    { link: r3e.body && String(r3e.body.link).slice(0, 40), reset: [rs.status, rs.body && rs.body.error], neu: lCarl.status, alt: lCarlAlt.status });
  const r3f = await s.j('/admin/konto/reset-link', { method: 'POST', headers: kopf(tok.ben), body: JSON.stringify({ targetUsername: 'carl' }) });
  check('3f: ohne Admin 403', r3f.status === 403, r3f.status);

  // ---- 4) Lage ------------------------------------------------------------------------------------
  await admin('/admin/schalter', { name: 'angriffe', aus: true, grund: 'fuer 4c' });
  const l4 = (await s.j('/admin/lage', { headers: kopf(tok.GameGeeeeek) })).body;
  const w = l4.wirtschaft || {};
  check('4a: die Wirtschaft summiert ueber alle Spielstaende - Konten, Kredite gesamt/Median/Top, Ressourcen',
    w.konten === 4 && w.kredite && w.kredite.gesamt === 9100 && w.kredite.median === 3000 && w.kredite.top[0].username === 'Annalena' && w.kredite.top[0].credits === 5000 &&
    w.ressourcen && w.ressourcen.erz === 4e5 && w.kampfpunkte === 40 && w.aktiv7Tage === 4,
    { konten: w.konten, kredite: w.kredite, erz: w.ressourcen && w.ressourcen.erz, kp: w.kampfpunkte });
  const p = l4.pve || {};
  check('4b: die PvE-Lage nennt Weltboss, Nester, Vorposten mit Zustand; Festungen und Konvois sind Listen',
    p.weltboss && p.weltboss.level === 2 && p.weltboss.hp === 500 && p.weltboss.maxHp === 1000 &&
    Array.isArray(p.nester) && p.nester.length === 1 && p.nester[0].volk === 'kryll' && p.nester[0].stufe === 2 && p.nester[0].lp === 800 &&
    Array.isArray(p.vorposten) && p.vorposten.length === 1 && p.vorposten[0].besitzerName === 'ben' && p.vorposten[0].kern === 100 &&
    Array.isArray(p.festungen) && Array.isArray(p.konvois),
    { weltboss: p.weltboss, nester: p.nester, vorposten: p.vorposten, festungen: (p.festungen || []).length, konvois: (p.konvois || []).length });
  check('4b2: der Markt liefert Preise gegen Basis und das Ereignis', l4.markt && l4.markt.preise && Object.keys(l4.markt.preise).length >= 3 && Object.values(l4.markt.preise).every(x => x.preis > 0 && x.basis > 0),
    l4.markt && Object.keys(l4.markt.preise || {}));
  check('4c: die gesetzten Notaus-Schalter stehen in der Lage', Array.isArray(l4.notAus) && l4.notAus.includes('angriffe'), l4.notAus);
  await admin('/admin/schalter', { name: 'angriffe', aus: false, grund: 'x' });
  const r4d = await s.j('/admin/lage', { headers: kopf(tok.ben) });
  check('4d: ohne Admin 403', r4d.status === 403, r4d.status);

  // ---- 5) Protokoll --------------------------------------------------------------------------------
  const p5 = await protokoll();
  const arten = [...new Set(p5.map(e => e.art))];
  const resetEintrag = p5.find(e => e.art === 'konto/reset-link') || {};
  check('5a: alle neuen Handlungen stehen im Protokoll', ['feedback/antwort', 'ankuendigung', 'ankuendigung/aufheben', 'konto/email', 'konto/umbenennen', 'konto/reset-link'].every(a => arten.includes(a)), arten);
  check('5b: der Reset-Link-Eintrag traegt KEIN Token (der kommt nicht aus dem Request-Koerper)', resetEintrag.details && !JSON.stringify(resetEintrag.details).includes(token3.slice(0, 16)) && resetEintrag.ziel === 'carl', resetEintrag);

  await stoppeServer();
  console.log(fail ? '\nFAIL - es gab rote Pruefungen.' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ABBRUCH:', e); try { console.log(s && s.protokoll().slice(-1500)); } catch (x) {} process.exit(1); });
