import logging
import zoneinfo
from datetime import date, datetime, timezone
from typing import Any

from icalendar import Calendar as ICalendar
from lxml import etree

# OxiCloud sendet ungültige XML-Namespace-Präfixe (z.B. <http://apple.com/ns/ical/:calendar-color/>).
# recover=True lässt lxml solche Tags überspringen statt abzubrechen.
_XML_PARSER = etree.XMLParser(recover=True)
from sqlalchemy.orm import Session

from app.caldav.client import get_caldav_client
from app.db.models import Calendar, Event, EventOverride
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)

BERLIN = zoneinfo.ZoneInfo("Europe/Berlin")

# CalDAV XML namespaces
NS_DAV = "DAV:"
NS_CAL = "urn:ietf:params:xml:ns:caldav"
NS_CS = "http://calendarserver.org/ns/"
NS = {"d": NS_DAV, "cal": NS_CAL, "cs": NS_CS}

# Ressourcentypen die als Kalender behandelt werden
_CALENDAR_TYPES = {
    f"{{{NS_CAL}}}calendar",
    f"{{{NS_CS}}}subscribed",
}

# Ressourcentypen die wir explizit ignorieren wollen
_IGNORE_TYPES = {
    f"{{{NS_CAL}}}schedule-inbox",
    f"{{{NS_CAL}}}schedule-outbox",
    "{http://nextcloud.com/ns}trash-bin",
    "{http://nextcloud.com/ns}deleted-calendar",
}

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

_DISCOVERY_BODY = """<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"
            xmlns:cs="http://calendarserver.org/ns/"
            xmlns:a="http://apple.com/ns/ical/">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <a:calendar-color/>
    <cs:getctag/>
    <cs:source/>
  </d:prop>
</d:propfind>"""


def _discover_calendars(client: Any) -> list[dict]:
    """
    Eigenes PROPFIND auf den Kalender-Root — gibt cal:calendar UND
    cs:subscribed zurück. Die caldav-Lib filtert subscribed heraus,
    daher machen wir das selbst.
    """
    from urllib.parse import urlparse

    from app.config import settings

    base_url = str(client.url).rstrip("/")
    parsed = urlparse(base_url)
    host_url = f"{parsed.scheme}://{parsed.netloc}"

    # Kalender-Root per calendar_home_set (funktioniert mit OxiCloud + Nextcloud).
    # Fallback auf den Nextcloud-Pfad falls der Server kein calendar_home_set liefert.
    try:
        cal_home_url = str(client.principal().calendar_home_set.url)
        if cal_home_url.startswith("/"):
            cal_home_url = host_url + cal_home_url
        cal_root = cal_home_url.rstrip("/") + "/"
    except Exception as exc:
        logger.warning(
            "calendar_home_set nicht verfügbar, nutze Fallback-Pfad: %s", exc
        )
        username = settings.caldav_username
        cal_root = f"{base_url}/calendars/{username}/"

    # PROPFIND direkt über urllib statt client.propfind() — die caldav-Lib würde
    # OxiClouds ungültigen XML-Namespace-Prefix (<http://apple.com/ns/ical/:calendar-color/>)
    # intern parsen und dabei abstürzen. Mit urllib + _XML_PARSER(recover=True)
    # überspringt lxml das fehlerhafte Tag und parst den Rest korrekt.
    import base64
    import urllib.error
    import urllib.request as urlreq

    _credentials = base64.b64encode(
        f"{settings.caldav_username}:{settings.caldav_password}".encode()
    ).decode()
    _req = urlreq.Request(
        cal_root,
        data=_DISCOVERY_BODY.encode("utf-8"),
        method="PROPFIND",
        headers={
            "Content-Type": "application/xml; charset=UTF-8",
            "Depth": "1",
            "Authorization": f"Basic {_credentials}",
        },
    )
    try:
        with urlreq.urlopen(_req, timeout=30) as _http_resp:
            raw_xml = _http_resp.read()
    except urllib.error.HTTPError as exc:
        logger.error("PROPFIND auf %s fehlgeschlagen: HTTP %d", cal_root, exc.code)
        return []
    except Exception as exc:
        logger.error("PROPFIND auf %s fehlgeschlagen: %s", cal_root, exc)
        return []

    tree = etree.fromstring(raw_xml, _XML_PARSER)

    calendars = []
    for response in tree.findall("d:response", NS):
        href = response.findtext("d:href", namespaces=NS) or ""

        # Ressourcentypen sammeln
        resourcetype_el = response.find(".//d:resourcetype", NS)
        if resourcetype_el is None:
            continue
        types = {child.tag for child in resourcetype_el}

        # Ignorierte Typen überspringen
        if types & _IGNORE_TYPES:
            continue

        # Nur bekannte Kalender-Typen durchlassen
        if not (types & _CALENDAR_TYPES):
            continue

        displayname = response.findtext(".//d:displayname", namespaces=NS) or ""
        if not displayname:
            # Fallback: letztes Segment der URL
            displayname = href.rstrip("/").split("/")[-1]

        color_el = response.find(".//{http://apple.com/ns/ical/}calendar-color", NS)
        color = (
            color_el.text.strip()[:7]
            if color_el is not None and color_el.text
            else None
        )

        ctag_el = response.find(f".//{{{NS_CS}}}getctag", NS)
        ctag = ctag_el.text if ctag_el is not None and ctag_el.text else None

        # Subscribed-Kalender erkennen und Source-URL extrahieren
        is_subscribed = f"{{{NS_CS}}}subscribed" in types
        source_url = None
        if is_subscribed:
            source_el = response.find(f".//{{{NS_CS}}}source/d:href", NS)
            if source_el is not None and source_el.text:
                source_url = source_el.text.strip()
                # webcal:// → https://
                if source_url.startswith("webcal://"):
                    source_url = "https://" + source_url[len("webcal://") :]

        # Volle URL zusammenbauen — hrefs sind absolute Pfade (/remote.php/...)
        if href.startswith("/"):
            full_url = host_url + href
        else:
            full_url = href

        calendars.append(
            {
                "url": full_url,
                "name": displayname,
                "color": color,
                "ctag": ctag,
                "subscribed": is_subscribed,
                "source_url": source_url,
            }
        )
        logger.debug(
            "Discovered calendar: %s (%s)%s",
            displayname,
            full_url,
            f" [subscribed: {source_url}]" if is_subscribed else "",
        )

    logger.info("Discovered %d calendars", len(calendars))
    return calendars


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


