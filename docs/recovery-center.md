# Recovery Center — Architecture + Adoption Guide

**Status:** Phase 1 shipped 2026-05-18; saved_report_filter adopted 2026-05-19.
**Wired services:** webhooks · saved scenarios · saved report filters
**Deferred:** 7 candidate services (auth-svc + regulatory-svc + tenant) — see audit below

> **Attribution note (one-time):** Phase 1's 17 files (this doc included)
> were swept into commit `cc7cd61 feat(audit): T6 M15.16 — correlation
> duration histogram` by a parallel CC session running `git add .` at
> the moment I was about to commit. The work IS on `origin/main`; only
> the commit title is misleading. Verify with
> `git show cc7cd61 --stat | grep -E "recovery|RecycleBin"`. Subsequent
> Recovery Center adoptions land in their own commits.

## What this is

Centralised soft-delete + recovery for ZorEWS. Any service that adopts the
pattern archives a copy of the row into `app_recovery.deleted_records`
BEFORE the destructive operation, so the row is recoverable via the
`/v1/recovery` API and the SPA `/admin/recycle-bin` page.

## Architecture

```
   ┌──────────────────┐     archive()      ┌──────────────────────┐
   │  Service store   │  ────────────────► │  RecoveryStore       │
   │ (e.g.            │  before DELETE     │  app_recovery.       │
   │  webhookStore,   │                    │  deleted_records     │
   │  scenarioStore)  │                    └──────────────────────┘
   └──────────────────┘                                │
                                                       │ restore() looks up
                                                       │ adapter by entity_type
                                                       ▼
                                          ┌──────────────────────┐
                                          │  RecoveryAdapter     │
                                          │  (per entity_type;   │
                                          │   registered at      │
                                          │   server boot)       │
                                          └──────────────────────┘
                                                       │
                                                       │ re-inserts payload
                                                       ▼
                                          ┌──────────────────────┐
                                          │  Original service    │
                                          │  store.restore(row)  │
                                          └──────────────────────┘
```

## Storage

```sql
CREATE TABLE app_recovery.deleted_records (
    recovery_id     UUID PRIMARY KEY,
    tenant_id       TEXT NOT NULL,
    module          TEXT NOT NULL,           -- 'bff' / 'auth-svc' / 'cases-svc' / 'alerts-svc'
    entity_type     TEXT NOT NULL,           -- 'webhook_subscription' / 'saved_scenario' / ...
    original_id     TEXT NOT NULL,           -- the original PK (stringified)
    original_table  TEXT NOT NULL,           -- 'app_bff.webhook_subscriptions' etc.
    payload         JSONB NOT NULL,          -- full row snapshot
    deleted_by      TEXT NOT NULL,
    deleted_at      TIMESTAMPTZ NOT NULL,
    deletion_reason TEXT,
    source_action   TEXT,
    prior_status    TEXT,
    restored_at     TIMESTAMPTZ, restored_by TEXT,
    purged_at       TIMESTAMPTZ, purged_by   TEXT
);
```

Status is derived:
- both NULL → **archived** (recoverable)
- restored_at NOT NULL → **restored** (live again)
- purged_at NOT NULL → **purged** (audit-only, irreversible)

Mutually exclusive — enforced by CHECK constraint.

## API surface (BFF, all admin-only)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/recovery?status=&module=&entity_type=&deleted_by=&since=&until=&page=&page_size=` | List deleted records (tenant-scoped) |
| `GET` | `/v1/recovery/stats` | Summary tile for SPA header |
| `GET` | `/v1/recovery/:recovery_id` | Single record with full payload |
| `POST` | `/v1/recovery/:recovery_id/restore` | Restore — re-insert with original ID. 409 on conflict. |
| `DELETE` | `/v1/recovery/:recovery_id` | Permanent purge (irreversible) |

RBAC: `recovery:list` / `recovery:restore` / `recovery:purge` — all admin-only in Phase 1.

## Adopting the pattern (for new service deletes)

Two surfaces to change per service:

### 1. Add a `restore()` method to your store

Both impls (in-memory + pg) need it. Re-inserts the payload with its original ID. Return `false` on conflict.

```ts
// in YourStore class
restore(row: YourRowType): boolean {
  if (this.byId.has(row.id)) return false;
  this.byId.set(row.id, { ...row });
  // pg impl: INSERT ... ON CONFLICT DO NOTHING
  return true;
}
```

### 2. Register a RecoveryAdapter at server boot

In `server.ts` `makeApp()`:

```ts
registerRecoveryAdapter({
  entity_type: 'your_entity',
  display_name: 'Your entity',
  module: 'bff',  // or 'auth-svc' / 'cases-svc' / ...
  original_table: 'app_yours.your_table',
  restore: async (record) => {
    const ok = yourStore.restore(record.payload as YourRowType);
    if (!ok) throw new RestoreConflictError('your_entity', record.original_id);
  },
});
```

### 3. Archive at the DELETE route handler

Capture the full row BEFORE deletion + push to recovery:

