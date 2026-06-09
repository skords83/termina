"""Settings, geladen aus Umgebungsvariablen bzw. .env."""

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        case_sensitive=False,
        extra="ignore",
    )

    # --- Nextcloud ---
    nextcloud_url: str = ""
    nextcloud_username: str = ""
    nextcloud_app_password: str = ""

    # --- Backend ---
    sync_interval_seconds: int = 300
    api_token: str = "change-me"
    database_url: str = "sqlite:////data/termina.db"

    # --- CORS ---
    # In Prod auf die echte Frontend-URL eingrenzen.
    cors_origins: list[str] = Field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"]
    )


settings = Settings()
