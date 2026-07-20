# backend/src/app/ics.py
#
# ICS-Import/-Export: Konvertiert zwischen DB-Repräsentation (Event +
# EventOverride) und rohen .ics-Dateien.

from __future__ import annotations

import logging
import uuid
import zoneinfo
from datetime import date, datetime, timezone
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


def _group_vevents_by_uid(data: bytes) -> tuple[dict[str, list[Any]], list[str]]:
    """Parst eine .ics-Datei und gruppiert VEVENTs nach UID (Reihenfolge des ersten Auftretens)."""
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

    return groups, order


def split_ics_for_import(data: bytes) -> list[tuple[str, bytes]]:
    """Gruppiert VEVENTs einer hochgeladenen .ics-Datei nach UID.

    Jede Gruppe (Master + ggf. Override-VEVENTs mit RECURRENCE-ID) wird als
    eigenständiges .ics-Objekt mit einer *neuen* UID zurückgegeben — verhindert
    Kollisionen mit bereits vorhandenen Events (z.B. beim Reimport einer
    zuvor selbst exportierten Datei).

    Returns: Liste von (neue_uid, ical_bytes).
    """
    groups, order = _group_vevents_by_uid(data)

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


def parse_ics_preview(data: bytes) -> list[dict[str, Any]]:
    """Gruppiert VEVENTs einer .ics-Datei nach UID und liefert die Eckdaten des
    Master-Termins je Gruppe, ohne irgendetwas zu schreiben — für die
    Import-Vorschau. `start`/`end` bleiben rohe date/datetime-Objekte (noch
    nicht serialisiert), damit der Aufrufer sie für die Konfliktprüfung
    normalisieren kann.
    """
    groups, order = _group_vevents_by_uid(data)

    previews: list[dict[str, Any]] = []
    for uid in order:
        comps = groups[uid]
        master = next((c for c in comps if c.get("RECURRENCE-ID") is None), comps[0])

        dtstart = master.get("DTSTART")
        start_val = dtstart.dt if dtstart else None
        all_day = start_val is not None and not isinstance(start_val, datetime) and isinstance(start_val, date)

        dtend = master.get("DTEND")
        end_val = dtend.dt if dtend else None

        previews.append({
            "summary": str(master.get("SUMMARY", "")).strip() or "(ohne Titel)",
            "start": start_val,
            "end": end_val,
            "all_day": all_day,
            "is_recurring": master.get("RRULE") is not None,
            "override_count": len(comps) - 1,
        })

    return previews


def annotate_import_conflicts(previews: list[dict[str, Any]], existing: list[Event]) -> None:
    """Setzt `conflict: bool` je Vorschau-Eintrag, falls sich der Termin zeitlich
    mit einem bestehenden Termin im Zielkalender überschneidet. Wiederkehrende
    Termine werden nicht geprüft (Serien-Expansion wäre für eine reine Vorschau
    unverhältnismäßig teuer)."""
    normalized_existing: list[tuple[datetime, datetime]] = []
    for e in existing:
        if e.start is None:
            continue
        e_start = _to_midnight_utc(e.start) if e.all_day else _to_utc(e.start)
        e_end_raw = e.end or e.start
        e_end = _to_midnight_utc(e_end_raw) if e.all_day else _to_utc(e_end_raw)
        normalized_existing.append((e_start, e_end))

    for p in previews:
        p["conflict"] = False
        if p["is_recurring"] or p["start"] is None:
            continue
        start = _to_midnight_utc(p["start"]) if p["all_day"] else _to_utc(p["start"])
        end_raw = p["end"] or p["start"]
        end = _to_midnight_utc(end_raw) if p["all_day"] else _to_utc(end_raw)
        for e_start, e_end in normalized_existing:
            if start < e_end and e_start < end:
                p["conflict"] = True
                break
