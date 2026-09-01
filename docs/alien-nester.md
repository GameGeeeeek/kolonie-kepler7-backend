# Alien-Nester (Phase 3 bis 6): Nester, NPC-Stärke, Verbandsangriff, PvE-Embleme

Verschoben aus `CLAUDE.md` am 01.09.2026 (Strukturprüfung, Punkt 1: Startkontext verkleinern). Wortlaut unverändert; Querverweise wie „unten" oder „oben" beziehen sich auf die frühere Reihenfolge in `CLAUDE.md`. Neue Erkenntnisse zu diesem Bereich gehören ab jetzt hierher, nicht in `CLAUDE.md`.

## Alien-Nester (Phase 3, 18.08.2026)

Das Gegenstück zu den Festungen: Die Festung **steht** und drosselt, das Nest **wächst** und breitet
sich aus. Wer nichts tut, hat übermorgen mehr davon als heute.

**`NEST_SPAWN_AKTIV` steht seit dem 19.08.2026 auf `true`** – das Frontend der Phase 3 ist
ausgeliefert (v8.582.0), und damit ist die Bedingung erfüllt, unter der er auf `false` stehen
musste. Karte, Kartenmenü, Angriffsmission, Bericht und Hilfetext stehen.

**Der Schalter bleibt trotzdem stehen** – als Notausschalter, aus demselben Grund wie die beiden
Festungs-Schalter. `test_alien_nester_http.js` 11c prüft jetzt, dass er auf `true` steht; ein
Wechsel auf `false` ist damit eine bewusste Notabschaltung, die auffällt statt still zu
geschehen – und ihr Grund gehört dann hierher.

Warum er überhaupt gebaut wurde, bleibt als Begründung wichtig: Solange er aus war, kehrte
`nestTick()` in der ersten Zeile zurück und der ganze Abschnitt tat nichts. Ging dieses Backend
allein live, entstünden Nester, die niemand sieht und niemand angreifen kann – dieselbe
Begründung wie bei den beiden Festungs-Schaltern.

**Wo sie wohnen: `db.galaxy.alienNester`.** Das ist keine Geschmacksfrage. `db.galaxy` ist für
Clients über `PUT /api/storage/:key` **gar nicht erreichbar** – anders als der Weltboss, dessen
Schlüssel `worldboss:current` im geteilten Speicher liegt und deshalb eigens abgesichert werden
musste. Die Nester dorthin zu legen umgeht diese ganze Fehlerklasse von vornherein. Nebeneffekt,
der Arbeit spart: `galaxyFuerClient()` macht `Object.assign({}, g, …)` – alles aus `db.galaxy`
geht damit automatisch an den Client, ohne eine Zeile Verdrahtung.

**Die LP sind gegen die BEREITS KALIBRIERTEN FESTUNGEN gerechnet, nicht gegen eine neue
Referenzflotte** – und der erste Anlauf tat genau das Falsche. Frisch zusammengestellte Flotten
lieferten 1.196 / 12.144 / 63.997 Schlagkraft; gegen die bräuchte die Sternenfeste 18,8
Endspiel-Schläge statt der 5, mit denen sie ausgeliefert ist. **Der Maßstab war ein anderer**
(Forschung, Marken, Haltung steckten in der Festungs-Kalibrierung drin), nicht die Zahl. Gegen den
richtigen Maßstab (7.500 / 44.000 / 240.000 je Schlag):

| Ziel | Einsteiger | Mittelfeld | Endspiel | × Sternenfeste |
|---|---|---|---|---|
| Sporenherd 40k | 5,3 | 0,9 | 0,2 | 0,03 |
| Brutkammer 120k | 16,0 | 2,7 | 0,5 | 0,10 |
| Schwarmstock 400k | 53,3 | 9,1 | 1,7 | 0,33 |
| Hochnest 1,2 Mio | 160,0 | 27,3 | 5,0 | 1,00 |
| Königin 4 Mio | 533,3 | 90,9 | **16,7** | 3,33 |

