# Wrackkonvois (A2, wandernde Beute-Ziele)

Verschoben aus `CLAUDE.md` am 01.09.2026 (Strukturprüfung, Punkt 1: Startkontext verkleinern). Wortlaut unverändert; Querverweise wie „unten" oder „oben" beziehen sich auf die frühere Reihenfolge in `CLAUDE.md`. Neue Erkenntnisse zu diesem Bereich gehören ab jetzt hierher, nicht in `CLAUDE.md`.

## Die wandernden Beute-Ziele – Wrackkonvois (A2, 28.08.2026)

Auftrag Sascha „beide umsetzten" (A2 wandernde Beute-Ziele UND B2 Vorposten). Konzept:
`docs/wandernde-beute-ziele-konzept.md` im FRONTEND-Repo. Der Code trägt einen ausführlichen
Doku-Block an der Konstantendefinition (`const A2_SPAWN_AKTIV`); hier stehen nur die
Entscheidungen, die man kennen muss, bevor man etwas ändert.

**A2 ist KEIN dritter Nomaden-Klon.** Es hebt sich vom Vex-Nest über ZWEI Achsen ab, die dem Nest
gemessen fehlen:

1. **Exklusive Beute über das Herkunfts-Schloss.** Der Fall wirft `kv_bergungslogik` (Standort,
   `effect:'prod'`) UND `kv_bergungspanzer` (Schiff, `effect:'hull'`, Klasse `schwerelinie`), beide
   mit `quelle:'konvoi'`. `fundPool` schließt sie damit aus jedem regulären Fundtopf und beiden
   Schmieden aus; vergeben werden sie ausschließlich über den A2-Schlag. `kv_bergungspanzer` ist
   PvP-relevant und steht deshalb in `SHIP_MODULE_COMBAT_BASE` – **Kopie-Familie**, Parität gegen
   das Frontend Pflicht (`test_A2_http.js` 8e).
2. **Das ENTKOMMEN – der Kern-Reiz.** Ein Nest verschwindet durchs Ignorieren nie
   („weitergezogen" heißt „ins Nachbarsystem, weiter angreifbar"). Ein A2-Ziel dagegen wird nach
   `A2_LEBENSDAUER_MS` (18 h) **ganz** aus `db.galaxy.wrackKonvois` entfernt. Wer zu lange zögert,
   verliert es. Der Endpunkt braucht dafür einen dritten `verpasst`-Grund `'entkommen'`, den er aus
   einer kurzen `a2Verlauf`-Spur (id → grund, gedeckelt auf 40) liest; ein Miss fällt harmlos auf
   `'gefallen'` zurück, weil beide Ausgänge folgenlos sind.

**Ablageort ist `db.galaxy.wrackKonvois`, nicht `db.shared`.** Damit ist die ganze Fehlerklasse
„offener Shared-Storage" umgangen (kein `checkKeyPermission` nötig – dieselbe Wahl wie bei den
Alien-Nestern), und `galaxyFuerClient()` schickt das Feld automatisch lesend an den Client. Der
Client-Feldname ist bewusst der Spielbegriff `wrackKonvois`, nicht der Etappencode – er ist Teil
des Client-Vertrags wie `alienNester`. Die internen Helfer (`A2Tick`, `a2Liste`, `A2_*`) behalten
den Etappen-Prefix.

**Die Abklingzeit liegt AM ZIEL** (`ziel.schlaege[uid]`), nie im Spielstand – genau wie bei Nest
und Festung, und aus demselben Grund (klientenautoritativer Spielstand). `A2_ABKLING_MS` = 2 h.

**Die LP sind gegen die kalibrierten Nest-/Festungs-Schläge gerechnet** (Regel 41), nicht gegen
ein Gefühl: `A2_LP` = 40.000 ist die Größenordnung des Sporenherds (Einsteiger-Nest), rund
5,3 / 0,9 / 0,2 Schläge bei den gemessenen Schlagkräften 7.500 / 44.000 / 240.000. Solo-tauglich –
das ist der Auftrag. In der Lebensdauer bekommt ein Solo-Konto 9 Schläge, deutlich mehr als die
nötigen ~5,3.

### Der gemeinsame Kern mit dem Nest, und die zwei Reward-Felder

Der Schaden läuft durch `A2SchlagAusfuehren` (eigener Rechenkern, KEIN Rollenfaktor/keine
Schwäche – ein Wrackkonvoi ist ein flacher Wurf). **Gezählt wird der ANGEKOMMENE Schaden**
(`lpVorher - lp`), nicht der volle Wurf – dieselbe Entscheidung wie beim Festungsschlag, und
`test_A2_http.js` 3a misst sie mit dem sprechenden Hinweis. Der Server schreibt den Spielstand des
Angreifers **nicht**; die Verluste reisen als Quote in der Antwort, der Client bucht sie.

