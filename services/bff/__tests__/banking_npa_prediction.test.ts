// services/bff/__tests__/banking_npa_prediction.test.ts

import {
  isNpaHorizon,
  buildNpaHighRisk,
  explainNpaPrediction,
  buildNpaBacktest,
  NpaPredictionError,
} from '../src/banking_npa_prediction';

const NOW = new Date('2026-05-23T12:00:00.000Z');

describe('isNpaHorizon', () => {
  it('accepts 30/60/90/180', () => {
    expect(isNpaHorizon(30)).toBe(true);
    expect(isNpaHorizon(60)).toBe(true);
    expect(isNpaHorizon(90)).toBe(true);
    expect(isNpaHorizon(180)).toBe(true);
  });
  it('rejects others', () => {
    expect(isNpaHorizon(45)).toBe(false);
    expect(isNpaHorizon('90')).toBe(false);
  });
});

describe('buildNpaHighRisk', () => {
  it('returns canonical envelope with high+critical rows only', () => {
    const out = buildNpaHighRisk('BANK_DEMO', 90, NOW);
    expect(out.tenant_id).toBe('BANK_DEMO');
    expect(out.horizon_days).toBe(90);
    expect(out.total_high_risk).toBe(out.rows.length);
    for (const r of out.rows) {
      expect(['high', 'critical']).toContain(r.band);
      expect(r.pd).toBeGreaterThanOrEqual(0.6);
    }
  });

  it('sorted PD desc', () => {
    const out = buildNpaHighRisk('BANK_DEMO', 90, NOW);
    for (let i = 1; i < out.rows.length; i++) {
      expect(out.rows[i - 1].pd).toBeGreaterThanOrEqual(out.rows[i].pd);
    }
  });

  it('deterministic per (tenant, horizon, day)', () => {
    const a = buildNpaHighRisk('BANK_DEMO', 90, NOW);
    const b = buildNpaHighRisk('BANK_DEMO', 90, NOW);
    expect(a.total_high_risk).toBe(b.total_high_risk);
    expect(a.total_critical).toBe(b.total_critical);
  });

  it('different horizons → different counts', () => {
    const a = buildNpaHighRisk('BANK_DEMO', 90, NOW);
    const b = buildNpaHighRisk('BANK_DEMO', 180, NOW);
    expect(a.rows[0]?.prediction_id).not.toBe(b.rows[0]?.prediction_id);
  });

  it('rejects bad horizon + empty tenant', () => {
    expect(() => buildNpaHighRisk('BANK_DEMO', 45 as 90, NOW)).toThrow(NpaPredictionError);
    expect(() => buildNpaHighRisk('', 90, NOW)).toThrow(NpaPredictionError);
  });
});

describe('explainNpaPrediction', () => {
  it('returns 5 top features + 3 comparables + 3 actions', () => {
    const out = explainNpaPrediction('BANK_DEMO', 'a-100001-00', NOW);
    expect(out.top_features).toHaveLength(5);
    expect(out.comparable_customers).toHaveLength(3);
    expect(out.recommended_actions).toHaveLength(3);
    expect(out.model_id).toBe('pd-xgb-prod');
  });

  it('rejects empty input', () => {
    expect(() => explainNpaPrediction('', 'a-1-0', NOW)).toThrow(NpaPredictionError);
    expect(() => explainNpaPrediction('BANK_DEMO', '', NOW)).toThrow(NpaPredictionError);
  });
});

describe('buildNpaBacktest', () => {
  it('returns confusion that sums to cohort_size', () => {
    const out = buildNpaBacktest('BANK_DEMO', NOW);
    const { tp, fp, tn, fn } = out.confusion;
    expect(tp + fp + tn + fn).toBe(out.cohort_size);
  });

  it('auc + ks within sensible ranges', () => {
    const out = buildNpaBacktest('BANK_DEMO', NOW);
    expect(out.auc).toBeGreaterThan(0.7);
    expect(out.auc).toBeLessThanOrEqual(1);
    expect(out.ks).toBeGreaterThan(0);
  });

  it('by_segment covers 4 segments', () => {
    const out = buildNpaBacktest('BANK_DEMO', NOW);
    expect(out.by_segment).toHaveLength(4);
  });

  it('rejects empty tenant', () => {
    expect(() => buildNpaBacktest('', NOW)).toThrow(NpaPredictionError);
  });
});
