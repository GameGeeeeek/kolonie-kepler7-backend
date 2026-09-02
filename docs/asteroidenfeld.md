# Asteroidenfeld: Kampfvermerk am Vorkommen, Urmaterie-Nachsaat und -Boden

Verschoben aus `CLAUDE.md` am 01.09.2026 (Strukturprüfung, Punkt 1: Startkontext verkleinern). Wortlaut unverändert; Querverweise wie „unten" oder „oben" beziehen sich auf die frühere Reihenfolge in `CLAUDE.md`. Neue Erkenntnisse zu diesem Bereich gehören ab jetzt hierher, nicht in `CLAUDE.md`.

## Der Kampfvermerk am Vorkommen (21.08.2026)

`/api/asteroid/contest` schreibt seit dem 21.08.2026 in **beiden** Ausgängen
`vork.letzterKampf = { zeit, verlierer, verloren, angreifer, verluste }`.

**Der Anlass war kein fehlender Text, sondern eine fehlende UNTERSCHEIDUNG.** Der Client des
Verteidigers konnte nicht erkennen, ob ein Schürfrecht durch einen **Kampf** weg ist oder weil er
es **selbst aufgegeben** hat. Beide Fälle sehen im Felddokument gleich aus: Das Recht gehört ihm
nicht mehr, und `vork.eskorte` ist leer (die Freigabe löscht sie ebenfalls). Sein
`asteroidEskortenSync` übersprang den Platz deshalb komplett – gemessen im Browser: 20 Kreuzer
stationiert, Recht verloren, der lokale Eintrag stand danach unverändert bei 20, und ein Rückruf
gab **alle 20 zurück**, obwohl der Server sie in diesem Kampf vernichtet hatte. Ein verlorenes
Schürfrecht kostete den Verteidiger damit keinen einzigen Schiffsverlust.

**Warum am Vorkommen und nicht im Spielstand des Verteidigers:** Der Server schreibt hier
grundsätzlich keinen fremden Spielstand (siehe den Kommentar am Festungsschlag). Das Felddokument
gehört dagegen den Asteroiden-Endpunkten, der Client liest es bei jedem Kartenaufruf ohnehin, und
ein nachwachsendes Vorkommen ist in `astNachschub` ein **frisches Objekt** – der Vermerk stirbt
also mit dem Brocken, an dem er hängt, und kann nicht auf einen späteren Nachfolger durchschlagen.

**Er wird auch bei einem ABGEWEHRTEN Angriff geschrieben.** Bis dahin stand über den Verlusten
einer erfolgreichen Abwehr nur eine Protokollzeile ohne Angreifer und ohne Schiffstypen – und
`#log` überschreibt sich mit der nächsten Meldung selbst.

**Kein neues Leck.** `verlierer` ist eine Nutzer-ID, aber `vork.halter` ist längst eine, und
`vork.eskorte` führt die Wache des Halters ohnehin vollständig und öffentlich.

**Die Auslieferungsreihenfolge ist gleichgültig** (anders als bei den Festungen, Frontend-Regel 60):
Geht dieses Backend allein live, schreibt es ein Feld, das niemand liest – folgenlos. Geht das
Frontend allein live, liest es ein Feld, das es nicht gibt, der Zweig feuert nie, und es bleibt
beim heutigen Zustand. Ein Schalter ist deshalb nicht nötig.

Wächter: `tests/test_asteroidfeld_http.js` 9k–9k4. Gemessen wird gegen die **Antwort an den
Angreifer** (`kampf.body.gegnerVerluste`) – ein Anker von außerhalb der Rechnung, den ein Fehler im
Vermerk nicht mitverschieben kann (Frontend-Regel 62). Und 9k prüft, dass der Vermerk die
**Verteidigerin** als Verliererin nennt und nicht den neuen Halter: Bei einem Sieg ist `vork.halter`
zu diesem Zeitpunkt schon der Angreifer – derselbe Fallstrick, den der Postfach-Zweig eine Zeile
weiter unten mit `halterIdVorher` löst.


## Urmaterie-Nachsaat und -Boden in astAlleFelder (28.08.2026)

