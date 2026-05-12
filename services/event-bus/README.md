# `@apex-ews/event-bus`

Pluggable Producer/Consumer over local NDJSON, Kafka (kafkajs / MSK / Redpanda), or in-memory.

## Why

The ZorEWS prototype emits events from several services — `regulatory-svc/alerts`, `regulatory-svc/cases`, `regulatory-svc/indicators`, BFF — and historically each had its own ad-hoc `OutboxProducer` writing NDJSON to disk. This package consolidates that:

- One `Producer` interface; three transports — InMemory, Outbox (file), Kafka (kafkajs)
- One `Consumer` interface; one transport (Kafka). The Outbox file is read-back via `OutboxProducer.readAll(topic)` for tests/replays.
- A `makeProducer()` factory that picks the right transport from env vars

## Quick start

```ts
import { makeProducer } from '@apex-ews/event-bus';

const producer = makeProducer({ clientId: 'apex-alert-producer' });

await producer.publish({
  topic: 'apex.regulatory.events.v2',
  key: 'cust-1042',                 // hash key for partition routing
  headers: { 'x-trace-id': 'abc' },
  payload: { /* canonical alert envelope */ },
});

await producer.close();
```

## Selecting a transport

| Transport | When | Env |
|---|---|---|
| **Outbox (default)** | Local dev + CI tests + dead-letter sink | `APEX_BUS=outbox` (or unset). Optional `APEX_OUTBOX_DIR=…` |
| **Kafka** | Staging + production. Works with MSK, Confluent Cloud, vanilla Kafka, Redpanda | `APEX_BUS=kafka` + `KAFKA_BROKERS=h1:9092,h2:9092`; optional `KAFKA_CLIENT_ID`, `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`, `KAFKA_SASL_MECHANISM` (default `scram-sha-512`), `KAFKA_SSL=1` |
| **InMemory** | Unit tests | `APEX_BUS=memory`. Or import `InMemoryEventBus` directly. |

## Local Kafka via Redpanda

Single-node Kafka-compatible broker, runs in <2s:

```bash
docker compose -f services/event-bus/docker-compose.yml up -d
# Console: http://localhost:8089
# Brokers: localhost:19092
```

Then any service:

```bash
APEX_BUS=kafka KAFKA_BROKERS=localhost:19092 npm run dev
```

Tear down: `docker compose -f services/event-bus/docker-compose.yml down -v`.

## Consumer side

```ts
import { KafkaConsumerAdapter } from '@apex-ews/event-bus';

const consumer = new KafkaConsumerAdapter({
  brokers: ['localhost:19092'],
  clientId: 'apex-collection-adapter',
  groupId: 'collection-adapter',
});

await consumer.subscribe<CaseEvent>(
  ['apex.case.events.v1'],
  async (m) => {
    // m.payload is typed CaseEvent
    await routeToCollection(m.payload);
  },
);
```

## Topics in this prototype

Schemas live at [`infra/schema-registry/`](../../infra/schema-registry/) with BACKWARD-compat CI:

- `apex.regulatory.events.v2` — alert envelope (severity, customer, rule, indicators_fired)
- `apex.case.events.v1` — case lifecycle (open → assigned → in_action → monitored → closed)
- `apex.cbs.events.v1` — CBS ingest stream
- `apex.indicator.values.v1` — indicator compute results
- `apex.audit.events.v1` — immutable audit log
- `apex.rule.firings.v1` — raw rule firing event

## Migration plan (from old per-service OutboxProducer)

1. Replace `import { OutboxProducer } from './producer'` with `import { makeProducer } from '@apex-ews/event-bus'`
2. Replace constructor wiring with `const producer = makeProducer({ clientId: 'apex-<svc>' })`
3. Replace `producer.emit(topic, event)` calls with `producer.publish({ topic, payload: event })`
4. Tests: inject `new InMemoryEventBus()` instead of `OutboxProducer` — assert against `bus.published`

The `regulatory-svc/alerts` service has been migrated as the reference implementation — see [services/regulatory-svc/alerts/src/producer.ts](../regulatory-svc/alerts/src/producer.ts).

## Tests

```bash
npm test    # 16 tests across InMemory + Outbox + factory
```

Kafka integration tests are not in the default suite — they require a running broker. Run them manually after `docker compose up`:

```bash
APEX_BUS=kafka KAFKA_BROKERS=localhost:19092 npm test -- kafka.integration
```
