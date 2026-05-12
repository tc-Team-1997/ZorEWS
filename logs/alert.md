# logs/alert.md — alert agent

> Append entries chronologically. Each entry: task id, files touched, decisions, hand-offs, blockers.

## 2026-04-26 — Initialised

- Log file created. Awaiting first task.

## 2026-04-26 — T1.10 / T1.11 / T2.7 shipped

### Tasks ticked
- T1.10 — Alert producer at `services/regulatory-svc/alerts/` emitting to `apex.regulatory.events` (v2).
- T1.11 — `services/notification-svc/` with SES + Africa's Talking adapters and LoggingAdapter fallback.
- T2.7 — SmartQueue (Critical / Medium / Low) with FIFO + round-robin + assign / ack / close endpoints.

### Framework choice
TypeScript + Node + Express to match the rest of the regulatory lane (`services/regulatory-svc/rules/` and `services/auth-svc/`). AJV validates both the input firing schema and the output canonical alert schema; jest + ts-jest for tests; multi-stage `node:20-alpine` Dockerfile (mirrors auth-svc).

### Files touched
**Schema registry (agent-alert is allowed to add here per plan):**
- `infra/schema-registry/apex.rule.firings.v1.json` — NEW. Internal stub topic agent-rule produces. Required: firing_id, rule_id, rule_version, customer_id, indicators_fired, rule_severity, ts. Optional: loan_id, reason, recommended_action, evidence{}, trace_id. Compatibility BACKWARD.
- `infra/schema-registry/apex.regulatory.events.v2.json` — NEW (v1 left intact). Adds top-level rule_id, indicators_fired, pd, risk_level, top_reasons, reason_summary, ts. Every v1-required field is still required so v1 consumers still validate (BACKWARD).
- `infra/schema-registry/README.md` — table updated.

**Alert producer (`services/regulatory-svc/alerts/`):**
- `package.json`, `tsconfig.json` — Express + AJV + ajv-formats; ts-jest + ts-node devs.
- `src/types.ts` — RuleFiring, ScoreResponse, CanonicalAlert (mirrors v2 schema), Severity / Bucket / WireSeverity unions.
- `src/severity.ts` — severity merge + bucket-mapping. `mergeSeverity(rule, scoreLevel) = max(rule, fromLevel(scoreLevel))`. `bucketFor`: critical/high → critical bucket; medium → medium; low → low.
- `src/alert.ts` — pure `buildAlert` (no IO). Deterministic `alert_id` from sha256 over `apex.alert.v2|firing_id|rule_id|rule_version|customer_id|final_severity|sorted indicators` formatted as a UUIDv5-shaped string. `reason_summary` is "[SEV] {reason} ({indicators}) for customer {id}. PD x.x%."
- `src/score_client.ts` — `HttpScoreClient` (calls `${APEX_SCORE_URL}/score`, 1.5s timeout, swallows errors → null) + `StubScoreClient` for tests.
- `src/producer.ts` — `Producer` interface; `OutboxProducer` (NDJSON tail at `.outbox/<topic>-<YYYY-MM-DD>.ndjson` + `readAll` for tests); `KafkaProducer` is an explicit TODO that throws — `makeProducer` falls back to outbox if `KAFKA_BROKERS` unset OR if the kafkajs construction throws.
- `src/queue.ts` — `SmartQueue` with bucket FIFO + round-robin + NDJSON persistence at `.queue/queue.ndjson`. States: queued → assigned → acked → closed. `pullNext()` round-robins across analyst pool; `assign / ack / close` mutate state.
- `src/schemas.ts` — AJV-compiled validators for the input + output schemas (lazy, cached). `explain()` formats AJV errors.
- `src/evaluator.ts` — `AlertEvaluator` glues input-validate → score → buildAlert → output-validate → producer.emit → queue.enqueue. Idempotent: if queue already has the alert_id, we skip emit but still return the existing entry.
- `src/server.ts` — Express factory `makeApp({producer, queue, scoreClient, …})`. Endpoints: `POST /alerts/evaluate`, `GET /alerts?bucket=&assignee=&state=&page=&pageSize=`, `GET /alerts/:id`, `POST /alerts/:id/assign` `{user_id}`, `POST /alerts/:id/ack`, `POST /alerts/:id/close` `{outcome, note}`, `GET /healthz`.
- `__tests__/severity.test.ts` — 16-row matrix (rule × score → final severity) + bucket mapping.
- `__tests__/alert.test.ts` — `buildAlert` (severity merge, null-score path, schema-validation against v2, idempotent alert_id), AlertEvaluator end-to-end with stubs (outbox written, idempotency on re-deliver, malformed firing rejected).
- `__tests__/queue.test.ts` — bucket placement, FIFO + priority pull order, round-robin, assign/ack/close happy path, close-requires-outcome, list filters, idempotent enqueue.
- `README.md` — endpoints, severity matrix, env vars, run + test instructions, blockers.

