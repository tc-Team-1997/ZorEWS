// services/bff/src/source.ts
//
// AlertSource — pluggable canonical-event source. Two implementations:
//
//   - OutboxSource: reads NDJSON from regulatory-svc/alerts/.outbox (dev/tests).
//   - StaticSource: in-memory list (tests).
//
// In production agent-integration replaces OutboxSource with a Kafka consumer
// keyed off the apex.regulatory.events topic; the interface is identical so
// the swap is a one-line factory change.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CanonicalAlert } from './types';

export interface AlertSource {
  read(): CanonicalAlert[];
}

/** Read every NDJSON line in `outboxDir` whose name starts with `topic-`. */
export class OutboxSource implements AlertSource {
  constructor(
    private readonly outboxDir: string,
    private readonly topic = 'apex.regulatory.events',
  ) {}

  read(): CanonicalAlert[] {
    if (!fs.existsSync(this.outboxDir)) return [];
    const out: CanonicalAlert[] = [];
    for (const f of fs.readdirSync(this.outboxDir).sort()) {
      if (!f.startsWith(`${this.topic}-`) || !f.endsWith('.ndjson')) continue;
      const txt = fs.readFileSync(path.join(this.outboxDir, f), 'utf8');
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as CanonicalAlert);
        } catch {
          // Skip corrupt lines; the outbox is append-only and best-effort.
        }
      }
    }
    return out;
  }
}

/** Test helper. */
export class StaticSource implements AlertSource {
  constructor(private readonly events: CanonicalAlert[]) {}
  read(): CanonicalAlert[] {
    return [...this.events];
  }
}

export function makeAlertSource(env: NodeJS.ProcessEnv = process.env): AlertSource {
  // Default to the alerts producer's outbox dir, two services over.
  const outboxDir =
    env.APEX_ALERT_OUTBOX_DIR ??
    path.resolve(__dirname, '..', '..', 'regulatory-svc', 'alerts', '.outbox');
  return new OutboxSource(outboxDir);
}
