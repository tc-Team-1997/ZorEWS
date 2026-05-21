// services/regulatory-svc/indicators/src/kafka_producer.ts
//
// T2.12.2 — Indicator-values Kafka producer + streaming dispatch.
//
// Closes the upstream-producer half of T2.12 ("Real-time alert path").
// When the indicator engine computes a new value, the producer:
//   1. Validates against the apex.indicator.values.v1 schema-registry entry.
//   2. Emits to topic `apex.indicator.values` (or OutboxProducer for dev).
//   3. POSTs the event to the BFF /v1/streaming/indicator-events route
//      so the T2.12.1 latency telemetry records ingest + processing ms.
//   4. On dispatch failure, writes to the DLQ outbox for replay.
//
// Mirrors the alerts producer pattern (services/regulatory-svc/alerts/
// src/producer.ts) — pluggable interface + Outbox/Kafka/Stub impls +
// makeIndicatorProducer() env-gated factory.
//
// The schema-registry entry for `apex.indicator.values.v1` already
// exists at infra/schema-registry/ — verified shape matches.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// ─── Canonical envelope ──────────────────────────────────────────────

export type IndicatorFamily = 'financial' | 'behavioural' | 'transaction' | 'credit' | 'fraud';

export type IndicatorSeverityBucket = 'green' | 'amber' | 'red';

/** Shape of one indicator-value event — matches
 *  infra/schema-registry/apex.indicator.values.v1.json. */
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
  severity_bucket?: IndicatorSeverityBucket;
  family: IndicatorFamily;
  tenant_id?: string;
  metadata?: Record<string, unknown>;
}

/** Lightweight input shape callers can build without filling boilerplate.
 *  The producer adds value_id + computed_at + family defaults if missing. */
export interface IndicatorValueInput {
  indicator_id: string;
  customer_id: string;
  value: number;
  severity_weight: number;
  family: IndicatorFamily;
  tenant_id?: string;
  loan_id?: string;
  indicator_version?: string;
  window?: string;
  severity_bucket?: IndicatorSeverityBucket;
  computed_at?: string;
  value_id?: string;
  metadata?: Record<string, unknown>;
}

// ─── Producer interface ──────────────────────────────────────────────

export interface IndicatorProducer {
  emit(event: IndicatorValueEvent): Promise<DispatchReceipt>;
}

export interface DispatchReceipt {
  value_id: string;
  topic: string;
  emitted_at: string;
  /** Latency telemetry status — best-effort POST to the BFF. */
  bff_telemetry: 'ok' | 'skipped' | 'failed';
}

/** Validation against the canonical schema. Throws on shape errors. */
export function validateIndicatorValue(input: IndicatorValueInput): IndicatorValueEvent {
  if (!input || typeof input !== 'object') {
    throw new IndicatorProducerError('invalid_input', 'event must be an object');
  }
  if (typeof input.indicator_id !== 'string' || input.indicator_id.length === 0) {
    throw new IndicatorProducerError('invalid_input', 'indicator_id required');
  }
  if (typeof input.customer_id !== 'string' || input.customer_id.length === 0) {
    throw new IndicatorProducerError('invalid_input', 'customer_id required');
  }
  if (typeof input.value !== 'number' || !Number.isFinite(input.value)) {
    throw new IndicatorProducerError('invalid_value', 'value must be a finite number');
  }
  if (typeof input.severity_weight !== 'number' || !Number.isFinite(input.severity_weight)) {
    throw new IndicatorProducerError('invalid_input', 'severity_weight must be finite');
  }
  if (input.severity_weight < 0 || input.severity_weight > 1) {
    throw new IndicatorProducerError('invalid_input', 'severity_weight must be in [0, 1]');
  }
  if (!['financial', 'behavioural', 'transaction', 'credit', 'fraud'].includes(input.family)) {
    throw new IndicatorProducerError('invalid_family', `family must be financial|behavioural|transaction|credit|fraud`);
  }

  const computed_at = input.computed_at ?? new Date().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(computed_at)) {
    throw new IndicatorProducerError('invalid_input', 'computed_at must be ISO-8601');
  }

  return {
    value_id: input.value_id ?? randomUUID(),
    indicator_id: input.indicator_id,
    indicator_version: input.indicator_version,
    customer_id: input.customer_id,
    loan_id: input.loan_id ?? null,
    computed_at,
    window: input.window,
    value: input.value,
    severity_weight: input.severity_weight,
    severity_bucket: input.severity_bucket,
    family: input.family,
    tenant_id: input.tenant_id,
    metadata: input.metadata,
  };
}

// ─── Error ───────────────────────────────────────────────────────────

export class IndicatorProducerError extends Error {
  override name = 'IndicatorProducerError';
  constructor(
    public code:
      | 'invalid_input'
      | 'invalid_value'
      | 'invalid_family'
      | 'emit_failed'
      | 'dlq_failed',
    message: string,
  ) {
    super(message);
  }
}

// ─── OutboxProducer (dev default) ────────────────────────────────────

const DEFAULT_TOPIC = 'apex.indicator.values';

export class OutboxIndicatorProducer implements IndicatorProducer {
  constructor(
    private readonly outboxDir: string,
    private readonly bffTelemetry?: BffTelemetryClient,
  ) {
    fs.mkdirSync(outboxDir, { recursive: true });
  }

