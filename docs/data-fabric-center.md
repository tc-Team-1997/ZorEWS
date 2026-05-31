# Enterprise Data Fabric & Integration Hub

**Status:** shipped 2026-05-31 (14th IA overlay this session).
**Route:** `/data-fabric-center`
**Owner:** agent-data + agent-integration
**Schema migration:** `data/schema/057_data_fabric.sql`

> Single enterprise control tower for every banking + insurance data integration, pipeline, quality control, lineage and governance asset. **Overlay on top of existing modules — zero subtraction.** Data Ingestion / Data Profiling / Validation Rules / Standardization / Anomaly Detection / Reconciliation / Data Quality Score / Master Setup / Audit Center / Regulatory Compliance Center / Investigation Center / Predictive Risk Center / Role-Based Dashboard / Executive Cockpit — every prior IA continues to render at its existing route without change.

---

## 1. Why this overlay exists

ZorEWS already ships eight or nine separate data-related surfaces — Data Ingestion (`/admin/ingestion`), Profiling (`/admin/profiling`), Validation Rules (`/admin/validation-rules`), Standardization (`/admin/standardization`), Anomaly Detection (`/admin/anomaly-detection`), Reconciliation (`/admin/reconciliation`), Data Quality Score (`/admin/data-quality-score`), Integrations (`/admin/integrations`), Master Setup (`/admin/master-setup`). Each does one thing well. None of them gives an executive or a Chief Data Officer a single screen that answers the question every regulator asks first: **"is the data we are running our risk decisions on actually trustworthy?"**

The Data Fabric Center is the consolidated lens. It is read-mostly and pulls deterministic snapshots from five pure engines so a demo always renders, and a backend wire-up later swaps each resolver for a `/v1/*` BFF route with the same shape.

## 2. Deliverables shipped (15)

| # | Deliverable | Location |
|---|---|---|
| 1 | Closed-enum catalog (16 enums) — domains, source kinds banking + insurance + common, integration types/statuses, execution statuses, pipeline statuses + actions, classifications, quality dimensions + bands, observability event kinds + severities, readiness states, role catalog | `web/src/modules/dataFabric/dataFabricEngine.ts` |
| 2 | Data source registry — ~36 deterministic sources across banking / insurance / common, all 5 integration types | `dataFabricEngine.ts` `listDataSources` |
| 3 | Integration hub — connections + executions + throughput + latency + availability + retry queue | `dataFabricEngine.ts` `buildIntegrationHubSummary` |
| 4 | Pipeline orchestrator — pipeline list + runs + 6 actions (run / pause / resume / retry / abort / clone) + status histogram + history | `web/src/modules/dataFabric/pipelineOrchestrator.ts` |
| 5 | Data quality center — 6-dimension scores + 5 quality bands + per-source quality + recent failed records + 30-day trend + heatmap | `web/src/modules/dataFabric/dataQualityCenter.ts` |
| 6 | Metadata catalog — business glossary + data dictionary + PII / CDE / regulatory flags + ownership | `web/src/modules/dataFabric/dataCatalogLineage.ts` |
| 7 | Data lineage — nodes (source / transformation / data_quality / risk_engine / ai_model / dashboard / report) + edges + impact analysis | `dataCatalogLineage.ts` |
| 8 | Data governance — 5 policy kinds (retention / access / classification / masking / anonymization) + compliance score | `dataCatalogLineage.ts` |
| 9 | Data observability — 7 event kinds, 3 severities, source health rollup, freshness + drift + schema-change tracking | `web/src/modules/dataFabric/dataObservabilityReadiness.ts` |
| 10 | AI data readiness — per-dataset feature availability / freshness / quality / validation pass rate; 3 readiness states | `dataObservabilityReadiness.ts` |
| 11 | Executive data health dashboard — composite score, 30-day trend (health / quality / freshness), top open incidents | `dataObservabilityReadiness.ts` `buildExecutiveDataHealthDashboard` |
| 12 | Page surface — `DataFabricCenterPage.tsx` with 10 sections, role gate, 3 filter axes, KPI tiles, recharts visualizations | `web/src/modules/dataFabric/DataFabricCenterPage.tsx` |
| 13 | i18n key `data_fabric_center` across en / hi / dz / ne | `web/src/lib/i18n.ts` |
| 14 | Sidebar entry with new `Cable` lucide icon, gated to admin / supervisor / risk_analyst (deeper role gating happens inside the page via `DATA_FABRIC_ROLES`) | `web/src/components/layout/navConfig.ts` |
| 15 | 11 additive database tables — every CREATE TABLE wrapped in IF NOT EXISTS, every CHECK constraint mirrors a closed enum in code | `data/schema/057_data_fabric.sql` |

