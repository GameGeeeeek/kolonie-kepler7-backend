// Gefechtsvorraete im PvP-Kampf (18.08.2026, Etappe B1 des Wirtschafts-Rebalance-Konzepts).
//
// WARUM DIESER TEST IM BACKEND STEHT: Ein Vorrat veraendert den Ausgang eines Kampfes gegen einen
// ECHTEN Spieler. Er faellt damit auf die Seite der Grenze, die dieses Projekt verteidigt ("kann
// ich etwas anfassen, das anderen gehoert?"), und darf deshalb nicht vom Client gemeldet oder
// abgebucht werden. Der Server liest die WAHL aus dem Spielstand, prueft den Bestand, wendet den
// Bonus an und bucht selbst ab. Genau das wird hier an einem echten HTTP-Kampf gemessen.
//
// AUFBAU (Muster wie test_marktdeckel_http.js - EIN Bash-Aufruf, sonst verliert die Sandbox den
// Hintergrundprozess):
//   DB=$(mktemp /tmp/kepler-gv-XXXX.json); rm -f "$DB"; export DB_FILE="$DB"
//   PORT=3218 JWT_SECRET=test node server.js & PID=$!; sleep 3
//   node tests/test_gefechtsvorrat_http.js teil1        # legt beide Konten an
//   kill $PID; sleep 1
//   node -e "...db.private[<opferId>].__attackShieldUntil = 0..."   # Anfaengerschutz weg
//   PORT=3218 JWT_SECRET=test node server.js & PID=$!; sleep 3
//   node tests/test_gefechtsvorrat_http.js teil2        # misst
//
// DER ANFAENGERSCHUTZ MUSS DABEI WEG (CLAUDE.md, Backend-Testabschnitt): Frisch angelegte Konten
// sind unangreifbar, /api/attack antwortet mit 403, und der ganze Test misst nichts. Beim ersten
// Anlauf sah genau das nach "der Vorrat wirkt nicht" aus - in Wahrheit fand nie ein Kampf statt,
// und zwei Pruefungen wurden dadurch aus dem FALSCHEN Grund gruen (beide Seiten undefined,
// Regel 28). Die Vorab-Pruefung 1-vorab fuehrt deshalb die Antwort des Servers mit.
//
// JEDE MESSUNG BEKOMMT EIN EIGENES, FRISCHES OPFER - und das ist keine Bequemlichkeit, sondern
// die Lehre aus dem ersten Anlauf. Der Verteidiger ist zwar uebermaechtig (73.920 gegen 400), aber
// der PvP-Kampf hat einen BODEN von 19,6 % je Phase: Rund jeder zehnte Angriff geht trotzdem durch.
// Passiert das, verschiebt die Beute Ressourcen (auch Tier-2-Bestaende!) und der Verteidiger
// bekommt einen Schutzschild - danach antwortet /api/attack mit 403, und die restlichen Pruefungen
// messen gar nichts mehr. Beim ersten Anlauf sah genau das aus wie "der Vorrat wirkt nicht".
// Deshalb: ein eigenes Opfer je Messung, und jede Messung verlangt ausdruecklich einen VERLORENEN
// Angriff (success === false) - sonst wiederholt sie sich mit dem naechsten Opfer. Vor jedem
// Angriff wird auch der Spielstand des Angreifers neu geschrieben: Er verliert im Kampf Schiffe,
// und eine geschrumpfte Flotte waere eine wandernde Bezugsgroesse (Arbeitsregel 21).
//
// GEPRUEFT WIRD:
//   1. Ohne eingeschalteten Vorrat wird nichts abgebucht - die Bezugsmessung.
//   2. Mit Angriffs-Vorrat: die gemeldete Angriffskraft steigt um genau den Faktor der Tabelle,
//      und es werden genau `menge` Einheiten abgebucht.
//   3. Mit Verteidigungs-Vorrat: dasselbe fuer die Verteidigung, abgebucht beim VERTEIDIGER.
//   4. Zu wenig Bestand: kein Bonus UND kein Abzug (ein Teilabzug waere schlimmer als keiner).
//   5. Die Antwort weist beide Vorratslisten aus, damit der Kampfbericht sie zeigen kann.
//   6. DIE SICHERHEITSPRUEFUNG: Ein Client, der den Vorrat im REQUEST mitschickt, obwohl er im
//      Spielstand aus ist, bekommt weder Bonus noch Abbuchung. /api/attack nimmt bewusst keinen
//      Kampfparameter entgegen - diese Pruefung haelt das fest.
//
// GEGENPROBE (Arbeitsregel 1): Gegen den server.js von vor dieser Etappe
// (git show origin/master:server.js > server.alt.js im SELBEN Ordner, damit node_modules aufloest)
// fallen 2, 3, 4 und 5 - der alte Stand kennt weder Bonus noch Abbuchung noch die Felder.
const http = require('http');
const fs = require('fs');
const PORT = process.env.TEST_PORT || 3218;   // 3195-3217 sind belegt (Regel 29)
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
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (e) {} resolve({ status: res.statusCode, body: j, roh: buf }); });
    });
    req.on('error', e => resolve({ status: 0, body: null, roh: String(e) }));
    if (daten) req.write(daten);
    req.end();
  });
}

