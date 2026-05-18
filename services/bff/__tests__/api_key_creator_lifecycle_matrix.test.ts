// services/bff/__tests__/api_key_creator_lifecycle_matrix.test.ts
//
// T6 M1.11 — API key creator × lifecycle stage cross-tab matrix.

import request from 'supertest';
import { buildApiKeyCreatorLifecycleMatrix } from '../src/api_key_creator_lifecycle_matrix';
import { ALL_API_KEY_LIFECYCLE_STAGES } from '../src/api_key_lifecycle_distribution';
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

function makeClmApp(role: string = 'admin', apiKeyStore?: ApiKeyStore) {
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

describe('M1.11 — empty input', () => {
  test('zero keys → empty rows + 7 cols at 0 + null peak', () => {
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', [], NOW);
    expect(s.total_keys).toBe(0);
    expect(s.total_creators).toBe(0);
    expect(s.total_stages).toBe(7);
    expect(s.rows).toEqual([]);
    expect(s.columns.length).toBe(7);
    for (const c of s.columns) {
      expect(c.total).toBe(0);
      expect(c.top_creators).toEqual([]);
      expect(c.distinct_creators).toBe(0);
    }
    expect(s.peak_cell).toBeNull();
    expect(s.top_attention_creator).toBeNull();
  });
});

describe('M1.11 — canonical column order', () => {
  test('columns[] in canonical lifecycle stage order', () => {
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', [], NOW);
    expect(s.columns.map((c) => c.stage)).toEqual([...ALL_API_KEY_LIFECYCLE_STAGES]);
  });
});

describe('M1.11 — single key single creator', () => {
  test('alice with 1 fresh key → 1 row with by_stage.fresh=1', () => {
    const k = key({ created_by: 'alice' });
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', [k], NOW);
    expect(s.total_creators).toBe(1);
    expect(s.rows[0].created_by).toBe('alice');
    expect(s.rows[0].total_keys).toBe(1);
    expect(s.rows[0].by_stage.fresh).toBe(1);
    expect(s.rows[0].by_stage.mature_active).toBe(0);
    expect(s.rows[0].attention_count).toBe(0); // fresh isn't attention
  });
});

describe('M1.11 — multi-creator cohort sorted desc', () => {
  test('alice 3 + bob 1 → alice first', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'alice' }),
      key({ key_id: 'k2', created_by: 'alice' }),
      key({ key_id: 'k3', created_by: 'alice' }),
      key({ key_id: 'k4', created_by: 'bob' }),
    ];
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', keys, NOW);
    expect(s.rows[0].created_by).toBe('alice');
    expect(s.rows[0].total_keys).toBe(3);
    expect(s.rows[1].created_by).toBe('bob');
  });

  test('canonical username asc tie-break at tied counts', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'zoe' }),
      key({ key_id: 'k2', created_by: 'alice' }),
    ];
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', keys, NOW);
    expect(s.rows[0].created_by).toBe('alice');
    expect(s.rows[1].created_by).toBe('zoe');
  });
});

