# Unterstützer, Kosmetik, Sternenstaub, Markt-Deckel, Gefechtsvorräte

Verschoben aus `CLAUDE.md` am 01.09.2026 (Strukturprüfung, Punkt 1: Startkontext verkleinern). Wortlaut unverändert; Querverweise wie „unten" oder „oben" beziehen sich auf die frühere Reihenfolge in `CLAUDE.md`. Neue Erkenntnisse zu diesem Bereich gehören ab jetzt hierher, nicht in `CLAUDE.md`.

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


