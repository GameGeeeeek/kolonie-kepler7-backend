# Admin-Bereich: Bonuscodes, Betreiber-Push, vier Admin-Fähigkeiten, Aktivitäts-Uhr

Verschoben aus `CLAUDE.md` am 01.09.2026 (Strukturprüfung, Punkt 1: Startkontext verkleinern). Wortlaut unverändert; Querverweise wie „unten" oder „oben" beziehen sich auf die frühere Reihenfolge in `CLAUDE.md`. Neue Erkenntnisse zu diesem Bereich gehören ab jetzt hierher, nicht in `CLAUDE.md`.

## Bonuscodes (21.08.2026, Auftrag Sascha)

**Wortlaut:** „ich will ab und zu mal bonuscodes posten wo die spieler kleine geschenke bekommen die
codes sollen aber nur eine gewisse gültigkeit haben also max 1 mal pro account einlösbar und nur
1 woche etc aktiv am liebsten baust du mir das in den admin bereich ein."

Vier Endpunkte: `POST /api/admin/bonuscode` (anlegen), `GET /api/admin/bonuscodes` (auflisten),
`POST /api/admin/bonuscode/aktiv` (an/aus/entfernen) und `POST /api/bonuscode/einloesen` (Spieler).

### Die Entscheidung, an der alles hängt: die Sperre liegt am KONTO

Das naheliegende Vorbild `/api/referral/redeem` merkt sich seine Einlösung in
`save.referralRedeemed` – also **im Spielstand**, und der ist bauartbedingt klientenautoritativ. Wer
das Feld in der Entwicklerkonsole löscht, löst erneut ein. Für +50 Kredite unter Freunden ist das
verkraftbar; bei einem Code, der **öffentlich gepostet** wird, wäre es die Selbstbedienung, vor der
dieses Projekt bei jedem Belohnungssystem warnt. Die Sperre liegt deshalb in `user.bonusCodes`, wie
`user.marktTag` und `user.staub` – dieselbe Entscheidung wie beim Kampfvermerk der Anfechtung.
`tests/test_bonuscodes_http.js` 4b misst genau das; die Gegenprobe mit der Sperre im Spielstand
liefert `{"amKonto":false,"imSpielstand":true}`.

Der **Katalog** liegt in `db.bonusCodes`, ausdrücklich nicht in `db.shared`: Der generische
Storage-Endpunkt ist für jeden eingeloggten Nutzer schreibbar, solange keine Sonderregel greift –
dort ließe sich ein Code anlegen. `db.galaxy` ist das Vorbild.

### `BONUSCODE_GABEN` ist die eigentliche Sicherung, nicht die Zahl darin

Die Tabelle sagt, welche Felder ein Code überhaupt tragen darf und wie groß jedes höchstens sein
kann. Ohne sie wäre ein Tippfehler beim Anlegen (1000000 statt 1000) ein Wirtschaftsereignis – und
ein zu großer Wert reißt beim Beschenkten später `SAVE_SANITY_LIMITS`, was den **gesamten**
Spielstand mit HTTP 400 ablehnen lässt. Die Deckel sind bewusst klein: Der Auftrag sagt „kleine
geschenke". Wer eine neue Gabe aufnimmt, trägt sie dort ein – eine Gabe ohne Eintrag wird abgelehnt,
und zwar mit ihrem Namen im Fehlertext.

### `authRateLimit` steht bewusst NICHT an der Einlöse-Route

Der naheliegende Griff, und im Test gemessen falsch: `authRateLimit` deckelt 15 Aufrufe je
15 Minuten und IP und zählt **jeden** Aufruf, auch die erfolgreichen. Ein Konto hatte nach vier
eingelösten Codes und elf Rateversuchen die IP-Grenze erreicht und bekam „Zu viele Versuche – bitte
in ein paar Minuten erneut versuchen" – eine Meldung, die mit Bonuscodes nichts zu tun hat. **Beim
Login ist jeder Aufruf ein Versuch; hier ist ein Erfolg keiner.**

Die Sperre ist deshalb der **Fehlversuchs**-Zähler am Konto (`user.bonusVersuche`, 12/Tag). Er
zählt ausschließlich unbekannte Codes; ein gültiger, nur abgelaufener Code zählt **nicht** – der
Spieler hat nichts falsch gemacht (Prüfung 5a2). Nachgerechnet trägt das: acht Zeichen aus 36
ergeben 2,8 Billionen Kombinationen; bei zwölf Fehlversuchen je Konto und Tag wäre selbst mit
tausend Konten nichts zu holen. Der Grundschutz gegen bloßes Zuschütten bleibt
`globalApiRateLimit`.

### Vier Dinge, die man beim Anfassen wissen muss

- **Jede Ablehnung nennt den Grund** – abgelaufen, schon eingelöst, aufgebraucht, unbekannt. Ein
  pauschales „ungültig" macht aus einem abgelaufenen Code einen Fehlerbericht.
- **Normalisiert wird beim Vergleichen, nicht beim Speichern.** `bonuscodeNormal()` wirft alles
  außer `A-Z0-9` weg; wer „sternen-staub 25" tippt, hat den Code. Die Anzeigeform bleibt als
  `anzeige` erhalten, damit der Admin-Bereich den Code so zeigt, wie er gepostet wurde.
- **`maxGesamt` steht nicht im Auftrag und ist trotzdem drin.** Ein Code, der in einem fremden Forum
  landet, ist mit einer Wochenfrist allein nicht zu bremsen; 0 heißt unbegrenzt.
- **Die Belohnung geht über `pushPendingReward` mit eigenem `type:'bonuscode'`.** Ohne eigenen Typ
  fällt sie im Client in den Rückfall-Zweig und meldet dem Spieler wörtlich „Dankeschön vom Team:
  +500 Kredite für deinen Bug-Report!" – eine Falschaussage. Der Frontend-Zweig gehört also zwingend
  dazu (Prüfung 3b, Gegenprobe ohne den Typ fällt).

### Der Test ist das erste Admin-Vorbild im Repo

Vor `tests/test_bonuscodes_http.js` (Port 3230, 32 Prüfungen, **vier Gegenproben**) legte **kein
einziger** Test ein Admin-Konto an – `grep -rn "gamegeeeeek" tests/*.js` lieferte null Treffer, und
die zehn `/api/admin`-Routen waren von keiner Prüfung abgedeckt. Wer einen weiteren Admin-Test baut,
findet hier das Muster: Der Schlüssel in `db.users` muss **`gamegeeeeek` kleingeschrieben** sein –
`isAdmin` schlägt genau dort nach, ein Eintrag unter `GameGeeeeek` liefert false.