Die Konzept-Zahlen halten damit alle stand – der Sporenherd ist das Gegenstück zur Schanze, das
Hochnest exakt die Sternenfeste. **Falsch ist nur der Satz daneben:** Das Konzept sagt, die Königin
sei „mit 40 Endspiel-Schlägen ausgelegt"; gemessen sind es 16,7. Bei 4 Stunden Abklingzeit je
Spieler heißt das drei Kommandanten an einem Tag oder eine Allianz an einem Abend – näher am
beschriebenen Gefühl als vierzig Schläge (Frontend-Arbeitsregel 41).

### Vier Entscheidungen, die man kennen muss

1. **Der Takt liegt im `galaxyTick`, nicht lazy beim Lesen** – anders als der Hort der Festung. Der
   Unterschied hat einen Grund: Der Hort ist ein Zähler, den nur der Leser sieht; ein Nest
   **verändert die Galaxie** (es reift, breitet sich aus, bringt eine Königin hervor), und diese
   Ereignisse gehören in den Weltentakt. Sonst hinge die Weltlage daran, wer wie oft die Karte
   öffnet.
2. **Ein reifendes Nest HEILT NICHT.** `lp` steigt um dieselbe Differenz wie `lpMax`, angerichteter
   Schaden bleibt angerichtet. Heilte es voll, wäre jeder Schlag davor wertlos – und Warten die
   beste Strategie für den Schwarm statt für den Spieler. Gegenprobe gemessen: mit `lp = lpMax`
   fällt `10c` mit `{"lp":96000,"erwartet":74000}`.
3. **Die Abklingzeit liegt AM NEST** (`nest.schlaege[userId]`), nicht im Spielstand – dieselbe
   Entscheidung wie bei der Festung und aus demselben Grund. Die Gegenprobe ist die Messung, die
   die beiden Ablageorte überhaupt unterscheidet: Mit der Sperre im Spielstand gibt ein gelöschtes
   Feld den nächsten Schlag sofort frei (gemessen: 200 statt 403, 31.113 Schaden).
4. **„Weitergezogen" und „gefallen" kosten NICHTS** – keine Verluste, keine Abklingzeit, und die
   Antwort nennt den **Grund**. Ein stilles `ok` wäre hier die Falschaussage, vor der dieses
   Projekt seine Anzeigestellen schützt. Das ist zugleich die Eigenart der Nomaden von Vex: ein
   Ziel, das man verlieren kann, wenn man zu lange zögert.

**Die Königin reißt den ganzen Schwarm ihres Volkes mit** und setzt eine 72-Stunden-Pause. Das ist
die Ausschüttung, auf die eine Allianz hinarbeitet – und der Grund, warum Wachsenlassen eine echte
Entscheidung ist statt einer Formalität: Wer früh räumt, zahlt wenig und bekommt wenig.

**Die Volksnamen sind eine KOPIE-FAMILIE.** `ALIEN_VOELKER[*].name` muss wörtlich zu
`ALIEN_RACE_NAMES` passen – darüber läuft die Zuordnung zwischen dem vorhandenen „Volk
entdeckt"-Ereignis und seinem Nestbestand. Eine Umbenennung auf einer Seite bricht sie still;
`tests/test_alien_nester_http.js` 1a hält beide zusammen.

### Der Test und zwei Lehren aus ihm

`tests/test_alien_nester_http.js` (Port 3224, **40 Prüfungen, fünf Gegenproben** – Schwächenfaktor,
angekommener Schaden, Heilung beim Reifen, Ablageort der Abklingzeit, Schwarm-Zerfall; alle in
beide Richtungen gefahren, überall dieselbe Anzahl gelaufener Prüfungen). **Belegte Testports sind
jetzt 3195–3200, 3210–3223 und 3224** – ein neuer Test nimmt 3225.

