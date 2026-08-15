// Echter HTTP-Test der serverseitig verankerten Kosmetik (15.08.2026).
//
// WARUM DIE KOSMETIK ÜBERHAUPT HIER LIEGT: Der Spielstand ist klientenautoritativ, wer sich Erz
// geben will, braucht dafür keine Lücke. Eine Namensfarbe steht aber in der BESTENLISTE - auf einer
// Fläche, die allen gehört. "Ich trage die Goldspender-Farbe, ohne je gespendet zu haben" entwertet
// sie für alle, die dafür bezahlt haben. Genau diese Grenze prüft dieser Test.
//
// GEPRÜFT WERDEN DIE VIER EIGENSCHAFTEN, DIE STILL KAPUTTGEHEN KÖNNEN:
//   1. Ohne Freischaltung lässt sich ein Stück nicht ausrüsten (403) - der eigentliche Zweck.
//   2. Der Client kann die Bestenliste nicht selbst bemalen: Ein eingereichter Eintrag mit
//      gefälschter Kosmetik wird beim Lesen durch die geprüfte Auswahl ERSETZT.
//   3. Fortschritt schaltet frei (Prestige aus dem gespeicherten Spielstand).
//   4. DER SUBTILE FALL: Ein ABGELAUFENES Spender-Stück verschwindet aus der Bestenliste, ohne dass
//      die Auswahl gelöscht wird - spendet derselbe Spieler erneut, trägt er sofort wieder seine
//      alte Farbe. Beides zusammen geht nur mit mehreren Serverstarts, weil die Bedingung an der
//      Uhr hängt. Genau hier trennt sich der billige Lesepfad (prüft nur die BEFRISTETEN
//      Bedingungen, ohne den Spielstand einzulesen) von der vollständigen Prüfung beim Ausrüsten.
//
// AUSFÜHREN (Serverstart und Test im selben Bash-Aufruf - CLAUDE.md, Punkt 2 der Commit-Pflichten).
// Vier Abschnitte, gesteuert über das Argument; dazwischen wird die DB von außen verändert:
//
//   DB=$(mktemp /tmp/kepler-kosm-XXXX.json); rm -f "$DB"; export DB_FILE="$DB"
//   PORT=3214 JWT_SECRET=test node server.js > /tmp/k1.log 2>&1 &
//   PID=$!; sleep 3; node tests/test_kosmetik_http.js teil1; kill $PID; sleep 1
//   node -e "...supporterGrantUntil in die ZUKUNFT, supporterGrantTier='gold'..."
//   PORT=3214 JWT_SECRET=test node server.js > /tmp/k2.log 2>&1 &
//   PID=$!; sleep 3; node tests/test_kosmetik_http.js teil2; kill $PID; sleep 1
//   node -e "...supporterGrantUntil in die VERGANGENHEIT..."
//   PORT=3214 JWT_SECRET=test node server.js > /tmp/k3.log 2>&1 &
//   PID=$!; sleep 3; node tests/test_kosmetik_http.js teil3; kill $PID; sleep 1
//   node -e "...supporterGrantUntil wieder in die ZUKUNFT..."
//   PORT=3214 JWT_SECRET=test node server.js > /tmp/k4.log 2>&1 &
//   PID=$!; sleep 3; node tests/test_kosmetik_http.js teil4; kill $PID; rm -f "$DB"
//
// GEGENPROBE, in beide Richtungen gefahren (15.08.2026):
//   Gegen den alten server.js: FAIL - /api/cosmetics antwortet (404), alle folgenden rot.
//   Gegen eine Kopie ohne die Besitzprüfung in /equip: FAIL - "1c: fremdes Stück wird abgelehnt"
//     (Status 200 statt 403) und danach trägt die Bestenliste die nie freigeschaltete Goldfarbe.
//   Gegen eine Kopie, die im Lesepfad die Befristung NICHT erneut prüft: Teil 1-2 grün,
//     "4b: abgelaufenes Spender-Stück fällt aus der Bestenliste" rot - der Fall, den nur die
//     Uhr sichtbar macht.

