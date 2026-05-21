// services/regulatory-svc/rules/src/kafka_consumer.ts
//
// T2.12 — Indicator-values Kafka consumer that drives real-time rule
// evaluation. Closes the DOWNSTREAM half of T2.12 (the upstream
// producer is T2.12.2 at services/regulatory-svc/indicators/src/
// kafka_producer.ts; T2.12.1 is the BFF latency telemetry primitive).
//
// Flow:
//   apex.indicator.values  →  IndicatorValueConsumer.subscribe(handler)
//   handler(event)         →  RuleEvaluator.fire(event)
//   RuleEvaluator.fire     →  emits matched rules to alert producer
//
// Per EWS.docx §3.5 + docs/slos.md tier-1: p95 indicator-observed-at →
// alert-created-at < 60s. The consumer is sequential (single in-flight
// event per partition) so order-sensitive rules stay deterministic.
// Multi-partition parallelism comes from kafkajs's per-partition
// consumer-group semantics.
//
// External blocker: a running MSK cluster + KAFKA_BROKERS env var
// pointing at it. The contract is testable today against the
// OutboxIndicatorValueConsumer dev-mode tail of the T2.12.2 outbox.
//
// Mirror of indicators/kafka_producer.ts pattern — pluggable interface
// + Outbox/Kafka impls + makeIndicatorValueConsumer() env-gated factory.

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Canonical event shape ───────────────────────────────────────────

/** Re-declared (instead of imported from indicators/) to keep rules-svc
 *  free of cross-service compile-time deps. Shape MUST stay aligned
 *  with infra/schema-registry/apex.indicator.values.v1.json — the
 *  schema-compat CI gate enforces. */
export interface IndicatorValueEvent {
  value_id: string;
  indicator_id: string;
  indicator_version?: string;
  customer_id: string;
  loan_id?: string | null;
  computed_at: string;
  window?: string;
  value: number;
  severity_weight: number;
  severity_bucket?: 'green' | 'amber' | 'red';
  family: 'financial' | 'behavioural' | 'transaction' | 'credit' | 'fraud';
  tenant_id?: string;
  metadata?: Record<string, unknown>;
}

/** Rule-evaluator handler the consumer invokes for every event.
 *  Returns the number of rules that fired (or 0 / null when none).
 *  Errors thrown by the handler are caught by the consumer + logged
 *  so a poison event can't block the topic. */
export type IndicatorValueHandler = (
  event: IndicatorValueEvent,
) => Promise<number | null> | number | null;

// ─── Consumer interface ──────────────────────────────────────────────

export interface IndicatorValueConsumer {
  /** Start consuming. Returns a stop-handle. The handler is invoked
   *  sequentially per partition; throwing handler errors are caught. */
  subscribe(handler: IndicatorValueHandler): Promise<ConsumerHandle>;
}

export interface ConsumerHandle {
  /** Graceful shutdown — finishes the in-flight event then closes. */
  stop(): Promise<void>;
}

export interface ConsumerStats {
  total_received: number;
  total_handled_ok: number;
  total_handler_errors: number;
  total_invalid_events: number;
  last_event_at: string | null;
}

// ─── Validation ──────────────────────────────────────────────────────

const VALID_FAMILIES = new Set([
  'financial',
  'behavioural',
  'transaction',
  'credit',
  'fraud',
]);

/** Validates an event shape. Returns null on success or an error code on
 *  failure. Defensive — schema-registry rejects upstream, but a typo in
 *  the dev outbox can still get here. */
export function validateIndicatorValueEvent(
  evt: unknown,
): 'invalid_input' | 'invalid_value' | 'invalid_family' | null {
  if (!evt || typeof evt !== 'object') return 'invalid_input';
  const e = evt as Partial<IndicatorValueEvent>;
  if (!e.value_id || typeof e.value_id !== 'string') return 'invalid_input';
  if (!e.indicator_id || typeof e.indicator_id !== 'string') return 'invalid_input';
  if (!e.customer_id || typeof e.customer_id !== 'string') return 'invalid_input';
  if (!e.computed_at || typeof e.computed_at !== 'string') return 'invalid_input';
  if (typeof e.value !== 'number' || !Number.isFinite(e.value)) return 'invalid_value';
  if (typeof e.severity_weight !== 'number' || !Number.isFinite(e.severity_weight)) {
    return 'invalid_value';
  }
  if (e.severity_weight < 0 || e.severity_weight > 1) return 'invalid_value';
  if (typeof e.family !== 'string' || !VALID_FAMILIES.has(e.family)) {
    return 'invalid_family';
  }
  return null;
}

// ─── OutboxIndicatorValueConsumer (dev mode) ─────────────────────────

/** Dev-mode consumer that tails the day-partitioned NDJSON outbox the
 *  T2.12.2 OutboxIndicatorProducer writes. No Kafka required; replays
 *  every file in dir on each `subscribe()` call, then exits.
 *  Production callers swap in `KafkaIndicatorValueConsumer`. */
export class OutboxIndicatorValueConsumer implements IndicatorValueConsumer {
  private stats: ConsumerStats = {
    total_received: 0,
    total_handled_ok: 0,
    total_handler_errors: 0,
    total_invalid_events: 0,
    last_event_at: null,
  };

  constructor(private readonly outboxDir: string) {}