**Der Test startet eine KOPIE von `server.js` mit umgelegtem Schalter.** Anders ginge es nicht:
Solange `NEST_SPAWN_AKTIV` aus ist, tut `nestTick()` nichts, und der halbe Test hätte keinen
Gegenstand. Die Kopie liegt im Repo-Verzeichnis (damit `require('./mailer')` auflöst) und wird im
`process.on('exit')` weggeräumt. Damit misst er den echten Code mit genau der einen Zeile, die
später ohnehin umgelegt wird – und er bleibt grün, egal wie der Schalter committet ist.

Zwei Fallen, die je einen Anlauf gekostet haben:

- **Ein `grep` nach `schwaeche:` trifft zwei Tabellen.** Die Namensprüfung suchte ungescopt und fand
  neun Namen statt vier – die fünf zusätzlichen waren **Weltboss-Archetypen**, die dasselbe Feld
  führen. Der Fehlschlag meldete sie als „fehlende Völker". Frontend-Arbeitsregel 39, hier im
  Backend: Jede Suche nach einem Eintrag gehört auf den Block ihrer Tabelle gescopt, und der Anker
  des Blocks gehört selbst geprüft.
- **Eine Prüfung darf nicht an einer Momentaufnahme hängen.** `7c` verlangte zuerst GENAU ein
  übriges Nest und fiel an einem Zufall: Der `galaxyTick` entdeckt mit 6 % je Takt ein neues Volk,
  und der Nachschub-Zweig legt ihm sofort ein Nest an – völlig korrektes Verhalten, das mit dem
  Königinnen-Fall nichts zu tun hat. Geprüft wird jetzt die REGEL („kein Nest des gefallenen
  Volkes, das fremde steht noch"), und kein Zugriff im Test greift mehr über `[0]`.

**Und eine dritte, die den Test selbst betraf** (Frontend-Arbeitsregel 34): Der Spielstand liegt in
`db.private` in **zwei** Formen vor – als blanke Zeichenkette oder als `{ value, version }`, weil
`setSaveValue()` die zweite schreibt. Der erste Entwurf nahm nur die erste an und **starb** an
einem `JSON.parse('[object Object]')`, sobald eine Gegenprobe den Server dazu brachte, den
Spielstand zu schreiben – 10 statt 40 Prüfungen, und der rote Exit-Code sah aus wie eine gelungene
Gegenprobe. Seither lesen `liesSave()`/`schreibSave()` beide Formen, und die Gegenprobe zum
Ablageort der Abklingzeit lässt sich überhaupt erst fahren.

## Die galaktische Gegnerstärke wird beweglich (Phase 4, 19.08.2026)

`npcEmpireStrength` wuchs bis hierher monoton bis 2,5 und blieb dort – ein Schwierigkeitsregler,
den niemand bewegen kann. Neu leitet der `galaxyTick` einen **Zielwert** aus dem Nestbestand ab und
lässt den Ist-Wert dorthin driften: Wer aufräumt, macht die Galaxie für alle leichter; wer die
Nester wachsen lässt, bezahlt es mit härteren NPC-Gegnern.

**Die Drift läuft NUR, wenn `NEST_SPAWN_AKTIV` an ist – und das ist keine Vorsicht, sondern
gemessen.** Ohne Nester ist die Stufensumme 0, der Zielwert wäre die Basis, und die
NPC-Verteidigung fiele sofort um 44 % – allein dadurch, dass diese Phase gemergt wird, während
Phase 3 noch schläft. Steht der Schalter aus, bleibt deshalb das alte monotone Wachstum.
`test_npc_staerke_http.js` 3a misst genau das; die Gegenprobe mit ausgebautem Tor lässt sie fallen.

**Die Basis ist die KONSERVATIVE Variante** (das Konzept führt sie in 11.2 als offene
Entscheidung), gerechnet gegen den bisherigen Stand 2,5:

| Lage | Stufensumme | Konzept (1,0 + 0,080) | gewählt (1,4 + 0,046) |
|---|---|---|---|
| geräumt | 0 | 1,00 (−60 %) | **1,40 (−44 %)** |
| ruhig (4 Nester Stufe 2) | 8 | 1,64 (−34 %) | 1,77 (−29 %) |
| angespannt (8 Nester Stufe 3) | 24 | 2,50 (±0) | 2,50 (±0) |

Beide Kurven enden am selben Deckel, aber **nicht bei derselben Dichte**: Die Konzept-Kurve ist
schon bei 18,75 Stufenpunkten oben, die gewählte erst bei 23,9. Der eigentliche Unterschied liegt
am unteren Ende, und genau dort steht der Spieler **am Tag der Umstellung**, wenn es null bis ein
Nest gibt – die Konzept-Basis verschenkte in den ersten 19 Stunden 60 % der NPC-Verteidigung, ohne
dass jemand etwas dafür getan hätte. **Hier stand im ersten Entwurf „beide treffen den Deckel bei
Stufensumme 24" – das war aus der Tabellenzeile abgelesen statt gerechnet** (die Zeile zeigt nur,
dass beide dort bereits gedeckelt SIND). Frontend-Arbeitsregel 41 an einer eigenen Zahl.

