# Enterprise IAM Layer — architecture

**Status:** shipped 2026-05-31
**Owner:** agent-integration + agent-ui
**Companion docs:** [Rule Center](./rule-center-architecture.md) · [Audit + Recovery Centers](./audit-and-recovery-centers.md) · [AI Governance Layer](./ai-governance-layer.md)

## Problem

The existing User Management surface covered the basics (create user via 4-step
wizard at `/admin/users/new`, list at `/admin/users`, lock/unlock + password
reset, sessions at `/admin/sessions`, audit feed at `/admin/activity` +
`/audit-center/activity`). What was missing — and what RBI Cyber Resilience §4.1
+ IRDAI Info-Sec §6.2 + SOC 2 CC6.1 expect — was an explicit lifecycle layer
with status governance, password policy, maker-checker for sensitive IAM
actions, full access-review panel, and per-user audit timeline with diff.

## Solution

Same pattern as Rule Center / Audit Center / AI Governance: **one new "IAM
Center" sidebar entry with 6 named sub-sections**, layered ADDITIVELY over the
existing IUserStore / ISessionStore / IAuthAuditLog / RBAC matrix / DBAC /
Tenant + Branch surface. **Zero new BFF route** at the User store level —
new dedicated stores cover the new domain. **Zero existing column dropped or
renamed.** Every legacy URL keeps working.

### Sub-sections at `/admin/iam/*`

| Sub-section          | URL                                       | Renders                          | Status |
| -------------------- | ----------------------------------------- | -------------------------------- | ------ |
| User Lifecycle       | `/admin/iam/lifecycle`                    | `UserLifecyclePage`              | NEW    |
| Access Review        | `/admin/iam/access-review[/:username]`    | `UserAccessReviewPage`           | NEW    |
| Approvals Inbox      | `/admin/iam/approvals`                    | `UserApprovalsInboxPage`         | NEW    |
| User Audit History   | `/admin/iam/audit[/:username]`            | `UserAuditHistoryPage`           | NEW    |
| Session Governance   | `/admin/sessions`                         | `AdminSessionsPage` (existing)   | LINK   |
| Password Policy      | `/admin/iam/password-policy`              | `PasswordPolicyPage`             | NEW    |

## 6 Features delivered

### F1 — User Status Management (`UserLifecyclePage`)
Closed-enum 5-state lifecycle (`active | inactive | suspended | locked |
pending_approval`) with status badge per row, per-user status history drawer,
bulk update toolbar (multi-select → choose status → reason → submit, cap 500
per batch). 5-bucket KPI strip headlines current distribution.

### F2 — Password Governance (`PasswordPolicyPage`)
Per-tenant `password_policies` row (min_len 8..128 / require upper-lower-digit-
symbol / expiry_days 0..730 / history_count 0..50 / lockout_threshold 3..20 /
lockout_window_min 1..1440 / reminder_days_before_expiry 0..60). Per-user
`user_password_metadata` row tracks `last_changed_at`, `expires_at`,
`must_reset`, `reminder_sent_at`, `force_reset_at`, `force_reset_by`. Force-
reset API composes with the existing `IUserStore.setMustChangePassword`.

### F3 — Session Governance enhancement
Five ADDITIVE columns on `app_iam.sessions`: `browser`, `device`, `country`,
`login_at`, `logout_at`. The existing `AdminSessionsPage` continues to render
its current columns; new columns are surfaced through the existing
`AdminSessionsPage` route which the IAM Center deep-links into. No removals.

### F4 — Access Review Panel (`UserAccessReviewPage`)
Per-user 360 panel: country (from `app_iam.tenants.country_code`), domain
(banking/insurance via DBAC), tenant_id, branch_id, department, role(s) +
RBAC summary table rendering 7 actions (`view | create | edit | delete |
approve | export | configure`) × N modules from the existing T6 permission
matrix. Read-only — the matrix is rendered, not editable here.

