# Unified View Layer — Design

**Date:** 2026-05-21
**Status:** Approved (brainstorming complete; implementation plan pending)
**Decision authority:** Project owner
**Companion:** `docs/database-schema.md` (live schema reference)

---

## 1. Goal

Expose a single read-only `unified.*` PostgreSQL schema that flattens the most-common cross-schema joins (alerts × cases × customer_360 × audit) for SPA reporting, ad-hoc DBeaver queries, and onboarding visibility — **without** disturbing the underlying schemas, the dbt medallion pipeline, the WORM audit chain, or the per-service write boundaries shipped in T4.13–T4.18.

This is **additive only**. No data migration. No service rewrites in v1. Rollback is `DROP SCHEMA unified CASCADE`.

## 2. Non-goals

- **No schema consolidation** of `raw` / `staging` / `mart` / `audit` / `app_*`. They stay as-is.
- **No write paths** through the unified layer. No `INSTEAD OF` triggers. No view-mediated INSERTs. Services keep writing to their owned schemas via existing `PgStore`s (T4.13–T4.18).
- **No dbt entanglement.** dbt continues to own `staging` + `mart` only. `unified` is plain SQL.
- **No ORM rewrites in v1.** Existing repository code keeps reading from owned schemas. Migrating individual stores to read from `unified.*` happens ticket-by-ticket in v1.5+.
- **No materialized views.** Plain `CREATE VIEW` only — always-live, zero refresh cost, zero write tax on underlying tables.
- **No Row-Level Security.** App-layer tenant filtering (T4.24 Phase 4–13) is the contract; views expose `tenant_id` as a column for explicit WHERE filtering.

## 3. Architecture overview

```
                            +-------------------------+
   DBeaver / ad-hoc SQL --> |   unified.*  (v1)       |
   SPA reporting queries    |   - customer_360        |
   T4.6 builder catalog ----|   - alerts              |
   (v1.5)                   |   - cases               |
                            |   - audit_activity      |
                            +-----------+-------------+
                                        | plain VIEW (always-live)
                                        v
       +-------------------+   +------------------+   +-----------------------+
       | mart.*  (dbt)     |   |  app_alerts.*    |   | audit.event_log       |
       | mart.customer_360 |<--|  app_cases.*     |-->| (WORM hash chain)     |
       | mart.loan_360     |   |  app_audit.*     |   | app_iam.audit_events  |
       | mart.txn_features |   |  app_bff.*       |   |                       |
       +-------------------+   +------------------+   +-----------------------+
                  ^                      ^                       ^
                  | dbt run              | PgStores (T4.13–T4.18) | hash-chain trigger
                  |                      |                       |
       +----------+-------+   +----------+-------+   +-----------+-----------+
       | raw / staging    |   | BFF services     |   | auth-svc + cases      |
       +------------------+   +------------------+   +-----------------------+
```

Reads flow up. Writes flow into the underlying schemas exactly as today. The unified layer never participates in a write.

## 4. Schema name

**`unified`** (bare, no prefix).

| Considered | Verdict | Reason |
|---|---|---|
| `unified` | ✅ Selected | Short. Reads as "across all owned namespaces". DBeaver list stays clean (sorts after `staging`, before nothing). |
| `app_unified` | Pass | Redundant ("app" + "unified"); slight visual clustering benefit with `app_*` not worth the prefix. |
| `zorews` / `zorews_unified` | Pass | DB is already `apex_ews`; branded prefix adds nothing. |
| `public` | ❌ Rejected | Pollutes the default search_path; convention is to keep `public` empty. |

## 5. The 4 views (v1)

All views expose `tenant_id` as a first-class column. Filtering is the caller's responsibility (matches every other PgStore in the codebase).

Column names below match the **live** column names in the source tables (confirmed against `data/schema/004_app_schemas.sql`, `003_audit_table.sql`, `006_audit_tenant.sql`, `007_app_tenant.sql`, `008_cases_tenant.sql`, `009_alerts_tenant.sql`, `010_mart_tenant.sql`, and the T4.19 `app_audit.approvals` definition). Implementation may discover further mart projections via `dbt run` output that should be considered for inclusion.

### 5.0 Conventions every `unified.*` view follows

These rules are normative — implementation MUST conform and the pg integration test asserts the shape rules where automatable.

**Column ordering (left-to-right):**
1. `tenant_id` — always first
2. Primary identity column(s) — `customer_id` / `alert_id` / `case_id` / `(source, event_id)`
3. Foreign identity columns — `customer_id` on alerts/cases; `alert_id` on cases
4. Natural attributes — `name`, `severity`, `status`, `state`, `outcome`, ...
5. Denormalised joined attributes — `customer_risk_level`, `customer_pd_score`, ...
6. Aggregate counts — `open_alerts_count`, `action_count`, ...
7. Latest-event timestamps — `latest_alert_at`, `last_action_at`, ...
8. Lifecycle timestamps — `created_at`, `updated_at`, `closed_at`, `acked_at`

