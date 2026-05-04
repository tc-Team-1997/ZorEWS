// services/event-bus/src/index.ts
//
// Public surface. Importers should always go through this barrel so the
// internal layout can change without rippling through callers.

export type {
  BusMessage,
  Consumer,
  ConsumerHandler,
  Producer,
} from './types';
export { InMemoryEventBus } from './memory';
export { OutboxProducer } from './outbox';
export { KafkaProducer, KafkaConsumerAdapter, type KafkaConfig } from './kafka';
export { makeProducer, type FactoryEnv, type MakeProducerOptions } from './factory';
