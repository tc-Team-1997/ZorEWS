// @ts-nocheck
// T6 M15.28 — Audit event metadata richness score.

import request from 'supertest';
import { buildAuditMetadataRichness } from '../src/audit_metadata_richness';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeRichnessApp(role = 'admin', store = new InMemoryAuditTrailStore()) {
  const { app } = makeApp({ source: new StaticSource([]), evaluator: new StubEvaluator(), riskProfile: new StubRiskProfileSource(), caseAction: new UnavailableCaseActionSink(), now: () => NOW, getRole: () => role, auditTrailStore: store });
  return app;
}

describe('M15.28 — empty store', () => {
  test('zero events → zero richness', () => {
    const store = new InMemoryAuditTrailStore();
    const out = buildAuditMetadataRichness('BIL', store, NOW);
    expect(out.total_events).toBe(0);
    expect(out.overall_avg_metadata_score).toBe(0);
    expect(out.richest_resource_type).toBeNull();
  });

  test('returns all 10 resource types', () => {
    const store = new InMemoryAuditTrailStore();
    const out = buildAuditMetadataRichness('BIL', store, NOW);
    expect(out.by_resource_type.length).toBe(10);
  });
});

describe('M15.28 — with events', () => {
  test('event with metadata counted correctly', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', { actor_username: 'alice', actor_role: 'admin', action: 'config.update', resource_type: 'config', resource_id: 'k1', outcome: 'success', metadata: { a: 1, b: 2, c: 3 } }, NOW);
    const out = buildAuditMetadataRichness('BIL', store, NOW);
    const configRow = out.by_resource_type.find((r) => r.resource_type === 'config');
    expect(configRow.avg_metadata_score).toBe(3);
    expect(configRow.events_with_metadata).toBe(1);
    expect(configRow.events_without_metadata).toBe(0);
  });

  test('richness_grade valid for all rows', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', { actor_username: 'alice', actor_role: 'admin', action: 'config.update', resource_type: 'config', resource_id: 'k1', outcome: 'success' }, NOW);
    const out = buildAuditMetadataRichness('BIL', store, NOW);
    for (const row of out.by_resource_type) {
      expect(['A', 'B', 'C', 'D']).toContain(row.richness_grade);
    }
  });

  test('by_resource_type sorted by avg_metadata_score desc', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', { actor_username: 'alice', actor_role: 'admin', action: 'config.update', resource_type: 'config', resource_id: 'k1', outcome: 'success', metadata: { a: 1, b: 2, c: 3, d: 4 } }, NOW);
    const out = buildAuditMetadataRichness('BIL', store, NOW);
    for (let i = 0; i < out.by_resource_type.length - 1; i++) {
      expect(out.by_resource_type[i].avg_metadata_score).toBeGreaterThanOrEqual(out.by_resource_type[i + 1].avg_metadata_score);
    }
  });

  test('richest_resource_type is type with highest avg', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', { actor_username: 'alice', actor_role: 'admin', action: 'config.update', resource_type: 'config', resource_id: 'k1', outcome: 'success', metadata: { a: 1, b: 2, c: 3 } }, NOW);
    const out = buildAuditMetadataRichness('BIL', store, NOW);
    expect(out.richest_resource_type).toBe('config');
  });

  test('cross-tenant isolation', () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', { actor_username: 'alice', actor_role: 'admin', action: 'config.update', resource_type: 'config', resource_id: 'k1', outcome: 'success', metadata: { a: 1 } }, NOW);
    const out = buildAuditMetadataRichness('BANK_DEMO', store, NOW);
    expect(out.total_events).toBe(0);
  });
});

describe('M15.28 — route', () => {
  test('admin GET /v1/audit/metadata-richness returns 200', async () => {
    const app = makeRichnessApp();
    const res = await request(app).get('/v1/audit/metadata-richness').set(TH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.body.by_resource_type)).toBe(true);
    expect(res.body.body.by_resource_type.length).toBe(10);
  });

  test('non-admin gets 403', async () => {
    const app = makeRichnessApp('field_officer');
    const res = await request(app).get('/v1/audit/metadata-richness').set(TH);
    expect(res.status).toBe(403);
  });
});
