# CLAUDE.md – kolonie-kepler7-backend

Node.js/Express-Backend für Kolonie Kepler-7. Läuft als Docker-Container `kepler7-backend` auf einem Raspberry Pi 4 (CasaOS). Einfache JSON-Datei als "Datenbank" (`db.json`), kein echtes DBMS.

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
   dieses Projekts – der Merge ist die Auslieferung, und nodemon startet Sekunden später neu.
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
2. **Kein `cookie-parser`.** Eine neue Abhängigkeit ändert `package.json`, und die verlangt auf dem
   Pi zusätzlich ein `docker restart` von Hand (nodemon installiert nichts nach). Für das Lesen
   *eines* Namens ist das ein schlechter Tausch – `leseCookie()` sind zwölf Zeilen.
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

## Bekannte Fallstricke

- **Backend hat teils eigene Kopien von Frontend-Formeln** zur serverseitigen Validierung (z.B. `ALLIANCE_STRUCTURE_COSTS`/`ALLIANCE_EXPANSION_BONUSES` gegen echte Allianz-Beiträge, `SHIP_SCORE_WEIGHTS`/`computeScoreServer()` gegen `computeScore()` im Frontend für den Bestenlisten-Score). Bei Änderungen an der jeweiligen Frontend-Formel **immer** die Backend-Kopie mitpflegen, sonst lehnt der Server legitime Aktionen ab, lässt zu wenig durch, oder validiert gegen einen veralteten Score.
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

Container-Setup (per `docker inspect` verifiziert, 19.07.2026): Startbefehl ist `npm install && npx nodemon --watch . --ext js,json server.js` – der Container beobachtet Code-Änderungen im Bind-Mount selbst und startet `server.js` automatisch neu. Der Webhook-Pull genügt deshalb für die meisten Deploys; **nur bei geänderter `package.json`/`package-lock.json` braucht es zusätzlich `docker restart kepler7-backend`**, weil nodemon keine neuen Abhängigkeiten nachinstalliert. Das ist der einzige Fall, der noch einen manuellen Schritt von Sascha verlangt.

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
- **Der Container sammelt Zombies.** PID 1 im Container ist `npm exec nodemon`, und das erntet
  verwaiste Kinder nicht ab. Gemessen am 18.08.: mehrere hundert `[git] <defunct>` (dazu ein
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

Steht dort „erfolgreich", ist der Pull durch und nodemon hat nicht neu gestartet (dann `docker
restart kepler7-backend` – Vorsicht, der Startbefehl beginnt mit `npm install`). Steht dort ein
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
- **`checkout` neuer als `commit`** – der Pull ist durch, **nodemon hat nicht neu gestartet**.
  Genau der Fall, für den die Doku `docker restart kepler7-backend` empfiehlt und den man
  bisher nur im Container-Log sehen konnte.

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

**Folge für PRs:** Der Merge ist nicht der Zwischenschritt zu einem späteren Deploy, sondern die Auslieferung selbst – was gemerged wird, läuft Sekunden später auf dem Pi. Offene PRs trotzdem sofort mergen statt sie liegen zu lassen, aber erst nach grünem Prüflauf.
