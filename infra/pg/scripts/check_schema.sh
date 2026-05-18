#!/usr/bin/env bash
# infra/pg/scripts/check_schema.sh
#
# Schema validation gate. Exits 0 if every expected schema + table is
# present; exits 1 with a diff if anything is missing. Use this as:
#   - Local sanity check after `make migrate`
#   - CI gate after schema bootstrap
#   - Pre-deploy verification
#
# Reads connection from $PG (DSN) or assembles from PG_HOST / PG_PORT
# / PG_USER / PG_PASSWORD / PG_DB. Default = ZorEWS native on :5432.

set -euo pipefail

PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-zorews_user}"
PG_PASSWORD="${PG_PASSWORD:-apex}"
PG_DB="${PG_DB:-zorews}"
PG="${PG:-postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DB}}"

# Strip password before logging
SAFE_DSN="postgres://${PG_USER}:***@${PG_HOST}:${PG_PORT}/${PG_DB}"
echo "[check_schema] target = ${SAFE_DSN}"

# Expected schemas — anything in this list MUST exist.
EXPECTED_SCHEMAS=(
  audit app_iam app_cases app_alerts app_bff app_scenario
  app_audit app_admin app_copilot app raw staging mart
)

# Expected tables (schema.table format). Generated from data/schema/*.sql.
EXPECTED_TABLES=(
  audit.event_log
  app_iam.tenants app_iam.users app_iam.sessions app_iam.password_history
  app_iam.audit_events app_iam.user_2fa_secrets app_iam.user_teams
  app_iam.user_team_members app_iam.leave_covers app_iam.role_dashboard_widgets
  app_iam.service_clients
  app_cases.cases app_cases.actions app_cases.cas_records app_cases.caps
  app_cases.cms_cases app_cases.cms_case_assignments app_cases.cms_case_attachments
  app_cases.cms_case_history app_cases.cms_case_notes
  app_alerts.alerts app_alerts.queue_assignments
  app_bff.webhook_subscriptions app_bff.webhook_deliveries
  app_scenario.saved_scenarios
  app_audit.approvals
  app_admin.admin_audit_log app_admin.case_scenario_history app_admin.case_scenarios
  app_admin.escalation_matrix app_admin.notification_dispatch_log
  app_admin.notification_templates app_admin.saved_report_filters
  app_admin.sla_config app_admin.user_access_override
  app_copilot.conversations app_copilot.messages app_copilot.audit_log
  app.ews_rules app.ews_rule_versions app.ews_rule_approvals app.ews_rule_executions
)

# Probe Postgres
PRESENT_SCHEMAS=$(PGPASSWORD="${PG_PASSWORD}" psql -h "${PG_HOST}" -p "${PG_PORT}" -U "${PG_USER}" -d "${PG_DB}" -At -c \
  "SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND nspname NOT LIKE 'pg_%' ORDER BY 1;" 2>/dev/null) || {
  echo "❌ cannot connect to ${SAFE_DSN}" >&2
  exit 2
}

PRESENT_TABLES=$(PGPASSWORD="${PG_PASSWORD}" psql -h "${PG_HOST}" -p "${PG_PORT}" -U "${PG_USER}" -d "${PG_DB}" -At -c \
  "SELECT table_schema || '.' || table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1;")

MISSING_SCHEMAS=()
for s in "${EXPECTED_SCHEMAS[@]}"; do
  echo "${PRESENT_SCHEMAS}" | grep -qx "${s}" || MISSING_SCHEMAS+=("${s}")
done

MISSING_TABLES=()
for t in "${EXPECTED_TABLES[@]}"; do
  echo "${PRESENT_TABLES}" | grep -qx "${t}" || MISSING_TABLES+=("${t}")
done

PRESENT_TABLE_COUNT=$(echo "${PRESENT_TABLES}" | grep -c .)
PRESENT_SCHEMA_COUNT=$(echo "${PRESENT_SCHEMAS}" | grep -c .)

echo "[check_schema] schemas: ${PRESENT_SCHEMA_COUNT} present / ${#EXPECTED_SCHEMAS[@]} expected"
echo "[check_schema] tables:  ${PRESENT_TABLE_COUNT} present / ${#EXPECTED_TABLES[@]} expected"

if [ ${#MISSING_SCHEMAS[@]} -ne 0 ]; then
  echo
  echo "❌ MISSING SCHEMAS:"
  printf '   - %s\n' "${MISSING_SCHEMAS[@]}"
fi

if [ ${#MISSING_TABLES[@]} -ne 0 ]; then
  echo
  echo "❌ MISSING TABLES:"
  printf '   - %s\n' "${MISSING_TABLES[@]}"
fi

if [ ${#MISSING_SCHEMAS[@]} -ne 0 ] || [ ${#MISSING_TABLES[@]} -ne 0 ]; then
  echo
  echo "Fix: apply pending migrations from data/schema/00X_*.sql"
  echo "     See data/schema/Makefile  OR  docs/database-connectivity.md"
  exit 1
fi

echo "✅ schema OK — all ${#EXPECTED_SCHEMAS[@]} schemas + ${#EXPECTED_TABLES[@]} tables present"
