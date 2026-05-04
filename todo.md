# EWS.docx — Feature Gap Registry

**Last updated:** 2026-05-04 (T6 M9.2 — Custom investigation checklists shipped — tenants can define KYC/sanctions/complaint/AML checklists alongside the BIL §17 default)

> Section-by-section walk through `EWS.docx` (the original design source — 11 MB Word doc at repo root, 133 text paragraphs) against what is actually shipped in the prototype. Each row is a feature called out by the doc, mapped to its current implementation status and the canonical task in `TASKS.md` (if any).
>
> **Legend:** ✅ done · ⏳ pending (covered by a TASKS.md task) · 🆕 new gap surfaced by this audit
>
> Pair this with `STATUS.md` for the verification matrix and `TASKS.md` for the canonical backlog. This file is read-only audit output — when an item lands, tick it in `TASKS.md`, not here.

## §3 Core Modules

| § | Feature | Status | TASKS.md | Notes |
|---|---------|--------|----------|-------|
| 3.1 | CBS — loan / DPD / repayment ingest | ⏳ | T3.1 | Synthetic seed scaled 2026-05-03 to 10k customers + 24k loans + 247k repayments in `mart.loan_360`; real CBS loader (T1.4b → `raw.cbs_*` tables) still pending. The empty `cbs_*` tables defined by `002_raw_tables.sql` were dropped 2026-05-03 — see `docs/database-gap-analysis.md` Gap 1 (closed) |
| 3.1 | Account transactions | ✅ | T1.3, T1.4 | `mart.txn_features` materialised; scaled to 10k customers / 290k transactions 2026-05-03 |
| 3.1 | Customer profile | ✅ | T1.3 | `mart.customer_360` (10,000 rows as of 2026-05-03) |
| 3.1 | External data (bureau, market) | ⏳ | T1.4 | Bureau-sync DAG scaffolded; 10k bureau snapshots in seed; live bureau integration not in prototype scope |
| 3.1 | 24-month historical backfill | ⏳ | T2.1 | Feature store + Aurora/S3 backfill pending |
| 3.2 | Indicator Engine — Financial family | ✅ | T1.5, T1.6 | 32-indicator catalog, compute coverage green |
| 3.2 | Indicator Engine — Behavioural family | ✅ | T1.5, T1.6 | |
| 3.2 | Indicator Engine — Transaction family | ✅ | T1.5, T1.6 | |
| 3.2 | Indicator Engine — Credit family | ✅ | T1.5, T1.6 | |
| 3.3 | Rule Engine — DSL + lifecycle | ✅ | T1.7, T1.8, T1.9 | 30 seed rules, simulator FP 0.148 |
| 3.4 | AI Risk Scoring — PD + Risk Level | ✅ | T2.2, T2.3, T2.4 | Synthetic-trained champion AUC 0.8822 |
| 3.5 | Alert Engine — real-time alerts | 🆕 | T2.12 (new) | Current path is DAG-batch on the mart; streaming/<60s path not built |
| 3.5 | Alert type — high-risk customer | ✅ | T1.10, T2.7 | |
| 3.5 | Alert type — potential default | ✅ | T1.10, T2.7 | |
| 3.5 | Alert type — fraud suspicion | 🆕 | T2.11 (new) | No `Fraud` family in indicator catalog; no fraud-tagged seed rules |
| 3.6 | Case Management — Alert → Case → Assign → Action → Monitor | ✅ | T3.5, T3.6, T3.4 | Full lifecycle wired (FR-CASE-1/3/4) |

## §4 AI Capabilities

| § | Feature | Status | TASKS.md | Notes |
|---|---------|--------|----------|-------|
| 4.1 | PD Prediction Model | ✅ | T2.2 | XGBoost + isotonic, SHAP top-5 |
| 4.2 | Early Risk Detection (before DPD) | ✅ | T2.2, T2.4 | PD score is computed independent of DPD; reason codes via SHAP |
| 4.3 | Scenario Simulation (GDP / interest-rate / FX) | ✅ | T4.2 | Shipped 2026-05-02 — full feature pack: 5 templates (Baseline/Mild/Severe/COVID/RBI), IFRS 9 stage migration matrix, segment×risk heatmap, Portfolio PD + NPA% cards, top-affected drill-down, saved scenarios with side-by-side compare, CSV/PDF/Excel export |
| 4.4 | Smart Alert Prioritisation (Critical/Medium/Low) | ✅ | T2.7, T4.9 | Original SmartQueue (T2.7); v2 prioritization (T4.9) added 2026-05-02 with criticality formula + customer dedup + sort dropdown |
| 4.5 | Continuous Learning Model | ⏳ | T5.1, T2.6 | Drift monitoring shipped (T2.6); auto-promotion gate pending (T5.1) |

