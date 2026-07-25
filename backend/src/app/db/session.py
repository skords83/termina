import logging

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.db.models import Base

logger = logging.getLogger(__name__)

engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False},  # SQLite only
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Jede Zeile: (index_name, DDL-Statement)
# IF NOT EXISTS macht alle Statements idempotent — sicher bei jedem Start.
_MIGRATIONS: list[tuple[str, str]] = [
    (
        "ix_events_calendar_start_end",
        "CREATE INDEX IF NOT EXISTS ix_events_calendar_start_end"
        " ON events(calendar_id, start, end)",
    ),
    (
        "ix_events_start",
        "CREATE INDEX IF NOT EXISTS ix_events_start ON events(start)",
    ),
]

# SQLite kennt kein "ADD COLUMN IF NOT EXISTS" — hier per PRAGMA geprüft statt
# über die obige rein deklarative Liste.
_COLUMN_MIGRATIONS: list[tuple[str, str, str]] = [
    ("events", "birth_year", "ALTER TABLE events ADD COLUMN birth_year INTEGER"),
]


def create_tables() -> None:
    Base.metadata.create_all(bind=engine)


def apply_migrations() -> None:
    """Idempotente Schema-Migrationen für bestehende Datenbanken.

    create_all() legt Indizes nur beim ersten Anlegen einer Tabelle an.
    Diese Funktion stellt sicher, dass Indizes auch in vorhandenen DBs
    vorhanden sind. IF NOT EXISTS macht jeden Lauf sicher.
    """
    with engine.connect() as conn:
        for name, ddl in _MIGRATIONS:
            conn.execute(text(ddl))
            logger.debug("Migration angewendet: %s", name)

        for table, column, ddl in _COLUMN_MIGRATIONS:
            existing = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}
            if column not in existing:
                conn.execute(text(ddl))
                logger.info("Spalte hinzugefügt: %s.%s", table, column)

        conn.commit()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
