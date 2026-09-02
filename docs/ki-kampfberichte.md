# KI-Kampfberichte (Backend)

Konzept und Etappenplan: `kolonie-kepler7/docs/ki-kampfberichte-konzept.md`.
Das Messwerkzeug, mit dem der Prompt am echten Modell kalibriert wurde:
`gamegeeeeek-ai-core/tools/kampftext_messlauf.py`.

## Etappe E1a (28.08.2026)

Konzept: `kolonie-kepler7/docs/ki-kampfberichte-konzept.md`. Der Client schickt die Kampf-FELDER,
dieser Server baut daraus einen Prompt, lässt AI Core auf dem M715q einen Erzähltext schreiben,
prüft ihn und legt ihn zum Abholen bereit. Zwei Endpunkte: `POST /api/kampfbericht/text`
(202 + `auftragId`) und `GET /api/kampfbericht/text/:id`.

**`KAMPFTEXT_AKTIV` steht auf `false`** – Auslieferungsschutz wie `FESTUNG_SPAWN_AKTIV`. Ohne das
Frontend ruft niemand den Endpunkt auf, aber er würde M715q-Zeit verbrauchen, sobald ihn jemand
findet, und der M715q bedient auch Social Hub. Umgelegt wird im Frontend-PR der Etappe E1b.

### Drei Dinge, die auf dem Pi gesetzt sein müssen (Container neu erzeugen)

```
AI_CORE_URL=http://192.168.178.45:8000
AI_CORE_API_KEY=<derselbe Wert wie API_KEY in AI Cores .env>
```

Eine Env-Änderung verlangt ein Neuerzeugen des Containers – der Webhook-Pull reicht dafür nicht.
**Das lässt sich mit `DEPLOY_ALARM_MAIL` bündeln**, das aus demselben Grund seit dem 22.08.2026
aussteht. Und **ob der Pi den M715q überhaupt erreicht, ist bis heute nicht gemessen** – der
Endpunkt meldet einen Fehlversuch benannt (`fehlgeschlagen` mit Grund), aber die erste Messung
gehört vor das Umlegen des Schalters.

### Sieben Entscheidungen, die man kennen muss

1. **Kein neues Paket.** Der Aufruf läuft über den Kern (`http`/`https`). Zwei Gründe, beide
   dokumentiert: Eine Änderung an `package.json` verlangt auf dem Pi ein `docker restart` von
   Hand (nodemon installiert nichts nach) – das darf ein Feature hinter einem ausgeschalteten
   Schalter nicht erzwingen. Und globales `fetch` gibt es erst ab Node 18; welche Node-Version im
   Container läuft, ist von außen nicht messbar.
2. **Der Prompt entsteht ausschließlich hier** aus einer festen Schablone. Der Client schickt
   Felder, niemals Text und niemals einen Prompt – sonst wäre der Endpunkt ein freier LLM-Zugang
   für jeden mit einem Konto.
3. **Der Gegnername ist die einzige vom Client kontrollierte Zeichenkette** im Prompt. 40 Zeichen,
   Zeichen-Whitelist ohne Steuerzeichen, Klammern und Anführungszeichen: Damit lässt sich weder
   die JSON-Struktur fälschen noch eine zweite Anweisungssektion vortäuschen. Dass darin trotzdem
   40 Zeichen Prosa Platz haben, ist **bekannt und bewusst in Kauf genommen** – bei 10 Texten je
   Konto und Tag ist das als LLM-Zugang unbrauchbar, und den Text sieht ohnehin nur der Spieler,
   der ihn ausgelöst hat.
4. **Schiffe reisen als SCHLÜSSEL**, nicht als Namen; der Server übersetzt über
   `KAMPFTEXT_SCHIFFSNAMEN`, ein unbekannter Schlüssel fällt weg. Damit erreicht außer dem
   Gegnernamen keine einzige Client-Zeichenkette den Prompt.
5. **Die Warteschlange lebt nur im Speicher** und ist nach einem Neustart weg. Absicht: Ein Auftrag
   ist Sekunden bis Minuten alt, der Client hört bei unbekannter ID auf zu fragen. `GET` meldet
   einen Auftrag, der die Zeit überschritten hat und trotzdem noch wartet, als gescheitert – statt
   ihn ewig hängen zu lassen.
6. **EIN Auftrag gleichzeitig Richtung M715q.** AI Cores Drossel zählt je Herkunft (20 Aufrufe je
   5 Minuten, 2 gleichzeitig), und aus seiner Sicht ist dieser Pi EINE Herkunft – alle Spieler
   teilen sich das Budget. Deshalb liegt die Warteschlange hier und nicht je Client.
