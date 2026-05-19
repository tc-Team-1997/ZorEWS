// services/bff/__tests__/tenant_onboarding_stage_vertical_matrix.test.ts
//
// T6 M2.17 — Onboarding milestone stage × tenant vertical cross-tab matrix.

import request from 'supertest';
import {
  buildOnboardingStageVerticalMatrix,
  ALL_ONBOARDING_STAGES,
} from '../src/tenant_onboarding_stage_vertical_matrix';
import { ALL_TENANT_VERTICALS } from '../src/tenant_onboarding_step_vertical_matrix';
import type { Tenant, TenantLookup } from '../src/tenant';
import { ONBOARDING_STEPS, InMemoryOnboardingStore } from '../src/tenant_onboarding';
import type { OnboardingState, OnboardingStore } from '../src/tenant_onboarding';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTenant(tenant_id: string, vertical: 'banking' | 'insurance'): Tenant {
  return {
    tenant_id,
    name: tenant_id,
    vertical,
    channels_allowed: ['API'],
    active: true,
  };
}

function makeTenantLookup(tenants: Tenant[]): TenantLookup {
  const byId = new Map(tenants.map((t) => [t.tenant_id, t]));
  const fn = ((id: string) => byId.get(id)) as TenantLookup;
  fn.all = () => tenants;
  return fn;
}

function makeStateGetter(scoresByTenant: Record<string, number>) {
  return (tenant_id: string): OnboardingState => {
    const targetScore = scoresByTenant[tenant_id] ?? 0;
    // Build state with the right completion count to achieve approximate score.
    // Use M2.6 formula: round(0.7 × required_pct + 0.3 × overall_pct).
    // For simplicity, mark N required steps completed to drive score.
    const requiredSteps = ONBOARDING_STEPS.filter((s) => s.required);
    const allSteps = ONBOARDING_STEPS;
    // For target=0 → no completions
    // For target=100 → all completed
    // Inverse: how many required to mark completed for target?
    // Simplest: count complete = target * total / 100
    const completeCount =
      targetScore === 0
        ? 0
        : Math.round((targetScore / 100) * allSteps.length);

    return {
      tenant_id,
      steps: allSteps.map((s, i) => ({
        step_id: s.id,
        status: i < completeCount ? 'completed' : 'pending',
        completed_at: i < completeCount ? NOW.toISOString() : null,
        completed_by: i < completeCount ? 'alice' : null,
        notes: null,
        skip_reason: null,
      })),
      total_steps: allSteps.length,
      required_steps: requiredSteps.length,
      completed_count: completeCount,
      skipped_count: 0,
      pending_count: allSteps.length - completeCount,
      is_complete: completeCount === allSteps.length,
      updated_at: NOW.toISOString(),
    };
  };
}

function makeTestApp(
  role: string = 'admin',
  tenantLookup?: TenantLookup,
  onboardingStore?: OnboardingStore,
) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    tenantLookup,
    onboardingStore,
  });
}

// ─── Pure resolver ─────────────────────────────────────────────────────

