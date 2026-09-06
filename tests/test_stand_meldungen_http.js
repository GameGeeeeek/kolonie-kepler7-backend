// Eine Ablehnung, die zwei Ursachen zusammenfasst, ist keine Diagnose (05.09.2026).
//
// DER ANLASS: Spieler-Report Hanson im Global-Chat, "warum kann man Energie volles Lager
// mehrmals verkaufen FEHLER". Diese Routen urteilen ueber den GESPEICHERTEN Spielstand
// (getSaveValue), der Client speichert aber nur alle 10 Sekunden. "Nicht genug Energie zum
// Verkaufen" hiess damit zweierlei:
//   (a) der Spieler hat es wirklich nicht, oder
//   (b) er hat es, und der gespeicherte Stand ist aelter als das, was er auf dem Bildschirm sieht.
// Weder er noch der, der seinen Report liest, konnte die Faelle auseinanderhalten. Jede dieser
// Ablehnungen nennt jetzt die Zahl, die der Server TATSAECHLICH gesehen hat.
//
// Das Frontend speichert seit v8.689.0 vor jedem Handel und laesst den Fall gar nicht erst
// entstehen. Diese Meldungen sind die ZWEITE Sicherung - fuer aeltere Clients, fuer
// Fremdaufrufe und fuer den Tag, an dem jemand das Speichern dort wieder herausnimmt. Genau
// deshalb braucht sie einen eigenen Waechter: Sie hat im Normalbetrieb keinen Anlassfall mehr,
// an dem ein Mensch ihr Verschwinden bemerken wuerde.
//
//   DB=$(mktemp /tmp/kepler-standmeld-XXXX.json); rm -f "$DB"
//   DB_FILE=$DB PORT=3270 JWT_SECRET=test node server.js &
//   node tests/test_stand_meldungen_http.js
//
// GEPRUEFT WIRD (alle vier Ablehnungen, die ueber den gespeicherten Stand urteilen):
//   1. Marktverkauf ohne Bestand: nennt den gesehenen Bestand UND die verlangte Menge.
//   2. Marktkauf ohne Kredite: nennt den gesehenen Kreditstand UND die Kosten.
//   3. Modulboerse einstellen ohne Modul: nennt den 10-Sekunden-Takt als moegliche Ursache.
//   4. Modulboerse kaufen ohne Kredite: nennt den gesehenen Kreditstand UND den Preis.
//   5. GEGENRICHTUNG - die Ablehnung mutiert nichts: Ressourcen und Kredite stehen danach
//      unveraendert da. Eine Meldung zu verbessern darf keinen Nebeneffekt haben.
//   6. GEGENRICHTUNG - ein GUELTIGER Verkauf geht weiterhin durch und traegt KEINEN Hinweis.
//      Ohne diese Pruefung waere 1-4 auch dann gruen, wenn der Hinweis faelschlich an jeder
//      Antwort haengt.
//
// GEGENPROBE (Regel: beide Richtungen), gefahren gegen origin/master vor dieser Aenderung:
// Ergebnis am Dateiende.
const http = require('http');
const fs = require('fs');
const PORT = process.env.TEST_PORT || 3270;   // 3261-3265 sind belegt (gemessen), 3270 ist frei
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

const NUTZER = 'standmelder';
const VERKAEUFER = 'standmelderzwei';   // Testkonten nur mit Kleinbuchstaben (CLAUDE.md)
const PASS = 'geheim-123';

async function konto(name) {
  await anfrage('POST', '/api/register', null, { username: name, password: PASS, email: name + '@example.invalid' });
  await new Promise(r => setTimeout(r, 700));
  const db = JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8'));
  const u = db.users[name];
  const eintrag = Object.entries(db.verifyTokens || {}).find(([, v]) => u && v.userId === u.userId);
  if (eintrag) await anfrage('POST', '/api/verify-email', null, { token: eintrag[0] });
  const login = await anfrage('POST', '/api/login', null, { username: name, password: PASS });
  return login.body && login.body.token;
}

// Bewusst KARG: wenig Energie, wenige Kredite, kein Modul - jede der vier Ablehnungen soll
// ausgeloest werden koennen. Die Zahlen stehen hier, damit die Pruefungen sie WIEDERFINDEN
// koennen; verglichen wird gegen die Antwort, nicht gegen eine eingetippte Erwartung.
const ENERGIE = 500;
const KREDITE = 10;
const save = {
  resources: { erz: 1000, kristalle: 1000, deuterium: 1000, energie: ENERGIE, antimaterie: 0, forschungspunkte: 0 },
  credits: KREDITE, buildings: { lager: 20 }, research: {}, fleet: {}, colonies: {}, modules: {}, shipModules: {}
};

