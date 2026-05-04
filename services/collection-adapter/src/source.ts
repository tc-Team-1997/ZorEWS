// services/collection-adapter/src/source.ts
//
// CaseEventSource — pluggable consumer of apex.case.events. NDJSON outbox
// reader for the prototype; agent-integration's MSK consumer plugs in
// behind the same interface.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CaseEvent } from './types';

export interface CaseEventSource {
  read(): CaseEvent[];
}

export class OutboxCaseEventSource implements CaseEventSource {
  constructor(
    private readonly outboxDir: string,
    private readonly topic = 'apex.case.events',
  ) {}

  read(): CaseEvent[] {
    if (!fs.existsSync(this.outboxDir)) return [];
    const out: CaseEvent[] = [];
    for (const f of fs.readdirSync(this.outboxDir).sort()) {
      if (!f.startsWith(`${this.topic}-`) || !f.endsWith('.ndjson')) continue;
      const txt = fs.readFileSync(path.join(this.outboxDir, f), 'utf8');
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as CaseEvent);
        } catch {
          // skip corrupt lines
        }
      }
    }
    return out;
  }
}

export class StaticCaseEventSource implements CaseEventSource {
  constructor(private readonly events: CaseEvent[]) {}
  read(): CaseEvent[] {
    return [...this.events];
  }
}

export function makeCaseEventSource(env: NodeJS.ProcessEnv = process.env): CaseEventSource {
  const outboxDir =
    env.APEX_CASES_OUTBOX_DIR ??
    path.resolve(__dirname, '..', '..', 'regulatory-svc', 'cases', '.outbox');
  return new OutboxCaseEventSource(outboxDir);
}
