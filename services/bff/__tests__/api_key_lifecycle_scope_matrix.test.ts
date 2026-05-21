// services/bff/__tests__/api_key_lifecycle_scope_matrix.test.ts
//
// T6 M1.16 — pure + HTTP route tests for the API key lifecycle stage
// × scope cross-tab matrix.

import { buildApiKeyLifecycleScopeMatrix } from '../src/api_key_lifecycle_scope_matrix';
import {
  type ApiKeyEntry,
  type ApiKeyScope,
  VALID_SCOPES,
} from '../src/api_keys';
import { ALL_API_KEY_LIFECYCLE_STAGES } from '../src/api_key_lifecycle_distribution';

const NOW = new Date('2026-05-21T12:00:00.000Z');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Helper: build an ApiKeyEntry with sensible defaults; override what
// matters for the test.
function mkEntry(opts: Partial<ApiKeyEntry> & { key_id: string }): ApiKeyEntry {
  return {
    key_id: opts.key_id,
    tenant_id: opts.tenant_id ?? 'BANK_DEMO',
    name: opts.name ?? `Key ${opts.key_id}`,
    prefix: opts.prefix ?? opts.key_id.slice(0, 8),
    status: opts.status ?? 'active',
    scopes: opts.scopes ?? ['alerts:read'],
    created_at: opts.created_at ?? new Date(NOW.getTime() - 5 * ONE_DAY_MS).toISOString(),
    created_by: opts.created_by ?? 'alice.admin',
    expires_at: opts.expires_at ?? null,
    last_used_at: opts.last_used_at ?? null,
    revoked_at: opts.revoked_at ?? null,
    revoked_by: opts.revoked_by ?? null,
  };
}

// Convenience: lifecycle-specific entry factories
function freshEntry(key_id: string, scopes: ApiKeyScope[]) {
  // Active + <7d old + never used → 'fresh'
  return mkEntry({
    key_id,
    scopes,
    created_at: new Date(NOW.getTime() - 3 * ONE_DAY_MS).toISOString(),
    last_used_at: null,
  });
}
function matureEntry(key_id: string, scopes: ApiKeyScope[]) {
  // Active + ever-used + recent → 'mature_active'
  return mkEntry({
    key_id,
    scopes,
    created_at: new Date(NOW.getTime() - 60 * ONE_DAY_MS).toISOString(),
    last_used_at: new Date(NOW.getTime() - 1 * ONE_DAY_MS).toISOString(),
  });
}
function dormantEntry(key_id: string, scopes: ApiKeyScope[]) {
  // Active + ever-used + >30d ago → 'dormant'
  return mkEntry({
    key_id,
    scopes,
    created_at: new Date(NOW.getTime() - 90 * ONE_DAY_MS).toISOString(),
    last_used_at: new Date(NOW.getTime() - 45 * ONE_DAY_MS).toISOString(),
  });
}
function idleNeverUsedEntry(key_id: string, scopes: ApiKeyScope[]) {
  // Active + never-used + ≥30d old → 'idle_never_used'
  return mkEntry({
    key_id,
    scopes,
    created_at: new Date(NOW.getTime() - 35 * ONE_DAY_MS).toISOString(),
    last_used_at: null,
  });
}
function expiredEntry(key_id: string, scopes: ApiKeyScope[]) {
  // Active + expires_at in past → 'expired'
  return mkEntry({
    key_id,
    scopes,
    expires_at: new Date(NOW.getTime() - 5 * ONE_DAY_MS).toISOString(),
  });
}
function expiringSoonEntry(key_id: string, scopes: ApiKeyScope[]) {
  // Active + expires_at in 10d → 'expiring_soon'
  return mkEntry({
    key_id,
    scopes,
    expires_at: new Date(NOW.getTime() + 10 * ONE_DAY_MS).toISOString(),
  });
}
function revokedEntry(key_id: string, scopes: ApiKeyScope[]) {
  return mkEntry({
    key_id,
    scopes,
    status: 'revoked',
    revoked_at: new Date(NOW.getTime() - 2 * ONE_DAY_MS).toISOString(),
    revoked_by: 'admin',
  });
}

// ---------------------------------------------------------------------
// Pure resolver
// ---------------------------------------------------------------------

