# ZorEWS Executive Risk Cockpit — Architecture

**Date:** 2026-05-31
**Status:** SHIPPED — additive overlay at `/executive-cockpit`. Existing dashboards untouched. **10th IA addition this session.**
**Method:** Pure-function resolvers (cockpit engine + briefing generator) + reuse of the widget registry from Role-Based Dashboard Engine + 3 additive tables + 1 new SPA route.

## TL;DR

A dedicated executive cockpit for CEO / CRO / COO / CFO / Board / Country Heads layered on top of the existing platform — composed from 8 sections (Enterprise Risk Overview / Risk Heatmap / Top Exposures / Predictive Intelligence / AI Executive Briefing / Board Reporting / Strategic KPIs / Executive Actions). Reuses the widget registry from the Role-Based Dashboard Engine (commit `4fa21f9`). Zero existing routes touched, zero APIs removed, zero dashboards changed, additive-only schema migration.

| Metric | Value |
|---|---|
| Sections | **8** (per brief) |
| Widget reuse | **7 KPIs** from Role-Based Dashboard widget registry |
| New pure resolvers | **2** (`executiveCockpitEngine.ts`, `executiveBriefing.ts`) |
| Net-new database tables | **3** (executive_reports, executive_briefings, executive_kpi_snapshots) |
| Net-new SPA route | **1** (`/executive-cockpit`) |
| Executive personas gated | **7** (super_admin · cro · ceo · cfo · coo · board_member · country_head) + legacy `executive` + `admin` |
| Tests | **44 new + 46/46 sibling sweep pass** |
| Build | Clean (4.67s, ~755 kB gzip) |

---

## 1. Executive Cockpit Architecture

```
   ┌──────────────────────────────────────────────────────────────────────┐
   │   Executive Risk Cockpit   /executive-cockpit                       │
   │   ─────────────────────────────────────────────────────────────     │
   │   ExecutiveCockpitPage.tsx                                          │
   │     ▸ Role gate: canAccessExecutiveCockpit(user.roles)              │
   │     ▸ 8 sections rendered top-to-bottom                             │
   │     ▸ Each section consumes a pure resolver                         │
   └────────────────────────┬─────────────────────────────────────────────┘
                            │ pure
            ┌───────────────┴────────────────────┐
            ▼                                    ▼
   ┌─────────────────────────┐         ┌──────────────────────────────┐
   │ executiveCockpitEngine  │         │     executiveBriefing.ts      │
   │ ─────────────────────── │         │  ──────────────────────────   │
   │ canAccessExecutiveCockpit         │ generateExecutiveBriefing(   │
   │ getEnterpriseRiskOverview         │   tenant, cadence, asOf)     │
   │ getRiskHeatmap                    │ generateAllBriefings(tenant) │
   │ getTopExposures                   │ REPORT_TEMPLATES (7 rows)    │
   │ getPredictiveForecasts            │                              │
   │ getStrategicKpis                  │ FNV-1a + Mulberry32 seeded   │
   │ EXECUTIVE_ACTIONS / actionsForRole│ per (tenant, cadence, day)   │
   └────────┬────────────────┘         └──────────────────────────────┘
            │
            ▼
   ┌────────────────────────────┐
   │ widgetRegistry.ts          │   ◀── REUSED from Role-Based Engine
   │ (52 widgets — KPI subset)  │       (commit 4fa21f9)
   └────────────────────────────┘
            ▲
            │
   ┌────────────────────────────┐
   │ Migration 052 (3 tables)   │   ◀── persistence for cached briefings,
   │ — additive, idempotent      │       generated reports, KPI snapshots
   └────────────────────────────┘
```

