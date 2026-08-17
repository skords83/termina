# Terminfreigabe „Mit Oma + Opa teilen" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eine "Mit Oma + Opa teilen"-Aktion an Terminen, die eine unabhängige, aber lose rückverknüpfte Kopie im dedizierten "Oma & Opa"-Kalender erzeugt — inkl. Serientermin-Unterstützung und Drift-Erkennung zwischen Original und Kopie.

**Architecture:** Neue `event_shares`/`event_share_instance_states`-Tabellen tracken die Verknüpfung per Snapshot-Vergleich (kein Live-Sync). Ein neuer Router `backend/src/app/api/event_shares.py` bietet Create/List/Resolve-Endpunkte; `GET /events` bekommt ein zusätzliches `shared_drift`-Flag pro Event/Instanz. Frontend: ein neuer `ShareDialog` zum Anlegen der Freigabe, ein persistentes Warn-Icon an Termin-Chips bei Drift, und eine Resolution-/Delete-Intercept-UI in `EventPopup.tsx`.

**Tech Stack:** FastAPI + SQLAlchemy 2.x (declarative, `Mapped`/`mapped_column`) + SQLite (Migrations via `create_tables()`/`apply_migrations()`, **kein Alembic**, **keine FK-Enforcement** — `PRAGMA foreign_keys` wird nirgends gesetzt); React + TypeScript, kein State-Management-Library außer lokalem `useState`/Context (`Toast.tsx`); pytest + FastAPI `TestClient` (Backend), kein Component-Test-Setup im Frontend (nur 1 Vitest-Unit-Test existiert projektweit — neue UI-Komponenten werden über `tsc`/Build-Check + manuelle Verifikation abgesichert, keine neuen RTL-Tests).

## Global Constraints

- Bestehendes Zugriffsmodell wiederverwenden: `service.ensure_calendar_access(db, user, calendar_id)` aus `backend/src/app/auth/service.py` vor jedem Schreibzugriff, exakt wie in `events.py`. Kein neues Berechtigungssystem.
- Zielkalender ("Oma & Opa") wird **nicht** in der UI ausgewählt (Spec nennt keine Kalenderauswahl im Teilen-Dialog) — er kommt aus einer neuen Config-Einstellung `oma_opa_calendar_id` in `backend/src/app/config.py` (Setup ist manueller Betriebsschritt, kein Code, siehe Spec Zeile 27–29).
- **Keine bidirektionale Synchronisierung, keine stille automatische Übernahme** — jede Übernahme einer Änderung braucht eine explizite Bestätigung (Spec "Out of Scope").
- SQLite FK-Constraints sind in diesem Projekt nicht aktiv (kein `PRAGMA foreign_keys=ON` in `backend/src/app/db/session.py`) — `ondelete="CASCADE"` in neuen Modellen ist nur Dokumentation, **Aufräumen von `event_shares`-Zeilen beim Löschen eines Events muss explizit im Code passieren** (Task 5).
- Instanz-Zuordnung bei Serien läuft über einen **berechneten Offset** (`shared_recurrence_id = source_recurrence_id + buffer_before_minutes`), keine 1:1-Mapping-Tabelle — RRULE wird identisch kopiert, nur DTSTART wird um den Puffer verschoben, wodurch sich alle RRULE-Instanzzeitpunkte um denselben Offset verschieben.
- Migrationen: neue Tabellen brauchen **keinen** Eintrag in `_COLUMN_MIGRATIONS` (nur nachträgliche Spalten an bestehenden Tabellen brauchen das) — `Base.metadata.create_all()` legt sie beim nächsten App-Start automatisch an.
- Copy: deutschsprachige UI-Texte, Ton passend zu bestehenden Toasts/Dialogen (knapp, direkt, keine Ausrufezeichen-Häufung).

---

### Task 1: Datenmodell `EventShare` + `EventShareInstanceState` + Config

**Files:**
- Modify: `backend/src/app/db/models.py`
- Modify: `backend/src/app/config.py`
- Test: `backend/tests/test_event_shares_models.py` (neu)

**Interfaces:**
- Produces: `EventShare` (Felder: `id`, `source_uid`, `shared_uid`, `target_calendar_id`, `snapshot_start`, `snapshot_end`, `snapshot_summary`, `snapshot_rrule`, `buffer_before_minutes`, `buffer_after_minutes`, `dismissed`, `created_at`), `EventShareInstanceState` (Felder: `id`, `share_id`, `source_recurrence_id`, `snapshot_start`, `snapshot_end`, `snapshot_summary`, `snapshot_deleted`, `dismissed`, `updated_at`), `settings.oma_opa_calendar_id: str | None`.

- [ ] **Step 1: Schreibe den fehlschlagenden Test für Tabellen-Erstellung + Constraints**

```python
# backend/tests/test_event_shares_models.py
from __future__ import annotations

from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.models import Base, Calendar, Event, EventShare, EventShareInstanceState

TEST_DB_URL = "sqlite:///:memory:"


@pytest.fixture()
def db():
    engine = create_engine(TEST_DB_URL, connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


def _seed_events(db):
    cal = Calendar(id="cal-1", name="Privat", color="#5b8fff")
    db.add(cal)
    src = Event(uid="src-1", calendar_id="cal-1", summary="Zahnarzt", start=datetime(2026, 6, 1, 10, 0), end=datetime(2026, 6, 1, 11, 0), all_day=False)
    shared = Event(uid="shared-1", calendar_id="cal-1", summary="Kinder hüten", start=datetime(2026, 6, 1, 9, 45), end=datetime(2026, 6, 1, 11, 15), all_day=False)
    db.add_all([src, shared])
    db.commit()


def test_event_share_erstellen_und_lesen(db):
    _seed_events(db)
    share = EventShare(
        source_uid="src-1",
        shared_uid="shared-1",
        target_calendar_id="cal-oma-opa",
        snapshot_start=datetime(2026, 6, 1, 10, 0),
        snapshot_end=datetime(2026, 6, 1, 11, 0),
        snapshot_summary="Zahnarzt",
        snapshot_rrule=None,
        buffer_before_minutes=15,
        buffer_after_minutes=15,
        dismissed=False,
        created_at=datetime.utcnow(),
    )
    db.add(share)
    db.commit()
    db.refresh(share)

    fetched = db.query(EventShare).filter(EventShare.source_uid == "src-1").first()
    assert fetched is not None
    assert fetched.shared_uid == "shared-1"
    assert fetched.buffer_before_minutes == 15
    assert fetched.dismissed is False


def test_event_share_instance_state_unique_constraint(db):
    _seed_events(db)
    share = EventShare(
        source_uid="src-1", shared_uid="shared-1", target_calendar_id="cal-oma-opa",
        snapshot_start=datetime(2026, 6, 1, 10, 0), snapshot_end=datetime(2026, 6, 1, 11, 0),
        snapshot_summary="Zahnarzt", snapshot_rrule="FREQ=WEEKLY",
        buffer_before_minutes=0, buffer_after_minutes=0, dismissed=False, created_at=datetime.utcnow(),
    )
    db.add(share)
    db.commit()
    db.refresh(share)

    rid = datetime(2026, 6, 8, 10, 0)
    db.add(EventShareInstanceState(share_id=share.id, source_recurrence_id=rid, snapshot_deleted=False, dismissed=False, updated_at=datetime.utcnow()))
    db.commit()

    db.add(EventShareInstanceState(share_id=share.id, source_recurrence_id=rid, snapshot_deleted=False, dismissed=False, updated_at=datetime.utcnow()))
    with pytest.raises(IntegrityError):
        db.commit()
```

- [ ] **Step 2: Test ausführen, erwarteter Fehlschlag**

Run: `cd backend && python -m pytest tests/test_event_shares_models.py -v`
Expected: FAIL mit `ImportError: cannot import name 'EventShare' from 'app.db.models'`

- [ ] **Step 3: Modelle in `backend/src/app/db/models.py` ergänzen**

Am Dateiende (nach der bestehenden `UserCalendarAccess`-Klasse) einfügen:

```python
class EventShare(Base):
    __tablename__ = "event_shares"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_uid: Mapped[str] = mapped_column(String, ForeignKey("events.uid", ondelete="CASCADE"), nullable=False, index=True)
    shared_uid: Mapped[str] = mapped_column(String, ForeignKey("events.uid", ondelete="CASCADE"), nullable=False, index=True)
    target_calendar_id: Mapped[str] = mapped_column(String, nullable=False)
    snapshot_start: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    snapshot_end: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    snapshot_summary: Mapped[str] = mapped_column(String, nullable=False)
    snapshot_rrule: Mapped[str | None] = mapped_column(String, nullable=True)
    buffer_before_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    buffer_after_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    dismissed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class EventShareInstanceState(Base):
    __tablename__ = "event_share_instance_states"
    __table_args__ = (
        UniqueConstraint("share_id", "source_recurrence_id", name="uq_event_share_instance"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    share_id: Mapped[int] = mapped_column(Integer, ForeignKey("event_shares.id", ondelete="CASCADE"), nullable=False, index=True)
    source_recurrence_id: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    snapshot_start: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    snapshot_end: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    snapshot_summary: Mapped[str | None] = mapped_column(String, nullable=True)
    snapshot_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    dismissed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
```

Hinweis: `target_calendar_id` ist eine Erweiterung gegenüber der Spec-Tabelle (dort nicht gelistet) — nötig, damit Drift-Resolution und Anzeige ohne zusätzlichen Config-Lookup auskommen. Bewusste Entscheidung, siehe "Offene Implementierungsfragen" in der Spec, die genaues Tabellendesign der Implementierungsplanung überlässt.

- [ ] **Step 4: Config-Feld ergänzen**

In `backend/src/app/config.py`, nach `birthdays_calendar_color: str = "#f2a65a"` einfügen:

```python
    oma_opa_calendar_id: str | None = None
```

- [ ] **Step 5: Test erneut ausführen**

Run: `cd backend && python -m pytest tests/test_event_shares_models.py -v`
Expected: PASS (2 Tests)

- [ ] **Step 6: Commit**

```bash
git add backend/src/app/db/models.py backend/src/app/config.py backend/tests/test_event_shares_models.py
git commit -m "feat: add EventShare/EventShareInstanceState models + oma_opa_calendar_id config"
```