describe('M1.11 — every by_stage carries 7 keys', () => {
  test('all stage keys at 0 when absent', () => {
    const k = key({ created_by: 'alice' });
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', [k], NOW);
    expect(Object.keys(s.rows[0].by_stage).length).toBe(7);
    for (const stage of ALL_API_KEY_LIFECYCLE_STAGES) {
      expect(s.rows[0].by_stage[stage]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('M1.11 — stages_without per row', () => {
  test('alice with only fresh → other 6 stages in stages_without', () => {
    const k = key({ created_by: 'alice' });
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', [k], NOW);
    expect(s.rows[0].stages_without.length).toBe(6);
    expect(s.rows[0].stages_without).not.toContain('fresh');
  });
});

describe('M1.11 — attention_count', () => {
  test('expired + dormant + idle counted, not fresh/mature/revoked', () => {
    const keys: ApiKeyEntry[] = [
      // alice's 4 keys, 3 attention + 1 fresh
      key({
        key_id: 'k1',
        created_by: 'alice',
        expires_at: new Date(NOW.getTime() - DAY).toISOString(),
      }), // expired
      key({
        key_id: 'k2',
        created_by: 'alice',
        created_at: new Date(NOW.getTime() - 40 * DAY).toISOString(),
      }), // idle_never_used
      key({
        key_id: 'k3',
        created_by: 'alice',
        created_at: new Date(NOW.getTime() - 100 * DAY).toISOString(),
        last_used_at: new Date(NOW.getTime() - 60 * DAY).toISOString(),
      }), // dormant
      key({ key_id: 'k4', created_by: 'alice' }), // fresh
    ];
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', keys, NOW);
    expect(s.rows[0].attention_count).toBe(3);
  });

  test('zero when all keys healthy', () => {
    const k = key({ created_by: 'alice' });
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', [k], NOW);
    expect(s.rows[0].attention_count).toBe(0);
  });
});

describe('M1.11 — per-column rollup', () => {
  test('fresh column counts across creators', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'alice' }),
      key({ key_id: 'k2', created_by: 'alice' }),
      key({ key_id: 'k3', created_by: 'bob' }),
    ];
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', keys, NOW);
    const freshCol = s.columns.find((c) => c.stage === 'fresh')!;
    expect(freshCol.total).toBe(3);
    expect(freshCol.distinct_creators).toBe(2);
    expect(freshCol.top_creators[0]).toEqual({ created_by: 'alice', count: 2 });
    expect(freshCol.top_creators[1]).toEqual({ created_by: 'bob', count: 1 });
  });

  test('top_creators canonical username asc tie-break at tied counts', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'zoe' }),
      key({ key_id: 'k2', created_by: 'alice' }),
    ];
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', keys, NOW);
    const freshCol = s.columns.find((c) => c.stage === 'fresh')!;
    expect(freshCol.top_creators[0].created_by).toBe('alice');
  });

  test('top_creators cap 10', () => {
    const keys: ApiKeyEntry[] = [];
    for (let i = 0; i < 15; i++) {
      keys.push(key({ key_id: `k${i}`, created_by: `user-${String(i).padStart(2, '0')}` }));
    }
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', keys, NOW);
    const freshCol = s.columns.find((c) => c.stage === 'fresh')!;
    expect(freshCol.distinct_creators).toBe(15);
    expect(freshCol.top_creators.length).toBe(10);
  });
});

describe('M1.11 — peak_cell', () => {
  test('finds highest cell across matrix', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'alice' }),
      key({ key_id: 'k2', created_by: 'alice' }),
      key({ key_id: 'k3', created_by: 'alice' }),
      key({ key_id: 'k4', created_by: 'bob' }),
    ];
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', keys, NOW);
    expect(s.peak_cell?.created_by).toBe('alice');
    expect(s.peak_cell?.stage).toBe('fresh');
    expect(s.peak_cell?.count).toBe(3);
  });

  test('null on empty', () => {
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', [], NOW);
    expect(s.peak_cell).toBeNull();
  });
});

describe('M1.11 — top_attention_creator', () => {
  test('creator with most attention_count wins', () => {
    const keys: ApiKeyEntry[] = [
      // alice has 1 expired (attention=1)
      key({
        key_id: 'k1',
        created_by: 'alice',
        expires_at: new Date(NOW.getTime() - DAY).toISOString(),
      }),
      // bob has 1 dormant + 1 idle (attention=2)
      key({
        key_id: 'k2',
        created_by: 'bob',
        created_at: new Date(NOW.getTime() - 100 * DAY).toISOString(),
        last_used_at: new Date(NOW.getTime() - 60 * DAY).toISOString(),
      }),
      key({
        key_id: 'k3',
        created_by: 'bob',
        created_at: new Date(NOW.getTime() - 40 * DAY).toISOString(),
      }),
    ];
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', keys, NOW);
    expect(s.top_attention_creator).toBe('bob');
  });

  test('null when no attention-needed keys', () => {
    const k = key({ created_by: 'alice' });
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', [k], NOW);
    expect(s.top_attention_creator).toBeNull();
  });

  test('canonical username asc tie-break', () => {
    const keys: ApiKeyEntry[] = [
      key({
        key_id: 'k1',
        created_by: 'alice',
        expires_at: new Date(NOW.getTime() - DAY).toISOString(),
      }),
      key({
        key_id: 'k2',
        created_by: 'bob',
        expires_at: new Date(NOW.getTime() - DAY).toISOString(),
      }),
    ];
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', keys, NOW);
    expect(s.top_attention_creator).toBe('alice');
  });
});

