# backend/src/app/api/sync_api.py
#
# Manueller Sync-Endpoint.
# In main.py einbinden:
#   from app.api import sync_api
#   app.include_router(sync_api.router, prefix="/api")

from fastapi import APIRouter, BackgroundTasks, Depends
from app.api.auth import require_token
from app.caldav.sync import run_sync

router = APIRouter()


@router.post("/sync", status_code=202)
def post_sync(
    background: BackgroundTasks,
    _: None = Depends(require_token),
):
    """Startet einen manuellen CalDAV-Sync im Hintergrund."""
    background.add_task(run_sync)
    return {"status": "sync gestartet"}
