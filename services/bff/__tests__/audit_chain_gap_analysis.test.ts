// @ts-nocheck
// services/bff/__tests__/audit_chain_gap_analysis.test.ts
// T6 M15.26 — Audit chain gap analysis tests

import { buildAuditChainGapAnalysis } from '../src/audit_chain_gap_analysis';
import { InMemoryAuditTrailStore } from '../src/audit_trail';

const NOW = new Date('2026-05-22T12:00:00.000Z');

function addEvent(store, tenant_id, ts) {
  store.record(tenant_id, {
    actor_username: 'alice',
    actor_role: 'admin',
    action: 'config.update',
    resource_type: 'config',
    resource_id: 'alerts.red_sla_hours',
    outcome: 'success',
    severity: 'info',
  }, new Date(ts));
}

describe('buildAuditChainGapAnalysis — pure resolver', () => {
  test('empty store → 0 events, 0 gaps, good coverage', () => {
    const store = new InMemoryAuditTrailStore();
    const r = buildAuditChainGapAnalysis(store, 'BANK_DEMO', NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.total_events).toBe(0);
    expect(r.gaps).toEqual([]);
    expect(r.largest_gap_hours).toBe(0);
    expect(r.coverage_health).toBe('good');
  });

  test('events within 1h → no gaps detected', () => {
    const store = new InMemoryAuditTrailStore();
    const t1 = '2026-05-22T10:00:00.000Z';
    const t2 = '2026-05-22T10:30:00.000Z';
    addEvent(store, 'BANK_DEMO', t1);
    addEvent(store, 'BANK_DEMO', t2);
    const r = buildAuditChainGapAnalysis(store, 'BANK_DEMO', NOW);
    expect(r.gaps).toHaveLength(0);
  });

  test('gap > 1h detected with correct gap_hours', () => {
    const store = new InMemoryAuditTrailStore();
    const t1 = '2026-05-22T08:00:00.000Z';
    const t2 = '2026-05-22T12:00:00.000Z'; // 4h gap
    addEvent(store, 'BANK_DEMO', t1);
    addEvent(store, 'BANK_DEMO', t2);
    const r = buildAuditChainGapAnalysis(store, 'BANK_DEMO', NOW);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0].gap_hours).toBe(4);
    expect(r.gaps[0].gap_type).toBe('medium');
  });

  test('gap_type: short(<4h), medium(4-24h), long(>24h)', () => {
    const gapType = (h) => {
      if (h < 4) return 'short';
      if (h <= 24) return 'medium';
      return 'long';
    };
    expect(gapType(1)).toBe('short');
    expect(gapType(4)).toBe('medium');
    expect(gapType(25)).toBe('long');
  });

  test('largest_gap_hours = max gap', () => {
    const store = new InMemoryAuditTrailStore();
    addEvent(store, 'BANK_DEMO', '2026-05-20T00:00:00.000Z');
    addEvent(store, 'BANK_DEMO', '2026-05-21T00:00:00.000Z'); // 24h gap
    addEvent(store, 'BANK_DEMO', '2026-05-21T04:00:00.000Z'); // 4h gap
    const r = buildAuditChainGapAnalysis(store, 'BANK_DEMO', NOW);
    expect(r.largest_gap_hours).toBe(24);
  });

  test('coverage_health: good(<3 gaps), fair(3-10), poor(>10)', () => {
    const coverage = (gaps) => {
      if (gaps < 3) return 'good';
      if (gaps <= 10) return 'fair';
      return 'poor';
    };
    expect(coverage(0)).toBe('good');
    expect(coverage(3)).toBe('fair');
    expect(coverage(11)).toBe('poor');
  });

  test('cross-tenant isolation: BIL events not visible to BANK_DEMO', () => {
    const store = new InMemoryAuditTrailStore();
    addEvent(store, 'BIL', '2026-05-22T10:00:00.000Z');
    const r = buildAuditChainGapAnalysis(store, 'BANK_DEMO', NOW);
    expect(r.total_events).toBe(0);
  });

  test('throws on empty tenant_id', () => {
    const store = new InMemoryAuditTrailStore();
    expect(() => buildAuditChainGapAnalysis(store, '', NOW)).toThrow();
  });
});

// ─── Route tests ──────────────────────────────────────────────────────

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BIL',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

describe('GET /v1/audit/chain-gap-analysis', () => {
  test('admin 200 with envelope', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/audit/chain-gap-analysis')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(Array.isArray(r.body.body.gaps)).toBe(true);
  });

  test('403 for field_officer', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/audit/chain-gap-analysis')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/audit/chain-gap-analysis')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
  });

  test('cross-tenant isolation', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/audit/chain-gap-analysis')
      .set(HEADERS_ADMIN);
    expect(r.body.body.tenant_id).toBe('BIL');
  });
});
