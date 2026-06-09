"""CTag/ETag-Sync-Logik.

Ablauf pro Kalender:
1. PROPFIND → aktuellen CTag lesen
2. CTag unveraendert → ueberspringen
3. CTag neu → REPORT fuer alle Event-ETags
4. Pro Event mit neuem/geaendertem ETag → vollstaendiges iCal holen + parsen
5. Events, die nicht mehr in der Response sind → aus DB loeschen
6. CTag + last_synced_at in DB aktualisieren
"""

import logging
from datetime import UTC, datetime

from icalendar import Calendar as iCalCalendar  # type: ignore
from icalendar import Event as iCalEvent

from app.caldav.client import discover_calendars, fetch_event_ical, get_event_etags
from app.db.models import Calendar, Event
from app.db.session import get_session

logger = logging.getLogger(__name__)


def run_sync() -> None:
    """Einstiegspunkt fuer den Scheduler. Synct alle Kalender."""
    logger.info("CalDAV-Sync gestartet")
    try:
        _sync_all()
    except Exception as exc:
        logger.error("Sync fehlgeschlagen: %s", exc, exc_info=True)
    logger.info("CalDAV-Sync abgeschlossen")


# ---------------------------------------------------------------------------
# Interne Funktionen
# ---------------------------------------------------------------------------

def _sync_all() -> None:
    remote_calendars = discover_calendars()
    with get_session() as session:
        _upsert_calendars(session, remote_calendars)
        session.commit()

        for cal_info in remote_calendars:
            db_cal = session.get(Calendar, cal_info.url)
            if db_cal is None:
                continue  # sollte nach upsert nicht passieren
            _sync_calendar(session, db_cal, cal_info.ctag)
            session.commit()


def _upsert_calendars(session, remote_calendars) -> None:
    """Legt neue Kalender an, aktualisiert Name/Farbe bestehender."""
    remote_ids = {c.url for c in remote_calendars}

    for cal_info in remote_calendars:
        db_cal = session.get(Calendar, cal_info.url)
        if db_cal is None:
            db_cal = Calendar(
                id=cal_info.url,
                name=cal_info.name,
                color=cal_info.color,
                ctag=None,
            )
            session.add(db_cal)
            logger.info("Neuer Kalender angelegt: %s", cal_info.name)
        else:
            db_cal.name = cal_info.name
            if cal_info.color:
                db_cal.color = cal_info.color

    # Kalender, die nicht mehr remote existieren, aus DB entfernen
    existing = session.query(Calendar).all()
    for db_cal in existing:
        if db_cal.id not in remote_ids:
            logger.info("Kalender entfernt: %s", db_cal.name)
            session.delete(db_cal)


