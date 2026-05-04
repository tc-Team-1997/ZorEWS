// services/bff/__tests__/bil_dashboards.test.ts
//
// Coverage for the BIL Claims dashboard (T6 M11.1) — both the pure
// builder and the BFF route.

import request from 'supertest';
import {
  buildAgentDashboard,
  buildClaimsDashboard,
  buildOperationalDashboard,
  buildUnderwritingDashboard,
} from '../src/bil_dashboards';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');

function makeBilApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('buildClaimsDashboard — pure builder', () => {
  test('shape — totals + 3 panel arrays', () => {
    const d = buildClaimsDashboard('BIL', NOW);
    expect(d.tenant_id).toBe('BIL');
    expect(d.as_of).toBe(NOW.toISOString());
    expect(d.totals.claims_filed_30d).toBeGreaterThan(0);
    expect(d.totals.claims_closed_30d).toBeLessThanOrEqual(d.totals.claims_filed_30d);
    expect(d.totals.fraud_flagged_pct).toBeGreaterThan(0);
    expect(d.totals.average_tat_hours).toBeGreaterThan(0);
    expect(Array.isArray(d.abnormal_claim_patterns)).toBe(true);
    expect(d.abnormal_claim_patterns.length).toBe(4);
    expect(Array.isArray(d.flagged_hospitals)).toBe(true);
    expect(d.flagged_hospitals.length).toBe(5);
    expect(Array.isArray(d.turnaround_anomalies)).toBe(true);
    expect(d.turnaround_anomalies.length).toBe(6);
  });

  test('deterministic — same (tenant, day) → identical payload', () => {
    const a = buildClaimsDashboard('BANK_DEMO', NOW);
    const b = buildClaimsDashboard('BANK_DEMO', NOW);
    expect(a).toEqual(b);
  });

  test('different tenants get different scale + content', () => {
    const bil = buildClaimsDashboard('BIL', NOW);
    const bank = buildClaimsDashboard('BANK_DEMO', NOW);
    // BIL operates at smaller scale (60% multiplier); BANK_DEMO claims_filed
    // should be measurably higher.
    expect(bank.totals.claims_filed_30d).toBeGreaterThan(bil.totals.claims_filed_30d);
  });

  test('flagged_hospitals are ranked 1..5 in fraud_score order', () => {
    const d = buildClaimsDashboard('BIL', NOW);
    expect(d.flagged_hospitals.map((h) => h.rank)).toEqual([1, 2, 3, 4, 5]);
    // The seed catalog declares fraud_score as 0.9, 0.8, 0.7, … with noise;
    // rank 1 should have fraud_score >= rank 5's.
    expect(d.flagged_hospitals[0]!.fraud_score).toBeGreaterThanOrEqual(
      d.flagged_hospitals[4]!.fraud_score,
    );
  });

  test('every abnormal pattern has a known severity bucket', () => {
    const d = buildClaimsDashboard('BANK_DEMO', NOW);
    for (const p of d.abnormal_claim_patterns) {
      expect(['critical', 'high', 'medium', 'low']).toContain(p.severity);
      expect(p.count_30d).toBeGreaterThanOrEqual(0);
    }
  });

  test('turnaround anomalies have actual_tat > expected_tat', () => {
    const d = buildClaimsDashboard('BANK_DEMO', NOW);
    for (const t of d.turnaround_anomalies) {
      expect(t.actual_tat_hours).toBeGreaterThan(t.expected_tat_hours);
      expect(['pending', 'investigating', 'escalated']).toContain(t.status);
    }
  });
});

