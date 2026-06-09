from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Calendar(Base):
    __tablename__ = "calendars"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # CalDAV URL
    name: Mapped[str] = mapped_column(String, nullable=False)
    color: Mapped[str | None] = mapped_column(String, nullable=True)
    ctag: Mapped[str | None] = mapped_column(String, nullable=True)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    events: Mapped[list["Event"]] = relationship(
        "Event", back_populates="calendar", cascade="all, delete-orphan"
    )


class Event(Base):
    __tablename__ = "events"

    uid: Mapped[str] = mapped_column(String, primary_key=True)
    calendar_id: Mapped[str] = mapped_column(
        String, ForeignKey("calendars.id", ondelete="CASCADE"), nullable=False
    )
    etag: Mapped[str | None] = mapped_column(String, nullable=True)
    summary: Mapped[str | None] = mapped_column(String, nullable=True)
    start: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    end: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    all_day: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    rrule: Mapped[str | None] = mapped_column(String, nullable=True)
    location: Mapped[str | None] = mapped_column(String, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    raw_ical: Mapped[str | None] = mapped_column(Text, nullable=True)

    calendar: Mapped["Calendar"] = relationship("Calendar", back_populates="events")
