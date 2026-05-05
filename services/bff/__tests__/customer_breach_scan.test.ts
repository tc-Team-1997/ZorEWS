// services/bff/__tests__/customer_breach_scan.test.ts
//
// T6 M4.5 — Customer breach scan.

import request from 'supertest';
import {
  BreachScanError,
  scanCustomerBreaches,
  scanCustomerBreachesBulk,
} from '../src/customer_breach_scan';
import { InMemoryThresholdOverrideStore } from '../src/indicator_thresholds';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-06T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeScanApp(role = 'admin') {
  const store = new InMemoryThresholdOverrideStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    thresholdOverrideStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

describe('scanCustomerBreaches', () => {
  test('happy: returns 17 breaches by default (no vertical filter)', () => {
    const s = new InMemoryThresholdOverrideStore();
    const r = scanCustomerBreaches(
      { tenant_id: 'BIL', customer_id: 'CUST-100123' },
      s,
      NOW,
    );
    expect(r.breaches.length).toBe(17);
    expect(r.summary.total).toBe(17);
    expect(r.vertical).toBe('all');
  });

  test('vertical=banking → 8 breaches', () => {
    const s = new InMemoryThresholdOverrideStore();
    const r = scanCustomerBreaches(
      { tenant_id: 'BIL', customer_id: 'CUST-1', vertical: 'banking' },
      s,
      NOW,
    );
    expect(r.breaches.length).toBe(8);
    expect(r.breaches.every((b) => b.vertical === 'banking')).toBe(true);
  });

  test('vertical=insurance → 9 breaches', () => {
    const s = new InMemoryThresholdOverrideStore();
    const r = scanCustomerBreaches(
      { tenant_id: 'BIL', customer_id: 'CUST-1', vertical: 'insurance' },
      s,
      NOW,
    );
    expect(r.breaches.length).toBe(9);
    expect(r.breaches.every((b) => b.vertical === 'insurance')).toBe(true);
  });

  test('breaches sorted: red → orange → yellow → green', () => {
    const s = new InMemoryThresholdOverrideStore();
    const r = scanCustomerBreaches(
      { tenant_id: 'BIL', customer_id: 'CUST-100123' },
      s,
      NOW,
    );
    const order = ['red', 'orange', 'yellow', 'green'];
    let lastIdx = -1;
    for (const b of r.breaches) {
      const idx = order.indexOf(b.breach_class);
      expect(idx).toBeGreaterThanOrEqual(lastIdx);
      lastIdx = idx;
    }
  });

  test('summary counts add to total', () => {
    const s = new InMemoryThresholdOverrideStore();
    const r = scanCustomerBreaches(
      { tenant_id: 'BIL', customer_id: 'CUST-1' },
      s,
      NOW,
    );
    const sum =
      r.summary.red_count +
      r.summary.orange_count +
      r.summary.yellow_count +
      r.summary.green_count;
    expect(sum).toBe(r.summary.total);
  });

  test('worst_class reflects highest seen', () => {
    const s = new InMemoryThresholdOverrideStore();
    const r = scanCustomerBreaches(
      { tenant_id: 'BIL', customer_id: 'CUST-100123' },
      s,
      NOW,
    );
    if (r.summary.red_count > 0) {
      expect(r.summary.worst_class).toBe('red');
    } else if (r.summary.orange_count > 0) {
      expect(r.summary.worst_class).toBe('orange');
    } else if (r.summary.yellow_count > 0) {
      expect(r.summary.worst_class).toBe('yellow');
    } else {
      expect(r.summary.worst_class).toBe('green');
    }
  });

  test('determinism: same (tenant, customer, day) → same result', () => {
    const s = new InMemoryThresholdOverrideStore();
    const a = scanCustomerBreaches(
      { tenant_id: 'BIL', customer_id: 'CUST-1' },
      s,
      NOW,
    );
    const b = scanCustomerBreaches(
      { tenant_id: 'BIL', customer_id: 'CUST-1' },
      s,
      NOW,
    );
    expect(a.breaches.map((x) => x.value)).toEqual(b.breaches.map((x) => x.value));
  });

  test('different customers produce different value distributions', () => {
    const s = new InMemoryThresholdOverrideStore();
    const a = scanCustomerBreaches(
      { tenant_id: 'BIL', customer_id: 'CUST-A' },
      s,
      NOW,
    );
    const b = scanCustomerBreaches(
      { tenant_id: 'BIL', customer_id: 'CUST-B' },
      s,
      NOW,
    );
    // Statistically, at least one value should differ
    const allEqual = a.breaches.every(
      (x, i) => x.value === b.breaches[i]!.value,
    );
    expect(allEqual).toBe(false);
  });

  test('cross-tenant: same customer in different tenants → different values', () => {
    const s = new InMemoryThresholdOverrideStore();
    const a = scanCustomerBreaches(
      { tenant_id: 'BIL', customer_id: 'CUST-1' },
      s,
      NOW,
    );
    const b = scanCustomerBreaches(
      { tenant_id: 'BANK_DEMO', customer_id: 'CUST-1' },
      s,
      NOW,
    );
    const allEqual = a.breaches.every(
      (x, i) => x.value === b.breaches[i]!.value,
    );
    expect(allEqual).toBe(false);
  });

  test('tenant override flips the breach class for affected indicator', () => {
    const s = new InMemoryThresholdOverrideStore();
    // Default FIN-001 thresholds: 0.30/0.55/0.80
    // Set super-tight override: 0.01/0.02/0.03 — almost everything will be red
    s.setOverride('BIL', 'FIN-001', {
      yellow_at: 0.01,
      orange_at: 0.02,
      red_at: 0.03,
    });
    const r = scanCustomerBreaches(
      { tenant_id: 'BIL', customer_id: 'CUST-100123' },
      s,
      NOW,
    );
    const fin001 = r.breaches.find((b) => b.indicator_id === 'FIN-001')!;
    // value is in [0,1] — overwhelmingly likely > 0.03 → red
    if (fin001.value > 0.03) {
      expect(fin001.breach_class).toBe('red');
    }
  });

  test('rejects empty tenant_id', () => {
    const s = new InMemoryThresholdOverrideStore();
    expect(() =>
      scanCustomerBreaches({ tenant_id: '', customer_id: 'CUST-1' }, s, NOW),
    ).toThrow(/tenant_id/);
  });

  test('rejects empty customer_id', () => {
    const s = new InMemoryThresholdOverrideStore();
    expect(() =>
      scanCustomerBreaches({ tenant_id: 'BIL', customer_id: '' }, s, NOW),
    ).toThrow(/customer_id/);
  });

  test('rejects invalid vertical', () => {
    const s = new InMemoryThresholdOverrideStore();
    expect(() =>
      scanCustomerBreaches(
        {
          tenant_id: 'BIL',
          customer_id: 'CUST-1',
          vertical: 'crypto' as unknown as 'banking',
        },
        s,
        NOW,
      ),
    ).toThrow(/vertical/);
  });

  test('all breach values in [0, 1]', () => {
    const s = new InMemoryThresholdOverrideStore();
    const r = scanCustomerBreaches(
      { tenant_id: 'BIL', customer_id: 'CUST-100123' },
      s,
      NOW,
    );
    for (const b of r.breaches) {
      expect(b.value).toBeGreaterThanOrEqual(0);
      expect(b.value).toBeLessThanOrEqual(1);
    }
  });
});

describe('POST /v1/indicators/scan-customer', () => {
  test('analyst+: 200 with 17 breaches by default', async () => {
    const { app } = makeScanApp('risk_analyst');
    const r = await request(app)
      .post('/v1/indicators/scan-customer')
      .set(TH_BIL)
      .send({ customer_id: 'CUST-100123' });
    expect(r.status).toBe(200);
    expect(r.body.body.breaches.length).toBe(17);
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('vertical=banking narrows', async () => {
    const { app } = makeScanApp('admin');
    const r = await request(app)
      .post('/v1/indicators/scan-customer')
      .set(TH_BIL)
      .send({ customer_id: 'CUST-1', vertical: 'banking' });
    expect(r.body.body.breaches.length).toBe(8);
  });

  test('accepts enveloped body', async () => {
    const { app } = makeScanApp('admin');
    const r = await request(app)
      .post('/v1/indicators/scan-customer')
      .set(TH_BIL)
      .send({
        header: { requestId: 'r-1' },
        body: { customer_id: 'CUST-1' },
      });
    expect(r.status).toBe(200);
  });

  test('summary counters add to total', async () => {
    const { app } = makeScanApp('admin');
    const r = await request(app)
      .post('/v1/indicators/scan-customer')
      .set(TH_BIL)
      .send({ customer_id: 'CUST-1' });
    const s = r.body.body.summary;
    expect(s.red_count + s.orange_count + s.yellow_count + s.green_count).toBe(s.total);
  });

  test('M4.4 override flows through (tighter threshold → more reds)', async () => {
    const { app, store } = makeScanApp('admin');
    // Tighten ALL thresholds via overrides — almost every value
    // should land in the red zone
    for (const id of [
      'FIN-001', 'FIN-002', 'FIN-003', 'BEH-001', 'BEH-002',
      'TXN-001', 'TXN-002', 'CRD-001',
    ]) {
      store.setOverride('BIL', id, {
        yellow_at: 0.01,
        orange_at: 0.02,
        red_at: 0.03,
      });
    }
    const r = await request(app)
      .post('/v1/indicators/scan-customer')
      .set(TH_BIL)
      .send({ customer_id: 'CUST-100123', vertical: 'banking' });
    expect(r.body.body.summary.red_count).toBeGreaterThanOrEqual(7);
  });

  test('missing customer_id → 400', async () => {
    const { app } = makeScanApp('admin');
    const r = await request(app)
      .post('/v1/indicators/scan-customer')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('invalid vertical → 400', async () => {
    const { app } = makeScanApp('admin');
    const r = await request(app)
      .post('/v1/indicators/scan-customer')
      .set(TH_BIL)
      .send({ customer_id: 'CUST-1', vertical: 'crypto' });
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeScanApp('case_owner');
    const r = await request(app)
      .post('/v1/indicators/scan-customer')
      .set(TH_BIL)
      .send({ customer_id: 'CUST-1' });
    expect(r.status).toBe(403);
  });

  test('determinism: same call → identical body', async () => {
    const { app } = makeScanApp('admin');
    const a = await request(app)
      .post('/v1/indicators/scan-customer')
      .set(TH_BIL)
      .send({ customer_id: 'CUST-1' });
    const b = await request(app)
      .post('/v1/indicators/scan-customer')
      .set(TH_BIL)
      .send({ customer_id: 'CUST-1' });
    expect(a.body.body.breaches.map((x: { value: number }) => x.value)).toEqual(
      b.body.body.breaches.map((x: { value: number }) => x.value),
    );
  });
});

// ─── M4.6 — Bulk customer breach scan ────────────────────────────────

describe('scanCustomerBreachesBulk', () => {
  test('happy: results[] = customer_ids.length', () => {
    const s = new InMemoryThresholdOverrideStore();
    const r = scanCustomerBreachesBulk(
      {
        tenant_id: 'BIL',
        customer_ids: ['CUST-1', 'CUST-2', 'CUST-3'],
      },
      s,
      NOW,
    );
    expect(r.results.length).toBe(3);
    expect(r.aggregate.customer_count).toBe(3);
  });

  test('aggregate counts = sum of per-customer counts', () => {
    const s = new InMemoryThresholdOverrideStore();
    const r = scanCustomerBreachesBulk(
      {
        tenant_id: 'BIL',
        customer_ids: ['CUST-1', 'CUST-2', 'CUST-3'],
      },
      s,
      NOW,
    );
    const expected = {
      red: r.results.reduce((a, x) => a + x.summary.red_count, 0),
      orange: r.results.reduce((a, x) => a + x.summary.orange_count, 0),
      yellow: r.results.reduce((a, x) => a + x.summary.yellow_count, 0),
      green: r.results.reduce((a, x) => a + x.summary.green_count, 0),
    };
    expect(r.aggregate.red_total).toBe(expected.red);
    expect(r.aggregate.orange_total).toBe(expected.orange);
    expect(r.aggregate.yellow_total).toBe(expected.yellow);
    expect(r.aggregate.green_total).toBe(expected.green);
  });

  test('results sorted by worst_class (red first)', () => {
    const s = new InMemoryThresholdOverrideStore();
    const r = scanCustomerBreachesBulk(
      {
        tenant_id: 'BIL',
        customer_ids: ['CUST-1', 'CUST-2', 'CUST-3', 'CUST-4', 'CUST-5'],
      },
      s,
      NOW,
    );
    const order = ['red', 'orange', 'yellow', 'green'];
    let lastIdx = -1;
    for (const row of r.results) {
      const idx = row.summary.worst_class
        ? order.indexOf(row.summary.worst_class)
        : 99;
      expect(idx).toBeGreaterThanOrEqual(lastIdx);
      lastIdx = idx;
    }
  });

  test('customers_with_red counts customers with ≥ 1 red', () => {
    const s = new InMemoryThresholdOverrideStore();
    const r = scanCustomerBreachesBulk(
      {
        tenant_id: 'BIL',
        customer_ids: ['CUST-1', 'CUST-2', 'CUST-3'],
      },
      s,
      NOW,
    );
    const expected = r.results.filter((x) => x.summary.red_count > 0).length;
    expect(r.aggregate.customers_with_red).toBe(expected);
  });

  test('customers_attention_required = red OR orange', () => {
    const s = new InMemoryThresholdOverrideStore();
    const r = scanCustomerBreachesBulk(
      {
        tenant_id: 'BIL',
        customer_ids: ['CUST-1', 'CUST-2', 'CUST-3'],
      },
      s,
      NOW,
    );
    const expected = r.results.filter(
      (x) => x.summary.red_count > 0 || x.summary.orange_count > 0,
    ).length;
    expect(r.aggregate.customers_attention_required).toBe(expected);
  });

  test('vertical filter narrows', () => {
    const s = new InMemoryThresholdOverrideStore();
    const r = scanCustomerBreachesBulk(
      {
        tenant_id: 'BIL',
        customer_ids: ['CUST-1', 'CUST-2'],
        vertical: 'banking',
      },
      s,
      NOW,
    );
    expect(r.vertical).toBe('banking');
    // Each row's summary.total = 8 banking indicators
    for (const row of r.results) {
      expect(row.summary.total).toBe(8);
    }
  });

  test('cross-tenant isolation', () => {
    const s = new InMemoryThresholdOverrideStore();
    const a = scanCustomerBreachesBulk(
      { tenant_id: 'BIL', customer_ids: ['CUST-1'] },
      s,
      NOW,
    );
    const b = scanCustomerBreachesBulk(
      { tenant_id: 'BANK_DEMO', customer_ids: ['CUST-1'] },
      s,
      NOW,
    );
    // Tenant scope changes the seed, so values differ
    const aValues = a.results[0]!.summary;
    const bValues = b.results[0]!.summary;
    expect(aValues).not.toEqual(bValues);
  });

  test('empty customer_ids → invalid_input', () => {
    const s = new InMemoryThresholdOverrideStore();
    expect(() =>
      scanCustomerBreachesBulk(
        { tenant_id: 'BIL', customer_ids: [] },
        s,
        NOW,
      ),
    ).toThrow(/non-empty/);
  });

  test('> 50 customer_ids → invalid_input', () => {
    const s = new InMemoryThresholdOverrideStore();
    const ids = Array.from({ length: 51 }, (_, i) => `CUST-${i}`);
    expect(() =>
      scanCustomerBreachesBulk(
        { tenant_id: 'BIL', customer_ids: ids },
        s,
        NOW,
      ),
    ).toThrow(/batch cap/);
  });

  test('duplicate customer_id → invalid_input', () => {
    const s = new InMemoryThresholdOverrideStore();
    expect(() =>
      scanCustomerBreachesBulk(
        { tenant_id: 'BIL', customer_ids: ['CUST-1', 'CUST-1'] },
        s,
        NOW,
      ),
    ).toThrow(/duplicate/);
  });

  test('non-string customer_id → invalid_input', () => {
    const s = new InMemoryThresholdOverrideStore();
    expect(() =>
      scanCustomerBreachesBulk(
        {
          tenant_id: 'BIL',
          customer_ids: ['CUST-1', 42 as unknown as string],
        },
        s,
        NOW,
      ),
    ).toThrow(/non-empty string/);
  });
});

describe('POST /v1/indicators/scan-customers', () => {
  test('analyst+: 200 with results + aggregate', async () => {
    const { app } = makeScanApp('risk_analyst');
    const r = await request(app)
      .post('/v1/indicators/scan-customers')
      .set(TH_BIL)
      .send({ customer_ids: ['CUST-1', 'CUST-2', 'CUST-3'] });
    expect(r.status).toBe(200);
    expect(r.body.body.results.length).toBe(3);
    expect(r.body.body.aggregate.customer_count).toBe(3);
  });

  test('vertical filter via route', async () => {
    const { app } = makeScanApp('admin');
    const r = await request(app)
      .post('/v1/indicators/scan-customers')
      .set(TH_BIL)
      .send({ customer_ids: ['CUST-1'], vertical: 'banking' });
    expect(r.body.body.vertical).toBe('banking');
  });

  test('empty list → 400', async () => {
    const { app } = makeScanApp('admin');
    const r = await request(app)
      .post('/v1/indicators/scan-customers')
      .set(TH_BIL)
      .send({ customer_ids: [] });
    expect(r.status).toBe(400);
  });

  test('> 50 → 400', async () => {
    const { app } = makeScanApp('admin');
    const ids = Array.from({ length: 51 }, (_, i) => `CUST-${i}`);
    const r = await request(app)
      .post('/v1/indicators/scan-customers')
      .set(TH_BIL)
      .send({ customer_ids: ids });
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeScanApp('case_owner');
    const r = await request(app)
      .post('/v1/indicators/scan-customers')
      .set(TH_BIL)
      .send({ customer_ids: ['CUST-1'] });
    expect(r.status).toBe(403);
  });

  test('M4.5 single-scan still works (literal -customers didn\'t shadow)', async () => {
    const { app } = makeScanApp('admin');
    const r = await request(app)
      .post('/v1/indicators/scan-customer')
      .set(TH_BIL)
      .send({ customer_id: 'CUST-1' });
    expect(r.status).toBe(200);
    expect(r.body.body.breaches.length).toBe(17);
  });
});
