// Die Sektorlage: derselbe Nestbestand, regional gelesen (E5, 03.09.2026).
//
//   node tests/test_sektorlage.js
//
// DER BEFUND, DER DIE FORM DIESER ETAPPE ENTSCHIEDEN HAT (gemessen vor dem Bau): Das Konzept ging
// davon aus, `NEST_STUFEN[*].punkte` existiere AUSSCHLIESSLICH fuer diese Etappe. Seit Phase 4
// stimmt das nicht mehr - npcStaerkeZiel() liest dasselbe Feld und hebt damit `npcEmpireStrength`
// galaxieweit an. Ein absoluter Sektorfaktor obendrauf haette dieselben Nester ZWEIMAL gezaehlt
// (schlimmster Fall 2,50x -> 3,63x). Der Faktor misst deshalb den ABSTAND ZUM GALAXIESCHNITT:
// gleichmaessig verteilte Nester ergeben ueberall 1,00, erst eine Ballung wirkt.
//
// WAS HIER GEPRUEFT WIRD - und warum nicht ueber HTTP: Die Lage entsteht im 15-Minuten-Takt aus
// einem Nestbestand, den ein Testserver erst haette wachsen lassen muessen. Geprueft wird deshalb
// die reine Funktion selbst, mit gestellten Lagen - das misst die REGEL und laeuft in
// Millisekunden. Abschnitt 5 prueft zusaetzlich die Kopie-Familie gegen den Frontend-Klon.
const fs = require('fs');
const path = require('path');

let fehlgeschlagen = false;
const check = (name, bedingung, zusatz) => {
  console.log((bedingung ? 'OK  ' : 'FAIL') + ' - ' + name + (zusatz !== undefined ? ' | ' + JSON.stringify(zusatz) : ''));
  if (!bedingung) fehlgeschlagen = true;
};
const QUELLE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const schneide = (start, endeRe) => {
  const i = QUELLE.indexOf(start);
  if (i < 0) return null;
  const rest = QUELLE.slice(i);
  const j = rest.search(endeRe);
  return j < 0 ? null : rest.slice(0, j);
};

// ---- 0) Die Stuecke schneiden -----------------------------------------------------------------
const KOORD    = schneide('const SYSTEM_COORDS = [', /\n\];/);
const STUFEN   = schneide('const NEST_STUFEN = [', /\n\];/);
const E5_VON   = QUELLE.indexOf('const SEKTOR_LAGE_AKTIV =');
const E5_BIS   = QUELLE.indexOf('\nfunction sektorLageTick(g) {');
check('0a: SYSTEM_COORDS, NEST_STUFEN und der E5-Block lassen sich schneiden',
  !!KOORD && !!STUFEN && E5_VON > 0 && E5_BIS > E5_VON,
  { koord: !!KOORD, stufen: !!STUFEN, e5Von: E5_VON, e5Bis: E5_BIS });
if (!KOORD || !STUFEN || E5_VON < 0 || E5_BIS < 0) { console.log('\nFAIL'); process.exit(1); }
const E5 = QUELLE.slice(E5_VON, E5_BIS);

/* Ausgefuehrt wird der ECHTE Block, nicht eine nachgebaute Fassung - eine Attrappe pruefte am Ende
   die Attrappe. Gestellt wird nur, was er von aussen braucht: die Koordinatentabelle (real aus
   server.js) und nestStufe (ebenfalls real, ueber die geschnittene NEST_STUFEN-Tabelle). */
const API = new Function(`
  ${KOORD}];
  ${STUFEN}];
  const SYSTEM_COORD_BY_ID = {};
  for (const s of SYSTEM_COORDS) SYSTEM_COORD_BY_ID[s.id] = s;
  function nestStufe(n){ return NEST_STUFEN[Math.max(1, Math.min(5, n || 1))]; }
  ${E5}
  return { SEKTOR_ZENTREN, sektorVonSystem, sektorLageAus, SYSTEM_COORDS,
           SEKTOR_LAGE_DECKEL, SEKTOR_LAGE_STEIGUNG, SEKTOR_DRUCK_JE_FESTUNG,
           SEKTOR_LAGE_UNRUHIG_AB, SEKTOR_LAGE_BELAGERT_AB, SEKTOR_LAGE_AKTIV };
`)();
check('0b: der Block laeuft und liefert acht Sektorzentren',
  API.SEKTOR_ZENTREN.length === 8 && API.SYSTEM_COORDS.length >= 69,
  { sektoren: API.SEKTOR_ZENTREN.length, systeme: API.SYSTEM_COORDS.length });

