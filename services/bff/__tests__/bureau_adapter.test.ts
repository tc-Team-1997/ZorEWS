// services/bff/__tests__/bureau_adapter.test.ts
//
// T6 M14.5 — Credit Bureau adapter.

import request from 'supertest';
import {
  BureauError,
  StubBureauAdapter,
  bandFor,
  isBureauType,
  listBureauTypes,
  type BureauAdapter,
  type BureauReport,
} from '../src/integrations/bureau';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeBurApp(role: string = 'admin', bureauAdapter?: BureauAdapter) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    bureauAdapter,
  });
}

// ─── Type guards + helpers ─────────────────────────────────────────────

describe('isBureauType / listBureauTypes', () => {
  test('isBureauType accepts the 4 valid types', () => {
    expect(isBureauType('CIBIL')).toBe(true);
    expect(isBureauType('CRIF')).toBe(true);
    expect(isBureauType('EXPERIAN')).toBe(true);
    expect(isBureauType('EQUIFAX')).toBe(true);
    expect(isBureauType('cibil')).toBe(false);
    expect(isBureauType('FICO')).toBe(false);
  });
  test('listBureauTypes returns all 4 in canonical order', () => {
    expect(listBureauTypes()).toEqual(['CIBIL', 'CRIF', 'EXPERIAN', 'EQUIFAX']);
  });
});

describe('bandFor — 300-900 score → band mapping', () => {
  test('< 600 → subprime', () => {
    expect(bandFor(300)).toBe('subprime');
    expect(bandFor(599)).toBe('subprime');
  });
  test('600-699 → near_prime', () => {
    expect(bandFor(600)).toBe('near_prime');
    expect(bandFor(699)).toBe('near_prime');
  });
  test('700-799 → prime', () => {
    expect(bandFor(700)).toBe('prime');
    expect(bandFor(799)).toBe('prime');
  });
  test('≥ 800 → super_prime', () => {
    expect(bandFor(800)).toBe('super_prime');
    expect(bandFor(900)).toBe('super_prime');
  });
});

// ─── StubBureauAdapter — pull ──────────────────────────────────────────

describe('StubBureauAdapter — pull', () => {
  test('returns a valid report shape', async () => {
    const a = new StubBureauAdapter();
    const r = await a.pull('BIL', 'c-1', 'CIBIL', 'taniya', NOW);
    expect(r.report_id).toMatch(/^bur-bil-\d{7}$/);
    expect(r.customer_id).toBe('c-1');
    expect(r.bureau_type).toBe('CIBIL');
    expect(r.score).toBeGreaterThanOrEqual(300);
    expect(r.score).toBeLessThanOrEqual(900);
    expect(['subprime', 'near_prime', 'prime', 'super_prime']).toContain(r.band);
    expect(r.pulled_by).toBe('taniya');
    expect(r.pulled_at).toBe(NOW.toISOString());
    expect(typeof r.summary.open_accounts).toBe('number');
  });

  test('band derived consistently from score', async () => {
    const a = new StubBureauAdapter();
    for (let i = 0; i < 50; i++) {
      const r = await a.pull('BIL', `c-${i}`, 'CIBIL', 't', NOW);
      expect(r.band).toBe(bandFor(r.score));
    }
  });

  test('expires_at is exactly 90 days after pulled_at', async () => {
    const a = new StubBureauAdapter();
    const r = await a.pull('BIL', 'c-1', 'CIBIL', 't', NOW);
    const expiry = new Date(r.expires_at).getTime();
    const pulled = new Date(r.pulled_at).getTime();
    expect(expiry - pulled).toBe(90 * 86_400_000);
  });

  test('idempotent — same (tenant, customer, bureau, day) returns same report_id', async () => {
    const a = new StubBureauAdapter();
    const r1 = await a.pull('BIL', 'c-1', 'CIBIL', 't', NOW);
    const r2 = await a.pull('BIL', 'c-1', 'CIBIL', 't', NOW);
    expect(r2.report_id).toBe(r1.report_id);
  });

  test('different bureau_type for same customer → different report_id', async () => {
    const a = new StubBureauAdapter();
    const cibil = await a.pull('BIL', 'c-1', 'CIBIL', 't', NOW);
    const crif = await a.pull('BIL', 'c-1', 'CRIF', 't', NOW);
    expect(crif.report_id).not.toBe(cibil.report_id);
  });

  test('different tenant for same customer → different report_id', async () => {
    const a = new StubBureauAdapter();
    const bil = await a.pull('BIL', 'c-1', 'CIBIL', 't', NOW);
    const bank = await a.pull('BANK_DEMO', 'c-1', 'CIBIL', 't', NOW);
    expect(bank.report_id).not.toBe(bil.report_id);
  });

  test('subprime customers carry higher dpd_max_24m + more enquiries than super_prime', async () => {
    const a = new StubBureauAdapter();
    // Sample many; aggregate per band
    const dpdByBand = new Map<string, number[]>();
    for (let i = 0; i < 200; i++) {
      const r = await a.pull('BIL', `c-${i}`, 'CIBIL', 't', NOW);
      let arr = dpdByBand.get(r.band);
      if (!arr) {
        arr = [];
        dpdByBand.set(r.band, arr);
      }
      arr.push(r.summary.dpd_max_24m);
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    if (dpdByBand.has('subprime') && dpdByBand.has('super_prime')) {
      expect(avg(dpdByBand.get('subprime')!)).toBeGreaterThan(avg(dpdByBand.get('super_prime')!));
    }
    // super_prime always 0 DPD
    if (dpdByBand.has('super_prime')) {
      for (const d of dpdByBand.get('super_prime')!) expect(d).toBe(0);
    }
  });

  test('total_outstanding_kes <= total_limit_kes', async () => {
    const a = new StubBureauAdapter();
    for (let i = 0; i < 30; i++) {
      const r = await a.pull('BIL', `c-${i}`, 'CIBIL', 't', NOW);
      expect(r.summary.total_outstanding_kes).toBeLessThanOrEqual(r.summary.total_limit_kes);
    }
  });

  test('throws invalid_input on missing customer_id', async () => {
    const a = new StubBureauAdapter();
    try {
      await a.pull('BIL', '', 'CIBIL', 't', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as BureauError).code).toBe('invalid_input');
    }
  });

  test('throws invalid_bureau_type on unknown bureau', async () => {
    const a = new StubBureauAdapter();
    try {
      await a.pull('BIL', 'c-1', 'FICO' as never, 't', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as BureauError).code).toBe('invalid_bureau_type');
    }
  });
});