**Design choices:**
- Existing **Role-Based Dashboard Engine** widget registry is the contract — Section 1 KPIs are just 7 `widget_id` references resolved through `getWidget()`. Zero widget duplication.
- The cockpit is **read-only** by intent — Section 8 actions queue UI feedback today; the BFF audit-write fan-out is the follow-up (`docs/executive-risk-cockpit.md §6`).
- Briefings + reports + KPI snapshots **cache** the pure-resolver output so executives can compare today vs last-month without re-deriving from raw mart.
- Heatmaps + forecasts use the same **FNV-1a + Mulberry32** deterministic synthesis scheme as `aiInsights.ts` / `bil_dashboards.ts` — production swap replaces the resolver body with a BFF query.

---

## 2. React Component Hierarchy

```
web/src/modules/executive/                  [NET-NEW dir]
├── executiveCockpitEngine.ts               [pure resolvers — sections 1-4, 7, 8]
├── executiveBriefing.ts                    [pure briefing + report templates — sections 5, 6]
└── ExecutiveCockpitPage.tsx                [SPA landing — 8 sections, role-gated]

web/src/__tests__/
└── ExecutiveCockpit.test.tsx               [44 tests — role gate + 7 resolver suites + page]

data/schema/
└── 052_executive_cockpit.sql               [3 idempotent tables + indexes]

docs/
└── executive-risk-cockpit.md               [this document — 10 deliverables]
```

Reused (untouched) modules:
- `@/components/ui` — Panel, MetricCard, Badge, Button
- `@/components/layout/PageHeader` — page chrome
- `@/store/auth` — `useAuth(s => s.user)` for role gate
- `@/modules/dashboard/roleEngine/widgetRegistry` — `getWidget(id)` lookup

---

## 3. Widget Architecture (Section 1)

Section 1 (Enterprise Risk Overview) is **7 KPI tiles** mapped to existing widget registry entries:

| `widget_id` (registry key) | Display | Drill target |
|---|---|---|
| `rs_enterprise_risk_score` | Enterprise Risk Score (0..100) | — |
| `rs_portfolio_health` | Portfolio Health (0..100) | `/analytics` |
| `kpi_total_alerts` | Total Open Alerts | `/alerts` |
| `kpi_open_cases` | Critical Cases | `/cms/cases` |
| `kpi_fraud_exposure_kes` | Fraud Exposure (KES) | — |
| `kpi_compliance_score` | Compliance Score | `/audit-center` |
| `kpi_recovery_rate` | Recovery Effectiveness | `/recovery-center/analytics` |

Each tile rendered via existing `<MetricCard>` primitive wrapped in `<Link>` to its `drill_to`. Values are deterministic synthetic (e.g. `Math.round(45 + rng() * 25)` for risk score) until the BFF KPI route lands.

---

## 4. KPI Architecture (Section 7 — Strategic)

6 strategic KPIs distinct from the executive overview. Each carries `{value, delta_pct, trend, band}` with `band ∈ green | amber | red`:

| Strategic KPI | Value example | Healthy direction | Band rule |
|---|---|---|---|
| Risk Adjusted Return (RaR) | 16.4% | ≥ 15% | falling > 4pp → red |
| Capital At Risk (CaR) | 11.2% | ≤ 15% (RBI internal cap) | rising > 4pp → red |
| Portfolio Stability Index | 84/100 | rising | falling > 4pp → red |
| Recovery Efficiency | 89.2% | rising | falling > 4pp → red |
| Compliance Health | 96/100 | rising | falling > 4pp → red |
| Fraud Loss Avoidance | ₹18.4 Cr | rising | falling > 4pp → red |

Bucketing follows the M8.16 / M7.15 / `recoveryRiskScoring.ts` convention. Computed by pure function `getStrategicKpis(tenant_id, asOf)` — same FNV-1a + Mulberry32 deterministic seeding.

---

## 5. Database Schema

Migration **`data/schema/052_executive_cockpit.sql`** — 3 additive tables under `app_iam` namespace. All `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` (idempotent — re-runs are safe).

### `app_iam.executive_reports`
Generated PDF / Excel / CSV report artefacts (Section 6 outputs).

