# ZorEWS — Compliance Control Mapping

> Phase 0 deliverable T0.5. Maps Kenya **Data Protection Act 2019 (DPA 2019)** and **ISO/IEC 27001:2022** Annex A controls onto the artefacts shipped in this monorepo.

## DPA 2019 — Principles & Sections

| Section / Principle | Requirement | Implementation in this monorepo |
|---|---|---|
| **§25(a) Lawful processing** | Process data only on a lawful basis | `services/auth-svc/` enforces RBAC by role; only `risk_analyst`/`supervisor`/`admin` reach customer data. RBAC matrix in `infra/k8s/rbac.yaml` + REST roles. |
| **§25(b) Purpose limitation** | Process only for stated purpose | Topic schemas in `infra/schema-registry/` carry no PII (only opaque `customer_id`). PII is fetched per-request via CBS REST with full audit trail. |
| **§25(c) Data minimisation** | Collect only what is necessary | CBS contract `integrations/cbs/contract.md` redacts name/MSISDN/national-ID at the source. |
| **§25(d) Accuracy** | Keep data accurate and up-to-date | dbt quality gates (agent-data) + reconciliation rules (`RECON_001/002`). |
| **§25(e) Storage limitation** | Retain only as long as necessary | S3 `audit` Object Lock = 7y (matches CBK retention rule); raw + curated have lifecycle rules to be tuned by agent-data. |
| **§25(f) Integrity & confidentiality** | Appropriate security | KMS CMKs (aurora/s3/msk/secret/ebs) in `infra/terraform/00-landing-zone/main.tf`. TLS 1.2+ everywhere. WAF + Shield in `40-edge`. |
| **§30 Cross-border transfer** | Restrict to safeguarded jurisdictions | SCP `apex-ews-deny-non-allowed-regions` pins data to `af-south-1` (+ `eu-west-1` DR). |
| **§31 Sensitive personal data** | Stricter conditions | KYC flag changes published as opaque hashes (CBS contract). |
| **§39 Breach notification** | Notify ODPC ≤ 72h | VPC Flow Logs + CloudTrail + audit-svc chain enable a 72h forensic timeline. Runbook hand-off: orchestrator T5.3. |
| **§41 Security of processing** | Risk-appropriate measures | argon2id passwords + TOTP MFA in `auth-svc`; immutable audit chain in `audit-svc`. |
| **§42 Notification of breach to data subject** | Communicate without undue delay | `notification-svc` (SES + Africa's Talking) — adapter pattern reusable for breach notice fan-out. |
| **§47 DPIA** | Required for high-risk processing | Doc placeholder — agent-orchestrator T0.1 risk register feeds the DPIA. |

## ISO/IEC 27001:2022 — Annex A controls

| Control | Title | Implementation |
|---|---|---|
| **A.5.1** Policies for information security | — | `docs/` + `AGENTS.md` Update Protocol = documented operating model. |
| **A.5.10** Acceptable use of information | — | Pod-Security `restricted` enforced per ns (`infra/k8s/namespaces.yaml`). |
| **A.5.15** Access control | RBAC | `infra/k8s/rbac.yaml` + `auth-svc` role claims in JWT. |
| **A.5.17** Authentication information | MFA + secrets | TOTP MFA in `auth-svc`; secrets in AWS Secrets Manager + KMS `alias/apex-ews-secret`. |
| **A.5.23** Cloud services security | — | SCPs (deny non-region, require encryption) in `00-landing-zone`. |
| **A.5.30** ICT readiness for BC | DR | Phase 5 DR plan; Aurora Global DB + S3 CRR + MSK MM2 — see `docs/architecture.md`. |
| **A.6.3** Security awareness training | — | Out-of-scope here (HR/training). |
| **A.8.2** Privileged access rights | — | `apex-ews-admin` ClusterRole + binding via SSO group `apex-ews:admins`. |
| **A.8.5** Secure authentication | — | argon2id + TOTP + RS256 JWT signed by KMS. |
| **A.8.7** Protection against malware | — | ECR scan-on-push (CI gate X.3). |
| **A.8.9** Configuration management | IaC | All infra via Terraform; CI runs `terraform validate`. |
| **A.8.10** Information deletion | — | S3 lifecycle + Object Lock retention boundaries. |
| **A.8.11** Data masking | — | PII never on Kafka payloads; field-encryption for free-text notes. |
| **A.8.12** DLP | — | VPC endpoints keep S3/ECR off NAT; egress NetworkPolicy except 443. |
| **A.8.13** Information backup | — | Aurora 35-day retention + automated snapshots; S3 versioning on. |
| **A.8.15** Logging | — | CloudTrail org-wide + EKS control-plane logs + VPC Flow Logs (1y). |
| **A.8.16** Monitoring activities | — | CloudWatch + X-Ray (NFR-OBS). |
| **A.8.20** Network security | — | 3-tier subnets, default-deny NetworkPolicies, SGs with no 0.0.0.0/0 except ALB:443. |
| **A.8.22** Segregation of networks | — | Public/private/data subnet split + ns-per-tier in K8s. |
| **A.8.23** Web filtering | — | WAF Common rules + rate limit. |
| **A.8.24** Use of cryptography | — | KMS CMKs + TLS 1.2+ + RS256 JWT. |
| **A.8.25** Secure development life cycle | — | This monorepo's agent loop + per-agent owned paths. |
| **A.8.26** Application security requirements | OWASP ASVS L2 | NFR-SEC-2 — enforced in service code. |
| **A.8.28** Secure coding | — | Strict TS, mypy/Pydantic, hashlib canonicalisation. |
| **A.8.32** Change management | — | Branch-per-agent + TASKS.md tick gate. |
| **A.8.34** Protection of audit info | Hash-chain | `audit-svc` SHA-256 chain → S3 Object Lock COMPLIANCE 7y. |

## Evidence catalogue

Auditors should sample:

1. `infra/terraform/00-landing-zone/main.tf` — SCPs + KMS + CloudTrail.
2. `infra/terraform/30-data/main.tf` — Object Lock + KMS.
3. `services/audit-svc/src/audit_svc/chain.py` + `tests/test_chain.py` — chain integrity proof.
4. `services/auth-svc/src/routes/auth.ts` + `__tests__/auth.test.ts` — MFA enforcement proof.
5. `infra/k8s/rbac.yaml` — least-privilege groupings.
6. `infra/k8s/network-policies.yaml` — default-deny baseline.
