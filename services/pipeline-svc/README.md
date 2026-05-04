# pipeline-svc

Tiny FastAPI service that stands in for AWS MWAA's REST trigger / status
surface during local prototype development.

## Endpoints

| Method | Path                          | Purpose                                |
|--------|-------------------------------|----------------------------------------|
| GET    | `/health`                     | Liveness probe.                        |
| POST   | `/pipeline/run/{dag_id}`      | Trigger one of the known DAGs (stub).  |
| GET    | `/pipeline/runs?limit=20`     | List recent simulated runs.            |

`dag_id` must be one of `cbs_ingestion`, `bureau_sync`, `feature_build`.

## Run locally

```bash
cd services/pipeline-svc
pip install -e '.[dev]'
uvicorn app.main:app --reload --port 8080
```

## Test

```bash
pytest -q
```

## Docker

```bash
docker build -t apex-ews/pipeline-svc:dev .
docker run --rm -p 8080:8080 apex-ews/pipeline-svc:dev
```

## Hand-off

- agent-ui consumes `/pipeline/runs` from the Scenario Simulation screen.
- agent-integration replaces the in-memory ring buffer with MWAA's real
  REST endpoint behind API Gateway in T3.7.
