// @ts-nocheck
// services/bff/__tests__/adapter_circuit_breaker_status.test.ts
// T6 M14.36 — Adapter circuit breaker status tests

import { buildAdapterCircuitBreakerStatus } from '../src/adapter_circuit_breaker_status';
import { listFleetAdapters } from '../src/adapter_health';

const NOW = new Date('2026-05-22T12:00:00.000Z');

describe('buildAdapterCircuitBreakerStatus — pure resolver', () => {
  test('returns envelope shape with all required fields', () => {
    const r = buildAdapterCircuitBreakerStatus('BANK_DEMO', NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(Array.isArray(r.adapters)).toBe(true);
    expect(typeof r.open_count).toBe('number');
    expect(typeof r.half_open_count).toBe('number');
    expect(typeof r.closed_count).toBe('number');
    expect(typeof r.all_healthy).toBe('boolean');
  });

  test('total adapters = listFleetAdapters().length', () => {
    const r = buildAdapterCircuitBreakerStatus('BANK_DEMO', NOW);
    expect(r.adapters.length).toBe(listFleetAdapters().length);
  });

  test('each adapter has required fields', () => {
    const r = buildAdapterCircuitBreakerStatus('BANK_DEMO', NOW);
    for (const a of r.adapters) {
      expect(typeof a.adapter_id).toBe('string');
      expect(typeof a.label).toBe('string');
      expect(typeof a.state).toBe('string');
      expect(['closed', 'half_open', 'open']).toContain(a.state);
      expect(typeof a.failure_count).toBe('number');
    }
  });

  test('all_healthy = true when open_count = 0', () => {
    const r = buildAdapterCircuitBreakerStatus('BANK_DEMO', NOW);
    expect(r.all_healthy).toBe(r.open_count === 0);
  });

  test('counts sum = total adapters', () => {
    const r = buildAdapterCircuitBreakerStatus('BANK_DEMO', NOW);
    expect(r.open_count + r.half_open_count + r.closed_count).toBe(r.adapters.length);
  });

  test('sort order: open first, then half_open, then closed', () => {
    const r = buildAdapterCircuitBreakerStatus('BANK_DEMO', NOW);
    const stateOrder = ['open', 'half_open', 'closed'];
    for (let i = 1; i < r.adapters.length; i++) {
      const prev = stateOrder.indexOf(r.adapters[i - 1].state);
      const curr = stateOrder.indexOf(r.adapters[i].state);
      expect(prev).toBeLessThanOrEqual(curr);
    }
  });

  test('deterministic: same (tenant, day) → same states', () => {
    const r1 = buildAdapterCircuitBreakerStatus('BANK_DEMO', NOW);
    const r2 = buildAdapterCircuitBreakerStatus('BANK_DEMO', NOW);
    expect(r1.open_count).toBe(r2.open_count);
    expect(r1.closed_count).toBe(r2.closed_count);
  });

  test('closed adapter → last_failure_at=null, recovery_timeout=null', () => {
    const r = buildAdapterCircuitBreakerStatus('BANK_DEMO', NOW);
    for (const a of r.adapters) {
      if (a.state === 'closed') {
        expect(a.last_failure_at).toBeNull();
        expect(a.recovery_timeout_seconds).toBeNull();
      }
    }
  });

  test('open/half_open adapters have last_failure_at set', () => {
    const r = buildAdapterCircuitBreakerStatus('BANK_DEMO', NOW);
    for (const a of r.adapters) {
      if (a.state === 'open' || a.state === 'half_open') {
        expect(a.last_failure_at).not.toBeNull();
        expect(typeof a.recovery_timeout_seconds).toBe('number');
      }
    }
  });

  test('throws on empty tenant_id', () => {
    expect(() => buildAdapterCircuitBreakerStatus('', NOW)).toThrow();
  });
});

// ─── Route tests ──────────────────────────────────────────────────────

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BANK_DEMO',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

describe('GET /v1/integrations/adapters/circuit-breaker-status', () => {
  test('admin 200 with envelope', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/integrations/adapters/circuit-breaker-status')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(Array.isArray(r.body.body.adapters)).toBe(true);
    expect(typeof r.body.body.all_healthy).toBe('boolean');
  });

  test('403 for field_officer', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/integrations/adapters/circuit-breaker-status')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/integrations/adapters/circuit-breaker-status')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
  });

  test('tenant_id echoed in response', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/integrations/adapters/circuit-breaker-status')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BIL' });
    expect(r.body.body.tenant_id).toBe('BIL');
  });
});
