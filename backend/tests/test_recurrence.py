"""
Tests für RRULE-Expansion (recurrence.py).

Deckt die Fälle aus der Migrations-Checkliste ab:
- RRULE-Event liefert mehrere Instanzen im Fenster
- EXDATE-Instanz erscheint nicht
- Einzeltermin bleibt Einzeltermin (uid ohne Suffix)
- Modifizierte Instanz (RECURRENCE-ID) überschreibt reguläre
- Ganztagesevent mit RRULE
"""

from datetime import datetime
import pytest
from app.caldav.recurrence import expand_event


# ---------------------------------------------------------------------------
# Hilfsfunktionen für minimale iCal-Strings
# ---------------------------------------------------------------------------

def make_ical(uid: str, dtstart: str, dtend: str, extra: str = "") -> str:
    """Erzeugt ein minimales iCal-Objekt mit einem VEVENT."""
    return (
        "BEGIN:VCALENDAR\r\n"
        "VERSION:2.0\r\n"
        "BEGIN:VEVENT\r\n"
        f"UID:{uid}\r\n"
        f"DTSTART:{dtstart}\r\n"
        f"DTEND:{dtend}\r\n"
        f"SUMMARY:Test Event\r\n"
        f"{extra}"
        "END:VEVENT\r\n"
        "END:VCALENDAR\r\n"
    )


# ---------------------------------------------------------------------------
# Einzeltermin
# ---------------------------------------------------------------------------

class TestSingleEvent:
    def test_single_event_in_window(self):
        raw = make_ical("single-1", "20260610T100000", "20260610T110000")
        result = expand_event(
            raw,
            datetime(2026, 6, 1),
            datetime(2026, 6, 30),
        )
        assert len(result) == 1
        assert result[0]["uid"] == "single-1"  # kein Datums-Suffix
        assert result[0]["start"] == "2026-06-10T10:00:00"

    def test_single_event_outside_window(self):
        raw = make_ical("single-2", "20260710T100000", "20260710T110000")
        result = expand_event(
            raw,
            datetime(2026, 6, 1),
            datetime(2026, 6, 30),
        )
        assert result == []

    def test_single_event_starts_before_window_but_overlaps(self):
        """Termin beginnt vor dem Fenster, endet aber darin → soll erscheinen."""
        raw = make_ical("single-3", "20260531T230000", "20260601T010000")
        result = expand_event(
            raw,
            datetime(2026, 6, 1),
            datetime(2026, 6, 30),
        )
        assert len(result) == 1


# ---------------------------------------------------------------------------
# RRULE – wöchentlich
# ---------------------------------------------------------------------------

WEEKLY_RRULE = (
    "RRULE:FREQ=WEEKLY;BYDAY=MO\r\n"
)

WEEKLY_ICAL = (
    "BEGIN:VCALENDAR\r\n"
    "VERSION:2.0\r\n"
    "BEGIN:VEVENT\r\n"
    "UID:weekly-1\r\n"
    "DTSTART:20260601T160000\r\n"  # Mo, 1. Juni 2026
    "DTEND:20260601T170000\r\n"
    "SUMMARY:Wöchentlich\r\n"
    "RRULE:FREQ=WEEKLY;BYDAY=MO\r\n"
    "END:VEVENT\r\n"
    "END:VCALENDAR\r\n"
)


class TestWeeklyRRule:
    def test_multiple_instances_in_window(self):
        result = expand_event(
            WEEKLY_ICAL,
            datetime(2026, 6, 1),
            datetime(2026, 6, 30),
        )
        # Juni 2026 hat Montage am 1., 8., 15., 22., 29. → 5 Instanzen
        assert len(result) == 5

    def test_uid_has_date_suffix(self):
        result = expand_event(
            WEEKLY_ICAL,
            datetime(2026, 6, 1),
            datetime(2026, 6, 7),
        )
        assert len(result) == 1
        assert result[0]["uid"] == "weekly-1_2026-06-01"

    def test_no_instances_outside_window(self):
        result = expand_event(
            WEEKLY_ICAL,
            datetime(2026, 7, 1),
            datetime(2026, 7, 5),  # kein Montag
        )
        assert result == []

    def test_calendar_id_is_none(self):
        """calendar_id wird von events.py gesetzt, nicht von expand_event."""
        result = expand_event(
            WEEKLY_ICAL,
            datetime(2026, 6, 1),
            datetime(2026, 6, 7),
        )
        assert result[0]["calendar_id"] is None


