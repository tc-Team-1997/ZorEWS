// services/collection-adapter/src/sink.ts
//
// CollectionSink — writes one apex.collection.routes event per routed
// case. NDJSON outbox in the prototype; production swaps in an HTTP/Kafka
// adapter to the bank's Collection module.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CollectionRouteEvent } from './types';

export interface CollectionSink {
  emit(event: CollectionRouteEvent): Promise<void>;
  /** Has the given case_id ever been routed? Idempotency check. */
  hasRouted(case_id: string): boolean;
}

export class OutboxCollectionSink implements CollectionSink {
  private readonly seen = new Set<string>();
  private readonly topic = 'apex.collection.routes';

  constructor(private readonly outboxDir: string) {
    fs.mkdirSync(outboxDir, { recursive: true });
    this.replay();
  }

  private replay(): void {
    if (!fs.existsSync(this.outboxDir)) return;
    for (const f of fs.readdirSync(this.outboxDir).sort()) {
      if (!f.startsWith(`${this.topic}-`) || !f.endsWith('.ndjson')) continue;
      const txt = fs.readFileSync(path.join(this.outboxDir, f), 'utf8');
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as CollectionRouteEvent;
          this.seen.add(e.case_id);
        } catch {
          // skip
        }
      }
    }
  }

  async emit(event: CollectionRouteEvent): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(this.outboxDir, `${this.topic}-${day}.ndjson`);
    fs.appendFileSync(file, JSON.stringify(event) + '\n', { encoding: 'utf8' });
    this.seen.add(event.case_id);
  }

  hasRouted(case_id: string): boolean {
    return this.seen.has(case_id);
  }

  /** Test helper. */
  readAll(): CollectionRouteEvent[] {
    if (!fs.existsSync(this.outboxDir)) return [];
    const out: CollectionRouteEvent[] = [];
    for (const f of fs.readdirSync(this.outboxDir).sort()) {
      if (!f.startsWith(`${this.topic}-`) || !f.endsWith('.ndjson')) continue;
      const txt = fs.readFileSync(path.join(this.outboxDir, f), 'utf8');
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        out.push(JSON.parse(line) as CollectionRouteEvent);
      }
    }
    return out;
  }
}

export class InMemoryCollectionSink implements CollectionSink {
  public readonly events: CollectionRouteEvent[] = [];
  hasRouted(case_id: string): boolean {
    return this.events.some((e) => e.case_id === case_id);
  }
  async emit(event: CollectionRouteEvent): Promise<void> {
    this.events.push(event);
  }
}

export function makeCollectionSink(env: NodeJS.ProcessEnv = process.env): OutboxCollectionSink {
  const outboxDir =
    env.APEX_COLLECTION_OUTBOX_DIR ?? path.resolve(__dirname, '..', '.outbox');
  return new OutboxCollectionSink(outboxDir);
}