describe('buildApiKeyLifecycleScopeMatrix — pure resolver', () => {
  test('empty input → 7 zero rows + N=VALID_SCOPES.length zero cols + null leaderboards', () => {
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', [], NOW);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.generated_at).toBe('2026-05-21T12:00:00.000Z');
    expect(r.total_keys).toBe(0);
    expect(r.total_bindings).toBe(0);
    expect(r.total_stages).toBe(ALL_API_KEY_LIFECYCLE_STAGES.length);
    expect(r.total_scopes).toBe(VALID_SCOPES.length);
    expect(r.rows).toHaveLength(ALL_API_KEY_LIFECYCLE_STAGES.length);
    expect(r.columns).toHaveLength(VALID_SCOPES.length);
    expect(r.peak_cell).toBeNull();
    expect(r.most_diverse_stage).toBeNull();
    expect(r.most_universal_scope).toBeNull();
    // Every row zero
    for (const row of r.rows) {
      expect(row.total).toBe(0);
      expect(row.distinct_scopes).toBe(0);
      expect(row.scopes_without).toEqual([...VALID_SCOPES]);
      // by_scope has every scope key
      expect(Object.keys(row.by_scope).sort()).toEqual([...VALID_SCOPES].sort());
    }
    // Every column zero
    for (const col of r.columns) {
      expect(col.total).toBe(0);
      expect(col.distinct_stages).toBe(0);
    }
    // empty_cells = 7 × N
    expect(r.empty_cells).toHaveLength(
      ALL_API_KEY_LIFECYCLE_STAGES.length * VALID_SCOPES.length,
    );
  });

  test('rows in canonical ALL_API_KEY_LIFECYCLE_STAGES order', () => {
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', [], NOW);
    expect(r.rows.map((row) => row.stage)).toEqual([
      ...ALL_API_KEY_LIFECYCLE_STAGES,
    ]);
  });

  test('columns in canonical VALID_SCOPES order', () => {
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', [], NOW);
    expect(r.columns.map((col) => col.scope)).toEqual([...VALID_SCOPES]);
  });

  test('single mature_active key with 1 scope → 1 cell populated', () => {
    const entries = [matureEntry('k-001', ['alerts:read'])];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', entries, NOW);
    expect(r.total_keys).toBe(1);
    expect(r.total_bindings).toBe(1);
    const matureRow = r.rows.find((row) => row.stage === 'mature_active')!;
    expect(matureRow.total).toBe(1);
    expect(matureRow.by_scope['alerts:read']).toBe(1);
    expect(matureRow.distinct_scopes).toBe(1);
    // All other scopes for mature_active should be 0
    for (const s of VALID_SCOPES) {
      if (s !== 'alerts:read') {
        expect(matureRow.by_scope[s]).toBe(0);
      }
    }
    // All other stage rows zero
    for (const row of r.rows) {
      if (row.stage !== 'mature_active') {
        expect(row.total).toBe(0);
      }
    }
  });

  test('multi-scope key contributes once per scope to its stage', () => {
    // 1 fresh key with 3 scopes → 3 bindings, total_keys=1
    const entries = [
      freshEntry('k-001', ['alerts:read', 'cases:read', 'audit:read']),
    ];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', entries, NOW);
    expect(r.total_keys).toBe(1);
    expect(r.total_bindings).toBe(3);
    const freshRow = r.rows.find((row) => row.stage === 'fresh')!;
    expect(freshRow.total).toBe(3);
    expect(freshRow.by_scope['alerts:read']).toBe(1);
    expect(freshRow.by_scope['cases:read']).toBe(1);
    expect(freshRow.by_scope['audit:read']).toBe(1);
    expect(freshRow.distinct_scopes).toBe(3);
  });

  test('intra-key scope dedup defensive (duplicate listed twice → 1 binding)', () => {
    const entry = freshEntry('k-001', ['alerts:read']);
    entry.scopes = ['alerts:read', 'alerts:read', 'alerts:read'];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', [entry], NOW);
    expect(r.total_bindings).toBe(1);
  });

  test('bogus scope value silently filtered (closed-enum guard)', () => {
    const entry = freshEntry('k-001', ['alerts:read']);
    entry.scopes = ['alerts:read', 'bogus_scope' as ApiKeyScope];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', [entry], NOW);
    expect(r.total_bindings).toBe(1); // bogus dropped
    expect(r.total_keys).toBe(1); // entry still counted
  });

  test('multiple lifecycle stages populated independently', () => {
    const entries = [
      freshEntry('k-fresh', ['alerts:read']),
      matureEntry('k-mature', ['cases:read']),
      revokedEntry('k-revoked', ['audit:read']),
    ];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', entries, NOW);
    expect(r.total_keys).toBe(3);
    expect(r.total_bindings).toBe(3);
    const freshRow = r.rows.find((row) => row.stage === 'fresh')!;
    const matureRow = r.rows.find((row) => row.stage === 'mature_active')!;
    const revokedRow = r.rows.find((row) => row.stage === 'revoked')!;
    expect(freshRow.by_scope['alerts:read']).toBe(1);
    expect(matureRow.by_scope['cases:read']).toBe(1);
    expect(revokedRow.by_scope['audit:read']).toBe(1);
  });

  test('per-row partition: Σ row.by_scope = row.total', () => {
    const entries = [
      freshEntry('k-001', ['alerts:read', 'cases:read']),
      freshEntry('k-002', ['audit:read']),
    ];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', entries, NOW);
    for (const row of r.rows) {
      const sum = Object.values(row.by_scope).reduce((a, b) => a + b, 0);
      expect(sum).toBe(row.total);
    }
  });

  test('per-col partition: Σ col.by_stage = col.total', () => {
    const entries = [
      freshEntry('k-001', ['alerts:read']),
      matureEntry('k-002', ['alerts:read']),
    ];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', entries, NOW);
    for (const col of r.columns) {
      const sum = Object.values(col.by_stage).reduce((a, b) => a + b, 0);
      expect(sum).toBe(col.total);
    }
  });

  test('grand-total partition: Σ rows.total = Σ cols.total = total_bindings', () => {
    const entries = [
      freshEntry('k-001', ['alerts:read', 'cases:read']),
      matureEntry('k-002', ['cases:read', 'audit:read']),
      revokedEntry('k-003', ['audit:read']),
    ];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', entries, NOW);
    const sumRows = r.rows.reduce((a, b) => a + b.total, 0);
    const sumCols = r.columns.reduce((a, b) => a + b.total, 0);
    expect(sumRows).toBe(r.total_bindings);
    expect(sumCols).toBe(r.total_bindings);
    expect(sumRows).toBe(5); // 2+2+1 bindings
  });

  test('cell cross-check invariant: row.by_scope[s] === col[s].by_stage[stage]', () => {
    const entries = [
      freshEntry('k-001', ['alerts:read']),
      freshEntry('k-002', ['cases:read']),
      matureEntry('k-003', ['alerts:read']),
    ];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', entries, NOW);
    for (const stage of ALL_API_KEY_LIFECYCLE_STAGES) {
      const row = r.rows.find((row) => row.stage === stage)!;
      for (const scope of VALID_SCOPES) {
        const col = r.columns.find((col) => col.scope === scope)!;
        expect(row.by_scope[scope]).toBe(col.by_stage[stage]);
      }
    }
  });

  test('every row has every ApiKeyScope key present (stable grid)', () => {
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', [], NOW);
    for (const row of r.rows) {
      expect(Object.keys(row.by_scope)).toHaveLength(VALID_SCOPES.length);
    }
  });

  test('every column has every ApiKeyLifecycleStage key present', () => {
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', [], NOW);
    for (const col of r.columns) {
      expect(Object.keys(col.by_stage).sort()).toEqual(
        [...ALL_API_KEY_LIFECYCLE_STAGES].sort(),
      );
    }
  });

  test('scopes_without per row in canonical order (mature row with 1 scope)', () => {
    const entries = [matureEntry('k-001', ['alerts:read'])];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', entries, NOW);
    const matureRow = r.rows.find((row) => row.stage === 'mature_active')!;
    // alerts:read populated, every other scope in scopes_without in canonical order
    const expected = VALID_SCOPES.filter((s) => s !== 'alerts:read');
    expect(matureRow.scopes_without).toEqual(expected);
  });

  test('stages_without per col canonical order (alerts:read with 1 mature key)', () => {
    const entries = [matureEntry('k-001', ['alerts:read'])];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', entries, NOW);
    const alertsCol = r.columns.find((col) => col.scope === 'alerts:read')!;
    // Only mature_active populated; every other stage in stages_without canonical
    const expected = ALL_API_KEY_LIFECYCLE_STAGES.filter(
      (s) => s !== 'mature_active',
    );
    expect(alertsCol.stages_without).toEqual(expected);
  });

  test('peak_cell formula + canonical iteration tie-break (earlier stage × earlier scope wins at tied count)', () => {
    // 1 revoked alerts:read + 1 fresh cases:read → tied at 1.
    // Canonical iteration: revoked is first in stages, alerts:read first in scopes.
    // So peak_cell = revoked/alerts:read.
    const entries = [
      revokedEntry('k-revoked', ['alerts:read']),
      freshEntry('k-fresh', ['cases:read']),
    ];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', entries, NOW);
    expect(r.peak_cell).not.toBeNull();
    expect(r.peak_cell!.stage).toBe('revoked');
    expect(r.peak_cell!.scope).toBe('alerts:read');
    expect(r.peak_cell!.count).toBe(1);
  });

  test('peak_cell formula: highest count wins over canonical position', () => {
    // 3 fresh/cases:read + 1 revoked/alerts:read → 3 > 1 → fresh/cases:read
    const entries = [
      freshEntry('k-001', ['cases:read']),
      freshEntry('k-002', ['cases:read']),
      freshEntry('k-003', ['cases:read']),
      revokedEntry('k-004', ['alerts:read']),
    ];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', entries, NOW);
    expect(r.peak_cell!.stage).toBe('fresh');
    expect(r.peak_cell!.scope).toBe('cases:read');
    expect(r.peak_cell!.count).toBe(3);
  });

  test('peak_cell sample_key_ids sorted asc + cap 5', () => {
    // 6 fresh keys all on alerts:read → samples cap 5, sorted asc
    const entries = [
      freshEntry('k-zebra', ['alerts:read']),
      freshEntry('k-apple', ['alerts:read']),
      freshEntry('k-mango', ['alerts:read']),
      freshEntry('k-banana', ['alerts:read']),
      freshEntry('k-cherry', ['alerts:read']),
      freshEntry('k-grape', ['alerts:read']),
    ];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', entries, NOW);
    expect(r.peak_cell!.count).toBe(6);
    expect(r.peak_cell!.sample_key_ids).toHaveLength(5);
    // Asc sort: apple, banana, cherry, grape, k-mango (k-zebra dropped)
    expect(r.peak_cell!.sample_key_ids).toEqual([
      'k-apple',
      'k-banana',
      'k-cherry',
      'k-grape',
      'k-mango',
    ]);
  });

  test('peak_cell null on empty', () => {
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', [], NOW);
    expect(r.peak_cell).toBeNull();
  });

  test('empty_cells canonical row-major order (stage major × scope minor)', () => {
    const entries = [matureEntry('k-001', ['alerts:read'])];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', entries, NOW);
    // Total cells = 7 × VALID_SCOPES.length. One populated cell
    // (mature_active, alerts:read). So empty_cells = total - 1.
    const total_cells = ALL_API_KEY_LIFECYCLE_STAGES.length * VALID_SCOPES.length;
    expect(r.empty_cells).toHaveLength(total_cells - 1);
    // Verify row-major order: stages in canonical order, scopes in canonical order
    let lastStageIdx = -1;
    let lastScopeIdx = -1;
    for (const cell of r.empty_cells) {
      const stageIdx = ALL_API_KEY_LIFECYCLE_STAGES.indexOf(cell.stage);
      const scopeIdx = VALID_SCOPES.indexOf(cell.scope);
      if (stageIdx === lastStageIdx) {
        expect(scopeIdx).toBeGreaterThan(lastScopeIdx);
      } else {
        expect(stageIdx).toBeGreaterThan(lastStageIdx);
      }
      lastStageIdx = stageIdx;
      lastScopeIdx = scopeIdx;
    }
  });

  test('most_diverse_stage formula + canonical tie-break', () => {
    // revoked has 1 scope, fresh has 3 scopes → fresh wins (3 > 1)
    const entries = [
      revokedEntry('k-r', ['alerts:read']),
      freshEntry('k-f', ['cases:read', 'audit:read', 'reports:read']),
    ];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', entries, NOW);
    expect(r.most_diverse_stage).toBe('fresh');
  });

  test('most_diverse_stage canonical tie-break: revoked beats fresh at tied span', () => {
    // revoked 2 scopes vs fresh 2 scopes → revoked wins (earlier in ALL_API_KEY_LIFECYCLE_STAGES)
    const entries = [
      revokedEntry('k-r', ['alerts:read', 'cases:read']),
      freshEntry('k-f', ['audit:read', 'reports:read']),
    ];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', entries, NOW);
    expect(r.most_diverse_stage).toBe('revoked');
  });

  test('most_universal_scope formula', () => {
    // alerts:read appears in 1 stage only (fresh)
    // cases:read appears in 3 stages (fresh, mature, revoked)
    const entries = [
      freshEntry('k-f', ['alerts:read', 'cases:read']),
      matureEntry('k-m', ['cases:read']),
      revokedEntry('k-r', ['cases:read']),
    ];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', entries, NOW);
    expect(r.most_universal_scope).toBe('cases:read');
  });

  test('most_diverse_stage + most_universal_scope null on empty', () => {
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', [], NOW);
    expect(r.most_diverse_stage).toBeNull();
    expect(r.most_universal_scope).toBeNull();
  });

  test('all 7 stages each have keys → all stages populated', () => {
    const entries = [
      revokedEntry('k-1', ['alerts:read']),
      expiredEntry('k-2', ['alerts:read']),
      expiringSoonEntry('k-3', ['alerts:read']),
      idleNeverUsedEntry('k-4', ['alerts:read']),
      dormantEntry('k-5', ['alerts:read']),
      freshEntry('k-6', ['alerts:read']),
      matureEntry('k-7', ['alerts:read']),
    ];
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', entries, NOW);
    expect(r.total_keys).toBe(7);
    expect(r.total_bindings).toBe(7);
    // every stage row has total >= 1
    for (const row of r.rows) {
      expect(row.total).toBeGreaterThanOrEqual(1);
    }
    // alerts:read column has all 7 stages populated
    const alertsCol = r.columns.find((col) => col.scope === 'alerts:read')!;
    expect(alertsCol.total).toBe(7);
    expect(alertsCol.distinct_stages).toBe(7);
    expect(alertsCol.stages_without).toEqual([]);
    // most_universal_scope = alerts:read (spans all 7 stages)
    expect(r.most_universal_scope).toBe('alerts:read');
  });

  test('empty tenant_id rejected', () => {
    expect(() => buildApiKeyLifecycleScopeMatrix('', [], NOW)).toThrow(
      /tenant_id/,
    );
  });

  test('total_stages + total_scopes echo enum lengths', () => {
    const r = buildApiKeyLifecycleScopeMatrix('BANK_DEMO', [], NOW);
    expect(r.total_stages).toBe(7);
    expect(r.total_scopes).toBe(VALID_SCOPES.length);
  });
});

