# logs/integration.md — integration agent

> Append entries chronologically. Each entry: task id, files touched, decisions, hand-offs, blockers.

## 2026-04-26 — Initialised

- Log file created. Awaiting first task.

## 2026-04-26 — Phase 0 + Phase 1 platform foundations

**Tasks ticked:** T0.2, T0.3, T0.4, T0.5, T1.1, T1.12, T1.13.

### Files created

#### Terraform — `infra/terraform/`
- `README.md` — layer index + local-validate workflow.
- `00-landing-zone/{versions,providers,variables,main,outputs}.tf` + `README.md`
  - AWS Organizations + 3 OUs (Security, Workloads, Sandbox).
  - SCPs: deny non-allowed regions (only af-south-1 + eu-west-1 DR), require S3/EBS encryption.
  - 5 KMS CMKs: aurora, s3 (multi-region), msk, secret, ebs.
  - Org-wide CloudTrail (multi-region, log-file validation, KMS-encrypted into versioned S3).
- `10-network/{versions,providers,variables,main,outputs}.tf` + `README.md`
  - VPC `10.0.0.0/16` with 3 AZ × 3 tiers (public/private/data).
  - 1 NAT/AZ; data subnets isolated (no default route).
  - VPC Flow Logs → CloudWatch (365-day retention).
  - S3 gateway endpoint on private + data route tables.
- `20-eks/{versions,providers,variables,main,outputs}.tf` + `README.md`
  - EKS 1.30, private endpoint only, secrets envelope-encrypted by `alias/apex-ews-secret`.
  - Node groups: `general` (m6i.xlarge, 3-12) + `ai` (g5.xlarge, 0-4, tainted).
  - OIDC provider + IRSA role per service (7 roles, exposed via `irsa_role_arns` output).
- `30-data/{versions,providers,variables,main,outputs}.tf` + `README.md`
  - Aurora PG 16.2 cluster `apex-ews-<env>-aurora` — 1 writer + 2 readers, RDS-managed master secret, IAM DB auth, 35-day backups.
  - Redis 7.2 replication group, multi-AZ, TLS in-transit + at-rest.
  - S3 audit (Object Lock COMPLIANCE 7y), raw, curated — all SSE-KMS, versioned, public access blocked.
  - MSK 3-broker `kafka.m7g.large`, Kafka 3.6, TLS + SASL/IAM, RF=3 minISR=2 retention=168h.
- `40-edge/{versions,providers,variables,main,outputs}.tf` + `README.md`
  - Route53 hosted zone, ACM cert (regional + us-east-1 for CloudFront).
  - WAFv2 ACLs: regional ALB (Common + 2k req/5min IP rate limit) + CloudFront.
  - Public ALB (drop_invalid_header_fields, deletion protection).
  - CloudFront SPA distribution via OAC, TLS 1.2_2021 minimum.
  - Optional Shield Advanced toggle (default off).

#### K8s — `infra/k8s/`
- `namespaces.yaml` — platform/data/regulatory/ai/analytics, all PSS=restricted.
- `network-policies.yaml` — default-deny per ns + targeted allow (ALB→auth, audit emit, egress 443+DNS).
- `rbac.yaml` — admin / readonly / risk-analyst / supervisor ClusterRoles + bindings to SSO groups.
- `serviceaccounts.yaml` — IRSA SAs for all 7 services with `${IRSA_ROLE_ARN_*}` placeholders for CI substitution.
- `deployments.yaml` — Deployment + Service skeletons for auth-svc, audit-svc, notification-svc, pipeline-svc, regulatory-svc, ai-copilot-svc, analytics-svc. Pod-Security restricted, readOnlyRootFilesystem, drop-ALL caps, IRSA SA refs.
- `README.md` — apply order + conventions.

#### Schema registry — `infra/schema-registry/`
- `apex.cbs.events.v1.json` — loan/repayment/account/profile events, customer_id partition key.
- `apex.indicator.values.v1.json` — indicator id, family, severity_weight 0-1.
- `apex.regulatory.events.v1.json` — alert with rule_firings + scoring (PD + risk_band + SHAP top-N).
- `apex.case.events.v1.json` — lifecycle states + assignee + action + GPS.
- `apex.audit.events.v1.json` — actor/action/resource/outcome + prev_hash/hash (SHA-256 hex pattern).
- `README.md` — BACKWARD compatibility rule, version field, CI gate placeholder.

#### Integration contracts — `integrations/`
- `cbs/{contract.md,openapi.yaml}` — Kafka CDC + REST back-fill + S3 daily; mTLS via PrivateLink + OAuth2 client-credentials; PII redacted on the wire.
- `ifrs9/{contract.md,openapi.yaml}` — bidirectional REST; monthly cycle; detached JWS signature.
- `aml/{contract.md,openapi.yaml}` — bidirectional webhooks; HMAC `X-APEX-Signature`; SQS DLQ.
- `collection/{contract.md,openapi.yaml}` — outbound case routing + status callback; idempotent on case_id.

#### Services
- `services/auth-svc/` (Node + TypeScript + Fastify):
  - `src/server.ts`, `src/users.ts`, `src/jwt.ts`, `src/routes/auth.ts`.
  - `src/__tests__/auth.test.ts` — login happy path + bad TOTP.
  - 5 seed users (admin / risk_analyst / supervisor / collection_officer / field_officer).
  - argon2id passwords, RFC 6238 TOTP, RS256 JWT (15-min access, 7-day refresh).
  - `package.json`, `tsconfig.json`, `Dockerfile` (multi-stage, non-root uid 10001), `.dockerignore`, `README.md`.
- `services/audit-svc/` (Python + FastAPI):
  - `src/audit_svc/{__init__,chain,server}.py`.
  - `tests/test_chain.py` — clean append + tamper detection.
  - SHA-256 hash-chain on canonical JSON; NDJSON store (S3 Object Lock target).
  - `pyproject.toml`, `Dockerfile`, `.dockerignore`, `README.md`.

#### Docs — `docs/`
- `architecture.md` — Mermaid logical view, network view, security view, alert end-to-end flow, DR preview.
- `compliance-mapping.md` — DPA 2019 sections + ISO 27001:2022 Annex A controls → implementation in this repo.
- `source-system-inventory.md` — 10 upstream/downstream systems, data classes, volumetrics at 5× pilot.

### Key decisions

