// Abmelden auf DIESEM Geraet, und die Cookie-Nachreichung fuer Bestandssitzungen
// (Sicherheits-Audit P3, Etappe b, 19.08.2026).
//
// WORUM ES GEHT
// -------------
// Etappe a hat das Sitzungs-Cookie eingefuehrt, aber niemand hat es benutzt: Das Frontend legte
// den Token weiter in localStorage und schickte ihn per Bearer. Etappe b dreht das um. Dabei
// entstehen zwei Loecher, die AUSSCHLIESSLICH der Server schliessen kann:
//
//   1. ABMELDEN. Ein HttpOnly-Cookie kann JavaScript nicht loeschen - das ist ja sein Zweck.
//      Ohne eine echte Route wuerde ein Klick auf "Abmelden" den localStorage-Rest wegraeumen,
//      neu laden, und das Cookie meldete den Spieler stillschweigend WIEDER AN. Ein Abmeldeknopf,
//      der nicht abmeldet, ist schlimmer als keiner.
//   2. BESTANDSSITZUNGEN. Wer sich zuletzt vor dem 19.08.2026 angemeldet hat, hat gar kein
//      Cookie - nur den Token in localStorage, also genau dort, wo die erste XSS-Luecke ihn
//      abholen wuerde. Das JWT laeuft 180 Tage; ohne Nachreichung braeuchte die Behebung fuer
//      diese Spieler ein halbes Jahr.
//
// WAS DIESER TEST NICHT MISST, und das gehoert dazugesagt: ob ein BROWSER das Cookie nach der
// Loeschanweisung wirklich fallen laesst. Hier wird die Cookie-Kopfzeile von Hand gesetzt, ein
// Browser ist nicht beteiligt. Geprueft wird deshalb der MECHANISMUS - dass die Loeschzeile
// dieselben Merkmale traegt wie die Setz-Zeile (1b). Das ist kein Schoenheitspunkt: Ein Browser
// ersetzt ein Cookie nur bei passendem Path; eine Loeschzeile mit abweichendem Path legt still
// ein ZWEITES Cookie an und laesst das echte stehen. Der Browser-Teil ist im Frontend-Repo
// gemessen (tests/test_sitzungscookie_front.js).
//
// AUSFUEHREN: npm install (einmalig), dann node tests/test_logout_cookie_http.js
//
// GEGENPROBE (19.08.2026, gegen den alten server.js: `git show origin/master:server.js >
// server.alt.js` im SELBEN Ordner, damit node_modules aufloest, dann TEST_SERVER gesetzt):
//   neuer Stand: 14 Pruefungen, 0 rot
//   alter Stand: 14 Pruefungen, 5 rot  (1, 1b, 2 - die Route fehlt und antwortet 404;
//                3, 3b - es wird nichts nachgereicht)
// Dieselben 14 an beiden Staenden (Frontend-Hausregel 34).
//
// ZWEI PRUEFUNGEN MUESSEN IN BEIDE RICHTUNGEN GRUEN SEIN, und das ist der Beleg statt eines
// Mangels: 6 (der Bearer-Weg funktioniert unveraendert) und 4/5 (es wird NICHT nachgereicht, wo
// es nicht soll). Bei einer additiven Aenderung heisst "richtig" ja gerade, dass sich fuer
// bestehende Clients nichts aendert - dieselbe Umkehrung wie in test_sitzungscookie_http.js.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
// 3195-3200 und 3210-3225 sind belegt (Arbeitsregel 29).
const PORT = Number(process.env.TEST_PORT || 3226);
const SERVERDATEI = process.env.TEST_SERVER || 'server.js';
const BASIS = 'http://127.0.0.1:' + PORT + '/api';

let fehl = false;
const check = (n, ok, x) => {
  console.log((ok ? 'OK   - ' : 'FAIL - ') + n + (x !== undefined ? ' | ' + JSON.stringify(x) : ''));
  if (!ok) fehl = true;
};
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');

