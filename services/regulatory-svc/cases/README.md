# regulatory-svc/cases

Case management for the ZorEWS. Implements **T3.5** (case state machine + assignment + action log) and the prototype hand-off to Collection (consumes `apex.case.events`).

## Lifecycle (FR-CASE-1)

```
[alert] --create--> open --assign--> assigned --logAction--> in_action --monitor--> monitored --close--> closed
                                       |                         |                      |
                                       +---------- close --------+----------------------+
```

Allowed transitions are enforced by `src/state_machine.ts`. Illegal transitions return HTTP 409 (with the current state in the body).

## Identity (FR-CASE-2)

`case_id` is a deterministic UUIDv5-style hash of `apex.case.v1|<alert_id>|<customer_id>`, so the same alert routed twice produces the same case (idempotent), and Collection sees the same id as EWS.

## Action log (FR-CASE-3)

`POST /cases/:id/actions` accepts:

```json
{ "kind": "call|visit|sms|email|note", "officer_id": "...", "outcome_note": "...",
  "gps": { "lat": -1.29, "lng": 36.82, "accuracy_m": 8 } }
```

GPS is optional and only populated by mobile field officers (FR-UI-4).

## Outcome (FR-CASE-4)

`POST /cases/:id/close` requires `outcome` ∈ `{ "cured", "cured_temp", "defaulted" }`.

## Storage

In-memory + NDJSON outbox at `.outbox/apex.case.events-<date>.ndjson`, mirroring the `alerts/` SmartQueue pattern. Real Kafka producer wiring is left as an `agent-integration` TODO (see `producer.ts`).

## Endpoints

| Method | Path                       | Notes                                     |
|--------|----------------------------|-------------------------------------------|
| POST   | `/cases`                   | create from alert (idempotent on alert_id)|
| GET    | `/cases?state=&assignee=&customer_id=&page=&pageSize=` | list                |
| GET    | `/cases/:id`               | read one                                  |
| POST   | `/cases/:id/assign`        | `{ user_id }`                             |
| POST   | `/cases/:id/actions`       | append action; auto-promotes to in_action |
| POST   | `/cases/:id/monitor`       | move in_action -> monitored               |
| POST   | `/cases/:id/close`         | `{ outcome, note? }`                      |
| GET    | `/healthz`                 | liveness                                  |

## Run

```
cd services/regulatory-svc/cases
npm install
npm test
npm run dev   # or `npm run build && npm start`
```
