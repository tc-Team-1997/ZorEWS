# Enterprise Governance Center — architecture

**Status:** shipped 2026-05-31
**Owner:** agent-integration + agent-ui
**Companion docs:** [Rule Center](./rule-center-architecture.md) · [Audit + Recovery Centers](./audit-and-recovery-centers.md) · [AI Governance Layer](./ai-governance-layer.md) · [Enterprise IAM Layer](./enterprise-iam-layer.md)

## Problem

Master Setup (Phase 9 T11) ships a reusable CRUD framework for 9 master
entities (countries / departments / risk-categories / currencies / severity-
levels / case-types / case-priorities / regulatory-frameworks / channels)
backed by `app_iam.master_entities` + `app_iam.master_entity_rows`. The brief
asks to transform it into the **single source of truth for every platform
governance dimension** — 11 sections spanning organization, domain, tenant,
role, risk, alert, escalation, SLA, notification, business calendar, and
cross-section audit.

Most pieces already exist in the platform; what was missing is the
*consolidating governance UX* + the 2 genuinely-new master entities
(regions + business calendars) + the cross-section change ledger.

## Solution

Same proven additive-overlay pattern (5th this week after Rule / Audit /
AI Governance / IAM Centers). One **Governance Center** landing at
`/admin/governance` with 11 named sections, each linking to the existing
CRUD surface (8 of 11) or a new sub-landing (3 of 11). 2 net-new master
entities ride the T11 framework, picking up auto-CRUD + audit + permission
gates for free.

**Master Setup remains the canonical store.** Governance Center is purely
additive navigation + consolidation. Every legacy URL still resolves.

## Information architecture (11 sections)

| # | Section                  | URL                                       | Renders                                          | Status |
| - | ------------------------ | ----------------------------------------- | ------------------------------------------------ | ------ |
| 1 | Organization Governance  | `/admin/governance/organization`          | `OrganizationGovernancePage` (NEW)               | NEW    |
| 2 | Domain Governance        | `/admin/governance/domains`               | `DomainGovernancePage` (NEW)                     | NEW    |
| 3 | Tenant Governance        | `/admin/tenants`                          | `AdminTenantsPage` (existing)                    | wrap   |
| 4 | Role Governance          | `/admin/governance/roles`                 | `RoleGovernancePage` (NEW)                       | NEW    |
| 5 | Risk Governance          | `/admin/governance/risk`                  | `RiskAndAlertGovernancePage` (NEW)               | NEW    |
| 6 | Alert Governance         | `/admin/governance/alerts`                | `RiskAndAlertGovernancePage` (same page, second card group) | NEW |
| 7 | Escalation Governance    | `/admin/escalation-matrix`                | `EscalationMatrixPage` (existing)                | wrap   |
| 8 | SLA Governance           | `/admin/sla-config`                       | `SlaConfigPage` (existing)                       | wrap   |
| 9 | Notification Governance  | `/admin/notification-templates`           | `NotificationTemplatesPage` (existing)           | wrap   |
| 10| Business Calendar        | `/admin/masters/business-calendars`       | `MasterEntityPage` (existing CRUD framework) — backed by NEW master | NEW |
| 11| Governance Audit         | `/audit-center/activity`                  | Audit Center activity stream (existing)          | wrap   |

### Section 1 sub-tree (Organization Governance)
- Countries → `/admin/masters/countries` (T11)
- Regions → `/admin/masters/regions` (NEW T11 master)
- Branches → `/admin/governance/branches` (existing)
- Departments → `/admin/masters/departments` (T11)

### Section 5 + 6 sub-tree (Risk + Alert paired)
- Risk Categories → `/admin/masters/risk-categories` (T11)
- Severity Levels → `/admin/masters/severity-levels` (T11)
- Risk Score Config → `/admin/risk-score-config` (existing)
- Alert Classification → `/admin/alert-classification` (existing)

## React component structure

```
src/modules/admin/governance/
├── GovernanceCenterPage.tsx          (NEW landing — 11 cards)
├── OrganizationGovernancePage.tsx    (NEW — 4 cards: countries/regions/branches/depts)
├── DomainGovernancePage.tsx          (NEW — banking + insurance summary)
├── RoleGovernancePage.tsx            (NEW — 10 role templates + matrix link)
├── RiskAndAlertGovernancePage.tsx    (NEW — risk + alert master shortcuts)
├── BranchesPage.tsx                  (existing — untouched)
└── ComplianceRulesPage.tsx           (existing — untouched)

Existing pages reached through Governance Center wrappers (NO modification):
- AdminTenantsPage
- EscalationMatrixPage
- SlaConfigPage
- NotificationTemplatesPage
- AlertClassificationConfigPage
- MasterMenuPage / MasterEntityPage
- PermissionMatrixPage
```

## PostgreSQL schema

### T11 master registry (additive — `services/bff/src/masters/registry.ts`)

