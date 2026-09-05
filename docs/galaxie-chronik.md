# Galaxie-Chronik – Etappe C1: das Ereignisbuch (05.09.2026)

Konzept: `gamegeeeeek-ai-core/docs/AI-HUB-ROADMAP.md`, Superprojekt 3 – **ein** Zeitungstext je
Woche aus dem, was in der Galaxie wirklich passiert ist, geschrieben vom M715q, im Spiel (Weltlage)
und als Entwurf in Social Hub. C1 ist die Vorbedingung dafür: Bis hierher **kannte** der Server die
Ereignisse (er verschickt `weltboss-kill`, hält Festungen, Nester, Allianzen), führte aber kein
Buch – `pushGalaxyNews` ist eine Laufschrift aus fertigen Sätzen, 40 Einträge, Reichweite Tage.

## Was das Buch ist

`db.galaxy.chronik` – **in `db.galaxy`, nicht in `db.shared`**, wie die Roadmap zuerst schrieb:
Die Hausregel legt server-eigene Daten nach `db.galaxy`, für Clients unerreichbar. Je Eintrag
`id`, `zeit`, `art` und die **festen Felder der Art** (`CHRONIK_ARTEN` nennt sie, die Routen
liefern die Liste mit). Nie Freitext: Jede Zeichenkette läuft durch `chronikText`, dieselbe
40-Zeichen-Whitelist wie der Gegnername der Kampftexte – Spieler-, Allianz- und Volksnamen sind
die einzigen client-stämmigen Werte, und der M715q baut daraus später einen Prompt.

**Geschrieben wird nur aus Server-Code** (`chronikVermerken`), an den Ereignisstellen, meist direkt
neben dem `pushGalaxyNews`, das dieselben Werte im Satz trägt: Weltboss-Fall (mit größtem Beitrag
und Anteil, unabhängig von den Push-Einstellungen), Festungs-Fall, Königinnen- und Nest-Fall,
Vorposten-Fall (Einzel und Verband), Hort-Fund, Eroberung eines NPC-Systems, Allianz-Gründung
(ein **neuer** `alliance:<tag>:info`-Schlüssel im Speicher-Hook), Allianzkrieg-Ende, Kopfgeld,
Saison-Ende, Front-Durchbruch der Randkriege. Ein `PUT /api/storage/chronik?shared=true` landet im
generischen Speicher und berührt das Buch nicht.

## Der Deckel

500 Einträge – **und er löscht nie, was die laufende Woche braucht:** Gekürzt werden nur Einträge
älter als acht Tage (Woche plus Puffer für den Abhol-Takt). 600 junge Einträge bleiben alle stehen,
auch über 500 hinaus (Wächter 5c). Hausregel: Deckel begrenzen das Wachstum, sie löschen keine
Daten, die noch gebraucht werden.

## Die zwei Routen

- `GET /api/admin/chronik?tage=7` – für Sascha im Browser (Admin-Konto).
- `GET /api/chronik/abholen?tage=7` – für den M715q, **derselbe Abhol-Weg wie die Off-Site-Sicherung**
  (`BACKUP_PULL_TOKEN`, `offsiteTokenPruefen`, Rate-Limit): Der M715q fragt, der Pi bekommt keinen
  Zugang dorthin. Fail-closed: Ohne Token gibt es die Route nicht (503). Antwort in beiden Fällen
  `{ tage, anzahl, gesamt, arten, eintraege }`; `tage` ist auf 1–60 geklammert.

`/api/health` → `chronik` nennt `eintraege`, `woche` (letzte sieben Tage) und `letzterEintrag` –
daran sieht man ohne Anmeldung, ob das Buch lebt.

## Wächter

`tests/test_chronik_http.js` (Port 3262): Weltboss-Fall → genau ein Eintrag mit festen Feldern;
Client schreibt nicht ins Buch; Admin-Route nur für den Admin; Allianz-Gründung mit Whitelist und
ohne Doppel-Eintrag; Abhol-Route 401/401-mit-Länge/200 und `tage`-Filter; Deckel kürzt nur Altes,
nie Junges; 503 ohne Token. Gegenprobe im Dateikopf.

## Was folgt

**C2 (M715q):** Cron holt die Wochenfakten über `/api/chronik/abholen`, baut Datenblock und
Zeitungstext (Sperre wie bei den Kampftexten: Zahlen und Namen nur aus den Fakten), liefert den
Text als Entwurf an Social Hub und als Weltlage-Text an dieses Backend – hinter `CHRONIK_AKTIV`.
**C3 (Spiel):** Weltlage-Panel zeigt die aktuelle Ausgabe, ohne Ausgabe kein leerer Rahmen.
