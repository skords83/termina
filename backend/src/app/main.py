"""FastAPI entry point.

Phase 0: Health-Check und Root-Route.
Phase 1: Lifespan-Hooks starten den Scheduler (DB-Init + CalDAV-Sync).
Phase 2: API-Router fuer /calendars und /events werden hier eingehaengt.
"""

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db.session import create_db_and_tables
from app import scheduler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Startup/Shutdown-Hooks."""
    logger.info("Termina startet – DB-Tabellen anlegen")
    create_db_and_tables()

    logger.info("Scheduler starten")
    scheduler.start()

    yield

    logger.info("Scheduler stoppen")
    scheduler.shutdown()


app = FastAPI(
    title="Termina API",
    version="0.1.0",
    description="Backend fuer den selbst gehosteten Termina-Kalender.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz", tags=["meta"])
def healthz() -> dict[str, str]:
    """Lightweight liveness probe."""
    return {"status": "ok"}


@app.get("/", tags=["meta"])
def root() -> dict[str, str]:
    return {"name": "Termina API", "version": "0.1.0"}