**4 % Annäherung je Tick** (96 Ticks/Tag): halber Abstand nach 4,2 h, 95 % nach 18,3 h. Die Galaxie
reagiert innerhalb eines Tages sichtbar, aber ein einzelner Angriff schaltet die Weltlage nicht um.

**`g.npcStaerkeZiel` reist über `galaxyFuerClient()` zum Client** – und wird **nur im Tor-Zweig
geschrieben**. Ein Server ohne wirkende Drift führt das Feld also GAR NICHT; das Frontend kann
daran erkennen, dass es nichts zu behaupten gibt, statt eine Weltlage anzuzeigen, die nirgends
gilt. `test_npc_staerke_http.js` 4a hält diese Richtung fest, 4b die andere.

**Kein Helfer `nestStufen(n)` neben `nestStufe(zahl)`.** Der erste Entwurf hatte einen – ein
Buchstabe Unterschied, und das eine nimmt ein Nest-OBJEKT, das andere eine Stufenzahl. Genau die
Sorte Namenspaar, die später jemand verwechselt; die Summe steht deshalb ausgeschrieben in
`nestStufenSumme`.

**Beim Anfassen mitgenommen: die erfundene Begründung beim Wandern.** `nestTick` leerte beim
Weiterziehen eines Nomaden-Nestes die Abklingzeiten (`n.schlaege = {}`) mit dem Kommentar „die
Abklingzeit hängt am ORT, nicht am Nest". Das ist beim Schreiben erfunden worden und widerspricht
dem Entwurf: Die Sperre hängt am NEST, und das Nest ist nach dem Wandern dasselbe Nest. Praktisch
folgenlos (Wanderung alle 12 h, Abklingzeit 4 h – sie wäre ohnehin abgelaufen), aber es ist genau
die Sorte Kommentar, die beim nächsten Lesen als REGEL gelesen wird. Zeile und Kommentar sind weg.

### Der Test

`tests/test_npc_staerke_http.js` (Port 3227, 14 Prüfungen, **drei Gegenproben** – Tor, Sprung statt
Drift, fehlender Deckel; alle in beide Richtungen gefahren, überall dieselben 14 Prüfnamen, per
`diff` verglichen statt gezählt). **Belegte Testports sind jetzt 3195–3200 und 3210–3227** – ein
neuer Test nimmt 3228.

Er startet **zwei** Kopien von `server.js`, eine je Schalterstellung. Der Gegenstand ist ein
Schalter; beide Stellungen gehören gemessen, und welche gerade committet ist, darf das Ergebnis
nicht verschieben.

**Die wichtigste Zeile des Tests ist `einfrieren()`** – vier Riegel, einer je Zweig des `nestTick`:
`letzteReifung` auf jetzt (reift nicht), `naechsterWurf` und `naechsteWanderung` weit in die
Zukunft, und `alienPause` für **alle vier** Völker. Der letzte ist der unauffälligste und der
nötigste: Der `galaxyTick` entdeckt mit 6 % je Takt ein neues Volk, und der Nachschub-Zweig legt
ihm sofort ein Nest an – die gemessene Eingabe wäre also mitten in der Messung eine andere. Genau
daran ist im Nest-Test schon einmal eine Prüfung an einem Zufall gescheitert.

