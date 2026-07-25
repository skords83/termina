import logging
from datetime import datetime, timezone
from typing import Any

from lxml import etree
from sqlalchemy.orm import Session

from app.caldav.sync import _XML_PARSER, _host_url, _propfind_etags
from app.db.models import Calendar, Event, EventOverride

logger = logging.getLogger(__name__)

NS_DAV = "DAV:"
NS_CARD = "urn:ietf:params:xml:ns:carddav"
NS_CS = "http://calendarserver.org/ns/"
NS = {"d": NS_DAV, "card": NS_CARD, "cs": NS_CS}

BIRTHDAYS_CALENDAR_ID = "birthdays:default"
BIRTHDAYS_CALENDAR_NAME = "Geburtstage"

# RFC 6474: konventionelles Platzhalter-Jahr für BDAY ohne Jahresangabe
# (--MMDD). Schaltjahr, damit auch der 29. Februar einen gültigen Anker hat.
_PLACEHOLDER_YEAR = 1604

_ADDRESSBOOK_HOME_BODY = """<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <card:addressbook-home-set/>
  </d:prop>
</d:propfind>"""

_ADDRESSBOOK_DISCOVERY_BODY = """<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"
            xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <cs:getctag/>
  </d:prop>
</d:propfind>"""

_MULTIGET_VCARD_TMPL = """<?xml version="1.0" encoding="utf-8"?>
<card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:getetag/>
    <card:address-data/>
  </d:prop>
  {hrefs}
</card:addressbook-multiget>"""


def _discover_addressbooks(client: Any) -> list[dict] | None:
    """PROPFIND-basierte Discovery, analog zu _discover_calendars in sync.py,
    aber für CardDAV-Adressbücher (addressbook-home-set statt calendar-home-set).
    """
    from urllib.parse import urlparse

    from app.config import settings

    base_url = str(client.url).rstrip("/")
    parsed = urlparse(base_url)
    host_url = f"{parsed.scheme}://{parsed.netloc}"

    ab_home_url: str | None = None
    try:
        principal_url = str(client.principal().url)
        resp = client.session.request(
            "PROPFIND",
            principal_url,
            data=_ADDRESSBOOK_HOME_BODY.encode("utf-8"),
            headers={"Content-Type": "application/xml; charset=UTF-8", "Depth": "0"},
            auth=(settings.caldav_username, settings.caldav_password),
            timeout=30,
        )
        if resp.status_code in (200, 207):
            tree = etree.fromstring(resp.content, _XML_PARSER)
            home_el = tree.find(".//card:addressbook-home-set/d:href", NS)
            if home_el is not None and home_el.text:
                href = home_el.text.strip()
                ab_home_url = host_url + href if href.startswith("/") else href
    except Exception as exc:
        logger.warning("addressbook-home-set nicht verfügbar, nutze Fallback-Pfad: %s", exc)

    if not ab_home_url:
        ab_home_url = f"{base_url}/addressbooks/{settings.caldav_username}/"

    ab_root = ab_home_url.rstrip("/") + "/"

    try:
        resp = client.session.request(
            "PROPFIND",
            ab_root,
            data=_ADDRESSBOOK_DISCOVERY_BODY.encode("utf-8"),
            headers={"Content-Type": "application/xml; charset=UTF-8", "Depth": "1"},
            auth=(settings.caldav_username, settings.caldav_password),
            timeout=30,
        )
        if resp.status_code not in (200, 207):
            logger.error("PROPFIND auf %s fehlgeschlagen: HTTP %d", ab_root, resp.status_code)
            return None
        raw_xml = resp.content
    except Exception as exc:
        logger.error("PROPFIND auf %s fehlgeschlagen: %s", ab_root, exc)
        return None

    tree = etree.fromstring(raw_xml, _XML_PARSER)

    addressbooks = []
    for response in tree.findall("d:response", NS):
        href = response.findtext("d:href", namespaces=NS) or ""

        resourcetype_el = response.find(".//d:resourcetype", NS)
        if resourcetype_el is None:
            continue
        types = {child.tag for child in resourcetype_el}
        if f"{{{NS_CARD}}}addressbook" not in types:
            continue

        displayname = response.findtext(".//d:displayname", namespaces=NS) or ""
        if not displayname:
            displayname = href.rstrip("/").split("/")[-1]

        full_url = host_url + href if href.startswith("/") else href
        addressbooks.append({"url": full_url, "name": displayname})

    logger.info("Discovered %d addressbooks", len(addressbooks))
    return addressbooks