describe('M2.17 — buildOnboardingStageVerticalMatrix', () => {
  test('empty tenants → empty matrix', async () => {
    const m = await buildOnboardingStageVerticalMatrix([], makeStateGetter({}), NOW);
    expect(m.total_tenants).toBe(0);
    expect(m.total_stages).toBe(5);
    expect(m.total_verticals).toBe(2);
    expect(m.rows.length).toBe(5);
    expect(m.columns.length).toBe(2);
    for (const row of m.rows) {
      expect(row.total).toBe(0);
      expect(row.verticals_without).toEqual([...ALL_TENANT_VERTICALS]);
    }
    for (const col of m.columns) {
      expect(col.total).toBe(0);
      expect(col.mean_completeness_score).toBeNull();
      expect(col.tenant_ids).toEqual([]);
    }
    expect(m.peak_cell).toBeNull();
    expect(m.fastest_vertical).toBeNull();
    expect(m.slowest_vertical).toBeNull();
    expect(m.empty_cells.length).toBe(10);
  });

  test('rows in canonical stage order', async () => {
    const m = await buildOnboardingStageVerticalMatrix([], makeStateGetter({}), NOW);
    expect(m.rows.map((r) => r.stage)).toEqual([...ALL_ONBOARDING_STAGES]);
  });

  test('columns in canonical vertical order', async () => {
    const m = await buildOnboardingStageVerticalMatrix([], makeStateGetter({}), NOW);
    expect(m.columns.map((c) => c.vertical)).toEqual([...ALL_TENANT_VERTICALS]);
  });

  test('single banking tenant at score=0 → starting/banking cell', async () => {
    const tenants = [makeTenant('TENANT_A', 'banking')];
    const m = await buildOnboardingStageVerticalMatrix(
      tenants,
      makeStateGetter({ TENANT_A: 0 }),
      NOW,
    );
    expect(m.total_tenants).toBe(1);
    const startingRow = m.rows.find((r) => r.stage === 'starting')!;
    expect(startingRow.by_vertical.banking).toBe(1);
    expect(startingRow.total).toBe(1);
    const bankingCol = m.columns.find((c) => c.vertical === 'banking')!;
    expect(bankingCol.total).toBe(1);
    expect(bankingCol.by_stage.starting).toBe(1);
    expect(bankingCol.tenant_ids).toEqual(['TENANT_A']);
    expect(bankingCol.mean_completeness_score).toBe(0);
  });

  test('every by_vertical key present per row', async () => {
    const m = await buildOnboardingStageVerticalMatrix([], makeStateGetter({}), NOW);
    for (const row of m.rows) {
      for (const v of ALL_TENANT_VERTICALS) {
        expect(row.by_vertical[v]).toBeGreaterThanOrEqual(0);
      }
      expect(Object.keys(row.by_vertical).length).toBe(2);
    }
  });

  test('every by_stage key present per column', async () => {
    const m = await buildOnboardingStageVerticalMatrix([], makeStateGetter({}), NOW);
    for (const col of m.columns) {
      for (const s of ALL_ONBOARDING_STAGES) {
        expect(col.by_stage[s]).toBeGreaterThanOrEqual(0);
      }
      expect(Object.keys(col.by_stage).length).toBe(5);
    }
  });

  test('Σ row.by_vertical = row.total partition invariant', async () => {
    const tenants = [
      makeTenant('T1', 'banking'),
      makeTenant('T2', 'banking'),
      makeTenant('T3', 'insurance'),
    ];
    const m = await buildOnboardingStageVerticalMatrix(
      tenants,
      makeStateGetter({ T1: 0, T2: 0, T3: 0 }),
      NOW,
    );
    for (const row of m.rows) {
      const sum = ALL_TENANT_VERTICALS.reduce((a, v) => a + row.by_vertical[v], 0);
      expect(sum).toBe(row.total);
    }
  });

  test('Σ col.by_stage = col.total partition', async () => {
    const tenants = [
      makeTenant('T1', 'banking'),
      makeTenant('T2', 'banking'),
    ];
    const m = await buildOnboardingStageVerticalMatrix(
      tenants,
      makeStateGetter({ T1: 0, T2: 50 }),
      NOW,
    );
    for (const col of m.columns) {
      const sum = ALL_ONBOARDING_STAGES.reduce((a, s) => a + col.by_stage[s], 0);
      expect(sum).toBe(col.total);
    }
  });

  test('grand-total cross-check Σ rows = Σ cols = total_tenants', async () => {
    const tenants = [
      makeTenant('T1', 'banking'),
      makeTenant('T2', 'banking'),
      makeTenant('T3', 'insurance'),
    ];
    const m = await buildOnboardingStageVerticalMatrix(
      tenants,
      makeStateGetter({ T1: 0, T2: 0, T3: 0 }),
      NOW,
    );
    const rowSum = m.rows.reduce((a, r) => a + r.total, 0);
    const colSum = m.columns.reduce((a, c) => a + c.total, 0);
    expect(rowSum).toBe(m.total_tenants);
    expect(colSum).toBe(m.total_tenants);
    expect(rowSum).toBe(3);
  });

  test('cell cross-check: row.by_vertical[V] === col[V].by_stage[stage]', async () => {
    const tenants = [
      makeTenant('T1', 'banking'),
      makeTenant('T2', 'insurance'),
      makeTenant('T3', 'banking'),
    ];
    const m = await buildOnboardingStageVerticalMatrix(
      tenants,
      makeStateGetter({ T1: 0, T2: 50, T3: 0 }),
      NOW,
    );
    for (const row of m.rows) {
      for (const v of ALL_TENANT_VERTICALS) {
        const fromRow = row.by_vertical[v];
        const col = m.columns.find((c) => c.vertical === v)!;
        const fromCol = col.by_stage[row.stage];
        expect(fromRow).toBe(fromCol);
      }
    }
  });

  test('tenant_ids per column sorted asc', async () => {
    const tenants = [
      makeTenant('ZEBRA', 'banking'),
      makeTenant('ALPHA', 'banking'),
      makeTenant('MIKE', 'banking'),
    ];
    const m = await buildOnboardingStageVerticalMatrix(
      tenants,
      makeStateGetter({ ZEBRA: 0, ALPHA: 0, MIKE: 0 }),
      NOW,
    );
    const bankingCol = m.columns.find((c) => c.vertical === 'banking')!;
    expect(bankingCol.tenant_ids).toEqual(['ALPHA', 'MIKE', 'ZEBRA']);
  });

  test('peak_cell formula = highest cell count', async () => {
    const tenants = [
      makeTenant('T1', 'banking'),
      makeTenant('T2', 'banking'),
      makeTenant('T3', 'banking'),
      makeTenant('T4', 'insurance'),
    ];
    const m = await buildOnboardingStageVerticalMatrix(
      tenants,
      makeStateGetter({ T1: 0, T2: 0, T3: 0, T4: 0 }),
      NOW,
    );
    // 3 banking + 1 insurance all in 'starting' → starting/banking cell wins
    expect(m.peak_cell).toEqual({
      stage: 'starting',
      vertical: 'banking',
      count: 3,
    });
  });

  test('peak_cell canonical iteration tie-break', async () => {
    const tenants = [
      makeTenant('T1', 'banking'),
      makeTenant('T2', 'insurance'),
    ];
    const m = await buildOnboardingStageVerticalMatrix(
      tenants,
      makeStateGetter({ T1: 0, T2: 0 }),
      NOW,
    );
    // Both at starting; tied at 1 each. Canonical iteration: stage starting
    // (first row) × banking (first col) → starting/banking wins.
    expect(m.peak_cell?.stage).toBe('starting');
    expect(m.peak_cell?.vertical).toBe('banking');
  });

  test('peak_cell null on empty', async () => {
    const m = await buildOnboardingStageVerticalMatrix([], makeStateGetter({}), NOW);
    expect(m.peak_cell).toBeNull();
  });

  test('fastest_vertical + slowest_vertical formulas', async () => {
    const tenants = [
      makeTenant('T1', 'banking'), // score 0 → mean banking = 0
      makeTenant('T2', 'insurance'), // score 100 → mean insurance = 100
    ];
    const m = await buildOnboardingStageVerticalMatrix(
      tenants,
      makeStateGetter({ T1: 0, T2: 100 }),
      NOW,
    );
    expect(m.fastest_vertical).toBe('insurance');
    expect(m.slowest_vertical).toBe('banking');
  });

  test('fastest_vertical canonical tie-break (banking wins at tied mean)', async () => {
    const tenants = [
      makeTenant('T1', 'banking'),
      makeTenant('T2', 'insurance'),
    ];
    const m = await buildOnboardingStageVerticalMatrix(
      tenants,
      makeStateGetter({ T1: 50, T2: 50 }),
      NOW,
    );
    // Tied at 50 → banking wins (canonical first)
    expect(m.fastest_vertical).toBe('banking');
    expect(m.slowest_vertical).toBe('banking');
  });

  test('fastest_vertical null on empty', async () => {
    const m = await buildOnboardingStageVerticalMatrix([], makeStateGetter({}), NOW);
    expect(m.fastest_vertical).toBeNull();
    expect(m.slowest_vertical).toBeNull();
  });

  test('verticals_without per row canonical order', async () => {
    const tenants = [makeTenant('T1', 'banking')];
    const m = await buildOnboardingStageVerticalMatrix(
      tenants,
      makeStateGetter({ T1: 0 }),
      NOW,
    );
    // 'starting' row has banking=1, insurance=0 → insurance in verticals_without
    const startingRow = m.rows.find((r) => r.stage === 'starting')!;
    expect(startingRow.verticals_without).toEqual(['insurance']);
  });

  test('stages_without per column canonical order', async () => {
    const tenants = [makeTenant('T1', 'banking')];
    const m = await buildOnboardingStageVerticalMatrix(
      tenants,
      makeStateGetter({ T1: 0 }),
      NOW,
    );
    const bankingCol = m.columns.find((c) => c.vertical === 'banking')!;
    // Only starting has banking → other 4 stages in stages_without
    expect(bankingCol.stages_without.length).toBe(4);
    expect(bankingCol.stages_without).toEqual(
      ALL_ONBOARDING_STAGES.filter((s) => s !== 'starting'),
    );
  });

  test('empty_cells in canonical stage × vertical row-major order', async () => {
    const tenants = [
      makeTenant('T1', 'banking'),
      makeTenant('T2', 'insurance'),
    ];
    const m = await buildOnboardingStageVerticalMatrix(
      tenants,
      makeStateGetter({ T1: 0, T2: 100 }),
      NOW,
    );
    // starting/banking + complete/insurance populated; 8 empty.
    expect(m.empty_cells.length).toBe(8);
    // First should be (starting, insurance)
    expect(m.empty_cells[0]).toEqual({ stage: 'starting', vertical: 'insurance' });
    // (complete, banking) should appear before (complete, insurance) in row-major; but insurance is populated
    expect(m.empty_cells.find(
      (c) => c.stage === 'complete' && c.vertical === 'banking',
    )).toBeDefined();
  });

  test('out-of-enum tenant.vertical skipped', async () => {
    const tenants = [
      { tenant_id: 'T1', name: 'T1', vertical: 'unknown' as never, channels_allowed: ['API'], active: true } as Tenant,
      makeTenant('T2', 'banking'),
    ];
    const m = await buildOnboardingStageVerticalMatrix(
      tenants,
      makeStateGetter({ T1: 0, T2: 0 }),
      NOW,
    );
    expect(m.total_tenants).toBe(1);
  });

  test('total_stages + total_verticals constants', async () => {
    const m = await buildOnboardingStageVerticalMatrix([], makeStateGetter({}), NOW);
    expect(m.total_stages).toBe(5);
    expect(m.total_verticals).toBe(2);
  });

  test('generated_at echo', async () => {
    const m = await buildOnboardingStageVerticalMatrix([], makeStateGetter({}), NOW);
    expect(m.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M2.17 — GET /v1/tenants/onboarding/stage-vertical-matrix', () => {
  test('admin → 200 with default 2-tenant registry', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/tenants/onboarding/stage-vertical-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    // Default registry has BANK_DEMO (banking) + BIL (insurance)
    expect(r.body.body.total_tenants).toBe(2);
    expect(r.body.body.rows.length).toBe(5);
    expect(r.body.body.columns.length).toBe(2);
  });

  test('501 when tenantLookup lacks all()', async () => {
    // Lookup must resolve the BIL tenant header but NOT expose all().
    const bilTenant = makeTenant('BIL', 'insurance');
    const lookup = ((id: string) => (id === 'BIL' ? bilTenant : undefined)) as TenantLookup;
    // Intentionally NO all() method
    const { app } = makeTestApp('admin', lookup);
    const r = await request(app)
      .get('/v1/tenants/onboarding/stage-vertical-matrix')
      .set(TH);
    expect(r.status).toBe(501);
    expect(r.body.error.code).toBe('EWS_501_not_implemented');
  });

  test('populated reflects markStep activity', async () => {
    // Use default tenantLookup (BANK_DEMO + BIL).
    const store = new InMemoryOnboardingStore();
    // Complete every step of BANK_DEMO → score=100 → complete stage
    for (const step of ONBOARDING_STEPS) {
      store.markStep('BANK_DEMO', step.id, 'completed', 'alice', null, NOW);
    }
    const { app } = makeTestApp('admin', undefined, store);
    const r = await request(app)
      .get('/v1/tenants/onboarding/stage-vertical-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_tenants).toBe(2);
    // BANK_DEMO at complete, BIL at starting (no activity)
    const completeRow = r.body.body.rows.find(
      (row: { stage: string }) => row.stage === 'complete',
    );
    expect(completeRow.by_vertical.banking).toBe(1);
    const startingRow = r.body.body.rows.find(
      (row: { stage: string }) => row.stage === 'starting',
    );
    expect(startingRow.by_vertical.insurance).toBe(1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTestApp('case_owner');
    const r = await request(app)
      .get('/v1/tenants/onboarding/stage-vertical-matrix')
      .set(TH);
    expect(r.status).toBe(403);
  });

  test('M2.14 /step-vertical-matrix sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/tenants/onboarding/step-vertical-matrix')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('literal /stage-vertical-matrix not captured by /:tenant_id wildcard', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/tenants/onboarding/stage-vertical-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.rows).toBeDefined();
  });
});
