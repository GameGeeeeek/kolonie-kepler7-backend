// Sternenstaub: die Währung für Kosmetik (15.08.2026), echter HTTP-Test.
//
// WORUM ES GEHT: Der erste Entwurf wollte Tagesaufgaben und Wochenliga als Quellen. Das wäre eine
// Währung gewesen, die nur so AUSSIEHT, als läge sie sicher auf dem Server - beide Größen stehen im
// klientenautoritativen Spielstand. Es zählt deshalb nur, was der Server SELBST beobachtet: die
// tägliche Anmeldung (Zeitstempel entsteht hier) und den ABGEWEHRTEN Angriff (/api/attack würfelt
// den Kampf serverseitig aus; der Verteidiger kann ihn weder auslösen noch beeinflussen).
//
// GEPRÜFT WERDEN DIE EIGENSCHAFTEN, DIE STILL KAPUTTGEHEN KÖNNEN:
//   1. Die Tagesgutschrift ist IDEMPOTENT - /api/me läuft bei jedem Spielstart, auch mehrfach.
//      Ohne den Tagesschlüssel wäre die Währung durch simples Neuladen beliebig vermehrbar. Das ist
//      die wichtigste Prüfung der Datei.
//   2. Die Serie zählt nur bei LÜCKENLOSEN Tagen hoch und setzt sonst zurück.
//   3. Der Laden bucht wirklich ab, gibt das Stück, und ein zweiter Kauf wird abgelehnt.
//   4. Ein Stück, das nicht käuflich ist, lässt sich auch nicht kaufen (400 statt 402/200) - sonst
//      wäre der Laden ein Umweg um die Fortschritts- und Spender-Bedingungen.
//   5. Die Abwehr-Gutschrift zählt je Angreifer nur EINMAL pro Tag. Ohne diese Grenze wären zwei
//      abgesprochene Konten eine Gelddruckmaschine.
//
// AUSFÜHREN (Serverstart und Test im selben Bash-Aufruf). Zwei Abschnitte, dazwischen wird der
// Tagesschlüssel des Kontos von außen zurückdatiert - anders ist ein Tageswechsel nicht prüfbar:
//
//   DB=$(mktemp /tmp/kepler-staub-XXXX.json); rm -f "$DB"; export DB_FILE="$DB"
//   PORT=3215 JWT_SECRET=test node server.js > /tmp/s1.log 2>&1 &
//   PID=$!; sleep 3; node tests/test_sternenstaub_http.js teil1; kill $PID; sleep 1
//   node -e "...staub.letzterTag auf GESTERN setzen, Guthaben geben,
//            UND db.private[<opferId>].__attackShieldUntil = 0..."
//
// DER ANFÄNGERSCHUTZ MUSS DABEI WEG, sonst misst Abschnitt 5 gar nichts: Frisch angelegte Konten
// bekommen einen Schutzschild, und /api/attack antwortet dann mit 403, ohne dass je ein Kampf
// stattfindet. Beim ersten Anlauf sah das aus wie "der Verteidiger verliert immer" - die Vorab-
// Prüfung führt deshalb die Antworten des Servers mit, statt nur "abgewehrt: 0" zu melden.
//   PORT=3215 JWT_SECRET=test node server.js > /tmp/s2.log 2>&1 &
//   PID=$!; sleep 3; node tests/test_sternenstaub_http.js teil2; kill $PID; rm -f "$DB"
//
// GEGENPROBE, in beide Richtungen gefahren (15.08.2026):
//   Gegen den alten server.js:  FAIL - 1a: /api/me führt einen Staub-Stand (undefined)
//   Gegen eine Kopie ohne den Tagesschlüssel-Riegel (letzterTag-Prüfung entfernt):
//     FAIL - 1b: ein zweiter Aufruf am selben Tag schreibt NICHTS gut  (Stand steigt weiter)
//   Gegen eine Kopie ohne die Angreifer-Sperre:
//     FAIL - 5: derselbe Angreifer zählt nur einmal am Tag

const BASIS = 'http://127.0.0.1:3215/api';
const TEIL = process.argv[2] || 'teil1';
const PASSWORT = 'geheim12345';
const OPFER = 'staubopfer';      // verteidigt
const TAETER = 'staubtaeter';    // greift an und verliert

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };

async function j(pfad, opt) {
  const r = await fetch(BASIS + pfad, opt);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; }
  catch (e) { return { status: r.status, body: t.slice(0, 200) }; }
}
const alsNutzer = (token, extra) => Object.assign({ 'Authorization': 'Bearer ' + token }, extra || {});
const anmelden = async (name) => {
  const r = await j('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: PASSWORT }) });
  return (r.body && r.body.token) || null;
};
const staubVon = async (token) => ((await j('/me', { headers: alsNutzer(token) })).body || {}).staub || {};

// Ein Spielstand, der den Verteidiger klar überlegen macht. Der Kampf bleibt zufällig (drei Phasen,
// je 19,6-80,4 %), aber ein Angriff mit einem einzelnen Jäger gegen eine ausgebaute Verteidigung
// geht in aller Regel verloren. Der Test rechnet deshalb NICHT damit, dass jeder Angriff abgewehrt
// wird - er zählt die tatsächlich abgewehrten und prüft die Gutschrift GEGEN DIESE ZAHL.
const starkerStand = JSON.stringify({
  resources: {}, research: {}, colonies: {},
  buildings: { turm: 30, schild: 30, laser: 30, plasma: 30, gauss: 30, raketen: 30 },
  fleet: { jaeger: 400, schlachtschiff: 60, missions: [] }, battlePoints: 0, prestige: 0
});
const schwacherStand = JSON.stringify({
  resources: {}, research: {}, colonies: {},
  buildings: {}, fleet: { jaeger: 1, missions: [] }, battlePoints: 0, prestige: 0
});

async function anlegen(name, mail) {
  const fs = require('fs');
  await j('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: PASSWORT, email: mail }) });
  await new Promise(r => setTimeout(r, 700));
  const db = JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8'));
  const u = db.users[name];
  const eintrag = Object.entries(db.verifyTokens || {}).find(([, v]) => u && v.userId === u.userId);
  if (eintrag) await j('/verify-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: eintrag[0] }) });
  return anmelden(name);
}

async function teil1() {
  const tokenO = await anlegen(OPFER, 'so@example.invalid');
  const tokenT = await anlegen(TAETER, 'st@example.invalid');
  check('Beide Konten angemeldet', !!tokenO && !!tokenT);
  if (!tokenO || !tokenT) return;
  // Die Spielstände schreiben, BEVOR angegriffen wird: Der Server rechnet Angriffs- und
  // Verteidigungskraft aus dem gespeicherten Stand. Ohne diesen Schritt stünden zwei leere Konten
  // gegeneinander, der Ausgang wäre beliebig, und Prüfung 5 hätte nichts gemessen.
  const pO = await j('/storage/kepler7-save-v3', { method: 'PUT', headers: alsNutzer(tokenO, { 'Content-Type': 'application/json' }), body: JSON.stringify({ value: starkerStand }) });
  const pT = await j('/storage/kepler7-save-v3', { method: 'PUT', headers: alsNutzer(tokenT, { 'Content-Type': 'application/json' }), body: JSON.stringify({ value: schwacherStand }) });
  check('Spielstände angenommen', pO.status === 200 && pT.status === 200, { opfer: pO.status, taeter: pT.status });

  // ---- 1. Tagesgutschrift ----------------------------------------------------------------------
  // Der erste /api/me lief bereits in anlegen() nicht - die Gutschrift fällt also hier zum ersten
  // Mal an. Verglichen wird gegen die SÄTZE, die der Server selbst meldet, nicht gegen getippte
  // Zahlen (CLAUDE.md-Regel 2): eine geänderte Konstante soll diesen Test nicht rot machen.
  const s1 = await staubVon(tokenO);
  check('1a: /api/me führt einen Staub-Stand', typeof s1.menge === 'number', s1);
  const saetze = s1.saetze || {};
  check('1a: die erste Anmeldung schreibt den Grundbetrag gut',
    s1.menge === saetze.anmeldung && s1.serie === 1, { menge: s1.menge, serie: s1.serie, satz: saetze.anmeldung });
  check('1a: und meldet sie als neu', s1.neu === saetze.anmeldung, { neu: s1.neu });

  // DIE WICHTIGSTE PRÜFUNG DER DATEI: Neuladen darf nichts bringen.
  const s2 = await staubVon(tokenO);
  const s3 = await staubVon(tokenO);
  check('1b: ein zweiter Aufruf am selben Tag schreibt NICHTS gut',
    s2.menge === s1.menge && s3.menge === s1.menge, { erst: s1.menge, dann: s2.menge, danach: s3.menge });
  check('1b: und meldet auch nichts als neu', s2.neu === 0 && s3.neu === 0, { neu2: s2.neu, neu3: s3.neu });

  // ---- 2. Laden ---------------------------------------------------------------------------------
  const k = await j('/cosmetics', { headers: alsNutzer(tokenO) });
  const katalog = (k.body || {}).katalog || [];
  const kaeuflich = katalog.filter(d => d.bedingung.typ === 'kauf').sort((a, b) => a.bedingung.preis - b.bedingung.preis);
  check('2-vorab: es gibt käufliche Stücke', kaeuflich.length > 0, kaeuflich.map(d => d.key + ':' + d.bedingung.preis));
  if (!kaeuflich.length) return;
  const billigstes = kaeuflich[0];

  // Zu wenig Staub -> 402, und der Fehler sagt, wie viel fehlt.
  const arm = await j('/cosmetics/buy', { method: 'POST', headers: alsNutzer(tokenO, { 'Content-Type': 'application/json' }), body: JSON.stringify({ key: billigstes.key }) });
  check('2a: ohne genug Staub wird abgelehnt', arm.status === 402, { status: arm.status });
  check('2a: und die Antwort nennt den Fehlbetrag',
    arm.body && arm.body.fehlt === billigstes.bedingung.preis - s1.menge, { fehlt: arm.body && arm.body.fehlt, erwartet: billigstes.bedingung.preis - s1.menge });

  // Ein NICHT käufliches Stück ist auch mit Geld nicht zu haben - sonst wäre der Laden ein Umweg um
  // die Fortschritts- und Spender-Bedingungen. Der GRUND wird mitgeprüft (Regel 28).
  const nichtKaeuflich = katalog.find(d => d.bedingung.typ === 'spender');
  if (nichtKaeuflich) {
    const r = await j('/cosmetics/buy', { method: 'POST', headers: alsNutzer(tokenO, { 'Content-Type': 'application/json' }), body: JSON.stringify({ key: nichtKaeuflich.key }) });
    check('2b: ein nicht käufliches Stück wird abgelehnt', r.status === 400, { status: r.status });
    check('2b: und zwar wegen der Art, nicht wegen des Preises',
      /nicht käuflich/i.test((r.body && r.body.error) || ''), r.body && r.body.error);
  }
  await new Promise(r => setTimeout(r, 900));
}

// Ab hier hat der Aufrufer (a) den Tagesschlüssel auf GESTERN zurückdatiert und (b) dem Opfer genug
// Staub für einen Kauf gegeben.
async function teil2() {
  const fs = require('fs');
  const tokenO = await anmelden(OPFER);
  const tokenT = await anmelden(TAETER);
  check('3: Anmeldung nach Neustart', !!tokenO && !!tokenT);
  if (!tokenO || !tokenT) return;

  // ---- 3. Serie ---------------------------------------------------------------------------------
  const vorher = JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8')).users[OPFER].staub;
  const s = await staubVon(tokenO);
  const saetze = s.saetze || {};
  check('3: ein lückenlos folgender Tag zählt die Serie hoch', s.serie === (vorher.serie || 0) + 1,
    { vorher: vorher.serie, jetzt: s.serie });
  const erwartet = saetze.anmeldung + (s.serie - 1) * saetze.serieBonus;
  check('3: und der Serienbonus schlägt sich im Betrag nieder', s.neu === erwartet, { neu: s.neu, erwartet });

  // ---- 4. Kaufen ---------------------------------------------------------------------------------
  const k = await j('/cosmetics', { headers: alsNutzer(tokenO) });
  const katalog = (k.body || {}).katalog || [];
  const billigstes = katalog.filter(d => d.bedingung.typ === 'kauf').sort((a, b) => a.bedingung.preis - b.bedingung.preis)[0];
  const standVor = (await staubVon(tokenO)).menge;
  const kauf = await j('/cosmetics/buy', { method: 'POST', headers: alsNutzer(tokenO, { 'Content-Type': 'application/json' }), body: JSON.stringify({ key: billigstes.key }) });
  check('4: der Kauf gelingt', kauf.status === 200 && kauf.body.ok === true, { status: kauf.status, body: kauf.body && kauf.body.error });
  check('4: genau der Preis wird abgebucht',
    kauf.body && kauf.body.staub && kauf.body.staub.menge === standVor - billigstes.bedingung.preis,
    { vorher: standVor, nachher: kauf.body && kauf.body.staub && kauf.body.staub.menge, preis: billigstes.bedingung.preis });
  check('4: und das Stück gilt als Besitz',
    kauf.body && (kauf.body.besitz || []).indexOf(billigstes.key) !== -1, kauf.body && kauf.body.besitz);
  // Es lässt sich danach auch wirklich tragen - der Kauf ist erst dann etwas wert.
  const eq = await j('/cosmetics/equip', { method: 'POST', headers: alsNutzer(tokenO, { 'Content-Type': 'application/json' }), body: JSON.stringify({ auswahl: { [billigstes.art]: billigstes.key } }) });
  check('4: und tragen lässt es sich auch', eq.status === 200, { status: eq.status, body: eq.body && eq.body.error });
  const nochmal = await j('/cosmetics/buy', { method: 'POST', headers: alsNutzer(tokenO, { 'Content-Type': 'application/json' }), body: JSON.stringify({ key: billigstes.key }) });
  check('4: ein zweiter Kauf desselben Stücks wird abgelehnt', nochmal.status === 409, { status: nochmal.status });

  // ---- 5. Abwehr: je Angreifer nur einmal am Tag ------------------------------------------------
  // Die Kampfauflösung ist zufällig (drei Phasen, je 19,6-80,4 %). Der Test rechnet deshalb nicht
  // damit, dass jeder Angriff abgewehrt wird - er ZÄHLT die abgewehrten und prüft die Gutschrift
  // gegen diese Zahl. Damit ist die Aussage auch dann richtig, wenn ein Angriff durchkommt.
  const opferId = ((await j('/me', { headers: alsNutzer(tokenO) })).body || {}).userId;
  const vorAbwehr = (await staubVon(tokenO)).menge;
  let abgewehrt = 0;
  const antworten = [];
  for (let i = 0; i < 5; i++) {
    const a = await j('/attack', { method: 'POST', headers: alsNutzer(tokenT, { 'Content-Type': 'application/json' }), body: JSON.stringify({ targetUserId: opferId }) });
    if (a.status === 200 && a.body && a.body.success === false) abgewehrt++;
    // Die Antworten werden mitgeführt, damit ein Fehlschlag der Vorab-Prüfung SAGT, woran es lag.
    // Ohne das meldete der Test nur "abgewehrt: 0" - und die eigentliche Ursache (Schutzschild für
    // neue Konten, abgelaufene Sitzung, Ratenbremse) müsste von Hand gesucht werden.
    antworten.push(a.status + (a.status === 200 ? (a.body.success ? ':durchgekommen' : ':abgewehrt') : ':' + String((a.body && a.body.error) || '').slice(0, 45)));
    await new Promise(r => setTimeout(r, 150));
  }
  check('5-vorab: mindestens ein Angriff wurde abgewehrt', abgewehrt > 0, { abgewehrt, antworten });
  const nachAbwehr = (await staubVon(tokenO)).menge;
  const gutschrift = nachAbwehr - vorAbwehr;
  // DIE REGEL: egal wie viele Angriffe dieser eine Gegner verloren hat, es zählt genau einer.
  check('5: derselbe Angreifer zählt nur einmal am Tag',
    abgewehrt === 0 || gutschrift === (saetze.abwehr || 3), { abgewehrt, gutschrift, satz: saetze.abwehr });
  const stand = await staubVon(tokenO);
  check('5: und der Zähler des Tages steht auf 1', abgewehrt === 0 || stand.abwehrHeute === 1, { abwehrHeute: stand.abwehrHeute });
}

(async () => {
  // Ein Absturz darf NICHT als grün durchgehen: ohne das try/catch endete der Prozess mit einer
  // unbehandelten Zurückweisung, und je nach Node-Fassung ist das ein anderer Exit-Code als der,
  // den die Suite erwartet (CLAUDE.md-Regel 25: der Exit-Code ist die Wahrheit).
  try {
    if (TEIL === 'teil2') await teil2(); else await teil1();
  } catch (e) {
    check('Ablauf ohne Absturz', false, String((e && e.message) || e));
  }
  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nalles gruen');
  process.exit(fail ? 1 : 0);
})();