// Die Vorrats-Tabelle wird AUS server.js gelesen, nicht eingetippt: Wandern die Werte, wandert die
// Erwartung mit (Arbeitsregel 2/3).
const TABELLE = (() => {
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const a = src.indexOf('GEFECHTSVORRAETE = [');
  const b = a < 0 ? -1 : src.indexOf('\n];', a);
  if (a < 0 || b <= a) return null;
  try { return new Function('return [' + src.slice(a + 'GEFECHTSVORRAETE = ['.length, b) + '];')(); }
  catch (e) { return null; }
})();

async function konto(name, save) {
  await anfrage('POST', '/api/register', null, { username: name, password: 'geheim-123', email: name + '@example.invalid' });
  await new Promise(r => setTimeout(r, 700));
  const db = JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8'));
  const u = db.users[name];
  const eintrag = Object.entries(db.verifyTokens || {}).find(([, v]) => u && v.userId === u.userId);
  if (eintrag) await anfrage('POST', '/api/verify-email', null, { token: eintrag[0] });
  const login = await anfrage('POST', '/api/login', null, { username: name, password: 'geheim-123' });
  const token = login.body && login.body.token;
  await anfrage('PUT', '/api/storage/kepler7-save-v3', token, { value: JSON.stringify(save) });
  return { token, userId: u && u.userId };
}
const stand = async (token) => {
  const r = await anfrage('GET', '/api/storage/kepler7-save-v3', token, null);
  try { return JSON.parse(r.body.value); } catch (e) { return null; }
};