**Column-name suffix conventions:**

| Suffix | Type | Example |
|---|---|---|
| `_at` | `TIMESTAMPTZ` | `created_at`, `latest_alert_at`, `last_activity_at` |
| `_count` | `INTEGER` (always `COALESCE(..., 0)` to avoid NULL arithmetic) | `open_alerts_count`, `pending_approvals_count` |
| `_kes` | `NUMERIC` monetary in Kenyan Shillings | `customer_exposure_kes`, `customer_total_exposure_kes` |
| `_score` | `NUMERIC` dimensionless rating | `criticality_score`, `pd_score` |
| `_id` | `TEXT` business identifier (NOT `event_id`'s `BIGSERIAL` — that's cast to TEXT for cross-source union) | `customer_id`, `alert_id`, `case_id` |

**Boolean naming:** `is_*` for instantaneous state predicates, `has_*` for relationships/possessions. The original `has_blocking_caps` is renamed to **`has_blocking_caps`** to conform (and reads more naturally — "this case has CAPs that block close" vs. "this case is blocking close").

**NULL handling:**
- Counts (`*_count`) — `COALESCE(..., 0)` so SUM/AVG behave predictably
- Joined attributes (e.g. `customer_pd_score` via LEFT JOIN) — leave NULL when underlying row absent (caller distinguishes "0 PD" from "unknown PD")
- Latest-event timestamps — NULL when there are no events of that type (do NOT `COALESCE(..., epoch)`)

**SQL alias conventions in DDL** (use throughout for grep-friendly cross-view consistency):

| Alias | Source |
|---|---|
| `m` | `mart.customer_360` (or any other mart table) |
| `a` | `app_alerts.alerts` |
| `c` | `app_cases.cases` |
| `act` | `app_cases.actions` |
| `cas` | `app_cases.cas_records` |
| `cap` | `app_cases.caps` |
| `ap` | `app_audit.approvals` |
| `e` | `audit.event_log` |
| `ae` | `app_iam.audit_events` |

**Identity tuple per view** (the ORM-recognisable "primary key" of each read-only entity):

| View | Identity tuple |
|---|---|
| `unified.customer_360` | `(tenant_id, customer_id)` |
| `unified.alerts` | `alert_id` (already globally unique; `tenant_id` is denormalised) |
| `unified.cases` | `case_id` (deterministic hash includes alert + customer; globally unique) |
| `unified.audit_activity` | `(source, event_id)` — `event_id` is unique within source but not across sources |

### 5.1 `unified.customer_360`

One row per `(tenant_id, customer_id)`. SPA dashboard hot-path.

```sql
CREATE VIEW unified.customer_360 AS
SELECT
    m.tenant_id,
    m.customer_id,
    m.name,
    m.risk_level,                                  -- Low / Medium / High (dbt-derived)
    m.pd_score,
    m.exposure_kes,
    m.worst_dpd                  AS dpd,
    m.kyc_status,
    m.segment,
    m.onboarded_at,
    COALESCE(a.open_alerts_count, 0)         AS open_alerts_count,
    a.max_criticality_score,
    a.latest_alert_at,
    COALESCE(c.open_cases_count, 0)          AS open_cases_count,
    COALESCE(c.breached_sla_count, 0)        AS breached_sla_count,
    COALESCE(ap.pending_approvals_count, 0)  AS pending_approvals_count,
    GREATEST(a.latest_alert_at, c.last_case_updated_at, m.last_updated_at) AS last_activity_at
FROM mart.customer_360 m
LEFT JOIN LATERAL (
    SELECT
        COUNT(*) FILTER (WHERE status = 'open')                              AS open_alerts_count,
        MAX(criticality_score) FILTER (WHERE status = 'open')                AS max_criticality_score,
        MAX(created_at)                                                       AS latest_alert_at
    FROM app_alerts.alerts
    WHERE tenant_id = m.tenant_id AND customer_id = m.customer_id
) a ON true
LEFT JOIN LATERAL (
    SELECT
        COUNT(*) FILTER (WHERE state <> 'closed')                            AS open_cases_count,
        COUNT(*) FILTER (WHERE sla_status IN ('approaching','breached'))     AS breached_sla_count,
        MAX(updated_at)                                                       AS last_case_updated_at
    FROM app_cases.cases
    WHERE tenant_id = m.tenant_id AND customer_id = m.customer_id
) c ON true
LEFT JOIN LATERAL (
    SELECT COUNT(*) AS pending_approvals_count
    FROM app_audit.approvals
    WHERE correlation_id IN (
        SELECT case_id FROM app_cases.cases
        WHERE tenant_id = m.tenant_id AND customer_id = m.customer_id
    )
    AND status = 'pending'
) ap ON true;
```