**Die Erwartung wird im Test neu gerechnet, die Eingabe dagegen BEOBACHTET** (Nestliste aus der DB
nach dem Tick). Eine Erwartung, die aus derselben Rechnung stammt wie das Ergebnis, kann nicht
fehlschlagen – Frontend-Arbeitsregel 62.

## Verbandsangriff auf ein Alien-Nest (Phase 5, 21.08.2026)

Der koordinierte Musterangriff konnte bisher nur eine fremde **Allianzbasis** treffen. Neu trägt
sein Dokument eine `zielArt`; mit `'alien-nest'` fällt der halbe Prüflauf darunter weg – nicht aus
Bequemlichkeit, sondern weil ein Nest keine Allianz, keine Basis, kein `incomingmuster`-Dokument
und keinen Schutzschild hat.

**Es gibt keinen eigenen Schalter.** `NEST_SPAWN_AKTIV` gilt mit: Ohne Nester existiert kein Ziel,
`create` antwortet mit 404, und der ganze Zweig ist unerreichbar.

### Die Sicherheitsstelle, und warum sie eine ist

`resolve` darf ausnahmsweise auch der VERTEIDIGER auslösen – deshalb prüft es Mitgliedschaft in
`tag` **oder** in `doc.targetTag`. Ein Nest hat kein `targetTag`. Und `allianceRoleOf` baut seinen
Schlüssel per **Zeichenkettenverkettung**:

```js
const raw = db.shared['alliance:' + tag + ':role:' + userId];
```

Mit `null`/`undefined` entsteht daraus wörtlich `alliance:null:role:<uid>` – ein Schlüssel, der wie
ein ganz normaler Rolleneintrag aussieht. Wer einen solchen anlegen kann, dürfte damit **jeden**
Nest-Verbandsangriff auflösen.

