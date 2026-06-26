from __future__ import annotations

import logging
import uuid
import zoneinfo
from datetime import datetime, timezone, timedelta, date as date_cls
from typing import Literal

from icalendar import Calendar, Event as ICalEvent
from icalendar.prop import vRecur
from caldav import DAVClient

from app.config import settings

logger = logging.getLogger(__name__)

BERLIN = zoneinfo.ZoneInfo("Europe/Berlin")


def _to_utc(dt: datetime) -> datetime:
    """Konvertiert datetime zu UTC. Naive Datetimes werden als Europe/Berlin behandelt."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=BERLIN)
    return dt.astimezone(timezone.utc)


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
    except Exception as e:
        logger.warning("cal.search() fehlgeschlagen, falle auf Iteration zurück: %s", e)

    for obj in cal.objects(load_objects=True):
        try:
            parsed = Calendar.from_ical(obj.data)
            for component in parsed.walk():
                if component.name == "VEVENT":
                    if str(component.get("uid", "")) == uid:
                        return obj
        except Exception as e:
            logger.warning("Konnte CalDAV-Objekt nicht parsen (übersprungen): %s", e)
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
    if a is None or b is None:
        return a is b

    def _norm(x):
        if isinstance(x, datetime):
            return x.replace(tzinfo=None)
        if isinstance(x, date_cls):
            return datetime(x.year, x.month, x.day)
        return x

    return _norm(a) == _norm(b)


def _master_dtstart_is_aware(master: ICalEvent) -> bool:
    """True wenn der Master-DTSTART tz-aware ist (also mit TZID gespeichert)."""
    dtstart = master.get("DTSTART")
    if dtstart is None:
        return False
    val = dtstart.dt
    return isinstance(val, datetime) and val.tzinfo is not None


def _strip_rrule_keys(rrule, keys_to_remove: set[str]) -> dict:
    """vRecur → dict, ohne bestimmte Keys (case-insensitive)."""
    upper = {k.upper() for k in keys_to_remove}
    result: dict = {}
    for k, v in rrule.items():
        if k.upper() in upper:
            continue
        result[k] = v
    return result


def _parse_rrule_string(rrule_str: str | None) -> vRecur | None:
    """Parst einen RRULE-String (z.B. 'FREQ=WEEKLY;UNTIL=20261231T235959Z') in vRecur."""
    if not rrule_str:
        return None
    s = rrule_str.strip()
    if s.upper().startswith("RRULE:"):
        s = s[6:]
    try:
        return vRecur.from_ical(s)
    except Exception as e:
        logger.warning("Konnte RRULE-String nicht parsen: %r (%s)", rrule_str, e)
        return None


def _to_date(x) -> date_cls:
    """Akzeptiert datetime oder date und gibt date zurück."""
    if isinstance(x, datetime):
        return x.date()
    return x


def _normalize_all_day(start, end) -> tuple[date_cls, date_cls]:
    """
    iCal-Konvention: DTEND ist bei all-day Events EXCLUSIVE.
    Ein eintägiges Event am 19.9. muss DTSTART=20260919, DTEND=20260920 haben.
    Frontend schickt manchmal end == start — hier korrigieren, sonst hat das Event
    in der DB Länge 0 und wird im Range-Filter / Rendering nicht sichtbar.
    """
    s = _to_date(start)
    e = _to_date(end)
    if e <= s:
        e = s + timedelta(days=1)
    return s, e


def _make_ical(
    uid: str,
    summary: str,
    start: datetime,
    end: datetime,
    all_day: bool,
    location: str | None,
    description: str | None,
    rrule: str | None = None,
) -> bytes:
    cal = Calendar()
    cal.add("prodid", "-//Termina//termina//EN")
    cal.add("version", "2.0")

    ev = ICalEvent()
    ev.add("uid", uid)
    ev.add("summary", summary)
    ev.add("dtstamp", datetime.now(timezone.utc))

    if all_day:
        s_date, e_date = _normalize_all_day(start, end)
        ev.add("dtstart", s_date)
        ev.add("dtend", e_date)
    else:
        ev.add("dtstart", _to_utc(start))
        ev.add("dtend", _to_utc(end))

    if location:
        ev.add("location", location)
    if description:
        ev.add("description", description)

    rrule_parsed = _parse_rrule_string(rrule)
    if rrule_parsed is not None:
        ev.add("rrule", rrule_parsed)

    cal.add_component(ev)
    return cal.to_ical()


# ── Create / Update / Delete ─────────────────────────────────────────────────

def create_event(
    calendar_id: str,
    summary: str,
    start: datetime,
    end: datetime,
    all_day: bool = False,
    location: str | None = None,
    description: str | None = None,
    rrule: str | None = None,
) -> str:
    uid = str(uuid.uuid4())
    ical_data = _make_ical(uid, summary, start, end, all_day, location, description, rrule)

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
            raise CalDAVTimeoutError(f"CalDAV-Server nicht erreichbar: {e}") from e
        raise CalDAVTimeoutError(f"CalDAV-Fehler: {e}") from e

    return uid


def update_event(
    calendar_id: str,
    uid: str,
    etag: str | None,
    summary: str,
    start: datetime,
    end: datetime,
    all_day: bool = False,
    location: str | None = None,
    description: str | None = None,
    rrule: str | None = None,
    recurrence_id: datetime | None = None,
) -> None:
    """
    Zwei Pfade:
      1. recurrence_id is None: Master-Event ersetzen (komplette .ics neu schreiben).
      2. recurrence_id given: Override-VEVENT für diese Instanz in bestehende .ics einfügen
         (Master mit RRULE bleibt erhalten).
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
        if current_etag and etag and current_etag != etag:
            raise ConflictError(f"ETag-Konflikt für Event {uid}")

        if recurrence_id is None:
            # Pfad 1: Master ersetzen
            ical_data = _make_ical(uid, summary, start, end, all_day, location, description, rrule)
            obj.data = ical_data
            obj.save()
        else:
            # Pfad 2: Override für eine Instanz einfügen
            ical = Calendar.from_ical(obj.data)

            # Existierenden Override mit gleicher RECURRENCE-ID entfernen
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

            # Neuen Override-VEVENT anlegen
            override = ICalEvent()
            override.add("UID", uid)
            override.add("SUMMARY", summary)
            override.add("DTSTAMP", datetime.now(timezone.utc))

            if all_day:
                rid_val = recurrence_id.date() if isinstance(recurrence_id, datetime) else recurrence_id
                s_date, e_date = _normalize_all_day(start, end)
                override.add("RECURRENCE-ID", rid_val)
                override.add("DTSTART", s_date)
                override.add("DTEND", e_date)
            else:
                override.add("RECURRENCE-ID", _to_utc(recurrence_id))
                override.add("DTSTART", _to_utc(start))
                override.add("DTEND", _to_utc(end))

            if location:
                override.add("LOCATION", location)
            if description:
                override.add("DESCRIPTION", description)

            ical.add_component(override)
            obj.data = ical.to_ical()
            obj.save()

    except (ValueError, ConflictError):
        raise
    except Exception as e:
        raise CalDAVTimeoutError(f"CalDAV-Fehler: {e}") from e


