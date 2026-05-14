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

## 2026-05-14 — T6 M9.5 — Case SLA breach detection

### Tasks ticked
- T6 sub-phase M9.5 — case SLA breach detection. T6 sub-phase tally 101 → 102.

### Files touched
- `services/bff/src/case_sla_breach.ts` (new) — pure `detectCaseSlaBreaches(events, now, sla_by_state?)` returning `CaseSlaSummary` with `total_cases_observed`, `open_cases`, `closed_cases`, `breach_count`, `breach_rate`, worst-first `breaches[]` capped at 50, per-state `{open, breached}` counts. `DEFAULT_SLA_HOURS_BY_STATE` mirrors M9.1 InvestigationStatus (`triage:4`, `gathering_evidence:24`, `awaiting_response:72`, `review:24`, `decision:12`, `closed:null`). State reconstruction walks events in sequence_no order; `opened` seeds initial state (from `payload.initial_state`, defaults to `triage`); `state_change` uses `payload.to`; `closed` drops the case out of the open pool.
- `services/bff/__tests__/case_sla_breach.test.ts` (new) — 18 jest tests: 14 unit (empty input, cases without `opened` skipped, `opened` with/without initial_state, state_change transitions, closed-event drops, shuffled-sequence robustness, breach detection + overdue computation, worst-first ordering, no-SLA states tracked but never breached, custom sla map override, null SLA suppresses breaches, BREACH_LIST_CAP capping, default tier values) + 4 route (200 empty, 200 with breach, 403 wrong role, cross-tenant isolation).
- `services/bff/src/server.ts` — import `detectCaseSlaBreaches`; new route `GET /v1/cases/sla-breaches` (`audit:read`, tenant-isolated) pulls the full journal via `caseEventStore.fetchSince(0, CASE_EVENT_MAX_LIMIT)` and returns `{summary}`.

### Decisions
- **State-vocabulary agnostic.** Resolver takes `sla_by_state` as input; states not in the map are tracked as open but never flagged. Default map mirrors M9.1 but the resolver works with any state names a caller posts to the journal.
- **`opened` payload.initial_state.** When present, seeds the case in that state. Defaults to `triage` so cases posted with bare `{action:'opened', case_id}` still produce a sensible reading.
- **Sequence-no sort.** Events are normally journal-ordered already, but I sort defensively — callers re-batching events shouldn't break the timeline.
- **Reuse `audit:read` not `cases:list`.** Matches the M3.5 + M8.6 analytics-route convention.
- **No new store.** This is purely derived from M9.4's existing journal — no schema additions, no migration.

### Hand-offs
- **agent-ui** — SLA breach strip can land on the cases dashboard / supervisor view. Envelope shape: `{ summary: CaseSlaSummary }`. Worst-first list is capped at 50.
- **agent-orchestrator** — when the M9.x case-transition routes (open, transition, close) get wired to auto-emit M9.4 journal entries (currently callers post explicitly per M9.4's design note), this SLA-breach signal becomes live for real workflow timelines, not just synthetic test data.

### Verification
- `npx jest __tests__/case_sla_breach.test.ts` — 18/18 pass.
- `npx jest` (full BFF suite) — 4093 pass / 58 skipped / 4152 total. Intermittent cross-suite singleton flakiness in `api_keys` / `admin_config` / `scenario_bulk` / `notification_template_dispatch` / `finance_adapter` — all pass when run alone; pre-existing pattern unrelated to M9.5 (also observed on M8.6).
- `npx tsc --noEmit` — clean.
