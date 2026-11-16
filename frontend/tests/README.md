# Terminformular im Browser prüfen

Vite mit `npm run dev -- --host 127.0.0.1` im Frontend starten.
Playwright separat bereitstellen (keine zusätzliche App-Abhängigkeit), dann:

```sh
PLAYWRIGHT_MODULE=/pfad/zu/playwright/index.mjs node tests/event-form.browser.mjs
```

Standardbrowser: `/usr/bin/chromium`, mit `CHROMIUM_PATH` überschreibbar.
Der Test verwendet das echte Formular und dessen Styles mit synthetischen Kalendern
und simulierten Schreibantworten. Zusätzlich prüft er die Datumübergabe durch
Klick auf den 14.12. im echten Monatskalender mit simulierten API-Antworten.
Die Fixture ist nicht Teil des Produktionsbuilds.

Geprüft: beide Beispieltermine, 60-Minuten-Vorgabe, persönliche Dauer und Erinnerung,
geänderte Dauer und Beginn, Tageswechsel, Ganztag, zusätzlicher Kalender und
Ausschluss von Lesekalendern, Wiederholung, unveränderte verborgene Angaben bei
Serienbearbeitung (inklusive mehrtägigem Ganztag), Titelfokus und Tab-Begrenzung.
Screenshots entstehen unter `/tmp/termina-*.png`. Die Layoutmatrix prüft
1280×800, 320×568, 360×667, 390×667 und 320×360 jeweils mit vier sowie fünf
beschreibbaren Kalendern und zusätzlich langen Namen (auch ohne Leerzeichen).
`termina-layout-*` zeigt die Kalenderauswahl, `termina-fields-*` die bei Bedarf
vertikal gescrollten Felder. Die Prüfung misst horizontale Überläufe, kontrolliert
44-Pixel-Touchflächen der Kalender, den exklusiven Auswahlzustand, geschlossene
Zusatzoptionen und sichtbare Aktionen. Geöffnete Optionen und Datumsauswahl
werden ebenfalls geprüft. Vertikales Scrollen bei wenig Platz ist erlaubt.

Prüfung am 16.11.2026 nach der Layoutüberarbeitung: Browserlauf erfolgreich;
Screenshots aller Layoutvarianten sowie der gescrollten Felder und geöffneten
Optionen visuell kontrolliert. Keine horizontalen Überläufe oder abgeschnittenen
Namen; Uhrzeitfeld für vollständige Darstellung bei mobiler Schriftgröße verbreitert.
103 Frontendtests und Produktionsbuild erfolgreich. Die Kalenderzahl basiert auf
der vorhandenen Fixture, da im Auftrag kein Screenshot angehängt war.
Backend und Terminlogik wurden bei dieser Layoutänderung nicht verändert.

Nicht geprüft: reale iOS-/Android-Bildschirmtastatur und physische Touchgeräte,
echter Nextcloud-/CalDAV-Schreibzugriff. Die reduzierte Browserhöhe simuliert nur
den verfügbaren Platz; das Formular berücksichtigt zusätzlich `visualViewport`
bei Größenänderungen und Verschiebung durch Bildschirmtastaturen.
