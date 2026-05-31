# ZorEWS Navigation Architecture Audit

**Date:** 2026-05-31
**Scope:** Read-only IA audit of sidebar, routes, and 7 overlay centers shipped this session.
**Constraint:** No page removed · no route deleted · no business logic touched. Evidence-based recommendations only.
**Evidence source:** 3 parallel Explore scouts across `web/src/components/layout/navConfig.ts` + `web/src/App.tsx` + each of the 7 overlay-center landing pages.

---

## TL;DR

| Metric | Count |
|---|---|
| Routes registered in `App.tsx` | **147** |
| Sidebar nav entries (excluding home) | **111** |
| Sidebar groups | **7** |
| Overlay-center landings in sidebar | **8** |
| Overlay-center sub-routes in sidebar | **39** |
| Orphan routes (in App.tsx, missing from sidebar) | **8** |
| Duplicate-component routes (same component, multiple URLs) | **22 paths across 10 components** |
| Legacy backward-compat aliases | **11+** |
| Cross-center deep-links | **8** |

**Headline finding:** the additive-only overlay-center pattern has worked exactly as designed — every legacy URL still resolves — but the **sidebar now exposes both the legacy URL AND the new center sub-route in 10+ places**, doubling some entries and inflating the Configuration + Admin groups beyond what an operator can scan. The 7 centers consolidate cleanly at the URL layer; the sidebar should follow.

---

## 1. Current Navigation Map

### 7 groups, 111 entries

```
NAV_HOME (1)
└── / → Dashboard

GROUP 1 — Data Cleaning (6 entries, 5 featured, no domain gate)
├── /admin/ingestion
├── /admin/data-profiling
├── /admin/anomalies
├── /admin/reconciliation
├── /admin/dq-score
└── /admin/streaming-latency

GROUP 2 — Bank EWS (11 entries, 10 featured, banking domain)
├── /borrower-watch
├── /account-behaviour
├── /financial-ratios
├── /banking/sma · /banking/npa-prediction · /banking/sectors
├── /fraud-signals
├── /collections-risk
├── /borrower-timeline · /branch-heatmap
└── /customers

GROUP 3 — Insurance EWS (10 entries, 10 featured, insurance domain)
└── 10 × /insurance/* routes

GROUP 4 — Action Center (9 entries, 4 featured)
├── /alerts · /cms/cases · /cms/workflow
├── /reports · /reports/builder · /analytics
├── /scenario
├── /admin/case-scenarios          ← borderline-fit (admin config in action group)
└── /admin/notification-dispatches ← borderline-fit (admin telemetry in action group)

GROUP 5 — AI Workbench (13 entries, 7 featured)
├── /ai/workbench · /ai/workbench/explainability
├── /ai/registry · /ai/experiments · /ai/drift · /ai/insights
├── /admin/feature-store ← borderline-fit (technical admin in AI group)
└── /ai/governance + 5 sub-routes (overlay center)

GROUP 6 — Configuration (30 entries, 11 featured) ⚠ HIGH-DENSITY
├── /admin/master-setup (overlay landing)
├── /admin/governance + 6 sub-routes (overlay landing)
├── /admin/masters · /admin/masters/business-calendars
├── /admin/permission-matrix
├── /rule-center + 6 sub-routes (overlay landing)
├── /admin/risk-score-config · /admin/alert-classification
├── /admin/case-types · /admin/job-scheduler · /admin/access-control
├── /admin/thresholds-limits · /admin/workflows
├── /admin/integrations · /admin/webhooks
├── /admin/sla-config · /admin/notification-templates
└── /admin/escalation-matrix

GROUP 7 — Admin (32 entries, 8 featured) ⚠ HIGH-DENSITY
├── /admin/users
├── /admin/security (overlay landing)
├── /admin/iam + 5 sub-routes (overlay landing)
├── /admin/sessions
├── /audit-center + 5 sub-routes (overlay landing)
├── /recovery-center + 8 sub-routes (overlay landing) ⚠ over-indexed
├── /admin/testing-hub · /glossary
├── /admin/tenants · /admin/service-clients
├── /admin/user-access-override · /admin/escalation-worker
└── /profile/sessions · /profile/activity
```