---

### Task 2: `POST /event-shares` — Freigabe erstellen (Einzeltermin + Serie)

**Files:**
- Create: `backend/src/app/api/event_shares.py`
- Modify: `backend/src/app/main.py`
- Test: `backend/tests/test_event_shares_api.py` (neu)

**Interfaces:**
- Consumes: `create_event(calendar_id, summary, start, end, all_day=False, location=None, description=None, rrule=None) -> str` aus `backend/src/app/caldav/write.py:257`; `run_sync()` aus `backend/src/app/caldav/sync.py`; `service.ensure_calendar_access(db, user, calendar_id)` aus `backend/src/app/auth/service.py:133`; `settings.oma_opa_calendar_id` aus Task 1.
- Produces: `router = APIRouter(prefix="/event-shares", tags=["event-shares"])`; `_naive(dt) -> datetime`; `_series_has_drift(share: EventShare, source: Event) -> bool`; `_share_out(share: EventShare, has_drift: bool) -> dict` — diese drei werden in Task 3 und Task 4 importiert (`from app.api.event_shares import ...`).

- [ ] **Step 1: Schreibe den fehlschlagenden Test**

```python
# backend/tests/test_event_shares_api.py
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import sessionmaker

from app.main import app
from app.auth.security import hash_password
from app.db.models import Base, Event, Calendar, User, EventShare
from app.db.session import get_db
from app.config import settings

TEST_USER_EMAIL = "admin@test.local"
TEST_USER_PASSWORD = "testpassword123"

TEST_DB_URL = "sqlite:///:memory:"
engine = create_engine(TEST_DB_URL, connect_args={"check_same_thread": False}, poolclass=StaticPool)
TestingSessionLocal = sessionmaker(bind=engine)

SRC_CAL = "https://nc.example.com/dav/personal/"
OMA_OPA_CAL = "https://nc.example.com/dav/oma-opa/"


def override_get_db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(autouse=True)
def setup_db(monkeypatch):
    Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(settings, "oma_opa_calendar_id", OMA_OPA_CAL)
    db = TestingSessionLocal()
    db.add_all([
        Calendar(id=SRC_CAL, name="Privat", color="#5b8fff"),
        Calendar(id=OMA_OPA_CAL, name="Oma & Opa", color="#f2a65a"),
    ])
    db.add(Event(
        uid="src-uid-1", calendar_id=SRC_CAL, etag='"etag-1"', summary="Zahnarzttermin",
        start=datetime(2026, 6, 15, 10, 0, tzinfo=timezone.utc),
        end=datetime(2026, 6, 15, 11, 0, tzinfo=timezone.utc),
        all_day=False,
    ))
    db.add(Event(
        uid="src-serie-1", calendar_id=SRC_CAL, etag='"etag-2"', summary="Einkaufen freitags",
        start=datetime(2026, 6, 19, 9, 0, tzinfo=timezone.utc),
        end=datetime(2026, 6, 19, 10, 0, tzinfo=timezone.utc),
        all_day=False, rrule="FREQ=WEEKLY;BYDAY=FR",
    ))
    db.commit()
    db.close()
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setitem(app.dependency_overrides, get_db, override_get_db)
    monkeypatch.setattr("app.caldav.sync.run_sync", lambda: None)
    monkeypatch.setattr("app.scheduler.run_sync", lambda: None)
    return TestClient(app)


@pytest.fixture()
def auth(client):
    db = TestingSessionLocal()
    db.add(User(
        email=TEST_USER_EMAIL, display_name="Test Admin",
        password_hash=hash_password(TEST_USER_PASSWORD), role="admin",
        must_change_password=False, created_at=datetime.utcnow(),
    ))
    db.commit()
    db.close()
    r = client.post("/api/auth/login", json={"email": TEST_USER_EMAIL, "password": TEST_USER_PASSWORD})
    assert r.status_code == 200
    return {}


def test_share_einzeltermin_erstellt_kopie_und_datensatz(client, auth):
    with patch("app.api.event_shares.create_event", return_value="shared-uid-1") as mock_create:
        r = client.post("/api/event-shares", json={
            "source_uid": "src-uid-1",
            "summary": "Kinder hüten",
            "start": "2026-06-15T09:45:00",
            "end": "2026-06-15T11:15:00",
            "buffer_before_minutes": 15,
            "buffer_after_minutes": 15,
        })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["shared_uid"] == "shared-uid-1"
    assert body["target_calendar_id"] == OMA_OPA_CAL
    assert body["has_drift"] is False

    mock_create.assert_called_once()
    _, kwargs = mock_create.call_args
    assert kwargs["calendar_id"] == OMA_OPA_CAL
    assert kwargs["summary"] == "Kinder hüten"
    assert kwargs["rrule"] is None

    db = TestingSessionLocal()
    row = db.query(EventShare).filter(EventShare.source_uid == "src-uid-1").first()
    assert row is not None
    assert row.buffer_before_minutes == 15
    db.close()


def test_share_serie_kopiert_rrule(client, auth):
    with patch("app.api.event_shares.create_event", return_value="shared-serie-1") as mock_create:
        r = client.post("/api/event-shares", json={
            "source_uid": "src-serie-1",
            "summary": "Einkaufen freitags",
            "start": "2026-06-19T09:00:00",
            "end": "2026-06-19T10:00:00",
        })
    assert r.status_code == 201, r.text
    _, kwargs = mock_create.call_args
    assert kwargs["rrule"] == "FREQ=WEEKLY;BYDAY=FR"


def test_share_ohne_konfigurierten_zielkalender_400(client, auth, monkeypatch):
    monkeypatch.setattr(settings, "oma_opa_calendar_id", None)
    r = client.post("/api/event-shares", json={
        "source_uid": "src-uid-1", "summary": "X",
        "start": "2026-06-15T09:45:00", "end": "2026-06-15T11:15:00",
    })
    assert r.status_code == 400


def test_share_unbekannter_source_404(client, auth):
    r = client.post("/api/event-shares", json={
        "source_uid": "does-not-exist", "summary": "X",
        "start": "2026-06-15T09:45:00", "end": "2026-06-15T11:15:00",
    })
    assert r.status_code == 404


def test_share_ohne_auth_401(client):
    r = client.post("/api/event-shares", json={
        "source_uid": "src-uid-1", "summary": "X",
        "start": "2026-06-15T09:45:00", "end": "2026-06-15T11:15:00",
    })
    assert r.status_code == 401
```

- [ ] **Step 2: Test ausführen, erwarteter Fehlschlag**

Run: `cd backend && python -m pytest tests/test_event_shares_api.py -v`
Expected: FAIL mit 404 auf `/api/event-shares` (Router existiert noch nicht)

- [ ] **Step 3: `backend/src/app/api/event_shares.py` implementieren**

```python
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import service
from app.auth.dependencies import get_current_user
from app.caldav.sync import run_sync
from app.caldav.write import create_event
from app.config import settings
from app.db.models import Event, EventShare, User
from app.db.session import get_db

router = APIRouter(prefix="/event-shares", tags=["event-shares"])


class EventShareCreate(BaseModel):
    source_uid: str
    summary: str
    start: datetime
    end: datetime
    buffer_before_minutes: int = 0
    buffer_after_minutes: int = 0


def _naive(dt: datetime) -> datetime:
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _series_has_drift(share: EventShare, source: Event) -> bool:
    return (
        _naive(share.snapshot_start) != _naive(source.start)
        or _naive(share.snapshot_end) != _naive(source.end)
        or share.snapshot_summary != source.summary
        or (share.snapshot_rrule or None) != (source.rrule or None)
    )


def _share_out(share: EventShare, has_drift: bool) -> dict:
    return {
        "id": share.id,
        "source_uid": share.source_uid,
        "shared_uid": share.shared_uid,
        "target_calendar_id": share.target_calendar_id,
        "snapshot_start": share.snapshot_start.isoformat(),
        "snapshot_end": share.snapshot_end.isoformat(),
        "snapshot_summary": share.snapshot_summary,
        "snapshot_rrule": share.snapshot_rrule,
        "buffer_before_minutes": share.buffer_before_minutes,
        "buffer_after_minutes": share.buffer_after_minutes,
        "has_drift": has_drift,
    }


@router.post("", status_code=201)
def create_share(
    body: EventShareCreate,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    source = db.query(Event).filter(Event.uid == body.source_uid).first()
    if source is None:
        raise HTTPException(status_code=404, detail="Quelltermin nicht gefunden")
    service.ensure_calendar_access(db, user, source.calendar_id)

    target_calendar_id = settings.oma_opa_calendar_id
    if not target_calendar_id:
        raise HTTPException(
            status_code=400,
            detail="Zielkalender 'Oma & Opa' ist nicht konfiguriert (OMA_OPA_CALENDAR_ID)",
        )
    service.ensure_calendar_access(db, user, target_calendar_id)

    shared_uid = create_event(
        calendar_id=target_calendar_id,
        summary=body.summary,
        start=body.start,
        end=body.end,
        all_day=source.all_day,
        location=None,
        description=None,
        rrule=source.rrule,
    )

    share = EventShare(
        source_uid=source.uid,
        shared_uid=shared_uid,
        target_calendar_id=target_calendar_id,
        snapshot_start=source.start,
        snapshot_end=source.end,
        snapshot_summary=source.summary,
        snapshot_rrule=source.rrule,
        buffer_before_minutes=body.buffer_before_minutes,
        buffer_after_minutes=body.buffer_after_minutes,
        dismissed=False,
        created_at=datetime.utcnow(),
    )
    db.add(share)
    db.commit()
    db.refresh(share)
    background.add_task(run_sync)

    return _share_out(share, has_drift=False)
```

- [ ] **Step 4: Router in `backend/src/app/main.py` registrieren**

Zeile 7 ändern von:
```python
from app.api import admin_users, calendars, events, ics_api, sync_api
```
zu:
```python
from app.api import admin_users, calendars, event_shares, events, ics_api, sync_api
```

Nach Zeile 46 (`app.include_router(events.router, prefix="/api")`) einfügen:
```python
app.include_router(event_shares.router, prefix="/api")
```

- [ ] **Step 5: Tests ausführen**

