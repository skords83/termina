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
os.environ.setdefault("API_TOKEN", "secret")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.models import Base, Calendar, Event
from app.db.session import get_db
from app.main import app

# --------------------------------------------------------------------------- #
# Test DB setup – shared in-memory DB via same connection
# --------------------------------------------------------------------------- #
TEST_DB_URL = "sqlite:///file::testmemory:?uri=true&cache=shared"
engine = create_engine(
    TEST_DB_URL,
    connect_args={"check_same_thread": False, "uri": True},
)
TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine)


def override_get_db():
    db = TestingSession()
    try:
        yield db
    finally:
        db.close()


app.dependency_overrides[get_db] = override_get_db
# Also override the DATABASE_URL used by the lifespan create_tables call
import app.db.session as _db_session
_db_session.engine = engine
_db_session.SessionLocal = TestingSession

AUTH = {"Authorization": "Bearer secret"}


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
@pytest.fixture()
def client():
    """Fresh TestClient per test; lifespan runs but won't re-create tables."""
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
    db.commit()
    db.close()

# --------------------------------------------------------------------------- #
# Auth tests
# --------------------------------------------------------------------------- #
def test_calendars_no_auth(client):
    r = client.get("/api/calendars")
    assert r.status_code == 422  # missing Header → validation error


def test_calendars_wrong_token(client):
    r = client.get("/api/calendars", headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


# --------------------------------------------------------------------------- #
# /api/calendars
# --------------------------------------------------------------------------- #
def test_list_calendars(client):
    r = client.get("/api/calendars", headers=AUTH)
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 1
    assert data[0]["id"] == "https://nc/cal/work"
    assert data[0]["name"] == "Work"
    assert data[0]["color"] == "#3b82f6"


# --------------------------------------------------------------------------- #
# /api/events
# --------------------------------------------------------------------------- #
def test_list_events_full_month(client):
    r = client.get(
        "/api/events",
        params={"from": "2026-06-01T00:00:00Z", "to": "2026-06-30T23:59:59Z"},
        headers=AUTH,
    )
    assert r.status_code == 200
    uids = {e["uid"] for e in r.json()}
    assert uids == {"evt-1", "evt-2"}


def test_list_events_narrow_range(client):
    r = client.get(
        "/api/events",
        params={"from": "2026-06-10T08:00:00Z", "to": "2026-06-10T10:00:00Z"},
        headers=AUTH,
    )
    assert r.status_code == 200
    uids = {e["uid"] for e in r.json()}
    assert "evt-1" in uids
    assert "evt-2" not in uids


def test_list_events_calendar_filter(client):
    r = client.get(
        "/api/events",
        params={
            "from": "2026-06-01T00:00:00Z",
            "to": "2026-06-30T23:59:59Z",
            "calendar_id": "https://nc/cal/work",
        },
        headers=AUTH,
    )
    assert r.status_code == 200
    assert len(r.json()) == 2


def test_list_events_no_results_outside_range(client):
    r = client.get(
        "/api/events",
        params={"from": "2026-07-01T00:00:00Z", "to": "2026-07-31T23:59:59Z"},
        headers=AUTH,
    )
    assert r.status_code == 200
    assert r.json() == []


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}