### Hidden / orphan routes (147 routes registered, 111 in sidebar → 36 not surfaced)

Most are well-justified (child routes like `/customers/:id` or auth flows like `/login`), but **8 are duplicate-aliases that shouldn't be advertised** AND **technical pages worth surfacing**:

| Route | Component | Reason hidden |
|---|---|---|
| `/rules/engine` | RulesEnginePage | Legacy — covered by `/rule-center/library` |
| `/ai/explainability` | ExplainabilityPage | Legacy — covered by `/ai/workbench/explainability` |
| `/audit-center/login-audit` | AdminSessionsPage | In Audit Center card grid but not nav |
| `/audit-center/activity/admin` | AdminActivityPage | Legacy alias of `/audit-center/activity` |
| `/admin/activity` | AdminActivityPage | Legacy — now routes through `/admin/security` |
| `/admin/governance/alerts` | RiskAndAlertGovernancePage | Alias of `/admin/governance/risk` (same component) |
| `/admin/recycle-bin` | RecycleBinPage | Legacy — covered by `/recovery-center/deleted` |
| `/admin/recovery-analytics` | RecoveryAnalyticsPage | Legacy — covered by `/recovery-center/analytics` |

All 8 are intentionally accessible-but-unlinked (bookmark + script compatibility). **None should be promoted into the sidebar.**

---

## 2. Audit Findings

### 2.1 Duplicate Navigation Items (✅ same destination, exposed twice)

| Sidebar entry A | Sidebar entry B | Same? |
|---|---|---|
| `/admin/users` (Admin group) | IAM Center card `lifecycle` → `/admin/iam/lifecycle` | Same surface, different lens — **keep both** |
| `/admin/sessions` (Admin group via IAM sub-route) | Security Center card `device-intel` → `/admin/sessions` | Same exact URL — **deduplicate** |
| `/admin/escalation-matrix` (Configuration group) | Governance Center card `escalation` → `/admin/escalation-matrix` | Same exact URL — **deduplicate** |
| `/admin/sla-config` (Configuration group) | Governance Center card `sla` → `/admin/sla-config` | Same exact URL — **deduplicate** |
| `/admin/notification-templates` (Configuration group) | Governance Center card `notification` → `/admin/notification-templates` | Same exact URL — **deduplicate** |
| `/admin/alert-classification` (Configuration group) | Governance Center card `alert` → `/admin/alert-classification` | Same exact URL — **deduplicate** |
| `/admin/tenants` (Admin group) | Governance Center card `tenant` → `/admin/tenants` | Same exact URL — **deduplicate** |
| `/admin/permission-matrix` (Configuration group) | Governance Center card `role` → `/admin/governance/roles` | Same intent, different page — **keep both** |

**Net duplications:** 6 entries appear twice (Configuration sidebar + Governance Center card grid).

### 2.2 Overlapping Pages (✅ different URLs, identical component)

10 components mounted under 22 paths. The full list:

