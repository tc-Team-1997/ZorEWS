# ZorEWS — Database Connectivity Audit + Fix

**Status:** Resolved 2026-05-17
**Endpoint:** `postgres://zorews_user:apex@localhost:5432/zorews`
**Server:** Native PostgreSQL 18 (EnterpriseDB install at `/Library/PostgreSQL/18/`)

This document is the post-mortem + fix for the "tables not appearing in the database connection layer" issue. It also documents the centralised connection helper + diagnostic scripts added under [infra/pg/](../infra/pg/).

## Root cause (in one line)

The user was inspecting the `zorews` database on **native :5432** (which existed but was completely empty — only the default `public` schema, zero tables). All ZorEWS schema + data lived on the **Docker `zorews-pg` instance on :55432**. Two Postgres servers were running at the same time; the app and the inspection tools were pointing at different ones.

## Architecture reality check (vs the original spec)

The original request used ORM-shaped language ("entities/models/tables", "ORM configuration fixes", "table discovery and mapping"). It's important to be precise about what this codebase actually is:

| Spec assumed | ZorEWS reality |
|---|---|
| ORM (TypeORM / Prisma / Sequelize) | **No ORM.** Hand-rolled `pg.Pool` with raw SQL. |
| Auto-discovered entities → tables | Tables defined in raw SQL migrations (`data/schema/00X_*.sql`). |
| Single central DB config | **21 separate `new Pool(...)` callsites** across 4 services. Each Pg*Store owns its pool. |
| Entity-to-table mapping | Each store has TypeScript types + raw `SELECT/INSERT/UPDATE` SQL. Column names match by hand. |
| Migration runner | No runner — migrations are SQL files applied via `psql -f` or `make migrate`. |

Implication: things like "fix ORM config", "auto-discover entities", "synchronize entity definitions" don't directly apply. What DOES apply — and what we shipped — is:

1. **Centralised connection helper** ([infra/pg/connection.ts](../infra/pg/connection.ts)) for future code + opt-in adoption.
2. **Schema-validation gate** ([infra/pg/scripts/check_schema.sh](../infra/pg/scripts/check_schema.sh)) that lists expected schemas + tables and exits 1 if anything's missing.
3. **Diagnostic audit** ([infra/pg/scripts/audit_db.sh](../infra/pg/scripts/audit_db.sh)) — schemas, table sizes, FK count, active sessions, indexes.
4. **Migration of the full schema + 26k rows** from Docker `:55432` → Native `:5432`.

## Detected tables (43 across 14 schemas, 30 FKs)

| Schema | Tables (count) | Purpose | Migration |
|---|---|---|---|
| `audit` | `event_log` (1) | Hash-chained regulatory event log | [003](../data/schema/003_audit_table.sql) |
| `app_iam` | `tenants`, `users`, `sessions`, `password_history`, `audit_events`, `user_2fa_secrets`, `user_teams`, `user_team_members`, `leave_covers`, `role_dashboard_widgets`, `service_clients` (11) | Identity + sessions + auth audit + teams + 2FA | [004](../data/schema/004_app_schemas.sql), [005](../data/schema/005_tenants.sql), [011](../data/schema/011_user_2fa.sql), [017](../data/schema/017_user_branch_department.sql) |
| `app_cases` | `cases`, `actions`, `cas_records`, `caps`, `cms_cases`, `cms_case_assignments`, `cms_case_attachments`, `cms_case_history`, `cms_case_notes` (9) | Case state machine + CAS/CAP + CMS extensions | [004](../data/schema/004_app_schemas.sql), [008](../data/schema/008_cases_tenant.sql), [013](../data/schema/013_cms_cases.sql) |
| `app_alerts` | `alerts`, `queue_assignments` (2) | Alert queue + smart-queue assignment ledger | [004](../data/schema/004_app_schemas.sql), [009](../data/schema/009_alerts_tenant.sql) |
| `app_bff` | `webhook_subscriptions`, `webhook_deliveries` (2) | Outbound webhooks + delivery log | [004](../data/schema/004_app_schemas.sql), [007](../data/schema/007_app_tenant.sql) |
| `app_scenario` | `saved_scenarios` (1) | Saved stress scenarios | [004](../data/schema/004_app_schemas.sql) |
| `app_audit` | `approvals` (1) | Cross-cutting maker-checker ledger | T4.20 |
| `app_admin` | `admin_audit_log`, `escalation_matrix`, `notification_templates`, `notification_dispatch_log`, `sla_config`, `user_access_override`, `case_scenarios`, `case_scenario_history`, `saved_report_filters` (9) | Admin config tables for BIL T6 work | [016-022](../data/schema/) |
| `app_copilot` | `conversations`, `messages`, `audit_log` (3) | Copilot chat history + audit | [014](../data/schema/014_copilot_audit.sql) |
| `app` | `ews_rules`, `ews_rule_versions`, `ews_rule_approvals`, `ews_rule_executions` (4) | EWS rule engine + maker-checker versions | [012](../data/schema/012_ews_rules.sql), [015](../data/schema/015_ews_rules_versions.sql) |
| `raw` | (0 tables) | dbt seeds — populated by `dbt seed` | [002](../data/schema/002_raw_tables.sql) |
| `staging` | (0 views) | dbt staging views — populated by `dbt run` | [data/dbt/models/staging/](../data/dbt/models/staging/) |
| `mart` | (0 tables) | dbt materialised features — populated by `dbt run` | [data/dbt/models/marts/](../data/dbt/models/marts/) |
| `public` | (0 tables) | default schema, unused | — |

