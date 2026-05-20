# Karpenter bootstrap

T4.4 — just-in-time node provisioning for the ZorEWS EKS cluster.

## Sequence

1. **Terraform 20-eks** with `enable_karpenter = true` — creates IAM
   role, SQS interruption queue, EventBridge rules, instance profile.
2. **Tag VPC subnets + security groups** with
   `karpenter.sh/discovery=apex-ews-prod` (the EC2NodeClass selector
   below uses this tag to find networking). Tags applied in
   `infra/terraform/10-network/` via `var.karpenter_discovery_tag`.
3. **Install Karpenter** via Helm (chart docs:
   https://karpenter.sh/docs/getting-started/):

   ```bash
   helm upgrade --install karpenter \
     oci://public.ecr.aws/karpenter/karpenter \
     --version 1.0.0 \
     --namespace karpenter \
     --create-namespace \
     --set settings.clusterName=apex-ews-prod \
     --set settings.interruptionQueue=apex-ews-prod-karpenter \
     --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=$(terraform -chdir=../../terraform/20-eks output -raw karpenter_controller_role_arn) \
     --wait
   ```

4. **Apply NodePools + EC2NodeClass**:

   ```bash
   kubectl apply -f infra/k8s/karpenter/nodepool.yaml
   ```

5. **Scale down the manually-managed node groups** to a minimal floor
   (e.g. `desired_size = 2` on the `general` group, `0` on `ai`). The
   floor exists to seed the Karpenter controller itself + critical
   system daemonsets. Karpenter takes over for everything else.

## Verifying

```bash
# Karpenter controller running?
kubectl -n karpenter get pods

# NodePools registered?
kubectl get nodepools

# Karpenter logs (watch for "launched node" events on pod scheduling)
kubectl -n karpenter logs -l app.kubernetes.io/name=karpenter --tail=100

# Pod-to-node mapping
kubectl get pods -o wide
```

## Rollback

If Karpenter misbehaves: scale the static node groups back to their
previous `desired_size` values, then `kubectl delete -f nodepool.yaml`
to stop new provisioning. The Helm chart itself can be uninstalled with
`helm uninstall karpenter -n karpenter`. Terraform `var.enable_karpenter
= false` (next apply) cleans up the IAM + SQS resources.

## References

- `infra/terraform/20-eks/karpenter.tf` — IAM + SQS + EventBridge IaC.
- `infra/k8s/hpa.yaml` — per-service HPAs that drive node demand.
- `infra/k8s/pdb.yaml` — PDBs constraining Karpenter consolidation.
- `docs/year-2-backlog.md` Theme H — cost optimisation incl.
  Karpenter spot-instance ramp.
- `docs/risk-register.md` R-007 — secondary-region availability for
  Karpenter NodePool override.
