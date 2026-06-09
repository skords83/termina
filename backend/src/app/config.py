from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    caldav_url: str
    caldav_username: str
    caldav_password: str
    sync_interval_seconds: int = 300
    api_token: str
    database_url: str = "sqlite:///./termina.db"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
