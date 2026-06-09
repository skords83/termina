import logging
from datetime import datetime, timezone

from icalendar import Calendar as ICalendar
from sqlalchemy.orm import Session

from app.caldav.client import get_principal
from app.db.models import Calendar, Event
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)


def _parse_dt(value) -> tuple[datetime | None, bool]:
    """Return (datetime_utc, all_day). Handles date and datetime."""
    from datetime import date

    if value is None:
        return None, False
    if isinstance(value, datetime):
        if value.tzinfo is None:
            # Assume UTC for naive datetimes
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc), False
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc), True
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
        pass  # Some servers don't expose CTag; fall through to full sync

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

    # REPORT: fetch all event ETags
    remote_etags: dict[str, str] = {}  # url → etag
    try:
        results = caldav_calendar.objects_by_sync_token() if False else caldav_calendar.objects()
        for obj in results:
            obj_url = str(obj.url)
            obj_etag = obj.get_properties().get("{DAV:}getetag", "")
            remote_etags[obj_url] = obj_etag
    except Exception as exc:
        logger.error("Failed to list objects for %s: %s", cal_url, exc)
        return

    # Find local events for this calendar
    local_events: dict[str, Event] = {
        e.uid: e for e in db.query(Event).filter(Event.calendar_id == cal_url).all()
    }

    # Track which UIDs are still on the server
    seen_uids: set[str] = set()

    for obj_url, remote_etag in remote_etags.items():
        # Fetch full iCal to get UID
        try:
            obj_data = caldav_calendar.object_by_url(obj_url)
            raw = str(obj_data.data)
        except Exception as exc:
            logger.warning("Could not fetch %s: %s", obj_url, exc)
            continue

        try:
            ical = ICalendar.from_ical(raw)
        except Exception as exc:
            logger.warning("Could not parse iCal for %s: %s", obj_url, exc)
            continue

        for component in ical.walk():
            if component.name != "VEVENT":
                continue

            uid = str(component.get("UID", obj_url))
            seen_uids.add(uid)

            existing = local_events.get(uid)
            if existing and existing.etag == remote_etag:
                continue  # unchanged

            summary = str(component.get("SUMMARY", "")) or None
            location = str(component.get("LOCATION", "")) or None
            description = str(component.get("DESCRIPTION", "")) or None
            rrule_prop = component.get("RRULE")
            rrule = str(rrule_prop.to_ical().decode()) if rrule_prop else None

            start_raw = component.get("DTSTART")
            start_val = start_raw.dt if start_raw else None
            start_dt, all_day = _parse_dt(start_val)

            end_raw = component.get("DTEND") or component.get("DURATION")
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
                    uid=uid,
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

    # Delete events that no longer exist on the server
    for uid, event in local_events.items():
        if uid not in seen_uids:
            logger.info("Deleting removed event: %s", uid)
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
