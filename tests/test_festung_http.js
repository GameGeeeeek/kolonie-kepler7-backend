// Echter HTTP-Test: Asteroidenfestungen - Angriff, Abklingzeit, Blockade, Fall und Ausschuettung.
//
//   node tests/test_festung_http.js
//
// Der erste Test der Festungs-Mechanik (Phase 1 des Konzepts unter
// docs/aliens-asteroidenfestungen-konzept.md im Frontend-Repo). Er misst an einem echten Server
// mit echter DB, weil die entscheidenden Eigenschaften am geteilten Speicher haengen und sich
// durch Lesen des Quelltextes nicht belegen lassen.
//
// GEPRUEFT WIRD:
//   1. Aufbau: eine Festung wird direkt in die DB gesetzt (der galaxyTick wuerfelt sie sonst nur
//      mit 8 % je 15 Minuten aus - ein Test darf nicht wuerfeln).
//   2. Ein Schlag kommt an: Der Kern sinkt, der Beitrag steht im Felddokument, die Antwort nennt
//      Schaden und Verluste.
//   3. DIE ABKLINGZEIT LIEGT AN DER FESTUNG, nicht im Spielstand. Der zweite Schlag prallt mit
//      403 ab - UND der Grund steht im Fehlertext (Arbeitsregel 28: ein blosser Statuscode waere
//      von "keine Flotte unterwegs" nicht zu unterscheiden, das antwortet ebenfalls 403).
//      Die Gegenprobe dazu ist der eigentliche Befund, siehe unten.
//   4. Dieselbe Missions-Kennung ein zweites Mal -> 409 "bereits abgerechnet". Das ist ein anderer
//      Weg als die Abklingzeit und muss eigens belegt sein; er greift auch dann noch, wenn die
//      Abklingzeit laengst abgelaufen ist.
//   5. GEZAEHLT WIRD, WAS ANGEKOMMEN IST: Ein Schlag gegen einen fast leeren Kern traegt nur den
//      Kernrest zum Beitrag bei, nicht den vollen Wurf. Sonst risse der letzte Angreifer den
//      halben Hort an sich.
//   6. Der Fall: Festung weg, `geraeumtBis` gesetzt, und BEIDE Beitragenden haben eine
//      Belohnung in ihrer Warteschlange - der zweite Spieler, ohne dass sein Spielstand
//      angefasst wurde (das ist der Zweck von __pendingRewards).
//   7. Die Blockade: Im Festungssystem liefert /asteroid/mine weniger als die Obergrenze, nach
//      dem Fall dagegen MEHR als sie (der Geraeumt-Bonus).
//   8. Kollision: astNachschub setzt nie ein Vorkommen auf den Platz der Festung.
//   9. Eine falsche Festungs-Kennung -> 409 (die Festung ist gefallen, eine neue steht da).
//
// GEGENPROBEN (in beide Richtungen ausgefuehrt, Arbeitsregel 1):
//   * Legt man die Abklingzeit wie im Konzept-Entwurf in den SPIELSTAND (`save.festungLetzterSchlag`)
//     statt an die Festung, faellt 3a nicht - der Test wuerde gruen bleiben. Deshalb prueft 3b
//     zusaetzlich, dass die Sperre einen Spielstand-Reset UEBERLEBT: Der Test loescht das Feld im
//     Spielstand des Angreifers und schlaegt erneut zu. Genau das ist die Messung, die den
//     Unterschied zwischen den beiden Ablageorten sichtbar macht - und genau das, was ein
//     Spieler mit der Entwicklerkonsole in fuenf Sekunden taete.
//   * Nimmt man `const schaden = kernVorher - fest.kern` zurueck auf den vollen Wurf, faellt 5b.
//   * Nimmt man die Blockade aus /asteroid/mine, faellt 7a; nimmt man den Geraeumt-Bonus, faellt 7c.
//   * Ersetzt man astFreiePlaetze wieder durch die urspruengliche Inline-Suche, faellt 8a.
//
// Port 3221: 3195-3200, 3210-3219 und 3220 (test_serverstart) sind belegt (Arbeitsregel 29).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3221;

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ANNA = crypto.randomUUID(), BEN = crypto.randomUUID();

