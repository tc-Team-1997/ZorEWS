# Enterprise Report Export Framework — Design Spec

**Date:** 2026-06-13
**Status:** Approved (brainstorming) — pending spec review → implementation plan
**Scope of this spec:** Phase 1 (Foundation), "P1-thin". Phases P1.5–P4 are roadmap context only; each gets its own spec→plan cycle.

---

## 1. Objective

Implement a platform-wide **Enterprise Report Export Framework** across ZorEWS so operators can generate professional reports (customer / risk / case / recovery / compliance / portfolio / executive / AI-insight) from any major screen, in multiple formats, with RBAC enforcement, an audit record per export, and an Export History Center.

Target quality bar: Moody's / SAS / Oracle FCCM / Actimize-class reporting.

**Hard constraint — additive only:** no existing route changes, no API removal, no RBAC regressions, no UI regressions. Every existing screen keeps working unchanged; it only gains an Export button.

---

## 2. Scope decomposition

The full spec is a multi-subsystem feature. It is decomposed into phases; **only P1-thin is specified for implementation here.**

| Phase | Deliverable | Screens |
|---|---|---|
| **P1-thin (this spec)** | Shared `ExportButton` + `ExportModal` + `ReportData` adapter contract + 3 generators (PDF/Excel/CSV) + config (date-range/scope/sections) + BFF audit + history record + RBAC. Piloted on **Customer Risk Profile** + **Alerts** | 2 |
| P1.5 | Word (.docx) generator + deterministic AI narrative, on the same 2 pilot screens | 2 |
| P2 | Wire framework into Banking + Action Center screens | ~13 |
| P3 | Wire into Insurance + Compliance + Executive screens | ~13 |
| P4 | Export History Center page polish + true byte-identical re-download (server-side artifact storage) | cross-cut |

Each phase is additive on the prior. P1-thin establishes the adapter contract that every later screen repeats.

---

## 3. Decision log (aligned during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Generation location | **Option C — Hybrid** | PDF/Excel/CSV generated client-side (reuses existing jspdf/write-excel-file infra); every export fires a BFF `POST /v1/exports` for a server-trustworthy audit + history record; Word + AI narrative are BFF-side (later phases) |
| P1 depth | **P1-thin** | Validate the adapter contract + modal + 3 formats + audit/history/RBAC first; Word + AI bolt on after the foundation is solid |
| Export-history + audit store | **In-memory**, pg-swap-ready interface | Matches every other M-store in the repo; pg later if persistence becomes a demo blocker |
| AI narrative (later phase) | **Deterministic template**, Claude-swap-ready | Anthropic prod key is an external blocker; deterministic synthesis is the repo convention |

---

## 4. Architecture

All new files. No existing file's behavior changes (pilot screens get an added button + adapter only).

**Frontend (`web/src/`):**
- `lib/export/types.ts` — the `ReportData` adapter contract (§5) + `ExportConfig` + `ExportFormat` enums
- `lib/export/generators/pdf.ts` — `buildReportPdf(data, config) → Blob`
- `lib/export/generators/xlsx.ts` — `buildReportXlsx(data, config) → Promise<Blob>`
- `lib/export/generators/csv.ts` — `buildReportCsv(data, config) → Blob`
- `lib/export/recordExport.ts` — fires `POST /v1/exports` (best-effort audit/history)
- `components/export/ExportButton.tsx` — standardized, RBAC-gated trigger
- `components/export/ExportModal.tsx` — format + config + sections UI (reuses `Modal` primitive)
- Pilot adapters: `modules/customers/customerReportAdapter.ts`, `modules/alerts/alertsReportAdapter.ts`

**Backend (`services/bff/src/exports/`):**
- `store.ts` — `ExportHistoryStore` interface + `InMemoryExportHistoryStore` (per-tenant, FIFO-capped)
- `routes.ts` — `POST /v1/exports`, `GET /v1/exports`, `GET /v1/exports/:export_id`
- Wired into `server.ts` with `requireTenant` + `requireRole('reports:export')`

**RBAC (`infra/rbac/matrix.json`):** new additive scope `reports:export` (roles: admin, supervisor, risk_analyst — analyst+; tighten/widen during impl review).

---

## 5. The `ReportData` contract (P1 core)

Every screen's adapter produces this shape. Generators consume only this — they never know which screen produced it.

