from __future__ import annotations

import uuid
from datetime import datetime, timezone

from icalendar import Calendar, Event as ICalEvent
from caldav import DAVClient

from app.config import settings


class ConflictError(Exception):
    pass


class CalDAVTimeoutError(Exception):
    pass


def _get_client() -> DAVClient:
    return DAVClient(
        url=settings.caldav_url,
        username=settings.caldav_username,
        password=settings.caldav_password,
    )


def _find_caldav_calendar(client: DAVClient, calendar_id: str):
    principal = client.principal()
    for cal in principal.calendars():
        if str(cal.url) == calendar_id:
            return cal
    return None


def _find_caldav_event(cal, uid: str):
    for obj in cal.objects(load_objects=True):
        parsed = Calendar.from_ical(obj.data)
        for component in parsed.walk():
            if component.name == "VEVENT":
                if str(component.get("uid", "")) == uid:
                    return obj
    return None


def _get_etag(obj) -> str | None:
    """Liest den ETag eines CalDAV-Objekts.

    Die caldav-Lib stellt den ETag als Attribut bereit; get_properties() crasht
    bei Nextcloud mit einem internen XML-Bug.
    """
    return getattr(obj, "etag", None)


def _make_ical(
    uid: str,
    summary: str,
    start: datetime,
    end: datetime,
    all_day: bool,
    location: str | None,
    description: str | None,
) -> bytes:
    cal = Calendar()
    cal.add("prodid", "-//Termina//termina//EN")
    cal.add("version", "2.0")

    ev = ICalEvent()
    ev.add("uid", uid)
    ev.add("summary", summary)
    ev.add("dtstamp", datetime.now(timezone.utc))

    if all_day:
        ev.add("dtstart", start.date())
        ev.add("dtend", end.date())
    else:
        ev.add("dtstart", start)
        ev.add("dtend", end)

    if location:
        ev.add("location", location)
    if description:
        ev.add("description", description)

    cal.add_component(ev)
    return cal.to_ical()


def create_event(
    calendar_id: str,
    summary: str,
    start: datetime,
    end: datetime,
    all_day: bool = False,
    location: str | None = None,
    description: str | None = None,
) -> str:
    """Erstellt ein neues Event auf CalDAV. Gibt die neue UID zurück."""
    uid = str(uuid.uuid4())
    ical_data = _make_ical(uid, summary, start, end, all_day, location, description)

    try:
        client = _get_client()
        cal = _find_caldav_calendar(client, calendar_id)
        if cal is None:
            raise ValueError(f"Kalender nicht gefunden: {calendar_id}")
        cal.save_event(ical_data)
    except ValueError:
        raise
    except Exception as e:
        if "timeout" in str(e).lower() or "ReadTimeout" in type(e).__name__:
            raise CalDAVTimeoutError(f"Nextcloud nicht erreichbar: {e}") from e
        raise CalDAVTimeoutError(f"CalDAV-Fehler: {e}") from e

    return uid


def update_event(
    calendar_id: str,
    uid: str,
    etag: str,
    summary: str,
    start: datetime,
    end: datetime,
    all_day: bool = False,
    location: str | None = None,
    description: str | None = None,
) -> None:
    """Aktualisiert ein Event. Wirft ConflictError wenn ETag nicht mehr stimmt."""
    try:
        client = _get_client()
        cal = _find_caldav_calendar(client, calendar_id)
        if cal is None:
            raise ValueError(f"Kalender nicht gefunden: {calendar_id}")

        obj = _find_caldav_event(cal, uid)
        if obj is None:
            raise ValueError(f"Event nicht gefunden: {uid}")

        current_etag = _get_etag(obj)
        if current_etag and current_etag != etag:
            raise ConflictError(f"ETag-Konflikt für Event {uid}")

        ical_data = _make_ical(uid, summary, start, end, all_day, location, description)
        obj.data = ical_data
        obj.save()
    except (ValueError, ConflictError):
        raise
    except Exception as e:
        raise CalDAVTimeoutError(f"CalDAV-Fehler: {e}") from e


def delete_event(calendar_id: str, uid: str, etag: str) -> None:
    """Löscht ein Event. Wirft ConflictError wenn ETag nicht mehr stimmt."""
    try:
        client = _get_client()
        cal = _find_caldav_calendar(client, calendar_id)
        if cal is None:
            raise ValueError(f"Kalender nicht gefunden: {calendar_id}")

        obj = _find_caldav_event(cal, uid)
        if obj is None:
            raise ValueError(f"Event nicht gefunden: {uid}")

        current_etag = _get_etag(obj)
        if current_etag and current_etag != etag:
            raise ConflictError(f"ETag-Konflikt für Event {uid}")

        obj.delete()
    except (ValueError, ConflictError):
        raise
    except Exception as e:
        raise CalDAVTimeoutError(f"CalDAV-Fehler: {e}") from e