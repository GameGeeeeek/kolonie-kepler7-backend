# CLAUDE.md – kolonie-kepler7-backend

Node.js/Express-Backend für Kolonie Kepler-7. Läuft als Docker-Container `kepler7-backend` auf einem Raspberry Pi 4 (CasaOS). Einfache JSON-Datei als "Datenbank" (`db.json`), kein echtes DBMS.

## Kritische Regel: DB_FILE nie hart pfaden

```js
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');
```
Gilt für **jedes** Skript, auch neue Standalone-Skripte (wie `thank_bugreporter.js`, `send_patchnotes.js`, `reset_alliance_progress.js`). Im Container ist `DB_FILE=/data/db.json` gesetzt – das Arbeitsverzeichnis ist NICHT `/data`. Dasselbe gilt für `VAPID_PUBLIC_FILE`/`VAPID_PRIVATE_FILE`.

## Vor jedem Commit (Pflicht)

1. `node --check server.js`
2. Bei sicherheitsrelevanten Änderungen an geteiltem Speicher (`alliance:*`-Schlüssel, Markt, o.ä.): **echte HTTP-Tests**, nicht nur Syntax-Check. Test-DB in `/tmp` aufsetzen (bcrypt-Hash für Testnutzer, `crypto.randomUUID()` für IDs), Server mit `DB_FILE=/tmp/...` lokal starten, curl-Requests gegen echte Endpunkte. **Serverstart und Test müssen im selben Bash-Aufruf laufen** – über mehrere Tool-Aufrufe hinweg verliert die Sandbox den Hintergrundprozess.
3. Testartefakte (`/tmp/...`, `node_modules`, `package.json`/`package-lock.json` falls nur für den Test installiert) vor dem Commit wieder entfernen.

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

**Der zweite Blocker, unabhängig davon: eine Handänderung an `server.js` auf dem Pi.** Sie fügte
`bergungsfrachter` in `SHIP_SCORE_WEIGHTS` und in die Schiffsliste von `/api/worldboss/resolve` ein
und blockierte JEDEN Pull mit „Ihre lokalen Änderungen würden überschrieben" – tagelang, ohne dass
es jemandem auffiel, weil der Webhook seinen Fehler nur ins Container-Log schreibt. Beide Zeilen
kamen später über git ordentlich herein, der verworfene Stand war also inhaltsgleich; verloren ging
nichts. **Lehre:** Eine Änderung von Hand am ausgecheckten Stand auf dem Pi legt den automatischen
Deploy still lahm. Wer dort etwas ausprobiert, macht es rückgängig (`git checkout -- <datei>`),
sobald er fertig ist – und prüft vor dem Verwerfen mit `git --no-pager diff --numstat -- <datei>`,
ob überhaupt Inhalt drinsteckt (`0 0` heißt: nur ein Dateimodus).

**Nachtrag zur Messmethode oben:** Die 401/404-Messung muss die **HTTP-Methode der Route treffen**.
`curl -X POST` auf `/api/cosmetics` (eine GET-Route) liefert 404 von Express – das sieht aus wie
„Route fehlt", obwohl der Server sie kennt. Genau dieser falsche Alarm ist am 16.08. entstanden.
Deshalb gehört zur Messung eine **Negativkontrolle**: eine frei erfundene Route (`/api/gibtesnicht`)
muss im selben Lauf 404 liefern, und eine bekannte alte Route 401. Erst dann misst man den Server
und nicht die eigene Anfrage.

**Folge für PRs:** Der Merge ist nicht der Zwischenschritt zu einem späteren Deploy, sondern die Auslieferung selbst – was gemerged wird, läuft Sekunden später auf dem Pi. Offene PRs trotzdem sofort mergen statt sie liegen zu lassen, aber erst nach grünem Prüflauf.
