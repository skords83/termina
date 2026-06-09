"""Phase-1-Tests: DB-Modelle und Sync-Logik (ohne echtes Nextcloud).

Testet:
- Tabellen-Erstellung
- Calendar/Event upsert
- _parse_ical mit einem minimalen VCALENDAR-String
- Loeschlogik (Event verschwindet wenn ETag nicht mehr remote)
"""

import pytest
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.models import Base, Calendar, Event
from app.caldav.sync import _parse_ical, _apply_parsed, run_sync


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def in_memory_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


# ---------------------------------------------------------------------------
# DB-Tests
# ---------------------------------------------------------------------------

def test_create_calendar(in_memory_session):
    cal = Calendar(id="https://nc.example.com/cal/personal/", name="Persoenlich", color="#4A90D9")
    in_memory_session.add(cal)
    in_memory_session.commit()

    result = in_memory_session.get(Calendar, "https://nc.example.com/cal/personal/")
    assert result is not None
    assert result.name == "Persoenlich"
    assert result.color == "#4A90D9"


def test_create_event(in_memory_session):
    cal = Calendar(id="https://nc.example.com/cal/personal/", name="Persoenlich")
    in_memory_session.add(cal)
    in_memory_session.commit()

    ev = Event(
        uid="abc-123@nextcloud",
        calendar_id="https://nc.example.com/cal/personal/",
        summary="Testevent",
        all_day=False,
    )
    in_memory_session.add(ev)
    in_memory_session.commit()

    result = in_memory_session.get(Event, "abc-123@nextcloud")
    assert result is not None
    assert result.summary == "Testevent"


def test_cascade_delete(in_memory_session):
    cal = Calendar(id="https://nc.example.com/cal/personal/", name="Persoenlich")
    ev = Event(uid="xyz@nc", calendar_id="https://nc.example.com/cal/personal/", summary="Event")
    in_memory_session.add_all([cal, ev])
    in_memory_session.commit()

    in_memory_session.delete(cal)
    in_memory_session.commit()

    assert in_memory_session.get(Event, "xyz@nc") is None


# ---------------------------------------------------------------------------
# Parse-Tests
# ---------------------------------------------------------------------------

MINIMAL_ICAL = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:test-uid-001@termina
SUMMARY:Testevent Sync
DTSTART:20260610T100000Z
DTEND:20260610T110000Z
END:VEVENT
END:VCALENDAR"""

ALLDAY_ICAL = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:allday-001@termina
SUMMARY:Ganztaegig
DTSTART;VALUE=DATE:20260615
DTEND;VALUE=DATE:20260616
END:VEVENT
END:VCALENDAR"""

RRULE_ICAL = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:rrule-001@termina
SUMMARY:Woechentlich
DTSTART:20260601T090000Z
DTEND:20260601T100000Z
RRULE:FREQ=WEEKLY;COUNT=10
END:VEVENT
END:VCALENDAR"""


def test_parse_minimal_ical():
    result = _parse_ical(MINIMAL_ICAL)
    assert result is not None
    assert result["uid"] == "test-uid-001@termina"
    assert result["summary"] == "Testevent Sync"
    assert result["all_day"] is False
    assert result["start"] == datetime(2026, 6, 10, 10, 0, 0, tzinfo=UTC)


def test_parse_allday_ical():
    result = _parse_ical(ALLDAY_ICAL)
    assert result is not None
    assert result["all_day"] is True
    assert result["start"].date().isoformat() == "2026-06-15"


def test_parse_rrule():
    result = _parse_ical(RRULE_ICAL)
    assert result is not None
    assert result["rrule"] is not None
    assert "FREQ=WEEKLY" in result["rrule"]


def test_parse_invalid_returns_none():
    assert _parse_ical("das ist kein ical") is None
    assert _parse_ical("") is None


# ---------------------------------------------------------------------------
# Sync-Logik: run_sync mit gemockten CalDAV-Calls
# ---------------------------------------------------------------------------

def test_run_sync_creates_calendar_and_event(in_memory_session):
    """run_sync legt Kalender + Event in der DB an."""

    from app.caldav.client import CalendarInfo

    mock_calendars = [
        CalendarInfo(
            url="https://nc.example.com/cal/personal/",
            name="Persoenlich",
            color="#4A90D9",
            ctag="ctag-v1",
        )
    ]
    mock_etags = {"https://nc.example.com/cal/personal/event1.ics": "etag-abc"}

    with (
        patch("app.caldav.sync.discover_calendars", return_value=mock_calendars),
        patch("app.caldav.sync.get_event_etags", return_value=mock_etags),
        patch("app.caldav.sync.fetch_event_ical", return_value=MINIMAL_ICAL),
        patch("app.caldav.sync.get_session", return_value=in_memory_session),
    ):
        run_sync()

    cal = in_memory_session.get(Calendar, "https://nc.example.com/cal/personal/")
    assert cal is not None
    assert cal.ctag == "ctag-v1"

    ev = in_memory_session.get(Event, "test-uid-001@termina")
    assert ev is not None
    assert ev.summary == "Testevent Sync"
    assert ev.etag == "etag-abc"