// Eine schlagkraeftige Flotte samt Mission. Die Missionen bekommen ihre Ziel-ID erst, wenn das
// Guertelsystem feststeht - deshalb baut der Test sie nachtraeglich in die DB-Datei.
function spielstand(id, name) {
  return {
    resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {},
    fleet: { missions: [], cruisers: 300, destroyers: 200, bomber: 120, schlachtschiff: 80, schuerfschiff: 50 },
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
      [ANNA]: { 'kepler7-save-v3': JSON.stringify(spielstand(ANNA, 'anna')) },
      [BEN]:  { 'kepler7-save-v3': JSON.stringify(spielstand(BEN, 'ben')) }
    },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {} }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-festung-' + process.pid + '.json');
let srv = null;
let s = null, tokA = null, tokB = null;   // vom Helfer aendereDb mitgefuehrt
function ende() { try { if (srv) srv.kill(); } catch (e) {} try { fs.unlinkSync(dbPfad); } catch (e) {} }
process.on('exit', ende);

// Mehrere Serverstarts auf DERSELBEN DB - dasselbe Muster wie test_sternenstaub_http. Nur so lassen
// sich Zustaende herstellen, die im laufenden Betrieb Stunden brauchen (Abklingzeit, Kernrest).
async function starteServer() {
  let log = '';
  srv = spawn(process.execPath, [path.join(WURZEL, 'server.js')], {
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
async function stoppeServer() {
  if (!srv) return;
  srv.kill('SIGTERM');            // flusht die DB (Graceful Shutdown)
  await warte(700);
  srv = null;
}
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));

/* JEDE Aenderung an der DB-Datei laeuft durch diesen Helfer - und das ist keine Bequemlichkeit,
   sondern die Behebung eines Fehlers, den erst die Gegenprobe sichtbar gemacht hat.
   Der erste Entwurf schrieb die Datei, WAEHREND der Server noch lief, und stoppte ihn danach.
   stoppeServer schickt aber SIGTERM, und der Graceful Shutdown flusht die im Speicher gehaltene db
   auf Platte - er ueberschreibt die gerade geschriebene Aenderung also wieder. Im gruenen Lauf
   fiel das nicht auf: Die betroffenen Pruefungen (3a/3b) waren durch die Abklingzeit ohnehin
   erfuellt, und die Abklingzeit wird VOR der Missionssuche geprueft. Erst mit ausgebauter
   Abklingzeit kam heraus, dass die vorbereitete Mission nie in der Datei stand - die Ablehnung
   lautete dann "keine Flotte unterwegs" statt der erwarteten. Genau die Sorte Pruefung, die aus
   dem falschen Grund gruen ist (Arbeitsregel 28).
   Reihenfolge deshalb fest verdrahtet: erst stoppen, dann lesen/aendern/schreiben, dann starten. */
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  s = await starteServer();
  tokA = await s.anmelden('anna');
  tokB = await s.anmelden('ben');
}

