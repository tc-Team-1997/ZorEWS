// services/bff/__tests__/scenario_diff.test.ts
//
// T6 M16.3 — Scenario diff.

import request from 'supertest';
import {
  ScenarioDiffError,
  diffScenarios,
  diffScenariosByIds,
} from '../src/scenario_diff';
import { getScenarioPreset } from '../src/scenario_library';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-05T13:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeDiffApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── diffScenarios (pure) ─────────────────────────────────────────────

describe('diffScenarios', () => {
  test('shape: 8 entries (3 enum + 3 numeric + 2 string)', () => {
    const a = getScenarioPreset('preset_rbi_baseline_stress')!;
    const b = getScenarioPreset('preset_rbi_adverse_stress')!;
    const r = diffScenarios(a, b, NOW);
    expect(r.entries.length).toBe(8);
    const kinds = r.entries.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'enum').length).toBe(3);
    expect(kinds.filter((k) => k === 'numeric').length).toBe(3);
    expect(kinds.filter((k) => k === 'string').length).toBe(2);
  });

  test('numeric deltas computed correctly (RBI Baseline → Adverse)', () => {
    const a = getScenarioPreset('preset_rbi_baseline_stress')!;
    const b = getScenarioPreset('preset_rbi_adverse_stress')!;
    const r = diffScenarios(a, b, NOW);
    // Baseline: gdp=-1, rate=50, fx=3
    // Adverse:  gdp=-2.5, rate=150, fx=7
    const gdp = r.entries.find((e) => e.field === 'shocks.gdp')!;
    const rate = r.entries.find((e) => e.field === 'shocks.rate')!;
    const fx = r.entries.find((e) => e.field === 'shocks.fx')!;
    expect(gdp.delta_abs).toBeCloseTo(-1.5);
    expect(rate.delta_abs).toBe(100);
    expect(fx.delta_abs).toBe(4);
  });

  test('numeric delta_pct = (right - left) / |left| when left ≠ 0', () => {
    const a = getScenarioPreset('preset_rbi_baseline_stress')!;
    const b = getScenarioPreset('preset_rbi_adverse_stress')!;
    const r = diffScenarios(a, b, NOW);
    // gdp -1 → -2.5: delta = -1.5 / 1 = -1.5
    const gdp = r.entries.find((e) => e.field === 'shocks.gdp')!;
    expect(gdp.delta_pct).toBeCloseTo(-1.5);
    // rate 50 → 150: delta = 100 / 50 = 2.0
    const rate = r.entries.find((e) => e.field === 'shocks.rate')!;
    expect(rate.delta_pct).toBeCloseTo(2);
  });

  test('numeric left=0 → delta_pct undefined (avoids divide-by-zero)', () => {
    // Baseline preset has all-zero shocks
    const a = getScenarioPreset('preset_baseline_no_shock')!;
    const b = getScenarioPreset('preset_rbi_baseline_stress')!;
    const r = diffScenarios(a, b, NOW);
    for (const e of r.entries) {
      if (e.kind === 'numeric') {
        expect(e.delta_abs).toBeDefined();
        expect(e.delta_pct).toBeUndefined();
      }
    }
  });

  test('changed flag accurate per field', () => {
    const a = getScenarioPreset('preset_rbi_baseline_stress')!;
    const b = getScenarioPreset('preset_rbi_adverse_stress')!;
    const r = diffScenarios(a, b, NOW);
    // category, regulator both 'regulatory' / 'RBI' — unchanged
    const cat = r.entries.find((e) => e.field === 'category')!;
    expect(cat.changed).toBe(false);
    const reg = r.entries.find((e) => e.field === 'regulator')!;
    expect(reg.changed).toBe(false);
    // severity differs (mild vs moderate)
    const sev = r.entries.find((e) => e.field === 'severity')!;
    expect(sev.changed).toBe(true);
  });

  test('same preset compared to itself: every entry changed=false', () => {
    const a = getScenarioPreset('preset_rbi_baseline_stress')!;
    const r = diffScenarios(a, a, NOW);
    expect(r.entries.every((e) => !e.changed)).toBe(true);
    expect(r.changed_entries).toEqual([]);
  });

  test('changed_entries: numeric block sorted by |delta_abs| desc', () => {
    const a = getScenarioPreset('preset_rbi_baseline_stress')!;
    const b = getScenarioPreset('preset_rbi_severely_adverse')!;
    const r = diffScenarios(a, b, NOW);
    // Numeric block leads
    const numeric = r.changed_entries.filter((e) => e.kind === 'numeric');
    expect(numeric.length).toBeGreaterThan(0);
    for (let i = 1; i < numeric.length; i++) {
      expect(Math.abs(numeric[i - 1]!.delta_abs!)).toBeGreaterThanOrEqual(
        Math.abs(numeric[i]!.delta_abs!),
      );
    }
    // rate: 50 → 300 (delta 250) is the biggest mover
    expect(numeric[0]!.field).toBe('shocks.rate');
  });

  test('changed_entries: numeric block precedes categorical block', () => {
    const a = getScenarioPreset('preset_rbi_baseline_stress')!;
    const b = getScenarioPreset('preset_rbi_severely_adverse')!;
    const r = diffScenarios(a, b, NOW);
    let sawCategorical = false;
    for (const e of r.changed_entries) {
      if (e.kind !== 'numeric') sawCategorical = true;
      else if (sawCategorical) {
        fail('numeric entry appeared after a categorical one');
      }
    }
  });

  test('shocks_delta is the flat right-minus-left of all 3 shocks', () => {
    const a = getScenarioPreset('preset_rbi_baseline_stress')!;
    const b = getScenarioPreset('preset_rbi_adverse_stress')!;
    const r = diffScenarios(a, b, NOW);
    expect(r.shocks_delta).toEqual({
      gdp: b.shocks.gdp - a.shocks.gdp,
      rate: b.shocks.rate - a.shocks.rate,
      fx: b.shocks.fx - a.shocks.fx,
    });
  });

  test('generated_at is the now timestamp', () => {
    const a = getScenarioPreset('preset_rbi_baseline_stress')!;
    const b = getScenarioPreset('preset_rbi_adverse_stress')!;
    const r = diffScenarios(a, b, NOW);
    expect(r.generated_at).toBe(NOW.toISOString());
  });

  test('left/right echoed in result', () => {
    const a = getScenarioPreset('preset_rbi_baseline_stress')!;
    const b = getScenarioPreset('preset_rbi_adverse_stress')!;
    const r = diffScenarios(a, b, NOW);
    expect(r.left.id).toBe(a.id);
    expect(r.right.id).toBe(b.id);
  });

  test('regulator-vs-IRDAI cross-org diff: regulator changes', () => {
    const rbi = getScenarioPreset('preset_rbi_baseline_stress')!;
    const irdai = getScenarioPreset('preset_irdai_solvency_stress')!;
    const r = diffScenarios(rbi, irdai, NOW);
    const reg = r.entries.find((e) => e.field === 'regulator')!;
    expect(reg.changed).toBe(true);
    expect(reg.left).toBe('RBI');
    expect(reg.right).toBe('IRDAI');
  });

  test('inverted diff (b vs a) flips numeric signs', () => {
    const a = getScenarioPreset('preset_rbi_baseline_stress')!;
    const b = getScenarioPreset('preset_rbi_adverse_stress')!;
    const fwd = diffScenarios(a, b, NOW);
    const inv = diffScenarios(b, a, NOW);
    for (const f of fwd.entries) {
      if (f.kind !== 'numeric') continue;
      const i = inv.entries.find((e) => e.field === f.field)!;
      expect(i.delta_abs).toBeCloseTo(-f.delta_abs!);
    }
  });
});