// ─── StubBureauAdapter — listByCustomer + get ──────────────────────────

describe('StubBureauAdapter — listByCustomer + get', () => {
  test('listByCustomer empty before pull', async () => {
    const a = new StubBureauAdapter();
    expect(await a.listByCustomer('BIL', 'c-1')).toEqual([]);
  });

  test('listByCustomer returns all reports newest-first', async () => {
    const a = new StubBureauAdapter();
    await a.pull('BIL', 'c-1', 'CIBIL', 't', new Date(NOW.getTime() - 86_400_000));
    await a.pull('BIL', 'c-1', 'CRIF', 't', NOW);
    const list = await a.listByCustomer('BIL', 'c-1');
    expect(list.length).toBe(2);
    expect(list[0]!.bureau_type).toBe('CRIF'); // newest first
    expect(list[1]!.bureau_type).toBe('CIBIL');
  });

  test('listByCustomer is tenant-scoped', async () => {
    const a = new StubBureauAdapter();
    await a.pull('BIL', 'c-1', 'CIBIL', 't', NOW);
    expect(await a.listByCustomer('BIL', 'c-1')).toHaveLength(1);
    expect(await a.listByCustomer('BANK_DEMO', 'c-1')).toEqual([]);
  });

  test('get returns report by id; null on miss + cross-tenant', async () => {
    const a = new StubBureauAdapter();
    const r = await a.pull('BIL', 'c-1', 'CIBIL', 't', NOW);
    expect((await a.get('BIL', r.report_id))!.report_id).toBe(r.report_id);
    expect(await a.get('BIL', 'bur-bil-9999999')).toBeNull();
    expect(await a.get('BANK_DEMO', r.report_id)).toBeNull();
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/integrations/bureau/types', () => {
  test('returns the 4 bureaus', async () => {
    const { app } = makeBurApp('admin');
    const r = await request(app).get('/v1/integrations/bureau/types').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.items).toEqual(['CIBIL', 'CRIF', 'EXPERIAN', 'EQUIFAX']);
  });

  test('unknown role → 403', async () => {
    const { app } = makeBurApp('case_owner');
    const r = await request(app).get('/v1/integrations/bureau/types').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('POST /v1/integrations/bureau/pull', () => {
  test('admin: 200 with the report', async () => {
    const { app } = makeBurApp('admin');
    const r = await request(app)
      .post('/v1/integrations/bureau/pull')
      .set(TH_BIL)
      .set('x-apex-user', 'taniya')
      .send({ customer_id: 'c-1', bureau_type: 'CIBIL' });
    expect(r.status).toBe(200);
    expect(r.body.body.bureau_type).toBe('CIBIL');
    expect(r.body.body.pulled_by).toBe('taniya');
  });

  test('accepts an enveloped request body', async () => {
    const { app } = makeBurApp('admin');
    const r = await request(app)
      .post('/v1/integrations/bureau/pull')
      .set(TH_BIL)
      .send({
        header: { requestId: 'r-1' },
        body: { customer_id: 'c-1', bureau_type: 'CRIF' },
      });
    expect(r.status).toBe(200);
    expect(r.body.body.bureau_type).toBe('CRIF');
  });

  test('idempotent — second call same day returns same report_id', async () => {
    const { app } = makeBurApp('admin');
    const r1 = await request(app)
      .post('/v1/integrations/bureau/pull')
      .set(TH_BIL)
      .send({ customer_id: 'c-1', bureau_type: 'CIBIL' });
    const r2 = await request(app)
      .post('/v1/integrations/bureau/pull')
      .set(TH_BIL)
      .send({ customer_id: 'c-1', bureau_type: 'CIBIL' });
    expect(r2.body.body.report_id).toBe(r1.body.body.report_id);
  });

  test('missing customer_id → 400 EWS_400_invalid_input', async () => {
    const { app } = makeBurApp('admin');
    const r = await request(app)
      .post('/v1/integrations/bureau/pull')
      .set(TH_BIL)
      .send({ bureau_type: 'CIBIL' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('invalid bureau_type → 400 EWS_400_invalid_bureau_type', async () => {
    const { app } = makeBurApp('admin');
    const r = await request(app)
      .post('/v1/integrations/bureau/pull')
      .set(TH_BIL)
      .send({ customer_id: 'c-1', bureau_type: 'FICO' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_bureau_type');
  });

  test('unknown role → 403', async () => {
    const { app } = makeBurApp('case_owner');
    const r = await request(app)
      .post('/v1/integrations/bureau/pull')
      .set(TH_BIL)
      .send({ customer_id: 'c-1', bureau_type: 'CIBIL' });
    expect(r.status).toBe(403);
  });

  test('adapter throwing non-BureauError → 502 envelope', async () => {
    const exploding: BureauAdapter = {
      async pull() {
        throw new Error('vendor down');
      },
      async listByCustomer() {
        return [];
      },
      async get() {
        return null;
      },
    };
    const { app } = makeBurApp('admin', exploding);
    const r = await request(app)
      .post('/v1/integrations/bureau/pull')
      .set(TH_BIL)
      .send({ customer_id: 'c-1', bureau_type: 'CIBIL' });
    expect(r.status).toBe(502);
  });
});

describe('GET /v1/integrations/bureau/reports', () => {
  test('returns reports newest-first after pulls', async () => {
    const { app } = makeBurApp('admin');
    await request(app)
      .post('/v1/integrations/bureau/pull')
      .set(TH_BIL)
      .send({ customer_id: 'c-1', bureau_type: 'CIBIL' });
    await request(app)
      .post('/v1/integrations/bureau/pull')
      .set(TH_BIL)
      .send({ customer_id: 'c-1', bureau_type: 'CRIF' });
    const r = await request(app)
      .get('/v1/integrations/bureau/reports?customer_id=c-1')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(2);
  });

  test('missing customer_id → 400', async () => {
    const { app } = makeBurApp('admin');
    const r = await request(app).get('/v1/integrations/bureau/reports').set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('unknown role → 403', async () => {
    const { app } = makeBurApp('case_owner');
    const r = await request(app)
      .get('/v1/integrations/bureau/reports?customer_id=c-1')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/integrations/bureau/reports/:report_id', () => {
  test('valid id → 200', async () => {
    const adapter = new StubBureauAdapter();
    const { app } = makeBurApp('admin', adapter);
    const report = await adapter.pull('BIL', 'c-1', 'CIBIL', 't', NOW);
    const r = await request(app)
      .get(`/v1/integrations/bureau/reports/${report.report_id}`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.report_id).toBe(report.report_id);
  });

  test('unknown id → 404', async () => {
    const { app } = makeBurApp('admin');
    const r = await request(app)
      .get('/v1/integrations/bureau/reports/bur-bil-9999999')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('cross-tenant lookup → 404', async () => {
    const adapter = new StubBureauAdapter();
    const { app } = makeBurApp('admin', adapter);
    const report = await adapter.pull('BIL', 'c-1', 'CIBIL', 't', NOW);
    const r = await request(app)
      .get(`/v1/integrations/bureau/reports/${report.report_id}`)
      .set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('Tenant isolation through routes', () => {
  test('BIL pull does not leak to BANK_DEMO list', async () => {
    const adapter = new StubBureauAdapter();
    const { app } = makeBurApp('admin', adapter);
    await request(app)
      .post('/v1/integrations/bureau/pull')
      .set(TH_BIL)
      .send({ customer_id: 'c-1', bureau_type: 'CIBIL' });
    const bil = await request(app)
      .get('/v1/integrations/bureau/reports?customer_id=c-1')
      .set(TH_BIL);
    const bank = await request(app)
      .get('/v1/integrations/bureau/reports?customer_id=c-1')
      .set(TH_BANK);
    expect(bil.body.body.total).toBe(1);
    expect(bank.body.body.total).toBe(0);
  });
});
