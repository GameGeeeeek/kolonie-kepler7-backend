// Passwort-Regeln beim SETZEN eines Passworts (Sicherheits-Audit 18.08.2026, Vorschlag P5).
//
// WAS DER BEFUND WAR
// ------------------
// Es galt nur "mindestens 6 Zeichen" - unter dem heutigen OWASP-/NIST-Stand (8). Und die dritte
// Zeile aus dem Ausloeser-Video ("Bekanntes PW: Front ✓ / Server ✗") wurde auf KEINER Seite
// geprueft: 'password' und 'passwort123' waren gueltige Passwoerter.
//
// Die eigentliche Videoluecke - Frontend prueft, Server nicht - bestand hier NICHT: Der Server
// prueft eigenstaendig, und das tut er weiterhin. Geaendert hat sich nur das Niveau.
//
// DIE WICHTIGSTE PRUEFUNG DIESER DATEI IST 7 - und sie prueft eine NICHT-Aenderung
// -------------------------------------------------------------------------------
// Ein Bestandskonto mit einem 6-Zeichen-Passwort muss sich weiterhin anmelden koennen. Eine neue
// Regel begrenzt das HINZUFUEGEN, nie den Bestand; wer das umdreht, sperrt echte Spieler aus ihren
// Konten aus, um ein Passwort zu erzwingen, das sie danach gar nicht mehr aendern koennen (der
// Reset laeuft ueber eine E-Mail, die man erst anfordern muss). Das ist dieselbe Ueberlegung wie
// bei den Deckeln im Unterstuetzer-Bereich: "Deckel duerfen niemals Daten loeschen."
//
// Nebenbei ist der ganze Testbestand dieses Repos der lebende Beleg dafuer: ACHT bestehende Tests
// (test_festung_http, test_geteilter_speicher_http, test_privatschluessel_http, ...) legen ihren
// Nutzern per bcrypt.hashSync('test1234') ein Passwort in die DB, das auf der Liste der bekannten
// Passwoerter STEHT - und melden sich damit weiterhin an. Waere die Pruefung faelschlich im Login
// gelandet, waeren sie alle acht rot.
//
// WARUM DER GRUND GEPRUEFT WIRD UND NICHT NUR DER STATUSCODE
// ----------------------------------------------------------
// /api/register lehnt aus vielen Gruenden mit 400 ab (Name vergeben, E-Mail fehlt, Name ungueltig).
// Eine Pruefung auf "400" allein waere deshalb aus dem falschen Grund gruen - genau der Fall, den
// Frontend-Hausregel 28 beschreibt und den die Gegenprobe von test_marktdeckel_http.js schon
// einmal vorgefuehrt hat. Jede Ablehnung hier verlangt darum ein charakteristisches Stueck des
// Fehlertextes, das NUR diese eine Regel erzeugen kann.
//
// AUSFUEHREN: npm install (einmalig), dann node tests/test_passwortregeln_http.js
//
// GEGENPROBE (beide Richtungen gefahren, 19.08.2026, gegen den alten server.js:
// `git show origin/master:server.js > server.alt.js` im SELBEN Ordner, damit node_modules
// aufloest, und TEST_SERVER=server.alt.js gesetzt):
//   neuer Stand: 19 Pruefungen, 0 rot
//   alter Stand: 19 Pruefungen, 11 rot - 1, 2, 3, 4, 4b, 5, 6 (Registrierung nimmt alles an),
//                8, 8b, 8c (der Reset ebenso) und 10 (das Konto wurde angelegt: der Login
//                antwortet dort 403 "noch nicht bestaetigt" statt 401 "gibt es nicht").
// An BEIDEN Staenden laufen dieselben 19 Pruefungen - waeren es verschieden viele, waere die
// Gegenprobe unvollstaendig (Frontend-Hausregel 34; per `diff` der Pruefnamen verglichen, nicht
// per Anzahl - eine Zahl allein beantwortet die Frage "liefen dieselben?" nur indirekt).
//
// Gruen bleiben am alten Stand genau die acht Gegenrichtungen und Kontrollen: 0-aufbau, 0-liste,
// 1b, 7, 7b, 9, 9b, 9c. Das ist kein Mangel, sondern ihr Zweck - eine Regel, die stumpf ALLES
// ablehnt, kaeme durch die Ablehnungs-Pruefungen ebenfalls durch und muss an ihnen scheitern.
// 0-liste prueft die Datei, nicht den Code, und ist deshalb an beiden Staenden gruen.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
// 3195-3200, 3210-3222 sind belegt (Arbeitsregel 29: `grep -hoE "PORT *= *[0-9]+" tests/*.js`).
const PORT = Number(process.env.TEST_PORT || 3223);
const SERVERDATEI = process.env.TEST_SERVER || 'server.js';

