from datetime import datetime, timedelta
from unittest.mock import Mock

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session
from icalendar import Calendar as ICalendar

from app import scheduler
from app.api.events import expand_rrule_event
from app.caldav import sync
from app.db import session as db_session
from app.db.models import Base, Calendar, Event, EventOverride, EventShare
from app.ics import build_export_calendar, parse_ics_preview


@pytest.fixture
def db():
    engine = create_engine('sqlite://')
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        session.add_all([Calendar(id='one', name='One', ctag='old'), Calendar(id='two', name='Two')])
        session.commit()
        yield session
    engine.dispose()


def raw(uid='same', end='DURATION:PT1H', extra=''):
    return f'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:{uid}\r\nDTSTART:20260901T090000\r\n{end}\r\nSUMMARY:Review\r\n{extra}END:VEVENT\r\nEND:VCALENDAR\r\n'


def upsert(db, cal='one', data=None, etag='v1'):
    seen = set()
    assert sync._upsert_event(db, cal, etag, data or raw(), cal + '/event.ics', {}, seen)
    db.commit()
    return db.get(Event, next(iter(seen)))


def test_duration_is_preserved_in_sync_and_preview(db):
    event = upsert(db)
    assert event.end - event.start == timedelta(hours=1)
    preview = parse_ics_preview(raw().encode())[0]
    assert preview['end'] - preview['start'] == timedelta(hours=1)


def test_same_remote_uid_in_two_calendars_has_independent_stable_identity(db):
    first = upsert(db)
    second = upsert(db, 'two')
    assert first.uid != second.uid
    assert first.remote_uid == second.remote_uid == 'same'
    again = upsert(db, 'two', data=raw().replace('Review', 'Changed'), etag='v2')
    assert again.uid == second.uid
    assert first.summary == 'Review'
    assert again.summary == 'Changed'
    assert db.query(Event).count() == 2
    single = ICalendar.from_ical(build_export_calendar([second], {})).walk('VEVENT')
    assert str(single[0]['UID']) == 'same'
    combined = ICalendar.from_ical(build_export_calendar([first, second], {})).walk('VEVENT')
    assert len({str(event['UID']) for event in combined}) == 2


def test_duplicate_uid_overrides_attach_to_correct_calendar(db):
    upsert(db)
    data = raw(extra='RRULE:FREQ=WEEKLY\r\n').replace('END:VCALENDAR',
        'BEGIN:VEVENT\r\nUID:same\r\nRECURRENCE-ID:20260908T090000\r\n'
        'DTSTART:20260909T110000\r\nDURATION:PT2H\r\nEND:VEVENT\r\nEND:VCALENDAR')
    second = upsert(db, 'two', data)
    override = db.query(EventOverride).one()
    assert override.master_uid == second.uid
    assert override.end - override.start == timedelta(hours=2)


@pytest.mark.parametrize('fetched', [{}, {'one/event.ics': ('new', 'invalid calendar')}])
def test_partial_or_invalid_multiget_never_deletes_local_data_or_advances_ctag(db, monkeypatch, fetched):
    event = upsert(db)
    db.add(Event(uid='shared', calendar_id='two', start=event.start, end=event.end))
    db.add(EventShare(source_uid=event.uid, shared_uid='shared', target_calendar_id='two',
                      snapshot_start=event.start, snapshot_end=event.end, snapshot_summary='Review', created_at=datetime.now()))
    db.commit()
    monkeypatch.setattr(sync, '_propfind_etags', lambda *args: {'one/event.ics': 'new'})
    monkeypatch.setattr(sync, '_multiget_ical', lambda *args: fetched)
    sync._sync_calendar(db, None, {'url': 'one', 'name': 'One', 'color': None, 'ctag': 'new'})
    assert db.get(Event, event.uid) is not None
    assert db.query(EventShare).count() == 1
    assert db.get(Calendar, 'one').ctag == 'old'