describe('M1.11 — partition invariants', () => {
  test('Σ row.total_keys = total_keys', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'alice' }),
      key({ key_id: 'k2', created_by: 'bob' }),
    ];
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', keys, NOW);
    const sum = s.rows.reduce((acc, r) => acc + r.total_keys, 0);
    expect(sum).toBe(s.total_keys);
  });

  test('Σ row.by_stage = row.total_keys per row', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'alice' }),
      key({
        key_id: 'k2',
        created_by: 'alice',
        expires_at: new Date(NOW.getTime() - DAY).toISOString(),
      }),
    ];
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', keys, NOW);
    const row = s.rows[0];
    const sum = ALL_API_KEY_LIFECYCLE_STAGES.reduce((acc, s) => acc + row.by_stage[s], 0);
    expect(sum).toBe(row.total_keys);
  });

  test('Σ col.total = total_keys', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'alice' }),
      key({ key_id: 'k2', created_by: 'bob' }),
    ];
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', keys, NOW);
    const sum = s.columns.reduce((acc, c) => acc + c.total, 0);
    expect(sum).toBe(s.total_keys);
  });

  test('cell cross-check: row[creator].by_stage[stage] === col[stage].top_creators[creator]', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: 'alice' }),
      key({ key_id: 'k2', created_by: 'alice' }),
      key({ key_id: 'k3', created_by: 'bob' }),
    ];
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', keys, NOW);
    const freshCol = s.columns.find((c) => c.stage === 'fresh')!;
    const aliceTop = freshCol.top_creators.find((t) => t.created_by === 'alice')!;
    const aliceRow = s.rows.find((r) => r.created_by === 'alice')!;
    expect(aliceRow.by_stage.fresh).toBe(aliceTop.count);
  });
});

describe('M1.11 — null created_by defensively skipped', () => {
  test('key with empty created_by not counted', () => {
    const keys: ApiKeyEntry[] = [
      key({ key_id: 'k1', created_by: '' }),
      key({ key_id: 'k2', created_by: 'alice' }),
    ];
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', keys, NOW);
    expect(s.total_keys).toBe(1);
    expect(s.total_creators).toBe(1);
  });
});

describe('M1.11 — tenant_id + generated_at echo', () => {
  test('envelope echoes', () => {
    const s = buildApiKeyCreatorLifecycleMatrix('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M1.11 — GET /v1/admin/api-keys/creator-lifecycle-matrix', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeClmApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/creator-lifecycle-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(0);
    expect(r.body.body.columns.length).toBe(7);
    expect(r.body.body.rows).toEqual([]);
  });

  test('populated → reflects keys', async () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'Alice Key', scopes: ['alerts:read'] }, 'alice', NOW);
    store.create('BIL', { name: 'Bob Key', scopes: ['alerts:read'] }, 'bob', NOW);
    const { app } = makeClmApp('admin', store);
    const r = await request(app)
      .get('/v1/admin/api-keys/creator-lifecycle-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(2);
    expect(r.body.body.total_creators).toBe(2);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeClmApp('case_owner');
    const r = await request(app)
      .get('/v1/admin/api-keys/creator-lifecycle-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'BIL Key', scopes: ['alerts:read'] }, 'alice', NOW);
    const { app } = makeClmApp('admin', store);
    const bankR = await request(app)
      .get('/v1/admin/api-keys/creator-lifecycle-matrix')
      .set(TH_BANK);
    expect(bankR.status).toBe(200);
    expect(bankR.body.body.total_keys).toBe(0);
  });

  test('M1.10 /v1/admin/api-keys/lifecycle-distribution sibling regression still 200', async () => {
    const { app } = makeClmApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/lifecycle-distribution')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('literal `/creator-lifecycle-matrix` not captured by `:key_id` wildcard', async () => {
    const { app } = makeClmApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/creator-lifecycle-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.rows).toBeDefined();
  });
});
