# CLAUDE.md – kolonie-kepler7-backend

Diese Datei ist absichtlich kurz. Sie enthält nur Startkontext und Regeln, die in praktisch jeder
Sitzung gelten. Die Begründungen, Messungen, Vorfälle und Etappen-Beschreibungen liegen unverändert
unter `docs/` (Übersicht am Ende). Wer einen Bereich anfasst, liest vorher dessen Datei dort.

## Projekt in 30 Sekunden

- Node.js/Express-Backend für Kolonie Kepler-7. Eine Datei `server.js` (107 Routen), dazu `mailer.js`.
- Läuft als Docker-Container `kepler7-backend` auf einem Raspberry Pi 4 (CasaOS, Portainer-Stack).
- „Datenbank" ist eine JSON-Datei (`db.json`): `db.users`, `db.private[userId]` (Spielstand, klientenautoritativ),
  `db.shared` (Allianzen, Markt, Chat, Weltboss), `db.galaxy` (Nester, Konvois, NPC-Stärke), `db.notAus`, `db.bonusCodes`.
- **Ein Push nach `master` geht von selbst live** (Deploy-Webhook, Selbst-Neustart, rund 7 s 502). Der Merge IST die Auslieferung.
- Frontend (`kolonie-kepler7`) und dieses Repo teilen sich Kopie-Familien von Tabellen und Formeln; die Paritätstests liegen im Frontend-Repo.

## Kritische Regel: DB_FILE nie hart pfaden

```js
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');
```
Gilt für **jedes** Skript, auch neue Standalone-Skripte. Im Container ist `DB_FILE=/data/db.json` gesetzt, das
Arbeitsverzeichnis ist NICHT `/data`. Dasselbe gilt für `VAPID_PUBLIC_FILE`/`VAPID_PRIVATE_FILE`.

## Vor jedem Commit (Pflicht)

1. `node --check server.js`
2. `node tests/test_serverstart.js` – drei Sekunden; `node --check` parst nur und führt nie aus. Ein Backend,
   das nicht startet, ist der teuerste Fehler dieses Projekts, weil der Merge die Auslieferung ist.
3. Bei sicherheitsrelevanten Änderungen an geteiltem Speicher, Kampf, Markt oder Belohnungen: **echte HTTP-Tests**
   gegen einen lokal gestarteten Server (`DB_FILE=/tmp/...`), Serverstart und Test im selben Bash-Aufruf.
4. Die HTTP-Tests des berührten Bereichs laufen lassen (`tests/test_<bereich>_http.js`).
5. Testartefakte entfernen; `node_modules` darf liegen bleiben (`.gitignore`).

## Regeln, die fast immer gelten

**Sicherheitsgrenze.** Der eigene Spielstand ist bauartbedingt klientenautoritativ (nur `SAVE_SANITY_LIMITS`).
Verteidigt wird die Frage „**Kann ich etwas anfassen, das ANDEREN gehört oder allen gemeinsam ist?**"
Daraus folgt:
- Der generische Shared-Storage (`PUT /api/storage/:key?shared=true`) ist für jeden eingeloggten Nutzer offen.
  Jeder neue geteilte Schlüssel braucht eine Rechteprüfung (`check*KeyPermission`) oder wohnt in `db.galaxy`
  (für Clients gar nicht erreichbar).
- Der Server ist Autorität für alles PvP-Relevante (Angriffskraft, Verteidigung, Marktpreise, Belohnungen).
  `/api/attack` und die Festungs-/Nest-Schläge nehmen **keinen Kampfparameter** aus dem Request; die Wahl steht im Spielstand.
- Zähler, an denen Belohnungen oder Bestenlisten hängen, liegen am **Nutzerobjekt** (`user.*`), nie im Spielstand.
  Abklingzeiten liegen **am Ziel** (`ziel.schlaege[userId]`), nie im Spielstand.
- Belohnungen gehen über `pushPendingReward` mit **eigenem `type`**; der Frontend-Zweig dazu gehört zwingend in denselben Auftrag.
- **Deckel dürfen niemals Daten löschen** – sie begrenzen nur das Wachstum. Vorher durchdenken, was beim Ablauf eines Rangs passiert.
- Jede neue `jwt.sign`-Stelle nimmt `tv: user.tokenVersion || 0` in den Payload.
- Eine Sicherung, deren Ausfall wie Normalbetrieb aussieht, ist keine (fail-closed für Sicherungen, fail-open nur für Benachrichtigungen).

