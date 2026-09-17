from datetime import timezone
from threading import Lock
from uuid import uuid4
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session
from app.auth.dependencies import get_current_user
from app.auth.service import accessible_calendar_ids, ensure_calendar_write
from app.db.models import CalendarChange, DeletedEvent, Calendar, User
from app.db.session import get_db
from app.activity import record, snapshot
from app.trash import restore_calendar
from app.caldav.write import restore_archived_object, CalDAVTimeoutError, ConflictError
from app.caldav.sync import run_sync, _upsert_event

router=APIRouter(tags=['activity'])
_restore_lock=Lock()


def visible(query, model, db, user):
    # Join current calendars even for admins: deleted calendars have no restore target.
    query=query.filter(model.calendar_id.in_(db.query(Calendar.id)))
    ids=accessible_calendar_ids(db,user)
    if ids is not None:
        query=query.filter(model.calendar_id.in_(ids))
        if model is CalendarChange:
            query=query.filter(or_(model.target_calendar_id.is_(None),model.target_calendar_id.in_(ids)))
    return query


def iso(value):
    return value.replace(tzinfo=timezone.utc).isoformat()


@router.get('/activity')
def list_activity(before_id: int | None = None, limit: int = Query(50,ge=1,le=100), event_uid: str | None = None,
                  db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    q=visible(db.query(CalendarChange),CalendarChange,db,user)
    if before_id is not None:q=q.filter(CalendarChange.id<before_id)
    if event_uid:q=q.filter(CalendarChange.event_uid==event_uid)
    rows=q.order_by(CalendarChange.id.desc()).limit(limit+1).all()
    return {'items':[{'id':r.id,'calendar_id':r.calendar_id,'event_uid':r.event_uid,'actor':r.actor_name,
        'action':r.action,'scope':r.scope,'recurrence_id':r.recurrence_id,'at':iso(r.created_at),
        'before':r.before,'after':r.after} for r in rows[:limit]],
        'next_cursor':rows[limit-1].id if len(rows)>limit else None}


@router.get('/trash')
def list_trash(before_id:int | None=None,limit:int=Query(50,ge=1,le=100),
               db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    q=visible(db.query(DeletedEvent),DeletedEvent,db,user).filter(DeletedEvent.state.in_(['deleted','restoring']))
    if before_id is not None:q=q.filter(DeletedEvent.id<before_id)
    rows=q.order_by(DeletedEvent.id.desc()).limit(limit+1).all()
    return {'items':[{'id':r.id,'calendar_id':r.calendar_id,'event_uid':r.event_uid,'summary':r.summary,
        'scope':r.scope,'recurrence_id':r.recurrence_id,'at':iso(r.deleted_at),'actor':r.deleted_by} for r in rows[:limit]],
        'next_cursor':rows[limit-1].id if len(rows)>limit else None}


def restore_item(item_id,db,user,background):
    with _restore_lock:
        item=visible(db.query(DeletedEvent),DeletedEvent,db,user).filter(DeletedEvent.id==item_id).first()
        if item is None or item.state not in ('deleted','restoring','restored'):
            raise HTTPException(404,'Papierkorbeintrag nicht gefunden')
        ensure_calendar_write(db,user,item.calendar_id)
        if item.state=='restored': return {'uid':item.restored_uid}
        if not item.restored_uid:item.restored_uid=str(uuid4())
        try: raw=restore_calendar(item,item.restored_uid)
        except (ValueError,TypeError) as exc: raise HTTPException(400,str(exc))
        item.state='restoring';db.commit()
        try: restore_archived_object(item.calendar_id,item.restored_uid,raw)
        except ConflictError: raise HTTPException(409,'Die Wiederherstellung kollidiert mit einem vorhandenen Termin.')
        except ValueError as exc: raise HTTPException(404,str(exc))
        except CalDAVTimeoutError: raise HTTPException(503,'Kalenderserver nicht erreichbar. Erneut versuchen.')
        from app.db.models import Event
        if not _upsert_event(db,item.calendar_id,None,raw.decode(),'',{},set()):
            raise HTTPException(500,'Termin wurde übertragen, konnte aber lokal nicht eingelesen werden. Erneut versuchen.')
        item.state='restored'
        event=db.get(Event,item.restored_uid)
        record(db,user,item.calendar_id,item.restored_uid,'restore',None,snapshot(event),item.scope,item.recurrence_id)
        background.add_task(run_sync)
        return {'uid':item.restored_uid}


@router.post('/trash/restore-latest/{uid}')
def restore_latest(uid:str,background:BackgroundTasks,scope:str="all",recurrence_id:str|None=None,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    item=visible(db.query(DeletedEvent),DeletedEvent,db,user).filter_by(event_uid=uid,scope=scope,recurrence_id=recurrence_id).filter(DeletedEvent.state.in_(['deleted','restoring'])).order_by(DeletedEvent.id.desc()).first()
    if item is None:raise HTTPException(404,'Gelöschter Termin nicht mehr im Papierkorb')
    return restore_item(item.id,db,user,background)


@router.post('/trash/{item_id}/restore')
def restore(item_id:int,background:BackgroundTasks,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    return restore_item(item_id,db,user,background)


@router.delete('/trash/{item_id}',status_code=204)
def purge(item_id:int,db:Session=Depends(get_db),user:User=Depends(get_current_user)):
    with _restore_lock:
        item=visible(db.query(DeletedEvent),DeletedEvent,db,user).filter_by(id=item_id,state='deleted').first()
        if item is None:raise HTTPException(404,'Papierkorbeintrag nicht gefunden')
        ensure_calendar_write(db,user,item.calendar_id)
        db.delete(item)
        record(db,user,item.calendar_id,item.event_uid,'purge',{'summary':item.summary},None,item.scope,item.recurrence_id)
