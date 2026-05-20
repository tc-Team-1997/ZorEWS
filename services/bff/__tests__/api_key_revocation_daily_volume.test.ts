// T6 M1.15 — API key revocation daily volume timeline.

import request from 'supertest';
import {
  buildApiKeyRevocationDailyVolume,
  ApiKeyRevocationDailyVolumeError,
  DEFAULT_REVOCATION_DAILY_WINDOW,
  MAX_REVOCATION_DAILY_WINDOW,
} from '../src/api_key_revocation_daily_volume';
import {
  InMemoryApiKeyStore,
  VALID_SCOPES,
  type ApiKeyEntry,
  type ApiKeyStore,
} from '../src/api_keys';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-20T12:00:00.000Z');
const TH = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeTestApp(role: string = 'admin', apiKeyStore?: ApiKeyStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    apiKeyStore: apiKeyStore ?? new InMemoryApiKeyStore(),
  });
}

function revokedKey(overrides: Partial<ApiKeyEntry> = {}): ApiKeyEntry {
  return {
    key_id: 'k-' + Math.random().toString(36).slice(2, 10),
    tenant_id: 'BIL',
    name: 'Test Key',
    prefix: 'abcdef',
    scopes: ['alerts:read'],
    status: 'revoked',
    created_by: 'alice',
    created_at: NOW.toISOString(),
    expires_at: null,
    last_used_at: null,
    revoked_at: NOW.toISOString(),
    revoked_by: 'admin',
    ...overrides,
  };
}

