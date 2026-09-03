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

## Der Besitzer erfährt vom Angriff – bei jedem Schlag (02.09.2026)

Bis hierher erfuhr der Besitzer eines Vorpostens **nichts**, bis er fiel: Der Kampfvermerk
(`letzterKampf`) steht nur im Dokument und wird erst sichtbar, wenn er das Kartenmenü öffnet; die
Warteschlange bekommt allein der Verlust (`vorposten-verlust`). Damit war die Verteidigungs-Zusage
des Konzepts (§2.6 – „kann mit Stationierung gegenhalten") nicht einlösbar: Wer nie erfährt, dass
geschossen wird, verstärkt keine Garnison.

`/api/vorposten/angriff` reiht deshalb bei **jedem** Schlag `pushNotificationEvent(besitzer,
'vorposten-angegriffen', …)` ein – gebaut nach dem Muster der Anfechtung (`asteroid-contested`) und
mit denselben drei Eigenschaften:

- **Einstellungen des Empfängers** (`getNotifPrefs`, Kategorie `attack`) entscheiden, ob überhaupt.
- **`allowAttackPush`** drosselt nur den Handy-Versand (30 Minuten); der Postfach-Eintrag kommt
  immer, damit die Historie vollständig bleibt.
- **fail-open in einem `try`**: Eine fehlgeschlagene Benachrichtigung darf einen Kampf nie
  scheitern lassen. Das ist hier richtig, weil es keine Sicherung ist (Hausregel: fail-closed für
  Sicherungen, fail-open für Benachrichtigungen).

Sie steht **vor** `saveDb()`, damit die eingereihte Meldung mit demselben Schreibvorgang auf die
Platte geht (Hausregel „db synchron vor saveDb mutieren").

**Der Kernstand steht im Text.** Ohne ihn wüsste der Besitzer nur DASS, nicht WIE DRINGEND – und
genau das entscheidet, ob er eine Garnison losschickt. Beim Fall nennt der Text stattdessen den
Verlust der Garnison und verweist aufs Belohnungsfach.

**Zwei Wege, die einander nicht ersetzen:** Die Benachrichtigung meldet sofort (auch aufs Handy, auch
bei geschlossenem Spiel), `vorposten-verlust` wirkt im Spielstand und schreibt den Bericht. Beim Fall
kommen beide.

Wächter: `tests/test_vorposten_http.js` 4h und 4h2 (Postfach-Eintrag samt Kernstand, gemessen an
`db.private[uid].__notificationEvents`), Gegenprobe `KEPLER_VP_SABOTAGE=meldung` – genau 4h und 4h2
fallen. Der bestehende `tests/test_pushkategorien.js` im Frontend-Repo fand die fehlende
Postfach-Zeile von selbst und nannte sie beim Namen (2b) – der Frontend-Eintrag in
`NOTIF_EVENT_INFO` ist damit erzwungen, nicht nur erinnert.

## Der Allianz-Verband gegen einen Vorposten (02.09.2026)

Derselbe Grund wie bei der Sternenfeste: Eine **Bastion** hat 400.000 Kern-LP und 60.000
Verteidigung – bei der gemessenen Einsteiger-Schlagkraft von 7.500 sind das **53 Schläge** bei vier
Stunden Abklingzeit. Solo ist sie nicht zu schleifen; genau dafür gibt es den Verband.
`zielArt: 'vorposten'` (mit `vorpostenSystem`, `vorpostenId`) läuft über **denselben Rechenkern**
wie der Einzelangriff (`vorpostenSchlagAusfuehren`) – wie bei Nest und Festung, aus demselben Grund.

### Der Name der Weiche hat sich geändert

`musterIstPveZiel` heißt jetzt **`musterZielOhneAllianz`**. Der alte Name wurde mit dieser Zielart
falsch: Ein Vorposten gehört einem **Spieler**, ist also PvP-Inhalt – er verhält sich in `resolve`
nur deshalb wie ein PvE-Ziel, weil sein Besitzer **keine Allianz** ist. Genau das ist die Frage, die
an allen vier Aufrufstellen zählt (`targetTag`, `incomingmuster`, `allianceRoleOf`), und der Name
sagt sie jetzt. `tests/test_muster_festung_http.js` liest ihn in seiner Sabotage-Zeile und wurde
mitgezogen.

### Drei Dinge, die es bei Nest und Festung nicht gibt

1. **Den eigenen greift man auch im Verband nicht an** – dieselbe Regel wie am Einzelendpunkt,
   geprüft beim Ausrufen.
2. **Der Bauschutz gilt auch für den Verband, und zwar zweimal**: beim Ausrufen und noch einmal
   **bei der Ankunft**. Ohne die zweite Prüfung wäre der Verband der Weg, den Bauschutz zu umgehen –
   ein Vorposten, der während der Sammelphase neu gebaut wurde (der alte fiel, jemand baute nach),
   stünde sonst ungeschützt da. Der Verband kommt dann an und richtet nichts an (`verpasst`,
   Grund `'schutz'`).
3. **Der Besitzer wird benachrichtigt**, mit dem Allianz-Tag als Angreifer statt eines einzelnen
   Namens. Ohne diese Zeile wäre die Lücke vom selben Tag über den Verbandsweg wieder offen –
   ausgerechnet für den Angriff, der ihn am ehesten kostet.

Wächter: `tests/test_muster_vorposten_http.js` (**Port 3247**, 29 Prüfungen). Vier Gegenproben, je
mit Pflichtliste und identischer Prüfliste: `schutz` → 6a, `gewicht` → 4c und 4d, `meldung` → 4h,
`eigen` → 1b.

**Eine Lehre aus der Gegenprobe `eigen`:** Sie riss zunächst 18 Prüfungen statt einer. Nicht der
Code war schuld, sondern der Testablauf – ohne die Sperre entsteht in 1b ein **echter** Angriff, der
als laufender jeden weiteren `create` mit 409 blockiert. Der Test räumt seither nach 1b immer auf,
egal ob die Sperre griff. Eine Sabotage, die den Ablauf kaputtmacht statt die Eigenschaft, belegt
nichts.

**Belegte Testports sind jetzt 3195–3200 und 3210–3247** – ein neuer Test nimmt 3248.

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

## Etappe 3: Stationsmodule (02.09.2026)

Auftrag Sascha: „Man soll Module finden können, die selten sind – die sind natürlich am besten,
random natürlich. Und man soll auch Module bauen können, die sind aber weniger gut. Die kann man
ausbauen, kostet aber eine Kleinigkeit."

**Warum der Server das führt.** Ein Stationsmodul erhöht die **Verteidigung eines PvP-Ziels**. Läge
der Bestand im klientenautoritativen Spielstand, könnte sich jeder beliebig viele legendäre Module
ausstellen. Deshalb: Bestand am Nutzerobjekt (`user.vpModule`), eingebaute Module im Dokument
(`doc.module`), und Fund, Bau, Einbau, Ausbau ausschließlich über Endpunkte.

| | woher | Seltenheit | Kosten |
|---|---|---|---|
| **Fund** | Fall von Festung und Nest, gewichtet nach Schwere und eigenem Anteil | bis legendär | – |
| **Bau** | `POST /api/vorposten/modul/bauen` | nur bis ungewöhnlich | Abklingzeit 6 h je Konto |
| **Ausbau** | `POST /api/vorposten/modul/ausbauen` | – | 250 Kredite, Modul kommt heil zurück |

Sechs Module (Kernpanzerung, Geschützbank, Hangarerweiterung, Sprungrechner, Umlaufraffinerie,
Horchposten) wirken ausschließlich auf Kanäle, die es **schon gibt** — Kern, Verteidigung, Garnison,
Flug, Produktion, Aufklärung. Steckplätze: einer je Stufe ab der Wahlstufe, höchstens fünf. Die
Steckplätze **sind** der Deckel; ein zusätzlicher Deckel je Kanal wäre doppelt.

**`vorpostenWerte(doc)` ist die eine Stelle**, die Stufe und Module zusammensetzt. Alles, was Werte
liest (Verteidigung, Garnisonsgrenze, Kern beim Ausbau, Client-Sicht), geht hindurch — sonst wäre
ein Modul an einer Anzeige wirksam und an der anderen nicht. Zwei Entscheidungen daneben: Der
**Kern-Ausbau** rechnet **mit** Modulen (sonst schrumpfte das Maximum, sobald eine Kernpanzerung
steckt), die **Beute beim Fall** rechnet **ohne** (sonst machte sich zur besseren Beute, wer
ausbaut).

Wächter: `tests/test_vorposten_http.js` Abschnitt 9 (12 Prüfungen) plus zwei Sabotagen mit
**gemessener** Pflichtliste: `modulbestand` → 9e 9e2 9h, `modulwirkung` → 9f. Die erste Vorhersage
für `modulbestand` nannte 9d — falsch: Der Einbau gelingt ohne Abbuchung weiter, rot werden nur die
Prüfungen, die den Bestand selbst lesen.

## Das Kern-Dach ist abgeleitet, nicht gespeichert (03.09.2026)

`doc.kern.lpMax` stand im Dokument und wurde **nur bei Bau und Ausbau** geschrieben. Eine
eingebaute **Kernpanzerung** hob damit zwar `vorpostenWerte().kernLp`, aber niemand las das für den
Kern: Das Modul war bis zum nächsten Ausbau **wirkungslos** — und nach einem Ausbau hätte sein
Ausbau das Dach nicht wieder gesenkt. Beschrieben war es als „mehr Lebenspunkte, bevor sie fällt";
geliefert wurde nichts. Gefunden beim Entwurf von Etappe 4, ausgeliefert war der Fehler seit
Etappe 3.

`vorpostenKernMax(doc)` rechnet jetzt (Stufe × Zweig × Module) und ist die **eine Quelle**;
`vorpostenKernLp(doc)` kappt die gespeicherten Lebenspunkte darunter. Gelesen wird `lpMax` nirgends
mehr — `vorpostenSchreib()` zieht es nur noch mit, damit Sicherungen und die Admin-Lage aus älteren
Ständen nichts Sinnloses zeigen. Bestehende Vorposten heilen sich damit ohne Migration.

**Zwei Regeln halten das Ein- und Ausbauen ehrlich:**
- Ein Einbau **heilt nicht** — das Dach steigt, die Lebenspunkte bleiben stehen (dieselbe Regel wie
  beim Ausbau der Stufe, nur ohne dessen bewussten Zuschlag).
- Ein Ausbau **kappt** nur, was über dem neuen Dach liegt. Ein- und Ausbauen ist damit keine
  Reparatur; ohne diese Symmetrie wäre eine Kernpanzerung für 250 Kredite eine Heilung gewesen.

Wächter: `tests/test_vorposten_http.js` Abschnitt 10 (10a–10d) mit **zwei** Sabotagen und
gemessener Pflichtliste — `kerndach` (Dach folgt der Panzerung gar nicht) → genau `10a`;
`kerndachab` (Dach steigt, sinkt aber nie wieder — die lohnende Ratsche) → genau `10c`. Prüfnamen
beider Läufe per `diff` gegen den grünen Lauf verglichen: identisch, 64 Prüfungen.

**Ein Nebenbefund in der Test-Vorrichtung:** Abschnitt 4 gab einem **Stufe-1**-Vorposten von Hand
`kern.lpMax = 900.000`, damit er den Probeschlag übersteht. Mit der abgeleiteten Rechnung ist das
eine stille Falschangabe — sein echtes Dach sind 20.000, er fiele beim ersten Schlag. Die
Vorrichtung hebt jetzt die **Stufe** (3, Bastion, 400.000) und fragt den Ausgangswert **beim
Server** ab, statt ihn aus der eigenen Annahme zu lesen.

## Etappe 4: Stationsprojekte und das Sprungtor (03.09.2026)

Auftrag Sascha: „dass man von dort aus Projekte starten kann, dass man von dort aus vielleicht auch
eine Art Überraumtor bauen kann. Also auch noch mehr Projekte quasi macht."

**Ein Projekt ist das Gegenstück zum Modul:** einmalig je Vorposten, dauerhaft, nicht umsteckbar,
und an **Stufe und Ausrichtung** gebunden. Damit bekommen die drei Zweige endlich etwas, das nur
sie können — bis hierher unterschieden sie sich nur in Multiplikatoren.

| Projekt | Zweig | ab Stufe | Dauer | Wirkung |
|---|---|---|---|---|
| **Dockring** | Werft | 5 | 8 h | Garnison +25 % |
| **Handelskammer** | Handel | 5 | 8 h | Produktionsbonus +35 % |
| **Bollwerk** | Festung | 5 | 8 h | Kern +20 %, Verteidigung +20 % |
| **Tiefenhorchposten** | alle | 6 | 12 h | +1 Aufklärungsstufe |
| **Sprungtor** | alle | 7 | 24 h | Flug +20 % **und Flugzeit-Deckel 50 % → 75 %** |

**Warum das Sprungtor den Deckel hebt statt aufzuaddieren.** Der Flugzeit-Bonus ist im Frontend bei
`VP_FLUG_DECKEL` (0,5) gedeckelt, und ein Vorposten der Stufe 8 liegt mit Modulen schon daran. Ein
Tor, das nur weitere Prozentpunkte gäbe, täte also **nichts** — genau die Sorte angezeigten Nutzens,
die es in diesem Projekt nicht geben soll. Der Deckel reist mit `nutzen.flugDeckel` zum Client; die
Kopie im Frontend (`vorpostenFlugMult`) liest ihn statt der harten 0,5.

**Kein Ticken und kein Einsammeln.** Ein Projekt ist fertig, sobald `fertigAb` erreicht ist. Es gibt
also keinen Zustandsübergang, der verlorengehen könnte, und kein Schreiben beim Lesen.
`doc.projekte` ist die Liste aller je begonnenen Vorhaben; das laufende ist genau das mit
`fertigAb > jetzt`, und mehr als eines gleichzeitig gibt es nicht. **Abbrechen gibt es nicht** — ein
Vorhaben, das man zurücknehmen kann, wäre ein Zwischenlager für Rohstoffe.

**Sichtbarkeit.** Fertige Projekte sieht **jeder** (wie die Steckplätze): Ein Bollwerk erklärt dem
Angreifer, warum dieser Kern härter ist als die Stufe verspricht. Das **laufende** Vorhaben sieht
nur der Besitzer — es sagt nichts über die heutige Stärke, verrät aber, wann diese Station stärker
wird, und das wäre eine Einladung, vorher zuzuschlagen.

**Der Schalter** `VP_PROJEKTE_AKTIV` steht ausgeliefert auf `false` und wird im **Frontend-PR**
umgelegt; der Admin-Notaus `vorposten` schaltet ihn zusätzlich ab.

Wächter: `tests/test_vorposten_http.js` Abschnitt 11 (11a–11i), gefahren an einer Kopie mit
umgelegtem Schalter (`0-kopie2`) — sonst wäre die ganze Etappe bis zum Frontend-Merge ungeprüft.
Zwei Sabotagen mit gemessener Pflichtliste: `projektwirkung` (ein fertiges Vorhaben ändert nichts)
→ genau `11f`, `11h`; `projektzeit` (ein laufendes wirkt schon) → genau `11d`.

### Die Auswertung der Gegenproben misst jetzt beide Richtungen

Bis zum 03.09.2026 prüfte der Auswerteblock nur, ob die Pflichtliste **gefallen ist** — und meldete
danach „genau […] gefallen", wobei er die **Erwartung** ausdruckte, nicht die Messung. Eine
Sabotage, die zehn weitere Prüfungen mitreißt, kam damit als „korrekt" durch, und die Pflichtliste
blieb eine unbelegte Behauptung. Aufgefallen an `projektwirkung`: Die Liste war noch leer, `11f` und
`11h` fielen — gemeldet wurde „genau [] gefallen", Exit 0.

Der Lauf zählt jetzt nach, **was** gefallen ist, vergleicht in beide Richtungen (fehlt etwas aus der
Liste? ist etwas außerhalb gefallen?) und druckt die **Messung**. Das ist dieselbe Regel, die
CLAUDE.md für Prüfnamen fordert („per `diff` vergleichen, nicht zählen"), nur im Werkzeug selbst.
