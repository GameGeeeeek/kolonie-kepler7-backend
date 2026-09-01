# Beute: Boss-Set-Teile ohne Allianz, mythische Stufe (Etappen B und C1)

Verschoben aus `CLAUDE.md` am 01.09.2026 (Strukturprüfung, Punkt 1: Startkontext verkleinern). Wortlaut unverändert; Querverweise wie „unten" oder „oben" beziehen sich auf die frühere Reihenfolge in `CLAUDE.md`. Neue Erkenntnisse zu diesem Bereich gehören ab jetzt hierher, nicht in `CLAUDE.md`.

## Boss-Set-Teile fallen jetzt auch ohne Allianz (Etappe B, 28.08.2026)

**Auftrag Sascha, über `AskUserQuestion` beantwortet mit „alle 4 optionen":** Die zwanzig
Boss-Set-Teile sollen nicht mehr ausschließlich nach einer Allianz-Raid-Welle fallen. Gewürfelt
wird jetzt an **drei** PvE-Zielen — Asteroidenfestung, Alien-Nest und Weltboss —, der Raid bleibt
unverändert der vierte und ergiebigste Weg.

**Der Befund, der die Etappe ausgelöst hat, steht im Beute-Konzept als gemessene Lücke 2:** Alle
20 Teile hingen an `grantBossSetModule()`, und die einzige Aufrufstelle lag im Raid-Claim. Wer
solo spielt, kam an **keines** davon heran — die größte inhaltliche Sperre im Modulsystem.

### Die Naht: der SERVER würfelt, der Client zieht nur noch

`bosssetPveWurf(basis, anteil, stufe)` liefert bei einem Treffer `{ bossKey, seltenheit }` und
sonst `null`. Das ist bewusst dieselbe Arbeitsteilung wie beim Raid: Der Server entscheidet **ob**
und **welches**, der Client legt das Teil über `grantBossSetModule` ins Inventar. Eine
Client-Ziehung wäre in fünf Sekunden gefälscht — und ein Boss-Set-Teil ist genau die Beute, die das
Herkunfts-Schloss aus jedem regulären Fundtopf heraushält.

**Der Wurf reist auf einer VORHANDENEN Belohnung mit** (`bossset` als Feld an
`pushPendingReward`), nicht als eigener Eintrag. Der Grund ist gemessen: Die Warteschlange hält
`list.slice(-20)`, und der Client holt je Start höchstens zehn. Ein zweiter Eintrag je Fall
verdrängte im Grenzfall einen Hort — also ausgerechnet die größere Belohnung.

### Die Kalibrierung — und der Kommentar, der zuerst das Gegenteil behauptete

| Quelle | Grundchance |
|---|---|
| Festung | 0,08 / 0,16 / 0,30 (Schanze / Kastell / Sternenfeste) |
| Nest | 0,05 / 0,09 / 0,15 / 0,24 / 0,45 (Sporenherd … Königin) |
| Weltboss | **0,07** |

