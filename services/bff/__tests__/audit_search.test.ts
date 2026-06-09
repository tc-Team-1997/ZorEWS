// __tests__/audit_search.test.ts
// T6 M15.21 — Audit event full-text search

import request from 'supertest';
import {
  searchAuditEvents,
  AuditSearchError,
} from '../src/audit_search';
import {
  InMemoryAuditTrailStore,
  type AuditEventInput,
} from '../src/audit_trail';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-06-08T12:00:00Z');
const TENANT = 'BIL';
const TH_BIL = { 'X-Tenant-ID': TENANT, 'X-Channel': 'API' };

function makeAuditApp(role = 'admin', store?: InMemoryAuditTrailStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    auditTrailStore: store ?? new InMemoryAuditTrailStore(),
  });
}

function makeEvent(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    actor_username: 'alice',
    actor_role: 'admin',
    action: 'config.update',
    resource_type: 'config',
    resource_id: 'key1',
    outcome: 'success',
    ip_address: '127.0.0.1',
    ...overrides,
  };
}

describe('searchAuditEvents — M15.21', () => {
  it('empty events → 0 matches', () => {
    const result = searchAuditEvents(TENANT, [], 'alice', 50);
    expect(result.tenant_id).toBe(TENANT);
    expect(result.match_count).toBe(0);
    expect(result.total_events_scanned).toBe(0);
    expect(result.results).toHaveLength(0);
    expect(result.limited).toBe(false);
  });

  it('query too short → AuditSearchError invalid_query', () => {
    expect(() => searchAuditEvents(TENANT, [], 'a', 50)).toThrow(AuditSearchError);
  });

  it('blank query → AuditSearchError invalid_query', () => {
    expect(() => searchAuditEvents(TENANT, [], '', 50)).toThrow(AuditSearchError);
  });

  it('query too long → AuditSearchError invalid_query', () => {
    const longQuery = 'a'.repeat(201);
    expect(() => searchAuditEvents(TENANT, [], longQuery, 50)).toThrow(AuditSearchError);
  });

  it('invalid limit → AuditSearchError invalid_limit', () => {
    expect(() => searchAuditEvents(TENANT, [], 'alice', 0)).toThrow(AuditSearchError);
    expect(() => searchAuditEvents(TENANT, [], 'alice', 201)).toThrow(AuditSearchError);
  });

  it('matches actor_username case-insensitively', () => {
    const store = new InMemoryAuditTrailStore();
    store.record(TENANT, makeEvent({ actor_username: 'Alice.Admin' }), NOW);
    const events = store.list(TENANT, {}).items;
    const result = searchAuditEvents(TENANT, events, 'alice.admin', 50);
    expect(result.match_count).toBe(1);
    expect(result.results[0]!.match_fields).toContain('actor_username');
  });

  it('matches action field', () => {
    const store = new InMemoryAuditTrailStore();
    store.record(TENANT, makeEvent({ action: 'scenario.run', resource_type: 'scenario', resource_id: 'sc-001' }), NOW);
    const events = store.list(TENANT, {}).items;
    const result = searchAuditEvents(TENANT, events, 'scenario', 50);
    expect(result.match_count).toBe(1);
    expect(result.results[0]!.match_fields).toContain('action');
  });

  it('matches resource_id field', () => {
    const store = new InMemoryAuditTrailStore();
    store.record(TENANT, makeEvent({ action: 'case.close', resource_type: 'case', resource_id: 'CASE-XYZ-999' }), NOW);
    const events = store.list(TENANT, {}).items;
    const result = searchAuditEvents(TENANT, events, 'CASE-XYZ-999', 50);
    expect(result.match_count).toBe(1);
    expect(result.results[0]!.match_fields).toContain('resource_id');
  });

  it('no-match query → 0 results', () => {
    const store = new InMemoryAuditTrailStore();
    store.record(TENANT, makeEvent(), NOW);
    const events = store.list(TENANT, {}).items;
    const result = searchAuditEvents(TENANT, events, 'zzznomatch', 50);
    expect(result.match_count).toBe(0);
  });

  it('results sorted newest-first', () => {
    const store = new InMemoryAuditTrailStore();
    const t1 = new Date('2026-01-01T00:00:00Z');
    const t2 = new Date('2026-06-01T00:00:00Z');
    store.record(TENANT, makeEvent({ actor_username: 'admin-user', resource_id: 'key1' }), t1);
    store.record(TENANT, makeEvent({ actor_username: 'admin-user', resource_id: 'key2' }), t2);
    const events = store.list(TENANT, {}).items;
    const result = searchAuditEvents(TENANT, events, 'admin-user', 50);
    expect(result.match_count).toBe(2);
    const ts0 = new Date(result.results[0]!.ts).getTime();
    const ts1 = new Date(result.results[1]!.ts).getTime();
    expect(ts0).toBeGreaterThanOrEqual(ts1);
  });

  it('limited flag set when matches exceed limit', () => {
    const store = new InMemoryAuditTrailStore();
    for (let i = 0; i < 10; i++) {
      store.record(
        TENANT,
        makeEvent({ actor_username: 'searchable-user', resource_id: `key-${i}` }),
        new Date(NOW.getTime() - i * 1000),
      );
    }
    const events = store.list(TENANT, { page_size: 1000 }).items;
    const result = searchAuditEvents(TENANT, events, 'searchable-user', 5);
    expect(result.limited).toBe(true);
    expect(result.results).toHaveLength(5);
    expect(result.match_count).toBeGreaterThan(5);
  });

  it('admin route GET /v1/audit/search?q=admin → 200', async () => {
    const { app } = makeAuditApp('admin');
    const res = await request(app)
      .get('/v1/audit/search?q=admin')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(200);
    expect(typeof res.body.body.match_count).toBe('number');
    expect(Array.isArray(res.body.body.results)).toBe(true);
  });

  it('missing q param → 400', async () => {
    const { app } = makeAuditApp('admin');
    const res = await request(app)
      .get('/v1/audit/search')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });

  it('q=a (too short) → 400', async () => {
    const { app } = makeAuditApp('admin');
    const res = await request(app)
      .get('/v1/audit/search?q=a')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    expect(res.status).toBe(400);
  });

  it('non-admin role → 403', async () => {
    const { app } = makeAuditApp('field_officer');
    const res = await request(app)
      .get('/v1/audit/search?q=admin')
      .set(TH_BIL)
      .set('x-apex-role', 'field_officer');
    expect(res.status).toBe(403);
  });

  it('cross-tenant invisibility', async () => {
    const store = new InMemoryAuditTrailStore();
    store.record('BIL', makeEvent({ actor_username: 'bil-user' }), NOW);
    const { app } = makeAuditApp('admin', store);
    const resBil = await request(app)
      .get('/v1/audit/search?q=bil-user')
      .set(TH_BIL)
      .set('x-apex-role', 'admin');
    const resBank = await request(app)
      .get('/v1/audit/search?q=bil-user')
      .set({ 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' })
      .set('x-apex-role', 'admin');
    expect(resBil.status).toBe(200);
    expect(resBil.body.body.match_count).toBe(1);
    expect(resBank.status).toBe(200);
    expect(resBank.body.body.match_count).toBe(0);
  });
});
