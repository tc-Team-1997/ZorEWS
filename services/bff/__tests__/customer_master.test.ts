// services/bff/__tests__/customer_master.test.ts
//
// Phase B.1 — Customer Master Setup.

import request from 'supertest';
import {
  ALL_CUSTOMER_TYPES,
  ALL_KYC_STATUSES,
  ALL_RISK_CATEGORIES,
  CUSTOMER_MASTER_CAP_PER_TENANT,
  CustomerMasterError,
  defaultCustomerMasterStore,
  InMemoryCustomerMasterStore,
  isCustomerType,
  isKycStatus,
  isRiskCategory,
  listKycExpiringCustomers,
} from '../src/master/customer_master';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryRecoveryStore } from '../src/recovery/store';

const NOW = new Date('2026-05-21T09:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.admin' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'X-APEX-USER': 'admin' };

function makeCustApp(role: string = 'admin', overrides: {
  customerMasterStore?: InMemoryCustomerMasterStore;
  recoveryStore?: InMemoryRecoveryStore;
} = {}) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    customerMasterStore: overrides.customerMasterStore ?? new InMemoryCustomerMasterStore(),
    recoveryStore: overrides.recoveryStore ?? new InMemoryRecoveryStore(),
  });
  return app;
}

const validInput = (over: Record<string, unknown> = {}) => ({
  customer_id: 'CUST_BIL_00001',
  customer_type: 'retail' as const,
  segment: 'mass-market',
  kyc_status: 'verified' as const,
  pep_flag: false,
  country: 'IN',
  industry: 'agriculture',
  ...over,
});

// ─── 1. Enum invariants ────────────────────────────────────────────────

describe('Customer master enums', () => {
  test('5 customer types', () => {
    expect(ALL_CUSTOMER_TYPES.length).toBe(5);
    expect(new Set(ALL_CUSTOMER_TYPES).size).toBe(5);
  });
  test('5 kyc statuses', () => {
    expect(ALL_KYC_STATUSES.length).toBe(5);
  });
  test('3 risk categories worst-last (low/medium/high)', () => {
    expect(ALL_RISK_CATEGORIES).toEqual(['low', 'medium', 'high']);
  });
  test('type guards', () => {
    for (const t of ALL_CUSTOMER_TYPES) expect(isCustomerType(t)).toBe(true);
    expect(isCustomerType('bogus')).toBe(false);
    for (const k of ALL_KYC_STATUSES) expect(isKycStatus(k)).toBe(true);
    for (const r of ALL_RISK_CATEGORIES) expect(isRiskCategory(r)).toBe(true);
  });
});

// ─── 2. Store CRUD + tenant scoping ─────────────────────────────────

