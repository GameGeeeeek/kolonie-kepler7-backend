# Allianzkriege mit Einsatz (Feature C, 11.09.2026)

Auftrag Sascha (Paket „sieben Gameplay-Features", Feature C): Kriegspunkte serverautoritativ, dazu
Einsatz (Staub, Trostpreis) und Kriegsruhm. Frontend-Gegenstück: `kolonie-kepler7`, Kriegspanel im
Allianz-Tab und `tests/test_allianzkrieg.js`.

## Was vorher war – und warum das nicht bleiben konnte

Ein Krieg lag komplett im geteilten Speicher: `alliance:<TAG>:wars` (`{enemies:[…]}`),
`:warmeta:<GEGNER>` (`{endsAt}`), `:warscore:<GEGNER>` (`{score}`), `:warcontrib:<GEGNER>:<userId>`.
Der **Client** schrieb die Punkte selbst (`addWarScore` im Frontend: +1 je gewonnenem Spielerangriff)
und setzte das Zeitfenster; die Rechteprüfung erlaubte jedem Mitglied jeden Wert („rein kosmetisch",
stand im Kommentar). Seit #4 hängt an genau diesem Punktestand aber eine Kredit-Prämie für alle
Beitragenden (`resolveAllianceWarsServer`, 1200 Kredite) – ein vom Client gemeldeter Zähler, an dem
eine Belohnung hängt, verstößt gegen die Hausregel. `warmeta` hatte gar keine Regel: Jeder eingeloggte
Client konnte ein fremdes `endsAt` setzen und den Krieg vorzeitig abrechnen lassen.

## Was jetzt gilt

`const ALLIANZKRIEG_SERVER_AKTIV = true;` (server.js, Block „Allianzkriege mit Einsatz" vor
`resolveAllianceWarsServer`). Bei Schalter an:

- **Der Server vergibt die Punkte**, dort, wo er den Kampf auswürfelt: `allianzkriegWerten()` in
  `/api/attack` (Siegzweig: +10 für die Allianz des Angreifers, Beitrag ihm; Abwehrzweig: +2 für den
  geschlagenen Angreifer, +6 für die Allianz des Verteidigers, Beitrag ihm) und in
  `/api/vorposten/angriff` (+8, nur wenn der Vorposten **fällt** – `erg.gefallen` ist der eindeutige
  Erfolgspfad). Voraussetzung: beide Allianzen stehen in **beiden** `wars`-Listen UND das Zeitfenster
  läuft (`allianzkriegLaeuft`). Im Sockel (Mindesteinsatz) nichts – dieselbe Regel wie beim alten
  `addWarScore`. Antwort und beide Berichte tragen `allianzkrieg: { eigeneTag, gegnerTag, angreifer,
  verteidiger, gedeckelt }`.
- **Tagesriegel am Nutzerobjekt**: `user.allianzkriegTag = { datum:'YYYY-MM-DD', ziele:{[zielId]:n} }`,
  höchstens `ALLIANZKRIEG_TAGESDECKEL = 3` gewertete Angriffe je Angreifer, Ziel und UTC-Tag – **jeder
  Ausgang zählt**, sonst wäre die Abwehrprämie über einen absichtlich verlierenden Freund farmbar. Beim
  Deckel kommt `gedeckelt:true` mit `deckel` zurück, damit der Spieler den Grund sieht.
- **Client-Schreibzugriffe abgelehnt**: `checkAllianceKeyPermission` gibt für PUT auf `wars`,
  `warmeta:`, `warscore:`, `warcontrib:` den Text „Kriegspunkte vergibt der Server." (403). **Lesen
  bleibt offen** – das Kriegspanel liest die Schlüssel weiter. Schalter aus = alter Zweig byte-gleich.
- **Routen** (alle hinter `authMiddleware`, Fehler `{ error }`):
  - `POST /api/allianzkrieg/erklaeren { gegnerTag }` – nur der **Anführer** (`admin`; aus dem
    Frontend-Panel abgelesen, Offiziere dürfen dort nicht). Gegner muss aktive Mitglieder haben
    (`allianzExistiert`), nicht man selbst, nicht schon im Krieg (409), höchstens
    `ALLIANZKRIEG_MAX_LAUFEND = 2` laufende Kriege **je Seite** (409). Schreibt beide Listen, beide
    `warmeta` (`{ startedAt, endsAt, declaredBy, erklaertVon, erklaertAm }` – die ersten drei Felder
    sind das alte Client-Format), räumt Punkte/Beiträge eines früheren Krieges gegen dieselbe Allianz,
    Galaxie-News, `chronikVermerken('allianzkrieg-erklaert', …)`.
  - `POST /api/allianzkrieg/frieden { gegnerTag }` – der Anführer **jeder** der beiden Seiten; räumt mit
    `removeWarEnemy` + `cleanupWarKeys` (ohne Belohnung, wie bisher).
  - `GET /api/allianzkrieg` → `{ aktiv:true, tag, kriege:[{ gegnerTag, endsAt, laeuft, erklaertVon,
    erklaertAm, punkte:{eigene,gegner}, topBeitraege:[{userId,name,score}] (max 3, eigene Seite),
    meinBeitrag }], ruhm:{siege,niederlagen,unentschieden}, regeln:{…} }`. Ohne Allianz: `tag:null`,
    leere Liste, kein Fehler.
  - **Statuscodes bewusst**: 404 heißt für den Client „alter Server ohne diese Route" (Rückfall auf den
    alten Weg). Deshalb sind „Allianz gibt es nicht" und „nicht im Krieg" **400** (`unbekannt:true` /
    `keinKrieg:true`), nicht 404.
