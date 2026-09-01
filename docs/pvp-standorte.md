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


