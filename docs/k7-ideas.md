# Kepler-Ideen: erster vollständiger Inhaltsschritt

Frontend: https://github.com/GameGeeeeek/kolonie-kepler7/pull/646

Alle Routen unter `/api/k7/` benötigen die normale Kontoanmeldung. Wertvoller Fortschritt liegt in `user.k7Progress`, nicht im frei schreibbaren Spielstand. Die Allianzoperation und Bossvariante wohnen im bereits geschützten Raid-Dokument; es gibt keinen neuen generischen Shared-Schlüssel.

## Kampagne und Expedition

`GET /progress` liefert den gespeicherten Stand. Die fünf Etappen sind Signal, Datenrekonstruktion, bestätigter PvE-Beitrag, Abschlusswahl und einmaliger Abschluss. `POST /story/start`, `/story/recover`, `/story/choice` und `/story/claim` prüfen die Reihenfolge. Wahl `quarantine` oder `transmit`, jeweils einmalig 100 Kredite über `story-campaign`.

`POST /expedition/register` nimmt nur die Kennung einer im eigenen Spielstand vorhandenen, noch laufenden Expedition mit Forschungsschiff und gültigen Zeiten. Der eigene Spielstand bleibt gemäß bestehender Architektur klientenautoritativ; dies ist keine neue serverseitige Simulation der gesamten Expedition. Der Server fixiert Kennung, Zeitpunkt, Ergebnis und Ausgabe. Registrierungen sind auf eine pro Minute, acht offene Ereignisse und 2000 archivierte Ereignisse begrenzt; bestehende Ereignisse werden nicht gelöscht. Wiederholte Registrierungen bleiben identisch.

`POST /expedition/choose` sperrt die erste Auswahl. `salvage`: 120 Erz/60 Kristalle; `inspect`: 80% auf 500 Erz/250 Kristalle, sonst null; `return`: null. Das zusätzliche Wrack verändert weder den gewöhnlichen Expeditionsfund noch deren Schiffsverluste. Auflösung frühestens nach einer Serverminute und am gespeicherten Rückkehrzeitpunkt, auch ohne aktiven Client. Ohne Wahl gilt sichere Bergung. Der Zufallswert bleibt vor der Auflösung verborgen. Belohnungstyp `expedition-choice`, normale Lagerdeckel im Client. Eine spätere Kampagne übernimmt keine vor ihrem Start registrierten Wracks.

## Panzerhüllen-Pilot

`POST /pity/target` akzeptiert ausschließlich `panzer_platte`, `panzer_niete`, `panzer_kiel`, `panzer_kammer`. Nur der vorhandene, erfolgreiche finale Raid-Claim gegen Panzerhülle zählt. Jede Welle zählt einmal. Nach zwölf Siegen gibt `/pity/claim` genau ein gewähltes **seltenes** Teil über `set-pity`; Zähler danach null. Kein Übertrag mehrfacher Auszahlungen durch Ansparen oberhalb zwölf, keine Änderung gewöhnlicher Zufallsfunde oder höherer Seltenheiten.

Balance: zusätzliche Verfügbarkeit maximal 1/12 Teil pro finalem Sieg. Bestehende Zufallsfundrate auf Stufe 1: 0,16 (letzter Rang) bis 0,61 (erster/Solo), danach 0,2433 bis 0,6933 Teile je Sieg inklusive Pilot. Das ist eine bewusste Erhöhung um 0,0833, besonders relevant für hintere Ränge. `tests/test_k7_balance.js` prüft 144 echte Aufrufe des Zählers, Wiederholungen, fremde Quellen und die bestehende Fundformel. Ein Ausbau auf weitere Sets benötigt eine eigene Balanceprüfung.

## Operation und Schildzyklus

`POST /operation/start`: Leitung/Offiziere, bestehender offener Raid vor Abflug. `/operation/contribute`: Mitglieder, erst `scout`, dann `supply`. Aufklärung benötigt einen tatsächlich stationierten Spionagekreuzer/Forscher und 100 Energie; unterwegs befindliche Schiffe zählen nicht. Versorgung kostet 250 Erz/100 Kristalle. Jede Rolle einmal je Konto; serverseitige Speicher-Version wird zurückgegeben, Wiederholungen ohne erneute Kosten. Bestehende Frontend-Speichersicherung vor der Anfrage verwenden.

Angriff bleibt der echte Raid. Noch zugehörige Aufklärungsbeiträge senken Gegenwehr um 10%, Versorgungsbeiträge die daraus errechnete Verlustquote um 10%. Bei endgültigem Sieg erhält jede noch zugehörige Person mit einem dieser Beiträge einmalig 40 Kredite über `alliance-operation`, auch offline. Angreifer erhalten daneben ihre normalen Raid-Belohnungen. Verlassene Allianzen gewähren keine Beitragswirkung oder Auszahlung.

`POST /raid/variant`: Leitung/Offiziere, ausschließlich Panzerhülle vor Welle 1. Optionaler Schildzyklus: ab 50% Rest-Hülle Schaden ×0,65 oder mit Bombern ×0,90, darunter Schaden ×1,20 und Gegenwehr ×0,80. Bestehende Schwäche und Status gelten zusätzlich. Brand wird vor der Phasenwahl gebucht. Phase gilt für die ganze Welle und steht im Ergebnis/Claim. `boss-phases.js` und Frontend-Helfer werden auf Parität geprüft.

## Auslieferung und Prüfungen

**Backend vor Frontend**, beide nur nach Freigabe mergen. Alte Clients dürfen die vier neuen Pending-Typen erst mit `k7IdeasVersion:1` abholen; andere kompatible Belohnungen bleiben erreichbar. Ohne neue Backend-Routen zeigt das Frontend die fehlende Server-Unterstützung.

Geprüft: Syntax, Start, bestehender Shared-Storage-HTTP-Test, 56 neue HTTP-Prüfungen, Balance und vier absichtlich rote Gegenproben. Neue HTTP-Prüfungen verwenden gemessene freie Ports, eigene DB/Secret-Dateien, beide Save-Formen und SIGKILL-Neustarts. Keine Produktionsdaten verwendet.
