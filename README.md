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
