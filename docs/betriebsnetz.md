# Das Betriebsnetz: gescheiterte Takte und Abstürze

Angelegt am 02.09.2026 (Strukturprüfung, Punkt C2).

## Der Befund

```
$ grep -n "process.on(" server.js
5727:process.on('SIGTERM', () => handleTerminate('SIGTERM'));
5728:process.on('SIGINT', () => handleTerminate('SIGINT'));
```

Zwei Zeilen, beide an einem **Signal**. Kein Handler für `uncaughtException`, keiner für
`unhandledRejection`. Daraus folgten zwei Dinge:

1. **Ein Wurf in irgendeinem der elf Takte beendete den ganzen Server.** `galaxyTick`,
   `pruefeLoeschungen`, der Erinnerungs-Sweep jede Minute, das periodische `saveDb` — jeder von
   ihnen konnte den Prozess mitnehmen.
2. **Und zwar ohne Flush.** Die Graceful-Shutdown-Handler helfen dabei nicht: Ein Absturz schickt
   kein Signal. Verloren waren damit bis zu **fünf Minuten** nur im RAM gehaltener Stand — genau
   der Takt, in dem `saveDb` periodisch läuft.

Die Takte, die schon ein `try/catch` hatten, waren nicht besser dran, nur leiser: Sie schrieben
ihren Fehler ins Containerlog, und das liest niemand. Genau daran sind die neun Deploy-Ausfälle
vom August lange unbemerkt geblieben.

## Zwei Mechanismen, und sie tun Verschiedenes

### `takt(name, fn)`

Umschließt jede Takt-Registrierung. Fängt den Wurf **und** die abgelehnte Zusage (ein
`async`-Takt wirft nicht, er lehnt ab — ohne `.catch` wäre das eine unbehandelte Zusage und
beendete den Prozess). Der nächste Durchlauf läuft wieder; ein kaputter Takt legt den Rest nicht
still.

Eingepackt sind: `rateLimit-aufraeumen`, `backupDb`, `saveDb`, `ueberfall-erinnerungen`,
`checkCompletionReminders`, `checkDormantWinback`, `galaxyTick` (Intervall **und** Startlauf),
`offsiteWaechter`, `pruefeLoeschungen` (Intervall und Startlauf).

**Ein Netz, das nur auffängt, wäre schlechter als der laute Absturz, den es ersetzt** — aus einem
sichtbaren Ausfall würde ein stiller Dauerschaden. Deshalb wird jeder Fehler gezählt, ist von
außen sichtbar und meldet sich:

| Wo | Was |
|---|---|
| `GET /api/health` | `taktFehler` — Summe der gescheiterten Durchläufe seit dem Start |
| `GET /api/admin/systemstand` | `laufzeit.taktFehlerJeTakt`, `laufzeit.taktFehlerLetzte` (die letzten fünf mit Name, Zeit, Meldung) |
| Mail an `DEPLOY_ALARM_MAIL` | einmal je **Takt und Stunde** (`betriebsMail`) |

Die Takte mit eigenem `try/catch` melden über denselben Weg (`taktFehlerVermerken`), statt nur ins
Log zu schreiben.

### `uncaughtException` → schreiben, dann beenden

Ein Wurf außerhalb eines Takts wird **nicht** aufgefangen und weitergemacht: Nach einem
`uncaughtException` ist der Zustand nicht mehr belastbar, und ausgerechnet dieser Server schreibt
fremde Spielstände. Stattdessen:

1. `db.absturz` setzen (Zeit, Herkunft, die ersten vier Stackzeilen),
2. **synchron** flushen — `fs.writeFileSync` auf eine eigene Zwischendatei `db.json.notfall`,
   dann `renameSync`. Nicht über `saveDb()`: Nach einem `uncaughtException` ist die
   Ereignisschleife nicht mehr belastbar, ein Promise kann ausbleiben. Eine **eigene**
   Zwischendatei, damit sie nicht mit einem laufenden asynchronen Schreibvorgang um dieselbe
   `.tmp` streitet.
3. `process.exit(1)`. Docker startet in rund 7 Sekunden neu.

**Gemeldet wird nicht von hier aus.** Eine Mail ist asynchron und erreicht diesen Prozess nicht
mehr. Der Absturz steht in der Datenbank und wird beim **nächsten Start** verschickt (ein
`setImmediate`, das `db.absturz.gemeldet` prüft) — der Weg über die Platte überlebt den Neustart,
ein offener Mailversand nicht.

### `unhandledRejection` → melden, weiterlaufen

Bewusst anders als der Wurf. Node beendet den Prozess seit v15 von sich aus; für diesen Server ist
das die schlechtere Wahl. Die unbehandelten Zusagen, die es hier realistisch gibt, kommen aus dem
Mail- und Push-Versand (fire and forget) — das ganze Spiel anzuhalten, weil Resend nicht antwortet,
wäre genau die Sorte Sicherung, die mehr kaputt macht als sie schützt.

Verschluckt wird sie trotzdem nicht: Sie läuft durch denselben Melder wie ein gescheiterter Takt,
unter dem Namen `unbehandelte-zusage`.

## Test

`tests/test_betriebsnetz_http.js` (Port 3250), 15 Prüfungen an wirklich laufenden Servern. Der
Fehler wird über **Kopien von `server.js` im Repo-Verzeichnis** eingebaut (`require('./mailer')`
löst nur dort auf); die Kopien heißen `server_gegenprobe_*.js` und werden am Ende entfernt.

Die Kernmessungen:

- **1c** — die Fehlerzahl **steigt** über zwei Abfragen hinweg: Der Takt läuft weiter, er ist
  nicht bloß einmal durchgerutscht.
- **2b** — eine Änderung, die nur im RAM stand, liegt nach dem Absturz auf der Platte. Genau das
  ging vorher verloren.
- **3a** — ohne Fehler meldet nichts einen Fehler. Sonst belegte Abschnitt 1 nur, dass der Zähler
  immer zählt.

Gegenproben, beide gemessen: gegen `origin/master` fallen **13 der 15**; grün bleiben nur
„2-vorab" (Aufbau-Prüfung) und 3b (Verhalten, das vorher schon richtig war). Und als Sabotage des
neuen Standes — `takt()` ohne sein `try/catch` — fallen genau 1a bis 1g. Die erste Probe belegt,
dass sich etwas geändert hat; die zweite, dass es der Fänger ist.

**Die Notbremse steckt in der Messvorrichtung**, nicht nur im Prüfling: Ist der Server tot — der
Fall, den dieser Test misst —, wirft jedes `fetch`. Ohne den Fänger in `j()` brach der Lauf gegen
den alten Stand nach drei von fünfzehn Prüfungen ab, statt rot zu werden.
