// @ts-nocheck
// T6 M2.20 + M3.20 + M4.20 + M7.20 + M9.20 — pure-function + route tests

import supertest from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const H = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function mkApp(role) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    getRole: () => (role || 'admin'),
  });
}

// ── M2.20 pure functions ──────────────────────────────────────────────────

describe('M2.20 - Onboarding velocity histogram (pure)', () => {
  test('bucketForVelocityDays: all 6 boundary cases', () => {
    const { bucketForVelocityDays } = require('../src/tenant_onboarding_velocity_histogram');
    expect(bucketForVelocityDays(0)).toBe('same_day');
    expect(bucketForVelocityDays(2)).toBe('within_3d');
    expect(bucketForVelocityDays(5)).toBe('within_7d');
    expect(bucketForVelocityDays(15)).toBe('within_30d');
    expect(bucketForVelocityDays(40)).toBe('beyond_30d');
    expect(bucketForVelocityDays(null)).toBe('incomplete');
  });

  test('strict boundaries: 3 → within_3d, 4 → within_7d, 7 → within_7d, 8 → within_30d, 30 → within_30d, 31 → beyond_30d', () => {
    const { bucketForVelocityDays } = require('../src/tenant_onboarding_velocity_histogram');
    expect(bucketForVelocityDays(3)).toBe('within_3d');
    expect(bucketForVelocityDays(4)).toBe('within_7d');
    expect(bucketForVelocityDays(7)).toBe('within_7d');
    expect(bucketForVelocityDays(8)).toBe('within_30d');
    expect(bucketForVelocityDays(30)).toBe('within_30d');
    expect(bucketForVelocityDays(31)).toBe('beyond_30d');
  });

  test('empty input returns all-zero histogram', () => {
    const { buildTenantOnboardingVelocityHistogram } = require('../src/tenant_onboarding_velocity_histogram');
    const r = buildTenantOnboardingVelocityHistogram([], new Date());
    expect(r.total_tenants).toBe(0);
    expect(r.completed_count).toBe(0);
    expect(r.incomplete_count).toBe(0);
    expect(r.mean_days).toBeNull();
    expect(r.peak_bucket).toBeNull();
    expect(r.buckets).toHaveLength(6);
  });

  test('6 canonical bucket order', () => {
    const { buildTenantOnboardingVelocityHistogram, ALL_VELOCITY_BUCKETS } = require('../src/tenant_onboarding_velocity_histogram');
    const r = buildTenantOnboardingVelocityHistogram([], new Date());
    expect(r.buckets.map(b => b.bucket)).toEqual([...ALL_VELOCITY_BUCKETS]);
  });

  test('completed tenant lands in within_7d', () => {
    const { buildTenantOnboardingVelocityHistogram } = require('../src/tenant_onboarding_velocity_histogram');
    const now = new Date('2026-06-09T00:00:00Z');
    const inputs = [
      { tenant_id: 'T1', provisioned_at: '2026-06-02T00:00:00Z', completed_at: '2026-06-09T00:00:00Z' },
      { tenant_id: 'T2', provisioned_at: '2026-06-01T00:00:00Z', completed_at: null },
    ];
    const r = buildTenantOnboardingVelocityHistogram(inputs, now);
    expect(r.completed_count).toBe(1);
    expect(r.incomplete_count).toBe(1);
    expect(r.buckets.find(b => b.bucket === 'within_7d').count).toBe(1);
    const sum = r.buckets.reduce((s, b) => s + b.count, 0);
    expect(sum).toBe(2);
  });

  test('mean_days correct', () => {
    const { buildTenantOnboardingVelocityHistogram } = require('../src/tenant_onboarding_velocity_histogram');
    const now = new Date('2026-06-09T00:00:00Z');
    const inputs = [
      { tenant_id: 'A', provisioned_at: '2026-06-05T00:00:00Z', completed_at: '2026-06-09T00:00:00Z' }, // 4 days
      { tenant_id: 'B', provisioned_at: '2026-06-03T00:00:00Z', completed_at: '2026-06-09T00:00:00Z' }, // 6 days
    ];
    const r = buildTenantOnboardingVelocityHistogram(inputs, now);
    expect(r.mean_days).toBe(5);
    expect(r.fastest_days).toBe(4);
    expect(r.slowest_days).toBe(6);
  });
});

// ── M3.20 pure + route ────────────────────────────────────────────────────

