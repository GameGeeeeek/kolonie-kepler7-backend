// Echter HTTP-Test: Die Anfechtung rechnet die Eskorte des Halters MIT seinen Marken, Modulen und
// seiner Kampfforschung - und die Vorschau nennt dieselbe Zahl wie der Kampf (01.09.2026).
//
//   node tests/test_anfechtung_vorschau_http.js
//   KEPLER_ANF_SABOTAGE=null node tests/test_anfechtung_vorschau_http.js    (Gegenprobe, s. u.)
//
// ANLASS: /api/asteroid/contest uebergab fuer die Eskorte `save = null`. Werftmarken, Klassenmodule
// und Kampfforschung des Halters zaehlten damit im Kampf nicht, waehrend die Werft sie ihm anzeigt -
// und die Anfechtungs-Vorschau des Frontends zeigte bewusst keine Zahl, weil der Client diese Werte
// gar nicht kennt. Beides loest EINE Backend-Funktion (astEskorteVerteidigung), die Kampf UND
// Vorschau benutzen.
//
// GEPRUEFT WIRD:
//   1. Die Vorschau-Route antwortet mit Angriff, Verteidigung, Chancen-Spanne und Verlustquoten,
//      alles in den Deckeln des Kampfs (10-90 %).
//   2. DAS PAAR: Dieselbe Eskorte, einmal ohne und einmal MIT Marken/Modul/Forschung des Halters,
//      muss eine HOEHERE Verteidigung ergeben. Ein Lauf allein waere auch am alten Stand gruen.
//   3. Der KAMPF rechnet mit derselben Zahl: Die gemeldete Chance liegt in der Spanne, die die
//      Vorschau unmittelbar davor genannt hat.
//   4. Die Wachen der Route: eigenes Recht (400), unreserviertes Vorkommen (409), Flotte ohne
//      Kampfkraft (400), unbekannte Schluessel werden ignoriert statt gezaehlt.
//
// GEGENPROBE (KEPLER_ANF_SABOTAGE=null: astEskorteVerteidigung liest den Halter-Spielstand NICHT):
//   2a und 2b MUESSEN fallen - beide Laeufe zeigen dieselbe Verteidigung und Chance. Bleibt eins gruen, ist das ein
//   WERKZEUGFEHLER (Frontend-Arbeitsregel 71), kein Beleg.
//
// Port 3240 (belegt bis 3239, Arbeitsregel 29). Startet eine KOPIE von server.js im
// Repo-Verzeichnis (require('./mailer') muss aufloesen), damit die Gegenprobe denselben Weg nimmt.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3240;
const QUELLE = path.join(WURZEL, 'server_anftest_tmp.js');
const SAB = process.env.KEPLER_ANF_SABOTAGE || '';
const MUSS_FALLEN = { null: ['2a', '2b'] };   // gemessen: ohne Halter-Spielstand sind Verteidigung UND Chance gleich

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
const ANNA = crypto.randomUUID(), BEN = crypto.randomUUID();
const SAVE_KEY = 'kepler7-save-v3';
const ESKORTE = { cruisers: 100, schlachtschiff: 20 };
const FLOTTE_B = { cruisers: 200, destroyers: 100 };

function spielstand(id, name, flotte) {
  return {
    resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {},
    fleet: Object.assign({ missions: [] }, flotte),
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  };
}
function grunddb() {
  return {
    users: {
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: Date.now() }
    },
    private: {
      [ANNA]: { [SAVE_KEY]: JSON.stringify(spielstand(ANNA, 'anna', {})) },
      [BEN]:  { [SAVE_KEY]: JSON.stringify(spielstand(BEN, 'ben', FLOTTE_B)) }
    },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {} }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-anfvorschau-' + process.pid + '.json');
