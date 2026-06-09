"""SQLAlchemy-Engine und Session.

Models kommen in Phase 1. Diese Datei kann schon stehen, damit die Konfiguration
fuer alles spaetere klar ist.
"""

from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings

# SQLite braucht check_same_thread=False, weil FastAPI Worker-Threads benutzt.
_connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}

engine = create_engine(settings.database_url, connect_args=_connect_args, future=True)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    """Basis-Klasse fuer alle ORM-Modelle."""


def get_db() -> Iterator[Session]:
    """FastAPI-Dependency, die eine Session pro Request liefert."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
