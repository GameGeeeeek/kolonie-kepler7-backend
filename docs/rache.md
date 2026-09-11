# Vergeltung / Rache-Knopf (Feature D, 11.09.2026)

Wer von einem Spieler angegriffen wurde, darf 24 Stunden lang zurückschlagen – mit mehr Beute und
mehr Kampfpunkten. Auftrag Sascha (Analyse-Paket vom 11.09.2026, sieben Gameplay-Features): mehr
PvP-Aktion ohne Freiflug. Frontend-Gegenstück: der Knopf „Vergeltungsschlag" im Bericht
`attack-received`, die Zeile „Vergeltung: +25 % Beute" in der Angriffsvorschau (`kolonie-kepler7`,
Test `tests/test_rache.js`).

## Was

- **Das Recht** entsteht nach **jedem** aufgelösten Spielerangriff in `/api/attack` – Sieg wie
  Niederlage des Angreifers. Ein abgeprallter Angriff (Schild, 403) erzeugt nichts, weil kein Kampf
  stattgefunden hat.
- **Der Vergeltungsschlag**: Greift ein Spieler jemanden an, gegen den er ein gültiges Recht hält,
  ist der Angriff ein Vergeltungsschlag. **Bei Sieg**: Beute-Anteil × 1,25 (`RACHE_BEUTE_BONUS`),
  `+10` Kampfpunkte (`RACHE_KAMPFPUNKTE`) zusätzlich zu den 25 des Sieges, Recht verbraucht.
  **Bei Niederlage**: nichts davon, das Recht bleibt bis zum Ablauf stehen.
- **Nicht angefasst**: Anfängerschutz, Angriffs-Schutzschild und Ratenbremse laufen unverändert
  VOR allem – der Schild blockt auch einen Rächer mit Recht (`test_rache_http.js` 2g).

## Warum das Recht am Nutzerobjekt liegt

Daran hängt eine Belohnung (Beute und Punkte), und der Spielstand ist klientenautoritativ. Ein
Recht im Spielstand wäre in fünf Sekunden für jeden Gegner „gültig". Deshalb `user.rache` in
`db.users`, dieselbe Grenze wie bei Bonuscodes und der Abwehr-Gutschrift (CLAUDE.md,
Sicherheitsgrenze). `test_rache_http.js` 1e misst, dass der Spielstand das Feld nicht trägt.

## Felder

`user.rache` (am Verteidiger): Objekt `{ [angreiferId]: { name, seit, bis } }`.
`bis = seit + RACHE_FENSTER_MS`; ein erneuter Angriff desselben Gegners setzt das Fenster neu.
Beim Schreiben fliegen abgelaufene Einträge raus, dann die ältesten über `RACHE_MAX_EINTRAEGE` (5).
`racheRecht()` prüft mit `hasOwnProperty` – `targetUserId` kommt aus dem Request, und
`{}['constructor']` wäre sonst wahr (dieselbe Falle wie bei der Standortwahl).

Berichte (`__reports`):
- `attack-sent`: zusätzlich `targetUserId`; bei gewonnenem Vergeltungsschlag `rache: true,
  racheBonus: 0.25`.
- `attack-received`: zusätzlich `attackerId` (das Signal für den Knopf im Client); bei erlittenem
  Vergeltungsschlag ebenfalls `rache`/`racheBonus`.

Antwort von `/api/attack` bei Sieg: `rache: true, racheBonus: 0.25` (sonst kein Feld).
`/api/me`: `rache: [{ gegnerId, gegnerName, bis }]` – nur gültige, jüngste zuerst; **fehlt bei
`RACHE_AKTIV = false`** (nicht: leere Liste), damit der Client „alter Server / aus" von „kein
Recht" unterscheiden kann.

Push-Text `attack-received` (`pushNotificationText`): Zusatz „Vergeltung 24 h möglich." in beiden
Ausgängen, aus `RACHE_FENSTER_MS` abgeleitet.

## Die Beute-Kappung

Der Bonus wirkt auf den **Anteil**, vor der Kappung: `take = min(amt, floor(amt · lootPct ·
farmPenalty · lootProtection · beuteFaktor · racheBeuteMult))`. Die Kappung am Bestand des Ziels war
bisher implizit (der Anteil lag stets unter 1); sie steht jetzt ausdrücklich da, weil ein Faktor
dazugekommen ist. Im Normalfall ist `racheBeuteMult` 1 und der Term byte-neutral.

## Zwei bewusste Entscheidungen

1. **Sockel-Angriff löst keine Vergeltung aus und verbraucht sie nicht.** Ein Angriff unter dem
   PvP-Mindesteinsatz bringt keine Beute und keine Punkte – +10 Kampfpunkte für einen Jäger wären
   genau das Leck, das der Mindesteinsatz schließt. Das Recht bleibt für den ernsthaften Schlag.
2. **`attackerId`/`targetUserId` hängen am Schalter.** Sie sind das Signal, an dem der Client den
   Knopf zeigt und „Vergeltung möglich" verspricht – ohne Wirkung dahinter wäre das ein leeres
   Versprechen. Mit `RACHE_AKTIV = false` fehlen beide Felder, `/api/me.rache` und der Push-Zusatz.

## Schalter

`RACHE_AKTIV = true` (server.js, direkt vor `/api/attack`). Gattert Zählung, Wirkung, Felder und
Push-Zusatz gemeinsam – hier gibt es keine Auszahlung mit neuem Reward-Typ, ein alter Client sieht
nur harmlose Zusatzfelder und bekommt bei einem gewonnenen Vergeltungsschlag schlicht mehr Beute
und Punkte, ohne zu wissen warum. Backend zuerst live, dann Frontend.

## Wächter: `tests/test_rache_http.js` (Port 3276, 35 Prüfungen)

Startet immer eine **Kopie** (`server_rache_tmp.js`) mit festgenageltem Wurf (`Math.random = 0,5`):
`resolveBattlePhases` liest den Wurf je Aufruf, die Phasenchance ist auf [0,196; 0,804] geklemmt –
stark gegen schwach gewinnt damit immer, ein Jäger gegen die Festung verliert immer. Der erste
Entwurf würfelte und wiederholte bis zum Sieg; in einer Gegenprobe gewann die „Niederlage" im ersten
Anlauf (10 %), setzte den Schild und ließ jede Wiederholung abprallen. Der feste Wurf macht die
Beute außerdem **exakt** prüfbar: 231.250 Erz mit Vergeltung, 185.000 ohne (1 Mio × 18,5 %).

Gegenprobe per `KEPLER_RACHE_SABOTAGE=<name>`, jede Liste **gemessen** (11.09.2026):

| Sabotage | fällt |
|---|---|
| `bonus` (Faktor bleibt 1) | 2c, 2c2 |
| `punkte` (keine +10) | 2d |
| `verbrauch` (Recht überlebt den Sieg) | 2e, 2f |
| `ablauf` (`bis` ignoriert) | 3a, 3b, 3c, 3d |
| `felder` (rache/racheBonus fehlen) | 2a, 2b |
| `vermerk` (kein Recht entsteht) | 1a, 1b, 2a, 2b, 2c, 2c2, 2d, 4d, 5a |
| `deckel` (Liste wächst über 5) | 5a |

Der Test prüft am Ende selbst, dass **genau** diese Liste gefallen ist, und in `0-sabotage`, dass
der Ersatz überhaupt gegriffen hat. `test_pvp_standorte_http.js` bleibt grün (Altpfad unverändert).
