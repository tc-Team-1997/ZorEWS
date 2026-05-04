// services/regulatory-svc/alerts/src/producer.ts
//
// Pluggable producer interface for the canonical alert envelope.
//
// Three concrete impls:
//   - OutboxProducer  — local NDJSON; default for dev + tests
//   - KafkaProducer   — kafkajs-backed (delegates to @apex-ews/event-bus)
//   - StubKafkaProducer — kept for backwards-compat callers; will be removed
//
// `makeProducer()` reads env vars to pick the right one.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  KafkaProducer as EventBusKafkaProducer,
  type KafkaConfig,
} from '../../../event-bus/dist/src/kafka';
import type { CanonicalAlert } from './types';

export interface Producer {
  /** Emit a single alert event to the topic. */
  emit(topic: string, event: CanonicalAlert): Promise<void>;
}

/**
 * Outbox producer — writes NDJSON to disk. Used in dev + tests + as the
 * dead-letter sink while the real Kafka producer is offline.
 */
export class OutboxProducer implements Producer {
  constructor(private readonly outboxDir: string) {
    fs.mkdirSync(outboxDir, { recursive: true });
  }

  async emit(topic: string, event: CanonicalAlert): Promise<void> {
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const file = path.join(this.outboxDir, `${topic}-${day}.ndjson`);
    fs.appendFileSync(file, JSON.stringify(event) + '\n', { encoding: 'utf8' });
  }

  /** Read-back helper (tests only). */
  readAll(topic: string): CanonicalAlert[] {
    if (!fs.existsSync(this.outboxDir)) return [];
    const out: CanonicalAlert[] = [];
    for (const f of fs.readdirSync(this.outboxDir)) {
      if (!f.startsWith(`${topic}-`) || !f.endsWith('.ndjson')) continue;
      const txt = fs.readFileSync(path.join(this.outboxDir, f), 'utf8');
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        out.push(JSON.parse(line) as CanonicalAlert);
      }
    }
    return out;
  }
}

/**
 * KafkaProducer — thin wrapper over @apex-ews/event-bus' kafkajs adapter.
 * Maps the alerts service's `emit(topic, event)` interface onto the
 * event-bus `publish({ topic, payload })` shape.
 *
 * Used in production (set KAFKA_BROKERS); local dev + tests still get
 * OutboxProducer via makeProducer() unless explicitly overridden.
 */
export class KafkaProducer implements Producer {
  private readonly inner: EventBusKafkaProducer;

  constructor(opts: { brokers: string[]; clientId: string; ssl?: boolean }) {
    const cfg: KafkaConfig = {
      brokers: opts.brokers,
      clientId: opts.clientId,
      ssl: opts.ssl ?? false,
    };
    this.inner = new EventBusKafkaProducer(cfg);
  }

  async emit(topic: string, event: CanonicalAlert): Promise<void> {
    await this.inner.publish({
      topic,
      key: event.customer_id, // hash by customer for ordered partition writes
      payload: event,
    });
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

/** Factory: Kafka if KAFKA_BROKERS is set, else outbox. */
export function makeProducer(env: NodeJS.ProcessEnv = process.env): Producer {
  if (env.KAFKA_BROKERS) {
    try {
      return new KafkaProducer({
        brokers: env.KAFKA_BROKERS.split(',').map((s) => s.trim()).filter(Boolean),
        clientId: env.KAFKA_CLIENT_ID ?? 'apex-alert-producer',
        ssl: env.KAFKA_SSL === '1' || env.KAFKA_SSL === 'true',
      });
    } catch {
      // Construction shouldn't throw with valid env, but if it does we
      // fall back to outbox so `npm start` keeps working in dev.
    }
  }
  const outboxDir =
    env.APEX_ALERT_OUTBOX_DIR ?? path.resolve(__dirname, '..', '.outbox');
  return new OutboxProducer(outboxDir);
}
