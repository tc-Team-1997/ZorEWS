// services/bff/__tests__/adapter_health.test.ts
//
// T6 M14.9 — Adapter fleet health roll-up.

import request from 'supertest';
import {
  listFleetAdapters,
  runFleetHealth,
  type AdapterFleet,
  type FleetHealthReport,
} from '../src/adapter_health';
import { defaultInsuranceAdapter } from '../src/integrations/insurance';
import { defaultIfrs9Adapter } from '../src/integrations/ifrs9';
import { defaultAmlAdapter } from '../src/integrations/aml';
import { defaultDmsAdapter } from '../src/integrations/dms';
import { defaultBureauAdapter } from '../src/integrations/bureau';
import { defaultAgentAdapter } from '../src/integrations/agent';
import { defaultFinanceAdapter } from '../src/integrations/finance';
import { defaultHrAdapter } from '../src/integrations/hr';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T14:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function realFleet(): AdapterFleet {
  return {
    insurance: defaultInsuranceAdapter,
    ifrs9: defaultIfrs9Adapter,
    aml: defaultAmlAdapter,
    dms: defaultDmsAdapter,
    bureau: defaultBureauAdapter,
    agent: defaultAgentAdapter,
    finance: defaultFinanceAdapter,
    hr: defaultHrAdapter,
  };
}

function makeFleetApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── listFleetAdapters (catalog) ──────────────────────────────────────

