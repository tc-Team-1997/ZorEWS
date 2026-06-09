// @ts-nocheck
// __tests__/investigation_checklist_analytics.test.ts
// T6 M9.21 — Investigation checklist completion analytics

import request from 'supertest';
import {
  buildInvestigationChecklistAnalytics,
} from '../src/investigation_checklist_analytics';
import {
  InMemoryCaseInvestigationStore,
  defaultSteps,
} from '../src/case_investigation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-08T12:00:00Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeChecklistApp(role = 'admin', invStore) {
  const store = invStore ?? new InMemoryCaseInvestigationStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    caseInvestigationStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, invStore: store };
}

function makeFakeInvestigation(overrides = {}) {
  return {
    investigation_id: `inv-${Math.random().toString(36).slice(2)}`,
    tenant_id: 'BIL',
    case_id: 'case-1',
    customer_id: 'cust-1',
    status: 'triage',
    decision: null,
    opened_at: NOW.toISOString(),
    opened_by: 'alice',
    last_updated_at: NOW.toISOString(),
    last_updated_by: 'alice',
    closed_at: null,
    notes_count: 0,
    checklist_template_id: 'BUILT_IN',
    steps: defaultSteps(),
    ...overrides,
  };
}

// ─── Pure function tests ───────────────────────────────────────────────

describe('buildInvestigationChecklistAnalytics — M9.21', () => {
  it('empty investigations → null rates, empty steps', () => {
    const result = buildInvestigationChecklistAnalytics('BIL', [], NOW);
    expect(result.total_investigations).toBe(0);
    expect(result.steps).toHaveLength(0);
    expect(result.best_completed_step).toBeNull();
    expect(result.worst_completed_step).toBeNull();
    expect(result.overall_checklist_completion_rate).toBeNull();
  });

  it('single investigation with all steps pending → 0% rate per step', () => {
    const inv = makeFakeInvestigation();
    const result = buildInvestigationChecklistAnalytics('BIL', [inv], NOW);
    expect(result.total_investigations).toBe(1);
    expect(result.steps.length).toBeGreaterThan(0);
    for (const step of result.steps) {
      expect(step.completion_rate).toBe(0);
      expect(step.completed_count).toBe(0);
      expect(step.never_completed_count).toBe(1);
    }
  });

  it('all steps completed → 1.0 completion rate', () => {
    const completedSteps = defaultSteps().map((s) => ({
      ...s,
      completed: true,
      completed_at: NOW.toISOString(),
      completed_by: 'alice',
    }));
    const inv = makeFakeInvestigation({ steps: completedSteps });
    const result = buildInvestigationChecklistAnalytics('BIL', [inv], NOW);
    expect(result.overall_checklist_completion_rate).toBeCloseTo(1.0, 5);
  });

  it('steps sorted by completion_rate desc', () => {
    // 2 investigations, only first step completed in both
    const steps1 = defaultSteps().map((s, i) => ({
      ...s,
      completed: i === 0,
      completed_at: i === 0 ? NOW.toISOString() : null,
      completed_by: i === 0 ? 'alice' : null,
    }));
    const inv = makeFakeInvestigation({ steps: steps1 });
    const result = buildInvestigationChecklistAnalytics('BIL', [inv], NOW);
    for (let i = 1; i < result.steps.length; i++) {
      expect(result.steps[i - 1].completion_rate).toBeGreaterThanOrEqual(
        result.steps[i].completion_rate,
      );
    }
  });

  it('best_completed_step has highest rate', () => {
    const steps = defaultSteps().map((s, i) => ({
      ...s,
      completed: i === 0,
      completed_at: i === 0 ? NOW.toISOString() : null,
      completed_by: i === 0 ? 'alice' : null,
    }));
    const inv = makeFakeInvestigation({ steps });
    const result = buildInvestigationChecklistAnalytics('BIL', [inv], NOW);
    const best = result.steps[0];
    expect(result.best_completed_step).toBe(best.step_id);
  });

  it('worst_completed_step has lowest rate', () => {
    const steps = defaultSteps().map((s, i) => ({
      ...s,
      completed: i === 0,
      completed_at: i === 0 ? NOW.toISOString() : null,
      completed_by: i === 0 ? 'alice' : null,
    }));
    const inv = makeFakeInvestigation({ steps });
    const result = buildInvestigationChecklistAnalytics('BIL', [inv], NOW);
    const worst = result.steps[result.steps.length - 1];
    expect(result.worst_completed_step).toBe(worst.step_id);
  });

  it('tenant_id and generated_at echoed', () => {
    const result = buildInvestigationChecklistAnalytics('BANK_DEMO', [], NOW);
    expect(result.tenant_id).toBe('BANK_DEMO');
    expect(result.generated_at).toBe(NOW.toISOString());
  });

  it('each step row has required fields', () => {
    const inv = makeFakeInvestigation();
    const result = buildInvestigationChecklistAnalytics('BIL', [inv], NOW);
    for (const step of result.steps) {
      expect(typeof step.step_id).toBe('string');
      expect(typeof step.total_investigations_with_step).toBe('number');
      expect(typeof step.completed_count).toBe('number');
      expect(typeof step.completion_rate).toBe('number');
      expect(typeof step.never_completed_count).toBe('number');
      expect(step.completed_count + step.never_completed_count).toBe(
        step.total_investigations_with_step,
      );
    }
  });
});

// ─── Route tests ───────────────────────────────────────────────────────

describe('GET /v1/investigations/checklist-analytics — M9.21 route', () => {
  it('admin GET → 200 with shape', async () => {
    const { app } = makeChecklistApp('admin');
    const res = await request(app)
      .get('/v1/investigations/checklist-analytics')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(typeof res.body.body.total_investigations).toBe('number');
    expect(Array.isArray(res.body.body.steps)).toBe(true);
  });

  it('after opening an investigation → steps array populated', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const { app } = makeChecklistApp('admin', store);
    store.open('BIL', { case_id: 'case-1', customer_id: 'cust-1' }, 'alice', NOW);
    const res = await request(app)
      .get('/v1/investigations/checklist-analytics')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.body.total_investigations).toBe(1);
    expect(res.body.body.steps.length).toBeGreaterThan(0);
  });

  it('unknown_role → 403', async () => {
    const { app } = makeChecklistApp('unknown_role');
    const res = await request(app)
      .get('/v1/investigations/checklist-analytics')
      .set(TH_BIL)
      .set('x-apex-role', 'unknown_role');
    expect(res.status).toBe(403);
  });

  it('no tenant header → 400', async () => {
    const { app } = makeChecklistApp('admin');
    const res = await request(app)
      .get('/v1/investigations/checklist-analytics')
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });
});
