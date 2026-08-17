// Tagesumsatz-Deckel des Marktes: 5 Mio Credits Verkaufserloes je Konto und UTC-Tag
// (17.08.2026, Auftrag Sascha - Anlass und Rechnung stehen bei MARKT_TAGES_ERLOES_MAX).
//
// DER ERSTE HTTP-TEST FUER /api/market ueberhaupt in diesem Repo. Muster wie
// test_sternenstaub_http.js: Der Server wird EXTERN im selben Bash-Aufruf gestartet (die Sandbox
// verliert Hintergrundprozesse ueber Tool-Aufrufe hinweg), ZWEI Starts auf DERSELBEN DB, und der
// Tageswechsel wird zwischen den Starts per node -e direkt in der DB rueckdatiert - nicht per
// Date-Mock (Regel 18-Familie: nie ein Messwerkzeug, das das Spiel kuenstlich heilt).
//
//   DB=$(mktemp /tmp/kepler-marktdeckel-XXXX.json); rm -f "$DB"
//   DB_FILE=$DB PORT=3217 JWT_SECRET=test node server.js &   # Start 1
//   node tests/test_marktdeckel_http.js teil1
//   kill %1; node -e '<stempel auf gestern>'                 # Tageswechsel
//   DB_FILE=$DB PORT=3217 JWT_SECRET=test node server.js &   # Start 2
//   node tests/test_marktdeckel_http.js teil2
//
// GEPRUEFT WIRD:
//   teil1:
//   1. Ein Verkauf unter dem Deckel geht durch, die Antwort nennt tagesRest (und der sinkt).
//   2. Der Zaehler SUMMIERT ueber mehrere Verkaeufe - nicht nur der einzelne Trade zaehlt.
//   3. Ein Verkauf, dessen Erloes das Restkontingent uebersteigt, wird mit 400 abgelehnt -
//      UND laesst den Spielstand vollstaendig unangetastet (Ressourcen wie Credits). Eine
//      Ablehnung, die trotzdem mutiert, waere schlimmer als keine Pruefung.
//   4. Der Fehlertext nennt die Zahlen und das Feld tagesRest (Regel 37: der Grund gehoert in
//      die Antwort, nicht in eine spaetere Sitzung).
//   5. KAEUFE bleiben am erschoepften Deckel frei - er zaehlt nur Verkaufserloese.
//   6. GET /api/market traegt tagesRest/tagesMax fuer die Anzeige.
//   teil2 (nach Tageswechsel):
//   7. Das Kontingent ist frisch - derselbe Verkauf, der eben abprallte, geht wieder durch.
//
// GEGENPROBE (Regel 1, gefahren am 17.08.2026 gegen den alten server.js - git show
// origin/master:server.js > server.alt.js im SELBEN Ordner, damit node_modules aufloest):
// teil1 faellt mit 4 Fehlschlaegen - 6 und 1/2 (kein tagesRest-Feld) und 4 (der Fehlertext nennt
// kein Tageskontingent). LEHRREICH: 3-vorab und 3 blieben dort aus dem FALSCHEN Grund gruen -
// die 40er-Schleife leerte schlicht den Antimaterie-Bestand, und der 400 kam vom "Nicht
// genug"-Zweig statt vom Deckel (gemessen: amVorher 0). Genau dafuer steht Pruefung 4 daneben:
// Sie verlangt den GRUND im Fehlertext, nicht nur den Statuscode (Regel 28). Ohne sie saehe die
// Gegenprobe staerker aus, als sie ist.
const http = require('http');
const PORT = process.env.TEST_PORT || 3217;   // 3198/3200-3216 grenzen an belegte Ports (Regel 29)
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

// Erz zum Basispreis 2,0: eine 1-Mio-Tranche drueckt den Preis sofort auf den Boden 0,30 und
// bringt ~165k-175k Credits. Der Deckel (5 Mio) ist damit nach ~30 Tranchen erreicht - zu viele
// fuer einen Test. Der Spielstand bekommt deshalb ANTIMATERIE (Basispreis 24,0): Eine 1-Mio-
// Tranche bringt dort ein Vielfaches, der Deckel faellt nach wenigen Anfragen. Die Zahlen werden
// trotzdem nirgends eingetippt, sondern aus den Antworten GEMESSEN (Regel 2).
const NUTZER = 'marktdeckeltester';
const PASS = 'geheim-123';

