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

## C3, Backend-Seite (06.09.2026): die Ausgabe ablegen und ausliefern

`POST /api/chronik/ausgabe` ist die **einzige schreibende Route** des Chronik-Bereichs und die
einzige Stelle, an der ein Modelltext in den Bestand kommt. Sie trägt denselben Token und dieselbe
fail-closed-Prüfung wie die Abholung – nur in die andere Richtung.

Gespeichert wird **eine** Ausgabe (`db.galaxy.chronikAusgabe = { woche, text, erstellt, modell }`),
keine Liste: Die Chronik ist eine Wochenzeitung, die Ausgabe der Vorwoche ist Archiv. Eine Liste
wäre ein zweiter Deckel, den jemand pflegen müsste.

**Drei Zurückweisungen, drei Meldungen** (Lektion 7 – „ungültig ODER fehlend" ist im Fehlerfall
keine Diagnose): Der Token beantwortet *wer*, die Wochenkennung (`2026-KW36`) *wofür*, der Text
*was*. Genannt wird immer die Länge des Empfangenen, nie der Wert.

**Zu lang wird abgelehnt, nicht gekürzt.** Der Absender ist eine unbeaufsichtigte Cron-Zeile, die
von einem stillen Schnitt nie erfährt; der Fehler nennt beide Zahlen. (Der erste Entwurf hängte
stattdessen ein zweites `express.json({limit:'32kb'})` davor – wirkungslos, weil der globale Parser
den Body längst geparst hat und `express.json` einen bereits geparsten überspringt. Ein Limit, das
nur wie eines aussieht, ist keines.)

**Der Text ist ein Modelltext, den jeder Spieler sieht.** Der Token beweist, dass der M715q ihn
geschickt hat, nicht dass er harmlos ist: `chronikAusgabeText` lässt nur Zeichen durch, die in
deutscher Prosa vorkommen – spitze Klammern insbesondere nicht. Die Sicherheit hängt damit nicht an
der Anzeigestelle im Frontend.

### Der Befund beim Bauen: das Buch ging an jeden Client

`db.galaxy` reicht seinen ganzen Inhalt ungefragt an jeden Client weiter – der Kommentar an
`db.notAus` sagt das ausdrücklich – und C1 hatte das Ereignisbuch genau dort abgelegt. Damit gingen
bis zu **500 Roheinträge bei jedem `/api/galaxy`** mit, das der Client alle zwei Minuten holt.
Gemessen an Einträgen in der Form, die `chronikVermerken` schreibt: **81,7 KB je Abruf, rund 2,4 MB
je Spieler und Stunde** – für Daten, die kein Client benutzt, auf einem Raspberry Pi.

`chronikAusClient()` nimmt das Buch heraus und reicht nur die fertige Ausgabe durch. Beides an
derselben Stelle, damit es nicht auseinanderlaufen kann; wer künftig etwas in `db.galaxy` legt, das
nicht an alle darf, gehört dorthin. Das Buch ist die Arbeitsgrundlage des M715q, der Spieler
bekommt die Zeitung, nicht die Zutaten.

### Schalter

`CHRONIK_AKTIV` steht auf `false` und wird im **Frontend-PR** umgelegt (Auslieferungsreihenfolge).
Dazu der zehnte Notaus-Schalter `chronik`: Steht er aus, bleibt die abgelegte Ausgabe liegen und
wird nur nicht mehr ausgeliefert – der Rückwärtsgang für einen Text, der sich als unpassend
herausstellt, ohne Release und ohne dass der M715q davon wissen muss.

`/api/health` → `chronik` nennt jetzt zusätzlich `ausgabe` (Woche, Zeitpunkt, Zeichenzahl) und
`aktiv`. Die Antwort der Schreibroute enthält `aktiv` ebenfalls – sonst könnte der M715q nicht
unterscheiden, ob sein Text nur abgelegt oder auch sichtbar ist.

### Wächter für C3

`tests/test_chronik_http.js` Abschnitte 7–9 (12 Prüfungen): jede Zurückweisung einzeln, Säuberung,
Ablage; das Buch erreicht den Client **nicht**, die Ausgabe nur bei umgelegtem Schalter (Abschnitt 9
fährt dafür eine Kopie von `server.js` im Repo-Verzeichnis). Gegenproben gemessen:

| Sabotage | fällt |
|---|---|
| Buch geht wieder an den Client | 8a, 8b, 9b |
| Säuberung entfällt | 7g |
| zu langer Text wird gekürzt statt abgelehnt | 7d (und 7e als Folge) |
| Schalter wird beim Ausliefern ignoriert | 8b |

## Was folgt

**C3 (M715q):** Cron ruft `kepler_chronik.py` wöchentlich auf und schickt den Text an
`POST /api/chronik/ausgabe` sowie als Entwurf an Social Hub.
**C3 (Spiel):** Weltlage-Panel zeigt `chronikAusgabe`, ohne Ausgabe kein leerer Rahmen – und der
Frontend-PR legt `CHRONIK_AKTIV` um.