def _infer_all_day(
    start_dt: datetime | None, end_dt: datetime | None, all_day: bool
) -> bool:
    """Detect midnight-to-midnight events as all-day (some ICS sources use T000000)."""
    if all_day:
        return True
    if start_dt is None or end_dt is None:
        return False
    if (
        start_dt.hour == 0
        and start_dt.minute == 0
        and start_dt.second == 0
        and end_dt.hour == 0
        and end_dt.minute == 0
        and end_dt.second == 0
        and end_dt > start_dt
    ):
        return True
    return False


def _host_url(client) -> str:
    """Nur Schema + Host, ohne Pfad. Für href-Rekonstruktion aus DAV-Responses."""
    from urllib.parse import urlparse

    parsed = urlparse(str(client.url))
    return f"{parsed.scheme}://{parsed.netloc}"


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
        tree = etree.fromstring(raw_xml, _XML_PARSER)
    except Exception as exc:
        logger.warning("Could not parse PROPFIND response for %s: %s", cal_url, exc)
        return etags

    from urllib.parse import urlparse

    host = _host_url(client)
    cal_path = urlparse(cal_url).path.rstrip("/")

    for response in tree.findall("d:response", NS):
        href = response.findtext("d:href", namespaces=NS) or ""
        if href.rstrip("/") == cal_path:
            continue
        etag_el = response.find(".//d:getetag", NS)
        etag = etag_el.text.strip('"') if etag_el is not None and etag_el.text else ""
        if href:
            full_url = host + href if href.startswith("/") else href
            etags[full_url] = etag

    return etags


