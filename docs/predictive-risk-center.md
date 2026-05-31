# Predictive Risk Center — Architecture

**Status:** Shipped 2026-05-31 · 11th IA addition this session.

The Predictive Risk Center transforms ZorEWS from a *monitoring* platform
into a *predictive intelligence* platform. It is mounted at
`/predictive-risk-center` as an **additive overlay** — every existing
dashboard, route, API, RBAC scope, and database object is untouched and
fully backward-compatible. Existing modules continue to operate exactly as
before; this center adds a forward-looking lens.

---

## 1. Predictive Risk Center Architecture

```
                         /predictive-risk-center
                                  │
                                  ▼
              ┌────────────────────────────────────────┐
              │  PredictiveRiskCenterPage (SPA only)   │
              │  Role gate via canAccessPredictiveRisk │
              └───────┬───────────────────────┬────────┘
                      │                       │
                      ▼                       ▼
           ┌──────────────────┐    ┌──────────────────┐
           │ predictiveRiskEng│    │ predictiveSignals│
           │ • predictRisk    │    │ • SIGNAL_LIBRARY │
           │ • buildTimeline  │    │ • listActive…    │
           │ • predictBank…   │    └──────────────────┘
           │ • predictInsure… │
           │ • buildExecForec │
           └────────┬─────────┘
                    │ ──→ predictiveExplanations  (SHAP / drivers / narrative)
                    │ ──→ predictiveRecommendations (6 action types)
                    │
                    ▼
              (production swap)
       ┌──────────────────────────────────┐
       │  BFF: GET /predictive-forecasts  │
       │       GET /predictive-signals    │
       │       GET /predictive-scores     │
       │       POST /predictive-recom…    │
       │                                  │
       │  Pg: predictive_models,          │
       │      predictive_forecasts,       │
       │      predictive_scores,          │
       │      predictive_signals,         │
       │      predictive_recommendations  │
       └──────────────────────────────────┘
```

**Design contract.** The SPA renders via pure resolvers backed by
deterministic synthesis today (FNV-1a + Mulberry32 keyed on
`(tenant, prediction, day)` — same scheme as `aiInsights.ts`,
`bil_dashboards.ts`, and `executiveCockpitEngine.ts`). Production swap is
mechanical: replace resolver bodies with BFF/HTTP calls satisfying the
exact same TypeScript surface — no SPA changes required.

---

## 2. Banking Prediction Framework

**7 predictions × 4 horizons.**

| Prediction Kind             | Label                       | Drives action  |
|-----------------------------|-----------------------------|----------------|
| `npa_probability`           | NPA Probability             | contact / investigate |
| `sma_migration_risk`        | SMA Migration Risk          | contact / monitor |
| `emi_default_risk`          | EMI Default Risk            | contact / escalate |
| `collection_failure_risk`   | Collection Failure Risk     | escalate / investigate |
| `borrower_stress_index`     | Borrower Stress Index       | monitor / contact |
| `sector_deterioration_risk` | Sector Deterioration Risk   | escalate / freeze exposure |
| `portfolio_risk_forecast`   | Portfolio Risk Forecast     | escalate / freeze exposure |

**Forecast envelope** per prediction:

```
{ current_score, current_band,
  forecast_score, forecast_band,
  delta_pp, confidence, trend ∈ {rising, falling, flat},
  points: [{ day_offset, score, band, confidence, lower, upper }] }
```

Confidence widens linearly from 0.92 → 0.60 as horizon grows. Reference
lines at the `high` (40) + `severe` (65) thresholds on the chart.

---

## 3. Insurance Prediction Framework

**7 predictions × 4 horizons** — identical envelope to banking but with
insurance-flavoured features + recommendations.

| Prediction Kind                | Label                        | Drives action |
|--------------------------------|------------------------------|---------------|
| `policy_lapse_probability`     | Policy Lapse Probability     | retention campaign |
| `claim_fraud_probability`      | Claim Fraud Probability      | launch investigation |
| `persistency_decline_risk`     | Persistency Decline Risk     | retention / escalate |
| `solvency_pressure_risk`       | Solvency Pressure Risk       | freeze / escalate |
| `premium_collection_risk`      | Premium Collection Risk      | retention / contact |
| `agent_risk_escalation`        | Agent Risk Escalation        | investigate / escalate |
| `customer_churn_probability`   | Customer Churn Probability   | retention / contact |