### F5 — User Approval Workflow (`UserApprovalsInboxPage`)
Maker-checker queue for sensitive IAM actions: `user_create | user_role_change
| user_status_change | user_delete | user_access_grant | password_force_reset`.
Pending → approved/rejected/cancelled/expired. Self-approval blocked at app
layer (`UserApprovalsError('self_approval_forbidden')`) **and** at DB layer
(`CHECK (approver IS NULL OR approver <> requested_by)` on
`app_iam.user_approvals`). FIFO inbox (oldest pending first).

### F6 — User Audit History (`UserAuditHistoryPage`)
Per-user event timeline with 11-value closed enum (`user_created | user_updated
| password_reset | role_changed | access_changed | status_changed |
approval_requested | approval_decided | session_terminated | profile_updated |
lifecycle_bulk_update`). Each row carries `before_state` + `after_state` JSON
snapshots; the SPA renders a side-by-side diff. Optional `correlation_id`
groups all rows from a bulk operation or maker-checker round-trip.

## PostgreSQL schema (`data/schema/052_user_lifecycle.sql`)

Idempotent migration. `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN
IF NOT EXISTS` + CHECK additions wrapped in `DO`-blocks with `EXCEPTION WHEN
duplicate_object`. Re-runs are no-ops.

### Additive ALTERs (legacy columns preserved)

| Table              | New columns                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `app_iam.users`    | `status TEXT NOT NULL DEFAULT 'active'` (5-value CHECK), `department TEXT`, `last_login_at TIMESTAMPTZ`, `last_logout_at TIMESTAMPTZ`, `active_session_count INTEGER NOT NULL DEFAULT 0` |
| `app_iam.sessions` | `browser TEXT`, `device TEXT`, `country TEXT`, `login_at TIMESTAMPTZ`, `logout_at TIMESTAMPTZ`         |

A `BEFORE-UPDATE` trigger `app_iam.sync_user_locked_status()` keeps the new
canonical `status` column and the legacy `locked` boolean in sync — every
existing query against `WHERE locked=` keeps working unchanged.

### New tables

1. **`app_iam.user_status_history`** — append-only status transition ledger.
2. **`app_iam.password_policies`** — per-tenant policy override (PK is `tenant_id`; absence ⇒ platform defaults).
3. **`app_iam.user_password_metadata`** — per-user expiry / force-reset / reminder state.
4. **`app_iam.user_approvals`** — IAM maker-checker queue with `CHECK` self-approval ban.
5. **`app_iam.user_audit_history`** — per-user event timeline with before/after JSON snapshots.

Every table carries `tenant_id` FK to `app_iam.tenants` and CASCADE on tenant
delete. Hot-path indexes (`tenant_id, status, changed_at DESC` etc) align with
the SPA filter patterns.

## Backend stores (in-memory; pg-backed swap follows existing IUserStore pattern)

| File                                                  | Interface + InMemory class                                 |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| `services/auth-svc/src/user_lifecycle.ts`             | `IUserLifecycleStore` + `InMemoryUserLifecycleStore`       |
| `services/auth-svc/src/password_governance.ts`        | `IPasswordGovernanceStore` + `InMemoryPasswordGovernanceStore` |
| `services/auth-svc/src/user_approvals.ts`             | `IUserApprovalStore` + `InMemoryUserApprovalStore`         |
| `services/auth-svc/src/user_audit_history.ts`         | `IUserAuditStore` + `InMemoryUserAuditStore`               |

Each store: closed-enum constants exported, error class with code routing
(`invalid_input | invalid_status | not_found | self_approval_forbidden |
already_decided`), TypeScript strict (no `any`), follows the same shape as
`teams.ts` + `leave_covers.ts` + `dashboard_widgets.ts` so a pg-backed swap
matches the proven T4.13-T4.21 pattern.

## APIs (SPA-facing via `api.ts` wrappers)

