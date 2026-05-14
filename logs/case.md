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

## 2026-05-14 — T6 M9.6 — Case investigation timeline reconstruction

### Tasks ticked
- T6 sub-phase M9.6 — case investigation timeline reconstruction. T6 sub-phase tally 119 → 120.

### Files touched
- `services/bff/src/case_timeline.ts` (new) — pure `reconstructCaseTimeline(events, case_id, now)` walks one case's events in sequence_no order. Returns `CaseTimeline` with `total_events`, `events_by_action` (every CaseEventAction key present at 0 when absent), `opened_at`, `closed_at`, `current_state`, `time_in_current_state_hours`, `total_age_hours` (`now` for open cases, `closed_at` for closed), and `transitions[]` of `{sequence_no, occurred_at, actor, from_state, to_state, duration_in_previous_state_hours}`. State-shifting events (`opened`/`state_change`/`closed`) produce transition rows; non-state events (`note_added`/`checklist_updated`/`override_*`/`escalated`) only bump action counts. Defensively sorts by sequence_no.
- `services/bff/__tests__/case_timeline.test.ts` (new) — 14 jest tests: 2 empty (no events for case, non-opened events without an opened parent → no transitions), 2 single-opened (default 'triage' seed, custom initial_state honored), 2 multi-transition (durations + shuffled sequence_no), 2 closed (closed_at + closed-uses-closed_at-not-now for time_in_current_state, open-case total_age uses now), 1 non-state-events-only-bump-action-counts, 1 case_id filter, 4 route (200 happy, empty timeline for unknown case, cross-tenant invisibility, 403 wrong role).
- `services/bff/src/server.ts` — `GET /v1/cases/:case_id/timeline` mounted right after `/v1/cases/:case_id/events`. `audit:read` RBAC matches M9.5. Returns the timeline directly (no envelope wrap of `{timeline}`).

### Decisions
- **Returns empty timeline (not 404) for unknown cases.** M9.4's event log is total over case_ids — `forCase(unknown)` returns `[]` without erroring. Matches that posture; the SPA shows "no activity" rather than a 404 panel.
- **`total_age_hours` uses `now` for open cases, `closed_at` for closed.** Captures "how long has this case been around?" consistently in both lifecycles.
- **Non-state events fold into events_by_action only.** A `note_added` doesn't shift state — it shouldn't add a transition row. Tested explicitly with all 5 non-state actions.
- **Defensively sorts by sequence_no.** Same posture as M9.5 — protects against callers passing re-batched event arrays.
- **First opened transition has `from_state: null` + `duration_in_previous_state_hours: null`.** Makes the lack of "prior state" explicit in the timeline ladder rather than guessing a default.

### Hand-offs
- **agent-ui** — case detail page can render a vertical "timeline ladder" component reading `GET /v1/cases/:case_id/timeline`. Each transition becomes a card with the duration badge ("3.4h in triage"); the `events_by_action` count chip surfaces alongside ("4 notes, 2 checklist updates").

### Verification
- `npx jest __tests__/case_timeline.test.ts` — 14/14 pass.
- `npx jest` (full BFF suite) — 4390 pass / 58 skipped / 4448 total, **zero failures**.
- `npx tsc --noEmit` — clean.

## 2026-05-14 — T6 M9.7 — Investigation state-machine catalog

**Goal.** Expose the M9.1 state machine + M9.5 SLA defaults as a single readable graph so the SPA can build a data-driven "Move case to..." dropdown and a status-legend tooltip without hardcoding the state machine in TypeScript on the frontend (where it would inevitably drift from the backend).

### Files

- **EDIT** `services/bff/src/case_investigation.ts` — promoted private `TRANSITIONS` and added a public `INVESTIGATION_STATUSES` constant (the ordered list of state names) to give M9.7 a single source of truth without forcing the workflow author to write the state list in two places.
- **NEW** `services/bff/src/investigation_state_graph.ts` — pure `listInvestigationStateGraph()` walks `INVESTIGATION_STATUSES` in declared order and emits per-state `{state, sla_hours_default, terminal, allowed_next_states[] sorted asc}`. Derives entirely from the shared constants; no I/O.
- **NEW** `services/bff/__tests__/investigation_state_graph.test.ts` — 9 tests (6 pure + 3 route): catalog shape, terminal-only-for-closed, SLA mapping match, allowed_next_states sorted, triage→2 outgoing contract, review-can't-jump-to-closed invariant, route happy path, 403, same-graph-across-tenants.
- **EDIT** `services/bff/src/server.ts` — imported `listInvestigationStateGraph`; mounted `GET /v1/cases/states/graph` (audit:read) right after `/v1/cases/sla-summary`. The state graph is platform-static (no tenant-scoped state), so any tenant gets the same response.

### Design notes

- The state machine is platform-static — there's no tenant-level customization right now. The route is tenant-required for RBAC + auditing, but the response shape is identical across tenants. Tests assert this explicitly so a future change that introduces tenant overrides would force a tests/contract conversation.
- `audit:read` chosen as the RBAC because this surface is operator-facing (case investigators) not engineer-facing. `case_owner` would also be reasonable, but `audit:read` matches the existing M9.4/M9.5/M9.6 audit-flavoured case routes.
- `terminal: true` only on `closed`. Even though `closed` has outgoing transitions (`gathering_evidence` for re-opening), it's still the workflow terminus for KPIs — SPA can render it differently (gray vs colored).
- `allowed_next_states` sorted asc so the SPA's dropdown order is deterministic. The declared workflow order is preserved at the top-level `states[]` array — that ordering carries the workflow story (triage first, closed last). 

