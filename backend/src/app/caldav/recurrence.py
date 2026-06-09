from datetime import datetime, date, timedelta
from icalendar import Calendar as iCal
from dateutil.rrule import rruleset, rrulestr


def expand_event(raw_ical: str, window_start: datetime, window_end: datetime) -> list[dict]:
    """
    Expandiert einen VEVENT (mit oder ohne RRULE) in alle Instanzen
    innerhalb [window_start, window_end).
    Gibt eine Liste von Dicts zurück, die direkt als API-Response-Objekte
    verwendet werden können.
    """
    # Normalisiere Fenster auf naive datetimes (DB-Werte sind immer naive)
    if window_start.tzinfo is not None:
        window_start = window_start.replace(tzinfo=None)
    if window_end.tzinfo is not None:
        window_end = window_end.replace(tzinfo=None)

    cal = iCal.from_ical(raw_ical)

    master = None
    exceptions: dict[datetime, any] = {}  # RECURRENCE-ID → modifizierter VEVENT

    for component in cal.walk():
        if component.name != "VEVENT":
            continue
        recurrence_id = component.get("RECURRENCE-ID")
        if recurrence_id:
            rid = _to_datetime(recurrence_id.dt)
            exceptions[rid] = component
        else:
            master = component

    if master is None:
        return []

    dtstart = _to_datetime(master.get("DTSTART").dt)
    duration = _get_duration(master)
    rrule_prop = master.get("RRULE")

    # Kein RRULE → Einzeltermin
    if not rrule_prop:
        end = dtstart + duration
        if dtstart < window_end and end > window_start:
            return [_build_occurrence(master, dtstart, end, is_recurring=False)]
        return []

    # RRULE vorhanden → Expansion mit rruleset
    rset = rruleset()
    rrule_str = "RRULE:" + rrule_prop.to_ical().decode()
    rset.rrule(rrulestr(rrule_str, dtstart=dtstart, ignoretz=True))

    # EXDATE (gelöschte Instanzen)
    exdate_prop = master.get("EXDATE")
    if exdate_prop:
        # Kann eine einzelne vDDDLists-Instanz oder eine Liste sein
        exdate_list = exdate_prop if isinstance(exdate_prop, list) else [exdate_prop]
        for exdate_group in exdate_list:
            dts = exdate_group.dts if hasattr(exdate_group, "dts") else [exdate_group]
            for exdate in dts:
                rset.exdate(_to_datetime(exdate.dt))

    occurrences = []
    # between() sucht ab window_start - duration, damit Termine die bereits begonnen haben
    # aber noch ins Fenster ragen, nicht verloren gehen
    for start in rset.between(window_start - duration, window_end, inc=True):
        end = start + duration
        if end <= window_start or start >= window_end:
            continue

        # Modifizierte Instanz (RECURRENCE-ID) vorhanden?
        exc = exceptions.get(start)
        if exc is not None:
            exc_start = _to_datetime(exc.get("DTSTART").dt)
            exc_end = exc_start + _get_duration(exc)
            occurrences.append(_build_occurrence(exc, exc_start, exc_end, is_recurring=True))
        else:
            occurrences.append(_build_occurrence(master, start, end, is_recurring=True))

    return occurrences


def _to_datetime(dt) -> datetime:
    """Normalisiert date und datetime auf naive datetime."""
    if isinstance(dt, datetime):
        return dt.replace(tzinfo=None) if dt.tzinfo else dt
    if isinstance(dt, date):
        return datetime(dt.year, dt.month, dt.day)
    return dt


def _get_duration(component) -> timedelta:
    dtstart = _to_datetime(component.get("DTSTART").dt)
    dtend = component.get("DTEND")
    if dtend:
        return _to_datetime(dtend.dt) - dtstart
    duration = component.get("DURATION")
    if duration:
        return duration.dt
    return timedelta(days=1)  # Fallback für Ganztagesevents ohne DTEND


def _build_occurrence(component, start: datetime, end: datetime, is_recurring: bool) -> dict:
    all_day = not isinstance(component.get("DTSTART").dt, datetime)
    uid = str(component.get("UID", ""))
    recurrence_id = component.get("RECURRENCE-ID")

    # Instanzen bekommen eine zusammengesetzte ID damit sie im Frontend eindeutig sind
    if is_recurring or recurrence_id:
        occurrence_uid = f"{uid}_{start.date().isoformat()}"
    else:
        occurrence_uid = uid

    return {
        "uid": occurrence_uid,
        "calendar_id": None,  # wird in events.py gesetzt
        "summary": str(component.get("SUMMARY", "")),
        "start": start.date().isoformat() if all_day else start.isoformat(),
        "end": end.date().isoformat() if all_day else end.isoformat(),
        "all_day": all_day,
        "location": str(component.get("LOCATION", "")) or None,
    }