# Operational scripts

Production operational scripts referenced by `docs/operationalization/*.md`.

| Script | Purpose | When to run | Owner |
|---|---|---|---|
| `bootstrap-cluster.sh` | One-shot cluster bring-up: Karpenter + ESO + ArgoCD + Prometheus + observability | T3-P2 → T3-P4 → T5-P1 sequence | SRE |
| `smoke.sh` | Daily + post-deploy smoke validation (10 checks) | BAU daily; after every deploy | on-call SRE |
| `deploy-validate.sh` | Pre- and post-deploy validation hooks | Inside CI deploy pipeline | CI |
| `dr-drill.sh` | DR game-day automation with scoring rubric | Quarterly (Q1/Q2/Q3/Q4) | SRE-lead + CISO |
| `rollback.sh` | Emergency rollback (CISO sign-off required) | Incident response only | on-call SRE |
| `infra-health.sh` | Walks every infra row from readiness-checklists.md §2 | BAU daily; after IaC change | SRE |
| `seed-secrets.sh` | Bootstrap Secrets Manager with every key the ESO manifests expect | T3-P3 (one-shot per env) + before secret rotation | SRE |
| `test-tenant-isolation.sh` | Security test verifying cross-tenant data leak is impossible | Pre-pentest (T7-P2) + every deploy involving auth/tenant code | CISO + SRE |

## Make targets

Wire these into the existing top-level `Makefile`:

```makefile
.PHONY: smoke dr-drill bootstrap deploy-validate-pre deploy-validate-post infra-health

smoke:
	@./scripts/smoke.sh

infra-health:
	@./scripts/infra-health.sh

dr-drill:
	@./scripts/dr-drill.sh --scope=$${SCOPE:-aurora} --target=$${TARGET:-staging}

bootstrap:
	@./scripts/bootstrap-cluster.sh $${CLUSTER:-apex-ews-prod}

deploy-validate-pre:
	@DEPLOY_PHASE=pre ./scripts/deploy-validate.sh

deploy-validate-post:
	@DEPLOY_PHASE=post ./scripts/deploy-validate.sh
```

## Permissions

Make scripts executable:

```bash
chmod +x scripts/*.sh
```

CI runners need:
- `aws` CLI (configured via OIDC role per `infra/terraform/00-landing-zone/baseline.tf`)
- `kubectl` (1.30 or matching cluster)
- `argocd` (1.x)
- `helm` (3.x)
- `jq`
- `curl`

## Outputs

| Script | Output location |
|---|---|
| `dr-drill.sh` | `reports/dr-drills/<timestamp>-<scope>-<target>.md` (committed to repo for audit) |
| `rollback.sh` | `.rollback-log/rollback-<timestamp>.log` (gitignored — local incident artifact) |
| `smoke.sh` | stdout only; integrate into Prometheus blackbox-exporter for continuous run |
| `infra-health.sh` | stdout only; wire into PagerDuty via `--exit-code-failure` for cron schedule |

## Cross-reference

- Per-phase deliverables: [`docs/operationalization/execution-plans.md`](../docs/operationalization/execution-plans.md)
- Readiness rows verified: [`docs/operationalization/readiness-checklists.md`](../docs/operationalization/readiness-checklists.md)
- BAU usage: [`docs/bau-runbook.md`](../docs/bau-runbook.md) § daily/weekly checklists
- DR usage: [`docs/dr-runbook.md`](../docs/dr-runbook.md) + [`docs/dr-game-day-plan.md`](../docs/dr-game-day-plan.md)
