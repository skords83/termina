import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api import calendars, events
from app.db.session import create_tables
from app.scheduler import start_scheduler, stop_scheduler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s – %(message)s",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_tables()
    start_scheduler()
    yield
    stop_scheduler()


app = FastAPI(title="Termina", lifespan=lifespan)

app.include_router(calendars.router, prefix="/api")
app.include_router(events.router, prefix="/api")


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/")
def root():
    return {"service": "Termina backend", "docs": "/docs"}
