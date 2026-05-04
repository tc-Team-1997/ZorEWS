// services/bff/__tests__/agent_adapter.test.ts
//
// T6 M14.6 — Agent Productivity adapter.

import request from 'supertest';
import {
  AgentError,
  StubAgentAdapter,
  isAgentStatus,
  isAgentTier,
  isValidPeriod,
  type Agent,
  type AgentAdapter,
  type AgentProductivity,
} from '../src/integrations/agent';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeAgentApp(role: string = 'admin', agentAdapter?: AgentAdapter) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    agentAdapter,
  });
}

// ─── Type guards ───────────────────────────────────────────────────────

describe('Type guards + period validation', () => {
  test('isAgentTier', () => {
    expect(isAgentTier('gold')).toBe(true);
    expect(isAgentTier('silver')).toBe(true);
    expect(isAgentTier('bronze')).toBe(true);
    expect(isAgentTier('platinum')).toBe(false);
  });
  test('isAgentStatus', () => {
    expect(isAgentStatus('active')).toBe(true);
    expect(isAgentStatus('suspended')).toBe(true);
    expect(isAgentStatus('terminated')).toBe(true);
    expect(isAgentStatus('on_leave')).toBe(true);
    expect(isAgentStatus('pending')).toBe(false);
  });
  test('isValidPeriod (YYYY-MM)', () => {
    expect(isValidPeriod('2026-05')).toBe(true);
    expect(isValidPeriod('2026-01')).toBe(true);
    expect(isValidPeriod('2026-12')).toBe(true);
    expect(isValidPeriod('2026-13')).toBe(false);
    expect(isValidPeriod('2026-00')).toBe(false);
    expect(isValidPeriod('2026/05')).toBe(false);
    expect(isValidPeriod('26-05')).toBe(false);
  });
});

// ─── StubAgentAdapter — list + get ─────────────────────────────────────

describe('StubAgentAdapter — list', () => {
  test('returns 50 agents per tenant by default (page 1, page_size=25)', async () => {
    const a = new StubAgentAdapter();
    const out = await a.list('BIL', {}, NOW);
    expect(out.total).toBe(50);
    expect(out.items.length).toBe(25);
    expect(out.page).toBe(1);
    expect(out.page_size).toBe(25);
  });

  test('every agent has required fields with valid types', async () => {
    const a = new StubAgentAdapter();
    const out = await a.list('BIL', { page_size: 100 }, NOW);
    for (const ag of out.items) {
      expect(ag.agent_id).toMatch(/^AGT-BIL-\d{4}$/);
      expect(typeof ag.name).toBe('string');
      expect(typeof ag.branch).toBe('string');
      expect(['gold', 'silver', 'bronze']).toContain(ag.tier);
      expect(['active', 'suspended', 'terminated', 'on_leave']).toContain(ag.status);
    }
  });

  test('first 5 agents are branch heads (manager_id null); rest have a manager', async () => {
    const a = new StubAgentAdapter();
    const out = await a.list('BIL', { page_size: 50 }, NOW);
    for (const ag of out.items) {
      const idx = parseInt(ag.agent_id.slice(-4), 10);
      if (idx < 5) {
        expect(ag.manager_id).toBeNull();
      } else {
        expect(ag.manager_id).not.toBeNull();
        expect(ag.manager_id!).toMatch(/^AGT-BIL-000\d$/);
      }
    }
  });

  test('tier filter narrows to only gold', async () => {
    const a = new StubAgentAdapter();
    const out = await a.list('BIL', { tier: 'gold', page_size: 100 }, NOW);
    for (const ag of out.items) expect(ag.tier).toBe('gold');
    expect(out.filter).toEqual({ tier: 'gold', status: undefined });
  });

  test('status filter narrows to only active', async () => {
    const a = new StubAgentAdapter();
    const out = await a.list('BIL', { status: 'active', page_size: 100 }, NOW);
    for (const ag of out.items) expect(ag.status).toBe('active');
  });

  test('tier + status combine as AND', async () => {
    const a = new StubAgentAdapter();
    const out = await a.list('BIL', { tier: 'silver', status: 'active', page_size: 100 }, NOW);
    for (const ag of out.items) {
      expect(ag.tier).toBe('silver');
      expect(ag.status).toBe('active');
    }
  });

  test('pagination disjoint, page_size clamped to [1, 100]', async () => {
    const a = new StubAgentAdapter();
    const p1 = await a.list('BIL', { page: 1, page_size: 10 }, NOW);
    const p2 = await a.list('BIL', { page: 2, page_size: 10 }, NOW);
    const p1Ids = new Set(p1.items.map((x) => x.agent_id));
    for (const x of p2.items) expect(p1Ids.has(x.agent_id)).toBe(false);
    expect((await a.list('BIL', { page_size: 99999 }, NOW)).page_size).toBe(100);
    expect((await a.list('BIL', { page_size: 0 }, NOW)).page_size).toBe(1);
  });

  test('different tenants → disjoint agent_ids', async () => {
    const a = new StubAgentAdapter();
    const bil = await a.list('BIL', { page_size: 50 }, NOW);
    const bank = await a.list('BANK_DEMO', { page_size: 50 }, NOW);
    const bilIds = new Set(bil.items.map((x) => x.agent_id));
    for (const x of bank.items) expect(bilIds.has(x.agent_id)).toBe(false);
  });
});