describe('M1.15 — buildApiKeyRevocationDailyVolume', () => {
  test('empty input → 30 zero buckets + null leaderboards', () => {
    const m = buildApiKeyRevocationDailyVolume('BIL', [], 30, NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.total_revocations_in_window).toBe(0);
    expect(m.total_revocations_observed).toBe(0);
    expect(m.by_day.length).toBe(30);
    for (const d of m.by_day) {
      expect(d.total_revocations).toBe(0);
      expect(d.distinct_revokers).toBe(0);
    }
    expect(m.peak_day).toBeNull();
    expect(m.peak_count).toBe(0);
    expect(m.growth_rate).toBeNull();
    expect(m.most_revoked_scope).toBeNull();
  });

  test('default 30-day window spans Apr 21 → May 20', () => {
    const m = buildApiKeyRevocationDailyVolume(
      'BIL',
      [],
      DEFAULT_REVOCATION_DAILY_WINDOW,
      NOW,
    );
    expect(m.window_end).toBe('2026-05-20');
    expect(m.window_start).toBe('2026-04-21');
  });

  test('days=1 → 1 bucket today', () => {
    const m = buildApiKeyRevocationDailyVolume('BIL', [], 1, NOW);
    expect(m.by_day.length).toBe(1);
    expect(m.by_day[0].date).toBe('2026-05-20');
  });

  test('by_day oldest-first', () => {
    const m = buildApiKeyRevocationDailyVolume('BIL', [], 7, NOW);
    for (let i = 1; i < m.by_day.length; i++) {
      expect(m.by_day[i].date > m.by_day[i - 1].date).toBe(true);
    }
  });

  test('active keys excluded (only revoked count)', () => {
    const entries = [
      { ...revokedKey({ key_id: 'k1' }), status: 'active' as const, revoked_at: null },
      revokedKey({ key_id: 'k2', revoked_at: '2026-05-15T10:00:00.000Z' }),
    ];
    const m = buildApiKeyRevocationDailyVolume('BIL', entries, 30, NOW);
    expect(m.total_revocations_observed).toBe(1);
    expect(m.total_revocations_in_window).toBe(1);
  });

  test('revoked key without revoked_at silently skipped', () => {
    const entries = [
      { ...revokedKey({ key_id: 'k1' }), revoked_at: null },
      revokedKey({ key_id: 'k2', revoked_at: '2026-05-15T10:00:00.000Z' }),
    ];
    const m = buildApiKeyRevocationDailyVolume('BIL', entries, 30, NOW);
    expect(m.total_revocations_observed).toBe(1);
  });

  test('single revocation lands at correct UTC bucket', () => {
    const entries = [
      revokedKey({ key_id: 'k1', revoked_at: '2026-05-15T14:30:00.000Z' }),
    ];
    const m = buildApiKeyRevocationDailyVolume('BIL', entries, 30, NOW);
    const bucket = m.by_day.find((b) => b.date === '2026-05-15')!;
    expect(bucket.total_revocations).toBe(1);
    expect(bucket.by_scope['alerts:read']).toBe(1);
    expect(bucket.distinct_revokers).toBe(1);
  });

  test('revocations outside window dropped from in_window but counted in observed', () => {
    const entries = [
      revokedKey({ key_id: 'k1', revoked_at: '2026-05-15T10:00:00.000Z' }), // in window
      revokedKey({ key_id: 'k2', revoked_at: '2025-12-01T00:00:00.000Z' }), // outside
    ];
    const m = buildApiKeyRevocationDailyVolume('BIL', entries, 30, NOW);
    expect(m.total_revocations_in_window).toBe(1);
    expect(m.total_revocations_observed).toBe(2);
  });

  test('multi-scope key contributes to each scope', () => {
    const entries = [
      revokedKey({
        key_id: 'k1',
        revoked_at: '2026-05-15T10:00:00.000Z',
        scopes: ['alerts:read', 'cases:read', 'audit:read'],
      }),
    ];
    const m = buildApiKeyRevocationDailyVolume('BIL', entries, 30, NOW);
    const bucket = m.by_day.find((b) => b.date === '2026-05-15')!;
    expect(bucket.total_revocations).toBe(1);
    expect(bucket.by_scope['alerts:read']).toBe(1);
    expect(bucket.by_scope['cases:read']).toBe(1);
    expect(bucket.by_scope['audit:read']).toBe(1);
    expect(bucket.by_scope['reports:read']).toBe(0);
  });

  test('intra-key scope dedup defensive', () => {
    const entries = [
      revokedKey({
        key_id: 'k1',
        revoked_at: '2026-05-15T10:00:00.000Z',
        scopes: ['alerts:read', 'alerts:read'] as never,
      }),
    ];
    const m = buildApiKeyRevocationDailyVolume('BIL', entries, 30, NOW);
    const bucket = m.by_day.find((b) => b.date === '2026-05-15')!;
    expect(bucket.by_scope['alerts:read']).toBe(1);
  });

  test('distinct_revokers per-day Set dedup', () => {
    const entries = [
      revokedKey({ key_id: 'k1', revoked_at: '2026-05-15T10:00:00.000Z', revoked_by: 'admin' }),
      revokedKey({ key_id: 'k2', revoked_at: '2026-05-15T11:00:00.000Z', revoked_by: 'admin' }),
      revokedKey({ key_id: 'k3', revoked_at: '2026-05-15T12:00:00.000Z', revoked_by: 'alice' }),
    ];
    const m = buildApiKeyRevocationDailyVolume('BIL', entries, 30, NOW);
    const bucket = m.by_day.find((b) => b.date === '2026-05-15')!;
    expect(bucket.total_revocations).toBe(3);
    expect(bucket.distinct_revokers).toBe(2);
  });

  test('peak_day formula + earliest-day-wins tie-break', () => {
    const entries = [
      revokedKey({ key_id: 'k1', revoked_at: '2026-05-15T10:00:00.000Z' }),
      revokedKey({ key_id: 'k2', revoked_at: '2026-05-10T10:00:00.000Z' }),
    ];
    const m = buildApiKeyRevocationDailyVolume('BIL', entries, 30, NOW);
    expect(m.peak_day).toBe('2026-05-10');
    expect(m.peak_count).toBe(1);
  });

  test('mean_per_day = round(total/days)', () => {
    const entries = [];
    for (let i = 0; i < 5; i++) {
      entries.push(
        revokedKey({
          key_id: `k${i}`,
          revoked_at: '2026-05-15T10:00:00.000Z',
        }),
      );
    }
    const m = buildApiKeyRevocationDailyVolume('BIL', entries, 30, NOW);
    expect(m.mean_per_day).toBe(0); // 5/30 = 0.17 → 0
  });

  test('growth_rate positive when second half busier', () => {
    const entries = [
      revokedKey({ key_id: 'k1', revoked_at: '2026-05-08T10:00:00.000Z' }),
      revokedKey({ key_id: 'k2', revoked_at: '2026-05-18T10:00:00.000Z' }),
      revokedKey({ key_id: 'k3', revoked_at: '2026-05-19T10:00:00.000Z' }),
      revokedKey({ key_id: 'k4', revoked_at: '2026-05-20T10:00:00.000Z' }),
    ];
    const m = buildApiKeyRevocationDailyVolume('BIL', entries, 14, NOW);
    expect(m.growth_rate).not.toBeNull();
    expect(m.growth_rate!).toBeGreaterThan(0);
  });

  test('growth_rate null when first-half=0', () => {
    const entries = [
      revokedKey({ key_id: 'k1', revoked_at: '2026-05-20T10:00:00.000Z' }),
    ];
    const m = buildApiKeyRevocationDailyVolume('BIL', entries, 14, NOW);
    expect(m.growth_rate).toBeNull();
  });

  test('growth_rate null when days=1', () => {
    const m = buildApiKeyRevocationDailyVolume('BIL', [], 1, NOW);
    expect(m.growth_rate).toBeNull();
  });

  test('most_revoked_scope formula', () => {
    const entries = [
      revokedKey({
        key_id: 'k1',
        revoked_at: '2026-05-15T10:00:00.000Z',
        scopes: ['audit:read', 'audit:read'] as never, // dedupes to 1
      }),
      revokedKey({
        key_id: 'k2',
        revoked_at: '2026-05-15T11:00:00.000Z',
        scopes: ['audit:read'],
      }),
      revokedKey({
        key_id: 'k3',
        revoked_at: '2026-05-15T12:00:00.000Z',
        scopes: ['alerts:read'],
      }),
    ];
    const m = buildApiKeyRevocationDailyVolume('BIL', entries, 30, NOW);
    expect(m.most_revoked_scope).toBe('audit:read');
  });

  test('most_revoked_scope canonical tie-break (alerts:read wins)', () => {
    const entries = [
      revokedKey({
        key_id: 'k1',
        revoked_at: '2026-05-15T10:00:00.000Z',
        scopes: ['alerts:read'],
      }),
      revokedKey({
        key_id: 'k2',
        revoked_at: '2026-05-15T11:00:00.000Z',
        scopes: ['audit:read'],
      }),
    ];
    const m = buildApiKeyRevocationDailyVolume('BIL', entries, 30, NOW);
    // Both 1; alerts:read is first in VALID_SCOPES → wins
    expect(m.most_revoked_scope).toBe('alerts:read');
  });

  test('most_revoked_scope null on empty', () => {
    const m = buildApiKeyRevocationDailyVolume('BIL', [], 30, NOW);
    expect(m.most_revoked_scope).toBeNull();
  });

  test('Σ by_day.total_revocations = total_revocations_in_window', () => {
    const entries = [
      revokedKey({ key_id: 'k1', revoked_at: '2026-05-10T10:00:00.000Z' }),
      revokedKey({ key_id: 'k2', revoked_at: '2026-05-15T10:00:00.000Z' }),
      revokedKey({ key_id: 'k3', revoked_at: '2026-05-19T10:00:00.000Z' }),
    ];
    const m = buildApiKeyRevocationDailyVolume('BIL', entries, 30, NOW);
    const sum = m.by_day.reduce((a, b) => a + b.total_revocations, 0);
    expect(sum).toBe(m.total_revocations_in_window);
    expect(sum).toBe(3);
  });

  test('invalid days throws (0 / MAX+1 / non-integer)', () => {
    expect(() => buildApiKeyRevocationDailyVolume('BIL', [], 0, NOW)).toThrow(
      ApiKeyRevocationDailyVolumeError,
    );
    expect(() =>
      buildApiKeyRevocationDailyVolume('BIL', [], MAX_REVOCATION_DAILY_WINDOW + 1, NOW),
    ).toThrow(ApiKeyRevocationDailyVolumeError);
    expect(() => buildApiKeyRevocationDailyVolume('BIL', [], 7.5, NOW)).toThrow(
      ApiKeyRevocationDailyVolumeError,
    );
  });

  test('days=MAX boundary accepted', () => {
    const m = buildApiKeyRevocationDailyVolume(
      'BIL',
      [],
      MAX_REVOCATION_DAILY_WINDOW,
      NOW,
    );
    expect(m.days).toBe(MAX_REVOCATION_DAILY_WINDOW);
  });

  test('records with NaN revoked_at silently skipped', () => {
    const entries = [
      revokedKey({ key_id: 'k1', revoked_at: 'not-a-date' }),
      revokedKey({ key_id: 'k2', revoked_at: '2026-05-15T10:00:00.000Z' }),
    ];
    const m = buildApiKeyRevocationDailyVolume('BIL', entries, 30, NOW);
    expect(m.total_revocations_in_window).toBe(1);
  });

  test('tenant_id + generated_at echo', () => {
    const m = buildApiKeyRevocationDailyVolume('BIL', [], 30, NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.generated_at).toBe(NOW.toISOString());
  });

  test('every VALID_SCOPES key present per bucket', () => {
    const entries = [
      revokedKey({ key_id: 'k1', revoked_at: '2026-05-15T10:00:00.000Z' }),
    ];
    const m = buildApiKeyRevocationDailyVolume('BIL', entries, 30, NOW);
    const bucket = m.by_day.find((b) => b.date === '2026-05-15')!;
    for (const s of VALID_SCOPES) {
      expect(bucket.by_scope[s]).toBeGreaterThanOrEqual(0);
    }
    expect(Object.keys(bucket.by_scope).length).toBe(VALID_SCOPES.length);
  });
});

