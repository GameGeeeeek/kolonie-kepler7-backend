# CLAUDE.md – kolonie-kepler7-backend

Node.js/Express-Backend für Kolonie Kepler-7. Läuft als Docker-Container `kepler7-backend` auf einem Raspberry Pi 4 (CasaOS). Einfache JSON-Datei als "Datenbank" (`db.json`), kein echtes DBMS.

## Was sich am 28.08.2026 geändert hat – für parallel arbeitende Sitzungen

Wer dieses Repo aus einer anderen Sitzung anfasst, braucht davon vier Sätze. Die Begründungen und
alle Messungen stehen unten unter „nodemon fliegt aus dem Deploy-Pfad".

1. **Der Deploy blockiert sich nicht mehr selbst. Merge, wann du willst.** Dreizehn Ausfälle hatten
   dieselbe Ursache: `git pull` schrieb `server.js`, nodemon startete daraufhin neu und räumte den
   laufenden git-Prozess mit ab, bevor er den Ref gesetzt hatte. Der Container läuft seither **ohne
   nodemon**; der Server beendet sich nach einem erfolgreichen Pull selbst, Docker startet ihn neu.
   Zwei gleichzeitige Webhooks fängt die Sperre aus #147 ab (der zweite wird vorgemerkt und
   nachgeholt). **Die Parallelität war nie die Ursache** – sie hat die Häufigkeit erhöht.
2. **Ein Code-Deploy kostet rund 7 Sekunden 502**, gemessen im Sekundentakt. Ein Commit ohne
   `.js`/`.json`-Änderung startet gar nichts neu – dann laufen `commit` und `checkout` in
   `/api/health` auseinander, und das ist KORREKT, keine Störung.
3. **`/api/health` hat ein Feld `selbstNeustart`.** Damit ist von außen erkennbar, ob der Container
   umgebaut ist; vorher brauchte diese Frage einen SSH-Zugang. Die vier Felder zusammen
   (`commit`, `checkout`, `blob`, `selbstNeustart`) beantworten jede Deploy-Frage ohne den Pi.
4. **Wer auf dem Pi von Hand an `server.js` etwas ausprobiert, bekommt keinen Neustart mehr
   geschenkt** – `docker restart kepler7-backend`. Und eine Handänderung dort blockiert weiterhin
   jeden Pull, bis sie zurückgenommen ist.

**Der Compose-Stack liegt in Portainer**, nicht auf dem Host: `big-bear-portainer:/data/compose/6/`.
Er enthält **Geheimnisse im Klartext** (Resend-Schlüssel, Deploy-Webhook-Secret, Ko-fi-Token) – sie
gehören in kein Repo, keinen Fehlerbericht und keinen Chat-Verlauf.

## Kritische Regel: DB_FILE nie hart pfaden

```js
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');
```
Gilt für **jedes** Skript, auch neue Standalone-Skripte (wie `thank_bugreporter.js`, `send_patchnotes.js`, `reset_alliance_progress.js`). Im Container ist `DB_FILE=/data/db.json` gesetzt – das Arbeitsverzeichnis ist NICHT `/data`. Dasselbe gilt für `VAPID_PUBLIC_FILE`/`VAPID_PRIVATE_FILE`.

## Vor jedem Commit (Pflicht)

