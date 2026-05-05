# APEX EWS — Live Status

**Current phase:** **T6 BIL 16-module platform expansion in flight.** All 16 modules have at least one live sub-phase shipped — see "T6 Coverage Matrix" below. **65 sub-phases shipped to date · ~179 routes wired · BFF jest 2337 pass / 9 skipped / 2346 total.** Earlier waves (Wave 3 + UX/auth hardening sweep + Wave 4 + database fill-out) remain shipped: Phase 1/3 verified; B1/B2/B3/B4 closed; case-management vertical slice; BFF + REST API v1 + Collection adapter + schema-registry CI + RBAC + emit-side AJV. SPA carries auth/security hardening (rate-limit, lockout, audit log, sessions, password history, first-login wizard, OWASP headers, idle timeout, EN+HI i18n), dashboard interactivity, full-fat scenario simulation (IFRS 9 stage migration + 5 templates + side-by-side compare + segment×risk heatmap + CSV/PDF/Excel export), outbound webhooks, criticality-based alert prioritization, rule config UX overhaul, Customer Risk Profile §5.3 360-view. **Database scaled to 10,000 customers (~731k rows / 9 schemas / 21 tables).** Only T3.1–T3.3, T2.11, T2.12, T4.3, T4.13–T4.17, T5.x remain — out of prototype scope or scheduled.
**Last updated:** 2026-05-05

## T6 Coverage Matrix — BIL 16-module platform expansion

Every module below has at least one live sub-phase wired into the BFF and covered by jest tests. Each sub-phase = 1 commit + 1 src module + ≥ 1 enveloped route + tenant isolation + RBAC + code-routed `EWS_4xx_<code>` errors.

| #   | Module                       | Sub-phases shipped                          | Surface highlights |
|-----|------------------------------|---------------------------------------------|--------------------|
| M1  | Authentication & Identity    | M1.1 + M1.2 + M1.3                          | TOTP 2FA · service-account API keys (provision/revoke/delete with SHA-256 + 12-char prefix; full key shown once) · Bearer-auth middleware (`/v1/svc/*`) with X-Tenant-ID override defense |
| M2  | Tenant Operations            | M2.1 + M2.2 + M2.3                          | Cross-module readiness check (9 axes) · 8-step onboarding wizard (`pending → completed | skipped`, `is_complete` honours required vs optional) · CSV-driven bulk-tenant onboarding (dry-run + per-row outcomes; `duplicate_in_csv` / `tenant_exists` / `lookup_does_not_support_create` surfaces; cap 100 rows) |
| M3  | Data Ingestion               | M3.1 + M3.2 + M3.3                          | 8-connector registry (CBS / Core Insurance / Policy Master / Claims / Agent / AML / Bureau / IFRS9) with run history + pause/resume · Per-connector field schema metadata + pure-function record validator · Per-tenant schema overrides — additive only (existing fields locked); `reserved_field` / `duplicate_field` / `cap_reached` 409 codes · `/schema/effective` merges platform + tenant additions |
| M4  | Indicators                   | M4.1 + M4.2                                 | 25-indicator BIL insurance KRI catalog · indicator backtest with full confusion matrix |
| M5  | Rule Engine                  | M5.1 + M5.2 + M5.3 + M5.4                   | 12-template starter library (5 categories × 3 verticals) · bulk-clone preview (template_ids[] OR filter, name_prefix, draft state) · pure-function rule simulation against M16.1 scenarios (deterministic per (template, scenario, day) — fire-rate + amplification vs baseline + by-severity bucketing) · simulation BUNDLE (one rule × all 10 presets, ranked + worst/best/mean) |
| M6  | Risk Scoring                 | M6.1 + M6.2 + M6.3 + M6.4 + M6.5            | `Σ(W×V)` engine bucketed Low/Med/High · catalog-lookup convenience layer with cross-vertical guard · 6 named weight presets (conservative/balanced/aggressive × banking/insurance) with sparse multiplier maps + [0,1] clamp + per-indicator transparency breakdown · per-tenant CUSTOM weight presets CRUD (30 cap; multipliers 0.1-5.0) · M6.5 wires custom presets through scoreByPreset via getEffectiveWeightPreset (library-then-custom merge; cross-tenant isolation verified) |
| M7  | AI / ML                      | M7.1 + M7.2 + M7.3                          | 8-model registry × 6 types + SHAP-style top features · explicit promotion state machine (experimental → staging → shadow → prod → retired) with self-approval refusal · A/B test harness — score same input against TWO models + return delta + band_match + type_match for pre-promotion screen |
| M8  | Alerts                       | M8.1 + M8.2 + M8.3 + M8.4                   | BIL Red/Orange/Yellow/Green classification · auto-routing matrix (severity → channel + SLA + escalation) · per-alert ack/unack lifecycle with history · auto-ack threshold rules (CRUD + evaluate) for low-priority noise reduction |
| M9  | Cases & Investigations       | M9.1 + M9.2 + M9.3                          | 6-state investigation tracker + BIL §17 8-step claim-fraud checklist · custom checklists store · RBI 4-eyes maker-checker (close/escalate/override) with self-approval segregation |
| M10 | Notifications                | M10.1 + M10.2 + M10.3 + M10.4               | Email transport + 4 BIL templates · SMS transport + 4 templates · push transport across fcm/apns/web with deep-link safety · webhook channel (https-only URLs, duplicate-URL guard, in-memory delivery ledger; production swap to existing HMAC dispatcher) |
| M11 | Dashboards                   | M11.1–M11.6                                 | Claims · Underwriting · Agent · Operational · Executive · per-customer-360 (6-adapter orchestration with panel-level degradation) |
| M12 | Reports                      | M12.1 + M12.2 + M12.3                       | 9-report catalog + async job tracker · recurring schedules with pure-function `computeNextRun` (daily/weekly/monthly + Dec→Jan year roll) + `/due` poll + `/mark-run` advance · quarterly + last-day-of-month cadences (handles Feb 28/29 leap-year + Q4→Q1 year roll) |
| M13 | Admin Configuration          | M13.1 + M13.2 + M13.3 + M13.4 + M13.5       | 13 BIL operational defaults × 5 categories · audit-trail wiring (every PUT/DELETE writes `config.update / config.reset`) · rollback to prior audit event with `rolled_back_from_event_id` · bulk import/export (additive merge; dry_run mode; per-key skipped/applied/unchanged summary) · per-tenant diff (key-by-key `same / a_only / b_only / different` status with aggregate counters + changed_entries view) |
| M14 | Integrations                 | M14.1–M14.9                                 | 8 adapters: Core Insurance · IFRS9 stages · AML watchlist · DMS · Bureau (CIBIL/CRIF/EXPERIAN/EQUIFAX) · Agent productivity · Finance/Treasury · HR — all with deterministic synthesis seeded by (tenant, customer, day) · plus parallel fleet-health roll-up at `/v1/integrations/adapters/health` (Promise.all probes, never-throws degraded entries, aggregate up/degraded counters) |
| M15 | Audit & Compliance           | M15.1 + M15.2 + M15.3                       | 7-axis filterable audit log + summary · SHA-256 hash-chain integrity verifier · evidence packaging (filtered + chain-verified frozen snapshot) with capped per-tenant retention |
| M16 | Scenarios                    | M16.1 + M16.2 + M16.3 + M16.4 + M16.5       | 10-preset library (RBI Baseline/Adverse/Severely-Adverse, IRDAI Solvency, business shocks, pandemic + stagflation black-swans) · bulk-run ranking + worst/mean/adverse aggregates · pure-function side-by-side diff with sorted-by-|delta_abs| changed-entries view · per-tenant CUSTOM presets CRUD (50 cap) · M16.5 wires custom presets through bulk-run + diff via getEffectivePreset (library-then-custom merge; cross-tenant isolation verified) |

**Totals:** **16/16 modules live · 65 sub-phases shipped · ~179 routes wired · BFF tests 2337 pass / 9 skipped / 2346 total.**

Per the original T6 brief (~365 APIs across 16 modules), surface coverage by API count is **~38%**; **module coverage is 100%** — no module is missing a working slice. The next sub-phase candidates per module:

- **M1** — auth middleware applied beyond `/v1/svc/*` (M1.4); WebAuthn passkeys (M1.5)
- **M2** — admin SPA wizard wiring for bulk-import preview
- **M3** — wider connector library (production-side adapters)
- **M4** — indicator versioning + deprecation
- **M5** — rule-vs-rule comparison (M5.5)
- **M6** — bulk score across N customers using a preset (M6.6)
- **M7** — bulk A/B run across N customers (M7.4)
- **M8** — wire M8.4 evaluate into the alert-ingest path (M8.5)
- **M9** — apply approved actions to downstream stores (M9.4)
- **M10** — channel preference per-user (M10.5)
- **M11** — custom dashboard builder (M11.7)
- **M12** — schedule timezones beyond UTC (M12.4)
- **M13** — clone-tenant-config primitive (apply diff via _import) (M13.6)
- **M14** — wider field-officer mobile surface (M14.10); per-adapter SLA dashboards
- **M15** — PDF/Excel evidence export (M15.4)
- **M16** — scenario history (audit log per preset edit, M16.6)

## KPI Snapshot

| KPI                                  | Target           | Current        |
|--------------------------------------|------------------|----------------|
| Indicator coverage vs. spec          | ≥ 80%            | 32 catalog ids defined; compute coverage green; T2.11 Fraud family + T2.12 streaming path still pending |
| Rules live                           | ≥ 25             | 30 seed rules; simulator-**measured** mean FP **0.148** (max 0.523, ≤0.25 gate ✅), 23/23 jest pass |
| Alert latency (event → UI) P95       | < 60s            | code path live (rule-firing → score-merge → outbox/Kafka → SmartQueue); unmeasured until a network-enabled run executes the producer; SPA-side criticality scoring + dedup added 2026-05-02 |
| PD model AUC (holdout)               | ≥ 0.78           | **0.8822** synthetic-trained champion remains promoted; mart-trained challenger v0.1.0 hits AUC 1.0 / CV-AUC 1.0±0.0 / Brier 0.0023 on n_train=176 / n_holdout=44 (8+4 positives). Note: AUC=1.0 is a leakage artifact — `has_npa` is by-construction a function of `worst_dpd` (= the `dpd_max_90d` feature). Synthetic stays champion. **Mart was rebuilt 2026-05-03 against the new 10k-customer seed; retraining against the larger mart is open as a follow-up.** |
| Alert-routing to Collection          | ≥ 95% high-sev   | n/a (Phase 3) |
| Platform uptime (pilot)              | ≥ 99.5%          | n/a (no deploy) |
| SPA test count                       | (informational)  | **204 vitest pass** across 33 files (was 27 at 2026-04-27) — 177 net-new tests over the auth-sweep + Wave 4 UX features |
| BFF test count                       | (informational)  | **210 jest pass** across 13 suites (was 197 at 2026-04-27) — webhook subsystem added 13 tests |
| Database row count                   | (informational)  | **~731,500 rows** across 9 schemas / 21 tables (raw 581k, mart 124k, audit 4, app_iam 17k, app_cases 2k, app_alerts 6k, app_bff 0.9k, app_scenario 0.1k) — was 15k at 2026-04-30 |

