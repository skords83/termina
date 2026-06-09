"""SQLAlchemy-Modelle.

Wird in Phase 1 implementiert. Grobe Skizze:

    class Calendar(Base):
        id: str (CalDAV-URL als PK)
        name: str
        color: str
        ctag: str | None       # zuletzt gesehener Sammlungs-Tag (Aenderungsdetektion)
        last_synced_at: datetime

    class Event(Base):
        uid: str (PK, CalDAV-UID)
        calendar_id: str (FK -> Calendar.id)
        etag: str              # Aenderungserkennung auf Event-Ebene
        summary: str
        start: datetime
        end: datetime
        all_day: bool
        rrule: str | None
        location: str | None
        description: str | None
        raw_ical: str          # vollstaendige iCal-Daten zur Sicherheit
"""
