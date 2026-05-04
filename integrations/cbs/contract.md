# Integration contract — CBS (Core Banking System)

**Owner:** agent-integration
**Counterpart system owner:** Bank — Core Banking team
**Status:** DRAFT v0.1 (Phase 0)

## Scope

Loan, repayment, account, and customer-profile change events from the bank's CBS, plus a daily batch reconciliation snapshot.

## Transport

| Channel | Mode | Frequency | Volume (peak) |
|---------|------|-----------|---------------|
| Kafka topic `apex.cbs.events`  | Push (CDC via Debezium) | Real-time | 5,000 ev/s |
| REST (this contract)            | Pull (back-fill / control) | On demand | n/a |
| S3 batch dump                   | Daily 02:00 EAT | Once/day | 5–10 GB/day |

## Events (Kafka)

Schema: `infra/schema-registry/apex.cbs.events.v1.json`. Partition key = `customer_id` to preserve per-customer ordering.

| `event_type` | Trigger | Critical fields in `payload` |
|--------------|---------|-----------------------------|
| `loan.disbursed`             | New loan booking | `loan_id`, `principal`, `currency`, `tenor_days`, `interest_rate`, `product_code` |
| `loan.repayment.received`    | Successful repayment | `amount`, `due_date`, `repayment_channel` |
| `loan.repayment.missed`      | Repayment instalment past due | `dpd`, `missed_amount`, `bucket` |
| `account.balance.changed`    | Balance crosses threshold | `currency`, `balance`, `prior_balance` |
| `account.overdraft`          | Account overdrawn | `od_amount`, `od_limit` |
| `customer.profile.updated`   | KYC change | `field`, `old_value_hash`, `new_value_hash` (PII never on the wire — see Security) |

## REST endpoints (mock)

OpenAPI: `integrations/cbs/openapi.yaml`. Backfills + control-plane only; not the primary data path.

- `GET /cbs/customers/{customer_id}` — current 360 snapshot.
- `GET /cbs/loans/{loan_id}` — single loan record.
- `GET /cbs/loans?status={status}&page=...` — paged list for back-fill.
- `POST /cbs/replay` — replay events for a date range to a Kafka offset.

## Security

- mTLS over PrivateLink between bank VPC and APEX EWS VPC. No public route.
- OAuth 2.0 client-credentials with rotating client secret in AWS Secrets Manager (CMK `alias/apex-ews-secret`).
- PII redaction: customer name, ID number, mobile MSISDN are **not** transmitted in event payload — only stable opaque `customer_id` (UUID v4 minted in CBS). PII required by UI is fetched per-request via REST with row-level audit trail.
- Field-level encryption for any free-text notes (ChaCha20-Poly1305 wrapped by `alias/apex-ews-aurora`).

## SLA

- Event-to-Kafka latency P95 ≤ 5s.
- 99.9% event delivery (with 7-day replay buffer in CBS Debezium).
- Daily batch arrives by 03:00 EAT; quality gate fails the dependent dbt run if late.

## Hand-offs

- **agent-data** consumes Kafka topic + S3 batch into the Aurora `raw` schema.
- Reconciliation breaks > 0.05% raise a Critical alert via the rule engine (`RECON_001`).
