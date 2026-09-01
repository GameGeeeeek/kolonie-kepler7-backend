# Sicherheit: Passwort-Regeln und Sitzungs-Cookie

Verschoben aus `CLAUDE.md` am 01.09.2026 (Strukturprüfung, Punkt 1: Startkontext verkleinern). Wortlaut unverändert; Querverweise wie „unten" oder „oben" beziehen sich auf die frühere Reihenfolge in `CLAUDE.md`. Neue Erkenntnisse zu diesem Bereich gehören ab jetzt hierher, nicht in `CLAUDE.md`.

## Passwort-Regeln beim SETZEN (19.08.2026, Sicherheits-Audit P5)

`passwortProblem(passwort, username)` ist die EINE Wache für neu gesetzte Passwörter. Sechs Regeln:
Mindestlänge 8, Abgleich gegen `passwoerter-bekannt.txt`, lauter gleiche Zeichen, reine
Ziffernfolgen, der eigene Spielername, der Name des Spiels.

**Die wichtigste Eigenschaft ist, wo sie NICHT aufgerufen wird: niemals im Login.** Wer ein
6-Zeichen-Passwort hat, meldet sich weiter damit an – eine neue Regel begrenzt das HINZUFÜGEN, nie
den Bestand. Das ist dieselbe Überlegung wie bei „Deckel dürfen niemals Daten löschen", nur auf eine
Zugangsregel angewandt, und sie wiegt hier schwerer: Ein ausgesperrtes Konto kommt nur über einen
Reset zurück, den man per E-Mail erst anfordern muss. Die vier `bcrypt.compare`-Stellen bleiben
unberührt; aufgerufen wird an den zwei `bcrypt.hash`-Stellen (Registrierung Z. ~1725, Reset ~2049).

**Der Testbestand ist der lebende Beleg dafür:** ACHT bestehende Tests legen ihren Nutzern per
`bcrypt.hashSync('test1234')` ein Passwort in die DB, das auf der Liste STEHT – und melden sich
weiterhin an. Wäre die Prüfung fälschlich im Login gelandet, wären sie alle acht rot.

**Die Liste enthält bewusst nur Einträge ab 8 Zeichen.** Kürzere fängt die Längenregel ohnehin ab,
bevor die Liste befragt wird; von den 10.000 der Quelle (SecLists, MIT) bleiben so 2.086 wirksame,
plus einer deutschen Ergänzung – die englische Liste kennt `passwort123` nicht. **Wer die
Mindestlänge je senkt, muss die Liste neu aus der Quelle ziehen**, sonst fehlen ihr genau die
kurzen Passwörter, die dann wieder erlaubt wären.

**Fehlt die Datei, läuft der Dienst weiter** und protokolliert es laut. Das ist bewusst anders
entschieden als bei `API_KEY` in AI Core (Befund A desselben Audits), und der Unterschied ist der
Grund: Dort WAR die Konfiguration die Sicherung, ihr Ausfall hob den ganzen Schutz auf. Hier ist die
Liste eine von sechs Regeln. Damit der Ausfall trotzdem nicht wie Normalbetrieb aussieht, ZÄHLT der
Test die Einträge, statt nur ihre Existenz zu prüfen.

**Die Prüfung im Reset steht HINTER `findUserById`** – nur so kennt sie den Spielernamen des Kontos
hinter dem Token. Der Token ist an der Stelle längst geprüft.

**Parität zum Frontend ist Pflicht.** Das Spiel prüft die Länge vorab (Komfort), die Liste bleibt
hier – eine Kopie im Frontend wäre eine zweite Wahrheit und 19 kB in einer Datei, die jeder Spieler
lädt. `tests/test_passwortregeln.js` im FRONTEND-Repo hält `PASSWORT_MIN` gegen die dortige Zahl;
läuft sie auseinander, entsteht genau die Abweichung, vor der das Auslöser-Video warnt.

`tests/test_passwortregeln_http.js` (Port 3223, 19 Prüfungen; **belegte Testports sind jetzt
3195–3200, 3210–3223** – ein neuer Test nimmt 3224). Zwei Lehren aus seiner Gegenprobe:

- **`qqqqqqqq` misst die falsche Regel** – jede achtfache Buchstaben-Wiederholung steht bereits auf
  der Liste, dort hätte also die Listen-Regel geantwortet. Aufgefallen ist es nur, weil die Prüfung
  den GRUND verlangt und nicht bloß den Statuscode. Sie misst jetzt `########`.
- **Ein einziger Reset-Token deckte vier Prüfungen zu.** Am alten Stand ging die erste durch und
  verbrauchte ihn dabei; die vier folgenden scheiterten danach an „Link ist ungültig" statt an dem,
  was sie messen wollten – vier Fehlschläge aus dem falschen Grund, die die Gegenprobe stärker
  aussehen ließen, als sie war. Jede Reset-Prüfung hat jetzt einen eigenen Token. **Übertragbar:
  Wer eine Ressource prüft, die der Erfolgsfall VERBRAUCHT, braucht je Prüfung eine eigene.**

