import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import calendars, events, sync_api
from app.config import settings
from app.db.session import apply_migrations, create_tables
from app.scheduler import start_scheduler, stop_scheduler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s – %(message)s",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_tables()
    apply_migrations()
    start_scheduler()
    yield
    stop_scheduler()


app = FastAPI(title="Termina", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(calendars.router, prefix="/api")
app.include_router(events.router, prefix="/api")
app.include_router(sync_api.router, prefix="/api")


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/")
def root():
    return {"service": "Termina backend", "docs": "/docs"}