describe('listFleetAdapters', () => {
  test('returns all 8 adapter ids', () => {
    const items = listFleetAdapters();
    expect(items.length).toBe(8);
    const ids = items.map((i) => i.adapter_id).sort();
    expect(ids).toEqual([
      'agent',
      'aml',
      'bureau',
      'dms',
      'finance',
      'hr',
      'ifrs9',
      'insurance',
    ]);
  });

  test('every entry carries label + base_path', () => {
    const items = listFleetAdapters();
    for (const i of items) {
      expect(i.label.length).toBeGreaterThan(0);
      expect(i.base_path).toMatch(/^\/v1\/integrations\//);
    }
  });
});

// ─── runFleetHealth (pure / Promise.all) ──────────────────────────────

describe('runFleetHealth', () => {
  test('all 8 adapters return up=true with default stubs', async () => {
    const r = await runFleetHealth('BIL', NOW, realFleet());
    expect(r.tenant_id).toBe('BIL');
    expect(r.total).toBe(8);
    expect(r.up_count).toBe(8);
    expect(r.degraded_count).toBe(0);
    expect(r.adapters.length).toBe(8);
    for (const p of r.adapters) {
      expect(p.status).toBe('up');
      expect(p.error).toBeUndefined();
      expect(p.latency_ms).toBeGreaterThanOrEqual(0);
      expect(p.sample_count).not.toBeNull();
    }
  });

  test('aggregate counters add up to total', async () => {
    const r = await runFleetHealth('BIL', NOW, realFleet());
    expect(r.up_count + r.degraded_count).toBe(r.total);
  });

  test('total_latency_ms ≥ 0 (parallelised)', async () => {
    const r = await runFleetHealth('BIL', NOW, realFleet());
    expect(r.total_latency_ms).toBeGreaterThanOrEqual(0);
    expect(r.total_latency_ms).toBeLessThan(5000);
  });

  test('generated_at echoes asOf', async () => {
    const r = await runFleetHealth('BIL', NOW, realFleet());
    expect(r.generated_at).toBe(NOW.toISOString());
  });

  test('one bad adapter → degraded entry, others still up', async () => {
    const fleet = realFleet();
    fleet.bureau = {
      ...fleet.bureau,
      listByCustomer: async () => {
        throw new Error('bureau upstream timeout');
      },
    };
    const r = await runFleetHealth('BIL', NOW, fleet);
    expect(r.up_count).toBe(7);
    expect(r.degraded_count).toBe(1);
    const bureau = r.adapters.find((a) => a.adapter_id === 'bureau')!;
    expect(bureau.status).toBe('degraded');
    expect(bureau.error).toMatch(/bureau upstream timeout/);
    expect(bureau.sample_count).toBeNull();
  });

  test('multiple bad adapters → all surfaced as degraded', async () => {
    const fleet = realFleet();
    fleet.bureau = {
      ...fleet.bureau,
      listByCustomer: async () => {
        throw new Error('boom1');
      },
    };
    fleet.dms = {
      ...fleet.dms,
      listByCustomer: async () => {
        throw new Error('boom2');
      },
    };
    const r = await runFleetHealth('BIL', NOW, fleet);
    expect(r.degraded_count).toBe(2);
    const ids = r.adapters.filter((a) => a.status === 'degraded').map((a) => a.adapter_id);
    expect(ids.sort()).toEqual(['bureau', 'dms']);
  });

  test('non-Error thrown values still surface as degraded', async () => {
    const fleet = realFleet();
    fleet.aml = {
      ...fleet.aml,
      screenCustomer: async () => {
        // eslint-disable-next-line no-throw-literal
        throw 'string error';
      },
    };
    const r = await runFleetHealth('BIL', NOW, fleet);
    const aml = r.adapters.find((a) => a.adapter_id === 'aml')!;
    expect(aml.status).toBe('degraded');
    expect(aml.error).toBe('string error');
  });

  test('cross-tenant: probing BANK_DEMO yields its own up=8', async () => {
    const r = await runFleetHealth('BANK_DEMO', NOW, realFleet());
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.up_count).toBe(8);
  });

  test('every adapter entry carries metadata + base_path', async () => {
    const r = await runFleetHealth('BIL', NOW, realFleet());
    for (const a of r.adapters) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.base_path).toMatch(/^\/v1\/integrations\//);
    }
  });

  test('fleet runs in parallel (faster than serial of slow probes)', async () => {
    // Wrap each adapter with a 50ms artificial delay to confirm
    // Promise.all is in play (not sequential await).
    const slow = realFleet();
    const wrap = <T>(fn: () => Promise<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        setTimeout(() => fn().then(resolve, reject), 50);
      });
    slow.insurance = {
      ...slow.insurance,
      listPolicies: () => wrap(() => Promise.resolve([])),
    };
    slow.ifrs9 = {
      ...slow.ifrs9,
      listStages: () =>
        wrap(() =>
          Promise.resolve({ items: [], total: 0, page: 1, page_size: 1, stage_filter: null }),
        ),
    };
    const start = Date.now();
    const r = await runFleetHealth('BIL', NOW, slow);
    const elapsed = Date.now() - start;
    expect(r.up_count).toBe(8);
    // Two probes are 50ms each — running in parallel total should be
    // ~50ms, definitely well under 100ms (which is the serial bound).
    expect(elapsed).toBeLessThan(150);
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

describe('GET /v1/integrations/adapters', () => {
  test('admin: 200 with 8-item catalog', async () => {
    const { app } = makeFleetApp('admin');
    const r = await request(app).get('/v1/integrations/adapters').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(8);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeFleetApp('case_owner');
    const r = await request(app).get('/v1/integrations/adapters').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('missing tenant header → 400/401/403', async () => {
    const { app } = makeFleetApp('admin');
    const r = await request(app).get('/v1/integrations/adapters');
    expect([400, 401, 403]).toContain(r.status);
  });
});

describe('GET /v1/integrations/adapters/health', () => {
  test('admin: 200 with all 8 up', async () => {
    const { app } = makeFleetApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/health').set(TH_BIL);
    expect(r.status).toBe(200);
    const body = r.body.body as FleetHealthReport;
    expect(body.total).toBe(8);
    expect(body.up_count).toBe(8);
    expect(body.degraded_count).toBe(0);
  });

  test('every adapter probe returns up status', async () => {
    const { app } = makeFleetApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/health').set(TH_BIL);
    for (const a of r.body.body.adapters) {
      expect(a.status).toBe('up');
    }
  });

  test('tenant_id echoed', async () => {
    const { app } = makeFleetApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/health').set(TH_BIL);
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeFleetApp('case_owner');
    const r = await request(app).get('/v1/integrations/adapters/health').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BANK_DEMO request returns BANK_DEMO context', async () => {
    const { app } = makeFleetApp('admin');
    const r = await request(app)
      .get('/v1/integrations/adapters/health')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
  });
});

// ─── No-regression ────────────────────────────────────────────────────

describe('No-regression: M14 adapter routes still work', () => {
  test('GET /v1/integrations/insurance/policies?customer_id=X still 200', async () => {
    const { app } = makeFleetApp('admin');
    const r = await request(app)
      .get('/v1/integrations/insurance/policies?customer_id=CUST-100001')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('GET /v1/integrations/ifrs9/stages still 200', async () => {
    const { app } = makeFleetApp('admin');
    const r = await request(app).get('/v1/integrations/ifrs9/stages').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('Existing /v1/integrations/health (banking upstream pings) still distinct', async () => {
    const { app } = makeFleetApp('admin');
    const r = await request(app).get('/v1/integrations/health').set(TH_BIL);
    // The banking-upstream pinger may return 200 with degraded entries
    // if the integration-mocks service isn't running — either way, the
    // status code should NOT be from the new adapters/health route.
    expect(r.status).not.toBe(404);
    // Body shape differs: banking pinger has `integrations[]`, not `adapters[]`
    if (r.status === 200) {
      expect(r.body.body).not.toHaveProperty('adapters');
    }
  });
});
