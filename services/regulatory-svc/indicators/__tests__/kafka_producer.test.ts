// T2.12.2 — Indicator-values Kafka producer tests.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HttpBffTelemetryClient,
  IndicatorProducerError,
  KafkaIndicatorProducer,
  OutboxIndicatorProducer,
  makeIndicatorProducer,
  validateIndicatorValue,
  type BffTelemetryClient,
  type IndicatorValueEvent,
} from '../src/kafka_producer';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'indicator-producer-'));
}

const BASE_INPUT = {
  indicator_id: 'FIN-001',
  customer_id: 'CUST-1',
  value: 0.42,
  severity_weight: 0.8,
  family: 'financial' as const,
};

describe('validateIndicatorValue', () => {
  test('happy path mints value_id + computed_at when omitted', () => {
    const e = validateIndicatorValue(BASE_INPUT);
    expect(e.value_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.computed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('caller-supplied value_id + computed_at preserved', () => {
    const e = validateIndicatorValue({
      ...BASE_INPUT,
      value_id: '00000000-0000-0000-0000-000000000001',
      computed_at: '2026-05-21T10:00:00.000Z',
    });
    expect(e.value_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(e.computed_at).toBe('2026-05-21T10:00:00.000Z');
  });

  test('rejects missing required fields', () => {
    expect(() => validateIndicatorValue({} as never)).toThrow(IndicatorProducerError);
    expect(() => validateIndicatorValue({ ...BASE_INPUT, customer_id: '' })).toThrow(/customer_id/);
  });

  test('rejects non-finite value', () => {
    expect(() => validateIndicatorValue({ ...BASE_INPUT, value: Number.NaN })).toThrow(
      /finite|invalid_value/,
    );
  });

  test('rejects severity_weight out of [0, 1]', () => {
    expect(() => validateIndicatorValue({ ...BASE_INPUT, severity_weight: 1.5 })).toThrow(
      /severity_weight/,
    );
    expect(() => validateIndicatorValue({ ...BASE_INPUT, severity_weight: -0.1 })).toThrow(
      /severity_weight/,
    );
  });

  test('rejects unknown family', () => {
    expect(() =>
      validateIndicatorValue({ ...BASE_INPUT, family: 'bogus' as never }),
    ).toThrow(/family/);
  });

  test('all 5 family enum values accepted', () => {
    for (const fam of ['financial', 'behavioural', 'transaction', 'credit', 'fraud'] as const) {
      expect(() => validateIndicatorValue({ ...BASE_INPUT, family: fam })).not.toThrow();
    }
  });

  test('rejects malformed computed_at', () => {
    expect(() =>
      validateIndicatorValue({ ...BASE_INPUT, computed_at: 'not-a-date' }),
    ).toThrow(/computed_at/);
  });
});

describe('OutboxIndicatorProducer', () => {
  test('emit writes NDJSON + returns DispatchReceipt with bff_telemetry=skipped', async () => {
    const dir = tmpDir();
    const p = new OutboxIndicatorProducer(dir);
    const event = validateIndicatorValue(BASE_INPUT);
    const receipt = await p.emit(event);
    expect(receipt.value_id).toBe(event.value_id);
    expect(receipt.topic).toBe('apex.indicator.values');
    expect(receipt.bff_telemetry).toBe('skipped');
    // File written.
    const files = fs.readdirSync(dir);
    expect(files.some((f) => f.startsWith('apex.indicator.values-'))).toBe(true);
  });

  test('readAll round-trips events', async () => {
    const dir = tmpDir();
    const p = new OutboxIndicatorProducer(dir);
    for (let i = 0; i < 5; i++) {
      await p.emit(validateIndicatorValue({ ...BASE_INPUT, customer_id: `CUST-${i}` }));
    }
    const all = p.readAll();
    expect(all.length).toBe(5);
    expect(all.map((e) => e.customer_id)).toContain('CUST-3');
  });

  test('telemetry client failure → bff_telemetry=failed', async () => {
    const dir = tmpDir();
    const failing: BffTelemetryClient = {
      record: async () => {
        throw new Error('network down');
      },
    };
    const p = new OutboxIndicatorProducer(dir, failing);
    const receipt = await p.emit(validateIndicatorValue(BASE_INPUT));
    expect(receipt.bff_telemetry).toBe('failed');
    // Outbox still has the event (failure is non-blocking).
    expect(p.readAll().length).toBe(1);
  });

  test('telemetry client success → bff_telemetry=ok', async () => {
    const dir = tmpDir();
    const ok: BffTelemetryClient = { record: async () => {} };
    const p = new OutboxIndicatorProducer(dir, ok);
    const receipt = await p.emit(validateIndicatorValue(BASE_INPUT));
    expect(receipt.bff_telemetry).toBe('ok');
  });
});

describe('KafkaIndicatorProducer (mocked inner)', () => {
  test('dispatch failure routes to DLQ outbox', async () => {
    const dlqDir = tmpDir();
    const p = new KafkaIndicatorProducer({
      brokers: ['broker-1:9092'],
      clientId: 'test',
      dlqDir,
    });
    // Inject a failing inner.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).inner = {
      publish: async () => {
        throw new Error('connection refused');
      },
    };
    await expect(p.emit(validateIndicatorValue(BASE_INPUT))).rejects.toThrow(
      IndicatorProducerError,
    );
    // DLQ should have captured the event.
    const dlqFiles = fs.readdirSync(dlqDir);
    expect(dlqFiles.some((f) => f.endsWith('.ndjson'))).toBe(true);
  });

  test('successful publish returns ok receipt', async () => {
    const p = new KafkaIndicatorProducer({
      brokers: ['broker-1:9092'],
      clientId: 'test',
    });
    let published: unknown = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (p as any).inner = {
      publish: async (msg: unknown) => {
        published = msg;
      },
    };
    const event = validateIndicatorValue(BASE_INPUT);
    const receipt = await p.emit(event);
    expect(receipt.value_id).toBe(event.value_id);
    expect(receipt.topic).toBe('apex.indicator.values');
    expect(published).toMatchObject({ topic: 'apex.indicator.values', key: 'CUST-1' });
  });
});

describe('HttpBffTelemetryClient', () => {
  test('POSTs to /v1/streaming/indicator-events with tenant + auth headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const orig = global.fetch;
    global.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    try {
      const c = new HttpBffTelemetryClient({
        baseUrl: 'http://bff.test',
        tenantId: 'BIL',
        apiKey: 'apex_xyz.secret',
      });
      const event = validateIndicatorValue(BASE_INPUT);
      await c.record(event);
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe('http://bff.test/v1/streaming/indicator-events');
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers['X-Tenant-ID']).toBe('BIL');
      expect(headers['Authorization']).toBe('Bearer apex_xyz.secret');
      expect(headers['X-Channel']).toBe('INTERNAL');
    } finally {
      global.fetch = orig;
    }
  });

  test('non-OK response throws', async () => {
    const orig = global.fetch;
    global.fetch = (async () => new Response('boom', { status: 503 })) as typeof fetch;
    try {
      const c = new HttpBffTelemetryClient({
        baseUrl: 'http://bff.test',
        tenantId: 'BIL',
      });
      await expect(c.record(validateIndicatorValue(BASE_INPUT))).rejects.toThrow(/503/);
    } finally {
      global.fetch = orig;
    }
  });

  test('event tenant_id overrides default when present', async () => {
    let captured: Record<string, string> | null = null;
    const orig = global.fetch;
    global.fetch = (async (_url: string, init: RequestInit) => {
      captured = init.headers as Record<string, string>;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    try {
      const c = new HttpBffTelemetryClient({ baseUrl: 'http://bff.test', tenantId: 'DEFAULT' });
      await c.record({ ...validateIndicatorValue(BASE_INPUT), tenant_id: 'BANK_DEMO' });
      expect(captured!['X-Tenant-ID']).toBe('BANK_DEMO');
    } finally {
      global.fetch = orig;
    }
  });
});

describe('makeIndicatorProducer factory', () => {
  test('defaults to OutboxIndicatorProducer when KAFKA_BROKERS unset', () => {
    const dir = tmpDir();
    const p = makeIndicatorProducer({ INDICATOR_OUTBOX_DIR: dir });
    expect(p).toBeInstanceOf(OutboxIndicatorProducer);
  });

  test('returns KafkaIndicatorProducer when KAFKA_BROKERS set', () => {
    const p = makeIndicatorProducer({
      KAFKA_BROKERS: 'broker-1:9092,broker-2:9092',
      KAFKA_CLIENT_ID: 'apex-indicators-test',
    });
    expect(p).toBeInstanceOf(KafkaIndicatorProducer);
  });
});
