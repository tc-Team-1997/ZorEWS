FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

COPY pyproject.toml ./
RUN pip install --upgrade pip && pip install .

COPY app ./app

EXPOSE 8080

# Non-root for OWASP ASVS.
RUN useradd -u 10001 -m apex
USER apex

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
