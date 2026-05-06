# EWS Case Management System — Migration & Architecture Map

**Status:** RFC — informs CMS-1 commit. Sign-off needed on §4 before CMS-2 lands.
**Date:** 2026-05-06.
**Brief:** Migrate apex_aml's CMS into ZorEWS, adapt for EWS workflows (alert-driven cases, multi-step investigation, audit-ready closure). 8-task brief: inventory + lifecycle + DB schema + APIs + UI + automation + security + notifications.

---

## 1. Source-repo access

**`apex_aml` is NOT on this filesystem.** Searched `/Users/taniya/`, `/Users/taniya/Documents/`, and `/`; the only sibling repos are `apex_datawarehouse` (no CMS) and `apex_network` (architecture docs only — no source). Task #1 ("INVENTORY apex_aml's CMS") is therefore **deferred** — I'll build to the spec the brief provides.

If you can share the apex_aml source (zip / paste / repo URL), I'll fold its patterns in via a follow-up commit. The user-mandated lifecycle + schema + APIs are detailed enough to design without it.

---

## 2. What ZorEWS already has — existing CMS surface

A reasonably complete case-management vertical is already shipped (M9.1–M9.4). Any new work must coexist with it (additive-only standing rule).

### Backend modules (5 files)

| File | Sub-phase | Concern |
|---|---|---|
| `services/bff/src/case_action.ts` | M9.0 | Action sink interface (call/visit/sms/email log) |
| `services/bff/src/case_investigation.ts` | M9.1 | 6-state tracker (open / assigned / in_action / monitored / closed) + 8-step BIL §17 claim-fraud checklist |
| `services/bff/src/case_checklists.ts` | M9.2 | Custom checklists store |
| `services/bff/src/case_maker_checker.ts` | M9.3 | RBI 4-eyes maker-checker (close/escalate/override) with self-approval refusal |
| `services/bff/src/case_events.ts` | M9.4 | Append-only journal w/ 9-action enum, monotonic `sequence_no`, cap 1000 FIFO |

### Existing routes (15 — all under `/v1/cases/*` and `/v1/investigations/*`)

```
GET    /v1/cases/sla-summary
POST   /v1/cases/maker-checker
GET    /v1/cases/maker-checker
GET    /v1/cases/maker-checker/:action_id
POST   /v1/cases/maker-checker/:action_id/{approve,reject}
POST   /v1/cases/events                  ← M9.4
GET    /v1/cases/events
GET    /v1/cases/events/:event_id
GET    /v1/cases/:case_id/events
GET    /v1/investigations
POST   /v1/investigations
GET    /v1/investigations/:id
PATCH  /v1/investigations/:id/status
POST   /v1/investigations/:id/steps/:step_id/complete
GET    /v1/investigations/:id/notes
POST   /v1/investigations/:id/notes
{CRUD} /v1/investigations/checklists[:id]
```

### SPA pages

- `web/src/modules/cases/CaseListPage.tsx` (filterable table, dedup grouping)
- `web/src/modules/cases/CaseDetailPage.tsx`

### DB schema (`app_cases.*` tables in `008_cases_tenant.sql` + `004_app_schemas.sql`)

| Table | Purpose | Status |
|---|---|---|
| `app_cases.cases` | One row per case; states open/assigned/in_action/monitored/closed; sla_status; outcome | **Exists** |
| `app_cases.actions` | call/visit/sms/email/note log per case | **Exists** |
| `app_cases.cas_records` | Causal Analysis Stage (maker-checker submission) | **Exists** |
| `app_cases.caps` | Corrective Action Plans | **Exists** |

---

## 3. Brief vs. existing — gap analysis

