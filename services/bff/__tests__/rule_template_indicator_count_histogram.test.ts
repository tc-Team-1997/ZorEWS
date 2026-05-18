// services/bff/__tests__/rule_template_indicator_count_histogram.test.ts
//
// T6 M5.18 — Rule template supporting_indicators count histogram.

import request from 'supertest';
import {
  buildRuleTemplateIndicatorCountHistogram,
  bucketForIndicatorCount,
  ALL_INDICATOR_COUNT_BUCKETS,
} from '../src/rule_template_indicator_count_histogram';
import { RULE_TEMPLATES, listCategories } from '../src/rule_templates';
import { ALL_RULE_TEMPLATE_VERTICALS } from '../src/rule_template_category_vertical_matrix';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

// ─── bucketForIndicatorCount pure helper ──────────────────────────────

describe('M5.18 — bucketForIndicatorCount', () => {
  test('1 → minimal', () => {
    expect(bucketForIndicatorCount(1)).toBe('minimal');
  });

  test('2-3 → low', () => {
    expect(bucketForIndicatorCount(2)).toBe('low');
    expect(bucketForIndicatorCount(3)).toBe('low');
  });

  test('4-6 → medium', () => {
    expect(bucketForIndicatorCount(4)).toBe('medium');
    expect(bucketForIndicatorCount(5)).toBe('medium');
    expect(bucketForIndicatorCount(6)).toBe('medium');
  });

  test('7-10 → high', () => {
    expect(bucketForIndicatorCount(7)).toBe('high');
    expect(bucketForIndicatorCount(10)).toBe('high');
  });

  test('>10 → comprehensive', () => {
    expect(bucketForIndicatorCount(11)).toBe('comprehensive');
    expect(bucketForIndicatorCount(50)).toBe('comprehensive');
  });

  test('0 → null', () => {
    expect(bucketForIndicatorCount(0)).toBeNull();
  });

  test('negative → null', () => {
    expect(bucketForIndicatorCount(-1)).toBeNull();
  });

  test('NaN → null', () => {
    expect(bucketForIndicatorCount(NaN)).toBeNull();
  });
});

// ─── Pure resolver ─────────────────────────────────────────────────────