**Behoben nicht durch eine Null-Prüfung, sondern durch eine Verzweigung davor:** Bei
`zielArt === 'alien-nest'` wird der Verteidiger-Zweig gar nicht erst betreten. Ein Nest hat keinen
Verteidiger, also gibt es auch keine Verteidiger-Rolle zu prüfen.
`tests/test_muster_nest_http.js` 2c **legt dem Außenstehenden genau diese zwei Schlüssel an** und
verlangt trotzdem 403 – die Gegenprobe ohne den Zweig lässt ihn auflösen. Das ist die Grenze, die
dieses Projekt überall verteidigt („kann ich etwas anfassen, das ANDEREN gehört?"), hier auf das
Auflösen eines fremden Verbandsangriffs angewandt.

### Der gemeinsame Kern – und wo seine Naht liegt

`nestSchlagAusfuehren(g, nest, kraft, composition, beteiligte, jetzt)` wird von BEIDEN Wegen
benutzt (Einzelangriff und Verband). Eine zweite Kopie der Schadensrechnung wäre die übliche
zweite Wahrheit – dieselbe Antwort wie bei `astFreiePlaetze`.

Zwei Entscheidungen an der Schnittstelle, beide aus dem Unterschied der zwei Wege:

- **Rein geht die KRAFT, nicht der Spielstand.** Der Einzelangriff bildet sie aus dem Spielstand
  des Angreifers; ein Verband hat **keinen einen Spielstand** – seine Kraft steht seit dem Beitritt
  fest (`doc.dispatch.totalPower`, je Mitglied gemessen und summiert). Sie hier neu zu bilden hieße,
  sie aus dem Spielstand eines einzelnen Mitglieds zu raten.
- **Raus kommen die Verluste als QUOTE, nicht als Stückzahlen.** Der Server schreibt fremde
  Spielstände nicht; jeder Client wendet sie auf SEINEN Beitrag an – dasselbe Muster wie bei der
  Basisangriffs-Auflösung (`ownLossPct`).

### Drei Entscheidungen, die nur der Verband kennt

1. **Abklingzeit und Beitrag gehen an ALLE Teilnehmer**, gewichtet nach ihrer beim Beitritt
   gemessenen Kraft. Nur den Auslöser gutzuschreiben machte den Hort-Anteil zur Frage, wer zufällig
   auf den Knopf drückt – und ein Verbandsschlag gäbe danach den nächsten Einzelschlag sofort frei.
   Gemessen (`4c`): Anna 18.967 Kraft gegen Bens 6.044 ergibt Beiträge von 19.665 zu 6.267, während
   **Ben** ausgelöst hat.
2. **Die Teilnehmer kommen aus dem VERSAND, nicht aus den Beitritts-Dokumenten.** `checkdispatch`
   friert sie als `dispatch.participants` ein. Ein Beitritt lässt sich bis zum Abflug zurückziehen;
   beim Auflösen erneut zu lesen wäre eine zweite Quelle, die inzwischen eine andere sein kann. Für
   Dokumente aus der Zeit davor gibt es einen Rückfall auf `participantIds` (dort zählen alle
   gleich, weil ihre Einzelkräfte nicht mitgeschrieben wurden).
3. **`claim` gibt bei einem Nest NUR die Schiffe zurück** und zahlt die Basisangriffs-Währung
   nicht. Die Nest-Belohnung liegt bereits anteilig in `__pendingRewards` (über den gemeinsamen
   Kern) – beides zu zahlen wäre eine Doppelzahlung für dasselbe Ereignis. Gegenprobe: mit
   ausgebautem Zweig fällt `5b`.

### Der Test

`tests/test_muster_nest_http.js` (Port 3228, **22 Prüfungen, drei Gegenproben** – Rechteprüfung,
Beitrags-Verteilung, Doppelzahlung; alle in beide Richtungen gefahren, überall dieselben 22
Prüfnamen). **Belegte Testports sind jetzt 3195–3200 und 3210–3228** – ein neuer Test nimmt 3229.

Zwei Fallen, die je einen Anlauf gekostet haben und beide schon dokumentiert waren:

- **`ALLIANCE_MUSTER_TEST_MODE` liest `ALLIANCE_RAID_TEST_MODE`** (derselbe Schalter wie beim
  Raid). Wer den naheliegenden Namen setzt, bekommt „Ungültige Anfrage" – die Sammeldauer 2 s steht
  nicht in `ALLIANCE_MUSTER_DURATIONS`.
- **Der Spielstand liegt in ZWEI Formen vor** (blanke Zeichenkette oder `{ value, version }`).
  Der Test starb beim Aufbau seiner Messvorrichtung an `JSON.parse('[object Object]')`, sobald
  `claim` den Spielstand geschrieben hatte – und führte die restlichen Prüfungen nie aus
  (Frontend-Arbeitsregel 34). Genau derselbe Anlauf wie beim Nest-Test; seither hat auch dieser
  Test ein `liesSave()`.

Und eine dritte, die den Wert des Protokolls zeigt: Vor der Behebung waren `5b` und `5c` **grün,
aber aus dem falschen Grund** – `claim` hatte mit 404 geantwortet, es war also gar nichts passiert
(Frontend-Arbeitsregel 28). Erst als die Kette lief, haben sie etwas gemessen.

## Zwei PvE-Meilenstein-Embleme (Phase 6, 21.08.2026)

`em_festungsbrecher` (25 geschleifte Asteroidenfestungen) und `em_schwarmbrecher` (eine gefallene
Alien-Königin). Der Kosmetik-Katalog kannte bis dahin keinen einzigen Weg über die neuen PvE-Ziele.

**Die Zähler liegen am NUTZEROBJEKT (`user.pveKills`), nicht im Spielstand** – dieselbe
Entscheidung wie bei `staub.abwehrGesamt` und aus demselben Grund: Ein Emblem steht in der
BESTENLISTE, also auf einer Fläche, die allen gehört. Der Spielstand ist klientenautoritativ; ein
Zähler darin wäre in fünf Sekunden gefälscht.

**Gezählt wird dort, wo der Server das Ereignis SELBST beobachtet** – beim Fall einer Festung und
beim Fall einer Königin, und zwar für **jeden Beitragenden**. Wer ein Drittel des Schadens getragen
hat, hat die Festung genauso geschleift wie der, der zufällig den letzten Schlag führte; das ist
dieselbe Überlegung, die den Hort anteilig auszahlt. Beide Zähler wachsen nur und gehören deshalb
**nicht** in `kosmetikBefristet()`.

**Die Schwellen sind gerechnet, nicht geschätzt.** Eine Festung braucht vier bis sieben Schläge bei
6 h Abklingzeit, also ein bis zwei Tage für EINE – 25 Stück sind damit ein Ziel über Wochen,
vergleichbar mit `em_schaedel` (30 Sektor-Bosse). Die Königin zählt bewusst **einmal**: Sie
erscheint erst ab vier Nestern eines Volkes, fällt mit 4 Mio LP praktisch nur im Verband und reißt
den ganzen Schwarm mit.

**Die Auslieferung muss mit dem Frontend zusammen erfolgen.** `tests/test_kosmetik_paritaet.js` im
FRONTEND-Repo vergleicht `KOSMETIK_DEFS` gegen `KOSMETIK_LOOK`; ein Stück, das nur eine Seite
kennt, lässt ihn fallen – in beide Richtungen. Das ist kein Mangel, sondern der Zweck des Tests.

Die 1f-Schleife von `test_kosmetik_http.js` deckt die zwei neuen Arten automatisch NICHT ab: Sie
filtert auf Bedingungsarten, die aus dem SPIELSTAND kommen (`ausSpielstand`), und diese beiden
kommen aus dem Nutzerobjekt – genau wie `kauf` und `abgewehrt`.

**Nachgemessen bei der adversarischen Prüfung des Änderungssatzes (21.08.2026), weil der Einwand
kam, die Zähler hingen letztlich an einer klientenautoritativen Flottenangabe.** Das stimmt für die
zugrundeliegende Schlagkraft und ist die dokumentierte Projektgrenze – aber die Einordnung fällt
zugunsten der neuen Bedingungen aus. Gemessen an `kosmetikBedingungErfuellt`, woher jede Art ihren
Wert nimmt:

| Nutzerobjekt (`findUserById`) | Spielstand (klientenautoritativ) |
|---|---|
| `kauf`, `abgewehrt`, **`festungen`**, **`koeniginnen`** | `prestige`, `aufstieg`, `kampfpunkte`, `abgrund`, `erfolge`, `bosse` |

**Sechs** bestehende Bedingungen lesen also direkt aus dem Spielstand – `em_schaedel` (30
Sektor-Bosse) ist der nächste Verwandte der zwei neuen und steht auf der schwächeren Seite. Die
Phase-6-Zähler sind damit besser verankert als die Nachbarn, die sie ergänzen; ein Handlungsbedarf
folgt daraus nicht.

**Ein Befund der Prüfung betraf allerdings das FRONTEND und war ein ausgelieferter Datenverlust:**
`POST /api/pending-rewards/claim` entfernt die Belohnung mit `list.shift()` + `saveDb()`, bevor sie
den Client erreicht – es gibt keinen zweiten Versuch. Die zwei Client-Zweige `festung` (v8.569.0)
und `alien-nest` (v8.582.0) riefen als EINZIGE der acht kein `save()`. Wer den Reiter nach dem
Spielstart schloss, verlor Hort, Protomaterie, Kampfpunkte, Erfahrung und Kredite endgültig.
Behoben im Frontend; Wächter dort `tests/test_belohnungen_speichern.js`. **Für dieses Repo folgt
daraus die Prüffrage bei jeder künftigen Warteschlange: Wer den Eintrag beim Ausliefern LÖSCHT,
verpflichtet den Empfänger zum sofortigen Speichern** – das gehört in die Beschreibung des
Endpunkts, nicht in die Erinnerung des Client-Autors.


