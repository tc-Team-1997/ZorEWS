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

- [x] T4.24 Multi-tenant API foundation + enterprise envelope — Phase 1 + 2 + 3 + 4, sourced from `Banking Api Integration – EWS Full Technical Documentation (1).pdf` §3 (multi-tenant), §6 (envelope), §7 (OAuth), §11 (error shape). Companion to the `DataNetworks-EWS-Ver1.pdf` BIL pitch — multi-tenant context is the prerequisite for serving BIL alongside the BANK_DEMO tenant. **agent-integration** _(Phase 1 shipped 2026-05-03; Phase 2 + 3 partial 2026-05-03 → 2026-05-04; Phase 4 partial 2026-05-04)_
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
  - **Still deferred** (no longer in T4.24 scope; new tickets when picked up):
    - Tag `app_cases.*` / `app_alerts.*` rows with `tenant_id`; tenant-filter at the data-access layer in regulatory-svc.
    - Tag `mart.*` rows with `tenant_id` — domain pivot (needs BIL synthetic data generation).
    - Migrate the operational endpoints (`/v1/webhooks*`, `/v1/rules*`, `/v1/notifications/publish`, `/v1/reports*`, `/v1/integrations/health`, `/v1/cases/sla-summary`) from raw JSON to the bank-grade envelope.
    - Admin SPA pages for tenant CRUD + service client CRUD (analogous to the existing `/admin/webhooks` page).
    - Replace the BFF JWT base64-decode-only shim with proper signature verification via auth-svc's JWKS endpoint.

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
