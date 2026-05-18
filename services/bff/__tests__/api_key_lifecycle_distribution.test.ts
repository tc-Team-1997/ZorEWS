// services/bff/__tests__/api_key_lifecycle_distribution.test.ts
//
// T6 M1.10 — API key lifecycle stage distribution.

import request from 'supertest';
import {
  summarizeApiKeyLifecycleDistribution,
  ALL_API_KEY_LIFECYCLE_STAGES,
  EXPIRING_SOON_DAYS,
  DORMANT_DAYS,
  IDLE_NEVER_USED_DAYS,
  FRESH_DAYS,
} from '../src/api_key_lifecycle_distribution';
import {
  InMemoryApiKeyStore,
  type ApiKeyEntry,
  type ApiKeyStore,
} from '../src/api_keys';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeLdApp(role: string = 'admin', apiKeyStore?: ApiKeyStore) {
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

function key(overrides: Partial<ApiKeyEntry> = {}): ApiKeyEntry {
  return {
    key_id: 'k-' + Math.random().toString(36).slice(2, 10),
    tenant_id: 'BIL',
    name: 'Test Key',
    prefix: 'abcdef',
    scopes: ['alerts:read'],
    status: 'active',
    created_by: 'alice',
    created_at: NOW.toISOString(),
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    revoked_by: null,
    ...overrides,
  };
}

const DAY = 24 * 60 * 60 * 1000;

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M1.10 — empty input', () => {
  test('zero keys → 7 zero stages + null peak', () => {
    const s = summarizeApiKeyLifecycleDistribution('BIL', [], NOW);
    expect(s.total_keys).toBe(0);
    expect(s.stages.length).toBe(7);
    for (const stage of s.stages) {
      expect(stage.count).toBe(0);
      expect(stage.sample_key_ids).toEqual([]);
    }
    expect(s.peak_stage).toBeNull();
    expect(s.peak_count).toBe(0);
    expect(s.attention_stages).toEqual([]);
  });
});

describe('M1.10 — canonical stage order', () => {
  test('stages[] in priority order', () => {
    const s = summarizeApiKeyLifecycleDistribution('BIL', [], NOW);
    expect(s.stages.map((r) => r.stage)).toEqual([...ALL_API_KEY_LIFECYCLE_STAGES]);
  });

  test('every stage has label', () => {
    const s = summarizeApiKeyLifecycleDistribution('BIL', [], NOW);
    for (const stage of s.stages) {
      expect(stage.label.length).toBeGreaterThan(0);
    }
  });
});

describe('M1.10 — revoked stage (terminal, highest priority)', () => {
  test('revoked key always classified as revoked', () => {
    // even with expires_at in the past, revoked wins
    const k = key({
      key_id: 'k-rev',
      status: 'revoked',
      expires_at: new Date(NOW.getTime() - DAY).toISOString(),
      revoked_at: NOW.toISOString(),
      revoked_by: 'admin',
    });
    const s = summarizeApiKeyLifecycleDistribution('BIL', [k], NOW);
    const revoked = s.stages.find((r) => r.stage === 'revoked')!;
    expect(revoked.count).toBe(1);
    expect(s.stages.find((r) => r.stage === 'expired')!.count).toBe(0);
  });
});

describe('M1.10 — expired stage', () => {
  test('active + expires_at in past → expired', () => {
    const k = key({
      key_id: 'k-exp',
      expires_at: new Date(NOW.getTime() - DAY).toISOString(),
    });
    const s = summarizeApiKeyLifecycleDistribution('BIL', [k], NOW);
    expect(s.stages.find((r) => r.stage === 'expired')!.count).toBe(1);
  });
});

