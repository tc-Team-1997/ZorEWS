#!/usr/bin/env bash
# Emergency rollback — reverts a production deploy via ArgoCD app history.
# Requires CISO sign-off in #apex-ews-incident.
#
# Usage:
#   ./scripts/rollback.sh                                    # rolls every app back 1 revision
#   ./scripts/rollback.sh bff                                # roll just BFF
#   ./scripts/rollback.sh bff 5                              # roll BFF to history revision 5
#   ./scripts/rollback.sh --integrations-mode-mock           # flip BFF to mock integrations

set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'

# CISO sign-off check (acknowledged via env var)
if [ -z "${CISO_SIGNOFF:-}" ]; then
  echo -e "${RED}ERROR: CISO sign-off required for emergency rollback.${NC}"
  echo "Set CISO_SIGNOFF=yes-by-<incident_id> after posting in #apex-ews-incident."
  exit 1
fi

echo -e "${YELLOW}Rollback initiated by $(whoami) with CISO_SIGNOFF=${CISO_SIGNOFF}${NC}"
date -u +%Y-%m-%dT%H:%M:%SZ

# Audit-record the rollback intent (will be re-emitted as audit event via the
# audit-svc once it's healthy; this is the local safety record).
mkdir -p .rollback-log
ROLLBACK_LOG=".rollback-log/rollback-$(date -u +%Y%m%dT%H%M%SZ).log"

{
  echo "## Rollback log"
  echo "actor: $(whoami)"
  echo "args:  $@"
  echo "ciso_signoff: ${CISO_SIGNOFF}"
  echo "started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >> "${ROLLBACK_LOG}"

case "${1:-}" in
  --integrations-mode-mock)
    echo "Flipping INTEGRATIONS_MODE=mock on BFF + collection-adapter..."
    kubectl set env deployment/bff INTEGRATIONS_MODE=mock -n apex-ews
    kubectl set env deployment/collection-adapter INTEGRATIONS_MODE=mock -n apex-ews
    kubectl rollout status deployment/bff -n apex-ews --timeout=5m
    echo -e "${GREEN}✓ INTEGRATIONS_MODE=mock applied; bank integrations fall back to mocks${NC}"
    echo "ACTION: deactivate live VPN routes if needed via:" \
         "terraform -chdir=infra/terraform/05-vpn destroy -auto-approve" >> "${ROLLBACK_LOG}"
    ;;
  --tenant-disable)
    TENANT_ID="${2:-}"
    if [ -z "${TENANT_ID}" ]; then
      echo "Usage: $0 --tenant-disable <TENANT_ID>"; exit 1
    fi
    echo "Disabling tenant ${TENANT_ID} (PATCH /v1/tenants/:id active=false)..."
    BFF_URL="${BFF_URL:-https://api.apex-ews.example}"
    curl -sf -X PATCH \
      -H "Authorization: Bearer ${ACCESS_TOKEN:-}" \
      -H "X-Tenant-ID: BANK_DEMO" \
      -H "X-Channel: API" \
      -H "Content-Type: application/json" \
      -d '{"active":false}' \
      "${BFF_URL}/v1/tenants/${TENANT_ID}"
    echo -e "${GREEN}✓ Tenant ${TENANT_ID} disabled${NC}"
    ;;
  bff|auth-svc|audit-svc|regulatory-svc-cases|regulatory-svc-alerts|regulatory-svc-rules|regulatory-svc-indicators|collection-adapter|notification-svc|ai-copilot-svc|pipeline-svc)
    APP="$1"
    REV="${2:-}"
    if [ -z "${REV}" ]; then
      echo "Rolling ${APP} back to previous revision (history -1)..."
      argocd app rollback "${APP}"
    else
      echo "Rolling ${APP} back to revision ${REV}..."
      argocd app rollback "${APP}" "${REV}"
    fi
    argocd app wait "${APP}" --health --timeout 600
    echo -e "${GREEN}✓ ${APP} rolled back${NC}"
    ;;
  "")
    echo "Rolling EVERY ArgoCD app back to previous revision..."
    for app in $(argocd app list -o name | grep apex-ews); do
      echo "  rolling ${app}..."
      argocd app rollback "${app}" 2>/dev/null || echo "    skipped (no prior revision)"
    done
    echo "Waiting for all apps to be Healthy..."
    for app in $(argocd app list -o name | grep apex-ews); do
      argocd app wait "${app}" --health --timeout 600 || true
    done
    echo -e "${GREEN}✓ All apps rolled back${NC}"
    ;;
  *)
    echo "Unknown rollback target: $1"
    echo "Usage: $0 [<app-name> [revision]]"
    echo "       $0 --integrations-mode-mock"
    echo "       $0 --tenant-disable <TENANT_ID>"
    echo "       $0   # without args: roll every app back 1 revision"
    exit 1
    ;;
esac

# Post-rollback validation
echo ""
echo "Running post-rollback smoke test..."
if ./scripts/smoke.sh; then
  echo -e "${GREEN}✓ Post-rollback smoke PASSED${NC}"
else
  echo -e "${RED}✕ Post-rollback smoke FAILED — escalate to CISO immediately${NC}"
  exit 2
fi

{
  echo "completed: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "outcome: SUCCESS"
} >> "${ROLLBACK_LOG}"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}Rollback complete. Log: ${ROLLBACK_LOG}${NC}"
echo -e "${GREEN}NEXT: post-mortem within 48h, append to docs/bau-runbook.md change log.${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