(async () => {
  check('0-vorab: die Vorrats-Tabelle liess sich aus server.js lesen', !!TABELLE && TABELLE.length >= 2,
    TABELLE && TABELLE.map(v => v.key));
  if (!TABELLE) { process.exit(1); }
  const ANG = TABELLE.find(v => v.seite === 'angriff');
  const VER = TABELLE.find(v => v.seite === 'verteidigung');
  check('0-vorab: je Seite ein Vorrat', !!ANG && !!VER, { angriff: ANG && ANG.key, verteidigung: VER && VER.key });
  if (!ANG || !VER) { process.exit(1); }

  const angreiferSave = (vorrat, bestand) => ({
    resources: Object.assign({ erz: 1e5, kristalle: 1e5, deuterium: 1e5, energie: 1e5, antimaterie: 1e4, forschungspunkte: 1000 },
      bestand || { [ANG.res]: ANG.menge * 5, [VER.res]: VER.menge * 5 }),
    credits: 1000, buildings: { lager: 60, werft: 10 }, research: {},
    fleet: { fighters: 60, cruisers: 20 }, colonies: {},
    gefechtsvorrat: vorrat || {}
  });
  // Uebermaechtige Verteidigung: Der Angreifer verliert immer, der Verteidiger bekommt also nie
  // einen Schutzschild und laesst sich wiederholt angreifen.
  const verteidigerSave = (vorrat, bestand) => ({
    resources: Object.assign({ erz: 1e5, kristalle: 1e5, deuterium: 1e5, energie: 1e5, antimaterie: 1e4, forschungspunkte: 1000 },
      bestand || { [ANG.res]: ANG.menge * 5, [VER.res]: VER.menge * 5 }),
    credits: 1000, buildings: { lager: 60, turm: 200, schild: 200, festung: 100 }, research: {},
    fleet: {}, colonies: {}, gefechtsvorrat: vorrat || {}
  });

  const teil = process.argv[2] || 'teil2';
  if (teil === 'teil1') {
    const a = await konto('gvangreifer', angreiferSave());
    // Ein Vorrat an Opfern: jede Messung verbraucht mindestens eins, ein gewonnener Angriff
    // verbraucht ein zusaetzliches. Zwoelf reichen fuer sechs Messungen mit reichlich Luft.
    const opfer = [];
    for (let i = 0; i < 12; i++) opfer.push(await konto('gvopfer' + i, verteidigerSave()));
    check('teil1: Angreifer und zwoelf Opfer angelegt',
      !!a.token && !!a.userId && opfer.every(o => o.token && o.userId), { opfer: opfer.filter(o => o.userId).length });
    console.log(fehl ? '\nFAIL' : '\nPASS');
    process.exit(fehl);
  }

  // teil2: neu anmelden (die Konten stehen seit teil1 in der DB).
  const anmelden = async (name) => {
    const l = await anfrage('POST', '/api/login', null, { username: name, password: 'geheim-123' });
    const db = JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8'));
    return { token: l.body && l.body.token, userId: db.users[name] && db.users[name].userId };
  };
  const A = await anmelden('gvangreifer');
  const OPFER = [];
  for (let i = 0; i < 12; i++) OPFER.push(await anmelden('gvopfer' + i));
  check('0-vorab: Angreifer und Opfer stehen', !!A.token && !!A.userId && OPFER.every(o => o.token && o.userId),
    { opfer: OPFER.filter(o => o.userId).length });
  let naechstesOpfer = 0;

  /* Ein Angriff auf ein FRISCHES Opfer, mit neu gesetzten Spielstaenden auf beiden Seiten.
     Wiederholt sich, solange der Angriff gewonnen wurde: Ein Sieg verschiebt Beute (und damit die
     gemessenen Bestaende) und setzt beim Opfer einen Schutzschild. Gemessen werden soll die
     Abbuchung des Vorrats, nicht die Beute. */
  async function angriff(angVorrat, verVorrat, angBestand, verBestand, was) {
    for (let versuch = 0; versuch < 4; versuch++) {
      const V = OPFER[naechstesOpfer++];
      if (!V) return { r: { status: 0, body: null }, fehler: 'Opfer aufgebraucht' };
      await anfrage('PUT', '/api/storage/kepler7-save-v3', A.token, { value: JSON.stringify(angreiferSave(angVorrat, angBestand)) });
      await anfrage('PUT', '/api/storage/kepler7-save-v3', V.token, { value: JSON.stringify(verteidigerSave(verVorrat, verBestand)) });
      const r = await anfrage('POST', '/api/attack', A.token, { targetUserId: V.userId });
      if (r.status === 200 && r.body && r.body.success === true) continue;   // gewonnen: Beute verfaelscht die Messung
      return { r, angDanach: await stand(A.token), verDanach: await stand(V.token), versuche: versuch + 1 };
    }
    return { r: { status: 0, body: null }, fehler: 'viermal gewonnen bei ' + was };
  }

  // ---- 1) Bezugsmessung ohne Vorrat ----------------------------------------------------------
  const basis = await angriff({}, {}, null, null, 'Bezugsmessung');
  check('1-vorab: der Angriff wird ueberhaupt ausgefuehrt (kein Schutzschild, kein Fehler)',
    basis.r.status === 200 && typeof (basis.r.body || {}).attackPower === 'number',
    { status: basis.r.status, fehler: basis.r.body && basis.r.body.error });
  const A0 = basis.r.body && basis.r.body.attackPower;
  const D0 = basis.r.body && basis.r.body.defensePower;
  check('1: ohne eingeschalteten Vorrat wird nichts abgebucht',
    basis.angDanach && basis.angDanach.resources[ANG.res] === ANG.menge * 5 &&
    basis.verDanach && basis.verDanach.resources[VER.res] === VER.menge * 5,
    { angreifer: basis.angDanach && basis.angDanach.resources[ANG.res], verteidiger: basis.verDanach && basis.verDanach.resources[VER.res] });

  // ---- 2) Angriffs-Vorrat --------------------------------------------------------------------
  const mitAng = await angriff({ [ANG.key]: true }, {}, null, null, 'Angriffs-Vorrat');
  check('2a: die gemeldete Angriffskraft steigt um genau den Faktor der Tabelle',
    mitAng.r.body && mitAng.r.body.attackPower === Math.round(A0 * (1 + ANG.bonus)),
    { ohne: A0, mit: mitAng.r.body && mitAng.r.body.attackPower, erwartet: Math.round(A0 * (1 + ANG.bonus)) });
  check('2b: und der Server bucht genau die Menge ab',
    mitAng.angDanach && mitAng.angDanach.resources[ANG.res] === ANG.menge * 5 - ANG.menge,
    { vorher: ANG.menge * 5, nachher: mitAng.angDanach && mitAng.angDanach.resources[ANG.res], menge: ANG.menge });
  check('2c: der Verteidigungswert bleibt dabei unberuehrt',
    mitAng.r.body && mitAng.r.body.defensePower === D0,
    { ohne: D0, mit: mitAng.r.body && mitAng.r.body.defensePower });

  // ---- 3) Verteidigungs-Vorrat ---------------------------------------------------------------
  const mitVer = await angriff({}, { [VER.key]: true }, null, null, 'Verteidigungs-Vorrat');
  check('3a: die gemeldete Verteidigung steigt um genau den Faktor der Tabelle',
    mitVer.r.body && mitVer.r.body.defensePower === Math.round(D0 * (1 + VER.bonus)),
    { ohne: D0, mit: mitVer.r.body && mitVer.r.body.defensePower, erwartet: Math.round(D0 * (1 + VER.bonus)) });
  check('3b: abgebucht wird beim VERTEIDIGER, nicht beim Angreifer',
    mitVer.verDanach && mitVer.verDanach.resources[VER.res] === VER.menge * 5 - VER.menge &&
    mitVer.angDanach && mitVer.angDanach.resources[VER.res] === VER.menge * 5,
    { verteidiger: mitVer.verDanach && mitVer.verDanach.resources[VER.res], angreifer: mitVer.angDanach && mitVer.angDanach.resources[VER.res] });

  // ---- 4) Zu wenig Bestand: kein Bonus UND kein Abzug -----------------------------------------
  const knapp = await angriff({ [ANG.key]: true }, {}, { [ANG.res]: ANG.menge - 1, [VER.res]: VER.menge * 5 }, null, 'knapper Bestand');
  check('4a: bei zu wenig Bestand bleibt die Angriffskraft auf dem Ausgangswert',
    knapp.r.body && knapp.r.body.attackPower === A0,
    { ohne: A0, knapp: knapp.r.body && knapp.r.body.attackPower });
  check('4b: und es wird NICHTS abgebucht (kein Teilabzug)',
    knapp.angDanach && knapp.angDanach.resources[ANG.res] === ANG.menge - 1,
    { bestand: knapp.angDanach && knapp.angDanach.resources[ANG.res] });

  // ---- 5) Die Antwort traegt beide Listen ------------------------------------------------------
  check('5: die Antwort weist den eingesetzten Vorrat aus, damit der Bericht ihn zeigen kann',
    Array.isArray(mitAng.r.body && mitAng.r.body.vorratAngriff) && mitAng.r.body.vorratAngriff.length === 1 &&
    mitAng.r.body.vorratAngriff[0].key === ANG.key &&
    Array.isArray(mitVer.r.body && mitVer.r.body.vorratVerteidigung) && mitVer.r.body.vorratVerteidigung.length === 1,
    { angriff: mitAng.r.body && mitAng.r.body.vorratAngriff, verteidigung: mitVer.r.body && mitVer.r.body.vorratVerteidigung });

  // ---- 6) SICHERHEIT: der Request kann den Vorrat nicht erzwingen -------------------------------
  const opferF = OPFER[naechstesOpfer++];
  await anfrage('PUT', '/api/storage/kepler7-save-v3', A.token, { value: JSON.stringify(angreiferSave({})) });
  await anfrage('PUT', '/api/storage/kepler7-save-v3', opferF.token, { value: JSON.stringify(verteidigerSave({})) });
  const gefaelscht = await anfrage('POST', '/api/attack', A.token, {
    targetUserId: opferF.userId,
    gefechtsvorrat: { [ANG.key]: true },
    vorrat: [{ key: ANG.key, bonus: 5 }],
    vorratAngriff: [{ key: ANG.key, bonus: 5 }]
  });
  const angNachFaelschung = await stand(A.token);
  check('6a: ein im Request mitgeschickter Vorrat wirkt NICHT auf die Angriffskraft',
    gefaelscht.body && gefaelscht.body.attackPower === A0,
    { ohne: A0, mitFaelschung: gefaelscht.body && gefaelscht.body.attackPower });
  check('6b: und er bucht auch nichts ab',
    angNachFaelschung && angNachFaelschung.resources[ANG.res] === ANG.menge * 5,
    { bestand: angNachFaelschung && angNachFaelschung.resources[ANG.res] });

  console.log(fehl ? '\nFAIL' : '\nPASS');
  process.exit(fehl);
})();
