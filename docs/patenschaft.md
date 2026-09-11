# Patenschaft: Mentor und Schützling (Feature G)

*Angelegt am 11.09.2026.*

Wer sich über einen Einladungs-Link registriert, ist **30 Tage** lang der Schützling seines
Einladenden. Jeder Meilenstein, den der Schützling in dieser Zeit **zum ersten Mal** schafft, zahlt
**beiden** Seiten Kredite und Sternenstaub. Der Pate hat damit einen Grund, dem Neuling nach der
Einladung weiter zu helfen – der bestehende Einladungs-Bonus (500 Erz + 500 Kristalle / 50 Kredite
ab Level 5) zahlt genau einmal und bleibt unverändert.

## Warum alles am Nutzerobjekt liegt

`user.pate` (Schützling) und `user.schuetzlinge[userId]` (Pate) liegen in `db.users`, nichts davon
im Spielstand. Der Spielstand ist klientenautoritativ, und an dieser Verknüpfung hängen Belohnungen
für ein **fremdes** Konto: Ein selbst in den Spielstand geschriebener `pate` ist für den Server
unsichtbar (`test_patenschaft_http.js`, 7a). Die Meilenstein-Zeitstempel stehen auf **beiden**
Seiten (`meilensteine[key] = ts`), damit die Karte beider Spieler denselben Stand zeigt.

## Felder

```
user.pate = { userId, name, seit, bis, meilensteine: { key: ts } }
user.schuetzlinge[userId] = { name, seit, bis, meilensteine: { key: ts } }
```

- `bis = seit + PATENSCHAFT_DAUER_MS` (30 Tage). Nach Ablauf bleiben die Einträge stehen (die Karte
  zeigt „abgelaufen" und die erreichten Häkchen), aber kein Meilenstein zahlt mehr.
- **Eine Patenschaft ist fest**: Wer schon einen Paten hat – auch einen abgelaufenen –, bekommt
  keinen zweiten. Dieselbe Regel wie beim Einladungs-Bonus (einmal je Konto).
- **Deckel `PATENSCHAFT_MAX_SCHUETZLINGE = 10`**: Ist die Liste des Paten voll, fliegen beim
  nächsten Verknüpfen **abgelaufene** Einträge raus (älteste zuerst) – laufende nie (Deckel löschen
  keine Daten). Sind alle zehn noch am Laufen, gibt es **keinen** Paten-Eintrag auf beiden Seiten;
  der gewöhnliche Einladungs-Bonus läuft trotzdem (11a/11b).

## Verknüpfung

Genau **eine** Stelle: `POST /api/referral/redeem`, in dem Zweig, der `save.referredBy` zum ersten
Mal setzt (`patenschaftVerknuepfen(schuetzling, referrer)`). Der Schützling ruft die Route vor
Level 5 mehrfach – jeder weitere Aufruf läuft durch den „schon verknüpft"-Zweig und verknüpft nicht
neu (1c). Die Antwort trägt beim ersten Mal zusätzlich `patenschaft: { name, bis, tage }`; ein
alter Client ignoriert das Feld, der neue zeigt „Dein Pate: … – 30 Tage gemeinsame Meilensteine".

## Meilensteine (`PATENSCHAFT_MEILENSTEINE`, Reihenfolge = Anzeige)

| key | Name | Hook |
|---|---|---|
| `erster-sieg` | Erster gewonnener Spielerangriff | `/api/attack`, Siegzweig, Angreifer (kein Sockel-Nadelstich) |
| `erste-abwehr` | Erster abgewehrter Angriff | `/api/attack`, Abwehrzweig, Verteidiger |
| `erster-schlag` | Erster Schlag gegen Nest oder Festung | `/api/alien/nest-angriff`, `/api/festung/angriff` (Erfolgspfad) |
| `erster-handel` | Erster Handel am Markt | `/api/market/trade` (nur erfolgreich) |
| `serie-5` | Fünf Tage in Folge angemeldet | `staubAnmeldungGutschreiben`, `serie >= 5` |

`patenschaftMeilenstein(userId, key)` ist der eine Hook: nur wenn `user.pate.bis > now` und der
Meilenstein noch offen ist. Dann Zeitstempel auf beiden Seiten, **Sternenstaub bucht der Server**
(`staubGutschreiben`, 3 je Seite), Kredite über die Warteschlange:

```
pushPendingReward(schuetzling, { type:'patenschaft', rolle:'schuetzling', meilenstein, name, partnerName, credits:200, staub:3 })
pushPendingReward(pate,        { type:'patenschaft', rolle:'pate',        meilenstein, name, partnerName, credits:150, staub:3 })
```

Dazu ein Postfach-Eintrag beim Paten (`pushNotificationEvent(pate, 'patenschaft', …)`, Text in
`pushNotificationText`, Sprungziel `einstellungen`). Der Hook läuft synchron vor dem `saveDb()` der
jeweiligen Route und steht in einem `try` – ein Fehler dort darf nie den Kampf oder den Handel
kaputtmachen.

## Route

`GET /api/patenschaft` → `{ aktiv:true, dauerTage:30, maxSchuetzlinge:10, pate:{name, seit, bis,
aktiv, meilensteine}|null, schuetzlinge:[{…}], katalog:[{key, name, credits:{pate, schuetzling},
staub}] }`. Namen, keine Kennungen. Bei `PATENSCHAFT_AKTIV = false`: **404** `{ inaktiv:true }` –
ein Client lässt die Karte dann ersatzlos weg, „Endpunkt fehlt" und „abgeschaltet" sehen für ihn
gleich aus.

## Schalter und Auslieferung

`PATENSCHAFT_AKTIV = true` gattert Verknüpfung, Zählung **und** Auszahlung. Er steht auf `true`,
weil beide Repos zusammen ausgeliefert werden – **Backend zuerst**, per `/api/health` belegt, dann
Frontend. Was ein alter Client bis dahin sieht: Der Reward-Typ `patenschaft` fällt in
`claimPendingRewards` in den Rückfall-Zweig und meldet „Dankeschön vom Team: +200 Kredite für
deinen Bug-Report!" – die Kredite stimmen, der Satz nicht. Den Sternenstaub hat der Server ohnehin
gebucht. Deshalb den Backend-PR erst mergen, wenn der Frontend-PR bereitliegt.

## Wächter

`tests/test_patenschaft_http.js` (Port 3277, 55 Prüfungen) gegen einen echt gestarteten Server:
Verknüpfung beider Seiten und nur einmal, Route, erster Sieg zahlt beide genau einmal (Zeitstempel,
Reward-Form, Staub vom Server, Postfach), zweiter Sieg nichts, Ablauf (mit Gegenrichtung über den
Markt-Hook), ohne Paten nichts, Spielstand-PUT wirkungslos, erste Abwehr, Serie, Nest-/Festungs-
Hook als Quelltext-Anker, Deckel. Gegenprobe per `KEPLER_PATENSCHAFT_SABOTAGE=schalter|einmal|
ablauf|sieg|verknuepfung` an einer Kopie von `server.js`; die „was fallen MUSS"-Listen im Dateikopf
sind gemessen.

Messaufbau-Fallstrick (gemessen in der Gegenprobe `einmal`): Der winzige Angreifer der
Abwehr-Messung **gewinnt** mit ~10 % je Anlauf (`PVP_PHASE_MIN = 0.196` je Phase). Dann trägt der
Schützling einen Schild und einen `pvp-fleet-loss` in der Warteschlange – der Test nullt den Schild
bei gestopptem Server und überspringt fremde Rewards, statt den Ausgang als Befund zu deuten.
