FROM python:3.11-slim AS build
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir .

FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app
RUN groupadd -g 10001 app && useradd -u 10001 -g app -m app
COPY --from=build /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=build /usr/local/bin /usr/local/bin
COPY --chown=app:app src ./src
USER app
EXPOSE 8081
ENV AUDIT_STORE_PATH=/var/audit/audit.ndjson
CMD ["uvicorn", "audit_svc.server:app", "--host", "0.0.0.0", "--port", "8081"]
