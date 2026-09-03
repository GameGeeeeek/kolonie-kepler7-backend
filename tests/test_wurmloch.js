// Das Wurmloch: beide Enden zufaellig, nie dasselbe System, nie ein kollabiertes (03.09.2026).
//
//   node tests/test_wurmloch.js
//
// DER ANLASS, gemessen: Bis heute stand im galaxyTick fest `from: 'kepler'`, und `to` musste
// UNbesiedelt sein. Damit war das Wurmloch kein Ort, sondern ein Anhaengsel des Heimatsystems -
// und zwar dauerhaft:
//
//   Lebensdauer 12 h = 48 Takte; danach 6 % je 15-Minuten-Takt, im Mittel 1/0,06 = 16,7 Takte
//   = 4,2 h Pause. Zyklus 16,2 h, davon 12 h offen  ->  PRAESENZ RUND 74 %.
//
// Drei Viertel der Zeit hing also ein Ende an der Heimat der meisten Konten, das andere an einem
// leeren System, in das ohnehin niemand fliegt. Auftrag Sascha: "mal ist kepler mit system x, mal
// system y fuehrt zu system a".
//
// WIE HIER GEPRUEFT WIRD - und warum nicht ueber HTTP: Der Wurf haengt am 15-Minuten-Takt und
// trifft mit 6 %. Ein laufender Server braeuchte im Erwartungswert vier Stunden fuer EINE Ziehung.
// Geprueft wird deshalb die Ziehung selbst: Der Block wird aus server.js geschnitten und mit
// gestellten Listen tausendfach ausgefuehrt. Das misst die REGEL (Verteilung, Ausschluesse),
// nicht eine Momentaufnahme - und es laeuft in Millisekunden.
const fs = require('fs');
const path = require('path');

let fehlgeschlagen = false;
const check = (name, bedingung, zusatz) => {
  console.log((bedingung ? 'OK  ' : 'FAIL') + ' - ' + name + (zusatz !== undefined ? ' | ' + JSON.stringify(zusatz) : ''));
  if (!bedingung) fehlgeschlagen = true;
};

const QUELLE = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ---- 0) Den Ziehblock schneiden ---------------------------------------------------------------
const von = QUELLE.indexOf("  if (Math.random() < 0.06 && !g.activeWormhole) {");
const bis = von >= 0 ? QUELLE.indexOf('\n  }\n', von) : -1;
check('0a: der Ziehblock laesst sich schneiden', von >= 0 && bis > von, { von, bis });
if (von < 0 || bis < 0) { console.log('\nFAIL'); process.exit(1); }
const BLOCK = QUELLE.slice(von, bis + 4);

/* Gestellt werden g, SYSTEMS, pushGalaxyNews - UND occupiedSystems, obwohl der heutige Block es
   gar nicht mehr braucht. Das ist Absicht und war der erste Befund beim Bau: Ohne diese Zeile
   starb die GEGENPROBE am alten Stand mit einem ReferenceError, statt rot zu melden - sie war
   damit wertlos, denn ein Absturz belegt nicht, dass die geprueften Eigenschaften fehlen. Eine
   Messvorrichtung muss BEIDE Staende ausfuehren koennen, sonst misst sie nur den neuen. */
function ziehen(systeme, kollabiert, besiedelt){
  const g = { activeWormhole: null, collapsedSystems: Object.assign({}, kollabiert || {}) };
  const nachrichten = [];
  const fn = new Function('g', 'SYSTEMS', 'pushGalaxyNews', 'Math', 'occupiedSystems',
    BLOCK + '\n return g.activeWormhole;');
  // Math.random auf 1 setzen wuerde den Wurf verhindern - deshalb ein Math, dessen random() beim
  // ERSTEN Aufruf (dem 6-%-Wurf) sicher trifft und danach echt zufaellig ist.
  let ersterAufruf = true;
  const M = Object.create(Math);
  M.random = () => { if (ersterAufruf){ ersterAufruf = false; return 0; } return Math.random(); };
  return fn(g, systeme, (i, t) => nachrichten.push(t), M, () => new Set(besiedelt || []));
}

const SYS = ['kepler', 'vega', 'orion', 'nebel', 'abyss', 'krux', 'zenith', 'chronos'];

