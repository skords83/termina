from datetime import datetime, timedelta

from fastapi import Cookie, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.auth.security import hash_session_token
from app.config import settings
from app.db.models import User, UserSession
from app.db.session import get_db


def _unauthorized() -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Nicht angemeldet")


def get_current_user(
    db: Session = Depends(get_db),
    session_token: str | None = Cookie(default=None, alias=settings.session_cookie_name),
) -> User:
    if session_token is None:
        raise _unauthorized()

    token_hash = hash_session_token(session_token)
    session = db.query(UserSession).filter(UserSession.id == token_hash).first()
    if session is None or session.expires_at < datetime.utcnow():
        raise _unauthorized()

    user = db.query(User).filter(User.id == session.user_id).first()
    if user is None:
        raise _unauthorized()

    now = datetime.utcnow()
    ttl = (
        timedelta(days=settings.session_remember_ttl_days)
        if session.remember_me
        else timedelta(hours=settings.session_short_ttl_hours)
    )
    session.last_seen_at = now
    session.expires_at = now + ttl
    db.commit()

    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Nur für Admins")
    return user