Run: `cd backend && python -m pytest tests/test_event_shares_api.py -v`
Expected: PASS (5 Tests)

- [ ] **Step 6: Vollständige Backend-Testsuite laufen lassen (Regression)**

Run: `cd backend && python -m pytest -v`
Expected: PASS, keine bestehenden Tests gebrochen

- [ ] **Step 7: Commit**

```bash
git add backend/src/app/api/event_shares.py backend/src/app/main.py backend/tests/test_event_shares_api.py
git commit -m "feat: add POST /event-shares endpoint to create grandparent copies"
```

---

### Task 3: Drift-Query & Resolution-Endpunkte (`GET /event-shares`, Sync-Snapshot)

**Files:**
- Modify: `backend/src/app/api/event_shares.py`
- Test: `backend/tests/test_event_shares_drift.py` (neu)

**Interfaces:**
- Consumes: `_naive`, `_series_has_drift`, `_share_out` aus Task 2 (gleiche Datei).
- Produces: `_instance_snapshot_from_source(db, source_uid, recurrence_id) -> tuple[datetime|None, datetime|None, str|None, bool]`; `_instance_overridden(db, source_uid, recurrence_id) -> bool`; `_instance_has_drift(db, share, source_uid, recurrence_id) -> bool` — werden in Task 4 aus `app.api.event_shares` importiert.

- [ ] **Step 1: Schreibe den fehlschlagenden Test**

```python
# backend/tests/test_event_shares_drift.py
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import sessionmaker

from app.main import app
from app.auth.security import hash_password
from app.db.models import Base, Event, EventOverride, Calendar, User, EventShare
from app.db.session import get_db
from app.config import settings

TEST_DB_URL = "sqlite:///:memory:"
engine = create_engine(TEST_DB_URL, connect_args={"check_same_thread": False}, poolclass=StaticPool)
TestingSessionLocal = sessionmaker(bind=engine)

SRC_CAL = "https://nc.example.com/dav/personal/"
OMA_OPA_CAL = "https://nc.example.com/dav/oma-opa/"


def override_get_db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(autouse=True)
def setup_db(monkeypatch):
    Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(settings, "oma_opa_calendar_id", OMA_OPA_CAL)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setitem(app.dependency_overrides, get_db, override_get_db)
    monkeypatch.setattr("app.caldav.sync.run_sync", lambda: None)
    monkeypatch.setattr("app.scheduler.run_sync", lambda: None)
    return TestClient(app)


@pytest.fixture()
def auth(client):
    db = TestingSessionLocal()
    db.add(User(email="a@test.local", display_name="Admin", password_hash=hash_password("testpassword123"),
                role="admin", must_change_password=False, created_at=datetime.utcnow()))
    db.commit()
    db.close()
    r = client.post("/api/auth/login", json={"email": "a@test.local", "password": "testpassword123"})
    assert r.status_code == 200
    return {}


def _make_share(db, source_start, source_end, source_summary, rrule=None):
    db.add_all([
        Calendar(id=SRC_CAL, name="Privat", color="#5b8fff"),
        Calendar(id=OMA_OPA_CAL, name="Oma & Opa", color="#f2a65a"),
    ])
    db.add(Event(uid="src-1", calendar_id=SRC_CAL, summary=source_summary, start=source_start, end=source_end, all_day=False, rrule=rrule))
    db.add(Event(uid="shared-1", calendar_id=OMA_OPA_CAL, summary="Kinder hüten", start=source_start, end=source_end, all_day=False, rrule=rrule))
    share = EventShare(
        source_uid="src-1", shared_uid="shared-1", target_calendar_id=OMA_OPA_CAL,
        snapshot_start=source_start, snapshot_end=source_end, snapshot_summary=source_summary,
        snapshot_rrule=rrule, buffer_before_minutes=0, buffer_after_minutes=0,
        dismissed=False, created_at=datetime.utcnow(),
    )
    db.add(share)
    db.commit()
    db.refresh(share)
    return share.id


def test_list_shares_ohne_drift(client, auth):
    db = TestingSessionLocal()
    _make_share(db, datetime(2026, 6, 15, 10, 0), datetime(2026, 6, 15, 11, 0), "Zahnarzt")
    db.close()

    r = client.get("/api/event-shares", params={"source_uid": "src-1"})
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    assert body[0]["has_drift"] is False


def test_list_shares_erkennt_serien_drift(client, auth):
    db = TestingSessionLocal()
    _make_share(db, datetime(2026, 6, 15, 10, 0), datetime(2026, 6, 15, 11, 0), "Zahnarzt")
    # Original verschiebt sich
    ev = db.query(Event).filter(Event.uid == "src-1").first()
    ev.start = datetime(2026, 6, 15, 12, 0)
    ev.end = datetime(2026, 6, 15, 13, 0)
    db.commit()
    db.close()

    r = client.get("/api/event-shares", params={"source_uid": "src-1"})
    assert r.json()[0]["has_drift"] is True


def test_sync_snapshot_loescht_drift(client, auth):
    db = TestingSessionLocal()
    share_id = _make_share(db, datetime(2026, 6, 15, 10, 0), datetime(2026, 6, 15, 11, 0), "Zahnarzt")
    ev = db.query(Event).filter(Event.uid == "src-1").first()
    ev.start = datetime(2026, 6, 15, 12, 0)
    ev.end = datetime(2026, 6, 15, 13, 0)
    db.commit()
    db.close()

    r = client.post(f"/api/event-shares/{share_id}/sync-snapshot")
    assert r.status_code == 200
    assert r.json()["has_drift"] is False

    r2 = client.get("/api/event-shares", params={"source_uid": "src-1"})
    assert r2.json()[0]["has_drift"] is False


def test_instance_drift_durch_override_erkannt(client, auth):
    db = TestingSessionLocal()
    share_id = _make_share(db, datetime(2026, 6, 19, 9, 0), datetime(2026, 6, 19, 10, 0), "Einkaufen", rrule="FREQ=WEEKLY;BYDAY=FR")
    rid = datetime(2026, 6, 26, 9, 0)
    db.add(EventOverride(master_uid="src-1", recurrence_id=rid, start=datetime(2026, 6, 26, 14, 0), end=datetime(2026, 6, 26, 15, 0)))
    db.commit()
    db.close()

    r = client.post(f"/api/event-shares/{share_id}/instances/sync-snapshot", json={"source_recurrence_id": "2026-06-19T09:00:00"})
    assert r.status_code == 200
    # Instanz ohne Override -> nach Sync kein Drift
    assert r.json()["dismissed"] is True


def test_sync_instance_snapshot_unbekannte_freigabe_404(client, auth):
    r = client.post("/api/event-shares/9999/instances/sync-snapshot", json={"source_recurrence_id": "2026-06-19T09:00:00"})
    assert r.status_code == 404
```

- [ ] **Step 2: Test ausführen, erwarteter Fehlschlag**

Run: `cd backend && python -m pytest tests/test_event_shares_drift.py -v`
Expected: FAIL mit 404 (`GET /event-shares` existiert noch nicht)

- [ ] **Step 3: Endpunkte + Helper in `backend/src/app/api/event_shares.py` ergänzen**

Imports am Kopf der Datei erweitern:
```python
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from app.db.models import Event, EventOverride, EventShare, EventShareInstanceState, User
```

Am Dateiende ergänzen:

```python
@router.get("")
def list_shares(
    source_uid: str = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    source = db.query(Event).filter(Event.uid == source_uid).first()
    if source is None:
        raise HTTPException(status_code=404, detail="Quelltermin nicht gefunden")
    service.ensure_calendar_access(db, user, source.calendar_id)

    shares = db.query(EventShare).filter(EventShare.source_uid == source_uid).all()
    return [_share_out(s, _series_has_drift(s, source)) for s in shares]


@router.post("/{share_id}/sync-snapshot")
def sync_snapshot(
    share_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    share = db.query(EventShare).filter(EventShare.id == share_id).first()
    if share is None:
        raise HTTPException(status_code=404, detail="Freigabe nicht gefunden")
    source = db.query(Event).filter(Event.uid == share.source_uid).first()
    if source is None:
        raise HTTPException(status_code=404, detail="Quelltermin nicht gefunden")
    service.ensure_calendar_access(db, user, source.calendar_id)

    share.snapshot_start = source.start
    share.snapshot_end = source.end
    share.snapshot_summary = source.summary
    share.snapshot_rrule = source.rrule
    share.dismissed = True
    db.commit()
    return _share_out(share, has_drift=False)


def _instance_snapshot_from_source(
    db: Session, source_uid: str, recurrence_id: datetime,
) -> tuple[datetime | None, datetime | None, str | None, bool]:
    """Liest den aktuell wirksamen Zustand einer Instanz (Override oder Master-Werte).

    Rückgabe: (start, end, summary, deleted)
    """
    rid_naive = _naive(recurrence_id)
    override = db.query(EventOverride).filter(
        EventOverride.master_uid == source_uid,
        EventOverride.recurrence_id == rid_naive,
    ).first()
    if override is not None:
        if override.start is None:
            return None, None, None, True  # EXDATE-Sentinel: Instanz gelöscht
        return override.start, override.end, override.summary, False

    source = db.query(Event).filter(Event.uid == source_uid).first()
    if source is None or source.start is None or source.end is None:
        return None, None, None, False
    duration = source.end - source.start
    return rid_naive, rid_naive + duration, source.summary, False


def _instance_overridden(db: Session, source_uid: str, recurrence_id: datetime) -> bool:
    return db.query(EventOverride).filter(
        EventOverride.master_uid == source_uid,
        EventOverride.recurrence_id == _naive(recurrence_id),
    ).first() is not None


def _instance_has_drift(db: Session, share: EventShare, source_uid: str, recurrence_id: datetime) -> bool:
    rid_naive = _naive(recurrence_id)
    cur_start, cur_end, cur_summary, cur_deleted = _instance_snapshot_from_source(db, source_uid, rid_naive)

    state = db.query(EventShareInstanceState).filter(
        EventShareInstanceState.share_id == share.id,
        EventShareInstanceState.source_recurrence_id == rid_naive,
    ).first()
    if state is None:
        # Noch nie synchronisiert: nur Drift, wenn diese Instanz vom Standard-Serienverlauf
        # abweicht (Override/Löschung vorhanden). Reine, unveränderte RRULE-Instanzen sind kein Drift.
        return cur_deleted or _instance_overridden(db, source_uid, rid_naive)

    return (
        state.snapshot_deleted != cur_deleted
        or state.snapshot_start != cur_start
        or state.snapshot_end != cur_end
        or state.snapshot_summary != cur_summary
    )


class InstanceSync(BaseModel):
    source_recurrence_id: datetime


@router.post("/{share_id}/instances/sync-snapshot")
def sync_instance_snapshot(
    share_id: int,
    body: InstanceSync,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    share = db.query(EventShare).filter(EventShare.id == share_id).first()
    if share is None:
        raise HTTPException(status_code=404, detail="Freigabe nicht gefunden")
    source = db.query(Event).filter(Event.uid == share.source_uid).first()
    if source is None:
        raise HTTPException(status_code=404, detail="Quelltermin nicht gefunden")
    service.ensure_calendar_access(db, user, source.calendar_id)

    rid_naive = _naive(body.source_recurrence_id)
    start, end, summary, deleted = _instance_snapshot_from_source(db, share.source_uid, rid_naive)

    state = db.query(EventShareInstanceState).filter(
        EventShareInstanceState.share_id == share.id,
        EventShareInstanceState.source_recurrence_id == rid_naive,
    ).first()
    if state is None:
        state = EventShareInstanceState(share_id=share.id, source_recurrence_id=rid_naive)
        db.add(state)

    state.snapshot_start = start
    state.snapshot_end = end
    state.snapshot_summary = summary
    state.snapshot_deleted = deleted
    state.dismissed = True
    state.updated_at = datetime.utcnow()
    db.commit()

    return {"share_id": share.id, "source_recurrence_id": rid_naive.isoformat(), "dismissed": True}
```

