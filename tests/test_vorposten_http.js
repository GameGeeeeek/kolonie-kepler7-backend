// B2 Vorposten (02.09.2026): spielergebaute PvP-Ziele in db.shared, hinter VORPOSTEN_AKTIV.
//
// GEPRUEFT WERDEN, gegen einen ECHT gestarteten Server (Port 3242, Kopie von server.js mit
// umgelegtem Schalter - sonst antwortet jeder Endpunkt mit 404 und der Test haette keinen Gegenstand):
//   1. RECHTE: Die generische Storage-Route schreibt `vorposten:*` NIE (auch nicht der Besitzer),
//      Lesen bleibt offen; GET /api/vorposten liefert Tabelle und Liste.
//   2. BAUEN: nur mit angekommener Baukolonne im gespeicherten Spielstand, ein Vorposten je System,
//      nicht im Heimatsystem (aus dem Bestenlisten-Eintrag), hoechstens VORPOSTEN_MAX_JE_KONTO.
//   3. STATIONIEREN: nur der Besitzer; der Server nimmt hoechstens an, was der Spielstand am Standort
//      hat, nur Kampfschiffe, bis garnisonMax; Fremde sehen die Zahl, nicht die Zusammensetzung.
//   4. ANGRIFF: Bauschutz, dann Schaden = ANGEKOMMEN (kernVorher - kernNachher), Garnison verliert
//      serverseitig, Abklingzeit AM OBJEKT, eigener Vorposten nicht angreifbar.
//   5. FALL: Dokument weg, Belohnung anteilig an ALLE Beitragenden mit type:'vorposten', der
//      Besitzer bekommt type:'vorposten-verlust' mit der verlorenen Restgarnison.
//   6. AUFGEBEN: nur der Besitzer, Garnison kommt zurueck, keine Rueckerstattung.
//   7. AUSBAU: Abklingzeit am Objekt, Stufe steigt, LP wachsen um die Differenz (kein Heilen), Endausbau.
//   8. SCHALTER: VORPOSTEN_AKTIV steht auf TRUE (seit dem 02.09.2026, Frontend live; vorher der
//      Frontend-PR legt ihn um), der Notaus `vorposten` ist verdrahtet, beide Rechte-Ketten kennen
//      checkVorpostenKeyPermission.
//
// GEGENPROBEN (KEPLER_VP_SABOTAGE, je mit "was fallen MUSS"-Liste, Regel 1/71 - der Lauf exit-0t,
// wenn GENAU die gelisteten Pruefungen fallen, und meldet WERKZEUGFEHLER, wenn eine gruen bleibt):
//   schaden  -> 4c  (der volle Wurf statt des angekommenen Schadens; gemessen: genau 4c)
//   meldung  -> 4h, 4h2 (die Benachrichtigung an den Besitzer entfaellt; gemessen: beide)
//   abkling  -> 4d  (keine Abklingzeit am Objekt; gemessen: genau 4d)
//   rechte   -> 1a, 1b, 2b (die Storage-Route schreibt vorposten:* wieder; 1b/2b sind die FOLGE -
//                    das per Storage angelegte Dokument fuellt die Liste und macht den Bau zum 409)
//   typ      -> 5b, 5c (die Belohnung traegt einen fremden Typ; 5c ist die Folge - der Anteil fehlt)
//   Alle vier mit identischer Pruefliste (40 Pruefungen + 0-sab), per diff verglichen - eine
//   Pflichtliste ist selbst eine Behauptung, bis die Gegenprobe sie gemessen hat.
//
// Die Kopie liegt im Repo-Verzeichnis (damit require('./mailer') aufloest) und wird am Ende weggeraeumt.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = 3242;
const QUELLE = path.join(WURZEL, 'server_vptest_tmp.js');
const SAB = process.env.KEPLER_VP_SABOTAGE || '';
// Was bei welcher Sabotage fallen MUSS - gemessen, nicht geschaetzt (Regel 71). Die Listen der zwei
// Zweig-Sabotagen stammen aus dem Lauf vom 02.09.2026: 'zweigwahl' 7e 7f 7g 7h, 'zweigwerte' nur 7g
// (die Wahl greift dort weiter, nur die Multiplikatoren wirken nicht - genau der stille Fall).
/* Die Listen fuehren die FOLGEN mit, nicht nur den Kern der Sabotage. Bis zum 03.09.2026 stand die
   Folge bei `rechte` und `typ` nur im Kommentar ("und als FOLGE 1b/2b") - die Auswertung pruefte
   damals nur, ob das Erwartete faellt, also fiel es nicht auf. Seit sie beide Richtungen misst,
   gehoert jede gemessene Folge in die Liste. */
const MUSS_FALLEN = { schaden: ['4c'], abkling: ['4d'], rechte: ['1a', '1b', '2b'], typ: ['5b', '5c'], meldung: ['4h', '4h2'],
  kerndach: ['10a'], kerndachab: ['10c'], abbaufrist: ['6b', '6c', '6d', '6e', '6f'], abbaumodule: ['6g'], projektwirkung: ['11f', '11h'], projektzeit: ['11d'],
  zweigwahl: ['7e', '7f', '7g', '7h'], zweigwerte: ['7g'],
  // Etappe 3 (Stationsmodule): Die Listen sind gemessen, siehe Abschnitt 9.
  // GEMESSEN, nicht geschaetzt: Bei 'modulbestand' faellt 9d NICHT - der Einbau gelingt ja weiter,
  // er bucht nur nichts ab. Rot werden die drei Pruefungen, die den Bestand SELBST lesen.
  modulbestand: ['9e', '9e2', '9h'], modulwirkung: ['9f', '10a'] };

let fail = false;
const ergebnis = {};
const check = (n, c, x) => {
  ergebnis[n] = !!c;
  console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : ''));
  fail = fail || !c;
};
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ANNA = crypto.randomUUID(), BEN = crypto.randomUUID(), CARL = crypto.randomUUID();

function spielstand(id, name) {
  return {
    resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {},
    fleet: { missions: [], cruisers: 300, destroyers: 200, jaeger: 400, schlachtschiff: 80, frachter: 40, colonyShips: 2 },
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  };
}
const FLOTTE = { cruisers: 300, destroyers: 200, jaeger: 400, schlachtschiff: 80 };

function grunddb() {
  return {
    users: {
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: Date.now() },
      carl: { userId: CARL, username: 'carl', passwordHash: hash, createdAt: Date.now() }
    },
    private: {
      [ANNA]: { 'kepler7-save-v3': JSON.stringify(spielstand(ANNA, 'anna')) },
      [BEN]:  { 'kepler7-save-v3': JSON.stringify(spielstand(BEN, 'ben')) },
      [CARL]: { 'kepler7-save-v3': JSON.stringify(spielstand(CARL, 'carl')) }
    },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {},
      unlockedAlienRaces: [], alienNester: [], alienPause: {}, wrackKonvois: [], a2Verlauf: [] }
  };
}

const SAVE_KEY = 'kepler7-save-v3';
const dbPfad = path.join(os.tmpdir(), 'kepler-vp-' + process.pid + '.json');
let srv = null, s = null, tokA = null, tokB = null, tokC = null;
function ende() {
  try { if (srv) srv.kill(); } catch (e) {}
  try { fs.unlinkSync(dbPfad); } catch (e) {}
  try { fs.unlinkSync(QUELLE); } catch (e) {}   // die Kopie NIE liegen lassen
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

/* Reihenfolge-Wache (test_festung_http.js): Eine Aenderung an der DB-DATEI bei laufendem Server ist
   beim naechsten SIGTERM wieder weg - der Graceful Shutdown flusht die im Speicher gehaltene db
   darueber. Deshalb: stoppen -> lesen -> aendern -> schreiben -> starten, in EINEM Helfer. */
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  s = await starteServer();
  tokA = await s.anmelden('anna');
  tokB = await s.anmelden('ben');
  tokC = await s.anmelden('carl');
}
/* Der Spielstand liegt in db.private in ZWEI Formen vor (blanke Zeichenkette oder { value, version }). */
function liesSave(d, uid) {
  const roh = d.private[uid][SAVE_KEY];
  if (roh === undefined) return null;
  return JSON.parse(typeof roh === 'string' ? roh : roh.value);
}
function schreibSave(d, uid, sv) {
  const roh = d.private[uid][SAVE_KEY];
  const txt = JSON.stringify(sv);
  d.private[uid][SAVE_KEY] = (roh && typeof roh === 'object') ? { value: txt, version: (roh.version || 0) + 1 } : txt;
}
const liesDoc = (d, sys) => { const raw = d.shared['vorposten:' + sys]; return typeof raw === 'string' ? JSON.parse(raw) : null; };
const schreibDoc = (d, doc) => { d.shared['vorposten:' + doc.sys] = JSON.stringify(doc); };
const doc = (sys, besitzer, name, extra) => Object.assign({
  id: 'vp_' + crypto.randomUUID(), sys, besitzer, besitzerName: name,
  seit: Date.now() - 13 * 3600 * 1000, stufe: 1, kern: { lp: 20000, lpMax: 20000 },
  garnison: {}, schlaege: {}, beitraege: {}, ausbauSeit: Date.now() - 13 * 3600 * 1000, kampfverlauf: []
}, extra || {});
const bauMission = (id, sys) => ({ id, type: 'vorposten-bau', targetId: sys, system: sys,
  startTime: Date.now() - 7200000, endTime: Date.now() - 3600000, fleetName: 'Baukolonne', composition: { colonyShips: 1 } });