describe('M3.20 - Connector health scorecard', () => {
  test('GET /v1/ingestion/health-scorecard returns fleet data', async () => {
    const { app } = mkApp('admin');
    const res = await supertest(app).get('/v1/ingestion/health-scorecard').set(H).expect(200);
    const b = res.body.body;
    expect(b.fleet_avg_score).toBeGreaterThanOrEqual(0);
    expect(b.fleet_avg_score).toBeLessThanOrEqual(100);
    expect(Array.isArray(b.connectors)).toBe(true);
  });

  test('each connector score 0-100 and sorted ascending', async () => {
    const { app } = mkApp('admin');
    const res = await supertest(app).get('/v1/ingestion/health-scorecard').set(H).expect(200);
    const scores = res.body.body.connectors.map(c => c.score);
    for (const s of scores) { expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThanOrEqual(100); }
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1]);
  });

  test('non-admin 403', async () => {
    const { app } = mkApp('field_officer');
    await supertest(app).get('/v1/ingestion/health-scorecard').set(H).expect(403);
  });

  test('M3.19 freshness-alert not shadowed', async () => {
    const { app } = mkApp('admin');
    await supertest(app).get('/v1/ingestion/freshness-alert').set(H).expect(200);
  });

  test('scoreConnector 100pct success → success_rate_score=100', () => {
    const { scoreConnector } = require('../src/connector_health_scorecard');
    const now = new Date();
    const runs = Array.from({ length: 20 }, (_, i) => ({
      run_id: 'r'+i, connector_id: 'cbs', status: 'success',
      started_at: new Date(now - i * 60000).toISOString(),
      finished_at: new Date(now - i * 60000 + 1500).toISOString(),
      records_processed: 1000, records_failed: 0,
    }));
    const score = scoreConnector('cbs', 'CBS', 'rest_api', 'CBS', runs, now);
    expect(score.components.success_rate_score).toBe(100);
    expect(score.score).toBeGreaterThan(60);
    expect(['excellent', 'good']).toContain(score.tier);
  });

  test('low success rate → poor or critical tier', () => {
    const { scoreConnector } = require('../src/connector_health_scorecard');
    const now = new Date();
    const runs = Array.from({ length: 10 }, (_, i) => ({
      run_id: 'r'+i, connector_id: 'c1', status: i < 2 ? 'success' : 'failure',
      started_at: now.toISOString(), finished_at: new Date(now.getTime() + 100).toISOString(),
      records_processed: 100, records_failed: 0,
    }));
    const score = scoreConnector('c1', 'C1', 'rest_api', 'CBS', runs, now);
    expect(['poor', 'critical', 'fair']).toContain(score.tier);
  });
});

// ── M4.20 route + pure ────────────────────────────────────────────────────

describe('M4.20 - Threshold calibration recommendations', () => {
  test('route returns report', async () => {
    const { app } = mkApp('admin');
    const res = await supertest(app).get('/v1/indicators/thresholds/calibration-recommendations').set(H).expect(200);
    const b = res.body.body;
    expect(b.total_indicators).toBeGreaterThan(0);
    expect(b.target_fp_rate).toBe(0.15);
    expect(b.needs_tightening + b.needs_loosening + b.well_calibrated).toBe(b.total_indicators);
  });

  test('non-admin 403', async () => {
    const { app } = mkApp('field_officer');
    await supertest(app).get('/v1/indicators/thresholds/calibration-recommendations').set(H).expect(403);
  });

  test('M4.19 sibling not shadowed', async () => {
    const { app } = mkApp('admin');
    await supertest(app).get('/v1/indicators/thresholds/shift-analysis').set(H).expect(200);
  });

  test('buildIndicatorRecommendation valid structure', () => {
    const { buildIndicatorRecommendation } = require('../src/indicator_threshold_recommendation');
    const rec = buildIndicatorRecommendation('FIN-001', 'DPD', 'banking',
      { yellow_at: 0.30, orange_at: 0.55, red_at: 0.80 }, 'BANK_DEMO', '2026-06-09', 30);
    expect(['tighten', 'loosen', 'keep']).toContain(rec.direction);
    expect(['high', 'medium', 'low']).toContain(rec.confidence);
    expect(rec.false_positive_rate_observed).toBeGreaterThanOrEqual(0);
    expect(rec.false_positive_rate_observed).toBeLessThanOrEqual(1);
    expect(rec.summary.length).toBeGreaterThan(0);
  });
});

// ── M7.20 route + pure ────────────────────────────────────────────────────

