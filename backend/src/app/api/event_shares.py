from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import service
from app.auth.dependencies import get_current_user
from app.caldav.sync import run_sync
from app.caldav.write import CalDAVTimeoutError, create_event
from app.config import settings
from app.db.models import Event, EventOverride, EventShare, EventShareInstanceState, User
from app.db.session import get_db

router = APIRouter(prefix="/event-shares", tags=["event-shares"])


class EventShareCreate(BaseModel):
    source_uid: str
    summary: str
    start: datetime
    end: datetime
    buffer_before_minutes: int = Field(default=0, ge=0)
    buffer_after_minutes: int = Field(default=0, ge=0)


def _naive(dt: datetime) -> datetime:
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


def _series_has_drift(share: EventShare, source: Event) -> bool:
    if source.start is None or source.end is None:
        # Nullable-Spalten: ohne verlaessliche Zeit koennen wir nicht sinnvoll
        # vergleichen -- als gedriftet behandeln statt beim .replace() abzustuerzen.
        return True
    return (
        _naive(share.snapshot_start) != _naive(source.start)
        or _naive(share.snapshot_end) != _naive(source.end)
        or share.snapshot_summary != source.summary
        or (share.snapshot_rrule or None) != (source.rrule or None)
    )


def _share_out(share: EventShare, has_drift: bool) -> dict:
    return {
        "id": share.id,
        "source_uid": share.source_uid,
        "shared_uid": share.shared_uid,
        "target_calendar_id": share.target_calendar_id,
        "snapshot_start": share.snapshot_start.isoformat(),
        "snapshot_end": share.snapshot_end.isoformat(),
        "snapshot_summary": share.snapshot_summary,
        "snapshot_rrule": share.snapshot_rrule,
        "buffer_before_minutes": share.buffer_before_minutes,
        "buffer_after_minutes": share.buffer_after_minutes,
        "has_drift": has_drift,
    }