## 3. Page anatomy

The page renders exactly 10 sections, each behind its own `data-testid="df-section-<name>"` so the vitest suite (`web/src/__tests__/DataFabricCenter.test.tsx`) can assert their presence.

1. **Data source registry** — top + bottom-row chip filters (domain × status × type), table of the top 14 sources, and a "top source kinds" bar chart for at-a-glance composition.
2. **Integration hub** — 7-tile KPI strip (connections / active / failed / retry / throughput / latency / success rate) + recent executions table.
3. **Pipeline orchestration** — status histogram (one chip per of 6 PIPELINE_STATUSES), action button group (6 PIPELINE_ACTIONS), pipelines table, recent runs table with SLA chips.
4. **Data quality center** — chip strip per of 6 QUALITY_DIMENSIONS, 30-day trend area chart, worst-sources list, per-source quality table, recent failed records list.
5. **Metadata catalog** — business glossary list + sample data dictionary table with PII / REG / CDE badges.
6. **Data lineage** — nodes-by-kind grid + sample edges table.
7. **Data governance** — policy-kind tiles + policy table with approver + status.
8. **Data observability** — event-kind chip filter, 4-tile KPI strip, recent events list, source-health worst-10 table.
9. **AI data readiness** — 4-tile KPI strip, per-dataset table with model + purpose + readiness state.
10. **Executive data health** — 6-tile KPI strip, 30-day trend area chart with three series (health / quality / freshness), top open incidents list, AI readiness composite badge.

A `Cross-IA` footer links to Governance, Audit Center, Regulatory Compliance Center, Investigation Center, Predictive Risk Center, Executive Cockpit, Role Dashboard — proving the overlay-not-replacement pattern visually.

## 4. RBAC model

Sidebar visibility: `admin / supervisor / risk_analyst` (the gate inside the page is wider via `canAccessDataFabricCenter`; the sidebar is intentionally narrower so analysts who only consume — auditor / compliance_officer — find the page via deep-link rather than nav clutter). Inside the page every role declared in `DATA_FABRIC_ROLES` (16 entries: super_admin / country_admin / data_engineer / data_steward / data_scientist / data_governance_officer / data_quality_analyst / risk_analyst / fraud_analyst / compliance_officer / auditor / cdo / cto / dpo + the legacy backend `admin / supervisor`) is granted.

Refused: `field_officer / investigator / unknown`.

## 5. Closed enums (16)

Declared verbatim in `dataFabricEngine.ts` and mirrored by CHECK constraints in `057_data_fabric.sql`. Listed for downstream BFF teams:

```
DATA_DOMAINS                  banking | insurance | common
BANKING_SOURCE_KINDS          10 kinds (CBS / LOS / LMS / TBS / SWIFT / CRM_BANK / AML / IFRS9 / TRADE_FINANCE / TREASURY)
INSURANCE_SOURCE_KINDS        8 kinds (POLICY_MASTER / CORE_INSURANCE / CLAIMS / AGENT_PORTAL / IRDAI_FILING / REINSURANCE / ACTUARIAL / CRM_INS)
COMMON_SOURCE_KINDS           9 kinds (KAFKA / KINESIS / SFTP / DMS / API / WAREHOUSE / BUREAU / DATA_LAKE / EXTERNAL_API)
INTEGRATION_TYPES             api | file | streaming | database_replication | event_driven
INTEGRATION_STATUSES          active | paused | failed | retrying | degraded
EXECUTION_STATUSES            success | failure | partial | running | queued
PIPELINE_STATUSES             idle | scheduled | running | paused | failed | success
PIPELINE_ACTIONS              run | pause | resume | retry | abort | clone
DATA_CLASSIFICATIONS          public | internal | confidential | restricted | pii | pci | phi | regulatory
QUALITY_DIMENSIONS            completeness | accuracy | consistency | validity | timeliness | uniqueness
QUALITY_BANDS                 excellent | good | fair | poor | critical
OBSERVABILITY_EVENT_KINDS     freshness_lag | volume_anomaly | schema_change | failed_load | pipeline_latency_spike | data_drift | quality_degradation
OBSERVABILITY_SEVERITIES      info | warning | critical
READINESS_STATES              ready | degraded | unavailable
DATA_FABRIC_ROLES             16 role identifiers (admin + supervisor + 14 enterprise personas)
```

