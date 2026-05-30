# Enterprise AI Governance Layer — architecture

**Status:** shipped 2026-05-30
**Owner:** agent-ai + agent-ui
**Companion docs:** [Rule Center](./rule-center-architecture.md) · [Audit + Recovery Centers](./audit-and-recovery-centers.md)

## Problem

The SPA exposed 7 sidebar entries for AI work:

| Sidebar entry        | URL                       | Page                        | Role                                |
| -------------------- | ------------------------- | --------------------------- | ----------------------------------- |
| AI Workbench         | `/ai/workbench`           | `AiWorkbenchPage`           | admin · supervisor · risk_analyst  |
| Model Registry       | `/ai/registry`            | `ModelRegistryPage`         | admin · supervisor · risk_analyst  |
| Explainability       | `/ai/explainability`      | `ExplainabilityPage`        | + collection_officer · field_officer |
| Experiment Tracking  | `/ai/experiments`         | `ExperimentTrackingPage`    | admin · supervisor · risk_analyst  |
| Drift Detection      | `/ai/drift`               | `DriftMonitoringPage`       | admin · supervisor · risk_analyst  |
| AI Insights          | `/ai/insights`            | `AiInsightsPage`            | + collection_officer · field_officer |
| Feature Store        | `/admin/feature-store`    | `FeatureStorePage`          | admin · supervisor · risk_analyst  |

What was missing — and what RBI MRM / IRDAI Model Risk Management expect —
was an explicit governance layer: model monitoring dashboards, prediction
audit logs, performance tracking, drift fleet views, and regulator-facing
report packs.

## Solution

