"""
Phase 5 – Tests für Write-Endpoints (POST / PUT / DELETE /api/events)

Alle CalDAV-Aufrufe und run_sync werden gemockt – kein echtes Nextcloud nötig.
"""
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import sessionmaker

from app.main import app
from app.auth.security import hash_password
from app.db.models import Base, Event, Calendar, User
from app.db.session import get_db

TEST_USER_EMAIL = "admin@test.local"
TEST_USER_PASSWORD = "testpassword123"


# ── In-Memory-DB für Tests ────────────────────────────────────────────────────

TEST_DB_URL = "sqlite:///:memory:"
engine = create_engine(TEST_DB_URL, connect_args={"check_same_thread": False}, poolclass=StaticPool)
TestingSessionLocal = sessionmaker(bind=engine)


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

    # Minimal-Kalender damit FK-Constraints stimmen
    cal = Calendar(
        id="https://nc.example.com/remote.php/dav/calendars/user/personal/",
        name="Persönlich",
        color="#5b8fff",
        ctag="initial",
    )
    db.add(cal)

    # Ein bestehendes Event für Update/Delete-Tests
    ev = Event(
        uid="existing-uid-1234",
        calendar_id="https://nc.example.com/remote.php/dav/calendars/user/personal/",
        etag='"etag-abc"',
        summary="Bestehendes Event",
        start=datetime(2026, 6, 15, 10, 0, tzinfo=timezone.utc),
        end=datetime(2026, 6, 15, 11, 0, tzinfo=timezone.utc),
        all_day=False,
    )
    db.add(ev)
    db.commit()
    db.close()
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setitem(app.dependency_overrides, get_db, override_get_db)
    monkeypatch.setattr("app.caldav.sync.run_sync", lambda: None)
    monkeypatch.setattr("app.scheduler.run_sync", lambda: None)
    return TestClient(app)


@pytest.fixture
def auth(client):
    """Legt einen Admin-User an und loggt ihn ein (Session-Cookie landet im TestClient)."""
    db = TestingSessionLocal()
    db.add(User(
        email=TEST_USER_EMAIL,
        display_name="Test Admin",
        password_hash=hash_password(TEST_USER_PASSWORD),
        role="admin",
        must_change_password=False,
        created_at=datetime.utcnow(),
    ))
    db.commit()
    db.close()

    r = client.post("/api/auth/login", json={"email": TEST_USER_EMAIL, "password": TEST_USER_PASSWORD})
    assert r.status_code == 200
    return {}


CAL_ID = "https://nc.example.com/remote.php/dav/calendars/user/personal/"
ISO_START = "2026-06-20T14:00:00Z"
ISO_END   = "2026-06-20T15:00:00Z"


# ── Auth-Tests ────────────────────────────────────────────────────────────────

def test_post_event_ohne_auth(client):
    r = client.post("/api/events", json={
        "calendar_id": CAL_ID, "summary": "Test",
        "start": ISO_START, "end": ISO_END,
    })
    assert r.status_code == 401


def test_put_event_ohne_auth(client):
    r = client.put("/api/events/existing-uid-1234", json={
        "etag": '"etag-abc"', "summary": "X",
        "start": ISO_START, "end": ISO_END,
    })
    assert r.status_code == 401


def test_delete_event_ohne_auth(client):
    r = client.delete("/api/events/existing-uid-1234", params={"etag": '"etag-abc"'})
    assert r.status_code == 401


# ── POST: Erstellen ───────────────────────────────────────────────────────────

def test_post_event_erstellt_erfolgreich(client, auth):
    new_uid = "new-uid-5678"

    def fake_sync():
        # Simuliert dass Sync das neue Event in die DB schreibt
        db = TestingSessionLocal()
        db.add(Event(
            uid=new_uid,
            calendar_id=CAL_ID,
            etag='"etag-new"',
            summary="Neues Event",
            start=datetime(2026, 6, 20, 14, 0, tzinfo=timezone.utc),
            end=datetime(2026, 6, 20, 15, 0, tzinfo=timezone.utc),
            all_day=False,
        ))
        db.commit()
        db.close()

    with patch("app.api.events.create_event", return_value=new_uid), \
         patch("app.api.events.run_sync", side_effect=fake_sync):
        r = client.post("/api/events", headers=auth, json={
            "calendar_id": CAL_ID,
            "summary": "Neues Event",
            "start": ISO_START,
            "end": ISO_END,
        })

    assert r.status_code == 201
    assert r.json()["uid"] == new_uid