def _multiget_ical(client, cal_url: str, urls: list[str]) -> dict[str, tuple[str, str]]:
    """
    CalDAV REPORT calendar-multiget → {obj_url: (etag, raw_ical)}.
    Holt iCal-Daten für alle angegebenen URLs in einem einzigen HTTP-Request.
    """
    if not urls:
        return {}

    from urllib.parse import urlparse

    host = _host_url(client)

    # Build <d:href> elements — path-only hrefs
    hrefs_xml = "\n  ".join(f"<d:href>{urlparse(url).path}</d:href>" for url in urls)
    body = _MULTIGET_TMPL.format(hrefs=hrefs_xml)

    resp = client.report(url=cal_url, query=body, depth=1)

    result: dict[str, tuple[str, str]] = {}
    try:
        raw_xml = resp.raw if isinstance(resp.raw, bytes) else resp.raw.encode()
        tree = etree.fromstring(raw_xml, _XML_PARSER)
    except Exception as exc:
        logger.error("Could not parse MULTIGET response for %s: %s", cal_url, exc)
        return result

    for response in tree.findall("d:response", NS):
        href = response.findtext("d:href", namespaces=NS) or ""
        full_url = host + href if href.startswith("/") else href

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
    all_day = _infer_all_day(start_dt, end_dt, all_day)

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
        db.add(
            Event(
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
            )
        )
        db.flush()

    db.query(EventOverride).filter(EventOverride.master_uid == master_uid).delete(
        synchronize_session=False
    )

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
        db.add(
            EventOverride(
                master_uid=master_uid,
                recurrence_id=rid_norm,
                start=ov_start_dt,
                end=ov_end_dt,
                summary=str(ov_comp.get("SUMMARY", "")) or None,
                location=str(ov_comp.get("LOCATION", "")) or None,
                description=str(ov_comp.get("DESCRIPTION", "")) or None,
            )
        )


