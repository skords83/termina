from fastapi import Header, HTTPException, status

from app.config import settings


def require_token(authorization: str | None = Header(default=None)) -> None:
    if authorization != f"Bearer {settings.api_token}":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing token",
            headers={"WWW-Authenticate": "Bearer"},
        )
