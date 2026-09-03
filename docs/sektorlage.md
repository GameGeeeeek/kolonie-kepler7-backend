# Die Sektorlage (E5)

Stand 03.09.2026. Konzept: `kolonie-kepler7/docs/sektorkarte-konzept.md`, Abschnitt V5.
Umgesetzt im Backend mit **ausgeschaltetem Schalter** (`SEKTOR_LAGE_AKTIV = false`); umgelegt wird
er im Frontend-PR, der die Anzeige mitbringt.

## Was sie ist

Bis hierher kennt die Galaxie genau **eine** Schwierigkeitszahl: `npcEmpireStrength`, abgeleitet
aus der Stufensumme **aller** Nester (Phase 4). Sie sagt, wie es der Galaxie geht — nie, wie es
einer Region geht. Auf der Karte ist deshalb jede der acht Regionen gleich gefährlich, und die
Übersicht beantwortet die Frage „wohin fliege ich als Nächstes, und warum ausgerechnet dorthin?"
an keiner Stelle.

`g.sektorLage` beantwortet sie: je Region Druck, Nester, Festungen, Abstand zum Galaxieschnitt,
ein NPC-Faktor und eine Stufe (`ruhig` / `unruhig` / `belagert`).

## Der Befund, der die Form entschieden hat

Das Konzept (19.08.2026) ging davon aus, `NEST_STUFEN[*].punkte` existiere **ausschließlich** für
diese Etappe. Das stimmte, als es geschrieben wurde, und **seit Phase 4 nicht mehr**:
`npcStaerkeZiel()` liest dasselbe Feld und hebt damit `npcEmpireStrength` galaxieweit an.

Ein absoluter Sektorfaktor obendrauf hätte dieselben Nester **zweimal** gezählt:

| | heute | absoluter Faktor (Konzept) |
|---|---|---|
| geräumte Galaxie, ruhiger Sektor | 1,40× | 1,40× |
| voller Deckel, ruhiger Sektor | 2,50× | 2,50× |
| voller Deckel, belagerter Sektor | 2,50× | **3,63×** |

Der Konzeptsatz „die Änderung kann kein Bestandskonto verschlechtern" wäre damit für **jeden**
Sektor mit Nestern falsch gewesen.

**Entscheidung Sascha aus drei vorgelegten Varianten: der Faktor misst den Abstand zum
Galaxieschnitt, nicht den Bestand.**

## Wie sie rechnet

```
druck[sek]   = Σ NEST_STUFEN[n.stufe].punkte über die Nester im Sektor
             + SEKTOR_DRUCK_JE_FESTUNG (2) je Festung im Sektor
schnitt      = Σ druck / 8
ueber[sek]   = max(0, druck - schnitt)
npcMult[sek] = min(1,25 ; 1 + 0,02 · ueber)
```

Eine **gleichmäßig belastete Galaxie ergibt in jedem Sektor genau 1,00** — also exakt den heutigen
Stand. Erst eine **Ballung** macht eine Region härter; der absolute Schwierigkeitsgrad bleibt
allein Sache von `npcEmpireStrength`. Nichts wird doppelt gezählt.

**Die Steigung ist gegen die echten Deckel gerechnet, nicht geschätzt.** `NEST_MAX` = 12 Nester,
höchste Stufe 5 Punkte, `FESTUNG_MAX_AKTIV` = 6 zu je 2 Punkten → der Gesamtdruck liegt höchstens
bei 72. Gleichmäßig verteilt trägt jeder der acht Sektoren 9 und steht bei 1,00. Der Deckel ist
erreicht, wenn ein Sektor rund das **Doppelte** seines Anteils trägt (Abstand 12,5):

| Abstand zum Schnitt | 0 | 2 | 5 | 9 | ≥ 12,5 |
|---|---|---|---|---|---|
| `npcMult` | 1,00 | 1,04 | 1,10 | 1,18 | 1,25 |

**Der Boden liegt exakt auf 1,00, in beide Richtungen.** Ein Sektor unter dem Schnitt bekommt
nichts geschenkt — ein Faktor unter 1 wäre eine Erleichterung, die niemand beantragt hat, und sie
fällt niemandem auf, weil sie sich wie Glück anfühlt.