## Sitzungs-Cookie (19.08.2026, Sicherheits-Audit P3, Etappen a und b)

Der Token liegt im Frontend in `localStorage` und ist damit in JS-Reichweite. Diese Etappe legt ihn
**zusätzlich** in ein HttpOnly-Cookie (`kepler7_sid`), das JavaScript gar nicht erst lesen kann.

**Sie ist für sich genommen KEIN Sicherheitsgewinn**, und das gehört klar gesagt: Solange das
Frontend den Token weiter in `localStorage` legt und per Bearer schickt, ist die Angriffsfläche
unverändert. Was sie leistet, ist die **Reihenfolge**:

- **Etappe a (dieser Stand)** ist rein additiv und ändert für jeden bestehenden Client exakt
  nichts. Sie darf jederzeit allein live gehen – auch bei hängender Auslieferung.
- **Etappe b (Frontend)** darf das NICHT. Ein Frontend, das nur noch auf das Cookie setzt, wäre
  gegen einen Server ohne diesen Block sofort abgemeldet – **jeder Spieler, gleichzeitig**. Genau
  deshalb die Teilung und nicht ein einzelner großer Umbau. **Sie ist seit dem 19.08.2026 gebaut**
  (Abschnitt darunter); der Backend-Teil davon muss vor dem Frontend live sein.

**Vier Entscheidungen, die man beim Anfassen kennen muss:**

1. **Der Bearer-Header hat VORRANG vor dem Cookie.** Solange a und b auseinander liegen, trägt ein
   Browser beides; maßgeblich muss das sein, was das Frontend bewusst mitschickt. Ein alter
   Cookie-Rest würde sonst ein frisch angemeldetes Gerät überstimmen.
2. **Kein `cookie-parser`.** Für das Lesen *eines* Namens ist eine Abhängigkeit ein schlechter
   Tausch – `leseCookie()` sind zwölf Zeilen. (Die frühere Begründung „das verlangt ein
   `docker restart` von Hand" gilt seit dem 28.08.2026 nicht mehr: Der Selbst-Neustart startet den
   ganzen Container neu, und `npm install` läuft dabei mit. Eine neue Abhängigkeit ändert immer
   auch Code, also greift der Neustart auch wirklich.)