---

## 4. Risk Scoring Architecture

**5-level closed enum** in canonical order:

```
RISK_LEVELS = ['low', 'moderate', 'high', 'severe', 'critical']
```

**Default thresholds** (upper-exclusive lower bound; ≥ critical = critical):

```ts
DEFAULT_THRESHOLDS = { moderate: 20, high: 40, severe: 65, critical: 85 };
```

**Scope-aware overrides** via `resolveThresholds(scope, overrides)`. Order:

```
tenant > domain > country > default
```

Operators can set tighter bands per tenant (e.g. BIL might run tighter
fraud thresholds in insurance) without touching the engine code. Production
backing: `predictive_models.thresholds_json` JSONB column.

`bandForScore(score, thresholds)` is the single classifier function used
by every resolver to produce a `RiskLevel`. Boundary semantics: `score ≥
threshold.band` → that band (not the previous one).

---

## 5. Signal Library Architecture

**`SIGNAL_LIBRARY`** is a platform-static catalog of **14 early-warning
signal definitions** spanning banking + insurance. Each carries:

- `signal_id` — stable closed enum
- `default_severity` (5-level closed enum)
- `feeds_predictions[]` — back-references into the prediction kinds it
  feeds. Drives the SPA's "click a signal → see which predictions move".
- `description` + `label` (i18n-friendly)

**`listActiveSignals(tenant, asOf)`** returns `2-5 observations per
domain per day`, deterministically synthesised. Each observation carries:

```
{ observation_id, signal_id, severity, entity_id, observed_at,
  feeds_predictions, band, description }
```

**Signal-types ↔ Entity-kind mapping** (banking):

| Signal prefix | Entity kind |
|---------------|-------------|
| `branch_*`    | BRANCH-NNNN |
| `sector_*`    | SECTOR-N    |
| (other)       | BORROWER-NNNN |

Insurance:

| Signal prefix | Entity kind |
|---------------|-------------|
| `agent_*`     | AGENT-NNNN  |
| `channel_*`   | CHANNEL-N   |
| `solvency_*`  | PORTFOLIO-LIFE |
| (other)       | POLICY-NNNN |

---

## 6. Database Schema (`054_predictive_risk.sql`)

All tables under `app_iam.*` schema. **Additive only — `CREATE TABLE IF
NOT EXISTS`**. Idempotent: safe to re-run via `make migrate`.

### `predictive_models`

| Column | Notes |
|--------|-------|
| `model_id` (PK) | e.g. `predictive-npa_probability` |
| `tenant_id`     | FK to `app_iam.tenants` |
| `domain`        | CHECK ∈ {banking, insurance} |
| `prediction_kind` | CHECK ∈ 14-value closed enum |
| `horizons_days` | INTEGER[] default `[30, 60, 90, 180]` |
| `thresholds_json` | JSONB; per-model band override |
| `status`        | CHECK ∈ {experimental, staging, shadow, production, retired} |

Seed: 14 models × 2 tenants (BANK_DEMO + BIL) via `INSERT … ON CONFLICT
DO NOTHING`.

### `predictive_forecasts`

Time-series of forecast outputs per `(model, entity, horizon, generated_at)`.
Includes `series_json` JSONB column holding the per-point trajectory.
Indexed on `(tenant, prediction_kind, horizon, generated_at DESC)` for
the "latest forecast per kind" lookup, plus a partial index on
`forecast_band ∈ {severe, critical}` for triage queries.

### `predictive_scores`

Latest-snapshot table — `UNIQUE (tenant, entity, prediction_kind, horizon)`
so the SPA can list "current risk score per customer × prediction" in O(1).

### `predictive_signals`

Active early-warning observations. Three partial indexes covering the hot
read paths: active-only `WHERE resolved_at IS NULL`, severity filter,
per-signal-id history.

