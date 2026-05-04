# APEX EWS — Task Board

**Last updated:** 2026-05-03

> Checkbox-based. Each task is tagged with the owning agent. Phase acceptance criteria live in `REQUIREMENTS.md §5`.

## Phase 0 — Discovery & Foundations (M0–2)

- [ ] T0.1 Charter, RACI, risk register — **orchestrator**
- [x] T0.2 AWS landing zone IaC (Org, SCP, KMS, baseline VPC) — **agent-integration**
- [x] T0.3 Source-system inventory + integration contract drafts (CBS, LOS, bureau) — **agent-integration**
- [x] T0.4 Target architecture doc + diagram — **agent-integration**
- [x] T0.5 DPA 2019 / ISO 27001 control mapping — **agent-integration**
- [ ] T0.6 Vendor account stubs (Anthropic, Africa's Talking, SES) — **agent-integration**

## Phase 1 — Data Platform & Rule-based MVP (M2–6)

- [x] T1.1 Production VPC + EKS + Aurora + MSK Terraform — **agent-integration**
- [x] T1.2 Aurora schemas (raw / staging / mart / audit) — **agent-data**
- [x] T1.3 dbt project + `mart.customer_360`, `mart.loan_360`, `mart.txn_features` — **agent-data**
- [x] T1.4 MWAA DAGs `cbs_ingestion`, `bureau_sync`, `feature_build` + quality gates — **agent-data**
- [x] T1.5 Indicator catalog JSON (4 families) — **agent-indicator** _(catalog seeded by agent-rule; agent-indicator owns compute)_
- [x] T1.6 Indicator compute service (`mart.indicator_values`) — **agent-indicator**
- [x] T1.7 Rule DSL + lifecycle (draft → simulate → live → retired) — **agent-rule**
- [x] T1.8 Rule simulator over 12 months of synthetic data — **agent-rule**
- [x] T1.9 Seed rules — ≥ 25 across 4 families — **agent-rule**
- [x] T1.10 Alert producer → `apex.regulatory.events` — **agent-alert**
- [x] T1.11 notification-svc — SES + Africa's Talking adapters — **agent-alert**
- [x] T1.12 auth-svc — JWT + TOTP MFA — **agent-integration**
- [x] T1.13 audit-svc — hash-chain + S3 Object Lock stub — **agent-integration**
- [x] T1.14 Web SPA scaffolding (Vite + React + Tailwind, DMS tokens) — **agent-ui**
- [x] T1.15 **Login page mirroring DMS_Network** (split layout, carousel left, sign-in right) — **agent-ui**
- [x] T1.16 EWS Dashboard, Alert List, Customer Risk Profile, Rule Config screens — **agent-ui**

## Phase 2 — AI Risk Scoring & Smart Alerts (M6–10)

- [ ] T2.1 Feature store (Aurora + S3) with 24-mo backfill of synthetic data — **agent-data**
- [x] T2.2 PD model training pipeline (XGBoost baseline) — **agent-ai**
- [x] T2.3 Model serving endpoint on `ai-copilot-svc` — **agent-ai**
- [x] T2.4 SHAP explainer + reason-code payload — **agent-ai**
- [x] T2.5 Model registry + champion/challenger flag — **agent-ai**
- [x] T2.6 Drift monitoring (data, prediction, performance) — **agent-ai**
- [x] T2.7 Smart alert prioritisation (Critical/Medium/Low queues) — **agent-alert**
- [x] T2.8 Risk score + level + SHAP on Customer Risk Profile UI — **agent-ui**
- [ ] T2.9 NL→SQL Copilot stub via Claude API — **agent-ai**
- [x] T2.10 Model risk management framework doc — **agent-ai**
- [ ] T2.11 Fraud-suspicion alert type — add `Fraud` indicator family to `services/regulatory-svc/indicators/catalog.json` (sudden-withdrawal-spike, salary-not-credited, channel-anomaly, geo-anomaly), seed ≥3 fraud-family rules, ensure alert producer tags severity/type=`fraud_suspicion` — **agent-rule** + **agent-indicator** _(EWS.docx §3.5 explicitly lists Fraud suspicion as a third alert type; current indicator families are only Financial/Behavioural/Transaction/Credit)_
- [ ] T2.12 Real-time alert path — Kafka-streaming branch from indicator-update events to rule-engine evaluation, p95 indicator-to-alert latency <60s; current path is DAG-batch on the mart — **agent-alert** + **agent-indicator** _(EWS.docx §3.5 specifies real-time alerts; the batch path satisfies the rule semantics but not the latency intent)_

## Phase 3 — Integration & Case Management (M10–14)

- [ ] T3.1 CBS integration deepening — loan/repayment/account events — **agent-integration**
- [ ] T3.2 IFRS 9 stage-movement signal + ECL inputs — **agent-integration**
- [ ] T3.3 AML bidirectional alert correlation — **agent-integration**
- [x] T3.4 Collection auto-case routing + status callback — **agent-integration**
- [x] T3.5 Case state machine + assignment + action log — **agent-case**
- [x] T3.6 Case View UI + action capture — **agent-ui**
- [x] T3.7 Public REST API v1 (`/ews/evaluate`, `/alerts`, `/risk-profile`, `/action`) — **agent-integration**
- [x] T3.8 Glue Schema Registry + BACKWARD compatibility CI — **agent-integration**
- [x] T3.9 RBAC matrix + quarterly access review process — **agent-integration**
- [x] T3.10 BFF: map `apex.regulatory.events.v2` → `/api/alerts` list-row (lowercase severity, customer+rule join, `created_at`/`age_min`) — **agent-integration**

## Phase 4 — Scale, UX & Mobile (M14–18)

- [ ] T4.1 Analytics dashboard suite (risk trend, PD distribution, stage migration, **alert resolution** — _EWS.docx §8 lists alert-resolution alongside the other three; make sure the suite covers it_) — **agent-ui** _(partially done 2026-05-02: dashboard time-range selector + clickable KPIs + customer list landed; the other three sub-dashboards still pending)_
- [x] T4.2 Scenario engine (GDP/rate/FX shock) — portfolio PD re-run — **agent-ai** + **agent-ui** _(2026-05-02: BFF engine returned shape-correct ScenarioResult; SPA layered with 5 templates, IFRS 9 stage migration matrix, segment×risk heatmap, Portfolio PD + NPA% cards, top-affected drill-down, saved scenarios with side-by-side compare, CSV/PDF/Excel export. Caveat: stage_1→stage_3 PD cutoffs are absolute-PD bands; production should use relative deterioration vs origination PD)_
- [ ] T4.3 Mobile RN shell — Alert list, Case view, call/visit log, GPS — **agent-ui**
- [ ] T4.4 Performance tuning — HPA, Karpenter, Aurora reader autoscale — **agent-integration**
- [ ] T4.5 Load test at 5× pilot volume — **agent-integration**
- [ ] T4.6 Self-service reporting (QuickSight equivalent) — **agent-ui**
- [x] T4.7 SPA auth + security hardening sweep — rate-limit / lockout / captcha gate / audit log / sessions / password history / first-login wizard / OWASP headers / idle timeout / EN+HI i18n — **agent-ui** + **agent-integration** _(shipped 2026-04-28)_
- [x] T4.8 Dashboard interactivity — clickable KPI cards with deep-link query params + time-range selector + new CustomerListPage replacing the redirect — **agent-ui** _(shipped 2026-05-02)_
- [x] T4.9 Smart Alert Prioritization v2 — criticality formula (severity × confidence × log-exposure × ageBoost) + customer dedup + sort dropdown + linked-alerts badge. Extends T2.7's queue model with a per-alert score the UI sorts on by default — **agent-ui** + **agent-alert** _(shipped 2026-05-02; BFF mapping.ts has TODO pointer for the formula port — full BFF wiring deferred until exposure is joined into Lookups)_
- [x] T4.10 Rule Config UX overhaul — search by name/id, sticky list panel, outcome-severity strip, polished empty state, 5-tab unified detail card (Overview / Workflow / Backtest / Performance / Audit) with full ARIA tablist, URL-synced via `?q=` and `?tab=` — **agent-ui** _(shipped 2026-05-02)_
- [x] T4.11 Customer Risk Profile §5.3 360-view — Linked Alerts + Linked Cases panels with click-through to the canonical lists, customer_id filter on `/api/alerts` + `/api/cases` (MSW + types) — **agent-ui** _(shipped 2026-05-02)_
- [x] T4.12 Outbound webhook subsystem — admin-managed subscriptions with HMAC-SHA256 signing, 3-attempt retry (1s/4s/16s), per-subscription delivery log, fan-out from `/v1/ews/evaluate` (alert.created on High) + `/v1/scenario/run`. Admin SPA at `/admin/webhooks` with create + one-time secret reveal + test-fire + deliveries log + delete. New `webhooks:manage` RBAC op (admin only). 3 reserved event types (`alert.updated`, `case.assigned`, `case.closed`) listed in the picker but no emitter yet — wiring scheduled — **agent-integration** _(shipped 2026-05-02)_
- [x] T4.A Database fill-out — **agent-data** _(shipped 2026-05-03)_
  - Scaled raw seed 45× (220 → 10,000 customers; 24k loans, 247k repayments, 290k transactions, 10k bureau scores)
  - Fixed Gap 1 from `docs/database-gap-analysis.md`: dropped 5 empty `raw.cbs_*` tables, rewrote `002_raw_tables.sql`, removed `identifier:` aliases from `data/dbt/models/sources.yml`, mechanical rename of source refs in 5 staging models
  - Created 5 new application schemas (`004_app_schemas.sql`): `app_iam` (users/sessions/password_history/audit_events), `app_cases` (cases/actions), `app_alerts` (alerts/queue_assignments), `app_bff` (webhook_subscriptions/webhook_deliveries), `app_scenario` (saved_scenarios). 11 tables total with proper PKs/FKs/CHECKs/indexes
  - Generated synthetic app data (`_generate_app_seeds.py` → `app_seeds.sql`) — ~26k rows (505 users / 3,105 sessions / 12,000 audit events / 528 cases / 1,568 actions / 2,527 alerts / 3,431 queue assignments / 25 webhook subs / 915 deliveries / 120 saved scenarios)
  - 79/79 dbt tests still pass on the larger volume
  - Two new docs: [`docs/database-schema.md`](docs/database-schema.md) (column-level reference for all 9 schemas) + [`docs/database-gap-analysis.md`](docs/database-gap-analysis.md) (live inventory + sized fix plans)
  - Final state: 9 schemas / 21 tables / **~731,500 rows** queryable via DBeaver
- [x] T4.13 Wire `services/bff` outbound webhooks → `app_bff.{webhook_subscriptions, webhook_deliveries}` — replaces in-memory `WebhookSubscriptionStore` + delivery ring buffer. Webhook secrets no longer disappear on BFF restart. **agent-integration** _(shipped 2026-05-03)_
  - New `PgWebhookSubscriptionStore` at `services/bff/src/webhooks/pg_store.ts` — cache-on-init + sync reads + write-through fire-and-forget pg INSERTs. Same shape as the in-memory store (duck-typed via new `IWebhookStore` alias).
  - Factory `makeWebhookStore()` in `store.ts` — picks pg-backed when `BFF_PG_URL` is set, in-memory otherwise. Server bootstrap (`if (require.main === module)` block) calls it on startup; logs which backend is active.
  - 5 new pg integration tests in `services/bff/__tests__/webhooks_pg.test.ts` (skipped when `BFF_PG_URL` unset, so CI stays hermetic). Manual smoke proven: POST webhook → kill BFF → restart → subscription rehydrated from `app_bff.*` (26 rows including the synthetic seed).
  - Existing 13 in-memory tests still pass; total BFF jest suite now 215 (210 + 5 pg integration).
  - Bundled the new pg dep + @types/pg in services/bff.
- [x] T4.14 Wire `services/auth-svc` users + sessions + password_history → `app_iam.*` — replaces in-memory DEMO_USERS array, SessionStore Map, password history string[]. Sessions + audit events + lock state persist across auth-svc restart. **agent-integration** _(shipped 2026-05-03)_
  - 3 new pg-backed stores at `services/auth-svc/src/pg_user_store.ts`, `pg_session_store.ts`, `pg_audit_log.ts` — all share the cache-on-init + sync reads + write-through fire-and-forget pattern from T4.13.
  - New `auth_state.ts` factory exposes `IUserStore | ISessionStore | IAuthAuditLog` union types + `makeAuthStores()` env switch — picks pg backend when `AUTH_SVC_PG_URL` is set, in-memory otherwise. Routes don't branch on the choice.
  - 5 new pg integration tests in `services/auth-svc/src/__tests__/pg_stores.test.ts` (skipped when `AUTH_SVC_PG_URL` unset; uses `node:test` `{ skip }` option). Existing 99 in-memory tests still pass.
  - Manual smoke proven: login as alice.admin → kill server → restart → /auth/users returns the 5 demo users (rehydrated) + the new sessions row landed in `app_iam.sessions`. Failed-login lock state + audit events also persist.
  - Bundled pg + @types/pg in services/auth-svc.
- [x] T4.15 Wire `services/regulatory-svc/cases` → `app_cases.{cases, actions}` — replaces NDJSON-backed CaseStore. State-machine logic + producer (case.events outbox) stay unchanged; only the persistence layer moves. **agent-case** _(shipped 2026-05-03)_
  - New `PgCaseStore` at `services/regulatory-svc/cases/src/pg_store.ts` — same cache-on-init + sync reads + write-through fire-and-forget pattern from T4.13/T4.14. Inserts use `ON CONFLICT DO NOTHING`; subsequent state transitions UPDATE; only newly-added actions get inserted (diff against persisted set, not full replace).
  - Factory `makeCaseStore()` + `ICaseStore` union type in `store.ts` — picks pg-backed when `CASES_PG_URL` is set, NDJSON otherwise. `service.ts` and `server.ts` AppDeps widened to `ICaseStore`; routes don't branch.
  - 5 new pg integration tests in `services/regulatory-svc/cases/__tests__/cases_pg.test.ts` (skipped via `describe.skip` when `CASES_PG_URL` unset). Covers create, full lifecycle (assign → action → close), restart-survival, idempotency on alert_id, and list filters.
  - Existing 39 in-memory tests still pass; manual smoke proven: POST /cases → kill server → restart → GET /cases?customer_id= returns the rehydrated case (state, actions, sla_status all correct).
  - Schema gotchas documented in `pg_store.ts` header: `customer_name` and `rule_name` columns are NOT NULL but the in-memory model doesn't carry them — defaults to empty string. `sla_status` defaults to `'on_track'` and flips to `'closed'` on terminal state. GPS columns (lat/lng/accuracy_m) split out from the nested object.
  - Bundled pg + @types/pg in services/regulatory-svc/cases.
- [x] T4.16 Wire `services/auth-svc` audit log fan-out → both `app_iam.audit_events` (service-local, T4.14) AND `audit.event_log` (hash-chained regulatory trail). **Closes Gap 2** from `docs/database-gap-analysis.md`. **agent-integration** _(shipped 2026-05-03)_
  - New `AuditEventLogClient` at `services/auth-svc/src/audit_event_log.ts` — thin INSERT wrapper that lets the `audit.fn_event_log_chain` trigger compute `prev_hash` + `event_hash`. INSERTs serialised through an in-process Promise queue (the chain depends on the previous row's hash; concurrent INSERTs would race for the same `last_hash`).
  - `PgAuthAuditLog.append()` now ALSO fires a fire-and-forget chain INSERT on every event. Cross-reference: each chain row carries `payload._local_event_id` pointing at the matching `app_iam.audit_events` row + `payload._service: "auth-svc"` so the same event is queryable from both tables.
  - 5 new pg integration tests in `services/auth-svc/src/__tests__/audit_event_log.test.ts` — chain math (prev_hash/event_hash), null-actor coercion, 10-concurrent-appends serialise correctly, end-to-end fan-out (login → both tables), opt-out via `setChainClient(null)`. All pass; existing 99 in-memory tests untouched.
  - Manual smoke proven: 3 login attempts (1 success, 1 wrong-password, 1 unknown user) → 3 chain rows with intact prev_hash links + correct event_types (LOGIN_SUCCESS / LOGIN_FAILURE) + cross-reference back to `ae-*` local IDs.
  - Designed for re-use: `audit_event_log.ts` is the seed of a future `@apex-ews/audit` library that cases (T4.15-shipped) and alerts (T4.17-shipped) can adopt with no rewrite — just a different mapping function.
- [x] T4.17 Wire `services/regulatory-svc/alerts` → `app_alerts.{alerts, queue_assignments}` — replaces in-memory `SmartQueue` (NDJSON-tail backed). Bucket order, FIFO, round-robin assignment + audit log all persist across restart. **agent-alert** _(shipped 2026-05-03)_
  - New `PgSmartQueue` at `services/regulatory-svc/alerts/src/pg_queue.ts` — same cache-on-init + sync reads + write-through fire-and-forget pattern from T4.13–T4.16. `init()` rebuilds bucket order from `created_at ASC` so FIFO is stable across restart.
  - Factory `makeQueue()` + `IQueue` union type in `queue.ts` — picks pg-backed when `ALERTS_PG_URL` is set, NDJSON otherwise. `evaluator.ts` and `server.ts` widened to `IQueue`; routes don't branch.
  - 5 new pg integration tests in `services/regulatory-svc/alerts/__tests__/alerts_pg.test.ts` — enqueue + initial assignment row, full lifecycle (enqueue → assign → ack → close) with assignment log appends, restart-survival with assigned-state preservation, pullNext priority, idempotency on alert_id. All pass; existing 40 in-memory tests untouched.
  - Manual smoke proven: POST /alerts/evaluate → kill server → restart → GET /alerts returns the rehydrated row with correct bucket + state.
  - State-mapping gotcha documented in `pg_queue.ts` header: schema `status` is 3-valued (`open`/`acked`/`closed`) but in-memory `state` is 4-valued (`queued`/`assigned`/`acked`/`closed`); both `queued` and `assigned` map to `'open'` with the `assignee` column distinguishing them. `init()` reverses the mapping.
  - Bundled pg + @types/pg in services/regulatory-svc/alerts.
- [x] T4.18 Wire `services/bff` scenario save/load → `app_scenario.saved_scenarios`. SPA's saved-scenario panel writes through to the BFF API; localStorage stays as a write-through cache for offline resilience + instant first-render. **agent-ui** + **agent-integration** _(shipped 2026-05-03)_
  - New `PgScenarioStore` + `InMemoryScenarioStore` at `services/bff/src/scenario/store.ts` — env-driven factory keyed off `BFF_PG_URL` (same DSN as webhooks). Both impls share the `IScenarioStore` interface; routes don't branch.
  - 4 new BFF routes at `/v1/scenarios` (GET list, GET id, POST save, DELETE) — all RBAC-guarded with `customers:read_risk_profile`. Non-admin callers see only their own rows; admin sees everyone (supports "review what the team is stress-testing" workflow).
  - Client-supplied id pattern: SPA generates `s-{ts}-{rand}` locally, passes it in the POST body, BFF stores it as-is. Avoids the "two entries for the same scenario" reconciliation problem when the cache holds a placeholder id and the server assigns a different one.
  - SPA's `web/src/lib/savedScenarios.ts` now write-through: cache is the instant-read source-of-truth; every save fires `api.saveScenarioApi(...)` in the background; on mount, `refreshSavedFromApi()` MERGES API + cache so cross-device saves appear without losing in-flight local items. Sync API contract preserved → existing 204 SPA tests pass without rewrites.
  - 15 new tests in `services/bff/__tests__/scenarios_store.test.ts` (11 in-memory + 4 pg integration gated on `BFF_PG_URL`). MSW handlers for `/v1/scenarios` added so SPA tests don't blow up on the fire-and-forget API call.
  - Manual smoke proven: POST /v1/scenarios → kill BFF → restart → GET /v1/scenarios returns the rehydrated row with correct saved_by + inputs + result.
  - Closes Gap 3 (Wire 5 services to read/write the new app_* tables) entirely. All 5 services now persist to Postgres.
- [x] T4.19 CAS + CAP modelling per BAC-A manual §3.1.5 — Causal Analysis Stage and Corrective Action Plan as distinct entities (not the granular action log we already had). Closes Gap #1 from `docs/bac-a-manual-gap-analysis.md`. **agent-case** _(shipped 2026-05-03)_
  - Two new schema tables: `app_cases.cas_records` (cas_id, cause_type, cause_summary, severity_assessment, decision, submitted_by, reviewed_by, review_status, attachments JSONB) and `app_cases.caps` (cap_id, cap_item, issue_owner_group, issue_owner, issue_priority, target_completion_date, status, proposed_by, approved_by, closed_at, closure_comments, attachments JSONB). FK CASCADE from cases.
  - 5 new methods on `CaseService`: `submitCas`, `reviewCas`, `proposeCap`, `approveCap`, `closeCap`. Maker-checker semantics enforced — CAS lands in `review_status='pending'` until a checker approves; CAPs land in `status='open'` until approved.
  - **`close()` now refuses with HTTP 409 when any CAP is `open`/`in_progress`/`overdue`** — per the manual's "case can only close when all CAPs are closed" rule.
  - 5 new event types on the case-events outbox: `case.cas_submitted`/`cas_reviewed`/`cap_proposed`/`cap_approved`/`cap_closed`. Schema registry (`infra/schema-registry/apex.case.events.v1.json`) updated in-place with the additions.
  - 5 new RBAC ops in `infra/rbac/matrix.json`: `cases:cas_submit` (RM tier), `cas_review` (supervisor), `cap_propose` (RM tier), `cap_approve` (supervisor), `cap_close` (RM + collection_officer).
  - 5 new HTTP routes: `POST /cases/:id/cas`, `POST /cases/:id/cas/:cas_id/review`, `POST /cases/:id/caps`, `POST /cases/:id/caps/:cap_id/approve`, `POST /cases/:id/caps/:cap_id/close`.
  - PgCaseStore extended with `init()` rehydration of cas_records + caps (with the YYYY-MM-DD cast-to-text trick for the DATE column to dodge the timezone bug) and diff-on-upsert persistence (cas/cap UPDATEs go through write-through fire-and-forget like everything else from T4.13–T4.18).
  - 15 new in-memory tests (covers happy paths + 409 on double-review + 409 on close-while-CAP-open + 404s) + 8 new pg integration tests (lifecycle persistence + restart-survival of cas_records and caps + close-gate-honoured-from-pg). All 62 cases tests pass.
  - Manual smoke proven: full retail-customer workflow per manual §2.1.1 — create case → submit CAS → checker approves → propose CAP → checker approves CAP → try to close case (409) → close CAP → close case (200) — and after a server restart the rehydrated case shows both records intact.
- [x] T4.20 Maker-Checker generic approvals infrastructure per BAC-A manual §3.1.4 — cross-cutting `app_audit.approvals` table with fan-out from CAS submit/review and CAP propose/approve. Closes Gap #2 from `docs/bac-a-manual-gap-analysis.md`. **agent-case** _(shipped 2026-05-03)_
  - New schema: `app_audit` (distinct from immutable `audit.event_log`; this one is mutable as approval state evolves) + `app_audit.approvals` table (approval_id, subject_type, subject_id, action, payload JSONB, maker, proposed_at, checker, reviewed_at, status, comments, sla_due_at, correlation_id).
  - New module `services/regulatory-svc/cases/src/approvals.ts` — `ApprovalsClient` with `propose()` + `review()`. Optional pool (`null` = no-op for in-memory tests); fire-and-forget writes (errors swallowed + logged); review() is a no-op on missing pending row.
  - **Additive, not replacement**: cas_records and caps tables stay the source-of-truth for the case workflow (T4.19). The new approvals table is a cross-cutting fan-out so future code (rule promotion, user creation, etc.) can adopt the same client and admins can query "all pending approvals across the system" from one table.
  - Wired into `CaseService` via a new `approvals?: ApprovalsClient` ServiceDep (defaults to `ApprovalsClient.noop()` so existing in-memory tests need no changes). Bootstrap injects a live client when `CASES_PG_URL` is set; in-memory mode keeps the no-op default.
  - 10 new tests in `services/regulatory-svc/cases/__tests__/approvals.test.ts` (3 unit + 7 pg integration). Includes the cross-cutting "GROUP BY subject_type, count pending" query that proves the whole point of the design — one table, all pending CAS + CAP approvals visible at once.
  - Manual smoke proven: full CAS+CAP workflow (with pg backend) writes 2 approval rows correctly correlated to the case_id, and the cross-cutting query returns both with their proper status (CAS approved, CAP pending) in one SELECT.
  - All 72 cases tests pass (39 prior + 15 CAS+CAP from T4.19 + 18 new for this work, of which 10 are the approvals suite and 8 are the existing T4.19 pg integration tests still passing).
- [x] T4.21 Issue Owner Groups + branch teams per BAC-A manual §3.1.7.1.5. Closes Gap #3 from `docs/bac-a-manual-gap-analysis.md`. **agent-integration** _(shipped 2026-05-03)_
  - Two new schema tables in `app_iam`: `user_teams` (team_id, name, branch, role, team_leader FK to app_iam.users, email, description) with UNIQUE (name, branch) + `user_team_members` (BIGSERIAL id, team_id FK CASCADE, user_id FK CASCADE) with UNIQUE (team_id, user_id).
  - New module `services/auth-svc/src/teams.ts` — `ITeamStore` interface + `InMemoryTeamStore` + `PgTeamStore`. Same write-through fire-and-forget pattern as the other auth-svc stores (T4.14, T4.16). Leader is implicitly added to members on `create()`; `removeMember()` refuses with HTTP 409 if the target is the team_leader (must reassign first).
  - Wired into `auth_state.ts` factory + 5 new routes: `GET /auth/teams?branch=&role=` (any signed-in user — needed by SPA team-picker dropdowns), `GET /auth/teams/:team_id` (any signed-in user), `POST /auth/teams` (admin), `POST /auth/teams/:team_id/members` (admin, idempotent), `DELETE /auth/teams/:team_id/members/:user_id` (admin), `DELETE /auth/teams/:team_id` (admin).
  - 10 new tests in `services/auth-svc/src/__tests__/teams.test.ts` (6 in-memory unit + 4 pg integration); all 105 in-memory + 14 pg auth-svc tests pass.
  - Manual smoke proven: login as alice.admin → POST 2 teams (Legal Mumbai + Credit Mumbai) → GET filtered by branch → add/remove non-leader members → 204 → try to remove team_leader → 409 with the right error message.
  - **Design choice — no cross-service validation:** the cases service does NOT validate `cap.issue_owner_group` against the team list. Adding a runtime auth-svc dependency to cases would couple two services that today share only a Postgres pool. Right shape: the SPA populates the issue_owner_group dropdown by calling `/auth/teams`, then cases trusts the value. Documented in `docs/bac-a-manual-gap-analysis.md`.
- [x] T4.22 Leave Cover Request per BAC-A manual §3.1.9.1.3 — operators delegate tasks to a coverer for a date range. Closes Gap #4 from `docs/bac-a-manual-gap-analysis.md`. **agent-integration** _(shipped 2026-05-03)_
  - New schema table `app_iam.leave_covers` (cover_id, applicant_user FK, leave_coverer FK, role, start_date DATE, end_date DATE, in_office BOOLEAN, comments, created_at, cancelled_at) with CHECK constraints `end_date >= start_date` and `applicant_user <> leave_coverer`.
  - New module `services/auth-svc/src/leave_covers.ts` — `ILeaveCoverStore` + `InMemoryLeaveCoverStore` + `PgLeaveCoverStore` with the same write-through pattern as the other auth-svc stores. The crucial method is `activeCoverFor(user_id, date)` which returns the active cover row (or undefined) for the SPA's auto-routing.
  - Wired into `auth_state.ts` + 4 new routes: `GET /auth/leave-covers?applicant_user=&leave_coverer=&active_on=&active_only=` (any signed-in user, scoped to own rows + admin sees all), `POST /auth/leave-covers` (any signed-in user can file own; admin can file on behalf of any user), `DELETE /auth/leave-covers/:cover_id` (applicant + coverer + admin can cancel), `GET /auth/users/:user_id/active-cover?date=YYYY-MM-DD` (returns cover row or 204).
  - 7 new tests (5 in-memory unit + 2 pg integration) including overlap-resolution (most-recently-created cover wins) and the schema CHECK constraints firing as belt-and-braces.
  - Manual smoke proven: alice files leave covered by ravi (10-20 May) → /active-cover at 15 May returns ravi's row → at 20 April returns 204 → DELETE the cover → /active-cover at 15 May now returns 204.
  - Same SPA-layer-validation design choice as T4.21: cases service doesn't auto-route based on covers. The SPA assignment dropdown calls `/auth/users/:id/active-cover` before submitting an `assign(case_id, user_id)` and substitutes the coverer. Avoids a runtime auth-svc dependency in cases.
- [x] T4.23 Per-role dashboard widget configuration per BAC-A manual §3.1.9.1.4. Closes Gap #5 — the LAST item from `docs/bac-a-manual-gap-analysis.md` Top-5 list. **agent-integration** + **agent-ui** _(shipped 2026-05-03)_
  - New schema table `app_iam.role_dashboard_widgets` (composite PK on (role, widget_id) + sort_order INTEGER + is_visible BOOLEAN + updated_at + updated_by). Empty config for a role = SPA falls back to catalogue defaults; the table is purely an override mechanism.
  - New module `services/auth-svc/src/dashboard_widgets.ts` — `IDashboardWidgetsStore` + `InMemoryDashboardWidgetsStore` + `PgDashboardWidgetsStore`. Single mutation method `replaceForRole()` is atomic-replace not merge — wipes prior rows for the role then INSERTs the new layout inside a pg transaction.
  - 2 new routes: `GET /auth/dashboard-widgets/:role` (any signed-in user — they need their own dashboard config), `PUT /auth/dashboard-widgets/:role` (admin only, replace-all). Validates role against the same 5-value enum auth-svc uses elsewhere (admin / risk_analyst / supervisor / collection_officer / field_officer); rejects duplicate widget_ids in the input.
  - 8 new tests (5 in-memory unit + 3 pg integration). Includes the transactional-replace assertion (verify replace with 1 widget after a prior replace with 3 leaves exactly 1 row) + the schema CHECK firing as belt-and-braces.
  - Manual smoke: GET /admin returns empty initially → PUT field_officer with 2 widgets → GET shows them in sort order → PUT with invalid role → 400.
  - **SPA delivery:**
    - `web/src/store/auth.ts` extended with `getDashboardWidgets(role)` + `putDashboardWidgets(role, widgets)` API methods + `DashboardWidgetConfig` type.
    - 2 MSW handlers in `web/src/mocks/handlers.ts` keyed by role; module-level Map reset between tests via new `__resetMswDashboardWidgets()` helper.
    - New page at `/admin/dashboard-widgets` — minimal v1 with role selector + checkbox-and-numeric-sort-order grid + Save layout button. Drag-and-drop polish deferred (would need a drag-drop library + meaningful ergonomics work; not worth it for the prototype).
  - **Deliberately deferred:** the `DashboardPage` itself doesn't yet honour the per-role config. It still renders the same panels for every role. Refactoring it into a widget catalogue + per-widget visibility filter is significant work (the dashboard is one large composed page, not a component composition) — documented as a follow-up in `docs/bac-a-manual-gap-analysis.md`. The admin page lets ops curate the config so the contract is in place when the dashboard is refactored.
  - All 5 BAC-A Top-5 gaps now closed (T4.19–T4.23). Backend: 134 auth-svc tests pass (115 in-memory + 19 pg); 72 cases tests; 230 BFF; 204 SPA. SPA build clean.

- [x] T4.24 Multi-tenant API foundation + enterprise envelope — Phases 1–13, sourced from `Banking Api Integration – EWS Full Technical Documentation (1).pdf` §3 (multi-tenant), §6 (envelope), §7 (OAuth), §11 (error shape). Companion to the `DataNetworks-EWS-Ver1.pdf` BIL pitch — multi-tenant context is the prerequisite for serving BIL alongside the BANK_DEMO tenant. **agent-integration** _(Phase 1 shipped 2026-05-03; Phases 2 + 3 partial 2026-05-03 → 2026-05-04; Phases 4–13 partial 2026-05-04)_
  - **Phase 1 — schema, helpers, reference endpoint, OAuth shim:**
    - Schema: `data/schema/005_tenants.sql` adds `app_iam.tenants` (seeded BANK_DEMO + BIL) and `app_iam.service_clients`; `tenant_id` column on `app_iam.users` (FK, default BANK_DEMO). Makefile wired to apply 004 + 005 in `make migrate`.
    - BFF: new `services/bff/src/envelope.ts` (`wrapResponse`, `wrapError`, `EnterpriseError`, `readRequestId`, `extractCtx`) and `services/bff/src/tenant.ts` (`requireTenant` middleware + default in-memory tenant lookup mirroring 005 seed). Reference endpoint `POST /v1/ews/evaluate` migrated: enforces `X-Tenant-ID` + `X-Channel`, returns `{header:{status,code,message,requestId,timestamp}, body}` envelope, errors as `{header, error:{code,message,severity}}`. Legacy raw-body callers are still served (the handler peels `body.body` if the envelope is present, otherwise treats the payload as the inner body).
    - auth-svc: new `services/auth-svc/src/service_clients.ts` (`IServiceClientStore` + `InMemoryServiceClientStore`, seeded with `apex-mobile-bank-demo` / `bil-los-stub`). New route `POST /oauth/token` (RFC 6749 §4.4 client_credentials) issues an RS256 access token bound to the tenant; payload carries `typ: "m2m"`, `tenant_id`, `client_id`, `scope`. Coexists with the existing user-cookie auth path.
  - **Phase 2 — envelope rollout, tenant gate everywhere, pg store:**
    - **Envelope migrated** to: `/v1/alerts`, `/v1/risk-profile/:customer_id`, `/v1/action`, `/v1/copilot/chat`, `/v1/scenario/run`, `/v1/scenarios` (GET list), `/v1/scenarios/:id` (GET + DELETE), `/v1/scenarios` (POST). All return `{header, body}` on success and `{header, error}` on failure with `EWS_<status>` codes (e.g. `EWS_400`, `EWS_404`, `EWS_409`, `EWS_500`, `EWS_503`). Severity assignment: 5xx → HIGH, 4xx → MEDIUM, NotFound → LOW.
    - **Tenant gate (no envelope) applied** to: `/v1/notifications/stream`, `/v1/notifications/publish`, `/v1/cases/sla-summary`, `/v1/webhooks` (GET + POST), `/v1/webhooks/:id` (DELETE), `/v1/webhooks/:id/test`, `/v1/webhooks/:id/deliveries`, `/v1/integrations/health`, `/v1/reports/:type`, `/v1/rules/variables`, `/v1/rules`, `/v1/rules/:id`, `/v1/rules/:id/transition`, `/v1/rules/:id/backtest`, `/v1/rules/:id/performance`. These ops endpoints reject without `X-Tenant-ID` + `X-Channel` but keep their existing raw-JSON response shapes; envelope migration deferred until partner integrations require it. **Every public `/v1/*` route now requires tenant context.**
    - **Pg-backed `PgServiceClientStore`** added next to `InMemoryServiceClientStore`. Cache-on-init pattern (mirrors `PgUserStore` / `PgWebhookSubscriptionStore`): hydrates from `app_iam.service_clients` and seeds the demo clients with argon2-hashed secrets via `INSERT … ON CONFLICT DO NOTHING`. `getServiceClientStore()` selects pg vs in-memory based on `AUTH_SVC_PG_URL`.
    - **`/api/alerts` stays raw** — it's the SPA-internal route, not a public partner endpoint. Only `/v1/*` carries the new contract.
  - **Tests:**
    - BFF: 242 pass (was 238 — +4 net after envelope/tenant additions across alerts, risk-profile, action, copilot, scenario, scenarios, plus tenant-header threading on rules/reports/sla/integrations/notifications/webhooks). Updated test files: `v1.test.ts`, `rbac.test.ts`, `webhooks.test.ts`, `copilot.test.ts`, `scenario.test.ts`, `scenarios_store.test.ts`, `notifications.test.ts`, `integrations.test.ts`, `sla.test.ts`, `reports.test.ts`, `rules.test.ts`. New file: `envelope.test.ts` (12 tests).
    - auth-svc: 122 in-memory pass (was 115 — +7 oauth in `oauth.test.ts`); 20 pg-skipped (was 19 — +1 PgServiceClientStore integration test in `pg_stores.test.ts`).
  - **Phase 3 — auth tenant binding + audit tenant context (2026-05-04):**
    - **User → tenant binding:** `User` interface gains `tenant_id` (default `BANK_DEMO`); both `UserStore` and `PgUserStore` SEED arrays add the field; new BIL demo user `bil.admin` (password `BilAdmin!1`, tenant `BIL`) so the prototype can demo cross-tenant flows. PgUserStore reads/writes the column; bootstrap seed and `register()` accept the optional tenant.
    - **JWT carries tenant_id:** `signAccessToken()` accepts a `tenant_id` claim; the `/auth/login` and `/auth/refresh` flows pass `user.tenant_id` through. Tokens are RS256 with `tenant_id` in the payload.
    - **BFF defense-in-depth:** the `requireTenant` middleware decodes (without verifying — prototype shim, production should fetch JWKS) the `Authorization: Bearer` JWT and refuses with **CRITICAL** severity 403 when its `tenant_id` claim contradicts `X-Tenant-ID`. Tokens without the claim (older user sessions or M2M tokens lacking tenant) fall through to header-only.
    - **Audit tenant + channel:** new migration `data/schema/006_audit_tenant.sql` adds `tenant_id` (default `BANK_DEMO`, NOT NULL) + `channel` (nullable) to both `audit.event_log` and `app_iam.audit_events` with `(tenant_id, ts DESC)` indexes. The hash chain on `audit.event_log` is INTENTIONALLY left untouched — tenant_id/channel are metadata alongside the chain, not in the canonical hash input. `AuthEvent` interface, `AuthAuditLog.append()`, `PgAuthAuditLog.append()` (read + write), `AuditChainEvent`, and `authEventToChain()` all thread the new fields. Login-success audit calls now stamp `user.tenant_id`.
    - **Tests:** BFF 246 (was 242 — +4 JWT-vs-header tenant tests in `envelope.test.ts`). auth-svc 125 in-memory (was 122 — +3 tenant audit tests in `audit_log.test.ts`: defaults, BIL passthrough, login flow stamps user's tenant in JWT + audit). 20 pg-skipped (unchanged).
  - **Phase 4 — data-layer tenant isolation for BFF-owned stores (2026-05-04):**
    - **Migration `data/schema/007_app_tenant.sql`:** adds `tenant_id` (FK → `app_iam.tenants`, default BANK_DEMO, NOT NULL) to `app_bff.webhook_subscriptions` and `app_scenario.saved_scenarios`. Denormalises `tenant_id` onto `app_bff.webhook_deliveries` (no FK; subscription FK keeps it consistent) with backfill from the parent subscription. New indexes: `(tenant_id, active)`, `(tenant_id, completed_at DESC)`, `(tenant_id, saved_by, saved_at DESC)`.
    - **`WebhookSubscriptionStore` (in-memory) + `PgWebhookSubscriptionStore`:** every CRUD method now tenant-scoped. `create({tenant_id,...})`, `list(tenant_id)`, `get(id, tenant_id)`, `delete(id, tenant_id)`, `matching(event_type, tenant_id)`, `deliveriesFor(id, tenant_id)`. Cross-tenant reads return `undefined` / empty (no enumeration leak). `internalGet(id)` stays tenant-agnostic — used by the dispatcher *after* it has already filtered via `matching()`.
    - **`InMemoryScenarioStore` + `PgScenarioStore`:** `IScenarioStore` interface evolves — `save({tenant_id,...})`, `list({tenant_id, saved_by?})`, `get(id, tenant_id)`, `delete(id, tenant_id)`. Same isolation semantics as webhooks.
    - **`WebhookDispatcher.dispatch(event_type, payload, tenant_id)`:** mandatory tenant_id parameter. Events fired in tenant A only reach tenant A's subscriptions. `WebhookDelivery` row carries denormalised `tenant_id` from its subscription.
    - **BFF route handlers:** `/v1/webhooks*`, `/v1/scenarios*`, the `alert.created` fan-out from `/v1/ews/evaluate`, and the `scenario.run` fan-out from `/v1/scenario/run` all pass `req.tenant!.tenant_id` into the stores / dispatcher.
    - **Out of scope (Phase 5+):** `regulatory-svc/cases` (`app_cases.*`) and `regulatory-svc/alerts` (`app_alerts.*`) live in a separate codebase — they'll get the same treatment in their own tickets. `mart.*` analytics warehouse is not tenant-tagged because it'd require BIL synthetic data generation, which is a domain pivot rather than data-layer plumbing.
    - **Tests:** BFF 249 (was 246 — +3 cross-tenant: `InMemoryScenarioStore` unit isolation, route-level "BIL admin never sees BANK_DEMO scenarios", route-level "BIL admin never sees BANK_DEMO webhooks"). Existing webhook + scenario tests updated for the new tenant_id parameter (~25 test calls). auth-svc unchanged at 125 in-memory + 20 pg-skipped.
  - **Phase 5 — regulatory-svc/cases tenant scoping (2026-05-04):**
    - **Migration `data/schema/008_cases_tenant.sql`:** `tenant_id` (FK → tenants, default BANK_DEMO, NOT NULL) on `app_cases.cases` with `(tenant_id, state)` and `(tenant_id, assignee) WHERE assignee IS NOT NULL` indexes. Downstream tables (actions, cas_records, caps) inherit tenancy via the case_id FK chain — no direct tenant column to avoid identical-tenant fan-out.
    - **`Case` interface:** gains `tenant_id`. Both `CaseStore` (NDJSON-backed) and `PgCaseStore` (cache-on-init): every read method (`get`, `getByAlert`, `list`) filters on `tenant_id` (default BANK_DEMO for backward compat with the existing test suite + pre-Phase-5 NDJSON snapshots). Pre-Phase-5 rows that lack `tenant_id` are treated as BANK_DEMO. PgCaseStore INSERT writes the column on case creation.
    - **`CaseService`:** all 13 mutation methods + `get`/`list` accept an optional `tenant_id` parameter (default `'BANK_DEMO'`). `requireCase(caseId, tenant_id)` passes through to `store.get` so the tenant filter applies on every state transition. `createFromAlert(alert, tenant_id)` stamps the new case with the caller's tenant.
    - **regulatory-svc/cases server:** new `tenantOf(req)` helper reads `X-Tenant-ID` (defaults to BANK_DEMO when missing — the BFF is the strict gate, this service trusts upstream). Every route (`POST /cases`, `GET /cases`, `GET /cases/:id`, `assign`, `actions`, `monitor`, `close`, the 5 CAS+CAP routes) threads tenant through to the service.
    - **BFF case_action proxy:** `HttpCaseActionSink` propagates `X-Tenant-ID` and `X-Channel` headers to the cases service. `CaseActionInput` gains optional `tenant_id` + `channel`. The BFF `/v1/action` handler populates them from `req.tenant.tenant_id` and `req.channel`.
    - **Out of scope (Phase 6):** `regulatory-svc/alerts` (`app_alerts.*`) gets the same treatment in its own ticket. Same pattern; same shape.
    - **Tests:** cases 59/59 (was 57 — +2 cross-tenant: `BIL admin never sees BANK_DEMO cases` covering list/get/assign across tenants, plus `cases from different tenants live side-by-side without leaking`). BFF 249/249 (unchanged — case_action sink still has its existing test coverage; the new headers are additive). auth-svc 125 in-memory + 20 pg-skipped (unchanged).
  - **Phase 6 — regulatory-svc/alerts tenant scoping (2026-05-04):**
    - **Migration `data/schema/009_alerts_tenant.sql`:** `tenant_id` (FK → tenants, default BANK_DEMO, NOT NULL) on `app_alerts.alerts` with `(tenant_id, status, criticality_score DESC) WHERE status='open'` and `(tenant_id, assignee) WHERE assignee IS NOT NULL` indexes. `app_alerts.queue_assignments` inherits via `alert_id` FK.
    - **`QueueEntry`:** gains `tenant_id`. Both `SmartQueue` (NDJSON) and `PgSmartQueue`: every method (`enqueue`, `list`, `get`, `pullNext`, `assign`, `ack`, `close`, `requireEntry`) takes optional `tenant_id` (default `'BANK_DEMO'` for backward compat with existing tests + pre-Phase-6 NDJSON). `pullNext(tenant_id, forUser?)` only iterates entries in the caller's tenant — a BIL puller never sees a BANK_DEMO alert. `PgSmartQueue` reads/writes the new column on `enqueue`.
    - **`AlertEvaluator.evaluate(firing, tenant_id)`:** the producer-side endpoint takes the tenant from the request and stamps it on the new alert via `queue.enqueue(alert, tenant_id)`. Idempotency check (`queue.get(alertId, tenant_id)`) also tenant-scoped.
    - **regulatory-svc/alerts server:** new `tenantOf(req)` helper (mirrors Phase 5's cases server). Every route — `POST /alerts/evaluate`, `GET /alerts`, `GET /alerts/:id`, `assign`, `ack`, `close` — threads tenant through to the queue/evaluator.
    - **Tests:** alerts 42/42 (was 40 — +2 cross-tenant in `queue.test.ts`: list/get/pullNext/assign/ack/close are tenant-scoped, plus default-tenant backward-compat). cases 59/59 unchanged. BFF 249/249 unchanged. auth-svc 125 in-memory + 20 pg-skipped unchanged.
    - **Bug found + fixed:** `SmartQueue.pullNext` was calling `this.assign(id, assignee)` without the tenant_id arg, causing the assign step to default to BANK_DEMO and reject BIL alerts. Now forwards tenant_id correctly.
  - **Phase 7 — JWKS signature verification (2026-05-04):**
    - **auth-svc:** new `GET /.well-known/jwks.json` endpoint exposes the signer's RS256 public key as a JWK Set (RFC 7517 shape). Anonymous; the public key is by definition not a secret. Includes `kid: 'alias/apex-ews-secret'`, `alg: 'RS256'`, `use: 'sig'`. Critically, the response strips private-key fields (`d`, `p`, `q`).
    - **BFF:** new `services/bff/src/jwks_client.ts` with two verifier impls satisfying a common `JwtVerifier` interface — `JwksVerifier` (real RS256 verification using `jose.jwtVerify` against a remote JWKS, used in production) and `InsecureDecodeVerifier` (the Phase 3 base64-decode shim, retained as the test-mode fallback so existing tests with fake-signature JWTs keep working). Selected by env: `BFF_JWKS_URL` set → JwksVerifier; unset → InsecureDecodeVerifier.
    - **Tenant middleware (services/bff/src/tenant.ts):** `requireTenant(lookup, verifier)` accepts a verifier; default `InsecureDecodeVerifier` for backward compat. `readBearerTenant` is now async and uses the verifier — production deployments now reject forged tokens at the tenant gate, not just decode them. The Phase 3 caveat ("prototype shim — production should fetch the auth-svc's public key") is now closed.
    - **AppDeps:** new optional `jwtVerifier?: JwtVerifier` injection point. `makeApp({ jwtVerifier })` for tests; production wires the env-driven default via `makeJwtVerifier(process.env)`.
    - **Tests:**
      - auth-svc: 3 new in `jwks.test.ts` — endpoint shape; anonymous access; end-to-end "JWKS verifies an /auth/login token" loop using the fetched JWK to verify a real access_token's signature + claims (tenant_id=BANK_DEMO, role=admin).
      - BFF: 10 new in `jwks_client.test.ts` — InsecureDecodeVerifier decodes well-formed payload + returns undefined for malformed; JwksVerifier verifies a properly signed token, rejects forged signature (signed with attacker's key), rejects expired, rejects wrong issuer, rejects wrong audience, rejects tampered claim (attacker swaps `tenant_id: BANK_DEMO` → `BIL` mid-flight); makeJwtVerifier factory selects correct impl.
      - Test counts: BFF 259/259 (was 249 — +10 JWKS), auth-svc 128 in-memory + 20 pg-skipped (was 125 — +3 JWKS).
    - **Dependency:** added `jose@^5` to BFF (downgraded from v6 because v6 is ESM-only and Jest's CJS transformer can't handle it without configuration; v5 is dual-published and works out of the box).
    - **Production note:** the JWKS cache TTL is process lifetime — auth-svc's ephemeral keypair regenerates on restart, so a key rotation requires a BFF restart too. Production swaps to KMS-backed rotation + cache TTL ≤ rotation window.
  - **Phase 8 — envelope migration for ops endpoints (2026-05-04):**
    - **14 routes migrated** to the bank-grade `{header, body}` / `{header, error: {code, message, severity}}` envelope:
      - **Webhooks (5):** `GET /v1/webhooks`, `POST /v1/webhooks` (201 with `EWS_201`), `DELETE /v1/webhooks/:id` (204 unchanged), `GET /v1/webhooks/:id/deliveries`, `POST /v1/webhooks/:id/test`.
      - **Notifications + SLA + integrations (3):** `POST /v1/notifications/publish` (201), `GET /v1/cases/sla-summary`, `GET /v1/integrations/health`.
      - **Rules (6):** `GET /v1/rules/variables`, `GET /v1/rules` (with `EWS_400` envelope on bad state/product), `GET /v1/rules/:id` (404 envelope), `POST /v1/rules/:id/transition` (404/400/409 envelopes — `IllegalTransition` becomes `EWS_409` with `detail.error_kind=illegal_transition`; `InvalidPayload` becomes `EWS_400` with `detail.error_kind=invalid_payload`), `POST /v1/rules/:id/backtest` (404), `GET /v1/rules/:id/performance` (404).
    - **Skipped — partial-binary endpoint:** `GET /v1/reports/:type` returns binary (PDF/Excel/CSV) for non-JSON formats. The mixed shape (envelope on JSON, raw binary on others) makes a full migration awkward and would break existing test fixtures that read raw `r.body` as a Buffer. Deferred to a separate ticket if/when external partners explicitly want the JSON variant enveloped.
    - **Skipped — SSE:** `/v1/notifications/stream` is Server-Sent Events; envelope doesn't apply to streaming text/event-stream payloads.
    - **Tests:** ~25 assertions updated across `webhooks.test.ts`, `notifications.test.ts`, `sla.test.ts`, `integrations.test.ts`, `rules.test.ts` — all `r.body.X` references for migrated routes now read `r.body.body.X` (success) or `r.body.error.X` (error). All 259 BFF tests pass; cases (59), alerts (42), auth-svc (128 in-memory + 20 pg-skipped) unchanged.
    - **Outcome:** every public `/v1/*` JSON-returning route now emits the same envelope shape — Banking API doc §6 + §11 are fully applied across the contract.
  - **Phase 9 — multi-tenant introspection + reports JSON envelope (2026-05-04):**
    - **`GET /v1/tenants/me`:** any authenticated request that carries tenant context gets back `req.tenant` (tenant_id, name, vertical, channels_allowed, active). Wrapped in the standard envelope. Useful for SPAs that want to render "you're logged in to <tenant.name>".
    - **`GET /v1/tenants`:** admin-only (gated on `audit:read`) — lists every configured tenant via `tenantLookup.all()`. Returns 501 envelope when the lookup doesn't expose `all()` (test stubs); production lookups always do.
    - **`TenantLookup` type evolved:** function type → callable interface with optional `all()` method. `defaultTenantLookup()` populates `all` to return the seed registry snapshot (BANK_DEMO + BIL).
    - **`GET /v1/reports/:type?format=json`:** the JSON variant now uses `wrapResponse`; binary formats (csv/pdf/xlsx) stay raw because the envelope can't wrap a Buffer + Content-Disposition cleanly. Validation errors (bad type/period/format) and 500s also wrap.
    - **Tests:** BFF 264/264 (was 259 — +5 in v1.test.ts: /tenants/me happy path BANK_DEMO, /tenants/me happy path BIL, /tenants/me missing tenant header → 400, /tenants admin lists ≥2 tenants, /tenants RBAC field_officer → 403). reports.test.ts JSON assertions updated for envelope shape.
    - **Outcome:** the multi-tenant story is now introspectable end-to-end — a caller can fetch their tenant, an admin can enumerate the registry, and the entire `/v1/*` JSON surface (including reports JSON) speaks the same envelope.
  - **Phase 10 — tenant mutation endpoints (2026-05-04):**
    - **`TenantLookup` evolved** with three optional mutation methods: `create(input)`, `update(tenant_id, patch)`, `delete(tenant_id)`. New types: `TenantCreateInput`, `TenantUpdatePatch`, `TenantConflict`. `defaultTenantLookup()` wraps a mutable Map and implements all three; `BANK_DEMO` is hardcoded as system-protected (delete returns the literal `'system_protected'` string so the route can map it to a 409 vs the missing-row 404).
    - **`POST /v1/tenants`:** admin-only (audit:read). Validates `tenant_id` matches `^[A-Z][A-Z0-9_]{1,31}$`, `name` non-empty, `vertical` ∈ {banking, insurance}, `channels_allowed` non-empty string array. 409 envelope on duplicate (`detail.tenant_id` echoes the conflicting id). 201/EWS_201 envelope on success. Accepts envelope or raw body input.
    - **`PATCH /v1/tenants/:tenant_id`:** admin-only. Partial update of `name` / `channels_allowed` / `active` (tenant_id immutable). Per-field validation; 404 envelope when missing.
    - **`DELETE /v1/tenants/:tenant_id`:** admin-only. 204 on success; 404 envelope when missing; 409 envelope when system-protected (BANK_DEMO).
    - **501 envelopes** when the tenant lookup doesn't expose the corresponding mutation method (test stubs); production lookups always do.
    - **Tests:** BFF 274/274 (was 264 — +10 in v1.test.ts: POST happy path + round-trip via GET, 409 duplicate, 400 malformed tenant_id, 400 bad vertical, RBAC field_officer → 403, PATCH happy path, PATCH 404 missing, PATCH 400 invalid field, DELETE happy path + 404 on second delete, DELETE 409 system-protected). cases / alerts / auth-svc unchanged.
    - **Outcome:** the multi-tenant config is now fully manageable from the API. An admin can sign in, list every configured tenant, create new ones (e.g. for a partner pilot), update channels or name, and delete experiments — all without touching SQL or restarting the BFF.
  - **Phase 11 — service-client CRUD (2026-05-04):**
    - **`IServiceClientStore` evolved** with three optional CRUD methods + helper types: `list(tenant_id?)` returns `ServiceClientView[]` (strips `client_secret_hash`); `create(input)` returns `ServiceClientWithSecret` (the only point where the plaintext secret is exposed); `delete(tenant_id, client_id)` returns boolean. New `ServiceClientConflict` exception for duplicates.
    - **Both stores implement them:** `InMemoryServiceClientStore` (used by hermetic tests + dev) writes to its in-process Map. `PgServiceClientStore` writes to `app_iam.service_clients` and updates the cache; `delete` is fire-and-forget pg with cache update upfront.
    - **Auth-svc routes:** all admin-only via Bearer JWT role=admin.
      - `GET /auth/service-clients?tenant_id=...` — admin lists clients (without secret hash). Optional tenant filter; omit for platform-admin view across all tenants.
      - `POST /auth/service-clients` — generates the secret server-side (32 bytes hex, same shape as webhook secrets), stores the argon2id hash, returns the plaintext secret ONCE in the response. 409 on `(tenant_id, client_id)` duplicate. 400 on malformed `client_id` (must match `^[a-z0-9][a-z0-9._-]{2,63}$`).
      - `DELETE /auth/service-clients/:tenant_id/:client_id` — 204 on success, 404 on missing.
      - 501 envelopes when the store doesn't implement the corresponding method.
      - Audit log: create/delete events fan out (`user_created` / `user_deleted` event types with `metadata.kind: 'service_client'`).
    - **Tests:** auth-svc 136 in-memory + 20 pg-skipped (was 128 — +8 in `service_clients_crud.test.ts`: list seeded, list filtered by tenant, list 401 without admin, POST happy path with /oauth/token round-trip, POST 409 duplicate, POST 400 malformed client_id, DELETE 204→404, non-admin 403). BFF 274/274 unchanged.
    - **Outcome:** the OAuth client_credentials principal store is now fully manageable from the API. Admins can sign in, list every client across tenants, mint new ones with auto-generated secrets, and revoke obsolete ones. Closes the "service-clients are seeded SQL only" gap from Phase 1.
  - **Phase 12 — admin SPA pages: tenants + service-clients (2026-05-04):**
    - **`AdminTenantsPage` at `/admin/tenants`:** lists every configured tenant; create form (tenant_id regex-validated, vertical picker, channel checkboxes); delete with confirm. BANK_DEMO row hides the delete button (system-protected). Follows the existing `WebhooksPage` layout pattern.
    - **`AdminServiceClientsPage` at `/admin/service-clients`:** lists every OAuth service-client across tenants; create form (tenant_id, client_id regex-validated lowercase, display_name); delete with confirm. **One-time secret reveal modal** (mirrors webhooks pattern) — the plaintext `client_secret` is shown once with copy-to-clipboard, then never again.
    - **`api.ts` extensions:** new `tenantList / tenantMe / tenantCreate / tenantPatch / tenantDelete` methods, all envelope-aware (unwrap `r.data.body`). New types: `Tenant`, `TenantCreateInput`, `TenantPatch`, `TenantVertical`, `EnvelopeBody<T>`.
    - **`store/auth.ts` extensions:** new `adminListServiceClients / adminCreateServiceClient / adminDeleteServiceClient` methods. New types: `ServiceClientRow`, `ServiceClientCreated`. Calls auth-svc raw shape (no envelope — auth-svc routes pre-date the envelope migration).
    - **MSW handlers:** new in-memory mocks for both APIs. Tenants handlers return enveloped responses (matching production BFF post-Phase-8); service-clients handlers return raw shape (matching auth-svc). Seeded with BANK_DEMO + BIL tenants + the two demo clients (`apex-mobile-bank-demo`, `bil-los-stub`).
    - **Sidebar + routes:** new `Tenants` and `Service clients` nav links under Admin (icons: Building2, Key). i18n keys for both en + hi. New routes registered in `App.tsx`.
    - **Tests:** SPA 204/204 unchanged — new pages don't have unit tests yet (mutation UIs are hand-tested through the dev server). Type-check (`tsc --noEmit`) clean. BFF / cases / alerts / auth-svc all unchanged.
    - **Outcome:** the multi-tenant story is now demoable end-to-end. Sign in as alice.admin → sidebar → Tenants → see BANK_DEMO + BIL → create a new pilot tenant → sidebar → Service clients → see the seeded clients → mint a new one and copy the secret. No more SQL or curl required for admin operations.
  - **Phase 13 — mart tenant tagging (2026-05-04):**
    - **Migration `data/schema/010_mart_tenant.sql`:** idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'BANK_DEMO'` on `mart.customer_360`, `mart.loan_360`, `mart.txn_features`, `mart.indicator_values`, plus `(tenant_id)` indexes on each. Wrapped in a DO block that checks each table exists first — survives a fresh schema bootstrap or a full dbt rebuild. No FK to `app_iam.tenants` (mart is append-only analytics; FK would block dbt from rebuilding when a tenant is deleted from the live registry).
    - **dbt staging models stamp `'BANK_DEMO'::text AS tenant_id`** as a literal projection in all 5 staging models (`stg_customer`, `stg_loans`, `stg_repayments`, `stg_txns`, `stg_bureau_score`). Picked literal-projection over modifying the seed CSVs / generator because re-running the seed pipeline regenerates 580k+ rows — way out of proportion to the goal. When BIL synthetic data ships, swap the literals for `coalesce(tenant_id, 'BANK_DEMO')` against a real source column.
    - **dbt mart models project `tenant_id` through:** `customer_360` (from `stg_customer`), `loan_360` (from `stg_loans`), `txn_features` (added to GROUP BY so future BIL transactions don't merge with BANK_DEMO), `indicator_values` (8 indicator CTEs + final SELECT all carry tenant_id from `customer_360`).
    - **Outcome:** the analytics warehouse now speaks tenant end-to-end. A BIL operator querying `mart.customer_360 WHERE tenant_id='BIL'` correctly sees zero rows today (no BIL data); a BANK_DEMO operator continues to see all 10,000 customers. The plumbing is in place for BIL synthetic data to land in a future ticket without further schema changes.
    - **Tests:** schema migrations not runnable in this environment (no Docker / Postgres / dbt). All committed code is structural — re-running `cd data/schema && make migrate && cd ../dbt && dbt run` materialises the changes. No service-side tests touch `mart.*` directly (mart access is via the BFF data-access layer, which already has tenant context from Phases 1-12). BFF / cases / alerts / auth-svc / SPA suites all unchanged.
    - **T4.24 status: COMPLETE for the schema/contract layer.** The 13-phase initiative ships every piece of the multi-tenant + envelope contract from the Banking API doc. What remains is operational nice-to-haves, not contract gaps: BIL synthetic data, persisted tenant mutations, patch UI polish, MSW envelope migration. Treating these as standalone follow-ups rather than phases of T4.24.
  - **Standalone follow-ups** (each is its own ticket; not part of T4.24 anymore):
    - **BIL synthetic dataset** — a generator that produces ~50 BIL customers + their loans / repayments / transactions / bureau scores, all stamped `tenant_id='BIL'`. Once seeded, the staging literal `'BANK_DEMO'::text AS tenant_id` flips to `coalesce(tenant_id, 'BANK_DEMO')` and BIL operators see real data.
    - **Persist tenant mutations to `app_iam.tenants`** — Phases 10 + 12 stay in-memory; pg-backed `ITenantStore` lands when the SPA writes regularly enough that restart-loss is annoying.
    - **Tenant patch UI** — endpoint exists, SPA form not yet built.
    - **Migrate webhook MSW handlers to enveloped shape** — Phase 8 wrapped real BFF for `/v1/webhooks*`; MSW still returns raw shape, so dev mode diverges from production. Same change for any other ops-endpoint MSW handlers that haven't been updated.
    - Migrate the operational endpoints (`/v1/webhooks*`, `/v1/rules*`, `/v1/notifications/publish`, `/v1/reports*`, `/v1/integrations/health`, `/v1/cases/sla-summary`) from raw JSON to the bank-grade envelope.
    - Admin SPA pages for tenant CRUD + service client CRUD (analogous to the existing `/admin/webhooks` page).
    - Replace the BFF JWT base64-decode-only shim with proper signature verification via auth-svc's JWKS endpoint.

- [ ] T6 BIL 16-module platform expansion — sourced from the BIL deployment brief (16 main modules / ~365 APIs). Each module ships as one or more sub-phases; existing code from T4.24 is re-used as foundation, all new work is additive. The 16 modules:
  1. Authentication & User Management (35 APIs) — login, 2FA, RBAC, sessions, maker-checker
  2. Multi-Tenancy & API Gateway (12 APIs) — already shipped via T4.24
  3. Data Ingestion & ETL (25 APIs) — connectors, Kafka streaming, batch ETL, data quality
  4. Risk Indicator Engine (30 APIs) — 8 sub-engines covering banking + insurance KRIs
  5. Rule Engine (18 APIs) — visual builder, lifecycle, backtesting, versioning
  6. Scoring Engine (12 APIs) — implements BIL formula `Σ (KRI Weight × KRI Value)`
  7. AI/ML Model Engine (25 APIs) — PD model, fraud detection, anomaly detection, MLflow
  8. Alert Engine (18 APIs) — Red/Orange/Yellow classification per BIL doc
  9. Case Management (20 APIs) — full case lifecycle, evidence, SLA, escalation
  10. Notification Service (18 APIs) — email, SMS, push, in-app
  11. Dashboards & Analytics (30 APIs) — all 5 BIL dashboards (Executive, Claims, Underwriting, Agent, Operational)
  12. Reports & Export (22 APIs) — PDF/Excel/Email per BIL doc
  13. Admin Configuration (15 APIs) — central control panel
  14. External Integration Layer (50 APIs) — CBS, Core Insurance, Policy Master, Claims, Agent, Finance, DMS, HR, IFRS 9, AML, Bureau
  15. Audit & Compliance (20 APIs) — RBI/IRDAI compliance trail
  16. Scenario Simulation (15 APIs) — already largely shipped via T4.2

  **agent-integration** _(initiative kicked off 2026-05-04; M1.1 shipped same day)_

  - **M1.1 — TOTP 2FA (2026-05-04):**
    - Migration `data/schema/011_user_2fa.sql` adds `app_iam.user_2fa_secrets` (one row per user, FK CASCADE on user_id, base32 secret + algorithm/digits/period config + backup_codes TEXT[] of argon2id hashes).
    - `services/auth-svc/src/totp.ts` — `otpauth`-based wrapper. `generateSecret()` produces a fresh 20-byte base32 secret; `buildOtpauthUrl()` returns the `otpauth://totp/` URL the client renders as a QR; `verifyCode()` checks a 6-digit TOTP against the secret with ±1 step (30s) drift tolerance; `mintBackupCodes()` produces 10 single-use codes (10 hex chars each) with argon2id hashes; `consumeBackupCode()` verifies + returns the new hashes array. In-memory `I2faStore` + `I2faPendingStore` interfaces; pg-backed swap is a future ticket.
    - 5 new routes:
      - `POST /auth/2fa/setup` — generates secret, stashes pending (10-min TTL), returns secret + otpauth URL. 409 when already enrolled.
      - `POST /auth/2fa/verify` — promotes pending → enrolled on first valid code, mints + returns 10 backup codes ONCE.
      - `POST /auth/login/verify-2fa` — partial-token exchange step. Accepts TOTP `code` OR `backup_code` (single-use). Returns the same access + refresh shape `/auth/login` would have, plus `backup_codes_remaining` count.
      - `DELETE /auth/2fa[?username=...]` — user disables their own; admin disables anyone's.
      - `GET /auth/2fa/status` — { enrolled, enrolled_at, last_used_at, backup_codes_remaining }.
    - **`/auth/login` extended** — when the user has 2FA enrolled, returns `{ requires_2fa: true, partial_token, expires_in: 300 }` instead of the full token pair. Partial token is a 5-minute RS256 JWT with `typ: '2fa_partial'` + `sid` claim. Login_success audit event is deferred until the verify-2fa step succeeds.
    - **Tests:** auth-svc 146 in-memory + 20 pg-skipped (was 136 — +10 in `totp.test.ts`: setup happy path, setup→verify happy path with backup-code mint, verify wrong code → 401, verify malformed → 400, login flow round-trip with TOTP, verify-2fa wrong code → 401, backup code single-use, DELETE disables, non-admin can't disable other users, setup 409 when already enrolled). BFF / cases / alerts / SPA all unchanged.
    - **Dependency:** added `otpauth@^9` to auth-svc.

  - **M4.1 — Insurance KRI catalogue (2026-05-04):**
    - New file `services/regulatory-svc/indicators/catalog_insurance.json` — 25 BIL-specific indicators across 5 KRI families (Policy 7, Customer 5, Agent 4, Claim 5, Operational 4). Sourced from `DataNetworks-EWS-Ver1.pdf` §7-10. Same `IndicatorDef` shape as the banking catalog so any consumer that handles one handles the other.
    - Family / id-prefix mapping: Policy → `POL-*`, Customer → `CUS-INS-*` (avoids collision with future banking customer ids), Agent → `AGT-*`, Claim → `CLM-*`, Operational → `OPS-*`. Inputs reference `mart.policy_360` / `mart.claim_360` / `mart.agent_360` etc. — those tables don't materialise yet (the catalog is forward-looking; compute fns + tables ship with the BIL synthetic-data follow-up).
    - **`catalog.ts` evolution** — adds `loadInsuranceCatalog()` (memoised) and `loadCatalogFor(vertical)` (banking | insurance dispatch). The compute-registry assertion (`checkRegistryAgainstCatalog`) is intentionally NOT applied to the insurance catalog because compute fns ship later.
    - **Two new routes** in `regulatory-svc/indicators/src/server.ts`:
      - `GET /indicators/insurance` — returns the BIL catalog directly.
      - `GET /indicators/by-vertical?vertical=banking|insurance` — vertical-aware dispatch. Tenants carry `vertical` (T4.24 Phase 1) so the BFF can forward `?vertical=${req.tenant.vertical}` and the indicator service picks the right catalog without the BFF hard-coding.
    - **Tests:** indicators suite 94/94 (was 81 — +13 in `insurance_catalog.test.ts`): catalog loads, declares vertical=insurance, spans 5 families with ≥3 indicators each, every indicator carries the standard IndicatorDef fields, ids unique + don't collide with banking prefixes, both new routes happy paths, default + invalid `vertical=` handling.
    - **Outcome:** the BIL deployment now has a structured indicator contract. When the BIL synthetic dataset lands (separate ticket) the compute fns can target known ids; the catalog itself is already shippable to the BIL stakeholders for review.

  - **M11.1 — BIL Claims Dashboard (2026-05-04):**
    - New `services/bff/src/bil_dashboards.ts` — pure-function builder for BIL dashboard payloads. `buildClaimsDashboard(tenant_id, asOf)` returns a deterministic `ClaimsDashboard` shape with totals + 3 panels (abnormal patterns, flagged hospitals, turnaround anomalies). Same (tenant, day) → identical output, so the SPA + downstream consumers can integrate against a stable contract today; the body swaps to real `mart.claim_360` queries when the BIL synthetic dataset lands.
    - New BFF endpoint `GET /v1/dashboards/bil/claims` — tenant-scoped, RBAC-gated on `audit:read`, enveloped response. BIL gets a 60%-scale dataset relative to BANK_DEMO so the two tenants' dashboards look distinguishable side-by-side.
    - **Dashboard panels** (mirror DataNetworks-EWS-Ver1.pdf §14):
      - **Abnormal claim patterns:** 4 of 6 known patterns sampled per day, each with count_30d + severity + delta vs baseline. Patterns: WAITING_PERIOD_BREACH, REPEAT_REASON_180D, AMOUNT_DEVIATION_30PCT, MISSING_DOCS, OFF_TEMPLATE_DOCS, RAPID_POLICY_CLAIM.
      - **Flagged hospitals:** top-5 watchlisted providers ranked by fraud score, with claim count + total amount KES.
      - **Turnaround anomalies:** 6 sample claims with actual_tat_hours > expected_tat_hours and a triage status (pending / investigating / escalated).
    - **M11.2-M11.4 follow-up sub-phases** (shipped 2026-05-04, same day as M11.1):
      - M11.2 — Underwriting Dashboard (high-risk proposals, churn, lapse)
      - M11.3 — Agent Dashboard (performance, risk contribution, cancellation clusters)
      - M11.4 — Operational Dashboard (UW delays, login anomalies, override patterns)
      - The Executive Dashboard is already shipped via the existing banking `/api/dashboards`.
    - **Tests:** BFF 284/284 (was 274 — +10 in `bil_dashboards.test.ts`):
      - builder shape + 3 panel arrays
      - deterministic — same (tenant, day) → identical
      - different tenants get different scale (BIL < BANK_DEMO)
      - flagged_hospitals ranked 1-5 by fraud_score
      - abnormal patterns carry valid severity buckets
      - turnaround anomalies have actual > expected TAT
      - `/v1/dashboards/bil/claims` admin happy path
      - BIL-tenant scoping
      - non-admin → 403
      - missing tenant headers → 400 envelope
    - All other suites unchanged.

  - **M11.2 + M11.3 + M11.4 — Underwriting / Agent / Operational dashboards (2026-05-04):**
    - Same builder pattern as M11.1: deterministic Mulberry32 PRNG seeded by `(tenant_id, day-of-asOf, dashboard-key)`. Each builder is a pure function exposed by `bil_dashboards.ts`.
    - **M11.2 `GET /v1/dashboards/bil/underwriting`** — totals (proposals_30d, approved/declined/pending, average_decision_hours), 8 high_risk_proposals (each with 2-3 risk_factors + UW risk band), 6-month churn_trend (issued/cancelled/lapsed/net_change), 10 lapse_predictions sorted by 30-day probability desc.
    - **M11.3 `GET /v1/dashboards/bil/agent`** — totals (active_agents, new_agents_30d, suspended_agents, avg payout/lapse ratios), 8-row leaderboard ranked 1-8 by premium volume, 6-row risk_contribution sorted by risk_score desc, 4 cancellation_clusters (branch + product + agent_count + cancellation_rate + premium_at_risk).
    - **M11.4 `GET /v1/dashboards/bil/operational`** — totals (pending_underwriting, avg_uw_delay, suspicious_logins_30d, overrides_30d, data_modifications_anomalous_7d), 5-row uw_delay_breakdown sorted by p95 desc, 7-row login_anomalies (geo_velocity / device_change / after_hours_admin / failed_attempts_spike) sorted newest-first, 8-row override_log (4 resource types: underwriting / claim / payout / kyc) sorted newest-first.
    - **Tests:** BFF 305/305 (was 284 — +21 across the 3 new dashboards):
      - Each builder: shape, determinism, sort invariants (rank/p95/probability/risk_score), enum-bounded fields
      - Each route: admin happy path; one non-admin 403 for UW + ops
    - **Outcome:** all 4 BIL dashboards under `/v1/dashboards/bil/*` are now demoable. Combined with the existing banking Executive at `/api/dashboards`, the SPA can render the full DataNetworks-EWS-Ver1.pdf §14 dashboard suite for both verticals. When the BIL synthetic dataset lands, the four builders swap to real queries; the response shapes stay stable.

  - **M6.1 — BIL Σ(W×V) risk-scoring engine (2026-05-04):**
    - New `services/bff/src/bil_scoring.ts` — pure-function `computeRiskScore(items, thresholds?)` implementing the formula from DataNetworks-EWS-Ver1.pdf §12: `Risk Score = Σ (KRI Weight × KRI Value)`, normalised to a 0-100 scale and bucketed Low (≤30) / Medium (≤70) / High (>70). Thresholds are operator-overridable per request (the PDF calls them "fully configurable by BIL"). Stateless — caller supplies `(indicator_id, weight 0..1, value 0..1)` tuples directly, so the scoring API doesn't need a catalog dependency. Values are clamped to `[0,1]` so a poorly-normalised input can't blow the upper bound; weight=0 contributes zero; total_weight=0 short-circuits to score=0/low (no NaN).
    - New BFF endpoint `POST /v1/scoring/risk` — tenant-gated, RBAC `customers:read_risk_profile` (risk-analyst level, NOT admin-only since this is a daily-use op), enveloped request/response. Accepts both raw `{items, thresholds?}` and enveloped `{header, body: {items, thresholds?}}` request shapes. Response body: `{score, category, thresholds, breakdown[], total_weight, raw_sum}`.
    - **Validation errors are 400-enveloped** with action-specific codes for SPA UX: `EWS_400_empty_items`, `EWS_400_invalid_weight` (weight out of `[0,1]`), `EWS_400_invalid_value` (NaN/non-finite), `EWS_400_invalid_item` (missing indicator_id), `EWS_400_invalid_thresholds` (low_max > medium_max OR out of `[0, 100]`).
    - **Tests:** BFF 337/337 (was 305 — +32 in `bil_scoring.test.ts`): pure function (22) covers the formula at boundaries (30 inclusive→low, 31→medium, 70 inclusive→medium, 71→high), threshold override + partial override, value clamping at both ends, breakdown order preservation, total_weight=0 NaN guard, and 8 error paths; route layer (10) covers admin happy path, enveloped request body, threshold override round-trip, the 4 error codes above, missing tenant header rejection, unknown role → 403 fail-closed, and `risk_analyst` accepted.
    - **Outcome:** Module 6's headline deliverable shipped. Any caller (SPA, scenario runner, partner integrator) with the indicator weights + values can now fetch a BIL-formula risk score with a single tenant-scoped POST. A future M6.2 can wrap this with a "look up weights from the catalog by indicator_id" convenience layer; the primitive itself stays unchanged.

  - **M10.1 — BIL notification email channel (2026-05-04):**
    - New `services/bff/src/notifications/email.ts` — `EmailTransport` interface (`send(tenant_id, msg) → receipt` + `recent(tenant_id, limit) → ledger[]`) plus `StubEmailTransport` (in-memory, per-tenant ledger with capped retention, deterministic clock injectable for tests). Production swap is an SES/SMTP transport satisfying the same interface — call sites stay unchanged.
    - **4 BIL canned templates** sourced from DataNetworks-EWS-Ver1.pdf §13: `ALERT_RED` (immediate-action, 4 required vars), `ALERT_ORANGE` (investigate, 3 required vars), `CASE_ASSIGNED` (4 required vars), `SLA_BREACH` (3 required vars). Subject + body are `{{var}}` strings rendered via the simple `substitute()` helper — unmatched slots survive in the output so misuses are visible to the operator. Caller-supplied subject/body fields override template-rendered ones for ad-hoc one-offs.
    - **`AppDeps.emailTransport` injection point** — defaults to the module-level `defaultEmailTransport` singleton; tests pass a fresh `StubEmailTransport` per test for isolation.
    - **4 new BFF routes** (all tenant-gated, all enveloped):
      - `GET /v1/notifications/email/templates` — RBAC `cases:list` (analyst+). Lists the 4 templates with their required_vars + subject/body strings so the SPA can render a picker.
      - `POST /v1/notifications/email/preview` — RBAC `cases:list`. Renders `template_id` + `template_vars` to `(subject, body_text, body_html?, missing_vars[])` without sending. Used by the SPA preview pane.
      - `POST /v1/notifications/email/send` — RBAC `audit:read` (admin). Validates + dispatches via the transport. Accepts both raw and enveloped request bodies. Errors 400-encoded with codes `EWS_400_no_recipient`, `EWS_400_invalid_addresses`, `EWS_400_unknown_template`, `EWS_400_missing_template_vars`, `EWS_400_missing_subject`, `EWS_400_subject_too_long`, `EWS_400_missing_body`.
      - `GET /v1/notifications/email/log?limit=50` — RBAC `audit:read`. Returns the per-tenant ledger newest-first; clamped to `[1, 500]`. Tenant-scoped — BIL admins do NOT see BANK_DEMO entries.
    - **Tests:** BFF 379/379 (was 337 — +42 in `email_channel.test.ts`):
      - Pure helpers (15): `substitute` slot replacement + unmatched-slot survival, `listTemplates`/`getTemplate`, `renderTemplate` with missing-vars reporting, `resolveMessage` (template path, caller override, validation errors).
      - StubEmailTransport (7): send returns receipt, recent newest-first within tenant, tenant scoping (BIL ↔ BANK_DEMO isolation), limit cap, retention cap evicts oldest, template_id + alert/case correlations preserved in ledger, send rejects bad input.
      - Routes (20): templates list happy path + 403, preview happy path + missing_vars + 400 paths, send admin happy path + ledger visible, send 403 for non-admin, every 400 error code, enveloped request body, log tenant scoping (BIL ↔ BANK_DEMO), log limit query param, log 403 for non-admin.
    - **Outcome:** Module 10's primary channel shipped. The BIL deployment now has a tenant-scoped, template-driven, auditable email pipeline. The transport interface keeps SES/SMTP a drop-in swap. The next sub-phase (M10.2 SMS, M10.3 push, M10.4 in-app) follows the same `<Channel>Transport` shape, which means routes can be parameterised.

  - **M8.1 — BIL Red/Orange/Yellow alert classification (2026-05-04):**
    - New `services/bff/src/bil_alert_classification.ts` — pure stateless mapping from `WireSeverity` (LOW|MEDIUM|HIGH|CRITICAL, case-insensitive) to a 4-colour BIL palette per DataNetworks-EWS-Ver1.pdf §11. Mapping: CRITICAL→red, HIGH→orange, MEDIUM→yellow, LOW→green. The BIL doc only colour-codes 3 levels — `green` is added to keep operational LOW alerts on the SPA badge palette without contradicting the spec. Each class carries `{color_hex, label, monitor_only, sla_hours, escalation_path, action_required, source_severities}` so the SPA legend renders directly off the API. SLA hours: red 4h, orange 24h, yellow 72h, green null (monitor-only, no SLA).
    - **3 additive BFF routes** (all tenant-gated, RBAC `alerts:list` — same as `/v1/alerts`, 5 roles):
      - `GET /v1/alerts/classification/spec` — returns the 4-class metadata table for the SPA legend / tooltips.
      - `POST /v1/alerts/classify` — accepts `{severity}` (case-insensitive), returns `{severity, class, metadata}`. Stateless — no alert lookup. Useful for ad-hoc classification (e.g. preview before save).
      - `GET /v1/alerts/by-class/:class` (class ∈ red|orange|yellow|green) — filters the existing alert fleet to alerts whose mapped severity is in the target class. Items are decorated with `bil_class` + `bil_metadata` so the SPA can render badges + SLA chips off a single payload.
    - **The existing `/v1/alerts` response shape is unchanged** — additive only. T4.24 endpoints not modified.
    - **Validation errors:** `EWS_400_invalid_severity` (unknown wire severity), `EWS_400_invalid_class` (path param not in red|orange|yellow|green; lowercase only — uppercase rejected to keep one canonical form).
    - **Tests:** BFF 415/415 (was 379 — +36 in `bil_alert_classification.test.ts`):
      - Pure classifier (8): each WireSeverity → its class, mixed-case acceptance, unknown / non-string rejection.
      - Metadata table (7): canonical order matches `BIL_CLASS_ORDER`, every row has the required fields, only green is `monitor_only` with `sla_hours=null`, SLAs strictly increase red→yellow, source_severities partition the WireSeverity space (no overlap, full coverage), `getClassMetadata` throws on unknown class.
      - `classifyWithMetadata` + `isBilAlertClass` type-guard (4).
      - Routes (17): spec list happy path + 403, classify all-4-severities + lowercase + enveloped body + 3 error paths, by-class filtering for each of the 4 classes, empty fleet, invalid class 400, uppercase rejection, unknown-role 403.
    - **Outcome:** Module 8's BIL-flavour classification shipped. The SPA can now render the BIL tri-colour alert badges (plus the operational green) directly from the API. Future sub-phases — M8.2 alert auto-routing per class, M8.3 alert acknowledgement workflow per class — extend this primitive rather than altering it.

  - **M14.1 — Core Insurance / Policy Master adapter (2026-05-04):**
    - First adapter in Module 14 (External Integration Layer, 50 APIs across 11 upstreams). The existing `/v1/integrations/health` is a probe-only health pinger; M14.1 lands a concrete data-fetch adapter for the BIL Core Insurance / Policy Master / Claims systems so the SPA can render per-customer policy + claim history alongside the indicator panel.
    - New `services/bff/src/integrations/insurance.ts`:
      - `InsuranceAdapter` interface — `listPolicies(tenant, customer, asOf)`, `getPolicy(tenant, policy_id, asOf)`, `listClaims(tenant, customer, asOf)`, `getClaim(tenant, claim_id, asOf)`. The contract a SOAP/REST gateway adapter would satisfy.
      - `StubInsuranceAdapter` — deterministic synthetic data keyed by `(tenant_id, customer_id, day)` via FNV-1a + Mulberry32 (same scheme as `bil_dashboards.ts`). 1-4 policies per customer; 0-3 claims per policy. Tenant baked into both the seed AND the policy/claim id prefix so BIL ↔ BANK_DEMO ids are disjoint.
      - 4 BIL products: `TERM_LIFE`, `ENDOWMENT`, `ULIP`, `GENERAL_HEALTH`. 5 policy statuses (`in_force`, `lapsed`, `cancelled`, `matured`, `pending_uw`) with realistic distribution (~50% in_force). 6 claim statuses (`submitted`, `under_investigation`, `approved`, `paid`, `rejected`, `withdrawn`) with `paid_amount_kes > 0` iff `status === 'paid'`. 7 reason codes from a closed enum.
      - Sum-assured ranges by product: TERM_LIFE 5M-50M KES, ENDOWMENT 1M-10M, ULIP 2M-20M, GENERAL_HEALTH 500k-5M. Annual premium calibrated as 1-3% of sum assured.
      - `getPolicy` / `getClaim` decode the canonical id format (`POL-<TEN>-\d{6}`, `CLM-<TEN>-\d{6}`) and synthesise a self-consistent shape from the id alone — production adapter would hit the Policy Master by id directly.
    - **`AppDeps.insuranceAdapter` injection point** — defaults to the module-level `defaultInsuranceAdapter`. Tests inject a custom adapter to assert error paths (e.g. upstream timeout → 502 envelope).
    - **4 new BFF routes** (all tenant-gated, all enveloped, all RBAC `customers:read_risk_profile` since the data class matches the per-customer risk-profile route):
      - `GET /v1/integrations/insurance/policies?customer_id=X` — list, sorted newest-inception-first. 400 on missing `customer_id`. 502 envelope on adapter throw.
      - `GET /v1/integrations/insurance/policies/:policy_id` — fetch by id. 404 on malformed/unknown id.
      - `GET /v1/integrations/insurance/claims?customer_id=X` — list, sorted newest-filed-first.
      - `GET /v1/integrations/insurance/claims/:claim_id` — fetch by id. 404 on malformed id.
    - **Tests:** BFF 446/446 (was 415 — +31 in `insurance_adapter.test.ts`):
      - StubInsuranceAdapter (16): listPolicies determinism + tenant scoping + sort + 1..4 count bound + every-field-present + rider dedup + lapsed-implies-unpaid invariant + empty-customer guard; getPolicy round-trip + malformed-id null; listClaims invariants (claim links back to policy, paid-iff-paid_amount>0, sort, reason_code enum); getClaim id-preservation + malformed-id null.
      - Routes (15): admin happy paths for all 4 routes, risk_analyst accepted, unknown-role 403, missing-customer-id 400, malformed-id 404, adapter-throw → 502 envelope, tenant scoping (BIL ↔ BANK_DEMO ids disjoint), claims sorted newest-filed-first.
    - **Outcome:** Module 14's first adapter shipped. The SPA can render a customer's BIL policy + claim history in two GET round-trips. The interface keeps a SOAP/REST gateway swap a drop-in. The next adapters (M14.2 IFRS9, M14.3 AML, M14.4 DMS, etc.) follow the same `<Upstream>Adapter` + `Stub<Upstream>Adapter` shape, parameterising routes once a 2nd adapter lands.

## Phase 5 — Optimisation & DR (M18–24)

- [ ] T5.1 Continuous learning pipeline + auto-promotion gate — **agent-ai**
- [ ] T5.2 Aurora Global DB + S3 CRR + MSK MirrorMaker 2 — **agent-integration**
- [ ] T5.3 DR drill runbook + game-day plan — **agent-integration**
- [ ] T5.4 Pen-test brief + remediation playbook — **agent-integration**
- [ ] T5.5 FinOps dashboard (cost-per-alert, cost-per-customer) — **agent-integration**
- [ ] T5.6 BAU runbook + SLOs + on-call rota — **orchestrator**
- [ ] T5.7 Year-2 backlog refresh — **orchestrator**

## Cross-cutting (every phase)

- [ ] X.1 Quarterly access review evidence log — **agent-integration**
- [ ] X.2 Data lineage updated per release — **agent-data**
- [ ] X.3 IaC + container scan green in CI — **agent-integration**
- [ ] X.4 Adoption metrics tracked from Phase 1 — **agent-ui** + **orchestrator**

## Scheduled follow-ups (in-session crons; recipes in memory)

- [ ] **2026-05-16** — Convert existing `/v1/reports` PDF/Excel downloads to client-side (mirror `web/src/lib/scenarioExport.ts`). The MSW handler at `web/src/mocks/handlers.ts /v1/reports/:type` only produces real bytes for CSV; PDF/Excel fall back to JSON, so existing reports PDF/Excel buttons download corrupt files in dev mode. Pattern reference: scenario page (jspdf + jspdf-autotable + write-excel-file/browser, all client-side). Scope: 4 report types (snapshot / alerts / cases / rbi) — each gets its own builder. Decision to flag in PR (don't decide alone): grep for non-SPA callers of the BFF's PDF/Excel paths before recommending deletion. Cron `c8db3fd5`.
- [ ] **2026-05-23** — Build T4.1 Analytics Dashboard suite (4 sub-dashboards: risk trend, PD distribution, stage migration, alert resolution). New SPA page `web/src/modules/reports/AnalyticsDashboardPage.tsx` at `/reports/analytics`. Backend: new `services/bff/src/analytics/` module with one route per sub-dashboard (`/v1/analytics/{risk-trend,pd-distribution,stage-migration,alert-resolution}`), gated by new `analytics:read` RBAC op. Reuse `aggregateStages` + `stageFromPd` from scenario engine. MSW mirror. Decisions to flag in PR: (a) sub-tab of /reports vs sibling top-level entry; (b) alert-resolution chart cumulative vs rolling N weeks. Cron `231b8391`.
- [ ] **2026-05-30** — Wire reserved webhook event types (`alert.updated`, `case.assigned`, `case.closed`) into BFF case lifecycle transitions. Pattern reference: `services/bff/src/server.ts` `/v1/ews/evaluate` already does `webhookDispatcher.dispatch('alert.created', ...)` fire-and-forget. Tests in `services/bff/__tests__/webhooks.test.ts` already have a "fires on transition" pattern via FixedLevelEvaluator. Caveat: depends on Task 8 (case management) maturity — if case lifecycle has materially evolved, align events with new states. Cron `6a1cfb0d`.
