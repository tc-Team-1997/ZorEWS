// services/bff/__tests__/api_key_expiry_forecast.test.ts
//
// T6 M1.7 — API key expiry forecast timeline.

import request from 'supertest';
import {
  buildApiKeyExpiryForecast,
  ApiKeyExpiryForecastError,
} from '../src/api_key_expiry_forecast';
import {
  InMemoryApiKeyStore,
  type ApiKeyEntry,
} from '../src/api_keys';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-17T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function daysFromNow(d: number): Date {
  return new Date(NOW.getTime() + d * 24 * 60 * 60 * 1000);
}

/** Constructs a redacted ApiKeyEntry inline. Lets tests forge past + future
 *  expires_at values that the store's `validateInput` would reject for being
 *  in the past. */
function makeEntry(overrides: Partial<ApiKeyEntry> = {}): ApiKeyEntry {
  return {
    key_id: `k-${Math.random().toString(36).slice(2, 10)}`,
    tenant_id: 'BIL',
    name: 'k1',
    prefix: 'abc123def456',
    scopes: ['audit:read'],
    status: 'active',
    created_by: 'alice',
    created_at: daysFromNow(-30).toISOString(),
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    revoked_by: null,
    ...overrides,
  };
}

function makeFcApp(role: string = 'admin') {
  const store = new InMemoryApiKeyStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    apiKeyStore: store,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, store };
}

// ─── buildApiKeyExpiryForecast — pure ────────────────────────────────

describe('M1.7 — empty input', () => {
  test('zero entries → zero envelope + 30-day window of zero buckets', () => {
    const f = buildApiKeyExpiryForecast('BIL', [], 30, NOW);
    expect(f.tenant_id).toBe('BIL');
    expect(f.generated_at).toBe(NOW.toISOString());
    expect(f.days).toBe(30);
    expect(f.by_day.length).toBe(30);
    expect(f.total_active_keys).toBe(0);
    expect(f.total_with_expiry).toBe(0);
    expect(f.no_expiry_count).toBe(0);
    expect(f.already_expired_count).toBe(0);
    expect(f.expiring_in_window_count).toBe(0);
    expect(f.beyond_window_count).toBe(0);
    expect(f.peak_day).toBeNull();
    expect(f.peak_count).toBe(0);
    expect(f.already_expired_keys).toEqual([]);
    expect(f.beyond_window_keys).toEqual([]);
    for (const b of f.by_day) {
      expect(b.expiring_count).toBe(0);
      expect(b.sample_keys).toEqual([]);
    }
  });
});

describe('M1.7 — window mechanics', () => {
  test('default 30-day window starts at NOW UTC day', () => {
    const f = buildApiKeyExpiryForecast('BIL', [], 30, NOW);
    expect(f.window_start).toBe('2026-05-17');
    // 30 days forward inclusive → end = May 17 + 29 days = Jun 15
    expect(f.window_end).toBe('2026-06-15');
  });

  test('days=1 → single-day window for today', () => {
    const f = buildApiKeyExpiryForecast('BIL', [], 1, NOW);
    expect(f.by_day.length).toBe(1);
    expect(f.by_day[0]!.date).toBe('2026-05-17');
    expect(f.window_start).toBe('2026-05-17');
    expect(f.window_end).toBe('2026-05-17');
  });

  test('7-day window — May 17..23', () => {
    const f = buildApiKeyExpiryForecast('BIL', [], 7, NOW);
    expect(f.by_day.map((b) => b.date)).toEqual([
      '2026-05-17',
      '2026-05-18',
      '2026-05-19',
      '2026-05-20',
      '2026-05-21',
      '2026-05-22',
      '2026-05-23',
    ]);
  });
});

describe('M1.7 — single key placement', () => {
  test('key expiring in 5 days lands in May 22 bucket', () => {
    const f = buildApiKeyExpiryForecast(
      'BIL',
      [makeEntry({ expires_at: daysFromNow(5).toISOString() })],
      30,
      NOW,
    );
    const may22 = f.by_day.find((b) => b.date === '2026-05-22')!;
    expect(may22.expiring_count).toBe(1);
    expect(may22.sample_keys).toHaveLength(1);
    expect(f.total_active_keys).toBe(1);
    expect(f.total_with_expiry).toBe(1);
    expect(f.expiring_in_window_count).toBe(1);
  });
});

