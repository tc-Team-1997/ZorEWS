# audit-svc

Immutable audit-log service for ZorEWS (T1.13 / NFR-AUDIT).

## Stack choice — Python + FastAPI

Picked over Node.js because:

1. `hashlib` + `json.dumps(sort_keys=True)` give a single-line, deterministic canonical form — no extra dep.
2. Tight read/write loop benefits from CPython's well-tuned file IO; Pydantic v2 covers schema validation.
3. Polyglot demonstration: auth-svc is Node, audit-svc is Python — proves the platform's IRSA + container model is language-agnostic.

## What it does

- **Subscribes** (in production) to Kafka topic `apex.audit.events`.
- **Hashes** each record into a SHA-256 chain (`prev_hash` + canonical(record without `hash`) → `hash`). Genesis `prev_hash` = 64 zeros.
- **Appends** the record as a single NDJSON line to `./audit-store/audit.ndjson` (env `AUDIT_STORE_PATH`).
- **Mirrors** to S3 in production with Object Lock `COMPLIANCE` retention 7 years (configured in `infra/terraform/30-data/main.tf`). The local file maps 1:1 to the S3 object — same NDJSON, same hash chain.
- **Verifies** the chain via `GET /audit/verify` — walks the file end-to-end, returns the first index where prev_hash or hash break.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/audit/events` | Append one event (also called by the local Kafka stub). |
| `GET`  | `/audit/verify` | Walk the chain; returns OK + count, or BROKEN + first-break-index. |
| `GET`  | `/healthz` | Liveness. |

## Running

```bash
pip install -e '.[dev]'
pytest                                    # tamper-detection tests
uvicorn audit_svc.server:app --port 8081
```

## Hash format

```
record_n.hash = SHA256( record_{n-1}.hash || "|" || canonical(record_n minus 'hash') )
```

`canonical(...)` = `json.dumps(..., sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