## §5 UI Screens

| § | Feature | Status | TASKS.md | Notes |
|---|---------|--------|----------|-------|
| 5.1 | EWS Dashboard — total alerts, high-risk customers, PD distribution, alert trend | ✅ | T1.16, T4.8 | Enhanced 2026-05-02 with clickable KPI deep-links + time-range selector + new CustomerListPage |
| 5.2 | Alert List — Customer ID / Risk Score / Indicator / Severity / Status | ✅ | T1.16, T3.10, T4.9 | BFF maps `apex.regulatory.events.v2` to list-row; criticality scoring + dedup added 2026-05-02 |
| 5.3 | Customer Risk Profile (with SHAP top-5) | ✅ | T1.16, T2.8, T4.11 | 360-view enhancement 2026-05-02: Linked Alerts + Linked Cases panels with click-through |
| 5.4 | Rule Configuration Screen | ✅ | T1.16, T4.10 | UX overhaul 2026-05-02: search + sticky list + severity strip + 5-tab unified detail card |
| 5.5 | Analytics Dashboard | ⏳ | T4.1 | Dashboard time-range + clickable KPIs landed (T4.8); the 4 sub-dashboards (risk trend / PD distribution / stage migration / alert resolution) still pending under T4.1 |

## §6 Other Features

| § | Feature | Status | TASKS.md | Notes |
|---|---------|--------|----------|-------|
| 6 | Real-time risk alerts | 🆕 | T2.12 (new) | See §3.5 |
| 6 | Case View — customer risk summary | ✅ | T3.6 | |
| 6 | Action — Call / Visit | ✅ | T3.5, T3.6 | Action capture + log |
| 6 | Location — field tracking (GPS) | ⏳ | T4.3 | Web action capture has GPS; mobile RN shell pending in T4.3 |

## §7 Integration

| § | Feature | Status | TASKS.md | Notes |
|---|---------|--------|----------|-------|
| 7 | CBS — loan + repayment | ⏳ | T3.1 | OpenAPI mock at `integrations/cbs/openapi.yaml`; live deepening pending |
| 7 | IFRS 9 — stage movement + ECL | ⏳ | T3.2 | Mock contract only |
| 7 | Collection — auto case creation | ✅ | T3.4 | `services/collection-adapter` — case routing + callback wired |
| 7 | AML — suspicious activity | ⏳ | T3.3 | Bidirectional alert correlation pending |

## §8 Reporting

| § | Feature | Status | TASKS.md | Notes |
|---|---------|--------|----------|-------|
| 8 | Risk trend dashboard | ⏳ | T4.1 | |
| 8 | PD distribution dashboard | ⏳ | T4.1 | |
| 8 | Stage migration dashboard | ⏳ | T4.1 | |
| 8 | Alert resolution dashboard | ⏳ | T4.1 (amended) | Was missing from T4.1's bullet list; appended in this audit |

## §9 API Framework

| § | Endpoint | Status | TASKS.md | Notes |
|---|----------|--------|----------|-------|
| 9 | `POST /ews/evaluate` | ✅ | T3.7 | Public REST API v1 in `services/bff`. Now also fires `alert.created` webhook on High-risk score (T4.12) |
| 9 | `GET /ews/alerts` | ✅ | T3.7, T3.10 | |
| 9 | `GET /ews/risk-profile` | ✅ | T3.7 | |
| 9 | `POST /ews/action` | ✅ | T3.7 | |
| 9 | `POST /scenario/run` | ✅ | T4.2 | Added 2026-05-02; also fires `scenario.run` webhook (T4.12) |
| 9 | `GET /reports/:type?format=` | ✅ | (auth sweep T4.7) | snapshot / alerts / cases / rbi; PDF/Excel work in real BFF, broken in MSW dev — fix scheduled 2026-05-16 |
| 9 | `GET/POST/DELETE /webhooks` + delivery log + test-fire | ✅ | T4.12 | New 2026-05-02 — admin-managed outbound webhook subscriptions |
| 9+ | `POST /oauth/token` (client_credentials) + `X-Tenant-ID` + `X-Channel` envelope on `/v1/ews/evaluate` | ✅ | T4.24 | Banking API doc §3+§6+§7+§11. Phase 1 reference impl shipped 2026-05-03 — see net-new tasks below |

