// services/regulatory-svc/rules/__tests__/kafka_consumer.test.ts
//
// T2.12 — Indicator-values consumer tests.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  OutboxIndicatorValueConsumer,
  KafkaIndicatorValueConsumer,
  validateIndicatorValueEvent,
  makeIndicatorValueConsumer,
  type IndicatorValueEvent,
  type IndicatorValueHandler,
} from '../src/kafka_consumer';

function tmpOutboxDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kafka-consumer-test-'));
}

function validEvent(overrides: Partial<IndicatorValueEvent> = {}): IndicatorValueEvent {
  return {
    value_id: 'val-1',
    indicator_id: 'FIN-001',
    customer_id: 'CUST-100',
    computed_at: '2026-05-21T12:00:00.000Z',
    value: 0.42,
    severity_weight: 0.65,
    family: 'financial',
    ...overrides,
  };
}

// Tiny in-memory mock of a kafkajs Consumer.
function makeMockConsumer(messages: { value: string; offset?: string }[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let savedHandler: any = null;
  let runCalled = false;
  return {
    runCalledRef: () => runCalled,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run: async (opts: any) => {
      runCalled = true;
      savedHandler = opts.eachMessage;
      for (let i = 0; i < messages.length; i++) {
        await opts.eachMessage({
          message: {
            value: Buffer.from(messages[i].value, 'utf8'),
            offset: messages[i].offset ?? String(i),
          },
        });
      }
    },
    disconnect: async () => {
      savedHandler = null;
    },
  };
}

// ─── validateIndicatorValueEvent ────────────────────────────────────

describe('validateIndicatorValueEvent', () => {
  test('accepts a complete valid event', () => {
    expect(validateIndicatorValueEvent(validEvent())).toBeNull();
  });

  test('accepts every family enum value', () => {
    for (const family of [
      'financial',
      'behavioural',
      'transaction',
      'credit',
      'fraud',
    ] as const) {
      expect(validateIndicatorValueEvent(validEvent({ family }))).toBeNull();
    }
  });

  test('rejects non-object input', () => {
    expect(validateIndicatorValueEvent(null)).toBe('invalid_input');
    expect(validateIndicatorValueEvent('not-an-object')).toBe('invalid_input');
    expect(validateIndicatorValueEvent(42)).toBe('invalid_input');
  });

  test('rejects missing required fields', () => {
    expect(validateIndicatorValueEvent({ ...validEvent(), value_id: '' })).toBe(
      'invalid_input',
    );
    expect(
      validateIndicatorValueEvent({ ...validEvent(), indicator_id: '' }),
    ).toBe('invalid_input');
    expect(
      validateIndicatorValueEvent({ ...validEvent(), customer_id: '' }),
    ).toBe('invalid_input');
    expect(
      validateIndicatorValueEvent({ ...validEvent(), computed_at: '' }),
    ).toBe('invalid_input');
  });

  test('rejects non-finite value', () => {
    expect(validateIndicatorValueEvent({ ...validEvent(), value: NaN })).toBe(
      'invalid_value',
    );
    expect(
      validateIndicatorValueEvent({ ...validEvent(), value: Infinity }),
    ).toBe('invalid_value');
  });

  test('rejects severity_weight outside [0, 1]', () => {
    expect(
      validateIndicatorValueEvent({ ...validEvent(), severity_weight: -0.1 }),
    ).toBe('invalid_value');
    expect(
      validateIndicatorValueEvent({ ...validEvent(), severity_weight: 1.5 }),
    ).toBe('invalid_value');
  });

  test('rejects unknown family', () => {
    expect(
      validateIndicatorValueEvent({
        ...validEvent(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        family: 'BOGUS' as any,
      }),
    ).toBe('invalid_family');
  });
});

// ─── OutboxIndicatorValueConsumer ────────────────────────────────────

describe('OutboxIndicatorValueConsumer', () => {
  test('drains zero events on missing dir without throwing', async () => {
    const c = new OutboxIndicatorValueConsumer('/nonexistent-dir-xyz');
    const seen: IndicatorValueEvent[] = [];
    const handle = await c.subscribe(async (e) => {
      seen.push(e);
      return 1;
    });
    await new Promise((r) => setTimeout(r, 50));
    await handle.stop();
    expect(seen).toEqual([]);
    expect(c.getStats().total_received).toBe(0);
  });

  test('drains a single valid event from an NDJSON file', async () => {
    const dir = tmpOutboxDir();
    const evt = validEvent({ value_id: 'val-single' });
    fs.writeFileSync(
      path.join(dir, '2026-05-21.ndjson'),
      JSON.stringify(evt) + '\n',
    );
    const c = new OutboxIndicatorValueConsumer(dir);
    const seen: IndicatorValueEvent[] = [];
    const handle = await c.subscribe(async (e) => {
      seen.push(e);
      return 0;
    });
    await new Promise((r) => setTimeout(r, 100));
    await handle.stop();
    expect(seen).toHaveLength(1);
    expect(seen[0].value_id).toBe('val-single');
    expect(c.getStats().total_received).toBe(1);
    expect(c.getStats().total_handled_ok).toBe(1);
    expect(c.getStats().total_handler_errors).toBe(0);
  });

  test('drains files in oldest-filename-first order', async () => {
    const dir = tmpOutboxDir();
    const e1 = validEvent({ value_id: 'val-1', computed_at: '2026-05-20T00:00:00Z' });
    const e2 = validEvent({ value_id: 'val-2', computed_at: '2026-05-21T00:00:00Z' });
    fs.writeFileSync(path.join(dir, '2026-05-20.ndjson'), JSON.stringify(e1) + '\n');
    fs.writeFileSync(path.join(dir, '2026-05-21.ndjson'), JSON.stringify(e2) + '\n');
    const c = new OutboxIndicatorValueConsumer(dir);
    const seen: IndicatorValueEvent[] = [];
    const handle = await c.subscribe(async (e) => {
      seen.push(e);
      return 0;
    });
    await new Promise((r) => setTimeout(r, 100));
    await handle.stop();
    expect(seen.map((s) => s.value_id)).toEqual(['val-1', 'val-2']);
  });

  test('handler errors are caught + counted but do not block subsequent events', async () => {
    const dir = tmpOutboxDir();
    const e1 = validEvent({ value_id: 'a' });
    const e2 = validEvent({ value_id: 'b' });
    fs.writeFileSync(
      path.join(dir, '2026-05-21.ndjson'),
      JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n',
    );
    const c = new OutboxIndicatorValueConsumer(dir);
    const seen: string[] = [];
    const handler: IndicatorValueHandler = async (e) => {
      seen.push(e.value_id);
      if (e.value_id === 'a') throw new Error('boom');
      return 0;
    };
    const handle = await c.subscribe(handler);
    await new Promise((r) => setTimeout(r, 100));
    await handle.stop();
    expect(seen).toEqual(['a', 'b']);
    expect(c.getStats().total_handler_errors).toBe(1);
    expect(c.getStats().total_handled_ok).toBe(1);
  });

  test('malformed JSON lines counted in total_invalid_events', async () => {
    const dir = tmpOutboxDir();
    fs.writeFileSync(
      path.join(dir, '2026-05-21.ndjson'),
      '{not valid json\n' + JSON.stringify(validEvent()) + '\n',
    );
    const c = new OutboxIndicatorValueConsumer(dir);
    let okCount = 0;
    const handle = await c.subscribe(async () => {
      okCount++;
      return 0;
    });
    await new Promise((r) => setTimeout(r, 100));
    await handle.stop();
    expect(c.getStats().total_invalid_events).toBe(1);
    expect(okCount).toBe(1);
  });

  test('schema-invalid events counted in total_invalid_events', async () => {
    const dir = tmpOutboxDir();
    const bad = { ...validEvent(), family: 'bogus_family' };
    fs.writeFileSync(
      path.join(dir, '2026-05-21.ndjson'),
      JSON.stringify(bad) + '\n',
    );
    const c = new OutboxIndicatorValueConsumer(dir);
    let okCount = 0;
    const handle = await c.subscribe(async () => {
      okCount++;
      return 0;
    });
    await new Promise((r) => setTimeout(r, 100));
    await handle.stop();
    expect(c.getStats().total_invalid_events).toBe(1);
    expect(okCount).toBe(0);
  });

  test('last_event_at tracks the most-recent computed_at', async () => {
    const dir = tmpOutboxDir();
    const e1 = validEvent({ value_id: 'x', computed_at: '2026-05-21T01:00:00.000Z' });
    const e2 = validEvent({ value_id: 'y', computed_at: '2026-05-21T02:00:00.000Z' });
    fs.writeFileSync(
      path.join(dir, '2026-05-21.ndjson'),
      JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n',
    );
    const c = new OutboxIndicatorValueConsumer(dir);
    const handle = await c.subscribe(async () => 0);
    await new Promise((r) => setTimeout(r, 100));
    await handle.stop();
    expect(c.getStats().last_event_at).toBe('2026-05-21T02:00:00.000Z');
  });

  test('stop() prevents further handler invocation', async () => {
    const dir = tmpOutboxDir();
    // Write 100 events.
    const lines = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify(validEvent({ value_id: `e-${i}` })),
    ).join('\n');
    fs.writeFileSync(path.join(dir, '2026-05-21.ndjson'), lines + '\n');
    const c = new OutboxIndicatorValueConsumer(dir);
    let count = 0;
    const handle = await c.subscribe(async () => {
      count++;
      // Yield to let stop() take effect.
      await new Promise((r) => setImmediate(r));
      return 0;
    });
    // Immediately stop — drain should bail before all 100 are processed.
    await handle.stop();
    await new Promise((r) => setTimeout(r, 200));
    expect(count).toBeLessThan(100);
  });
});

// ─── KafkaIndicatorValueConsumer ────────────────────────────────────

describe('KafkaIndicatorValueConsumer', () => {
  test('invokes handler per kafkajs message', async () => {
    const messages = [
      { value: JSON.stringify(validEvent({ value_id: 'k1' })), offset: '1' },
      { value: JSON.stringify(validEvent({ value_id: 'k2' })), offset: '2' },
    ];
    const consumer = makeMockConsumer(messages);
    const c = new KafkaIndicatorValueConsumer({
      consumer,
      topic: 'apex.indicator.values',
    });
    const seen: string[] = [];
    const handle = await c.subscribe(async (e) => {
      seen.push(e.value_id);
      return 0;
    });
    await handle.stop();
    expect(seen).toEqual(['k1', 'k2']);
    expect(c.getStats().total_handled_ok).toBe(2);
  });

  test('catches handler errors without unwinding the run loop', async () => {
    const messages = [
      { value: JSON.stringify(validEvent({ value_id: 'a' })) },
      { value: JSON.stringify(validEvent({ value_id: 'b' })) },
    ];
    const consumer = makeMockConsumer(messages);
    const c = new KafkaIndicatorValueConsumer({
      consumer,
      topic: 'apex.indicator.values',
    });
    const seen: string[] = [];
    const handle = await c.subscribe(async (e) => {
      seen.push(e.value_id);
      if (e.value_id === 'a') throw new Error('test');
      return 0;
    });
    await handle.stop();
    expect(seen).toEqual(['a', 'b']);
    expect(c.getStats().total_handler_errors).toBe(1);
  });

  test('rejects malformed JSON messages', async () => {
    const messages = [
      { value: 'not-json{' },
      { value: JSON.stringify(validEvent()) },
    ];
    const consumer = makeMockConsumer(messages);
    const c = new KafkaIndicatorValueConsumer({
      consumer,
      topic: 'apex.indicator.values',
    });
    let okCount = 0;
    const handle = await c.subscribe(async () => {
      okCount++;
      return 0;
    });
    await handle.stop();
    expect(c.getStats().total_invalid_events).toBe(1);
    expect(okCount).toBe(1);
  });

  test('schema-invalid events fail validation', async () => {
    const bad = { ...validEvent(), severity_weight: 5 };
    const messages = [{ value: JSON.stringify(bad) }];
    const consumer = makeMockConsumer(messages);
    const c = new KafkaIndicatorValueConsumer({
      consumer,
      topic: 'apex.indicator.values',
    });
    let okCount = 0;
    const handle = await c.subscribe(async () => {
      okCount++;
      return 0;
    });
    await handle.stop();
    expect(c.getStats().total_invalid_events).toBe(1);
    expect(okCount).toBe(0);
  });

  test('onCommit fires per message with the offset', async () => {
    const messages = [
      { value: JSON.stringify(validEvent()), offset: '100' },
      { value: JSON.stringify(validEvent()), offset: '101' },
    ];
    const consumer = makeMockConsumer(messages);
    const offsets: string[] = [];
    const c = new KafkaIndicatorValueConsumer({
      consumer,
      topic: 'apex.indicator.values',
      onCommit: (offset) => offsets.push(offset),
    });
    const handle = await c.subscribe(async () => 0);
    await handle.stop();
    expect(offsets).toEqual(['100', '101']);
  });
});

// ─── makeIndicatorValueConsumer factory ─────────────────────────────

describe('makeIndicatorValueConsumer', () => {
  test('returns OutboxIndicatorValueConsumer when KAFKA_BROKERS unset', () => {
    const c = makeIndicatorValueConsumer({});
    expect(c).toBeInstanceOf(OutboxIndicatorValueConsumer);
  });

  test('throws useful error when KAFKA_BROKERS is set (production needs caller-side wire-up)', () => {
    expect(() =>
      makeIndicatorValueConsumer({ KAFKA_BROKERS: 'broker1:9092' }),
    ).toThrow(/KAFKA_BROKERS is set/);
  });

  test('honours INDICATOR_OUTBOX_DIR env override', () => {
    const dir = tmpOutboxDir();
    const c = makeIndicatorValueConsumer({ INDICATOR_OUTBOX_DIR: dir });
    expect(c).toBeInstanceOf(OutboxIndicatorValueConsumer);
  });
});