**Kopie-Familien und Auslieferungsreihenfolge.**
- Tabellen wie `SHIP_SCORE_WEIGHTS`, `SHIP_ATK_VALUES`, `SHIP_DEF_WEIGHTS`, `COUNTER_ROLE_*`, `KOSMETIK_DEFS`,
  `GEFECHTSVORRAETE`, `SHIP_MODULE_*`, Festungs-, Nest- und Weltboss-Tabellen existieren im Frontend ein zweites Mal.
  Bei jeder Änderung beide Seiten pflegen; Reihenfolge in `COUNTER_ROLE_OF` ist testrelevant.
- Eine neue Schiffsklasse lebt in **sechs** Tabellen: `grep -c "<schluessel>" server.js` muss 6 sein, jede Auslassung mit Begründung.
- Ändert ein Backend-Merge eine spielersichtbare Zahl oder liest das Frontend ein neues Feld: **Backend zuerst live**, per `/api/health`
  belegt, dann Frontend. Für Mechaniken, die das Frontend noch nicht kennt, gibt es Notausschalter
  (`FESTUNG_SPAWN_AKTIV`, `FESTUNG_BAUTEILE_AKTIV`, `NEST_SPAWN_AKTIV`, `A2_SPAWN_AKTIV`, `VORPOSTEN_AKTIV`); umgelegt werden sie im **Frontend-PR**.
  Der Admin kann sie zur Laufzeit nur AB-, nie einschalten (`db.notAus`).
- Ein Refactor, der eine Funktion zusammenführt, die ein Frontend-Test liest, wird im PR-Text benannt.

**Persistenz und Prozess.**
- `saveDb()` bündelt Schreibvorgänge (In-Flight-Coalescing); `db` immer **synchron vor** `saveDb()` mutieren, nie im `await`-Callback.
- Die Graceful-Shutdown-Handler (`SIGTERM`/`SIGINT`) flushen die DB; nicht entfernen.
- **Temporale Todeszone:** `galaxyTick` und andere Startaufrufe sehen jede `const` weiter unten in der Datei nicht.
  Startläufe gehören in `setImmediate(...)`; `node --check` findet diesen Fehler nicht.
- Konstanten in einem `function`-Rumpf lesen, nicht in einem Objektliteral mit direkten Verweisen.

**Tests.**
- Jeder neue Test braucht eine **Gegenprobe in beide Richtungen** (grün am neuen, rot am alten oder sabotierten Stand), mit einer
  gemessenen „was fallen MUSS"-Liste; Prüfnamen beider Läufe per `diff` vergleichen, nicht zählen (die Schlusszeile `FAIL - …` zählt sonst mit).
- Freien Port **messen**, nicht aus einer Liste lesen: `grep -hoE "3[12][0-9][0-9]" tests/*.js | sort -un`.
- Ein Persistenz-Test stoppt den Server mit **SIGKILL**; SIGTERM flusht die DB und verdeckt einen fehlenden `saveDb()`.
- Tests, die einen Schalter umlegen, starten eine **Kopie** von `server.js` im Repo-Verzeichnis (`require('./mailer')` löst nur dort auf).
- Der Spielstand in `db.private` liegt in ZWEI Formen vor (Zeichenkette oder `{ value, version }`); Tests lesen beide.
- Testkonten nur mit Kleinbuchstaben; `db.users` speichert Schlüssel kleingeschrieben. Admin-Konto heißt `gamegeeeeek`.
- Anfängerschutz (`__attackShieldUntil`) für Angriffs-Tests bei gestopptem Server nullen; jede Messung ein frisches Opfer.
- Eine DB-Änderung bei laufendem Server ist beim nächsten Stopp weg (der Flush überschreibt sie): stoppen → ändern → starten.
- Prozesse über `ps` und PID beenden, nie `pkill -f <muster>` (trifft die eigene Shell, Exit 144).
- Ein fertiger Änderungssatz wird **sofort committet und gepusht**; der Remote-Container kann jederzeit recycelt werden.

**Betrieb.**
- **Nie direkt per SSH auf den Pi.** Befehle als Text an Sascha, er führt sie aus und schickt die Ausgabe.
- **Nie nach Secrets fragen oder sie sich zeigen lassen.** Der Portainer-Stack enthält Resend-Schlüssel, Deploy-Secret und
  Ko-fi-Token im Klartext; er gehört in kein Repo, keinen Bericht, keinen Chat.
