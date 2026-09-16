"""Keep API identities stable while allowing one iCalendar UID in many calendars."""
import uuid

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.models import Event


def event_identity(db: Session, calendar_id: str, remote_uid: str) -> str:
    existing = db.query(Event).filter(
        Event.calendar_id == calendar_id,
        func.coalesce(Event.remote_uid, Event.uid) == remote_uid,
    ).first()
    if existing is not None:
        return existing.uid
    # Preserve existing client/API behavior for non-colliding UIDs.
    if db.get(Event, remote_uid) is None:
        return remote_uid
    candidate = "termina-" + str(uuid.uuid5(uuid.NAMESPACE_URL, calendar_id + "\0" + remote_uid))
    while db.get(Event, candidate) is not None:
        candidate = "termina-" + str(uuid.uuid4())
    return candidate
