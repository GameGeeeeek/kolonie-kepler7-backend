# Asteroidenfestungen (Phase 1 und 2)

Verschoben aus `CLAUDE.md` am 01.09.2026 (Strukturprüfung, Punkt 1: Startkontext verkleinern). Wortlaut unverändert; Querverweise wie „unten" oder „oben" beziehen sich auf die frühere Reihenfolge in `CLAUDE.md`. Neue Erkenntnisse zu diesem Bereich gehören ab jetzt hierher, nicht in `CLAUDE.md`.

## Asteroidenfestungen (Phase 1, 18.08.2026)

Konzept: `docs/aliens-asteroidenfestungen-konzept.md` im FRONTEND-Repo. Hier stehen nur die
Entscheidungen, die man kennen muss, bevor man etwas daran ändert.

**`FESTUNG_SPAWN_AKTIV` steht seit dem 18.08.2026 auf `true`** – das Frontend der Phase 1 ist
ausgeliefert (v8.569.0), und damit ist die Bedingung erfüllt, unter der er auf `false` stehen
musste. Nachgemessen im Browser, bevor der Schalter kippte: Die Karte zeichnet die Festung als
eigenen Knoten (32×32 px, sichtbar – nicht nur im DOM), das Kartenmenü nennt Kern, Blockade und
Hort, die Abbau-Vorschau **benennt** die Drosselung und zeigt die gekürzte Ladung (2,4k statt
5,4k), und der Missionsstart schickt weiterhin den ROHEN Wunsch, damit der Server nicht ein
zweites Mal kürzt.

**Der Schalter bleibt trotzdem stehen** – als Notausschalter. Eine Zeile umzulegen ist schneller
und sicherer, als einen Merge zurückzunehmen, und Endpunkte, Härtungen und Tests bleiben dabei
unangetastet. `test_festung_http.js` Abschnitt 10 prüft jetzt, dass er auf `true` steht; ein
Wechsel auf `false` ist damit eine bewusste Notabschaltung, die auffällt, statt still zu geschehen –
und ihr Grund gehört dann hierher.

Warum er überhaupt gebaut wurde, bleibt als Begründung wichtig:

**Er stand zunächst auf `false`, und das war kein Übersehen.** Solange der Schalter aus
ist, entsteht keine Festung – und ohne Festung tut der ganze Abschnitt nichts. Der Grund ist die
Auslieferung: Backend und Frontend gehen über **zwei getrennte** fest verdrahtete Befehle desselben
Webhooks live, und sie sind historisch dreimal auseinandergelaufen. Ginge dieses Backend allein
live, entstünde binnen Stunden eine Festung, und die Blockade kürzte die Abbauladung um bis zu
55 % – während das Frontend die UNGEKÜRZTE Vorschau zeigt und das Feld `festung` nicht einmal
kennt. Gemessen am Frontend-Code (`echt = daten.menge`, `weltraum_kolonie.html` Z. 55883): Der
Spieler bekommt still weniger, als die Vorschau ihm versprach, ohne einen einzigen Hinweis worauf.
Umgelegt wird der Schalter im **Frontend-PR der Phase 1**, nicht vorher. `test_festung_http.js`
Abschnitt 10 hält ihn fest, damit er nicht versehentlich früher kippt.

