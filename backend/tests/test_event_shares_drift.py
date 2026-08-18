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
from app.api.event_shares import _instance_has_drift
from app.db.models import Base, Event, EventOverride, Calendar, User, EventShare, EventShareInstanceState
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


# --- Direkte Unit-Tests fuer _instance_has_drift ---

def test_instance_has_drift_unveraenderte_instanz_kein_drift(client, auth):
    db = TestingSessionLocal()
    share_id = _make_share(db, datetime(2026, 6, 19, 9, 0), datetime(2026, 6, 19, 10, 0), "Einkaufen", rrule="FREQ=WEEKLY;BYDAY=FR")
    share = db.query(EventShare).filter(EventShare.id == share_id).first()
    rid = datetime(2026, 6, 26, 9, 0)

    assert _instance_has_drift(db, share, "src-1", rid) is False
    db.close()


def test_instance_has_drift_override_ohne_state_ist_drift(client, auth):
    db = TestingSessionLocal()
    share_id = _make_share(db, datetime(2026, 6, 19, 9, 0), datetime(2026, 6, 19, 10, 0), "Einkaufen", rrule="FREQ=WEEKLY;BYDAY=FR")
    share = db.query(EventShare).filter(EventShare.id == share_id).first()
    rid = datetime(2026, 6, 26, 9, 0)
    db.add(EventOverride(master_uid="src-1", recurrence_id=rid, start=datetime(2026, 6, 26, 14, 0), end=datetime(2026, 6, 26, 15, 0)))
    db.commit()

    assert _instance_has_drift(db, share, "src-1", rid) is True
    db.close()


def test_instance_has_drift_geloeschte_instanz_ohne_state_ist_drift(client, auth):
    db = TestingSessionLocal()
    share_id = _make_share(db, datetime(2026, 6, 19, 9, 0), datetime(2026, 6, 19, 10, 0), "Einkaufen", rrule="FREQ=WEEKLY;BYDAY=FR")
    share = db.query(EventShare).filter(EventShare.id == share_id).first()
    rid = datetime(2026, 6, 26, 9, 0)
    # EXDATE-Sentinel: Override ohne start markiert die Instanz als geloescht.
    db.add(EventOverride(master_uid="src-1", recurrence_id=rid, start=None, end=None))
    db.commit()

    assert _instance_has_drift(db, share, "src-1", rid) is True
    db.close()


def test_instance_has_drift_nach_sync_kein_drift_dann_erneute_aenderung_ist_drift(client, auth):
    db = TestingSessionLocal()
    share_id = _make_share(db, datetime(2026, 6, 19, 9, 0), datetime(2026, 6, 19, 10, 0), "Einkaufen", rrule="FREQ=WEEKLY;BYDAY=FR")
    share = db.query(EventShare).filter(EventShare.id == share_id).first()
    rid = datetime(2026, 6, 26, 9, 0)
    db.add(EventOverride(master_uid="src-1", recurrence_id=rid, start=datetime(2026, 6, 26, 14, 0), end=datetime(2026, 6, 26, 15, 0)))
    db.commit()

    # State-Snapshot passend zu den aktuellen (ueberschriebenen) Werten synchronisieren.
    db.add(EventShareInstanceState(
        share_id=share.id,
        source_recurrence_id=rid,
        snapshot_start=datetime(2026, 6, 26, 14, 0),
        snapshot_end=datetime(2026, 6, 26, 15, 0),
        snapshot_summary=None,
        snapshot_deleted=False,
        dismissed=True,
        updated_at=datetime.utcnow(),
    ))
    db.commit()

    assert _instance_has_drift(db, share, "src-1", rid) is False

    # Quelle aendert sich erneut -> Drift muss wieder erkannt werden.
    override = db.query(EventOverride).filter(
        EventOverride.master_uid == "src-1", EventOverride.recurrence_id == rid
    ).first()
    override.start = datetime(2026, 6, 26, 16, 0)
    override.end = datetime(2026, 6, 26, 17, 0)
    db.commit()

    assert _instance_has_drift(db, share, "src-1", rid) is True
    db.close()


# --- Fix 1: recurrence_id-Parameter fuer list_shares (Instanz-Drift sichtbar) ---


def test_list_shares_mit_recurrence_id_erkennt_instanz_drift(client, auth):
    db = TestingSessionLocal()
    share_id = _make_share(
        db, datetime(2026, 6, 19, 9, 0), datetime(2026, 6, 19, 10, 0), "Einkaufen",
        rrule="FREQ=WEEKLY;BYDAY=FR",
    )
    rid = datetime(2026, 6, 26, 9, 0)
    # Instanz wurde verschoben, aber es existiert noch kein EventShareInstanceState
    # dafuer -> unsynchronisierte Instanz-Drift.
    db.add(EventOverride(
        master_uid="src-1", recurrence_id=rid,
        start=datetime(2026, 6, 26, 14, 0), end=datetime(2026, 6, 26, 15, 0),
    ))
    db.commit()
    db.close()

    r = client.get(
        "/api/event-shares",
        params={"source_uid": "src-1", "recurrence_id": "2026-06-26T09:00:00"},
    )
    assert r.status_code == 200
    assert r.json()[0]["has_drift"] is True

    # Ohne recurrence_id bleibt es beim reinen Serien-Drift-Check (kein Drift,
    # da die Serie selbst unveraendert ist -- nur diese eine Instanz driftet).
    r2 = client.get("/api/event-shares", params={"source_uid": "src-1"})
    assert r2.status_code == 200
    assert r2.json()[0]["has_drift"] is False


# --- Minor: _series_has_drift darf bei None-start/end nicht crashen ---


def test_series_has_drift_none_start_ist_drift():
    from app.api.event_shares import _series_has_drift

    source = Event(uid="x", calendar_id=SRC_CAL, summary="s", start=None, end=None, all_day=False)
    share = EventShare(
        source_uid="x", shared_uid="y", target_calendar_id=OMA_OPA_CAL,
        snapshot_start=datetime(2026, 1, 1, 0, 0), snapshot_end=datetime(2026, 1, 1, 1, 0),
        snapshot_summary="s", snapshot_rrule=None, buffer_before_minutes=0,
        buffer_after_minutes=0, dismissed=False, created_at=datetime.utcnow(),
    )
    assert _series_has_drift(share, source) is True