let fehl = false;
const check = (n, ok, x) => {
  console.log((ok ? 'OK   - ' : 'FAIL - ') + n + (x !== undefined ? ' | ' + JSON.stringify(x) : ''));
  if (!ok) fehl = true;
};
const warte = ms => new Promise(r => setTimeout(r, ms));

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');

// Das Bestandskonto: sechs Zeichen, also ein Passwort, das die NEUE Regel nicht mehr durchliesse.
// Genau darum geht es in Pruefung 7.
const ALT_PASSWORT = 'geheim';
const ALT_ID = crypto.randomUUID();
// JEDE Reset-Pruefung bekommt einen EIGENEN Token. Der Grund ist eine Messung: Der Server
// LOESCHT den Token bei einem erfolgreichen Reset. Mit nur einem Token ging Pruefung 8 am alten
// Stand durch (dort waren 6 Zeichen ja erlaubt), verbrauchte ihn dabei - und alle folgenden
// Reset-Pruefungen scheiterten danach an "Link ist ungueltig" statt an dem, was sie messen
// wollten. Vier Fehlschlaege aus dem falschen Grund, die die Gegenprobe staerker aussehen liessen,
// als sie war (Frontend-Hausregel 28). Mit je eigenem Token misst jede unabhaengig - an beiden
// Staenden.
const RESET_TOKENS = { kurz: 't-kurz', bekannt: 't-bekannt', name: 't-name', gut: 't-gut' };

function db() {
  return {
    users: {
      altgedient: {
        userId: ALT_ID, username: 'altgedient', passwordHash: bcrypt.hashSync(ALT_PASSWORT, 10),
        email: 'alt@example.invalid', emailVerified: true, createdAt: Date.now()
      }
    },
    private: {},
    shared: {},
    // Ein gueltiger Reset-Token, damit /api/reset-password ohne Mailversand pruefbar ist.
    resetTokens: Object.fromEntries(Object.values(RESET_TOKENS)
      .map(t => [t, { userId: ALT_ID, expires: Date.now() + 60 * 60 * 1000 }])),
    galaxy: {
      npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {}
    }
  };
}

const BASIS = 'http://127.0.0.1:' + PORT + '/api';

