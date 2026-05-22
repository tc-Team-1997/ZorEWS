# ZorEWS — Data Lineage

**Owner:** agent-data · **Cadence:** Updated per release · **Last reviewed:** 2026-05-20

> Provenance + transformation map for every dataset in the prototype. Each dataset is tagged with source, owner, transformations, downstream consumers, and the audit-chain implications. Pair with `docs/database-schema.md` (column-level reference) + `docs/database-gap-analysis.md` (open inventory) + `docs/compliance-mapping.md` (DPA 2019 Art. 22 data minimisation).

---

## 1. Lineage graph (textual)

```
                                ┌──────────────────────────────────┐
                                │ External Sources (Phase 0 mocks) │
                                │  - CBS (loans + repayments)      │
                                │  - Bureau (credit scores)        │
                                │  - IFRS9 (stage data)            │
                                │  - AML (watchlist matches)       │
                                │  - Insurance (policies + claims) │
                                │  - DMS + Agent + Finance + HR    │
                                └────────────────┬─────────────────┘
                                                 │ (MWAA DAGs +
                                                 │  adapter probes)
                                                 ▼
                                ┌──────────────────────────────────┐
                                │  raw.* (Aurora)                  │
                                │  - seed_customer (10k rows)      │
                                │  - seed_loans (24k)              │
                                │  - seed_repayments (247k)        │
                                │  - seed_txns (290k)              │
                                │  - seed_bureau_score (10k)       │
                                └────────────────┬─────────────────┘
                                                 │ (dbt staging models)
                                                 ▼
                                ┌──────────────────────────────────┐
                                │  staging.* (Aurora — views)      │
                                │  - stg_customer / stg_loans /    │
                                │    stg_repayments / stg_txns /   │
                                │    stg_bureau_score              │
                                │  All carry tenant_id='BANK_DEMO' │
                                │  literal (Phase 13 of T4.24)     │
                                └────────────────┬─────────────────┘
                                                 │ (dbt mart models)
                                                 ▼
                                ┌──────────────────────────────────┐
                                │  mart.* (Aurora — tables)        │
                                │  - customer_360 (10k)            │
                                │  - loan_360 (24k)                │
                                │  - txn_features (10k aggregates) │
                                │  - indicator_values (80k)        │
                                │  Tenant-tagged (T4.24 Phase 13)  │
                                └─┬──────────┬──────────┬──────────┘
                                  │          │          │
                                  ▼          ▼          ▼
                  ┌───────────┐  ┌────────────┐  ┌───────────────┐
                  │ Indicator │  │  Rule      │  │ AI scoring    │
                  │ compute   │  │  evaluator │  │ (PD model)    │
                  │ (M4.x)    │  │  (M5.x)    │  │ (M7.x)        │
                  └─────┬─────┘  └─────┬──────┘  └───────┬───────┘
                        │              │                  │
                        └───────┬──────┴──────────────────┘
                                ▼
                  ┌──────────────────────────────────┐
                  │  Alerts + Cases (app_*)          │
                  │  - app_alerts.alerts (2.5k)      │
                  │  - app_alerts.queue_assignments  │
                  │  - app_cases.cases (528)         │
                  │  - app_cases.actions / cas /     │
                  │    caps                          │
                  └────────────┬─────────────────────┘
                               │
                  ┌────────────┴──────────────┐
                  ▼                            ▼
        ┌──────────────────┐         ┌──────────────────────┐
        │ audit.event_log  │         │ apex.regulatory.     │
        │ (hash-chain      │         │ events (Kafka topic) │
        │  WORM)           │         │ → bff/webhooks       │
        └──────────────────┘         └──────────────────────┘
```

---

## 2. Per-dataset lineage

### 2.1 Raw layer (`raw.*`)

| Table | Source | Loader | Owner | Tenant-aware? | PII | Retention |
|---|---|---|---|---|---|---|
| `raw.seed_customer` | dbt seed CSV `data/dbt/seeds/customers.csv` (prototype) → CBS in production | `dbt seed --full-refresh` (prototype); MWAA `cbs_ingestion` DAG in production | agent-data | No (column added in mart by T4.24 P13 — staging stamps literal `'BANK_DEMO'`) | Yes (name, DOB, phone, address) | Indefinite (regulatory) |
| `raw.seed_loans` | dbt seed CSV `data/dbt/seeds/loans.csv` → CBS loan-book | dbt seed; MWAA DAG | agent-data | No (column added in mart) | No directly (only loan_id + customer_id FK) | Indefinite |
| `raw.seed_repayments` | dbt seed CSV → CBS repayment history | dbt seed; MWAA DAG | agent-data | No | No | Indefinite |
| `raw.seed_txns` | dbt seed CSV → CBS transaction stream | dbt seed; MWAA DAG | agent-data | Yes (amount + counterparty) | Indefinite |
| `raw.seed_bureau_score` | dbt seed CSV → Bureau pull | dbt seed; MWAA `bureau_sync` DAG | agent-data | No (column added in mart) | No directly | 90 days (bureau report TTL per M14.5) |

