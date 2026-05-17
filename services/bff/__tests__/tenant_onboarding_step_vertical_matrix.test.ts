// services/bff/__tests__/tenant_onboarding_step_vertical_matrix.test.ts
//
// T6 M2.14 — Onboarding step × tenant-vertical cross-tab matrix.

import request from 'supertest';
import {
  buildOnboardingStepVerticalMatrix,
  ALL_TENANT_VERTICALS,
} from '../src/tenant_onboarding_step_vertical_matrix';
import {
  InMemoryOnboardingStore,
  ONBOARDING_STEPS,
} from '../src/tenant_onboarding';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import type { Tenant } from '../src/tenant';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeSvApp(role: string = 'admin') {
  const store = new InMemoryOnboardingStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    onboardingStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

function tenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    tenant_id: 'BIL',
    name: 'BIL test',
    vertical: 'banking',
    channels_allowed: ['API'],
    active: true,
    ...overrides,
  };
}

// ─── buildOnboardingStepVerticalMatrix — pure ────────────────────────

describe('M2.14 — empty fleet', () => {
  test('zero tenants → every row × col at 0; null leaderboards', () => {
    const store = new InMemoryOnboardingStore();
    const m = buildOnboardingStepVerticalMatrix([], (id) => store.get(id), NOW);
    expect(m.generated_at).toBe(NOW.toISOString());
    expect(m.total_tenants).toBe(0);
    expect(m.total_steps).toBe(ONBOARDING_STEPS.length);
    expect(m.total_verticals).toBe(ALL_TENANT_VERTICALS.length);
    expect(m.rows.length).toBe(ONBOARDING_STEPS.length);
    expect(m.columns.length).toBe(2);
    for (const row of m.rows) {
      expect(row.total_completed).toBe(0);
      for (const v of ALL_TENANT_VERTICALS) {
        expect(row.by_vertical[v]).toBe(0);
      }
    }
    expect(m.peak_cell).toBeNull();
    expect(m.fastest_vertical).toBeNull();
    expect(m.slowest_vertical).toBeNull();
    expect(m.empty_cells.length).toBe(ONBOARDING_STEPS.length * 2);
  });
});

describe('M2.14 — rows in canonical step.order asc', () => {
  test('rows[] follow ONBOARDING_STEPS as supplied', () => {
    const m = buildOnboardingStepVerticalMatrix([], (id) => new InMemoryOnboardingStore().get(id), NOW);
    expect(m.rows.map((r) => r.step_id)).toEqual(ONBOARDING_STEPS.map((s) => s.id));
  });
});

describe('M2.14 — columns in canonical vertical order', () => {
  test('columns[] follows ALL_TENANT_VERTICALS (banking → insurance)', () => {
    const m = buildOnboardingStepVerticalMatrix([], (id) => new InMemoryOnboardingStore().get(id), NOW);
    expect(m.columns.map((c) => c.vertical)).toEqual([...ALL_TENANT_VERTICALS]);
  });
});

describe('M2.14 — single tenant single completion', () => {
  test('1 banking tenant completes step → cell populated', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('T1', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    const m = buildOnboardingStepVerticalMatrix(
      [tenant({ tenant_id: 'T1', vertical: 'banking' })],
      (id) => store.get(id),
      NOW,
    );
    expect(m.total_tenants).toBe(1);
    const row = m.rows.find((r) => r.step_id === 'tenant_provisioned')!;
    expect(row.by_vertical.banking).toBe(1);
    expect(row.by_vertical.insurance).toBe(0);
    expect(row.total_completed).toBe(1);
    const banking = m.columns.find((c) => c.vertical === 'banking')!;
    expect(banking.total_tenants).toBe(1);
    expect(banking.by_step.tenant_provisioned).toBe(1);
    expect(m.peak_cell).toEqual({
      step_id: 'tenant_provisioned',
      vertical: 'banking',
      completed_count: 1,
      completion_rate: 1,
    });
  });
});