let srv = null, s = null, tokA = null, tokB = null;
function ende() {
  try { if (srv) srv.kill(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.unlinkSync(QUELLE); } catch (e) {}
}
process.on('exit', ende);

async function starteServer() {
  let log = '';
  srv = spawn(process.execPath, [QUELLE], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, { DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret' }),
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
    try { return { status: r.status, body: JSON.parse(t) }; }
    catch (e) { return { status: r.status, body: t.slice(0, 300) }; }
  }
  async function anmelden(name) {
    const r = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name, password: 'test1234' }) });
    return r.body && r.body.token;
  }
  return { j, anmelden, protokoll: () => log };
}
async function stoppeServer() { if (!srv) return; srv.kill('SIGTERM'); await warte(700); srv = null; }
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
function liesSave(d, uid) {
  const roh = d.private[uid][SAVE_KEY];
  return JSON.parse(typeof roh === 'string' ? roh : roh.value);
}
function schreibSave(d, uid, save) {
  const roh = d.private[uid][SAVE_KEY];
  if (typeof roh === 'string') d.private[uid][SAVE_KEY] = JSON.stringify(save);
  else d.private[uid][SAVE_KEY] = Object.assign({}, roh, { value: JSON.stringify(save) });
}
// Reihenfolge-Wache wie in den Nachbartests: Eine Aenderung an der DB-DATEI, waehrend der Server
// laeuft, ist beim naechsten SIGTERM wieder weg (der Graceful Shutdown flusht darueber).
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  try { await fn(d); } catch (e) { check('aufbau: die DB-Aenderung liess sich ausfuehren', false, { fehler: String(e).slice(0, 200) }); }
  schreibDb(d);
  s = await starteServer();
  tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
}