describe('StubAgentAdapter — get', () => {
  test('valid agent_id → 200 with agent', async () => {
    const a = new StubAgentAdapter();
    const ag = await a.get('BIL', 'AGT-BIL-0010');
    expect(ag).not.toBeNull();
    expect(ag!.agent_id).toBe('AGT-BIL-0010');
  });

  test('out-of-range index → null', async () => {
    const a = new StubAgentAdapter();
    expect(await a.get('BIL', 'AGT-BIL-9999')).toBeNull();
  });

  test('malformed agent_id → null', async () => {
    const a = new StubAgentAdapter();
    expect(await a.get('BIL', 'AGT-XX-0001')).toBeNull();
    expect(await a.get('BIL', 'foo')).toBeNull();
  });

  test('cross-tenant lookup (using BIL prefix on BANK_DEMO tenant) → null', async () => {
    const a = new StubAgentAdapter();
    expect(await a.get('BANK_DEMO', 'AGT-BIL-0001')).toBeNull();
  });
});

// ─── StubAgentAdapter — productivity ───────────────────────────────────

describe('StubAgentAdapter — getProductivity', () => {
  test('default period = current YYYY-MM', async () => {
    const a = new StubAgentAdapter();
    const p = await a.getProductivity('BIL', 'AGT-BIL-0001', {}, NOW);
    expect(p!.period).toBe('2026-05');
    expect(p!.agent_id).toBe('AGT-BIL-0001');
  });

  test('explicit period honoured', async () => {
    const a = new StubAgentAdapter();
    const p = await a.getProductivity('BIL', 'AGT-BIL-0001', { period: '2026-01' }, NOW);
    expect(p!.period).toBe('2026-01');
  });

  test('invalid period throws invalid_period', async () => {
    const a = new StubAgentAdapter();
    try {
      await a.getProductivity('BIL', 'AGT-BIL-0001', { period: '2026/05' }, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as AgentError).code).toBe('invalid_period');
    }
  });

  test('unknown agent_id → null (not throw)', async () => {
    const a = new StubAgentAdapter();
    expect(await a.getProductivity('BIL', 'AGT-BIL-9999', {}, NOW)).toBeNull();
  });

  test('terminated agent has zeros + null branch_rank', async () => {
    const a = new StubAgentAdapter();
    // Sample many agents; find a terminated one
    const all = await a.list('BIL', { status: 'terminated', page_size: 50 }, NOW);
    if (all.items.length > 0) {
      const term = all.items[0]!;
      const p = (await a.getProductivity('BIL', term.agent_id, {}, NOW))!;
      expect(p.policies_sold).toBe(0);
      expect(p.premium_collected_kes).toBe(0);
      expect(p.branch_rank).toBeNull();
      expect(p.persistency_pct).toBe(0);
      expect(p.lapse_count).toBe(0);
    }
  });

  test('productivity is deterministic per (tenant, agent, period)', async () => {
    const a = new StubAgentAdapter();
    const p1 = await a.getProductivity('BIL', 'AGT-BIL-0001', { period: '2026-03' }, NOW);
    const p2 = await a.getProductivity('BIL', 'AGT-BIL-0001', { period: '2026-03' }, NOW);
    expect(p1).toEqual(p2);
  });

  test('every productivity row carries valid types', async () => {
    const a = new StubAgentAdapter();
    for (let i = 0; i < 50; i++) {
      const p = await a.getProductivity('BIL', `AGT-BIL-${i.toString().padStart(4, '0')}`, {}, NOW);
      if (!p) continue;
      expect(p.policies_sold).toBeGreaterThanOrEqual(0);
      expect(p.premium_collected_kes).toBeGreaterThanOrEqual(0);
      expect(p.persistency_pct).toBeGreaterThanOrEqual(0);
      expect(p.persistency_pct).toBeLessThanOrEqual(100);
      expect(p.lapse_count).toBeGreaterThanOrEqual(0);
      expect(p.complaints_count).toBeGreaterThanOrEqual(0);
      expect(p.complaints_count).toBeLessThanOrEqual(3);
      expect(p.conversion_pct).toBeGreaterThanOrEqual(0);
      expect(p.conversion_pct).toBeLessThanOrEqual(50);
    }
  });

  test('gold tier carries higher avg policies_sold than bronze', async () => {
    const a = new StubAgentAdapter();
    const all = await a.list('BIL', { page_size: 50 }, NOW);
    const goldStats: number[] = [];
    const bronzeStats: number[] = [];
    for (const ag of all.items) {
      if (ag.status !== 'active') continue;
      const p = (await a.getProductivity('BIL', ag.agent_id, {}, NOW))!;
      if (ag.tier === 'gold') goldStats.push(p.policies_sold);
      if (ag.tier === 'bronze') bronzeStats.push(p.policies_sold);
    }
    if (goldStats.length > 0 && bronzeStats.length > 0) {
      const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
      expect(avg(goldStats)).toBeGreaterThan(avg(bronzeStats));
    }
  });
});

