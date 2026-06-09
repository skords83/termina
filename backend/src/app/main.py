"""FastAPI entry point.

Phase 0: nur Health-Check und Root-Route, damit das Frontend was zum Reden hat.
Phase 1/2: API-Router fuer /calendars und /events haengen wir hier ein.
"""

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Startup/Shutdown-Hooks.

    Hier wird in Phase 1 der Scheduler gestartet (initialer Sync + periodisches Polling).
    """
    # TODO Phase 1: scheduler.start()
    yield
    # TODO Phase 1: scheduler.shutdown()


app = FastAPI(
    title="Termina API",
    version="0.0.1",
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
    return {"name": "Termina API", "version": "0.0.1"}
