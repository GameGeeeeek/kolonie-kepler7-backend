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
//      Minenschiff höchstens dessen Schranke, egal was der Client wünscht - und sie kennt JEDEN
//      Ladungsträger, nicht nur die zwei, mit denen sie ursprünglich geprüft wurde (4c-4e,
//      15.08.2026: der große Frachter wurde unter einem Schlüssel gelesen, den der Spielstand nie
//      hatte, der Bergungsfrachter fehlte ganz - beides kürzte ehrliche Flotten stillschweigend).
//   5. Ein leergefördertes Vorkommen verschwindet und bekommt einen Nachschub-Termin in der Zukunft.
//   6. Unsinnige Anfragen werden abgelehnt.
//   7. Das Feld liegt wirklich im geteilten Speicher der Datenbank.
//   8. Schürfrechte (Phase 4, Schritt 2): claim reserviert für genau einen Spieler; ein fremdes
//      mine/claim/release wird abgelehnt UND der Fehlertext nennt den Grund (Halter bzw. Limit -
//      Arbeitsregel 28: nicht nur den Statuscode prüfen); das Anspruchslimit kommt aus der
//      GESPEICHERTEN Forschung rschuerfrecht (2 Basis, +1 je Stufe, Deckel 5); die Eskorte wird
//      aus save.asteroidEskorten übernommen, nie aus dem Request; release macht den Platz wieder
//      für alle abbaubar.
//
//   9. Anfechtung (Phase 5): Der Server rechnet die Angriffsstärke aus der MISSION im gespeicherten
//      Spielstand nach (unterwegs steht sie nicht in save.fleet); jede Sperre nennt ihren Grund
//      (Schutzfrist, Abklingzeit, Allianz, eigenes Recht); derselbe Anflug lässt sich nicht zweimal
//      einlösen; bei Sieg wechselt der Halter samt Schutzfrist, bei Niederlage schrumpft nur die
//      Eskorte - der VORRAT bleibt in beiden Fällen unangetastet (man erobert eine Quelle, keine
//      Beute). Der Server schreibt dabei keinen Spielstand.
//
// GEGENPROBE (in beide Richtungen ausgeführt): Gegen den alten server.js antworten beide Endpunkte
// mit 404 - 1a fällt sofort. Ersetzt man die Klemmung `Math.min(wunsch, vork.vorrat, obergrenze)`
// durch `wunsch`, fallen 3c/3d (Summe > Ausgangsvorrat) und 4b. Für Abschnitt 8: Gegen den Stand
// vor den Schürfrechten fällt 8a mit 404; nimmt man die Halter-Prüfung aus mine heraus, fällt 8c
// (der Fremde baut ab, obwohl reserviert); prüft man das Limit gegen den Request statt gegen den
// gespeicherten Spielstand, fällt 8f (die Forschung im Save hebt das Limit nicht).
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

