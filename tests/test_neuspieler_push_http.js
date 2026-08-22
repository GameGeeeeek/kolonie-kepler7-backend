// Push an das Betreiberkonto, wenn ein neuer Spieler die Kolonie zum ersten Mal oeffnet
// (22.08.2026, Auftrag Sascha: "fuege hinzu wenn sich neuer spieler anmeldet und spielt bekommt
// gamegeeeeek eine push nachricht").
//
// DER AUSLOESEPUNKT IST EINE ENTSCHEIDUNG, KEINE TECHNISCHE ZWANGSLAEUFIGKEIT - Sascha hat unter
// drei gemessenen Moeglichkeiten gewaehlt: erster Spielstand-Save ("hat die Kolonie geoeffnet")
// statt "nach 5 Minuten Spielzeit" oder "bei echtem Fortschritt". Und ausdruecklich: eine Meldung
// je Neuling, SOFORT, ohne Buendelung.
//
// WARUM DIESER PUNKT UEBERHAUPT TRAEGT (beides gemessen, nicht angenommen):
//   * Er liegt hinter der E-Mail-Bestaetigung. /api/register stellt kein Token aus, /api/login
//     weist emailVerified === false mit 403 ab. An der Registrierung haengend waere die Meldung
//     mit 1.440 Aufrufen je Tag und IP flutbar, ohne dass jemand eine Mail lesen muesste.
//   * 'existing === undefined' bei SAVE_KEY ist EINMALIG je Konto: Es gibt keinen Pfad, der einen
//     Spielstand loescht, und kein Fremdzugriff kann zuvorkommen (/api/attack bricht mit 404 ab,
//     wenn das Ziel keinen Spielstand hat). Die Bedingung ist damit selbst die Idempotenz-Marke -
//     deshalb gibt es kein zusaetzliches Feld, und Abschnitt 2 misst genau das.
//
// DIE WICHTIGSTE PRUEFUNG IST 6 (Persistenz ueber einen Neustart). pushNotificationEvent schreibt
// den Postfach-Eintrag nur in den ARBEITSSPEICHER; steht der Aufruf hinter dem saveDb() des
// Endpunkts, ist er beim naechsten Neustart weg - und im Quelltext sieht das voellig unauffaellig
// aus. Genau dieser Fehler ist bei der Feedback-Push schon einmal passiert und steht dort als
// Warnung im Code. Eine Messung im selben Prozess waere aus dem falschen Grund gruen - und eine
// Messung mit SIGTERM ebenfalls: Der Graceful Shutdown flusht den Arbeitsspeicher und nimmt genau
// den Eintrag mit, dessen Verlust gemessen werden soll (der erste Entwurf tat das, und die
// Gegenprobe hat es als WERKZEUGFEHLER gemeldet). Abschnitt 6 stoppt deshalb mit SIGKILL.
//
// Port 3231 (3195-3230 sind belegt; gemessen mit
// `grep -hoE "3[12][0-9][0-9]" tests/*.js | sort -un` - ein Muster auf "PORT = <zahl>" uebersieht
// die Form `Number(process.env.TEST_PORT || 3230)`).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3231);

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ADMIN = crypto.randomUUID(), NEU = crypto.randomUUID(), ZWEIT = crypto.randomUUID();