**Notes:**
- `app_audit.approvals.tenant_id` is **not yet a column** (T4.20 shipped 2026-05-03, before T4.24 Phase 3 added tenant_id to the audit tables on 2026-05-04). The migration adds `tenant_id` to `app_audit.approvals` with `DEFAULT 'BANK_DEMO' NOT NULL` and backfills existing rows; the view JOIN above uses `correlation_id → case_id` because approvals are tied to cases by correlation, not directly by customer. If `tenant_id` is added in the same migration, the JOIN can switch to direct customer_id once a `customer_id` projection lands on approvals (not in v1 scope).
- `m.last_updated_at` assumes `mart.customer_360` projects an updated-at column — verify against the dbt model; if absent, drop from `GREATEST(...)` clause.

### 5.2 `unified.alerts`

Flattens the alert-list view-model the BFF's `mapping.ts` produces in-code today.

```sql
CREATE VIEW unified.alerts AS
SELECT
    a.tenant_id,
    a.alert_id,
    a.customer_id,
    a.customer_name,                              -- denormalised on the alert at write time
    a.rule_id,
    a.rule_name,                                  -- denormalised on the alert at write time
    a.severity,                                   -- critical / high / medium / low
    a.criticality_score,
    a.confidence,
    a.customer_exposure_kes,
    a.indicators,
    a.status,                                     -- open / acked / closed
    a.assignee,
    a.created_at,
    a.acked_at,
    a.closed_at,
    EXTRACT(EPOCH FROM (now() - a.created_at)) / 60   AS age_minutes,
    m.risk_level                                  AS customer_risk_level,
    m.pd_score                                    AS customer_pd_score,
    m.exposure_kes                                AS customer_total_exposure_kes
FROM app_alerts.alerts a
LEFT JOIN mart.customer_360 m
    ON m.tenant_id = a.tenant_id
   AND m.customer_id = a.customer_id;
```

**Notes:**
- `linked_alert_ids` is **not** in the view. That field is computed by `web/src/lib/criticality.ts` deduplication at request time, not stored. BFF mapping layer continues to compute it on the wire when `dedup=true`.
- `customer_name` + `rule_name` come from the alert row directly (denormalised at write time per T4.17). No JOIN required for naming.
- `age_minutes` is a computed column; SPA may continue computing client-side for freshness — both produce the same result.

### 5.3 `unified.cases`

Flattens the case-list view-model with CAS+CAP rollups from T4.19.

```sql
CREATE VIEW unified.cases AS
SELECT
    c.tenant_id,
    c.case_id,
    c.alert_id,
    c.customer_id,
    c.customer_name,
    c.severity,
    c.rule_id,
    c.rule_name,
    c.state,                                      -- open / assigned / in_action / monitored / closed
    c.assignee,
    c.loan_id,
    c.reason_summary,
    c.outcome,                                    -- cured / cured_temp / defaulted | NULL
    c.sla_status,                                 -- on_track / approaching / breached / closed
    c.created_at,
    c.updated_at,
    c.closed_at,
    COALESCE(act.action_count, 0)            AS action_count,
    act.last_action_at,
    COALESCE(cas.open_cas_count, 0)          AS open_cas_count,
    COALESCE(cap.open_cap_count, 0)          AS open_cap_count,
    COALESCE(cap.has_blocking_caps, false)      AS has_blocking_caps,
    m.risk_level                              AS customer_risk_level,
    m.pd_score                                AS customer_pd_score
FROM app_cases.cases c
LEFT JOIN LATERAL (
    SELECT COUNT(*) AS action_count, MAX(occurred_at) AS last_action_at
    FROM app_cases.actions
    WHERE case_id = c.case_id
) act ON true
LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE review_status = 'pending') AS open_cas_count
    FROM app_cases.cas_records
    WHERE case_id = c.case_id
) cas ON true
LEFT JOIN LATERAL (
    SELECT
        COUNT(*) FILTER (WHERE status IN ('open','in_progress','overdue')) AS open_cap_count,
        bool_or(status IN ('open','in_progress','overdue'))                 AS has_blocking_caps
    FROM app_cases.caps
    WHERE case_id = c.case_id
) cap ON true
LEFT JOIN mart.customer_360 m
    ON m.tenant_id = c.tenant_id
   AND m.customer_id = c.customer_id;
```

**Notes:**
- `has_blocking_caps` makes the T4.19 "case can't close while any CAP is open" gate visible at query time — supports SPA "why can't I close this?" tooltips without hitting `/cases/:id/caps`.
- `app_cases.actions.occurred_at` — column name should be verified against the live `app_cases.actions` DDL; substitute `created_at` if `occurred_at` is absent.

### 5.4 `unified.audit_activity`

UNION ALL across three audit sources with normalized columns. **Structurally read-only** — PG planner refuses INSERT on UNION views, preserving WORM semantics on `audit.event_log` even by accident.