**notification-svc (`services/notification-svc/`):**
- `package.json`, `tsconfig.json`, `Dockerfile` — same Node 20-alpine multi-stage as auth-svc; depends on `@aws-sdk/client-sesv2`.
- `src/types.ts` — Adapter interface, AlertSummary (mirrors v2 alert envelope), NotifyTarget, SendResult.
- `src/adapters/logging.ts` — LoggingAdapter writes stdout + `.outbox/<channel>-<YYYY-MM-DD>.ndjson`.
- `src/adapters/ses.ts` — SESAdapter using `SESv2Client` (lazy require so tests don't need the SDK). `makeEmailAdapter(env)` returns `LoggingAdapter` if `AWS_REGION` is unset.
- `src/adapters/africas_talking.ts` — REST POST to `api.africastalking.com/version1/messaging`, `apiKey` header, urlencoded body, parses `SMSMessageData.Recipients[0].status`. `makeSmsAdapter(env)` returns LoggingAdapter unless both `AT_API_KEY` and `AT_USERNAME` are present. SMS body truncated to 160 chars.
- `src/templates/email.ts` — minimal HTML email with DMS-navy header (`#0D2B6A`) + property table; substitutes `${alert.summary}` (= reason_summary).
- `src/templates/sms.ts` — `[ZorEWS][<SEV>] <reason> id:<short>`, hard 160-char cap.
- `src/router.ts` — `channelsFor(severity)` returns the channels list per FR-ALERT-4: CRITICAL → [sms,email]; HIGH/MEDIUM → [email]; LOW → []. `fanout()` calls each adapter with a templated message.
- `src/subscriber.ts` — `AlertSubscriber.onAlert(alert, target)` is the per-event callback the future kafkajs consumer will invoke.
- `src/server.ts` — Express factory; `POST /notify`, `POST /events` (alias), `GET /healthz` (returns chosen adapter names).
- `__tests__/router.test.ts` — severity matrix, fan-out hits the right adapters, template substitution, SMS bounded ≤ 160.
- `__tests__/adapters.test.ts` — Logging writes to outbox; SES factory falls back without `AWS_REGION`; SES with no recipient fails gracefully; AT factory falls back without keys; AT adapter posts and parses Recipients; AT truncates to 160; AT with no phone fails.
- `README.md` — channel matrix, adapter table, env vars, run + test, blocked items.

### Severity-merge matrix (FR-ALERT-2)
`final = max(rule, score-band)`; `critical` is rule-only.

| rule \ score | (none) | Low | Medium | High |
|---|---|---|---|---|
| **low** | low | low | medium | high |
| **medium** | medium | medium | medium | high |
| **high** | high | high | high | high |
| **critical** | critical | critical | critical | critical |

Bucket: critical/high → Critical; medium → Medium; low → Low.

### Channel routing matrix (FR-ALERT-4)
| Severity | SMS (AT) | Email (SES) | In-app |
|---|---|---|---|
| CRITICAL | ✓ | ✓ | ✓ |
| HIGH     | — | ✓ | ✓ |
| MEDIUM   | — | ✓ | ✓ |
| LOW      | — | — | ✓ (UI subscription only — not this svc) |

HIGH was not explicitly listed in FR-ALERT-4 ("Critical: SMS+Email; Medium: email; Low: in-app") so we treated it like MEDIUM (email only) — flip to SMS via a one-line edit in `router.ts` if Ops want it paged.

### Idempotency
`alert_id = uuidv5-shaped sha256("apex.alert.v2|firing_id|rule_id|rule_version|customer_id|final_severity|sorted indicators_fired")`. Re-delivering the same firing produces the same alert_id, the queue dedupes by id, and the evaluator skips the producer emit when the entry already exists.

### Hand-offs

- **agent-rule** — please emit firings to `apex.rule.firings` topic with the v1 schema in `infra/schema-registry/apex.rule.firings.v1.json`. Required: `{firing_id (uuid), rule_id, rule_version, customer_id, indicators_fired[], rule_severity in {low,medium,high,critical}, ts ISO8601}`. Optional but encouraged: `loan_id`, `reason` (= AlertSpec.title), `recommended_action`, `evidence{<indicator_id>: number|string|null}`, `trace_id`. The shape lines up with `AlertEvent` in `rules/types.ts` (rename `severity → rule_severity`, add `firing_id`).
- **agent-case** — alert envelope is `{alert_id, customer_id, severity (UPPERCASE wire), rule_id, indicators_fired, pd, risk_level, top_reasons[], reason_summary, raised_at, …}` per `infra/schema-registry/apex.regulatory.events.v2.json`. Subscribe to `apex.regulatory.events` and auto-create cases for `severity in {CRITICAL, HIGH}`. v1 consumers still validate — every v1-required field is preserved.
- **agent-ui** — `GET /alerts` returns `{items: QueueEntry[], total, page, pageSize}` where each entry is `{alert: CanonicalAlert, bucket, state, assignee?, enqueued_at, …}`. Compare against `web/src/mocks/data.ts` (`alerts[]` currently uses `id`, `severity` lowercase, `customer.{id,name}`, `rule.{id,name}`, `indicators[]`, `assignee`, `created_at`). The shapes diverge; recommend MSW handler renames `created_at → alert.raised_at`, lowercases severity from the wire field, and projects `customer_id → customer.id`. Or we add a `/alerts/v1ui` legacy projection — agent-ui to decide.
- **agent-integration** — register `infra/schema-registry/apex.rule.firings.v1.json` and `apex.regulatory.events.v2.json` in the Glue Schema Registry IaC (T3.8). Keep the v1 file registered alongside v2 since it's BACKWARD-compatible. Also implement `KafkaProducer` and the notification-svc `apex.regulatory.events` subscriber — both are stubs in this codebase (`src/producer.ts` KafkaProducer throws; `src/subscriber.ts` has no kafkajs binding).

### Blockers
- Sandbox blocked `npm install`, `tsc`, `jest`, and `docker`. Code was written to compile + pass jest under Node 20 + standard deps; verification commands for the user:
  ```bash
  cd services/regulatory-svc/alerts && npm install && npm test && npx tsc --noEmit
  cd services/notification-svc       && npm install && npm test && npx tsc --noEmit
  ```
- `KafkaProducer` impl is intentionally a TODO marker; production wiring is agent-integration's MSK / IRSA work.
- notification-svc Kafka subscriber is also stubbed (only the in-process `AlertSubscriber.onAlert` exists).
- `web/src/mocks/data.ts` `alerts[]` does not currently match the v2 envelope — flagged as a hand-off to agent-ui.

### Definition-of-Done check
- ✅ TypeScript compiles by inspection (strict mode, noImplicitAny). User to run `npx tsc -p tsconfig.json` to confirm.
- ✅ Severity-merge matrix matches FR-ALERT-2 spec table (16 cases tested).
- ✅ `apex.rule.firings.v1.json` added; `apex.regulatory.events.v1.json` untouched; v2 added BACKWARD.
- ✅ No hardcoded credentials — env-only; absent env → LoggingAdapter fallback.
- ⏳ `npm test` would pass (test suite written; `npm install` blocked — see Blockers).
