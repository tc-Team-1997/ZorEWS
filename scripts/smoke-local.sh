#!/usr/bin/env bash
# Local-environment smoke test — runs against `make up` stack.
# Targets localhost ports only. NO AWS, NO production endpoints.
#
# Usage:
#   ./scripts/smoke-local.sh
#
# Exits 0 if every probed service responds 200 on /healthz.
# Exits 1 if any service is unreachable or returns non-200.
#
# Pairs with the production `scripts/smoke.sh` — same shape, local target.

set -euo pipefail

# Service port map — matches `make up` defaults in services/*/package.json
BFF_PORT="${BFF_PORT:-8084}"
AUTH_PORT="${AUTH_PORT:-8080}"
AUDIT_PORT="${AUDIT_PORT:-8081}"
CASES_PORT="${CASES_PORT:-8083}"
ALERTS_PORT="${ALERTS_PORT:-8082}"
RULES_PORT="${RULES_PORT:-8088}"
INDICATORS_PORT="${INDICATORS_PORT:-8087}"
COLLECTION_PORT="${COLLECTION_PORT:-8085}"
INTEGRATION_MOCKS_PORT="${INTEGRATION_MOCKS_PORT:-8086}"
PG_PORT="${PG_PORT:-55432}"
PG_DB="${PG_DB:-zorews}"
PG_USER="${PG_USER:-zorews_user}"
PG_PASSWORD="${PG_PASSWORD:-apex}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "  ${RED}✕${NC} $1"; FAIL=$((FAIL+1)); }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }

probe_health() {
  local name="$1"
  local port="$2"
  local path="${3:-/healthz}"
  if curl --silent --show-error --max-time 5 -o /dev/null -w "%{http_code}" "http://localhost:${port}${path}" 2>/dev/null | grep -q '^200$'; then
    pass "${name} :${port}${path} → 200"
  else
    local code
    code=$(curl --silent --show-error --max-time 5 -o /dev/null -w "%{http_code}" "http://localhost:${port}${path}" 2>&1 || true)
    fail "${name} :${port}${path} → ${code:-unreachable}"
  fi
}

echo ""
echo "=== Postgres ==="
if PGPASSWORD="${PG_PASSWORD}" psql -h localhost -p "${PG_PORT}" -U "${PG_USER}" -d "${PG_DB}" -tc "SELECT 1" >/dev/null 2>&1; then
  pass "postgres :${PG_PORT} reachable"
else
  fail "postgres :${PG_PORT} unreachable (run: cd data/schema && make up)"
fi

# Critical tables — fail early if migrations missing
for t in "app_iam.users" "app_iam.tenants" "app_cases.cases" "app_alerts.alerts" "app_bff.saved_reports" "app_copilot.ai_predictions" "app_admin.tenant_configs"; do
  exists=$(PGPASSWORD="${PG_PASSWORD}" psql -h localhost -p "${PG_PORT}" -U "${PG_USER}" -d "${PG_DB}" -tc "SELECT to_regclass('${t}') IS NOT NULL;" 2>/dev/null | tr -d ' ')
  if [ "${exists}" = "t" ]; then
    pass "table ${t} exists"
  else
    fail "table ${t} missing (apply data/schema/0*.sql in order)"
  fi
done

echo ""
echo "=== Service /healthz probes ==="
probe_health "auth-svc"           "${AUTH_PORT}"
probe_health "audit-svc"          "${AUDIT_PORT}"
probe_health "bff"                "${BFF_PORT}"
probe_health "cases"              "${CASES_PORT}"
probe_health "alerts"             "${ALERTS_PORT}"
probe_health "rules"              "${RULES_PORT}"
probe_health "indicators"         "${INDICATORS_PORT}"
probe_health "collection-adapter" "${COLLECTION_PORT}"
probe_health "integration-mocks"  "${INTEGRATION_MOCKS_PORT}"

echo ""
echo "=== BFF API surface (10 group representatives) ==="
# Each row exercises one of the user's 10 API groups against a known route.
# Headers match the existing tenant gate (M2.x + T4.24 envelope).
TENANT_HDR="X-Tenant-ID: BANK_DEMO"
CHAN_HDR="X-Channel: API"
USER_HDR="X-APEX-USER: alice.admin"

probe_api_at() {
  local port="$1"
  local label="$2"
  local route="$3"
  local expect_codes="${4:-200|201|401|403}"
  local code
  code=$(curl --silent --show-error --max-time 5 -o /dev/null -w "%{http_code}" \
    -H "${TENANT_HDR}" -H "${CHAN_HDR}" -H "${USER_HDR}" \
    "http://localhost:${port}${route}" 2>&1 || echo unreachable)
  if echo "${code}" | grep -qE "^(${expect_codes})$"; then
    pass "${label} :${port}${route} → ${code}"
  else
    fail "${label} :${port}${route} → ${code} (expected one of: ${expect_codes})"
  fi
}

# Each probe hits the correct port for that API group:
# Group 1 — Auth (auth-svc on AUTH_PORT)
probe_api_at "${AUTH_PORT}"  "1.auth-svc /auth/me"           "/auth/me" "200|401"
# Group 2 — Users
probe_api_at "${BFF_PORT}"   "2.users (via session)"         "/api/customers" "200|401|403"
# Group 3 — Dashboard
probe_api_at "${BFF_PORT}"   "3.dashboard summary"           "/api/dashboard/summary" "200|401|403"
# Group 4 — Borrower (customers — same surface as group 2 for now)
probe_api_at "${BFF_PORT}"   "4.borrower /api/customers/:id" "/api/customers/c-101/risk" "200|401|403|404"
# Group 5 — EWS Indicators (indicators-svc direct, NOT proxied via BFF)
probe_api_at "${INDICATORS_PORT}" "5.indicators catalog"     "/indicators" "200|401|403"
# Group 6 — Alerts (alerts-svc has /alerts; BFF mirrors /api/alerts + /v1/alerts)
probe_api_at "${BFF_PORT}"   "6.alerts list"                 "/api/alerts" "200|401|403"
# Group 7 — Workflow (cases via BFF /api/cases)
probe_api_at "${BFF_PORT}"   "7.workflow cases"              "/api/cases" "200|401|403"
# Group 8 — AI (BFF /v1/ai/models registry)
probe_api_at "${BFF_PORT}"   "8.ai models registry"          "/v1/ai/models" "200|401|403"
# Group 9 — Reports
probe_api_at "${BFF_PORT}"   "9.reports catalog"             "/v1/reports/catalog" "200|401|403"
# Group 10 — Config
probe_api_at "${BFF_PORT}"   "10.admin config keys"          "/v1/admin/config" "200|401|403"

echo ""
echo "================================================================"
echo "Total: ${PASS} pass · ${FAIL} fail"
echo "================================================================"
if [ "${FAIL}" -gt 0 ]; then
  echo ""
  echo "To start the local stack:"
  echo "  cd data/schema && make up && make migrate"
  echo "  cd ../.."
  echo "  make install && make up"
  echo "  ./scripts/smoke-local.sh"
  exit 1
fi
exit 0