- **Abrechnung** (`resolveAllianceWarsServer`, unverändert im Takt und beim Start): zusätzlich zu den
  1200 Krediten je Sieger-Beitragendem `staub: 15` – **den Staub bucht der Server**
  (`staubGutschreiben(staubKonto(user), WAR_VICTORY_STAUB)`), der Reward trägt die Zahl nur zur
  Anzeige. Verlierer-Beitragende bekommen `{ type:'war-defeat', enemyTag, credits: 200, myScore,
  theirScore }`. Kriegsruhm `db.galaxy.allianzRuhm[tag] = { siege, niederlagen, unentschieden }`
  (für Clients unerreichbar; das Frontend vergibt daraus ab 3 Siegen den Titel „Kriegsherren").
- **Alte `warmeta`, die ein Client vor der Umstellung gesetzt hat, bleiben gültig** – dieselben
  Schlüssel, dieselbe Quelle für die Abrechnung. Ein Krieg ganz ohne `warmeta` (aus der Zeit vor dem
  Zeitfenster) bekommt keine Serverpunkte – er wurde auch bisher nie abgerechnet.

## Auslieferung: Backend VOR Frontend

Ein **alter Client** gegen den neuen Server: Das Panel liest weiter (Lesen erlaubt), Erklärung/Frieden
per PUT und `addWarScore` laufen in den 403 – `declareWar` meldet „Kriegserklärung fehlgeschlagen.",
`addWarScore` schluckt den Fehler still (try/catch), die Punkte kommen trotzdem, weil der Server sie
im selben Angriff vergibt. `war-victory` mit `staub` liest der alte Zweig ohne die Zahl (harmlos).
`war-defeat` hat im alten Client keinen Zweig – er landete im Rückfall „Dankeschön vom Team: +200
Kredite für deinen Bug-Report!". Deshalb steht diese Auszahlung hinter dem Schalter, und das Frontend
folgt dem Backend zeitnah (erste Abrechnung frühestens 7 Tage nach der ersten Server-Erklärung).

## Wächter

`tests/test_allianzkrieg_http.js` (Port **3275**, startet eine Kopie mit erzwungenem Schalter an):
Erklärung (Rollen, Selbstkrieg, unbekannter Gegner, doppelt, Deckel 2), Schreibsperre (vier
Schlüssel, Lesen bleibt), Punkte je gewürfeltem Ausgang mit Vermerk in Antwort und Bericht,
Tagesriegel am Nutzerobjekt, Frieden (beide Seiten), Abrechnung beim Serverstart (Staub gebucht,
Trostpreis, Ruhm, Unentschieden, Aufräumen). Gegenprobe per `KEPLER_ALLIANZKRIEG_SABOTAGE=schalter|riegel|staub`
mit gemessener „was fallen MUSS"-Liste im Dateikopf.
