// services/bff/__tests__/adapter_sla_budget.test.ts
//
// T6 M14.26 — Adapter SLA latency budget check.

import request from 'supertest';
import { buildAdapterSlaBudgetReport } from '../src/adapter_sla_budget';
import { listAdapterSlaCatalog } from '../src/adapter_sla_catalog';
import { listFleetAdapters, type AdapterFleet } from '../src/adapter_health';
import { StubInsuranceAdapter } from '../src/integrations/insurance';
import { StubIfrs9Adapter } from '../src/integrations/ifrs9';
import { StubAmlAdapter } from '../src/integrations/aml';
import { StubDmsAdapter } from '../src/integrations/dms';
import { StubBureauAdapter } from '../src/integrations/bureau';
import { StubAgentAdapter } from '../src/integrations/agent';
import { StubFinanceAdapter } from '../src/integrations/finance';
import { StubHrAdapter } from '../src/integrations/hr';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function buildFleet(): AdapterFleet {
  return {
    insurance: new StubInsuranceAdapter(),
    ifrs9: new StubIfrs9Adapter(),
    aml: new StubAmlAdapter(),
    dms: new StubDmsAdapter(),
    bureau: new StubBureauAdapter(),
    agent: new StubAgentAdapter(),
    finance: new StubFinanceAdapter(),
    hr: new StubHrAdapter(),
  };
}

// ─── buildAdapterSlaBudgetReport — pure ──────────────────────────────

describe('M14.26 — fleet coverage', () => {
  test('every M14.23 adapter in SLA catalog covered', async () => {
    const r = await buildAdapterSlaBudgetReport('BIL', NOW, buildFleet());
    const slaIds = new Set(listAdapterSlaCatalog().adapters.map((a) => a.adapter_id));
    const reportIds = new Set(r.adapters.map((a) => a.adapter_id));
    for (const id of slaIds) {
      expect(reportIds.has(id)).toBe(true);
    }
    expect(r.total_adapters).toBe(slaIds.size);
  });

  test('every fleet adapter (M14.9) appears in report', async () => {
    const r = await buildAdapterSlaBudgetReport('BIL', NOW, buildFleet());
    const fleetIds = new Set(listFleetAdapters().map((a) => a.adapter_id));
    const reportIds = new Set(r.adapters.map((a) => a.adapter_id));
    for (const id of fleetIds) {
      expect(reportIds.has(id)).toBe(true);
    }
  });
});