const angriffMission = (id, sys) => ({ id, type: 'vorposten-angriff', targetId: sys, system: sys,
  startTime: Date.now() - 7200000, endTime: Date.now() - 3600000, fleetName: 'Flotte 1', composition: Object.assign({}, FLOTTE) });

(async () => {
  const roh = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  let geflippt = roh.replace(/const VORPOSTEN_AKTIV = (true|false);/, 'const VORPOSTEN_AKTIV = true;');
  check('0-kopie: der Schalter liess sich in der Kopie umlegen',
    /const VORPOSTEN_AKTIV = true;/.test(geflippt), { gefunden: /const VORPOSTEN_AKTIV = (true|false);/.test(roh) });
  /* Derselbe Weg fuer den Projekt-Schalter (Etappe 4): Ausgeliefert steht er auf false, bis das
     Frontend die Projekte kennt - geprueft wird die LOGIK trotzdem, an einer Kopie mit
     umgelegtem Schalter. Ohne das waere Etappe 4 bis zum Frontend-Merge voellig ungeprueft. */
  geflippt = geflippt.replace(/const VP_PROJEKTE_AKTIV = (true|false);/, 'const VP_PROJEKTE_AKTIV = true;');
  check('0-kopie2: auch der Projekt-Schalter liess sich in der Kopie umlegen',
    /const VP_PROJEKTE_AKTIV = true;/.test(geflippt), { gefunden: /const VP_PROJEKTE_AKTIV = (true|false);/.test(roh) });
  /* Derselbe Weg fuer den Abbau-Schalter (03.09.2026) - und dazu ein KURZER galaxyTick: Der Abbau
     wird dort abgeschlossen, und 15 Minuten wartet kein Test ab. Die Kopie taktet stattdessen im
     Sekundenbereich; gemessen wird damit der ECHTE Weg (der Tick raeumt auf), nicht eine
     Abkuerzung ueber einen Endpunkt, den es im Betrieb gar nicht gibt. */
  geflippt = geflippt.replace(/const VORPOSTEN_ABBAU_AKTIV = (true|false);/, 'const VORPOSTEN_ABBAU_AKTIV = true;');
  geflippt = geflippt.replace(/const GALAXY_TICK_MS = [^;]+;/, 'const GALAXY_TICK_MS = 1500;');
  check('0-kopie3: Abbau-Schalter umgelegt und der galaxyTick auf Sekunden verkuerzt',
    /const VORPOSTEN_ABBAU_AKTIV = true;/.test(geflippt) && /const GALAXY_TICK_MS = 1500;/.test(geflippt),
    { schalter: /const VORPOSTEN_ABBAU_AKTIV = (true|false);/.test(roh), takt: /const GALAXY_TICK_MS = /.test(roh) });
  // Unabhaengige Anker fuer die Erwartungen (nicht aus der API-Antwort selbst, Regel 62): die
  // Stufentabelle aus dem QUELLTEXT.
  const kernLps = [...roh.matchAll(/kernLp:\s*(\d+)/g)].map(m => Number(m[1]));
  const KERN1 = kernLps[0], KERN2 = kernLps[1];
  const GARN_MAX1 = Number((roh.match(/garnisonMax:\s*(\d+)/) || [])[1]);
  const MAX_JE_KONTO = Number((roh.match(/const VORPOSTEN_MAX_JE_KONTO = (\d+);/) || [])[1]);
  check('0-anker: Stufentabelle und Deckel aus dem Quelltext gelesen',
    KERN1 > 0 && KERN2 > KERN1 && GARN_MAX1 > 0 && MAX_JE_KONTO > 0, { KERN1, KERN2, GARN_MAX1, MAX_JE_KONTO });

  if (SAB) {
    const vorher = geflippt;
    if (SAB === 'schaden') geflippt = geflippt.replace('const schaden = lpVorher - doc.kern.lp;', 'const schaden = wurf;');
    else if (SAB === 'abkling') geflippt = geflippt.replace('    doc.schlaege[t.userId] = jetzt;', '    /* sabotiert: keine Abklingzeit am Objekt */;');
    else if (SAB === 'rechte') geflippt = geflippt.replace("  return 'Vorposten werden ausschließlich über die Vorposten-Endpunkte verändert.';", '  return null;');
    else if (SAB === 'typ') geflippt = geflippt.replace("        type: 'vorposten',           // eigener Typ", "        type: 'alien-nest',          // eigener Typ");
    else if (SAB === 'meldung') geflippt = geflippt.replace("        pushNotificationEvent(doc.besitzer, 'vorposten-angegriffen', {", "        if (false) pushNotificationEvent(doc.besitzer, 'vorposten-angegriffen', {");
    // Die zwei Haelften der Spezialisierung (02.09.2026) einzeln sabotierbar: die WAHL beim Ausbau
    // und die WIRKUNG der Multiplikatoren. Beide zusammen waeren eine Sabotage, die zu viel trifft.
    else if (SAB === 'zweigwahl') geflippt = geflippt.replace('  const brauchtZweig = zielStufe === VORPOSTEN_ZWEIG_AB && !vorpostenZweigOk(doc.zweig);', '  const brauchtZweig = false;');

    else if (SAB === 'zweigwerte') geflippt = geflippt.replace('  if (!z || basis.stufe < VORPOSTEN_ZWEIG_AB) return basis;', '  return basis;');
    // Stationsmodule (02.09.2026), zwei Haelften: der BESTAND (nimmt der Einbau wirklich eines weg?)
    // und die WIRKUNG (aendert ein eingebautes Modul die Werte?). Letztere reisst seit dem
    // 03.09.2026 auch 10a mit: Ohne Modulwirkung hebt die Kernpanzerung auch das Kern-Dach nicht.
    else if (SAB === 'modulbestand') geflippt = geflippt.replace('  if (!user || !vpModulNehmen(user, instKey)) return res.status(400)', '  if (!user) return res.status(400)');
    else if (SAB === 'modulwirkung') geflippt = geflippt.replace('  const b = vpModulBoni(doc);', '  const b = { kern:0, verteidigung:0, garnison:0, flug:0, prod:0, scan:0 };');
    /* Das Kern-Dach (03.09.2026): zurueck auf den gespeicherten Wert statt der Rechnung - genau
       der Stand, an dem eine eingebaute Kernpanzerung bis zum naechsten Ausbau wirkungslos blieb. */
    else if (SAB === 'kerndach') geflippt = geflippt.replace('function vorpostenKernMax(doc) { return vorpostenWerte(doc).kernLp; }', 'function vorpostenKernMax(doc) { return Math.round((doc && doc.kern && doc.kern.lpMax) || vorpostenWerte(doc).kernLp); }');
    /* Die Gegenrichtung: das Dach steigt beim Einbau, sinkt beim Ausbau aber nie wieder (Ratsche).
       Das waere der lohnende Fehler - Panzerung einbauen, Dach behalten, Modul anderswo verwenden. */
    else if (SAB === 'kerndachab') geflippt = geflippt.replace('function vorpostenKernMax(doc) { return vorpostenWerte(doc).kernLp; }', 'function vorpostenKernMax(doc) { return Math.max(vorpostenWerte(doc).kernLp, Math.round((doc && doc.kern && doc.kern.lpMax) || 0)); }');
    /* Stationsprojekte (03.09.2026), zwei Haelften: die WIRKUNG (aendert ein fertiges Vorhaben die
       Werte?) und die BAUZEIT (wirkt ein noch laufendes schon?). Beide zusammen waeren eine
       Sabotage, die zu viel trifft. */
    else if (SAB === 'projektwirkung') geflippt = geflippt.replace('  const pr = vpProjektBoni(doc);', '  const pr = { kern:0, verteidigung:0, garnison:0, flug:0, prod:0, scan:0, flugDeckel: VP_FLUG_DECKEL };');
    else if (SAB === 'projektzeit') geflippt = geflippt.replace('  return vpProjektListe(doc).filter(p => p && vpProjektDef(p.key) && (p.fertigAb || 0) <= t).map(p => p.key);', '  return vpProjektListe(doc).filter(p => p && vpProjektDef(p.key)).map(p => p.key);');
    /* Der Abbau (03.09.2026), zwei Haelften: die FRIST (verschwindet der Vorposten wieder sofort?)
       und die RUECKGABE der Module beim Aufraeumen. */
    else if (SAB === 'abbaufrist') geflippt = geflippt.replace('  doc.abbauAb = jetzt + VORPOSTEN_ABBAU_MS;', '  doc.abbauAb = jetzt - 1;');
    else if (SAB === 'abbaumodule') geflippt = geflippt.replace('    if (user) for (const instKey of module) if (vpModulTeile(instKey)) vpModulGeben(user, instKey, 1);', '    /* sabotiert: Module bleiben weg */;');
    else { console.log('unbekannte Sabotage: ' + SAB); process.exit(2); }
    check('0-sab: die Sabotage "' + SAB + '" hat den Quelltext veraendert', geflippt !== vorher, { veraendert: geflippt !== vorher });
  }
  fs.writeFileSync(QUELLE, geflippt);

  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  s = await starteServer();
  tokA = await s.anmelden('anna'); tokB = await s.anmelden('ben'); tokC = await s.anmelden('carl');
  check('0: drei Konten angemeldet', !!tokA && !!tokB && !!tokC);
  if (!tokA || !tokB || !tokC) { console.log(s.protokoll().slice(-1500)); process.exit(1); }
  const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
  const post = (tok, pfad, body) => s.j(pfad, { method: 'POST', headers: kopf(tok), body: JSON.stringify(body) });

  // ---- 1) Rechte -------------------------------------------------------------------------------
  const SYS1 = 'vpsys-a';
  const put = await s.j('/storage/vorposten:' + SYS1 + '?shared=true', { method: 'PUT', headers: kopf(tokA),
    body: JSON.stringify({ value: JSON.stringify(doc(SYS1, ANNA, 'anna')) }) });
  check('1a: die Storage-Route schreibt vorposten:* NICHT (auch nicht fuer den kuenftigen Besitzer)',
    put.status === 403 && /Vorposten-Endpunkte/.test(String(put.body && put.body.error)), { status: put.status, body: put.body });
  const get0 = await s.j('/vorposten', { headers: kopf(tokA) });
  check('1b: GET /api/vorposten antwortet mit aktiv:true und leerer Liste',
    get0.status === 200 && get0.body.aktiv === true && Array.isArray(get0.body.liste) && get0.body.liste.length === 0, get0.body && { aktiv: get0.body.aktiv, n: (get0.body.liste || []).length });
  /* Die Leiter als REGEL, nicht als Momentaufnahme (die Zahl der Stufen waechst, 02.09.2026: 3 -> 8):
     jede Stufe traegt die Pflichtfelder, jede ausser der ersten hat Ausbaukosten, und die Werte
     STEIGEN streng. Ein Ausbau, der nichts verbessert, faellt damit auf. */
  check('1c: die Stufentabelle reist mit - jede Stufe mit kernLp/flug/prod/scan/garnisonMax, Kosten ab Stufe 2',
    Array.isArray(get0.body.stufen) && get0.body.stufen.length >= 3
    && get0.body.stufen.every(st => st.kernLp > 0 && st.flug > 0 && st.prod > 0 && st.scan > 0 && st.garnisonMax > 0)
    && get0.body.stufen.every((st, i) => i === 0 ? st.kosten === null : (st.kosten && Object.keys(st.kosten).length > 0)),
    get0.body.stufen && get0.body.stufen.map(st => st.name));
  check('1c2: die Leiter steigt streng (Kern, Verteidigung, Garnison) - kein Ausbau ohne Gewinn',
    get0.body.stufen.every((st, i) => i === 0 || (st.kernLp > get0.body.stufen[i-1].kernLp && st.verteidigung > get0.body.stufen[i-1].verteidigung && st.garnisonMax > get0.body.stufen[i-1].garnisonMax)),
    get0.body.stufen && get0.body.stufen.map(st => st.kernLp));
  /* 1c4/1c5 (GR-7, 04.09.2026): Die Namen selbst waren NIE geprueft - deshalb fiel jahrelang
     nicht auf, dass die Stufen 4 bis 8 "Ausbaustufe 4" bis "Ausbaustufe 8" hiessen, also
     Platzhalter. Geprueft wird die REGEL, nicht die Wortliste: Jede Stufe traegt einen eigenen,
     nicht leeren Namen, und keiner davon ist ein durchnummerierter Platzhalter. Eine spaetere
     Umbenennung bleibt damit frei, ein Rueckfall in "Ausbaustufe N" faellt auf. */
  /* 1c6 (GR-7): DER RUECKFALL, den es wirklich gab. Fuenf Stellen riefen vorpostenStufe(x.stufe)
     ohne den Zweig - Anflug-Meldung, Angriffs-Push, Ergebnis-Liste, Nicht-Teilnehmer-Fall und die
     Verlustmeldung. Sie bekamen dadurch den Basisnamen: Ein Vorposten mit Festungszweig auf
     Stufe 6 hiess in Kampfberichten "Ausbaustufe 6" statt "Sperrfeuerring", die Zweignamen waren
     dort nie zu sehen. Geprueft am Quelltext, weil eine HTTP-Kette dafuer erst einen Vorposten
     ausbauen, einen Zweig waehlen und ihn dann angreifen muesste - und weil die REGEL genau hier
     lebt: Wer ein Dokument zur Hand hat, nimmt vorpostenStufeVon(). Erlaubt bleiben nur der
     Aufruf mit ausdruecklichem Zweig und der fuer die Grundstufe eines noch nicht gebauten
     Vorpostens. */
  const serverQuelle = fs.readFileSync(path.join(WURZEL, 'server.js'), 'utf8');
  const zweigVerschluckt = (serverQuelle.match(/vorpostenStufe\(([^)]*)\)/g) || [])
    .filter(r => !/vorpostenStufeVon/.test(r))
    .filter(r => !/,/.test(r))                       // mit zweitem Argument ist es in Ordnung
    .filter(r => !/vorpostenStufe\(1\)/.test(r))     // Grundstufe eines neuen Vorpostens
    .filter(r => /\./.test(r));                      // nur Aufrufe MIT einem Dokumentfeld
  check('1c6: kein Aufruf liest die Stufe eines Dokuments ohne seinen Zweig',
    zweigVerschluckt.length === 0, { gefunden: zweigVerschluckt });
  const namen = (get0.body.stufen || []).map(st => st.name);
  check('1c4: jede Stufe traegt einen eigenen Namen - keiner doppelt, keiner leer',
    namen.length >= 3 && namen.every(n => typeof n === 'string' && n.trim().length > 2)
    && new Set(namen).size === namen.length, namen);
  check('1c5: und keiner davon ist ein durchnummerierter Platzhalter',
    namen.every(n => !/^(Ausbaustufe|Stufe)\s*\d+$/i.test(n)), namen);
  check('1c3: die drei Zweige reisen mit, jeder mit Namen ab der Wahlstufe und Multiplikatoren',
    Array.isArray(get0.body.zweige) && get0.body.zweige.length === 3 && get0.body.zweigAb >= 2
    && get0.body.zweige.every(z => z.key && z.name && z.kurz && z.mult && z.namen && Object.keys(z.namen).length === (get0.body.maxStufe - get0.body.zweigAb + 1)),
    get0.body.zweige && get0.body.zweige.map(z => z.key));
  /* 1d hielt bis zum 04.09.2026 fest, dass LESEN offen bleibt - mit der Begruendung, im Dokument
     stehe nichts Schuetzenswertes. Das stimmte nicht mehr: Es enthaelt `anflug` (den
     vorpostenFuerClient ausdruecklich NUR dem Besitzer schickt, weil er den Plan eines Dritten
     verraet), seit Etappe V5 `garnisonVon`, dazu `beitraege` und `schlaege`. Ein GET auf den
     geteilten Speicher hebelte damit jede dieser Entscheidungen aus. Aufgefallen bei einem
     Audit der Vorposten-Etappen; die Sperre ist die Korrektur, dieser Test ihre Wache. */
  const lese = await s.j('/storage/vorposten:' + SYS1 + '?shared=true', { headers: kopf(tokB) });
  check('1d: das Rohdokument ist auch fuer Fremde NICHT lesbar - die gefilterte Sicht kommt nur ueber /api/vorposten',
    lese.status === 403, { status: lese.status, fehler: lese.body && lese.body.error });
  const leseEigen = await s.j('/storage/vorposten:' + SYS1 + '?shared=true', { headers: kopf(tokA) });
  check('1d2: auch der Besitzer liest es nicht roh - eine Ausnahme waere eine zweite Sicht auf dieselben Daten',
    leseEigen.status === 403, { status: leseEigen.status });

  // ---- 2) Bauen --------------------------------------------------------------------------------
  const ohne = await post(tokA, '/vorposten/bauen', { system: SYS1, missionId: 'gibtsnicht' });
  check('2a: ohne angekommene Baukolonne im Spielstand kein Bau', ohne.status === 403, { status: ohne.status, body: ohne.body });
  await aendereDb(d => {
    const sv = liesSave(d, ANNA); sv.fleet.missions = [bauMission('b1', SYS1)]; schreibSave(d, ANNA, sv);
    const sb = liesSave(d, BEN); sb.fleet.missions = [bauMission('b2', SYS1)]; schreibSave(d, BEN, sb);
  });
  const bau = await post(tokA, '/vorposten/bauen', { system: SYS1, missionId: 'b1' });
  check('2b: mit Baukolonne entsteht ein Ankerkern mit dem Kern der ersten Stufe',
    bau.status === 200 && bau.body.ok === true && bau.body.vorposten && bau.body.vorposten.stufe === 1 && bau.body.vorposten.kern.lpMax === KERN1,
    bau.body && (bau.body.vorposten ? { stufe: bau.body.vorposten.stufe, lpMax: bau.body.vorposten.kern.lpMax } : bau.body));
  const belegt = await post(tokB, '/vorposten/bauen', { system: SYS1, missionId: 'b2' });
  check('2c: ein Vorposten je System - der zweite Bau dort wird mit 409 abgewiesen', belegt.status === 409 && belegt.body.belegt === true, { status: belegt.status });
  let d2 = null;
  await aendereDb(d => {
    d2 = liesDoc(d, SYS1);
    // Heimatsystem aus dem Bestenlisten-Eintrag; dazu zwei weitere Vorposten fuer den Deckel.
    d.shared['leaderboard:' + ANNA] = JSON.stringify({ name: 'anna', homeSystem: 'heim-a', score: 1 });
    schreibDoc(d, doc('vpsys-b', ANNA, 'anna')); schreibDoc(d, doc('vpsys-c', ANNA, 'anna'));
    const sv = liesSave(d, ANNA); sv.fleet.missions = [bauMission('b3', 'heim-a'), bauMission('b4', 'vpsys-d')]; schreibSave(d, ANNA, sv);
  });
  check('2d: das Dokument liegt in db.shared unter vorposten:<sys> mit dem Besitzer', !!d2 && d2.besitzer === ANNA && d2.stufe === 1, d2 && { besitzer: d2.besitzer === ANNA, stufe: d2.stufe });
  const heim = await post(tokA, '/vorposten/bauen', { system: 'heim-a', missionId: 'b3' });
  check('2e: im eigenen Heimatsystem (Bestenlisten-Eintrag) kein Bau', heim.status === 400 && heim.body.heimat === true, { status: heim.status, body: heim.body });
  const deckel = await post(tokA, '/vorposten/bauen', { system: 'vpsys-d', missionId: 'b4' });
  check('2f: hoechstens VORPOSTEN_MAX_JE_KONTO Vorposten je Konto', deckel.status === 400 && deckel.body.deckel === true && deckel.body.max === MAX_JE_KONTO, { status: deckel.status, body: deckel.body });

  // ---- 3) Stationieren -------------------------------------------------------------------------
  const st1 = await post(tokA, '/vorposten/stationieren', { system: SYS1, planetKey: 'home', composition: { cruisers: 50, frachter: 10 } });
  check('3a: der Besitzer stationiert Kampfschiffe; Frachter werden NICHT angenommen (kein sicherer Hafen)',
    st1.status === 200 && st1.body.angenommen && st1.body.angenommen.cruisers === 50 && st1.body.angenommen.frachter === undefined, st1.body && st1.body.angenommen);
  const st2 = await post(tokA, '/vorposten/stationieren', { system: SYS1, planetKey: 'home', composition: { cruisers: 10000 } });
  check('3b: angenommen wird hoechstens Bestand UND freier Platz bis garnisonMax',
    st2.status === 200 && st2.body.angenommen && st2.body.angenommen.cruisers === Math.min(300, GARN_MAX1 - 50), { angenommen: st2.body && st2.body.angenommen, erwartet: Math.min(300, GARN_MAX1 - 50) });
  const fremd = await post(tokB, '/vorposten/stationieren', { system: SYS1, planetKey: 'home', composition: { cruisers: 5 } });
  check('3c: ein Fremder kann dort nicht stationieren', fremd.status === 403, { status: fremd.status });
  const gA = await s.j('/vorposten', { headers: kopf(tokA) });
  const gB = await s.j('/vorposten', { headers: kopf(tokB) });
  const eigenA = (gA.body.liste || []).find(x => x.sys === SYS1) || {};
  const fremdB = (gB.body.liste || []).find(x => x.sys === SYS1) || {};
  check('3d: der Besitzer sieht die Zusammensetzung, der Fremde nur die Zahl',
    eigenA.eigener === true && eigenA.garnison && eigenA.garnison.cruisers === GARN_MAX1 && fremdB.eigener === false && fremdB.garnison === undefined && fremdB.garnisonAnzahl === GARN_MAX1,
    { eigen: eigenA.garnison, fremdZahl: fremdB.garnisonAnzahl, fremdListe: fremdB.garnison });
  check('3e: die Garnison hebt die Verteidigung ueber die der blossen Struktur',
    eigenA.verteidigung > get0.body.stufen[0].verteidigung, { verteidigung: eigenA.verteidigung, struktur: get0.body.stufen[0].verteidigung });

  // ---- 4) Angriff ------------------------------------------------------------------------------
  await aendereDb(d => {
    const sb = liesSave(d, BEN); sb.fleet.missions = [angriffMission('m1', SYS1), angriffMission('m2', SYS1)]; schreibSave(d, BEN, sb);
    const sc = liesSave(d, CARL); sc.fleet.missions = [angriffMission('m3', SYS1)]; schreibSave(d, CARL, sc);
    const dd = liesDoc(d, SYS1); dd.seit = Date.now() - 60000; schreibDoc(d, dd);   // frisch gebaut -> Bauschutz
  });
  const schutz = await post(tokB, '/vorposten/angriff', { system: SYS1, missionId: 'm1' });
  check('4a: unter Bauschutz kein Angriff (403, schutzBis genannt)', schutz.status === 403 && schutz.body.schutz === true && schutz.body.schutzBis > Date.now(), { status: schutz.status, body: schutz.body });
  let garnVorher = 0, lpVorher4b = 0;
  /* Die STUFE traegt den Kern, nicht ein von Hand ins Dokument geschriebenes Dach: Seit dem
     03.09.2026 rechnet der Server `lpMax` aus Stufe, Zweig und Modulen und kappt beim Schreiben,
     was darueber liegt. Ein Stufe-1-Vorposten mit 900.000 eingetragenen Punkten war vorher eine
     stille Falschangabe - er faellt jetzt beim ersten Schlag, weil sein echtes Dach 20.000 ist.
     Stufe 3 (Kernstation) traegt 400.000 und uebersteht 4b sicher. Der Ausgangswert wird ausserdem
     beim SERVER erfragt statt aus der Vorrichtung gelesen - so misst 4b2 die Rechnung des
     Servers und nicht die eigene Annahme. */
  await aendereDb(d => {
    const dd = liesDoc(d, SYS1); dd.seit = Date.now() - 13 * 3600 * 1000;
    dd.stufe = 3;
    dd.kern = { lp: 400000, lpMax: 400000 };                        // faellt in 4b sicher NICHT
    garnVorher = Object.values(dd.garnison).reduce((a, n) => a + n, 0);
    schreibDoc(d, dd);
  });
  {
    const vor4 = await s.j('/vorposten', { headers: kopf(tokB) });
    lpVorher4b = (((vor4.body.liste || []).find(x => x.sys === SYS1) || {}).kern || {}).lp;
  }
  const r4 = await post(tokB, '/vorposten/angriff', { system: SYS1, missionId: 'm1' });
  check('4b: der Schlag wird angenommen, richtet Schaden an und nennt eigene Verluste',
    r4.status === 200 && r4.body.ok === true && r4.body.schaden > 0 && r4.body.gefallen === false && Object.keys(r4.body.eigeneVerluste || {}).length > 0,
    r4.body && { status: r4.status, schaden: r4.body.schaden, lp: r4.body.lp, verluste: r4.body.eigeneVerluste });
  check('4b2: angekommen = kernVorher - kernNachher (auch ohne Fall)', r4.body.schaden === lpVorher4b - r4.body.lp, { schaden: r4.body.schaden, lpVorher: lpVorher4b, lp: r4.body.lp });
  let garnNachher = -1, docNach4b = null;
  await aendereDb(d => { docNach4b = liesDoc(d, SYS1); garnNachher = Object.values(docNach4b.garnison).reduce((a, n) => a + n, 0); });
  check('4f: die Garnison hat serverseitig verloren (im Dokument, nicht in einem Spielstand)',
    garnNachher < garnVorher && Object.keys(r4.body.garnisonVerluste || {}).length > 0, { vorher: garnVorher, nachher: garnNachher, gemeldet: r4.body.garnisonVerluste });
  check('4g: der Kampfvermerk steht am Objekt (letzterKampf mit Angreifer und Schaden)',
    !!docNach4b.letzterKampf && docNach4b.letzterKampf.angreifer === BEN && docNach4b.letzterKampf.schaden === r4.body.schaden, docNach4b.letzterKampf);
  /* 4h: DER BESITZER ERFAEHRT ES - bei diesem Schlag, nicht erst beim Fall. Das ist die
     Verteidigungs-Zusage des Konzepts (§2.6): Er soll mit einer Garnison gegenhalten koennen,
     und dafuer muss er den ERSTEN Schlag mitbekommen. Der Kampfvermerk (4g) steht nur im
     Dokument - sichtbar erst, wenn er das Kartenmenue oeffnet.
     Gemessen wird der Postfach-Eintrag in db.private[uid].__notificationEvents, nicht der
     Handy-Versand (der ist Feuer-und-Vergessen und in einem Test ohne VAPID-Schluessel ohnehin
     stumm) - und der TEXT wird mitgeprueft, denn eine Meldung ohne Kernstand nimmt dem Besitzer
     genau die Zahl, an der er die Dringlichkeit ablesen soll (Regel 28). */
  const meldungen = (liesDb().private[ANNA] || {}).__notificationEvents || [];
  const vpMeldung = meldungen.find(m => m.type === 'vorposten-angegriffen');
  check('4h: der Besitzer bekommt eine Meldung ueber den Angriff - beim Schlag, nicht erst beim Fall',
    !!vpMeldung && vpMeldung.payload.gefallen === false && vpMeldung.payload.angreiferName === 'ben',
    { gefunden: !!vpMeldung, payload: vpMeldung && vpMeldung.payload,
      hinweis: 'ohne sie erfaehrt er erst vom Verlust und kann nie reagieren' });
  check('4h2: und sie nennt den Kernstand, an dem er die Dringlichkeit ablesen kann',
    !!vpMeldung && typeof vpMeldung.payload.kernProzent === 'number' && vpMeldung.payload.kernProzent > 0 && vpMeldung.payload.kernProzent < 100,
    vpMeldung && { kernProzent: vpMeldung.payload.kernProzent, name: vpMeldung.payload.name, system: vpMeldung.payload.system });
  const r4d = await post(tokB, '/vorposten/angriff', { system: SYS1, missionId: 'm2' });
  check('4d: Abklingzeit AM OBJEKT - der zweite Schlag desselben Kontos wird abgewiesen', r4d.status === 403 && r4d.body.abklingzeit === true, { status: r4d.status, body: r4d.body });
  await aendereDb(d => { const sa = liesSave(d, ANNA); sa.fleet.missions = [angriffMission('m9', SYS1)]; schreibSave(d, ANNA, sa); });
  const eigen = await post(tokA, '/vorposten/angriff', { system: SYS1, missionId: 'm9' });
  check('4e: den eigenen Vorposten greift man nicht an', eigen.status === 400, { status: eigen.status, body: eigen.body });
  // 4c: der ANGEKOMMENE Schaden - gemessen dort, wo der Deckel greift (Regel 7): kern.lp = 500,
  // jeder Wurf liegt weit darueber. Mit dem vollen Wurf stuende hier eine fuenfstellige Zahl.
  await aendereDb(d => { const dd = liesDoc(d, SYS1); dd.kern.lp = 500; schreibDoc(d, dd); });
  const r4c = await post(tokC, '/vorposten/angriff', { system: SYS1, missionId: 'm3' });
  check('4c: gezaehlt wird, was ANGEKOMMEN ist - bei 500 Rest-LP genau 500, nicht der Wurf',
    r4c.status === 200 && r4c.body.gefallen === true && r4c.body.schaden === 500, r4c.body && { status: r4c.status, schaden: r4c.body.schaden, gefallen: r4c.body.gefallen });

  // ---- 5) Fall ---------------------------------------------------------------------------------
  let nachFall = null, belohnungB = null, belohnungC = null, verlustA = null;
  await aendereDb(d => {
    nachFall = liesDoc(d, SYS1);
    belohnungB = (d.private[BEN].__pendingRewards || []).find(r => r.type === 'vorposten') || null;
    belohnungC = (d.private[CARL].__pendingRewards || []).find(r => r.type === 'vorposten') || null;
    verlustA = (d.private[ANNA].__pendingRewards || []).find(r => r.type === 'vorposten-verlust') || null;
  });
  check('5a: das Dokument ist nach dem Fall weg', nachFall === null, { doc: nachFall && nachFall.id });
  check('5b: der letzte Angreifer bekommt eine Belohnung mit EIGENEM type vorposten und Anteil',
    !!belohnungC && belohnungC.anteil > 0 && belohnungC.kampfpunkte > 0 && belohnungC.credits > 0, belohnungC);
  check('5c: auch der fruehere Beitragende (ben) ist dabei, die Anteile summieren sich zu 1',
    !!belohnungB && belohnungB.anteil > 0 && Math.abs((belohnungB.anteil + belohnungC.anteil) - 1) < 0.003, { ben: belohnungB && belohnungB.anteil, carl: belohnungC && belohnungC.anteil });
  check('5d: der Besitzer erfaehrt vom Verlust (vorposten-verlust mit Restgarnison)',
    !!verlustA && verlustA.system === SYS1 && verlustA.garnisonVerloren && typeof verlustA.garnisonVerloren === 'object', verlustA);

  // ---- 6) Aufgeben ist ein ABBAU ueber 24 Stunden (03.09.2026) ----------------------------------
  /* Auftrag Sascha: "vorposten sollen auch aufgebar sein allerdings muessen die abgebaut werden
     dauert 24 stunden". Der Punkt der Frist ist 6d: Bis hierher verschwand der Vorposten in dem
     Moment, in dem sein Besitzer es wollte - auch mitten im Angriff, und der Angreifer stand vor
     einem leeren System. Deshalb misst dieser Abschnitt nicht nur, DASS es dauert, sondern dass
     der Vorposten waehrenddessen angreifbar bleibt. */
  const SYS6 = 'vpsys-f';
  const modul6 = get0.body.modulDefs[0].key + ':episch';
  await aendereDb(d => {
    schreibDoc(d, doc(SYS6, ANNA, 'anna', { garnison: { cruisers: 40 }, stufe: get0.body.zweigAb + 1,
      zweig: 'festung', module: [modul6] }));
    d.users.anna.vpModule = {};
    const sb = liesSave(d, BEN); sb.fleet.missions = (sb.fleet.missions || []).concat([angriffMission('m6', SYS6)]); schreibSave(d, BEN, sb);
  });
  const fremdAuf = await post(tokB, '/vorposten/aufgeben', { system: SYS6 });
  check('6a: ein Fremder kann nicht aufgeben', fremdAuf.status === 403, { status: fremdAuf.status });
  const auf = await post(tokA, '/vorposten/aufgeben', { system: SYS6 });
  let nach6 = 'unbekannt';
  await aendereDb(d => { nach6 = liesDoc(d, SYS6); });
  check('6b: Aufgeben startet den Abbau - der Vorposten steht noch, mit Frist in der Zukunft',
    auf.status === 200 && auf.body.abbau === true && auf.body.abbauAb > Date.now()
    && auf.body.dauerMs > 0 && nach6 !== null && nach6.abbauAb === auf.body.abbauAb,
    { body: auf.body && { abbau: auf.body.abbau, abbauAb: auf.body.abbauAb }, stehtNoch: nach6 !== null });
  const nochmal6 = await post(tokA, '/vorposten/aufgeben', { system: SYS6 });
  check('6c: ein zweiter Aufruf startet nichts Neues, sondern nennt die Restzeit',
    nochmal6.status === 400 && nochmal6.body.laeuft === true && nochmal6.body.abbauAb === auf.body.abbauAb,
    { status: nochmal6.status, body: nochmal6.body });
  // 6d: DER Punkt der Frist - der Abbau ist keine Fluchttuer aus einem laufenden Angriff.
  const schlag6 = await post(tokB, '/vorposten/angriff', { system: SYS6, missionId: 'm6' });
  check('6d: waehrend des Abbaus bleibt der Vorposten angreifbar (sonst waere er eine Fluchttuer)',
    schlag6.status === 200 && schlag6.body.ok === true && schlag6.body.schaden > 0,
    { status: schlag6.status, schaden: schlag6.body && schlag6.body.schaden, error: schlag6.body && schlag6.body.error });
  const abbruch6 = await post(tokA, '/vorposten/abbau/abbrechen', { system: SYS6 });
  let nachAbbruch = null;
  await aendereDb(d => { nachAbbruch = liesDoc(d, SYS6); });
  check('6e: der Abbau laesst sich abbrechen - die Frist ist weg, der Vorposten bleibt',
    abbruch6.status === 200 && nachAbbruch && !nachAbbruch.abbauAb, { status: abbruch6.status, doc: !!nachAbbruch });
  // 6f: abgelaufene Frist -> der galaxyTick raeumt auf. Die Kopie taktet im Sekundenbereich.
  /* Die Garnison wird HIER gemessen, nicht aus der Vorrichtung angenommen: Der Schlag in 6d hat
     Schiffe gekostet, und die Regel lautet "was noch dasteht, kommt zurueck" - nicht "vierzig".
     Der erste Entwurf verglich mit der Startzahl und fiel genau daran (gemessen: 37 statt 40). */
  /* NULL-SICHER: Unter der Sabotage `abbaufrist` ist die Frist sofort abgelaufen, der Tick raeumt
     den Vorposten also schon vor dieser Zeile weg. Der erste Entwurf griff hier auf `dd.garnison`
     eines nicht mehr vorhandenen Dokuments zu und STUERZTE AB - damit belegten 6f und 6g unter
     dieser Sabotage gar nichts, und die Prueflisten beider Laeufe waren verschieden. Genau die
     Lehre aus test_vorposten_module_ui: Ein Test, der am kaputten Stand abstuerzt statt zu fallen,
     misst dort nichts. */
  let garnVorTick = null;
  await aendereDb(d => {
    const dd = liesDoc(d, SYS6);
    if (!dd) return;
    garnVorTick = Object.assign({}, dd.garnison || {});
    dd.abbauAb = Date.now() - 1000;
    schreibDoc(d, dd);
  });
  await new Promise(r => setTimeout(r, 4000));
  let nachTick = 'unbekannt', belohnung6 = null, bestand6 = null;
  await aendereDb(d => {
    nachTick = liesDoc(d, SYS6);
    belohnung6 = (d.private[ANNA].__pendingRewards || []).find(r => r.type === 'vorposten-abbau') || null;
    bestand6 = d.users.anna.vpModule || {};
  });
  check('6f: nach Ablauf raeumt der Tick auf - Dokument weg, Belohnung mit EIGENEM type, Garnison drin',
    nachTick === null && !!belohnung6 && belohnung6.system === SYS6
    && JSON.stringify(belohnung6.garnison || {}) === JSON.stringify(garnVorTick),
    { docDanach: nachTick, zurueck: belohnung6 && belohnung6.garnison, stand: garnVorTick });
  check('6g: und die eingebauten Module kommen in den Bestand zurueck (kein Fundstueck geht beim Aufraeumen verloren)',
    bestand6 && bestand6[modul6] === 1, { bestand: bestand6, erwartet: modul6 });

  // ---- 7) Ausbau -------------------------------------------------------------------------------
  const SYS7 = 'vpsys-g';
  await aendereDb(d => { schreibDoc(d, doc(SYS7, ANNA, 'anna', { kern: { lp: 10000, lpMax: KERN1 }, ausbauSeit: Date.now() })); });
  const zuFrueh = await post(tokA, '/vorposten/ausbauen', { system: SYS7 });
  check('7a: Ausbau hat eine Abklingzeit am Objekt', zuFrueh.status === 400 && zuFrueh.body.abklingzeit === true, { status: zuFrueh.status, body: zuFrueh.body });
  await aendereDb(d => { const dd = liesDoc(d, SYS7); dd.ausbauSeit = Date.now() - 13 * 3600 * 1000; schreibDoc(d, dd); });
  const aus = await post(tokA, '/vorposten/ausbauen', { system: SYS7 });
  check('7b: Stufe 2 - das Maximum ist das der zweiten Stufe, die LP wachsen um die DIFFERENZ (kein Heilen)',
    aus.status === 200 && aus.body.vorposten.stufe === 2 && aus.body.vorposten.kern.lpMax === KERN2 && aus.body.vorposten.kern.lp === 10000 + (KERN2 - KERN1),
    aus.body && aus.body.vorposten && { stufe: aus.body.vorposten.stufe, lp: aus.body.vorposten.kern.lp, lpMax: aus.body.vorposten.kern.lpMax, erwartetLp: 10000 + (KERN2 - KERN1) });
  const fremdAus = await post(tokB, '/vorposten/ausbauen', { system: SYS7 });
  check('7c: ein Fremder kann nicht ausbauen', fremdAus.status === 403, { status: fremdAus.status });
  // ---- 7e-7h) Die Zweigwahl faellt beim Sprung auf die Wahlstufe, einmalig -----------------------
  const maxStufe = get0.body.maxStufe, zweigAb = get0.body.zweigAb;
  await aendereDb(d => { const dd = liesDoc(d, SYS7); dd.stufe = zweigAb - 1; delete dd.zweig; dd.ausbauSeit = Date.now() - 13 * 3600 * 1000; schreibDoc(d, dd); });
  const ohneZweig = await post(tokA, '/vorposten/ausbauen', { system: SYS7 });
  check('7e: der Ausbau auf die Wahlstufe verlangt eine Ausrichtung und nennt die drei Zweige',
    ohneZweig.status === 400 && ohneZweig.body.zweigNoetig === true && (ohneZweig.body.zweige || []).length === 3,
    { status: ohneZweig.status, zweige: (ohneZweig.body.zweige || []).map(z => z.key) });
  const falsch = await post(tokA, '/vorposten/ausbauen', { system: SYS7, zweig: 'gibtsnicht' });
  check('7f: ein erfundener Zweig wird abgelehnt', falsch.status === 400 && falsch.body.zweigNoetig === true, { status: falsch.status });
  const mitZweig = await post(tokA, '/vorposten/ausbauen', { system: SYS7, zweig: 'festung' });
  const basisWahl = get0.body.stufen[zweigAb - 1];
  check('7g: mit Ausrichtung geht der Ausbau durch - der Zweig steht im Dokument und praegt Namen und Werte',
    mitZweig.status === 200 && mitZweig.body.vorposten.zweig === 'festung'
    && mitZweig.body.vorposten.name !== basisWahl.name
    && mitZweig.body.vorposten.kern.lpMax > basisWahl.kernLp,   // Festungsring: dickerer Kern als die Leiter
    mitZweig.body && mitZweig.body.vorposten && { zweig: mitZweig.body.vorposten.zweig, name: mitZweig.body.vorposten.name, lpMax: mitZweig.body.vorposten.kern.lpMax, leiter: basisWahl.kernLp });
  await aendereDb(d => { const dd = liesDoc(d, SYS7); dd.ausbauSeit = Date.now() - 13 * 3600 * 1000; schreibDoc(d, dd); });
  const zweitWahl = await post(tokA, '/vorposten/ausbauen', { system: SYS7, zweig: 'handel' });
  check('7h: die Ausrichtung ist unveraenderlich - ein spaeter mitgeschickter Zweig aendert nichts',
    zweitWahl.status === 200 && zweitWahl.body.vorposten.zweig === 'festung', zweitWahl.body && zweitWahl.body.vorposten && { zweig: zweitWahl.body.vorposten.zweig, stufe: zweitWahl.body.vorposten.stufe });
  await aendereDb(d => { const dd = liesDoc(d, SYS7); dd.stufe = maxStufe; dd.ausbauSeit = Date.now() - 13 * 3600 * 1000; schreibDoc(d, dd); });
  const voll = await post(tokA, '/vorposten/ausbauen', { system: SYS7, zweig: 'festung' });
  check('7d: nach dem Endausbau (letzte Stufe der Leiter) kein weiterer', voll.status === 400 && voll.body.endausbau === true, { status: voll.status, maxStufe });

  // ---- 8) Der Schalter ist der Auslieferungs-Riegel ---------------------------------------------
  {
    const schalter = (roh.match(/const VORPOSTEN_AKTIV = (true|false);/) || [])[1];
    check('8a: der Schalter ist auffindbar', !!schalter, { steht_auf: schalter });
    check('8b: und er steht auf TRUE (Frontend mit dem Vorposten-Zweig ausgeliefert - false waere eine Notabschaltung, deren Grund nach docs/vorposten.md gehoert)',
      schalter === 'true', { steht_auf: schalter, hinweis: 'umgelegt am 02.09.2026 unmittelbar nach dem Frontend-Merge; der Admin-Notaus stoppt nur den BAU' });
    check('8c: der Admin-Notaus kennt vorposten (NOTAUS_NAMEN und spawnAktivImCode)',
      /vorposten:\s*'Neue Vorposten werden errichtet'/.test(roh) && roh.includes("if (name === 'vorposten') return VORPOSTEN_AKTIV;") && roh.includes("if (!spawnAktiv('vorposten'))"));
    check('8d: BEIDE Rechte-Ketten der Storage-Route kennen checkVorpostenKeyPermission',
      roh.includes('checkVorpostenKeyPermission(req, key, false)') && roh.includes('checkVorpostenKeyPermission(req, key, true)'));
    /* Der Abbau-Schalter braucht dieselbe Wache. Ohne sie prueft dieser Test nur die KOPIE (die legt
       ihn selbst um, Zeile 0-kopie3) - der ausgelieferte Stand koennte still auf false zurueckfallen,
       und das saehe wie Normalbetrieb aus: /api/vorposten meldet abbauAktiv:false, das Frontend
       beschriftet den Eintrag brav wieder mit "aufgeben", und niemandem faellt etwas auf. */
    const abbauSchalter = (roh.match(/const VORPOSTEN_ABBAU_AKTIV = (true|false);/) || [])[1];
    check('8e: auch der Abbau-Schalter steht im AUSGELIEFERTEN Stand auf TRUE (Frontend v8.654.0 liest abbauMs/abbauAktiv)',
      abbauSchalter === 'true', { steht_auf: abbauSchalter, hinweis: 'umgelegt am 03.09.2026 nach dem Frontend-Merge; false waere eine Notabschaltung mit Grund in docs/vorposten.md' });
  }

  // ---- 9) Stationsmodule: Bestand, Bau, Einbau, Ausbau, Wirkung ---------------------------------
  {
    const SYS9 = 'vpsys-i';
    const modKey = get0.body.modulDefs[1].key;          // 'geschuetz' - wirkt auf die Verteidigung
    const instKey = modKey + ':selten';
    check('9-anker: der Modulkatalog reist mit (Definitionen, Seltenheiten, was baubar ist)',
      Array.isArray(get0.body.modulDefs) && get0.body.modulDefs.length >= 4
      && get0.body.modulSeltenheiten && get0.body.modulSeltenheiten.selten
      && Array.isArray(get0.body.modulBaubar) && get0.body.modulBaubar.indexOf('legendaer') < 0,
      { defs: (get0.body.modulDefs||[]).map(d => d.key), baubar: get0.body.modulBaubar });
    // Ein Vorposten AUF der Wahlstufe, damit es ueberhaupt einen Steckplatz gibt.
    // Eine Stufe UEBER der Wahlstufe: zwei Steckplaetze. Mit nur einem scheiterte der zweite
    // Einbau am vollen Vorposten statt am leeren Bestand - die Pruefung 9e2 haette dann etwas
    // anderes gemessen als ihr Name sagt (erster Entwurf, im Lauf aufgefallen).
    await aendereDb(d => { const dd = doc(SYS9, ANNA, 'anna'); dd.stufe = get0.body.zweigAb + 1; dd.zweig = 'festung'; schreibDoc(d, dd); });
    const bau1 = await post(tokA, '/vorposten/modul/bauen', { modul: modKey, seltenheit: 'selten' });
    check('9a: bauen laesst sich nur bis „ungewoehnlich" - „selten" wird abgelehnt und sagt warum',
      bau1.status === 400 && bau1.body.nurFund === true && /Festungen, Nestern und Konvois/.test(String(bau1.body.error)), { status: bau1.status, body: bau1.body });
    const bau2 = await post(tokA, '/vorposten/modul/bauen', { modul: modKey, seltenheit: 'ungewoehnlich' });
    check('9b: ein baubares Modul landet im Bestand am NUTZEROBJEKT (nicht im Spielstand)',
      bau2.status === 200 && bau2.body.bestand && bau2.body.bestand[modKey + ':ungewoehnlich'] === 1, bau2.body && bau2.body.bestand);
    const bau3 = await post(tokA, '/vorposten/modul/bauen', { modul: modKey, seltenheit: 'gewoehnlich' });
    check('9c: die Schmiede hat eine Abklingzeit - sonst waere der Bau eine Endlosquelle',
      bau3.status === 400 && bau3.body.abklingzeit === true && bau3.body.bauAb > Date.now(), { status: bau3.status, body: bau3.body });

    // Einbauen: das Modul muss aus dem Bestand VERSCHWINDEN und im Dokument stehen.
    await aendereDb(d => { d.users.anna.vpModule = { [instKey]: 1 }; });
    const ein = await post(tokA, '/vorposten/modul/einbauen', { system: SYS9, modul: instKey });
    check('9d: einbauen steckt das Modul in den Vorposten', ein.status === 200 && (ein.body.vorposten.module || []).indexOf(instKey) === 0,
      { status: ein.status, module: ein.body.vorposten && ein.body.vorposten.module });
    check('9e: und nimmt es aus dem Bestand (kein Modul zweimal)', ein.status === 200 && !(ein.body.bestand || {})[instKey], ein.body && ein.body.bestand);
    const ohne = await post(tokA, '/vorposten/modul/einbauen', { system: SYS9, modul: instKey });
    check('9e2: ein zweiter Einbau desselben Stuecks scheitert am leeren BESTAND (nicht an den Slots)',
      ohne.status === 400 && /Bestand/.test(String(ohne.body && ohne.body.error)) && ohne.body.voll !== true,
      { status: ohne.status, body: ohne.body });

    // Wirkung: die Geschuetzbank hebt die Verteidigung UEBER den Stufenwert.
    const nurStufe = get0.body.stufen[get0.body.zweigAb].verteidigung;   // eine Stufe ueber der Wahlstufe, siehe oben
    check('9f: das eingebaute Modul hebt die Verteidigung ueber den reinen Stufenwert',
      ein.body.vorposten.verteidigung > nurStufe && ein.body.vorposten.modulBoni && ein.body.vorposten.modulBoni.verteidigung > 0,
      { verteidigung: ein.body.vorposten.verteidigung, nurStufe, boni: ein.body.vorposten.modulBoni });
    /* GEGEN DIE MOMENTAUFNAHME (05.09.2026): Hier stand `slots === 2`, und Etappe V7 hat die Zahl
       geaendert - der Festungsring bekommt seit dem einen Platz mehr. Eine feste Zahl haelt einen
       Zustand fest, keine Regel. Geprueft wird jetzt die REGEL: Leiter (einer je Stufe ab der
       Wahlstufe) plus der Zuschlag der Ausrichtung, beides aus der Serverangabe - und dass die
       Leiter an dieser Stelle wirklich zwei ergibt, damit die Aussage „waechst mit der Stufe"
       nicht verlorengeht. */
    const leiterSlots9 = ein.body.vorposten.stufe - get0.body.zweigAb + 1;
    const zuschlag9 = get0.body.modulSetsAktiv ? ((get0.body.zweigSlots || {})[ein.body.vorposten.zweig] || 0) : 0;
    check('9g: die Steckplatzzahl kommt vom Server: Leiter (hier zwei) plus Zuschlag der Ausrichtung',
      leiterSlots9 === 2 && ein.body.vorposten.slots === leiterSlots9 + zuschlag9,
      { slots: ein.body.vorposten.slots, leiter: leiterSlots9, zuschlag: zuschlag9, zweig: ein.body.vorposten.zweig });

    // Ausbauen kostet eine Kleinigkeit - und gibt das Modul heil zurueck.
    let krediteVorher = 0;
    await aendereDb(d => { const s = JSON.parse(d.private[ANNA]['kepler7-save-v3']); s.credits = 1000; krediteVorher = s.credits; d.private[ANNA]['kepler7-save-v3'] = JSON.stringify(s); });
    const raus = await post(tokA, '/vorposten/modul/ausbauen', { system: SYS9, platz: 0 });
    check('9h: ausbauen gibt das Modul heil in den Bestand zurueck',
      raus.status === 200 && raus.body.modul === instKey && (raus.body.bestand || {})[instKey] === 1 && (raus.body.vorposten.module || []).length === 0,
      { status: raus.status, modul: raus.body.modul, bestand: raus.body.bestand });
    check('9i: und kostet eine Kleinigkeit (Kredite aus dem Spielstand, zurueckgemeldet)',
      raus.body.kosten === get0.body.modulAusbauKosten && raus.body.newCredits === krediteVorher - get0.body.modulAusbauKosten,
      { kosten: raus.body.kosten, vorher: krediteVorher, nachher: raus.body.newCredits });
    const fremd = await post(tokB, '/vorposten/modul/einbauen', { system: SYS9, modul: instKey });
    check('9j: ein Fremder bestueckt den Vorposten nicht', fremd.status === 403, { status: fremd.status });
  }

  // ---- 10) Das Kern-Dach folgt der Panzerung ----------------------------------------------------
  /* Bis zum 03.09.2026 stand `lpMax` im Dokument und wurde NUR bei Bau und Ausbau geschrieben. Eine
     eingebaute Kernpanzerung hob damit zwar vorpostenWerte().kernLp, aber der Kern las das nie: Das
     Modul war bis zum naechsten Ausbau wirkungslos - und danach haette sein Ausbau das Dach nicht
     wieder gesenkt. Gemessen wird deshalb die REGEL: Das Dach folgt der Panzerung in beide
     Richtungen, ein Einbau heilt nicht, und Ein- plus Ausbau ist keine Reparatur. */
  {
    const SYS10 = 'vpsys-j';
    const kernKey = get0.body.modulDefs.find(d => d.wirkung === 'kern').key;
    const inst10 = kernKey + ':episch';
    await aendereDb(d => {
      const dd = doc(SYS10, ANNA, 'anna');
      dd.stufe = get0.body.zweigAb + 1; dd.zweig = 'festung';
      schreibDoc(d, dd);
      d.users.anna.vpModule = { [inst10]: 1 };
    });
    const vor10 = await s.j('/vorposten', { headers: kopf(tokA) });
    const v10a = (vor10.body.liste || []).find(x => x.sys === SYS10) || { kern: {} };
    const dachOhne = v10a.kern.lpMax;
    // Der Kern wird auf die Haelfte gesetzt: So ist sichtbar, ob ein Einbau HEILT (das darf er nicht).
    const lpVorher = Math.round(dachOhne / 2);
    await aendereDb(d => { const dd = liesDoc(d, SYS10); dd.kern.lp = lpVorher; schreibDoc(d, dd); });
    const ein10 = await post(tokA, '/vorposten/modul/einbauen', { system: SYS10, modul: inst10 });
    check('10a: die Kernpanzerung hebt das Dach SOFORT, nicht erst beim naechsten Ausbau',
      ein10.status === 200 && ein10.body.vorposten.kern.lpMax > dachOhne,
      { ohne: dachOhne, mit: ein10.body.vorposten && ein10.body.vorposten.kern });
    check('10b: und sie heilt dabei nicht - die Lebenspunkte bleiben, wo sie waren',
      ein10.status === 200 && ein10.body.vorposten.kern.lp === lpVorher,
      { lpVorher, lpNachher: ein10.body.vorposten && ein10.body.vorposten.kern.lp });
    await aendereDb(d => { const s2 = liesSave(d, ANNA); s2.credits = 1000; schreibSave(d, ANNA, s2); });
    const raus10 = await post(tokA, '/vorposten/modul/ausbauen', { system: SYS10, platz: 0 });
    check('10c: der Ausbau senkt das Dach wieder auf den Stufenwert',
      raus10.status === 200 && raus10.body.vorposten.kern.lpMax === dachOhne,
      { ohne: dachOhne, nachAusbau: raus10.body.vorposten && raus10.body.vorposten.kern.lpMax });
    check('10d: Ein- und Ausbauen ist keine Reparatur (die Lebenspunkte stehen wie vorher)',
      raus10.status === 200 && raus10.body.vorposten.kern.lp === lpVorher,
      { lpVorher, lpNachher: raus10.body.vorposten && raus10.body.vorposten.kern.lp });
  }

  // ---- 11) Stationsprojekte: Freischaltung, Bauzeit, Wirkung, Sprungtor -------------------------
  /* Etappe 4 (03.09.2026). Ausgeliefert steht VP_PROJEKTE_AKTIV auf false; hier laeuft die Kopie
     mit umgelegtem Schalter (0-kopie2), sonst waere die ganze Etappe bis zum Frontend ungeprueft. */
  {
    const SYS11 = 'vpsys-k';
    const defs = get0.body.projektDefs || [];
    const dock = defs.find(d => d.zweig === 'werft');
    const tor = defs.find(d => d.key === 'sprungtor');
    check('11-anker: der Projektkatalog reist mit (mit Zweig, Stufe, Dauer und Kosten)',
      defs.length >= 4 && !!dock && !!tor && dock.stufeAb > 0 && dock.dauerMs > 0 && !!dock.kosten && tor.stufeAb > dock.stufeAb,
      { keys: defs.map(d => d.key), dockAb: dock && dock.stufeAb, torAb: tor && tor.stufeAb });

    // Zu niedrige Stufe: eine Stufe UNTER der Anforderung, richtiger Zweig.
    await aendereDb(d => { const dd = doc(SYS11, ANNA, 'anna'); dd.stufe = dock.stufeAb - 1; dd.zweig = 'werft'; schreibDoc(d, dd); });
    const zuKlein = await post(tokA, '/vorposten/projekt/starten', { system: SYS11, projekt: dock.key });
    check('11a: unter der geforderten Stufe geht nichts - und die Antwort nennt die Stufe',
      zuKlein.status === 400 && zuKlein.body.stufeFehlt === true && zuKlein.body.stufeAb === dock.stufeAb,
      { status: zuKlein.status, body: zuKlein.body });

    // Richtige Stufe, FALSCHER Zweig: das Zweig-Projekt bleibt zu.
    await aendereDb(d => { const dd = liesDoc(d, SYS11); dd.stufe = dock.stufeAb; dd.zweig = 'festung'; schreibDoc(d, dd); });
    const falscherZweig = await post(tokA, '/vorposten/projekt/starten', { system: SYS11, projekt: dock.key });
    check('11b: ein Zweig-Projekt baut nur seine Ausrichtung - sonst waeren die Zweige beliebig',
      falscherZweig.status === 400 && falscherZweig.body.zweigFehlt === true, { status: falscherZweig.status, body: falscherZweig.body });

    // Passend: das Vorhaben laeuft an.
    await aendereDb(d => { const dd = liesDoc(d, SYS11); dd.zweig = 'werft'; schreibDoc(d, dd); });
    const vorStart = await s.j('/vorposten', { headers: kopf(tokA) });
    const garnVor = ((vorStart.body.liste || []).find(x => x.sys === SYS11) || {}).garnisonMax;
    const start = await post(tokA, '/vorposten/projekt/starten', { system: SYS11, projekt: dock.key });
    check('11c: passend gestartet - mit Fertigzeit in der Zukunft und den Kosten, die der Client bucht',
      start.status === 200 && start.body.fertigAb > Date.now() && !!start.body.kosten
      && (start.body.vorposten.projektLaeuft || {}).key === dock.key,
      { status: start.status, fertigAb: start.body.fertigAb, laeuft: start.body.vorposten && start.body.vorposten.projektLaeuft });
    check('11d: waehrend es laeuft, wirkt es NICHT - sonst waere die Bauzeit eine Zierde',
      start.status === 200 && start.body.vorposten.garnisonMax === garnVor
      && (start.body.vorposten.projekte || []).length === 0,
      { vorher: garnVor, waehrend: start.body.vorposten && start.body.vorposten.garnisonMax });
    const zweites = await post(tokA, '/vorposten/projekt/starten', { system: SYS11, projekt: dock.key });
    check('11e: eine Station baut hoechstens ein Vorhaben gleichzeitig',
      zweites.status === 400 && zweites.body.belegt === true, { status: zweites.status, body: zweites.body });

    // Fertig: die Zeit vorziehen, dann muss die Wirkung da sein.
    await aendereDb(d => { const dd = liesDoc(d, SYS11); dd.projekte[0].fertigAb = Date.now() - 1000; schreibDoc(d, dd); });
    const nachher = await s.j('/vorposten', { headers: kopf(tokA) });
    const v11 = (nachher.body.liste || []).find(x => x.sys === SYS11) || {};
    check('11f: fertig wirkt es - die Garnisonsgrenze steht ueber dem reinen Stufenwert',
      v11.garnisonMax > garnVor && (v11.projekte || []).indexOf(dock.key) >= 0 && !v11.projektLaeuft,
      { vorher: garnVor, nachher: v11.garnisonMax, projekte: v11.projekte });
    const nochmal = await post(tokA, '/vorposten/projekt/starten', { system: SYS11, projekt: dock.key });
    check('11g: dasselbe Vorhaben gibt es kein zweites Mal',
      nochmal.status === 400 && nochmal.body.schonDa === true, { status: nochmal.status, body: nochmal.body });

    /* Das Sprungtor hebt den DECKEL, es addiert nicht nur. Genau das ist sein Sinn: Der
       Flugzeit-Bonus ist im Spiel bei VP_FLUG_DECKEL gedeckelt, eine hohe Stufe liegt mit Modulen
       schon daran - ein Tor, das nur aufaddiert, taete nichts. */
    check('11h-anker: ohne Tor gilt der normale Flugzeit-Deckel',
      v11.nutzen && v11.nutzen.flugDeckel === get0.body.flugDeckel, { deckel: v11.nutzen && v11.nutzen.flugDeckel, normal: get0.body.flugDeckel });
    await aendereDb(d => {
      const dd = liesDoc(d, SYS11); dd.stufe = tor.stufeAb;
      dd.projekte.push({ key: tor.key, start: Date.now() - 2000, fertigAb: Date.now() - 1000 });
      schreibDoc(d, dd);
    });
    const mitTor = await s.j('/vorposten', { headers: kopf(tokA) });
    const v11t = (mitTor.body.liste || []).find(x => x.sys === SYS11) || {};
    check('11h: das Sprungtor hebt den Flugzeit-Deckel ueber den normalen',
      v11t.nutzen && v11t.nutzen.flugDeckel > get0.body.flugDeckel,
      { mitTor: v11t.nutzen && v11t.nutzen.flugDeckel, normal: get0.body.flugDeckel });
    const fremd11 = await post(tokB, '/vorposten/projekt/starten', { system: SYS11, projekt: tor.key });
    check('11i: ein Fremder startet an fremden Stationen nichts', fremd11.status === 403, { status: fremd11.status });
  }

  await stoppeServer();

  // ---- Auswertung: Gruen-Lauf ODER Gegenprobe (Regel 71) --------------------------------------
  if (SAB) {
    /* BEIDE Richtungen, gemessen (03.09.2026): Bis hierher prueft die Auswertung nur, ob das
       Erwartete gefallen IST - und meldete danach "genau [...] gefallen", wobei sie die ERWARTUNG
       ausdruckte, nicht die Messung. Eine Sabotage, die zehn weitere Pruefungen mitreisst, kam so
       als "korrekt" durch, und die Pflichtliste blieb eine unbelegte Behauptung. Aufgefallen an
       `projektwirkung`: Die Liste war noch leer, 11f und 11h fielen - gemeldet wurde
       "genau [] gefallen", Exit 0. Jetzt zaehlt der Lauf nach, WAS gefallen ist, und vergleicht
       in beide Richtungen. */
    const soll = MUSS_FALLEN[SAB] || [];
    const gefallen = [...new Set(Object.keys(ergebnis).filter(n => ergebnis[n] === false)
      .map(n => String(n).split(':')[0]))].sort();
    const nichtGefallen = soll.filter(k => gefallen.indexOf(k) < 0);
    const unerwartet = gefallen.filter(k => soll.indexOf(k) < 0);
    if (nichtGefallen.length || unerwartet.length) {
      if (nichtGefallen.length) console.log('\nWERKZEUGFEHLER - diese Pruefung(en) haetten bei Sabotage "' + SAB + '" fallen MUESSEN, blieben aber gruen: ' + JSON.stringify(nichtGefallen));
      if (unerwartet.length) console.log('\nWERKZEUGFEHLER - Sabotage "' + SAB + '" hat AUSSERDEM gerissen: ' + JSON.stringify(unerwartet) + ' - entweder trifft sie zu viel, oder die Pflichtliste ist unvollstaendig.');
      process.exit(1);
    }
    console.log('\nGegenprobe "' + SAB + '" korrekt: gemessen gefallen ' + JSON.stringify(gefallen) + '.');
    process.exit(0);
  }
  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nAlles gruen.');
  process.exit(fail ? 1 : 0);
})();
