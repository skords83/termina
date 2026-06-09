FROM python:3.12-slim

WORKDIR /app

# System-Deps fuer caldav/lxml
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libxml2-dev \
        libxslt-dev \
    && rm -rf /var/lib/apt/lists/*

# Python-Deps zuerst (Layer-Caching)
COPY pyproject.toml ./
COPY src/ ./src/
RUN pip install --no-cache-dir -e .[dev]

EXPOSE 8000

# Im Compose ueberschrieben mit --reload fuer Dev
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--app-dir", "src"]