def _multiget_vcards(client: Any, ab_url: str, urls: list[str]) -> dict[str, tuple[str, str]]:
    """CardDAV REPORT addressbook-multiget → {obj_url: (etag, raw_vcard)}."""
    if not urls:
        return {}

    from urllib.parse import urlparse

    host = _host_url(client)
    hrefs_xml = "\n  ".join(f"<d:href>{urlparse(url).path}</d:href>" for url in urls)
    body = _MULTIGET_VCARD_TMPL.format(hrefs=hrefs_xml)

    resp = client.report(url=ab_url, query=body, depth=1)

    result: dict[str, tuple[str, str]] = {}
    try:
        raw_xml = resp.raw if isinstance(resp.raw, bytes) else resp.raw.encode()
        tree = etree.fromstring(raw_xml, _XML_PARSER)
    except Exception as exc:
        logger.error("Could not parse vCard MULTIGET response for %s: %s", ab_url, exc)
        return result

    for response in tree.findall("d:response", NS):
        href = response.findtext("d:href", namespaces=NS) or ""
        full_url = host + href if href.startswith("/") else href

        data_el = response.find(".//card:address-data", NS)
        raw = data_el.text if data_el is not None and data_el.text else ""
        if raw:
            result[full_url] = ("", raw)

    logger.debug("vCard MULTIGET: requested %d, received %d", len(urls), len(result))
    return result


def _unfold_vcard_lines(raw: str) -> list[str]:
    """RFC 6350 nutzt dieselbe Zeilen-Fortsetzungsregel wie iCalendar
    (führendes Leerzeichen/Tab = Fortsetzung der vorherigen Zeile)."""
    normalized = raw.replace("\r\n", "\n").replace("\r", "\n")
    lines: list[str] = []
    for line in normalized.split("\n"):
        if line.startswith((" ", "\t")) and lines:
            lines[-1] += line[1:]
        elif line:
            lines.append(line)
    return lines


def _unescape_vcard_value(value: str) -> str:
    return (
        value.replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\n", " ")
        .replace("\\N", " ")
        .replace("\\\\", "\\")
    )


def _parse_bday(raw: str) -> tuple[int, int, int | None] | None:
    """RFC 6350 BDAY (YYYYMMDD / YYYY-MM-DD) oder RFC 6474 --MMDD/--MM-DD (kein Jahr).

    Gibt (month, day, year) zurück, year=None wenn nicht bekannt.
    """
    value = raw.strip()
    if value.startswith("--"):
        digits = value[2:].replace("-", "")
        if len(digits) != 4 or not digits.isdigit():
            return None
        month, day = int(digits[:2]), int(digits[2:])
        return month, day, None

    digits = value.replace("-", "")
    if len(digits) != 8 or not digits.isdigit():
        return None
    year, month, day = int(digits[:4]), int(digits[4:6]), int(digits[6:8])
    return month, day, year


def _parse_vcard(raw: str) -> dict | None:
    """Extrahiert UID, Anzeigename und Geburtsdatum aus einer einzelnen VCARD."""
    uid: str | None = None
    fn: str | None = None
    n_parts: list[str] | None = None
    bday_raw: str | None = None

    for line in _unfold_vcard_lines(raw):
        if ":" not in line:
            continue
        name_and_params, _, value = line.partition(":")
        prop_name = name_and_params.split(";", 1)[0].upper()
        if "." in prop_name:  # gruppierte Properties, z.B. "item1.FN"
            prop_name = prop_name.rsplit(".", 1)[1]

        if prop_name == "UID":
            uid = value.strip()
        elif prop_name == "FN":
            fn = _unescape_vcard_value(value.strip())
        elif prop_name == "N":
            n_parts = [_unescape_vcard_value(p) for p in value.split(";")]
        elif prop_name == "BDAY":
            bday_raw = value.strip()

    if not uid or not bday_raw:
        return None

    display_name = fn
    if not display_name and n_parts:
        family = n_parts[0] if len(n_parts) > 0 else ""
        given = n_parts[1] if len(n_parts) > 1 else ""
        display_name = " ".join(p for p in (given, family) if p)
    if not display_name:
        display_name = uid

    parsed = _parse_bday(bday_raw)
    if parsed is None:
        return None
    month, day, year = parsed

    return {"uid": uid, "name": display_name, "month": month, "day": day, "year": year}


