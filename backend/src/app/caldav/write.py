from __future__ import annotations

import logging
import time
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


def _to_midnight_utc(x) -> datetime:
    """Konvertiert date oder datetime in datetime midnight UTC.

    OxiCloud akzeptiert keine VALUE=DATE-Properties (DTSTART;VALUE=DATE:…),
    sondern erwartet immer vollständige datetime-Werte — auch für Ganztages-Events.
    Midnight UTC ist die kanonische Darstellung für ganztägige Ereignisse.
    """
    d = _to_date(x)
    return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)


def _normalize_all_day(start, end) -> tuple[date_cls, date_cls]:
    """DTEND ist bei all-day Events EXCLUSIVE. end == start wird auf start+1 korrigiert."""
    s = _to_date(start)
    e = _to_date(end)
    if e <= s:
        e = s + timedelta(days=1)
    return s, e


def _normalize_all_day_utc(start, end) -> tuple[datetime, datetime]:
    """Wie _normalize_all_day, gibt aber datetime midnight UTC zurück (OxiCloud-kompatibel)."""
    s, e = _normalize_all_day(start, end)
    return _to_midnight_utc(s), _to_midnight_utc(e)


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
        s_dt, e_dt = _normalize_all_day_utc(start, end)
        ev.add("dtstart", s_dt)
        ev.add("dtend", e_dt)
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

def _caldav_op_with_retry(fn, context: str, retries: int = 2, delay: float = 1.5) -> None:
    """Führt fn() aus und wiederholt bei transienten CalDAV-Fehlern.

    Nextcloud gibt gelegentlich 500 JSON zurück (DB-Lock, interne Locks), die das
    caldav-Lib als XMLSyntaxError auflöst. Ein kurzes Retry löst das zuverlässig.
    ValueError und ConflictError werden nie wiederholt.
    """
    last_exc: Exception | None = None
    for attempt in range(1, retries + 2):
        try:
            fn()
            if attempt > 1:
                logger.info("%s: erfolgreich nach Versuch %d", context, attempt)
            return
        except (ValueError, ConflictError):
            raise
        except Exception as e:
            last_exc = e
            is_timeout = "timeout" in str(e).lower() or "ReadTimeout" in type(e).__name__
            logger.warning(
                "%s: Versuch %d/%d fehlgeschlagen (%s: %s)%s",
                context, attempt, retries + 1, type(e).__name__, e,
                "" if attempt > retries else f" – retry in {delay}s",
            )
            if is_timeout or attempt > retries:
                break
            time.sleep(delay)

    if last_exc and ("timeout" in str(last_exc).lower() or "ReadTimeout" in type(last_exc).__name__):
        raise CalDAVTimeoutError(f"CalDAV-Server nicht erreichbar: {last_exc}") from last_exc
    raise CalDAVTimeoutError(f"CalDAV-Fehler nach {retries + 1} Versuchen: {last_exc}") from last_exc


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

    logger.debug(
        "create_event: all_day=%s start=%s end=%s payload=\n%s",
        all_day, start, end, ical_data.decode("utf-8", errors="replace"),
    )

    client = _get_client()
    cal = _find_caldav_calendar(client, calendar_id)
    if cal is None:
        raise ValueError(f"Kalender nicht gefunden: {calendar_id}")

    _caldav_op_with_retry(
        lambda: cal.save_event(ical_data),
        context=f"create_event(all_day={all_day}, start={start})",
    )

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
                rid_dt = _to_midnight_utc(recurrence_id)
                s_dt, e_dt = _normalize_all_day_utc(start, end)
                override.add("RECURRENCE-ID", rid_dt)
                override.add("DTSTART", s_dt)
                override.add("DTEND", e_dt)
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

        _caldav_op_with_retry(obj.save, context=f"update_event({uid})")

    except (ValueError, ConflictError):
        raise
    except CalDAVTimeoutError:
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

        _caldav_op_with_retry(obj.delete, context=f"delete_event({uid})")
    except (ValueError, ConflictError):
        raise
    except CalDAVTimeoutError:
        raise
    except Exception as e:
        raise CalDAVTimeoutError(f"CalDAV-Fehler: {e}") from e


