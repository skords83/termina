from datetime import datetime, timezone

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import service
from app.auth.dependencies import get_current_user
from app.auth.security import verify_password
from app.config import settings
from app.db.models import User
from app.db.session import get_db

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    email: str
    password: str
    remember_me: bool = False


class ChangePasswordRequest(BaseModel):
    current_password: str | None = None
    new_password: str


class UserOut(BaseModel):
    id: int
    email: str
    display_name: str
    role: str
    must_change_password: bool

    model_config = {"from_attributes": True}


def _set_session_cookie(response: Response, raw_token: str, expires_at: datetime) -> None:
    response.set_cookie(
        key=settings.session_cookie_name,
        value=raw_token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        expires=expires_at.replace(tzinfo=timezone.utc),
        path="/",
    )


@router.post("/login", response_model=UserOut)
def login(body: LoginRequest, response: Response, db: Session = Depends(get_db)) -> User:
    try:
        user = service.authenticate(db, body.email, body.password)
    except service.LockedOutError as e:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Zu viele Fehlversuche. Erneut versuchen in {e.retry_after_minutes} Minuten.",
        )

    raw_token, expires_at = service.create_session(db, user, body.remember_me)
    _set_session_cookie(response, raw_token, expires_at)
    return user


@router.post("/logout")
def logout(
    response: Response,
    db: Session = Depends(get_db),
    session_token: str | None = Cookie(default=None, alias=settings.session_cookie_name),
) -> dict:
    if session_token:
        service.delete_session(db, session_token)
    response.delete_cookie(settings.session_cookie_name, path="/")
    return {"status": "ok"}


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> User:
    return user


@router.post("/change-password", response_model=UserOut)
def change_password(
    body: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> User:
    if not user.must_change_password:
        if body.current_password is None or not verify_password(body.current_password, user.password_hash):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Aktuelles Passwort falsch")
    service.change_password(db, user, body.new_password)
    return user
