# Deploy: Webhook, Selbst-Neustart, Selbstheilung, Diagnose

Verschoben aus `CLAUDE.md` am 01.09.2026 (Strukturprüfung, Punkt 1: Startkontext verkleinern). Wortlaut unverändert; Querverweise wie „unten" oder „oben" beziehen sich auf die frühere Reihenfolge in `CLAUDE.md`. Neue Erkenntnisse zu diesem Bereich gehören ab jetzt hierher, nicht in `CLAUDE.md`.

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



## Diagnose in drei Schritten (Kurzfassung, 01.09.2026)

Ausführlich mit allen Messungen: `docs/deploy-historie.md`.

1. **Von außen messen, nie `git log` glauben:**
   ```bash
   curl -s https://gamegeeeeek.de/api/health
   ```
   `commit` = beim Start gelesen, `checkout` = jetzt auf der Platte, `blob` = die wirklich ausgeführte `server.js`.
   Erwarteter Blob nach einem Merge: `git rev-parse origin/master:server.js | cut -c1-7`. Bei einem Revert oder reinem
   Doku-Commit ändert sich der Blob nicht; dann tragen nur `commit`/`checkout` die Aussage. 502 mit immer wieder kleiner
   `uptimeSec` heißt halb geschriebene Datei (Neustart-Schleife), nicht toter Container.
2. **Im Container-Log nachsehen, ob überhaupt ein Pull versucht wurde** (Befehl an Sascha):
   ```bash
   docker logs --tail 80 kepler7-backend | grep -i "deploy-webhook"
   ```
   „erfolgreich" ohne Neustart ist bei einem Commit ohne `.js`/`.json`-Änderung korrekt. Ein Fehler nennt die
   blockierende Datei. Gar nichts zum Merge-Zeitpunkt heißt: der Webhook kam nicht an (GitHub → Settings → Webhooks).
3. **Reparieren, je Datei erst messen, dann verwerfen** (Abschnitt „Der Wiederherstellungsweg, falls es wieder passiert"
   und „DIE GRENZE DIESER SELBSTHEILUNG" in `docs/deploy-historie.md`):
   ```bash
   cd /DATA/kepler7/backend
   git status --short                      # JEDE Zeile versorgen
   git hash-object server.js | cut -c1-7   # gegen die eingehenden Commits halten, bevor etwas verworfen wird
   sudo rm -f .git/index.lock              # nur wenn kein lebender git-Prozess (Zombies zählen nicht)
   git checkout HEAD -- server.js CLAUDE.md
   git pull --ff-only origin master
   docker restart kepler7-backend          # nur bei halber Datei nötig
   ```
   In diesem Verzeichnis nie `git clean -x`, `git stash -a` oder `git reset --hard`: dort liegen `db.json`,
   `jwt-secret.txt` und die VAPID-Schlüssel.
