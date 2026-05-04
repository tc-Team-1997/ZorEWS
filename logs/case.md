# logs/case.md — case agent

> Append entries chronologically. Each entry: task id, files touched, decisions, hand-offs, blockers.

## 2026-04-26 — Initialised

- Log file created. Awaiting first task.

## 2026-04-27 — T3.5 case state machine shipped

- **Files:** `services/regulatory-svc/cases/{package.json,tsconfig.json,README.md}`, `src/{types,case_id,state_machine,store,producer,service,server}.ts`, `__tests__/{state_machine,service,server}.test.ts`.
- **Surface:** `POST /cases` (idempotent on alert_id), `GET /cases?state=&assignee=&customer_id=&page=&pageSize=`, `GET/POST /cases/:id/{assign,actions,monitor,close}`.
- **State machine (FR-CASE-1):** open → assigned → in_action → monitored → closed; logAction during monitored re-engages to in_action; close allowed from any non-closed state. Illegal transitions return HTTP 409 with `current_state` + `attempted` in the body.
- **Identity (FR-CASE-2):** `case_id` is a deterministic UUIDv5-style hash of `apex.case.v1|<alert_id>|<customer_id>` (mirrors `alerts/deterministicAlertId`). Same alert routed twice yields same case.
- **Action log (FR-CASE-3):** `kind ∈ {call, visit, sms, email, note}`, `officer_id` required, optional `outcome_note`, optional `gps {lat, lng, accuracy_m?}`. GPS validated as numeric.
- **Outcome (FR-CASE-4):** `outcome ∈ {cured, cured_temp, defaulted}` enforced at close.
- **Storage:** in-memory + NDJSON snapshot at `.store/cases.ndjson` (replays on construction). Survives restart (verified by test).
- **Producer:** `OutboxCaseProducer` writes `apex.case.events` NDJSON to `.outbox/`. Each transition emits a typed event (`case.created` | `case.assigned` | `case.action_logged` | `case.monitored` | `case.closed`) with `prior_state`, `new_state`, and a free-form payload.
- **Tests:** 26 jest tests across the three files. All green. `tsc -p .` clean.
- **Hand-offs:**
  - `agent-integration` — wire a Kafka producer at `src/kafka_producer.ts` for `apex.case.events`; T3.4 (Collection auto-routing) consumes the topic, T3.7 includes case endpoints in the public REST API v1.
  - `agent-ui` — T3.6 (Case View) can drive against the local `npm run dev` (default port 8083); the case payload + action log are the UI's source of truth.
  - `agent-rule` / `agent-alert` — `POST /cases` accepts `AlertSummary` projected from the canonical `apex.regulatory.events` envelope (`alert_id`, `customer_id`, `loan_id`, `severity`, `rule_id`, `raised_at`, `reason_summary`).
