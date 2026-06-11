// @ts-nocheck
// services/bff/__tests__/api_key_state_transitions.test.ts
// T6 M1.23 — API key lifecycle state transitions

import request from 'supertest';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryApiKeyStore, defaultApiKeyStore } from '../src/api_keys';
import { computeApiKeyStateTransitions } from '../src/api_key_state_transitions';

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

describe('computeApiKeyStateTransitions()', () => {
  test('empty store returns zeroed state_counts', () => {
    const store = new InMemoryApiKeyStore();
    const result = computeApiKeyStateTransitions('BIL', store, NOW);
    expect(result.tenant_id).toBe('BIL');
    expect(result.total_keys).toBe(0);
    expect(result.state_counts.fresh).toBe(0);
    expect(result.state_counts.revoked).toBe(0);
    expect(result.state_counts.mature).toBe(0);
    expect(result.state_counts.dormant).toBe(0);
    expect(result.state_counts.expiring_soon).toBe(0);
    expect(result.state_counts.expired).toBe(0);
  });

  test('fresh key created today is classified as fresh', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'test', scopes: ['alerts:read'] }, 'alice', NOW);
    const result = computeApiKeyStateTransitions('BIL', store, NOW);
    expect(result.state_counts.fresh).toBeGreaterThanOrEqual(1);
    expect(result.total_keys).toBe(1);
  });

  test('revoked key is classified as revoked', () => {
    const store = new InMemoryApiKeyStore();
    const created = store.create('BIL', { name: 'k1', scopes: ['cases:read'] }, 'alice', NOW);
    store.revoke('BIL', created.key_id, 'alice', NOW);
    const result = computeApiKeyStateTransitions('BIL', store, NOW);
    expect(result.state_counts.revoked).toBe(1);
  });

  test('transition_matrix is an object with expected keys', () => {
    const store = new InMemoryApiKeyStore();
    const result = computeApiKeyStateTransitions('BIL', store, NOW);
    expect(result.transition_matrix).toHaveProperty('fresh_to_mature');
    expect(result.transition_matrix).toHaveProperty('mature_to_dormant');
    expect(result.transition_matrix).toHaveProperty('active_to_revoked');
    expect(result.transition_matrix).toHaveProperty('expiring_to_expired');
  });

  test('transition_summary is a non-empty string', () => {
    const store = new InMemoryApiKeyStore();
    const result = computeApiKeyStateTransitions('BIL', store, NOW);
    expect(typeof result.transition_summary).toBe('string');
    expect(result.transition_summary.length).toBeGreaterThan(0);
  });

  test('tenant isolation — BANK_DEMO keys not visible to BIL', () => {
    const store = new InMemoryApiKeyStore();
    store.create('BANK_DEMO', { name: 'k1', scopes: ['alerts:read'] }, 'alice', NOW);
    const result = computeApiKeyStateTransitions('BIL', store, NOW);
    expect(result.total_keys).toBe(0);
  });

  test('generated_at matches now', () => {
    const store = new InMemoryApiKeyStore();
    const result = computeApiKeyStateTransitions('BIL', store, NOW);
    expect(result.generated_at).toBe(NOW.toISOString());
  });
});

describe('GET /v1/admin/api-keys/state-transitions', () => {
  test('admin returns 200 with state_counts', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/admin/api-keys/state-transitions')
      .set(TH);
    expect(res.status).toBe(200);
    expect(res.body.body).toHaveProperty('state_counts');
    expect(res.body.body).toHaveProperty('transition_matrix');
    expect(res.body.body).toHaveProperty('transition_summary');
  });

  test('non-admin returns 403', async () => {
    const { app } = makeTestApp('field_officer');
    const res = await request(app)
      .get('/v1/admin/api-keys/state-transitions')
      .set(TH);
    expect(res.status).toBe(403);
  });

  test('missing tenant header returns 400', async () => {
    const { app } = makeTestApp('admin');
    const res = await request(app)
      .get('/v1/admin/api-keys/state-transitions')
      .set('X-Channel', 'API');
    expect(res.status).toBe(400);
  });
});
