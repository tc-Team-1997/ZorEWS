// services/bff/__tests__/scenario_bulk.test.ts
//
// T6 M16.2 — Scenario bulk-run + comparison.

import request from 'supertest';
import {
  BulkRunError,
  resolveBulkInput,
  runBulkScenarios,
  type BulkRunResult,
  type BulkRunResultRow,
} from '../src/scenario_bulk';
import { defaultPortfolio } from '../src/scenario/portfolio';
import { listScenarioPresets } from '../src/scenario_library';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeBulkApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── resolveBulkInput ──────────────────────────────────────────────────

describe('resolveBulkInput', () => {
  test('preset_ids mode resolves the listed presets in order', () => {
    const out = resolveBulkInput({
      preset_ids: ['preset_baseline_no_shock', 'preset_rate_hike_200bps'],
    });
    expect(out.selection.mode).toBe('by_ids');
    expect(out.presets.length).toBe(2);
    expect(out.presets[0]!.id).toBe('preset_baseline_no_shock');
    expect(out.presets[1]!.id).toBe('preset_rate_hike_200bps');
  });

  test('category mode resolves all presets in the category', () => {
    const out = resolveBulkInput({ category: 'regulatory' });
    expect(out.selection.mode).toBe('by_category');
    if (out.selection.mode === 'by_category') {
      expect(out.selection.category).toBe('regulatory');
    }
    expect(out.presets.length).toBeGreaterThan(0);
    for (const p of out.presets) {
      expect(p.category).toBe('regulatory');
    }
  });

  test('both preset_ids AND category supplied → invalid_input', () => {
    expect(() =>
      resolveBulkInput({ preset_ids: ['preset_baseline_no_shock'], category: 'regulatory' }),
    ).toThrow(/only one/);
  });

  test('neither supplied → invalid_input', () => {
    expect(() => resolveBulkInput({})).toThrow(/required/);
  });

  test('preset_ids[] with empty array → invalid_input (treated as not-supplied)', () => {
    expect(() => resolveBulkInput({ preset_ids: [] })).toThrow(/required/);
  });

  test('> 20 preset_ids → invalid_input', () => {
    const ids = new Array(21).fill('preset_baseline_no_shock');
    expect(() => resolveBulkInput({ preset_ids: ids })).toThrow(/at most 20/);
  });

  test('unknown preset_id → unknown_preset', () => {
    try {
      resolveBulkInput({ preset_ids: ['preset_baseline_no_shock', 'NO-SUCH'] });
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BulkRunError);
      expect((e as BulkRunError).code).toBe('unknown_preset');
    }
  });

  test('non-string preset_id → invalid_input', () => {
    expect(() =>
      resolveBulkInput({ preset_ids: [42 as unknown as string] }),
    ).toThrow(/non-empty string/);
  });

  test('invalid category → invalid_category', () => {
    try {
      resolveBulkInput({ category: 'crypto' as never });
      fail('expected throw');
    } catch (e) {
      expect((e as BulkRunError).code).toBe('invalid_category');
    }
  });

  test('non-object input → invalid_input', () => {
    expect(() => resolveBulkInput(undefined as unknown as never)).toThrow(/body required/);
    expect(() => resolveBulkInput(null as unknown as never)).toThrow(/body required/);
  });
});

// ─── runBulkScenarios ──────────────────────────────────────────────────