7. **Kein zweiter Versuch bei einem verworfenen Text.** Ein Retry kostet weitere ~70 s M715q für
   denselben Text, und ein fehlender Text ist per Konzept kein Fehler – die Sektion bleibt weg.

### Die Sperren sind eine KOPIE-FAMILIE über drei Repos

Prompt, Zuschnitt und die drei Sperren liegen hier **und** in
`gamegeeeeek-ai-core/tools/kampftext_messlauf.py`; die Schiffsnamen zusätzlich in `SHIP_DEFS` der
Spieldatei. Dort sind sie am echten Modell **gemessen** worden (E0, 28.08.2026: acht von acht
Texten trugen eine Falschaussage), hier **entscheiden** sie. Laufen sie auseinander, misst das
Werkzeug etwas anderes, als der Server durchlässt. Wächter:
`kolonie-kepler7/tests/test_kampftext_paritaet.js` (12 Prüfungen, fünf Gegenproben).

**Der wichtigste Einzelpunkt daraus:** Die Zahlen-Sperre vergleicht gegen den **Datenblock**, nicht
gegen den ganzen Prompt. Gegen den ganzen Prompt wären drei Zahlen erlaubt statt einer – die 500
aus „höchstens 500 Zeichen" und die 7 aus „Kolonie Kepler-7"; ein Text mit „500 Jäger fielen in
7 Wellen" käme sauber durch. `test_kampftext_http.js` 6g hält genau das fest.

### Der Test misst gegen einen GEFÄLSCHTEN AI Core

`tests/test_kampftext_http.js` (Port 3240 für den Server, 3241 für den Fake; 57 Prüfungen, **acht
Gegenproben**, alle beidseitig gefahren bei 57 gelaufenen Prüfungen in jeder Richtung). Der echte
AI Core läuft auf dem M715q, ist von hier nicht erreichbar und bräuchte je Text 70 Sekunden – der
Fake schreibt stattdessen **jeden Prompt mit**, und genau das ist der Gegenstand der halben Datei:
*Was* das Modell zu sehen bekommt, entscheidet mehr als jede nachgelagerte Sperre.

Er startet **zwei** Serverstände: die echte `server.js` (Schalter aus, Abschnitt 1) und eine Kopie
mit umgelegtem Schalter. Anders ginge es nicht – mit ausgeschaltetem Schalter hätte der Rest keinen
Gegenstand, und welche Stellung gerade committet ist, darf das Ergebnis nicht verschieben.

**Zu den Testports:** Gemessen sind 3195–3238 belegt (`grep -hoE "3[0-9]{3}" tests/*.js | sort -un`),
dieser Test nimmt 3240 und 3241. Die **drei** Portlisten weiter oben in dieser Datei sind über die
Zeit auseinandergelaufen und nennen alle drei zu kleine Zahlen – wer einen Test anlegt, misst
selbst, statt eine davon zu glauben. Genau die Fehlerklasse, gegen die Frontend-Regel 72
geschrieben ist: eine Aufzählung neben der Liste wird still falsch.

**Zwei Funde am eigenen Test, beide nur von der „was muss fallen"-Liste gemeldet** (Regel 71):

- **Die Fixture trug die riskanten Felder gar nicht.** Prüfung 3b („keine der E0-Größen steht im
  Prompt") suchte nach etwas, das die Fixture nicht enthielt, und blieb selbst dann grün, als der
  Zuschnitt in der Gegenprobe entfernt wurde. Sie ist jetzt ein **vollständiger** npc-attack-
  Bericht – so, wie ein echter Client ihn schickt.
- **Eine Prüfung konnte per Konstruktion nicht fallen.** „Der Datenblock ist gültiges JSON" ist
  immer wahr, solange `JSON.stringify` ihn baut – der escapet die Anführungszeichen selbst. Sie
  heißt jetzt `4-vorab2` und ist als Vorbedingung benannt, nicht als Zusage; die Zusage über den
  Namen ist `4b`.

**Und eine dritte Lehre zur Fixture:** Der erste Entwurf benutzte für alle Abschnitte dasselbe
Konto – bei einem Tagesdeckel von 10 verbrauchten sie ihn gegenseitig, und vier Prüfungen maßen
danach den Deckel statt ihres eigenen Gegenstands. Es gibt jetzt vier Konten.
