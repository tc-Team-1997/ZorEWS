# logs/orchestrator.md — orchestrator agent

> Append entries chronologically. Each entry: task id, files touched, decisions, hand-offs, blockers.

## 2026-04-26 — Initialised

- Log file created. Awaiting first task.

## 2026-04-26 — Verification run (host shell)

- **Goal:** clear blockers B1 (sandbox-prevented execution) and B3 (analytical-only FP rates) by running `BOOTSTRAP.md` end-to-end on the host.
- **Toolchain installed:** `python@3.12` (BOOTSTRAP-pinned), `terraform 1.14.9` via `brew tap hashicorp/tap` (HashiCorp pulled core formula on BSL change), `libomp` for xgboost arm64. Venv at `.venv/` with `dbt-postgres 1.8.2`, ML stack, `httpx` (BOOTSTRAP omitted).
- **Steps green (8/9):** 1, 4, 5, 6, 7a, 7b, 8, 9. See STATUS.md verification matrix.
- **Steps blocked:** 2 (Postgres docker), 3 (dbt) — host Docker daemon not yet up at end of session.
- **9 real defects fixed** (caught only because the code ran for the first time):
  - **agent-rule** — `services/regulatory-svc/rules/src/dsl.ts`: Ajv import didn't support draft-2020-12, switched to `Ajv2020`. `__tests__/lifecycle.test.ts` + `__tests__/simulator.test.ts`: fixture `then.title`/`recommended_action` violated `minLength:4`. `__tests__/dsl.test.ts`: `as const` readonly tuples vs `Expr[]` (added `: Expr` annotation); `XYZ-999` indicator id was rejected on schema pattern before catalog check, switched to `FIN-999`.
  - **agent-ui** — `web/src/__tests__/setup.ts`: jsdom 25 + vitest 2.1 exposes a stub `localStorage` without Storage methods; added a Map-backed polyfill. `web/src/__tests__/LoginPage.test.tsx` + `web/src/__tests__/AppShell.test.tsx`: orchestrator's earlier credential reconciliation (`admin/admin123` → `alice.admin/Admin!Pass1`) was applied to `DEMO_USERS` and to LoginPage hint, but never to the tests; updated matchers and submit values to match.
- **Measured KPIs (replace placeholders in STATUS.md):**
  - PD AUC = **0.8822** (synthetic features, B2 retrain still due against `mart.customer_360.has_npa`).
  - Mean rule FP = **0.148** across 30 seed rules; max 0.523.
- **BOOTSTRAP.md gaps to amend later:** missing `npm run gen-history` before `npm run simulate`; `npm run typecheck` script doesn't exist in `web/package.json` (`npm run build` already does `tsc --noEmit`); `services/audit-svc/requirements.txt` doesn't exist — venv libs sufficient; needs `brew install libomp` for xgboost on macOS arm64.
- **Hand-off:** when Docker daemon comes up, orchestrator runs steps 2 + 3 with the resume command block in STATUS.md, then re-trains PD against the materialised mart (clears B2), then closes step 10 KPI update. After that, dispatch agent-case (T3.5) + agent-ui (T2.8/T3.6) + agent-integration (T3.7/T3.8/T3.10) per Wave 3 plan in the prior wrap-up.

## 2026-04-27 — Verification run, day 2 (closes steps 2 + 3 + B2)

