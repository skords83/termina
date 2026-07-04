import logging
from datetime import datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.auth.security import (
    generate_session_token,
    generate_temp_password,
    hash_password,
    hash_session_token,
    verify_password,
)
from app.config import settings
from app.db.models import User, UserCalendarAccess, UserSession
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)


class LockedOutError(Exception):
    def __init__(self, retry_after_minutes: int):
        self.retry_after_minutes = retry_after_minutes


def authenticate(db: Session, email: str, password: str) -> User:
    user = db.query(User).filter(User.email == email).first()
    now = datetime.utcnow()

    if user is not None and user.locked_until is not None and user.locked_until > now:
        remaining = max(1, int((user.locked_until - now).total_seconds() // 60) + 1)
        raise LockedOutError(remaining)

    if user is None or not verify_password(password, user.password_hash):
        if user is not None:
            user.failed_login_attempts += 1
            if user.failed_login_attempts >= settings.failed_login_max_attempts:
                overflow = user.failed_login_attempts - settings.failed_login_max_attempts
                user.locked_until = now + timedelta(minutes=settings.lockout_minutes * (2**overflow))
            db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="E-Mail oder Passwort falsch")

    user.failed_login_attempts = 0
    user.locked_until = None
    user.last_login_at = now
    db.commit()
    return user


def create_session(db: Session, user: User, remember_me: bool) -> tuple[str, datetime]:
    raw_token = generate_session_token()
    now = datetime.utcnow()
    ttl = (
        timedelta(days=settings.session_remember_ttl_days)
        if remember_me
        else timedelta(hours=settings.session_short_ttl_hours)
    )
    expires_at = now + ttl

    db.add(
        UserSession(
            id=hash_session_token(raw_token),
            user_id=user.id,
            created_at=now,
            last_seen_at=now,
            expires_at=expires_at,
            remember_me=remember_me,
        )
    )
    db.commit()
    return raw_token, expires_at


def delete_session(db: Session, raw_token: str) -> None:
    token_hash = hash_session_token(raw_token)
    db.query(UserSession).filter(UserSession.id == token_hash).delete()
    db.commit()


def create_user(db: Session, email: str, display_name: str, role: str, calendar_ids: list[str]) -> tuple[User, str]:
    temp_password = generate_temp_password()
    user = User(
        email=email,
        display_name=display_name,
        password_hash=hash_password(temp_password),
        role=role,
        must_change_password=True,
        created_at=datetime.utcnow(),
    )
    db.add(user)
    db.flush()
    _set_calendar_access(db, user, calendar_ids)
    db.commit()
    db.refresh(user)
    return user, temp_password


def reset_password(db: Session, user: User) -> str:
    temp_password = generate_temp_password()
    user.password_hash = hash_password(temp_password)
    user.must_change_password = True
    user.failed_login_attempts = 0
    user.locked_until = None
    db.commit()
    return temp_password


def change_password(db: Session, user: User, new_password: str) -> None:
    user.password_hash = hash_password(new_password)
    user.must_change_password = False
    db.commit()


def set_calendar_access(db: Session, user: User, calendar_ids: list[str]) -> None:
    _set_calendar_access(db, user, calendar_ids)
    db.commit()


def _set_calendar_access(db: Session, user: User, calendar_ids: list[str]) -> None:
    db.query(UserCalendarAccess).filter(UserCalendarAccess.user_id == user.id).delete()
    for calendar_id in calendar_ids:
        db.add(UserCalendarAccess(user_id=user.id, calendar_id=calendar_id))


def accessible_calendar_ids(db: Session, user: User) -> list[str] | None:
    """None bedeutet uneingeschränkten Zugriff (admin)."""
    if user.role == "admin":
        return None
    rows = db.query(UserCalendarAccess.calendar_id).filter(UserCalendarAccess.user_id == user.id).all()
    return [row[0] for row in rows]


def ensure_calendar_access(db: Session, user: User, calendar_id: str) -> None:
    accessible = accessible_calendar_ids(db, user)
    if accessible is not None and calendar_id not in accessible:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Kein Zugriff auf diesen Kalender")


def bootstrap_initial_admin() -> None:
    """Legt beim ersten Start einen Admin aus INITIAL_ADMIN_EMAIL/PASSWORD an, falls noch keine User existieren."""
    if not settings.initial_admin_email or not settings.initial_admin_password:
        return

    db = SessionLocal()
    try:
        if db.query(User).count() > 0:
            return
        db.add(
            User(
                email=settings.initial_admin_email,
                display_name="Admin",
                password_hash=hash_password(settings.initial_admin_password),
                role="admin",
                must_change_password=True,
                created_at=datetime.utcnow(),
            )
        )
        db.commit()
        logger.info("Initialer Admin-Account angelegt: %s", settings.initial_admin_email)
    finally:
        db.close()