```ts
type ReportType =
  | 'customer' | 'risk' | 'case' | 'recovery'
  | 'compliance' | 'portfolio' | 'executive' | 'ai_insight';

interface ReportData {
  report_type: ReportType;
  module: string;                  // 'customer_360' | 'alerts' | …
  title: string;
  subject?: { id: string; name: string };   // customer/case-level reports
  meta: {
    tenant_id: string;
    generated_by: string;
    role: string;
    generated_at: string;          // ISO
    report_id: string;             // 'EXP-<tenant>-<ts>-<seq>'
  };
  sections: {
    summary?:          { label: string; value: string }[];
    kpis?:             { label: string; value: string; delta?: string }[];
    trends?:           { label: string; points: { x: string; y: number }[] }[];
    tables?:           { name: string; columns: string[]; rows: (string|number)[][] }[];
    alerts?:           Record<string, string|number>[];
    recommendations?:  string[];
    ai_insights?:      { narrative: string };   // P1 stub (empty); P1.5/P4 fills
    audit_trail?:      Record<string, string|number>[];
    workflow_history?: Record<string, string|number>[];
  };
}
```

`ExportConfig` (from the modal) selects which sections + which date-range + which data-scope the adapter populates:

```ts
interface ExportConfig {
  formats: ExportFormat[];                 // ('pdf'|'xlsx'|'csv')[]
  report_type: ReportType;
  date_range: 'today'|'7d'|'30d'|'quarter'|'custom';
  custom_range?: { from: string; to: string };
  data_scope: 'current_page'|'filtered'|'selected'|'complete';
  include: {                               // section toggles
    summary: boolean; kpis: boolean; trends: boolean; charts: boolean;
    alerts: boolean; ai_insights: boolean; recommendations: boolean;
    audit_trail: boolean; workflow_history: boolean;
  };
}
```

Adapter signature: `(config: ExportConfig) => ReportData | Promise<ReportData>`.

---

## 6. ExportModal config surface

Reuses the existing `Modal` primitive. Sections:
- **Formats** (checkbox group): PDF · Excel (.xlsx) · CSV — (Word disabled-with-tooltip "coming soon" in P1)
- **Report Type** (select): 8 types from `ReportType`
- **Date Range**: Today / Last 7 Days / Last 30 Days / Quarter / Custom (custom → 2 date inputs)
- **Data Scope**: Current Page / Filtered Records / Selected Records / Complete Dataset
- **Include Sections** (checkbox group): Summary / KPIs / Trends / Charts / Alerts / AI Insights / Recommendations / Audit Trail / Workflow History
- **Generate** button → runs adapter → generators → download(s) → `POST /v1/exports` per format

---

## 7. Data flow

```
Screen
  └─ <ExportButton> (hidden if no reports:export scope)
       └─ opens <ExportModal>
            └─ user picks formats + config
                 └─ "Generate"
                      ├─ adapter(config) → ReportData
                      ├─ for each format: generator(ReportData, config) → Blob → browser download
                      └─ for each format: POST /v1/exports  (audit + history record)
                           └─ BFF: auditTrailStore.record(action='export.generate')
                                   + exportHistoryStore.add(record)
```

---

## 8. Enterprise format output

**PDF** (`pdf.ts`, jspdf + jspdf-autotable):
- Header block: `ZorEWS` / `Early Warning System` / tenant name / Generated By / Generated Date / **Report ID**
- Body: one block per included section (summary table, KPI grid, trend tables, data tables, recommendations list)
- Page numbering (`Page X of Y`)
- Footer: `Confidential — Generated from ZorEWS`

**Excel** (`xlsx.ts`, write-excel-file/browser) — multi-sheet:
- Sheet 1 — Executive Summary (meta + summary + KPIs)
- Sheet 2 — Raw Data (the primary table)
- Sheet 3 — Risk Analysis (risk-scoped tables/KPIs)
- Sheet 4 — Audit Trail (when included)
- (AI Recommendations sheet added in P1.5 when narrative lands)

**CSV** (`csv.ts`) — primary tabular records only (RFC 4180 escaping), respects the modal's data-scope + the screen's active filters; no multi-section composition.

---

## 9. Security: RBAC + audit

- **RBAC:** `ExportButton` is not rendered unless the viewer's role has `reports:export`. `POST /v1/exports` is gated by `requireRole('reports:export')` → 403 otherwise. The *data* is already RBAC-gated at its source route (the screen fetched it under the user's scope); the export framework never re-fetches or escalates.
- **Audit:** every `POST /v1/exports` writes an M15.1 audit event: `action='export.generate'`, `resource_type='report'`, `metadata={ module, report_type, format, record_count, data_scope }`, plus the actor/tenant from request context. Server-trustworthy (client cannot skip the audit because the history record IS the audit POST).

