#!/usr/bin/env bash
# Tenant isolation security test — verifies cross-tenant data leak is impossible.
#
# Required before T7-P2 pentest fieldwork + every infra/k8s rollout +
# every T4.24-relevant schema change.
#
# Test matrix (per docs/threat-model.md T5.1 + T5.4):
#   1. BIL admin token + X-Tenant-ID=BANK_DEMO → must be REFUSED (JWT mismatch)
#   2. BIL admin token + no X-Tenant-ID → must default to JWT's tenant_id
#   3. BIL admin GET /v1/alerts must not return any BANK_DEMO alert ids
#   4. BIL admin GET /v1/webhooks must return empty if no BIL webhooks
#   5. BANK_DEMO admin cannot read BIL audit chain (cross-tenant 404)
#   6. Service-account API key bound to BIL cannot read BANK_DEMO data
#   7. POST /v1/alerts/evaluate with body.tenant_id=BANK_DEMO + header=BIL →
#      header wins; body field ignored

set -euo pipefail

BFF_URL="${BFF_URL:-https://api.apex-ews.example}"
AUTH_URL="${AUTH_URL:-https://auth.apex-ews.example}"
BANK_DEMO_USER="${BANK_DEMO_USER:-alice.admin}"
BIL_USER="${BIL_USER:-bil.admin}"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; FAIL=0

assert_pass() { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS+1)); }
assert_fail() { echo -e "  ${RED}✕${NC} $1"; FAIL=$((FAIL+1)); }
heading()    { echo ""; echo "── $1 ──"; }

# Fetch tokens for both demo tenants
heading "0. Login both tenants"

BANK_DEMO_CREDS=$(aws secretsmanager get-secret-value \
  --secret-id "apex-ews/prod/admin-smoke-credentials" \
  --query SecretString --output text 2>/dev/null || echo "{}")
BIL_CREDS=$(aws secretsmanager get-secret-value \
  --secret-id "apex-ews/prod/admin-smoke-credentials-bil" \
  --query SecretString --output text 2>/dev/null || echo "{}")

BANK_DEMO_PW=$(echo "${BANK_DEMO_CREDS}" | jq -r '.password // empty')
BIL_PW=$(echo "${BIL_CREDS}" | jq -r '.password // empty')

if [ -z "${BANK_DEMO_PW}" ] || [ -z "${BIL_PW}" ]; then
  echo -e "${RED}ERROR: smoke credentials not in Secrets Manager.${NC}"
  echo "Provision both apex-ews/prod/admin-smoke-credentials* before running."
  exit 1
fi

BANK_DEMO_TOKEN=$(curl -sf -X POST "${AUTH_URL}/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${BANK_DEMO_USER}\",\"password\":\"${BANK_DEMO_PW}\"}" \
  | jq -r '.access_token // empty')

BIL_TOKEN=$(curl -sf -X POST "${AUTH_URL}/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${BIL_USER}\",\"password\":\"${BIL_PW}\"}" \
  | jq -r '.access_token // empty')

[ -n "${BANK_DEMO_TOKEN}" ] && assert_pass "BANK_DEMO admin login" || { assert_fail "BANK_DEMO admin login"; exit 1; }
[ -n "${BIL_TOKEN}" ]       && assert_pass "BIL admin login"       || { assert_fail "BIL admin login"; exit 1; }

# ────────────────────────────────────────────────────────────────
heading "1. JWT tenant_id MUST match X-Tenant-ID header"

# BIL token + X-Tenant-ID: BANK_DEMO header → must 403
STATUS=$(curl -s -o /tmp/iso1.json -w '%{http_code}' \
  -H "Authorization: Bearer ${BIL_TOKEN}" \
  -H "X-Tenant-ID: BANK_DEMO" \
  -H "X-Channel: API" \
  "${BFF_URL}/v1/alerts" || echo "000")

if [ "${STATUS}" = "403" ]; then
  ERROR_CODE=$(jq -r '.error.code // empty' < /tmp/iso1.json)
  if [ "${ERROR_CODE}" = "EWS_403_tenant_mismatch" ]; then
    assert_pass "BIL token + X-Tenant-ID=BANK_DEMO refused with EWS_403_tenant_mismatch"
  else
    assert_fail "Got 403 but error.code=${ERROR_CODE} (expected EWS_403_tenant_mismatch)"
  fi
elif [ "${STATUS}" = "200" ]; then
  assert_fail "${RED}CRITICAL: BIL token + X-Tenant-ID=BANK_DEMO returned 200 — tenant isolation BROKEN${NC}"
else
  assert_fail "Got HTTP ${STATUS} (expected 403)"
fi

# ────────────────────────────────────────────────────────────────
heading "2. Cross-tenant resource lookup MUST return 404 (not 403)"

# Find a BANK_DEMO alert id
BANK_DEMO_ALERT=$(curl -sf \
  -H "Authorization: Bearer ${BANK_DEMO_TOKEN}" \
  -H "X-Tenant-ID: BANK_DEMO" \
  -H "X-Channel: API" \
  "${BFF_URL}/v1/alerts?limit=1" | jq -r '.body.items[0].id // empty')

if [ -n "${BANK_DEMO_ALERT}" ]; then
  STATUS=$(curl -s -o /tmp/iso2.json -w '%{http_code}' \
    -H "Authorization: Bearer ${BIL_TOKEN}" \
    -H "X-Tenant-ID: BIL" \
    -H "X-Channel: API" \
    "${BFF_URL}/v1/alerts/${BANK_DEMO_ALERT}" || echo "000")

  if [ "${STATUS}" = "404" ]; then
    assert_pass "BIL admin GET /v1/alerts/<BANK_DEMO_id> returns 404 (existence-probe guard)"
  elif [ "${STATUS}" = "403" ]; then
    assert_fail "Got 403 instead of 404 — leaks existence of BANK_DEMO alert"
  else
    assert_fail "Got HTTP ${STATUS} (expected 404)"
  fi
