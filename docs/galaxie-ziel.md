# Galaxie-Ziel der Woche – Feature A (11.09.2026)

Auftrag Sascha („Alles umgesetzt, aber nicht Freiflug" – die sieben Gameplay-Features aus der
Analyse). Ein **gemeinsames Wochenziel aller Spieler**: „Schlagt diese Woche zusammen N-mal gegen
Alien-Nester." Jeder gewertete Schlag zählt eins; wer beigetragen hat, bekommt beim Wochenwechsel
Kredite und Sternenstaub – **nur, wenn die Gemeinschaft das Ziel erreicht hat.**

## Was es ist

- **Zustand** `db.galaxy.galaxieZiel = { woche, art, ziel, stand, beitraege:{[userId]:n},
  beitraegeTag:{stempel, konten}, erreichtAm, ausgezahlt, beginn, ende }` – in `db.galaxy`, für
  Clients unerreichbar. `woche` ist `serverWeekKey(now)` (Montag, lokale Zeit – derselbe Schlüssel
  wie die Wochenliga). Das abgerechnete Ziel bleibt als `galaxieZielVorwoche` liegen (Beleg, geht
  nie an Clients).
- **Katalog** `GALAXIE_ZIEL_ARTEN` (Reihenfolge = Rotation nach Wochennummer, Wochen seit Epoche
  modulo vier): `nestschlaege` (`/api/alien/nest-angriff`), `festungsschlaege`
  (`/api/festung/angriff`), `konvoiueberfaelle` (`/api/konvoi/angriff`), `weltbossschlaege`
  (`/api/worldboss/resolve`, nur der **gewertete** Schlag – nicht Tagessperre, nicht „zu spät").
  Je Art `name`, `beschreibung`, `icon` (ti-Klasse, die das Frontend kennt – Paritätstest dort),
  `proSpieler`.
- **Zielhöhe** einmal beim Anlegen: `clamp(round(rkAktiveSpieler() * proSpieler), 10, 400)` mit
  `proSpieler` 3 (Nest/Festung/Konvoi) bzw. 2 (Weltboss). Danach fest für die Woche – sonst
  wanderte das Ziel mit jedem Login.
- **Hook** `galaxieZielBeitrag(userId, art)`: nur im Erfolgspfad der Route, VOR deren `saveDb()`.
  Bindet an die Art der Woche (Festungswoche → Nestschlag zählt nicht). **Tagesdeckel 10 je Spieler**
  (`GALAXIE_ZIEL_TAGESDECKEL`, UTC-Tag wie `rkTagesSchluessel`) – sonst erfüllt ein Konto das Ziel
  allein; der Deckel begrenzt nur die Zählung, nicht den Angriff. Beim Erreichen: `erreichtAm`,
  `pushGalaxyNews(…, 'galaxie-ziel')`, `chronikVermerken('galaxie-ziel-erreicht', { zielArt, ziel,
  stand, kommandanten })`. Zählung läuft nach dem Erreichen weiter (spätere Beitragende werden mit
  bezahlt).
- **Wochenwechsel** `galaxieZielTick(g)` im `galaxyTick` (alle 15 min, beim Start) **und** vor jedem
  Beitrag (ein Schlag Montag 00:05 fällt in die neue Woche). Abrechnung `galaxieZielAbrechnen`:
  idempotent über `ausgezahlt`; je Beitragendem
  `pushPendingReward(uid, { type:'galaxie-ziel', woche, art, name, ziel, stand, beitrag, credits, staub })`
  mit `credits = 200 + min(400, beitrag*50)`, `staub = 5` – **den Staub bucht der Server**
  (`staubGutschreiben(staubKonto(user), 5)`), der Reward trägt die Zahl nur zur Anzeige.
  `pushPendingReward` dedupliziert zusätzlich je `woche`. Verfehlt → keine Auszahlung, Meldung in
  der Weltlage.
- **Transport** `galaxyFuerClient` → `galaxieZiel: { woche, art, name, beschreibung, icon, ziel,
  stand, erreicht, ende, meinBeitrag, kommandanten, tagesDeckel }` – nur wenn Schalter an, Notaus
  nicht gesetzt und das Ziel zur laufenden Woche gehört. `chronikAusClient` blendet das rohe Ziel
  und die Vorwoche aus (Beitrags-Verzeichnis aller Konten).
- `/api/health` → `galaxieZiel: { woche, art, stand, ziel, erreicht, kommandanten, notAus }` –
  der Deploy-Beleg ohne Anmeldung.

## Schalter

`const GALAXIE_ZIEL_AKTIV = true` ist die Grundstellung; Notaus `galaxieziel` in `NOTAUS_NAMEN`
der Rückwärtsgang ohne Deploy. `spawnAktiv('galaxieziel')` gattert **Zählung, Auszahlung und
Transport** – eine Karte, die zählt, während nichts gezählt wird, wäre eine Anzeige-Falschaussage.
Ein am Wochenwechsel gesetzter Notaus schließt die Woche ohne Auszahlung (Protokollvermerk).

## Auslieferung

**Backend zuerst, Frontend unmittelbar danach.** Der Reward-Typ `galaxie-ziel` ist neu: Ein
Client ohne den Zweig in `claimPendingRewards` meldet „Dankeschön vom Team: +… Kredite für deinen
Bug-Report" und bucht die Kredite in den Rückfall. Bis zur ersten Auszahlung (frühestens der
nächste Montag) muss der Frontend-Zweig live sein. Bis dahin sieht ein alter Client nur ein
harmloses Zusatzfeld `galaxieZiel` in `/api/galaxy` – keine Karte, keine Meldung.

## Wächter

`tests/test_galaxie_ziel_http.js` (Port 3273): Ziel entsteht mit Wochenschlüssel und Formel,
Client-Form ohne fremde Beiträge, `/api/health`; Nestschlag zählt, abgelehnter Schlag nicht,
Erreichen mit News und Chronik, Tagesdeckel je Spieler; PUT `/api/storage/galaxieZiel?shared=true`
wirkungslos; falsche Art zählt nicht; Wochenwechsel zahlt nur Beitragende, nur bei `erreichtAm`,
nur einmal, mit Staub am Nutzer; Notaus nimmt Anzeige und Zählung. Gegenprobe per
`KEPLER_GZ_SABOTAGE=zaehlung|deckel|auszahlung|staub|transport|notaus` auf einer Kopie – die
gemessenen Listen stehen im Dateikopf. Frontend: `tests/test_galaxie_ziel.js` (Karte, Reward-Zweig,
Bericht, Hilfe, Paritäts-Prüfung der Symbole und Zahlen gegen diese `server.js`).

## Bekannte Grenzen

- Verbandsangriffe (`/api/musterattack/resolve`) zählen nicht – die Spec nennt die vier
  Einzelrouten; ein Verband müsste je Teilnehmer zählen und wäre eine eigene Entscheidung.
- `chronikVermerken` trägt die Felder über den Eintrag; ein Feld `art` überschriebe die Sorte des
  Eintrags selbst (gemessen: der erste Entwurf schrieb `art:'nestschlaege'` statt
  `'galaxie-ziel-erreicht'`). Deshalb heißt das Feld `zielArt`.

**Nachtrag 11.09.2026:** Das Client-Feld heißt `kommandanten`, nicht `beitragende` – `test_randkriege_handlungen_http.js` Prüfung 8 verbietet den Schlüssel `"beitragende"` im gesamten `/api/galaxy`-JSON (Wache gegen die Beitragendenliste der Fronten), und die Wache soll pauschal bleiben.