**Anlass:** Spieler-Report Sascha „kein einziger Urmaterie-Asteroid" — die Felder entstanden am
16.08. mit der Sortentabelle VOR #117 und wurden nie migriert; die Startpopulation konnte
bauartbedingt keinen Urmateriekern enthalten, und neue Sorten entstehen nur nach vollständiger
Leerförderung (p = 3/103 je Neuwurf). Die Frontend-Hälfte (Sichtbarkeit) steht in der
Frontend-CLAUDE.md; hier die zwei Mechaniken.

**Beide leben in `astAlleFelder()` — dem EINEN Tor**, durch das jeder Feldzugriff läuft (lazy
Erzeugung, Nachschub, Festungs-Reifung). Eine dritte Stelle daneben wäre die übliche zweite
Wahrheit; hier erben künftige Aufrufer beides automatisch.

1. **Die Nachsaat läuft GENAU EINMAL** und setzt so viele Urmateriekerne nach, dass 3 stehen.
   Ihr Marker `db.galaxy.urmaterieNachsaat` liegt bewusst in `db.galaxy`: Das ist für Clients über
   die Storage-Route **gar nicht erreichbar** (dieselbe Begründung wie bei den Alien-Nestern) —
   ein löschbarer Marker wäre eine wiederholbare Geldquelle. Gesetzt wird er nur, wenn `db.galaxy`
   schon existiert; ein hier angelegtes leeres Objekt hebelte die Voll-Initialisierung im
   `galaxyTick` aus.
2. **Der Boden greift NUR bei Bestand 0** und setzt genau EINEN Kern. Kein Ziel-Bestand, keine
   Quote — die Sorte bleibt selten, aber „in der ganzen Galaxie liegt keiner" kann nicht mehr
   vorkommen. Bei Bestand ≥ 1 tut er nachweislich nichts (`test_urmaterie_boden_http` 3b).

**`astUrmaterieSetzen` verteilt statt zu fluten:** je Durchgang höchstens EIN Kern je System
(gemischte Systemliste), nur auf Plätze aus `astFreiePlaetze` (festungsbewusst), unter
`AST_GRENZE_MAX`, als ganz normales Vorkommen über `astNeuesVorkommen` mit `sorte = 'urmaterie'`.
**Nichts Bestehendes wird gelöscht oder umgewürfelt** — eine Migration, die Bestand anfasst, nähme
Spielern etwas weg, das sie gerade anfliegen.

**Die Auslieferungsreihenfolge ist gleichgültig** (anders als bei den Festungs-Schaltern): Das
Backend allein setzt Vorkommen, die das alte Frontend als normale graue Brocken zeichnet — korrekt,
nur unauffällig; das Frontend allein zeichnet gold, was der Zufall irgendwann liefert. Kein
Schalter nötig; die zwei PRs gehören trotzdem zusammen gemerged.

Wächter: `tests/test_urmaterie_boden_http.js` (Port 3232, 11 Prüfungen — Nachsaat exakt 3 in DREI
verschiedenen Systemen, nichts gelöscht, Idempotenz über einen Neustart, Boden 0→1 und ≥1→nichts,
Marker-Zeitstempel unverändert). Gegenprobe über `URMATERIE_TEST_SERVER` an einer Kopie ohne den
Block (die Kopie MUSS im Repo-Verzeichnis liegen, `require('./mailer')`): **8 rot, 3 grün bei
identischen Prüfnamen** — die gemessene Pflichtliste steht im Test-Kopf, samt der Lehre, dass die
ERSTE Fassung dieser Liste doppelt falsch war (drei Prüfungen aus dem falschen Grund grün über
leeren Listen bzw. `undefined === undefined`, Frontend-Regel 28; seither verlangen sie erst einen
WERT, dann die Beziehung).



## Die Anfechtung rechnet die Eskorte MIT dem Spielstand des Halters – und hat eine Vorschau (01.09.2026)