**Note:** `raw.cbs_*` tables defined in `002_raw_tables.sql` were dropped 2026-05-03 — the empty schemas misled readers into thinking a CBS loader was wired. See `docs/database-gap-analysis.md` Gap 1 (closed). Real CBS loader is T1.4b (Year-2 Theme C).

### 2.2 Staging layer (`staging.*`)

| View | Source | Transformations | Tenant-aware? |
|---|---|---|---|
| `stg_customer` | `raw.seed_customer` | Lowercases enum-like columns (gender, kyc_status); stamps `'BANK_DEMO'::text AS tenant_id` literal | Yes (literal) |
| `stg_loans` | `raw.seed_loans` | Joins customer_id; lowercases product_code; stamps tenant_id literal | Yes |
| `stg_repayments` | `raw.seed_repayments` | Computes DPD per repayment; stamps tenant_id | Yes |
| `stg_txns` | `raw.seed_txns` | Normalises currency to KES; stamps tenant_id | Yes |
| `stg_bureau_score` | `raw.seed_bureau_score` | Bands score (subprime/near_prime/prime/super_prime); stamps tenant_id | Yes |

Staging models are dbt views (no materialisation). Documentation in `data/dbt/models/staging/schema.yml` covers per-column tests + descriptions.

### 2.3 Mart layer (`mart.*`)

| Table | Source | Materialisation | Refresh | Tenant-aware? | Downstream |
|---|---|---|---|---|---|
| `customer_360` | `stg_customer` + `stg_bureau_score` + aggregated `stg_txns` | dbt table | Daily 06:00 IST (per SLO tier-3) | Yes (column from staging) | M4 indicators / M6 scoring / M11 dashboards / BFF risk profile |
| `loan_360` | `stg_loans` + `stg_repayments` aggregates (max DPD, count NPA flags) | dbt table | Daily | Yes | M4 / M6 / M11 |
| `txn_features` | `stg_txns` per customer (sum/mean/zscore over 30/60/90d) | dbt table | Daily | Yes | M4 (TXN family) / M6 / M11 |
| `indicator_values` | `customer_360` + `loan_360` + `txn_features` via 8 indicator CTEs | dbt table | Daily | Yes (from customer_360) | Rule evaluator (M5) / Alert producer (M8) |

dbt tests (79 currently) assert per-column NOT NULL, accepted ranges, FK relationships. Run via `dbt test` on every `dbt run`.

### 2.4 Application layer (`app_*`) — operational state

| Schema | Table | Owner | Source | Tenant-aware? | PII |
|---|---|---|---|---|---|
| `app_iam` | `users` (505 seed rows) | auth-svc | seed + register API | Yes (FK to tenants) | Yes (username, role) |
| `app_iam` | `sessions` | auth-svc | login flow | Yes (via user) | No |
| `app_iam` | `password_history` | auth-svc | password change flow | Yes | No (argon2 hash only) |
| `app_iam` | `audit_events` | auth-svc | every auth mutation | Yes | Yes (actor + IP) |
| `app_iam` | `tenants` | bff (T4.24 P10) | tenant CRUD API | n/a (definitional) | No |
| `app_iam` | `service_clients` | auth-svc (T4.24 P11) | service-client CRUD | Yes | No |
| `app_iam` | `user_teams` (T4.21) | auth-svc | team CRUD | Yes | No |
| `app_iam` | `leave_covers` (T4.22) | auth-svc | leave-cover CRUD | Yes (via user_id) | No |
| `app_iam` | `role_dashboard_widgets` (T4.23) | auth-svc | admin dashboard config | n/a (role-keyed) | No |
| `app_iam` | `user_2fa_secrets` (M1.1) | auth-svc | TOTP setup flow | Yes | Yes (TOTP secret) |
| `app_cases` | `cases` (528 seed) | cases-svc | alert → case lifecycle | Yes (T4.24 P5) | Yes (customer_id + actor) |
| `app_cases` | `actions` (1.5k seed) | cases-svc | case action log | Yes (via case) | Yes (officer_id + GPS) |
| `app_cases` | `cas_records` (T4.19) | cases-svc | causal analysis | Yes | No |
| `app_cases` | `caps` (T4.19) | cases-svc | corrective action plans | Yes | No |
| `app_alerts` | `alerts` (2.5k seed) | alerts-svc | rule firings (T4.24 P6) | Yes | Yes (customer_id) |
| `app_alerts` | `queue_assignments` | alerts-svc | SmartQueue lifecycle | Yes (via alert) | Yes (assignee) |
| `app_bff` | `webhook_subscriptions` (25 seed) | bff (T4.13) | admin CRUD | Yes (T4.24 P4) | No (secret hashed) |
| `app_bff` | `webhook_deliveries` (915 seed) | bff | dispatcher | Yes | No |
| `app_scenario` | `saved_scenarios` (120 seed) | bff (T4.18) | scenario save flow | Yes (T4.24 P4) | No |
| `app_audit` | `approvals` (T4.20) | cases-svc | CAS/CAP maker-checker | Yes | Yes (maker + checker) |

