import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OutboxProducer } from '../src/outbox';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'event-bus-outbox-'));
}

describe('OutboxProducer', () => {
  test('writes one NDJSON line per publish', async () => {
    const dir = tmp();
    const p = new OutboxProducer(dir);
    await p.publish({ topic: 't', payload: { n: 1 } });
    await p.publish({ topic: 't', payload: { n: 2 } });
    const all = p.readAll<{ n: number }>('t');
    expect(all).toHaveLength(2);
    expect(all[0].payload).toEqual({ n: 1 });
    expect(all[1].payload).toEqual({ n: 2 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('separates topics into separate files', async () => {
    const dir = tmp();
    const p = new OutboxProducer(dir);
    await p.publish({ topic: 'a', payload: 1 });
    await p.publish({ topic: 'b', payload: 2 });
    expect(p.readAll('a').map((m) => m.payload)).toEqual([1]);
    expect(p.readAll('b').map((m) => m.payload)).toEqual([2]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('preserves key + headers on round-trip', async () => {
    const dir = tmp();
    const p = new OutboxProducer(dir);
    await p.publish({
      topic: 't',
      key: 'cust-9',
      headers: { 'x-trace': 'abc' },
      payload: { ok: true },
    });
    const [m] = p.readAll('t');
    expect(m.key).toBe('cust-9');
    expect(m.headers).toEqual({ 'x-trace': 'abc' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('readAll on empty dir returns []', () => {
    const dir = tmp();
    const p = new OutboxProducer(dir);
    expect(p.readAll('whatever')).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