- [ ] **Step 4: Tests ausführen**

Run: `cd backend && python -m pytest tests/test_event_shares_drift.py -v`
Expected: PASS (5 Tests)

- [ ] **Step 5: Vollständige Backend-Testsuite laufen lassen**

Run: `cd backend && python -m pytest -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/app/api/event_shares.py backend/tests/test_event_shares_drift.py
git commit -m "feat: add drift detection and snapshot-sync endpoints for event shares"
```

---

### Task 4: `shared_drift`-Flag in `GET /events` integrieren

**Files:**
- Modify: `backend/src/app/api/events.py`
- Test: `backend/tests/test_events_shared_drift.py` (neu)

**Interfaces:**
- Consumes: `_series_has_drift`, `_instance_has_drift`, `_naive` aus `app.api.event_shares` (Task 2/3).
- Produces: jedes von `GET /events` gelieferte Dict trägt jetzt zusätzlich `"shared_drift": bool`.

**Scope-Hinweis:** Nur `GET /events` (Kalender-Chip-Ansichten) bekommt das Flag — `GET /events/search` liefert keine gerenderten Chips mit Icons und bleibt unverändert (YAGNI).

- [ ] **Step 1: Schreibe den fehlschlagenden Test**

```python
# backend/tests/test_events_shared_drift.py
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import sessionmaker

from app.main import app
from app.auth.security import hash_password
from app.db.models import Base, Event, EventOverride, Calendar, User, EventShare
from app.db.session import get_db

TEST_DB_URL = "sqlite:///:memory:"
engine = create_engine(TEST_DB_URL, connect_args={"check_same_thread": False}, poolclass=StaticPool)
TestingSessionLocal = sessionmaker(bind=engine)

CAL = "https://nc.example.com/dav/personal/"
OMA_OPA_CAL = "https://nc.example.com/dav/oma-opa/"


def override_get_db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setitem(app.dependency_overrides, get_db, override_get_db)
    monkeypatch.setattr("app.caldav.sync.run_sync", lambda: None)
    monkeypatch.setattr("app.scheduler.run_sync", lambda: None)
    return TestClient(app)


@pytest.fixture()
def auth(client):
    db = TestingSessionLocal()
    db.add(User(email="a@test.local", display_name="Admin", password_hash=hash_password("testpassword123"),
                role="admin", must_change_password=False, created_at=datetime.utcnow()))
    db.commit()
    db.close()
    r = client.post("/api/auth/login", json={"email": "a@test.local", "password": "testpassword123"})
    assert r.status_code == 200
    return {}


def test_nicht_geteiltes_event_hat_kein_drift_flag(client, auth):
    db = TestingSessionLocal()
    db.add(Calendar(id=CAL, name="Privat", color="#5b8fff"))
    db.add(Event(uid="ev-1", calendar_id=CAL, summary="Meeting",
                 start=datetime(2026, 6, 15, 10, 0), end=datetime(2026, 6, 15, 11, 0), all_day=False))
    db.commit()
    db.close()

    r = client.get("/api/events", params={"from": "2026-06-01T00:00:00", "to": "2026-06-30T00:00:00"})
    assert r.status_code == 200
    body = r.json()
    assert body[0]["shared_drift"] is False


def test_geteiltes_event_mit_drift_wird_geflaggt(client, auth):
    db = TestingSessionLocal()
    db.add_all([
        Calendar(id=CAL, name="Privat", color="#5b8fff"),
        Calendar(id=OMA_OPA_CAL, name="Oma & Opa", color="#f2a65a"),
    ])
    db.add(Event(uid="ev-1", calendar_id=CAL, summary="Zahnarzt geändert",
                 start=datetime(2026, 6, 15, 10, 0), end=datetime(2026, 6, 15, 11, 0), all_day=False))
    db.add(Event(uid="shared-1", calendar_id=OMA_OPA_CAL, summary="Kinder hüten",
                 start=datetime(2026, 6, 15, 9, 45), end=datetime(2026, 6, 15, 11, 15), all_day=False))
    db.add(EventShare(
        source_uid="ev-1", shared_uid="shared-1", target_calendar_id=OMA_OPA_CAL,
        snapshot_start=datetime(2026, 6, 15, 10, 0), snapshot_end=datetime(2026, 6, 15, 11, 0),
        snapshot_summary="Zahnarzt", snapshot_rrule=None,
        buffer_before_minutes=15, buffer_after_minutes=15, dismissed=False, created_at=datetime.utcnow(),
    ))
    db.commit()
    db.close()

    r = client.get("/api/events", params={"from": "2026-06-01T00:00:00", "to": "2026-06-30T00:00:00"})
    events = {e["uid"]: e for e in r.json()}
    assert events["ev-1"]["shared_drift"] is True
    assert events["shared-1"]["shared_drift"] is False  # die Kopie selbst hat kein Flag
```

- [ ] **Step 2: Test ausführen, erwarteter Fehlschlag**

Run: `cd backend && python -m pytest tests/test_events_shared_drift.py -v`
Expected: FAIL mit `KeyError: 'shared_drift'`

- [ ] **Step 3: `backend/src/app/api/events.py` anpassen**

Import ergänzen (bei den bestehenden `from app.db.models import Event, EventOverride, User`):
```python
from app.api.event_shares import _instance_has_drift, _naive, _series_has_drift
from app.db.models import Event, EventOverride, EventShare, User
```

`expand_rrule_event`-Signatur erweitern (bestehende Zeile `def expand_rrule_event(event: Event, from_: datetime, to: datetime, overrides: dict[str, EventOverride] | None = None,) -> list[dict]:`):

```python
def expand_rrule_event(
    event: Event,
    from_: datetime,
    to: datetime,
    overrides: dict[str, EventOverride] | None = None,
    drift_fn=None,
) -> list[dict]:
```

In allen drei `result.append({...})`-Blöcken innerhalb `expand_rrule_event` (Override-Zweig, Normal-Instanz-Zweig, Fallback-Zweig) direkt nach `"rrule": event.rrule,` die Zeile ergänzen:
```python
        "shared_drift": drift_fn(event.uid, inst.isoformat()) if drift_fn else False,
```
(im Fallback-Zweig entsprechend `event.start.isoformat() if event.start else None` statt `inst.isoformat()` — dort lautet die Zeile `"shared_drift": drift_fn(event.uid, event.start.isoformat()) if drift_fn and event.start else False,`)

In `get_events()`, direkt nach dem bestehenden Block
```python
    non_rrule = (
        q.filter(Event.rrule.is_(None), Event.start < to, Event.end > from_)
        .all()
    )
    rrule_events = q.filter(
        Event.rrule.isnot(None),
        Event.start < to,
    ).all()
```
einfügen:
```python
    all_events_by_uid: dict[str, Event] = {e.uid: e for e in non_rrule + rrule_events}
    shares_by_source: dict[str, list[EventShare]] = {}
    if all_events_by_uid:
        for share in db.query(EventShare).filter(EventShare.source_uid.in_(all_events_by_uid.keys())).all():
            shares_by_source.setdefault(share.source_uid, []).append(share)

    def drift_fn(uid: str, recurrence_id: str | None) -> bool:
        shares = shares_by_source.get(uid)
        if not shares:
            return False
        source = all_events_by_uid[uid]
        for share in shares:
            if _series_has_drift(share, source):
                return True
            if recurrence_id is not None:
                rid_dt = datetime.fromisoformat(recurrence_id)
                if _instance_has_drift(db, share, uid, rid_dt):
                    return True
        return False
```

Den `non_rrule`-Dict-Aufbau erweitern — in
```python
    for e in non_rrule:
        result.append({
            "uid": e.uid,
            ...
            "rrule": None,
        })
```
nach `"rrule": None,` ergänzen:
```python
            "shared_drift": drift_fn(e.uid, None),
```

Den `rrule_events`-Aufruf erweitern — bestehende Zeile
```python
    for e in rrule_events:
        result.extend(expand_rrule_event(e, from_, to, overrides_by_uid.get(e.uid, {})))
```
ändern zu:
```python
    for e in rrule_events:
        result.extend(expand_rrule_event(e, from_, to, overrides_by_uid.get(e.uid, {}), drift_fn))
```

- [ ] **Step 4: Tests ausführen**

Run: `cd backend && python -m pytest tests/test_events_shared_drift.py -v`
Expected: PASS (2 Tests)

