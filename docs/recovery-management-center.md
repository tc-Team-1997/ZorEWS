# Enterprise Recovery Management Center — Architecture

**Status:** SPA + schema migration shipped 2026-05-31; BFF routes follow-up.
**Scope:** Enhance the existing 4-section Recovery Center into a 10-section enterprise platform per the brief. **Zero new audit table** (every action fans out to M15 hash-chain), **zero removed APIs**, **zero deleted Recovery Analytics**. Mirrors the proven 6-overlay-center pattern (Rule / Audit + Recovery / AI Governance / IAM / Governance / Security Activity).

This is the **7th overlay center** shipped this session. Same constraints applied verbatim: **additive only · no API removal · backward-compatible · CREATE TABLE IF NOT EXISTS · reuse Audit Center / Governance Center / IAM Center / Security Activity Center integrations**.

---

## 1. Recovery Center Information Architecture

The center is a **landing page + KPI strip + card grid**, mirroring the proven pattern. The **4 existing sub-sections stay exactly where they are**; 6 net-new overlays add intent-focused surfaces, of which 4 introduce small new pages and 2 are deep-link cards into existing surfaces.

**Route root:** `/recovery-center`

### 10 sections (brief-canonical order)

| # | Section | Status | Destination |
|---|---------|--------|-------------|
| 1 | **Deleted Records Inventory** | REUSE existing | `/recovery-center/deleted` → `RecycleBinPage` |
| 2 | **Restore Workspace** | REUSE existing | `/recovery-center/restore` → `RecycleBinPage` |
| 3 | **Permanent Delete Workspace** | REUSE existing | `/recovery-center/permanent-delete` → `RecycleBinPage` |
| 4 | **Recovery Analytics** | REUSE existing (unchanged) | `/recovery-center/analytics` → `RecoveryAnalyticsPage` |
| 5 | **Recovery Workflow** (maker-checker) | NET-NEW page | `/recovery-center/workflow` → `RecoveryWorkflowQueuePage` |
| 6 | **Recovery History** (audit-chain pivot) | NET-NEW page (read-only over M15) | `/recovery-center/history` → `RecoveryHistoryPage` |
| 7 | **Search & Discovery** | NET-NEW page | `/recovery-center/search` → `RecoverySearchPage` |
| 8 | **Recovery Policies** (per-tenant retention) | NET-NEW page | `/recovery-center/policies` → `RecoveryPoliciesPage` |
| 9 | **Recovery RBAC Console** | DEEP-LINK to existing | `/admin/permissions?scope=recovery:*` |
| 10 | **Governance Integration** | DEEP-LINK to existing | `/audit-center` + `/admin/security` + `/admin/iam` |

The original `/admin/recycle-bin` + `/admin/recovery-analytics` URLs are preserved and remain registered in App.tsx for bookmarks + scripts.

---

## 2. React Component Hierarchy

```
web/src/modules/admin/recovery/
├── RecoveryCenterPage.tsx                  [EXTENDED — adds KPI strip + 6 new cards; original 4 cards intact]
├── recoveryRiskScoring.ts                  [NET-NEW — pure 5-factor risk resolver, 4-level bucketing]
├── workflowStateMachine.ts                 [NET-NEW — pure state machine: draft→submitted→approved→executed; maker≠checker]
├── RecoveryWorkflowQueuePage.tsx           [NET-NEW — 3-tab inbox (Pending / Decided / Mine)]
├── RecoveryHistoryPage.tsx                 [NET-NEW — read-only pivot over M15 audit chain]
├── RecoverySearchPage.tsx                  [NET-NEW — cross-entity payload search]
└── RecoveryPoliciesPage.tsx                [NET-NEW — per-tenant retention defaults table]

web/src/__tests__/
└── RecoveryManagementCenter.test.tsx       [NET-NEW — 44 tests]
```