Every CHECK constraint in `057_data_fabric.sql` references one of these enums by string set, so violating an enum at the database layer fails fast at INSERT time.

## 6. Schema migration (`057_data_fabric.sql`)

11 additive tables under `app_iam.*`, all idempotent. **Zero alteration to existing tables.** Re-running `make migrate` is safe.

| # | Table | Identity | Purpose |
|---|---|---|---|
| 1 | `app_iam.data_sources` | `source_id` PK | Source registry — name / kind / domain / type / status / classification / owner / steward / refresh frequency / tags |
| 2 | `app_iam.integration_connections` | `connection_id` PK, FK to `data_sources` | Source → target wiring + throughput + latency + availability + retries |
| 3 | `app_iam.integration_executions` | `execution_id` PK, FK to `integration_connections` | Per-execution log (success / failure / partial / running / queued) |
| 4 | `app_iam.data_pipelines` | `pipeline_id` PK | Pipeline definitions — schedule, source_ids[], target_ids[], owner, SLA |
| 5 | `app_iam.pipeline_runs` | `run_id` PK, FK to `data_pipelines` | Per-run log + SLA met flag + trigger source |
| 6 | `app_iam.metadata_catalog` | `entry_id` PK | Business glossary + data dictionary (CHECK kind ∈ glossary_term / dictionary_entry) |
| 7 | `app_iam.data_lineage` | `edge_id` BIGSERIAL | Lineage edges — `(from_node, to_node, from_kind, to_kind, transformation)` |
| 8 | `app_iam.data_governance` | `policy_id` PK | Policies (CHECK kind ∈ retention / access / classification / masking / anonymization) |
| 9 | `app_iam.data_quality_metrics` | `metric_id` BIGSERIAL, FK to `data_sources` | 6-dimension scores per source with score / target / band |
| 10 | `app_iam.data_observability_events` | `event_id` PK, FK to `data_sources` | Observability events (freshness / volume / schema / drift / quality_degradation) |
| 11 | `app_iam.ai_data_readiness` | `dataset_id` PK | AI dataset readiness for training / inference / validation |

Two `BEFORE UPDATE` triggers keep `updated_at` columns fresh on `data_sources` and `data_pipelines` (single shared `app_iam.data_sources_touch()` function).

## 7. Frontend module map

```
web/src/modules/dataFabric/
├── dataFabricEngine.ts            # 16 closed-enum types, sources + integrations
├── pipelineOrchestrator.ts        # pipelines + runs + history + status histogram
├── dataQualityCenter.ts           # 6 dimensions + heatmap + trend + failed records
├── dataCatalogLineage.ts          # glossary + dictionary + lineage graph + governance policies
├── dataObservabilityReadiness.ts  # observability events + source health + AI readiness + exec dashboard
└── DataFabricCenterPage.tsx       # SPA page rendering all 10 sections
```

All public functions are pure and accept `(tenant_id, asOf)` so the page can compute deterministic snapshots in the browser today and swap each call for a `fetch` against a `/v1/data-fabric/*` BFF route later without touching the page itself.

## 8. Production BFF wire-up (later)

When the BFF lands, swap the 11 in-memory resolvers for the following endpoints (matching the deliverables in §2). The page changes are zero — pages already consume the same `ReturnType<>` shape the resolvers produce today.

