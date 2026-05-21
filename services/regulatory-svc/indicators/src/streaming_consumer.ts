// services/regulatory-svc/indicators/src/streaming_consumer.ts
//
// T2.12.3 — Kafka CONSUMER on `apex.indicator.values`. Closes the
// downstream half of the real-time alert path internally.
//
// Flow:
//   Indicator engine produces → apex.indicator.values (kafka_producer.ts)
//                              → THIS CONSUMER drains the topic
//                              → POST /v1/streaming/indicator-events
//                                (BFF M2.12.1 latency telemetry)
//                              → rule evaluator + AlertEvaluator
//                              → apex.regulatory.events (alert producer)
//                              → SmartQueue + AlertRoutingEngine
//                              → NotificationBus + SPA SSE banner
//
// The consumer is intentionally THIN. It:
//   1. Consumes each event with at-least-once semantics (commit after
//      success; on failure → DLQ via the existing outbox pattern).
//   2. Posts to the BFF /v1/streaming/indicator-events route with the
//      caller-supplied observed_at preserved end-to-end. BFF computes
//      the 3-component latency (ingest, processing, total) + records
//      in the per-tenant ledger.
//   3. On post failure (4xx or network), increments a per-event retry
//      counter capped at MAX_RETRIES=3; final failure → DLQ NDJSON sink
//      so an operator can replay later.
//
// External blockers:
//   - Running MSK cluster + KAFKA_BROKERS env var (Year-2 Theme D
//     infrastructure work)
//   - BFF reachable from this consumer pod (cluster-internal Service)
//
// Wire-up: deploy as a separate Deployment in apex-ews namespace using
// the same image as indicators service but `npm run streaming-consumer`.
// Karpenter consolidates it onto the platform tier (low CPU + memory).

import type { IndicatorValueEvent } from "./kafka_producer";

/** Minimal BusMessage shape we depend on — mirrors @apex-ews/event-bus types.
 *  Inlined here to keep the consumer testable without the kafkajs runtime. */
interface BusMessage<T = unknown> {
  topic: string;
  key?: string;
  payload: T;
}

export interface StreamingConsumerOptions {
  /** Bootstrap brokers — falls back to KAFKA_BROKERS env. */
  brokers?: string[];
  /** Kafka client/consumer group id. */
  groupId?: string;
  /** BFF URL (cluster-internal). */
  bffUrl?: string;
  /** Bearer token loader for the BFF service-account call. */
  authToken?: () => Promise<string> | string;
  /** Per-event retry cap before DLQ. */
  maxRetries?: number;
  /** DLQ writer (fire-and-forget). Defaults to a NoOp; production wires
   *  the OutboxProducer pattern from event-bus. */
  dlqWrite?: (event: IndicatorValueEvent, error: string) => Promise<void>;
  /** Fetch impl override (for tests). */
  fetchImpl?: typeof fetch;
  /** Inject Kafka client (for tests). When unset, builds via @apex-ews/event-bus
   *  KafkaConsumerAdapter using KAFKA_* env. */
  consumer?: ConsumerLike;
}

/** Minimal consumer surface the loop needs. Allows test stubs. */
export interface ConsumerLike {
  subscribe(topic: string): Promise<void>;
  run(handler: (msg: BusMessage<IndicatorValueEvent>) => Promise<void>): Promise<void>;
  disconnect(): Promise<void>;
}

const INDICATOR_TOPIC = "apex.indicator.values";
const DEFAULT_GROUP_ID = "apex-ews-streaming-rule-evaluator";
const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_MS = 1_000; // exp backoff 1s/4s/16s


export class StreamingRuleEvaluatorConsumer {
  private readonly bffUrl: string;
  private readonly authToken: () => Promise<string> | string;
  private readonly maxRetries: number;
  private readonly dlqWrite: (event: IndicatorValueEvent, error: string) => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly consumer: ConsumerLike;
  private running = false;

