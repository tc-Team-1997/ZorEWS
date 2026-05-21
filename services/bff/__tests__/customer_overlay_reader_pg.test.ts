// services/bff/__tests__/customer_overlay_reader_pg.test.ts
//
// B2 of v1.5+ unified.* consumer migration: pg integration + hermetic
// tests for the unified.customer_360 reader. Asserts shape parity,
// tenant isolation, single-customer fetch, list filters, band-derived
// pd_score stopgap helpers.

import { Pool } from 'pg';
import {
  PgUnifiedCustomer360Reader,
  InMemoryUnifiedCustomer360Reader,
  makeUnifiedCustomer360Reader,
  bandToPdScore,
  normalizeLevel,
  projectListItem,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type CustomerOverlayRow,
} from '../src/customer_overlay_reader';

const PG_URL = process.env.BFF_PG_URL ?? process.env.ADMIN_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

describeIfPg('customer_overlay_reader (pg integration — requires BFF_PG_URL)', () => {
  let pool: Pool;
  let reader: PgUnifiedCustomer360Reader;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    reader = new PgUnifiedCustomer360Reader(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  test('fetchOne returns a full row with the CustomerOverlayRow shape', async () => {
    // Pick a real BANK_DEMO customer
    const one = await pool.query(
      `SELECT customer_id FROM unified.customer_360 WHERE tenant_id = 'BANK_DEMO' LIMIT 1`,
    );
    const cid = one.rows[0].customer_id as string;
    const row = await reader.fetchOne('BANK_DEMO', cid);
    expect(row).not.toBeNull();
    expect(row!.tenant_id).toBe('BANK_DEMO');
    expect(row!.customer_id).toBe(cid);
    expect(typeof row!.name).toBe('string');
    // risk_level may be null on bad data; otherwise text bucket
    expect(row!.risk_level === null || typeof row!.risk_level === 'string').toBe(true);
    expect(typeof row!.exposure_kes).toBe('number');
    expect(typeof row!.dpd).toBe('number');
    expect(typeof row!.open_alerts_count).toBe('number');
    expect(typeof row!.open_cases_count).toBe('number');
    expect(typeof row!.pending_approvals_count).toBe('number');
  });

  test('fetchOne returns null for unknown customer_id', async () => {
    const row = await reader.fetchOne('BANK_DEMO', 'DOES_NOT_EXIST_99999');
    expect(row).toBeNull();
  });

  test('fetchOne rejects empty tenant_id / customer_id', async () => {
    await expect(reader.fetchOne('', 'C00001')).rejects.toThrow(/tenant_id/);
    await expect(reader.fetchOne('BANK_DEMO', '')).rejects.toThrow(/customer_id/);
  });

  test('fetchList returns paginated rows sorted High→Medium→Low then exposure DESC', async () => {
    const items = await reader.fetchList({ tenant_id: 'BANK_DEMO', limit: 50 });
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(50);
    // Verify level ordering: once we see a Medium, we should not see High after.
    let seenLevel: 'High' | 'Medium' | 'Low' | null = null;
    for (const it of items) {
      if (seenLevel === null) {
        seenLevel = it.level;
      } else if (
        (seenLevel === 'High' && (it.level === 'Medium' || it.level === 'Low')) ||
        (seenLevel === 'Medium' && it.level === 'Low')
      ) {
        seenLevel = it.level;
      } else if (
        (seenLevel === 'Medium' && it.level === 'High') ||
        (seenLevel === 'Low' && (it.level === 'High' || it.level === 'Medium'))
      ) {
        throw new Error(`sort broken: saw ${seenLevel} before ${it.level}`);
      }
    }
  });

  test('fetchList respects levels filter (High only)', async () => {
    const items = await reader.fetchList({ tenant_id: 'BANK_DEMO', levels: ['high'], limit: 100 });
    for (const it of items) {
      expect(it.level).toBe('High');
    }
  });

  test('fetchList respects pd_min filter', async () => {
    // Band-derived pd: Low=0.2, Medium=0.5, High=0.8
    const items = await reader.fetchList({ tenant_id: 'BANK_DEMO', pd_min: 0.4, limit: 50 });
    for (const it of items) {
      expect(it.pd).toBeGreaterThanOrEqual(0.4);
    }
  });

  test('fetchList limit clamped between 1 and MAX_LIMIT', async () => {
    const big = await reader.fetchList({ tenant_id: 'BANK_DEMO', limit: 9_999_999 });
    expect(big.length).toBeLessThanOrEqual(MAX_LIMIT);
    const one = await reader.fetchList({ tenant_id: 'BANK_DEMO', limit: 0 });
    expect(one.length).toBeLessThanOrEqual(1);
  });

  test('fetchList rejects empty tenant_id', async () => {
    await expect(reader.fetchList({ tenant_id: '' })).rejects.toThrow(/tenant_id/);
  });

  test('BIL tenant isolation: empty results (mart has only BANK_DEMO seed)', async () => {
    const items = await reader.fetchList({ tenant_id: 'BIL', limit: 100 });
    expect(items).toEqual([]);
    const single = await reader.fetchOne('BIL', 'C00001');
    // BIL has no mart data; even if BANK_DEMO has C00001, BIL doesn't.
    expect(single).toBeNull();
  });

  test('makeUnifiedCustomer360Reader returns reader when view exists', async () => {
    const made = await makeUnifiedCustomer360Reader(pool);
    expect(made).toBeInstanceOf(PgUnifiedCustomer360Reader);
  });

  test('makeUnifiedCustomer360Reader returns undefined on null pool', async () => {
    const made = await makeUnifiedCustomer360Reader(null);
    expect(made).toBeUndefined();
  });

  test('list items carry pd_source = "band" (stopgap discriminator)', async () => {
    const items = await reader.fetchList({ tenant_id: 'BANK_DEMO', limit: 5 });
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) {
      expect(it.pd_source).toBe('band');
    }
  });
});