  async emit(event: IndicatorValueEvent): Promise<DispatchReceipt> {
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(this.outboxDir, `${DEFAULT_TOPIC}-${day}.ndjson`);
    fs.appendFileSync(file, JSON.stringify(event) + '\n', { encoding: 'utf8' });

    let bff_telemetry: DispatchReceipt['bff_telemetry'] = 'skipped';
    if (this.bffTelemetry) {
      try {
        await this.bffTelemetry.record(event);
        bff_telemetry = 'ok';
      } catch {
        bff_telemetry = 'failed';
      }
    }

    return {
      value_id: event.value_id,
      topic: DEFAULT_TOPIC,
      emitted_at: new Date().toISOString(),
      bff_telemetry,
    };
  }

  readAll(): IndicatorValueEvent[] {
    if (!fs.existsSync(this.outboxDir)) return [];
    const out: IndicatorValueEvent[] = [];
    for (const f of fs.readdirSync(this.outboxDir)) {
      if (!f.startsWith(`${DEFAULT_TOPIC}-`) || !f.endsWith('.ndjson')) continue;
      const txt = fs.readFileSync(path.join(this.outboxDir, f), 'utf8');
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        out.push(JSON.parse(line) as IndicatorValueEvent);
      }
    }
    return out;
  }
}

// ─── KafkaProducer (production) ──────────────────────────────────────
//
// Lazy import of @apex-ews/event-bus to avoid forcing kafkajs into the
// dev path. Production wires this via makeIndicatorProducer() below.

export class KafkaIndicatorProducer implements IndicatorProducer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private inner: any | null = null;
  private dlq: OutboxIndicatorProducer | null = null;

  constructor(
    private opts: { brokers: string[]; clientId: string; ssl?: boolean; dlqDir?: string },
    private bffTelemetry?: BffTelemetryClient,
  ) {
    if (opts.dlqDir) {
      this.dlq = new OutboxIndicatorProducer(opts.dlqDir);
    }
  }

  private async ensureInner() {
    if (this.inner) return this.inner;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const eb = require('../../../event-bus/dist/src/kafka') as typeof import('../../../event-bus/dist/src/kafka');
    this.inner = new eb.KafkaProducer({
      brokers: this.opts.brokers,
      clientId: this.opts.clientId,
      ssl: this.opts.ssl ?? false,
    });
    return this.inner;
  }

  async emit(event: IndicatorValueEvent): Promise<DispatchReceipt> {
    const inner = await this.ensureInner();
    let bff_telemetry: DispatchReceipt['bff_telemetry'] = 'skipped';

    try {
      await inner.publish({
        topic: DEFAULT_TOPIC,
        key: event.customer_id,
        payload: event,
      });
    } catch (err) {
      // Dispatch failure → DLQ for replay.
      if (this.dlq) {
        try {
          await this.dlq.emit(event);
        } catch {
          throw new IndicatorProducerError(
            'dlq_failed',
            `kafka emit failed AND dlq write failed: ${(err as Error).message}`,
          );
        }
      }
      throw new IndicatorProducerError('emit_failed', (err as Error).message);
    }

    if (this.bffTelemetry) {
      try {
        await this.bffTelemetry.record(event);
        bff_telemetry = 'ok';
      } catch {
        bff_telemetry = 'failed';
      }
    }

    return {
      value_id: event.value_id,
      topic: DEFAULT_TOPIC,
      emitted_at: new Date().toISOString(),
      bff_telemetry,
    };
  }
}

// ─── BFF telemetry client ────────────────────────────────────────────
//
// Calls the T2.12.1 latency endpoint after every dispatch. Pure
// fetch-based; failure is non-blocking (caller's emit() succeeds even
// if telemetry POST fails) — the DispatchReceipt records the status.

export interface BffTelemetryClient {
  record(event: IndicatorValueEvent): Promise<void>;
}

export class HttpBffTelemetryClient implements BffTelemetryClient {
  constructor(
    private opts: { baseUrl: string; tenantId: string; timeoutMs?: number; apiKey?: string },
  ) {}

  async record(event: IndicatorValueEvent): Promise<void> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs ?? 2_000);
    try {
      const res = await fetch(`${this.opts.baseUrl}/v1/streaming/indicator-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': event.tenant_id ?? this.opts.tenantId,
          'X-Channel': 'INTERNAL',
          'X-APEX-USER': 'system:indicator-producer',
          ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          indicator_id: event.indicator_id,
          customer_id: event.customer_id,
          value: event.value,
          observed_at: event.computed_at,
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        throw new Error(`BFF telemetry POST failed: ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────

/** Env-gated factory. KAFKA_BROKERS set → KafkaIndicatorProducer;
 *  unset → OutboxIndicatorProducer. BFF_TELEMETRY_URL set →
 *  HttpBffTelemetryClient wired into both impls. */
export function makeIndicatorProducer(
  env: NodeJS.ProcessEnv = process.env,
): IndicatorProducer {
  const tel =
    env.BFF_TELEMETRY_URL && env.BFF_TELEMETRY_TENANT
      ? new HttpBffTelemetryClient({
          baseUrl: env.BFF_TELEMETRY_URL,
          tenantId: env.BFF_TELEMETRY_TENANT,
          apiKey: env.BFF_TELEMETRY_API_KEY,
        })
      : undefined;

  if (env.KAFKA_BROKERS) {
    return new KafkaIndicatorProducer(
      {
        brokers: env.KAFKA_BROKERS.split(',').map((s) => s.trim()),
        clientId: env.KAFKA_CLIENT_ID ?? 'apex-indicators',
        ssl: env.KAFKA_SSL === 'true',
        dlqDir: env.KAFKA_DLQ_DIR ?? '.dlq/indicator-values',
      },
      tel,
    );
  }

  return new OutboxIndicatorProducer(env.INDICATOR_OUTBOX_DIR ?? '.outbox/indicator-values', tel);
}