# ---------------------------------------------------------------------------
# EXDATE
# ---------------------------------------------------------------------------

WEEKLY_WITH_EXDATE = (
    "BEGIN:VCALENDAR\r\n"
    "VERSION:2.0\r\n"
    "BEGIN:VEVENT\r\n"
    "UID:weekly-exdate\r\n"
    "DTSTART:20260601T160000\r\n"
    "DTEND:20260601T170000\r\n"
    "SUMMARY:Wöchentlich mit Ausnahme\r\n"
    "RRULE:FREQ=WEEKLY;BYDAY=MO\r\n"
    "EXDATE:20260608T160000\r\n"  # 8. Juni fällt aus
    "END:VEVENT\r\n"
    "END:VCALENDAR\r\n"
)


class TestExdate:
    def test_exdate_instance_missing(self):
        result = expand_event(
            WEEKLY_WITH_EXDATE,
            datetime(2026, 6, 1),
            datetime(2026, 6, 30),
        )
        starts = [r["start"] for r in result]
        assert "2026-06-08T16:00:00" not in starts

    def test_other_instances_present(self):
        result = expand_event(
            WEEKLY_WITH_EXDATE,
            datetime(2026, 6, 1),
            datetime(2026, 6, 30),
        )
        # 5 Montage minus 1 EXDATE = 4
        assert len(result) == 4


# ---------------------------------------------------------------------------
# RECURRENCE-ID (modifizierte Instanz)
# ---------------------------------------------------------------------------

WEEKLY_WITH_EXCEPTION = (
    "BEGIN:VCALENDAR\r\n"
    "VERSION:2.0\r\n"
    "BEGIN:VEVENT\r\n"
    "UID:weekly-exception\r\n"
    "DTSTART:20260601T160000\r\n"
    "DTEND:20260601T170000\r\n"
    "SUMMARY:Wöchentlich\r\n"
    "RRULE:FREQ=WEEKLY;BYDAY=MO\r\n"
    "END:VEVENT\r\n"
    "BEGIN:VEVENT\r\n"
    "UID:weekly-exception\r\n"
    "RECURRENCE-ID:20260608T160000\r\n"
    "DTSTART:20260608T180000\r\n"  # verschoben auf 18 Uhr
    "DTEND:20260608T190000\r\n"
    "SUMMARY:Wöchentlich (verschoben)\r\n"
    "END:VEVENT\r\n"
    "END:VCALENDAR\r\n"
)


class TestRecurrenceId:
    def test_modified_instance_replaces_original(self):
        result = expand_event(
            WEEKLY_WITH_EXCEPTION,
            datetime(2026, 6, 8),
            datetime(2026, 6, 9),
        )
        assert len(result) == 1
        assert result[0]["start"] == "2026-06-08T18:00:00"
        assert result[0]["summary"] == "Wöchentlich (verschoben)"


# ---------------------------------------------------------------------------
# Ganztagesevents
# ---------------------------------------------------------------------------

ALLDAY_WEEKLY = (
    "BEGIN:VCALENDAR\r\n"
    "VERSION:2.0\r\n"
    "BEGIN:VEVENT\r\n"
    "UID:allday-weekly\r\n"
    "DTSTART;VALUE=DATE:20260601\r\n"
    "DTEND;VALUE=DATE:20260602\r\n"
    "SUMMARY:Ganztags wöchentlich\r\n"
    "RRULE:FREQ=WEEKLY;BYDAY=MO\r\n"
    "END:VEVENT\r\n"
    "END:VCALENDAR\r\n"
)


class TestAllDayRRule:
    def test_allday_instances_returned(self):
        result = expand_event(
            ALLDAY_WEEKLY,
            datetime(2026, 6, 1),
            datetime(2026, 6, 30),
        )
        assert len(result) == 5

    def test_allday_flag_set(self):
        result = expand_event(
            ALLDAY_WEEKLY,
            datetime(2026, 6, 1),
            datetime(2026, 6, 7),
        )
        assert result[0]["all_day"] is True

    def test_allday_start_is_date_string(self):
        result = expand_event(
            ALLDAY_WEEKLY,
            datetime(2026, 6, 1),
            datetime(2026, 6, 7),
        )
        # Ganztagesevents: YYYY-MM-DD ohne Uhrzeit
        assert result[0]["start"] == "2026-06-01"
