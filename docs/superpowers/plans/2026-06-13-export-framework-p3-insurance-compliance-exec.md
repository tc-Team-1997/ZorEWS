# Export Framework P3 — Insurance + Compliance + Executive Roll-out Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Add the standardized export `<ExportButton>` (PDF/Excel/CSV/Word + AI narrative) to the 7 Insurance + 2 Compliance + 2 Executive screens, each via a screen-specific `ReportData` adapter.

**Architecture:** Identical to the proven P2 pattern (one `*ReportAdapter.ts` + an `<ExportButton>` in the page header). The framework is done + on main and is NOT modified. ADDITIVE ONLY — no existing render/fetch/prop/route/test changes. The RBAC-gated button renders null without `reports:export`, so existing page suites (most of these screens HAVE one) stay green with zero changed assertions.

**Tech Stack:** TypeScript, React, vitest. No new deps.

**Spec:** `docs/superpowers/specs/2026-06-13-enterprise-report-export-framework-design.md` (Insurance / Compliance / Executive screen lists). **Recipe + worked example:** reuse the adapter recipe, unit-test structure, and wiring recipe from `docs/superpowers/plans/2026-06-13-export-framework-p2-banking-rollout.md` (P2) verbatim — P3 is the same pattern on different screens.

---

## Reference (mirror exactly — committed in P2)
- Adapter + test: `web/src/modules/banking/collectionsRiskReportAdapter.ts` + `web/src/__tests__/collectionsRiskReportAdapter.test.ts`.
- Single-subject adapter (sets `subject`): `web/src/modules/banking/borrowerTimelineReportAdapter.ts`.
- Wiring into a `PageHeader actions` slot: `web/src/modules/banking/CollectionsRiskPage.tsx`.
- Multi-panel / no-single-list page handling: `web/src/modules/admin/recovery/recoveryReportAdapter.ts` (exported the page's representative rendered data + KPI strip).

## Per-screen table

| # | Screen | Page file | adapter file (next to page) | module slug | report_type |
|---|--------|-----------|------------------------------|-------------|-------------|
| **Batch 1 — Insurance A** |||||
| 1 | Policy Lapse | `web/src/modules/insurance/PolicyLapsePage.tsx` | `policyLapseReportAdapter.ts` | `policy_lapse` | `risk` |
| 2 | Claims Anomaly | `web/src/modules/insurance/ClaimsAnomalyPage.tsx` | `claimsAnomalyReportAdapter.ts` | `claims_anomaly` | `risk` |
| 3 | Fraud Detection | `web/src/modules/insurance/FraudDetectionPage.tsx` | `fraudDetectionReportAdapter.ts` | `fraud_detection` | `risk` |
| 4 | Underwriting | `web/src/modules/insurance/UnderwritingDeviationPage.tsx` | `underwritingReportAdapter.ts` | `underwriting` | `risk` |
| **Batch 2 — Insurance B** |||||
| 5 | Solvency | `web/src/modules/insurance/SolvencyWatchPage.tsx` | `solvencyReportAdapter.ts` | `solvency` | `compliance` |
| 6 | Persistency | `web/src/modules/insurance/PersistencyWatchPage.tsx` | `persistencyReportAdapter.ts` | `persistency` | `portfolio` |
| 7 | Channel Risk | `web/src/modules/insurance/ChannelRiskPage.tsx` | `channelRiskReportAdapter.ts` | `channel_risk` | `risk` |
| **Batch 3 — Compliance + Executive** |||||
| 8 | Regulatory Center | `web/src/modules/regulatory/RegulatoryComplianceCenterPage.tsx` | `regulatoryReportAdapter.ts` | `regulatory_center` | `compliance` |
| 9 | Audit Center | `web/src/modules/admin/audit/AuditCenterPage.tsx` | `auditCenterReportAdapter.ts` | `audit_center` | `compliance` |
| 10 | Executive Dashboard | `web/src/modules/dashboard/DashboardPage.tsx` | `dashboardReportAdapter.ts` | `executive_dashboard` | `executive` |
| 11 | Executive Risk Cockpit | `web/src/modules/executive/ExecutiveCockpitPage.tsx` | `executiveCockpitReportAdapter.ts` | `executive_cockpit` | `executive` |

Notes:
- Screens 10-11 (Dashboard, Cockpit) are large composed multi-panel pages with no single primary table — follow the `recoveryReportAdapter` precedent: export the page's headline KPIs as `kpis`/`summary` + the most representative list the page renders (e.g. the portfolio/risk-trend rows or top-alerts list) as the primary table. Note your choice in the report.
- Audit Center (screen 9) renders an audit-event list — export those rows.

## Per screen (TDD) — same as P2
1. READ the page → primary rendered/post-filter data array + row type + KPI/summary scalars + `<PageHeader>` usage (`actions` slot present?).
2. Write adapter unit test (`web/src/__tests__/<name>ReportAdapter.test.ts`): assert `report_type`, `EXP-` report_id, primary table row count, `record_count`.
3. Run → fail. 4. Write `<name>ReportAdapter.ts` (imports `ReportData`/`ExportConfig` from `@/lib/export/types`; NO type re-declaration). 5. Run → pass.
6. Wire `<ExportButton module="..." reportType="..." adapter={() => build<Name>ReportData({...real page data...}, config)} />` into the page's header actions (additive; add the `actions` prop minimally if absent; do NOT restructure a composed dashboard/cockpit shell — place the button in the page's top header/toolbar).
7. Run the page's EXISTING test suite (most of these have one — e.g. `PolicyLapsePage.test.tsx`, `ClaimsAnomalyPage.test.tsx`, `FraudDetectionPage.test.tsx`, `UnderwritingDeviationPage.test.tsx`, `SolvencyWatchPage.test.tsx`, `PersistencyWatchPage.test.tsx`, `ChannelRiskPage.test.tsx`, `RegulatoryComplianceCenter.test.tsx`, `AuditCenterPage.test.tsx`, `DashboardPage.test.tsx` + `DashboardClickable.test.tsx`, `ExecutiveCockpit.test.tsx`) → confirm green.

