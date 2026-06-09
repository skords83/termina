"""GET /events?from=...&to=... - Termine im angegebenen Zeitraum.

Wird in Phase 2 implementiert.
"""

# Phase 2:
#   @router.get("")
#   def list_events(
#       from_: datetime = Query(alias="from"),
#       to: datetime = Query(...),
#       calendar_id: str | None = None,
#       db: Session = Depends(get_db),
#   ) -> list[EventOut]: ...
