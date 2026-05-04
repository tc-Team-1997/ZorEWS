# 30-data

Stateful platform data services in the data subnets.

## Aurora PostgreSQL 16
- Cluster `apex-ews-<env>-aurora`, engine `16.2`.
- Writer (`db.r6g.xlarge`) + 2 readers across 3 AZs.
- Serverless v2 capacity 2-32 ACUs (auto-scales burst load).
- KMS encryption with `alias/apex-ews-aurora`.
- Master password handled by RDS-managed Secrets Manager secret (`master_user_secret_arn`).
- 35-day backup retention, IAM DB auth enabled, Performance Insights on.

## ElastiCache Redis 7.2
- Single shard, 2 replicas, automatic failover, multi-AZ.
- TLS in-transit + at-rest, AUTH token rotation enabled.
- Used for alert smart-queue priority sets + JWT refresh-token blocklist.

## S3
- `audit` — Object Lock COMPLIANCE 7y → satisfies NFR-AUDIT.
- `raw` — landing zone for CBS / bureau dumps.
- `curated` — dbt-built marts + ML training snapshots.
- All three: SSE-KMS via `alias/apex-ews-s3`, versioning + public access fully blocked.

## MSK
- 3 brokers `kafka.m7g.large`, Kafka `3.6.0`.
- TLS client + SASL/IAM auth.
- Topic auto-create disabled. RF=3, min.ISR=2, retention 168h.

## Hand-offs
- `aurora_writer_endpoint`, `aurora_reader_endpoint` — agent-data.
- `audit_bucket_arn` — audit-svc IRSA policy.
- `msk_bootstrap_brokers_sasl_iam` — every producing/consuming service.
