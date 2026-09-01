# Projektgedächtnis: übertragbare Lehren (Wortlaut der Vorfälle)

Verschoben aus `CLAUDE.md` am 01.09.2026 (Strukturprüfung, Punkt 1: Startkontext verkleinern). Wortlaut unverändert; Querverweise wie „unten" oder „oben" beziehen sich auf die frühere Reihenfolge in `CLAUDE.md`. Neue Erkenntnisse zu diesem Bereich gehören ab jetzt hierher, nicht in `CLAUDE.md`.

### Die temporale Todeszone: `node --check` sieht sie NICHT (18.08.2026)

`galaxyTick()` wurde bei Zeile 5526 einmal **mitten in der Modulauswertung** aufgerufen, damit nach
einem Neustart nicht 15 Minuten auf den ersten Galaxie-Zustand gewartet werden muss. Der Rumpf
dieser Funktion sieht damit jede `const`, die weiter unten in der Datei steht, in ihrer temporalen
Todeszone. Beim Einbau von `FESTUNG_SPAWN_CHANCE` (Zeile 7908) war die Folge:

```
ReferenceError: Cannot access 'FESTUNG_SPAWN_CHANCE' before initialization
    at galaxyTick (server.js:5364:23)
    at Object.<anonymous> (server.js:5526:1)
```

Bei **jedem** Start, nicht nur in 8 % der Fälle – der rechte Operand eines `<` wird immer
ausgewertet. `node --check` war grün.

**Behoben strukturell, nicht punktuell:** Der Startlauf liegt jetzt in `setImmediate(galaxyTick)`.
Er feuert, sobald die Modulauswertung fertig ist – also Millisekunden später, die Absicht bleibt
vollständig erhalten, und die ganze Fehlerklasse ist für **jede künftige Konstante** miterledigt.
Vorher nachgesehen: Nach dieser Zeile stehen nur noch Funktions-, Konstanten- und
Routendefinitionen, nichts, was den Takt vorher gelaufen sehen müsste.

Das ist dieselbe Familie wie Arbeitsregel 38 der Frontend-CLAUDE.md (dort für Array-Literale wie
`CREDIT_SHOP`/`HELP_SECTIONS`, die beim Laden ausgewertet werden). **Die übertragbare Regel: Ein
Syntax-Check ist kein Startversuch.** Wer eine Konstante einführt und irgendwo oben in der Datei
benutzt, muss den Server einmal wirklich hochfahren – `tests/test_serverstart.js` tut genau das.

**Vorhandene Tests liegen unter `tests/`** und werden von Hand gestartet (`npm install` vorher, danach `node_modules` wieder löschen): `bash tests/chatpush.sh` prüft die Chat-Push-Kette Ende zu Ende gegen einen echten, lokal gestarteten Server. Sie sind bewusst **im Repo** und nicht im Sitzungs-Scratchpad – dort wären sie mit dem Container weg, und genau so stand das Frontend bis zum 25.07.2026 ohne einen einzigen Test da. Ein neuer Backend-Test gehört ebenfalls hierher.

Zwei Fallen, die beim Schreiben von `tests/chatpush.sh` je einen Anlauf gekostet haben und die jeder neue Test vermeiden sollte: Ein Schreibvorgang landet nur mit **`?shared=true`** im geteilten Speicher (ohne den Parameter schreibt dieselbe Route in den privaten Bereich, `handleSharedStorageWrite` läuft dann gar nicht erst) – und **JSON-in-JSON nicht von Hand in der Shell zusammenbauen**, sondern die Nutzlast mit `node -e` erzeugen und per `--data-binary @-` übergeben; vier Ebenen Anführungszeichen erzeugen sonst genau die Fehler, die man dem Server anlastet.


### Container-Lehre derselben Session (ephemere Umgebung)

Der Remote-Container wurde MITTEN in der Etappe recycelt – alle unkommittierten server.js-Edits
waren weg und mussten aus dem Sitzungskontext neu angewandt werden (der Backend-Klon fiel dabei
still auf einen acht Tage alten Schnappschuss zurück). **Ein fertiger Änderungssatz wird SOFORT
committet und gepusht**, auch wenn Tests/Doku noch ausstehen – ein zweiter Commit ist billig, ein
verlorener Änderungssatz nicht. Und nach jeder längeren Pause: `git log --oneline -1` gegen die

