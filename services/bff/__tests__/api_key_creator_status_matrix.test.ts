// T6 M1.14 — API key creator × status cross-tab matrix.

import request from 'supertest';
import { buildApiKeyCreatorStatusMatrix } from '../src/api_key_creator_status_matrix';
import {
  InMemoryApiKeyStore,
  type ApiKeyEntry,
  type ApiKeyStore,
} from '../src/api_keys';
import { ALL_API_KEY_STATUSES } from '../src/api_key_scope_status_matrix';
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

describe('M1.14 — buildApiKeyCreatorStatusMatrix', () => {
  test('empty input → empty rows + empty columns', () => {
    const m = buildApiKeyCreatorStatusMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.total_keys).toBe(0);
    expect(m.total_creators).toBe(0);
    expect(m.total_statuses).toBe(2);
    expect(m.creators).toEqual([]);
    expect(m.rows).toEqual([]);
    expect(m.columns.length).toBe(2);
    for (const col of m.columns) {
      expect(col.total).toBe(0);
      expect(col.by_creator).toEqual({});
      expect(col.top_creators).toEqual([]);
    }
    expect(m.peak_cell).toBeNull();
    expect(m.most_revoked_creator).toBeNull();
    expect(m.highest_revocation_rate_creator).toBeNull();
    expect(m.creators_with_zero_revocations).toEqual([]);
    expect(m.empty_cells).toEqual([]);
  });

  test('columns in canonical ALL_API_KEY_STATUSES order', () => {
    const m = buildApiKeyCreatorStatusMatrix('BIL', [], NOW);
    expect(m.columns.map((c) => c.status)).toEqual([...ALL_API_KEY_STATUSES]);
  });

  test('single active key creates 1 row + 1 cell populated', () => {
    const entries = [key({ created_by: 'alice', status: 'active' })];
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    expect(m.total_keys).toBe(1);
    expect(m.creators).toEqual(['alice']);
    expect(m.rows[0].by_status.active).toBe(1);
    expect(m.rows[0].by_status.revoked).toBe(0);
    expect(m.rows[0].revocation_rate).toBe(0);
    expect(m.rows[0].key_ids.length).toBe(1);
    const activeCol = m.columns.find((c) => c.status === 'active')!;
    expect(activeCol.by_creator.alice).toBe(1);
    expect(activeCol.distinct_creators).toBe(1);
  });

  test('every by_status key present per row (2 keys)', () => {
    const entries = [key({ created_by: 'alice' })];
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    for (const row of m.rows) {
      for (const s of ALL_API_KEY_STATUSES) {
        expect(row.by_status[s]).toBeGreaterThanOrEqual(0);
      }
      expect(Object.keys(row.by_status).length).toBe(2);
    }
  });

  test('rows sorted by total_keys desc + creator asc tie-break', () => {
    const entries = [
      // alice: 3 keys
      key({ key_id: 'k1', created_by: 'alice' }),
      key({ key_id: 'k2', created_by: 'alice' }),
      key({ key_id: 'k3', created_by: 'alice' }),
      // bob: 1 key
      key({ key_id: 'k4', created_by: 'bob' }),
      // alphazoe + zeta: 1 key each — alphazoe wins canonical asc
      key({ key_id: 'k5', created_by: 'zeta' }),
      key({ key_id: 'k6', created_by: 'alphazoe' }),
    ];
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    expect(m.rows.map((r) => r.created_by)).toEqual([
      'alice', // 3 keys first
      'alphazoe', // tied 1 — canonical asc
      'bob',
      'zeta',
    ]);
  });

  test('revocation_rate formula', () => {
    const entries = [
      key({ key_id: 'k1', created_by: 'alice', status: 'active' }),
      key({ key_id: 'k2', created_by: 'alice', status: 'active' }),
      key({ key_id: 'k3', created_by: 'alice', status: 'revoked' }),
    ];
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    const aliceRow = m.rows[0];
    expect(aliceRow.by_status.active).toBe(2);
    expect(aliceRow.by_status.revoked).toBe(1);
    expect(aliceRow.revocation_rate).toBeCloseTo(1 / 3);
  });

  test('Σ row.by_status = row.total_keys partition', () => {
    const entries = [
      key({ key_id: 'k1', created_by: 'alice', status: 'active' }),
      key({ key_id: 'k2', created_by: 'alice', status: 'revoked' }),
      key({ key_id: 'k3', created_by: 'bob', status: 'active' }),
    ];
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    for (const row of m.rows) {
      const sum = ALL_API_KEY_STATUSES.reduce(
        (a, s) => a + row.by_status[s],
        0,
      );
      expect(sum).toBe(row.total_keys);
    }
  });

  test('Σ col.by_creator = col.total partition', () => {
    const entries = [
      key({ key_id: 'k1', created_by: 'alice', status: 'active' }),
      key({ key_id: 'k2', created_by: 'bob', status: 'active' }),
      key({ key_id: 'k3', created_by: 'alice', status: 'revoked' }),
    ];
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    for (const col of m.columns) {
      const sum = Object.values(col.by_creator).reduce((a, n) => a + n, 0);
      expect(sum).toBe(col.total);
    }
  });

  test('grand-total Σ rows = Σ cols = total_keys', () => {
    const entries = [
      key({ key_id: 'k1', created_by: 'alice', status: 'active' }),
      key({ key_id: 'k2', created_by: 'bob', status: 'revoked' }),
      key({ key_id: 'k3', created_by: 'carol', status: 'active' }),
    ];
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    const rowSum = m.rows.reduce((a, r) => a + r.total_keys, 0);
    const colSum = m.columns.reduce((a, c) => a + c.total, 0);
    expect(rowSum).toBe(m.total_keys);
    expect(colSum).toBe(m.total_keys);
    expect(rowSum).toBe(3);
  });

  test('cell cross-check row.by_status[X] === col[X].by_creator[creator]', () => {
    const entries = [
      key({ key_id: 'k1', created_by: 'alice', status: 'active' }),
      key({ key_id: 'k2', created_by: 'alice', status: 'active' }),
      key({ key_id: 'k3', created_by: 'alice', status: 'revoked' }),
      key({ key_id: 'k4', created_by: 'bob', status: 'active' }),
    ];
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    for (const row of m.rows) {
      for (const s of ALL_API_KEY_STATUSES) {
        const fromRow = row.by_status[s];
        const col = m.columns.find((c) => c.status === s)!;
        const fromCol = col.by_creator[row.created_by] ?? 0;
        expect(fromRow).toBe(fromCol);
      }
    }
  });

  test('key_ids cap 50 sorted asc per row', () => {
    const entries: ApiKeyEntry[] = [];
    for (let i = 0; i < 60; i++) {
      entries.push(
        key({
          key_id: `k-${String(i).padStart(3, '0')}`,
          created_by: 'alice',
        }),
      );
    }
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    expect(m.rows[0].key_ids.length).toBe(50);
    const sorted = [...m.rows[0].key_ids].sort((a, b) => a.localeCompare(b));
    expect(m.rows[0].key_ids).toEqual(sorted);
  });

  test('top_creators cap 3 + canonical asc tie-break', () => {
    const entries: ApiKeyEntry[] = [];
    // 5 creators all 1 active key
    for (let i = 0; i < 5; i++) {
      entries.push(
        key({
          key_id: `k${i}`,
          created_by: `user-${String(i).padStart(2, '0')}`,
        }),
      );
    }
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    const activeCol = m.columns.find((c) => c.status === 'active')!;
    expect(activeCol.top_creators.length).toBe(3);
    expect(activeCol.top_creators.map((t) => t.created_by)).toEqual([
      'user-00',
      'user-01',
      'user-02',
    ]);
  });

  test('peak_cell formula', () => {
    const entries = [
      // alice/active: 5
      key({ key_id: 'k1', created_by: 'alice', status: 'active' }),
      key({ key_id: 'k2', created_by: 'alice', status: 'active' }),
      key({ key_id: 'k3', created_by: 'alice', status: 'active' }),
      key({ key_id: 'k4', created_by: 'alice', status: 'active' }),
      key({ key_id: 'k5', created_by: 'alice', status: 'active' }),
      // bob/revoked: 1
      key({ key_id: 'k6', created_by: 'bob', status: 'revoked' }),
    ];
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    expect(m.peak_cell).toEqual({
      created_by: 'alice',
      status: 'active',
      count: 5,
    });
  });

  test('peak_cell canonical iteration tie-break', () => {
    const entries = [
      // alice/active and bob/revoked both 1
      key({ key_id: 'k1', created_by: 'alice', status: 'active' }),
      key({ key_id: 'k2', created_by: 'bob', status: 'revoked' }),
    ];
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    // alice iterates first canonical
    expect(m.peak_cell?.created_by).toBe('alice');
    expect(m.peak_cell?.status).toBe('active');
  });

  test('peak_cell null on empty', () => {
    const m = buildApiKeyCreatorStatusMatrix('BIL', [], NOW);
    expect(m.peak_cell).toBeNull();
  });

  test('most_revoked_creator formula', () => {
    const entries = [
      // alice: 3 revoked
      key({ key_id: 'k1', created_by: 'alice', status: 'revoked' }),
      key({ key_id: 'k2', created_by: 'alice', status: 'revoked' }),
      key({ key_id: 'k3', created_by: 'alice', status: 'revoked' }),
      // bob: 1 revoked, 5 active
      key({ key_id: 'k4', created_by: 'bob', status: 'revoked' }),
      key({ key_id: 'k5', created_by: 'bob', status: 'active' }),
      key({ key_id: 'k6', created_by: 'bob', status: 'active' }),
      key({ key_id: 'k7', created_by: 'bob', status: 'active' }),
      key({ key_id: 'k8', created_by: 'bob', status: 'active' }),
      key({ key_id: 'k9', created_by: 'bob', status: 'active' }),
    ];
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    // alice has 3 revoked (most absolute)
    expect(m.most_revoked_creator).toBe('alice');
    // alice revocation rate = 1.0 (all revoked); bob = 1/6
    expect(m.highest_revocation_rate_creator).toBe('alice');
  });

  test('most_revoked_creator canonical asc tie-break', () => {
    const entries = [
      key({ key_id: 'k1', created_by: 'zebra', status: 'revoked' }),
      key({ key_id: 'k2', created_by: 'alpha', status: 'revoked' }),
    ];
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    expect(m.most_revoked_creator).toBe('alpha');
  });

  test('most_revoked_creator null when zero revocations', () => {
    const entries = [
      key({ key_id: 'k1', created_by: 'alice', status: 'active' }),
    ];
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    expect(m.most_revoked_creator).toBeNull();
    expect(m.highest_revocation_rate_creator).toBeNull();
  });

  test('highest_revocation_rate_creator favors rate over count', () => {
    const entries = [
      // alice: 1 revoked / 1 total = 100%
      key({ key_id: 'k1', created_by: 'alice', status: 'revoked' }),
      // bob: 10 revoked / 100 total = 10% (more absolute revocations but lower rate)
      ...Array.from({ length: 10 }, (_, i) =>
        key({ key_id: `k-bob-r-${i}`, created_by: 'bob', status: 'revoked' as const }),
      ),
      ...Array.from({ length: 90 }, (_, i) =>
        key({ key_id: `k-bob-a-${i}`, created_by: 'bob', status: 'active' as const }),
      ),
    ];
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    expect(m.most_revoked_creator).toBe('bob'); // most absolute
    expect(m.highest_revocation_rate_creator).toBe('alice'); // highest rate
  });

  test('creators_with_zero_revocations sorted asc', () => {
    const entries = [
      // alice + zoe: 0 revocations; bob: 1 revocation
      key({ key_id: 'k1', created_by: 'alice', status: 'active' }),
      key({ key_id: 'k2', created_by: 'bob', status: 'revoked' }),
      key({ key_id: 'k3', created_by: 'zoe', status: 'active' }),
    ];
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    expect(m.creators_with_zero_revocations).toEqual(['alice', 'zoe']);
  });

  test('empty_cells in canonical creator asc × status canonical order', () => {
    const entries = [
      // alice has only active; bob has only revoked
      key({ key_id: 'k1', created_by: 'alice', status: 'active' }),
      key({ key_id: 'k2', created_by: 'bob', status: 'revoked' }),
    ];
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    // 2 creators × 2 statuses = 4 cells; 2 populated, 2 empty
    expect(m.empty_cells.length).toBe(2);
    // Canonical: alice/revoked (alice first creator, revoked = canonical 2nd status)
    expect(m.empty_cells[0]).toEqual({ created_by: 'alice', status: 'revoked' });
    expect(m.empty_cells[1]).toEqual({ created_by: 'bob', status: 'active' });
  });

  test('out-of-enum status silently skipped', () => {
    const entries = [
      { ...key({ created_by: 'alice' }), status: 'bogus' as never },
      key({ key_id: 'k2', created_by: 'bob', status: 'active' }),
    ];
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    expect(m.total_keys).toBe(1);
  });

  test('empty created_by silently skipped', () => {
    const entries = [
      key({ key_id: 'k1', created_by: '', status: 'active' }),
      key({ key_id: 'k2', created_by: 'bob', status: 'active' }),
    ];
    const m = buildApiKeyCreatorStatusMatrix('BIL', entries, NOW);
    expect(m.total_keys).toBe(1);
    expect(m.creators).toEqual(['bob']);
  });

  test('tenant_id + generated_at echo', () => {
    const m = buildApiKeyCreatorStatusMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.generated_at).toBe(NOW.toISOString());
  });
});

