// PvP auf alle Standorte, Etappe 1 (29.08.2026): /api/attack nimmt optional `targetPlanet`
// entgegen und kaempft dann gegen die Verteidigung EINES Standorts; GET /api/spieler-standorte
// liefert die Zielwahl-Liste. Auftrag Sascha: "es sollen alle von spielern kolonisierten
// planeten angreifbar sein mehr pvp aktion!"
//
// DIE ZWEI ZUSAGEN DES KONZEPTS (docs/pvp-standorte-konzept.md im Frontend-Repo), beide hier
// GEMESSEN statt behauptet:
//   (1) "Fehlt das Feld (alter Client), laeuft exakt der heutige Konto-Kampf" - Abschnitt 1
//       (keine neuen Felder im Altpfad) und Abschnitt 2 (byte-gleiche Kraefte).
//   (2) "computeDefensePower wird zur Summe ueber alle Standorte - byte-gleiches Ergebnis" -
//       der DAUERHAFTE Paritaetsanker ist 2c: fuer ein Konto OHNE Kolonien muss die
//       GET-verteidigung('home') exakt der Konto-defensePower eines echten Kampfes entsprechen.
//       Beide Werte entstehen aus DERSELBEN Faktorkette (kontoDefenseFaktoren), aber ueber die
//       zwei verschiedenen Einstiege - laufen die je auseinander, ist die Zerlegung kaputt.
//
// AUFBAU (Muster wie test_gefechtsvorrat_http.js - EIN Bash-Aufruf, sonst verliert die Sandbox
// den Hintergrundprozess; der Anfaengerschutz wird zwischen den Teilen bei GESTOPPTEM Server
// geleert, sonst flusht der Graceful Shutdown die Aenderung wieder weg - aendereDb-Regel):
//   DB=$(mktemp /tmp/kepler-pvst-XXXX.json); rm -f "$DB"; export DB_FILE="$DB"
//   PORT=3237 JWT_SECRET=test node server.js & PID=$!; sleep 3
//   node tests/test_pvp_standorte_http.js teil1        # legt Angreifer + neun Opfer an
//   kill $PID; sleep 1.5
//   node -e "...__attackShieldUntil = 0 fuer alle Opfer..."
//   PORT=3237 JWT_SECRET=test node server.js & PID=$!; sleep 3
//   node tests/test_pvp_standorte_http.js teil2        # misst
//
// DAS RATE-LIMIT IST TEIL DES MESSAUFBAUS: attackRateLimit erlaubt 20 Angriffe je Minute und
// IP+Pfad, und ALLE Anfragen dieses Tests teilen sich den einen Topf (127.0.0.1:/api/attack).
// Der Normallauf braucht ~13 Angriffe, der schlimmste Fall (Sieg-Wiederholungen) ~21 - deshalb
// wartet angriffAnfrage() bei einem 429 die Retry-After-Zeit ab, statt den 429 als Testergebnis
// zu deuten (dieselbe Familie wie der Markt-Sammelauftrag: ein Limit-Treffer ist kein Befund).
//
// JEDE MESSUNG BEKOMMT EIN EIGENES, FRISCHES OPFER (Hausregel aus test_gefechtsvorrat): Ein
// gewonnener Angriff verschiebt Beute und setzt beim Opfer einen Schutzschild - danach prallt
// jeder weitere Angriff mit 403 ab und die Folgepruefungen messen nichts mehr. Die zwei
// SIEG-Messungen (Abschnitt 5) brauchen umgekehrt einen Sieg und wiederholen mit neu
// geschriebenen Spielstaenden, bis er da ist (P(Niederlage) ~10% je Anlauf bei Uebermacht).
//
// GEPRUEFT WIRD:
//   1  Altpfad: ohne targetPlanet traegt weder Antwort noch Bericht ein Standortfeld.
//   2  home === Konto: zwei identische Opfer, byte-gleiche Kraefte; der home-Angriff traegt
//      die Standortfelder; GET-verteidigung('home') === Konto-defensePower (Paritaetsanker).
//   3  Validierung: unbekannter Standort -> 404 MIT GRUND, Nicht-String/ueberlang -> 400,
//      und Prototypen-Schluessel ('constructor' & Co.) ebenso - auch gegen ein Ziel OHNE
//      jede Kolonie (3d/3e, Sicherheitsbehebung 02.09.2026).
//   4  Die Kolonie verteidigt schwaecher als die Heimat desselben Kontos - und die GET-Route
//      nennt fuer BEIDE exakt die defensePower, mit der der Kampf danach rechnet (Anker von
//      ausserhalb der Kampfantwort, Regel 62).
//   5  Beutefaktor: Der Faktor wird als VERHAELTNIS gemessen (stolen / (Pool * lootPct)), denn
//      defenderLossPct traegt den Beutefaktor NICHT - das Verhaeltnis der beiden Antwortfelder
//      isoliert also genau den Faktor, unabhaengig vom Zufallswurf. Dazu die groben absoluten
//      Spannen als zweiter Anker (Pool 1 Mio ist eine feste Groesse von ausserhalb).
//   6  planetKey im pvp-fleet-loss nur im Standort-Fall.
//   7  Der Schutzschild ist KONTOWEIT: nach dem Kolonie-Sieg prallt der home-Angriff ab.
//   8  defenseBefore traegt nur die Anlagen des Standorts, und zerstoert wird nur dort
//      (Heimat schild:7 unveraendert, Kolonie turm 5 -> 4 - am neuen Stand DETERMINISTISCH,
//      weil die Kandidatenliste nur den einen Standort enthaelt).
//   9  defenderFleet ist die Standortflotte (Kolonie {fighters:5}, Konto beide summiert).
//  10  GET /api/spieler-standorte: home/kolonie/mond mit Art und Beutefaktor 1/0,5/0,35;
//      401 ohne Token, 404 bei unbekanntem Ziel, 400 ohne target-Parameter.
//
// GEGENPROBE (Regel 1/71): Runner mit `git show <alter-stand>:server.js > server.alt.js` im
// SELBEN Ordner (node_modules muss aufloesen) und PVP_STANDORT_TEST_SERVER=server.alt.js -
// der Runner startet dann die Kopie. Was am alten Stand fallen MUSS: 2b, 2b2, 2c, 3a, 3b, 3c,
// 4a, 4b, 4c, 5a, 5b, 6a, 8a, 9a, 10a, 10b, 10c, 10d. Was gruen bleiben MUSS (die additive
// Zusage): 1a, 1b, 2a, 5c, 6b, 7a, 9b. AUSDRUECKLICH IN KEINER LISTE: 8b - am alten Stand
// wuerfelt die Zerstoerung ueber ALLE Standorte, der Ausgang ist dort 50/50 (zwei Kandidaten)
// und damit kein Beleg in irgendeine Richtung.
//
// Belegte Testports sind jetzt 3195-3236 und 3237 (dieser Test) - ein neuer nimmt 3238
// (Regel 29; selbst messen: grep -hoE "TEST_PORT \|\| 3[0-9]+" tests/*.js | sort -u).
const http = require('http');
const fs = require('fs');
const PORT = process.env.TEST_PORT || 3237;
const BASIS = 'http://127.0.0.1:' + PORT;