### `predictive_recommendations`

Issued prescriptive actions — the **audit trail** for the prescriptive
side of the workflow. `requires_maker_checker` boolean carries the M9.3
4-eyes pattern; row-level CHECK enforces `approver_username ≠ issued_by`
when maker-checker is required.

---

## 7. APIs (BFF follow-up)

| Method | Path                                | Auth scope                    | Notes |
|--------|-------------------------------------|-------------------------------|-------|
| GET    | `/predictive-risk-center`           | analyst+ / exec               | Manifest of available kinds + horizons + thresholds |
| GET    | `/predictive-forecasts`             | `customers:read_risk_profile` | Filter by `kind`, `horizon`, `entity_id` |
| GET    | `/predictive-signals`               | `customers:read_risk_profile` | Filter by `domain`, `severity`, `signal_id` |
| GET    | `/predictive-scores`                | `customers:read_risk_profile` | Latest snapshot per entity |
| POST   | `/predictive-recommendations`       | `cases:log_action`            | Issue an action; maker-checker enforced at row level |

Envelope follows the platform standard:

```jsonc
{ "header": { "request_id": "…", "status": 200, "tenant_id": "BANK_DEMO" },
  "body":   { /* resource */ } }
```

Validation: all kinds + bands + horizons + actions are closed enums and
rejected as `400 EWS_400_invalid_input` on mismatch.

---

## 8. React Component Hierarchy

```
PredictiveRiskCenterPage                    (role gate via canAccessPredictiveRiskCenter)
├── PageHeader
├── Panel "Forecast horizon"                (4 horizon chips: 30/60/90/180)
├── Panel "Predictive overview"             (5 MetricCard KPIs)
├── Panel "Domain forecasts"
│   ├── Tab strip: banking / insurance
│   └── ForecastGrid
│       └── ForecastCard × 7                (click → selectedKind)
│           └── ForecastChart (recharts Area + confidence band + threshold refs)
├── grid (2:1)
│   ├── Panel "Risk evolution"              (timeline: historical + current + predicted)
│   │   └── AreaChart (multi-series + ReferenceLine "Now")
│   └── Panel "AI explanation"
│       ├── Prediction score card
│       ├── Top 5 SHAP drivers
│       └── Risk factors (narrative)
├── Panel "Signal explorer"                 (filter: all/banking/insurance)
│   └── signal rows × ≤12
├── Panel "Prescriptive actions"            (per selected prediction)
│   └── action cards × N
├── Panel "Executive forecasts"             (scope: enterprise/country/tenant/portfolio)
│   └── table (entity × forecast × band × delta × trend × confidence)
└── Cross-IA footer                         (links to Executive Cockpit, Role Dashboard, Analytics, Governance, Audit, Recovery)
```

All sections render under one `<PredictiveRiskCenterPage>` component;
state is local (React `useState`); data is memoised on `(asOf, tenant,
horizon, selectedKind, scope)`. No global store; no react-query
round-trips today (production wire-up adds them).

---

## 9. AI Explanation Framework

**`buildExplanation(forecast, asOf)`** returns:

```ts
{
  prediction_score, confidence, label, model_id, model_version,
  top_drivers: KeyDriver[],   // 5 SHAP-style entries, sorted by |shap_value| desc
  risk_factors: string[],     // 3-5 narrative bullets per prediction kind
  recommended_action_ids: RecommendationActionId[],
}
```

**Feature pools per domain:**

- Banking: `dpd_max_90d`, `utilization`, `bureau_score`, `income_drop_30d_pct`,
  `repayment_delay_streak`, `txn_volume_zscore_90d`, `product_concentration`
- Insurance: `premium_due_days`, `claim_freq_180d`, `agent_persistency_pct`,
  `portal_login_drop`, `solvency_ratio`, `channel_persistency_delta`,
  `policy_age_days`, `rapid_claim_flag`

Each driver carries `direction` (`up` = pushes score up = worse) + a
human-readable `human_value` (e.g. "DPD = 42 days") for the SPA chip.