**Nebenbefund zu den Testports, gemessen:** Die Kopfkommentare zur Portbelegung sind in beide
Richtungen falsch – sie führen 3198, 3200 und 3225 als belegt, obwohl kein Test sie benutzt, und
haben zwei echte Doppelbelegungen nicht verhindert (3223 in `test_deploy_webhook_http` **und**
`test_passwortregeln_http`; 3224 in `test_alien_nester_http` **und** `test_sitzungscookie_http`).
Wer einen freien Port sucht, misst ihn selbst:
`grep -hoE "PORT *= *[0-9]+" tests/*.js | sort -un`.


## Push an den Betreiber, wenn ein neuer Spieler anfängt (22.08.2026)

**Auftrag Sascha:** „füge hinzu wenn sich neuer spieler anmeldet und spielt bekommt gamegeeeeek
eine push nachricht."

Der Auslöser ist der **erste Spielstand-Save** (`existing === undefined` bei `SAVE_KEY` in
`PUT /api/storage/:key`) — von Sascha gewählt aus drei vorgelegten, gemessenen Möglichkeiten
(erstes Öffnen / nach ~5 Min Spielzeit / bei echtem Fortschritt). Ebenso von ihm entschieden:
**eine Meldung je Neuling, sofort, ausdrücklich ohne Bündelung.**

### Warum dieser Punkt trägt — und warum die Registrierung ausschied

Beides gemessen, nicht angenommen:

- **Er liegt hinter der E-Mail-Bestätigung.** `/api/register` stellt bewusst kein Token aus,
  `/api/login` weist `emailVerified === false` mit 403 ab. An der Registrierung gehängt wäre die
  Meldung mit **1.440 Konten je Tag und IP** flutbar (`authRateLimit` = 15/15 Min, und es gibt
  weder Captcha noch E-Mail-Eindeutigkeit), ohne dass der Absender je eine Mail lesen müsste.
- **`existing === undefined` ist EINMALIG je Konto**, es braucht also keine Idempotenz-Marke:
  Gemessen gibt es keinen Pfad, der einen Spielstand löscht, und kein Fremdzugriff kann dem ersten
  Save zuvorkommen — `/api/attack` bricht mit 404 ab (`if (!attackerRaw || !targetRaw)`), wenn das
  Ziel keinen Spielstand hat. **Die Bedingung ist selbst die Marke.**

