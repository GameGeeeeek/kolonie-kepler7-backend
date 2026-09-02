// Vier Admin-Faehigkeiten (28.08.2026, Auftrag Sascha "mehr adminfaehigkeiten in admin bereich hinzu").
//
// GEMESSEN VOR DEM BAU, weil es die Auswahl bestimmt hat: Der Admin-Bereich hatte 13 Routen, und
// alle 13 waren im Frontend verdrahtet. Es fehlte keine Anzeigestelle - es fehlten Faehigkeiten.
//
// DIE VIER ZUSAGEN, jede mit ihrem Abschnitt:
//   1. Feedback     -> Abschnitt 2   (db.feedback hatte 500 Eintraege und NULL Leser)
//   2. Notaus       -> Abschnitt 3   (die drei Spawn-Schalter brauchten bis dahin einen Deploy)
//   3. Konto-Blatt  -> Abschnitt 4   (Sperren ging nur ueber eine vorhandene Meldung)
//   4. Systemstand  -> Abschnitt 5   (commit/blob und die fehlende Konfiguration ohne SSH)
//
// DIE WICHTIGSTE PRUEFUNG IST 3c/3c2, und zwar als PAAR: Der Notaus wird nicht am gemeldeten
// Feld `wirksam` gemessen (das waere das Etikett), sondern an der WIRKUNG - ein faelliges Nest
// reift beim Serverstart, und mit gesetztem Notaus reift dasselbe Nest nicht. Ohne die zweite
// Haelfte waere auch ein Schalter gruen, der gar nichts tut.
//
// GEGENSTUECK DAZU IST 3d: Ein vorhandenes Nest bleibt trotz Notaus ANGREIFBAR. Das ist die
// bewusste Grenze der Mechanik - sie stoppt den Nachschub und enteignet niemanden. Haenge der
// Angriffs-Endpunkt am Schalter, staenden nach dem Abschalten unangreifbare Nester auf der Karte.
//
// PORT 3234: gemessen belegt sind 3195-3200 und 3210-3233
// (`grep -hoE "3[12][0-9][0-9]" tests/*.js | sort -un`) - ein neuer Test nimmt 3235.
//
// DAS ADMIN-KONTO muss unter dem Schluessel 'gamegeeeeek' KLEINGESCHRIEBEN in db.users stehen -
// daran haengt isAdmin(); ein Eintrag unter 'GameGeeeeek' liefert false (Vorbild und Lehre:
// test_bonuscodes_http.js).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3234);

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ADMIN = crypto.randomUUID(), ANNA = crypto.randomUUID(), BEN = crypto.randomUUID();

// Ein Wert, der NUR ueber eine Env-Variable in den Prozess kommt. Abschnitt 5b sucht ihn in der
// vollstaendigen Antwort des Systemstands - damit ist "es werden nur Ja/Nein ausgegeben" gemessen
// statt behauptet.
const GEHEIM = 'GEHEIMWERT-' + crypto.randomUUID();