describe('M5.18 — buildRuleTemplateIndicatorCountHistogram', () => {
  test('basic envelope shape', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_templates).toBeGreaterThan(0);
    expect(s.buckets.length).toBe(5);
    expect(s.peak_bucket).not.toBeNull();
    expect(s.peak_count).toBeGreaterThan(0);
  });

  test('buckets in canonical order', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    expect(s.buckets.map((b) => b.bucket)).toEqual([
      ...ALL_INDICATOR_COUNT_BUCKETS,
    ]);
  });

  test('total_catalog_size matches RULE_TEMPLATES.length', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    expect(s.total_catalog_size).toBe(RULE_TEMPLATES.length);
  });

  test('total_templates + templates_with_zero_indicators = total_catalog_size', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    expect(s.total_templates + s.templates_with_zero_indicators).toBe(
      s.total_catalog_size,
    );
  });

  test('zero-indicator templates surface separately', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    const manualZero = RULE_TEMPLATES.filter(
      (t) => t.supporting_indicators.length === 0,
    ).length;
    expect(s.templates_with_zero_indicators).toBe(manualZero);
  });

  test('Σ buckets.count = total_templates partition', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    const sum = s.buckets.reduce((acc, b) => acc + b.count, 0);
    expect(sum).toBe(s.total_templates);
  });

  test('every by_category key present per bucket', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    const cats = listCategories();
    for (const b of s.buckets) {
      for (const c of cats) {
        expect(b.by_category[c]).toBeGreaterThanOrEqual(0);
      }
      expect(Object.keys(b.by_category).length).toBe(cats.length);
    }
  });

  test('every by_vertical key present per bucket', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    for (const b of s.buckets) {
      for (const v of ALL_RULE_TEMPLATE_VERTICALS) {
        expect(b.by_vertical[v]).toBeGreaterThanOrEqual(0);
      }
      expect(Object.keys(b.by_vertical).length).toBe(
        ALL_RULE_TEMPLATE_VERTICALS.length,
      );
    }
  });

  test('Σ by_category per bucket = bucket.count', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    for (const b of s.buckets) {
      const sum = Object.values(b.by_category).reduce((a, n) => a + n, 0);
      expect(sum).toBe(b.count);
    }
  });

  test('Σ by_vertical per bucket = bucket.count', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    for (const b of s.buckets) {
      const sum = Object.values(b.by_vertical).reduce((a, n) => a + n, 0);
      expect(sum).toBe(b.count);
    }
  });

  test('sample_template_ids cap 3 sorted asc', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    for (const b of s.buckets) {
      expect(b.sample_template_ids.length).toBeLessThanOrEqual(3);
      const sorted = [...b.sample_template_ids].sort((a, c) =>
        a.localeCompare(c),
      );
      expect(b.sample_template_ids).toEqual(sorted);
    }
  });

  test('min_indicators ≤ mean_indicators ≤ max_indicators invariant', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    expect(s.min_indicators).not.toBeNull();
    expect(s.max_indicators).not.toBeNull();
    expect(s.mean_indicators).not.toBeNull();
    expect(s.min_indicators!).toBeLessThanOrEqual(s.mean_indicators!);
    expect(s.mean_indicators!).toBeLessThanOrEqual(s.max_indicators!);
  });

  test('min_indicators matches manual scan over non-zero templates', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    const nonZero = RULE_TEMPLATES.filter(
      (t) => t.supporting_indicators.length > 0,
    );
    const manualMin = Math.min(...nonZero.map((t) => t.supporting_indicators.length));
    expect(s.min_indicators).toBe(manualMin);
  });

  test('max_indicators matches manual scan over non-zero templates', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    const nonZero = RULE_TEMPLATES.filter(
      (t) => t.supporting_indicators.length > 0,
    );
    const manualMax = Math.max(...nonZero.map((t) => t.supporting_indicators.length));
    expect(s.max_indicators).toBe(manualMax);
  });

  test('mean_indicators = sum / count rounded 2 decimals (non-zero templates)', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    const nonZero = RULE_TEMPLATES.filter(
      (t) => t.supporting_indicators.length > 0,
    );
    const sum = nonZero.reduce((acc, t) => acc + t.supporting_indicators.length, 0);
    const expected = Math.round((sum / nonZero.length) * 100) / 100;
    expect(s.mean_indicators).toBe(expected);
  });

  test('peak_bucket formula = highest count', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    const maxCount = Math.max(...s.buckets.map((b) => b.count));
    expect(s.peak_count).toBe(maxCount);
    const expectedBucket = s.buckets.find((b) => b.count === maxCount)!.bucket;
    expect(s.peak_bucket).toBe(expectedBucket);
  });

  test('peak_bucket canonical iteration tie-break', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    if (s.peak_bucket !== null) {
      const peakIdx = ALL_INDICATOR_COUNT_BUCKETS.indexOf(s.peak_bucket);
      // No earlier bucket has STRICTLY higher count.
      for (let i = 0; i < peakIdx; i++) {
        const earlier = s.buckets.find(
          (b) => b.bucket === ALL_INDICATOR_COUNT_BUCKETS[i],
        )!;
        expect(earlier.count).toBeLessThanOrEqual(s.peak_count);
      }
    }
  });

  test('empty_buckets canonical order', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    const computed = s.buckets.filter((b) => b.count === 0).map((b) => b.bucket);
    expect(s.empty_buckets).toEqual(computed);
    // Sorted in canonical order
    const indices = s.empty_buckets.map((b) =>
      ALL_INDICATOR_COUNT_BUCKETS.indexOf(b),
    );
    const sorted = [...indices].sort((a, b) => a - b);
    expect(indices).toEqual(sorted);
  });

  test('bucket meta fields correct', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    const minimal = s.buckets.find((b) => b.bucket === 'minimal')!;
    expect(minimal.min).toBe(1);
    expect(minimal.max).toBe(1);
    expect(minimal.max_inclusive).toBe(true);
    const comp = s.buckets.find((b) => b.bucket === 'comprehensive')!;
    expect(comp.min).toBe(11);
    expect(comp.max).toBeNull();
  });

  test('platform-static — same response across now() calls', () => {
    const NOW2 = new Date('2026-06-15T08:30:00.000Z');
    const s1 = buildRuleTemplateIndicatorCountHistogram(NOW);
    const s2 = buildRuleTemplateIndicatorCountHistogram(NOW2);
    // generated_at differs but data must match
    expect(s1.total_templates).toBe(s2.total_templates);
    expect(s1.peak_bucket).toBe(s2.peak_bucket);
    expect(s1.peak_count).toBe(s2.peak_count);
    expect(s1.mean_indicators).toBe(s2.mean_indicators);
  });

  test('catalog cross-check: bucketed + zero = catalog size', () => {
    const s = buildRuleTemplateIndicatorCountHistogram(NOW);
    const bucketed = s.buckets.reduce((acc, b) => acc + b.count, 0);
    expect(bucketed + s.templates_with_zero_indicators).toBe(
      RULE_TEMPLATES.length,
    );
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M5.18 — GET /v1/rules/templates/indicator-count-histogram', () => {
  test('analyst+ → 200 with shape', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/rules/templates/indicator-count-histogram')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_catalog_size).toBe(RULE_TEMPLATES.length);
    expect(r.body.body.buckets.length).toBe(5);
    expect(r.body.body.peak_bucket).not.toBeNull();
  });

  test('risk_analyst accepted', async () => {
    const { app } = makeTestApp('risk_analyst');
    const r = await request(app)
      .get('/v1/rules/templates/indicator-count-histogram')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('unknown role → 403', async () => {
    // rules:list allows all 5 known roles; only an unknown role triggers 403.
    const { app } = makeTestApp('unknown_role');
    const r = await request(app)
      .get('/v1/rules/templates/indicator-count-histogram')
      .set(TH);
    expect(r.status).toBe(403);
  });

  test('platform-static across tenants', async () => {
    const { app } = makeTestApp('admin');
    const r1 = await request(app)
      .get('/v1/rules/templates/indicator-count-histogram')
      .set(TH);
    const r2 = await request(app)
      .get('/v1/rules/templates/indicator-count-histogram')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(r1.body.body.total_templates).toBe(r2.body.body.total_templates);
    expect(r1.body.body.peak_bucket).toBe(r2.body.body.peak_bucket);
  });

  test('M5.17 /category-vertical-matrix sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/rules/templates/category-vertical-matrix')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('M5.1 /categories sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/rules/templates/categories')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('literal /indicator-count-histogram not captured by /:id wildcard', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/rules/templates/indicator-count-histogram')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.buckets).toBeDefined();
  });
});