**Der Fund, der den Schalter erst nötig machte – `st.proto` war eine Zahl, die nur die ANKÜNDIGUNG
las.** Die Stufentabelle führt neben `blockade` (Ladung) ein Feld `proto` (0,50/0,75/1,00) für die
Protomaterie-Drosselung, die das Konzept als den eigentlichen Zahn der Blockade beschreibt. Ein
`grep` nach `st.proto` fand einen Treffer und sah damit benutzt aus – der einzige Treffer war
jedoch der **Galaxie-Nachrichtentext, der die Drosselung ankündigt**. Die Mechanik selbst gab es
nicht. Der Grund liegt im Frontend: Die Protomaterie je Fuhre hängt allein an der **GRÖSSE** des
Vorkommens (`proto: protoJeFuhre(a)` – Z. 55912 im Missionsstart, Z. 55722 in der Vorschau, und
beide müssen im Gleichschritt bleiben), nicht an der Ladung – die Ladungskürzung erreicht sie also
nie. Behoben, indem `/api/asteroid/mine` den Faktor als **`protoBlockade`** mitschickt und
das Frontend ihn multipliziert; der Server bleibt Autorität über den Faktor, dieselbe Arbeitsteilung
wie bei `menge`.
**Die übertragbare Lehre: Ein Konstantenfeld, das nur der Ankündigungstext liest, ist keine
umgesetzte Mechanik – und ein `grep` nach dem Namen sagt das Gegenteil.** Wer prüfen will, ob eine
Tabellenspalte wirklich wirkt, muss die Fundstellen einzeln ansehen und fragen, ob eine davon
etwas BERECHNET. Das ist die Gegenrichtung zu Frontend-Arbeitsregel 32: Dort existiert eine Zahl
nur zur Laufzeit und wird beim Suchen übersehen, hier existiert sie nur im Versprechen und wird
beim Suchen fälschlich für vorhanden gehalten.

**Wo die Festung wohnt:** in `db.shared['asteroids:<sys>'].festung`, also im selben Dokument wie die
Vorkommen. Geschrieben wird es ausschließlich von den Asteroiden-Endpunkten – die generische
Storage-Route ist seit dem 18.08.2026 durch `checkAsteroidKeyPermission()` gesperrt. Das war die
Voraussetzung für alles Weitere: Ohne die Sperre wäre der Kern-Lebenspunktestand einer Festung von
jedem Konto mit einer Anfrage auf null zu setzen.

**`astFreiePlaetze()` ist DIE EINE Stelle, die „welcher Platz ist frei" beantwortet.** `astNachschub`
suchte das vorher an zwei Stellen selbst und hätte ein nachwachsendes Vorkommen auf den Platz der
Festung gesetzt – die wäre damit still verschwunden. Gemessen in der Gegenprobe: **6 von 6**
Nachschub-Runden trafen den Festungsplatz. Ein dritter Aufrufer erbt das Verhalten jetzt automatisch
(dieselbe Behandlung wie `kbMarkerFrei` im Frontend).

**Die Kern-Lebenspunkte sind GERECHNET, nicht geschätzt.** Gemessen über `rawFleetPower` +
`diminishingShipCount` (Schwelle 300, danach halber Wert) für drei Ausbaustufen, dazu die üblichen
Multiplikatoren aus `computeAttackPowerFromComposition`: je Schlag rund **7.500 / 44.000 / 240.000**.
Daraus die Kerne 30.000 / 250.000 / 1.200.000, also vier bis sieben Schläge für ein Konto der
passenden Stufe – bei 6 h Abklingzeit ein bis zwei Tage allein. Der erste Entwurf stand bei 120.000
für die Schanze; das wären für ihr eigentliches Publikum **neunzehn** Schläge gewesen, fast fünf
Tage, ausgerechnet am Einsteigerziel. Zur Einordnung: Der Weltboss startet bei 50.000 LP und wächst
um Faktor 1,6 je Stufe – die Schanze liegt darunter, das Kastell etwa bei Stufe 5, die Sternenfeste
bei Stufe 8. **Wer diese Zahlen anfasst, rechnet sie gegen echte Flottenkräfte nach**, nicht gegen
das Gefühl (Frontend-Arbeitsregel 41: ein Konzept ist kein Messergebnis).

**Der Hort trägt eine `sorte` aus `AST_SORTEN`** – kein Schmuck, sondern die Vermeidung eines
zweiten Begriffs: Der Server verteilt in diesem ganzen Modul keine Ressourcen, er führt nur Sorte
und Menge, das Frontend bildet daraus seine T1-Ressourcen ab. Eine Festung mit Sorte läuft damit
durch dieselbe Abbildung wie jede Abbaufuhre. Die **Protomaterie dagegen führt der Hort IMMER**,
unabhängig von der Sorte (bei den Vorkommen trägt sie nur `urmaterie`). Das ist Absicht und der
Kern der Belohnung: Sie ist die einzige Größe, die im Endspiel nicht in der Eigenproduktion
untergeht – 8,81 Mio. Erz je Stunde gegen 11 bis 32 Protomaterie. Hinge sie an der Sorte, wäre die
Belohnung in neun von zehn Fällen wertlos und die Festung für entwickelte Konten kein Ziel.