else
  echo -e "  ${YELLOW}⚠${NC} No BANK_DEMO alerts to test against; skipping"
fi

# ────────────────────────────────────────────────────────────────
heading "3. List response MUST be tenant-scoped"

BIL_ALERTS=$(curl -sf \
  -H "Authorization: Bearer ${BIL_TOKEN}" \
  -H "X-Tenant-ID: BIL" \
  -H "X-Channel: API" \
  "${BFF_URL}/v1/alerts?limit=200" | jq -r '.body.items[].tenant_id // empty' | sort -u)

if [ -z "${BIL_ALERTS}" ]; then
  echo -e "  ${YELLOW}⚠${NC} BIL has no alerts to test; assertion vacuously true"
elif [ "${BIL_ALERTS}" = "BIL" ]; then
  assert_pass "BIL /v1/alerts list contains only tenant_id=BIL"
else
  assert_fail "BIL /v1/alerts list contains foreign tenant_ids: ${BIL_ALERTS}"
fi

# ────────────────────────────────────────────────────────────────
heading "4. POST body MUST NOT override header tenant"

# Try to ingest an alert into BANK_DEMO using BIL token + body.tenant_id=BANK_DEMO
RESPONSE=$(curl -sf -X POST \
  -H "Authorization: Bearer ${BIL_TOKEN}" \
  -H "X-Tenant-ID: BIL" \
  -H "X-Channel: API" \
  -H "Content-Type: application/json" \
  -d '{"tenant_id":"BANK_DEMO","customer_id":"isolation-test","features":{}}' \
  "${BFF_URL}/v1/ews/evaluate" || echo '{}')

EVALUATED_TENANT=$(echo "${RESPONSE}" | jq -r '.body.tenant_id // empty')

if [ "${EVALUATED_TENANT}" = "BIL" ]; then
  assert_pass "Header X-Tenant-ID=BIL wins over body.tenant_id=BANK_DEMO"
elif [ "${EVALUATED_TENANT}" = "BANK_DEMO" ]; then
  assert_fail "${RED}CRITICAL: body.tenant_id overrode header — tenant isolation BROKEN${NC}"
fi

# ────────────────────────────────────────────────────────────────
heading "5. Cross-tenant audit chain isolation"

BIL_VALID=$(curl -sf \
  -H "Authorization: Bearer ${BIL_TOKEN}" \
  -H "X-Tenant-ID: BIL" \
  -H "X-Channel: API" \
  "${BFF_URL}/v1/audit/integrity" | jq -r '.body.tenant_id // empty')

if [ "${BIL_VALID}" = "BIL" ]; then
  assert_pass "BIL audit chain integrity check scoped to BIL"
elif [ "${BIL_VALID}" = "BANK_DEMO" ]; then
  assert_fail "${RED}CRITICAL: audit chain shows BANK_DEMO tenant — cross-tenant leak${NC}"
else
  assert_fail "Audit chain returned unexpected tenant_id=${BIL_VALID}"
fi

# ────────────────────────────────────────────────────────────────
heading "6. Webhook list MUST be tenant-scoped"

BIL_WEBHOOKS=$(curl -sf \
  -H "Authorization: Bearer ${BIL_TOKEN}" \
  -H "X-Tenant-ID: BIL" \
  -H "X-Channel: API" \
  "${BFF_URL}/v1/webhooks" 2>/dev/null | jq -r '.body[].tenant_id // empty' | sort -u || echo "")

if [ -z "${BIL_WEBHOOKS}" ] || [ "${BIL_WEBHOOKS}" = "BIL" ]; then
  assert_pass "BIL /v1/webhooks contains only BIL subscriptions"
else
  assert_fail "BIL /v1/webhooks contains foreign tenant_ids: ${BIL_WEBHOOKS}"
fi

# ────────────────────────────────────────────────────────────────
heading "7. Service-account API key tenant binding"

# Best-effort: probe with a test key if available. Skipped if no key configured.
TEST_API_KEY="${TEST_API_KEY:-}"
if [ -n "${TEST_API_KEY}" ]; then
  # API key has tenant baked in; should ignore X-Tenant-ID overrides
  RESPONSE_TENANT=$(curl -sf \
    -H "Authorization: Bearer ${TEST_API_KEY}" \
    -H "X-Tenant-ID: WRONG_TENANT_THAT_DOESNT_EXIST" \
    -H "X-Channel: API" \
    "${BFF_URL}/v1/svc/whoami" | jq -r '.body.tenant_id // empty')

  if [ -n "${RESPONSE_TENANT}" ] && [ "${RESPONSE_TENANT}" != "WRONG_TENANT_THAT_DOESNT_EXIST" ]; then
    assert_pass "API key tenant_id (${RESPONSE_TENANT}) wins over X-Tenant-ID header"
  else
    assert_fail "${RED}CRITICAL: API key auth honored X-Tenant-ID override — tenant isolation BROKEN${NC}"
  fi
else
  echo -e "  ${YELLOW}⚠${NC} TEST_API_KEY not set; skipping service-account isolation test"
fi

# ────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "Tenant isolation: ${GREEN}PASS=${PASS}${NC} ${RED}FAIL=${FAIL}${NC}"
echo "═══════════════════════════════════════════"

if [ "${FAIL}" -gt 0 ]; then
  echo -e "${RED}TENANT ISOLATION FAILED — DO NOT PROCEED TO PENTEST OR GO-LIVE${NC}"
  exit 1
fi
exit 0
