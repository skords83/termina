"""Sync-Logik.

Phase 1: zwei Funktionen
  - sync_calendar_list() -- holt alle abonnierten Kalender aus Nextcloud
  - sync_events(calendar) -- CTag pruefen, dann nur Events mit neuem ETag holen
"""

# Phase 1:
#   def sync_all() -> None:
#       for calendar in sync_calendar_list():
#           sync_events(calendar)
