"""App-Konfiguration via .env / Umgebungsvariablen (pydantic-settings).

Akzeptiert NEXTCLOUD_* oder CALDAV_*-Variablennamen (AliasChoices).
Pflichtfelder ohne Default: caldav_url, caldav_username, caldav_password.
api_token hat einen unsicheren Default und sollte in .env gesetzt werden.
"""

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
        populate_by_name=True,
    )

    # CalDAV – akzeptiert CALDAV_* oder NEXTCLOUD_*
    caldav_url: str = Field(
        validation_alias=AliasChoices("CALDAV_URL", "NEXTCLOUD_URL")
    )
    caldav_username: str = Field(
        validation_alias=AliasChoices("CALDAV_USERNAME", "NEXTCLOUD_USERNAME")
    )
    caldav_password: str = Field(
        validation_alias=AliasChoices("CALDAV_PASSWORD", "NEXTCLOUD_APP_PASSWORD", "NEXTCLOUD_PASSWORD")
    )

    # Sync
    sync_interval_seconds: int = 300    # 5 Minuten

    # Datenbank
    database_url: str = "sqlite:///./termina.db"

    # API
    api_token: str = Field(
        default="change-me-in-env",
        validation_alias=AliasChoices("API_TOKEN", "TERMINA_API_TOKEN"),
    )

    # CORS (kommaseparierte Liste)
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:3000"]

    @field_validator("cors_origins", mode="before")
    @classmethod
    def split_cors(cls, v):
        if isinstance(v, str):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v


settings = Settings()  # type: ignore[call-arg]  # Felder kommen aus .env