  /** Drains every NDJSON file in the dir, oldest filename first, invoking
   *  the handler per line. Stops when the dir is exhausted. */
  async subscribe(handler: IndicatorValueHandler): Promise<ConsumerHandle> {
    let stopped = false;
    const drain = async () => {
      if (!fs.existsSync(this.outboxDir)) return;
      const files = fs.readdirSync(this.outboxDir).filter((f) => f.endsWith('.ndjson')).sort();
      for (const file of files) {
        if (stopped) return;
        const full = path.join(this.outboxDir, file);
        let raw: string;
        try {
          raw = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        const lines = raw.split('\n').filter((l) => l.length > 0);
        for (const line of lines) {
          if (stopped) return;
          let evt: IndicatorValueEvent;
          try {
            evt = JSON.parse(line);
          } catch {
            this.stats.total_invalid_events++;
            continue;
          }
          this.stats.total_received++;
          const valErr = validateIndicatorValueEvent(evt);
          if (valErr !== null) {
            this.stats.total_invalid_events++;
            continue;
          }
          this.stats.last_event_at = evt.computed_at;
          try {
            await handler(evt);
            this.stats.total_handled_ok++;
          } catch {
            this.stats.total_handler_errors++;
          }
        }
      }
    };
    // Kick off drain non-blocking so caller gets the handle promptly.
    drain().catch(() => {
      /* swallow; stats already updated */
    });
    return {
      stop: async () => {
        stopped = true;
      },
    };
  }

  /** Read-only stats. Useful for tests + ops health endpoints. */
  getStats(): ConsumerStats {
    return { ...this.stats };
  }
}

// ─── KafkaIndicatorValueConsumer (production) ────────────────────────

export interface KafkaIndicatorValueConsumerOptions {
  /** kafkajs Consumer instance (lazy-imported by the caller — keeps
   *  rules-svc free of @apex-ews/event-bus compile-time dep). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  consumer: any;
  topic: string;
  /** Optional callback after every commit. Useful for ops metrics. */
  onCommit?: (offset: string) => void;
}

/** Production consumer that subscribes to the MSK topic via the
 *  @apex-ews/event-bus consumer wrapper. The caller is responsible
 *  for the kafkajs construction + connect() — this class only handles
 *  message-loop + handler-invocation + error containment.
 *
 *  Swap point: when MSK cluster is live, the bootstrap wires:
 *      const { Kafka } = require('@apex-ews/event-bus');
 *      const kafka = new Kafka({ clientId: 'rules-svc', brokers: [...] });
 *      const consumer = kafka.consumer({ groupId: 'rules-svc-prod' });
 *      await consumer.connect();
 *      await consumer.subscribe({ topic: 'apex.indicator.values' });
 *      const c = new KafkaIndicatorValueConsumer({ consumer, topic: ... });
 *      await c.subscribe(ruleEvaluator);
 *
 *  Year-2 Theme D blocker — MSK cluster provisioning + KAFKA_BROKERS
 *  env wiring + Helm config on the rules-svc Deployment. */
export class KafkaIndicatorValueConsumer implements IndicatorValueConsumer {
  private stats: ConsumerStats = {
    total_received: 0,
    total_handled_ok: 0,
    total_handler_errors: 0,
    total_invalid_events: 0,
    last_event_at: null,
  };

  constructor(private readonly opts: KafkaIndicatorValueConsumerOptions) {}

  async subscribe(handler: IndicatorValueHandler): Promise<ConsumerHandle> {
    const { consumer } = this.opts;
    let running = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await consumer.run({
      autoCommit: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eachMessage: async ({ message }: any) => {
        if (!running) return;
        const raw = message?.value ? message.value.toString('utf8') : '';
        let evt: IndicatorValueEvent;
        try {
          evt = JSON.parse(raw);
        } catch {
          this.stats.total_invalid_events++;
          return;
        }
        this.stats.total_received++;
        const valErr = validateIndicatorValueEvent(evt);
        if (valErr !== null) {
          this.stats.total_invalid_events++;
          return;
        }
        this.stats.last_event_at = evt.computed_at;
        try {
          await handler(evt);
          this.stats.total_handled_ok++;
        } catch {
          this.stats.total_handler_errors++;
        }
        if (this.opts.onCommit && message?.offset) {
          this.opts.onCommit(String(message.offset));
        }
      },
    });
    return {
      stop: async () => {
        running = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (consumer as any).disconnect?.();
      },
    };
  }

  getStats(): ConsumerStats {
    return { ...this.stats };
  }
}

// ─── Env-gated factory ───────────────────────────────────────────────

export function makeIndicatorValueConsumer(
  env: Record<string, string | undefined> = process.env,
): IndicatorValueConsumer {
  if (env.KAFKA_BROKERS) {
    // Production path — caller passes the constructed consumer in.
    // The factory cannot construct kafkajs itself without @apex-ews/
    // event-bus, which is a workspace dep not always installed in
    // rules-svc dev mode. Throw a useful error instead of silent fail.
    throw new Error(
      'KAFKA_BROKERS is set but makeIndicatorValueConsumer cannot construct ' +
        'kafkajs directly. Wire bootstrap to instantiate KafkaIndicatorValueConsumer ' +
        'with a connected consumer from @apex-ews/event-bus. See class docstring.',
    );
  }
  const outboxDir =
    env.INDICATOR_OUTBOX_DIR ??
    path.resolve(process.cwd(), '../indicators/.outbox/indicator-values');
  return new OutboxIndicatorValueConsumer(outboxDir);
}
