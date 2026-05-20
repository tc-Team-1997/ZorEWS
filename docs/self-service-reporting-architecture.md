# ZorEWS — Self-Service Reporting Architecture

**Owner:** agent-integration + agent-ui · **Status:** Active build (T4.6) · **Last reviewed:** 2026-05-20

> Architecture + dependency analysis for T4.6 self-service reporting (QuickSight-equivalent). Lets analysts and risk-ops build ad-hoc reports against the mart + app_* layers without writing SQL. Pair with `docs/data-lineage.md` (queryable surfaces) + `docs/database-schema.md` (column-level reference) + `docs/charter.md` §2 (in-scope reporting features).

---

## 1. Design intent

| Goal | How |
|---|---|
| Analysts compose reports without SQL | Canonical data-source catalog + visual filter tree + section configurator |
| Saved configurations survive across sessions | pg-backable saved-report store (T4.13 / T4.18 pattern reused) |
| Role-based visibility | Per-report `visibility: 'private' \| 'role' \| 'tenant'` field + RBAC scope on routes |
| Drill-down between reports | Each data source declares `drill_targets[]`; UI navigates via deep-link |
| Export | Reuse `web/src/lib/reportsExport.ts` (T4.18) for client-side PDF/Excel; CSV streamed from BFF |
| Avoid duplicate aggregation logic | Filter compiler shares the same safety rails as T2.9 NL→SQL stub |
| Preserve existing flows | Additive only — no changes to `/v1/reports/:type` (M12.1), `/v1/dashboards/*`, `/analytics`, or webhooks |

---

## 2. Layering

```
┌──────────────────────────────────────────────────────────┐
│  SPA  /reports/builder                                   │
│  ├─ Saved-list panel                                     │
│  ├─ Filter tree builder (AND/OR/leaf nodes)              │
│  ├─ Section configurator (chart/table/grid; drag-drop)   │
│  ├─ Drill-down deep-link handler                         │
│  └─ Export buttons (CSV via streaming; PDF/Excel client) │
└──────────────────────────┬───────────────────────────────┘
                           │ /v1/reports/builder/*
                           ▼
┌──────────────────────────────────────────────────────────┐
│  BFF /v1/reports/builder/*                               │
│  ├─ /sources         (catalog)                           │
│  ├─ /preview         (compile filters → SQL plan)        │
│  ├─ /run             (execute + aggregate)               │
│  ├─ /export.csv      (streaming CSV)                     │
│  ├─ /saved           (CRUD on saved configurations)      │
│  └─ /saved/:id/run   (run a saved report)                │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│  Data sources (read-only)                                │
│  ├─ mart.customer_360 / loan_360 / txn_features /        │
│  │   indicator_values                                    │
│  ├─ app_alerts.alerts / queue_assignments                │
│  ├─ app_cases.cases / actions                            │
│  └─ app_audit.approvals / audit.event_log                │
└──────────────────────────────────────────────────────────┘
```

---

## 3. Component contracts

### 3.1 Data source catalog (T4.6.1)

Each entry declares the queryable shape:

```ts
interface ReportDataSource {
  source_id: string;           // 'mart.customer_360'
  display_name: string;        // 'Customer 360'
  description: string;
  schema: 'mart' | 'app_alerts' | 'app_cases' | 'app_audit' | 'audit';
  fields: ReportField[];
  default_filter_fields: string[];  // SPA pre-populates these
  drill_targets: DrillTarget[];     // links to other sources
  tenant_scoped: boolean;           // most sources are; audit chain is mixed
  required_role: string;            // RBAC scope to query
}

interface ReportField {
  name: string;
  display_name: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'datetime' | 'enum';
  enum_values?: readonly string[];
  filterable: boolean;
  groupable: boolean;
  aggregatable: boolean;     // supports SUM/AVG/MIN/MAX
  pii: boolean;              // SPA masks unless caller has `customers:read_pii` scope
}

interface DrillTarget {
  to_source_id: string;
  via_field: string;        // 'customer_id' → joins to mart.loan_360 on customer_id
  display_name: string;
}
```

The catalog is platform-static (closed enum). New tables require a code change to the catalog file — intentional, not a runtime configuration surface.

### 3.2 Report definition (T4.6.2)