- [ ] **Step 5: Vollständige Backend-Testsuite laufen lassen (Regression, insb. `test_recurrence.py`, `test_phase2_api.py`)**

Run: `cd backend && python -m pytest -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/app/api/events.py backend/tests/test_events_shared_drift.py
git commit -m "feat: expose shared_drift flag on GET /events results"
```

---

### Task 5: Aufräumen von `event_shares` beim Löschen des Master-Events

**Files:**
- Modify: `backend/src/app/api/events.py`
- Test: `backend/tests/test_event_shares_delete_cleanup.py` (neu)

**Interfaces:**
- Consumes: `EventShare`, `EventShareInstanceState` (Task 1).

Kontext: SQLite-FK-Constraints sind in diesem Projekt nicht aktiv (siehe Global Constraints) — `ondelete="CASCADE"` auf `EventShare.source_uid`/`shared_uid` wird **nicht** von der DB durchgesetzt. Ohne explizites Aufräumen blieben verwaiste `event_shares`-Zeilen zurück, sobald Quelltermin oder Kopie gelöscht wird.

- [ ] **Step 1: Schreibe den fehlschlagenden Test**

```python
# backend/tests/test_event_shares_delete_cleanup.py
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import sessionmaker

from app.main import app
from app.auth.security import hash_password
from app.db.models import Base, Event, Calendar, User, EventShare
from app.db.session import get_db

TEST_DB_URL = "sqlite:///:memory:"
engine = create_engine(TEST_DB_URL, connect_args={"check_same_thread": False}, poolclass=StaticPool)
TestingSessionLocal = sessionmaker(bind=engine)

CAL = "https://nc.example.com/dav/personal/"
OMA_OPA_CAL = "https://nc.example.com/dav/oma-opa/"


def override_get_db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=engine)
    db = TestingSessionLocal()
    db.add_all([
        Calendar(id=CAL, name="Privat", color="#5b8fff"),
        Calendar(id=OMA_OPA_CAL, name="Oma & Opa", color="#f2a65a"),
    ])
    db.add(Event(uid="src-1", calendar_id=CAL, etag='"e1"', summary="Zahnarzt",
                 start=datetime(2026, 6, 15, 10, 0), end=datetime(2026, 6, 15, 11, 0), all_day=False))
    db.add(Event(uid="shared-1", calendar_id=OMA_OPA_CAL, etag='"e2"', summary="Kinder hüten",
                 start=datetime(2026, 6, 15, 10, 0), end=datetime(2026, 6, 15, 11, 0), all_day=False))
    db.add(EventShare(
        source_uid="src-1", shared_uid="shared-1", target_calendar_id=OMA_OPA_CAL,
        snapshot_start=datetime(2026, 6, 15, 10, 0), snapshot_end=datetime(2026, 6, 15, 11, 0),
        snapshot_summary="Zahnarzt", snapshot_rrule=None,
        buffer_before_minutes=0, buffer_after_minutes=0, dismissed=False, created_at=datetime.utcnow(),
    ))
    db.commit()
    db.close()
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setitem(app.dependency_overrides, get_db, override_get_db)
    monkeypatch.setattr("app.caldav.sync.run_sync", lambda: None)
    monkeypatch.setattr("app.scheduler.run_sync", lambda: None)
    return TestClient(app)


@pytest.fixture()
def auth(client):
    db = TestingSessionLocal()
    db.add(User(email="a@test.local", display_name="Admin", password_hash=hash_password("testpassword123"),
                role="admin", must_change_password=False, created_at=datetime.utcnow()))
    db.commit()
    db.close()
    r = client.post("/api/auth/login", json={"email": "a@test.local", "password": "testpassword123"})
    assert r.status_code == 200
    return {}


def test_loeschen_des_quelltermins_raeumt_event_share_auf(client, auth):
    with patch("app.api.events.delete_event"):
        r = client.delete("/api/events/src-1", params={"etag": '"e1"'})
    assert r.status_code == 204

    db = TestingSessionLocal()
    assert db.query(EventShare).filter(EventShare.source_uid == "src-1").first() is None
    # Die Kopie selbst bleibt unangetastet
    assert db.query(Event).filter(Event.uid == "shared-1").first() is not None
    db.close()


def test_loeschen_der_kopie_raeumt_event_share_auf(client, auth):
    with patch("app.api.events.delete_event"):
        r = client.delete("/api/events/shared-1", params={"etag": '"e2"'})
    assert r.status_code == 204

    db = TestingSessionLocal()
    assert db.query(EventShare).filter(EventShare.shared_uid == "shared-1").first() is None
    assert db.query(Event).filter(Event.uid == "src-1").first() is not None
    db.close()
```

- [ ] **Step 2: Test ausführen, erwarteter Fehlschlag**

Run: `cd backend && python -m pytest tests/test_event_shares_delete_cleanup.py -v`
Expected: FAIL — `EventShare`-Zeile bleibt nach dem Löschen bestehen

- [ ] **Step 3: `backend/src/app/api/events.py` anpassen**

Imports erweitern (gleiche Stelle wie Task 4):
```python
from app.db.models import Event, EventOverride, EventShare, EventShareInstanceState, User
```

Am Ende von `delete_event_endpoint`, im Zweig "Ganzes Event löschen", die bestehenden Zeilen

```python
    db.query(EventOverride).filter(EventOverride.master_uid == uid).delete(synchronize_session=False)
    db.delete(event)
    db.commit()
```

ersetzen durch:

```python
    share_ids = [
        row[0] for row in db.query(EventShare.id).filter(
            (EventShare.source_uid == uid) | (EventShare.shared_uid == uid)
        ).all()
    ]
    if share_ids:
        db.query(EventShareInstanceState).filter(
            EventShareInstanceState.share_id.in_(share_ids)
        ).delete(synchronize_session=False)
        db.query(EventShare).filter(EventShare.id.in_(share_ids)).delete(synchronize_session=False)

    db.query(EventOverride).filter(EventOverride.master_uid == uid).delete(synchronize_session=False)
    db.delete(event)
    db.commit()
```

- [ ] **Step 4: Tests ausführen**

Run: `cd backend && python -m pytest tests/test_event_shares_delete_cleanup.py -v`
Expected: PASS (2 Tests)

- [ ] **Step 5: Vollständige Backend-Testsuite laufen lassen**

Run: `cd backend && python -m pytest -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/app/api/events.py backend/tests/test_event_shares_delete_cleanup.py
git commit -m "fix: clean up event_shares rows when source or shared event is deleted"
```

---

### Task 6: Frontend-Typen + API-Client für Event-Shares

**Files:**
- Modify: `frontend/src/types/index.ts`
- Create: `frontend/src/api/shares.ts`

**Interfaces:**
- Produces: `EventShare` (TS-Interface, Felder identisch zu `_share_out()` in Task 2), `CreateEventSharePayload`, `createEventShare(payload) -> Promise<EventShare>`, `listEventShares(sourceUid) -> Promise<EventShare[]>`, `syncShareSnapshot(shareId) -> Promise<EventShare>`, `syncInstanceShareSnapshot(shareId, sourceRecurrenceId) -> Promise<void>`. `CalendarEvent` bekommt zusätzlich `shared_drift?: boolean`.

- [ ] **Step 1: `frontend/src/types/index.ts` erweitern**

Im bestehenden `CalendarEvent`-Interface (Zeile 7–20), nach `rrule?: string | null;` ergänzen:
```typescript
  shared_drift?: boolean;
```

Am Dateiende ergänzen:
```typescript
export interface EventShare {
  id: number;
  source_uid: string;
  shared_uid: string;
  target_calendar_id: string;
  snapshot_start: string;
  snapshot_end: string;
  snapshot_summary: string;
  snapshot_rrule: string | null;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  has_drift: boolean;
}

export interface CreateEventSharePayload {
  source_uid: string;
  summary: string;
  start: string;
  end: string;
  buffer_before_minutes?: number;
  buffer_after_minutes?: number;
}
```

- [ ] **Step 2: `frontend/src/api/shares.ts` anlegen**

```typescript
// frontend/src/api/shares.ts
//
// Schreib- und Lese-Operationen für die "Mit Oma + Opa teilen"-Funktion.

import type { CreateEventSharePayload, EventShare, WriteError } from '../types';

const headers = () => ({
  'Content-Type': 'application/json',
});

function mapError(status: number, body?: any): WriteError {
  if (status === 400) return { type: 'bad_request', message: body?.detail ?? 'Ungültige Anfrage' };
  if (status === 401) return { type: 'auth' };
  if (status === 404) return { type: 'not_found' };
  if (status === 409) return { type: 'conflict' };
  if (status === 503) return { type: 'caldav_down' };
  return { type: 'unknown', status };
}

async function parseError(res: Response): Promise<WriteError> {
  let body: any = undefined;
  try {
    body = await res.json();
  } catch {
    // ignore
  }
  return mapError(res.status, body);
}

// ── POST /api/event-shares ───────────────────────────────────────

export async function createEventShare(payload: CreateEventSharePayload): Promise<EventShare> {
  const res = await fetch('/api/event-shares', {
    method: 'POST',
    credentials: 'include',
    headers: headers(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

// ── GET /api/event-shares?source_uid= ────────────────────────────

export async function listEventShares(sourceUid: string): Promise<EventShare[]> {
  const url = new URL('/api/event-shares', window.location.origin);
  url.searchParams.set('source_uid', sourceUid);
  const res = await fetch(url.toString(), { credentials: 'include' });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

// ── POST /api/event-shares/{id}/sync-snapshot ────────────────────

export async function syncShareSnapshot(shareId: number): Promise<EventShare> {
  const res = await fetch(`/api/event-shares/${shareId}/sync-snapshot`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

// ── POST /api/event-shares/{id}/instances/sync-snapshot ──────────

export async function syncInstanceShareSnapshot(shareId: number, sourceRecurrenceId: string): Promise<void> {
  const res = await fetch(`/api/event-shares/${shareId}/instances/sync-snapshot`, {
    method: 'POST',
    credentials: 'include',
    headers: headers(),
    body: JSON.stringify({ source_recurrence_id: sourceRecurrenceId }),
  });
  if (!res.ok) throw await parseError(res);
}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: keine neuen Fehler (bestehende Dateien kompilieren weiterhin, `shares.ts` und die `types/index.ts`-Erweiterung sind typkorrekt)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types/index.ts frontend/src/api/shares.ts
git commit -m "feat: add EventShare types and API client"
```