### Reused primitives (no new components)
- `PageHeader` · `Panel` · `MetricCard` · `Badge` · `Input` · `Button` · `DataTable` — existing UI kit
- `useAuth().user.roles` — existing RBAC gate pattern
- `<Link to>` from react-router-dom — existing nav primitive
- `Navigate` for role-gate bounce → `/`

### Reused existing pages (untouched)
- `RecycleBinPage` (deleted / restore / permanent-delete sub-sections)
- `RecoveryAnalyticsPage` (analytics sub-section)
- `AdminPermissionMatrixPage` (RBAC console deep-link)
- `AuditTrailPage` (history deep-link)

---

## 3. PostgreSQL Schema Changes — `app_recovery` namespace

Two **net-new tables** + one **append-only log** + one BEFORE-UPDATE trigger. The existing `app_recovery.deleted_records` (migration 023) is untouched. **No parallel audit table** — every recovery action fans out into the existing M15 hash-chain (`audit.event_log`) via the existing `auditTrailStore` interface.

### Table 1 — `app_recovery.recovery_approvals` (maker-checker ledger)
Mirrors M9.3 `case_maker_checker` contract.

| Column | Type | Notes |
|---|---|---|
| approval_id | UUID PK | gen_random_uuid() |
| tenant_id | TEXT NOT NULL | FK → app_iam.tenants |
| recovery_id | UUID NOT NULL | FK → app_recovery.deleted_records, ON DELETE RESTRICT |
| action_type | TEXT NOT NULL | CHECK: closed enum (restore / bulk_restore / purge / bulk_purge / anonymize) |
| status | TEXT NOT NULL DEFAULT 'submitted' | CHECK: draft / submitted / approved / rejected / executed / cancelled |
| risk_score | TEXT | CHECK: low / medium / high / critical |
| maker_username | TEXT NOT NULL | submitter |
| submitted_at, rationale, checker_username, reviewed_at, decision_notes, executed_at, execution_outcome, execution_error, correlation_id, context_payload | … | rationale 10..4000 chars; decision_notes ≤ 4000 |

**Row-level CHECKs:**
- `recovery_approvals_maker_neq_checker` — RBI segregation: `checker_username IS NULL OR checker_username <> maker_username`
- `recovery_approvals_review_pair` — `(reviewed_at IS NULL) = (checker_username IS NULL)`
- `recovery_approvals_execution_after_approval` — `executed_at IS NULL OR status IN ('executed','approved')`

**Indexes:** `(tenant_id, status, submitted_at DESC)` hot path · `(tenant_id, maker_username, submitted_at DESC)` "my submissions" · `(tenant_id, checker_username, reviewed_at DESC) WHERE checker_username IS NOT NULL` · `(recovery_id)` back-reference · `(tenant_id, risk_score, submitted_at DESC) WHERE status='submitted'` prioritisation · `(correlation_id) WHERE correlation_id IS NOT NULL`

### Table 2 — `app_recovery.recovery_policies` (per-tenant config)

| Column | Type | Notes |
|---|---|---|
| policy_id | UUID PK | |
| tenant_id, entity_type | TEXT | UNIQUE composite |
| retention_days | INTEGER NOT NULL DEFAULT 90 | CHECK 1..2555 (7 years) |
| auto_purge_enabled | BOOLEAN NOT NULL DEFAULT false | |
| requires_maker_checker | BOOLEAN NOT NULL DEFAULT true | |
| min_checker_role | TEXT NOT NULL DEFAULT 'supervisor' | CHECK: supervisor / admin / compliance_officer |
| breach_quarantine_days | INTEGER | NULL means "no quarantine" |
| created_at/by, updated_at/by | … | BEFORE-UPDATE trigger keeps updated_at fresh |

**Indexes:** partial `(tenant_id) WHERE auto_purge_enabled = true` for the auto-purge cron job.

### Table 3 — `app_recovery.recovery_workflow_events` (append-only state log)