| Column | Type | Notes |
|---|---|---|
| report_id | UUID PK | gen_random_uuid() |
| tenant_id, template_id, format, status | TEXT | CHECK enums |
| period_start, period_end, generated_at | TIMESTAMPTZ | `period_start ≤ period_end` enforced |
| generated_by, storage_key, error_message | TEXT | |
| parameters | JSONB | caller-supplied params |
| correlation_id | UUID | M15 chain back-reference |

**CHECKs:** template_id ∈ 7-template closed enum · format ∈ {pdf, xlsx, csv} · status ∈ {pending, generating, ready, failed} · failed status implies error_message set.

### `app_iam.executive_briefings`
Cached AI briefing output per (tenant, cadence, period_start).

| Column | Type | Notes |
|---|---|---|
| briefing_id | UUID PK | |
| tenant_id, cadence, period_start, period_end | … | UNIQUE (tenant, cadence, period_start) |
| headline | TEXT | CHECK length 5..500 |
| highlights | JSONB | array of {metric, direction, detail, drill_to} |
| recommended_action | TEXT | CHECK length ≤ 1000 |
| source | TEXT | CHECK ∈ {heuristic, claude, bedrock, manual} |

### `app_iam.executive_kpi_snapshots`
Point-in-time strategic KPI snapshots.

| Column | Type | Notes |
|---|---|---|
| snapshot_id | UUID PK | |
| tenant_id, captured_at, kpi_id | … | indexed `(tenant, kpi, time DESC)` |
| value_text, value_numeric | TEXT, NUMERIC | text preserves "₹14.2 Cr"; numeric for trends |
| band, delta_pct, trend | TEXT, NUMERIC, TEXT | CHECK band ∈ {green, amber, red}; CHECK trend ∈ {rising, falling, flat} |
| metadata | JSONB | model id / weight set / forecast horizon |

**Partial index:** `(tenant, captured_at DESC) WHERE band = 'red'` for the "what's red right now" headline.

---

## 6. APIs (BFF follow-up commit)

All routes `requireTenant` + JWT auth + envelope `{header, body}`. The cockpit SPA renders fully today without these — they enable persistence (briefing cache, report generation, audit-write fan-out on actions).

| Method | Path | RBAC | Purpose |
|---|---|---|---|
| GET | `/v1/executive-cockpit` | `executive:read` | Composite payload: overview + heatmap + exposures + forecasts + briefings + KPIs |
| GET | `/v1/executive-briefings?cadence=daily|weekly|monthly` | `executive:read` | Returns latest cached briefing for cadence; generates if stale |
| POST | `/v1/executive-briefings/refresh` | `executive:write` | Force-regenerate the cached briefing for a cadence |
| GET | `/v1/executive-reports?template_id=&since=&until=` | `executive:read` | List generated report artefacts |
| GET | `/v1/executive-reports/:report_id` | `executive:read` | Single report (returns storage_key download URL) |
| POST | `/v1/executive-report/export` | `executive:write` | Generate a new report; body `{template_id, format, parameters?}` |
| GET | `/v1/executive-kpi-snapshots?kpi_id=&since=` | `executive:read` | Historical strategic KPI snapshots for trend lines |
| POST | `/v1/executive-actions/:action_id` | varies (matches `actionsForRole`) | Fire one of the 5 executive actions + audit-chain write |

**OpenAPI surface:** to be added at `docs/openapi/executive-cockpit.yaml`. Request / response shapes mirror the TypeScript types in `executiveCockpitEngine.ts` + `executiveBriefing.ts`.

**Error codes:** standard envelope — `EWS_403_executive_only` · `EWS_403_action_not_permitted` · `EWS_400_invalid_template` · `EWS_400_invalid_format` · `EWS_404_unknown_report` · `EWS_409_briefing_in_flight`.

---

## 7. RBAC Model