describe('runBulkScenarios', () => {
  const portfolio = defaultPortfolio();

  test('shape: tenant_id, generated_at, selection, preset_count, totals, results', () => {
    const presets = listScenarioPresets({ category: 'regulatory' });
    const out = runBulkScenarios(
      'BIL',
      presets,
      { mode: 'by_category', category: 'regulatory' },
      portfolio,
      () => NOW,
    );
    expect(out.tenant_id).toBe('BIL');
    expect(out.generated_at).toBe(NOW.toISOString());
    expect(out.preset_count).toBe(presets.length);
    expect(out.results.length).toBe(presets.length);
    expect(out.totals).toBeDefined();
    expect(typeof out.totals.worst_ecl_delta_kes).toBe('number');
  });

  test('every result row carries baseline + stressed + delta + rank + scenario metadata', () => {
    const presets = listScenarioPresets({ category: 'regulatory' });
    const out = runBulkScenarios(
      'BIL',
      presets,
      { mode: 'by_category', category: 'regulatory' },
      portfolio,
      () => NOW,
    );
    for (const r of out.results) {
      expect(typeof r.preset_id).toBe('string');
      expect(typeof r.name).toBe('string');
      expect(['regulatory', 'business', 'black_swan', 'baseline']).toContain(r.category);
      expect(['mild', 'moderate', 'severe']).toContain(r.severity);
      expect(typeof r.shocks.gdp).toBe('number');
      expect(typeof r.baseline_ecl_kes).toBe('number');
      expect(typeof r.stressed_ecl_kes).toBe('number');
      // delta = stressed - baseline (rounded). Allow a tiny rounding
      // tolerance because each side is rounded independently.
      const computed = r.stressed_ecl_kes - r.baseline_ecl_kes;
      expect(Math.abs(r.ecl_delta_kes - computed)).toBeLessThanOrEqual(1);
      expect(r.rank).toBeGreaterThanOrEqual(1);
      expect(r.rank).toBeLessThanOrEqual(out.results.length);
    }
  });

  test('results sorted by |ECL delta| descending (rank 1 = worst)', () => {
    const presets = listScenarioPresets();
    const out = runBulkScenarios(
      'BIL',
      presets,
      { mode: 'by_ids', preset_ids: presets.map((p) => p.id) },
      portfolio,
      () => NOW,
    );
    for (let i = 1; i < out.results.length; i++) {
      expect(Math.abs(out.results[i - 1]!.ecl_delta_kes)).toBeGreaterThanOrEqual(
        Math.abs(out.results[i]!.ecl_delta_kes),
      );
    }
    // rank should match position
    out.results.forEach((r, i) => {
      expect(r.rank).toBe(i + 1);
    });
  });

  test('worst_ecl_delta_kes equals first row\'s ecl_delta_kes', () => {
    const presets = listScenarioPresets({ category: 'black_swan' });
    const out = runBulkScenarios(
      'BIL',
      presets,
      { mode: 'by_category', category: 'black_swan' },
      portfolio,
      () => NOW,
    );
    expect(out.totals.worst_ecl_delta_kes).toBe(out.results[0]!.ecl_delta_kes);
  });

  test('adverse_count + benign_count sum to preset_count', () => {
    const presets = listScenarioPresets();
    const out = runBulkScenarios(
      'BIL',
      presets,
      { mode: 'by_ids', preset_ids: presets.map((p) => p.id) },
      portfolio,
      () => NOW,
    );
    expect(out.totals.adverse_count + out.totals.benign_count).toBe(out.preset_count);
  });

  test('baseline preset (zero shock) → ecl_delta_kes near 0', () => {
    const presets = listScenarioPresets({ category: 'baseline' });
    const out = runBulkScenarios(
      'BIL',
      presets,
      { mode: 'by_category', category: 'baseline' },
      portfolio,
      () => NOW,
    );
    expect(out.results.length).toBe(1);
    expect(Math.abs(out.results[0]!.ecl_delta_kes)).toBeLessThanOrEqual(1);
  });

  test('severely-adverse RBI scenarios produce LARGER delta than baseline', () => {
    const presets = listScenarioPresets();
    const out = runBulkScenarios(
      'BIL',
      presets,
      { mode: 'by_ids', preset_ids: presets.map((p) => p.id) },
      portfolio,
      () => NOW,
    );
    const baseline = out.results.find((r) => r.preset_id === 'preset_baseline_no_shock')!;
    const severelyAdverse = out.results.find((r) => r.preset_id === 'preset_rbi_severely_adverse')!;
    expect(Math.abs(severelyAdverse.ecl_delta_kes)).toBeGreaterThan(
      Math.abs(baseline.ecl_delta_kes),
    );
  });

  test('mean_ecl_delta_kes is the integer mean across rows', () => {
    const presets = listScenarioPresets({ category: 'regulatory' });
    const out = runBulkScenarios(
      'BIL',
      presets,
      { mode: 'by_category', category: 'regulatory' },
      portfolio,
      () => NOW,
    );
    const expected = Math.round(
      out.results.reduce((s, r) => s + r.ecl_delta_kes, 0) / out.results.length,
    );
    expect(out.totals.mean_ecl_delta_kes).toBe(expected);
  });

  test('deterministic — same (presets, portfolio, now) → identical result', () => {
    const presets = listScenarioPresets({ category: 'regulatory' });
    const a = runBulkScenarios(
      'BIL',
      presets,
      { mode: 'by_category', category: 'regulatory' },
      portfolio,
      () => NOW,
    );
    const b = runBulkScenarios(
      'BIL',
      presets,
      { mode: 'by_category', category: 'regulatory' },
      portfolio,
      () => NOW,
    );
    expect(a).toEqual(b);
  });
});

