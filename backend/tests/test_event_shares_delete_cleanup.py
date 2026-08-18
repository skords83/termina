# backend/tests/test_event_shares_delete_cleanup.py
from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import sessionmaker

from app.main import app
from app.auth.security import hash_password
from app.db.models import Base, Event, Calendar, User, EventShare
from app.db.session import get_db

TEST_DB_URL = "sqlite:///:memory:"
engine = create_engine(TEST_DB_URL, connect_args={"check_same_thread": False}, poolclass=StaticPool)
TestingSessionLocal = sessionmaker(bind=engine)

CAL = "https://nc.example.com/dav/personal/"
OMA_OPA_CAL = "https://nc.example.com/dav/oma-opa/"


def override_get_db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(autouse=True)
def setup_db():
    Base.metadata.create_all(bind=engine)
    db = TestingSessionLocal()
    db.add_all([
        Calendar(id=CAL, name="Privat", color="#5b8fff"),
        Calendar(id=OMA_OPA_CAL, name="Oma & Opa", color="#f2a65a"),
    ])
    db.add(Event(uid="src-1", calendar_id=CAL, etag='"e1"', summary="Zahnarzt",
                 start=datetime(2026, 6, 15, 10, 0), end=datetime(2026, 6, 15, 11, 0), all_day=False))
    db.add(Event(uid="shared-1", calendar_id=OMA_OPA_CAL, etag='"e2"', summary="Kinder hüten",
                 start=datetime(2026, 6, 15, 10, 0), end=datetime(2026, 6, 15, 11, 0), all_day=False))
    db.add(EventShare(
        source_uid="src-1", shared_uid="shared-1", target_calendar_id=OMA_OPA_CAL,
        snapshot_start=datetime(2026, 6, 15, 10, 0), snapshot_end=datetime(2026, 6, 15, 11, 0),
        snapshot_summary="Zahnarzt", snapshot_rrule=None,
        buffer_before_minutes=0, buffer_after_minutes=0, dismissed=False, created_at=datetime.utcnow(),
    ))
    db.commit()
    db.close()
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setitem(app.dependency_overrides, get_db, override_get_db)
    monkeypatch.setattr("app.caldav.sync.run_sync", lambda: None)
    monkeypatch.setattr("app.scheduler.run_sync", lambda: None)
    return TestClient(app)


@pytest.fixture()
def auth(client):
    db = TestingSessionLocal()
    db.add(User(email="a@test.local", display_name="Admin", password_hash=hash_password("testpassword123"),
                role="admin", must_change_password=False, created_at=datetime.utcnow()))
    db.commit()
    db.close()
    r = client.post("/api/auth/login", json={"email": "a@test.local", "password": "testpassword123"})
    assert r.status_code == 200
    return {}


def test_loeschen_des_quelltermins_raeumt_event_share_auf(client, auth):
    with patch("app.api.events.delete_event"):
        r = client.delete("/api/events/src-1", params={"etag": '"e1"'})
    assert r.status_code == 204

    db = TestingSessionLocal()
    assert db.query(EventShare).filter(EventShare.source_uid == "src-1").first() is None
    # Die Kopie selbst bleibt unangetastet
    assert db.query(Event).filter(Event.uid == "shared-1").first() is not None
    db.close()


def test_loeschen_der_kopie_raeumt_event_share_auf(client, auth):
    with patch("app.api.events.delete_event"):
        r = client.delete("/api/events/shared-1", params={"etag": '"e2"'})
    assert r.status_code == 204

    db = TestingSessionLocal()
    assert db.query(EventShare).filter(EventShare.shared_uid == "shared-1").first() is None
    assert db.query(Event).filter(Event.uid == "src-1").first() is not None
    db.close()
