# Vorposten (B2, spielergebaute PvP-Ziele)

Konzept und Entscheidungsgrundlage: `docs/vorposten-konzept.md` im FRONTEND-Repo. Hier stehen die
Entscheidungen, die man kennen muss, bevor man etwas daran ändert, und die Messungen dahinter.

## Die Entscheidungen, die den Bau bestimmt haben (02.09.2026)

Auftrag Sascha „beide umsetzten" (A2 UND B2); per Auswahl: **„Echtes PvP-Ziel (db.shared)"** (Option B
des Konzepts) und **„alle 4 optionen"** beim Nutzen-Kanal (Flugzeit, Scan, Produktion, Stationierung).
Die PvP-Weiche des Flugzeit-Kanals (Konzept §4.2) war nicht Teil der Fragen; gebaut wird die
Konzept-Empfehlung (i): Der Flugzeit-Bonus wirkt im Frontend nur auf Nicht-PvP-Missionen, damit sich
das Reaktionsfenster eines Verteidigers nicht verschiebt und keine Backend-Parität für Flugzeiten
entsteht. Wer das ändern will, ändert eine Sascha-Entscheidung.

## Wo er wohnt, und warum der Server so viel selbst führt

**Ein Vorposten je System, `db.shared['vorposten:<sysId>']`.** Die generische Storage-Route schreibt
ihn nie (`checkVorpostenKeyPermission`, in BEIDEN Rechte-Ketten der Storage-Route eingetragen – dieselbe
Sperre wie `asteroids:*`); Lesen bleibt offen, und `GET /api/vorposten` liefert die Liste aller
Vorposten mit allem, was das Frontend zum Zeichnen braucht. Das ist die Grenze, die dieses Projekt
verteidigt: Ohne die Sperre setzte jeder Beliebige einen fremden Kern mit einer Anfrage auf null.

**Der Server ist Autorität über Stufe, Kern-LP, Garnison und Verteidigung.** Die Stufe ist ein
gezähltes Ereignis (`/api/vorposten/ausbauen`, Abklingzeit am Objekt), kein vom Client gemeldeter Wert
– die Verteidigungsstärke darf nie aus dem Client-Wert kommen (Konzept-Falle 1 an der Allianzbasis).
Baukosten prüft der Server NICHT: Der Spielstand ist klientenautoritativ, wer sich Erz hinschreibt,
konnte das schon immer. Was zählt, ist, dass niemand Fremdes anfassen kann.

**Die vier Nutzen-Kanäle sind Zahlen je Stufe in `VORPOSTEN_STUFEN`** (`flug`, `prod`, `scan`, und die
Garnison als Stationierungs-Kanal) und reisen mit `GET /api/vorposten` zum Client. **Bewusst keine
Kopie der Tabelle im Frontend** – die Hilfe und die Vorschau lesen die Zahlen aus der Antwort. Damit
entsteht keine Kopie-Familie, die einen Paritätstest bräuchte; der einzige Kampfwert, den beide Seiten
rechnen, ist die Angriffskraft, und die hält bereits `test_schiffsmodul_paritaet` u. a.

**Der Server schreibt den Spielstand hier NIE.** Verluste des Angreifers reisen als Quote (wie bei
A2/Festung), und beim Stationieren nimmt der Server nur an, was der gespeicherte Spielstand am
Standort wirklich hat – der Client bucht genau `angenommen` ab, NACHDEM die Antwort da ist. Andersherum
(Server zieht ab) liefe die Abbuchung gegen den Autosave des Clients, und die Schiffe stünden doppelt.

**Nur Kampfschiffe kommen in die Garnison** (`SHIP_ATK_VALUES > 0`). Sonst wäre die Garnison ein
sicherer Hafen für Frachter, den kein `/api/attack` erreicht. Die Garnison verliert serverseitig (sie
wohnt im Dokument) und ist mit dem Vorposten verloren, wenn er fällt.

## Kalibrierung – gerechnet gegen die Festungs-Schlagkräfte, nicht geschätzt

| Stufe | Kern-LP | Struktur-Verteidigung | Garnison max. | Schläge (Einsteiger / Mittelfeld / Endspiel) |
|---|---|---|---|---|
| Feldlager | 20.000 | 2.500 | 300 | 2,7 / 0,45 / 0,08 |
| Stützpunkt | 90.000 | 12.000 | 800 | 12 / 2,0 / 0,4 |
| Bastion | 400.000 | 60.000 | 2.000 | 53 / 9,1 / 1,7 |

