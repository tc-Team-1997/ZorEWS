#!/usr/bin/env bash
# Karpenter bootstrap — T3-P2.
#
# Prerequisites:
#   - EKS cluster apex-ews-prod created (T3-P1)
#   - kubectl context pointed at the cluster
#   - terraform applied on infra/terraform/20-eks with var.enable_karpenter=true
#   - aws CLI logged in to the production account
#
# Usage: ./install.sh [cluster-name] [karpenter-version]

set -euo pipefail

CLUSTER_NAME="${1:-apex-ews-prod}"
KARPENTER_VERSION="${2:-1.0.0}"
NAMESPACE="karpenter"

echo "==> Karpenter bootstrap on cluster=${CLUSTER_NAME} version=${KARPENTER_VERSION}"

# 1. Verify cluster + node group + IAM prereqs
echo "==> Verifying cluster prereqs..."
kubectl config current-context
kubectl get nodes -o wide | head -3
aws sts get-caller-identity > /dev/null
aws eks describe-cluster --name "${CLUSTER_NAME}" --query 'cluster.status' --output text | grep -q ACTIVE

# 2. Resolve Karpenter controller IRSA role ARN from Terraform outputs
echo "==> Resolving Karpenter controller IAM role ARN..."
KARPENTER_ROLE_ARN=$(terraform -chdir="../../terraform/20-eks" output -raw karpenter_controller_role_arn 2>/dev/null)
KARPENTER_QUEUE=$(terraform -chdir="../../terraform/20-eks" output -raw karpenter_interruption_queue 2>/dev/null)

if [ -z "${KARPENTER_ROLE_ARN}" ] || [ -z "${KARPENTER_QUEUE}" ]; then
  echo "ERROR: terraform outputs karpenter_controller_role_arn or karpenter_interruption_queue not set."
  echo "       Set var.enable_karpenter=true in 20-eks and apply, then re-run."
  exit 1
fi

echo "    role_arn=${KARPENTER_ROLE_ARN}"
echo "    queue=${KARPENTER_QUEUE}"

# 3. Tag VPC subnets + security groups for Karpenter discovery (idempotent)
echo "==> Tagging subnets + SGs for Karpenter discovery..."
VPC_ID=$(terraform -chdir="../../terraform/10-network" output -raw vpc_id)
DISCOVERY_TAG="karpenter.sh/discovery=${CLUSTER_NAME}"

# Tag PRIVATE subnets only (Karpenter nodes go in private)
PRIVATE_SUBNETS=$(aws ec2 describe-subnets \
  --filters "Name=vpc-id,Values=${VPC_ID}" "Name=tag:Tier,Values=private" \
  --query 'Subnets[].SubnetId' --output text)

for subnet_id in ${PRIVATE_SUBNETS}; do
  aws ec2 create-tags --resources "${subnet_id}" --tags "Key=karpenter.sh/discovery,Value=${CLUSTER_NAME}"
  echo "    tagged subnet ${subnet_id}"
done

# Tag node-shared security group
NODE_SG=$(aws eks describe-cluster --name "${CLUSTER_NAME}" \
  --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId' --output text)
aws ec2 create-tags --resources "${NODE_SG}" --tags "Key=karpenter.sh/discovery,Value=${CLUSTER_NAME}"
echo "    tagged SG ${NODE_SG}"

# 4. Install Karpenter via Helm OCI chart
echo "==> Installing Karpenter chart v${KARPENTER_VERSION}..."
helm registry logout public.ecr.aws/karpenter 2>/dev/null || true

helm upgrade --install karpenter \
  oci://public.ecr.aws/karpenter/karpenter \
  --version "${KARPENTER_VERSION}" \
  --namespace "${NAMESPACE}" \
  --create-namespace \
  --values "$(dirname "$0")/values.yaml" \
  --set settings.clusterName="${CLUSTER_NAME}" \
  --set settings.interruptionQueue="${KARPENTER_QUEUE}" \
  --set "serviceAccount.annotations.eks\.amazonaws\.com/role-arn=${KARPENTER_ROLE_ARN}" \
  --wait --timeout 5m

echo "==> Waiting for Karpenter to become Ready..."
kubectl -n "${NAMESPACE}" wait --for=condition=Available deployment/karpenter --timeout=5m
kubectl -n "${NAMESPACE}" get pods

# 5. Apply NodePools + EC2NodeClasses
echo "==> Applying NodePools + EC2NodeClass..."
kubectl apply -f "$(dirname "$0")/nodepool.yaml"
kubectl get nodepools -o name
kubectl get ec2nodeclass -o name

# 6. Verify a smoke test scheduling
echo "==> Smoke test: scheduling a single test pod to verify Karpenter activates..."
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: karpenter-smoke-test
  namespace: default
spec:
  nodeSelector:
    karpenter.sh/nodepool: general
  containers:
    - name: pause
      image: registry.k8s.io/pause:3.9
      resources:
        requests:
          cpu: "1"
          memory: "256Mi"
  restartPolicy: Never
EOF

# Wait for pod to bind to a Karpenter-provisioned node (or fall through to existing if any)
sleep 60
SCHEDULED=$(kubectl get pod karpenter-smoke-test -n default -o jsonpath='{.status.phase}' || echo "Unknown")
echo "    smoke pod phase=${SCHEDULED}"
kubectl delete pod karpenter-smoke-test -n default --ignore-not-found

echo ""
echo "==> Karpenter bootstrap complete."
echo "   Verify:  kubectl get nodepools && kubectl logs -n karpenter deploy/karpenter --tail=20"
echo "   Rollback: helm uninstall karpenter -n karpenter && kubectl delete -f nodepool.yaml"