---

### Task 7: `ShareDialog`-Komponente + "Mit Oma + Opa teilen"-Button

**Files:**
- Create: `frontend/src/components/ShareDialog.tsx`
- Modify: `frontend/src/components/EventPopup.tsx`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `createEventShare` aus Task 6; `useToast` aus `frontend/src/components/Toast.tsx`.
- Produces: `<ShareDialog event={CalendarEvent} onClose={() => void} onShared={(share: EventShare) => void} />`.

**Platzierung des Buttons (Entscheidung, siehe Spec "Offene Implementierungsfragen"):** In der Action-Row von `EventPopup.tsx` (Termin-Detail-Popup), neben Bearbeiten/Duplizieren/Löschen — analog zu Spec Zeile 35 ("Button/Menüpunkt in Termin-Detail").

- [ ] **Step 1: `frontend/src/components/ShareDialog.tsx` anlegen**

```tsx
// frontend/src/components/ShareDialog.tsx
//
// Dialog für die Aktion "Mit Oma + Opa teilen": Titel/Start/Ende
// vorausgefüllt aus dem Quelltermin, frei editierbar, plus zwei
// Zeit-Puffer-Felder. Bei Serienterminen wird die ganze Serie kopiert.

import { useState } from 'react';
import { createEventShare } from '../api/shares';
import { useToast } from './Toast';
import type { CalendarEvent, WriteError } from '../types';

interface Props {
  event: CalendarEvent;
  onClose: () => void;
  onShared: () => void;
}

function addMinutes(iso: string, minutes: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString().slice(0, 16);
}

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ShareDialog({ event, onClose, onShared }: Props) {
  const { showToast } = useToast();
  const [summary, setSummary] = useState(event.summary);
  const [start, setStart] = useState(toLocalInputValue(event.start));
  const [end, setEnd] = useState(toLocalInputValue(event.end));
  const [bufferBefore, setBufferBefore] = useState(0);
  const [bufferAfter, setBufferAfter] = useState(0);
  const [saving, setSaving] = useState(false);

  const applyBuffers = (before: number, after: number) => {
    setStart(toLocalInputValue(addMinutes(event.start, -before)));
    setEnd(toLocalInputValue(addMinutes(event.end, after)));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await createEventShare({
        source_uid: event.uid,
        summary,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        buffer_before_minutes: bufferBefore,
        buffer_after_minutes: bufferAfter,
      });
      showToast('Mit Oma + Opa geteilt', 'success');
      onShared();
      onClose();
    } catch (err) {
      const writeErr = err as WriteError;
      if (writeErr.type === 'bad_request') {
        showToast(writeErr.message, 'error');
      } else {
        showToast('Freigabe konnte nicht angelegt werden.', 'error');
      }
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="rec-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="rec-dialog-header">
          <h3 className="rec-dialog-title">Mit Oma + Opa teilen</h3>
          {event.is_recurring && (
            <p className="rec-dialog-sub">
              „{event.summary}" ist ein Serientermin — die ganze Serie wird kopiert, der Puffer gilt für jede Instanz gleich.
            </p>
          )}
        </div>

        <div className="share-dialog-body">
          <label className="share-field">
            <span>Titel</span>
            <input type="text" value={summary} onChange={(e) => setSummary(e.target.value)} />
          </label>
          <label className="share-field">
            <span>Start</span>
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="share-field">
            <span>Ende</span>
            <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <div className="share-buffer-row">
            <label className="share-field">
              <span>+Min. davor</span>
              <input
                type="number"
                min={0}
                value={bufferBefore}
                onChange={(e) => {
                  const v = Number(e.target.value) || 0;
                  setBufferBefore(v);
                  applyBuffers(v, bufferAfter);
                }}
              />
            </label>
            <label className="share-field">
              <span>+Min. danach</span>
              <input
                type="number"
                min={0}
                value={bufferAfter}
                onChange={(e) => {
                  const v = Number(e.target.value) || 0;
                  setBufferAfter(v);
                  applyBuffers(bufferBefore, v);
                }}
              />
            </label>
          </div>
        </div>

        <div className="rec-dialog-footer">
          <button className="rec-cancel" onClick={onClose} disabled={saving}>
            Abbrechen
          </button>
          <button className="rec-option" style={{ flex: 'none', padding: '8px 16px' }} onClick={handleSave} disabled={saving}>
            {saving ? 'Teilen…' : 'Teilen'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: CSS für `.share-dialog-body`/`.share-field`/`.share-buffer-row` in `frontend/src/index.css` ergänzen**

Am Ende der Datei anfügen:
```css
/* ─── Share-Dialog ("Mit Oma + Opa teilen") ─────────────────────── */
.share-dialog-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0 20px 16px;
}
.share-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.85em;
  color: var(--text-2);
}
.share-field input {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--text-1);
  font-size: 0.95em;
}
.share-buffer-row {
  display: flex;
  gap: 12px;
}
.share-buffer-row .share-field {
  flex: 1;
}
```

(Hinweis: `var(--surface-2)`, `var(--border)`, `var(--text-1)`, `var(--text-2)` sind bestehende Tokens aus `:root` in `index.css` — vor dem Schreiben kurz prüfen, ob die Namen exakt so lauten, sonst an die tatsächlichen Token-Namen anpassen.)

- [ ] **Step 3: Button in `frontend/src/components/EventPopup.tsx` ergänzen**

Props-Interface (Zeile 23–32) um `onShare` erweitern:
```typescript
interface Props {
  event: CalendarEvent;
  calendarColor: string;
  calendarName: string;
  anchorPos: { x: number; y: number };
  onClose: () => void;
  onEdit: (event: CalendarEvent) => void;
  onDuplicate: (event: CalendarEvent) => void;
  onCopy: (event: CalendarEvent) => void;
  onShare: (event: CalendarEvent) => void;
  onDeleted: (uid: string, recurrenceId?: string | null, mode?: "single" | "future" | "all") => void;
}
```

Komponenten-Signatur entsprechend um `onShare` erweitern (bei den destrukturierten Props).

In der Action-Row (nach dem Duplizieren-Button, vor dem Löschen-Button) einfügen:
```tsx
              <button
                style={S.btnEdit}
                onClick={() => {
                  onClose();
                  onShare(event);
                }}
                title="Mit Oma + Opa teilen"
                aria-label="Mit Oma + Opa teilen"
              >
                👪
              </button>
```

- [ ] **Step 4: In `frontend/src/App.tsx` einhängen**

Nach Zeile 156 (`const [duplicateModal, setDuplicateModal] = useState<CalendarEvent | null>(null);`) neuen State ergänzen:
```typescript
  const [shareModal, setShareModal] = useState<CalendarEvent | null>(null);