**Narrative templates** per prediction kind drive the "Risk factors"
bullet list. 3-5 randomly-picked phrases from a 4-item pool per kind.

Production swap: read SHAP values directly from
`/v1/ai/models/:id/score` response (matches M7.1 model registry shape).

---

## 10. Prescriptive Action Framework

**6 action types** (closed enum):

| `action_id`                   | Required role           | Maker-checker |
|-------------------------------|-------------------------|---------------|
| `contact_borrower`            | collection_officer      | no  |
| `increase_monitoring`         | risk_analyst            | no  |
| `launch_investigation`        | fraud_analyst           | no  |
| `escalate_review`             | supervisor              | **yes** |
| `freeze_exposure`             | supervisor              | **yes** |
| `trigger_retention_campaign`  | risk_analyst            | no  |

Each `RecommendationDef` carries `severity_floor` (minimum band that
should trigger the action) + `domains[]` (banking-only, insurance-only,
or both).

**Maker-checker discipline.** `freeze_exposure` and `escalate_review`
require a different approver from the issuer. Row-level CHECK
constraint on `predictive_recommendations`:

```sql
CONSTRAINT predictive_recs_maker_checker_chk CHECK (
    NOT requires_maker_checker
    OR approver_username IS NULL
    OR approver_username <> issued_by
)
```

This mirrors the M9.3 case-management 4-eyes pattern — same enforcement
shape so analysts experience consistent governance across surfaces.

---

## 11. Executive Forecast Architecture

**4 scope axes** in `buildExecutiveForecast(scope, horizon, asOf)`:

- `enterprise` → 1 row (whole platform)
- `country`    → 4 rows (IN / BT / NP / AE)
- `tenant`     → 4 rows (BANK_DEMO / BIL / SBI_TEST / HDFC_TEST)
- `portfolio`  → 6 rows (retail/sme/corp/auto loans + life/general insurance)

Each row carries `{ forecast_score, forecast_band, delta_pp, trend,
confidence, top_kind }`. The `top_kind` field is the most-pressing
underlying prediction kind that drove this scope's forecast — gives the
exec a one-click drill-through into the per-prediction view.

Production swap: replace the pure deterministic synth with rollups over
`predictive_scores` filtered by entity_kind.

---

## 12. Testing Strategy

| Tier | Coverage                                                          | Status |
|------|-------------------------------------------------------------------|--------|
| Pure resolver tests | role gate (PREDICTIVE_ROLES, legacy), bandForScore boundaries, threshold override precedence, predictRisk shape + determinism + tenant divergence, predictBankingSuite + predictInsuranceSuite (7+7), buildRiskTimeline (historical+current+predicted), SIGNAL_LIBRARY catalog invariants, listActiveSignals + filters + sort + determinism, buildExplanation (SHAP sort, direction, narrative, action mapping), RECOMMENDATION_CATALOG (6 actions, assignees, maker-checker on escalate+freeze), buildExecutiveForecast (4 scopes, determinism) | ✅ |
| Page render tests   | admin sees 8 sections, risk_analyst + fraud_analyst granted (per brief), field_officer bounced, 4 horizon chips, both domain tabs, 7 banking cards + 7 insurance cards, click forecast updates explanation, 5 KPI tiles, signal filter chips, exec scope chips, horizon click switches, ENT exec row by default | ✅ |
| Sibling sweep       | ExecutiveCockpit (44) + RoleBasedDashboard (15) + AppShell + AppShellNavGroups + DashboardPage = 90/90 | ✅ |
| Build               | `tsc --noEmit` clean on all 5 new modules; `vite build` clean (4.66s) | ✅ |

**Total: 60 new tests** in `PredictiveRiskCenter.test.tsx`.

---

## 13. Migration Strategy

| File                                  | Status  | Notes |
|---------------------------------------|---------|-------|
| `data/schema/054_predictive_risk.sql` | NEW     | Idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, DO $$ for trigger). Re-runnable via `make migrate`. |
| Existing migrations 001-053           | UNCHANGED | Backward compatible. |

