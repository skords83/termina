"""Snapshots and durable records of successful Termina changes."""
from datetime import datetime
from fastapi.encoders import jsonable_encoder
from app.db.models import CalendarChange, DeletedEvent, EventOverride
from app.ics import build_export_calendar

FIELDS = ('summary', 'start', 'end', 'all_day', 'location', 'description', 'rrule', 'reminders', 'calendar_id')


def snapshot(event):
    return {key: (value.isoformat() if isinstance(value, datetime) else value)
            for key in FIELDS if (value := getattr(event, key, None)) is not None}


class Change:
    def __init__(self, db, user, event, action, body=None, scope=None, recurrence_id=None):
        self.db, self.user, self.event, self.action = db, user, event, action
        self.before = snapshot(event)
        self.uid, self.calendar_id = event.uid, event.calendar_id
        self.body = body.model_dump(mode='json', exclude_unset=True) if body is not None else {}
        if recurrence_id:
            self.body.update(recurrence_id=recurrence_id, mode=scope)
        if self.body.get('recurrence_id') and self.body.get('mode') != 'all':
            rid = datetime.fromisoformat(self.body['recurrence_id']).replace(tzinfo=None)
            override = db.query(EventOverride).filter_by(master_uid=event.uid, recurrence_id=rid).first()
            if override is not None and override.start is not None:
                for key in ('summary','start','end','location','description','reminders'):
                    value=getattr(override,key)
                    if value is not None:self.before[key]=value.isoformat() if isinstance(value,datetime) else value
            elif event.start and event.end:
                self.before['start']=rid.isoformat()
                self.before['end']=(rid+(event.end-event.start)).isoformat()


    def finish_move(self):
        after={**self.before}
        if 'new_start' in self.body:after['start']=self.body['new_start']
        if 'new_end' in self.body:after['end']=self.body['new_end']
        self.finish(after)

    def finish(self, after=None, scope=None, recurrence_id=None):
        data = after if after is not None else {**self.before, **{k:v for k,v in self.body.items() if k in FIELDS}}
        effective_scope = scope or self.body.get('mode') or ('single' if self.body.get('recurrence_id') else 'all')
        if effective_scope in ('single', 'future'):
            data['calendar_id'] = self.calendar_id
        if effective_scope == 'single' and 'rrule' in self.before:
            data['rrule'] = self.before['rrule']
        if data.get('reminders') is None and 'reminders' in self.before:
            data['reminders'] = self.before['reminders']
        record(self.db, self.user, self.calendar_id, self.uid, self.action, self.before,
               None if self.action == 'delete' else data,
               effective_scope,
               recurrence_id or self.body.get('recurrence_id'))


def record(db, user, calendar_id, uid, action, before, after, scope='all', recurrence_id=None):
    db.add(CalendarChange(calendar_id=calendar_id, target_calendar_id=(after or {}).get('calendar_id'),
        event_uid=uid, actor_id=user.id, actor_name=user.display_name, action=action,
        before=jsonable_encoder(before), after=jsonable_encoder(after), scope=scope, recurrence_id=recurrence_id))
    db.commit()


def prepare_trash(db, user, event, scope, recurrence_id):
    overrides=db.query(EventOverride).filter_by(master_uid=event.uid).all()
    raw=event.raw_ical or build_export_calendar([event], {event.uid:overrides}).decode()
    item=DeletedEvent(calendar_id=event.calendar_id,event_uid=event.uid,summary=event.summary or 'Ohne Titel',
        scope=scope,recurrence_id=recurrence_id,all_day=event.all_day,raw_ical=raw,deleted_by=user.display_name,state='pending')
    db.add(item); db.commit()
    return item
