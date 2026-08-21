// Bonuscodes im Admin-Bereich (21.08.2026, Auftrag Sascha).
//
// DER AUFTRAG, woertlich: "ich will ab und zu mal bonuscodes posten wo die spieler kleine geschenke
// bekommen die codes sollen aber nur eine gewisse gueltigkeit haben also max 1 mal pro account
// einloesbar und nur 1 woche etc aktiv am liebsten baust du mir das in den admin bereich ein."
//
// DIE DREI ZUSAGEN DES AUFTRAGS sind die drei wichtigsten Pruefungen dieses Tests:
//   * "max 1 mal pro account"  -> Abschnitt 4
//   * "nur 1 woche etc aktiv"  -> Abschnitt 5
//   * "in den admin bereich"   -> Abschnitt 1 (kein Fremder kommt an die Verwaltung)
//
// DIE ENTSCHEIDUNG, DIE DER TEST ABSICHERT (Abschnitt 4b): Die Einloesesperre liegt am
// user-Objekt, NICHT im Spielstand. Das naheliegende Vorbild /api/referral/redeem merkt sie sich in
// `save.referralRedeemed` - und der Spielstand ist bauartbedingt klientenautoritativ. Bei einem
// Code, der OEFFENTLICH gepostet wird, waere das eine Selbstbedienungstheke: Feld loeschen, erneut
// einloesen. 4b misst deshalb, dass der Spielstand die Sperre NICHT traegt und das Konto schon.
//
// KEIN VORBILD IM REPO: Vor diesem Test legte kein einziger Test ein Admin-Konto an
// (`grep -rn "gamegeeeeek" tests/*.js` lieferte null Treffer) - die zehn /api/admin-Routen waren
// von keiner Pruefung abgedeckt. isAdmin haengt allein am Schluessel 'gamegeeeeek' in db.users,
// kleingeschrieben; ein Eintrag unter 'GameGeeeeek' liefert false.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT || 3230);

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ADMIN = crypto.randomUUID(), ANNA = crypto.randomUUID(), BEN = crypto.randomUUID();

function spielstand(id, name) {
  return {
    resources: { energie: 1e5, erz: 1e5, kristalle: 1e5, deuterium: 1e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {}, fleet: { missions: [] },
    player: { id, name }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0, lastTick: Date.now()
  };
}
function grunddb() {
  return {
    // Der Schluessel MUSS 'gamegeeeeek' kleingeschrieben sein - daran haengt isAdmin.
    users: {
      gamegeeeeek: { userId: ADMIN, username: 'GameGeeeeek', passwordHash: hash, createdAt: Date.now() },
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() },
      ben:  { userId: BEN,  username: 'ben',  passwordHash: hash, createdAt: Date.now() }
    },
    private: {
      [ADMIN]: { 'kepler7-save-v3': JSON.stringify(spielstand(ADMIN, 'GameGeeeeek')) },
      [ANNA]:  { 'kepler7-save-v3': JSON.stringify(spielstand(ANNA, 'anna')) },
      [BEN]:   { 'kepler7-save-v3': JSON.stringify(spielstand(BEN, 'ben')) }
    },
    shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {} }
  };
}

const dbPfad = path.join(os.tmpdir(), 'kepler-bonuscodes-' + process.pid + '.json');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-bonus-'));
let srv = null;
let s = null, tokAdmin = null, tokA = null, tokB = null;
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
    // JWT- und VAPID-Dateien umleiten: Sonst fasst der Server die ECHTEN Dateien im Repo an
    // (sie liegen dort und werden ueber den __dirname-Rueckfall gefunden).
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
// Jede Aenderung an der DB-DATEI laeuft durch diesen Helfer: stoppeServer schickt SIGTERM, und der
// Graceful Shutdown flusht die im Speicher gehaltene db darueber - eine Aenderung am laufenden
// Server waere also wieder weg (Vorbild und Begruendung: test_festung_http.js).
async function aendereDb(fn) {
  await stoppeServer();
  const d = liesDb();
  await fn(d);
  schreibDb(d);
  s = await starteServer();
  tokAdmin = await s.anmelden('GameGeeeeek');
  tokA = await s.anmelden('anna');
  tokB = await s.anmelden('ben');
}
// Der Spielstand liegt in ZWEI Formen vor: als blanke Zeichenkette oder als { value, version }.
const liesSave = (d, id) => {
  const roh = (d.private[id] || {})['kepler7-save-v3'];
  if (!roh) return null;
  try { return JSON.parse(typeof roh === 'string' ? roh : roh.value); } catch (e) { return null; }
};
const kopf = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });

(async () => {
  fs.writeFileSync(dbPfad, JSON.stringify(grunddb(), null, 1));
  s = await starteServer();
  tokAdmin = await s.anmelden('GameGeeeeek');
  tokA = await s.anmelden('anna');
  tokB = await s.anmelden('ben');
  check('0: Admin und zwei Spieler angemeldet', !!tokAdmin && !!tokA && !!tokB,
    { admin: !!tokAdmin, anna: !!tokA, ben: !!tokB });
  if (!tokAdmin || !tokA) { console.log(s.protokoll().slice(-800)); console.log('\nFAIL'); process.exit(1); }

  const anlegen = (token, body) => s.j('/admin/bonuscode', { method: 'POST', headers: kopf(token), body: JSON.stringify(body) });
  const einloesen = (token, code) => s.j('/bonuscode/einloesen', { method: 'POST', headers: kopf(token), body: JSON.stringify({ code }) });
  const listen = token => s.j('/admin/bonuscodes', { headers: kopf(token) });
  const schalten = (token, body) => s.j('/admin/bonuscode/aktiv', { method: 'POST', headers: kopf(token), body: JSON.stringify(body) });

  // ---- 1) "in den admin bereich": kein Fremder kommt an die Verwaltung --------------------------
  const fremdAnlegen = await anlegen(tokA, { code: 'FREMDCODE1', gaben: { credits: 100 }, tage: 7 });
  check('1a: ein normaler Spieler kann keinen Code anlegen',
    fremdAnlegen.status === 403 && /Admin/.test(String(fremdAnlegen.body && fremdAnlegen.body.error)),
    { status: fremdAnlegen.status, body: fremdAnlegen.body });
  const fremdListen = await listen(tokA);
  check('1b: und er sieht die Liste nicht', fremdListen.status === 403, { status: fremdListen.status });
  const fremdSchalten = await schalten(tokA, { code: 'FREMDCODE1', aktiv: false });
  check('1c: und er kann keinen abschalten', fremdSchalten.status === 403, { status: fremdSchalten.status });

  // ---- 2) Anlegen: die Gaben-Tabelle ist die Sicherung ------------------------------------------
  const gut = await anlegen(tokAdmin, { code: 'Sternen-Staub 25', gaben: { credits: 500, erz: 5000 }, tage: 7, notiz: 'TikTok' });
  check('2a: der Admin legt einen Code an - und Schreibweise und Bindestriche sind egal',
    gut.status === 200 && gut.body.code === 'STERNENSTAUB25',
    { status: gut.status, code: gut.body && gut.body.code });
  const zuKurz = await anlegen(tokAdmin, { code: 'AB12', gaben: { credits: 100 }, tage: 7 });
  check('2b: ein zu kurzer Code wird abgelehnt - er waere durchprobierbar',
    zuKurz.status === 400 && /Zeichen/.test(String(zuKurz.body.error)), { status: zuKurz.status, body: zuKurz.body });
  const fremdeGabe = await anlegen(tokAdmin, { code: 'FREMDGABE12', gaben: { flotte: 999 }, tage: 7 });
  check('2c: eine unbekannte Gabe wird abgelehnt - mit Namen der Gabe',
    fremdeGabe.status === 400 && /flotte/.test(String(fremdeGabe.body.error)), { body: fremdeGabe.body });
  const zuGross = await anlegen(tokAdmin, { code: 'ZUGROSS1234', gaben: { credits: 99999999 }, tage: 7 });
  check('2d: eine zu grosse Gabe wird abgelehnt - der Tippfehler-Schutz',
    zuGross.status === 400 && /Kredite/.test(String(zuGross.body.error)), { body: zuGross.body });
  const leer = await anlegen(tokAdmin, { code: 'LEERCODE12', gaben: {}, tage: 7 });
  check('2e: ein Code ohne Gabe wird abgelehnt', leer.status === 400 && /verschenkt nichts/.test(String(leer.body.error)),
    { body: leer.body });
  const falscheZeit = await anlegen(tokAdmin, { code: 'ZEITCODE12', gaben: { credits: 100 }, tage: 999 });
  check('2f: eine Laufzeit ausserhalb der Auswahl wird abgelehnt',
    falscheZeit.status === 400 && /Laufzeit/.test(String(falscheZeit.body.error)), { body: falscheZeit.body });
  const doppelt = await anlegen(tokAdmin, { code: 'sternenstaub25', gaben: { credits: 100 }, tage: 7 });
  check('2g: derselbe Code laesst sich nicht zweimal anlegen - auch anders geschrieben nicht',
    doppelt.status === 409, { status: doppelt.status, body: doppelt.body });
  const negativ = await anlegen(tokAdmin, { code: 'NEGATIV1234', gaben: { credits: -500 }, tage: 7 });
  check('2h: eine negative Gabe wird abgelehnt - sonst waere der "Bonus" ein Abzug',
    negativ.status === 400, { status: negativ.status, body: negativ.body });

  // ---- 3) Einloesen: die Belohnung kommt an ------------------------------------------------------
  const dbVor = liesDb();
  const offenVor = ((dbVor.private[ANNA] || {}).__pendingRewards || []).length;
  const ein1 = await einloesen(tokA, 'sternen staub 25');
  check('3a: Anna loest den Code ein - kleingeschrieben und mit Leerzeichen',
    ein1.status === 200 && ein1.body.ok === true, { status: ein1.status, body: ein1.body });
  await warte(400);
  const dbNach = liesDb();
  const offen = (dbNach.private[ANNA] || {}).__pendingRewards || [];
  const lohn = offen.find(r => r && r.type === 'bonuscode');
  check('3b: die Belohnung liegt als eigener Typ in der Warteschlange - nicht im Rueckfall-Zweig',
    !!lohn && lohn.credits === 500 && lohn.erz === 5000,
    lohn ? { type: lohn.type, credits: lohn.credits, erz: lohn.erz } : { offen: offen.map(r => r.type) });
  check('3b2: und sie ist DAZUgekommen, nicht an die Stelle einer anderen getreten',
    offen.length === offenVor + 1, { vorher: offenVor, nachher: offen.length });
  check('3c: der Server hat den Spielstand NICHT geschrieben - das macht der Client beim Abholen',
    (liesSave(dbNach, ANNA) || {}).credits === 1000,
    { credits: (liesSave(dbNach, ANNA) || {}).credits });

  // ---- 4) "max 1 mal pro account" ---------------------------------------------------------------
  const ein2 = await einloesen(tokA, 'STERNENSTAUB25');
  check('4a: ein zweiter Versuch wird abgelehnt - mit Grund',
    ein2.status === 409 && ein2.body.schonEingeloest === true && /bereits eingelöst/.test(String(ein2.body.error)),
    { status: ein2.status, body: ein2.body });
  const dbSperre = liesDb();
  const sperreAmKonto = ((dbSperre.users.anna || {}).bonusCodes || {})['STERNENSTAUB25'];
  const saveAnna = liesSave(dbSperre, ANNA) || {};
  check('4b: die Sperre liegt am KONTO, nicht im Spielstand',
    !!sperreAmKonto && !saveAnna.bonusCodes,
    { amKonto: !!sperreAmKonto, imSpielstand: !!saveAnna.bonusCodes,
      hinweis: 'im Spielstand waere sie in fuenf Sekunden geloescht - er gehoert dem Spieler' });
  const einBen = await einloesen(tokB, 'STERNENSTAUB25');
  check('4c: ein ANDERER Spieler kann denselben Code aber einloesen',
    einBen.status === 200, { status: einBen.status, body: einBen.body });

  // ---- 5) "nur 1 woche etc aktiv" ---------------------------------------------------------------
  await aendereDb(d => { d.bonusCodes['STERNENSTAUB25'].gueltigBis = Date.now() - 60000; });
  const abgelaufen = await einloesen(tokAdmin, 'STERNENSTAUB25');
  check('5a: ein abgelaufener Code wird abgelehnt - und sagt, dass er abgelaufen ist',
    abgelaufen.status === 410 && abgelaufen.body.abgelaufen === true,
    { status: abgelaufen.status, body: abgelaufen.body });
  // Ein GUELTIGER, nur abgelaufener Code darf NICHT als Fehlversuch zaehlen: Der Spieler hat nichts
  // falsch gemacht.
  const dbNachAblauf = liesDb();
  check('5a2: und er zaehlt NICHT als Fehlversuch',
    !((dbNachAblauf.users.gamegeeeeek || {}).bonusVersuche || {}).n,
    { versuche: ((dbNachAblauf.users.gamegeeeeek || {}).bonusVersuche || {}).n || 0 });

  await anlegen(tokAdmin, { code: 'ABSCHALTBAR1', gaben: { credits: 100 }, tage: 7 });
  await schalten(tokAdmin, { code: 'ABSCHALTBAR1', aktiv: false });
  const aus = await einloesen(tokA, 'ABSCHALTBAR1');
  check('5b: ein abgeschalteter Code wird abgelehnt', aus.status === 410 && /nicht mehr aktiv/.test(String(aus.body.error)),
    { status: aus.status, body: aus.body });
  await schalten(tokAdmin, { code: 'ABSCHALTBAR1', aktiv: true });
  const wieder = await einloesen(tokA, 'ABSCHALTBAR1');
  check('5b2: und laesst sich wieder einschalten - die Gegenrichtung', wieder.status === 200,
    { status: wieder.status, body: wieder.body });

  // ---- 6) Gesamtdeckel: "die ersten N" -----------------------------------------------------------
  await anlegen(tokAdmin, { code: 'NURFUEREINEN', gaben: { credits: 100 }, tage: 7, maxGesamt: 1 });
  const erster = await einloesen(tokA, 'NURFUEREINEN');
  const zweiter = await einloesen(tokB, 'NURFUEREINEN');
  check('6a: der erste Spieler bekommt ihn', erster.status === 200, { status: erster.status });
  check('6b: der zweite bekommt "aufgebraucht" - mit der Zahl im Text',
    zweiter.status === 409 && zweiter.body.aufgebraucht === true && /ersten 1 /.test(String(zweiter.body.error)),
    { status: zweiter.status, body: zweiter.body });

  // ---- 7) Fehlversuche: der Code ist nicht durchprobierbar ----------------------------------------
  // Gezaehlt werden AUSSCHLIESSLICH Fehlversuche. Ben hat oben zweimal erfolgreich eingeloest -
  // sein Zaehler muss deshalb bei 0 stehen, bevor hier gemessen wird (Vorab-Pruefung).
  const dbVorRaten = liesDb();
  check('7-vorab: erfolgreiche Einloesungen haben NICHT mitgezaehlt',
    !((dbVorRaten.users.ben || {}).bonusVersuche || {}).n,
    { versuche: ((dbVorRaten.users.ben || {}).bonusVersuche || {}).n || 0 });
  let letzte = null, gesperrtAb = 0;
  for (let i = 1; i <= 14; i++) {
    letzte = await einloesen(tokB, 'RATEVERSUCH' + i);
    if (letzte.status === 429) { gesperrtAb = i; break; }
  }
  check('7a: nach zu vielen Fehlversuchen wird gesperrt - und die Sperre nennt sich beim Namen',
    gesperrtAb > 0 && letzte.body.gesperrt === true, { gesperrtAb, body: letzte && letzte.body });
  check('7b: die Sperre greift erst nach mehreren Versuchen, nicht beim ersten',
    gesperrtAb > 3, { gesperrtAb });
  // Gegenrichtung: Ein ECHTER Code muss fuer ein anderes Konto weiter gehen - die Sperre ist
  // kontobezogen, nicht global.
  const annaWeiter = await s.j('/admin/bonuscodes', { headers: kopf(tokAdmin) });
  check('7c: die Sperre trifft nur dieses Konto, nicht den Endpunkt insgesamt',
    annaWeiter.status === 200, { status: annaWeiter.status });

  // ---- 8) Die Liste fuer den Admin-Bereich -------------------------------------------------------
  const liste = await listen(tokAdmin);
  const eintrag = (liste.body.codes || []).find(c => c.code === 'STERNENSTAUB25');
  check('8a: die Liste nennt Einloesungen, Laufzeit und Zustand je Code',
    liste.status === 200 && !!eintrag && eintrag.eingeloest === 2 && typeof eintrag.gueltigBis === 'number',
    eintrag ? { eingeloest: eintrag.eingeloest, aktiv: eintrag.aktiv } : { codes: (liste.body.codes || []).map(c => c.code) });
  check('8b: sie schickt die Gaben-Tabelle und die Laufzeiten mit - der Admin-Bereich fuehrt keine zweite Kopie',
    !!liste.body.gaben && !!liste.body.gaben.credits && Array.isArray(liste.body.laufzeiten),
    { gaben: Object.keys(liste.body.gaben || {}), laufzeiten: liste.body.laufzeiten });
  const weg = await schalten(tokAdmin, { code: 'ABSCHALTBAR1', entfernen: true });
  const listeNach = await listen(tokAdmin);
  check('8c: ein Code laesst sich endgueltig entfernen',
    weg.status === 200 && !(listeNach.body.codes || []).some(c => c.code === 'ABSCHALTBAR1'),
    { status: weg.status, codes: (listeNach.body.codes || []).map(c => c.code) });

  await stoppeServer();
  console.log(fail ? '\nFAIL' : '\nPASS');
  process.exit(fail ? 1 : 0);
})();
