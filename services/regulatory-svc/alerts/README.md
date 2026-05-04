# regulatory-svc / alerts

Alert producer + smart-prioritisation queue. Owns T1.10 (alert producer →
`apex.regulatory.events`) and T2.7 (Critical / Medium / Low queues).

## Pipeline

```
agent-rule  ─►  apex.rule.firings (v1)  ─►  alerts/evaluator
                                              │
                                              ├─ POST /score (ai-copilot-svc)  best-effort
                                              ├─ severity merge (rule × score)
                                              ├─ buildAlert + content-hash alert_id
                                              ├─ AJV-validate against apex.regulatory.events.v2
                                              ├─ Producer.emit("apex.regulatory.events", alert)
                                              └─ SmartQueue.enqueue(alert)
```

The producer interface has two implementations:

| Impl | When | Notes |
|------|------|-------|
| `KafkaProducer` | prod (`KAFKA_BROKERS` set) | Live — wraps [`@apex-ews/event-bus`](../../event-bus/) kafkajs adapter. Hashes by `customer_id` for ordered partition writes. Set `KAFKA_SSL=1` + SASL env for MSK / Confluent. Falls back to outbox if construction throws. |
| `OutboxProducer` | dev / tests | NDJSON tail at `services/regulatory-svc/alerts/.outbox/<topic>-<YYYY-MM-DD>.ndjson` |

## Severity merge — FR-ALERT-2 matrix

`final_severity = max(rule.severity, score-band severity)`. `critical` is a
rule-only escalation; no score band maps to critical.

| rule severity ↓ \ score level → | (none) | Low | Medium | High |
|---|---|---|---|---|
| **low** | low | low | medium | high |
| **medium** | medium | medium | medium | high |
| **high** | high | high | high | high |
| **critical** | critical | critical | critical | critical |

Bucket mapping for the smart-queue:

| Final severity | Bucket   |
|----------------|----------|
| critical, high | Critical |
| medium         | Medium   |
| low            | Low      |

## Endpoints

| Method | Path | Body |
|--------|------|------|
| `POST` | `/alerts/evaluate` | `RuleFiring` (apex.rule.firings.v1 shape). Returns `{alert, queueEntry, score, alertExisting}`. Idempotent on the (firing, severity) content key. |
| `GET`  | `/alerts?bucket=critical|medium|low&assignee=&state=&page=&pageSize=` | Paged queue listing. |
| `GET`  | `/alerts/:id` | Single queue entry. |
| `POST` | `/alerts/:id/assign` | `{user_id}` |
| `POST` | `/alerts/:id/ack` | empty |
| `POST` | `/alerts/:id/close` | `{outcome, note?}` |

## Idempotency

`alert_id` is derived deterministically from `sha256(firing_id | rule_id |
rule_version | customer_id | final_severity | sorted indicators_fired)` —
re-delivery of the same firing produces the same envelope, the same queue
entry, and a single emit on `apex.regulatory.events`.

## Configuration (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `8082` | HTTP listener port |
| `APEX_SCORE_URL` | (unset → stub returns null) | `ai-copilot-svc` base URL, e.g. `http://ai-copilot-svc:8080` |
| `APEX_QUEUE_PATH` | `services/regulatory-svc/alerts/.queue/queue.ndjson` | NDJSON queue tail |
| `APEX_ALERT_OUTBOX_DIR` | `services/regulatory-svc/alerts/.outbox` | dev producer sink |
| `APEX_ANALYST_POOL` | (empty → no auto-assign) | Comma-separated analyst user ids for round-robin |
| `KAFKA_BROKERS` | unset | When set, attempts real Kafka producer; falls back to outbox on error |
| `KAFKA_CLIENT_ID` | `apex-alert-producer` | |

## Schemas

* Input (consumed): [`infra/schema-registry/apex.rule.firings.v1.json`](../../../infra/schema-registry/apex.rule.firings.v1.json)
* Output (produced): [`infra/schema-registry/apex.regulatory.events.v2.json`](../../../infra/schema-registry/apex.regulatory.events.v2.json)

The `v2` envelope is BACKWARD-compatible with v1 (every v1-required field is
still required) and adds `rule_id`, `indicators_fired`, `pd`, `risk_level`,
`top_reasons`, `reason_summary`, `ts`.

## Run

```bash
cd services/regulatory-svc/alerts
npm install
npm run dev          # ts-node src/server.ts
# in another shell:
curl -sX POST localhost:8082/alerts/evaluate -H 'content-type: application/json' -d '{
  "firing_id":"11111111-1111-4111-8111-111111111111",
  "rule_id":"RULE-014",
  "rule_version":1,
  "customer_id":"CUST0000001",
  "indicators_fired":["TXN-003","BEH-006"],
  "rule_severity":"medium",
  "reason":"Salary inflow stopped 60d",
  "ts":"2026-04-26T08:00:00Z"
}'
```

## Tests

```bash
cd services/regulatory-svc/alerts
npm install
npm test
```

Covered:

* severity-merge matrix (16 cases) + bucket mapping
* `buildAlert` envelope shape vs `apex.regulatory.events.v2` schema
* idempotency by content key
* `AlertEvaluator` end-to-end with stubbed score client & outbox producer
* `SmartQueue`: bucket placement, FIFO, round-robin assignment, close happy
  path, idempotent enqueue.

## Blocked / TODO

* `npm install` was not executed in the build sandbox (no network). Run the
  install + `npm test` locally to verify. `tsc -p tsconfig.json` should be
  warning-free; the suite uses `ts-jest`.
* `KafkaProducer` is live (delegates to `@apex-ews/event-bus`). For local
  dev with a real broker: `docker compose -f services/event-bus/docker-compose.yml up -d`
  then `KAFKA_BROKERS=localhost:19092 npm run dev`.
* `indicator_value_ids` is left empty until agent-indicator's value store is
  online; the v2 schema marks it optional.