- Schreibzugriffe auf die echte `db.json` nur über von Sascha ausgeführte Befehle, Container vorher stoppen.

## Deploy in fünf Sätzen

Der Webhook zieht bei jedem Push (`git pull` in `/app`), räumt vorher nachweislich halb angewendete Pulls weg
(`deployAufraeumen`) und beendet den Prozess nach einem Pull, der geladenen Code geändert hat; Docker startet ihn neu.
`GET /api/health` beantwortet jede Deploy-Frage ohne SSH: `commit` (beim Start gelesen), `checkout` (jetzt auf der Platte),
`blob` (die wirklich ausgeführte `server.js`, vergleichbar mit `git rev-parse <commit>:server.js`), `uptimeSec`, `selbstNeustart`.
`checkout` neuer als `commit` ist nur dann eine Störung, wenn der Commit `.js`/`.json` geändert hat. Eine Handänderung an `server.js`
auf dem Pi blockiert jeden Pull und bekommt keinen Neustart geschenkt (`docker restart kepler7-backend`).
Alles Weitere, insbesondere der Wiederherstellungsweg und die Ausfall-Historie: `docs/deploy.md` und `docs/deploy-historie.md`.

## Dokumentation

| Datei | Inhalt |
|---|---|
| `docs/ARCHITECTURE.md` | Architektur, geteilter Speicher, bekannte Fallstricke (Stand des Speicher-Audits) |
| `docs/deploy.md` | Deploy-Mechanik, Alarm, Diagnose in drei Schritten |
| `docs/deploy-historie.md` | alle Ausfälle Nr. 1–12 mit Messungen, Reparaturwegen, Container-Umbau, Selbstheilung |
| `docs/PROJECT_MEMORY.md` | übertragbare Lehren (Todeszone, ephemere Umgebung) |
| `docs/unterstuetzer-und-wirtschaft.md` | Rang vs. Freigabe, Kosmetik, Sternenstaub, Markt-Deckel, Gefechtsvorräte |
| `docs/asteroidenfestungen.md` | Festungen Phase 1 und 2 (Kern, Hort, Bauteile, Zielwahl) |
| `docs/asteroidenfeld.md` | Kampfvermerk am Vorkommen, Urmaterie-Nachsaat und -Boden |
| `docs/alien-nester.md` | Nester, bewegliche NPC-Stärke, Verbandsangriff, PvE-Embleme (Phase 3–6) |
| `docs/wrackkonvois.md` | A2, die wandernden Beute-Ziele |
| `docs/vorposten.md` | B2, Vorposten: spielergebaute PvP-Ziele in db.shared, Stufen, Garnison, Schalter |
| `docs/beute.md` | Boss-Set-Teile ohne Allianz, mythische Stufe |
| `docs/kampfrechnung-paritaet.md` | Flottenverteidigung, Klassen-Sets, Raid-Vorschau, sechs Schiffstabellen, Kausalitätsbrecher |
| `docs/pvp-standorte.md` | `targetPlanet` an `/api/attack`, Standort-Verteidigung |
| `docs/sicherheit-auth.md` | Passwort-Regeln, Sitzungs-Cookie (Etappen a und b) |
| `docs/admin.md` | Bonuscodes, Betreiber-Push, Admin-Fähigkeiten, Notaus, Aktivitäts-Uhr und ihre Erweiterungen (Verdacht, Geschenk, abgelehnte Spielstände) |
| `docs/chat.md` | Bündel-Abruf, Retention |
| `docs/ki-kampfberichte.md` | Etappe E1a: Prompt-Zuschnitt, Wahrheits-Sperren, Warteschlange, `KAMPFTEXT_AKTIV` |

Der vollständige frühere Text dieser Datei liegt in der Git-Historie vor dem 01.09.2026.

## Dokumentation künftig pflegen

- Gilt fast immer? → nur dann kurz hierher.
- Betrifft einen Bereich? → in dessen `docs/`-Datei, am Ende anfügen, mit Datum.
- Deploy-Vorfall? → `docs/deploy-historie.md`, Mechanik-Änderung in `docs/deploy.md`.
- Übertragbare Lehre? → `docs/PROJECT_MEMORY.md`, nur wenn sie künftiges Verhalten konkret ändert.
- Einmalige Sitzungshistorie? → nicht dauerhaft dokumentieren; Commit und PR reichen.

Diese Datei soll nicht wieder zum Sitzungsarchiv wachsen. Richtwert: unter 10 KB.
