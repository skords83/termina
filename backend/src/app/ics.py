# backend/src/app/ics.py
#
# ICS-Import/-Export: Konvertiert zwischen DB-Repräsentation (Event +
# EventOverride) und rohen .ics-Dateien.

from __future__ import annotations

import logging
import uuid
import zoneinfo
from datetime import datetime, timezone
from typing import Any

from icalendar import Calendar, Event as ICalEvent
from icalendar.prop import vRecur

from app.db.models import Event, EventOverride

logger = logging.getLogger(__name__)

BERLIN = zoneinfo.ZoneInfo("Europe/Berlin")


def _to_utc(dt: datetime) -> datetime:
    """Konvertiert datetime zu UTC. Naive Datetimes werden als Europe/Berlin behandelt."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=BERLIN)
    return dt.astimezone(timezone.utc)


def _to_midnight_utc(d) -> datetime:
    if isinstance(d, datetime):
        d = d.date()
    return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)


def _add_dt(comp: ICalEvent, key: str, value: datetime, all_day: bool) -> None:
    if all_day:
        comp.add(key, _to_midnight_utc(value))
    else:
        comp.add(key, _to_utc(value))


def _parse_rrule(rrule_str: str | None) -> vRecur | None:
    if not rrule_str:
        return None
    s = rrule_str.strip()
    if s.upper().startswith("RRULE:"):
        s = s[6:]
    try:
        return vRecur.from_ical(s)
    except Exception as e:
        logger.warning("Export: RRULE nicht parsebar: %r (%s)", rrule_str, e)
        return None


def build_export_calendar(
    events: list[Event],
    overrides_by_uid: dict[str, list[EventOverride]],
) -> bytes:
    """Baut eine einzelne .ics-Datei aus Event- + EventOverride-Datensätzen.

    Arbeitet auf der DB-Sicht (nicht auf dem rohen CalDAV-Text), damit lokal
    noch nicht synchronisierte Änderungen ebenfalls exportiert werden.
    """
    cal = Calendar()
    cal.add("prodid", "-//Termina//termina//EN")
    cal.add("version", "2.0")

    for event in events:
        if event.start is None:
            continue

        ev = ICalEvent()
        ev.add("uid", event.uid)
        ev.add("summary", event.summary or "")
        ev.add("dtstamp", datetime.now(timezone.utc))
        _add_dt(ev, "dtstart", event.start, event.all_day)
        if event.end is not None:
            _add_dt(ev, "dtend", event.end, event.all_day)
        if event.location:
            ev.add("location", event.location)
        if event.description:
            ev.add("description", event.description)

        override_comps: list[ICalEvent] = []
        exdates: list[datetime] = []

        if event.rrule:
            rrule_parsed = _parse_rrule(event.rrule)
            if rrule_parsed is not None:
                ev.add("rrule", rrule_parsed)

            for ov in overrides_by_uid.get(event.uid, []):
                if ov.start is None:
                    # Gelöschte Instanz einer Serie → EXDATE statt Override-VEVENT.
                    exdates.append(
                        _to_midnight_utc(ov.recurrence_id) if event.all_day else _to_utc(ov.recurrence_id)
                    )
                    continue

                ov_ev = ICalEvent()
                ov_ev.add("uid", event.uid)
                ov_ev.add("dtstamp", datetime.now(timezone.utc))
                _add_dt(ov_ev, "recurrence-id", ov.recurrence_id, event.all_day)
                _add_dt(ov_ev, "dtstart", ov.start, event.all_day)
                if ov.end is not None:
                    _add_dt(ov_ev, "dtend", ov.end, event.all_day)
                ov_ev.add("summary", ov.summary or event.summary or "")
                loc = ov.location or event.location
                if loc:
                    ov_ev.add("location", loc)
                desc = ov.description or event.description
                if desc:
                    ov_ev.add("description", desc)
                override_comps.append(ov_ev)

            if exdates:
                ev.add("exdate", exdates)

        cal.add_component(ev)
        for oc in override_comps:
            cal.add_component(oc)

    return cal.to_ical()


class IcsImportError(Exception):
    pass


def split_ics_for_import(data: bytes) -> list[tuple[str, bytes]]:
    """Parst eine hochgeladene .ics-Datei und gruppiert VEVENTs nach UID.

    Jede Gruppe (Master + ggf. Override-VEVENTs mit RECURRENCE-ID) wird als
    eigenständiges .ics-Objekt mit einer *neuen* UID zurückgegeben — verhindert
    Kollisionen mit bereits vorhandenen Events (z.B. beim Reimport einer
    zuvor selbst exportierten Datei).

    Returns: Liste von (neue_uid, ical_bytes).
    """
    try:
        parsed = Calendar.from_ical(data)
    except Exception as e:
        raise IcsImportError(f"Ungültige .ics-Datei: {e}") from e

    groups: dict[str, list[Any]] = {}
    order: list[str] = []
    for component in parsed.walk("VEVENT"):
        uid = str(component.get("UID", "")).strip()
        if not uid:
            continue
        if uid not in groups:
            groups[uid] = []
            order.append(uid)
        groups[uid].append(component)

    if not order:
        raise IcsImportError("Keine Termine (VEVENT) in der Datei gefunden")

    results: list[tuple[str, bytes]] = []
    for old_uid in order:
        new_uid = str(uuid.uuid4())
        new_cal = Calendar()
        new_cal.add("prodid", "-//Termina//termina//EN")
        new_cal.add("version", "2.0")
        for comp in groups[old_uid]:
            comp.pop("UID", None)
            comp.add("UID", new_uid)
            new_cal.add_component(comp)
        results.append((new_uid, new_cal.to_ical()))

    return results