describe('M2.14 — total_tenants tracks vertical totals', () => {
  test('Σ per-vertical totals = total_tenants', () => {
    const store = new InMemoryOnboardingStore();
    const tenants: Tenant[] = [
      tenant({ tenant_id: 'B1', vertical: 'banking' }),
      tenant({ tenant_id: 'B2', vertical: 'banking' }),
      tenant({ tenant_id: 'I1', vertical: 'insurance' }),
    ];
    const m = buildOnboardingStepVerticalMatrix(tenants, (id) => store.get(id), NOW);
    expect(m.total_tenants).toBe(3);
    expect(m.columns.find((c) => c.vertical === 'banking')!.total_tenants).toBe(2);
    expect(m.columns.find((c) => c.vertical === 'insurance')!.total_tenants).toBe(1);
  });
});

describe('M2.14 — per-row partition invariant', () => {
  test('Σ by_vertical = row.total_completed per row', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('B1', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    store.markStep('I1', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    const tenants: Tenant[] = [
      tenant({ tenant_id: 'B1', vertical: 'banking' }),
      tenant({ tenant_id: 'I1', vertical: 'insurance' }),
    ];
    const m = buildOnboardingStepVerticalMatrix(tenants, (id) => store.get(id), NOW);
    for (const row of m.rows) {
      expect(row.by_vertical.banking + row.by_vertical.insurance).toBe(row.total_completed);
    }
  });
});

describe('M2.14 — per-column partition invariant', () => {
  test('Σ by_step = col.total_completed per col', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('B1', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    store.markStep('B1', 'channels_configured', 'completed', 'admin', null, NOW);
    const tenants = [tenant({ tenant_id: 'B1', vertical: 'banking' })];
    const m = buildOnboardingStepVerticalMatrix(tenants, (id) => store.get(id), NOW);
    for (const col of m.columns) {
      const sum = Object.values(col.by_step).reduce((a, b) => a + b, 0);
      expect(col.total_completed).toBe(sum);
    }
  });
});

describe('M2.14 — grand-total cross-check', () => {
  test('Σ rows.total_completed = Σ cols.total_completed', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('B1', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    store.markStep('I1', 'channels_configured', 'completed', 'admin', null, NOW);
    const tenants: Tenant[] = [
      tenant({ tenant_id: 'B1', vertical: 'banking' }),
      tenant({ tenant_id: 'I1', vertical: 'insurance' }),
    ];
    const m = buildOnboardingStepVerticalMatrix(tenants, (id) => store.get(id), NOW);
    const rowSum = m.rows.reduce((acc, r) => acc + r.total_completed, 0);
    const colSum = m.columns.reduce((acc, c) => acc + c.total_completed, 0);
    expect(rowSum).toBe(colSum);
    expect(rowSum).toBe(2);
  });
});

describe('M2.14 — every-vertical-key-present per row', () => {
  test('row.by_vertical has both banking + insurance', () => {
    const store = new InMemoryOnboardingStore();
    const m = buildOnboardingStepVerticalMatrix([], (id) => store.get(id), NOW);
    for (const row of m.rows) {
      expect(row.by_vertical).toHaveProperty('banking');
      expect(row.by_vertical).toHaveProperty('insurance');
    }
  });
});

describe('M2.14 — every-step-key-present per column', () => {
  test('col.by_step has every OnboardingStepId key', () => {
    const store = new InMemoryOnboardingStore();
    const m = buildOnboardingStepVerticalMatrix([], (id) => store.get(id), NOW);
    for (const col of m.columns) {
      for (const step of ONBOARDING_STEPS) {
        expect(col.by_step).toHaveProperty(step.id);
      }
    }
  });
});

describe('M2.14 — cell cross-check invariant', () => {
  test('row[step].by_vertical[v] === col[v].by_step[step] for every pair', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('B1', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    store.markStep('I1', 'channels_configured', 'completed', 'admin', null, NOW);
    const tenants: Tenant[] = [
      tenant({ tenant_id: 'B1', vertical: 'banking' }),
      tenant({ tenant_id: 'I1', vertical: 'insurance' }),
    ];
    const m = buildOnboardingStepVerticalMatrix(tenants, (id) => store.get(id), NOW);
    for (const row of m.rows) {
      for (const col of m.columns) {
        expect(row.by_vertical[col.vertical]).toBe(col.by_step[row.step_id]);
      }
    }
  });
});

describe('M2.14 — verticals_without per row', () => {
  test('canonical vertical order; entries have by_vertical=0', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('B1', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    const tenants = [tenant({ tenant_id: 'B1', vertical: 'banking' })];
    const m = buildOnboardingStepVerticalMatrix(tenants, (id) => store.get(id), NOW);
    const row = m.rows.find((r) => r.step_id === 'tenant_provisioned')!;
    expect(row.verticals_without).toEqual(['insurance']);
  });
});

describe('M2.14 — steps_universally_completed', () => {
  test('lists steps every tenant in vertical has completed', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('B1', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    store.markStep('B2', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    store.markStep('B1', 'channels_configured', 'completed', 'admin', null, NOW);
    const tenants: Tenant[] = [
      tenant({ tenant_id: 'B1', vertical: 'banking' }),
      tenant({ tenant_id: 'B2', vertical: 'banking' }),
    ];
    const m = buildOnboardingStepVerticalMatrix(tenants, (id) => store.get(id), NOW);
    const banking = m.columns.find((c) => c.vertical === 'banking')!;
    // Both completed tenant_provisioned (universal); only B1 did channels_configured (not universal).
    expect(banking.steps_universally_completed).toContain('tenant_provisioned');
    expect(banking.steps_universally_completed).not.toContain('channels_configured');
  });

  test('empty when vertical has zero tenants', () => {
    const store = new InMemoryOnboardingStore();
    const m = buildOnboardingStepVerticalMatrix([], (id) => store.get(id), NOW);
    for (const col of m.columns) {
      expect(col.steps_universally_completed).toEqual([]);
    }
  });
});

describe('M2.14 — peak_cell formula', () => {
  test('points at highest-count cell', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('B1', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    store.markStep('B2', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    store.markStep('B3', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    store.markStep('I1', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    const tenants: Tenant[] = [
      tenant({ tenant_id: 'B1', vertical: 'banking' }),
      tenant({ tenant_id: 'B2', vertical: 'banking' }),
      tenant({ tenant_id: 'B3', vertical: 'banking' }),
      tenant({ tenant_id: 'I1', vertical: 'insurance' }),
    ];
    const m = buildOnboardingStepVerticalMatrix(tenants, (id) => store.get(id), NOW);
    expect(m.peak_cell!.step_id).toBe('tenant_provisioned');
    expect(m.peak_cell!.vertical).toBe('banking');
    expect(m.peak_cell!.completed_count).toBe(3);
    expect(m.peak_cell!.completion_rate).toBe(1); // 3 of 3 banking tenants
  });

  test('canonical iteration tie-break: step.order asc × vertical asc', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('B1', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    store.markStep('I1', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    const tenants: Tenant[] = [
      tenant({ tenant_id: 'B1', vertical: 'banking' }),
      tenant({ tenant_id: 'I1', vertical: 'insurance' }),
    ];
    const m = buildOnboardingStepVerticalMatrix(tenants, (id) => store.get(id), NOW);
    // Tied at 1 each; canonical order picks banking first.
    expect(m.peak_cell!.vertical).toBe('banking');
  });

  test('null when no completions anywhere', () => {
    const store = new InMemoryOnboardingStore();
    const tenants = [tenant({ tenant_id: 'B1', vertical: 'banking' })];
    const m = buildOnboardingStepVerticalMatrix(tenants, (id) => store.get(id), NOW);
    expect(m.peak_cell).toBeNull();
  });
});

describe('M2.14 — empty_cells canonical row-major order', () => {
  test('step.order asc × vertical canonical', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('B1', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    const tenants = [tenant({ tenant_id: 'B1', vertical: 'banking' })];
    const m = buildOnboardingStepVerticalMatrix(tenants, (id) => store.get(id), NOW);
    const stepOrder = ONBOARDING_STEPS.map((s) => s.id);
    for (let i = 1; i < m.empty_cells.length; i++) {
      const prev = m.empty_cells[i - 1]!;
      const curr = m.empty_cells[i]!;
      const prevIdx = stepOrder.indexOf(prev.step_id);
      const currIdx = stepOrder.indexOf(curr.step_id);
      if (prevIdx !== currIdx) {
        expect(currIdx).toBeGreaterThan(prevIdx);
      } else {
        const prevVIdx = ALL_TENANT_VERTICALS.indexOf(prev.vertical);
        const currVIdx = ALL_TENANT_VERTICALS.indexOf(curr.vertical);
        expect(currVIdx).toBeGreaterThan(prevVIdx);
      }
    }
  });

  test('partition: empty + non_empty = 16 cells', () => {
    const store = new InMemoryOnboardingStore();
    store.markStep('B1', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    const tenants = [tenant({ tenant_id: 'B1', vertical: 'banking' })];
    const m = buildOnboardingStepVerticalMatrix(tenants, (id) => store.get(id), NOW);
    const total_cells = ONBOARDING_STEPS.length * ALL_TENANT_VERTICALS.length;
    let non_empty = 0;
    for (const row of m.rows) {
      for (const v of ALL_TENANT_VERTICALS) {
        if (row.by_vertical[v] > 0) non_empty++;
      }
    }
    expect(m.empty_cells.length + non_empty).toBe(total_cells);
  });
});

describe('M2.14 — fastest_vertical + slowest_vertical', () => {
  test('fastest has highest mean completion_rate; slowest has lowest', () => {
    const store = new InMemoryOnboardingStore();
    // Banking: 1 tenant completes all 8 steps (rate = 1.0)
    for (const step of ONBOARDING_STEPS) {
      store.markStep('B1', step.id, 'completed', 'admin', null, NOW);
    }
    // Insurance: 1 tenant completes nothing (rate = 0)
    const tenants: Tenant[] = [
      tenant({ tenant_id: 'B1', vertical: 'banking' }),
      tenant({ tenant_id: 'I1', vertical: 'insurance' }),
    ];
    const m = buildOnboardingStepVerticalMatrix(tenants, (id) => store.get(id), NOW);
    expect(m.fastest_vertical!.vertical).toBe('banking');
    expect(m.fastest_vertical!.mean_completion_rate).toBe(1);
    expect(m.slowest_vertical!.vertical).toBe('insurance');
    expect(m.slowest_vertical!.mean_completion_rate).toBe(0);
  });

  test('null on empty fleet', () => {
    const store = new InMemoryOnboardingStore();
    const m = buildOnboardingStepVerticalMatrix([], (id) => store.get(id), NOW);
    expect(m.fastest_vertical).toBeNull();
    expect(m.slowest_vertical).toBeNull();
  });
});

// ─── GET /v1/tenants/onboarding/step-vertical-matrix ─────────────────

describe('M2.14 — GET /v1/tenants/onboarding/step-vertical-matrix', () => {
  test('admin → 200 with default 2-tenant registry', async () => {
    const { app } = makeSvApp('admin');
    const r = await request(app).get('/v1/tenants/onboarding/step-vertical-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_tenants).toBeGreaterThanOrEqual(2);
    expect(r.body.body.rows.length).toBe(ONBOARDING_STEPS.length);
    expect(r.body.body.columns.length).toBe(2);
  });

  test('populated matrix after markStep', async () => {
    const { app, store } = makeSvApp('admin');
    store.markStep('BIL', 'tenant_provisioned', 'completed', 'admin', null, NOW);
    const r = await request(app).get('/v1/tenants/onboarding/step-vertical-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    // BIL is `insurance` per defaultTenantLookup seed — counts in insurance.
    const row = r.body.body.rows.find((rr: { step_id: string }) => rr.step_id === 'tenant_provisioned');
    expect(row.by_vertical.insurance).toBe(1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeSvApp('case_owner');
    const r = await request(app).get('/v1/tenants/onboarding/step-vertical-matrix').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('literal `/step-vertical-matrix` not captured by :tenant_id wildcard', async () => {
    const { app } = makeSvApp('admin');
    const r = await request(app).get('/v1/tenants/onboarding/step-vertical-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M2.13 /v1/tenants/onboarding/step-completion still 200 (sibling regression)', async () => {
    const { app } = makeSvApp('admin');
    const r = await request(app).get('/v1/tenants/onboarding/step-completion').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M2.12 /v1/tenants/onboarding/fleet still 200 (sibling regression)', async () => {
    const { app } = makeSvApp('admin');
    const r = await request(app).get('/v1/tenants/onboarding/fleet').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