function spielstand(id, name) {
  return {
    resources: { energie: 1e4, erz: 1e4, kristalle: 1e4, deuterium: 1e4, antimaterie: 10, forschungspunkte: 10 },
    buildings: {}, research: {}, colonies: {}, fleet: { missions: [] },
    player: { id, name }, credits: 100, xp: 0, prestige: 0, battlePoints: 0, lastTick: Date.now()
  };
}
function grunddb() {
  return {
    // 'gamegeeeeek' MUSS kleingeschrieben sein - db.users wird mit dem kleingeschriebenen Namen
    // geschluesselt, und genau daran haengt die Betreiber-Suche in der Aufrufstelle.
    users: {
      gamegeeeeek: { userId: ADMIN, username: 'GameGeeeeek', passwordHash: hash, emailVerified: true, createdAt: Date.now() },
      neuling:     { userId: NEU,   username: 'neuling',     passwordHash: hash, emailVerified: true, createdAt: Date.now() },
      zweiter:     { userId: ZWEIT, username: 'zweiter',     passwordHash: hash, emailVerified: true, createdAt: Date.now() }
    },
    // Der Betreiber HAT einen Spielstand (sonst loeste sein eigener erster Save die Meldung aus und
    // die Messung mischte zwei Faelle). Die beiden Neulinge haben KEINEN - das ist der Gegenstand.
    private: { [ADMIN]: { 'kepler7-save-v3': JSON.stringify(spielstand(ADMIN, 'GameGeeeeek')) } },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {} }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-neuspieler-' + process.pid + '.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-neusp-'));
let srv = null;
function aufraeumen() {
  try { if (srv) srv.kill(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
}
process.on('exit', aufraeumen);

async function starteServer() {
  let log = '';
  srv = spawn(process.execPath, [path.join(WURZEL, 'server.js')], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, {
      DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret',
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
  async function speichern(tok, wert, key) {
    return j('/storage/' + (key || 'kepler7-save-v3'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify({ value: JSON.stringify(wert) })
    });
  }
  return { j, anmelden, speichern, protokoll: () => log };
}
async function stoppeServer() {
  if (!srv) return;
  srv.kill('SIGTERM');            // flusht die DB (Graceful Shutdown)
  await warte(700);
  srv = null;
}
// Der HARTE Stopp fuer Abschnitt 6, und er ist der ganze Punkt dieses Abschnitts: SIGTERM loest den
// Graceful Shutdown aus, und der flusht die im Arbeitsspeicher gehaltene db auf Platte - er wuerde
// also genau den Eintrag mitnehmen, dessen Verlust hier gemessen werden soll. Mit SIGKILL bleibt in
// der Datei stehen, was das LETZTE saveDb() geschrieben hat. Damit unterscheidet der Abschnitt die
// zwei Faelle exakt: Steht der Push-Aufruf VOR dem saveDb() des Endpunkts, ist der Eintrag drin;
// steht er dahinter, ist der Spielstand drin und die Meldung weg.
// (Der erste Entwurf benutzte SIGTERM mit dem Kommentar, SIGKILL messe "etwas anderes" - das war
// ungemessen und falsch, und die Gegenprobe hat es als WERKZEUGFEHLER gemeldet.)
async function stoppeServerHart() {
  if (!srv) return;
  srv.kill('SIGKILL');
  await warte(400);
  srv = null;
}
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
// Jede Aenderung an der DB-DATEI laeuft durch diesen Helfer: SIGTERM flusht die im Speicher
// gehaltene db darueber, eine Aenderung am laufenden Server waere also wieder weg.
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  fn(d);
  schreibDb(d);
  return starteServer();
}
// Die Postfach-Eintraege des Betreibers, gefiltert auf unseren Typ.
function meldungen(d) {
  const liste = (d.private[ADMIN] && d.private[ADMIN].__notificationEvents) || [];
  return liste.filter(e => e.type === 'neuer-spieler');
}

(async () => {
  schreibDb(grunddb());
  let S = await starteServer();

  // ---------------------------------------------------------------- 1) der erste Save meldet
  {
    const d0 = liesDb();
    check('1-vorab: der Neuling hat wirklich noch keinen Spielstand',
      !(d0.private[NEU] && d0.private[NEU]['kepler7-save-v3']),
      { vorhanden: !!(d0.private[NEU] && d0.private[NEU]['kepler7-save-v3']) });

    const tok = await S.anmelden('neuling');
    check('1-vorab2: der Neuling kann sich anmelden', !!tok, { token: !!tok });

    const r = await S.speichern(tok, spielstand(NEU, 'neuling'));
    check('1-vorab3: der erste Save wird angenommen', r.status === 200 && r.body.version === 0,
      { status: r.status, version: r.body && r.body.version });

    const d = liesDb();
    const m = meldungen(d);
    check('1a: der Betreiber hat GENAU EINE Neuling-Meldung', m.length === 1, { anzahl: m.length });
    check('1b: die Meldung nennt den Namen des Neulings',
      !!(m[0] && m[0].payload && m[0].payload.username === 'neuling'),
      { username: m[0] && m[0].payload && m[0].payload.username });
    // Die Gesamtzahl muss die Konten MIT SPIELSTAND zaehlen, nicht die Registrierungen: In dieser
    // Fixture gibt es drei Konten, aber erst zwei haben je gespeichert (Betreiber + Neuling). Eine
    // Meldung mit Object.keys(db.users).length saegte 3 und meinte etwas anderes als ihr Satz.
    check('1c: die Gesamtzahl zaehlt Konten MIT Spielstand (2), nicht Registrierungen (3)',
      !!(m[0] && m[0].payload && m[0].payload.gesamt === 2),
      { gesamt: m[0] && m[0].payload && m[0].payload.gesamt, konten: Object.keys(d.users).length });
  }

  // ------------------------------------------------- 2) PAAR: der zweite Save meldet NICHT mehr
  {
    const tok = await S.anmelden('neuling');
    const r = await S.speichern(tok, spielstand(NEU, 'neuling'));
    check('2-vorab: der zweite Save wird angenommen und zaehlt hoch',
      r.status === 200 && r.body.version === 1, { status: r.status, version: r.body && r.body.version });
    const m = meldungen(liesDb());
    check('2a: er loest KEINE zweite Meldung aus', m.length === 1, { anzahl: m.length });
  }

  // -------------------------------------- 3) ein anderer Speicher-Schluessel loest nichts aus
  {
    const tok = await S.anmelden('zweiter');
    const r = await S.speichern(tok, { irgendwas: 1 }, 'kepler7-einstellungen');
    check('3-vorab: der Fremdschluessel wird angenommen', r.status === 200, { status: r.status });
    const m = meldungen(liesDb());
    check('3a: ein Save auf einen ANDEREN Schluessel meldet nichts', m.length === 1, { anzahl: m.length });
  }

  // ------------------------- 4) PAAR: die Kategorie schaltet die Meldung ab - und wieder an
  {
    // Erst ABSCHALTEN (ueber die echte Route, nicht per DB-Griff - genau diese Route baut die
    // Einstellungen komplett neu auf und ist laut Kommentar dort die tueckischste Stelle).
    const tokAdmin = await S.anmelden('gamegeeeeek');
    const r = await S.j('/notification-prefs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokAdmin },
      body: JSON.stringify({ neuspieler: false })
    });
    check('4-vorab: die Route kennt die Kategorie und gibt sie zurueck',
      r.status === 200 && r.body && r.body.neuspieler === false,
      { status: r.status, neuspieler: r.body && r.body.neuspieler });

    const tok = await S.anmelden('zweiter');
    const rs = await S.speichern(tok, spielstand(ZWEIT, 'zweiter'));
    check('4-vorab2: der erste Save des zweiten Neulings wird angenommen',
      rs.status === 200 && rs.body.version === 0, { status: rs.status, version: rs.body && rs.body.version });
    const m = meldungen(liesDb());
    check('4a: mit abgeschalteter Kategorie kommt KEINE Meldung', m.length === 1, { anzahl: m.length });
  }
  {
    // ...und die Gegenrichtung. Ohne sie waere 4a auch dann gruen, wenn die Meldung ueberhaupt
    // nicht mehr funktioniert.
    const tokAdmin = await S.anmelden('gamegeeeeek');
    await S.j('/notification-prefs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokAdmin },
      body: JSON.stringify({ neuspieler: true })
    });
    // Ein DRITTES Konto anlegen, weil 'zweiter' seinen ersten Save schon hinter sich hat.
    const DRITT = crypto.randomUUID();
    S = await aendereDb(d => {
      d.users.dritter = { userId: DRITT, username: 'dritter', passwordHash: hash, emailVerified: true, createdAt: Date.now() };
    });
    const tok = await S.anmelden('dritter');
    const rs = await S.speichern(tok, spielstand(DRITT, 'dritter'));
    check('4b-vorab: der erste Save des dritten Neulings wird angenommen',
      rs.status === 200 && rs.body.version === 0, { status: rs.status, version: rs.body && rs.body.version });
    const m = meldungen(liesDb());
    check('4b: mit eingeschalteter Kategorie kommt sie wieder', m.length === 2,
      { anzahl: m.length, namen: m.map(e => e.payload && e.payload.username) });
  }

  // ------------------------------------- 5) die Kategorie ueberlebt das Speichern (Rueckfall-Falle)
  {
    const tokAdmin = await S.anmelden('gamegeeeeek');
    // Die Route baut das Objekt komplett neu auf. Ein dort fehlender Schluessel faellt beim ersten
    // Speichern still auf die Vorgabe zurueck - der Schalter liesse sich umlegen und taete nichts.
    await S.j('/notification-prefs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokAdmin },
      body: JSON.stringify({ neuspieler: false, attack: false })
    });
    const gespeichert = liesDb().users.gamegeeeeek.notifPrefs || {};
    check('5a: der Schluessel steht wirklich im gespeicherten Objekt',
      gespeichert.neuspieler === false,
      { neuspieler: gespeichert.neuspieler, kontrolleAttack: gespeichert.attack });
    const r = await S.j('/notification-prefs', { headers: { Authorization: 'Bearer ' + tokAdmin } });
    check('5b: und die Lese-Route gibt ihn unveraendert zurueck',
      r.status === 200 && r.body && r.body.neuspieler === false,
      { status: r.status, neuspieler: r.body && r.body.neuspieler });
    // wieder anschalten fuer den Persistenz-Abschnitt
    await S.j('/notification-prefs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokAdmin },
      body: JSON.stringify({ neuspieler: true })
    });
  }

  // ------------------------ 6) DIE WICHTIGSTE: der Eintrag ueberlebt einen Serverneustart
  {
    const VIERT = crypto.randomUUID();
    S = await aendereDb(d => {
      d.users.vierter = { userId: VIERT, username: 'vierter', passwordHash: hash, emailVerified: true, createdAt: Date.now() };
    });
    const tok = await S.anmelden('vierter');
    const rs = await S.speichern(tok, spielstand(VIERT, 'vierter'));
    check('6-vorab: der erste Save des vierten Neulings wird angenommen',
      rs.status === 200 && rs.body.version === 0, { status: rs.status, version: rs.body && rs.body.version });
    const vorher = meldungen(liesDb()).length;
    check('6-vorab2: die Meldung steht vor dem Neustart in der Datei', vorher === 3, { anzahl: vorher });

    // HART stoppen (SIGKILL, kein Graceful Shutdown): Was jetzt noch in der Datei steht, hat das
    // saveDb() des Endpunkts geschrieben - nichts sonst.
    await stoppeServerHart();
    const nachHartemStopp = meldungen(liesDb()).length;
    check('6a: sie ueberlebt einen harten Stopp (also VOR saveDb geschrieben)', nachHartemStopp === 3,
      { vorher, nachHartemStopp });
    S = await starteServer();
    const nachher = meldungen(liesDb()).length;
    check('6a2: und ist nach dem Neustart weiterhin da', nachher === 3, { nachher });
    // Die Gegenrichtung: Der SPIELSTAND selbst muss den harten Stopp genauso ueberleben - sonst
    // waere 6a auch dann gruen, wenn schlicht gar nichts gespeichert wurde.
    const d6 = liesDb();
    check('6a3: der Spielstand des Neulings hat den harten Stopp ebenfalls ueberlebt',
      !!(d6.private[VIERT] && d6.private[VIERT]['kepler7-save-v3']),
      { vorhanden: !!(d6.private[VIERT] && d6.private[VIERT]['kepler7-save-v3']) });
    const tokAdmin = await S.anmelden('gamegeeeeek');
    const r = await S.j('/notifications', { headers: { Authorization: 'Bearer ' + tokAdmin } });
    // Das Feld heisst 'notifications', nicht 'events' - abgelesen an der Route (server.js:4585),
    // nicht geraten. Der erste Entwurf hatte 'events' und meldete 0 Eintraege bei Status 200.
    const ausRoute = (r.body && r.body.notifications || []).filter(e => e.type === 'neuer-spieler');
    check('6b: und der Server liefert sie ueber /api/notifications aus', ausRoute.length === 3,
      { status: r.status, anzahl: ausRoute.length });
    check('6c: mit Sprungziel auf die Bestenliste',
      ausRoute.length > 0 && ausRoute[0].ziel === 'galaxie:rang',
      { ziel: ausRoute[0] && ausRoute[0].ziel });
  }

  // --------------------------------- 7) ohne Betreiberkonto laeuft der Save unveraendert weiter
  {
    const FUENFT = crypto.randomUUID();
    S = await aendereDb(d => {
      delete d.users.gamegeeeeek;
      d.users.fuenfter = { userId: FUENFT, username: 'fuenfter', passwordHash: hash, emailVerified: true, createdAt: Date.now() };
    });
    const tok = await S.anmelden('fuenfter');
    const rs = await S.speichern(tok, spielstand(FUENFT, 'fuenfter'));
    check('7a: ohne Betreiberkonto wird der Spielstand normal gespeichert',
      rs.status === 200 && rs.body.version === 0, { status: rs.status, version: rs.body && rs.body.version });
    const d = liesDb();
    check('7b: und er steht wirklich in der Datei',
      !!(d.private[FUENFT] && d.private[FUENFT]['kepler7-save-v3']),
      { vorhanden: !!(d.private[FUENFT] && d.private[FUENFT]['kepler7-save-v3']) });
    check('7c: dabei ist nichts abgestuerzt',
      !/Neuer-Spieler-Push fehlgeschlagen/.test(S.protokoll()),
      { protokollende: S.protokoll().slice(-200) });
  }

  // ------------------------------ 8) der Push-TEXT ist nicht der Sammel-Rueckfall (ausgefuehrt)
  {
    // Hausregel 43: ausgefuehrt, nicht gegreppt. Die Funktion wird ueber die echte Klammertiefe
    // geschnitten - ein geratenes Zeichenfenster waere keine Messung.
    let text = null, bauFehler = null;
    try {
      const src = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
      const start = src.indexOf('function pushNotificationText(');
      if (start < 0) throw new Error('pushNotificationText nicht gefunden');
      let i = src.indexOf('{', start), tiefe = 0, ende = -1;
      for (; i < src.length; i++) {
        if (src[i] === '{') tiefe++;
        else if (src[i] === '}') { tiefe--; if (tiefe === 0) { ende = i + 1; break; } }
      }
      if (ende < 0) throw new Error('Funktionsende nicht gefunden');
      const fn = new Function(src.slice(start, ende) + '; return pushNotificationText;')();
      text = fn('neuer-spieler', { username: 'neuling', gesamt: 12 });
    } catch (e) { bauFehler = e.message; }
    check('8-bau: der Block laesst sich schneiden und ausfuehren', bauFehler === null, { fehler: bauFehler });
    check('8a: der Text ist NICHT der Sammel-Rueckfall',
      !!text && text.body !== 'Es gibt Neuigkeiten.', { text });
    check('8b: er nennt den Namen und die Gesamtzahl',
      !!text && /neuling/.test(text.body) && /12/.test(text.body), { body: text && text.body });
  }

  await stoppeServer();
  console.log(fail ? 'FAIL - es gab rote Pruefungen.' : 'PASS - alles gruen.');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ABBRUCH:', e); process.exit(1); });
