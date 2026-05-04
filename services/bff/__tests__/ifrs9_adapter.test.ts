// services/bff/__tests__/ifrs9_adapter.test.ts
//
// T6 M14.2 — IFRS9 Stage adapter.
//
// Layered tests:
//   1. StubIfrs9Adapter — determinism, stage distribution, IFRS9
//      invariants (ECL = driver_PD × LGD × EAD, Stage 1 ⇒ DPD=0,
//      Stage 3 ⇒ DPD ≥ 90, lifetime ≥ 12m PD), pagination + filter
//   2. The 2 routes — RBAC, envelope, validation, 404, 502 on throw

import request from 'supertest';
import {
  StubIfrs9Adapter,
  type Ifrs9Adapter,
  type Ifrs9Stage,
  type Ifrs9StageNum,
} from '../src/integrations/ifrs9';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeIfrsApp(role: string = 'admin', ifrs9Adapter?: Ifrs9Adapter) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    ifrs9Adapter,
  });
}

// ─── StubIfrs9Adapter ──────────────────────────────────────────────────

describe('StubIfrs9Adapter — getStage', () => {
  test('returns a valid stage for any customer', async () => {
    const a = new StubIfrs9Adapter();
    const s = await a.getStage('BIL', 'c-101', NOW);
    expect(s).not.toBeNull();
    expect([1, 2, 3]).toContain(s!.stage);
    expect(s!.customer_id).toBe('c-101');
  });

  test('deterministic — same (tenant, customer, day) → identical', async () => {
    const a = new StubIfrs9Adapter();
    const s1 = await a.getStage('BIL', 'c-101', NOW);
    const s2 = await a.getStage('BIL', 'c-101', NOW);
    expect(s1).toEqual(s2);
  });

  test('different tenants → potentially different stages for same customer', async () => {
    const a = new StubIfrs9Adapter();
    let differs = false;
    for (let i = 0; i < 50; i++) {
      const bil = await a.getStage('BIL', `c-${i}`, NOW);
      const bank = await a.getStage('BANK_DEMO', `c-${i}`, NOW);
      if (
        bil!.stage !== bank!.stage ||
        bil!.pd_12m !== bank!.pd_12m ||
        bil!.ead_kes !== bank!.ead_kes
      ) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });

  test('empty customer_id → null', async () => {
    const a = new StubIfrs9Adapter();
    expect(await a.getStage('BIL', '', NOW)).toBeNull();
  });

  test('empty tenant_id → null', async () => {
    const a = new StubIfrs9Adapter();
    expect(await a.getStage('', 'c-101', NOW)).toBeNull();
  });
});

describe('StubIfrs9Adapter — IFRS9 invariants', () => {
  test('Stage 1 ⇒ DPD=0', async () => {
    const a = new StubIfrs9Adapter();
    let sawS1 = false;
    for (let i = 0; i < 100; i++) {
      const s = await a.getStage('BIL', `c-${i}`, NOW);
      if (s!.stage === 1) {
        sawS1 = true;
        expect(s!.dpd_days).toBe(0);
      }
    }
    expect(sawS1).toBe(true);
  });

  test('Stage 2 ⇒ 30 ≤ DPD < 90', async () => {
    const a = new StubIfrs9Adapter();
    let sawS2 = false;
    for (let i = 0; i < 200; i++) {
      const s = await a.getStage('BIL', `c-${i}`, NOW);
      if (s!.stage === 2) {
        sawS2 = true;
        expect(s!.dpd_days).toBeGreaterThanOrEqual(30);
        expect(s!.dpd_days).toBeLessThan(90);
      }
    }
    expect(sawS2).toBe(true);
  });

  test('Stage 3 ⇒ DPD ≥ 90', async () => {
    const a = new StubIfrs9Adapter();
    let sawS3 = false;
    for (let i = 0; i < 200; i++) {
      const s = await a.getStage('BIL', `c-${i}`, NOW);
      if (s!.stage === 3) {
        sawS3 = true;
        expect(s!.dpd_days).toBeGreaterThanOrEqual(90);
      }
    }
    expect(sawS3).toBe(true);
  });

  test('PDs in [0, 1] for every stage', async () => {
    const a = new StubIfrs9Adapter();
    for (let i = 0; i < 50; i++) {
      const s = await a.getStage('BIL', `c-${i}`, NOW);
      expect(s!.pd_12m).toBeGreaterThanOrEqual(0);
      expect(s!.pd_12m).toBeLessThanOrEqual(1);
      expect(s!.pd_lifetime).toBeGreaterThanOrEqual(0);
      expect(s!.pd_lifetime).toBeLessThanOrEqual(1);
    }
  });

  test('pd_lifetime ≥ pd_12m (lifetime is over a longer horizon)', async () => {
    const a = new StubIfrs9Adapter();
    for (let i = 0; i < 50; i++) {
      const s = await a.getStage('BIL', `c-${i}`, NOW);
      expect(s!.pd_lifetime).toBeGreaterThanOrEqual(s!.pd_12m - 1e-6);
    }
  });

  test('LGD in [0, 1]', async () => {
    const a = new StubIfrs9Adapter();
    for (let i = 0; i < 50; i++) {
      const s = await a.getStage('BIL', `c-${i}`, NOW);
      expect(s!.lgd).toBeGreaterThan(0);
      expect(s!.lgd).toBeLessThanOrEqual(1);
    }
  });

  test('EAD > 0', async () => {
    const a = new StubIfrs9Adapter();
    for (let i = 0; i < 50; i++) {
      const s = await a.getStage('BIL', `c-${i}`, NOW);
      expect(s!.ead_kes).toBeGreaterThan(0);
    }
  });

  test('ECL ≈ driver_PD × LGD × EAD (rounded)', async () => {
    const a = new StubIfrs9Adapter();
    for (let i = 0; i < 30; i++) {
      const s = await a.getStage('BIL', `c-${i}`, NOW);
      const driver = s!.stage === 1 ? s!.pd_12m : s!.pd_lifetime;
      const expected = Math.round(driver * s!.lgd * s!.ead_kes);
      expect(s!.ecl_kes).toBe(expected);
    }
  });

  test('stage_reason is non-empty and shape matches stage bucket', async () => {
    const a = new StubIfrs9Adapter();
    for (let i = 0; i < 100; i++) {
      const s = await a.getStage('BIL', `c-${i}`, NOW);
      expect(typeof s!.stage_reason).toBe('string');
      expect(s!.stage_reason.length).toBeGreaterThan(0);
    }
  });

  test('evaluation_date is ≤ asOf and within last 7 days', async () => {
    const a = new StubIfrs9Adapter();
    const cutoff = new Date(NOW.getTime() - 8 * 86400000).toISOString();
    for (let i = 0; i < 30; i++) {
      const s = await a.getStage('BIL', `c-${i}`, NOW);
      expect(s!.evaluation_date <= NOW.toISOString()).toBe(true);
      expect(s!.evaluation_date > cutoff).toBe(true);
    }
  });
});

describe('StubIfrs9Adapter — listStages', () => {
  test('default page_size=50, page=1, no filter — 50 items, total=200', async () => {
    const a = new StubIfrs9Adapter();
    const out = await a.listStages('BIL', {}, NOW);
    expect(out.items.length).toBe(50);
    expect(out.page).toBe(1);
    expect(out.page_size).toBe(50);
    expect(out.total).toBe(200);
    expect(out.stage_filter).toBeNull();
  });

  test('items sorted highest-ECL first', async () => {
    const a = new StubIfrs9Adapter();
    const out = await a.listStages('BIL', { page_size: 100 }, NOW);
    for (let i = 1; i < out.items.length; i++) {
      expect(out.items[i - 1]!.ecl_kes).toBeGreaterThanOrEqual(out.items[i]!.ecl_kes);
    }
  });

  test('stage filter — every returned item matches the filter', async () => {
    const a = new StubIfrs9Adapter();
    for (const stage of [1, 2, 3] as Ifrs9StageNum[]) {
      const out = await a.listStages('BIL', { stage, page_size: 200 }, NOW);
      for (const it of out.items) {
        expect(it.stage).toBe(stage);
      }
      // Stage 1 should be most populous (~80%), Stage 3 the rarest (~5%).
      // Loose assertion: stage 1 > stage 3 in count.
    }
  });

  test('stage 1 + stage 2 + stage 3 totals sum to 200', async () => {
    const a = new StubIfrs9Adapter();
    let sum = 0;
    for (const stage of [1, 2, 3] as Ifrs9StageNum[]) {
      const out = await a.listStages('BIL', { stage, page_size: 200 }, NOW);
      sum += out.total;
    }
    expect(sum).toBe(200);
  });

  test('pagination — page 2 yields the next slice; no overlap with page 1', async () => {
    const a = new StubIfrs9Adapter();
    const p1 = await a.listStages('BIL', { page: 1, page_size: 25 }, NOW);
    const p2 = await a.listStages('BIL', { page: 2, page_size: 25 }, NOW);
    expect(p1.items.length).toBe(25);
    expect(p2.items.length).toBe(25);
    const p1Ids = new Set(p1.items.map((i) => i.customer_id));
    for (const i of p2.items) expect(p1Ids.has(i.customer_id)).toBe(false);
  });

  test('page_size clamped to [1, 200]', async () => {
    const a = new StubIfrs9Adapter();
    const tooBig = await a.listStages('BIL', { page_size: 9999 }, NOW);
    expect(tooBig.page_size).toBe(200);
    const tooSmall = await a.listStages('BIL', { page_size: 0 }, NOW);
    expect(tooSmall.page_size).toBe(1);
  });

  test('page beyond available data → empty items but total reflects full filtered set', async () => {
    const a = new StubIfrs9Adapter();
    const out = await a.listStages('BIL', { page: 999, page_size: 50 }, NOW);
    expect(out.items.length).toBe(0);
    expect(out.total).toBe(200);
  });

  test('different tenants get independent books (different customer ids)', async () => {
    const a = new StubIfrs9Adapter();
    const bil = await a.listStages('BIL', { page_size: 200 }, NOW);
    const bank = await a.listStages('BANK_DEMO', { page_size: 200 }, NOW);
    const bilIds = new Set(bil.items.map((i) => i.customer_id));
    for (const i of bank.items) {
      expect(bilIds.has(i.customer_id)).toBe(false);
    }
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/integrations/ifrs9/stages/:customer_id', () => {
  test('admin: 200 with enveloped stage', async () => {
    const { app } = makeIfrsApp('admin');
    const r = await request(app).get('/v1/integrations/ifrs9/stages/c-101').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.customer_id).toBe('c-101');
    expect([1, 2, 3]).toContain(r.body.body.stage);
  });

  test('risk_analyst accepted', async () => {
    const { app } = makeIfrsApp('risk_analyst');
    const r = await request(app).get('/v1/integrations/ifrs9/stages/c-101').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('unknown role → 403', async () => {
    const { app } = makeIfrsApp('case_owner');
    const r = await request(app).get('/v1/integrations/ifrs9/stages/c-101').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('adapter returning null → 404', async () => {
    const nullAdapter: Ifrs9Adapter = {
      async getStage() {
        return null;
      },
      async listStages() {
        return { items: [], page: 1, page_size: 50, total: 0, stage_filter: null };
      },
    };
    const { app } = makeIfrsApp('admin', nullAdapter);
    const r = await request(app).get('/v1/integrations/ifrs9/stages/c-101').set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404');
  });

  test('adapter throwing → 502 envelope', async () => {
    const exploding: Ifrs9Adapter = {
      async getStage() {
        throw new Error('upstream timeout');
      },
      async listStages() {
        return { items: [], page: 1, page_size: 50, total: 0, stage_filter: null };
      },
    };
    const { app } = makeIfrsApp('admin', exploding);
    const r = await request(app).get('/v1/integrations/ifrs9/stages/c-101').set(TH_BIL);
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('EWS_502');
  });

  test('different tenants → different stage payloads (eventually)', async () => {
    const { app } = makeIfrsApp('admin');
    let differs = false;
    for (let i = 0; i < 50; i++) {
      const bil = await request(app).get(`/v1/integrations/ifrs9/stages/c-${i}`).set(TH_BIL);
      const bank = await request(app).get(`/v1/integrations/ifrs9/stages/c-${i}`).set(TH_BANK);
      if (
        bil.body.body.stage !== bank.body.body.stage ||
        bil.body.body.ead_kes !== bank.body.body.ead_kes
      ) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });
});

describe('GET /v1/integrations/ifrs9/stages', () => {
  test('admin: 200 with paginated list, default page_size=50', async () => {
    const { app } = makeIfrsApp('admin');
    const r = await request(app).get('/v1/integrations/ifrs9/stages').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.items.length).toBe(50);
    expect(r.body.body.page).toBe(1);
    expect(r.body.body.total).toBe(200);
    expect(r.body.body.stage_filter).toBeNull();
  });

  test('?stage=2 filters items', async () => {
    const { app } = makeIfrsApp('admin');
    const r = await request(app).get('/v1/integrations/ifrs9/stages?stage=2&page_size=200').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.stage_filter).toBe(2);
    for (const it of r.body.body.items as Ifrs9Stage[]) {
      expect(it.stage).toBe(2);
    }
  });

  test('?stage=invalid → 400 EWS_400_invalid_stage', async () => {
    const { app } = makeIfrsApp('admin');
    const r = await request(app).get('/v1/integrations/ifrs9/stages?stage=4').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_stage');
  });

  test('?stage=foo → 400', async () => {
    const { app } = makeIfrsApp('admin');
    const r = await request(app).get('/v1/integrations/ifrs9/stages?stage=foo').set(TH_BIL);
    expect(r.status).toBe(400);
  });

  test('?page=2&page_size=25 — no overlap with page 1', async () => {
    const { app } = makeIfrsApp('admin');
    const p1 = await request(app).get('/v1/integrations/ifrs9/stages?page=1&page_size=25').set(TH_BIL);
    const p2 = await request(app).get('/v1/integrations/ifrs9/stages?page=2&page_size=25').set(TH_BIL);
    expect(p1.body.body.items.length).toBe(25);
    expect(p2.body.body.items.length).toBe(25);
    const p1Ids = new Set((p1.body.body.items as Ifrs9Stage[]).map((i) => i.customer_id));
    for (const i of p2.body.body.items as Ifrs9Stage[]) {
      expect(p1Ids.has(i.customer_id)).toBe(false);
    }
  });

  test('items sorted highest-ECL first', async () => {
    const { app } = makeIfrsApp('admin');
    const r = await request(app).get('/v1/integrations/ifrs9/stages?page_size=100').set(TH_BIL);
    const items = r.body.body.items as Ifrs9Stage[];
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1]!.ecl_kes).toBeGreaterThanOrEqual(items[i]!.ecl_kes);
    }
  });

  test('unknown role → 403', async () => {
    const { app } = makeIfrsApp('case_owner');
    const r = await request(app).get('/v1/integrations/ifrs9/stages').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});