function spielstand(id, name) {
  return {
    resources: { energie: 1e5, erz: 1e5, kristalle: 1e5, deuterium: 1e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {}, fleet: { missions: [] },
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  };
}
function grunddb() {
  const jetzt = Date.now();
  return {
    users: {
      gamegeeeeek: { userId: ADMIN, username: 'GameGeeeeek', passwordHash: hash, createdAt: jetzt },
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: jetzt - 5 * 86400000,
              email: 'anna@example.org', emailVerified: true, homeSystem: 'kepler' },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: jetzt }
    },
    private: {
      [ADMIN]: { 'kepler7-save-v3': JSON.stringify(spielstand(ADMIN, 'GameGeeeeek')) },
      [ANNA]:  { 'kepler7-save-v3': JSON.stringify(spielstand(ANNA, 'anna')) },
      [BEN]:   {}   // ohne Spielstand: 5a zaehlt Spielstaende, nicht Konten
    },
    feedback: [
      { id: 'fb-1', time: jetzt - 3600000, userId: ANNA, username: 'anna', type: 'bug',
        text: 'Der Kartenknopf reagiert nicht.', version: '8.616.0' },
      { id: 'fb-2', time: jetzt - 7200000, userId: BEN, username: 'ben', type: 'idee',
        text: 'Mehr Sorten bei den Asteroiden waeren schoen.', version: '8.615.0' },
      { id: 'fb-3', time: jetzt - 9000000, userId: ANNA, username: 'anna', type: 'bug',
        text: 'Screenshot anbei.', version: '8.614.0', imageFile: 'fb-3.png' }
    ],
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: jetzt, factions: {},
      // Alle vier Voelker pausiert: Der galaxyTick entdeckt sonst mit 6 % je Takt ein neues Volk
      // und legt ihm sofort ein Nest an - die gemessene Eingabe waere dann mitten in der Messung
      // eine andere (Lehre aus test_npc_staerke_http.js).
      alienPause: { kryll: jetzt + 9e8, xantheer: jetzt + 9e8, vex: jetzt + 9e8, verglueht: jetzt + 9e8 },
      alienNester: [] }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-adminfunk-' + process.pid + '.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-adminfunk-'));
const bildDir = path.join(tmpDir, 'feedback-images');
let srv = null;
let s = null, tokAdmin = null, tokA = null;
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
      VAPID_PRIVATE_FILE: path.join(tmpDir, 'vapid-priv.txt'),
      FEEDBACK_IMG_DIR: bildDir,
      // 5b: dieser Wert darf in KEINER Antwort auftauchen.
      KOFI_VERIFICATION_TOKEN: GEHEIM,
      // 5c misst die Gegenrichtung an einer Variablen, die gemessen NICHT gesetzt ist.
      DEPLOY_ALARM_MAIL: ''
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
  async function roh(pfad, opt) {
    const r = await fetch(basis + pfad, opt);
    const b = Buffer.from(await r.arrayBuffer());
    return { status: r.status, typ: r.headers.get('content-type') || '', bytes: b.length };
  }
  async function anmelden(name) {
    const r = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name, password: 'test1234' }) });
    return r.body && r.body.token;
  }
  return { j, roh, anmelden, protokoll: () => log };
}
async function stoppeServer() {
  if (!srv) return;
  srv.kill('SIGTERM');
  await warte(700);
  srv = null;
}
/* HART stoppen - ohne Graceful Shutdown. Der Unterschied ist keine Feinheit, sondern der ganze
   Gegenstand von 2d: SIGTERM loest den Graceful Shutdown aus, und der FLUSHT die im Speicher
   gehaltene db auf Platte. Ein Eintrag, der nur im Arbeitsspeicher stand, weil der zugehoerige
   saveDb()-Aufruf fehlt, wuerde dabei mitgeschrieben - die Pruefung waere dann gruen, obwohl
   genau der Fehler vorliegt, den sie fangen soll. Gemessen an einer sabotierten Kopie ohne
   saveDb(): mit SIGTERM blieb 2d gruen, mit SIGKILL faellt es.
   Wer misst, ob etwas WIRKLICH auf Platte steht, beendet den Prozess so, wie er im Ernstfall
   stirbt. */
async function stoppeHart() {
  if (!srv) return;
  srv.kill('SIGKILL');
  await warte(700);
  srv = null;
}
const liesDb = () => JSON.parse(fs.readFileSync(dbPfad, 'utf8'));
const schreibDb = d => fs.writeFileSync(dbPfad, JSON.stringify(d, null, 1));
// Jede Aenderung an der DB-DATEI laeuft durch diesen Helfer: SIGTERM flusht die im Speicher
// gehaltene db darueber, eine Aenderung am laufenden Server waere also wieder weg.
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  s = await starteServer();
  tokAdmin = await s.anmelden('GameGeeeeek');
  tokA = await s.anmelden('anna');
}
const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });

// Ein faelliges Nest, das beim naechsten galaxyTick reifen MUSS. Deterministisch gewaehlt:
// xantheer breitet sich erst ab Stufe 3 aus und wandert nie, auf Stufe 1 passiert also ausser dem
// Reifen nichts - kein Zufall in der Messung.
function faelligesNest(jetzt) {
  return {
    id: 'nest-mess', volk: 'xantheer', sys: 'vega', stufe: 1,
    lp: 40000, lpMax: 40000,
    seit: jetzt - 40 * 3600000, letzteReifung: jetzt - 40 * 3600000,
    naechsterWurf: jetzt + 9e8, naechsteWanderung: 0,
    beitraege: {}, schlaege: {}
  };
}

(async () => {
  fs.mkdirSync(bildDir, { recursive: true });
  fs.writeFileSync(path.join(bildDir, 'fb-3.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  // Das ZIEL des Ausbruchsversuchs in 2e3. Es wird hier angelegt und nicht dem Server ueberlassen:
  // JWT_SECRET steht auch als Env-Variable, die Datei entstuende also womoeglich gar nicht - und
  // eine Ausbruchspruefung gegen eine Datei, die es nicht gibt, ist aus dem falschen Grund gruen.
  fs.writeFileSync(path.join(tmpDir, 'jwt.txt'), 'GEHEIMES-SITZUNGSSCHLUESSEL-ZIEL');
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  s = await starteServer();
  tokAdmin = await s.anmelden('GameGeeeeek');
  tokA = await s.anmelden('anna');
  check('0: Admin und ein Spieler angemeldet', !!tokAdmin && !!tokA, { admin: !!tokAdmin, anna: !!tokA });
  if (!tokAdmin || !tokA) { console.log(s.protokoll().slice(-900)); console.log('\nFAIL'); process.exit(1); }

  // ---- 1. Rechtepruefung -----------------------------------------------------------------------
  // DATENGETRIEBEN ueber alle sechs neuen Routen statt als Namensliste an einer Stelle: Eine
  // siebte Route faellt hier auf, sobald sie in diese Liste kommt - und wer sie vergisst, sieht es
  // an 1c (die Zahl der geprueften Routen steht im Beleg).
  const NEUE_ROUTEN = [
    ['GET',  '/admin/feedback'],
    ['POST', '/admin/feedback/erledigt'],
    ['GET',  '/admin/feedback/bild/fb-3'],
    ['GET',  '/admin/schalter'],
    ['POST', '/admin/schalter'],
    ['GET',  '/admin/konto?name=anna'],
    ['POST', '/admin/konto/sitzungen-beenden'],
    ['GET',  '/admin/systemstand']
  ];
  const fremd = [];
  for (const [m, p] of NEUE_ROUTEN) {
    const r = await s.j(p, m === 'GET' ? { headers: kopf(tokA) } : { method: 'POST', headers: kopf(tokA), body: '{}' });
    if (r.status !== 403) fremd.push(p + ' -> ' + r.status);
  }
  check('1a: kein Fremder kommt an eine der neuen Routen', fremd.length === 0, fremd);
  const ohne = [];
  for (const [m, p] of NEUE_ROUTEN) {
    const r = await s.j(p, m === 'GET' ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (r.status !== 401) ohne.push(p + ' -> ' + r.status);
  }
  check('1b: ohne Anmeldung antwortet keine mit Daten', ohne.length === 0, ohne);
  check('1c: es wurden wirklich alle acht Zugaenge geprueft', NEUE_ROUTEN.length === 8, { geprueft: NEUE_ROUTEN.length });

  // ---- 2. Feedback -----------------------------------------------------------------------------
  const fbAlle = await s.j('/admin/feedback', { headers: kopf(tokAdmin) });
  check('2a: die Einsendungen sind lesbar', fbAlle.status === 200 && fbAlle.body.feedback.length === 3,
    { status: fbAlle.status, anzahl: fbAlle.body.feedback && fbAlle.body.feedback.length });
  const eins = (fbAlle.body.feedback || [])[0] || {};
  check('2a2: ein Eintrag traegt Text, Absender, Typ und Version',
    eins.text === 'Der Kartenknopf reagiert nicht.' && eins.username === 'anna' && eins.type === 'bug' && eins.version === '8.616.0',
    { text: eins.text, username: eins.username, type: eins.type, version: eins.version });
  check('2a3: der Zaehler nennt gesamt und offen', fbAlle.body.gesamt === 3 && fbAlle.body.offen === 3,
    { gesamt: fbAlle.body.gesamt, offen: fbAlle.body.offen });

  const nurIdeen = await s.j('/admin/feedback?typ=idee', { headers: kopf(tokAdmin) });
  check('2b: der Typ-Filter greift',
    nurIdeen.body.feedback.length === 1 && nurIdeen.body.feedback[0].type === 'idee',
    { anzahl: nurIdeen.body.feedback.length, typen: nurIdeen.body.feedback.map(f => f.type) });

  const hak = await s.j('/admin/feedback/erledigt', { method: 'POST', headers: kopf(tokAdmin), body: JSON.stringify({ id: 'fb-1' }) });
  check('2c: abhaken senkt den Offen-Zaehler', hak.status === 200 && hak.body.offen === 2,
    { status: hak.status, offen: hak.body.offen });
  const nurOffen = await s.j('/admin/feedback?offen=1', { headers: kopf(tokAdmin) });
  check('2c2: der Offen-Filter blendet das Abgehakte aus',
    nurOffen.body.feedback.length === 2 && !nurOffen.body.feedback.some(f => f.id === 'fb-1'),
    { ids: nurOffen.body.feedback.map(f => f.id) });
  // Die Marke ist ein Zustand, kein Loeschen: Der abgehakte Eintrag muss im Gesamtbestand stehen
  // bleiben. Ohne diese Zeile waere 2c auch bei einer Route gruen, die den Eintrag entfernt.
  const nachHaken = await s.j('/admin/feedback', { headers: kopf(tokAdmin) });
  const fb1 = (nachHaken.body.feedback || []).find(f => f.id === 'fb-1');
  check('2c3: der abgehakte Eintrag ist NICHT geloescht, nur markiert',
    !!fb1 && fb1.erledigt === true && fb1.erledigtAm > 0,
    { vorhanden: !!fb1, erledigt: fb1 && fb1.erledigt });

  // Ueberlebt die Marke einen HARTEN Stopp? Nur dann steht sie wirklich auf Platte. Mit dem
  // sanften Stopp waere diese Pruefung wertlos (Begruendung bei stoppeHart).
  await stoppeHart();
  s = await starteServer();
  tokAdmin = await s.anmelden('GameGeeeeek');
  tokA = await s.anmelden('anna');
  const nachNeustart = await s.j('/admin/feedback', { headers: kopf(tokAdmin) });
  check('2d: die Erledigt-Marke ueberlebt einen HARTEN Stopp', nachNeustart.body.offen === 2,
    { offen: nachNeustart.body.offen });
  // Die Gegenkontrolle: Der Bestand selbst muss den harten Stopp ebenfalls ueberstanden haben -
  // sonst waere 2d auch dann gruen, wenn schlicht GAR NICHTS gespeichert wurde.
  check('2d2: und der Feedback-Bestand steht vollstaendig da',
    (nachNeustart.body.feedback || []).length === 3 && nachNeustart.body.gesamt === 3,
    { anzahl: (nachNeustart.body.feedback || []).length, gesamt: nachNeustart.body.gesamt });

  const bild = await s.roh('/admin/feedback/bild/fb-3', { headers: kopf(tokAdmin) });
  check('2e: der angehaengte Screenshot ist abrufbar',
    bild.status === 200 && bild.typ.startsWith('image/') && bild.bytes > 0,
    { status: bild.status, typ: bild.typ, bytes: bild.bytes });
  const ohneBild = await s.j('/admin/feedback/bild/fb-2', { headers: kopf(tokAdmin) });
  check('2e2: eine Einsendung ohne Bild liefert 404 statt irgendetwas', ohneBild.status === 404,
    { status: ohneBild.status });
  /* Die Route nimmt die ID und schlaegt den Dateinamen selbst nach - ein Pfad im Aufruf kann
     deshalb gar nicht erst wirken.

     DER PFAD ZEIGT BEWUSST AUF EINE DATEI, DIE ES WIRKLICH GIBT: die JWT-Geheimnisdatei liegt
     ein Verzeichnis ueber dem Bilderordner. Der erste Entwurf nahm '../../server.js' - der lag
     ausserhalb des Testverzeichnisses, es gab dort also gar nichts zu holen, und die Pruefung
     war aus dem falschen Grund gruen: Sie haette auch bei einer voellig ungeschuetzten Route
     404 gemeldet. Gemessen an der Gegenprobe (Route nimmt den Dateinamen statt der ID) faellt
     sie jetzt mit 200 und dem Inhalt des Sitzungsgeheimnisses. */
  check('2e3-vorab: die Zieldatei des Ausbruchsversuchs existiert wirklich',
    fs.existsSync(path.join(tmpDir, 'jwt.txt')), { pfad: path.join(tmpDir, 'jwt.txt') });
  const ausbruch = await s.roh('/admin/feedback/bild/' + encodeURIComponent('../jwt.txt'), { headers: kopf(tokAdmin) });
  check('2e3: ein Pfad statt einer ID holt keine fremde Datei - auch keine, die es gibt',
    ausbruch.status === 404, { status: ausbruch.status, bytes: ausbruch.bytes });

  // ---- 3. Notabschaltung der PvE-Spawns --------------------------------------------------------
  const st0 = await s.j('/admin/schalter', { headers: kopf(tokAdmin) });
  const nester0 = (st0.body.schalter || []).find(x => x.name === 'nester') || {};
  // Vier seit dem 02.09.2026: A2 (Wrackkonvois) haengt seither ebenfalls am Notaus - vorher las
  // A2Tick die blanke Konstante, und der Admin konnte die Konvois nicht anhalten.
  check('3a: die vier Schalter werden gemeldet (festung, bauteile, nester, konvois)', (st0.body.schalter || []).length === 4,
    { namen: (st0.body.schalter || []).map(x => x.name) });
  check('3a2: im Ausgangszustand ist nichts abgeschaltet',
    nester0.notAus === false && nester0.wirksam === true && nester0.imCode === true,
    { notAus: nester0.notAus, wirksam: nester0.wirksam, imCode: nester0.imCode });

  const ohneGrund = await s.j('/admin/schalter', { method: 'POST', headers: kopf(tokAdmin), body: JSON.stringify({ name: 'nester', aus: true }) });
  check('3b: abschalten ohne Begruendung wird abgelehnt', ohneGrund.status === 400,
    { status: ohneGrund.status, fehler: ohneGrund.body && ohneGrund.body.error });
  const unbekannt = await s.j('/admin/schalter', { method: 'POST', headers: kopf(tokAdmin), body: JSON.stringify({ name: 'gibtsnicht', aus: true, grund: 'x y z' }) });
  check('3b2: ein unbekannter Schaltername wird abgelehnt', unbekannt.status === 400,
    { status: unbekannt.status });

  // --- Die WIRKUNG, als Paar gemessen. Zuerst der Beleg, dass die Messvorrichtung ueberhaupt
  //     etwas misst: OHNE Notaus muss dasselbe Nest reifen.
  await aendereDb(d => {
    d.galaxy.alienNester = [faelligesNest(Date.now())];
    delete d.notAus;
  });
  await warte(600);   // der galaxyTick laeuft per setImmediate beim Start
  await stoppeServer();
  const nachOhne = liesDb().galaxy.alienNester[0] || {};
  check('3c: OHNE Notaus reift ein faelliges Nest beim Takt', nachOhne.stufe === 2,
    { stufe: nachOhne.stufe, erwartet: 2 });

  s = await starteServer();
  tokAdmin = await s.anmelden('GameGeeeeek');
  tokA = await s.anmelden('anna');
  const aus = await s.j('/admin/schalter', { method: 'POST', headers: kopf(tokAdmin),
    body: JSON.stringify({ name: 'nester', aus: true, grund: 'Messlauf des Tests' }) });
  check('3c-vorab: der Notaus laesst sich setzen', aus.status === 200 && aus.body.wirksam === false,
    { status: aus.status, wirksam: aus.body && aus.body.wirksam });

  await aendereDb(d => { d.galaxy.alienNester = [faelligesNest(Date.now())]; });
  await warte(600);
  await stoppeServer();
  const nachAus = liesDb().galaxy.alienNester[0] || {};
  check('3c2: MIT Notaus reift dasselbe Nest NICHT', nachAus.stufe === 1,
    { stufe: nachAus.stufe, erwartet: 1 });

  s = await starteServer();
  tokAdmin = await s.anmelden('GameGeeeeek');
  tokA = await s.anmelden('anna');

  // --- Die GRENZE der Mechanik, am Quelltext gemessen und nicht per HTTP.
  //
  // WARUM NICHT PER HTTP, ausgeschrieben statt verschwiegen: Der erste Entwurf rief
  // /api/alien/nest-angriff auf und war gruen - aus dem falschen Grund gleich zweifach. Erstens
  // traf er die falsche Route (die Konstante steht im MUSTERangriff, nicht im Einzelangriff),
  // zweitens antwortete sie mit 400 "nestId und missionId erforderlich", also der
  // Argumentpruefung statt der Erreichbarkeit. Und der Einzelangriff haengt an gar keinem
  // Schalter - die Zusage ist dort per Konstruktion erfuellt, eine HTTP-Messung koennte sie also
  // nie reissen. Was hier wirklich schuetzenswert ist: dass niemand spaeter `spawnAktiv` in die
  // zwei bewusst ausgenommenen Stellen einbaut. Genau das misst der Quelltext, und zwar in
  // BEIDE Richtungen (Regel 33) - eine verschwundene Umstellung ist derselbe Befund wie eine
  // zusaetzliche.
  const QUELLE = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  const schnitt = (name) => {
    const i = QUELLE.indexOf('function ' + name + '(');
    if (i < 0) return null;
    let tiefe = 0, start = QUELLE.indexOf('{', i);
    for (let k = start; k < QUELLE.length; k++) {
      if (QUELLE[k] === '{') tiefe++;
      else if (QUELLE[k] === '}') { tiefe--; if (tiefe === 0) return QUELLE.slice(i, k + 1); }
    }
    return null;
  };
  const nestTickRumpf = schnitt('nestTick');
  const festungSpawnRumpf = schnitt('festungSpawn');
  const a2TickRumpf = schnitt('A2Tick');
  check('3d-vorab: alle drei Rumpfe liessen sich schneiden', !!nestTickRumpf && !!festungSpawnRumpf && !!a2TickRumpf,
    { nestTick: !!nestTickRumpf, festungSpawn: !!festungSpawnRumpf, a2Tick: !!a2TickRumpf });
  check('3d: der Nachschub laeuft ueber den Schalter (Nester, Festungen, Bauteile, Konvois)',
    !!nestTickRumpf && nestTickRumpf.includes("spawnAktiv('nester')")
      && !!festungSpawnRumpf && festungSpawnRumpf.includes("spawnAktiv('festung')")
      && QUELLE.includes("bauteile: !spawnAktiv('bauteile')")
      && !!a2TickRumpf && a2TickRumpf.includes("spawnAktiv('konvois')"),
    { nestTick: !!nestTickRumpf && nestTickRumpf.includes("spawnAktiv('nester')"),
      festungSpawn: !!festungSpawnRumpf && festungSpawnRumpf.includes("spawnAktiv('festung')"),
      bauteile: QUELLE.includes("bauteile: !spawnAktiv('bauteile')"),
      a2Tick: !!a2TickRumpf && a2TickRumpf.includes("spawnAktiv('konvois')") });
  check('3d2: der Angriffsweg haengt WEITERHIN an der blanken Konstante',
    QUELLE.includes("if (!NEST_SPAWN_AKTIV) return res.status(404)"),
    { gefunden: QUELLE.includes("if (!NEST_SPAWN_AKTIV) return res.status(404)") });
  check('3d3: die NPC-Drift haengt WEITERHIN an der blanken Konstante',
    QUELLE.includes('if (NEST_SPAWN_AKTIV) {\n    const ziel = npcStaerkeZiel(g);'),
    { gefunden: QUELLE.includes('if (NEST_SPAWN_AKTIV) {\n    const ziel = npcStaerkeZiel(g);') });

  const st1 = await s.j('/admin/schalter', { headers: kopf(tokAdmin) });
  const nester1 = (st1.body.schalter || []).find(x => x.name === 'nester') || {};
  check('3e: der Stand nennt Grund und Zeitpunkt der Abschaltung',
    nester1.notAus === true && nester1.grund === 'Messlauf des Tests' && nester1.seit > 0,
    { notAus: nester1.notAus, grund: nester1.grund, seit: nester1.seit > 0 });
  check('3e2: imCode bleibt true - der Unterschied zu notAus ist die Auskunft',
    nester1.imCode === true && nester1.wirksam === false,
    { imCode: nester1.imCode, wirksam: nester1.wirksam });

  const wiederAn = await s.j('/admin/schalter', { method: 'POST', headers: kopf(tokAdmin), body: JSON.stringify({ name: 'nester', aus: false }) });
  check('3f: der Notaus laesst sich zuruecknehmen', wiederAn.status === 200 && wiederAn.body.wirksam === true,
    { status: wiederAn.status, wirksam: wiederAn.body && wiederAn.body.wirksam });

  // ---- 4. Konto-Blatt ---------------------------------------------------------------------------
  const suche = await s.j('/admin/konto?name=ann', { headers: kopf(tokAdmin) });
  const anna = (suche.body.konten || [])[0] || {};
  check('4a: der Teiltreffer findet das Konto', suche.status === 200 && anna.username === 'anna',
    { status: suche.status, gefunden: (suche.body.konten || []).map(k => k.username) });
  check('4a2: das Blatt nennt Registrierung, Bestaetigung und Spielstand',
    anna.registriert > 0 && anna.emailBestaetigt === true && anna.hatSpielstand === true,
    { registriert: anna.registriert > 0, emailBestaetigt: anna.emailBestaetigt, hatSpielstand: anna.hatSpielstand });
  check('4a3: die E-Mail steht NUR in ihrer Form da, nie im Klartext',
    anna.emailForm === 'a***@example.org' && JSON.stringify(suche.body).indexOf('anna@example.org') === -1,
    { form: anna.emailForm });
  check('4a4: der Passwort-Hash taucht nirgends auf', JSON.stringify(suche.body).indexOf(hash) === -1);
  const zuKurz = await s.j('/admin/konto?name=a', { headers: kopf(tokAdmin) });
  check('4a5: eine zu kurze Suche wird abgelehnt statt alles auszuliefern', zuKurz.status === 400,
    { status: zuKurz.status });

  // Sperren OHNE eine vorhandene Meldung - genau die Luecke, die diese Etappe schliesst.
  const sperre = await s.j('/admin/set-banned', { method: 'POST', headers: kopf(tokAdmin), body: JSON.stringify({ targetUsername: 'anna', banned: true }) });
  const nachSperre = await s.j('/admin/konto?name=anna', { headers: kopf(tokAdmin) });
  check('4b: ein Konto laesst sich ohne Meldung sperren, und das Blatt zeigt es',
    sperre.status === 200 && (nachSperre.body.konten || [])[0].gesperrt === true,
    { status: sperre.status, gesperrt: (nachSperre.body.konten || [])[0].gesperrt });
  const annaGesperrt = await s.j('/me', { headers: kopf(tokA) });
  check('4b2: die Sperre wirkt sofort auf das laufende Token', annaGesperrt.status === 403,
    { status: annaGesperrt.status });
  await s.j('/admin/set-banned', { method: 'POST', headers: kopf(tokAdmin), body: JSON.stringify({ targetUsername: 'anna', banned: false }) });

  // Sitzungen beenden: die WIRKUNG ist, dass das alte Token danach nicht mehr traegt.
  tokA = await s.anmelden('anna');
  const vorher = await s.j('/me', { headers: kopf(tokA) });
  const beenden = await s.j('/admin/konto/sitzungen-beenden', { method: 'POST', headers: kopf(tokAdmin), body: JSON.stringify({ targetUsername: 'anna' }) });
  const nachher = await s.j('/me', { headers: kopf(tokA) });
  check('4c: "alle Sitzungen beenden" entwertet das laufende Token wirklich',
    vorher.status === 200 && beenden.status === 200 && nachher.status === 401,
    { vorher: vorher.status, beenden: beenden.status, nachher: nachher.status });
  check('4c2: es traf NUR das gemeinte Konto - der Admin bleibt angemeldet',
    (await s.j('/me', { headers: kopf(tokAdmin) })).status === 200);
  const unbekanntesKonto = await s.j('/admin/konto/sitzungen-beenden', { method: 'POST', headers: kopf(tokAdmin), body: JSON.stringify({ targetUsername: 'gibtsnicht' }) });
  check('4c3: ein unbekannter Name liefert 404 statt still nichts zu tun', unbekanntesKonto.status === 404,
    { status: unbekanntesKonto.status });

  // ---- 5. Systemstand ---------------------------------------------------------------------------
  const sys = await s.j('/admin/systemstand', { headers: kopf(tokAdmin) });
  check('5a: der Stand nennt Commit, Blob und den Selbst-Neustart',
    sys.status === 200 && typeof sys.body.deploy.commit === 'string' && typeof sys.body.deploy.blob === 'string'
      && typeof sys.body.deploy.selbstNeustart === 'boolean',
    { status: sys.status, deploy: sys.body.deploy });
  check('5a2: der Bestand zaehlt Spielstaende, nicht Konten',
    sys.body.bestand.konten === 3 && sys.body.bestand.spielstaende === 2,
    { konten: sys.body.bestand.konten, spielstaende: sys.body.bestand.spielstaende });
  // 5b ist die Zusage der ganzen Kachel: Ja/Nein statt Werten. Gemessen an einem Geheimnis, das
  // ausschliesslich ueber die Umgebung in den Prozess kommt.
  check('5b: kein einziger Konfigurationswert steht in der Antwort',
    JSON.stringify(sys.body).indexOf(GEHEIM) === -1);
  const kofi = (sys.body.konfiguration || []).find(k => k.name === 'KOFI_VERIFICATION_TOKEN') || {};
  check('5b2: eine gesetzte Variable wird trotzdem als gesetzt gemeldet', kofi.gesetzt === true,
    { gesetzt: kofi.gesetzt });
  const alarm = (sys.body.konfiguration || []).find(k => k.name === 'DEPLOY_ALARM_MAIL') || {};
  check('5c: eine FEHLENDE Variable wird als fehlend benannt', alarm.gesetzt === false && !!alarm.zweck,
    { gesetzt: alarm.gesetzt, zweck: alarm.zweck });
  check('5d: die Laufzeit meldet die geladene Passwortliste als ZAHL',
    typeof sys.body.laufzeit.passwortlisteEintraege === 'number' && sys.body.laufzeit.passwortlisteEintraege > 100,
    { eintraege: sys.body.laufzeit.passwortlisteEintraege });
  check('5d2: offenes Feedback und offene Meldungen stehen im Bestand',
    sys.body.bestand.offenesFeedback === 2 && sys.body.bestand.offeneMeldungen === 0,
    { feedback: sys.body.bestand.offenesFeedback, meldungen: sys.body.bestand.offeneMeldungen });

  await stoppeServer();
  console.log('\n' + (fail ? 'FAIL - es gab rote Pruefungen.' : 'Alles gruen.'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); try { if (srv) srv.kill(); } catch (x) {} process.exit(1); });