```

Im `<EventPopup ...>`-Block (ab Zeile 836) die Props um `onShare={(ev) => { setSelectedEvent(null); setShareModal(ev); }}` ergänzen (z.B. direkt nach der `onDuplicate`-Zeile).

Nach dem `{duplicateModal && (<EventFormModal .../>)}`-Block (endet vor Zeile 914 `{editModal && (`) einfügen:
```tsx
        {shareModal && (
          <ShareDialog
            event={shareModal}
            onClose={() => setShareModal(null)}
            onShared={() => setRefreshNonce((n) => n + 1)}
          />
        )}
```

Import ergänzen (bei den bestehenden Component-Imports, Zeile 22):
```typescript
import { ShareDialog } from './components/ShareDialog';
```

- [ ] **Step 5: Build/Typecheck**

Run: `cd frontend && npx tsc --noEmit && npm run build`
Expected: kein Fehler

- [ ] **Step 6: Manuelle Verifikation über das `run`-Skill**

Backend + Frontend starten, einen Termin öffnen, auf "👪" klicken, Dialog ausfüllen, "Teilen" klicken → Toast "Mit Oma + Opa geteilt" erscheint. (`oma_opa_calendar_id` muss in `.env`/Umgebung gesetzt sein, sonst 400-Fehler-Toast — für den manuellen Test einen beliebigen existierenden zweiten Kalender als `OMA_OPA_CALENDAR_ID` setzen.)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/ShareDialog.tsx frontend/src/components/EventPopup.tsx frontend/src/App.tsx frontend/src/index.css
git commit -m "feat: add ShareDialog and 'Mit Oma + Opa teilen' button"
```

---

### Task 8: Persistentes Drift-Icon an Termin-Chips

**Files:**
- Modify: `frontend/src/components/MonthView.tsx`
- Modify: `frontend/src/components/WeekView.tsx`
- Modify: `frontend/src/components/DayView.tsx`
- Modify: `frontend/src/components/AgendaView.tsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: `CalendarEvent.shared_drift` (Task 4/6).

**Scope-Hinweis:** Icon wird an denselben 6 Stellen ergänzt, an denen bereits `.recur-icon` gerendert wird (analog zur Spec-Vorgabe "analog zum bestehenden Wiederholungssymbol"). Kompakte Chip-Varianten ohne `.recur-icon` (`week-event-compact`, `day-event-compact`) bekommen aus Konsistenzgründen ebenfalls kein neues Icon.

- [ ] **Step 1: CSS-Klasse in `frontend/src/index.css` ergänzen**

Direkt nach dem bestehenden `.recur-icon`-Block (Zeile 59–68) einfügen:
```css
.shared-drift-icon {
  flex-shrink: 0;
  margin-left: 4px;
  padding-left: 4px;
  font-size: 0.85em;
  line-height: 1;
  color: var(--accent);
  opacity: 1;
}
```

- [ ] **Step 2: `MonthView.tsx` (Zeile 105–111) ergänzen**

Nach dem bestehenden `.recur-icon`-Block:
```jsx
{ev.is_recurring && (
  <span className="recur-icon" title="Wiederholt sich" aria-label="Wiederholt sich">⟲</span>
)}
{ev.shared_drift && (
  <span className="shared-drift-icon" title="Abweichung bei Oma+Opa" aria-label="Abweichung bei Oma+Opa">⚠</span>
)}
```

- [ ] **Step 3: `WeekView.tsx` an beiden Stellen (Zeile 168–175 timed, Zeile 355–362 allday) analog ergänzen**

```jsx
{ev.shared_drift && (
  <span className="shared-drift-icon" title="Abweichung bei Oma+Opa" aria-label="Abweichung bei Oma+Opa">⚠</span>
)}
```
jeweils direkt nach dem bestehenden `.recur-icon`-Block.

- [ ] **Step 4: `DayView.tsx` an beiden Stellen (Zeile 156–168 allday, Zeile 312–319 timed) analog ergänzen**

Gleicher Snippet wie Step 3, jeweils nach dem `.recur-icon`-Block.

- [ ] **Step 5: `AgendaView.tsx` (Zeile 133–137) analog ergänzen**

Gleicher Snippet wie Step 3.

- [ ] **Step 6: Build/Typecheck**

Run: `cd frontend && npx tsc --noEmit && npm run build`
Expected: kein Fehler

- [ ] **Step 7: Manuelle Verifikation über das `run`-Skill**

Geteilten Termin im Backend anlegen (Task 2/7), Original-Termin-Titel/Zeit ändern → Icon "⚠" erscheint in Month/Week/Day/Agenda-Ansicht am betroffenen Chip.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/MonthView.tsx frontend/src/components/WeekView.tsx frontend/src/components/DayView.tsx frontend/src/components/AgendaView.tsx frontend/src/index.css
git commit -m "feat: show drift indicator icon on shared event chips"
```

---

### Task 9: Drift-Resolution-Dialog in `EventPopup.tsx`

**Files:**
- Create: `frontend/src/components/ShareDriftDialog.tsx`
- Modify: `frontend/src/components/EventPopup.tsx`

**Interfaces:**
- Consumes: `listEventShares`, `syncShareSnapshot`, `syncInstanceShareSnapshot` (Task 6); `updateEvent` aus `frontend/src/api/write.ts`.
- Produces: `<ShareDriftDialog share={EventShare} sourceEvent={CalendarEvent} onClose={() => void} onResolved={() => void} />`.

**Interaktionsentscheidung:** Das Chip-Icon aus Task 8 ist rein dekorativ (kein eigener Click-Handler, analog zu `.recur-icon`) — Klick auf den Chip öffnet wie gewohnt `EventPopup`. Dort erscheint bei `event.shared_drift === true` ein Hinweis-Banner mit "Prüfen"-Button, der `ShareDriftDialog` öffnet. Das erfüllt die Spec-Anforderung ("Klick auf Icon oder 'Aktualisieren' öffnet den Ziel-Termin … zur Kontrolle") ohne Click-Handler-Duplizierung über 6 Chip-Stellen.

- [ ] **Step 1: `frontend/src/components/ShareDriftDialog.tsx` anlegen**

```tsx
// frontend/src/components/ShareDriftDialog.tsx
//
// Zeigt die berechneten neuen Werte (Original ± Puffer) zur Kontrolle
// vor dem Übernehmen — kein stilles Auto-Überschreiben. Zwei Optionen:
// "Aktualisieren" (Kopie anpassen) oder "Ignorieren" (Snapshot bestätigen).

import { useEffect, useState } from 'react';
import { updateEvent } from '../api/write';
import { syncShareSnapshot, syncInstanceShareSnapshot } from '../api/shares';
import { apiFetch } from '../hooks/api';
import { useToast } from './Toast';
import type { CalendarEvent, EventShare, WriteError } from '../types';

interface Props {
  share: EventShare;
  sourceEvent: CalendarEvent;
  onClose: () => void;
  onResolved: () => void;
}

function addMinutesIso(iso: string, minutes: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

export function ShareDriftDialog({ share, sourceEvent, onClose, onResolved }: Props) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  const newStart = addMinutesIso(sourceEvent.start, -share.buffer_before_minutes);
  const newEnd = addMinutesIso(sourceEvent.end, share.buffer_after_minutes);
  const newSummary = sourceEvent.summary;

  const isInstance = !!sourceEvent.recurrence_id;
  const mappedRecurrenceId = isInstance
    ? addMinutesIso(sourceEvent.recurrence_id as string, share.buffer_before_minutes)
    : undefined;

  const handleIgnore = async () => {
    setBusy(true);
    try {
      if (isInstance && sourceEvent.recurrence_id) {
        await syncInstanceShareSnapshot(share.id, sourceEvent.recurrence_id);
      } else {
        await syncShareSnapshot(share.id);
      }
      showToast('Abweichung ignoriert', 'info');
      onResolved();
      onClose();
    } catch {
      showToast('Konnte Abweichung nicht ignorieren.', 'error');
      setBusy(false);
    }
  };

  const handleUpdate = async () => {
    setBusy(true);
    try {
      // Aktuellen Zustand der Kopie holen (für etag) — enges Zeitfenster um den neuen Termin.
      const from = new Date(newStart);
      from.setDate(from.getDate() - 1);
      const to = new Date(newEnd);
      to.setDate(to.getDate() + 1);
      const events = await apiFetch<CalendarEvent[]>('/api/events', {
        from: from.toISOString(),
        to: to.toISOString(),
        calendar_id: share.target_calendar_id,
      });
      const target = events.find((e) => e.uid === share.shared_uid);
      if (!target) {
        showToast('Kopie nicht gefunden — evtl. noch nicht synchronisiert.', 'error');
        setBusy(false);
        return;
      }

      await updateEvent(share.shared_uid, {
        etag: target.etag ?? '',
        summary: newSummary,
        start: newStart,
        end: newEnd,
        all_day: sourceEvent.all_day,
        recurrence_id: isInstance ? mappedRecurrenceId : undefined,
        mode: isInstance ? 'single' : share.snapshot_rrule ? 'all' : undefined,
      });

      if (isInstance && sourceEvent.recurrence_id) {
        await syncInstanceShareSnapshot(share.id, sourceEvent.recurrence_id);
      } else {
        await syncShareSnapshot(share.id);
      }
      showToast('Bei Oma + Opa aktualisiert', 'success');
      onResolved();
      onClose();
    } catch (err) {
      const writeErr = err as WriteError;
      if (writeErr.type === 'conflict') {
        showToast('Kopie wurde extern geändert — bitte neu laden.', 'warning');
      } else {
        showToast('Aktualisierung fehlgeschlagen.', 'error');
      }
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="rec-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="rec-dialog-header">
          <h3 className="rec-dialog-title">Abweichung bei Oma + Opa</h3>
          <p className="rec-dialog-sub">
            Neue Werte: „{newSummary}", {new Date(newStart).toLocaleString('de-DE')} – {new Date(newEnd).toLocaleString('de-DE')}
          </p>
        </div>
        <div className="rec-dialog-options">
          <button className="rec-option" onClick={handleUpdate} disabled={busy}>
            <div className="rec-option-title">Aktualisieren</div>
            <div className="rec-option-desc">Die Kopie bei Oma + Opa wird auf diese Werte gesetzt.</div>
          </button>
          <button className="rec-option" onClick={handleIgnore} disabled={busy}>
            <div className="rec-option-title">Ignorieren</div>
            <div className="rec-option-desc">Kopie bleibt unverändert, Hinweis verschwindet bis zur nächsten Abweichung.</div>
          </button>
        </div>
        <div className="rec-dialog-footer">
          <button className="rec-cancel" onClick={onClose} disabled={busy}>
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Banner + Dialog-State in `frontend/src/components/EventPopup.tsx` ergänzen**

Import ergänzen:
```typescript
import { listEventShares } from "../api/shares";
import { ShareDriftDialog } from "./ShareDriftDialog";
import type { EventShare } from "../types";
```

State ergänzen (bei den bestehenden `useState`-Zeilen):
```typescript
  const [driftShare, setDriftShare] = useState<EventShare | null>(null);
  const [driftDialogOpen, setDriftDialogOpen] = useState(false);
```

`useEffect` ergänzen (nach dem bestehenden Positionierungs-`useEffect`):
```typescript
  useEffect(() => {
    if (!event.shared_drift) {
      setDriftShare(null);
      return;
    }
    let cancelled = false;
    listEventShares(event.uid)
      .then((shares) => {
        if (cancelled) return;
        setDriftShare(shares.find((s) => s.has_drift) ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [event.uid, event.shared_drift]);
```

Im JSX der Popup-Karte (`popup`-Variable), direkt nach dem Öffnen des Karten-Containers und vor der Action-Row, Banner einfügen:
```tsx
      {driftShare && (
        <div className="share-drift-banner">
          <span>⚠ Abweichung bei Oma + Opa erkannt.</span>
          <button className="rec-cancel" onClick={() => setDriftDialogOpen(true)}>
            Prüfen
          </button>
        </div>
      )}
```

Am Ende der Return-Anweisung (innerhalb des bestehenden `<>...</>`-Fragments, neben `{recurringDeleteDialog && createPortal(...)}`) ergänzen:
```tsx
      {driftDialogOpen && driftShare && createPortal(
        <ShareDriftDialog
          share={driftShare}
          sourceEvent={event}
          onClose={() => setDriftDialogOpen(false)}
          onResolved={() => setDriftShare(null)}
        />,
        document.body,
      )}
```

- [ ] **Step 3: CSS für `.share-drift-banner` in `frontend/src/index.css` ergänzen**

```css
.share-drift-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 20px;
  background: var(--accent-dim);
  color: var(--text-1);
  font-size: 0.85em;
}
```

- [ ] **Step 4: Build/Typecheck**

Run: `cd frontend && npx tsc --noEmit && npm run build`
Expected: kein Fehler

- [ ] **Step 5: Manuelle Verifikation über das `run`-Skill**

Geteilten Termin ändern (Titel/Zeit) → Chip zeigt "⚠" → Termin öffnen → Banner "Abweichung bei Oma + Opa erkannt" → "Prüfen" → Dialog zeigt neue Werte → "Aktualisieren" → Toast "Bei Oma + Opa aktualisiert", Banner verschwindet nach Neuladen.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ShareDriftDialog.tsx frontend/src/components/EventPopup.tsx frontend/src/index.css
git commit -m "feat: add drift resolution dialog (Aktualisieren/Ignorieren) to EventPopup"
```

---

### Task 10: "Auch bei Oma+Opa löschen?"-Intercept beim Löschen

**Files:**
- Modify: `frontend/src/components/EventPopup.tsx`

**Interfaces:**
- Consumes: `listEventShares`, `EventShare` (Task 6); `deleteEvent` aus `frontend/src/api/write.ts` (bereits importiert).

- [ ] **Step 1: State + Fetch beim Öffnen des Löschen-Flows ergänzen**

State ergänzen:
```typescript
  const [allShares, setAllShares] = useState<EventShare[]>([]);
  const [confirmShareDelete, setConfirmShareDelete] = useState(false);
```

Im bestehenden `useEffect` aus Task 9 (oder einem zusätzlichen, einfacheren) alle Shares laden — unabhängig vom Drift-Status, da für den Lösch-Intercept auch nicht-abweichende Freigaben relevant sind:
```typescript
  useEffect(() => {
    let cancelled = false;
    listEventShares(event.uid)
      .then((shares) => {
        if (!cancelled) setAllShares(shares);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [event.uid]);
```
(Ersetzt den in Task 9 Step 2 eingefügten `useEffect` — dort `setDriftShare` aus `allShares` ableiten statt eigenem Fetch: `const driftShare = allShares.find((s) => s.has_drift) ?? null;` als lokale Konstante statt eigenem State, `setDriftShare`-Aufrufe entfallen. `onResolved` in `ShareDriftDialog`-Aufruf ruft stattdessen `refetchShares` — kleine Anpassung: State `allShares` neu laden via denselben `listEventShares`-Call in einer `refetchShares`-Funktion, die sowohl `useEffect` als auch `onResolved` nutzen.)

- [ ] **Step 2: `handleDeleteClick` und `executeDelete` erweitern**

Bestehende `handleDeleteClick` (siehe Codebasis) bleibt für die Scope-Auswahl (single/future/all) bei Serien bzw. den einfachen Confirm bei Einzelterminen unverändert. Neuer Zwischenschritt: bevor `executeDelete` tatsächlich `deleteEvent` aufruft, bei vorhandenen `allShares` erst `confirmShareDelete` anzeigen.

Konkret: `executeDelete` umbenennen in `performDelete` (reine Ausführung, unverändert) und einen neuen Wrapper einführen:
```typescript
  const [pendingDelete, setPendingDelete] = useState<{ recurrenceId?: string | null; mode?: "single" | "future" | "all" } | null>(null);

  const requestDelete = useCallback((recurrenceId?: string | null, mode?: "single" | "future" | "all") => {
    if (allShares.length > 0) {
      setPendingDelete({ recurrenceId, mode });
      setConfirmShareDelete(true);
    } else {
      executeDelete(recurrenceId, mode);
    }
  }, [allShares, executeDelete]);
```

Alle bisherigen direkten `executeDelete(...)`-Aufrufe aus dem `confirmDelete`- und `recurringDeleteDialog`-JSX durch `requestDelete(...)` ersetzen (gleiche Argumente).

`executeDelete` selbst am Ende (nach erfolgreichem `deleteEvent`) um das Mitlöschen der Kopie erweitern, wenn der Nutzer zugestimmt hat:
```typescript
  const executeDelete = useCallback(async (recurrenceId?: string | null, mode?: "single" | "future" | "all", alsoDeleteShared?: boolean) => {
    setDeleting(true);
    try {
      await deleteEvent(event.uid, { etag: event.etag ?? undefined, recurrence_id: recurrenceId, mode });
      showToast("Termin gelöscht", "success");

      if (alsoDeleteShared) {
        for (const share of allShares) {
          try {
            if (recurrenceId) {
              const mappedRid = new Date(recurrenceId);
              mappedRid.setMinutes(mappedRid.getMinutes() + share.buffer_before_minutes);
              await deleteEvent(share.shared_uid, { recurrence_id: mappedRid.toISOString(), mode: "single" });
            } else {
              await deleteEvent(share.shared_uid, { mode: "all" });
            }
          } catch {
            // Best effort — Haupt-Löschung ist bereits erfolgreich, nicht blockieren.
          }
        }
      }

      onDeleted(event.uid, recurrenceId, mode);
      onClose();
    } catch (err) {
      const writeErr = err as WriteError;
      if (writeErr.type === "conflict") {
        showToast("Termin wurde extern geändert – bitte Seite neu laden.", "warning");
      } else if (writeErr.type === "caldav_down") {
        showToast("CalDAV-Server nicht erreichbar – Termin konnte nicht gelöscht werden.", "error");
      } else {
        showToast("Fehler beim Löschen.", "error");
      }
      setDeleting(false);
      setConfirmDelete(false);
      setRecurringDeleteDialog(false);
    }
  }, [event, onDeleted, onClose, showToast, allShares]);
```

`requestDelete` entsprechend den `alsoDeleteShared`-Flag an `executeDelete` weiterreichen, sobald der Nutzer im neuen Confirm-Dialog wählt.

- [ ] **Step 3: Neuen 2-Options-Dialog im JSX ergänzen**

Analog zu `recurringDeleteDialog`, aber mit zwei Optionen statt drei:
```tsx
      {confirmShareDelete && pendingDelete && createPortal(
        <div className="modal-backdrop" onClick={() => setConfirmShareDelete(false)}>
          <div className="rec-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="rec-dialog-header">
              <h3 className="rec-dialog-title">Auch bei Oma + Opa löschen?</h3>
              <p className="rec-dialog-sub">„{event.summary}" ist mit Oma + Opa geteilt.</p>
            </div>
            <div className="rec-dialog-options">
              <button
                className="rec-option"
                onClick={() => {
                  setConfirmShareDelete(false);
                  executeDelete(pendingDelete.recurrenceId, pendingDelete.mode, true);
                }}
              >
                <div className="rec-option-title">Ja, auch dort löschen</div>
                <div className="rec-option-desc">Die Kopie bei Oma + Opa wird ebenfalls entfernt.</div>
              </button>
              <button
                className="rec-option"
                onClick={() => {
                  setConfirmShareDelete(false);
                  executeDelete(pendingDelete.recurrenceId, pendingDelete.mode, false);
                }}
              >
                <div className="rec-option-title">Nein, nur hier löschen</div>
                <div className="rec-option-desc">Die Kopie bei Oma + Opa bleibt bestehen.</div>
              </button>
            </div>
            <div className="rec-dialog-footer">
              <button className="rec-cancel" onClick={() => setConfirmShareDelete(false)}>
                Abbrechen
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
```

- [ ] **Step 4: Build/Typecheck**

Run: `cd frontend && npx tsc --noEmit && npm run build`
Expected: kein Fehler

- [ ] **Step 5: Manuelle Verifikation über das `run`-Skill**

Geteilten Termin löschen → Dialog "Auch bei Oma + Opa löschen?" erscheint → "Ja, auch dort löschen" → beide Termine verschwinden nach Neuladen. Nicht-geteilten Termin löschen → wie bisher, kein neuer Dialog.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/EventPopup.tsx
git commit -m "feat: prompt to also delete grandparent copy when deleting a shared source event"
```

---

## Self-Review

**Spec-Abdeckung:**
- Teilen-Aktion + Dialog (Titel/Start/Ende editierbar, Puffer-Felder) → Task 7
- Einzeltermine → Task 2 (`rrule=None`-Zweig)
- Serientermine (RRULE 1:1 kopiert, Puffer auf jede Instanz gleich) → Task 2 (`rrule=source.rrule`)
- Datenmodell `event_shares` (+ Instanz-Zuordnung, hier als berechneter Offset + `event_share_instance_states`) → Task 1
- Drift-Erkennung Serien-Ebene → Task 3 (`_series_has_drift`)
- Drift-Erkennung Instanz-Ebene (Override/EXDATE) → Task 3 (`_instance_has_drift`)
- Toast + persistentes Icon → Task 8 (Icon), Task 9 (Banner im Popup als Toast-Äquivalent, da das bestehende Toast-System keine Action-Buttons unterstützt — Abweichung von der Spec-Formulierung "Toast", bewusst dokumentiert)
- Klick öffnet Ziel-Termin vorausgefüllt zur Kontrolle, kein Auto-Überschreiben → Task 9 (`ShareDriftDialog`)
- "Ignorieren" aktualisiert Snapshot, ändert Kopie nicht → Task 3 (`sync-snapshot`), Task 9 (`handleIgnore`)
- Löschen löst Hinweis aus statt automatischem Mitlöschen → Task 10
- Out of Scope (keine bidirektionale Sync, kein stiller Auto-Sync, keine Read-Only-Rechte) → nirgends implementiert, korrekt ausgelassen

**Platzhalter-Scan:** Keine TBD/TODO-Marker; alle Schritte enthalten vollständigen Code oder exakte Zeilenangaben für Edits.

**Typkonsistenz:** `EventShare`-Feldnamen identisch zwischen Backend-`_share_out()` (Task 2/3), Frontend-`EventShare`-Interface (Task 6) und allen Verwendungsstellen (Task 7, 9, 10) geprüft — `has_drift`, `buffer_before_minutes`, `buffer_after_minutes`, `target_calendar_id`, `shared_uid`, `source_uid` durchgängig gleich benannt. `shared_drift` (Event-Flag) vs. `has_drift` (Share-Flag) sind bewusst unterschiedliche Namen für unterschiedliche Ebenen (Event-Chip vs. Share-Objekt) — nicht verwechseln.

**Bekannte Grenzen (bewusst, dokumentiert statt Platzhalter):**
- Task 9/10 setzen voraus, dass die Kopie im Oma&Opa-Kalender bereits synchronisiert ist (Sync läuft als `BackgroundTask` nach `POST /event-shares`) — bei sehr kurz aufeinanderfolgenden Aktionen kann `ShareDriftDialog` kurzzeitig "Kopie nicht gefunden" zeigen; kein Blocker, da Sync-Intervall kurz ist und ein erneuter Versuch funktioniert.
- `ShareDialog` (Task 7) bietet keine Kalenderauswahl (Ziel ist fest `settings.oma_opa_calendar_id`) — exakt wie in der Spec beschrieben, keine zusätzliche UI erfunden.
