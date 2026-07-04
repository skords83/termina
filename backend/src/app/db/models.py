from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
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
    __table_args__ = (
        Index("ix_events_calendar_start_end", "calendar_id", "start", "end"),
        Index("ix_events_start", "start"),
    )

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
    overrides: Mapped[list["EventOverride"]] = relationship(
        "EventOverride",
        back_populates="master",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class EventOverride(Base):
    """
    RECURRENCE-ID-Override für rekurrente Events.

    Wenn der User eine einzelne Instanz einer Serie verschiebt, entsteht ein
    Override mit der ursprünglichen Instanz-Startzeit (recurrence_id) und den
    neuen Daten (start/end + optional überschriebene Felder).
    """
    __tablename__ = "event_overrides"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    master_uid: Mapped[str] = mapped_column(
        String,
        ForeignKey("events.uid", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Ursprüngliche Instanz-Startzeit (was die RRULE-Expansion erzeugen würde)
    recurrence_id: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    # Neue Werte für diese Instanz
    start: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    end: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    summary: Mapped[str | None] = mapped_column(String, nullable=True)
    location: Mapped[str | None] = mapped_column(String, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    master: Mapped["Event"] = relationship("Event", back_populates="overrides")

    __table_args__ = (
        UniqueConstraint("master_uid", "recurrence_id", name="uq_event_override"),
    )


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    password_hash: Mapped[str] = mapped_column(String, nullable=False)
    role: Mapped[str] = mapped_column(String, nullable=False, default="member")  # admin|member|child
    must_change_password: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    failed_login_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    calendar_access: Mapped[list["UserCalendarAccess"]] = relationship(
        "UserCalendarAccess", back_populates="user", cascade="all, delete-orphan"
    )
    sessions: Mapped[list["UserSession"]] = relationship(
        "UserSession", back_populates="user", cascade="all, delete-orphan"
    )


class UserSession(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # sha256-Hash des Session-Tokens
    user_id: Mapped[int] = mapped_column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    remember_me: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    user: Mapped["User"] = relationship("User", back_populates="sessions")


class UserCalendarAccess(Base):
    __tablename__ = "user_calendar_access"

    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    calendar_id: Mapped[str] = mapped_column(
        String, ForeignKey("calendars.id", ondelete="CASCADE"), primary_key=True
    )

    user: Mapped["User"] = relationship("User", back_populates="calendar_access")