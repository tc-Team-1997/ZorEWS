// services/bff/__tests__/ai_explainability.test.ts

import {
  explainPrediction,
  buildTrustSignals,
  ExplainabilityError,
} from '../src/ai_explainability';

const NOW = new Date('2026-05-23T12:00:00.000Z');

describe('explainPrediction', () => {
  it('returns top-5 features + counterfactual + group rollup', () => {
    const out = explainPrediction('BANK_DEMO', 'pred-BANK_DEMO-c-100001-2026-05-23-90', NOW);
    expect(out.top_features).toHaveLength(5);
    expect(out.counterfactual).toBeDefined();
    expect(out.feature_group_summary.length).toBeGreaterThan(0);
    expect(out.base_pd_population).toBeGreaterThan(0);
  });

  it('top features sorted by |weight| desc', () => {
    const out = explainPrediction('BANK_DEMO', 'pred-x', NOW);
    for (let i = 1; i < out.top_features.length; i++) {
      expect(Math.abs(out.top_features[i - 1].weight)).toBeGreaterThanOrEqual(Math.abs(out.top_features[i].weight));
    }
  });

  it('counterfactual reduces PD vs original', () => {
    const out = explainPrediction('BANK_DEMO', 'pred-x', NOW);
    expect(out.counterfactual.resulting_pd).toBeLessThanOrEqual(out.pd);
  });

  it('deterministic per (tenant, prediction_id)', () => {
    const a = explainPrediction('BANK_DEMO', 'pred-x', NOW);
    const b = explainPrediction('BANK_DEMO', 'pred-x', NOW);
    expect(a.pd).toBe(b.pd);
    expect(a.top_features[0].weight).toBe(b.top_features[0].weight);
  });

  it('feature group pct_of_total in (0, 1] for every group', () => {
    const out = explainPrediction('BANK_DEMO', 'pred-x', NOW);
    for (const g of out.feature_group_summary) {
      expect(g.pct_of_total).toBeGreaterThanOrEqual(0);
      expect(g.pct_of_total).toBeLessThanOrEqual(1);
    }
    // The sum is normalised against total |weight| but groups can offset
    // when signs cancel; sum is in (0, 1] as a sanity bound.
    const sum = out.feature_group_summary.reduce((a, g) => a + g.pct_of_total, 0);
    expect(sum).toBeGreaterThan(0);
    expect(sum).toBeLessThanOrEqual(1.001);
  });

  it('rejects empty input', () => {
    expect(() => explainPrediction('', 'pred-x', NOW)).toThrow(ExplainabilityError);
    expect(() => explainPrediction('BANK_DEMO', '', NOW)).toThrow(ExplainabilityError);
  });
});

describe('buildTrustSignals', () => {
  it('returns 5 signals + overall worst', () => {
    const out = buildTrustSignals('BANK_DEMO', 'pred-x', NOW);
    expect(out.signals).toHaveLength(5);
    expect(['green', 'amber', 'red']).toContain(out.overall);
  });

  it('every signal has status + value + threshold', () => {
    const out = buildTrustSignals('BANK_DEMO', 'pred-x', NOW);
    for (const s of out.signals) {
      expect(['green', 'amber', 'red']).toContain(s.status);
      expect(s.value.length).toBeGreaterThan(0);
      expect(s.threshold.length).toBeGreaterThan(0);
    }
  });

  it('overall reflects worst signal', () => {
    const out = buildTrustSignals('BANK_DEMO', 'pred-x', NOW);
    const rank: Record<string, number> = { red: 2, amber: 1, green: 0 };
    const worst = out.signals.reduce((a, s) => (rank[s.status] > rank[a] ? s.status : a), 'green');
    expect(out.overall).toBe(worst);
  });

  it('deterministic per (tenant, prediction_id)', () => {
    const a = buildTrustSignals('BANK_DEMO', 'pred-x', NOW);
    const b = buildTrustSignals('BANK_DEMO', 'pred-x', NOW);
    expect(a.overall).toBe(b.overall);
  });

  it('rejects empty input', () => {
    expect(() => buildTrustSignals('', 'pred-x', NOW)).toThrow(ExplainabilityError);
    expect(() => buildTrustSignals('BANK_DEMO', '', NOW)).toThrow(ExplainabilityError);
  });
});
