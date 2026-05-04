// services/event-bus/src/kafka.ts
//
// Kafka Producer + Consumer using kafkajs. Compatible with AWS MSK,
// Confluent Cloud, Redpanda, and any vanilla Apache Kafka 2.4+ broker.
//
// Connection lifecycle:
//   - producer + consumer connect lazily on first publish/subscribe
//   - .close() is graceful (drains in-flight + disconnects)
//
// Tests don't exercise this adapter directly — the in-memory bus
// covers the contract. A smoke test (gated by KAFKA_BROKERS env)
// validates real connectivity when developers run docker-compose.

import { Kafka, type Consumer as KafkaConsumer, type Producer as KafkaJsProducer, type SASLOptions, logLevel } from 'kafkajs';
import type { BusMessage, Consumer, ConsumerHandler, Producer } from './types';

export interface KafkaConfig {
  brokers: string[];
  clientId: string;
  /** Optional SASL/SCRAM credentials (production MSK or Confluent). */
  sasl?: SASLOptions;
  /** Enable TLS — required for MSK + Confluent Cloud. */
  ssl?: boolean;
  /** Consumer group id — defaults to `<clientId>-group`. */
  groupId?: string;
}

function build(cfg: KafkaConfig): Kafka {
  return new Kafka({
    clientId: cfg.clientId,
    brokers: cfg.brokers,
    ssl: cfg.ssl,
    sasl: cfg.sasl,
    logLevel: logLevel.WARN,
  });
}

export class KafkaProducer implements Producer {
  private readonly kafka: Kafka;
  private producer: KafkaJsProducer | null = null;

  constructor(private readonly cfg: KafkaConfig) {
    this.kafka = build(cfg);
  }

  private async ensure(): Promise<KafkaJsProducer> {
    if (this.producer) return this.producer;
    const p = this.kafka.producer({ allowAutoTopicCreation: false });
    await p.connect();
    this.producer = p;
    return p;
  }

  async publish<T>(message: BusMessage<T>): Promise<void> {
    const p = await this.ensure();
    await p.send({
      topic: message.topic,
      messages: [
        {
          key: message.key,
          value: JSON.stringify(message.payload),
          headers: message.headers,
        },
      ],
    });
  }

  async close(): Promise<void> {
    if (this.producer) {
      await this.producer.disconnect();
      this.producer = null;
    }
  }
}

export class KafkaConsumerAdapter implements Consumer {
  private readonly kafka: Kafka;
  private consumer: KafkaConsumer | null = null;

  constructor(private readonly cfg: KafkaConfig) {
    this.kafka = build(cfg);
  }

  async subscribe<T>(topics: string[], handler: ConsumerHandler<T>): Promise<void> {
    const groupId = this.cfg.groupId ?? `${this.cfg.clientId}-group`;
    const c = this.kafka.consumer({ groupId });
    await c.connect();
    for (const t of topics) {
      await c.subscribe({ topic: t, fromBeginning: false });
    }
    this.consumer = c;

    await c.run({
      eachMessage: async ({ topic, message }) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(message.headers ?? {})) {
          headers[k] = v?.toString() ?? '';
        }
        const payload = message.value
          ? (JSON.parse(message.value.toString()) as T)
          : (null as unknown as T);
        const wire: BusMessage<T> = {
          topic,
          key: message.key?.toString(),
          headers,
          payload,
        };
        await handler(wire);
      },
    });
  }

  async close(): Promise<void> {
    if (this.consumer) {
      await this.consumer.disconnect();
      this.consumer = null;
    }
  }
}
