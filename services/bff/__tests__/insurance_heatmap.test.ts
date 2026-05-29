// services/bff/__tests__/insurance_heatmap.test.ts

import {
  ALL_HEAT_METRICS,
  ALL_HEAT_DIMENSIONS,
  ALL_HEAT_LEVELS,
  HEAT_METRIC_CATALOG,
  INSURANCE_BRANCHES,
  INSURANCE_REGIONS,
  INSURANCE_CHANNELS,
  listHeatmapCatalog,
  buildInsuranceHeatmap,
  InsuranceHeatmapError,
} from '../src/insurance_heatmap';

const NOW = new Date('2026-05-29T12:00:00.000Z');

describe('catalog + enums', () => {
  it('5 metrics × 3 dimensions', () => {
    expect(ALL_HEAT_METRICS).toHaveLength(5);
    expect(ALL_HEAT_DIMENSIONS).toEqual(['branch', 'region', 'channel']);
    expect(ALL_HEAT_LEVELS).toEqual(['low', 'medium', 'high', 'critical']);
  });
  it('metric catalog covers every metric with a natural dimension + headline', () => {
    expect(HEAT_METRIC_CATALOG).toHaveLength(5);
    for (const m of ALL_HEAT_METRICS) {
      const def = HEAT_METRIC_CATALOG.find((d) => d.metric === m)!;
      expect(def).toBeDefined();
      expect(ALL_HEAT_DIMENSIONS).toContain(def.natural_dimension);
      expect(def.headline_label).toBeTruthy();
      expect(['count', 'pct', 'ratio']).toContain(def.headline_unit);
    }
  });
  it('solvency + persistency are lower-is-worse; others higher-is-worse', () => {
    const byM = Object.fromEntries(HEAT_METRIC_CATALOG.map((d) => [d.metric, d]));
    expect(byM.solvency_stress.higher_is_worse).toBe(false);
    expect(byM.persistency_weakness.higher_is_worse).toBe(false);
    expect(byM.fraud.higher_is_worse).toBe(true);
    expect(byM.lapse_risk.higher_is_worse).toBe(true);
    expect(byM.channel_risk.higher_is_worse).toBe(true);
  });
  it('listHeatmapCatalog returns metrics + dimensions', () => {
    const cat = listHeatmapCatalog();
    expect(cat.metrics).toHaveLength(5);
    expect(cat.dimensions).toEqual(['branch', 'region', 'channel']);
  });
});

describe('buildInsuranceHeatmap — shape across every metric × dimension', () => {
  it('every combo returns cells with a by_heat_level partition', () => {
    for (const metric of ALL_HEAT_METRICS) {
      for (const dimension of ALL_HEAT_DIMENSIONS) {
        const hm = buildInsuranceHeatmap('BANK_DEMO', metric, dimension, NOW);
        expect(hm.metric).toBe(metric);
        expect(hm.dimension).toBe(dimension);
        const expectedCells =
          dimension === 'branch' ? INSURANCE_BRANCHES.length : dimension === 'region' ? INSURANCE_REGIONS.length : INSURANCE_CHANNELS.length;
        expect(hm.cells).toHaveLength(expectedCells);
        const sum = ALL_HEAT_LEVELS.reduce((a, l) => a + hm.by_heat_level[l], 0);
        expect(sum).toBe(expectedCells);
      }
    }
  });

  it('cells sorted worst-first (heat rank then risk_score desc)', () => {
    const hm = buildInsuranceHeatmap('BANK_DEMO', 'fraud', 'branch', NOW);
    const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    for (let i = 1; i < hm.cells.length; i++) {
      expect(rank[hm.cells[i - 1].heat_level]).toBeLessThanOrEqual(rank[hm.cells[i].heat_level]);
    }
  });

  it('risk_score in [0,100] + heat_level derived from it; headline label set', () => {
    for (const metric of ALL_HEAT_METRICS) {
      const hm = buildInsuranceHeatmap('BANK_DEMO', metric, 'region', NOW);
      for (const c of hm.cells) {
        expect(c.risk_score).toBeGreaterThanOrEqual(0);
        expect(c.risk_score).toBeLessThanOrEqual(100);
        expect(c.heat_level).toBe(
          c.risk_score >= 75 ? 'critical' : c.risk_score >= 50 ? 'high' : c.risk_score >= 25 ? 'medium' : 'low',
        );
        expect(c.headline_label).toBeTruthy();
        expect(c.volume).toBeGreaterThan(0);
      }
    }
  });

  it('branch cells carry region group; region cells null group; channel cells a tier group', () => {
    const branch = buildInsuranceHeatmap('BANK_DEMO', 'fraud', 'branch', NOW);
    for (const c of branch.cells) expect(INSURANCE_REGIONS).toContain(c.group as never);
    const region = buildInsuranceHeatmap('BANK_DEMO', 'lapse_risk', 'region', NOW);
    for (const c of region.cells) expect(c.group).toBeNull();
    const channel = buildInsuranceHeatmap('BANK_DEMO', 'channel_risk', 'channel', NOW);
    for (const c of channel.cells) expect(c.group).toBeTruthy();
  });

  it('solvency_stress headline is a ratio in [1.1, 2.3]', () => {
    const hm = buildInsuranceHeatmap('BANK_DEMO', 'solvency_stress', 'region', NOW);
    for (const c of hm.cells) {
      expect(c.headline_unit).toBe('ratio');
      expect(c.headline_value).toBeGreaterThanOrEqual(1.1);
      expect(c.headline_value).toBeLessThanOrEqual(2.3);
    }
  });

  it('persistency_weakness — lower persistency yields higher risk_score (inverted)', () => {
    const hm = buildInsuranceHeatmap('BANK_DEMO', 'persistency_weakness', 'channel', NOW);
    for (const c of hm.cells) {
      // 55% persistency → ~100 risk; 95% → ~0 risk
      const expected = Math.round(Math.min(100, Math.max(0, ((95 - c.headline_value) / 40) * 100)));
      expect(Math.abs(c.risk_score - expected)).toBeLessThanOrEqual(1);
    }
  });

  it('deterministic per (tenant, metric, dimension, day)', () => {
    expect(buildInsuranceHeatmap('BANK_DEMO', 'fraud', 'branch', NOW)).toEqual(
      buildInsuranceHeatmap('BANK_DEMO', 'fraud', 'branch', NOW),
    );
  });

  it('BIL scaled below BANK_DEMO on volume (fraud/branch)', () => {
    const bank = buildInsuranceHeatmap('BANK_DEMO', 'fraud', 'branch', NOW);
    const bil = buildInsuranceHeatmap('BIL', 'fraud', 'branch', NOW);
    const vol = (h: typeof bank) => h.cells.reduce((a, c) => a + c.volume, 0);
    expect(vol(bil)).toBeLessThan(vol(bank));
  });
});

describe('validation', () => {
  it('empty tenant_id throws', () => {
    expect(() => buildInsuranceHeatmap('', 'fraud', 'branch', NOW)).toThrow(InsuranceHeatmapError);
  });
  it('invalid metric throws', () => {
    expect(() => buildInsuranceHeatmap('BANK_DEMO', 'bogus' as never, 'branch', NOW)).toThrow(InsuranceHeatmapError);
  });
  it('invalid dimension throws', () => {
    expect(() => buildInsuranceHeatmap('BANK_DEMO', 'fraud', 'bogus' as never, NOW)).toThrow(InsuranceHeatmapError);
  });
});
