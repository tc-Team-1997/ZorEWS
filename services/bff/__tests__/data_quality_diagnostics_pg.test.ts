// services/bff/__tests__/data_quality_diagnostics_pg.test.ts
//
// B6 of v1.5+ unified.* consumer migration: integration tests for the
// orphan-reference scanner against the live zorews-pg seed. Asserts the
// known seed orphan counts (528 cases reference alert_ids absent from
// app_alerts.alerts per the T4.25 spec §11 finding) + tenant isolation +
// sample cap behaviour.
//
// Skipped when BFF_PG_URL unset (mirrors T4.13-T4.18 pattern).

import { Pool } from 'pg';
import {
  runOrphanReferenceScan,
  ALL_ORPHAN_CLASSES,
  DEFAULT_SAMPLE_CAP,
  MAX_SAMPLE_CAP,
  PgOrphanScanner,
  InMemoryOrphanScanner,
  type OrphanReferenceReport,
} from '../src/data_quality_diagnostics';

const PG_URL = process.env.BFF_PG_URL ?? process.env.ADMIN_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

describeIfPg('data_quality_diagnostics (pg integration — requires BFF_PG_URL)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
  });
  afterAll(async () => {
    await pool.end();
  });

  test('runOrphanReferenceScan: BANK_DEMO returns the 3 canonical classes in order', async () => {
    const r = await runOrphanReferenceScan(pool, { tenant_id: 'BANK_DEMO' });
    expect(r.classes.map((c) => c.class)).toEqual([
      'cases_without_alert',
      'alerts_without_customer',
      'approvals_without_case',
    ]);
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(typeof r.generated_at).toBe('string');
    expect(r.sample_cap).toBe(DEFAULT_SAMPLE_CAP);
    expect(typeof r.total_orphans).toBe('number');
    expect(typeof r.is_clean).toBe('boolean');
  });

  test('cases_without_alert: detects the T4.25 seed-quality finding (528 orphans on BANK_DEMO)', async () => {
    const r = await runOrphanReferenceScan(pool, { tenant_id: 'BANK_DEMO' });
    const cases = r.classes.find((c) => c.class === 'cases_without_alert');
    expect(cases).toBeDefined();
    // Spec §11 known-gap says all 528 BANK_DEMO cases are orphans.
    expect(cases!.total_scanned).toBe(528);
    expect(cases!.orphan_count).toBe(528);
    expect(cases!.orphan_rate).toBe(1);
    // Default cap is 100 samples.
    expect(cases!.sample_orphans.length).toBe(DEFAULT_SAMPLE_CAP);
    // Each sample carries parent_id + missing_ref + context.
    const s = cases!.sample_orphans[0];
    expect(typeof s.parent_id).toBe('string');
    expect(typeof s.missing_ref).toBe('string');
    expect(s.context).toBeDefined();
    expect(s.context!.state).toBeDefined();
    expect(s.context!.severity).toBeDefined();
  });

  test('alerts_without_customer: counts match a direct query (mart join)', async () => {
    const r = await runOrphanReferenceScan(pool, { tenant_id: 'BANK_DEMO' });
    const alerts = r.classes.find((c) => c.class === 'alerts_without_customer');

    // Independently compute the same count and assert parity.
    const direct = await pool.query(
      `SELECT COUNT(*)::int AS n FROM app_alerts.alerts a
        WHERE a.tenant_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM mart.customer_360 m
             WHERE m.tenant_id = a.tenant_id
               AND m.customer_id = a.customer_id
          )`,
      ['BANK_DEMO'],
    );
    expect(alerts!.orphan_count).toBe(direct.rows[0].n);

    const totalAlerts = await pool.query(
      `SELECT COUNT(*)::int AS n FROM app_alerts.alerts WHERE tenant_id = $1`,
      ['BANK_DEMO'],
    );
    expect(alerts!.total_scanned).toBe(totalAlerts.rows[0].n);
  });

  test('approvals_without_case: filters to case-like subject_types only', async () => {
    const r = await runOrphanReferenceScan(pool, { tenant_id: 'BANK_DEMO' });
    const approvals = r.classes.find((c) => c.class === 'approvals_without_case');

    // Total scanned = ALL approvals (we don't pre-filter total_scanned).
    const totalApprovals = await pool.query(
      `SELECT COUNT(*)::int AS n FROM app_audit.approvals WHERE tenant_id = $1`,
      ['BANK_DEMO'],
    );
    expect(approvals!.total_scanned).toBe(totalApprovals.rows[0].n);

    // orphan_count only counts case-like subject_types that don't resolve.
    // Seed has 0 approvals so this is 0 too — but the SHAPE is correct.
    expect(approvals!.orphan_count).toBe(0);
    expect(approvals!.orphan_rate).toBe(0);
    expect(approvals!.sample_orphans).toEqual([]);
  });

  test('tenant isolation: BIL has its own scan (no BANK_DEMO bleed-through)', async () => {
    const bil = await runOrphanReferenceScan(pool, { tenant_id: 'BIL' });
    expect(bil.tenant_id).toBe('BIL');
    // BIL has no cases / no alerts / no approvals in the seed.
    for (const c of bil.classes) {
      expect(c.total_scanned).toBe(0);
      expect(c.orphan_count).toBe(0);
      expect(c.orphan_rate).toBe(0);
      expect(c.sample_orphans).toEqual([]);
    }
    expect(bil.total_orphans).toBe(0);
    expect(bil.is_clean).toBe(true);
  });

  test('sample_cap: clamped between 1 and MAX_SAMPLE_CAP', async () => {
    const huge = await runOrphanReferenceScan(pool, {
      tenant_id: 'BANK_DEMO',
      sample_cap: 999999,
    });
    expect(huge.sample_cap).toBe(MAX_SAMPLE_CAP);
    // Cases has 528 orphans — capped at 500.
    const c = huge.classes.find((x) => x.class === 'cases_without_alert')!;
    expect(c.sample_orphans.length).toBe(MAX_SAMPLE_CAP);

    const tiny = await runOrphanReferenceScan(pool, {
      tenant_id: 'BANK_DEMO',
      sample_cap: 0,
    });
    expect(tiny.sample_cap).toBe(1);
    const tcc = tiny.classes.find((x) => x.class === 'cases_without_alert')!;
    expect(tcc.sample_orphans.length).toBeLessThanOrEqual(1);
  });

  test('sample_orphans sorted by parent_id ASC for determinism', async () => {
    const r = await runOrphanReferenceScan(pool, {
      tenant_id: 'BANK_DEMO',
      sample_cap: 50,
    });
    const cases = r.classes.find((c) => c.class === 'cases_without_alert')!;
    for (let i = 1; i < cases.sample_orphans.length; i++) {
      expect(cases.sample_orphans[i - 1].parent_id <= cases.sample_orphans[i].parent_id).toBe(true);
    }
  });

  test('rejects empty tenant_id', async () => {
    await expect(runOrphanReferenceScan(pool, { tenant_id: '' })).rejects.toThrow(/tenant_id/);
    await expect(runOrphanReferenceScan(pool, { tenant_id: '   ' })).rejects.toThrow(/tenant_id/);
  });

  test('now() injection respected', async () => {
    const fixed = new Date('2026-05-21T12:00:00.000Z');
    const r = await runOrphanReferenceScan(pool, {
      tenant_id: 'BANK_DEMO',
      now: () => fixed,
    });
    expect(r.generated_at).toBe('2026-05-21T12:00:00.000Z');
  });

  test('total_orphans rollup matches sum of per-class counts', async () => {
    const r = await runOrphanReferenceScan(pool, { tenant_id: 'BANK_DEMO' });
    const sum = r.classes.reduce((acc, c) => acc + c.orphan_count, 0);
    expect(r.total_orphans).toBe(sum);
    expect(r.is_clean).toBe(sum === 0);
  });

  test('PgOrphanScanner.run() delegates to runOrphanReferenceScan', async () => {
    const s = new PgOrphanScanner(pool);
    const r = await s.run({ tenant_id: 'BANK_DEMO' });
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.classes.length).toBe(3);
  });
});

