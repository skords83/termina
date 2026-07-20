# backend/src/app/api/ics_api.py
#
# ICS-Import/-Export: Termine als .ics-Datei herunterladen oder aus einer
# .ics-Datei in einen Kalender importieren.

from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, Response, UploadFile
from sqlalchemy.orm import Session

from app.auth import service
from app.auth.dependencies import get_current_user
from app.caldav.sync import run_sync
from app.caldav.write import CalDAVTimeoutError, import_ical_object
from app.db.models import Event, EventOverride, User
from app.db.session import get_db
from app.ics import IcsImportError, build_export_calendar, split_ics_for_import

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/ics/export")
def export_ics(
    calendar_id: str | None = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    accessible = service.accessible_calendar_ids(db, user)
    q = db.query(Event)
    if calendar_id:
        service.ensure_calendar_access(db, user, calendar_id)
        q = q.filter(Event.calendar_id == calendar_id)
    elif accessible is not None:
        q = q.filter(Event.calendar_id.in_(accessible))

    events = q.all()

    overrides_by_uid: dict[str, list[EventOverride]] = {}
    if events:
        uids = [e.uid for e in events]
        for ov in db.query(EventOverride).filter(EventOverride.master_uid.in_(uids)).all():
            overrides_by_uid.setdefault(ov.master_uid, []).append(ov)

    ics_bytes = build_export_calendar(events, overrides_by_uid)

    return Response(
        content=ics_bytes,
        media_type="text/calendar",
        headers={"Content-Disposition": 'attachment; filename="termina-export.ics"'},
    )


@router.post("/ics/import")
async def import_ics(
    background: BackgroundTasks,
    calendar_id: str = Form(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    service.ensure_calendar_access(db, user, calendar_id)

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Datei ist leer")

    try:
        groups = split_ics_for_import(data)
    except IcsImportError as e:
        raise HTTPException(status_code=400, detail=str(e))

    imported = 0
    errors: list[str] = []
    for new_uid, ical_bytes in groups:
        try:
            import_ical_object(calendar_id, ical_bytes)
            imported += 1
        except CalDAVTimeoutError as e:
            raise HTTPException(
                status_code=503,
                detail=f"CalDAV-Server nicht erreichbar (bereits importiert: {imported}): {e}",
            )
        except Exception as e:
            logger.warning("Import: Termin übersprungen (%s): %s", new_uid, e)
            errors.append(str(e))

    background.add_task(run_sync)

    return {
        "imported": imported,
        "failed": len(errors),
        "total": len(groups),
    }