## Adapt, don't guess
Adapter input MUST match each page's real shapes (read the page). `meta` literals `{ tenant_id: 'BANK_DEMO', generated_by: 'operator', role: 'admin' }` are fine (BFF stamps authoritative tenant/actor); use the auth store only if the page already imports it. If a page has no clean additive insertion point, report that screen BLOCKED rather than restructuring.

## Commits
One commit per screen or one per batch, local only. **DO NOT `git push`** — controller pushes once at the end.

## Task batches
- [ ] **Task A — Batch 1 (Insurance A):** PolicyLapse, ClaimsAnomaly, FraudDetection, Underwriting. Verify the 4 adapter tests + the 4 existing page suites green. tsc 0 new errors. Commit.
- [ ] **Task B — Batch 2 (Insurance B):** Solvency, Persistency, ChannelRisk. Verify 3 adapter tests + 3 page suites. Commit.
- [ ] **Task C — Batch 3 (Compliance + Executive):** RegulatoryCenter, AuditCenter, Dashboard, ExecutiveCockpit. Verify 4 adapter tests + the existing page suites (Dashboard has DashboardPage.test + DashboardClickable.test; Executive has ExecutiveCockpit.test). Commit.

## Final verification (P3)
- [ ] `cd web && npx vitest run` — FULL suite green (no regression across all files); some heavy pages may timeout-flake under parallel load — re-run any flagged file in isolation to confirm pass.
- [ ] `cd web && npx tsc --noEmit 2>&1 | grep "error TS" | grep -vc "mocks/handlers.ts"` — prints `0`.
- [ ] All 11 `*ReportAdapter.test.ts` present + green.

## Self-Review notes
- **Spec coverage:** 7 insurance + 2 compliance + 2 executive screens (the full P3 screen list). With P1 (Customer 360, Alerts) + P2 (9 banking + 3 action-center), this completes EVERY screen in the spec's "EXPORT ACTION" list.
- **Placeholders:** parameterized recipe + worked P2 references (not literal per-screen code) because each page's real data shape is read at implement time — same correct granularity as P2, which shipped clean.
- **Type consistency:** every adapter returns the `ReportData` contract from `@/lib/export/types`; consumed unchanged by the built ExportButton/ExportModal/generators.
- **Additive guarantee:** RBAC-gated button renders null in existing page suites (which don't set `apex.ews.user`) — zero changed assertions, same mechanism proven across P1+P2.
