# Export Framework P2 — Banking + Action-Center Roll-out Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Add the standardized export `<ExportButton>` (PDF/Excel/CSV/Word + AI narrative) to all 9 Banking screens + 3 Action-Center screens, each via a screen-specific `ReportData` adapter.

**Architecture:** Pure repetition of the proven P1 pilot pattern (one `*ReportAdapter.ts` + an `<ExportButton>` in the page header). The framework (`@/lib/export/*`, `@/components/export/ExportButton`) is done + on main and is NOT modified. ADDITIVE ONLY — no existing render, fetch, prop, route, or test expectation on any page changes.

**Tech Stack:** TypeScript, React, vitest. No new deps.

**Spec:** `docs/superpowers/specs/2026-06-13-enterprise-report-export-framework-design.md` (§"EXPORT ACTION" screen list).

---

## The proven pattern (reference — from P1 Slice D)

Each screen gets:
1. A new `<page-dir>/<name>ReportAdapter.ts` exporting a pure `build<Name>ReportData(src, config) → ReportData` that maps the page's already-fetched data into the `ReportData` contract from `@/lib/export/types`. It has a unit test asserting shape + record_count + a representative section.
2. An `<ExportButton module="..." reportType="..." adapter={() => build<Name>ReportData({...page data...}, ... )} />` placed in the page's existing header/actions area (a `PageHeader actions` slot if present), RBAC-gated (renders null without `reports:export` — so existing page tests that don't set `apex.ews.user` see no change).

### Worked adapter example (copy this structure for every screen)

```ts
// web/src/modules/<area>/<name>ReportAdapter.ts
import type { ReportData, ExportConfig } from '@/lib/export/types';

export interface <Name>ReportSource {
  rows: <RowShape>[];                 // the screen's primary tabular data
  meta: { tenant_id: string; generated_by: string; role: string };
  // + any summary/KPI scalars the page already has
}

export function build<Name>ReportData(src: <Name>ReportSource, config: ExportConfig): ReportData {
  const now = new Date().toISOString();
  return {
    report_type: '<type>',            // per the table below
    module: '<module-slug>',
    title: '<Human Title>',
    // subject only for single-entity pages (BorrowerTimeline); omit for list pages
    meta: {
      tenant_id: src.meta.tenant_id, generated_by: src.meta.generated_by, role: src.meta.role,
      generated_at: now, report_id: `EXP-${src.meta.tenant_id}-${Date.now()}`,
    },
    sections: {
      summary: [ /* page's headline scalars as {label,value} */ ],
      kpis: [ /* page's KPI cards as {label,value} */ ],
      tables: [{ name: '<Table Name>', columns: [...], rows: src.rows.map((r) => [ ...cells ]) }],
    },
    record_count: src.rows.length,
  };
}
```

Adapter unit test (copy structure):
```ts
import { describe, test, expect } from 'vitest';
import { build<Name>ReportData } from '@/modules/<area>/<name>ReportAdapter';
import { DEFAULT_INCLUDE, type ExportConfig } from '@/lib/export/types';

const config: ExportConfig = { formats: ['pdf'], report_type: '<type>', date_range: '30d', data_scope: 'complete', include: DEFAULT_INCLUDE };

describe('build<Name>ReportData', () => {
  test('maps page data into ReportData', () => {
    const data = build<Name>ReportData({ rows: [/* 1-2 sample rows */], meta: { tenant_id: 'BANK_DEMO', generated_by: 'a', role: 'admin' } }, config);
    expect(data.report_type).toBe('<type>');
    expect(data.meta.report_id).toMatch(/^EXP-/);
    expect(data.sections.tables?.[0].rows).toHaveLength(<n>);
    expect(data.record_count).toBe(<n>);
  });
});
```

### Wiring recipe (additive — into each page)
- `import { ExportButton } from '@/components/export/ExportButton';` + `import { build<Name>ReportData } from './<name>ReportAdapter';`
- Find the page's `<PageHeader ... />`. If it has an `actions` prop, add `<ExportButton/>` there (wrap existing actions in a fragment if needed). If `PageHeader` has no actions slot on that page, add the prop minimally OR place the button just under the header — DO NOT restructure.
- Feed the adapter the page's CURRENTLY-RENDERED / post-filter data (the same array the page's table/list uses), so the export respects active filters.
- `meta`: literals `{ tenant_id: 'BANK_DEMO', generated_by: 'operator', role: 'admin' }` are fine (BFF stamps authoritative tenant/actor); only use the auth store if the page already imports it.

**CRITICAL:** Before writing each page's wiring, READ the page to get the REAL variable names, the real row type, and the real PageHeader usage. The adapter input mapping must match the page's actual data shapes. If a page has no clean additive insertion point, report BLOCKED for that screen rather than restructuring.

---

## Per-screen table