describe('M1.7 — no_expiry_count', () => {
  test('active key with null expires_at counted separately', () => {
    const f = buildApiKeyExpiryForecast(
      'BIL',
      [makeEntry({ expires_at: null })],
      30,
      NOW,
    );
    expect(f.total_active_keys).toBe(1);
    expect(f.no_expiry_count).toBe(1);
    expect(f.total_with_expiry).toBe(0);
    expect(f.expiring_in_window_count).toBe(0);
  });
});

describe('M1.7 — already_expired_count', () => {
  test('key with expires_at before NOW UTC day lands in already_expired', () => {
    const f = buildApiKeyExpiryForecast(
      'BIL',
      [makeEntry({
        name: 'overdue',
        expires_at: daysFromNow(-10).toISOString(),
      })],
      30,
      NOW,
    );
    expect(f.already_expired_count).toBe(1);
    expect(f.expiring_in_window_count).toBe(0);
    expect(f.already_expired_keys).toHaveLength(1);
    expect(f.already_expired_keys[0]!.name).toBe('overdue');
  });

  test('already_expired_keys sorted by expires_at asc (most-overdue first)', () => {
    const f = buildApiKeyExpiryForecast(
      'BIL',
      [
        makeEntry({ name: 'recent', expires_at: daysFromNow(-1).toISOString() }),
        makeEntry({ name: 'ancient', expires_at: daysFromNow(-100).toISOString() }),
        makeEntry({ name: 'medium', expires_at: daysFromNow(-30).toISOString() }),
      ],
      30,
      NOW,
    );
    expect(f.already_expired_keys.map((s) => s.name)).toEqual(['ancient', 'medium', 'recent']);
  });
});

describe('M1.7 — beyond_window_count', () => {
  test('key expiring beyond window end counted separately', () => {
    const f = buildApiKeyExpiryForecast(
      'BIL',
      [makeEntry({
        name: 'far-future',
        expires_at: daysFromNow(60).toISOString(),
      })],
      30,
      NOW,
    );
    expect(f.beyond_window_count).toBe(1);
    expect(f.expiring_in_window_count).toBe(0);
    expect(f.beyond_window_keys).toHaveLength(1);
  });

  test('beyond_window_keys sorted by expires_at asc (soonest first)', () => {
    const f = buildApiKeyExpiryForecast(
      'BIL',
      [
        makeEntry({ name: 'far', expires_at: daysFromNow(200).toISOString() }),
        makeEntry({ name: 'mid', expires_at: daysFromNow(60).toISOString() }),
        makeEntry({ name: 'farther', expires_at: daysFromNow(100).toISOString() }),
      ],
      30,
      NOW,
    );
    expect(f.beyond_window_keys.map((s) => s.name)).toEqual(['mid', 'farther', 'far']);
  });
});

describe('M1.7 — boundary semantics', () => {
  test('key expiring today (NOW UTC day) lands in first bucket, not already_expired', () => {
    const f = buildApiKeyExpiryForecast(
      'BIL',
      [makeEntry({
        // Same UTC day as NOW (2026-05-17), late in the day
        expires_at: '2026-05-17T23:00:00.000Z',
      })],
      30,
      NOW,
    );
    expect(f.already_expired_count).toBe(0);
    expect(f.expiring_in_window_count).toBe(1);
    expect(f.by_day[0]!.expiring_count).toBe(1);
  });

  test('key expiring on window_end falls inside window not beyond', () => {
    // 30-day window: end = May 17 + 29 = Jun 15. Make a key expire late on Jun 15.
    const f = buildApiKeyExpiryForecast(
      'BIL',
      [makeEntry({
        expires_at: '2026-06-15T23:00:00.000Z',
      })],
      30,
      NOW,
    );
    expect(f.beyond_window_count).toBe(0);
    expect(f.expiring_in_window_count).toBe(1);
    expect(f.by_day[f.by_day.length - 1]!.expiring_count).toBe(1);
  });

  test('key expiring on day AFTER window_end is beyond_window', () => {
    // Jun 16 is one day past window_end of Jun 15.
    const f = buildApiKeyExpiryForecast(
      'BIL',
      [makeEntry({
        expires_at: '2026-06-16T00:00:00.000Z',
      })],
      30,
      NOW,
    );
    expect(f.beyond_window_count).toBe(1);
    expect(f.expiring_in_window_count).toBe(0);
  });
});

