import logging
from datetime import datetime, timezone, date
from typing import Any
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


def _fetch_remote_etags(caldav_calendar) -> dict[str, str]:
    """PROPFIND: liefert {obj_url: etag} für alle Events — ein einziger HTTP-Request."""
    etags: dict[str, str] = {}
    try:
        # load_objects=False → nur Metadaten (URL + ETag), kein iCal-Download
        for obj in caldav_calendar.objects(load_objects=False):
            obj_url = str(obj.url)
            try:
                props = obj.get_properties(["{DAV:}getetag"])
                etag = props.get("{DAV:}getetag", "")
            except Exception:
                etag = ""
            etags[obj_url] = etag
    except Exception as exc:
        raise RuntimeError(f"PROPFIND failed: {exc}") from exc
    return etags


def _fetch_ical_data(caldav_calendar, urls: list[str]) -> dict[str, tuple[str, str]]:
    """MULTIGET REPORT: holt iCal-Daten nur für die angegebenen URLs.

    Gibt {obj_url: (etag, raw_ical)} zurück.
    Fällt auf Einzel-GETs zurück wenn multiget nicht verfügbar ist.
    """
    result: dict[str, tuple[str, str]] = {}
    if not urls:
        return result

    # Versuche MULTIGET (ein Request für alle URLs)
    try:
        objects = caldav_calendar.multiget(urls)
        for obj in objects:
            obj_url = str(obj.url)
            raw = str(obj.data) if obj.data else ""
            if not raw:
                continue
            try:
                props = obj.get_properties(["{DAV:}getetag"])
                etag = props.get("{DAV:}getetag", "")
            except Exception:
                etag = ""
            result[obj_url] = (etag, raw)
        logger.debug("MULTIGET fetched %d objects in one request", len(result))
        return result
    except AttributeError:
        # Ältere caldav-Lib-Version ohne multiget()
        logger.warning("caldav.multiget() not available, falling back to individual GETs")
    except Exception as exc:
        logger.warning("MULTIGET failed (%s), falling back to individual GETs", exc)

    # Fallback: einzelne GETs
    for url in urls:
        try:
            obj = caldav_calendar.object_by_url(url)
            raw = str(obj.data) if obj.data else ""
            if not raw:
                continue
            try:
                props = obj.get_properties(["{DAV:}getetag"])
                etag = props.get("{DAV:}getetag", "")
            except Exception:
                etag = ""
            result[url] = (etag, raw)
        except Exception as exc:
            logger.warning("GET failed for %s: %s", url, exc)

    return result


def _upsert_event(
    db: Session,
    cal_url: str,
    remote_etag: str,
    raw: str,
    obj_url: str,
    local_events: dict[str, "Event"],
    seen_uids: set[str],
) -> None:
    """Parst eine .ics-Datei und schreibt Master + Overrides in die DB."""
    try:
        ical = ICalendar.from_ical(raw)
    except Exception as exc:
        logger.warning("Could not parse iCal for %s: %s", obj_url, exc)
        return

    master_uid: str | None = None
    master_component: Any = None
    override_components: list[tuple[str, Any, Any]] = []

    for component in ical.walk("VEVENT"):
        comp_uid = str(component.get("UID", obj_url))
        rid_prop = component.get("RECURRENCE-ID")

        if rid_prop is None:
            if master_component is None:
                master_uid = comp_uid
                master_component = component
        else:
            override_components.append((comp_uid, rid_prop.dt, component))

    if master_component is None or master_uid is None:
        logger.warning("No master VEVENT in %s, skipping", obj_url)
        return

    seen_uids.add(master_uid)

    existing = local_events.get(master_uid)
    if existing and existing.etag == remote_etag:
        # ETag stimmt überein → Datei unverändert
        return

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
        db.flush()  # FK für EventOverride muss existieren

    db.query(EventOverride).filter(
        EventOverride.master_uid == master_uid
    ).delete(synchronize_session=False)

    for ov_uid, rid_dt, ov_comp in override_components:
        if ov_uid != master_uid:
            continue

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


def _sync_calendar(db: Session, caldav_calendar) -> None:
    cal_url = str(caldav_calendar.url)

    # ── 1. CTag prüfen (PROPFIND) ───────────────────────────────────────────
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

    # ── 2. Alle ETags holen (PROPFIND, load_objects=False) — 1 Request ──────
    try:
        remote_etags: dict[str, str] = _fetch_remote_etags(caldav_calendar)
    except Exception as exc:
        logger.error("Failed to fetch ETags for %s: %s", cal_url, exc)
        return

    logger.debug("Remote: %d objects", len(remote_etags))

    # ── 3. Mit DB vergleichen ────────────────────────────────────────────────
    local_events: dict[str, Event] = {
        e.uid: e for e in db.query(Event).filter(Event.calendar_id == cal_url).all()
    }
    # url → etag der lokalen Events (wir haben keine URL als PK, aber etag reicht zum Vergleich)
    # Da URL nicht in der DB steht, holen wir für alle remote URLs deren ETag
    # und prüfen ob wir ein lokales Event mit gleichem ETag haben.
    # Strategie: URLs ohne bekanntes lokales ETag-Match → MULTIGET
    local_etags_set: set[str] = {e.etag for e in local_events.values() if e.etag}

    urls_to_fetch: list[str] = []
    remote_urls_set: set[str] = set(remote_etags.keys())

    for url, remote_etag in remote_etags.items():
        if remote_etag not in local_etags_set:
            # Entweder neu oder geändert → muss geholt werden
            urls_to_fetch.append(url)

    deleted_count = 0
    changed_count = len(urls_to_fetch)
    logger.info(
        "Calendar %s: %d remote, %d to fetch",
        db_cal.name, len(remote_etags), changed_count,
    )

    # ── 4. MULTIGET — nur neue/geänderte URLs ────────────────────────────────
    seen_uids: set[str] = set()

    if urls_to_fetch:
        try:
            fetched = _fetch_ical_data(caldav_calendar, urls_to_fetch)
        except Exception as exc:
            logger.error("Failed to fetch iCal data for %s: %s", cal_url, exc)
            return

        for obj_url, (remote_etag, raw) in fetched.items():
            _upsert_event(db, cal_url, remote_etag, raw, obj_url, local_events, seen_uids)

    # Für Events deren ETag unverändert ist, müssen wir trotzdem seen_uids befüllen,
    # damit sie nicht fälschlicherweise als gelöscht markiert werden.
    # Da wir keine URL→UID-Zuordnung in der DB haben, identifizieren wir
    # unveränderte Events über ETag-Übereinstimmung.
    unchanged_etags: set[str] = {
        etag for url, etag in remote_etags.items()
        if url not in urls_to_fetch
    }
    for event in local_events.values():
        if event.etag in unchanged_etags:
            seen_uids.add(event.uid)

    # ── 5. Gelöschte Events entfernen ────────────────────────────────────────
    for uid, event in local_events.items():
        if uid not in seen_uids:
            logger.info("Deleting removed event: %s", uid)
            db.query(EventOverride).filter(
                EventOverride.master_uid == uid
            ).delete(synchronize_session=False)
            db.delete(event)
            deleted_count += 1

    # ── 6. CTag aktualisieren ────────────────────────────────────────────────
    db_cal.ctag = ctag
    db_cal.last_synced_at = datetime.now(timezone.utc)
    db.commit()
    logger.info(
        "Sync complete for %s: %d fetched, %d deleted",
        db_cal.name, changed_count, deleted_count,
    )


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