// services/bff/__tests__/insurance_adapter.test.ts
//
// T6 M14.1 — Core Insurance / Policy Master adapter.
//
// Three layers:
//   1. StubInsuranceAdapter — determinism, sort invariants, id-decode
//      contract for getPolicy/getClaim, tenant scoping
//   2. The 4 routes — RBAC, envelope, validation, 404 path

import request from 'supertest';
import {
  StubInsuranceAdapter,
  type Claim,
  type InsuranceAdapter,
  type Policy,
} from '../src/integrations/insurance';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeInsApp(role: string = 'admin', insuranceAdapter?: InsuranceAdapter) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    insuranceAdapter,
  });
}

// ─── StubInsuranceAdapter ──────────────────────────────────────────────

describe('StubInsuranceAdapter — listPolicies', () => {
  test('returns 1-4 policies for any customer', async () => {
    const a = new StubInsuranceAdapter();
    const policies = await a.listPolicies('BIL', 'c-101', NOW);
    expect(policies.length).toBeGreaterThanOrEqual(1);
    expect(policies.length).toBeLessThanOrEqual(4);
  });

  test('deterministic — same (tenant, customer, day) → same payload', async () => {
    const a = new StubInsuranceAdapter();
    const a1 = await a.listPolicies('BIL', 'c-101', NOW);
    const a2 = await a.listPolicies('BIL', 'c-101', NOW);
    expect(a1).toEqual(a2);
  });

  test('different tenants → different policy ids for same customer', async () => {
    const a = new StubInsuranceAdapter();
    const bil = await a.listPolicies('BIL', 'c-101', NOW);
    const bank = await a.listPolicies('BANK_DEMO', 'c-101', NOW);
    const bilIds = new Set(bil.map((p) => p.policy_id));
    const bankIds = new Set(bank.map((p) => p.policy_id));
    // Stub uses tenant in seed AND policy_id prefix — sets are disjoint.
    for (const id of bilIds) expect(bankIds.has(id)).toBe(false);
  });

  test('sorted newest-inception-first', async () => {
    const a = new StubInsuranceAdapter();
    const policies = await a.listPolicies('BIL', 'c-many-policies', NOW);
    for (let i = 1; i < policies.length; i++) {
      expect(policies[i - 1]!.inception_date >= policies[i]!.inception_date).toBe(true);
    }
  });

  test('every policy has required fields, valid product + status', async () => {
    const a = new StubInsuranceAdapter();
    const policies = await a.listPolicies('BIL', 'c-101', NOW);
    for (const p of policies) {
      expect(p.policy_id).toMatch(/^POL-[A-Z]{3}-\d{6}$/);
      expect(p.customer_id).toBe('c-101');
      expect(['TERM_LIFE', 'ENDOWMENT', 'ULIP', 'GENERAL_HEALTH']).toContain(p.product);
      expect(['in_force', 'lapsed', 'cancelled', 'matured', 'pending_uw']).toContain(p.status);
      expect(p.sum_assured_kes).toBeGreaterThan(0);
      expect(p.annual_premium_kes).toBeGreaterThan(0);
      expect(p.annual_premium_kes).toBeLessThan(p.sum_assured_kes);
      expect(p.inception_date < p.maturity_date || p.maturity_date < NOW.toISOString()).toBe(true);
      expect(Array.isArray(p.riders)).toBe(true);
      expect(p.agent_id).toMatch(/^AGT-\d{4}$/);
    }
  });

  test('riders are deduplicated when present', async () => {
    const a = new StubInsuranceAdapter();
    const policies = await a.listPolicies('BIL', 'c-rider-test', NOW);
    for (const p of policies) {
      expect(new Set(p.riders).size).toBe(p.riders.length);
    }
  });

  test('lapsed policy has premium_paid_current_period=false', async () => {
    const a = new StubInsuranceAdapter();
    // Sample many customers — some will produce lapsed policies.
    let sawLapsed = false;
    for (let i = 0; i < 50; i++) {
      const policies = await a.listPolicies('BIL', `c-${i}`, NOW);
      for (const p of policies) {
        if (p.status === 'lapsed') {
          sawLapsed = true;
          expect(p.premium_paid_current_period).toBe(false);
        }
      }
    }
    expect(sawLapsed).toBe(true);
  });

  test('empty customer_id → empty list', async () => {
    const a = new StubInsuranceAdapter();
    expect(await a.listPolicies('BIL', '', NOW)).toEqual([]);
  });
});