```ts
interface ReportDefinition {
  source_id: string;
  filters: FilterNode;
  group_by: string[];        // e.g. ['risk_level', 'product_code']
  metrics: ReportMetric[];   // e.g. {field:'outstanding_balance', agg:'SUM'}
  sort: SortClause[];
  limit: number;             // clamped [1, 10000]
  sections: ReportSection[]; // chart + table compositions
}

type FilterNode =
  | { op: 'AND' | 'OR'; children: FilterNode[] }
  | { op: 'NOT'; child: FilterNode }
  | { op: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'in' | 'not_in' | 'between' | 'is_null' | 'is_not_null';
      field: string;
      value?: unknown };

interface ReportMetric {
  field: string;
  agg: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'DISTINCT_COUNT';
  alias?: string;
}

interface ReportSection {
  section_id: string;
  type: 'chart' | 'table' | 'grid' | 'kpi';
  config: ChartConfig | TableConfig | GridConfig | KpiConfig;
}
```

### 3.3 Filter compiler (T4.6.2)

Pure function — no I/O. Walks the FilterNode tree, validates every leaf's `field` against the source's declared fields, validates the value's type, and emits SQL fragments + parameter bindings:

```ts
function compileFilter(node: FilterNode, source: ReportDataSource, params: ParamBag): SqlFragment;
```

Safety rails (mirror T2.9 NL→SQL):

1. Whitelist fields — leaf's `field` MUST be in `source.fields`. Unknown → 400.
2. Type-check values — string/number/date validated against `ReportField.type`. Mismatch → 400.
3. Enum-check — `op: 'eq' \| 'in'` on enum field rejects out-of-enum values.
4. Parameterise — every value bound via `:p0`, `:p1`, ... — no string-concat.
5. Forbid keywords — `assertSafeSql` reuses T2.9's keyword regex.
6. Inject `tenant_id = :tenant_id` automatically for `tenant_scoped` sources.
7. Inject hard `LIMIT` (clamped [1, 10000] default 100).
8. SELECT-only — no DDL/DML.

### 3.4 Saved-report store (T4.6.3)

```ts
interface SavedReport {
  report_id: string;
  tenant_id: string;
  name: string;
  description: string;
  definition: ReportDefinition;
  created_by: string;
  created_at: string;
  updated_at: string;
  visibility: 'private' | 'role' | 'tenant';
  visible_to_roles: string[];     // populated when visibility='role'
  tags: string[];
}
```

Store interface (mirror `IScenarioStore` from T4.18):

```ts
interface ISavedReportStore {
  save(input): SavedReport;
  list(tenant, filter?): SavedReport[];
  get(id, tenant): SavedReport | null;
  delete(id, tenant): boolean;
  visibleTo(report, user_role, user_username, tenant): boolean;
}
```

In-memory + pg-backed via env-driven factory `makeReportStore()`. Pg backing table = new schema migration `data/schema/011_app_reports.sql` adding `app_bff.saved_reports`.

### 3.5 Execution engine (T4.6.4)

```ts
function executeReport(definition, sourceCatalog, tenant, user, now): ReportResult;

interface ReportResult {
  report_definition: ReportDefinition;
  rows: Record<string, unknown>[];
  aggregates: Record<string, number>;
  total_rows: number;
  generated_at: string;
  sql_compiled?: string;  // debug-only when caller role is admin
  params: Record<string, unknown>;
  duration_ms: number;
}
```

In the prototype phase, **execution returns synthesised rows** (FNV-1a + Mulberry32 seeded by (tenant, source, day, definition-hash)) so the SPA can demo end-to-end. The compiled SQL is returned but NOT executed against the live mart — production swap is a one-line replacement of `synthesiseRows()` with a pg-pool query.

### 3.6 SPA report builder (T4.6.5 + T4.6.6)

Page at `/reports/builder`:

- Saved-list left panel — collapses by visibility (private / role-shared / tenant-shared).
- Source picker — dropdown of catalog entries; SPA fetches `/v1/reports/builder/sources` once on mount.
- Filter tree builder — recursive `FilterNode` rendering; SPA passes the tree to `/preview` for SQL + sample-row preview.
- Section configurator — drag-drop reorder + add/remove sections; each section has its own type-specific config form.
- Drill-down — table-row click navigates to the drill-target source pre-populated with the join field as filter.
- Export buttons reuse `web/src/lib/reportsExport.ts` (T4.18) for client-side PDF/Excel. CSV calls `/v1/reports/builder/export.csv` streaming endpoint.