| Brief requirement | Existing | Gap |
|---|---|---|
| **Lifecycle** OPEN→ASSIGNED→INVESTIGATING→PENDING_APPROVAL→CLOSED + ESCALATED + REOPENED | open→assigned→in_action→monitored→closed (5 states, no reopen, no first-class escalated) | **Different state names + missing REOPENED/ESCALATED transitions** |
| **case_number** `EWS-YYYY-NNNNN` auto-generated | `case_id` is opaque text | **Add a separate `case_number` field** |
| **Priority** P1/P2/P3/P4 | `severity: low/medium/high/critical` | **Map: P1=critical, P2=high, P3=medium, P4=low** |
| **`alert_id` FK** | denormalised on `cases.alert_id` (TEXT, no FK) | **Already there** |
| **`assigned_to`, `created_by`** | only `assignee` (no created_by) | **Add `created_by` column** |
| **`sla_due_at`** | `sla_status` enum only (no concrete deadline) | **Add `sla_due_at` TIMESTAMPTZ** |
| **`resolved_at`** | `closed_at` | Equivalent — alias |
| **`resolution_category`** false_positive / confirmed_risk / mitigated | `outcome` cured / cured_temp / defaulted | **Different vocabulary — add new enum** |
| **`resolution_notes`** | Not on cases table | **Add column** |
| **`tags TEXT[]`** | Not present | **Add column** |
| **`case_notes`** dedicated table | Inline notes in `case_investigation.ts` | **Build new table** |
| **`case_attachments`** with virus_scan_status | Not present | **Build — net-new capability** |
| **`case_history`** dedicated audit | M9.4 case-event journal exists but is per-tenant + cross-case | **Use M9.4 as the audit source; surface case-scoped slice via existing `/v1/cases/:case_id/events`** |
| **`case_assignments`** assignment history | Just `assignee` column (no history) | **Build new table** |
| **APIs** POST/GET/PATCH/transition/assign/escalate/close/notes/attachments/history/stats/sla-breaches/bulk-assign | Partial (CRUD on investigations, no transition/assign/escalate/close/attachments/stats/bulk-assign) | **~12 new routes** |
| **Kanban board view** | Not present | **New SPA page** |
| **Tabbed detail (Overview/Investigation/Timeline/Related)** | Single page | **Refactor or add new page** |
| **Auto-create from RED alert** | Not wired | **New automation hook** |
| **SLA P1=4h / P2=24h / P3=72h / P4=7d** with breach warnings | `sla_status` flag only | **New SLA timer + warning route** |
| **File uploads** with virus scan + type whitelist | Not present | **New attachment store** |
| **Closed-case lock** | Not enforced | **Add `is_locked` derived from state==closed** |
| **Notifications** (in-app, email, Slack/Teams) | Webhook system exists (M10) | **Wire case events → existing webhook channels** |

**Net new code:** ~8 backend modules, ~12 new routes, 4 new DB tables, 2 new SPA pages, ~150 tests.
**Net unchanged:** existing M9.1–M9.4 surfaces stay frozen — additive only.

---

## 4. Proposed architecture

### 4.1 Naming + namespace

To stay additive without confusing readers about which CMS surface they're on, the new richer CMS lives under:

- BFF routes: **`/v1/cms/cases/*`** (NOT `/v1/cases/*` — that's M9.x)
- BFF modules: `services/bff/src/cms_*.ts` (cms_cases.ts, cms_assignments.ts, cms_notes.ts, cms_attachments.ts, cms_sla.ts, cms_seed.ts)
- SPA pages: `web/src/modules/cms/{CmsCaseListPage,CmsCaseKanbanPage,CmsCaseDetailPage}.tsx`
- DB schema: extends `app_cases.*` with new tables (`cms_cases`, `cms_case_notes`, `cms_case_attachments`, `cms_case_assignments`, `cms_case_history` mirror); existing `app_cases.cases` stays untouched

### 4.2 Lifecycle state machine (the user's spec)

```
                  ┌─────────────┐
                  │    OPEN     │ ◀──────────── REOPENED
                  └─────┬───────┘                    ▲
                        │                            │
                  assign│                            │
                        ▼                            │
                  ┌─────────────┐                    │
                  │  ASSIGNED   │                    │
                  └─────┬───────┘                    │
                        │                            │
                 begin  │                            │
                investig│                            │
                        ▼                            │
                  ┌─────────────┐ ────escalate─▶ ┌────────────┐
                  │INVESTIGATING│                │ ESCALATED  │
                  └─────┬───────┘ ◀──de-escal─── └─────┬──────┘
                        │                              │
                  submit│                              │
                        ▼                              │
                  ┌────────────────┐                   │
                  │PENDING_APPROVAL│                   │
                  └─────┬──────────┘                   │
                        │                              │
                 approve│                              │
                        ▼                              │
                  ┌─────────────┐                      │
                  │   CLOSED    │ ◀───── close ────────┘
                  └─────┬───────┘
                        │
                  reopen│
                        ▼
                     OPEN  (state→OPEN; deprecated_at cleared)
```

**Transitions table:** captured in `cms_cases.ts` as a static `Record<State, State[]>` map; pure `isLegalCmsTransition(from, to)` guard. Same pattern as M9.1.

### 4.3 Priority ↔ Severity ↔ SLA mapping

| Priority | Maps to existing severity | SLA window |
|---|---|---|
| P1 | critical | 4 hours |
| P2 | high | 24 hours |
| P3 | medium | 72 hours |
| P4 | low | 7 days |

`sla_due_at = created_at + sla_window(priority)`. Stored at create time; recomputed on `reopen`. Pure helper `computeSlaDueAt(priority, anchor)`.

### 4.4 Case number generation

`EWS-YYYY-NNNNN` where `NNNNN` is per-tenant per-year monotonic. Counter held in-memory in the prototype (the production swap reads from a sequence). Format enforced by a regex check at DB boundary (in the migration's CHECK constraint).

### 4.5 New DB tables (extends `app_cases` schema, doesn't touch existing tables)

```sql
CREATE TABLE app_cases.cms_cases (
    case_id              UUID         PRIMARY KEY,
    case_number          TEXT         NOT NULL,
    tenant_id            TEXT         NOT NULL,
    title                TEXT         NOT NULL,
    description          TEXT,
    alert_id             TEXT,         -- FK to alerts (soft — alerts table varies by env)
    status               TEXT         NOT NULL DEFAULT 'OPEN',
    priority             TEXT         NOT NULL,        -- P1 / P2 / P3 / P4
    assigned_to          TEXT,
    created_by           TEXT         NOT NULL,
    sla_due_at           TIMESTAMPTZ  NOT NULL,
    resolved_at          TIMESTAMPTZ,
    resolution_category  TEXT,         -- false_positive / confirmed_risk / mitigated
    resolution_notes     TEXT,
    tags                 TEXT[]       NOT NULL DEFAULT '{}',
    is_locked            BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, case_number),
    CHECK (status IN ('OPEN','ASSIGNED','INVESTIGATING','PENDING_APPROVAL','ESCALATED','CLOSED','REOPENED')),
    CHECK (priority IN ('P1','P2','P3','P4')),
    CHECK (resolution_category IS NULL OR
           resolution_category IN ('false_positive','confirmed_risk','mitigated'))
);

CREATE TABLE app_cases.cms_case_notes (
    note_id     UUID         PRIMARY KEY,
    case_id     UUID         NOT NULL REFERENCES app_cases.cms_cases(case_id) ON DELETE CASCADE,
    tenant_id   TEXT         NOT NULL,
    user_id     TEXT         NOT NULL,
    note_text   TEXT         NOT NULL,
    is_internal BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE app_cases.cms_case_attachments (
    attachment_id      UUID         PRIMARY KEY,
    case_id            UUID         NOT NULL REFERENCES app_cases.cms_cases(case_id) ON DELETE CASCADE,
    tenant_id          TEXT         NOT NULL,
    file_name          TEXT         NOT NULL,
    file_url           TEXT         NOT NULL,
    file_size          BIGINT       NOT NULL,
    mime_type          TEXT         NOT NULL,
    uploaded_by        TEXT         NOT NULL,
    virus_scan_status  TEXT         NOT NULL DEFAULT 'pending',  -- pending / clean / infected / failed
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE app_cases.cms_case_assignments (
    assignment_id   UUID         PRIMARY KEY,
    case_id         UUID         NOT NULL REFERENCES app_cases.cms_cases(case_id) ON DELETE CASCADE,
    tenant_id       TEXT         NOT NULL,
    assigned_to     TEXT         NOT NULL,
    assigned_by     TEXT         NOT NULL,
    assigned_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    unassigned_at   TIMESTAMPTZ,
    reason          TEXT
);

CREATE TABLE app_cases.cms_case_history (
    history_id    UUID         PRIMARY KEY,
    case_id       UUID         NOT NULL REFERENCES app_cases.cms_cases(case_id) ON DELETE CASCADE,
    tenant_id     TEXT         NOT NULL,
    action_type   TEXT         NOT NULL,
    old_value     JSONB,
    new_value     JSONB,
    performed_by  TEXT         NOT NULL,
    performed_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

Indexes: `(tenant_id, status)` on cms_cases for kanban; `(tenant_id, sla_due_at)` for breach reports; `(case_id, performed_at DESC)` on history; `(tenant_id, virus_scan_status)` on attachments for the queue worker.

### 4.6 New routes (`/v1/cms/cases/*`)

```
POST   /v1/cms/cases                         create
GET    /v1/cms/cases                         list with filters
GET    /v1/cms/cases/:id                     full detail
PATCH  /v1/cms/cases/:id                     update mutable fields
POST   /v1/cms/cases/:id/transition          state change with validation
POST   /v1/cms/cases/:id/assign              assign/reassign
POST   /v1/cms/cases/:id/escalate            shortcut → ESCALATED
POST   /v1/cms/cases/:id/close               shortcut → CLOSED with resolution
POST   /v1/cms/cases/:id/notes               add note
GET    /v1/cms/cases/:id/notes               list notes
POST   /v1/cms/cases/:id/attachments         upload (cap 20MB; whitelist; stores metadata)
GET    /v1/cms/cases/:id/attachments         list
GET    /v1/cms/cases/:id/attachments/:fid    download
DELETE /v1/cms/cases/:id/attachments/:fid    remove
GET    /v1/cms/cases/:id/history             audit trail
GET    /v1/cms/cases/stats                   dashboard metrics
GET    /v1/cms/cases/sla-breaches            SLA violations
POST   /v1/cms/cases/bulk-assign             bulk assign N case_ids
```

19 routes total. Audit-event wiring on every mutation; SLA-breach computed on read (no scheduled sweeper in the prototype — runtime is in-memory).

### 4.7 RBAC

| Role | List scope | Mutation scope |
|---|---|---|
| `risk_analyst` (`cases:list`) | only assigned-to-self | comment only on assigned cases |
| `supervisor` (`cases:supervise`) | own team's cases | assign/escalate/close on team cases |
| `admin` (`cases:list` + audit:read) | all cases tenant-wide | full mutation rights |

Implementation: middleware reads `x-apex-role` header; the existing `requireRole()` helper handles capability gates. The "only assigned-to-self" filter for analysts is applied at list-time as a LEFT-JOIN-style filter on `assigned_to == actor`.

### 4.8 Closed-case lock

When `status` transitions to `CLOSED`, the row's `is_locked = TRUE`. Every mutation route checks `is_locked` first and returns `EWS_409_case_locked` if set. Reopen flow: `POST /:id/transition {target: OPEN}` from CLOSED clears `is_locked` (with audit event).

### 4.9 SLA + automation

- `computeSlaDueAt(priority, created_at)` — pure helper; called at create time and on `reopen`.
- `slaProgressPct(now, created_at, sla_due_at)` — `0..100`, returns 100+ when breached.
- `GET /v1/cms/cases/sla-breaches` returns cases where `slaProgressPct >= 100`.
- Breach-warning at 80%: surface in the same response with a `warning` flag; SPA shows a yellow chip. No background sweeper in the prototype.
- **Auto-create from RED alert**: a small wiring shim that the alerts ingest path (M8.5) optionally calls — if a configurable flag is set, every RED alert creates a CMS case. Implemented as a pure function; M8.5 doesn't change.
- **Round-robin assignment**: `assignNext(activeAssignees: string[], lastAssigned)` pure helper; deterministic so tests can verify.

### 4.10 Notifications

- Every mutation writes a `case.{create/update/transition/assign/escalate/close}` audit event.
- Per RFC sign-off Q5 from the EWS rules engine, every mutation also writes an M9.4 case-event journal entry (so we don't fork the journal — the existing one is the source of truth).
- For email/Slack/Teams: wire to the existing M10 webhook channels. Concretely: when a case transitions to ESCALATED or P1 cases get created, fire `webhook.dispatch({event: 'cms.case.escalated', payload: {...}})`. M10 handles delivery.

### 4.11 File-attachment storage

For the prototype: in-memory `Map<attachment_id, Buffer>` keyed on the metadata row. **Production swap point:** `AttachmentStorage` interface with `put(id, bytes)` / `get(id)` / `delete(id)`; the in-memory impl ships in CMS-3, an S3 impl can land later without touching the route handlers.

Virus-scan: pure-function `simulateVirusScan(file_name, mime_type)` for the prototype (returns `clean` for whitelisted types, `infected` for `.exe`/`.bat`, `pending` for unknowns). Production swap is ClamAV. Whitelist: `.pdf, .png, .jpg, .jpeg, .xlsx, .csv, .docx, .txt`.

---

## 5. Implementation sub-phases

| Commit | Scope | Test target |
|---|---|---|
| **CMS-1** (this commit) | Architecture mapping doc + types + DB migration (forward-looking schema) + minimal validator | ~30 |
| **CMS-2** | In-memory store: CRUD, state machine, assignment history, audit trail mirror, case-number generation | ~50 |
| **CMS-3** | 19 routes + audit + M9.4 case-event side-effects + SLA helpers + RBAC | ~60 |
| **CMS-4** | Auto-create-from-RED-alert wiring + round-robin + SLA breach surface + bulk-assign + virus-scan simulation + attachment storage | ~30 |
| **CMS-5** | SPA Kanban board + tabbed detail + bulk actions + Postman + README | ~20 |

Total ≈ 190 new tests on top of the existing 3155.

---

## 6. Open questions for sign-off (defaulting if no reply)

| # | Question | Default |
|---|---|---|
| Q1 | Path prefix `/v1/cms/cases/*` vs literal `/api/cases`? | `/v1/cms/cases/*` (project convention) |
| Q2 | Coexist with existing M9.1 `/v1/investigations/*` (don't deprecate) | YES — additive only |
| Q3 | Closed-case **lock** semantics — does reopen clear `is_locked`? | YES — reopen is the unlock path |
| Q4 | Round-robin algorithm: alphabetical position vs least-recently-assigned? | Least-recently-assigned (fairer load distribution) |
| Q5 | Auto-create from RED alert: enabled by default per tenant, or opt-in flag? | Opt-in flag stored in tenant config (M13.1 admin overrides) |
| Q6 | DB migration: prototype runtime stays in-memory (matches recent EWS work) or push for live PostgreSQL wire-up? | In-memory (matches prototype posture) |
| Q7 | Attachment max size: 20 MB per the brief; reject larger at the route layer | YES — 20 MB; spec-compliant |
| Q8 | Case_history vs M9.4 case_events journal: dedicated table or reuse? | **Hybrid**: write to BOTH so the dedicated `cms_case_history` table is queryable per-case AND the M9.4 cross-case journal is unchanged |

If you want different defaults, reply before CMS-2 and the doc will be updated first.
