"""APScheduler-Setup fuer den Hintergrund-Sync.

start() wird im Lifespan-Hook von main.py aufgerufen.
Der erste Sync laeuft sofort (next_run_time=datetime.now()), danach alle
settings.sync_interval_seconds Sekunden.
"""

import logging
from datetime import UTC, datetime

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from app.caldav.sync import run_sync
from app.config import settings

logger = logging.getLogger(__name__)

_scheduler = BackgroundScheduler(timezone="UTC")


def start() -> None:
    """Startet den Scheduler und loest den ersten Sync sofort aus."""
    _scheduler.add_job(
        run_sync,
        trigger=IntervalTrigger(seconds=settings.sync_interval_seconds),
        id="caldav_sync",
        name="CalDAV Sync",
        next_run_time=datetime.now(UTC),  # sofort beim Start
        replace_existing=True,
        misfire_grace_time=30,
    )
    _scheduler.start()
    logger.info(
        "Scheduler gestartet – Sync alle %d Sekunden", settings.sync_interval_seconds
    )


def shutdown() -> None:
    """Faehrt den Scheduler sauber herunter."""
    if _scheduler.running:
        _scheduler.shutdown(wait=False)
        logger.info("Scheduler gestoppt")