describe('M1.7 — revoked excluded', () => {
  test('revoked key not counted in total_active_keys or anywhere', () => {
    const f = buildApiKeyExpiryForecast(
      'BIL',
      [
        makeEntry({ status: 'active', expires_at: daysFromNow(5).toISOString() }),
        makeEntry({
          status: 'revoked',
          expires_at: daysFromNow(5).toISOString(),
          revoked_at: daysFromNow(-1).toISOString(),
          revoked_by: 'admin',
        }),
      ],
      30,
      NOW,
    );
    expect(f.total_active_keys).toBe(1);
    expect(f.expiring_in_window_count).toBe(1);
    expect(f.no_expiry_count).toBe(0);
  });
});

describe('M1.7 — peak_day', () => {
  test('points at highest expiring_count day', () => {
    const f = buildApiKeyExpiryForecast(
      'BIL',
      [
        // May 20: 3 expirations
        makeEntry({ name: 'a', expires_at: daysFromNow(3).toISOString() }),
        makeEntry({ name: 'b', expires_at: daysFromNow(3).toISOString() }),
        makeEntry({ name: 'c', expires_at: daysFromNow(3).toISOString() }),
        // May 21: 1
        makeEntry({ name: 'd', expires_at: daysFromNow(4).toISOString() }),
      ],
      30,
      NOW,
    );
    expect(f.peak_day).toBe('2026-05-20');
    expect(f.peak_count).toBe(3);
  });

  test('earliest-day-wins tie-break', () => {
    const f = buildApiKeyExpiryForecast(
      'BIL',
      [
        makeEntry({ name: 'a', expires_at: daysFromNow(3).toISOString() }),
        makeEntry({ name: 'b', expires_at: daysFromNow(10).toISOString() }),
      ],
      30,
      NOW,
    );
    // Tied at 1; earlier day wins via strict > comparison.
    expect(f.peak_day).toBe('2026-05-20');
    expect(f.peak_count).toBe(1);
  });

  test('null when no expirations in window', () => {
    const f = buildApiKeyExpiryForecast(
      'BIL',
      [makeEntry({ expires_at: null })],
      30,
      NOW,
    );
    expect(f.peak_day).toBeNull();
    expect(f.peak_count).toBe(0);
  });
});

describe('M1.7 — sample_keys cap and sort', () => {
  test('per-day sample_keys cap at 5 sorted name asc', () => {
    const entries: ApiKeyEntry[] = [];
    // 7 keys all expiring on same day
    for (const name of ['z', 'y', 'x', 'w', 'v', 'u', 't']) {
      entries.push(makeEntry({ name, expires_at: daysFromNow(5).toISOString() }));
    }
    const f = buildApiKeyExpiryForecast('BIL', entries, 30, NOW);
    const may22 = f.by_day.find((b) => b.date === '2026-05-22')!;
    expect(may22.expiring_count).toBe(7); // full count preserved
    expect(may22.sample_keys).toHaveLength(5); // sample capped at 5
    expect(may22.sample_keys.map((s) => s.name)).toEqual(['t', 'u', 'v', 'w', 'x']); // alpha asc top-5
  });
});

describe('M1.7 — partition invariant', () => {
  test('no_expiry + already_expired + in_window + beyond_window = total_active_keys', () => {
    const f = buildApiKeyExpiryForecast(
      'BIL',
      [
        makeEntry({ expires_at: null }), // no_expiry
        makeEntry({ expires_at: daysFromNow(-10).toISOString() }), // already_expired
        makeEntry({ expires_at: daysFromNow(5).toISOString() }), // in_window
        makeEntry({ expires_at: daysFromNow(100).toISOString() }), // beyond_window
        makeEntry({
          status: 'revoked',
          expires_at: daysFromNow(5).toISOString(),
          revoked_at: daysFromNow(-1).toISOString(),
          revoked_by: 'admin',
        }), // revoked — excluded entirely
      ],
      30,
      NOW,
    );
    expect(f.total_active_keys).toBe(4);
    expect(
      f.no_expiry_count + f.already_expired_count + f.expiring_in_window_count + f.beyond_window_count,
    ).toBe(f.total_active_keys);
    // Σ by_day expiring_count = expiring_in_window_count
    const sum = f.by_day.reduce((acc, b) => acc + b.expiring_count, 0);
    expect(sum).toBe(f.expiring_in_window_count);
  });
});

