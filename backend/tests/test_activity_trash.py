from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from dateutil.rrule import rrulestr
from icalendar import Calendar as ICalendar, Event as IEvent
from .test_security_regressions import secured_api, login
from app.db.models import Event, EventOverride, Calendar, CalendarChange, DeletedEvent, User, UserCalendarAccess
from app.trash import restore_calendar
from app.reminders import read_reminders, set_reminders
from app.caldav import write


def raw_series():
    cal=ICalendar();cal.add('version','2.0');ev=IEvent();ev.add('uid','old')
    ev.add('summary','Training');ev.add('dtstart',datetime(2026,9,7,8,tzinfo=timezone.utc));ev.add('dtend',datetime(2026,9,7,9,tzinfo=timezone.utc))
    ev.add('rrule',{'FREQ':'WEEKLY','INTERVAL':2,'BYDAY':['MO','WE'],'COUNT':6});set_reminders(ev,[15]);cal.add_component(ev)
    override=IEvent();override.add('uid','old');override.add('summary','Sondertraining');override.add('recurrence-id',datetime(2026,9,9,8,tzinfo=timezone.utc));override.add('dtstart',datetime(2026,9,9,12,tzinfo=timezone.utc));override.add('dtend',datetime(2026,9,9,13,tzinfo=timezone.utc));set_reminders(override,[30]);cal.add_component(override)
    return cal.to_ical().decode()


def seed(sessions):
    with sessions() as db:
        db.add(Event(uid='old',calendar_id='cal',summary='Training',start=datetime(2026,9,7,10),end=datetime(2026,9,7,11),all_day=False,rrule='FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6',reminders=[15],raw_ical=raw_series()));db.commit()


@pytest.mark.parametrize('scope',['all','single','future'])
def test_delete_and_restore_roundtrip(secured_api,monkeypatch,scope):
    client,sessions=secured_api;login(client);seed(sessions)
    monkeypatch.setattr('app.api.activity.run_sync',lambda:None)
    monkeypatch.setattr('app.api.activity.restore_archived_object',lambda *args:None)
    for name in ['delete_event','delete_occurrence','delete_future_occurrences']:
        monkeypatch.setattr('app.api.events.'+name,lambda **kw:kw['snapshot_callback'](raw_series()))
    params={'mode':scope}
    if scope!='all':params['recurrence_id']='2026-09-09T10:00:00'
    assert client.delete('/api/events/old',params=params).status_code==204
    trash=client.get('/api/trash').json()['items'];assert len(trash)==1 and trash[0]['scope']==scope
    result=client.post(f"/api/trash/{trash[0]['id']}/restore");assert result.status_code==200,result.text
    uid=result.json()['uid'];assert uid!='old'
    assert client.post(f"/api/trash/{trash[0]['id']}/restore").json()['uid']==uid
    assert client.get('/api/trash').json()['items']==[]
    history=client.get('/api/activity').json()['items'];assert [r['action'] for r in history]==['restore','delete']
    with sessions() as db:
        restored=db.get(Event,uid);assert restored
        if scope=='single':
            assert restored.summary=='Sondertraining' and restored.rrule is None and restored.reminders==[30]
        else:assert restored.rrule and restored.reminders==[15]
        assert (db.get(Event,'old') is not None)==(scope!='all')


def test_future_restoration_preserves_interval_count_and_exceptions():
    item=SimpleNamespace(raw_ical=raw_series(),scope='future',recurrence_id='2026-09-09T10:00:00',all_day=False)
    cal=ICalendar.from_ical(restore_calendar(item,'new'));master=next(e for e in cal.walk('VEVENT') if 'RECURRENCE-ID' not in e)
    rule=rrulestr(master['RRULE'].to_ical().decode(),dtstart=master['DTSTART'].dt)
    excludes=master.get('EXDATE');excludes=excludes if isinstance(excludes,list) else [excludes]
    excluded={value.dt for entry in excludes for value in entry.dts}
    visible=[date for date in rule if date not in excluded]
    assert len(visible)==5 and visible[0]==datetime(2026,9,9,8,tzinfo=timezone.utc)
    assert visible[1]==datetime(2026,9,21,8,tzinfo=timezone.utc)
    assert len(cal.walk('VEVENT'))==2


