// Darf ein beliebiger eingeloggter Nutzer den GEMEINSAMEN Weltboss überschreiben?
//
// `worldboss:current` ist der einzige Schlüssel dieses Spiels, an dem ALLE Spieler gemeinsam
// arbeiten: ein Boss, HP, eine Beitragsliste. Die Schadensauflösung ist seit dem 13.07.2026
// gehärtet (/api/worldboss/resolve rechnet den Schaden serverseitig aus dem echten Spielstand) –
// der SCHLÜSSEL selbst blieb dabei aber offen. Er lief durch keine der fünf Rechteprüfungen des
// geteilten Speichers, also galt für ihn die Grundregel aus CLAUDE.md: „Generischer Shared-Storage
// ohne Sonderregel ist für JEDEN eingeloggten Nutzer weit offen (lesen UND schreiben)."
//
// WAS DAS WERT IST – und was ausdrücklich NICHT:
// Der eigene Spielstand ist in diesem Spiel bauartbedingt klientenautoritativ (der Server prüft ihn
// nur gegen die großzügigen SAVE_SANITY_LIMITS). Wer sich selbst Kredite geben will, braucht dafür
// keine Lücke im Weltboss – er schreibt sie direkt in den eigenen Spielstand. Die Grenze, die hier
// wirklich verläuft, ist deshalb eine andere: „Kann ich etwas anfassen, das ANDEREN gehört?" Genau
// an dieser Grenze liegen auch alle bisherigen Härtungen (Pakt, Chat, Bestenliste, Mondverteidigung,
// Allianz). Gegen sie gemessen wiegt der offene Boss-Schlüssel schwer, und zwar in drei Richtungen:
//
//   1. EINE Anfrage tötet das Feature dauerhaft für alle. loadWorldBoss() im Frontend erneuert den
//      Boss NUR nach einem Kill (defeatedAt + Respawn-Frist). Ein Boss mit absurd hoher Stufe hat
//      50000 * 1,6^(Stufe-1) HP, ist also nie tötbar – und wird deshalb auch nie ersetzt.
//   2. Fremde Konten lassen sich in die Beitragsliste eintragen. maybeClaimWorldBossReward() im
//      Frontend zahlt allein anhand dieser Liste aus (Kredite, Kampfpunkte, Modulwurf, Unikat
//      „Leviathanherz") – der Server ist an dieser Auszahlung gar nicht beteiligt.
//   3. `defeatedAt` lässt sich ohne einen einzigen Kampf setzen.
//
// GEMESSEN, NICHT BEHAUPTET: Der Test schreibt die Fälschungen an den echten Endpunkten und liest
// den Boss danach aus der Datenbankdatei zurück.
//
// ZWEI SERVERLÄUFE, weil zwei Ausgangszustände geprüft werden müssen und der Server seine
// Datenbank im Speicher hält (eine Änderung an der Datei unter ihm durch wäre wirkungslos):
//   Lauf 1 startet OHNE Boss  -> erster Spawn, alle Fälschungen, echter Schadensweg.
//   Lauf 2 startet mit einem GEFALLENEN Boss samt abgelaufener Frist -> der echte Respawn.
//
// AUSFÜHREN: npm install (einmalig), dann node tests/test_weltboss_schluessel_http.js
//
// GEGENPROBE (beide Richtungen, 10.08.2026): Am Stand VOR der Behebung sind die fünf
// „wird abgelehnt"-Prüfungen (2a–2e) rot, und 3 zeigt den zerstörten Boss in der Datenbank. Danach
// ist alles grün. Die Kontrollprüfungen 1a/1b/4/5 (Lesen bleibt offen, erster Spawn und echter
// Respawn gehen weiterhin durch, /api/worldboss/resolve trägt weiterhin Schaden ein) sind in BEIDEN
// Läufen grün – eine Sperre, die stumpf alles ablehnt, käme damit nicht durch.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WURZEL = path.resolve(__dirname, '..');
// Zwei Läufe = zwei Ports (BASIS_PORT und BASIS_PORT+1). Bewusst oberhalb der Ports der übrigen
// Tests (3195–3199): Die erste Fassung stand auf 3198 und belegte damit auch die 3199 von
// test_systemliste_http.js – der fiel danach mit ECONNREFUSED aus, und der Fehler sah aus, als läge
// er an der Härtung. Wer hier einen Test dazustellt, prüft die Liste oben mit.
const BASIS_PORT = 3210;