// ---------------------------------------------------------------------
// Hermetic tests (no pg) — exercises the InMemoryOrphanScanner stub.
// ---------------------------------------------------------------------

describe('InMemoryOrphanScanner (hermetic)', () => {
  test('returns the canned report with tenant_id overridden', async () => {
    const canned: OrphanReferenceReport = {
      tenant_id: 'FAKE',
      generated_at: '2026-05-21T00:00:00.000Z',
      sample_cap: 100,
      classes: ALL_ORPHAN_CLASSES.map((c) => ({
        class: c,
        total_scanned: 10,
        orphan_count: 2,
        orphan_rate: 0.2,
        sample_orphans: [],
      })),
      total_orphans: 6,
      is_clean: false,
    };
    const s = new InMemoryOrphanScanner(canned);
    const r = await s.run({ tenant_id: 'BANK_DEMO' });
    expect(r.tenant_id).toBe('BANK_DEMO');
    expect(r.classes.length).toBe(3);
    expect(r.total_orphans).toBe(6);
    expect(r.is_clean).toBe(false);
  });

  test('exports DEFAULT_SAMPLE_CAP=100 + MAX_SAMPLE_CAP=500', () => {
    expect(DEFAULT_SAMPLE_CAP).toBe(100);
    expect(MAX_SAMPLE_CAP).toBe(500);
  });

  test('ALL_ORPHAN_CLASSES is a 3-element canonical tuple', () => {
    expect(ALL_ORPHAN_CLASSES).toEqual([
      'cases_without_alert',
      'alerts_without_customer',
      'approvals_without_case',
    ]);
  });
});

