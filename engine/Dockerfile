# Audit engine (PRD 5.1). Listens on 7002 on the internal network.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin tesseract-ocr-mar \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY audit_engine ./audit_engine
COPY sql ./sql
RUN uv sync --frozen --no-dev

ENV ENGINE_PORT=7002 \
    ENGINE_AUDIT_DB=postgresql+psycopg://engine_audit:engine_audit@db:5432/elev05 \
    ENGINE_BUSINESS_SOURCE=postgresql+psycopg://engine_audit:engine_audit@db:5432/elev05 \
    ENGINE_FILES=minio://minio:minio123@minio:9000/files \
    ENGINE_OUTPUT_DIR=/data/outputs \
    LEDGER_URL=http://ledger:7001 \
    OLLAMA_URL=http://ollama:11434 \
    TESSERACT_CMD=/usr/bin/tesseract

EXPOSE 7002
CMD ["uv", "run", "--no-dev", "python", "-m", "audit_engine.api"]
