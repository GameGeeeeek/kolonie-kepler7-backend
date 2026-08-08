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

## Architektur

- `db.shared` – generischer Key-Value-Speicher für alles Multiplayer-Relevante (Allianzen, Markt, Weltboss-Beiträge). Frontend schreibt direkt über `GET/PUT /api/storage/:key`.
- `POST /api/kofi-webhook` / `GET /api/kofi-top-supporter` – Ko-fi-Spenden-Integration (13.07.2026): zeigt den aktuellen Top-Unterstützer im Spiel. Braucht `KOFI_VERIFICATION_TOKEN` (aus ko-fi.com/manage/webhooks, Bereich "Advanced") als Env-Var auf dem Pi, sonst wird jeder Webhook-Aufruf verworfen. Anonyme Spenden (`is_public:false`) fließen NUR in `db.kofiSupportersAnonymousTotal` (Summe ohne Namen) - Namen werden bei anonymen Spenden nie irgendwo gespeichert oder geloggt, auch nicht in Server-Logs.
- `checkAllianceKeyPermission()` – zentrale Rechteprüfung für `alliance:*`-Schlüssel, wird in den generischen Storage-Routen aufgerufen. Rollen: admin > officer > member.
- `db.private[userId]` – der eigentliche Spielstand jedes Nutzers (JSON-Blob, `kepler7-save-v3`-Key).
- Server ist für PvP-relevante Berechnungen (Angriffskraft, Marktpreise, Allianz-Freischaltungen) die Autorität – Client-Werte werden dort nicht blind übernommen, sondern serverseitig aus dem gespeicherten Spielstand neu berechnet.

## Bekannte Fallstricke

- **Backend hat teils eigene Kopien von Frontend-Formeln** zur serverseitigen Validierung (z.B. `ALLIANCE_STRUCTURE_COSTS`/`ALLIANCE_EXPANSION_BONUSES` gegen echte Allianz-Beiträge, `SHIP_SCORE_WEIGHTS`/`computeScoreServer()` gegen `computeScore()` im Frontend für den Bestenlisten-Score). Bei Änderungen an der jeweiligen Frontend-Formel **immer** die Backend-Kopie mitpflegen, sonst lehnt der Server legitime Aktionen ab, lässt zu wenig durch, oder validiert gegen einen veralteten Score.
- **Generischer Shared-Storage ohne Sonderregel ist für JEDEN eingeloggten Nutzer weit offen** (lesen UND schreiben) – nicht nur für Mitglieder der jeweiligen Allianz/Gruppe. Neue sicherheitsrelevante Unterressourcen brauchen eine explizite Prüfung in `checkAllianceKeyPermission()` (oder einer äquivalenten Funktion für neue Systeme), sonst kann jeder Beliebige den Wert manipulieren.
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

**Folge für PRs:** Der Merge ist nicht der Zwischenschritt zu einem späteren Deploy, sondern die Auslieferung selbst – was gemerged wird, läuft Sekunden später auf dem Pi. Offene PRs trotzdem sofort mergen statt sie liegen zu lassen, aber erst nach grünem Prüflauf.
