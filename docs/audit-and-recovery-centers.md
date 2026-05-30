# Audit Center + Recovery Center — architecture

**Status:** shipped 2026-05-30
**Owner:** agent-integration + agent-ui

## Problem

The SPA exposed 6 separate sidebar entries for audit-adjacent + recovery
work, each pointing at an existing page:

| Sidebar entry        | URL                          | Page component             | Role               |
| -------------------- | ---------------------------- | -------------------------- | ------------------ |
| Audit Trail          | `/admin/audit-trail`         | `AuditTrailPage`           | admin / supervisor |
| Audit Log            | `/admin/audit-log`           | `AuditLogPage`             | admin / supervisor |
| Admin Activity       | `/admin/activity`            | `AdminActivityPage`        | admin / supervisor |
| Admin Sessions       | `/admin/sessions`            | `AdminSessionsPage`        | admin              |
| Recycle Bin          | `/admin/recycle-bin`         | `RecycleBinPage`           | admin              |
| Recovery Analytics   | `/admin/recovery-analytics`  | `RecoveryAnalyticsPage`    | admin              |

The audit + recovery stories were each split across multiple sidebar entries
with overlapping semantics (Audit Log + Admin Activity both showed operator
event streams; Recycle Bin already had restore + permanent-delete inline
but the sub-section concepts weren't surfaced as separate destinations).
Operators kept clicking the wrong one.

## Solution

Two unified centers. Same pattern as the [Rule Center](./rule-center-architecture.md):
one sidebar entry per center, each with named sub-sections that are thin
wrappers around existing pages. **Zero new BFF route, zero new DB table,
zero broken bookmark** — the legacy URLs all keep resolving.

### Audit Center → 5 sub-sections at `/audit-center/*`

| Sub-section         | URL                              | Renders                                   |
| ------------------- | -------------------------------- | ----------------------------------------- |
| Audit Trail         | `/audit-center/trail`            | `AuditTrailPage`                          |
| Login Audit         | `/audit-center/login-audit`      | `AdminSessionsPage`                       |
| Activity Logs       | `/audit-center/activity`         | `AuditLogPage` (default)                  |
|                     | `/audit-center/activity/admin`   | `AdminActivityPage`                       |
| Export Reports      | `/audit-center/export`           | `AuditExportPage` (NEW)                   |
| Compliance Reports  | `/audit-center/compliance`       | `AuditComplianceReportsPage` (NEW)        |

### Recovery Center → 4 sub-sections at `/recovery-center/*`

| Sub-section         | URL                                  | Renders                  |
| ------------------- | ------------------------------------ | ------------------------ |
| Deleted Records     | `/recovery-center/deleted`           | `RecycleBinPage`         |
| Restore             | `/recovery-center/restore`           | `RecycleBinPage`         |
| Permanent Delete    | `/recovery-center/permanent-delete`  | `RecycleBinPage`         |
| Recovery Analytics  | `/recovery-center/analytics`         | `RecoveryAnalyticsPage`  |

The 3 RecycleBinPage wrappers exist because the same surface answers three
different intents — admins land directly in the right context per click.
The page already exposes restore + purge buttons inline; the sub-routes
are an SPA-navigation hint, not a new BFF contract.

## UI architecture

- **2 new landing pages**, both ~220 LOC each: `AuditCenterPage` +
  `RecoveryCenterPage`. Each renders a card grid driven by an exported
  `_CENTER_CARDS` array (single source of truth). Adding a sub-section
  is a one-element push + one wrapper route in `App.tsx`.
- **2 new destination pages** for the genuinely-new Audit Center landings:
  - `AuditExportPage` — filter-driven bulk export of M15.1 audit events
    in CSV / PDF / XLSX with a client-side FNV-1a manifest fingerprint
    (lightweight evidence-pack identifier — production may swap to
    SHA-256 via WebCrypto). Re-uses `api.auditEvents` + `downloadAuditEvents{Csv,Pdf,Xlsx}`
    helpers — zero new BFF route.
  - `AuditComplianceReportsPage` — curated catalog of 6 pre-templated
    regulator packs (RBI Cyber Resilience access review, RBI BAC-A
    incident evidence, IRDAI Form-K claims, IRDAI Info-Sec access,
    SOC 2 quarterly, DPA 2019 data access). Each pack composes the
    M15.1 audit chain + M12.1 reports catalog + M9.3 maker-checker
    ledger + M13.1 config history. Click → land in Export Reports.
- **Role gates:**
  - Audit Center: `admin | supervisor` (matches the existing Audit Trail page).
  - Recovery Center: `admin` only (destructive purge action lives here).
- **Same Rule Center pattern** for backwards compatibility — `App.tsx`
  keeps every legacy route registered; `navConfig.ts` removes the 6
  scattered sidebar entries and adds 2 center groups + 9 sub-entries.

## API design

**Zero new BFF routes.** Every sub-section maps onto an existing surface:

| Sub-section                                  | Primary BFF surface                                                                 |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| Audit Trail                                  | M15.1 `GET /v1/audit/events*` + M15.2 `GET /v1/audit/integrity` + M15.4 `GET /summary.txt` |
| Login Audit                                  | `GET /auth/admin/sessions*` (Phase 9 T2)                                            |
| Activity Logs                                | M15.1 `GET /v1/audit/events?actor=` (same chain, different filter)                  |
| Export Reports                               | M15.1 `GET /v1/audit/events?…` then client-side serialise via `auditExport.ts`      |
| Compliance Reports                           | Curated index over M15.1 / M12.1 / M9.3 / M13.1                                     |
| Deleted Records / Restore / Permanent Delete | `GET /v1/recovery/records` + `POST /:id/restore` + `DELETE /:id/purge` (existing)   |
| Recovery Analytics                           | `GET /v1/recovery/analytics` (existing)                                             |

The only NEW client-side primitive is `fingerprint(ids: readonly string[])`
in `AuditExportPage` — FNV-1a 32-bit over the `event_id` list, hex-encoded.
Used as a deterministic evidence-pack identifier so regulators can verify
"the BFF handed me exactly these N rows". Production swap to SHA-256 via
WebCrypto is a 3-line change.

## DB changes

**None.** Both centers compose existing schemas:

- `audit.event_log` (M15 hash-chained WORM) — read-only.
- `app_iam.audit_events` (auth-svc local trail) — read-only.
- `app_audit.approvals` (T4.20 maker-checker) — read-only.
- `app_iam.sessions` (T4.14) — read-only.
- Recovery store (Phase 9 T7 recycle-bin schema) — read + restore + purge already wired.

If a future compliance pack needs new aggregation (e.g. "every customer_id
ever touched in the last quarter"), add a pure resolver under
`services/bff/src/audit/` following the M15.x naming pattern. Don't add
columns.

## RBAC controls

| Surface                                  | Required role(s)               | Reasoning                                                 |
| ---------------------------------------- | ------------------------------ | --------------------------------------------------------- |
| `/audit-center` landing                  | admin · supervisor             | Matches existing `AuditTrailPage`                         |
| `/audit-center/trail`                    | admin · supervisor             | Same as legacy `/admin/audit-trail`                       |
| `/audit-center/login-audit`              | admin                          | Same as legacy `/admin/sessions`                          |
| `/audit-center/activity`                 | admin · supervisor             | Same as legacy `/admin/audit-log` + `/admin/activity`     |
| `/audit-center/export`                   | admin · supervisor             | Wraps M15.1 reads — same gate as Audit Trail              |
| `/audit-center/compliance`               | admin · supervisor             | Curated index over the same M15 surface                   |
| `/recovery-center` landing               | admin                          | Destructive purge lives in the tree                       |
| `/recovery-center/deleted`               | admin                          | Same as legacy `/admin/recycle-bin`                       |
| `/recovery-center/restore`               | admin                          | RecycleBin restore action is admin-gated                  |
| `/recovery-center/permanent-delete`      | admin                          | Hard delete is irreversible — strictest gate              |
| `/recovery-center/analytics`             | admin                          | Same as legacy `/admin/recovery-analytics`                |

The BFF endpoints all keep their existing `requireRole` middlewares — the
SPA role gate is the FIRST line of defense; the BFF is the authoritative
second. No middleware changes were made.

## What we explicitly did NOT do

- Rename or move any existing audit / recovery module file.
- Change any existing audit / recovery API contract.
- Add a column to any audit / recovery table.
- Remove any legacy URL — every `/admin/audit-*` + `/admin/activity` +
  `/admin/sessions` + `/admin/recycle-bin` + `/admin/recovery-analytics`
  URL still resolves to the same page it always did.
- Add new RBAC operations. The 2 centers reuse the existing role checks.

## Test surface

- `web/src/__tests__/AuditCenterPage.test.tsx` — 19 cases covering:
  - Audit Center role gate (admin / supervisor pass / risk_analyst bounce / field_officer bounce)
  - 5 landing cards present with canonical-order invariant
  - Backwards-compat panel testid
  - Compliance Reports landing — 6 packs render with regulator closed-enum + Export-link invariant
  - Recovery Center role gate (admin pass / supervisor + risk_analyst bounce)
  - 4 landing cards + danger-tone invariant on permanent-delete card
  - URL prefix invariants on both `_CENTER_CARDS` arrays
- Existing audit + recovery test files unchanged.

## Follow-ups (future, not blocking)

- Replace the FNV-1a manifest with SHA-256 via WebCrypto once SubtleCrypto
  is required (~3 lines).
- Add a 7th compliance pack for the BIL-specific IRDAI Form-K when a real
  insurer onboards (entry in `COMPLIANCE_PACKS` array — no schema change).
- Once SPA telemetry confirms 0% traffic on the legacy sidebar entries for
  60 days, drop the legacy nav-entry-removal can be backed by analytics
  rather than assumption.
- If RecycleBinPage ever splits restore-only vs purge-only into distinct
  views, the Recovery Center cards already point at the right URLs to
  receive the split without further wiring.