1. **auth-svc = Node + TypeScript (Fastify)**, audit-svc = Python (FastAPI). Polyglot is intentional — proves IRSA + container model is language-neutral. Auth picked Node because the SPA is React/TS (shared types) and `jose` integrates cleanly with KMS asymmetric signing. Audit picked Python because hashlib + canonical JSON are one-line, and the Kafka consumer loop here is lighter than confluent-kafka-go.
2. **Region pin via SCP** for the Workloads OU (only `af-south-1` + `eu-west-1`-DR). Global services (IAM, Route53, CloudFront, WAF, Shield, support, sts, budgets) excepted via `not_actions` so the org bootstrap does not deadlock.
3. **5 separate CMKs** (aurora/s3/msk/secret/ebs) — supports per-domain key rotation, simpler key-policy review, no blast-radius across domains.
4. **Aurora PG 16.2 provisioned (r6g.xlarge writer + 2 readers)** rather than Serverless v2. Provisioned gives predictable P95 for the rule simulator + dbt runs; Serverless v2 burst path documented as a Phase 4 perf-tuning option (T4.4).
5. **MSK m7g.large × 3** sized for 30k ev/s headroom (peak modelled = 25k at 5× pilot). RF=3 min.ISR=2 unclean.leader.election=false → consistency over availability for audit traffic.
6. **EKS endpoint = private only.** Operators reach it via SSM Session Manager / Workspaces — no kubectl over the public internet. NFR-SEC-1 alignment.
7. **g5.xlarge AI node group with `workload=ai:NoSchedule` taint, scale-to-zero.** Cheapest single-A10G GPU in af-south-1, only spins up when ai-copilot-svc has demand.
8. **S3 Object Lock COMPLIANCE 7y** — matches CBK retention guidance. The `audit-svc` writes the same NDJSON to local disk in dev; in prod the consumer streams to S3 with the lock. Code comment in `chain.py` flags this.
9. **JWT signing key never on disk in prod** — `loadSigner()` is intentionally swappable to a `KMSSigner` that delegates to `kms:Sign` via IRSA. Local dev generates an ephemeral RS256 keypair on boot. `kid="alias/apex-ews-secret"` is set today so verifiers don't need code changes when KMS goes live.
10. **Schemas declare `version` + `compatibility="BACKWARD"`** at the root — cheap CI hook can grep for these and reject breaking changes (FR-INT-3).

### Hand-offs

- **agent-data — Aurora endpoints exposed in `infra/terraform/30-data/outputs.tf`; use `aurora_writer_endpoint` for writers, `aurora_reader_endpoint` for dbt + analytics reads, `aurora_master_user_secret_arn` for the bootstrap migration job.**
- **agent-data** — S3 raw/curated bucket names from `30-data` outputs `raw_bucket`, `curated_bucket`. Kafka bootstrap from `msk_bootstrap_brokers_sasl_iam`.
- **agent-data** — `apex.cbs.events` schema (`infra/schema-registry/apex.cbs.events.v1.json`) is the contract for the staging dbt model.
- **agent-indicator** — `apex.indicator.values.v1.json` is the producer-side schema; severity_weight is bounded [0,1].
- **agent-rule** — `apex.regulatory.events.v1.json` defines the alert envelope; rule_firings is an array, allowing severity merge per FR-ALERT-2.
- **agent-alert** — Redis primary endpoint via `redis_primary_endpoint`; smart-queue priority sets per FR-ALERT-3.
- **agent-case** — `apex.case.events.v1.json` carries the lifecycle states + GPS; Collection contract under `integrations/collection/`.
- **agent-ai** — IRSA role for `ai-copilot-svc` exposed in `20-eks/outputs.tf` `irsa_role_arns["ai-copilot-svc"]`. AI node-group taint = `workload=ai:NoSchedule`; tolerate it in any AI Deployment.
- **agent-ui** — auth endpoints stable (`/auth/login`, `/auth/refresh`, `/auth/me`) and respond with `role` + `display_name` for the dashboard greeting.
- **orchestrator** — every microservice has been added to `services/<svc>/` with at least a Dockerfile + README; ECR repo provisioning (T0.6 vendor stubs / X.3 CI scan) is the next on-deck item for me.

### Open issues / blockers

- **Bash execution disabled** in this run, so `terraform fmt/validate`, `npm test`, and `pytest` were not executed by me. The user must run them once before merge:
  - `terraform fmt -recursive infra/terraform`
  - per layer: `cd infra/terraform/<layer> && terraform init -backend=false && terraform validate`
  - `cd services/auth-svc && npm install && npm test`
  - `cd services/audit-svc && pip install -e '.[dev]' && pytest -q`
