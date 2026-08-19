// Sitzungs-Cookie: der Server stellt es aus und nimmt es an - ohne dass sich fuer bestehende
// Clients irgendetwas aendert (Sicherheits-Audit P3, Etappe a, 19.08.2026).
//
// WORUM ES GEHT
// -------------
// Der Token liegt im Frontend in localStorage und ist damit in JS-Reichweite: Die erste
// XSS-Luecke, die je entsteht, ist sofort eine vollstaendige Kontouebernahme. Ein HttpOnly-Cookie
// kann JavaScript gar nicht erst lesen.
//
// DIESE ETAPPE IST FUER SICH GENOMMEN KEIN SICHERHEITSGEWINN. Solange das Frontend den Token
// weiter in localStorage legt und per Bearer schickt, ist die Angriffsflaeche unveraendert. Was
// sie leistet, ist die REIHENFOLGE - und genau das misst dieser Test:
//
//   Pruefung 2 belegt, dass das Cookie TRAEGT (Etappe b kann darauf aufbauen).
//   Pruefung 3 belegt, dass der Bearer-Weg UNVERAENDERT funktioniert (Etappe a darf allein live).
//
// Die zweite ist die wichtigere. Ohne sie waere nicht belegt, dass diese Etappe additiv ist - und
// eine nicht-additive Aenderung an der Anmeldung trifft im Zweifel JEDEN Spieler gleichzeitig,
// nicht einen. Das wiegt hier besonders schwer, weil Frontend und Backend ueber zwei getrennte
// Befehle desselben Webhooks live gehen und historisch mehrfach auseinandergelaufen sind.
//
// WARUM DER BEARER VORRANG HAT (Pruefung 4)
// -----------------------------------------
// Solange Etappe a und b auseinander liegen, traegt ein Browser BEIDES. Massgeblich muss dann
// sein, was das Frontend bewusst mitschickt: Ein alter Cookie-Rest wuerde sonst ein frisch
// angemeldetes Geraet ueberstimmen und den Spieler mit einer fremden Sitzung weiterlaufen lassen.
// Gemessen wird das mit ZWEI Konten - Bearer von A, Cookie von B, und /api/me muss A nennen.
// Mit nur einem Konto ginge es nicht: Eine zweite Anmeldung entwertet die erste (eine Sitzung je
// Konto), es gaebe also nie zwei gleichzeitig gueltige Tokens desselben Nutzers.
//
// AUSFUEHREN: npm install (einmalig), dann node tests/test_sitzungscookie_http.js
//
// GEGENPROBE (19.08.2026, gegen den alten server.js: `git show origin/master:server.js >
// server.alt.js` im SELBEN Ordner, damit node_modules aufloest, dann TEST_SERVER gesetzt):
//   neuer Stand: 15 Pruefungen, 0 rot
//   alter Stand: 15 Pruefungen, 7 rot  (1, 1b, 1c - kein Cookie; 2 - es traegt nicht;
//                4-vorab und 7-vorab/7 - alles, was ein Cookie voraussetzt)
// Dieselben 15 an beiden Staenden (Frontend-Hausregel 34).
//
// EINE PRUEFUNG MUSS HIER IN BEIDE RICHTUNGEN GRUEN SEIN, und das ist kein Mangel, sondern der
// Beleg: Pruefung 3 (der Bearer-Weg funktioniert). Bei einer ADDITIVEN Aenderung heisst
// "richtig" ja gerade, dass sich fuer bestehende Clients nichts aendert - waere 3 am alten Stand
// rot, haette ich etwas kaputtgemacht. Das ist die Umkehrung des Normalfalls (Hausregel 26: eine
// Gegenprobe, die gruen bleibt, ist der Befund) und gilt nur fuer genau diese eine Prueffrage.
//
// Ebenfalls gruen bleiben 1d, 4, 5, 6 und 7b - dort fehlt am alten Stand schlicht das Cookie, sie
// sind also trivial erfuellt. Sie tragen die Aussage nicht allein; das tun 1-3.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
// 3195-3200 und 3210-3223 sind belegt (Arbeitsregel 29).
const PORT = Number(process.env.TEST_PORT || 3224);
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

/** Aus einer Set-Cookie-Zeile das reine "name=wert" fuer den Rueckweg ziehen. */
const cookiePaar = zeile => String(zeile || '').split(';')[0];

