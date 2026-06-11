from __future__ import annotations

import uuid
from datetime import datetime, timezone, timedelta, date as date_cls
from typing import Literal

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
    """Event per UID-Suche holen, Fallback auf Iteration."""
    try:
        results = cal.search(uid=uid, event=True, expand=False)
        if results:
            return results[0]
    except Exception:
        pass

    for obj in cal.objects(load_objects=True):
        try:
            parsed = Calendar.from_ical(obj.data)
            for component in parsed.walk():
                if component.name == "VEVENT":
                    if str(component.get("uid", "")) == uid:
                        return obj
        except Exception:
            continue
    return None


def _get_etag(obj) -> str | None:
    return getattr(obj, "etag", None)


# ── iCal-Helfer ──────────────────────────────────────────────────────────────

def _find_master(cal: Calendar) -> ICalEvent | None:
    """Master = VEVENT ohne RECURRENCE-ID."""
    for component in cal.walk("VEVENT"):
        if "RECURRENCE-ID" not in component:
            return component
    return None


def _find_overrides(cal: Calendar) -> list[ICalEvent]:
    """Alle Override-VEVENTs (mit RECURRENCE-ID)."""
    return [c for c in cal.walk("VEVENT") if "RECURRENCE-ID" in c]


def _dt_equal(a, b) -> bool:
    """Vergleicht zwei datetime/date robust (ignoriert tz wenn nötig)."""
    if a is None or b is None:
        return a is b

    # Beide auf naive datetime normalisieren
    def _norm(x):
        if isinstance(x, datetime):
            return x.replace(tzinfo=None)
        if isinstance(x, date_cls):
            return datetime(x.year, x.month, x.day)
        return x

    return _norm(a) == _norm(b)


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


# ── Create / Update / Delete (unverändert) ───────────────────────────────────

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


# ── Move: alle drei Modi ─────────────────────────────────────────────────────

MoveMode = Literal["single", "future", "all"]


def move_event(
    mode: MoveMode,
    calendar_id: str,
    uid: str,
    etag: str,
    original_start: datetime,
    new_start: datetime,
    new_end: datetime,
    all_day: bool = False,
    recurrence_id: datetime | None = None,
) -> dict:
    """
    Verschiebt ein Event.

    Modi:
    - 'all':    Master-DTSTART/DTEND um delta (new_start - original_start) verschieben.
                Ändert die gesamte Serie (oder ein nicht-rekurrentes Event).
                Existierende RECURRENCE-ID-Overrides werden mit verschoben.
    - 'single': Fügt einen RECURRENCE-ID-Override hinzu (nur diese eine Instanz).
                recurrence_id = ursprüngliches Datum dieser Instanz.
    - 'future': Setzt UNTIL im Master-RRULE und erstellt ein neues Event mit
                neuer UID ab new_start. Gibt {'new_uid': ...} zurück.

    Returns: dict mit ggf. 'new_uid' bei mode='future'.
    """
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

        ical = Calendar.from_ical(obj.data)
        master = _find_master(ical)
        if master is None:
            raise ValueError("Kein Master-VEVENT gefunden")

        result: dict = {}

        if mode == "all":
            _apply_move_all(ical, master, original_start, new_start, all_day)
            obj.data = ical.to_ical()
            obj.save()

        elif mode == "single":
            if recurrence_id is None:
                raise ValueError("recurrence_id ist für mode='single' erforderlich")
            _apply_move_single(ical, master, uid, recurrence_id, new_start, new_end, all_day)
            obj.data = ical.to_ical()
            obj.save()

        elif mode == "future":
            if recurrence_id is None:
                raise ValueError("recurrence_id ist für mode='future' erforderlich")
            new_uid = _apply_move_future(cal, ical, master, recurrence_id, new_start, new_end, all_day)
            obj.data = ical.to_ical()
            obj.save()
            result["new_uid"] = new_uid

        else:
            raise ValueError(f"Unbekannter mode: {mode}")

        return result

    except (ValueError, ConflictError):
        raise
    except Exception as e:
        if "timeout" in str(e).lower() or "ReadTimeout" in type(e).__name__:
            raise CalDAVTimeoutError(f"Nextcloud nicht erreichbar: {e}") from e
        raise CalDAVTimeoutError(f"CalDAV-Fehler: {e}") from e


def _apply_move_all(
    ical: Calendar,
    master: ICalEvent,
    original_start: datetime,
    new_start: datetime,
    all_day: bool,
) -> None:
    """Verschiebt Master + alle Overrides um delta."""
    # Delta naiv berechnen (ohne tz-Konvertierung)
    o = original_start.replace(tzinfo=None) if original_start.tzinfo else original_start
    n = new_start.replace(tzinfo=None) if new_start.tzinfo else new_start
    delta = n - o

    # Master shiften
    _shift_component(master, delta, all_day)

    # Alle Overrides ebenfalls shiften (relativ zum Master)
    for override in _find_overrides(ical):
        _shift_component(override, delta, all_day)
        # RECURRENCE-ID ebenfalls shiften, damit der Override zur neuen Instanz passt
        rid = override.get("RECURRENCE-ID")
        if rid is not None:
            old = rid.dt
            if isinstance(old, datetime):
                override.pop("RECURRENCE-ID", None)
                override.add("RECURRENCE-ID", old + delta)
            elif isinstance(old, date_cls):
                override.pop("RECURRENCE-ID", None)
                override.add("RECURRENCE-ID", old + delta)