def delete_event(calendar_id: str, uid: str, etag: str | None) -> None:
    try:
        client = _get_client()
        cal = _find_caldav_calendar(client, calendar_id)
        if cal is None:
            raise ValueError(f"Kalender nicht gefunden: {calendar_id}")

        obj = _find_caldav_event(cal, uid)
        if obj is None:
            raise ValueError(f"Event nicht gefunden: {uid}")

        current_etag = _get_etag(obj)
        if current_etag and etag and current_etag != etag:
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
    etag: str | None,
    original_start: datetime,
    new_start: datetime,
    new_end: datetime,
    all_day: bool = False,
    recurrence_id: datetime | None = None,
) -> dict:
    """Verschiebt ein Event. Returns dict, ggf. mit 'new_uid' bei mode='future'."""
    try:
        client = _get_client()
        cal = _find_caldav_calendar(client, calendar_id)
        if cal is None:
            raise ValueError(f"Kalender nicht gefunden: {calendar_id}")

        obj = _find_caldav_event(cal, uid)
        if obj is None:
            raise ValueError(f"Event nicht gefunden: {uid}")

        current_etag = _get_etag(obj)
        if current_etag and etag and current_etag != etag:
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
        logger.exception("move_event(%s) failed", mode)
        if "timeout" in str(e).lower() or "ReadTimeout" in type(e).__name__:
            raise CalDAVTimeoutError(f"CalDAV-Server nicht erreichbar: {e}") from e
        raise CalDAVTimeoutError(f"CalDAV-Fehler: {e}") from e


