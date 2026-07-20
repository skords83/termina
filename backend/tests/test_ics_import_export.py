"""
ICS-Import/-Export – Tests.

Uses an in-memory SQLite DB and mocks the CalDAV write layer so no real
CalDAV server is needed.
"""
import os
import pytest
from datetime import datetime, timezone

os.environ.setdefault("CALDAV_URL", "http://localhost")
os.environ.setdefault("CALDAV_USERNAME", "test")
os.environ.setdefault("CALDAV_PASSWORD", "test")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")

from icalendar import Calendar as ICalendar
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth.security import hash_password
from app.caldav.write import CalDAVTimeoutError
from app.db.models import Base, Calendar, Event, EventOverride, User
from app.db.session import get_db
from app.main import app

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
CAL_ID = "https://nc/cal/work"


@pytest.fixture()
def client(monkeypatch):
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
    db.add(Calendar(id=CAL_ID, name="Work", color="#3b82f6"))
    db.add(Event(
        uid="evt-1",
        calendar_id=CAL_ID,
        summary="Team Standup",
        start=datetime(2026, 6, 10, 9, 0),
        end=datetime(2026, 6, 10, 9, 30),
        all_day=False,
    ))
    db.add(Event(
        uid="evt-2",
        calendar_id=CAL_ID,
        summary="All-day event",
        start=datetime(2026, 6, 15, 0, 0),
        end=datetime(2026, 6, 16, 0, 0),
        all_day=True,
    ))
    db.add(Event(
        uid="evt-series",
        calendar_id=CAL_ID,
        summary="Wöchentliches Meeting",
        start=datetime(2026, 6, 1, 10, 0),
        end=datetime(2026, 6, 1, 11, 0),
        all_day=False,
        rrule="FREQ=WEEKLY;COUNT=5",
    ))
    db.add(EventOverride(
        master_uid="evt-series",
        recurrence_id=datetime(2026, 6, 8, 10, 0),
        start=datetime(2026, 6, 8, 14, 0),
        end=datetime(2026, 6, 8, 15, 0),
        summary="Meeting (verschoben)",
    ))
    db.add(EventOverride(
        master_uid="evt-series",
        recurrence_id=datetime(2026, 6, 15, 10, 0),
        start=None,
        end=None,
    ))
    db.commit()
    db.close()
    yield
    db = TestingSession()
    db.query(EventOverride).delete()
    db.query(Event).delete()
    db.query(Calendar).delete()
    db.query(User).delete()
    db.commit()
    db.close()


@pytest.fixture()
def auth(client):
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


@pytest.fixture()
def member_auth(client):
    """Nutzer ohne Zugriff auf CAL_ID (kein UserCalendarAccess-Eintrag)."""
    email = "member@test.local"
    password = "memberpassword123"
    db = TestingSession()
    db.add(User(
        email=email,
        display_name="Member",
        password_hash=hash_password(password),
        role="member",
        must_change_password=False,
        created_at=datetime.utcnow(),
    ))
    db.commit()
    db.close()

    r = client.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200
    return {}


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #
def test_export_requires_auth(client):
    r = client.get("/api/ics/export")
    assert r.status_code == 401


def test_export_contains_all_events(client, auth):
    r = client.get("/api/ics/export", headers=auth)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/calendar")
    assert "attachment" in r.headers["content-disposition"]

    cal = ICalendar.from_ical(r.content)
    vevents = list(cal.walk("VEVENT"))
    summaries = {str(v.get("SUMMARY")) for v in vevents}
    assert "Team Standup" in summaries
    assert "All-day event" in summaries
    assert "Wöchentliches Meeting" in summaries


def test_export_includes_recurring_master_with_rrule(client, auth):
    r = client.get("/api/ics/export", headers=auth)
    cal = ICalendar.from_ical(r.content)
    master = next(
        v for v in cal.walk("VEVENT")
        if str(v.get("UID")) == "evt-series" and "RECURRENCE-ID" not in v
    )
    assert master.get("RRULE") is not None
    assert "WEEKLY" in master["RRULE"].to_ical().decode()


def test_export_includes_override_instance(client, auth):
    r = client.get("/api/ics/export", headers=auth)
    cal = ICalendar.from_ical(r.content)
    overrides = [
        v for v in cal.walk("VEVENT")
        if str(v.get("UID")) == "evt-series" and "RECURRENCE-ID" in v
    ]
    assert len(overrides) == 1
    assert str(overrides[0].get("SUMMARY")) == "Meeting (verschoben)"


def test_export_includes_exdate_for_deleted_instance(client, auth):
    r = client.get("/api/ics/export", headers=auth)
    cal = ICalendar.from_ical(r.content)
    master = next(
        v for v in cal.walk("VEVENT")
        if str(v.get("UID")) == "evt-series" and "RECURRENCE-ID" not in v
    )
    assert master.get("EXDATE") is not None


def test_export_filters_by_calendar_id_no_access(client, member_auth):
    r = client.get("/api/ics/export", params={"calendar_id": CAL_ID}, headers=member_auth)
    assert r.status_code == 403


# --------------------------------------------------------------------------- #
# Single-event export
# --------------------------------------------------------------------------- #
def test_export_event_requires_auth(client):
    r = client.get("/api/ics/export/event/evt-1")
    assert r.status_code == 401


def test_export_event_returns_single_event(client, auth):
    r = client.get("/api/ics/export/event/evt-1", headers=auth)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/calendar")

    cal = ICalendar.from_ical(r.content)
    vevents = list(cal.walk("VEVENT"))
    assert len(vevents) == 1
    assert str(vevents[0].get("SUMMARY")) == "Team Standup"