// ─── Route ─────────────────────────────────────────────────────────────

describe('POST /v1/scenarios/bulk-run', () => {
  test('admin: 200 with comparison payload via category mode', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/bulk-run')
      .set(TH_BIL)
      .send({ category: 'regulatory' });
    expect(r.status).toBe(200);
    const body = r.body.body as BulkRunResult;
    expect(body.preset_count).toBeGreaterThan(0);
    expect(body.results.length).toBe(body.preset_count);
    if (body.selection.mode === 'by_category') {
      expect(body.selection.category).toBe('regulatory');
    }
  });

  test('admin: 200 via preset_ids mode (in-order, but sorted by |delta| in results)', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/bulk-run')
      .set(TH_BIL)
      .send({
        preset_ids: [
          'preset_baseline_no_shock',
          'preset_rbi_severely_adverse',
          'preset_pandemic_stress',
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.body.preset_count).toBe(3);
    // The black_swan + RBI severe scenarios should outrank the baseline
    const ranks = (r.body.body.results as BulkRunResultRow[]).reduce<Record<string, number>>(
      (acc, row) => {
        acc[row.preset_id] = row.rank;
        return acc;
      },
      {},
    );
    expect(ranks['preset_baseline_no_shock']).toBe(3); // worst rank (least delta)
  });

  test('accepts an enveloped request body', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/bulk-run')
      .set(TH_BIL)
      .send({
        header: { requestId: 'r-1' },
        body: { category: 'baseline' },
      });
    expect(r.status).toBe(200);
    expect(r.body.body.preset_count).toBe(1);
  });

  test('both preset_ids AND category → 400 EWS_400_invalid_input', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/bulk-run')
      .set(TH_BIL)
      .send({
        preset_ids: ['preset_baseline_no_shock'],
        category: 'regulatory',
      });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('neither preset_ids nor category → 400 EWS_400_invalid_input', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/bulk-run')
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('unknown preset_id → 404 EWS_404_unknown_preset', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/bulk-run')
      .set(TH_BIL)
      .send({ preset_ids: ['NO-SUCH'] });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_preset');
  });

  test('invalid category → 400 EWS_400_invalid_category', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/scenarios/bulk-run')
      .set(TH_BIL)
      .send({ category: 'crypto' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_category');
  });

  test('> 20 preset_ids → 400 EWS_400_invalid_input', async () => {
    const { app } = makeBulkApp('admin');
    const ids = new Array(21).fill('preset_baseline_no_shock');
    const r = await request(app)
      .post('/v1/scenarios/bulk-run')
      .set(TH_BIL)
      .send({ preset_ids: ids });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeBulkApp('case_owner');
    const r = await request(app)
      .post('/v1/scenarios/bulk-run')
      .set(TH_BIL)
      .send({ category: 'baseline' });
    expect(r.status).toBe(403);
  });

  test('risk_analyst (real role) accepted', async () => {
    const { app } = makeBulkApp('risk_analyst');
    const r = await request(app)
      .post('/v1/scenarios/bulk-run')
      .set(TH_BIL)
      .send({ category: 'baseline' });
    expect(r.status).toBe(200);
  });
});

// ─── Sanity: existing scenario routes still work ──────────────────────

describe('No-regression: M16.1 + T4.2 scenario surface unaffected', () => {
  test('/v1/scenarios/library still 200', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app).get('/v1/scenarios/library').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total).toBe(10);
  });

  test('/v1/scenario/run still 200', async () => {
    const { app } = makeBulkApp('admin');
    const r = await request(app)
      .post('/v1/scenario/run')
      .set(TH_BIL)
      .send({ gdp: -2, rate: 100, fx: 5 });
    expect(r.status).toBe(200);
    expect(r.body.body.ecl_delta_kes).toBeDefined();
  });
});
