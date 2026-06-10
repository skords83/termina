from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.auth import require_token
from app.caldav.write import create_event, update_event, delete_event, ConflictError
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


class EventDelete(BaseModel):
    etag: str


# ── GET ───────────────────────────────────────────────────────────────────────

@router.get("/events")
def get_events(
    from_: datetime = Query(alias="from"),
    to: datetime = Query(),
    calendar_id: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    _: None = Depends(require_token),
):
    q = db.query(Event).filter(Event.start < to, Event.end > from_)
    if calendar_id:
        q = q.filter(Event.calendar_id == calendar_id)
    return [
        {
            "uid": e.uid,
            "calendar_id": e.calendar_id,
            "summary": e.summary,
            "start": e.start,
            "end": e.end,
            "all_day": e.all_day,
            "location": e.location,
            "etag": e.etag,
        }
        for e in q.all()
    ]


# ── POST: Erstellen ───────────────────────────────────────────────────────────

@router.post("/events", status_code=201)
def post_event(
    body: EventCreate,
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

    # Sofort re-synchen damit das neue Event in der DB landet
    run_sync()

    event = db.query(Event).filter(Event.uid == uid).first()
    if not event:
        raise HTTPException(status_code=500, detail="Sync nach Create fehlgeschlagen")

    return {"uid": uid}


# ── PUT: Bearbeiten ───────────────────────────────────────────────────────────

@router.put("/events/{uid}")
def put_event(
    uid: str,
    body: EventUpdate,
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

    run_sync()
    return {"uid": uid}


# ── DELETE: Löschen ───────────────────────────────────────────────────────────

@router.delete("/events/{uid}", status_code=204)
def delete_event_endpoint(
    uid: str,
    body: EventDelete,
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
            etag=body.etag,
        )
    except ConflictError:
        raise HTTPException(status_code=409, detail="Extern geändert – bitte neu laden")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    run_sync()