---

## 4. Role-based visibility

| Visibility | Saver | Visible to |
|---|---|---|
| `private` | individual analyst | the saver only |
| `role` | senior analyst / risk-IT | every user with at least one role in `visible_to_roles[]` |
| `tenant` | admin | every user in the same tenant |

Cross-tenant lookup always returns 404 (per existing T4.24 isolation pattern). Admin sees every report in their tenant including private ones (per RBAC `audit:read` superuser semantics — same as existing `/v1/admin/*` routes).

RBAC scopes:

- `customers:read_risk_profile` — analyst-tier (run + save private reports).
- `audit:read` — admin (run + save tenant-shared reports + force-delete).
- New scope `reports:share` — risk-IT lead can save role-shared reports. Added to `infra/rbac/matrix.json` in T4.6.3.

---

## 5. Reuse map

Avoiding duplicate aggregation logic:

| Concern | Reused from |
|---|---|
| SQL safety rails | T2.9 NL→SQL (`copilot/nl_to_sql.ts:assertSafeSql`) |
| Saved-config CRUD pattern | T4.18 scenario saved-config store |
| Pg-backed store factory | T4.13 webhook store |
| Tenant scoping | T4.24 Phase 4–6 tenant_id columns |
| Role-based access | `@apex-ews/rbac` matrix from T3.9 |
| Envelope shape | `services/bff/src/envelope.ts` (T4.24) |
| Client-side export | `web/src/lib/reportsExport.ts` (T4.18) |
| Aggregation in stubs | `services/bff/src/analytics/*.ts` (T4.1) |
| Saved-config SPA UI | `web/src/lib/savedScenarios.ts` (T4.18) |
| BFF deterministic synthesis | T5.5 FinOps + X.4 adoption (FNV-1a + Mulberry32) |
| RBAC enforcement | `@apex-ews/rbac.requireRole` middleware |

---

## 6. Per-sub-phase delivery contract

For every T4.6.x sub-phase commit, the commit message + STATUS.md entry document:

- Modules completed (file paths).
- APIs/routes added (path + method + RBAC scope).
- Schemas/tables impacted (DB migrations + new types).
- Analytics components added (resolvers, builders).
- Report builder capabilities completed (against the §3 + §6 contracts above).
- Test coverage delta (jest + vitest counts).
- Remaining reporting gaps (what's deferred + which sub-phase owns it).

---

## 7. Sub-phase sequence (re-stated for traceability)

| Sub-phase | Status | Deliverable |
|---|---|---|
| T4.6.0 | this commit | Architecture doc |
| T4.6.1 | next | Data source catalog (BFF) |
| T4.6.2 | after T4.6.1 | Filter compiler + preview route (BFF) |
| T4.6.3 | after T4.6.2 | Saved-report CRUD store + RBAC scope (BFF + pg migration) |
| T4.6.4 | after T4.6.3 | Execution engine + run route + CSV export (BFF) |
| T4.6.5 | after T4.6.4 | SPA page scaffold + saved-list + filter tree UI |
| T4.6.6 | after T4.6.5 | SPA section configurator + drill-down + export buttons |
| T4.6.7 | after T4.6.6 | Postman collection + integration smoke + nav links |

T4.6.1–T4.6.3 ship in this session. T4.6.4–T4.6.7 land in follow-up sessions per the user's direction ("Do not start mobile RN, live bank integrations, or feature-store redesign until T4.6 is completed").

---

## 8. References

- `docs/data-lineage.md` — queryable schemas + tenant scoping.
- `docs/database-schema.md` — column-level reference.
- `docs/charter.md` §2 — reporting in-scope confirmation.
- `services/bff/src/copilot/nl_to_sql.ts` — T2.9 NL→SQL stub + safety rails.
- `services/bff/src/scenario/store.ts` — saved-config store template.
- `web/src/lib/reportsExport.ts` — client-side PDF/Excel export (T4.18).
- `infra/rbac/matrix.json` — RBAC source-of-truth.