def _shift_component(comp: ICalEvent, delta: timedelta, all_day: bool) -> None:
    """Verschiebt DTSTART und DTEND einer Komponente um delta."""
    dtstart = comp.get("DTSTART")
    dtend = comp.get("DTEND")

    if dtstart is not None:
        old = dtstart.dt
        comp.pop("DTSTART", None)
        if isinstance(old, datetime):
            comp.add("DTSTART", old + delta)
        elif isinstance(old, date_cls):
            comp.add("DTSTART", old + delta)

    if dtend is not None:
        old = dtend.dt
        comp.pop("DTEND", None)
        if isinstance(old, datetime):
            comp.add("DTEND", old + delta)
        elif isinstance(old, date_cls):
            comp.add("DTEND", old + delta)


def _apply_move_single(
    ical: Calendar,
    master: ICalEvent,
    uid: str,
    recurrence_id: datetime,
    new_start: datetime,
    new_end: datetime,
    all_day: bool,
) -> None:
    """Fügt einen RECURRENCE-ID-Override hinzu. Ersetzt existierenden Override für dasselbe Datum."""
    # Existierenden Override für dasselbe recurrence_id entfernen
    to_remove = []
    for sub in ical.subcomponents:
        if getattr(sub, "name", None) != "VEVENT":
            continue
        rid = sub.get("RECURRENCE-ID")
        if rid is None:
            continue
        if _dt_equal(rid.dt, recurrence_id):
            to_remove.append(sub)
    for sub in to_remove:
        ical.subcomponents.remove(sub)

    # Neuen Override anlegen
    override = ICalEvent()
    override.add("UID", uid)

    # Felder vom Master übernehmen
    if "SUMMARY" in master:
        override.add("SUMMARY", master["SUMMARY"])
    if "LOCATION" in master:
        override.add("LOCATION", master["LOCATION"])
    if "DESCRIPTION" in master:
        override.add("DESCRIPTION", master["DESCRIPTION"])

    override.add("DTSTAMP", datetime.now(timezone.utc))

    if all_day:
        # RECURRENCE-ID als date für all-day
        rid_val = recurrence_id.date() if isinstance(recurrence_id, datetime) else recurrence_id
        override.add("RECURRENCE-ID", rid_val)
        override.add("DTSTART", new_start.date() if isinstance(new_start, datetime) else new_start)
        override.add("DTEND", new_end.date() if isinstance(new_end, datetime) else new_end)
    else:
        override.add("RECURRENCE-ID", recurrence_id)
        override.add("DTSTART", new_start)
        override.add("DTEND", new_end)

    ical.add_component(override)


def _apply_move_future(
    caldav_cal,
    ical: Calendar,
    master: ICalEvent,
    recurrence_id: datetime,
    new_start: datetime,
    new_end: datetime,
    all_day: bool,
) -> str:
    """
    Setzt UNTIL im Master-RRULE auf (recurrence_id - 1 Sekunde / 1 Tag),
    erstellt neues Event mit eigener UID ab new_start.
    Gibt die neue UID zurück.
    """
    rrule = master.get("RRULE")
    if rrule is None:
        raise ValueError("Master hat keine RRULE — 'future' nicht möglich")

    # UNTIL setzen
    if all_day:
        until_val = (recurrence_id.date() if isinstance(recurrence_id, datetime) else recurrence_id) - timedelta(days=1)
    else:
        until = recurrence_id - timedelta(seconds=1)
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
        else:
            until = until.astimezone(timezone.utc)
        until_val = until

    # RRULE neu setzen (alte ersetzen, da vRecur sich nicht zuverlässig in-place mutieren lässt)
    new_rrule_dict = dict(rrule)
    new_rrule_dict.pop("COUNT", None)  # COUNT und UNTIL sind exklusiv
    new_rrule_dict["UNTIL"] = [until_val]
    master.pop("RRULE", None)
    master.add("RRULE", new_rrule_dict)

    # Etwaige Overrides nach recurrence_id verwerfen — die gehören zum neuen Event
    to_remove = []
    for sub in ical.subcomponents:
        if getattr(sub, "name", None) != "VEVENT":
            continue
        rid = sub.get("RECURRENCE-ID")
        if rid is None:
            continue
        old = rid.dt
        old_dt = old if isinstance(old, datetime) else datetime(old.year, old.month, old.day)
        rid_dt = recurrence_id if isinstance(recurrence_id, datetime) else datetime(recurrence_id.year, recurrence_id.month, recurrence_id.day)
        if old_dt.replace(tzinfo=None) >= rid_dt.replace(tzinfo=None):
            to_remove.append(sub)
    for sub in to_remove:
        ical.subcomponents.remove(sub)

    # Neues Event mit eigener UID, RRULE ohne UNTIL
    new_uid = str(uuid.uuid4())
    new_cal = Calendar()
    new_cal.add("prodid", "-//Termina//termina//EN")
    new_cal.add("version", "2.0")

    new_ev = ICalEvent()
    new_ev.add("uid", new_uid)
    new_ev.add("dtstamp", datetime.now(timezone.utc))
    if "SUMMARY" in master:
        new_ev.add("summary", master["SUMMARY"])
    if "LOCATION" in master:
        new_ev.add("location", master["LOCATION"])
    if "DESCRIPTION" in master:
        new_ev.add("description", master["DESCRIPTION"])

    if all_day:
        new_ev.add("dtstart", new_start.date() if isinstance(new_start, datetime) else new_start)
        new_ev.add("dtend", new_end.date() if isinstance(new_end, datetime) else new_end)
    else:
        new_ev.add("dtstart", new_start)
        new_ev.add("dtend", new_end)

    # RRULE für neue Serie: ursprüngliche Regel ohne UNTIL/COUNT
    fresh_rrule = dict(rrule)
    fresh_rrule.pop("UNTIL", None)
    fresh_rrule.pop("COUNT", None)
    new_ev.add("rrule", fresh_rrule)

    new_cal.add_component(new_ev)
    caldav_cal.save_event(new_cal.to_ical())

    return new_uid