**Total active rows ~731,500** across 26 tables (per `STATUS.md` database state).

### 2.5 Audit chain (`audit.event_log`)

| Field | Source | Audit role |
|---|---|---|
| `event_id` | generated UUIDv4 | Primary key |
| `tenant_id` | from request | Tenant scoping (T4.24 Phase 3) |
| `actor_username` | JWT sub claim | Who performed the action |
| `actor_role` | JWT role claim | RBAC context |
| `action` | application code | What was done (e.g. `config.update`, `case.close`) |
| `resource_type` | application code | Closed enum: user/session/config/case/alert/report/scenario/rule/integration/system |
| `resource_id` | application code | Target ID |
| `outcome` | application code | success/failure/denied |
| `severity` | application code | info/warning/critical |
| `metadata` | application code | JSON detail (`previous_value`, `new_value`, `cloned_from`, etc.) |
| `prev_hash` | computed by trigger | Links to previous event |
| `event_hash` | SHA-256 over canonical | Tamper evidence (M15.2) |

**Hash chain integrity:** every audit event signs its prev_hash + canonical-encoded fields. `verifyChain()` (M15.2) walks oldest-first and detects any tampering. Per-tenant chain (Phase 3 segmentation).

### 2.6 Streaming layer (Kafka topics)

| Topic | Producer | Consumers | Schema |
|---|---|---|---|
| `apex.cbs.events` | agent-integration (CBS adapter) | agent-data | `infra/schema-registry/apex.cbs.events.v1.json` |
| `apex.indicator.values` | agent-indicator | agent-rule, agent-ai | `apex.indicator.values.v1.json` |
| `apex.regulatory.events` | agent-alert | agent-case, agent-ui (via BFF SSE), agent-integration (webhooks) | `apex.regulatory.events.v2.json` |
| `apex.case.events` | agent-case | agent-integration (Collection adapter), bff (webhooks) | `apex.case.events.v1.json` |
| `apex.audit.events` | every service | agent-integration (audit-svc → `audit.event_log` Aurora table + S3) | `apex.audit.events.v1.json` |

**Compatibility:** Glue Schema Registry enforces BACKWARD via `.github/workflows/schema-compat.yml`.

**MM2 replication:** Year-2 Theme G ships MirrorMaker 2 (T5.2 IaC) replicating all 5 topics to the secondary region with <2min lag (per `docs/slos.md` tier-2 SLO).

---

## 3. PII handling

Per `docs/compliance-mapping.md` and DPA 2019 Art. 22 (data minimisation):

| PII class | Tables | Encryption-at-rest | Encryption-in-transit | Access |
|---|---|---|---|---|
| Name + DOB | `raw.seed_customer` + `mart.customer_360` | Aurora KMS (alias `apex-ews-aurora`) | TLS | RBAC scope `customers:read_risk_profile` (5 roles) |
| Phone | same + `app_iam.users` (username) + `app_alerts.alerts` (assignee phone) | Aurora KMS | TLS | RBAC |
| Address | same | Aurora KMS | TLS | RBAC |
| Email | `app_iam.users` (registered email) + `app_bff.webhook_subscriptions` (notify_recipients) | Aurora KMS | TLS | RBAC |
| Geo (GPS) | `app_cases.actions.lat/lng/accuracy_m` | Aurora KMS | TLS | RBAC scope `cases:log_action` |
| TOTP secrets | `app_iam.user_2fa_secrets.secret_base32` | Aurora KMS + application-layer envelope under separate KMS key | TLS | Admin-only |
| Auth tokens | `app_iam.sessions` (sid) + JWT refresh tokens | Hashed via argon2 | TLS | None directly readable |

