from datetime import datetime, timedelta, timezone
from unittest.mock import Mock
import pytest
from icalendar import Alarm, Calendar as ICalendar, Event as IEvent
from fastapi import HTTPException
from .test_security_regressions import secured_api, login
from app.auth.service import ensure_calendar_write, set_calendar_access
from app.caldav import sync, write
from app.db.models import Calendar, Event, SyncState, User
from app.reminders import read_reminders, set_reminders

PAYLOAD = {'calendar_id': 'cal', 'summary': 'Termin', 'start': '2026-10-01T10:00:00', 'end': '2026-10-01T11:00:00'}


def test_preferences_persist_and_validate(secured_api):
    client, sessions = secured_api
    login(client)
    prefs = {'default_calendar_id': 'cal', 'default_duration_minutes': 90, 'default_view': 'week', 'default_reminder_minutes': 15}
    assert client.put('/api/preferences', json=prefs).json() == prefs
    assert client.get('/api/preferences').json() == prefs
    assert client.get('/api/auth/me').json()['default_view'] == 'week'
    assert client.put('/api/preferences', json={**prefs, 'default_duration_minutes': 0}).status_code == 422
    with sessions() as db:
        db.get(Calendar, 'cal').read_only = True; db.commit()
    assert client.put('/api/preferences', json=prefs).status_code == 403


@pytest.mark.parametrize('method,path,payload', [
    ('post', '/api/events', PAYLOAD),
    ('put', '/api/events/event', {**PAYLOAD, 'etag': 'x'}),
    ('delete', '/api/events/event', {'etag':'x'}),
    ('post', '/api/events/event/move', {'mode':'all','etag':'x','original_start':PAYLOAD['start'],'new_start':PAYLOAD['start'],'new_end':PAYLOAD['end']}),
    ('post', '/api/events/event/resize', {'mode':'all','etag':'x','occurrence_start':PAYLOAD['start'],'new_end':PAYLOAD['end']}),
])
def test_read_only_blocks_admin_mutations(secured_api, method, path, payload):
    client, sessions = secured_api
    login(client)
    with sessions() as db:
        db.get(Calendar,'cal').read_only = True
        db.add(Event(uid='event', calendar_id='cal', summary='Event', start=datetime(2026,10,1,10),end=datetime(2026,10,1,11))); db.commit()
    assert client.get('/api/calendars').json()[0]['can_write'] is False
    assert client.request(method,path,json=payload).status_code == 403


def test_member_write_grants_are_separate(secured_api):
    _, sessions = secured_api
    with sessions() as db:
        user = db.get(User,1); user.role = 'member'; db.commit()
        set_calendar_access(db,user,['cal'],[])
        with pytest.raises(HTTPException): ensure_calendar_write(db,user,'cal')
        set_calendar_access(db,user,['cal'],['cal']); ensure_calendar_write(db,user,'cal')
        db.get(Calendar,'cal').read_only=True; db.commit()
        with pytest.raises(HTTPException): ensure_calendar_write(db,user,'cal')


def test_default_alarm_and_explicit_empty(secured_api, monkeypatch):
    client,sessions=secured_api; login(client)
    with sessions() as db:
        db.get(User,1).default_reminder_minutes=30; db.commit()
    create=Mock(return_value='created'); monkeypatch.setattr('app.api.events.create_event',create)
    assert client.post('/api/events',json=PAYLOAD).status_code==201
    assert create.call_args.kwargs['reminders']==[30]
    assert client.post('/api/events',json={**PAYLOAD,'reminders':[]}).status_code==201
    assert create.call_args.kwargs['reminders']==[]
    for reminders in [[-1],[40321],[1,2,3,4,5,6]]:
        assert client.post('/api/events',json={**PAYLOAD,'reminders':reminders}).status_code==422


def test_sync_failure_preserves_last_success(secured_api,monkeypatch):
    client,sessions=secured_api; login(client)
    monkeypatch.setattr(sync.db_session,'SessionLocal',sessions)
    def success():
        with sessions() as db: assert db.get(SyncState,1).running
        return 0
    monkeypatch.setattr(sync,'_run_sync_locked',success); sync.run_sync()
    first=client.get('/api/sync/status').json()
    assert not first['running'] and first['last_success_at'] and first['error'] is None
    monkeypatch.setattr(sync,'_run_sync_locked',lambda:1); sync.run_sync()
    failed=client.get('/api/sync/status').json()
    assert failed['last_success_at']==first['last_success_at'] and failed['error'] and not failed['running']


def calendar_with_alarm():
    cal=ICalendar(); cal.add('version','2.0')
    ev=IEvent(); ev.add('uid','event'); ev.add('summary','Old')
    ev.add('dtstart',datetime(2026,10,1,10,tzinfo=timezone.utc)); ev.add('dtend',datetime(2026,10,1,11,tzinfo=timezone.utc))
    ev.add('rrule',{'freq':'weekly'}); set_reminders(ev,[15,60]); cal.add_component(ev)
    return cal,ev


