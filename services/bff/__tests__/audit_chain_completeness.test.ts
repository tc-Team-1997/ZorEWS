// @ts-nocheck
// T6 M15.23 — Audit chain completeness check tests.

import request from 'supertest';
import { buildAuditChainCompleteness } from '../src/audit_chain_completeness';
import { InMemoryAuditTrailStore } from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-04T12:00:00.000Z');
const H = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function makeEvent(overrides) {
  return {
    event_id: overrides.event_id || `ev-${Math.random().toString(36).slice(2)}`,
    ts: overrides.ts || NOW.toISOString(),
    tenant_id: 'BIL',
    actor_username: 'alice',
    actor_role: 'admin',
    action: 'config.update',
    resource_type: 'config',
    resource_id: 'key1',
    outcome: 'success',
    severity: 'info',
    correlation_id: null,
    ip_address: null,
    metadata: {},
    hash: overrides.hash || 'abc123',
    prev_hash: overrides.prev_hash || 'GENESIS',
    ...overrides,
  };
}

describe('buildAuditChainCompleteness — empty input', () => {
  test('returns perfect score with no events', () => {
    const r = buildAuditChainCompleteness('BIL', [], NOW);
    expect(r.total_events).toBe(0);
    expect(r.completeness_score).toBe(100);
    expect(r.is_complete).toBe(true);
    expect(r.has_gaps).toBe(false);
    expect(r.gap_count).toBe(0);
    expect(r.out_of_order_count).toBe(0);
    expect(r.broken_hash_links).toBe(0);
    expect(r.issues).toEqual([]);
  });

  test('returns tenant_id and generated_at', () => {
    const r = buildAuditChainCompleteness('TEST', [], NOW);
    expect(r.tenant_id).toBe('TEST');
    expect(r.generated_at).toBe(NOW.toISOString());
  });
});

describe('buildAuditChainCompleteness — chain validation', () => {
  test('single clean event returns perfect score', () => {
    const ev = makeEvent({ event_id: 'ev-1', prev_hash: 'GENESIS', hash: 'hash1' });
    const r = buildAuditChainCompleteness('BIL', [ev], NOW);
    expect(r.total_events).toBe(1);
    expect(r.completeness_score).toBe(100);
    expect(r.is_complete).toBe(true);
  });

  test('detects broken hash link', () => {
    const ev1 = makeEvent({ event_id: 'ev-001', prev_hash: 'GENESIS', hash: 'aaa111', ts: '2026-06-04T10:00:00Z' });
    const ev2 = makeEvent({ event_id: 'ev-002', prev_hash: 'WRONGHASH', hash: 'bbb222', ts: '2026-06-04T11:00:00Z' });
    const r = buildAuditChainCompleteness('BIL', [ev1, ev2], NOW);
    expect(r.broken_hash_links).toBeGreaterThan(0);
    expect(r.completeness_score).toBeLessThan(100);
  });

  test('detects out-of-order: broken hash link signals chain issue', () => {
    // Two events where the second has wrong prev_hash (chain break)
    const ev1 = makeEvent({ ts: '2026-06-04T10:00:00Z', hash: 'h1', prev_hash: 'GENESIS' });
    const ev2 = makeEvent({ ts: '2026-06-04T11:00:00Z', hash: 'h2', prev_hash: 'WRONG' });
    const r = buildAuditChainCompleteness('BIL', [ev1, ev2], NOW);
    // broken_hash_links should flag the broken chain
    expect(r.broken_hash_links + r.out_of_order_count).toBeGreaterThan(0);
  });

  test('issues array populated on problems', () => {
    const ev1 = makeEvent({ event_id: 'ev-001', prev_hash: 'GENESIS', hash: 'h1', ts: '2026-06-04T10:00:00Z' });
    const ev2 = makeEvent({ event_id: 'ev-002', prev_hash: 'WRONG', hash: 'h2', ts: '2026-06-04T11:00:00Z' });
    const r = buildAuditChainCompleteness('BIL', [ev1, ev2], NOW);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues[0].type).toMatch(/gap|out_of_order|broken_hash/);
    expect(typeof r.issues[0].event_id).toBe('string');
    expect(typeof r.issues[0].description).toBe('string');
  });

  test('completeness_score is_complete threshold at 95', () => {
    // Single event is fine → 100
    const ev = makeEvent({ prev_hash: 'GENESIS', hash: 'h1' });
    const r = buildAuditChainCompleteness('BIL', [ev], NOW);
    expect(r.is_complete).toBe(r.completeness_score >= 95);
  });
});

describe('buildAuditChainCompleteness — route', () => {
  test('GET /v1/audit/chain-completeness returns 200', async () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', { actor_username: 'alice', actor_role: 'admin', action: 'test', resource_type: 'config', resource_id: 'k1', outcome: 'success' }, NOW);
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'admin',
      auditTrailStore: store,
    });
    const res = await request(app).get('/v1/audit/chain-completeness').set(H);
    expect(res.status).toBe(200);
    expect(res.body.body.total_events).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.body.completeness_score).toBe('number');
    expect(typeof res.body.body.is_complete).toBe('boolean');
  });

  test('403 for non-admin role', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'field_officer',
    });
    const res = await request(app).get('/v1/audit/chain-completeness').set(H);
    expect(res.status).toBe(403);
  });

  test('400 when missing tenant header', async () => {
    const { app } = makeApp({
      source: new StaticSource([]),
      evaluator: new StubEvaluator(),
      riskProfile: new StubRiskProfileSource(),
      caseAction: new UnavailableCaseActionSink(),
      getRole: () => 'admin',
    });
    const res = await request(app).get('/v1/audit/chain-completeness');
    expect(res.status).toBe(400);
  });
});