```sql
CREATE VIEW unified.audit_activity AS
SELECT
    'chain'              AS source,
    e.tenant_id,
    e.event_id::text     AS event_id,
    e.event_ts           AS ts,
    e.actor              AS actor,
    e.event_type         AS action,
    NULL::text           AS resource_type,
    e.subject_id         AS resource_id,
    NULL::text           AS outcome,
    NULL::text           AS severity,
    e.correlation_id,
    e.payload            AS metadata
FROM audit.event_log e

UNION ALL

SELECT
    'auth_local'         AS source,
    a.tenant_id,
    a.id::text           AS event_id,
    a.occurred_at        AS ts,
    a.actor_username     AS actor,
    a.event_type         AS action,
    'user'::text         AS resource_type,
    a.target_username    AS resource_id,
    NULL::text           AS outcome,
    NULL::text           AS severity,
    NULL::text           AS correlation_id,
    a.detail             AS metadata
FROM app_iam.audit_events a

UNION ALL

SELECT
    'approval'                            AS source,
    COALESCE(ap.tenant_id, 'BANK_DEMO')   AS tenant_id,
    ap.approval_id                        AS event_id,
    ap.proposed_at                        AS ts,
    ap.maker                              AS actor,
    ap.action                             AS action,
    ap.subject_type                       AS resource_type,
    ap.subject_id                         AS resource_id,
    ap.status                             AS outcome,
    NULL::text                            AS severity,
    ap.correlation_id,
    ap.payload                            AS metadata
FROM app_audit.approvals ap;
```

**Notes:**
- `source` discriminator (`'chain'` | `'auth_local'` | `'approval'`) lets callers filter to a single origin and prevents double-counting when the T4.16 auth → audit-chain fan-out lands the same event in both `app_iam.audit_events` AND `audit.event_log`. SPA timeline default-source choice is out of scope for this spec — it's a UX decision for the page owner.
- `app_audit.approvals.tenant_id` is added by this migration (see §6 — Migration adds the column with default `BANK_DEMO`). The `COALESCE` is defensive against any future row that lacks the column.
- Native column-name asymmetries are normalized in projection: `audit.event_log.event_ts` → `ts`, `event_log.actor` → `actor`, `audit_events.occurred_at` → `ts`, `audit_events.actor_username` → `actor`.

## 6. Tenant scoping

**Pattern:** `tenant_id` is a first-class column on every view. Callers filter explicitly via `WHERE tenant_id = $1`.

**Why not session-var auto-filtering** (`SET LOCAL app.tenant_id = ...`): would force connection-pool changes across every PgStore, introduces a silent-fall-through foot-gun (forgetting `SET LOCAL` returns all tenants), and doesn't match the existing T4.24 Phases 4–13 convention where the BFF passes `tenant_id` as a query parameter.

**Why not RLS in v1:** App-layer filtering is the established contract. Adding `CREATE POLICY` would be defense-in-depth (welcome in v1.5+ once BIL stakeholders ask for it) but adds nothing to v1's developer-experience goal.

**Prerequisite migration step for `unified.audit_activity`:** `app_audit.approvals` lacks `tenant_id` today. Migration `035_unified_views.sql` adds:

```sql
ALTER TABLE app_audit.approvals
    ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'BANK_DEMO'
        REFERENCES app_iam.tenants(tenant_id);
CREATE INDEX IF NOT EXISTS approvals_tenant_idx ON app_audit.approvals(tenant_id);
```

Backfill is implicit (`DEFAULT 'BANK_DEMO'` fills existing rows). The change is additive and tenant-isolated by construction.

## 6.5 Materialized-view forward compatibility

The promotion of any individual view from plain `VIEW` to `MATERIALIZED VIEW` MUST be a **transparent operation for consumers**. Specifically, promotion may not change:

- Schema name (`unified`)
- View name
- Column names, order, or types
- The `tenant_id`-as-first-column pattern
- The identity-tuple contract documented in §5.0

This means callers (SPA, BFF mapping, ORM repositories, ad-hoc DBeaver SQL) never need to update their queries when a hot view is promoted for performance.

**Promotion DDL template** (committed as a comment block in `data/schema/035_unified_views.sql` so a future operator can copy-paste without research):

```sql
-- FUTURE: promote unified.customer_360 to MATERIALIZED VIEW
-- Pre-conditions: p95 query latency > 100ms target; promotion adds noticeable refresh cost.
-- Execute inside a transaction; the unique index is required for CONCURRENT refresh.
BEGIN;
    DROP VIEW unified.customer_360 CASCADE;  -- CASCADE only if dependent views exist (none in v1)
    CREATE MATERIALIZED VIEW unified.customer_360 AS
        <same SELECT body as the original VIEW>;
    CREATE UNIQUE INDEX unified_customer_360_pkey
        ON unified.customer_360 (tenant_id, customer_id);
    -- For pre-warming, refresh once:
    REFRESH MATERIALIZED VIEW unified.customer_360;
COMMIT;
-- Schedule the refresh (one of):
--   (a) cron'd `REFRESH MATERIALIZED VIEW CONCURRENTLY unified.customer_360;`
--   (b) trigger on app_alerts.alerts INSERT/UPDATE/DELETE
--   (c) BFF `pg_notify` + listener that schedules a refresh
-- Acceptable staleness window is a deployment decision; default starts at 60s for SPA hot-paths.
```