def test_failed_delete_never_records_success(secured_api,monkeypatch):
    client,sessions=secured_api;login(client);seed(sessions)
    def fail(**kwargs):raise write.ConflictError('changed')
    monkeypatch.setattr('app.api.events.delete_event',fail)
    assert client.delete('/api/events/old').status_code==409
    assert client.get('/api/trash').json()['items']==[]
    assert client.get('/api/activity').json()['items']==[]
    with sessions() as db:assert db.get(Event,'old')


def test_permissions_apply_to_trash_history_restore_and_purge(secured_api,monkeypatch):
    client,sessions=secured_api;login(client);seed(sessions)
    monkeypatch.setattr('app.api.events.delete_event',lambda **kw:None)
    assert client.delete('/api/events/old').status_code==204
    item_id=client.get('/api/trash').json()['items'][0]['id']
    with sessions() as db:
        user=db.get(User,1);user.role='member';db.commit()
    assert client.get('/api/trash').json()['items']==[]
    assert client.get('/api/activity').json()['items']==[]
    assert client.post(f'/api/trash/{item_id}/restore').status_code==404
    with sessions() as db:
        db.add(UserCalendarAccess(user_id=1,calendar_id='cal',can_write=False));db.commit()
    assert len(client.get('/api/trash').json()['items'])==1
    assert client.post(f'/api/trash/{item_id}/restore').status_code==403
    assert client.delete(f'/api/trash/{item_id}').status_code==403


def test_restore_retry_reuses_uid_after_network_failure(secured_api,monkeypatch):
    client,sessions=secured_api;login(client);seed(sessions)
    monkeypatch.setattr('app.api.events.delete_event',lambda **kw:None)
    monkeypatch.setattr('app.api.activity.run_sync',lambda:None)
    client.delete('/api/events/old');item=client.get('/api/trash').json()['items'][0]
    restore=Mock(side_effect=[write.CalDAVTimeoutError('timeout'),None]);monkeypatch.setattr('app.api.activity.restore_archived_object',restore)
    assert client.post(f"/api/trash/{item['id']}/restore").status_code==503
    assert client.post(f"/api/trash/{item['id']}/restore").status_code==200
    assert restore.call_args_list[0].args[1]==restore.call_args_list[1].args[1]


def test_purge_does_not_delete_history(secured_api,monkeypatch):
    client,sessions=secured_api;login(client);seed(sessions)
    monkeypatch.setattr('app.api.events.delete_event',lambda **kw:None)
    client.delete('/api/events/old');item=client.get('/api/trash').json()['items'][0]
    assert client.delete(f"/api/trash/{item['id']}").status_code==204
    assert client.post(f"/api/trash/{item['id']}/restore").status_code==404
    assert [r['action'] for r in client.get('/api/activity').json()['items']]==['purge','delete']


def test_moving_between_calendars_hides_history_without_both_permissions(secured_api):
    client,sessions=secured_api;login(client)
    with sessions() as db:
        db.add(Calendar(id='other',name='Other'));db.get(User,1).role='member'
        db.add(UserCalendarAccess(user_id=1,calendar_id='cal',can_write=True))
        db.add(CalendarChange(calendar_id='cal',target_calendar_id='other',event_uid='moved',actor_name='Admin',action='update',before={'summary':'secret'},after={'calendar_id':'other'}));db.commit()
    assert client.get('/api/activity').json()['items']==[]


@pytest.mark.parametrize('rule',['FREQ=WEEKLY;INTERVAL=0','FREQ=WEEKLY;COUNT=-1','FREQ=INVALID','BYDAY=MO'])
def test_invalid_recurrence_never_reaches_caldav(secured_api,monkeypatch,rule):
    client,_=secured_api;login(client);create=Mock();monkeypatch.setattr('app.api.events.create_event',create)
    response=client.post('/api/events',json={'calendar_id':'cal','summary':'Weekly','start':'2026-09-07T10:00:00','end':'2026-09-07T11:00:00','rrule':rule})
    assert response.status_code==422;create.assert_not_called()


def test_history_records_before_after_actor_and_pagination(secured_api,monkeypatch):
    client,sessions=secured_api;login(client);seed(sessions)
    monkeypatch.setattr('app.api.events.update_event',lambda **kw:None)
    for title in ['New title','Another title']:
        assert client.put('/api/events/old',json={'summary':title,'start':'2026-09-07T10:00:00','end':'2026-09-07T11:00:00','rrule':'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE'}).status_code==200
    first=client.get('/api/activity?limit=1').json();entry=first['items'][0]
    assert entry['actor']=='Admin' and entry['before']['summary']=='New title' and entry['after']['summary']=='Another title'
    second=client.get(f"/api/activity?limit=1&before_id={first['next_cursor']}").json()
    assert second['items'][0]['id']!=entry['id'] and second['next_cursor'] is None


