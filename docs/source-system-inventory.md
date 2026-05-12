# ZorEWS — Source-System Inventory

> Phase 0 deliverable T0.3. Lists every upstream system ZorEWS reads from or writes to, the data classes involved, expected volumes, and the contract draft + owner.

| # | System | Owner | Direction | Protocol | Frequency | Volume (peak) | Data classes | Contract |
|---|--------|-------|-----------|----------|-----------|---------------|--------------|----------|
| 1 | Core Banking System (CBS) | Bank — Core Banking | In | Kafka (Debezium CDC) + REST (back-fill) + S3 daily | Real-time + daily | 5,000 ev/s | Loan, repayment, account, customer-profile change | `integrations/cbs/contract.md` + `integrations/cbs/openapi.yaml` |
| 2 | Loan Origination System (LOS) | Bank — Lending | In | Kafka + REST | Real-time | 200 ev/s | New-loan applications, decisions | (subsumed under CBS contract; expanded in Phase 3) |
| 3 | Credit Bureau (CRB) | Bureau (Metropol/TransUnion) | In | REST | On-demand + monthly bulk | 50 req/s peak | Bureau score, enquiries, defaults | Phase 3 — placeholder |
| 4 | IFRS 9 ECL Engine | Bank — Risk/Finance | In + Out | REST + S3 monthly | Monthly | n/a | Stage assignment, ECL inputs | `integrations/ifrs9/contract.md` + `integrations/ifrs9/openapi.yaml` |
| 5 | AML / Financial Crime | Bank — Financial Crime | In + Out | REST webhooks | Real-time | < 50 ev/s | Alert correlation, scenario flags | `integrations/aml/contract.md` + `integrations/aml/openapi.yaml` |
| 6 | Collection System | Bank — Collections | Out + callback | REST | Real-time | < 100 ev/s | Case routing, status callbacks | `integrations/collection/contract.md` + `integrations/collection/openapi.yaml` |
| 7 | SES | AWS | Out | SDK | Real-time | < 1k/min | Notification email | Phase 1 — `notification-svc` |
| 8 | Africa's Talking | Africa's Talking | Out | REST | Real-time | < 1k/min | Notification SMS | Phase 1 — `notification-svc` |
| 9 | Anthropic API (Claude) | Anthropic | Out | HTTPS | On-demand | < 100 req/min | NL→SQL Copilot prompts (no PII) | Phase 2 — `ai-copilot-svc` |
| 10 | SageMaker | AWS | Internal | SDK | Daily training | n/a | PD model artefacts | Phase 2 — `ai-copilot-svc` |

## Data classification

| Class | Examples | Where it may live | Where it must NOT live |
|-------|----------|-------------------|------------------------|
| **PII (sensitive, DPA §31)** | National ID, MSISDN, full name | Aurora `raw.customer` (encrypted) | Kafka payloads, CloudWatch logs, Anthropic prompts |
| **PII (general)** | customer_id (UUID), display_name | JWT, in-app responses, audit trail | n/a (acceptable everywhere with audit) |
| **Financial** | balances, repayment amounts | Aurora `mart.*`, S3 curated | Anthropic prompts (must be redacted) |
| **Derived signals** | indicator values, PD, SHAP | Aurora + S3 + Kafka | n/a |
| **Operational** | service logs, traces | CloudWatch + X-Ray | n/a |

## Volumetrics (5x pilot)

- CBS Kafka peak: 5,000 ev/s × 5 = 25,000 ev/s. MSK 3 × `kafka.m7g.large` sized for 30k ev/s headroom.
- Aurora writes: indicator values + audit events ≈ 8,000 wps. r6g.xlarge writer sized for 12k wps headroom; serverless v2 burst path documented in `30-data/`.
- S3 audit: ~50 GB/year at pilot, ~250 GB/year at 5x. 7y retention = 1.75 TB max footprint per env.
