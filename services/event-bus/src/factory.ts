// services/event-bus/src/factory.ts
//
// Env-driven Producer factory. Lets callers swap transports without
// touching their service code:
//
//   APEX_BUS=outbox  + APEX_OUTBOX_DIR=…       → file-backed (default)
//   APEX_BUS=kafka   + KAFKA_BROKERS=h1,h2 …   → Kafka (kafkajs)
//   APEX_BUS=memory                            → in-memory (tests)

import * as path from 'node:path';
import { InMemoryEventBus } from './memory';
import { OutboxProducer } from './outbox';
import { KafkaProducer, type KafkaConfig } from './kafka';
import type { Producer } from './types';

export interface FactoryEnv {
  APEX_BUS?: string;
  APEX_OUTBOX_DIR?: string;
  KAFKA_BROKERS?: string;
  KAFKA_CLIENT_ID?: string;
  KAFKA_SASL_USERNAME?: string;
  KAFKA_SASL_PASSWORD?: string;
  KAFKA_SASL_MECHANISM?: string;
  KAFKA_SSL?: string;
}

function kafkaConfigFromEnv(env: FactoryEnv, clientIdFallback: string): KafkaConfig {
  const brokers = (env.KAFKA_BROKERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (brokers.length === 0) {
    throw new Error('KAFKA_BROKERS is required when APEX_BUS=kafka');
  }
  const cfg: KafkaConfig = {
    brokers,
    clientId: env.KAFKA_CLIENT_ID ?? clientIdFallback,
    ssl: env.KAFKA_SSL === '1' || env.KAFKA_SSL === 'true',
  };
  if (env.KAFKA_SASL_USERNAME && env.KAFKA_SASL_PASSWORD) {
    const mechanism = (env.KAFKA_SASL_MECHANISM ?? 'scram-sha-512') as
      | 'plain'
      | 'scram-sha-256'
      | 'scram-sha-512';
    cfg.sasl = {
      mechanism,
      username: env.KAFKA_SASL_USERNAME,
      password: env.KAFKA_SASL_PASSWORD,
    };
  }
  return cfg;
}

export interface MakeProducerOptions {
  /** Used as the kafka client-id and as the file path for outbox. */
  clientId: string;
  env?: FactoryEnv;
}

export function makeProducer(opts: MakeProducerOptions): Producer {
  const env = opts.env ?? (process.env as FactoryEnv);
  const choice = (env.APEX_BUS ?? 'outbox').toLowerCase();
  if (choice === 'memory') return new InMemoryEventBus();
  if (choice === 'kafka') return new KafkaProducer(kafkaConfigFromEnv(env, opts.clientId));
  // default — outbox
  const dir = env.APEX_OUTBOX_DIR ?? path.resolve(process.cwd(), '.outbox', opts.clientId);
  return new OutboxProducer(dir);
}