def test_export_event_includes_overrides(client, auth):
    r = client.get("/api/ics/export/event/evt-series", headers=auth)
    cal = ICalendar.from_ical(r.content)
    uids = {str(v.get("UID")) for v in cal.walk("VEVENT")}
    assert uids == {"evt-series"}
    assert len(cal.walk("VEVENT")) == 2  # Master + eine Override-Instanz


def test_export_event_not_found(client, auth):
    r = client.get("/api/ics/export/event/does-not-exist", headers=auth)
    assert r.status_code == 404


def test_export_event_no_calendar_access_returns_403(client, member_auth):
    r = client.get("/api/ics/export/event/evt-1", headers=member_auth)
    assert r.status_code == 403


# --------------------------------------------------------------------------- #
# Import
# --------------------------------------------------------------------------- #
SAMPLE_ICS = b"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:external-uid-123
SUMMARY:Imported Event
DTSTART:20261201T100000Z
DTEND:20261201T110000Z
END:VEVENT
END:VCALENDAR
"""


def test_import_requires_auth(client):
    r = client.post(
        "/api/ics/import",
        data={"calendar_id": CAL_ID},
        files={"file": ("test.ics", SAMPLE_ICS, "text/calendar")},
    )
    assert r.status_code == 401


def test_import_creates_event_via_caldav(client, auth, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.api.ics_api.import_ical_object",
        lambda calendar_id, ical_bytes: calls.append((calendar_id, ical_bytes)),
    )

    r = client.post(
        "/api/ics/import",
        data={"calendar_id": CAL_ID},
        files={"file": ("test.ics", SAMPLE_ICS, "text/calendar")},
        headers=auth,
    )
    assert r.status_code == 200
    body = r.json()
    assert body == {"imported": 1, "failed": 0, "total": 1}

    assert len(calls) == 1
    called_calendar_id, ical_bytes = calls[0]
    assert called_calendar_id == CAL_ID

    imported_cal = ICalendar.from_ical(ical_bytes)
    vevent = imported_cal.walk("VEVENT")[0]
    assert str(vevent.get("SUMMARY")) == "Imported Event"
    # UID muss neu vergeben worden sein (keine Kollision mit der Quelldatei)
    assert str(vevent.get("UID")) != "external-uid-123"


def test_import_invalid_file_returns_400(client, auth):
    r = client.post(
        "/api/ics/import",
        data={"calendar_id": CAL_ID},
        files={"file": ("test.ics", b"not an ics file", "text/calendar")},
        headers=auth,
    )
    assert r.status_code == 400


def test_import_no_calendar_access_returns_403(client, member_auth):
    r = client.post(
        "/api/ics/import",
        data={"calendar_id": CAL_ID},
        files={"file": ("test.ics", SAMPLE_ICS, "text/calendar")},
        headers=member_auth,
    )
    assert r.status_code == 403


def test_import_caldav_down_returns_503(client, auth, monkeypatch):
    def raise_timeout(calendar_id, ical_bytes):
        raise CalDAVTimeoutError("nope")

    monkeypatch.setattr("app.api.ics_api.import_ical_object", raise_timeout)

    r = client.post(
        "/api/ics/import",
        data={"calendar_id": CAL_ID},
        files={"file": ("test.ics", SAMPLE_ICS, "text/calendar")},
        headers=auth,
    )
    assert r.status_code == 503


# --------------------------------------------------------------------------- #
# Import-Vorschau
# --------------------------------------------------------------------------- #
def test_import_preview_requires_auth(client):
    r = client.post(
        "/api/ics/import/preview",
        data={"calendar_id": CAL_ID},
        files={"file": ("test.ics", SAMPLE_ICS, "text/calendar")},
    )
    assert r.status_code == 401


def test_import_preview_does_not_write(client, auth, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "app.api.ics_api.import_ical_object",
        lambda calendar_id, ical_bytes: calls.append((calendar_id, ical_bytes)),
    )

    r = client.post(
        "/api/ics/import/preview",
        data={"calendar_id": CAL_ID},
        files={"file": ("test.ics", SAMPLE_ICS, "text/calendar")},
        headers=auth,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["events"][0]["summary"] == "Imported Event"
    assert body["events"][0]["is_recurring"] is False
    assert calls == []  # Reine Vorschau schreibt nichts


def test_import_preview_flags_time_conflict(client, auth):
    conflicting_ics = b"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:conflicting-uid
SUMMARY:Overlapping Standup
DTSTART:20260610T071500Z
DTEND:20260610T072000Z
END:VEVENT
END:VCALENDAR
"""
    r = client.post(
        "/api/ics/import/preview",
        data={"calendar_id": CAL_ID},
        files={"file": ("test.ics", conflicting_ics, "text/calendar")},
        headers=auth,
    )
    assert r.status_code == 200
    assert r.json()["events"][0]["conflict"] is True


def test_import_preview_no_conflict_for_distinct_time(client, auth):
    r = client.post(
        "/api/ics/import/preview",
        data={"calendar_id": CAL_ID},
        files={"file": ("test.ics", SAMPLE_ICS, "text/calendar")},
        headers=auth,
    )
    assert r.status_code == 200
    assert r.json()["events"][0]["conflict"] is False


def test_import_preview_invalid_file_returns_400(client, auth):
    r = client.post(
        "/api/ics/import/preview",
        data={"calendar_id": CAL_ID},
        files={"file": ("test.ics", b"not an ics file", "text/calendar")},
        headers=auth,
    )
    assert r.status_code == 400


def test_import_preview_no_calendar_access_returns_403(client, member_auth):
    r = client.post(
        "/api/ics/import/preview",
        data={"calendar_id": CAL_ID},
        files={"file": ("test.ics", SAMPLE_ICS, "text/calendar")},
        headers=member_auth,
    )
    assert r.status_code == 403
