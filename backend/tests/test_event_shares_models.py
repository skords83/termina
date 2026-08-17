"""Test EventShare and EventShareInstanceState models."""

from __future__ import annotations

from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db.models import Base, Calendar, Event, EventShare, EventShareInstanceState

TEST_DB_URL = "sqlite:///:memory:"


@pytest.fixture()
def db():
    engine = create_engine(TEST_DB_URL, connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()


def _seed_events(db):
    cal = Calendar(id="cal-1", name="Privat", color="#5b8fff")
    db.add(cal)
    src = Event(uid="src-1", calendar_id="cal-1", summary="Zahnarzt", start=datetime(2026, 6, 1, 10, 0), end=datetime(2026, 6, 1, 11, 0), all_day=False)
    shared = Event(uid="shared-1", calendar_id="cal-1", summary="Kinder hüten", start=datetime(2026, 6, 1, 9, 45), end=datetime(2026, 6, 1, 11, 15), all_day=False)
    db.add_all([src, shared])
    db.commit()


def test_event_share_erstellen_und_lesen(db):
    _seed_events(db)
    share = EventShare(
        source_uid="src-1",
        shared_uid="shared-1",
        target_calendar_id="cal-oma-opa",
        snapshot_start=datetime(2026, 6, 1, 10, 0),
        snapshot_end=datetime(2026, 6, 1, 11, 0),
        snapshot_summary="Zahnarzt",
        snapshot_rrule=None,
        buffer_before_minutes=15,
        buffer_after_minutes=15,
        dismissed=False,
        created_at=datetime.utcnow(),
    )
    db.add(share)
    db.commit()
    db.refresh(share)

    fetched = db.query(EventShare).filter(EventShare.source_uid == "src-1").first()
    assert fetched is not None
    assert fetched.shared_uid == "shared-1"
    assert fetched.buffer_before_minutes == 15
    assert fetched.dismissed is False


def test_event_share_instance_state_unique_constraint(db):
    _seed_events(db)
    share = EventShare(
        source_uid="src-1", shared_uid="shared-1", target_calendar_id="cal-oma-opa",
        snapshot_start=datetime(2026, 6, 1, 10, 0), snapshot_end=datetime(2026, 6, 1, 11, 0),
        snapshot_summary="Zahnarzt", snapshot_rrule="FREQ=WEEKLY",
        buffer_before_minutes=0, buffer_after_minutes=0, dismissed=False, created_at=datetime.utcnow(),
    )
    db.add(share)
    db.commit()
    db.refresh(share)

    rid = datetime(2026, 6, 8, 10, 0)
    db.add(EventShareInstanceState(share_id=share.id, source_recurrence_id=rid, snapshot_deleted=False, dismissed=False, updated_at=datetime.utcnow()))
    db.commit()

    db.add(EventShareInstanceState(share_id=share.id, source_recurrence_id=rid, snapshot_deleted=False, dismissed=False, updated_at=datetime.utcnow()))
    with pytest.raises(IntegrityError):
        db.commit()
