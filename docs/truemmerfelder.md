# Trümmerfelder als geteiltes Ziel (Etappe T1–T3)

**Auftrag Sascha (wörtlich, 07.09.2026):** „wenn an einem planet ein trümmerfeld ist auch in der
map anzeigen und das andere spieler auch recyler dahin schicken können."
Gewählt per Auswahl: **„Beides zusammen"** (Backend und Frontend als volles Feature) und
**„Offen wie das Vorposten-Lager"** (jeder sieht Ort und Menge).

## Der Befund, der den Zuschnitt bestimmt hat

Vor dieser Etappe waren Trümmerfelder **rein klientenautoritativ**:

| gemessen am 07.09.2026 | Ergebnis |
|---|---|
| `state.debrisFields` im Frontend | Zeile 21871, im Spielstand — neben `colonyNames` |
| `grep -c "debris" server.js` | **0** |
| `grep -ci "trümmer\|truemmer" server.js` | 1 (ein Kommentar) |

Das Backend kannte Trümmerfelder also **überhaupt nicht**. „Andere Spieler schicken Recycler
hin" war damit keine Anzeige-Frage, sondern ein neues geteiltes Objekt mit allem, was daran
hängt: Wo es wohnt, wer es schreiben darf, wer entscheidet, was ankommt.

## Wo das Feld wohnt: `db.galaxy.truemmer`, nicht der geteilte Speicher

**Der generische Shared-Storage (`PUT /api/storage/:key?shared=true`) ist für jeden eingeloggten
Nutzer offen.** Läge das Trümmerfeld dort, könnte sich jeder eines erfinden und es anschließend
selbst bergen — eine Rohstoffquelle aus dem Nichts. Es wohnt deshalb in `db.galaxy`, das für
Clients gar nicht erreichbar ist, wie Nester, Konvois und die Sektorlage.

Form (ein Eintrag je Standort):

```
db.galaxy.truemmer["<uid>:<standort>"] = {
  uid,                    // wem der Standort gehoert
  standort,               // 'home' oder ein Kolonien-/Mondschluessel
  erz, kristalle,         // was dort liegt
  seit,                   // wann es entstanden ist
  schlaege: { <uid>: ts } // Abklingzeit AM ZIEL, nie im Spielstand
}
```

**Warum der Schlüssel `<uid>:<standort>` ist und nicht ein Systemname:** Ein Standort ist im
ganzen Spiel als Paar `(targetUserId, targetPlanet)` identifiziert — genau so nimmt `/api/attack`
sein Ziel entgegen (`docs/pvp-standorte.md`). Ein Kolonieschlüssel IST eine Planeten-Id, und die
Frontend-Tabelle `PLANETS` trägt zu jeder Id ihr `system`. Der Server muss die Zuordnung
Planet → System deshalb **nicht kennen und nicht kopieren**; die Karte löst sie selbst auf. Das
spart eine Kopie-Familie, die sonst still auseinanderliefe.

## Wer das Feld erzeugt: der Server beim Kampf, niemand sonst

Trümmer entstehen **ausschließlich** dort, wo der Server ohnehin schon Verluste ausrechnet — im
Sieg- und im Niederlagenzweig von `/api/attack`. Der Client meldet nichts; eine gemeldete
Trümmermenge wäre eine Zahl, die sich der Spieler selbst ausdenkt.

Die Formel ist eine **Kopie-Familie mit dem Frontend** und dort seit Langem in Gebrauch:

```
gewicht  = Σ (zerstoerte Schiffe je Typ) × SHIP_SCORE_WEIGHTS[typ]
menge    = round(gewicht × TRUEMMER_JE_GEWICHT)      // TRUEMMER_JE_GEWICHT = 3
erz      = round(menge × 0.6)
kristalle= round(menge × 0.3)                        // die fehlenden 10 % verglühen, seit jeher
```

`SHIP_SCORE_WEIGHTS` liegt bereits in beiden Repos und steht in `CLAUDE.md` als Kopie-Familie.
`TRUEMMER_JE_GEWICHT` kommt neu dazu und gehört ab jetzt in dieselbe Liste.

## Wer bergen darf, und wie das entschieden wird

`POST /api/truemmer/bergen { uid, standort, recycler }`

- **Der Server ist Autorität für alles**, was ankommt: Er liest die Recycler-Zahl aus dem
  **gespeicherten Spielstand** des Anfragenden, nicht aus dem Request — dieselbe Regel wie bei
  `/api/attack`, das keinen Kampfparameter aus dem Request nimmt.
- **Abklingzeit am ZIEL** (`feld.schlaege[uid]`), nie im Spielstand. Sonst wäre sie durch einen
  bearbeiteten Spielstand wegzuräumen.
- **Der Besitzer des Standorts hat keinen Vorrang und keine Sperre.** Ein Feld vor der eigenen
  Tür bergen ist derselbe Vorgang; es ist nur schneller, weil kein Flug anfällt.
- Die Beute geht über `pushPendingReward(uid, { type: 'truemmer-bergung', … })` mit **eigenem
  `type`** — der Frontend-Zweig dazu gehört zwingend in denselben Auftrag. Genau dieser Zweig hat
  beim Vorposten-Abbau einmal gefehlt, und eine ganze Garnison ist still verfallen.

## Der Deckel löscht nichts

Ein Feld wächst nicht unbegrenzt: Über `TRUEMMER_DECKEL` hinaus wird **nichts mehr addiert** —
aber nie etwas abgezogen. Ein Deckel, der Bestehendes wegräumt, hat in diesem Projekt schon
einmal Spielerbesitz vernichtet.

Alte Felder verfallen über `TRUEMMER_LEBENSDAUER_MS`, und zwar **beim Tick**, nicht beim Lesen —
sonst hinge das Verschwinden davon ab, wer zufällig hinsieht.

## Notaus

`TRUEMMER_AKTIV = false` bis das Frontend live ist. Umgelegt wird der Schalter im
**Frontend-PR**, nicht hier: Solange das Spiel das Feld `truemmer` nicht liest, entstünden
Felder, die niemand sehen und bergen kann — genau der Fehler, den das Sternendock (V6) gerade
vorgeführt hat. Der Admin kann den Schalter zur Laufzeit nur AB-, nie einschalten (`db.notAus`).

## Etappen

| | Inhalt | Repo |
|---|---|---|
| **T1** | `db.galaxy.truemmer`, Entstehung im Kampf, Auslieferung an alle Clients, Bergungs-Endpunkt, Notaus | Backend |
| **T2** | Kartenmarker am Planeten, Bergungsmenü, Belohnungszweig `truemmer-bergung`, Schalter umlegen | Frontend |
| **T3** | Recycler-**Flug** zu fremden Standorten mit echter Flugzeit statt Sofortbergung | beide |

T3 ist bewusst getrennt: Ein Flug braucht eine Mission mit Ankunftszeit, und Missionen sind im
Spiel klientenautoritativ. Ihn zusammen mit T1/T2 zu bauen hieße, zwei ungelöste Fragen
gleichzeitig zu beantworten.

## Was das für Angreifer bedeutet (Entscheidung Sascha: offen)

Ein sichtbares Trümmerfeld verrät: *hier hat gerade jemand eine Flotte verloren*. Das ist
gewollt und folgt der Regel, die beim Vorposten-Lager schon gilt — „wer stürmt, soll riechen
können, wo sich der Flug lohnt". Ein Trümmerfeld wird damit zugleich Anreiz und Warnung: Es lockt
Bergungsflüge an und sagt Angreifern, dass die Verteidigung dort eben Federn gelassen hat.
