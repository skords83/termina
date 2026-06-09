# Termina

Selbst gehosteter Kalender, der gegen eine Nextcloud per CalDAV im Hintergrund synct
und als PWA im Browser nutzbar ist.

## Architektur

```
[Nextcloud CalDAV]  <-->  [Backend (FastAPI + SQLite)]  <-->  [Frontend (React PWA)]
```

- **Backend (Python / FastAPI)** pollt Nextcloud regelmaessig, cached Termine in SQLite,
  und stellt eine schmale REST-API bereit.
- **Frontend (React + Vite + TypeScript)** redet ausschliesslich mit dem Backend.
  Damit umgehen wir CORS, der Sync laeuft auch bei geschlossenem Browser,
  und die CalDAV-Credentials liegen nur auf dem Server.

## Quick Start

```sh
cp .env.example .env
# .env editieren: NEXTCLOUD_URL, NEXTCLOUD_USERNAME, NEXTCLOUD_APP_PASSWORD setzen
# und API_TOKEN auf einen zufaelligen Wert aendern (z.B. `openssl rand -hex 32`)
docker compose up --build
```

- Backend:  http://localhost:8000  (Health-Check: `/healthz`)
- Frontend: http://localhost:5173

## Projektstruktur

```
backend/
  src/app/
    main.py           FastAPI-Einstieg
    config.py         Settings aus .env (pydantic-settings)
    db/               SQLAlchemy (Phase 1)
    caldav/           Nextcloud-Client + Sync-Worker (Phase 1)
    api/              REST-Endpoints (Phase 2)
    scheduler.py      APScheduler (Phase 1)
  tests/
  pyproject.toml
  Dockerfile

frontend/
  src/
    main.tsx
    App.tsx
    index.css
  index.html
  package.json
  vite.config.ts
  tsconfig.json
  Dockerfile

data/                 SQLite-Datei (auf dem Host persistiert)
docker-compose.yml
.env.example
```

## Roadmap

- [x] **Phase 0** - Grundgeruest (Repo, Docker, "Hello World")
- [ ] **Phase 1** - CalDAV-Sync mit CTag/ETag, Background-Polling
- [ ] **Phase 2** - REST-API (`/calendars`, `/events`)
- [ ] **Phase 3** - Monatsansicht im Frontend
- [ ] **Phase 4** - PWA + Polish (Manifest, Service Worker, Dark Mode)
- [ ] danach: Write-Sync (Erstellen/Bearbeiten/Loeschen), weitere Ansichten,
      Wiederholungen (RRULE), Tasks (VTODO), Push-Benachrichtigungen,
      Kontaktgeburtstage via CardDAV.

## Phase 0 Smoke-Test

Wenn beide Container laufen, sollte gelten:

```sh
curl http://localhost:8000/healthz
# {"status":"ok"}
```

Und im Browser unter http://localhost:5173 erscheint eine Seite, die "Backend-Status: ok"
anzeigt - das beweist, dass Frontend und Backend miteinander reden.