const KEYS = API.SEKTOR_ZENTREN.map(s => s.key);
const nest = (sys, stufe) => ({ sys, stufe });

// ---- 1) Die tragende Zusage: gleichmaessige Last aendert NICHTS -------------------------------
/* Das ist der ganze Grund fuer die relative Form. Faellt diese Pruefung, zaehlt der Faktor wieder
   den Bestand statt der Ueberlast - und dieselben Nester wirken zweimal (siehe Kopf). */
{
  // In jeden Sektor genau ein Nest derselben Stufe: der Schnitt ist der Druck, der Abstand 0.
  const einsJeSektor = KEYS.map(k => {
    const sys = API.SYSTEM_COORDS.find(s => API.sektorVonSystem(s.id) === k);
    return nest(sys.id, 3);
  });
  const { lage, schnitt } = API.sektorLageAus(einsJeSektor, []);
  const alleEins = KEYS.every(k => lage[k].npcMult === 1);
  check('1: eine gleichmaessig belastete Galaxie laesst JEDEN Sektor auf 1,00',
    alleEins && schnitt === 3,
    { schnitt, faktoren: KEYS.map(k => lage[k].npcMult) });
  check('1b: und nennt sie alle "ruhig" - die Beschriftung folgt derselben Zahl',
    KEYS.every(k => lage[k].stufe === 'ruhig'),
    KEYS.map(k => lage[k].stufe));
}

// ---- 2) Erst eine BALLUNG wirkt, und nur dort --------------------------------------------------
{
  const kepSys = API.SYSTEM_COORDS.filter(s => API.sektorVonSystem(s.id) === 'kepler').slice(0, 4);
  check('2-vorab: der Kepler-Kern traegt genug Systeme fuer die gestellte Ballung', kepSys.length === 4, kepSys.length);
  const { lage, schnitt } = API.sektorLageAus(kepSys.map(s => nest(s.id, 5)), []);
  // 4 Nester x 5 Punkte = 20, Schnitt 2,5, Abstand 17,5 -> ueber dem Deckel.
  check('2: die Ballung hebt genau ihren Sektor - und keinen anderen',
    lage.kepler.npcMult > 1 && KEYS.filter(k => k !== 'kepler').every(k => lage[k].npcMult === 1),
    { kepler: lage.kepler.npcMult, schnitt, uebrige: KEYS.filter(k => k !== 'kepler').map(k => lage[k].npcMult) });
  check('2b: der Deckel greift und wird nicht ueberschritten',
    lage.kepler.npcMult === API.SEKTOR_LAGE_DECKEL,
    { npcMult: lage.kepler.npcMult, deckel: API.SEKTOR_LAGE_DECKEL, ueber: lage.kepler.ueber });
  check('2c: Nester und Druck werden mitgezaehlt, nicht nur der Faktor',
    lage.kepler.nester === 4 && lage.kepler.druck === 20,
    { nester: lage.kepler.nester, druck: lage.kepler.druck });
}

// ---- 3) Der Boden liegt EXAKT auf 1,00 ---------------------------------------------------------
/* In beide Richtungen: Ein leerer Sektor darf weder teurer noch BILLIGER werden. Ein Faktor unter
   1 waere eine Erleichterung, die niemand beantragt hat - und sie faellt niemandem auf, weil sie
   sich wie Glueck anfuehlt. */
{
  const einer = API.SYSTEM_COORDS.find(s => API.sektorVonSystem(s.id) === 'obsidian');
  const { lage } = API.sektorLageAus([nest(einer.id, 5), nest(einer.id, 5)], []);
  const unterSchnitt = KEYS.filter(k => k !== 'obsidian');
  check('3: kein Sektor faellt je unter 1,00 - auch keiner weit unter dem Schnitt',
    unterSchnitt.every(k => lage[k].npcMult === 1 && lage[k].ueber === 0),
    unterSchnitt.map(k => k + ':' + lage[k].npcMult));
  const leer = API.sektorLageAus([], []);
  check('3b: eine leere Galaxie ergibt ueberall genau 1,00 und Schnitt 0',
    KEYS.every(k => leer.lage[k].npcMult === 1 && leer.lage[k].druck === 0) && leer.schnitt === 0,
    { schnitt: leer.schnitt });
}

