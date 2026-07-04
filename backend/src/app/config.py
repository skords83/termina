from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    caldav_url: str
    caldav_username: str
    caldav_password: str
    sync_interval_seconds: int = 300
    database_url: str = "sqlite:///./termina.db"
    cors_origins: list[str] = ["http://localhost:5173"]
    ics_feeds: list[dict] = []
    calendar_colors: dict[str, str] = {}

    # --- Auth ---
    initial_admin_email: str | None = None
    initial_admin_password: str | None = None
    session_cookie_name: str = "termina_session"
    session_short_ttl_hours: int = 12
    session_remember_ttl_days: int = 30
    cookie_secure: bool = True
    failed_login_max_attempts: int = 5
    lockout_minutes: int = 15

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "env_parse_none_str": "",
    }


settings = Settings()
