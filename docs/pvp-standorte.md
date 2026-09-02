# PvP auf alle Standorte (Etappe 1, Backend)

Verschoben aus `CLAUDE.md` am 01.09.2026 (Strukturprüfung, Punkt 1: Startkontext verkleinern). Wortlaut unverändert; Querverweise wie „unten" oder „oben" beziehen sich auf die frühere Reihenfolge in `CLAUDE.md`. Neue Erkenntnisse zu diesem Bereich gehören ab jetzt hierher, nicht in `CLAUDE.md`.

## PvP auf alle Standorte (Etappe 1, Backend, 29.08.2026)

**Auftrag Sascha (wörtlich): „prüfe man kann nur hauptlanet von spielern angreifen keine kolonien
es sollen alle von spielern kolonisierten planeten angreifbar sein mehr pvp aktion!"** Gewählt per
Auswahl: „Voller Standort-Kampf, 2 Etappen". Konzept mit allen Zahlen und den zwei Zusagen:
**`docs/pvp-standorte-konzept.md` im FRONTEND-Repo.** Diese Etappe ist das Backend; die Zielwahl-UI
folgt als eigene Frontend-Etappe.

**Was gebaut ist:** `/api/attack` nimmt optional `targetPlanet` entgegen ('home' oder ein
Kolonien-Schlüssel) und kämpft dann gegen die Verteidigung EINES Standorts;
`GET /api/spieler-standorte?target=<id>` liefert die Zielwahl-Liste (key, art, verteidigung,
beuteFaktor). Ohne das Feld läuft byte-genau der bisherige Konto-Kampf.

### Die Zerlegung: computeDefensePower ist jetzt eine Summe über Standorte

`standortDefGebaeude(save, key)` + `standortDefFlotte(save, key)` sind die Standort-Summanden,
`kontoDefenseFaktoren(save, basis)` die kontoweite Faktorkette (Forschung, Perk, Doktrin, Haltung,
Bonusgruppe, Buff, Sabotage, T2-Aura) – **GENAU EINMAL vorhanden, beide Einstiege laufen
hindurch**: `computeDefensePower(save)` summiert alle Standorte, `standortVerteidigung(save, key)`
nimmt einen. **Byte-Gleichheit ist eine Float-Aussage, keine „ungefähr gleich"-Aussage:** Die
Zerlegung erhält die exakte Operationsreihenfolge des alten Rumpfes (Gebäude Heimat → Gebäude
Kolonien → Flotte Heimat → Flotte Kolonien), und `x*1`/`x+0` sind in IEEE-754 exakt – deshalb ist
`standortVerteidigung(save,'home') === computeDefensePower(save)` für Konten ohne Kolonien. Der
DAUERHAFTE Wächter darauf ist `test_pvp_standorte_http.js` 2c (GET-verteidigung gegen die
defensePower eines echten Kampfes – zwei Einstiege, eine Faktorkette).

### Entscheidungen, die man beim Anfassen kennen muss

- **Der Schutzschild bleibt KONTOWEIT** (`__attackShieldUntil` am Konto): Ein Sieg auf irgendeinem
  Standort schützt das ganze Konto. Je-Standort-Schilde wären ein Farming-Kanal (nacheinander alle
  Standorte desselben Opfers leerfarmen). Test 7a misst genau das.
- **`STANDORT_BEUTE_FAKTOR` = heimat 1,0 / kolonie 0,5 / mond 0,35** – nur der SIEG-Zweig
  multipliziert ihn auf die Beute; `defenderLossPct` trägt ihn NICHT. Genau deshalb lässt er sich
  im Test als VERHÄLTNIS messen (`stolen / (Pool * defenderLossPct * 2)` isoliert exakt den
  Faktor, unabhängig vom Zufallswurf) – absolute Spannen allein überlappen sich zwischen den
  Faktoren und beweisen nichts in jedem Wurf.
- **Die Gebäude-Zerstörung würfelt nur noch über den ANGEGRIFFENEN Standort**
  (`standortBuildingsRef`) – am Altpfad weiter über alle. Im Test ist sie dadurch am neuen Stand
  DETERMINISTISCH (Fixture mit verschiedenen Anlagen-Schlüsseln je Standort), am alten ein
  50/50-Wurf – weshalb Prüfung 8b ausdrücklich in KEINER Gegenproben-Pflichtliste steht.
