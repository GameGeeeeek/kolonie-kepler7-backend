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
// Die drei Bauteile einer Asteroidenfestung: Zielwahl, Rollenfaktoren, Schild und Tuerme.
//
//   node tests/test_festung_bauteile_http.js
//
// Phase 2 des Konzepts. Der Kern allein war Phase 1; hier kommt die Entscheidung dazu, WORAUF man
// schiesst - und die drei vorhandenen Konterrollen entscheiden, wie gut man trifft.
//
// GEPRUEFT WIRD:
//   1. Eine frisch entstandene Festung traegt beide Bauteile, mit LP als Anteil des Kerns
//      (Schild 40 %, Tuerme 25 %) - nicht als eigene Zahlen, die auseinanderlaufen koennen.
//   2. DER SCHILD IST DER GRUND, warum man ihn brechen will: Solange er steht, kommen nur 35 %
//      am Kern an. Gemessen als VERGLEICH zweier Schlaege derselben Flotte - mit und ohne Schild.
//      Ein Blick auf das Feld allein waere die Beschriftung, nicht die Wirkung.
//   3. DIE TUERME kosten Schiffe: Stehen sie, liegt die Verlustquote bei 30 % statt bei den
//      6/9/12 % der Stufe. Ebenfalls als Vergleich gemessen.
//   4. DER ROLLENFAKTOR RECHNET NACH ANTEIL, nicht nach Anwesenheit: Ein einzelner Bomber in
//      einer Kreuzerflotte darf den Schildbonus nicht ausloesen. Gemessen an drei Flotten
//      (reine Bomber, halb, keine) gegen dasselbe Bauteil.
//   5. Ist das gewaehlte Bauteil schon zerstoert, geht der Schaden OHNE Rollenfaktor auf den
//      Kern - die Flotte wird nicht bestraft, weil ein Mitstreiter schneller war.
//   6. Schaden an Bauteilen zaehlt zu 60 % auf den Hortanteil. Ohne diesen Ausgleich wuerde
//      niemand den Schild angreifen, und die ganze Rollen-Mechanik waere tot.
//   7. Der Schild regeneriert (2 %/Std.), die Tuerme nie - und ein ZERSTOERTER Schild kommt
//      nicht wieder.
//   8. Eine Festung OHNE `bauteile` (jede aus Phase 1) verhaelt sich weiterhin wie vorher.
//      Das ist die Zusicherung, die diese Phase ohne Wanderung des Bestands auslieferbar macht.
//
// GEGENPROBEN (in beide Richtungen ausgefuehrt):
//   * Ohne den Schild-Durchlass faellt 2c (beide Schlaege gleich gross).
//   * Ohne die Turm-Verlustquote faellt 3c.
//   * Mit einem Rollenfaktor nach ANWESENHEIT statt nach Anteil faellt 4c.
//   * Ohne die 60-%-Gewichtung faellt 6b.
//
// Port 3222: 3195-3200, 3210-3221 sind belegt (Arbeitsregel 29).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3222;

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

