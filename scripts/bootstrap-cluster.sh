#!/usr/bin/env bash
# Cluster bootstrap automation — runs after EKS cluster + terraform on
# 20-eks complete. Installs Karpenter, ESO, ArgoCD, kube-prometheus-stack,
# and the bootstrap Application for App-of-Apps.
#
# Phases: T3-P2, T3-P3, T3-P4, T5-P1.
#
# Usage:
#   ./scripts/bootstrap-cluster.sh apex-ews-prod

set -euo pipefail

CLUSTER_NAME="${1:-apex-ews-prod}"
REGION="${REGION:-af-south-1}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

log() { echo -e "[$(date -u +%H:%M:%SZ)] $*"; }
step() { echo ""; log "${YELLOW}── $* ──${NC}"; }

step "1. Verify kubectl context + cluster"
aws eks update-kubeconfig --name "${CLUSTER_NAME}" --region "${REGION}"
kubectl get nodes -o wide

step "2. Install Karpenter (T3-P2)"
./infra/k8s/karpenter/install.sh "${CLUSTER_NAME}"

step "3. Install External Secrets Operator (T3-P3)"
ESO_ROLE_ARN=$(terraform -chdir=infra/terraform/20-eks output -raw external_secrets_role_arn 2>/dev/null || echo "")

if [ -z "${ESO_ROLE_ARN}" ]; then
  log "WARN: external_secrets_role_arn not in 20-eks outputs. Set var.enable_eso=true and apply. Skipping ESO install."
else
  helm repo add external-secrets https://charts.external-secrets.io
  helm repo update
  helm upgrade --install external-secrets external-secrets/external-secrets \
    --namespace external-secrets --create-namespace \
    --set installCRDs=true \
    --set serviceAccount.create=true \
    --set serviceAccount.name=external-secrets \
    --set "serviceAccount.annotations.eks\.amazonaws\.com/role-arn=${ESO_ROLE_ARN}" \
    --wait --timeout 5m

  log "Waiting for ESO CRDs to register..."
  kubectl wait --for condition=established --timeout=120s \
    crd/externalsecrets.external-secrets.io \
    crd/clustersecretstores.external-secrets.io

  log "Applying ClusterSecretStore..."
  kubectl apply -f infra/k8s/external-secrets/cluster-secret-store.yaml
  log "${GREEN}✓${NC} External Secrets Operator installed"
fi

step "4. Install ArgoCD (T3-P4)"
kubectl apply -f infra/k8s/argocd/namespace.yaml
helm repo add argo https://argoproj.github.io/argo-helm
helm repo update
helm upgrade --install argocd argo/argo-cd \
  --namespace argocd \
  --set server.extraArgs='{--insecure}' \
  --set configs.params.server\\.insecure=true \
  --wait --timeout 10m

log "Waiting for ArgoCD server..."
kubectl wait --for=condition=available deployment/argocd-server -n argocd --timeout=5m
log "${GREEN}✓${NC} ArgoCD installed; bootstrap Application apply next"

step "5. Apply App-of-Apps bootstrap"
kubectl apply -f infra/k8s/argocd/bootstrap.yaml

log "Waiting for ArgoCD to sync child Applications (up to 10 min)..."
for i in {1..60}; do
  TOTAL=$(kubectl get applications -n argocd --no-headers 2>/dev/null | wc -l | xargs)
  HEALTHY=$(kubectl get applications -n argocd -o json 2>/dev/null \
    | jq '[.items[] | select(.status.health.status == "Healthy" and .status.sync.status == "Synced")] | length' || echo 0)

  log "  apps: total=${TOTAL} healthy+synced=${HEALTHY}"
  if [ "${TOTAL}" -gt 0 ] && [ "${HEALTHY}" = "${TOTAL}" ]; then
    log "${GREEN}✓${NC} all ${TOTAL} apps Healthy + Synced"
    break
  fi
  sleep 10
done

step "6. Install kube-prometheus-stack (T5-P1)"
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --set fullnameOverride=prom \
  --set prometheus.prometheusSpec.retention=15d \
  --set prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage=200Gi \
  --set prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.storageClassName=gp3 \
  --set grafana.persistence.enabled=true \
  --set grafana.persistence.size=10Gi \
  --set grafana.adminPassword=changeme-via-argocd \
  --wait --timeout 10m

log "Applying SLO recording + alerting rules..."
kubectl apply -f infra/k8s/prometheus/recording-rules.yaml
kubectl apply -f infra/k8s/prometheus/alerting-rules.yaml
kubectl apply -f infra/k8s/prometheus/infra-alerting.yaml

log "${GREEN}✓${NC} Prometheus + Grafana installed; SLO rules applied"

step "7. Verify"
echo ""
log "Bootstrap summary:"
log "  Karpenter NodePools:"
kubectl get nodepools -o name 2>/dev/null | sed 's/^/    /'
log "  ESO sync status:"
kubectl get externalsecret -A --no-headers 2>/dev/null | head -5 | sed 's/^/    /'
log "  ArgoCD apps:"
kubectl get applications -n argocd --no-headers 2>/dev/null | sed 's/^/    /'
log "  Prometheus rules:"
kubectl get prometheusrule -n monitoring --no-headers 2>/dev/null | sed 's/^/    /'

echo ""
log "${GREEN}═══════════════════════════════════════════${NC}"
log "${GREEN}Cluster bootstrap complete.${NC}"
log "Next: Run scripts/smoke.sh to validate end-to-end."
log "${GREEN}═══════════════════════════════════════════${NC}"
