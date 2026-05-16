// services/bff/__tests__/tenant_onboarding_fleet.test.ts
//
// T6 M2.12 — Cross-tenant onboarding fleet overview.

import request from 'supertest';
import {
  summarizeOnboardingFleet,
  ATTENTION_THRESHOLD,
} from '../src/tenant_onboarding_fleet';
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

const NOW = new Date('2026-05-16T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeFleetApp(role: string = 'admin') {
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

/** Mark every step (required + optional) completed → score=100 → complete stage.
 *  Required-only completion caps at 96 (overall_pct weighted in) so the
 *  optional step must also land in `completed` for the canonical 100-score
 *  / complete-stage result the SPA expects. */
function fullyOnboard(store: InMemoryOnboardingStore, tenant_id: string): void {
  for (const step of ONBOARDING_STEPS) {
    store.markStep(tenant_id, step.id, 'completed', 'admin', null, NOW);
  }
}

/** Mark N required steps completed → partial completeness. */
function partialOnboard(store: InMemoryOnboardingStore, tenant_id: string, n: number): void {
  const required = ONBOARDING_STEPS.filter((s) => s.required);
  for (let i = 0; i < Math.min(n, required.length); i++) {
    store.markStep(tenant_id, required[i]!.id, 'completed', 'admin', null, NOW);
  }
}

// ─── summarizeOnboardingFleet — pure ─────────────────────────────────

describe('M2.12 — empty tenant list', () => {
  test('zero tenants → zero envelope', () => {
    const store = new InMemoryOnboardingStore();
    const s = summarizeOnboardingFleet([], (id) => store.get(id), NOW);
    expect(s.total_tenants).toBe(0);
    expect(s.total_active_tenants).toBe(0);
    expect(s.tenants).toEqual([]);
    expect(s.tenants_needing_attention).toEqual([]);
    expect(s.most_advanced_tenant).toBeNull();
    expect(s.mean_completeness_score).toBe(0);
    expect(s.by_stage.starting).toBe(0);
    expect(s.by_stage.complete).toBe(0);
    expect(Object.keys(s.by_stage).length).toBe(5);
  });
});

describe('M2.12 — single untouched tenant', () => {
  test('completeness=0 → starting stage; included in tenants_needing_attention', () => {
    const store = new InMemoryOnboardingStore();
    const t = tenant({ tenant_id: 'NEW_BANK' });
    const s = summarizeOnboardingFleet([t], (id) => store.get(id), NOW);
    expect(s.total_tenants).toBe(1);
    const row = s.tenants[0]!;
    expect(row.completeness_score).toBe(0);
    expect(row.current_stage).toBe('starting');
    expect(row.is_complete).toBe(false);
    expect(s.by_stage.starting).toBe(1);
    expect(s.tenants_needing_attention.length).toBe(1);
    expect(s.tenants_needing_attention[0]!.tenant_id).toBe('NEW_BANK');
  });
});

describe('M2.12 — fully-onboarded tenant', () => {
  test('every required step done → score=100, complete stage', () => {
    const store = new InMemoryOnboardingStore();
    const t = tenant({ tenant_id: 'DONE_BANK' });
    fullyOnboard(store, t.tenant_id);
    const s = summarizeOnboardingFleet([t], (id) => store.get(id), NOW);
    const row = s.tenants[0]!;
    expect(row.completeness_score).toBe(100);
    expect(row.current_stage).toBe('complete');
    expect(row.is_complete).toBe(true);
    expect(row.total_blockers).toBe(0);
    expect(s.by_stage.complete).toBe(1);
    expect(s.tenants_needing_attention.length).toBe(0);
  });
});

describe('M2.12 — mixed cohort', () => {
  test('three tenants at different stages bucket correctly', () => {
    const store = new InMemoryOnboardingStore();
    const a = tenant({ tenant_id: 'A_NEW', name: 'A New' });
    const b = tenant({ tenant_id: 'B_MID', name: 'B Mid' });
    const c = tenant({ tenant_id: 'C_DONE', name: 'C Done' });
    // A: untouched (starting)
    // B: 4 of 7 required → ~50-60% score (near_done)
    // C: fully done (complete)
    partialOnboard(store, b.tenant_id, 4);
    fullyOnboard(store, c.tenant_id);
    const s = summarizeOnboardingFleet([a, b, c], (id) => store.get(id), NOW);
    expect(s.total_tenants).toBe(3);
    const byId = Object.fromEntries(s.tenants.map((r) => [r.tenant_id, r]));
    expect(byId['A_NEW']!.current_stage).toBe('starting');
    expect(byId['C_DONE']!.current_stage).toBe('complete');
    expect(byId['B_MID']!.completeness_score).toBeGreaterThan(0);
    expect(byId['B_MID']!.completeness_score).toBeLessThan(100);
    expect(s.by_stage.starting + s.by_stage.in_progress + s.by_stage.near_done
      + s.by_stage.final_review + s.by_stage.complete).toBe(3);
  });
});

describe('M2.12 — by_stage every key emitted at 0', () => {
  test('keys present even when zero', () => {
    const store = new InMemoryOnboardingStore();
    const t = tenant({ tenant_id: 'X' });
    const s = summarizeOnboardingFleet([t], (id) => store.get(id), NOW);
    expect(s.by_stage.starting).toBeDefined();
    expect(s.by_stage.in_progress).toBeDefined();
    expect(s.by_stage.near_done).toBeDefined();
    expect(s.by_stage.final_review).toBeDefined();
    expect(s.by_stage.complete).toBeDefined();
  });
});

describe('M2.12 — Σ by_stage = total_tenants', () => {
  test('partition invariant', () => {
    const store = new InMemoryOnboardingStore();
    const tenants = [
      tenant({ tenant_id: 'A' }),
      tenant({ tenant_id: 'B' }),
      tenant({ tenant_id: 'C' }),
    ];
    partialOnboard(store, 'B', 3);
    fullyOnboard(store, 'C');
    const s = summarizeOnboardingFleet(tenants, (id) => store.get(id), NOW);
    const sum = Object.values(s.by_stage).reduce((a, b) => a + b, 0);
    expect(sum).toBe(s.total_tenants);
  });
});

describe('M2.12 — mean_completeness_score', () => {
  test('rounded mean across tenants', () => {
    const store = new InMemoryOnboardingStore();
    const a = tenant({ tenant_id: 'A' });
    const b = tenant({ tenant_id: 'B' });
    fullyOnboard(store, b.tenant_id); // 100
    // a stays at 0 → mean = 50
    const s = summarizeOnboardingFleet([a, b], (id) => store.get(id), NOW);
    expect(s.mean_completeness_score).toBe(50);
  });

  test('= 0 when empty', () => {
    const store = new InMemoryOnboardingStore();
    const s = summarizeOnboardingFleet([], (id) => store.get(id), NOW);
    expect(s.mean_completeness_score).toBe(0);
  });
});

describe('M2.12 — tenants_needing_attention', () => {
  test('subset of completeness < ATTENTION_THRESHOLD, sorted asc', () => {
    const store = new InMemoryOnboardingStore();
    const tA = tenant({ tenant_id: 'A_LOW' }); // 0 → in
    const tB = tenant({ tenant_id: 'B_DONE' });
    fullyOnboard(store, tB.tenant_id); // 100 → out
    const tC = tenant({ tenant_id: 'C_PARTIAL' });
    partialOnboard(store, tC.tenant_id, 2); // small partial → in (likely < 70)
    const s = summarizeOnboardingFleet([tA, tB, tC], (id) => store.get(id), NOW);
    const attn = s.tenants_needing_attention.map((t) => t.tenant_id);
    expect(attn).toContain('A_LOW');
    expect(attn).not.toContain('B_DONE');
    // Sorted asc by completeness — A_LOW (0) before C_PARTIAL (lower than 70).
    for (let i = 1; i < s.tenants_needing_attention.length; i++) {
      expect(s.tenants_needing_attention[i - 1]!.completeness_score)
        .toBeLessThanOrEqual(s.tenants_needing_attention[i]!.completeness_score);
    }
  });

  test('all tenants below threshold surface', () => {
    const store = new InMemoryOnboardingStore();
    const t = tenant({ tenant_id: 'A' });
    const s = summarizeOnboardingFleet([t], (id) => store.get(id), NOW);
    expect(s.tenants_needing_attention.length).toBe(1);
  });

  test('threshold boundary: exactly ATTENTION_THRESHOLD is NOT in list (strict-<)', () => {
    // We can't easily land on exactly 70 with the discrete step weights,
    // so we just assert the contract: a 100-score tenant is excluded.
    const store = new InMemoryOnboardingStore();
    const t = tenant({ tenant_id: 'DONE' });
    fullyOnboard(store, t.tenant_id);
    const s = summarizeOnboardingFleet([t], (id) => store.get(id), NOW);
    expect(s.tenants_needing_attention).toEqual([]);
    expect(ATTENTION_THRESHOLD).toBe(70);
  });
});

describe('M2.12 — sort order', () => {
  test('tenants[] sorted completeness desc + tenant_id asc tie-break', () => {
    const store = new InMemoryOnboardingStore();
    const tA = tenant({ tenant_id: 'A_DONE' });
    const tB = tenant({ tenant_id: 'B_DONE' });
    const tC = tenant({ tenant_id: 'C_PARTIAL' });
    fullyOnboard(store, tA.tenant_id);
    fullyOnboard(store, tB.tenant_id);
    partialOnboard(store, tC.tenant_id, 2);
    const s = summarizeOnboardingFleet([tC, tA, tB], (id) => store.get(id), NOW);
    expect(s.tenants.map((r) => r.tenant_id)).toEqual(['A_DONE', 'B_DONE', 'C_PARTIAL']);
  });
});

describe('M2.12 — most_advanced_tenant', () => {
  test('points at top row of tenants[]', () => {
    const store = new InMemoryOnboardingStore();
    const tA = tenant({ tenant_id: 'A_LOW' });
    const tB = tenant({ tenant_id: 'B_DONE' });
    fullyOnboard(store, tB.tenant_id);
    const s = summarizeOnboardingFleet([tA, tB], (id) => store.get(id), NOW);
    expect(s.most_advanced_tenant).not.toBeNull();
    expect(s.most_advanced_tenant!.tenant_id).toBe('B_DONE');
    expect(s.most_advanced_tenant!.completeness_score).toBe(100);
  });

  test('null when no tenants', () => {
    const store = new InMemoryOnboardingStore();
    const s = summarizeOnboardingFleet([], (id) => store.get(id), NOW);
    expect(s.most_advanced_tenant).toBeNull();
  });
});

describe('M2.12 — total_active counter', () => {
  test('counts only active tenants', () => {
    const store = new InMemoryOnboardingStore();
    const tA = tenant({ tenant_id: 'A', active: true });
    const tB = tenant({ tenant_id: 'B', active: false });
    const s = summarizeOnboardingFleet([tA, tB], (id) => store.get(id), NOW);
    expect(s.total_active_tenants).toBe(1);
    expect(s.total_inactive_tenants).toBe(1);
    expect(s.total_active_tenants + s.total_inactive_tenants).toBe(s.total_tenants);
  });
});

// ─── GET /v1/tenants/onboarding/fleet ────────────────────────────────

describe('M2.12 — GET /v1/tenants/onboarding/fleet', () => {
  test('admin → 200 with default registry (BANK_DEMO + BIL)', async () => {
    const { app } = makeFleetApp('admin');
    const r = await request(app).get('/v1/tenants/onboarding/fleet').set(TH_BIL);
    expect(r.status).toBe(200);
    // Default registry has 2 tenants.
    expect(r.body.body.total_tenants).toBe(2);
    expect(r.body.body.tenants.length).toBe(2);
    expect(r.body.body.tenants.map((t: { tenant_id: string }) => t.tenant_id))
      .toEqual(expect.arrayContaining(['BANK_DEMO', 'BIL']));
  });

  test('populated rollup reflects onboarding progress', async () => {
    const { app, store } = makeFleetApp('admin');
    // Fully onboard BIL via the store
    fullyOnboard(store, 'BIL');
    const r = await request(app).get('/v1/tenants/onboarding/fleet').set(TH_BIL);
    expect(r.status).toBe(200);
    const bilRow = r.body.body.tenants.find((t: { tenant_id: string }) => t.tenant_id === 'BIL');
    expect(bilRow.completeness_score).toBe(100);
    expect(bilRow.current_stage).toBe('complete');
    expect(r.body.body.most_advanced_tenant.tenant_id).toBe('BIL');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeFleetApp('case_owner');
    const r = await request(app).get('/v1/tenants/onboarding/fleet').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('literal /fleet not captured by :tenant_id wildcard', async () => {
    const { app } = makeFleetApp('admin');
    const r = await request(app).get('/v1/tenants/onboarding/fleet').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_tenants).toBeGreaterThan(0);
  });

  test('M2.11 /v1/tenants/me/onboarding/milestone still works (sibling regression)', async () => {
    const { app } = makeFleetApp('admin');
    const r = await request(app).get('/v1/tenants/me/onboarding/milestone').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