describe('StubAgentAdapter — listProductivity', () => {
  test('default 12 months newest-first', async () => {
    const a = new StubAgentAdapter();
    const out = await a.listProductivity('BIL', 'AGT-BIL-0001', 12, NOW);
    expect(out.length).toBe(12);
    expect(out[0]!.period).toBe('2026-05');
    expect(out[1]!.period).toBe('2026-04');
    expect(out[11]!.period).toBe('2025-06');
  });

  test('months clamped to [1, 36]', async () => {
    const a = new StubAgentAdapter();
    expect((await a.listProductivity('BIL', 'AGT-BIL-0001', 0, NOW)).length).toBe(1);
    expect((await a.listProductivity('BIL', 'AGT-BIL-0001', 9999, NOW)).length).toBe(36);
  });

  test('crosses year boundaries cleanly (Dec → Nov of prior year)', async () => {
    const a = new StubAgentAdapter();
    const startOfFeb = new Date('2026-02-15T12:00:00.000Z');
    const out = await a.listProductivity('BIL', 'AGT-BIL-0001', 6, startOfFeb);
    expect(out.map((x) => x.period)).toEqual([
      '2026-02',
      '2026-01',
      '2025-12',
      '2025-11',
      '2025-10',
      '2025-09',
    ]);
  });

  test('unknown agent → empty array', async () => {
    const a = new StubAgentAdapter();
    expect(await a.listProductivity('BIL', 'AGT-BIL-9999', 12, NOW)).toEqual([]);
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('GET /v1/integrations/agent/agents', () => {
  test('admin: 200 with paginated list', async () => {
    const { app } = makeAgentApp('admin');
    const r = await request(app).get('/v1/integrations/agent/agents').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(50);
    expect(r.body.body.items.length).toBe(25);
  });

  test('?tier=gold narrows', async () => {
    const { app } = makeAgentApp('admin');
    const r = await request(app).get('/v1/integrations/agent/agents?tier=gold&page_size=100').set(TH_BIL);
    for (const ag of r.body.body.items as Agent[]) expect(ag.tier).toBe('gold');
  });

  test('?status=active narrows', async () => {
    const { app } = makeAgentApp('admin');
    const r = await request(app).get('/v1/integrations/agent/agents?status=active&page_size=100').set(TH_BIL);
    for (const ag of r.body.body.items as Agent[]) expect(ag.status).toBe('active');
  });

  test('?tier=invalid → 400 EWS_400_invalid_tier', async () => {
    const { app } = makeAgentApp('admin');
    const r = await request(app).get('/v1/integrations/agent/agents?tier=platinum').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_tier');
  });

  test('?status=invalid → 400 EWS_400_invalid_status', async () => {
    const { app } = makeAgentApp('admin');
    const r = await request(app).get('/v1/integrations/agent/agents?status=working').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_status');
  });

  test('unknown role → 403', async () => {
    const { app } = makeAgentApp('case_owner');
    const r = await request(app).get('/v1/integrations/agent/agents').set(TH_BIL);
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/integrations/agent/agents/:agent_id', () => {
  test('valid id → 200', async () => {
    const { app } = makeAgentApp('admin');
    const r = await request(app).get('/v1/integrations/agent/agents/AGT-BIL-0010').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.agent_id).toBe('AGT-BIL-0010');
  });

  test('unknown id → 404', async () => {
    const { app } = makeAgentApp('admin');
    const r = await request(app).get('/v1/integrations/agent/agents/AGT-BIL-9999').set(TH_BIL);
    expect(r.status).toBe(404);
  });

  test('cross-tenant (BIL agent on BANK_DEMO tenant) → 404', async () => {
    const { app } = makeAgentApp('admin');
    const r = await request(app).get('/v1/integrations/agent/agents/AGT-BIL-0001').set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('GET /v1/integrations/agent/agents/:agent_id/productivity', () => {
  test('default period (current month) → 200', async () => {
    const { app } = makeAgentApp('admin');
    const r = await request(app)
      .get('/v1/integrations/agent/agents/AGT-BIL-0001/productivity')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.period).toBe('2026-05');
  });

  test('?period=2026-01 honoured', async () => {
    const { app } = makeAgentApp('admin');
    const r = await request(app)
      .get('/v1/integrations/agent/agents/AGT-BIL-0001/productivity?period=2026-01')
      .set(TH_BIL);
    expect(r.body.body.period).toBe('2026-01');
  });

  test('?period=invalid → 400 EWS_400_invalid_period', async () => {
    const { app } = makeAgentApp('admin');
    const r = await request(app)
      .get('/v1/integrations/agent/agents/AGT-BIL-0001/productivity?period=2026/05')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_period');
  });

  test('unknown agent → 404', async () => {
    const { app } = makeAgentApp('admin');
    const r = await request(app)
      .get('/v1/integrations/agent/agents/AGT-BIL-9999/productivity')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });
});

describe('GET /v1/integrations/agent/agents/:agent_id/productivity/history', () => {
  test('default 12 months newest-first', async () => {
    const { app } = makeAgentApp('admin');
    const r = await request(app)
      .get('/v1/integrations/agent/agents/AGT-BIL-0001/productivity/history')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.months).toBe(12);
    expect(r.body.body.items.length).toBe(12);
    const items = r.body.body.items as AgentProductivity[];
    expect(items[0]!.period).toBe('2026-05');
  });

  test('?months=6 honoured', async () => {
    const { app } = makeAgentApp('admin');
    const r = await request(app)
      .get('/v1/integrations/agent/agents/AGT-BIL-0001/productivity/history?months=6')
      .set(TH_BIL);
    expect(r.body.body.months).toBe(6);
    expect(r.body.body.items.length).toBe(6);
  });

  test('?months clamped to [1, 36]', async () => {
    const { app } = makeAgentApp('admin');
    const big = await request(app)
      .get('/v1/integrations/agent/agents/AGT-BIL-0001/productivity/history?months=99999')
      .set(TH_BIL);
    expect(big.body.body.months).toBe(36);
    const zero = await request(app)
      .get('/v1/integrations/agent/agents/AGT-BIL-0001/productivity/history?months=0')
      .set(TH_BIL);
    expect(zero.body.body.months).toBe(1);
  });

  test('unknown agent → 404', async () => {
    const { app } = makeAgentApp('admin');
    const r = await request(app)
      .get('/v1/integrations/agent/agents/AGT-BIL-9999/productivity/history')
      .set(TH_BIL);
    expect(r.status).toBe(404);
  });
});

describe('Tenant isolation through routes', () => {
  test('different tenants see disjoint agent registers', async () => {
    const { app } = makeAgentApp('admin');
    const bil = await request(app).get('/v1/integrations/agent/agents?page_size=50').set(TH_BIL);
    const bank = await request(app).get('/v1/integrations/agent/agents?page_size=50').set(TH_BANK);
    const bilIds = new Set((bil.body.body.items as Agent[]).map((x) => x.agent_id));
    for (const x of bank.body.body.items as Agent[]) {
      expect(bilIds.has(x.agent_id)).toBe(false);
    }
  });
});