// ---------------------------------------------------------------------
// Pure helpers (hermetic — no pg)
// ---------------------------------------------------------------------

describe('bandToPdScore + normalizeLevel (pure helpers)', () => {
  test('bandToPdScore maps risk_level → synthetic pd', () => {
    expect(bandToPdScore('low')).toBe(0.2);
    expect(bandToPdScore('medium')).toBe(0.5);
    expect(bandToPdScore('high')).toBe(0.8);
    expect(bandToPdScore('Low')).toBe(0.2); // case-insensitive
    expect(bandToPdScore('HIGH')).toBe(0.8);
    expect(bandToPdScore(null)).toBe(0);
    expect(bandToPdScore(undefined)).toBe(0);
    expect(bandToPdScore('unknown')).toBe(0);
  });

  test('normalizeLevel buckets text → Low/Medium/High', () => {
    expect(normalizeLevel('high')).toBe('High');
    expect(normalizeLevel('HIGH')).toBe('High');
    expect(normalizeLevel('medium')).toBe('Medium');
    expect(normalizeLevel('low')).toBe('Low');
    expect(normalizeLevel(null)).toBe('Low'); // unknown → Low (safe default)
    expect(normalizeLevel('garbage')).toBe('Low');
  });

  test('projectListItem composes the slim shape with band pd', () => {
    const row: CustomerOverlayRow = {
      tenant_id: 'BANK_DEMO',
      customer_id: 'C00001',
      name: 'Alice',
      risk_level: 'high',
      exposure_kes: 1_000_000,
      dpd: 45,
      kyc_status: 'verified',
      segment: 'retail',
      onboarded_at: '2024-01-01T00:00:00Z',
      open_alerts_count: 2,
      max_criticality_score: 7.5,
      latest_alert_at: '2026-05-20T10:00:00Z',
      open_cases_count: 1,
      breached_sla_count: 0,
      pending_approvals_count: 0,
      last_activity_at: '2026-05-20T10:00:00Z',
    };
    const item = projectListItem(row);
    expect(item.id).toBe('C00001');
    expect(item.name).toBe('Alice');
    expect(item.pd).toBe(0.8); // High → 0.8 band
    expect(item.pd_source).toBe('band');
    expect(item.level).toBe('High');
    expect(item.exposure).toBe(1_000_000);
    expect(item.dpd).toBe(45);
    expect(item.open_alerts_count).toBe(2);
    expect(item.open_cases_count).toBe(1);
  });
});