describe('M1.15 — GET /v1/admin/api-keys/revocation-daily-volume', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/revocation-daily-volume')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_revocations_in_window).toBe(0);
    expect(r.body.body.days).toBe(30);
    expect(r.body.body.by_day.length).toBe(30);
  });

  test('populated reflects store', async () => {
    const store = new InMemoryApiKeyStore();
    const created = store.create(
      'BIL',
      { name: 'Test', scopes: ['alerts:read'] },
      'alice',
      NOW,
    );
    store.revoke('BIL', created.key_id, 'admin', NOW);
    const { app } = makeTestApp('admin', store);
    const r = await request(app)
      .get('/v1/admin/api-keys/revocation-daily-volume')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_revocations_in_window).toBe(1);
    expect(r.body.body.most_revoked_scope).toBe('alerts:read');
  });

  test('?days=7 narrows window', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/revocation-daily-volume?days=7')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.days).toBe(7);
    expect(r.body.body.by_day.length).toBe(7);
  });

  test('?days=0 → 400 EWS_400_invalid_input', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/revocation-daily-volume?days=0')
      .set(TH);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?days=400 → 400', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/revocation-daily-volume?days=400')
      .set(TH);
    expect(r.status).toBe(400);
  });

  test('?days=abc → 400', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/revocation-daily-volume?days=abc')
      .set(TH);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTestApp('case_owner');
    const r = await request(app)
      .get('/v1/admin/api-keys/revocation-daily-volume')
      .set(TH);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryApiKeyStore();
    const created = store.create(
      'BIL',
      { name: 'Test', scopes: ['alerts:read'] },
      'alice',
      NOW,
    );
    store.revoke('BIL', created.key_id, 'admin', NOW);
    const { app } = makeTestApp('admin', store);
    const r = await request(app)
      .get('/v1/admin/api-keys/revocation-daily-volume')
      .set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total_revocations_in_window).toBe(0);
  });

  test('M1.9 /daily-volume sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/daily-volume')
      .set(TH);
    expect(r.status).toBe(200);
  });
});