// ---- 4) Festungen wiegen mit, und die Stufe widerspricht nie ihrer Zahl ------------------------
{
  const fSys = API.SYSTEM_COORDS.filter(s => API.sektorVonSystem(s.id) === 'rand').slice(0, 3).map(s => s.id);
  const { lage } = API.sektorLageAus([], fSys);
  check('4: eine Festung zaehlt mit dem eingetragenen Gewicht in den Druck',
    lage.rand.druck === 3 * API.SEKTOR_DRUCK_JE_FESTUNG && lage.rand.festungen === 3,
    { druck: lage.rand.druck, festungen: lage.rand.festungen, gewicht: API.SEKTOR_DRUCK_JE_FESTUNG });
  /* Die Beschriftung wird aus DEMSELBEN Abstand abgeleitet wie der Faktor. Stuende sie am rohen
     Druck, koennte an einer Region "belagert" stehen, waehrend ihr Faktor 1,00 ist - eine
     Anzeige, die ihrer eigenen Zahl widerspricht. */
  /* Zwei Faelle, ZWEI Pruefnamen: Die Hausregel vergleicht die Namen beider Laeufe per diff -
     zweimal derselbe Name macht aus einem gefallenen Fall einen unsichtbaren. */
  const faelle = [
    { name: '4b: eine leere Galaxie ergibt "ruhig" statt eines Absturzes', nester: [], f: [] },
    { name: '4b2: FEHLENDE Eingaben (null) ebenso - der Takt darf an einem leeren Bestand nicht sterben', nester: null, f: null }
  ];
  for (const fall of faelle) {
    const r = API.sektorLageAus(fall.nester, fall.f);
    check(fall.name, KEYS.every(k => r.lage[k].stufe === 'ruhig'), Object.keys(r.lage).length);
  }
}
{
  // Die Regel selbst, ueber den ganzen erreichbaren Bereich: ruhig <=> Faktor genau 1,00.
  const proben = [];
  for (let n = 0; n <= 12; n++) {
    const sys = API.SYSTEM_COORDS.filter(s => API.sektorVonSystem(s.id) === 'pulsar').slice(0, Math.max(1, n));
    proben.push(API.sektorLageAus(sys.slice(0, n).map(s => nest(s.id, 4)), []).lage);
  }
  const widerspruch = proben.filter(l => KEYS.some(k =>
    (l[k].stufe === 'ruhig') !== (l[k].npcMult === 1)));
  check('4c: "ruhig" heisst IMMER genau Faktor 1,00 - und umgekehrt',
    widerspruch.length === 0, { widerspruechlich: widerspruch.length });
  const stufenFalsch = proben.filter(l => KEYS.some(k =>
    l[k].stufe !== (l[k].ueber >= API.SEKTOR_LAGE_BELAGERT_AB ? 'belagert'
                  : l[k].ueber >= API.SEKTOR_LAGE_UNRUHIG_AB ? 'unruhig' : 'ruhig')));
  check('4d: die drei Stufen folgen genau den eingetragenen Schwellen',
    stufenFalsch.length === 0, { abweichend: stufenFalsch.length });
}

// ---- 5) Kopie-Familie: der Server muss dieselbe Region treffen wie der Client -------------------
/* Nicht "die zwei Tabellen tragen dieselben Zahlen", sondern die WIRKUNG: Fuer jedes der 69
   Systeme muss beide Seiten dieselbe Region herausbekommen. Eine vertauschte Zeile in
   SEKTOR_ZENTREN faellt hier auf, eine abweichende Systemkoordinate ebenfalls - und beides waere
   sonst erst zu sehen, wenn ein Spieler eine Zahl meldet, die zu seiner Karte nicht passt. */
