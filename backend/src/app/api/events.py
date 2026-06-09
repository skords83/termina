from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.auth import require_token
from app.db.models import Event
from app.db.session import get_db

router = APIRouter(prefix="/events", tags=["events"])


class EventOut(BaseModel):
    uid: str
    calendar_id: str
    summary: str | None
    start: datetime | None
    end: datetime | None
    all_day: bool
    location: str | None

    model_config = {"from_attributes": True}


@router.get("", response_model=list[EventOut], dependencies=[Depends(require_token)])
def list_events(
    from_: datetime = Query(..., alias="from"),
    to: datetime = Query(...),
    calendar_id: str | None = Query(None),
    db: Session = Depends(get_db),
) -> list[Event]:
    q = db.query(Event).filter(
        Event.start < to,
        Event.end > from_,
    )
    if calendar_id is not None:
        q = q.filter(Event.calendar_id == calendar_id)
    return q.order_by(Event.start).all()