(async () => {
  let roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  const anker = "const halterSave = (vork && vork.halter) ? astLeseSave(vork.halter) : null;";
  check('0-kopie: die Halter-Lesestelle ist auffindbar', roh.split(anker).length === 2, { treffer: roh.split(anker).length - 1 });
  if (SAB === 'null') roh = roh.replace(anker, 'const halterSave = null;');
  else if (SAB) { console.log('Unbekannte Sabotage: ' + SAB); process.exit(2); }
  fs.writeFileSync(QUELLE, roh);

  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  s = await starteServer();
  tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  check('0: beide Konten angemeldet', !!tokA && !!tokB);
  if (!tokA || !tokB) { console.log(s.protokoll().slice(-1500)); process.exit(1); }
  const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
  const post = (pfad, tok, body) => s.j(pfad, { method: 'POST', headers: kopf(tok), body: JSON.stringify(body || {}) });

  // Guertelfelder erzeugen lassen, dann ein Vorkommen fuer Anna reservieren.
  const f0 = await s.j('/asteroid/field', { headers: kopf(tokA) });
  check('0b: Guertelfeld lesbar', f0.status === 200, f0.status);
  if (f0.status !== 200) { console.log(s.protokoll().slice(-1500)); process.exit(1); }
  const sys = (f0.body.systeme || [])[0];
  const feldKey = 'asteroids:' + sys;
  let platz = null, freierPlatz = null;
  await aendereDb(d => {
    const feld = d.shared[feldKey];
    const belegt = Object.keys(feld.plaetze).filter(k => feld.plaetze[k] && !feld.plaetze[k].frei);
    platz = belegt[0];
    freierPlatz = belegt[1] || null;
    const v = feld.plaetze[platz];
    v.halter = ANNA; v.halterName = 'anna'; v.tag = ''; v.eskorte = Object.assign({}, ESKORTE);
    v.seit = Date.now() - 3600000; v.schutzBis = 0; v.angriffe = {};
    d.shared[feldKey] = feld;
  });
  check('0c: ein reserviertes Vorkommen mit Eskorte steht', !!platz, { sys, platz });
  const vorschau = (tok, comp, p) => post('/asteroid/anfechtung-vorschau', tok, { system: sys, platz: p === undefined ? platz : p, composition: comp });

  // ---- 1) die Route -----------------------------------------------------------------------------
  const ohne = await vorschau(tokB, FLOTTE_B);
  check('1a: die Vorschau antwortet', ohne.status === 200 && ohne.body && ohne.body.ok, { status: ohne.status, body: ohne.body });
  const o = ohne.body || {};
  check('1b: sie nennt Angriff, Verteidigung und die Wache', o.angriff > 0 && o.verteidigung > 0 && o.wache === 120,
    { angriff: o.angriff, verteidigung: o.verteidigung, wache: o.wache });
  check('1c: die Chancen-Spanne liegt in den Deckeln des Kampfs (10-90) und ist geordnet',
    o.chanceMin >= 10 && o.chanceMax <= 90 && o.chanceMin <= o.chance && o.chance <= o.chanceMax,
    { chanceMin: o.chanceMin, chance: o.chance, chanceMax: o.chanceMax });
  check('1d: die Verlustquoten sind benannt - Niederlage teurer als Sieg',
    typeof o.verlustSieg === 'number' && typeof o.verlustNiederlage === 'number' && o.verlustNiederlage > o.verlustSieg,
    { sieg: o.verlustSieg, niederlage: o.verlustNiederlage });

  // ---- 2) DAS PAAR: Marken, Modul und Forschung des Halters zaehlen -----------------------------
  await aendereDb(d => {
    const save = liesSave(d, ANNA);
    save.shipMarks = { cruisers: 10, schlachtschiff: 10 };
    save.research = { rkampf: 20, rkampf2: 20 };
    // Ein episches Huellenmodul der Schweren Linie (Kreuzer gehoeren dazu). Der Instanz-Schluessel
    // traegt Seltenheit, Stufe und Wurf - genau die Form, die moduleSubsServer/moduleWertMultServer lesen.
    save.equippedShipModules = { schwerelinie: ['sl_kompositpanzer:episch:1:w100'] };
    schreibSave(d, ANNA, save);
  });
  const mit = await vorschau(tokB, FLOTTE_B);
  const m = mit.body || {};
  check('2-vorab: die zweite Vorschau antwortet', mit.status === 200 && m.ok, { status: mit.status });
  check('2a: MIT Marken, Modul und Forschung des Halters ist die Verteidigung HOEHER als ohne',
    m.verteidigung > o.verteidigung * 1.5,
    { ohne: o.verteidigung, mit: m.verteidigung, faktor: o.verteidigung ? Math.round(m.verteidigung / o.verteidigung * 100) / 100 : null,
      hinweis: 'am alten Stand (save=null) sind beide Zahlen gleich' });
  check('2b: und die Chance des Angreifers sinkt entsprechend', m.chance < o.chance, { ohne: o.chance, mit: m.chance });
  check('2c: der eigene Angriff bleibt dabei unveraendert (nur die Gegenseite hat sich geaendert)',
    m.angriff === o.angriff, { ohne: o.angriff, mit: m.angriff });

  // ---- 3) der KAMPF rechnet mit derselben Zahl ---------------------------------------------------
  await aendereDb(d => {
    const save = liesSave(d, BEN);
    save.fleet.missions = [{ id: 'm1', type: 'asteroid-contest', targetId: sys + ':' + platz, system: sys, platz,
      endTime: Date.now() - 1000, composition: FLOTTE_B }];
    schreibSave(d, BEN, save);
  });
  const vorKampf = await vorschau(tokB, FLOTTE_B);
  const vk = vorKampf.body || {};
  const kampf = await post('/asteroid/contest', tokB, { system: sys, platz, missionId: 'm1' });
  check('3-vorab: die Anfechtung wurde ausgetragen', kampf.status === 200 && kampf.body && typeof kampf.body.chance === 'number',
    { status: kampf.status, body: kampf.body && (kampf.body.error || { gewonnen: kampf.body.gewonnen, chance: kampf.body.chance }) });
  const kc = Math.round((kampf.body && kampf.body.chance || 0) * 100);
  check('3a: die im Kampf gewuerfelte Chance liegt in der Spanne, die die Vorschau genannt hat',
    kc >= vk.chanceMin - 1 && kc <= vk.chanceMax + 1,
    { kampf: kc, vorschauMin: vk.chanceMin, vorschauMax: vk.chanceMax,
      hinweis: 'beide gehen durch astEskorteVerteidigung und astAnfechtungChance - eine zweite Formel laege daneben' });

  // ---- 4) die Wachen der Route -------------------------------------------------------------------
  {
    /* Der Kampf in Abschnitt 3 kann GEWONNEN worden sein - dann gehoert das Recht jetzt Ben, und
       "eigenes Recht" traefe den Falschen (genau so beim ersten Lauf passiert: 4a gruen fuer Ben,
       rot fuer Anna). Der Halter wird deshalb VOR den Wachen zurueckgesetzt, nicht erst vor 4d. */
    await aendereDb(d => {
      const feld = d.shared[feldKey]; const v = feld.plaetze[platz];
      v.halter = ANNA; v.halterName = 'anna'; v.tag = ''; v.eskorte = Object.assign({}, ESKORTE); v.schutzBis = 0; v.angriffe = {};
      d.shared[feldKey] = feld;
    });
    const eig = await vorschau(tokA, { cruisers: 10 });
    check('4a: das eigene Schuerfrecht laesst sich nicht "vorschauen" (400, mit Grund)',
      eig.status === 400 && /eigenes/.test((eig.body && eig.body.error) || ''), { status: eig.status, error: eig.body && eig.body.error });
    if (freierPlatz !== null) {
      const unres = await vorschau(tokB, { cruisers: 10 }, freierPlatz);
      check('4b: ein unreserviertes Vorkommen wird abgelehnt (409)', unres.status === 409, { status: unres.status, error: unres.body && unres.body.error });
    } else {
      check('4b: ein unreserviertes Vorkommen wird abgelehnt (409) - kein zweiter Platz im Feld, uebersprungen', true, { hinweis: 'Feld hat nur einen belegten Platz' });
    }
    const leer = await vorschau(tokB, {});
    // Der GRUND gehoert geprueft (Frontend-Arbeitsregel 28): Ein 400 kaeme auch fuer "eigenes Recht".
    check('4c: eine Flotte ohne Kampfkraft wird abgelehnt (400, mit Grund)',
      leer.status === 400 && /Kampfkraft/.test((leer.body && leer.body.error) || ''), { status: leer.status, error: leer.body && leer.body.error });
    const a1 = await vorschau(tokB, { cruisers: 50 });
    const a2 = await vorschau(tokB, { cruisers: 50, foo: 99, bomber: -5, jaeger: 'x' });
    check('4d: unbekannte Schluessel, negative und unsinnige Werte zaehlen nicht',
      a1.status === 200 && a2.status === 200 && a1.body.angriff === a2.body.angriff,
      { rein: a1.body && a1.body.angriff, mitMuell: a2.body && a2.body.angriff });
  }

  await stoppeServer();
  if (SAB) {
    const muss = MUSS_FALLEN[SAB] || [];
    const gefallen = Object.keys(ergebnis).filter(k => !ergebnis[k]);
    const fehlend = muss.filter(k => ergebnis[k] !== false);
    const zuviel = gefallen.filter(k => !muss.includes(k));
    if (!fehlend.length && !zuviel.length) { console.log('\nGEGENPROBE ' + SAB + ': genau ' + muss.join(', ') + ' gefallen - wie erwartet.'); process.exit(0); }
    console.log('\nWERKZEUGFEHLER Gegenprobe ' + SAB + ': erwartet ' + JSON.stringify(muss) + ', gefallen ' + JSON.stringify(gefallen));
    process.exit(1);
  }
  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})();