describe('InMemoryCustomerMasterStore — create validation', () => {
  test('happy path returns populated entry', () => {
    const s = new InMemoryCustomerMasterStore();
    const e = s.create('BIL', validInput(), 'alice.admin', NOW);
    expect(e.customer_id).toBe('CUST_BIL_00001');
    expect(e.customer_type).toBe('retail');
    expect(e.kyc_status).toBe('verified');
    expect(e.pep_flag).toBe(false);
    expect(e.risk_category).toBeNull();
    expect(e.active).toBe(true);
    expect(e.tenant_id).toBe('BIL');
  });

  test('invalid customer_id format → invalid_customer_id', () => {
    const s = new InMemoryCustomerMasterStore();
    expect(() => s.create('BIL', validInput({ customer_id: '' }), 'a', NOW)).toThrow(
      CustomerMasterError,
    );
    expect(() =>
      s.create('BIL', validInput({ customer_id: 'has spaces' }), 'a', NOW),
    ).toThrow(CustomerMasterError);
    expect(() =>
      s.create('BIL', validInput({ customer_id: 'x'.repeat(65) }), 'a', NOW),
    ).toThrow(CustomerMasterError);
  });

  test('invalid customer_type → invalid_type', () => {
    const s = new InMemoryCustomerMasterStore();
    expect(() =>
      s.create('BIL', validInput({ customer_type: 'BANK' }), 'a', NOW),
    ).toThrow(CustomerMasterError);
  });

  test('invalid kyc_status → invalid_kyc_status', () => {
    const s = new InMemoryCustomerMasterStore();
    expect(() =>
      s.create('BIL', validInput({ kyc_status: 'maybe' }), 'a', NOW),
    ).toThrow(CustomerMasterError);
  });

  test('invalid country (lowercase / wrong length) rejected', () => {
    const s = new InMemoryCustomerMasterStore();
    expect(() => s.create('BIL', validInput({ country: 'in' }), 'a', NOW)).toThrow(
      CustomerMasterError,
    );
    expect(() => s.create('BIL', validInput({ country: 'IND' }), 'a', NOW)).toThrow(
      CustomerMasterError,
    );
  });

  test('invalid risk_category rejected', () => {
    const s = new InMemoryCustomerMasterStore();
    expect(() =>
      s.create('BIL', validInput({ risk_category: 'critical' }), 'a', NOW),
    ).toThrow(CustomerMasterError);
  });

  test('null risk_category accepted (override-not-applied)', () => {
    const s = new InMemoryCustomerMasterStore();
    const e = s.create('BIL', validInput({ risk_category: null }), 'a', NOW);
    expect(e.risk_category).toBeNull();
  });

  test('non-ISO kyc_expires_at rejected', () => {
    const s = new InMemoryCustomerMasterStore();
    expect(() =>
      s.create('BIL', validInput({ kyc_expires_at: 'not-iso' }), 'a', NOW),
    ).toThrow(CustomerMasterError);
  });

  test('overlong segment/industry/notes rejected', () => {
    const s = new InMemoryCustomerMasterStore();
    expect(() =>
      s.create('BIL', validInput({ segment: 'x'.repeat(81) }), 'a', NOW),
    ).toThrow(CustomerMasterError);
    expect(() =>
      s.create('BIL', validInput({ industry: 'x'.repeat(81) }), 'a', NOW),
    ).toThrow(CustomerMasterError);
    expect(() =>
      s.create('BIL', validInput({ notes: 'x'.repeat(1001) }), 'a', NOW),
    ).toThrow(CustomerMasterError);
  });

  test('non-boolean pep_flag rejected', () => {
    const s = new InMemoryCustomerMasterStore();
    expect(() => s.create('BIL', validInput({ pep_flag: 1 as never }), 'a', NOW)).toThrow(
      CustomerMasterError,
    );
  });

  test('missing actor → invalid_input', () => {
    const s = new InMemoryCustomerMasterStore();
    expect(() => s.create('BIL', validInput(), '', NOW)).toThrow(CustomerMasterError);
  });
});

