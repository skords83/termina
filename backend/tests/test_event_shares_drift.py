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
from app.db.models import Base, Event, EventOverride, Calendar, User, EventShare
from app.db.session import get_db
from app.config import settings

TEST_DB_URL = "sqlite:///:memory:"
engine = create_engine(TEST_DB_URL, connect_args={"check_same_thread": False}, poolclass=StaticPool)
TestingSessionLocal = sessionmaker(bind=engine)

SRC_CAL = "https://nc.example.com/dav/personal/"
OMA_OPA_CAL = "https://nc.example.com/dav/oma-opa/"


def override_get_db():
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(autouse=True)
def setup_db(monkeypatch):
    Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(settings, "oma_opa_calendar_id", OMA_OPA_CAL)
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


def _make_share(db, source_start, source_end, source_summary, rrule=None):
    db.add_all([
        Calendar(id=SRC_CAL, name="Privat", color="#5b8fff"),
        Calendar(id=OMA_OPA_CAL, name="Oma & Opa", color="#f2a65a"),
    ])
    db.add(Event(uid="src-1", calendar_id=SRC_CAL, summary=source_summary, start=source_start, end=source_end, all_day=False, rrule=rrule))
    db.add(Event(uid="shared-1", calendar_id=OMA_OPA_CAL, summary="Kinder hüten", start=source_start, end=source_end, all_day=False, rrule=rrule))
    share = EventShare(
        source_uid="src-1", shared_uid="shared-1", target_calendar_id=OMA_OPA_CAL,
        snapshot_start=source_start, snapshot_end=source_end, snapshot_summary=source_summary,
        snapshot_rrule=rrule, buffer_before_minutes=0, buffer_after_minutes=0,
        dismissed=False, created_at=datetime.utcnow(),
    )
    db.add(share)
    db.commit()
    db.refresh(share)
    return share.id


def test_list_shares_ohne_drift(client, auth):
    db = TestingSessionLocal()
    _make_share(db, datetime(2026, 6, 15, 10, 0), datetime(2026, 6, 15, 11, 0), "Zahnarzt")
    db.close()

    r = client.get("/api/event-shares", params={"source_uid": "src-1"})
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    assert body[0]["has_drift"] is False


def test_list_shares_erkennt_serien_drift(client, auth):
    db = TestingSessionLocal()
    _make_share(db, datetime(2026, 6, 15, 10, 0), datetime(2026, 6, 15, 11, 0), "Zahnarzt")
    # Original verschiebt sich
    ev = db.query(Event).filter(Event.uid == "src-1").first()
    ev.start = datetime(2026, 6, 15, 12, 0)
    ev.end = datetime(2026, 6, 15, 13, 0)
    db.commit()
    db.close()

    r = client.get("/api/event-shares", params={"source_uid": "src-1"})
    assert r.json()[0]["has_drift"] is True


def test_sync_snapshot_loescht_drift(client, auth):
    db = TestingSessionLocal()
    share_id = _make_share(db, datetime(2026, 6, 15, 10, 0), datetime(2026, 6, 15, 11, 0), "Zahnarzt")
    ev = db.query(Event).filter(Event.uid == "src-1").first()
    ev.start = datetime(2026, 6, 15, 12, 0)
    ev.end = datetime(2026, 6, 15, 13, 0)
    db.commit()
    db.close()

    r = client.post(f"/api/event-shares/{share_id}/sync-snapshot")
    assert r.status_code == 200
    assert r.json()["has_drift"] is False

    r2 = client.get("/api/event-shares", params={"source_uid": "src-1"})
    assert r2.json()[0]["has_drift"] is False


def test_instance_drift_durch_override_erkannt(client, auth):
    db = TestingSessionLocal()
    share_id = _make_share(db, datetime(2026, 6, 19, 9, 0), datetime(2026, 6, 19, 10, 0), "Einkaufen", rrule="FREQ=WEEKLY;BYDAY=FR")
    rid = datetime(2026, 6, 26, 9, 0)
    db.add(EventOverride(master_uid="src-1", recurrence_id=rid, start=datetime(2026, 6, 26, 14, 0), end=datetime(2026, 6, 26, 15, 0)))
    db.commit()
    db.close()

    r = client.post(f"/api/event-shares/{share_id}/instances/sync-snapshot", json={"source_recurrence_id": "2026-06-19T09:00:00"})
    assert r.status_code == 200
    # Instanz ohne Override -> nach Sync kein Drift
    assert r.json()["dismissed"] is True


def test_sync_instance_snapshot_unbekannte_freigabe_404(client, auth):
    r = client.post("/api/event-shares/9999/instances/sync-snapshot", json={"source_recurrence_id": "2026-06-19T09:00:00"})
    assert r.status_code == 404