const dbPfad = path.join(os.tmpdir(), 'kepler-bauteile-' + process.pid + '.json');
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

  const f0 = await s.j('/asteroid/field', { headers: kopf(tokA) });
  check('0b: Gürtelfeld lesbar', f0.status === 200, f0.status);
  if (f0.status !== 200) { console.log(s.protokoll().slice(-1500)); process.exit(1); }
  const sys = (f0.body.systeme || [])[0];
  const feldKey = 'asteroids:' + sys;

  const KERN = 1200000;
  const SCHILD = Math.round(KERN * 0.40);
  const TUERME = Math.round(KERN * 0.25);

  // Eine Festung mit Bauteilen setzen. `bauteile` genau so, wie festungSpawn sie anlegt.
  function festung(opt) {
    opt = opt || {};
    const f = {
      id: 'fest-1', stufe: 'sternenfeste', platz: '0', sorte: 'eisen',
      kernMax: KERN, kern: opt.kern === undefined ? KERN : opt.kern,
      hort: 100000, hortProto: 100,
      seit: Date.now(), letzteReifung: Date.now(), beitraege: opt.beitraege || {}, schlaege: {}
    };
    if (!opt.ohneBauteile) {
      f.bauteile = {
        schild: { lp: opt.schild === undefined ? SCHILD : opt.schild, lpMax: SCHILD, letzteReifung: Date.now() },
        tuerme: { lp: opt.tuerme === undefined ? TUERME : opt.tuerme, lpMax: TUERME }
      };
    }
    return f;
  }
  // Eine Mission mit Zielwahl und frei waehlbarer Zusammensetzung in Annas Spielstand legen.
  const FLOTTE_KAPITAL = { cruisers: 300, destroyers: 200, schlachtschiff: 80 };
  const FLOTTE_BOMBER  = { bomber: 300, nanoklinge: 100 };
  const FLOTTE_ABFANG  = { jaeger: 400, carrier: 200 };
  const FLOTTE_HALB    = { bomber: 150, cruisers: 300 };

  async function schlag(opt) {
    await aendereDb(d => {
      const feld = d.shared[feldKey];
      feld.festung = opt.festung || festung();
      d.shared[feldKey] = feld;
      const save = JSON.parse(d.private[ANNA]['kepler7-save-v3']);
      Object.assign(save.fleet, opt.flotte || FLOTTE_KAPITAL);
      save.fleet.missions = [{ id: opt.id, type: 'festung-angriff', targetId: sys,
        endTime: Date.now() - 1000, ziel: opt.ziel || 'kern', composition: opt.flotte || FLOTTE_KAPITAL }];
      d.private[ANNA]['kepler7-save-v3'] = JSON.stringify(save);
    });
    return await s.j('/festung/angriff', { method: 'POST', headers: kopf(tokA),
      body: JSON.stringify({ system: sys, missionId: opt.id, festungId: 'fest-1' }) });
  }

  // ---- 1) Die Bauteile entstehen mit der Festung ---------------------------------------------
  {
    const quelle = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
    const anteilSchild = (quelle.match(/schild:\s*\{[^}]*anteilKern:\s*([\d.]+)/) || [])[1];
    const anteilTuerme = (quelle.match(/tuerme:\s*\{[^}]*anteilKern:\s*([\d.]+)/) || [])[1];
    check('1a: die LP der Bauteile sind ANTEILE des Kerns, keine eigenen Zahlen',
      anteilSchild === '0.40' && anteilTuerme === '0.25', { schild: anteilSchild, tuerme: anteilTuerme });
    check('1b: festungSpawn legt beide an',
      /bauteile:[\s\S]{0,120}\{[\s\S]{0,400}schild:[\s\S]{0,300}tuerme:/.test(quelle));
    /* Der Schalter, der diese Phase allein auslieferbar gemacht hat - dieselbe Zusicherung wie
       FESTUNG_SPAWN_AKTIV in Phase 1, und dieselbe Umkehr nach der Auslieferung.
       Solange er aus war, entstand keine Festung MIT Bauteilen, und ohne Bauteile verhielt sich
       alles wie vorher (Abschnitt 8 misst genau das).
       SEIT v8.575.0 steht das Frontend der Phase 2, also steht er auf true. Die Pruefung bleibt
       und DREHT SICH UM: Ein Wechsel zurueck auf false ist ab jetzt eine bewusste Notabschaltung
       und kein Versehen - aber er soll auffallen, statt still zu geschehen. */
    const schalter = (quelle.match(/const FESTUNG_BAUTEILE_AKTIV = (true|false);/) || [])[1];
    check('1c: der Bauteile-Schalter ist auffindbar', !!schalter, { steht_auf: schalter });
    check('1d: und er steht auf true - das Frontend der Phase 2 ist ausgeliefert',
      schalter === 'true',
      { steht_auf: schalter,
        hinweis: 'false heisst: Notabschaltung. Dann gehoert der Grund in die CLAUDE.md.' });
  }

  // ---- 2) Der Schild laesst nur 35 % durch ----------------------------------------------------
  // GEMESSEN als Vergleich zweier Schlaege DERSELBEN Flotte - einmal mit stehendem Schild, einmal
  // ohne. Ein Blick auf das Feld allein waere die Beschriftung, nicht die Wirkung (Regel 61).
  const mitSchild = await schlag({ id: 'm1', ziel: 'kern' });
  check('2a: ein Kernschlag mit stehendem Schild kommt an', mitSchild.status === 200, mitSchild.body);
  const ohneSchild = await schlag({ id: 'm2', ziel: 'kern', festung: festung({ schild: 0 }) });
  check('2b: und einer ohne Schild ebenfalls', ohneSchild.status === 200, ohneSchild.body);
  const verhaeltnis = (mitSchild.body.schaden || 0) / Math.max(1, ohneSchild.body.schaden || 0);
  // Der Wurf streut um +-20 %, deshalb eine Spanne statt eines Punktwerts. 0,35 erwartet;
  // schlimmstenfalls 0,35 * 1,2/0,8 = 0,525 bzw. 0,35 * 0,8/1,2 = 0,233.
  check('2c: der Schild laesst nur rund 35 % durch',
    verhaeltnis > 0.20 && verhaeltnis < 0.56,
    { mitSchild: mitSchild.body.schaden, ohneSchild: ohneSchild.body.schaden,
      verhaeltnis: verhaeltnis.toFixed(3), erwartet: '~0.35' });

  // ---- 3) Die Tuerme kosten Schiffe -----------------------------------------------------------
  const summe = o => Object.values(o || {}).reduce((a, b) => a + b, 0);
  const mitTuermen = await schlag({ id: 'm3', ziel: 'kern' });
  const ohneTuerme = await schlag({ id: 'm4', ziel: 'kern', festung: festung({ tuerme: 0 }) });
  const gesendet = summe(FLOTTE_KAPITAL);
  const qMit = summe(mitTuermen.body.eigeneVerluste) / gesendet;
  const qOhne = summe(ohneTuerme.body.eigeneVerluste) / gesendet;
  check('3a: mit Türmen liegt die Verlustquote bei rund 30 %', qMit > 0.27 && qMit < 0.38,
    { quote: qMit.toFixed(3), verluste: mitTuermen.body.eigeneVerluste });
  check('3b: ohne Türme bei den 12 % der Sternenfeste', qOhne > 0.10 && qOhne < 0.19,
    { quote: qOhne.toFixed(3), verluste: ohneTuerme.body.eigeneVerluste });
  check('3c: die Türme kosten also deutlich mehr', qMit > qOhne * 1.6,
    { mitTuermen: qMit.toFixed(3), ohneTuerme: qOhne.toFixed(3) });

  // ---- 4) Der Rollenfaktor rechnet nach ANTEIL ------------------------------------------------
  // Drei Flotten gegen dasselbe Bauteil. Der Faktor steht in der Antwort, gemessen wird aber
  // ZUSAETZLICH der angerichtete Teilschaden - eine Zahl in der Antwort allein waere wieder nur
  // das Etikett.
  const rein  = await schlag({ id: 'm5', ziel: 'schild', flotte: FLOTTE_BOMBER });
  const halb  = await schlag({ id: 'm6', ziel: 'schild', flotte: FLOTTE_HALB });
  const keine = await schlag({ id: 'm7', ziel: 'schild', flotte: FLOTTE_KAPITAL });
  check('4a: eine reine Bomberflotte erreicht den vollen Faktor',
    Math.abs((rein.body.rollenFaktor || 0) - 1.60) < 0.02, { faktor: rein.body.rollenFaktor });
  check('4b: eine Flotte ohne Bomber den kleinsten',
    Math.abs((keine.body.rollenFaktor || 0) - 0.70) < 0.02, { faktor: keine.body.rollenFaktor });
  check('4c: eine gemischte liegt DAZWISCHEN - nach Anteil, nicht nach Anwesenheit',
    (halb.body.rollenFaktor || 0) > 0.75 && (halb.body.rollenFaktor || 0) < 1.55,
    { faktor: halb.body.rollenFaktor,
      hinweis: 'bei "nach Anwesenheit" stuende hier 1.60 - ein einzelner Bomber wuerde reichen' });

  // ---- 5) Ein zerstoertes Bauteil: Schaden geht auf den Kern, ohne Rollenfaktor ---------------
  const ersatz = await schlag({ id: 'm8', ziel: 'schild', festung: festung({ schild: 0 }), flotte: FLOTTE_BOMBER });
  check('5a: der Schlag wird angenommen', ersatz.status === 200, ersatz.body);
  check('5b: das Ziel weicht auf den Kern aus', ersatz.body.ziel === 'kern-ersatz', { ziel: ersatz.body.ziel });
  check('5c: ohne Rollenfaktor - die Flotte wird nicht bestraft, aber auch nicht belohnt',
    ersatz.body.rollenFaktor === 1, { faktor: ersatz.body.rollenFaktor });
  check('5d: und der Kern nimmt Schaden', (ersatz.body.schaden || 0) > 0, { schaden: ersatz.body.schaden });

  // ---- 6) Bauteilschaden zaehlt zu 60 % auf den Hortanteil ------------------------------------
  // Ben hat 100.000 Kernschaden vorgearbeitet. Anna schlaegt auf den Schild - ihr Beitrag muss
  // 60 % ihres Teilschadens sein, nicht 100 % und nicht 0.
  const vorBen = { [BEN]: { name: 'ben', schaden: 100000 } };
  const teil = await schlag({ id: 'm9', ziel: 'tuerme', flotte: FLOTTE_ABFANG,
                              festung: festung({ beitraege: vorBen }) });
  check('6a: der Schlag richtet Schaden am Bauteil an', (teil.body.teilSchaden || 0) > 0,
    { teilSchaden: teil.body.teilSchaden });
  {
    const fest = liesDb().shared[feldKey].festung;
    const meinBeitrag = (fest.beitraege[ANNA] || {}).schaden || 0;
    const erwartet = Math.round((teil.body.teilSchaden || 0) * 0.60);
    check('6b: und zaehlt zu 60 % auf den Hortanteil', meinBeitrag === erwartet,
      { beitrag: meinBeitrag, teilSchaden: teil.body.teilSchaden, erwartet,
        hinweis: 'gleich dem Teilschaden hiesse 100 %, null hiesse: der Schild lohnt nie' });
  }

  // ---- 7) Regeneration: der Schild ja, die Tuerme nie, ein zerstoerter Schild nicht ----------
  await aendereDb(d => {
    const feld = d.shared[feldKey];
    feld.festung = festung({ schild: Math.round(SCHILD * 0.5), tuerme: Math.round(TUERME * 0.5) });
    // Zwei Stunden zurueckdatieren - 2 %/Std. ergibt +4 % der Maximal-LP.
    feld.festung.bauteile.schild.letzteReifung = Date.now() - 2 * 3600 * 1000;
    feld.festung.letzteReifung = Date.now() - 2 * 3600 * 1000;
    d.shared[feldKey] = feld;
  });
  await s.j('/asteroid/field', { headers: kopf(tokA) });   // Lesen loest die Reifung aus
  {
    const b = liesDb().shared[feldKey].festung.bauteile;
    const erwartetSchild = Math.round(SCHILD * 0.5 + SCHILD * 0.02 * 2);
    check('7a: der Schild regeneriert 2 % je Stunde',
      Math.abs(b.schild.lp - erwartetSchild) <= 2, { lp: b.schild.lp, erwartet: erwartetSchild });
    check('7b: die Türme regenerieren NIE', b.tuerme.lp === Math.round(TUERME * 0.5),
      { lp: b.tuerme.lp, erwartet: Math.round(TUERME * 0.5) });
  }
  await aendereDb(d => {
    const feld = d.shared[feldKey];
    feld.festung = festung({ schild: 0 });
    feld.festung.bauteile.schild.letzteReifung = Date.now() - 10 * 3600 * 1000;
    feld.festung.letzteReifung = Date.now() - 10 * 3600 * 1000;
    d.shared[feldKey] = feld;
  });
  await s.j('/asteroid/field', { headers: kopf(tokA) });
  check('7c: ein ZERSTÖRTER Schild kommt nicht wieder',
    liesDb().shared[feldKey].festung.bauteile.schild.lp === 0,
    { lp: liesDb().shared[feldKey].festung.bauteile.schild.lp,
      hinweis: 'sonst waere der erkaempfte Vorteil vor der zweiten Welle wieder weg' });

  // ---- 8) Eine Festung OHNE bauteile verhaelt sich wie in Phase 1 -----------------------------
  // Das ist die Zusicherung, die diese Phase ohne Wanderung des Bestands auslieferbar macht.
  const alt = await schlag({ id: 'm10', ziel: 'kern', festung: festung({ ohneBauteile: true }) });
  check('8a: sie nimmt den Schlag an', alt.status === 200, alt.body);
  check('8b: kein Schild-Durchlass - der volle Schaden kommt an',
    (alt.body.schaden || 0) > (mitSchild.body.schaden || 0) * 1.5,
    { ohneBauteile: alt.body.schaden, mitSchild: mitSchild.body.schaden });
  const qAlt = summe(alt.body.eigeneVerluste) / gesendet;
  check('8c: und die Verlustquote ist die der Stufe, nicht die der Türme',
    qAlt > 0.10 && qAlt < 0.19, { quote: qAlt.toFixed(3) });
  check('8d: die Antwort führt keine Bauteile',
    Object.keys(alt.body.bauteile || {}).length === 0, { bauteile: alt.body.bauteile });

  await stoppeServer();
  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})();