@router.post("", status_code=201)
def create_share(
    body: EventShareCreate,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    source = db.query(Event).filter(Event.uid == body.source_uid).first()
    if source is None:
        raise HTTPException(status_code=404, detail="Quelltermin nicht gefunden")
    service.ensure_calendar_access(db, user, source.calendar_id)

    target_calendar_id = settings.oma_opa_calendar_id
    if not target_calendar_id:
        raise HTTPException(
            status_code=400,
            detail="Zielkalender 'Oma & Opa' ist nicht konfiguriert (OMA_OPA_CALENDAR_ID)",
        )
    service.ensure_calendar_access(db, user, target_calendar_id)

    try:
        shared_uid = create_event(
            calendar_id=target_calendar_id,
            summary=body.summary,
            start=body.start,
            end=body.end,
            all_day=source.all_day,
            location=None,
            description=None,
            rrule=source.rrule,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except CalDAVTimeoutError as e:
        raise HTTPException(status_code=503, detail=f"CalDAV-Server nicht erreichbar: {e}")

    share = EventShare(
        source_uid=source.uid,
        shared_uid=shared_uid,
        target_calendar_id=target_calendar_id,
        snapshot_start=source.start,
        snapshot_end=source.end,
        snapshot_summary=source.summary,
        snapshot_rrule=source.rrule,
        buffer_before_minutes=body.buffer_before_minutes,
        buffer_after_minutes=body.buffer_after_minutes,
        dismissed=False,
        created_at=datetime.utcnow(),
    )
    db.add(share)
    db.commit()
    db.refresh(share)

    # Fix 2: Fuer bereits vorhandene Overrides (z.B. eine schon verschobene/gestrichene
    # Instanz einer Serie) sofort einen passenden EventShareInstanceState seeden --
    # sonst wertet _instance_has_drift diese Instanz beim allerersten Abruf faelschlich
    # als Drift ("noch nie synchronisiert" + Override vorhanden), obwohl sich seit dem
    # Anlegen der Freigabe nichts geaendert hat.
    existing_overrides = db.query(EventOverride).filter(
        EventOverride.master_uid == source.uid
    ).all()
    for ov in existing_overrides:
        _upsert_instance_state(db, share, source.uid, ov.recurrence_id, dismissed=False)
    if existing_overrides:
        db.commit()

    background.add_task(run_sync)

    return _share_out(share, has_drift=False)


@router.get("")
def list_shares(
    source_uid: str = Query(...),
    recurrence_id: datetime | None = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    source = db.query(Event).filter(Event.uid == source_uid).first()
    if source is None:
        raise HTTPException(status_code=404, detail="Quelltermin nicht gefunden")
    service.ensure_calendar_access(db, user, source.calendar_id)

    shares = db.query(EventShare).filter(EventShare.source_uid == source_uid).all()
    result = []
    for s in shares:
        has_drift = _series_has_drift(s, source)
        if not has_drift and recurrence_id is not None:
            has_drift = _instance_has_drift(db, s, source_uid, recurrence_id)
        result.append(_share_out(s, has_drift))
    return result


@router.post("/{share_id}/sync-snapshot")
def sync_snapshot(
    share_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    share = db.query(EventShare).filter(EventShare.id == share_id).first()
    if share is None:
        raise HTTPException(status_code=404, detail="Freigabe nicht gefunden")
    source = db.query(Event).filter(Event.uid == share.source_uid).first()
    if source is None:
        raise HTTPException(status_code=404, detail="Quelltermin nicht gefunden")
    service.ensure_calendar_access(db, user, source.calendar_id)

    share.snapshot_start = source.start
    share.snapshot_end = source.end
    share.snapshot_summary = source.summary
    share.snapshot_rrule = source.rrule
    share.dismissed = True
    db.commit()
    return _share_out(share, has_drift=False)


def _instance_snapshot_from_source(
    db: Session, source_uid: str, recurrence_id: datetime,
) -> tuple[datetime | None, datetime | None, str | None, bool]:
    """Liest den aktuell wirksamen Zustand einer Instanz (Override oder Master-Werte).

    Rückgabe: (start, end, summary, deleted)
    """
    rid_naive = _naive(recurrence_id)
    override = db.query(EventOverride).filter(
        EventOverride.master_uid == source_uid,
        EventOverride.recurrence_id == rid_naive,
    ).first()
    source = db.query(Event).filter(Event.uid == source_uid).first()
    return _instance_snapshot_preloaded(source, override, rid_naive)


def _instance_snapshot_preloaded(
    source: Event | None, override: EventOverride | None, recurrence_id: datetime,
) -> tuple[datetime | None, datetime | None, str | None, bool]:
    """Wie `_instance_snapshot_from_source`, aber ohne eigene DB-Queries -- Override und
    Source werden vom Aufrufer bereits geladen mitgegeben (Batch-Pfad, siehe Fix 5)."""
    rid_naive = _naive(recurrence_id)
    if override is not None:
        if override.start is None:
            return None, None, None, True  # EXDATE-Sentinel: Instanz gelöscht
        return override.start, override.end, override.summary, False

    if source is None or source.start is None or source.end is None:
        return None, None, None, False
    duration = source.end - source.start
    return rid_naive, rid_naive + duration, source.summary, False


def _instance_has_drift_preloaded(
    share: EventShare,
    source: Event | None,
    recurrence_id: datetime,
    override: EventOverride | None,
    state: EventShareInstanceState | None,
) -> bool:
    """Drift-Berechnung fuer eine Instanz ohne eigene DB-Queries (Batch-Pfad, Fix 5)."""
    rid_naive = _naive(recurrence_id)
    cur_start, cur_end, cur_summary, cur_deleted = _instance_snapshot_preloaded(source, override, rid_naive)

    if state is None:
        # Noch nie synchronisiert: nur Drift, wenn diese Instanz vom Standard-Serienverlauf
        # abweicht (Override/Löschung vorhanden). Reine, unveränderte RRULE-Instanzen sind kein Drift.
        # (cur_deleted impliziert immer override is not None, daher reicht die Existenzpruefung.)
        return override is not None

    return (
        state.snapshot_deleted != cur_deleted
        or state.snapshot_start != cur_start
        or state.snapshot_end != cur_end
        or state.snapshot_summary != cur_summary
    )


def _instance_has_drift(db: Session, share: EventShare, source_uid: str, recurrence_id: datetime) -> bool:
    rid_naive = _naive(recurrence_id)
    override = db.query(EventOverride).filter(
        EventOverride.master_uid == source_uid,
        EventOverride.recurrence_id == rid_naive,
    ).first()
    source = db.query(Event).filter(Event.uid == source_uid).first()
    state = db.query(EventShareInstanceState).filter(
        EventShareInstanceState.share_id == share.id,
        EventShareInstanceState.source_recurrence_id == rid_naive,
    ).first()
    return _instance_has_drift_preloaded(share, source, rid_naive, override, state)


def _upsert_instance_state(
    db: Session, share: EventShare, source_uid: str, recurrence_id: datetime, *, dismissed: bool,
) -> EventShareInstanceState:
    """Legt den EventShareInstanceState einer Instanz an oder aktualisiert ihn, sodass er
    den aktuell wirksamen Zustand (Override oder Serien-Standard) widerspiegelt. Gemeinsame
    Logik fuer `sync_instance_snapshot` (expliziter Nutzer-Sync) und `create_share`
    (Seeding bereits vorhandener Overrides beim Anlegen der Freigabe, Fix 2)."""
    rid_naive = _naive(recurrence_id)
    start, end, summary, deleted = _instance_snapshot_from_source(db, source_uid, rid_naive)

    state = db.query(EventShareInstanceState).filter(
        EventShareInstanceState.share_id == share.id,
        EventShareInstanceState.source_recurrence_id == rid_naive,
    ).first()
    if state is None:
        state = EventShareInstanceState(share_id=share.id, source_recurrence_id=rid_naive)
        db.add(state)

    state.snapshot_start = start
    state.snapshot_end = end
    state.snapshot_summary = summary
    state.snapshot_deleted = deleted
    state.dismissed = dismissed
    state.updated_at = datetime.utcnow()
    return state


class InstanceSync(BaseModel):
    source_recurrence_id: datetime


@router.post("/{share_id}/instances/sync-snapshot")
def sync_instance_snapshot(
    share_id: int,
    body: InstanceSync,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    share = db.query(EventShare).filter(EventShare.id == share_id).first()
    if share is None:
        raise HTTPException(status_code=404, detail="Freigabe nicht gefunden")
    source = db.query(Event).filter(Event.uid == share.source_uid).first()
    if source is None:
        raise HTTPException(status_code=404, detail="Quelltermin nicht gefunden")
    service.ensure_calendar_access(db, user, source.calendar_id)

    rid_naive = _naive(body.source_recurrence_id)
    _upsert_instance_state(db, share, share.source_uid, rid_naive, dismissed=True)
    db.commit()

    return {"share_id": share.id, "source_recurrence_id": rid_naive.isoformat(), "dismissed": True}