**Promotion criterion (do not promote prematurely):**
- Sustained `unified.<view>` query p95 exceeds the §10.5 target
- Same query as `MATERIALIZED VIEW` (measured via a one-off promotion in a non-prod environment) clears the target by ≥ 2× margin
- Underlying write rate × refresh strategy cost < net SELECT-side saving

**Why this matters for v1:** the consumer contract is set NOW. If we let v1 ship column names that wouldn't survive a materialized rewrite (e.g. JSONB on a key column, computed expressions that can't be uniquely indexed), every future v2.x promotion forces a SPA + ORM rewrite. The §5.0 conventions enforce promotion-safety at v1.

## 7. SQL migration structure

| File | Purpose |
|---|---|
| `data/schema/035_unified_views.sql` | `CREATE SCHEMA unified` + `ALTER TABLE app_audit.approvals ADD tenant_id` + 4 `CREATE VIEW` statements + COMMENT ON metadata for each view |
| `data/schema/035_unified_views_rollback.sql` | `DROP VIEW unified.* CASCADE` + `DROP SCHEMA unified` + (optionally) `ALTER TABLE app_audit.approvals DROP COLUMN tenant_id` |
| `services/bff/__tests__/unified_views_pg.test.ts` | pg integration suite (gated on `BFF_PG_URL`, skipped in hermetic CI per the T4.13–T4.18 pattern) |
| `docs/database-schema.md` | Add new "§N — `unified.*` schema" section appending after existing app_* docs |

Migration numbering picks up at `035_` (next free; see `data/schema/` listing showing `034_feature_store.sql` is the current highest).

**Apply mechanism:** existing `make migrate` walks `data/schema/0NN_*.sql` in numeric order and applies each. No new tooling.

**Plain VIEW choice:** `CREATE VIEW`, not `CREATE MATERIALIZED VIEW`. Reasons:
- Always-live — no `REFRESH MATERIALIZED VIEW` cron, no staleness window.
- Aggregates are over small tables (~2.5k alerts/tenant, ~528 cases/tenant in current seed). Pg planner handles single-digit ms even unmaterialized.
- Materialized adds write tax + refresh complexity. Promote to materialized only on demonstrated perf failure (>100k alerts/tenant or measured p95 > 200ms), at which point we add a trigger-driven refresh that doesn't change view shape.

## 8. SPA / BFF integration

**v1 ships the views; nothing else changes.** Existing routes keep their current queries. No code outside the migration + test file is touched.

| Caller | v1 | v1.5 candidate |
|---|---|---|
| `services/bff/src/mapping.ts` (alert list-row mapper) | unchanged — keeps in-code joins via `Lookups` for customer + rule names | swap to `SELECT * FROM unified.alerts WHERE tenant_id = $1` — drops the lookup hydration; ~50 LOC saved |
| `/v1/risk-profile/:customer_id` (Customer Risk Profile) | unchanged | could JOIN against `unified.customer_360` for the side-panel `open_alerts_count` + `open_cases_count` chips |
| Customer 360 page (M11.6) — cross-adapter | unchanged | **not affected** — M11.6 orchestrates external adapters (insurance / ifrs9 / aml / dms / bureau / finance), which are not pg-backed. Different surface. |
| T4.6 self-service report builder catalog | unchanged | future ticket: add `unified.*` to the M12.1 catalog's source list so analysts can drag the flat views into reports without writing JOINs |
| Direct DBeaver / ad-hoc SQL | **primary v1 beneficiary** — operators query `unified.customer_360 WHERE tenant_id='BIL'` instead of remembering the 4-table JOIN | — |

**No ORM changes in v1.** Each PgStore (T4.13–T4.18) keeps writing to its owned table. v1.5 tickets — one per store — can opt into reading from `unified.*` views, preserving the store interface but simplifying the SQL.

## 8.5 ORM + repository abstraction compatibility

`unified.*` views are designed as **first-class read-only entities** that any future ORM or repository abstraction layer (TypeORM, Prisma, sqlx, Drizzle, sqlc, etc.) can declare without bespoke escape hatches.

**Compatibility contract:**