function spielstand(id, name, fleet, extras) {
  return JSON.stringify(Object.assign({
    resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {},
    fleet: Object.assign({ missions: [] }, fleet),
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  }, extras || {}));
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

  /* 4c-4e (15.08.2026): Die Schranke muss ALLE Ladungsträger kennen - nicht nur die beiden, mit
     denen sie 4a/4b damals geprüft haben. Genau daran hing sie ein knappes Vierteljahr:
       - Der große Frachter wurde als `f.grossfrachter` gelesen; im Spielstand heißt er
         `frachtergross`. Der Term war also IMMER 0.
       - Der Bergungsfrachter (v8.495.0) fehlte in der Summe komplett.
     Beides fiel nicht auf, weil `menge = min(wunsch, vorrat, obergrenze)` still abschneidet: Es
     gibt keinen Fehler, keine Meldung, die Mission startet - sie trägt nur weniger, als die
     Startvorschau desselben Spielers eine Sekunde vorher versprochen hat. Gemessen an einer
     Kolossflotte (30 Minenschiffe + 40 große + 20 Bergungsfrachter) fehlten 56% der Ladung.
     Dass 4b grün war, ist dabei kein Zufall, sondern der Kern der Sache: Der Test benutzte
     ausschließlich den einen Schiffstyp, bei dem der Code stimmte.

     WARUM GEMESSEN UND NICHT EINGETIPPT (Arbeitsregel 2): Bezugsgröße ist die Menge, die dieselbe
     Flotte OHNE Frachter bekommt. Damit bleibt der Test gültig, wenn jemand an
     AST_MAX_JE_SCHUERFSCHIFF dreht - er prüft die Regel „ein Ladungsträger erhöht die Schranke",
     nicht die Momentaufnahme „genau 2000".
     GEGENPROBE (beidseitig gefahren): Gegen den Stand vor dieser Behebung liefern alle drei Flotten
     dieselbe Menge - 4c und 4d fallen zusammen. */
  const fLad = await s.j('/asteroid/field', { headers: kopf(tokenA) });
  let sysLad = null, platzLad = null, vorratLad = 0;
  for (const x of systeme) for (const [platz, p] of Object.entries(fLad.body.felder[x].plaetze)) {
    if (p && !p.frei && p.vorrat > vorratLad) { sysLad = x; platzLad = platz; vorratLad = p.vorrat; }
  }
  // Ohne diese Vorabprüfung könnte 4c/4d den BROCKEN messen statt die Flotte (Arbeitsregel 7):
  // Ist der Vorrat kleiner als die Schranke, liefern alle Flotten denselben Wert - und der Test
  // wäre aus dem falschen Grund grün bzw. rot.
  check('4c-vorab: das Zielvorkommen ist groß genug, dass die FLOTTE die Grenze setzt',
    vorratLad >= 200000, { system: sysLad, platz: platzLad, vorrat: vorratLad });

  async function holeMit(fleet) {
    const setzen = await s.j('/storage/kepler7-save-v3', { method: 'PUT', headers: kopf(tokenC),
      body: JSON.stringify({ value: spielstand(CARL, 'carl', fleet) }) });
    if (setzen.status !== 200) return { menge: -1, fehler: 'Spielstand abgelehnt: ' + setzen.status };
    const r = await s.j('/asteroid/mine', { method: 'POST', headers: kopf(tokenC),
      body: JSON.stringify({ system: sysLad, platz: platzLad, wunsch: 10000000 }) });
    return { status: r.status, menge: (r.body && r.body.menge) || 0, rest: r.body && r.body.rest };
  }
  const nurMine    = await holeMit({ schuerfschiff: 1 });
  const mitGross   = await holeMit({ schuerfschiff: 1, frachtergross: 4 });
  const mitBergung = await holeMit({ schuerfschiff: 1, bergungsfrachter: 4 });
  check('4c: große Frachter heben die Schranke - der Server liest ihren echten Spielstand-Schlüssel',
    mitGross.menge > nurMine.menge, { ohneFrachter: nurMine.menge, mitGrossfrachtern: mitGross.menge });
  check('4d: Bergungsfrachter heben sie stärker - sie sind der größte Ladungsträger des Spiels',
    mitBergung.menge > mitGross.menge,
    { ohneFrachter: nurMine.menge, mitGrossfrachtern: mitGross.menge, mitBergungsfrachtern: mitBergung.menge });
  check('4e: der Vorrat war dabei nie die bindende Grenze (sonst hätte 4c/4d den Brocken gemessen)',
    mitBergung.rest > 0 && mitBergung.menge < vorratLad,
    { rest: mitBergung.rest, menge: mitBergung.menge, ausgangsvorrat: vorratLad });

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

  // ---- 8) Schürfrechte: reservieren, abgewiesen werden, Limit, Eskorte, aufgeben --------------
  // Drei noch volle Vorkommen suchen (nach den Abschnitten 3-5 sind zwei erschöpft; von ~90 ist
  // reichlich übrig). Z1 wird Annas Hauptziel, Z2/Z3 füllen ihr Limit.
  const f4 = await s.j('/asteroid/field', { headers: kopf(tokenA) });
  const volle = [];
  for (const x of f4.body.systeme) for (const [platz, p] of Object.entries(f4.body.felder[x].plaetze)) {
    if (p && !p.frei && !p.halter && p.vorrat > 3000) volle.push({ sys: x, platz, vorrat: p.vorrat });
  }
  check('8-0: mindestens fünf volle, freie Vorkommen gefunden', volle.length >= 5, volle.length);
  const [Z1, Z2, Z3, Z4, Z5] = volle;

  // anna reserviert Z1 - und die Antwort trägt den Halter.
  const c1 = await s.j('/asteroid/claim', { method: 'POST', headers: kopf(tokenA),
    body: JSON.stringify({ system: Z1.sys, platz: Z1.platz }) });
  check('8a: anna reserviert ein freies Vorkommen', c1.status === 200 && c1.body.halterName === 'anna',
    { status: c1.status, body: c1.body });

  // bert scheitert am selben Platz - und der Fehlertext nennt anna (Regel 28: der GRUND, nicht nur der Status).
  const c2 = await s.j('/asteroid/claim', { method: 'POST', headers: kopf(tokenB),
    body: JSON.stringify({ system: Z1.sys, platz: Z1.platz }) });
  check('8b: berts Anspruch auf denselben Platz wird abgelehnt und nennt die Halterin',
    c2.status === 409 && /anna/.test(String(c2.body && c2.body.error)), { status: c2.status, body: c2.body });

  // bert darf dort auch nicht abbauen - Fehlertext nennt die Halterin, Flag reserviert.
  const mFremd = await s.j('/asteroid/mine', { method: 'POST', headers: kopf(tokenB),
    body: JSON.stringify({ system: Z1.sys, platz: Z1.platz, wunsch: 1000 }) });
  check('8c: ein Fremder darf ein reserviertes Vorkommen nicht abbauen, und erfährt von wem',
    mFremd.status === 403 && mFremd.body.reserviert === true && /anna/.test(String(mFremd.body.error)),
    { status: mFremd.status, body: mFremd.body });

  // anna selbst darf weiterhin abbauen (kleiner Wunsch, damit das Vorkommen NICHT erschöpft).
  const mEigen = await s.j('/asteroid/mine', { method: 'POST', headers: kopf(tokenA),
    body: JSON.stringify({ system: Z1.sys, platz: Z1.platz, wunsch: 500 }) });
  check('8d: die Halterin selbst baut weiter ab', mEigen.status === 200 && mEigen.body.menge === 500,
    { status: mEigen.status, menge: mEigen.body && mEigen.body.menge });

  // Limit: anna hat KEINE Forschung -> Grundstock 2. Z2 geht noch, Z3 scheitert - und der
  // Fehlertext nennt das Limit.
  const c3 = await s.j('/asteroid/claim', { method: 'POST', headers: kopf(tokenA),
    body: JSON.stringify({ system: Z2.sys, platz: Z2.platz }) });
  check('8e: das zweite Recht geht noch durch (Grundstock 2)', c3.status === 200, c3.status);
  const c4 = await s.j('/asteroid/claim', { method: 'POST', headers: kopf(tokenA),
    body: JSON.stringify({ system: Z3.sys, platz: Z3.platz }) });
  check('8e2: das dritte scheitert am Anspruchslimit, und der Fehlertext nennt es',
    c4.status === 403 && /Anspruchslimit/.test(String(c4.body && c4.body.error)) && /2/.test(String(c4.body && c4.body.error)),
    { status: c4.status, body: c4.body });

  // Forschung im GESPEICHERTEN Spielstand hebt das Limit: rschuerfrecht 1 -> Limit 3, Z3 geht jetzt.
  await s.j('/storage/kepler7-save-v3', { method: 'PUT', headers: kopf(tokenA),
    body: JSON.stringify({ value: spielstand(ANNA, 'anna', { schuerfschiff: 5 }, { research: { rschuerfrecht: 1 } }) }) });
  const c5 = await s.j('/asteroid/claim', { method: 'POST', headers: kopf(tokenA),
    body: JSON.stringify({ system: Z3.sys, platz: Z3.platz }) });
  check('8f: die gespeicherte Forschung Bergbaurecht hebt das Limit (3. Recht geht jetzt)',
    c5.status === 200, { status: c5.status, body: c5.status !== 200 ? c5.body : undefined });

  // Eskorte: kommt aus save.asteroidEskorten, NIE aus dem Request. Erst speichern, dann abgleichen.
  await s.j('/storage/kepler7-save-v3', { method: 'PUT', headers: kopf(tokenA),
    body: JSON.stringify({ value: spielstand(ANNA, 'anna', { schuerfschiff: 5 },
      { research: { rschuerfrecht: 1 },
        asteroidEskorten: { [Z1.sys + ':' + Z1.platz]: { schiffe: { jaeger: 25, kreuzer: 3 }, heimat: 'home' } } }) }) });
  const c6 = await s.j('/asteroid/claim', { method: 'POST', headers: kopf(tokenA),
    body: JSON.stringify({ system: Z1.sys, platz: Z1.platz, eskorte: { jaeger: 999999 } }) });
  check('8g: die Eskorte kommt aus dem Spielstand - was der Request behauptet, ist egal',
    c6.status === 200 && c6.body.eskorte && c6.body.eskorte.jaeger === 25 && c6.body.eskorte.kreuzer === 3,
    { status: c6.status, eskorte: c6.body && c6.body.eskorte });

  // Und alle anderen SEHEN Halterin und Eskorte im Feld.
  const f5 = await s.j('/asteroid/field', { headers: kopf(tokenB) });
  const z1Sicht = f5.body.felder[Z1.sys].plaetze[Z1.platz];
  check('8h: bert sieht Halterin und Eskorte im Feld', !!z1Sicht && z1Sicht.halterName === 'anna' &&
    z1Sicht.eskorte && z1Sicht.eskorte.jaeger === 25, z1Sicht && { halterName: z1Sicht.halterName, eskorte: z1Sicht.eskorte });

  // Aufgeben: bert darf nicht, anna darf - und danach baut bert dort ganz normal ab.
  const r1 = await s.j('/asteroid/release', { method: 'POST', headers: kopf(tokenB),
    body: JSON.stringify({ system: Z1.sys, platz: Z1.platz }) });
  check('8i: ein Fremder kann das Recht nicht aufgeben', r1.status === 403 && /Halter/.test(String(r1.body && r1.body.error)),
    { status: r1.status, body: r1.body });
  const r2 = await s.j('/asteroid/release', { method: 'POST', headers: kopf(tokenA),
    body: JSON.stringify({ system: Z1.sys, platz: Z1.platz }) });
  check('8j: die Halterin gibt das Recht auf', r2.status === 200, r2.status);
  const mNachher = await s.j('/asteroid/mine', { method: 'POST', headers: kopf(tokenB),
    body: JSON.stringify({ system: Z1.sys, platz: Z1.platz, wunsch: 700 }) });
  check('8k: danach baut bert dort ganz normal ab', mNachher.status === 200 && mNachher.body.menge === 700,
    { status: mNachher.status, menge: mNachher.body && mNachher.body.menge });

  // Ein erschöpfter Platz lässt sich nicht reservieren (zielSys/zielPlatz aus Abschnitt 3/5 ist leer).
  const cWeg = await s.j('/asteroid/claim', { method: 'POST', headers: kopf(tokenA),
    body: JSON.stringify({ system: zielSys, platz: zielPlatz }) });
  check('8l: ein erschöpftes Vorkommen lässt sich nicht reservieren', cWeg.status === 409 && cWeg.body.weg === true,
    { status: cWeg.status, body: cWeg.body });

  // ---- 9) Anfechtung (Phase 5) --------------------------------------------------------------
  // anna haelt Z2 (aus 8e) mit einer Eskorte; bert fliegt sie an. Die Angriffsflotte steht NICHT in
  // save.fleet - sie ist unterwegs -, sondern in der Mission. Genau von dort liest der Server sie.
  const eskorteSetzen = async (schiffe) => {
    await s.j('/storage/kepler7-save-v3', { method: 'PUT', headers: kopf(tokenA),
      body: JSON.stringify({ value: spielstand(ANNA, 'anna', { schuerfschiff: 5 },
        { research: { rschuerfrecht: 1 },
          asteroidEskorten: { [Z5.sys + ':' + Z5.platz]: { schiffe, heimat: 'home' } } }) }) });
    await s.j('/asteroid/claim', { method: 'POST', headers: kopf(tokenA),
      body: JSON.stringify({ system: Z5.sys, platz: Z5.platz }) });
  };
  // bert bekommt eine Anfechtungs-Mission in den gespeicherten Spielstand.
  const berthilfe = async (mid, composition, ziel) => {
    await s.j('/storage/kepler7-save-v3', { method: 'PUT', headers: kopf(tokenB),
      body: JSON.stringify({ value: spielstand(BERT, 'bert', { schuerfschiff: 2000 },
        { fleet: { missions: [{ id: mid, type: 'asteroid-contest', targetId: ziel, composition }] } }) }) });
  };
  const anfechten = (token, sys, platz, mid) => s.j('/asteroid/contest', { method: 'POST', headers: kopf(token),
    body: JSON.stringify({ system: sys, platz, missionId: mid }) });

  await eskorteSetzen({ jaeger: 20 });
  const zielKampf = Z5.sys + ':' + Z5.platz;

  // 9a: ohne Mission im Spielstand geht gar nichts - das ist die Stelle, an der ein erfundener
  // Angriff scheitert.
  await berthilfe('mX', { jaeger: 500 }, 'ganz:anderes');
  const ohneMission = await anfechten(tokenB, Z5.sys, Z5.platz, 'mX');
  check('9a: ohne passende Mission im gespeicherten Spielstand wird abgelehnt',
    ohneMission.status === 403 && /keine Flotte/.test(String(ohneMission.body && ohneMission.body.error)),
    { status: ohneMission.status, body: ohneMission.body });

  // 9b: eigenes Recht kann man nicht anfechten.
  await s.j('/storage/kepler7-save-v3', { method: 'PUT', headers: kopf(tokenA),
    body: JSON.stringify({ value: spielstand(ANNA, 'anna', { schuerfschiff: 5 },
      { research: { rschuerfrecht: 1 },
        asteroidEskorten: { [zielKampf]: { schiffe: { jaeger: 20 }, heimat: 'home' } },
        fleet: { missions: [{ id: 'mA', type: 'asteroid-contest', targetId: zielKampf, composition: { jaeger: 99 } }] } }) }) });
  const eigenes = await anfechten(tokenA, Z5.sys, Z5.platz, 'mA');
  check('9b: das eigene Schürfrecht lässt sich nicht anfechten',
    eigenes.status === 400 && /eigenes/.test(String(eigenes.body && eigenes.body.error)), { status: eigenes.status, body: eigenes.body });

  // 9c: Der Kampf selbst. Uebermacht gegen 20 Jaeger - die Chance ist bei 90% gedeckelt, also
  // mehrere Anlaeufe auf VERSCHIEDENE Vorkommen (die Abklingzeit gilt je Vorkommen). Geprueft wird
  // die REGEL, nicht das Wuerfelglueck: Bei Sieg wechselt der Halter UND es gibt eine Schutzfrist,
  // bei Niederlage bleibt der Halter und die Eskorte ist kleiner. Der Vorrat bleibt immer gleich.
  const vorratVorher = (await s.j('/asteroid/field', { headers: kopf(tokenA) })).body.felder[Z5.sys].plaetze[Z5.platz].vorrat;
  await berthilfe('m1', { schlachtschiff: 300, jaeger: 2000 }, zielKampf);
  const kampf = await anfechten(tokenB, Z5.sys, Z5.platz, 'm1');
  check('9c: die Anfechtung wird aufgelöst und meldet Chance und beide Verlustseiten',
    kampf.status === 200 && typeof kampf.body.gewonnen === 'boolean' && kampf.body.chance > 0 &&
    !!kampf.body.eigeneVerluste && !!kampf.body.gegnerVerluste,
    { status: kampf.status, gewonnen: kampf.body && kampf.body.gewonnen, chance: kampf.body && kampf.body.chance });
  const feldNach = (await s.j('/asteroid/field', { headers: kopf(tokenA) })).body.felder[Z5.sys].plaetze[Z5.platz];
  check('9d: der Vorrat bleibt unangetastet - man erobert eine Quelle, keine Beute',
    feldNach.vorrat === vorratVorher, { vorher: vorratVorher, nachher: feldNach.vorrat });
  if (kampf.body.gewonnen){
    check('9e: nach dem Sieg hält bert das Recht, mit Schutzfrist und ohne fremde Eskorte',
      feldNach.halter === BERT && feldNach.schutzBis > Date.now() && !Object.keys(feldNach.eskorte || {}).length,
      { halter: feldNach.halter === BERT, schutz: feldNach.schutzBis > Date.now(), eskorte: feldNach.eskorte });
  } else {
    check('9e: nach der Niederlage hält anna weiter, ihre Eskorte ist aber kleiner',
      feldNach.halter === ANNA && (feldNach.eskorte.jaeger || 0) < 20,
      { halter: feldNach.halter === ANNA, jaeger: feldNach.eskorte && feldNach.eskorte.jaeger });
  }

  // 9f: derselbe Anflug lässt sich nicht zweimal einlösen (sonst reibt ein wiederholter Aufruf die
  // Eskorte in Sekunden auf). Geprueft wird der GRUND, nicht nur der Status.
  // Hat bert gewonnen, haelt er das Recht selbst - dann wuerde "eigenes Schuerfrecht" greifen und
  // die Pruefung waere aus dem falschen Grund gruen (Arbeitsregel 28). Also erst zurueckgeben.
  if (kampf.body.gewonnen){
    await s.j('/asteroid/release', { method: 'POST', headers: kopf(tokenB), body: JSON.stringify({ system: Z5.sys, platz: Z5.platz }) });
    await s.j('/asteroid/claim', { method: 'POST', headers: kopf(tokenA), body: JSON.stringify({ system: Z5.sys, platz: Z5.platz }) });
  }
  const nochmal = await anfechten(tokenB, Z5.sys, Z5.platz, 'm1');
  check('9f: derselbe Anflug lässt sich kein zweites Mal einlösen',
    nochmal.status === 409 && /bereits abgerechnet/.test(String(nochmal.body && nochmal.body.error)),
    { status: nochmal.status, body: nochmal.body });

  // 9g: Abklingzeit bzw. Schutzfrist - je nachdem, wie 9c ausging, greift die eine oder die andere.
  // Beide sind eine Sperre mit Grund, und genau das wird geprueft.
  await berthilfe('m2', { schlachtschiff: 300 }, zielKampf);
  const zweiter = await anfechten(tokenB, Z5.sys, Z5.platz, 'm2');
  check('9g: ein sofortiger zweiter Angriff wird gesperrt - mit Schutzfrist oder Abklingzeit als Grund',
    zweiter.status === 403 && (zweiter.body.abklingzeit === true || zweiter.body.schutz === true) &&
    /Minuten/.test(String(zweiter.body.error)),
    { status: zweiter.status, body: zweiter.body });

  // 9h: Allianz - carl teilt annas Tag und darf ihr Recht nicht abnehmen. Dafuer haelt anna wieder
  // eines (Z3 aus 8f), und beide bekommen denselben Tag.
  // rschuerfrecht 3 (Limit 5): anna haelt zu diesem Zeitpunkt schon mehrere Rechte, mit dem
  // Grundstock waere der Claim still am Limit gescheitert - und 9h haette dann gemessen, dass ein
  // UNRESERVIERTES Vorkommen nicht anfechtbar ist. Genau so wird eine Pruefung aus dem falschen
  // Grund gruen oder rot; deshalb steht die Vorbedingung als eigene Pruefung darunter.
  await s.j('/storage/kepler7-save-v3', { method: 'PUT', headers: kopf(tokenA),
    body: JSON.stringify({ value: JSON.stringify(Object.assign(JSON.parse(spielstand(ANNA, 'anna', { schuerfschiff: 5 }, { research: { rschuerfrecht: 3 } })), { player: { id: ANNA, name: 'anna', allianceTag: 'KEP' } })) }) });
  const claimZ4 = await s.j('/asteroid/claim', { method: 'POST', headers: kopf(tokenA), body: JSON.stringify({ system: Z4.sys, platz: Z4.platz }) });
  check('9h-vorab: anna hält Z4 mit dem Tag KEP', claimZ4.status === 200 && claimZ4.body.tag === 'KEP',
    { status: claimZ4.status, tag: claimZ4.body && claimZ4.body.tag });
  await s.j('/storage/kepler7-save-v3', { method: 'PUT', headers: kopf(tokenC),
    body: JSON.stringify({ value: JSON.stringify(Object.assign(JSON.parse(spielstand(CARL, 'carl', { jaeger: 500 })), {
      player: { id: CARL, name: 'carl', allianceTag: 'KEP' },
      fleet: { missions: [{ id: 'mC', type: 'asteroid-contest', targetId: Z4.sys + ':' + Z4.platz, composition: { jaeger: 400 } }] } })) }) });
  const allianz = await anfechten(tokenC, Z4.sys, Z4.platz, 'mC');
  check('9h: Allianzmitglieder können sich ihre Schürfrechte nicht abnehmen - mit Begründung',
    allianz.status === 403 && allianz.body.allianz === true && /Allianz/.test(String(allianz.body.error)),
    { status: allianz.status, body: allianz.body });

  // 9j: Der Halter erfaehrt den Angriff, auch wenn sein Spiel zu ist. Geprueft wird der EMPFAENGER -
  // bei einem Sieg wird vork.halter mit dem Angreifer ueberschrieben, eine Benachrichtigung an
  // "den Halter" ginge dann an den, der gerade gewonnen hat.
  await warte(300);
  const dbPush = s.dbLesen();
  const annaEreignisse = (dbPush.private[ANNA] || {}).__notificationEvents || [];
  const bertEreignisse = (dbPush.private[BERT] || {}).__notificationEvents || [];
  const meldung = annaEreignisse.find(e => e && e.type === 'asteroid-contested');
  check('9j: die Verteidigerin bekommt eine Benachrichtigung über die Anfechtung',
    !!meldung && !!meldung.payload && typeof meldung.payload.verloren === 'boolean' && meldung.payload.angreiferName === 'bert',
    meldung ? meldung.payload : { annaEreignisse: annaEreignisse.map(e => e.type) });
  check('9j2: und der ANGREIFER bekommt keine - die Meldung ging nicht an den Falschen',
    !bertEreignisse.some(e => e && e.type === 'asteroid-contested'),
    bertEreignisse.map(e => e.type));

  // Und die Rechte stehen wirklich in der Datenbank (nicht nur in der Antwort).
  await warte(900);
  const db8 = s.dbLesen();
  const z2Db = db8.shared['asteroids:' + Z2.sys].plaetze[Z2.platz];
  const standB = JSON.parse(db8.private[BERT]['kepler7-save-v3'].value || db8.private[BERT]['kepler7-save-v3']);
  check('9i: der Server hat auch im Kampf KEINEN Spielstand geschrieben (Verluste bucht der Client)',
    standB.resources.erz === 5e5 && (standB.fleet.missions || []).length >= 1,
    { erz: standB.resources.erz, missionen: (standB.fleet.missions || []).length });
  check('8m: das Recht an Z2 steht mit Halter und Zeitstempel in der DB',
    !!z2Db && z2Db.halter === ANNA && z2Db.halterName === 'anna' && z2Db.seit > 0,
    z2Db && { halter: z2Db.halter === ANNA, halterName: z2Db.halterName, seit: z2Db.seit > 0 });

  s.ende();
  console.log(fail ? '\nFAIL' : '\nPASS');
  process.exit(fail ? 1 : 0);
})();