**Page gate** — `canAccessExecutiveCockpit(roles)` accepts:

| Role | Granted | Notes |
|---|---|---|
| `super_admin` | ✅ | Full access incl. every Section 8 action |
| `cro` | ✅ | All actions |
| `ceo` | ✅ | All actions except `trigger_review` |
| `cfo` | ✅ | All actions except `escalate_risk` / `launch_investigation` |
| `coo` | ✅ | Operational actions |
| `board_member` | ✅ | Read-only + `export_report` |
| `country_head` | ✅ | Read-only + `export_report` (country-scoped data at API layer) |
| `executive` (generic) | ✅ | Legacy fallback |
| `admin` (legacy backend) | ✅ | Treated as super_admin for sidebar discovery |
| anything else | ❌ | Bounced to `/` |

**Action gating** — each `ExecutiveActionDef` carries an `allowed_roles[]` subset:

| Action | super_admin | cro | ceo | cfo | coo | board_member | country_head |
|---|---|---|---|---|---|---|---|
| Escalate Risk (critical severity) | ✅ | ✅ | ✅ | — | ✅ | — | — |
| Launch Investigation | ✅ | ✅ | ✅ | — | — | — | — |
| Trigger Review | ✅ | ✅ | — | ✅ | — | — | — |
| Export Report | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Notify Leadership | ✅ | ✅ | ✅ | ✅ | ✅ | — | — |

`actionsForRole(role)` filters the action list at render time. BFF re-checks `allowed_roles[]` on POST to defend against client tampering.

---

## 8. Reporting Architecture (Section 6)

7 report templates declared in `REPORT_TEMPLATES` array:

| Template | Cadence | Formats | Source |
|---|---|---|---|
| `executive_summary` | on_demand | PDF, XLSX | Cockpit live state |
| `quarterly_board_pack` | quarterly | PDF | Cockpit + analytics rollup (40-slide deck) |
| `regulatory_rbi_quarterly` | quarterly | PDF, XLSX | mart.customer_360 + audit chain |
| `regulatory_irdai_quarterly` | quarterly | PDF, XLSX | mart.policy_360 (when wired) |
| `risk_profile_snapshot` | on_demand | PDF, XLSX, CSV | mart.customer_360 |
| `recovery_performance` | monthly | PDF, XLSX, CSV | app_recovery.recovery_workflow_events |
| `fraud_investigation_summary` | monthly | PDF, XLSX | investigation tracker + fraud signals |

**Pipeline reuse:** every template deep-links into `/reports/builder?source=<legacy_source_id>` so the cockpit doesn't duplicate the T4.6 self-service report builder pipeline — it just surfaces an executive-friendly index.

**Future:** the `POST /v1/executive-report/export` route writes a row to `executive_reports` with `status='pending'`, then an async worker generates the artefact + writes back `status='ready'` + `storage_key`. Same async-job pattern as M12.1 report jobs.

---

## 9. AI Briefing Framework (Section 5)

`generateExecutiveBriefing(tenant_id, cadence, asOf)` produces a deterministic briefing per `(tenant, cadence, period_start_date)`:

```typescript
interface ExecutiveBriefing {
  id: string;
  cadence: 'daily' | 'weekly' | 'monthly';
  period_label: string;   // e.g. "Week of 2026-05-25"
  period_start: string;
  period_end: string;
  generated_at: string;
  headline: string;        // single-sentence summary
  highlights: BriefingHighlight[];  // 4 / 5 / 6 cards for daily / weekly / monthly
  recommended_action: string;
}
```

**Template pools:**
- `HIGHLIGHT_POOL` — 16 highlight templates (mix of positive / negative / neutral, with optional drill_to)
- `CADENCE_HEADLINES` — 3 headlines per cadence (daily / weekly / monthly)
- `RECOMMENDED_ACTIONS` — 7 action suggestions