| Property | Requirement | Why |
|---|---|---|
| Stable column ordering | `SELECT *` returns the §5.0 canonical order on every session | Some ORM client paths read columns positionally; reordering breaks generated TypeScript types |
| Identity column declared | Each view has the identity tuple from §5.0 documented in a `COMMENT ON VIEW` so ORM tooling that reads catalog comments can find it without parsing this spec | TypeORM `@ViewEntity` + `@ViewColumn` + `@PrimaryColumn` need to know which column(s) form the key |
| Portable types only | TEXT (not CITEXT), TIMESTAMPTZ (not TIMESTAMP WITHOUT TIME ZONE), INTEGER / NUMERIC (not MONEY or SMALLINT), JSONB (not JSON) | Cross-driver portability; survives migration to Prisma/Drizzle/sqlc without type-rewrite churn |
| JSONB only on `metadata`-style columns | The `metadata` column on `unified.audit_activity` is the only JSONB. Identifiers, timestamps, counts, names, status flags MUST be scalar | ORMs deserialise JSONB to objects/Maps — fine for opaque payloads, brittle when typed access is expected |
| No views-of-views | Each `unified.*` view selects directly from underlying tables in `mart` / `app_*` / `audit`, never from another `unified.*` view | Prevents dependency chains that complicate ORM schema-introspection and migration-tool topo-sort |
| `COMMENT ON VIEW` + `COMMENT ON COLUMN` populated | Every view + every column carries a short comment in pg catalog | DBeaver shows comments inline; ORM codegen tools can lift them as JSDoc on generated types |

**Future repository pattern (v1.5+ guidance, not v1 work):**

```typescript
// services/<svc>/src/repos/unified_customer_360_repo.ts
export interface IUnifiedCustomer360Repo {
  getByTenantAndCustomer(tenant_id: string, customer_id: string): Promise<UnifiedCustomer360 | null>;
  listByTenant(tenant_id: string, opts: ListOpts): Promise<UnifiedCustomer360[]>;
  // No upsert / save / delete — the view is read-only.
}
```

The interface intentionally omits write methods. Attempting `INSERT INTO unified.customer_360` would fail with a Pg error — the type system should reflect that. v1.5 consumer-migration tickets adopt this interface store-by-store.

**ORM-readability validation** (added to §10):
- Every view has a non-empty `COMMENT ON VIEW`
- Every column has a non-empty `COMMENT ON COLUMN`
- Identity tuples from §5.0 are recoverable from catalog (via parsing the view comment which begins `IDENTITY: (tenant_id, customer_id)` etc.)

## 9. Rollback

The entire `unified` schema is read-only views over data that lives elsewhere. Rollback is one statement; no data movement.

```sql
-- data/schema/035_unified_views_rollback.sql
BEGIN;
DROP VIEW IF EXISTS unified.audit_activity CASCADE;
DROP VIEW IF EXISTS unified.cases CASCADE;
DROP VIEW IF EXISTS unified.alerts CASCADE;
DROP VIEW IF EXISTS unified.customer_360 CASCADE;
DROP SCHEMA IF EXISTS unified;
-- Approvals tenant_id column: keep by default (additive, harmless).
-- Uncomment to fully revert:
-- ALTER TABLE app_audit.approvals DROP COLUMN IF EXISTS tenant_id;
COMMIT;
```

No service coordination needed in v1 because no service references `unified.*`. If v1.5 migrations have already shipped consumer changes, those would need their own rollback first.

## 10. Validation checklist

Asserted by `services/bff/__tests__/unified_views_pg.test.ts` (gated on `BFF_PG_URL`; skipped in hermetic CI):

1. **Existence** — `unified.{customer_360, alerts, cases, audit_activity}` exist with the column lists declared in §5.
2. **Tenant data** — `SELECT COUNT(*) FROM unified.customer_360 WHERE tenant_id='BANK_DEMO'` > 0 (the 10k-customer seed should populate).
3. **Tenant isolation** — for any view, `(tenant_id_a) ∩ (tenant_id_b)` row keys are empty when both tenants have data. Skipped with explicit log when one tenant has zero rows in a view (current state: `mart.customer_360` has BANK_DEMO seed data only, BIL synthetic data is a separate T4.24 standalone follow-up).
4. **JOIN integrity — alerts → customer_360** — every `unified.alerts.customer_id` either has a matching row in `unified.customer_360` OR `customer_pd_score IS NULL` (LEFT JOIN preserves orphan alerts).
5. **JOIN integrity — cases → alerts** — every `unified.cases.alert_id` (when non-null) appears in `unified.alerts.alert_id`.
6. **Audit UNION shape** — `unified.audit_activity` returns the discriminator set `{'chain', 'auth_local', 'approval'}`; total row count = sum of per-source counts.
7. **Read-only sanity** — `INSERT INTO unified.customer_360 (tenant_id, customer_id, name) VALUES (...)` returns Pg error `cannot insert into view "customer_360"` (confirms no one accidentally added INSTEAD OF triggers).
8. **WORM preservation** — INSERT a synthetic row into `audit.event_log`, then immediately `SELECT FROM unified.audit_activity WHERE source = 'chain' AND event_id = <new>` returns it (proves the view is always-live, not snapshotted).
9. **`has_blocking_caps` correctness** — for a case with an open CAP, `unified.cases.has_blocking_caps = true`; after closing the CAP, the next read shows `false`.
10. **`open_alerts_count` correctness** — sum of `open_alerts_count` over `unified.customer_360` for a tenant ≈ count of `app_alerts.alerts` rows with `status = 'open'` for that tenant.
11. **No Seq Scan regression** — `EXPLAIN (ANALYZE, BUFFERS)` of each view's representative tenant-filtered query (per §10.5 table) shows no `Seq Scan` on any underlying table with > 1000 rows. Plan output persisted in the PR.
12. **Per-view p95 within budget** — median of 5 sequential runs of each representative query meets the §10.5 latency target on the local `apex-ews-pg` container with current seed.
13. **ORM-readability metadata populated** — every view has a non-empty `COMMENT ON VIEW`, every column has a non-empty `COMMENT ON COLUMN`, and the view comment carries an `IDENTITY: (...)` line matching the §5.0 identity-tuple contract (parsed by the test).

