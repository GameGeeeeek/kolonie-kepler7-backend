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
- `checkAllianceKeyPermission()` – zentrale Rechteprüfung für `alliance:*`-Schlüssel, wird in den generischen Storage-Routen aufgerufen. Rollen: admin > officer > member.
- `db.private[userId]` – der eigentliche Spielstand jedes Nutzers (JSON-Blob, `kepler7-save-v3`-Key).
- Server ist für PvP-relevante Berechnungen (Angriffskraft, Marktpreise, Allianz-Freischaltungen) die Autorität – Client-Werte werden dort nicht blind übernommen, sondern serverseitig aus dem gespeicherten Spielstand neu berechnet.

## Bekannte Fallstricke

- **Backend hat teils eigene Kopien von Frontend-Formeln** zur serverseitigen Validierung (z.B. `ALLIANCE_STRUCTURE_COSTS`/`ALLIANCE_EXPANSION_BONUSES` gegen echte Allianz-Beiträge, `SHIP_SCORE_WEIGHTS`/`computeScoreServer()` gegen `computeScore()` im Frontend für den Bestenlisten-Score). Bei Änderungen an der jeweiligen Frontend-Formel **immer** die Backend-Kopie mitpflegen, sonst lehnt der Server legitime Aktionen ab, lässt zu wenig durch, oder validiert gegen einen veralteten Score.
- **Generischer Shared-Storage ohne Sonderregel ist für JEDEN eingeloggten Nutzer weit offen** (lesen UND schreiben) – nicht nur für Mitglieder der jeweiligen Allianz/Gruppe. Neue sicherheitsrelevante Unterressourcen brauchen eine explizite Prüfung in `checkAllianceKeyPermission()` (oder einer äquivalenten Funktion für neue Systeme), sonst kann jeder Beliebige den Wert manipulieren.
- **"Letzter Admin verlässt die Allianz"**-Art von Randfällen: bei mehrstufigen Freigabe-Refactors (z.B. "letzter Admin darf nicht mehr verlassen") prüfen, ob interne Funktionen (wie Allianz-Auflösen, die selbst die eigene Rolle auf 'left' setzen) durch die neue Regel blockiert würden – eigene Rolle in solchen Fällen bewusst zuletzt schreiben.
- Reine Lese-Skripte (Analyse, Daten sammeln) sind risikolos gegen das echte Repo klonbar; **Schreiboperationen an der echten `db.json` auf dem Pi** immer nur über von Sascha manuell ausgeführte SSH-Befehle, nie direkt von hier aus.

## Deploy

Push nach `master` ändert nichts automatisch – Sascha zieht und startet den Container auf dem Pi manuell per SSH neu.
