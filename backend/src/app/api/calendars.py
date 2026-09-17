from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import service
from app.auth.dependencies import get_current_user
from app.db.models import Calendar, User
from app.db.session import get_db

router = APIRouter(prefix="/calendars", tags=["calendars"])


class CalendarOut(BaseModel):
    id: str
    name: str
    color: str | None
    can_write: bool
    read_only: bool

    model_config = {"from_attributes": True}


@router.get("", response_model=list[CalendarOut])
def list_calendars(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[CalendarOut]:
    q = db.query(Calendar).order_by(Calendar.name)
    accessible = service.accessible_calendar_ids(db, user)
    if accessible is not None:
        q = q.filter(Calendar.id.in_(accessible))
    writable = service.writable_calendar_ids(db, user)
    return [CalendarOut(id=c.id, name=c.name, color=c.color, read_only=c.read_only, can_write=c.id in writable) for c in q.all()]