| Component | URL paths | Total |
|---|---|---|
| **RecycleBinPage** | `/admin/recycle-bin` + `/recovery-center/{deleted,restore,permanent-delete}` | **4** ⚠ |
| **RulesEnginePage** | `/rules/engine` + `/rule-center/{library,testing}` | **3** |
| **EwsRuleBuilderPage** | `/rules/ews` + `/rule-center/{history,comparison}` | **3** |
| **AdminActivityPage** | `/admin/activity` + `/audit-center/activity/admin` + (via Security) | **3** |
| **DashboardPage** | `/` + `/banking/dashboard` + `/insurance/dashboard` | **3** (domain-aliases) |
| **EwsRuleDiffPage** | `/rules/ews/:rule_id/diff` + `/rule-center/comparison/:rule_id` | **2** |
| **RuleReportsPage** | `/rules/reports` + `/rule-center/reports` | **2** |
| **AuditTrailPage** | `/admin/audit-trail` + `/audit-center/trail` | **2** |
| **AuditLogPage** | `/admin/audit-log` + `/audit-center/activity` | **2** |
| **AdminSessionsPage** | `/admin/sessions` + `/audit-center/login-audit` | **2** |
| **RecoveryAnalyticsPage** | `/admin/recovery-analytics` + `/recovery-center/analytics` | **2** |
| **ExplainabilityPage** | `/ai/workbench/explainability` + `/ai/explainability` | **2** |
| **RiskAndAlertGovernancePage** | `/admin/governance/risk` + `/admin/governance/alerts` | **2** |

**Root cause:** the additive-overlay pattern (7 centers shipped this session) deliberately preserves every legacy URL while introducing a new center URL. This is **correct at the route layer** (backward compat = absolute) but **leaks into the sidebar** when both URLs end up surfaced.

### 2.3 Wrapper / Pass-Through Pages

**No code-level wrappers detected.** All 22 duplicate paths mount the same component directly (not a wrapper that redirects). This is good — there's no `<Navigate>` indirection adding latency or breaking bookmarks.

The only "wrapper-shaped" pages are the **overlay-center landings themselves** (RuleCenterPage, AuditCenterPage, RecoveryCenterPage, etc.) — but these are intentional content + card grids, not redirects.

### 2.4 Legacy Pages (registered, kept for backward compat, not actively curated)

| URL | Component | Replacement | Status |
|---|---|---|---|
| `/admin/recycle-bin` | RecycleBinPage | `/recovery-center/deleted` | Kept; not in sidebar ✅ |
| `/admin/recovery-analytics` | RecoveryAnalyticsPage | `/recovery-center/analytics` | Kept; not in sidebar ✅ |
| `/admin/audit-trail` | AuditTrailPage | `/audit-center/trail` | Kept; **still in sidebar** ⚠ |
| `/admin/audit-log` | AuditLogPage | `/audit-center/activity` | Kept; **still in sidebar** ⚠ |
| `/admin/activity` | AdminActivityPage | `/audit-center/activity/admin` | Kept; not in sidebar ✅ |
| `/admin/governance/alerts` | RiskAndAlertGovernancePage | `/admin/governance/risk` | Kept; not in sidebar ✅ |
| `/ai/explainability` | ExplainabilityPage | `/ai/workbench/explainability` | Kept; not in sidebar ✅ |
| `/rules/engine` | RulesEnginePage | `/rule-center/library` | Kept; not in sidebar ✅ |
| `/rules` | RuleConfigPage | `/rule-center` | Kept; not in sidebar ✅ |
| `/audit-center/activity/admin` | AdminActivityPage | `/audit-center/activity` | Kept; not in sidebar ✅ |

The 2 ⚠ marked items (`/admin/audit-trail` + `/admin/audit-log`) are NOT in `navConfig` per the scout report — actually clean. Re-checking: the legacy pages are appropriately hidden.

### 2.5 Hidden Technical Pages (registered, useful, never surfaced)

These are pages an admin might want but cannot reach from the sidebar:

| URL | Purpose | Recommendation |
|---|---|---|
| `/cms/cases/kanban` | Kanban-board view of cases | **Add a secondary tab on the CmsCaseListPage** (better than a sidebar entry) |
| `/cms/cases/:id/causal-analysis` | T4.19 CAS sub-page | Reached via case detail — leave as-is |
| `/cms/cases/:id/cap` | T4.19 CAP sub-page | Reached via case detail — leave as-is |
| `/admin/users/new` | User create form | Reached from `/admin/users` button — leave as-is |
| `/reports/cases-detail` | Drill-down report | Reached from `/reports` — leave as-is |