const PASS = 'Vurm-Tal-92x';          // besteht die Passwort-Regeln aus #138
const A_ID = crypto.randomUUID();
const B_ID = crypto.randomUUID();

function db() {
  const hash = bcrypt.hashSync(PASS, 10);
  return {
    users: {
      anna: { userId: A_ID, username: 'anna', passwordHash: hash, email: 'a@example.invalid', emailVerified: true, createdAt: Date.now() },
      bert: { userId: B_ID, username: 'bert', passwordHash: hash, email: 'b@example.invalid', emailVerified: true, createdAt: Date.now() }
    },
    private: {}, shared: {}, resetTokens: {},
    galaxy: { npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {} }
  };
}

/** Liefert Status, Body UND die rohen Set-Cookie-Zeilen - die sind hier der Messgegenstand. */
async function ruf(pfad, { methode = 'GET', token = null, cookie = null, body = null } = {}) {
  const kopf = { 'Content-Type': 'application/json' };
  if (token) kopf.Authorization = 'Bearer ' + token;
  if (cookie) kopf.Cookie = cookie;
  try {
    const r = await fetch(BASIS + pfad, {
      method: methode, headers: kopf, body: body ? JSON.stringify(body) : undefined
    });
    let j = null; try { j = await r.json(); } catch (e) {}
    return { status: r.status, body: j || {}, setCookie: r.headers.getSetCookie ? r.headers.getSetCookie() : [] };
  } catch (e) { return { status: 0, body: { error: String(e) }, setCookie: [] }; }
}

const sidZeile = r => (r.setCookie || []).find(z => z.startsWith('kepler7_sid=')) || '';
const cookiePaar = zeile => String(zeile || '').split(';')[0];
/** Die Merkmale einer Set-Cookie-Zeile ohne Wert und ohne Frist - fuer den Vergleich in 1b. */
const merkmale = zeile => String(zeile || '').split(';').map(t => t.trim())
  .filter(t => t && !t.startsWith('kepler7_sid=') && !/^Max-Age=/i.test(t)).sort().join('; ');