To regenerate this list: `./infra/pg/scripts/audit_db.sh`

## Centralised DB configuration

The new helper at [infra/pg/connection.ts](../infra/pg/connection.ts) standardises:

- **Env-var resolution** — single ordered fallback chain instead of duplicated `process.env.X ?? process.env.Y` patterns
- **Pool factory** — same defaults everywhere (`max=4`, `idleTimeoutMillis=30s`, application_name tagging for `pg_stat_activity`)
- **Startup ping** — `pingPool()` runs `SELECT 1` so misconfig fails fast
- **Expected-table check** — `checkExpectedTables()` returns a missing-list for the caller to validate against its known schema

**Adoption is opt-in.** Existing services keep their per-store `new Pool(...)` calls untouched. New code (and future refactors) should use the helper:

```typescript
import { resolvePgConfig, makePool, pingPool, checkExpectedTables } from '../../../infra/pg/connection.js';

const cfg = resolvePgConfig({ envVars: ['BFF_PG_URL'] });
if (!cfg) return new InMemoryStore();   // fall back to in-memory if no env var

const pool = makePool(cfg, { max: 4, application_name: 'bff-scenarios' });
await pingPool(pool, cfg);

const missing = await checkExpectedTables(pool, [
  { schema: 'app_scenario', table: 'saved_scenarios' },
]);
if (missing.length) throw new Error(`missing tables: ${JSON.stringify(missing)}`);
```

## Connection-string env vars (canonical list)

| Env var | Read by | Default fallback |
|---|---|---|
| `AUTH_SVC_PG_URL` | auth-svc (`pg_user_store.ts`, `pg_session_store.ts`, `pg_audit_log.ts`, `service_clients.ts`, `teams.ts`, `leave_covers.ts`, `dashboard_widgets.ts`) | in-memory |
| `BFF_PG_URL` | bff (`webhooks/pg_store.ts`, `scenario/store.ts`, `analytics/*`, `reports/cases_detail_query.ts`) | in-memory |
| `ADMIN_PG_URL` | bff admin stores (`admin/notification_*.ts`, `admin/sla_config_store.ts`, `admin/case_scenarios_store.ts`, `admin/user_access_override_store.ts`, `admin/escalation_matrix_store.ts`) | in-memory |
| `CASES_PG_URL` | regulatory-svc/cases (`store.ts`) | NDJSON outbox |
| `ALERTS_PG_URL` | regulatory-svc/alerts (`queue.ts`) | NDJSON outbox |

**All point to the same DSN in practice.** Convention: set them all to `$PG`:

```sh
PG=postgres://zorews_user:apex@localhost:5432/zorews
export AUTH_SVC_PG_URL=$PG BFF_PG_URL=$PG ADMIN_PG_URL=$PG CASES_PG_URL=$PG ALERTS_PG_URL=$PG
```

**Special case — auth-svc:** the synthetic seed (`_generate_app_seeds.py`) writes placeholder argon2 hashes (`$argon2id$v=19$m=65536,t=3,p=4$demo$demo`) that don't validate. If `AUTH_SVC_PG_URL` is set, login throws "Output is too short" 500. Either (a) leave `AUTH_SVC_PG_URL` unset so auth-svc uses in-memory DEMO_USERS, or (b) regenerate the seed with real argon2 hashes. Option (a) is the current working setup.

## Validation commands

