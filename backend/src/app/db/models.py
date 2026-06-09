"""SQLAlchemy-Modelle fuer Phase 1.

Calendar  – repraesentiert einen CalDAV-Kalender in Nextcloud.
Event     – ein einzelner Termin (VEVENT), inkl. raw iCal fuer spaetere RRULE-Expansion.
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Calendar(Base):
    __tablename__ = "calendars"

    # CalDAV-URL dient als stabiler PK (z.B. https://nc.example.com/remote.php/dav/calendars/user/personal/)
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    color: Mapped[str | None] = mapped_column(String, nullable=True)  # z.B. "#4A90D9"
    ctag: Mapped[str | None] = mapped_column(String, nullable=True)   # letzter bekannter CTag
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    events: Mapped[list["Event"]] = relationship(
        "Event", back_populates="calendar", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:
        return f"<Calendar id={self.id!r} name={self.name!r}>"


class Event(Base):
    __tablename__ = "events"

    # UID aus dem iCal-Objekt – eindeutig pro Kalender, wird als PK verwendet
    uid: Mapped[str] = mapped_column(String, primary_key=True)
    calendar_id: Mapped[str] = mapped_column(
        String, ForeignKey("calendars.id", ondelete="CASCADE"), nullable=False, index=True
    )
    etag: Mapped[str | None] = mapped_column(String, nullable=True)   # HTTP ETag vom Server
    summary: Mapped[str | None] = mapped_column(String, nullable=True)
    start: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    end: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    all_day: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    rrule: Mapped[str | None] = mapped_column(String, nullable=True)  # RRULE-String, roh
    location: Mapped[str | None] = mapped_column(String, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    raw_ical: Mapped[str | None] = mapped_column(Text, nullable=True) # komplettes VCALENDAR-Objekt

    calendar: Mapped["Calendar"] = relationship("Calendar", back_populates="events")

    def __repr__(self) -> str:
        return f"<Event uid={self.uid!r} summary={self.summary!r}>"