describe('InMemoryCustomerMasterStore — list/get/update/delete', () => {
  test('list orders PEP/high-priority first, then by customer_id asc', () => {
    const s = new InMemoryCustomerMasterStore();
    s.create('BIL', validInput({ customer_id: 'B', segment: null, pep_flag: false }), 'a', NOW);
    s.create('BIL', validInput({ customer_id: 'A', pep_flag: true }), 'a', NOW);
    s.create('BIL', validInput({ customer_id: 'C', pep_flag: false }), 'a', NOW);
    const items = s.list('BIL');
    // A is PEP=true → first; B + C tied at false → alpha order.
    expect(items.map((e) => e.customer_id)).toEqual(['A', 'B', 'C']);
  });

  test('filters: customer_type narrows correctly', () => {
    const s = new InMemoryCustomerMasterStore();
    s.create('BIL', validInput({ customer_id: 'R1', customer_type: 'retail' }), 'a', NOW);
    s.create('BIL', validInput({ customer_id: 'C1', customer_type: 'corporate' }), 'a', NOW);
    expect(s.list('BIL', { customer_type: 'corporate' }).map((e) => e.customer_id)).toEqual([
      'C1',
    ]);
  });

  test('filters: kyc_status narrows correctly', () => {
    const s = new InMemoryCustomerMasterStore();
    s.create('BIL', validInput({ customer_id: 'V1', kyc_status: 'verified' }), 'a', NOW);
    s.create('BIL', validInput({ customer_id: 'E1', kyc_status: 'expired' }), 'a', NOW);
    expect(s.list('BIL', { kyc_status: 'expired' }).map((e) => e.customer_id)).toEqual([
      'E1',
    ]);
  });

  test('filters: pep_flag=true narrows correctly', () => {
    const s = new InMemoryCustomerMasterStore();
    s.create('BIL', validInput({ customer_id: 'P1', pep_flag: true }), 'a', NOW);
    s.create('BIL', validInput({ customer_id: 'P2', pep_flag: false }), 'a', NOW);
    expect(s.list('BIL', { pep_flag: true }).map((e) => e.customer_id)).toEqual(['P1']);
  });

  test('filter: country narrows correctly', () => {
    const s = new InMemoryCustomerMasterStore();
    s.create('BIL', validInput({ customer_id: 'I1', country: 'IN' }), 'a', NOW);
    s.create('BIL', validInput({ customer_id: 'B1', country: 'BT' }), 'a', NOW);
    expect(s.list('BIL', { country: 'BT' }).map((e) => e.customer_id)).toEqual(['B1']);
  });

  test('duplicate customer_id → 409 code', () => {
    const s = new InMemoryCustomerMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    expect(() => s.create('BIL', validInput(), 'a', NOW)).toThrow(CustomerMasterError);
  });

  test('update applies patch + bumps audit fields', () => {
    const s = new InMemoryCustomerMasterStore();
    s.create('BIL', validInput(), 'alice', NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const u = s.update(
      'BIL',
      'CUST_BIL_00001',
      { pep_flag: true, risk_category: 'high', kyc_status: 'expired' },
      'bob',
      later,
    );
    expect(u.pep_flag).toBe(true);
    expect(u.risk_category).toBe('high');
    expect(u.kyc_status).toBe('expired');
    expect(u.updated_by).toBe('bob');
    expect(u.updated_at).toBe(later.toISOString());
    expect(u.created_by).toBe('alice');
  });

  test('update unknown_customer throws', () => {
    const s = new InMemoryCustomerMasterStore();
    expect(() => s.update('BIL', 'GHOST', { pep_flag: true }, 'a', NOW)).toThrow(
      CustomerMasterError,
    );
  });

  test('softDelete + restore round-trip', () => {
    const s = new InMemoryCustomerMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    const t = s.softDelete('BIL', 'CUST_BIL_00001', 'b', NOW);
    expect(t.deleted_at).toBe(NOW.toISOString());
    expect(s.get('BIL', 'CUST_BIL_00001')).toBeNull();
    expect(s.restore(t)).toBe(true);
    expect(s.get('BIL', 'CUST_BIL_00001')?.deleted_at).toBeNull();
  });

  test('restore conflict on live row', () => {
    const s = new InMemoryCustomerMasterStore();
    const e = s.create('BIL', validInput(), 'a', NOW);
    expect(s.restore(e)).toBe(false);
  });

  test('tenant scoping — BIL invisible to BANK_DEMO', () => {
    const s = new InMemoryCustomerMasterStore();
    s.create('BIL', validInput(), 'a', NOW);
    s.create('BANK_DEMO', validInput({ customer_id: 'BANK_001' }), 'a', NOW);
    expect(s.list('BIL').map((e) => e.customer_id)).toEqual(['CUST_BIL_00001']);
    expect(s.list('BANK_DEMO').map((e) => e.customer_id)).toEqual(['BANK_001']);
  });

  test('defensive copy', () => {
    const s = new InMemoryCustomerMasterStore();
    const e = s.create('BIL', validInput(), 'a', NOW);
    (e as { country: string }).country = 'XX';
    expect(s.get('BIL', 'CUST_BIL_00001')?.country).toBe('IN');
  });
});

// ─── 3. KYC-expiring helper ──────────────────────────────────────────

describe('listKycExpiringCustomers', () => {
  test('surfaces already-expired + within-30-days; excludes still-valid', () => {
    const s = new InMemoryCustomerMasterStore();
    const past = new Date(NOW.getTime() - 86_400_000).toISOString();
    const within = new Date(NOW.getTime() + 5 * 86_400_000).toISOString();
    const far = new Date(NOW.getTime() + 90 * 86_400_000).toISOString();
    s.create('BIL', validInput({ customer_id: 'A', kyc_expires_at: past }), 'a', NOW);
    s.create('BIL', validInput({ customer_id: 'B', kyc_expires_at: within }), 'a', NOW);
    s.create('BIL', validInput({ customer_id: 'C', kyc_expires_at: far }), 'a', NOW);
    const items = listKycExpiringCustomers(s, 'BIL', NOW, 30);
    expect(items.map((e) => e.customer_id)).toEqual(['A', 'B']);
  });

  test('exempt customers excluded', () => {
    const s = new InMemoryCustomerMasterStore();
    const past = new Date(NOW.getTime() - 86_400_000).toISOString();
    s.create(
      'BIL',
      validInput({ customer_id: 'EX', kyc_status: 'exempt', kyc_expires_at: past }),
      'a',
      NOW,
    );
    expect(listKycExpiringCustomers(s, 'BIL', NOW, 30)).toEqual([]);
  });

  test('customers without kyc_expires_at excluded', () => {
    const s = new InMemoryCustomerMasterStore();
    s.create('BIL', validInput({ customer_id: 'X', kyc_expires_at: null }), 'a', NOW);
    expect(listKycExpiringCustomers(s, 'BIL', NOW, 30)).toEqual([]);
  });

  test('configurable lookahead_days', () => {
    const s = new InMemoryCustomerMasterStore();
    const t10 = new Date(NOW.getTime() + 10 * 86_400_000).toISOString();
    s.create('BIL', validInput({ customer_id: 'X', kyc_expires_at: t10 }), 'a', NOW);
    expect(listKycExpiringCustomers(s, 'BIL', NOW, 5)).toEqual([]);
    expect(listKycExpiringCustomers(s, 'BIL', NOW, 15).length).toBe(1);
  });

  test('sorted by expiry ASC (soonest first)', () => {
    const s = new InMemoryCustomerMasterStore();
    const t5 = new Date(NOW.getTime() + 5 * 86_400_000).toISOString();
    const t10 = new Date(NOW.getTime() + 10 * 86_400_000).toISOString();
    const t20 = new Date(NOW.getTime() + 20 * 86_400_000).toISOString();
    s.create('BIL', validInput({ customer_id: 'C', kyc_expires_at: t20 }), 'a', NOW);
    s.create('BIL', validInput({ customer_id: 'A', kyc_expires_at: t5 }), 'a', NOW);
    s.create('BIL', validInput({ customer_id: 'B', kyc_expires_at: t10 }), 'a', NOW);
    expect(listKycExpiringCustomers(s, 'BIL', NOW, 30).map((e) => e.customer_id)).toEqual([
      'A',
      'B',
      'C',
    ]);
  });
});

// ─── 4. Routes ─────────────────────────────────────────────────────────

describe('GET /v1/master/customers/types', () => {
  test('admin happy → enums', async () => {
    const app = makeCustApp('admin');
    const r = await request(app).get('/v1/master/customers/types').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.customer_types).toEqual([...ALL_CUSTOMER_TYPES]);
    expect(r.body.body.kyc_statuses).toEqual([...ALL_KYC_STATUSES]);
    expect(r.body.body.risk_categories).toEqual([...ALL_RISK_CATEGORIES]);
  });
  test('non-admin → 403', async () => {
    const app = makeCustApp('field_officer');
    const r = await request(app).get('/v1/master/customers/types').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/master/customers', () => {
  test('happy 201', async () => {
    const app = makeCustApp('admin');
    const r = await request(app).post('/v1/master/customers').set(TH_BIL).send(validInput());
    expect(r.status).toBe(201);
    expect(r.body.body.customer_id).toBe('CUST_BIL_00001');
    expect(r.body.body.created_by).toBe('alice.admin');
  });

  test('enveloped body honoured', async () => {
    const app = makeCustApp('admin');
    const r = await request(app)
      .post('/v1/master/customers')
      .set(TH_BIL)
      .send({ header: {}, body: validInput() });
    expect(r.status).toBe(201);
  });

  test('duplicate → 409', async () => {
    const store = new InMemoryCustomerMasterStore();
    const app = makeCustApp('admin', { customerMasterStore: store });
    await request(app).post('/v1/master/customers').set(TH_BIL).send(validInput());
    const r = await request(app).post('/v1/master/customers').set(TH_BIL).send(validInput());
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_duplicate_customer_id');
  });

  test('invalid customer_type → 400', async () => {
    const app = makeCustApp('admin');
    const r = await request(app)
      .post('/v1/master/customers')
      .set(TH_BIL)
      .send(validInput({ customer_type: 'bogus' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_type');
  });

  test('invalid kyc_status → 400', async () => {
    const app = makeCustApp('admin');
    const r = await request(app)
      .post('/v1/master/customers')
      .set(TH_BIL)
      .send(validInput({ kyc_status: 'maybe' }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_kyc_status');
  });

  test('non-admin → 403', async () => {
    const app = makeCustApp('field_officer');
    const r = await request(app).post('/v1/master/customers').set(TH_BIL).send(validInput());
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/master/customers + filters', () => {
  test('tenant scoping', async () => {
    const store = new InMemoryCustomerMasterStore();
    const app = makeCustApp('admin', { customerMasterStore: store });
    await request(app).post('/v1/master/customers').set(TH_BIL).send(validInput());
    await request(app)
      .post('/v1/master/customers')
      .set(TH_BANK)
      .send(validInput({ customer_id: 'BANK_001' }));
    const rBIL = await request(app).get('/v1/master/customers').set(TH_BIL);
    expect(rBIL.body.body.total).toBe(1);
    expect(rBIL.body.body.items[0].customer_id).toBe('CUST_BIL_00001');
    const rBANK = await request(app).get('/v1/master/customers').set(TH_BANK);
    expect(rBANK.body.body.items[0].customer_id).toBe('BANK_001');
  });

  test('?pep_flag=true narrows', async () => {
    const store = new InMemoryCustomerMasterStore();
    const app = makeCustApp('admin', { customerMasterStore: store });
    await request(app).post('/v1/master/customers').set(TH_BIL).send(validInput());
    await request(app)
      .post('/v1/master/customers')
      .set(TH_BIL)
      .send(validInput({ customer_id: 'PEP_01', pep_flag: true }));
    const r = await request(app).get('/v1/master/customers?pep_flag=true').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
    expect(r.body.body.items[0].customer_id).toBe('PEP_01');
  });

  test('?customer_type=bogus → 400', async () => {
    const app = makeCustApp('admin');
    const r = await request(app).get('/v1/master/customers?customer_type=bogus').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_type');
  });

  test('?pep_flag=foo → 400', async () => {
    const app = makeCustApp('admin');
    const r = await request(app).get('/v1/master/customers?pep_flag=foo').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_pep_flag');
  });

  test('?country=in (lowercase) → 400', async () => {
    const app = makeCustApp('admin');
    const r = await request(app).get('/v1/master/customers?country=in').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_country');
  });
});

describe('GET /v1/master/customers/kyc-expiring', () => {
  test('default lookahead_days=30 surfaces expiring + expired', async () => {
    const store = new InMemoryCustomerMasterStore();
    const app = makeCustApp('admin', { customerMasterStore: store });
    const past = new Date(NOW.getTime() - 86_400_000).toISOString();
    const within = new Date(NOW.getTime() + 5 * 86_400_000).toISOString();
    await request(app)
      .post('/v1/master/customers')
      .set(TH_BIL)
      .send(validInput({ customer_id: 'A', kyc_expires_at: past }));
    await request(app)
      .post('/v1/master/customers')
      .set(TH_BIL)
      .send(validInput({ customer_id: 'B', kyc_expires_at: within }));
    const r = await request(app).get('/v1/master/customers/kyc-expiring').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.lookahead_days).toBe(30);
    expect(r.body.body.total).toBe(2);
  });

  test('?lookahead_days=5 narrows', async () => {
    const store = new InMemoryCustomerMasterStore();
    const app = makeCustApp('admin', { customerMasterStore: store });
    const within10 = new Date(NOW.getTime() + 10 * 86_400_000).toISOString();
    await request(app)
      .post('/v1/master/customers')
      .set(TH_BIL)
      .send(validInput({ customer_id: 'A', kyc_expires_at: within10 }));
    const r = await request(app)
      .get('/v1/master/customers/kyc-expiring?lookahead_days=5')
      .set(TH_BIL);
    expect(r.body.body.total).toBe(0);
  });

  test('?lookahead_days=400 → 400', async () => {
    const app = makeCustApp('admin');
    const r = await request(app)
      .get('/v1/master/customers/kyc-expiring?lookahead_days=400')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_lookahead_days');
  });
});

describe('GET /v1/master/customers/:customer_id', () => {
  test('happy', async () => {
    const store = new InMemoryCustomerMasterStore();
    const app = makeCustApp('admin', { customerMasterStore: store });
    await request(app).post('/v1/master/customers').set(TH_BIL).send(validInput());
    const r = await request(app).get('/v1/master/customers/CUST_BIL_00001').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.customer_id).toBe('CUST_BIL_00001');
  });

  test('unknown → 404', async () => {
    const app = makeCustApp('admin');
    const r = await request(app).get('/v1/master/customers/GHOST').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_customer');
  });

  test('cross-tenant → 404', async () => {
    const store = new InMemoryCustomerMasterStore();
    const app = makeCustApp('admin', { customerMasterStore: store });
    await request(app).post('/v1/master/customers').set(TH_BIL).send(validInput());
    const r = await request(app).get('/v1/master/customers/CUST_BIL_00001').set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('PATCH /v1/master/customers/:customer_id', () => {
  test('happy', async () => {
    const store = new InMemoryCustomerMasterStore();
    const app = makeCustApp('admin', { customerMasterStore: store });
    await request(app).post('/v1/master/customers').set(TH_BIL).send(validInput());
    const r = await request(app)
      .patch('/v1/master/customers/CUST_BIL_00001')
      .set(TH_BIL)
      .send({ pep_flag: true, risk_category: 'high' });
    expect(r.status).toBe(200);
    expect(r.body.body.pep_flag).toBe(true);
    expect(r.body.body.risk_category).toBe('high');
  });

  test('unknown → 404', async () => {
    const app = makeCustApp('admin');
    const r = await request(app)
      .patch('/v1/master/customers/GHOST')
      .set(TH_BIL)
      .send({ pep_flag: true });
    expect(r.status).toBe(404);
  });

  test('invalid patch field → 400', async () => {
    const store = new InMemoryCustomerMasterStore();
    const app = makeCustApp('admin', { customerMasterStore: store });
    await request(app).post('/v1/master/customers').set(TH_BIL).send(validInput());
    const r = await request(app)
      .patch('/v1/master/customers/CUST_BIL_00001')
      .set(TH_BIL)
      .send({ risk_category: 'unknown' });
    expect(r.status).toBe(400);
  });
});

describe('DELETE /v1/master/customers/:customer_id + recovery', () => {
  test('soft-delete + archive', async () => {
    const store = new InMemoryCustomerMasterStore();
    const recovery = new InMemoryRecoveryStore();
    const app = makeCustApp('admin', {
      customerMasterStore: store,
      recoveryStore: recovery,
    });
    await request(app).post('/v1/master/customers').set(TH_BIL).send(validInput());
    const r = await request(app).delete('/v1/master/customers/CUST_BIL_00001').set(TH_BIL);
    expect(r.status).toBe(204);
    const live = await request(app).get('/v1/master/customers').set(TH_BIL);
    expect(live.body.body.total).toBe(0);
    const archived = await recovery.list({ tenant_id: 'BIL', entity_type: 'customer_master' });
    expect(archived.items.length).toBe(1);
    expect(archived.items[0].original_id).toBe('CUST_BIL_00001');
    expect(archived.items[0].original_table).toBe('app_master.customers');
  });

  test('unknown → 404', async () => {
    const app = makeCustApp('admin');
    const r = await request(app).delete('/v1/master/customers/GHOST').set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('non-admin → 403', async () => {
    const app = makeCustApp('field_officer');
    const r = await request(app).delete('/v1/master/customers/CUST_BIL_00001').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

// ─── 5. Cap test (small isolated test to avoid timeouts) ──────────────

describe('CUSTOMER_MASTER_CAP_PER_TENANT', () => {
  test('cap constant exported', () => {
    expect(CUSTOMER_MASTER_CAP_PER_TENANT).toBeGreaterThan(0);
    expect(CUSTOMER_MASTER_CAP_PER_TENANT).toBeLessThan(1_000_000);
  });
});

// ─── 6. Singleton sanity ──────────────────────────────────────────────

describe('defaultCustomerMasterStore', () => {
  test('exposes IStore interface', () => {
    expect(defaultCustomerMasterStore).toBeDefined();
    expect(typeof defaultCustomerMasterStore.list).toBe('function');
    expect(typeof defaultCustomerMasterStore.create).toBe('function');
    expect(typeof defaultCustomerMasterStore.softDelete).toBe('function');
    expect(typeof defaultCustomerMasterStore.restore).toBe('function');
  });
});
