from datetime import timezone

from fastapi import APIRouter, BackgroundTasks, Depends
from sqlalchemy.orm import Session
from app.auth.dependencies import get_current_user
from app.caldav.sync import run_sync
from app.db.models import SyncState, User
from app.db.session import get_db

router = APIRouter()


@router.get("/sync/status")
def sync_status(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    state = db.get(SyncState, 1)
    def iso(value):
        return value.replace(tzinfo=timezone.utc).isoformat() if value else None
    return {
        "running": state.running if state else False,
        "started_at": iso(state.started_at) if state else None,
        "finished_at": iso(state.finished_at) if state else None,
        "last_success_at": iso(state.last_success_at) if state else None,
        "error": state.error if state else None,
    }


@router.post("/sync", status_code=202)
def post_sync(background: BackgroundTasks, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    state = db.get(SyncState, 1)
    if state is None or not state.running:
        background.add_task(run_sync)
    return {"status": "sync gestartet"}
