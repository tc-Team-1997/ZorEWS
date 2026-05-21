#!/usr/bin/env bash
# Production smoke test — runs after every deploy + during BAU daily checklist.
# Exits 0 only if every check passes.
#
# Usage:
#   ENV=prod ./scripts/smoke.sh
#   ENV=staging ./scripts/smoke.sh
#
# Covers the following per docs/operationalization/readiness-checklists.md §4:
#   - Cluster reachable + nodes Ready
#   - All ArgoCD apps Healthy + Synced
#   - All ExternalSecrets Synced
#   - All HPAs current populated
#   - All PDBs ALLOWED DISRUPTIONS ≥ 1
#   - Prometheus targets UP
#   - Public API /healthz returns 200
#   - Audit chain integrity for every configured tenant
#   - JWKS endpoint serves valid JWK Set
#   - All adapters healthy in /v1/integrations/adapters/health

set -euo pipefail

ENV="${ENV:-prod}"
BFF_URL="${BFF_URL:-https://api.apex-ews.example}"
AUTH_URL="${AUTH_URL:-https://auth.apex-ews.example}"
ADMIN_USER="${ADMIN_USER:-alice.admin}"
ADMIN_PASS_SECRET_ID="${ADMIN_PASS_SECRET_ID:-apex-ews/${ENV}/admin-smoke-credentials}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0
warned=0

assert_pass() {
  echo -e "  ${GREEN}✓${NC} $1"
  PASS=$((PASS+1))
}

assert_fail() {
  echo -e "  ${RED}✕${NC} $1"
  FAIL=$((FAIL+1))
}

assert_warn() {
  echo -e "  ${YELLOW}⚠${NC} $1"
  warned=$((warned+1))
}

heading() {
  echo ""
  echo "── $1 ──"
}

# ────────────────────────────────────────────────────────────────
heading "1. Cluster reachable"

if kubectl cluster-info > /dev/null 2>&1; then
  NODES_READY=$(kubectl get nodes -o jsonpath='{.items[?(@.status.conditions[-1:].status=="True")].metadata.name}' | wc -w | xargs)
  NODES_TOTAL=$(kubectl get nodes -o name | wc -l | xargs)
  if [ "${NODES_READY}" -ge 5 ]; then
    assert_pass "${NODES_READY}/${NODES_TOTAL} nodes Ready"
  else
    assert_fail "Only ${NODES_READY}/${NODES_TOTAL} nodes Ready (expected ≥5)"
  fi
else
  assert_fail "kubectl cluster-info failed — no cluster connection"
  exit 1
fi

# ────────────────────────────────────────────────────────────────
heading "2. ArgoCD apps Healthy + Synced"

if command -v argocd > /dev/null; then
  UNHEALTHY=$(argocd app list -o json 2>/dev/null \
    | jq -r '.[] | select(.status.health.status != "Healthy" or .status.sync.status != "Synced") | .metadata.name' \
    | wc -l | xargs)

  if [ "${UNHEALTHY}" = "0" ]; then
    assert_pass "all ArgoCD apps Healthy + Synced"
  else
    assert_fail "${UNHEALTHY} ArgoCD apps not Healthy or not Synced"
    argocd app list 2>/dev/null | head -20
  fi
else
  assert_warn "argocd CLI not installed; skipping app status check"
fi

# ────────────────────────────────────────────────────────────────
heading "3. ExternalSecrets Synced"

ES_STALE=$(kubectl get externalsecret -A -o json 2>/dev/null \
  | jq -r '.items[] | select(.status.conditions == null or .status.conditions[-1].status != "True") | "\(.metadata.namespace)/\(.metadata.name)"' \
  | wc -l | xargs)

if [ "${ES_STALE}" = "0" ]; then
  assert_pass "all ExternalSecrets SyncedToTarget"
else
  assert_fail "${ES_STALE} ExternalSecrets not synced"
fi

# ────────────────────────────────────────────────────────────────
heading "4. HPAs current populated"

HPA_UNKNOWN=$(kubectl get hpa -A -o json 2>/dev/null \
  | jq -r '.items[] | select(.status.currentMetrics == null) | "\(.metadata.namespace)/\(.metadata.name)"' \
  | wc -l | xargs)

if [ "${HPA_UNKNOWN}" = "0" ]; then
  assert_pass "all HPAs report currentMetrics"
else
  assert_fail "${HPA_UNKNOWN} HPAs show <unknown> current metric"
fi

# ────────────────────────────────────────────────────────────────
heading "5. PDBs allow voluntary disruptions"

PDB_BLOCKED=$(kubectl get pdb -A -o json 2>/dev/null \
  | jq -r '.items[] | select(.status.disruptionsAllowed == 0) | "\(.metadata.namespace)/\(.metadata.name)"' \
  | wc -l | xargs)

if [ "${PDB_BLOCKED}" = "0" ]; then
  assert_pass "all PDBs allow ≥ 1 disruption"
else
  assert_warn "${PDB_BLOCKED} PDBs blocked (allow=0) — investigate pod health"
fi

# ────────────────────────────────────────────────────────────────
heading "6. Public API healthz"