**Die Belohnung trägt Feldnamen auf DEUTSCH und zwei unabhängige Modulwürfe:**
`{ type:'wrackkonvoi', system, anteil, essenz, kampfpunkte, xp, credits, modul?, kampfmodul?, zeit }`.
`essenz` (nicht `essence`) geht im Frontend nach `state.ascension.essence`. Die zwei Modulfelder
werden **getrennt** gewürfelt (`Math.random() < anteil * A2_MODUL_CHANCE`, Basis 0,3) – der
Claim-Zweig muss BEIDE behandeln. Ausgezahlt wird an **alle** Beitragenden über `pushPendingReward`
mit dem EIGENEN `type:'wrackkonvoi'`; ohne den fällt sie im Client in den „+500 Kredite für deinen
Bug-Report"-Rückfall (`test_A2_http.js` 4b, Gegenprobe `typ`).

### Der Notausschalter und die Auslieferungsreihenfolge

**`A2_SPAWN_AKTIV` steht seit dem 02.09.2026 auf `true`** – das Frontend ist ausgeliefert
(v8.625.0: Kartenknoten, Kartenmenü, Mission `konvoi-angriff`, Bericht, Belohnungszweig
`wrackkonvoi`, beide Module mit `quelle:'konvoi'`), und damit ist die Bedingung erfüllt, unter der
er auf `false` stehen musste. Von außen belegt, bevor der Schalter kippte: Frontend-Version 8.625.0
live, `/api/health` auf `commit e2cc326`/`blob ce1a10f` (#191).

**Der Schalter bleibt trotzdem stehen** – als Notausschalter, aus demselben Grund wie
`FESTUNG_SPAWN_AKTIV` und `NEST_SPAWN_AKTIV`: eine Zeile umzulegen ist schneller und sicherer als
ein Merge zurückzunehmen, Endpunkte, Härtungen und Tests bleiben unangetastet. `test_A2_http.js`
Abschnitt 9 prüft jetzt, dass er auf `true` steht; ein Wechsel auf `false` ist damit eine bewusste
Notabschaltung, die auffällt statt still zu geschehen – und ihr Grund gehört dann hierher.

**Seit demselben Tag hängt A2 auch am Admin-Notaus** (`db.notAus`, `POST /api/admin/schalter`,
Schlüssel `konvois`, ohne Deploy wirksam). Beim Umlegen gemessen: `A2Tick` las bis dahin die
**blanke Konstante** (`if (!A2_SPAWN_AKTIV) return`), nicht `spawnAktiv()` – der Admin-Notaus
erreichte A2 gar nicht, obwohl `CLAUDE.md` `A2_SPAWN_AKTIV` als admin-abschaltbar führte. Genau
in dem Moment, in dem der Schalter live geht, wäre das die einzige Notbremse ohne Deploy gewesen.
Jetzt läuft der **ganze Takt** über `spawnAktiv('konvois')` (kein Entstehen, kein Driften, kein
Entkommen), wie `nestTick`; der Angriffs-Endpunkt hängt nicht am Schalter, bestehende Ziele
bleiben also angreifbar. `spawnAktivImCode('konvois')` liefert die Konstante –
ohne diesen Eintrag liefe `A2Tick` nie (der Rückfall ist `false`). Wächter:
`test_admin_funktionen_http.js` 3a (vier Schalter) und 3d (vier Aufrufstellen).

Warum er überhaupt gebaut wurde, bleibt als Begründung wichtig: A2 wirft ein PvP-relevantes
Kampfmodul ab, also musste das Backend VOR dem Frontend live sein (Regel 60) und der Schalter erst
im Fenster des Frontend-PRs kippen. Solange er aus war, kehrte `A2Tick` in Zeile 1 zurück und der
ganze Abschnitt tat nichts. Umgelegt wurde er unmittelbar nach dem Frontend-Merge
(GameGeeeeek/kolonie-kepler7#516), damit Patchnote und Wirkung im selben Fenster liegen – bei den
Alien-Nestern stand genau diese Lücke zwischen Ankündigung und Wirkung zwei Tage lang.

Wächter: `tests/test_A2_http.js` (**Port 3234**, 35 Prüfungen, vier Gegenproben je mit „was fällt
MUSS"-Liste: `schaden`→3a, `abkling`→2a, `entkommen`→5e-grund, `typ`→4b). Der Test startet eine
**Kopie** von `server.js` mit umgelegtem Schalter (`server_a2test_tmp.js` im Repo-Verzeichnis,
`require('./mailer')` löst dort auf), sonst tut `A2Tick` nichts – dasselbe Muster wie
`test_alien_nester_http.js`. **Belegte Testports sind jetzt 3195–3234.**


