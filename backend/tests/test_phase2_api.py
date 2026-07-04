"""
Phase 2 – REST API tests.

Uses an in-memory SQLite DB and bypasses the scheduler so no real
CalDAV server is needed.
"""
import os
import pytest
from datetime import datetime, timezone

os.environ.setdefault("CALDAV_URL", "http://localhost")
os.environ.setdefault("CALDAV_USERNAME", "test")
os.environ.setdefault("CALDAV_PASSWORD", "test")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth.security import hash_password
from app.db.models import Base, Calendar, Event, User
from app.db.session import get_db
from app.main import app

# --------------------------------------------------------------------------- #
# Test DB setup – StaticPool stellt sicher dass alle Verbindungen dieselbe
# In-Memory-DB sehen (sqlite:///:memory: öffnet sonst pro Verbindung eine neue)
# --------------------------------------------------------------------------- #
engine = create_engine(
    "sqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine)


def override_get_db():
    db = TestingSession()
    try:
        yield db
    finally:
        db.close()


import app.db.session as _db_session

TEST_USER_EMAIL = "admin@test.local"
TEST_USER_PASSWORD = "testpassword123"


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
@pytest.fixture()
def client(monkeypatch):
    """Fresh TestClient per test mit isolierter DB und ohne CalDAV-Calls."""
    monkeypatch.setitem(app.dependency_overrides, get_db, override_get_db)
    monkeypatch.setattr(_db_session, "engine", engine)
    monkeypatch.setattr(_db_session, "SessionLocal", TestingSession)
    monkeypatch.setattr("app.caldav.sync.run_sync", lambda: None)
    monkeypatch.setattr("app.scheduler.run_sync", lambda: None)
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def seed_db():
    db = TestingSession()
    cal = Calendar(id="https://nc/cal/work", name="Work", color="#3b82f6")
    db.add(cal)
    db.add(Event(
        uid="evt-1",
        calendar_id="https://nc/cal/work",
        summary="Team Standup",
        start=datetime(2026, 6, 10, 9, 0, tzinfo=timezone.utc),
        end=datetime(2026, 6, 10, 9, 30, tzinfo=timezone.utc),
        all_day=False,
    ))
    db.add(Event(
        uid="evt-2",
        calendar_id="https://nc/cal/work",
        summary="All-day event",
        start=datetime(2026, 6, 15, 0, 0, tzinfo=timezone.utc),
        end=datetime(2026, 6, 16, 0, 0, tzinfo=timezone.utc),
        all_day=True,
    ))
    db.commit()
    db.close()
    yield
    db = TestingSession()
    db.query(Event).delete()
    db.query(Calendar).delete()
    db.query(User).delete()
    db.commit()
    db.close()


@pytest.fixture()
def auth(client):
    """Legt einen Admin-User an und loggt ihn ein (Session-Cookie landet im TestClient)."""
    db = TestingSession()
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


# --------------------------------------------------------------------------- #
# Auth tests
# --------------------------------------------------------------------------- #
def test_calendars_no_auth(client):
    r = client.get("/api/calendars")
    assert r.status_code == 401  # keine Session -> Unauthorized


def test_calendars_invalid_session(client):
    client.cookies.set("termina_session", "invalid-token")
    r = client.get("/api/calendars")
    assert r.status_code == 401


# --------------------------------------------------------------------------- #
# /api/calendars
# --------------------------------------------------------------------------- #
def test_list_calendars(client, auth):
    r = client.get("/api/calendars", headers=auth)
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 1
    assert data[0]["id"] == "https://nc/cal/work"
    assert data[0]["name"] == "Work"
    assert data[0]["color"] == "#3b82f6"


# --------------------------------------------------------------------------- #
# /api/events
# --------------------------------------------------------------------------- #
def test_list_events_full_month(client, auth):
    r = client.get(
        "/api/events",
        params={"from": "2026-06-01T00:00:00Z", "to": "2026-06-30T23:59:59Z"},
        headers=auth,
    )
    assert r.status_code == 200
    uids = {e["uid"] for e in r.json()}
    assert uids == {"evt-1", "evt-2"}


def test_list_events_narrow_range(client, auth):
    r = client.get(
        "/api/events",
        params={"from": "2026-06-10T08:00:00Z", "to": "2026-06-10T10:00:00Z"},
        headers=auth,
    )
    assert r.status_code == 200
    uids = {e["uid"] for e in r.json()}
    assert "evt-1" in uids
    assert "evt-2" not in uids


def test_list_events_calendar_filter(client, auth):
    r = client.get(
        "/api/events",
        params={
            "from": "2026-06-01T00:00:00Z",
            "to": "2026-06-30T23:59:59Z",
            "calendar_id": "https://nc/cal/work",
        },
        headers=auth,
    )
    assert r.status_code == 200
    assert len(r.json()) == 2


def test_list_events_no_results_outside_range(client, auth):
    r = client.get(
        "/api/events",
        params={"from": "2026-07-01T00:00:00Z", "to": "2026-07-31T23:59:59Z"},
        headers=auth,
    )
    assert r.status_code == 200
    assert r.json() == []


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
