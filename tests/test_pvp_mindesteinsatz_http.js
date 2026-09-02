// PvP-Mindesteinsatz (03.09.2026, Balance-Entscheidung Sascha): Ein Angriff, dessen geschickte
// Flotte weniger als PVP_MINDESTEINSATZ der Reichs-Rohkraft traegt, wird NICHT abgelehnt, sondern
// ERTRAGLOS - keine Kampfpunkte, kein Anlagenschaden, kein Flottenverlust beim Ziel. Beute und
// Siegchance bleiben unveraendert.
//
// BEFUND, DER DAZU FUEHRTE: computeAttackPower rechnet ueber allFleetsOf (die ganze Reichsflotte),
// die Verluste zieht der Client nur aus m.composition. Ein Angriff mit EINEM Jaeger kaempfte also
// mit voller Reichskraft und riskierte einen Jaeger - fuer +25 Kampfpunkte, zerstoerte Anlagen und
// Flottenverlust beim Ziel.
//
// AUFBAU - EIN Bash-Aufruf, sonst verliert die Sandbox den Hintergrundprozess. Der Schalter ist
// eine Code-Konstante, deshalb misst dieser Test ZWEI Serverstaende: server.js (Schalter aus, der
// Paritaetsanker) und eine Kopie mit umgelegtem Schalter. Die Kopie liegt im REPO-Verzeichnis,
// sonst loest `require('./mailer')` nicht auf.
//   DB=$(mktemp ...); export DB_FILE="$DB"
//   PORT=3247 JWT_SECRET=test node server.js & sleep 4
//   node tests/test_pvp_mindesteinsatz_http.js teil1     # Konten + Missionen anlegen
//   kill; Anfaengerschutz bei GESTOPPTEM Server nullen (sonst flusht der Shutdown es weg)
//   PORT=3247 JWT_SECRET=test node server.js & sleep 4
//   node tests/test_pvp_mindesteinsatz_http.js aus       # Schalter AUS: Altwerte
//   kill; sed 's/PVP_MINDESTEINSATZ_AKTIV = false/= true/' server.js > server.an.js
//   PORT=3247 JWT_SECRET=test node server.an.js & sleep 4
//   node tests/test_pvp_mindesteinsatz_http.js an        # Schalter AN: Sockel und Gnadenfrist
//
// WARUM DIE PRUEFUNGEN ERGEBNISUNABHAENGIG SIND: battleWinChance deckelt bei 90 %, jeder zehnte
// Angriff geht also auch bei Uebermacht verloren. Kampfpunkte sind trotzdem eindeutig messbar:
// voll = 25 (Sieg) oder 3 (Niederlage), Sockel = 0 in BEIDEN Faellen. Die Pruefungen lesen
// deshalb die DIFFERENZ am Spielstand, nicht den Ausgang. Anlagenschaden und Flottenverlust
// gibt es nur im Sieg - die zwei Pruefungen dazu melden bei einer Niederlage ausdruecklich
// "nicht gemessen" statt gruen zu behaupten, was sie nicht gesehen haben.
//
// Belegte Testports sind 3195-3246 - dieser nimmt 3247, ein neuer 3248.
const http = require('http');
const fs = require('fs');
const PORT = process.env.TEST_PORT || 3247;
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
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, body: j }); });
    });
    req.on('error', e => resolve({ status: 0, body: null, roh: String(e) }));
    if (daten) req.write(daten);
    req.end();
  });
}
// Das attackRateLimit (20/min je IP+Pfad) ist Eigenschaft des Messaufbaus, kein Messgegenstand.
async function angriffAnfrage(token, body) {
  for (let i = 0; i < 3; i++) {
    const r = await anfrage('POST', '/api/attack', token, body);
    if (r.status !== 429) return r;
    const wartezeit = (parseInt((r.headers || {})['retry-after'], 10) || 61) + 1;
    console.log('     (429 vom attackRateLimit - warte ' + wartezeit + 's)');
    await new Promise(res => setTimeout(res, wartezeit * 1000));
  }
  return { status: 429, body: null };
}
function liesDb() { return JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8')); }
// Beide Speicherformen (blanke Zeichenkette oder { value, version }) - Regel 34.
function liesSave(db, userId) {
  const e = db.private[userId] && db.private[userId]['kepler7-save-v3'];
  if (e === undefined || e === null) return null;
  try { return JSON.parse(typeof e === 'string' ? e : e.value); } catch (x) { return null; }
}
function punkte(userId) { const s = liesSave(liesDb(), userId); return (s && s.battlePoints) || 0; }

async function konto(name, save) {
  await anfrage('POST', '/api/register', null, { username: name, password: 'geheim-123', email: name + '@example.invalid' });
  await new Promise(r => setTimeout(r, 700));
  const db = liesDb();
  const u = db.users[name];
  const eintrag = Object.entries(db.verifyTokens || {}).find(([, v]) => u && v.userId === u.userId);
  if (eintrag) await anfrage('POST', '/api/verify-email', null, { token: eintrag[0] });
  const login = await anfrage('POST', '/api/login', null, { username: name, password: 'geheim-123' });
  const token = login.body && login.body.token;
  await anfrage('PUT', '/api/storage/kepler7-save-v3', token, { value: JSON.stringify(save) });
  return { token, userId: u && u.userId };
}

// --- Fixtures --------------------------------------------------------------------------------
// Der Angreifer haelt eine grosse Reichsflotte UND zwei Angriffsmissionen: eine winzige (weit
// unter der Schwelle) und eine grosse (deutlich darueber). Beide zeigen auf dasselbe Ziel-Muster;
// die Ziel-ID wird in teil1 nachgetragen, weil sie erst nach dem Anlegen feststeht.
const ANGREIFER = () => ({
  resources: { erz: 1e5, kristalle: 1e5, deuterium: 1e5, energie: 1e5, antimaterie: 1e4, forschungspunkte: 1000 },
  credits: 1000, buildings: { lager: 60, werft: 10 }, research: {},
  fleet: { cruisers: 1000, missions: [] }, colonies: {}, battlePoints: 0
});
// Schwach genug, dass der Angreifer fast immer gewinnt; mit Anlagen, damit Zerstoerung messbar
// ist, und mit Flotte, damit defenderLossPct etwas zu treffen haette.
const OPFER = () => ({
  resources: { erz: 1e6, kristalle: 1e5, deuterium: 1e5, energie: 1e5 },
  credits: 100, buildings: { lager: 20, turm: 3 }, research: {},
  fleet: { jaeger: 40 }, colonies: {}
});

// Fuer die sieg-abhaengigen Messungen (C5/C6 und E1) je DREI Opfer: battleWinChance deckelt bei
// 90 %, jeder zehnte Angriff geht also auch bei Uebermacht verloren. Mit drei Anlaeufen liegt die
// Wahrscheinlichkeit, dass eine Messung ausfaellt, bei 0,1 % statt 10 %.
const OPFER_NAMEN = ['mepfa', 'mepfb', 'mepfc1', 'mepfc2', 'mepfc3', 'mepfd',
                     'mepfe1', 'mepfe2', 'mepfe3', 'mepff'];
const ABLAGE = '/tmp/kepler-mindesteinsatz-ids.json';

(async () => {
  const modus = process.argv[2] || 'teil1';

  if (modus === 'teil1') {
    const A = await konto('meangreifer', ANGREIFER());
    const O = {};
    for (const n of OPFER_NAMEN) O[n] = await konto(n, OPFER());
    // Die zwei Missionen tragen die echte Ziel-ID - pvpFindeAngriffsmission prueft sie mit.
    // Sie stehen in der HEIMATflotte; ihre composition ist das, was der Server als Einsatz liest.
    const save = ANGREIFER();
    save.fleet.missions = [
      { id: 'mini',  type: 'attack-player', targetId: O.mepfa.userId, composition: { cruisers: 1 } },
      { id: 'gross', type: 'attack-player', targetId: O.mepfa.userId, composition: { cruisers: 900 } },
    ];
    // Fuer jedes Opfer eine eigene Mini- und Gross-Mission, damit jede Messung ein frisches Ziel
    // bekommt (ein gewonnener Angriff setzt den Schild).
    for (const n of OPFER_NAMEN) {
      save.fleet.missions.push({ id: 'mini-' + n,  type: 'attack-player', targetId: O[n].userId, composition: { cruisers: 1 } });
      save.fleet.missions.push({ id: 'gross-' + n, type: 'attack-player', targetId: O[n].userId, composition: { cruisers: 900 } });
    }
    await anfrage('PUT', '/api/storage/kepler7-save-v3', A.token, { value: JSON.stringify(save) });
    fs.writeFileSync(ABLAGE, JSON.stringify({ A, O }));
    check('teil1: Angreifer und ' + OPFER_NAMEN.length + ' Opfer angelegt, Missionen geschrieben',
      !!A.userId && OPFER_NAMEN.every(n => O[n].userId), { opfer: OPFER_NAMEN.length });
    console.log(fehl ? '\nFEHLGESCHLAGEN' : '\nPASS');
    process.exit(fehl);
  }

  const { A, O } = JSON.parse(fs.readFileSync(ABLAGE, 'utf8'));
  // Eine Messung: Angriff fahren, Punktedifferenz am SPIELSTAND lesen (nicht aus der Antwort -
  // der Server ist die Autoritaet, und genau seine Buchung ist der Messgegenstand).
  const erzVon = (uid) => { const s2 = liesSave(liesDb(), uid); return (s2 && s2.resources && s2.resources.erz) || 0; };
  async function messung(opferName, body) {
    const vorher = punkte(A.userId);
    const opferId = opferName && O[opferName] ? O[opferName].userId : null;
    const erzVorher = opferId ? erzVon(opferId) : null;
    const r = await angriffAnfrage(A.token, body);
    await new Promise(x => setTimeout(x, 400));
    return { r, delta: punkte(A.userId) - vorher, b: (r && r.body) || {},
             opferErzVorher: erzVorher, opferErzNachher: opferId ? erzVon(opferId) : null };
  }

  if (modus === 'aus') {
    // PARITAETSANKER: Schalter aus -> alles wie vorher, AUCH mit missionId einer Mini-Mission.
    const m = await messung('mepfa', { targetUserId: O.mepfa.userId, missionId: 'mini-mepfa' });
    check('A1: Schalter AUS - der Angriff laeuft', m.r.status === 200, { status: m.r.status, fehler: m.b.error });
    check('A2: Schalter AUS - Mini-Mission bekommt trotzdem Kampfpunkte (Paritaetsanker)',
      m.delta === 25 || m.delta === 3, { delta: m.delta, sieg: m.b.success });
    check('A3: Schalter AUS - die Antwort meldet ertragStufe "voll"',
      m.b.ertragStufe === 'voll', { ertragStufe: m.b.ertragStufe, einsatzAnteil: m.b.einsatzAnteil });
    check('A4: Schalter AUS - der Anteil wird gar nicht erst gerechnet',
      m.b.einsatzAnteil === null, { einsatzAnteil: m.b.einsatzAnteil });
    if (m.b.success) {
      check('A5: Schalter AUS - der Verteidiger verliert Flotte',
        typeof m.b.defenderLossPct === 'number' && m.b.defenderLossPct > 0, { defenderLossPct: m.b.defenderLossPct });
    } else {
      console.log('     (A5 nicht gemessen - dieser Angriff ging verloren, Flottenverlust gibt es nur im Sieg)');
    }
    console.log(fehl ? '\nFEHLGESCHLAGEN' : '\nPASS');
    process.exit(fehl);
  }

  if (modus === 'an') {
    // B: Gnadenfrist - ein Client ohne missionId bekommt weiterhin vollen Ertrag.
    const b = await messung('mepfb', { targetUserId: O.mepfb.userId });
    check('B1: Schalter AN, OHNE missionId - Gnadenfrist, voller Ertrag',
      b.delta === 25 || b.delta === 3, { delta: b.delta, ertragStufe: b.b.ertragStufe });
    check('B2: und die Stufe heisst "voll"', b.b.ertragStufe === 'voll', { ertragStufe: b.b.ertragStufe });

    /* C: Der Kern - Mini-Mission bekommt NICHTS. Die Punktepruefung C1 gilt fuer BEIDE Ausgaenge
       (voll waere 25 oder 3, Sockel ist 0), C5/C6 nur im Sieg - dafuer bis zu drei frische Opfer.
       Ein "nicht gemessen" waere hier das schlechtere Ergebnis: C5/C6 sind die eigentliche
       Zusage der Regel. */
    let c = null;
    for (const n of ['mepfc1', 'mepfc2', 'mepfc3']) {
      c = await messung(n, { targetUserId: O[n].userId, missionId: 'mini-' + n });
      if (c.b.success) break;
      console.log('     (Anlauf ' + n + ' ging verloren - naechstes frisches Opfer)');
    }
    check('C1: Schalter AN, Mini-Mission - KEINE Kampfpunkte, weder bei Sieg noch bei Niederlage',
      c.delta === 0, { delta: c.delta, sieg: c.b.success });
    check('C0: die Sieg-Messung kam zustande (sonst sind C5/C6 nur uebersprungen)',
      c.b.success === true, { sieg: c.b.success });
    check('C2: die Antwort weist den Sockel aus', c.b.ertragStufe === 'sockel', { ertragStufe: c.b.ertragStufe });
    check('C3: und nennt den gemessenen Anteil unter der Schwelle',
      typeof c.b.einsatzAnteil === 'number' && c.b.einsatzAnteil < 0.25, { einsatzAnteil: c.b.einsatzAnteil });
    check('C4: der Angriff wird NICHT abgelehnt - er laeuft, er bringt nur nichts',
      c.r.status === 200, { status: c.r.status, fehler: c.b.error });
    check('C5: kein Flottenverlust beim Ziel', c.b.success && c.b.defenderLossPct === 0,
      { sieg: c.b.success, defenderLossPct: c.b.defenderLossPct });
    /* C7 ist der teuerste Teil der Regel: Der Server kennt keinen Frachtdeckel und zog dem Ziel
       bisher IMMER den vollen Satz ab - der groesste Teil wurde vernichtet, weil ihn niemand
       tragen konnte. Geprueft wird deshalb BEIDES: dass die Antwort nichts meldet, UND dass am
       Spielstand des Opfers wirklich nichts fehlt. Nur das zweite ist der Beweis. */
    check('C7: keine Beute in der Antwort',
      c.b.success && c.b.stolen && Object.keys(c.b.stolen).length === 0, { stolen: c.b.stolen });
    check('C8: und im Spielstand des Opfers fehlt nichts',
      c.opferErzNachher === c.opferErzVorher, { vorher: c.opferErzVorher, nachher: c.opferErzNachher });

    check('C6: keine Anlage zerstoert',
      c.b.success && !c.b.destroyedBuilding && !c.b.destroyedBuildingCount,
      { sieg: c.b.success, gebaeude: c.b.destroyedBuilding, anzahl: c.b.destroyedBuildingCount });

    // D: Ueber der Schwelle - voller Ertrag.
    const d = await messung('mepfd', { targetUserId: O.mepfd.userId, missionId: 'gross-mepfd' });
    check('D1: Schalter AN, grosse Mission - voller Ertrag',
      d.delta === 25 || d.delta === 3, { delta: d.delta, sieg: d.b.success });
    check('D2: die Stufe heisst "voll"', d.b.ertragStufe === 'voll', { ertragStufe: d.b.ertragStufe });
    check('D3: und der Anteil liegt ueber der Schwelle',
      typeof d.b.einsatzAnteil === 'number' && d.b.einsatzAnteil >= 0.25, { einsatzAnteil: d.b.einsatzAnteil });

    // E: Der Schild haengt NICHT mehr am Ertrag. Ein Sockel-Angriff nimmt nichts mit und richtet
    //    nichts an - das Opfer muss trotzdem geschuetzt sein, sonst ist das Dauer-Farmen wieder
    //    offen, gegen das der Schild eingefuehrt wurde.
    let eName = null, e1 = null;
    for (const n of ['mepfe1', 'mepfe2', 'mepfe3']) {
      e1 = await messung(n, { targetUserId: O[n].userId, missionId: 'mini-' + n });
      eName = n;
      if (e1.b.success) break;
      console.log('     (Anlauf ' + n + ' ging verloren - naechstes frisches Opfer)');
    }
    const e2 = await angriffAnfrage(A.token, { targetUserId: O[eName].userId, missionId: 'mini-' + eName });
    check('E0: die Sieg-Messung kam zustande', e1.b.success === true, { sieg: e1.b.success, opfer: eName });
    check('E1: nach einem gewonnenen SOCKEL-Angriff steht das Opfer unter Schutzschild',
      e1.b.success && e2.status === 403 && /Schutzschild/.test((e2.body || {}).error || ''),
      { ersterSieg: e1.b.success, zweiterStatus: e2.status, fehler: (e2.body || {}).error });

    // F: Eine unbekannte missionId darf nicht bestrafen - sonst waere ein Tippfehler im Client
    //    eine stille Ertragssperre.
    const f = await messung('mepff', { targetUserId: O.mepff.userId, missionId: 'gibtsnicht' });
    check('F1: unbekannte missionId -> voller Ertrag, keine stille Sperre',
      (f.delta === 25 || f.delta === 3) && f.b.ertragStufe === 'voll',
      { delta: f.delta, ertragStufe: f.b.ertragStufe });

    console.log(fehl ? '\nFEHLGESCHLAGEN' : '\nPASS');
    process.exit(fehl);
  }
  console.log('Unbekannter Modus: ' + modus); process.exit(1);
})();
