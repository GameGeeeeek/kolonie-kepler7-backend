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

**Nachtrag 04.09.2026: `KAMPFTEXT_AKTIV` steht seit E1b auf `true`.** Umgelegt, nachdem die
Selbstprüfung den Weg Pi → M715q und den Schlüssel belegt hatte (Abschnitt „Die Selbstprüfung" unten).
Der Rückwärtsgang zur Laufzeit ist der Notaus `kampftext` (Abschnitt „Etappe E1b" am Ende).

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
**Nachtrag 04.09.2026: Diese Messung macht der Server jetzt selbst** – `/api/health` → `kampftext`,
siehe den Abschnitt „Die Selbstprüfung" am Ende dieser Datei. Am Pi bleibt nur das Setzen der zwei
Werte im Portainer-Stack.

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

## Die Selbstprüfung (04.09.2026)

Anlass: Die drei Vorbedingungen der Etappe E1b standen als drei SSH-Befehle für Sascha in der
Roadmap (Schlüssellänge zählen, Erreichbarkeit **aus dem Container heraus** messen). Der Server kann
beides selbst – und tut es seither beim Start und alle zehn Minuten, unabhängig von
`KAMPFTEXT_AKTIV`: Gemessen wird, **bevor** der Schalter umgelegt wird. Das Ergebnis steht in
`GET /api/health` unter `kampftext`, von außen ohne Anmeldung lesbar (dasselbe Prinzip wie
`commit`/`checkout`/`blob`/`offsiteAlterMin`):

```
"kampftext": {
  "aktiv": false, "modell": "qwen3.5:4b", "gemessenVorSek": 37,
  "aiCore":     { "erreichbar": true, "ollamaOnline": true, "modellVorhanden": true, "fehler": "" },
  "schluessel": { "zeichen": 64, "befund": "passt", "hinweis": "" }
}
```

**Was die Felder bedeuten, in Laiensprache:** `erreichbar` – kommt der Pi überhaupt bis zum M715q
(Netz, Firewall, Docker-Netz). `ollamaOnline` – läuft dort das Sprachmodell-Programm.
`modellVorhanden` – ist genau das Modell geladen, das der Kampftext benutzt. `schluessel.befund` –
`passt`, `falsch` (mit der Zeichenzahl, die AI Core empfangen hat), `fehlt` (0 Zeichen, es wird gar
nicht erst gefragt), `ungeprueft` (AI Core nicht erreichbar, niemand konnte gefragt werden) oder
`unklar` (AI Core selbst meldet einen Fehler, steht im `hinweis`). `zeichen` ist die Länge des
gesetzten Schlüssels: 64 ist richtig, 65 ist das Leerzeichen hinter dem `=` (AI-Core-Lektion 7).
`null` bei `ollamaOnline`/`modellVorhanden` heißt „nicht messbar", nicht „nein".

**Drei Entscheidungen:**

1. **Der Schlüssel wird an `/ai/embed` geprüft, nie an `/ai/chat`.** Embedding ist der billige Pfad
   und von AI Core bewusst ungedrosselt; AI Core prüft den Schlüssel vor jedem Ollama-Aufruf, also ist
   401 eindeutig „falsch" – auch wenn Ollama gerade nicht läuft. Eine Prüfung über `/ai/chat` kostete
   70 s Textgenerierung alle zehn Minuten und wäre selbst die Last, vor der der Tagesdeckel schützt.
2. **Nichts in der Antwort nennt Adresse oder Schlüssel.** Node-Systemfehler tragen die Zieladresse
   im Text (`connect ECONNREFUSED 192.168.178.45:8000`); gemeldet wird nur der Code
   (`ECONNREFUSED`: nichts hört auf dem Port, `EHOSTUNREACH`: kein Weg zur Maschine, `ETIMEDOUT`:
   keine Antwort). Der Code allein ist die Diagnose.
3. **Ein Transport für beide Wege.** `kampftextHttp()` bedient den Textauftrag und die Prüfung; der
   Aufruf war vorher fest an `/ai/chat` gebunden. Ein zweiter Client daneben wäre die Vervielfachung,
   die Social Hub bis PR #12 vier Fassungen derselben Timeout-Logik eingebracht hat. Die 57 Prüfungen
   von `test_kampftext_http.js` decken den Umbau.

**Was am Pi bleibt – einmalig, im Portainer-Stack des Backends:** `AI_CORE_API_KEY` (derselbe Wert wie
`API_KEY` in AI Cores `.env`; er liegt auch schon in Social Hubs `server/.env` auf dem Pi) und
`AI_CORE_URL` nur, falls die Vorgabe `http://192.168.178.45:8000` nicht stimmt. „Update the stack"
erzeugt den Container neu; Sekunden später steht der Befund in `/api/health`. Im selben Schritt
lassen sich `BACKUP_PULL_TOKEN` (Off-Site-Sicherung) und `DEPLOY_ALARM_MAIL` (Deploy-Alarm) setzen,
die aus demselben Grund seit dem 02.09. bzw. 22.08. ausstehen.

Wächter: `tests/test_kampftext_selbstpruefung_http.js` (Port 3260/3261; 20 Prüfungen, vier
Serverstände, weil der Schlüssel nur über die Umgebung wechselt; vier Gegenproben mit gemessenen
Ausfall-Listen im Dateikopf). Der Takt ist per `KAMPFTEXT_PRUEF_TAKT_MS` stellbar (Untergrenze 1 s),
damit der Test die **Wiederholung** messen kann – eine Messung, die nach dem Start nie mehr nachschaut,
meldete „erreichbar" noch lange, nachdem es das nicht mehr ist (Abschnitt A: Modell weg, AI Core
weg, AI Core zurück). Der Fake im älteren `test_kampftext_http.js` zählt seither nur `/ai/chat` als
Auftrag; `/health` und `/ai/embed` landen in `ai.sonstige`.

## Etappe E1b, Backend-Hälfte (04.09.2026)

Die Erkundung des Frontends für E1b hat eine Annahme des Konzepts widerlegt: **Die Berichte liegen
nicht im Spielstand, sondern hier** – in `db.private[userId].__reports` (`addReport`), und der Client
hält nur einen Cache, den er alle 15 Sekunden neu lädt (`loadReports`). Ein Client, der den fertigen
Text selbst abholt und irgendwo ablegt, hätte ihn nur auf einem Gerät. Deshalb hängt der Server den
Text an den Bericht:

1. **`POST /api/reports` nennt jetzt die ID des angelegten Berichts** (`{ ok: true, id }`). Der Client
   warf die Antwort bisher weg; ein älterer Client tut das weiterhin, ohne Schaden.
2. **`POST /api/kampfbericht/text` nimmt `reportId` entgegen.** Nur ein **eigener, vorhandener** Bericht
   wird verknüpft (`kampftextEigenerBericht`); eine fremde oder unbekannte ID wird still ignoriert –
   der Auftrag läuft trotzdem und bleibt über `GET` abholbar. Kein Fehler, weil eine fehlende
   Verknüpfung den Text nicht entwertet.
3. **Wird der Text `fertig`, schreibt `kampftextArbeite` ihn als `kiText` in den Bericht**
   (`kampftextAnBerichtHaengen`), synchron vor dem `saveDb()`. Ist der Bericht inzwischen gelöscht
   oder aus dem Archiv gerollt, passiert nichts – er kommt nicht wieder.
4. **Der Client braucht keinen Poll.** Der nächste Berichte-Abruf bringt den Text mit, auf jedem Gerät
   des Spielers. Die Route `GET /api/kampfbericht/text/:id` bleibt (Tests, ältere Clients, Diagnose).
5. **Notaus `kampftext`** in `NOTAUS_NAMEN`/`spawnAktivImCode`: Jeder Text kostet den M715q rund
   70 Sekunden, und der bedient auch Social Hub. Der Betreiber kann abschalten, ohne einen Deploy;
   der Endpunkt antwortet dann 503, die Sektion bleibt beim Spieler still weg. Einschalten kann nur
   ein Merge (dieselbe einseitige Richtung wie bei den Spawns).
6. **`KAMPFTEXT_AKTIV = true`.** Der Schalter wird hier umgelegt, nicht im Frontend-PR, weil die Repos
   getrennt sind und der Client mit 503 umgeht (keine Sektion, kein Fehler). Bis der Frontend-PR
   live ist, ruft den Endpunkt niemand auf.

Wächter: `tests/test_kampftext_http.js` Abschnitte 12 und 13 (jetzt 75 Prüfungen). Abschnitt 1 lief
bisher gegen die echte `server.js` und setzt seit dem Umlegen wie Abschnitt 2 auf eine **Kopie**, hier
mit `false` – welche Stellung committet ist, darf das Ergebnis nicht verschieben. Gegenprobe: siehe
Dateikopf.