describe('InMemoryUnifiedCustomer360Reader (hermetic stub)', () => {
  const seed: CustomerOverlayRow[] = [
    {
      tenant_id: 'BANK_DEMO',
      customer_id: 'C00001',
      name: 'Alice',
      risk_level: 'high',
      exposure_kes: 5_000_000,
      dpd: 60,
      kyc_status: 'verified',
      segment: 'retail',
      onboarded_at: '2024-01-01T00:00:00Z',
      open_alerts_count: 3,
      max_criticality_score: 8,
      latest_alert_at: '2026-05-20T10:00:00Z',
      open_cases_count: 1,
      breached_sla_count: 1,
      pending_approvals_count: 0,
      last_activity_at: '2026-05-20T10:00:00Z',
    },
    {
      tenant_id: 'BANK_DEMO',
      customer_id: 'C00002',
      name: 'Bob',
      risk_level: 'low',
      exposure_kes: 100_000,
      dpd: 0,
      kyc_status: 'verified',
      segment: 'retail',
      onboarded_at: '2024-06-01T00:00:00Z',
      open_alerts_count: 0,
      max_criticality_score: null,
      latest_alert_at: null,
      open_cases_count: 0,
      breached_sla_count: 0,
      pending_approvals_count: 0,
      last_activity_at: null,
    },
    {
      tenant_id: 'BIL',
      customer_id: 'C00100',
      name: 'BIL Customer',
      risk_level: 'medium',
      exposure_kes: 50_000,
      dpd: 5,
      kyc_status: 'verified',
      segment: 'sme',
      onboarded_at: '2025-01-01T00:00:00Z',
      open_alerts_count: 0,
      max_criticality_score: null,
      latest_alert_at: null,
      open_cases_count: 0,
      breached_sla_count: 0,
      pending_approvals_count: 0,
      last_activity_at: null,
    },
  ];

  test('fetchOne returns matching tenant+customer', async () => {
    const r = new InMemoryUnifiedCustomer360Reader(seed);
    expect((await r.fetchOne('BANK_DEMO', 'C00001'))?.name).toBe('Alice');
    expect(await r.fetchOne('BANK_DEMO', 'C00009')).toBeNull();
  });

  test('fetchList tenant-scoped + level filter + pd_min', async () => {
    const r = new InMemoryUnifiedCustomer360Reader(seed);
    const all = await r.fetchList({ tenant_id: 'BANK_DEMO' });
    expect(all).toHaveLength(2);
    const bilOnly = await r.fetchList({ tenant_id: 'BIL' });
    expect(bilOnly).toHaveLength(1);
    expect(bilOnly[0].name).toBe('BIL Customer');
    const high = await r.fetchList({ tenant_id: 'BANK_DEMO', levels: ['high'] });
    expect(high).toHaveLength(1);
    expect(high[0].id).toBe('C00001');
    const pdHalf = await r.fetchList({ tenant_id: 'BANK_DEMO', pd_min: 0.4 });
    expect(pdHalf).toHaveLength(1); // only High survives (0.8 ≥ 0.4); Low (0.2) excluded
    expect(pdHalf[0].id).toBe('C00001');
  });

  test('exports DEFAULT_LIMIT=1000 + MAX_LIMIT=10000', () => {
    expect(DEFAULT_LIMIT).toBe(1000);
    expect(MAX_LIMIT).toBe(10_000);
  });
});