// ─── diffScenariosByIds ───────────────────────────────────────────────

describe('diffScenariosByIds', () => {
  test('happy: resolves both ids and runs diff', () => {
    const r = diffScenariosByIds(
      'preset_rbi_baseline_stress',
      'preset_rbi_adverse_stress',
      NOW,
    );
    expect(r.left.id).toBe('preset_rbi_baseline_stress');
    expect(r.right.id).toBe('preset_rbi_adverse_stress');
  });

  test('missing left_id → invalid_input', () => {
    expect(() => diffScenariosByIds(undefined, 'preset_rbi_adverse_stress', NOW)).toThrow(
      ScenarioDiffError,
    );
  });

  test('missing right_id → invalid_input', () => {
    try {
      diffScenariosByIds('preset_rbi_baseline_stress', '', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ScenarioDiffError).code).toBe('invalid_input');
    }
  });

  test('non-string ids rejected', () => {
    expect(() => diffScenariosByIds(42, 'preset_rbi_baseline_stress', NOW)).toThrow(/left_id/);
  });

  test('whitespace ids rejected', () => {
    expect(() => diffScenariosByIds('   ', 'preset_rbi_baseline_stress', NOW)).toThrow(
      /left_id/,
    );
  });

  test('left_id === right_id → same_preset', () => {
    try {
      diffScenariosByIds('preset_rbi_baseline_stress', 'preset_rbi_baseline_stress', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ScenarioDiffError).code).toBe('same_preset');
    }
  });

  test('unknown left_id → unknown_preset', () => {
    try {
      diffScenariosByIds('NO-SUCH', 'preset_rbi_baseline_stress', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ScenarioDiffError).code).toBe('unknown_preset');
    }
  });

  test('unknown right_id → unknown_preset', () => {
    try {
      diffScenariosByIds('preset_rbi_baseline_stress', 'NO-SUCH', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as ScenarioDiffError).code).toBe('unknown_preset');
    }
  });
});