const FRONTEND = path.join(__dirname, '..', '..', 'kolonie-kepler7', 'weltraum_kolonie.html');
if (!fs.existsSync(FRONTEND)) {
  console.log('----  5: Frontend-Klon nicht daneben - Paritaetspruefung uebersprungen');
} else {
  const FE = fs.readFileSync(FRONTEND, 'utf8');
  const feSchnitt = (start, endeRe) => { const i = FE.indexOf(start); const r = FE.slice(i); return i < 0 ? null : r.slice(0, r.search(endeRe)); };
  const feSek = feSchnitt('const SEKTOR_DEFS = [', /\n\s*\];/);
  const feSys = feSchnitt('const STAR_SYSTEMS =', /\n\s*\];/);
  check('5-anker: beide Frontend-Tabellen lassen sich schneiden', !!feSek && !!feSys, { sek: !!feSek, sys: !!feSys });
  if (feSek && feSys) {
    const feZentren = [...feSek.matchAll(/\{\s*key:'([a-z]+)',\s*name:'[^']*',\s*cx:(\d+),\s*cy:(\d+)/g)]
      .map(m => ({ key: m[1], cx: +m[2], cy: +m[3] }));
    check('5a: acht Regionen, gleiche Reihenfolge, gleiche Mittelpunkte',
      feZentren.length === 8 && feZentren.every((z, i) =>
        z.key === API.SEKTOR_ZENTREN[i].key && z.cx === API.SEKTOR_ZENTREN[i].cx && z.cy === API.SEKTOR_ZENTREN[i].cy),
      { frontend: feZentren.map(z => z.key + '@' + z.cx + '/' + z.cy),
        backend: API.SEKTOR_ZENTREN.map(z => z.key + '@' + z.cx + '/' + z.cy) });
    const feKoord = {};
    for (const t of feSys.matchAll(/\{[^{}]*id:\s*'([a-z0-9_]+)'[^{}]*\}/g)) {
      const gx = /gx:\s*(-?[\d.]+)/.exec(t[0]), gy = /gy:\s*(-?[\d.]+)/.exec(t[0]);
      if (gx && gy) feKoord[t[1]] = { gx: +gx[1], gy: +gy[1] };
    }
    check('5b-anker: die Frontend-Systeme wurden gelesen', Object.keys(feKoord).length >= 69, Object.keys(feKoord).length);
    // Dieselbe Rechnung wie sektorVon() im Frontend, hier gegen die FRONTEND-Koordinaten gefahren.
    const feSektorVon = (id) => {
      const c = feKoord[id]; if (!c) return null;
      let best = feZentren[0], bd = Infinity;
      for (const sk of feZentren) { const d = (c.gx-sk.cx)**2 + (c.gy-sk.cy)**2; if (d < bd) { bd = d; best = sk; } }
      return best.key;
    };
    const abweichend = API.SYSTEM_COORDS.filter(s => feSektorVon(s.id) !== API.sektorVonSystem(s.id));
    check('5b: jedes der Systeme landet auf BEIDEN Seiten in derselben Region',
      abweichend.length === 0 && API.SYSTEM_COORDS.length === Object.keys(feKoord).length,
      { abweichend: abweichend.slice(0, 5).map(s => s.id + ': FE ' + feSektorVon(s.id) + ' vs. BE ' + API.sektorVonSystem(s.id)),
        anzahl: abweichend.length, be: API.SYSTEM_COORDS.length, fe: Object.keys(feKoord).length });
  }
}

// ---- 6) Der Schalter liefert stumm aus ----------------------------------------------------------
/* Solange das Frontend die Lage nicht kennt, darf sie nicht wirken - sonst waeren NPCs in
   einzelnen Regionen bis zu einem Viertel zaeher, ohne dass eine Anzeige den Grund nennt.
   Geprueft wird BEIDES: die Grundstellung und dass der Takt wirklich an ihr abbiegt. */
check('6: SEKTOR_LAGE_AKTIV steht in der Grundstellung auf false',
  API.SEKTOR_LAGE_AKTIV === false, { wert: API.SEKTOR_LAGE_AKTIV });
const TICK = schneide('function sektorLageTick(g) {', /\n\}/);
check('6b: sektorLageTick kehrt bei ausgeschaltetem Schalter SOFORT zurueck - vor jedem Schreibzugriff',
  !!TICK && /^\s*if \(!SEKTOR_LAGE_AKTIV\) return;/m.test(TICK)
  && TICK.indexOf('if (!SEKTOR_LAGE_AKTIV) return;') < TICK.indexOf('g.sektorLage'),
  { rumpf: TICK ? TICK.slice(0, 120) : null });
check('6c: der Takt ruft die Lage ueberhaupt auf',
  /\n  sektorLageTick\(g\);/.test(QUELLE), {});
check('6d: das Feld hat eine Vorgabe, damit der Client nicht zwischen leer und kaputt raten muss',
  /if \(!db\.galaxy\.sektorLage\) db\.galaxy\.sektorLage = \{ sektoren: \{\}, schnitt: 0, stand: 0 \};/.test(QUELLE), {});

console.log(fehlgeschlagen ? '\nFAIL' : '\nAlles gruen.');
process.exit(fehlgeschlagen ? 1 : 0);
