# Recovery Center — Architecture + Adoption Guide

**Status:** Phase 1 shipped 2026-05-18; saved_report_filter adopted 2026-05-19.
**Wired services:** webhooks · saved scenarios · saved report filters · cms_case_attachments · auth-svc/{teams, team members, dashboard widgets, service clients, users}
**Deferred:** 7 candidate services (auth-svc + regulatory-svc + tenant) — see audit below

> **Attribution note (one-time):** Phase 1's 17 files (this doc included)
> were swept into commit `cc7cd61 feat(audit): T6 M15.16 — correlation
> duration histogram` by a parallel CC session running `git add .` at
> the moment I was about to commit. The work IS on `origin/main`; only
> the commit title is misleading. Verify with
> `git show cc7cd61 --stat | grep -E "recovery|RecycleBin"`. Subsequent
> Recovery Center adoptions land in their own commits.
>
> **Phase 2b attribution (one-time, 2026-05-19):** The
> `RecoveryArchiveClient` helper + 26 unit/e2e tests + the §"Caller
> pattern" doc update were similarly swept into commit `9c90b90
> feat(ai): T6 M7.17 — promotion request daily volume timeline` by
> the same parallel-`git add .` race. The work IS on `origin/main`;
> verify with `git show 9c90b90 --stat | grep -E "archive_client|recovery-center"`.
> (Phase 2a — the BFF endpoint itself — shipped cleanly in commit
> `445089b feat(recovery): Phase 2a — cross-service archive endpoint`.)
>
> **Phase 2e attribution (one-time, 2026-05-20):** The dashboard_widgets
> adoption (archive-on-PUT + restore dispatch + BFF adapter + 14
> auth-svc tests + 1 BFF e2e test) was swept into commit `980ec80
> feat(reports): T6 M12.17 — schedule cadence × format cross-tab
> matrix` by the same parallel-`git add .` race. The work IS on
> `origin/main`; verify with `git show 980ec80 --stat | grep -E "recovery|dashboard_widgets|auth_svc_restore"`.
> Earlier-phase commits in the same series: 2a/clean `445089b`, 2b/swept
> `9c90b90`, 2c/clean `e73e1e0`, 2d/swept-server.ts `21794bf` (full
> Phase 2d commit `b0f0557`).

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
| `GET` | `/v1/recovery/stats` | Summary tile for SPA header (totals + by-status + adapter list) |
| `GET` | `/v1/recovery/analytics?days=N` | **Phase 3 (2026-05-21).** Operator analytics over a trailing N-day window (default 30, bounds [1, 365]): daily archive/restore/purge volume timeline, top actors, per-entity_type rollup with `outstanding_delta` (archives − restores), per-module rollup, cohort-based `restore_rate` + `purge_rate`, mean/p50/p95 time-to-restore. 37 tests. SPA dashboard at `/admin/recovery-analytics` (admin-only, linked from Recycle Bin header) renders the full view with 7/30/90-day window picker, KPI strip, recharts daily-volume chart, cohort tile, top-actors / by-entity / by-module tables. 9 SPA tests. |
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

**Re-audited 2026-05-20** at the close of Phase 2. Two services
originally flagged as candidates (`regulatory-svc/cases`,
`regulatory-svc/alerts`) were re-classified into the "already
self-soft-deletes" category after investigating their actual delete
paths — see notes below. The Recovery Center pattern targets entities
that VANISH from the live store; entities that transition to a
terminal state but stay queryable are already soft-deleted by design.

### Already self-soft-deletes (no Recovery Center needed)

| Service | Why it's covered |
|---|---|
| `services/bff/src/admin/notification_templates_store.ts` | `deleted_at` + `status=ARCHIVED`; SPA shows archived under filter |
| `services/bff/src/admin/escalation_matrix_store.ts` | `archive()` method; SPA shows archived rules |
| `services/bff/src/admin/sla_config_store.ts` | `archive()` only (no DELETE at all by design) |
| `services/bff/src/admin/case_scenarios_store.ts` | `deleted_at` + restore via STATE_TRANSITION |
| `services/regulatory-svc/cases/*` | **Re-classified 2026-05-20.** State-machine soft-delete via the close lifecycle (`open → assigned → in_action → monitored → closed`). Closed cases stay in the store with `state='closed'` + a resolution category — fully queryable, no row disappears. The Recovery Center pattern doesn't apply. Operators "un-close" via the existing case lifecycle, not via the Recycle Bin. |
| `services/regulatory-svc/alerts/*` | **Re-classified 2026-05-20.** Same architectural pattern as cases: alerts transition `open → acked → closed` via the queue's state machine. There is no `DELETE` route, no `queue.delete()` method, and no path that removes a row from `app_alerts.alerts`. Queue assignments cascade via FK only when the parent alert is removed, which never happens. |

### Still hard-deletes — Recovery Center candidates

Each requires a separate ticket so the change can be reviewed in isolation.
Roughly in order of complexity:

| Service | Entity types | Notes |
|---|---|---|
| ✅ `services/bff/src/reports/saved_filters_store.ts` | `saved_report_filter` | **Adopted 2026-05-19** (commit follows this doc) |
| ✅ `services/bff/src/cms_store.ts` (attachments) | `cms_case_attachment` | **Adopted 2026-05-20 (Phase 2h).** BFF-local; DELETE /v1/cms/cases/:case_id/attachments/:attachment_id archives the row snapshot (including file_url + virus_scan_status) before delete. Restore re-inserts onto the parent case via `restoreAttachment()`; refuses (409) when an attachment with the same id already exists OR when the parent case is gone. 6 new tests. |
| ✅ `services/auth-svc/src/teams.ts` | `user_team` + `user_team_member` | **Archive (Phase 2c, 2026-05-19) + Restore (Phase 2d, 2026-05-20) both shipped — first end-to-end cross-service adopter.** Archive: `recovery_archive_client.ts` copy in auth-svc src/; both DELETE routes archive before deleting (best-effort posture). Restore: shared-secret-authed `POST /auth/recovery/restore` on auth-svc + BFF registers adapters that HTTP-call through `auth_svc_restore_client.ts`. Cascade limitation: restoring a member whose parent team is gone returns 409 (operator must restore the team first). 43 new tests total (10 archive + 15 auth-svc restore + 18 BFF adapter). |
| ✅ `services/auth-svc/src/dashboard_widgets.ts` | `role_dashboard_widget` | **Adopted 2026-05-20 (Phase 2e).** Semantic twist: no DELETE endpoint exists; the destructive op is `PUT /auth/dashboard-widgets/:role` which atomically replaces a role's layout. Adoption archives the PRIOR non-empty layout before each replace (treats layout snapshots as "soft deletes" — gives admins a rollback path for any layout edit, not just clears). Restore re-applies via `replaceForRole` and deliberately does NOT archive the overwrite (avoids Recycle Bin loops). 15 new tests (14 archive + 1 BFF adapter). |
| ✅ `services/auth-svc/src/service_clients.ts` | `service_client` | **Adopted 2026-05-20 (Phase 2f).** Security concern addressed via CONSERVATIVE restore semantic: regardless of the archive's `active` flag, restored clients ALWAYS come back with `active=false`. The preserved hash is audit-historic only — `find()` short-circuits on inactive so the credential cannot authenticate. Operators who want re-activation: delete the restored inactive row + re-create with the same id (new secret minted). 11 new auth-svc tests + 1 BFF e2e test. |
| ✅ `services/auth-svc/src/pg_user_store.ts` | `user` | **Adopted 2026-05-20 (Phase 2g).** Conservative restore mirroring Phase 2f: restored users always come back with `locked=true` + `must_change_password=true` regardless of the archived flags. The preserved password hash is audit-historic — admin must reset the password before the user can log in. **Cascade limitation:** sessions, team memberships, leave_covers, and password_reset tokens were CASCADE-deleted from pg and are NOT restored — operators rebuild memberships via the existing team-management routes after restoring. 13 new auth-svc tests. |
| ✅ `tenants` (bff) | `tenant` | **Adopted 2026-05-20 (Phase 2i).** BFF-local; `DELETE /v1/tenants/:tenant_id` archives the tenant config row before removing it from the in-memory registry. CONSERVATIVE SEMANTIC: restored tenants come back with `active=false` regardless of the archived flag — operators must `PATCH active=true` to bring the tenant back online (second-confirm gate for a high-blast-radius op). System-protected tenants (BANK_DEMO) are still refused before any archive happens, so they never appear in the Recycle Bin. Cascade-from-pg concern doesn't apply in the prototype: tenants live in the in-memory tenantLookup, not in pg with FKs from operational tables. Recovery rows live under the CALLER's tenant (a BANK_DEMO admin deleting BIL finds the recovery row in the BANK_DEMO Recycle Bin). 10 new tests. |

**Phase 2 is substantively complete.** All 10 adopters that actually
benefit from Recovery Center are wired:

- **5 BFF-local**: `webhook_subscription`, `saved_scenario`,
  `saved_report_filter`, `cms_case_attachment`, `tenant`
- **5 cross-service via BFF→auth-svc**: `user_team`, `user_team_member`,
  `role_dashboard_widget`, `service_client`, `user`

The cross-service architecture chose option (b) from the design
discussion: one `app_recovery.deleted_records` table for the platform.
Source services write to it via `POST /v1/svc/recovery/archive` with
an api-key scope (`recovery:archive_internal`); restore HTTP-calls
back via a shared-secret-authed `POST /auth/recovery/restore`
endpoint (env var `AUTH_SVC_RECOVERY_RESTORE_KEY` on both sides).
Conservative-restore-as-inert is the platform pattern for entities
with security implications (`service_client`, `user`, `tenant`):
restoration brings the row's audit-historic state back but the row
won't authenticate / accept traffic until an explicit admin action
flips it active again.

## Cross-service adoption (Phase 2a, 2026-05-19)

**Shipped:** the option-(b) write-side foundation — non-BFF services can
now archive into the central table over HTTP.

### Endpoint

```
POST /v1/svc/recovery/archive
```

- Auth: api-key bearer (`Authorization: Bearer apex_<prefix>.<secret>`).
- Required scope: `recovery:archive_internal` (M1.2 scope catalogue).
- Tenant: bound to the verified key. `X-Tenant-ID` override is ignored
  by api-key auth — a key issued to BIL cannot write into BANK_DEMO.
- Body (raw or `{header, body: …}` enveloped):
  ```json
  {
    "module": "auth-svc",      // 'auth-svc' | 'cases-svc' | 'alerts-svc' | 'rules-svc'
    "entity_type": "user_team",
    "original_id": "team-123",
    "original_table": "app_iam.user_teams",
    "payload": { "team_id": "team-123", "name": "Legal Mumbai", ... },
    "deleted_by": "svc:auth-svc",
    "deletion_reason": "team leader left",   // optional
    "source_action": "user_initiated",       // optional
    "prior_status": "active"                 // optional
  }
  ```
- `module: 'bff'` is **rejected** — in-process callers must call
  `recoveryStore.archive()` directly to save an HTTP loopback + keep
  audit attribution unambiguous.
- Response: `201 { recovery_id, archived: DeletedRecord }`. Every
  successful archive writes one `recovery.archive` event to the M15.1
  audit trail with `actor_role: 'service:<module>'` so audit filters
  can separate machine-driven archives from operator-driven.

### Provisioning a key

Admin mints a service-account key with the new scope:

```bash
curl -sS -X POST https://bff.example.com/v1/admin/api-keys \
  -H "Authorization: Bearer <admin_jwt>" \
  -H "X-Tenant-ID: BANK_DEMO" -H "X-Channel: API" \
  -H "Content-Type: application/json" \
  -d '{"name":"auth-svc archive","scopes":["recovery:archive_internal"]}'
```

The plaintext key is returned **once** in the create response; store
it in the source service's secret manager. Subsequent reads return
only the redacted prefix.

### Caller pattern (auth-svc example)

Use the typed `RecoveryArchiveClient` helper at
[`services/bff/src/recovery/archive_client.ts`](../services/bff/src/recovery/archive_client.ts) —
adopters copy this 240-line zero-dep file into their own `src/`. It
wraps the raw fetch with:

- type-safe `ArchiveRequest` shape so misspelled fields are caught at compile time
- client-side validation (catches typos before the round-trip)
- error mapping to typed `RecoveryArchiveError` (`invalid_input` / `invalid_api_key` / `missing_scope` / `server_error` / `network_error`)
- auto-retry on 502/503/504 + network errors (default 2 retries, back-off 100ms/400ms)
- per-request timeout (default 5s) via AbortController

```ts
import { RecoveryArchiveClient, RecoveryArchiveError } from './recovery/archive_client';

// One-time setup at boot.
const recovery = new RecoveryArchiveClient({
  baseUrl: process.env.BFF_BASE_URL!,           // 'https://bff.bil.local'
  apiKey:  process.env.BFF_RECOVERY_API_KEY!,   // 'apex_<prefix>.<secret>'
});

// In the delete path:
const team = await store.get(team_id);
try {
  await recovery.archive({
    module: 'auth-svc',
    entity_type: 'user_team',
    original_id: team.team_id,
    original_table: 'app_iam.user_teams',
    payload: team,                  // full row snapshot for restore
    deleted_by: actor_username,
    source_action: 'user_initiated',
  });
} catch (err) {
  // Best-effort: log + proceed. Archive failure shouldn't block the
  // user's delete. The Recovery Center silently loses this row, which
  // operators see in the archive count vs. expected mismatch.
  if (err instanceof RecoveryArchiveError) {
    console.warn(`[teams] archive failed (${err.code}): ${err.message}`);
  } else {
    console.warn('[teams] archive failed', err);
  }
}
// Proceed with local delete.
await store.delete(team_id);
```

Raw `fetch` works too if the source service doesn't want the dependency
— see `services/bff/src/recovery/archive_client.ts` for the exact wire
format (`POST /v1/svc/recovery/archive` with `Authorization: Bearer
apex_<prefix>.<secret>` + JSON body matching the `ArchiveRequest`
shape).

### Restore callback (Phase 2d, 2026-05-20)

The opposite direction — BFF → source service for restore — uses a
shared-secret env var instead of api-keys. Rationale: auth-svc would
otherwise need to mint+verify a BFF api-key of its own (round-trip
back to BFF for every restore), and the BFF is already the trust
anchor (it verified the operator's admin role via the M1.2
`recovery:restore` RBAC scope before invoking the adapter).

**Source-service side (auth-svc reference impl):**

1. Expose `POST /auth/recovery/restore` accepting
   `{entity_type, original_id, payload}` with `X-Recovery-Restore-Key`
   header verified against `AUTH_SVC_RECOVERY_RESTORE_KEY` env. When
   the env is unset, refuse all calls with 503 (fail-closed).
2. Dispatch by `entity_type` to per-entity restore handlers. Each
   handler:
   - 201 on success.
   - 409 on conflict (entity already exists in source store).
   - 404 when a parent record is missing (e.g. restoring a member
     when the team is gone — operator must restore the team first).
   - 400 on payload validation failure.
   - 400 with `error: 'unknown_entity_type'` when this service
     doesn't handle the requested entity_type.

**BFF side:**

1. Configure env vars `AUTH_SVC_BASE_URL` + `AUTH_SVC_RECOVERY_RESTORE_KEY`
   (the latter must match the source service's value).
2. `makeApp` auto-instantiates an `AuthSvcRestoreClient` from env and
   registers a `RecoveryAdapter` per entity_type that the source
   service handles. Each adapter HTTP-calls the source service's
   restore endpoint via the client.
3. When the env vars are unset, no adapters are registered. The SPA
   Restore button returns 501 `no_adapter` — the correct fail-closed
   posture for a misconfigured environment.

**Cascade limitation:** restore is one-row-at-a-time. If a deleted
parent had child rows that were also archived (team + members), the
operator restores them in dependency order. Member restore against a
missing team returns 409 `restore_conflict` with `parent_team_id` in
the error detail so the SPA can highlight the team to restore first.

### Restore for cross-service entities

The archive side is now plumbed. **Restore still requires a per-entity
adapter** registered in BFF that HTTP-calls back to the source
service's restore endpoint. Each remaining adopter ticket includes:

1. Source service: add a `restore(payload)` method to its store
2. Source service: expose `POST /<resource>/restore` (api-key gated
   with a matching `recovery:restore_internal` scope — to ship in
   Phase 2b)
3. BFF: register a `RecoveryAdapter` for the entity_type that fetches
   the source service over HTTP and invokes the restore endpoint

Tickets in order: `auth-svc/teams` (smallest cascade) →
`auth-svc/dashboard_widgets` → `auth-svc/service_clients` (security
review required) → `auth-svc/pg_user_store` →
`regulatory-svc/cases` → `regulatory-svc/alerts` → `tenants`.

## Known limitations (Phase 1)

| | |
|---|---|
| ~~Auto-purge after 30 days~~ | **Shipped 2026-05-19**: `POST /v1/recovery/purge-expired?days=N` (admin only, tenant-scoped, idempotent). No in-process timer — operators wire to an external scheduler (k8s CronJob / pg_cron / GitHub Actions). Default 30 days; bounds [0, 3650]. Response: `{removed, cutoff, days, tenant_id}`. See "Auto-purge scheduling" below. |
| Cross-tenant restore | Restoring restores into the row's original tenant; cross-tenant copies not supported. |
| Cascade restore | If a parent record had child rows that were also deleted, restoring the parent alone won't bring back the children. Each entity must register its own adapter and the SPA user restores them in order. |
| ~~Audit-event cross-reference~~ | **Shipped 2026-05-19**: every archive / restore / purge writes a `recovery.archive` / `recovery.restore` / `recovery.purge` event to `app_iam.audit_events` via the M15.1 audit trail store. `resource_type='system'`, severity `info` for archive/restore and `warning` for purge. Metadata: `{entity_type, original_id, original_table, module, deleted_by, deleted_at, restored_at?, restored_by?, purged_at?, purged_by?}`. Best-effort — audit failures never block the recovery op. Visible in `/admin/audit-log` + M15.x analytics. |

## Auto-purge scheduling

`POST /v1/recovery/purge-expired?days=30` hard-deletes recovery rows
whose `purged_at` is older than `days`. Idempotent + tenant-scoped, so
multiple invocations (across BFF instances or multiple cron firings)
do no harm.

**No in-process timer is shipped.** Multi-instance deployments would
otherwise race the same DELETE. Pick ONE of:

### k8s CronJob (recommended for prod)

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: recovery-purge-bank-demo
spec:
  schedule: "30 3 * * *"            # 03:30 UTC daily
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: curl
              image: curlimages/curl:latest
              command:
                - sh
                - -c
                - >
                  curl -sS -X POST http://bff:8084/v1/recovery/purge-expired
                  -H "Authorization: Bearer $BFF_ADMIN_TOKEN"
                  -H "X-Tenant-ID: BANK_DEMO" -H "X-Channel: API"
                  -H "X-Source-System: recovery-purge-cron"
                  -H "x-apex-role: admin"
                  -H "x-apex-user: recovery-purge-cron"
              env:
                - name: BFF_ADMIN_TOKEN
                  valueFrom:
                    secretKeyRef:
                      name: recovery-purge
                      key: token
```

One CronJob per tenant. The endpoint is tenant-scoped via the header,
so no cross-tenant fan-out from a single job.

### pg_cron (lighter-weight, skips the HTTP hop)

```sql
SELECT cron.schedule(
  'recovery-purge-daily',
  '30 3 * * *',
  $$DELETE FROM app_recovery.deleted_records
     WHERE purged_at IS NOT NULL
       AND purged_at < now() - INTERVAL '30 days'$$
);
```

This bypasses the BFF entirely. The endpoint stays as the manual /
ad-hoc trigger (admins can run it from the Recovery Center page when
needed).

### Manual (operator-on-demand)

```sh
curl -X POST http://localhost:8084/v1/recovery/purge-expired?days=30 \
  -H "X-Tenant-ID: BANK_DEMO" -H "X-Channel: API" -H "x-apex-role: admin"
# → {"body":{"removed":N,"cutoff":"2026-04-19T...","days":30,"tenant_id":"BANK_DEMO"}}
```

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