describe('StubInsuranceAdapter — getPolicy', () => {
  test('round-trip: a policy from listPolicies can be fetched by id', async () => {
    const a = new StubInsuranceAdapter();
    const policies = await a.listPolicies('BIL', 'c-101', NOW);
    const p = policies[0]!;
    const fetched = await a.getPolicy('BIL', p.policy_id, NOW);
    expect(fetched).not.toBeNull();
    expect(fetched!.policy_id).toBe(p.policy_id);
    // The stub synthesises from id, so fields aren't byte-identical, but
    // policy_id + product + status + agent shape must hold.
    expect(['TERM_LIFE', 'ENDOWMENT', 'ULIP', 'GENERAL_HEALTH']).toContain(fetched!.product);
  });

  test('malformed policy_id → null', async () => {
    const a = new StubInsuranceAdapter();
    expect(await a.getPolicy('BIL', 'not-a-policy', NOW)).toBeNull();
    expect(await a.getPolicy('BIL', 'POL-XX-1', NOW)).toBeNull();
    expect(await a.getPolicy('BIL', '', NOW)).toBeNull();
  });
});

describe('StubInsuranceAdapter — listClaims', () => {
  test('returns 0 to (#policies × 3) claims', async () => {
    const a = new StubInsuranceAdapter();
    const policies = await a.listPolicies('BIL', 'c-101', NOW);
    const claims = await a.listClaims('BIL', 'c-101', NOW);
    expect(claims.length).toBeGreaterThanOrEqual(0);
    expect(claims.length).toBeLessThanOrEqual(policies.length * 3);
  });

  test('every claim links back to one of the customer\'s policies', async () => {
    const a = new StubInsuranceAdapter();
    const policies = await a.listPolicies('BIL', 'c-many-claims', NOW);
    const policyIds = new Set(policies.map((p) => p.policy_id));
    const claims = await a.listClaims('BIL', 'c-many-claims', NOW);
    for (const c of claims) {
      expect(policyIds.has(c.policy_id)).toBe(true);
      expect(c.customer_id).toBe('c-many-claims');
    }
  });

  test('paid claim has paid_amount_kes > 0; non-paid has 0', async () => {
    const a = new StubInsuranceAdapter();
    let sawPaid = false;
    let sawNonPaid = false;
    for (let i = 0; i < 30; i++) {
      const claims = await a.listClaims('BIL', `c-${i}`, NOW);
      for (const c of claims) {
        if (c.status === 'paid') {
          sawPaid = true;
          expect(c.paid_amount_kes).toBeGreaterThan(0);
          expect(c.paid_amount_kes).toBeLessThanOrEqual(c.claim_amount_kes);
        } else {
          sawNonPaid = true;
          expect(c.paid_amount_kes).toBe(0);
        }
      }
    }
    expect(sawPaid).toBe(true);
    expect(sawNonPaid).toBe(true);
  });

  test('claims sorted newest-filed-first', async () => {
    const a = new StubInsuranceAdapter();
    const claims = await a.listClaims('BIL', 'c-many-claims', NOW);
    for (let i = 1; i < claims.length; i++) {
      expect(claims[i - 1]!.filed_at >= claims[i]!.filed_at).toBe(true);
    }
  });

  test('reason_code is from the closed enum', async () => {
    const a = new StubInsuranceAdapter();
    const VALID = [
      'NATURAL_DEATH',
      'ACCIDENT',
      'CRITICAL_ILLNESS',
      'HOSPITALISATION',
      'MATURITY',
      'SURRENDER',
      'PARTIAL_DISABILITY',
    ];
    for (let i = 0; i < 10; i++) {
      const claims = await a.listClaims('BIL', `c-${i}`, NOW);
      for (const c of claims) {
        expect(VALID).toContain(c.reason_code);
      }
    }
  });
});

