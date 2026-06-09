"""App-Konfiguration via .env / Umgebungsvariablen (pydantic-settings).

Pflichtfelder (kein Default): caldav_url, caldav_username, caldav_password, api_token.
Alles andere hat sinnvolle Defaults.
"""

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # CalDAV
    caldav_url: str                     # z.B. https://nextcloud.example.com/remote.php/dav
    caldav_username: str
    caldav_password: str

    # Sync
    sync_interval_seconds: int = 300    # 5 Minuten

    # Datenbank
    database_url: str = "sqlite:///./termina.db"

    # API
    api_token: str                      # statisches Bearer-Token fuer Phase 2

    # CORS (kommaseparierte Liste)
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:3000"]

    @field_validator("cors_origins", mode="before")
    @classmethod
    def split_cors(cls, v):
        if isinstance(v, str):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v


settings = Settings()  # type: ignore[call-arg]  # Felder kommen aus .env
