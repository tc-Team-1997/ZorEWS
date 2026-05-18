#!/usr/bin/env bash
# infra/pg/scripts/audit_db.sh
#
# Human-readable diagnostic report: which schemas exist, how many rows
# in each table, foreign-key count, active sessions, server version.
# Use as a quick "is the DB healthy?" probe — does NOT modify state.

set -euo pipefail

PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-zorews_user}"
PG_PASSWORD="${PG_PASSWORD:-apex}"
PG_DB="${PG_DB:-zorews}"

# Export password so psql picks it up without command-line quoting risk
export PGPASSWORD="${PG_PASSWORD}"
PSQL=(psql -h "${PG_HOST}" -p "${PG_PORT}" -U "${PG_USER}" -d "${PG_DB}")

echo "═══════════════════════════════════════════════════════════════"
echo " ZorEWS DB Audit — ${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DB}"
echo " $(date)"
echo "═══════════════════════════════════════════════════════════════"
echo

echo "── 1. Server version ──────────────────────────────────────────"
"${PSQL[@]}" -At -c "SELECT version();" 2>/dev/null | head -1 || { echo "❌ cannot connect"; exit 2; }
echo

echo "── 2. Per-schema table + view counts ──────────────────────────"
"${PSQL[@]}" -P pager=off -c "
SELECT n.nspname AS schema,
       count(c.oid) FILTER (WHERE c.relkind='r') AS tables,
       count(c.oid) FILTER (WHERE c.relkind='v') AS views
  FROM pg_namespace n
  LEFT JOIN pg_class c ON c.relnamespace = n.oid
 WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
   AND n.nspname NOT LIKE 'pg_%'
 GROUP BY n.nspname
 ORDER BY n.nspname;"

echo "── 3. Top 15 tables by row count ──────────────────────────────"
"${PSQL[@]}" -P pager=off -c "
SELECT n.nspname || '.' || c.relname AS table,
       c.reltuples::bigint AS estimated_rows,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'r'
   AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
   AND n.nspname NOT LIKE 'pg_%'
 ORDER BY c.reltuples DESC NULLS LAST
 LIMIT 15;"

echo "── 4. Foreign keys ────────────────────────────────────────────"
"${PSQL[@]}" -At -c "SELECT 'FKs total: ' || count(*) FROM information_schema.referential_constraints;"
echo

echo "── 5. Connection sessions to this database ────────────────────"
"${PSQL[@]}" -P pager=off -c "
SELECT pid, application_name, usename, state, query_start, left(query, 50) AS query_excerpt
  FROM pg_stat_activity
 WHERE datname='${PG_DB}'
   AND pid <> pg_backend_pid()
 ORDER BY state, query_start DESC NULLS LAST;"

echo "── 6. Indexes per schema ──────────────────────────────────────"
"${PSQL[@]}" -P pager=off -c "
SELECT schemaname AS schema, count(*) AS indexes
  FROM pg_indexes
 WHERE schemaname NOT IN ('pg_catalog','information_schema')
 GROUP BY schemaname
 ORDER BY schemaname;"

echo "═══════════════════════════════════════════════════════════════"
echo "Done. For schema validation: ./infra/pg/scripts/check_schema.sh"
echo "═══════════════════════════════════════════════════════════════"