Two new master schemas appended to `MASTER_SCHEMAS`:

1. **`regions`** — tenant-scoped. Fields: code (≤32) · name (≤200) · country_code · parent_region · active. 4 IN-region seed rows.
2. **`business-calendars`** — tenant-scoped. Fields: code · name · country_code · domain (banking/insurance/shared enum) · working_days CSV (ISO Mon=1..Sun=7) · holidays_csv (YYYY-MM-DD, comma-sep) · active. 3 seed rows (IN banking 2026 / IN insurance 2026 / BT shared 2026).

Both pick up auto-CRUD via `/v1/master/:entity/*` routes + audit fan-out via the existing master_audit hook + RBAC gates via `module:master_setup` × T6 actions.

### Migration `data/schema/053_governance_calendars.sql` (idempotent)

Two new tables alongside the existing T11 substrate:

| Table                                       | Purpose                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `app_iam.business_calendar_holidays`        | Resolved per-tenant per-calendar holiday list. SLA + escalation business-day math queries this directly instead of re-parsing CSV. PK `(tenant_id, calendar_code, holiday_date)`. |
| `app_iam.governance_change_ledger`          | Cross-section governance change rollup. `section` closed enum (11 values matching the SPA cards). Distinct from T11 row-level master_audit and the M15 cryptographic chain — this is the governance-domain rollup for compliance reporting. |

CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS throughout. Re-runs are no-ops.

## REST APIs

**Zero new BFF route added at the governance layer.** The 2 new master
entities (regions + business-calendars) automatically expose the existing
T11 routes:

| Method | Path                                                    | Source                                  |
| ------ | ------------------------------------------------------- | --------------------------------------- |
| GET    | `/v1/master/regions/schema`                             | T11 framework                           |
| GET    | `/v1/master/regions`                                    | T11 framework                           |
| POST   | `/v1/master/regions`                                    | T11 framework                           |
| PUT    | `/v1/master/regions/:id`                                | T11 framework                           |
| DELETE | `/v1/master/regions/:id`                                | T11 framework                           |
| (same shape for business-calendars)                                                                              |
| GET    | `/v1/master/regions/audit`                              | T11 audit helper                        |
| GET    | `/v1/master/business-calendars/audit`                   | T11 audit helper                        |

Existing routes for the 8 wrapped sections (tenants, branches, escalation,
SLA, notifications, alert classification, RBAC, audit) keep their current
contracts — no shape change.

## RBAC mapping

**No new RBAC operations.** Governance Center reuses:

| Surface                                  | Required role(s)                | Backing scope                                |
| ---------------------------------------- | ------------------------------- | -------------------------------------------- |
| `/admin/governance` landing              | admin · supervisor              | SPA gate                                     |
| `/admin/governance/organization`         | admin · supervisor              | Read-only nav                                |
| `/admin/governance/domains`              | admin · supervisor              | Reads tenant list                            |
| `/admin/governance/roles`                | admin · supervisor              | Reads role catalog                           |
| `/admin/governance/risk` + `/alerts`     | admin · supervisor              | Read-only nav                                |
| Master CRUD (regions / business-calendars / countries / etc) | admin (existing T11) | `module:master_setup` × 7 actions             |
| Tenant Governance                        | admin                           | Existing AdminTenantsPage gate               |
| Escalation / SLA / Notification          | admin · supervisor              | Existing page gates                          |
| Permission Matrix Editor                 | admin                           | T6 enterprise layer                          |

The Section 4 (Role Governance) page links to the existing `/admin/rbac/permission-matrix` editor (T6) for actual matrix edits — Governance Center is the discovery surface, the existing editor remains the source-of-truth UI.

## Audit integration

Every governance edit fans out across three layers:

1. **T11 master_audit** — per-entity row-level history (existing). Surfaced via `GET /v1/master/:entity/audit`.
2. **`app_iam.governance_change_ledger`** — cross-section rollup with section + entity + actor + before/after JSONB + correlation_id. The Governance Center's Section 11 (Audit) deep-links into this via the existing Audit Center activity stream.
3. **M15 audit chain** — cryptographic anchor via the existing `audit_event_log.ts` bridge. Every governance change writes a chain row with `resource_type='config'` so it shows up in the M15.2 integrity check.

The `correlation_id` field groups multi-step governance operations (e.g. bulk
calendar import, role-template clone fanning out to N permission matrix
edits).

## Sidebar navigation

```
Administration
├── Master Setup                       /admin/master-setup       (existing)
├── Governance Center      [NEW]       /admin/governance         featured
│   ├── Organization                   /admin/governance/organization
│   ├── Domains                        /admin/governance/domains
│   ├── Roles                          /admin/governance/roles
│   ├── Risk & Alerts                  /admin/governance/risk
│   └── Business Calendar              /admin/masters/business-calendars
├── Master Data                        /admin/masters            (existing)
├── Permission Matrix                  /admin/permission-matrix  (existing)
├── Tenant Governance: branches        /admin/governance/branches (existing)
└── … (every other existing entry untouched)
```

