// services/event-bus/src/types.ts

/** Generic envelope around any event payload. */
export interface BusMessage<T = unknown> {
  topic: string;
  /** Optional partition key — KafkaProducer uses it for hash routing. */
  key?: string;
  payload: T;
  /** Optional headers (string→string), copied to Kafka headers as-is. */
  headers?: Record<string, string>;
}

export interface Producer {
  /** Publish a single message. Throws on hard failure. */
  publish<T>(message: BusMessage<T>): Promise<void>;
  /** Optional graceful shutdown. */
  close(): Promise<void>;
}

export interface ConsumerHandler<T = unknown> {
  (message: BusMessage<T>): Promise<void> | void;
}

export interface Consumer {
  /**
   * Subscribe to one or more topics. Each delivered message is passed
   * to `handler`. Implementations are at-least-once — handlers must be
   * idempotent.
   */
  subscribe<T>(topics: string[], handler: ConsumerHandler<T>): Promise<void>;
  /** Optional graceful shutdown. */
  close(): Promise<void>;
}
