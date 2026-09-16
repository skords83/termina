FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.12.14 /uv /uvx /bin/
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY src/ src/
# Outside /app so the development source mount cannot hide dependencies.
ENV UV_PROJECT_ENVIRONMENT=/opt/venv
RUN uv sync --locked --no-dev --no-editable
ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONPATH=/app/src
ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