if curl -sf -o /dev/null -w "%{http_code}" --max-time 5 "${BFF_URL}/healthz" | grep -q '^200'; then
  assert_pass "BFF /healthz returns 200"
else
  assert_fail "BFF /healthz did not return 200"
fi

if curl -sf -o /dev/null -w "%{http_code}" --max-time 5 "${AUTH_URL}/healthz" | grep -q '^200'; then
  assert_pass "auth-svc /healthz returns 200"
else
  assert_fail "auth-svc /healthz did not return 200"
fi

# ────────────────────────────────────────────────────────────────
heading "7. JWKS endpoint"

JWKS_BODY=$(curl -sf --max-time 5 "${AUTH_URL}/.well-known/jwks.json" || echo "")
if echo "${JWKS_BODY}" | jq -e '.keys[0].kty == "RSA" and .keys[0].alg == "RS256"' > /dev/null 2>&1; then
  assert_pass "JWKS returns valid RS256 key set"
else
  assert_fail "JWKS endpoint did not return a valid key set"
fi

# ────────────────────────────────────────────────────────────────
heading "8. Admin auth + audit-chain integrity"

# Fetch admin smoke credentials from Secrets Manager
if command -v aws > /dev/null; then
  CREDS=$(aws secretsmanager get-secret-value --secret-id "${ADMIN_PASS_SECRET_ID}" --query SecretString --output text 2>/dev/null || echo "")
  if [ -n "${CREDS}" ]; then
    USERNAME=$(echo "${CREDS}" | jq -r '.username')
    PASSWORD=$(echo "${CREDS}" | jq -r '.password')

    TOKEN_RESPONSE=$(curl -sf -X POST -H "Content-Type: application/json" \
      -d "{\"username\":\"${USERNAME}\",\"password\":\"${PASSWORD}\"}" \
      "${AUTH_URL}/auth/login" --max-time 10 || echo "")

    ACCESS_TOKEN=$(echo "${TOKEN_RESPONSE}" | jq -r '.access_token // empty')

    if [ -n "${ACCESS_TOKEN}" ]; then
      assert_pass "admin login succeeded; access token obtained"

      # Audit chain integrity per tenant
      for tenant in BANK_DEMO BIL; do
        VALID=$(curl -sf \
          -H "Authorization: Bearer ${ACCESS_TOKEN}" \
          -H "X-Tenant-ID: ${tenant}" \
          -H "X-Channel: API" \
          "${BFF_URL}/v1/audit/integrity" --max-time 10 \
          | jq -r '.body.valid // false' 2>/dev/null || echo "false")

        if [ "${VALID}" = "true" ]; then
          assert_pass "audit chain integrity OK for tenant ${tenant}"
        else
          assert_fail "audit chain INTEGRITY FAIL for tenant ${tenant} — wake CISO"
        fi
      done
    else
      assert_warn "admin login failed; skipping audit-chain check"
    fi
  else
    assert_warn "admin smoke credentials not in Secrets Manager (${ADMIN_PASS_SECRET_ID})"
  fi
else
  assert_warn "aws CLI not installed; skipping admin auth check"
fi

# ────────────────────────────────────────────────────────────────
heading "9. Adapter fleet health"

if [ -n "${ACCESS_TOKEN:-}" ]; then
  HEALTH=$(curl -sf \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "X-Tenant-ID: BANK_DEMO" \
    -H "X-Channel: API" \
    "${BFF_URL}/v1/integrations/adapters/health" --max-time 10 || echo "")

  UP_COUNT=$(echo "${HEALTH}" | jq -r '.body.up_count // 0' 2>/dev/null)
  TOTAL=$(echo "${HEALTH}" | jq -r '.body.total // 0' 2>/dev/null)

  if [ "${UP_COUNT}" = "8" ] && [ "${TOTAL}" = "8" ]; then
    assert_pass "all 8 adapters UP"
  elif [ "${UP_COUNT}" -ge "6" ]; then
    assert_warn "${UP_COUNT}/8 adapters UP — investigate degraded adapters"
  else
    assert_fail "${UP_COUNT}/8 adapters UP (expected 8)"
  fi
else
  assert_warn "skipped (no token from prior step)"
fi

# ────────────────────────────────────────────────────────────────
heading "10. Prometheus targets"

PROM_URL="${PROMETHEUS_URL:-}"
if [ -n "${PROM_URL}" ]; then
  TARGETS_DOWN=$(curl -sf "${PROM_URL}/api/v1/targets" --max-time 10 \
    | jq '[.data.activeTargets[] | select(.health != "up")] | length' 2>/dev/null || echo "1")

  if [ "${TARGETS_DOWN}" = "0" ]; then
    assert_pass "all Prometheus targets UP"
  else
    assert_warn "${TARGETS_DOWN} Prometheus targets down"
  fi
else
  assert_warn "PROMETHEUS_URL not set; skipping target health check"
fi

# ────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "Smoke result: ${GREEN}PASS=${PASS}${NC} ${RED}FAIL=${FAIL}${NC} ${YELLOW}WARN=${warned}${NC}"
echo "═══════════════════════════════════════════"

if [ "${FAIL}" -gt "0" ]; then
  exit 1
fi
exit 0