## Mobile (called out in §2 architecture diagram + §5 header)

| Feature | Status | TASKS.md | Notes |
|---------|--------|----------|-------|
| Mobile RN shell — Alert list, Case view, call/visit log, GPS | ⏳ | T4.3 | Phase 4 |

## Net-new tasks added by this audit

These were not represented anywhere in `TASKS.md` and have just been appended:

- **T2.11** — Fraud-suspicion alert type (new `Fraud` indicator family + ≥3 seed rules + alert tagging). Source: §3.5.
- **T2.12** — Real-time alert streaming path (Kafka → indicator-update → rule eval, p95 <60s). Source: §3.5.
- **T4.1 amendment** — alert-resolution explicitly added to the analytics-dashboard scope. Source: §8.
- **T4.7** — SPA auth + security hardening sweep. _(shipped 2026-04-28; not from EWS.docx — surfaced from the in-flight banking-grade hardening backlog)_
- **T4.8** — Dashboard interactivity (clickable KPIs + time-range selector + CustomerListPage). _(shipped 2026-05-02; closes the §5.1 deep-link gap implied by the spec)_
- **T4.9** — Smart Alert Prioritization v2 (criticality formula + customer dedup). _(shipped 2026-05-02; extends T2.7 SmartQueue with per-alert score)_
- **T4.10** — Rule Config UX overhaul (search + sticky list + 5-tab unified detail card). _(shipped 2026-05-02)_
- **T4.11** — Customer Risk Profile §5.3 360-view enhancement (Linked Alerts + Linked Cases panels). _(shipped 2026-05-02)_
- **T4.12** — Outbound webhook subsystem (admin-managed subscriptions with HMAC + retry + admin SPA). _(shipped 2026-05-02; from spec §9 API Framework — webhooks were not enumerated as endpoints in the original 4-line list)_
- **T4.A** — Database fill-out: 10k-customer scale-up + 5 new app schemas (`app_iam`, `app_cases`, `app_alerts`, `app_bff`, `app_scenario`) populated with ~26k rows of synthetic operator data. Closed Gaps 1 + 5 from `docs/database-gap-analysis.md`. Final database state: 9 schemas / 21 tables / ~731,500 rows. _(shipped 2026-05-03; service-wiring T4.13–T4.18 deferred to next sessions)_
- **T4.13–T4.18** — Per-service Postgres wiring (open). Each service replaces its in-memory store with reads/writes against the new `app_*` schemas. Recommended order: T4.13 bff webhooks → T4.14 auth-svc users/sessions → T4.15 cases → T4.16 audit fan-out → T4.17 alerts → T4.18 scenario. ~10-13 hours total across 5-6 sessions. See `TASKS.md` for sized per-task entries.
- **T4.24** — Multi-tenant API foundation + enterprise envelope (`Banking API Integration` doc §3, §6, §7, §11). _(Phases 1–13 shipped 2026-05-03 → 2026-05-04 — initiative complete; standalone follow-ups in TASKS.md)_
- **T6** — BIL 16-module platform expansion (~365 APIs). _(initiative kicked off 2026-05-04; M1.1, M2.1, M3.1, M4.1, M5.1, M6.1, M7.1, M8.1, M8.2, M9.1, M9.2, M10.1, M10.2, M11.1, M11.2, M11.3, M11.4, M11.5, M12.1, M13.1, M14.1, M14.2, M14.3, M14.4, M14.5, M14.6, M15.1, M15.2, M16.1 shipped same day)_. 16 modules step-by-step, additive only. M1.1 ships TOTP 2FA. M4.1 ships the 25-indicator BIL insurance KRI catalogue. **M11.1-M11.4 ship the full BIL dashboard suite** (Claims / Underwriting / Agent / Operational) under `/v1/dashboards/bil/*` — combined with the existing Executive at `/api/dashboards` that's all 5 DataNetworks dashboards, demoable today with deterministic-stub data per (tenant, day). **M6.1 ships the BIL `Σ(W×V)` risk-scoring engine** at `POST /v1/scoring/risk` — pure-function primitive that any caller can invoke with `(indicator_id, weight, value)` tuples and get back a 0-100 score bucketed Low/Medium/High per the operator-overridable thresholds. **M10.1 ships the BIL email notification channel** at `/v1/notifications/email/{templates,preview,send,log}` — `EmailTransport` interface + `StubEmailTransport` (in-memory ledger, tenant-scoped) + 4 canned templates per BIL §13 (ALERT_RED, ALERT_ORANGE, CASE_ASSIGNED, SLA_BREACH); production swap to SES/SMTP is a drop-in. **M8.1 ships the BIL Red/Orange/Yellow alert classification** at `/v1/alerts/{classification/spec,classify,by-class/:class}` — pure mapping from WireSeverity → BIL 4-colour palette per DataNetworks PDF §11 (CRITICAL→red, HIGH→orange, MEDIUM→yellow, LOW→green) with full action metadata (SLA hours, escalation path, monitor_only flag); the existing `/v1/alerts` shape is unchanged. **M14.1 ships the BIL Core Insurance / Policy Master adapter** at `/v1/integrations/insurance/{policies,claims}[/:id]` — `InsuranceAdapter` interface + `StubInsuranceAdapter` (deterministic synthetic data per (tenant, customer, day), 1-4 policies + 0-3 claims/policy, BIL ids disjoint from BANK_DEMO); production swap to a SOAP/REST gateway is a drop-in. **M14.2 ships the IFRS9 Stage adapter** at `/v1/integrations/ifrs9/stages[/:customer_id]` — `Ifrs9Adapter` interface + `StubIfrs9Adapter` (200-customer book per tenant; ~80/15/5% stage distribution) with full IFRS9 invariants (Stage 1 ⇒ DPD=0, Stage 3 ⇒ DPD ≥ 90, ECL = driver_PD × LGD × EAD); paginated list-by-stage sorted highest-ECL first. **M13.1 ships the Admin Configuration registry** at `/v1/admin/config[/categories|/:key]` — `ConfigStore` interface + `InMemoryConfigStore` + 13 BIL operational defaults across 5 categories (alerts, notifications, reporting, scoring, features); typed entries (number/string/boolean/json) with per-tenant overrides + reset-to-default. **M15.1 ships the BIL Audit & Compliance trail** at `/v1/audit/{events,actions,summary}` — `AuditTrailStore` + `InMemoryAuditTrailStore` (per-tenant capped log) with 7-axis filtering (actor / action / resource_type / outcome / severity / since-until / pagination), aggregate summary, and tenant-scoped 404 on cross-tenant lookup. **M3.1 ships the BIL Data Ingestion connector registry** at `/v1/ingestion/{health,connectors[/:id[/run|pause|resume|runs]]}` — 8 seed connectors covering the BIL upstream list (CBS, Core Insurance, Policy Master, Claims, Agent, AML, Bureau, IFRS9), with status + run-history tracking, deterministic per-day stats, and pause/resume controls. **M12.1 ships the BIL reports catalog + async job tracker** at `/v1/reports/{catalog[/:id],jobs[/:job_id]}` — 9 BIL report definitions across 4 categories (operational/regulatory/audit/business) with both RBI + IRDAI regulators represented; `ReportJobStore` + `InMemoryReportJobStore` for per-tenant submit/list/get; status code routing (201/404/409/400) per error class; backwards-compat regression-tested with the existing T4 `/v1/reports/:type`. **M14.3 ships the AML Watchlist adapter** at `/v1/integrations/aml/{screen,matches[/:id]}` — `AmlAdapter` + `StubAmlAdapter` covering the 4 watchlist categories (sanctions / PEP / adverse_media / internal) with deterministic ~85/10/5% match distribution and 4 review states (open/cleared/escalated/false_positive); PATCH endpoint records audit trail (changed_at + changed_by). **M9.1 ships the BIL Case Investigation tracker** at `/v1/investigations[/:id[/status|/steps/:step_id/complete|/notes]]` — `CaseInvestigationStore` + `InMemoryCaseInvestigationStore` with a 6-state workflow gated by an explicit transitions table, the BIL §17 standard 8-step claim-fraud evidence checklist (verify_identity → final_recommendation), 4 decisions, and a notes thread (4000-char cap). **M7.1 ships the BIL AI/ML model registry** at `/v1/ai/models[/types|/by-type/:type|/:model_id[/metrics|/score]]` — `AiModelRegistry` + `InMemoryAiModelRegistry` seeded with 8 model versions across 6 types (PD/fraud/churn/lapse/anomaly/claim_severity); 5 statuses (experimental/staging/production/shadow/retired); deterministic per-(model, tenant, customer, day) inference with band derivation + SHAP-style top features; retired-model 409 + cross-type metrics handling (AUC for binary, MAE for regression). **M5.1 ships the BIL rule template library** at `/v1/rules/templates[/categories|/:id]` — 12 starter templates across 5 categories (risk_monitoring / fraud_detection / compliance / operational / underwriting) × 3 verticals (banking / insurance / both); inclusive vertical filter (banking returns banking AND both); each template carries condition_pseudocode + recommended_severity + recommended_actions + supporting_indicators referencing the existing catalogue prefixes. **M16.1 ships the BIL named scenario library** at `/v1/scenarios/library[/categories|/:id]` — 10 presets (RBI Baseline/Adverse/Severely-Adverse, IRDAI Solvency, business shocks, pandemic + stagflation black-swans, zero-shock baseline) with multi-axis filtering by category/regulator/severity; schema invariants (regulatory→non-INTERNAL, baseline=zero, black_swan=severe). **M14.4 ships the DMS Document Management adapter** at `/v1/integrations/dms/{document-types,documents[/:id[/status]]}` — 9 document types + 4 review statuses; pivots to case_id/policy_id/claim_id; type-aware status distribution + proof-types-only expiry; PATCH-status workflow with audit trail. **M14.5 ships the Credit Bureau adapter** at `/v1/integrations/bureau/{types,pull,reports[/:id]}` — `BureauAdapter` + `StubBureauAdapter` covering 4 bureaus (CIBIL/CRIF/EXPERIAN/EQUIFAX) with 300-900 score → 4 bands (subprime/near_prime/prime/super_prime), per-day idempotency cache, and calibrated summary stats by band (subprime carries higher DPD + more enquiries). **M10.2 ships the BIL SMS notification channel** at `/v1/notifications/sms/{templates,preview,send,log}` — `SmsTransport` + `StubSmsTransport` with 4 BIL canned templates (ALERT_RED_BRIEF, OTP_LOGIN, KYC_REMINDER, PAYMENT_REMINDER), 160-char cap, E.164 phone validation; mirrors the M10.1 email shape so the `<Channel>Transport` pattern is now proven across 2 channels. **M8.2 ships the BIL alert auto-routing matrix** at `/v1/alerts/routing/{rules[/:class],decide}` — `AlertRoutingEngine` + `InMemoryAlertRoutingEngine` with 4 default rules per BIL §11 (red 4h SLA / sms+email / head_of_risk; orange 24h / supervisor; yellow 72h / analyst; green monitor-only); per-tenant overrides + escalation-before-SLA invariant + monitor_only-implies-no-SLA invariant. Combined with M8.1 + M10.1/M10.2 the platform now wires severity → class → routing decision → notification channel end-to-end. **M14.6 ships the Agent Productivity adapter** at `/v1/integrations/agent/agents[/:id[/productivity[/history]]]` — 50 agents per tenant with branch-head invariants + tier-driven productivity calibration (gold gets 2.5× policies + 82% persistency floor; bronze 1.0× / 65%); status-driven reductions (terminated → zeros, suspended/on_leave → 40% of baseline); 36-month history with cross-year traversal. **M2.1 ships the tenant readiness check** at `/v1/tenants/{me,:tenant_id}/readiness` — pure-function `runReadinessChecks` aggregating 9 cross-module structural checks (tenant_exists/active, channels_configured, vertical_assigned, config_schema_complete, email_channel_enabled+from_address, alert_routing_complete+has_active, audit_trail_active) into a single ready/warnings/blocked verdict with severity-aware aggregation rules. **M11.5 ships the BIL Executive Watchlist** at `/v1/dashboards/bil/executive` — `buildExecutiveWatchlist` consolidates top items from all 4 BIL dashboards (M11.1-4) into a single feed sorted critical→high→medium with per-source + per-severity totals. Deterministic per-(tenant, day); demonstrates platform coherence (one route reads 4 builders). **M15.2 ships the audit-trail hash-chain** at `/v1/audit/integrity` — every recorded `AuditEvent` now carries `hash` (SHA-256 over canonical encoding) + `prev_hash` (linked to the prior event); `verifyChain()` walks the chain oldest-first and reports tampering with index + event_id + expected/actual hash + reason (hash_mismatch | prev_hash_mismatch). Per-tenant chain segmentation. **M9.2 ships custom investigation checklists** at `/v1/investigations/checklists[/:id]` — `ChecklistTemplateStore` + `InMemoryChecklistTemplateStore` with platform built-in (BIL §17 default) always visible + per-tenant custom templates across 5 categories (claim_fraud / kyc_review / sanctions / complaint / other); 1-32 steps with regex-validated step_ids; POST /v1/investigations now accepts `checklist_template_id` to seed an investigation with custom steps. See TASKS.md for the full module roadmap. — Phase 1: `app_iam.tenants` + `app_iam.service_clients` migration (`005_tenants.sql`); `tenant_id` FK on `app_iam.users`; BFF tenant middleware (`X-Tenant-ID` + `X-Channel`); standard `{header, body}` request/response envelope + `{error: {code, message, severity}}` error shape; OAuth client-credentials `POST /oauth/token` in auth-svc; `POST /v1/ews/evaluate` migrated as the reference endpoint. Phase 2: envelope rolled out to `/v1/alerts`, `/v1/risk-profile/:customer_id`, `/v1/action`, `/v1/copilot/chat`, `/v1/scenario/run`, `/v1/scenarios*`; tenant gate (no envelope) applied to every other `/v1/*` route (webhooks, rules, reports, sla, notifications, integrations) — every public `/v1/*` endpoint now requires tenant context. `PgServiceClientStore` shipped with cache-on-init + idempotent seed. Still deferred: data-layer tenant filtering (mart + app_*); audit-event `tenant_id`/`channel` columns; envelope migration for ops endpoints; admin SPA tenant + service-client CRUD. Source documents: `Banking Api Integration – EWS Full Technical Documentation (1).pdf` + `DataNetworks-EWS-Ver1.pdf` (BIL pitch deck — multi-tenant is the prerequisite for serving BIL alongside the bank demo).

