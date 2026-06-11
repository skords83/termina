import logging
from datetime import datetime, timezone, date
from typing import Any
import zoneinfo

from lxml import etree
from icalendar import Calendar as ICalendar
from sqlalchemy.orm import Session

from app.caldav.client import get_principal
from app.db.models import Calendar, Event, EventOverride
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)

BERLIN = zoneinfo.ZoneInfo("Europe/Berlin")

# CalDAV XML namespaces
NS_DAV = "DAV:"
NS_CAL = "urn:ietf:params:xml:ns:caldav"
NS = {"d": NS_DAV, "cal": NS_CAL}

# PROPFIND body: request getetag for all calendar objects
_PROPFIND_ETAG_BODY = """<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getetag/>
  </d:prop>
</d:propfind>"""

# MULTIGET body template: fill in <d:href> elements
_MULTIGET_TMPL = """<?xml version="1.0" encoding="utf-8"?>
<cal:calendar-multiget xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <cal:calendar-data/>
  </d:prop>
  {hrefs}
</cal:calendar-multiget>"""


def _parse_dt(value) -> tuple[datetime | None, bool]:
    """Return (datetime_naive_local, all_day)."""
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


def _propfind_etags(client, cal_url: str) -> dict[str, str]:
    """
    PROPFIND Depth:1 → {obj_url: etag} für alle Calendar Objects.
    Ein einziger HTTP-Request.
    """
    resp = client.propfind(
        url=cal_url,
        props=_PROPFIND_ETAG_BODY,
        depth=1,
    )
    etags: dict[str, str] = {}
    try:
        raw_xml = resp.raw if isinstance(resp.raw, bytes) else resp.raw.encode()
        tree = etree.fromstring(raw_xml)
    except Exception as exc:
        logger.warning("Could not parse PROPFIND response for %s: %s", cal_url, exc)
        return etags

    base_url = str(client.url).rstrip("/")

    for response in tree.findall("d:response", NS):
        href = response.findtext("d:href", namespaces=NS) or ""
        # Skip the calendar collection itself
        cal_path = cal_url.replace(base_url, "").rstrip("/")
        if href.rstrip("/") == cal_path:
            continue
        etag_el = response.find(".//d:getetag", NS)
        etag = etag_el.text.strip('"') if etag_el is not None and etag_el.text else ""
        if href:
            # Normalize to full URL
            if href.startswith("/"):
                full_url = base_url + href
            else:
                full_url = href
            etags[full_url] = etag

    return etags


def _multiget_ical(client, cal_url: str, urls: list[str]) -> dict[str, tuple[str, str]]:
    """
    CalDAV REPORT calendar-multiget → {obj_url: (etag, raw_ical)}.
    Holt iCal-Daten für alle angegebenen URLs in einem einzigen HTTP-Request.
    """
    if not urls:
        return {}

    base_url = str(client.url).rstrip("/")

    # Build <d:href> elements — use path-only hrefs as CalDAV servers prefer
    hrefs_xml = "\n  ".join(
        f"<d:href>{url.replace(base_url, '')}</d:href>"
        for url in urls
    )
    body = _MULTIGET_TMPL.format(hrefs=hrefs_xml)

    resp = client.report(url=cal_url, query=body, depth=1)

    result: dict[str, tuple[str, str]] = {}
    try:
        raw_xml = resp.raw if isinstance(resp.raw, bytes) else resp.raw.encode()
        tree = etree.fromstring(raw_xml)
    except Exception as exc:
        logger.error("Could not parse MULTIGET response for %s: %s", cal_url, exc)
        return result

    for response in tree.findall("d:response", NS):
        href = response.findtext("d:href", namespaces=NS) or ""
        full_url = base_url + href if href.startswith("/") else href

        etag_el = response.find(".//d:getetag", NS)
        etag = etag_el.text.strip('"') if etag_el is not None and etag_el.text else ""

        cal_data_el = response.find(".//cal:calendar-data", NS)
        raw = cal_data_el.text if cal_data_el is not None and cal_data_el.text else ""

        if raw:
            result[full_url] = (etag, raw)

    logger.debug("MULTIGET: requested %d, received %d", len(urls), len(result))
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
        db.flush()

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
        db.add(EventOverride(
            master_uid=master_uid,
            recurrence_id=rid_norm,
            start=ov_start_dt,
            end=ov_end_dt,
            summary=str(ov_comp.get("SUMMARY", "")) or None,
            location=str(ov_comp.get("LOCATION", "")) or None,
            description=str(ov_comp.get("DESCRIPTION", "")) or None,
        ))


def _sync_calendar(db: Session, caldav_calendar) -> None:
    cal_url = str(caldav_calendar.url)
    client = caldav_calendar.client

    # ── 1. CTag prüfen ──────────────────────────────────────────────────────
    ctag = None
    try:
        from caldav.elements import dav
        props = caldav_calendar.get_properties([dav.GetCTag()])
        ctag = str(props.get("{http://calendarserver.org/ns/}getctag", "")) or None
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

    # ── 2. Alle ETags via PROPFIND — 1 Request ───────────────────────────────
    try:
        remote_etags = _propfind_etags(client, cal_url)
    except Exception as exc:
        logger.error("PROPFIND failed for %s: %s", cal_url, exc)
        return

    logger.info("Calendar %s: %d remote objects", db_cal.name, len(remote_etags))

    # ── 3. Mit DB vergleichen ─────────────────────────────────────────────────
    local_events: dict[str, Event] = {
        e.uid: e for e in db.query(Event).filter(Event.calendar_id == cal_url).all()
    }
    local_etag_to_uid: dict[str, str] = {
        e.etag: e.uid for e in local_events.values() if e.etag
    }

    urls_to_fetch: list[str] = []
    unchanged_etags: set[str] = set()

    for url, remote_etag in remote_etags.items():
        if remote_etag and remote_etag in local_etag_to_uid:
            unchanged_etags.add(remote_etag)
        else:
            urls_to_fetch.append(url)

    logger.info(
        "Calendar %s: %d unchanged, %d to fetch",
        db_cal.name, len(unchanged_etags), len(urls_to_fetch),
    )

    # ── 4. MULTIGET — nur neue/geänderte URLs, 1 Request ─────────────────────
    seen_uids: set[str] = set()

    if urls_to_fetch:
        try:
            fetched = _multiget_ical(client, cal_url, urls_to_fetch)
        except Exception as exc:
            logger.error("MULTIGET failed for %s: %s", cal_url, exc)
            return

        for obj_url, (remote_etag, raw) in fetched.items():
            _upsert_event(db, cal_url, remote_etag, raw, obj_url, local_events, seen_uids)

    # Unveränderte Events als "gesehen" markieren (nicht löschen!)
    for etag in unchanged_etags:
        uid = local_etag_to_uid.get(etag)
        if uid:
            seen_uids.add(uid)

    # ── 5. Gelöschte Events entfernen ─────────────────────────────────────────
    deleted_count = 0
    for uid, event in local_events.items():
        if uid not in seen_uids:
            logger.info("Deleting removed event: %s", uid)
            db.query(EventOverride).filter(
                EventOverride.master_uid == uid
            ).delete(synchronize_session=False)
            db.delete(event)
            deleted_count += 1

    # ── 6. CTag aktualisieren ─────────────────────────────────────────────────
    db_cal.ctag = ctag
    db_cal.last_synced_at = datetime.now(timezone.utc)
    db.commit()
    logger.info(
        "Sync complete for %s: %d fetched, %d deleted",
        db_cal.name, len(urls_to_fetch), deleted_count,
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