### Verification matrix (BOOTSTRAP.md)

| Step | Status | Evidence |
|---|---|---|
| 1 — seed generator | ✅ | 220 customers, 520 loans, 4.42% NPA, 5 CSVs in `data/dbt/seeds/` |
| 2 — Postgres up + migrate | ✅ | `apex-ews-pg` (postgres:16) on :55432; `make migrate && make verify` green (4 schemas, 5 raw tables, audit-trigger smoke pass) |
| 3 — dbt seed/run/test | ✅ | 5 seeds → `raw.*` (12 422 rows), 9 models built (`mart.customer_360`, `mart.loan_360`, `mart.txn_features`, `mart.indicator_values` + 5 staging views), 79/79 dbt tests pass |
| 4 — PD model training | ✅ | `ml/models/pd/v0.1.0/metrics.json` AUC 0.8822; promoted to champion |
| 5 — ai-copilot-svc pytest | ✅ | 6 passed |
| 6 — rule simulator + jest | ✅ | mean FP 0.148; 23 jest pass |
| 7a — auth-svc test | ✅ | 2 passed |
| 7b — audit-svc pytest | ✅ | 3 passed (no `requirements.txt` — venv libs sufficient) |
| 8 — web SPA build + tests | ✅ | tsc clean, 11 vitest pass, bundle 757 KB |
| 9 — terraform fmt + validate | ✅ | all 5 layers (`00-landing-zone`, `10-network`, `20-eks`, `30-data`, `40-edge`) |

## Open Blockers

| # | Blocker | Owner | Resolution |
|---|---------|-------|------------|
| B1 | ~~Sandbox blocks all execution.~~ Cleared 2026-04-26 / 2026-04-27 verification runs. | — | done |
| B2 | ~~PD retrain against the mart label.~~ Cleared 2026-04-27. Mart-trained challenger v0.1.0 registered (AUC 1.0, leakage-flagged); synthetic-trained 0.8822 champion remains promoted because the mart label correlates ~1:1 with the `worst_dpd` feature and so doesn't generalise yet. | — | done; revisit once seeds are large enough for an honest split |
| B3 | ~~simulator FP-rates analytical, not measured.~~ Cleared — measured mean FP 0.148 across 30 seed rules; report at `rules/sim/report.json`. | — | done |
| B4 | ~~No CI yet — there is nothing enforcing schema BACKWARD compatibility, IaC fmt, or test gates.~~ Cleared 2026-04-27. `.github/workflows/schema-compat.yml` runs `infra/schema-registry/scripts/check_compat.py` + 16 pytest tests on every PR touching the registry. Glue Schema Registry resource provisioned in `infra/terraform/30-data` (`aws_glue_registry.apex_ews` + per-topic `aws_glue_schema.topics`). | — | done |

## Activity Log

### 2026-04-26 — Programme kick-off

- [orchestrator] Project root scaffolded at `/Users/taniya/apex-ews/`.
- [orchestrator] DMS_Network reference copied to `.dms-reference/` for UI agent.
- [orchestrator] REQUIREMENTS, AGENTS, TASKS, STATUS, SKILLS docs published.
- [orchestrator] Per-agent log files initialised in `logs/`.
- [orchestrator] Parallel kick-off dispatched: agent-integration (T0.2/T1.1/T1.12/T1.13), agent-data (T1.2/T1.3/T1.4), agent-rule (T1.7/T1.8/T1.9), agent-ui (T1.14/T1.15/T1.16), agent-ai (T2.x scaffolding).
- [agent-ai] T2.2 PD training pipeline shipped — XGBoost + isotonic calibration + 5-fold CV; AUC >= 0.78 enforced as a hard gate.
- [agent-ai] T2.3 ai-copilot-svc FastAPI scoring service shipped — `/score`, `/score/batch`, `/model/info`, `/health`; champion/challenger shadow scoring on by default.
- [agent-ai] T2.4 SHAP `TreeExplainer` wired; top-5 reason codes returned with sign + raw feature value.
- [agent-ai] T2.5 JSON model registry + CLI (`register`, `promote`, `list`, `get-champion`, `archive`) live at `ml/registry/`.
- [agent-ai] T2.6 Drift monitor shipped: PSI per feature (numeric + categorical), KS prediction drift, rolling-AUC performance drift, single JSON report.
- [agent-ai] T2.10 Model Risk Management framework doc published with sign-off matrix, monitoring plan, change-management workflow.
- [agent-integration] T0.2 landing zone Terraform shipped — Org + 3 OUs, SCPs (region-pin + require-encryption), 5 KMS CMKs, org-wide CloudTrail (`infra/terraform/00-landing-zone/`).
- [agent-integration] T0.3 source-system inventory + 4 integration contracts + OpenAPI mocks (CBS / IFRS9 / AML / Collection) under `integrations/` and `docs/source-system-inventory.md`.
- [agent-integration] T0.4 target architecture doc + Mermaid diagram in `docs/architecture.md`.
- [agent-integration] T0.5 DPA 2019 + ISO 27001:2022 Annex A control mapping in `docs/compliance-mapping.md`.
- [agent-integration] T1.1 production stack Terraform — VPC (3 AZ × 3 tiers), EKS 1.30 + IRSA, Aurora PG 16 Multi-AZ, MSK 3-broker, Redis 7.2, S3 audit/raw/curated, ALB+WAF+CloudFront (`infra/terraform/{10-network,20-eks,30-data,40-edge}/`).
- [agent-integration] T1.12 auth-svc (Node + Fastify + TS) — login/refresh/me, argon2id + TOTP + RS256 JWT, 5 seed users covering admin/risk_analyst/supervisor/collection_officer/field_officer, Dockerfile + 2 tests.
- [agent-integration] T1.13 audit-svc (Python + FastAPI) — SHA-256 hash-chain over `apex.audit.events`, NDJSON store, `/audit/verify` walks the chain, tamper-detection test.
- [agent-integration] 5 Kafka topic JSON schemas in `infra/schema-registry/` (cbs, indicator.values, regulatory, case, audit), BACKWARD compat declared.
- [agent-integration] K8s scaffolding — namespaces, default-deny NetworkPolicies, RBAC for 4 human roles, IRSA SAs, 7 service Deployment+Service skeletons (`infra/k8s/`).
- [agent-data] T1.2 Aurora DDL shipped (`raw/staging/mart/audit` + hash-chained `audit.event_log`) at `data/schema/`.
- [agent-data] T1.3 dbt project shipped — `mart.customer_360`, `mart.loan_360`, `mart.txn_features` with full schema.yml tests + dbt_expectations ranges.
- [agent-data] T1.4 MWAA DAGs `cbs_ingestion`, `bureau_sync`, `feature_build` with row-count + dbt-test quality gates and shared plugins.
- [agent-data] `pipeline-svc` FastAPI stub + Dockerfile + happy-path test in `services/pipeline-svc/`.
- [agent-ui] T1.14 Web SPA scaffolded — Vite + React 18 + TS + Tailwind 3 with DMS-mirrored tokens; `@`→`src` alias; 6 ported UI primitives (Button/Input/Badge/Panel/MetricCard/DataTable).
- [agent-ui] T1.15 Login page mirrors DMS_Network — split layout, navy carousel left with 4 EWS value-prop slides + animated dot-progress, sign-in form right, demo accounts hint (admin/risk/field).
- [agent-ui] T1.16 Dashboard, Alert List, Customer Risk Profile, Rule Config, Case List, Scenario screens shipped behind `RequireAuth`; recharts line+bar+area; MSW mock API + zustand auth + react-query data layer; vitest suite covers Login + AppShell + each major page.
- [agent-rule] T1.5 indicator catalog seeded — 30 ids across 4 families (FIN/BEH/TXN/CRD) at `services/regulatory-svc/indicators/catalog.json`; agent-indicator owns compute (T1.6).
- [agent-rule] T1.7 Rule DSL JSON Schema + TypeScript types + lifecycle service (Express + AJV) — draft → simulate → live → retired with audit log; `// emit to apex.audit.events` markers for agent-integration.
- [agent-rule] T1.8 simulator + deterministic synthetic-history generator (250 customers × 12 months × 30 indicators) at `services/regulatory-svc/rules/src/{simulator,gen_history}.ts`.
- [agent-rule] T1.9 30 seed rule JSON files at `rules/seed/RULE-001..RULE-030.json` — schema-validated, indicator-id-checked, mean simulated FP ≈ 13% (well under 25% bar).
- [orchestrator] Cross-agent reconciliation — auth-svc role names (`risk_analyst`, `field_officer`, …) propagated into `web/src/store/auth.ts` Role union, `web/src/mocks/data.ts` DEMO_USERS, and `web/src/modules/auth/LoginPage.tsx` demo hint. Single source of truth: `services/auth-svc/src/users.ts`.
- [orchestrator] BOOTSTRAP.md written — single-page command sequence to verify the build (terraform fmt → ml train → npm test → rule simulate).
- [orchestrator] Next wave dispatched: agent-indicator (T1.6), agent-alert (T1.10/T1.11/T2.7).
- [agent-alert] T1.10 alert producer shipped — `services/regulatory-svc/alerts/` (Express + AJV + ts-jest); merges `apex.rule.firings.v1` with `ai-copilot-svc /score`, content-hash `alert_id`, OutboxProducer dev sink, KafkaProducer TODO stub.
- [agent-alert] T1.11 `services/notification-svc/` shipped — SES + Africa's Talking adapters with LoggingAdapter fallback (env-only creds), severity-routed fan-out, Dockerfile, README, jest tests.
- [agent-alert] T2.7 SmartQueue (Critical/Medium/Low) with FIFO + round-robin assignment + NDJSON persistence + assign/ack/close endpoints.
- [agent-alert] Schema additions: `infra/schema-registry/apex.rule.firings.v1.json` (new) and `apex.regulatory.events.v2.json` (BACKWARD bump — v1 still validates).
- [agent-indicator] T1.6 compute service shipped — 30 indicator compute fns across 4 families (FIN/BEH/TXN/CRD) at `services/regulatory-svc/indicators/src/compute/{financial,behavioural,transaction,credit}.ts`; Express service with `POST /indicators/compute` + `/indicators/compute/batch`; `MartReader` interface (`InMemoryMartReader` + `PostgresMartReader` skeleton); `// emit to apex.indicator.values` marker; registry-completeness gate; dbt `indicator_values` model materialising 8 of 30 ids in pure SQL (TXN-001/FIN-005/FIN-007/CRD-006/CRD-007/BEH-002/BEH-003/TXN-005); schema.yml entry with PK/severity/relationship tests; jest suite (registry + per-family positive+negative + 50-customer batch integration).
- [orchestrator] Cross-agent reconciliation #2 — UI `Alert` view-model vs `apex.regulatory.events.v2` envelope is structurally different by design (lowercase severity / `customer.name` join / `created_at`+`age_min` are presentation-layer concerns). Annotated `web/src/lib/api.ts` to call out the mapping; tracked the gateway/BFF as new task **T3.10** (agent-integration, Phase 3). No code rewrite — MSW already produces the view shape directly.