i18n keys: 6 new (`governance_center`, `governance_center_organization`, `governance_center_domains`, `governance_center_roles`, `governance_center_risk`, `governance_center_calendar`) across all 4 locales (en / hi / dz / ne).

## Governance workflow

Daily governance flow:
1. Admin lands on `/admin/governance` — sees 11-card overview.
2. Picks the section (e.g. Business Calendar).
3. Lands on the T11 CRUD page or the existing module page.
4. Edit writes via existing PUT/POST routes → fans out to T11 master_audit + governance_change_ledger + M15 chain.
5. Quarterly audit: compliance officer queries `/audit-center/activity?resource_type=config` for the cross-section change pack.

## Approval workflow

Reuses the existing T4.20 generic approvals (`app_audit.approvals`) and the
T11 maker-checker hook. For sensitive governance edits (role template
changes, tenant suspension, domain disable), the existing M9.3 maker-checker
toggle (`features.maker_checker_enabled`) routes the change through the
Governance Center's audit panel before commit. No new approval engine added —
the existing 3 (T4.20 generic + M9.3 case + IAM Center approvals) cover it.

## Enterprise wireframe (text)

```
┌──────────────────────────────────────────────────────────────────┐
│ Enterprise Governance Center                                     │
│ Single source of truth for platform governance — 11 sections    │
├──────────────────────────────────────────────────────────────────┤
│ ⚙ Master Setup → Governance Center. Backward-compatible.        │
│ Every legacy URL still works — purely additive navigation.       │
├──────────────────────────────────────────────────────────────────┤
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                  │
│ │ 🌍 Organize │ │ 📚 Domain   │ │ 🏢 Tenant   │                  │
│ │ countries / │ │ banking +   │ │ HDFC / ICICI│                  │
│ │ regions etc │ │ insurance   │ │ + insurers  │                  │
│ └─────────────┘ └─────────────┘ └─────────────┘                  │
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                  │
│ │ 👥 Roles    │ │ ⚠ Risk     │ │ 🔔 Alerts   │                  │
│ │ 10 templates│ │ + severity  │ │ + SLA map   │                  │
│ └─────────────┘ └─────────────┘ └─────────────┘                  │
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                  │
│ │ ⬆ Escalate │ │ ⏰ SLA      │ │ ✉ Notify    │                  │
│ │ matrix      │ │ per severity│ │ templates   │                  │
│ └─────────────┘ └─────────────┘ └─────────────┘                  │
│ ┌─────────────┐ ┌─────────────┐                                  │
│ │ 📅 Calendar │ │ 🛡 Audit    │                                 │
│ │ + holidays  │ │ change log  │                                  │
│ └─────────────┘ └─────────────┘                                  │
├──────────────────────────────────────────────────────────────────┤
│ Backwards compatibility — every legacy URL listed                │
└──────────────────────────────────────────────────────────────────┘
```

## What we explicitly did NOT do

- Rename or move any existing Master Setup file.
- Change any existing master entity schema or row.
- Add a column to `app_iam.master_entities` / `master_entity_rows` / `master_audit`.
- Remove any legacy URL — every `/admin/master-setup`, `/admin/masters/*`,
  `/admin/tenants`, `/admin/governance/branches`, `/admin/sla-config`,
  `/admin/escalation-matrix`, `/admin/notification-templates`,
  `/admin/alert-classification`, `/admin/rbac/*` URL still resolves to the
  same page it always did.
- Add a new BFF route. The 2 net-new master entities ride the T11 generic
  routes; the 5 new SPA pages are pure read views.
- Add a new RBAC operation. Reuses T6 7-action × ~25-module matrix.

## Test surface

- `web/src/__tests__/GovernanceCenterPage.test.tsx` — 18 cases covering:
  - Governance Center role gate (admin / supervisor pass; risk_analyst bounce)
  - 11-card grid + canonical-order invariant + URL prefix invariant
  - Backwards-compat panel testid
  - Organization sub-page: 4 cards + canonical order + role gate
  - Domain sub-page: banking + insurance both render + closed-enum
  - Role sub-page: 10 templates + scope enum check + role gate
  - Risk + Alert paired sub-page: both card sections render + role gate

Sibling-regression sweep across 4 master/governance test files = **39/39 pass**.
BFF master_t11 jest = **27/27 pass** with the 2 new entities picked up by
the registry framework.

## Follow-ups (future, not blocking)

- Wire `business_calendar_holidays` resolution into the SLA business-day
  calculator (today the existing `SlaConfigPage` uses a static 5-day-week
  assumption).
- Add a regions × branches join view on the Organization landing once branches
  surface their region in the read shape.
- Add a per-section change-ledger drill into Section 11 once the
  `governance_change_ledger` row insertion is wired into the T11 master save
  path (today fans out via M15 audit chain only).
