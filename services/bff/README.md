# bff — backend-for-frontend

Implements **T3.10**: maps canonical `apex.regulatory.events.v2` alert envelopes to the UI's `/api/alerts` list-row shape so the SPA at `web/` can read events without depending on Kafka topology or service-to-service joins.

## Mapping (the heart of T3.10)

| canonical (v2)        | list-row (UI)                       | transform                                     |
|-----------------------|-------------------------------------|-----------------------------------------------|
| `alert_id`            | `id`                                | rename                                        |
| `severity`            | `severity`                          | `'CRITICAL' → 'critical'` (lowercase)         |
| `customer_id`         | `customer.id`                       | rename                                        |
| —                     | `customer.name`                     | join from customer lookup (fallback to id)    |
| `rule_id`             | `rule.id`                           | rename                                        |
| —                     | `rule.name`                         | join from rule lookup (fallback to id)        |
| `indicators_fired`    | `indicators`                        | rename                                        |
| `raised_at`           | `created_at`                        | rename                                        |
| `raised_at`           | `age_min`                           | computed: `floor((now - raised_at) / 60000)`  |

Pure function `mapAlertEvent(canonical, lookups, now?)` lives in `src/mapping.ts`. It takes no IO; the server wraps it with the source (NDJSON outbox reader) and the lookups (in-memory tables matching the UI mock seeds).

## Source

For the prototype, `src/source.ts` reads `services/regulatory-svc/alerts/.outbox/apex.regulatory.events-*.ndjson` (one event per line). In production, agent-integration replaces this with a Kafka consumer.

## Endpoints

### `/api/*` — internal BFF for the SPA

| Method | Path                                  | Notes                                  |
|--------|---------------------------------------|----------------------------------------|
| GET    | `/api/alerts?severity=&assignee=`     | list-row `{ items, total }` (T3.10)    |
| GET    | `/healthz`                            | liveness                               |

The response shape matches `web/src/lib/api.ts:AlertListResponse` exactly so the UI can switch from MSW to this BFF by setting `VITE_API_BASE_URL`.

### `/v1/*` — public REST API v1 (T3.7)

| Method | Path                                  | Notes                                                                  |
|--------|---------------------------------------|------------------------------------------------------------------------|
| GET    | `/v1/alerts?severity=&assignee=`      | same shape as `/api/alerts`                                            |
| POST   | `/v1/ews/evaluate`                    | body `{ customer_id?, features? }` → `ScoreResponse`                   |
| GET    | `/v1/risk-profile/:customer_id`       | full profile (PD + level + balance trend + SHAP top-5 + model version) |
| POST   | `/v1/action`                          | body `{ case_id, kind, officer_id, outcome_note?, gps? }` → `Case`     |

`/v1/action` proxies to `services/regulatory-svc/cases` at `APEX_CASES_URL` (e.g. `http://localhost:8083`). When unset the endpoint returns 503 — set the env var or run the cases service before calling it.

`/v1/ews/evaluate` and `/v1/risk-profile/:customer_id` are stub-backed in this prototype; the production wiring forwards to `services/ai-copilot-svc /score` and a customer-master read.

## Run

```
cd services/bff
npm install
npm test
npm run dev   # listens on :8084 by default
```