def test_post_event_kalender_nicht_gefunden(client, auth):
    with patch("app.api.events.create_event",
               side_effect=ValueError("Kalender nicht gefunden")):
        r = client.post("/api/events", headers=auth, json={
            "calendar_id": "https://nc.example.com/nonexistent/",
            "summary": "Test",
            "start": ISO_START,
            "end": ISO_END,
        })
    assert r.status_code == 404


def test_post_event_mit_optionalen_feldern(client, auth):
    new_uid = "new-uid-optional"

    def fake_sync():
        db = TestingSessionLocal()
        db.add(Event(
            uid=new_uid,
            calendar_id=CAL_ID,
            etag='"etag-opt"',
            summary="Mit Ort",
            start=datetime(2026, 6, 20, 14, 0, tzinfo=timezone.utc),
            end=datetime(2026, 6, 20, 15, 0, tzinfo=timezone.utc),
            all_day=False,
            location="Berlin",
        ))
        db.commit()
        db.close()

    with patch("app.api.events.create_event", return_value=new_uid) as mock_create, \
         patch("app.api.events.run_sync", side_effect=fake_sync):
        r = client.post("/api/events", headers=auth, json={
            "calendar_id": CAL_ID,
            "summary": "Mit Ort",
            "start": ISO_START,
            "end": ISO_END,
            "location": "Berlin",
            "description": "Konferenz",
        })

    assert r.status_code == 201
    # Prüfen dass location/description an create_event übergeben wurden
    _, kwargs = mock_create.call_args
    assert kwargs.get("location") == "Berlin"
    assert kwargs.get("description") == "Konferenz"


# ── PUT: Bearbeiten ───────────────────────────────────────────────────────────

def test_put_event_erfolgreich(client, auth):
    with patch("app.api.events.update_event") as mock_update, \
         patch("app.api.events.run_sync"):
        r = client.put("/api/events/existing-uid-1234", headers=auth, json={
            "etag": '"etag-abc"',
            "summary": "Geänderter Titel",
            "start": ISO_START,
            "end": ISO_END,
        })

    assert r.status_code == 200
    assert r.json()["uid"] == "existing-uid-1234"
    mock_update.assert_called_once()


def test_put_event_nicht_gefunden(client, auth):
    with patch("app.api.events.update_event"):
        r = client.put("/api/events/unknown-uid", headers=auth, json={
            "etag": '"etag-x"',
            "summary": "X",
            "start": ISO_START,
            "end": ISO_END,
        })
    assert r.status_code == 404


def test_put_event_konflikt(client, auth):
    from app.caldav.write import ConflictError as CE

    with patch("app.api.events.update_event", side_effect=CE("Konflikt")):
        r = client.put("/api/events/existing-uid-1234", headers=auth, json={
            "etag": '"etag-veraltet"',
            "summary": "X",
            "start": ISO_START,
            "end": ISO_END,
        })

    assert r.status_code == 409
    assert "neu laden" in r.json()["detail"]


# ── DELETE: Löschen ───────────────────────────────────────────────────────────

def test_delete_event_erfolgreich(client, auth):
    with patch("app.api.events.delete_event") as mock_del, \
         patch("app.api.events.run_sync"):
        r = client.delete(
            "/api/events/existing-uid-1234",
            params={"etag": '"etag-abc"'},
            headers=auth,
        )

    assert r.status_code == 204
    mock_del.assert_called_once()


def test_delete_event_nicht_gefunden(client, auth):
    r = client.delete(
        "/api/events/unknown-uid",
        params={"etag": '"etag-x"'},
        headers=auth,
    )
    assert r.status_code == 404


