# Saison-Auftragsbuch (Feature B, 11.09.2026)

## Was und warum

Ein **Monatsfortschritt aus Taten, die der Server selbst gesehen hat**. Die Tagesaufgaben des Spiels
leben im Spielstand und sind damit klientenautoritativ – an ihnen kann keine Belohnung hängen, die
über den eigenen Spielstand hinausreicht (Sternenstaub, Titel). Das Auftragsbuch ist das Gegenstück:
Es zählt ausschließlich im **Erfolgspfad einer Route, die den Kampf oder Handel serverseitig
aufgelöst hat**, und speichert am **Nutzerobjekt**. Derselbe Gedanke wie beim Sternenstaub
(`docs/unterstuetzer-und-wirtschaft.md`).

## Zustand

`user.auftragsbuch = { saison:'YYYY-MM', punkte, taten:{[art]:n}, tag:{datum:'YYYY-MM-DD', zaehler:{[art]:n}}, abgeholt:[stufenNr…] }`

- `saison` ist der Monat in **UTC** (`auftragsbuchSaison()`), `tag.datum` der UTC-Tag
  (`staubTagesschluessel()`, derselbe Schlüssel wie beim Sternenstaub).
- Liegt das Feld nicht in `db.users`, sondern ein Spieler schreibt ein gleichnamiges Feld in seinen
  Spielstand, ist das wirkungslos – Wächter 8a–8c.

## Katalog und Stufen

| art | Tat | Punkte | Tagesdeckel | Hook |
|---|---|---|---|---|
| `angriff` | Spielerangriff geführt | 10 | 5 | `/api/attack`, beide Ausgänge – nicht bei Schild (403) oder 400/404 |
| `abwehr` | Angriff abgewehrt | 8 | 3 | `/api/attack`, Abwehrzweig, dem Verteidiger |
| `festung` | Festung angegriffen | 8 | 6 | `/api/festung/angriff` nach `festungSchlagAusfuehren` |
| `nest` | Nest angegriffen | 8 | 6 | `/api/alien/nest-angriff` nach `nestSchlagAusfuehren` |
| `konvoi` | Konvoi überfallen | 8 | 6 | `/api/konvoi/angriff` nach `A2SchlagAusfuehren` |
| `weltboss` | Weltboss getroffen | 6 | 8 | `/api/worldboss/resolve`, nur im Trefferzweig (nicht bei Abklingzeit, nicht `arrivedTooLate`) |
| `vorposten` | Vorposten angegriffen | 8 | 6 | `/api/vorposten/angriff` nach `vorpostenSchlagAusfuehren` |
| `markt` | Handel am Markt | 2 | 10 | `/api/market/trade`, nur der Erfolgspfad |

Die „verpasst"-Antworten (Ziel weg, weitergezogen) stehen in allen Schlag-Routen VOR dem Hook.

`AUFTRAGSBUCH_STUFEN`: 20 Stufen ab `[25,60,100,150,210,280,360,450,550,660,780,910,1050,1200,1360,1530,1710,1900,2100,2310]`
Punkten. Kredite steigen von 100 auf 600 (Zehnerschritte); Stufe 5/10/15/20 tragen zusätzlich
Sternenstaub 5/8/12/20 und Modulfragmente 2/4/6/10; Stufe 20 den Titel `Chronist der Saison`
(informativ im Reward – vergeben wird er vom Client in `state.seasonTitles`).

## Routen (hinter `authMiddleware`)

- `GET /api/auftragsbuch` → `{ aktiv:true, saison, endetAm, punkte, taten, stufen:[{stufe, ab, belohnung,
  erreicht, abgeholt}], katalog:[{art, name, punkte, tagesDeckel, heute}] }`.
- `POST /api/auftragsbuch/abholen` → für jede erreichte, nicht abgeholte Stufe
  `pushPendingReward(uid, { type:'auftragsbuch', saison, stufe, credits, fragmente?, staub?, titel? })`;
  Antwort `{ ok:true, abgeholt:[stufen] }`. **Sternenstaub bucht der Server** in derselben Funktion
  (`auftragsbuchStufeAuszahlen`), Kredite und Fragmente bucht der Client beim Abholen.
- Schalter aus → beide Routen `404 { error:'Das Auftragsbuch ist nicht aktiv.', inaktiv:true }`; der
  Client blendet die Box dann ersatzlos aus.

## Saisonwechsel – lazy, ohne Tick

Beim ersten Kontakt in einem neuen Monat (Tat, GET oder POST) schließt `auftragsbuchVon(user)` das
alte Buch: erreichte, nicht abgeholte Stufen werden eingereiht, danach wird neu angelegt. Idempotent,
weil `abgeholt` am alten Buch vor dem Austausch fortgeschrieben wird. Wer im ganzen Monat nicht
vorbeikommt, bekommt die Stufen beim nächsten Besuch – nichts verfällt. Grenze: Die Warteschlange
hält 20 Einträge (`slice(-20)` in `pushPendingReward`); wer eine Saison mit allen 20 Stufen komplett
liegen lässt, füllt sie damit ganz.

## Schalter

`AUFTRAGSBUCH_AKTIV` (im Code, `true` seit 11.09.2026) und der Notaus `auftragsbuch` in `NOTAUS_NAMEN`.
`spawnAktiv('auftragsbuch')` gattert **Zählung, Auszahlung und beide Routen**. Ausliefern:
Backend zuerst, dann Frontend. Bis dahin sieht ein alter Client nichts – er kennt die Routen nicht,
und ein `auftragsbuch`-Reward entsteht nur durch `POST /abholen` (nur der neue Client ruft es) oder
durch einen Saisonwechsel (nächster: Monatsanfang). Läge der Monatswechsel VOR dem Frontend-Deploy,
sähe ein alter Client den Rückfall „Dankeschön vom Team: +… Kredite für deinen Bug-Report" – deshalb
beide PRs am selben Tag.

## Wächter

`tests/test_auftragsbuch_http.js` (Port 3274, 40 Prüfungen). Gegenprobe per Env-Sabotage an einer
Kopie von `server.js`: `KEPLER_AUFTRAGSBUCH_SABOTAGE=<zaehlung|deckel|schild|doppelt|saison|schalter>`;
die gemessene „muss fallen"-Liste steht im Dateikopf – mit dem, was bewusst NICHT fällt.