async function lauf() {
  const dbPfad = path.join(os.tmpdir(), 'kepler-sitzungscookie-' + process.pid + '.json');
  fs.writeFileSync(dbPfad, JSON.stringify(db(), null, 1));

  let log = '';
  const srv = spawn(process.execPath, [path.join(WURZEL, SERVERDATEI)], {
    cwd: WURZEL,
    // PUBLIC_URL wird bewusst NICHT ueberschrieben: `web-push` verlangt fuer das VAPID-Subject
    // zwingend `https:` oder `mailto:` und laesst den Server sonst gar nicht erst starten. Genau
    // daran ist der erste Entwurf gescheitert - und der Fehlschlag hat einen echten Mangel im
    // Code aufgedeckt: `Secure` hing dort an PUBLIC_URL und war damit IMMER gesetzt, also keine
    // Fallunterscheidung, sondern eine, die nur so aussah. Jetzt haengt es an `req.secure`, und
    // dieser Test misst ueber http - Pruefung 1d belegt die Gegenrichtung.
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

  // ---- 1: die Anmeldung stellt das Cookie aus, und es traegt die Schutzmerkmale --------------
  const loginA = await ruf('/login', { methode: 'POST', body: { username: 'anna', password: PASS } });
  check('1-vorab: die Anmeldung gelingt und liefert den Token weiterhin im Body',
    loginA.status === 200 && !!loginA.body.token,
    { status: loginA.status, error: loginA.body.error });
  if (!loginA.body.token) { ende(); return; }

  const zeile = loginA.setCookie.find(z => z.startsWith('kepler7_sid=')) || '';
  check('1: die Anmeldung setzt ein Sitzungs-Cookie', !!zeile, { setCookie: loginA.setCookie });
  // HttpOnly ist der ganze Zweck: Ein Cookie ohne dieses Merkmal waere fuer JavaScript genauso
  // lesbar wie localStorage und damit vollkommen wirkungslos.
  check('1b: es ist HttpOnly', /HttpOnly/i.test(zeile), { zeile });
  check('1c: es traegt SameSite und eine Frist', /SameSite=Lax/i.test(zeile) && /Max-Age=\d+/.test(zeile), { zeile });
  // Gegenrichtung zur Secure-Entscheidung: Der Test spricht ueber http, also DARF Secure hier
  // nicht stehen - sonst verwuerfe ein Browser das Cookie im lokalen Betrieb stillschweigend.
  // Dass es in Produktion sehr wohl gesetzt wird, haengt an `req.secure` und damit an nginx.
  check('1d: ueber http ist Secure NICHT gesetzt (es haengt an req.secure)',
    !/;\s*Secure/i.test(zeile), { zeile });

  const cookieA = cookiePaar(zeile);
  const tokenA = loginA.body.token;

  // ---- 2: das Cookie TRAEGT - eine Anfrage ganz ohne Bearer wird angenommen ------------------
  {
    const r = await ruf('/me', { cookie: cookieA });
    check('2: eine Anfrage NUR mit Cookie (ohne Bearer) wird angenommen',
      r.status === 200 && r.body.username === 'anna',
      { status: r.status, username: r.body.username, error: r.body.error });
  }

  // ---- 3: DER KERN - der Bearer-Weg funktioniert unveraendert --------------------------------
  // Faellt diese Pruefung, ist die Etappe nicht additiv und darf nicht allein live gehen.
  {
    const r = await ruf('/me', { token: tokenA });
    check('3: eine Anfrage NUR mit Bearer funktioniert unveraendert (die Etappe ist additiv)',
      r.status === 200 && r.body.username === 'anna',
      { status: r.status, username: r.body.username, error: r.body.error });
  }

  // ---- 4: Bearer hat Vorrang vor dem Cookie --------------------------------------------------
  // Gemessen mit ZWEI Konten, weil eine zweite Anmeldung desselben Kontos die erste entwertet.
  {
    const loginB = await ruf('/login', { methode: 'POST', body: { username: 'bert', password: PASS } });
    const cookieB = cookiePaar(loginB.setCookie.find(z => z.startsWith('kepler7_sid=')) || '');
    check('4-vorab: das zweite Konto ist angemeldet und hat ein eigenes Cookie',
      loginB.status === 200 && !!cookieB && cookieB !== cookieA,
      { status: loginB.status, unterschiedlich: cookieB !== cookieA });

    const r = await ruf('/me', { token: tokenA, cookie: cookieB });
    check('4: schickt ein Client BEIDES, entscheidet der Bearer-Header',
      r.status === 200 && r.body.username === 'anna',
      { status: r.status, username: r.body.username, erwartet: 'anna' });
  }

  // ---- 5: ohne beides bleibt es bei 401 ------------------------------------------------------
  // Die Gegenrichtung zu 2 und 3: Eine Middleware, die alles durchlaesst, waere dort ebenfalls
  // gruen.
  {
    const r = await ruf('/me');
    check('5: ohne Bearer UND ohne Cookie antwortet der Server weiterhin mit 401', r.status === 401,
      { status: r.status });
  }

  // ---- 6: ein unsinniges Cookie wird abgewiesen ----------------------------------------------
  {
    const r = await ruf('/me', { cookie: 'kepler7_sid=keingueltigestoken' });
    check('6: ein ungueltiges Cookie wird abgewiesen', r.status === 401, { status: r.status });
  }

  // ---- 7: "alle Sitzungen beenden" raeumt das Cookie weg -------------------------------------
  {
    const r = await ruf('/logout-all', { methode: 'POST', cookie: cookieA, body: { password: PASS } });
    const weg = (r.setCookie || []).find(z => z.startsWith('kepler7_sid='));
    check('7-vorab: die Abmeldung gelingt mit dem Cookie allein', r.status === 200,
      { status: r.status, error: r.body.error });
    check('7: sie loescht das Cookie (Max-Age=0)', !!weg && /Max-Age=0/.test(weg), { zeile: weg });

    // Und die WIRKUNG, nicht nur die Kopfzeile (Frontend-Arbeitsregel 61): Das alte Cookie gilt
    // danach wirklich nicht mehr - tokenVersion ist hochgezaehlt.
    const nach = await ruf('/me', { cookie: cookieA });
    check('7b: das alte Cookie ist danach wirkungslos', nach.status === 401, { status: nach.status });
  }

  ende();
}

lauf().then(() => {
  console.log(fehl ? '\nFEHLGESCHLAGEN' : '\nAlles gruen.');
  process.exit(fehl ? 1 : 0);
}).catch(e => {
  console.error('\nFEHLGESCHLAGEN - Testlauf abgebrochen:', e && e.message ? e.message : e);
  process.exit(1);
});