(async () => {
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  s = await starteServer();
  tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  check('0: zwei Konten angemeldet', !!tokA && !!tokB);
  if (!tokA || !tokB) { console.log(s.protokoll().slice(-1500)); process.exit(1); }
  const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });

  // ---- 1) Aufbau: Festung von Hand setzen --------------------------------------------------
  const f0 = await s.j('/asteroid/field', { headers: kopf(tokA) });
  check('1a: Gürtelfeld lesbar', f0.status === 200 && !!(f0.body && f0.body.felder), f0.status);
  if (f0.status !== 200) { console.log(s.protokoll().slice(-1500)); process.exit(1); }
  const sys = (f0.body.systeme || [])[0];

  await stoppeServer();
  let db = liesDb();
  const feldKey = 'asteroids:' + sys;
  const feld = db.shared[feldKey];
  // Der Platz der Festung: einer, auf dem gerade KEIN Vorkommen liegt. Gibt es keinen, wird einer
  // freigeraeumt - sonst haengt der Test am Zufall des Feldaufbaus.
  let festPlatz = null;
  for (let i = 0; i < 10; i++) { const q = feld.plaetze[String(i)]; if (!q || q.frei) { festPlatz = String(i); break; } }
  if (festPlatz === null) { festPlatz = '0'; delete feld.plaetze['0']; }
  const FEST_ID = crypto.randomUUID();
  feld.festung = {
    id: FEST_ID, stufe: 'sternenfeste', platz: festPlatz, sorte: 'eisen',
    kernMax: 1200000, kern: 1200000, hort: 500000, hortProto: 400,
    seit: Date.now(), letzteReifung: Date.now(), beitraege: {}
  };
  db.shared[feldKey] = feld;
  // Beiden Konten je eine angekommene Angriffsmission in den Spielstand legen.
  for (const [uid, missionId] of [[ANNA, 'm-anna-1'], [BEN, 'm-ben-1']]) {
    const save = JSON.parse(db.private[uid]['kepler7-save-v3']);
    save.fleet.missions = [{ id: missionId, type: 'festung-angriff', targetId: sys, endTime: Date.now() - 1000,
      composition: { cruisers: 300, destroyers: 200, bomber: 120, schlachtschiff: 80 } }];
    db.private[uid]['kepler7-save-v3'] = JSON.stringify(save);
  }
  schreibDb(db);
  s = await starteServer();
  tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  check('1b: Festung steht im Feld', !!liesDb().shared[feldKey].festung, { sys, festPlatz });

  // ---- 2) Ein Schlag kommt an ---------------------------------------------------------------
  const schlag1 = await s.j('/festung/angriff', { method: 'POST', headers: kopf(tokA),
    body: JSON.stringify({ system: sys, missionId: 'm-anna-1', festungId: FEST_ID }) });
  check('2a: der Schlag wird angenommen', schlag1.status === 200 && schlag1.body.ok === true,
    { status: schlag1.status, body: schlag1.body });
  check('2b: er richtet Schaden an', (schlag1.body.schaden || 0) > 0, { schaden: schlag1.body.schaden });
  check('2c: der Kern ist gesunken', (schlag1.body.kern || 0) < 1200000 && schlag1.body.gefallen === false,
    { kern: schlag1.body.kern, gefallen: schlag1.body.gefallen });
  check('2d: eigene Verluste werden gemeldet', Object.keys(schlag1.body.eigeneVerluste || {}).length > 0,
    schlag1.body.eigeneVerluste);
  const nachSchlag1 = liesDb().shared[feldKey].festung;
  check('2e: der Beitrag steht im GETEILTEN Speicher', (nachSchlag1.beitraege[ANNA] || {}).schaden > 0,
    { beitraege: nachSchlag1.beitraege });

  // ---- 3) Die Abklingzeit liegt an der Festung ----------------------------------------------
  await aendereDb(db2 => {
    const save = JSON.parse(db2.private[ANNA]['kepler7-save-v3']);
    save.fleet.missions = [{ id: 'm-anna-2', type: 'festung-angriff', targetId: sys, endTime: Date.now() - 1000,
      composition: { cruisers: 300, destroyers: 200, bomber: 120, schlachtschiff: 80 } }];
    db2.private[ANNA]['kepler7-save-v3'] = JSON.stringify(save);
  });

  const schlag2 = await s.j('/festung/angriff', { method: 'POST', headers: kopf(tokA),
    body: JSON.stringify({ system: sys, missionId: 'm-anna-2', festungId: FEST_ID }) });
  const grundGenannt = typeof schlag2.body.error === 'string' && /nächste[rn]? Schlag|Kurzem beschossen/.test(schlag2.body.error);
  check('3a: der zweite Schlag prallt ab - MIT Grund im Fehlertext',
    schlag2.status === 403 && grundGenannt && schlag2.body.abklingzeit === true,
    { status: schlag2.status, error: schlag2.body.error });

  // 3b ist die eigentliche Aussage: Die Sperre ueberlebt einen Spielstand-Reset. Laege sie im
  // klientenautoritativen Spielstand, waere sie hier weg - und der Schlag ginge durch.
  await aendereDb(db3 => {
    const save = JSON.parse(db3.private[ANNA]['kepler7-save-v3']);
    delete save.festungLetzterSchlag;          // was der Konzept-Entwurf benutzt haette
    save.fleet.missions = [{ id: 'm-anna-3', type: 'festung-angriff', targetId: sys, endTime: Date.now() - 1000,
      composition: { cruisers: 300, destroyers: 200, bomber: 120, schlachtschiff: 80 } }];
    db3.private[ANNA]['kepler7-save-v3'] = JSON.stringify(save);
  });
  const schlag3 = await s.j('/festung/angriff', { method: 'POST', headers: kopf(tokA),
    body: JSON.stringify({ system: sys, missionId: 'm-anna-3', festungId: FEST_ID }) });
  check('3b: die Sperre überlebt einen gelöschten Spielstand-Eintrag',
    schlag3.status === 403 && schlag3.body.abklingzeit === true,
    { status: schlag3.status, error: schlag3.body.error });

  // ---- 4) Dieselbe Missions-Kennung ein zweites Mal ------------------------------------------
  // Die Abklingzeit im Feld zurueckdatieren, damit hier wirklich die Missions-Sperre misst und
  // nicht die Abklingzeit (Arbeitsregel 28: aus dem richtigen Grund gruen).
  await stoppeServer();
  {
    const db4 = liesDb();
    db4.shared[feldKey].festung.schlaege[ANNA] = Date.now() - 7 * 3600 * 1000;
    schreibDb(db4);
  }
  s = await starteServer(); tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  const wieder = await s.j('/festung/angriff', { method: 'POST', headers: kopf(tokA),
    body: JSON.stringify({ system: sys, missionId: 'm-anna-1', festungId: FEST_ID }) });
  check('4a: dieselbe Missions-Kennung wird abgewiesen - MIT Grund',
    wieder.status === 409 && /bereits abgerechnet/.test(wieder.body.error || ''),
    { status: wieder.status, error: wieder.body.error });

  // ---- 5) Gezählt wird, was ankommt ----------------------------------------------------------
  await stoppeServer();
  {
    const db5 = liesDb();
    const fst = db5.shared[feldKey].festung;
    fst.kern = 4000;                       // deutlich weniger als ein Schlag anrichtet
    fst.schlaege = {};                     // Abklingzeit fuer beide frei
    fst.beitraege = { [BEN]: { name: 'ben', schaden: 6000 } };  // Ben hat vorgearbeitet
    const save = JSON.parse(db5.private[ANNA]['kepler7-save-v3']);
    save.fleet.missions = [{ id: 'm-anna-4', type: 'festung-angriff', targetId: sys, endTime: Date.now() - 1000,
      composition: { cruisers: 300, destroyers: 200, bomber: 120, schlachtschiff: 80 } }];
    db5.private[ANNA]['kepler7-save-v3'] = JSON.stringify(save);
    schreibDb(db5);
  }
  s = await starteServer(); tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben');
  const totschlag = await s.j('/festung/angriff', { method: 'POST', headers: kopf(tokA),
    body: JSON.stringify({ system: sys, missionId: 'm-anna-4', festungId: FEST_ID }) });
  check('5a: die Festung fällt', totschlag.status === 200 && totschlag.body.gefallen === true,
    { status: totschlag.status, body: totschlag.body });
  check('5b: gezählt wird der KERNREST, nicht der volle Wurf',
    totschlag.body.schaden === 4000, { schaden: totschlag.body.schaden, kernRestWar: 4000 });
  // Anna 4000, Ben 6000 -> Anna 40 %. Waere der volle Wurf gezaehlt worden (~200.000), stuende
  // Anna bei ueber 97 % und Ben ginge faktisch leer aus.
  check('5c: der Anteil folgt daraus', Math.abs((totschlag.body.anteil || 0) - 0.4) < 0.001,
    { anteil: totschlag.body.anteil, erwartet: 0.4 });

  // ---- 6) Der Fall: Ausschüttung an beide ----------------------------------------------------
  const feldNachFall = liesDb().shared[feldKey];
  check('6a: die Festung ist weg', !feldNachFall.festung, { festung: feldNachFall.festung });
  check('6b: geraeumtBis ist gesetzt', (feldNachFall.geraeumtBis || 0) > Date.now(),
    { geraeumtBis: feldNachFall.geraeumtBis });
  const belA = await s.j('/pending-rewards', { headers: kopf(tokA) });
  const belB = await s.j('/pending-rewards', { headers: kopf(tokB) });
  const fA = (belA.body.rewards || []).find(r => r.type === 'festung');
  const fB = (belB.body.rewards || []).find(r => r.type === 'festung');
  check('6c: Anna hat eine Festungs-Belohnung', !!fA, fA);
  check('6d: BEN hat eine, ohne dass sein Spielstand angefasst wurde', !!fB, fB);
  check('6e: die Anteile ergeben zusammen 1', !!fA && !!fB && Math.abs(fA.anteil + fB.anteil - 1) < 0.01,
    { anna: fA && fA.anteil, ben: fB && fB.anteil });
  check('6f: Protomaterie ist dabei', !!fA && fA.protomaterie > 0 && !!fB && fB.protomaterie > 0,
    { anna: fA && fA.protomaterie, ben: fB && fB.protomaterie });
  check('6g: die Belohnung nennt Sorte und Menge', !!fA && fA.sorte === 'eisen' && fA.menge > 0,
    { sorte: fA && fA.sorte, menge: fA && fA.menge });
  {
    const dbNach = liesDb();
    const saveBen = JSON.parse(dbNach.private[BEN]['kepler7-save-v3']);
    check('6h: Bens Spielstand ist unveraendert (keine Fremdschreibung)',
      saveBen.credits === 1000 && saveBen.battlePoints === 0,
      { credits: saveBen.credits, battlePoints: saveBen.battlePoints });
  }

  // ---- 7) Blockade und Geräumt-Bonus: GEMESSEN, nicht am Etikett abgelesen ------------------
  // Der Test vergleicht drei echte Fuhren gegen dieselbe Flotte (50 Schürfschiffe = 100.000
  // Obergrenze). Ein Blick auf das Feld `blockade` in der Antwort allein wäre die Beschriftung,
  // nicht die Wirkung (Arbeitsregel 3: die REGEL prüfen, nicht die Momentaufnahme).
  const MESSPLATZ = String((Number(festPlatz) + 1) % 10);
  async function messeFuhre(bau) {
    await stoppeServer();
    const d = liesDb();
    const f = d.shared[feldKey];
    delete f.festung; delete f.geraeumtBis;
    bau(f);
    // Ein fetter Brocken, damit nie der Vorrat begrenzt, sondern immer die Obergrenze.
    f.plaetze[MESSPLATZ] = { sorte: 'eisen', groesse: 'brocken', vorrat: 5000000 };
    d.shared[feldKey] = f;
    schreibDb(d);
    s = await starteServer(); tokA = await s.anmelden('anna');
    return await s.j('/asteroid/mine', { method: 'POST', headers: kopf(tokA),
      body: JSON.stringify({ system: sys, platz: MESSPLATZ, wunsch: 999999999 }) });
  }

  const frei = await messeFuhre(() => {});
  check('7a: ohne Festung trägt die Fuhre die volle Obergrenze',
    frei.status === 200 && frei.body.menge === 100000 && frei.body.blockade === 0,
    { status: frei.status, error: frei.body.error, menge: frei.body.menge, blockade: frei.body.blockade });

  const blockiert = await messeFuhre(f => {
    f.festung = { id: crypto.randomUUID(), stufe: 'sternenfeste', platz: festPlatz, sorte: 'eisen',
      kernMax: 1200000, kern: 1200000, hort: 1000, hortProto: 5,
      seit: Date.now(), letzteReifung: Date.now(), beitraege: {} };
  });
  check('7b: die Sternenfeste kürzt die Fuhre wirklich um 55 %',
    blockiert.status === 200 && blockiert.body.menge === 45000 && blockiert.body.blockade === 0.55,
    { status: blockiert.status, error: blockiert.body.error, menge: blockiert.body.menge,
      erwartet: 45000, blockade: blockiert.body.blockade });
  // Die Protomaterie haengt im Frontend an der GROESSE des Vorkommens, nicht an der Ladung - die
  // Kuerzung oben erreicht sie nie. Der Faktor muss deshalb eigens mitreisen, sonst ist die
  // Drosselung, die die Galaxie-Nachricht ankuendigt, gar nicht vorhanden.
  check('7b-proto: der Protomaterie-Faktor reist mit (Sternenfeste = 100 % Drosselung)',
    blockiert.body.protoBlockade === 0, { protoBlockade: blockiert.body.protoBlockade, erwartet: 0 });
  check('7a-proto: ohne Festung ist der Faktor 1 (keine Drosselung)',
    frei.body.protoBlockade === 1, { protoBlockade: frei.body.protoBlockade, erwartet: 1 });

  const geraeumt = await messeFuhre(f => { f.geraeumtBis = Date.now() + 3600 * 1000; });
  check('7c: nach dem Fall trägt die Fuhre 15 % mehr',
    geraeumt.status === 200 && geraeumt.body.menge === 115000 && geraeumt.body.geraeumtBonus === 0.15,
    { status: geraeumt.status, error: geraeumt.body.error, menge: geraeumt.body.menge,
      erwartet: 115000, geraeumtBonus: geraeumt.body.geraeumtBonus });

  // Die Gegenrichtung: Solange die Festung steht, gibt es KEINEN Geräumt-Bonus - auch dann nicht,
  // wenn beide Marken gesetzt sind. Ohne diese Prüfung könnte sich beides addieren, und ein
  // schnell nachgesetzter Nachfolger machte den Gürtel ergiebiger als ohne jede Festung.
  const beides = await messeFuhre(f => {
    f.geraeumtBis = Date.now() + 3600 * 1000;
    f.festung = { id: crypto.randomUUID(), stufe: 'schanze', platz: festPlatz, sorte: 'eisen',
      kernMax: 30000, kern: 30000, hort: 100, hortProto: 1,
      seit: Date.now(), letzteReifung: Date.now(), beitraege: {} };
  });
  check('7d: steht wieder eine Festung, greift der Bonus NICHT mehr',
    beides.status === 200 && beides.body.geraeumtBonus === 0 && beides.body.menge === 75000,
    { status: beides.status, error: beides.body.error, menge: beides.body.menge,
      erwartet: 75000, geraeumtBonus: beides.body.geraeumtBonus, blockade: beides.body.blockade });
  // Zweite Stufe: Die Schanze drosselt die Protomaterie nur zur Haelfte. Damit ist belegt, dass
  // der Faktor der TABELLE folgt und nicht bloss ein festes 0/1 ist.
  check('7d-proto: die Schanze drosselt die Protomaterie um 50 %',
    beides.body.protoBlockade === 0.5, { protoBlockade: beides.body.protoBlockade, erwartet: 0.5 });

  // ---- 10) Der Spawn-Schalter: solange er aus ist, entsteht NICHTS -------------------------
  // Das ist die Zusicherung, auf der die Auslieferbarkeit dieser Phase allein beruht. Der
  // galaxyTick wird hier nicht abgewartet (8 % je 15 Minuten) - gemessen wird festungSpawn()
  // direkt, mit vielen Versuchen gegen ein Feld ohne Festung.
  {
    const schalter = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8')
      .match(/const FESTUNG_SPAWN_AKTIV = (true|false);/);
    check('10a: der Spawn-Schalter ist im Quelltext auffindbar', !!schalter, { gefunden: schalter && schalter[1] });
    // Solange das Frontend der Phase 1 nicht da ist, MUSS er false sein - sonst kuerzt die
    // Blockade live die Abbauladung, ohne dass irgendetwas sie erklaeren kann.
    check('10b: er steht auf false, solange das Frontend fehlt', !!schalter && schalter[1] === 'false',
      { steht_auf: schalter && schalter[1] });
  }

  // ---- 8) Kein Nachschub auf den Platz der Festung -------------------------------------------
  await stoppeServer();
  {
    const db8 = liesDb();
    const f8 = db8.shared[feldKey];
    // Alle Plaetze ausser dem der Festung leeren und faellig stellen - der naechste Feldabruf
    // muss sie alle neu besetzen und darf dabei den Festungsplatz NIE treffen.
    for (let i = 0; i < 10; i++) {
      const k = String(i);
      if (k === festPlatz) continue;
      f8.plaetze[k] = { frei: true, nachschubAb: Date.now() - 1000 };
    }
    delete f8.plaetze[festPlatz];
    db8.shared[feldKey] = f8;
    schreibDb(db8);
  }
  s = await starteServer(); tokA = await s.anmelden('anna');
  let trefferAufFestung = 0;
  for (let runde = 0; runde < 6; runde++) {
    await s.j('/asteroid/field', { headers: kopf(tokA) });
    const fx = liesDb().shared[feldKey];
    const drauf = fx.plaetze[festPlatz];
    if (drauf && !drauf.frei) trefferAufFestung++;
    // erneut faellig stellen, damit der Nachschub mehrfach laeuft
    await aendereDb(db8b => {
      for (let i = 0; i < 10; i++) {
        const k = String(i);
        if (k === festPlatz) continue;
        db8b.shared[feldKey].plaetze[k] = { frei: true, nachschubAb: Date.now() - 1000 };
      }
    });
  }
  check('8a: über 6 Nachschub-Runden landet nie ein Vorkommen auf dem Festungsplatz',
    trefferAufFestung === 0, { trefferAufFestung, festPlatz });

  // ---- 9) Falsche Festungs-Kennung -----------------------------------------------------------
  await aendereDb(db9 => {
    const save = JSON.parse(db9.private[BEN]['kepler7-save-v3']);
    save.fleet.missions = [{ id: 'm-ben-9', type: 'festung-angriff', targetId: sys, endTime: Date.now() - 1000,
      composition: { cruisers: 300, destroyers: 200 } }];
    db9.private[BEN]['kepler7-save-v3'] = JSON.stringify(save);
  });
  const falsch = await s.j('/festung/angriff', { method: 'POST', headers: kopf(tokB),
    body: JSON.stringify({ system: sys, missionId: 'm-ben-9', festungId: FEST_ID }) });
  check('9a: eine veraltete Festungs-Kennung wird abgewiesen - MIT Grund',
    falsch.status === 409 && /gefallen/.test(falsch.body.error || ''),
    { status: falsch.status, error: falsch.body.error });

  await stoppeServer();
  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})();