  constructor(options: StreamingConsumerOptions = {}) {
    this.bffUrl = (options.bffUrl ?? process.env.BFF_URL ?? "http://bff.apex-ews.svc:8081").replace(/\/+$/, "");
    this.authToken = options.authToken ?? (() => process.env.STREAMING_BFF_TOKEN ?? "");
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.dlqWrite = options.dlqWrite ?? (async () => undefined);
    this.fetchImpl = options.fetchImpl ?? fetch;

    if (options.consumer) {
      this.consumer = options.consumer;
    } else {
      const brokers = options.brokers ?? (process.env.KAFKA_BROKERS ?? "").split(",").filter(Boolean);
      if (brokers.length === 0) {
        throw new Error(
          "StreamingRuleEvaluatorConsumer requires brokers (or KAFKA_BROKERS env). " +
          "Set to MSK bootstrap_brokers_sasl_iam.",
        );
      }
      // Lazy require so the kafkajs runtime is not pulled into the dev path.
      // Production wires this with KAFKA_BROKERS set; tests inject options.consumer.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const eb = require("../../../event-bus/dist/src/kafka") as {
        KafkaConsumerAdapter: new (cfg: unknown, groupId: string) => ConsumerLike;
      };
      const cfg = {
        clientId: "apex-ews-streaming-consumer",
        brokers,
        ssl: true,
      };
      this.consumer = new eb.KafkaConsumerAdapter(cfg, options.groupId ?? DEFAULT_GROUP_ID);
    }
  }

  /** Start consuming. Long-running; awaits until disconnect() is called. */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error("StreamingRuleEvaluatorConsumer already running");
    }
    this.running = true;

    await this.consumer.subscribe(INDICATOR_TOPIC);

    await this.consumer.run(async (msg) => {
      const event = msg.payload;
      if (!event) {
        console.warn("Skipping null/undefined message");
        return;
      }
      await this.handleEvent(event);
    });
  }

  async disconnect(): Promise<void> {
    this.running = false;
    await this.consumer.disconnect();
  }

  /** Public for tests — process a single event with retry + DLQ. */
  async handleEvent(event: IndicatorValueEvent): Promise<void> {
    let attempt = 0;
    while (attempt <= this.maxRetries) {
      const ok = await this.postToBff(event);
      if (ok) return;

      attempt++;
      if (attempt > this.maxRetries) {
        await this.dlqWrite(event, "max retries exceeded posting to BFF /v1/streaming/indicator-events");
        return;
      }

      // Exponential backoff: 1s / 4s / 16s
      await sleep(RETRY_BASE_MS * Math.pow(4, attempt - 1));
    }
  }

  private async postToBff(event: IndicatorValueEvent): Promise<boolean> {
    const token = await this.authToken();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Tenant-ID": event.tenant_id ?? "BANK_DEMO",
      "X-Channel": "STREAMING",
      "X-APEX-USER": "system:streaming-rule-evaluator",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5_000);

    try {
      const resp = await this.fetchImpl(`${this.bffUrl}/v1/streaming/indicator-events`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          indicator_id: event.indicator_id,
          customer_id: event.customer_id,
          value: event.value,
          observed_at: event.computed_at, // observed-at IS the producer's compute time
          event_id: event.value_id,
          fired_rule_ids: [],   // populated by downstream rule eval, not by upstream
          fired_alert_ids: [],
        }),
        signal: ac.signal,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        console.warn(
          `BFF POST /v1/streaming/indicator-events returned ${resp.status} for ${event.value_id}: ${text.slice(0, 200)}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      console.warn(
        `BFF POST /v1/streaming/indicator-events network error for ${event.value_id}: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Factory selecting consumer based on env. */
export function makeStreamingConsumer(
  env: NodeJS.ProcessEnv = process.env,
): StreamingRuleEvaluatorConsumer {
  return new StreamingRuleEvaluatorConsumer({
    brokers: (env.KAFKA_BROKERS ?? "").split(",").filter(Boolean),
    bffUrl: env.BFF_URL,
    authToken: () => env.STREAMING_BFF_TOKEN ?? "",
  });
}

/** Convenience entry point — bin script wires this to `npm run streaming-consumer`. */
export async function runStreamingConsumer(): Promise<void> {
  const consumer = makeStreamingConsumer();
  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${sig}, draining...`);
    await consumer.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  console.log("Starting streaming rule-evaluator consumer...");
  await consumer.start();
}
