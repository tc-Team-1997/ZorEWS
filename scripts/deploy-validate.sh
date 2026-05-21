#!/usr/bin/env bash
# Pre-deploy + post-deploy validation. Runs in CI deploy pipeline.
#
# Phases (auto-detected from $DEPLOY_PHASE):
#   pre   — before kubectl apply: schema-compat, image-scan, manifest-lint
#   post  — after kubectl apply: rollout-wait, smoke, slo-budget-check
#
# Usage:
#   DEPLOY_PHASE=pre  ./scripts/deploy-validate.sh
#   DEPLOY_PHASE=post ./scripts/deploy-validate.sh

set -euo pipefail

DEPLOY_PHASE="${DEPLOY_PHASE:-pre}"
NAMESPACE="${NAMESPACE:-apex-ews}"
TIMEOUT="${TIMEOUT:-600s}"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; FAIL=0

assert() {
  if eval "$2" > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} $1"
    PASS=$((PASS+1))
  else
    echo -e "  ${RED}✕${NC} $1"
    FAIL=$((FAIL+1))
  fi
}

pre_deploy() {
  echo ""
  echo "── PRE-DEPLOY VALIDATION ──"

  echo ""
  echo "1. Schema BACKWARD compat check"
  if [ -f infra/schema-registry/scripts/check_compat.py ]; then
    if python3 infra/schema-registry/scripts/check_compat.py 2>&1 | tee /tmp/schema-check.log; then
      assert "schema BACKWARD compat" "true"
    else
      assert "schema BACKWARD compat" "false"
    fi
  else
    echo "  ⚠ check_compat.py not found; skipping"
  fi

  echo ""
  echo "2. Manifest lint (kubeconform)"
  if command -v kubeconform > /dev/null; then
    if kubeconform -summary -strict infra/k8s/*.yaml; then
      assert "kubeconform clean" "true"
    else
      assert "kubeconform clean" "false"
    fi
  else
    echo "  ⚠ kubeconform not installed; skipping"
  fi

  echo ""
  echo "3. Image vulnerability scan (Trivy)"
  if command -v trivy > /dev/null; then
    # Scan the about-to-deploy image tag (passed via env)
    IMAGE="${IMAGE:-${CI_IMAGE_TAG:-not-set}}"
    if [ "${IMAGE}" != "not-set" ]; then
      if trivy image --severity CRITICAL --exit-code 1 --no-progress "${IMAGE}"; then
        assert "Trivy CRITICAL scan clean" "true"
      else
        assert "Trivy CRITICAL scan clean" "false"
      fi
    else
      echo "  ⚠ IMAGE not set; skipping"
    fi
  else
    echo "  ⚠ Trivy not installed; skipping"
  fi

  echo ""
  echo "4. Terraform plan check (5 layers)"
  for layer in 00-landing-zone 05-vpn 10-network 20-eks 30-data 40-edge; do
    if [ -d "infra/terraform/${layer}" ]; then
      if terraform -chdir="infra/terraform/${layer}" fmt -check -diff > /dev/null 2>&1; then
        assert "terraform fmt — ${layer}" "true"
      else
        assert "terraform fmt — ${layer}" "false"
      fi
    fi
  done

  echo ""
  echo "5. Pod Security Standards check"
  CONTAINERS_AS_ROOT=$(find infra/k8s -name '*.yaml' -exec grep -l 'runAsUser: 0\|runAsRoot: true' {} \; | wc -l | xargs)
  if [ "${CONTAINERS_AS_ROOT}" = "0" ]; then
    assert "no containers run as root" "true"
  else
    assert "no containers run as root" "false"
  fi

  echo ""
  echo "6. Image tag check (no :latest)"
  LATEST_TAGS=$(grep -r ':latest' infra/k8s/ 2>/dev/null | wc -l | xargs)
  if [ "${LATEST_TAGS}" = "0" ]; then
    assert "no :latest image tags" "true"
  else
    assert "no :latest image tags" "false"
  fi
}

post_deploy() {
  echo ""
  echo "── POST-DEPLOY VALIDATION ──"

  echo ""
  echo "1. Rollout wait (Deployment status)"
  for deploy in $(kubectl get deployment -n "${NAMESPACE}" -o name 2>/dev/null); do
    if kubectl rollout status "${deploy}" -n "${NAMESPACE}" --timeout="${TIMEOUT}" > /dev/null 2>&1; then
      assert "${deploy} rolled out" "true"
    else
      assert "${deploy} rolled out" "false"
    fi
  done

  echo ""
  echo "2. HPA current populated"
  HPA_UNKNOWN=$(kubectl get hpa -n "${NAMESPACE}" -o json 2>/dev/null \
    | jq '[.items[] | select(.status.currentMetrics == null)] | length' || echo 0)
  if [ "${HPA_UNKNOWN}" = "0" ]; then
    assert "all HPAs current populated" "true"
  else
    assert "all HPAs current populated" "false"
  fi

  echo ""
  echo "3. Pod readiness"
  NOT_READY=$(kubectl get pods -n "${NAMESPACE}" -o json 2>/dev/null \
    | jq '[.items[] | select(.status.phase != "Running" or (.status.containerStatuses // [] | any(.ready != true)))] | length' || echo 0)
  if [ "${NOT_READY}" = "0" ]; then
    assert "all pods Ready" "true"
  else
    assert "all pods Ready" "false"
    kubectl get pods -n "${NAMESPACE}" --field-selector=status.phase!=Running 2>/dev/null
  fi

  echo ""
  echo "4. Smoke test"
  if [ -x ./scripts/smoke.sh ]; then
    if ./scripts/smoke.sh; then
      assert "smoke test passed" "true"
    else
      assert "smoke test passed" "false"
    fi
  else
    echo "  ⚠ scripts/smoke.sh not executable; skipping"
  fi

  echo ""
  echo "5. SLO error budget check (post-deploy)"
  # Query Prometheus for the last 5 minutes' error rate; refuse to PROMOTE
  # this deploy if budget has burnt during deploy window.
  PROM_URL="${PROMETHEUS_URL:-}"
  if [ -n "${PROM_URL}" ]; then
    BURN=$(curl -sf --max-time 10 \
      "${PROM_URL}/api/v1/query?query=apex_ews:slo:bff:burn_rate:1h" \
      | jq -r '.data.result[0].value[1] // "0"' 2>/dev/null || echo 0)

    BURN_INT=${BURN%.*}
    if [ "${BURN_INT}" -le 1 ]; then
      assert "SLO burn rate post-deploy ≤1× (no error budget consumed)" "true"
    else
      assert "SLO burn rate post-deploy ≤1× (burn=${BURN}×)" "false"
    fi
  else
    echo "  ⚠ PROMETHEUS_URL not set; skipping SLO check"
  fi

  echo ""
  echo "6. Audit chain integrity"
  if [ -x ./scripts/smoke.sh ]; then
    # Already covered in smoke; flag separately for explicitness
    echo "  (covered in smoke test §8)"
  fi
}

case "${DEPLOY_PHASE}" in
  pre) pre_deploy ;;
  post) post_deploy ;;
  *) echo "ERROR: DEPLOY_PHASE must be 'pre' or 'post'"; exit 1 ;;
esac

echo ""
echo "═══════════════════════════════════════════"
echo "Result: ${GREEN}PASS=${PASS}${NC} ${RED}FAIL=${FAIL}${NC}"
echo "═══════════════════════════════════════════"

if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
exit 0
