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



### Ein Handler an einem Signal deckt den Absturz nicht ab (02.09.2026)

`handleTerminate` flushte die DB bei `SIGTERM`/`SIGINT` und stand seit Monaten unbeanstandet in der
Datei — die Sache sah erledigt aus. **Ein Absturz schickt aber kein Signal.** Bis zum 02.09.2026
gab es keinen Handler für `uncaughtException`, und ein Wurf in irgendeinem der elf Takte beendete
den Prozess damit ohne jeden Flush: bis zu fünf Minuten Spielstand weg, weil genau in diesem Takt
das periodische `saveDb` läuft.

**Die übertragbare Frage: Deckt die Sicherung den Weg ab, auf dem der Schaden wirklich eintritt —
oder nur den, an den man beim Schreiben gedacht hat?** Dieselbe Familie wie die Prüffrage aus dem
AI-Core-Audit („Was passiert, wenn die Konfiguration fehlt?"). Hier lautete die Antwort: Die
Sicherung war da, sie hing nur am falschen Ereignis.

Zwei Punkte, die sich beim Bauen als tragend erwiesen haben:

- **Ein Netz, das nur auffängt, ist schlechter als der laute Absturz, den es ersetzt.** Aus einem
  sichtbaren Ausfall würde ein stiller Dauerschaden. Jeder aufgefangene Fehler wird deshalb
  gezählt und ist in `/api/health` sichtbar — dieselbe Antwort wie bei den neun Deploy-Ausfällen,
  die alle nur zufällig bemerkt wurden.
- **Im Absturz-Handler wird synchron geschrieben und nicht gemailt.** Nach einem
  `uncaughtException` kann ein Promise ausbleiben; und eine Mail erreicht diesen Prozess ohnehin
  nicht mehr. Der Absturz wandert stattdessen IN die Datenbank und wird beim nächsten Start
  verschickt — der Weg über die Platte überlebt den Neustart, ein offener Versand nicht.

Einzelheiten: `docs/betriebsnetz.md`.

## Eine Rechteprüfung altert mit ihrer Begründung (04.09.2026)

`checkVorpostenKeyPermission` ließ das Lesen offen, und der Kommentar begründete das: im Dokument
stehe nichts Schützenswertes. Das stimmte am Tag, an dem es geschrieben wurde. Drei Etappen später
enthielt dasselbe Dokument den Anflug eines Dritten, die Aufschlüsselung fremder Beiträge und die
Kampfvermerke — und die Sperre stand unverändert da, mit ihrer inzwischen falschen Begründung.

**Wer einem geteilten Dokument ein Feld hinzufügt, prüft die Rechteregel dieses Dokuments neu.**
Die Regel ist keine Eigenschaft des Schlüssels, sondern seines Inhalts, und der wächst.

## Eine Sabotage, die nichts trifft, sieht aus wie eine bestandene Gegenprobe (04.09.2026)

An einem Tag dreimal passiert: Eine Gegenprobe ersetzt eine Zeichenkette im Quelltext, die es nach
einer späteren Änderung nicht mehr gibt. `String.replace` meldet keinen Fehler, die Kopie läuft
unverändert, nichts fällt — und die Auswertung meldet „genau die erwarteten Prüfungen sind
gefallen", wenn die Liste zufällig leer ist.

**Jede Sabotage muss belegen, dass sie gegriffen hat** — entweder durch eine Prüfung auf den
veränderten Text (wie `0-kopie` es für die Schalter tut), oder dadurch, dass ihre Pflichtliste
nicht leer ist. Eine leere Erwartungsliste ist nie ein gültiges Ergebnis einer Gegenprobe.

## Eine Benachrichtigung nach `saveDb()` ist eine Benachrichtigung auf Verdacht (04.09.2026)

`/api/musterattack/create` reihte seine Push-Meldungen **nach** `await saveDb()` ein.
`pushNotificationEvent` mutiert `db` — der Flush war zu dem Zeitpunkt aber schon durch, die
Meldungen lagen also nur im Speicher und erreichten die Platte erst, wenn zufällig ein fremder
Schreibvorgang nachkam. Meistens kam einer. Ein Neustart dazwischen verschluckte den Aufruf
lautlos, und der Deploy startet den Prozess bei jedem Push neu.

Der Fehler ist deshalb so zäh, weil er **im Normalbetrieb funktioniert**: Auf einem belebten Server
schreibt binnen Sekunden irgendwer irgendetwas. Er schlägt genau dann zu, wenn am wenigsten los ist
— und dann fehlt eine Meldung, die niemand vermisst, weil niemand weiß, dass sie kommen sollte.

**Die Hausregel „`db` immer synchron vor `saveDb()` mutieren" gilt auch für alles, was nur
nebenbei schreibt.** Wer in einer Route eine Nebenwirkung hinter den Flush hängt — Meldung,
Protokoll, Zähler —, hat sie nicht persistiert, sondern nur gehofft. Gefunden wurde es nicht im
Spiel, sondern weil ein neuer Test den Posteingang **nachgelesen** hat statt nur den Rückgabewert.

## Ein Schalter, der nur die Anzeige einer Wahl gattert, ist kein Schalter (04.09.2026)

`VP_ENDPROJEKTE_AKTIV` stand an zwei Stellen: an der Liste, die dem Client die möglichen Projekte
nennt, und an der Formel, die ihre Wirkung rechnet. Die Stelle dazwischen — der Endpunkt, der die
Wahl **ausführt** — kannte ihn nicht. Ein Client, der den Schlüssel selbst schickt, kam also durch,
obwohl dasselbe Backend ihm diesen Schlüssel nie angeboten hätte.

Die Doku hat den Fehler mitgetragen und dabei verdeckt: Sie sagte, der Schalter gattere „die Wahl"
und „die Wirkung" — beide Male in dem Ton, in dem man eine vollständige Aufzählung schreibt. Die
Wahl war aber die *Anzeige* der Wahl. Wer den Absatz las, hatte keinen Grund nachzusehen.

**Ein Notausschalter gehört an die Stelle, die HANDELT, nicht an die, die anbietet.** Anzeige und
Ausführung sind zwei Stellen, auch wenn sie im Kopf eine sind; nur der Client, der sich an die
Anzeige hält, sieht sie als eine. Und die Prüffrage dazu ist billig: *Was passiert, wenn jemand
genau das schickt, was ich ihm nicht angeboten habe?*

Der Schaden war hier auch nicht auf „ein Vorhaben ohne Wirkung" begrenzt: Weil ein späteres
Umlegen des Schalters die schon vergangene Wartezeit als Fortschritt las, lag beim Einschalten
sofort der volle Deckel an Schiffen bereit. **Ein Zustand, der heute nur nutzlos aussieht, kann
beim Einschalten rückwirkend wertvoll werden.**

## „Backend zuerst live" deckt nur das Hinzufügen ab (04.09.2026)

Die Regel dieses Projekts lautet: Ändert ein Backend-Merge eine spielersichtbare Zahl, geht das
Backend zuerst live, dann das Frontend. Sie ist richtig — aber sie beschreibt nur eine Richtung.

Eine Sammelzeit-Liste wurde von `[30, 60, 120]` auf `[15, 30, 45, 60]` umgestellt. Die neuen Werte
hinzuzufügen ist unproblematisch: Ein altes Frontend schickt sie nicht. Den Wert 120 zu **entfernen**
ist die Gegenrichtung — das live stehende Frontend bot ihn weiterhin an, und der Server hätte ihn
mit 400 abgelehnt. Der Fehler wäre im laufenden Spiel aufgetreten, hätte nur eine von drei Optionen
betroffen und deshalb nach einem Zufallsfehler ausgesehen, nicht nach einer Versionslücke.

**Die akzeptierte Menge eines Servers darf nur wachsen, solange ein älteres Frontend live ist. Nur
die Anzeige darf vorauseilen.** Wer einen Wert wegnimmt, braucht die Vereinigungsmenge für genau
eine Auslieferung — und einen Wächter, der beim Aufräumen bewusst rot wird, damit die Übergangsmenge
als Entscheidung erkennbar bleibt und nicht als Versehen stehen bleibt.

Der eigene Dokumentationstext behauptete zu diesem Punkt ausdrücklich das Gegenteil („kein
Zwischenzustand, in dem ein Client etwas Unmögliches schickt"). Er war beim Schreiben plausibel und
falsch: Geprüft worden war, dass 30 und 60 in *beiden* Listen stehen — nicht, was mit dem dritten
Wert passiert, den nur eine Seite kennt. **Bei einer geänderten Wertemenge zählt der Wert, der
wegfällt, nicht die, die bleiben.**

## Ein Recht, das jeder sich selbst geben kann, wird durch jede neue Fähigkeit teurer (04.09.2026)

Die Allianz-Mitgliedschaft ist in diesem Projekt bewusst offen: `checkAllianceKeyPermission` lässt
jedes Konto `alliance:<TAG>:role:<eigene id>` mit `'member'` schreiben, ohne Einladung. Das war
jahrelang folgenlos, weil daran nichts Wertvolles hing.

Dann bekam die Mitgliedschaft eine neue Fähigkeit — Garnison an einem fremden Vorposten. Damit
konnte ein Fremder den **gemeinsamen** Deckel mit den billigsten Schiffen füllen, und der Besitzer
hatte keinen Weg zurück: Der Rückruf löscht nur die eigenen Schiffe, einen Rauswurf gibt es nicht.
Die Lücke lag nicht in der neuen Fähigkeit und nicht in der alten Regel, sondern in ihrer
Kombination.

**Wer einem bestehenden Recht eine neue Fähigkeit anhängt, prüft die Erwerbsregel dieses Rechts neu —
nicht die Fähigkeit.** Und die Frage dazu ist immer dieselbe: *Was kann jemand anrichten, der sich
dieses Recht in fünf Sekunden selbst gibt, und wie bekommt der Betroffene ihn wieder los?* Fehlt
die zweite Hälfte der Antwort, ist ein Deckel nötig — einer, der nichts löscht, sondern nur das
Wachstum begrenzt.

## Eine Regel, die ein Datum beschreibt, gehört nur dorthin, wo das Datum steht (05.09.2026)

Gemessen an den KI-Kampfberichten: Ein Prompt-Satz („Steht bei `verluste` ‚nicht bekannt', dann sage
nichts über Verluste") stand in den **gemeinsamen** Regeln aller Kampfarten. Bei den Arten, die
dieses Datum gar nicht haben, lieferte er dem Modell die Formulierung für einen Fehler, den er
anderswo verhindern sollte – der Königinnen-Text schrieb „Verluste sind nicht bekannt", obwohl die
Daten die Verluste nannten. **Die Regel war die Ursache, nicht die Abhilfe.**

Übertragbar auf jeden geteilten Anweisungstext, jede geteilte Konstante, jeden gemeinsamen
Hilfstext: Vor dem Einfügen in einen gemeinsamen Block die Frage stellen, ob die Aussage für
**jeden** Fall gilt, der ihn bekommt. Gilt sie nur für einen Teil, gehört sie in dessen eigenen
Abschnitt. Und die Prüfung dazu misst beide Hälften – dass der Satz da ist, wo er hingehört, **und**
dass er dort fehlt, wo er nicht hingehört; die zweite Hälfte ist die, die den Fehler gefunden hätte.