def test_alarm_roundtrip_preserves_other_types():
    cal,ev=calendar_with_alarm()
    audio=Alarm(); audio.add('action','AUDIO'); audio.add('trigger',timedelta(minutes=-5)); ev.add_component(audio)
    set_reminders(ev,[30,30]); saved=ICalendar.from_ical(cal.to_ical()).walk('VEVENT')[0]
    assert read_reminders(saved)==[30] and len(saved.subcomponents)==2
    set_reminders(saved,[])
    assert len(saved.subcomponents)==1 and str(saved.subcomponents[0]['ACTION'])=='AUDIO'


@pytest.mark.parametrize('reminders,expected',[(None,[15,60]),([],[]),([5],[5])])
def test_master_edit_preserves_exceptions_and_alarm_intent(monkeypatch,reminders,expected):
    cal,master=calendar_with_alarm()
    exception=IEvent(); exception.add('uid','event'); exception.add('recurrence-id',datetime(2026,10,8,10,tzinfo=timezone.utc)); exception.add('dtstart',datetime(2026,10,8,12,tzinfo=timezone.utc)); cal.add_component(exception)
    obj=Mock(data=cal.to_ical())
    monkeypatch.setattr(write,'_get_client',lambda:Mock()); monkeypatch.setattr(write,'_find_caldav_calendar',lambda *args:Mock())
    monkeypatch.setattr(write,'_find_caldav_event',lambda *args:obj); monkeypatch.setattr(write,'_get_etag',lambda obj:'x')
    write.update_event('cal','event','x','Updated',master['DTSTART'].dt,master['DTEND'].dt,rrule='FREQ=WEEKLY',reminders=reminders)
    saved=ICalendar.from_ical(obj.data)
    assert len(saved.walk('VEVENT'))==2 and read_reminders(write._find_master(saved))==expected


def test_drag_single_preserves_override_alarms():
    cal,master=calendar_with_alarm(); rid=datetime(2026,10,8,10,tzinfo=timezone.utc)
    write._apply_move_single(cal,master,'event',rid,rid+timedelta(hours=1),rid+timedelta(hours=2),False)
    override=cal.walk('VEVENT')[1]; assert read_reminders(override)==[15,60]; set_reminders(override,[5])
    write._apply_move_single(cal,master,'event',rid,rid+timedelta(hours=2),rid+timedelta(hours=3),False)
    assert read_reminders(cal.walk('VEVENT')[1])==[5]


def test_drag_future_preserves_alarms():
    cal,master=calendar_with_alarm(); remote=Mock(); rid=datetime(2026,10,8,10,tzinfo=timezone.utc)
    write._apply_move_future(remote,cal,master,rid,rid,rid+timedelta(hours=1),False)
    assert read_reminders(ICalendar.from_ical(remote.save_event.call_args.args[0]).walk('VEVENT')[0])==[15,60]


def test_preferences_are_isolated_between_users(secured_api):
    from app.auth.security import hash_password
    client,sessions=secured_api; login(client)
    assert client.put('/api/preferences',json={'default_view':'week'}).status_code==200
    with sessions() as db:
        db.add(User(email='other@test',display_name='Other',role='member',password_hash=hash_password('other-password'),must_change_password=False,created_at=datetime.utcnow())); db.commit()
    assert client.post('/api/auth/login',json={'email':'other@test','password':'other-password'}).status_code==200
    assert client.get('/api/preferences').json()['default_view']=='month'
    assert client.put('/api/preferences',json={'default_calendar_id':'cal'}).status_code==403


def test_feature_migrations_preserve_existing_grants_and_alarms(secured_api,monkeypatch):
    from sqlalchemy import text
    from app.db import session as db_session
    from app.db.models import UserCalendarAccess
    _,sessions=secured_api
    with sessions() as db:
        db.add(UserCalendarAccess(user_id=1,calendar_id='cal',can_write=True)); db.commit()
        engine=db.bind
    columns={'events':['reminders'],'event_overrides':['reminders'],'calendars':['read_only'], 'user_calendar_access':['can_write'], 'users':['default_calendar_id','default_duration_minutes','default_view','default_reminder_minutes']}
    with engine.begin() as conn:
        for table,names in columns.items():
            for name in names: conn.execute(text(f'ALTER TABLE {table} DROP COLUMN {name}'))
    monkeypatch.setattr(db_session,'engine',engine)
    db_session.apply_migrations(); db_session.apply_migrations()
    with sessions() as db:
        assert db.query(UserCalendarAccess).one().can_write
        assert db.get(User,1).default_duration_minutes==60
        assert not db.get(Calendar,'cal').read_only


def test_ics_export_keeps_override_alarm_disable(secured_api):
    from app.db.models import EventOverride
    client,sessions=secured_api;login(client)
    with sessions() as db:
        db.add(Event(uid='series',calendar_id='cal',summary='Weekly',start=datetime(2026,10,1,10),end=datetime(2026,10,1,11),rrule='FREQ=WEEKLY',reminders=[15]))
        db.add(EventOverride(master_uid='series',recurrence_id=datetime(2026,10,8,10),start=datetime(2026,10,8,10),end=datetime(2026,10,8,11),reminders=[]));db.commit()
    response=client.get('/api/ics/export/event/series');assert response.status_code==200
    events=ICalendar.from_ical(response.content).walk('VEVENT')
    assert read_reminders(events[0])==[15] and read_reminders(events[1])==[]