let fail = false;
const check = (n, c, x) => { console.log((c ? 'OK  ' : 'FAIL') + ' - ' + n + (x !== undefined ? ' | ' + JSON.stringify(x) : '')); fail = fail || !c; };

const bcrypt = require(path.join(WURZEL, 'node_modules', 'bcryptjs'));
const crypto = require('crypto');
const hash = bcrypt.hashSync('test1234', 10);
const ANNA = crypto.randomUUID();
const BERT = crypto.randomUUID();

const RESPAWN_MS = 10 * 60 * 1000; // Spiegel von WORLDBOSS_RESPAWN_DELAY_MS im Frontend
const BASIS_HP = 50000;            // Spiegel von WORLDBOSS_BASE_HP im Frontend
const hpFuer = stufe => Math.round(BASIS_HP * Math.pow(1.6, Math.max(0, stufe - 1)));

function spielstand(felder) {
  return Object.assign({
    resources: { energie: 5e5, erz: 5e5, kristalle: 5e5, deuterium: 5e5, antimaterie: 100, forschungspunkte: 100 },
    buildings: {}, research: {}, colonies: {},
    fleet: { jaeger: 500, cruisers: 200, missions: [] },
    player: { id: 'p', name: 'A' }, credits: 1000, xp: 1000, prestige: 0, battlePoints: 0,
    lastTick: Date.now()
  }, felder || {});
}

const MISSION_ID = 'm-weltboss-1';
const BOSS_ID = 'wb1_test';

function grunddb(sharedSeed, annaFelder) {
  return {
    users: {
      anna: { userId: ANNA, username: 'anna', passwordHash: hash, createdAt: Date.now() },
      bert: { userId: BERT, username: 'bert', passwordHash: hash, createdAt: Date.now() }
    },
    private: {
      [ANNA]: { 'kepler7-save-v3': JSON.stringify(spielstand(Object.assign({ player: { id: ANNA, name: 'anna' } }, annaFelder))) },
      [BERT]: { 'kepler7-save-v3': JSON.stringify(spielstand({ player: { id: BERT, name: 'bert' } })) }
    },
    shared: sharedSeed || {},
    resetTokens: {},
    galaxy: {
      npcEmpireStrength: 1, marketTrend: 1, collapsedSystems: {}, controlledSystems: {},
      news: [], activeWar: null, activeWormhole: null, lastTick: Date.now(), factions: {}
    }
  };
}

const warte = ms => new Promise(r => setTimeout(r, ms));