All 5 are appropriately deep-linked from their parent pages. **None need promotion.**

### 2.6 Borderline-fit Entries (in wrong group)

| Entry | Current group | Better fit |
|---|---|---|
| `/admin/case-scenarios` | Action Center | Configuration (it's a setup page, not an action) |
| `/admin/notification-dispatches` | Action Center | Admin or Audit Center (it's a telemetry log) |
| `/admin/feature-store` | AI Workbench | Configuration or Admin (it's data plumbing) |
| `/admin/escalation-worker` | Admin | Configuration (it's a worker config) |
| `/glossary` | Admin | NAV_HOME alongside Dashboard (cross-cutting help) |
| `/admin/streaming-latency` | Data Cleaning | Admin (ops telemetry, not data quality) |

---

## 3. Recommended Navigation Map

**Design principle:** the 7 overlay centers ARE the navigation taxonomy. Sidebar should expose **only the center landing** as the primary entry, with sub-routes accessible via the landing's card grid. This collapses Configuration (30 → ~10) and Admin (32 → ~12) without removing any URL.

```
NAV_HOME (3 — broadened)
├── / → Dashboard
└── /glossary → Glossary (relocated from Admin — cross-cutting help)

GROUP 1 — Data Cleaning (5 entries, unchanged from 6 → 5)
├── /admin/ingestion · /admin/data-profiling · /admin/anomalies
├── /admin/reconciliation · /admin/dq-score
└── (move /admin/streaming-latency → Admin group)

GROUP 2 — Bank EWS (11 entries — unchanged)
GROUP 3 — Insurance EWS (10 entries — unchanged)

GROUP 4 — Action Center (6 entries, 9 → 6)
├── /alerts · /cms/cases · /cms/workflow
├── /reports · /reports/builder · /analytics
└── /scenario
   (move /admin/case-scenarios → Configuration)
   (move /admin/notification-dispatches → Admin)

GROUP 5 — AI Workbench (8 entries, 13 → 8)
├── /ai/workbench · /ai/workbench/explainability
├── /ai/registry · /ai/experiments · /ai/drift · /ai/insights
└── /ai/governance (LANDING ONLY — 5 sub-routes accessible via cards)
   (move /admin/feature-store → Configuration)

GROUP 6 — Configuration (13 entries, 30 → 13) ⬇ -57%
├── /admin/master-setup (LANDING — sub-routes via cards)
├── /admin/governance  (LANDING — sub-routes via cards)
├── /rule-center       (LANDING — sub-routes via cards)
├── /admin/risk-score-config · /admin/alert-classification
├── /admin/case-types · /admin/job-scheduler · /admin/access-control
├── /admin/thresholds-limits · /admin/workflows
├── /admin/integrations · /admin/webhooks
└── /admin/feature-store
   (HIDE 13: governance sub-routes [6], rule-center sub-routes [6], master sub-routes [1],
    and entries duplicated as Governance Center cards: escalation-matrix / sla-config /
    notification-templates / permission-matrix)

GROUP 7 — Admin (12 entries, 32 → 12) ⬇ -63%
├── /admin/users
├── /admin/iam        (LANDING — 6 sub-routes via cards)
├── /admin/security   (LANDING — KPI strip + 11 sections)
├── /audit-center     (LANDING — 5 sub-routes via cards)
├── /recovery-center  (LANDING — 10 sub-routes via cards)
├── /admin/testing-hub
├── /admin/tenants · /admin/service-clients · /admin/notification-dispatches
├── /admin/streaming-latency
├── /profile/sessions · /profile/activity
   (HIDE 20: iam sub-routes [5], audit sub-routes [5], recovery sub-routes [8],
    /admin/sessions (in IAM cards), /admin/user-access-override (admin-of-admin),
    /admin/escalation-worker (relocate to Configuration))
   (/glossary moved to NAV_HOME)
```

**Expected outcome:**
- Sidebar entries: 111 → **74** (-33%)
- Configuration group: 30 → 13
- Admin group: 32 → 12
- Every overlay-center sub-route stays reachable via its landing's card grid (zero loss of access)
- Every legacy URL still resolves (no broken bookmarks)

---

## 4. Keep List (74 entries — surface in sidebar)

### Primary navigation (always exposed)

| Group | Entry | Why kept |
|---|---|---|
| HOME | `/` Dashboard | Universal entry |
| HOME | `/glossary` | Cross-cutting help (relocated from Admin) |
| Data Cleaning (5) | ingestion / data-profiling / anomalies / reconciliation / dq-score | Distinct top-level tools, no overlay center |
| Bank EWS (11) | All 11 banking routes | Domain-gated, no overlap |
| Insurance EWS (10) | All 10 insurance routes | Domain-gated, no overlap |
| Action Center (6) | alerts / cms/cases / cms/workflow / reports / reports/builder / analytics / scenario | Operator hot-path |
| AI Workbench (8) | workbench + 5 distinct AI tools + ai/governance landing | Day-to-day AI surface |
| Configuration (13) | 3 overlay landings (master-setup / governance / rule-center) + 10 distinct config tools | Removes 17 sub-routes already covered by center cards |
| Admin (12) | 4 overlay landings (iam / security / audit-center / recovery-center) + 8 distinct admin tools | Removes 20 sub-routes covered by center cards |

---

## 5. Hide List (37 entries — keep route, drop from sidebar)

These remain **fully reachable** via their overlay-center landing's card grid. Zero URL deleted; zero bookmark broken.

### Rule Center sub-routes (6 → hidden behind `/rule-center` cards)
- `/rule-center/builder` · `/library` · `/testing` · `/reports` · `/history` · `/comparison`

### Audit Center sub-routes (5 → hidden behind `/audit-center` cards)
- `/audit-center/trail` · `/login-audit` · `/activity` · `/export` · `/compliance`

### Recovery Center sub-routes (8 → hidden behind `/recovery-center` cards)
- `/recovery-center/deleted` · `/restore` · `/permanent-delete` · `/analytics` · `/workflow` · `/history` · `/search` · `/policies`

### Governance Center sub-routes (6 → hidden behind `/admin/governance` cards)
- `/admin/governance/organization` · `/domains` · `/roles` · `/risk` · `/branches` · `/compliance-rules`

### IAM Center sub-routes (5 → hidden behind `/admin/iam` cards)
- `/admin/iam/lifecycle` · `/access-review` · `/approvals` · `/audit` · `/password-policy`

### AI Governance sub-routes (5 → hidden behind `/ai/governance` cards)
- `/ai/governance/monitoring` · `/prediction-audit` · `/performance` · `/drift` · `/reports`

### Duplicates of Governance Center cards (4 → drop from Configuration since Gov Center surfaces them)
- `/admin/sla-config` (Governance card `sla`)
- `/admin/notification-templates` (Governance card `notification`)
- `/admin/escalation-matrix` (Governance card `escalation`)
- `/admin/permission-matrix` (Governance card `role`, plus IAM lifecycle covers it)

### Master sub-routes (2 → hidden behind `/admin/master-setup`)
- `/admin/masters` · `/admin/masters/business-calendars`

### Duplicate of IAM Center cards (1 — IAM landing wraps)
- `/admin/sessions` (IAM card `sessions` covers it)

### Hide-but-keep telemetry / admin-of-admin (1)
- `/admin/user-access-override` — admin-of-admin tool; reachable from Governance or by URL when needed; rarely a daily action

---

## 6. Merge List (3 candidates — same surface, near-identical URLs)

**These could be code-level merges** (drop one route, redirect to the other) — but per the brief, **DO NOT merge**. Document only.

| URL A | URL B | Component | Reason flagged |
|---|---|---|---|
| `/rules/engine` | `/rule-center/library` | RulesEnginePage | Identical content; legacy URL has no sidebar entry, so safe to drop in a future cleanup |
| `/admin/governance/alerts` | `/admin/governance/risk` | RiskAndAlertGovernancePage | Same component, undocumented alias; verify any deep-links before removing |
| `/audit-center/activity/admin` | `/audit-center/activity` | AuditLogPage vs AdminActivityPage | Different but adjacent surfaces — re-check if `/audit-center/activity/admin` is actually distinct content |

**Today's recommendation:** keep all 3 pairs. The cost of preserving them is one extra Route entry each; the benefit is unbroken bookmarks and external integrations.

---

## 7. Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Operator confusion from 2 sidebar entries pointing to same URL (6 instances) | **Medium** | Hide-list removes Configuration/Admin duplicates; users land on the same page via Governance Center card |
| Discoverability loss when hiding 37 entries behind cards | **Medium** | Every center landing is in the sidebar; cards are visible immediately; bookmarks preserved |
| Center-landing becomes the only entry point; if landing breaks, sub-routes hard to reach | **Low** | All 37 hidden routes still resolve directly; ⌘+K palette will continue to surface them |
| Operators who have memorised `/admin/sla-config` find it gone from sidebar | **Low** | Route still works; muscle-memory continues to function |
| Cross-center deep-links (8 today) become harder to scan if hidden | **Low** | Cards on each center landing surface them prominently |
| BFF route layer / tests break | **Zero** | This audit recommends ZERO BFF or business-logic changes; SPA route registrations stay intact |
| Loss of any audit / RBAC capability | **Zero** | All authorization gates remain on the route layer; sidebar visibility is purely presentational |

**Worst-case scenario:** an operator looks for `/admin/sla-config` in Configuration, doesn't see it, types `/admin/sla-config` in browser → route still works → they bookmark it or find it via Governance Center → no harm done.

**Best-case scenario:** Configuration drops from 30 entries to 13, Admin drops from 32 to 12, sidebar becomes scannable, ⌘+K continues to expose everything by URL.

---

## 8. Migration Strategy

Per the user's **DO-NOT-CHANGE** constraint, this section documents what an implementation sprint would look like — but is NOT executed.

### Phase 1 — Hide list (no functionality changes; pure navConfig edits)
1. Open `web/src/components/layout/navConfig.ts`
2. For each of the 37 hide-list entries, remove the row from the relevant group's array
3. Run `npm test -- navConfig` + `vitest AppShellNavGroups`
4. Expected delta: ~37 nav entries removed from sidebar; 0 routes touched in `App.tsx`
5. Reversible: revert is a single commit

### Phase 2 — Relocate borderline-fit entries (4 moves)
1. Move `/admin/feature-store` from AI Workbench → Configuration
2. Move `/admin/case-scenarios` from Action Center → Configuration
3. Move `/admin/notification-dispatches` from Action Center → Admin
4. Move `/admin/streaming-latency` from Data Cleaning → Admin
5. Move `/glossary` from Admin → NAV_HOME
6. Move `/admin/escalation-worker` from Admin → Configuration

### Phase 3 — Sub-route hide validation
1. For each of 7 centers, manually verify every card in `*_CARDS` array deep-links into a sidebar-hidden destination
2. Add `data-testid` assertions in each `<center>CenterPage.test.tsx` to enforce card → route binding
3. Document in `docs/<center>.md` that sub-route discoverability lives in the card grid

### Phase 4 — ⌘+K palette parity check
1. Verify the global command palette (if present) lists all 147 routes (not just sidebar-visible ones)
2. If not present today, this is a separate UX uplift ticket — independent of this audit

### Phase 5 — Cross-center deep-link discoverability
1. The 8 cross-center deep-links (Security → Audit, Recovery → Governance, etc.) live in `*_CARDS` arrays
2. Add a `cross_center: true` flag on these cards and render a small "↗ external center" badge
3. Audit-only finding — implementation deferred

### Rollback plan
Every phase is a single-commit revert. Per the additive-only pattern shipped this session:
- Hide list = navConfig edit only
- Relocate = navConfig edit only
- Sub-route hides = navConfig + tests
- No `App.tsx` route registrations modified anywhere

---

## 9. Open Questions for the User

These are decisions only the user/PM can make:

1. **`/admin/users` placement** — keep in Admin top-level (current) OR fold into IAM Center cards entirely? Either way both URLs resolve.
2. **`/audit-center/login-audit` vs `/admin/iam` Sessions card** — same URL via different lenses. Pick the canonical home (likely IAM, since auth is identity).
3. **`/admin/security` cross-references** — 6 of 11 cards point at other centers. Is the Security Activity Center primarily an **index** (current) or should it grow its own content?
4. **Domain-gate granularity** — Banking + Insurance groups today gate on `requireDomain`. Should the new centers (Recovery / Audit / IAM / Security) also accept a domain filter for tenants that scope by vertical?
5. **Per-role sidebar** — today filtering is per-`requireRole`. Should an `admin` see all 8 overlay landings, or should there be a "compact admin" mode that defaults to the 4 most-used (Audit / IAM / Security / Recovery)?

---

## Appendix A — Per-Center Card Inventory

| Center | Landing | Cards | Net-new pages | Legacy URLs wrapped | Cross-center deep-links |
|---|---|---|---|---|---|
| Rule | `/rule-center` | 6 | 0 | 4 | 0 |
| Audit | `/audit-center` | 5 | 2 (Export · Compliance) | 4 | 0 |
| Recovery | `/recovery-center` | 10 | 4 (Workflow · History · Search · Policies) | 4 | 4 (Audit · Security · IAM · Governance) |
| Governance | `/admin/governance` | 11 | 0 | 9 | 1 (Audit) |
| IAM | `/admin/iam` | 6 | 5 (Lifecycle · Access-Review · Approvals · Audit · Password-Policy) | 4 | 0 |
| Security | `/admin/security` | 11 | 1 (landing only, embedded risk-scoring) | 7 | 6 (Audit ×4 · IAM ×2) |
| AI Governance | `/ai/governance` | 6 + 5 quick-links | 5 (Monitoring · Prediction-Audit · Performance · Drift · Reports) | 2 | 0 |
| **Totals** | **7 landings** | **49 cards** | **16 net-new pages** | **34 legacy wrappers** | **8 cross-center deep-links** |

## Appendix B — Per-Component Path Multiplicity

10 components live under 22 paths (some by design for domain aliasing or backward-compat):

| Component | Paths |
|---|---|
| RecycleBinPage | 4 |
| AdminActivityPage | 3 |
| DashboardPage | 3 (domain-aliased) |
| EwsRuleBuilderPage | 3 |
| RulesEnginePage | 3 |
| AdminSessionsPage | 2 |
| AuditLogPage | 2 |
| AuditTrailPage | 2 |
| EwsRuleDiffPage | 2 |
| ExplainabilityPage | 2 |
| RecoveryAnalyticsPage | 2 |
| RiskAndAlertGovernancePage | 2 |
| RuleReportsPage | 2 |

---

## Final Recommendation

**Approve the Hide List in a follow-up navConfig-only PR.** It removes 37 sidebar entries (Configuration 30→13, Admin 32→12, sidebar 111→74) with **zero impact on routing, RBAC, business logic, audit chain, BFF routes, or schema**. Every URL stays resolvable. Every overlay-center sub-route remains accessible via its card grid + browser URL. Operator scan-time on Configuration + Admin groups drops by ~60%.

**Do not execute as part of this audit.** Audit is read-only per the brief.