def delete_occurrence(
    calendar_id: str,
    uid: str,
    etag: str | None,
    recurrence_id: datetime,
    all_day: bool = False,
) -> None:
    """Löscht eine einzelne Instanz einer Terminserie per EXDATE."""
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

        # Eventuelle Override-VEVENTs für diese Instanz entfernen
        to_remove = [
            sub for sub in ical.subcomponents
            if getattr(sub, "name", None) == "VEVENT"
            and sub.get("RECURRENCE-ID") is not None
            and _dt_equal(sub["RECURRENCE-ID"].dt, recurrence_id)
        ]
        for sub in to_remove:
            ical.subcomponents.remove(sub)

        # EXDATE zum Master hinzufügen
        exdate_dt = _to_midnight_utc(recurrence_id) if all_day else _to_utc(recurrence_id)
        existing_exdates = master.get("EXDATE")
        if existing_exdates is None:
            from icalendar import vDDDLists
            master.add("EXDATE", [exdate_dt])
        else:
            # EXDATE kann ein einzelner Wert oder eine Liste sein
            if not isinstance(existing_exdates, list):
                existing_exdates = [existing_exdates]
            all_dts = []
            for ex in existing_exdates:
                dts = ex.dts if hasattr(ex, "dts") else [ex]
                all_dts.extend(dt.dt for dt in dts)
            all_dts.append(exdate_dt)
            del master["EXDATE"]
            master.add("EXDATE", all_dts)

        obj.data = ical.to_ical()
        _caldav_op_with_retry(obj.save, context=f"delete_occurrence({uid}, {recurrence_id})")
    except (ValueError, ConflictError):
        raise
    except CalDAVTimeoutError:
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
            _caldav_op_with_retry(obj.save, context=f"move_event(all, {uid})")

        elif mode == "single":
            if recurrence_id is None:
                raise ValueError("recurrence_id ist für mode='single' erforderlich")
            _apply_move_single(ical, master, uid, recurrence_id, new_start, new_end, all_day)
            obj.data = ical.to_ical()
            _caldav_op_with_retry(obj.save, context=f"move_event(single, {uid})")

        elif mode == "future":
            if recurrence_id is None:
                raise ValueError("recurrence_id ist für mode='future' erforderlich")
            new_uid = _apply_move_future(cal, ical, master, recurrence_id, new_start, new_end, all_day)
            obj.data = ical.to_ical()
            _caldav_op_with_retry(obj.save, context=f"move_event(future, {uid})")
            result["new_uid"] = new_uid

        else:
            raise ValueError(f"Unbekannter mode: {mode}")

        return result

    except (ValueError, ConflictError):
        raise
    except CalDAVTimeoutError:
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
        rid_dt = _to_midnight_utc(recurrence_id)
        s_dt, e_dt = _normalize_all_day_utc(new_start, new_end)
        override.add("RECURRENCE-ID", rid_dt)
        override.add("DTSTART", s_dt)
        override.add("DTEND", e_dt)
    else:
        override.add("RECURRENCE-ID", _to_utc(recurrence_id))
        override.add("DTSTART", _to_utc(new_start))
        override.add("DTEND", _to_utc(new_end))

    ical.add_component(override)