describe('StubInsuranceAdapter — getClaim', () => {
  test('valid claim_id returns a synthesised claim', async () => {
    const a = new StubInsuranceAdapter();
    const c = await a.getClaim('BIL', 'CLM-BIL-123456', NOW);
    expect(c).not.toBeNull();
    expect(c!.claim_id).toBe('CLM-BIL-123456');
    expect(c!.policy_id).toMatch(/^POL-BIL-\d{6}$/);
  });

  test('malformed claim_id → null', async () => {
    const a = new StubInsuranceAdapter();
    expect(await a.getClaim('BIL', 'not-a-claim', NOW)).toBeNull();
    expect(await a.getClaim('BIL', '', NOW)).toBeNull();
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/integrations/insurance/policies', () => {
  test('admin: 200 with enveloped list', async () => {
    const { app } = makeInsApp('admin');
    const r = await request(app)
      .get('/v1/integrations/insurance/policies?customer_id=c-101')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.customer_id).toBe('c-101');
    expect(r.body.body.total).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(r.body.body.items)).toBe(true);
  });

  test('risk_analyst (customers:read_risk_profile) accepted', async () => {
    const { app } = makeInsApp('risk_analyst');
    const r = await request(app)
      .get('/v1/integrations/insurance/policies?customer_id=c-101')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('missing customer_id → 400', async () => {
    const { app } = makeInsApp('admin');
    const r = await request(app).get('/v1/integrations/insurance/policies').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400');
  });

  test('different tenants get distinct policy ids for same customer', async () => {
    const { app } = makeInsApp('admin');
    const bil = await request(app)
      .get('/v1/integrations/insurance/policies?customer_id=c-101')
      .set(TH_BIL);
    const bank = await request(app)
      .get('/v1/integrations/insurance/policies?customer_id=c-101')
      .set(TH_BANK);
    const bilIds: string[] = bil.body.body.items.map((p: Policy) => p.policy_id);
    const bankIds: string[] = bank.body.body.items.map((p: Policy) => p.policy_id);
    for (const id of bilIds) expect(bankIds).not.toContain(id);
  });

  test('unknown role → 403', async () => {
    const { app } = makeInsApp('case_owner');
    const r = await request(app)
      .get('/v1/integrations/insurance/policies?customer_id=c-101')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('adapter throwing → 502 envelope', async () => {
    const exploding: InsuranceAdapter = {
      async listPolicies() {
        throw new Error('upstream timeout');
      },
      async getPolicy() {
        return null;
      },
      async listClaims() {
        return [];
      },
      async getClaim() {
        return null;
      },
    };
    const { app } = makeInsApp('admin', exploding);
    const r = await request(app)
      .get('/v1/integrations/insurance/policies?customer_id=c-101')
      .set(TH_BIL);
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('EWS_502');
    expect(r.body.error.message).toMatch(/upstream timeout/);
  });
});

describe('GET /v1/integrations/insurance/policies/:policy_id', () => {
  test('valid policy_id → 200 with enveloped policy', async () => {
    const { app } = makeInsApp('admin');
    const r = await request(app).get('/v1/integrations/insurance/policies/POL-BIL-123456').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.policy_id).toBe('POL-BIL-123456');
  });

  test('malformed policy_id → 404', async () => {
    const { app } = makeInsApp('admin');
    const r = await request(app).get('/v1/integrations/insurance/policies/not-a-policy').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404');
  });

  test('unknown role → 403', async () => {
    const { app } = makeInsApp('case_owner');
    const r = await request(app).get('/v1/integrations/insurance/policies/POL-BIL-123456').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/integrations/insurance/claims', () => {
  test('admin: 200 with enveloped list', async () => {
    const { app } = makeInsApp('admin');
    const r = await request(app)
      .get('/v1/integrations/insurance/claims?customer_id=c-many-claims')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.customer_id).toBe('c-many-claims');
    expect(Array.isArray(r.body.body.items)).toBe(true);
  });

  test('items are sorted newest-filed-first', async () => {
    const { app } = makeInsApp('admin');
    const r = await request(app)
      .get('/v1/integrations/insurance/claims?customer_id=c-many-claims')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    const items = r.body.body.items as Claim[];
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1]!.filed_at >= items[i]!.filed_at).toBe(true);
    }
  });

  test('missing customer_id → 400', async () => {
    const { app } = makeInsApp('admin');
    const r = await request(app).get('/v1/integrations/insurance/claims').set(TH_BIL);
    expect(r.status).toBe(400);
  });
});

describe('GET /v1/integrations/insurance/claims/:claim_id', () => {
  test('valid claim_id → 200 with enveloped claim', async () => {
    const { app } = makeInsApp('admin');
    const r = await request(app).get('/v1/integrations/insurance/claims/CLM-BIL-654321').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.claim_id).toBe('CLM-BIL-654321');
    expect(r.body.body.policy_id).toMatch(/^POL-BIL-\d{6}$/);
  });

  test('malformed claim_id → 404', async () => {
    const { app } = makeInsApp('admin');
    const r = await request(app).get('/v1/integrations/insurance/claims/not-a-claim').set(TH_BIL);
    expect(r.status).toBe(404);
  });
});
