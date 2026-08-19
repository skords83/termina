# backend/src/app/api/public_ics.py
#
# Oeffentlicher, unauthentifizierter ICS-Export fuer "Mit Oma + Opa teilen":
# ein Abo-Link (webcal://...) fuer Kalender-Apps ohne Login (z.B. Apple
# Kalender "Kalender abonnieren"). Einzige Absicherung ist ein Secret-Token
# in der URL - kein Cookie, kein User-Kontext. Ohne konfigurierten Kalender
# oder Token ist der Endpoint komplett deaktiviert (404, wie "gibt's nicht").

from __future__ import annotations

import secrets

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from app.config import settings
from app.db.models import Event, EventOverride
from app.db.session import get_db
from app.ics import build_export_calendar

router = APIRouter()


@router.get("/public/oma-opa/{token}.ics")
def export_oma_opa_ics(token: str, db: Session = Depends(get_db)) -> Response:
    calendar_id = settings.oma_opa_calendar_id
    expected_token = settings.oma_opa_export_token

    if not calendar_id or not expected_token or not secrets.compare_digest(token, expected_token):
        raise HTTPException(status_code=404)

    events = db.query(Event).filter(Event.calendar_id == calendar_id).all()

    overrides_by_uid: dict[str, list[EventOverride]] = {}
    if events:
        uids = [e.uid for e in events]
        for ov in db.query(EventOverride).filter(EventOverride.master_uid.in_(uids)).all():
            overrides_by_uid.setdefault(ov.master_uid, []).append(ov)

    ics_bytes = build_export_calendar(events, overrides_by_uid)

    return Response(content=ics_bytes, media_type="text/calendar")