def test_delete_event_konflikt(client, auth):
    from app.caldav.write import ConflictError as CE

    with patch("app.api.events.delete_event", side_effect=CE("Konflikt")):
        r = client.delete(
            "/api/events/existing-uid-1234",
            params={"etag": '"etag-veraltet"'},
            headers=auth,
        )

    assert r.status_code == 409


# ── GET: etag jetzt im Response ───────────────────────────────────────────────

def test_get_events_enthält_etag(client, auth):
    r = client.get(
        "/api/events",
        headers=auth,
        params={"from": "2026-06-01T00:00:00Z", "to": "2026-06-30T23:59:59Z"},
    )
    assert r.status_code == 200
    events = r.json()
    assert len(events) >= 1
    assert "etag" in events[0]


# ── PUT/DELETE: Serien-Bearbeitung/-Löschung mode='future' ────────────────────

def _add_recurring_event(uid="recurring-uid-1", rrule="FREQ=WEEKLY"):
    db = TestingSessionLocal()
    db.add(Event(
        uid=uid,
        calendar_id=CAL_ID,
        etag='"etag-rec"',
        summary="Serientermin",
        start=datetime(2026, 6, 1, 10, 0, tzinfo=timezone.utc),
        end=datetime(2026, 6, 1, 11, 0, tzinfo=timezone.utc),
        all_day=False,
        rrule=rrule,
    ))
    db.commit()
    db.close()


def test_put_event_future_erfolgreich(client, auth):
    _add_recurring_event()
    with patch("app.api.events.update_event_future", return_value="new-uid-xyz") as mock_fut, \
         patch("app.api.events.run_sync"):
        r = client.put("/api/events/recurring-uid-1", headers=auth, json={
            "etag": '"etag-rec"',
            "summary": "Geänderter Titel",
            "start": "2026-06-15T14:00:00",
            "end": "2026-06-15T15:00:00",
            "recurrence_id": "2026-06-15T10:00:00",
            "mode": "future",
        })

    assert r.status_code == 200
    body = r.json()
    assert body["uid"] == "recurring-uid-1"
    assert body["new_uid"] == "new-uid-xyz"
    mock_fut.assert_called_once()

    db = TestingSessionLocal()
    old = db.query(Event).filter(Event.uid == "recurring-uid-1").first()
    new = db.query(Event).filter(Event.uid == "new-uid-xyz").first()
    assert "UNTIL=" in old.rrule
    assert new is not None
    assert new.summary == "Geänderter Titel"
    assert new.rrule == "FREQ=WEEKLY"
    db.close()


def test_put_event_future_ohne_recurrence_id(client, auth):
    _add_recurring_event(uid="recurring-uid-2")
    r = client.put("/api/events/recurring-uid-2", headers=auth, json={
        "etag": '"etag-rec"',
        "summary": "X",
        "start": ISO_START,
        "end": ISO_END,
        "mode": "future",
    })
    assert r.status_code == 400


def test_put_event_future_nicht_rekurrent(client, auth):
    r = client.put("/api/events/existing-uid-1234", headers=auth, json={
        "etag": '"etag-abc"',
        "summary": "X",
        "start": ISO_START,
        "end": ISO_END,
        "recurrence_id": "2026-06-15T10:00:00",
        "mode": "future",
    })
    assert r.status_code == 400


def test_delete_event_future_erfolgreich(client, auth):
    _add_recurring_event(uid="recurring-uid-3")
    with patch("app.api.events.delete_future_occurrences") as mock_del, \
         patch("app.api.events.run_sync"):
        r = client.delete(
            "/api/events/recurring-uid-3",
            params={"etag": '"etag-rec"', "recurrence_id": "2026-06-15T10:00:00", "mode": "future"},
            headers=auth,
        )

    assert r.status_code == 204
    mock_del.assert_called_once()

    db = TestingSessionLocal()
    old = db.query(Event).filter(Event.uid == "recurring-uid-3").first()
    assert "UNTIL=" in old.rrule
    db.close()


def test_delete_event_future_nicht_rekurrent(client, auth):
    r = client.delete(
        "/api/events/existing-uid-1234",
        params={"etag": '"etag-abc"', "recurrence_id": "2026-06-15T10:00:00", "mode": "future"},
        headers=auth,
    )
    assert r.status_code == 400
