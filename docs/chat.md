# Chat: Bündel-Abruf und Retention

Verschoben aus `CLAUDE.md` am 01.09.2026 (Strukturprüfung, Punkt 1: Startkontext verkleinern). Wortlaut unverändert; Querverweise wie „unten" oder „oben" beziehen sich auf die frühere Reihenfolge in `CLAUDE.md`. Neue Erkenntnisse zu diesem Bereich gehören ab jetzt hierher, nicht in `CLAUDE.md`.

## Chat-Großetappe A: der Bündel-Abruf (28.08.2026)

Auftrag Sascha („müssen auch noch mal was am Chat machen… mach mal wir Ideen dazu", danach über
`AskUserQuestion` gewählt: **„Großetappe: alles"** — Bündel-Abruf, dann Live-Aktualisierung im
Frontend, dann Historie/Komfort). Dieses Repo liefert die Etappen A und die Backend-Hälfte von C;
die Frontend-Hälften stehen in der Frontend-CLAUDE.md, sobald sie gebaut sind.

**Der Anlass ist gemessen:** Das Frontend las einen Chat-Kanal in ~1+50 Anfragen (`storage-list`
für die Schlüssel, dann `storageGet` je Nachricht) — gegen das globale Rate-Limit von 240/min je
Verbindung. Ein Panel-Öffnen mit beiden Kanälen verbrauchte davon rund 100, und ein offenes Panel
aktualisierte sich trotzdem NIE von selbst (kein Poll — er wäre mit dem alten Lesemuster gar nicht
bezahlbar gewesen). Genau deshalb ist der Bündel-Abruf die VORAUSSETZUNG der Live-Aktualisierung,
nicht eine Komfort-Route daneben.

### `GET /api/chat/:kanal` — vier Entscheidungen, die man kennen muss

- **Die Leserechte sind exakt die des alten Wegs: `authMiddleware`, mehr nicht.** Das Lesen von
  Chat-Schlüsseln war im generischen Storage schon immer für jedes angemeldete Konto offen
  (`checkChatKeyPermission` prüft nur das SCHREIBEN, `authorId === req.userId`). Die Route öffnet
  also nichts, sie bündelt. Prüfung 3c hält das als bewusste Haltung fest — ein Nicht-Mitglied
  darf den Allianz-Kanal lesen, wie beim alten Weg auch. **Wer das je ändern will, ändert BEIDE
  Wege**, sonst ist die Sperre eine Attrappe neben einer offenen Tür.
- **Der Allianz-Tag wird nur FORMAL geprüft** (kein Doppelpunkt, Länge ≤ 16): Er landet als Präfix
  in einer In-Memory-Suche über `Object.keys`, nie in einem Pfad oder Befehl — ein erfundener Tag
  liefert schlicht eine leere Liste, genau wie beim alten `storage-list`-Weg. Der Doppelpunkt ist
  trotzdem verboten, weil er die Schlüssel-Grammatik sprengt (`alliance:A:B:msg:` läse einen
  fremden Namensraum an).
- **Sortiert wird über `chatKeyTimestamp`** (numerisch nach dem Zeitstempel im Schlüssel, wie
  `pruneChatKeys`) — eine String-Sortierung wäre bei zehnstelligen gegen dreizehnstellige
  Zeitstempel falsch. Der Test hält das mit einem Prüfstein fest, den nur die numerische
  Sortierung besteht: ein Schlüssel `…:msg:9999999999-alt` (April 1970!) zwischen dreizehnstelligen
  — lexikografisch die „neueste", numerisch die älteste Nachricht.
- **Der limit-Deckel hängt an `CHAT_KEEP_PER_CHANNEL`**, nicht an einer eigenen zweiten Zahl —
  mehr als die Aufbewahrung hält, kann es nicht geben, und zwei Obergrenzen nebeneinander liefen
  beim nächsten Umbau auseinander. Vorgabe ohne Parameter: 50 (die bisherige Lesetiefe des
  Frontends). `neuesteTs` in der Antwort erlaubt dem künftigen Poll die billige Frage „gibt es
  Neues?", ohne die Nachrichtenliste selbst zu vergleichen.