**Der Hort wächst LAZY beim Lesen** (`festungReifen`, aus `letzteReifung`), nicht im galaxyTick: Der
Takt läuft alle 15 Minuten, das Feld wird viel häufiger gelesen, und ein Zähler, der nur beim Tick
wächst, wäre dazwischen eingefroren. Dasselbe Muster wie `user.marktTag`. Das ENTSTEHEN dagegen
liegt im galaxyTick – eine Festung ist ein Ereignis der Galaxie, kein Nebeneffekt eines
Kartenaufrufs.

### Drei Entscheidungen an `/api/festung/angriff`, die man kennen muss

1. **Die Abklingzeit liegt AN DER FESTUNG (`festung.schlaege[userId]`), nicht im Spielstand.** Der
   Konzept-Entwurf sah `save.festungLetzterSchlag[sysId]` vor – das wäre wertlos gewesen: Der
   Spielstand ist bauartbedingt klientenautoritativ, ein gelöschtes Feld gibt den nächsten Schlag
   sofort frei, und die einzige Bremse der ganzen Mechanik wäre per Entwicklerkonsole abschaltbar.
   Genau so macht es die Anfechtung nebenan mit `vork.angriffe[userId]`.
   Der Weltboss legt seine 24-Stunden-Sperre bewusst in den Spielstand, weil sie einen Respawn
   überleben soll – dort ist das richtig, hier nicht: Fällt die Festung, ist ihre Abklingzeit
   gegenstandslos. **Zwei berechtigte Ablageorte, und welcher stimmt, hängt an der Frage, was die
   Sperre überleben soll.**
2. **Gezählt wird, was ANGEKOMMEN ist**, nicht was gewürfelt wurde: `schaden = kernVorher - kernNachher`.
   Gemessen in der Gegenprobe – mit dem vollen Wurf stünde der letzte Angreifer bei **84,2 %** des
   Hortes statt bei den 40 %, die seiner Arbeit entsprechen. Der Weltboss zählt den vollen Wurf; hier
   ist bewusst abgewichen, weil der Hort rein anteilig ausgezahlt wird.
3. **Der Server schreibt den Spielstand des Angreifers NICHT.** Die Verluste stehen in der Antwort,
   sein Client bucht sie – das Muster der Anfechtung, nicht das des Weltbosses. Damit entsteht das
   Wettrennen zwischen Server-Schreibung und Autosave gar nicht erst. Die Belohnung beim Fall geht an
   **alle** Beitragenden über `pushPendingReward` (also `db.private[uid].__pendingRewards`, nie ein
   fremder Spielstand) – **auch an den Anfragenden selbst**: Ein Weg für alle statt zweier, die
   auseinanderlaufen können.

