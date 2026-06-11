from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.auth import require_token
from app.caldav.write import (
    create_event,
    update_event,
    delete_event,
    move_event,
    ConflictError,
    CalDAVTimeoutError,
)
from app.caldav.sync import run_sync
from app.db.models import Event
from app.db.session import get_db

router = APIRouter()


# ── Pydantic-Schemas ──────────────────────────────────────────────────────────

class EventCreate(BaseModel):
    calendar_id: str
    summary: str
    start: datetime
    end: datetime
    all_day: bool = False
    location: str | None = None
    description: str | None = None


class EventUpdate(BaseModel):
    etag: str
    summary: str
    start: datetime
    end: datetime
    all_day: bool = False
    location: str | None = None
    description: str | None = None


class EventMove(BaseModel):
    mode: Literal["single", "future", "all"]
    etag: str
    original_start: datetime
    new_start: datetime
    new_end: datetime
    recurrence_id: datetime | None = None


# ── RRULE-Expansion ───────────────────────────────────────────────────────────

def expand_rrule_event(event: Event, from_: datetime, to: datetime) -> list[dict]:
    """Expandiert ein RRULE-Event und gibt alle Instanzen im Fenster zurück."""
    try:
        from dateutil.rrule import rrulestr

        master_start: datetime = event.start
        master_end: datetime = event.end if event.end is not None else master_start + timedelta(hours=1)
        duration: timedelta = master_end - master_start

        rrule_str = event.rrule
        if "DTSTART" not in rrule_str:
            dtstart_str = master_start.strftime("DTSTART:%Y%m%dT%H%M%S\n")
            rrule_str = dtstart_str + rrule_str

        rule = rrulestr(rrule_str, ignoretz=True)
        instances = rule.between(
            from_ - timedelta(days=1),
            to + timedelta(days=1),
            inc=True,
        )

        result = []
        for inst in instances:
            inst_start: datetime = inst
            inst_end: datetime = inst + duration
            if inst_start >= to or inst_end <= from_:
                continue

            result.append({
                "uid": event.uid,
                "calendar_id": event.calendar_id,
                "summary": event.summary,
                "start": inst_start,
                "end": inst_end,
                "all_day": event.all_day,
                "location": event.location,
                "etag": event.etag,
                "description": event.description,
                "is_recurring": True,
                "recurrence_id": inst_start,
            })

        return result

    except Exception:
        if event.start is not None and event.start < to and (event.end is None or event.end > from_):
            return [{
                "uid": event.uid,
                "calendar_id": event.calendar_id,
                "summary": event.summary,
                "start": event.start,
                "end": event.end,
                "all_day": event.all_day,
                "location": event.location,
                "etag": event.etag,
                "description": event.description,
                "is_recurring": True,
                "recurrence_id": event.start,
            }]
        return []


# ── GET ───────────────────────────────────────────────────────────────────────

@router.get("/events")
def get_events(
    from_: datetime = Query(alias="from"),
    to: datetime = Query(),
    calendar_id: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    _: None = Depends(require_token),
):
    q = db.query(Event)
    if calendar_id:
        q = q.filter(Event.calendar_id == calendar_id)

    non_rrule = (
        q.filter(Event.rrule.is_(None), Event.start < to, Event.end > from_)
        .all()
    )
    rrule_events = q.filter(Event.rrule.isnot(None)).all()

    result = []

    for e in non_rrule:
        result.append({
            "uid": e.uid,
            "calendar_id": e.calendar_id,
            "summary": e.summary,
            "start": e.start,
            "end": e.end,
            "all_day": e.all_day,
            "location": e.location,
            "etag": e.etag,
            "description": e.description,
            "is_recurring": False,
            "recurrence_id": None,
        })

    for e in rrule_events:
        result.extend(expand_rrule_event(e, from_, to))

    return result


# ── POST: Erstellen ───────────────────────────────────────────────────────────

