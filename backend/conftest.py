"""Root-Conftest: Setzt Pflicht-Umgebungsvariablen bevor irgendein Modul
importiert wird (Settings() wird beim Import von app.config instantiiert)."""
import os

os.environ.setdefault("CALDAV_URL", "https://nextcloud.test/remote.php/dav")
os.environ.setdefault("CALDAV_USERNAME", "testuser")
os.environ.setdefault("CALDAV_PASSWORD", "testpassword")
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("COOKIE_SECURE", "false")
