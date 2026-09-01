# Deploy-Historie: alle Ausfälle, Messungen und Reparaturwege

Verschoben aus `CLAUDE.md` am 01.09.2026 (Strukturprüfung, Punkt 1: Startkontext verkleinern). Wortlaut unverändert; Querverweise wie „unten" oder „oben" beziehen sich auf die frühere Reihenfolge in `CLAUDE.md`. Neue Erkenntnisse zu diesem Bereich gehören ab jetzt hierher, nicht in `CLAUDE.md`.

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


