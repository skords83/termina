import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from app.caldav.sync import run_sync
from app.config import settings

logger = logging.getLogger(__name__)

_scheduler = BackgroundScheduler()


def start_scheduler() -> None:
    _scheduler.add_job(
        run_sync,
        trigger=IntervalTrigger(seconds=settings.sync_interval_seconds),
        id="caldav_sync",
        replace_existing=True,
        next_run_time=None,  # overridden below to run immediately
    )
    _scheduler.start()
    logger.info(
        "Scheduler started. Sync interval: %ds", settings.sync_interval_seconds
    )
    # Trigger an immediate first sync in a background thread
    _scheduler.add_job(run_sync, id="caldav_sync_immediate", replace_existing=True)


def stop_scheduler() -> None:
    if _scheduler.running:
        _scheduler.shutdown(wait=False)
        logger.info("Scheduler stopped.")
