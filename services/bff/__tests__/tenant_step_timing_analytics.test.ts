// @ts-nocheck
// __tests__/tenant_step_timing_analytics.test.ts
// T6 M2.21 — Tenant step timing analytics

import request from 'supertest';
import { buildTenantStepTimingAnalytics } from '../src/tenant_step_timing_analytics';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-09T14:00:00Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

function makeStep(step_id, overrides) {
  return {
    step_id,
    status: 'pending',
    completed_at: null,
    completed_by: null,
    notes: null,
    skip_reason: null,
    ...overrides,
  };
}

describe('buildTenantStepTimingAnalytics — M2.21', () => {
  it('empty fleet → all steps at 0, null leaderboards', () => {
    const result = buildTenantStepTimingAnalytics([], NOW);
    expect(result.total_tenants).toBe(0);
    expect(result.busiest_hour).toBeNull();
    expect(result.most_adopted_step).toBeNull();
    expect(result.steps.length).toBeGreaterThan(0);
    for (const s of result.steps) {
      expect(s.total_completed).toBe(0);
      expect(s.completion_rate).toBe(0);
      expect(s.avg_completion_hour_of_day).toBeNull();
    }
  });

  it('steps returned in canonical ONBOARDING_STEPS order', () => {
    const result = buildTenantStepTimingAnalytics([], NOW);
    const orders = result.steps.map(s => s.order);
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i] > orders[i - 1]).toBe(true);
    }
  });

  it('completed step increments total_completed and completion_rate', () => {
    const states = [
      {
        tenant_id: 'T1',
        steps: [
          makeStep('tenant_provisioned', {
            status: 'completed',
            completed_at: '2026-06-01T10:00:00Z',
            completed_by: 'alice',
          }),
          makeStep('channels_configured'),
        ],
      },
    ];
    const result = buildTenantStepTimingAnalytics(states, NOW);
    const provStep = result.steps.find(s => s.step_id === 'tenant_provisioned');
    expect(provStep.total_completed).toBe(1);
    expect(provStep.completion_rate).toBe(1);
    const chanStep = result.steps.find(s => s.step_id === 'channels_configured');
    expect(chanStep.total_completed).toBe(0);
    expect(chanStep.completion_rate).toBe(0);
  });

  it('avg_completion_hour_of_day computed from completed_at timestamps', () => {
    const states = [
      {
        tenant_id: 'T1',
        steps: [
          makeStep('tenant_provisioned', {
            status: 'completed',
            completed_at: '2026-06-01T10:00:00Z',
          }),
        ],
      },
      {
        tenant_id: 'T2',
        steps: [
          makeStep('tenant_provisioned', {
            status: 'completed',
            completed_at: '2026-06-01T14:00:00Z',
          }),
        ],
      },
    ];
    const result = buildTenantStepTimingAnalytics(states, NOW);
    const step = result.steps.find(s => s.step_id === 'tenant_provisioned');
    // avg of hour 10 and 14 = 12
    expect(step.avg_completion_hour_of_day).toBeCloseTo(12, 0);
  });

  it('busiest_hour is the UTC hour with the most completions', () => {
    const states = [
      {
        tenant_id: 'T1',
        steps: [
          makeStep('tenant_provisioned', {
            status: 'completed',
            completed_at: '2026-06-01T09:00:00Z',
          }),
          makeStep('channels_configured', {
            status: 'completed',
            completed_at: '2026-06-01T09:30:00Z',
          }),
        ],
      },
    ];
    const result = buildTenantStepTimingAnalytics(states, NOW);
    expect(result.busiest_hour).toBe(9);
  });

  it('most_adopted_step is the step with highest completion_rate', () => {
    const states = [
      {
        tenant_id: 'T1',
        steps: [
          makeStep('tenant_provisioned', {
            status: 'completed',
            completed_at: '2026-06-01T10:00:00Z',
          }),
        ],
      },
      {
        tenant_id: 'T2',
        steps: [
          makeStep('tenant_provisioned', {
            status: 'completed',
            completed_at: '2026-06-02T10:00:00Z',
          }),
        ],
      },
    ];
    const result = buildTenantStepTimingAnalytics(states, NOW);
    expect(result.most_adopted_step).toBe('tenant_provisioned');
  });

  it('pending/skipped steps do not count toward completed', () => {
    const states = [
      {
        tenant_id: 'T1',
        steps: [
          makeStep('tenant_provisioned', { status: 'skipped' }),
          makeStep('channels_configured', { status: 'pending' }),
        ],
      },
    ];
    const result = buildTenantStepTimingAnalytics(states, NOW);
    for (const s of result.steps) {
      expect(s.total_completed).toBe(0);
    }
  });

  it('fastest/slowest_completion_days derived from relative timing', () => {
    const states = [
      {
        tenant_id: 'T1',
        steps: [
          makeStep('tenant_provisioned', {
            status: 'completed',
            completed_at: '2026-06-01T10:00:00Z',
          }),
          makeStep('channels_configured', {
            status: 'completed',
            completed_at: '2026-06-03T10:00:00Z', // 2 days later
          }),
        ],
      },
    ];
    const result = buildTenantStepTimingAnalytics(states, NOW);
    const chanStep = result.steps.find(s => s.step_id === 'channels_configured');
    expect(chanStep.fastest_completion_days).toBeCloseTo(2, 0);
    expect(chanStep.slowest_completion_days).toBeCloseTo(2, 0);
  });

  it('admin route GET /v1/tenants/onboarding/step-timing → 200', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/tenants/onboarding/step-timing')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(typeof res.body.body.total_tenants).toBe('number');
    expect(Array.isArray(res.body.body.steps)).toBe(true);
  });

  it('non-admin → 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/tenants/onboarding/step-timing')
      .set(TH_BIL)
      .set('x-apex-role', 'field_officer');
    expect(res.status).toBe(403);
  });
});
