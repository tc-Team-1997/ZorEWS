// services/bff/src/notifications/bus.ts
//
// In-process pub/sub bus. Lives for the lifetime of the BFF process; SSE
// subscribers register here, and any code path (route handler, scheduled
// job, etc.) can publish via `bus.publish(...)`.
//
// Single-process scope is fine for the prototype. In a multi-replica
// deployment, swap this for a Redis pub/sub adapter — same Subscriber
// interface, same `bus.publish()` call site.

import { randomUUID } from 'node:crypto';
import type { Notification } from './types';

export type Subscriber = (n: Notification) => void;

export class NotificationBus {
  private readonly subs = new Set<Subscriber>();
  /** Last N notifications kept for new SSE clients to backfill. */
  readonly recent: Notification[] = [];
  private readonly cap: number;

  constructor(cap = 50) {
    this.cap = cap;
  }

  publish(input: Omit<Notification, 'id' | 'ts'> & { id?: string; ts?: string }): Notification {
    const n: Notification = {
      id: input.id ?? randomUUID(),
      ts: input.ts ?? new Date().toISOString(),
      level: input.level,
      title: input.title,
      body: input.body,
      href: input.href,
      type: input.type,
      meta: input.meta,
    };
    this.recent.push(n);
    if (this.recent.length > this.cap) this.recent.shift();
    for (const sub of this.subs) {
      try {
        sub(n);
      } catch {
        // Subscriber error must not poison the publish — at-most-once delivery
        // per subscriber on failure. SSE handler swallows here too.
      }
    }
    return n;
  }

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  /** Subscriber count — surfaced via the publish endpoint for diagnostics. */
  size(): number {
    return this.subs.size;
  }

  /** Test-only — clears subscribers + history. */
  reset(): void {
    this.subs.clear();
    this.recent.length = 0;
  }
}

/** Module-level singleton — same bus shared by all routes in this process. */
export const defaultBus = new NotificationBus();
