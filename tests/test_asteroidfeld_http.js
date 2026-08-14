// Echter HTTP-Test: das geteilte Asteroidenfeld (Konzept docs/asteroiden-konzept.md 3.3.2/6.4,
// Phase 4, Schritt 1). Startet einen echten Server gegen eine eigene Test-DB und spricht die neuen
// Endpunkte an - kein Nachbau, keine Attrappe.
//
//   node tests/test_asteroidfeld_http.js
//
// Der Test startet den Server SELBST (Muster von test_geteilter_speicher_http.js) statt eine
// Bash-Orchestrierung zu verlangen. Grund: Serverstart und Test müssen im selben Aufruf laufen,
// sonst verliert die Sandbox den Hintergrundprozess (CLAUDE.md, Punkt 2 der Commit-Pflichten) -
// und ein Test, dessen Ausführung eine mehrzeilige Anleitung braucht, wird beim nächsten Mal
// übersprungen. Port 3212: 3195-3199 und 3210/3211 sind belegt (CLAUDE.md-Arbeitsregel 29).
//
// DIE ZUSAGE, die dieser Test trägt: **Derselbe Brocken kann nicht zweimal verkauft werden.** Das
// ist der ganze Grund, warum der Vorrat serverseitig geführt wird und die Entnahme beim START
// passiert. Punkt 3d ist deshalb der Kern: Zwei Spieler holen nacheinander vom selben Vorkommen,
// und die Summe darf den Ausgangsvorrat nicht übersteigen.
//
// GEPRUEFT WIRD:
//   1. Das Feld entsteht beim ersten Lesen, hat 20 Gürtelsysteme mit je 4-6 Vorkommen, und ein
//      zweiter Abruf durch einen ANDEREN Spieler liefert dasselbe - es wird gespeichert, nicht bei
//      jedem Blick neu gewürfelt.
//   2. Ohne Anmeldung geht gar nichts.
//   3. Entnahme: Der Vorrat sinkt um genau die entnommene Menge, und wer als Zweiter kommt,
//      bekommt nur den Rest - nicht seinen Wunsch.
//   4. Die Obergrenze aus der GESPEICHERTEN Flotte greift: ohne Minenschiff nichts, mit einem
//      Minenschiff höchstens dessen Schranke, egal was der Client wünscht.
//   5. Ein leergefördertes Vorkommen verschwindet und bekommt einen Nachschub-Termin in der Zukunft.
//   6. Unsinnige Anfragen werden abgelehnt.
//   7. Das Feld liegt wirklich im geteilten Speicher der Datenbank.
//
// GEGENPROBE (in beide Richtungen ausgeführt): Gegen den alten server.js antworten beide Endpunkte
// mit 404 - 1a fällt sofort. Ersetzt man die Klemmung `Math.min(wunsch, vork.vorrat, obergrenze)`
// durch `wunsch`, fallen 3c/3d (Summe > Ausgangsvorrat) und 4b.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3212;

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ANNA = crypto.randomUUID(), BERT = crypto.randomUUID(), CARL = crypto.randomUUID();

function spielstand(id, name, fleet) {
  return JSON.stringify({
    resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {},
    fleet: Object.assign({ missions: [] }, fleet),
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  });
}
function grunddb() {
  return {
    users: {
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() },
      bert: { userId: BERT, username: 'bert', passwordHash: hash, createdAt: Date.now() },
      carl: { userId: CARL, username: 'carl', passwordHash: hash, createdAt: Date.now() }
    },
    private: {
      [ANNA]: { 'kepler7-save-v3': spielstand(ANNA, 'anna', { schuerfschiff: 200 }) },
      [BERT]: { 'kepler7-save-v3': spielstand(BERT, 'bert', { schuerfschiff: 2000 }) },
      [CARL]: { 'kepler7-save-v3': spielstand(CARL, 'carl', { jaeger: 500 }) }
    },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {} }
  };
}