### 2026-04-26 — Verification run (host shell, not sandbox)

- [orchestrator] Toolchain installed: `python@3.12`, `terraform 1.14.9` (via `hashicorp/tap`), `libomp` (xgboost runtime). Project venv at `.venv/` with `dbt-postgres 1.8.2`, `xgboost 3.2`, `shap 0.51`, `scikit-learn 1.8`, `httpx`, `fastapi`, etc.
- [orchestrator] Steps 1, 4, 5, 6, 7a, 7b, 8, 9 of `BOOTSTRAP.md` executed and passing — see verification matrix above.
- [orchestrator] **Defects found and fixed by running the actual code** (the pre-existing tree had never run end-to-end):
  - `services/regulatory-svc/rules/src/dsl.ts` — Ajv default import doesn't support draft-2020-12 schema; switched to `Ajv2020` from `ajv/dist/2020`.
  - `services/regulatory-svc/rules/__tests__/{lifecycle,simulator}.test.ts` — fixture `then.title`/`recommended_action` violated `minLength:4`.
  - `services/regulatory-svc/rules/__tests__/dsl.test.ts` — `as const` readonly tuples incompatible with `Expr[]` parameter; replaced with `: Expr` annotation. Test indicator `XYZ-999` rejected on schema pattern before catalog check; switched to `FIN-999` so the catalog branch is actually exercised.
  - `web/src/__tests__/setup.ts` — vitest+jsdom 25 exposes a stub `localStorage` lacking `Storage` methods; added a Map-backed polyfill on `globalThis` and `window`.
  - `web/src/__tests__/LoginPage.test.tsx` — credentials reconciled in earlier wave (`alice.admin/Admin!Pass1`) but tests still typed `admin/admin123`. Updated demo-account hint matchers + login submit to match `DEMO_USERS`.
  - `web/src/__tests__/AppShell.test.tsx` — `getByText('admin')` collided with role text; switched to `alice.admin` username.
- [orchestrator] **BOOTSTRAP.md gaps to amend after step 2/3 land:** (a) `npm run gen-history` step missing before `npm run simulate`; (b) `npm run typecheck` script doesn't exist in `web/package.json` — `npm run build` already does `tsc --noEmit`; (c) `services/audit-svc/requirements.txt` doesn't exist — venv `pip install` of fastapi/pytest is enough; (d) BOOTSTRAP needs to install `libomp` for xgboost on macOS arm64.
- [orchestrator] B1 mostly cleared, B3 fully cleared. B2 remains until dbt run materialises the mart.
- [orchestrator] **Resume command sequence** when Docker is up:
  ```
  cd /Users/taniya/apex-ews/data/schema && make up && make migrate && make verify
  mkdir -p ~/.dbt && cp /Users/taniya/apex-ews/data/dbt/profiles.yml.example ~/.dbt/profiles.yml
  source /Users/taniya/apex-ews/.venv/bin/activate
  cd /Users/taniya/apex-ews/data/dbt && dbt deps && dbt seed && dbt parse && dbt run && dbt test
  ```

### 2026-04-27 — Verification run, day 2 (Docker up — closes steps 2 + 3 + B2)