**Die ehrliche Grenze der Aussage steht im Meldungstext:** Der erste Save feuert automatisch beim
ersten Boot des Spiels („Neue Kolonie gestartet"), also Sekunden nach dem ersten Login. Die Meldung
sagt deshalb „hat die Kolonie zum ersten Mal geöffnet" und **nicht** „spielt".

### Der Abschalter ist die Notbremse, die die abgewählte Bündelung ersetzt

Die Kategorie `neuspieler` gibt es, **weil** Sascha die Bündelung abgelehnt hat. Gemessen hält das
Postfach **30 Einträge** (`list.unshift` + `slice(0, 30)`) ohne jede Bevorzugung — eine Flut
verdrängt zuerst `feedback-received` und `player-reported`, also den einzigen Meldungskanal, den
der Betreiber im Spiel hat. Der Schalter macht den Schaden abstellbar; er ersetzt keine Drosselung.

Damit ist diese Meldung die **erste** Betreiber-Push mit Kategorie: `feedback-received` und
`player-reported` rufen `pushNotificationEvent` ungefiltert auf. Das war bei zwei seltenen
Ereignissen vertretbar, bei einem minütlich auslösbaren nicht.

### Die Gesamtzahl zählt Spielstände, nicht Registrierungen

`payload.gesamt` ist `Object.keys(db.private).filter(uid => …[SAVE_KEY] !== undefined).length`.
`Object.keys(db.users).length` wäre die naheliegende und falsche Zahl: Zwischen Registrierung und
erstem Öffnen liegt die E-Mail-Bestätigung, ein Konto ohne Klick hat nie gespielt. Die Meldung
nennte sonst eine Zahl, die etwas anderes sagt als der Satz um sie herum.
`test_neuspieler_push_http.js` 1c misst das an einer Fixture mit drei Konten und zwei Spielständen.

### Der Wächter und die Falle, die er fangen musste

`tests/test_neuspieler_push_http.js` (Port 3231, 30 Prüfungen, **fünf Gegenproben** — jede mit
„was fallen MUSS"-Liste, identische Prüflisten in allen sechs Läufen).

**Abschnitt 6 ist der wichtigste, und der erste Entwurf konnte seine Falle prinzipiell nicht
fangen.** `pushNotificationEvent` schreibt den Postfach-Eintrag nur in den Arbeitsspeicher; steht
der Aufruf hinter dem `saveDb()` des Endpunkts, ist er beim nächsten Neustart weg — im Quelltext
sieht das völlig unauffällig aus, und genau dieser Fehler ist bei der Feedback-Push schon einmal
passiert. Mein Test stoppte den Server dafür mit **SIGTERM** und dem Kommentar, SIGKILL messe
„etwas anderes". Das war ungemessen und falsch: **Der Graceful Shutdown flusht die db und nimmt
genau den Eintrag mit, dessen Verlust gemessen werden soll.** Die Gegenprobe hat es als
`WERKZEUGFEHLER` gemeldet (Frontend-Regel 71) — ohne diese Wache wäre der Test mit einer Lücke
ausgeliefert worden, die genau den Anlassfall durchlässt.

Seit dem Umbau auf SIGKILL fällt die Sabotage „Aufruf hinter `saveDb()`" an `6a`. Und `6a3` ist die
Gegenkontrolle: Der **Spielstand** muss den harten Stopp ebenfalls überleben — sonst wäre `6a` auch
dann grün, wenn schlicht gar nichts gespeichert wurde.

**Die übertragbare Lehre, unabhängig von diesem Endpunkt: Ein Persistenz-Test, der mit einem
Graceful Shutdown stoppt, kann einen fehlenden `saveDb()`-Aufruf nicht fangen.** Wer misst, ob
etwas wirklich auf Platte steht, beendet den Prozess hart — sonst misst er die Aufräumroutine
statt der Schreibstelle.

### Auslieferungsreihenfolge: gleichgültig, aber beide zusammen

Anders als bei den Festungen (Frontend-Regel 60) entsteht keine stille Verschlechterung. Geht das
**Backend allein** live, schreibt es Postfach-Einträge, die das Spiel mit Glocke und dem Wort
„Ereignis" zeichnet — sichtbar unvollständig, nicht falsch. Geht das **Frontend allein** live, gibt
es einen Schalter für eine Kategorie, die nie feuert. Beides ist harmlos; die zwei PRs gehören
trotzdem zusammen gemerged, damit `test_pushkategorien.js` im Frontend-Repo nicht gegen die halbe
Wahrheit läuft (es hält Backend-Kategorien und Frontend-Schalter zusammen und fällt bei einer
Seite allein).

**Belegte Testports sind jetzt 3195–3231** — ein neuer Test nimmt 3232. Und beim Suchen eines
freien Ports gilt: `grep -hoE "3[12][0-9][0-9]" tests/*.js | sort -un`, nicht ein Muster auf
`PORT = <zahl>` — das übersieht die Form `Number(process.env.TEST_PORT || 3230)` und meldete
3230 fälschlich als frei.


## Vier neue Admin-Fähigkeiten (28.08.2026, Auftrag Sascha)

**Wortlaut:** „mehr adminfähigkeiten in admin bereich hinzu mache vorschläge." Vorgelegt wurden
sieben gemessene Lücken, gewählt hat Sascha vier: Feedback-Ansicht, Notabschaltung der PvE-Spawns,
Konto-Blatt mit Spielersuche, Deploy- und Konfig-Kachel.

**Was VORHER gemessen wurde, damit klar ist, was hier nicht das Problem war:** Der Admin-Bereich
hatte 13 Routen, und **alle 13 waren im Frontend verdrahtet**. Es fehlte keine Anzeigestelle zu
einer vorhandenen Route — es fehlten Fähigkeiten. Der erste `grep` sah das anders (`api/admin/`
fand nur 3 von 13) und war schlicht zu eng: `backendFetch` setzt das `/api`-Präfix selbst. Regel 32
in Reinform, hier an der eigenen Bestandsaufnahme.

### 1. Feedback: 500 Einträge, die niemand lesen konnte

`db.feedback` hält die letzten 500 Einsendungen und hatte **null Leser** — gemessen gab es nur
Schreibstellen. Der einzige Weg dorthin war die Resend-Mail plus eine Push-Meldung; wer die Mail
löscht oder `FEEDBACK_EMAIL` nicht gesetzt hat, kam nie wieder daran. Das ist dieselbe Sorte
Änderung wie `/api/admin/retention`: **keine neue Erfassung, nur eine neue Sicht.**

**`erledigt` ist eine MARKE, kein Löschen.** Die Liste rollt bei 500 ohnehin von selbst weiter; ein
abgehakter Eintrag bleibt nachlesbar, weil eine Idee von vor zwei Monaten beim nächsten Konzept
wieder interessant ist. `2c3` misst genau das — ohne diese Zeile wäre `2c` auch bei einer Route
grün, die den Eintrag entfernt.

**Der angehängte Screenshot ging bisher NUR als Mail-Anhang raus.** Eine Feedback-Ansicht ohne ihn
wäre die halbe Auskunft, gerade bei einem Fehlerbericht. **Die Route nimmt die Feedback-ID, nicht
den Dateinamen** — der Server schlägt `imageFile` im eigenen Bestand nach, ein Pfad-Ausbruch ist
damit *strukturell* unmöglich statt durch eine Prüfung abgefangen, die man beim nächsten Umbau
vergessen kann.

### 2. Die Notabschaltung, und warum sie nur in EINE Richtung geht

`FESTUNG_SPAWN_AKTIV`, `FESTUNG_BAUTEILE_AKTIV` und `NEST_SPAWN_AKTIV` nennen sich in ihren eigenen
Kommentaren dreimal „Notausschalter" — und brauchten bis hierher einen **Merge samt Deploy**, um
umgelegt zu werden. Das ist genau der Weg, der in diesem Dokument dreizehnmal als ausgefallen
dokumentiert ist; der letzte Ausfall lief fünf Tage unbemerkt. **Ein Notausschalter, der einen
funktionierenden Deploy voraussetzt, ist im Ernstfall keiner.**

**Der Admin kann nur ABSCHALTEN, nie einschalten.** Die Konstante bleibt die Grundstellung; steht
sie auf `false`, holt kein Knopf sie zurück (`POST /api/admin/schalter` lehnt das mit 400 ab). Der
Grund ist derselbe, aus dem es die Konstanten überhaupt gibt: Sie schützen davor, dass eine
Backend-Mechanik ohne ihr Frontend live geht und dem Spieler still eine Zahl verschiebt
(Frontend-Regel 60). Ein DB-Schalter, der etwas EINschalten könnte, hätte dieses Tor wieder
geöffnet — an einer Stelle, an der weder Merge noch Test dazwischenstehen.

**Der Zustand liegt in `db.notAus`** — einem eigenen Feld auf oberster Ebene, ausdrücklich **nicht**
in `db.shared` (dort schreibt jeder eingeloggte Nutzer, solange keine Sonderregel greift) und auch
nicht in `db.galaxy`: `galaxyFuerClient()` macht `Object.assign({}, g, …)` und reichte den
Schalterzustand damit ungefragt an **jeden** Client weiter. `db.bonusCodes` ist das Vorbild.

**Kein Neustart nötig, und das ist der Zweck:** `spawnAktiv()` liest bei jedem Aufruf frisch. Die
Funktionen sind bewusst `function`-Deklarationen (hochgezogen) und lesen die Konstanten erst im
RUMPF — ein Objektliteral mit direkten Verweisen wäre hier die temporale Todeszone, die den
Serverstart in diesem Repo schon einmal gekostet hat.

**Der Notaus stoppt den NACHSCHUB, er enteignet niemanden.** Drei Stellen laufen über
`spawnAktiv()` (`nestTick`, `festungSpawn`, das Anlegen der Bauteile), **zwei bewusst nicht**:

| Stelle | bleibt an der Konstante, weil |
|---|---|
| `/api/musterattack/create`, Nest-Zweig | Hinge der 404 am Schalter, stünden nach dem Abschalten **unangreifbare** Nester auf der Karte — und „es gibt derzeit keine Alien-Nester" wäre eine Falschaussage gegenüber einem Spieler, der eines vor sich sieht. |
| Die NPC-Stärke-Drift im `galaxyTick` | Sie wertet den **Bestand** aus, und der bleibt beim Notaus unverändert stehen. Sie mitzustoppen ließe `g.npcStaerkeZiel` auf einem Wert einfrieren, den niemand mehr anstrebt — das Frontend zeigte dann eine Weltlage an, die nicht mehr gilt. |

Beide tragen ihre Begründung im Code, sonst hält der Nächste sie für ein Versehen; `3d2`/`3d3`
prüfen die Richtung, `3d` die Gegenrichtung (Regel 33).

**Der Grund ist beim Abschalten Pflicht** und steht später in der Antwort. Eine Notabschaltung ohne
Begründung ist in zwei Wochen nicht mehr von einem Versehen zu unterscheiden — und dieses Dokument
sagt bei allen drei Schaltern ausdrücklich, dass ihr Grund „dann hierher gehört".

**Drei Felder statt eines an/aus**, und genau ihr Unterschied ist die Auskunft: `imCode` = was
ausgeliefert ist, `notAus` = was der Admin gesetzt hat, `wirksam` = was der Server jetzt tut. Ein
einzelnes Ja/Nein könnte nicht sagen, ob etwas abgeschaltet oder nie ausgeliefert wurde.

### 3. Konto-Blatt: Sperren ging nur über eine Meldung

`/api/admin/set-banned` nimmt seit jeher einen Namen entgegen — der Knopf dafür hing im Frontend
aber ausschließlich an einer **Meldungszeile**. Ohne vorliegende Meldung war ein Konto gar nicht
erreichbar, weder zum Sperren noch zum bloßen Nachsehen. Das Blatt zeigt jetzt, was der Server je
Konto ohnehin führt (Registrierung, E-Mail bestätigt, letzte Sitzung, Rang und Quelle, Sternenstaub,
Marktkontingent, eingelöste Codes, Fehlversuche, offene Belohnungen).

**Was NICHT drinsteht:** `passwordHash`, die E-Mail im Klartext und der Spielstand. Die Adresse wird
auf ihre Form reduziert (`a***@example.org`), weil die Frage im Betrieb „hat er eine und ist sie
bestätigt" lautet und nicht „wie lautet sie" — wer sie wirklich braucht, kommt an die `db.json`
ohnehin heran, aber sie fällt dann nicht nebenbei in einem Screenshot an. `4a3`/`4a4` messen das.

**„Alle Sitzungen beenden" für ein FREMDES Konto** hat bewusst keine Passwort-Abfrage: Der Admin
kennt das fremde Passwort per Konstruktion nicht, die Sperre ist `isAdmin()` selbst. Der Weg ist
sonst derselbe wie beim Spieler (`tokenVersion` hochzählen entwertet jedes ausgestellte Token).
Gemessen wird die **Wirkung** — das laufende Token des Ziels antwortet danach mit 401, das des
Admins weiterhin mit 200.

### 4. Systemstand: nie Werte, nur Ja/Nein

Die vier Deploy-Felder aus `/api/health` plus die Frage, die bisher nur ein SSH-Zugang beantworten
konnte: welche Konfiguration fehlt. **Es wird kein einziger Wert ausgegeben.** Der Compose-Stack
führt Resend-Schlüssel, Deploy-Secret und Ko-fi-Token im Klartext; ein Ja/Nein beantwortet „warum
kommt keine Alarm-Mail" vollständig, ohne etwas preiszugeben. `5b` misst das an einem Geheimnis, das
ausschließlich über die Umgebung in den Prozess kommt und in der ganzen Antwort nicht vorkommen darf.

Dazu drei abgeleitete Betriebszustände, die an keiner Env-Variablen hängen, sondern daran, ob etwas
WIRKLICH geladen ist: `BEKANNTE_PASSWOERTER.size` (die Doku sagt ausdrücklich, der Ausfall der Liste
dürfe „nicht wie Normalbetrieb aussehen" — als Zahl ist er sichtbar), die VAPID-Schlüssel und die
Deploy-Selbstheilung.

### Der Wächter und die vier Werkzeugfehler beim Bau

`tests/test_admin_funktionen_http.js` (Port 3234, **48 Prüfungen, sechs Gegenproben** — jede mit
ihrer „was fallen MUSS"-Liste, identische Prüflisten in allen sieben Läufen, per `diff` über die
reinen Prüfnamen verglichen statt gezählt). **Belegte Testports sind jetzt 3195–3234** — ein neuer
Test nimmt 3235.

| Sabotage | fällt |
|---|---|
| Notaus-Wache raus (`spawnAktiv` ignoriert `db.notAus`) | `3c-vorab`, `3c2`, `3e2` |
| E-Mail roh statt in Form | `4a3` |
| Systemstand gibt Werte statt Ja/Nein | `5b`, `5b2` |
| Erledigt-Marke nur im RAM (kein `saveDb`) | `2d`, `5d2` |
| Konto-Route ohne `isAdmin`-Wache | `1a` |
| Bild-Route nimmt den Dateinamen statt der ID | `2e`, `2e3` |

**Die Kernmessung ist `3c`/`3c2` als PAAR:** Der Notaus wird nicht am gemeldeten Feld `wirksam`
gemessen (das wäre das Etikett, Regel 61), sondern an der Wirkung — ein fälliges Nest reift beim
Serverstart, und mit gesetztem Notaus reift dasselbe Nest nicht. Ohne die erste Hälfte wäre auch ein
Schalter grün, der gar nichts tut.

**Vier Werkzeugfehler, jeder eine im Repo dokumentierte Familie:**

1. **`2d` stoppte mit SIGTERM — und konnte damit einen fehlenden `saveDb()` prinzipiell nicht
   fangen.** Der Graceful Shutdown flusht die im Speicher gehaltene `db` und schreibt genau den
   Eintrag mit, dessen Verlust gemessen werden soll. Gemeldet hat es allein die Pflichtliste der
   Gegenprobe: 48 von 48 grün bei sabotiertem Code. Das ist wörtlich die Lehre aus
   `test_neuspieler_push_http` vom 22.08.2026, sechs Tage alt und beim Bauen trotzdem verletzt.
   Seit dem Umbau auf SIGKILL fällt `2d`; `2d2` ist die Gegenkontrolle (der Bestand selbst muss den
   harten Stopp ebenfalls überleben — sonst wäre `2d` auch grün, wenn gar nichts gespeichert wurde).
2. **`2e3` prüfte einen Pfad-Ausbruch gegen eine Datei, die es nicht gab** (`../../server.js` lag
   außerhalb des Testverzeichnisses). Die Prüfung hätte auch bei einer völlig ungeschützten Route
   404 gemeldet. Sie zielt jetzt auf `../jwt.txt` — eine Datei, die der Test selbst anlegt und
   deren Existenz `2e3-vorab` belegt; mit der Sabotage kommt dort 200 samt Inhalt.
3. **Zwei Pflichtlisten waren zu eng**, und die Messung hat sie korrigiert: Die `saveDb`-Sabotage
   reißt auch `5d2` (der Bestandszähler liest denselben Wert), und `2e2` *kann* von der Bild-Sabotage
   gar nicht fallen. **Eine Pflichtliste ist selbst eine Behauptung, bis die Gegenprobe sie gemessen
   hat** — dieselbe Lehre wie bei `test_urmaterie_boden_http` und `test_chat_buendel_http`.
4. **Mein Zähler zählte die Schlusszeile mit** (`FAIL - es gab rote Pruefungen.` passt auf
   `^(OK|FAIL) +- `) und verglich Kürzel gegen Volltext — Regel 60, hier zum dritten Mal. Verglichen
   werden jetzt die reinen Prüf-NAMEN.

**Und ein fünfter, der nicht den Test betraf:** Ein `pkill -f "test_admin_funktionen"` traf die
eigene Shell (Exit 144) — wörtlich Arbeitsregel 15, die seit dem 06.08.2026 samt Exit-Code in diesem
Projekt steht. Prozesse werden über `ps` identifiziert und einzeln per PID beendet.

**Zwei geratene Feldnamen hat der erste Entwurf getragen** und der Abgleich gegen die Datei gefangen:
`staub.stand` heißt `staub.menge`, `bonusVersuche.anzahl` heißt `.n`, und `supporterStatusCombined`
liefert `granted`, kein `source`. `node --check` hätte keinen davon gemeldet — die Anzeige hätte
still Nullen gezeigt.

### Auslieferungsreihenfolge: dieses Repo ZUERST

Das Frontend braucht die sechs neuen Routen; ein Reiter, dessen Route mit 404 antwortet, wäre genau
die tote Fläche, gegen die Frontend-Regel 35 geschrieben ist. Umgekehrt stellt dieses Backend
Routen bereit, die noch niemand aufruft — folgenlos. Die Betroffenheit der Bestandstests ist
gemessen: `test_festung_http` (35), `test_festung_bauteile_http` (28), `test_alien_nester_http` (40),
`test_npc_staerke_http` (14) und `test_muster_nest_http` (22) laufen unverändert grün; die drei, die
eine **Kopie** von `server.js` mit umgelegtem Schalter starten, greifen weiterhin, weil die
Konstanten unverändert dastehen.


## Aktivitäts-Uhr und Reaktionszeit (28.08.2026, Auftrag Sascha)

**Wortlaut:** „Da ist ein Spieler, der ist wirklich Tag und Nacht online. Kann man das irgendwie
nachvollziehen, ob das wirklich ein Spieler ist oder irgendwie Bot oder KI oder whatever
dahintersteckt?" Vorgelegt wurden vier Wege, gewählt hat Sascha **beide Messungen zusammen**.

### Der Befund, der zuerst gehört: „immer online" ist hier KEIN Verdacht

Das Offline-Fenster ist im Frontend **8 Stunden Basis** (`OFFLINE_BASE_SEC`), mit vollem
Autonomiekern höchstens **14**. Wer den Tab schließt und 24 h wegbleibt, verliert zehn Stunden
Produktion ersatzlos; wer ihn offen lässt, verliert nichts — und der Autosave schreibt dabei alle
10 Sekunden (`setInterval(save, 10000)`). **Den Tab durchlaufen zu lassen ist damit das rational
richtige Verhalten, das das Spiel selbst belohnt.** Ein `lastSeen` rund um die Uhr misst nur, ob
jemand einen Browser-Tab schließt.

Dazu kommt die Projektgrenze: Der Spielstand ist klientenautoritativ. Wer sich bereichern will,
braucht **keinen Bot** — er schreibt sich die Zahlen hin. Ein Bot lohnt sich nur dort, wo der
Server rechnet: Angriffe, Festungs- und Nest-Schläge, Anfechtungen, Markt. Also genau dort, wo er
**anderen** etwas wegnimmt.

### Die Uhr zählt HANDLUNGEN, nicht Anwesenheit

`user.aktiv` ist je Tag eine 24-Bit-Zahl (Bit n = Stunde n UTC), 14 Tage, rund 30 Byte je Konto.
Gefüllt wird sie in **`authMiddleware`**, unmittelbar vor `next()` — dort ist die Sitzung
vollständig geprüft und `user` ohnehin geladen. Ein abgewiesener Aufruf ist keine Handlung.

**Warum dort und nicht an einer Liste von Routen:** Eine Positivliste findet nur, woran man beim
Schreiben gedacht hat (Frontend-Regel 40) — eine neue Angriffsroute wäre still nicht dabei. Die
Regel ist deshalb umgedreht: Gezählt wird **jede Nicht-GET-Anfrage**, außer den wenigen, die der
Client von selbst feuert.

**`AKTIV_AUSNAHMEN` ist GEMESSEN, nicht aus dem Quelltext geraten.** Das Spiel lief im Browser 90
und 240 Sekunden ohne eine einzige Bedienung, mit Handelsrouten und Allianz im Spielstand. Von
selbst feuern genau drei Dinge:

| | in 240 s | |
|---|---|---|
| `PUT /api/storage/*` | 27× | Autosave, alle ~9 s |
| `POST /api/pending-rewards/claim` | **17×** | alle ~14 s — **nicht** nur beim Start, wie die Doku sagte |
| `POST /api/reminders` | 1× | beim Boot |

Die mittlere Zeile hätte ich nie erraten. **Wer hier eine Automatik ergänzt, misst sie genauso
nach** — der Messlauf steht als Muster in der Sitzung, und `test_aktivitaetsuhr_http.js` 1c hält
die Form der Liste fest.

**`/api/analytics/event` steht bewusst NICHT in der Uhr**, obwohl es nur bei Bedienung feuert: Es
ist klientengemeldet und damit fälschbar. Ein Bot, der es unterschlägt, sähe untätig aus; einer,
der es schickt, menschlich — es trägt in keiner Richtung etwas bei. Die Uhr zeigt nur, was der
Server SELBST ausgeführt hat (dieselbe Grenze wie beim Sternenstaub).

**Gespeichert wird nicht eigens.** Wie die Analytics läuft die Uhr im Speicher mit und wird vom
nächsten ohnehin anfallenden `saveDb()` mitgenommen; die zählenden Routen speichern ohnehin. Ein
harter Absturz kann die letzte Stunde kosten — verschmerzbar, und es steht im Code, damit niemand
die Uhr für lückenlos hält.

### Die Reihe ist an KALENDERTAGEN ausgerichtet, nicht an „vor N Stunden"

Das ist der Unterschied zwischen einem lesbaren Bild und einem unlesbaren, und er fiel erst beim
Zeichnen auf: Eine Reihe, die bei der aktuellen Stunde endet, ist gegen die Stundenachse
verschoben — im Raster läge die Nacht jeden Tag in einer anderen Spalte, und ein Schlafmuster wäre
keine senkrechte Bahn mehr, sondern eine Diagonale. Spalte 0 ist deshalb immer 00:00 UTC.

**Drei Zeichen statt zweier:** `1` aktiv, `0` beobachtet und ruhig, `-` **nicht beobachtet** (vor
der ersten Aufzeichnung oder noch in der Zukunft). Ohne das dritte zählten die Stunden des heutigen
Tages, die noch gar nicht stattgefunden haben, als Pause — ein lückenloser Dauerläufer sähe am
Abend wie ein schlafender Mensch aus. `test_aktivitaetsuhr_http.js` 2c2 hält das fest; die
Gegenprobe ohne das dritte Zeichen reißt `2b2` und `2c2`.

### Die Auswertung beginnt bei der ERSTEN aufgezeichneten Stunde

`aktivAuswerten()` ist die eine Stelle, die „wie lange war Ruhe" beantwortet — im Frontend noch
einmal zu rechnen wäre die übliche zweite Wahrheit. Sie rechnet ausdrücklich erst ab der ersten
aktiven Stunde: Die Uhr fängt mit ihrer Auslieferung an zu schreiben, ohne diesen Anfang zählten
die Jahre davor als eine gewaltige Pause und **jedes** Konto sähe menschlich aus (Frontend-Regel
28). Unter 24 beobachteten Stunden meldet `belastbar: false`.

**Die aussagekräftige Zahl ist die längste Pause, nicht die Gesamtzahl.** An vier nachgebauten
Konten gemessen: Bot 72/72 mit **0 h**, ein Spieler mit nächtlichem Aufwachen 3 h, ein Vielspieler
5 h, ein Gelegenheitsspieler 14 h. Erst eine Pause nahe null über viele Tage ist nicht mehr
menschlich erklärbar — und selbst dann bleiben zwei harmlose Erklärungen, die in den Text gehören:
ein **geteiltes Konto** und ein Konto auf **zwei Geräten in verschiedenen Zeitzonen**. Die Uhr ist
ein Hinweis, kein Beweis.

### Die Reaktionszeit misst, was die Uhr nicht kann

Festung und Nest tragen ihren Entstehungszeitpunkt (`seit`) längst. Wie lange es danach dauert,
bis ein Konto zum **ersten** Mal zuschlägt, ist die zweite Kennzahl: Ein Mensch muss das Ereignis
erst bemerken, also die Karte öffnen; wer regelmäßig binnen Sekunden da ist, fragt im Takt ab.
Aussagekraft liegt in der **Wiederholung**, deshalb ein Ringpuffer über zehn Werte.

Vermerkt wird **nur beim ersten Schlag** (`letzter === 0`) und **nur beim Einzelangriff** — beim
Verband steht die Flotte seit dem Beitritt fest, der Auslösezeitpunkt sagt über den Auslöser
nichts. Deshalb steht die Zeile im Endpunkt und nicht im gemeinsamen Kern `nestSchlagAusfuehren`,
den beide Wege benutzen.

### Der Wächter und die vier Fehler beim Bau

`tests/test_aktivitaetsuhr_http.js` (Port 3236, 26 Prüfungen, **sechs Gegenproben** — jede mit
ihrer Soll-Liste, identische Prüflisten in allen sechs Läufen). **Belegte Testports sind jetzt
3195–3200 und 3210–3236** — ein neuer Test nimmt 3237.

**Die Kernmessung ist 1a/1b als PAAR:** Eine Bedienhandlung muss ein Bit setzen UND der Autosave
darf keines setzen. Jede Hälfte allein ist wertlos — `1a` wäre auch bei einer Uhr grün, die bei
jeder Anfrage tickt (also 24/7 anzeigt und nichts unterscheidet), `1b` auch bei einer, die nie
tickt.

| Sabotage | fällt |
|---|---|
| Ausnahmeliste ignoriert (Uhr zählt alles) | `1b` |
| Uhr zählt nichts | `1a`, `5a` |
| Auswertung beginnt bei Index 0 | `2b`, `2b2` |
| Reaktionszeit ohne `!letzter` | `3b`, `4a` |
| Zukunftsstunden zählen als Pause | `2b2`, `2c2` |
| Aufräumen entfernt | `5a` |

**Drei Fehler steckten im Test, nicht im Code**, und alle drei sind lehrreich:

1. **Die Fixture deckte 14 KALENDERTAGE ab, die Reihe braucht 15.** 14×24 Stunden zurück beginnt
   mitten im fünfzehnten Tag; gemessen kamen 333 statt 336 aktive Stunden heraus — ein
   Fixture-Fehler, der wie ein Rechenfehler in der Auswertung aussah.
2. **`3b` hat seine eigene Bedingung zerstört.** Um die Abklingzeit zu umgehen, leerte der erste
   Anlauf `festung.schlaege` — damit ist `letzter` wieder 0, und es war aus Sicht des Servers
   völlig korrekt ein *erster* Schlag. Der Test fiel auf richtigem Code durch. Der Stempel wird
   seither **zurückdatiert** statt entfernt: Abklingzeit abgelaufen, `letzter` trotzdem gesetzt —
   genau die Lage, die im Spiel entsteht.
3. **Die sabotierte Kopie lag in `tests/`.** Dort löst `require('./mailer')` nicht auf; alle fünf
   Gegenproben liefen mit **0 Prüfungen** und sahen wie bestandene Proben aus (Regel 34). Gefangen
   hat es allein die Soll-Liste (Regel 71) — der Kommentar im Test sagt seither ausdrücklich, dass
   die Kopie ins Repo-Verzeichnis gehört.

**Ein vierter Fehler steckte in einer PFLICHTLISTE, nicht im Test:** Für die Sabotage
„Zukunftsstunden zählen als Pause" hatte ich `2c` als fallend vorhergesagt. Gemessen fällt es
nicht — das Konto in `2c` ist auch in den Zukunftsstunden lückenlos, `aktiv === beobachtet` bleibt
also wahr. **Eine Pflichtliste ist selbst eine Behauptung, bis die Gegenprobe sie gemessen hat**
(dieselbe Lehre wie bei `test_urmaterie_boden_http` und `test_chat_buendel_http`).

**Und ein fünfter im Mess-Skript, zum wiederholten Mal derselbe:** Der Prüfnamen-Vergleich zählte
die Schlusszeile `FAIL - es gab rote Pruefungen.` als Prüfung „es" mit und meldete fünf
Werkzeugfehler, wo keiner war (Frontend-Regel 60). Prüfnamen tragen einen Doppelpunkt, die
Schlusszeile nicht — daran trennt der Vergleich sie jetzt.

**`KEPLER_SERVER_JS` leitet den Test auf eine Kopie um** (Start UND Quelltext-Lesung, sonst wäre er
halb umgeleitet und sagte trotzdem nichts). Dass die Umleitung greift, ist belegt: gegen eine leere
Datei bricht der Lauf ab, statt still das Original zu messen.

### Auslieferungsreihenfolge: dieses Repo ZUERST

Das Konto-Blatt im Frontend liest `aktiv` und `reaktionen` — Felder, die nur der neue Server
schickt. Umgekehrt schreibt dieses Backend Felder, die noch niemand liest: folgenlos.



## Vier Erweiterungen der Uhr: Übersicht, Rate-Limit, Geschenk, abgelehnte Spielstände (01.09.2026, Auftrag Sascha)

**Wortlaut:** „Funktionen weiter ausbauen mache virschläge." Vorgelegt wurden sieben gemessene
Lücken, gewählt hat Sascha **alle vier** vorgeschlagenen: Übersicht aller Konten nach
Auffälligkeit, Rate-Limit-Treffer je Konto, Geschenk an alle Spieler, abgelehnte Spielstände im
Admin-Bereich. Die Verdachts-Push an den Betreiber ist Teil der Übersicht – sie macht aus einer
Fläche, die man aufrufen muss, eine Meldung, die kommt.

### Abgelehnte Spielstände: die EINE Stelle, an der der abgelehnte Spieler nie speichert

Eine Ablehnung ist für den Spieler faktisch kompletter Speicherverlust (Vorfall 21.07.2026,
stundenlange Fehlersuche) und stand bis hierher **ausschließlich im Container-Log** – das niemand
liest und das mit jedem Neustart weg ist. `saveAblehnungVermerken()` schreibt `user.saveAblehnungen`
(Zähler, letzter Grund, die fünf letzten Gründe mit Zeit) am Nutzerobjekt, nicht im Spielstand: Der
ist ja gerade der, den der Server nicht annimmt.

**Die Ablehnungsstelle ruft ausdrücklich `await saveDb()`**, anders als die Uhr und der
Rate-Limit-Zähler. Es ist der eine Fall, in dem der betroffene Spieler selbst **nie** ein saveDb
auslöst – jeder seiner Saves wird ja abgelehnt –, der Vermerk hinge sonst an fremden
Schreibvorgängen. `test_admin_uhr_erweiterungen_http` 1c misst das mit **SIGKILL** (Regel 78: ein
SIGTERM schriebe den Eintrag selbst mit); die Gegenprobe ohne saveDb reißt 1c, 1d und 1e.

### Rate-Limit-Treffer je Konto: das Token wird im 429-Fall eigens geprüft

`app.use('/api', globalApiRateLimit)` läuft **vor** `authMiddleware` – an der Stelle, an der der
429 entsteht, gibt es kein `req.userId`. `rateLimitTrefferVermerken(req)` prüft das Token deshalb
selbst (Bearer oder Cookie, `jwt.verify` in try/catch) und **nur im 429-Fall**: Ein Treffer ist
selten, und ein jwt.verify je Treffer kostet nichts, was der Flooder nicht ohnehin verursacht. Ein
ungültiges oder fehlendes Token wird still übergangen – der 429 gilt der Verbindung, nicht dem
Konto (2c misst: eine Flut ohne Sitzung landet an keinem Konto). Tageszähler am UTC-Tag wie
`user.marktTag`, dazu Gesamtzähler, Zeit und Pfad des letzten Treffers.

### Die Verdachtsregel liegt an EINER Stelle – und die Push kennt eine Meldepause

`verdachtBewerten(auswertung)` ist die eine Definition von „auffällig": belastbar, **mindestens
168 beobachtete Stunden** und längste Pause ≤ 2 h. Die Zahlen kommen aus der Kalibrierung der Uhr
(Bot 0 h, nächtlich aufwachender Spieler 3 h, Vielspieler 5 h) – zwei Stunden liegen unter dem
menschlichsten Dauerspieler der Messung, und die Woche verhindert, dass ein einzelner Marathon-Tag
auslöst. `3b2` hält die Wochenregel fest: **drei** Tage lückenlos sind kein Verdacht; die Gegenprobe
ohne sie reißt 3b2, 4a, 4a2 und 4e.

`verdachtTick()` läuft im `galaxyTick` (alle 15 Minuten, und beim Start über `setImmediate`) und
meldet an das Betreiberkonto über die **abschaltbare** Kategorie `verdacht` (Ereignistyp
`konto-verdacht`, an allen fünf Stellen wie `neuspieler`: getNotifPrefs, POST notification-prefs,
pushNotificationText, notificationTarget, Sender). **Eine Meldung je Konto und Woche**
(`user.verdachtGemeldet`, vor dem saveDb des Takts gesetzt) – ohne die Pause käme jeden Takt
dieselbe Meldung. Der Push-Text nennt die zwei harmlosen Erklärungen mit (geteiltes Konto, zwei
Geräte in verschiedenen Zeitzonen): Eine Push, die nur „Bot?" sagt, macht aus einem Hinweis einen
Beweis.

`GET /api/admin/aktivitaet` liefert alle Konten mit Spielstand, sortiert nach längster Pause
aufsteigend, belastbare zuerst, mit der 336-Zeichen-Stundenreihe je Zeile (bei hundert Konten
34 kB – auf einer Fläche, die genau ein Konto sieht), Deckel 200.

### Geschenk an alle: dieselben Deckel wie der Bonuscode, eigener `type`

`POST /api/admin/geschenk` legt jedem Konto **mit Spielstand** (ohne gesperrte) eine Belohnung
`{ type:'geschenk', text, zeit, …gaben }` über `pushPendingReward` ins Fach – die Gaben flach wie
beim Bonuscode, damit der Frontend-Zweig dieselben Felder lesen kann. Geprüft über
**`bonuscodeGabenPruefen`**, also `BONUSCODE_GABEN`: Ein Tippfehler (1000000 statt 1000) wäre hier
ein Wirtschaftsereignis für jedes Konto auf einmal, und ein zu großer Wert risse beim Beschenkten
`SAVE_SANITY_LIMITS`. `nurAktiveTage` (0 = alle) grenzt auf Konten ein, die sich binnen N Tagen
angemeldet haben – das Belohnungsfach hält zwanzig Einträge, ein Geschenk an ein seit Monaten
stilles Konto verdrängte dort im Grenzfall etwas Wertvolleres. **Ein nie angemeldetes Konto ist
dabei nicht aktiv** (5f/5f2: carl nach 40 Tagen und dora ohne jede Anmeldung fallen heraus –
die erste Fassung der Prüfung hatte dora vergessen und war rot). Der Verlauf liegt in
`db.geschenke` (letzte 20), `GET /api/admin/geschenke` nennt ihn samt Deckel-Tabelle.

**Der eigene `type` ist Pflicht, nicht Kosmetik** – dieselbe Lehre wie beim Bonuscode: Ohne ihn
fällt die Belohnung im Client in den Rückfall-Zweig „+500 Kredite für deinen Bug-Report".

### Der Wächter

`tests/test_admin_uhr_erweiterungen_http.js` (**Port 3238**, 38 Prüfungen, sieben Gegenproben mit
Pflichtlisten, alle mit 38 Prüfungen in beide Richtungen und identischer Prüfliste per `diff`).
**Belegte Testports sind jetzt 3195–3200 und 3210–3238** – ein neuer Test nimmt 3239.

Die vier Kernmessungen sind Paare (Regel 61): Ablehnung vermerkt UND gültiger Save geht durch
(1a/1e), Flooder gezählt UND Nicht-Flooder nicht (2a/2b), acht Tage lückenlos ist Verdacht UND
drei Tage sind keiner (3b/3b2), Push nennt anna UND nicht ben (4a/4a2).

| Sabotage | fällt |
|---|---|
| Save-Reject ohne saveDb | `1c`, `1d`, `1e` |
| 429 nicht vermerkt | `2a`, `2c`, `2d` |
| verdachtTick nicht im galaxyTick | `4a`, `4b`, `4c2`, `4d` |
| Wochenregel entfernt | `3b2`, `4a`, `4a2`, `4e` |
| Meldepause entfernt | `4a`, `4b` |
| Geschenk-Deckel entfernt | `5c`, `5d`, `5e`, `5g` |
| Geschenk ohne saveDb vor der Antwort | `5b`, `5f2`, `5g`, `5j` |

**Vier der sieben Pflichtlisten waren beim ersten Entwurf zu eng** (1d/1e, 4a, 5g, 5f2/5g/5j fielen
zusätzlich) – eine Pflichtliste ist selbst eine Behauptung, bis die Gegenprobe sie gemessen hat
(dieselbe Lehre wie bei `test_urmaterie_boden_http` und `test_aktivitaetsuhr_http`). Und eine
Erwartung war falsch, nicht der Code: 5f rechnete mit einem Empfänger zu viel, weil das im Test
nachträglich angelegte Konto sich nie angemeldet hatte – der Filter hatte recht.

### Auslieferungsreihenfolge: dieses Repo ZUERST

Das Frontend liest `rateLimitTreffer`, `spielstandAbgelehnt`, `aktiv.verdacht` und ruft die drei
neuen Routen; ein Reiter, dessen Route mit 404 antwortet, wäre die tote Fläche aus Frontend-Regel 35.
Umgekehrt stellt dieses Backend Routen bereit, die niemand aufruft – folgenlos. Die Betroffenheit der
Bestandstests ist gemessen: 14 Backend-Tests, die Rate-Limit, Save-Ablehnung, Benachrichtigungen,
galaxyTick oder den Admin-Bereich berühren, laufen unverändert grün (`test_pvp_standorte_http` ist
ein von Hand zu startender Test und zählt hier nicht).


### Vierter Notaus-Schalter: `konvois` (02.09.2026)

Beim Umlegen von `A2_SPAWN_AKTIV` gemessen: `A2Tick` las die **blanke Konstante**, nicht
`spawnAktiv()` – der Admin-Notaus erreichte die Wrackkonvois nicht, obwohl `CLAUDE.md` den Schalter
als admin-abschaltbar führte. Seither steht `konvois` in `NOTAUS_NAMEN` („Wrackkonvois entstehen,
driften und entkommen"), `spawnAktivImCode('konvois')` liefert die Konstante, und `A2Tick` läuft
über `spawnAktiv('konvois')` – der ganze Takt, wie bei `nestTick`; der Angriffs-Endpunkt hängt nicht
am Schalter, bestehende Ziele bleiben angreifbar. Die Admin-Fläche im Frontend rendert die Liste
datengetrieben aus `GET /api/admin/schalter`, der vierte Eintrag erscheint dort ohne Frontend-Änderung.
Wächter: `test_admin_funktionen_http.js` 3a (vier Schalter) und 3d (vier Aufrufstellen).
Einzelheiten zu A2 in `docs/wrackkonvois.md`.
