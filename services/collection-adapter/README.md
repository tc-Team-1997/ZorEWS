# collection-adapter

Implements **T3.4**: Collection auto-case routing + status callback. Lives between `services/regulatory-svc/cases` (case events out) and the bank's Collection module (route in, status callback out).

Default port **8085**.

## Two halves

### 1) Auto-routing (case event → Collection)

Consumes `apex.case.events` from `services/regulatory-svc/cases/.outbox/`. For each `case.created` event the router decides whether to escalate to Collection. The current policy:

* `severity ∈ {high, critical}` → route.
* `severity = medium` AND `loan_id` present → route (default loan accounts always go to Collection per FR-CASE policy).
* otherwise → don't route (analyst handles in-house).

Each routed case gets a single `apex.collection.routes` event written to the local outbox at `.outbox/apex.collection.routes-<date>.ndjson`. Routing is **idempotent on case_id** — replaying the same case events doesn't double-route.

### 2) Status callback (Collection → case)

`POST /collection/callback` accepts the Collection module's outcome report and proxies it to the cases service as a `POST /cases/:case_id/close`.

```json
{ "case_id": "case-501", "status": "cured" | "cured_temp" | "defaulted", "note": "optional" }
```

* `status` is the Collection vocabulary; we map it 1:1 to the cases service's `outcome` field.
* The cases service URL is `APEX_CASES_URL` (e.g. `http://localhost:8083`). Unset → 503.
* Upstream errors (e.g. 409 illegal-transition because the case is already closed) are forwarded with their status code.

## Endpoints

| Method | Path                     | Notes                                       |
|--------|--------------------------|---------------------------------------------|
| POST   | `/collection/callback`   | `{case_id, status, note?}` → close          |
| POST   | `/process`               | Admin trigger: read source, route eligible  |
| GET    | `/healthz`               | liveness                                    |

## Run

```
cd services/collection-adapter
npm install
npm test
APEX_CASES_URL=http://localhost:8083 npm run dev
```

## Future hand-offs

* MSK Kafka consumer behind `CaseEventSource` (replaces NDJSON tail).
* Outbound HTTP/Kafka to the real Collection module behind `CollectionSink`.
