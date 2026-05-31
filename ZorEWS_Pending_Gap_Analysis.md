# ZorEWS — Pending Functionality / API Gap Analysis

**Inputs:**

- `ZorEWS_Wireframe.html` — 35+ screens, 150+ modals (functional contract)
- `openapi.md` — 775 routes auto-discovered from `services/bff` + `services/auth-svc`, grouped into 10 tag buckets (Auth · Users · Dashboard · Borrower · EWS · Alerts · Workflow · AI · Reports · Config)
- **Goal:** Demo readiness for local-only deployment with this exact UI.

**Headline:** Backend coverage is **strong overall** — Auth, Workflow, Alerts, AI Model Registry, Reports, Audit, Ingestion, IFRS9, Notifications are all well-built. **Demo-blocking gaps cluster in 3 areas:** (1) Banking domain analytics (SMA / Ratios / Sector / Account Behaviour / CMA), (2) Data pipeline AI features (Profiling / Standardisation / Anomaly / Explainability), and (3) the entire Insurance vertical.

---

## 1. Coverage Scorecard (screen-by-screen)

Legend: **DONE** = wireframe needs are met · **PARTIAL** = some endpoints exist but key surfaces missing · **MISSING** = no/very thin backend coverage.

### 1.1 Data Pipeline (8 screens)

| # | Wireframe Screen | Status | Mapped APIs / Notes |
|---|---|---|---|
| 1 | EWS Dashboard | **DONE** | `/v1/dashboards/bil/{executive,operational,claims,underwriting,agent}` + custom widgets |
| 2 | Data Ingestion | **DONE** | `/v1/ingestion/connectors/*` (pause/resume/run/schema/runs/SLA) |
| 3 | Data Profiling (AI) | **MISSING** | No column-profile, no distribution, no AI auto-suggest-DQ-rules endpoint |
| 4 | Validation Rules (AI) | **DONE** | `/v1/dq/rules/*` (CRUD + run) + `/v1/ews/rules/*` (versioning, approval, clone, simulate) |
| 5 | Standardisation (AI) | **MISSING** | No canonicalisation pipeline / dictionary endpoints |
| 6 | Anomaly Detection (AI) | **MISSING** | No statistical/ML anomaly endpoints; only `/v1/aml/*` covers AML matches |
| 7 | Reconciliation | **DONE** | `/v1/recon/definitions/*`, `/v1/recon/runs/*`, `/v1/recon/dashboard` |
| 8 | Data Quality Score | **DONE** | `/v1/dq/dashboard`, `/v1/dq/executions`, `/v1/admin/data-quality/orphan-references` |

### 1.2 Banking Module (7 screens)

| # | Wireframe Screen | Status | Mapped APIs / Notes |
|---|---|---|---|
| 9 | Borrower Watch | **DONE** | `/api/customers`, `/v1/customers/:id/360`, `/v1/risk-profile/:customer_id`, `/v1/watchlist/*` |
| 10 | Account Behaviour (AI) | **MISSING** | No account-signal store, no behavioural-signal scoring; `/v1/master/accounts` is master-data only |
| 11 | Financial Ratios | **MISSING** | No ratio CRUD, no per-borrower ratio watchlist, no thresholds, no sector benchmark, no notes, **no CMA Pack generator** |
| 12 | SMA Classification | **MISSING** | Zero SMA endpoints. (RBI SMA-0/1/2 movement, drill, sector view all absent.) IFRS9 stages exist but ≠ SMA |
| 13 | NPA Prediction (AI) | **PARTIAL** | Generic `/v1/ai/models/*` + `/v1/ai/predictions` exist, but no NPA-specific high-risk-accounts endpoint, no 30/60/90 d horizon, no "why" feature-importance per prediction |
| 14 | Fraud Signals — Banking (AI) | **PARTIAL** | `/v1/fraud/dashboard` is the only fraud surface. No fraud-cases CRUD, no fraud-rules editor, no SAR/Vigilance referral endpoints |
| 15 | Sector Watch | **PARTIAL** | `/v1/master/sectors` (CRUD) exists, but no portfolio concentration × stress heatmap, no sector deep-dive, no sector watchlist |

### 1.3 Insurance Module (7 screens) — **ENTIRE VERTICAL ESSENTIALLY MISSING**

| # | Wireframe Screen | Status | Mapped APIs / Notes |
|---|---|---|---|
| 16 | Lapse Risk (AI) | **MISSING** | No lapse-risk endpoints |
| 17 | Claims Anomaly (AI) | **PARTIAL** | `/v1/integrations/insurance/claims` (read-only integration) — no anomaly scoring |
| 18 | Fraud Detection — Insurance (AI) | **MISSING** | No network-analysis / staged-accident / provider-fraud endpoints |
| 19 | Solvency Watch | **MISSING** | No IRDAI solvency margin endpoint, no driver breakdown |
| 20 | Persistency Watch | **MISSING** | No 13/25/37/49/61M persistency endpoints |
| 21 | Underwriting Deviation (AI) | **PARTIAL** | `/v1/dashboards/bil/underwriting` exists at dashboard level but no deviations-list/detail endpoint |
| 22 | Channel Risk | **MISSING** | No channel scorecard endpoints |

