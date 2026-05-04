FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# OS deps for xgboost (libgomp).
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Service deps first for layer cache.
COPY services/ai-copilot-svc/requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# Copy the bits we need.
COPY ml /app/ml
COPY services/ai-copilot-svc /app/services/ai-copilot-svc

WORKDIR /app/services/ai-copilot-svc

ENV APEX_REGISTRY_PATH=/app/ml/registry/registry.json \
    APEX_MODEL_NAME=pd_xgboost \
    APEX_LEVEL_LOW_MAX=0.05 \
    APEX_LEVEL_HIGH_MIN=0.20 \
    PYTHONPATH=/app:/app/services/ai-copilot-svc

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