- **`GET /api/spieler-standorte` hat BEWUSST kein Honeypot-Gate.** Der Spionage-Honeypot ist eine
  REIN CLIENTSEITIGE Mechanik (der Client verfälscht seine eigene Anzeige); der Server kennt ihn
  nicht. Eine Sperre hier wäre eine Attrappe – der Angreifer bekäme dieselben Daten über einen
  Angriff mit anschließendem Bericht. Die Honeypot-Verfälschung der Standortliste gehört ins
  Frontend (steht im Konzept §2.5).
- **`pvp-fleet-loss` trägt im Standort-Fall `planetKey`**, damit der Verteidiger-Client die
  Verluste der STANDORTFLOTTE zuordnen kann; im Altpfad fehlt das Feld (alte Clients sehen exakt
  das bisherige Objekt).

### Auslieferung: KEIN Schalter nötig – und warum das hier stimmt

Anders als bei Festungen/Nestern (Frontend-Regel 60) gibt es keine still verschlechterte Zahl:
Ohne das neue Frontend sendet niemand `targetPlanet`, und der Altpfad ist byte-gleich (Zusage §2.2
des Konzepts, per Test-Abschnitt 1/2 gemessen statt behauptet). Backend darf beliebig lange allein
live sein.

**Das Übergangsfenster im NACHBAR-Repo ist seit dem 29.08.2026 geschlossen** (Frontend #518).
`test_bastionsmarken.js` prüfte 10c als Wortform-Zähler „`bastionMarkMultServer(save, k)` steht
GENAU ZWEIMAL im Rumpf" – nach der Zerlegung steht er genau einmal (in `standortDefGebaeude`, für
beide Wege), und der Test fiel damit auf völlig korrektem Code durch. Er ist GESTÄRKT statt
gelockert (Regel 43): eine markentragende Stelle, Delegationsprüfung beider Summierwege, und die
NEUE Eigenschaft, dass die Zielwahl-Route `standortVerteidigung` die Marke erbt – eine Anzeigestelle
ohne Marke kann so gar nicht mehr entstehen. Gemessen: 50 Prüfungen grün, am Eltern-Stand fallen
genau 10c/10c2/10c3, und gegen eine `server.js`-Kopie mit `forEach`- statt `for-of`-Schleife bleibt
die neue Fassung grün, während die alte Zeile daran fällt.

**Die übertragbare Lehre steht als Frontend-Arbeitsregel 80 und betrifft dieses Repo unmittelbar:**
Wer hier eine Funktion zusammenführt, die ein Frontend-Test liest, kann das nicht bemerken – der
eigene Prüflauf kennt die Datei nicht. Ein solcher Refactor gehört deshalb im PR-Text benannt,
damit der rote Test drüben als Etappe erkennbar ist und nicht als Spielfehler gesucht wird. Genau
so ist es hier gelaufen, und deshalb hat die Suche zwei Minuten statt eines halben Prüflaufs
gekostet.

### Der Test: `tests/test_pvp_standorte_http.js` (Port 3237, 33 Prüfungen, Gegenprobe mit Pflichtlisten)

Muster wie `test_gefechtsvorrat_http.js` (teil1/teil2, Anfängerschutz bei GESTOPPTEM Server über
ALLE private-Einträge genullt). Die Gegenprobe läuft über `PVP_STANDORT_TEST_SERVER` – **der
RUNNER wertet die Variable aus** (er startet wahlweise `server.alt.js`), nicht der Server; die
Pflichtlisten (18 fallen MUSS / 7 grün bleiben MUSS) stehen im Test-Kopf, Prüfnamen werden per
diff verglichen (Regel 60). Gemessen am Eltern-Stand: exakt die 18, exakt die 7, 8b außen vor.
**Belegte Testports sind jetzt 3195–3237 – ein neuer Test nimmt 3238.**

Drei Lehren aus dem Bau, jede über den Einzelfall hinaus:

1. **`db.users` speichert seine Schlüssel KLEINGESCHRIEBEN** (`.trim().toLowerCase()`, ~Z. 2057).
   Ein Testkonto mit Großbuchstaben im Namen (`pvopferA`) registriert sich erfolgreich – aber
   `db.users['pvopferA']` ist undefined, verify-email läuft nie, der Login liefert 403, und das
   Fehlerbild sieht aus wie ein kaputtes Register. Alle 33 Prüfungen fielen als Kaskade. Wer
   Konten in Tests anlegt: nur Kleinbuchstaben, oder lowercase nachschlagen (Regel 4).
