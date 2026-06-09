"""Background-Scheduler (APScheduler).

Wird in Phase 1 implementiert. Aufgaben:
  - initialer Full-Sync beim Start
  - periodisches CTag/ETag-Polling alle `SYNC_INTERVAL_SECONDS` Sekunden
"""

# Phase 1:
#   from apscheduler.schedulers.asyncio import AsyncIOScheduler
#   scheduler = AsyncIOScheduler()
#   scheduler.add_job(sync_all, "interval", seconds=settings.sync_interval_seconds)