const BASIS = 'http://127.0.0.1:3214/api';
const TEIL = process.argv[2] || 'teil1';
const NUTZER = 'kosmpruef';
const PASSWORT = 'geheim12345';

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };

async function j(pfad, opt) {
  const r = await fetch(BASIS + pfad, opt);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; }
  catch (e) { return { status: r.status, body: t.slice(0, 200) }; }
}
const alsNutzer = (token, extra) => Object.assign({ 'Authorization': 'Bearer ' + token }, extra || {});

async function anmelden() {
  const r = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: NUTZER, password: PASSWORT }) });
  return (r.body && r.body.token) || null;
}
async function meineId(token) {
  const r = await j('/me', { headers: alsNutzer(token) });
  return (r.body || {}).userId;
}
// Bestenlisten-Eintrag schreiben und ZURÜCKLESEN. Der Rückgabewert ist das, was ANDERE sehen.
async function bestenlisteSchreibenUndLesen(token, uid, gefaelscht) {
  await j('/storage/leaderboard:' + uid + '?shared=true', {
    method: 'PUT', headers: alsNutzer(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ value: JSON.stringify({ name: NUTZER, score: 4321, cosmetics: gefaelscht }) })
  });
  const g = await j('/storage/leaderboard:' + uid + '?shared=true', { headers: alsNutzer(token) });
  try { return JSON.parse((g.body || {}).value || 'null'); } catch (e) { return null; }
}