def _sync_subscribed_calendar(db: Session, cal_info: dict) -> None:
    """
    Sync für ICS-Abo-Kalender (cs:subscribed).
    Events aus abonnierten Kalendern sind per PROPFIND/REPORT nicht abrufbar,
    daher holen wir das ICS direkt von der Quell-URL.
    """
    import urllib.error
    import urllib.request

    cal_url = cal_info["url"]
    ctag = cal_info["ctag"]
    source_url = cal_info.get("source_url")

    db_cal = db.get(Calendar, cal_url)
    if db_cal is None:
        db_cal = Calendar(
            id=cal_url,
            name=cal_info["name"],
            color=cal_info["color"],
            ctag=None,
            last_synced_at=None,
        )
        db.add(db_cal)
        db.flush()
        logger.info("New subscribed calendar: %s", cal_info["name"])
    else:
        db_cal.name = cal_info["name"]
        if cal_info["color"]:
            db_cal.color = cal_info["color"]

    if ctag and db_cal.ctag == ctag:
        logger.debug(
            "Subscribed calendar %s unchanged (ctag match), skipping.", db_cal.name
        )
        return

    if not source_url:
        logger.warning(
            "Subscribed calendar %s has no source URL, skipping.", db_cal.name
        )
        db_cal.ctag = ctag
        db_cal.last_synced_at = datetime.now(timezone.utc)
        db.commit()
        return

    logger.info("Syncing subscribed calendar: %s from %s", db_cal.name, source_url)

    # ICS direkt von der Quelle holen
    try:
        req = urllib.request.Request(
            source_url,
            headers={
                "User-Agent": "Termina/1.0 CalDAV-Sync",
            },
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw_ics = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        logger.error(
            "HTTP %d fetching subscribed ICS for %s: %s", exc.code, db_cal.name, exc
        )
        if exc.code in (403, 404, 410):
            # Permanenter Fehler — ctag setzen damit der nächste Sync nicht blind wiederholt
            db_cal.ctag = ctag
            db_cal.last_synced_at = datetime.now(timezone.utc)
            db.commit()
        return
    except Exception as exc:
        # Transienter Fehler (Timeout, Netzwerk) — kein ctag-Update, beim nächsten Intervall retry
        logger.error("Failed to fetch subscribed ICS for %s: %s", db_cal.name, exc)
        return

    # Alle VEVENTs parsen
    try:
        ical = ICalendar.from_ical(raw_ics)
    except Exception as exc:
        logger.error("Failed to parse ICS for %s: %s", db_cal.name, exc)
        # Kaputtes ICS ist kein transienter Fehler — ctag setzen bis die Quelle sich ändert
        db_cal.ctag = ctag
        db_cal.last_synced_at = datetime.now(timezone.utc)
        db.commit()
        return

    local_events: dict[str, Event] = {
        e.uid: e for e in db.query(Event).filter(Event.calendar_id == cal_url).all()
    }
    seen_uids: set[str] = set()
    upserted = 0

    for component in ical.walk("VEVENT"):
        uid = str(component.get("UID", ""))
        if not uid:
            continue
        # Nur Master-Events (kein RECURRENCE-ID) — Overrides werden ggf. separat behandelt
        rid_prop = component.get("RECURRENCE-ID")
        if rid_prop is not None:
            continue

        seen_uids.add(uid)

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
        all_day = _infer_all_day(start_dt, end_dt, all_day)

        existing = local_events.get(uid)
        if existing:
            existing.summary = summary
            existing.start = start_dt
            existing.end = end_dt
            existing.all_day = all_day
            existing.rrule = rrule
            existing.location = location
            existing.description = description
            existing.etag = None
        else:
            db.add(
                Event(
                    uid=uid,
                    calendar_id=cal_url,
                    etag=None,
                    summary=summary,
                    start=start_dt,
                    end=end_dt,
                    all_day=all_day,
                    rrule=rrule,
                    location=location,
                    description=description,
                    raw_ical="",
                )
            )
        upserted += 1

    # Gelöschte Events entfernen
    deleted_count = 0
    for uid, event in local_events.items():
        if uid not in seen_uids:
            db.query(EventOverride).filter(EventOverride.master_uid == uid).delete(
                synchronize_session=False
            )
            db.delete(event)
            deleted_count += 1

    db_cal.ctag = ctag
    db_cal.last_synced_at = datetime.now(timezone.utc)
    db.commit()
    logger.info(
        "Sync complete for subscribed %s: %d upserted, %d deleted",
        db_cal.name,
        upserted,
        deleted_count,
    )


def _sync_ics_feed(db: Session, feed: dict) -> None:
    """Synct einen extern konfigurierten ICS-Feed (read-only, kein CalDAV-Write)."""
    import hashlib
    import urllib.error
    import urllib.request

    url: str = feed["url"]
    if url.startswith("webcal://"):
        url = "https://" + url[len("webcal://"):]

    name: str = feed.get("name", url)
    color: str | None = feed.get("color")
    feed_id = url

    db_cal = db.get(Calendar, feed_id)
    if db_cal is None:
        db_cal = Calendar(id=feed_id, name=name, color=color, ctag=None, last_synced_at=None)
        db.add(db_cal)
        db.flush()
        logger.info("New ICS feed: %s", name)
    else:
        db_cal.name = name
        if color:
            db_cal.color = color

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Termina/1.0 ICS-Sync"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw_ics = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        logger.error("HTTP %d beim Abruf von ICS-Feed %s: %s", exc.code, name, exc)
        return
    except Exception as exc:
        logger.error("Abruf von ICS-Feed %s fehlgeschlagen: %s", name, exc)
        return

    content_hash = hashlib.sha256(raw_ics.encode()).hexdigest()[:16]
    if db_cal.ctag == content_hash:
        logger.debug("ICS-Feed %s unverändert (Hash-Match), übersprungen.", name)
        return

    try:
        ical = ICalendar.from_ical(raw_ics)
    except Exception as exc:
        logger.error("ICS-Feed %s konnte nicht geparst werden: %s", name, exc)
        return

    local_events: dict[str, Event] = {
        e.uid: e for e in db.query(Event).filter(Event.calendar_id == feed_id).all()
    }
    seen_uids: set[str] = set()
    upserted = 0

    for component in ical.walk("VEVENT"):
        uid = str(component.get("UID", ""))
        if not uid or component.get("RECURRENCE-ID") is not None:
            continue

        seen_uids.add(uid)
        summary = str(component.get("SUMMARY", "")) or None
        location = str(component.get("LOCATION", "")) or None
        description = str(component.get("DESCRIPTION", "")) or None
        rrule_prop = component.get("RRULE")
        rrule = str(rrule_prop.to_ical().decode()) if rrule_prop else None

        start_raw = component.get("DTSTART")
        start_dt, all_day = _parse_dt(start_raw.dt if start_raw else None)
        end_raw = component.get("DTEND") or component.get("DURATION")
        end_dt, _ = _parse_dt(end_raw.dt if end_raw else None)
        all_day = _infer_all_day(start_dt, end_dt, all_day)

        existing = local_events.get(uid)
        if existing:
            existing.summary = summary
            existing.start = start_dt
            existing.end = end_dt
            existing.all_day = all_day
            existing.rrule = rrule
            existing.location = location
            existing.description = description
        else:
            db.add(Event(
                uid=uid,
                calendar_id=feed_id,
                etag=None,
                summary=summary,
                start=start_dt,
                end=end_dt,
                all_day=all_day,
                rrule=rrule,
                location=location,
                description=description,
                raw_ical="",
            ))
        upserted += 1

    deleted_count = 0
    for uid, event in local_events.items():
        if uid not in seen_uids:
            db.query(EventOverride).filter(EventOverride.master_uid == uid).delete(
                synchronize_session=False
            )
            db.delete(event)
            deleted_count += 1

    db_cal.ctag = content_hash
    db_cal.last_synced_at = datetime.now(timezone.utc)
    db.commit()
    logger.info(
        "ICS-Feed-Sync abgeschlossen für %s: %d upserted, %d deleted",
        name, upserted, deleted_count,
    )


def _sync_calendar(db: Session, client: Any, cal_info: dict) -> None:
    # Subscribed-Kalender haben einen eigenen Sync-Pfad
    if cal_info.get("subscribed"):
        _sync_subscribed_calendar(db, cal_info)
        return

    cal_url = cal_info["url"]
    ctag = cal_info["ctag"]

    db_cal = db.get(Calendar, cal_url)
    if db_cal is None:
        db_cal = Calendar(
            id=cal_url,
            name=cal_info["name"],
            color=cal_info["color"],
            ctag=None,
            last_synced_at=None,
        )
        db.add(db_cal)
        db.flush()
        logger.info("New calendar: %s", cal_info["name"])
    else:
        # Name/Farbe aktualisieren falls geändert
        db_cal.name = cal_info["name"]
        if cal_info["color"]:
            db_cal.color = cal_info["color"]

    if ctag and db_cal.ctag == ctag:
        logger.debug("Calendar %s unchanged (ctag match), skipping.", db_cal.name)
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
        db_cal.name,
        len(unchanged_etags),
        len(urls_to_fetch),
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
            _upsert_event(
                db, cal_url, remote_etag, raw, obj_url, local_events, seen_uids
            )

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
            db.query(EventOverride).filter(EventOverride.master_uid == uid).delete(
                synchronize_session=False
            )
            db.delete(event)
            deleted_count += 1

    # ── 6. CTag + Kalender entfernen die nicht mehr existieren ───────────────
    db_cal.ctag = ctag
    db_cal.last_synced_at = datetime.now(timezone.utc)
    db.commit()
    logger.info(
        "Sync complete for %s: %d fetched, %d deleted",
        db_cal.name,
        len(urls_to_fetch),
        deleted_count,
    )


def run_sync() -> None:
    """Entry point called by APScheduler."""
    from app.config import settings

    logger.info("Starting CalDAV sync run")
    db: Session = SessionLocal()
    try:
        client = get_caldav_client()

        calendars = _discover_calendars(client)
        remote_urls = {c["url"] for c in calendars}

        for cal_info in calendars:
            try:
                _sync_calendar(db, client, cal_info)
            except Exception as exc:
                logger.error("Error syncing calendar %s: %s", cal_info["url"], exc)
                db.rollback()

        # ICS-Feeds aus Konfiguration
        ics_feed_ids: set[str] = set()
        for feed in settings.ics_feeds:
            url = feed.get("url", "")
            if url.startswith("webcal://"):
                url = "https://" + url[len("webcal://"):]
            ics_feed_ids.add(url)
            try:
                _sync_ics_feed(db, {**feed, "url": url})
            except Exception as exc:
                logger.error("Error syncing ICS feed %s: %s", feed.get("name"), exc)
                db.rollback()

        # Kalender entfernen die weder im CalDAV-Server noch in den ICS-Feeds vorhanden sind
        existing_cals = db.query(Calendar).all()
        for db_cal in existing_cals:
            if db_cal.id not in remote_urls and db_cal.id not in ics_feed_ids:
                logger.info("Removing deleted calendar: %s", db_cal.name)
                db.query(Event).filter(Event.calendar_id == db_cal.id).delete()
                db.delete(db_cal)
        db.commit()

    except Exception as exc:
        logger.error("Sync run failed: %s", exc)
    finally:
        db.close()
    logger.info("CalDAV sync run finished")
