// Der Hort: der seltenste Expeditionsfund, und die einzige Meldung, die alle Spieler sehen.
//
// WORUM ES HIER GEHT
// ------------------
// Die Expedition wird im Browser ausgewertet - der Spielstand ist bauartbedingt klientenautoritativ.
// Fuer den Fund selbst ist das in Ordnung. Fuer die MELDUNG AN ALLE ist es das nicht: pushGalaxyNews
// schreibt in die Weltlage, die jeder sieht, und ein Banner, das jeder Client ausloesen kann, ist
// ein Spam-Kanal. Deshalb faellt die Hort-Entscheidung auf dem Server, und dieser Test haelt genau
// das fest - nicht die Zahlen, sondern die Grenze.
//
// Aufruf:
//   node tests/test_hort_meldung_http.js                  normaler Lauf (Kopie mit Schalter AN)
//   node tests/test_hort_meldung_http.js --sabotage=stumm  Gegenprobe
//
// Gegenproben mit gemessener Pflichtliste (siehe Auswertung am Ende):
//   offen       - der Schalter wird ignoriert
//   ungeklemmt  - der Beute-Multiplikator des Clients wird geglaubt statt geklemmt
//   stumm       - der Hort wird zugesagt, aber nicht in der Weltlage gemeldet
//   fremdres    - eine unbekannte Ressource wird angenommen statt abgelehnt
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
// Port 3253: gemessen mit grep -hoE "3[12][0-9][0-9]" tests/*.js | sort -un gegen frisch geholtes
// origin/master (hoechster belegter Wert 3252) - die Messung kennt sonst fremde, noch nicht
// gemergte Tests nicht.
const PORT = 3253;
const QUELLE = path.join(WURZEL, 'server_hortmeldung_tmp.js');
const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const hash = bcrypt.hashSync('test1234', 10);

const SAB = (process.argv.find(a => a.startsWith('--sabotage=')) || '').split('=')[1] || null;
let fail = false;
const gefallen = [];
const check = (n, c, x) => {
  console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : ''));
  if (!c) gefallen.push(n.split(':')[0]);
  fail = fail || !c;
};
const warte = ms => new Promise(r => setTimeout(r, ms));

const dbPfad = path.join(os.tmpdir(), 'kepler-hort-' + process.pid + '.json');
let srv = null;
function ende() {
  try { if (srv) srv.kill(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.unlinkSync(QUELLE); } catch (e) {}
}
process.on('exit', ende);

function grunddb() {
  return {
    users: { anna: { userId: 'u-anna', username: 'anna', passwordHash: hash, createdAt: Date.now() } },
    private: {}, shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {} }
  };
}

async function starteServer() {
  srv = spawn(process.execPath, [QUELLE], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, { DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
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
  const login = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'anna', password: 'test1234' }) });
  return { j, tok: login.body && login.body.token };
}

