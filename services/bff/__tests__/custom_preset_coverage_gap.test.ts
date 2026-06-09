// @ts-nocheck
// __tests__/custom_preset_coverage_gap.test.ts
// T6 M6.21 — Custom scoring preset coverage gap analysis

import request from 'supertest';
import {
  analyzeCustomPresetCoverageGaps,
} from '../src/custom_preset_coverage_gap';
import { InMemoryCustomWeightPresetStore } from '../src/scoring_presets_custom';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-08T00:00:00Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeCoverageApp(role = 'admin') {
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

// ─── Pure function tests ───────────────────────────────────────────────

describe('analyzeCustomPresetCoverageGaps — M6.21', () => {
  it('empty custom presets → all 6 combinations are gaps', () => {
    const result = analyzeCustomPresetCoverageGaps('BIL', [], NOW);
    expect(result.total_combinations).toBe(6);
    expect(result.gaps_count).toBe(6);
    expect(result.covered_count).toBe(0);
    expect(result.coverage_rate).toBe(0);
    expect(result.most_customized_mode).toBeNull();
    expect(result.gaps).toHaveLength(6);
    expect(result.covered).toHaveLength(0);
  });

  it('all 6 cells present with correct structure', () => {
    const result = analyzeCustomPresetCoverageGaps('BIL', [], NOW);
    const modes = result.gaps.map((g) => g.mode);
    const verticals = result.gaps.map((g) => g.vertical);
    expect(modes).toContain('conservative');
    expect(modes).toContain('balanced');
    expect(modes).toContain('aggressive');
    expect(verticals).toContain('banking');
    expect(verticals).toContain('insurance');
  });

  it('each cell has has_library_preset=true', () => {
    const result = analyzeCustomPresetCoverageGaps('BIL', [], NOW);
    for (const cell of result.gaps) {
      expect(cell.has_library_preset).toBe(true);
    }
  });

  it('adding one custom preset marks that cell as covered', () => {
    const preset = {
      id: 'wp_custom_abc',
      name: 'My conservative banking',
      description: 'test',
      vertical: 'banking',
      mode: 'conservative',
      weight_multipliers: {},
    };
    const result = analyzeCustomPresetCoverageGaps('BIL', [preset], NOW);
    expect(result.covered_count).toBe(1);
    expect(result.gaps_count).toBe(5);
    expect(result.coverage_rate).toBeCloseTo(1 / 6, 5);
    expect(result.most_customized_mode).toBe('conservative');
    const covered = result.covered.find(
      (c) => c.mode === 'conservative' && c.vertical === 'banking',
    );
    expect(covered).toBeDefined();
    expect(covered.has_custom_preset).toBe(true);
    expect(covered.custom_preset_ids).toContain('wp_custom_abc');
  });

  it('multiple customs in same mode+vertical aggregated correctly', () => {
    const presets = [
      { id: 'p1', name: 'A', description: 'x', vertical: 'banking', mode: 'conservative', weight_multipliers: {} },
      { id: 'p2', name: 'B', description: 'x', vertical: 'banking', mode: 'conservative', weight_multipliers: {} },
    ];
    const result = analyzeCustomPresetCoverageGaps('BIL', presets, NOW);
    const covered = result.covered.find(
      (c) => c.mode === 'conservative' && c.vertical === 'banking',
    );
    expect(covered).toBeDefined();
    expect(covered.custom_preset_ids).toHaveLength(2);
  });

  it('all 6 covered → coverage_rate=1, no gaps', () => {
    const combos = [
      ['conservative', 'banking'],
      ['conservative', 'insurance'],
      ['balanced', 'banking'],
      ['balanced', 'insurance'],
      ['aggressive', 'banking'],
      ['aggressive', 'insurance'],
    ];
    const presets = combos.map(([mode, vertical], i) => ({
      id: `p${i}`,
      name: `p${i}`,
      description: 'x',
      vertical,
      mode,
      weight_multipliers: {},
    }));
    const result = analyzeCustomPresetCoverageGaps('BIL', presets, NOW);
    expect(result.coverage_rate).toBe(1);
    expect(result.gaps_count).toBe(0);
    expect(result.gaps).toHaveLength(0);
  });

  it('most_customized_mode picks mode with most presets', () => {
    const presets = [
      { id: 'p1', name: 'A', description: 'x', vertical: 'banking', mode: 'aggressive', weight_multipliers: {} },
      { id: 'p2', name: 'B', description: 'x', vertical: 'insurance', mode: 'aggressive', weight_multipliers: {} },
      { id: 'p3', name: 'C', description: 'x', vertical: 'banking', mode: 'conservative', weight_multipliers: {} },
    ];
    const result = analyzeCustomPresetCoverageGaps('BIL', presets, NOW);
    expect(result.most_customized_mode).toBe('aggressive');
  });

  it('tenant_id and generated_at echoed', () => {
    const result = analyzeCustomPresetCoverageGaps('BANK_DEMO', [], NOW);
    expect(result.tenant_id).toBe('BANK_DEMO');
    expect(result.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ───────────────────────────────────────────────────────

describe('GET /v1/scoring/presets/custom/coverage-gaps — M6.21 route', () => {
  it('admin → 200 with gaps shape (empty store → all 6 gaps)', async () => {
    const { app } = makeCoverageApp('admin');
    const res = await request(app)
      .get('/v1/scoring/presets/custom/coverage-gaps')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.total_combinations).toBe(6);
    expect(res.body.body.gaps_count).toBe(6);
    expect(res.body.body.coverage_rate).toBe(0);
  });

  it('after creating a custom preset → covered_count=1', async () => {
    const { app, store } = makeCoverageApp('admin');
    store.create('BIL', {
      name: 'My preset',
      description: 'test desc',
      vertical: 'banking',
      mode: 'conservative',
      weight_multipliers: { 'FIN-001': 1.2 },
    }, 'alice.admin', NOW);
    const res = await request(app)
      .get('/v1/scoring/presets/custom/coverage-gaps')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.covered_count).toBe(1);
    expect(res.body.body.most_customized_mode).toBe('conservative');
  });

  it('risk_analyst → 200 (customers:read_risk_profile)', async () => {
    const { app } = makeCoverageApp('risk_analyst');
    const res = await request(app)
      .get('/v1/scoring/presets/custom/coverage-gaps')
      .set(TH_BIL)
      .set('x-apex-role', 'risk_analyst');
    expect(res.status).toBe(200);
  });

  it('unknown role → 403', async () => {
    const { app } = makeCoverageApp('unknown_role');
    const res = await request(app)
      .get('/v1/scoring/presets/custom/coverage-gaps')
      .set(TH_BIL)
      .set('x-apex-role', 'unknown_role');
    expect(res.status).toBe(403);
  });

  it('no tenant header → 400', async () => {
    const { app } = makeCoverageApp('admin');
    const res = await request(app)
      .get('/v1/scoring/presets/custom/coverage-gaps')
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });
});