| Column | Type | Notes |
|---|---|---|
| event_id | BIGSERIAL PK | |
| tenant_id, approval_id | … | FK CASCADE to recovery_approvals |
| from_status, to_status, actor_username, actor_role, occurred_at, transition_reason | … | `to_status` CHECK; reason ≤ 1000 chars |

**Indexes:** `(approval_id, occurred_at)` for per-approval timeline · `(tenant_id, occurred_at DESC)` for fleet view.

---

## 4. Migration Scripts

Full SQL at **`data/schema/050_app_recovery.sql`** — idempotent (CREATE … IF NOT EXISTS / ON CONFLICT DO NOTHING). Apply after migrations 005 (tenants) + 023 (deleted_records). Seeds 2 default policies (`BANK_DEMO` + `BIL`, entity_type `*` wildcard, 90-day retention, maker-checker required).

Re-runs are safe. Rollback is `DROP SCHEMA app_recovery CASCADE` — but only do that if you also drop the existing migration 023 first (recovery_approvals has FK to deleted_records). For partial rollback `DROP TABLE app_recovery.recovery_approvals; DROP TABLE app_recovery.recovery_policies; DROP TABLE app_recovery.recovery_workflow_events;` leaves the existing deleted_records intact.

---

## 5. REST APIs — BFF routes (follow-up commit)

All routes: `requireTenant` middleware + JWT auth + envelope `{header, body}` / `{header, error}`. **The existing 7 `/v1/recovery/*` routes are UNCHANGED.**

| Method | Path | RBAC | Purpose |
|---|---|---|---|
| GET | `/v1/recovery/kpis` | `recovery:list` | 6-tile KPI strip data |
| GET | `/v1/recovery/workflow/approvals` | `recovery:workflow:read` | Paginated queue (filters: status, maker, checker, risk, action_type, since, until) |
| GET | `/v1/recovery/workflow/approvals/:approval_id` | `recovery:workflow:read` | Single approval + timeline |
| POST | `/v1/recovery/workflow/submit` | `recovery:workflow:submit` | Maker submits restore/purge for review |
| POST | `/v1/recovery/workflow/:approval_id/approve` | `recovery:workflow:approve` | Checker approves. **409 if maker===checker** (defense in depth alongside DB CHECK) |
| POST | `/v1/recovery/workflow/:approval_id/reject` | `recovery:workflow:approve` | Checker rejects with required notes |
| POST | `/v1/recovery/workflow/:approval_id/execute` | `recovery:restore` OR `recovery:purge` | Execute approved action via existing adapter; idempotent |
| POST | `/v1/recovery/workflow/:approval_id/cancel` | `recovery:workflow:submit` (maker only) | Maker withdraws before review |
| GET | `/v1/recovery/policies` | `recovery:list` | List per-tenant policies |
| PUT | `/v1/recovery/policies/:entity_type` | `recovery:policy:write` | Upsert per-(tenant, entity_type) |
| GET | `/v1/recovery/history` | `audit:read` | Pivot over M15 `auditTrailStore` (no new storage) |
| GET | `/v1/recovery/search?q=` | `recovery:list` | Substring over payload/original_id/deleted_by, min 3 chars |

**Error code routing:** `400 EWS_400_invalid_input` · `400 EWS_400_rationale_too_short` · `403 EWS_403_self_approval_forbidden` (maker===checker) · `403 EWS_403_missing_scope` · `404 EWS_404_unknown_approval` · `409 EWS_409_invalid_state_transition` · `409 EWS_409_already_decided`.

---

## 6. RBAC Mapping — 5 permissions × 5 roles

**Reused operations:** `recovery:list`, `recovery:restore`, `recovery:purge`, `audit:read`.
**Net-new operations:** `recovery:workflow:submit`, `recovery:workflow:approve`, `recovery:workflow:read`, `recovery:restore_direct`, `recovery:policy:write`.