async function konto() {
  /* Register verlangt eine E-Mail und schaltet das Konto erst nach der Bestaetigung frei - der
     Bestaetigungs-Token wird wie in test_sternenstaub_http.js direkt aus der DB-Datei gelesen
     (db.verifyTokens) und an /api/verify-email gegeben. Ohne diesen Schritt antwortet /api/login
     mit "Unbekannter Name" und der ganze Test misst nichts (genau so beim ersten Anlauf passiert;
     Regel 37: die Vorab-Pruefung 0 meldet es). */
  const fs = require('fs');
  await anfrage('POST', '/api/register', null, { username: NUTZER, password: PASS, email: 'md@example.invalid' });
  await new Promise(r => setTimeout(r, 700));
  const db = JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8'));
  const u = db.users[NUTZER];
  const eintrag = Object.entries(db.verifyTokens || {}).find(([, v]) => u && v.userId === u.userId);
  if (eintrag) await anfrage('POST', '/api/verify-email', null, { token: eintrag[0] });
  const login = await anfrage('POST', '/api/login', null, { username: NUTZER, password: PASS });
  const token = login.body && login.body.token;
  // Spielstand mit viel Antimaterie und wenig Krediten anlegen - ueber die normale Storage-Route,
  // wie es der Client taete.
  const save = {
    resources: { erz: 5e6, kristalle: 1e6, deuterium: 1e6, energie: 1e6, antimaterie: 5e6, forschungspunkte: 1000 },
    credits: 1000, buildings: { lager: 60 }, research: {}, fleet: {}, colonies: {}
  };
  await anfrage('PUT', '/api/storage/kepler7-save-v3', token, { value: JSON.stringify(save) });
  return token;
}
const stand = async (token) => {
  const r = await anfrage('GET', '/api/storage/kepler7-save-v3', token, null);
  try { return JSON.parse(r.body.value); } catch (e) { return null; }
};