| Endpoint | Replaces |
|---|---|
| `GET /v1/data-fabric/sources` | `listDataSources` |
| `GET /v1/data-fabric/sources/:id` | `getDataSource` |
| `GET /v1/data-fabric/integration/summary` | `buildIntegrationHubSummary` |
| `GET /v1/data-fabric/integration/connections` | `listIntegrationConnections` |
| `GET /v1/data-fabric/integration/executions?limit=N` | `listIntegrationExecutions` |
| `GET /v1/data-fabric/pipelines` + `/:id` + `/runs` + `/summary` | pipeline orchestrator surface |
| `GET /v1/data-fabric/quality/sources` + `/heatmap` + `/trend` + `/failed-records` + `/summary` | data quality center surface |
| `GET /v1/data-fabric/catalog/glossary` + `/dictionary` + `/summary` | metadata catalog surface |
| `GET /v1/data-fabric/lineage` + `POST /lineage/impact` | lineage surface |
| `GET /v1/data-fabric/governance/policies` + `/summary` | governance surface |
| `GET /v1/data-fabric/observability/events` + `/source-health` + `/summary` | observability surface |
| `GET /v1/data-fabric/ai-readiness` + `/summary` + `/executive-dashboard` | AI readiness + executive surface |

## 9. Tests

Suite: `web/src/__tests__/DataFabricCenter.test.tsx` — 59 vitest cases covering:

* Role gate (3 cases) — all 16 declared roles + legacy + refuse-unknown
* Closed-enum invariants (12 cases) — every enum size + composition + canonical ordering
* Data source resolvers (4 cases) — non-empty + deterministic + required-field shape + getDataSource hit/miss
* Integration hub (3 cases) — summary partition + connections enum + executions limit
* Pipeline orchestrator (5 cases) — list determinism + status / domain / schedule shape + getPipeline hit/miss + runs limit + summary
* Data quality (5 cases) — per-source rows + failed records limit + trend bounds + heatmap shape + summary partition
* Metadata catalog (3 cases) — glossary shape + dictionary limit + summary totals
* Lineage (2 cases) — nodes + edges with kind enum, analyzeImpact returns result
* Governance (2 cases) — policies enum + summary by_kind partition
* Observability (3 cases) — events limit + source health enum + summary partition
* AI readiness (2 cases) — datasets enum + summary partition
* Executive dashboard (2 cases) — health score + 30-day trend bounds
* Page render (4 cases) — bounce field_officer, render 10 sections for admin / supervisor / risk_analyst
* Source registry filter wiring (3 cases) — domain / status / type chips render and toggle
* KPI tile presence (4 cases) — integration / pipeline buckets + actions / quality dimensions / observability filter chips / exec KPIs / AI KPIs

**All 59 tests pass.** Sibling sweep across 8 other IA-overlay test files (RegulatoryComplianceCenter, InvestigationCenter, PredictiveRiskCenter, ExecutiveCockpit, RoleBasedDashboard, DashboardPage, AppShell, AppShellNavGroups) — **283/283 pass**. Zero regression.

## 10. Hard constraints honoured

* ✅ No existing module removed.
* ✅ No existing route removed.
* ✅ No existing API removed.
* ✅ No existing business workflow modified.
* ✅ Additive changes only.
* ✅ Backward compatibility maintained.
* ✅ `CREATE TABLE IF NOT EXISTS` on every new table.
* ✅ No edits to existing migrations.

## 11. Verification

```
cd /Users/chuadhary_taniya/ZorEWS/web
npx tsc --noEmit         # 26 pre-existing baseline errors; zero new in dataFabric
npx vite build           # clean — 4.97s build time
npx vitest run src/__tests__/DataFabricCenter.test.tsx
# Test Files  1 passed (1)
#      Tests  59 passed (59)
npx vitest run \
  src/__tests__/RegulatoryComplianceCenter.test.tsx \
  src/__tests__/InvestigationCenter.test.tsx \
  src/__tests__/PredictiveRiskCenter.test.tsx \
  src/__tests__/ExecutiveCockpit.test.tsx \
  src/__tests__/RoleBasedDashboard.test.tsx \
  src/__tests__/DashboardPage.test.tsx \
  src/__tests__/AppShell.test.tsx \
  src/__tests__/AppShellNavGroups.test.tsx
# Test Files  8 passed (8)
#      Tests  283 passed (283)
```
