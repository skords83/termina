from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.auth.service import ensure_calendar_write
from app.db.models import User
from app.db.session import get_db

router = APIRouter(prefix="/preferences", tags=["preferences"])


class Preferences(BaseModel):
    default_calendar_id: str | None = None
    default_duration_minutes: int = Field(default=60, ge=5, le=1440)
    default_view: Literal["month", "week", "day", "agenda"] = "month"
    default_reminder_minutes: int | None = Field(default=None, ge=0, le=40320)
    model_config = {"from_attributes": True}


@router.get("", response_model=Preferences)
def get_preferences(user: User = Depends(get_current_user)):
    return user


@router.put("", response_model=Preferences)
def save_preferences(body: Preferences, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if body.default_calendar_id:
        ensure_calendar_write(db, user, body.default_calendar_id)
    for key, value in body.model_dump().items():
        setattr(user, key, value)
    db.commit()
    return user
