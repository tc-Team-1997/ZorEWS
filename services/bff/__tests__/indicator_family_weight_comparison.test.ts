// @ts-nocheck
import { buildIndicatorFamilyWeightComparison } from '../src/indicator_family_weight_comparison';
import { STUB_CATALOG } from '../src/bil_scoring_v2';

const NOW = new Date('2026-06-01T10:00:00Z');

describe('buildIndicatorFamilyWeightComparison', () => {
  it('returns report with generated_at', () => {
    const report = buildIndicatorFamilyWeightComparison(NOW);
    expect(report.generated_at).toBeDefined();
  });

  it('total_families matches families array length', () => {
    const report = buildIndicatorFamilyWeightComparison(NOW);
    expect(report.total_families).toBe(report.families.length);
  });

  it('all indicators in STUB_CATALOG are covered', () => {
    const report = buildIndicatorFamilyWeightComparison(NOW);
    const total_indicators = report.families.reduce((s, f) => s + f.indicator_count, 0);
    expect(total_indicators).toBe(Object.keys(STUB_CATALOG).length);
  });

  it('each family has required fields', () => {
    const report = buildIndicatorFamilyWeightComparison(NOW);
    for (const f of report.families) {
      expect(f.family).toBeDefined();
      expect(f.indicator_count).toBeGreaterThan(0);
      expect(f.min_weight).toBeGreaterThanOrEqual(0);
      expect(f.max_weight).toBeGreaterThanOrEqual(f.min_weight);
      expect(f.avg_weight).toBeGreaterThan(0);
      expect(f.weight_range).toBe(f.max_weight - f.min_weight);
      expect(f.dominant_indicators.length).toBeLessThanOrEqual(2);
    }
  });

  it('sorts by avg_weight desc', () => {
    const report = buildIndicatorFamilyWeightComparison(NOW);
    for (let i = 1; i < report.families.length; i++) {
      expect(report.families[i].avg_weight).toBeLessThanOrEqual(report.families[i - 1].avg_weight);
    }
  });

  it('heaviest_family is first in sorted list', () => {
    const report = buildIndicatorFamilyWeightComparison(NOW);
    if (report.families.length > 0) {
      expect(report.heaviest_family).toBe(report.families[0].family);
    }
  });

  it('lightest_family is last in sorted list', () => {
    const report = buildIndicatorFamilyWeightComparison(NOW);
    if (report.families.length > 0) {
      expect(report.lightest_family).toBe(report.families[report.families.length - 1].family);
    }
  });

  it('dominant_indicators are sorted by weight desc', () => {
    const report = buildIndicatorFamilyWeightComparison(NOW);
    for (const f of report.families) {
      const weights = f.dominant_indicators.map(d => d.weight);
      for (let i = 1; i < weights.length; i++) {
        expect(weights[i]).toBeLessThanOrEqual(weights[i - 1]);
      }
    }
  });

  it('is deterministic across calls', () => {
    const r1 = buildIndicatorFamilyWeightComparison(NOW);
    const r2 = buildIndicatorFamilyWeightComparison(NOW);
    expect(r1.total_families).toBe(r2.total_families);
    expect(r1.heaviest_family).toBe(r2.heaviest_family);
  });
});