| Method | Path                                                        | Purpose                                              |
| ------ | ----------------------------------------------------------- | ---------------------------------------------------- |
| GET    | `/auth/users/lifecycle/by-status`                           | List user → current status (filter for KPI strip)    |
| GET    | `/auth/users/:user_id/status-history`                       | Per-user transition ledger                           |
| POST   | `/auth/users/lifecycle/bulk-update`                         | Bulk status update (cap 500)                         |
| GET    | `/auth/users/:username/access-review`                       | One-shot 360 panel (RBAC + DBAC + session + audit)   |
| GET    | `/auth/password-policy/me`                                  | Caller-tenant policy                                 |
| PUT    | `/auth/password-policy/me`                                  | Update policy (admin only)                           |
| GET    | `/auth/users/password-governance/expiring`                  | Users with passwords expiring within reminder window |
| GET    | `/auth/users/approvals/summary`                             | Approvals KPI strip                                  |
| GET    | `/auth/users/approvals?status=…`                            | Approvals inbox queue                                |
| POST   | `/auth/users/approvals/:approval_id/approve`                | Approve (self-approval blocked)                      |
| POST   | `/auth/users/approvals/:approval_id/reject`                 | Reject with mandatory comments                       |
| GET    | `/auth/users/:user_id/audit-history`                        | Per-user audit timeline                              |
| GET    | `/auth/users/audit-history/by-tenant`                       | Tenant-wide IAM audit feed                           |

