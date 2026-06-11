// @ts-nocheck
// T6 M9.29 — Investigation evidence collection rate tests.

import request from 'supertest';
import { buildInvestigationEvidenceRate } from '../src/investigation_evidence_rate';
import { InMemoryCaseInvestigationStore } from '../src/case_investigation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeTestApp(role = 'admin', caseInvestigationStore?) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    caseInvestigationStore,
  });
  return { app };
}

describe('M9.29 — buildInvestigationEvidenceRate pure', () => {
  test('empty store returns zero counts', () => {
    const store = new InMemoryCaseInvestigationStore();
    const result = buildInvestigationEvidenceRate('BIL', NOW, store);
    expect(result.total_open).toBe(0);
    expect(result.well_evidenced_count).toBe(0);
    expect(result.partial_count).toBe(0);
    expect(result.sparse_count).toBe(0);
    expect(result.avg_evidence_rate).toBe(0);
    expect(result.investigations_needing_attention).toHaveLength(0);
    expect(result.collection_health).toBe('weak');
  });

  test('open investigation with no evidence links is sparse', () => {
    const store = new InMemoryCaseInvestigationStore();
    store.open('BIL', { case_id: 'c-001', customer_id: 'cust-1' }, 'alice', NOW);
    const result = buildInvestigationEvidenceRate('BIL', NOW, store);
    expect(result.total_open).toBe(1);
    expect(result.sparse_count).toBe(1);
    expect(result.investigations_needing_attention).toHaveLength(1);
  });

  test('closed investigations not counted as open', () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'c-001', customer_id: 'cust-1' }, 'alice', NOW);
    store.updateStatus('BIL', inv.investigation_id, 'closed', null, 'alice', NOW);
    const result = buildInvestigationEvidenceRate('BIL', NOW, store);
    expect(result.total_open).toBe(0);
  });

  test('collection_health is weak/fair/strong based on avg rate', () => {
    const store = new InMemoryCaseInvestigationStore();
    const result = buildInvestigationEvidenceRate('BIL', NOW, store);
    expect(['strong', 'fair', 'weak']).toContain(result.collection_health);
  });

  test('throws on empty tenant_id', () => {
    const store = new InMemoryCaseInvestigationStore();
    expect(() => buildInvestigationEvidenceRate('', NOW, store)).toThrow();
  });
});

describe('M9.29 — GET /v1/investigations/evidence-collection-rate route', () => {
  test('admin returns 200', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/investigations/evidence-collection-rate')
      .set(TH);
    expect(res.status).toBe(200);
    expect(typeof res.body.body.total_open).toBe('number');
    expect(['strong', 'fair', 'weak']).toContain(res.body.body.collection_health);
  });

  test('field_officer returns 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/investigations/evidence-collection-rate')
      .set(TH);
    expect(res.status).toBe(403);
  });

  test('cross-tenant isolation', async () => {
    const store = new InMemoryCaseInvestigationStore();
    store.open('BIL', { case_id: 'c-001', customer_id: 'cust-1' }, 'alice', NOW);
    const { app } = makeTestApp('admin', store);
    const res = await request(app)
      .get('/v1/investigations/evidence-collection-rate')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' });
    expect(res.status).toBe(200);
    expect(res.body.body.total_open).toBe(0);
  });
});