def _sync_calendar(session, db_cal: Calendar, remote_ctag: str | None) -> None:
    """Synct einen einzelnen Kalender via CTag/ETag."""
    if remote_ctag and db_cal.ctag == remote_ctag:
        logger.debug("Kalender unveraendert (CTag match): %s", db_cal.name)
        return

    logger.info("Sync Kalender: %s (ctag alt=%s neu=%s)", db_cal.name, db_cal.ctag, remote_ctag)

    # Alle Event-ETags vom Server holen
    remote_etags: dict[str, str] = get_event_etags(db_cal.id)
    remote_urls = set(remote_etags.keys())

    # Bestehende Events in DB: {uid -> Event}
    db_events: dict[str, Event] = {e.uid: e for e in db_cal.events}

    # Hilfsstruktur: remote_url -> db_event (falls ETag-URL als PK nutzbar waere;
    # wir matchen aber per UID nach dem Parsen)
    updated = 0
    created = 0

    for event_url, remote_etag in remote_etags.items():
        # Finden wir ein DB-Event mit passendem ETag? Dann ueberspringen.
        # (Wir koennen die URL noch nicht direkt auf UID mappen – erst nach dem Parsen.)
        # Einfachste korrekte Strategie: nur laden wenn ETag sich nicht in DB befindet.
        db_event_by_etag = _find_event_by_etag(db_events, remote_etag)
        if db_event_by_etag is not None:
            continue  # unveraendert

        raw = fetch_event_ical(event_url)
        if raw is None:
            continue

        parsed = _parse_ical(raw)
        if parsed is None:
            continue

        uid = parsed["uid"]
        if uid in db_events:
            # Update
            ev = db_events[uid]
            _apply_parsed(ev, parsed, remote_etag, raw)
            updated += 1
        else:
            # Insert
            ev = Event(uid=uid, calendar_id=db_cal.id)
            _apply_parsed(ev, parsed, remote_etag, raw)
            session.add(ev)
            created += 1

    # Geloeschte Events entfernen: Events in DB, deren ETag nicht mehr remote vorkommt
    remote_etag_values = set(remote_etags.values())
    for uid, ev in list(db_events.items()):
        # Event existiert nicht mehr remote (ETag-URL nicht in remote_urls trickreich –
        # einfacher: wenn der ETag des DB-Events nicht mehr in remote_etag_values ist,
        # ist er geloescht oder veraendert. Geloeschte haben kein neues ETag.)
        if ev.etag not in remote_etag_values:
            # Pruefe ob die UID noch irgendwie zugeordnet werden kann
            # Wir loeschen nur wenn remote_urls leer ODER kein Event mit diesem uid mehr kommt
            # Sicherer Ansatz: nach dem Sync alle Events loeschen, deren ETag-URL nicht existiert
            pass  # s.u.

    # Sicherere Methode fuer Loeschungen: alle DB-Events durchgehen
    # und pruefen ob ihr ETag noch unter den remote ETags vorkommt
    surviving_etags = set(remote_etags.values())
    for uid, ev in list(db_events.items()):
        if ev.etag is not None and ev.etag not in surviving_etags:
            logger.info("Event geloescht: %s", ev.summary)
            session.delete(ev)

    db_cal.ctag = remote_ctag
    db_cal.last_synced_at = datetime.now(UTC)

    logger.info(
        "Kalender %s: %d neu, %d aktualisiert",
        db_cal.name, created, updated,
    )


def _find_event_by_etag(db_events: dict[str, Event], etag: str) -> Event | None:
    for ev in db_events.values():
        if ev.etag == etag:
            return ev
    return None


def _parse_ical(raw: str) -> dict | None:
    """Parst ein VCALENDAR-String und gibt die relevanten Felder zurueck."""
    try:
        cal = iCalCalendar.from_ical(raw)
    except Exception as exc:
        logger.warning("iCal-Parse-Fehler: %s", exc)
        return None

    for component in cal.walk():
        if component.name != "VEVENT":
            continue

        uid = str(component.get("UID", ""))
        if not uid:
            continue

        summary = str(component.get("SUMMARY", "")) or None
        location = str(component.get("LOCATION", "")) or None
        description = str(component.get("DESCRIPTION", "")) or None

        dtstart = component.get("DTSTART")
        dtend = component.get("DTEND")

        start_dt, all_day = _parse_dt(dtstart)
        end_dt, _ = _parse_dt(dtend)

        rrule = None
        if component.get("RRULE"):
            rrule = component["RRULE"].to_ical().decode()

        return {
            "uid": uid,
            "summary": summary,
            "location": location,
            "description": description,
            "start": start_dt,
            "end": end_dt,
            "all_day": all_day,
            "rrule": rrule,
        }

    return None


def _parse_dt(dt_prop) -> tuple[datetime | None, bool]:
    """Gibt (datetime, all_day) zurueck. all_day=True wenn nur ein date, kein datetime."""
    if dt_prop is None:
        return None, False

    from datetime import date
    val = dt_prop.dt

    if isinstance(val, datetime):
        # Naive datetimes (floating) als UTC behandeln
        if val.tzinfo is None:
            val = val.replace(tzinfo=UTC)
        return val, False

    if isinstance(val, date):
        # Ganztaegig: date → datetime um Mitternacht UTC
        return datetime(val.year, val.month, val.day, tzinfo=UTC), True

    return None, False


def _apply_parsed(ev: Event, parsed: dict, etag: str, raw: str) -> None:
    ev.etag = etag
    ev.summary = parsed["summary"]
    ev.start = parsed["start"]
    ev.end = parsed["end"]
    ev.all_day = parsed["all_day"]
    ev.rrule = parsed["rrule"]
    ev.location = parsed["location"]
    ev.description = parsed["description"]
    ev.raw_ical = raw