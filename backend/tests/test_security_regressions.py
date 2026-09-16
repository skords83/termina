from datetime import datetime
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import service
from app.auth.security import hash_password
from app.config import settings
from app.db.models import Base, Calendar, Event, User
from app.db.session import get_db
from app.main import app


@pytest.fixture
def secured_api(monkeypatch):
    engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    sessions = sessionmaker(bind=engine)
    with sessions() as db:
        db.add(User(id=1, email='admin@test', display_name='Admin', role='admin',
                    password_hash=hash_password('initial-password'), must_change_password=False,
                    created_at=datetime.utcnow()))
        db.add(Calendar(id='cal', name='Private'))
        db.commit()
    def override_db():
        with sessions() as db:
            yield db
    monkeypatch.setitem(app.dependency_overrides, get_db, override_db)
    monkeypatch.setattr(settings, 'cookie_secure', False)
    monkeypatch.setattr('app.api.events.run_sync', lambda: None)
    monkeypatch.setattr('app.api.ics_api.run_sync', lambda: None)
    client = TestClient(app)
    yield client, sessions
    client.close()
    engine.dispose()


def login(client, password='initial-password'):
    response = client.post('/api/auth/login', json={'email': 'admin@test', 'password': password})
    assert response.status_code == 200
    return client.cookies.get(settings.session_cookie_name)


def test_reset_revokes_all_sessions_and_old_cookie_cannot_change_password(secured_api):
    client, sessions = secured_api
    old = login(client)
    with sessions() as db:
        password = service.reset_password(db, db.get(User, 1))
    assert client.get('/api/auth/me').status_code == 401
    assert client.post('/api/auth/change-password', json={'new_password': 'attacker-password'}).status_code == 401
    login(client, password)
    assert client.get('/api/auth/me').json()['must_change_password']
    assert client.get('/api/calendars').status_code == 403
    assert client.get('/api/admin/users').status_code == 403
    assert client.post('/api/sync').status_code == 403
    result = client.post('/api/auth/change-password', json={'new_password': 'replacement-password'})
    assert result.status_code == 200
    assert client.cookies.get(settings.session_cookie_name) != old
    assert client.get('/api/calendars').status_code == 200


def test_password_change_rotates_current_session_and_revokes_others(secured_api):
    client, _ = secured_api
    old = login(client)
    second = login(client)
    response = client.post('/api/auth/change-password', json={
        'current_password': 'initial-password', 'new_password': 'replacement-password'})
    assert response.status_code == 200
    assert client.cookies.get(settings.session_cookie_name) not in (old, second)
    assert client.get('/api/me').headers['cache-control'] == 'no-store'
    assert client.get('/api/calendars').status_code == 200
    for token in (old, second):
        client.cookies.clear()
        client.cookies.set(settings.session_cookie_name, token)
        assert client.get('/api/auth/me').status_code == 401


@pytest.mark.parametrize('password', ['', 'short', 'x' * 1025])
def test_invalid_new_password_rejected(secured_api, password):
    client, _ = secured_api
    login(client)
    assert client.post('/api/auth/change-password', json={
        'current_password': 'initial-password', 'new_password': password}).status_code == 422
    assert client.get('/api/calendars').status_code == 200


def test_api_writes_resolve_internal_id_to_remote_uid(secured_api, monkeypatch):
    client, sessions = secured_api
    login(client)
    with sessions() as db:
        db.add(Event(uid='internal-id', remote_uid='remote-id', calendar_id='cal',
                     summary='Private', start=datetime(2026, 9, 16, 9), end=datetime(2026, 9, 16, 10)))
        db.commit()
    update = Mock()
    monkeypatch.setattr('app.api.events.update_event', update)
    result = client.put('/api/events/internal-id', json={
        'summary': 'Updated', 'start': '2026-09-16T09:00:00', 'end': '2026-09-16T10:00:00'})
    assert result.status_code == 200
    assert result.json()['uid'] == 'internal-id'
    assert update.call_args.kwargs['uid'] == 'remote-id'
    delete = Mock()
    monkeypatch.setattr('app.api.events.delete_event', delete)
    assert client.delete('/api/events/internal-id').status_code == 204
    assert delete.call_args.kwargs['uid'] == 'remote-id'


@pytest.mark.parametrize('endpoint', ['preview', ''])
def test_oversized_import_rejected_before_writes(secured_api, monkeypatch, endpoint):
    client, _ = secured_api
    login(client)
    write = Mock()
    monkeypatch.setattr('app.api.ics_api.import_ical_object', write)
    path = '/api/ics/import' + ('/' + endpoint if endpoint else '')
    response = client.post(path, data={'calendar_id': 'cal'}, files={'file': ('large.ics', b'x' * (1024 * 1024 + 1))})
    assert response.status_code == 413
    write.assert_not_called()


def test_too_many_import_components_rejected_before_writes(secured_api, monkeypatch):
    client, _ = secured_api
    login(client)
    write = Mock()
    monkeypatch.setattr('app.api.ics_api.import_ical_object', write)
    data = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n' + ''.join(
        f'BEGIN:VEVENT\r\nUID:{i}\r\nDTSTART:20260916T090000\r\nEND:VEVENT\r\n' for i in range(501)
    ) + 'END:VCALENDAR\r\n'
    response = client.post('/api/ics/import', data={'calendar_id': 'cal'}, files={'file': ('many.ics', data)})
    assert response.status_code == 400
    write.assert_not_called()


@pytest.mark.asyncio
async def test_slow_import_does_not_block_other_requests(secured_api, monkeypatch):
    import asyncio
    import threading
    import httpx
    client, _ = secured_api
    token = login(client)
    entered = threading.Event()
    release = threading.Event()
    def slow_write(*args):
        entered.set()
        release.wait(3)
    monkeypatch.setattr('app.api.ics_api.import_ical_object', slow_write)
    data = b'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:slow\r\nDTSTART:20260916T090000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test',
                                cookies={settings.session_cookie_name: token}) as async_client:
        task = asyncio.create_task(async_client.post('/api/ics/import', data={'calendar_id': 'cal'}, files={'file': ('slow.ics', data)}))
        try:
            assert await asyncio.to_thread(entered.wait, 2)
            assert not release.is_set()
            assert not task.done()
            health = await asyncio.wait_for(async_client.get('/healthz'), timeout=1)
            assert health.status_code == 200
            assert not task.done()
        finally:
            release.set()
            response = await task
        assert response.status_code == 200
        assert response.json()['imported'] == 1