// ─── Routes ───────────────────────────────────────────────────────────

describe('POST /v1/scenarios/diff', () => {
  test('analyst+: 200 with diff body', async () => {
    const { app } = makeDiffApp('risk_analyst');
    const r = await request(app)
      .post('/v1/scenarios/diff')
      .set(TH_BIL)
      .send({
        left_id: 'preset_rbi_baseline_stress',
        right_id: 'preset_rbi_adverse_stress',
      });
    expect(r.status).toBe(200);
    expect(r.body.body.left.id).toBe('preset_rbi_baseline_stress');
    expect(r.body.body.right.id).toBe('preset_rbi_adverse_stress');
    expect(r.body.body.entries.length).toBe(8);
  });

  test('accepts enveloped body', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/diff')
      .set(TH_BIL)
      .send({
        header: { requestId: 'r-1' },
        body: {
          left_id: 'preset_rbi_baseline_stress',
          right_id: 'preset_rbi_adverse_stress',
        },
      });
    expect(r.status).toBe(200);
  });

  test('changed_entries surfaced (rate is biggest mover)', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/diff')
      .set(TH_BIL)
      .send({
        left_id: 'preset_rbi_baseline_stress',
        right_id: 'preset_rbi_severely_adverse',
      });
    const numeric = r.body.body.changed_entries.filter(
      (e: { kind: string }) => e.kind === 'numeric',
    );
    expect(numeric[0].field).toBe('shocks.rate');
  });

  test('shocks_delta echoed in response', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/diff')
      .set(TH_BIL)
      .send({
        left_id: 'preset_rbi_baseline_stress',
        right_id: 'preset_rbi_adverse_stress',
      });
    expect(r.body.body.shocks_delta).toEqual({ gdp: -1.5, rate: 100, fx: 4 });
  });

  test('missing left_id → 400 EWS_400_invalid_input', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/diff')
      .set(TH_BIL)
      .send({ right_id: 'preset_rbi_baseline_stress' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('missing both ids → 400', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app).post('/v1/scenarios/diff').set(TH_BIL).send({});
    expect(r.status).toBe(400);
  });

  test('same_preset → 400 EWS_400_same_preset', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/diff')
      .set(TH_BIL)
      .send({
        left_id: 'preset_rbi_baseline_stress',
        right_id: 'preset_rbi_baseline_stress',
      });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_same_preset');
  });

  test('unknown left_id → 404 EWS_404_unknown_preset', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/diff')
      .set(TH_BIL)
      .send({ left_id: 'NO-SUCH', right_id: 'preset_rbi_baseline_stress' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preset');
  });

  test('unknown right_id → 404', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/diff')
      .set(TH_BIL)
      .send({ left_id: 'preset_rbi_baseline_stress', right_id: 'NO-SUCH' });
    expect(r.status).toBe(404);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeDiffApp('case_owner');
    const r = await request(app)
      .post('/v1/scenarios/diff')
      .set(TH_BIL)
      .send({
        left_id: 'preset_rbi_baseline_stress',
        right_id: 'preset_rbi_adverse_stress',
      });
    expect(r.status).toBe(403);
  });
});

// ─── No-regression ────────────────────────────────────────────────────

describe('No-regression: M16.1 + M16.2 routes still work', () => {
  test('GET /v1/scenarios/library still 200', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app).get('/v1/scenarios/library').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('GET /v1/scenarios/library/:id still 200 (didn\'t shadow with /diff)', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app).get('/v1/scenarios/library/preset_rbi_baseline_stress').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('POST /v1/scenarios/bulk-run still 200', async () => {
    const { app } = makeDiffApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/bulk-run')
      .set(TH_BIL)
      .send({ preset_ids: ['preset_baseline_no_shock'] });
    expect(r.status).toBe(200);
  });

  test('GET /v1/scenarios/:id (saved-scenario route) still 404 cleanly', async () => {
    const { app } = makeDiffApp('admin');
    // No saved scenario exists; should 404 (NOT shadowed by /diff route)
    const r = await request(app).get('/v1/scenarios/no-such-saved').set(TH_BIL);
    expect(r.status).toBe(404);
  });
});
