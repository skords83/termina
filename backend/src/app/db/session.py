"""Engine und Session-Factory.

Wird von sync.py (Scheduler-Kontext) und spaeter von den API-Routen verwendet.
create_db_and_tables() beim App-Start aufrufen – idempotent dank checkfirst=True.
"""

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.db.models import Base

engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False},  # noetig fuer SQLite + Threads
    echo=False,
)

SessionLocal: sessionmaker[Session] = sessionmaker(
    bind=engine,
    autocommit=False,
    autoflush=False,
)


def create_db_and_tables() -> None:
    """Erstellt alle Tabellen, falls sie noch nicht existieren."""
    Base.metadata.create_all(bind=engine, checkfirst=True)


def get_session() -> Session:
    """Gibt eine neue Session zurueck. Aufrufer ist verantwortlich fuer .close()."""
    return SessionLocal()