## Scheduled follow-ups (in-session crons)

These are tracked in the active Claude Code session as one-shot scheduled jobs. Recipes saved to memory at `~/.claude/projects/-Users-taniya-apex-ews/memory/project_pending_followups.md` for cross-session recovery.

- **2026-05-16** — Convert existing `/v1/reports` PDF/Excel downloads to client-side (cron `c8db3fd5`). Mirrors the scenario approach so MSW dev mode produces real binaries.
- **2026-05-23** — Build T4.1 Analytics Dashboard suite (cron `231b8391`). 4 sub-dashboards: risk trend / PD distribution / stage migration / alert resolution. Reuses scenario engine helpers for stage migration; new `analytics:read` RBAC op.
- **2026-05-30** — Wire reserved webhook event types `alert.updated`, `case.assigned`, `case.closed` into BFF case lifecycle transitions (cron `6a1cfb0d`). Depends on Task 8 (case management) maturity.

## Database state (post 2026-05-03 fill-out)

| Schema | Tables | Live rows | Source-of-truth doc |
|---|---|---|---|
| `raw` | 5 | 581,369 | `data/dbt/seeds/_generate_seeds.py` |
| `staging` | 5 (views) | n/a | `data/dbt/models/staging/` |
| `mart` | 4 | 124,000 | `data/dbt/models/marts/` |
| `audit` | 1 | 4 (smoke only — Gap 2 still open per `docs/database-gap-analysis.md`) | `data/schema/003_audit_table.sql` |
| `app_iam` | 4 | 17,055 | `data/schema/004_app_schemas.sql` + `_generate_app_seeds.py` |
| `app_cases` | 2 | 2,096 | same |
| `app_alerts` | 2 | 5,958 | same |
| `app_bff` | 2 | 940 | same |
| `app_scenario` | 1 | 120 | same |
| **Total** | **26** | **~731,500** | column-level reference: [`docs/database-schema.md`](docs/database-schema.md) |

Open backlog: services don't yet read/write the `app_*` tables — that's T4.13–T4.18 in TASKS.md. See [`docs/database-gap-analysis.md`](docs/database-gap-analysis.md) Open Gap A for the sized per-service backlog.

## Out of scope for this prototype (per `project_apex_ews_scope.md`)

- Real AWS deploy (Terraform `apply`) and live bank integrations (CBS/IFRS9/AML/Collection) — only OpenAPI mocks ship.
- DR drill, pen-test, ISO 27001 audit — Phase 5 backlog (T5.2–T5.4).
- Production mobile app build — only the RN shell is in scope (T4.3).