describe('M1.10 — expiring_soon stage', () => {
  test('active + expires_at within 30d → expiring_soon', () => {
    const k = key({
      key_id: 'k-soon',
      expires_at: new Date(NOW.getTime() + 15 * DAY).toISOString(),
    });
    const s = summarizeApiKeyLifecycleDistribution('BIL', [k], NOW);
    expect(s.stages.find((r) => r.stage === 'expiring_soon')!.count).toBe(1);
  });

  test('expires_at beyond 30d → not expiring_soon', () => {
    const k = key({
      key_id: 'k-far',
      expires_at: new Date(NOW.getTime() + 100 * DAY).toISOString(),
      last_used_at: new Date(NOW.getTime() - DAY).toISOString(),
    });
    const s = summarizeApiKeyLifecycleDistribution('BIL', [k], NOW);
    expect(s.stages.find((r) => r.stage === 'expiring_soon')!.count).toBe(0);
    expect(s.stages.find((r) => r.stage === 'mature_active')!.count).toBe(1);
  });
});

describe('M1.10 — idle_never_used stage', () => {
  test('active + never used + >= 30d old → idle_never_used', () => {
    const k = key({
      key_id: 'k-idle',
      created_at: new Date(NOW.getTime() - 40 * DAY).toISOString(),
      last_used_at: null,
    });
    const s = summarizeApiKeyLifecycleDistribution('BIL', [k], NOW);
    expect(s.stages.find((r) => r.stage === 'idle_never_used')!.count).toBe(1);
  });
});

describe('M1.10 — dormant stage', () => {
  test('active + ever used + last use > 30d ago → dormant', () => {
    const k = key({
      key_id: 'k-dorm',
      created_at: new Date(NOW.getTime() - 100 * DAY).toISOString(),
      last_used_at: new Date(NOW.getTime() - 60 * DAY).toISOString(),
    });
    const s = summarizeApiKeyLifecycleDistribution('BIL', [k], NOW);
    expect(s.stages.find((r) => r.stage === 'dormant')!.count).toBe(1);
  });
});

describe('M1.10 — fresh stage', () => {
  test('active + < 7d old + never used → fresh', () => {
    const k = key({
      key_id: 'k-fresh',
      created_at: new Date(NOW.getTime() - 3 * DAY).toISOString(),
      last_used_at: null,
    });
    const s = summarizeApiKeyLifecycleDistribution('BIL', [k], NOW);
    expect(s.stages.find((r) => r.stage === 'fresh')!.count).toBe(1);
  });
});

describe('M1.10 — mature_active stage', () => {
  test('active + ever used + recent use → mature_active', () => {
    const k = key({
      key_id: 'k-mature',
      created_at: new Date(NOW.getTime() - 60 * DAY).toISOString(),
      last_used_at: new Date(NOW.getTime() - DAY).toISOString(),
    });
    const s = summarizeApiKeyLifecycleDistribution('BIL', [k], NOW);
    expect(s.stages.find((r) => r.stage === 'mature_active')!.count).toBe(1);
  });

  test('active + recent created + recently used → mature_active (not fresh, since fresh requires never-used)', () => {
    const k = key({
      key_id: 'k-mat',
      created_at: new Date(NOW.getTime() - 3 * DAY).toISOString(),
      last_used_at: new Date(NOW.getTime() - DAY).toISOString(),
    });
    const s = summarizeApiKeyLifecycleDistribution('BIL', [k], NOW);
    expect(s.stages.find((r) => r.stage === 'mature_active')!.count).toBe(1);
    expect(s.stages.find((r) => r.stage === 'fresh')!.count).toBe(0);
  });
});

describe('M1.10 — priority order (overlapping flags → first-match wins)', () => {
  test('revoked + expired → revoked wins (priority)', () => {
    const k = key({
      status: 'revoked',
      expires_at: new Date(NOW.getTime() - DAY).toISOString(),
    });
    const s = summarizeApiKeyLifecycleDistribution('BIL', [k], NOW);
    expect(s.stages.find((r) => r.stage === 'revoked')!.count).toBe(1);
    expect(s.stages.find((r) => r.stage === 'expired')!.count).toBe(0);
  });

  test('expired + dormant → expired wins (higher priority)', () => {
    const k = key({
      created_at: new Date(NOW.getTime() - 100 * DAY).toISOString(),
      last_used_at: new Date(NOW.getTime() - 60 * DAY).toISOString(),
      expires_at: new Date(NOW.getTime() - DAY).toISOString(),
    });
    const s = summarizeApiKeyLifecycleDistribution('BIL', [k], NOW);
    expect(s.stages.find((r) => r.stage === 'expired')!.count).toBe(1);
    expect(s.stages.find((r) => r.stage === 'dormant')!.count).toBe(0);
  });

  test('expiring_soon + dormant → expiring_soon wins', () => {
    const k = key({
      created_at: new Date(NOW.getTime() - 100 * DAY).toISOString(),
      last_used_at: new Date(NOW.getTime() - 60 * DAY).toISOString(),
      expires_at: new Date(NOW.getTime() + 15 * DAY).toISOString(),
    });
    const s = summarizeApiKeyLifecycleDistribution('BIL', [k], NOW);
    expect(s.stages.find((r) => r.stage === 'expiring_soon')!.count).toBe(1);
    expect(s.stages.find((r) => r.stage === 'dormant')!.count).toBe(0);
  });
});