1. `node --check server.js`
2. **`node tests/test_serverstart.js`** – drei Sekunden, und sie schließen die Lücke, die Punkt 1
   offenlässt: `node --check` **parst nur und führt nie aus**. Am 18.08.2026 hat genau das einen
   Absturz durchgelassen, der den Server bei JEDEM Start getötet hätte (Einzelheiten unten unter
   „Die temporale Todeszone…"). Ein Backend, das nicht startet, ist der teuerste denkbare Fehler
   dieses Projekts – der Merge ist die Auslieferung, und der Server startet sich Sekunden später
   selbst neu (seit dem 28.08.2026; vorher tat das nodemon).
3. Bei sicherheitsrelevanten Änderungen an geteiltem Speicher (`alliance:*`-Schlüssel, Markt, o.ä.): **echte HTTP-Tests**, nicht nur Syntax-Check. Test-DB in `/tmp` aufsetzen (bcrypt-Hash für Testnutzer, `crypto.randomUUID()` für IDs), Server mit `DB_FILE=/tmp/...` lokal starten, curl-Requests gegen echte Endpunkte. **Serverstart und Test müssen im selben Bash-Aufruf laufen** – über mehrere Tool-Aufrufe hinweg verliert die Sandbox den Hintergrundprozess.
4. Testartefakte (`/tmp/...`, `package.json`/`package-lock.json` falls nur für den Test installiert) vor dem Commit wieder entfernen. `node_modules` steht in `.gitignore` und darf liegen bleiben.

### Die temporale Todeszone: `node --check` sieht sie NICHT (18.08.2026)

`galaxyTick()` wurde bei Zeile 5526 einmal **mitten in der Modulauswertung** aufgerufen, damit nach
einem Neustart nicht 15 Minuten auf den ersten Galaxie-Zustand gewartet werden muss. Der Rumpf
dieser Funktion sieht damit jede `const`, die weiter unten in der Datei steht, in ihrer temporalen
Todeszone. Beim Einbau von `FESTUNG_SPAWN_CHANCE` (Zeile 7908) war die Folge:

```
ReferenceError: Cannot access 'FESTUNG_SPAWN_CHANCE' before initialization
    at galaxyTick (server.js:5364:23)
    at Object.<anonymous> (server.js:5526:1)
```

Bei **jedem** Start, nicht nur in 8 % der Fälle – der rechte Operand eines `<` wird immer
ausgewertet. `node --check` war grün.

**Behoben strukturell, nicht punktuell:** Der Startlauf liegt jetzt in `setImmediate(galaxyTick)`.
Er feuert, sobald die Modulauswertung fertig ist – also Millisekunden später, die Absicht bleibt
vollständig erhalten, und die ganze Fehlerklasse ist für **jede künftige Konstante** miterledigt.
Vorher nachgesehen: Nach dieser Zeile stehen nur noch Funktions-, Konstanten- und
Routendefinitionen, nichts, was den Takt vorher gelaufen sehen müsste.

Das ist dieselbe Familie wie Arbeitsregel 38 der Frontend-CLAUDE.md (dort für Array-Literale wie
`CREDIT_SHOP`/`HELP_SECTIONS`, die beim Laden ausgewertet werden). **Die übertragbare Regel: Ein
Syntax-Check ist kein Startversuch.** Wer eine Konstante einführt und irgendwo oben in der Datei
benutzt, muss den Server einmal wirklich hochfahren – `tests/test_serverstart.js` tut genau das.

**Vorhandene Tests liegen unter `tests/`** und werden von Hand gestartet (`npm install` vorher, danach `node_modules` wieder löschen): `bash tests/chatpush.sh` prüft die Chat-Push-Kette Ende zu Ende gegen einen echten, lokal gestarteten Server. Sie sind bewusst **im Repo** und nicht im Sitzungs-Scratchpad – dort wären sie mit dem Container weg, und genau so stand das Frontend bis zum 25.07.2026 ohne einen einzigen Test da. Ein neuer Backend-Test gehört ebenfalls hierher.

Zwei Fallen, die beim Schreiben von `tests/chatpush.sh` je einen Anlauf gekostet haben und die jeder neue Test vermeiden sollte: Ein Schreibvorgang landet nur mit **`?shared=true`** im geteilten Speicher (ohne den Parameter schreibt dieselbe Route in den privaten Bereich, `handleSharedStorageWrite` läuft dann gar nicht erst) – und **JSON-in-JSON nicht von Hand in der Shell zusammenbauen**, sondern die Nutzlast mit `node -e` erzeugen und per `--data-binary @-` übergeben; vier Ebenen Anführungszeichen erzeugen sonst genau die Fehler, die man dem Server anlastet.

## Architektur

- `db.shared` – generischer Key-Value-Speicher für alles Multiplayer-Relevante (Allianzen, Markt, Weltboss-Beiträge). Frontend schreibt direkt über `GET/PUT /api/storage/:key`.
- `POST /api/kofi-webhook` / `GET /api/kofi-top-supporter` – Ko-fi-Spenden-Integration (13.07.2026): zeigt den aktuellen Top-Unterstützer im Spiel. Braucht `KOFI_VERIFICATION_TOKEN` (aus ko-fi.com/manage/webhooks, Bereich "Advanced") als Env-Var auf dem Pi, sonst wird jeder Webhook-Aufruf verworfen. Anonyme Spenden (`is_public:false`) fließen NUR in `db.kofiSupportersAnonymousTotal` (Summe ohne Namen) - Namen werden bei anonymen Spenden nie irgendwo gespeichert oder geloggt, auch nicht in Server-Logs.
- `checkAllianceKeyPermission()` – zentrale Rechteprüfung für `alliance:*`-Schlüssel, wird in den generischen Storage-Routen aufgerufen. Rollen: admin > officer > member.
- `db.private[userId]` – der eigentliche Spielstand jedes Nutzers (JSON-Blob, `kepler7-save-v3`-Key).
- Server ist für PvP-relevante Berechnungen (Angriffskraft, Marktpreise, Allianz-Freischaltungen) die Autorität – Client-Werte werden dort nicht blind übernommen, sondern serverseitig aus dem gespeicherten Spielstand neu berechnet.

## Unterstützer, Kosmetik und Sternenstaub (15./16.08.2026)

Das Premium-Programm liegt in weiten Teilen HIER, nicht im Frontend. Wer daran etwas ändert, sollte
die folgenden Entscheidungen kennen – jede davon hat einen Grund, der beim Bauen nicht offensichtlich
war.

### Rang und Funktionsfreigabe sind ZWEI verschiedene Dinge

- `supporterStatusCombined(userId)` = der **RANG**. Spende oder manuell vergeben. Er trägt das
  ☕-Abzeichen in der Bestenliste und schaltet die **Spender-Kosmetik** frei.
- `supporterFeaturesFor(userId)` = die **FUNKTIONSFREIGABE**. Rang, Testphase ODER die
  `gamegeeeeek`-Ausnahme. Sie schaltet Automatiken, Komfort-Grenzen und das Berichts-Archiv frei.

**Die Trennung ist der Kern und darf nicht zusammengelegt werden.** Testphase und Betreiber-Ausnahme
sind keine Unterstützung – ein Abzeichen oder eine Spender-Farbe dafür wäre schlicht unwahr. Genau
deshalb fragt `kosmetikSpenderErfuellt()` den RANG und nicht die Freigabe; sonst trüge jeder nach
fünf Gratistagen die Goldspender-Farbe.

Die Testphase (`SUPPORTER_TRIAL_DAYS`) ist einmalig je Konto. **Die Sperre hängt an
`supporterTrialAt`** (bleibt für immer stehen), nicht an `supporterTrialUntil` (liegt nach Ablauf in
der Vergangenheit und gäbe die Testphase wieder frei). Im Neuzustand verhalten sich beide identisch –
der Unterschied wird erst nach Ablauf sichtbar, und dann wäre aus der Testphase ein unbegrenztes
Gratisabo geworden.

### Kosmetik: zwei Prüfstufen, und warum es zwei sind

`KOSMETIK_DEFS` führt Schlüssel + Freischaltbedingung; das Frontend kennt dieselben Schlüssel mit
Aussehen. Beide Seiten werden von `tests/test_kosmetik_paritaet.js` (im FRONTEND-Repo) verglichen –
dieselbe Kopie-Familie wie `SHIP_SCORE_WEIGHTS`/`computeScoreServer`.

- **Beim AUSRÜSTEN** wird vollständig geprüft, inklusive Fortschritt. Kostet einmal ein `JSON.parse`
  des Spielstands, ist selten genug.
- **Beim LESEN** (Bestenliste, jede Sekunde, von jedem) nur die **BEFRISTETEN** Bedingungen, ohne den
  Spielstand einzulesen.

Tragfähig ist das, weil die Fortschritts-Bedingungen **MONOTON** sind: Prestige, Aufstiege,
Kampfpunkte, Rekordtiefe, Erfolge, besiegte Bosse und Käufe wachsen, sie schrumpfen nicht. Was beim
Ausrüsten galt, gilt weiter. Nur eine Spende läuft ab – und dann muss die Farbe von selbst
verschwinden. **Eine neue Bedingungsart, die schrumpfen kann, muss `kosmetikBefristet()` erweitern**,
sonst trägt jemand ein Stück weiter, das er nicht mehr besitzt.

Die gespeicherte Auswahl bleibt beim Ablauf bewusst STEHEN – spendet derselbe Spieler erneut, trägt
er sofort wieder seine alte Farbe.

### Meilenstein-Embleme: die Bedingungsart, die NIE abläuft (17.08.2026)

`spender_je` ist das Gegenstück zu `spender`: nicht „unterstützt gerade", sondern „hat unterstützt".
Drei Stufen (`em_funke`/`em_leitstern`/`em_leuchtfeuer`), dieselben Schwellen wie `supporterTierFor`
– also keine zweite Zahlenliste. Sie steht bewusst **nicht** in `kosmetikBefristet()`; das ist der
ganze Zweck, kein Versehen.

**Der Fehler, den der Test gefunden hat – und die Lehre daraus.** Der erste Entwurf hat die höchste
je erreichte Stufe bei jedem Aufruf frisch ABGELEITET (aus der kumulativen Spendensumme plus dem
gerade laufenden Rang). Das sah monoton aus und war es nicht:

- Ein von Hand vergebener Rang aus der Zeit vor der Änderung hat keine Historie – nach dem Ablauf
  war die Stufe „nie erreicht".
- Dieselbe Lücke bei einer gelösten oder geänderten Ko-fi-Adresse: Die Spendensumme hängt an
  `user.kofiEmail`; ist die weg, ist die Historie weg.

Gemessen im HTTP-Test sah das so aus: Das Emblem fiel aus dem Besitz, **wurde aber weiter getragen**
– weil der Lesepfad unbefristete Bedingungen ja nicht erneut prüft. Genau der Zustand, vor dem der
Abschnitt darüber warnt, nur von der anderen Seite: nicht „läuft ab, obwohl es bleiben soll", sondern
„bleibt sichtbar, obwohl es nicht mehr besessen wird".

**Behoben, indem die Höchstmarke PERSISTIERT statt abgeleitet wird:** `user.supporterStufeJeMax`
steigt nur und wird über `spenderStufeJeFortschreiben()` an jeder Stelle nachgezogen, an der der
Server einen Rang tatsächlich **beobachtet** – Ko-fi-Webhook, manuelle Vergabe, und bei jedem
`/api/me` (dort heilt sich der Altbestand beim nächsten Spielstart von selbst, gemessen: Rang direkt
in der DB gesetzt, nach einem `/api/me` steht `supporterStufeJeMax: 'gold'`). Der Widerruf löscht das
Feld ausdrücklich **nicht**.

**Die übertragbare Lehre:** „Der Wert ist monoton" ist eine Behauptung über *alle* Pfade, nicht nur
über den Hauptpfad. Wer eine Größe ableitet, statt sie festzuhalten, erbt jede Lücke ihrer Quellen –
hier die Bindung an eine E-Mail-Adresse und das Fehlen einer Historie bei der Handvergabe. Bei einer
Größe, die per Definition nie sinken darf, ist Festhalten die richtige Antwort, nicht Ableiten.

Eingespeist wird an **zwei** Stellen (GET- und PUT-Pfad der Bestenliste), genau wie `isSupporter`.
Beide braucht es: Der GET überschreibt ohnehin, der PUT ist Verteidigung in der Tiefe.

### Sternenstaub: nur was der Server SELBST beobachtet

Der erste Entwurf wollte Tagesaufgaben und Wochenliga als Quellen. Das wäre eine Währung gewesen, die
nur so AUSSIEHT, als läge sie sicher hier – beide Größen stehen im klientenautoritativen Spielstand.
Der Server hätte eine gemeldete Zahl entgegengenommen und feierlich in sein eigenes Konto geschrieben;
damit wäre die ganze Verankerung der Kosmetik über den Umweg der Währung wieder offen gewesen.

Es zählt deshalb nur: **die tägliche Anmeldung** (Zeitstempel entsteht hier) und der **abgewehrte
Angriff** (`/api/attack` würfelt serverseitig aus, der Verteidiger kann ihn weder auslösen noch
beeinflussen). Gegen Absprache: je Angreifer höchstens einer pro Tag, insgesamt höchstens
`STAUB_ABWEHR_MAX_PRO_TAG`.

**Der Tagesriegel ist die wichtigste Zeile der ganzen Währung.** Ohne ihn wächst der Stand bei JEDEM
`/api/me`, also bei jedem Neuladen – gemessen an einer sabotierten Kopie: 5 → 10 → 15. Die Währung
wäre per F5 druckbar. Gutgeschrieben wird bewusst in `/api/me` und nicht in `/api/login`: Das Token
überlebt Tage, wer angemeldet bleibt, durchläuft `/api/login` unter Umständen wochenlang nicht.

**Jede Gutschrift läuft durch `staubGutschreiben()`** – eine Stelle, damit die Wochensumme nicht an
einer Quelle vorbeizählt. Der Wochenschlüssel ist ISO-8601 in **UTC** und damit bewusst NICHT
derselbe wie `weekKeyOf()` im Frontend (lokaler Montag); der Server kennt die Zeitzone nicht. Tragbar
nur, weil daran keine Belohnung hängt – **kommt je eine, muss das neu entschieden werden.**

### Deckel dürfen niemals Daten löschen

`addReport` begrenzt nur das **WACHSTUM**: behalten wird immer mindestens so viel, wie vor dem neuen
Bericht schon dalag. Ein schlichtes `slice(0, deckel)` hätte einem ehemaligen Unterstützer beim
nächsten Kampf über hundert Kampfberichte gelöscht – unbemerkt, denn er sieht es erst, wenn er
nachsehen will (an einer sabotierten Kopie gemessen: 150 → 40). Ein Deckel, der Historie vernichtet,
sobald jemand aufhört zu spenden, bestraft das Aufhören statt das Unterstützen.

**Das gilt für jeden künftigen Deckel an einer Unterstützer-Grenze**: Erst durchdenken, was beim
ABLAUF passiert. Im Frontend ist dieselbe Regel umgesetzt, indem dort nur das Hinzufügen gedeckelt
wird (Warteschlangen, Notizen, Freunde) – nichts Bestehendes wird angetastet.

### Tests dieses Bereichs

`tests/test_unterstuetzer_testphase_http.js`, `tests/test_kosmetik_http.js`,
`tests/test_sternenstaub_http.js`, `tests/test_berichtsarchiv_http.js`. Alle arbeiten mit **mehreren
Serverstarts auf derselben DB**, weil die entscheidenden Eigenschaften an der Uhr hängen (Rang läuft
ab, Tag wechselt) und sich anders nicht prüfen lassen. Zwei Fallen daraus:

- **Der Anfängerschutz muss für Angriffs-Tests weg** (`db.private[<id>].__attackShieldUntil = 0`),
  sonst antwortet `/api/attack` mit 403 und der ganze Abschnitt misst nichts – beim ersten Anlauf sah
  das aus wie „der Verteidiger verliert immer".
- **Deckel-Prüfungen gehören dorthin, wo der Deckel greifen KANN.** Ein `anzahl <= deckel` nach dem
  Ablauf ist trivial erfüllt, weil das Wachstum ohnehin eingefroren ist.

`test_kosmetik_http.js` Abschnitt 1f prüft **jede** Fortschritts-Bedingungsart, die der Katalog
führt, statt einer festen Liste – eine neue Art ist damit automatisch abgedeckt.

### Markt: Tagesumsatz-Deckel für Verkaufserlöse (17.08.2026)

`MARKT_TAGES_ERLOES_MAX` (5 Mio Credits je Konto und UTC-Tag) deckelt am `/api/market/trade`-Endpunkt
ausschließlich VERKAUFS-Erlöse – Käufe vernichten Credits und bleiben frei. Anlass und Rechnung
stehen als Kommentar an der Konstante. Vier Entscheidungen, die man beim Anfassen kennen muss:

- **Der Zähler lebt am user-Objekt** (`user.marktTag = { stempel, erloes }`), nach exakt dem
  `user.staub`-Muster: Stempel gegen `staubTagesschluessel()` prüfen, bei Abweichung zurücksetzen,
  dann zählen – kein Cron. Der Spielstand scheidet als Ablageort aus: Er ist klientenautoritativ
  und beim nächsten regulären Speichern überschrieben.
- **Prüfung VOR der ersten Mutation, Fortschreibung im selben synchronen Block** vor `saveDb()` –
  dieselbe Race-Begründung wie bei der Modulbörse. Zwei parallele Verkäufe können den Deckel so
  nicht gemeinsam durchbrechen.
- **Abgelehnt wird mit 400, bewusst NICHT mit 429**: Den 429 deutet der Sammelauftrag des Frontends
  als vorübergehend und wiederholt dieselbe Tranche bis zu dreimal mit je 20 s Wartezeit. Ein
  erschöpftes Tageskontingent ist nicht vorübergehend. Der Fehlertext nennt die Zahlen, die
  Antwort trägt `tagesRest`/`tagesMax` als Felder.
- **`tagesRest` reist in JEDER Antwort mit** (GET /api/market und beide Trade-Ausgänge) – das
  Frontend zeigt den Stand an, statt dass der Spieler ihn erst aus einer Ablehnung erfährt.

`tests/test_marktdeckel_http.js` ist der erste Markt-HTTP-Test dieses Repos (Port 3217,
Sternenstaub-Muster: zwei Serverstarts auf derselben DB, Tageswechsel per rückdatiertem Stempel).
Seine Gegenprobe hat ein Lehrstück dokumentiert: Am alten Stand blieb die Deckel-Prüfung aus dem
FALSCHEN Grund grün (die Verkaufsschleife leerte den Bestand, der 400 kam vom „Nicht genug"-Zweig) –
deshalb verlangt Prüfung 4 den GRUND im Fehlertext, nicht nur den Statuscode.

**Entschieden am 17.08.2026 (Sascha): Verkaufsrouten zählen auf DASSELBE Kontingent.** Der Client
meldet Routen-Erlöse gebündelt an `POST /api/market/routen-erloes`; sie zählen in denselben
`user.marktTag`-Zähler. Das ist eine klientengemeldete Zahl – aber sie kann das Kontingent nur
VERKLEINERN: Wer die Meldung unterschlägt, hat exakt den Stand von vor der Änderung (Routen
verbucht ohnehin der Client), wer zu viel meldet, sperrt sich selbst den Direktverkauf. Dieselbe
Prüffrage wie beim Sternenstaub, mit umgekehrtem Ergebnis – hier gibt es nichts zu holen.

### Gefechtsvorräte: warum der Server sie rechnet UND abbucht (18.08.2026)

`GEFECHTSVORRAETE` ist eine Kopie der Frontend-Tabelle, dieselbe Familie wie `SHIP_SCORE_WEIGHTS`
und `DEFENSE_VALUES`. Ein Vorrat erhöht Angriff bzw. Verteidigung um einen festen Prozentsatz und
kostet dafür Tier-2-Material je Kampf.

**Die Entscheidung, die man kennen muss:** Ein Vorrat verändert den Ausgang eines Kampfes gegen
einen **echten Spieler**. Er fällt damit auf die Seite der Grenze, die dieses Projekt verteidigt
(„kann ich etwas anfassen, das anderen gehört?"), und darf deshalb weder vom Client gemeldet noch
vom Client abgebucht werden. `/api/attack` nimmt weiterhin **keinen einzigen Kampfparameter** aus
dem Request entgegen — das ist eine Eigenschaft dieses Endpunkts, die erhalten bleiben soll. Statt
dessen steht die **Wahl** im Spielstand (`save.gefechtsvorrat`), genau wie Doktrin, Aufstellung und
Prestige-Perks; der Server liest sie, prüft den Bestand und bucht in `gefechtsvorratEinsetzenServer`
im selben synchronen Block ab, bevor beide Spielstände ohnehin geschrieben werden.

Dass der Spielstand klientenautoritativ ist, ändert daran nichts: Wer sich Nanolegierungen
hinschreibt, konnte sich schon immer alles hinschreiben. Neu wäre nur gewesen, dem Client zu
erlauben, dem Server eine **Wirkung** zu diktieren — und genau das passiert hier nicht.

**Zwei Fallen beim Anfassen:**

- **`attackPower` ist EINE Definition, die den Vorrat trägt.** Sie wird an sechs Stellen ausgegeben
  (zwei Berichte je Ausgang plus beide Antworten). Vor dem Umbau hätte jede davon eine Kraft
  genannt, mit der gar nicht gekämpft wurde. Das Konterverhältnis wird bewusst **davor** aus dem
  unveränderten Wert gebildet — es ist das Verhältnis zweier Kraftwerte und darf sich durch einen
  flachen Aufschlag nicht verschieben (dieselbe Überlegung wie beim `spyEdgeMult`).
- **Reicht der Bestand nicht, wird NICHTS abgebucht** und der Kampf findet ohne Vorrat statt. Ein
  Teilabzug wäre schlimmer als keiner: Material weg, Wirkung keine.

`tests/test_gefechtsvorrat_http.js` (Port 3218) misst das an echten Kämpfen. Zwei Dinge daraus, die
jeder neue Angriffs-Test braucht: **Jede Messung bekommt ein eigenes, frisches Opfer** — der
PvP-Kampf hat einen Boden von 19,6 % je Phase, rund jeder zehnte Angriff geht also auch gegen eine
hundertfach überlegene Verteidigung durch, verschiebt per Beute die gemessenen Bestände und setzt
beim Opfer einen Schutzschild, nach dem alle weiteren Angriffe mit 403 abprallen. Und der
**Anfängerschutz muss zwischen zwei Serverstarts in der DB-Datei geleert werden**; beim ersten
Anlauf sah sein 403 aus wie „der Vorrat wirkt nicht", und zwei Prüfungen wurden dadurch aus dem
falschen Grund grün (beide Seiten `undefined`).

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

## Der Kampfvermerk am Vorkommen (21.08.2026)

`/api/asteroid/contest` schreibt seit dem 21.08.2026 in **beiden** Ausgängen
`vork.letzterKampf = { zeit, verlierer, verloren, angreifer, verluste }`.

**Der Anlass war kein fehlender Text, sondern eine fehlende UNTERSCHEIDUNG.** Der Client des
Verteidigers konnte nicht erkennen, ob ein Schürfrecht durch einen **Kampf** weg ist oder weil er
es **selbst aufgegeben** hat. Beide Fälle sehen im Felddokument gleich aus: Das Recht gehört ihm
nicht mehr, und `vork.eskorte` ist leer (die Freigabe löscht sie ebenfalls). Sein
`asteroidEskortenSync` übersprang den Platz deshalb komplett – gemessen im Browser: 20 Kreuzer
stationiert, Recht verloren, der lokale Eintrag stand danach unverändert bei 20, und ein Rückruf
gab **alle 20 zurück**, obwohl der Server sie in diesem Kampf vernichtet hatte. Ein verlorenes
Schürfrecht kostete den Verteidiger damit keinen einzigen Schiffsverlust.

**Warum am Vorkommen und nicht im Spielstand des Verteidigers:** Der Server schreibt hier
grundsätzlich keinen fremden Spielstand (siehe den Kommentar am Festungsschlag). Das Felddokument
gehört dagegen den Asteroiden-Endpunkten, der Client liest es bei jedem Kartenaufruf ohnehin, und
ein nachwachsendes Vorkommen ist in `astNachschub` ein **frisches Objekt** – der Vermerk stirbt
also mit dem Brocken, an dem er hängt, und kann nicht auf einen späteren Nachfolger durchschlagen.

**Er wird auch bei einem ABGEWEHRTEN Angriff geschrieben.** Bis dahin stand über den Verlusten
einer erfolgreichen Abwehr nur eine Protokollzeile ohne Angreifer und ohne Schiffstypen – und
`#log` überschreibt sich mit der nächsten Meldung selbst.

**Kein neues Leck.** `verlierer` ist eine Nutzer-ID, aber `vork.halter` ist längst eine, und
`vork.eskorte` führt die Wache des Halters ohnehin vollständig und öffentlich.

**Die Auslieferungsreihenfolge ist gleichgültig** (anders als bei den Festungen, Frontend-Regel 60):
Geht dieses Backend allein live, schreibt es ein Feld, das niemand liest – folgenlos. Geht das
Frontend allein live, liest es ein Feld, das es nicht gibt, der Zweig feuert nie, und es bleibt
beim heutigen Zustand. Ein Schalter ist deshalb nicht nötig.

Wächter: `tests/test_asteroidfeld_http.js` 9k–9k4. Gemessen wird gegen die **Antwort an den
Angreifer** (`kampf.body.gegnerVerluste`) – ein Anker von außerhalb der Rechnung, den ein Fehler im
Vermerk nicht mitverschieben kann (Frontend-Regel 62). Und 9k prüft, dass der Vermerk die
**Verteidigerin** als Verliererin nennt und nicht den neuen Halter: Bei einem Sieg ist `vork.halter`
zu diesem Zeitpunkt schon der Angreifer – derselbe Fallstrick, den der Postfach-Zweig eine Zeile
weiter unten mit `halterIdVorher` löst.

## Alien-Nester (Phase 3, 18.08.2026)

Das Gegenstück zu den Festungen: Die Festung **steht** und drosselt, das Nest **wächst** und breitet
sich aus. Wer nichts tut, hat übermorgen mehr davon als heute.

**`NEST_SPAWN_AKTIV` steht seit dem 19.08.2026 auf `true`** – das Frontend der Phase 3 ist
ausgeliefert (v8.582.0), und damit ist die Bedingung erfüllt, unter der er auf `false` stehen
musste. Karte, Kartenmenü, Angriffsmission, Bericht und Hilfetext stehen.

**Der Schalter bleibt trotzdem stehen** – als Notausschalter, aus demselben Grund wie die beiden
Festungs-Schalter. `test_alien_nester_http.js` 11c prüft jetzt, dass er auf `true` steht; ein
Wechsel auf `false` ist damit eine bewusste Notabschaltung, die auffällt statt still zu
geschehen – und ihr Grund gehört dann hierher.

Warum er überhaupt gebaut wurde, bleibt als Begründung wichtig: Solange er aus war, kehrte
`nestTick()` in der ersten Zeile zurück und der ganze Abschnitt tat nichts. Ging dieses Backend
allein live, entstünden Nester, die niemand sieht und niemand angreifen kann – dieselbe
Begründung wie bei den beiden Festungs-Schaltern.

**Wo sie wohnen: `db.galaxy.alienNester`.** Das ist keine Geschmacksfrage. `db.galaxy` ist für
Clients über `PUT /api/storage/:key` **gar nicht erreichbar** – anders als der Weltboss, dessen
Schlüssel `worldboss:current` im geteilten Speicher liegt und deshalb eigens abgesichert werden
musste. Die Nester dorthin zu legen umgeht diese ganze Fehlerklasse von vornherein. Nebeneffekt,
der Arbeit spart: `galaxyFuerClient()` macht `Object.assign({}, g, …)` – alles aus `db.galaxy`
geht damit automatisch an den Client, ohne eine Zeile Verdrahtung.

**Die LP sind gegen die BEREITS KALIBRIERTEN FESTUNGEN gerechnet, nicht gegen eine neue
Referenzflotte** – und der erste Anlauf tat genau das Falsche. Frisch zusammengestellte Flotten
lieferten 1.196 / 12.144 / 63.997 Schlagkraft; gegen die bräuchte die Sternenfeste 18,8
Endspiel-Schläge statt der 5, mit denen sie ausgeliefert ist. **Der Maßstab war ein anderer**
(Forschung, Marken, Haltung steckten in der Festungs-Kalibrierung drin), nicht die Zahl. Gegen den
richtigen Maßstab (7.500 / 44.000 / 240.000 je Schlag):

| Ziel | Einsteiger | Mittelfeld | Endspiel | × Sternenfeste |
|---|---|---|---|---|
| Sporenherd 40k | 5,3 | 0,9 | 0,2 | 0,03 |
| Brutkammer 120k | 16,0 | 2,7 | 0,5 | 0,10 |
| Schwarmstock 400k | 53,3 | 9,1 | 1,7 | 0,33 |
| Hochnest 1,2 Mio | 160,0 | 27,3 | 5,0 | 1,00 |
| Königin 4 Mio | 533,3 | 90,9 | **16,7** | 3,33 |

Die Konzept-Zahlen halten damit alle stand – der Sporenherd ist das Gegenstück zur Schanze, das
Hochnest exakt die Sternenfeste. **Falsch ist nur der Satz daneben:** Das Konzept sagt, die Königin
sei „mit 40 Endspiel-Schlägen ausgelegt"; gemessen sind es 16,7. Bei 4 Stunden Abklingzeit je
Spieler heißt das drei Kommandanten an einem Tag oder eine Allianz an einem Abend – näher am
beschriebenen Gefühl als vierzig Schläge (Frontend-Arbeitsregel 41).

### Vier Entscheidungen, die man kennen muss

1. **Der Takt liegt im `galaxyTick`, nicht lazy beim Lesen** – anders als der Hort der Festung. Der
   Unterschied hat einen Grund: Der Hort ist ein Zähler, den nur der Leser sieht; ein Nest
   **verändert die Galaxie** (es reift, breitet sich aus, bringt eine Königin hervor), und diese
   Ereignisse gehören in den Weltentakt. Sonst hinge die Weltlage daran, wer wie oft die Karte
   öffnet.
2. **Ein reifendes Nest HEILT NICHT.** `lp` steigt um dieselbe Differenz wie `lpMax`, angerichteter
   Schaden bleibt angerichtet. Heilte es voll, wäre jeder Schlag davor wertlos – und Warten die
   beste Strategie für den Schwarm statt für den Spieler. Gegenprobe gemessen: mit `lp = lpMax`
   fällt `10c` mit `{"lp":96000,"erwartet":74000}`.
3. **Die Abklingzeit liegt AM NEST** (`nest.schlaege[userId]`), nicht im Spielstand – dieselbe
   Entscheidung wie bei der Festung und aus demselben Grund. Die Gegenprobe ist die Messung, die
   die beiden Ablageorte überhaupt unterscheidet: Mit der Sperre im Spielstand gibt ein gelöschtes
   Feld den nächsten Schlag sofort frei (gemessen: 200 statt 403, 31.113 Schaden).
4. **„Weitergezogen" und „gefallen" kosten NICHTS** – keine Verluste, keine Abklingzeit, und die
   Antwort nennt den **Grund**. Ein stilles `ok` wäre hier die Falschaussage, vor der dieses
   Projekt seine Anzeigestellen schützt. Das ist zugleich die Eigenart der Nomaden von Vex: ein
   Ziel, das man verlieren kann, wenn man zu lange zögert.

**Die Königin reißt den ganzen Schwarm ihres Volkes mit** und setzt eine 72-Stunden-Pause. Das ist
die Ausschüttung, auf die eine Allianz hinarbeitet – und der Grund, warum Wachsenlassen eine echte
Entscheidung ist statt einer Formalität: Wer früh räumt, zahlt wenig und bekommt wenig.

**Die Volksnamen sind eine KOPIE-FAMILIE.** `ALIEN_VOELKER[*].name` muss wörtlich zu
`ALIEN_RACE_NAMES` passen – darüber läuft die Zuordnung zwischen dem vorhandenen „Volk
entdeckt"-Ereignis und seinem Nestbestand. Eine Umbenennung auf einer Seite bricht sie still;
`tests/test_alien_nester_http.js` 1a hält beide zusammen.

### Der Test und zwei Lehren aus ihm

`tests/test_alien_nester_http.js` (Port 3224, **40 Prüfungen, fünf Gegenproben** – Schwächenfaktor,
angekommener Schaden, Heilung beim Reifen, Ablageort der Abklingzeit, Schwarm-Zerfall; alle in
beide Richtungen gefahren, überall dieselbe Anzahl gelaufener Prüfungen). **Belegte Testports sind
jetzt 3195–3200, 3210–3223 und 3224** – ein neuer Test nimmt 3225.

**Der Test startet eine KOPIE von `server.js` mit umgelegtem Schalter.** Anders ginge es nicht:
Solange `NEST_SPAWN_AKTIV` aus ist, tut `nestTick()` nichts, und der halbe Test hätte keinen
Gegenstand. Die Kopie liegt im Repo-Verzeichnis (damit `require('./mailer')` auflöst) und wird im
`process.on('exit')` weggeräumt. Damit misst er den echten Code mit genau der einen Zeile, die
später ohnehin umgelegt wird – und er bleibt grün, egal wie der Schalter committet ist.

Zwei Fallen, die je einen Anlauf gekostet haben:

- **Ein `grep` nach `schwaeche:` trifft zwei Tabellen.** Die Namensprüfung suchte ungescopt und fand
  neun Namen statt vier – die fünf zusätzlichen waren **Weltboss-Archetypen**, die dasselbe Feld
  führen. Der Fehlschlag meldete sie als „fehlende Völker". Frontend-Arbeitsregel 39, hier im
  Backend: Jede Suche nach einem Eintrag gehört auf den Block ihrer Tabelle gescopt, und der Anker
  des Blocks gehört selbst geprüft.
- **Eine Prüfung darf nicht an einer Momentaufnahme hängen.** `7c` verlangte zuerst GENAU ein
  übriges Nest und fiel an einem Zufall: Der `galaxyTick` entdeckt mit 6 % je Takt ein neues Volk,
  und der Nachschub-Zweig legt ihm sofort ein Nest an – völlig korrektes Verhalten, das mit dem
  Königinnen-Fall nichts zu tun hat. Geprüft wird jetzt die REGEL („kein Nest des gefallenen
  Volkes, das fremde steht noch"), und kein Zugriff im Test greift mehr über `[0]`.

**Und eine dritte, die den Test selbst betraf** (Frontend-Arbeitsregel 34): Der Spielstand liegt in
`db.private` in **zwei** Formen vor – als blanke Zeichenkette oder als `{ value, version }`, weil
`setSaveValue()` die zweite schreibt. Der erste Entwurf nahm nur die erste an und **starb** an
einem `JSON.parse('[object Object]')`, sobald eine Gegenprobe den Server dazu brachte, den
Spielstand zu schreiben – 10 statt 40 Prüfungen, und der rote Exit-Code sah aus wie eine gelungene
Gegenprobe. Seither lesen `liesSave()`/`schreibSave()` beide Formen, und die Gegenprobe zum
Ablageort der Abklingzeit lässt sich überhaupt erst fahren.

## Die galaktische Gegnerstärke wird beweglich (Phase 4, 19.08.2026)

`npcEmpireStrength` wuchs bis hierher monoton bis 2,5 und blieb dort – ein Schwierigkeitsregler,
den niemand bewegen kann. Neu leitet der `galaxyTick` einen **Zielwert** aus dem Nestbestand ab und
lässt den Ist-Wert dorthin driften: Wer aufräumt, macht die Galaxie für alle leichter; wer die
Nester wachsen lässt, bezahlt es mit härteren NPC-Gegnern.

**Die Drift läuft NUR, wenn `NEST_SPAWN_AKTIV` an ist – und das ist keine Vorsicht, sondern
gemessen.** Ohne Nester ist die Stufensumme 0, der Zielwert wäre die Basis, und die
NPC-Verteidigung fiele sofort um 44 % – allein dadurch, dass diese Phase gemergt wird, während
Phase 3 noch schläft. Steht der Schalter aus, bleibt deshalb das alte monotone Wachstum.
`test_npc_staerke_http.js` 3a misst genau das; die Gegenprobe mit ausgebautem Tor lässt sie fallen.

**Die Basis ist die KONSERVATIVE Variante** (das Konzept führt sie in 11.2 als offene
Entscheidung), gerechnet gegen den bisherigen Stand 2,5:

| Lage | Stufensumme | Konzept (1,0 + 0,080) | gewählt (1,4 + 0,046) |
|---|---|---|---|
| geräumt | 0 | 1,00 (−60 %) | **1,40 (−44 %)** |
| ruhig (4 Nester Stufe 2) | 8 | 1,64 (−34 %) | 1,77 (−29 %) |
| angespannt (8 Nester Stufe 3) | 24 | 2,50 (±0) | 2,50 (±0) |

Beide Kurven enden am selben Deckel, aber **nicht bei derselben Dichte**: Die Konzept-Kurve ist
schon bei 18,75 Stufenpunkten oben, die gewählte erst bei 23,9. Der eigentliche Unterschied liegt
am unteren Ende, und genau dort steht der Spieler **am Tag der Umstellung**, wenn es null bis ein
Nest gibt – die Konzept-Basis verschenkte in den ersten 19 Stunden 60 % der NPC-Verteidigung, ohne
dass jemand etwas dafür getan hätte. **Hier stand im ersten Entwurf „beide treffen den Deckel bei
Stufensumme 24" – das war aus der Tabellenzeile abgelesen statt gerechnet** (die Zeile zeigt nur,
dass beide dort bereits gedeckelt SIND). Frontend-Arbeitsregel 41 an einer eigenen Zahl.

**4 % Annäherung je Tick** (96 Ticks/Tag): halber Abstand nach 4,2 h, 95 % nach 18,3 h. Die Galaxie
reagiert innerhalb eines Tages sichtbar, aber ein einzelner Angriff schaltet die Weltlage nicht um.

**`g.npcStaerkeZiel` reist über `galaxyFuerClient()` zum Client** – und wird **nur im Tor-Zweig
geschrieben**. Ein Server ohne wirkende Drift führt das Feld also GAR NICHT; das Frontend kann
daran erkennen, dass es nichts zu behaupten gibt, statt eine Weltlage anzuzeigen, die nirgends
gilt. `test_npc_staerke_http.js` 4a hält diese Richtung fest, 4b die andere.

**Kein Helfer `nestStufen(n)` neben `nestStufe(zahl)`.** Der erste Entwurf hatte einen – ein
Buchstabe Unterschied, und das eine nimmt ein Nest-OBJEKT, das andere eine Stufenzahl. Genau die
Sorte Namenspaar, die später jemand verwechselt; die Summe steht deshalb ausgeschrieben in
`nestStufenSumme`.

**Beim Anfassen mitgenommen: die erfundene Begründung beim Wandern.** `nestTick` leerte beim
Weiterziehen eines Nomaden-Nestes die Abklingzeiten (`n.schlaege = {}`) mit dem Kommentar „die
Abklingzeit hängt am ORT, nicht am Nest". Das ist beim Schreiben erfunden worden und widerspricht
dem Entwurf: Die Sperre hängt am NEST, und das Nest ist nach dem Wandern dasselbe Nest. Praktisch
folgenlos (Wanderung alle 12 h, Abklingzeit 4 h – sie wäre ohnehin abgelaufen), aber es ist genau
die Sorte Kommentar, die beim nächsten Lesen als REGEL gelesen wird. Zeile und Kommentar sind weg.

### Der Test

`tests/test_npc_staerke_http.js` (Port 3227, 14 Prüfungen, **drei Gegenproben** – Tor, Sprung statt
Drift, fehlender Deckel; alle in beide Richtungen gefahren, überall dieselben 14 Prüfnamen, per
`diff` verglichen statt gezählt). **Belegte Testports sind jetzt 3195–3200 und 3210–3227** – ein
neuer Test nimmt 3228.

Er startet **zwei** Kopien von `server.js`, eine je Schalterstellung. Der Gegenstand ist ein
Schalter; beide Stellungen gehören gemessen, und welche gerade committet ist, darf das Ergebnis
nicht verschieben.

**Die wichtigste Zeile des Tests ist `einfrieren()`** – vier Riegel, einer je Zweig des `nestTick`:
`letzteReifung` auf jetzt (reift nicht), `naechsterWurf` und `naechsteWanderung` weit in die
Zukunft, und `alienPause` für **alle vier** Völker. Der letzte ist der unauffälligste und der
nötigste: Der `galaxyTick` entdeckt mit 6 % je Takt ein neues Volk, und der Nachschub-Zweig legt
ihm sofort ein Nest an – die gemessene Eingabe wäre also mitten in der Messung eine andere. Genau
daran ist im Nest-Test schon einmal eine Prüfung an einem Zufall gescheitert.

**Die Erwartung wird im Test neu gerechnet, die Eingabe dagegen BEOBACHTET** (Nestliste aus der DB
nach dem Tick). Eine Erwartung, die aus derselben Rechnung stammt wie das Ergebnis, kann nicht
fehlschlagen – Frontend-Arbeitsregel 62.

## Verbandsangriff auf ein Alien-Nest (Phase 5, 21.08.2026)

Der koordinierte Musterangriff konnte bisher nur eine fremde **Allianzbasis** treffen. Neu trägt
sein Dokument eine `zielArt`; mit `'alien-nest'` fällt der halbe Prüflauf darunter weg – nicht aus
Bequemlichkeit, sondern weil ein Nest keine Allianz, keine Basis, kein `incomingmuster`-Dokument
und keinen Schutzschild hat.

**Es gibt keinen eigenen Schalter.** `NEST_SPAWN_AKTIV` gilt mit: Ohne Nester existiert kein Ziel,
`create` antwortet mit 404, und der ganze Zweig ist unerreichbar.

### Die Sicherheitsstelle, und warum sie eine ist

`resolve` darf ausnahmsweise auch der VERTEIDIGER auslösen – deshalb prüft es Mitgliedschaft in
`tag` **oder** in `doc.targetTag`. Ein Nest hat kein `targetTag`. Und `allianceRoleOf` baut seinen
Schlüssel per **Zeichenkettenverkettung**:

```js
const raw = db.shared['alliance:' + tag + ':role:' + userId];
```

Mit `null`/`undefined` entsteht daraus wörtlich `alliance:null:role:<uid>` – ein Schlüssel, der wie
ein ganz normaler Rolleneintrag aussieht. Wer einen solchen anlegen kann, dürfte damit **jeden**
Nest-Verbandsangriff auflösen.

**Behoben nicht durch eine Null-Prüfung, sondern durch eine Verzweigung davor:** Bei
`zielArt === 'alien-nest'` wird der Verteidiger-Zweig gar nicht erst betreten. Ein Nest hat keinen
Verteidiger, also gibt es auch keine Verteidiger-Rolle zu prüfen.
`tests/test_muster_nest_http.js` 2c **legt dem Außenstehenden genau diese zwei Schlüssel an** und
verlangt trotzdem 403 – die Gegenprobe ohne den Zweig lässt ihn auflösen. Das ist die Grenze, die
dieses Projekt überall verteidigt („kann ich etwas anfassen, das ANDEREN gehört?"), hier auf das
Auflösen eines fremden Verbandsangriffs angewandt.

### Der gemeinsame Kern – und wo seine Naht liegt

`nestSchlagAusfuehren(g, nest, kraft, composition, beteiligte, jetzt)` wird von BEIDEN Wegen
benutzt (Einzelangriff und Verband). Eine zweite Kopie der Schadensrechnung wäre die übliche
zweite Wahrheit – dieselbe Antwort wie bei `astFreiePlaetze`.

Zwei Entscheidungen an der Schnittstelle, beide aus dem Unterschied der zwei Wege:

- **Rein geht die KRAFT, nicht der Spielstand.** Der Einzelangriff bildet sie aus dem Spielstand
  des Angreifers; ein Verband hat **keinen einen Spielstand** – seine Kraft steht seit dem Beitritt
  fest (`doc.dispatch.totalPower`, je Mitglied gemessen und summiert). Sie hier neu zu bilden hieße,
  sie aus dem Spielstand eines einzelnen Mitglieds zu raten.
- **Raus kommen die Verluste als QUOTE, nicht als Stückzahlen.** Der Server schreibt fremde
  Spielstände nicht; jeder Client wendet sie auf SEINEN Beitrag an – dasselbe Muster wie bei der
  Basisangriffs-Auflösung (`ownLossPct`).

### Drei Entscheidungen, die nur der Verband kennt

1. **Abklingzeit und Beitrag gehen an ALLE Teilnehmer**, gewichtet nach ihrer beim Beitritt
   gemessenen Kraft. Nur den Auslöser gutzuschreiben machte den Hort-Anteil zur Frage, wer zufällig
   auf den Knopf drückt – und ein Verbandsschlag gäbe danach den nächsten Einzelschlag sofort frei.
   Gemessen (`4c`): Anna 18.967 Kraft gegen Bens 6.044 ergibt Beiträge von 19.665 zu 6.267, während
   **Ben** ausgelöst hat.
2. **Die Teilnehmer kommen aus dem VERSAND, nicht aus den Beitritts-Dokumenten.** `checkdispatch`
   friert sie als `dispatch.participants` ein. Ein Beitritt lässt sich bis zum Abflug zurückziehen;
   beim Auflösen erneut zu lesen wäre eine zweite Quelle, die inzwischen eine andere sein kann. Für
   Dokumente aus der Zeit davor gibt es einen Rückfall auf `participantIds` (dort zählen alle
   gleich, weil ihre Einzelkräfte nicht mitgeschrieben wurden).
3. **`claim` gibt bei einem Nest NUR die Schiffe zurück** und zahlt die Basisangriffs-Währung
   nicht. Die Nest-Belohnung liegt bereits anteilig in `__pendingRewards` (über den gemeinsamen
   Kern) – beides zu zahlen wäre eine Doppelzahlung für dasselbe Ereignis. Gegenprobe: mit
   ausgebautem Zweig fällt `5b`.

### Der Test

`tests/test_muster_nest_http.js` (Port 3228, **22 Prüfungen, drei Gegenproben** – Rechteprüfung,
Beitrags-Verteilung, Doppelzahlung; alle in beide Richtungen gefahren, überall dieselben 22
Prüfnamen). **Belegte Testports sind jetzt 3195–3200 und 3210–3228** – ein neuer Test nimmt 3229.

Zwei Fallen, die je einen Anlauf gekostet haben und beide schon dokumentiert waren:

- **`ALLIANCE_MUSTER_TEST_MODE` liest `ALLIANCE_RAID_TEST_MODE`** (derselbe Schalter wie beim
  Raid). Wer den naheliegenden Namen setzt, bekommt „Ungültige Anfrage" – die Sammeldauer 2 s steht
  nicht in `ALLIANCE_MUSTER_DURATIONS`.
- **Der Spielstand liegt in ZWEI Formen vor** (blanke Zeichenkette oder `{ value, version }`).
  Der Test starb beim Aufbau seiner Messvorrichtung an `JSON.parse('[object Object]')`, sobald
  `claim` den Spielstand geschrieben hatte – und führte die restlichen Prüfungen nie aus
  (Frontend-Arbeitsregel 34). Genau derselbe Anlauf wie beim Nest-Test; seither hat auch dieser
  Test ein `liesSave()`.

Und eine dritte, die den Wert des Protokolls zeigt: Vor der Behebung waren `5b` und `5c` **grün,
aber aus dem falschen Grund** – `claim` hatte mit 404 geantwortet, es war also gar nichts passiert
(Frontend-Arbeitsregel 28). Erst als die Kette lief, haben sie etwas gemessen.

## Zwei PvE-Meilenstein-Embleme (Phase 6, 21.08.2026)

`em_festungsbrecher` (25 geschleifte Asteroidenfestungen) und `em_schwarmbrecher` (eine gefallene
Alien-Königin). Der Kosmetik-Katalog kannte bis dahin keinen einzigen Weg über die neuen PvE-Ziele.

**Die Zähler liegen am NUTZEROBJEKT (`user.pveKills`), nicht im Spielstand** – dieselbe
Entscheidung wie bei `staub.abwehrGesamt` und aus demselben Grund: Ein Emblem steht in der
BESTENLISTE, also auf einer Fläche, die allen gehört. Der Spielstand ist klientenautoritativ; ein
Zähler darin wäre in fünf Sekunden gefälscht.

**Gezählt wird dort, wo der Server das Ereignis SELBST beobachtet** – beim Fall einer Festung und
beim Fall einer Königin, und zwar für **jeden Beitragenden**. Wer ein Drittel des Schadens getragen
hat, hat die Festung genauso geschleift wie der, der zufällig den letzten Schlag führte; das ist
dieselbe Überlegung, die den Hort anteilig auszahlt. Beide Zähler wachsen nur und gehören deshalb
**nicht** in `kosmetikBefristet()`.

**Die Schwellen sind gerechnet, nicht geschätzt.** Eine Festung braucht vier bis sieben Schläge bei
6 h Abklingzeit, also ein bis zwei Tage für EINE – 25 Stück sind damit ein Ziel über Wochen,
vergleichbar mit `em_schaedel` (30 Sektor-Bosse). Die Königin zählt bewusst **einmal**: Sie
erscheint erst ab vier Nestern eines Volkes, fällt mit 4 Mio LP praktisch nur im Verband und reißt
den ganzen Schwarm mit.

**Die Auslieferung muss mit dem Frontend zusammen erfolgen.** `tests/test_kosmetik_paritaet.js` im
FRONTEND-Repo vergleicht `KOSMETIK_DEFS` gegen `KOSMETIK_LOOK`; ein Stück, das nur eine Seite
kennt, lässt ihn fallen – in beide Richtungen. Das ist kein Mangel, sondern der Zweck des Tests.

Die 1f-Schleife von `test_kosmetik_http.js` deckt die zwei neuen Arten automatisch NICHT ab: Sie
filtert auf Bedingungsarten, die aus dem SPIELSTAND kommen (`ausSpielstand`), und diese beiden
kommen aus dem Nutzerobjekt – genau wie `kauf` und `abgewehrt`.

**Nachgemessen bei der adversarischen Prüfung des Änderungssatzes (21.08.2026), weil der Einwand
kam, die Zähler hingen letztlich an einer klientenautoritativen Flottenangabe.** Das stimmt für die
zugrundeliegende Schlagkraft und ist die dokumentierte Projektgrenze – aber die Einordnung fällt
zugunsten der neuen Bedingungen aus. Gemessen an `kosmetikBedingungErfuellt`, woher jede Art ihren
Wert nimmt:

| Nutzerobjekt (`findUserById`) | Spielstand (klientenautoritativ) |
|---|---|
| `kauf`, `abgewehrt`, **`festungen`**, **`koeniginnen`** | `prestige`, `aufstieg`, `kampfpunkte`, `abgrund`, `erfolge`, `bosse` |

**Sechs** bestehende Bedingungen lesen also direkt aus dem Spielstand – `em_schaedel` (30
Sektor-Bosse) ist der nächste Verwandte der zwei neuen und steht auf der schwächeren Seite. Die
Phase-6-Zähler sind damit besser verankert als die Nachbarn, die sie ergänzen; ein Handlungsbedarf
folgt daraus nicht.

**Ein Befund der Prüfung betraf allerdings das FRONTEND und war ein ausgelieferter Datenverlust:**
`POST /api/pending-rewards/claim` entfernt die Belohnung mit `list.shift()` + `saveDb()`, bevor sie
den Client erreicht – es gibt keinen zweiten Versuch. Die zwei Client-Zweige `festung` (v8.569.0)
und `alien-nest` (v8.582.0) riefen als EINZIGE der acht kein `save()`. Wer den Reiter nach dem
Spielstart schloss, verlor Hort, Protomaterie, Kampfpunkte, Erfahrung und Kredite endgültig.
Behoben im Frontend; Wächter dort `tests/test_belohnungen_speichern.js`. **Für dieses Repo folgt
daraus die Prüffrage bei jeder künftigen Warteschlange: Wer den Eintrag beim Ausliefern LÖSCHT,
verpflichtet den Empfänger zum sofortigen Speichern** – das gehört in die Beschreibung des
Endpunkts, nicht in die Erinnerung des Client-Autors.

## Die wandernden Beute-Ziele – Wrackkonvois (A2, 28.08.2026)

Auftrag Sascha „beide umsetzten" (A2 wandernde Beute-Ziele UND B2 Vorposten). Konzept:
`docs/wandernde-beute-ziele-konzept.md` im FRONTEND-Repo. Der Code trägt einen ausführlichen
Doku-Block an der Konstantendefinition (`const A2_SPAWN_AKTIV`); hier stehen nur die
Entscheidungen, die man kennen muss, bevor man etwas ändert.

**A2 ist KEIN dritter Nomaden-Klon.** Es hebt sich vom Vex-Nest über ZWEI Achsen ab, die dem Nest
gemessen fehlen:

1. **Exklusive Beute über das Herkunfts-Schloss.** Der Fall wirft `kv_bergungslogik` (Standort,
   `effect:'prod'`) UND `kv_bergungspanzer` (Schiff, `effect:'hull'`, Klasse `schwerelinie`), beide
   mit `quelle:'konvoi'`. `fundPool` schließt sie damit aus jedem regulären Fundtopf und beiden
   Schmieden aus; vergeben werden sie ausschließlich über den A2-Schlag. `kv_bergungspanzer` ist
   PvP-relevant und steht deshalb in `SHIP_MODULE_COMBAT_BASE` – **Kopie-Familie**, Parität gegen
   das Frontend Pflicht (`test_A2_http.js` 8e).
2. **Das ENTKOMMEN – der Kern-Reiz.** Ein Nest verschwindet durchs Ignorieren nie
   („weitergezogen" heißt „ins Nachbarsystem, weiter angreifbar"). Ein A2-Ziel dagegen wird nach
   `A2_LEBENSDAUER_MS` (18 h) **ganz** aus `db.galaxy.wrackKonvois` entfernt. Wer zu lange zögert,
   verliert es. Der Endpunkt braucht dafür einen dritten `verpasst`-Grund `'entkommen'`, den er aus
   einer kurzen `a2Verlauf`-Spur (id → grund, gedeckelt auf 40) liest; ein Miss fällt harmlos auf
   `'gefallen'` zurück, weil beide Ausgänge folgenlos sind.

**Ablageort ist `db.galaxy.wrackKonvois`, nicht `db.shared`.** Damit ist die ganze Fehlerklasse
„offener Shared-Storage" umgangen (kein `checkKeyPermission` nötig – dieselbe Wahl wie bei den
Alien-Nestern), und `galaxyFuerClient()` schickt das Feld automatisch lesend an den Client. Der
Client-Feldname ist bewusst der Spielbegriff `wrackKonvois`, nicht der Etappencode – er ist Teil
des Client-Vertrags wie `alienNester`. Die internen Helfer (`A2Tick`, `a2Liste`, `A2_*`) behalten
den Etappen-Prefix.

**Die Abklingzeit liegt AM ZIEL** (`ziel.schlaege[uid]`), nie im Spielstand – genau wie bei Nest
und Festung, und aus demselben Grund (klientenautoritativer Spielstand). `A2_ABKLING_MS` = 2 h.

**Die LP sind gegen die kalibrierten Nest-/Festungs-Schläge gerechnet** (Regel 41), nicht gegen
ein Gefühl: `A2_LP` = 40.000 ist die Größenordnung des Sporenherds (Einsteiger-Nest), rund
5,3 / 0,9 / 0,2 Schläge bei den gemessenen Schlagkräften 7.500 / 44.000 / 240.000. Solo-tauglich –
das ist der Auftrag. In der Lebensdauer bekommt ein Solo-Konto 9 Schläge, deutlich mehr als die
nötigen ~5,3.

### Der gemeinsame Kern mit dem Nest, und die zwei Reward-Felder

Der Schaden läuft durch `A2SchlagAusfuehren` (eigener Rechenkern, KEIN Rollenfaktor/keine
Schwäche – ein Wrackkonvoi ist ein flacher Wurf). **Gezählt wird der ANGEKOMMENE Schaden**
(`lpVorher - lp`), nicht der volle Wurf – dieselbe Entscheidung wie beim Festungsschlag, und
`test_A2_http.js` 3a misst sie mit dem sprechenden Hinweis. Der Server schreibt den Spielstand des
Angreifers **nicht**; die Verluste reisen als Quote in der Antwort, der Client bucht sie.

**Die Belohnung trägt Feldnamen auf DEUTSCH und zwei unabhängige Modulwürfe:**
`{ type:'wrackkonvoi', system, anteil, essenz, kampfpunkte, xp, credits, modul?, kampfmodul?, zeit }`.
`essenz` (nicht `essence`) geht im Frontend nach `state.ascension.essence`. Die zwei Modulfelder
werden **getrennt** gewürfelt (`Math.random() < anteil * A2_MODUL_CHANCE`, Basis 0,3) – der
Claim-Zweig muss BEIDE behandeln. Ausgezahlt wird an **alle** Beitragenden über `pushPendingReward`
mit dem EIGENEN `type:'wrackkonvoi'`; ohne den fällt sie im Client in den „+500 Kredite für deinen
Bug-Report"-Rückfall (`test_A2_http.js` 4b, Gegenprobe `typ`).

### Der Notausschalter und die Auslieferungsreihenfolge

`A2_SPAWN_AKTIV` steht auf **`false`** – Notausschalter und Auslieferungs-Riegel (Regel 60): A2
wirft ein PvP-relevantes Kampfmodul ab, also muss das Backend VOR dem Frontend live sein und der
Schalter erst im Frontend-PR umgelegt werden. Solange er aus ist, kehrt `A2Tick` in Zeile 1 zurück
und der ganze Abschnitt tut nichts. `test_A2_http.js` Abschnitt 9 hält den Stand fest (jetzt
`false`); beim Umlegen wird die Prüfung mit umgestellt, damit ein versehentliches früheres Kippen
auffällt – dasselbe Muster wie `test_festung_http.js` Abschnitt 10.

Wächter: `tests/test_A2_http.js` (**Port 3234**, 35 Prüfungen, vier Gegenproben je mit „was fällt
MUSS"-Liste: `schaden`→3a, `abkling`→2a, `entkommen`→5e-grund, `typ`→4b). Der Test startet eine
**Kopie** von `server.js` mit umgelegtem Schalter (`server_a2test_tmp.js` im Repo-Verzeichnis,
`require('./mailer')` löst dort auf), sonst tut `A2Tick` nichts – dasselbe Muster wie
`test_alien_nester_http.js`. **Belegte Testports sind jetzt 3195–3234.**

## Passwort-Regeln beim SETZEN (19.08.2026, Sicherheits-Audit P5)

`passwortProblem(passwort, username)` ist die EINE Wache für neu gesetzte Passwörter. Sechs Regeln:
Mindestlänge 8, Abgleich gegen `passwoerter-bekannt.txt`, lauter gleiche Zeichen, reine
Ziffernfolgen, der eigene Spielername, der Name des Spiels.

**Die wichtigste Eigenschaft ist, wo sie NICHT aufgerufen wird: niemals im Login.** Wer ein
6-Zeichen-Passwort hat, meldet sich weiter damit an – eine neue Regel begrenzt das HINZUFÜGEN, nie
den Bestand. Das ist dieselbe Überlegung wie bei „Deckel dürfen niemals Daten löschen", nur auf eine
Zugangsregel angewandt, und sie wiegt hier schwerer: Ein ausgesperrtes Konto kommt nur über einen
Reset zurück, den man per E-Mail erst anfordern muss. Die vier `bcrypt.compare`-Stellen bleiben
unberührt; aufgerufen wird an den zwei `bcrypt.hash`-Stellen (Registrierung Z. ~1725, Reset ~2049).

**Der Testbestand ist der lebende Beleg dafür:** ACHT bestehende Tests legen ihren Nutzern per
`bcrypt.hashSync('test1234')` ein Passwort in die DB, das auf der Liste STEHT – und melden sich
weiterhin an. Wäre die Prüfung fälschlich im Login gelandet, wären sie alle acht rot.

**Die Liste enthält bewusst nur Einträge ab 8 Zeichen.** Kürzere fängt die Längenregel ohnehin ab,
bevor die Liste befragt wird; von den 10.000 der Quelle (SecLists, MIT) bleiben so 2.086 wirksame,
plus einer deutschen Ergänzung – die englische Liste kennt `passwort123` nicht. **Wer die
Mindestlänge je senkt, muss die Liste neu aus der Quelle ziehen**, sonst fehlen ihr genau die
kurzen Passwörter, die dann wieder erlaubt wären.

**Fehlt die Datei, läuft der Dienst weiter** und protokolliert es laut. Das ist bewusst anders
entschieden als bei `API_KEY` in AI Core (Befund A desselben Audits), und der Unterschied ist der
Grund: Dort WAR die Konfiguration die Sicherung, ihr Ausfall hob den ganzen Schutz auf. Hier ist die
Liste eine von sechs Regeln. Damit der Ausfall trotzdem nicht wie Normalbetrieb aussieht, ZÄHLT der
Test die Einträge, statt nur ihre Existenz zu prüfen.

**Die Prüfung im Reset steht HINTER `findUserById`** – nur so kennt sie den Spielernamen des Kontos
hinter dem Token. Der Token ist an der Stelle längst geprüft.

**Parität zum Frontend ist Pflicht.** Das Spiel prüft die Länge vorab (Komfort), die Liste bleibt
hier – eine Kopie im Frontend wäre eine zweite Wahrheit und 19 kB in einer Datei, die jeder Spieler
lädt. `tests/test_passwortregeln.js` im FRONTEND-Repo hält `PASSWORT_MIN` gegen die dortige Zahl;
läuft sie auseinander, entsteht genau die Abweichung, vor der das Auslöser-Video warnt.

`tests/test_passwortregeln_http.js` (Port 3223, 19 Prüfungen; **belegte Testports sind jetzt
3195–3200, 3210–3223** – ein neuer Test nimmt 3224). Zwei Lehren aus seiner Gegenprobe:

- **`qqqqqqqq` misst die falsche Regel** – jede achtfache Buchstaben-Wiederholung steht bereits auf
  der Liste, dort hätte also die Listen-Regel geantwortet. Aufgefallen ist es nur, weil die Prüfung
  den GRUND verlangt und nicht bloß den Statuscode. Sie misst jetzt `########`.
- **Ein einziger Reset-Token deckte vier Prüfungen zu.** Am alten Stand ging die erste durch und
  verbrauchte ihn dabei; die vier folgenden scheiterten danach an „Link ist ungültig" statt an dem,
  was sie messen wollten – vier Fehlschläge aus dem falschen Grund, die die Gegenprobe stärker
  aussehen ließen, als sie war. Jede Reset-Prüfung hat jetzt einen eigenen Token. **Übertragbar:
  Wer eine Ressource prüft, die der Erfolgsfall VERBRAUCHT, braucht je Prüfung eine eigene.**

## Sitzungs-Cookie (19.08.2026, Sicherheits-Audit P3, Etappen a und b)

Der Token liegt im Frontend in `localStorage` und ist damit in JS-Reichweite. Diese Etappe legt ihn
**zusätzlich** in ein HttpOnly-Cookie (`kepler7_sid`), das JavaScript gar nicht erst lesen kann.

**Sie ist für sich genommen KEIN Sicherheitsgewinn**, und das gehört klar gesagt: Solange das
Frontend den Token weiter in `localStorage` legt und per Bearer schickt, ist die Angriffsfläche
unverändert. Was sie leistet, ist die **Reihenfolge**:

- **Etappe a (dieser Stand)** ist rein additiv und ändert für jeden bestehenden Client exakt
  nichts. Sie darf jederzeit allein live gehen – auch bei hängender Auslieferung.
- **Etappe b (Frontend)** darf das NICHT. Ein Frontend, das nur noch auf das Cookie setzt, wäre
  gegen einen Server ohne diesen Block sofort abgemeldet – **jeder Spieler, gleichzeitig**. Genau
  deshalb die Teilung und nicht ein einzelner großer Umbau. **Sie ist seit dem 19.08.2026 gebaut**
  (Abschnitt darunter); der Backend-Teil davon muss vor dem Frontend live sein.

**Vier Entscheidungen, die man beim Anfassen kennen muss:**

1. **Der Bearer-Header hat VORRANG vor dem Cookie.** Solange a und b auseinander liegen, trägt ein
   Browser beides; maßgeblich muss das sein, was das Frontend bewusst mitschickt. Ein alter
   Cookie-Rest würde sonst ein frisch angemeldetes Gerät überstimmen.
2. **Kein `cookie-parser`.** Für das Lesen *eines* Namens ist eine Abhängigkeit ein schlechter
   Tausch – `leseCookie()` sind zwölf Zeilen. (Die frühere Begründung „das verlangt ein
   `docker restart` von Hand" gilt seit dem 28.08.2026 nicht mehr: Der Selbst-Neustart startet den
   ganzen Container neu, und `npm install` läuft dabei mit. Eine neue Abhängigkeit ändert immer
   auch Code, also greift der Neustart auch wirklich.)
3. **`Secure` hängt an `req.secure`, nicht an einer Konfiguration.** Der erste Entwurf prüfte
   `PUBLIC_URL.startsWith('https://')` – das sah nach einer Entscheidung aus und war keine:
   `web-push` verlangt für das VAPID-Subject zwingend `https:` oder `mailto:` und lässt den Server
   sonst **gar nicht erst starten** (gemessen: „Vapid subject is not an https: or mailto: URL").
   Die Bedingung wäre also immer wahr gewesen. `req.secure` misst, was wirklich anliegt, und ist
   dank `app.set('trust proxy', 1)` auch hinter dem nginx des Pi korrekt.
   **Übertragbar: Eine Fallunterscheidung über eine Konfiguration, die nur einen Wert annehmen
   KANN, ist keine** – dieselbe Familie wie das `st.proto`-Feld, das nur der Ankündigungstext las.
4. **`SameSite=Lax`, nicht `Strict`.** Das Spiel wird auch aus Mails heraus geöffnet (Bestätigungs-
   und Reset-Links), und `Strict` schickt bei genau diesem Aufruf kein Cookie mit.

`tests/test_sitzungscookie_http.js` (Port 3225 belegt der Gegenprobe-Lauf mit, **belegte Testports
sind jetzt 3195–3200 und 3210–3225** – ein neuer Test nimmt 3226). Die Gegenprobe hat eine
Besonderheit, die man kennen sollte: **Prüfung 3 (der Bearer-Weg funktioniert) muss an BEIDEN
Ständen grün sein.** Bei einer additiven Änderung heißt „richtig" ja gerade, dass sich für
bestehende Clients nichts ändert – wäre sie am alten Stand rot, hätte man etwas kaputtgemacht. Das
ist die Umkehrung des Normalfalls und gilt nur für genau diese eine Prüffrage.

### Etappe b: was der Server dazu beitragen MUSS (19.08.2026)

Etappe b dreht die Richtung um – das Frontend legt den Token nicht mehr in `localStorage`, die
Sitzung trägt das Cookie. Zwei Löcher entstehen dabei, die **ausschließlich** der Server schließen
kann; ohne sie wäre der Umbau im Frontend gar nicht durchführbar.

**1. `POST /api/logout` – bewusst OHNE `authMiddleware`.** Ein HttpOnly-Cookie kann JavaScript
nicht löschen, das ist ja sein Zweck. Ohne diese Route hätte ein Klick auf „Abmelden" den
localStorage-Rest weggeräumt, neu geladen – und das Cookie hätte den Spieler stillschweigend
**wieder angemeldet**. Ein Abmeldeknopf, der nicht abmeldet, ist schlimmer als keiner.
Die fehlende Wache ist der Zweck und keine Nachlässigkeit: Wer ein Sitzungsgeheimnis loswerden
will, darf daran nicht scheitern, weil genau dieses Geheimnis schon abgelaufen oder unsinnig ist.
Zu holen gibt es nichts – die Route liest nichts, schreibt nichts und kann nur die Kopfzeile ihres
eigenen Aufrufers löschen; ein fremder Auslöser käme wegen `SameSite=Lax` ohnehin ohne Cookie an.
**Sie entwertet die Sitzung BEWUSST NICHT serverseitig.** Das ist die ehrliche Grenze der Etappe:
Sie übersetzt, **wo** der Token liegt, nicht was Abmelden bedeutet – vorher blieb ein
ausgestelltes Token nach dem Abmelden ebenfalls gültig, es hatte nur niemand mehr. Wer die Sitzung
wirklich entwerten will, nimmt „Alle Sitzungen beenden". `test_logout_cookie_http.js` 7 misst das,
statt es nur zu behaupten.

**2. Cookie-Nachreichung in `authMiddleware`.** Wer sich zuletzt vor dem 19.08.2026 angemeldet hat,
hat gar kein Cookie – nur den Token in `localStorage`, also genau dort, wo die erste XSS-Lücke ihn
abholen würde. Das JWT läuft 180 Tage; ohne diese drei Zeilen hätte die Behebung für diese Spieler
**ein halbes Jahr** gebraucht. Kommt ein vollständig geprüfter Bearer **ohne** Cookie an, stellt der
Server eines aus; beim nächsten Seitenaufruf trägt es die Sitzung, und das Frontend räumt den
gespeicherten Token weg. Zwei Seitenaufrufe, keine Nutzeraktion.
**Nur wenn gar kein Cookie anliegt** – ein vorhandenes zu überschreiben könnte eine frische
Anmeldung durch einen älteren Bearer-Rest ersetzen. Und sie steht **hinter** der vollständigen
Prüfung (Signatur, Sperre, `tokenVersion`, `sid`); davor könnte sich jeder mit einem erfundenen
Header ein Cookie ausstellen lassen.

**Der Fehler, den der eigene Test gefangen hat – und die Regel daraus.** Die Nachreichung feuert
auch auf `/api/logout-all`: Dort kommt ein Bearer ohne Cookie an. Die Antwort trug danach **zwei**
`Set-Cookie`-Zeilen – erst eine frische Sitzung über 180 Tage, dann deren Löschung. Welche gewinnt,
entscheidet die Reihenfolge im Browser; darauf zu bauen ist ausgerechnet in einer Abmeldung der
falsche Ort. Behoben **nicht** durch eine Ausnahmeliste für Routen, sondern in
`loescheSitzungsCookie()`: Es wirft jede schon angehängte Zeile für dieses Cookie weg, bevor es die
Löschung setzt. **Wer dieses Cookie löscht, meint es – und nichts weiter oben in derselben Antwort
darf ihm widersprechen.** Das gilt damit für jede künftige Route, nicht nur für die zwei von heute.
Bezeichnend ist, wie knapp es sichtbar wurde: Die Prüfung hätte nur `Max-Age=0` irgendwo in den
Kopfzeilen verlangt, wäre sie **mit** dem Widerspruch grün geblieben. Sie verlangt jetzt **genau
eine** Zeile – die REGEL statt der Momentaufnahme (Frontend-Arbeitsregel 3).

**Und die Zeile, die jeden Spieler gleichzeitig ausgesperrt hätte** – gemessen im Browser, bevor
etwas gebaut wurde: `'Bearer '+authToken` ergibt bei `authToken === null` wörtlich den Header
`Bearer null`. `authMiddleware` sieht damit einen Bearer-Header und schaut das Cookie **gar nicht
mehr an**; jede frische Anmeldung wäre in einen 401 gelaufen. Das Frontend setzt den Header
deshalb nur noch bei wirklich vorhandenem Token. Dieselbe Messung hat nebenbei gezeigt, dass
`credentials: 'include'` überhaupt nicht gebraucht wird: Ein nacktes `fetch()` schickt das Cookie
bei gleicher Herkunft von selbst mit (Gegenprobe `credentials:'omit'` – dann nicht).

`tests/test_logout_cookie_http.js` (Port 3226, 14 Prüfungen; **belegte Testports sind jetzt
3195–3200 und 3210–3226** – ein neuer Test nimmt 3227). Am alten Stand fallen 5 (Route fehlt,
nichts wird nachgereicht), bei identischen Prüfnamen in beiden Läufen. **Drei Prüfungen müssen in
BEIDE Richtungen grün sein** und sind der Beleg statt eines Mangels: 6 (der Bearer-Weg funktioniert
unverändert) sowie 4 und 5 (es wird NICHT nachgereicht, wo es nicht soll).

Eine Falle beim Auswerten der Gegenprobe, die hier zugeschlagen hat: `grep -cE '^(OK|FAIL) +- '`
über das Protokoll meldete **15** statt 14 – die Schlusszeile `FAIL - es gab rote Pruefungen.`
passt auf dasselbe Muster. Verglichen werden deshalb die Prüf-NAMEN beider Läufe per `diff`, nicht
ihre Anzahl (Frontend-Arbeitsregel 60, hier zum zweiten Mal bestätigt).

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

### AUSFALL NR. 12 (22.–28.08.2026) – der Rest lag im ARBEITSBAUM, nicht im Index

Der Merge von #168 kam nicht an. Gemessen unmittelbar danach und über sechs Tage hinweg unverändert:

```
{"commit":"c96defa","checkout":"c96defa","blob":"76c6e4e","uptimeSec":…}
```

Derselbe Flickenteppich wie Nr. 9 und Nr. 11: `blob` ist der **neue** (`0f1454b:server.js`), der
Prozess führte die angeglichene Fassung also bereits aus, während `.git/HEAD` auf dem alten Commit
stand. Die Kausalitätsbrecher-Angleichung war damit **live und korrekt** — nur git war verklemmt,
und jeder weitere Pull wäre abgeprallt.

**Der Ausfall lief sechs Tage und hat trotzdem keinen weiteren Schaden angerichtet**, weil in dieser
Zeit nichts ins Backend gemergt wurde. Das ist Glück, keine Eigenschaft: `origin/master` stand die
ganze Zeit auf demselben Commit. Ein einziger Merge hätte den Stau sofort sichtbar gemacht.

**Neu an diesem Fall ist die SPALTE.** Saschas Messung:

| | Blob | zugeordnet |
|---|---|---|
| `server.js` Arbeitsbaum (`git hash-object`) | `76c6e4e` | **neu** (0f1454b) |
| `CLAUDE.md` Arbeitsbaum | `5881aa0` | **neu** (0f1454b) |
| `server.js` **Index** (`git rev-parse :server.js`) | `0a31941` | **alt** (c96defa) |

`git status --short` zeigte ` M` mit dem M in der **zweiten** Spalte — Arbeitsbaum geändert, Index
unberührt. Bei Nr. 9 war es genau andersherum (vorgemerkt, `M ` in der ersten Spalte). **Davon hängt
ab, ob `git checkout HEAD -- <datei>` überhaupt greift**, und deshalb werden seither beide gemessen,
bevor irgendetwas verworfen wird. Hier griff es.

**Und ein Fehler in meiner eigenen Reparaturanleitung, der eine Runde gekostet hat** (Regel 54, zum
zweiten Mal in derselben Familie): Ich hatte nur `server.js` versorgt, obwohl mein Commit **drei**
Dateien anfasste — Saschas `git pull` brach danach an `CLAUDE.md` ab. Die Regel steht seit dem
17.08. im Frontend-Dokument, dort für eine Sicherung vor einem Rebase; sie gilt genauso für eine
Reparaturanleitung: **nicht überlegen, was zu versorgen ist, sondern `git status --short` lesen und
JEDE Zeile versorgen** — und noch billiger wäre `git show --stat <hash>` gewesen, das die Dateien
nennt, die der halb angewendete Pull auf dem Pi hinterlassen haben MUSS.

Behoben mit Rückschreiben und Vorspulen in einer Kette, damit der Server nicht unnötig lange auf dem
alten Code neu startet:

```bash
git checkout HEAD -- server.js CLAUDE.md && git merge --ff-only origin/master
```

Danach von außen belegt: `{"commit":"0f1454b","checkout":"0f1454b","blob":"76c6e4e","uptimeSec":53}`
— alle drei Felder einig, nodemon hat neu gestartet.

## Deploy-Alarm: ein gescheiterter Deploy meldet sich selbst (22.08.2026)

Auftrag Sascha (AI-Hub-Runde). Anlass: die **Serie** von Deploy-Ausfällen seit dem 14.08. wurde
durchweg erst zufällig bemerkt – der Webhook schrieb seinen Fehler ausschließlich ins
Container-Log, das niemand liest, und nichts holte einen gescheiterten Pull später nach.

`deployAlarm(repoName, betreff, detail)` sitzt an BEIDEN Fehlerausgängen von `starteDeploy`
(Zeitüberschreitung und Befehlsfehler) und schickt eine Mail an `DEPLOY_ALARM_MAIL` über
denselben Resend-Mailer wie Verify/Reset – mit Grund, stderr-Auszug und den drei nächsten
Schritten (Container-Log, `/api/health`-Dreifelder-Vergleich, Rettungsweg-Abschnitt).

**Vier Entscheidungen, die man beim Anfassen kennen muss:**

- **Bewusst FAIL-OPEN** – das Gegenstück zur fail-closed Signaturprüfung darunter, und der
  Unterschied ist der Punkt: Die Signaturprüfung ist eine SICHERUNG (ihr Ausfall öffnet etwas),
  der Alarm ist eine BENACHRICHTIGUNG (sein Ausfall lässt nur den alten Zustand zurück). Fehlt
  die Adresse oder scheitert Resend, läuft der Deploy-Weg unverändert – aber der Ausfall wird
  BENANNT („DEPLOY_ALARM_MAIL ist nicht gesetzt") statt verschwiegen. Test 8b hält das fest.
- **Höchstens eine Mail je Repo und Stunde** (`DEPLOY_ALARM_PAUSE_MS`): Ein dauerhaft kaputter
  Deploy feuert bei JEDEM Push doppelt (Branch-Push + Merge), und ein Postfach voller
  identischer Alarme ist so unlesbar wie das Container-Log. Die Drossel sitzt HINTER der
  Protokollzeile – jeder Fehlschlag bleibt im Log sichtbar, gedrosselt wird nur der Versand
  (Test 8c). Der Zähler lebt bewusst nur im RAM: Im Fehlerfall ändert sich `server.js` gerade
  NICHT, nodemon startet also nicht neu, und die Stunde hält.
- **`DEPLOY_ALARM_MAIL` muss auf dem Pi als Container-Env gesetzt werden** (plus vorhandenes
  `RESEND_API_KEY`) – eine Env-Änderung braucht ein Neuerzeugen des Containers, der Webhook-Pull
  allein reicht dafür nicht.
- Wächter: `tests/test_deploy_webhook_http.js` Abschnitt 8 (am echten gescheiterten Deploy
  gemessen, nicht am Quelltext). Gegenprobe beidseitig: am Stand davor fallen genau 8a/8b/8c.

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

## Bekannte Fallstricke

- **Backend hat teils eigene Kopien von Frontend-Formeln** zur serverseitigen Validierung (z.B. `ALLIANCE_STRUCTURE_COSTS`/`ALLIANCE_EXPANSION_BONUSES` gegen echte Allianz-Beiträge, `SHIP_SCORE_WEIGHTS`/`computeScoreServer()` gegen `computeScore()` im Frontend für den Bestenlisten-Score, seit v8.565.0 auch `WORLDBOSS_ARCHETYPES_PLAYABLE`/`WORLDBOSS_ARCHETYPE_FOLGE` gegen die gleichnamigen Frontend-Tabellen – die FOLGE muss deckungsgleich sein, sonst zeigt die Boss-Karte andere Kampffaktoren an, als `/api/worldboss`-Kämpfe benutzen; Wächter ist `test_inhalt_v8373.js` im Frontend-Repo, 60 Stufen). Bei Änderungen an der jeweiligen Frontend-Formel **immer** die Backend-Kopie mitpflegen, sonst lehnt der Server legitime Aktionen ab, lässt zu wenig durch, oder validiert gegen einen veralteten Score.
- **Generischer Shared-Storage ohne Sonderregel ist für JEDEN eingeloggten Nutzer weit offen** (lesen UND schreiben) – nicht nur für Mitglieder der jeweiligen Allianz/Gruppe. Neue sicherheitsrelevante Unterressourcen brauchen eine explizite Prüfung in `checkAllianceKeyPermission()` (oder einer äquivalenten Funktion für neue Systeme), sonst kann jeder Beliebige den Wert manipulieren.
- **Wo die Sicherheitsgrenze in diesem Spiel wirklich verläuft** (Audit des geteilten Speichers, 10.08.2026): Der eigene Spielstand ist bauartbedingt **klientenautoritativ** – der Server prüft ihn nur gegen die großzügigen `SAVE_SANITY_LIMITS` (Kredite bis 1e12), rechnet ihn aber nicht nach. Wer sich selbst bereichern will, braucht dafür also gar keine Lücke im geteilten Speicher; das zu schließen wäre ein eigenes, sehr großes Vorhaben (serverseitige Simulation der gesamten Wirtschaft). Die Grenze, die tatsächlich verteidigt wird und an der alle bisherigen Härtungen liegen, ist deshalb: **„Kann ich etwas anfassen, das ANDEREN gehört oder allen gemeinsam?"** Bei einem neuen Befund zuerst diese Frage stellen – sonst meldet man als Lücke, was in Wahrheit schon über den Spielstand offensteht (genau dieser Irrtum stand beim Weltboss-Fund kurz im Raum und wurde erst durch einen Blick auf `saveSanityViolation` ausgeräumt).
- **Stand der Rechteprüfungen im geteilten Speicher** (nach dem Audit vom 10.08.2026): geprüft sind `alliance:*`, `pact:*`, `globalchat:msg:*`, `halloffame:records`, `moondefense:*`/`moonsiegelog:*`, `leaderboard:*` und `spyping:*` (die letzten beiden inline in der PUT-Route) sowie neu `worldboss:current` und `missions:*`. **Bewusst ohne Regel bleibt `alliancehist:<TAG>`** – ein Punktestand-Schnappschuss je Allianz für den Trendpfeil. Eine Eigentumsprüfung ist dort nicht möglich, weil `updateAllianceHistory()` im Frontend nach dem „opportunistischen Cron"-Prinzip die Historie **aller** Allianzen fortschreibt, nicht nur der eigenen; jeder Spieler schreibt dort also legitim fremde Tags. Der Missbrauch beschränkt sich auf einen falschen Trendpfeil (rein kosmetisch, keine Belohnung daran gebunden). Wer das schließen will, braucht eine Wertprüfung gegen den serverseitig berechneten Allianz-Score – nicht eine Eigentumsprüfung.
- **"Letzter Admin verlässt die Allianz"**-Art von Randfällen: bei mehrstufigen Freigabe-Refactors (z.B. "letzter Admin darf nicht mehr verlassen") prüfen, ob interne Funktionen (wie Allianz-Auflösen, die selbst die eigene Rolle auf 'left' setzen) durch die neue Regel blockiert würden – eigene Rolle in solchen Fällen bewusst zuletzt schreiben.
- Reine Lese-Skripte (Analyse, Daten sammeln) sind risikolos gegen das echte Repo klonbar; **Schreiboperationen an der echten `db.json` auf dem Pi** immer nur über von Sascha manuell ausgeführte SSH-Befehle, nie direkt von hier aus.
- **Token-Invalidierung (`tokenVersion`)**: Jede neue `jwt.sign`-Stelle MUSS `tv: user.tokenVersion || 0` in den Payload aufnehmen – `authMiddleware` vergleicht `payload.tv` gegen `user.tokenVersion`, ein fehlendes `tv` (=0) würde bei Konten mit hochgezähltem `tokenVersion` sofort als ungültig gelten. `tokenVersion` wird beim Passwort-Reset hochgezählt (wirft alle alten Sitzungen raus); wer weitere „alle Geräte abmelden"-Aktionen baut, zählt es dort ebenfalls hoch.
- **Graceful Shutdown flusht die DB** bei `SIGTERM`/`SIGINT` (Stop) und `SIGUSR2` (nodemon-Neustart) einmalig auf Platte, bevor der Prozess endet – schützt nur-im-RAM gehaltene Felder (v.a. Analytics, die bewusst nicht pro Event speichern) vor Verlust bei jedem Deploy/Restart. Diese Handler nicht entfernen; neue „nur im RAM, wird beim nächsten saveDb mitgenommen"-Felder sind dadurch automatisch abgesichert.
- **`saveDb()` schreibt mit In-Flight-Coalescing**: Es läuft immer nur EIN Schreibvorgang; Aufrufe während eines laufenden Writes werden zu genau einem Folge-Write gebündelt (schreibt den dann aktuellsten Stand). Das zurückgegebene Promise löst weiterhin erst auf, nachdem ein Write mit der Änderung des Aufrufers durch ist – die `await saveDb()`-Semantik bleibt also erhalten. Nicht auf „ein Write pro Aufruf" zurückbauen. `db` immer VOR `saveDb()` synchron mutieren (nie im `await`-Callback nachträglich), sonst kann die Mutation einen Write verpassen.
- **CORS ist auf die Spiel-Domains beschränkt** (`CORS_ALLOWED`, überschreibbar per Env `CORS_ORIGINS`). Anfragen ohne Origin (Server-zu-Server wie Ko-fi-/GitHub-Webhooks, native Apps, same-origin) bleiben erlaubt. Ein neuer legitimer Browser-Client von einer anderen Domain braucht einen Eintrag in `CORS_ORIGINS`, sonst blockt der Browser ihn.

## Deploy

**Ein Push nach `master` geht von selbst live.** Bis zum 05.08.2026 stand hier „ändert von hier aus nichts automatisch" – das war überholt und hat zu falschen Auskünften geführt.

Der Weg: GitHub ruft nach jedem Push den **Deploy-Webhook** dieses Backends auf (`POST /api/deploy-webhook`, abgesichert per HMAC-SHA256 gegen `DEPLOY_WEBHOOK_SECRET`). Der Repo-**Name** aus dem Payload wählt einen von zwei **fest verdrahteten** Befehlen aus `DEPLOY_TARGETS` – nie etwas aus dem Request-Body, das schützt gegen Command-Injection. Für dieses Repo lautet er:

```
cd /app && git pull -q && (chown -R 1000:1000 .git || true)
```

Der Server antwortet sofort und lässt `git pull` asynchron weiterlaufen, weil GitHub eine schnelle Antwort erwartet. Das `chown` ist Pflicht: Der Container läuft als root und `/app` **ist** der Bind-Mount `/DATA/kepler7/backend` – ohne die Zeile gehören die erzeugten `.git/objects` root und Sascha kann in seinem eigenen Repo kein `git` mehr ausführen. Genau so hing der Pi am 05.08.2026 sechzehn Commits zurück.

Container-Setup (per `docker inspect` verifiziert, **umgebaut am 28.08.2026**): Startbefehl ist
`sh -c "git config --global --add safe.directory '*' && npm install --no-audit --no-fund && node server.js"`,
dazu `DEPLOY_SELBST_NEUSTART=1` und `restart: unless-stopped`. **Es läuft KEIN nodemon mehr im
Deploy-Pfad** – der Server beendet sich nach einem erfolgreichen Pull selbst, wenn sich geladener
Code geändert hat, und Docker startet ihn neu (Einzelheiten und die Messungen im Abschnitt
„nodemon fliegt aus dem Deploy-Pfad").

Der Webhook-Pull genügt damit für JEDEN Deploy, auch bei geänderter `package.json` – `npm install`
läuft beim Neustart mit. **Ein `docker restart kepler7-backend` von Hand braucht es nur noch, wenn
jemand auf dem Pi direkt an `server.js` etwas ausprobiert hat**: Diese Änderung kommt über keinen
Pull und löst deshalb auch keinen Neustart aus.

Das ältere Auto-Pull-Skript unter `deploy/autodeploy.sh` ist damit **hinfällig** – es löste dasselbe Problem vor dem Webhook und braucht keine Einrichtung mehr.

**Von außen messen, welchen Stand der Pi wirklich fährt** (Vorfall 14.08.2026: der Backend-Deploy
hing zum zweiten Mal, diesmal seit dem 10.08. – mindestens sechs Merges nie angekommen, während der
Frontend-Deploy desselben Webhooks einwandfrei lief): Eine Route, die es im laufenden Prozess gibt,
antwortet ohne Token mit **401** (authMiddleware), eine, die der laufende Code nicht kennt, mit
**404** („Cannot GET/POST …" von Express). Wer je Merge eine neue Route kennt, kann den Stand damit
ohne SSH eingrenzen – z.B. `curl -X POST https://gamegeeeeek.de/api/randkriege/lager` (existiert
seit #95): 401 = Stand mindestens 10.08., 404 = älter. Die Gegenprobe gehört dazu: eine ALTE Route
(z.B. `/api/musterattack/create`) muss im selben Lauf 401 liefern, sonst misst man die eigene
Messmethode. WICHTIG: `/api/health` mit 200 beweist nur, dass IRGENDEIN Backend läuft – nicht,
welches. Und der Frontend-Deploy kann funktionieren, während der Backend-Pull kaputt ist: Beide
laufen über denselben Webhook-Endpunkt, aber als getrennte fest verdrahtete Befehle.

**Nachtrag 15.08.2026 – DRITTES Mal, und diesmal mit ausgeliefertem Frontend davor.** Nach drei
Backend-Merges an einem Tag (#105 Testphase, #106 Kosmetik, #107 Sternenstaub) stand der Pi
weiterhin auf Code von VOR dem 15.08. Gemessen von außen nach der Methode oben, mit Kontrollroute
im selben Lauf:

```
cosmetics/buy          404   (#107, heute)
cosmetics              404   (#106, heute)
supporter/trial        404   (#105, heute)
randkriege/lager       401   (#95, 10.08.)
musterattack/create    401   (alte Kontrollroute)
```

Das Neue an diesem Mal ist die Wirkung: Der FRONTEND-Deploy lief durch. Die Spieldatei war also auf
v8.519.0 und fragte Routen ab, die es auf dem Server nicht gab – der neue Abschnitt „Aussehen" stand
für Spieler dauerhaft auf „Lädt…". **Zwei Lehren:** (a) Nach jedem Merge, der BEIDE Repos betrifft,
den Backend-Stand mit dieser 401/404-Messung prüfen, nicht nur die Frontend-Version – der
Frontend-Deploy beweist nichts über den Backend-Deploy, beide sind getrennte fest verdrahtete
Befehle desselben Webhooks; (b) das Frontend muss einen nicht erreichbaren Server BENENNEN können,
statt stumm im Ladezustand zu bleiben (Frontend-CLAUDE.md, Regel 35, behoben in v8.520.0). Ein
hängender Deploy ist dann eine sichtbare Störung statt einer toten Fläche.

**URSACHE GEFUNDEN UND BEHOBEN, 16.08.2026 – es waren nie die Lock-Dateien.** Die drei Vorfälle
(14.08. und zweimal 15.08.) hatten dieselbe Wurzel, und sie stand in der **root-crontab** des Pi:

```
*/10 * * * * cd /DATA/kepler7/kolonie-kepler7 && git pull -q && cp weltraum_kolonie.html /DATA/kepler7/web/
*/10 * * * * cd /DATA/kepler7/backend && git pull -q
*/5  * * * * /DATA/kepler7/backend/deploy/autodeploy.sh >> …/autodeploy.log 2>&1
```

Drei Cron-Jobs taten als **root** dasselbe wie der Webhook – nur zusätzlich und alle paar Minuten.
Damit erklären sich beide Fehlerbilder auf einen Schlag:

- **`Unable to create '/app/.git/index.lock': File exists`** – der Cron-Pull und der Webhook-Pull
  liefen gleichzeitig im selben Repo. Es war nie ein „abgestürzter git-Prozess", sondern schlicht
  ein zweiter, ganz normaler.
- **root-eigene `.git`-Objekte** – genau das, was der `chown 1000:1000` im Webhook seit dem
  05.08.2026 hinterherräumt. Die Cron-Jobs erzeugten es alle fünf bis zehn Minuten neu.

Und es erklärt, warum es **immer das Backend** traf und nie das Frontend: Im Backend liefen ZWEI
Konkurrenten (`*/10`-Pull und `*/5`-`autodeploy.sh`), im Frontend nur einer. `deploy/autodeploy.sh`
ist seit dem Webhook ohnehin hinfällig – es löste dasselbe Problem vorher.

**Behoben:** Die drei Zeilen sind aus der root-crontab entfernt, nur die certbot-Erneuerung bleibt.
Gegengeprüft, dass dabei nichts verlorengeht: `docker exec kepler7-nginx ls -la
/usr/share/nginx/html/` zeigt **alle** Seiten, Icons, `robots.txt`, `sitemap.xml`, `manifest.json`
und `service-worker.js` mit demselben frischen Zeitstempel – der Webhook kopiert seit dem 05.08.
das komplette Set, die Cron-Zeile kopierte nur `weltraum_kolonie.html` und war damit die ärmere
Variante derselben Arbeit.

**KORREKTUR 18.08.2026 – die Behebung oben war unvollständig, und der Deploy hing danach 49 Stunden.**
Entfernt wurden die drei Zeilen aus der **root**-crontab. Sie standen aber ZUSÄTZLICH in Saschas
**Nutzer-crontab** (`/var/spool/cron/crontabs/sascha`) und liefen dort unverändert weiter – gemessen
am 18.08. um 10:40, also zwei Tage nach der angeblichen Behebung, alle drei Zeilen wortgleich.

Am 16.08. um 09:13:16 kollidierte einer dieser Läufe mit dem Webhook-Pull. Der unterlegene Prozess
hinterließ `.git/index.lock`; ab da scheiterte **jeder** weitere Pull – der Pi blieb auf #109 stehen,
während elf Commits (#110–#120) aufliefen, und das Frontend fragte live Routen ab, die es
serverseitig nicht gab. Der FRONTEND-Deploy lief die ganze Zeit sauber, weil dort nur EIN
Cron-Konkurrent lief statt zweier – dieselbe Asymmetrie wie schon am 15.08.

**Die Lehre ist nicht „Cron ist böse", sondern: Eine Prüfung, die nur `sudo crontab -l` ansieht,
beantwortet eine andere Frage als die gestellte** (dieselbe Familie wie die Fernreferenz-Falle im
Frontend-Prüflauf). Cron-Zeilen können in fünf Ablagen stehen, und Datei-Eigentümer verraten nichts:
root darf in eine sascha-eigene Logdatei anhängen, ohne dass sich der Eigentümer ändert. Wer fragt
„läuft noch ein zweiter Deploy?", misst deshalb alle fünf:

```
crontab -l                       # der eigene Nutzer  <-- HIER standen sie
sudo crontab -l                  # root
grep -vE '^#|^$' /etc/crontab
ls -la /etc/cron.d/
systemctl list-timers --all
```

**Zwei Befunde, die dabei nebenbei herausfielen:**

- **Was auf dem Pi wie eine „Handänderung an `server.js`" aussah, war der halb geschriebene
  Arbeitsbaum des abgestürzten Pulls.** Belegt über den Blob-Hash: `git hash-object server.js`
  lieferte exakt `a1d7b40…`, also `server.js` bei #110 – und die daneben unversioniert liegende
  `tests/test_berichtsarchiv_http.js` ist genau die Datei, die #110 anlegt, mit Zeitstempel
  16.08. 09:13. **Vorgehen bei einer „lokalen Änderung", die einen Pull blockiert: erst den
  Blob-Hash gegen die eingehenden Commits halten, bevor man sie stasht.** Hier gab es nichts zu
  retten – der Inhalt stand längst im Ursprung, und ein Stash wäre eine Zeitbombe gewesen (ein
  späteres `git stash pop` schreibt bei 278 geänderten Zeilen Konfliktmarker in die
  Produktivdatei, nodemon lädt sie, und das Backend ist komplett aus).
- **Der Container sammelt Zombies.** PID 1 im Container war bis zum 28.08.2026 `npm exec nodemon`,
  und das erntet verwaiste Kinder nicht ab. Seit dem Umbau ist PID 1 die `sh` des Startbefehls –
  **ob die es besser macht, ist NICHT gemessen**, und bis dahin gilt der Absatz unverändert
  weiter. Die Messung steht unten (`ps` mit Zustandsfeld, nie `pgrep`). Gemessen am 18.08.: mehrere hundert `[git] <defunct>` (dazu ein
  `[chown]`), alle mit PPID 3307, der älteste zweieinhalb Tage alt. Sie halten nichts und sind
  harmlos – aber sie **verfälschen jede Prozessprüfung**: `pgrep -x git` findet einen Zombie über
  den Prozessnamen, `ps … | awk '$4 ~ /git$/'` findet ihn nicht, weil die Kommandozeile fehlt.
  Genau dieser Widerspruch hat bei der Wiederherstellung eine Runde gekostet. Wer prüft, ob ein
  git-Prozess LEBT, liest den Zustand mit:
  `ps -eo pid=,stat=,etimes=,comm=,args= | awk '$4=="git" && $2 !~ /Z/'`. Ein `docker restart`
  räumt sie ab – mit Vorsicht, der Startbefehl beginnt mit `npm install`, und ein Fehlschlag dort
  lässt den Container gar nicht erst hochkommen.

  **Nachtrag 18.08.2026 – woher sie kommen, und was der Code daran ändern kann (und was nicht).**
  Nachgemessen in einem Node-Nachbau: `exec(cmd, { timeout })` schickt beim Ablauf SIGTERM an die
  **Shell**, nicht an das `git` darunter. Der Enkelprozess lief im Versuch weiter und schrieb seine
  Datei zu Ende (`killed=true`, `signal=SIGTERM`, Marke trotzdem angelegt). Auf dem Pi heißt das:
  Ein abgewürgter Deploy lässt ein unbeobachtetes `git` in `.git` schreiben – **derselbe Zustand,
  den wir gerade 49 Stunden lang repariert haben, nur auf einem zweiten, von Cron unabhängigen
  Weg.** Der Deploy-Timeout steht deshalb seit #122 auf `DEPLOY_TIMEOUT_MS` = 10 Minuten statt 30
  Sekunden (ein `git pull` samt `cp` des 6-MB-Spielstands und `chown -R` über `.git` kann die 30 s
  auf einem Pi überschreiten, ohne dass irgendetwas kaputt ist), und die Zeitüberschreitung hat
  einen **eigenen** Log-Zweig: Als generisches „Fehler" gemeldet sähe der gefährlichste Ausgang aus
  wie der harmloseste.
  **Was der Code NICHT kann:** Ein Kill an die Prozessgruppe wäre der saubere Hebel – er steht
  bewusst nicht da, weil `detached: true` im selben Nachbau **keine** eigene Gruppe erzeugte
  (gemessen: PGID des Kindes = PID des Elternprozesses, `process.kill(-pid)` scheiterte mit
  `ESRCH`). Eine Behebung, die sich auf eine Annahme stützt, die schon im Nachbau nicht hält, wäre
  schlimmer als keine. Und das Einsammeln der Zombies selbst ist **keine Code-Frage**: Verwaiste
  Kinder landen bei PID 1, und PID 1 ist hier `npm exec nodemon`. Das behebt man am Container
  (`--init` bzw. tini als PID 1), nicht in `server.js`. Wächter für den Endpunkt:
  `tests/test_deploy_webhook_http.js` (Port 3223) – er fährt Signaturprüfung, Repo-Zuordnung und
  die Sofort-Antwort gegen einen echt gestarteten Server.

**NACHTRAG 18.08.2026, 16:44 UTC – es ist am selben Tag WIEDER passiert, nach der Behebung von
10:40.** Gemessen von aussen nach der Methode oben, mit beiden Kontrollen im selben Lauf, über
sechs Minuten und neunzehn Abfragen hinweg:

```
POST /api/festung/angriff        404   (neu mit #126, gerade gemergt)
POST /api/musterattack/create    401   (alte Kontrollroute)
POST /api/gibtesnicht            404   (Negativkontrolle)
```

Der FRONTEND-Deploy desselben Webhooks lief im selben Moment einwandfrei durch – `www.gamegeeeeek.de`
lieferte v8.568.0 innerhalb von Sekunden nach dem Merge. **Zum vierten Mal dieselbe Asymmetrie.**

**Was daran neu und wichtig ist:** Die Korrektur von 10:40 (Nutzer-crontab von Sascha geleert) war
also entweder unvollständig, oder es gibt eine weitere Ursache. Der Verdacht „Cron-Konkurrent" ist
damit NICHT mehr die naheliegendste Erklärung – die fünf Ablagen waren am Morgen geprüft. Wer das
nächste Mal hier landet, prüft deshalb **zuerst**, ob überhaupt ein Pull versucht wurde: Der
Webhook schreibt seinen Fehler ausschliesslich ins Container-Log, und nichts holt ihn später nach.

```
docker logs --tail 80 kepler7-backend | grep -i "deploy-webhook"
```

Steht dort „erfolgreich", ist der Pull durch und der Selbst-Neustart hat nicht gefeuert. Das ist
seit dem 28.08.2026 der NORMALFALL bei einem Commit ohne Codeänderung (etwa reiner Doku) und keine
Störung – `/api/health` zeigt dann `checkout` neuer als `commit`, und beide Felder sind korrekt.
Störend ist es nur, wenn der Commit `.js`/`.json` angefasst hat; dann hilft `docker restart
kepler7-backend` (Vorsicht, der Startbefehl beginnt mit `npm install`). Steht dort ein
Fehler, nennt er die Ursache. Steht dort GAR NICHTS zum Zeitpunkt des Merges, kam der Webhook nicht
an – dann liegt es an GitHub (Settings → Webhooks → Recent Deliveries) und nicht am Pi.

**Was in diesem Fall NICHT kaputt war, und warum das kein Zufall ist:** `FESTUNG_SPAWN_AKTIV` stand
auf `false`, und das ausgelieferte Frontend ruft keine der neuen Routen auf (nachgemessen: 0 Treffer
für `festung/angriff` und `protoBlockade` in der Spieldatei). Der hängende Deploy war damit eine
reine Pipeline-Störung ohne jede Spielerwirkung – anders als am 15.08., als das Frontend live Routen
abfragte, die es serverseitig nicht gab. **Genau dafür ist der Schalter da** (Frontend-Arbeitsregel
60): Er macht die Reihenfolge der beiden Deploys gleichgültig, statt auf sie zu hoffen.

**NACHTRAG 18.08.2026, 22:03 UTC – der Ausfall läuft noch, und die Behebung dafür steckt HINTER
ihm fest.** Unmittelbar nach dem Merge von Phase 2 (Frontend v8.575.0, Backend #135) gemessen, mit
beiden Kontrollen im selben Lauf:

```
POST /api/festung/angriff        404   (neu mit #126)
POST /api/musterattack/create    401   (alte Kontrollroute)
POST /api/gibtesnicht            404   (Negativkontrolle)
```

Das Frontend stand binnen Sekunden auf `8.575.0`. Der Pi fährt also weiterhin einen Stand von VOR
#126 – inzwischen fehlen ihm zehn Commits.

**Der wahrscheinliche Grund steht in #134, und das ist die Pointe:** Der Webhook rief `exec()` mit
einem Timeout von **30 Sekunden** auf. Nachgemessen in einem Node-Nachbau schickt `exec()` beim
Ablauf SIGTERM an die **Shell**, nicht an das `git` darunter – der Enkelprozess läuft weiter und
schreibt seine Datei zu Ende (`killed:true`, `signal:SIGTERM`, Marke trotzdem angelegt). Auf dem Pi
ist das genau der Zustand, der den Deploy am 16.08. für 49 Stunden lahmgelegt hat: ein
unbeobachtetes `git`, ein halb geschriebener Arbeitsbaum, eine liegengebliebene `.git/index.lock`.
Ein `git pull` samt `cp` des 6-MB-Spielstands und `chown -R` über `.git` kann auf einem Raspberry Pi
30 Sekunden überschreiten, ohne dass irgendetwas kaputt ist – **der Webhook konnte den Schaden also
selbst erzeugen**, ganz ohne Cron-Konkurrenten. Das erklärt, warum es nach dem Leeren beider
crontabs wieder passiert ist.

#134 hebt den Timeout auf 10 Minuten und gibt der Zeitüberschreitung eine eigene Logmeldung. **Nur
kommt die Behebung nicht an, solange der Pull hängt** – sie steckt hinter genau dem Problem fest,
das sie behebt. Der erste Schritt bleibt deshalb ein Blick ins Container-Log und danach der
Wiederherstellungsweg von Hand; ab dem nächsten erfolgreichen Pull greift der neue Timeout von
selbst.

**BEHOBEN 19.08.2026, 05:39 UTC – und der Befund macht aus der Vermutung oben einen Beweis.** Der
Pi stand auf #122 und ist von Hand in einem Zug auf #138 vorgespult worden (16 Commits,
`Fast-forward`, 11 Dateien, 5.923 Zeilen, `merge EXIT=0`). Beleg über den laufenden Prozess statt
über `git log`, mit beiden Kontrollen im selben Lauf:

```
POST /api/festung/angriff        401   (neu ab #126 – vorher 404)
POST /api/musterattack/create    401   (alte Kontrollroute)
POST /api/gibtesnicht            404   (Negativkontrolle)
```

**Der Blocker war diesmal NICHT `index.lock`**, und genau darin liegt die Lehre. Gefunden wurde:

- `git pull` scheiterte an `Your local changes to the following files would be overwritten by
  merge: server.js` – und `git status --porcelain` zeigte `M␣server.js`, also **M in der ERSTEN
  Spalte: vorgemerkt**, Arbeitsbaum sauber. Das ist die Falle, die in diesem Dokument seit dem
  05.08. steht: `git diff` allein ist dabei leer, und `git checkout -- server.js` ist wirkungslos,
  weil es aus dem Index zurückholt statt aus HEAD.
- Zwei Sperren, aber `.git/HEAD.lock` und `.git/refs/heads/master.lock` – **nicht** `index.lock`.
  Ein `rm -f .git/*.lock` hätte die zweite nicht einmal gefunden; nur `find .git -name '*.lock'`
  sieht sie.

**Welche Sperren liegen bleiben, sagt, WO der Pull gestorben ist.** `HEAD.lock` plus
`refs/heads/master.lock` bei gleichzeitig schon geschriebenem Index und Arbeitsbaum heißt: Der
Fast-Forward war fertig mit den Dateien und wurde **während der Ref-Aktualisierung** abgeschnitten.
Genau dieser Fingerabdruck gehört zum Timeout-Mechanismus aus #134 – damit ist die dortige
Vermutung („der wahrscheinliche Grund") bestätigt.

**Wie der vorgemerkte Rest identifiziert wurde, ohne zu raten** – dieselbe Frage wie am 16.08., nur
eine Ebene tiefer, weil er im INDEX lag statt im Arbeitsbaum:

```
git rev-parse :server.js          # der VORGEMERKTE Blob
# dagegen jeden eingehenden Commit halten:
for c in $(git rev-list --reverse <pi-stand>..origin/master); do
  git --no-pager diff --numstat <pi-stand> $c -- server.js
done
```

Nur `ea090dd` (#123) ergab die gemessenen 46/3, und der Blob stimmte exakt (`51c3bf2…`). Der
vorgemerkte Stand war also byte-genau `server.js` bei #123 und längst im Ziel enthalten – es gab
nichts zu retten, und das Verwerfen war belegt statt gehofft. **Die übertragbare Regel: Ein
blockierender „lokaler Stand" wird über den BLOB-Hash einem Commit zugeordnet, bevor er verworfen
wird – und zwar mit `git rev-parse :datei` für den Index, nicht nur `git hash-object datei` für den
Arbeitsbaum.**

**NACHTRAG 19.08.2026, 09:35 UTC – SECHSTES Mal, und diesmal hängt der Pi zwischen #137 und #142.**
Gemessen unmittelbar nach dem Merge von #143 (Nest-Schalter), dreimal über zwei Minuten, mit beiden
Kontrollen im selben Lauf:

```
POST /api/logout                 404   (neu mit #142)
POST /api/alien/nest-angriff     401   (neu mit #137 - der Pi HAT den Nest-Code)
POST /api/musterattack/create    401   (alte Kontrollroute)
POST /api/gibtesnicht            404   (Negativkontrolle)
```

Der FRONTEND-Deploy lief im selben Moment einwandfrei durch: `www.gamegeeeeek.de` lieferte
v8.582.0 innerhalb von Sekunden nach dem Merge. **Zum sechsten Mal dieselbe Asymmetrie.**

**Was der Schalter hier geleistet hat, und warum das die Einordnung ändert:** Der Pi steht auf einem
Stand MIT dem Nest-Code, aber VOR dem Umlegen von `NEST_SPAWN_AKTIV`. Es entsteht also kein Nest,
das Frontend zeigt keines, und nichts sagt etwas Falsches – genau der Zustand, für den der Schalter
gebaut ist (Frontend-Arbeitsregel 60). **Eine Sache bleibt trotzdem schief und gehört benannt:** Der
Patchnote zu v8.582.0 kündigt die Alien-Nester an, und der ist live. Wer ihn liest und die Karte
sucht, findet nichts. Das ist keine Falschaussage der Anzeigestellen, aber eine Lücke zwischen
Ankündigung und Wirkung – der Preis dafür, dass die Auslieferung aus zwei getrennten Befehlen
besteht.

**Die Eingrenzung ist knapper als sonst, und das liegt am Gegenstand:** #143 legt nur eine Konstante
um und bringt deshalb KEINE neue Route mit. Ein Schalter-Merge ist von außen grundsätzlich nicht
messbar. Gemessen werden kann nur, ob der Pi den davorliegenden Stand hat – und das reicht: Ist
#142 nicht angekommen, ist #143 es auch nicht. **Wer künftig einen reinen Schalter-Merge
ausliefert, misst deshalb den letzten routentragenden Commit davor, nicht den eigenen.**

**NACHTRAG 21.08.2026, 03:51 UTC – SIEBTES Mal, und es ist DERSELBE Ausfall wie Nr. 6, nur
44,5 Stunden alt.** Der Eintrag darüber (19.08., 09:35 UTC) beschreibt den Anfang; hier steht, was
zwei Tage später daraus geworden ist. Gemessen mit allen Kontrollen im selben Lauf:

```
POST /api/logout                 404   (neu mit #142, gemergt 19.08. 07:16 UTC)
POST /api/alien/nest-angriff     401   (neu mit #137 - der Pi HAT den Nest-Code)
POST /api/musterattack/create    401   (alte Kontrollroute)
POST /api/gibtesnicht            404   (Negativkontrolle)
```

Dem Pi fehlen inzwischen **vier** Commits: #142 (Abmelde-Route), #143 (Nest-Schalter), #144
(Doku) und #145 (Phase 4). Der FRONTEND-Deploy lief in derselben Zeit dreimal sauber durch – live
steht v8.585.0. **Zum siebten Mal dieselbe Asymmetrie.**

**Die Marker-Prüfung, die diesmal ausdrücklich mitgelaufen ist** (sie ist billig und schließt die
Fehlerklasse aus, die am 18.08. eine falsche Diagnose erzeugt hat): `/api/logout` kommt in
`server.js` bei **#141 null**mal vor und bei **#142 einmal** – ein gültiger Marker, keine Route,
die es vorher schon gab und die nur angefasst wurde.

**Und die Eingrenzung war nur deshalb überhaupt möglich:** #143, #144 und #145 bringen **keine
einzige neue Route** mit. Maschinell gemessen statt geschätzt, indem je Commit die Routenliste
gegen die des Vorgängers gehalten wurde:

```bash
for c in $(git rev-list --reverse <von>..origin/master); do
  neu=$(git show $c:server.js  | grep -oE "app\.(post|get)\('/api/[a-z0-9/-]+" | sort -u)
  alt=$(git show $c~1:server.js | grep -oE "app\.(post|get)\('/api/[a-z0-9/-]+" | sort -u)
  echo "$(git log -1 --format=%h $c) $(comm -13 <(echo "$alt") <(echo "$neu"))"
done
```

Das ist die Regel vom 19.08. („wer einen reinen Schalter-Merge ausliefert, misst den letzten
routentragenden Commit davor") als **Messung** statt als Erinnerung – bei vier Commits am Stück
lässt sich sonst nicht sagen, welcher überhaupt einen Anker hergibt.

**Was diesmal wirklich schiefsteht, und es sind zwei Dinge:**

1. **Der Patchnote zu v8.582.0 kündigt die Alien-Nester an und ist live** – `NEST_SPAWN_AKTIV`
   legt aber erst #143 um. Es entsteht keins. Der Schalter tut genau, wofür er gebaut ist (keine
   Falschaussage einer Anzeigestelle), aber die Lücke zwischen Ankündigung und Wirkung ist jetzt
   zwei Tage alt statt zwei Minuten. **Der Schalter schützt vor der stillen Verschlechterung, nicht
   vor einem hängenden Deploy** – das ist der Unterschied zwischen „nichts sagt etwas Falsches" und
   „alles ist in Ordnung".
2. **Die Auslieferung der Etappe b hängt daran.** Der Frontend-PR darf nicht gemerged werden,
   solange `/api/logout` mit 404 antwortet: Der Abmeldeknopf meldete dann nicht ab. Das Frontend
   BENENNT diesen Fall zwar (`sitzungBeenden()` prüft den Status), aber eine benannte Störung ist
   kein Ersatz für eine funktionierende Abmeldung.

**Der Wiederherstellungsweg, falls es wieder passiert** (am 18.08. so gefahren, jede Stufe gemessen,
vorher von vier Prüfläufen adversarisch zerlegt):

1. **Auslöser stilllegen**, bevor irgendetwas angefasst wird – sonst startet der Konkurrent mitten
   in die Reparatur hinein.
2. **Sichern, was kein git wiederherstellt.** Achtung auf die Ablage: `db.json` und
   `jwt-secret.txt` liegen im Docker-**Volume** (`DB_FILE=/data/db.json`), die
   **VAPID-Schlüssel dagegen im Repo-Verzeichnis** (die Env-Variablen sind nicht gesetzt, also
   greift der `__dirname`-Rückfall). In diesem Verzeichnis niemals `git clean -x`, `git stash -a`
   oder `git reset --hard` – sie träfen genau diese Dateien.
3. **Wachen prüfen**: kein LEBENDER git-Prozess (siehe Zombies oben), Sperre älter als eine Stunde,
   kein `MERGE_HEAD`, keine eigenen Commits, HEAD ist Vorfahr des Ziels.
4. **`chown` inklusive Wurzelverzeichnis.** git ersetzt eine Datei per unlink+create; dafür zählt
   das Schreibrecht am **Verzeichnis**, nicht an der Datei. Fehlt das `.`, scheitert der Checkout
   mit „unable to unlink old" – und darüber steht trotzdem verführerisch `Updating …`.
5. Sperren entfernen (`find .git -name '*.lock' -delete`, nicht nur `.git/*.lock` – Ref-Locks
   liegen tiefer), Arbeitsbaum-Rest mit `git checkout HEAD -- <datei>` verwerfen, kollidierende
   unversionierte Dateien **wegbewegen, nie löschen**.
6. **`git merge --ff-only <fester Hash>`** – nie `git pull` (darf einen Merge-Commit bauen, und der
   Pi liefe danach dauerhaft neben `origin/master`) und nie `origin/master` als Ziel (kann zwischen
   Prüfung und Merge weiterlaufen). Danach `echo "merge EXIT=$?"` ohne Pipe dazwischen.
7. **Der Beleg ist nie `git log`**, sondern eine Route, die es erst im neuen Stand gibt: 404 vorher,
   401 nachher, mit `/api/gibtesnicht` als Negativkontrolle und einer alten Route als
   Gegenkontrolle. `git log` beweist nur den Dateistand, nicht den laufenden Prozess.

**Der zweite Blocker, unabhängig davon: eine Handänderung an `server.js` auf dem Pi.** Sie fügte
`bergungsfrachter` in `SHIP_SCORE_WEIGHTS` und in die Schiffsliste von `/api/worldboss/resolve` ein
und blockierte JEDEN Pull mit „Ihre lokalen Änderungen würden überschrieben" – tagelang, ohne dass
es jemandem auffiel, weil der Webhook seinen Fehler nur ins Container-Log schreibt. Beide Zeilen
kamen später über git ordentlich herein, der verworfene Stand war also inhaltsgleich; verloren ging
nichts. **Lehre:** Eine Änderung von Hand am ausgecheckten Stand auf dem Pi legt den automatischen
Deploy still lahm. Wer dort etwas ausprobiert, macht es rückgängig (`git checkout -- <datei>`),
sobald er fertig ist – und prüft vor dem Verwerfen mit `git --no-pager diff --numstat -- <datei>`,
ob überhaupt Inhalt drinsteckt (`0 0` heißt: nur ein Dateimodus).

**URSACHE VON NR. 6 UND NR. 7 GEFUNDEN UND BEHOBEN, 21.08.2026 (#147) – der Webhook kollidierte
mit SICH SELBST.** Die zwei Einträge darüber beschreiben denselben Ausfall und lassen ihn als
Rätsel stehen: Die Cron-Jobs waren weg, der Timeout aus #134 war behoben, und trotzdem hing es
wieder. Der fehlende Baustein ist eine Eigenschaft, die weiter oben in diesem Dokument längst
steht, nur nie mit dem Ausfall verbunden wurde: **Der Webhook feuert bei JEDEM Push, auch auf
Feature-Branches.** Wer einen Branch pusht und Sekunden später den PR merged – also der normale
Auslieferungsablauf dieses Projekts – löst damit ZWEI Ereignisse aus, und beide starten
`cd /app && git pull` im selben Repo.

Gemessen am Vorfall vom 19.08.2026, 05:41 UTC (der Minute, in der genau das passierte):

```
.git/HEAD.lock                    0 Bytes
.git/refs/heads/master.lock      41 Bytes   <- der fertige Hash war schon geschrieben
git status --porcelain           M␣server.js, M␣CLAUDE.md, A␣tests/…   (VORGEMERKT)
```

Der vorgemerkte Stand entsprach byte-genau Commit #140. Der Pull war also mit Index und
Arbeitsbaum fertig und wurde **während der Ref-Aktualisierung** abgeschnitten – derselbe
Fingerabdruck wie bei den Cron-Kollisionen, nur mit dem Webhook als zweitem Schreiber. Danach
scheitert jeder weitere Pull an „Your local changes would be overwritten", und der Deploy steht,
bis jemand von Hand aufräumt.

**Behoben in #147: eine Sperrdatei je Ziel.** Läuft für ein Repo schon ein Deploy, wird kein
zweiter gestartet; der Push wird nur VORGEMERKT und einmal am Ende nachgeholt (kein Stapel –
`git pull` ist kumulativ). Eine verwaiste Sperre, älter als `DEPLOY_TIMEOUT_MS`, wird übernommen:
Ohne diese Gegenrichtung legte ein einziger abgestürzter Lauf den Deploy für immer still, und die
Behebung wäre schlimmer als das Problem.

**Warum als DATEI und nicht als Variable im Prozess** – das ist die eigentliche Pointe und
nachgemessen: Ein erfolgreicher Backend-Pull ändert `server.js`, nodemon startet daraufhin neu,
und der neue Prozess hätte eine leere Variable, während der alte `git`-Enkel noch läuft. Dass der
Enkel einen nodemon-Neustart ÜBERLEBT, wurde im Nachbau gemessen (er lief zu Ende und schrieb
seine Marke) – genau in diesem Fenster entsteht die Kollision, und nur eine Datei übersteht den
Neustart.

**Was daran übertragbar ist, unabhängig von diesem Webhook:** Nr. 6 und Nr. 7 sind zweimal
sorgfältig gemessen und richtig als „derselbe Ausfall" erkannt worden – gefehlt hat nicht die
Messung, sondern die Verbindung zu einer Eigenschaft, die drei Absätze weiter oben im selben
Dokument steht. Wer einen wiederkehrenden Ausfall untersucht, liest die bekannten Eigenschaften
des Systems noch einmal durch und fragt bei jeder: *kann DIE das erklären?* – statt nur neue
Messungen zu sammeln.

**Und ein Befund über die eigene Prüfung** (Arbeitsregel-Familie „aus dem falschen Grund grün"):
Der erste Test zu #147 prüfte, ob die Sperrdatei bei einem zweiten Webhook **unberührt** bleibt.
Er war am alten Stand grün – dort kennt der Server die Datei gar nicht und fasst sie deshalb auch
nicht an. Gemessen wird jetzt am Serverprotokoll, ob ein zweiter Deploy wirklich ANGELAUFEN ist;
die Gegenprobe liefert dort `{"vorher":0,"nachher":2}`, also zwei parallel gelaufene Deploys – der
Vorfall selbst, im Test reproduziert.

**Nachtrag zur Messmethode oben:** Die 401/404-Messung muss die **HTTP-Methode der Route treffen**.
`curl -X POST` auf `/api/cosmetics` (eine GET-Route) liefert 404 von Express – das sieht aus wie
„Route fehlt", obwohl der Server sie kennt. Genau dieser falsche Alarm ist am 16.08. entstanden.
Deshalb gehört zur Messung eine **Negativkontrolle**: eine frei erfundene Route (`/api/gibtesnicht`)
muss im selben Lauf 404 liefern, und eine bekannte alte Route 401. Erst dann misst man den Server
und nicht die eigene Anfrage.

**AUSFALL NR. 8, am selben Tag behoben – und er hat den Marker gleich selbst geprüft.** Der
Merge von #152 kam nicht an; 40 Abfragen über 15 Minuten lieferten unverändert
`{"ok":true,"users":11}`. Der Diagnoseblock brachte:

| | |
|---|---|
| Frontend-Webhook | erfolgreich, jedes Mal – **zum fünften Mal dieselbe Asymmetrie** |
| Backend-Webhook | `Command failed: cd /app && git pull -q …`, neun Mal in 120 Logzeilen |
| Stand | #141, es fehlten **10 Commits** |
| Blocker | `.git/index.lock`, 0 Bytes, 06:14 – **kein lebender git-Prozess dazu**, also verwaist |
| #147-Sperre | keine – die Serialisierung war nie angekommen, kann also weder geholfen noch versagt haben |

**Der eigentliche Befund ist der Arbeitsbaum, und er ist neu:** Er war kein „alter Stand",
sondern ein **Flickenteppich**. Per Blob-Hash einzeln zugeordnet:

```
CLAUDE.md                        -> byte-genau #146
server.js                        -> byte-genau #145
tests/test_alien_nester_http.js  -> byte-genau #143
.git/HEAD                        -> #141
```

Vier verschiedene Stände in einem Verzeichnis. Mehrere Pulls waren jeweils unterschiedlich weit
gekommen, bevor sie abgeschnitten wurden. **Kein `git log` der Welt zeigt das** – es meldet #141,
und die Tests im Verzeichnis stammten aus drei anderen Commits.

**Die Lehre, und sie kostet eine Rücknahme:** Die 401/404-Messung misst die laufende **Datei**,
nicht den ausgecheckten **Commit**. Während des Ausfalls antwortete `/api/logout` mit 200,
obwohl es die Route in #141 nicht gibt – die geladene `server.js` stammte ja aus #145. Aus
diesem Widerspruch wurde zunächst geschlossen, die `git log`-Ausgabe sei veraltetes Scrollback.
Sie war korrekt; falsch war der Schluss, eine antwortende Route belege den Commit. Ein halb
angewendeter Pull entkoppelt beide, und dann sagt jede der beiden Messungen für sich die
Wahrheit über etwas anderes.

**Deshalb trägt `/api/health` seit #153 ein drittes Feld: `blob`** – den git-Blob-Hash der
Datei, die der Prozess wirklich ausführt (über `__filename`, nicht über einen Pfad aus der
Konfiguration). Er ist exakt der Wert von `git rev-parse <commit>:server.js` und lässt sich
deshalb von außen gegen jeden Commit halten, bis einer passt – genau die Analyse, die am
21.08. einen SSH-Zugang gebraucht hat:

```bash
blob=$(curl -s https://gamegeeeeek.de/api/health | grep -o '"blob":"[^"]*"' | cut -d'"' -f4)
for c in $(git rev-list --reverse <alt>..origin/master); do
  [ "$(git rev-parse $c:server.js | cut -c1-7)" = "$blob" ] && git log -1 --oneline $c
done
```

Die drei Felder beantworten damit drei verschiedene Fragen: `commit` = welchen Stand hat der
Prozess beim Start GELESEN, `checkout` = was liegt JETZT auf der Platte, `blob` = was FÜHRT er
aus. Im Normalfall sind alle drei einig; jede Abweichung benennt eine andere Störung.

`test_health_commit_http.js` 7a/7c misst den Blob gegen **`git hash-object`**, also gegen eine
fremde Implementierung – die Erwartung aus derselben Rechnung zu bilden könnte nicht
fehlschlagen (Frontend-Arbeitsregel 62). Dazwischen steht `7b-bau` als eigene Aufbau-Prüfung
(Arbeitsregel 34): Scheitert der git-Aufruf, meldet das eine benannte Prüfung, statt den
Testlauf mittendrin zu beenden.

**Zwei Dinge, die beim Reparieren gelernt wurden und für das nächste Mal gelten:**

- **Ein Skript, das über die Ausgabe von `git status --porcelain` iteriert, MUSS NUL-getrennt
  lesen** (`-z`, dazu `git diff --name-only -z`). Im Verzeichnis lag eine Datei namens
  `tash push -- server.js` – der Rest eines vertippten `git stash push`. Bei Wortzerlegung wird
  daraus unter anderem das Wort `server.js`, das im Zielbaum existiert – das Aufräum-Skript
  hätte ausgerechnet die getrackte `server.js` beiseitegeschoben. Aufgefallen beim Trockentest
  an einem Wegwerf-Repo, nicht am Pi.
- **Der Rest im Arbeitsbaum wird per Blob-Hash einem Commit zugeordnet, BEVOR er verworfen
  wird** – und wenn keiner passt, wird abgebrochen statt geraten (dann ist die Datei
  wahrscheinlich halb geschrieben und niemand weiß, was drinsteht). Das Skript vom 21.08. macht
  genau das und legt kollidierende unversionierte Dateien **beiseite statt sie zu löschen**.

### `/api/health` nennt den Stand selbst (21.08.2026)

Die 401/404-Messung oben trägt nur, solange ein Merge überhaupt eine **neue Route** mitbringt.
Am 21.08.2026 einmal maschinell über alle Commits seit #142 gemessen (Routenliste je Commit
gegen die des Vorgängers, der Schleifenbefehl steht im Nachtrag vom 21.08.): **#143 bis #151
brachten zusammen KEINE EINZIGE neue Route** – allein #149–#151 ändern dabei 363 Zeilen in
`server.js`. Der Pi-Stand war in dieser ganzen Zeit von außen schlicht nicht messbar, und
`/api/logout` (#142, gemergt am 19.08.) war neun Tage lang der jüngste Anker, den es gab.

`/api/health` trägt deshalb zwei Felder, und **der Unterschied zwischen ihnen ist der ganze
Zweck**:

| Feld | woher | sagt |
|---|---|---|
| `commit` | beim Start **einmal** gelesen | mit welchem Stand dieser Prozess läuft |
| `checkout` | jetzt von der Platte (10 s gepuffert) | welchen Stand der letzte Pull hinterließ |

Drei Lagen lassen sich damit von außen unterscheiden, die vorher alle gleich aussahen:

- **beide gleich und aktuell** – alles in Ordnung.
- **beide gleich und alt** – der Pull selbst hängt. Weiter mit dem Container-Log.
- **`checkout` neuer als `commit`** – der Pull ist durch, **der Neustart ist ausgeblieben**.
  **Das ist nur dann eine Störung, wenn der Commit geladenen Code angefasst hat.** Seit dem
  28.08.2026 entscheidet das der Server selbst über `require.cache`; vorher tat es nodemon über
  `--ext js,json`. Ob der Umbau überhaupt aktiv ist, sagt seither das Feld `selbstNeustart`
  derselben Antwort – vorher brauchte diese Frage einen SSH-Zugang. Am 22.08.2026 gemessen an einem reinen Doku-Merge
  (`a1ecd8e`, nur `CLAUDE.md`): `commit` blieb `d881b45`, `checkout` sprang auf `a1ecd8e`,
  `uptimeSec` wuchs ruhig weiter – der korrekte und erwartete Zustand. Hier stand vorher
  pauschal „genau der Fall, für den die Doku `docker restart kepler7-backend` empfiehlt";
  ein Neustart wäre in diesem Fall grundlose Unruhe. Die Prüffrage lautet also nicht „laufen
  die zwei Felder auseinander?", sondern **„laufen sie auseinander, obwohl der Commit `.js`
  oder `.json` geändert hat?"** – zu klären mit
  `git diff --name-only <commit> <checkout> | grep -E '\.(js|json)$'`. Kommt dort nichts,
  ist alles in Ordnung.

**git wird dafür NICHT aufgerufen.** Der Diagnosefall ist ja gerade der, in dem git im Repo
nicht mehr durchkommt (liegengebliebene Sperrdatei, root-eigene Objekte) – gelesen wird nur
`.git/HEAD` und die Referenz dahinter, notfalls aus `packed-refs`. Ein Kurzhash aus einem
öffentlichen Repo gibt nichts preis, was nicht ohnehin auf GitHub steht.

**Der Befund, der dabei nebenbei herausfiel: `/health` ist von außen gar nicht erreichbar.**
Der Endpunkt trägt seit dem 13.07.2026 den Kommentar „für externe Monitoring-Dienste wie
UptimeRobot gedacht" – er liegt aber **außerhalb** von `/api`, und der nginx des Pi proxyt nur
`/api/` zum Backend. Gemessen:

```
https://gamegeeeeek.de/health        200   <!DOCTYPE html> …   (die Spieldatei!)
https://gamegeeeeek.de/api/health    200   {"ok":true,"users":11}
```

Ein Monitor, der auf `https://gamegeeeeek.de/health` zeigt, bekommt also von nginx die
Startseite und meldet „up" – **auch wenn das Backend vollständig tot ist**. Eine Überwachung,
die nicht fehlschlagen kann, überwacht nichts (dieselbe Familie wie „aus dem falschen Grund
grün"). Wer sie einrichtet, nimmt `/api/health`; das Rate-Limit von 240/min ist für einen
Minutentakt reichlich. Ob dort wirklich ein Monitor hängt, weiß nur Sascha – die Messung sagt
nur, dass die öffentliche Adresse den Backend-Endpunkt nicht trifft.

**`KEPLER_GIT_DIR`** leitet das gelesene Verzeichnis um; nur damit lässt sich der Fall
„`checkout` wandert unter dem laufenden Prozess" überhaupt prüfen, ohne das echte Repo
anzufassen. Weil eine still ignorierte Env-Variable wie eine bestandene Prüfung aussieht
(Frontend-Arbeitsregel 14), belegt `test_health_commit_http.js` 6a/6b, dass die Umleitung
greift – an einem Hash, der im echten Repo nicht vorkommen kann.

**Und weil dieser Test damit ausschließlich den umgeleiteten Weg fährt, kann er den
Normalweg nicht belegen.** Diese Lücke schließt `test_serverstart.js` 2b: Der startet den
Server ohne jede Umleitung und vergleicht `commit` gegen `.git/HEAD` des Repos. Ohne die
Prüfung hätte eine Umleitung, die *immer* greift, nie auffallen können.

`tests/test_health_commit_http.js` (Port 3229, 12 Prüfungen, Gegenprobe in beide Richtungen:
9 von 12 fallen am alten Stand, identische Prüfnamen per `diff` verglichen). **Belegte
Testports sind jetzt 3195–3200 und 3210–3229** – ein neuer Test nimmt 3230.

Eine Lehre aus der Gegenprobe, zum wiederholten Mal dieselbe: Zwei Prüfungen waren am alten
Stand **aus dem falschen Grund grün**. Dort fehlen beide Felder, und `undefined === undefined`
(„beim Start gleich") wie `undefined !== '<hash>'` („stammt nicht aus dem echten Repo") sind
trivial erfüllt. Beide verlangen jetzt zuerst einen **Wert**, dann die Beziehung. Wer eine
Prüfung über zwei Felder formuliert, die es am Vergleichsstand gar nicht gibt, prüft sonst nur,
dass beide fehlen.

### Der erste SAUBERE Deploy seit acht Ausfällen – gemessen, nicht gehofft (21.08.2026, #150)

Der Merge von Phase 6 (Backend #150, Frontend v8.594.0) ist der erste, bei dem die ganze Kette
von außen belegt werden konnte. Gemessen unmittelbar nach dem Merge, mit beiden Kontrollen im
selben Lauf:

```
GET  /api/health   {"commit":"03f047c","checkout":"03f047c","blob":"9ad26fc","uptimeSec":63}
POST /api/musterattack/create   401   (alte Kontrollroute)
POST /api/gibtesnicht           404   (Negativkontrolle)
www.gamegeeeeek.de              VERSION = '8.594.0'
```

**Der Blob ist die Zeile, auf die es ankommt** – und dies ist seine erste Anwendung in der
Richtung, für die er eigentlich gebaut wurde: nicht als Diagnose eines Ausfalls, sondern als
Beleg eines Erfolgs. `git rev-parse 03f047c:server.js` liefert lokal `9ad26fc`, der Pi meldet
`9ad26fc` – der Prozess führt also **byte-genau** die Datei aus, die gemergt wurde. Der
Flickenteppich-Fall vom selben Tag (vier Stände in einem Verzeichnis) ist damit ausgeschlossen,
und zwar ohne SSH. `uptimeSec: 63` belegt zusätzlich, dass nodemon nach dem Pull wirklich neu
gestartet hat – der dritte Fehlerfall der Tabelle oben („`checkout` neuer als `commit`") kann
gar nicht vorliegen.

**Warum diese Messung überhaupt möglich war, ist die eigentliche Lehre:** #150 bringt **keine
einzige neue Route** mit (maschinell über alle Commits seit #142 gemessen – #143 bis #153
brachten zusammen keine). Nach der alten 401/404-Methode wäre der Stand schlicht **nicht
messbar** gewesen; man hätte den letzten routentragenden Commit davor genommen und über #150
selbst weiterhin nichts gewusst. Ein Werkzeug, das nur bei bestimmten Merges greift, hat genau
dann Pause, wenn eine Serie von Logik-Änderungen ausgeliefert wird – also im Normalfall dieses
Projekts.

**Für #147 (die Sperrdatei je Ziel) ist das der erste positive Beleg**, aber ausdrücklich noch
kein Freispruch: Ein einzelner erfolgreicher Deploy beweist nicht, dass die Kollision behoben
ist – er beweist nur, dass sie diesmal nicht auftrat. Die Ausfälle Nr. 6 und 7 lagen Tage
auseinander. Wer den nächsten Merge fährt, misst weiter.

### AUSFALL NR. 9 (21.08.2026) – und der Blob hat die Diagnose von AUSSEN geliefert

Der Merge von #158 kam nicht an. Gemessen unmittelbar danach und über zehn Minuten hinweg
unverändert:

```
GET /api/health   {"commit":"d8b6d89","checkout":"d8b6d89","blob":"a86145e","uptimeSec":10456}
```

Die drei Felder widersprechen sich, und **genau dieser Widerspruch IST der Befund**:

| Feld | Wert | zugeordnet |
|---|---|---|
| `commit`/`checkout` | `d8b6d89` | #155 (Bonuscodes) |
| `blob` | `a86145e` | = `0259f21:server.js`, also **#156** |
| erwartet nach #158 | `36808e9` | = `fd2a0fd:server.js` |

**Der Pi FÜHRT also #156 aus, während sein git-Ref auf #155 steht.** Das ist der
Flickenteppich-Zustand vom 21.08. (Ausfall Nr. 8) in seiner reinen Form: Ein Pull ist mit dem
Arbeitsbaum fertig geworden und wurde **vor** der Ref-Aktualisierung abgeschnitten. Aus git-Sicht
ist `server.js` damit lokal geändert, und **jeder weitere Pull bricht mit „Your local changes
would be overwritten by merge" ab** – der Deploy steht, bis jemand von Hand aufräumt.
`uptimeSec` 10.456 (2,9 h) datiert den abgeschnittenen Lauf: Er hat die Datei geschrieben,
nodemon hat neu gestartet, die Ref blieb stehen.

**Das ist die erste Anwendung des Blob-Felds für genau die Analyse, die am 21.08. noch einen
SSH-Zugang gebraucht hat.** Damals mussten vier Dateien einzeln per `git hash-object` einem
Commit zugeordnet werden, um den Flickenteppich überhaupt zu sehen; hier steht er nach einem
`curl` fest. Die Zuordnung läuft von außen gegen jeden Commit, bis einer passt:

```bash
blob=$(curl -s https://gamegeeeeek.de/api/health | grep -o '"blob":"[^"]*"' | cut -d'"' -f4)
for c in $(git rev-list --reverse <alt>..origin/master); do
  [ "$(git rev-parse $c:server.js | cut -c1-7)" = "$blob" ] && git log -1 --oneline $c
done
```

**Und die Rettungsanalyse ist damit ebenfalls von außen erledigt, bevor jemand den Pi anfasst:**
Der Arbeitsbaum-Rest ist byte-genau `0259f21:server.js` – also im Ziel `fd2a0fd` vollständig
enthalten. Es gibt nichts zu retten, das Verwerfen ist **belegt statt gehofft** (die Regel vom
19.08.: ein blockierender „lokaler Stand" wird über den BLOB-Hash einem Commit zugeordnet, bevor
er verworfen wird). Was am Pi trotzdem gemessen werden muss, ist die SPALTE: Liegt der Rest im
Arbeitsbaum (`git hash-object server.js`) oder im Index (`git rev-parse :server.js`)? Davon hängt
ab, ob `git checkout HEAD -- server.js` überhaupt greift.

**Die Auslieferung des Frontends hing daran und wurde deshalb ANGEHALTEN.** v8.605.0 bringt die
Klassen-Sets, deren `atk`/`hull`/`shield` der Server mitrechnen muss; ohne #158 zeigte die
Vorschau eine Kampfkraft, mit der nicht gekämpft wird. Der Frontend-PR steht als Entwurf mit der
Freigabe-Bedingung im Text: **`blob` muss `36808e9` melden.** Das ist die Regel „eine
Backend-Phase, die eine spielersichtbare Zahl ändert, geht zuerst live" (Frontend-Regel 60) – nur
diesmal mit einem Messinstrument, das die Bedingung wirklich prüfen kann, statt mit einer
401/404-Messung, die bei einem Merge ohne neue Route gar nichts sagt.

**Kein Spielerschaden in diesem Zustand, und das ist kein Zufall:** Live steht v8.604.0, das die
Sets nicht kennt. Frontend ohne Sets gegen Backend mit der Angleichung (#156) ist ein
widerspruchsfreier Stand. Schief würde es erst, wenn das Frontend allein nachrückte.

### AUSFALL NR. 10 (22.08.2026) – drei Befunde, und zwei davon betreffen die Werkzeuge

Der Merge von #162 (Rücknahme der Raid-Vorschau) kam nicht an. `/api/health` meldete über
Minuten unverändert:

```
{"commit":"19430fc","checkout":"19430fc","blob":"e0810f3","uptimeSec":…}
```

**Wieder der Flickenteppich, und diesmal ist die Abbruchstelle byte-genau messbar.** Der
Arbeitsbaum trug drei Dateien aus #161 (`9392852`) bei einem git-Ref auf #157 (`19430fc`).
Gemessen, nachdem Sascha die Blob-Hashes gezogen hatte:

| Datei | Größe in #161 | auf dem Pi |
|---|---|---|
| `CLAUDE.md` | 144.925 B | vollständig (`ca1a5ec`) |
| `server.js` | 696.893 B | vollständig (`e0810f3`) |
| `tests/test_raid_vorschau_http.js` | 19.745 B | **angelegt, 0 Bytes** (`e69de29`) |

git schreibt in Index-Reihenfolge; `tests/` steht hinter `CLAUDE.md` und `server.js`. Der Pull
ist also beim **letzten** Eintrag gestorben – nach dem Anlegen, vor dem Inhalt, und lange vor der
Ref-Aktualisierung. Damit ist der Ausfall vollständig rekonstruiert, ohne Rätselrest.

**Befund 1 – das `blob`-Feld ist bei einem REVERT blind, und das ist strukturell.** `d881b45`
nimmt `9392852` zurück; seine `server.js` ist damit byte-identisch mit der von `19430fc`.
Gemessen liefern **beide** `0455a14`. Ein Blob-Hash kann zwei Commits nur unterscheiden, wenn sie
verschiedene Dateiinhalte haben – bei einer Rücknahme, einem reinen Doku-Commit oder einem
Schalter-Merge in einer anderen Datei ist das per Definition nicht der Fall.
**Vorgehen:** Vor dem Merge ausrechnen, welches Feld den Erfolg überhaupt belegen KANN
(`git rev-parse <ziel>:server.js` gegen `<davor>:server.js` halten). Sind sie gleich, tragen die
Aussage allein `commit`/`checkout` – wer dann auf den Blob wartet, wartet auf eine Zahl, die sich
nie ändert. Das ist dieselbe Familie wie die 401/404-Messung bei einem Merge ohne neue Route: ein
Messinstrument, das für genau diesen Merge keinen Gegenstand hat.

**Befund 2 – der leere Blob ist eine ANTWORT, keine Panne.** Meine Reparatur-Anleitung sagte für
die Testdatei `9e6047b` an (ihr Inhalt in #161) und bekam `e69de29`. Das ist gemessen der leere
Blob (`printf '' | git hash-object --stdin`). Die Regel „ein blockierender lokaler Stand wird über
den Blob-Hash einem Commit zugeordnet, bevor er verworfen wird" braucht deshalb einen dritten
Ausgang neben *passt* und *passt nicht*: **der leere Blob heißt „hier ist der Pull abgebrochen"**.
Verworfen werden darf er, sobald die Datei im Ziel-Commit gar nicht existiert oder ihr Inhalt in
der Historie steht – hier beides.

**Befund 3 – mein eigener Befehlssatz war unvollständig, und zwar nach Regel 54.** Ich hatte nur
`server.js` versorgt, obwohl mein Commit **drei** Dateien anfasst; Saschas `git pull` brach danach
an `CLAUDE.md` ab und kostete eine zweite Runde. Die Regel steht seit dem 17.08. in der
Frontend-CLAUDE.md, dort für eine Sicherung vor einem Rebase – sie gilt genauso für eine
Reparaturanleitung: **nicht überlegen, was zu versorgen ist, sondern `git status --short` lesen und
JEDE Zeile versorgen.** Und noch billiger wäre der Blick in den eigenen Commit gewesen:
`git show --stat <hash>` nennt die Dateien, die der halb angewendete Pull auf dem Pi hinterlassen
haben MUSS.

Der Ablauf, der es dann behoben hat (je Datei erst messen, dann verwerfen):

```bash
cd /DATA/kepler7/backend
git hash-object CLAUDE.md | cut -c1-7      # erwartet ca1a5ec = 9392852:CLAUDE.md
git checkout HEAD -- CLAUDE.md
mv tests/test_raid_vorschau_http.js /tmp/  # 0 Bytes, im Ziel nicht vorhanden
git pull origin master                     # Fast-forward, 1 Datei
curl -s https://gamegeeeeek.de/api/health  # commit/checkout d881b45, uptimeSec 11
```

### AUSFALL NR. 12, DIE URSACHE (28.08.2026) – nodemon killt den eigenen Pull

*Ergänzt den Abschnitt „AUSFALL NR. 12 … der Rest lag im ARBEITSBAUM, nicht im Index" weiter oben:
Dort steht, WIE der Zustand aussah (die Spalte: Arbeitsbaum geändert, Index unberührt) und wie er
repariert wurde. Hier steht, WOHER er kommt — und was seither dagegen gebaut ist. Beide Hälften
entstanden am selben Tag in zwei Sitzungen; die zweite hat die erste beim Rebase vorgefunden.*

Sechs Ausfälle (Nr. 6, 7, 8, 9, 11, 12) zeigten denselben Fingerabdruck – der Arbeitsbaum trug den
neuen Stand, `.git/HEAD` den alten, eine `*.lock` blieb liegen –, und die Ursache war jedes Mal
Vermutung. Bei Nr. 12 stand sie im Container-Log, Zeile für Zeile:

```
Deploy-Webhook erfolgreich für kolonie-kepler7-backend: (keine Änderungen)   <- Branch-Push
[nodemon] restarting due to changes...            <- der Merge-Pull hat server.js geschrieben
SIGUSR2 (nodemon-Neustart) - flushe DB...
[nodemon] still waiting for 1 sub-process to finish...   <- DAS ist der laufende git-Prozess
Deploy-Webhook Fehler für kolonie-kepler7-backend: Command failed: cd /app && git pull -q && (chown -R 1000:1000 .git || true)
Deploy-Alarm für kolonie-kepler7-backend: Command failed: ...
Deploy-Alarm: DEPLOY_ALARM_MAIL ist nicht gesetzt - keine Mail verschickt.
[nodemon] starting `node server.js`
```

**Der Deploy sabotiert sich über seinen EIGENEN Neustart.** `git pull` schreibt `server.js`,
nodemon sieht die Änderung sofort, wartet kurz auf den Subprozess (`still waiting for 1
sub-process to finish`) und beendet ihn – **bevor** git den Ref aktualisiert hat. Zurück bleiben
`.git/index.lock` und ein `HEAD` auf dem alten Commit; ab da bricht jeder weitere Pull mit
„local changes would be overwritten" ab.

**Damit ist auch erklärt, warum die Sperrdatei aus #147 nicht half:** Sie serialisiert zwei
WEBHOOKS gegeneinander. Hier gab es nur einen – der zweite Schreiber war der eigene Prozess-
neustart. Die Zeitstempel stützen es unabhängig: Sperre 22.08. 20:23, Prozessstart (aus
`uptimeSec` zurückgerechnet) 20:26.

**Cron ist bei diesem Ausfall nachweislich unschuldig**, alle fünf Ablagen gemessen: Nutzer-crontab
leer, root-crontab nur die certbot-Erneuerung, `/etc/crontab` Debian-Standard, `/etc/cron.d/` nur
certbot und e2scrub, Systemtimer nur Standard. `deploy/autodeploy.log` lag mit Zeitstempel
18.08. 10:50 da, also zehn Tage tot. Die Bereinigung vom 18.08.2026 hält.

**Der zweite Befund erklärt die Dauer: `DEPLOY_ALARM_MAIL` ist am Container nicht gesetzt.** Der
Alarm aus #166 hat korrekt gefeuert UND seinen eigenen Ausfall benannt (das ist die fail-open-
Entscheidung, wie gebaut) – nur ging keine Mail raus. Der Ausfall lief deshalb **fünf Tage**
unbemerkt, obwohl das Werkzeug dagegen längst existiert. Eine Env-Änderung verlangt ein
Neuerzeugen des Containers; der Webhook-Pull allein reicht dafür nicht.

**GEBAUT (28.08.2026, #170): die Selbstheilung.** `deployAufraeumen(repoName, dir)` läuft in
`starteDeploy` **hinter der Sperre und vor dem Pull** — davor könnte sie einem parallel laufenden
Deploy ins Verzeichnis greifen, danach wäre sie wirkungslos. Sie räumt genau zwei Dinge weg, beide
nur unter Beweis:

1. **Eine verwaiste `*.lock`** — aber nur, wenn KEIN git-Prozess lebt und die Sperre älter ist, als
   ein Deploy dauern darf (`DEPLOY_TIMEOUT_MS + 60 s`).
2. **Eine geänderte Datei, deren Blob NACHWEISLICH schon im Ursprung steht** (`git hash-object`
   gegen `git rev-parse FETCH_HEAD:<datei>`), also genau der halb angewendete Pull. Geprüft wird
   **je Datei einzeln**.

**Alles andere bleibt liegen und wird benannt.** Eine Handänderung an `server.js` auf dem Pi hat
den Deploy am 18.08.2026 schon einmal blockiert; sie automatisch wegzuwerfen wäre Datenverlust mit
gutem Gewissen — die teurere Fehlerrichtung als ein stehender Deploy. Der Bericht sagt dann
wörtlich „ist eine FREMDE Aenderung … bleibt liegen, der Pull wird daran scheitern".

**Der Zombie-Test ist der Kern der ersten Wache.** `lebenderGitProzess()` liest `/proc/<pid>/stat`
und wertet **Feld 3, den Zustand**, mit aus: Der Container sammelt verwaiste `[git] <defunct>`
(gemessen mehrere hundert, der älteste zweieinhalb Tage), und `pgrep -x git` findet einen Zombie
über den Prozessnamen. Wer eine Leiche für einen laufenden Pull hält, räumt nie auf. Der `comm`
wird ab der **schließenden** Klammer zerlegt, nie durch Splitten des ganzen Strings — ein
Prozessname darf Leerzeichen enthalten.

**`DEPLOY_TARGETS` führt sein Verzeichnis seither benannt** (`{ dir, command }`) statt es nur im
Befehlsstring zu tragen. Der `command` bleibt unverändert fest verdrahtet — er ist die
Sicherheitsentscheidung, nichts daran kommt je aus einem Request. Einen Pfad aus dem String zu
parsen wäre die Sorte Ableitung, die beim nächsten Umbau still danebengreift.

Wächter: `tests/test_deploy_selbstheilung.js` (17 Prüfungen). Er **führt** die Funktion samt ihrer
Konstanten aus `server.js` geschnitten gegen ein echtes Wegwerf-Repo-Paar in `/tmp` aus, in dem der
Ausfall-Fingerabdruck von Hand hergestellt wird — ein Test, der bei einer Aufräumfunktion nur nach
Zeichenketten sucht, belegt gar nichts. Die entscheidende Zeile ist `2b`: **der Pull läuft danach
durch.** Drei Wirkungs-Gegenproben, jede mit ihrer Soll-Liste, alle mit 17 gelaufenen Prüfungen:

| Sabotage | fällt | Beleg |
|---|---|---|
| Alters-Wache raus | `1b` | eine frische Sperre wird entfernt |
| Blob-Vergleich raus | `3`, `3b` | eine fremde Änderung würde weggeworfen |
| git-Prozess-Wache raus | `4`, `4b` | `{"lebenderGit":true,"sperreNochDa":false}` |

### Drei Werkzeugfehler beim Bau dieses Tests, alle über den Einzelfall hinaus

1. **Ein `//`-Zeilenkommentar, der `/*` enthält, sprengt jeden naiven Blockkommentar-Ersetzer.**
   `server.js` hat davon mehrere („NGINX leitet /api/* per Reverse-Proxy", „*.js/*.json-Platzhalter").
   Wer zuerst nach Blöcken sucht, öffnet dort ein Fenster bis zum nächsten `*/` — gemessen **77.612**
   bzw. **20.018 Zeichen** — und leert echten Code mit; der Test fand seine eigenen Funktionen nicht
   mehr. **Zuerst die ZEILEN-Kommentare leeren, dann die Blöcke.** Das ist die Familie „Naive Regex
   über die ganze Datei", nur mit besonders großem Radius.
2. **Eine Bausteinliste aus Namen veraltet beim nächsten Umbau** — der erste Entwurf gab
   `DEPLOY_TIMEOUT_MS` mit und starb beim AUFRUF an `GIT_LOCK_STALE_MS`. Die Konstanten werden
   seither **gesammelt** (jeder GROSS_-Bezeichner in den geschnittenen Blöcken, transitiv) und **in
   der Reihenfolge der DATEI** eingesetzt: Nach Fund-Reihenfolge sortiert wirft eine abgeleitete
   Konstante „Cannot access … before initialization". Und jeder Messaufruf ist gefasst und meldet
   seinen Fehlschlag als eigene Prüfung (`0-lauf`) — ein `try/catch` um den Aufbau allein genügt
   nicht.
3. **Ein zu kurzlebiger Hilfsprozess machte zwei Prüfungen trivial grün.** Der lebende git-Prozess
   war zuerst `git --paginate help -a` und endete, bevor gemessen wurde; `4`/`4b` hingen an einer
   `lief ? … : true`-Bedingung und waren damit ohne Aussage. Jetzt blockiert `git hash-object
   --stdin` zuverlässig, und ohne lebenden Prozess fallen `4`/`4b` **mit**.

**Und ein Werkzeugfehler beim Aufräumen danach, zum zweiten Mal derselbe:** Ein `pkill -f "PORT=3223"`
traf die eigene Shell (Exit 144) — wörtlich Arbeitsregel 15, die seit dem 06.08.2026 samt Exit-Code
in diesem Dokument steht. Prozesse werden über `ps` identifiziert und einzeln per PID beendet.

### DIE GRENZE DIESER SELBSTHEILUNG, gemessen am Tag ihrer Auslieferung

**Sie hilft nur, solange der Server LEBT.** `deployAufraeumen` läuft im Webhook-Handler, also im
Node-Prozess. Ist der abgestürzt, nimmt niemand mehr einen Webhook entgegen — dann kann sich
nichts heilen, egal wie gut die Funktion ist.

Genau dieser Fall trat unmittelbar nach ihrem eigenen Merge ein: Das Backend antwortete um 04:12
noch sauber (`uptimeSec 668`), der Merge lief um 04:24:59, und danach lieferte
`https://gamegeeeeek.de/api/health` **502 Bad Gateway** — nginx erreichte `kepler7-backend:3001`
nicht mehr. Das statische Frontend blieb bei HTTP 200; Spieler konnten also spielen, aber
Anmeldung, Speichern, Allianzen, Markt und Bestenliste waren tot.

**Zwei Ursachen sind von außen ausgeschlossen worden, bevor irgendjemand geweckt wurde:**
Der gemergte Stand startet lokal einwandfrei und meldet `blob 2c3f34a` — exakt
`git rev-parse origin/master:server.js`. Und `DEPLOY_TARGETS` hat nur eine Leserstelle, die auf
die neue `{ dir, command }`-Form angepasst ist; eine übersehene zweite Stelle scheidet als
Absturzursache aus. `node --check`, `tests/test_serverstart.js` und
`tests/test_deploy_webhook_http.js` waren vor dem Merge grün.

**AM LOG BELEGT (05:15 UTC), und es ist die SCHLIMMERE Ausprägung desselben Mechanismus:**

```
[nodemon] still waiting for 1 sub-process to finish...   <- der laufende git-Prozess
Deploy-Webhook Fehler: Command failed: cd /app && git pull -q && (chown -R 1000:1000 .git || true)
/app/server.js:9986  SyntaxError: Unexpected end of input   <- HALBE Datei
[nodemon] app crashed - waiting for file changes before starting...
```

Bei Ausfall Nr. 12 war die Datei **vollständig** geschrieben und nur der Ref blieb alt — der
Server lief weiter, nur git war verklemmt. Hier hat der Kill den Pull **mitten in der Datei**
erwischt: `git hash-object server.js` meldete `dc9a1ff` statt `2c3f34a`, node starb am
Syntaxfehler, und nodemon wartet nach einem Absturz ausdrücklich auf eine Dateiänderung, statt
neu zu starten. **Derselbe Mechanismus, zwei Schweregrade — und welcher eintritt, entscheidet
allein, wie weit der Pull beim Kill gekommen war.**

**Drei Dinge für die nächste Reparatur, alle in diesem Lauf gemessen:**
- **`docker restart` allein genügt NICHT.** Der Container startet, `node` liest dieselbe halbe
  Datei und stirbt erneut. Erst `git checkout HEAD -- server.js` macht ihn startfähig.
- **`node` gibt es auf dem Host nicht** (`-bash: node: Kommando nicht gefunden`). Eine
  Syntaxprüfung von Hand läuft dort ins Leere; der verlässliche Test ist der Blob-Vergleich
  (`git hash-object server.js` gegen `git rev-parse origin/master:server.js`).
- **Die Sperre entsteht bei genau diesem Pull neu.** Sie muss vor dem Checkout weg
  (`sudo rm -f .git/index.lock`), sonst prallt auch die Reparatur ab — genau so ist der erste
  Versuch gescheitert.

Der Ablauf, der es behoben hat, in dieser Reihenfolge:

```bash
cd /DATA/kepler7/backend
sudo rm -f .git/index.lock
git checkout HEAD -- server.js CLAUDE.md
git pull --ff-only origin master
git hash-object server.js | cut -c1-7      # muss dem Soll-Blob entsprechen
docker restart kepler7-backend
```

Danach von außen belegt: `{"commit":"9246f02","checkout":"9246f02","blob":"2c3f34a","uptimeSec":31}`.

**Die Lehre über den Einzelfall hinaus: Ein Selbstheilungsmechanismus, der IM geheilten System
läuft, deckt dessen Totalausfall grundsätzlich nicht ab.** Das ist keine Schwäche der Umsetzung,
sondern ihrer Lage — und es gehört benannt, damit niemand sie für einen vollständigen Schutz hält.
Was diesen Fall abdecken würde, liegt außerhalb von `server.js`:

- eine **Docker-Restart-Policy** (`--restart unless-stopped`), die den Container nach einem Crash
  wieder hochfährt — nodemon tut das nach einem Absturz ausdrücklich NICHT, es wartet auf eine
  Dateiänderung (`[nodemon] app crashed - waiting for file changes`);
- oder ein **Watchdog von außen**, der `/api/health` prüft und bei 502 neu startet.

Beides ist Infrastruktur, keine Code-Änderung. Wer den nächsten Schritt baut, fängt dort an —
mehr Logik im Server macht diese Lücke nicht kleiner.

**Sascha hat die Infrastruktur-Seite am 28.08.2026 gesetzt** (auf die Vorlage der zwei Befehle:
„Erledigt"). Nachprüfbar von der Kommandozeile des Pi, und weil es hier um genau die Zusage geht,
gehört der Befehl daneben statt der bloßen Behauptung:

```bash
docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' kepler7-backend   # erwartet: unless-stopped
docker inspect -f '{{.Config.Cmd}}' kepler7-backend                      # steht dort --delay?
```

**Was die Restart-Policy leistet — und was nicht.** Sie fängt einen Container ab, der beendet
wurde. Sie hilft NICHT gegen eine halb geschriebene `server.js`: Dann startet der Container, node
stirbt am Syntaxfehler, und die Policy startet ihn erneut — eine Schleife statt eines Ausfalls.
Der Zustand ist von außen dann dasselbe 502, nur mit ständig kleiner `uptimeSec` statt gar keiner
Antwort. **Wer das nächste Mal 502 misst, holt deshalb ZUERST `uptimeSec` mit** (`curl` in einer
Schleife): springt sie immer wieder auf kleine Werte, ist es die halbe Datei und nicht ein toter
Container, und die Reparatur beginnt mit dem `git checkout`, nicht mit einem Neustart.

Gegen die halbe Datei hilft nur die zweite Hälfte, `nodemon --delay 5` im Startbefehl — die ist
eine Änderung an der Container-Definition und per `docker update` nicht setzbar.

**Was NICHT gebaut ist, und warum es weiterhin lohnt:**

1. **Das Fenster verkleinern (Infrastruktur):** `nodemon --delay 5` im Startbefehl. nodemon wartet
   dann fünf Sekunden nach der letzten Dateiänderung, und der Pull hat nach dem Schreiben von
   `server.js` nur noch Index und Ref zu setzen. Das verkleinert das Fenster, schließt es nicht.
2. **Selbstheilung (Code):** Der Webhook erkennt beim NÄCHSTEN Anlauf eine verwaiste Sperre (älter
   als `DEPLOY_TIMEOUT_MS`, kein lebender git-Prozess) und räumt sie weg, bevor er pullt – dazu
   ein `git checkout HEAD -- .`, wenn der Arbeitsbaum-Blob nachweislich einem der eingehenden
   Commits entspricht. Erst das macht den Deploy wieder selbstständig, statt dass er bis zum
   nächsten SSH-Zugang steht.

Der Fingerabdruck ist bei allen sechs Ausfällen derselbe gewesen – die Selbstheilung würde also
rückwirkend jeden davon abgefangen haben. **Wer sie baut, prüft die Zombie-Falle mit:** Der
Container sammelt `[git] <defunct>`, und `pgrep -x git` findet einen Zombie über den Prozessnamen,
während `ps … | awk '$4=="git"'` ihn nicht findet. Ein „lebt noch ein git?" muss den Zustand
mitlesen (`$2 !~ /Z/`), sonst hält die Selbstheilung eine Leiche für einen laufenden Pull und
räumt nie auf.

### Die Selbstheilung hat gegriffen – und den Pull dabei selbst gekillt (28.08.2026)

Der erste Anwendungsfall von #170, und er ist nur zur Hälfte gutgegangen. Ausgelöst von einem
Push auf einen Feature-Branch (der Webhook feuert bei jedem Push), gemessen ausschließlich über
`/api/health`:

| | vor dem Deploy | 10 s danach | 166 s danach |
|---|---|---|---|
| `commit`/`checkout` | `6317576` | `6317576` | `6317576` |
| `blob` | `dfcef52` | **`2c3f34a`** | `2c3f34a` |
| `uptimeSec` | 2017 | **10** | 166 |

Zugeordnet: `dfcef52` = `7835948:server.js` (die Spitze von `master`), `2c3f34a` =
`6317576:server.js` (der Stand des Refs). Der Pi lief also mit dem NEUEN Code bei altem Ref –
der Flickenteppich aus Ausfall Nr. 12 –, und `deployAufraeumen` hat den Arbeitsbaum-Rest
verworfen, genau wie gebaut. **Der Pull danach ist nicht durchgelaufen**: Das Ref steht
unverändert, und der Blob bleibt auf dem alten Stand.

**Der Mechanismus ist benennbar, und es ist der eigene.** `git checkout HEAD -- server.js`
SCHREIBT die Datei. nodemon sieht die Änderung, meldet `still waiting for 1 sub-process to
finish` und beendet den laufenden git-Prozess – also den Pull, der unmittelbar danach startet.
Das ist wörtlich der Mechanismus von Ausfall Nr. 12, nur ausgelöst von der Funktion, die ihn
beheben soll. Der Neustart ist am `uptimeSec`-Sprung belegt; dass der Kill den Pull traf, ist
von außen nicht belegbar und steht nur im Container-Log
(`docker logs --tail 80 kepler7-backend | grep -i deploy-webhook`).

**Netto ist der Pi von „neuer Code, altes Ref" auf „alter Code, konsistentes Ref" gefallen** –
`#169` (der Neuspieler-Push an den Betreiber) ist damit nicht mehr live. Kein Spielerschaden,
aber eine ausgelieferte Funktion weniger, und der Zustand sieht in allen drei Feldern
unauffällig aus.

**Diese Vorhersage stand hier zuerst und ist gemessen WIDERLEGT:** „Der Arbeitsbaum ist jetzt
sauber, der nächste Deploy findet nichts zu räumen und der Pull sollte durchlaufen." Ein zweiter
Push zwei Stunden später bewirkte **gar nichts** – `uptimeSec` wuchs über fünf Messungen lückenlos
weiter (7643 → 7718), es gab also keinen Neustart und damit keinen Schreibvorgang; `commit`,
`checkout` und `blob` blieben unverändert.

**Der Grund ist eine LÜCKE in `deployAufraeumen`, und sie ist benennbar:** Der Diff
`6317576..7835948` besteht aus drei Dateien, und eine davon ist **neu**:

```
M  CLAUDE.md
M  server.js
A  tests/test_neuspieler_push_http.js     <- in 6317576 nicht vorhanden
```

Nach dem abgeschnittenen ersten Pull liegt diese Datei **untracked** im Verzeichnis. Die
Selbstheilung räumt aber nur GEÄNDERTE Dateien weg, deren Blob nachweislich im Ursprung steht –
eine untracked Datei fällt durch beide Wachen, und `git pull` bricht an ihr ab („untracked working
tree files would be overwritten by merge"). Bezeichnend: Der manuelle Wiederherstellungsweg weiter
oben kennt den Fall längst und sagt „kollidierende unversionierte Dateien **wegbewegen, nie
löschen**" – die automatische Heilung tut es nicht. Ein zweiter Kandidat ist von außen nicht davon
zu unterscheiden: `CLAUDE.md` steht ebenfalls im Diff, und ob der erste Lauf sie mitverworfen hat,
sagt nur das Log.

**Damit ist der Zustand NICHT selbstheilend.** Er braucht einen Handgriff, und weil die Datei im
Ziel-Commit existiert, ist ihr Wegbewegen gefahrlos:

```bash
cd /DATA/kepler7/backend
docker logs --tail 80 kepler7-backend | grep -i deploy-webhook   # nennt die blockierende Datei
git status --short                                               # JEDE Zeile versorgen
mv tests/test_neuspieler_push_http.js /tmp/                      # untracked, im Ziel enthalten
git checkout HEAD -- CLAUDE.md server.js 2>/dev/null
git pull --ff-only origin master
curl -s https://gamegeeeeek.de/api/health                         # commit/checkout/blob muessen einig sein
```

**GEBAUT: der dritte Zweig.** `deployAufraeumen` behandelt jetzt auch unversionierte Dateien –
aber nur die, die der eingehende Stand ANLEGT, mit demselben Beweis wie bei den geänderten (der
Pfad muss in `FETCH_HEAD` vorkommen), und sie werden **weggelegt statt gelöscht**
(`os.tmpdir()/kepler7-deploy-beiseite/<zeitstempel>/<pfad>`). Ohne ihn half die Heilung
ausgerechnet bei jedem Commit nicht, der eine Datei ANLEGT – und das ist bei diesem Projekt fast
jeder, weil zu jeder Etappe ein neuer Wächter gehört.

**Die Gegenrichtung ist die wichtigere Hälfte** (`6c`): Eine unversionierte Datei, die der
eingehende Stand NICHT kennt, ist eine fremde Datei und bleibt liegen. Ohne diese eine Zeile
dürfte die Heilung jede beliebige Datei aus dem Verzeichnis räumen – und in `/DATA/kepler7/backend`
liegen `db.json`, `jwt-secret.txt` und die VAPID-Schlüssel.

`tests/test_deploy_selbstheilung.js` Abschnitt 6 (22 Prüfungen, zwei Gegenproben, jede mit ihrer
Soll-Liste, 22 identische Prüfnamen in allen drei Läufen). **`6-vorab` misst den Anlassfall
selbst**: Ohne Heilung scheitert der Pull an dieser Datei wirklich – sonst könnte `6b` auch dann
grün sein, wenn es nie ein Problem gab.

| Sabotage | fällt |
|---|---|
| den ganzen Zweig entfernt (= Stand davor) | `6`, `6b` |
| den `FETCH_HEAD`-Beweis entfernt | `6c` |

**Ein Werkzeugfehler beim Bau, und er ist die bekannte Bausteinlisten-Falle:** Der Test schneidet
die Funktion aus `server.js` und führt sie mit `new Function('fs','path','execSync', …)` aus – `os`
war dort nicht dabei. Der neue Zweig warf zur LAUFZEIT, der innere `catch` von `deployAufraeumen`
schluckte es in den Bericht, und mein auf `/beiseitegelegt/` gefilterter Beleg versteckte es
vollends: `{"bericht":[]}` sah aus, als sei der Zweig wirkungslos. Seitdem gibt der Beleg den
VOLLEN Bericht aus, und `6-bau` prüft ausdrücklich, dass keine „nicht pruefbar"-Zeile darin steht –
ein verschluckter Laufzeitfehler ist damit eine eigene, benannte Prüfung statt eines Rätsels.

**Was der Zweig NICHT löst:** Das Wegbewegen einer `.js`-Datei ist selbst eine Änderung, die
nodemon sieht – das Kill-Fenster von oben bleibt also bestehen, und der Deploy braucht weiterhin
zwei Anläufe. Erst `nodemon --delay 5` im Startbefehl (Infrastruktur, nicht Code) schließt es.

**Die Lehre für den nächsten Ausbau: Die Heilung darf die beobachtete Datei nicht anfassen,
solange der Beobachter scharf ist.** Zwei Wege, beide außerhalb von `server.js`:
`nodemon --delay 5` im Startbefehl (das Fenster wird kleiner, nicht zu), oder die beobachteten
Dateien beim Aufräumen gar nicht erst schreiben – etwa `git stash` statt `checkout`, oder das
Aufräumen und den Pull in EINEN git-Aufruf legen, damit zwischen Schreiben und Ref-Update kein
zweiter Prozessstart liegt. Solange das nicht gebaut ist, gilt: **Ein Deploy, dem eine Heilung
vorausgeht, braucht zwei Anläufe** – der erste räumt, der zweite pullt.

### nodemon fliegt aus dem Deploy-Pfad: der Server startet sich selbst neu (28.08.2026)

Auftrag Sascha: „schau mal wir haben die ganze zeit das problem mit dem backend weil ich mehrere
claude chats habe die unterchiedliche aufgaben im backend machen finde eine lösung das jeder chat
mit dem backend arbeiten kann und sich nicht selbst blockeirt." Vorgelegt wurden vier Wege,
gewählt: **die Ursache beseitigen.**

**Die naheliegende Diagnose ist gemessen FALSCH: Die Parallelität war nie die Ursache.** Der Beleg
ist eine Asymmetrie, die durch alle dreizehn Ausfälle läuft:

| | Frontend | Backend |
|---|---|---|
| Deploy | `git pull` → `cp` nach `/deploy/web/` | `git pull` in `/app` |
| wer beobachtet das gepullte Verzeichnis | niemand | **nodemon** `--watch . --ext js,json` |
| Ausfälle seit dem 14.08.2026 | **0** | **13** |

Derselbe Webhook, dieselben Pushes, dieselben parallel arbeitenden Sitzungen (gemessen: 4 aktive
Branches, Merges im 3–10-Minuten-Abstand, jeder Merge = zwei Webhooks). Der einzige Unterschied
ist der Beobachter. Mehr Sitzungen erhöhen die **Häufigkeit**, nicht die Fehlerklasse – der
Ausfall tritt auch bei einem einzigen Merge einer einzigen Sitzung auf.

Damit ist auch klar, warum die Serialisierung aus #147 nicht half, obwohl sie funktioniert: Sie
hält zwei WEBHOOKS auseinander. Der zweite Schreiber war aber nie ein zweiter Webhook, sondern
der **eigene Prozessneustart**.

**Der Weg: Der Pull läuft vollständig durch, und ERST DANACH beendet sich der Prozess selbst** –
über `handleTerminate`, damit die Datenbank geflusht wird; Docker startet ihn per
`--restart unless-stopped` neu. Kein Watcher, kein Kill-Fenster.

**Vier Entscheidungen, die man beim Anfassen kennen muss:**

- **`DEPLOY_SELBST_NEUSTART` ist Pflicht, keine Vorsicht.** Solange nodemon läuft, ist ein
  Selbst-Exit für nodemon ein **Crash**, nach dem es ausdrücklich auf eine Dateiänderung WARTET
  (`app crashed - waiting for file changes`) – der Server bliebe unten, bis jemand eine Datei
  anfasst. Der Schalter gehört deshalb gemeinsam mit dem Container-Umbau gesetzt, nie vorher.
  Ohne ihn verhält sich alles exakt wie bisher.
- **Neu gestartet wird nur bei GEÄNDERTEM Code**, gemessen über `require.cache`: die Dateien, die
  dieser Prozess wirklich geladen hat. Das ist dieselbe Semantik, die nodemon mit `--ext js,json`
  hatte – ein reiner Doku-Commit startet nichts neu. `node_modules` bleibt draußen: Neue
  Abhängigkeiten brauchen ohnehin `npm install` und damit einen echten Neustart von Hand.
- **Nur das EIGENE Verzeichnis.** Der Frontend-Deploy zieht ein fremdes Repo; ein Neustart darauf
  wäre grundlose Unruhe. Verglichen wird gegen `__dirname`, also gegen die tatsächlich geladene
  Datei – nicht gegen einen Pfad aus der Konfiguration.
- **Der vorgemerkte Push kommt VOR dem Neustart** – und wird beim START nachgeholt, falls doch
  einer liegen bleibt. Ohne diese zwei Stellen risse der Selbst-Neustart genau die Lücke auf, die
  die Vormerkung aus #147 schließen soll: Der `.pending`-Marker ist eine Datei, sie überlebt den
  Prozess, gelesen wurde sie bisher aber nur im laufenden Deploy.

### Der Container-Umbau, vollzogen am 28.08.2026

**Der Stack wird von Portainer verwaltet**, nicht per `docker run` – das war vorher nirgends
notiert und kostet sonst einen Anlauf. Die Compose-Datei liegt **im Portainer-Container**
(`big-bear-portainer:/data/compose/6/docker-compose.yml`, Projekt `kepler7`); auf dem Host gibt
es sie nicht. Lesen geht per `docker exec`, **geändert wird sie über die Portainer-Oberfläche**
(Stacks → kepler7 → Editor → „Update the stack") – wer die Datei im Container von Hand ändert,
bekommt sie beim nächsten Stack-Update aus Portainers eigener Ansicht überschrieben.

Auslesen, welche Datei gerade gilt:

```bash
P=$(docker ps --format '{{.Names}}' | grep -i portainer | head -1)
docker exec "$P" cat /data/compose/6/docker-compose.yml
```

**ACHTUNG: Diese Datei enthält Geheimnisse im Klartext** (Resend-Schlüssel, Deploy-Webhook-Secret,
Ko-fi-Token). Sie gehört nirgendwo hin, wo sie mitgeschnitten wird – nicht in ein Repo, nicht in
einen Fehlerbericht, nicht in einen Chat-Verlauf. Wer sie doch einmal irgendwo abgelegt hat,
rotiert die drei Werte.

**Der echte Startbefehl war länger als hier dokumentiert**, und das zweite Glied muss bleiben:

```
vorher:  sh -c "git config --global --add safe.directory '*' && npm install --no-audit --no-fund && npx nodemon --watch . --ext js,json server.js"
nachher: sh -c "git config --global --add safe.directory '*' && npm install --no-audit --no-fund && node server.js"
```

Dazu `- DEPLOY_SELBST_NEUSTART=1` im `environment`-Block. `restart: unless-stopped` stand bereits.

**Gemessen unmittelbar nach dem Update:**

```
docker inspect -f '{{.Config.Cmd}}' kepler7-backend   -> [sh -c ... && node server.js]
DEPLOY_SELBST_NEUSTART=1
/api/health   commit 74d4600  checkout 74d4600  blob a596512  uptimeSec 21
```

**Was der Umbau kostet – jetzt GEMESSEN statt geschätzt.** Ohne nodemon startet bei einem
Codewechsel der ganze CONTAINER neu, und damit läuft `npm install --no-audit --no-fund` jedes Mal
mit. Hier stand zuerst „spürbar länger als nodemons zwei bis drei Sekunden" und weiter unten die
Vermutung 10–20 Sekunden. Am ersten echten Code-Deploy (#178) im Sekundentakt nachgemessen:

```
09:36:05  200  commit 74d4600  checkout 6d63908  uptimeSec 512    <- alter Prozess
09:36:08  502  AUSFALL
09:36:10  502  AUSFALL
09:36:12  200  commit 1b0679f  checkout 1b0679f  blob 4b0b3ec  uptimeSec 1  selbstNeustart true
```

**Rund sieben Sekunden**, also gut das Doppelte von nodemon und nicht das Fünffache. Das Backend
ist in dieser Zeit auf 502, das Spiel selbst (statisch über nginx) bleibt erreichbar.

**Damit ist die naheliegende Optimierung erledigt, bevor sie gebaut wurde:** `npm install` zu
überspringen, solange `package-lock.json` nicht neuer ist als `node_modules`, würde ein paar
Sekunden bei einem Vorgang sparen, der ein paar Mal am Tag stattfindet – und dafür eine
Bedingung in den Startbefehl setzen, die im Fehlerfall einen Container ohne Abhängigkeiten
hochfahren lässt. Der Messwert sagt: nicht bauen.

**Und wer auf dem Pi von Hand an `server.js` etwas ausprobiert, bekommt seinen Neustart nicht mehr
geschenkt:** `docker restart kepler7-backend`. Das ist der Preis dafür, dass niemand mehr in einen
laufenden Pull hineingreift.

**Der Selbst-Neustart ist am 28.08.2026 im Betrieb belegt, in BEIDE Richtungen** – und das PAAR
ist der eigentliche Beweis, nicht die eine Hälfte:

| Merge | Änderung | Ergebnis |
|---|---|---|
| `6d63908` | nur `CLAUDE.md` | `checkout` sprang, `commit` blieb, `uptimeSec` wuchs **178 → 190** durch |
| `1b0679f` | `server.js` | alle drei Felder sprangen, `uptimeSec` **512 → 1** |

Ohne die erste Zeile wäre auch ein Neustart bei JEDEM Deploy grün gewesen; ohne die zweite auch
einer, der nie feuert. `/api/health` meldet seit `1b0679f` zusätzlich `selbstNeustart`, damit von
außen erkennbar ist, ob der Container umgebaut ist – vorher brauchte diese Frage einen SSH-Zugang.

### Was das NICHT löst

Ein Container, der gar nicht mehr lauscht (die halb geschriebene `server.js` aus dem Ausfall vom
28.08.2026), wird davon nicht geheilt – die Selbstheilung läuft IM Server. Dagegen hilft nur die
Restart-Policy plus, falls es wieder auftritt, der Handgriff aus dem Abschnitt darüber.

Wächter: `tests/test_deploy_neustart.js` (19 Prüfungen). Er führt `deploySelbstNeustart`
geschnitten aus und stellt jede der vier Bedingungen EINZELN; `1-paar` belegt, dass sich die vier
Läufe wirklich unterscheiden – ohne diese Zeile wäre `1b` auch bei einer Funktion grün, die immer
`true` liefert. Sechs Gegenproben, jede mit Soll-Liste, identische Prüflisten:

| Sabotage | fällt |
|---|---|
| Schalter ignoriert | `1`, `1-paar` |
| Verzeichnis-Wache raus | `1d`, `1-paar` |
| `process.exit` statt `handleTerminate` | `2`, `2b` |
| Neustart vor dem Nachholen | `4` |
| kein `return` nach dem Nachholen | `4b2` |
| Stand davor (`origin/master`) | `0-bau` |

**Zwei Werkzeugfehler beim Bau, beide von den Soll-Listen gefangen und beide lehrreich:**

1. **Die `process.exit`-Sabotage beendete den TEST.** Gemessen: **2 statt 19** Prüfungen und
   **EXIT=0** – eine Gegenprobe, die wie ein sauberer Lauf aussieht (Regel 34 in ihrer
   gefährlichsten Ausprägung, weil der Exit-Code hier nicht rot, sondern GRÜN log). Seitdem
   bekommt die geschnittene Funktion ein `process` mit abgefangenem `exit`.
2. **`4` suchte `.pending` per `indexOf`** – und fand den ersten Treffer, der schon ganz oben im
   Sperr-Zweig steht, wo der Marker GESCHRIEBEN wird. Eine Sabotage, die den Neustart davorzieht,
   blieb dadurch grün. Gescopt wird jetzt auf die Nachhol-Stelle (den rekursiven Aufruf), und
   `4b2` prüft zusätzlich das `return` dahinter – ohne das liefe der Neustart trotzdem und der
   gerade angestoßene Deploy verlöre seinen Prozess mitten im Pull.

### AUSFALL NR. 11 (22.08.2026) – der Blob hat ihn WÄHREND des Ausfalls gezeigt

Der Merge von #165 lief an, und `/api/health` meldete über 14 Minuten unverändert:

```
{"commit":"48d8676","checkout":"48d8676","blob":"e93a879","uptimeSec":821}
```

**Die drei Felder widersprechen sich, und das ist die Diagnose:** `e93a879` ist
`d5a861c:server.js` – der Prozess führte also die **neue** Datei aus, während `.git/HEAD` noch
auf dem alten Commit stand. Derselbe Fingerabdruck wie Nr. 9: Der Pull hat den Arbeitsbaum
geschrieben, nodemon hat daraufhin neu gestartet, und der Ref wurde nie aktualisiert.

**Das Neue daran ist der Zeitpunkt.** Bei Nr. 8 und 9 fiel derselbe Zustand erst auf, als der
NÄCHSTE Merge nicht ankam – der Blob war die Diagnose *hinterher*. Hier stand der Widerspruch
schon in der ersten Messung nach dem Merge. Das ist die Richtung, für die das Feld gebaut wurde,
und ihre erste Anwendung.

**Vor dem Alarm wurde das Instrument geprüft** (dieselbe Familie wie Regel 15/17/19), sonst wäre
die Meldung nicht von einem Messfehler zu unterscheiden gewesen:

- `gitKopfJetzt()` puffert **10 Sekunden**; die Messungen lagen 20–30 s auseinander, waren also
  alle frisch. `commit` ist ohnehin ein zweiter, unabhängiger Lesevorgang (einmalig beim Start).
- Der Deploy-Timeout aus #134 liegt bei **10 Minuten** – ein langsamer Pull hätte den Ref also
  noch nachziehen können. 14 Minuten beobachtet, `uptimeSec` wuchs dabei lückenlos weiter (kein
  Neustart, kein zweiter Versuch).

**Aufgelöst hat es der Pull von #166**, nicht eine Reparatur, die von hier aus sichtbar gewesen
wäre. Und #166 kann das nicht selbst getan haben: Es fügt ausschließlich den Mail-Alarm hinzu und
enthält gemessen **keine** Aufräum-Logik (kein `checkout`, `reset`, `clean`, `stash`, keine
Änderung an `DEPLOY_TARGETS`). Ein Pull überschreibt einen verschmutzten Arbeitsbaum nicht – er
ist also auf einen bereits sauberen gelaufen. Von außen ist nicht messbar, wodurch.

**Eine Vorhersage von mir ist damit weder bestätigt noch widerlegt, und das gehört dazu:** Ich
hatte gemeldet, jeder künftige Pull, der `server.js` anfasst, breche ab. Die Begründung steht
weiterhin (`server.js` galt git als lokal geändert, und `48d8676` gegen `origin/master`
unterschied sich in genau dieser einen Datei) – belegt hat dieser Lauf sie nicht, weil der Baum
vorher sauber war. **Eine Vorhersage, deren Bedingung jemand wegräumt, ist nicht geprüft**, und
sie als bestätigt zu führen wäre genau die Sorte Behauptung, die dieses Dokument sonst misst.

**Für den Alarm aus #166 ist Nr. 11 der Anlassfall** – und die Prüffrage dazu: Er hängt an den
zwei FEHLERAUSGÄNGEN von `starteDeploy`. Ein Pull, der abgeschnitten wird, meldet mit hoher
Wahrscheinlichkeit einen Fehler oder eine Zeitüberschreitung, träfe also einen davon; sicher ist
das von außen nicht (die Antwort steht nur im Container-Log). **Und er feuert erst, wenn
`DEPLOY_ALARM_MAIL` als Container-Env gesetzt ist** – dafür genügt der Webhook-Pull nicht, der
Container muss neu erzeugt werden. Solange das aussteht, ist der Alarm gebaut und still.

**Folge für PRs:** Der Merge ist nicht der Zwischenschritt zu einem späteren Deploy, sondern die Auslieferung selbst – was gemerged wird, läuft Sekunden später auf dem Pi. Offene PRs trotzdem sofort mergen statt sie liegen zu lassen, aber erst nach grünem Prüflauf.

## Urmaterie-Nachsaat und -Boden in astAlleFelder (28.08.2026)

**Anlass:** Spieler-Report Sascha „kein einziger Urmaterie-Asteroid" — die Felder entstanden am
16.08. mit der Sortentabelle VOR #117 und wurden nie migriert; die Startpopulation konnte
bauartbedingt keinen Urmateriekern enthalten, und neue Sorten entstehen nur nach vollständiger
Leerförderung (p = 3/103 je Neuwurf). Die Frontend-Hälfte (Sichtbarkeit) steht in der
Frontend-CLAUDE.md; hier die zwei Mechaniken.

**Beide leben in `astAlleFelder()` — dem EINEN Tor**, durch das jeder Feldzugriff läuft (lazy
Erzeugung, Nachschub, Festungs-Reifung). Eine dritte Stelle daneben wäre die übliche zweite
Wahrheit; hier erben künftige Aufrufer beides automatisch.

1. **Die Nachsaat läuft GENAU EINMAL** und setzt so viele Urmateriekerne nach, dass 3 stehen.
   Ihr Marker `db.galaxy.urmaterieNachsaat` liegt bewusst in `db.galaxy`: Das ist für Clients über
   die Storage-Route **gar nicht erreichbar** (dieselbe Begründung wie bei den Alien-Nestern) —
   ein löschbarer Marker wäre eine wiederholbare Geldquelle. Gesetzt wird er nur, wenn `db.galaxy`
   schon existiert; ein hier angelegtes leeres Objekt hebelte die Voll-Initialisierung im
   `galaxyTick` aus.
2. **Der Boden greift NUR bei Bestand 0** und setzt genau EINEN Kern. Kein Ziel-Bestand, keine
   Quote — die Sorte bleibt selten, aber „in der ganzen Galaxie liegt keiner" kann nicht mehr
   vorkommen. Bei Bestand ≥ 1 tut er nachweislich nichts (`test_urmaterie_boden_http` 3b).

**`astUrmaterieSetzen` verteilt statt zu fluten:** je Durchgang höchstens EIN Kern je System
(gemischte Systemliste), nur auf Plätze aus `astFreiePlaetze` (festungsbewusst), unter
`AST_GRENZE_MAX`, als ganz normales Vorkommen über `astNeuesVorkommen` mit `sorte = 'urmaterie'`.
**Nichts Bestehendes wird gelöscht oder umgewürfelt** — eine Migration, die Bestand anfasst, nähme
Spielern etwas weg, das sie gerade anfliegen.

**Die Auslieferungsreihenfolge ist gleichgültig** (anders als bei den Festungs-Schaltern): Das
Backend allein setzt Vorkommen, die das alte Frontend als normale graue Brocken zeichnet — korrekt,
nur unauffällig; das Frontend allein zeichnet gold, was der Zufall irgendwann liefert. Kein
Schalter nötig; die zwei PRs gehören trotzdem zusammen gemerged.

Wächter: `tests/test_urmaterie_boden_http.js` (Port 3232, 11 Prüfungen — Nachsaat exakt 3 in DREI
verschiedenen Systemen, nichts gelöscht, Idempotenz über einen Neustart, Boden 0→1 und ≥1→nichts,
Marker-Zeitstempel unverändert). Gegenprobe über `URMATERIE_TEST_SERVER` an einer Kopie ohne den
Block (die Kopie MUSS im Repo-Verzeichnis liegen, `require('./mailer')`): **8 rot, 3 grün bei
identischen Prüfnamen** — die gemessene Pflichtliste steht im Test-Kopf, samt der Lehre, dass die
ERSTE Fassung dieser Liste doppelt falsch war (drei Prüfungen aus dem falschen Grund grün über
leeren Listen bzw. `undefined === undefined`, Frontend-Regel 28; seither verlangen sie erst einen
WERT, dann die Beziehung).

## Chat-Großetappe A: der Bündel-Abruf (28.08.2026)

Auftrag Sascha („müssen auch noch mal was am Chat machen… mach mal wir Ideen dazu", danach über
`AskUserQuestion` gewählt: **„Großetappe: alles"** — Bündel-Abruf, dann Live-Aktualisierung im
Frontend, dann Historie/Komfort). Dieses Repo liefert die Etappen A und die Backend-Hälfte von C;
die Frontend-Hälften stehen in der Frontend-CLAUDE.md, sobald sie gebaut sind.

**Der Anlass ist gemessen:** Das Frontend las einen Chat-Kanal in ~1+50 Anfragen (`storage-list`
für die Schlüssel, dann `storageGet` je Nachricht) — gegen das globale Rate-Limit von 240/min je
Verbindung. Ein Panel-Öffnen mit beiden Kanälen verbrauchte davon rund 100, und ein offenes Panel
aktualisierte sich trotzdem NIE von selbst (kein Poll — er wäre mit dem alten Lesemuster gar nicht
bezahlbar gewesen). Genau deshalb ist der Bündel-Abruf die VORAUSSETZUNG der Live-Aktualisierung,
nicht eine Komfort-Route daneben.

### `GET /api/chat/:kanal` — vier Entscheidungen, die man kennen muss

- **Die Leserechte sind exakt die des alten Wegs: `authMiddleware`, mehr nicht.** Das Lesen von
  Chat-Schlüsseln war im generischen Storage schon immer für jedes angemeldete Konto offen
  (`checkChatKeyPermission` prüft nur das SCHREIBEN, `authorId === req.userId`). Die Route öffnet
  also nichts, sie bündelt. Prüfung 3c hält das als bewusste Haltung fest — ein Nicht-Mitglied
  darf den Allianz-Kanal lesen, wie beim alten Weg auch. **Wer das je ändern will, ändert BEIDE
  Wege**, sonst ist die Sperre eine Attrappe neben einer offenen Tür.
- **Der Allianz-Tag wird nur FORMAL geprüft** (kein Doppelpunkt, Länge ≤ 16): Er landet als Präfix
  in einer In-Memory-Suche über `Object.keys`, nie in einem Pfad oder Befehl — ein erfundener Tag
  liefert schlicht eine leere Liste, genau wie beim alten `storage-list`-Weg. Der Doppelpunkt ist
  trotzdem verboten, weil er die Schlüssel-Grammatik sprengt (`alliance:A:B:msg:` läse einen
  fremden Namensraum an).
- **Sortiert wird über `chatKeyTimestamp`** (numerisch nach dem Zeitstempel im Schlüssel, wie
  `pruneChatKeys`) — eine String-Sortierung wäre bei zehnstelligen gegen dreizehnstellige
  Zeitstempel falsch. Der Test hält das mit einem Prüfstein fest, den nur die numerische
  Sortierung besteht: ein Schlüssel `…:msg:9999999999-alt` (April 1970!) zwischen dreizehnstelligen
  — lexikografisch die „neueste", numerisch die älteste Nachricht.
- **Der limit-Deckel hängt an `CHAT_KEEP_PER_CHANNEL`**, nicht an einer eigenen zweiten Zahl —
  mehr als die Aufbewahrung hält, kann es nicht geben, und zwei Obergrenzen nebeneinander liefen
  beim nächsten Umbau auseinander. Vorgabe ohne Parameter: 50 (die bisherige Lesetiefe des
  Frontends). `neuesteTs` in der Antwort erlaubt dem künftigen Poll die billige Frage „gibt es
  Neues?", ohne die Nachrichtenliste selbst zu vergleichen.

### Retention 300 statt 100 (die Backend-Hälfte von Etappe C)

`CHAT_KEEP_PER_CHANNEL` steht seit dieser Etappe auf **300**. Das alte Größenargument („jede
Abfrage überträgt alles mit — je Schlüssel eine Anfrage") gilt mit dem Bündel-Abruf nicht mehr:
Das Panel kann über „Ältere anzeigen" bis zur vollen Tiefe lesen, in EINER Antwort. Der Kommentar
an der Konstante sagt ausdrücklich, dass die Obergrenze des Bündel-Abrufs an DERSELBEN Konstante
hängt — wer sie ändert, ändert beides zugleich.

### Der Wächter: `tests/test_chat_buendel_http.js` (Port 3233, 19 Prüfungen, drei Gegenproben)

**Belegte Testports sind jetzt 3195–3233** — ein neuer Test nimmt 3234.

Die Fixture ist so KONSTRUIERT, dass jede Erwartung aus ihr folgt statt aus einer Momentaufnahme
(Frontend-Regel 2): 309 globale Nachrichten (g0…g308, Zeitbasis fest, Abstand 10 ms) plus ein
kaputter Nicht-JSON-Eintrag zwischen g250 und g251 — zusammen 310 Schlüssel, also 10 über der
Aufbewahrung. Der `galaxyTick` beim Serverstart (`setImmediate`) ruft `pruneChatKeys` und muss auf
300 schneiden: g0…g9 weg, g10 die älteste verbleibende (Abschnitt 5). 5c misst dieselbe Wahrheit
über den ALTEN Weg (`storage-list` zählt 300 = 299 gültige + der kaputte), damit Bündel-Abruf und
Altweg keine zwei Welten zeigen können.

Drei Gegenproben, alle beidseitig gefahren, identische Prüflisten per `diff` (Frontend-Regel 60),
jede mit gemessener „was muss fallen"-Liste (Regel 71) im Test-Kopf:

| Gegenprobe (via `CHAT_TEST_SERVER`, Kopie im Repo-Verzeichnis wegen `require('./mailer')`) | fällt |
|---|---|
| alter Stand (`origin/master` vor der Etappe) | **18 von 19** — nur `0-vorab` bleibt |
| `keys.sort()` ohne Komparator in der Route | genau `3a` + `3b` (Beleg: `neuesteTs 9999999999`) |
| limit-Absicherung entfernt | genau `1a`, `1b`, `2b` (`parseInt(undefined)` → NaN → `slice(-NaN)` liefert ALLES) |

**Zwei Vorhersagen der Pflichtlisten waren zu eng und sind an der Messung korrigiert worden**
(dieselbe Lehre wie bei `test_urmaterie_boden_http`): Die Sortier-Sabotage reißt auch `3b`
(`neuesteTs` liest den LETZTEN Schlüssel der sortierten Liste), und die limit-Sabotage reißt auch
`1a`/`1b` (der Vorgabe-Pfad OHNE Parameter läuft durch dieselbe entfernte Zeile). Eine
Pflichtliste ist selbst eine Behauptung, bis die Gegenprobe sie gemessen hat.

### Auslieferungsreihenfolge: dieses Repo zuerst, und sie ist ungefährlich

Das Backend allein live stellt eine Route bereit, die noch niemand aufruft — folgenlos. Das
Frontend der Etappe B baut einen **Rückfall auf den alten Weg** ein (bei 404/nicht-ok antwortet
ein alter Server, und das Panel liest wie bisher je Schlüssel) — „der Server darf hinterherhinken,
das Frontend nicht". Ein Schalter ist deshalb nicht nötig. Die Retention 300 allein ist ebenfalls
harmlos: Der alte Client liest ohnehin nur die neuesten 50.

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