```ts
app.delete('/v1/your-entity/:id', requireTenantMw, requireRole('your:delete'), async (req, res) => {
  const ctx = extractCtx(req, now);
  const id = req.params.id;
  const tenant_id = req.tenant!.tenant_id;
  const existing = yourStore.get(id, tenant_id);
  if (!existing) return res.status(404).json(wrapError({ code: 'EWS_404', ... }, ctx));
  try {
    await recoveryStore.archive({
      tenant_id,
      module: 'bff',
      entity_type: 'your_entity',
      original_id: id,
      original_table: 'app_yours.your_table',
      payload: existing as Record<string, unknown>,
      deleted_by:
        ((req.headers['x-apex-user'] as string | undefined) ?? '').trim() || 'admin',
      source_action: 'user_initiated',
      prior_status: existing.status,  // optional snapshot for the SPA
    });
  } catch (err) {
    // Archive failure is non-blocking — log + continue
    console.error('[recovery] archive failed for your-entity', id, err);
  }
  yourStore.delete(id, tenant_id);
  res.status(204).end();
});
```

That's it. The SPA `/admin/recycle-bin` page automatically picks up new
entity_types (filter chips render from the live `adapters` list).

## Backlog (services NOT yet wired)

**Audited 2026-05-19** — only 6 services actually hard-delete and would
benefit from Recovery Center. The 4 BFF admin stores below all have
their OWN per-table soft-delete via `deleted_at` + status=ARCHIVED and
expose a "Show archived" toggle on their SPA admin page. Adding
Recovery Center on top would duplicate the same archive in two
places. Cross-reference: see the `archive()` method on each.

### Already self-soft-deletes (no Recovery Center needed)

| Service | Why it's covered |
|---|---|
| `services/bff/src/admin/notification_templates_store.ts` | `deleted_at` + `status=ARCHIVED`; SPA shows archived under filter |
| `services/bff/src/admin/escalation_matrix_store.ts` | `archive()` method; SPA shows archived rules |
| `services/bff/src/admin/sla_config_store.ts` | `archive()` only (no DELETE at all by design) |
| `services/bff/src/admin/case_scenarios_store.ts` | `deleted_at` + restore via STATE_TRANSITION |

### Still hard-deletes — Recovery Center candidates

Each requires a separate ticket so the change can be reviewed in isolation.
Roughly in order of complexity:

| Service | Entity types | Notes |
|---|---|---|
| ✅ `services/bff/src/reports/saved_filters_store.ts` | `saved_report_filter` | **Adopted 2026-05-19** (commit follows this doc) |
| `services/auth-svc/src/teams.ts` | `user_team` + `user_team_member` | Hierarchy; restore must handle members. Cross-service: needs auth-svc to either own its own RecoveryStore OR call BFF's via HTTP. |
| `services/auth-svc/src/dashboard_widgets.ts` | `role_dashboard_widget` | Per-role array; care needed. Cross-service. |
| `services/auth-svc/src/service_clients.ts` | `service_client` | Has secret hash — restore re-introduces a revoked OAuth client. Security review needed. Cross-service. |
| `services/auth-svc/src/pg_user_store.ts` | `user` | High blast radius (FK to sessions, audit, teams); restore semantics need design. Cross-service. |
| `services/regulatory-svc/cases/...` | `case` + cascade | Big — cases own actions, notes, attachments, CAS, CAP. Cross-service. |
| `services/regulatory-svc/alerts/...` | `alert` + `queue_assignment` | Cascade implications. Cross-service. |
| `tenants` (bff) | `tenant` | Cascades to EVERYTHING; restore would need ordered re-insert of dependent rows |

The 5 auth-svc + 2 regulatory-svc entries need architectural work first:
Recovery Center lives in BFF. Either (a) each service gets its own
local Recovery Center + a unified "view all" endpoint that aggregates,
or (b) the BFF exposes an internal API that other services call to
archive. (b) is the cleanest centralisation — keep one
`app_recovery.deleted_records` table for the platform.

## Known limitations (Phase 1)

| | |
|---|---|
| Auto-purge after 30 days | Not implemented. Records stay until manually purged. A nightly job that runs `DELETE FROM app_recovery.deleted_records WHERE purged_at < now() - INTERVAL '30 days'` is a separate follow-up. |
| Cross-tenant restore | Restoring restores into the row's original tenant; cross-tenant copies not supported. |
| Cascade restore | If a parent record had child rows that were also deleted, restoring the parent alone won't bring back the children. Each entity must register its own adapter and the SPA user restores them in order. |
| Audit-event cross-reference | The Recovery row does NOT auto-write to `app_iam.audit_events`. A future ticket can wire `recoveryStore.archive()` to ALSO emit an audit event with `event_type='record_archived'`. |

## Validation commands

```sh
# Check the schema is applied
PGPASSWORD=apex psql -h localhost -p 5432 -U zorews_user -d zorews \
  -c "\dt app_recovery.*"

# See recent deletes (last 24h)
PGPASSWORD=apex psql -h localhost -p 5432 -U zorews_user -d zorews -c "
SELECT entity_type, original_id, deleted_by, deleted_at
  FROM app_recovery.deleted_records
 WHERE deleted_at > now() - INTERVAL '1 day'
 ORDER BY deleted_at DESC LIMIT 20;"

# Manual restore via curl (admin token)
curl -X POST http://localhost:8084/v1/recovery/<recovery_id>/restore \
  -H "X-Tenant-ID: BANK_DEMO" -H "X-Channel: API" -H "x-apex-role: admin" \
  -H "x-apex-user: ops.engineer"
```
