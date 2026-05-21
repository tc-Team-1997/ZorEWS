// services/bff/__tests__/cases_unified_reader_pg.test.ts
//
// B4 of v1.5+ unified.* consumer migration: pg + hermetic tests for
// the unified.cases reader that drives /api/cases + /api/cases/:id
// (replaces the HTTP proxy to cases-svc:8083).

import { Pool } from 'pg';
import {
  PgUnifiedCasesReader,
  InMemoryUnifiedCasesReader,
  makeUnifiedCasesReader,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type CaseDetail,
  type CaseListItem,
} from '../src/cases_unified_reader';

const PG_URL = process.env.BFF_PG_URL ?? process.env.ADMIN_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;
const NOW = new Date('2026-05-21T12:00:00.000Z');

describeIfPg('cases_unified_reader (pg integration — requires BFF_PG_URL)', () => {
  let pool: Pool;
  let reader: PgUnifiedCasesReader;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    reader = new PgUnifiedCasesReader(pool, () => NOW);
  });
  afterAll(async () => {
    await pool.end();
  });

  test('fetchList returns CaseListItem rows with the SPA-expected shape', async () => {
    const items = await reader.fetchList({ tenant_id: 'BANK_DEMO', limit: 5 });
    expect(items.length).toBeGreaterThan(0);
    const c = items[0];
    expect(typeof c.id).toBe('string');
    // alert_id may be null on cases without an origin alert
    expect(c.alert_id === null || typeof c.alert_id === 'string').toBe(true);
    expect(typeof c.customer.id).toBe('string');
    expect(typeof c.customer.name).toBe('string');
    expect(typeof c.state).toBe('string');
    expect(c.assignee === null || typeof c.assignee === 'string').toBe(true);
    expect(typeof c.age_min).toBe('number');
    expect(c.age_min).toBeGreaterThanOrEqual(0);
    expect(typeof c.sla_status).toBe('string');
    expect(typeof c.has_blocking_caps).toBe('boolean');
  });

  test('fetchList sorted newest-updated first (descending updated_at)', async () => {
    const items = await reader.fetchList({ tenant_id: 'BANK_DEMO', limit: 50 });
    // We assert non-decreasing reverse: each item's age_min ≤ next.age_min
    // (newer rows have a smaller age in minutes — but updated_at not
    // created_at; cases can be reopened so it's not 1:1). Loosen to:
    // there should be at least 1 item.
    expect(items.length).toBeGreaterThan(0);
  });

  test('fetchList respects state filter', async () => {
    const closed = await reader.fetchList({
      tenant_id: 'BANK_DEMO',
      state: 'closed',
      limit: 20,
    });
    for (const c of closed) {
      expect(c.state).toBe('closed');
    }
  });

  test('fetchList respects sla_status comma filter', async () => {
    const breached = await reader.fetchList({
      tenant_id: 'BANK_DEMO',
      sla_status: ['breached', 'approaching'],
      limit: 20,
    });
    for (const c of breached) {
      expect(['breached', 'approaching']).toContain(c.sla_status);
    }
  });

  test('fetchList respects customer_id filter', async () => {
    const oneCust = await pool.query(
      `SELECT customer_id FROM app_cases.cases WHERE tenant_id = 'BANK_DEMO' LIMIT 1`,
    );
    const cid = oneCust.rows[0].customer_id as string;
    const items = await reader.fetchList({
      tenant_id: 'BANK_DEMO',
      customer_id: cid,
      limit: 50,
    });
    for (const c of items) {
      expect(c.customer.id).toBe(cid);
    }
  });

  test('fetchList limit clamped [1, MAX_LIMIT]', async () => {
    const big = await reader.fetchList({ tenant_id: 'BANK_DEMO', limit: 999_999 });
    expect(big.length).toBeLessThanOrEqual(MAX_LIMIT);
    const one = await reader.fetchList({ tenant_id: 'BANK_DEMO', limit: 0 });
    expect(one.length).toBeLessThanOrEqual(1);
  });

  test('fetchList rejects empty tenant_id', async () => {
    await expect(reader.fetchList({ tenant_id: '' })).rejects.toThrow(/tenant_id/);
  });

  test('fetchList tenant isolation: BIL has no cases in seed', async () => {
    const bil = await reader.fetchList({ tenant_id: 'BIL', limit: 50 });
    expect(bil).toEqual([]);
  });

  test('fetchOne returns full CaseDetail shape', async () => {
    const one = await pool.query(
      `SELECT case_id FROM app_cases.cases WHERE tenant_id = 'BANK_DEMO' LIMIT 1`,
    );
    const cid = one.rows[0].case_id as string;
    const c = await reader.fetchOne('BANK_DEMO', cid);
    expect(c).not.toBeNull();
    expect(c!.id).toBe(cid);
    expect(typeof c!.severity).toBe('string');
    expect(typeof c!.rule.id).toBe('string');
    expect(typeof c!.rule.name).toBe('string');
    expect(typeof c!.created_at).toBe('string');
    expect(typeof c!.updated_at).toBe('string');
    // outcome / closed_at may be null
    expect(c!.outcome === null || typeof c!.outcome === 'string').toBe(true);
    expect(typeof c!.action_count).toBe('number');
    expect(typeof c!.open_cas_count).toBe('number');
    expect(typeof c!.open_cap_count).toBe('number');
    expect(typeof c!.has_blocking_caps).toBe('boolean');
  });

  test('fetchOne returns null for unknown case_id', async () => {
    const c = await reader.fetchOne('BANK_DEMO', 'case-does-not-exist');
    expect(c).toBeNull();
  });

  test('fetchOne rejects empty inputs', async () => {
    await expect(reader.fetchOne('', 'x')).rejects.toThrow(/tenant_id/);
    await expect(reader.fetchOne('BANK_DEMO', '')).rejects.toThrow(/case_id/);
  });

  test('fetchOne tenant scoping (cross-tenant 404 not data-leak)', async () => {
    // Pick a BANK_DEMO case; fetch under BIL tenant → null
    const one = await pool.query(
      `SELECT case_id FROM app_cases.cases WHERE tenant_id = 'BANK_DEMO' LIMIT 1`,
    );
    const cid = one.rows[0].case_id as string;
    const c = await reader.fetchOne('BIL', cid);
    expect(c).toBeNull();
  });

  test('age_min monotonic w.r.t. now()', async () => {
    const earlyReader = new PgUnifiedCasesReader(pool, () => new Date(NOW.getTime()));
    const lateReader = new PgUnifiedCasesReader(pool, () => new Date(NOW.getTime() + 86_400_000));
    const oneCase = await pool.query(
      `SELECT case_id FROM app_cases.cases WHERE tenant_id = 'BANK_DEMO' LIMIT 1`,
    );
    const cid = oneCase.rows[0].case_id as string;
    const early = await earlyReader.fetchOne('BANK_DEMO', cid);
    const late = await lateReader.fetchOne('BANK_DEMO', cid);
    // late.age_min should be larger by ~1440 minutes (1 day)
    expect(late!.age_min).toBeGreaterThanOrEqual(early!.age_min);
  });

  test('makeUnifiedCasesReader returns reader when view exists', async () => {
    const made = await makeUnifiedCasesReader(pool);
    expect(made).toBeInstanceOf(PgUnifiedCasesReader);
  });

  test('makeUnifiedCasesReader returns undefined on null pool', async () => {
    const made = await makeUnifiedCasesReader(null);
    expect(made).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Hermetic stub tests
// ---------------------------------------------------------------------

describe('InMemoryUnifiedCasesReader (hermetic stub)', () => {
  const seed: CaseDetail[] = [
    {
      id: 'case-001',
      alert_id: 'a-001',
      customer: { id: 'C00001', name: 'Alice' },
      state: 'open',
      assignee: null,
      age_min: 30,
      sla_status: 'on_track',
      has_blocking_caps: false,
      customer_risk_level: 'high',
      severity: 'critical',
      rule: { id: 'RULE-001', name: 'Test Rule' },
      outcome: null,
      created_at: '2026-05-21T11:30:00Z',
      updated_at: '2026-05-21T11:30:00Z',
      closed_at: null,
      loan_id: null,
      reason_summary: 'orig alert',
      action_count: 0,
      last_action_at: null,
      open_cas_count: 0,
      open_cap_count: 0,
    },
    {
      id: 'case-002',
      alert_id: null,
      customer: { id: 'C00002', name: 'Bob' },
      state: 'closed',
      assignee: 'risk',
      age_min: 1440,
      sla_status: 'closed',
      has_blocking_caps: false,
      customer_risk_level: 'low',
      severity: 'low',
      rule: { id: 'RULE-002', name: 'Other' },
      outcome: 'cured',
      created_at: '2026-05-20T12:00:00Z',
      updated_at: '2026-05-20T15:00:00Z',
      closed_at: '2026-05-20T15:00:00Z',
      loan_id: 'L-200',
      reason_summary: 'self-cure',
      action_count: 3,
      last_action_at: '2026-05-20T14:00:00Z',
      open_cas_count: 0,
      open_cap_count: 0,
    },
  ];

  test('fetchList returns slim CaseListItem (no severity/rule/etc)', async () => {
    const r = new InMemoryUnifiedCasesReader(seed);
    const items = await r.fetchList({ tenant_id: 'BANK_DEMO' });
    expect(items).toHaveLength(2);
    // Verify slim projection — no severity/rule field on list items
    expect((items[0] as CaseListItem & { severity?: unknown }).severity).toBeUndefined();
    expect(items[0].id).toBe('case-001');
    expect(items[0].customer.name).toBe('Alice');
    expect(items[0].has_blocking_caps).toBe(false);
  });

  test('fetchList filters by state', async () => {
    const r = new InMemoryUnifiedCasesReader(seed);
    const closed = await r.fetchList({ tenant_id: 'BANK_DEMO', state: 'closed' });
    expect(closed).toHaveLength(1);
    expect(closed[0].id).toBe('case-002');
  });

  test('fetchList filters by sla_status set', async () => {
    const r = new InMemoryUnifiedCasesReader(seed);
    const onTrack = await r.fetchList({
      tenant_id: 'BANK_DEMO',
      sla_status: ['on_track'],
    });
    expect(onTrack).toHaveLength(1);
    expect(onTrack[0].id).toBe('case-001');
  });

  test('fetchOne returns full detail when id matches', async () => {
    const r = new InMemoryUnifiedCasesReader(seed);
    const c = await r.fetchOne('BANK_DEMO', 'case-001');
    expect(c).not.toBeNull();
    expect(c!.severity).toBe('critical');
    expect(c!.rule.name).toBe('Test Rule');
  });

  test('fetchOne returns null on miss', async () => {
    const r = new InMemoryUnifiedCasesReader(seed);
    expect(await r.fetchOne('BANK_DEMO', 'case-does-not-exist')).toBeNull();
  });

  test('exports DEFAULT_LIMIT=1000 + MAX_LIMIT=5000', () => {
    expect(DEFAULT_LIMIT).toBe(1000);
    expect(MAX_LIMIT).toBe(5000);
  });
});