3. **`Secure` hängt an `req.secure`, nicht an einer Konfiguration.** Der erste Entwurf prüfte
   `PUBLIC_URL.startsWith('https://')` – das sah nach einer Entscheidung aus und war keine:
   `web-push` verlangt für das VAPID-Subject zwingend `https:` oder `mailto:` und lässt den Server
   sonst **gar nicht erst starten** (gemessen: „Vapid subject is not an https: or mailto: URL").
   Die Bedingung wäre also immer wahr gewesen. `req.secure` misst, was wirklich anliegt, und ist
   dank `app.set('trust proxy', 1)` auch hinter dem nginx des Pi korrekt.
   **Übertragbar: Eine Fallunterscheidung über eine Konfiguration, die nur einen Wert annehmen
   KANN, ist keine** – dieselbe Familie wie das `st.proto`-Feld, das nur der Ankündigungstext las.
4. **`SameSite=Lax`, nicht `Strict`.** Das Spiel wird auch aus Mails heraus geöffnet (Bestätigungs-
   und Reset-Links), und `Strict` schickt bei genau diesem Aufruf kein Cookie mit.

`tests/test_sitzungscookie_http.js` (Port 3225 belegt der Gegenprobe-Lauf mit, **belegte Testports
sind jetzt 3195–3200 und 3210–3225** – ein neuer Test nimmt 3226). Die Gegenprobe hat eine
Besonderheit, die man kennen sollte: **Prüfung 3 (der Bearer-Weg funktioniert) muss an BEIDEN
Ständen grün sein.** Bei einer additiven Änderung heißt „richtig" ja gerade, dass sich für
bestehende Clients nichts ändert – wäre sie am alten Stand rot, hätte man etwas kaputtgemacht. Das
ist die Umkehrung des Normalfalls und gilt nur für genau diese eine Prüffrage.

### Etappe b: was der Server dazu beitragen MUSS (19.08.2026)

Etappe b dreht die Richtung um – das Frontend legt den Token nicht mehr in `localStorage`, die
Sitzung trägt das Cookie. Zwei Löcher entstehen dabei, die **ausschließlich** der Server schließen
kann; ohne sie wäre der Umbau im Frontend gar nicht durchführbar.

**1. `POST /api/logout` – bewusst OHNE `authMiddleware`.** Ein HttpOnly-Cookie kann JavaScript
nicht löschen, das ist ja sein Zweck. Ohne diese Route hätte ein Klick auf „Abmelden" den
localStorage-Rest weggeräumt, neu geladen – und das Cookie hätte den Spieler stillschweigend
**wieder angemeldet**. Ein Abmeldeknopf, der nicht abmeldet, ist schlimmer als keiner.
Die fehlende Wache ist der Zweck und keine Nachlässigkeit: Wer ein Sitzungsgeheimnis loswerden
will, darf daran nicht scheitern, weil genau dieses Geheimnis schon abgelaufen oder unsinnig ist.
Zu holen gibt es nichts – die Route liest nichts, schreibt nichts und kann nur die Kopfzeile ihres
eigenen Aufrufers löschen; ein fremder Auslöser käme wegen `SameSite=Lax` ohnehin ohne Cookie an.
**Sie entwertet die Sitzung BEWUSST NICHT serverseitig.** Das ist die ehrliche Grenze der Etappe:
Sie übersetzt, **wo** der Token liegt, nicht was Abmelden bedeutet – vorher blieb ein
ausgestelltes Token nach dem Abmelden ebenfalls gültig, es hatte nur niemand mehr. Wer die Sitzung
wirklich entwerten will, nimmt „Alle Sitzungen beenden". `test_logout_cookie_http.js` 7 misst das,
statt es nur zu behaupten.

**2. Cookie-Nachreichung in `authMiddleware`.** Wer sich zuletzt vor dem 19.08.2026 angemeldet hat,
hat gar kein Cookie – nur den Token in `localStorage`, also genau dort, wo die erste XSS-Lücke ihn
abholen würde. Das JWT läuft 180 Tage; ohne diese drei Zeilen hätte die Behebung für diese Spieler
**ein halbes Jahr** gebraucht. Kommt ein vollständig geprüfter Bearer **ohne** Cookie an, stellt der
Server eines aus; beim nächsten Seitenaufruf trägt es die Sitzung, und das Frontend räumt den
gespeicherten Token weg. Zwei Seitenaufrufe, keine Nutzeraktion.
**Nur wenn gar kein Cookie anliegt** – ein vorhandenes zu überschreiben könnte eine frische
Anmeldung durch einen älteren Bearer-Rest ersetzen. Und sie steht **hinter** der vollständigen
Prüfung (Signatur, Sperre, `tokenVersion`, `sid`); davor könnte sich jeder mit einem erfundenen
Header ein Cookie ausstellen lassen.

**Der Fehler, den der eigene Test gefangen hat – und die Regel daraus.** Die Nachreichung feuert
auch auf `/api/logout-all`: Dort kommt ein Bearer ohne Cookie an. Die Antwort trug danach **zwei**
`Set-Cookie`-Zeilen – erst eine frische Sitzung über 180 Tage, dann deren Löschung. Welche gewinnt,
entscheidet die Reihenfolge im Browser; darauf zu bauen ist ausgerechnet in einer Abmeldung der
falsche Ort. Behoben **nicht** durch eine Ausnahmeliste für Routen, sondern in
`loescheSitzungsCookie()`: Es wirft jede schon angehängte Zeile für dieses Cookie weg, bevor es die
Löschung setzt. **Wer dieses Cookie löscht, meint es – und nichts weiter oben in derselben Antwort
darf ihm widersprechen.** Das gilt damit für jede künftige Route, nicht nur für die zwei von heute.
Bezeichnend ist, wie knapp es sichtbar wurde: Die Prüfung hätte nur `Max-Age=0` irgendwo in den
Kopfzeilen verlangt, wäre sie **mit** dem Widerspruch grün geblieben. Sie verlangt jetzt **genau
eine** Zeile – die REGEL statt der Momentaufnahme (Frontend-Arbeitsregel 3).

**Und die Zeile, die jeden Spieler gleichzeitig ausgesperrt hätte** – gemessen im Browser, bevor
etwas gebaut wurde: `'Bearer '+authToken` ergibt bei `authToken === null` wörtlich den Header
`Bearer null`. `authMiddleware` sieht damit einen Bearer-Header und schaut das Cookie **gar nicht
mehr an**; jede frische Anmeldung wäre in einen 401 gelaufen. Das Frontend setzt den Header
deshalb nur noch bei wirklich vorhandenem Token. Dieselbe Messung hat nebenbei gezeigt, dass
`credentials: 'include'` überhaupt nicht gebraucht wird: Ein nacktes `fetch()` schickt das Cookie
bei gleicher Herkunft von selbst mit (Gegenprobe `credentials:'omit'` – dann nicht).

`tests/test_logout_cookie_http.js` (Port 3226, 14 Prüfungen; **belegte Testports sind jetzt
3195–3200 und 3210–3226** – ein neuer Test nimmt 3227). Am alten Stand fallen 5 (Route fehlt,
nichts wird nachgereicht), bei identischen Prüfnamen in beiden Läufen. **Drei Prüfungen müssen in
BEIDE Richtungen grün sein** und sind der Beleg statt eines Mangels: 6 (der Bearer-Weg funktioniert
unverändert) sowie 4 und 5 (es wird NICHT nachgereicht, wo es nicht soll).

Eine Falle beim Auswerten der Gegenprobe, die hier zugeschlagen hat: `grep -cE '^(OK|FAIL) +- '`
über das Protokoll meldete **15** statt 14 – die Schlusszeile `FAIL - es gab rote Pruefungen.`
passt auf dasselbe Muster. Verglichen werden deshalb die Prüf-NAMEN beider Läufe per `diff`, nicht
ihre Anzahl (Frontend-Arbeitsregel 60, hier zum zweiten Mal bestätigt).


