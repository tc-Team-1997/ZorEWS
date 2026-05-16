// services/bff/__tests__/scoring_preset_inventory.test.ts
//
// T6 M6.15 — Preset inventory cross-tab (library + custom by mode × vertical).

import request from 'supertest';
import {
  summarizePresetInventory,
  ALL_PRESET_VERTICALS,
} from '../src/scoring_preset_inventory';
import {
  InMemoryCustomWeightPresetStore,
} from '../src/scoring_presets_custom';
import {
  VALID_PRESET_MODES,
  WEIGHT_PRESETS,
} from '../src/scoring_presets';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-16T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeInvApp(role: string = 'admin') {
  const store = new InMemoryCustomWeightPresetStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    customWeightPresetStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

const validInput = (overrides: Partial<{ vertical: string; mode: string; name: string }> = {}) => ({
  name: 'test preset',
  description: 'test',
  vertical: 'banking',
  mode: 'conservative',
  weight_multipliers: { 'FIN-001': 1.4 },
  ...overrides,
});

// ─── summarizePresetInventory — pure ─────────────────────────────────

describe('M6.15 — empty custom store (library-only)', () => {
  test('zero custom presets → 6 cells with library_count=1 each + 0 custom', () => {
    const store = new InMemoryCustomWeightPresetStore();
    const s = summarizePresetInventory('BIL', store, NOW);
    expect(s.total_library_presets).toBe(WEIGHT_PRESETS.length);
    expect(s.total_library_presets).toBe(6);
    expect(s.total_custom_presets).toBe(0);
    expect(s.cells.length).toBe(6);
    for (const cell of s.cells) {
      expect(cell.library_count).toBe(1);
      expect(cell.custom_count).toBe(0);
      expect(cell.total_count).toBe(1);
      expect(cell.library_preset_ids.length).toBe(1);
      expect(cell.custom_preset_ids).toEqual([]);
    }
    expect(s.most_customised_mode).toBeNull();
    expect(s.uncovered_cells).toEqual([]);
  });
});

describe('M6.15 — canonical row × col order', () => {
  test('cells[] in canonical row-major order (mode major, vertical minor)', () => {
    const store = new InMemoryCustomWeightPresetStore();
    const s = summarizePresetInventory('BIL', store, NOW);
    const expected: Array<{ mode: string; vertical: string }> = [];
    for (const mode of VALID_PRESET_MODES) {
      for (const vertical of ALL_PRESET_VERTICALS) {
        expected.push({ mode, vertical });
      }
    }
    expect(s.cells.map((c) => ({ mode: c.mode, vertical: c.vertical }))).toEqual(expected);
  });
});

describe('M6.15 — library_count matches WEIGHT_PRESETS', () => {
  test('each of the 6 library presets contributes to exactly one cell', () => {
    const store = new InMemoryCustomWeightPresetStore();
    const s = summarizePresetInventory('BIL', store, NOW);
    const totalLibrary = s.cells.reduce((acc, c) => acc + c.library_count, 0);
    expect(totalLibrary).toBe(WEIGHT_PRESETS.length);
    expect(totalLibrary).toBe(6);
  });
});

describe('M6.15 — custom preset adds to correct cell', () => {
  test('single custom (banking, conservative) → that cell gets custom_count=1', () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create('BIL', validInput(), 'admin', NOW);
    const s = summarizePresetInventory('BIL', store, NOW);
    const cell = s.cells.find((c) => c.mode === 'conservative' && c.vertical === 'banking')!;
    expect(cell.custom_count).toBe(1);
    expect(cell.library_count).toBe(1);
    expect(cell.total_count).toBe(2);
    expect(cell.custom_preset_ids.length).toBe(1);
  });
});

describe('M6.15 — multi-mode + multi-vertical custom accumulation', () => {
  test('customs in different cells accumulate independently', () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create('BIL', validInput({ vertical: 'banking', mode: 'conservative', name: 'a' }), 'admin', NOW);
    store.create('BIL', validInput({ vertical: 'banking', mode: 'aggressive', name: 'b' }), 'admin', NOW);
    store.create('BIL', validInput({ vertical: 'insurance', mode: 'balanced', name: 'c' }), 'admin', NOW);
    const s = summarizePresetInventory('BIL', store, NOW);
    expect(s.total_custom_presets).toBe(3);
    expect(s.cells.find((c) => c.mode === 'conservative' && c.vertical === 'banking')!.custom_count).toBe(1);
    expect(s.cells.find((c) => c.mode === 'aggressive' && c.vertical === 'banking')!.custom_count).toBe(1);
    expect(s.cells.find((c) => c.mode === 'balanced' && c.vertical === 'insurance')!.custom_count).toBe(1);
    expect(s.cells.find((c) => c.mode === 'balanced' && c.vertical === 'banking')!.custom_count).toBe(0);
  });
});