---

## 10. Export history store + routes

`ExportRecord`:
```ts
interface ExportRecord {
  export_id: string;        // 'EXP-<tenant>-<ts>-<seq>'
  tenant_id: string;
  generated_by: string;
  role: string;
  module: string;
  report_type: ReportType;
  format: ExportFormat;
  record_count: number;
  title: string;
  status: 'completed' | 'failed';
  generated_at: string;     // ISO
  config_snapshot: ExportConfig;   // enables P1 "re-run with same config"
}
```

Routes (all tenant-gated, enveloped, `reports:export`):
- `POST /v1/exports` — body `{ module, report_type, format, record_count, title, status, config }` → 201 with the `ExportRecord`. Writes history + audit.
- `GET /v1/exports?module=&format=&report_type=&page=&page_size=` — newest-first paginated history (tenant-scoped).
- `GET /v1/exports/:export_id` — single record (404 cross-tenant). Returns `config_snapshot` so the SPA can re-run.

`InMemoryExportHistoryStore`: per-tenant `Map`, FIFO cap (default 500), defensive copy on read.

---

## 11. Re-download caveat (explicit)

P1 generates client-side, so the BFF does **not** store the produced file bytes. In P1, "re-download" means **re-run with the same `config_snapshot`** (the SPA rebuilds the report from live data + the saved config). True byte-identical re-download requires server-side artifact storage and is deferred to **P4** (alongside BFF-side Word generation).

---

## 12. Error handling

- Generator throws → modal shows an inline error; a `POST /v1/exports` with `status='failed'` is recorded (so failed attempts are auditable).
- `POST /v1/exports` network failure → the client download already succeeded; the failure is `console.warn`-logged and surfaced as a non-blocking modal notice (best-effort, mirrors the existing webhook fire-and-forget pattern). The download is never blocked on the audit call.
- Empty/zero-row report → generators still produce a valid file with the meta header and an "no records for this scope" note.

---

## 13. Testing

**Frontend (vitest):**
- `ExportModal` renders all config controls; format multi-select; section toggles drive `ExportConfig`.
- Each generator: `ReportData` → non-empty Blob with the expected structure (PDF has header text; XLSX has the 4 sheets; CSV has header + rows).
- `ExportButton` hidden without `reports:export`; visible with it.
- Pilot adapters: produce a well-formed `ReportData` for a sample customer / alert list.

**Backend (jest):**
- `POST /v1/exports` → 201 + writes history + writes M15.1 audit event.
- `GET /v1/exports` → newest-first + every filter axis + pagination.
- `GET /v1/exports/:id` → 200 + 404 on cross-tenant.
- RBAC: 403 without `reports:export`.
- Tenant isolation: BIL exports invisible to BANK_DEMO.

---

## 14. Non-functional / additive guarantees

- **No existing route/API touched.** New routes: `POST/GET /v1/exports`, `GET /v1/exports/:id`.
- **New RBAC scope additive.** `reports:export` is added; no existing scope changes.
- **No UI regression.** Pilot screens gain an `ExportButton` only; existing layout/tests unaffected.
- **No test regression.** Full BFF jest + web vitest suites stay green; new tests are additive.

---

## 15. P1 pilot adapters (concrete)

- **Customer Risk Profile** (`modules/customers/CustomerRiskProfilePage.tsx`, BFF `/v1/customers/:id/360`): `report_type='customer'`, `subject={id,name}`, sections = summary (profile + risk score + NPA status), KPIs, alerts (linked), tables (case history), recommendations (stub).
- **Alerts** (`modules/alerts/AlertListPage.tsx`, `/v1/alerts`): `report_type='risk'`, no subject, sections = summary (counts by severity/class), tables (alert rows respecting active filters + data-scope), kpis.

---

## 16. Out of scope for P1 (explicit)

- Word (.docx) generation — P1.5
- AI narrative generation — P1.5 (deterministic), Claude — later
- The other 28 screens — P2/P3
- Server-side artifact storage + byte-identical re-download — P4
- pg-backed history persistence — when persistence becomes a demo blocker

---

## 17. Follow-ups after P1

- P1.5: `docx` npm dep + `generators/docx.ts` + deterministic `narrative.ts` (BFF) + AI Insight section/sheet.
- P2/P3: per-screen adapters (one `*ReportAdapter.ts` per screen, reusing the contract).
- P4: `Export History Center` SPA page + server-side artifact store + true re-download.