- The chain test deliberately rewrites a record's `action` while keeping its `hash` to assert tamper detection — `verify()` will return `BROKEN` with `first_break_index=1`. This is the intended assertion.
- T0.6 vendor account stubs (Anthropic, Africa's Talking, SES) — not in this run's scope, deferred to next slice.
- Glue Schema Registry resource (T3.8) — schemas live as JSON only; the AWS Glue resource is a Phase 3 task, not provisioned here.
- ECR repos for the seven services are referenced as `${ECR_REGISTRY}/apex-ews/<svc>` placeholders — actual `aws_ecr_repository` resources to be added under `20-eks` or a new `25-registry` layer in the next slice.

### Next-on-deck for agent-integration

T0.6 vendor stubs, T3.x integration deepening + RBAC matrix doc + Glue Schema Registry resource + ECR repo Terraform + X.3 CI workflow (terraform validate + container scan).

## 2026-04-27 — T3.10 BFF shipped

- **New service:** `services/bff/` — TS + Express + Jest sibling to the regulatory-svc modules; default port 8084.
- **Files:** `package.json`, `tsconfig.json`, `README.md`, `src/{types,mapping,lookups,source,server}.ts`, `__tests__/{mapping,server}.test.ts`.
- **Mapping (`src/mapping.ts`) — the heart of T3.10:**
  - `mapAlertEvent(canonical, lookups, now?) → AlertRow` — pure, IO-free.
    - severity: `WireSeverity` UPPERCASE → `UiSeverity` lowercase via static map; unknown wire severity throws (the v2 schema constrains the set, so a producer bug surfaces loud not silent).
    - customer.name / rule.name: looked up; fall back to id when absent.
    - age_min: `floor((now - raised_at) / 60000)`, clamped to 0 for clock-skew safety.
    - assignee: pulled from `lookups.assignees` (alert_id → user_id), `null` when absent.
    - rename: `alert_id → id`, `raised_at → created_at`, `indicators_fired → indicators`.
  - `mapAlertList(canonicals, lookups, filters?, now?) → AlertRow[]` — sorts newest-first by `created_at` with stable tie-break on `id`; filters by severity + assignee.
  - `dedupeByAlertId(canonicals)` — last-write-wins so at-least-once delivery doesn't double-count rows.
- **Source plumbing (`src/source.ts`):**
  - `OutboxSource(outboxDir, topic='apex.regulatory.events')` reads every `${topic}-*.ndjson` line, skips corrupt lines.
  - `StaticSource` for tests.
  - `makeAlertSource(env)` defaults to `services/regulatory-svc/alerts/.outbox` (the producer side); when MSK is wired, swap to a kafkajs consumer behind the same `AlertSource` interface.
- **Lookups (`src/lookups.ts`):** in-memory `SEED_CUSTOMERS` + `SEED_RULES` mirror `web/src/mocks/data.ts` so local dev produces the same customer + rule names the SPA's MSW path shows. Production wires these to agent-data customer master + agent-rule registry — `Lookups` interface is already the contract for that swap.
- **Server (`src/server.ts`):** `GET /api/alerts?severity=&assignee=`, returns `{items, total}` matching `web/src/lib/api.ts:AlertListResponse` exactly so the SPA can drop MSW with `VITE_API_BASE_URL=http://localhost:8084`. `severity` validated server-side (400 on unknown).
- **Tests:** 20/20 jest tests pass (12 mapping unit tests, 8 server e2e tests via supertest including OutboxSource NDJSON parsing + corrupt-line skip + 404-on-missing-dir paths). `tsc -p .` clean.
- **What this does and doesn't cover:**
  - Covers: `apex.regulatory.events.v2` → `/api/alerts` list-row (the literal T3.10 deliverable).
  - Doesn't cover: `/api/cases/*` proxy to `services/regulatory-svc/cases` (T3.7 territory), `/api/customers/:id/risk` proxy to ai-copilot-svc /score (also T3.7), live assignee feed from the SmartQueue, real Kafka consumer (still on the agent-integration backlog under MSK wiring), Glue Schema Registry registration of the canonical schemas (T3.8).
- **Hand-offs:**
  - `agent-ui` — when ready, set `VITE_API_BASE_URL=http://localhost:8084`, run `cd services/bff && npm run dev`. The shape matches the existing UI consumer.
  - `agent-rule` / `agent-alert` — assignee assignment events from the SmartQueue would let the BFF populate `Lookups.assignees` live; today it's a snapshot map.
  - `agent-integration` (next slice) — proxy `/api/cases/*` and `/api/customers/:id/risk` through the BFF; wire MSK kafkajs consumer behind `AlertSource`; register `apex.regulatory.events.v2` + `apex.case.events.v1` in Glue (T3.8 closes B4).

## 2026-04-27 — T3.7 public REST API v1 shipped

- **Decision:** put the `/v1` surface in the same `services/bff/` module as `/api` (T3.10) instead of a separate `services/api-gateway/`. Both surfaces share the alert source, lookups, and mapping pipeline; carving them apart would have duplicated infra without prototype value. The path prefix delineates intent: `/api/*` for SPA, `/v1/*` for partners.
- **Files added:** `services/bff/src/{score,risk_profile,case_action}.ts`, `services/bff/__tests__/v1.test.ts`. Files extended: `src/server.ts` (4 new routes), `README.md` (endpoint table).
- **Endpoints:**
  - `GET /v1/alerts` — alias of `/api/alerts` (identical shape, identical filters).
  - `POST /v1/ews/evaluate` — body `{customer_id?, features?}` → `ScoreResponse {customer_id, pd, level, top_reasons[], model_name, model_version}`. Stubbed via `StubEvaluator`: PD = clamped weighted sum of (utilization, dpd_max_90d, bureau_score-inverse, repayment_delay_streak, txn_volume_zscore_90d positive); level bands match ai-copilot-svc (Low <0.30, Medium <0.60, High otherwise); top_reasons sorted by `|shap|`. Returns 400 when neither customer_id nor features supplied.
  - `GET /v1/risk-profile/:customer_id` — full profile (id, name, pd, level, exposure, dpd, balance_trend, top_reasons, model). Stubbed via `StubRiskProfileSource` whose canned data matches `web/src/mocks/data.ts` for c-101 + c-102. 404 for unknown ids.
  - `POST /v1/action` — body `{case_id, kind, officer_id, outcome_note?, gps?}` → forwards to `services/regulatory-svc/cases POST /cases/:id/actions`. Validates kind ∈ {call,visit,sms,email,note}, officer_id required, GPS lat/lng numeric. 503 when `APEX_CASES_URL` is unset (`UnavailableCaseActionSink`); when set, errors from the upstream cases service are forwarded with their status code (so a 409 illegal-transition appears as a 409 to the caller, with `current_state` + `attempted` in `body`).
- **Plugin shape:** every external dep is an interface (`Evaluator`, `RiskProfileSource`, `CaseActionSink`, `AlertSource`) so production wiring is a one-line factory swap and tests inject stubs/fakes.
- **`fetch`:** uses Node 18's global fetch (no extra dep); `HttpCaseActionSink` accepts an injectable fetch for tests.
- **Numbers:** 32/32 jest tests pass (12 new on `/v1`); `tsc -p .` clean. No regressions on the `/api/alerts` (T3.10) tests.
- **Hand-offs:**
  - `agent-ai` — replace `StubEvaluator` with an `HttpEvaluator` calling `services/ai-copilot-svc /score` once that service is the source of truth in dev.
  - `agent-data` — `StubRiskProfileSource` is the contract for the production join (customer master + `/score`); the prototype hard-codes c-101/c-102 only.
  - `agent-integration` (next) — MSK kafkajs consumer behind `AlertSource`; Glue Schema Registry registration for `apex.regulatory.events.v2` + `apex.case.events.v1` (T3.8 closes B4); T3.4 (Collection auto-routing consumer of `apex.case.events`).

## 2026-04-27 — T3.8 schema-registry CI shipped (closes B4)

- **What landed:**
  - `infra/schema-registry/scripts/check_compat.py` — pure-Python BACKWARD-compatibility checker. Loads every `*.json` under the registry, validates each as draft 2020-12 (via `Draft202012Validator.check_schema`), groups by `title`, sorts by semver, and for each consecutive (vN, vN+1) pair flags six classes of break: `required-added`, `property-removed`, `type-narrowed`, `enum-removed`, `additional-properties-closed`, plus recursion into array `items` and nested objects.
  - `infra/schema-registry/tests/test_check_compat.py` — 16 pytest tests. Real-registry sanity check + every positive case (optional add, type widening, enum widening, required → optional demotion) + every negative case (required add, property removed, type narrowed, enum removed, additional-properties closed, break inside array items, break inside nested object) + malformed-input rejection.
  - `.github/workflows/schema-compat.yml` — runs the checker + tests on every push/PR touching `infra/schema-registry/**` or the workflow itself.
  - `infra/terraform/30-data/main.tf` — added `aws_glue_registry.apex_ews` + an auto-discovered `aws_glue_schema.topics` `for_each` over the registry directory. Each registered schema gets `compatibility = "BACKWARD"` to mirror the CI promise. Output map `glue_schema_arns` lets eks IAM bindings reference the per-topic ARNs.
- **Numbers:** 16/16 pytest tests pass. Real-registry walk: `BACKWARD-compat OK — 7 schema(s) across 6 topic(s); 1 version-pair(s) checked.` `terraform fmt` clean, `terraform validate` clean.
- **Design notes:**
  - The checker is conservative — only flags rules that have ever bitten real-world Avro/JSON-Schema BACKWARD compatibility setups. Doesn't try to be a full subschema-implication prover.
  - "Demoting required → optional" is treated as compatible: existing payloads still carry the field, so they still validate. (vs. removing the property entirely, which is flagged.)
  - `additionalProperties: <subschema>` is treated as "permissive" (open), so flipping from a permissive subschema to `false` is flagged — same observable effect as the open → closed case.
- **Hand-off:**
  - Future schema versions land via PR; CI gates the merge. The author updates `version` (semver), bumps the file, and the checker reports any breaks with the JSON pointer to the offending field.
  - When agent-integration deploys `30-data`, the Glue resource and per-topic schemas are created; downstream services get them via the `aws_glue_schema_arns` output.
- **Still pending under the broader CI umbrella** (out of T3.8 scope):
  - `terraform fmt` / `terraform validate` workflow across all five layers.
  - Container scan (was hinted at in earlier integration log as "X.3 CI").
  - JS/TS test workflows for `services/*` and `web/`.
  These are smaller follow-ups; T3.8 was specifically about schema BACKWARD-compat CI + Glue resource, and those are done.

## 2026-04-27 — T3.4 collection-adapter shipped

- **New module:** `services/collection-adapter/` — TS + Express + Jest, port 8085. Sibling to alerts/cases/bff.
- **Files:** `package.json`, `tsconfig.json`, `README.md`, `src/{types,router,source,sink,cases_client,processor,server}.ts`, `__tests__/{router,processor,server}.test.ts`.
- **Auto-routing flow:**
  - `CaseEventSource` reads NDJSON from `services/regulatory-svc/cases/.outbox/apex.case.events-*.ndjson` (default; configurable via `APEX_CASES_OUTBOX_DIR`).
  - `decideRoute(case_event)` is pure — `critical|high → route(reason='severity')`, `medium AND loan_id → route(reason='loan_default_track')`, else skip. Non-`case.created` events are ignored.
  - `CollectionSink` writes one `apex.collection.routes` event per routed case to `services/collection-adapter/.outbox/apex.collection.routes-*.ndjson`. The outbox sink replays its previous emissions on construction to populate a `seen` set, so the processor is idempotent on `case_id` across restarts.
  - `POST /process` runs one full pass and returns a report (`{scanned, routed, skipped_below_threshold, skipped_already_routed, skipped_non_create, routes[]}`).
- **Status callback flow:**
  - `POST /collection/callback` body `{case_id, status, note?}` where `status ∈ {cured, cured_temp, defaulted}`. Validates 400-style. Proxies to `services/regulatory-svc/cases POST /cases/:case_id/close` via the configurable `APEX_CASES_URL` (Node 18 global fetch, injectable for tests).
  - Upstream `CasesClientError` (4xx/5xx from cases service) is forwarded with the original status code; an upstream 409 illegal-transition surfaces as a 409 to Collection with `current_state` + `attempted` preserved in `body`. 503 when `APEX_CASES_URL` is unset (`UnavailableCasesClient`).
- **Numbers:** 19/19 jest tests pass (8 router + 3 processor + 8 server, including a real `OutboxCollectionSink` round-trip with a tmp dir). `tsc -p .` clean.
- **Defect surfaced (not fixed here):** `infra/schema-registry/apex.case.events.v1.json` predates the cases service implementation. Real emit shape differs:
  - Schema: `event_id`, `case_id`, `alert_id`, `occurred_at`, `lifecycle_state ∈ {ALERT, CASE, ASSIGNED, ACTION, MONITORED, CLOSED}`, optional `assignee` + `action` + `trace_id`.
  - Emitter (`services/regulatory-svc/cases/src/types.ts:CaseEvent`): `event_id`, `case_id`, `alert_id`, `customer_id`, `ts`, `event_type ∈ {case.created, case.assigned, case.action_logged, case.monitored, case.closed}`, `prior_state`, `new_state ∈ {open, assigned, in_action, monitored, closed}`, `payload` (free-form).
  - The schema BACKWARD checker doesn't catch this because it only diffs *between schema versions*, not between schema and live emitter. To prevent future drift, either:
    1. Bump to `apex.case.events.v2.json` to match the emitter (recommended — emitter is the source of truth) and have `services/regulatory-svc/cases` AJV-validate every event against the v2 schema before write, or
    2. Rewrite the emitter to match v1 and validate before write.
  - For T3.4 the collection-adapter consumes the live emitter shape, so the prototype works end-to-end; the schema fix is a 1-hour follow-up.
- **Hand-offs queued:**
  - `agent-integration` (own) — replace `CaseEventSource` outbox tail with MSK kafkajs consumer; replace `CollectionSink` outbox writer with HTTP/Kafka to the bank's Collection module; pick option 1 or 2 above to reconcile the case-events schema with the emitter.
  - `agent-case` — once the schema reconciliation lands, add AJV validation in `service.ts:emit` so production never writes an event that fails the registered schema.
  - `agent-rule` / `agent-alert` — same SmartQueue-assignment-events plumbing called out in T3.10 still applies (lets the BFF show live assignees on `/v1/alerts`).

## 2026-04-27 — apex.case.events schema/emitter alignment (defect from T3.4 closed)

- **What:** rewrote `infra/schema-registry/apex.case.events.v1.json` in place to match the live emitter shape from `services/regulatory-svc/cases/src/types.ts:CaseEvent`. Required fields are now `event_id`, `event_type`, `ts`, `case_id`, `alert_id`, `customer_id`, `new_state`. `prior_state` is optional + nullable; `payload` is `additionalProperties: true` (free-form for per-event-type evolution); top-level `additionalProperties: false`.
- **Why kept at v1.0.0 (not v2):** the original v1 was scaffolded before the cases service existed and had no consumer. No Glue resource was ever provisioned for it (T3.8 only just added the Terraform). So this is a "first real v1" rather than a v2 bump that would force consumers to migrate. The schema's `description` field documents the alignment for future readers.
- **Why this didn't get caught earlier:** the T3.8 BACKWARD-compat checker only diffs *between schema versions*. It can't catch divergence between schema and live emitter. The fix below adds the missing guard.
- **Emit-side guard:** `services/regulatory-svc/cases/src/event_validator.ts` (new) compiles the registered schema with Ajv2020 + ajv-formats and exposes `validateOrThrow(event)`. `service.ts:emit` calls it before every write. Any future code change that produces a non-conforming event throws `CaseEventSchemaError` immediately — invariant: nothing ever lands in the outbox that fails the schema.
- **Tests:**
  - 5 new tests in `services/regulatory-svc/cases/__tests__/event_validator.test.ts` — well-formed acceptance, required-fields rejection, unknown-enum rejection, additionalProperties rejection, and a full-lifecycle assertion that all 5 events written across `create → assign → logAction → monitor → close` pass the schema.
  - Re-ran T3.8 CI gate: `BACKWARD-compat OK — 7 schema(s) across 6 topic(s); 1 version-pair(s) checked.` + 16/16 schema-registry pytest tests + 31/31 cases jest tests + tsc clean.
- **Hand-off:** the collection-adapter from T3.4 already reads the live emitter shape (which is now also the canonical schema), so no change there. When `agent-integration` provisions the Glue Schema Registry resource (T3.8 Terraform), this v1 file is what gets uploaded. Next time a transition needs new payload keys, evolve `payload` (free-form by design) instead of bumping the top-level schema.

## 2026-04-27 — T3.9 RBAC matrix + quarterly access review

- **Files:**
  - `infra/rbac/matrix.json` — canonical matrix. 5 roles × 27 operations across alerts/cases/rules/customers/collection/users/audit.
  - `infra/rbac/README.md` — permission table as Markdown + the quarterly access review process (cadence, owners, runbook, audit-trail integration).
  - `infra/rbac/scripts/access_review.py` — Python CLI + library. Validates matrix self-consistency, validates a roster against the matrix, emits a Markdown review report with role distribution + dormant-account flags + sign-off block.
  - `infra/rbac/scripts/sample_roster.json` — mirrors `services/auth-svc/src/users.ts` for local-dev smoke tests.
  - `infra/rbac/tests/test_access_review.py` — 11 pytest tests (matrix loader, roster validator, dormant-detection rendering, CLI happy path + error path).
  - `infra/rbac/lib/{package.json,tsconfig.json,src/index.ts,__tests__/rbac.test.ts}` — small TS package `@apex-ews/rbac` exposing `loadMatrix()`, `can(role, op)`, `operationsFor(role)`, and an Express `requireRole(op, getRole)` middleware factory. 13 jest tests covering load, deny-by-default, per-role assertions, middleware 401/403/next paths.
- **Numbers:** 11/11 pytest + 13/13 jest = 24 new tests, all green. Both tsc and `pytest -q` clean.
- **Design notes:**
  - Matrix lives in JSON, not TS, so the Python access-review script and the TS service guards both consume the same source of truth.
  - Fail-closed on unknown roles AND unknown operations — wrong choice would silently grant on typos.
  - Quarterly review process is documented end-to-end (owners, cadence, runbook, audit append) so it's actionable, not aspirational.
  - The TS lib's `requireRole` factory matches the Express `(req, res, next)` signature already used elsewhere in the codebase, so adoption is a one-line addition per route.
- **Hand-offs:**
  - `agent-integration` (own) — extend `.github/workflows/schema-compat.yml` (or add a sibling workflow) to run `access_review.py --matrix infra/rbac/matrix.json --validate-only` on PRs touching the matrix.
  - `agent-rule` / `agent-alert` / `agent-case` — each service can adopt `import { requireRole } from '@apex-ews/rbac'` and wrap mutating routes (e.g. `/cases/:id/close` with `requireRole('cases:close', getRoleFromJwt)`). Out of scope for T3.9 (matrix authoring); next slice in their respective backlogs.
  - The Linear "quarterly-access-review" recurring ticket is described in the README; orchestrator agent runs the script on schedule (could be /loop or /schedule once the harness is wired).

## 2026-04-27 — RBAC enforcement in cases + CI gate

- **What:** turned `@apex-ews/rbac` from documentation-only into a runtime guard for `services/regulatory-svc/cases`. Added `.github/workflows/rbac-matrix.yml` so the matrix can't drift on PRs.
- **Files touched:**
  - `services/regulatory-svc/cases/src/server.ts` — imports `can` + `requireRole` from `../../../../infra/rbac/lib/dist/src/index`. Adds `AppDeps.getRole` (default reads `x-apex-role` header). Wraps every mutating + read route with `requireRole('cases:<op>')`.
  - `services/regulatory-svc/cases/__tests__/server.test.ts` — sets `getRole: () => 'admin'` so existing tests don't need to send the header.
  - `services/regulatory-svc/cases/__tests__/rbac.test.ts` (new, 8 tests) — exercises 401 (no role), 403 (denied roles per matrix), 200/201 (permitted roles). Includes an "admin wildcard" test that walks the full lifecycle (create/list/assign/action/monitor/close).
  - `infra/rbac/lib/src/index.ts` — `findDefaultMatrixPath()` walks the dir tree so the same source works under `lib/src/` (ts-jest) and `lib/dist/src/` (consumers).
  - `.github/workflows/rbac-matrix.yml` (new) — two jobs: `validate-matrix` (access_review.py + pytest) and `validate-ts-helper` (npm ci + build + test).
- **Numbers:** 39/39 cases jest tests (8 new); 13/13 rbac jest still pass; 11/11 rbac pytest still pass; tsc clean for both. The cross-module import to `dist/src/index` is the same shape as the rules service's `'../../../../rules/types'` pattern but points at compiled output so tsc honours rootDir.
- **Why import from dist not src:** tsc with `rootDir: '.'` complains when source files outside the rootDir are pulled into compilation. Importing from the rbac lib's compiled `dist/` means tsc reads the `.d.ts` declarations only — type info, not source — which is the production-correct way to consume a sibling module without setting up TS project references. Trade-off: consumers must build the rbac lib first; the CI workflow does this in `validate-ts-helper` and the local-dev recipe is `cd infra/rbac/lib && npm run build` once after a fresh clone.
- **Hand-offs:**
  - `agent-rule` / `agent-alert` / `agent-integration` — adopt `requireRole` on their mutating routes following the cases pattern. Each service can copy the `defaultGetRole` + `requireRole` factory from `services/regulatory-svc/cases/src/server.ts`.
  - `agent-integration` — once auth-svc issues JWTs in dev, swap `defaultGetRole` from header-reader to JWT-claim extractor (`req.user.role`).
  - Eventually fold the `validate-ts-helper` job into a unified `services-ci.yml` workflow that builds + tests every TS service under `services/*/` on every PR. Out of scope for this slice.

## 2026-04-27 — RBAC adoption rolled out across bff + collection-adapter; services-ci.yml landed

- **bff** — guarded surfaces:
  - `GET /api/alerts` + `GET /v1/alerts` → `alerts:list`
  - `POST /v1/ews/evaluate` + `GET /v1/risk-profile/:customer_id` → `customers:read_risk_profile`
  - `POST /v1/action` → `cases:log_action`
  - 9 new tests in `services/bff/__tests__/rbac.test.ts`. 41/41 jest pass; tsc clean.
- **collection-adapter** — guarded surfaces:
  - `POST /collection/callback` → `collection:callback`
  - `POST /process` → admin-only (inline check; the matrix doesn't carry a dedicated `process:run` op since /process is a diagnostic trigger, not part of the public surface).
  - 8 new tests in `services/collection-adapter/__tests__/rbac.test.ts`. 27/27 jest pass; tsc clean.
- **services-ci.yml** — three-stage workflow:
  1. `rbac-lib` — `npm ci && npm run build && npm test` for `infra/rbac/lib`. Uploads `dist/` as artifact `rbac-dist`.
  2. `service` matrix — eight TS services run `npm ci && npm test && npm run build` in parallel. Three of them (cases, bff, collection-adapter) download `rbac-dist` first because they import the compiled helper from `infra/rbac/lib/dist/src/index`.
  3. `web` — `npm ci && npx vitest run && npm run build` for the SPA.
- **Pattern callout (for agent-rule / agent-alert / agent-indicator):** the three-line diff to adopt `@apex-ews/rbac` is:
  1. Import `requireRole as rbacRequireRole` from `'../../../infra/rbac/lib/dist/src/index'` (or appropriate relative path).
  2. Add `defaultGetRole` (reads `x-apex-role` header) + `requireRole(op)` factory inside `makeApp`.
  3. Wrap each mutating route with `requireRole('<resource>:<verb>')` per the matrix.
  Tests: inject `getRole: () => 'admin'` in existing test factories so business-logic tests don't need to dance with headers; add a `__tests__/rbac.test.ts` with the realistic header-driven 401/403/200 paths.
- **Caveat (called out separately):** GitHub Actions workflows are committed but not yet observed running — there's no GH remote in this prototype env. The yaml is well-formed and the underlying commands all run clean locally (152+ tests pass across all services this session).

## 2026-04-27 — RBAC in alerts + SPA role-header interceptor (front-to-back enforcement)

- **alerts service guards:**
  - `GET /alerts` → `alerts:list`
  - `GET /alerts/:id` → `alerts:read`
  - `POST /alerts/:id/assign` → `alerts:assign`
  - `POST /alerts/:id/ack` → `alerts:ack`
  - `POST /alerts/:id/close` → `alerts:close`
  - `POST /alerts/evaluate` → admin-only inline (system-internal producer endpoint; not in matrix because it's not a published operation).
- **Defect surfaced + fixed:** `services/regulatory-svc/alerts/src/schemas.ts` used default `Ajv` (draft-07) against schemas declaring `$schema: draft/2020-12`. AJV refused to compile, throwing `no schema with key or ref draft/2020-12`. This is the same defect pattern caught in `services/regulatory-svc/rules/src/dsl.ts` during the 2026-04-26 verification run — but the alerts test was never exercised in BOOTSTRAP step 6 (which only ran rules), so it never surfaced until services-ci.yml started running everything. Switched to `Ajv2020` (one-line import). All 7 previously-broken alert.test.ts cases now pass.
- **alerts test suite:** added supertest dependency; new `__tests__/rbac.test.ts` with 8 tests (admin-only /evaluate, denied roles per matrix, allowed roles per matrix). 40/40 jest pass total; tsc clean.
- **SPA axios interceptor:** `web/src/lib/http.ts` now reads the auth store's `apex.ews.user` blob from localStorage and sends `roles[0]` as `x-apex-role` on every request, alongside the existing Bearer token interceptor. 5 new vitest tests cover all paths (token-only, role-only, neither, malformed-blob, both).
- **End-to-end posture:** SPA login → user object cached to localStorage → axios interceptor sets `x-apex-role` → service reads header via `defaultGetRole` → `@apex-ews/rbac.requireRole` checks the canonical matrix. Same path for cases, alerts, bff, collection-adapter. JWT-claim extraction is the production swap point at both ends.

## 2026-05-14 — T6 M14.19 — Field-operations analytics

### Tasks ticked
- T6 sub-phase M14.19 — field-operations analytics. T6 sub-phase tally 102 → 103.

### Files touched
- `services/bff/src/field_operations_analytics.ts` (new) — pure `summarizeFieldOperations(visits)` returning `FieldOperationsAnalytics` with sample_size, distinct_officers, distinct_customers, outcome_mix (re-uses existing `aggregateByOutcome`), success_count + success_rate (success = met_customer + partial_payment + promised_to_pay; tunable via exported `SUCCESS_OUTCOMES`), mean_visits_per_officer, per-officer rollup (visit_count, distinct_customers, success_rate, by_outcome, last_visit_at) sorted by visit_count desc → success_rate desc → officer_id asc.
- `services/bff/__tests__/field_operations_analytics.test.ts` (new) — 15 jest tests: 9 unit (empty input shape, SUCCESS_OUTCOMES contents, success_rate denominator, outcome_mix double-counting, per-officer distinct_customers + last_visit_at + success_rate, primary sort by visit_count, secondary sort by success_rate, tertiary alphabetical tie-break, distinct customers across officers) + 6 route (200 empty, 200 with visits, filter narrowing, invalid outcome → 400, 403 wrong role, cross-tenant isolation).
- `services/bff/src/server.ts` — import `summarizeFieldOperations` + `isVisitOutcome`; new route `GET /v1/field/operations/analytics` (`audit:read`, tenant-isolated) accepting the same filter set as `/v1/field/visits` (officer_id/customer_id/outcome/since/until), with strict `isVisitOutcome` validation on `?outcome=`. Returns `{ analytics }`.

### Decisions
- **Success = met_customer + partial_payment + promised_to_pay.** Collections-workflow positives. no_response / dispute / escalation_needed are negatives. Exported `SUCCESS_OUTCOMES` so tests + future consumers can use the canonical set instead of duplicating the literal.
- **Sort order is deterministic.** Tie-break chain (visit_count desc → success_rate desc → officer_id asc) makes the per-officer list snapshot-stable across runs.
- **Reuse existing filter shape.** `/v1/field/operations/analytics` mirrors `/v1/field/visits` so callers compose the same query params; reduces SPA surface complexity.
- **`audit:read` RBAC.** Matches M3.5 / M8.6 / M9.5 analytics-route convention.
- **No new store.** Derived from M14.10's existing visit ledger.

### Hand-offs
- **agent-ui** — supervisor "team operations" panel can drive against `GET /v1/field/operations/analytics?since=...`. Envelope: `{ analytics: FieldOperationsAnalytics }`. The per_officer list is already sorted leaderboard-style.

### Verification
- `npx jest __tests__/field_operations_analytics.test.ts` — 15/15 pass.
- `npx jest` (full BFF suite) — 4108 pass / 58 skipped / 4167 total. Intermittent cross-suite singleton flakiness in `config_bulk` / `cms_case_tracking` — both pass when run alone; pre-existing pattern unrelated to M14.19.
- `npx tsc --noEmit` — clean.

## 2026-05-14 — T6 M15.5 — Audit log integrity spot-check

### Tasks ticked
- T6 sub-phase M15.5 — audit chain integrity spot-check. T6 sub-phase tally 109 → 110.

### Files touched
- `services/bff/src/audit_trail.ts` — exported `computeEventHash` (was module-local) so the sample verifier uses the same canonical SHA-256 encoding as M15.2's full-chain walker. Added `ChainSampleVerification` type (superset of `ChainVerification` adding `window_size`, `sample_size`, `window_start_index`). Extended `AuditTrailStore` interface with `verifyChainSample(tenant, window_size, now)` method. Implemented on `InMemoryAuditTrailStore`: walks `arr.slice(total - window_size)` recomputing each event's hash and verifying each `prev_hash` matches the previous event's `hash`. Seeds `prev` with `arr[window_start_index - 1].hash` (or `'GENESIS'` when window covers the whole chain) so the leading edge of the window is also verified — catches tampering on the first event in the window. Constants `CHAIN_SAMPLE_DEFAULT_WINDOW = 50` and `CHAIN_SAMPLE_MAX_WINDOW = 500` surfaced to the route.
- `services/bff/__tests__/audit_chain_sample.test.ts` (new) — 18 jest tests: 9 store-level (empty tenant, non-positive window defensive return, window<total, window>total, agrees-with-full-chain-on-clean, hash tampering inside window, prev_hash tampering at window edge, tampering outside window is undetected by sample but caught by full M15.2 walk, tenant isolation) + 9 route (empty default window, ?window=5 honored, window=0 → 400, window>max → 400, ?window=abc NaN → 400, tampering inside → 200 valid=false with broken_at, 403 wrong role, cross-tenant invisible, M15.2 /integrity regression check).
- `services/bff/src/server.ts` — import `CHAIN_SAMPLE_DEFAULT_WINDOW` + `CHAIN_SAMPLE_MAX_WINDOW`. New route `GET /v1/audit/integrity/sample?window=N` mounted right after the M15.2 `/integrity` route. Validates window is int in `[1, 500]` → 400 otherwise. Delegates to `auditTrailStore.verifyChainSample`. `audit:read` RBAC matches M15.2.

### Decisions
- **Sample closes the chain back to the un-verified prefix.** The first event in the window's `prev_hash` is verified against the hash of the event immediately before the window (or `'GENESIS'` if window starts at index 0). Without this, tampering on the first event in the window would slip through. Costs one extra dictionary lookup, gains full chain-edge coverage.
- **Same canonical encoding as M15.2.** Exporting `computeEventHash` keeps the two verifiers guaranteed-consistent — a future change to the hash inputs lands in one place. Documented why the export exists at the function comment.
- **Defensive non-positive window returns 0-result, doesn't throw.** Route layer validates; if a misbehaving caller bypasses, the store returns a sample_size=0 / valid=true envelope rather than crashing.
- **Sample does NOT catch tampering OUTSIDE the window.** Documented in tests + STATUS. M15.2's full walk remains the truth oracle; M15.5 is the cheap-but-incomplete health pulse for dashboard polling.
- **Default window=50, max=500.** Same posture as M3.5's analytics window. Larger windows are still cheaper than the full walk in tenants with millions of events.

### Hand-offs
- **agent-ui** — audit dashboard health-pulse card can poll `GET /v1/audit/integrity/sample` every minute and render a 🟢/🔴 indicator + sample_size context ("verified newest 50 of 12,431 events"). Full M15.2 walk stays the "Run full integrity check" button for the heavier on-demand verification.

### Verification
- `npx jest __tests__/audit_chain_sample.test.ts` — 18/18 pass.
- `npx jest` (full BFF suite) — 4232 pass / 58 skipped / 4290 total, **zero failures**.
- `npx tsc --noEmit` — clean.

## 2026-05-14 — T6 M2.5 — Onboarding step skip-with-reason capture

### Tasks ticked
- T6 sub-phase M2.5 — onboarding skip-with-reason capture. T6 sub-phase tally 113 → 114.

### Files touched
- `services/bff/src/tenant_onboarding.ts` — added `skip_reason: string | null` field to `StepProgress` (default null on `pendingStep`). New exported constants `SKIP_REASON_MIN = 5` / `SKIP_REASON_MAX = 500`. New private `normaliseSkipReason(input)` collapses whitespace + validates length, throws `skip_reason_required` / `skip_reason_too_short` / `skip_reason_too_long` `OnboardingError` codes. Extended `OnboardingStore` interface with `skipStepWithReason(tenant, step, actor, reason, now)`. `InMemoryOnboardingStore` impl forces status=skipped, completed_at=null, completed_by=actor.trim(), notes=null, skip_reason=cleanReason. Existing `markStep` updated to set `skip_reason: null` on every write (legacy skipped path stays compatible — skip_reason just remains null).
- `services/bff/__tests__/tenant_onboarding_skip.test.ts` (new) — 19 jest tests: 3 happy path (captures reason, whitespace collapse, counts move pending→skipped), 5 validation (missing/empty/whitespace, too short, too long, unknown step, missing actor), 3 backwards-compat (legacy markStep skipped stays null, skipStepWithReason → markStep completed clears reason, pendingStep default), 1 tenant isolation, 7 route (200 happy, 400 each of the 3 reason errors, 404 unknown_step, 403 wrong role, M2.2 markStep route still works).
- `services/bff/src/server.ts` — `POST /v1/tenants/:tenant_id/onboarding/steps/:step_id/skip` mounted BEFORE the catch-all `.../steps/:step_id` so the literal `/skip` segment isn't captured as a step_id. `audit:read` RBAC matches M2.2. 404 mapped for `unknown_step`; 400 for the three `skip_reason_*` codes; 500 fallback.

### Decisions
- **New explicit `/skip` route, not extending markStep.** Two reasons: (1) backwards-compatibility — 46 pre-existing onboarding tests pass unchanged because `markStep(..., 'skipped', ...)` still works without a reason. (2) The new route's body shape `{reason}` is simpler than the markStep `{status, notes}` shape; the SPA's skip-confirmation dialog gets a focused endpoint.
- **`skip_reason` is a distinct field from `notes`.** Notes is generic free-form text; skip_reason is the structured compliance justification. Auditors filter on it; SPA renders it inline. Keeps the audit semantics clean.
- **5-char floor.** Catches `'a'`, `'no'`, `'tbd'` — entries that wouldn't survive a regulator review. Tunable via the exported constant.
- **500-char ceiling.** Same shape as the M16.4 description cap; long enough for a sentence-or-three justification, short enough to render in a card.
- **markStep clears skip_reason back to null on `completed`.** A step that was skipped-with-reason and then later completed shouldn't carry stale skip_reason text — the audit trail of WHEN it was skipped lives in the audit log, not on the live state.

### Hand-offs
- **agent-ui** — onboarding wizard "Skip" button → dialog that REQUIRES a reason input (5..500 chars) → `POST .../skip` → render the inline skip_reason badge on the now-skipped step. Legacy skipped-without-reason steps from before M2.5 show "(reason not captured — pre-M2.5)" inline.

### Verification
- `npx jest __tests__/tenant_onboarding_skip.test.ts` — 19/19 pass.
- `npx jest __tests__/tenant_onboarding.test.ts` — 46/46 (pre-existing tests unaffected by the field addition).
- `npx jest` (full BFF suite) — 4300 pass / 58 skipped / 4358 total, **zero failures**.
- `npx tsc --noEmit` — clean.

## 2026-05-14 — T6 M14.20 — Adapter SLA breach event analytics

### Tasks ticked
- T6 sub-phase M14.20 — adapter SLA breach event analytics. T6 sub-phase tally 114 → 115.

### Files touched
- `services/bff/src/adapter_sla_breach_analytics.ts` (new) — pure `summarizeBreachEvents(events)` returns `AdapterSlaBreachAnalytics`: sample_size, distinct_connectors, acknowledged_count + unacknowledged_count + ack_rate, by_reason (all 3 SlaBreachReason keys present at 0 when absent; one event with N reasons in sla_breaches[] increments each), by_day (UTC YYYY-MM-DD oldest-first), top_breachers cap 10 sorted by breach_count desc → last_breached_at desc → connector_id asc with per-connector recent_reasons cap 3 newest-first and rename-safe connector_name (tracks the newest event's name).
- `services/bff/__tests__/adapter_sla_breach_analytics.test.ts` (new) — 15 jest tests: 9 unit (empty zero envelope, reason mix, distinct connectors, ack split, top_breachers sort + cap, recent_reasons cap, connector_name rename-safe, by_day UTC oldest-first) + 6 route (empty, populated, ?since narrows, ?since=invalid → 400, 403 wrong role, cross-tenant isolation).
- `services/bff/src/server.ts` — `GET /v1/ingestion/adapters/sla-breaches/analytics?since=ISO` mounted BEFORE the M14.14 `/:event_id/acknowledge` wildcard so the literal "analytics" segment isn't captured as an event_id. `audit:read` RBAC matches M14.13. Validates `?since` via `Number.isFinite(new Date(s).getTime())` → 400 on bad input.

### Decisions
- **Reuse existing `query(tenant, {since})` — no new store method needed.** The breach event store already exposes a tenant-filtered, newest-first query with optional since/limit/acknowledged. M14.20 just runs the pure aggregator over the slice.
- **`by_reason` increments PER REASON, not per event.** An event with `sla_breaches: ['success_rate_below_target', 'p95_latency_above_target']` increments BOTH keys by 1. Tests this explicitly. Reflects the operational reality — those are independent SRE concerns.
- **`connector_name` rename-safe.** If an operator renames the connector between observations, the rollup uses the newest event's name. Tested explicitly.
- **`recent_reasons` cap 3, newest-first.** Same posture as M3.6's exemplar messages.
- **No `last_acknowledgement_note` surfaced.** The breach detail view (M14.13 + M14.14) carries the ack metadata; analytics just counts. Keeps payload size predictable.

### Hand-offs
- **agent-ui** — admin dashboard adapter card can drive against `GET /v1/ingestion/adapters/sla-breaches/analytics?since=2026-05-01T00:00:00Z`. Envelope: `{ analytics: AdapterSlaBreachAnalytics }`. `top_breachers` is already a leaderboard; `by_reason` is a 3-bar mini-chart; `ack_rate` is the headline gauge.

### Verification
- `npx jest __tests__/adapter_sla_breach_analytics.test.ts` — 15/15 pass.
- `npx jest` (full BFF suite) — 4313 pass / 58 skipped / 4373 total. Intermittent cross-suite singleton flakiness in `cms_routes` / `indicator_thresholds` — both pass when run alone (109/109); pre-existing pattern unrelated to M14.20.
- `npx tsc --noEmit` — clean.