(async () => {
  let roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');

  // Der ausgelieferte Schalter steht auf false; der Test legt ihn in seiner KOPIE um. Ohne diese
  // Pruefung koennte er unbemerkt schon live sein - dann pruefte der Test nicht mehr, was live steht.
  const schalter = /const HORT_BANNER_AKTIV = (true|false);/;
  check('0-kopie: der Schalter ist auffindbar', schalter.test(roh), { gefunden: (roh.match(schalter) || [])[1] });
  roh = roh.replace(schalter, 'const HORT_BANNER_AKTIV = true;');

  // Die Chance auf 1 setzen: Ein Test, der auf 0,5% wartet, misst Geduld statt Verhalten.
  const chance = /const HORT_START_CHANCE = [\d.]+;/;
  check('0-kopie: die Chance ist auffindbar', chance.test(roh));
  roh = roh.replace(chance, 'const HORT_START_CHANCE = 1;');

  // "offen" greift bewusst an der ZWEITEN Kopie an (Abschnitt 5, Schalter aus). An der ersten waere
  // sie wirkungslos: Dort steht der Schalter ohnehin auf true, das Entfernen der Bedingung aendert
  // also nichts - gemessen beim ersten Gegenprobenlauf, der genau nichts fallen liess.
  const sab = {
    offen: ['  if (!HORT_BANNER_AKTIV || notAusGesetzt(\'hort\')) return res.json({ hort: false });',
            '  if (false) return res.json({ hort: false });'],
    ungeklemmt: ['  const mult = Number.isFinite(roh) ? Math.min(HORT_MULT_MAX, Math.max(HORT_MULT_MIN, roh)) : 1;',
                 '  const mult = Number.isFinite(roh) ? roh : 1;'],
    stumm: ["  pushGalaxyNews('ti-trophy', 'Seltener Fund: ' + req.username",
            "  if (false) pushGalaxyNews('ti-trophy', 'Seltener Fund: ' + req.username"],
    fremdres: ['  if (!label) return res.status(400).json({ error: \'Unbekannte Ressource.\' });',
               '  if (!label && false) return res.status(400).json({ error: \'Unbekannte Ressource.\' });'],
    // Die Meldung geht raus, aber ohne Art - genau der Zustand vor dem 03.09.2026, in dem ein
    // Leser sie nur am Wortlaut haette erkennen koennen.
    artlos: ["    + betrag.toLocaleString('de-DE') + ' ' + label + '!', 'hort');",
             "    + betrag.toLocaleString('de-DE') + ' ' + label + '!');"]
  };
  if (SAB) {
    const paar = sab[SAB];
    if (!paar) { console.log('Unbekannte Sabotage: ' + SAB); process.exit(2); }
    check('0-sab: die Stelle fuer ' + SAB + ' ist genau einmal auffindbar', roh.split(paar[0]).length === 2,
      { treffer: roh.split(paar[0]).length - 1 });
    roh = roh.replace(paar[0], paar[1]);
  }
  fs.writeFileSync(QUELLE, roh);
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));

  const s = await starteServer();
  check('0: angemeldet', !!s.tok);
  const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.tok };
  const weltlage = async () => {
    const g = await s.j('/galaxy', { headers: auth });
    return (g.body && g.body.news) || [];
  };
  // NUR die Hort-Meldungen zaehlen, nicht alle. Gemessen beim ersten Lauf: Die Weltlage ist nie
  // leer und waechst waehrend des Tests von selbst - der Galaxie-Tick schreibt eigene Meldungen
  // (Fronten, Kriege). Eine absolute Zaehlung misst hier den Tick, nicht den Hort.
  //
  // Erkannt wird an der ART, nicht am Wortlaut. Ein Filter auf "Seltener Fund" waere genau die
  // zufaellige Momentaufnahme, vor der CLAUDE.md warnt: Eine umformulierte Meldung braeche ihn
  // lautlos - und mit ihm das Banner im Frontend, das dieselbe Frage stellt.
  const hortMeldungen = async () => (await weltlage()).filter(e => e && e.art === 'hort');

  // ---- 1: der Wurf und die Meldung ---------------------------------------------------------------
  const vorher = await hortMeldungen();
  check('1a-anker: es gibt noch keine Hort-Meldung', vorher.length === 0, { hortMeldungen: vorher.length });

  const r1 = await s.j('/expedition/hort', { method: 'POST', headers: auth,
    body: JSON.stringify({ res: 'erz', mult: 2 }) });
  check('1a: der Server sagt den Hort zu', r1.status === 200 && r1.body && r1.body.hort === true, r1.body);
  // Der Betrag muss aus der Leiterspitze stammen: 1.000.000 mal Streuung (0,85-1,15) mal mult 2.
  const b = (r1.body && r1.body.betrag) || 0;
  check('1b: der Betrag stammt aus der Leiterspitze, mit dem Multiplikator verrechnet',
    b >= 1000000 * 0.85 * 2 && b <= 1000000 * 1.15 * 2, { betrag: b });

  const nachher = await hortMeldungen();
  check('1c: die Weltlage traegt genau eine Hort-Meldung', nachher.length === 1, { hortMeldungen: nachher.length });
  const text = (nachher[0] && nachher[0].text) || '';
  // Der Spielername gehoert hinein - ohne ihn ist es keine Nachricht ueber einen Spieler, sondern
  // eine ueber niemanden. Und der Name kommt aus dem Token, nicht aus dem Rumpf der Anfrage.
  check('1c2: sie traegt die Art "hort", damit das Frontend sie nicht am Wortlaut erkennen muss',
    (nachher[0] || {}).art === 'hort', { art: (nachher[0] || {}).art });
  check('1d: die Meldung nennt den Spieler', /anna/.test(text), { text: text.slice(0, 160) });
  check('1e: sie nennt die Ressource', /Erz/.test(text), { text: text.slice(0, 160) });
  check('1f: sie nennt den Betrag', text.replace(/\./g, '').includes(String(b)), { betrag: b, text: text.slice(0, 160) });

  // ---- 2: die Grenze, um die es geht -------------------------------------------------------------
  // Der Client darf die Weltlage NICHT selbst beschreiben. db.galaxy ist fuer Clients gar nicht
  // erreichbar (CLAUDE.md: "wohnt in db.galaxy - fuer Clients gar nicht erreichbar"), und genau
  // deshalb ist die Meldung faelschungssicher. Gemessen statt geglaubt:
  const fremd = await s.j('/storage/galaxy?shared=true', { method: 'PUT', headers: auth,
    body: JSON.stringify({ value: JSON.stringify({ news: [{ id: 'x', time: Date.now(), icon: 'ti-trophy', text: 'Seltener Fund: anna hat 9.999.999 Erz entdeckt!' }] }) }) });
  const nachFremd = await hortMeldungen();
  // Der Schreibversuch selbst DARF angenommen werden - er landet in db.shared['galaxy'], einem
  // gewoehnlichen geteilten Schluessel. Entscheidend ist, dass er die Weltlage (db.galaxy) nicht
  // erreicht: Das sind zwei verschiedene Orte, und nur der zweite speist die Meldungen.
  check('2a: ein Client-Schreibversuch erreicht die Weltlage nicht',
    nachFremd.length === 1 && !/9\.999\.999/.test(JSON.stringify(nachFremd)),
    { status: fremd.status, hortMeldungen: nachFremd.length });

  // ---- 3: was der Server dem Client NICHT glaubt --------------------------------------------------
  const r3 = await s.j('/expedition/hort', { method: 'POST', headers: auth,
    body: JSON.stringify({ res: 'kristalle', mult: 999999 }) });
  const b3 = (r3.body && r3.body.betrag) || 0;
  // Nicht als Sicherheitsgrenze (der Fund landet ohnehin im klientenautoritativen Spielstand),
  // sondern als Anzeigegrenze: Ohne sie stuende in der Weltlage eine Zahl mit zwoelf Stellen.
  check('3a: ein absurder Multiplikator wird geklemmt', b3 > 0 && b3 <= 1000000 * 1.15 * 5, { betrag: b3 });

  const r3b = await s.j('/expedition/hort', { method: 'POST', headers: auth,
    body: JSON.stringify({ res: 'gold', mult: 1 }) });
  check('3b: eine unbekannte Ressource wird abgelehnt', r3b.status === 400, r3b);
  const nach3b = await hortMeldungen();
  check('3c: und hinterlaesst keine weitere Hort-Meldung', nach3b.length === 2, { hortMeldungen: nach3b.length });

  // ---- 4: ohne Anmeldung geht gar nichts ---------------------------------------------------------
  const r4 = await s.j('/expedition/hort', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ res: 'erz', mult: 1 }) });
  check('4a: ohne Token abgewiesen', r4.status === 401 || r4.status === 403, { status: r4.status });

  // ---- 5: der ausgelieferte Zustand schweigt -----------------------------------------------------
  // Der Schalter steht ausgeliefert auf false und wird erst im Frontend-PR umgelegt. Ob er wirklich
  // schuetzt, laesst sich an der ersten Kopie NICHT messen (dort ist er an) - deshalb hier eine
  // zweite Kopie, bei der nur die Chance hochgesetzt wird. Sagt sie trotzdem einen Hort zu, ginge
  // die Mechanik live, bevor das Frontend sie kennt.
  srv.kill('SIGTERM');
  await warte(600);
  let roh2 = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8').replace(chance, 'const HORT_START_CHANCE = 1;');
  if (SAB === 'offen') {
    const paar = sab.offen;
    check('0-sab2: die Stelle fuer offen ist in der zweiten Kopie auffindbar', roh2.split(paar[0]).length === 2);
    roh2 = roh2.replace(paar[0], paar[1]);
  }
  fs.writeFileSync(QUELLE, roh2);
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  const s2 = await starteServer();
  const auth2 = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s2.tok };
  const r5 = await s2.j('/expedition/hort', { method: 'POST', headers: auth2,
    body: JSON.stringify({ res: 'erz', mult: 2 }) });
  check('5a: mit ausgeschaltetem Schalter sagt der Server keinen Hort zu',
    r5.status === 200 && r5.body && r5.body.hort === false, r5.body);
  const g5 = await s2.j('/galaxy', { headers: auth2 });
  const meldungen5 = (((g5.body || {}).news) || []).filter(e => e && /Seltener Fund/.test(e.text || ''));
  check('5b: und schreibt nichts in die Weltlage', meldungen5.length === 0, { hortMeldungen: meldungen5.length });

  // ---- Auswertung der Gegenprobe -----------------------------------------------------------------
  // Gemessen, nicht erwartet: Was faellt wirklich? Die Liste steht hier, weil eine Pflichtliste
  // selbst eine Behauptung ist, bis sie gemessen wurde.
  const PFLICHT = { offen: ['5a'], ungeklemmt: ['3a'], stumm: ['1c'], fremdres: ['3b'], artlos: ['1c'] };
  if (SAB) {
    const muss = PFLICHT[SAB] || [];
    const fehlend = muss.filter(p => !gefallen.includes(p));
    console.log('\nSabotage "' + SAB + '": gefallen = [' + gefallen.join(', ') + ']');
    console.log('Pflichtliste = [' + muss.join(', ') + ']' + (fehlend.length ? '  FEHLT: ' + fehlend.join(', ') : '  vollstaendig'));
  }

  srv.kill('SIGTERM');
  await warte(500);
  console.log(fail ? '\nFAIL' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})();
