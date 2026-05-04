# APEX EWS — Terraform

Layered IaC. Apply order is strictly numerical. Each layer publishes outputs that the next layer consumes via `terraform_remote_state` (or `data` lookups in production via SSM).

| Layer | Purpose |
|-------|---------|
| `00-landing-zone/` | AWS Organizations, SCPs (deny non-`af-south-1`), org-wide CloudTrail, KMS CMKs |
| `10-network/`      | VPC `10.0.0.0/16` in `af-south-1`, 3 AZs, public/private/data subnets, NATs |
| `20-eks/`          | EKS 1.30, general + ai node groups, IRSA roles per micro-service |
| `30-data/`         | Aurora PostgreSQL 16 Multi-AZ, ElastiCache Redis 7.2, S3 (audit/raw/curated), MSK 3-broker |
| `40-edge/`         | ALB, WAF, Shield Advanced, Route53, CloudFront for SPA |

## Conventions

- Region: `af-south-1` (Cape Town). SCP denies any other region.
- Naming: `apex-ews-<env>-<resource>`.
- Tags: `Project=apex-ews`, `Owner=agent-integration`, `Compliance=DPA2019,ISO27001`.
- State backend: S3 + DynamoDB lock (configured in `versions.tf` of each layer; comment out for local validate).

## Local validation

```bash
cd infra/terraform/<layer>
terraform fmt -recursive .
terraform init -backend=false
terraform validate
```

`terraform fmt -recursive infra/terraform` from the repo root must come back clean.