def _apply_move_all(
    ical: Calendar,
    master: ICalEvent,
    original_start: datetime,
    new_start: datetime,
    all_day: bool,
) -> None:
    o = original_start.replace(tzinfo=None) if original_start.tzinfo else original_start
    n = new_start.replace(tzinfo=None) if new_start.tzinfo else new_start
    delta = n - o

    _shift_component(master, delta, all_day)

    for override in _find_overrides(ical):
        _shift_component(override, delta, all_day)
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

    override = ICalEvent()
    override.add("UID", uid)

    if "SUMMARY" in master:
        override.add("SUMMARY", master["SUMMARY"])
    if "LOCATION" in master:
        override.add("LOCATION", master["LOCATION"])
    if "DESCRIPTION" in master:
        override.add("DESCRIPTION", master["DESCRIPTION"])

    override.add("DTSTAMP", datetime.now(timezone.utc))

    if all_day:
        rid_val = recurrence_id.date() if isinstance(recurrence_id, datetime) else recurrence_id
        s_date, e_date = _normalize_all_day(new_start, new_end)
        override.add("RECURRENCE-ID", rid_val)
        override.add("DTSTART", s_date)
        override.add("DTEND", e_date)
    else:
        override.add("RECURRENCE-ID", _to_utc(recurrence_id))
        override.add("DTSTART", _to_utc(new_start))
        override.add("DTEND", _to_utc(new_end))

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
    Setzt UNTIL im Master-RRULE (= alte Serie endet vor recurrence_id),
    erstellt neues Event mit eigener UID ab new_start mit gleicher RRULE.
    """
    rrule = master.get("RRULE")
    if rrule is None:
        raise ValueError("Master hat keine RRULE — 'future' nicht möglich")

    master_aware = _master_dtstart_is_aware(master)
    logger.info(
        "move_event[future] master DTSTART tz-aware=%s, recurrence_id=%s, all_day=%s",
        master_aware, recurrence_id, all_day,
    )

    if all_day:
        rid_date = recurrence_id.date() if isinstance(recurrence_id, datetime) else recurrence_id
        until_val = rid_date - timedelta(days=1)
    else:
        rid_dt = recurrence_id if isinstance(recurrence_id, datetime) else datetime(
            recurrence_id.year, recurrence_id.month, recurrence_id.day
        )
        rid_naive = rid_dt.replace(tzinfo=None) if rid_dt.tzinfo else rid_dt
        until_naive_local = rid_naive - timedelta(seconds=1)

        if master_aware:
            until_val = until_naive_local.replace(tzinfo=BERLIN).astimezone(timezone.utc)
        else:
            until_val = until_naive_local

    logger.info("move_event[future] setting UNTIL=%s (master_aware=%s)", until_val, master_aware)

    new_rrule_dict = _strip_rrule_keys(rrule, {"UNTIL", "COUNT"})
    new_rrule_dict["UNTIL"] = [until_val]

    master.pop("RRULE", None)
    master.add("RRULE", new_rrule_dict)

    to_remove = []
    for sub in ical.subcomponents:
        if getattr(sub, "name", None) != "VEVENT":
            continue
        rid = sub.get("RECURRENCE-ID")
        if rid is None:
            continue
        old = rid.dt
        old_dt = old if isinstance(old, datetime) else datetime(old.year, old.month, old.day)
        rid_dt_norm = recurrence_id if isinstance(recurrence_id, datetime) else datetime(
            recurrence_id.year, recurrence_id.month, recurrence_id.day
        )
        if old_dt.replace(tzinfo=None) >= rid_dt_norm.replace(tzinfo=None):
            to_remove.append(sub)
    for sub in to_remove:
        ical.subcomponents.remove(sub)

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
        s_date, e_date = _normalize_all_day(new_start, new_end)
        new_ev.add("dtstart", s_date)
        new_ev.add("dtend", e_date)
    else:
        new_ev.add("dtstart", _to_utc(new_start))
        new_ev.add("dtend", _to_utc(new_end))

    fresh_rrule = _strip_rrule_keys(rrule, {"UNTIL", "COUNT"})
    new_ev.add("rrule", fresh_rrule)

    new_cal.add_component(new_ev)
    caldav_cal.save_event(new_cal.to_ical())

    logger.info("move_event[future] created new event uid=%s", new_uid)
    return new_uid
