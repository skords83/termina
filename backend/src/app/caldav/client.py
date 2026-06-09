import caldav

from app.config import settings


def get_caldav_client() -> caldav.DAVClient:
    return caldav.DAVClient(
        url=settings.caldav_url,
        username=settings.caldav_username,
        password=settings.caldav_password,
    )


def get_principal() -> caldav.Principal:
    client = get_caldav_client()
    return client.principal()