### Verification
- `npx jest __tests__/investigation_state_graph.test.ts` — 9/9 pass.
- `npx tsc --noEmit` — clean.

### Sub-phase tally
- T6 tally **133 → 134**.

## 2026-05-14 — T6 M9.8 — Investigation cohort summary

**Goal.** Executive rollup over ALL investigations in the tenant for the SPA's risk dashboard. Mirrors M14.19 / M3.5 analytics shape but for case investigations.

### Files

- **NEW** `services/bff/src/investigation_cohort_summary.ts` — pure `summarizeInvestigationCohort(tenant, investigations, now)`. Walks every investigation, increments per-status + per-decision counters, accumulates age-open + time-to-close sums for the means, tracks earliest-opened + latest-closed pointers.
- **NEW** `services/bff/__tests__/investigation_cohort_summary.test.ts` — 11 tests (6 pure + 5 route): empty (all-status-keys-emitted invariant), single open (open_count + oldest_open + mean_age), multi-open oldest_open invariant, single closed (decision bucket + mean_time_to_close), multi-closed newest_closed invariant, mixed cohort independence, empty route, populated, 403, cross-tenant invisibility, M9.1 list regression.
- **EDIT** `services/bff/src/server.ts` — mounted `GET /v1/investigations/summary` (audit:read) right BEFORE `/v1/investigations/:id` so the literal `/summary` segment isn't captured by `:id`.

### Design notes

- `by_status` always emits every 6 InvestigationStatus key (zeros when absent) so the SPA's state-mix bar chart doesn't have to backfill missing buckets.
- `by_decision` uses the literal `'null'` string for closed-without-decision (closed via `triage` → `closed` dismissal path). The 4 named buckets + 1 null bucket sum to closed_count.
- Means use null (not 0) when count=0 — avoids the misleading "your mean time-to-close is 0 hours" on an empty cohort. SPA renders "no data yet" when null.
- `oldest_open` / `newest_closed` provide single-row pointers for at-a-glance triage. Useful for "this investigation has been open 14 days, take action" badges.
- audit:read RBAC matches the existing dashboard-style routes (M14.19, M3.5, M11.11) — not analyst-tier `cases:list` because this is exec-tier aggregate data.

### Verification
- `npx jest __tests__/investigation_cohort_summary.test.ts` — 11/11 pass.
- `npx tsc --noEmit` — clean.

### Sub-phase tally
- T6 tally **144 → 145**.

## 2026-05-14 — T6 M9.9 — Investigation step progress

**Goal.** Per-case step progress card + fleet-wide step backlog view. Distinct from M9.8 (cohort-level investigation counts) — this is step granularity. Lets ops answer "this case is 6 of 8 steps done" + "most cases get stuck at the interview_claimant step".

### Files

- **NEW** `services/bff/src/investigation_step_progress.ts` — two pure surfaces:
  - `summariseInvestigationSteps(inv)` per-case progress card with oldest_pending_step (first step in array order still pending) and recent_completions (newest-first cap 5).
  - `listInvestigationStepBacklog(invs)` fleet-wide per-step backlog with `open_pending_count` excluding closed-case pendings (since closed-case pendings aren't actionable bottlenecks).
- **NEW** `services/bff/__tests__/investigation_step_progress.test.ts` — 15 tests (8 pure + 7 route) covering empty steps, all-pending oldest_pending = first step, mixed completion = first-incomplete-step is oldest_pending, all-complete oldest_pending=null, recent_completions sort + cap of 5, backlog empty, backlog aggregation, closed-case-pending excluded from open_pending_count, backlog sort invariant, route happy + 404 + 403.
- **EDIT** `services/bff/src/server.ts` — mounted both new routes BEFORE the catch-all `/v1/investigations/:id` (right above the existing M9.8 `/v1/investigations/summary`) so the literal `/step-backlog` and `/:id/step-progress` segments win.

### Design notes

- `oldest_pending_step` uses array-order (= step order) for "oldest" semantics. Investigation steps are deliberately ordered in `defaultSteps()` (verify_identity → … → final_recommendation per BIL §17), so first-pending-in-order = the natural "next step ops should tackle".
- `open_pending_count` is the load-bearing field for the backlog view. Counting pending steps on closed cases would pollute the bottleneck signal (a closed case isn't waiting on anything). Tested explicitly.
- Sort by `open_pending_count` desc surfaces the actual operational bottleneck. Tie-break by step_id asc keeps the order stable for SPA rendering.
- audit:read RBAC matches the M9.8 cohort-summary RBAC since this is exec-tier aggregate data.

### Verification
- `npx jest __tests__/investigation_step_progress.test.ts` — 15/15 pass.
- `npx tsc --noEmit` — clean.

### Sub-phase tally
- T6 tally **149 → 150**. **First session to reach 150!**