describe('M14.26 — within_budget verdict', () => {
  test('observed below expected → within_budget', async () => {
    const r = await buildAdapterSlaBudgetReport('BIL', NOW, buildFleet());
    // Stubs return ~immediately — latency should be way under any SLA.
    // Verify the verdict + within_budget flag for at least most adapters.
    const withinBudget = r.adapters.filter((a) => a.verdict === 'within_budget');
    expect(withinBudget.length).toBeGreaterThan(0);
    for (const a of withinBudget) {
      expect(a.within_budget).toBe(true);
      expect(a.headroom_ms).not.toBeNull();
      expect(a.headroom_ms!).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('M14.26 — headroom arithmetic', () => {
  test('headroom_ms = expected - observed', async () => {
    const r = await buildAdapterSlaBudgetReport('BIL', NOW, buildFleet());
    for (const a of r.adapters) {
      if (a.observed_latency_ms === null) continue;
      expect(a.headroom_ms).toBe(a.expected_p95_ms - a.observed_latency_ms);
    }
  });

  test('headroom_pct = headroom_ms / expected', async () => {
    const r = await buildAdapterSlaBudgetReport('BIL', NOW, buildFleet());
    for (const a of r.adapters) {
      if (a.headroom_pct === null) continue;
      expect(a.headroom_pct).toBeCloseTo(a.headroom_ms! / a.expected_p95_ms);
    }
  });
});

describe('M14.26 — totals sum invariant', () => {
  test('within + over + degraded = total_adapters', async () => {
    const r = await buildAdapterSlaBudgetReport('BIL', NOW, buildFleet());
    const sum = r.total_within_budget + r.total_over_budget + r.total_degraded;
    expect(sum).toBe(r.total_adapters);
  });

  test('over_budget_severe ⊆ over_budget', async () => {
    const r = await buildAdapterSlaBudgetReport('BIL', NOW, buildFleet());
    expect(r.total_over_budget_severe).toBeLessThanOrEqual(r.total_over_budget);
  });
});

describe('M14.26 — sort order', () => {
  test('rows sorted by headroom_ms asc with degraded pinned last', async () => {
    const r = await buildAdapterSlaBudgetReport('BIL', NOW, buildFleet());
    let sawNullHeadroom = false;
    let prevHeadroom = -Infinity;
    for (const a of r.adapters) {
      if (a.headroom_ms === null) {
        sawNullHeadroom = true;
      } else {
        expect(sawNullHeadroom).toBe(false); // non-null must precede nulls
        expect(a.headroom_ms).toBeGreaterThanOrEqual(prevHeadroom);
        prevHeadroom = a.headroom_ms;
      }
    }
  });
});

describe('M14.26 — verdict enum exhaustive', () => {
  test('every row has a valid verdict', async () => {
    const r = await buildAdapterSlaBudgetReport('BIL', NOW, buildFleet());
    const valid = ['within_budget', 'over_budget', 'over_budget_severe', 'degraded'];
    for (const a of r.adapters) {
      expect(valid).toContain(a.verdict);
    }
  });
});

describe('M14.26 — degraded probe handling', () => {
  test('degraded adapter → observed_latency_ms=null + verdict=degraded', async () => {
    const fleet = buildFleet();
    // Force the AML adapter to throw on screenCustomer (the probe path)
    fleet.aml = {
      ...fleet.aml,
      screenCustomer: () => Promise.reject(new Error('synthetic outage')),
    } as typeof fleet.aml;
    const r = await buildAdapterSlaBudgetReport('BIL', NOW, fleet);
    const aml = r.adapters.find((a) => a.adapter_id === 'aml')!;
    expect(aml.status).toBe('degraded');
    expect(aml.observed_latency_ms).toBeNull();
    expect(aml.headroom_ms).toBeNull();
    expect(aml.within_budget).toBe(false);
    expect(aml.verdict).toBe('degraded');
    expect(aml.error).toBeTruthy();
    expect(r.total_degraded).toBe(1);
  });
});

describe('M14.26 — worst_offender + most_slack', () => {
  test('most_slack is the adapter with the most positive headroom', async () => {
    const r = await buildAdapterSlaBudgetReport('BIL', NOW, buildFleet());
    if (r.most_slack) {
      const maxHeadroom = Math.max(
        ...r.adapters.filter((a) => a.headroom_ms !== null).map((a) => a.headroom_ms!),
      );
      expect(r.most_slack.headroom_ms).toBe(maxHeadroom);
    }
  });

  test('worst_offender null when no over-budget adapters', async () => {
    const r = await buildAdapterSlaBudgetReport('BIL', NOW, buildFleet());
    if (r.total_over_budget === 0) {
      expect(r.worst_offender).toBeNull();
    }
  });
});

describe('M14.26 — tenant scope', () => {
  test('tenant_id + generated_at echoed', async () => {
    const r = await buildAdapterSlaBudgetReport('BIL', NOW, buildFleet());
    expect(r.tenant_id).toBe('BIL');
    expect(r.generated_at).toBe(NOW.toISOString());
  });
});

describe('M14.26 — label echoed from probe', () => {
  test('labels match probe labels', async () => {
    const r = await buildAdapterSlaBudgetReport('BIL', NOW, buildFleet());
    const probes = listFleetAdapters();
    const labelById = new Map(probes.map((p) => [p.adapter_id, p.label]));
    for (const a of r.adapters) {
      expect(a.label).toBe(labelById.get(a.adapter_id));
    }
  });
});

// ─── GET /v1/integrations/adapters/sla-budget ────────────────────────

function makeBudgetApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('M14.26 — GET /v1/integrations/adapters/sla-budget', () => {
  test('admin → 200 with full report', async () => {
    const { app } = makeBudgetApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/sla-budget').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_adapters).toBeGreaterThan(0);
    expect(r.body.body.adapters.length).toBe(r.body.body.total_adapters);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBudgetApp('case_owner');
    const r = await request(app).get('/v1/integrations/adapters/sla-budget').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M14.23 /v1/integrations/adapters/sla-catalog still works (sibling)', async () => {
    const { app } = makeBudgetApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/sla-catalog').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M14.9 /v1/integrations/adapters/health still works (sibling)', async () => {
    const { app } = makeBudgetApp('admin');
    const r = await request(app).get('/v1/integrations/adapters/health').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
