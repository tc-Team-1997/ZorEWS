// @ts-nocheck
// services/bff/__tests__/investigation_evidence_score.test.ts
// T6 M9.24 — Investigation evidence sufficiency score

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryCaseInvestigationStore, defaultCaseInvestigationStore } from '../src/case_investigation';
import { computeInvestigationEvidenceScores } from '../src/investigation_evidence_score';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('computeInvestigationEvidenceScores()', () => {
  test('empty store returns zero analyzed', () => {
    const store = new InMemoryCaseInvestigationStore();
    const result = computeInvestigationEvidenceScores('BIL', store, NOW);
    expect(result.total_analyzed).toBe(0);
    expect(result.scores).toHaveLength(0);
    expect(result.avg_score).toBe(0);
  });

  test('grade_distribution has all 5 grade keys', () => {
    const store = new InMemoryCaseInvestigationStore();
    const result = computeInvestigationEvidenceScores('BIL', store, NOW);
    expect(result.grade_distribution).toHaveProperty('A');
    expect(result.grade_distribution).toHaveProperty('B');
    expect(result.grade_distribution).toHaveProperty('C');
    expect(result.grade_distribution).toHaveProperty('D');
    expect(result.grade_distribution).toHaveProperty('F');
  });

  test('open investigation with no steps or notes gets F grade', () => {
    const store = new InMemoryCaseInvestigationStore();
    store.open('BIL', {
      case_id: 'case-001',
      customer_id: 'c-001',
      steps_override: [], // no steps
    }, 'alice', NOW);
    const result = computeInvestigationEvidenceScores('BIL', store, NOW);
    expect(result.total_analyzed).toBe(1);
    expect(result.scores[0].grade).toBe('F');
    expect(result.scores[0].score).toBe(0);
  });

  test('closed investigation is excluded', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', {
      case_id: 'case-002',
      customer_id: 'c-002',
    }, 'alice', NOW);
    store.updateStatus('BIL', inv.investigation_id, 'closed', 'fraud_confirmed', 'alice', NOW);
    const result = computeInvestigationEvidenceScores('BIL', store, NOW);
    expect(result.total_analyzed).toBe(0);
  });

  test('notes increase the score', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', {
      case_id: 'case-003',
      customer_id: 'c-003',
      steps_override: [],
    }, 'alice', NOW);
    store.addNote('BIL', inv.investigation_id, 'alice', 'Note 1', NOW);
    store.addNote('BIL', inv.investigation_id, 'alice', 'Note 2', NOW);
    const result = computeInvestigationEvidenceScores('BIL', store, NOW);
    expect(result.scores[0].notes_contribution).toBeGreaterThan(0);
  });

  test('scores sorted asc (lowest first)', () => {
    const store = new InMemoryCaseInvestigationStore();
    store.open('BIL', { case_id: 'c1', customer_id: 'c-001', steps_override: [] }, 'alice', NOW);
    store.open('BIL', { case_id: 'c2', customer_id: 'c-002', steps_override: [] }, 'alice', NOW);
    const result = computeInvestigationEvidenceScores('BIL', store, NOW);
    for (let i = 1; i < result.scores.length; i++) {
      expect(result.scores[i - 1].score).toBeLessThanOrEqual(result.scores[i].score);
    }
  });

  test('investigations_needing_attention counts score < 40', () => {
    const store = new InMemoryCaseInvestigationStore();
    store.open('BIL', { case_id: 'c1', customer_id: 'c-001', steps_override: [] }, 'alice', NOW);
    const result = computeInvestigationEvidenceScores('BIL', store, NOW);
    expect(result.investigations_needing_attention).toBe(result.scores.filter((s) => s.score < 40).length);
  });

  test('tenant isolation', () => {
    const store = new InMemoryCaseInvestigationStore();
    store.open('BANK_DEMO', { case_id: 'c1', customer_id: 'c-001', steps_override: [] }, 'alice', NOW);
    const result = computeInvestigationEvidenceScores('BIL', store, NOW);
    expect(result.total_analyzed).toBe(0);
  });
});

describe('GET /v1/investigations/evidence-scores', () => {
  test('admin returns 200 with scores array', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/investigations/evidence-scores')
      .set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('scores');
    expect(res.body.body).toHaveProperty('grade_distribution');
    expect(res.body.body).toHaveProperty('investigations_needing_attention');
  });

  test('non-admin returns 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/investigations/evidence-scores')
      .set(TH);
    expect(res.status).toBe(403);
  });

  test('missing tenant header returns 400', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/investigations/evidence-scores')
      .set('X-Channel', 'API');
    expect(res.status).toBe(400);
  });
});
