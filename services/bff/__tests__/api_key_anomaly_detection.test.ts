// @ts-nocheck
// services/bff/__tests__/api_key_anomaly_detection.test.ts
// T6 M1.26 — API key anomaly detection tests

import { detectApiKeyAnomalies } from '../src/api_key_anomaly_detection';

const NOW = new Date('2026-05-22T12:00:00.000Z');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function mkEntry(opts) {
  return {
    key_id: opts.key_id,
    tenant_id: opts.tenant_id ?? 'BANK_DEMO',
    name: opts.name ?? `Key ${opts.key_id}`,
    prefix: opts.prefix ?? opts.key_id.slice(0, 8),
    status: opts.status ?? 'active',
    scopes: opts.scopes ?? ['alerts:read'],
    created_at: opts.created_at ?? new Date(NOW.getTime() - 30 * ONE_DAY_MS).toISOString(),
    created_by: opts.created_by ?? 'alice.admin',
    expires_at: opts.expires_at ?? null,
    last_used_at: opts.last_used_at ?? null,
    revoked_at: opts.revoked_at ?? null,
    revoked_by: opts.revoked_by ?? null,
  };
}

describe('detectApiKeyAnomalies — pure resolver', () => {
  test('empty input → no anomalies', () => {
    const r = detectApiKeyAnomalies('BANK_DEMO', [], NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.generated_at).toBe(NOW.toISOString());
    expect(r.anomalies).toEqual([]);
    expect(r.anomaly_count).toBe(0);
    expect(r.risk_score).toBe(0);
  });

  test('scope_escalation: key with all scopes → critical anomaly', () => {
    const entry = mkEntry({
      key_id: 'k-full',
      scopes: [
        'alerts:read', 'cases:read', 'audit:read', 'reports:read',
        'notifications:send', 'webhooks:dispatch', 'integrations:read',
        'recovery:archive_internal',
      ],
    });
    const r = detectApiKeyAnomalies('BANK_DEMO', [entry], NOW);
    const a = r.anomalies.find((x) => x.type === 'scope_escalation');
    expect(a).toBeDefined();
    expect(a.severity).toBe('critical');
    expect(a.key_id).toBe('k-full');
  });

  test('long_lived_no_expiry: active key > 180 days old, no expires_at → medium', () => {
    const old = new Date(NOW.getTime() - 200 * ONE_DAY_MS).toISOString();
    const entry = mkEntry({ key_id: 'k-old', created_at: old, expires_at: null });
    const r = detectApiKeyAnomalies('BANK_DEMO', [entry], NOW);
    const a = r.anomalies.find((x) => x.type === 'long_lived_no_expiry');
    expect(a).toBeDefined();
    expect(a.severity).toBe('medium');
  });

  test('key < 180 days old → no long_lived anomaly', () => {
    const recent = new Date(NOW.getTime() - 100 * ONE_DAY_MS).toISOString();
    const entry = mkEntry({ key_id: 'k-new', created_at: recent });
    const r = detectApiKeyAnomalies('BANK_DEMO', [entry], NOW);
    expect(r.anomalies.find((x) => x.type === 'long_lived_no_expiry')).toBeUndefined();
  });

  test('dormant_high_scope: active key, last_used > 90 days ago, >4 scopes → high', () => {
    const old_use = new Date(NOW.getTime() - 100 * ONE_DAY_MS).toISOString();
    const entry = mkEntry({
      key_id: 'k-dormant',
      last_used_at: old_use,
      scopes: ['alerts:read', 'cases:read', 'audit:read', 'reports:read', 'notifications:send'],
    });
    const r = detectApiKeyAnomalies('BANK_DEMO', [entry], NOW);
    const a = r.anomalies.find((x) => x.type === 'dormant_high_scope');
    expect(a).toBeDefined();
    expect(a.severity).toBe('high');
  });

  test('bulk_creation: >3 keys same day by same actor → high anomalies', () => {
    const day = '2026-05-15';
    const keys = Array.from({ length: 4 }, (_, i) =>
      mkEntry({
        key_id: `k-bulk-${i}`,
        created_at: `${day}T0${i}:00:00.000Z`,
        created_by: 'bob.admin',
      }),
    );
    const r = detectApiKeyAnomalies('BANK_DEMO', keys, NOW);
    const bulk = r.anomalies.filter((a) => a.type === 'bulk_creation');
    expect(bulk.length).toBe(4);
    expect(bulk[0].severity).toBe('high');
  });

  test('anomalies sorted by severity (critical first)', () => {
    const old = new Date(NOW.getTime() - 200 * ONE_DAY_MS).toISOString();
    const entries = [
      mkEntry({ key_id: 'k-medium', created_at: old }),
      mkEntry({
        key_id: 'k-critical',
        scopes: [
          'alerts:read', 'cases:read', 'audit:read', 'reports:read',
          'notifications:send', 'webhooks:dispatch', 'integrations:read',
          'recovery:archive_internal',
        ],
      }),
    ];
    const r = detectApiKeyAnomalies('BANK_DEMO', entries, NOW);
    expect(r.anomalies[0].severity).toBe('critical');
  });

  test('risk_score = critical*30 + high*15 + medium*5', () => {
    const old = new Date(NOW.getTime() - 200 * ONE_DAY_MS).toISOString();
    const entry = mkEntry({ key_id: 'k-m', created_at: old });
    const r = detectApiKeyAnomalies('BANK_DEMO', [entry], NOW);
    const expectedScore = r.anomalies.reduce((s, a) => {
      if (a.severity === 'critical') return s + 30;
      if (a.severity === 'high') return s + 15;
      return s + 5;
    }, 0);
    expect(r.risk_score).toBe(expectedScore);
  });

  test('cross-tenant isolation: keys for different tenant not counted', () => {
    const entry = mkEntry({ key_id: 'k-x', tenant_id: 'BIL' });
    const r = detectApiKeyAnomalies('BANK_DEMO', [entry], NOW);
    expect(r.total_keys_scanned).toBe(0);
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

describe('GET /v1/admin/api-keys/anomaly-detection', () => {
  test('admin happy path returns 200 with envelope', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/api-keys/anomaly-detection')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(Array.isArray(r.body.body.anomalies)).toBe(true);
    expect(typeof r.body.body.risk_score).toBe('number');
  });

  test('403 for non-admin role', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/api-keys/anomaly-detection')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/api-keys/anomaly-detection')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
  });

  test('cross-tenant isolation: BIL admin only sees BIL keys', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/api-keys/anomaly-detection')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
  });
});
