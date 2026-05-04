// services/event-bus/src/memory.ts
//
// In-memory event-bus — same Producer + Consumer interface, no IO.
// Used by unit tests so the suite stays deterministic and fast even
// when the real adapters depend on filesystems or network sockets.

import type { BusMessage, Consumer, ConsumerHandler, Producer } from './types';

interface Subscription {
  topics: Set<string>;
  handler: ConsumerHandler<unknown>;
}

export class InMemoryEventBus implements Producer, Consumer {
  /** All published messages — useful for assertions. */
  readonly published: BusMessage[] = [];
  private readonly subs: Subscription[] = [];

  async publish<T>(message: BusMessage<T>): Promise<void> {
    this.published.push(message as BusMessage);
    // Fan out to every matching subscription. Errors don't fail the
    // publish — same as Kafka where the consumer side is decoupled.
    for (const sub of this.subs) {
      if (sub.topics.has(message.topic)) {
        try {
          await sub.handler(message as BusMessage<unknown>);
        } catch {
          /* swallow — at-least-once: producer keeps going */
        }
      }
    }
  }

  async subscribe<T>(topics: string[], handler: ConsumerHandler<T>): Promise<void> {
    this.subs.push({
      topics: new Set(topics),
      handler: handler as ConsumerHandler<unknown>,
    });
  }

  async close(): Promise<void> {
    this.subs.length = 0;
  }

  /** Reset state — handy between tests. */
  reset(): void {
    this.published.length = 0;
    this.subs.length = 0;
  }
}