describe('GET /v1/dashboards/bil/claims', () => {
  const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };
  const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

  test('admin gets the enveloped dashboard payload', async () => {
    const { app } = makeBilApp();
    const r = await request(app).get('/v1/dashboards/bil/claims').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
    expect(r.body.body.as_of).toBe(NOW.toISOString());
    expect(r.body.body.totals.claims_filed_30d).toBeGreaterThan(0);
    expect(r.body.body.abnormal_claim_patterns).toHaveLength(4);
    expect(r.body.body.flagged_hospitals).toHaveLength(5);
    expect(r.body.body.turnaround_anomalies).toHaveLength(6);
  });

  test('BIL tenant gets a BIL-scoped payload', async () => {
    const { app } = makeBilApp();
    const r = await request(app).get('/v1/dashboards/bil/claims').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('non-admin without audit:read → 403', async () => {
    const { app } = makeBilApp('field_officer');
    const r = await request(app).get('/v1/dashboards/bil/claims').set(TH);
    expect(r.status).toBe(403);
  });

  test('missing tenant headers → 400 envelope', async () => {
    const { app } = makeBilApp();
    const r = await request(app).get('/v1/dashboards/bil/claims').set({ 'X-Channel': 'API' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400');
    expect(r.body.error.message).toMatch(/X-Tenant-ID/);
  });
});

// ─── M11.2 — Underwriting Dashboard ────────────────────────────────────

describe('buildUnderwritingDashboard — pure builder', () => {
  test('shape: totals + 3 panels', () => {
    const d = buildUnderwritingDashboard('BIL', NOW);
    expect(d.tenant_id).toBe('BIL');
    expect(d.totals.proposals_30d).toBeGreaterThan(0);
    expect(d.totals.approved + d.totals.declined + d.totals.pending).toBe(d.totals.proposals_30d);
    expect(d.high_risk_proposals).toHaveLength(8);
    expect(d.churn_trend).toHaveLength(6);
    expect(d.lapse_predictions).toHaveLength(10);
  });

  test('deterministic — same (tenant, day) → identical', () => {
    expect(buildUnderwritingDashboard('BIL', NOW)).toEqual(buildUnderwritingDashboard('BIL', NOW));
  });

  test('lapse_predictions sorted highest probability first', () => {
    const d = buildUnderwritingDashboard('BANK_DEMO', NOW);
    for (let i = 1; i < d.lapse_predictions.length; i++) {
      expect(d.lapse_predictions[i - 1]!.lapse_probability_30d).toBeGreaterThanOrEqual(
        d.lapse_predictions[i]!.lapse_probability_30d,
      );
    }
  });

  test('churn_trend net_change matches issued - cancelled - lapsed', () => {
    const d = buildUnderwritingDashboard('BANK_DEMO', NOW);
    for (const m of d.churn_trend) {
      expect(m.net_change).toBe(m.policies_issued - m.policies_cancelled - m.policies_lapsed);
    }
  });

  test('high_risk_proposals: each has 2-3 risk_factors and a valid band', () => {
    const d = buildUnderwritingDashboard('BANK_DEMO', NOW);
    for (const p of d.high_risk_proposals) {
      expect(['critical', 'high', 'medium']).toContain(p.uw_risk_band);
      expect(p.risk_factors.length).toBeGreaterThanOrEqual(1);
      expect(p.risk_factors.length).toBeLessThanOrEqual(3);
    }
  });
});

describe('GET /v1/dashboards/bil/underwriting', () => {
  const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

  test('admin gets the enveloped UW dashboard', async () => {
    const { app } = makeBilApp();
    const r = await request(app).get('/v1/dashboards/bil/underwriting').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
    expect(r.body.body.totals.proposals_30d).toBeGreaterThan(0);
    expect(r.body.body.churn_trend).toHaveLength(6);
  });

  test('non-admin → 403', async () => {
    const { app } = makeBilApp('field_officer');
    const r = await request(app).get('/v1/dashboards/bil/underwriting').set(TH);
    expect(r.status).toBe(403);
  });
});

// ─── M11.3 — Agent Dashboard ───────────────────────────────────────────

describe('buildAgentDashboard — pure builder', () => {
  test('shape: totals + 3 panels', () => {
    const d = buildAgentDashboard('BIL', NOW);
    expect(d.totals.active_agents).toBeGreaterThan(0);
    expect(d.agent_leaderboard).toHaveLength(8);
    expect(d.risk_contribution).toHaveLength(6);
    expect(d.cancellation_clusters).toHaveLength(4);
  });

  test('deterministic — same (tenant, day) → identical', () => {
    expect(buildAgentDashboard('BIL', NOW)).toEqual(buildAgentDashboard('BIL', NOW));
  });

  test('leaderboard ranked 1..8', () => {
    const d = buildAgentDashboard('BANK_DEMO', NOW);
    expect(d.agent_leaderboard.map((a) => a.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('risk_contribution sorted highest risk first', () => {
    const d = buildAgentDashboard('BANK_DEMO', NOW);
    for (let i = 1; i < d.risk_contribution.length; i++) {
      expect(d.risk_contribution[i - 1]!.risk_score).toBeGreaterThanOrEqual(
        d.risk_contribution[i]!.risk_score,
      );
    }
  });

  test('cancellation_clusters carry agent_count + rate + premium-at-risk', () => {
    const d = buildAgentDashboard('BANK_DEMO', NOW);
    for (const c of d.cancellation_clusters) {
      expect(c.agent_count).toBeGreaterThanOrEqual(2);
      expect(c.cancellation_rate).toBeGreaterThan(0);
      expect(c.cancellation_rate).toBeLessThan(1);
      expect(c.total_premium_at_risk_kes).toBeGreaterThan(0);
    }
  });
});

describe('GET /v1/dashboards/bil/agent', () => {
  const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

  test('admin gets the enveloped agent dashboard', async () => {
    const { app } = makeBilApp();
    const r = await request(app).get('/v1/dashboards/bil/agent').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.agent_leaderboard).toHaveLength(8);
  });
});

// ─── M11.4 — Operational Dashboard ─────────────────────────────────────

describe('buildOperationalDashboard — pure builder', () => {
  test('shape: totals + 3 panels', () => {
    const d = buildOperationalDashboard('BIL', NOW);
    expect(d.totals.pending_underwriting).toBeGreaterThan(0);
    expect(d.totals.suspicious_logins_30d).toBeGreaterThan(0);
    expect(d.uw_delay_breakdown).toHaveLength(5);
    expect(d.login_anomalies).toHaveLength(7);
    expect(d.override_log).toHaveLength(8);
  });

  test('deterministic — same (tenant, day) → identical', () => {
    expect(buildOperationalDashboard('BIL', NOW)).toEqual(buildOperationalDashboard('BIL', NOW));
  });

  test('uw_delay_breakdown sorted by p95 desc', () => {
    const d = buildOperationalDashboard('BANK_DEMO', NOW);
    for (let i = 1; i < d.uw_delay_breakdown.length; i++) {
      expect(d.uw_delay_breakdown[i - 1]!.p95_delay_hours).toBeGreaterThanOrEqual(
        d.uw_delay_breakdown[i]!.p95_delay_hours,
      );
    }
  });

  test('login_anomalies sorted newest-first', () => {
    const d = buildOperationalDashboard('BANK_DEMO', NOW);
    for (let i = 1; i < d.login_anomalies.length; i++) {
      expect(d.login_anomalies[i - 1]!.occurred_at >= d.login_anomalies[i]!.occurred_at).toBe(true);
    }
  });

  test('login_anomalies have valid reasons + severities', () => {
    const d = buildOperationalDashboard('BANK_DEMO', NOW);
    for (const a of d.login_anomalies) {
      expect([
        'geo_velocity',
        'device_change',
        'after_hours_admin',
        'failed_attempts_spike',
      ]).toContain(a.reason);
      expect(['critical', 'high', 'medium']).toContain(a.severity);
    }
  });

  test('override_log sorted newest-first; resource_type is from the closed enum', () => {
    const d = buildOperationalDashboard('BANK_DEMO', NOW);
    for (let i = 1; i < d.override_log.length; i++) {
      expect(d.override_log[i - 1]!.ts >= d.override_log[i]!.ts).toBe(true);
    }
    for (const o of d.override_log) {
      expect(['underwriting', 'claim', 'payout', 'kyc']).toContain(o.resource_type);
    }
  });
});

describe('GET /v1/dashboards/bil/operational', () => {
  const TH = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

  test('admin gets the enveloped ops dashboard', async () => {
    const { app } = makeBilApp();
    const r = await request(app).get('/v1/dashboards/bil/operational').set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.uw_delay_breakdown).toHaveLength(5);
    expect(r.body.body.login_anomalies).toHaveLength(7);
    expect(r.body.body.override_log).toHaveLength(8);
  });

  test('non-admin → 403', async () => {
    const { app } = makeBilApp('field_officer');
    const r = await request(app).get('/v1/dashboards/bil/operational').set(TH);
    expect(r.status).toBe(403);
  });
});
