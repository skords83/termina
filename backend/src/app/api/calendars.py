from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.auth import require_token
from app.db.models import Calendar
from app.db.session import get_db

router = APIRouter(prefix="/calendars", tags=["calendars"])


class CalendarOut(BaseModel):
    id: str
    name: str
    color: str | None

    model_config = {"from_attributes": True}


@router.get("", response_model=list[CalendarOut], dependencies=[Depends(require_token)])
def list_calendars(db: Session = Depends(get_db)) -> list[Calendar]:
    return db.query(Calendar).order_by(Calendar.name).all()