**S3 layer:**
- `apex-ews-prod-audit-*` — KMS aws:kms + Object Lock COMPLIANCE (7-year retention)
- `apex-ews-prod-raw-*` — KMS aws:kms
- `apex-ews-prod-curated-*` — KMS aws:kms
- CRR replicates to secondary region with destination-region KMS re-encryption (T5.2).

---

## 4. Retention + deletion

| Layer | Retention | Deletion path |
|---|---|---|
| `raw.*` | Indefinite (regulatory requirements) | Tenant deletion → CASCADE FK to mart |
| `staging.*` | n/a (views) | Auto-drop when underlying raw drops |
| `mart.*` | Daily refresh; full snapshot at month-end retained 60 months | Tenant deletion → CASCADE |
| `app_*` | Per-table policy; sessions purged 90d after expiry, audit_events indefinite | Tenant soft-delete → row-level mark `deleted_at`, hard-delete after 90 days |
| `audit.event_log` | Indefinite (regulatory) | NO deletion (WORM Object Lock + chain integrity) |
| S3 raw | 365 days (per platform config M13.1 `reporting.retention_days`) | Lifecycle to STANDARD_IA after 90 days (T5.2), expire after retention |
| S3 audit | 7 years (Object Lock COMPLIANCE) | NO deletion before retention |
| Kafka topics | 7 days (per MSK configuration `log.retention.hours=168`) | Auto-purge |

**Right-to-be-forgotten:** Customer-data deletion on regulator-mandated request:

1. Identify all rows referencing customer_id via FK trace from `mart.customer_360`.
2. Soft-delete in app_* layer.
3. Anonymise in raw + mart (replace name/DOB/phone/address with hash) rather than hard-delete (audit chain integrity).
4. Audit event written: `action: 'customer.anonymised'`, `metadata: {customer_id, reason, regulator_ref}`.
5. NOT yet automated — manual SQL runbook in `docs/data-deletion-runbook.md` (to be authored on first request).

---

## 5. Per-release update procedure

Every release that touches the data model:

1. dbt model changes → update `data/dbt/models/*/schema.yml` (PR-blocking via CI).
2. App schema migration → file in `data/schema/0XX_*.sql` with row-impact estimate in commit.
3. Update §2 of this document with new dataset / new transformation / new downstream.
4. If new PII column → update §3 with encryption posture + RBAC scope.
5. If retention changed → update §4.
6. Compliance officer reviews §3 + §4 changes per `docs/raci.md` §6.

---

## 6. References

- `docs/database-schema.md` — column-level reference for all 9 schemas.
- `docs/database-gap-analysis.md` — open inventory + service-wiring backlog.
- `docs/compliance-mapping.md` — DPA 2019 + ISO 27001 controls.
- `docs/charter.md` — programme scope.
- `docs/risk-register.md` R-013 — synthetic dataset misrepresents real risk.
- `docs/year-2-backlog.md` Theme C — real bank integrations (CBS T3.1 + IFRS9 T3.2).
- `data/dbt/models/` — dbt source.
- `data/schema/` — Aurora DDL migrations.
- `infra/schema-registry/` — Kafka topic JSON schemas.

## Airflow DAG inventory — UPDATED: 2026-05-21

| DAG | Path | Cadence | Closes | External dependency |
|---|---|---|---|---|
| `cbs_ingestion` | `data/airflow/dags/cbs_ingestion.py` | daily | T1.4 | bank CBS endpoint (Year-2 Theme C) |
| `bureau_sync` | `data/airflow/dags/bureau_sync.py` | weekly | T1.4 | bank bureau endpoint |
| `feature_build` | `data/airflow/dags/feature_build.py` | daily | T1.4 | none — runs on mart |
| `pd_retrain_monthly` | `data/airflow/dags/pd_retrain_monthly.py` | monthly | T2.5 | MWAA runtime |
| `feature_store_backfill` | `data/airflow/dags/feature_store_backfill.py` | daily 06:30 IST | T2.1 (Year-2 Theme E) | MWAA cluster running |
| `retraining_scheduler` | `data/airflow/dags/retraining_scheduler.py` | every 6h at :15 | T5.1 (Year-2 Theme E) | MWAA + `RETRAINING_TOKEN_SECRET` in Secrets Manager |

The last two DAGs were closed code-side 2026-05-21 — runtime dependency is MWAA cluster provisioning (`terraform apply` 30-data).
