// Integration test — 50-customer synthetic batch.
//
// We seed half the customers as "healthy" (no breach expected) and half as
// "stressed" (multiple breaches expected). We then call the engine via the
// HTTP route and assert:
//   * every customer returns one value per catalog indicator
//   * healthy customers have 0 breaches
//   * stressed customers have ≥ 5 breaches
//   * registry-completeness still holds at the boundary
//
// Catalog size is derived at test time (loadCatalog().indicators.length) so
// adding/removing indicators doesn't re-break these assertions.

import request from 'supertest';
import { makeApp } from '../../src/server';
import { InMemoryMartReader, MartSnapshot } from '../../src/mart/reader';
import { loadCatalog } from '../../src/catalog';
import { baseCustomer, baseLoan, baseTxn } from '../fixtures';
import { MartCustomer360, MartLoan360, MartTxnFeatures } from '../../src/types';

const CATALOG_SIZE = loadCatalog().indicators.length;

function healthy(i: number): MartSnapshot {
  const id = `CUST-H-${i.toString().padStart(3, '0')}`;
  const customer: MartCustomer360 = baseCustomer({ customer_id: id });
  const loan: MartLoan360 = baseLoan({ loan_id: `LOAN-H-${i}`, customer_id: id });
  const txn: MartTxnFeatures = baseTxn({ customer_id: id });
  return { customer, loans: [loan], txn };
}

function stressed(i: number): MartSnapshot {
  const id = `CUST-S-${i.toString().padStart(3, '0')}`;
  const customer = baseCustomer({
    customer_id: id,
    overdraft_used: 95_000,           // FIN-008 breach
    overdraft_limit: 100_000,
    savings_balance: 5_000,           // FIN-003 breach (vs 200k outstanding)
    bureau_score: 660,                // CRD-001 breach
    bureau_score_prior_60d: 720,
    bureau_inquiries_90d: 4,          // CRD-002 breach
    contact_failures_30d: 5,          // BEH-008 breach
    complaints_60d: 3,                // BEH-005 breach
  });
  const loan = baseLoan({
    loan_id: `LOAN-S-${i}`,
    customer_id: id,
    days_past_due: 45,                // CRD-006 breach
    ifrs9_stage: 2,                   // CRD-005 breach
    ifrs9_stage_90d_ago: 1,
  });
  const txn = baseTxn({
    customer_id: id,
    bounced_payment_count_60d: 2,     // TXN-005 breach
    inflow_30d: 50_000,
    outflow_30d: 75_000,              // TXN-001 breach (1.5)
  });
  return { customer, loans: [loan], txn };
}

describe('Indicator batch endpoint', () => {
  const reader = new InMemoryMartReader();
  const SNAPSHOT = '2026-04-26';

  // 25 healthy + 25 stressed
  const healthyIds: string[] = [];
  const stressedIds: string[] = [];
  for (let i = 0; i < 25; i++) {
    const h = healthy(i);
    reader.put(h.customer.customer_id, SNAPSHOT, h);
    healthyIds.push(h.customer.customer_id);
    const s = stressed(i);
    reader.put(s.customer.customer_id, SNAPSHOT, s);
    stressedIds.push(s.customer.customer_id);
  }

  // RBAC for /indicators/compute is admin-only; rbac.test.ts asserts the
  // matrix paths separately. Inject getRole here so business-logic tests
  // exercise the engine without header dance.
  const app = makeApp({ reader, emitter: () => undefined, getRole: () => 'admin' });

  test('GET /healthz reports registry completeness', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.registry.catalog_size).toBe(CATALOG_SIZE);
    expect(res.body.registry.compute_size).toBe(CATALOG_SIZE);
    expect(res.body.registry.missing).toEqual([]);
  });

  test('POST /indicators/compute returns one value per catalog indicator (healthy)', async () => {
    const res = await request(app)
      .post('/indicators/compute')
      .send({ customer_id: healthyIds[0], snapshot_date: SNAPSHOT });
    expect(res.status).toBe(200);
    expect(res.body.values).toHaveLength(CATALOG_SIZE);
    expect(res.body.breached).toEqual([]);
  });

  test('POST /indicators/compute marks stressed customer as breached on multiple indicators', async () => {
    const res = await request(app)
      .post('/indicators/compute')
      .send({ customer_id: stressedIds[0], snapshot_date: SNAPSHOT });
    expect(res.status).toBe(200);
    expect(res.body.values).toHaveLength(CATALOG_SIZE);
    const breachedIds = (res.body.breached as { indicator_id: string }[]).map((r) => r.indicator_id);
    // expect at least these 9 to fire
    const expected = ['FIN-008', 'FIN-003', 'CRD-001', 'CRD-002', 'BEH-008',
                      'BEH-005', 'CRD-006', 'CRD-005', 'TXN-005', 'TXN-001'];
    for (const e of expected) {
      expect(breachedIds).toContain(e);
    }
    expect(breachedIds.length).toBeGreaterThanOrEqual(5);
  });

  test('POST /indicators/compute/batch — 50 customers all return values', async () => {
    const items = [...healthyIds, ...stressedIds].map((id) => ({
      customer_id: id,
      snapshot_date: SNAPSHOT,
    }));
    const res = await request(app)
      .post('/indicators/compute/batch')
      .send({ items });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(50);

    const healthyResults = res.body.results.filter(
      (r: { customer_id: string }) => r.customer_id.startsWith('CUST-H-'),
    );
    const stressedResults = res.body.results.filter(
      (r: { customer_id: string }) => r.customer_id.startsWith('CUST-S-'),
    );
    expect(healthyResults).toHaveLength(25);
    expect(stressedResults).toHaveLength(25);
    for (const r of healthyResults) {
      expect(r.values).toHaveLength(CATALOG_SIZE);
      expect(r.breached).toHaveLength(0);
    }
    for (const r of stressedResults) {
      expect(r.values).toHaveLength(CATALOG_SIZE);
      expect(r.breached.length).toBeGreaterThanOrEqual(5);
    }
  });

  test('POST /indicators/compute returns 404 when snapshot is absent', async () => {
    const res = await request(app)
      .post('/indicators/compute')
      .send({ customer_id: 'CUST-NOPE', snapshot_date: SNAPSHOT });
    expect(res.status).toBe(404);
  });

  test('POST /indicators/compute rejects missing fields', async () => {
    const res = await request(app)
      .post('/indicators/compute')
      .send({});
    expect(res.status).toBe(400);
  });

  test('POST /indicators/compute emits per-breached record', async () => {
    const seen: string[] = [];
    const localApp = makeApp({
      reader,
      getRole: () => 'admin',
      emitter: (rec) => {
        seen.push(rec.indicator_id);
      },
    });
    await request(localApp)
      .post('/indicators/compute')
      .send({ customer_id: stressedIds[0], snapshot_date: SNAPSHOT });
    expect(seen.length).toBeGreaterThanOrEqual(5);
  });
});