def _sync_birthdays(db: Session, client: Any) -> None:
    """Synct Geburtstage aus allen CardDAV-Adressbüchern in einen synthetischen,
    read-only Kalender (analog zu _sync_ics_feed in sync.py)."""
    from app.config import settings

    addressbooks = _discover_addressbooks(client)
    if not addressbooks:
        logger.info("Keine Adressbücher gefunden, Geburtstage-Sync übersprungen.")
        return

    db_cal = db.get(Calendar, BIRTHDAYS_CALENDAR_ID)
    if db_cal is None:
        db_cal = Calendar(
            id=BIRTHDAYS_CALENDAR_ID,
            name=BIRTHDAYS_CALENDAR_NAME,
            color=settings.birthdays_calendar_color,
            ctag=None,
            last_synced_at=None,
        )
        db.add(db_cal)
        db.flush()
        logger.info("New calendar: %s", BIRTHDAYS_CALENDAR_NAME)
    else:
        db_cal.name = BIRTHDAYS_CALENDAR_NAME
        db_cal.color = settings.birthdays_calendar_color

    local_events: dict[str, Event] = {
        e.uid: e for e in db.query(Event).filter(Event.calendar_id == BIRTHDAYS_CALENDAR_ID).all()
    }
    seen_uids: set[str] = set()
    upserted = 0

    for ab in addressbooks:
        ab_url = ab["url"]
        try:
            remote_etags = _propfind_etags(client, ab_url)
        except Exception as exc:
            logger.error("PROPFIND fehlgeschlagen für Adressbuch %s: %s", ab_url, exc)
            continue
        if not remote_etags:
            continue

        try:
            fetched = _multiget_vcards(client, ab_url, list(remote_etags.keys()))
        except Exception as exc:
            logger.error("MULTIGET fehlgeschlagen für Adressbuch %s: %s", ab_url, exc)
            continue

        for obj_url, (_etag, raw_vcard) in fetched.items():
            try:
                contact = _parse_vcard(raw_vcard)
                if contact is None:
                    continue

                event_uid = f"birthday:{contact['uid']}"
                year = contact["year"] or _PLACEHOLDER_YEAR
                start_dt = datetime(year, contact["month"], contact["day"])
                summary = f"🎂 {contact['name']}"

                seen_uids.add(event_uid)
                upserted += 1

                existing = local_events.get(event_uid)
                if existing:
                    existing.summary = summary
                    existing.start = start_dt
                    existing.end = start_dt
                    existing.all_day = True
                    existing.rrule = "FREQ=YEARLY"
                    existing.birth_year = contact["year"]
                else:
                    db.add(
                        Event(
                            uid=event_uid,
                            calendar_id=BIRTHDAYS_CALENDAR_ID,
                            etag=None,
                            summary=summary,
                            start=start_dt,
                            end=start_dt,
                            all_day=True,
                            rrule="FREQ=YEARLY",
                            location=None,
                            description=None,
                            raw_ical="",
                            birth_year=contact["year"],
                        )
                    )
            except Exception as exc:
                logger.warning("Konnte vCard %s nicht verarbeiten: %s", obj_url, exc)

    deleted_count = 0
    for uid, event in local_events.items():
        if uid not in seen_uids:
            db.query(EventOverride).filter(EventOverride.master_uid == uid).delete(
                synchronize_session=False
            )
            db.delete(event)
            deleted_count += 1

    db_cal.last_synced_at = datetime.now(timezone.utc)
    db.commit()
    logger.info(
        "Geburtstage-Sync abgeschlossen: %d upserted, %d deleted", upserted, deleted_count
    )