const stand = async (token) => {
  const r = await anfrage('GET', '/api/storage/kepler7-save-v3', token, null);
  try { return JSON.parse(r.body.value); } catch (e) { return null; }
};
// Der gemeinsame Hinweis ist EINE Konstante im Server; hier wird nur sein Kern gesucht,
// nicht der Wortlaut - sonst waere jede Umformulierung ein roter Test ohne Befund.
const nenntTakt = (t) => /10 Sekunden/.test(t || '');

(async () => {
  const token = await konto(NUTZER);
  check('0-vorab: Konto steht', !!token);
  await anfrage('PUT', '/api/storage/kepler7-save-v3', token, { value: JSON.stringify(save) });
  const vorher = await stand(token);
  check('0-vorab2: der Spielstand liegt wie gesetzt', vorher && vorher.resources.energie === ENERGIE && vorher.credits === KREDITE,
    { energie: vorher && vorher.resources.energie, credits: vorher && vorher.credits });

  // ---- 1) Marktverkauf ohne Bestand -----------------------------------------------------
  const zuViel = ENERGIE + 1000;
  const v = await anfrage('POST', '/api/market/trade', token, { action: 'sell', resource: 'energie', amount: zuViel });
  const vTxt = v.body && v.body.error;
  check('1a: der Verkauf prallt ab', v.status === 400, { status: v.status });
  check('1b: die Ablehnung nennt den GESEHENEN Bestand und die verlangte Menge',
    !!vTxt && vTxt.includes(ENERGIE.toLocaleString('de-DE')) && vTxt.includes(zuViel.toLocaleString('de-DE')), vTxt);
  check('1c: und den 10-Sekunden-Takt als moegliche Ursache', nenntTakt(vTxt), vTxt);

  // ---- 2) Marktkauf ohne Kredite ---------------------------------------------------------
  const k = await anfrage('POST', '/api/market/trade', token, { action: 'buy', resource: 'erz', amount: 100000 });
  const kTxt = k.body && k.body.error;
  check('2a: der Kauf prallt ab', k.status === 400, { status: k.status });
  check('2b: die Ablehnung nennt den GESEHENEN Kreditstand',
    !!kTxt && kTxt.includes(KREDITE.toLocaleString('de-DE')) && nenntTakt(kTxt), kTxt);

  // ---- 3) Modulboerse: einstellen ohne Modul ---------------------------------------------
  /* Der Schluessel MUSS zu MODULE_INSTKEY_RE passen, sonst steigt die Route eine Zeile
     frueher mit "Ungueltiger Modulschluessel" aus - und die Pruefung waere gruen aus dem
     FALSCHEN Grund (im ersten Anlauf genau so passiert, gemessen). Deshalb wird das Format
     hier aus dem Server ABGELESEN und der Schluessel dagegen geprueft, statt ihn zu raten. */
  const RE_QUELLE = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8')
    .match(/const MODULE_INSTKEY_RE = (\/.*\/);/);
  const RE = RE_QUELLE ? eval(RE_QUELLE[1]) : null;
  const MODUL = 'produktion:epic:3';
  check('3-vorab: der Testschluessel passt zum Format des Servers - sonst misst 3 nichts',
    !!RE && RE.test(MODUL), { regex: RE_QUELLE && RE_QUELLE[1], schluessel: MODUL });
  const m = await anfrage('POST', '/api/modulemarket/list', token, { isShip: false, instKey: MODUL, price: 2000 });
  const mTxt = m.body && m.body.error;
  check('3a: das Einstellen prallt am INVENTAR ab, nicht am Format',
    m.status === 400 && /Inventar/.test(mTxt || ''), { status: m.status, txt: mTxt });
  check('3b: die Ablehnung nennt den 10-Sekunden-Takt als moegliche Ursache', nenntTakt(mTxt), mTxt);

  // ---- 4) Modulboerse: kaufen ohne Kredite ------------------------------------------------
  /* HIER STAND EIN TEST, DER SICH IMMER SELBST UEBERSPRANG (Codex-Durchsicht 06.09.2026).
     Er suchte ein fremdes Angebot ueber `l.sellerId !== undefined`. publicListing() liefert
     sellerId aber BEWUSST nicht mit - nur `mine`. Das Praedikat war damit fuer JEDES Angebot
     falsch, der Zweig lief IMMER in den "uebersprungen"-Ausgang, und der druckte eine gruene
     Zeile. Die Begruendung daneben ("per Quelltext identisch zu 2") liess das begruendet
     aussehen, war aber eine Ausrede fuer eine Pruefung, die nie stattfand.
     Jetzt wird ein echtes fremdes Angebot ERZEUGT: zweites Konto, Modul im Inventar,
     eingestellt - und ueber das ausgelieferte Feld `mine === false` ausgewaehlt. */
  const tokenB = await konto(VERKAEUFER);
  check('4-vorab: das zweite Konto steht', !!tokenB);
  const saveB = { resources: {}, credits: 0, buildings: {}, research: {}, fleet: {}, colonies: {},
    modules: { [MODUL]: 1 }, shipModules: {} };
  await anfrage('PUT', '/api/storage/kepler7-save-v3', tokenB, { value: JSON.stringify(saveB) });
  const eingestellt = await anfrage('POST', '/api/modulemarket/list', tokenB,
    { isShip: false, instKey: MODUL, price: 2000 });
  check('4-vorab2: das fremde Angebot steht wirklich in der Boerse',
    eingestellt.status === 200 && eingestellt.body && eingestellt.body.ok,
    { status: eingestellt.status, error: eingestellt.body && eingestellt.body.error });

  const boerse = await anfrage('GET', '/api/modulemarket', token, null);
  const fremd = ((boerse.body && boerse.body.listings) || []).find(l => l.mine === false);
  check('4-vorab3: aus Sicht des ersten Kontos ist es ein FREMDES Angebot',
    !!fremd, { listings: (boerse.body && boerse.body.listings) || [] });
  const b = await anfrage('POST', '/api/modulemarket/buy', token, { id: fremd && fremd.id });
  const bTxt = b.body && b.body.error;
  check('4: der Modulkauf nennt den gesehenen Kreditstand UND den Preis',
    b.status === 400 && !!bTxt && bTxt.includes(KREDITE.toLocaleString('de-DE'))
      && bTxt.includes((2000).toLocaleString('de-DE')) && nenntTakt(bTxt), bTxt);

  // ---- 5) GEGENRICHTUNG: die Ablehnungen mutieren nichts ----------------------------------
  const nachher = await stand(token);
  check('5: nach vier Ablehnungen steht der Spielstand unveraendert da',
    nachher && nachher.resources.energie === ENERGIE && nachher.credits === KREDITE,
    { energie: nachher && nachher.resources.energie, credits: nachher && nachher.credits });

  // ---- 6) GEGENRICHTUNG: ein gueltiger Verkauf traegt KEINEN Hinweis ----------------------
  // Ohne diese Pruefung waeren 1-4 auch dann gruen, wenn der Hinweis faelschlich an JEDER
  // Antwort haengt - dann waere er keine Diagnose mehr, sondern Rauschen.
  const gut = await anfrage('POST', '/api/market/trade', token, { action: 'sell', resource: 'energie', amount: 100 });
  check('6a: ein gueltiger Verkauf geht durch', gut.status === 200 && gut.body && gut.body.ok,
    { status: gut.status, error: gut.body && gut.body.error });
  check('6b: und traegt keine Fehlermeldung mit dem Hinweis', !gut.body.error, gut.body && gut.body.error);

  console.log(fehl ? '\nFAIL' : '\nPASS');
  process.exit(fehl);
})();