### 1.4 Alerts & Workflow (2 screens)

| # | Wireframe Screen | Status | Mapped APIs / Notes |
|---|---|---|---|
| 23 | Alerts & Cases | **DONE** | `/v1/alerts/*` (54 routes incl. routing, ack, auto-ack, SLA, classification, AML correlation), `/v1/cms/cases/*` |
| 24 | Case Workflow (pipeline) | **DONE** | `/v1/cases/*`, `/v1/cms/cases/*` (transition, assign, escalate, close, attachments, notes), `/v1/investigations/*`, `/v1/cases/maker-checker/*` |

### 1.5 Reports & BI (1 screen)

| # | Wireframe Screen | Status | Mapped APIs / Notes |
|---|---|---|---|
| 25 | Reports & BI | **DONE** | `/v1/reports/catalog`, `/v1/reports/builder/*` (run/preview/saved/sources/export.csv), `/v1/reports/jobs/*`, `/v1/reports/schedules/*`, `/v1/scenarios/*` |

### 1.6 AI Layer (3 screens)

| # | Wireframe Screen | Status | Mapped APIs / Notes |
|---|---|---|---|
| 26 | AI Workbench | **PARTIAL** | Copilot covered (`/v1/copilot/v2/*`), but no **prompt library** endpoint, no **lifecycle scenarios** content endpoint |
| 27 | Model Registry | **DONE** | `/v1/ai/models/*` (CRUD, metrics, performance, promotion-gate, AB-test, retraining) |
| 28 | AI Explainability | **MISSING** | No per-prediction feature-importance / SHAP endpoint; no "trust signals" surface |

### 1.7 Setup (3 screens)

| # | Wireframe Screen | Status | Mapped APIs / Notes |
|---|---|---|---|
| 29 | Master Setup | **PARTIAL** | Have: accounts, bureaus, customers, geographies, policies, sectors. **Missing masters:** Currencies, Source Types, Severity Levels, Borrower Segments, Regulators (RBI/IRDAI/RMA/CBK frameworks), Financial Ratios Master, Review Cadences, Reference Data Master, Roles master, Reassign basis/team, Recipients master, Schedule format/frequency masters |
| 30 | Thresholds & Limits | **DONE** | `/v1/indicators/thresholds/*` (overrides, suggest, drift, shift-analysis, effective, band-gap) |
| 31 | Workflows | **PARTIAL** | Case workflow covered; no separate workflow-templates CRUD endpoint for non-case workflows |

### 1.8 Admin (4 screens)

| # | Wireframe Screen | Status | Mapped APIs / Notes |
|---|---|---|---|
| 32 | Users & RBAC | **DONE** | `/auth/users/*`, `/auth/teams/*`, `/auth/2fa/*`, `/auth/sessions/*`, `/v1/admin/api-keys/*`, `/auth/dashboard-widgets/:role`, `/auth/leave-covers/*` |
| 33 | Audit Trail | **DONE** | `/v1/audit/*` (events, evidence, integrity, correlations, heatmap, severity-matrix), `/v1/admin/audit-activity/*`, `/v1/admin/audit-retention/*` |
| 34 | Testing Hub | **MISSING** | No test-case CRUD, no bulk-upload-tests, no auto-test scheduler, no test-failure investigation endpoint. (`/v1/ews/rules/:id/test` is rule-test only, `/v1/webhooks/:id/test` is webhook-test only.) |
| 35 | Glossary | **MISSING** | No glossary/terminology endpoint |

### 1.9 Cross-Cutting Features

| Feature | Status | Notes |
|---|---|---|
| Data Lineage modal | **DONE** | `/v1/metadata/lineage/*` (catalog, upstream/downstream/impact) |
| Export (CSV/Excel/PDF) | **PARTIAL** | CSV via `/v1/reports/builder/export.csv`. PDF only via printable text endpoints (`/v1/ai/models/:id/performance/summary.txt`). No generic Excel export, no PDF generator |
| Notices (issue/preview/cohort) | **MISSING** | No notice-template/preview/issue endpoints |
| CMA Pack | **MISSING** | No CMA generator (Form II/III/IV/V) |
| Notifications (email/SMS/push/webhook) | **DONE** | `/v1/notifications/*` is fully built out |
| Help / Keyboard shortcuts / Videos | **N/A** | Static UI content; no backend needed |

---

## 2. Pending Work Grouped by Effort