| Permission | super_admin | country_admin | bank_admin / insurance_admin | auditor | analyst |
|---|---|---|---|---|---|
| **View** (`recovery:list`, `recovery:workflow:read`, `audit:read`) | ✅ all tenants | ✅ country scope | ✅ domain scope | ✅ read-only | ✅ own-tenant |
| **Restore** (workflow submit / direct) | ✅ direct + workflow | ✅ workflow | ✅ workflow | ❌ | ✅ workflow submit only |
| **Permanent Delete** (purge / anonymize) | ✅ (compliance_officer sign-off required) | ❌ | ❌ | ❌ | ❌ |
| **Approve Recovery** (`recovery:workflow:approve`) | ✅ all action_types | ✅ restore + bulk_restore | ✅ restore + bulk_restore | ❌ | ❌ |
| **Export Recovery Reports** (T4.6 builder) | ✅ all sources | ✅ country scope | ✅ domain scope | ✅ read-only export | ✅ own-tenant |

### matrix.json additions (follow-up)
```json
{
  "recovery:workflow:read":     ["admin", "supervisor", "risk_analyst", "collection_officer"],
  "recovery:workflow:submit":   ["admin", "supervisor", "risk_analyst", "collection_officer"],
  "recovery:workflow:approve":  ["admin", "supervisor"],
  "recovery:restore_direct":    ["admin"],
  "recovery:policy:write":      ["admin"]
}
```

### Self-approval ban — defense in depth (3 places)
1. **Database CHECK constraint** `recovery_approvals_maker_neq_checker`
2. **BFF route layer** — 403 `EWS_403_self_approval_forbidden`
3. **SPA UI** — Approve button disabled when `current_user.username === maker_username`

Mirrors M9.3 case_maker_checker pattern exactly.

---

## 7. Recovery Workflow — Maker-Checker State Machine

Implemented as **pure function** in `web/src/modules/admin/recovery/workflowStateMachine.ts`. SPA + BFF route handlers use the same `canTransition()` validator. Mirrors M9.3 + M7.2 contracts.

### Closed-enum statuses

```
draft → submitted → approved → executed   (happy path)
                  → rejected               (terminal — fresh submission required)
        submitted → cancelled              (maker withdraws before review)
        approved  → cancelled              (admin override pre-execution)
```

### TRANSITIONS map

| From | Allowed → To |
|---|---|
| `draft` | `submitted` · `cancelled` |
| `submitted` | `approved` · `rejected` · `cancelled` |
| `approved` | `executed` · `cancelled` |
| `rejected` | (terminal) |
| `executed` | (terminal) |
| `cancelled` | (terminal) |

`canTransition(from, to)` returns false for self-transitions (no-op) AND for any pair not in TRANSITIONS. `isTerminal(status)` returns true for {rejected, executed, cancelled}.

### Tracked metadata per workflow

- **Requestor** (`maker_username`, `maker_role`) — snapshot at submit
- **Approver** (`checker_username`, `checker_role`) — set at decision
- **Submission timestamp** (`submitted_at`) + **decision timestamp** (`reviewed_at`) + **execution timestamp** (`executed_at`)
- **Rationale** (maker, 10..4000 chars) + **Decision notes** (checker, ≤ 4000 chars)
- **Risk score** — computed at submit time via `scoreRecoveryRequest()` (see §8)
- **Correlation ID** — UUID linking to M15 audit chain entries for cross-reference

---

## 8. Dashboard Widgets — 6 KPI tiles

Surfaced inline on the `/recovery-center` landing as a horizontal `MetricCard` strip (`data-testid="recovery-kpi-strip"`).

