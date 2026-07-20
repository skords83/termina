import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import admin_users, calendars, events, ics_api, sync_api
from app.auth import router as auth_router
from app.auth.service import bootstrap_initial_admin
from app.config import settings
from app.db.session import apply_migrations, create_tables
from app.scheduler import start_scheduler, stop_scheduler

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)s %(name)s – %(message)s",
)
logging.getLogger("caldav").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_tables()
    apply_migrations()
    bootstrap_initial_admin()
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

app.include_router(auth_router.router, prefix="/api")
app.include_router(admin_users.router, prefix="/api")
app.include_router(calendars.router, prefix="/api")
app.include_router(events.router, prefix="/api")
app.include_router(sync_api.router, prefix="/api")
app.include_router(ics_api.router, prefix="/api")


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/")
def root():
    return {"service": "Termina backend", "docs": "/docs"}