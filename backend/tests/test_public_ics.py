"""
Oeffentlicher ICS-Export fuer "Mit Oma + Opa teilen" - Tests.

Unauthentifizierter, token-geschuetzter Read-Only-Endpoint. Kein Login,
keine Cookies - die einzige Absicherung ist das Secret-Token in der URL.
"""
import os
from datetime import datetime

os.environ.setdefault("CALDAV_URL", "http://localhost")
os.environ.setdefault("CALDAV_USERNAME", "test")
os.environ.setdefault("CALDAV_PASSWORD", "test")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")

import pytest
from fastapi.testclient import TestClient
from icalendar import Calendar as ICalendar
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.db.models import Base, Calendar, Event
from app.db.session import get_db
from app.main import app

engine = create_engine(
    "sqlite:///:memory:",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
TestingSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(bind=engine)


def override_get_db():
    db = TestingSession()
    try:
        yield db
    finally:
        db.close()


import app.db.session as _db_session

OMA_OPA_CAL = "https://baikal.test/cal/oma-opa"
OTHER_CAL = "https://baikal.test/cal/private"
TOKEN = "correct-horse-battery-staple"


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setitem(app.dependency_overrides, get_db, override_get_db)
    monkeypatch.setattr(_db_session, "engine", engine)
    monkeypatch.setattr(_db_session, "SessionLocal", TestingSession)
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def seed_db():
    db = TestingSession()
    db.add(Calendar(id=OMA_OPA_CAL, name="Oma + Opa", color="#f2a65a"))
    db.add(Calendar(id=OTHER_CAL, name="Privat", color="#3b82f6"))
    db.add(Event(
        uid="shared-1",
        calendar_id=OMA_OPA_CAL,
        summary="Kindergeburtstag",
        start=datetime(2026, 9, 1, 14, 0),
        end=datetime(2026, 9, 1, 17, 0),
        all_day=False,
    ))
    db.add(Event(
        uid="private-1",
        calendar_id=OTHER_CAL,
        summary="Geheimnis",
        start=datetime(2026, 9, 2, 10, 0),
        end=datetime(2026, 9, 2, 11, 0),
        all_day=False,
    ))
    db.commit()
    db.close()
    yield
    db = TestingSession()
    db.query(Event).delete()
    db.query(Calendar).delete()
    db.commit()
    db.close()


def test_404_when_no_token_configured(client, monkeypatch):
    monkeypatch.setattr(settings, "oma_opa_calendar_id", OMA_OPA_CAL)
    monkeypatch.setattr(settings, "oma_opa_export_token", None)

    resp = client.get(f"/public/oma-opa/{TOKEN}.ics")

    assert resp.status_code == 404


def test_404_when_no_calendar_configured(client, monkeypatch):
    monkeypatch.setattr(settings, "oma_opa_calendar_id", None)
    monkeypatch.setattr(settings, "oma_opa_export_token", TOKEN)

    resp = client.get(f"/public/oma-opa/{TOKEN}.ics")

    assert resp.status_code == 404


def test_404_when_wrong_token(client, monkeypatch):
    monkeypatch.setattr(settings, "oma_opa_calendar_id", OMA_OPA_CAL)
    monkeypatch.setattr(settings, "oma_opa_export_token", TOKEN)

    resp = client.get("/public/oma-opa/wrong-token.ics")

    assert resp.status_code == 404


def test_200_with_correct_token_returns_only_shared_calendar(client, monkeypatch):
    monkeypatch.setattr(settings, "oma_opa_calendar_id", OMA_OPA_CAL)
    monkeypatch.setattr(settings, "oma_opa_export_token", TOKEN)

    resp = client.get(f"/public/oma-opa/{TOKEN}.ics")

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/calendar")

    cal = ICalendar.from_ical(resp.content)
    uids = {str(c.get("UID")) for c in cal.walk("VEVENT")}
    assert uids == {"shared-1"}


def test_no_login_cookie_required(client, monkeypatch):
    """Der Endpoint darf keine Session/Auth voraussetzen - er ist fuer Kalender-Apps
    ohne Login gedacht (Apple Kalender 'Abonnieren')."""
    monkeypatch.setattr(settings, "oma_opa_calendar_id", OMA_OPA_CAL)
    monkeypatch.setattr(settings, "oma_opa_export_token", TOKEN)

    client.cookies.clear()
    resp = client.get(f"/public/oma-opa/{TOKEN}.ics")

    assert resp.status_code == 200
