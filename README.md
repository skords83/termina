# Termina

Selbst gehosteter Familienkalender mit CalDAV-Synchronisation, Benutzerkonten,
Serienterminen, ICS-Import/-Export und optionalem öffentlichen Kalender-Abo.

## Lokal starten

```sh
cp .env.example .env
# CALDAV_URL, CALDAV_USERNAME, CALDAV_PASSWORD und INITIAL_ADMIN_PASSWORD setzen.
docker compose up --build
```

Frontend: http://localhost:5173. Backend: http://localhost:8000/healthz.
Die Entwicklungsports sind nur an localhost gebunden. Das Frontend leitet
API-Aufrufe über den Vite-Proxy an den Backend-Container weiter.
Beim ersten Start wird der konfigurierte Admin angelegt; vor dem Kalenderzugriff
muss er ein neues Passwort mit mindestens 12 Zeichen setzen.

## Produktion

`docker-compose.prod.yml` verwendet die veröffentlichten Images. HTTPS am
Reverse-Proxy bereitstellen und `COOKIE_SECURE=true` setzen. Die übrigen
Einstellungen entsprechen `.env.example`; zusätzliche Feed- und Freigabeoptionen
stehen in `backend/.env.example`. Keine Beispielpasswörter verwenden.
Die SQLite-Datenbank liegt im persistenten Volume unter `/data/termina.db`.
Vor Updates das Datenvolume sichern. Schema-Ergänzungen erfolgen beim Start;
der erste Sync nach der Identitätsmigration liest alle Termine erneut ein.

Private Kalenderdaten werden nicht offline gespeichert. Beim Abmelden werden
Ansicht und Undo-Verlauf verworfen. Passwort-Reset und Passwortwechsel widerrufen
bestehende Sitzungen; nach dem eigenen Passwortwechsel wird eine neue Sitzung gesetzt.
ICS-Importe sind auf 1 MiB und 500 VEVENTs (inklusive Serienausnahmen) begrenzt.

## Entwicklung und Tests

Node.js 24 und uv 0.12.14 werden auch in CI/Docker verwendet.

```sh
cd frontend
npm ci
npm test
npm run build
npm audit
```

```sh
cd backend
uv sync --locked
uv run --locked pytest -q
```

Für Backend-Entwicklung außerhalb von Docker `backend/.env.example` nach
`backend/.env` kopieren und Zugangsdaten setzen. Vite verwendet lokal Port 8000;
`API_PROXY_TARGET` kann das Ziel überschreiben. Die Images verwenden die
versionierten Lockfiles. Tests, Build und npm-Audit müssen vor Veröffentlichung
und Deployment erfolgreich sein.

## Deployment-Verzeichnis

Der SSH-Deploy liest Projektname und Compose-Dateien aus den Labels der vorhandenen
Container `termina-backend` bzw. `termina-frontend`. Dockhand-interne Pfade werden
über die tatsächlichen Docker-Mounts auf Host-Pfade aufgelöst. Der Projektname
bleibt erhalten, damit das bestehende Datenvolume weiterverwendet wird.
Bei einer mehrdeutigen oder abweichenden Installation kann die GitHub-Actions-
Repository-Variable `TERMINA_DEPLOY_DIR` auf das aktuelle Stack-Verzeichnis auf
dem Host gesetzt werden. Fehlende Pfade oder ungültige Compose-Dateien brechen
den Deploy vor Änderungen an den Containern ab.

## Persönliche Einstellungen und Kalenderrechte

Über das Zahnrad lassen sich Standardkalender, Termindauer, Startansicht, Standarderinnerung und das eigene Passwort ändern. Einstellungen gelten pro Nutzer. Die Standarddauer gilt für neue Termine im Terminformular; die Schnelleingabe verwendet ihre erkannte Zeitangabe.

Die Nutzerverwaltung unterscheidet keinen Zugriff, Lesen und Bearbeiten. Bestehende Freigaben behalten bei der Migration ihre Schreibrechte; neue Freigaben beginnen mit Lesezugriff. Abonnements, ICS-Feeds, Geburtstagskalender und vom CalDAV-Server als schreibgeschützt gemeldete Kalender bleiben auch für Administratoren nur lesbar.

Der Sync-Status zeigt den letzten vollständigen Erfolg, laufende Synchronisationen und Fehler. Bei Teilfehlern bleibt der letzte Erfolgszeitpunkt erhalten. Der Status wird alle fünf Sekunden aktualisiert.

Termine unterstützen bis zu fünf relative DISPLAY-Erinnerungen vor Beginn (auch zum Beginn). Sie werden als VALARM über CalDAV gespeichert und durch eine verbundene Kalender-App ausgelöst; eigene Web-Push-Benachrichtigungen sind nicht enthalten. Andere vorhandene Alarmtypen bleiben beim Bearbeiten erhalten. Ganztagserinnerungen beziehen sich auf den gespeicherten Tagesbeginn.