describe('M1.10 — sample_key_ids cap 5 sorted asc', () => {
  test('caps at 5 + sorted', () => {
    const keys: ApiKeyEntry[] = [];
    for (let i = 0; i < 7; i++) {
      keys.push(
        key({
          key_id: `k-${String(i).padStart(2, '0')}`,
          name: `Key ${i}`,
        }),
      );
    }
    const s = summarizeApiKeyLifecycleDistribution('BIL', keys, NOW);
    const mature = s.stages.find((r) => r.stage === 'mature_active')!;
    // All 7 keys with last_used_at=null + created_at=NOW + no expires →
    // fresh actually (< 7d, never used)
    const fresh = s.stages.find((r) => r.stage === 'fresh')!;
    expect(fresh.count).toBe(7);
    expect(fresh.sample_key_ids.length).toBe(5);
    expect(fresh.sample_key_ids[0]).toBe('k-00');
    expect(fresh.sample_names[0]).toBe('Key 0');
    void mature;
  });
});

describe('M1.10 — peak_stage', () => {
  test('highest-count stage; canonical tie-break (revoked > expired)', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k-1', status: 'revoked' }),
      key({ key_id: 'k-2', status: 'revoked' }),
      key({
        key_id: 'k-3',
        expires_at: new Date(NOW.getTime() - DAY).toISOString(),
      }),
    ];
    const s = summarizeApiKeyLifecycleDistribution('BIL', keys, NOW);
    expect(s.peak_stage).toBe('revoked');
    expect(s.peak_count).toBe(2);
  });

  test('canonical iteration tie-break at tied 1: revoked beats expired', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k-1', status: 'revoked' }),
      key({
        key_id: 'k-2',
        expires_at: new Date(NOW.getTime() - DAY).toISOString(),
      }),
    ];
    const s = summarizeApiKeyLifecycleDistribution('BIL', keys, NOW);
    expect(s.peak_stage).toBe('revoked');
  });

  test('null on empty', () => {
    const s = summarizeApiKeyLifecycleDistribution('BIL', [], NOW);
    expect(s.peak_stage).toBeNull();
  });
});

describe('M1.10 — empty_stages', () => {
  test('canonical-order zero-count subset', () => {
    const k = key({ key_id: 'k-1' });
    const s = summarizeApiKeyLifecycleDistribution('BIL', [k], NOW);
    expect(s.empty_stages.length).toBe(6); // 7 stages, 1 used (fresh)
    expect(s.empty_stages).not.toContain('fresh');
  });
});

