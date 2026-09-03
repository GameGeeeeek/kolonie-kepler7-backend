# Der Hort: der seltenste Expeditionsfund als serverweite Meldung

*Angelegt am 03.09.2026.*

Auftrag Sascha: „Füge Jackpot Funde ein wenn jemand einen seltenen Jackpot Fund findet soll eine
Server weite Nachricht als Laufschrift Banner angezeigt werden – Spieler X hat einen seltenen Fund
gemacht in der Expedition, er hat X gefunden."

## Warum der Server würfelt

Die Expedition wird **im Browser** ausgewertet; der Spielstand ist bauartbedingt klientenautoritativ.
Für den Fund selbst ist das in Ordnung — er landet ohnehin in einem Spielstand, den der Client
schreibt. Für die **Meldung an alle** ist es das nicht: `pushGalaxyNews` schreibt in die Weltlage,
die jeder Spieler sieht, und ein Banner, das jeder Client auslösen kann, ist ein Spam-Kanal.

Hier fällt deshalb die eine Entscheidung, die nicht gefälscht werden darf: **ob diese Expedition
einen Hort bringt.** Entscheidung Sascha, nach vorgelegter Abwägung.

## Gewürfelt wird beim Start, nicht beim Abschluss

Zwei gemessene Gründe:

1. Die Fundauflösung im Client (`checkMissions`) ist **synchron**. Ein `await` mitten darin wäre ein
   Eingriff in die Missionsschleife; so liegt die Zusage Minuten vor der Auswertung bereit und
   blockiert nichts.
2. Ein Aufruf **je Expedition** statt je Fund — rund 20 Anfragen pro Stunde und Spieler statt 15
   zusätzlicher.

**Ohne Server gibt es keinen Hort, aber auch keinen Bruch.** Der Client bekommt keine Zusage,
würfelt seine Fundleiter ohne die oberste Stufe und spielt normal weiter. Das ist der Preis der
Entscheidung „der Server würfelt", und er war beim Treffen bekannt.

## Die Chance hier ist nicht die Chance der Leiter

Beim Start ist noch nicht bekannt, ob die Expedition überhaupt einen Ressourcenfund bringt (44 % bei
Standard, 72 % bei der Schürfexpedition). Diese Bänder stehen im Frontend und werden hier bewusst
**nicht** gespiegelt — eine Kopie-Familie für einen einzigen Wurf wäre teurer als die Ungenauigkeit,
die sie beseitigt. Aus `HORT_START_CHANCE = 0.005` werden dadurch effektiv 0,22 % bis 0,36 % je
Ressourcenfund; das Ziel der Fundleiter sind 0,3 %.

## Was der Server dem Client nicht glaubt

| Feld | Behandlung |
|---|---|
| `res` | muss eine bekannte Fundressource sein, sonst `400`. `MARKET_RES_LABELS` plus Forschungspunkte |
| `mult` | wird auf 0,5 bis 5 **geklemmt** |
| Spielername | kommt aus dem Token (`req.username`), nie aus dem Rumpf |
| Betrag | rechnet der Server aus `HORT_BASIS` und `HORT_STREUUNG`, nicht der Client |

Das Klemmen des Multiplikators ist **keine** Sicherheitsgrenze — der Fund landet ohnehin in einem
klientenautoritativen Spielstand. Es ist eine **Anzeigegrenze**: Ohne sie stünde in der Weltlage,
die alle sehen, irgendwann eine Zahl mit zwölf Stellen.

## Warum es keinen neuen Kanal gibt

`db.galaxy.news` existierte bereits (Ringpuffer auf 40, `pushGalaxyNews(icon, text)`), reist über
`GET /api/galaxy` ohnehin alle zwei Minuten mit und wird vom Frontend schon gelesen. `db.galaxy` ist
für Clients **gar nicht erreichbar** — genau die Bauart, die CLAUDE.md für geteilte Daten ohne
eigene Rechteprüfung vorsieht. Vorbild ist die Kopfgeld-Meldung, die dieselbe Form hat.

Zwei Minuten Verzögerung sind für ein Ereignis, das den Vielspieler alle 22 Stunden trifft,
unerheblich — und ein eigener Poll hätte den Pi dauerhaft belastet.

## Schalter

`HORT_BANNER_AKTIV` steht ausgeliefert auf `false` und wird im **Frontend-PR** umgelegt, sobald das
Banner dort steht. Der Admin-Notaus `hort` (`db.notAus`) schaltet zusätzlich ab. Beide greifen,
**bevor** gewürfelt wird: Eine abgeschaltete Mechanik, die noch würfelt und nur nicht meldet, wäre
eine Abschaltung, die wie Normalbetrieb aussieht.

## Wächter

`tests/test_hort_meldung_http.js` (Port 3253), Abschnitte 1 bis 5, gefahren an einer Kopie mit
umgelegtem Schalter und hochgesetzter Chance — ein Test, der auf 0,5 % wartet, misst Geduld statt
Verhalten. Abschnitt 5 startet eine **zweite** Kopie mit ausgeschaltetem Schalter; nur dort lässt
sich messen, ob der ausgelieferte Zustand wirklich schweigt.

Fünf Sabotagen mit gemessener Pflichtliste: `offen` → `5a`; `ungeklemmt` → `3a`; `stumm` → `1c`;
`fremdres` → `3b`; `artlos` → `1c`.

## Die Meldung trägt eine Art, keinen erkennbaren Wortlaut

`pushGalaxyNews(icon, text, art)` nimmt seit dem 03.09.2026 ein optionales drittes Feld; die
Hort-Meldung setzt `art: 'hort'`. Ohne es müsste das Frontend sie am Satzanfang erkennen
(`/Seltener Fund/`) — genau die zufällige Momentaufnahme, vor der CLAUDE.md warnt: Eine
umformulierte Meldung bräche das Banner lautlos. Alle bestehenden Aufrufer bleiben unverändert und
liefern kein `art`.

**Zwei Messungen, die den Test verändert haben** — beide hätten ihn stumm gemacht:

- Die Weltlage ist **nie leer** und wächst während des Tests von selbst: Der Galaxie-Tick schreibt
  eigene Meldungen (Fronten, Kriege). Eine absolute Zählung misst dort den Tick, nicht den Hort;
  gezählt werden deshalb nur Einträge mit „Seltener Fund".
- Die Sabotage `offen` ließ zunächst **gar nichts** fallen. Sie entfernte die Schalterprüfung an der
  ersten Kopie — wo der Schalter ohnehin auf `true` steht, die Bedingung also nie zutrifft. Erst an
  der zweiten Kopie prüft sie etwas. Eine Gegenprobe ohne Wirkung hätte vorgetäuscht, der Schalter
  sei abgesichert.
