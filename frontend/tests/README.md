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
Screenshots entstehen unter `/tmp/termina-*.png` für 1280×800, 375×667,
320×568 und 375×360 (reduzierte Höhe). Die normalen kompakten Ansichten werden
auf scrollfreie Felder und sichtbare Aktionen geprüft; bei geöffneten Optionen
und reduzierter Höhe bleiben die Aktionen außerhalb des scrollenden Inhalts.

Prüfung am 16.11.2026: Browserlauf erfolgreich, Screenshots visuell kontrolliert;
103 Frontendtests, 183 Backendtests und Frontendbuild erfolgreich.
`npm audit --omit=dev`: keine Befunde. Vollständiger `npm audit`: vier bereits
im Hauptbranch vorhandene Befunde in Entwicklungsabhängigkeiten (2 moderat,
2 hoch; Vitest/Mocker, source-map-js, Vite). Abhängigkeiten bleiben in diesem
auf die Terminerfassung begrenzten PR unverändert.

Nicht geprüft: reale iOS-/Android-Bildschirmtastatur und physische Touchgeräte,
echter Nextcloud-/CalDAV-Schreibzugriff. Die reduzierte Browserhöhe simuliert nur
den verfügbaren Platz; das Formular berücksichtigt zusätzlich `visualViewport`
bei Größenänderungen und Verschiebung durch Bildschirmtastaturen.