describe('M1.10 — attention_stages', () => {
  test('subset filter — expired + expiring_soon + idle_never_used + dormant', () => {
    const keys: ApiKeyEntry[] = [
      key({
        key_id: 'k-exp',
        expires_at: new Date(NOW.getTime() - DAY).toISOString(),
      }),
      key({
        key_id: 'k-soon',
        expires_at: new Date(NOW.getTime() + 15 * DAY).toISOString(),
      }),
      key({
        key_id: 'k-idle',
        created_at: new Date(NOW.getTime() - 40 * DAY).toISOString(),
      }),
      key({
        key_id: 'k-dorm',
        created_at: new Date(NOW.getTime() - 100 * DAY).toISOString(),
        last_used_at: new Date(NOW.getTime() - 60 * DAY).toISOString(),
      }),
      // healthy: should NOT surface in attention
      key({
        key_id: 'k-mat',
        created_at: new Date(NOW.getTime() - 60 * DAY).toISOString(),
        last_used_at: new Date(NOW.getTime() - DAY).toISOString(),
      }),
    ];
    const s = summarizeApiKeyLifecycleDistribution('BIL', keys, NOW);
    expect(s.attention_stages).toEqual([
      'expired',
      'expiring_soon',
      'idle_never_used',
      'dormant',
    ]);
  });

  test('sorted by count desc + canonical order tie-break', () => {
    const keys: ApiKeyEntry[] = [
      // 2 expired + 1 dormant + 1 expiring_soon
      key({ key_id: 'e1', expires_at: new Date(NOW.getTime() - DAY).toISOString() }),
      key({ key_id: 'e2', expires_at: new Date(NOW.getTime() - DAY).toISOString() }),
      key({
        key_id: 'd1',
        created_at: new Date(NOW.getTime() - 100 * DAY).toISOString(),
        last_used_at: new Date(NOW.getTime() - 60 * DAY).toISOString(),
      }),
      key({
        key_id: 's1',
        expires_at: new Date(NOW.getTime() + 15 * DAY).toISOString(),
      }),
    ];
    const s = summarizeApiKeyLifecycleDistribution('BIL', keys, NOW);
    // expired (2) > expiring_soon (1) > dormant (1) — canonical order
    // tie-break on the second two
    expect(s.attention_stages[0]).toBe('expired');
  });

  test('empty when no attention-needed keys', () => {
    const k = key({ key_id: 'k-1' }); // fresh
    const s = summarizeApiKeyLifecycleDistribution('BIL', [k], NOW);
    expect(s.attention_stages).toEqual([]);
  });
});

describe('M1.10 — exported thresholds', () => {
  test('threshold constants exposed', () => {
    expect(EXPIRING_SOON_DAYS).toBe(30);
    expect(DORMANT_DAYS).toBe(30);
    expect(IDLE_NEVER_USED_DAYS).toBe(30);
    expect(FRESH_DAYS).toBe(7);
  });
});

describe('M1.10 — partition invariant', () => {
  test('Σ stages.count = total_keys', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k-1' }),
      key({ key_id: 'k-2', status: 'revoked' }),
      key({
        key_id: 'k-3',
        expires_at: new Date(NOW.getTime() - DAY).toISOString(),
      }),
    ];
    const s = summarizeApiKeyLifecycleDistribution('BIL', keys, NOW);
    const sum = s.stages.reduce((acc, r) => acc + r.count, 0);
    expect(sum).toBe(s.total_keys);
    expect(s.total_keys).toBe(3);
  });
});

describe('M1.10 — tenant_id + generated_at echo', () => {
  test('envelope echoes', () => {
    const s = summarizeApiKeyLifecycleDistribution('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M1.10 — GET /v1/admin/api-keys/lifecycle-distribution', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeLdApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/lifecycle-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(0);
    expect(r.body.body.stages.length).toBe(7);
  });

  test('populated → reflects keys', async () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'Test', scopes: ['alerts:read'] }, 'alice', NOW);
    const { app } = makeLdApp('admin', store);
    const r = await request(app)
      .get('/v1/admin/api-keys/lifecycle-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(1);
    expect(r.body.body.peak_stage).toBe('fresh');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeLdApp('case_owner');
    const r = await request(app)
      .get('/v1/admin/api-keys/lifecycle-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'BIL Key', scopes: ['alerts:read'] }, 'alice', NOW);
    const { app } = makeLdApp('admin', store);
    const bankR = await request(app)
      .get('/v1/admin/api-keys/lifecycle-distribution')
      .set(TH_BANK);
    expect(bankR.status).toBe(200);
    expect(bankR.body.body.total_keys).toBe(0);
  });

  test('M1.9 /v1/admin/api-keys/daily-volume sibling regression still 200', async () => {
    const { app } = makeLdApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/daily-volume')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('literal `/lifecycle-distribution` not captured by `:key_id` wildcard', async () => {
    const { app } = makeLdApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/lifecycle-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.stages).toBeDefined();
  });
});
