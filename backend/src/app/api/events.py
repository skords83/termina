from __future__ import annotations

import logging
from datetime import datetime, timedelta, date as date_cls
from typing import Optional, Literal
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

_BERLIN = ZoneInfo("Europe/Berlin")


def _dt_to_iso(dt: datetime | None, all_day: bool) -> str | None:
    """Serialisiert ein DB-Datetime als timezone-aware ISO-String.

    All-Day: nur Datum ("YYYY-MM-DD") — kein Uhrzeit-Anteil.
    Timed: Berlin-Offset anfügen ("+02:00"/"+01:00"), damit der Client
    die Zeit korrekt anzeigt, unabhängig von seiner lokalen Timezone.
    """
    if dt is None:
        return None
    if all_day:
        return dt.strftime("%Y-%m-%d")
    return dt.replace(tzinfo=_BERLIN).isoformat()

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import service
from app.auth.dependencies import get_current_user
from app.caldav.write import (
    create_event,
    update_event,
    delete_event,
    delete_occurrence,
    move_event,
    ConflictError,
    CalDAVTimeoutError,
)
from app.caldav.sync import run_sync
from app.db.models import Event, EventOverride, User
from app.db.session import get_db

router = APIRouter()


# ── Pydantic-Schemas ──────────────────────────────────────────────────────────

def _to_dt(v: datetime | date_cls) -> datetime:
    """Normalisiert date → datetime(midnight). datetime bleibt unverändert."""
    if isinstance(v, datetime):
        return v
    return datetime(v.year, v.month, v.day, 0, 0, 0)


class EventCreate(BaseModel):
    calendar_id: str
    summary: str
    start: datetime | date_cls
    end: datetime | date_cls
    all_day: bool = False
    location: str | None = None
    description: str | None = None
    rrule: str | None = None


class EventUpdate(BaseModel):
    etag: str | None = None
    summary: str
    start: datetime | date_cls
    end: datetime | date_cls
    all_day: bool = False
    location: str | None = None
    description: str | None = None
    rrule: str | None = None
    # Bei Serien-Edit mit scope="single": recurrence_id der zu ändernden Instanz.
    # Das Backend legt dann einen EventOverride an statt den Master zu ändern.
    recurrence_id: datetime | None = None


class EventMove(BaseModel):
    mode: Literal["single", "future", "all"]
    etag: str | None = None
    original_start: datetime
    new_start: datetime
    new_end: datetime
    recurrence_id: datetime | None = None


# ── RRULE-Expansion mit Override-Anwendung ────────────────────────────────────

def expand_rrule_event(
    event: Event,
    from_: datetime,
    to: datetime,
    overrides: dict[str, EventOverride] | None = None,
) -> list[dict]:
    overrides = overrides or {}

    try:
        from dateutil.rrule import rrulestr

        master_start: datetime = event.start
        master_end: datetime = event.end if event.end is not None else master_start + timedelta(hours=1)
        duration: timedelta = master_end - master_start

        rrule_str = event.rrule
        if "DTSTART" not in rrule_str:
            dtstart_str = master_start.strftime("DTSTART:%Y%m%dT%H%M%S\n")
            rrule_str = dtstart_str + rrule_str

        rule = rrulestr(rrule_str, ignoretz=True)
        instances = rule.between(
            from_ - timedelta(days=1),
            to + timedelta(days=1),
            inc=True,
        )

        result = []
        for inst in instances:
            inst_key = inst.isoformat()
            override = overrides.get(inst_key)

            if override is not None:
                ov_start = override.start
                ov_end = override.end if override.end is not None else (
                    ov_start + duration if ov_start is not None else None
                )
                if ov_start is None:
                    continue
                if ov_start >= to or (ov_end is not None and ov_end <= from_):
                    continue

                result.append({
                    "uid": event.uid,
                    "calendar_id": event.calendar_id,
                    "summary": override.summary or event.summary,
                    "start": _dt_to_iso(ov_start, event.all_day),
                    "end": _dt_to_iso(ov_end, event.all_day),
                    "all_day": event.all_day,
                    "location": override.location if override.location is not None else event.location,
                    "etag": event.etag,
                    "description": override.description if override.description is not None else event.description,
                    "is_recurring": True,
                    "recurrence_id": inst.isoformat(),
                    "rrule": event.rrule,
                })
            else:
                inst_start: datetime = inst
                inst_end: datetime = inst + duration
                if inst_start >= to or inst_end <= from_:
                    continue

                result.append({
                    "uid": event.uid,
                    "calendar_id": event.calendar_id,
                    "summary": event.summary,
                    "start": _dt_to_iso(inst_start, event.all_day),
                    "end": _dt_to_iso(inst_end, event.all_day),
                    "all_day": event.all_day,
                    "location": event.location,
                    "etag": event.etag,
                    "description": event.description,
                    "is_recurring": True,
                    "recurrence_id": inst.isoformat(),
                    "rrule": event.rrule,
                })

        return result

    except Exception as exc:
        logger.warning(
            "RRULE-Expansion fehlgeschlagen für Event %s (%r): %s — liefere Master-Event als Fallback",
            event.uid,
            event.rrule,
            exc,
        )
        if event.start is not None and event.start < to and (event.end is None or event.end > from_):
            return [{
                "uid": event.uid,
                "calendar_id": event.calendar_id,
                "summary": event.summary,
                "start": _dt_to_iso(event.start, event.all_day),
                "end": _dt_to_iso(event.end, event.all_day),
                "all_day": event.all_day,
                "location": event.location,
                "etag": event.etag,
                "description": event.description,
                "is_recurring": True,
                "recurrence_id": event.start.isoformat() if event.start else None,
                "rrule": event.rrule,
            }]
        return []