/* GEGENPROBE, GEMESSEN am 06.09.2026 gegen origin/master (ea6e27e):
   `git show origin/master:server.js > server.alt.js` im SELBEN Ordner (damit node_modules und
   require('./mailer') aufloesen), auf einem eigenen Port gestartet, danach wieder geloescht.
   ES FALLEN FUENF: 1b, 1c, 2b, 3b und 4 - die alten Meldungen lauten
     "Nicht genug energie zum Verkaufen."
     "Nicht genug Kredite."
     "Dieses Modul liegt nicht (mehr) in deinem Inventar. Ausgeruestete Module musst du erst abnehmen."
     "Nicht genug Kredite (2000 noetig)."
   und nennen weder den gesehenen Stand noch den Takt.
   GRUEN bleiben 1a, 2a, 3-vorab, 3a, die 4-vorab-Schritte, 5, 6a und 6b - Absicht: Die
   Ablehnungen selbst waren nie falsch, nur ihre AUSKUNFT. 5 und 6 belegen zusaetzlich, dass
   diese Aenderung nichts mutiert und den Hinweis nicht an gueltige Antworten haengt.

   VORHER FIELEN NUR VIER. Pruefung 4 konnte gar nicht fallen: Sie suchte ein fremdes Angebot
   ueber `l.sellerId !== undefined`, und publicListing() liefert sellerId bewusst nicht mit.
   Das Praedikat war fuer JEDES Angebot falsch, der Zweig lief immer in den
   "uebersprungen"-Ausgang - und der druckte eine gruene Zeile mit einer Begruendung, die das
   begruendet aussehen liess. Gefunden hat es die Codex-Durchsicht, nicht der eigene Lauf.
   Seit sie ein echtes fremdes Angebot ERZEUGT (zweites Konto, Modul im Inventar, eingestellt,
   ueber `mine === false` ausgewaehlt), misst sie den Zweig wirklich - und faellt am alten
   Stand mit. */