// ---------------------------------------------------------------------
// HTTP route tests: /v1/admin/data-quality/orphan-references
// ---------------------------------------------------------------------

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS_ADMIN = {
  'X-Tenant-ID': 'BANK_DEMO',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

const ZERO_REPORT: OrphanReferenceReport = {
  tenant_id: 'BANK_DEMO',
  generated_at: '2026-05-21T12:00:00.000Z',
  sample_cap: 100,
  classes: ALL_ORPHAN_CLASSES.map((c) => ({
    class: c,
    total_scanned: 0,
    orphan_count: 0,
    orphan_rate: 0,
    sample_orphans: [],
  })),
  total_orphans: 0,
  is_clean: true,
};

describe('GET /v1/admin/data-quality/orphan-references (hermetic — InMemoryOrphanScanner)', () => {
  test('200 with the scanner report wrapped in envelope', async () => {
    const scanner = new InMemoryOrphanScanner(ZERO_REPORT);
    const { app } = makeApp({ orphanScanner: scanner });
    const r = await request(app)
      .get('/v1/admin/data-quality/orphan-references')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    expect(r.body.body.tenant_id).toBe('BANK_DEMO');
    expect(r.body.body.classes.map((c: { class: string }) => c.class)).toEqual([
      'cases_without_alert',
      'alerts_without_customer',
      'approvals_without_case',
    ]);
    expect(r.body.body.is_clean).toBe(true);
  });

  test('501 when no scanner wired (in-memory BFF mode)', async () => {
    const { app } = makeApp({}); // no orphanScanner
    const r = await request(app)
      .get('/v1/admin/data-quality/orphan-references')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(501);
    expect(r.body.error.code).toBe('EWS_501_not_available');
  });

  test('403 when role lacks audit:read', async () => {
    const scanner = new InMemoryOrphanScanner(ZERO_REPORT);
    const { app } = makeApp({ orphanScanner: scanner });
    const r = await request(app)
      .get('/v1/admin/data-quality/orphan-references')
      .set({ ...HEADERS_ADMIN, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('?sample_cap=N is forwarded to the scanner', async () => {
    let observed_cap: number | undefined;
    const stub = {
      async run(opts: { tenant_id: string; sample_cap?: number }) {
        observed_cap = opts.sample_cap;
        return { ...ZERO_REPORT, tenant_id: opts.tenant_id, sample_cap: opts.sample_cap ?? 100 };
      },
    };
    const { app } = makeApp({ orphanScanner: stub });
    await request(app)
      .get('/v1/admin/data-quality/orphan-references?sample_cap=42')
      .set(HEADERS_ADMIN);
    expect(observed_cap).toBe(42);
  });

  test('?sample_cap=abc → 400 invalid_input', async () => {
    const scanner = new InMemoryOrphanScanner(ZERO_REPORT);
    const { app } = makeApp({ orphanScanner: scanner });
    const r = await request(app)
      .get('/v1/admin/data-quality/orphan-references?sample_cap=abc')
      .set(HEADERS_ADMIN);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('missing tenant header → 400 (envelope contract)', async () => {
    const scanner = new InMemoryOrphanScanner(ZERO_REPORT);
    const { app } = makeApp({ orphanScanner: scanner });
    const r = await request(app)
      .get('/v1/admin/data-quality/orphan-references')
      .set({ 'X-Apex-Role': 'admin', 'X-APEX-USER': 'alice.admin' });
    expect(r.status).toBe(400);
  });
});