describe('M1.7 — edge list caps', () => {
  test('already_expired_keys + beyond_window_keys cap at 20', () => {
    const entries: ApiKeyEntry[] = [];
    for (let i = 0; i < 25; i++) {
      entries.push(makeEntry({
        name: `expired-${i}`,
        expires_at: daysFromNow(-(i + 1)).toISOString(),
      }));
    }
    for (let i = 0; i < 25; i++) {
      entries.push(makeEntry({
        name: `future-${i}`,
        expires_at: daysFromNow(100 + i).toISOString(),
      }));
    }
    const f = buildApiKeyExpiryForecast('BIL', entries, 30, NOW);
    expect(f.already_expired_count).toBe(25); // full count
    expect(f.beyond_window_count).toBe(25);
    expect(f.already_expired_keys).toHaveLength(20); // list capped
    expect(f.beyond_window_keys).toHaveLength(20);
  });
});

describe('M1.7 — invalid days throws', () => {
  test('days=0 throws ApiKeyExpiryForecastError', () => {
    expect(() => buildApiKeyExpiryForecast('BIL', [], 0, NOW)).toThrow(ApiKeyExpiryForecastError);
  });

  test('days=366 throws', () => {
    expect(() => buildApiKeyExpiryForecast('BIL', [], 366, NOW)).toThrow(ApiKeyExpiryForecastError);
  });

  test('non-integer throws', () => {
    expect(() => buildApiKeyExpiryForecast('BIL', [], 3.5, NOW)).toThrow(ApiKeyExpiryForecastError);
  });

  test('days=365 accepted at boundary', () => {
    const f = buildApiKeyExpiryForecast('BIL', [], 365, NOW);
    expect(f.days).toBe(365);
    expect(f.by_day.length).toBe(365);
  });
});

// ─── GET /v1/admin/api-keys/expiry-forecast ──────────────────────────

describe('M1.7 — GET /v1/admin/api-keys/expiry-forecast', () => {
  test('admin → 200 with default 30-day empty window', async () => {
    const { app } = makeFcApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/expiry-forecast').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.days).toBe(30);
    expect(r.body.body.by_day.length).toBe(30);
    expect(r.body.body.total_active_keys).toBe(0);
    expect(r.body.body.peak_day).toBeNull();
  });

  test('populated forecast reflects future expirations', async () => {
    const { app, store } = makeFcApp('admin');
    // Create with a future expires_at (must be future per validateInput).
    store.create(
      'BIL',
      { name: 'k1', scopes: ['audit:read'], expires_at: daysFromNow(10).toISOString() },
      'alice',
      NOW,
    );
    store.create(
      'BIL',
      { name: 'k2-no-expiry', scopes: ['audit:read'] },
      'alice',
      NOW,
    );
    const r = await request(app).get('/v1/admin/api-keys/expiry-forecast?days=30').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_active_keys).toBe(2);
    expect(r.body.body.no_expiry_count).toBe(1);
    expect(r.body.body.expiring_in_window_count).toBe(1);
    expect(r.body.body.peak_day).toBe('2026-05-27');
    expect(r.body.body.peak_count).toBe(1);
  });

  test('?days=invalid → 400 envelope', async () => {
    const { app } = makeFcApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/expiry-forecast?days=0').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?days=400 → 400 envelope', async () => {
    const { app } = makeFcApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/expiry-forecast?days=400').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?days=NaN → 400 envelope', async () => {
    const { app } = makeFcApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/expiry-forecast?days=abc').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeFcApp('case_owner');
    const r = await request(app).get('/v1/admin/api-keys/expiry-forecast').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL keys invisible to BANK_DEMO', async () => {
    const { app, store } = makeFcApp('admin');
    store.create(
      'BIL',
      { name: 'k1', scopes: ['audit:read'], expires_at: daysFromNow(5).toISOString() },
      'alice',
      NOW,
    );
    const bank = await request(app)
      .get('/v1/admin/api-keys/expiry-forecast')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_active_keys).toBe(0);
  });

  test('literal `/expiry-forecast` not captured as :key_id', async () => {
    const { app } = makeFcApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/expiry-forecast').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('M1.6 /by-creator + M1.5 /scope-distribution still 200 (sibling regression)', async () => {
    const { app } = makeFcApp('admin');
    const r1 = await request(app).get('/v1/admin/api-keys/by-creator').set(TH_BIL);
    const r2 = await request(app).get('/v1/admin/api-keys/scope-distribution').set(TH_BIL);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});