def test_complete_empty_listing_still_removes_deleted_event(db, monkeypatch):
    event = upsert(db)
    uid = event.uid
    monkeypatch.setattr(sync, '_propfind_etags', lambda *args: {})
    sync._sync_calendar(db, None, {'url': 'one', 'name': 'One', 'color': None, 'ctag': 'new'})
    assert db.get(Event, uid) is None
    assert db.get(Calendar, 'one').ctag == 'new'


@pytest.mark.parametrize('xml', [b'<broken', b'<html/>'])
def test_invalid_propfind_is_not_empty_success(xml):
    client = Mock(url='https://example.invalid/cal')
    client.propfind.return_value.raw = xml
    with pytest.raises(ValueError):
        sync._propfind_etags(client, 'https://example.invalid/cal')


def test_scheduler_has_next_periodic_run(monkeypatch, db):
    monkeypatch.setattr("app.db.session.SessionLocal", lambda: db)
    from apscheduler.schedulers.background import BackgroundScheduler
    monkeypatch.setattr(scheduler, '_scheduler', BackgroundScheduler())
    monkeypatch.setattr(scheduler, 'run_sync', lambda: None)
    try:
        scheduler.start_scheduler()
        assert scheduler._scheduler.get_job('caldav_sync').next_run_time is not None
    finally:
        scheduler.stop_scheduler()


@pytest.mark.parametrize('original', [datetime(2026, 9, 1, 9), datetime(2026, 10, 1, 9)])
def test_override_is_visible_in_actual_window_even_outside_original_window(original):
    event = Event(uid='series', calendar_id='one', summary='Series', start=original,
                  end=original + timedelta(hours=1), rrule='FREQ=WEEKLY', all_day=False)
    override = EventOverride(master_uid='series', recurrence_id=original,
                             start=datetime(2026, 9, 16, 9), end=datetime(2026, 9, 16, 10))
    result = expand_rrule_event(event, datetime(2026, 9, 16), datetime(2026, 9, 17), {original.isoformat(): override})
    assert len(result) == 1
    assert result[0]['recurrence_id'] == original.isoformat()
    assert result[0]['start'].startswith('2026-09-16T09:00')


def test_long_recurring_event_overlapping_window_is_visible():
    event = Event(uid='long', calendar_id='one', summary='Trip', start=datetime(2026, 9, 1),
                  end=datetime(2026, 9, 6), rrule='FREQ=MONTHLY', all_day=True)
    assert len(expand_rrule_event(event, datetime(2026, 9, 4), datetime(2026, 9, 5))) == 1


def test_identity_migration_preserves_existing_rows_and_is_idempotent(db, monkeypatch):
    event = upsert(db)
    uid = event.uid
    with db.bind.begin() as connection:
        connection.execute(text('ALTER TABLE events DROP COLUMN remote_uid'))
    monkeypatch.setattr(db_session, 'engine', db.bind)
    db_session.apply_migrations()
    db.expire_all()
    assert db.get(Event, uid).summary == 'Review'
    assert db.get(Event, uid).etag is None
    assert db.get(Calendar, 'one').ctag is None
    db.get(Calendar, 'one').ctag = 'fresh'
    db.commit()
    db_session.apply_migrations()
    db.expire_all()
    assert db.get(Calendar, 'one').ctag == 'fresh'


@pytest.mark.parametrize('xml', [b'<html/>', b'<d:multistatus xmlns:d="DAV:"/>'])
def test_invalid_discovery_does_not_authorize_calendar_deletion(xml):
    client = Mock(url='https://example.invalid/dav')
    client.principal.return_value.calendar_home_set.url = 'https://example.invalid/calendars/'
    client.session.request.return_value.status_code = 207
    client.session.request.return_value.content = xml
    assert sync._discover_calendars(client) is None


def test_incomplete_discovery_keeps_unseen_calendars(db, monkeypatch):
    monkeypatch.setattr(sync, 'get_caldav_client', lambda: None)
    monkeypatch.setattr(sync, '_discover_calendars', lambda _: [
        {'url': 'one', 'discovery_complete': False}])
    monkeypatch.setattr(sync, '_sync_calendar', lambda *args: None)
    monkeypatch.setattr(db_session, 'SessionLocal', lambda: db)
    sync.run_sync()
    assert db.get(Calendar, 'two') is not None