**CI integration:** the test file runs under the existing `make test-pg` target (mirrors T4.13–T4.18 pg integration suites). Hermetic CI skips when `BFF_PG_URL` is unset. PR description includes a manual smoke transcript against the local `apex-ews-pg` container.

## 10.5 Performance + index-review checkpoints

Cross-schema JOINs hide indexing assumptions. This section locks in the performance contract + the audit that confirms the underlying tables already carry the indexes the views need.

**Per-view latency targets** on the current seed (10k customers / 24k loans / 2.5k alerts / 528 cases / 12k audit events) on the local `apex-ews-pg` container:

| View | Representative query | p95 target | Action when exceeded |
|---|---|---|---|
| `unified.customer_360` | `SELECT * FROM unified.customer_360 WHERE tenant_id = $1` | **< 100ms** | Add covering index OR promote per §6.5 |
| `unified.customer_360` | `SELECT * FROM unified.customer_360 WHERE tenant_id = $1 AND customer_id = $2` | **< 20ms** | Verify (tenant_id, customer_id) index on mart.customer_360 |
| `unified.alerts` | `SELECT * FROM unified.alerts WHERE tenant_id = $1 AND status = 'open' ORDER BY criticality_score DESC LIMIT 50` | **< 50ms** | Verify (tenant_id, status, criticality_score DESC) partial index on app_alerts.alerts |
| `unified.cases` | `SELECT * FROM unified.cases WHERE tenant_id = $1 AND state <> 'closed'` | **< 50ms** | Verify (tenant_id, state) index on app_cases.cases |
| `unified.audit_activity` | `SELECT * FROM unified.audit_activity WHERE tenant_id = $1 ORDER BY ts DESC LIMIT 100` | **< 200ms** | UNION ALL is unavoidable cost; promote per §6.5 |

These targets are local-container benchmarks; production targets will calibrate against actual hardware once first deployed.

**Pre-flight index audit** — required indexes on underlying tables, verified against `data/schema/006_audit_tenant.sql` through `034_feature_store.sql`:

| Underlying table | Required index | Status today | Action in 035 migration |
|---|---|---|---|
| `mart.customer_360 (tenant_id)` | for view's tenant filter | ✅ exists (`010_mart_tenant.sql`) | none |
| `mart.customer_360 (tenant_id, customer_id)` | for view's point lookup | ⚠️ verify primary key includes both; if only `customer_id`, add | implementation step |
| `app_alerts.alerts (tenant_id, customer_id)` | for LATERAL subquery in customer_360 view | ⚠️ verify | implementation step (add if missing) |
| `app_alerts.alerts (tenant_id, status, criticality_score DESC) WHERE status='open'` | for alerts view | ✅ exists (`009_alerts_tenant.sql`) | none |
| `app_cases.cases (tenant_id, customer_id)` | for LATERAL subquery in customer_360 view | ⚠️ verify | implementation step (add if missing) |
| `app_cases.cases (tenant_id, state)` | for cases view | ✅ exists (`008_cases_tenant.sql`) | none |
| `app_cases.actions (case_id)` | for LATERAL subquery in cases view | ⚠️ verify (likely exists as FK index) | implementation step |
| `app_cases.cas_records (case_id, review_status)` | for has_blocking_caps + open_cas_count | ⚠️ verify | implementation step (add if missing) |
| `app_cases.caps (case_id, status)` | for has_blocking_caps + open_cap_count | ⚠️ verify | implementation step (add if missing) |
| `app_audit.approvals (tenant_id)` | for audit_activity view | ❌ tenant_id column doesn't exist | added by 035 (§6 precondition) — index added in same migration |
| `app_audit.approvals (correlation_id, status)` | for pending_approvals_count in customer_360 view | ⚠️ verify | implementation step (add if missing) |
| `audit.event_log (tenant_id, event_ts DESC)` | for audit_activity ORDER BY | ✅ exists (`006_audit_tenant.sql`) | none |
| `app_iam.audit_events (tenant_id, occurred_at DESC)` | for audit_activity ORDER BY | ✅ exists (`006_audit_tenant.sql`) | none |

