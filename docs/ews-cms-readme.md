# EWS Case Management System — Operator Guide

The day-to-day reference for risk operators, supervisors, and admins working in the CMS. For the architectural design + the gap analysis vs. the existing M9.x case surface, see [`ews-cms-mapping.md`](./ews-cms-mapping.md).

## What this CMS does

Drives alert-resolution workflow end to end:

1. RED alerts auto-create a case (or analyst creates one manually).
2. The case lands `OPEN`, gets assigned (round-robin from the pool, or manually), and walks through `ASSIGNED → INVESTIGATING → PENDING_APPROVAL → CLOSED`.
3. At any non-CLOSED state, an operator can **escalate** to a supervisor.
4. After CLOSED, the case is **locked** — read-only — until someone explicitly **reopens** it (which clears the lock + recomputes the SLA).
5. Every mutation writes both an audit-trail event and an M9.4 case-event journal entry, so cross-case downstream consumers see one stream.

## Where things live

| Concern | Path |
|---|---|
| Types + state machine + validators | `services/bff/src/cms_cases.ts` |
| In-memory store + sub-stores | `services/bff/src/cms_store.ts` |
| Auto-create + pool + inactive-case detection | `services/bff/src/cms_automation.ts` |
| Routes (23) | `services/bff/src/server.ts` (search "EWS Case Management System (CMS-3)") |
| DB migration | `data/schema/013_cms_cases.sql` |
| SPA list page | `web/src/modules/cms/CmsCaseListPage.tsx` (route `/cms/cases`) |
| SPA kanban page | `web/src/modules/cms/CmsCaseKanbanPage.tsx` (route `/cms/cases/kanban`) |
| SPA detail page | `web/src/modules/cms/CmsCaseDetailPage.tsx` (route `/cms/cases/:id`) |
| Postman | `docs/ews-cms-postman.json` |
| Architecture mapping | `docs/ews-cms-mapping.md` |

## Lifecycle

```
OPEN ──assign──▶ ASSIGNED ──begin──▶ INVESTIGATING ──submit──▶ PENDING_APPROVAL ──approve──▶ CLOSED
                                  ↘ escalate ↗  ESCALATED                                       │
                                                  │                                              │
                                                  └──de-escalate──▶ INVESTIGATING               │
                                                                                                 │
                                            CLOSED ──reopen──▶ OPEN  (lock cleared, SLA reset) ◀┘
```

The **bare `CLOSED` transition is rejected** — operators must POST to `/v1/cms/cases/:id/close` with `resolution_category` + `resolution_notes`. This guarantees every closed case carries a resolution record.

## Priorities + SLA

| Priority | Mapped severity | SLA window | Mapped from auto-create alert |
|---|---|---|---|
| P1 | critical | 4 hours | `RED` / `critical` |
| P2 | high | 24 hours | `ORANGE` / `high` |
| P3 | medium | 72 hours | `YELLOW` / `medium` |
| P4 | low | 7 days | `GREEN` / `low` |