**Die Blockade greift an der GEWÄHRTEN MENGE, nicht an der Obergrenze – und der erste Entwurf tat
das Gegenteil, ohne dass sein Test es sah (18.08.2026).** `obergrenze` ist die Anti-Betrugs-Schranke
aus dem gespeicherten Spielstand und hat bewusst reichlich Luft (`AST_MAX_JE_SCHUERFSCHIFF` nennt
„Faktor 3,5"). Sie bindet im echten Spiel praktisch nie. Ein Faktor auf sie ist deshalb wirkungslos –
gemessen für vier typische Flotten, Frontend-Laderaum gegen `obergrenze × 0,45`:

| Flotte | Laderaum | gekürzte Obergrenze | Wirkung |
|---|---|---|---|
| 50 Schürfschiffe, keine Forschung | 20.000 | 45.000 | keine |
| 50 Schürfschiffe, Förderung max | 28.000 | 45.000 | keine |
| 16 Schürf + 20 Frachter | 14.960 | 27.900 | keine |
| 50 Schürf + 100 Großfrachter | 178.000 | 382.500 | keine |

**In keinem Fall hätte ein Spieler etwas von der Blockade gemerkt.** Die ganze Mechanik war inert.
Aufgefallen ist es erst beim Bau der Frontend-Vorschau, beim Nachrechnen der beiden Kapazitäten
gegeneinander.

**Und der eigene Test hat es gedeckt** – er schickte `wunsch: 999999999` und maß damit exakt den
Deckel statt der Wirkung. Das ist Frontend-Arbeitsregel 7 („Messen, was gemessen werden soll, nicht
den Deckel") in Reinform, und es ist die zweite Prüfung dieses Bereichs, die aus dem falschen Grund
grün war. Seither schickt `test_festung_http.js` einen realistischen Wunsch (30.000, klar unter der
Obergrenze); die Gegenprobe am alten Stand liefert für alle drei Messungen unverändert 30.000.
Dazu `7e`, das ausdrücklich prüft, dass die Obergrenze WEITERHIN bindet – sonst wäre beim Verschieben
des Faktors der Betrugsschutz still verlorengegangen.

**Die übertragbare Lehre: Wer einen Faktor an eine Schranke hängt, muss zuerst messen, ob diese
Schranke überhaupt bindet.** Eine Schranke mit Sicherheitsabstand ist gerade dadurch definiert, dass
sie normalerweise nicht greift – ein Rabatt darauf ist ein Rabatt auf nichts.

**`Math.round` statt `Math.floor`** bei der Blockade-Obergrenze: `1 - 0.55` ist in Gleitkomma
`0.44999999999999996`, abgerundet werden aus 100.000 Kapazität 44.999 statt 45.000. Für den Spieler
eine grundlos krumme Zahl – und schlimmer, das Frontend rechnet dieselbe Formel für die Vorschau, eine
Paritätsprüfung müsste sonst das Rauschen zeichengenau nachbauen statt die Regel.

### Die Lehre aus dem Test dieses Bereichs

`tests/test_festung_http.js` (Port 3221, **33 Prüfungen, sieben Gegenproben** – Abklingzeit,
Schadenszählung, Blockade, Geräumt-Bonus, Platzkollision, `protoBlockade`, Spawn-Schalter; alle in
beide Richtungen gefahren, überall dieselbe Anzahl gelaufener Prüfungen). **Belegte Testports sind
jetzt 3195–3200, 3210–3219, 3220 (`test_serverstart.js`) und 3221** – ein neuer Test nimmt 3222
(Arbeitsregel 29).

Zwei Zahlen aus den Gegenproben, die den Wert der jeweiligen Entscheidung belegen: Mit dem vollen
Wurf statt dem angekommenen Schaden stünde der letzte Angreifer bei **84,2 %** des Hortes statt bei
40 %. Und ohne `astFreiePlaetze` trafen **6 von 6** Nachschub-Runden den Platz der Festung – sie
wäre still verschwunden.

Eine Falle daraus, die jeder Test mit mehreren Serverstarts auf derselben DB vermeiden muss:

**Eine Änderung an der DB-DATEI, während der Server noch läuft, ist beim nächsten `stoppeServer()`
wieder weg.** SIGTERM löst den Graceful Shutdown aus, und der flusht die im Speicher gehaltene `db`
auf Platte – über die gerade geschriebene Änderung hinweg. Im grünen Lauf fiel das nicht auf, weil
die betroffenen Prüfungen durch die Abklingzeit ohnehin erfüllt waren und die Abklingzeit VOR der
Missionssuche geprüft wird. Erst die Gegenprobe mit ausgebauter Abklingzeit brachte heraus, dass die
vorbereitete Mission nie in der Datei stand – die Ablehnung lautete dann „keine Flotte unterwegs"
statt der erwarteten. **Eine Prüfung, die aus dem falschen Grund grün ist** (Frontend-Arbeitsregel 28),
und sie wäre ohne die Gegenprobe nie aufgefallen.
Behoben nicht durch vier von Hand richtig sortierte Stellen, sondern durch **einen Helfer**
(`aendereDb(fn)`: stoppen → lesen → ändern → schreiben → starten), der die falsche Reihenfolge
strukturell unmöglich macht.

## Asteroidenfestungen Phase 2: die drei Bauteile (18.08.2026)

Schildkuppel und Geschütztürme neben dem Kern, dazu die **Zielwahl** und die **Rollenfaktoren**.

**`FESTUNG_BAUTEILE_AKTIV` steht seit dem 18.08.2026 auf `true`** – das Frontend der Phase 2 ist
ausgeliefert (v8.575.0), und damit ist die Bedingung erfüllt, unter der er auf `false` stehen
musste. Die Zielwahl steht, die Bauteil-Balken stehen, und der Hilfetext leitet Durchlass,
Verlustquote und Rollenfaktoren aus der Frontend-Kopie dieser Tabelle ab, die
`tests/test_festung_paritaet.js` gegen `server.js` hält – inzwischen auch `regenProStd` und
`FESTUNG_BAUTEIL_BEITRAG`, die dort **ausschließlich** stehen, damit der Hilfetext seine Zahlen
ableiten kann statt sie zu behaupten.

**Der Schalter bleibt trotzdem stehen** – als Notausschalter, aus demselben Grund wie
`FESTUNG_SPAWN_AKTIV`. `test_festung_bauteile_http.js` 1d prüft jetzt, dass er auf `true` steht; ein
Wechsel auf `false` ist damit eine bewusste Notabschaltung, die auffällt statt still zu geschehen –
und ihr Grund gehört dann hierher.

Warum er überhaupt gebaut wurde, bleibt als Begründung wichtig: Ginge dieses Backend allein live,
richtete ein Kernschlag nur noch 35 % an und kostete 30 % statt 12 % der Flotte, während das
Frontend `bauteile` nicht kennt und weder das eine erklären noch das andere abwenden kann. Der
Spieler sähe nur, dass sein Verband plötzlich dreimal so teuer ist und ein Drittel ausrichtet.

**Die LP der Bauteile sind ANTEILE des Kerns** (Schild 40 %, Türme 25 %), keine eigenen Zahlen –
eine Größe zu pflegen statt drei, und sie skalieren automatisch mit der Stufe. Gerechnet gegen die
gemessenen Schlagkräfte: mit einer PASSEND spezialisierten Flotte (Rollenfaktor 1,6) fällt der
Schild in 1,0–1,4 Schlägen, die Türme in 0,6–0,9. Der erste Entwurf stand bei 30 % / 20 %; damit
fielen beide in UNTER einem Schlag, und der ganze Abschnitt wäre eine Formalität statt einer
Entscheidung gewesen.

**Warum sich der Umweg über den Schild überhaupt lohnt, nachgerechnet:** Solange er steht, kosten
Kerntreffer das 2,86-fache. Ihn zu brechen lohnt, solange seine LP unter dem 2,98-fachen des Kerns
liegen – bei 40 % mit großem Abstand erfüllt. Die Mechanik trägt also, ohne dass die Zahl fein
justiert werden müsste.

**Der Rollenfaktor rechnet nach ANTEIL an der Angriffskraft, nicht nach Anwesenheit.** Ein einzelner
Bomber in einer Kreuzerflotte darf den Schildbonus nicht auslösen. Der Faktor läuft linear zwischen
`min` (0,70) und `max` (1,60); gemessen: reine Bomberflotte 1,60, gemischte 1,24, ohne Bomber 0,70.
Die Gegenprobe mit „nach Anwesenheit" liefert für die gemischte Flotte 1,60 – ein einzelner Bomber
würde reichen. Der Anteil kommt aus `rawFleetPower` je Teilmenge, damit dasselbe Gewicht zählt wie
im echten Kampf statt einer zweiten Bewertung daneben.

**Schaden an Bauteilen zählt zu 60 % auf den Hortanteil.** Ohne diesen Ausgleich würde niemand den
Schild angreifen – die Arbeit nützt dem VERBAND, nicht dem eigenen Zähler, und die ganze
Rollen-Mechanik wäre tot. Gewichtet und nicht voll: Wer den Kern zerlegt, hat die Festung gestürzt;
wer den Schild gebrochen hat, hat es ermöglicht.

**Der Schild regeneriert 2 %/Std., die Türme nie – und ein ZERSTÖRTER Schild kommt nicht wieder.**
Sonst wäre der erkämpfte Vorteil vor der zweiten Welle wieder weg. Die Regeneration läuft im selben
Lazy-Takt wie der Hort.

**Ist das gewählte Bauteil schon zerstört, geht der Schaden OHNE Rollenfaktor auf den Kern**
(`ziel: 'kern-ersatz'`). Die Flotte wird nicht dafür bestraft, dass ein Mitstreiter schneller war –
bekommt aber auch keinen Bonus für ein Ziel, das sie nicht trifft.

**Die Zielwahl steht in der MISSION, nicht im Request.** `/api/festung/angriff` nimmt weiterhin
keinen einzigen Kampfparameter aus dem Body – dieselbe Eigenschaft wie bei den Gefechtsvorräten und
`/api/attack`.

`tests/test_festung_bauteile_http.js` (Port 3222, 28 Prüfungen, vier Gegenproben). Die Messungen
sind **Vergleiche zweier Schläge derselben Flotte**, nicht Blicke auf ein Feld: Schild 8.821 gegen
33.732 Kernschaden, Türme 30,5 % gegen 12,6 % Verluste. Ein Feld allein wäre die Beschriftung, nicht
die Wirkung (Frontend-Arbeitsregel 61).



## Der Verband gegen eine Asteroidenfestung (01.09.2026)

Auftrag Sascha „Alle umsetzen". Der koordinierte Musterangriff kannte als Zielart nur `alien-nest`
(Phase 5). Eine Sternenfeste braucht fünf Endspiel-Schläge bei sechs Stunden Abklingzeit, also zwei
Tage allein – genau dafür ist ein Verband gedacht. Seither gibt es `zielArt: 'festung'` mit
`festungSystem`, `festungId` und `festungZiel` (`kern` | `schild` | `tuerme`) im Request; unbekannte
Zielarten und Bauteile werden mit 400 abgelehnt.

**`festungSchlagAusfuehren(feld, fest, sysId, kraft, composition, beteiligte, jetzt, zielWunsch, marks)`
ist seither der gemeinsame Kern** von `/api/festung/angriff` und dem Festungs-Zweig von
`/api/musterattack/resolve` – dieselbe Konstruktion wie `nestSchlagAusfuehren`. Der Einzelweg ist
byte-gleich zu vorher: Mit einem Beteiligten (Gewicht 1) ist jeder Anteil exakt 1, und jede Zeile
steht an derselben Stelle wie im alten Rumpf; `test_festung_http.js` (35) und
`test_festung_bauteile_http.js` (28) laufen unverändert grün. Der Verband übergibt `marks = null`
(Werftmarken sind personengebunden, eine Summe aus zehn Flotten hat keine).

**Drei Entscheidungen, alle aus dem Nest-Zweig übernommen:** Bei einer Festung wird der
Verteidiger-Zweig von `resolve` nicht betreten (`musterIstPveZiel`; ein Nest wie eine Festung hat
kein `targetTag`, und `allianceRoleOf` verkettet seinen Schlüssel zu `alliance:null:role:<uid>`).
Kein `incomingmuster`-Dokument (niemand, der gewarnt werden könnte). `claim` gibt nur die Schiffe
zurück – der Hort liegt anteilig in `__pendingRewards`, ausgezahlt vom Kern an ALLE Beitragenden
nach ihrer beim Beitritt gemessenen Kraft, und alle bekommen die Abklingzeit.

Wächter: `tests/test_muster_festung_http.js` (Port 3241, 35 Prüfungen). Drei Gegenproben, je mit
Pflichtliste und identischer Prüfliste: `rechte` → 2c, `gewicht` → 4c und 4d, `claim` → 5a und 5b.
**Die erste Fassung der Pflichtlisten nannte je nur eine Prüfung** – gemessen fallen bei `gewicht`
auch die Abklingzeit (4d) und bei `claim` auch die Antwortfelder (5a). Eine Pflichtliste ist selbst
eine Behauptung, bis die Gegenprobe sie gemessen hat.

**Belegte Testports sind jetzt 3195–3200 und 3210–3241** – ein neuer Test nimmt 3242.

**Die Auslieferungsreihenfolge ist gleichgültig:** Ohne das Frontend schickt niemand
`zielArt: 'festung'`, und ohne dieses Backend antwortet `create` mit 400 „Unbekannte Zielart" – kein
Zustand, in dem eine Zahl still falsch würde. Kein Schalter nötig.

## Sammelphase 15/30/45/60 und eine Meldung, die ihr Ziel nennt (04.09.2026)

Auftrag Sascha: „füge hier hinzu das man unter festung angreifen auch allianz raid starten kann mit
einstellbarer sammelphase 15 minuten 30 minuten 45 und 60 mit nachricht an allianz". Drei Dinge
waren dafür im Backend zu ändern, und das dritte war ein echter Fehler, kein Wunsch.

**1. `ALLIANCE_MUSTER_DURATIONS` ist jetzt `[15, 30, 45, 60]` Minuten** (vorher 30/60/120). Der
Grund liegt im neuen Einstieg: Ein Verband, den jemand aus dem Festungsmenü heraus ausruft, wird
ausgerufen, **weil gerade jemand da ist**. Zwei Stunden Sammelphase passen zu einem verabredeten
Termin, nicht zu einem spontanen „jetzt gleich". Laufende Verbände mit zwei Stunden bleiben
unberührt – die Liste wird nur beim Ausrufen geprüft. **Kopie-Familie:** dieselbe Liste steht im
Frontend; kein Test vergleicht sie automatisch, beide Seiten also von Hand pflegen.

**2. Die Push-Meldung nennt das wirkliche Ziel.** Sie las bis hierher `greift [<targetTag>] an` –
und `targetTag` ist bei einer Festung, einem Nest und einem Vorposten **null**. Wer einen Verband
gegen eine Festung ausrief, verschickte an seine ganze Allianz „greift [?] an". Jetzt trägt die
Meldung `ziel: musterZielBeschreibung(doc)`, dieselbe Quelle, aus der schon der 409-Text beim
zweiten Verband gespeist wird; der Rückfall auf `targetTag` hält ältere Einträge lesbar, die noch
ohne das Feld in der Warteschlange liegen. Dazu hängt die **Nachricht des Ausrufers** an (auf 60
Zeichen gekürzt) – sie stand vorher nur im Dokument, also genau dort, wo der sie nicht liest, für
den sie gedacht ist.

**3. Die Meldungen werden VOR `saveDb()` eingereiht.** Sie standen dahinter. `pushNotificationEvent`
mutiert `db`, und `saveDb()` war zu dem Zeitpunkt schon durch: Die Meldungen lagen nur im Speicher
und erreichten die Platte erst, wenn irgendein fremder Schreibvorgang zufällig nachkam. Ein
Neustart dazwischen verschluckte den Aufruf still – und der Deploy startet den Prozess bei **jedem**
Push neu. Das ist wortwörtlich die Hausregel „`db` immer synchron vor `saveDb()` mutieren"; sie galt
hier seit dem Bau des Musterangriffs nicht. Aufgefallen ist es nicht im Spiel, sondern beim Bau des
Wächters: Bens Posteingang war leer, obwohl der Verband stand.

**Der Wächter:** `tests/test_muster_festung_http.js`, Abschnitt 8 (fünf Prüfungen, Port 3241
unverändert). Gemessene Gegenprobe am alten Serverstand: es fallen **8a, 8b, 8c, 8d und 8e**, die
Prüfliste beider Läufe ist per `diff` identisch. `8d` und `8e` messen am **echten Endpunkt**, nicht
im Quelltext – die alten zwei Stunden werden mit 400 abgelehnt, 45 Minuten gehen mit 200 durch.

**Auslieferungsreihenfolge: Backend zuerst.** Das Frontend darf die 15/45 erst anbieten, wenn der
Server sie annimmt, sonst antwortet `create` mit „Ungültige Anfrage". Kein Schalter nötig – die
alten Werte 30 und 60 bleiben in beiden Listen gültig, es gibt also keinen Zwischenzustand, in dem
ein Client etwas Unmögliches schickt.