| Tile | testid | Source | Computation |
|---|---|---|---|
| Active deletions | `recovery-kpi-active` | `GET /v1/recovery?status=archived&page_size=0` | Count of soft-deleted, not-restored, not-purged records |
| Pending approvals | `recovery-kpi-pending-approvals` | `GET /v1/recovery/workflow/approvals?status=submitted` | Count awaiting checker review |
| Restored today | `recovery-kpi-restored-today` | `GET /v1/recovery?status=restored&restored_since=today` | Restored within last 24h |
| Purges pending | `recovery-kpi-purges-pending` | `GET /v1/recovery/workflow/approvals?action_type=recovery.purge,recovery.bulk_purge&status=submitted` | Awaiting checker for irreversible action |
| High-risk requests | `recovery-kpi-high-risk` | `GET /v1/recovery/workflow/approvals?risk=high,critical` | Composed via `scoreRecoveryRequest()` |
| Audit chain integrity | `recovery-kpi-chain-integrity` | `GET /v1/audit/integrity` | Reuses M15 `verifyChain()` — surfaces ✓ / ✗ badge |

All 6 tiles render placeholder `—` until the BFF kpis endpoint lands; this is intentional and documented (no fabricated numbers).

### Pure risk-scoring resolver (`recoveryRiskScoring.ts`)

5 factors with closed-enum 4-level bucketing (low / medium / high / critical):

| Factor | Weight | Triggered when |
|---|---|---|
| `pii_payload` | 2 | payload contains name / email / phone / dob / pan / aadhaar / ssn / address |
| `bulk_action` | 1 | action_type starts with `recovery.bulk_` OR record_count > 1 |
| `purge_action` | 2 | action_type ∈ {recovery.purge, recovery.bulk_purge, recovery.anonymize} |
| `recent_deletion` | 1 | record was deleted < 7 days ago |
| `high_value_entity` | 2 | entity_type ∈ {tenant, customer, case, investigation, user, rule} |

`total_score = Σ (factor.weight where triggered)` ∈ [0, 8]. Bucket boundaries match M8.16 / M7.15 / Security Activity Center pattern: **≥6 critical · ≥4 high · ≥2 medium · <2 low**.

Thresholds exported as `RECOVERY_RISK_THRESHOLDS` for test reuse + future tuning.

---

## 9. Reporting Design

**No duplicate report runner.** The Reporting card on the landing deep-links to `/reports/builder` (existing T4.6 self-service report builder). Three new data sources land additively in `builder_catalog.ts`:

| Source ID | Reads from | Use case |
|---|---|---|
| `recovery_records` | `app_recovery.deleted_records` | "Deleted records report" — list of soft-deleted rows in window with full filter set |
| `recovery_actions` | `app_recovery.recovery_workflow_events` | "Recovery report" — restore + purge action timeline |
| `recovery_approvals_summary` | `app_recovery.recovery_approvals` | "Permanent deletion report" — purge approvals + decisions |

Compliance officers building an RBI/IRDAI evidence dump select one of these sources, apply the recovery-specific filters (entity_type, actor, time window, tenant, domain, country), and export to **CSV / PDF / Excel** via the unchanged T4.6 pipeline.

---

## 10. Governance Integration

The Recovery Management Center is **layered over** every existing governance surface. Zero duplicate audit storage. Cross-links:

```
                ┌────────────────────────────────────────────────┐
                │  Enterprise Recovery Management Center         │
                │  /recovery-center (overlay — 10 sections)      │
                └─────────────────┬──────────────────────────────┘
                                  │ composes (read-only deep-links)
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│  Audit Center   │      │ Security Center │      │  Governance     │
│  /audit-center  │      │ /admin/security │      │   /admin/iam    │
└────────┬────────┘      └────────┬────────┘      └────────┬────────┘
         │                        │                        │
         └────┬───────────────────┴────────────────────────┘
              ▼
       ┌─────────────────────────────────────────────────┐
       │  M15 audit.event_log (hash-chained WORM)        │
       │  + app_iam.audit_events                         │
       │  + app_audit.approvals (T4.20 maker-checker)    │
       └─────────────────────────────────────────────────┘
                              ▲
                              │ writes (recovery.*)
                              │
       ┌──────────────────────┴──────────────────────────┐
       │  Recovery actions fan out HERE — NEVER into     │
       │  a parallel app_recovery.audit_events table.    │
       └─────────────────────────────────────────────────┘
```

