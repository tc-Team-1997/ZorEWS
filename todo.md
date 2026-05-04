# EWS.docx — Feature Gap Registry

**Last updated:** 2026-05-04 (T4.24 Phase 6 — regulatory-svc/alerts tenant-scoped: SmartQueue + PgSmartQueue + evaluator + server all thread tenant through)

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
- **T4.24** — Multi-tenant API foundation + enterprise envelope (`Banking API Integration` doc §3, §6, §7, §11). _(Phases 1 + 2 + 3 + 4 + 5 + 6 shipped 2026-05-03 → 2026-05-04)_ — Phase 1: `app_iam.tenants` + `app_iam.service_clients` migration (`005_tenants.sql`); `tenant_id` FK on `app_iam.users`; BFF tenant middleware (`X-Tenant-ID` + `X-Channel`); standard `{header, body}` request/response envelope + `{error: {code, message, severity}}` error shape; OAuth client-credentials `POST /oauth/token` in auth-svc; `POST /v1/ews/evaluate` migrated as the reference endpoint. Phase 2: envelope rolled out to `/v1/alerts`, `/v1/risk-profile/:customer_id`, `/v1/action`, `/v1/copilot/chat`, `/v1/scenario/run`, `/v1/scenarios*`; tenant gate (no envelope) applied to every other `/v1/*` route (webhooks, rules, reports, sla, notifications, integrations) — every public `/v1/*` endpoint now requires tenant context. `PgServiceClientStore` shipped with cache-on-init + idempotent seed. Still deferred: data-layer tenant filtering (mart + app_*); audit-event `tenant_id`/`channel` columns; envelope migration for ops endpoints; admin SPA tenant + service-client CRUD. Source documents: `Banking Api Integration – EWS Full Technical Documentation (1).pdf` + `DataNetworks-EWS-Ver1.pdf` (BIL pitch deck — multi-tenant is the prerequisite for serving BIL alongside the bank demo).

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