// ---- 1) Beide Enden variieren -----------------------------------------------------------------
const LAEUFE = 3000;
const vonZaehler = {}, nachZaehler = {};
let gleich = 0, leer = 0;
for (let n = 0; n < LAEUFE; n++){
  const w = ziehen(SYS, {});
  if (!w){ leer++; continue; }
  vonZaehler[w.from] = (vonZaehler[w.from] || 0) + 1;
  nachZaehler[w.to] = (nachZaehler[w.to] || 0) + 1;
  if (w.from === w.to) gleich++;
}
check('1-vorab: jeder Wurf hat ein Wurmloch erzeugt', leer === 0, { ohneErgebnis: leer });
/* DIE EIGENTLICHE PRUEFUNG (Anlassfall): `from` muss ueber ALLE Systeme streuen. Am alten Stand
   stand dort 3000-mal 'kepler' - genau das faellt hier auf. Geprueft wird die REGEL "jedes System
   kommt vor", nicht eine Trefferzahl: Die haenge an der Zufallsfolge und waere eine Momentaufnahme. */
const vonArten = Object.keys(vonZaehler).sort();
check('1: `from` streut ueber alle Systeme, nicht nur kepler',
  vonArten.length === SYS.length,
  { gefunden: vonArten, erwartet: SYS.length, keplerAnteil: +((vonZaehler.kepler || 0) / LAEUFE).toFixed(3) });
check('1b: `to` streut ebenfalls ueber alle Systeme',
  Object.keys(nachZaehler).length === SYS.length, { gefunden: Object.keys(nachZaehler).sort() });
/* Und die Verteilung ist grob gleichmaessig - ohne diese Zeile waere 1 auch von einer Ziehung
   erfuellt, die kepler in 90 % der Faelle nimmt und die uebrigen je einmal streift. Der Rahmen ist
   weit gewaehlt (halber bis doppelter Erwartungswert), damit die Pruefung nicht an der
   Zufallsfolge scheitert, aber eine echte Schieflage faengt. */
const erwartet = LAEUFE / SYS.length;
const schief = Object.entries(vonZaehler).filter(([, n]) => n < erwartet * 0.5 || n > erwartet * 2);
check('1c: keines der Systeme ist auffaellig bevorzugt oder benachteiligt',
  schief.length === 0, { erwartetJeSystem: erwartet, schief });

// ---- 2) Die beiden Enden sind nie dasselbe System ---------------------------------------------
check('2: kein Wurmloch endet dort, wo es beginnt', gleich === 0, { gleicheEnden: gleich, laeufe: LAEUFE });

// ---- 3) Kollabierte Systeme kommen nicht vor ---------------------------------------------------
// Das war am alten Stand NICHT geprueft: `to` konnte ein von einer Supernova kollabiertes System
// treffen - ein Tor in ein System, das 48 Stunden lang unzugaenglich ist.
const GESPERRT = { orion: Date.now() + 3600000, nebel: Date.now() + 3600000 };
let trefferGesperrt = 0;
for (let n = 0; n < 1000; n++){
  const w = ziehen(SYS, GESPERRT);
  if (w && (GESPERRT[w.from] || GESPERRT[w.to])) trefferGesperrt++;
}
check('3: ein kollabiertes System wird nie zum Endpunkt', trefferGesperrt === 0,
  { treffer: trefferGesperrt, gesperrt: Object.keys(GESPERRT) });

// ---- 4) Der Grenzfall: genau zwei Systeme ------------------------------------------------------
// Hier haette eine "wuerfle neu, bis ungleich"-Schleife im Grenzfall lange gedreht; die
// Index-Verschiebung nicht. Geprueft wird, dass beide Reihenfolgen vorkommen und nichts haengt.
const zwei = ['a', 'b'];
const paare = new Set();
for (let n = 0; n < 200; n++){ const w = ziehen(zwei, {}); if (w) paare.add(w.from + '->' + w.to); }
check('4: bei genau zwei Systemen kommen beide Richtungen vor',
  paare.has('a->b') && paare.has('b->a') && paare.size === 2, { paare: [...paare] });

// ---- 5) Was der Spieler liest -----------------------------------------------------------------
check('5: die Entstehungs-Meldung nennt BEIDE Enden',
  /Ein neues Wurmloch ist entstanden: ' \+ moeglich\[i\] \+ ' ↔ ' \+ moeglich\[j\]/.test(QUELLE),
  { hinweis: 'am alten Stand stand dort fest "Kepler-System ↔ " + to' });
check('5b: die Schliess-Meldung ebenso',
  /Das Wurmloch ' \+ g\.activeWormhole\.from \+ ' ↔ ' \+ g\.activeWormhole\.to \+ ' hat sich wieder geschlossen/.test(QUELLE),
  { hinweis: '"das Wurmloch nach X" sagt nichts mehr, wenn beide Enden zufaellig sind' });

console.log(fehlgeschlagen ? '\nFAIL' : '\nAlles gruen.');
process.exit(fehlgeschlagen ? 1 : 0);