**Cross-center cross-references:**
- **Audit Center** — `/admin/audit-trail?resource_type=recovery` returns every recovery.* event in chain
- **Security Activity Center** — recovery approvals surface in the Admin Action Monitoring section because they write to the same audit chain
- **IAM Center** — `recovery:*` operations show up in the standard quarterly access review (`infra/rbac/scripts/access_review.py`)
- **Governance Center** — recovery policies cross-listed under the Master Setup → Governance Configuration view

---

## Tests

`web/src/__tests__/RecoveryManagementCenter.test.tsx` — **44 tests, all passing**:

- **Landing (5):** admin sees page + KPI strip, 6 KPI tiles render, non-admin bounced, 10 sections in canonical order, legacy panel intact
- **Workflow Queue (4):** admin sees 3 tabs, analyst (maker) accepted, field_officer bounced, state catalog renders
- **History (3):** admin sees page + action catalog + deep-link, analyst bounced, supervisor accepted
- **Search (2):** form + empty state render, non-allowed role bounced
- **Policies (2):** admin sees defaults table + RBI note, supervisor bounced (admin-only)
- **Risk-scoring closed enums (3):** 4 levels, 5 action types, exported thresholds
- **scoreRecoveryRequest (9):** low / medium / critical bucketing; each factor trigger fires correctly; all-5 → critical+8
- **Workflow state machine (8):** closed enum, transitions table, happy + reject + cancel paths, no-op self-transition, terminal-no-outbound, executed cannot rewind
- **isTerminal + checkMakerNotChecker (5):** terminal flagging, self-approval forbidden, distinct allowed, empty checker allowed
- **STATUS_LABELS (3):** every status mapped, terminal tones correct

### Sibling regression sweep
- `RecoveryCenterPage` / `RecycleBinPage` / `SecurityActivityCenter` / `GovernanceCenterPage` — **57/57 pass** (no regression)

### Build
- `tsc --noEmit` clean on all recovery files
- `vite build` clean (4.67s, ~750 kB gzip — no regression vs baseline)

---

## What's deliberately deferred

- **BFF route layer** — pure resolvers + state machine + types are the canonical contract today; route handlers wire to `app_recovery.recovery_approvals` in a follow-up commit. SPA pages render the contract + empty states so the surface is demoable end-to-end before persistence lands.
- **`recovery:workflow:*` RBAC scopes** — to be added to `infra/rbac/matrix.json` when the BFF routes ship. Today the SPA pages gate via existing `admin / supervisor / risk_analyst` role checks; analysts can render the maker-side UI, only admin + supervisor see the checker-side.
- **3 T4.6 report-builder source registrations** — added to `services/bff/src/reports/builder_catalog.ts` alongside the BFF route wiring.
- **Cron auto-purge worker** — reads `app_recovery.recovery_policies WHERE auto_purge_enabled=true`, scans `app_recovery.deleted_records` for `now - deleted_at > retention_days`, fires through the maker-checker workflow if `requires_maker_checker=true` else executes directly. Ships with the BFF follow-up.

---

## Pattern coda — 7 overlay centers shipped this session

1. **Rule Center** (commit `61ae37c`)
2. **Audit Center + Recovery Center** (commit `1689032`) — original 4-section Recovery Center
3. **AI Governance Layer** (commit `727ebd0`)
4. **Enterprise IAM Layer** (commit `b7539d7`)
5. **Enterprise Governance Center** (commit `e776639`)
6. **Security Activity Center** (commit `09e62e5`)
7. **Enterprise Recovery Management Center** (this commit) — 10 sections layered over the original 4

Same overlay-not-replacement pattern every time. Same constraints. Same outcome: extensive new capability surface with zero breaking changes.