(async () => {
  const teil = process.argv[2] || 'teil1';

  if (teil === 'teil1') {
    const token = await konto();
    check('0-vorab: Konto und Spielstand stehen', !!token);

    // ---- 6) GET /api/market traegt das Kontingent ---------------------------------------------
    const markt = await anfrage('GET', '/api/market', token, null);
    check('6: GET /api/market nennt tagesRest und tagesMax',
      markt.status === 200 && typeof markt.body.tagesRest === 'number' && markt.body.tagesMax > 0,
      { status: markt.status, tagesRest: markt.body && markt.body.tagesRest, tagesMax: markt.body && markt.body.tagesMax });
    const MAX = (markt.body && markt.body.tagesMax) || 0;

    // ---- 1+2) Verkaeufe unter dem Deckel: tagesRest sinkt und summiert ------------------------
    const v1 = await anfrage('POST', '/api/market/trade', token, { action: 'sell', resource: 'antimaterie', amount: 1000000 });
    check('1: Verkauf unter dem Deckel geht durch und nennt tagesRest',
      v1.status === 200 && v1.body.ok && typeof v1.body.tagesRest === 'number' && v1.body.tagesRest === MAX - v1.body.credits,
      { status: v1.status, credits: v1.body && v1.body.credits, tagesRest: v1.body && v1.body.tagesRest });
    const v2 = await anfrage('POST', '/api/market/trade', token, { action: 'sell', resource: 'antimaterie', amount: 1000000 });
    check('2: der Zaehler summiert ueber mehrere Verkaeufe',
      v2.status === 200 && v2.body.ok && v2.body.tagesRest === MAX - v1.body.credits - v2.body.credits,
      { rest1: v1.body && v1.body.tagesRest, credits2: v2.body && v2.body.credits, rest2: v2.body && v2.body.tagesRest });

    // ---- 8) Routen-Erloese zaehlen in DENSELBEN Zaehler ---------------------------------------
    // (17.08.2026, Entscheidung Sascha). Steht bewusst VOR der Erschoepfungs-Schleife: Nur hier
    // laesst sich die exakte Arithmetik gegen den GEMESSENEN Stand pruefen (Regel 2) - nach der
    // Schleife ist der Zaehler am Anschlag und jede Addition verschwaende im Clamp.
    const RM = 250000;
    const r1 = await anfrage('POST', '/api/market/routen-erloes', token, { credits: RM });
    check('8a: eine Routen-Meldung senkt das Restkontingent um exakt den gemeldeten Betrag',
      r1.status === 200 && r1.body.ok && r1.body.tagesRest === v2.body.tagesRest - RM,
      { vorher: v2.body.tagesRest, gemeldet: RM, nachher: r1.body && r1.body.tagesRest });
    const rNull = await anfrage('POST', '/api/market/routen-erloes', token, { credits: 0 });
    const rNeg = await anfrage('POST', '/api/market/routen-erloes', token, { credits: -50 });
    const rRiesig = await anfrage('POST', '/api/market/routen-erloes', token, { credits: 99999999 });
    check('8b: 0, negativ und ueber dem Tagesmaximum prallen als 400 ab',
      rNull.status === 400 && rNeg.status === 400 && rRiesig.status === 400,
      { null: rNull.status, neg: rNeg.status, riesig: rRiesig.status });
    // Der Beleg fuer den GETEILTEN Zaehler: Ein direkter Verkauf direkt nach der Meldung muss
    // vom gemeldeten Stand aus weiterrechnen - nicht von dem, den v2 zuletzt sah.
    const v3 = await anfrage('POST', '/api/market/trade', token, { action: 'sell', resource: 'antimaterie', amount: 100000 });
    check('8c: ein direkter Verkauf rechnet vom gemeldeten Stand aus weiter (ein Zaehler, zwei Quellen)',
      v3.status === 200 && v3.body.ok && v3.body.tagesRest === r1.body.tagesRest - v3.body.credits,
      { nachMeldung: r1.body && r1.body.tagesRest, verkaufsErloes: v3.body && v3.body.credits, danach: v3.body && v3.body.tagesRest });

    // ---- 3+4) Der Deckel greift, und die Ablehnung mutiert NICHTS -----------------------------
    // Weiterverkaufen, bis eine Tranche abprallt (Sicherheitsgrenze 40 Anfragen, weit ueber dem
    // rechnerischen Bedarf - laeuft sie leer, meldet 3-vorab das ausdruecklich statt still gruen
    // zu sein, Regel 37).
    let abgelehnt = null, letzterRest = (v3.body && v3.body.tagesRest) || (r1.body && r1.body.tagesRest) || v2.body.tagesRest;
    for (let i = 0; i < 40 && !abgelehnt; i++) {
      const v = await anfrage('POST', '/api/market/trade', token, { action: 'sell', resource: 'antimaterie', amount: 1000000 });
      if (v.status === 400) abgelehnt = v; else letzterRest = v.body && v.body.tagesRest;
    }
    check('3-vorab: eine Tranche ist am Deckel abgeprallt', !!abgelehnt, { letzterRest });
    if (abgelehnt) {
      const vorher = await stand(token);
      const nochmal = await anfrage('POST', '/api/market/trade', token, { action: 'sell', resource: 'antimaterie', amount: 1000000 });
      const nachher = await stand(token);
      check('3: die Ablehnung ist ein 400 und laesst den Spielstand unangetastet',
        nochmal.status === 400 && !!vorher && !!nachher
        && vorher.resources.antimaterie === nachher.resources.antimaterie
        && vorher.credits === nachher.credits,
        { status: nochmal.status, amVorher: vorher && vorher.resources.antimaterie, amNachher: nachher && nachher.resources.antimaterie });
      check('4: der Fehlertext nennt das Kontingent und die Antwort das Feld tagesRest',
        /Tageskontingent/.test(String(abgelehnt.body.error || '')) && typeof abgelehnt.body.tagesRest === 'number',
        { error: abgelehnt.body && abgelehnt.body.error, tagesRest: abgelehnt.body && abgelehnt.body.tagesRest });
    }

    // ---- 5) Kaeufe bleiben frei ---------------------------------------------------------------
    const kauf = await anfrage('POST', '/api/market/trade', token, { action: 'buy', resource: 'erz', amount: 100 });
    check('5: ein KAUF geht am erschoepften Verkaufs-Deckel vorbei (er zaehlt nur Erloese)',
      kauf.status === 200 && kauf.body.ok === true,
      { status: kauf.status, error: kauf.body && kauf.body.error });
    process.exit(fehl);
  }

  if (teil === 'teil2') {
    // Der Aufrufer hat zwischen den Serverstarts user.marktTag.stempel auf GESTERN rueckdatiert.
    const login = await anfrage('POST', '/api/login', null, { username: NUTZER, password: PASS });
    const token = login.body && login.body.token;
    check('7-vorab: Anmeldung nach dem Neustart', !!token);
    const markt = await anfrage('GET', '/api/market', token, null);
    check('7a: nach dem Tageswechsel ist das Kontingent frisch',
      markt.status === 200 && markt.body.tagesRest === markt.body.tagesMax,
      { tagesRest: markt.body && markt.body.tagesRest, tagesMax: markt.body && markt.body.tagesMax });
    const v = await anfrage('POST', '/api/market/trade', token, { action: 'sell', resource: 'antimaterie', amount: 1000000 });
    check('7b: derselbe Verkauf, der gestern abprallte, geht wieder durch',
      v.status === 200 && v.body.ok === true, { status: v.status, error: v.body && v.body.error });
    process.exit(fehl);
  }

  console.log('FAIL - unbekannter Teil: ' + teil);
  process.exit(1);
})();
