from datetime import datetime
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..db.session import get_db
from ..db.models import Event
from ..api.auth import require_token
from ..caldav.recurrence import expand_event

router = APIRouter(prefix="/events", tags=["events"])


@router.get("")
def get_events(
    from_: datetime = Query(alias="from"),
    to: datetime = Query(),
    calendar_id: str | None = None,
    db: Session = Depends(get_db),
    _: None = Depends(require_token),
):
    query = db.query(Event)
    if calendar_id:
        query = query.filter(Event.calendar_id == calendar_id)

    # Für RRULEs ohne UNTIL/COUNT können wir start nicht sicher vorfiltern –
    # expand_event übernimmt die Fenster-Prüfung.
    # Einzeltermine könnten per start/end-Vergleich vorausgefiltert werden,
    # aber bei ~10 Kalendern ist der Full-Scan akzeptabel.
    results = []
    for event in query.all():
        occurrences = expand_event(event.raw_ical, from_, to)
        for occ in occurrences:
            occ["calendar_id"] = event.calendar_id
            occ["description"] = event.description
            results.append(occ)

    results.sort(key=lambda e: e["start"])
    return results