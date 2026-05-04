// services/notification-svc/src/adapters/logging.ts
//
// LoggingAdapter — last-resort sink. Writes to stdout AND to an NDJSON file
// under .outbox/<channel>-<date>.ndjson so dev runs are reproducible and tests
// can read back the messages produced.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Adapter, Channel, SendInput, SendResult } from '../types';

export class LoggingAdapter implements Adapter {
  public readonly name = 'logging';

  constructor(
    public readonly channel: Channel,
    private readonly outboxDir: string,
  ) {
    fs.mkdirSync(outboxDir, { recursive: true });
  }

  async send(input: SendInput): Promise<SendResult> {
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(this.outboxDir, `${this.channel}-${day}.ndjson`);
    const record = {
      ts: new Date().toISOString(),
      adapter: this.name,
      channel: this.channel,
      alert_id: input.alert_id,
      target: input.target,
      message: input.message,
    };
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { encoding: 'utf8' });
    // eslint-disable-next-line no-console
    console.log(`[notify:${this.channel}:logging]`, JSON.stringify(record));
    return {
      channel: this.channel,
      ok: true,
      adapter: this.name,
      provider_message_id: `log-${Date.now()}`,
    };
  }
}
