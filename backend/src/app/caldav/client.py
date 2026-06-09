"""CalDAV-Client-Wrapper.

Phase 1: duenne Schicht ueber der `caldav`-Lib, die mit unseren Settings verbindet
und Calendar-Objekte mit Helfern fuer CTag/ETag liefert.
"""

# Phase 1:
#   import caldav
#   def get_principal() -> caldav.Principal:
#       client = caldav.DAVClient(
#           url=settings.nextcloud_url,
#           username=settings.nextcloud_username,
#           password=settings.nextcloud_app_password,
#       )
#       return client.principal()