- **Goal:** finish what 2026-04-26 left blocked on the Docker daemon.
- **Steps green:** 2 (postgres up + 003 migrations + audit-trigger smoke), 3 (5 seeds → `raw.*`, 9 dbt models, 79/79 dbt tests). All 9 BOOTSTRAP steps now green.
- **Defects fixed:**
  - `data/dbt/macros/generate_schema_name.sql` (new) — added the standard override macro so a model/seed `+schema:` config becomes the literal schema (`raw`, `staging`, `mart`) instead of dbt's default `<target>_<custom>`. Without it `dbt seed` landed in `staging_raw.seed_*` and the staging models pointing at sources `raw.seed_*` failed with `relation does not exist`. Dropped the orphan `staging_raw` schema after re-seeding.
  - `data/dbt/models/staging/schema.yml` — three `accepted_values` tests had `quote: false`, which made dbt render string values as bare SQL identifiers (`column "male" does not exist`). Removed the override on `stg_customer.gender`, `stg_customer.kyc_status`, `stg_bureau_score.score_band`. Those are string columns; default `quote: true` is correct.
  - `ml/data/load_from_mart.py` — SCHEMA_QUERY referenced columns the dbt mart doesn't materialise (`utilization`, `dpd_max_90d`, `balance_drop_30d_pct`, `defaulted_within_60d`, `snapshot_date`). Rewrote it to project the actual mart shape into the contracted feature names: `worst_dpd → dpd_max_90d`, `LEAST(exposure_to_income_ratio,1.5) → utilization`, `arrears_repayment_count → repayment_delay_streak`, derived `tenure_months` from `onboarded_at`, computed `txn_volume_zscore_90d` over the population window-function on `mart.txn_features.txn_count_90d`, mapped `loan_360.product_code` (PL_RET/AUTO_RET/INV_SME/WC_SME/CORP_TL) to PRODUCT_LEVELS, banded `monthly_income` to INCOME_LEVELS, mapped `has_npa::int → defaulted_within_60d`. Also fixed the date-range filter — `mart.customer_360.as_of` is a `timestamptz`, so `BETWEEN '2026-04-27' AND '2026-04-27'` matched zero rows. Cast to `::date` in the WHERE clause.
  - `ml/pipelines/train_pd.py` — XGB hyperparameters were tuned for the 4 000-row synthetic dataset (`min_child_weight=5`, `n_estimators=500`). On the 176-row mart slice with 8 positives no leaf can satisfy `mcw=5`; the tree never splits and the calibrated classifier collapses to a constant predictor, giving holdout AUC 0.5 (despite a plain XGB on the same data hitting 1.0). Added an auto-switch: when `n_positives < 20` the trainer downshifts to `mcw=1, n_estimators=300, max_depth=4`, uses sigmoid (Platt) calibration in place of isotonic (which is data-hungry), and clamps K-fold CV to `min(KFOLDS, n_positives)`. The synthetic-tuned defaults remain the default for the 4 000-row path.
  - Installed `sqlalchemy>=2.0` + `psycopg2-binary` into the venv (the loader's `from sqlalchemy import …` was unsatisfied by the existing `.venv/`).
- **Measured KPIs:**
  - Mart-trained challenger v0.1.0 — AUC 1.0, KS 1.0, Brier 0.0023, CV-AUC 1.0±0.0 on n_train=176 / n_holdout=44 (8 + 4 positives). Registered as challenger; **synthetic-trained 0.8822 model stays champion**.
  - **Caveat (important):** AUC=1.0 is a leakage artifact, not a generalisation claim. `mart.customer_360.has_npa` is defined in dbt as `npa_status IN ('SUBSTANDARD','DOUBTFUL','LOSS')`, and `data/dbt/seeds/_generate_seeds.py` assigns `npa_status` directly off `days_past_due`, which is the same signal as the `dpd_max_90d` feature the model gets. Honest mart evaluation needs either (a) a `has_npa` definition not co-linear with the DPD feature, or (b) `N_CUSTOMERS` bumped well above the current 220 so the trained model can demonstrate ranking ability across more than the 4 holdout positives.
- **BOOTSTRAP.md gaps still pending** (carry from 2026-04-26 + new): (a) `npm run gen-history` missing before `npm run simulate`, (b) `web/package.json` has no `typecheck` script, (c) `services/audit-svc/requirements.txt` missing, (d) `brew install libomp` needed for xgboost on macOS arm64, (e) `data/dbt/macros/generate_schema_name.sql` was missing, (f) `ml/data/load_from_mart.py` was a stub against a phantom mart shape, (g) `train_pd.py` needed a low-positive auto-profile.
- **Hand-off:** verification matrix and Open Blockers in STATUS.md updated. B1, B2, B3 closed. B4 (CI) deferred to Phase 3 T3.8. Wave 3 dispatch (agent-case T3.5; agent-ui T2.8/T3.6; agent-integration T3.7/T3.8/T3.10) is unblocked.

## 2026-04-27 — Wave 3 dispatch begins (T3.5 shipped)

- **Dispatch decision:** with verification fully closed, opened Wave 3 by picking T3.5 first. Rationale: it's the most foundational of the Wave 3 set — T3.6 (Case View UI) depends on it, T3.4 (Collection auto-routing) consumes its events, and unlike T3.8 (schema-registry CI) it's actionable in a non-git prototype. T2.8 (UI risk-profile hookup) is the next logical pick if we want user-visible progress before more backend.
- **T3.5 shipped — agent-case.** New module `services/regulatory-svc/cases/` (sibling to `alerts/`, `rules/`, `indicators/`).
  - **Files:** `package.json`, `tsconfig.json`, `README.md`, `src/{types,case_id,state_machine,store,producer,service,server}.ts`, `__tests__/{state_machine,service,server}.test.ts`.
  - **Numbers:** 26/26 jest tests pass; `tsc -p .` clean; install added 398 npm packages (express, jest, ts-jest, supertest, ts-node, typescript) — same shape as alerts/.
  - **Surface:** `POST /cases` (idempotent on alert_id), `GET /cases` (paged, filterable by state/assignee/customer_id), `GET/POST /cases/:id/{assign,actions,monitor,close}`, `GET /healthz`. Default port 8083.
  - **State machine:** open → assigned → in_action → monitored → closed. logAction re-engages from monitored. Close allowed from any non-closed state. Illegal transitions surface as 409 with `current_state` + `attempted` in the body.
  - **Persistence:** in-memory + NDJSON snapshot at `.store/cases.ndjson`, replays on construction. Restart-survival has a dedicated test.
  - **Producer:** outbox writes typed events (`case.created` | `case.assigned` | `case.action_logged` | `case.monitored` | `case.closed`) to `.outbox/apex.case.events-<date>.ndjson`. Same shape as alerts/OutboxProducer; agent-integration's MSK wiring is a one-line factory swap.
  - **No defects** — first run green. Followed the alerts/ patterns closely (Express factory with injectable deps, deterministic id like `deterministicAlertId`, jest preset config inside package.json).
- **Hand-offs queued:**
  - `agent-integration` — Kafka producer for `apex.case.events` (T3.4 consumes it); include `/cases` in T3.7 public REST API v1; schema-registry entry for `apex.case.events` v1 (T3.8).
  - `agent-ui` — T3.6 Case View can consume the local service at :8083; the action log is the source of truth for the UI's timeline.
  - `agent-rule` / `agent-alert` — the existing alerts/SmartQueue should call `POST /cases` on `close` for high-severity items, or directly on alert emission depending on policy. (Out of scope for T3.5 — leaving as a Wave 3 follow-up.)
- **Next likely picks:** T2.8 (UI risk profile + SHAP top-5) for visible progress, or T3.6 (Case View UI) now that T3.5 is the contract.

## 2026-04-27 — T3.6 Case View UI shipped (agent-ui)

- **Decision:** picked T3.6 next after T3.5 to complete the vertical slice while the case-service contract was still fresh. T2.8 (Risk Profile + SHAP top-5) is the next visible-progress option.
- **Files touched:** `web/src/modules/cases/CaseDetailPage.tsx` (new, 380 lines), `web/src/modules/cases/CaseListPage.tsx` (state-name rename + clickable rows), `web/src/lib/api.ts` (CaseDetail/CaseAction/LogActionInput types + 5 new api fns), `web/src/mocks/handlers.ts` (new GET + 4 POST handlers backed by an in-memory state machine that mirrors the backend), `web/src/mocks/data.ts` (caseDetails seed + caseSummariesFrom derivation), `web/src/App.tsx` (`/cases/:id` route), `web/src/__tests__/CaseDetailPage.test.tsx` (new, 8 tests).
- **Defects fixed during build:** one tsc error — `CaseDetail extends CaseSummary` requires `age_min`, but the detail mock only carries `created_at`. Made `CaseDetail` a sibling type (not extending) so age is computed only at the list-row layer (`caseSummariesFrom`).
- **State-name unification:** dropped the UI-only `'action'` enum value in favour of `'in_action'` so the list, detail, MSW mocks, and `services/regulatory-svc/cases` all share one vocabulary. The BFF (T3.10) does no rename.
- **Mock BFF parity with backend:** `web/src/mocks/handlers.ts` now embeds the same allowed-transitions table as `services/regulatory-svc/cases/src/state_machine.ts` and returns HTTP 409 with `current_state` + `attempted` on illegal transitions. The UI's `HttpError` surface for cases matches what the real service will return.
- **Numbers:** 19 web tests pass (8 new + 11 pre-existing); `tsc --noEmit` clean; `vite build` clean (770 KB bundle, same magnitude as before).
- **Visual verification gap (called out):** I did not start `npm run dev` and exercise the page in a real browser — vitest + jsdom cover rendering + interactions but not actual styling / responsive layout. Recommended a manual smoke before demoing.
- **Hand-offs:** `agent-integration` (T3.10) swaps the MSW handlers for a real proxy to the cases service on :8083; `agent-ui` next picks T2.8 (Customer Risk Profile SHAP top-5).

## 2026-04-27 — T2.8 SHAP hookup shipped (agent-ui)

- **Picked T2.8 next** to close the Phase-2 deferred carry-over before continuing into deeper Phase-3 work (T3.7 / T3.10 / T3.8 / T3.4). It's the third agent-ui task in this session.
- **Files touched:** `web/src/lib/api.ts`, `web/src/mocks/data.ts`, `web/src/modules/customers/CustomerRiskProfilePage.tsx`, `web/src/__tests__/CustomerRiskProfilePage.test.tsx`.
- **Defects fixed:** none — the existing page already had the PD score and a placeholder reasons panel; T2.8 replaced the placeholder with a real SHAP rendering aligned to `services/ai-copilot-svc/app/main.py:ReasonCode`.
- **Numbers:** 22/22 web tests pass (3 new); tsc + vite build clean.
- **Visual verification gap:** same caveat as T3.6 — vitest covers rendering and ordering, but no real-browser smoke. Recommend a 60-second click-through at the end of the session: login, `/customers/c-101`, eyeball the diverging bars + model footer; `/customers/c-102` to see the categorical feature row.
- **Hand-off:** `agent-integration` T3.10 BFF can now wire `/api/customers/:id/risk` straight to ai-copilot-svc `/score` — UI shape matches.
- **Wave 3 status update:** T3.5 (case service) ✅, T3.6 (case UI) ✅, T2.8 (risk-profile SHAP) ✅. Remaining: T3.7 (public REST API v1), T3.10 (BFF mapping), T3.8 (schema-registry CI — closes B4), T3.4 (Collection auto-routing on apex.case.events), T3.1–T3.3 (CBS/IFRS9/AML deepening), T3.9 (RBAC matrix).

## 2026-04-27 — T3.10 BFF shipped (agent-integration)

- **Picked T3.10** to close the round-trip: T3.5 (case service) + T3.6 (case UI) + T2.8 (risk-profile SHAP shape) all aligned on contracts; T3.10 is the missing infra piece that lets the SPA actually read those contracts from a real backend instead of MSW.
- **Files touched:** new module `services/bff/` (sibling to `services/regulatory-svc/{alerts,cases,rules,indicators}`, `services/ai-copilot-svc`, etc.). Files: `package.json`, `tsconfig.json`, `README.md`, `src/{types,mapping,lookups,source,server}.ts`, `__tests__/{mapping,server}.test.ts`.
- **Mapping coverage** — pure `mapAlertEvent(canonical, lookups, now?)`: severity case-fold, customer + rule name join with id-fallback, age computed and clock-skew-clamped, assignee pulled from a snapshot lookup, schema renames applied. Plus a `mapAlertList` that sorts newest-first and dedupes on alert_id (last-write-wins so at-least-once Kafka doesn't double-count).
- **Source plumbing** — `OutboxSource` reads NDJSON from `services/regulatory-svc/alerts/.outbox/`; `StaticSource` for tests; `AlertSource` interface is what the future MSK kafkajs consumer plugs into (one-line factory swap).
- **Numbers:** 20/20 jest tests pass; `tsc -p .` clean; install added 398 npm packages (same shape as alerts/cases).
- **No defects fixed during build** — first run green. Followed the alerts/ + cases/ patterns closely (Express factory with injectable deps, NDJSON outbox parsing mirrors OutboxProducer, jest preset config inside package.json).
- **Wave 3 progress:** T3.5 ✅ T3.6 ✅ T2.8 ✅ T3.10 ✅. Remaining: T3.7 (public REST API v1), T3.8 (Glue Schema Registry CI — closes B4), T3.4 (Collection auto-routing on apex.case.events), T3.1–T3.3 (CBS/IFRS9/AML deepening), T3.9 (RBAC matrix). Natural next pick: T3.7 (BFF surface extension to /api/cases/* + /api/customers/:id/risk) or T3.8 (closes the last open blocker).

## 2026-04-27 — T3.7 public REST API v1 shipped (agent-integration)

- **Continued in services/bff/ rather than spinning up a new api-gateway** — `/api/*` (SPA) and `/v1/*` (partners) share the same alert source, lookups, and mapping pipeline; carving them apart would duplicate infra without prototype value.
- **Endpoints added:** `GET /v1/alerts` (alias of /api/alerts), `POST /v1/ews/evaluate`, `GET /v1/risk-profile/:customer_id`, `POST /v1/action`. Each backed by a stub now and an interface that production wiring slots into.
- **`/v1/action` HTTP-proxies to the cases service** via Node 18 global fetch, configurable through `APEX_CASES_URL`. Forwards upstream HTTP status verbatim — a 409 illegal-transition from the cases service surfaces as a 409 to the public-API caller, with `current_state` + `attempted` preserved in the body.
- **Numbers:** 32/32 jest tests pass in the bff (12 new on /v1); tsc clean. No regressions.
- **No defects fixed during build** — first run green.
- **Wave 3 progress this session:** T3.5 ✅ T3.6 ✅ T2.8 ✅ T3.10 ✅ T3.7 ✅. Five tasks done.
- **Remaining Wave 3:** T3.8 (Glue Schema Registry CI — closes B4, the last open blocker), T3.4 (Collection auto-routing consumer of apex.case.events), T3.1–T3.3 (CBS/IFRS9/AML deepening), T3.9 (RBAC matrix).

## 2026-04-27 — T3.8 shipped, B4 closed (agent-integration)

- **All 4 listed blockers (B1, B2, B3, B4) are now resolved.** B1 + B3 closed yesterday; B2 closed earlier today (with the leakage caveat); B4 closes now.
- **Files added:**
  - `infra/schema-registry/scripts/check_compat.py` — pure-Python BACKWARD checker, validates draft 2020-12, walks all `*.json`, flags six classes of break with JSON pointers.
  - `infra/schema-registry/tests/test_check_compat.py` — 16 pytest tests (positive + negative + recursion + malformed input), all green.
  - `.github/workflows/schema-compat.yml` — CI gate on every PR touching `infra/schema-registry/**`.
  - `infra/terraform/30-data/main.tf` (extended) — `aws_glue_registry.apex_ews` + `aws_glue_schema.topics` auto-discovered via `fileset` + `jsondecode(file(...)).title`. Compatibility mode = BACKWARD on every registered schema.
  - `infra/terraform/30-data/outputs.tf` — `glue_schema_registry_arn` + `glue_schema_arns` map.
- **No defects fixed during build** — first run green. Real registry walks clean: `BACKWARD-compat OK — 7 schema(s) across 6 topic(s); 1 version-pair(s) checked.`. `terraform fmt` + `terraform validate` clean.
- **Wave 3 progress this session:** T3.5 ✅ T3.6 ✅ T2.8 ✅ T3.10 ✅ T3.7 ✅ T3.8 ✅. Six tasks done end-to-end. All four blockers closed.
- **Remaining Wave 3:** T3.4 (Collection auto-routing on apex.case.events), T3.1–T3.3 (CBS/IFRS9/AML deepening), T3.9 (RBAC matrix). Of these, T3.4 is the most actionable next pick — it directly consumes the `apex.case.events` outbox the cases service already writes, completing the alert-to-Collection round-trip.

## 2026-04-27 — T3.4 collection-adapter shipped

- **What landed:** `services/collection-adapter/` — TS + Express + Jest, port 8085. Implements both halves of T3.4: routing case events to a Collection outbox (`apex.collection.routes`), and a `POST /collection/callback` endpoint that proxies status reports to the cases service `/close`.
- **Numbers:** 19/19 jest tests pass on first run; tsc clean.
- **Defect surfaced (not fixed):** `infra/schema-registry/apex.case.events.v1.json` doesn't match what `services/regulatory-svc/cases` actually emits. The schema requires `occurred_at` + `lifecycle_state ∈ {ALERT, CASE, ...}`; the emitter writes `ts` + `event_type ∈ {case.created, ...}` + `prior_state`/`new_state`/`payload`. The collection-adapter consumes the live emitter shape, so T3.4 works end-to-end, but the schema needs a v2 bump (or the emitter needs to be rewritten). Documented in logs/integration.md as a follow-up.
- **Wave 3 progress this session:** T3.5 ✅ T3.6 ✅ T2.8 ✅ T3.10 ✅ T3.7 ✅ T3.8 ✅ T3.4 ✅. Seven tasks. All blockers (B1/B2/B3/B4) closed.
- **Remaining Wave 3:** T3.1 (CBS deepening), T3.2 (IFRS 9 stage-movement signal), T3.3 (AML correlation), T3.9 (RBAC matrix doc). T3.1–T3.3 are agent-integration deepening tasks that rely on real bank contracts (out of prototype scope per `project_apex_ews_scope.md`); T3.9 is a doc + RBAC stub task that can land at any time.

## 2026-04-27 — Schema/emitter alignment + AJV emit-side validation (defect from T3.4 closed)

- **The defect surfaced during T3.4 is fixed.** Rewrote `infra/schema-registry/apex.case.events.v1.json` in place (kept version 1.0.0 because v1 had no Glue resource yet — pre-implementation scaffold). New v1 matches `services/regulatory-svc/cases/src/types.ts:CaseEvent` exactly: required fields `event_id`, `event_type` (`case.created` | `case.assigned` | `case.action_logged` | `case.monitored` | `case.closed`), `ts`, `case_id`, `alert_id`, `customer_id`, `new_state` (`open` | `assigned` | `in_action` | `monitored` | `closed`); optional `prior_state` (nullable); free-form `payload`; top-level `additionalProperties: false`.
- **Added `services/regulatory-svc/cases/src/event_validator.ts`** — Ajv2020 compiled from the registered schema, called by `service.ts:emit` before every write. Future drift throws `CaseEventSchemaError` at emit time. Belt-and-braces: T3.8 CI catches schema-vs-schema drift, this catches schema-vs-emitter drift.
- **Numbers:** 31/31 cases jest tests pass (5 new); T3.8 CI re-runs clean (`BACKWARD-compat OK — 7 schemas, 6 topics, 1 pair`); 16/16 schema-registry pytest; tsc clean.
- **Wave 3 progress this session:** T3.5 ✅ T3.6 ✅ T2.8 ✅ T3.10 ✅ T3.7 ✅ T3.8 ✅ T3.4 ✅ + schema-fix ✅. All four blockers (B1–B4) closed. Eight Wave-3-or-tightly-related tasks done.
- **Remaining Wave 3:** T3.1 (CBS deepening), T3.2 (IFRS 9 stage-movement signal), T3.3 (AML correlation), T3.9 (RBAC matrix). Per `project_apex_ews_scope.md` T3.1–T3.3 are out of prototype scope (real bank integrations); T3.9 is the only clean remaining pick.

## 2026-04-27 — T3.9 RBAC matrix + access review shipped — Wave 3 wrap

- **What landed:**
  - `infra/rbac/matrix.json` — canonical RBAC matrix. 5 roles × 27 ops.
  - `infra/rbac/README.md` — permission table + full quarterly-review process doc.
  - `infra/rbac/scripts/access_review.py` + 11 pytest tests — validator + report generator + CLI.
  - `infra/rbac/scripts/sample_roster.json` — local-dev roster matching auth-svc seeds.
  - `infra/rbac/lib/` — TS package `@apex-ews/rbac` (loadMatrix, can, operationsFor, requireRole middleware) + 13 jest tests.
- **Numbers:** 24 new tests (11 pytest + 13 jest), all green; tsc clean; `terraform validate` still clean (didn't touch terraform).
- **Wave 3 progress this session:** T3.5 ✅ T3.6 ✅ T2.8 ✅ T3.10 ✅ T3.7 ✅ T3.8 ✅ T3.4 ✅ + schema-fix ✅ + T3.9 ✅. **Nine tasks done end-to-end.** All four blockers closed.
- **Remaining in TASKS.md Wave 3:** T3.1 (CBS deepening), T3.2 (IFRS 9 stage-movement signal), T3.3 (AML correlation). Per `project_apex_ews_scope.md`, these are **out of prototype scope** — they require real bank integrations (production deploy / real bank integrations are explicitly off-table). Marking Wave 3 effectively complete for prototype purposes.
- **Total artefacts shipped this session:**
  - 4 new TS services: `services/regulatory-svc/cases/`, `services/bff/`, `services/collection-adapter/`, `infra/rbac/lib/`.
  - 1 new Python module: `infra/rbac/scripts/`.
  - 1 schema rewrite + 1 schema CI gate: `infra/schema-registry/apex.case.events.v1.json` + `.github/workflows/schema-compat.yml` + `infra/schema-registry/scripts/check_compat.py`.
  - Terraform: `aws_glue_registry` + auto-discovered `aws_glue_schema.topics` in `infra/terraform/30-data`.
  - UI: `web/src/modules/cases/CaseDetailPage.tsx`, refreshed `CaseListPage`, refreshed `CustomerRiskProfilePage` SHAP panel, MSW mocks aligned to backend state machine.
  - ML: `ml/data/load_from_mart.py` rewritten to project the actual mart shape; `ml/pipelines/train_pd.py` low-data auto-profile.
  - dbt: `data/dbt/macros/generate_schema_name.sql` + `accepted_values` schema fix.
  - Postgres: docker stack live, 3 mart models materialised, 79 dbt tests green.
  - Verified: 9/9 BOOTSTRAP steps, B1/B2/B3/B4 all closed.
- **Test posture:**
  - cases/cases jest — 31 tests pass.
  - bff jest — 32 tests pass.
  - collection-adapter jest — 19 tests pass.
  - rbac jest — 13 tests pass.
  - schema-registry pytest — 16 tests pass.
  - rbac pytest — 11 tests pass.
  - web vitest — 22 tests pass.
  - **Total this session: 144 new/refreshed tests, all green.**

## 2026-04-27 — RBAC enforced at HTTP layer + matrix CI gate

- **Decision:** turning the RBAC matrix into a runtime guard, not just docs. Wired `@apex-ews/rbac` into the cases service first because that's the most state-machine-heavy surface (`cases:close` is supervisor/admin/collection-only — risk_analyst can no longer close).
- **Files added/changed:**
  - `services/regulatory-svc/cases/src/server.ts` — every route now sits behind `requireRole('cases:<op>')`. `getRole` is injectable so tests can use `() => 'admin'` and skip the header dance.
  - `services/regulatory-svc/cases/__tests__/rbac.test.ts` (new) — 8 tests asserting matrix enforcement.
  - `infra/rbac/lib/src/index.ts` — matrix-path fallback so the same source works under `lib/src/` (ts-jest) and `lib/dist/src/` (consumer imports).
  - `.github/workflows/rbac-matrix.yml` (new) — gate the matrix on every PR. `validate-matrix` runs the python validator + 11 pytest tests; `validate-ts-helper` builds + tests `@apex-ews/rbac`.
- **Defects fixed during build:** one round-trip:
  1. Imported rbac/lib from source path → tsc complained that the file was outside rootDir.
  2. Switched to importing from `dist/src/index` → ts-jest crashed at runtime because the compiled `__dirname` is one level deeper than the source path, breaking `DEFAULT_MATRIX_PATH = path.resolve(__dirname, '..', '..', 'matrix.json')`.
  3. Added `findDefaultMatrixPath()` that walks up the dir tree — both layouts now resolve to `infra/rbac/matrix.json`.
- **Numbers:** 39/39 cases jest (8 new RBAC tests); 13/13 rbac jest; 11/11 rbac pytest; tsc clean for both. CI workflow yaml is well-formed (not run yet — no GH Actions trigger in this prototype env).
- **Wave 3 progress this session:** T3.5 ✅ T3.6 ✅ T2.8 ✅ T3.10 ✅ T3.7 ✅ T3.8 ✅ T3.4 ✅ + schema-fix ✅ + T3.9 ✅ + RBAC-enforcement ✅ + matrix-CI ✅. **Eleven discrete pieces of work end-to-end.**
- **Next likely picks** (if the user continues): adopt `requireRole` in bff (`/v1/action`) and collection-adapter (`/collection/callback`); add a unified `services-ci.yml` workflow that runs jest + tsc on every TS service touched in a PR; swap `defaultGetRole` to a JWT-claim extractor once auth-svc issues real tokens in dev.

## 2026-04-27 — RBAC rolled out everywhere + services-ci.yml

- **bff + collection-adapter** now both consume `@apex-ews/rbac` the same way cases does. Three lines per service: import, defaultGetRole, requireRole factory. Plus per-route `requireRole('<op>')` wrap.
- **bff guards:** `alerts:list`, `customers:read_risk_profile`, `cases:log_action` — all from the matrix.
- **collection-adapter guards:** `collection:callback` for the public callback; `/process` is admin-only via inline check (not in matrix because it's diagnostic, not a published operation).
- **services-ci.yml** — unified workflow gating PRs that touch services/web/rbac. rbac-lib builds first → 8-service matrix downloads its dist → web independently. Each service runs `npm ci && npm test && npm run build`.
- **Numbers this slice:** 9 new bff RBAC tests + 8 new collection-adapter RBAC tests + 1 new workflow file. **bff: 41/41, collection-adapter: 27/27, cases: 39/39, rbac/lib: 13/13** (TS); rbac/scripts: 11/11, schema-registry: 16/16 (Python). All clean.
- **Caveat:** GitHub Actions yamls are committed but not running in CI yet — no GH remote in this prototype env. The yaml is well-formed and locally-equivalent commands pass.
- **Session totals: 13 discrete pieces of work end-to-end** — T3.5 / T3.6 / T2.8 / T3.10 / T3.7 / T3.8 / T3.4 / schema-fix / T3.9 / RBAC-cases / matrix-CI / RBAC-bff+collection / services-CI.
- **Real next picks if the user keeps going:** swap `defaultGetRole` from header-reader to JWT-claim extractor (needs auth-svc to issue tokens in dev); adopt RBAC in alerts/rules/indicators (3-line each); wire web SPA to send `x-apex-role` header on requests through the existing axios interceptor; add a `terraform fmt && terraform validate` workflow for the IaC layers.

## 2026-04-27 — Front-to-back RBAC enforcement live

- **alerts service** now matches cases/bff/collection-adapter — every operator route guarded by `requireRole('alerts:*')` against the matrix; producer-only `/alerts/evaluate` is admin-inline.
- **SPA interceptor** sends `x-apex-role` alongside the Bearer token. The full path SPA → bff → backend services is now matrix-enforced at every hop.
- **Pre-existing defect found + fixed:** `services/regulatory-svc/alerts/src/schemas.ts` used default `Ajv` (draft-07) against draft-2020-12 schemas. Same defect pattern fixed in `rules/dsl.ts` during the verification day, but the alerts variant slipped through because BOOTSTRAP step 6 only exercised rules. Now caught (the new services-ci.yml will catch it on PRs).
- **Numbers this slice:** alerts 40/40 (8 new RBAC + 7 unblocked by AJV fix); web 27/27 (5 new). `tsc` + `vite build` clean.
- **Session totals: 14 discrete pieces of work end-to-end** — Wave 3 + RBAC rollout (cases/bff/collection-adapter/alerts) + matrix CI + services CI + SPA interceptor + AJV-defect fix.
- **Test posture across the codebase:**
  - cases jest: 39/39
  - alerts jest: 40/40
  - bff jest: 41/41
  - collection-adapter jest: 27/27
  - rbac/lib jest: 13/13
  - rbac/scripts pytest: 11/11
  - schema-registry pytest: 16/16
  - web vitest: 27/27
  - **214 tests pass across the codebase.**
- **Remaining naturally-actionable picks (none of them blocking):** adopt RBAC in regulatory-svc/rules + indicators (5-min each), auth-svc, and notification-svc; add a `terraform fmt + validate` workflow for IaC; swap the SPA's `roles[0]` heuristic for proper multi-role handling once any user has more than one role (DEMO_USERS all have single roles today).

## 2026-04-27 — RBAC rollout completes regulatory-svc (rules + indicators)

- **rules service:** routes guarded per matrix (`rules:list/read/create/simulate` + `rules:retire` for promote/retire + `audit:read` for audit). `makeApp` refactored from positional arg to deps-object with back-compat. tsconfig `rootDir` dropped. 31/31 jest; tsc clean.
- **indicators service:** `/indicators/compute` + `/compute/batch` admin-only inline (system endpoints, not in matrix); catalog + healthz open. 7 new RBAC tests pass; tsc clean.
- **Pre-existing test drift surfaced (not RBAC-related):** indicators catalog grew 30→32 since the original tests; `batch.test.ts` + `registry.test.ts` + `compute/transaction.test.ts` carry stale assertions. 6 tests fail. Out of scope for the RBAC slice; tracked in STATUS.md for agent-indicator follow-up. The new `services-ci.yml` workflow will keep this kind of drift visible going forward.
- **End-to-end RBAC posture (final):** every TS service except auth-svc (deliberate, login is pre-auth) and notification-svc (no operator endpoints yet) enforces the matrix at HTTP layer. SPA → x-apex-role → service. JWT-claim swap is the production change at both ends.
- **Session totals: 16 discrete pieces of work end-to-end** — Wave 3 (T3.5 / T3.6 / T2.8 / T3.10 / T3.7 / T3.8 / T3.4 / T3.9) + schema-fix + RBAC-rollout × 5 services (cases / bff / collection-adapter / alerts / rules / indicators) + matrix-CI + services-CI + SPA interceptor + AJV-defect-fix.
- **Test posture this session:**
  - cases jest: 39/39
  - alerts jest: 40/40
  - bff jest: 41/41
  - collection-adapter jest: 27/27
  - rules jest: 31/31 (8 new RBAC)
  - indicators jest: 74/81 (7 new RBAC pass; 7 pre-existing fail on catalog drift, separately tracked)
  - rbac/lib jest: 13/13
  - rbac/scripts pytest: 11/11
  - schema-registry pytest: 16/16
  - web vitest: 27/27
  - **Total clean: 282 tests pass; 7 pre-existing tests broken on stale catalog assertions.**

## 2026-04-27 — Indicator catalog test drift cleared (closes the 7 pre-existing fails)

- **What:** the catalog grew 30 → 32 indicators (8 per family across FIN/BEH/TXN/CRD); test assertions hardcoded 30 and were stale. Replaced hardcoded counts with derived assertions:
  - `batch.test.ts` — `CATALOG_SIZE = loadCatalog().indicators.length` constant; every `.toHaveLength(30)` → `.toHaveLength(CATALOG_SIZE)`.
  - `registry.test.ts` — drop the magic-number tests entirely. New checks: (a) family coverage with `>= 6 per family` and the four expected family ids, (b) `COMPUTE_REGISTRY size === catalog.indicators.length` (the real invariant, no magic number).
  - `compute/transaction.test.ts` — TXN-002 z-score test had a flat 80k baseline (zero variance) + a spike, expecting z ≥ 3. Compute fn correctly short-circuits when stddev=0. Jittered the baseline ±2k for non-zero variance. Compute fn behaviour unchanged.
- **Numbers:** indicators jest 74/81 → 81/81. tsc still clean.
- **Final clean test posture across the entire codebase this session:**
  - cases jest: 39/39
  - alerts jest: 40/40
  - bff jest: 41/41
  - collection-adapter jest: 27/27
  - rules jest: 31/31
  - indicators jest: **81/81** (now clean)
  - rbac/lib jest: 13/13
  - rbac/scripts pytest: 11/11
  - schema-registry pytest: 16/16
  - web vitest: 27/27
  - **Total: 326 tests pass clean across the codebase. Zero failing tests.**
- **Session totals: 17 discrete pieces of work end-to-end.**

## 2026-04-27 — terraform-ci.yml shipped (CI gate story complete)

- **`.github/workflows/terraform-ci.yml`** — two jobs:
  - `validate` matrix on the 5 IaC layers (00-landing-zone / 10-network / 20-eks / 30-data / 40-edge): `terraform fmt -check`, `terraform init -backend=false`, `terraform validate`.
  - `fmt-tree` recursive fmt across the whole `infra/terraform/` subtree to catch stray .tf files outside the layered structure.
- Locally verified: all 5 layers pass `fmt -check` and `validate` clean. Recursive fmt on the whole subtree is also clean.
- **Four CI workflows now in place**, gating every PR end-to-end:
  - `schema-compat.yml` — T3.8 BACKWARD-compat checker + 16 pytest tests on the schema registry.
  - `rbac-matrix.yml` — T3.9 matrix self-consistency + 11 pytest tests + the @apex-ews/rbac helper build.
  - `services-ci.yml` — 8 TS services + web SPA jest/vitest/tsc/vite.
  - `terraform-ci.yml` — 5 IaC layers fmt/init/validate.
- **Caveat:** workflows are not running in CI (no GH remote in this prototype env). All commands run clean locally.
- **Session totals: 18 discrete pieces of work end-to-end.**

## 2026-04-27 — Top-level Makefile + README + .gitignore

- **Why:** the Path B local-run recipe was 60 lines of bash spread across 7 terminals. New devs onboarding to the prototype shouldn't have to reverse-engineer that. Same logic for `make ci` mirroring the four GH workflows — local feedback loop should match CI 1:1.
- **Files:**
  - `Makefile` (top-level) — install / test / build / lint / ci / up / down / smoke / ps / logs / web-dev. Service registry encoded as `name:path:port` triples; `make up` writes PIDs to `.pids/<name>.pid` and logs to `.logs/<name>.log`; `make down` kills tracked PIDs cleanly; `make smoke` curls /healthz on each running port.
  - `README.md` (top-level) — orientation page. What's shipped, quick-start for Path A (`make web-dev`) + Path B (`make up && make smoke`), repo layout tree, CI gates table, links to STATUS/AGENTS/TASKS/BOOTSTRAP.
  - `.gitignore` — covers everything that gets generated (build artefacts, .venv, dbt target, terraform state, Make's .pids/.logs, service runtime .outbox/.store/.queue, .env.local).
- **Verified locally:** `make help` prints; `make lint` runs clean (terraform fmt + per-layer validate, 5/5 green).
- **Caveat:** workflows are not running in CI (no GH remote). Same for everything in this session.
- **Session totals: 19 discrete pieces of work end-to-end.**

## 2026-05-14 — T6 M12.5 — Report job analytics

### Tasks ticked
- T6 sub-phase M12.5 — report job analytics. T6 sub-phase tally 103 → 104.

### Files touched
- `services/bff/src/report_job_analytics.ts` (new) — pure `summarizeReportJobs(jobs)` returning `ReportJobAnalytics`: sample_size, by_status (all 4 keys), by_format (only observed keys), per_report (job_count + completed/failed + success_rate + mean_processing_ms; sorted by job_count desc → report_id asc), top_requesters (cap 10, by_count desc → name asc), processing_ms min/mean/p50/p95/max via M3.5 `linearPercentile`, success_rate (completed/(completed+failed)), last_failure (newest by `requested_at`).
- `services/bff/__tests__/report_job_analytics.test.ts` (new) — 15 jest tests: 11 unit (empty input, status mix, format mix, success_rate denominator, processing-ms percentiles ignoring non-completed, per-report rollup + tie-break, top_requesters cap, last_failure newest, last_failure null) + 4 route (200 empty, 200 with submitted job, 403 wrong role, cross-tenant isolation).
- `services/bff/src/server.ts` — import `summarizeReportJobs`; new route `GET /v1/reports/jobs/analytics` mounted BEFORE `/v1/reports/jobs/:job_id` so the literal "analytics" segment isn't captured as a job_id. Filters: `?status=` (validated against `isJobStatus`, 400 on invalid) + `?report_id=` (free string). Pulls up to 200 jobs from the store and runs the resolver.

### Decisions
- **Route order matters.** The existing `/v1/reports/jobs/:job_id` is a wildcard; the analytics route must be registered first. Confirmed via test — `GET /v1/reports/jobs/analytics` returns 200 (zero envelope) on an empty store, not 404 from the `:job_id` handler.
- **success_rate denominator excludes queued/running.** Matches the M3.5 connector-analytics posture (in-flight is reported separately, not folded into rate).
- **last_failure by requested_at (not completed_at).** completed_at can be null on failed jobs; requested_at always exists.
- **Top requesters cap 10.** Same posture as the M11.x leaderboard convention.
- **No new store.** Derived from M12.1's existing job tracker.

### Hand-offs
- **agent-ui** — supervisor "reports activity" panel can drive against `GET /v1/reports/jobs/analytics`. Envelope: `{ analytics: ReportJobAnalytics, sample_total }`. `top_requesters` is already a leaderboard, `per_report` is sorted highest-traffic first.

### Verification
- `npx jest __tests__/report_job_analytics.test.ts` — 15/15 pass.
- `npx jest` (full BFF suite) — 4124 pass / 58 skipped / 4182 total, **zero failures** (no cross-suite flakiness on this run).
- `npx tsc --noEmit` — clean.

## 2026-05-14 — T6 M6.9 — Weight preset definition diff

### Tasks ticked
- T6 sub-phase M6.9 — weight preset definition diff. T6 sub-phase tally 105 → 106.

### Files touched
- `services/bff/src/scoring_preset_diff.ts` (new) — pure `diffWeightPresets(from, to)` returning `WeightPresetDiff`: `{from_id, to_id, identical, header: {name, description, vertical, mode} each as HeaderDiff<T>, multipliers: {added[], removed[], changed[] (with delta), unchanged_count}}`. Added/removed sorted asc by indicator_id; changed sorted by abs(delta) desc with alphabetical tie-break. Sparse-map semantics preserved (an indicator only in one side is `added`/`removed`, not "changed from implicit 1.0").
- `services/bff/__tests__/scoring_preset_diff.test.ts` (new) — 17 jest tests: 10 unit (identical-presets edge, header-only change, added/removed/changed buckets, sort orders, sparse-map semantics, multi-header diff, real library preset diff) + 7 route (200 lib-vs-lib, 200 identical, 200 lib-vs-custom resolved via tenant store, 404 unknown_preset, 400 missing query param, 403 wrong role, 404 cross-tenant on custom preset).
- `services/bff/src/server.ts` — import `diffWeightPresets`; new route `GET /v1/scoring/presets/diff?from=&to=` (`customers:read_risk_profile`; mounted BEFORE `/v1/scoring/presets/:id` so the literal "diff" segment isn't captured as an id). Both ids resolved via the existing `getEffectiveWeightPreset(store, tenant, id)` helper so library AND custom presets are diffable in any combination.

### Decisions
- **Sparse-map semantics.** An indicator present only in one side is `added` or `removed`, not "changed from 1.0 → x". The diff reflects what the operator actually typed, not the inferred default. Matches how the SPA author-tweak UX thinks about the data.
- **Sort by abs(delta) desc.** Biggest changes first — that's what a risk officer scans for.
- **Reuse `getEffectiveWeightPreset` for both ids.** Library + custom diffable in any direction (lib-lib, lib-custom, custom-custom, custom-lib).
- **`customers:read_risk_profile` RBAC.** Matches the existing M6.x route convention.

### Hand-offs
- **agent-ui** — preset author UX can call `GET /v1/scoring/presets/diff?from=preset_banking_balanced&to=<draft_id>` while the operator is editing a custom preset; the response is the SPA's "compared with the platform default" panel. Envelope: `{ diff: WeightPresetDiff }`.

### Verification
- `npx jest __tests__/scoring_preset_diff.test.ts` — 17/17 pass.
- `npx jest` (full BFF suite) — 4162 pass / 58 skipped / 4222 total. Intermittent cross-suite singleton flakiness in `adapter_sla_dashboard` / `case_maker_checker` — both pass when run alone or together (136/136); pre-existing pattern unrelated to M6.9.
- `npx tsc --noEmit` — clean.

## 2026-05-14 — T6 M16.12 — Scenario bulk delete

### Tasks ticked
- T6 sub-phase M16.12 — scenario bulk delete. T6 sub-phase tally 107 → 108.

### Files touched
- `services/bff/src/server.ts` — new route `POST /v1/scenarios/library/custom/bulk-delete` mirroring the M16.9 bulk-clone shape: validates `preset_ids[]` (non-empty, cap 10), iterates and `customPresetStore.get` → `delete` each, captures previous-state metadata for the audit event before delete. Per-row outcomes: `deleted[] {preset_id, name}` / `skipped[] {preset_id, reason}` where reasons are `invalid_id` (non-string / empty) or `unknown_preset` (not in tenant's store, covers cross-tenant). Best-effort `scenario.delete` audit event per successful delete with `bulk:true` marker and the same `{previous_name, previous_severity, bulk:true}` metadata shape M16.9 uses. Mounted BEFORE `DELETE /:preset_id` so the literal "bulk-delete" segment isn't captured as a preset_id by the wildcard.
- `services/bff/__tests__/scenario_bulk_delete.test.ts` (new) — 10 jest tests: 3 validation (empty / over-cap / 403 wrong role), 3 happy paths (all-valid / mixed valid+unknown / non-string-ids→invalid_id), 2 audit (event written per success with bulk:true / no event for skipped rows), 1 tenant isolation (cross-tenant id surfaces as unknown_preset; foreign preset stays intact), 1 route ordering (bulk-delete segment routes correctly, not captured by `:preset_id`).

### Decisions
- **Mirror M16.9 exactly.** Same `{preset_ids[]}` body, same cap 10, same per-row outcome shape, same audit event shape with `bulk:true`. SPA can reuse the existing bulk-clone result viewer with no shape changes.
- **Cross-tenant → unknown_preset, not error.** A cross-tenant id is indistinguishable from a non-existent id from the caller's perspective; treating it as a per-row skip rather than a global error keeps partial-success behavior consistent.
- **Capture metadata BEFORE delete.** Same as the single-delete route. The audit event's `previous_name` + `previous_severity` are unrecoverable post-delete.
- **`customers:read_risk_profile` RBAC.** Matches the existing M16.x route convention.

### Hand-offs
- **agent-ui** — multi-select rows on `/scenarios/custom` → `POST .../bulk-delete` → render per-row result strip (reuse the M16.9 bulk-clone outcome viewer; deleted entries show with strike-through, skipped rows show their reason inline).

### Verification
- `npx jest __tests__/scenario_bulk_delete.test.ts` — 10/10 pass.
- `npx jest` (full BFF suite) — 4192 pass / 58 skipped / 4251 total. Intermittent cross-suite singleton flakiness in `analytics_risk_trend` (passes 9/9 when run alone); pre-existing pattern unrelated to M16.12.
- `npx tsc --noEmit` — clean.

## 2026-05-14 — T6 M12.6 — Recurring report schedule next-N-runs preview

### Tasks ticked
- T6 sub-phase M12.6 — schedule next-N-runs preview. T6 sub-phase tally 117 → 118.

### Files touched
- `services/bff/src/report_schedule_preview.ts` (new) — pure `previewScheduleRuns({cadence, day_of_week, day_of_month, hour_utc, tz}, from, n)` iterates M12.2 `computeNextRun` to project the next N firings. Each step advances the `after` anchor by 1ms so consecutive returns are strictly increasing (computeNextRun's contract is "next strictly-future"). Returns `Array<{run_no: number, fire_at: ISO}>` 1-based. n bounded [1, 50] via `SchedulePreviewError('invalid_input', …)`. `PREVIEW_DEFAULT_N=10`, `PREVIEW_MAX_N=50` exported. Convenience adapter `previewScheduleEntryRuns(entry, from, n)` accepts a `ReportScheduleEntry` directly.
- `services/bff/__tests__/report_schedule_preview.test.ts` (new) — 19 jest tests: 10 pure (daily, weekly fires on configured day_of_week, monthly with year roll, quarterly spaced 3-months, last_day_of_month handling Feb 28/29 across 2027 non-leap + 2028 leap, strict-monotonic invariant, n bounds throw on 0 / > MAX / non-integer, returns N rows exactly, Asia/Kolkata IST→UTC tz handling) + 9 route (default n=10, ?n=3, ?n=0 → 400, ?n > 50 → 400, ?from=ISO honored with daily-hour edge, ?from=invalid → 400, unknown_schedule → 404, 403 wrong role, cross-tenant invisibility).
- `services/bff/src/server.ts` — `GET /v1/reports/schedules/:schedule_id/preview?n=10&from=ISO` mounted BEFORE the catch-all `/:schedule_id` so the literal `/preview` segment isn't captured as a schedule_id. `audit:read` RBAC matches the other M12 schedule routes. Validates `?n` is int in [1, 50]; validates `?from` via `Number.isFinite(new Date(s).getTime())` → 400 on bad input. Default `from = now()`.

### Decisions
- **Advance anchor by 1ms each iteration.** computeNextRun's contract is "next STRICTLY-future" — passing the same anchor twice would return the same fire. Advancing by 1ms (less than any meaningful schedule resolution) guarantees forward motion without skipping legitimate fires.
- **n capped at 50.** A month-and-change of daily firings or a year of weekly firings. Deeper projection doesn't help the SPA timeline view and would waste payload.
- **Both pure `previewScheduleRuns` and adapter `previewScheduleEntryRuns` exported.** Pure variant takes a tight 5-field arg; adapter takes a `ReportScheduleEntry` — keeps unit tests focused while letting the route hand a full entry across.
- **First fire follows computeNextRun's "today if hour > now" semantics.** Confirmed by the test where `?from=2026-12-25T00:00` with `hour_utc=8` daily returns `2026-12-25T08:00` as run_no=1 (same day, strictly future) — not `2026-12-26T08:00`.
- **No new store, no audit event.** Pure forward simulation against the existing schedule definition.

### Hand-offs
- **agent-ui** — schedule detail page can render a 10-run timeline strip: `GET /v1/reports/schedules/:id/preview` → list of upcoming fires with relative-time labels ("in 2 hours", "tomorrow at 08:00"). Editing a schedule (PATCH) → re-preview to show the operator how their change propagates.

### Verification
- `npx jest __tests__/report_schedule_preview.test.ts` — 19/19 pass.
- `npx jest` (full BFF suite) — 4360 pass / 58 skipped / 4420 total. Intermittent cross-suite singleton flakiness in `case_maker_checker` / `scenario_bulk` (both pass when run together in isolation, 81/81); pre-existing pattern unrelated to M12.6.
- `npx tsc --noEmit` — clean.

## 2026-05-14 — T6 M16.13 — Custom scenario preset bundle export/import

### Tasks ticked
- T6 sub-phase M16.13 — custom scenario preset bundle. T6 sub-phase tally 121 → 122.

### Files touched
- `services/bff/src/scenario_bundle.ts` (new) — mirrors the M5.11 (rule templates) + M11.9 (dashboards) bundle shape. Versioned envelope (`schema_version='1'`, `exported_at`, `exported_by`, `source_tenant_id`, `items[]`). `validateBundle` rejects empty items + items > cap (30) + missing shocks; `exportScenarioBundle` strips live `id` from each `ScenarioPreset` so import re-mints; `importScenarioBundle` replays via `store.create` with per-row outcomes (`created` / `skipped already_exists` / `error` captures `cap_reached` and any `CustomPresetError` code); `name_prefix` ≤ 24 chars for same-tenant cloning; intra-bundle sibling dedup via in-memory existingNames set updated after each successful create.
- `services/bff/__tests__/scenario_bundle.test.ts` (new) — 21 jest tests: 5 validation (non-object, schema_version mismatch, empty items, items > cap, item-missing-shocks), 4 export (envelope shape + deep-copy independence; unknown_preset; duplicate ids; empty ids), 5 import (clean target → all created; name collision → skipped with already_exists; name_prefix sidesteps same-tenant collisions; intra-bundle dup second occurrence skipped against first; name_prefix > 24 chars → invalid_input), 7 route (200 export envelope; 404 unknown_preset; 403 wrong role on export; 200 import with per-row outcomes; 400 bad schema_version on import; cross-tenant: imports land in caller tenant; 403 wrong role on import).
- `services/bff/src/server.ts` — two new routes `POST /v1/scenarios/library/custom/export-bundle` + `POST /v1/scenarios/library/custom/import-bundle` mounted BEFORE the catch-all `/:preset_id` so the literal `/export-bundle` and `/import-bundle` segments aren't captured as preset_ids. Export route maps `ScenarioBundleError('unknown_preset')` → 404 with `EWS_404_unknown_preset`; all other `ScenarioBundleError` codes → 400. Import route maps every `ScenarioBundleError` → 400. `customers:read_risk_profile` RBAC matches the rest of M16.

### Decisions
- **Mirror M5.11 + M11.9 exactly.** Same envelope shape, same per-row outcome shape, same name_prefix posture. SPA reuses the existing bundle-viewer UX for rule templates / dashboards / scenarios.
- **Cap 30 items/bundle matches M16.4's CAP_PER_TENANT.** A bundle larger than the per-tenant cap could never be imported wholesale anyway.
- **Strip identity on export.** No `id` in the bundle — import re-mints via `store.create`. Bundles stay portable across environments.
- **400 vs 404 on the export side.** Unknown_preset gets a discrete 404; everything else (bad shape, dup ids, empty ids, exceeded cap) is 400. Mirrors M5.11.
- **Inline `require()` for the bundle module in the route.** Same pattern as other late-bound analytics/bundle modules — keeps the import graph cheaper at startup.

### Hand-offs
- **agent-ui** — multi-select rows on `/scenarios/custom` → "Export selected" button → `POST .../export-bundle` → download `.json`. Import: drag-and-drop / paste-JSON dialog → `POST .../import-bundle` → render per-row outcomes (reuse the M5.11 / M11.9 viewer).

### Verification
- `npx jest __tests__/scenario_bundle.test.ts` — 21/21 pass.
- `npx jest` (full BFF suite) — 4424 pass / 58 skipped / 4482 total, **zero failures**.
- `npx tsc --noEmit` — clean.

## 2026-05-14 — T6 M6.10 — Weight preset effective weights view

### Tasks ticked
- T6 sub-phase M6.10 — weight preset effective weights view. T6 sub-phase tally 126 → 127.

### Files touched
- `services/bff/src/scoring_preset_effective_weights.ts` (new) — pure `resolveEffectivePresetWeights(preset, vertical?)` walks `STUB_CATALOG` (every indicator), applies `preset.weight_multipliers[id]` if listed (else 1.0), computes `effective_weight = clamp01(catalog_weight × multiplier)`. Per-entry `{indicator_id, name, vertical, catalog_weight, multiplier, effective_weight, source: 'preset_multiplier'|'catalog_default'}`. Totals `{multiplier_count, default_count, total}`. Sorted by `indicator_id` asc. Validates `vertical` via `isScoringVertical` → throws on invalid.
- `services/bff/__tests__/scoring_preset_effective_weights.test.ts` (new) — 17 jest tests: 2 empty-preset (all catalog_default, sorted asc), 3 sparse-multiplier (source flip, count split, [0,1] clamp), 3 vertical filter (banking, insurance, invalid throws), 2 real-library-preset (conservative_banking explicit multipliers + balanced empty), 7 route (200 library, custom resolved through store, ?vertical narrow, invalid vertical → 400, unknown_preset → 404, 403, M6.3 regression).
- `services/bff/src/server.ts` — `GET /v1/scoring/presets/:preset_id/effective-weights?vertical=banking|insurance` mounted BEFORE the catch-all `/:id` route + before `/diff` so the literal `/effective-weights` segment isn't captured. `customers:read_risk_profile` RBAC. Resolves library + custom presets via the existing `getEffectiveWeightPreset` helper. 404 unknown_preset.

### Decisions
- **Mirror M4.9 resolution-chain shape.** Same `source` enum naming convention; both levels visible side-by-side. SPA can reuse the same renderer.
- **`effective_weight` clamped to [0, 1] per M6.3 contract.** A multiplier of 100 on a 0.9-catalog-weight indicator produces 90, which clamps to 1.0. Tested explicitly.
- **Catalog_default means multiplier = 1.0 implicit.** When the preset's sparse map doesn't list an indicator, its multiplier is 1.0 by definition. Tested via `hasOwnProperty` check (so explicit `{indicator: 1.0}` flips to `preset_multiplier` while absence keeps `catalog_default`).
- **No need to score anything.** The M6.3 `scoreByPreset` already returns `effective_weights[]` as a side-effect of scoring, but M6.10 exposes the same view as a STANDALONE introspection endpoint — useful when an operator is authoring a preset and wants to preview "what would this look like?" before applying it to real customers.

### Hand-offs
- **agent-ui** — preset author UX can render an "Effective weights" table per preset: every indicator on one row, catalog weight in greyed column, multiplier in editable column, effective weight (clamped) in highlighted column, source badge. Pair with M6.9 (preset diff) for compare-against-baseline view.

### Verification
- `npx jest __tests__/scoring_preset_effective_weights.test.ts` — 17/17 pass.
- `npx jest` (full BFF suite) — 4510 pass / 58 skipped / 4571 total. Intermittent cross-suite singleton flakiness in `notification_template_dispatch` / `rule_bulk_clone` / `scoring_presets_custom` — all pass when run together (90/90); pre-existing pattern unrelated to M6.10.
- `npx tsc --noEmit` — clean.

## 2026-05-14 — T6 M6.11 — Weight preset clone-from-library

**Goal.** Mirror of M5.9 (rule template clone-from-library) for the M6.3 / M6.4 weight preset surface. Lets tenants take a curated library preset (conservative-banking, balanced-insurance, etc.) and create an editable custom copy without re-authoring the multiplier map.

### Files

- **EDIT** `services/bff/src/server.ts` — new route `POST /v1/scoring/presets/custom/clone-from-library` mounted right BEFORE `DELETE /v1/scoring/presets/custom/:preset_id`. Reads source via `getWeightPreset`, builds an input dict matching `CustomWeightPresetInput` with a deep-copy of `weight_multipliers` (object spread), then calls `customWeightPresetStore.create(...)`. Same error shape as the existing M6.4 manual create route: 400 invalid_input / 404 unknown_preset / 409 cap_reached / 400 other validation. Default name when no override: `Copy of <source.name>`.
- **NEW** `services/bff/__tests__/scoring_preset_clone_from_library.test.ts` — 9 tests: 400 missing source, 404 unknown library, 201 default name + multiplier equality, 201 name override, deep-copy verification (mutating clone doesn't mutate the library), 409 cap_reached at 30 seeded entries, 403, cross-tenant invisibility, M6.4 manual create regression.

### Design notes

- Pattern-aligned with M5.9 — same route shape, same `getXxx(source_id) → 404 if null → store.create()` flow, same audit-omission (existing M6.4 create doesn't audit either; staying consistent).
- Deep-copy is just `{...source.weight_multipliers}` since the values are numbers (immutable primitives). Verified via the explicit mutation test.
- Library preset registry exposed via `getWeightPreset` / `listWeightPresets` from `scoring_presets.ts` — both library AND custom presets share the same `WeightPreset` shape so the clone passes straight through `validate()` in `CustomWeightPresetStore`.
- Tests use `listWeightPresets()[0]` rather than hardcoding a preset id — safer if the library set is re-ordered, and exercises whatever real preset is at index 0.

### Verification
- `npx jest __tests__/scoring_preset_clone_from_library.test.ts` — 9/9 pass.
- `npx tsc --noEmit` — clean.

### Sub-phase tally
- T6 tally **132 → 133**.

## 2026-05-14 — T6 M2.7 — Onboarding skip-reason history

**Goal.** Focused audit view over the M2.5 skip-reason capture: just the skipped steps with their reasons + actor + step.order, the auditable "why was each step skipped?" companion to M2.6 readiness. Distinguishes M2.5 explicit-reason skips from legacy `markStep('skipped')` skips so compliance can spot the audit-trail gap.

### Files

- **NEW** `services/bff/src/onboarding_skip_history.ts` — pure `listOnboardingSkips(state)`. Filters `state.steps` to `status==='skipped'`, joins against `ONBOARDING_STEPS` for name + required + order, sorts by step.order asc, and surfaces `total_skipped`, `total_skipped_with_reason` (skip_reason not null), `total_skipped_legacy` (skip_reason null), and `state_last_updated_at`.
- **NEW** `services/bff/__tests__/onboarding_skip_history.test.ts` — 9 tests (5 pure + 4 route): empty envelope, M2.5 explicit-reason capture, legacy markStep null-reason, filter (completed/pending steps drop), step.order asc sort with 3 reverse-order skips, mixed-bucket counting, route happy path, 403, cross-tenant invisibility.
- **EDIT** `services/bff/src/server.ts` — imported `listOnboardingSkips`; mounted `GET /v1/tenants/me/onboarding/skip-history` (audit:read) right before `/v1/tenants/me/onboarding/readiness` to keep onboarding routes grouped.

### Design notes

- Per-record shape carries `actor` (preserves `completed_by` from the step progress entry) but NOT `last_updated_at` — `skipStepWithReason` sets `completed_at: null` on explicit skips, so the field would have been confusingly null for the very path it was meant to time-stamp. Tenant-level `state_last_updated_at` at the envelope level handles the "how recent is this report?" use case.
- Distinguishing M2.5-explicit vs legacy null-reason skips at the count level surfaces a compliance signal the SPA can act on (banner: "3 skips without reasons — re-skip via the M2.5 flow to capture the audit context").
- M2.5 `skipStepWithReason` accepts ANY step (required or optional); the regulatory use case is precisely "skip a required step with a documented reason." Tests exercise required-step skips on purpose.

### Verification
- `npx jest __tests__/onboarding_skip_history.test.ts` — 9/9 pass.
- `npx tsc --noEmit` — clean.

### Sub-phase tally
- T6 tally **136 → 137**.

## 2026-05-14 — T6 M12.7 — Report schedule fleet-wide upcoming runs

**Goal.** Widen M12.6's single-schedule preview to the entire tenant. The SPA wants a calendar view answering "what's firing across all my saved schedules in the next hour / day / week?" — currently it'd have to call M12.6 once per schedule and merge client-side. M12.7 does the merge server-side and returns the top-N overall.

### Files

- **NEW** `services/bff/src/report_schedule_fleet_preview.ts` — pure `previewScheduleFleet(schedules, from, n)`. Filters to `enabled === true`, calls `previewScheduleEntryRuns(s, from, n)` for each, accumulates `{schedule_id, name, report_id, format, fire_at}` items into a pool, sorts by `fire_at` asc with `schedule_id` asc tie-break, trims to top-n. Default n=20, max=100. Validates n + from up-front via `FleetPreviewError`.
- **NEW** `services/bff/__tests__/report_schedule_fleet_preview.test.ts` — 15 tests across 6 pure + 1 validation + 1 tie-break + 6 route describe blocks: empty input, single schedule top-n, multi-schedule merge+sort, top-n cap on larger pool, disabled-schedule exclusion, n bounds + invalid from, same-timestamp tie-break, route 200 empty, populated, 400 invalid_n, 400 invalid_from, 403, cross-tenant.
- **EDIT** `services/bff/src/server.ts` — mounted `GET /v1/reports/schedules/upcoming` (audit:read) BEFORE `/v1/reports/schedules/:schedule_id` catch-all so the literal `/upcoming` segment wins.

### Design notes

- Each enabled schedule contributes UP TO `n` candidates to the merge pool — that's enough to ensure the top-n overall is complete even when one fast-firing schedule (e.g. hourly) would otherwise dominate the early slots. Pool size is bounded at n × |enabled| ≤ 100 × |enabled| which is fine for the in-memory store.
- Tie-break by schedule_id asc when two schedules fire at the same minute. Stable + deterministic.
- Disabled schedules are excluded silently — their `next_run_at` field is a stale value that hasn't been advanced since pause. Including them would surface confusing "this schedule is paused but will fire" items.
- Reuses `previewScheduleEntryRuns` from M12.6 — no duplicate slope/cadence logic.

### Verification
- `npx jest __tests__/report_schedule_fleet_preview.test.ts` — 15/15 pass.
- `npx tsc --noEmit` — clean.

### Sub-phase tally
- T6 tally **138 → 139**.

## 2026-05-14 — T6 M16.14 — Library scenario preset clone-from back-reference

**Goal.** Direct scenario equivalent of M5.13 (rule template clone history). Same audit-walk shape, opposite resource family.

### Files

- **NEW** `services/bff/src/scenario_clone_analysis.ts` — pure `analyseScenarioCloneHistory(events, library_preset_id)`. Filters strictly to `action='scenario.create' + resource_type='scenario' + metadata.cloned_from === library_preset_id` so unrelated events drop. Sorts newest-first by `cloned_at` with `custom_preset_id` asc tie-break. Absent optional metadata (name/category) surfaces as null.
- **NEW** `services/bff/__tests__/scenario_clone_analysis.test.ts` — 9 tests (4 pure + 5 route): empty, filter combinations, ordering + tie-break, null optional metadata, route 404 unknown_preset, zero-clones envelope, populated back-reference, 403, cross-tenant invisibility.
- **EDIT** `services/bff/src/server.ts` — mounted `GET /v1/scenarios/library/:preset_id/clones-in-tenant` (customers:read_risk_profile) right ABOVE the existing `/v1/scenarios/library/:id` catch-all so the literal `/clones-in-tenant` wins.

### Design notes

- Mirrors M5.13 verbatim — same Pure aggregator pattern, same filter logic, same sort. Differences: source filter is `scenario.create` not `rule.create`; per-record shape carries `category` (scenario taxonomy) instead of `vertical`+`category` (template taxonomy).
- Per-tenant scope: the auditTrailStore is per-tenant, so this answers "which of MY custom scenarios trace back to this library preset?" — not the cross-tenant "how many tenants have cloned this preset?" view.
- 404 uses `getScenarioPreset(id)` — same library registry M16.8/M16.9 validate against.

### Verification
- `npx jest __tests__/scenario_clone_analysis.test.ts` — 9/9 pass.
- `npx tsc --noEmit` — clean.

### Sub-phase tally
- T6 tally **139 → 140**.

## 2026-05-14 — T6 M12.8 — Report schedule conflict detection

**Goal.** Pair-finder over the report schedule fleet: detect schedules that fire within X minutes of each other. Lets ops spot "these two heavy reports slam the database simultaneously" resource contention before it bites.

### Files

- **NEW** `services/bff/src/schedule_conflict_detection.ts` — pure `detectScheduleConflicts(schedules, from, window_minutes, lookahead_n)`. Re-uses M12.6 `previewScheduleEntryRuns` to generate each enabled schedule's next-N firings, merges into a flat sorted timeline, then sweeps with a two-pointer algorithm: for each firing i, walk j=i+1 while gap ≤ window, emit conflict ONLY when schedule_id[i] !== schedule_id[j]. Same-schedule self-pairs are filtered out (by construction they're never closer than the cadence period).
- **NEW** `services/bff/__tests__/schedule_conflict_detection.test.ts` — 19 tests (12 pure + 7 route) cover empty input, single schedule (no conflicts), two-at-same-time, window-threshold sensitivity (15min vs 90min), same-schedule-no-self-conflict invariant, disabled-exclusion, 3-schedule C(3,2)=3 pair count, validation rejections, sort order, route happy paths, 400 × 2, 403, M12.7 upcoming regression.
- **EDIT** `services/bff/src/server.ts` — mounted `GET /v1/reports/schedules/conflicts` (audit:read) right above the M12.7 /upcoming route so all the fleet-wide diagnostics sit together. Mounting before `/:schedule_id` ensures the literal segment wins.

### Design notes

- Two-pointer sweep is O(n × k) in the worst case but k is bounded by the window — once `gap > window` we break the inner loop. Average case linear-ish given the window+lookahead bounds.
- Same-schedule self-pair filter is the load-bearing assertion. Daily schedules generate ~lookahead_n firings each, all separated by ≥24h; conflicts between those are not interesting (and would never fit a sub-day window anyway).
- Sort: conflicts surface earliest-first so the SPA renders the most urgent contention at the top.
- Bound choices: window 0-240 min (4-hour upper bound — wider than that and "conflict" becomes meaningless); lookahead 1-50 (matches M12.6's PREVIEW_MAX_N).
- Validation rejection through ConflictDetectionError → 400 — same shape as M12.7's FleetPreviewError handling.

### Verification
- `npx jest __tests__/schedule_conflict_detection.test.ts` — 19/19 pass.
- `npx tsc --noEmit` — clean.

### Sub-phase tally
- T6 tally **148 → 149**.

## 2026-05-14 — T6 M2.8 — Tenant onboarding ETA projection

**Goal.** Operational time projection over the M2.2 onboarding state. Static per-step minute estimates + sum the pending ones = remaining_minutes + projected_completion_at. Companion to M2.6 readiness (structural verdict) — this is the temporal one.

### Files

- **NEW** `services/bff/src/tenant_onboarding_eta.ts` — pure `projectOnboardingEta(state, now)` with a `MINUTES_BY_STEP` constant (hand-calibrated per-step efforts). Sums completed/skipped/pending minutes; computes percent_done_by_effort (completed/total); emits projected_completion_at as `now + pending_minutes * 60_000`. remaining_required_minutes is the load-bearing metric for "real" completion ETA (excludes optional steps).
- **NEW** `services/bff/__tests__/tenant_onboarding_eta.test.ts` — 9 tests (5 pure + 4 route): untouched tenant, fully completed (projected_completion_at=null), partial state, skipped vs pending semantics, projected_completion_at arithmetic, untouched/completed/403/cross-tenant routes.
- **EDIT** `services/bff/src/server.ts` — mounted `GET /v1/tenants/me/onboarding/eta` (audit:read) alongside the M2.6 readiness + M2.7 skip-history routes.

### Design notes

- Effort estimates are HAND-CALIBRATED static numbers, not historical averages. Justifications:
  - tenant_provisioned: 5min — automated DB row provision
  - channels_configured: 10min — picker + defaults accept
  - vertical_set: 5min — single dropdown
  - config_baseline: 30min — the M13 13-key walkthrough
  - email_channel: 15min — SES creds + verification
  - alert_routing: 20min — tweak 4 M8 rules
  - audit_active: 10min — WORM bucket confirm
  - operator_invited: 15min — invite + first login (optional)
  - Total: 110 platform minutes.
- A future enhancement would replace the static table with a historical average from a "onboarding completions" ledger. Not in scope.
- `projected_completion_at` is null when pending_minutes=0 — onboarding is done. Distinct from "now" because a completed onboarding has no ETA to project, it has a past completion timestamp.
- `remaining_required_minutes` excludes optional steps so the SPA can render two complementary metrics: "you have 95min of total work left, of which 80min are required to finish".

### Verification
- `npx jest __tests__/tenant_onboarding_eta.test.ts` — 9/9 pass.
- `npx tsc --noEmit` — clean.

### Sub-phase tally
- T6 tally **154 → 155**.

## 2026-05-14 — T6 M16.15 — Scenario shock-vector radar transform

**Goal.** Chart-data transform that normalises every M16.1 library preset's `{gdp, rate, fx}` shocks onto [-1, 1] using library-wide MIN/MAX per axis. Lets the SPA render a unified radar chart comparing all presets without each axis fighting on its own scale.

### Files

- **NEW** `services/bff/src/scenario_shock_vectors.ts` — pure `normaliseScenarioShockVectors(presets)`. Per-axis MIN/MAX computed across the preset set, then per-preset `value' = -1 + 2 * (value - min) / (max - min)`. Constant-axis edge case handled: when max=min on an axis, every preset's normalized value is 0 (no variation to plot).
- **NEW** `services/bff/__tests__/scenario_shock_vectors.test.ts` — 11 tests (7 pure + 4 route): empty, single preset (all 0), three presets min/mid/max → -1/0/+1, monotonicity, constant-axis edge, sort order, default registry integration, admin happy, 403, platform-static, M16.1 regression.
- **EDIT** `services/bff/src/server.ts` — mounted `GET /v1/scenarios/library/shock-vectors` (customers:read_risk_profile) BEFORE the `/:preset_id` catch-all (specifically right above the M16.14 clones-in-tenant route) so the literal `/shock-vectors` wins.

### Design notes

- Why -1 to 1 (not 0 to 1): the BIL scenario library includes both shocks (negative GDP, positive rates) AND boons (positive GDP, lower rates would be a stimulus scenario). Centred on 0 gives the SPA a meaningful baseline tick — anything below the centre is a tightening shock, anything above is loosening.
- Constant-axis edge case: if every preset shares the same gdp value (theoretical but possible), the gdp axis has zero variance and `normalize(val)` would divide by zero. Returning 0 across the board is the right semantic — there's no variation to display.
- Min/max anchored on the supplied library: if the SPA later wants to compare a custom preset against the library radar, the route needs to accept a candidate preset and include it in the MIN/MAX computation. Not in scope today; static library-only.
- Sort by preset_id asc for stable rendering — the SPA can layer the radars in the same order each time.

### Verification
- `npx jest __tests__/scenario_shock_vectors.test.ts` — 11/11 pass.
- `npx tsc --noEmit` — clean.

### Sub-phase tally
- T6 tally **155 → 156**.

## 2026-05-14 — T6 M6.12 — Bulk-clone weight presets from library

**Goal.** Mirror M5.10 (rule template bulk-clone) for the M6.3/M6.4 weight preset surface. Lets BIL onboarding go from "clone 6 library presets one-by-one through M6.11" to "select-all + name-prefix → server fans out".

### Files

- **EDIT** `services/bff/src/server.ts` — new POST route `/v1/scoring/presets/custom/bulk-clone-from-library` mounted right above the existing M6.11 single-clone-from-library route. Cap 10 ids/call. Per-row outcome split (created[] + skipped[]) with explicit reason enum: `invalid_id` (non-string), `duplicate_in_request` (same source twice in one body), `unknown_preset`, `cap_reached`, etc.
- **NEW** `services/bff/__tests__/scoring_preset_bulk_clone.test.ts` — 12 tests covering 400 missing/empty/over-cap, happy path 2-create, name_prefix, unknown-id skip, duplicate-in-request skip, non-string skip, cap_reached skip, 403, cross-tenant invisibility, M6.11 single-clone regression.

### Design notes

- The skip-reason enumeration is the load-bearing UX detail: when a tenant tries to clone 5 presets and ends up with 3 created + 2 skipped, the SPA needs structured reasons to render which ones failed and why. `invalid_id` / `unknown_preset` / `cap_reached` are operationally distinct, so they're distinct strings.
- Server-side trim on `name_prefix` strips trailing whitespace. Callers wanting `"[BIL] <name>"` should include the trailing space inside their prefix; the trim is for "[BIL]    " accidental padding. Test asserts the bracketed-prefix lands but doesn't assert the space (implementation detail).
- Cap at 10 matches M5.10's bulk-clone cap. Above 10 = paginate in the SPA.
- Same RBAC as M6.11 (customers:read_risk_profile) — bulk-clone is a tier of the same primitive.

### Verification
- `npx jest __tests__/scoring_preset_bulk_clone.test.ts` — 12/12 pass.
- `npx tsc --noEmit` — clean.

### Sub-phase tally
- T6 tally **157 → 158**.

## 2026-05-14 — T6 M6.13 — Score sensitivity analysis

**Goal.** Partial-derivative attribution over the M6.5 scoreByPreset primitive. Lets ops answer "which indicator moves my score the most?" by perturbing each indicator value ±0.05 and comparing score swings.

### Files

- **NEW** `services/bff/src/scoring_sensitivity.ts` — pure `analyseScoreSensitivity(input, baseLookup)`. Calls scoreByPreset N+1 times (base + 2×N for up/down per indicator). Symmetric finite-difference around the base point. Clamps perturbed values to [0,1] for value bounds. Default perturbation 0.05; valid range (0, 0.5].
- **NEW** `services/bff/__tests__/scoring_sensitivity.test.ts` — 14 tests (9 pure + 5 route): single-indicator happy, heavier-weight-more-sensitive invariant, symmetric_delta arithmetic, value=0/value=1 clamping, sort order, validation, empty-items bubble, admin happy, 400 × 2 + 404 + 403.
- **EDIT** `services/bff/src/server.ts` — mounted `POST /v1/scoring/sensitivity` (customers:read_risk_profile) right above `/scoring/risk/by-preset` so it sits with the scoring family. Routes SensitivityError → 400, WeightPresetError.unknown_preset → 404, IndicatorLookupError.unknown_indicator → 404.

### Design notes

- Symmetric difference (`up - down`) is more accurate than one-sided (`up - base`) because it cancels the second-order term in the Taylor expansion. For non-linear scoring (which Σ(W×V) isn't, but the clamp can be), this matters.
- Clamping perturbed values to [0,1]: if base_value=0.98 and perturbation=0.05, the "up" candidate is clamped at 1.0. Score still computed; the row's `score_up` reflects the clamped reality. SPA can detect this by comparing `base_value + perturbation > 1` itself.
- Empty items[]: rather than catch + return empty rows[], we let M6.1's ScoringInputError bubble. Sensitivity on zero inputs is genuinely meaningless and 400 is the right contract.
- Sort tiebreak (indicator_id asc) keeps rendering stable.
- Re-uses scoreByPreset rather than inlining the math — single source of truth for the scoring formula.

### Verification
- `npx jest __tests__/scoring_sensitivity.test.ts` — 14/14 pass.
- `npx tsc --noEmit` — clean.

### Sub-phase tally
- T6 tally **160 → 161**.

## 2026-05-14 — T6 M2.9 — Tenant onboarding overview (composite)

**Goal.** Single round-trip for the SPA's onboarding dashboard, composing the M2.6 readiness + M2.7 skip-history + M2.8 ETA views.

### Files

- **NEW** `services/bff/src/tenant_onboarding_overview.ts` — pure `composeOnboardingOverview(state, now)`. Delegates to the three existing pure functions (computeOnboardingReadiness, listOnboardingSkips, projectOnboardingEta). No new logic.
- **NEW** `services/bff/__tests__/tenant_onboarding_overview.test.ts` — 7 tests (3 pure + 4 route): untouched zero state, partial progress with all 3 sub-views reflecting, fully-done invariant, admin happy, 403, cross-tenant, M2.6 regression.
- **EDIT** `services/bff/src/server.ts` — mounted `GET /v1/tenants/me/onboarding/overview` (audit:read) above the M2.8 /eta route.

### Design notes

- Pure composition: M2.9 doesn't introduce new business logic; it just collapses 3 network calls into 1. Justification: the SPA's onboarding dashboard already rendered all 3 views simultaneously and the latency budget was 3×.
- Three sub-views answer complementary questions: readiness = "are you ready?" (structural verdict); skip_history = "what did you skip and why?" (audit trail); eta = "how much time remaining?" (temporal projection). Together they answer the full onboarding state.
- audit:read RBAC matches the underlying routes — consistent permission posture.

### 5000 jest crossed
This is the BFF jest suite crossing 5000 passing tests this session. Started at ~4500 (155 sub-phases ago).

### Verification
- `npx jest __tests__/tenant_onboarding_overview.test.ts` — 7/7 pass.
- `npx tsc --noEmit` — clean.

### Sub-phase tally
- T6 tally **165 → 166**.

## 2026-05-14 — T6 M2.10 Tenant onboarding actor summary

- Pure `summarizeOnboardingActors(state)` at `services/bff/src/tenant_onboarding_actors.ts` groups every non-pending step in the M2.2 state by `completed_by` and emits per-actor rows with completed_count + skipped_count + step lists (sorted by step.order asc). Envelope counts: total_actors / total_completed / total_skipped. Actors sorted by total_actions desc with username asc tie-break.
- New route `GET /v1/tenants/me/onboarding/actors` (audit:read; mounted alongside M2.9 overview).
- Distinct from M2.7 skip-history (step-perspective) vs M2.10 (actor-perspective): M2.7 answers "what was skipped and why", M2.10 answers "who did what". Both are valid drill-downs from the M2.9 composite.
- 10 new jest tests (6 pure + 4 route). All pass; full BFF suite 5010 effective (1 pre-existing flake in alert_quiet_hours_mute_analytics).
- T6 sub-phase tally 166 → 167.
- Hand-off: next sub-phase per the autonomous loop directive — pick any of the unstarted module surfaces or a fresh shape on an existing one.

## 2026-05-14 — T6 M9.12 Investigation outcome breakdown by checklist template

- Pure `summarizeOutcomeByTemplate(tenant, investigations, now)` at `services/bff/src/investigation_outcome_by_template.ts` groups investigations by `checklist_template_id` (M9.2) and emits per-template per-decision counts + `confirmation_rate = (fraud_confirmed + partial_fraud) / closed-with-decision`.
- Envelope adds `most_effective_template`: highest confirmation_rate among templates with ≥ 1 closed-with-decision investigation, tie-broken by sample size desc then template_id asc.
- New route `GET /v1/investigations/outcome-by-template` (audit:read; mounted BEFORE the M9.1 catch-all `/:id` so the literal segment wins).
- Distinct from M9.8 cohort summary (overall tenant rollup) vs M9.12 (template-pivoted): M9.12 surfaces *which* checklists actually move the needle, letting ops decide whether to migrate from BUILT_IN to a custom template.
- 11 new jest tests (7 pure + 4 route). All pass; full BFF suite 5021 effective (2 pre-existing flakes).
- T6 sub-phase tally 167 → 168.

## 2026-05-14 — T6 M16.16 Scenario library narrative one-liners

- Pure `formatScenarioNarrative(preset)` + `listScenarioNarratives()` at `services/bff/src/scenario_narrative.ts` render each M16.1 preset's `{gdp, rate, fx}` shocks into a canonical one-liner the SPA can use in a single chip.
- Format: GDP `+/-X.X%` (1dp, pp), rate `+/-Nbps` (integer rounded), FX `INR +/-X.X%` (1dp). Unicode minus U+2212 for negatives; ASCII `+` for positives.
- Baseline preset narrates as literal `"Baseline (no shock)"` rather than empty — saves the SPA a null-check.
- New route `GET /v1/scenarios/library/narratives` (customers:read_risk_profile; mounted before `/:preset_id` catch-all so the literal segment wins).
- Companion to M16.15: M16.15 normalises shocks onto [-1, 1] for radar charts (visual), M16.16 emits the text (label). Both pure, both platform-static.
- 20 new jest tests (8 formatShockPhrases + 3 formatScenarioNarrative + 4 listScenarioNarratives + 5 route). Clean full-suite run: 5041 pass / 58 skipped / 5099 total.
- T6 sub-phase tally 168 → 169.

## 2026-05-14 — T6 M5.15 Rule template recommended-action inventory

- Pure `mapTemplateActionUsage()` at `services/bff/src/rule_template_action_inventory.ts` is the inverted index over the M5.1 template library. For each of 6 `RecommendedAction` enum values, list referencing templates + per-category + per-severity breakdowns.
- Each breakdown map carries every enum key (zero when absent) — stable grid for the SPA.
- Envelope `{total_templates, actions[] sorted by reference_count desc + action name asc, unused_actions[], most_referenced}`.
- Defensive intra-template dedup: same action twice on one template counts once.
- New route `GET /v1/rules/templates/action-inventory` (rules:list; mounted before catch-all `/:id`).
- Mirror of M4.11 (indicator → templates reverse map) but for actions.
- 16 new jest tests (12 pure + 4 route). Full BFF suite 5057 effective (1 pre-existing flake).
- T6 sub-phase tally 169 → 170.

## 2026-05-14 — T6 M16.17 Scenario library category × regulator coverage matrix

- Pure `buildScenarioCoverageMatrix()` at `services/bff/src/scenario_coverage_matrix.ts` rolls up the M16.1 library into a 4 × 3 = 12-cell matrix showing per-(category × regulator) coverage.
- Per-cell: `{category, regulator, count, preset_ids[], expected_min, is_gap}`. expected_min is hand-calibrated (regulatory.RBI ≥ 2, regulatory.IRDAI ≥ 1, etc.); is_gap surfaces when count < expected_min.
- Envelope: `gaps[]` sorted by shortfall desc + tie-break, `most_populated_cell`, marginal totals via `by_category` + `by_regulator`.
- All 12 cells always present in declared order (category major: baseline → business → regulatory → black_swan; regulator minor: RBI → IRDAI → INTERNAL).
- New route `GET /v1/scenarios/library/coverage-matrix` (customers:read_risk_profile; mounted before catch-all `/:preset_id`).
- Surfaces stress-test inventory gaps. Mirror of M5.14 (template indicator coverage) but for 2D matrix shape.
- 19 new jest tests (14 pure + 5 route). Full BFF suite 5076 effective (1 pre-existing flake).
- T6 sub-phase tally 170 → 171.

## 2026-05-14 — T6 M10.13 Notification template variable cross-reference

- Pure `buildNotificationVariableIndex()` at `services/bff/src/notification_variable_index.ts` is the inverted index over M10.11. For each `{{variable}}` across the 12 BIL canned templates, list referencing templates + channels covered + spans_all_channels.
- Per-variable: `{variable, templates[] sorted by channel asc + template_id asc, reference_count, channels[] in declared order (email/sms/push), spans_all_channels}`.
- Envelope: `single_use_variables` (refactor candidates), `shared_variables` (cross-channel concepts), `most_referenced`.
- Defensive intra-template dedup.
- New route `GET /v1/notifications/variables/index` (audit:read; platform-static).
- Mirror of M5.15 / M4.11 reverse cross-reference shape.
- 19 new jest tests (14 pure + 5 route). Full BFF suite 5095 effective (1 pre-existing flake).
- T6 sub-phase tally 171 → 172.

## 2026-05-14 — T6 M14.24 Adapter operation catalog

- Hand-curated metadata catalog at `services/bff/src/adapter_operation_catalog.ts` — every M14 adapter (insurance/ifrs9/aml/dms/bureau/agent/finance/hr) with its operation list (operation_id, method, path, description, parameter contracts).
- Per-parameter shape `{name, in, type, required, description, enum_values?}`.
- Path-parameter invariant: every `:segment` in path → declared as `in=path` + `required=true` (validated in tests).
- Defensive deep-copy of params + enum_values so SPA mutations don't pollute singleton.
- Envelope: `{total_adapters, total_operations, adapters[], most_capable_adapter}`.
- New route `GET /v1/integrations/adapters/operations` (audit:read; platform-static).
- Distinct from M14.9 (fleet probe) and M14.23 (SLA targets) — this is the "what queries can I make?" lens.
- 18 new jest tests. Full BFF suite 5113 effective (2 pre-existing flakes).
- T6 sub-phase tally 172 → 173.

## 2026-05-14 — T6 M7.10 AI model promotion request timeline

- Two pure surfaces at `services/bff/src/ai_model_promotion_timeline.ts`:
  - `buildModelPromotionTimeline(engine, registry, tenant, model_id)` — per-model audit chain (oldest-first) with aggregate counts + `latest_decision_at` + `oldest_pending_at` + `decision_latency_ms` per entry.
  - `buildPromotionFleetOverview(engine, registry, tenant, now)` — fleet-wide rollup; every registry model surfaced (zero-request models too) + every orphan model_id seen in engine.
- Unknown model_id surfaces as orphan (model_name=null, current_model_status=null) — useful for delisted models.
- Drains via `engine.list({page, page_size: 500})` pagination (200-page cap).
- Two new routes: per-model + fleet. Both mounted with literal segments BEFORE catch-alls.
- Companion to M7.9 staleness lens + M7.7 telemetry lens → M7.10 is the audit-trail lens.
- 22 new jest tests (15 pure + 7 route). Full BFF suite 5135 effective (1 pre-existing flake).
- T6 sub-phase tally 173 → 174.

## 2026-05-15 — T6 M13.12 Config category override-rate snapshot

- Pure `buildConfigOverrideRateSnapshot(store, tenant, now)` at `services/bff/src/admin_config_override_rate.ts` is the category-pivoted rollup over the M13.1 admin config store.
- Per category: `{category, total_keys, default_count, override_count, override_rate, override_keys[]}`. Every declared category present even with zero overrides.
- Envelope adds aggregate totals + `most_customised_category` + `pristine_categories[]`.
- Companion to M13.11 (age axis) — same store input, different lens.
- New route `GET /v1/admin/config/override-rate` (audit:read).
- 14 new jest tests. Full BFF suite 5149 effective (1 pre-existing flake).
- T6 sub-phase tally 174 → 175.

## 2026-05-15 — T6 M12.9 Report schedule cadence statistics

- Pure `buildScheduleCadenceStats(store, tenant, now)` at `services/bff/src/report_schedule_cadence_stats.ts` is the cadence-pivoted rollup over the M12.2 schedule store.
- Per-cadence: `{cadence, total_count, enabled_count, disabled_count, next_run_within_24h_count, next_run_within_7d_count, earliest_next_run_at}`. Disabled schedules excluded from window counts + earliest_next_run_at.
- Every declared cadence emitted in VALID_CADENCES canonical order, even when zero schedules use it.
- Envelope: `{total_schedules, total_enabled, total_disabled, cadences[], most_common_cadence, unused_cadences[]}`.
- New route `GET /v1/reports/schedules/cadence-stats` (audit:read; mounted before `/:schedule_id`).
- Companion to M12.7 (upcoming runs) + M12.8 (conflicts) — same store, cadence axis instead of time axis.
- 19 new jest tests (13 pure + 6 route). Clean full-suite run: 5168 pass / 58 skipped / 5226 total (no flakes).
- T6 sub-phase tally 175 → 176.

## 2026-05-15 — T6 M3.11 Connector schema field type-coverage matrix

- Pure `buildConnectorSchemaTypeMatrix()` at `services/bff/src/connector_schema_type_matrix.ts` is the 2D pivot over the M3.2 connector schema catalog.
- Per-connector row `{connector_id, version, total_fields, required_count, optional_count, by_type (7-key Record<FieldType,number>), dominant_type}`. Every FieldType key always present (zero when absent).
- Envelope: `{total_connectors, total_fields, total_required, total_optional, by_type_totals, connectors[] sorted desc, connectors_without_type (inversion per type)}`.
- New route `GET /v1/ingestion/schema/type-matrix` (audit:read; platform-static; mounted before `/v1/ingestion/connectors/:id/schema`).
- Mirror of M16.17 (scenario coverage) but for connectors × types.
- 17 new jest tests (13 pure + 4 route). Full BFF suite 5185 effective (2 pre-existing flakes).
- T6 sub-phase tally 176 → 177.

## 2026-05-15 — T6 M15.8 Audit log per-actor activity rollup

- Pure `summarizePerActorActivity(tenant, events, now)` at `services/bff/src/audit_per_actor_activity.ts` is the actor-pivoted rollup over the audit chain.
- Per-actor: `{actor_username, total_events, distinct_actions, by_action_top[] top-5, by_outcome (3 keys), by_resource_type (10 keys), first/last_event_at, primary_role}`.
- Envelope: `{actors[] sorted, most_active_actor, failure_only_actors[]}`.
- `primary_role` ranks admin > supervisor > risk_analyst > case_owner > field_officer > alphabetical for actors who flipped role over time.
- New route `GET /v1/audit/per-actor-activity` (audit:read).
- Mirror of M15.6 (action catalog by verb) but pivoted by actor.
- 18 new jest tests. Clean full-suite run: 5203 pass / 58 skipped / 5261 total (no flakes).
- T6 sub-phase tally 177 → 178.

## 2026-05-15 — T6 M8.10 Alert routing rule diff vs platform default

- Pure `buildAlertRoutingDiff(engine, tenant, now)` at `services/bff/src/alert_routing_diff.ts` walks every BIL class and compares the tenant's effective rule against `DEFAULT_RULES`.
- Per-class: `{class, is_default, changed_field_count, changed_fields[]: {field, default_value, effective_value}}`. Fields ordered by declared ALL_FIELDS sequence.
- `channels` compared element-wise (different order = different).
- Envelope: `{total_overrides, classes[] in BIL_CLASS_ORDER, most_customised_class, pristine_classes[]}`.
- Defensive deep-copy on channels array so SPA mutations don't pollute engine.
- Extends M8.8 matrix snapshot with field-level diff detail. Mirror of M13.12 (config override-rate).
- New route `GET /v1/alerts/routing/diff` (audit:read).
- 18 new jest tests. Full BFF suite 5221 effective (2 pre-existing flakes).
- T6 sub-phase tally 178 → 179.

## 2026-05-15 — T6 M4.12 Indicator threshold drift analytics

- Pure `buildIndicatorThresholdDrift(store, tenant, now)` at `services/bff/src/indicator_threshold_drift.ts` computes per-tenant threshold drift over the M4.4 override store.
- Per-override: per-band `{default_value, effective_value, delta_abs (signed), delta_rel (|delta_abs|/|default|; null when default=0)}` for yellow/orange/red, then `drift_score = mean(non-null delta_rel)` + `peak_band_drift` + `peak_band` enum.
- Envelope: `{total_overrides, total_with_drift, total_zero_drift, mean_drift_score, most_drifted_indicator, indicators[]}` sorted by drift_score desc.
- Companion to M4.10 (auto-tune) — M4.10 says "what to use", M4.12 says "how far have you drifted".
- New route `GET /v1/indicators/thresholds/drift` (audit:read).
- 16 new jest tests. Full BFF suite 5237 effective (2 pre-existing flakes).
- T6 sub-phase tally 179 → 180. **180 sub-phases milestone crossed.**

## 2026-05-15 — T6 M6.14 Score what-if across library presets

- Pure `buildScoreWhatIf({vertical, items}, baseLookup, now)` at `services/bff/src/scoring_what_if.ts` fans one indicator input set across every M6.3 library preset of the given vertical.
- Composes M6.3 `scoreByPreset` under the hood per preset.
- Per-preset: `{preset_id, name, mode, vertical, score, category, delta_vs_balanced}`.
- Envelope: `{vertical, items_count, total_presets_considered, presets[] sorted desc, peak_preset, lowest_preset, spread}`.
- Strict vertical filter — banking presets never resolve insurance indicators (cross-vertical guard from M6.3 stays in effect).
- Extends M6.7 (2-preset compare) to the FULL library.
- New route `POST /v1/scoring/what-if` (customers:read_risk_profile; envelope-aware).
- 21 new jest tests. Clean full-suite run: 5258 pass / 58 skipped / 5316 total (no flakes).
- T6 sub-phase tally 180 → 181.

## 2026-05-15 — T6 M11.14 Custom dashboard fleet lint summary

- Pure `buildFleetLintSummary(store, tenant, now)` at `services/bff/src/custom_dashboard_fleet_lint.ts` walks every saved dashboard and composes M11.10 `lintDashboardLayout` per row.
- Per-dashboard summary: `{dashboard_id, name, total_widgets, errors_count, warnings_count, info_count, passes}`.
- Envelope: `{total_dashboards, passing_count, failing_count, with_warnings_count, total_errors/warnings/infos, by_issue_type (5 keys), dashboards[] sorted desc, dashboards_with_errors[], worst_dashboard}`.
- Sort key: errors_count desc → warnings_count desc → dashboard_id asc.
- Companion lens to M11.11 widget usage analytics (popular vs broken).
- New route `GET /v1/dashboards/custom/fleet-lint` (audit:read; mounted before catch-all `/custom/:dashboard_id`).
- 16 new jest tests. Full BFF suite 5274 effective (2 pre-existing flakes).
- T6 sub-phase tally 181 → 182.

## 2026-05-15 — T6 M7.11 Model deployment age histogram

- Pure `bucketModelsByDeploymentAge(registry, now)` at `services/bff/src/ai_model_deployment_age.ts` is the 5-bucket histogram over non-retired M7.1 models by `days_since_deployed` plus a `never_deployed` tail.
- Buckets: under_30d / 30_to_90d / 90_to_180d / 180_to_365d / 365d_plus / never_deployed (in canonical order, even when empty).
- Per-bucket: top-3 oldest samples sorted by days_since_deployed desc + model_id asc; never_deployed sorts by days_since_trained desc instead.
- Envelope: `{total_models_considered (non-retired), total_models_in_registry, total_retired_excluded, buckets[], dominant_bucket}`.
- Mirror of M9.11 (investigation age buckets) for AI models. Companion to M7.9 (threshold-based shortlist).
- New route `GET /v1/ai/models/deployment-age` (audit:read; mounted before `/by-type/:type` + `/retirement-candidates`).
- 20 new jest tests. Clean full-suite run: 5294 pass / 58 skipped / 5352 total (no flakes).
- T6 sub-phase tally 182 → 183.

## 2026-05-15 — T6 M14.25 Adapter entity ID format catalog

- Hand-curated `listAdapterIdCatalog()` + `buildPatternForTenant(template, tenant)` at `services/bff/src/adapter_id_catalog.ts` expose every entity ID format the M14 adapters produce.
- Per-adapter group: `{adapter_id, label, base_path, entities[]: {entity, id_field, pattern_template, example, description}}`.
- Covers 10 entities across 8 adapters: agent(1) / aml(1) / bureau(1) / dms(1) / finance(2) / hr(1) / ifrs9(1) / insurance(2).
- `buildPatternForTenant()` returns a tenant-anchored RegExp; heuristic via first alpha in pattern picks slug case (upper vs lower).
- New route `GET /v1/integrations/adapters/id-catalog` (audit:read; platform-static).
- Drives SPA "paste an ID, route to the right adapter" + client-side validation.
- 16 new jest tests. Full suite 5310 effective (5 pre-existing cross-suite flakes; all isolated runs clean).
- T6 sub-phase tally 183 → 184.

## 2026-05-15 — T6 M10.14 Notification per-recipient cross-channel rollup

- Pure `buildPerRecipientSummary(tenant, email[], sms[], push[], now)` at `services/bff/src/notification_per_recipient.ts` unifies all 3 ledgers into one per-recipient list.
- 3 recipient kinds: `email_address` / `sms_phone` / `push_user` — same human across channels = different rows (address spaces are distinct).
- Push fan-out across devices of same user = 1 send for that user (matches M10.12 convention).
- Per-row: `{recipient_id, recipient_kind, total_sent, by_channel, most_recent_at, distinct_templates[]}`.
- Envelope: `{total_sent_all_channels, total_distinct_recipients, by_kind, top_recipients[] cap 20, recipients[] full, most_active_recipient}`.
- Mirror of M15.8 (audit per-actor activity) for notifications.
- New route `GET /v1/notifications/per-recipient` (audit:read) drains 500 per channel via the transports.
- 19 new jest tests. Clean full-suite run: 5329 pass / 58 skipped / 5387 total (no flakes).
- T6 sub-phase tally 184 → 185.

## 2026-05-15 — T6 M16.18 Scenario library shock magnitude rollup

- Pure `buildScenarioMagnitudeSummary(now, presets?)` at `services/bff/src/scenario_magnitude.ts` normalises every preset shock to [0, 1] against the library MAX-ABS per axis, averages → magnitude_normalised ∈ [0, 1].
- Per-preset: `{preset_id, name, category, severity, gdp_abs/rate_abs/fx_abs, gdp_norm/rate_norm/fx_norm, magnitude_normalised}`.
- Per-category rollup: `{preset_count, total_magnitude, mean_magnitude (null when empty), max_magnitude_preset_id}`.
- Envelope: `{library_max_abs, presets[] sorted desc, by_category[] sorted, most_aggressive_preset, most_aggressive_category}`.
- Sign-agnostic; divide-by-zero guarded for constant-zero axes.
- Companion to M16.15 (radar per-axis [-1, 1]) — M16.18 produces ONE severity number per preset.
- New route `GET /v1/scenarios/library/magnitude` (customers:read_risk_profile; platform-static).
- 21 new jest tests. Full suite 5350 effective (3 pre-existing cross-suite flakes; isolated runs pass).
- T6 sub-phase tally 185 → 186.

## 2026-05-15 — T6 M5.16 Rule template severity distribution

- Pure `buildTemplateSeverityDistribution()` at `services/bff/src/rule_template_severity_distribution.ts` pivots M5.1 templates by `recommended_severity`.
- Per-severity: `{severity, total_count, by_category (5 keys), by_vertical (3 keys), template_ids[]}`.
- Envelope: `{total_templates, severities[] in canonical order (critical → high → medium → low), most_common_severity, unused_severities[]}`.
- Every template appears in exactly one severity bucket (invariant tested).
- New route `GET /v1/rules/templates/severity-distribution` (rules:list; platform-static).
- Companion to M5.15 (action inventory) but pivoted by severity.
- 19 new jest tests. Full suite 5369 effective (2 pre-existing flakes).
- T6 sub-phase tally 186 → 187.

## 2026-05-15 — T6 M2.11 Tenant onboarding milestone tracker

- Pure `computeOnboardingMilestone(state, now)` at `services/bff/src/tenant_onboarding_milestone.ts` enriches M2.6 readiness with a 5-stage classification: starting [0, 25) → in_progress [25, 50) → near_done [50, 75) → final_review [75, 100) → complete (100).
- Per-stage carries label + description for SPA chip rendering.
- Envelope: `{completeness_score, current_stage, current_label, current_description, next_stage_threshold, progress_within_stage, remaining_required_blockers, all_stages[]}`.
- `remaining_required_blockers` excludes skipped (skipped required steps need an unblock decision, not more work).
- New route `GET /v1/tenants/me/onboarding/milestone` (audit:read).
- 19 new jest tests. Full suite 5388 effective (1 pre-existing flake).
- T6 sub-phase tally 187 → 188.

## 2026-05-15 — T6 M15.9 Audit event severity distribution

- Pure `summarizeAuditBySeverity(tenant, events, now)` at `services/bff/src/audit_severity_distribution.ts` is the severity-pivoted rollup over the audit chain.
- Per-severity row: `{severity, total_count, by_resource_type (10 keys), by_outcome (3 keys), by_action_top (top 5), most_recent_at}`.
- Envelope: `{total_events, severities[] in critical→warning→info order, most_common_severity, last_critical_event_at}`.
- Mirror of M5.16 (template severity distribution) for the audit surface.
- Completes the 3-axis pivot family with M15.6 (verb) + M15.8 (actor) + M15.9 (severity).
- New route `GET /v1/audit/severity-distribution` (audit:read).
- 20 new jest tests. Clean full-suite run: 5408 pass / 58 skipped / 5466 total (no flakes).
- T6 sub-phase tally 188 → 189.

## 2026-05-15 — T6 M12.10 Report job runtime trend per report_id

- Pure `buildReportRuntimeTrend(store, tenant, now)` at `services/bff/src/report_job_runtime_trend.ts` drains completed jobs via `store.list({status: completed})` (200×500 pages), buckets by report_id, runs least-squares regression over (days_since_first, processing_ms).
- Per-row: `{report_id, sample_size, mean_processing_ms, first/last_*, abs_change_ms, slope_ms_per_day}`.
- Envelope: `{report_trends[] sorted by |slope| desc, biggest_regression_report_id, biggest_improvement_report_id}`.
- Mirror of M7.8 (model performance trend) for the reports surface.
- New route `GET /v1/reports/jobs/runtime-trend` (audit:read; mounted before catch-all `/:job_id`).
- 16 new jest tests. Full suite 5424 effective (2 pre-existing flakes).
- T6 sub-phase tally 189 → 190. **190 sub-phases milestone crossed.**