async function post(pfad, body) {
  try {
    const r = await fetch(BASIS + pfad, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    let j = null; try { j = await r.json(); } catch (e) {}
    return { status: r.status, body: j || {} };
  } catch (e) { return { status: 0, body: { error: String(e) } }; }
}

/** Registrierungsversuch mit frischem Namen - so kollidiert nie ein Name mit einem frueheren Lauf. */
let lfd = 0;
const registriere = (passwort, name) => post('/register', {
  username: name || ('pwtest' + (++lfd) + Math.floor(Math.random() * 9000)),
  password: passwort,
  email: 'pwtest' + lfd + '@example.invalid'
});

async function lauf() {
  const dbPfad = path.join(os.tmpdir(), 'kepler-passwortregeln-' + process.pid + '.json');
  fs.writeFileSync(dbPfad, JSON.stringify(db(), null, 1));

  let log = '';
  const srv = spawn(process.execPath, [path.join(WURZEL, SERVERDATEI)], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, { DB_FILE: dbPfad, PORT: String(PORT), JWT_SECRET: 'testsecret' }),
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
  // Der Aufbau ist eine eigene, BENANNTE Pruefung und wirft nicht - ein Test, der beim Aufbau
  // seiner Messvorrichtung abstuerzt, hat seine uebrigen Pruefungen nicht ausgefuehrt, und der
  // rote Exit-Code verdeckt genau das (Frontend-Hausregel 34).
  check('0-aufbau: der Server ist oben', oben, oben ? undefined : { log: log.slice(-400) });
  if (!oben) { ende(); return; }

  // --- 0-liste: die Liste ist wirklich da und nicht abgeschnitten ---------------------------
  // Der Server laeuft auch OHNE die Datei weiter (bewusst, siehe Kommentar an BEKANNTE_PASSWOERTER)
  // - dann fehlt aber genau die Regel, die 'password' abfaengt, und das saehe von aussen aus wie
  // Normalbetrieb. Gezaehlt wird deshalb, nicht nur auf Existenz geprueft.
  let eintraege = 0;
  try {
    eintraege = fs.readFileSync(path.join(WURZEL, 'passwoerter-bekannt.txt'), 'utf8')
      .split('\n').map(z => z.trim()).filter(z => z && !z.startsWith('#')).length;
  } catch (e) { /* bleibt 0 */ }
  check('0-liste: die Liste bekannter Passwoerter ist geladen und gefuellt', eintraege >= 1000, { eintraege });

  // --- 1: zu kurz --------------------------------------------------------------------------
  {
    const r = await registriere('Ab3!xyz');   // 7 Zeichen, sonst tadellos
    check('1: sieben Zeichen werden abgelehnt, und der Grund nennt die Laenge',
      r.status === 400 && /8 Zeichen/.test(r.body.error || ''), r);
  }
  // --- 1b: Gegenrichtung - acht Zeichen genuegen -------------------------------------------
  // Ohne diese Pruefung waere eine Regel, die stumpf ALLES ablehnt, genauso "gruen".
  {
    const r = await registriere('Ab3!xyzq');  // exakt 8, die Grenze selbst
    check('1b: acht Zeichen werden angenommen (die Grenze bindet nicht zu streng)',
      r.status === 200 || r.status === 201, { status: r.status, error: r.body.error });
  }
  // --- 2: bekanntes Passwort ---------------------------------------------------------------
  {
    const r = await registriere('passwort123');
    check('2: ein bekanntes Passwort wird abgelehnt, und der Grund nennt die Haeufigkeit',
      r.status === 400 && /haeufigsten|häufigsten/.test(r.body.error || ''), r);
  }
  // --- 3: nur Ziffern ----------------------------------------------------------------------
  {
    const r = await registriere('19850612');  // ein Geburtsdatum, nicht auf der Liste
    check('3: eine reine Ziffernfolge wird abgelehnt, und der Grund nennt die Ziffern',
      r.status === 400 && /Ziffern/.test(r.body.error || ''), r);
  }
  // --- 4: lauter gleiche Zeichen -----------------------------------------------------------
  // BEWUSST Sonderzeichen und NICHT 'qqqqqqqq': Jede achtfache Buchstaben-Wiederholung steht
  // bereits auf der Liste, dort haette also die Listen-Regel geantwortet und diese Pruefung waere
  // aus dem falschen Grund gruen gewesen (Frontend-Hausregel 28 - genau so beim ersten Anlauf
  // passiert, und nur weil die Pruefung den GRUND verlangt und nicht bloss den Statuscode, ist es
  // aufgefallen). Was hier gemessen wird, ist der Rest, den die Liste NICHT abdeckt:
  // Sonderzeichen und laengere Wiederholungen.
  {
    const r = await registriere('########');
    check('4: lauter gleiche Zeichen werden abgelehnt (Fall ohne Listentreffer)',
      r.status === 400 && /gleichen Zeichen/.test(r.body.error || ''), r);
  }
  // --- 4b: dasselbe fuer eine laengere Wiederholung, die die Liste ebenfalls nicht kennt ----
  {
    const r = await registriere('qqqqqqqqqqqq');
    check('4b: auch eine laengere Buchstaben-Wiederholung wird abgelehnt',
      r.status === 400 && /gleichen Zeichen/.test(r.body.error || ''), r);
  }
  // --- 5: enthaelt den eigenen Spielernamen ------------------------------------------------
  {
    const r = await registriere('Sternwolf-99', 'Sternwolf');
    check('5: der eigene Spielername im Passwort wird abgelehnt',
      r.status === 400 && /Spielernamen/.test(r.body.error || ''), r);
  }
  // --- 6: enthaelt den Namen des Spiels ----------------------------------------------------
  // Ein spielspezifischer Griff, den KEINE allgemeine Haeufigkeitsliste kennt - die Liste allein
  // waere hier blind.
  {
    const r = await registriere('MeinKepler7!');
    check('6: der Name des Spiels im Passwort wird abgelehnt',
      r.status === 400 && /Namen des Spiels/.test(r.body.error || ''), r);
  }

  // --- 7: DER KERN - das Bestandskonto kommt weiterhin hinein -------------------------------
  // 'geheim' hat sechs Zeichen und wuerde als NEUES Passwort abgelehnt. Als BESTEHENDES muss es
  // sich weiter anmelden koennen. Faellt diese Pruefung, ist die Regel in den Login gerutscht.
  {
    const r = await post('/login', { username: 'altgedient', password: ALT_PASSWORT });
    check('7: ein Bestandskonto mit 6-Zeichen-Passwort kann sich WEITERHIN anmelden',
      r.status === 200 && !!r.body.token, { status: r.status, error: r.body.error });
  }
  // --- 7b: und ein falsches Passwort wird weiterhin abgewiesen ------------------------------
  // Die Gegenrichtung zu 7: Ein Login, der alles durchlaesst, waere dort ebenfalls gruen.
  {
    const r = await post('/login', { username: 'altgedient', password: 'geheim-falsch' });
    check('7b: ein falsches Passwort wird weiterhin abgewiesen', r.status === 401, { status: r.status });
  }

  // --- 8: der Reset prueft dieselben Regeln ------------------------------------------------
  // Beide Setz-Wege muessen dieselbe Wache haben, sonst ist die strengere Regel ueber den
  // schwaecheren Weg zu umgehen.
  {
    const r = await post('/reset-password', { token: RESET_TOKENS.kurz, newPassword: 'kurz12' });
    check('8: der Passwort-Reset lehnt ein zu kurzes Passwort ab',
      r.status === 400 && /8 Zeichen/.test(r.body.error || ''), r);
  }
  // --- 8b: und er kennt auch die Liste (nicht nur die Laenge) ------------------------------
  {
    const r = await post('/reset-password', { token: RESET_TOKENS.bekannt, newPassword: 'passwort123' });
    check('8b: der Reset lehnt auch ein bekanntes Passwort ab (nicht nur zu kurze)',
      r.status === 400 && /haeufigsten|häufigsten/.test(r.body.error || ''), r);
  }
  // --- 8c: und den Spielernamen des BETROFFENEN Kontos --------------------------------------
  // Der Name kommt hier nicht aus dem Request, sondern aus dem Konto hinter dem Token - deshalb
  // steht die Pruefung im Server HINTER findUserById.
  {
    const r = await post('/reset-password', { token: RESET_TOKENS.name, newPassword: 'altgedient-1' });
    check('8c: der Reset kennt den Spielernamen des Kontos hinter dem Token',
      r.status === 400 && /Spielernamen/.test(r.body.error || ''), r);
  }
  // --- 9: Gegenrichtung - ein starkes Passwort geht durch -----------------------------------
  {
    const r = await post('/reset-password', { token: RESET_TOKENS.gut, newPassword: 'Vurm-Tal-92x' });
    check('9: ein starkes neues Passwort wird beim Reset angenommen',
      r.status === 200, { status: r.status, error: r.body.error });
  }
  // --- 9b: und es gilt danach wirklich ------------------------------------------------------
  // Ohne diese Pruefung waere 9 nur "der Server hat 200 gesagt" - nicht "das Passwort ist gesetzt".
  {
    const r = await post('/login', { username: 'altgedient', password: 'Vurm-Tal-92x' });
    check('9b: mit dem neuen Passwort gelingt die Anmeldung',
      r.status === 200 && !!r.body.token, { status: r.status, error: r.body.error });
  }
  // --- 9c: das alte Passwort gilt danach nicht mehr -----------------------------------------
  {
    const r = await post('/login', { username: 'altgedient', password: ALT_PASSWORT });
    check('9c: das alte Passwort gilt nach dem Reset nicht mehr', r.status === 401, { status: r.status });
  }

  // --- 10: die Ablehnung legt kein halbes Konto an ------------------------------------------
  // Eine Ablehnung, die trotzdem schreibt, waere schlimmer als keine Pruefung (dieselbe
  // Ueberlegung wie bei Pruefung 3 in test_marktdeckel_http.js).
  {
    const name = 'halbkonto' + Math.floor(Math.random() * 9000);
    await registriere('passwort123', name);
    const r = await post('/login', { username: name, password: 'passwort123' });
    check('10: eine abgelehnte Registrierung legt kein Konto an',
      r.status === 401 || r.status === 404, { status: r.status });
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