`sla_due_at = created_at + sla_window(priority)`. Recomputed on **reopen** (anchor=now) and on **priority change** during update (anchor=original created_at, so re-prioritising doesn't reset the clock).

## How to do common things

### Author a case manually

```bash
curl -X POST $BFF/v1/cms/cases \
  -H "X-Tenant-ID: BIL" -H "X-Channel: API" \
  -H "X-APEX-USER: compliance.lead" -H "x-apex-role: admin" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Customer cust-001 KYC overdue",
    "description": "KYC docs expired 45 days ago",
    "priority": "P3",
    "alert_id": "alrt-001",
    "tags": ["kyc"]
  }'
```

The case lands `OPEN` (or `ASSIGNED` if `assigned_to` was supplied).

### Auto-create from a RED alert

```bash
curl -X POST $BFF/v1/cms/automation/auto-create-from-alert \
  -H "X-Tenant-ID: BIL" -H "X-Channel: API" \
  -H "X-APEX-USER: system" -H "x-apex-role: admin" \
  -H "Content-Type: application/json" \
  -d '{
    "alert_id": "alrt-001",
    "alert_severity": "RED",
    "customer_id": "cust-001",
    "rule_id": "RULE_CREDIT_001",
    "rule_name": "High EMI Bounce Risk"
  }'
```

**Idempotent on `alert_id`**: re-firing returns the existing case (`created: false`, `matched_case_id: ...`) instead of duplicating. Pool[0] becomes the initial assignee when set.

### Set the assignee pool (admin)

```bash
curl -X PUT $BFF/v1/cms/automation/pool \
  -H "X-Tenant-ID: BIL" -H "X-Channel: API" \
  -H "X-APEX-USER: admin" -H "x-apex-role: admin" \
  -H "Content-Type: application/json" \
  -d '{ "members": ["alice", "bob", "carol"] }'
```

Cap 50 members; duplicates and empty strings rejected.

### Round-robin assign

```bash
curl -X POST $BFF/v1/cms/cases/<case_id>/assign-from-pool \
  -H "X-Tenant-ID: BIL" -H "X-Channel: API" -H "x-apex-role: admin"
```

Rotates through the pool deterministically. `409 pool_empty` if the tenant pool is empty.

### Walk a case to CLOSED

```bash
# 1. Assign manually (or use /assign-from-pool)
curl -X POST $BFF/v1/cms/cases/<id>/assign \
  -d '{ "assigned_to": "jane.analyst" }' …

# 2. Start investigating
curl -X POST $BFF/v1/cms/cases/<id>/transition \
  -d '{ "target": "INVESTIGATING" }' …

# 3. Submit for approval
curl -X POST $BFF/v1/cms/cases/<id>/transition \
  -d '{ "target": "PENDING_APPROVAL" }' …

# 4. Close with resolution
curl -X POST $BFF/v1/cms/cases/<id>/close \
  -d '{ "resolution_category": "mitigated",
        "resolution_notes": "Customer settled" }' …
```

After step 4 the case is **locked**. Reopen with:

```bash
curl -X POST $BFF/v1/cms/cases/<id>/transition \
  -d '{ "target": "OPEN" }' …
```

### Add notes + attachments

```bash
curl -X POST $BFF/v1/cms/cases/<id>/notes \
  -d '{ "note_text": "Met customer at branch", "is_internal": false }' …

curl -X POST $BFF/v1/cms/cases/<id>/attachments \
  -d '{ "file_name": "evidence.pdf",
        "file_size": 1024,
        "mime_type": "application/pdf" }' …
```

**Allowed mime types**: PDF, PNG, JPEG, XLSX, CSV, DOCX, TXT. **Max size**: 20 MB. Anything else returns `415 invalid_mime_type` or `400 file_size`. The prototype simulates virus-scan: `.exe/.bat/.scr` files set `virus_scan_status: 'infected'`; whitelisted mimes get `clean`.

### Surface SLA breaches + inactive cases

```bash
# Cases past sla_due_at
curl $BFF/v1/cms/cases/sla-breaches …

# Cases with no update in 48 hours
curl $BFF/v1/cms/automation/inactive-cases?threshold_hours=48 …
```

Both routes return cases sorted by overshoot/inactive-time DESC.

### Bulk operations

```bash
curl -X POST $BFF/v1/cms/cases/bulk-assign \
  -d '{ "case_ids": ["id1", "id2"], "assigned_to": "carol" }' …
```

Returns mixed per-row outcomes (`ok` / `unknown_case` / `case_locked` / `invalid_input`). Cap 100 case_ids.

## SPA pages

Open the SPA at http://localhost:5173 and navigate to:

- **`/cms/cases`** — filterable list with bulk-select + bulk-assign, search, status/priority/assignee filters, stat cards (total / SLA breached / SLA warning / open+investigating).
- **`/cms/cases/kanban`** — 6 columns (OPEN / ASSIGNED / INVESTIGATING / PENDING_APPROVAL / ESCALATED / CLOSED) with quick-action arrow buttons on each card. SLA-breached cards show a red `⚠ SLA breached` chip; warning cards show an amber `🕒 SLA warn` chip. Click any case# link to open the detail page.
- **`/cms/cases/:id`** — tabbed detail (Overview / Investigation / Timeline / Related). Right sidebar has Quick Actions: assign, transition shortcut, escalate (with reason), close (with resolution form). Closed cases show only a "Reopen" button.

## RBAC

| Role | List | Mutate | History |
|---|---|---|---|
| `risk_analyst` (`cases:list`) | only assigned-to-self via `?assigned_to=` | yes on assigned cases | requires `audit:read` |
| `supervisor` (`cases:list`) | team cases | yes | yes |
| `admin` | all | yes | yes |

Closed-case lock applies to ALL roles — only **reopen** is allowed on a CLOSED case.

## Audit + telemetry

Every mutation writes:

1. **Audit-trail event** queryable via `/v1/audit/events?resource_id=<case_id>` with action `case.{create|update|transition|assign|escalate|close|reopen|note_added|attachment_added|attachment_deleted}`.
2. **M9.4 case-event journal entry** appended to `/v1/cases/events` (the existing journal — CMS-3 reuses it instead of forking) with `actor: cms:<X-APEX-USER>` and a journal-action enum value (`opened` / `state_change` / `escalated` / `closed` / `note_added`).

Telemetry writes are wrapped in try/catch — they cannot break a mutation if a downstream store is unavailable.

## Caps + retention

| Resource | Cap | Eviction |
|---|---|---|
| Cases | 1000 / tenant | error on overflow |
| Notes | 50 / case | FIFO |
| Attachments | 50 / case | FIFO |
| Assignment history | 50 / case | FIFO |
| Per-case audit history | 200 / case | FIFO |
| Assignee pool | 50 members / tenant | error on overflow |
| Bulk-assign request | 100 case_ids | error |

## DB schema (forward-looking)

Per the architecture RFC, the prototype runtime is in-memory. Production deployment swaps in PostgreSQL via `data/schema/013_cms_cases.sql`. 5 new tables under `app_cases.cms_*`:

- `cms_cases` — composite UNIQUE on `(tenant_id, case_number)`; CHECK constraints keep `status ↔ is_locked ↔ resolution_category` in lock-step.
- `cms_case_notes`, `cms_case_attachments` (with virus_scan_status), `cms_case_assignments` (FIFO history), `cms_case_history` (per-case immutable audit slice).

The existing `app_cases.cases` / `actions` / `cas_records` / `caps` tables are **not touched** — this is a parallel surface.

## Postman quickstart

Import `docs/ews-cms-postman.json` into Postman. Variables: `baseUrl` (default `http://localhost:8084`), `tenantId`, `channel`, `apexUser`, `apexRole`, `caseId` (set after step 2), `alertId`. Run requests 0–22 in order to walk a case through the full lifecycle.

## Related docs

- [`ews-cms-mapping.md`](./ews-cms-mapping.md) — architecture, gap analysis, sub-phase plan
- [`ews-rules-engine-readme.md`](./ews-rules-engine-readme.md) — the parallel EWS rules engine that fires alerts which become CMS cases
