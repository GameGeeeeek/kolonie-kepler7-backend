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

Die Spalte „Kosten" ist wörtlich zu lesen: **Der Bau kostet keine Rohstoffe**, weder serverseitig
noch im Client — der einzige Preis ist die Abklingzeit. Der Kommentar über dem Endpunkt behauptete
bis zum 03.09.2026 das Gegenteil („die Kosten zahlt der Client aus seinem Spielstand"); an beiden
Seiten nachgelesen und korrigiert. Kredite kostet nur das **Ausbauen**.

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

## Die Vorwarnung beim Anflug (03.09.2026)

Das Konzept sagt dem Besitzer zu, er könne mit einer Garnison gegenhalten. Einlösbar war das nicht:
Er erfuhr von einem Verband erst beim **ersten Schlag** – also nach der Ankunft. Da ist Verstärken
zu spät. Seit dem 02.09.2026 gibt es die Meldung beim Schlag; jetzt kommt die Vorwarnung während
des Anflugs dazu.

**Wo sie wohnt.** Ein Vorposten gehört einem *Spieler*, nicht einer Allianz – der Weg über
`alliance:<tag>:incomingmuster` steht also nicht offen. Der Vermerk hängt deshalb am
Vorposten-Dokument selbst (`doc.anflug`) und wird in `vorpostenFuerClient` ausgespielt, das ohnehin
je Nutzer entscheidet, was es zeigt.

**Eine Liste, kein einzelnes Feld.** Zwei Allianzen können denselben Vorposten anfliegen. Wer
zuerst ankommt, würde beim Aufräumen sonst die Warnung des anderen mitlöschen, und der Besitzer
sähe den zweiten Verband nicht mehr kommen. Jeder Eintrag trägt seine `musterId` und wird nur von
*seiner* Auflösung entfernt.

**Nur der Besitzer sieht sie.** Verteidigung, Garnisonszahl und Steckplätze stehen bewusst jedem
offen – ein Angreifer soll sehen, worauf er sich einlässt. Ein Anflug ist etwas anderes: Er verrät
den Plan eines Dritten. Wer ihn allen zeigte, machte aus der Vorwarnung ein Werkzeug für
Nachzügler, die die geschwächte Station abräumen. Das wäre eine eigene Spielentscheidung, keine
Nebenwirkung – deshalb hier eng gefasst und leicht zu öffnen, falls gewünscht.

**Einzelangriffe stehen nicht drin.** Der Server erfährt von ihnen erst bei der Ankunft (der Client
fliegt und ruft dann den Endpunkt). Es gibt nichts vorzuwarnen. Nur der Verband hat einen Versand,
den der Server kennt – eine Eigenschaft der Mechanik, keine Auslassung.

**Verfall.** Ein Verband, dessen `resolve` nie kommt, würde sonst ewig warnen. Einträge, deren
Ankunft länger als `VORPOSTEN_ANFLUG_GNADE` (2 h) zurückliegt, gelten beim *Lesen* als erledigt –
so muss ein Serverneustart nichts reparieren.

**Ein Fallstrick, gemessen.** Das Aufräumen darf das Dokument **nicht neu einlesen**. Die Auflösung
hält ihr Vorposten-Objekt bereits in der Hand und schreibt es nach dem Kampf zurück
(`vorpostenSchlagAusfuehren` ruft `vorpostenSchreib`). Ein Helfer, der selbst liest und schreibt,
wird von genau diesem Rückschreiben überholt – der Vermerk stünde wieder da, und der Besitzer sähe
eine Dauerwarnung vor einem Verband, der längst angekommen ist. `vorpostenAnflugEntfernen` ändert
deshalb das **übergebene** Objekt; der Aufrufer schreibt, wenn er sonst nicht schreibt.

Test: `tests/test_vorposten_anflug_http.js` (Port 3252), Gegenproben `offen`, `bleibt`, `verfall`.
Bei `bleibt` fällt **nur** `3a`, nicht auch `4a` – gemessen: `4a` prüft, dass der fremde Vermerk
bleibt, und das tut er auch, wenn gar nichts geräumt wird. Erst das Paar pinnt das Verhalten fest.

### Und eine Meldung, nicht nur ein Vermerk (03.09.2026)

Der Vermerk allein wäre eine halbe Zusage: Er steht im Kartenmenü, und wer nicht zufällig hinsieht,
erfährt nichts – genau der Fehler, den die Etappe vom 02.09.2026 an der *Schlag*-Meldung behoben
hat. Beim Versand geht deshalb `vorposten-anflug` ins Postfach des Besitzers, mit Angreifer-Tag,
Schiffszahl und der verbleibenden Zeit. Ohne die beiden Zahlen wäre es ein „irgendwer kommt
irgendwann" und damit keine Grundlage für die Entscheidung, ob sich eine Garnison noch lohnt.

Der Tiefenlink zeigt auf die **Karte** – dorthin, wo man die Garnison losschickt, nicht in die
Berichte. Der Frontend-Zweig (`NOTIF_EVENT_INFO`) gehört zwingend in denselben Auftrag; der Wächter
`test_pushkategorien` fordert ihn ein.

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

**Der Projekt-Schalter ist umgelegt (03.09.2026).** `VP_PROJEKTE_AKTIV` stand seit dem Backend-PR
auf `false`; das Frontend blendete den Menüeintrag über `projekteAktiv` aus. Mit dem Frontend-Merge
v8.649.0 (live per `version.txt` belegt) steht er auf `true`. Der Admin-Notaus `vorposten` schaltet
Projekte weiterhin ab — er kann zur Laufzeit nur AB-, nie einschalten.

## Aufgeben ist ein Abbau über 24 Stunden (03.09.2026)

Auftrag Sascha: „vorposten sollen auch aufgebar sein allerdings müssen die abgebaut werden dauert
24 stunden."

**Warum das mehr ist als eine Wartezeit.** Bis hierher verschwand ein Vorposten in dem Moment, in
dem sein Besitzer es wollte — auch mitten in einem Angriff. Wer sah, dass seine Station fallen
würde, gab sie auf, und der Angreifer stand vor einem leeren System: keine Beute, kein Kampfpunkt,
die Flüge umsonst. Mit der Frist bleibt der Vorposten angreifbar, solange er abgebaut wird. Der
Abbau ist damit ein **Entschluss, keine Fluchttür** — und genau das misst Prüfung 6d.

| | |
|---|---|
| `POST /api/vorposten/aufgeben` | setzt `doc.abbauAb = jetzt + VORPOSTEN_ABBAU_MS` (24 h). Ein zweiter Aufruf startet nichts Neues, sondern nennt die Restzeit. |
| `POST /api/vorposten/abbau/abbrechen` | löscht die Frist. Es gibt nichts zu erstatten — der Abbau kostet keine Rohstoffe, er kostet Zeit. Wer abbricht, hat die Frist umsonst laufen lassen; das ist die ganze Strafe und sie reicht. |
| `vorpostenAbbauTick()` | schließt fertige Abbauten im `galaxyTick` ab (alle 15 Minuten — ein 24-Stunden-Vorhaben braucht keine feinere Auflösung, und ein eigener Takt wäre ein zweiter Zeitgeber für dieselbe Sache). |

**Der Zustand ist EIN Feld** (`doc.abbauAb`), kein eigener Speicher: Alles, was den Vorposten liest,
sieht ihn damit automatisch mit. `vorpostenFuerClient` meldet ihn an **jeden**, nicht nur an den
Besitzer — dieselbe Offenheit wie bei Verteidigung und Garnisonszahl. Eine Station, die in Kürze
verschwindet, ist für einen Angreifer eine echte Information: Es lohnt sich, vorher zuzuschlagen.

**Was beim Abschluss zurückkommt:**
- Die **Module** gehen in den Bestand des Besitzers. Ein legendäres Fundstück beim freiwilligen
  Abbau zu verlieren, wäre eine Strafe fürs Aufräumen. Fällt der Vorposten dagegen im Kampf, bleiben
  sie verloren — dort hat sie jemand zerstört.
- Die **Garnison** kommt über `pushPendingReward` mit eigenem `type: 'vorposten-abbau'`, nicht über
  eine Rückflug-Mission: Der Server schreibt keinen fremden Spielstand, und beim Ablauf der Frist
  ist der Besitzer üblicherweise gar nicht da.
- Ein laufendes **Stationsprojekt** ist mit der Station weg. Es hätte nichts, worin es fertig werden
  könnte.

**Nicht geändert:** Der Vorposten zählt während des Abbaus weiter gegen `VORPOSTEN_MAX_JE_KONTO` —
sonst wäre ein gestarteter Abbau der Weg, die Drei-pro-Konto-Grenze zu umgehen, ohne je etwas
aufzugeben.

`VORPOSTEN_ABBAU_AKTIV` stand bis zum Frontend-Merge auf `false`; solange blieb das ausgelieferte
Verhalten (sofort weg, Garnison zurück). Wäre der Schalter schon an gewesen, klickte ein Spieler
„aufgeben" und sähe seinen Vorposten weiter stehen. **Umgelegt am 03.09.2026**, nachdem Frontend
v8.654.0 live gemessen war (`version.txt`) — dessen Kartenmenü liest `abbauMs`/`abbauAktiv` aus
`GET /api/vorposten` und beschriftet den Eintrag danach.

Wächter: `tests/test_vorposten_http.js` Abschnitt 6 (6a–6g), gefahren an einer Kopie mit umgelegtem
Schalter **und verkürztem `galaxyTick`** (`0-kopie3`) — so misst 6f den echten Weg über den Tick
statt einer Abkürzung, die es im Betrieb nicht gibt. Zwei Sabotagen mit gemessener Pflichtliste:
`abbaufrist` (der Vorposten verschwindet wieder sofort) → `6b 6c 6d 6e 6f`; `abbaumodule` (die
Module bleiben beim Aufräumen weg) → `6g`.

Dazu Prüfung **8e**: Der Schalter im **ausgelieferten** Stand steht auf `true`. Abschnitt 6 fährt
eine Kopie und legt ihn selbst um — ohne 8e prüfte dieser Test also nie, was auf dem Pi läuft, und
ein stiller Rückfall auf `false` sähe wie Normalbetrieb aus: `/api/vorposten` meldet
`abbauAktiv:false`, das Frontend beschriftet den Eintrag brav wieder mit „aufgeben", und niemandem
fällt etwas auf. Gegenprobe gemessen: mit `false` fällt **genau** 8e, die 83 Prüfnamen beider Läufe
sind per `diff` identisch.

## Etappe V2: Der Werftrabatt (03.09.2026)

Auftrag Sascha: alle Punkte der Vorposten-Auswahl umsetzen. Dieser stand als **Schuld im eigenen
Quelltext**: Der Kommentar über `VORPOSTEN_ZWEIGE` nennt seit dem 02.09.2026 „Werftrabatt" und
„Marktgebühr" als Kanäle, die später *zusammen mit ihrer Wirkung* kommen. Steckplätze, Projekte und
Sprungtor sind seither gebaut — diese beiden nicht. Bis hierher war die „Werft" ein
Flugzeit-Multiplikator mit dünnerem Kern: Sie baute nichts.

**Der Kanal.** `werft` ist ein Anteil **ersparter Bauzeit** in der Werft. Er steht auf der Leiter
(0,02 im Feldlager bis 0,16 auf Stufe 8) und bekommt ab der Wahlstufe den Zweig-Multiplikator:
Werft 2,20, Handel und Festung je 0,50. Eine Sternenwerft kommt damit auf **35,2 %**, ein
Sternenmarkt oder eine Sternenfestung auf 8 %.

**Der Deckel gilt der Summe, nicht dem einzelnen Vorposten** — genau wie bei `prod`. Drei
Sternenwerften kämen auf 105 % und damit auf Bauzeit null. Ein Deckel je Vorposten hätte das nicht
verhindert und wäre zugleich unprüfbar gewesen, weil ihn heute kein einzelner Vorposten erreicht
(gemessen: 0,352 gegen 0,40). Der Wert reist als `werftDeckel` an jedem Vorposten und im Katalog
mit, damit im Frontend keine zweite Zahl gepflegt werden muss.

**Global, nicht je System.** Schiffe entstehen zu Hause, nicht am Vorposten — der Rabatt summiert
sich deshalb über alle eigenen Vorposten wie `prod`, statt am Zielsystem zu hängen wie `flug`.

**Der Schalter.** `VP_WERFT_AKTIV` steht ausgeliefert auf `false`; solange meldet `nutzen.werft`
eine harte 0. Umgelegt wird er, sobald das Frontend den Kanal liest. Ein gemeldeter Nutzen, der
nirgends wirkt, wäre eine Lüge — dieselbe Regel, aus der die Zweige von Anfang an nur über Kanäle
unterschieden wurden, die es schon gibt.

Wächter: `tests/test_vorposten_werft_http.js` (Port 3255, 9 Prüfungen). Er läuft **zweimal**, mit
umgelegtem und mit aktiv ausgeschaltetem Schalter: Geprüft wird die *Wirkung* des Schalters, nicht
seine ausgelieferte Stellung — ein Test, der die Auslieferung als Voraussetzung nimmt, fällt bei
genau der Änderung, die er begleiten soll (Lehre aus `test_hort_meldung_http.js`). Gegenproben
`zweigmult` (1b), `leiter` (1b, 1c) und `schalter` (2a); die Liste bei `leiter` führt 1b als
**gemessene** Folge mit, weil die Erwartung dort aus dem unversehrten Quelltext stammt.

## Etappe V3: Die Marktgebühr (03.09.2026)

Der zweite der beiden Kanäle, die der Quelltext seit dem 02.09.2026 schuldet. Der Handelsknoten war
bis hierher Produktion mal 1,8 und die dünnste Hülle — er handelte nicht.

**Zwei Wirkungen, eine Zahl.** Der Kanal `markt` liegt auf derselben Leiter wie `werft`
(0,02 → 0,16) und bekommt den Multiplikator Handel 2,20, Werft und Festung je 0,50. Ein
Sternenmarkt kommt damit auf **35,2 %**. Daraus folgen:

1. **Die Einstellgebühr sinkt anteilig** — bei 5 % Grundgebühr und 35,2 % Rabatt zahlt der
   Verkäufer 3,24 % statt 5 % (gemessen: 3.240 statt 5.000 Kredite auf 100.000).
2. **Mehr gleichzeitige Angebote** — ein Platz je `VP_MARKT_SLOT_SCHRITT` (0,12), höchstens drei.
   Ein Sternenmarkt gibt zwei, zwei Sternenmärkte den Deckel.

Beide hängen an derselben Summe, damit die Balance an einer Stelle sitzt. Deckel 60 %: Die Gebühr
wird gesenkt, nie erlassen.

**Die Gebühr hängt am VERKÄUFER, nicht am Käufer.** Er zahlt sie, und er ist nicht der, der die
Anfrage stellt — im Code steht deshalb `vorpostenMarktBonus(listing.sellerId)` und ausdrücklich
nicht `req.userId`. Die naheliegende Verwechslung hätte dem Käufer den Rabatt eines fremden
Handelsknotens gegeben und wäre im Normalbetrieb nie aufgefallen.

**Die Grenzen kommen fertig verrechnet zum Client.** `limits.feePct` und `limits.maxPerUser` sind
die *wirklich geltenden* Werte; `basisFeePct`, `basisMaxPerUser`, `vorpostenRabatt` und
`vorpostenAngebote` reisen daneben mit, damit die Anzeige den Rabatt benennen kann, ohne ihn selbst
zu rechnen. Eine zweite Rechenstelle wäre die nächste Kopie-Familie.

**Der Schalter.** `VP_MARKT_AKTIV` steht ausgeliefert auf `false`. Weil `vorpostenWerte` dann für
jeden Vorposten eine harte 0 liefert, ist die Summe 0 und alles bleibt, wie es war — ein zweiter
Schalter-Zweig in `vorpostenMarktBonus` wäre eine zweite Stelle, die dasselbe entscheidet.

Wächter: `tests/test_vorposten_markt_http.js` (Port 3256, 12 Prüfungen) — gemessen über die **echten
Endpunkte**: einstellen, kaufen, Gebühr in der Antwort lesen. Ein Test, der die Gebühr selbst
nachrechnet, prüft seine eigene Formel. Gegenproben `verkaeufer` (2a, 2c), `gebuehr` (2a, 2c),
`slots` (1c, 3a) und `schalter` (4a, 4b) — **alle vier Listen waren im ersten Entwurf falsch**, und
`slots` deckte dabei einen echten Testfehler auf: Prüfung 3a ließ nur den Vorpostenlosen seine
Plätze füllen und fragte dann den Handelsknoten — der hatte nach dem Verkauf aber null offene
Angebote, sein Angebot ging mit und ohne Bonus durch. Jetzt füllen beide erst die Grundzahl.

## Etappe V4: Das Lager am Vorposten und die Beute beim Fall (03.09.2026)

Bis hierher war ein Vorposten ein Bonus auf Zahlen — Flugzeit, Produktion, Aufklärung. Man flog nie
hin, holte nie etwas ab, und sein Verlust kostete nur diesen Bonus. Jetzt fördert er.

**Kein Ticken.** Der Stand wird beim Lesen und beim Abholen aus der verstrichenen Zeit *gerechnet*,
nicht laufend gutgeschrieben — dieselbe Entscheidung wie bei den Projekten: kein Zustandsübergang,
der verlorengehen könnte, kein Schreiben beim Lesen. `doc.lagerSeit` ist der einzige Zustand, und er
fällt auf `doc.seit` zurück, damit ein Dokument von vor dieser Etappe korrekt weiterrechnet statt
seit 1970 zu sammeln.

**Der Deckel ist die ganze Balance.** `VP_LAGER_STUNDEN = 12`. Ohne ihn wäre ein vergessener
Vorposten eine Bank, die mit der Abwesenheit wächst. Beim Abholen wird `lagerSeit` auf **jetzt**
gesetzt, nicht um die geholten Stunden zurückgedreht — ein Zurückdrehen machte den Deckel wirkungslos.

**Die Aufteilung ist gemessen, nicht erfunden:** die `baseRate`-Werte der drei Fördergebäude des
Spiels (Erzmine 0,225, Kristallraffinerie 0,075, Deuteriumsynthetisierer 0,06). Ein Vorposten fördert
im selben Verhältnis wie eine Kolonie; eine eigene Mischung wäre eine zweite Wirtschaftsaussage über
dieselbe Welt.

**Kalibriert gegen die eigene Förderung des Spiels.** Stufe 8 trägt 25.000 Erz-Äquivalent je Stunde,
ein Handelsknoten 45.000 (Multiplikator 1,80 — dieselben Zahlen wie `prod`, denn wer Ertrag macht,
macht auch Vorrat). Ein Spätspieler fördert selbst rund 145.000 Erz je Stunde (Mine 45,
Multiplikator 4, gemessen an `ratesPerSecond` im Frontend). Das Lager ist damit eine Beigabe, kein
Ersatz — drei volle Vorposten bleiben unter dem, was er in derselben Zeit selbst fördert.

**Das Lager ist offen sichtbar**, wie Verteidigung und Garnisonszahl. Das ist der Zweck: Wer stürmt,
soll riechen können, wo sich der Flug lohnt. Die Spannung zur älteren Regel „Beute hängt an der Stufe,
nicht am Zubehör" ist gewollt und auflösbar: **Module sind Investition** und bleiben ungestraft,
**das Lager ist Versäumnis** — bestraft wird, wer hortet, nicht wer ausbaut.

**Beim Fall** wandert das Lager nach demselben Schadensanteil an die Angreifer wie Kampfpunkte, XP
und Kredite (`lagerBeute`); der Besitzer erfährt in seiner Verlust-Meldung, *was* er verloren hat
(`lagerVerloren`), nicht nur *dass*. Der Stand wird dafür gemessen, **bevor** das Dokument
verschwindet.

Der Schalter `VP_LAGER_AKTIV` steht ausgeliefert auf `false`; dann ist die Rate 0, das Lager bleibt
leer, und `POST /api/vorposten/lager/holen` antwortet mit 404 und `inaktiv`. Der Endpunkt-Riegel ist
mit Absicht eine zweite Stelle: Er gibt eine verständliche Auskunft statt der irreführenden „Im Lager
liegt noch nichts".

Wächter: `tests/test_vorposten_lager_http.js` (Port 3257, 17 Prüfungen). Gegenproben `deckel` (2b),
`zurueckdrehen` (3a), `beute` (4a) und `schalter` (5a).

### Zwei Testfehler, die diese Etappe aufgedeckt hat

1. **Prüfung 3a war zeitabhängig.** Sie holte zweimal hintereinander ab und erwartete beim zweiten
   Mal „leer" — ein Handelsknoten der Stufe 8 fördert aber 7,8 Erz je *Sekunde*, nach einer
   Zehntelsekunde ist das Lager nicht mehr leer. Aufgefallen ist es daran, dass die Gegenprobe
   `beute` 3a mitriss, obwohl sie mit dem Abholen nichts zu tun hat. Gemessen wird jetzt der
   Zustand: `lagerSeit` steht danach auf jetzt.
2. **Anker und Sabotagen von V2 und V3 hingen daran, dass ein Wert der letzte im `mult`-Objekt ist**
   (`werft: 2.20 \}`). Der neue Kanal `lager` dahinter hat sie gebrochen — die Anker fielen laut, die
   *Sabotage* aber still: Sie griff ins Leere, und die Gegenprobe belegte nichts mehr. Beide greifen
   den Wert jetzt innerhalb des `mult`-Objekts, ohne seine Position festzuhalten.

## Etappe V5: Der Verbündete darf etwas (03.09.2026)

Bis hierher stand an **jeder** Vorposten-Route `doc.besitzer !== req.userId` → 403. Ein
Allianzpartner konnte nichts: nicht beisteuern, nicht mitnutzen, nicht mitbauen. Reines
Einzeleigentum in einem Allianzspiel.

**Die Mechanik ist eine Datenfrage.** `doc.garnisonVon` schlüsselt auf, **wer** was gestellt hat,
und ist die Quelle; `doc.garnison` wird daraus nachgezogen — bei jedem `vorpostenSchreib`, wie das
Kern-Dach. Zwei Zahlen über denselben Bestand wären sonst eine Frage der Zeit. Ein Dokument von vor
dieser Etappe schreibt seine ganze Garnison dem Besitzer zu (Migration in `vorpostenGarnisonVon`).

**Was der Verbündete darf:** Garnison beisteuern und **nur seine eigenen** Schiffe zurückrufen. Der
Besitzer kann fremde Schiffe nicht einziehen. Ausbauen, abbauen, Projekte starten und das Lager
abholen bleiben beim Besitzer.

**Verluste treffen jeden Beitragenden mit derselben Quote**, nicht die Gesamtzahl mit
anschließender Verteilung. Der Unterschied ist eine Rundung je Konto und Schiffstyp; dafür ist die
Rechnung nachvollziehbar und niemand verliert Schiffe, die er nie gestellt hat.

**Beim Fall und beim Abbau bekommt jeder seine eigene Meldung** (`alsVerbuendeter`) mit *seinen*
Schiffen — ohne sie wäre die Garnison eines Verbündeten eines Tages einfach nicht mehr da, ohne dass
irgendetwas es gesagt hätte. Die Module gehen weiterhin nur an den Besitzer.

**Die Rechteprüfung liest den geteilten Speicher** (`allianceTagOf`, jede aktive Rolle), **nicht**
`save.player.allianceTag`: Der Spielstand ist klientenautoritativ, und eine Rechteprüfung, die ihn
glaubt, ist keine. Prüfung 2e misst genau das mit einem Konto, das den Tag im Spielstand trägt und
keine Rolle im geteilten Speicher hat.

Schalter: `VP_ALLIANZ_AKTIV` (ausgeliefert `false` — dann verhält sich alles wie vorher).

Wächter: `tests/test_vorposten_allianz_http.js` (Port 3258, 14 Prüfungen). Gegenproben `schalter`
(1a), `rueckruf` (3a, 3b), `spielstand` (2e, 3b) und `nachziehen` (2b, 2c).

**Zwei Sabotagen griffen im ersten Entwurf ins Leere** und sind deshalb erwähnenswert: `schalter`
setzte den Schalter, den Abschnitt 1 ohnehin selbst schreibt — er muss die *Gatterung* brechen;
und `nachziehen` entfernte nur das Sicherheitsnetz in `vorpostenSchreib`, während der gemessene Weg
die zweite, ausdrückliche Stelle im Stationieren benutzt. Eine Sabotage, die nichts trifft, sieht
aus wie ein bestandener Test.

### Offen aus der Auswahl: der Allianz-Vorposten mit geteilten Kosten

Punkt (c) der Allianz-Frage — ein Vorposten, den mehrere gemeinsam bezahlen — ist bewusst **nicht**
Teil dieser Etappe. Er ändert das Eigentumsmodell (heute genau ein `besitzer`) und braucht eine
Treuhand für Baubeiträge in `db.shared`. Das ist eine eigene Etappe, keine Zeile mehr an dieser.