```sh
# 1. Probe connectivity
PGPASSWORD=apex psql -h localhost -p 5432 -U zorews_user -d zorews -c "SELECT current_user, current_database();"

# 2. Validate every expected schema + table is present (exits 0/1)
./infra/pg/scripts/check_schema.sh

# 3. Full diagnostic report
./infra/pg/scripts/audit_db.sh

# 4. Top 5 tables by size
PGPASSWORD=apex psql -h localhost -p 5432 -U zorews_user -d zorews -c "
SELECT n.nspname || '.' || c.relname AS table,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind='r' AND n.nspname NOT LIKE 'pg_%'
 ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 5;"

# 5. Verify foreign keys
PGPASSWORD=apex psql -h localhost -p 5432 -U zorews_user -d zorews -c "
SELECT tc.table_schema, tc.table_name, kcu.column_name,
       ccu.table_schema AS ref_schema, ccu.table_name AS ref_table, ccu.column_name AS ref_column
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
  JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
 WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema LIKE 'app_%'
 ORDER BY tc.table_schema, tc.table_name;"

# 6. End-to-end check: service hits PG (after `make up` with PG_URLs set)
TOKEN=$(curl -s -X POST http://localhost:8080/auth/login -H "Content-Type: application/json" \
  -d '{"username":"alice.admin","password":"Admin!Pass1"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -s http://localhost:5173/api/cases \
  -H "Authorization: Bearer $TOKEN" -H "X-Tenant-ID: BANK_DEMO" -H "X-Channel: API" \
  -H "X-Source-System: validation" -H "x-apex-role: admin"
```

## Unresolved issues (current backlog)

| # | Issue | Status | Fix |
|---|---|---|---|
| 1 | **dbt mart layer empty** — `raw.*`, `staging.*`, `mart.*` have no rows. Migration `010_mart_tenant.sql` skipped because it references `mart.customer_360` which dbt hasn't materialised. | Open | `cd data/dbt && dbt deps && dbt seed --full-refresh && dbt run` (~4 min) then re-apply `010_mart_tenant.sql` |
| 2 | **Seed users have placeholder argon2 hashes** — `_generate_app_seeds.py` writes `$argon2id$...$demo$demo` which throws "Output is too short" on login. | Workaround in place (auth-svc runs in-memory) | Regenerate `_generate_app_seeds.py` to compute real argon2 hashes via Python `argon2-cffi` library |
| 3 | **Two Postgres servers running simultaneously** — native :5432 + Docker `zorews-pg` :55432. They got out of sync (Docker was the source of truth; native was empty). | Resolved by migrating schema + data to :5432 | Tear down Docker container: `cd data/schema && make down` (will free port 55432) |
| 4 | **21 disparate `new Pool()` callsites** — each Pg*Store owns its own pool. Centralised helper is shipped but no service has been refactored to use it yet (preserving stable code). | Tracked for future refactor | Migrate Pg*Stores one at a time to `infra/pg/connection.ts` |
| 5 | **No automatic migration runner** — migrations applied via `psql -f` or `make migrate`. No record of which migration ran when. | Acceptable for prototype | Adopt `node-pg-migrate` or similar if production-readiness needed |

## What was changed in this fix

| File | Change |
|---|---|
| `infra/pg/connection.ts` | **NEW** — Centralised pg.Pool factory + env resolution + ping + table-presence check |
| `infra/pg/scripts/check_schema.sh` | **NEW** — Schema validation gate (exits 0/1, lists missing schemas/tables) |
| `infra/pg/scripts/audit_db.sh` | **NEW** — Human-readable diagnostic report |
| `docs/database-connectivity.md` | **NEW** — This document |

**Zero existing files modified.** Existing 21 `new Pool()` callsites unchanged. Existing Pg*Store classes unchanged. Migrations unchanged. Adoption of the centralised helper is opt-in.

## Quick reference

```sh
# Start services pointing at :5432 (clean way)
cd /Users/chuadhary_taniya/ZorEWS
PG=postgres://zorews_user:apex@localhost:5432/zorews \
  CASES_PG_URL=$PG ALERTS_PG_URL=$PG BFF_PG_URL=$PG ADMIN_PG_URL=$PG \
  make up

# (note: leaving AUTH_SVC_PG_URL unset so auth-svc uses in-memory DEMO_USERS)

# Verify
./infra/pg/scripts/check_schema.sh   # → ✅ schema OK
./infra/pg/scripts/audit_db.sh       # → full report

# Open SPA
open http://localhost:5173/
```