describe('M7.20 - AI model decision distribution', () => {
  test('returns 5 bands very_low to very_high', async () => {
    const { app } = mkApp('admin');
    const res = await supertest(app).get('/v1/ai/models/pd_xgb_v3/decision-distribution').set(H).expect(200);
    const b = res.body.body;
    expect(b.bands).toHaveLength(5);
    expect(b.bands[0].band).toBe('very_low');
    expect(b.bands[4].band).toBe('very_high');
  });

  test('unknown model 404', async () => {
    const { app } = mkApp('admin');
    await supertest(app).get('/v1/ai/models/no-such-model-xyz/decision-distribution').set(H).expect(404);
  });

  test('M7.18 sibling not shadowed', async () => {
    const { app } = mkApp('admin');
    await supertest(app).get('/v1/ai/models/performance-freshness').set(H).expect(200);
  });

  test('empty sample → 5 zero bands, no stats', () => {
    const { buildModelDecisionDistribution } = require('../src/ai_model_decision_distribution');
    const r = buildModelDecisionDistribution('m', 'T', 0, new Date());
    expect(r.bands.every(b => b.count === 0)).toBe(true);
    expect(r.mean_score).toBeNull();
    expect(r.discrimination_index).toBeNull();
  });

  test('bandForScore: 5 boundaries', () => {
    const { bandForScore } = require('../src/ai_model_decision_distribution');
    expect(bandForScore(10)).toBe('very_low');
    expect(bandForScore(30)).toBe('low');
    expect(bandForScore(50)).toBe('medium');
    expect(bandForScore(70)).toBe('high');
    expect(bandForScore(90)).toBe('very_high');
  });

  test('bandForScore strict boundaries: 19→very_low, 20→low, 39→low, 40→medium', () => {
    const { bandForScore } = require('../src/ai_model_decision_distribution');
    expect(bandForScore(19)).toBe('very_low');
    expect(bandForScore(20)).toBe('low');
    expect(bandForScore(39)).toBe('low');
    expect(bandForScore(40)).toBe('medium');
  });
});

// ── M9.20 route + pure ────────────────────────────────────────────────────

describe('M9.20 - Investigation verdict distribution', () => {
  test('returns 5 verdicts in canonical order', async () => {
    const { app } = mkApp('admin');
    const res = await supertest(app).get('/v1/investigations/verdict-distribution').set(H).expect(200);
    const b = res.body.body;
    expect(b.verdicts).toHaveLength(5);
    expect(b.verdicts[0].verdict).toBe('fraud_confirmed');
    expect(b.verdicts[4].verdict).toBe('no_decision');
  });

  test('sigma counts = total_investigations', async () => {
    const { app } = mkApp('admin');
    const res = await supertest(app).get('/v1/investigations/verdict-distribution').set(H).expect(200);
    const { verdicts, total_investigations } = res.body.body;
    expect(verdicts.reduce((s, v) => s + v.count, 0)).toBe(total_investigations);
  });

  test('non-admin 403', async () => {
    const { app } = mkApp('field_officer');
    await supertest(app).get('/v1/investigations/verdict-distribution').set(H).expect(403);
  });

  test('M9.19 sibling not shadowed', async () => {
    const { app } = mkApp('admin');
    await supertest(app).get('/v1/investigations/duration-histogram').set(H).expect(200);
  });

  test('classifyVerdict: open → no_decision, closed+fraud → fraud_confirmed', () => {
    const { classifyVerdict } = require('../src/investigation_outcome_verdict_distribution');
    expect(classifyVerdict({ status: 'triage', decision: null })).toBe('no_decision');
    expect(classifyVerdict({ status: 'closed', decision: 'fraud_confirmed' })).toBe('fraud_confirmed');
    expect(classifyVerdict({ status: 'closed', decision: 'partial_fraud' })).toBe('partial_fraud');
    expect(classifyVerdict({ status: 'closed', decision: 'data_quality' })).toBe('data_quality');
  });

  test('empty input all zero, null rates', () => {
    const { buildInvestigationVerdictDistribution } = require('../src/investigation_outcome_verdict_distribution');
    const r = buildInvestigationVerdictDistribution('BANK_DEMO', [], new Date());
    expect(r.total_investigations).toBe(0);
    expect(r.verdicts.every(v => v.count === 0)).toBe(true);
    expect(r.confirmation_rate).toBeNull();
    expect(r.most_common_verdict).toBeNull();
  });

  test('confirmed investigation counted, fraud_detection_rate=1', () => {
    const { buildInvestigationVerdictDistribution } = require('../src/investigation_outcome_verdict_distribution');
    const inv = [{ investigation_id: 'I1', case_id: 'C1', customer_id: 'c1',
      status: 'closed', decision: 'fraud_confirmed',
      opened_at: '2026-06-01T00:00:00Z', closed_at: '2026-06-08T00:00:00Z',
      steps: [], notes_count: 0, last_updated_at: '2026-06-08T00:00:00Z',
      opened_by: 'alice', checklist_template_id: 'BUILT_IN' }];
    const r = buildInvestigationVerdictDistribution('BANK_DEMO', inv, new Date());
    expect(r.verdicts.find(v => v.verdict === 'fraud_confirmed').count).toBe(1);
    expect(r.fraud_detection_rate).toBe(1);
    expect(r.most_common_verdict).toBe('fraud_confirmed');
  });
});