| # | Screen | Page file | module slug | report_type |
|---|--------|-----------|-------------|-------------|
| **Batch 1 (customers/)** ||||
| 1 | Borrower Watch | `web/src/modules/customers/BorrowerWatchPage.tsx` | `borrower_watch` | `risk` |
| 2 | Account Behaviour | `web/src/modules/customers/AccountBehaviourPage.tsx` | `account_behaviour` | `risk` |
| 3 | Financial Ratios | `web/src/modules/customers/FinancialRatiosPage.tsx` | `financial_ratios` | `risk` |
| **Batch 2 (banking/)** ||||
| 4 | SMA Classification | `web/src/modules/banking/SmaClassificationPage.tsx` | `sma_classification` | `risk` |
| 5 | NPA Prediction | `web/src/modules/banking/NpaPredictionPage.tsx` | `npa_prediction` | `risk` |
| 6 | Fraud Signals | `web/src/modules/banking/FraudSignalsPage.tsx` | `fraud_signals` | `risk` |
| 7 | Sector Watch | `web/src/modules/banking/SectorWatchPage.tsx` | `sector_watch` | `portfolio` |
| 8 | Collections Risk | `web/src/modules/banking/CollectionsRiskPage.tsx` | `collections_risk` | `recovery` |
| 9 | Borrower Timeline | `web/src/modules/banking/BorrowerTimelinePage.tsx` | `borrower_timeline` | `customer` |
| **Batch 3 (action center)** ||||
| 10 | Cases | `web/src/modules/cms/CmsCaseListPage.tsx` | `cases` | `case` |
| 11 | Investigations | `web/src/modules/investigation/InvestigationCenterPage.tsx` | `investigations` | `case` |
| 12 | Recovery | `web/src/modules/admin/recovery/RecoveryCenterPage.tsx` | `recovery` | `recovery` |

---

## Task batches

Each batch = one implementer subagent. Within a batch, do each screen TDD-style: write the adapter unit test → run fail → write adapter → run pass → wire the button into the page → run that page's EXISTING test suite (no regression) → commit (one commit per screen, or one per batch — implementer's choice, local only).

- [ ] **Task A — Batch 1: BorrowerWatch + AccountBehaviour + FinancialRatios**
  - For each: read the page, build `*ReportAdapter.ts` + unit test, wire `<ExportButton>`, verify the page's existing test suite (`web/src/__tests__/<Page>.test.tsx` if it exists) still passes.
  - Verify: `cd web && npx vitest run src/__tests__/borrowerWatchReportAdapter.test.ts src/__tests__/accountBehaviourReportAdapter.test.ts src/__tests__/financialRatiosReportAdapter.test.ts` (+ any existing page suites for those 3) — green.
  - Commit. DO NOT push.

- [ ] **Task B — Batch 2: SMA + NPA + FraudSignals + SectorWatch + CollectionsRisk + BorrowerTimeline**
  - Same recipe ×6. BorrowerTimeline is a single-borrower page → set `subject={id,name}`.
  - Verify the 6 adapter tests + any existing page suites for those 6 — green.
  - Commit. DO NOT push.

- [ ] **Task C — Batch 3: Cases + Investigations + Recovery**
  - Cases: `CmsCaseListPage` — report the case rows (id/state/assignee/sla) the list renders.
  - Investigations: `InvestigationCenterPage` — investigation rows.
  - Recovery: `RecoveryCenterPage` — recovery rows.
  - Verify the 3 adapter tests + existing page suites — green.
  - Commit. DO NOT push.

---

## Final verification (P2)
- [ ] `cd web && npx vitest run` — FULL suite green (no regression across all ~150 files)
- [ ] `cd web && npx tsc --noEmit` — 0 new errors outside `src/mocks/handlers.ts`
- [ ] Spot check: each of the 12 pages renders an Export button for an admin user and the adapter produces a well-formed ReportData (covered by the 12 adapter unit tests).

## Self-Review notes
- **Spec coverage:** all 9 banking screens (table rows 1-9) + 3 action-center screens (rows 10-12) get the export button. Customer 360 + Alerts already done in P1. Insurance + Compliance + Exec screens are P3 (out of scope here).
- **Placeholders:** the adapter code is a parameterized RECIPE + worked example, not literal per-screen code, because each page's real data shape must be read at implement time (the P1 Slice-D precedent proved implementers reconcile real var names reliably). Each screen still has a concrete deliverable: a tested adapter + an additive button. This is the correct granularity for 12 near-identical screens.
- **Type consistency:** every adapter returns the `ReportData` contract from `@/lib/export/types` (no re-declaration) and is consumed by the already-built `ExportButton`/`ExportModal`/generators unchanged.
- **Additive guarantee:** RBAC-gated button renders null in existing page tests (which don't set `apex.ews.user`), so no existing assertion changes — same mechanism that kept P1 Slice D regression-free.
