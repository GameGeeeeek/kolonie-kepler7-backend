# Kampfrechnung und Frontend-Parität: Flottenverteidigung, Klassen-Sets, Raid-Vorschau, Schiffstabellen, Kausalitätsbrecher

Verschoben aus `CLAUDE.md` am 01.09.2026 (Strukturprüfung, Punkt 1: Startkontext verkleinern). Wortlaut unverändert; Querverweise wie „unten" oder „oben" beziehen sich auf die frühere Reihenfolge in `CLAUDE.md`. Neue Erkenntnisse zu diesem Bereich gehören ab jetzt hierher, nicht in `CLAUDE.md`.

## Die Flottenverteidigung war eine Vereinfachung – vier Abweichungen (21.08.2026)

Auftrag Sascha, nach vorgelegter Messung: „Alle drei angleichen, Frontend gilt." (Gefunden wurden
am Ende **vier**; die vierte folgt derselben Regel und ist mitgezogen.)

**Anlass war eine ganz andere Frage** – ob die neuen Klassen-Set-Boni (`docs/beute-und-instanzen-konzept.md`,
Teil A) auf `atk`/`hull`/`shield` wirken dürfen. Beim Nachmessen stellte sich heraus, dass der
Server von 44 Schiffsmodulen nur **vier** kennt und seine Flottenverteidigung seit Monaten etwas
anderes rechnet als das Frontend.

**Gemessen an einer Flotte aus 200 Schlachtschiffen, 300 Kreuzern, 200 Zerstörern und
100 Metamaterial-Titanen:**

| | Verteidigungsbeitrag |
|---|---|
| Frontend **ohne** Module | 35.000 |
| Frontend **mit** je drei epischen Hüllen- und Schildmodulen | 68.552 |
| **Backend** (immer) | **51.600** |

Ohne Module schrieb der Server **+47 %** zu viel gut, mit Modulen **−25 %** zu wenig. **Die beiden
Fehler haben einander verdeckt** – ein mittelmäßig ausgerüsteter Spieler landete zufällig nahe der
Parität, und genau deshalb ist es nie aufgefallen.

### Die vier Ursachen

1. **Die Schild-Basis** (der größte Posten). Von 43 Schiffstypen haben **34 keinen** eigenen
   `shield`-Wert. Das Frontend gibt ihnen die Basis **0**; seine Konstruktion
   `(def.atk||0)*shieldBonus*0.5` existiert nur, damit ein prozentualer Modulbonus überhaupt etwas
   zum Verstärken hat – der Kommentar dort sagt das wörtlich. `shipShield()` machte daraus eine
   echte Basis: im Beispiel **3,1× so viel Schild**.
2. **Die Module.** `hull`/`shield` kannte der Server gar nicht; `SHIP_MODULE_COMBAT_BASE` führte
   4 von 44 Einträgen, alle mit `atk`/`siegechance`.
3. **Die Kampfforschung.** Das Frontend multipliziert den Flotten-Angriffsanteil mit
   `rkampf`/`rkampf2` (je 2 %/Stufe, max 20) – bis **×1,96**. Der Server wandte auf die
   Verteidigung nur `rpanzer`/`rschildmatrix` an.
4. **Der Trägerhangar.** Das Frontend wertet Jäger/Bomber nur bis zur Trägerkapazität
   (`deployableFighters`). Der Server zählte sie voll: **2000 Jäger ohne einen einzigen Träger
   trugen 8.050 statt 0.**

