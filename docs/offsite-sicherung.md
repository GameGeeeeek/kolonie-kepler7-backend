# Off-Site-Sicherung: der M715q holt die Datenbank ab

Angelegt am 02.09.2026 (Strukturprüfung, Punkt C1).

## Der Befund

`backupDb()` kopiert `db.json` alle 30 Minuten nach `<Verzeichnis von DB_FILE>/backups/` und hält
48 Stände, also rund einen Tag. Der Kommentar über der Funktion nennt den Fall, gegen den das
hilft: ein Bug, ein versehentliches Überschreiben, eine Beschädigung.

Er nennt nicht den Fall, gegen den es **nicht** hilft. Original und alle 48 Kopien liegen im
selben Volume auf demselben Raspberry Pi. Eine gestorbene SD-Karte, ein verlorenes Volume, ein
Diebstahl — und mit der Maschine sind sämtliche Konten, Spielstände, Allianzen, der Markt und
der Weltboss-Fortschritt weg, ohne dass irgendwo sonst eine Kopie liegt.

## Die Entscheidung: holen, nicht schicken

Der M715q fragt beim Pi an. Der Pi bekommt **keinerlei** Zugang zum M715q.

Das ist der Unterschied, der im Ernstfall zählt: Wer den Pi übernimmt oder sein Dateisystem
zerlegt, erreicht die Kopien damit nicht. Ein Push-Weg hätte dem Pi Schreibrechte auf dem
Sicherungsziel gegeben — dann fällt die Sicherung mit derselben Maschine, gegen deren Ausfall
sie da ist. Nebenbei braucht der Pi so kein einziges neues Geheimnis, das er selbst benutzt.

## Die zwei Routen

Beide liegen **nicht** unter `/api/admin` und **nicht** hinter `authMiddleware`; sie hängen an
einem eigenen Token (`BACKUP_PULL_TOKEN`), damit die Cron-Zeile auf dem M715q kein Admin-Token
braucht — das könnte alles, was der Admin kann.

| Route | Antwort |
|---|---|
| `GET /api/offsite/stand` | neueste Sicherung, Anzahl, Kontenzahl, Zeitpunkt der letzten Abholung |
| `GET /api/offsite/backup` | die Datei selbst; optional `?datei=db-….json` |

`/api/offsite/backup` schickt vier Kopfzeilen mit: `X-Backup-Datei`, `X-Backup-Zeit`,
`X-Backup-Groesse` und `X-Backup-Sha256`. Die Prüfsumme wird über genau die Bytes gebildet, die
rausgehen; die Gegenseite rechnet sie nach. Ohne sie wäre eine unterwegs abgeschnittene Datei
eine Datei, die aussieht wie eine Sicherung.

Die `konten`-Zahl aus `/api/offsite/stand` ist kein Beiwerk: Sie ist der Maßstab, an dem die
Gegenseite eine geschrumpfte Sicherung erkennt. Eine Datei, die sich sauber liest und trotzdem
die Hälfte der Konten verloren hat, ist genau der Fall, den „heruntergeladen, Größe > 0" nicht
sieht.

## Fail-closed

Ohne `BACKUP_PULL_TOKEN` gibt es die Abholung nicht — 503, kein Datenweg. `db.json` enthält
Passwort-Hashes, E-Mail-Adressen und Push-Anmeldungen; ein Endpunkt, der sie im Fehlerfall
ungeschützt herausgibt, wäre schlimmer als gar keine Off-Site-Sicherung.

**Drei Fälle, drei Meldungen** — „ungültig ODER fehlend" ist im Fehlerfall keine Diagnose (die
Formulierung hat im AI-Core-Repo am 17.08.2026 eine ganze Fehlersuche gekostet):

| Lage | Antwort |
|---|---|
| kein `BACKUP_PULL_TOKEN` am Server | 503 „nicht eingerichtet (BACKUP_PULL_TOKEN fehlt)" |
| kein Token mitgeschickt | 401 „Kein Abhol-Token mitgeschickt" |
| falscher Token | 401 „stimmt nicht (**n** Zeichen empfangen)" |