Same pattern as Rule Center + Audit/Recovery Centers: one new sidebar
entry "AI Governance Center" with 6 named sub-sections. Zero new BFF
routes, zero new DB tables, zero broken bookmark. Explainability is
**relocated under AI Workbench** per the brief ("Move Explainability
under AI Workbench") — the legacy `/ai/explainability` URL keeps
resolving so bookmarks still work.

### Sub-sections at `/ai/governance/*`

| Sub-section                    | URL                                      | Renders                          | New?                |
| ------------------------------ | ---------------------------------------- | -------------------------------- | ------------------- |
| Model Monitoring Dashboard     | `/ai/governance/monitoring`              | `AiModelMonitoringPage`          | NEW                 |
| Prediction Audit Logs          | `/ai/governance/prediction-audit`        | `AiPredictionAuditPage`          | NEW                 |
| Performance Tracking           | `/ai/governance/performance`             | `AiPerformanceTrackingPage`      | NEW                 |
| Drift Monitoring Dashboard     | `/ai/governance/drift`                   | `AiDriftDashboardPage`           | NEW (fleet view)    |
| Explainability Viewer          | `/ai/workbench/explainability`           | `ExplainabilityPage` (existing)  | RELOCATED           |
| AI Governance Reports          | `/ai/governance/reports`                 | `AiGovernanceReportsPage`        | NEW (curated index) |

### Quick-links

The governance landing also surfaces the 5 non-governance AI tools as
quick-link chips (Workbench / Registry / Experiments / Insights / Feature
Store). Governance is layered ON TOP of them — not a replacement.

## UI architecture

- **1 new landing page** `AiGovernanceCenterPage` (~210 LOC) driven by
  an exported `AI_GOVERNANCE_CARDS` array (single source of truth).
  Adding a 7th sub-section is one element + one wrapper route.
- **5 new destination pages**:
  - `AiModelMonitoringPage` — fleet rollup table combining
    `api.aiModels()` + `api.aiDriftFleet()`. Derives a 5-bucket health
    badge (healthy / watch / drift_alert / stale / retired) client-side
    from existing data. Click → per-model `/ai/drift?model_id=…`.
  - `AiPredictionAuditPage` — filter-driven prediction history over
    `api.aiPredictions()` (NEW wrapper around existing
    `/v1/ai/predictions`). Click row → `/ai/workbench/explainability?prediction_id=…`.
  - `AiPerformanceTrackingPage` — per-model + per-metric line chart
    composing M7.5 ledger + M7.7 outliers + M7.8 trend. Slope-based
    verdict (improving / declining / flat) + outlier annotations on the
    chart.
  - `AiDriftDashboardPage` — fleet drift rollup over `api.aiDriftFleet()`.
    Distribution chart + worst-offenders + full table. Distinct from the
    existing `/ai/drift` per-model deep-dive.
  - `AiGovernanceReportsPage` — curated catalog of 6 regulator packs
    (RBI MRM Model Inventory, RBI MRM Validation Attestation, IRDAI
    Explainability Sign-off, SOC 2 CC8.1 ML Change Control, Internal
    MRM Quarterly Risk Review, Drift+Retraining Attestation). Same
    shape as Audit Center's Compliance Reports.
- **Role gates:** all 6 sub-pages match the AI Workbench gate
  (`admin | supervisor | risk_analyst`). Explainability keeps its
  wider gate (also `collection_officer | field_officer`) at the
  legacy URL.

## Database changes

**None.** The governance layer is purely a presentation + composition
layer over existing tables:

- `app_iam.ai_models` (M7.1 registry)
- M7.5 performance ledger (in-memory; pg-backed swap was planned for T5.1.1)
- M7.6 drift fleet state (in-memory)
- `app_ai.predictions` (Phase 9 prediction audit table)
- M7.2 promotion ledger
- M9.3 maker-checker decisions
- M15.1 audit chain

If a future pack genuinely needs new aggregation, add a pure resolver
under `services/bff/src/ai_*` following the M7.x naming pattern. **Don't
add columns to satisfy a pack** — the existing surface covers every
MRM / IRDAI / SOC 2 question we model today.

## API design

**Zero new BFF routes.** The 5 destination pages compose existing surface:

| Page                          | BFF endpoints consumed                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| Model Monitoring              | `GET /v1/ai/models` + `GET /v1/ai/drift`                                                     |
| Prediction Audit              | `GET /v1/ai/predictions?customer_id=&model_id=&prediction_type=&since=&until=&page=&page_size=` |
| Performance Tracking          | `GET /v1/ai/models` + `GET /v1/ai/models/:id/performance?metric=` + `…/trend?metric=` + `…/outliers?metric=&z=` |
| Drift Dashboard               | `GET /v1/ai/drift` + `GET /v1/ai/drift/:id/history`                                          |
| Governance Reports            | Curated index — no fetch. Links deep into the above + `/audit-center/export`.                |

**One NEW SPA-side wrapper:** `api.aiPredictions(params)` in
`web/src/lib/api.ts` — a filter-aware paginated list over the existing
`GET /v1/ai/predictions` endpoint that wasn't yet exposed in the typed
API client. No BFF change required.

## Dashboard widgets

Each sub-page exposes its own widget composition (Tailwind grid + recharts):

| Page                  | Widgets                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| Monitoring            | 5 KPI tiles (healthy / watch / drift_alert / stale / retired) + sorted health table with drill-into chip  |
| Prediction Audit      | 6-axis filter grid + paginated table + per-row Explain link                                               |
| Performance Tracking  | 5 KPI tiles (samples / mean / first / last / slope) + verdict badge + line chart with outlier dots        |
| Drift Dashboard       | 4 KPI tiles (red / amber / green / unevaluated) + verdict bar chart + worst-5 list + full fleet table     |
| Governance Reports    | 6 regulator pack cards with primary + secondary deep-links                                                |

The widgets are pure-Tailwind compositions — no new dashboard-builder
widget types. The existing `WIDGET_CATALOG` (M11.7 custom dashboards)
remains the source of truth for the SPA's pluggable widget system; new
governance widgets ship as page-internal compositions, not catalog entries.

## RBAC permissions

| Surface                                       | Required role(s)                                              | Reasoning                                                          |
| --------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `/ai/governance` landing                      | admin · supervisor · risk_analyst                             | Matches AI Workbench / Model Registry — MRM-tier views             |
| `/ai/governance/monitoring`                   | admin · supervisor · risk_analyst                             | Reads M7.1 + drift fleet — same scope as the existing pages        |
| `/ai/governance/prediction-audit`             | admin · supervisor · risk_analyst                             | Reads `/v1/ai/predictions` (`customers:read_risk_profile` BFF scope) |
| `/ai/governance/performance`                  | admin · supervisor · risk_analyst                             | Reads M7.5 ledger — sensitive but not destructive                  |
| `/ai/governance/drift`                        | admin · supervisor · risk_analyst                             | Reads M7.6 fleet                                                   |
| `/ai/governance/reports`                      | admin · supervisor · risk_analyst                             | Curated index — no data of its own                                 |
| `/ai/workbench/explainability` (relocated)    | admin · supervisor · risk_analyst · collection_officer · field_officer | Keeps the legacy gate so investigators + field officers can still drill into a prediction |

The BFF endpoints keep their existing `requireRole` gates — the SPA gate is
the first line of defense; the BFF is the authoritative second. **No new
RBAC operations were added.** The brief's "RBAC permissions" requirement is
satisfied by reusing the existing 7-action enterprise matrix (T6) —
governance reads compose into `customers:read_risk_profile` + `audit:read`
which the existing roles already carry.

## What we explicitly did NOT do

- Rename or move any existing AI module file.
- Change any existing AI API contract.
- Add a column to any AI table.
- Remove any legacy URL — every `/ai/workbench`, `/ai/registry`,
  `/ai/explainability`, `/ai/experiments`, `/ai/drift`, `/ai/insights`,
  `/admin/feature-store` URL still resolves to the same page.
- Add a new BFF route. The 5 new pages compose existing surface
  (M7.1 / M7.5 / M7.6 / M7.7 / M7.8 / `/v1/ai/predictions`).
- Add a new dashboard widget catalog entry. Governance widgets ship as
  page-internal compositions.

## Test surface

- `web/src/__tests__/AiGovernanceCenter.test.tsx` — 22 cases covering:
  - Landing role gate (admin / supervisor / risk_analyst pass; field_officer bounce)
  - 6-card grid + canonical-order invariant
  - Explainability card relocation (points at `/ai/workbench/explainability`, legacy `/ai/explainability` echoed)
  - Quick-links cover 5 non-governance AI surfaces
  - Reports page: 6 packs render + closed-enum regulator + primary-link URL invariant
  - Monitoring `deriveHealth` pure helper: all 5 bucket pathways
  - Performance `slopeVerdict` pure helper: improving / declining / flat / null
  - `METRICS` closed-enum coverage
- Existing AI test files unchanged. Sibling-regression sweep across the 6
  AI test files = **52/52 pass** (no regressions).

## Follow-ups (future, not blocking)

- Pg-backed swap for the M7.5 performance ledger (already on the T5.1.1 follow-up
  list) — Performance Tracking page is unchanged at swap time.
- 7th compliance pack for BIL-specific IRDAI Form-K AI explainability when a
  real BIL insurer onboards — entry in `AI_GOVERNANCE_PACKS` array.
- Per-prediction trust-signal column on the Audit Logs page once the trust
  endpoint stabilises (the API call already exists; just a column on the
  table).
- Per-model `last_evaluated_at` timestamp on the Drift fleet shape (BFF-side)
  so the Dashboard's "Last evaluated" column populates without a separate
  history fetch.