def _split_master_until(
    ical: Calendar,
    master: ICalEvent,
    recurrence_id: datetime,
    all_day: bool,
) -> vRecur:
    """
    Setzt UNTIL im Master-RRULE (= Serie endet vor recurrence_id) und entfernt
    Override-VEVENTs ab recurrence_id (inkl.). Gibt die *ursprüngliche*
    (unveränderte) RRULE zurück, aus der eine Folge-Serie ihre RRULE ableiten kann.
    """
    rrule = master.get("RRULE")
    if rrule is None:
        raise ValueError("Master hat keine RRULE — 'future' nicht möglich")

    master_aware = _master_dtstart_is_aware(master)
    logger.info(
        "split_master_until: master DTSTART tz-aware=%s, recurrence_id=%s, all_day=%s",
        master_aware, recurrence_id, all_day,
    )

    if all_day:
        rid_date = _to_date(recurrence_id)
        until_val = _to_midnight_utc(rid_date - timedelta(days=1))
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

    logger.info("split_master_until: setting UNTIL=%s (master_aware=%s)", until_val, master_aware)

    new_rrule_dict = _strip_rrule_keys(rrule, {"UNTIL", "COUNT"})
    new_rrule_dict["UNTIL"] = [until_val]

    master.pop("RRULE", None)
    master.add("RRULE", new_rrule_dict)

    rid_dt_norm = recurrence_id if isinstance(recurrence_id, datetime) else datetime(
        recurrence_id.year, recurrence_id.month, recurrence_id.day
    )
    to_remove = []
    for sub in ical.subcomponents:
        if getattr(sub, "name", None) != "VEVENT":
            continue
        rid = sub.get("RECURRENCE-ID")
        if rid is None:
            continue
        old = rid.dt
        old_dt = old if isinstance(old, datetime) else datetime(old.year, old.month, old.day)
        if old_dt.replace(tzinfo=None) >= rid_dt_norm.replace(tzinfo=None):
            to_remove.append(sub)
    for sub in to_remove:
        ical.subcomponents.remove(sub)

    return rrule


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
    rrule = _split_master_until(ical, master, recurrence_id, all_day)

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
        s_dt, e_dt = _normalize_all_day_utc(new_start, new_end)
        new_ev.add("dtstart", s_dt)
        new_ev.add("dtend", e_dt)
    else:
        new_ev.add("dtstart", _to_utc(new_start))
        new_ev.add("dtend", _to_utc(new_end))

    fresh_rrule = _strip_rrule_keys(rrule, {"UNTIL", "COUNT"})
    new_ev.add("rrule", fresh_rrule)

    new_cal.add_component(new_ev)
    caldav_cal.save_event(new_cal.to_ical())

    logger.info("move_event[future] created new event uid=%s", new_uid)
    return new_uid


def update_event_future(
    calendar_id: str,
    uid: str,
    etag: str | None,
    summary: str,
    start: datetime,
    end: datetime,
    all_day: bool,
    location: str | None,
    description: str | None,
    recurrence_id: datetime,
) -> str:
    """
    Trennt die Serie an recurrence_id (UNTIL im alten Master) und legt ein neues
    Event mit den geänderten Feldern (gleiche RRULE-Wiederholung) ab dort an.
    Gibt die neue UID zurück.
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

        ical = Calendar.from_ical(obj.data)
        master = _find_master(ical)
        if master is None:
            raise ValueError("Kein Master-VEVENT gefunden")

        rrule = _split_master_until(ical, master, recurrence_id, all_day)
        obj.data = ical.to_ical()
        _caldav_op_with_retry(obj.save, context=f"update_event_future(split, {uid})")

        new_uid = str(uuid.uuid4())
        new_cal = Calendar()
        new_cal.add("prodid", "-//Termina//termina//EN")
        new_cal.add("version", "2.0")

        new_ev = ICalEvent()
        new_ev.add("uid", new_uid)
        new_ev.add("dtstamp", datetime.now(timezone.utc))
        new_ev.add("summary", summary)
        if location:
            new_ev.add("location", location)
        if description:
            new_ev.add("description", description)

        if all_day:
            s_dt, e_dt = _normalize_all_day_utc(start, end)
            new_ev.add("dtstart", s_dt)
            new_ev.add("dtend", e_dt)
        else:
            new_ev.add("dtstart", _to_utc(start))
            new_ev.add("dtend", _to_utc(end))

        fresh_rrule = _strip_rrule_keys(rrule, {"UNTIL", "COUNT"})
        new_ev.add("rrule", fresh_rrule)

        new_cal.add_component(new_ev)
        _caldav_op_with_retry(
            lambda: cal.save_event(new_cal.to_ical()),
            context=f"update_event_future(create, {new_uid})",
        )

        logger.info("update_event_future: created new event uid=%s", new_uid)
        return new_uid

    except (ValueError, ConflictError):
        raise
    except CalDAVTimeoutError:
        raise
    except Exception as e:
        raise CalDAVTimeoutError(f"CalDAV-Fehler: {e}") from e


def delete_future_occurrences(
    calendar_id: str,
    uid: str,
    etag: str | None,
    recurrence_id: datetime,
    all_day: bool = False,
) -> None:
    """Löscht diese und alle folgenden Instanzen einer Serie (UNTIL-Split, kein Folge-Event)."""
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

        _split_master_until(ical, master, recurrence_id, all_day)
        obj.data = ical.to_ical()
        _caldav_op_with_retry(obj.save, context=f"delete_future_occurrences({uid})")
    except (ValueError, ConflictError):
        raise
    except CalDAVTimeoutError:
        raise
    except Exception as e:
        raise CalDAVTimeoutError(f"CalDAV-Fehler: {e}") from e
