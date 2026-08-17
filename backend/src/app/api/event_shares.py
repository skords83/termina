from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import service
from app.auth.dependencies import get_current_user
from app.caldav.sync import run_sync
from app.caldav.write import create_event
from app.config import settings
from app.db.models import Event, EventShare, User
from app.db.session import get_db

router = APIRouter(prefix="/event-shares", tags=["event-shares"])


class EventShareCreate(BaseModel):
    source_uid: str
    summary: str
    start: datetime
    end: datetime
    buffer_before_minutes: int = 0
    buffer_after_minutes: int = 0


def _naive(dt: datetime) -> datetime:
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _series_has_drift(share: EventShare, source: Event) -> bool:
    return (
        _naive(share.snapshot_start) != _naive(source.start)
        or _naive(share.snapshot_end) != _naive(source.end)
        or share.snapshot_summary != source.summary
        or (share.snapshot_rrule or None) != (source.rrule or None)
    )


def _share_out(share: EventShare, has_drift: bool) -> dict:
    return {
        "id": share.id,
        "source_uid": share.source_uid,
        "shared_uid": share.shared_uid,
        "target_calendar_id": share.target_calendar_id,
        "snapshot_start": share.snapshot_start.isoformat(),
        "snapshot_end": share.snapshot_end.isoformat(),
        "snapshot_summary": share.snapshot_summary,
        "snapshot_rrule": share.snapshot_rrule,
        "buffer_before_minutes": share.buffer_before_minutes,
        "buffer_after_minutes": share.buffer_after_minutes,
        "has_drift": has_drift,
    }


@router.post("", status_code=201)
def create_share(
    body: EventShareCreate,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    source = db.query(Event).filter(Event.uid == body.source_uid).first()
    if source is None:
        raise HTTPException(status_code=404, detail="Quelltermin nicht gefunden")
    service.ensure_calendar_access(db, user, source.calendar_id)

    target_calendar_id = settings.oma_opa_calendar_id
    if not target_calendar_id:
        raise HTTPException(
            status_code=400,
            detail="Zielkalender 'Oma & Opa' ist nicht konfiguriert (OMA_OPA_CALENDAR_ID)",
        )
    service.ensure_calendar_access(db, user, target_calendar_id)

    shared_uid = create_event(
        calendar_id=target_calendar_id,
        summary=body.summary,
        start=body.start,
        end=body.end,
        all_day=source.all_day,
        location=None,
        description=None,
        rrule=source.rrule,
    )

    share = EventShare(
        source_uid=source.uid,
        shared_uid=shared_uid,
        target_calendar_id=target_calendar_id,
        snapshot_start=source.start,
        snapshot_end=source.end,
        snapshot_summary=source.summary,
        snapshot_rrule=source.rrule,
        buffer_before_minutes=body.buffer_before_minutes,
        buffer_after_minutes=body.buffer_after_minutes,
        dismissed=False,
        created_at=datetime.utcnow(),
    )
    db.add(share)
    db.commit()
    db.refresh(share)
    background.add_task(run_sync)

    return _share_out(share, has_drift=False)