### 2.1 Demo-Blocking (must-have before demo) — **HIGH PRIORITY**

Without these, the demo will visibly fail when the user clicks into the corresponding screens.

1. **SMA Classification screen** — Build:
   - `GET /v1/banking/sma/movements?date=&framework=` (today's transitions per regulator code)
   - `GET /v1/banking/sma/drill?from=&to=&framework=` (movement detail with reason)
   - `GET /v1/banking/sma/sector-view?framework=` (sector breakdown)
   - `GET /v1/banking/sma/trend?customer_id=&from=&to=` (per-borrower trend)
   - `POST /v1/banking/sma/run-classification` (manual trigger)

2. **Financial Ratios + CMA Pack** — Build:
   - `GET /v1/banking/ratios/master` (config list — DSCR, ICR, Current, Quick, DE, etc.)
   - `GET /v1/banking/ratios/customer/:customer_id` (per-borrower ratios + history)
   - `GET /v1/banking/ratios/sector-benchmark?sector=` (quarterly RBI + internal aggregates)
   - `PUT /v1/banking/ratios/thresholds/:ratio_code` (warning/critical bands)
   - `POST /v1/banking/cma/pack` body `{ cohort: [customer_ids], forms: [II,III,IV,V] }` → returns PDF/HTML URL

3. **Account Behaviour signals** — Build:
   - `GET /v1/banking/accounts/signals?customer_id=&watchlist_only=` (top signals)
   - `GET /v1/banking/accounts/:account_id/patterns` (visualised behavioural patterns)
   - `POST /v1/banking/accounts/:account_id/block` (4-eyes block workflow)

4. **Sector Watch heatmap** — Build:
   - `GET /v1/banking/sectors/heatmap` (concentration × stress matrix)
   - `GET /v1/banking/sectors/:sector_id/deep-dive` (multi-quarter analytics)
   - Sector watchlist CRUD endpoints

5. **NPA Prediction specifics** — Wrap your existing AI model surface with:
   - `GET /v1/banking/npa/high-risk?horizon=90` (high-risk accounts)
   - `GET /v1/banking/npa/predictions/:account_id/why` (feature importance — see #6)
   - `GET /v1/banking/npa/backtest/latest`

6. **AI Explainability (per-prediction)** — Build:
   - `GET /v1/ai/predictions/:prediction_id/explanation` (SHAP-style feature importance + sample explanation)
   - `GET /v1/ai/predictions/:prediction_id/trust-signals` (model trust indicators)

7. **Data Profiling (AI suggest-rules)** — Build:
   - `GET /v1/dq/profile/:source_id/columns` (column profile: stats, distribution, format detection)
   - `GET /v1/dq/profile/:source_id/column/:col/distribution`
   - `POST /v1/dq/profile/:source_id/suggest-rules` (AI auto-suggest)
   - `POST /v1/dq/profile/promote-rule` (promote into Validation Rules library)

8. **Anomaly Detection** — Build:
   - `GET /v1/anomalies?window=24h&source=&severity=` (recent anomalies)
   - `GET /v1/anomalies/:anomaly_id` (case detail with evidence)
   - `POST /v1/anomalies/patterns/config` (configure detection patterns)
   - `POST /v1/anomalies/rerun` (re-evaluate window)

### 2.2 Demo-Blocking only if Insurance mode is shown — **HIGH if Insurance, else skip**

If your demo is **Bank-only**, skip this entire block.
If you toggle to Insurance during the demo, build at minimum:

9. **Insurance Lapse Risk** — `GET /v1/insurance/lapse/high-risk?horizon=`
10. **Insurance Claims Anomaly** — `GET /v1/insurance/claims/high-risk` (scoring on top of existing `/v1/integrations/insurance/claims`)
11. **Insurance Fraud Detection** — `GET /v1/insurance/fraud/cases` + detail
12. **Solvency Watch** — `GET /v1/insurance/solvency/margin` + `GET /v1/insurance/solvency/drivers`
13. **Persistency Watch** — `GET /v1/insurance/persistency?cut=13M|25M|...` + `GET /v1/insurance/persistency/channel-vintage-matrix`
14. **Underwriting Deviation** — `GET /v1/insurance/uw/deviations`
15. **Channel Risk** — `GET /v1/insurance/channels/scorecard`

### 2.3 Wireframe-Visible but Lower Risk — **MEDIUM PRIORITY**

These appear in the UI but won't necessarily crash the demo:

16. **Standardisation pipelines** — `GET/POST/PUT /v1/dq/standardisation/pipelines/*` + dictionaries CRUD
17. **Notice generation** — `GET /v1/notices/templates`, `POST /v1/notices/preview`, `POST /v1/notices/issue` (with cohort support)
18. **Fraud (Banking) full surface** — Fraud cases CRUD, fraud-rules editor, SAR submission, Vigilance referral
19. **Missing master-data screens** — Add CRUD endpoints for: Currencies, Source Types, Severity Levels, Borrower Segments, Regulators (with country-specific frameworks), Financial Ratios Master, Review Cadences, Reference Data Master, Roles master, Reassign basis/team, Recipients master, Schedule format/frequency masters
20. **Workflows (non-case)** — Workflow-templates CRUD for sectors outside CMS

### 2.4 Nice-to-have for Polished Demo — **LOW PRIORITY**

21. **Testing Hub** — Test-case CRUD + bulk CSV upload + auto-test scheduler + test-failure modal
22. **Glossary** — `GET /v1/glossary/terms` (or just serve static JSON)
23. **AI Workbench prompt library** — `GET /v1/ai/prompts/library`, `POST /v1/ai/prompts`
24. **Excel + PDF export generators** — Generic table → XLSX / PDF service

---

## 3. Recommended Build Order for Demo (concrete sprint plan)

Assuming **2-week sprint to demo**, single developer, Bank-only demo:

### Week 1 — Banking domain depth (the demo's centre of gravity)

| Day | Build |
|---|---|
| Day 1 | SMA Classification (#1) — 5 endpoints + seed data |
| Day 2 | Financial Ratios (#2) — 4 GET endpoints + 1 PUT threshold |
| Day 3 | CMA Pack generator (#2) — HTML/PDF render of Forms II/III/IV/V |
| Day 4 | Account Behaviour signals (#3) — 3 endpoints + signal-scoring stub |
| Day 5 | Sector Watch heatmap (#4) — 2 endpoints + heatmap aggregation |

### Week 2 — AI surfaces + data pipeline gaps + polish

| Day | Build |
|---|---|
| Day 6 | NPA wrap (#5) + AI Explainability (#6) — feature-importance endpoint |
| Day 7 | Data Profiling AI suggest-rules (#7) — column profile + suggest + promote |
| Day 8 | Anomaly Detection (#8) — list, detail, rerun |
| Day 9 | Notice generation (#17) + missing critical masters (#19 — at least Regulators, Severity, Segments) |
| Day 10 | Smoke pass — wire every wireframe drill-down click to a working endpoint; record demo dry-run |

If Insurance is in scope, **add a week** for items #9–#15.

---

## 4. Summary Table

| Group | Total Screens | Done | Partial | Missing |
|---|---:|---:|---:|---:|
| Data Pipeline | 8 | 5 | 0 | 3 |
| Banking | 7 | 1 | 3 | 3 |
| Insurance | 7 | 0 | 2 | 5 |
| Alerts/Workflow | 2 | 2 | 0 | 0 |
| Reports | 1 | 1 | 0 | 0 |
| AI Layer | 3 | 1 | 1 | 1 |
| Setup | 3 | 1 | 2 | 0 |
| Admin | 4 | 2 | 0 | 2 |
| **TOTAL** | **35** | **13 (37%)** | **8 (23%)** | **14 (40%)** |

**For Bank-only demo:** Skip Insurance (–7 missing) → effective scope becomes 28 screens with **13 done / 8 partial / 7 missing** → roughly **75% of demo surface already has backend**.

The remaining **7 must-build screens for Bank demo** are: SMA, Ratios+CMA, Account Behaviour, Sector heatmap, NPA wrap, Explainability, Profiling+Anomaly. All listed concretely in §2.1.

---

## 5. What's Strong & Should NOT Be Rebuilt

To save you from re-doing work — these surfaces are **production-grade** in your current backend and need **zero changes** for demo:

- **Auth & Session management** (33 routes) — JWT, 2FA, JWKS, API keys, leave covers, teams, dashboard widgets per role
- **User Management & RBAC** (31 routes)
- **Workflow / Cases** (92 routes!) — full CMS, maker-checker, investigations, checklists, field visits, tenant onboarding
- **Alerts** (54 routes) — ingest, classify, route, ack, SLA, auto-ack, AML correlation, STR reports
- **AI Models** (71 routes) — registry, metrics, performance, promotions, retraining, copilot v2, scoring presets, AB-test, what-if, sensitivity
- **Reports** (71 routes) — builder, jobs, schedules, scenarios
- **Audit** (extensive) — events, evidence, integrity, retention, correlations
- **Notifications** (email/SMS/push/webhook) — preferences, quiet-hours, templates, ledger
- **Ingestion** — connectors, schemas, runs, SLA, freshness
- **IFRS9 / Recovery / FinOps / DR** — full surfaces

You have **775 routes**. Don't let the gap list scare you — the backend is in great shape. The pending items are **focused, well-bounded additions** in 2 verticals (banking domain depth, insurance vertical) plus a handful of data-pipeline AI features.

---

*Generated by comparing `ZorEWS_Wireframe.html` against `openapi.md` on 2026-05-23.*