def test_future_edit_applies_new_rule(secured_api,monkeypatch):
    client,sessions=secured_api;login(client);seed(sessions)
    update=Mock(return_value='new-series');monkeypatch.setattr('app.api.events.update_event_future',update)
    response=client.put('/api/events/old',json={'summary':'Monthly','start':'2026-09-09T10:00:00','end':'2026-09-09T11:00:00','mode':'future','recurrence_id':'2026-09-09T10:00:00','rrule':'FREQ=MONTHLY;BYDAY=1MO'})
    assert response.status_code==200,response.text
    assert update.call_args.kwargs['replace_rrule'] is True
    with sessions() as db:assert db.get(Event,'new-series').rrule=='FREQ=MONTHLY;BYDAY=1MO'


def test_archive_snapshot_is_saved_before_remote_delete(monkeypatch):
    obj=Mock(data=raw_series());obj.etag='tag'
    monkeypatch.setattr(write,'_get_client',lambda:Mock());monkeypatch.setattr(write,'_find_caldav_calendar',lambda *args:Mock());monkeypatch.setattr(write,'_find_caldav_event',lambda *args:obj)
    calls=[]
    obj.delete.side_effect=lambda:calls.append('remote delete')
    write.delete_event('cal','old','tag',lambda raw:calls.append(raw))
    assert calls==[raw_series(),'remote delete']


def test_all_day_single_and_floating_single_restore():
    for all_day in [True,False]:
        cal=ICalendar();ev=IEvent();ev.add('uid','old');ev.add('summary','Test')
        start=datetime(2026,9,7,10);end=start+timedelta(hours=1)
        ev.add('dtstart',start.date() if all_day else start);ev.add('dtend',(start+timedelta(days=1)).date() if all_day else end);ev.add('rrule',{'freq':'weekly'});cal.add_component(ev)
        item=SimpleNamespace(raw_ical=cal.to_ical(),scope='single',recurrence_id='2026-09-14T10:00:00',all_day=all_day)
        restored=ICalendar.from_ical(restore_calendar(item,'new')).walk('VEVENT')[0]
        expected=datetime(2026,9,14,10)
        assert restored['DTSTART'].dt==(expected.date() if all_day else expected)
        assert 'RRULE' not in restored


@pytest.mark.parametrize('new_rule',['FREQ=MONTHLY;BYDAY=1MO',None])
def test_caldav_future_edit_writes_selected_rule(monkeypatch,new_rule):
    obj=Mock(data=raw_series());obj.etag='tag';remote=Mock()
    monkeypatch.setattr(write,'_get_client',lambda:Mock());monkeypatch.setattr(write,'_find_caldav_calendar',lambda *args:remote);monkeypatch.setattr(write,'_find_caldav_event',lambda *args:obj)
    write.update_event_future('cal','old','tag','Changed',datetime(2026,9,9,10),datetime(2026,9,9,11),False,None,None,datetime(2026,9,9,10),rrule=new_rule,replace_rrule=True)
    restored=ICalendar.from_ical(remote.save_event.call_args.args[0]).walk('VEVENT')[0]
    if new_rule:assert restored['RRULE'].to_ical().decode()=='FREQ=MONTHLY;BYDAY=1MO'
    else:assert 'RRULE' not in restored
    assert read_reminders(restored)==[15]


def test_failed_future_creation_never_truncates_original(monkeypatch):
    obj=Mock(data=raw_series());obj.etag='tag';remote=Mock()
    remote.save_event.side_effect=write.CalDAVTimeoutError('unavailable')
    monkeypatch.setattr(write,'_get_client',lambda:Mock());monkeypatch.setattr(write,'_find_caldav_calendar',lambda *args:remote);monkeypatch.setattr(write,'_find_caldav_event',lambda *args:obj)
    with pytest.raises(write.CalDAVTimeoutError):
        write.update_event_future('cal','old','tag','Changed',datetime(2026,9,9,10),datetime(2026,9,9,11),False,None,None,datetime(2026,9,9,10),rrule='FREQ=MONTHLY;BYDAY=1MO',replace_rrule=True)
    obj.save.assert_not_called()