async function teil1() {
  const fs = require('fs');
  const DB = process.env.DB_FILE;
  await j('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: NUTZER, password: PASSWORT, email: 'kosm@example.invalid' }) });
  await new Promise(r => setTimeout(r, 900));
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  const ziel = db.users[NUTZER];
  check('Testkonto angelegt', !!ziel);
  const eintrag = Object.entries(db.verifyTokens || {}).find(([, v]) => ziel && v.userId === ziel.userId);
  if (eintrag) await j('/verify-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: eintrag[0] }) });
  const token = await anmelden();
  check('Anmeldung erfolgreich', !!token);
  if (!token) return;
  const uid = await meineId(token);

  // ---- 1a. Katalog und Ausgangsbesitz --------------------------------------------------------
  const k = await j('/cosmetics', { headers: alsNutzer(token) });
  check('1a: /api/cosmetics antwortet', k.status === 200, { status: k.status });
  const katalog = (k.body || {}).katalog || [];
  const besitz = (k.body || {}).besitz || [];
  check('1a: Katalog ist nicht leer', katalog.length > 0, { stuecke: katalog.length });
  check('1a: beide Arten kommen vor',
    katalog.some(d => d.art === 'namensfarbe') && katalog.some(d => d.art === 'emblem'));
  // Frisches Konto: nur was IMMER gilt. Verglichen wird gegen den Katalog (die Regel), nicht gegen
  // eine eingetippte Liste - kommt ein Immer-Stück dazu, soll der Test nicht falsch anschlagen.
  const immerKeys = katalog.filter(d => d.bedingung.typ === 'immer').map(d => d.key).sort();
  check('1a: frisches Konto besitzt genau die Immer-Stücke',
    JSON.stringify(besitz.slice().sort()) === JSON.stringify(immerKeys), { besitz, erwartet: immerKeys });

  // ---- 1b. Ein besessenes Stück lässt sich tragen ---------------------------------------------
  const eigenes = immerKeys.find(x => x.startsWith('nf_'));
  const e1 = await j('/cosmetics/equip', { method: 'POST', headers: alsNutzer(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ auswahl: { namensfarbe: eigenes } }) });
  check('1b: eigenes Stück lässt sich ausrüsten', e1.status === 200 && e1.body.ok === true, { status: e1.status, body: e1.body && e1.body.error });

  // ---- 1c. Ein FREMDES Stück nicht - der eigentliche Zweck -------------------------------------
  const fremd = katalog.find(d => d.art === 'namensfarbe' && d.bedingung.typ === 'spender' && d.bedingung.stufe === 'gold');
  check('1c-vorab: ein Spender-Stück existiert im Katalog', !!fremd, fremd && fremd.key);
  if (fremd) {
    const e2 = await j('/cosmetics/equip', { method: 'POST', headers: alsNutzer(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ auswahl: { namensfarbe: fremd.key } }) });
    // Der GRUND wird mitgeprüft, nicht nur der Statuscode (CLAUDE.md-Regel 28): 403 könnte auch aus
    // einer ganz anderen Sperre kommen.
    check('1c: fremdes Stück wird abgelehnt', e2.status === 403, { status: e2.status });
    check('1c: und zwar mit der Begründung "nicht freigeschaltet"',
      /freigeschaltet/i.test((e2.body && e2.body.error) || ''), e2.body && e2.body.error);
  }
  // Ein erfundener Schlüssel ist etwas anderes als ein gesperrter - 400, nicht 403.
  const e3 = await j('/cosmetics/equip', { method: 'POST', headers: alsNutzer(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ auswahl: { namensfarbe: 'nf_gibtsnicht' } }) });
  check('1c: erfundener Schlüssel wird als solcher abgelehnt', e3.status === 400, { status: e3.status });

  // ---- 1d. Fortschritt schaltet frei ------------------------------------------------------------
  const fortschritt = katalog.find(d => d.bedingung.typ === 'prestige');
  check('1d-vorab: ein Prestige-Stück existiert', !!fortschritt, fortschritt && fortschritt.key);
  if (fortschritt) {
    const spielstand = JSON.stringify({ prestige: fortschritt.bedingung.wert, ascension: { count: 0 }, battlePoints: 0, abgrund: { best: 0 }, resources: {}, buildings: {}, research: {}, fleet: {}, colonies: {} });
    const put = await j('/storage/kepler7-save-v3', { method: 'PUT', headers: alsNutzer(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ value: spielstand }) });
    check('1d-vorab: Spielstand angenommen', put.status === 200, { status: put.status, body: put.body && put.body.error });
    const k2 = await j('/cosmetics', { headers: alsNutzer(token) });
    check('1d: Prestige schaltet das Stück frei', ((k2.body || {}).besitz || []).indexOf(fortschritt.key) !== -1,
      { gesucht: fortschritt.key, besitz: (k2.body || {}).besitz });
    const e4 = await j('/cosmetics/equip', { method: 'POST', headers: alsNutzer(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ auswahl: { namensfarbe: fortschritt.key } }) });
    check('1d: und lässt sich danach tragen', e4.status === 200, { status: e4.status });
  }

  // ---- 1e. Die Bestenliste lässt sich nicht selbst bemalen -------------------------------------
  // BEWUSST HIER UNTEN, nach 1d: Getragen wird jetzt ein Stück, das NICHT die Vorgabe ist. Stünde
  // diese Prüfung weiter oben, trüge das Konto noch nf_standard - und ein Server, der stumpf immer
  // die Vorgabe zurückgibt, hätte sie ebenfalls bestanden (CLAUDE.md-Regel 28: grün aus dem
  // falschen Grund ist so schlecht wie rot).
  const getragenJetzt = fortschritt ? fortschritt.key : eigenes;
  const lb = await bestenlisteSchreibenUndLesen(token, uid, { namensfarbe: fremd ? fremd.key : 'nf_gold', emblem: 'em_komet' });
  check('1e: gefälschte Kosmetik wird beim Lesen durch die echte ersetzt',
    !!lb && lb.cosmetics && lb.cosmetics.namensfarbe === getragenJetzt, { gelesen: lb && lb.cosmetics, erwartet: getragenJetzt });
  check('1e: auch das gefälschte Emblem ist weg',
    !!lb && lb.cosmetics && lb.cosmetics.emblem === 'em_keins', lb && lb.cosmetics);
  await new Promise(r => setTimeout(r, 900));
}