# ── Helpers ──────────────────────────────────────────────────────────────────

def _strip_rrule_str(rrule_str: str, keys_to_remove: set[str]) -> str:
    """Entfernt bestimmte Keys (z.B. UNTIL, COUNT) aus einem RRULE-String."""
    upper = {k.upper() for k in keys_to_remove}
    parts = []
    for p in rrule_str.split(";"):
        if "=" in p:
            key = p.split("=", 1)[0].upper()
            if key in upper:
                continue
        parts.append(p)
    return ";".join(parts)


# ── GET ───────────────────────────────────────────────────────────────────────

@router.get("/events")
def get_events(
    from_: datetime = Query(alias="from"),
    to: datetime = Query(),
    calendar_id: Optional[str] = Query(default=None),
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

    non_rrule = (
        q.filter(Event.rrule.is_(None), Event.start < to, Event.end > from_)
        .all()
    )
    rrule_events = q.filter(
        Event.rrule.isnot(None),
        Event.start < to,  # Events die nach dem Fenster starten, haben keine Instanzen darin
    ).all()

    result = []

    for e in non_rrule:
        result.append({
            "uid": e.uid,
            "calendar_id": e.calendar_id,
            "summary": e.summary,
            "start": _dt_to_iso(e.start, e.all_day),
            "end": _dt_to_iso(e.end, e.all_day),
            "all_day": e.all_day,
            "location": e.location,
            "etag": e.etag,
            "description": e.description,
            "is_recurring": False,
            "recurrence_id": None,
            "rrule": None,
        })

    overrides_by_uid: dict[str, dict[str, EventOverride]] = {}
    if rrule_events:
        uids = [e.uid for e in rrule_events]
        all_overrides = (
            db.query(EventOverride)
            .filter(EventOverride.master_uid.in_(uids))
            .all()
        )
        for ov in all_overrides:
            if ov.recurrence_id is None:
                continue
            overrides_by_uid.setdefault(ov.master_uid, {})[ov.recurrence_id.isoformat()] = ov

    for e in rrule_events:
        result.extend(expand_rrule_event(e, from_, to, overrides_by_uid.get(e.uid, {})))

    return result


# ── POST: Erstellen ───────────────────────────────────────────────────────────

@router.post("/events", status_code=201)
def post_event(
    body: EventCreate,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    service.ensure_calendar_access(db, user, body.calendar_id)
    try:
        uid = create_event(
            calendar_id=body.calendar_id,
            summary=body.summary,
            start=_to_dt(body.start),
            end=_to_dt(body.end),
            all_day=body.all_day,
            location=body.location,
            description=body.description,
            rrule=body.rrule,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except CalDAVTimeoutError as e:
        raise HTTPException(status_code=503, detail=f"CalDAV-Server nicht erreichbar: {e}")

    background.add_task(run_sync)
    return {"uid": uid}


# ── PUT: Bearbeiten ───────────────────────────────────────────────────────────

@router.put("/events/{uid}")
def put_event(
    uid: str,
    body: EventUpdate,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    event = db.query(Event).filter(Event.uid == uid).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event nicht gefunden")
    service.ensure_calendar_access(db, user, event.calendar_id)

    start_dt = _to_dt(body.start)
    end_dt = _to_dt(body.end)

    rid_naive = body.recurrence_id.replace(tzinfo=None) if body.recurrence_id else None

    # ── Scope: Nur diese Instanz ──────────────────────────────────────────────
    if rid_naive is not None:
        existing_ov = (
            db.query(EventOverride)
            .filter(
                EventOverride.master_uid == uid,
                EventOverride.recurrence_id == rid_naive,
            )
            .first()
        )
        start_naive = start_dt.replace(tzinfo=None)
        end_naive = end_dt.replace(tzinfo=None)

        if existing_ov is not None:
            existing_ov.summary = body.summary
            existing_ov.start = start_naive
            existing_ov.end = end_naive
            existing_ov.location = body.location
            existing_ov.description = body.description
        else:
            db.add(EventOverride(
                master_uid=uid,
                recurrence_id=rid_naive,
                summary=body.summary,
                start=start_naive,
                end=end_naive,
                location=body.location,
                description=body.description,
            ))
        db.commit()

        try:
            update_event(
                calendar_id=event.calendar_id,
                uid=uid,
                etag=body.etag,
                summary=body.summary,
                start=start_dt,
                end=end_dt,
                all_day=body.all_day,
                location=body.location,
                description=body.description,
                rrule=event.rrule,
                recurrence_id=body.recurrence_id,
            )
        except ConflictError:
            raise HTTPException(status_code=409, detail="Extern geändert – bitte neu laden")
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except CalDAVTimeoutError as e:
            raise HTTPException(status_code=503, detail=f"CalDAV-Server nicht erreichbar: {e}")

        background.add_task(run_sync)
        return {"uid": uid}

    # ── Scope: Alle Termine der Serie (oder normaler Termin) ──────────────────
    try:
        update_event(
            calendar_id=event.calendar_id,
            uid=uid,
            etag=body.etag,
            summary=body.summary,
            start=start_dt,
            end=end_dt,
            all_day=body.all_day,
            location=body.location,
            description=body.description,
            rrule=body.rrule,
        )
    except ConflictError:
        raise HTTPException(status_code=409, detail="Extern geändert – bitte neu laden")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except CalDAVTimeoutError as e:
        raise HTTPException(status_code=503, detail=f"CalDAV-Server nicht erreichbar: {e}")

    background.add_task(run_sync)
    return {"uid": uid}


# ── POST /move: Verschieben (DnD) ─────────────────────────────────────────────

@router.post("/events/{uid}/move")
def post_move(
    uid: str,
    body: EventMove,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    event = db.query(Event).filter(Event.uid == uid).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event nicht gefunden")
    service.ensure_calendar_access(db, user, event.calendar_id)

    if body.mode in ("single", "future") and body.recurrence_id is None:
        raise HTTPException(
            status_code=400,
            detail=f"recurrence_id ist für mode='{body.mode}' erforderlich",
        )

    if body.mode in ("single", "future") and not event.rrule:
        raise HTTPException(
            status_code=400,
            detail=f"mode='{body.mode}' nur für rekurrente Events erlaubt",
        )

    try:
        result = move_event(
            mode=body.mode,
            calendar_id=event.calendar_id,
            uid=uid,
            etag=body.etag,
            original_start=body.original_start,
            new_start=body.new_start,
            new_end=body.new_end,
            all_day=event.all_day,
            recurrence_id=body.recurrence_id,
        )
    except ConflictError:
        raise HTTPException(status_code=409, detail="Extern geändert – bitte neu laden")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except CalDAVTimeoutError as e:
        raise HTTPException(status_code=503, detail=f"CalDAV-Server nicht erreichbar: {e}")

    # Lokale DB sofort aktualisieren
    if body.mode == "all":
        delta = body.new_start.replace(tzinfo=None) - body.original_start.replace(tzinfo=None)
        if event.start is not None:
            event.start = event.start + delta
        if event.end is not None:
            event.end = event.end + delta
        for ov in db.query(EventOverride).filter(EventOverride.master_uid == uid).all():
            if ov.recurrence_id is not None:
                ov.recurrence_id = ov.recurrence_id + delta
            if ov.start is not None:
                ov.start = ov.start + delta
            if ov.end is not None:
                ov.end = ov.end + delta
        db.commit()

    elif body.mode == "single":
        rid_naive = body.recurrence_id.replace(tzinfo=None) if body.recurrence_id else None
        if rid_naive is not None:
            existing_ov = (
                db.query(EventOverride)
                .filter(
                    EventOverride.master_uid == uid,
                    EventOverride.recurrence_id == rid_naive,
                )
                .first()
            )
            new_start_naive = body.new_start.replace(tzinfo=None)
            new_end_naive = body.new_end.replace(tzinfo=None)
            if existing_ov is not None:
                existing_ov.start = new_start_naive
                existing_ov.end = new_end_naive
            else:
                db.add(EventOverride(
                    master_uid=uid,
                    recurrence_id=rid_naive,
                    start=new_start_naive,
                    end=new_end_naive,
                ))
            db.commit()

    elif body.mode == "future":
        rid_naive = body.recurrence_id.replace(tzinfo=None) if body.recurrence_id else None
        new_start_naive = body.new_start.replace(tzinfo=None)
        new_end_naive = body.new_end.replace(tzinfo=None)

        if rid_naive is not None and event.rrule:
            until_dt = rid_naive - timedelta(seconds=1)
            until_str = until_dt.strftime("%Y%m%dT%H%M%S")
            new_master_rrule = _strip_rrule_str(event.rrule, {"UNTIL", "COUNT"})
            event.rrule = f"{new_master_rrule};UNTIL={until_str}" if new_master_rrule else f"UNTIL={until_str}"

            db.query(EventOverride).filter(
                EventOverride.master_uid == uid,
                EventOverride.recurrence_id >= rid_naive,
            ).delete(synchronize_session=False)

        if "new_uid" in result and result["new_uid"]:
            fresh_rrule = _strip_rrule_str(event.rrule, {"UNTIL", "COUNT"}) if event.rrule else None
            db.add(Event(
                uid=result["new_uid"],
                calendar_id=event.calendar_id,
                etag=None,
                summary=event.summary,
                start=new_start_naive,
                end=new_end_naive,
                all_day=event.all_day,
                rrule=new_master_rrule if (rid_naive is not None and event.rrule) else fresh_rrule,
                location=event.location,
                description=event.description,
                raw_ical=None,
            ))

        db.commit()

    background.add_task(run_sync)

    response = {"uid": uid}
    if "new_uid" in result:
        response["new_uid"] = result["new_uid"]
    return response


# ── DELETE: Löschen ───────────────────────────────────────────────────────────

@router.delete("/events/{uid}", status_code=204)
def delete_event_endpoint(
    uid: str,
    background: BackgroundTasks,
    etag: str | None = Query(None),
    recurrence_id: str | None = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    event = db.query(Event).filter(Event.uid == uid).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event nicht gefunden")
    service.ensure_calendar_access(db, user, event.calendar_id)

    # Einzelne Instanz einer Serie löschen (EXDATE)
    if recurrence_id is not None:
        try:
            from datetime import datetime as dt_cls
            rid_dt = dt_cls.fromisoformat(recurrence_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Ungültige recurrence_id")

        try:
            delete_occurrence(
                calendar_id=event.calendar_id,
                uid=uid,
                etag=etag,
                recurrence_id=rid_dt,
                all_day=event.all_day,
            )
        except ConflictError:
            raise HTTPException(status_code=409, detail="Extern geändert – bitte neu laden")
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e))
        except CalDAVTimeoutError as e:
            raise HTTPException(status_code=503, detail=f"CalDAV-Server nicht erreichbar: {e}")

        # Vorhandenen Override für diese Instanz löschen und neuen mit start=None anlegen
        rid_naive = rid_dt.replace(tzinfo=None)
        db.query(EventOverride).filter(
            EventOverride.master_uid == uid,
            EventOverride.recurrence_id == rid_naive,
        ).delete(synchronize_session=False)
        db.add(EventOverride(
            master_uid=uid,
            recurrence_id=rid_naive,
            start=None,
            end=None,
        ))
        db.commit()
        background.add_task(run_sync)
        return

    # Ganzes Event löschen
    try:
        delete_event(
            calendar_id=event.calendar_id,
            uid=uid,
            etag=etag,
        )
    except ConflictError:
        raise HTTPException(status_code=409, detail="Extern geändert – bitte neu laden")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except CalDAVTimeoutError as e:
        raise HTTPException(status_code=503, detail=f"CalDAV-Server nicht erreichbar: {e}")

    db.query(EventOverride).filter(EventOverride.master_uid == uid).delete(synchronize_session=False)
    db.delete(event)
    db.commit()