Gegen die gemessenen 7.500 / 44.000 / 240.000 je Schlag (`docs/asteroidenfestungen.md`). Ein Feldlager
ohne Garnison ist für sein Publikum ein Ziel von zwei bis drei Schlägen – eine gehaltene Präsenz, die
man verteidigen MUSS. Die Verteidigung wirkt als **Durchschlag** auf den Wurf (`kraft / (kraft +
verteidigung)`, 15–95 %): Eine Garnison lässt weniger ankommen UND kostet den Angreifer mehr
(Grundverlust 6 % + bis zu 20 % aus dem Kräfteverhältnis + Streuung, gedeckelt bei 45 %).

Weitere Konstanten: `VORPOSTEN_MAX_JE_KONTO = 3` (E3-Rahmen `SPRUNGBAKEN_MAX`, der Vorposten IST der
Sprungknoten), Bauschutz 12 h (sonst wäre ein Vorposten in der Minute nach der Baukolonne schleifbar,
bevor eine Garnison da ist), Abklingzeit 4 h je Angreifer am Objekt, Ausbau-Abklingzeit 12 h.
**Ein Ausbau heilt nicht** – die LP wachsen um die Differenz der Maxima (Nest-Regel).

## Beute und Berichte

Gezählt wird der **angekommene** Schaden (`kernVorher - kernNachher`), nicht der Wurf – die
Festungs-Entscheidung. Beim Fall geht die Beute anteilig an ALLE Beitragenden über `pushPendingReward`
mit eigenem `type:'vorposten'` (Kampfpunkte/XP/Credits je Stufe, klein und flach – nie aus der
Produktion des Besitzers abgeleitet, Konzept §6). Der Besitzer bekommt `type:'vorposten-verlust'` mit
der verlorenen Restgarnison. **Jeder Schlag davor steht als Kampfvermerk im Dokument**
(`letzterKampf`, `kampfverlauf` bis 10), nicht in seiner Warteschlange: Die hält 20 Einträge und
verdrängte sonst Wertvolleres (die Boss-Set-Lehre aus `docs/beute.md`). Der Frontend-Zweig für beide
Typen gehört zwingend zum Frontend-Auftrag (sonst der „Bug-Report"-Rückfall).

**Aufgeben: keine Rückerstattung** (Konzept §9, Empfehlung a) – der Bau ist eine verbindliche Ortswahl,
ein Abbau-Wiederaufbau-Kreislauf entsteht so nicht. Die Garnison kommt zurück.

## Was der Server NICHT prüfen kann

„Nicht im eigenen System" prüft er nur gegen das **Heimatsystem** aus dem Bestenlisten-Eintrag
(`leaderboard:<uid>.homeSystem`): `PLANETS` kennt er nicht, Kolonie-Systeme kann er einem Spielstand
nicht zuordnen. Das prüft der Client. Ein Vorposten im eigenen Kolonie-System wäre nutzlos, aber kein
Zugriff auf Fremdes – die verteidigte Grenze bleibt.

## Schalter und Auslieferungsreihenfolge

**`VORPOSTEN_AKTIV` steht auf `false`** – Auslieferungs-Riegel (Regel 60) und Notausschalter: Ein
Vorposten ist ein PvP-Ziel mit spielersichtbaren Zahlen, also muss das Backend VOR dem Frontend live
sein und der Schalter erst im Fenster des Frontend-PRs kippen (genau wie `A2_SPAWN_AKTIV`, umgelegt
unmittelbar nach dem Frontend-Merge). Solange er aus ist, antworten alle Endpunkte mit 404/`inaktiv`
und `GET /api/vorposten` meldet `aktiv:false`. `test_vorposten_http.js` 8b hält den Stand fest; beim
Umlegen wird die Prüfung mit umgestellt.

Der **Admin-Notaus `vorposten`** (fünfter Schalter, `db.notAus`) stoppt nur den BAU neuer Vorposten
(`/api/vorposten/bauen` läuft über `spawnAktiv('vorposten')`); bestehende bleiben angreifbar – dieselbe
Semantik wie bei den Nestern. Im ausgelieferten Stand meldet er `imCode:false`.

## Der Wächter

`tests/test_vorposten_http.js` (**Port 3242**, Kopie von `server.js` mit umgelegtem Schalter im
Repo-Verzeichnis, drei Konten, vier Gegenproben mit „was fallen MUSS"-Liste: `schaden`→4c,
`abkling`→4d, `rechte`→1a, `typ`→5b). Zwei Messentscheidungen daraus: 4c misst den angekommenen
Schaden dort, wo der Deckel greift (500 Rest-LP – mit dem vollen Wurf stünde eine fünfstellige Zahl),
und die Erwartungen der Stufentabelle kommen aus dem QUELLTEXT, nicht aus der API-Antwort (Regel 62).
`test_admin_funktionen_http.js` 3a zählt seither fünf Schalter, 3d prüft die Bau-Aufrufstelle mit.

## Acht Stufen und drei Spezialisierungen (02.09.2026)

Auftrag Sascha: „Ich will, dass der Vorposten ein Highlight des Spiels wird … am liebsten sehr,
sehr viele Ausbaustufen für verschiedene Spezialisierungen." Entscheidung nach Vorlage von drei
Zuschnitten: **8 Stufen, ab Stufe 4 eine einmalige Ausrichtung**, Etappe 1 zuerst die Tiefe.

**Eine Leiter, drei Multiplikatoren.** `VORPOSTEN_STUFEN` hat acht Einträge (die gemeinsame
Zahlenreihe), `VORPOSTEN_ZWEIGE` sind Multiplikatoren darauf – keine drei parallelen Tabellen.
Die Balance ist damit an einer Stelle messbar; drei Tabellen wären in drei Richtungen abgedriftet.

| Stufe | Kern | Verteidigung | Garnison | Endspiel-Schläge (240k) |
|---|---|---|---|---|
| 1 Feldlager | 20.000 | 2.500 | 300 | 0,08 |
| 3 Bastion | 400.000 | 60.000 | 2.000 | 1,7 |
| 6 | 2.400.000 | 320.000 | 7.000 | 10 |
| 8 | 6.500.000 | 850.000 | 14.000 | 27 |

Stufe 8 ist bei 4 h Abklingzeit allein 4,5 Tage Arbeit, im Verband ein Abend – ein echtes
Belagerungsziel, kein Selbstläufer.

**Die drei Zweige** (Werft, Handelsknoten, Festungsring) differenzieren ausschließlich über Kanäle,
die im Frontend **heute schon wirken**: Flugzeit, Produktion, Aufklärung, Struktur, Garnison. Ein
angezeigter Nutzen, der nichts tut, wäre eine Lüge; neue Kanäle (Werftrabatt, Marktgebühr,
Modul-Steckplätze, Projekte, Sprungtor) kommen in späteren Etappen **zusammen mit ihrer Wirkung**.

**Die Wahl fällt beim Sprung auf Stufe 4 und ist unveränderlich** (`doc.zweig`). Ein später
mitgeschickter Zweig wird ignoriert, nicht abgelehnt – der Client darf ihn immer mitsenden.

**Die Ausbaukosten sind aus dem Frontend in die Stufentabelle gewandert** und reisen mit
`GET /api/vorposten`. Grund: Die Stufentabelle hatte nie eine Kopie im Frontend, die Kostentabelle
schon (zwei Einträge) – mit acht Stufen wäre daraus eine Kopie-Familie geworden.

**Ein Deckel, der die Leiter eingeholt hätte:** `VORPOSTEN_PROD_DECKEL` im Frontend stand auf 0,10.
Ein Handelsknoten der Stufe 8 trägt allein 0,234 – jeder Ausbau ab Stufe 3 wäre wirkungslos
gewesen. Der Deckel steht jetzt auf 0,25 (Frontend, im selben Auftrag).

Wächter: `tests/test_vorposten_http.js` – 1c/1c2/1c3 prüfen die Leiter als **Regel** (Pflichtfelder,
streng steigend, Zweige vollständig) statt der alten Momentaufnahme „drei Stufen"; 7e–7h die
Zweigwahl. Zwei neue Sabotagen mit gemessener Pflichtliste: `zweigwahl` → 7e 7f 7g 7h,
`zweigwerte` → nur 7g (die Wahl greift, die Multiplikatoren wirken nicht – der stille Fall).