async function lauf() {
  const dbPfad = path.join(os.tmpdir(), 'kepler-logoutcookie-' + process.pid + '.json');
  fs.writeFileSync(dbPfad, JSON.stringify(db(), null, 1));

  let log = '';
  // PUBLIC_URL wird bewusst NICHT ueberschrieben - `web-push` verlangt fuer das VAPID-Subject
  // zwingend https:/mailto: und laesst den Server sonst gar nicht erst starten.
  const srv = spawn(process.execPath, [path.join(WURZEL, SERVERDATEI)], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, {
      DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
  const ende = () => { try { srv.kill(); } catch (e) {} try { fs.unlinkSync(dbPfad); } catch (e) {} };
  process.on('exit', ende);

  let oben = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASIS + '/health'); if (r.ok) { oben = true; break; } } catch (e) {}
    await warte(250);
  }
  check('0-aufbau: der Server ist oben', oben, oben ? undefined : { log: log.slice(-400) });
  if (!oben) { ende(); return; }

  const loginA = await ruf('/login', { methode: 'POST', body: { username: 'anna', password: PASS } });
  const setzZeile = sidZeile(loginA);
  check('0b-aufbau: die Anmeldung gelingt und setzt ein Cookie',
    loginA.status === 200 && !!loginA.body.token && !!setzZeile,
    { status: loginA.status, error: loginA.body.error });
  if (!loginA.body.token) { ende(); return; }
  const tokenA = loginA.body.token;
  const cookieA = cookiePaar(setzZeile);

  // ---- 1: die Abmelde-Route gibt es, und sie weist den Browser an, das Cookie fallenzulassen --
  {
    const r = await ruf('/logout', { methode: 'POST', cookie: cookieA });
    const zeile = sidZeile(r);
    check('1: POST /api/logout antwortet und schickt eine Loeschanweisung',
      r.status === 200 && /^kepler7_sid=;/.test(zeile) && /Max-Age=0/.test(zeile),
      { status: r.status, zeile: zeile || '(keine)' });

    // Ein Browser ERSETZT ein Cookie nur bei passendem Path (und Domain). Weicht die Loeschzeile
    // ab, legt er stillschweigend ein ZWEITES an und laesst das echte stehen - die Abmeldung
    // saehe erfolgreich aus und waere keine. Deshalb wird hier gegen die SETZ-Zeile verglichen
    // und nicht gegen eine hier eingetippte Erwartung: Wer spaeter ein Merkmal am Setzen aendert,
    // faellt hier auf, statt es beim Abmelden zu merken.
    check('1b: sie traegt dieselben Merkmale wie die Setz-Zeile (sonst loescht der Browser nichts)',
      !!zeile && merkmale(zeile) === merkmale(setzZeile),
      { loeschen: merkmale(zeile), setzen: merkmale(setzZeile) });
  }

  // ---- 2: sie verlangt KEINE gueltige Anmeldung -----------------------------------------------
  // Das ist der Zweck und nicht eine Nachlaessigkeit: Wer ein Sitzungsgeheimnis loswerden will,
  // darf daran nicht scheitern, weil genau dieses Geheimnis abgelaufen oder unsinnig ist. Zu
  // holen gibt es nichts - die Route liest nichts und schreibt nichts.
  {
    const r = await ruf('/logout', { methode: 'POST', cookie: 'kepler7_sid=voelligerunsinn' });
    check('2: auch mit ungueltigem Cookie laesst sich abmelden (sonst bleibt man daran haengen)',
      r.status === 200 && /Max-Age=0/.test(sidZeile(r)),
      { status: r.status, error: r.body.error });
  }

  // ---- 3: Bestandssitzung - Bearer OHNE Cookie bekommt eines nachgereicht ---------------------
  {
    const r = await ruf('/me', { token: tokenA });
    const zeile = sidZeile(r);
    check('3: ein gueltiger Bearer ohne Cookie bekommt eines nachgereicht',
      r.status === 200 && !!zeile && !/^kepler7_sid=;/.test(zeile),
      { status: r.status, zeile: zeile || '(keine)' });

    // Eine Kopfzeile allein waere die Beschriftung, nicht die Wirkung (Frontend-Hausregel 61):
    // Das nachgereichte Cookie muss auch wirklich eine Anfrage tragen, sonst haette die Migration
    // den Spieler beim naechsten Laden abgemeldet.
    const r2 = await ruf('/me', { cookie: cookiePaar(zeile) });
    check('3b: das nachgereichte Cookie TRAEGT auch wirklich',
      r2.status === 200 && r2.body.username === 'anna',
      { status: r2.status, username: r2.body.username, error: r2.body.error });
  }

  // ---- 4: liegt schon ein Cookie an, wird NICHTS nachgereicht ---------------------------------
  // Die Gegenrichtung, und sie ist keine Formalie: Wuerde bedingungslos nachgereicht, koennte ein
  // alter Bearer-Rest das Cookie einer FRISCHEN Anmeldung ueberschreiben - der Spieler liefe beim
  // naechsten Laden unter der falschen Sitzung weiter.
  {
    const loginB = await ruf('/login', { methode: 'POST', body: { username: 'bert', password: PASS } });
    const cookieB = cookiePaar(sidZeile(loginB));
    check('4-vorab: das zweite Konto ist angemeldet und hat ein eigenes Cookie',
      loginB.status === 200 && !!cookieB && cookieB !== cookieA, { status: loginB.status });

    const r = await ruf('/me', { token: tokenA, cookie: cookieB });
    check('4: liegt bereits ein Cookie an, wird keines nachgereicht',
      r.status === 200 && sidZeile(r) === '', { zeile: sidZeile(r) || '(keine)' });
  }

  // ---- 5: ein UNGUELTIGER Bearer reicht nichts nach -------------------------------------------
  // Die Nachreichung steht hinter der vollstaendigen Pruefung. Stuende sie davor, koennte sich
  // jeder mit einem erfundenen Header ein Cookie ausstellen lassen.
  {
    const r = await ruf('/me', { token: 'keingueltigestoken' });
    check('5: ein ungueltiger Bearer bekommt kein Cookie nachgereicht',
      r.status === 401 && sidZeile(r) === '', { status: r.status, zeile: sidZeile(r) || '(keine)' });
  }

  // ---- 6: der Bearer-Weg funktioniert unveraendert ---------------------------------------------
  // Muss an BEIDEN Staenden gruen sein. Faellt sie, ist die Etappe nicht additiv - und eine
  // nicht-additive Aenderung an der Anmeldung trifft jeden Spieler gleichzeitig, nicht einen.
  {
    const r = await ruf('/me', { token: tokenA });
    check('6: eine Anfrage nur mit Bearer funktioniert weiterhin (die Aenderung ist additiv)',
      r.status === 200 && r.body.username === 'anna',
      { status: r.status, username: r.body.username, error: r.body.error });
  }

  // ---- 7: das Abmelden entwertet die Sitzung BEWUSST NICHT serverseitig -----------------------
  // Das ist die ehrliche Grenze dieser Etappe, und sie gehoert gemessen statt nur behauptet: Sie
  // uebersetzt, WO der Token liegt, nicht was Abmelden bedeutet. Vorher blieb ein ausgestelltes
  // Token nach dem Abmelden ebenfalls gueltig, es hatte nur niemand mehr. Wer die Sitzung
  // wirklich entwerten will, nimmt "Alle Sitzungen beenden".
  {
    await ruf('/logout', { methode: 'POST', cookie: cookieA });
    const r = await ruf('/me', { token: tokenA });
    check('7: Abmelden entwertet den Token nicht serverseitig (unveraendert, "Alle Sitzungen" tut das)',
      r.status === 200, { status: r.status });
  }

  // ---- 8: "Alle Sitzungen beenden" raeumt das Cookie weiterhin mit ab --------------------------
  // Diese Pruefung hat einen echten Fehler der eigenen Aenderung gefangen (19.08.2026): Die
  // Nachreichung feuert auch hier - es kommt ja ein Bearer ohne Cookie an -, und die Antwort trug
  // danach ZWEI Zeilen: erst eine frische Sitzung ueber 180 Tage, dann deren Loeschung. Welche
  // gewinnt, entscheidet die Reihenfolge im Browser. Geprueft wird deshalb die REGEL (es gibt
  // GENAU EINE Zeile, und sie loescht) und nicht nur "irgendwo steht Max-Age=0" - Letzteres waere
  // auch mit dem Widerspruch gruen gewesen.
  {
    const r = await ruf('/logout-all', { methode: 'POST', token: tokenA, body: { password: PASS } });
    const sidZeilen = (r.setCookie || []).filter(z => z.startsWith('kepler7_sid='));
    check('8: "Alle Sitzungen beenden" schickt GENAU EINE Zeile, und die loescht',
      r.status === 200 && sidZeilen.length === 1 && /Max-Age=0/.test(sidZeilen[0]),
      { status: r.status, anzahl: sidZeilen.length, zeilen: sidZeilen.map(z => z.slice(0, 60)) });
    const r2 = await ruf('/me', { token: tokenA });
    check('8b: und der Token gilt danach wirklich nicht mehr', r2.status === 401, { status: r2.status });
  }

  ende();
  console.log('');
  console.log(fehl ? 'FAIL - es gab rote Pruefungen.' : 'Alles gruen.');
  process.exit(fehl ? 1 : 0);
}

lauf().catch(e => { console.error(e); process.exit(1); });