**EXPLAIN ANALYZE gate (mandatory in the PR):** the pg integration test runs each representative query with `EXPLAIN (ANALYZE, BUFFERS)` and asserts:
- No `Seq Scan` on any underlying table with > 1000 rows
- Total time per query meets the p95 targets above (run 5 times, take median)
- LATERAL subqueries appear as `Nested Loop` with index access, not `Hash Join` (the former scales linearly with the outer; the latter scans everything)

The EXPLAIN output for all 4 representative queries is pasted into the PR description as evidence — the reviewer skims for regressions vs. the documented expected plans.

**Index discovery procedure** during implementation:
1. `psql -c "\d app_alerts.alerts" $APEX_EWS_DEV_URL` for each underlying table — note existing indexes
2. Cross-reference against the table above
3. Any ⚠️ marked "verify" that's missing gets a `CREATE INDEX IF NOT EXISTS` added to `035_unified_views.sql` BEFORE the view DDL
4. Re-run EXPLAIN ANALYZE; expect plan changes from Seq Scan → Index Scan / Index Only Scan
5. Persist the before/after plans in the PR

**Augments §10's checklist** with items #11 (no Seq Scan on > 1000-row tables), #12 (per-view p95 within target), and #13 (ORM-readability metadata populated) — see §10 for the literal assertions and §8.5 for the metadata contract those tests gate.

## 11. Known gaps + future work

| Gap | v1 impact | Resolution path |
|---|---|---|
| `mart.customer_360` column list isn't versioned in this spec — dbt model is the source of truth | Implementation must verify `name`, `risk_level`, `pd_score`, `exposure_kes`, `worst_dpd`, `kyc_status`, `segment`, `onboarded_at` are all projected; drop missing columns from the view | Inspect `data/dbt/models/marts/customer_360.sql` during implementation; spec assumes the standard projection |
| `app_audit.approvals` lacks `customer_id` | Approvals JOIN to customer_360 traverses `correlation_id → case_id → customer_id` (one extra subquery) | Future ticket: denormalize `customer_id` onto approvals at write time; the view can then drop the subquery |
| Audit chain's `resource_type` is NULL for `'chain'` rows | SPA timeline can't filter `unified.audit_activity` by resource_type for chain events without a derivation table | Future ticket: add an event_type → resource_type lookup table OR populate the column at write time in audit-svc |
| Rule registry not in pg | `unified.alerts.rule_name` comes from the denormalised column on `app_alerts.alerts` (set at write time) | Acceptable for v1; if rule_name drift becomes an issue, add a `unified.rules` view backed by a pg table populated from the in-memory registry |
| No RLS / session-var auto-filter | Caller must remember `WHERE tenant_id = $1` | Acceptable for v1; revisit when BIL or a future tenant asks for defense-in-depth |
| Plain views may underperform at >100k alerts/tenant | None today (current seed is ~2.5k alerts) | Promote `customer_360` to materialized + trigger-driven refresh; view shape stays stable |
| v1.5 consumer migrations are not specified | Existing routes work; no degradation | Each store's swap to `unified.*` reads is its own ticket — keeps the blast radius small |

## 12. References

- `docs/database-schema.md` — live schema reference (will be updated post-implementation)
- `docs/database-gap-analysis.md` — existing schema gap analysis
- `data/schema/004_app_schemas.sql` — `app_iam` / `app_cases` / `app_alerts` / `app_bff` / `app_scenario` table definitions
- `data/schema/003_audit_table.sql` — `audit.event_log` definition
- `data/schema/006_audit_tenant.sql` — tenant_id additions to audit tables (T4.24 Phase 3)
- `data/schema/007_app_tenant.sql` / `008_cases_tenant.sql` / `009_alerts_tenant.sql` / `010_mart_tenant.sql` — tenant_id additions to app + mart (T4.24 Phases 4–6, 13)
- `data/dbt/models/marts/customer_360.sql` — mart projection (verify columns during implementation)
- T4.13–T4.18 (TASKS.md / STATUS.md) — per-service Postgres wiring; the `PgStore` pattern this design respects
- T4.19 (TASKS.md) — CAS + CAP modelling that `unified.cases.has_blocking_caps` surfaces
- T4.20 (TASKS.md) — `app_audit.approvals` definition + maker-checker infrastructure
- T4.24 (TASKS.md / STATUS.md) — multi-tenant API foundation that established `tenant_id` as a first-class column