async function starteServer() {
  const dbPfad = path.join(os.tmpdir(), 'kepler-asteroid-' + process.pid + '.json');
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  let log = '';
  const srv = spawn(process.execPath, [path.join(WURZEL, 'server.js')], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, { DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
  const basis = 'http://127.0.0.1:' + PORT + '/api';
  const ende = () => { try { srv.kill(); } catch (e) {} try { fs.unlinkSync(dbPfad); } catch (e) {} };
  process.on('exit', ende);
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
  const dbLesen = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
  return { j, anmelden, dbLesen, ende, protokoll: () => log };
}

(async () => {
  const s = await starteServer();
  const tokenA = await s.anmelden('anna');
  const tokenB = await s.anmelden('bert');
  const tokenC = await s.anmelden('carl');
  check('0: drei Konten angemeldet', !!tokenA && !!tokenB && !!tokenC);
  if (!tokenA || !tokenB || !tokenC) { console.log(s.protokoll().slice(-1500)); console.log('\nFAIL'); process.exit(1); }
  const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });

  // ---- 2) Ohne Anmeldung geht nichts -------------------------------------------------------
  const ohne = await s.j('/asteroid/field');
  check('2a: Feld lesen ohne Anmeldung wird abgewiesen', ohne.status === 401 || ohne.status === 403, ohne.status);
  const ohne2 = await s.j('/asteroid/mine', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system: 'kepler', platz: '0', wunsch: 100 }) });
  check('2b: Entnahme ohne Anmeldung wird abgewiesen', ohne2.status === 401 || ohne2.status === 403, ohne2.status);

  // ---- 1) Das Feld entsteht und bleibt -----------------------------------------------------
  const f1 = await s.j('/asteroid/field', { headers: kopf(tokenA) });
  check('1a: Feld wird geliefert', f1.status === 200 && !!(f1.body && f1.body.felder), { status: f1.status, body: f1.status !== 200 ? f1.body : undefined });
  if (f1.status !== 200) { console.log(s.protokoll().slice(-1500)); console.log('\nFAIL'); process.exit(1); }
  const systeme = f1.body.systeme || [];
  check('1b: 20 Gürtelsysteme', systeme.length === 20, systeme.length);
  const belegt = (felder, sys) => Object.values((felder[sys] || {}).plaetze || {}).filter(p => p && !p.frei).length;
  const zahlen = systeme.map(x => belegt(f1.body.felder, x));
  check('1c: jedes Gürtelsystem trägt 4-6 Vorkommen',
    zahlen.length === 20 && zahlen.every(n => n >= 4 && n <= 6), { min: Math.min(...zahlen), max: Math.max(...zahlen) });
  const gesamt = zahlen.reduce((a, b) => a + b, 0);
  check('1d: galaxieweit 80-120 Vorkommen', gesamt >= 80 && gesamt <= 120, gesamt);
  const alle = systeme.flatMap(x => Object.values(f1.body.felder[x].plaetze)).filter(p => p && !p.frei);
  check('1e: jedes Vorkommen hat Sorte, Größe und Vorrat',
    alle.length > 0 && alle.every(p => typeof p.sorte === 'string' && typeof p.groesse === 'string' && p.vorrat > 0),
    alle.filter(p => !(typeof p.sorte === 'string' && typeof p.groesse === 'string' && p.vorrat > 0)).slice(0, 2));
  const f2 = await s.j('/asteroid/field', { headers: kopf(tokenB) });
  check('1f: ein zweiter Abruf durch einen anderen Spieler liefert DASSELBE Feld',
    JSON.stringify(f2.body.felder) === JSON.stringify(f1.body.felder));

  // ---- 3) Entnahme, und der Brocken wird nicht zweimal verkauft ------------------------------
  let zielSys = null, zielPlatz = null, startVorrat = 0;
  for (const x of systeme) for (const [platz, p] of Object.entries(f1.body.felder[x].plaetze)) {
    if (p && !p.frei && p.vorrat > startVorrat) { zielSys = x; zielPlatz = platz; startVorrat = p.vorrat; }
  }
  check('3-0: ein Vorkommen zum Abbauen gefunden', !!zielSys && startVorrat > 0, { zielSys, zielPlatz, startVorrat });

  // Die Flotten JETZT auf das gefundene Vorkommen auslegen, statt sie im Grundstand zu raten: Die
  // Obergrenze des Servers hängt an der gespeicherten Flotte, und ein zu kleiner Grundstand hätte
  // gemessen, wie gut die Schranke greift - nicht, ob die Buchführung stimmt (Arbeitsregel 7:
  // messen, was gemessen werden soll, nicht den Deckel).
  const drittel = Math.floor(startVorrat / 3);
  const schiffeFuer = menge => Math.ceil(menge / 2000) + 1;   // AST_MAX_JE_SCHUERFSCHIFF = 2000
  await s.j('/storage/kepler7-save-v3', { method: 'PUT', headers: kopf(tokenA),
    body: JSON.stringify({ value: spielstand(ANNA, 'anna', { schuerfschiff: schiffeFuer(drittel) }) }) });
  await s.j('/storage/kepler7-save-v3', { method: 'PUT', headers: kopf(tokenB),
    body: JSON.stringify({ value: spielstand(BERT, 'bert', { schuerfschiff: schiffeFuer(startVorrat * 2) }) }) });
  const m1 = await s.j('/asteroid/mine', { method: 'POST', headers: kopf(tokenA),
    body: JSON.stringify({ system: zielSys, platz: zielPlatz, wunsch: drittel }) });
  check('3a: erste Entnahme geht durch und liefert genau den Wunsch',
    m1.status === 200 && m1.body.menge === drittel, { status: m1.status, menge: m1.body && m1.body.menge, wunsch: drittel });
  check('3b: der Server meldet den Restvorrat',
    m1.body && m1.body.rest === startVorrat - drittel, { rest: m1.body && m1.body.rest, erwartet: startVorrat - drittel });

  // Der Zweite will MEHR, als noch dasteht. Er darf nur den Rest bekommen.
  const m2 = await s.j('/asteroid/mine', { method: 'POST', headers: kopf(tokenB),
    body: JSON.stringify({ system: zielSys, platz: zielPlatz, wunsch: startVorrat * 2 }) });
  check('3c: der Zweite bekommt nur den Rest, nicht seinen Wunsch',
    m2.status === 200 && m2.body.menge === startVorrat - drittel,
    { menge: m2.body && m2.body.menge, erwartet: startVorrat - drittel });
  const summe = (m1.body.menge || 0) + ((m2.body && m2.body.menge) || 0);
  check('3d: DER KERN - zusammen nie mehr als der Ausgangsvorrat', summe <= startVorrat, { summe, startVorrat });

  // ---- 5) Erschöpft: Platz weg, Nachschub-Termin in der Zukunft ------------------------------
  const f3 = await s.j('/asteroid/field', { headers: kopf(tokenA) });
  const nachher = f3.body.felder[zielSys].plaetze[zielPlatz];
  check('5a: das leergeförderte Vorkommen ist weg und hat einen Nachschub-Termin',
    !!nachher && nachher.frei === true && nachher.nachschubAb > Date.now(), nachher);
  const m3 = await s.j('/asteroid/mine', { method: 'POST', headers: kopf(tokenA),
    body: JSON.stringify({ system: zielSys, platz: zielPlatz, wunsch: 100 }) });
  check('5b: eine weitere Entnahme dort wird abgelehnt', m3.status === 409 && m3.body.weg === true, { status: m3.status, body: m3.body });

  // ---- 4) Die Obergrenze aus der gespeicherten Flotte ----------------------------------------
  let sys2 = null, platz2 = null, vorrat2 = 0;
  for (const x of systeme) for (const [platz, p] of Object.entries(f3.body.felder[x].plaetze)) {
    if (p && !p.frei && p.vorrat > vorrat2) { sys2 = x; platz2 = platz; vorrat2 = p.vorrat; }
  }
  // carl hat nur Jäger im gespeicherten Stand - kein Minenschiff, also nichts zu holen.
  const ohneSchiff = await s.j('/asteroid/mine', { method: 'POST', headers: kopf(tokenC),
    body: JSON.stringify({ system: sys2, platz: platz2, wunsch: vorrat2 }) });
  check('4a: ohne Minenschiff im gespeicherten Spielstand wird abgelehnt',
    ohneSchiff.status === 403, { status: ohneSchiff.status, body: ohneSchiff.body });
  // Genau EIN Minenschiff: Der Client fordert das ganze Vorkommen an, bekommen darf er höchstens
  // die Schranke dieses einen Schiffs. Das ist die Sperre gegen "ein Schiff saugt einen Kern leer".
  const setz = await s.j('/storage/kepler7-save-v3', { method: 'PUT', headers: kopf(tokenC),
    body: JSON.stringify({ value: spielstand(CARL, 'carl', { schuerfschiff: 1 }) }) });
  check('4b-vorab: der Spielstand mit einem Minenschiff wurde angenommen', setz.status === 200, setz.status);
  const gedeckelt = await s.j('/asteroid/mine', { method: 'POST', headers: kopf(tokenC),
    body: JSON.stringify({ system: sys2, platz: platz2, wunsch: vorrat2 }) });
  check('4b: ein einzelnes Minenschiff kann kein ganzes Vorkommen leersaugen',
    gedeckelt.status === 200 && gedeckelt.body.menge <= 2000 && gedeckelt.body.menge < vorrat2,
    { menge: gedeckelt.body && gedeckelt.body.menge, vorrat: vorrat2 });

  // ---- 6) Unsinn wird abgelehnt --------------------------------------------------------------
  const fremd = await s.j('/asteroid/mine', { method: 'POST', headers: kopf(tokenA),
    body: JSON.stringify({ system: 'gibtesnicht', platz: '0', wunsch: 10 }) });
  check('6a: ein System, das es nicht gibt, wird abgelehnt', fremd.status === 400, fremd.status);
  const keinGuertel = (['kepler','vega','orion','nebel'].find(x => systeme.indexOf(x) < 0)) || 'gibtesnicht2';
  const ohneGuertel = await s.j('/asteroid/mine', { method: 'POST', headers: kopf(tokenA),
    body: JSON.stringify({ system: keinGuertel, platz: '0', wunsch: 10 }) });
  check('6b: ein System ohne Gürtel wird abgelehnt', ohneGuertel.status === 400, { system: keinGuertel, status: ohneGuertel.status });
  for (const [name, wunsch] of [['0', 0], ['negativ', -5000], ['Text', 'viel']]) {
    const r = await s.j('/asteroid/mine', { method: 'POST', headers: kopf(tokenA),
      body: JSON.stringify({ system: sys2, platz: platz2, wunsch }) });
    check('6c: Wunschmenge "' + name + '" wird abgelehnt', r.status === 400, r.status);
  }
  const leererPlatz = await s.j('/asteroid/mine', { method: 'POST', headers: kopf(tokenA),
    body: JSON.stringify({ system: sys2, platz: '99', wunsch: 10 }) });
  check('6d: ein Platz, den es nicht gibt, wird abgelehnt', leererPlatz.status === 409, leererPlatz.status);

  // ---- 7) Das Feld liegt wirklich in der Datenbank -------------------------------------------
  await warte(900);   // saveDb() bündelt Schreibvorgänge
  const db = s.dbLesen();
  const schluessel = Object.keys(db.shared || {}).filter(k => k.startsWith('asteroids:'));
  check('7a: alle 20 Felder stehen unter asteroids:<system> in der DB', schluessel.length === 20, schluessel.length);
  // Und der Server hat NICHT in den Spielstand geschrieben - er führt nur den geteilten Vorrat.
  const standA = JSON.parse(db.private[ANNA]['kepler7-save-v3'].value || db.private[ANNA]['kepler7-save-v3']);
  check('7b: der Server hat den Spielstand des Abbauenden nicht angefasst',
    !standA.asteroidFeld && (standA.resources.erz === 5e5), { erz: standA.resources.erz });

  s.ende();
  console.log(fail ? '\nFAIL' : '\nPASS');
  process.exit(fail ? 1 : 0);
})();