let fehl = 0;
function check(name, ok, detail) {
  console.log((ok ? 'OK   - ' : 'FAIL - ') + name + (detail !== undefined ? ' | ' + JSON.stringify(detail) : ''));
  if (!ok) fehl = 1;
}
function anfrage(methode, pfad, token, body) {
  return new Promise((resolve) => {
    const daten = body ? JSON.stringify(body) : null;
    const req = http.request(BASIS + pfad, {
      method: methode,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {},
        daten ? { 'Content-Length': Buffer.byteLength(daten) } : {})
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, body: j, roh: buf }); });
    });
    req.on('error', e => resolve({ status: 0, body: null, roh: String(e) }));
    if (daten) req.write(daten);
    req.end();
  });
}
// Angriffs-Anfrage mit 429-Wartelogik: Das attackRateLimit (20/min je IP+Pfad) ist hier eine
// Eigenschaft des Messaufbaus, kein Messgegenstand - bei 429 wird Retry-After abgewartet und
// derselbe Angriff wiederholt (hoechstens zweimal, sonst ist wirklich etwas kaputt).
async function angriffAnfrage(token, body) {
  for (let i = 0; i < 3; i++) {
    const r = await anfrage('POST', '/api/attack', token, body);
    if (r.status !== 429) return r;
    const wartezeit = (parseInt((r.headers || {})['retry-after'], 10) || 61) + 1;
    console.log('     (429 vom attackRateLimit - warte ' + wartezeit + 's)');
    await new Promise(res => setTimeout(res, wartezeit * 1000));
  }
  return { status: 429, body: null };
}
// Spielstand aus der DB-DATEI lesen - sicher, weil /api/attack sein saveDb() abwartet, bevor es
// antwortet. Beide Speicherformen (blanke Zeichenkette oder { value, version }) - die Falle aus
// test_alien_nester_http, die dort 30 Pruefungen verschluckt hat (Regel 34).
function liesDb() { return JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8')); }
function liesSave(db, userId) {
  const eintrag = db.private[userId] && db.private[userId]['kepler7-save-v3'];
  if (eintrag === undefined || eintrag === null) return null;
  const roh = typeof eintrag === 'string' ? eintrag : eintrag.value;
  try { return JSON.parse(roh); } catch (e) { return null; }
}

async function konto(name, save) {
  await anfrage('POST', '/api/register', null, { username: name, password: 'geheim-123', email: name + '@example.invalid' });
  await new Promise(r => setTimeout(r, 700));
  const db = liesDb();
  const u = db.users[name];
  const eintrag = Object.entries(db.verifyTokens || {}).find(([, v]) => u && v.userId === u.userId);
  if (eintrag) await anfrage('POST', '/api/verify-email', null, { token: eintrag[0] });
  const login = await anfrage('POST', '/api/login', null, { username: name, password: 'geheim-123' });
  const token = login.body && login.body.token;
  await anfrage('PUT', '/api/storage/kepler7-save-v3', token, { value: JSON.stringify(save) });
  return { token, userId: u && u.userId };
}

// --- Fixtures ------------------------------------------------------------------------------
// Der Angreifer ist gegen die STARKEN Opfer chancenarm (misst Kraefte ohne Beute-Nebenwirkung)
// und gegen die SCHWACHEN uebermaechtig (erzwingt die Sieg-Messungen).
const angreiferSave = () => ({
  resources: { erz: 1e5, kristalle: 1e5, deuterium: 1e5, energie: 1e5, antimaterie: 1e4, forschungspunkte: 1000 },
  credits: 1000, buildings: { lager: 60, werft: 10 }, research: {},
  fleet: { fighters: 60, cruisers: 20 }, colonies: {}
});
// Stark, OHNE Kolonien - fuer Altpfad, home===Konto und den Paritaetsanker.
const starkOhneKolonien = () => ({
  resources: { erz: 1e5, kristalle: 1e5, deuterium: 1e5, energie: 1e5 },
  credits: 1000, buildings: { lager: 60, turm: 200, schild: 200, festung: 100 }, research: {},
  fleet: {}, colonies: {}
});
// Stark daheim, schwaechere Kolonie - fuer den Vergleich Heimat gegen Kolonie.
const starkMitKolonie = () => ({
  resources: { erz: 1e5, kristalle: 1e5, deuterium: 1e5, energie: 1e5 },
  credits: 1000, buildings: { lager: 60, turm: 200, schild: 200, festung: 100 }, research: {},
  fleet: {}, colonies: { kolonie_beta: { buildings: { turm: 20 }, fleet: {} } }
});
// Schwach, GENAU 1 Mio Erz als messbarer Beute-Pool; Heimat- und Kolonie-Anlagen tragen
// VERSCHIEDENE Schluessel (schild daheim, turm in der Kolonie), damit defenseBefore und die
// Zerstoerung eindeutig einem Standort zuzuordnen sind.
const schwachMitKolonie = () => ({
  resources: { erz: 1000000 },
  credits: 0, buildings: { schild: 7 }, research: {},
  fleet: {}, colonies: { kolonie_beta: { buildings: { turm: 5 }, fleet: {} } }
});
const schwachOhneKolonie = () => ({
  resources: { erz: 1000000 },
  credits: 0, buildings: { schild: 7 }, research: {},
  fleet: {}, colonies: {}
});
// Flotten-Split: daheim Kreuzer, in der Kolonie Jaeger - defenderFleet muss den Unterschied zeigen.
const flottenSplit = () => ({
  resources: { erz: 1e5 },
  credits: 0, buildings: { lager: 60, turm: 200, schild: 200 }, research: {},
  fleet: { cruisers: 50 }, colonies: { kolonie_beta: { buildings: {}, fleet: { fighters: 5 } } }
});
// Drei Standortarten fuer die GET-Route: Heimat, Kolonie, Mond (moon_-Praefix).
const dreiStandorte = () => ({
  resources: { erz: 1e5 },
  credits: 0, buildings: { turm: 10 }, research: {},
  fleet: {}, colonies: { kolonie_beta: { buildings: { turm: 5 }, fleet: {} }, moon_beta: { buildings: { turm: 2 }, fleet: {} } }
});

// Alle Kontonamen KLEINGESCHRIEBEN: db.users speichert seine Schluessel per toLowerCase()
// (server.js ~Z. 2057) - ein Name mit Grossbuchstaben laeuft beim DB-Nachschlag ins Leere,
// und der Fehler sieht aus wie ein fehlgeschlagenes Register (Regel 4: ablesen, nie raten).
const OPFER_NAMEN = ['pvopfera', 'pvopferb', 'pvopferc1', 'pvopferc2', 'pvopferw', 'pvopferh', 'pvopferf', 'pvopferf2', 'pvopferg'];
const OPFER_SAVES = {
  pvopfera: starkOhneKolonien, pvopferb: starkOhneKolonien,
  pvopferc1: starkMitKolonie, pvopferc2: starkMitKolonie,
  pvopferw: schwachMitKolonie, pvopferh: schwachOhneKolonie,
  pvopferf: flottenSplit, pvopferf2: flottenSplit,
  pvopferg: dreiStandorte
};

(async () => {
  const teil = process.argv[2] || 'teil2';
  if (teil === 'teil1') {
    const a = await konto('pvangreifer', angreiferSave());
    const opfer = [];
    for (const name of OPFER_NAMEN) opfer.push(await konto(name, OPFER_SAVES[name]()));
    check('teil1: Angreifer und neun Opfer angelegt',
      !!a.token && !!a.userId && opfer.every(o => o.token && o.userId), { opfer: opfer.filter(o => o.userId).length });
    console.log(fehl ? '\nFAIL' : '\nPASS');
    process.exit(fehl);
  }

  // teil2: neu anmelden (die Konten stehen seit teil1 in der DB, der Anfaengerschutz ist vom
  // Runner bei gestopptem Server geleert worden).
  const anmelden = async (name) => {
    const l = await anfrage('POST', '/api/login', null, { username: name, password: 'geheim-123' });
    const db = liesDb();
    return { token: l.body && l.body.token, userId: db.users[name] && db.users[name].userId };
  };
  const A = await anmelden('pvangreifer');
  const O = {};
  for (const name of OPFER_NAMEN) O[name] = await anmelden(name);
  check('0-vorab: Angreifer und neun Opfer stehen',
    !!A.token && !!A.userId && OPFER_NAMEN.every(n => O[n].token && O[n].userId),
    { da: OPFER_NAMEN.filter(n => O[n].userId).length });

  // Vor jedem Angriff beide Spielstaende FRISCH schreiben - der Angreifer verliert im Kampf
  // Punkte-Deltas und im Siegfall kommt Beute dazu; eine gewanderte Bezugsgroesse waere die
  // Falle aus Arbeitsregel 21.
  async function frisch(opferName) {
    await anfrage('PUT', '/api/storage/kepler7-save-v3', A.token, { value: JSON.stringify(angreiferSave()) });
    await anfrage('PUT', '/api/storage/kepler7-save-v3', O[opferName].token, { value: JSON.stringify(OPFER_SAVES[opferName]()) });
  }

  // ==== 1 + 2: Altpfad und home === Konto ====================================================
  // GET-Paritaetsanker VOR dem Angriff (die GET-Route mutiert nichts, der Kampf schreibt danach).
  await frisch('pvopfera');
  const getA = await anfrage('GET', '/api/spieler-standorte?target=' + O.pvopfera.userId, A.token, null);
  const kampfKonto = await angriffAnfrage(A.token, { targetUserId: O.pvopfera.userId });
  // Den Altpfad-Bericht SOFORT lesen (unshift -> Index 0), BEVOR der naechste Kampf einen
  // juengeren darueberlegt - der erste Entwurf las erst nach dem home-Kampf und mass dessen
  // Bericht, der die Standortfelder zu Recht traegt (der Fehlschlag sah aus wie ein Codefehler).
  const berichtAltpfad = ((liesDb().private[A.userId] || {}).__reports || [])[0] || {};
  await frisch('pvopferb');
  const kampfHome = await angriffAnfrage(A.token, { targetUserId: O.pvopferb.userId, targetPlanet: 'home' });
  const berichtHome = ((liesDb().private[A.userId] || {}).__reports || [])[0] || {};

  check('2-vorab: beide Kaempfe ausgefuehrt (kein Schild, kein Fehler)',
    kampfKonto.status === 200 && typeof (kampfKonto.body || {}).attackPower === 'number' &&
    kampfHome.status === 200 && typeof (kampfHome.body || {}).attackPower === 'number',
    { konto: kampfKonto.status, home: kampfHome.status, fehler: [(kampfKonto.body || {}).error, (kampfHome.body || {}).error] });

  const kb = kampfKonto.body || {};
  check('1a: Altpfad-Antwort traegt KEINE Standortfelder',
    typeof kb.attackPower === 'number' &&
    !('targetPlanet' in kb) && !('standortArt' in kb) && !('beuteFaktor' in kb),
    { schluessel: Object.keys(kb).filter(k => /target|standort|beute/i.test(k)) });
  check('1b: Altpfad-Bericht traegt KEINE Standortfelder',
    berichtAltpfad.type === 'attack-sent' &&
    !('targetPlanet' in berichtAltpfad) && !('standortArt' in berichtAltpfad) && !('beuteFaktor' in berichtAltpfad),
    { typ: berichtAltpfad.type, schluessel: Object.keys(berichtAltpfad).filter(k => /target(P|Art)|standort|beute/i.test(k)) });

  const hb = kampfHome.body || {};
  check('2a: home-Angriff und Konto-Angriff nennen BYTE-GLEICHE Kraefte',
    typeof kb.attackPower === 'number' && kb.attackPower === hb.attackPower && kb.defensePower === hb.defensePower,
    { konto: { atk: kb.attackPower, def: kb.defensePower }, home: { atk: hb.attackPower, def: hb.defensePower } });
  check('2b: der home-Angriff traegt die Standortfelder',
    hb.targetPlanet === 'home' && hb.standortArt === 'heimat' && hb.beuteFaktor === 1,
    { targetPlanet: hb.targetPlanet, standortArt: hb.standortArt, beuteFaktor: hb.beuteFaktor });
  check('2b2: der home-Kampf-BERICHT traegt die Standortfelder (die addReport-Spreads wirken)',
    berichtHome.type === 'attack-sent' && berichtHome.targetPlanet === 'home' &&
    berichtHome.standortArt === 'heimat' && berichtHome.beuteFaktor === 1,
    { typ: berichtHome.type, targetPlanet: berichtHome.targetPlanet, standortArt: berichtHome.standortArt, beuteFaktor: berichtHome.beuteFaktor });
  const getAHome = (((getA.body || {}).standorte) || []).find(s => s.key === 'home');
  check('2c: GET-verteidigung(home) === Konto-defensePower (Float-Paritaetsanker der Zerlegung)',
    typeof kb.defensePower === 'number' && !!getAHome && getAHome.verteidigung === kb.defensePower,
    { get: getAHome && getAHome.verteidigung, kampf: kb.defensePower, getStatus: getA.status });

  // ==== 3: Validierung =======================================================================
  const unbekannt = await angriffAnfrage(A.token, { targetUserId: O.pvopferg.userId, targetPlanet: 'gibtsnicht' });
  check('3a: unbekannter Standort -> 404 MIT GRUND',
    unbekannt.status === 404 && /aufgegeben/.test((unbekannt.body || {}).error || ''),
    { status: unbekannt.status, fehler: (unbekannt.body || {}).error });
  const keinString = await angriffAnfrage(A.token, { targetUserId: O.pvopferg.userId, targetPlanet: 123 });
  check('3b: Nicht-String -> 400 Ungueltiger Standort',
    keinString.status === 400 && /Standort/.test((keinString.body || {}).error || ''),
    { status: keinString.status, fehler: (keinString.body || {}).error });
  const zuLang = await angriffAnfrage(A.token, { targetUserId: O.pvopferg.userId, targetPlanet: 'x'.repeat(65) });
  check('3c: ueberlanger Standort -> 400',
    zuLang.status === 400 && /Standort/.test((zuLang.body || {}).error || ''),
    { status: zuLang.status, fehler: (zuLang.body || {}).error });

  /* 3d/3e - Prototypen-Schluessel (Sicherheitsbehebung 02.09.2026). Die Schranke fragte bis hierher
     `!((target.colonies || {})[targetPlanet])`, also den WAHRHEITSWERT. Ein Objektliteral erbt aber
     die Namen aus Object.prototype: `{}['constructor']` ist die Funktion Object und damit wahr.
     Gemessen am alten Stand: Status 200, defensePower 0, success true - also 90% Siegchance (die
     Obergrenze) gegen JEDES Konto, mit einem einzigen Schiff, samt Beute und Kampfpunkten.
     Geprueft wird der STATUS UND die Wirkung (defensePower/success wandern in die Zusatzangabe),
     damit ein Fehlschlag zeigt, was der Angreifer bekommen haette - ein nacktes "erwartet 404,
     bekam 200" laesst offen, ob das ueberhaupt ausnutzbar war. */
  const PROTO_SCHLUESSEL = ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'];
  const protoErgebnis = [];
  for (const k of PROTO_SCHLUESSEL){
    const r = await angriffAnfrage(A.token, { targetUserId: O.pvopferg.userId, targetPlanet: k });
    protoErgebnis.push({ key: k, status: r.status, defensePower: (r.body || {}).defensePower, sieg: (r.body || {}).success });
  }
  check('3d: Prototypen-Schluessel werden abgewiesen wie jeder andere unbekannte Standort',
    protoErgebnis.every(r => r.status === 404), protoErgebnis);

  // Der schaerfste Fall: pvopferh hat GAR KEINE Kolonien. Die alte Schranke liess auch hier durch,
  // weil sie nicht die Kolonien las, sondern den Prototyp des leeren Objekts.
  const protoOhne = await angriffAnfrage(A.token, { targetUserId: O.pvopferh.userId, targetPlanet: 'constructor' });
  check('3e: auch ein Ziel OHNE jede Kolonie weist einen Prototypen-Schluessel ab',
    protoOhne.status === 404,
    { status: protoOhne.status, defensePower: (protoOhne.body || {}).defensePower, sieg: (protoOhne.body || {}).success });

  // ==== 4: Kolonie schwaecher als Heimat, GET === Kampf ======================================
  await frisch('pvopferc1');
  const getC1 = await anfrage('GET', '/api/spieler-standorte?target=' + O.pvopferc1.userId, A.token, null);
  const kampfC1 = await angriffAnfrage(A.token, { targetUserId: O.pvopferc1.userId, targetPlanet: 'home' });
  await frisch('pvopferc2');
  const getC2 = await anfrage('GET', '/api/spieler-standorte?target=' + O.pvopferc2.userId, A.token, null);
  const kampfC2 = await angriffAnfrage(A.token, { targetUserId: O.pvopferc2.userId, targetPlanet: 'kolonie_beta' });
  const dHome = (kampfC1.body || {}).defensePower, dKol = (kampfC2.body || {}).defensePower;
  check('4-vorab: beide Standort-Kaempfe ausgefuehrt',
    kampfC1.status === 200 && kampfC2.status === 200 && typeof dHome === 'number' && typeof dKol === 'number',
    { c1: kampfC1.status, c2: kampfC2.status, fehler: [(kampfC1.body || {}).error, (kampfC2.body || {}).error] });
  check('4a: die Kolonie verteidigt SCHWAECHER als die Heimat desselben Kontos',
    typeof dHome === 'number' && typeof dKol === 'number' && dKol > 0 && dKol < dHome,
    { heimat: dHome, kolonie: dKol });
  const getC1Home = (((getC1.body || {}).standorte) || []).find(s => s.key === 'home');
  const getC2Kol = (((getC2.body || {}).standorte) || []).find(s => s.key === 'kolonie_beta');
  check('4b: GET-verteidigung(home) === Kampf-defensePower(home)',
    typeof dHome === 'number' && !!getC1Home && getC1Home.verteidigung === dHome,
    { get: getC1Home && getC1Home.verteidigung, kampf: dHome });
  check('4c: GET-verteidigung(kolonie) === Kampf-defensePower(kolonie)',
    typeof dKol === 'number' && !!getC2Kol && getC2Kol.verteidigung === dKol,
    { get: getC2Kol && getC2Kol.verteidigung, kampf: dKol });

  // ==== 5-8: die zwei SIEG-Messungen =========================================================
  // Wiederholen bis zum Sieg - eine Niederlage setzt keinen Schutzschild, dieselben Konten
  // lassen sich also mit frisch geschriebenen Spielstaenden erneut messen. Der Fehlschlag
  // fuehrt die Serverantworten mit (Regel 37: die Ursache gehoert ins Protokoll).
  async function siegAuf(opferName, body, was) {
    const antworten = [];
    for (let versuch = 0; versuch < 6; versuch++) {
      await frisch(opferName);
      const r = await angriffAnfrage(A.token, Object.assign({ targetUserId: O[opferName].userId }, body));
      antworten.push(r.status + ':' + ((r.body || {}).error || ((r.body || {}).success === true ? 'SIEG' : 'niederlage')));
      if (r.status === 200 && r.body && r.body.success === true) return { r, versuche: versuch + 1, antworten };
    }
    return { r: { status: 0, body: null }, versuche: 6, antworten, fehler: 'kein Sieg bei ' + was };
  }

  const siegKol = await siegAuf('pvopferw', { targetPlanet: 'kolonie_beta' }, 'Kolonie-Sieg');
  const wk = siegKol.r.body || {};
  check('5-vorab: Sieg auf der Kolonie herbeigefuehrt',
    wk.success === true, { versuche: siegKol.versuche, antworten: siegKol.antworten });
  // Der Beutefaktor als VERHAELTNIS zweier Antwortfelder: defenderLossPct = lootPct/2 traegt den
  // Faktor NICHT, stolen schon - stolen / (Pool * defenderLossPct * 2) isoliert ihn also exakt,
  // unabhaengig vom Zufallswurf (die Rundung von defenderLossPct auf drei Stellen laesst
  // hoechstens ~0,5% Spiel, deshalb die Toleranz 0,02).
  const faktorKol = wk.defenderLossPct > 0 ? (wk.stolen && wk.stolen.erz || 0) / (1000000 * wk.defenderLossPct * 2) : null;
  check('5a: Kolonie-Beute = HALBE Beutequote (Faktor 0,5 gemessen, nicht behauptet)',
    faktorKol !== null && Math.abs(faktorKol - 0.5) < 0.02,
    { gemessenerFaktor: faktorKol, stolen: wk.stolen && wk.stolen.erz, defenderLossPct: wk.defenderLossPct });
  check('5a2: und absolut in der halbierten Spanne (Pool 1 Mio, 12-25% halbiert)',
    wk.stolen && wk.stolen.erz >= 60000 && wk.stolen.erz <= 125000, { erz: wk.stolen && wk.stolen.erz });
  check('5b: die Sieg-Antwort nennt beuteFaktor 0,5 und die Standortfelder',
    wk.beuteFaktor === 0.5 && wk.targetPlanet === 'kolonie_beta' && wk.standortArt === 'kolonie',
    { beuteFaktor: wk.beuteFaktor, targetPlanet: wk.targetPlanet, standortArt: wk.standortArt });

  // 6a + 8: direkt nach dem Kolonie-Sieg messen (die DB ist frisch - der Handler wartet sein
  // saveDb() ab, bevor er antwortet).
  const dbNachKol = liesDb();
  const rewardsW = ((dbNachKol.private[O.pvopferw.userId] || {}).__pendingRewards || []);
  const lossW = rewardsW.filter(r => r.type === 'pvp-fleet-loss').pop();
  check('6a: pvp-fleet-loss traegt den planetKey der Kolonie',
    !!lossW && lossW.planetKey === 'kolonie_beta',
    { reward: lossW && { pct: lossW.pct, planetKey: lossW.planetKey } });
  check('8a: defenseBefore traegt NUR die Anlagen des Standorts',
    JSON.stringify(wk.defenseBefore) === JSON.stringify({ turm: 5 }),
    { defenseBefore: wk.defenseBefore });
  const saveWnach = liesSave(dbNachKol, O.pvopferw.userId);
  check('8b: zerstoert wird nur am Standort (Heimat-schild 7 unveraendert, Kolonie-turm 5 -> 4)',
    !!saveWnach && (saveWnach.buildings || {}).schild === 7 &&
    ((saveWnach.colonies || {}).kolonie_beta || {}).buildings.turm === 4,
    { heimatSchild: saveWnach && (saveWnach.buildings || {}).schild, kolonieTurm: saveWnach && (((saveWnach.colonies || {}).kolonie_beta || {}).buildings || {}).turm });

  // 7: derselbe Sieg hat den KONTOWEITEN Schild gesetzt - der home-Angriff prallt ab.
  const nachSieg = await angriffAnfrage(A.token, { targetUserId: O.pvopferw.userId, targetPlanet: 'home' });
  check('7a: der Schutzschild ist KONTOWEIT - home-Angriff nach Kolonie-Sieg -> 403',
    nachSieg.status === 403 && /Schutzschild/.test((nachSieg.body || {}).error || ''),
    { status: nachSieg.status, fehler: (nachSieg.body || {}).error });

  // 5c + 6b: der Heimat-Sieg OHNE targetPlanet (Altpfad) als Gegenstueck.
  const siegHeim = await siegAuf('pvopferh', {}, 'Heimat-Sieg');
  const hk = siegHeim.r.body || {};
  check('5c-vorab: Sieg auf der Heimat (Altpfad) herbeigefuehrt',
    hk.success === true, { versuche: siegHeim.versuche, antworten: siegHeim.antworten });
  const faktorHeim = hk.defenderLossPct > 0 ? (hk.stolen && hk.stolen.erz || 0) / (1000000 * hk.defenderLossPct * 2) : null;
  check('5c: Heimat-Beute = VOLLE Beutequote (Faktor 1,0 - bleibt auch am alten Stand gruen)',
    faktorHeim !== null && Math.abs(faktorHeim - 1.0) < 0.02,
    { gemessenerFaktor: faktorHeim, stolen: hk.stolen && hk.stolen.erz, defenderLossPct: hk.defenderLossPct });
  const rewardsH = ((liesDb().private[O.pvopferh.userId] || {}).__pendingRewards || []);
  const lossH = rewardsH.filter(r => r.type === 'pvp-fleet-loss').pop();
  check('6b: der Altpfad-Verlust traegt KEIN planetKey',
    !!lossH && !('planetKey' in lossH), { reward: lossH && { pct: lossH.pct, planetKey: lossH.planetKey } });

  // ==== 9: defenderFleet ist die Standortflotte ==============================================
  await frisch('pvopferf');
  const kampfF = await angriffAnfrage(A.token, { targetUserId: O.pvopferf.userId, targetPlanet: 'kolonie_beta' });
  await frisch('pvopferf2');
  const kampfF2 = await angriffAnfrage(A.token, { targetUserId: O.pvopferf2.userId });
  check('9a: defenderFleet ist die STANDORTFLOTTE der Kolonie',
    JSON.stringify((kampfF.body || {}).defenderFleet) === JSON.stringify({ fighters: 5 }),
    { defenderFleet: (kampfF.body || {}).defenderFleet, status: kampfF.status });
  check('9b: ohne targetPlanet die KONTOFLOTTE (beide Standorte summiert)',
    JSON.stringify((kampfF2.body || {}).defenderFleet) === JSON.stringify({ cruisers: 50, fighters: 5 }),
    { defenderFleet: (kampfF2.body || {}).defenderFleet, status: kampfF2.status });

  // ==== 10: die GET-Route ====================================================================
  const getG = await anfrage('GET', '/api/spieler-standorte?target=' + O.pvopferg.userId, A.token, null);
  const liste = ((getG.body || {}).standorte) || [];
  const artVon = k => (liste.find(s => s.key === k) || {}).art;
  const faktorVon = k => (liste.find(s => s.key === k) || {}).beuteFaktor;
  check('10a: GET nennt home/kolonie/mond mit Art und Beutefaktor 1/0,5/0,35',
    liste.length === 3 &&
    artVon('home') === 'heimat' && faktorVon('home') === 1 &&
    artVon('kolonie_beta') === 'kolonie' && faktorVon('kolonie_beta') === 0.5 &&
    artVon('moon_beta') === 'mond' && faktorVon('moon_beta') === 0.35 &&
    liste.every(s => typeof s.verteidigung === 'number' && s.verteidigung >= 0),
    { status: getG.status, liste });
  const ohneToken = await anfrage('GET', '/api/spieler-standorte?target=' + O.pvopferg.userId, null, null);
  check('10b: GET ohne Token -> 401', ohneToken.status === 401, { status: ohneToken.status });
  // 10c/10d pruefen den GRUND mit (Regel 28): Am alten Stand antwortet die FEHLENDE Route
  // ebenfalls mit 404 - nur eben als Express-HTML ("Cannot GET") statt als JSON mit Fehlertext.
  // Ein blanker Statuscode-Vergleich waere dort aus dem falschen Grund gruen.
  const falschesZiel = await anfrage('GET', '/api/spieler-standorte?target=gibtsnicht', A.token, null);
  check('10c: GET mit unbekanntem Ziel -> 404 MIT GRUND',
    falschesZiel.status === 404 && /Spielstand/.test((falschesZiel.body || {}).error || ''),
    { status: falschesZiel.status, fehler: (falschesZiel.body || {}).error });
  const ohneZiel = await anfrage('GET', '/api/spieler-standorte', A.token, null);
  check('10d: GET ohne target -> 400 MIT GRUND',
    ohneZiel.status === 400 && /Ziel/.test((ohneZiel.body || {}).error || ''),
    { status: ohneZiel.status, fehler: (ohneZiel.body || {}).error });

  console.log(fehl ? '\nFAIL' : '\nPASS');
  process.exit(fehl);
})();
