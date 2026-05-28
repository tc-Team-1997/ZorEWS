// services/bff/__tests__/insurance_underwriting.test.ts
//
// Coverage for Insurance EWS Module 6 — Underwriting Deviation. Pure
// builders (dashboard, proposal analyze, deviations) + the 3 BFF routes.

import request from 'supertest';
import {
  buildUnderwritingDashboard,
  analyzeProposal,
  listDeviations,
  severityFor,
  DEVIATION_TYPES,
  DEVIATION_STATUSES,
  UW_SEVERITIES,
  UnderwritingError,
} from '../src/insurance_underwriting';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-28T12:00:00.000Z');

function makeInsApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── severityFor ─────────────────────────────────────────────────────────

describe('severityFor', () => {
  test('boundary mapping', () => {
    expect(severityFor(0.24)).toBe('low');
    expect(severityFor(0.25)).toBe('medium');
    expect(severityFor(0.5)).toBe('high');
    expect(severityFor(0.75)).toBe('critical');
  });
});

// ─── buildUnderwritingDashboard ──────────────────────────────────────────

describe('buildUnderwritingDashboard — pure builder', () => {
  test('shape — totals + 4 widgets', () => {
    const d = buildUnderwritingDashboard('BANK_DEMO', NOW);
    expect(d.tenant_id).toBe('BANK_DEMO');
    expect(d.generated_at).toBe(NOW.toISOString());
    expect(Array.isArray(d.high_risk_underwriters)).toBe(true);
    expect(Array.isArray(d.deviation_heatmap)).toBe(true);
    expect(Array.isArray(d.medical_waiver_analysis)).toBe(true);
    expect(Array.isArray(d.rule_violation_alerts)).toBe(true);
  });

  test('deterministic — same (tenant, day) identical', () => {
    const a = buildUnderwritingDashboard('BANK_DEMO', NOW);
    const b = buildUnderwritingDashboard('BANK_DEMO', NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('tenant divergence — BIL reviews fewer proposals', () => {
    const bank = buildUnderwritingDashboard('BANK_DEMO', NOW);
    const bil = buildUnderwritingDashboard('BIL', NOW);
    expect(bil.totals.proposals_reviewed).toBeLessThan(bank.totals.proposals_reviewed);
  });

  test('high_risk_underwriters — capped 10, ranked 1..n by risk desc', () => {
    const d = buildUnderwritingDashboard('BANK_DEMO', NOW);
    expect(d.high_risk_underwriters.length).toBeLessThanOrEqual(10);
    d.high_risk_underwriters.forEach((u, i) => expect(u.rank).toBe(i + 1));
    for (let i = 1; i < d.high_risk_underwriters.length; i++) {
      expect(d.high_risk_underwriters[i - 1].risk_score).toBeGreaterThanOrEqual(d.high_risk_underwriters[i].risk_score);
    }
  });

  test('deviation heatmap — 20 cells (4 types × 5 channels)', () => {
    const d = buildUnderwritingDashboard('BANK_DEMO', NOW);
    expect(d.deviation_heatmap).toHaveLength(20);
  });

  test('medical_waiver_analysis — 3 age bands', () => {
    const d = buildUnderwritingDashboard('BANK_DEMO', NOW);
    expect(d.medical_waiver_analysis.map((m) => m.band)).toEqual(['under_35', '35_50', 'over_50']);
    for (const m of d.medical_waiver_analysis) {
      expect(m.waiver_rate).toBeGreaterThanOrEqual(0);
      expect(m.waiver_rate).toBeLessThanOrEqual(1);
    }
  });

  test('rule_violation_alerts — open only, capped 12, severity-sorted', () => {
    const d = buildUnderwritingDashboard('BANK_DEMO', NOW);
    expect(d.rule_violation_alerts.length).toBeLessThanOrEqual(12);
    for (const a of d.rule_violation_alerts) expect(a.status).toBe('open');
    const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    for (let i = 1; i < d.rule_violation_alerts.length; i++) {
      expect(rank[d.rule_violation_alerts[i - 1].severity]).toBeLessThanOrEqual(rank[d.rule_violation_alerts[i].severity]);
    }
  });

  test('totals consistency', () => {
    const d = buildUnderwritingDashboard('BANK_DEMO', NOW);
    expect(d.totals.total_deviations).toBeGreaterThan(0);
    expect(d.totals.open_deviations).toBeLessThanOrEqual(d.totals.total_deviations);
    expect(d.totals.critical_deviations).toBeLessThanOrEqual(d.totals.total_deviations);
  });

  test('empty tenant_id throws', () => {
    expect(() => buildUnderwritingDashboard('', NOW)).toThrow(UnderwritingError);
  });
});

// ─── listDeviations ──────────────────────────────────────────────────────

describe('listDeviations — pure builder', () => {
  test('default returns all', () => {
    const l = listDeviations('BANK_DEMO', NOW);
    expect(l.type_filter).toBe('all');
    expect(l.status_filter).toBe('all');
  });

  test('deviation_type filter narrows', () => {
    const l = listDeviations('BANK_DEMO', NOW, { deviation_type: 'premium' });
    for (const d of l.deviations) expect(d.deviation_type).toBe('premium');
  });

  test('status filter narrows', () => {
    const l = listDeviations('BANK_DEMO', NOW, { status: 'open' });
    for (const d of l.deviations) expect(d.status).toBe('open');
  });

  test('limit caps rows', () => {
    const l = listDeviations('BANK_DEMO', NOW, { limit: 3 });
    expect(l.deviations.length).toBeLessThanOrEqual(3);
  });

  test('invalid deviation_type throws', () => {
    expect(() => listDeviations('BANK_DEMO', NOW, { deviation_type: 'nonsense' })).toThrow(UnderwritingError);
  });
  test('invalid status throws', () => {
    expect(() => listDeviations('BANK_DEMO', NOW, { status: 'nonsense' })).toThrow(UnderwritingError);
  });
});

// ─── analyzeProposal ─────────────────────────────────────────────────────

describe('analyzeProposal — ad-hoc', () => {
  test('on-guideline proposal scores low, no deviations', () => {
    const r = analyzeProposal({ premium_vs_guideline_ratio: 1, sum_assured_vs_limit_ratio: 1, medical_waiver_granted: false }, NOW);
    expect(r.deviation_score).toBeLessThan(0.25);
    expect(r.deviations).toHaveLength(0);
    expect(r.requires_exception_approval).toBe(false);
  });

  test('under-priced premium flags a premium deviation', () => {
    const r = analyzeProposal({ premium_vs_guideline_ratio: 0.6 }, NOW);
    expect(r.deviations.some((d) => d.deviation_type === 'premium')).toBe(true);
  });

  test('over-limit sum assured flags a sum_assured deviation', () => {
    const r = analyzeProposal({ sum_assured_vs_limit_ratio: 1.5 }, NOW);
    expect(r.deviations.some((d) => d.deviation_type === 'sum_assured')).toBe(true);
  });

  test('medical waiver flags a medical_waiver deviation', () => {
    const r = analyzeProposal({ medical_waiver_granted: true, applicant_age: 55 }, NOW);
    expect(r.deviations.some((d) => d.deviation_type === 'medical_waiver')).toBe(true);
  });

  test('rule overrides flag a rule_violation deviation', () => {
    const r = analyzeProposal({ rule_overrides: 2 }, NOW);
    expect(r.deviations.some((d) => d.deviation_type === 'rule_violation')).toBe(true);
  });

  test('stacked deviations score higher + require exception approval', () => {
    const r = analyzeProposal(
      { premium_vs_guideline_ratio: 0.5, sum_assured_vs_limit_ratio: 1.6, medical_waiver_granted: true, applicant_age: 60, rule_overrides: 3 },
      NOW,
    );
    expect(['high', 'critical']).toContain(r.severity);
    expect(r.requires_exception_approval).toBe(true);
  });

  test('deterministic', () => {
    const a = analyzeProposal({ premium_vs_guideline_ratio: 0.7 }, NOW);
    const b = analyzeProposal({ premium_vs_guideline_ratio: 0.7 }, NOW);
    expect(a.deviation_score).toBe(b.deviation_score);
  });

  test('clamped to [0,1] + deviations sorted desc', () => {
    const r = analyzeProposal({ premium_vs_guideline_ratio: 0, sum_assured_vs_limit_ratio: 5, medical_waiver_granted: true, applicant_age: 99, rule_overrides: 9 }, NOW);
    expect(r.deviation_score).toBeLessThanOrEqual(1);
    for (let i = 1; i < r.deviations.length; i++) {
      expect(r.deviations[i - 1].contribution).toBeGreaterThanOrEqual(r.deviations[i].contribution);
    }
  });

  test('severity matches severityFor', () => {
    const r = analyzeProposal({ premium_vs_guideline_ratio: 0.6, sum_assured_vs_limit_ratio: 1.3 }, NOW);
    expect(r.severity).toBe(severityFor(r.deviation_score));
  });

  test('negative signal throws', () => {
    expect(() => analyzeProposal({ premium_vs_guideline_ratio: -1 }, NOW)).toThrow(UnderwritingError);
  });
  test('non-finite signal throws', () => {
    expect(() => analyzeProposal({ sum_assured_vs_limit_ratio: Infinity }, NOW)).toThrow(UnderwritingError);
  });
  test('non-object throws', () => {
    expect(() => analyzeProposal(null as never, NOW)).toThrow(UnderwritingError);
  });
});

// ─── enum exports ─────────────────────────────────────────────────────────

describe('exports', () => {
  test('DEVIATION_TYPES has 4', () => {
    expect(DEVIATION_TYPES).toEqual(['premium', 'medical_waiver', 'sum_assured', 'rule_violation']);
  });
  test('DEVIATION_STATUSES has 4', () => {
    expect(DEVIATION_STATUSES).toEqual(['open', 'reviewed', 'accepted', 'reversed']);
  });
  test('UW_SEVERITIES canonical', () => {
    expect(UW_SEVERITIES).toEqual(['low', 'medium', 'high', 'critical']);
  });
});

// ─── routes ─────────────────────────────────────────────────────────────

describe('GET /v1/insurance/underwriting/dashboard', () => {
  test('admin happy path — enveloped', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/underwriting/dashboard').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.high_risk_underwriters).toBeDefined();
    expect(r.body.body.deviation_heatmap).toBeDefined();
  });

  test('field_officer (read) accepted', async () => {
    const r = await request(makeInsApp('field_officer').app).get('/v1/insurance/underwriting/dashboard').set(TH);
    expect(r.status).toBe(200);
  });

  test('tenant scoping — BIL diverges', async () => {
    const bank = await request(makeInsApp('admin').app).get('/v1/insurance/underwriting/dashboard').set(TH);
    const bil = await request(makeInsApp('admin').app).get('/v1/insurance/underwriting/dashboard').set(TH_BIL);
    expect(bil.body.body.totals.proposals_reviewed).toBeLessThan(bank.body.body.totals.proposals_reviewed);
  });

  test('missing tenant header → 400', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/underwriting/dashboard').set({ 'X-Channel': 'API' });
    expect(r.status).toBe(400);
  });
});

describe('POST /v1/insurance/underwriting/analyze', () => {
  test('analyst happy path', async () => {
    const r = await request(makeInsApp('risk_analyst').app)
      .post('/v1/insurance/underwriting/analyze')
      .set(TH)
      .send({ premium_vs_guideline_ratio: 0.6, sum_assured_vs_limit_ratio: 1.4, medical_waiver_granted: true, applicant_age: 55 });
    expect(r.status).toBe(200);
    expect(r.body.body.deviation_score).toBeGreaterThan(0);
    expect(r.body.body.deviations).toBeDefined();
  });

  test('enveloped body accepted', async () => {
    const r = await request(makeInsApp('admin').app)
      .post('/v1/insurance/underwriting/analyze')
      .set(TH)
      .send({ header: {}, body: { policy_id: 'POL-X', premium_vs_guideline_ratio: 0.7 } });
    expect(r.status).toBe(200);
    expect(r.body.body.policy_id).toBe('POL-X');
  });

  test('negative signal → 400', async () => {
    const r = await request(makeInsApp('admin').app)
      .post('/v1/insurance/underwriting/analyze')
      .set(TH)
      .send({ premium_vs_guideline_ratio: -1 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_value');
  });

  test('field_officer lacks analyze scope → 403', async () => {
    const r = await request(makeInsApp('field_officer').app)
      .post('/v1/insurance/underwriting/analyze')
      .set(TH)
      .send({ premium_vs_guideline_ratio: 0.8 });
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/insurance/underwriting/deviations', () => {
  test('happy path', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/underwriting/deviations').set(TH);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.body.deviations)).toBe(true);
  });

  test('?deviation_type=premium narrows', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/underwriting/deviations?deviation_type=premium').set(TH);
    for (const d of r.body.body.deviations) expect(d.deviation_type).toBe('premium');
  });

  test('?deviation_type=bogus → 400', async () => {
    const r = await request(makeInsApp('admin').app).get('/v1/insurance/underwriting/deviations?deviation_type=bogus').set(TH);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_deviation_type');
  });
});