**Der Weltboss hat die KLEINSTE Grundchance, und die erste Fassung des Kommentars daneben
begründete genau das Gegenteil** („die größte, weil er eine endliche Quelle ist"). Das war auf die
Annahme „je KILL" gerechnet; gewürfelt wird aber je SCHLAG. Damit ist er die einzige der drei
Quellen mit einer **garantierten täglichen Gelegenheit** — der 24-Stunden-Riegel des
Weltboss-Angriffs —, während Festungen und Nester erst entstehen müssen. Nachgerechnet gegen die
zwei anderen (zusammen 0,333 Teile/Tag): 0,07 gibt +0,070/Tag, also **+21 %**; die ursprünglich
gedachten 0,22 hätten +66 % ergeben und die beiden anderen Quellen dominiert.

**Der Anteilsfaktor läuft von 0,4 bis 1,0** (`bosssetAnteilFaktor`), wie `rShare` im Raid: Wer ein
Zehntel des Schadens getragen hat, soll nicht dieselbe Chance haben wie der Hauptschädiger — der
Sockel 0,4 ist trotzdem Absicht, sonst flögen kleine Konten gar nicht erst mit.

**Die Seltenheit hängt an der Härte des Ziels** (`roll + (stufe−1)·0,06`), nicht an einer eigenen
Tabelle. Eine Sternenfeste liefert damit messbar häufiger legendär als eine Schanze.

### Zwei Fehler am Weltboss-Zweig, beide vom eigenen Wächter gefangen

1. **`boss.contributions[uid]` ist ein OBJEKT `{ name, dmg }`, keine Zahl.** Der erste Entwurf
   las `Number(b2)` und bekam damit `NaN` → Summe 0 → Anteil **immer 0**. Der Anteilsfaktor wäre
   still auf seinem Sockel 0,4 eingefroren gewesen, ohne dass irgendetwas fehlgeschlagen wäre —
   genau die Sorte Größe, die nur der Kommentar behauptet. `test_bossset_pve` 2b prüft seither die
   REGEL („wer den Anteil bildet, liest `.dmg`"), nicht die Schreibweise.
2. **Gewürfelt wird je SCHLAG mit Schaden, nicht nur beim Kill.** Der erste Entwurf hing an
   `killed &&` — damit hätte allein der letzte Schlag belohnt, und das ist exakt die Kritik, die
   beim Hort der Festung zum anteiligen Modell geführt hat. Der `resolve`-Weg erreicht
   bauartbedingt nur den Anfragenden; „an alle Beitragenden" bräuchte die Warteschlange, und die
   ist der Engpass von oben. `2c` hält beides fest.

### Der Wächter

`tests/test_bossset_pve.js` liegt im **FRONTEND**-Repo (dort liegen die Tests, die beide Seiten
lesen) und misst 28 Prüfungen über beide Repos: den Wurf **ausgeführt** statt gelesen, die drei
Aufrufstellen, die NAHT (jede Quelle in `BOSSSET_PVE_CHANCE` braucht eine Frontend-Empfangsstelle,
datengetrieben abgeleitet — eine vierte Quelle fällt damit auf) und die Anzeigestellen.
Gegenprobe beidseitig gefahren: **25 von 28 rot** am alten Stand bei identischer Prüfliste.

**Die Auslieferungsreihenfolge ist dieses Repo ZUERST** (Regel 60): Die drei Empfangsstellen im
Frontend lesen ein Feld, das nur der neue Server schickt. Umgekehrt schriebe der Server ein Feld,
das niemand liest — folgenlos.

## Etappe C1: die Bossstufe entscheidet über die SPITZE des Beutetischs (28.08.2026)

**Auftrag Sascha, über `AskUserQuestion` gewählt: „Mythisch ab Stufenschwelle".** Ab Bossstufe 10
fällt ein erbeutetes Boss-Set-Teil mit stufenabhängiger Chance **mythisch** statt legendär. Umfang
bewusst klein gehalten: eine Backend-Funktion, im Frontend nur Anzeige, dazu der Paritätstest.

Damit ist die dritte der vier gemessenen Lücken aus `docs/beute-und-instanzen-konzept.md` erledigt
(„keine gestufte Schwierigkeit mit eigenem Beutetisch").

### Der Befund: „stufenunabhängig" war falsch, und die naheliegende Stellschraube ist gedeckelt

Das Konzept nennt den Raid-Beutetisch stufenunabhängig. **Gemessen stimmt das nicht** — Fallchance
(+1 Prozentpunkt je Stufe) und Seltenheitswurf (+0,4 Pp) hängen längst an der Stufe. Was fehlte,
war eine Stufe, die man überhaupt noch erreichen kann:

| Größe | Verhalten |
|---|---|
| Fallchance `Math.min(0.75, …)` | läuft **ab Stufe 15** in ihren Deckel |
| Boss-HP | wachsen mit **1,4 je Stufe** |
| erreichbare Stufe | rund **18** (Stufe 20 wären 54 Wellen à 2 h > das 72-h-Fenster des Raids) |

**Ein stärkerer Auftrieb auf die Fallchance wäre damit ein Rabatt auf eine Schranke, die schon
bindet** — genau die Falle aus der Festungs-Blockade („wer einen Faktor an eine Schranke hängt, muss
zuerst messen, ob diese Schranke überhaupt bindet") und aus Abgrund C2. Der freie Kanal ist die
**Seltenheit**: Sie hat keinen Deckel, endete aber bei `legendaer`.

### Die Schwelle 10 ist GELIEHEN, nicht gegriffen

Es ist dieselbe Stufe, ab der das Großprojekt (`ALLIANCE_MISSION_CADENCES.monthly`, `minLevel: 10`)
mythische Module ausschütten kann — die eine vergleichbare Quelle, die es im Spiel gibt. Eine frei
gewählte Zahl daneben wäre eine zweite Schwelle für dieselbe Sache.

### Kalibriert gegen die FREQUENZ, nicht gegen die Einzelchance

Ein Modul fällt nur bei der Kill-Welle, also genau **einmal je Raid**, und ein Raid auf Stufe 15
dauert gemessen 29 h (1 h Sammelphase + 11 Wellen à 2 h + 6 h Restart-Sperre). Für den
Hauptschädiger ergibt das je Monat:

| Bossstufe | 10 | 12 | **15** | 18 |
|---|---|---|---|---|
| mythische Set-Teile / Monat | 0,14 | 0,33 | **0,37** | 0,24 |

**Das Maximum liegt bei Stufe 15, nicht oben** — die HP wachsen schneller, als die Chance steigt.
Wer die Stufe hochtreibt, bekommt bessere Chancen JE KILL, aber nicht mehr Module je Monat; eine
Farm-Spitze am oberen Ende entsteht dadurch gar nicht erst.

**Die erste Fassung dieser Rechnung war zweimal falsch, und beide Male an der BEZUGSGRÖSSE** (die
Frontend-Regel 21 an einer Balance-Zahl): Zuerst je *Welle* statt je *Kill* gerechnet — der Wurf
läuft aber nur bei `destroyed`, also einmal je Raid statt elfmal. Danach je *Gelegenheit* statt je
*Monat* — und erst die Umrechnung auf die Zeitachse zeigt, dass das Maximum in der MITTE liegt.

### Warum 0,37/Monat unbedenklich ist — gemessen statt behauptet

Mythische Module an sich sind für ein Endspiel-Konto keine Rarität: Die Mythische Modulschmiede
fertigt sie **deterministisch** für 15 Metamaterial-Gewebe + 8 Singularitätskerne, unbegrenzt oft.
Was sie NICHT kann, ist ein Boss-Set-Teil — die tragen `HERKUNFT_BOSS` und sind aus jeder Schmiede,
aus jedem Fundtopf und aus dem Verschmelzen ausgeschlossen. **„Mythisch UND Boss-Set-Teil" gibt es
auf keinem anderen Weg im Spiel**, und bei 20 Teilen dauert ein einzelnes VOLLSTÄNDIGES mythisches
Set im Erwartungswert rund 11 Monate.

**Der SET-Bonus bleibt unberührt:** `setBonusAt` im Frontend liest nur den TYP des Moduls
(`k.split(':')[0]`), nicht seine Seltenheit. Mythisch ändert allein den Einzelbonus des Stücks
(`MODULE_RARITY_MULT` 3,5 → 5,0, also +43 %) — eine begrenzte und benennbare Balance-Folge.

### Drei Entscheidungen im Code

- **Aufgewertet wird nur der LEGENDÄRE Ast** (`roll > 1.02`). Ein gewöhnlicher Wurf soll durch die
  Bossstufe nicht plötzlich mythisch werden: Die Stufe verbessert, was oben herauskommt, nicht den
  Durchschnitt. Dasselbe Muster wie beim Präzedenzfall, wo die 8 % des Großprojekts ebenfalls nur
  auf `legendaer` greifen.
- **Der Wurf wird nur gezogen, wenn die Stufe ihn zulässt** (`pMyth > 0 &&`). Ein `Math.random()`
  unterhalb der Schwelle verschöbe die Zufallsfolge, ohne je etwas zu entscheiden.
- **`Math.max(1, level | 0)` in der Chance-Funktion**, damit `undefined`/`null`/`NaN`/negativ
  denselben Boden treffen wie in `allianceRaidModuleDrop` daneben — der Paritätstest fährt genau
  diese Randfälle über beide Repos.

### Der Kommentar, der die Etappe beinahe blockiert hätte

An der Stelle stand: „`mythisch` fällt hier bewusst NIE — die Stufe ist im ganzen Spiel kein
Fundgegenstand (siehe `MODULE_RARITY` im Frontend)." **Gemessen ist das falsch.** `MODULE_RARITY`
sagt „bewusst NICHT im normalen Fundpool" und nennt die hochstufigen Allianzmissionen ausdrücklich
als Weg — `grantAllianceMissionBonusModule` wertet dort seit jeher legendär mit 8 % auf mythisch
auf. **Aus „nicht im normalen Fundpool" war im Kommentar ein „gibt es nirgends" geworden**, und wer
ihm glaubt, hält die Etappe für ausgeschlossen, ohne nachzusehen.

Das ist die KB-20i-Familie aus der Frontend-CLAUDE.md, nur in ihrer teuersten Ausprägung: Ein
Kommentar mit einer ungemessenen Begründung wird beim nächsten Lesen als REGEL gelesen — und diese
hier hätte eine Entscheidung verhindert statt nur eine falsche Zahl zu tragen. **Vor jedem „das
geht nicht, steht so im Kommentar" wird die genannte Quelle aufgeschlagen.**

### Der Wächter

`tests/test_raid_belohnung_paritaet.js` im **FRONTEND**-Repo, Abschnitt 5 (14 Prüfungen insgesamt).
Er schneidet `allianceRaidMythischChance` samt ihren drei Konstanten aus BEIDEN Repos und führt sie
über ein Stufenraster plus die Randfälle `undefined/null/NaN/-5/'12'` aus.

**5a ist die Parität, 5b–5d messen die WIRKUNG** — und das ist keine Fleißarbeit, sondern belegt:

| Gegenprobe | fällt | Beleg |
|---|---|---|
| Backend `JE_STUFE = 0.02` | `5a` | `[{"lvl":10,"front":0.015,"back":0.02}]` |
| Frontend `AB = 1` | `5a`, `5b` | `{"geprueft":1,"werte":[0.015]}` |
| **BEIDE** Seiten `JE_STUFE = 0` | `5c`, `5d` — **`5a` bleibt grün** | `{"werte":[0,0,0,0,0,0,0,0,0]}` |

**Die dritte Zeile ist der Grund, warum 5c/5d existieren:** Ein Paritätsvergleich über einer
konstanten Größe kann nicht fehlschlagen (Frontend-Regel 28/62). Alle drei beidseitig gefahren, je
14 Prüfungen, identische Prüfnamen per `diff` verglichen.

**Die Auslieferungsreihenfolge ist dieses Repo ZUERST** (Regel 60): Die Frontend-Zeile nennt eine
Chance, die nur der neue Server einlöst. Umgekehrt würfelte der Server eine Seltenheit, die das
Frontend nicht ankündigt — folgenlos, aber unsichtbar.

**Und ein Werkzeugfehler im eigenen Mess-Skript, wörtlich Regel 60 und der Nachtrag zu Regel 19:**
Der Gegenproben-Vergleich las die Prüfzeilen **samt ihrem Beleg** (`5a: … | {…}`) und zählte die
Schlusszeile `FAIL - es gab rote Pruefungen.` als 15. Prüfung mit. Beide korrekten Sabotagen
meldeten dadurch „PRUEFLISTE ABWEICHEND" und „15 statt 14". Verglichen wird der reine Prüf-NAME
(`sed -E 's/^(OK|FAIL) +- //; s/ \|.*$//'`), und die Schlusszeile wird ausdrücklich herausgefiltert.