// Startet einen Server auf eigenem Port mit eigener Datenbankdatei und liefert die Werkzeuge, um
// gegen ihn zu sprechen. Der Aufrufer ruft `.ende()`, wenn er fertig ist.
async function starteServer(nr, dbInhalt) {
  const port = BASIS_PORT + nr;
  const dbPfad = path.join(os.tmpdir(), 'kepler-weltboss-' + process.pid + '-' + nr + '.json');
  fs.writeFileSync(dbPfad, JSON.stringify(dbInhalt, null, 1));
  let log = '';
  const srv = spawn(process.execPath, [path.join(WURZEL, 'server.js')], {
    cwd: WURZEL,
    env: Object.assign({}, process.env, { DB_FILE: dbPfad, PORT: String(port), JWT_SECRET: 'testsecret' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });
  const basis = 'http://127.0.0.1:' + port + '/api';
  const ende = () => { try { srv.kill(); } catch (e) {} try { fs.unlinkSync(dbPfad); } catch (e) {} };
  process.on('exit', ende);
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
  const bossAusDb = () => {
    try { return JSON.parse(JSON.parse(fs.readFileSync(dbPfad, 'utf8')).shared['worldboss:current']); }
    catch (e) { return null; }
  };
  return { j, anmelden, bossAusDb, ende, protokoll: () => log };
}

const frischerBoss = (stufe, id) => ({
  bossId: id || ('wb' + stufe + '_' + Date.now()), level: stufe,
  maxHp: hpFuer(stufe), hp: hpFuer(stufe), spawnedAt: Date.now(),
  contributions: {}, defeatedAt: null
});

(async () => {
  // ================= Lauf 1: leerer geteilter Speicher =========================================
  const s1 = await starteServer(0, grunddb({}, {
    fleet: { jaeger: 500, cruisers: 200, missions: [
      { id: MISSION_ID, type: 'worldboss', targetId: BOSS_ID, bossLevel: 1,
        startTime: Date.now() - 7200000, endTime: Date.now() - 3600000,
        composition: { jaeger: 300, cruisers: 100 } }
    ] }
  }));
  const tokenA = await s1.anmelden('anna');
  const tokenB = await s1.anmelden('bert');
  check('Anmeldung beider Konten erfolgreich', !!tokenA && !!tokenB);
  if (!tokenA || !tokenB) { console.log(s1.protokoll().slice(-1500)); process.exit(1); }
  const kopfA = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenA };
  const kopfB = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenB };
  const schreibeBoss = (kopf, doc) => s1.j('/storage/' + encodeURIComponent('worldboss:current') + '?shared=true',
    { method: 'PUT', headers: kopf, body: JSON.stringify({ value: JSON.stringify(doc) }) });

  // ---- 1. Kontrollprüfungen: der normale Ablauf muss durchgehen ---------------------------------
  // Beide sind an BEIDEN Ständen grün. Ohne sie könnte eine Sperre, die den Schlüssel einfach
  // komplett dichtmacht, den Test bestehen – und dabei das Feature abschalten, weil der Boss im
  // Frontend vom ERSTEN Client erzeugt wird, der keinen vorfindet (loadWorldBoss).
  {
    const r = await schreibeBoss(kopfA, frischerBoss(1, BOSS_ID));
    check('1a: der erste Client darf den Boss auf Stufe 1 anlegen', r.status === 200, { status: r.status, body: r.body });
    const g = await s1.j('/storage/' + encodeURIComponent('worldboss:current') + '?shared=true', { headers: kopfB });
    check('1b: jeder darf den Boss lesen', g.status === 200 && !!g.body.value, g.status);
  }

  // ---- 2. Die Fälschungen ----------------------------------------------------------------------
  // Vor der Behebung antwortet der Server auf alle fünf mit 200.
  //
  // JEDE Fälschung wird EINZELN nachgemessen, statt am Ende einmal auf den Endstand zu schauen.
  // Der erste Entwurf dieses Tests tat genau das – und die Messung war wertlos: Die letzte
  // Fälschung (2e) schrieb zufällig wieder Stufe 1 mit vollem maxHp, also sah der Endstand auch
  // am ungepatchten Server unauffällig aus und alle vier Endstands-Prüfungen waren grün, während
  // 2a einen Boss mit 2,08e45 HP durchgelassen hatte. Gemessen wird deshalb hier, direkt hinter
  // jedem einzelnen Schreibversuch.
  const echterBoss = frischerBoss(1, BOSS_ID);
  async function faelschung(name, kopf, doc) {
    const r = await schreibeBoss(kopf, doc);
    await warte(250);
    const nachher = s1.bossAusDb();
    check(name + ' – wird abgelehnt', r.status === 403, { status: r.status, fehler: r.body && r.body.error });
    const unberuehrt = !!nachher && nachher.level === echterBoss.level && nachher.maxHp === echterBoss.maxHp
      && nachher.hp === echterBoss.hp && !nachher.defeatedAt
      && !Object.keys(nachher.contributions || {}).length;
    check(name + ' – und landet nicht in der Datenbank', unberuehrt,
      nachher && { level: nachher.level, hp: nachher.hp, maxHp: nachher.maxHp,
        defeatedAt: nachher.defeatedAt, beitragende: Object.keys(nachher.contributions || {}).length });
  }
  {
    // (a) Ein Boss mit absurder Stufe hat 50000*1,6^(Stufe-1) HP. Bei Stufe 200 sind das rund
    // 1e44 – kein Spieler und keine Allianz bringt das je zusammen. Und weil das Frontend einen
    // neuen Boss NUR nach einem Kill setzt, bleibt dieser hier für immer stehen.
    await faelschung('2a: erfundene Stufe (Stufe 200 = 2,08e45 HP, nie tötbar)', kopfA, frischerBoss(200));

    // (b) Berts Konto in die Beitragsliste eintragen – Anna schreibt, Bert kassiert. Die Auszahlung
    // läuft rein im Frontend (maybeClaimWorldBossReward) und fragt den Server nie.
    const geschenkt = frischerBoss(1, BOSS_ID);
    geschenkt.contributions = { [BERT]: { name: 'bert', dmg: 999999 }, [ANNA]: { name: 'anna', dmg: 1 } };
    await faelschung('2b: erfundene Beitragsliste für ein fremdes Konto', kopfA, geschenkt);

    // (c) Den Boss für tot erklären, ohne einen Schuss abzugeben.
    const totgesagt = frischerBoss(1, BOSS_ID);
    totgesagt.hp = 0;
    totgesagt.defeatedAt = Date.now();
    totgesagt.contributions = { [ANNA]: { name: 'anna', dmg: 50000 } };
    await faelschung('2c: selbst erklärter Kill', kopfA, totgesagt);

    // (d) Ein Respawn, obwohl der Vorgänger noch lebt.
    await faelschung('2d: Respawn bei lebendem Boss', kopfB, frischerBoss(2));

    // (e) Die richtige Stufe, aber geschenkte HP. Ohne diese Prüfung könnte man den laufenden Boss
    // auf 1 HP setzen und ihn vom nächsten beliebigen Angriff fallen lassen.
    const weich = frischerBoss(1, BOSS_ID);
    weich.hp = 1;
    await faelschung('2e: geschenkte HP am laufenden Boss', kopfA, weich);
  }

  // ---- 4. Kontrollprüfung: der echte Schadensweg lebt weiter ------------------------------------
  // /api/worldboss/resolve schreibt db.shared direkt und läuft damit an der Rechteprüfung vorbei –
  // genau so soll es sein. Diese Prüfung ist an BEIDEN Ständen grün und hält die Behebung davon ab,
  // den Weltboss als Spielinhalt zu erledigen.
  {
    const r = await s1.j('/worldboss/resolve', { method: 'POST', headers: kopfA,
      body: JSON.stringify({ missionId: MISSION_ID, planetKey: 'home' }) });
    check('4a: eine echte Mission wird weiterhin aufgelöst', r.status === 200 && r.body.ok === true, { status: r.status, body: r.body });
    check('4b: sie richtet echten Schaden an', r.body && r.body.damage > 0, r.body && r.body.damage);
    await warte(300);
    const boss = s1.bossAusDb();
    check('4c: der Schaden steht am gemeinsamen Boss', !!boss && boss.hp < hpFuer(1), boss && boss.hp);
    check('4d: und Anna steht mit ihrem echten Schaden in der Beitragsliste',
      !!boss && !!(boss.contributions || {})[ANNA] && boss.contributions[ANNA].dmg > 0,
      boss && Object.keys(boss.contributions || {}));
  }
  // ---- 6. Flottenmeldungen (missions:<playerId>) ------------------------------------------------
  // Derselbe Audit, dieselbe Ursache: kein Rechte-Check. Über diese Schlüssel speisen sich die
  // Abhorchposten aller Spieler (loadDetectedFleets liest sie alle). Wer unter fremder Kennung
  // schreiben darf, kann in der ganzen Galaxie Angriffe erscheinen lassen, die es nie gab – oder
  // die echte Meldung eines Dritten überschreiben und ihn damit unsichtbar machen.
  {
    const meldung = ziel => ({ id: ziel, name: 'wer auch immer', updated: Date.now(),
      missions: [{ type: 'attack', originSystem: 'orion', destSystem: 'kepler',
        startTime: Date.now(), endTime: Date.now() + 3600000, fleetName: 'Geisterflotte',
        composition: { jaeger: 99999 } }] });
    const schreibeMeldung = (kopf, ziel) => s1.j('/storage/' + encodeURIComponent('missions:' + ziel) + '?shared=true',
      { method: 'PUT', headers: kopf, body: JSON.stringify({ value: JSON.stringify(meldung(ziel)) }) });

    // Kontrollprüfung, an BEIDEN Ständen grün: die eigene Meldung muss durchgehen, sonst wäre der
    // Abhorchposten als Spielinhalt tot.
    const eigen = await schreibeMeldung(kopfA, ANNA);
    check('6a: die eigene Flottenmeldung geht durch', eigen.status === 200, { status: eigen.status, body: eigen.body });

    const fremd = await schreibeMeldung(kopfA, BERT);
    check('6b: eine Meldung unter fremder Kennung wird abgelehnt', fremd.status === 403,
      { status: fremd.status, fehler: fremd.body && fremd.body.error });

    await warte(250);
    const roh = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'kepler-weltboss-' + process.pid + '-0.json'), 'utf8'));
    check('6c: und landet nicht im geteilten Speicher', roh.shared['missions:' + BERT] === undefined,
      roh.shared['missions:' + BERT]);

    // Lesen muss offen bleiben – der Abhorchposten wertet clientseitig aus.
    const lesen = await s1.j('/storage/' + encodeURIComponent('missions:' + ANNA) + '?shared=true', { headers: kopfB });
    check('6d: fremde Meldungen bleiben lesbar', lesen.status === 200 && !!lesen.body.value, lesen.status);
  }

  const log1 = s1.protokoll();
  s1.ende();

  // ================= Lauf 2: gefallener Boss, Frist abgelaufen ==================================
  // Der echte Respawn. Ohne diese Prüfung wäre die Behebung eine Falle: Nach dem ersten Kill bliebe
  // für immer eine Leiche im geteilten Speicher und das Feature wäre genauso tot wie bei 2a.
  const gefallen = frischerBoss(3, 'wb3_alt');
  gefallen.hp = 0;
  gefallen.defeatedAt = Date.now() - RESPAWN_MS - 60000;
  gefallen.contributions = { [ANNA]: { name: 'anna', dmg: hpFuer(3) } };
  const s2 = await starteServer(1, grunddb({ 'worldboss:current': JSON.stringify(gefallen) }));
  const tokenB2 = await s2.anmelden('bert');
  const kopfB2 = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenB2 };
  {
    const schreibe2 = doc => s2.j('/storage/' + encodeURIComponent('worldboss:current') + '?shared=true',
      { method: 'PUT', headers: kopfB2, body: JSON.stringify({ value: JSON.stringify(doc) }) });

    // ZUERST die übersprungene Stufe – solange das Respawn-Fenster wirklich OFFEN ist. In der ersten
    // Fassung stand diese Prüfung hinter 5a, also hinter dem bereits gesetzten lebenden Boss: Sie war
    // grün, aber aus dem falschen Grund („Boss lebt", derselbe Zweig wie 2d) und belegte die
    // Stufenregel überhaupt nicht. Am Fehlertext ist der Zweig jetzt unterscheidbar.
    const r0 = await schreibe2(frischerBoss(60));
    check('5a: eine übersprungene Stufe wird auch im offenen Respawn-Fenster abgelehnt',
      r0.status === 403, { status: r0.status, body: r0.body });
    check('5b: und zwar wegen der Stufe, nicht weil ein Boss lebt',
      r0.status === 403 && /Stufe 4/.test((r0.body && r0.body.error) || ''), r0.body && r0.body.error);

    const r = await schreibe2(frischerBoss(4));
    check('5c: nach gefallenem Boss und abgelaufener Frist darf neu gespawnt werden', r.status === 200, { status: r.status, body: r.body });
    await warte(300);
    const boss = s2.bossAusDb();
    check('5d: der neue Boss steht eine Stufe höher', !!boss && boss.level === 4, boss && boss.level);
  }
  const log2 = s2.protokoll();
  s2.ende();

  const logs = log1 + log2;
  check('keine Serverfehler im Protokoll', !/TypeError|ReferenceError/.test(logs),
    (logs.match(/(TypeError|ReferenceError)[^\n]*/g) || []).slice(0, 2));

  console.log(fail ? '\nFEHLGESCHLAGEN' : '\nAlles in Ordnung');
  process.exit(fail ? 1 : 0);
})();
