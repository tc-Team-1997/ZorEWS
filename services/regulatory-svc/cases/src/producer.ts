// services/regulatory-svc/cases/src/producer.ts
//
// Outbox producer for the apex.case.events topic. Mirrors the alerts/
// OutboxProducer pattern so a future agent-integration MSK wiring is a
// one-line factory swap.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CaseEvent } from './types';

export interface CaseProducer {
  emit(topic: string, event: CaseEvent): Promise<void>;
}

export class OutboxCaseProducer implements CaseProducer {
  constructor(private readonly outboxDir: string) {
    fs.mkdirSync(outboxDir, { recursive: true });
  }

  async emit(topic: string, event: CaseEvent): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(this.outboxDir, `${topic}-${day}.ndjson`);
    fs.appendFileSync(file, JSON.stringify(event) + '\n', { encoding: 'utf8' });
  }

  /** Read-back helper (tests only). */
  readAll(topic: string): CaseEvent[] {
    if (!fs.existsSync(this.outboxDir)) return [];
    const out: CaseEvent[] = [];
    for (const f of fs.readdirSync(this.outboxDir)) {
      if (!f.startsWith(`${topic}-`) || !f.endsWith('.ndjson')) continue;
      const txt = fs.readFileSync(path.join(this.outboxDir, f), 'utf8');
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        out.push(JSON.parse(line) as CaseEvent);
      }
    }
    return out;
  }
}

export function makeCaseProducer(env: NodeJS.ProcessEnv = process.env): OutboxCaseProducer {
  const outboxDir =
    env.APEX_CASE_OUTBOX_DIR ?? path.resolve(__dirname, '..', '.outbox');
  return new OutboxCaseProducer(outboxDir);
}