All routes mirror the existing auth-svc raw-JSON shape (no envelope wrapping —
auth-svc pre-dates the M15 envelope rollout; introducing it now would break the
SPA's existing wrappers). Tenant context read from `X-Tenant-ID` header with
`BANK_DEMO` fallback. Role gates align with the existing admin-check helper
used by `/auth/users`.

## SPA UI architecture

- **1 new landing page** (`IamCenterPage`, ~150 LOC) — driven by exported
  `IAM_CENTER_CARDS` array. Adding a 7th sub-section is one element + one
  wrapper route.
- **5 new destination pages** under `web/src/modules/admin/iam/`:
  - `UserLifecyclePage` — 5-bucket KPI strip + filterable table + status-history drawer + bulk-update toolbar.
  - `UserAccessReviewPage` — list view + per-user drill (`/admin/iam/access-review/:username`) with IAM context grid + RBAC summary table (7 actions × N modules).
  - `UserApprovalsInboxPage` — 5-status KPI strip + tabbed queue (pending sorts oldest-first) + approve/reject modal with self-approval guard.
  - `UserAuditHistoryPage` — event timeline (per-user or tenant-wide) with event_type + actor filters + show-diff toggle rendering side-by-side before/after JSON.
  - `PasswordPolicyPage` — policy editor (NumberField + ToggleField) + expiring-soon list.
- **MSW handlers** mirror every route shape so dev mode works without auth-svc.
- **Role gates**: admin + supervisor for the landing + lifecycle + access-review +
  approvals + audit; admin-only for password-policy + sessions.

## RBAC integration

**No new RBAC operations.** The IAM Center reuses the existing T6 7-action ×
~25-module enterprise matrix (`services/bff/src/rbac/permission_matrix.ts`):

| IAM Center surface         | Effective scope                                            |
| -------------------------- | ---------------------------------------------------------- |
| Landing page               | admin · supervisor (SPA gate)                              |
| User Lifecycle             | admin · supervisor — read; admin write (mutations)         |
| Access Review              | admin · supervisor — read only (matrix rendered, not edited) |
| Approvals Inbox            | admin · supervisor — read; admin write (approve/reject)    |
| User Audit History         | admin · supervisor — read only                             |
| Password Policy            | admin only (destructive)                                   |
| Session Governance         | admin only (existing AdminSessionsPage policy)             |

The Access Review page calls `api.iamAccessReview(username)` which returns a
`rbac_modules[]` array — each row carries `module_id` + `granted_actions[]`.
The SPA renders this directly as the 7-column matrix.

## Audit integration

Every IAM mutation writes to `app_iam.user_audit_history` (per-user, with
before/after JSON snapshots) AND fans out to the M15 `audit.event_log`
hash-chain via the existing `audit_event_log.ts` bridge — same pattern T4.16
established for the auth audit log. This means every IAM change is:

1. Locally queryable via `IUserAuditStore.listByUser(user_id)` + the SPA's
   UserAuditHistoryPage (with field-level diff).
2. Tenant-wide queryable via `IUserAuditStore.listByTenant(tenant_id)`.
3. Cryptographically anchored in the M15.2 hash-chain — verified via
   `GET /v1/audit/integrity` against the existing chain-walker.
4. Surfaced in the unified `/audit-center/*` Audit Center as part of the
   same fleet — compliance teams already know how to query it.

The `correlation_id` field groups all rows from a bulk operation (one
correlation_id across N `user_audit_history` rows + 1 `user_status_history`
parent) or a maker-checker round-trip (correlation across `approval_requested`
+ `approval_decided` + the executed action's `status_changed` row).

## What we explicitly did NOT do

- Rename or move any existing User / Session / Audit module file.
- Change any existing User / Session / Audit / RBAC API contract.
- Add a column to `app_iam.users` that would shadow `locked`, `failed_login_count`,
  `lockout_until_ms`, `must_change_password`, or `password_history` — those stay
  the source of truth for the auth flow; the new `status` column is the
  canonical lifecycle state with a sync trigger.
- Remove any legacy URL — every `/admin/users`, `/admin/users/new`,
  `/admin/sessions`, `/admin/audit-trail`, `/admin/audit-log`, `/admin/activity`
  URL still resolves to the same page.
- Add a new RBAC operation. The 7-action × ~25-module T6 enterprise matrix is
  reused unchanged.
- Add a new BFF route. The 5 new pages either call the new auth-svc routes
  (via the new SPA `api.iam*` wrappers + MSW handlers in dev mode), or reuse
  the existing `useAuth().adminListUsers` action.

## Test surface

- `web/src/__tests__/IamCenterPage.test.tsx` — 18 cases covering:
  - IamCenter role gate (admin / supervisor pass; risk_analyst / field_officer bounce)
  - 6-card grid + canonical-order invariant + URL prefix invariant
  - Backwards-compat panel testid
  - UserLifecyclePage role gate + KPI strip testids
  - UserApprovalsInboxPage role gate + tabs testid + pending-tab testid
  - UserAccessReviewPage role gate + list view testid
  - UserAuditHistoryPage role gate + filters testid
  - PasswordPolicyPage role gate (admin only; supervisor + risk_analyst bounced) + KPI strip

Sibling-regression sweep across 4 user/admin/IAM test files = **55/55 pass**.

## User lifecycle state diagram

```
              ┌──────────────────────────────────────────┐
              │                                          │
              │     (admin create with maker-checker)    │
              │                                          ▼
            (new)──────────► pending_approval ──────► active
                                  │                    │  ▲
                                  │                    │  │
                                  │  (reject)          ▼  │
                                  │                  inactive
                                  ▼                    │  ▲
                              (deleted)                │  │
                                                       ▼  │
                                                   suspended
                                                       │  ▲
                                                       │  │
                                                       ▼  │
                                                    locked
```

Edges in `app_iam.user_status_history` carry actor + reason + correlation_id.
Trigger keeps legacy `locked` boolean in sync with `status = 'locked'`.

## Follow-ups (future, not blocking)

- Pg-backed swap for the 4 in-memory stores (mirrors T4.13–T4.21 pattern;
  same interface). Wiring is one factory line in `auth_state.ts` once the
  migration is applied.
- 7th sub-section if needed — e.g. "MFA Governance" (TOTP enrollment +
  recovery code mgmt at tenant scope). Drop into the array.
- Once telemetry confirms 0% traffic on `/admin/users` from non-IAM-Center
  entry points for 60 days, evaluate consolidating that legacy entry into
  the IAM Center landing as an SPA-side redirect (URL stays).