Genannt wird immer die **Länge** des Empfangenen, nie der Wert: 0 heißt fehlend, eine Zahl heißt
falsch. Verglichen wird per `crypto.timingSafeEqual` auf **Buffern**, nicht auf Zeichenketten —
ein Umlaut im Header hätte sonst einen 500er statt einer sauberen 401 ergeben (Prüfung 1d).

Dazu ein eigener Zähler: 20 Aufrufe je 10 Minuten und Herkunft, mit `Retry-After`.

## Der Wächter — und warum es ihn braucht

Holt der M715q nicht mehr ab (Timer aus, Maschine aus, Token gedreht, Netz weg), ändert sich am
Pi **nichts**. Der Spielbetrieb läuft weiter, `/api/health` meldet `ok`, und die
Off-Site-Sicherung ist trotzdem tot. Derselbe Fingerabdruck wie bei den neun Deploy-Ausfällen,
die alle nur zufällig bemerkt wurden — deshalb dieselbe Antwort:

- **Der Pi merkt sich die Abholung selbst** (`db.offsite`), er lässt sich nicht vom M715q melden.
  Der Vermerk entsteht beim `finish` der Antwort, nicht beim Absenden: Ein abgebrochener Abruf
  darf die Uhr nicht zurücksetzen. Er wird gespeichert und überlebt einen SIGKILL (Prüfung 4d) —
  läge er nur im RAM, wäre er nach jedem Deploy wieder `null` und der Wächter meldete bei jedem
  Neustart einen Ausfall, den es nicht gibt.
- **`/api/health` nennt `offsiteAlterMin`** — ohne Anmeldung lesbar, wie die vier Deploy-Felder.
  `null` heißt „noch nie abgeholt". Weder Dateiname noch Größe noch Abholer stehen dort.
- **Nach 26 Stunden ohne Abholung kommt eine Mail** an `DEPLOY_ALARM_MAIL`, und eine zweite, wenn
  es wieder läuft. Bewusst fail-open wie der Deploy-Alarm: Er ist eine Benachrichtigung, keine
  Sicherung. Ohne `BACKUP_PULL_TOKEN` schweigt er ganz — dann ist nichts eingerichtet, und eine
  Mail wäre reines Rauschen. „Noch nie abgeholt" gilt erst nach 26 Stunden Laufzeit als Befund,
  damit die Einrichtung selbst keinen Fehlalarm auslöst.

## Die Gegenseite

`tools/kepler_offsite_backup.py` im Repo `gamegeeeeek-ai-core`, Cron-Zeilen in
`deploy/kepler-offsite.cron`. Es prüft vor dem Schreiben Prüfsumme, JSON-Form und Kontenzahl,
schreibt über eine `.teil`-Datei mit `os.replace` und hält die neuesten 48 Stände **plus** je
Kalendertag den letzten, 90 Tage lang. `--nur-pruefen` misst das Alter der Datei **dort**, nicht
die Erreichbarkeit des Pi — genau das ist der Unterschied, den ein toter Timer ausmacht.

## Einrichten

1. Token erzeugen (64 Hex-Zeichen): `openssl rand -hex 32`
2. Auf dem Pi: `BACKUP_PULL_TOKEN=<Wert>` in den Portainer-Stack des Backends, Container neu
   erzeugen. **Kein Leerzeichen hinter dem `=`.**
3. Auf dem M715q: derselbe Wert als `BACKUP_PULL_TOKEN` in `~/gamegeeeeek-ai-core/.env`.
4. Erster Lauf von Hand:
   `cd ~/gamegeeeeek-ai-core && .venv/bin/python tools/kepler_offsite_backup.py`
5. Cron-Zeilen aus `deploy/kepler-offsite.cron` übernehmen.
6. Von außen belegen: `curl -s https://gamegeeeeek.de/api/health` — `offsiteAlterMin` ist danach
   eine Zahl statt `null`.

## Test

`tests/test_offsite_backup_http.js` (Port 3249), 30 Prüfungen an einem wirklich laufenden
Server. Gegenprobe gemessen: gegen den Stand davor fallen 29 davon; grün bleibt allein die
Aufbau-Prüfung. Vier Prüfungen waren im ersten Anlauf aus dem falschen Grund grün (wo es die
Route nicht gibt, ist alles 404, und in einer 404 steht kein Datenbankinhalt) — sie verlangen
seither zuerst die benannte Absage mit ihrem Grund.