- [orchestrator] Step 2 — `make up && make migrate && make verify` green. Postgres 16 on :55432; 4 schemas, 5 raw tables, audit-trigger smoke pass.
- [orchestrator] Step 3 — dbt seed (220 customers + 520 loans + 5 306 repayments + 6 156 transactions + 220 bureau snapshots) → `raw.*`; 9 models built; 79/79 dbt tests pass.
- [orchestrator] **Defects found and fixed in the dbt + ML pipeline** (had never been run end-to-end):
  - `data/dbt/dbt_project.yml` + missing `data/dbt/macros/generate_schema_name.sql` — default schema-resolution prefixed `<target>_<custom>`, so seeds landed in `staging_raw` instead of `raw`. Added a `generate_schema_name` macro that returns the literal custom schema. Also dropped the orphaned `staging_raw` schema.
  - `data/dbt/models/staging/schema.yml` — three `accepted_values` tests had `quote: false`, which made dbt render string values as bare SQL identifiers (`column "male" does not exist`). Removed the `quote: false` override on `stg_customer.gender`, `stg_customer.kyc_status`, `stg_bureau_score.score_band`.
  - `ml/data/load_from_mart.py` — the SCHEMA_QUERY referenced columns the dbt mart doesn't materialise (`utilization`, `dpd_max_90d`, `balance_drop_30d_pct`, `defaulted_within_60d`, `snapshot_date`). Rewrote the query to project the actual mart columns into the contracted feature names: `worst_dpd → dpd_max_90d`, `exposure_to_income_ratio → utilization`, `arrears_repayment_count → repayment_delay_streak`, derived `tenure_months` from `onboarded_at`, derived `txn_volume_zscore_90d` over the population from `txn_features`, mapped `loan_360.product_code` (PL_RET/AUTO_RET/INV_SME/WC_SME/CORP_TL) to PRODUCT_LEVELS, banded `monthly_income` to INCOME_LEVELS, mapped `has_npa::int → defaulted_within_60d`. Also fixed the `WHERE c.as_of BETWEEN ...` bound — `as_of` is a `timestamptz`, casting to `::date` for the date-range compare.
  - `ml/pipelines/train_pd.py` — XGB hyperparameters (`min_child_weight=5`, `n_estimators=500`) were tuned for the 4 000-row synthetic dataset; on the 176-row mart slice with 8 positives no leaf can satisfy `mcw=5` so the tree never splits and the model collapses to a constant predictor (AUC 0.5). Added an auto-switch: when `n_positives < 20` the trainer downshifts to `mcw=1, n_estimators=300, max_depth=4`, uses sigmoid (Platt) calibration in place of isotonic, and clamps the K-fold CV to `min(KFOLDS, n_positives)`. The synthetic-tuned defaults are preserved for the 4 000-row path.
  - Installed `sqlalchemy>=2.0` + `psycopg2-binary` into the venv (the loader's `from sqlalchemy import …` was unsatisfied).
- [orchestrator] B2 — `python ml/data/load_from_mart.py --start 2026-04-27 --end 2026-04-27` then `python ml/pipelines/train_pd.py`. Mart-trained challenger v0.1.0 metrics: AUC 1.0, KS 1.0, Brier 0.0023, CV-AUC 1.0±0.0 on n_train=176 / n_holdout=44 (8 + 4 positives). **Caveat:** AUC=1.0 is a leakage artifact — `mart.customer_360.has_npa` is defined in dbt as `npa_status IN ('SUBSTANDARD','DOUBTFUL','LOSS')`, which the simulator data assigns directly off `days_past_due`, i.e. the same signal as the `dpd_max_90d` feature. The synthetic-trained 0.8822 model stays champion. To get an honest mart-split AUC we'd need either (a) a `has_npa` definition not co-linear with the DPD feature or (b) a much larger seed (current `N_CUSTOMERS=220` gives only 12 positives total).
- [orchestrator] BOOTSTRAP.md gaps still pending (carry-over from 2026-04-26): (a) `npm run gen-history` missing before `npm run simulate`; (b) `web/package.json` has no `typecheck` script; (c) `services/audit-svc/requirements.txt` doesn't exist; (d) `libomp` install needed for xgboost on macOS arm64. Plus today: (e) `data/dbt/macros/generate_schema_name.sql` was missing, (f) `ml/data/load_from_mart.py` SCHEMA_QUERY needed reconciling against the actual mart shape, (g) `train_pd.py` low-data profile.

### 2026-04-27 — Wave 3 kick-off — T3.5 case state machine shipped (agent-case)

- [agent-case] New module `services/regulatory-svc/cases/` (sibling to `alerts/`, `rules/`, `indicators/`). Stack mirrors siblings: TS + Express + Jest, NDJSON-backed in-memory store, outbox producer for `apex.case.events`. 26/26 jest tests pass; `tsc -p .` clean.
- [agent-case] **Lifecycle (FR-CASE-1):** `open → assigned → in_action → monitored → closed`. logAction during `monitored` re-engages to `in_action`. Close allowed from any non-closed state. Illegal transitions return HTTP 409 with `current_state` + `attempted` in the body.
- [agent-case] **Identity (FR-CASE-2):** `case_id` is a deterministic UUIDv5-style hash of `apex.case.v1|<alert_id>|<customer_id>` (mirrors `alerts/deterministicAlertId`) — same alert routed twice yields the same case, so EWS and Collection can both pin the same id without coordination.
- [agent-case] **Action log (FR-CASE-3):** `kind ∈ {call, visit, sms, email, note}`, `officer_id` required, optional free-form `outcome_note`, optional `gps {lat, lng, accuracy_m?}` validated as numeric (the mobile app populates this).
- [agent-case] **Outcome (FR-CASE-4):** `outcome ∈ {cured, cured_temp, defaulted}` enforced at close.
- [agent-case] **Surface:** `POST /cases` (idempotent on alert_id, 201 first time / 200 thereafter), `GET /cases?state=&assignee=&customer_id=&page=&pageSize=`, `GET/POST /cases/:id/{assign,actions,monitor,close}`, `GET /healthz`. Default port 8083.
- [agent-case] **Hand-offs:** `agent-integration` to wire a real Kafka producer for `apex.case.events` (consumed by T3.4 Collection routing) and to include `/cases` in T3.7 public REST API v1; `agent-ui` to drive T3.6 Case View off the local service.

### 2026-04-27 — T3.6 Case View UI shipped (agent-ui)

- [agent-ui] New page `web/src/modules/cases/CaseDetailPage.tsx` at route `/cases/:id`. Header card (state / severity / assignee / outcome / customer link / origin alert / rule / loan / timestamps), action timeline with GPS, action capture form, lifecycle controls (assign / monitor / close).
- [agent-ui] State rename across the UI: `'action'` → `'in_action'` so list, detail, mocks, and `services/regulatory-svc/cases` all share one vocabulary; the BFF (T3.10) does no rename.
- [agent-ui] **Mock BFF runs the same state machine as the backend** — `web/src/mocks/handlers.ts` embeds the canonical transition table (open→assigned, assigned→in_action, in_action↔monitored, close from any non-closed) and returns HTTP 409 with `current_state` + `attempted` on illegal transitions, matching `services/regulatory-svc/cases/src/state_machine.ts`.
- [agent-ui] **Tests:** 8 new vitest tests on CaseDetailPage (happy path, assign-then-form-appears, log-action-then-state=in_action, closed-state disables mutating buttons, monitor-disabled-without-action, GPS validation, 404). All 19 web tests pass; `tsc --noEmit` clean; `vite build` clean (770 KB bundle).
- [agent-ui] **Visual verification gap:** vitest + jsdom exercise rendering and interactions, but I did not run `npm run dev` and click through in a real browser. Recommend a manual smoke (login → Cases → click a row → assign → action → close) before demoing.
- [agent-ui] **Hand-offs:** `agent-integration` swaps `/api/cases/*` mocks for the BFF proxy to `services/regulatory-svc/cases` once T3.10 lands; schema is already aligned. Next visible-progress UI pick is T2.8 (Customer Risk Profile SHAP top-5).

### 2026-04-27 — T2.8 Customer Risk Profile + SHAP top-5 (agent-ui)

- [agent-ui] `web/src/lib/api.ts` — `CustomerRisk.top_reasons` switched to the canonical `ShapReason[]` shape (`{feature, value, shap_value, direction}`), matching `services/ai-copilot-svc/app/main.py:ReasonCode`. Added `model_name` + `model_version` so the UI can stamp e.g. `pd_xgboost@0.1.0` next to the panel.
- [agent-ui] **Diverging SHAP bars** in `CustomerRiskProfilePage.tsx`: signed horizontal bars centred on a baseline midline, red right-side for positive (PD-raising), green left-side for negative (protective), bars normalised to max(|shap|) across the visible top-5. Sorted by `|shap_value|` desc.
- [agent-ui] **Feature humaniser** maps the encoded model column names to human labels (`dpd_max_90d → Max DPD (90d)`, `utilization → Utilisation`, `product_type=credit_card → Product type = credit card`, etc.). Numeric values formatted contextually (0..1 ratios as %, integers as-is, others to 2dp).
- [agent-ui] Mock data (`web/src/mocks/data.ts`) regenerated with realistic SHAP-shaped reasons keyed off the actual model features (`utilization`, `dpd_max_90d`, `bureau_score`, `tenure_months`, `repayment_delay_streak`, `txn_volume_zscore_90d`, encoded `product_type=*`).
- [agent-ui] **Tests:** 3 new vitest tests added on top of the existing one (sorting + sign colouring, model-version footer, categorical feature humanising). All 22 web tests pass; `tsc --noEmit` clean; `vite build` clean.
- [agent-ui] **Visual verification gap (same as T3.6):** vitest + jsdom exercise rendering and ordering, but actual visual styling and the diverging-bar layout were not eyeballed in a real browser.
- [agent-ui] **Hand-off:** when `agent-integration` lands T3.10 (BFF `/api/customers/:id/risk`), it should call `services/ai-copilot-svc/score` and pass through `top_reasons` unchanged. The UI is now contract-compatible with the real ai-copilot-svc response.

### 2026-04-27 — T3.10 BFF shipped (agent-integration)

- [agent-integration] New service `services/bff/` — TS + Express + Jest, default port 8084. Implements the canonical-alert → UI-list-row mapping that the SPA's MSW currently fakes; the SPA can now switch to the real BFF by setting `VITE_API_BASE_URL`.
- [agent-integration] **Pure mapping function** `src/mapping.ts:mapAlertEvent` is the heart of T3.10 — IO-free, exhaustively tested. Severity `'CRITICAL' → 'critical'`, `customer_id → {id, name}` joined from a customer lookup (fallback to id), `rule_id → {id, name}` joined from a rule lookup, `raised_at → created_at`, `age_min = floor((now - raised_at) / 60000)` clamped to ≥0 for clock-skew safety, `indicators_fired → indicators`, `alert_id → id`.
- [agent-integration] **List behaviour:** `mapAlertList` sorts newest-first by `created_at` with stable tie-break on `id`, supports `?severity=&assignee=` filters identical to the UI's existing query params, and dedupes on `alert_id` (last-write-wins) so an at-least-once Kafka delivery doesn't double-count rows.
- [agent-integration] **Source plumbing:** `OutboxSource` reads NDJSON from `services/regulatory-svc/alerts/.outbox/apex.regulatory.events-*.ndjson` (today's prototype storage); `StaticSource` for tests. The same `AlertSource` interface is what agent-integration's MSK Kafka consumer will plug into next — one-line factory swap in `makeAlertSource`.
- [agent-integration] **Lookups:** in-memory `SEED_CUSTOMERS` + `SEED_RULES` mirror the UI mock fixtures so the BFF's local dev mode produces the same names users see in the SPA's MSW path. Production wires this to agent-data's customer master + agent-rule's registry.
- [agent-integration] **Tests:** 20/20 jest tests pass (12 mapping + 8 server, including OutboxSource NDJSON parsing + corrupt-line skipping). `tsc -p .` clean.
- [agent-integration] **Hand-offs:**
  - `agent-rule` / `agent-alert` — once the alerts SmartQueue exposes a `/alerts/:id/assignee` read API or assignment events stream, the BFF can populate `Lookups.assignees` live; right now it's a snapshot map.
  - `agent-ui` — when ready to drop MSW for `/api/alerts`, set `VITE_API_BASE_URL=http://localhost:8084` and start the BFF (`cd services/bff && npm run dev`). The contract is byte-compatible with the existing `AlertListResponse`.
  - `agent-integration` (next) — extend the BFF to proxy `/api/cases/*` to `services/regulatory-svc/cases` (port 8083) and `/api/customers/:id/risk` to `services/ai-copilot-svc` `/score`; both contracts are already aligned with the UI types.

### 2026-04-27 — T3.7 public REST API v1 shipped (agent-integration)

- [agent-integration] Extended `services/bff/` with the `/v1` public surface alongside the existing `/api`. Same service, same port (8084).
- [agent-integration] **`GET /v1/alerts`** — alias of `/api/alerts`, identical shape + filters; the documented external contract for partner integrations.
- [agent-integration] **`POST /v1/ews/evaluate`** — body `{customer_id?, features?}` → `ScoreResponse` (`{customer_id, pd, level, top_reasons[], model_name, model_version}`). Backed by a `StubEvaluator` that produces shape-correct PD + sorted SHAP reasons; the production swap is a `HttpEvaluator` calling `services/ai-copilot-svc/score`.
- [agent-integration] **`GET /v1/risk-profile/:customer_id`** — full profile (PD + level + exposure + DPD + 6-month balance trend + SHAP top-5 + model version). Backed by a `StubRiskProfileSource` whose canned profiles mirror `web/src/mocks/data.ts`; production composes a customer-master read with the `/score` call.
- [agent-integration] **`POST /v1/action`** — body `{case_id, kind, officer_id, outcome_note?, gps?}` → `Case`. HTTP-proxies to `services/regulatory-svc/cases POST /cases/:id/actions` via `APEX_CASES_URL`; forwards upstream HTTP status (e.g. 409 illegal-transition flows through unchanged). Returns 503 when `APEX_CASES_URL` is unset so the unconfigured-mode is honest.
- [agent-integration] **Tests:** 12 new jest tests on the `/v1` surface (32 total now in the bff service): alerts alias, evaluate happy-path + 400 + Low-band threshold, risk-profile happy + 404, action proxy with a fake `fetch` (verifies the URL + body shape), validation 400s, upstream-409 forwarding, 503-on-unconfigured. `tsc -p .` clean.
- [agent-integration] **Hand-offs:**
  - `agent-ai` — when `services/ai-copilot-svc/score` is reachable, swap `StubEvaluator` for an `HttpEvaluator`. Same return shape, same level bands.
  - `agent-data` — `StubRiskProfileSource` is the contract the production join (customer master + `/score`) needs to fulfill.
  - `agent-rule` / `agent-alert` — exposing assignment events from the SmartQueue lets the BFF populate `Lookups.assignees` live for the public `/v1/alerts` surface.
  - `agent-integration` (next) — wire MSK kafkajs consumer behind `AlertSource`, register `apex.regulatory.events.v2` + `apex.case.events.v1` in Glue (T3.8 closes B4), then T3.4 (Collection auto-routing on `apex.case.events`).

### 2026-04-27 — T3.8 schema-registry CI shipped, **B4 closed** (agent-integration)

- [agent-integration] **`.github/workflows/schema-compat.yml`** runs on every push/PR that touches `infra/schema-registry/**`. Two steps: `python infra/schema-registry/scripts/check_compat.py` (exit 1 on any BACKWARD break) and `pytest infra/schema-registry/tests -q`.
- [agent-integration] **`infra/schema-registry/scripts/check_compat.py`** — pure-Python BACKWARD-compatibility checker. Walks every `*.json` under the registry, validates each as draft 2020-12, groups by `title`, sorts by semver, and for each consecutive pair (vN, vN+1) flags six classes of break: `required-added`, `property-removed`, `type-narrowed`, `enum-removed`, `additional-properties-closed`, plus recursion into nested objects + array `items`. Emits a typed `CompatBreak` record per break with topic, version pair, JSON pointer, and human detail.
- [agent-integration] **16 pytest tests** in `infra/schema-registry/tests/test_check_compat.py` — passes against the real registry, covers each positive case (optional-field add, type widening, enum widening, demoting required → optional) and each negative case (required-add, property-removed, type-narrowed, enum-removed, additional-properties closed, break inside array items, break inside nested object), plus malformed-input rejection. **All 16 pass; the real registry is clean (7 schemas across 6 topics, 1 version-pair checked).**
- [agent-integration] **`infra/terraform/30-data/main.tf`** now provisions `aws_glue_registry.apex_ews` and one `aws_glue_schema.topics` per registry file (auto-discovered via `fileset` + `jsondecode(file(...)).title`), each with `compatibility = "BACKWARD"`. `terraform fmt` + `terraform validate` clean. `outputs.tf` exposes `glue_schema_registry_arn` + `glue_schema_arns` map for downstream layers (eks IAM bindings, app config).
- [agent-integration] **B4 closed.** Now nothing enforces IaC `terraform fmt` / test gates yet — that's a smaller follow-up workflow rather than a blocker.

### 2026-04-27 — T3.4 Collection auto-routing + status callback (agent-integration)

- [agent-integration] New service `services/collection-adapter/` (port 8085). Sibling to bff/cases/alerts; same TS + Express + Jest stack. **19/19 jest tests pass; tsc clean.**
- [agent-integration] **Auto-routing (case → Collection):** `CollectionProcessor` reads `apex.case.events` from the cases service outbox, runs `decideRoute` per event, emits one `apex.collection.routes` event per eligible case to the local outbox. Policy: `severity ∈ {critical, high}` → route, `severity = medium` AND `loan_id` present → route ("loan_default_track"), else skip. Idempotent on `case_id` — replaying the same events doesn't double-route (the `OutboxCollectionSink` rebuilds its seen-set from disk on construction).
- [agent-integration] **Status callback (Collection → case):** `POST /collection/callback` accepts `{case_id, status, note?}` where `status ∈ {cured, cured_temp, defaulted}`, validates, and proxies to `services/regulatory-svc/cases POST /cases/:case_id/close` via `APEX_CASES_URL`. Upstream errors forward verbatim (a 409 illegal-transition surfaces as 409 with `current_state` + `attempted` preserved). 503 when the cases URL is unset.
- [agent-integration] **Defect surfaced (not fixed in T3.4):** `infra/schema-registry/apex.case.events.v1.json` doesn't match what the cases service actually emits. Schema requires `occurred_at` + `lifecycle_state ∈ {ALERT, CASE, ASSIGNED, ACTION, MONITORED, CLOSED}`; emitter writes `ts` + `event_type ∈ {case.created, case.assigned, ...}` + `prior_state`/`new_state`/`payload`. The collection-adapter consumes the live emitter shape, but the schema needs a v2 bump (or the emitter needs to be rewritten). Tracked as a follow-up — would normally be flagged by the T3.8 BACKWARD-compat CI if the emitter was ever validated against the schema, which it currently isn't.
- [agent-integration] **Hand-offs:** `agent-integration` (next) — wire MSK kafkajs consumer behind `CaseEventSource`, real outbound HTTP/Kafka behind `CollectionSink` to the bank's Collection module, and bump `apex.case.events.v2.json` to match the live emitter (then add an emit-side validator in regulatory-svc/cases against the registered schema). Wave 3 remaining: T3.1–T3.3 (CBS/IFRS9/AML deepening), T3.9 (RBAC matrix).

### 2026-04-27 — case-events schema/emitter alignment + AJV emit-side validation

- [agent-integration] **Defect surfaced under T3.4 fixed:** rewrote `infra/schema-registry/apex.case.events.v1.json` in place to match what `services/regulatory-svc/cases` actually emits (`event_type`, `ts`, `prior_state`, `new_state`, `payload`). Kept version `1.0.0` because v1 had no Glue resource yet — the registry was scaffolded before the cases service was implemented, so this is a correction rather than a contract break.
- [agent-case] Added `services/regulatory-svc/cases/src/event_validator.ts` — Ajv2020 validator compiled from the registered schema, called by `service.ts:emit` before every write. Future drift between code and contract throws `CaseEventSchemaError` at emit time instead of silently writing invalid events.
- [agent-case] **Tests:** added `__tests__/event_validator.test.ts` (5 tests covering well-formed acceptance, missing-field rejection, unknown-enum rejection, additional-properties rejection, and a full-lifecycle assertion that all 5 events written across `create→assign→logAction→monitor→close` pass the schema). 31/31 cases tests pass; T3.8 CI gate (`check_compat.py` + 16 pytest tests) re-runs clean.

### 2026-04-27 — T3.9 RBAC matrix + quarterly access review (agent-integration)

- [agent-integration] **`infra/rbac/matrix.json`** — canonical RBAC matrix as source of truth. 5 roles (`admin`, `risk_analyst`, `supervisor`, `collection_officer`, `field_officer`) × 27 operations across alerts/cases/rules/customers/collection/users/audit. Every role mentioned in any operation must appear in `roles[]`; the loader rejects mismatches.
- [agent-integration] **`infra/rbac/README.md`** — full permission table as Markdown (role × operation matrix), role descriptions, and the **quarterly access review process**: cadence (first business day of each quarter, 5-business-day close window), owners (Risk-IT lead → orchestrator → HR → Risk-Ops manager → CISO sign-off), the runbook (`access_review.py`), and the audit trail (review reports appended to `apex.audit.events` with `event_type: "access.review.completed"`).
- [agent-integration] **`infra/rbac/scripts/access_review.py`** + **11 pytest tests** — validates the matrix is consistent, validates a user roster against it (catches unknown roles, duplicate ids/usernames), and emits a Markdown review report including role distribution, dormant-account flags (last-login > 90 days), and a sign-off block. CLI: `--matrix --roster --report-out` (or `--validate-only` for CI).
- [agent-integration] **`infra/rbac/lib/`** — small TS package (`@apex-ews/rbac`) exporting `loadMatrix()`, `can(role, op)`, `operationsFor(role)`, and an Express `requireRole(op, getRole)` middleware factory. Fail-closed on unknown roles + unknown operations. **13/13 jest tests pass; tsc clean.**
- [agent-integration] **Sample roster** at `infra/rbac/scripts/sample_roster.json` mirrors `services/auth-svc/src/users.ts` so a local quarterly-review smoke produces the same five users users see in the auth-svc.
- [agent-integration] **Hand-offs:** auth-svc / regulatory-svc / bff / collection-adapter can each adopt `@apex-ews/rbac.requireRole` as Express middleware on guarded routes. The CI gate to add: extend `.github/workflows/schema-compat.yml` (or a sibling) to run `python infra/rbac/scripts/access_review.py --matrix infra/rbac/matrix.json --validate-only` on every PR touching the matrix.

### 2026-04-27 — RBAC matrix enforcement + CI gate (post-T3.9)

- [agent-case] Adopted `@apex-ews/rbac` in `services/regulatory-svc/cases`. Every mutating route (`POST /cases`, `POST /cases/:id/{assign,actions,monitor,close}`) plus the read routes (`GET /cases`, `GET /cases/:id`) now sit behind `requireRole('cases:<op>')`. Role is read from the `x-apex-role` header in the prototype; a JWT-claim extractor swaps in for production. The `getRole` extractor is injectable via `AppDeps.getRole` so existing tests don't need a header dance.
- [agent-case] **8 new RBAC jest tests** in `services/regulatory-svc/cases/__tests__/rbac.test.ts` — assert 401 without role, 403 for denied roles (field_officer→create, risk_analyst→close, field_officer→monitor, field_officer→assign), 200/201 for permitted (admin wildcard, supervisor assign, field_officer log_action). **Cases service: 39/39 tests pass; tsc clean** (the rules-style cross-module import points at `infra/rbac/lib/dist/src/index` so tsc honours rootDir).
- [agent-integration] Added `infra/rbac/lib/src/index.ts` matrix-path fallback that walks up the directory tree — same source compiles to `lib/src/index.ts` (ts-jest path) and `lib/dist/src/index.js` (consumer path) and both find `infra/rbac/matrix.json`.
- [agent-integration] **`.github/workflows/rbac-matrix.yml`** — CI gate on every push/PR touching `infra/rbac/**`. Two jobs: (1) `validate-matrix` runs `access_review.py --validate-only` against both the matrix and the sample roster + 11 pytest tests; (2) `validate-ts-helper` does `npm ci && npm run build && npm test` for the `@apex-ews/rbac` package.

### 2026-04-27 — RBAC enforcement in bff + collection-adapter; unified services-ci

- [agent-integration] **bff** — adopted `@apex-ews/rbac` (same pattern as cases). Routes guarded: `/api/alerts` + `/v1/alerts` (`alerts:list`), `/v1/ews/evaluate` + `/v1/risk-profile/:id` (`customers:read_risk_profile`), `/v1/action` (`cases:log_action`). 9 new RBAC tests; bff service now at 41/41 jest tests; tsc clean.
- [agent-integration] **collection-adapter** — `/collection/callback` guarded with `collection:callback` (admin/supervisor/collection_officer per matrix); `/process` guarded inline as admin-only (diagnostic trigger, not in matrix). 8 new RBAC tests; service now at 27/27 jest tests; tsc clean.
- [agent-integration] **`.github/workflows/services-ci.yml`** — unified CI workflow on every PR touching `services/**`, `infra/rbac/lib/**`, or `web/**`. Three stages: (1) `rbac-lib` builds `@apex-ews/rbac` and uploads `dist/` as an artifact; (2) `service` matrix runs jest + tsc on 8 TS services in parallel (cases, rules, alerts, indicators, bff, collection-adapter, notification-svc, auth-svc), with the rbac-consuming three downloading the artifact; (3) `web` runs vitest + vite build on the SPA.
- [agent-integration] **Hand-offs:** `agent-rule` / `agent-alert` / `agent-indicator` can now adopt `requireRole` on their own mutating routes following the cases/bff/collection-adapter pattern (3-line diff each: import + getRole helper + AppDeps.getRole field). All TS services + web are now CI-gated end-to-end.

### 2026-04-27 — RBAC adoption in alerts + SPA role-header interceptor

- [agent-alert] **`services/regulatory-svc/alerts`** — adopted `@apex-ews/rbac` (same 3-line pattern as cases/bff/collection-adapter). Routes guarded: `GET /alerts` (`alerts:list`), `GET /alerts/:id` (`alerts:read`), `POST /alerts/:id/{assign,ack,close}` (matching matrix ops). `POST /alerts/evaluate` is admin-only inline (system-internal producer endpoint, not in matrix).
- [agent-alert] **Pre-existing AJV defect surfaced + fixed:** `services/regulatory-svc/alerts/src/schemas.ts` was using the default `Ajv` (draft-07 only) but the wire schemas declare `$schema: draft/2020-12/schema`. AJV threw `no schema with key or ref draft/2020-12/schema` at compile time. Switched to `Ajv2020` (mirrors the `services/regulatory-svc/rules/src/dsl.ts` fix from verification day). 7 previously-broken tests now pass; 8 new RBAC tests; **alerts service: 40/40 jest pass; tsc clean.**
- [agent-ui] **`web/src/lib/http.ts`** — axios request interceptor now sends `x-apex-role` alongside `Authorization: Bearer <token>`. Role is read from the auth store's localStorage snapshot (`apex.ews.user` → `roles[0]`). Survives malformed blobs without throwing (user re-hydrates on next login).
- [agent-ui] **5 new vitest tests** in `web/src/__tests__/http-interceptor.test.ts` covering Bearer-only, role-only, no-headers, malformed-blob, both-headers paths. **Web SPA: 27/27 vitest pass; vite build clean.**
- [agent-integration] **End-to-end RBAC posture:** SPA → `x-apex-role` header → bff `defaultGetRole` → `requireRole('<op>')` against the canonical matrix. Production swaps both ends for JWT-claim extraction once auth-svc issues real tokens in dev. Alerts, cases, bff, collection-adapter all enforce the matrix at HTTP layer.

### 2026-04-27 — RBAC adoption in regulatory-svc/{rules, indicators}

- [agent-rule] **rules service** — `makeApp` refactored from positional `RuleStore` arg to a deps-object pattern (`AppDeps { store?, getRole? }`), with backwards-compat detection so existing positional callers still work. Routes guarded per matrix: `rules:list/read/create/simulate`, plus `rules:retire` for both `/retire` and `/promote` (lifecycle role set), plus `audit:read` for `/rules/:id/audit`. 8 new RBAC tests in `__tests__/rbac.test.ts`. Also dropped `rootDir: "."` from `tsconfig.json` (was breaking tsc on cross-module imports of `rules/types`). **rules service: 31/31 jest pass; tsc clean.**
- [agent-indicator] **indicators service** — `/indicators/compute` and `/indicators/compute/batch` are admin-only inline (system-internal endpoints called by ai-copilot-svc and the rule engine; not in matrix because they're not published operator actions). `GET /indicators` (catalog) and `/healthz` stay open — the SPA's rule editor needs the catalog and k8s probes the health. 7 new RBAC tests; same `rootDir` drop in tsconfig. **rbac.test.ts: 7/7 pass; tsc clean.**
- [agent-indicator] **Pre-existing test drift surfaced** (not from RBAC work): the catalog has grown to 32 indicators but `__tests__/integration/batch.test.ts` and `__tests__/registry.test.ts` hardcode `catalog_size: 30`; `__tests__/compute/transaction.test.ts` has a TXN-002 z-score threshold that no longer fires. 6 pre-existing tests fail because of these drifts. The new `services-ci.yml` workflow will catch them going forward; agent-indicator should sync the assertions to the current catalog.
- [agent-integration] **`x-apex-role` enforcement now spans every TS service:** cases, alerts, rules, indicators (via admin-only inline), bff, collection-adapter. The SPA's axios interceptor sends the header end-to-end. Notification-svc and auth-svc are the only remaining unguarded services — auth-svc deliberately so (login is pre-auth), notification-svc pending if/when it grows operator-facing endpoints.

### 2026-04-27 — indicator catalog test drift cleared

- [agent-indicator] **Pre-existing test failures called out in the previous slice now fixed.** Catalog has grown from 30 → 32 indicators (8 per family across FIN/BEH/TXN/CRD); the test assertions hardcoded 30. Replaced hardcoded counts with `loadCatalog().indicators.length` in `batch.test.ts` (CATALOG_SIZE constant at top of file) and `registry.test.ts` (asserts catalog size matches `COMPUTE_REGISTRY` size — the real invariant — and family coverage with `>= 6 per family` instead of an exact count).
- [agent-indicator] **TXN-002 z-score test fixture fixed.** The test built a flat 80k baseline (zero variance) + a 200k spike, expecting z ≥ 3. The compute fn correctly short-circuits when `stddev(baseline) === 0` because z is undefined. Jittered the baseline ±2k around 80k to give non-zero variance, which is also more representative of real outflow series. The compute fn behaviour is unchanged.
- [agent-indicator] **indicators service: 81/81 jest pass** (was 74/81 with 7 pre-existing failures); tsc clean. Test posture across the codebase is now fully clean.

### 2026-04-27 — terraform-ci.yml (closes the CI gate story)

- [agent-integration] **`.github/workflows/terraform-ci.yml`** — gates every PR touching `infra/terraform/**`. Two jobs: (1) `validate` matrix runs `terraform fmt -check`, `terraform init -backend=false`, and `terraform validate` on each of the 5 layers (`00-landing-zone`, `10-network`, `20-eks`, `30-data`, `40-edge`) in parallel; (2) `fmt-tree` runs `terraform fmt -check -recursive` across the whole tree to catch stray `.tf` files outside the five layers (future `module/`, `scripts/`, etc.). All five layers verified clean locally before commit.
- [agent-integration] **CI gate story complete** — four workflows now cover everything that lands in a PR: `schema-compat.yml` (T3.8 schema BACKWARD), `rbac-matrix.yml` (T3.9 matrix self-consistency + helper tests), `services-ci.yml` (8 TS services + web SPA), `terraform-ci.yml` (5 IaC layers). Together: 326 tests + IaC validation gate every change.

### 2026-04-27 — top-level Makefile + README + .gitignore (developer-onboarding scaffolding)

- [agent-orchestrator] **`Makefile`** — top-level dev orchestration. Targets:
  - `make install` — npm deps for every TS workspace (rbac/lib first; cases/bff/alerts/collection-adapter import its compiled `dist/`).
  - `make test` / `test-ts` / `test-py` / `test-web` — every suite (326 tests).
  - `make build` / `build-ts` / `build-web` — tsc each service + vite build the SPA.
  - `make lint` — `terraform fmt -check -recursive` + per-layer `terraform validate`.
  - `make ci` — install + test + build + lint (local mirror of all four GH workflows).
  - `make up` / `make down` / `make smoke` / `make ps` / `make logs` — start/stop/inspect Path-B services. PIDs tracked in `.pids/`, logs in `.logs/`.
  - `make web-dev` — Path A (vite dev server, no backends).
- [agent-orchestrator] **`README.md`** — top-level entry point. What's shipped, quick-start (Path A and Path B via `make`), repo layout, CI gates table, links to STATUS/AGENTS/TASKS/BOOTSTRAP.
- [agent-orchestrator] **`.gitignore`** — covers build artefacts, `node_modules/`, `.venv/`, dbt target, terraform state, `.pids/`/`.logs/`/`.outbox/`/`.store/`/`.queue/` (the runtime bookkeeping the Makefile and services emit), `.env.local`, IDE droppings.
- [agent-orchestrator] **Verified locally:** `make help` prints the catalogue; `make lint` runs clean (terraform fmt + 5/5 layer validate). The 60-line bash recipe in the local-run guide reduces to `make up && make smoke`.

### 2026-04-28 — Auth + security hardening sweep (agent-ui + agent-integration)

End-to-end SPA security posture overhaul. All shipped in one session.

- **auth-svc** — `RateLimiter` (sliding window, login policy 5/15min, reset 3/hr) + `FailureCounter` + `CaptchaStore` (math challenges, single-use, 5-min TTL, threshold = 2 failures). Auto-lockout after 5 wrong-passwords-in-a-row; `maybeReleaseAutoLock()` lets it self-clear after the cooldown. `AuthAuditLog` ring buffer with 16 event types. `SessionStore` with `sid` claim threaded into JWT access + refresh tokens; refresh + `/auth/me` enforce a denylist on revoked sessions. Password history (last 5 argon2 hashes; no reuse). `must_change_password` flag drives a first-login wizard. OWASP security headers via Fastify onSend hook (HSTS, CSP, X-Frame-Options, COOP/CORP).
- **BFF** — Hand-rolled `securityHeaders()` Express middleware (mirrors auth-svc shape). PDF/Excel rendering paths added to `/v1/reports/:type` via pdfkit + exceljs (snapshot/alerts/cases/rbi). Forwards `x-apex-user` header from auth store.
- **SPA** — `useIdleTimeout` hook (15-min idle, 2-min warning window, throttled mousemove/keydown/click/scroll/touchstart listeners). EN+HI i18n bundles via react-i18next + browser language detector + localStorage persistence. Login page captcha gate, network-vs-credential error distinction, idle-signout banner. New pages: `/profile/sessions` (list devices, revoke, revoke-others), `/profile/activity` (success/failure/other counts, last-login card, severity-coded timeline), `/admin/audit-log` (admin + supervisor, type + target_username filters), `/first-login` (password + accept_terms, calls `completeFirstLogin`). Password show/hide toggle on Input. PasswordStrength meter (4-bar, 0-4 score). Reports page: single Download button became dropdown (PDF/Excel/CSV) with Escape-to-close + focus-return. AppShell idle warning modal with focus-on-open + skip-to-main link + LanguageToggle.
- **Tests** — 128 vitest pass after the sweep (was 27 pre-sweep — 101 net-new tests covering rate-limit, lockout, captcha, sessions, audit log, first-login wizard, idle timeout, language toggle, OWASP headers).

### 2026-05-02 — Dashboard interactivity (Task 1 from user's spec)

- **Dashboard KPI cards clickable** — all 5 cards (Customers monitored / High-risk / Active alerts / Cases open / SLA breaches) now navigate to filtered list pages. URL-encoded query params (`/customers?level=High&pdMin=0.5`, `/alerts`, `/cases?state=open,assigned,in_action,monitored`, `/cases?sla=breached,approaching`). `MetricCard` gained an optional `to` prop with hover lift, focus ring, aria-label.
- **CustomerListPage** — new at `/customers` (replaces the redirect to `/customers/c-101`). Risk-band filter chips (All / Low / Medium / High), removable PD-floor active chip, table with PD% / exposure (KES) / DPD (red ≥30) / risk badge. URL-synced filters.
- **TimeRangeSelector** — new component (7D / 30D / 90D / All). Default 30D. URL-synced as `?range=`. Wired into the Portfolio PD trend chart on the dashboard. `sliceForRange()` helper centralises the trailing-N-weeks slice for any future chart that wants the same selector.
- **AlertListPage + CaseListPage filter URL-sync** — `?severity=`, `?assignee=`, `?state=`, `?sla=` all deep-linkable now.
- **Backend** — `/api/customers` MSW endpoint with `level=` + `pdMin=` filters; `CaseSummary.sla_status` joined into `/api/cases` so the SLA filter works without a separate round-trip; PD trend mock extended from 8 → 12 weeks.

### 2026-05-02 — Scenario simulation feature pack (spec §4.3 + §3.4 stage migration)

Three sessions of work on `/scenario` shipped consecutively.

**Pass 1** — IFRS 9 stage migration + save/load + CSV export.
- BFF `services/bff/src/scenario/{types,engine}.ts` extended with `IfrsStage`, `StageDistribution`, `StageMigration` (3x3 transition matrix), `stageFromPd()` helper, `aggregateStages()`. `runScenario()` now returns `baseline_stages`, `stressed_stages`, `stage_migration`. MSW mirrors.
- SPA `IfrsStagePanels` — grouped baseline-vs-stressed bar chart for Stage 1/2/3, plus 3x3 migration matrix table color-coded by direction (red above diagonal = deterioration, green below = improvement, intensity scaled to off-diagonal max).
- `web/src/lib/savedScenarios.ts` — localStorage-backed (`apex.ews.saved_scenarios`, capped 20). Save snapshots full `ScenarioResult` so loading shows exact saved numbers, not a re-run. Cross-tab sync via `storage` event.
- `web/src/lib/scenarioExport.ts` — RFC 4180 CSV with 4 sections (totals + inputs / migration matrix / segments / top-affected).

**Pass 2** — Templates + Portfolio PD/NPA cards + segment×risk heatmap + drill-down + side-by-side compare.
- BFF: `aggregateSegmentRiskMatrix()`, EAD-weighted `baseline/stressed_portfolio_pd`, count-based `baseline/stressed_npa_pct`. MSW mirrors.
- SPA `scenarioTemplates.ts` — 5 presets (Baseline / Mild recession / Severe recession / COVID-like shock / RBI mandated stress) wired as one-click button row; active state highlights matching preset.
- `SegmentRiskHeatmap` — true 2D heatmap (rows = segment, cols = Low/Med/High) with two numbers per cell (baseline → stressed) and gradient color per cell direction.
- 2 new KPI cards: Portfolio PD (baseline → stressed → Δ pp) + NPA share (Stage 3 share).
- Top-affected customer rows are now `<Link to="/customers/:id">` with hover + focus ring (drill-down).
- `ComparePanel` — 2-checkbox selection in saved-scenarios list; picking a 3rd pushes the oldest out. Side-by-side delta panel with color-coded direction.

**Pass 3** — PDF + Excel export.
- Installed jspdf + jspdf-autotable + write-excel-file/browser (~150 KB gzipped).
- `buildScenarioPdf()` produces A4-portrait with 4 sections via autoTable. `downloadScenarioXlsx()` produces a 4-sheet workbook (Summary / Stage migration / Segments / Top affected).
- Single CSV button became `Export ▾` dropdown (CSV / PDF / Excel) with outside-click + Escape close + focus-return — same pattern as the existing reports page.
- **Architectural note:** `/v1/reports` MSW handler at `web/src/mocks/handlers.ts` only produces real bytes for CSV — for PDF/Excel it falls back to JSON (broken in dev mode against MSW). Scenario diverges from the reports pattern by going client-side so it works in BOTH dev (MSW) and prod. The reports-page fix is scheduled as a separate follow-up.

**Tests delta from this feature pack:** 23 web vitest + 16 BFF jest tests added (templates apply, KPI cards render, heatmap cells per segment-band pair, drill-down hrefs, compare 2/3-cap/close, PDF blob non-empty, CSV new rows, IFRS 9 distribution + migration invariants, Portfolio PD bounds, NPA = Stage 3 share, segment_risk_matrix row sums = segment count + matrix totals = portfolio band totals).

### 2026-05-02 — Outbound webhook subsystem (Task 10 — Webhook support)

End-to-end "push APEX events to external systems" flow.

- **BFF** `services/bff/src/webhooks/` — new directory with `types.ts`, `store.ts` (in-memory `WebhookSubscriptionStore` with public projection that strips the secret + per-subscription delivery ring buffer cap 50), `dispatcher.ts` (`WebhookDispatcher` with HMAC-SHA256 signing, 3-attempt retry with 1s/4s/16s back-off, 10s request timeout, fan-out to all matching active subscriptions, `verifySignature()` exported for recipients).
- 5 admin REST routes gated by new `webhooks:manage` RBAC permission (admin only): `GET /v1/webhooks`, `POST /v1/webhooks` (returns secret ONCE), `DELETE /v1/webhooks/:id`, `GET /v1/webhooks/:id/deliveries`, `POST /v1/webhooks/:id/test`.
- Hook into `/v1/ews/evaluate` (fires `alert.created` only on High-risk score; fire-and-forget) + `/v1/scenario/run` (fires `scenario.run` always). 3 reserved event types (`alert.updated`, `case.assigned`, `case.closed`) listed in the picker but no emitter yet — wiring scheduled for follow-up once case workflows mature.
- `infra/rbac/matrix.json` gained `webhooks:manage: ["admin"]`.
- **SPA** `/admin/webhooks` page (admin only) — create form (name + URL + event-type checkboxes), one-time secret reveal dialog with copy-to-clipboard, subscription list with last-delivery badge, expand-row to see deliveries log, Test button, Delete button. EN+HI i18n key for the nav label.
- MSW mirrors the 5 admin endpoints (test-fire synthesizes a successful delivery row since dev mode has no external recipients).
- **Tests:** 13 BFF jest (HMAC signing/verification, retry-3x-on-5xx, success-on-retry, fan-out only to active+matching, RBAC 403, full CRUD, hook fires on High but not Low/Medium) + 6 SPA vitest (empty state, create + secret dialog, submit-disabled-until-filled, test-fire updates last-status, delete removes from list, non-admin gets 403).

### 2026-05-02 — Alert prioritization with AI (Task 6)

- `web/src/lib/criticality.ts` — pure formula: `severityWeight × confidence × log10(exposure/100k) × ageBoost`. Hand-tuned weights documented as the prototype's "AI ranking" surrogate; production swap-point is `computeScore()`. Helpers: `bandFor()` (critical/high/medium/low), `dedupByCustomer()` (groups by customer, primary = highest criticality, others surface as `+N` linked badge), `sortBy()` (criticality / severity / age, stable).
- `Alert` type extended with `confidence`, `customer_exposure_kes`, `criticality_score`, `linked_alert_ids`. Mock alerts backfilled (8 alerts; a-1008 added on c-106 to demonstrate dedup).
- MSW `/api/alerts` computes scores + applies dedup + sorts at request time. URL params: `?sort=criticality|severity|age` (default criticality), `?dedup=true|false` (default true).
- `AlertListPage` — Score column with color-coded band badge + "conf %" sub-line, Sort dropdown, Dedup toggle, `+N` linked badge on dedup'd primaries. URL-synced.
- `services/bff/src/mapping.ts` — comment block describes how to wire the same formula into the BFF when `customer_exposure_kes` is joined into `Lookups` (full BFF wiring deferred).
- **Tests:** 16 criticality unit tests + 5 AlertListPage UI tests.

### 2026-05-02 — Rule config UX overhaul (spec §5.4 polish)

Two consecutive passes.

**Pass 1** — sticky list + search + severity strip + active-row indicator + filter result count + polished empty state + sticky in-page anchor nav.
- Sticky list panel on xl screens (`xl:sticky xl:top-4 xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto`); list stays in view while detail scrolls.
- Search input above the list (substring match on name OR id, URL-synced as `?q=`, clear-X inside).
- Outcome-severity left-edge strip on each row (red/amber/green; thicker on active row).
- Stronger active-row state (`border-action shadow-md ring-1 ring-action/20`, `aria-pressed=true`).
- Subtitle shows "X of Y rules match" when filters active.
- Polished empty state with icon + Clear-filters button.

**Pass 2** — converted detail panel from stacked sub-panels to **5-tab unified card**.
- Tabs: Overview (Plain English + Visual builder) / Workflow (maker-checker) / Backtest / Performance / Audit. URL-synced as `?tab=`. Header card stays always-visible above the tabs. Tab persists across rule switches (cross-rule audit comparison stays on Audit tab).
- Full ARIA tablist semantics (role=tablist, role=tab, aria-selected, aria-controls, role=tabpanel, aria-labelledby, tabIndex management).
- Refactored 6 sub-components (PlainEnglishPreview / VisualBuilder / MakerCheckerPanel / BacktestPanel / PerformancePanel / AuditPanel) to use a local `<Section>` helper instead of `<Panel>` so the outer tabbed card owns the chrome — no nested-panel visual.
- Sticky tablist with `bg-surface/95 backdrop-blur-sm border-b` so it stays readable as content scrolls under.

**Tests:** 11 net-new RuleConfigPage tests (search by name/id, clear-search, "X of Y" subtitle, empty-state Clear-filters button, ARIA tablist + 5 tabs, ?tab= URL deep-link, tab persists across rule switches, default-tab Overview shows plain-english + visual-builder while other testids are absent, each tab loads its expected sub-panel when clicked, Workflow tab + Backtest tab navigation for legacy tests).

### 2026-05-02 — Customer Risk Profile §5.3 360-view enhancement

- New `LinkedAlertsPanel` + `LinkedCasesPanel` on the Customer Risk Profile page. Both query `/api/alerts?customer_id=:id` and `/api/cases?customer_id=:id` (new optional filter on both endpoints + their MSW handlers). Empty states with icon + helpful copy. Click-through links to `/alerts` and `/cases/:id`. SLA badge on case rows.
- `api.alerts()` + `api.cases()` types extended with `customer_id?` param.
- **Tests:** 4 new vitest tests on CustomerRiskProfilePage (linked alerts list renders the customer's alert, linked case row links to `/cases/:id`, both panels show empty state for a customer with no alerts/cases).

### Tally as of 2026-05-02

- **SPA vitest:** 204 pass across 33 files (was 27 at Wave 3 wrap; +177 net-new from auth sweep + Wave 4 UX work).
- **BFF jest:** 210 pass across 13 suites (was 197; +13 from webhook subsystem).
- **TypeScript clean** across `web/`, `services/bff/`, `services/auth-svc/`, `infra/rbac/lib/`.
- **Dev server smoke** (Path A — MSW): every page route serves `200 OK`. Demo accounts in [README.md](README.md) Quick Start.
- **Active scheduled follow-ups (in-session, may not survive Claude Code restart):**
  - `c8db3fd5` — 2026-05-16 09:11 — convert `/v1/reports` PDF/Excel to client-side (mirror scenario approach).
  - `231b8391` — 2026-05-23 09:17 — build T4.1 Analytics Dashboard suite (4 sub-dashboards).
  - `6a1cfb0d` — 2026-05-30 09:13 — wire reserved webhook event types (`alert.updated`, `case.assigned`, `case.closed`) once case lifecycle matures.
  - Recipes saved to `~/.claude/projects/-Users-taniya-apex-ews/memory/project_pending_followups.md` for cross-session recovery.

### 2026-05-03 — Database fill-out: 10k-customer scale-up + 5 new app schemas + ~731k rows

Big push to make the Postgres database **look complete in DBeaver** for the demo. Schema-only — service-wiring (services actually reading/writing the new tables instead of in-memory stores) is deferred per Gap 3 part B in [`docs/database-gap-analysis.md`](docs/database-gap-analysis.md). Two new docs published in this session: [`docs/database-schema.md`](docs/database-schema.md) (column-level reference for all 9 schemas) and [`docs/database-gap-analysis.md`](docs/database-gap-analysis.md) (live inventory + sized fix plans).

**1. Scaled raw seed 45×** — `data/dbt/seeds/_generate_seeds.py` knobs bumped from `N_CUSTOMERS=220 / N_LOANS_TARGET=520 / N_TXNS_TARGET=6000` to `10_000 / 24_000 / 280_000`; safety cap on repayments removed (no longer needed). Re-ran `dbt seed --full-refresh` (3m52s) + `dbt run` (7s) + `dbt test` (1.3s). All 79 dbt tests still pass on the larger volume. New raw row counts: 10,000 customers / 24,000 loans / 247,550 repayments / 289,819 transactions / 10,000 bureau scores. Mart rebuilds: `mart.customer_360` 10k / `mart.loan_360` 24k / `mart.txn_features` 10k / `mart.indicator_values` 80k. NPA ratio: 4.25% (1,019 of 24,000 loans), 528 unique defaulted customers.

**2. Closed Gap 1** — the 5 `raw.cbs_*` tables defined in `002_raw_tables.sql` had sat empty for the entire prototype lifecycle. Schema lied: anyone reading the SQL thought a CBS loader wrote to those tables, but data actually lived in `raw.seed_*` (loaded by dbt seed) and the `sources.yml` aliases hid the redirect. Fixed cleanly:
  - Dropped the 5 empty tables: `DROP TABLE IF EXISTS raw.cbs_customer_profile;` and 4 siblings.
  - Rewrote [`002_raw_tables.sql`](data/schema/002_raw_tables.sql) — declares only the `seed_*` tables that actually carry data; original `cbs_*` schemas preserved in git history for reinstatement when T1.4b ships the real CBS loader.
  - Cleaned [`data/dbt/models/sources.yml`](data/dbt/models/sources.yml) — dropped all 5 `identifier:` aliases; sources reference `seed_*` directly.
  - Mechanical rename across the 5 staging models (`{{ source('raw', 'seed_customers') }}` etc.).

**3. Added 5 new application schemas** via [`data/schema/004_app_schemas.sql`](data/schema/004_app_schemas.sql) — gives the operational stores a real Postgres home. Production target wiring is the next sessions' work.
  - `app_iam.{users, sessions, password_history, audit_events}` — owned by `services/auth-svc`. CHECK constraints on role + event_type. FKs sessions/password_history → users with CASCADE.
  - `app_cases.{cases, actions}` — owned by `services/regulatory-svc/cases`. CHECK on state ∈ {open, assigned, in_action, monitored, closed} + outcome ∈ {cured, cured_temp, defaulted}; partial index on sla_status for {approaching, breached}.
  - `app_alerts.{alerts, queue_assignments}` — owned by `services/regulatory-svc/alerts`. Carries the criticality_score + customer_exposure_kes fields added in the 2026-05-02 prioritization work.
  - `app_bff.{webhook_subscriptions, webhook_deliveries}` — owned by `services/bff` webhooks. Secret column is hex HMAC key; never returned via list/get APIs.
  - `app_scenario.saved_scenarios` — JSONB result column preserves the full ScenarioResult so reload shows saved numbers (not a re-run if engine elasticities change).

**4. Generated synthetic app data** via [`data/schema/_generate_app_seeds.py`](data/schema/_generate_app_seeds.py) (seed=43, deterministic). Produces `app_seeds.sql` (~26,000 rows) loaded via `psql -f`:
  - `app_iam.users`: 505 (5 demo accounts u-001..u-005 verbatim from `services/auth-svc/src/users.ts` + 500 synthetic)
  - `app_iam.sessions`: 3,105 (avg ~6 per user, ~35% revoked, mix of Chrome/Firefox/Mobile/Safari)
  - `app_iam.password_history`: 1,445 (avg 2-3 historical hashes per user)
  - `app_iam.audit_events`: 12,000 (14 event types weighted by realistic frequency)
  - `app_cases.cases`: 528 (one per defaulted customer; mix of all 5 states; SLA distribution)
  - `app_cases.actions`: 1,568 (avg ~3 actions per non-open case; GPS for visit actions)
  - `app_alerts.alerts`: 2,527 (defaulted cohort + 50% of WATCH-status loan customers; criticality_score computed via the production formula)
  - `app_alerts.queue_assignments`: 3,431 (avg ~1.4 assignments per alert showing reassignment history)
  - `app_bff.webhook_subscriptions`: 25 (22 active, 3 deactivated; realistic names like "AML Hub primary", "PagerDuty critical", "Slack #risk-alerts")
  - `app_bff.webhook_deliveries`: 915 (~92% success rate; failures show 500/502/503/0/401)
  - `app_scenario.saved_scenarios`: 120 (12 named templates × ~10 quarter-tagged variants)

**5. Final state in DBeaver:** **9 schemas / 21 tables / ~731,500 rows.** The dev container at `apex-ews-pg:55432` shows everything alive. Connect with role `apex` / db `apex_ews`.

**Next-session backlog** (open Gap 3 part B in [`docs/database-gap-analysis.md`](docs/database-gap-analysis.md)):
- ~10-13 hours total per-service wiring across 5 services
- Recommended order: **bff webhooks** (2 hr, lowest risk) → **auth-svc users+sessions** (2-3 hr) → **cases** (2-3 hr) → **auth-svc audit + audit.event_log** (closes Gap 2) → **alerts** (lower priority) → **scenario** (lowest priority)
- Each is a self-contained TASKS.md entry — see T4.13–T4.17 below.

### Wave 2 wrap-up (Phase 1 build complete)

- **Tasks shipped this session:** Phase 0 — T0.2/T0.3/T0.4/T0.5 ✅ (T0.1 charter + T0.6 vendor stubs still pending). Phase 1 — T1.1, T1.2, T1.3, T1.4, T1.5, T1.6, T1.7, T1.8, T1.9, T1.10, T1.11, T1.12, T1.13, T1.14, T1.15, T1.16 ✅ (full Phase 1). Phase 2 — T2.2, T2.3, T2.4, T2.5, T2.6, T2.7, T2.10 ✅ (T2.1 feature-store, T2.8 UI risk-profile hookup, T2.9 NL→SQL Copilot stub still pending).
- **Verification:** still B1 — sandbox blocks every executable. `BOOTSTRAP.md` is the single source of truth for the run-order.
- **Recommended next wave (Wave 3):** agent-case (T3.5) + agent-ui Phase-2 hookup (T2.8 risk profile with SHAP top-5 + T3.6 Case View) + agent-integration deepening (T3.7 public REST API v1, T3.8 schema-registry CI, T3.10 BFF mapping). Hold T3.1–T3.4 until B1 is resolved so the integration agent can actually exercise the contracts.

### 2026-04-26 — Re-verification from clean Docker state (steps 2+3+B2 reproduced)

- [orchestrator] Docker had been reset and `apex-ews-pg` was gone; `postgres:16` re-pulled. `make up && make migrate && make verify` green from scratch (4 schemas, 5 raw tables, audit-trigger smoke pass).
- [orchestrator] Two new dbt-1.11-compat fixes surfaced (the 2026-04-27 run was on dbt-core ≤1.10 and didn't hit them):
  - `data/dbt/packages.yml` — `version: ">=1.1.1,<2.0.0"` no longer parses as a single string in dbt 1.11's stricter semver. Switched to YAML-list form: `version: [">=1.1.1", "<2.0.0"]` (same fix on both `dbt_utils` and `dbt_expectations`). `dbt deps` resolves cleanly: `dbt_utils 1.3.3`, `dbt_expectations 0.10.4`, `dbt_date 0.10.1`. Note: deprecation warning that `calogica/dbt_expectations` should migrate to `metaplane/dbt_expectations` — not blocking.
  - `data/dbt/models/marts/schema.yml` — `dbt_utils.accepted_range` doesn't accept `row_condition` (never did; previous dbt versions silently dropped the unknown kwarg). Three call sites converted to the dbt-native `config: { where: "..." }` test-level filter (`bureau_score`, `exposure_to_income_ratio`, `burn_ratio_30d`).
- [orchestrator] After the two fixes: `dbt seed && dbt parse && dbt run && dbt test` all green — same 9 models, **79/79 tests pass**.
- [orchestrator] B2 re-trained against today's mart pull: same outcome as 2026-04-27 — challenger v0.1.0 AUC 1.0 / KS 1.0 / Brier 0.0023 / CV-AUC 1.0±0.0 on n_train=176 / n_holdout=44 (8 + 4 positives). Same leakage caveat (`has_npa` ≡ `worst_dpd > 0`); synthetic-trained 0.8822 model remains champion.
- [orchestrator] **Side note worth flagging:** `train_pd.py` overwrote the existing v0.1.0 entry in `ml/registry/registry.json` instead of producing a new version. The previous synthetic-champion AUC 0.882 record is no longer in the JSON; only the mart-trained challenger (AUC 1.0) is present. The trained artifact at `ml/models/pd/v0.1.0/` still corresponds to whichever was last trained. **Fix landed same day** — `train_pd.py` now resolves the version before training: if `v<N>` already exists on disk or in the registry, the patch component is auto-bumped (with a warning) and a fresh entry is created; pass `--overwrite` for the old in-place behaviour. Verified: re-running with no args after the mart train produced `v0.1.1` and preserved `v0.1.0`; `--version 0.1.1 --overwrite` then replaced `v0.1.1` in place without growing the registry.
- [orchestrator] BOOTSTRAP.md gaps still pending (carry-over): (a) `npm run gen-history` missing before `npm run simulate`; (b) `web/package.json` has no `typecheck` script; (c) `services/audit-svc/requirements.txt` doesn't exist; (d) `libomp` install needed for xgboost on macOS arm64; (e) `data/dbt/macros/generate_schema_name.sql` was missing on 2026-04-27 (now in tree); (f) `ml/data/load_from_mart.py` SCHEMA_QUERY needed reconciling against the actual mart shape; (g) `train_pd.py` low-data profile; **(h) NEW: `data/dbt/packages.yml` version-list syntax;** **(i) NEW: `data/dbt/models/marts/schema.yml` row_condition → `config.where`;** ~~**(j) NEW: `train_pd.py` should bump model version on re-train against a different label rather than overwriting the registry entry in place.**~~ FIXED — train_pd.py now auto-bumps; `--overwrite` opts back into in-place replacement.
- [orchestrator] **Browser-smoke defect found running `make web-dev`:** `web/public/mockServiceWorker.js` was missing — vitest+jsdom never exercises MSW's service-worker registration so the test suite was green, but `import.meta.env.DEV` triggers `worker.start()` in `web/src/main.tsx` and that throws before React mounts. The page served correctly (`<title>APEX EWS</title>`, `<div id="root">`) but the SPA bundle never rendered. Fixed in tree by `npx msw init public/ --save` from `web/`. Carry-over (k): regenerate the worker as part of `make install` or document the `npx msw init` step in BOOTSTRAP.md so this doesn't bite the next clone.