**Die Stufe wird aus demselben Abstand abgeleitet wie der Faktor** (`unruhig` ab 1, `belagert` ab
6), nicht aus dem rohen Druck. Sonst stünde an einer Region „belagert" und daneben ein Faktor von
1,00 — eine Beschriftung, die ihrer eigenen Zahl widerspricht.

## Wo sie im Takt steht

`sektorLageTick(g)` läuft **nach** dem Festungs-Spawn, nicht — wie das Konzept vorschlug — vor der
`npcEmpireStrength`-Zeile. Grund: Der Druck soll den Bestand **dieses** Takts zählen, und
Festungen entstehen weiter unten. Die frühe Position war im Konzept nötig, weil der Faktor dort
noch in den Zielwert von `npcEmpireStrength` einfließen sollte; in der relativen Fassung tut er
das nicht mehr.

## Autorität und Auslieferung

Vollständig Server. `g.sektorLage` liegt in `db.galaxy` und ist über `PUT /api/storage/:key` für
keinen Client erreichbar; es reist über `galaxyFuerClient` mit (`Object.assign` über `g`), ohne
eine Zeile Verdrahtung.

Der Schalter steht auf **false**: Allein ausgeliefert wären NPCs in einzelnen Regionen bis zu
einem Viertel zäher, ohne dass eine Anzeige den Grund kennt. `sektorLageTick` kehrt dann sofort
zurück, **vor** jedem Schreibzugriff, und `g.sektorLage` bleibt auf seiner leeren Vorgabe. Die
Vorgabe steht trotzdem in `loadOrInitGalaxy`, damit das Frontend nicht zwischen „noch nie
gerechnet" und „kaputt" raten muss.

## Kopie-Familie

`SEKTOR_ZENTREN` (acht `{key, cx, cy}`) ist die Server-Hälfte von `SEKTOR_DEFS` im Frontend, das
dort zusätzlich Name, Farbe, Eigenart und Beschreibung trägt. Beide Seiten bei jeder Änderung
pflegen. `sektorVonSystem` rechnet dasselbe Nächster-Nachbar-Verfahren wie `sektorVon` im
Frontend — **auch in der Reihenfolge**: Bei exakt gleichem Abstand gewinnt der zuerst eingetragene
Sektor, ein `<=` statt `<` wäre eine stille Abweichung.

Gemessen am 03.09.2026: Beide Seiten führen **dieselben 69 Systeme mit identischen Koordinaten**
(0 Abweichungen). `tests/test_sektorlage.js` Abschnitt 5 prüft nicht die Tabellen, sondern die
**Wirkung**: Für jedes der 69 Systeme muss auf beiden Seiten dieselbe Region herauskommen.

## Wächter

`tests/test_sektorlage.js`, 23 Prüfungen, rein (kein Server, keine Uhr — die Lage entsteht aus
einer reinen Funktion, die mit gestellten Beständen gefüttert wird). Gegenproben:

| Sabotage | fällt |
|---|---|
| Faktor absolut statt relativ (`e.druck` statt `e.ueber`) | 1 |
| Boden `Math.max(0, …)` entfernt | 2, 3, 4c |
| Deckel entfernt | 2b |
| eine Sektorkoordinate weicht vom Frontend ab | 5a, 5b |
| zwei Sektorzeilen vertauscht | 5a |
| Schalter versehentlich auf `true` | 6 |

Am Stand vor dieser Etappe fällt die Ankerprüfung 0a und der Lauf bricht ab — der Block existiert
dort nicht.

## Was das Frontend noch braucht

Offen bis zum Frontend-PR: `npcEffectiveDefense` muss den Faktor aus `galaxyCache.sektorLage`
mitnehmen und ihn **beim Missionsstart einfrieren** (wie `protoBlockade` beim Abbau) — sonst zeigt
die Vorschau eine Verteidigung, die der Kampf sechs Minuten später nicht mehr benutzt. Dazu die
vierte Textzeile am Regionsknoten, die fünfte Kopfzeile der Sektoransicht, der Info-Block in
`npcMapMenu`, Angriffsvorschau, Kampfbericht und `HELP_SECTIONS`.

Die Frontend-Kopie `NEST_STUFEN` trägt bewusst **kein** `punkte`-Feld, und das soll so bleiben:
Der Client rechnet die Lage nicht nach, er liest sie.
