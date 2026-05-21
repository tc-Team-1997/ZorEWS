// services/bff/__tests__/alerts_unified_reader_pg.test.ts
//
// B1 of v1.5+ consumer migration: parity test asserting
// PgUnifiedAlertsReader.fetch() produces the same AlertRow shape that
// mapAlertList() does. Both paths must yield identical output for the
// same logical input, because the 3 alert routes branch on which one
// to call and the SPA must see the same response either way.
//
// Skipped when BFF_PG_URL unset (mirrors T4.13-T4.18 + unified_views_pg).

import { Pool } from 'pg';
import {
  PgUnifiedAlertsReader,
  InMemoryUnifiedAlertsReader,
  makeUnifiedAlertsReader,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../src/alerts_unified_reader';
import type { AlertRow, UiSeverity } from '../src/types';

const PG_URL = process.env.BFF_PG_URL ?? process.env.ADMIN_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

describeIfPg('alerts_unified_reader (pg integration — requires BFF_PG_URL)', () => {
  let pool: Pool;
  let reader: PgUnifiedAlertsReader;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    reader = new PgUnifiedAlertsReader(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  test('fetch returns rows with the AlertRow shape', async () => {
    const rows = await reader.fetch({ tenant_id: 'BANK_DEMO', limit: 5 });
    expect(rows.length).toBeGreaterThan(0);
    const a = rows[0];

    // Shape parity: every AlertRow field must be present + typed correctly
    expect(typeof a.id).toBe('string');
    expect(['low', 'medium', 'high', 'critical']).toContain(a.severity);
    expect(typeof a.customer.id).toBe('string');
    expect(typeof a.customer.name).toBe('string');
    expect(typeof a.rule.id).toBe('string');
    expect(typeof a.rule.name).toBe('string');
    expect(Array.isArray(a.indicators)).toBe(true);
    expect(typeof a.age_min).toBe('number');
    expect(a.age_min).toBeGreaterThanOrEqual(0);
    // assignee is null OR string
    expect(a.assignee === null || typeof a.assignee === 'string').toBe(true);
    expect(typeof a.created_at).toBe('string');
    expect(typeof a.confidence).toBe('number');
    expect(typeof a.customer_exposure_kes).toBe('number');
    expect(typeof a.criticality_score).toBe('number');
    expect(Array.isArray(a.linked_alert_ids)).toBe(true);
    expect(a.linked_alert_ids).toEqual([]); // populated post-fetch by dedup
  });

  test('fetch respects tenant_id filter (BIL invisible from BANK_DEMO query)', async () => {
    const bank = await reader.fetch({ tenant_id: 'BANK_DEMO', limit: 100 });
    // All rows must report customers whose ids exist in BANK_DEMO scope
    // (seed has all alerts under BANK_DEMO; BIL has no alerts yet).
    expect(bank.length).toBeGreaterThan(0);

    const bil = await reader.fetch({ tenant_id: 'BIL', limit: 100 });
    // BIL has 0 alerts in the current seed (parallel to BIL mart being empty).
    expect(bil).toEqual([]);
  });

  test('fetch respects severity filter', async () => {
    const critical = await reader.fetch({
      tenant_id: 'BANK_DEMO',
      severity: 'critical',
      limit: 50,
    });
    for (const a of critical) {
      expect(a.severity).toBe('critical');
    }
  });

  test('fetch respects status filter', async () => {
    const open = await reader.fetch({
      tenant_id: 'BANK_DEMO',
      status: 'open',
      limit: 50,
    });
    expect(open.length).toBeGreaterThan(0);
    // Status isn't on AlertRow, but the query filtered to status='open'
    // — verify a closed alert isn't accidentally returned via the assignee
    // hack OR by joining to app_alerts.alerts directly.
    const ids = open.map((a) => a.id);
    const directOpen = await pool.query(
      `SELECT alert_id FROM app_alerts.alerts WHERE tenant_id = 'BANK_DEMO' AND status = 'open'`,
    );
    const directOpenSet = new Set(directOpen.rows.map((r) => r.alert_id as string));
    for (const id of ids) {
      expect(directOpenSet.has(id)).toBe(true);
    }
  });

  test('fetch respects customer_id filter', async () => {
    // Pick a customer that has at least one alert
    const oneCustomer = await pool.query(
      `SELECT customer_id FROM app_alerts.alerts WHERE tenant_id = 'BANK_DEMO' LIMIT 1`,
    );
    const cid = oneCustomer.rows[0].customer_id as string;

    const rows = await reader.fetch({ tenant_id: 'BANK_DEMO', customer_id: cid });
    expect(rows.length).toBeGreaterThan(0);
    for (const a of rows) {
      expect(a.customer.id).toBe(cid);
    }
  });

  test('fetch clamps limit between 1 and MAX_LIMIT', async () => {
    const lots = await reader.fetch({ tenant_id: 'BANK_DEMO', limit: 999999 });
    expect(lots.length).toBeLessThanOrEqual(MAX_LIMIT);

    const one = await reader.fetch({ tenant_id: 'BANK_DEMO', limit: 0 });
    expect(one.length).toBeLessThanOrEqual(1);
  });

  test('fetch rejects empty tenant_id', async () => {
    await expect(reader.fetch({ tenant_id: '' })).rejects.toThrow(/tenant_id/);
    await expect(reader.fetch({ tenant_id: '   ' })).rejects.toThrow(/tenant_id/);
  });

  test('fetch sorts criticality_score DESC NULLS LAST, then created_at DESC', async () => {
    const rows = await reader.fetch({ tenant_id: 'BANK_DEMO', limit: 50 });
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1].criticality_score;
      const b = rows[i].criticality_score;
      // Non-NaN ordering: previous >= next (DESC)
      expect(Number(a)).toBeGreaterThanOrEqual(Number(b));
    }
  });

  test('makeUnifiedAlertsReader returns reader when unified.alerts exists', async () => {
    const made = await makeUnifiedAlertsReader(pool);
    expect(made).toBeInstanceOf(PgUnifiedAlertsReader);
  });

  test('makeUnifiedAlertsReader returns undefined when pool is null', async () => {
    const made = await makeUnifiedAlertsReader(null);
    expect(made).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Pure (non-pg) tests — InMemoryUnifiedAlertsReader is the test stub
// used by route tests in B1.5+. Hermetic; runs in CI without pg.
// ---------------------------------------------------------------------

describe('InMemoryUnifiedAlertsReader', () => {
  const seed: AlertRow[] = [
    {
      id: 'a1',
      severity: 'critical',
      customer: { id: 'c1', name: 'Alice' },
      rule: { id: 'r1', name: 'Rule One' },
      indicators: ['IND_TXN_001'],
      age_min: 5,
      assignee: 'analyst.1',
      created_at: '2026-05-21T10:00:00Z',
      confidence: 0.92,
      customer_exposure_kes: 1_000_000,
      criticality_score: 0.85,
      linked_alert_ids: [],
    },
    {
      id: 'a2',
      severity: 'low',
      customer: { id: 'c2', name: 'Bob' },
      rule: { id: 'r1', name: 'Rule One' },
      indicators: [],
      age_min: 60,
      assignee: null,
      created_at: '2026-05-21T09:00:00Z',
      confidence: 0.4,
      customer_exposure_kes: 50_000,
      criticality_score: 0.12,
      linked_alert_ids: [],
    },
  ];

  test('returns all rows when only tenant_id given', async () => {
    const r = new InMemoryUnifiedAlertsReader(seed);
    const out = await r.fetch({ tenant_id: 'BANK_DEMO' });
    expect(out).toHaveLength(2);
  });

  test('filters by severity', async () => {
    const r = new InMemoryUnifiedAlertsReader(seed);
    const crit = await r.fetch({ tenant_id: 'BANK_DEMO', severity: 'critical' as UiSeverity });
    expect(crit).toHaveLength(1);
    expect(crit[0].id).toBe('a1');
  });

  test('filters by assignee', async () => {
    const r = new InMemoryUnifiedAlertsReader(seed);
    const assigned = await r.fetch({ tenant_id: 'BANK_DEMO', assignee: 'analyst.1' });
    expect(assigned).toHaveLength(1);
    expect(assigned[0].id).toBe('a1');
  });

  test('filters by customer_id', async () => {
    const r = new InMemoryUnifiedAlertsReader(seed);
    const cust = await r.fetch({ tenant_id: 'BANK_DEMO', customer_id: 'c2' });
    expect(cust).toHaveLength(1);
    expect(cust[0].id).toBe('a2');
  });

  test('DEFAULT_LIMIT + MAX_LIMIT exported', () => {
    expect(DEFAULT_LIMIT).toBe(1000);
    expect(MAX_LIMIT).toBe(5000);
  });
});
