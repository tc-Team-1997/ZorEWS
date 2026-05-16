// services/bff/__tests__/scenario_inventory.test.ts
//
// T6 M16.19 — Scenario inventory cross-tab (library + custom by category × severity).

import request from 'supertest';
import {
  summarizeScenarioInventory,
  ALL_SCENARIO_CATEGORIES,
  ALL_SCENARIO_SEVERITIES,
} from '../src/scenario_inventory';
import { InMemoryCustomPresetStore } from '../src/scenario_custom';
import { SCENARIO_PRESETS } from '../src/scenario_library';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-16T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeInvApp(role: string = 'admin') {
  const store = new InMemoryCustomPresetStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    customPresetStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

const validInput = (overrides: Partial<{ category: string; severity: string; name: string; regulator: string }> = {}) => ({
  name: 'test scenario',
  description: 'test',
  category: 'business',
  regulator: 'INTERNAL',
  severity: 'moderate',
  shocks: { gdp: -1, rate: 50, fx: 3 },
  source_doc: 'test',
  ...overrides,
});

// ─── summarizeScenarioInventory — pure ───────────────────────────────

describe('M16.19 — empty custom store (library-only)', () => {
  test('library presets distributed across 12 cells, no customs', () => {
    const store = new InMemoryCustomPresetStore();
    const s = summarizeScenarioInventory('BIL', store, NOW);
    expect(s.total_library_presets).toBe(SCENARIO_PRESETS.length);
    expect(s.total_custom_presets).toBe(0);
    expect(s.cells.length).toBe(12);
    // Σ library_count across cells = total_library_presets
    const sumLib = s.cells.reduce((acc, c) => acc + c.library_count, 0);
    expect(sumLib).toBe(SCENARIO_PRESETS.length);
    expect(s.most_customised_category).toBeNull();
  });
});

describe('M16.19 — canonical row × col order', () => {
  test('cells[] in canonical row-major order (category major, severity minor)', () => {
    const store = new InMemoryCustomPresetStore();
    const s = summarizeScenarioInventory('BIL', store, NOW);
    const expected: Array<{ category: string; severity: string }> = [];
    for (const cat of ALL_SCENARIO_CATEGORIES) {
      for (const sev of ALL_SCENARIO_SEVERITIES) {
        expected.push({ category: cat, severity: sev });
      }
    }
    expect(s.cells.map((c) => ({ category: c.category, severity: c.severity }))).toEqual(expected);
  });
});

describe('M16.19 — library_count matches SCENARIO_PRESETS', () => {
  test('Σ library_count = SCENARIO_PRESETS.length', () => {
    const store = new InMemoryCustomPresetStore();
    const s = summarizeScenarioInventory('BIL', store, NOW);
    const sum = s.cells.reduce((acc, c) => acc + c.library_count, 0);
    expect(sum).toBe(SCENARIO_PRESETS.length);
  });
});

describe('M16.19 — custom preset adds to correct cell', () => {
  test('single business/moderate custom → that cell gets custom_count=1', () => {
    const store = new InMemoryCustomPresetStore();
    store.create('BIL', validInput(), 'admin', NOW);
    const s = summarizeScenarioInventory('BIL', store, NOW);
    const cell = s.cells.find((c) => c.category === 'business' && c.severity === 'moderate')!;
    expect(cell.custom_count).toBe(1);
    expect(cell.custom_preset_ids.length).toBe(1);
    expect(s.total_custom_presets).toBe(1);
  });
});

describe('M16.19 — partition invariants', () => {
  test('Σ cells.total_count = library + custom totals', () => {
    const store = new InMemoryCustomPresetStore();
    store.create('BIL', validInput(), 'admin', NOW);
    store.create('BIL', validInput({ name: 'b' }), 'admin', NOW);
    const s = summarizeScenarioInventory('BIL', store, NOW);
    const sum = s.cells.reduce((acc, c) => acc + c.total_count, 0);
    expect(sum).toBe(s.total_library_presets + s.total_custom_presets);
  });

  test('Σ by_category = library + custom totals', () => {
    const store = new InMemoryCustomPresetStore();
    store.create('BIL', validInput(), 'admin', NOW);
    const s = summarizeScenarioInventory('BIL', store, NOW);
    const catSum = Object.values(s.by_category).reduce((a, b) => a + b, 0);
    expect(catSum).toBe(s.total_library_presets + s.total_custom_presets);
  });

  test('Σ by_severity = library + custom totals', () => {
    const store = new InMemoryCustomPresetStore();
    store.create('BIL', validInput(), 'admin', NOW);
    const s = summarizeScenarioInventory('BIL', store, NOW);
    const sevSum = Object.values(s.by_severity).reduce((a, b) => a + b, 0);
    expect(sevSum).toBe(s.total_library_presets + s.total_custom_presets);
  });

  test('per-cell library + custom = total_count', () => {
    const store = new InMemoryCustomPresetStore();
    store.create('BIL', validInput(), 'admin', NOW);
    const s = summarizeScenarioInventory('BIL', store, NOW);
    for (const cell of s.cells) {
      expect(cell.library_count + cell.custom_count).toBe(cell.total_count);
    }
  });
});

describe('M16.19 — most_populated_cell', () => {
  test('points at highest total_count cell', () => {
    const store = new InMemoryCustomPresetStore();
    // Add 3 customs in business/moderate to ensure it wins.
    store.create('BIL', validInput({ name: 'a' }), 'admin', NOW);
    store.create('BIL', validInput({ name: 'b' }), 'admin', NOW);
    store.create('BIL', validInput({ name: 'c' }), 'admin', NOW);
    const s = summarizeScenarioInventory('BIL', store, NOW);
    const cell = s.cells.find((c) => c.category === 'business' && c.severity === 'moderate')!;
    expect(s.most_populated_cell).not.toBeNull();
    expect(s.most_populated_cell!.category).toBe('business');
    expect(s.most_populated_cell!.severity).toBe('moderate');
    expect(s.most_populated_cell!.total_count).toBe(cell.total_count);
  });
});

describe('M16.19 — most_customised_category', () => {
  test('points at category with highest custom_count', () => {
    const store = new InMemoryCustomPresetStore();
    store.create('BIL', validInput({ category: 'business', name: 'a' }), 'admin', NOW);
    store.create('BIL', validInput({ category: 'business', name: 'b' }), 'admin', NOW);
    store.create('BIL', validInput({ category: 'baseline', severity: 'mild', name: 'c' }), 'admin', NOW);
    const s = summarizeScenarioInventory('BIL', store, NOW);
    expect(s.most_customised_category).toEqual({ category: 'business', custom_count: 2 });
  });

  test('canonical tie-break: regulatory wins over business at same count', () => {
    const store = new InMemoryCustomPresetStore();
    store.create('BIL', validInput({ category: 'business', name: 'a' }), 'admin', NOW);
    store.create('BIL', validInput({ category: 'regulatory', regulator: 'RBI', name: 'b', severity: 'severe' }), 'admin', NOW);
    const s = summarizeScenarioInventory('BIL', store, NOW);
    expect(s.most_customised_category!.category).toBe('regulatory');
  });

  test('null when no custom presets', () => {
    const store = new InMemoryCustomPresetStore();
    const s = summarizeScenarioInventory('BIL', store, NOW);
    expect(s.most_customised_category).toBeNull();
  });
});

describe('M16.19 — uncovered_cells', () => {
  test('cells with library_count=0 surface in canonical order', () => {
    const store = new InMemoryCustomPresetStore();
    const s = summarizeScenarioInventory('BIL', store, NOW);
    // Whatever the library has, uncovered must match library_count=0 cells.
    const manualUncovered = s.cells.filter((c) => c.library_count === 0);
    expect(s.uncovered_cells.length).toBe(manualUncovered.length);
  });
});

describe('M16.19 — sorted preset_ids per cell', () => {
  test('library_preset_ids + custom_preset_ids sorted asc', () => {
    const store = new InMemoryCustomPresetStore();
    store.create('BIL', validInput({ name: 'zoom' }), 'admin', NOW);
    store.create('BIL', validInput({ name: 'alpha' }), 'admin', NOW);
    const s = summarizeScenarioInventory('BIL', store, NOW);
    for (const cell of s.cells) {
      const lib = [...cell.library_preset_ids];
      expect(lib).toEqual([...lib].sort());
      const cust = [...cell.custom_preset_ids];
      expect(cust).toEqual([...cust].sort());
    }
  });
});

describe('M16.19 — tenant scoping', () => {
  test('custom presets from other tenants invisible', () => {
    const store = new InMemoryCustomPresetStore();
    store.create('BIL', validInput({ name: 'bil-only' }), 'admin', NOW);
    store.create('BANK_DEMO', validInput({ name: 'bank-only' }), 'admin', NOW);
    const bil = summarizeScenarioInventory('BIL', store, NOW);
    const bank = summarizeScenarioInventory('BANK_DEMO', store, NOW);
    expect(bil.total_custom_presets).toBe(1);
    expect(bank.total_custom_presets).toBe(1);
    expect(bil.total_library_presets).toBe(SCENARIO_PRESETS.length);
    expect(bank.total_library_presets).toBe(SCENARIO_PRESETS.length);
  });
});

// ─── GET /v1/scenarios/library/inventory ─────────────────────────────

describe('M16.19 — GET /v1/scenarios/library/inventory', () => {
  test('admin → 200 with library-only inventory', async () => {
    const { app } = makeInvApp('admin');
    const r = await request(app).get('/v1/scenarios/library/inventory').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_library_presets).toBe(SCENARIO_PRESETS.length);
    expect(r.body.body.total_custom_presets).toBe(0);
    expect(r.body.body.cells.length).toBe(12);
  });

  test('populated rollup reflects created customs', async () => {
    const { app, store } = makeInvApp('admin');
    store.create('BIL', validInput(), 'admin', NOW);
    const r = await request(app).get('/v1/scenarios/library/inventory').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_custom_presets).toBe(1);
    expect(r.body.body.most_customised_category.category).toBe('business');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeInvApp('case_owner');
    const r = await request(app).get('/v1/scenarios/library/inventory').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL customs invisible to BANK_DEMO', async () => {
    const { app, store } = makeInvApp('admin');
    store.create('BIL', validInput(), 'admin', NOW);
    const bank = await request(app)
      .get('/v1/scenarios/library/inventory')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_custom_presets).toBe(0);
    expect(bank.body.body.total_library_presets).toBe(SCENARIO_PRESETS.length);
  });

  test('literal /inventory not captured by :preset_id wildcard', async () => {
    const { app } = makeInvApp('admin');
    const r = await request(app).get('/v1/scenarios/library/inventory').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.cells.length).toBe(12);
  });

  test('M16.17 /v1/scenarios/library/coverage-matrix still works (sibling regression)', async () => {
    const { app } = makeInvApp('admin');
    const r = await request(app).get('/v1/scenarios/library/coverage-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
