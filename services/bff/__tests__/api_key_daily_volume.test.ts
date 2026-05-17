// services/bff/__tests__/api_key_daily_volume.test.ts
//
// T6 M1.9 — API key creation daily volume timeline.

import request from 'supertest';
import {
  summarizeApiKeyDailyVolume,
  ApiKeyDailyVolumeError,
} from '../src/api_key_daily_volume';
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

function daysAgo(d: number): Date {
  return new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);
}

function entry(overrides: Partial<ApiKeyEntry> = {}): ApiKeyEntry {
  return {
    key_id: `k-${Math.random().toString(36).slice(2, 10)}`,
    tenant_id: 'BIL',
    name: 'k',
    prefix: 'abc123def456',
    scopes: ['audit:read'],
    status: 'active',
    created_by: 'admin',
    created_at: NOW.toISOString(),
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    revoked_by: null,
    ...overrides,
  };
}

function makeDvApp(role: string = 'admin') {
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

// ─── summarizeApiKeyDailyVolume — pure ───────────────────────────────

describe('M1.9 — empty input', () => {
  test('zero entries → every day at 0; peak null', () => {
    const s = summarizeApiKeyDailyVolume('BIL', [], 30, NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.days).toBe(30);
    expect(s.by_day.length).toBe(30);
    expect(s.total_created_in_window).toBe(0);
    expect(s.total_keys_observed).toBe(0);
    expect(s.peak_day).toBeNull();
    expect(s.peak_count).toBe(0);
    expect(s.mean_per_day).toBe(0);
    expect(s.growth_rate).toBeNull();
    expect(s.total_active_in_window).toBe(0);
    expect(s.total_revoked_in_window).toBe(0);
  });
});

describe('M1.9 — window mechanics', () => {
  test('default 30-day window — last bucket is NOW UTC day', () => {
    const s = summarizeApiKeyDailyVolume('BIL', [], 30, NOW);
    expect(s.by_day.length).toBe(30);
    expect(s.window_end).toBe('2026-05-17');
    // 30 days inclusive → start = May 17 - 29 = Apr 18
    expect(s.window_start).toBe('2026-04-18');
  });

  test('days=1 → single day window', () => {
    const s = summarizeApiKeyDailyVolume('BIL', [], 1, NOW);
    expect(s.by_day.length).toBe(1);
    expect(s.by_day[0]!.date).toBe('2026-05-17');
    expect(s.window_start).toBe('2026-05-17');
    expect(s.window_end).toBe('2026-05-17');
  });

  test('7-day window — May 11..17', () => {
    const s = summarizeApiKeyDailyVolume('BIL', [], 7, NOW);
    expect(s.by_day.map((b) => b.date)).toEqual([
      '2026-05-11',
      '2026-05-12',
      '2026-05-13',
      '2026-05-14',
      '2026-05-15',
      '2026-05-16',
      '2026-05-17',
    ]);
  });
});

describe('M1.9 — single key placement', () => {
  test('key created 2 days ago lands in correct bucket', () => {
    const s = summarizeApiKeyDailyVolume(
      'BIL',
      [entry({ created_at: daysAgo(2).toISOString() })],
      7,
      NOW,
    );
    const may15 = s.by_day.find((b) => b.date === '2026-05-15')!;
    expect(may15.total).toBe(1);
    expect(may15.by_status.active).toBe(1);
    expect(s.total_created_in_window).toBe(1);
    expect(s.total_keys_observed).toBe(1);
  });
});

describe('M1.9 — by_status accumulation', () => {
  test('mix of active + revoked counts correctly per day', () => {
    const s = summarizeApiKeyDailyVolume(
      'BIL',
      [
        entry({ created_at: NOW.toISOString(), status: 'active' }),
        entry({ created_at: NOW.toISOString(), status: 'active' }),
        entry({ created_at: NOW.toISOString(), status: 'revoked' }),
      ],
      7,
      NOW,
    );
    const today = s.by_day.find((b) => b.date === '2026-05-17')!;
    expect(today.total).toBe(3);
    expect(today.by_status.active).toBe(2);
    expect(today.by_status.revoked).toBe(1);
    expect(s.total_active_in_window).toBe(2);
    expect(s.total_revoked_in_window).toBe(1);
  });
});

describe('M1.9 — events outside window', () => {
  test('keys created before window_start counted in observed but not in_window', () => {
    const s = summarizeApiKeyDailyVolume(
      'BIL',
      [
        entry({ created_at: NOW.toISOString() }), // today, in window
        entry({ created_at: daysAgo(100).toISOString() }), // 100 days ago, outside 30-day window
      ],
      30,
      NOW,
    );
    expect(s.total_created_in_window).toBe(1);
    expect(s.total_keys_observed).toBe(2);
  });
});

describe('M1.9 — peak_day', () => {
  test('points at highest-count day', () => {
    const s = summarizeApiKeyDailyVolume(
      'BIL',
      [
        entry({ created_at: daysAgo(2).toISOString() }),
        entry({ created_at: daysAgo(2).toISOString() }),
        entry({ created_at: daysAgo(2).toISOString() }),
        entry({ created_at: daysAgo(1).toISOString() }),
      ],
      7,
      NOW,
    );
    expect(s.peak_day).toBe('2026-05-15');
    expect(s.peak_count).toBe(3);
  });

  test('earliest-day-wins tie-break', () => {
    const s = summarizeApiKeyDailyVolume(
      'BIL',
      [
        entry({ created_at: daysAgo(2).toISOString() }),
        entry({ created_at: daysAgo(1).toISOString() }),
      ],
      7,
      NOW,
    );
    expect(s.peak_day).toBe('2026-05-15'); // earlier day wins
  });

  test('null when zero creations in window', () => {
    const s = summarizeApiKeyDailyVolume('BIL', [], 7, NOW);
    expect(s.peak_day).toBeNull();
    expect(s.peak_count).toBe(0);
  });
});

describe('M1.9 — mean_per_day', () => {
  test('rounded total / days', () => {
    const s = summarizeApiKeyDailyVolume(
      'BIL',
      [
        entry({ created_at: daysAgo(0).toISOString() }),
        entry({ created_at: daysAgo(0).toISOString() }),
        entry({ created_at: daysAgo(0).toISOString() }),
        entry({ created_at: daysAgo(1).toISOString() }),
        entry({ created_at: daysAgo(2).toISOString() }),
      ],
      5,
      NOW,
    );
    expect(s.mean_per_day).toBe(1); // 5/5 = 1
  });

  test('zero when no creations', () => {
    const s = summarizeApiKeyDailyVolume('BIL', [], 7, NOW);
    expect(s.mean_per_day).toBe(0);
  });
});

describe('M1.9 — growth_rate', () => {
  test('positive when second half busier than first half', () => {
    const entries: ApiKeyEntry[] = [
      // First half (May 11-13): 1 per day
      entry({ created_at: daysAgo(6).toISOString() }),
      entry({ created_at: daysAgo(5).toISOString() }),
      entry({ created_at: daysAgo(4).toISOString() }),
      // Second half (May 14-17): 4 per day
      ...Array(4).fill(0).map(() => entry({ created_at: daysAgo(3).toISOString() })),
      ...Array(4).fill(0).map(() => entry({ created_at: daysAgo(2).toISOString() })),
      ...Array(4).fill(0).map(() => entry({ created_at: daysAgo(1).toISOString() })),
      ...Array(4).fill(0).map(() => entry({ created_at: daysAgo(0).toISOString() })),
    ];
    const s = summarizeApiKeyDailyVolume('BIL', entries, 7, NOW);
    // 7-day window → half=3; firstHalf mean=1; secondHalf mean=4
    // growth = (4-1)/1 = 3
    expect(s.growth_rate).toBe(3);
  });

  test('negative when second half quieter', () => {
    const entries: ApiKeyEntry[] = [
      // First half: 4 per day
      ...Array(4).fill(0).map(() => entry({ created_at: daysAgo(6).toISOString() })),
      ...Array(4).fill(0).map(() => entry({ created_at: daysAgo(5).toISOString() })),
      ...Array(4).fill(0).map(() => entry({ created_at: daysAgo(4).toISOString() })),
      // Second half: 2 per day
      ...Array(2).fill(0).map(() => entry({ created_at: daysAgo(3).toISOString() })),
      ...Array(2).fill(0).map(() => entry({ created_at: daysAgo(2).toISOString() })),
      ...Array(2).fill(0).map(() => entry({ created_at: daysAgo(1).toISOString() })),
      ...Array(2).fill(0).map(() => entry({ created_at: daysAgo(0).toISOString() })),
    ];
    const s = summarizeApiKeyDailyVolume('BIL', entries, 7, NOW);
    // firstHalf mean=4, secondHalf mean=2 → growth = (2-4)/4 = -0.5
    expect(s.growth_rate).toBeCloseTo(-0.5);
  });

  test('null when first-half mean = 0', () => {
    const s = summarizeApiKeyDailyVolume(
      'BIL',
      [entry({ created_at: daysAgo(1).toISOString() })],
      7,
      NOW,
    );
    expect(s.growth_rate).toBeNull();
  });

  test('null when days=1', () => {
    const s = summarizeApiKeyDailyVolume('BIL', [], 1, NOW);
    expect(s.growth_rate).toBeNull();
  });
});

describe('M1.9 — partition invariants', () => {
  test('Σ by_status per day = day.total', () => {
    const s = summarizeApiKeyDailyVolume(
      'BIL',
      [
        entry({ created_at: NOW.toISOString(), status: 'active' }),
        entry({ created_at: NOW.toISOString(), status: 'revoked' }),
      ],
      7,
      NOW,
    );
    for (const b of s.by_day) {
      const sum = Object.values(b.by_status).reduce((a, c) => a + c, 0);
      expect(sum).toBe(b.total);
    }
  });

  test('Σ by_day = total_created_in_window', () => {
    const s = summarizeApiKeyDailyVolume(
      'BIL',
      [
        entry({ created_at: daysAgo(1).toISOString() }),
        entry({ created_at: daysAgo(2).toISOString() }),
        entry({ created_at: daysAgo(3).toISOString() }),
      ],
      7,
      NOW,
    );
    const sum = s.by_day.reduce((acc, b) => acc + b.total, 0);
    expect(sum).toBe(s.total_created_in_window);
  });

  test('total_active + total_revoked = total_created_in_window when all statuses are known', () => {
    const s = summarizeApiKeyDailyVolume(
      'BIL',
      [
        entry({ created_at: daysAgo(1).toISOString(), status: 'active' }),
        entry({ created_at: daysAgo(1).toISOString(), status: 'revoked' }),
      ],
      7,
      NOW,
    );
    expect(s.total_active_in_window + s.total_revoked_in_window).toBe(s.total_created_in_window);
  });
});

describe('M1.9 — tenant_id echo', () => {
  test('tenant_id surfaces in envelope', () => {
    const s = summarizeApiKeyDailyVolume('BANK_DEMO', [], 7, NOW);
    expect(s.tenant_id).toBe('BANK_DEMO');
  });
});

describe('M1.9 — invalid days throws', () => {
  test('days=0 throws ApiKeyDailyVolumeError', () => {
    expect(() => summarizeApiKeyDailyVolume('BIL', [], 0, NOW)).toThrow(ApiKeyDailyVolumeError);
  });

  test('days=366 throws', () => {
    expect(() => summarizeApiKeyDailyVolume('BIL', [], 366, NOW)).toThrow(ApiKeyDailyVolumeError);
  });

  test('non-integer throws', () => {
    expect(() => summarizeApiKeyDailyVolume('BIL', [], 3.5, NOW)).toThrow(ApiKeyDailyVolumeError);
  });

  test('days=365 accepted at boundary', () => {
    const s = summarizeApiKeyDailyVolume('BIL', [], 365, NOW);
    expect(s.days).toBe(365);
    expect(s.by_day.length).toBe(365);
  });
});

// ─── GET /v1/admin/api-keys/daily-volume ─────────────────────────────

describe('M1.9 — GET /v1/admin/api-keys/daily-volume', () => {
  test('admin → 200 with default 30-day empty window', async () => {
    const { app } = makeDvApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/daily-volume').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.days).toBe(30);
    expect(r.body.body.by_day.length).toBe(30);
    expect(r.body.body.total_created_in_window).toBe(0);
    expect(r.body.body.peak_day).toBeNull();
  });

  test('populated timeline reflects created keys', async () => {
    const { app, store } = makeDvApp('admin');
    store.create('BIL', { name: 'k1', scopes: ['audit:read'] }, 'alice', NOW);
    store.create('BIL', { name: 'k2', scopes: ['audit:read'] }, 'alice', NOW);
    const r = await request(app).get('/v1/admin/api-keys/daily-volume?days=7').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.days).toBe(7);
    expect(r.body.body.total_created_in_window).toBe(2);
    expect(r.body.body.peak_day).toBe('2026-05-17');
    expect(r.body.body.peak_count).toBe(2);
    expect(r.body.body.total_active_in_window).toBe(2);
  });

  test('?days=0 → 400 envelope', async () => {
    const { app } = makeDvApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/daily-volume?days=0').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?days=400 → 400 envelope', async () => {
    const { app } = makeDvApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/daily-volume?days=400').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('?days=abc → 400 envelope', async () => {
    const { app } = makeDvApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/daily-volume?days=abc').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeDvApp('case_owner');
    const r = await request(app).get('/v1/admin/api-keys/daily-volume').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL keys invisible to BANK_DEMO', async () => {
    const { app, store } = makeDvApp('admin');
    store.create('BIL', { name: 'k1', scopes: ['audit:read'] }, 'alice', NOW);
    const bank = await request(app)
      .get('/v1/admin/api-keys/daily-volume')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_created_in_window).toBe(0);
  });

  test('literal `/daily-volume` not captured by `:key_id` wildcard', async () => {
    const { app } = makeDvApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/daily-volume').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('M1.8 /v1/admin/api-keys/scope-status-matrix still 200 (sibling regression)', async () => {
    const { app } = makeDvApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/scope-status-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M1.5 /v1/admin/api-keys/scope-distribution still 200 (sibling regression)', async () => {
    const { app } = makeDvApp('admin');
    const r = await request(app).get('/v1/admin/api-keys/scope-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