**Keine dieser Vereinfachungen war ein Versehen** – zwei sind im Backend sogar auskommentiert
(„der Backend-Ansatz kennt generell keine Schilde, vorbestehende Vereinfachung" und „das Backend
kennt den Hangar-Mechanismus ohnehin nicht"). Sie sind über Monate angewachsen, bis die Summe
weit neben dem stand, was der Spieler sieht.

### Warum das FRONTEND gilt

Es ist die Seite, die der Spieler sieht, und seine Konstruktionen sind im Quelltext begründet,
während die Server-Vereinfachungen erfunden waren. **Folge für die Balance, und sie gehört
benannt:** Verteidigung wird **modulabhängig** – wer ausgerüstet ist, gewinnt, wer nichts
ausgerüstet hat, verliert.

**Nach der Angleichung gemessen, dieselbe Flotte, Frontend gegen Backend: 35.000 zu 35.000 ohne
Module, 63.944 zu 63.944 mit drei epischen Hüllenmodulen je Klasse – Abweichung NULL.**

### Vier Dinge, die man beim Anfassen wissen muss

- **Der Hüllen-Deckel ist HART** (`Math.min(1.0, …)`), nicht `weicherDeckel`. Die weiche Form gilt
  im Frontend ausschließlich für den `atk`-Kanal. Der Schild-Bonus ist **ungedeckelt** – ebenfalls
  wie vorne.
- **Zweitwerte zählen mit.** `MODULE_SUB_POOL_SHIP` trägt `hull` und `shield`; ohne
  `moduleSubsServer()` wäre die Spiegelung unvollständig, und ein Spieler mit hull-Substats bekäme
  serverseitig weniger, als sein Spiel ihm anzeigt.
- **Die Synergien fehlen bewusst.** Gemessen tragen alle sechs ausschließlich `speed`/`fuel`/`cargo`.
  `test_schiffsmodul_paritaet.js` 3a hält das fest – wer dort je eine auf `hull`/`shield`/`atk`
  anlegt, muss sie hier nachziehen.
- **`save` ist optional.** Die Asteroiden-Anfechtung ruft mit der Eskorte eines FREMDEN Spielers
  auf und hat dessen Spielstand nicht zur Hand – dort bleibt es (wie schon bei den Marken) beim
  blanken Flottenwert. Seine Eskorte verliert damit ebenfalls die erfundene Schild-Basis; die
  Vorschau der Anfechtung zeigt bewusst keine Zahl, es wird dort also nichts falsch, aber die
  Kräfteverhältnisse verschieben sich. **Nebenbefund:** Der Kommentar dieser Vorschau sagt, der
  Server rechne mit „Werftmarken, Module des Halters" – die Aufrufstelle übergibt beides als `null`.

### Die Auslieferungsreihenfolge ist hier ausnahmsweise gleichgültig

Anders als bei den Festungen (Frontend-Regel 60) entsteht keine stille Verschlechterung: Der Server
**konvergiert auf die Zahl, die das Frontend längst anzeigt**. Geht dieses Backend allein live,
stimmen Anzeige und Kampf zum ersten Mal überein. Ein Schalter ist deshalb nicht nötig.

### Der Wächter

`tests/test_schiffsmodul_paritaet.js` liegt im FRONTEND-Repo (dort liegen die Paritätstests) und
hat 22 Prüfungen: Tabellen, Klassenzuordnung, die Synergie-Wache und **vier ausgeführte
Wirkungsmessungen**. Vier Gegenproben, jede speist genau eine der vier Abweichungen wieder ein und
muss ihre eigene Prüfung reißen – bei jeweils 22 gelaufenen Prüfungen.

**Eine Lehre aus dem Bau dieses Tests, die über ihn hinausgeht:** Seine Bausteinliste war zuerst
eine Liste von 21 benannten Blöcken – und hatte damit die Schwäche jeder Namensliste. Die Gegenprobe
zur Schild-Basis baute `shipShield()` wieder ein, das in der Liste fehlte; der Test brach am Aufbau
ab statt an `4a`, fuhr **14 statt 22** Prüfungen, und die Sabotage sah grün aus. Gefangen hat das
nur die `WERKZEUGFEHLER`-Wache des Messskripts (Frontend-Regel 71). Der Sammler holt seither
Konstanten **und Funktionen** transitiv; die Liste ist auf die zwei Zielfunktionen geschrumpft.

## Klassen-Sets der Schiffsmodule (21.08.2026, Teil A des Beute-Konzepts)

Auftrag Sascha: „Findbare Module die zusammen set Bonus geben". Set-Boni gab es schon – aber nur
bei den STANDORT-Modulen und den Boss-Sets. Die 44 Schiffsklassen-Module hatten **keinen einzigen**
(gemessen: 0 Treffer). Jede der acht Klassen hat jetzt ein Set aus drei namentlich festgelegten
Modulen, gestaffelt bei zwei und drei Teilen.

**Warum die Tabelle hier liegt:** Der Set-Bonus trägt `atk`, `hull` und `shield` und entscheidet
damit PvP. `SHIP_MODULE_SET_DEFS` ist deshalb eine Kopie – dieselbe Familie wie
`SHIP_MODULE_COMBAT_BASE` daneben. `tests/test_schiffsmodul_paritaet.js` im FRONTEND-Repo hält
beide Seiten Feld für Feld zusammen.

**Eingespeist wird an ZWEI Stellen**, weil es zwei Verbrauchspfade gibt: `shipModuleBonus`
(der `atk`-Pfad) und `shipModulKlassenBoni` (`hull`/`shield`). Beide addieren **vor** dem Deckel –
genau wie das Frontend, wo der Set-Bonus in `shipModuleBonusFor` steckt und `Math.min(1.0, …)`
erst an der Verbrauchsstelle greift.

**Drei Entscheidungen, die vorher gemessen wurden:**

- **Bestimmte Schlüssel statt „N beliebige".** Der erste Entwurf wollte nach ANZAHL staffeln wie
  die Boss-Sets. Gemessen ist das hier keine Entscheidung: `equipShipModule` im Frontend verbietet
  zwei Module desselben TYPS an einer Klasse, es gibt also gar keine Stapel-Alternative – „zwei
  beliebige" wäre schlicht eine Belohnung dafür, einen zweiten Slot gekauft zu haben.
- **Kein Set trägt einen Kanal, den seine Klasse nicht verbraucht.** Gemessen wirken
  `hull`/`shield`/`speed`/`fuel` in allen Klassen, `atk` nur in `schlachtschiff` und `raffiniert`,
  `cargo` nur in `frachter`. Ein Set-Bonus auf `atk` für die Schwere Linie wäre ein Tabellenfeld,
  das nur der Anzeigetext liest (Frontend-Regel 59). `test_schiffsmodul_paritaet.js` 5d leitet
  diese Zuordnung aus der Spieldatei AB und prüft sie – sie ist nicht eingetippt.
- **Der Mondzerstörer bekommt bewusst kein `atk`.** Der Server verbraucht es (Mondangriff), das
  Frontend nicht – die Vorschau verschwiege sonst eine Wirkung, die im Kampf eintritt.

**Ein Nebenbefund, der beim Vermessen der Kanäle herausfiel und NICHT behoben ist:** Das
Event-Modul `ev_erzgreifer` („Erzgreifer-Ausleger", `cargo`, `base:0.25`) bewirkt **nichts**.
`cargo` wird ausschließlich für die Frachter-Klasse gelesen, und die drei Frachtschiffe
(`frachter`, `frachtergross`, `bergungsfrachter`) gehören alle dorthin – Event-Schiffe haben
überhaupt keine Frachtkapazität. Seine Beschreibung verspricht ausdrücklich „erhöht die
Frachtkapazität aller Event-Schiffe deutlich". Eine per-Klasse-Umstellung von
`fleetCargoCapacity` würde daran nichts ändern; es bräuchte entweder Frachtraum für Event-Schiffe
oder eine Umwidmung des Moduls. **Das ist eine Entscheidung über die Identität eines
Event-Gegenstands und liegt bei Sascha.**

**Die Auslieferungsreihenfolge ist hier NICHT gleichgültig** (anders als bei der Angleichung
darüber): Geht ein Repo allein live, entsteht genau die Divergenz, die gerade behoben wurde –
einmal in die eine, einmal in die andere Richtung. Beide PRs gehören unmittelbar nacheinander
gemergt, das Backend zuerst und per `/api/health`-Blob belegt, bevor das Frontend folgt.

## Die Belohnungsvorschau des Allianz-Raids liegt im FRONTEND (22.08.2026)

Auftrag Sascha: „allianz raid deutlich optisch aktraktiver gestalkten weniger text und vsl.
belohnungen einblenden." **Dieses Repo liefert dafür nichts** — die Vorschau rechnet das Frontend
(v8.607.0), abgesichert durch `tests/test_raid_belohnung_paritaet.js`, das beide Fassungen von
`allianceRaidRewardFor` **ausgeführt** gegeneinander rechnet.

**Der Abschnitt steht hier, weil dieses Repo die Vorschau schon einmal hatte — für 23 Minuten.**
Vorgelegt wurden zwei Wege, gewählt wurde zuerst das Serverfeld (keine Kopie-Familie). Es war
gebaut, getestet und gemergt (#161), als sich zeigte, dass eine parallele Sitzung dieselbe Aufgabe
im Frontend gelöst und bereits ausgeliefert hatte. Das Feld `doc.dispatch.vorschau` las damit
**niemand** — genau die Sorte Eintrag, die beim nächsten `grep` wie umgesetzte Mechanik aussieht
(Regel 59). Es ist deshalb wieder draußen; `server.js` ist byte-identisch mit dem Stand davor.

**Zwei Argumente sprachen bei der Neubewertung FÜR die Frontend-Lösung**, und beide lagen bei der
ursprünglichen Wahl nicht auf dem Tisch:

1. Die Kopie-Familie ist durch einen **ausgeführten** Paritätstest zusammengehalten, nicht durch
   einen Textvergleich — also genau der Wächter, dessen Fehlen das Argument gegen Kopien trägt.
2. Sie funktioniert, **wenn der Backend-Deploy hängt**. Das ist hier zehnmal passiert, zuletzt am
   selben Tag: Ein Serverfeld hätte die Zeile in genau diesen Stunden verschwinden lassen.

**Wer sie doch einmal hierher holt**, braucht `doc.dispatch` als Ablageort (das Frontend liest den
Raid über `storageGet('alliance:<TAG>:raid')`, eine Leseroute gibt es nicht), muss beide Varianten
ablegen (nach dem Abflug steht alles fest außer dem Kampfausgang) und die Frontend-Kopie samt
Paritätstest im selben Zug entfernen — sonst stehen wieder zwei Wahrheiten nebeneinander.

**Die eigentliche Lehre ist Regel 69, und sie hat diesmal zu spät gegriffen.** Geprüft wurde vor
dem ersten Zeichen Code, ob die Aufgabe auf `origin/main` schon steht — `allianceRaidRewardFor` kam
im Frontend **null**mal vor. Die fremde Lieferung kam eine Stunde später. **Ein Blick zu Beginn
genügt nicht, wenn die eigene Arbeit über eine Stunde läuft**; er gehört auch unmittelbar vor den
Merge, und zwar mit einem Suchbegriff aus der SACHE (hier `allianceRaidRewardFor`), nicht aus der
eigenen Umsetzung — deren Namen kennt eine fremde Lösung ja gerade nicht.

## Eine neue Schiffsklasse lebt in SECHS Tabellen dieses Repos (21.08.2026, Urmaterie-Koloss)

Das Frontend hat mit Etappe D den **Urmaterie-Koloss** bekommen (`atk:250`, Frachtraum 2.000,
Punktegewicht 175) — der erste wiederkehrende Protomaterie-Abnehmer. Dieses Repo führt davon
**sechs** Kopien (gemessen: `grep -c urmateriekoloss server.js`), und beim ersten Anlauf waren nur
zwei davon gepflegt.

| Tabelle | ohne Eintrag |
|---|---|
| `SHIP_SCORE_WEIGHTS` | Punktestand seiner Besitzer zu niedrig |
| `COUNTER_ROLE_OF` | Werftmarken-Schild 0,03 statt kapital 0,04 (über `shipMarkShieldPerStep`) |
| `rawFleetPower` | trägt **0** Angriff bei — der Koloss existiert im PvP-Angriff nicht |
| `SHIP_ATK_VALUES` | **0** in der Verteidigung UND in `fleetShieldSum` |
| `SHIP_DEF_WEIGHTS` | Vorgabegewicht 1 statt 1,8 |
| `COUNTER_ROLE_ATK` | zählt nicht in die Flottenbalance |

**`SHIP_ATK_VALUES` ist die unangenehmste der sechs**, und der Grund steht in der Schleife selbst:
`weightedFleetDefensePower` und `fleetShieldSum` iterieren über `Object.keys(SHIP_ATK_VALUES)` — ein
fehlender Schlüssel trägt also **0 ohne jeden Vorgabewert**, und zwar in zwei Rechnungen auf einmal.
`SHIP_DEF_WEIGHTS` daneben hat ein `!== undefined ? … : 1`, fällt also weich aus. Eine Klasse, die
in der einen Tabelle fehlt, ist damit im Kampf unsichtbar; fehlt sie nur in der anderen, ist sie
bloß falsch gewichtet.

**Zwei der sechs hat KEIN Test gemeldet.** `SHIP_ATK_VALUES` und `SHIP_DEF_WEIGHTS` fielen erst beim
Durchgehen aller Tabellen auf, die eine Schiffsklasse führen — die Paritätstests im Frontend decken
`SHIP_SCORE_WEIGHTS`, `COUNTER_ROLE_OF` und `COUNTER_ROLE_ATK` ab, diese beiden nicht.
**Vorgehen beim Anlegen einer neuen Schiffsklasse:** `grep -c "<schluessel>" server.js` — die Zahl
muss **sechs** sein, und wer eine der sechs bewusst auslässt, schreibt den Grund daneben.

**Die Reihenfolge in `COUNTER_ROLE_OF` ist nicht gleichgültig.** `test_konter_paritaet` im Frontend
vergleicht die zwei Tabellen per `JSON.stringify`, und das ist reihenfolgeabhängig. Der Eintrag steht
deshalb an derselben Stelle wie dort (hinter `metamaterialtitan`), nicht am Tabellenende — dort hatte
er zuerst gestanden und den Test auf völlig korrekten Werten reißen lassen.

**Zwei Klassen waren bewusst NICHT ergänzt**, obwohl derselbe Durchgang sie als fehlend zeigte:
`mondzerstoerer` (dokumentierte Absicht — der Kommentar an der Stelle nennt sie ausdrücklich) und
`kausalitaetsbrecher` in `SHIP_DEF_WEIGHTS`/`SHIP_SHIELD_EXPLICIT`. Das zweite war ein gemessener
Bestands-Balancefall und gehörte in eine eigene Entscheidung — eine PvP-Zahl im Vorbeigehen zu
verschieben wäre eine unbestellte Zweitänderung gewesen. **Sascha hat sie am 22.08.2026 getroffen:
angleichen.** Der eigene Abschnitt weiter unten hält fest, was gemessen wurde und welcher Wächter
seither darüber steht.

**Kein `t2AtkMult` am Koloss:** Der Multiplikator kommt aus der Modulgruppe `raffiniert`, und die
führt ihn nicht. Dieselbe Begründung steht an derselben Zeile in `attackPowerRaw` des Frontends —
wer sie hier ergänzt, ohne dort nachzusehen, erzeugt genau die Abweichung, die `#156` gerade an vier
Stellen beseitigt hat.

**Auslieferungsreihenfolge: dieses Repo ZUERST** (Regel 60). Umgekehrt könnte ein Spieler einen
Koloss bauen, dessen Punktestand, Schild und Kampfkraft der Server still falsch rechnet.
Andersherum kennt der Server ein Schiff, das noch niemand hat — folgenlos.

## Der Kausalitätsbrecher zählte im PvP nur ein Drittel (22.08.2026)

Auftrag Sascha, nach vorgelegter Messung: **„Angleichen."** Damit ist der letzte der beiden
Bestandsfälle aus dem Abschnitt darüber erledigt; `mondzerstoerer` bleibt die eine dokumentierte
Ausnahme.

Das stärkste Schiff des Spiels (`atk:340, shield:120, defWeight:1.8`) fehlte in **beiden**
Verteidigungstabellen. Beide Schleifen laufen über `SHIP_ATK_VALUES` – dort stand er korrekt –,
holen ihre Faktoren aber aus `SHIP_DEF_WEIGHTS` und `SHIP_SHIELD_EXPLICIT`, und ein fehlender
Eintrag heißt dort Vorgabegewicht 1 bzw. **Schildbasis 0**.

**Gemessen, indem `weightedFleetDefensePower` und `fleetShieldSum` aus dieser Datei geschnitten und
ausgeführt wurden** – nicht nachgerechnet:

| je Schiff | vorher | angeglichen |
|---|---|---|
| ohne Kampfforschung | **136** | 365 |
| mit `rkampf`/`rkampf2` auf Maximum | 267 | 600 |
| 100 Stück, ohne Forschung | 13.600 | 36.480 |

**Eine Korrektur in eigener Sache gehört dazu:** Die Entscheidungsvorlage nannte den heutigen Wert
mit 306 (`340·1·0,4 + 170`) und damit einen Zuwachs von 19 %. Die 170 waren die halbe
Angriffskraft – also genau die **erfundene Schildbasis, die `shipShield()` bis zum 21.08.2026
lieferte** und die mit dessen Entfernung weggefallen ist. Wirklich beitragen tut das Schiff heute
**136**, der Zuwachs ist also **+168 %** statt +19 %. Die Entscheidung wird dadurch nicht anders,
die Lücke war nur größer als vorgelegt. Dieselbe 170 stand als „Vorgabe … bzw. 170 statt 120" auch
im Abschnitt darüber und ist dort mit korrigiert.

**Die Auslieferungsreihenfolge ist dieses Repo ZUERST** (Regel 60): Bis der Server nachzieht, zeigt
die Werft einen Schild- und Verteidigungswert an, mit dem im PvP nicht gerechnet wird – umgekehrt
gibt es keinen Zustand, in dem eine Zahl still falsch würde.

### Der Wächter, den es bis dahin nicht gab

`tests/test_paritaet_tabellen.js` im FRONTEND-Repo, Abschnitt 5 (7 Prüfungen). **Kein einziger Test
hat diese zwei Tabellen bis dahin gelesen** – der Abschnitt über den Urmaterie-Koloss nennt genau
das als offene Flanke („Zwei der sechs hat KEIN Test gemeldet"), und der Kausalitätsbrecher ist
monatelang durch sie hindurchgefallen.

Geprüft wird die **WIRKUNG, nicht die Tabellenmitgliedschaft**: Ein Schiff ohne Eintrag ist kein
Fehler, es bekommt dann den Vorgabewert. Falsch ist erst ein abweichender wirksamer Wert. Dazu drei
Richtungen, die eine reine Feld-für-Feld-Prüfung nicht hätte:

- **5c2** – ein Eintrag in `SHIP_DEF_WEIGHTS`/`SHIP_SHIELD_EXPLICIT`, den `SHIP_ATK_VALUES` nicht
  kennt, wird von beiden Schleifen gar nicht erst gelesen: stiller toter Code (Regel 59).
- **5d** – ein Schiff **mit** Kampfwerten, das in `SHIP_ATK_VALUES` fehlt, trägt **null** ohne
  jeden Vorgabewert. Das ist die Richtung, an der der Urmaterie-Koloss beinahe gescheitert wäre.
- **5b** – das Superschlachtschiff hat keinen `SHIP_DEFS`-Eintrag und wird trotzdem verglichen: Es
  aus dem Wächter zu nehmen wäre die schwächere Lösung, seine drei Werte stehen im Frontend
  genauso schwarz auf weiß, nur in eigenen Konstanten (`SUPERSCHLACHTSCHIFF_SHIELD`,
  `SUPERSCHLACHTSCHIFF_DEF_WEIGHT`, `shipBaseAtk`).

Sieben Gegenproben, jede mit ihrer eigenen „was muss fallen"-Liste (Regel 71), alle mit 37
gelaufenen Prüfungen in beide Richtungen: Kausalitätsbrecher aus beiden Tabellen → `5a` mit
`["kausalitaetsbrecher defWeight: FE=1.8 BE=1","kausalitaetsbrecher Schild: FE=120 BE=0"]`; je
einzeln → `5a`; Superschlachtschiff-Schild verstellt → `5b`; ungelesener Eintrag → `5c2`;
Kampfschiff aus `SHIP_ATK_VALUES` entfernt → `5c2` und `5d`; erfundenes Backend-Schiff → `5c`.

**Ein Werkzeugfehler beim Bau, und er ist die eigentliche Lehre des Abschnitts:** Die erste Messung
las `SHIP_DEFS` **zeilenweise** – wie Abschnitt 4 daneben, wo das richtig ist – und meldete drei
Abweichungen bei Paktkorvette, Bundeskreuzer und Sternenbanner. Die drei Allianzschiffe tragen ihr
`defWeight` aber auf der **zweiten Zeile** ihres Eintrags; es gab keine einzige Abweichung.
Beinahe wären drei erfundene Befunde weitergegeben worden (Regel 10 hat sie abgefangen). Geschnitten
wird seither vom Eintragsanfang bis zum nächsten Eintragsanfang, und `5-vorab` belegt an der
Paktkorvette, dass die mehrzeilige Lesung wirklich greift – sonst wäre der ganze Abschnitt still
blind für jedes mehrzeilig definierte Schiff.