**Deterministic seeding** via FNV-1a + Mulberry32 over `(tenant, cadence, period_start)`. Same inputs always produce the same briefing — different days reshuffle.

**Production swap:** the function body becomes a Claude / Bedrock `messages.create` call returning the same JSON shape. Schema enforced via `executive_briefings` table's CHECK constraints. Until then the heuristic gives operationally-realistic briefings for demo without LLM cost or latency.

---

## 10. Testing Strategy

`web/src/__tests__/ExecutiveCockpit.test.tsx` — **44 tests, all passing**.

### Test categories
- **Role gate (4):** every executive persona granted; legacy executive + admin granted; non-execs refused; empty/null refused
- **Enterprise Risk Overview (4):** 7 KPI count; deterministic per (tenant, day); different tenants diverge; every KPI has label+value+sub
- **Risk Heatmap (4):** non-empty cells per scope; band enum; risk_score ∈ [0, 100]; deterministic
- **Top Exposures (4):** exactly 10 per kind; rank 1..10 stable; ≥1 driver per row; entity_id prefix matches kind
- **Predictive Forecasts (4):** 5 forecasts; 9 series buckets each (6 actual + 3 forecast); confidence ∈ [0, 1]; severity enum
- **Strategic KPIs (3):** 6 KPIs; band ∈ green/amber/red; all 6 StrategicKpiId values present
- **Executive Actions (3):** 5 actions; every has label+desc; actionsForRole narrows correctly
- **AI Briefing (5):** briefing per cadence; daily=4/weekly=5/monthly=6 highlights; deterministic; tenant divergence; generateAllBriefings returns 3
- **Report Templates (3):** ≥7 templates; supported formats validated; getReportTemplate hit/miss
- **Page render (8):** admin sees all 8 sections; KPI strip with 7+ tiles; heatmap tabs render; exposure tab switching changes panel; field_officer + risk_analyst bounced; all 5 actions render; action click shows feedback; cockpit footer renders

### Sibling regression sweep
- `RoleBasedDashboard.test.tsx` (28/28)
- `DashboardPage.test.tsx` (9/9)
- `AppShell.test.tsx` (1/1 — disambiguated)
- `AppShellNavGroups.test.tsx` (8/8)
- **Total: 46/46 — zero regression**

### Quality gates
- `tsc --noEmit` clean on all executive module files
- `vite build` clean (4.67s, ~755 kB gzip — no regression vs prior baseline)

---

## Success Criteria — All Met ✅

| Criterion | Status |
|---|---|
| Executive users get a dedicated cockpit | ✅ `/executive-cockpit` with 8 sections |
| Existing dashboards remain unchanged | ✅ Zero edits to `/` Dashboard or `/dashboards/role-based` |
| Zero route removal | ✅ App.tsx routes: 149 → 150 (added 1, removed 0) |
| Zero API removal | ✅ No BFF route deleted |
| Zero RBAC regression | ✅ Existing matrix untouched; cockpit role gate is page-local |
| Enterprise-grade executive intelligence experience | ✅ 8 sections · 7-KPI overview · 4 heatmap scopes · 4 exposure leaderboards · 5 forecasts · 3-cadence briefings · 7 report templates · 6 strategic KPIs · 5 executive actions |

---

## Pattern Coda — 10 IA additions this session

1. Rule Center (`61ae37c`)
2. Audit Center + Recovery Center (`1689032`)
3. AI Governance Layer (`727ebd0`)
4. Enterprise IAM Layer (`b7539d7`)
5. Enterprise Governance Center (`e776639`)
6. Security Activity Center (`09e62e5`)
7. Enterprise Recovery Management Center (`32a9007`)
8. Navigation Simplification (`4994f37`)
9. Role-Based Dashboard Engine (`4fa21f9`)
10. **Executive Risk Cockpit** (this commit)

Same overlay-not-replacement pattern every time. Same additive-only constraints. Same outcome: extensive new capability with zero breaking changes.
