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

TEST_USER_EMAIL = "admin@test.local"
TEST_USER_PASSWORD = "testpassword123"

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
    db = TestingSessionLocal()
    db.add_all([
        Calendar(id=SRC_CAL, name="Privat", color="#5b8fff"),
        Calendar(id=OMA_OPA_CAL, name="Oma & Opa", color="#f2a65a"),
    ])
    db.add(Event(
        uid="src-uid-1", calendar_id=SRC_CAL, etag='"etag-1"', summary="Zahnarzttermin",
        start=datetime(2026, 6, 15, 10, 0, tzinfo=timezone.utc),
        end=datetime(2026, 6, 15, 11, 0, tzinfo=timezone.utc),
        all_day=False,
    ))
    db.add(Event(
        uid="src-serie-1", calendar_id=SRC_CAL, etag='"etag-2"', summary="Einkaufen freitags",
        start=datetime(2026, 6, 19, 9, 0, tzinfo=timezone.utc),
        end=datetime(2026, 6, 19, 10, 0, tzinfo=timezone.utc),
        all_day=False, rrule="FREQ=WEEKLY;BYDAY=FR",
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
    db.add(User(
        email=TEST_USER_EMAIL, display_name="Test Admin",
        password_hash=hash_password(TEST_USER_PASSWORD), role="admin",
        must_change_password=False, created_at=datetime.utcnow(),
    ))
    db.commit()
    db.close()
    r = client.post("/api/auth/login", json={"email": TEST_USER_EMAIL, "password": TEST_USER_PASSWORD})
    assert r.status_code == 200
    return {}


def test_share_einzeltermin_erstellt_kopie_und_datensatz(client, auth):
    with patch("app.api.event_shares.create_event", return_value="shared-uid-1") as mock_create:
        r = client.post("/api/event-shares", json={
            "source_uid": "src-uid-1",
            "summary": "Kinder hüten",
            "start": "2026-06-15T09:45:00",
            "end": "2026-06-15T11:15:00",
            "buffer_before_minutes": 15,
            "buffer_after_minutes": 15,
        })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["shared_uid"] == "shared-uid-1"
    assert body["target_calendar_id"] == OMA_OPA_CAL
    assert body["has_drift"] is False

    mock_create.assert_called_once()
    _, kwargs = mock_create.call_args
    assert kwargs["calendar_id"] == OMA_OPA_CAL
    assert kwargs["summary"] == "Kinder hüten"
    assert kwargs["rrule"] is None

    db = TestingSessionLocal()
    row = db.query(EventShare).filter(EventShare.source_uid == "src-uid-1").first()
    assert row is not None
    assert row.buffer_before_minutes == 15
    db.close()


def test_share_serie_kopiert_rrule(client, auth):
    with patch("app.api.event_shares.create_event", return_value="shared-serie-1") as mock_create:
        r = client.post("/api/event-shares", json={
            "source_uid": "src-serie-1",
            "summary": "Einkaufen freitags",
            "start": "2026-06-19T09:00:00",
            "end": "2026-06-19T10:00:00",
        })
    assert r.status_code == 201, r.text
    _, kwargs = mock_create.call_args
    assert kwargs["rrule"] == "FREQ=WEEKLY;BYDAY=FR"


def test_share_ohne_konfigurierten_zielkalender_400(client, auth, monkeypatch):
    monkeypatch.setattr(settings, "oma_opa_calendar_id", None)
    r = client.post("/api/event-shares", json={
        "source_uid": "src-uid-1", "summary": "X",
        "start": "2026-06-15T09:45:00", "end": "2026-06-15T11:15:00",
    })
    assert r.status_code == 400


def test_share_serie_mit_bestehendem_override_kein_sofortiger_drift(client, auth):
    """Serie mit bereits vorhandenem Override wird geteilt -> die betroffene Instanz
    darf nicht sofort als gedriftet gelten (Fix 2: State wird beim Anlegen geseedet)."""
    db = TestingSessionLocal()
    rid = datetime(2026, 6, 26, 9, 0)
    db.add(EventOverride(
        master_uid="src-serie-1", recurrence_id=rid,
        start=datetime(2026, 6, 26, 14, 0), end=datetime(2026, 6, 26, 15, 0),
    ))
    db.commit()
    db.close()

    with patch("app.api.event_shares.create_event", return_value="shared-serie-1"):
        r = client.post("/api/event-shares", json={
            "source_uid": "src-serie-1",
            "summary": "Einkaufen freitags",
            "start": "2026-06-19T09:00:00",
            "end": "2026-06-19T10:00:00",
        })
    assert r.status_code == 201, r.text

    r2 = client.get(
        "/api/event-shares",
        params={"source_uid": "src-serie-1", "recurrence_id": "2026-06-26T09:00:00"},
    )
    assert r2.status_code == 200
    assert r2.json()[0]["has_drift"] is False


def test_share_unbekannter_source_404(client, auth):
    r = client.post("/api/event-shares", json={
        "source_uid": "does-not-exist", "summary": "X",
        "start": "2026-06-15T09:45:00", "end": "2026-06-15T11:15:00",
    })
    assert r.status_code == 404


def test_share_ohne_auth_401(client):
    r = client.post("/api/event-shares", json={
        "source_uid": "src-uid-1", "summary": "X",
        "start": "2026-06-15T09:45:00", "end": "2026-06-15T11:15:00",
    })
    assert r.status_code == 401