### Retention 300 statt 100 (die Backend-Hälfte von Etappe C)

`CHAT_KEEP_PER_CHANNEL` steht seit dieser Etappe auf **300**. Das alte Größenargument („jede
Abfrage überträgt alles mit — je Schlüssel eine Anfrage") gilt mit dem Bündel-Abruf nicht mehr:
Das Panel kann über „Ältere anzeigen" bis zur vollen Tiefe lesen, in EINER Antwort. Der Kommentar
an der Konstante sagt ausdrücklich, dass die Obergrenze des Bündel-Abrufs an DERSELBEN Konstante
hängt — wer sie ändert, ändert beides zugleich.

### Der Wächter: `tests/test_chat_buendel_http.js` (Port 3233, 19 Prüfungen, drei Gegenproben)

**Belegte Testports sind jetzt 3195–3233** — ein neuer Test nimmt 3234.

Die Fixture ist so KONSTRUIERT, dass jede Erwartung aus ihr folgt statt aus einer Momentaufnahme
(Frontend-Regel 2): 309 globale Nachrichten (g0…g308, Zeitbasis fest, Abstand 10 ms) plus ein
kaputter Nicht-JSON-Eintrag zwischen g250 und g251 — zusammen 310 Schlüssel, also 10 über der
Aufbewahrung. Der `galaxyTick` beim Serverstart (`setImmediate`) ruft `pruneChatKeys` und muss auf
300 schneiden: g0…g9 weg, g10 die älteste verbleibende (Abschnitt 5). 5c misst dieselbe Wahrheit
über den ALTEN Weg (`storage-list` zählt 300 = 299 gültige + der kaputte), damit Bündel-Abruf und
Altweg keine zwei Welten zeigen können.

Drei Gegenproben, alle beidseitig gefahren, identische Prüflisten per `diff` (Frontend-Regel 60),
jede mit gemessener „was muss fallen"-Liste (Regel 71) im Test-Kopf:

| Gegenprobe (via `CHAT_TEST_SERVER`, Kopie im Repo-Verzeichnis wegen `require('./mailer')`) | fällt |
|---|---|
| alter Stand (`origin/master` vor der Etappe) | **18 von 19** — nur `0-vorab` bleibt |
| `keys.sort()` ohne Komparator in der Route | genau `3a` + `3b` (Beleg: `neuesteTs 9999999999`) |
| limit-Absicherung entfernt | genau `1a`, `1b`, `2b` (`parseInt(undefined)` → NaN → `slice(-NaN)` liefert ALLES) |

**Zwei Vorhersagen der Pflichtlisten waren zu eng und sind an der Messung korrigiert worden**
(dieselbe Lehre wie bei `test_urmaterie_boden_http`): Die Sortier-Sabotage reißt auch `3b`
(`neuesteTs` liest den LETZTEN Schlüssel der sortierten Liste), und die limit-Sabotage reißt auch
`1a`/`1b` (der Vorgabe-Pfad OHNE Parameter läuft durch dieselbe entfernte Zeile). Eine
Pflichtliste ist selbst eine Behauptung, bis die Gegenprobe sie gemessen hat.

### Auslieferungsreihenfolge: dieses Repo zuerst, und sie ist ungefährlich

Das Backend allein live stellt eine Route bereit, die noch niemand aufruft — folgenlos. Das
Frontend der Etappe B baut einen **Rückfall auf den alten Weg** ein (bei 404/nicht-ok antwortet
ein alter Server, und das Panel liest wie bisher je Schlüssel) — „der Server darf hinterherhinken,
das Frontend nicht". Ein Schalter ist deshalb nicht nötig. Die Retention 300 allein ist ebenfalls
harmlos: Der alte Client liest ohnehin nur die neuesten 50.