describe('M6.15 — partition invariants', () => {
  test('Σ cells.total_count = total_library + total_custom', () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create('BIL', validInput(), 'admin', NOW);
    store.create('BIL', validInput({ name: 'b' }), 'admin', NOW);
    const s = summarizePresetInventory('BIL', store, NOW);
    const sum = s.cells.reduce((acc, c) => acc + c.total_count, 0);
    expect(sum).toBe(s.total_library_presets + s.total_custom_presets);
  });

  test('Σ by_mode = total_library + total_custom', () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create('BIL', validInput(), 'admin', NOW);
    const s = summarizePresetInventory('BIL', store, NOW);
    const modeSum = Object.values(s.by_mode).reduce((a, b) => a + b, 0);
    expect(modeSum).toBe(s.total_library_presets + s.total_custom_presets);
  });

  test('Σ by_vertical = total_library + total_custom', () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create('BIL', validInput(), 'admin', NOW);
    const s = summarizePresetInventory('BIL', store, NOW);
    const vertSum = Object.values(s.by_vertical).reduce((a, b) => a + b, 0);
    expect(vertSum).toBe(s.total_library_presets + s.total_custom_presets);
  });
});

describe('M6.15 — most_customised_mode', () => {
  test('points at mode with highest custom_count', () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create('BIL', validInput({ mode: 'aggressive', name: 'a1' }), 'admin', NOW);
    store.create('BIL', validInput({ mode: 'aggressive', name: 'a2' }), 'admin', NOW);
    store.create('BIL', validInput({ mode: 'conservative', name: 'b' }), 'admin', NOW);
    const s = summarizePresetInventory('BIL', store, NOW);
    expect(s.most_customised_mode).toEqual({ mode: 'aggressive', custom_count: 2 });
  });

  test('canonical tie-break: conservative wins at same count', () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create('BIL', validInput({ mode: 'aggressive', name: 'a' }), 'admin', NOW);
    store.create('BIL', validInput({ mode: 'conservative', name: 'c' }), 'admin', NOW);
    const s = summarizePresetInventory('BIL', store, NOW);
    expect(s.most_customised_mode!.mode).toBe('conservative');
  });

  test('null when no custom presets', () => {
    const store = new InMemoryCustomWeightPresetStore();
    const s = summarizePresetInventory('BIL', store, NOW);
    expect(s.most_customised_mode).toBeNull();
  });
});

describe('M6.15 — uncovered_cells', () => {
  test('= empty for default library (every cell has 1 library preset)', () => {
    const store = new InMemoryCustomWeightPresetStore();
    const s = summarizePresetInventory('BIL', store, NOW);
    expect(s.uncovered_cells).toEqual([]);
  });
});

describe('M6.15 — sorted preset_ids per cell', () => {
  test('library_preset_ids + custom_preset_ids both sorted asc', () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create('BIL', validInput({ name: 'z' }), 'admin', NOW);
    store.create('BIL', validInput({ name: 'a' }), 'admin', NOW);
    const s = summarizePresetInventory('BIL', store, NOW);
    for (const cell of s.cells) {
      const lib = [...cell.library_preset_ids];
      const sorted = [...lib].sort();
      expect(lib).toEqual(sorted);
      const cust = [...cell.custom_preset_ids];
      const csorted = [...cust].sort();
      expect(cust).toEqual(csorted);
    }
  });
});

describe('M6.15 — tenant scoping', () => {
  test('custom presets from other tenants invisible', () => {
    const store = new InMemoryCustomWeightPresetStore();
    store.create('BIL', validInput({ name: 'bil-only' }), 'admin', NOW);
    store.create('BANK_DEMO', validInput({ name: 'bank-only' }), 'admin', NOW);
    const bil = summarizePresetInventory('BIL', store, NOW);
    const bank = summarizePresetInventory('BANK_DEMO', store, NOW);
    expect(bil.total_custom_presets).toBe(1);
    expect(bank.total_custom_presets).toBe(1);
  });
});

// ─── GET /v1/scoring/presets/inventory ───────────────────────────────

describe('M6.15 — GET /v1/scoring/presets/inventory', () => {
  test('admin → 200 with library-only inventory', async () => {
    const { app } = makeInvApp('admin');
    const r = await request(app).get('/v1/scoring/presets/inventory').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_library_presets).toBe(6);
    expect(r.body.body.total_custom_presets).toBe(0);
    expect(r.body.body.cells.length).toBe(6);
  });

  test('populated rollup reflects created customs', async () => {
    const { app, store } = makeInvApp('admin');
    store.create('BIL', validInput({ mode: 'aggressive' }), 'admin', NOW);
    const r = await request(app).get('/v1/scoring/presets/inventory').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_custom_presets).toBe(1);
    expect(r.body.body.most_customised_mode.mode).toBe('aggressive');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeInvApp('case_owner');
    const r = await request(app).get('/v1/scoring/presets/inventory').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL customs invisible to BANK_DEMO', async () => {
    const { app, store } = makeInvApp('admin');
    store.create('BIL', validInput(), 'admin', NOW);
    const bank = await request(app)
      .get('/v1/scoring/presets/inventory')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_custom_presets).toBe(0);
    expect(bank.body.body.total_library_presets).toBe(6); // library is platform-wide
  });

  test('literal /inventory not captured by :preset_id wildcard', async () => {
    const { app } = makeInvApp('admin');
    const r = await request(app).get('/v1/scoring/presets/inventory').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.cells.length).toBe(6);
  });

  test('M6.3 /v1/scoring/presets (list) still works (sibling regression)', async () => {
    const { app } = makeInvApp('admin');
    const r = await request(app).get('/v1/scoring/presets').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