describe('M1.14 — GET /v1/admin/api-keys/creator-status-matrix', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/creator-status-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(0);
    expect(r.body.body.rows).toEqual([]);
    expect(r.body.body.columns.length).toBe(2);
  });

  test('populated reflects keys', async () => {
    const store = new InMemoryApiKeyStore();
    store.create(
      'BIL',
      { name: 'Alice 1', scopes: ['alerts:read'] },
      'alice',
      NOW,
    );
    store.create(
      'BIL',
      { name: 'Alice 2', scopes: ['cases:read'] },
      'alice',
      NOW,
    );
    const { app } = makeTestApp('admin', store);
    const r = await request(app)
      .get('/v1/admin/api-keys/creator-status-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(2);
    expect(r.body.body.peak_cell.created_by).toBe('alice');
    expect(r.body.body.peak_cell.status).toBe('active');
    expect(r.body.body.creators_with_zero_revocations).toEqual(['alice']);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeTestApp('case_owner');
    const r = await request(app)
      .get('/v1/admin/api-keys/creator-status-matrix')
      .set(TH);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const store = new InMemoryApiKeyStore();
    store.create('BIL', { name: 'BIL Key', scopes: ['alerts:read'] }, 'alice', NOW);
    const { app } = makeTestApp('admin', store);
    const r = await request(app)
      .get('/v1/admin/api-keys/creator-status-matrix')
      .set(TH_BANK);
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBe(0);
  });

  test('M1.12 /scope-creator-matrix sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/scope-creator-matrix')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('M1.13 /usage-recency-histogram sibling regression still 200', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/usage-recency-histogram')
      .set(TH);
    expect(r.status).toBe(200);
  });

  test('literal /creator-status-matrix not captured by /:key_id wildcard', async () => {
    const { app } = makeTestApp('admin');
    const r = await request(app)
      .get('/v1/admin/api-keys/creator-status-matrix')
      .set(TH);
    expect(r.status).toBe(200);
    expect(r.body.body.columns).toBeDefined();
  });
});