@router.post("/events", status_code=201)
def post_event(
    body: EventCreate,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    _: None = Depends(require_token),
):
    try:
        uid = create_event(
            calendar_id=body.calendar_id,
            summary=body.summary,
            start=body.start,
            end=body.end,
            all_day=body.all_day,
            location=body.location,
            description=body.description,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except CalDAVTimeoutError as e:
        raise HTTPException(status_code=503, detail=f"Nextcloud nicht erreichbar: {e}")

    background.add_task(run_sync)
    return {"uid": uid}


# ── PUT: Bearbeiten ───────────────────────────────────────────────────────────

@router.put("/events/{uid}")
def put_event(
    uid: str,
    body: EventUpdate,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    _: None = Depends(require_token),
):
    event = db.query(Event).filter(Event.uid == uid).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event nicht gefunden")

    try:
        update_event(
            calendar_id=event.calendar_id,
            uid=uid,
            etag=body.etag,
            summary=body.summary,
            start=body.start,
            end=body.end,
            all_day=body.all_day,
            location=body.location,
            description=body.description,
        )
    except ConflictError:
        raise HTTPException(status_code=409, detail="Extern geändert – bitte neu laden")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except CalDAVTimeoutError as e:
        raise HTTPException(status_code=503, detail=f"Nextcloud nicht erreichbar: {e}")

    background.add_task(run_sync)
    return {"uid": uid}


# ── POST /move: Verschieben (DnD) ─────────────────────────────────────────────

@router.post("/events/{uid}/move")
def post_move(
    uid: str,
    body: EventMove,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    _: None = Depends(require_token),
):
    event = db.query(Event).filter(Event.uid == uid).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event nicht gefunden")

    # Validierung: single/future brauchen recurrence_id
    if body.mode in ("single", "future") and body.recurrence_id is None:
        raise HTTPException(
            status_code=400,
            detail=f"recurrence_id ist für mode='{body.mode}' erforderlich",
        )

    # Validierung: single/future nur bei rekurrenten Events sinnvoll
    if body.mode in ("single", "future") and not event.rrule:
        raise HTTPException(
            status_code=400,
            detail=f"mode='{body.mode}' nur für rekurrente Events erlaubt",
        )

    try:
        result = move_event(
            mode=body.mode,
            calendar_id=event.calendar_id,
            uid=uid,
            etag=body.etag,
            original_start=body.original_start,
            new_start=body.new_start,
            new_end=body.new_end,
            all_day=event.all_day,
            recurrence_id=body.recurrence_id,
        )
    except ConflictError:
        raise HTTPException(status_code=409, detail="Extern geändert – bitte neu laden")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except CalDAVTimeoutError as e:
        raise HTTPException(status_code=503, detail=f"Nextcloud nicht erreichbar: {e}")

    # Lokale DB sofort aktualisieren für instant UI feedback (sync räumt später nach)
    if body.mode == "all":
        delta = body.new_start.replace(tzinfo=None) - body.original_start.replace(tzinfo=None)
        if event.start is not None:
            event.start = event.start + delta
        if event.end is not None:
            event.end = event.end + delta
        db.commit()

    background.add_task(run_sync)

    response = {"uid": uid}
    if "new_uid" in result:
        response["new_uid"] = result["new_uid"]
    return response


# ── DELETE: Löschen ───────────────────────────────────────────────────────────

@router.delete("/events/{uid}", status_code=204)
def delete_event_endpoint(
    uid: str,
    etag: str = Query(...),
    background: BackgroundTasks = BackgroundTasks(),
    db: Session = Depends(get_db),
    _: None = Depends(require_token),
):
    event = db.query(Event).filter(Event.uid == uid).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event nicht gefunden")

    try:
        delete_event(
            calendar_id=event.calendar_id,
            uid=uid,
            etag=etag,
        )
    except ConflictError:
        raise HTTPException(status_code=409, detail="Extern geändert – bitte neu laden")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except CalDAVTimeoutError as e:
        raise HTTPException(status_code=503, detail=f"Nextcloud nicht erreichbar: {e}")

    db.delete(event)
    db.commit()

    background.add_task(run_sync)
