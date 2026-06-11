// @ts-nocheck
// services/bff/__tests__/investigation_outcome_confidence.test.ts
// T6 M9.23 — Investigation outcome prediction confidence.

import request from 'supertest';
import { buildInvestigationOutcomeConfidence } from '../src/investigation_outcome_confidence';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryCaseInvestigationStore } from '../src/case_investigation';

const NOW = new Date('2026-06-11T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function fakeApp(role = 'admin', store = undefined) {
  const invStore = store ?? new InMemoryCaseInvestigationStore();
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    caseInvestigationStore: invStore,
    getRole: () => role,
    now: () => NOW,
  });
  return { app, invStore };
}

function makeClosedInv(overrides = {}) {
  return {
    investigation_id: `inv-${Math.random().toString(36).slice(2)}`,
    tenant_id: 'BIL',
    case_id: 'c-001',
    customer_id: 'cust-1',
    status: 'closed',
    decision: 'fraud_confirmed',
    opened_at: '2026-06-01T00:00:00.000Z',
    opened_by: 'alice',
    last_updated_at: '2026-06-11T00:00:00.000Z',
    last_updated_by: 'alice',
    closed_at: '2026-06-11T00:00:00.000Z',
    steps: [],
    notes_count: 0,
    checklist_template_id: 'BUILT_IN',
    ...overrides,
  };
}

// ─── Pure function tests ────────────────────────────────────────────────

describe('M9.23 — buildInvestigationOutcomeConfidence — empty', () => {
  test('no investigations → empty results', () => {
    const out = buildInvestigationOutcomeConfidence('BIL', [], NOW);
    expect(out.tenant_id).toBe('BIL');
    expect(out.total_templates).toBe(0);
    expect(out.results).toHaveLength(0);
  });
});

describe('M9.23 — buildInvestigationOutcomeConfidence — basic', () => {
  test('single closed with decision → confidence_score > 0', () => {
    const inv = makeClosedInv({ decision: 'fraud_confirmed' });
    const out = buildInvestigationOutcomeConfidence('BIL', [inv], NOW);
    expect(out.total_templates).toBe(1);
    const row = out.results[0];
    expect(row.template_id).toBe('BUILT_IN');
    expect(row.decision_rate).toBe(1);
    expect(row.sample_size).toBe(1);
    expect(row.confidence_score).toBeGreaterThan(0);
    expect(row.most_common_decision).toBe('fraud_confirmed');
  });

  test('open investigations excluded', () => {
    const inv = makeClosedInv({ status: 'triage', decision: null });
    const out = buildInvestigationOutcomeConfidence('BIL', [inv], NOW);
    expect(out.total_templates).toBe(0);
  });

  test('closed without decision → decision_rate=0', () => {
    const inv = makeClosedInv({ decision: null });
    const out = buildInvestigationOutcomeConfidence('BIL', [inv], NOW);
    expect(out.results[0].decision_rate).toBe(0);
    expect(out.results[0].most_common_decision).toBeNull();
  });

  test('multiple templates sorted by confidence_score desc', () => {
    const tpl1 = makeClosedInv({ checklist_template_id: 'TPL-A', decision: 'fraud_confirmed' });
    const tpl2 = makeClosedInv({ checklist_template_id: 'TPL-B', decision: null });
    const out = buildInvestigationOutcomeConfidence('BIL', [tpl1, tpl2], NOW);
    expect(out.results[0].template_id).toBe('TPL-A');
    expect(out.results[0].confidence_score).toBeGreaterThan(out.results[1].confidence_score);
  });

  test('confidence_score formula: sample_size cap at 20', () => {
    const invs = Array.from({ length: 25 }, (_, i) =>
      makeClosedInv({ investigation_id: `inv-${i}`, decision: 'fraud_confirmed' }),
    );
    const out = buildInvestigationOutcomeConfidence('BIL', invs, NOW);
    const row = out.results[0];
    // decision_rate=1, sample_size=25 → min(100, round(1*60 + min(25,20)*2)) = min(100, 100) = 100
    expect(row.confidence_score).toBe(100);
    expect(row.sample_size).toBe(25);
  });

  test('generated_at matches NOW', () => {
    const out = buildInvestigationOutcomeConfidence('BIL', [], NOW);
    expect(out.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ────────────────────────────────────────────────────────

describe('M9.23 — route GET /v1/investigations/outcome-confidence', () => {
  test('admin → 200 with envelope', async () => {
    const { app } = fakeApp('admin');
    const res = await request(app).get('/v1/investigations/outcome-confidence').set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('total_templates');
    expect(Array.isArray(res.body.body.results)).toBe(true);
  });

  test('case_owner → 403', async () => {
    const { app } = fakeApp('case_owner');
    const res = await request(app).get('/v1/investigations/outcome-confidence').set(TH);
    expect(res.status).toBe(403);
  });

  test('no tenant header → 400', async () => {
    const { app } = fakeApp('admin');
    const res = await request(app).get('/v1/investigations/outcome-confidence');
    expect(res.status).toBe(400);
  });
});
