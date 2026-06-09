"""Nextcloud CalDAV-Verbindung und Kalender-Discovery.

Kapselt die caldav-Lib, damit sync.py keine direkten caldav-Objekte verarbeitet.
"""

import logging
from dataclasses import dataclass

import caldav
from caldav import DAVClient

from app.config import settings

logger = logging.getLogger(__name__)


@dataclass
class CalendarInfo:
    """Rohform eines Kalenders – unabhaengig von DB-Modellen."""
    url: str
    name: str
    color: str | None
    ctag: str | None


def _get_client() -> DAVClient:
    return DAVClient(
        url=settings.caldav_url,
        username=settings.caldav_username,
        password=settings.caldav_password,
    )


def discover_calendars() -> list[CalendarInfo]:
    """Verbindet mit Nextcloud und gibt alle sichtbaren Kalender zurueck."""
    client = _get_client()
    principal = client.principal()
    calendars: list[CalendarInfo] = []

    for cal in principal.calendars():
        # Name aus displayname-Property, Fallback auf URL-Ende
        try:
            name = str(cal.name) if cal.name else cal.url.path.rstrip("/").split("/")[-1]
        except Exception:
            name = str(cal.url)

        # Farbe: Nextcloud haengt sie als apple-ns-Property an
        color: str | None = None
        try:
            props = cal.get_properties([caldav.elements.dav.DisplayName()])
            # apple-Farbe ist nicht in der Standard-caldav-Lib; wir lesen sie per PROPFIND-raw
            color = _fetch_color(cal)
        except Exception:
            pass

        # CTag
        ctag: str | None = None
        try:
            ctag = str(cal.get_ctag())
        except Exception:
            logger.debug("Kein CTag fuer Kalender %s", cal.url)

        calendars.append(CalendarInfo(url=str(cal.url), name=name, color=color, ctag=ctag))
        logger.debug("Kalender gefunden: %s (ctag=%s)", name, ctag)

    return calendars


def _fetch_color(cal: caldav.Calendar) -> str | None:
    """Liest die Apple/Nextcloud-Kalenderfarbe via PROPFIND."""
    try:
        # Nextcloud nutzt {http://apple.com/ns/ical/}calendar-color
        from lxml import etree  # type: ignore
        result = cal.client.propfind(
            cal.url,
            props=b"""<?xml version="1.0"?>
            <d:propfind xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/">
              <d:prop><a:calendar-color/></d:prop>
            </d:propfind>""",
            depth=0,
        )
        tree = etree.fromstring(result.raw)
        ns = "http://apple.com/ns/ical/"
        color_el = tree.find(f".//{{{ns}}}calendar-color")
        if color_el is not None and color_el.text:
            # Nextcloud liefert manchmal "#RRGGBBAA" – wir kuerzen auf #RRGGBB
            raw = color_el.text.strip()
            return raw[:7] if len(raw) >= 7 else raw
    except Exception:
        pass
    return None


def get_event_etags(cal_url: str) -> dict[str, str]:
    """Gibt {event_url: etag} fuer alle Events im Kalender zurueck (via REPORT)."""
    client = _get_client()
    cal = client.calendar(url=cal_url)

    etags: dict[str, str] = {}
    try:
        for obj in cal.objects_by_url(cal.url):
            # caldav liefert hier keine ETags direkt – wir nutzen search mit load_objects=False
            pass
    except Exception:
        pass

    # Zuverlaessigerer Weg: REPORT mit calendar-multiget
    try:
        objects = cal.search(todo=False, event=True, load_objects=False)
        for obj in objects:
            url = str(obj.url)
            etag = obj.etag.strip('"') if obj.etag else None
            if etag:
                etags[url] = etag
    except Exception as exc:
        logger.warning("REPORT fuer %s fehlgeschlagen: %s", cal_url, exc)

    return etags


def fetch_event_ical(event_url: str) -> str | None:
    """Laed das vollstaendige iCal-Objekt eines einzelnen Events."""
    client = _get_client()
    try:
        obj = client.object_by_url(event_url)
        obj.load()
        return obj.data
    except Exception as exc:
        logger.warning("Event laden fehlgeschlagen (%s): %s", event_url, exc)
        return None