// Ab hier hat der Aufrufer dem Konto von außen einen Spender-Rang gegeben (Gold, in der Zukunft).
async function teil2() {
  const token = await anmelden();
  check('2: Anmeldung nach Neustart', !!token);
  if (!token) return;
  const uid = await meineId(token);
  const k = await j('/cosmetics', { headers: alsNutzer(token) });
  const besitz = (k.body || {}).besitz || [];
  check('2a: Spender-Rang schaltet die Goldfarbe frei', besitz.indexOf('nf_gold') !== -1, { besitz });
  // Die Stufen sind aufsteigend - Gold besitzt auch Bronze und Silber.
  check('2a: und die niedrigeren Stufen gleich mit',
    besitz.indexOf('nf_kupfer') !== -1 && besitz.indexOf('nf_silber') !== -1, { besitz });
  const e = await j('/cosmetics/equip', { method: 'POST', headers: alsNutzer(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ auswahl: { namensfarbe: 'nf_gold' } }) });
  check('2b: Goldfarbe lässt sich jetzt ausrüsten', e.status === 200, { status: e.status, body: e.body && e.body.error });
  // Auch hier wieder mit Fälschungsversuch: Getragen ist nf_gold, eingereicht wird ein Emblem, das
  // dieses Konto nie freigeschaltet hat (em_lot, Rekordtiefe 60). Beides muss stimmen - die echte
  // Farbe steht da, das erfundene Emblem nicht.
  const lb = await bestenlisteSchreibenUndLesen(token, uid, { namensfarbe: 'nf_standard', emblem: 'em_lot' });
  check('2b: und steht in der Bestenliste', !!lb && lb.cosmetics && lb.cosmetics.namensfarbe === 'nf_gold', lb && lb.cosmetics);
  check('2b: das nie freigeschaltete Emblem kommt nicht durch',
    !!lb && lb.cosmetics && lb.cosmetics.emblem !== 'em_lot', lb && lb.cosmetics);
  await new Promise(r => setTimeout(r, 900));
}

// Ab hier ist der Spender-Rang ABGELAUFEN (Zeitpunkt in der Vergangenheit).
async function teil3() {
  const fs = require('fs');
  const token = await anmelden();
  check('3: Anmeldung nach Ablauf', !!token);
  if (!token) return;
  const uid = await meineId(token);
  const lb = await bestenlisteSchreibenUndLesen(token, uid, null);
  check('3a: abgelaufenes Spender-Stück fällt aus der Bestenliste',
    !!lb && lb.cosmetics && lb.cosmetics.namensfarbe === 'nf_standard', lb && lb.cosmetics);
  const k = await j('/cosmetics', { headers: alsNutzer(token) });
  check('3a: und gilt auch nicht mehr als Besitz', ((k.body || {}).besitz || []).indexOf('nf_gold') === -1, (k.body || {}).besitz);
  // ABER: die getroffene Wahl darf nicht gelöscht worden sein - sonst müsste ein wiederkehrender
  // Spender seine Farbe neu suchen. Gemessen an der Datenbank, nicht an der Antwort: die Antwort
  // zeigt ja bewusst die Vorgabe.
  await new Promise(r => setTimeout(r, 900));
  const db = JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8'));
  const gespeichert = ((db.users[NUTZER] || {}).cosmetics || {}).namensfarbe;
  check('3b: die Auswahl bleibt gespeichert', gespeichert === 'nf_gold', { gespeichert });
}

// Und jetzt ist wieder gespendet worden.
async function teil4() {
  const token = await anmelden();
  check('4: Anmeldung nach erneuter Spende', !!token);
  if (!token) return;
  const uid = await meineId(token);
  const lb = await bestenlisteSchreibenUndLesen(token, uid, null);
  check('4: die alte Farbe kehrt von selbst zurück - ohne erneutes Ausrüsten',
    !!lb && lb.cosmetics && lb.cosmetics.namensfarbe === 'nf_gold', lb && lb.cosmetics);
}

(async () => {
  const teile = { teil1, teil2, teil3, teil4 };
  await (teile[TEIL] || teil1)();
  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nalles gruen');
  process.exit(fail ? 1 : 0);
})();