// ---------------------------------------------------------------------
// HTTP route tests
// ---------------------------------------------------------------------

import request from 'supertest';
import { makeApp } from '../src/server';
import {
  defaultApiKeyStore,
  type ApiKeyStore,
} from '../src/api_keys';

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BANK_DEMO',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

describe('GET /v1/admin/api-keys/lifecycle-scope-matrix', () => {
  test('admin happy path empty', async () => {
    // makeApp uses defaultApiKeyStore which has the running BFF's
    // shared state. Reset to a fresh in-memory store for isolation
    // via the apiKeyStore dep slot when available; otherwise rely
    // on tenant scoping (BIL is never populated by other tests).
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/api-keys/lifecycle-scope-matrix')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BIL' });
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.rows).toHaveLength(7);
    expect(r.body.body.columns).toHaveLength(VALID_SCOPES.length);
    expect(r.body.body.peak_cell).toBeNull();
  });

  test('403 when role lacks audit:read', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/api-keys/lifecycle-scope-matrix')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('400 missing tenant header', async () => {
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/api-keys/lifecycle-scope-matrix')
      .set({ 'X-Apex-Role': 'admin' });
    expect(r.status).toBe(400);
  });

  test('populated path via BIL tenant (provision a key + verify)', async () => {
    // BIL is a registered tenant (T4.24 Phase 1 seed) so the tenant
    // gate accepts it. Pure resolver already exhaustively covers
    // populated cells; this just verifies the route correctly
    // forwards real store data.
    const { app } = makeApp({});
    const created = defaultApiKeyStore.create(
      'BIL',
      {
        name: 'M1.16 route smoke',
        scopes: ['alerts:read', 'audit:read'],
      },
      'alice.admin',
      NOW,
    );
    expect(created.key_id).toBeDefined();
    const r = await request(app)
      .get('/v1/admin/api-keys/lifecycle-scope-matrix')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BIL' });
    expect(r.status).toBe(200);
    expect(r.body.body.total_keys).toBeGreaterThanOrEqual(1);
    expect(r.body.body.total_bindings).toBeGreaterThanOrEqual(2);
    expect(r.body.body.peak_cell).not.toBeNull();
  });

  test('route mounted BEFORE /:key_id wildcard (literal segment wins)', async () => {
    // If /:key_id were mounted first, GET /v1/admin/api-keys/lifecycle-scope-matrix
    // would be captured as a key_id lookup → 404. Since our route is
    // mounted first, it returns 200.
    const { app } = makeApp({});
    const r = await request(app)
      .get('/v1/admin/api-keys/lifecycle-scope-matrix')
      .set({ ...HEADERS_ADMIN, 'X-Tenant-ID': 'BIL' });
    expect(r.status).toBe(200);
    expect(r.body.body.rows).toBeDefined();
  });
});