Auftrag Sascha „Alle umsetzen" (Asteroiden-Etappen). Bis hierher stand in `/api/asteroid/contest`
`weightedFleetDefensePower(vork.eskorte, null) + fleetShieldSum(vork.eskorte, null)` – die Eskorte
des Halters kämpfte **ohne** seine Werftmarken, Klassenmodule und Kampfforschung, während die Werft
sie ihm anzeigt. Der Kommentar an der Vorschau des Frontends behauptete das Gegenteil („der Server
rechnet mit Werftmarken, Modulen des Halters"). Gemessen an einer Eskorte aus 100 Kreuzern und
20 Schlachtschiffen (Marken 10, Kampfforschung 20/20, ein episches Hüllenmodul der Schweren Linie):

| | Verteidigung | Chance des Angreifers |
|---|---|---|
| ohne Halter-Spielstand (alt) | 4.340 | 66 % |
| mit Halter-Spielstand (neu) | **11.744** | **42 %** |

**`astEskorteVerteidigung(vork)` ist die EINE Stelle**, die den Spielstand des Halters aus
`db.private` liest (wie `/api/attack` den des Verteidigers) und beide Verteidigungs-Funktionen mit
`marks` und `save` aufruft. Ein Halter ohne Spielstand fällt auf den alten Wert zurück.

**Die Vorschau (`POST /api/asteroid/anfechtung-vorschau`) rechnet mit GENAU denselben Funktionen**
– `astEskorteVerteidigung`, `astAnfechtungChance`, `astAnfechtungVerluste` –, deshalb sind die
drei aus dem Rumpf des Kampfs herausgezogen. Die Zusammensetzung kommt für die Vorschau aus dem
Request; das ist unkritisch, weil daraus nichts gebucht wird. Der Kampf liest sie weiterhin
ausschließlich aus der gespeicherten Mission. Die Vorschau nennt die **Spanne** (Wurf 0,85 bis
1,15) statt einer Zahl, die der Kampf dann „widerlegt". Dieselbe Arbeitsteilung wie
`GET /api/spieler-standorte`, das die Verteidigung eines fremden Standorts für die Zielwahl nennt.

**Balance-Folge, benannt:** Ein Halter mit Marken, Modulen und Forschung ist im Vergleich zu vorher
deutlich stärker – gemessen Faktor 2,7 bei Endausbau. Eine Anfechtung gegen einen gut gerüsteten
Halter ist damit teurer. Das ist der Zustand, den die Werft dem Halter seit jeher verspricht.

Wächter: `tests/test_anfechtung_vorschau_http.js` (Port 3240, 19 Prüfungen). Kern ist das PAAR
(2a/2b: dieselbe Eskorte ohne und mit Halter-Spielstand) und 3a (die im Kampf gewürfelte Chance
liegt in der Spanne der Vorschau davor). Gegenprobe `KEPLER_ANF_SABOTAGE=null`: genau 2a und 2b
fallen, Prüfliste identisch. **Die erste Pflichtliste nannte nur 2a** – gemessen fällt 2b mit; eine
Pflichtliste ist selbst eine Behauptung, bis die Gegenprobe sie gemessen hat.

## Gürtelauswahl eingefroren (02.09.2026)

`astGuertelSysteme` wählt nur noch aus den 69 Basissystemen und `sysw_0` bis `sysw_13`
(`astGuertelKandidat`, `AST_GUERTEL_WOCHEN_STAND`); Startschub-Systeme (`SCHUB_COORDS`) und
spätere Wochensysteme nie. Gemessen mit der eigenen Formel: Das 5×4-Raster liegt über der
Bounding-Box aller Systeme, und jedes Wochensystem verschob die Zellen – 12 → 14 Wochensysteme
nahm `sysn_kelyra` den Gürtel, bis zum Deckel hätten 12 von 20 gewechselt, jeweils mit den
Schürfrechten und Eskorten der Spieler im Leeren (das Feld bleibt als Waise unter
`asteroids:<sysId>` in `db.shared`). Der Satz vom 02.09.2026 (20, siehe
`test_asteroidfeld_http` 1b2) gilt jetzt für immer. Das Frontend rechnet seit demselben Tag mit
einer Kopie dieser Formel und übernimmt zusätzlich die Liste aus `/api/asteroid/field` – vorher
stimmten nur 10 der 20 Systeme überein (anderer Hash, anderer Seed), und zehn Gürtel des Servers
waren im Spiel unsichtbar. Vollständig: `docs/galaxie-wachstum.md` im Frontend-Repo.
