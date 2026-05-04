// services/event-bus/src/outbox.ts
//
// File-backed Producer — writes one NDJSON line per message into
// `<dir>/<topic>-YYYY-MM-DD.ndjson`. This is the dev/CI default; the
// existing alerts + cases services already follow this pattern, so
// migrating them to event-bus is a one-line factory swap.
//
// Append-only + open-append-close per write so a crash mid-test still
// leaves a valid NDJSON file.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BusMessage, Producer } from './types';

export class OutboxProducer implements Producer {
  constructor(private readonly outboxDir: string) {
    fs.mkdirSync(outboxDir, { recursive: true });
  }

  async publish<T>(message: BusMessage<T>): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(this.outboxDir, `${message.topic}-${day}.ndjson`);
    const line =
      JSON.stringify({
        topic: message.topic,
        key: message.key,
        headers: message.headers,
        payload: message.payload,
      }) + '\n';
    fs.appendFileSync(file, line, { encoding: 'utf8' });
  }

  async close(): Promise<void> {
    /* nothing to close */
  }

  /** Test-only: read every message ever written for `topic`. */
  readAll<T = unknown>(topic: string): BusMessage<T>[] {
    if (!fs.existsSync(this.outboxDir)) return [];
    const out: BusMessage<T>[] = [];
    for (const f of fs.readdirSync(this.outboxDir)) {
      if (!f.startsWith(`${topic}-`) || !f.endsWith('.ndjson')) continue;
      const txt = fs.readFileSync(path.join(this.outboxDir, f), 'utf8');
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        out.push(JSON.parse(line) as BusMessage<T>);
      }
    }
    return out;
  }
}
