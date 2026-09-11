# Stimmen-Belohnung: browsermmorpg.com ruft nach einer Stimme zurück (11.09.2026)

**Auftrag Sascha, wörtlich:** „Voting Script in Kepler einbauen. Spieler sollen nach 6 Stunden ein
Popup bekommen bitte voten für mehr Spieler und vergib nach dem Voten dem Spieler eine kleine Belohnung."

**Was bewusst NICHT gebaut wurde:** ein Skript, das selbst abstimmt. Das wäre Stimmen-Fälschung, die
Seite wehrt sich dagegen (Captcha, eine Stimme je sechs Stunden), und ein aufgeflogener Eintrag ist
weg. Gebaut ist der Weg, den das Verzeichnis selbst anbietet: „Postback & callback reward systems –
pay players for voting".

## Die Kette

1. Das Spiel zeigt alle sechs Stunden ein Fenster („Eine Stimme für die Galaxie") mit einem nackten
   Link auf `https://browsermmorpg.com/vote.php?id=1799&username=<Registrierungsname>` (Frontend,
   `maybeShowStimmeErinnerung`). **Wann**, sagt dieser Server über `/api/me` → `stimme.naechsteAb`.
2. Der Spieler stimmt dort ab (ohne Konto, „Did you like this game? Yes/No").
3. browsermmorpg.com ruft die im Konto dort hinterlegte Adresse auf:
   `GET https://gamegeeeeek.de/api/stimme/rueckruf?key=<STIMME_RUECKRUF_KEY>&spieler=<Name>`
   (die Route nimmt den Spieler auch unter `username` oder `user` an – wie das Verzeichnis den
   Parameter nennt, steht in dessen Konto und ist dort abzulesen, nicht zu raten).
4. Der Server prüft Schlüssel, Konto und Sperre, legt `{ type:'verzeichnis-stimme', credits:25 }`
   über `pushPendingReward` ins Belohnungsfach; das Spiel holt es im Takt ab, bucht die Kredite und
   schreibt einen Bericht „Danke für deine Stimme".

## Die Regeln der Route

| Fall | Antwort | Warum |
|---|---|---|
| `STIMME_RUECKRUF_KEY` nicht gesetzt | **503** | fail-closed wie Ko-fi-Webhook und Maschinenzugang: Ohne Schlüssel gibt es die Route nicht |
| Schlüssel fehlt / falsch | **401**, Meldung nennt die **Länge** (0 = fehlend), nie den Wert | „ungültig ODER fehlend" ist keine Diagnose (AI-Core-Lektion 7) |
| Spieler unbekannt / ohne Spielstand / Notaus | **200**, `belohnt:false`, `grund` | eine fremde Maschine soll bei 4xx nicht wiederholen; der Grund steht im Body und im Log |
| innerhalb der Sperre | **200**, `belohnt:false`, `grund:'sperre'`, `naechsteAb` | Sperre = 6 h **minus 15 min** Toleranz, weil der Rückruf Sekunden nach der Stimme kommt |
| sonst | **200**, `belohnt:true`, `naechsteAb` | Sperre und Zähler VOR der Belohnung, im selben synchronen Block vor `saveDb()` |

- **Die Sperre liegt am Konto** (`user.stimmeBelohntZuletzt`, dazu `user.stimmenGezaehlt`), nie im
  klientenautoritativen Spielstand – eine Belohnung, die der Spieler selbst freischalten könnte, wäre keine.
- **Bremse nur für Fehlversuche:** 60 falsche Schlüssel je 15 Minuten je Herkunft, dann 429 mit
  `Retry-After`. Ein richtiger Schlüssel wird **nie** gebremst – alle echten Rückrufe kommen von der
  einen Adresse des Verzeichnisses, und ein Zähler über alle Aufrufe hätte ab dem 61. Voter in einer
  Viertelstunde die Belohnung verweigert (Codex-Review am PR, 11.09.2026). Was ein einzelner
  Aufruf bewirken kann, begrenzt die Sperre je Konto.
- **Höhe:** `STIMME_BELOHNUNG_KREDITE` (Vorgabe 25), geprüft durch `bonuscodeGabenPruefen` – dieselben
  Deckel wie bei Bonuscodes. Wer eine andere Gabe will, erweitert `stimmeBelohnung()`.
- **Notaus `stimme`** (`POST /api/admin/schalter`): Rückruf antwortet 200 ohne Belohnung, `/api/me`
  liefert `belohnung: null` – das Fenster im Spiel verspricht dann keine Kredite mehr.
- **`/api/me` → `stimme`:** `{ belohnung: {credits} | null, naechsteAb }`. `naechsteAb` ist
  `max(stimmeBelohntZuletzt, createdAt) + 6 h` – ein frisches Konto sieht die erste Erinnerung sechs
  Stunden nach der Registrierung („nach 6 Stunden ein Popup"). Der Rückruf selbst hängt **nicht** an
  `createdAt`: Wer früher abstimmt, wird belohnt.
- **`/api/health` → `stimmenRueckruf`:** `true`, wenn Schlüssel gesetzt und kein Notaus – der
  Deploy-Beleg ohne Anmeldung.

## Einrichten (Pi und Verzeichnis)

1. Schlüssel erzeugen, z. B. `openssl rand -hex 32`, als `STIMME_RUECKRUF_KEY` in den Portainer-Stack
   (kein Leerzeichen nach dem `=`; Prüfung ohne den Wert zu zeigen: 65 Zeichen mit Zeilenumbruch).
2. Container neu erzeugen, dann `curl -s https://gamegeeeeek.de/api/health | grep -o '"stimmenRueckruf":[a-z]*'` → `true`.
3. Im Konto bei browsermmorpg.com die Postback-Adresse eintragen:
   `https://gamegeeeeek.de/api/stimme/rueckruf?key=<SCHLÜSSEL>&spieler=<Platzhalter für den Spielernamen>` –
   welchen Platzhalter das Verzeichnis anbietet und welchen Parameter es an die Vote-Adresse
   anhängt, steht dort im Formular. Passt der Parametername nicht zu `spieler`/`username`/`user`,
   ist `STIMME_LINK_PARAM` im Spiel bzw. die Namensliste in der Route die EINE Stelle dafür.
4. Probe von Hand: `curl -s "https://gamegeeeeek.de/api/stimme/rueckruf?key=<SCHLÜSSEL>&spieler=GameGeeeeek"`
   → `{"ok":true,"belohnt":true,…}`; im Spiel erscheint binnen einer Viertelminute „Danke für deine Stimme".

**Reihenfolge der Auslieferung:** Backend zuerst (dieser PR), per `/api/health` belegt; das Spiel
(kolonie-kepler7, `v8.719.0`) zeigt das Fenster erst, wenn `/api/me` das Feld `stimme` trägt.

## Wächter

`tests/test_stimme_rueckruf_http.js` (26 Prüfungen): fail-closed, Längenmeldung, unbekannt/ohne
Spielstand, Belohnung genau einmal je sechs Stunden, Sperre am Konto statt im Spielstand, `/api/me`
und `/api/health`, Notaus. Gegenprobe: am alten `server.js` antwortet 1a mit 404 – rot.
