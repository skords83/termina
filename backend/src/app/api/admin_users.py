from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import service
from app.auth.dependencies import require_admin
from app.db.models import Calendar, User, UserCalendarAccess
from app.db.session import get_db

router = APIRouter(prefix="/admin/users", tags=["admin"])

VALID_ROLES = ("admin", "member", "child")


class UserSummary(BaseModel):
    id: int
    email: str
    display_name: str
    role: str
    must_change_password: bool
    last_login_at: str | None
    calendar_ids: list[str]


class UserCreate(BaseModel):
    email: str
    display_name: str
    role: str = "member"
    calendar_ids: list[str] = []


class TempPasswordOut(BaseModel):
    temp_password: str


class CalendarAccessUpdate(BaseModel):
    calendar_ids: list[str]


def _to_summary(db: Session, user: User) -> UserSummary:
    rows = db.query(UserCalendarAccess.calendar_id).filter(UserCalendarAccess.user_id == user.id).all()
    return UserSummary(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        role=user.role,
        must_change_password=user.must_change_password,
        last_login_at=user.last_login_at.isoformat() if user.last_login_at else None,
        calendar_ids=[row[0] for row in rows],
    )


def _validate_calendar_ids(db: Session, calendar_ids: list[str]) -> None:
    if not calendar_ids:
        return
    found_ids = {row[0] for row in db.query(Calendar.id).filter(Calendar.id.in_(calendar_ids)).all()}
    missing = set(calendar_ids) - found_ids
    if missing:
        raise HTTPException(status_code=400, detail=f"Unbekannte Kalender-IDs: {sorted(missing)}")


@router.get("", response_model=list[UserSummary])
def list_users(db: Session = Depends(get_db), _: User = Depends(require_admin)) -> list[UserSummary]:
    users = db.query(User).order_by(User.display_name).all()
    return [_to_summary(db, u) for u in users]


@router.post("", response_model=TempPasswordOut, status_code=201)
def create_user(
    body: UserCreate, db: Session = Depends(get_db), _: User = Depends(require_admin)
) -> TempPasswordOut:
    if body.role not in VALID_ROLES:
        raise HTTPException(status_code=400, detail="Ungültige Rolle")
    if db.query(User).filter(User.email == body.email).first() is not None:
        raise HTTPException(status_code=409, detail="E-Mail bereits vergeben")

    _validate_calendar_ids(db, body.calendar_ids)
    _, temp_password = service.create_user(db, body.email, body.display_name, body.role, body.calendar_ids)
    return TempPasswordOut(temp_password=temp_password)


@router.post("/{user_id}/reset-password", response_model=TempPasswordOut)
def reset_password(
    user_id: int, db: Session = Depends(get_db), _: User = Depends(require_admin)
) -> TempPasswordOut:
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=404, detail="User nicht gefunden")
    temp_password = service.reset_password(db, user)
    return TempPasswordOut(temp_password=temp_password)


@router.put("/{user_id}/calendar-access", response_model=UserSummary)
def update_calendar_access(
    user_id: int,
    body: CalendarAccessUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
) -> UserSummary:
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=404, detail="User nicht gefunden")
    _validate_calendar_ids(db, body.calendar_ids)
    service.set_calendar_access(db, user, body.calendar_ids)
    return _to_summary(db, user)
