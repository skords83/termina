import logging
from datetime import datetime, timezone, date
import zoneinfo

from icalendar import Calendar as ICalendar
from sqlalchemy.orm import Session

from app.caldav.client import get_principal
from app.db.models import Calendar, Event, EventOverride
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)

BERLIN = zoneinfo.ZoneInfo("Europe/Berlin")


def _parse_dt(value) -> tuple[datetime | None, bool]:
    """Return (datetime_naive_local, all_day).

    Speichert naive Datetimes in Europe/Berlin-Lokalzeit, damit das Frontend
    sie ohne Umrechnung anzeigen kann.

    Nextcloud liefert:
      - DTSTART mit TZID=Europe/Berlin → aware datetime → nach Berlin konvertieren
      - DTSTART als naive datetime     → bereits Lokalzeit, tzinfo nur entfernen
      - DATE (ganztägig)               → date-Objekt → datetime um Mitternacht
    """
    if value is None:
        return None, False

    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=None), False
        else:
            local = value.astimezone(BERLIN)
            return local.replace(tzinfo=None), False

    if isinstance(value, date):
        return datetime(value.year, value.month, value.day), True

    return None, False


def _sync_calendar(db: Session, caldav_calendar) -> None:
    cal_url = str(caldav_calendar.url)

    # Fetch current CTag via PROPFIND
    caldav_calendar.get_properties()
    ctag = None
    try:
        from caldav.elements import dav
        props = caldav_calendar.get_properties([dav.GetCTag()])
        ctag = str(props.get("{http://calendarserver.org/ns/}getctag", ""))
    except Exception:
        pass

    db_cal = db.get(Calendar, cal_url)
    if db_cal is None:
        color = None
        try:
            from caldav.elements import cdav
            props = caldav_calendar.get_properties([cdav.CalendarColor()])
            color = props.get("{http://apple.com/ns/ical/}calendar-color")
        except Exception:
            pass

        db_cal = Calendar(
            id=cal_url,
            name=caldav_calendar.name or "Unnamed",
            color=color,
            ctag=None,
            last_synced_at=None,
        )
        db.add(db_cal)
        db.flush()

    if ctag and db_cal.ctag == ctag:
        logger.debug("Calendar %s unchanged (ctag match), skipping.", cal_url)
        return

    logger.info("Syncing calendar: %s", db_cal.name)

    # REPORT: fetch all event ETags + data in one go
    remote_objects: dict[str, tuple[str, str]] = {}  # url → (etag, raw_ical)
    try:
        for obj in caldav_calendar.objects(load_objects=True):
            obj_url = str(obj.url)
            obj_etag = obj.get_properties().get("{DAV:}getetag", "")
            raw = str(obj.data) if obj.data else ""
            if raw:
                remote_objects[obj_url] = (obj_etag, raw)
    except Exception as exc:
        logger.error("Failed to list objects for %s: %s", cal_url, exc)
        return

    local_events: dict[str, Event] = {
        e.uid: e for e in db.query(Event).filter(Event.calendar_id == cal_url).all()
    }

    seen_uids: set[str] = set()

    for obj_url, (remote_etag, raw) in remote_objects.items():
        try:
            ical = ICalendar.from_ical(raw)
        except Exception as exc:
            logger.warning("Could not parse iCal for %s: %s", obj_url, exc)
            continue

        # VEVENTs in Master + Overrides aufteilen
        master_uid: str | None = None
        master_component = None
        override_components: list[tuple[str, object, object]] = []  # (uid, rid_dt, component)

        for component in ical.walk("VEVENT"):
            comp_uid = str(component.get("UID", obj_url))
            rid_prop = component.get("RECURRENCE-ID")

            if rid_prop is None:
                # Master — bei Duplikaten den ersten nehmen
                if master_component is None:
                    master_uid = comp_uid
                    master_component = component
            else:
                override_components.append((comp_uid, rid_prop.dt, component))

        if master_component is None or master_uid is None:
            logger.warning("No master VEVENT in %s, skipping", obj_url)
            continue

        seen_uids.add(master_uid)

        existing = local_events.get(master_uid)
        if existing and existing.etag == remote_etag:
            # ETag identisch → Datei (Master + Overrides) unverändert, alles überspringen
            continue

        # Master parsen
        summary = str(master_component.get("SUMMARY", "")) or None
        location = str(master_component.get("LOCATION", "")) or None
        description = str(master_component.get("DESCRIPTION", "")) or None
        rrule_prop = master_component.get("RRULE")
        rrule = str(rrule_prop.to_ical().decode()) if rrule_prop else None

        start_raw = master_component.get("DTSTART")
        start_val = start_raw.dt if start_raw else None
        start_dt, all_day = _parse_dt(start_val)

        end_raw = master_component.get("DTEND") or master_component.get("DURATION")
        end_val = end_raw.dt if end_raw else None
        end_dt, _ = _parse_dt(end_val)

        if existing:
            existing.etag = remote_etag
            existing.summary = summary
            existing.start = start_dt
            existing.end = end_dt
            existing.all_day = all_day
            existing.rrule = rrule
            existing.location = location
            existing.description = description
            existing.raw_ical = raw
        else:
            db.add(Event(
                uid=master_uid,
                calendar_id=cal_url,
                etag=remote_etag,
                summary=summary,
                start=start_dt,
                end=end_dt,
                all_day=all_day,
                rrule=rrule,
                location=location,
                description=description,
                raw_ical=raw,
            ))
            db.flush()  # damit FK für EventOverride existiert

        # Overrides synchronisieren: alles für diese master_uid weg + neu schreiben
        db.query(EventOverride).filter(
            EventOverride.master_uid == master_uid
        ).delete(synchronize_session=False)

        for ov_uid, rid_dt, ov_comp in override_components:
            if ov_uid != master_uid:
                continue  # sollte nicht vorkommen

            rid_norm, _ = _parse_dt(rid_dt)
            if rid_norm is None:
                continue

            ov_start_raw = ov_comp.get("DTSTART")
            ov_start_val = ov_start_raw.dt if ov_start_raw else None
            ov_start_dt, _ = _parse_dt(ov_start_val)

            ov_end_raw = ov_comp.get("DTEND")
            ov_end_val = ov_end_raw.dt if ov_end_raw else None
            ov_end_dt, _ = _parse_dt(ov_end_val)

            ov_summary = str(ov_comp.get("SUMMARY", "")) or None
            ov_location = str(ov_comp.get("LOCATION", "")) or None
            ov_description = str(ov_comp.get("DESCRIPTION", "")) or None

            db.add(EventOverride(
                master_uid=master_uid,
                recurrence_id=rid_norm,
                start=ov_start_dt,
                end=ov_end_dt,
                summary=ov_summary,
                location=ov_location,
                description=ov_description,
            ))

    # Events löschen die nicht mehr auf dem Server sind
    for uid, event in local_events.items():
        if uid not in seen_uids:
            logger.info("Deleting removed event: %s", uid)
            # Overrides werden via cascade mitgelöscht (passive_deletes + ondelete=CASCADE)
            # Fallback explizit, falls SQLite FK-Cascade nicht aktiv ist:
            db.query(EventOverride).filter(
                EventOverride.master_uid == uid
            ).delete(synchronize_session=False)
            db.delete(event)

    db_cal.ctag = ctag
    db_cal.last_synced_at = datetime.now(timezone.utc)
    db.commit()
    logger.info("Sync complete for calendar: %s", db_cal.name)


def run_sync() -> None:
    """Entry point called by APScheduler."""
    logger.info("Starting CalDAV sync run")
    db: Session = SessionLocal()
    try:
        principal = get_principal()
        calendars = principal.calendars()
        for cal in calendars:
            try:
                _sync_calendar(db, cal)
            except Exception as exc:
                logger.error("Error syncing calendar %s: %s", cal.url, exc)
                db.rollback()
    except Exception as exc:
        logger.error("Sync run failed: %s", exc)
    finally:
        db.close()
    logger.info("CalDAV sync run finished")