The migration seeds 14 default models per tenant (BANK_DEMO + BIL) so the
BFF can immediately answer "what models exist?" without manual seeding.

Roll-forward only — there is no destructive change to roll back. If the
center is ever discontinued, the additive tables can be dropped without
affecting any other module.

---

## 14. Backward Compatibility Plan

| Surface                              | Impact |
|--------------------------------------|--------|
| Existing dashboards (`/`, `/dashboards/role-based`) | UNCHANGED — no widgets removed / renamed / reordered. |
| Executive Cockpit (`/executive-cockpit`)            | UNCHANGED — Predictive Risk Center is sibling, not replacement. |
| Recovery Center / Audit Center / Governance / IAM / Security Activity / Rule Center / AI Governance | UNCHANGED |
| `/analytics`, `/reports/builder`, `/reports`        | UNCHANGED — links from Predictive footer back into these pages. |
| RBAC matrix (`infra/rbac/matrix.json`)              | UNCHANGED — page role gate is local (`canAccessPredictiveRiskCenter`), broad enough to admit every requested role from the brief. |
| Routes registered in App.tsx                        | 150 → 151 (added 1; zero removed) |
| Sidebar navigation                                  | +1 nav leaf in `action-center` group (after Executive Cockpit). Zero existing entries removed. |
| Database tables                                     | +5 new tables in `app_iam`. Zero existing tables altered or dropped. |
| BFF routes                                          | UNCHANGED today (engine renders client-side). Future BFF routes documented in §7 are additive. |
| OpenAPI                                             | UNCHANGED until BFF routes ship; spec scaffold deferred (matches Executive Cockpit pattern). |

**Smoke verification post-deploy:**
1. `/` Dashboard renders identically to pre-deploy (compare snapshot).
2. `/executive-cockpit` renders identically.
3. `/dashboards/role-based` renders identically.
4. All existing widgets in the widget registry still resolve.
5. `make migrate` exits 0 (no DDL failures).

---

## 15. Implementation Roadmap

### Shipped 2026-05-31

- ✅ Engine + signals + recommendations + explanations (pure resolvers + closed enums)
- ✅ SPA landing page (8 sections, role-gated, recharts visualisations)
- ✅ Sidebar nav entry + i18n × 4 locales
- ✅ Route registration in App.tsx
- ✅ Migration 054 (5 additive tables + 14-model seed × 2 tenants)
- ✅ 60 vitest tests + 90/90 sibling sweep + tsc + vite build clean

### Next (BFF wire-up, separate commits)

1. Implement the 5 BFF routes from §7 against the existing `app_iam.*`
   schema. Reuse the envelope helper + `requireTenant`/`requireRole`
   middleware stack.
2. Add OpenAPI spec at `docs/openapi/predictive-risk-center.yaml` once
   route bodies are validated against the schema.
3. Replace the deterministic synthesis resolvers with HTTP calls from
   the SPA — surface contract is unchanged so no SPA refactor required.
4. Wire `POST /predictive-recommendations` into the M15.1 audit chain
   (action issuance becomes an audit event with `event_type:
   'predictive.recommendation.issued'`).
5. Add a `predictive_recommendations` ↔ `app_audit.approvals` fan-out
   for maker-checker actions (reuse the M9.3 pattern).

### Future

- Real model training. Today's `model_id` strings (e.g.
  `predictive-npa_probability`) are stable so they can become real
  registry entries via `ai_model_registry.ts` (M7.1) without changing
  the SPA.
- Replace deterministic SHAP synth with explainer.shap_values() output
  from the trained model (matches M7.1 `top_features[]` shape — already
  identical).
- Cross-tenant fleet-aggregate dashboards (extend `buildExecutiveForecast`
  with a real tenant lookup).

---

**IA additions this session — 11 total (overlay-not-replacement; additive only; backward-compat preserved every time):**

Rule Center · Audit + Recovery · AI Governance · IAM · Governance · Security
Activity · Recovery Management · Navigation Simplification · Role-Based
Dashboard Engine · Executive Risk Cockpit · **Predictive Risk Center**