2. **„Der jüngste Bericht" (`__reports[0]`, unshift) gilt nur, bis der NÄCHSTE Kampf einen
   jüngeren darüberlegt.** Der erste Entwurf las den Altpfad-Bericht erst nach dem home-Kampf und
   maß dessen Bericht – der die Standortfelder zu Recht trägt. Der Fehlschlag sah aus wie ein
   Codefehler („Altpfad trägt Standortfelder") und war ein Lesefehler des Tests. Berichts-Messungen
   gehören UNMITTELBAR hinter den Kampf, den sie messen.
3. **Eine 404-Prüfung an einer NEUEN Route ist am alten Stand aus dem falschen Grund grün** –
   die fehlende Route antwortet ebenfalls 404 (Express-HTML statt JSON). 10c/10d prüfen deshalb
   den GRUND im JSON-Fehlertext mit (Regel 28), sonst wäre die Gegenprobe dort blind.

### Beifang: die Sieg-Flanke in `test_gefechtsvorrat_http.js` 6b (behoben)

Der Betroffenheits-Sweep riss 6b mit `{"bestand":232}` statt 200: Der Fälschungs-Angriff des
Abschnitts 6 hatte zufällig GEWONNEN (der PvP-Boden lässt ~jeden zehnten Angriff auch gegen
185-fache Übermacht durch), und die Beute enthielt 32 der 200 Nanolegierungen des Opfers – die
starre Erwartung `menge*5` kannte nur den Niederlage-Fall. Die geprüfte Eigenschaft („der
gefälschte Vorrat bucht NICHTS ab") ist davon unabhängig; 6b rechnet jetzt die vom Server
GEMELDETE Beute heraus (`erwartung = 200 + (success ? stolen[res] : 0)` – eine Abbuchung wäre −40
und fällt weiterhin auf, die beiden Quellen können sich nicht maskieren). Der Sieg-Zweig der
Formel ist durch die Messung des roten Laufs belegt (232 = 200 + 32).



## Sicherheitsbehebung 02.09.2026: die Standort-Schranke prüfte den Wahrheitswert

Gefunden bei einer gegnerischen Abnahme des Frontend-PRs, nicht im eigenen Prüflauf – der hätte
sie auch nicht finden können, weil alle vorhandenen Prüfungen echte Standortschlüssel benutzten.

**Der Fehler.** Die Eingangsprüfung von `/api/attack` lautete:

```js
if (targetPlanet !== 'home' && !((target.colonies || {})[targetPlanet])) return 404;
```

Ein Objektliteral erbt die Namen aus `Object.prototype`. `{}['constructor']` ist die Funktion
`Object` und damit **wahr** – die Schranke ließ `constructor`, `toString`, `valueOf`, `__proto__`
und `hasOwnProperty` durch, und zwar auch bei einem Ziel **ohne jede Kolonie**.

**Die Wirkung, gemessen statt geschätzt.** Danach greifen die Null-Wachen der Verbraucher:
`standortDefGebaeude` und `standortDefFlotte` liefern für einen unbekannten Schlüssel `0`, und
`kontoDefenseFaktoren` ist rein multiplikativ. Ergebnis `defensePower: 0`, und `battleWinChance`
zahlt dafür die Obergrenze:

| Lage | Siegchance |
|---|---|
| Verteidigung 0 (der Exploit) | **90,0 %** |
| ein einzelner Jäger gegen Verteidigung 0 | **90,0 %** |
| fair, 50000 gegen 50000 | 50,0 % |

Dazu Beute (Standortart `kolonie`, Faktor 0,5), Kampfpunkte und Gebäudezerstörung beim Opfer. Über
die Oberfläche unerreichbar, per selbstgebautem Request trivial. Der Gegenprobe-Lauf zeigt sogar,
dass der Exploit `planetKey: "constructor"` in den Flottenverlust-Bericht des Opfers schrieb.

**Die Behebung.** Prüfung auf **eigene** Eigenschaft:

```js
if (targetPlanet !== 'home' && !Object.prototype.hasOwnProperty.call(target.colonies || {}, targetPlanet)) return 404;
```

`Object.prototype.hasOwnProperty.call(...)` und nicht `target.colonies.hasOwnProperty(...)`: Der
Spielstand kommt aus `JSON.parse` eines klientenautoritativen Saves und kann selbst einen Schlüssel
`hasOwnProperty` tragen – der Aufruf über das Objekt wäre dann keine Prüfung mehr, sondern ein
`TypeError` (gemessen: „boese.hasOwnProperty is not a function", also 500 statt Abweisung).

**Der Wächter.** `tests/test_pvp_standorte_http.js` 3d/3e. Geprüft wird der Status **und die
Wirkung** – `defensePower` und `success` wandern in die Zusatzangabe, damit ein Fehlschlag zeigt,
was der Angreifer bekommen hätte. Gegenprobe gegen eine Kopie mit der alten Zeile:

```
3d  {"key":"constructor","status":200,"defensePower":0,"sieg":true}
3e  {"status":200,"defensePower":0,"sieg":true}     ← Ziel ohne jede Kolonie
```

Die vier übrigen Schlüssel liefen dort in 403, **weil der erste Angriff bereits gewonnen hatte**
und den Schutzschild des Opfers setzte. Am behobenen Stand sind alle 34 Prüfungen grün und ohne
diese Kaskade – ein 404 löst keinen Kampf aus.

**Die übertragbare Lehre.** Eine Wahrheitswert-Prüfung auf einen Schlüssel **aus dem Request** ist
nie eine Zugehörigkeitsprüfung. Der Nachbar-Zweig `/api/vorposten` (`planetKey`) ist von derselben
Klasse nur deshalb nicht betroffen, weil er über `.fleet` weiterläuft und dort `undefined` landet –
also durch Glück, nicht durch Absicht. Wer hier eine neue Route mit einem Ortsschlüssel baut:
`Object.prototype.hasOwnProperty.call` oder eine Whitelist, nichts dazwischen.

## PvP-Mindesteinsatz (03.09.2026, Balance-Entscheidung Sascha) — Backend-Etappe

**Der Befund.** Kampfkraft und Risiko waren entkoppelt. `computeAttackPower` rechnet über
`allFleetsOf` — die ganze Reichsflotte —, während die Verluste im Client nur aus der geschickten
`m.composition` gezogen werden. Ein Angriff mit **einem Jäger** kämpfte also mit voller
Reichskraft und riskierte diesen einen Jäger.

Dazu kommt eine Eigenschaft, die beim Nachmessen auffiel und die Lage deutlich verschärft:
**`awayShipTotalsServer` kennt `attack-player` nicht** (nur `relocate`, `defend-base`,
`defend-base-return`, `attack-alliance-base`). Angriffsmissionen ziehen ihre Schiffe nirgends ab —
der volle Bestand bleibt am Standort stehen, während die Mission fliegt.

**Und der teuerste Teil, gemessen statt vermutet:** Das Wort `cargoCapacity` kommt in `server.js`
**null Mal** vor. Der Server zog dem Ziel bisher **immer** den vollen Satz ab (12–25 %) und schrieb
ihn dem Angreifer gut; der Frachtdeckel sitzt allein im Client, der den Spielstand des Angreifers
danach überschreibt. Ein Ein-Jäger-Angriff plünderte also ein Viertel des Ressourcenkontos — und
der größte Teil wurde **vernichtet**, weil ihn niemand tragen konnte. Für den Angreifer sah es nach
„keine Beute" aus, für das Opfer nicht.

**Die Regel.** Ein Angriff unter `PVP_MINDESTEINSATZ` wird **nicht abgelehnt, sondern ertraglos**:
keine Beute, keine Kampfpunkte, kein Anlagenschaden, kein Flottenverlust beim Ziel. Der Kampf
läuft normal, und die Siegchance bleibt die Reichsflotte — die Zusage aus Frontend-v8.634.0
(„deine Reichsflotte X gegen Y Verteidigung dort") bleibt damit **wörtlich wahr**.

Ablehnen wäre die schlechtere Bauform: Beim Eintreffen hat der Angreifer Treibstoff und Flugzeit
längst bezahlt, und seine Flotte kann seit dem Start gewachsen sein. Eine Schwelle, die dort Nein
sagt, bestraft ihn für etwas, das er nicht mehr ändern kann.

**Warum `missionId` und nicht die Flotte im Request.** Der Spielstand ist klientenautoritativ; eine
Flottenangabe im Body wäre eine PvP-relevante Größe aus der Hand des Angreifers. Der Server liest
die Zusammensetzung deshalb aus dem **gespeicherten** Spielstand — dasselbe Muster wie
`/api/asteroid/contest` (`astFindeAngriffsmission`). **Ehrlich bleibt:** Wer sich den Request baut,
kann eine große Mission in seinen Spielstand schreiben. Der Missbrauch wandert damit aus „drei
Klicks in der offiziellen Oberfläche" in die Klasse „Spielstand fälschen" — das ist eine
Spielregel, kein Sicherheitsschloss.

**Der Anteil** (`pvpEinsatzAnteil`) nimmt bewusst nur den flottenabhängigen Teil von
`computeAttackPower` (`rawFleetPower × fleetDiversityMult` je Flotte). Alles danach — Forschung,
Doktrin, Haltung, Bonusgruppe, Buffs, Aura — ist kontoweit und kürzt sich im Quotienten heraus.
`ssAtkMult`/`t2AtkMult` bleiben drin, weil sie klassenselektiv wirken. Nachgerechnet: 1000 Kreuzer
ergeben über `diminishingShipCount` 650 → 13000 Rohkraft; 1 Kreuzer → 20 (Anteil 0,00154), 900
Kreuzer → 12000 (Anteil 0,92308). Beide Werte hat der HTTP-Test exakt so gemessen.

**Der Schild hängt nicht mehr am Ertrag.** `grantAttackShield` stand an
`Object.keys(stolen).length > 0 || defenderLossPct > 0`. Im Siegzweig war die zweite Bedingung
**immer** wahr (`lootPct` 12–25 %, halbiert) — die Entkopplung ist am Altpfad also byte-neutral.
Mit dem Sockel wäre sie zur Falle geworden: Ein Sockel-Angriff nimmt nichts mit und richtet nichts
an, das Opfer hätte also seine **einzige** Angriffs-Abklingzeit verloren, und genau das
Dauer-Farmen wäre wieder offen, gegen das der Schild eingeführt wurde. Die Gegenprobe belegt das:
Mit der alten Bedingung fällt `E1`.

**Gnadenfrist.** Ein Request ohne `missionId` bekommt vollen Ertrag. Ein Browser-Tab, der beim
Umlegen des Schalters schon offen war, liefert die alte Datei aus und kennt das Feld nicht — er
soll nicht stillschweigend leer ausgehen. Dasselbe gilt für eine unbekannte `missionId`: ein
Tippfehler im Client darf keine stille Ertragssperre sein (`F1`).

**Die Schwelle ist noch geraten.** 25 % ist ein Startwert. Bevor `PVP_MINDESTEINSATZ_AKTIV` auf
`true` geht, muss über `db.private` gemessen werden, welchen Anteil der stärkste Standort eines
Kontos üblicherweise an der Reichsflotte hält — sonst trifft die Regel ehrliche Spieler mit über
viele Standorte verteilten Flotten. Rückwärtsgang ist der Notaus `mindesteinsatz`, ohne
Frontend-Release.

### Der Wächter: `tests/test_pvp_mindesteinsatz_http.js` (Port 3247, 22 Prüfungen)

Misst **beide Schalterstellungen** in einem Lauf: `server.js` (aus, der Paritätsanker) und eine
Kopie mit umgelegtem Schalter im Repo-Verzeichnis. Die Prüfungen sind ergebnisunabhängig gebaut —
`battleWinChance` deckelt bei 90 %, jeder zehnte Angriff geht auch bei Übermacht verloren, deshalb
lesen sie die **Differenz am Spielstand** statt des Ausgangs (voll = 25 oder 3, Sockel = 0 in
beiden Fällen). Die sieg-abhängigen Prüfungen bekommen bis zu drei frische Opfer, statt sich mit
„nicht gemessen" wegzuducken.

`C8` ist der eigentliche Beleg: Das Erz des Opfers steht vor und nach einem **gewonnenen**
Sockel-Angriff bei 1 000 000 — es wird nichts mehr abgezogen.

**Gegenproben** (Schalter jeweils an, dann eine Zeile sabotiert), Pflichtliste vorher festgelegt.
Jede fällt genau und nur in ihrer eigenen Prüfung:

| Sabotage | Fällt |
|---|---|
| Kampfpunkte-Sockel entfernt | `C1` |
| Flottenverlust-Sockel entfernt | `C5` |
| Anlagen-Sockel entfernt | `C6` |
| Beute-Sockel entfernt | `C7`, `C8` |
| alte Schild-Bedingung wiederhergestellt | `E1` |

**Beim ersten Anlauf blieb die Schild-Gegenprobe grün** — und das war kein Testfehler, sondern der
Befund: Solange die Beute nicht mit unter dem Sockel lag, war `stolen` nicht leer und die alte
Oder-Bedingung griff über ihren ersten Zweig. Genau daran ist aufgefallen, dass der Server dem
Opfer die Ressourcen unabhängig vom Frachtraum abzieht.
