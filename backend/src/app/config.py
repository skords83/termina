from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    caldav_url: str
    caldav_username: str
    caldav_password: str
    sync_interval_seconds: int = 300
    api_token: str
    database_url: str = "sqlite:///./termina.db"
    cors_origins: list[str] = ["http://localhost:5173"]

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "env_parse_none_str": "",
    }


settings = Settings()
