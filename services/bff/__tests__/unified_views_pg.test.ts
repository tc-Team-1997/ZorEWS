// services/bff/__tests__/unified_views_pg.test.ts
// Integration tests for the unified.* read-only view layer (T4.25).
//
// Verifies each view exists with the columns declared in
// docs/unified-view-layer-design.md §5, the conventions in §5.0 hold,
// the ORM-readability gate in §8.5 is met, and the performance budget
// in §10.5 is respected on the local zorews-pg seed.
//
// Skipped when BFF_PG_URL / ADMIN_PG_URL unset (mirrors T4.13-T4.18).

import { Pool } from 'pg';

const PG_URL = process.env.BFF_PG_URL ?? process.env.ADMIN_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

// Per-file tenant prefix for hygiene; the views also read pre-existing
// BANK_DEMO seed data so we don't need to insert anything special.
const TENANT_BANK = 'BANK_DEMO';
const TENANT_BIL = 'BIL';

// Column expectations sourced from spec §5 view DDLs (§5.0 ordering rule applied).
// Reality-corrected 2026-05-21 against live mart (no pd_score; mart projects
// full_name / risk_rating / total_outstanding / as_of which the views rename).
const COLS_CUSTOMER_360 = [
  'tenant_id', 'customer_id',
  'name', 'risk_level', 'exposure_kes', 'dpd', 'kyc_status', 'segment', 'onboarded_at',
  'open_alerts_count', 'max_criticality_score', 'latest_alert_at',
  'open_cases_count', 'breached_sla_count', 'pending_approvals_count',
  'last_activity_at',
];

const COLS_ALERTS = [
  'tenant_id', 'alert_id', 'customer_id', 'customer_name',
  'rule_id', 'rule_name', 'severity', 'criticality_score', 'confidence',
  'customer_exposure_kes', 'indicators', 'status', 'assignee',
  'created_at', 'acked_at', 'closed_at',
  'age_minutes',
  'customer_risk_level', 'customer_total_exposure_kes',
];

const COLS_CASES = [
  'tenant_id', 'case_id', 'alert_id', 'customer_id', 'customer_name',
  'severity', 'rule_id', 'rule_name', 'state', 'assignee',
  'loan_id', 'reason_summary', 'outcome', 'sla_status',
  'created_at', 'updated_at', 'closed_at',
  'action_count', 'last_action_at',
  'open_cas_count', 'open_cap_count', 'has_blocking_caps',
  'customer_risk_level',
];

const COLS_AUDIT_ACTIVITY = [
  'source', 'tenant_id', 'event_id', 'ts',
  'actor', 'action', 'resource_type', 'resource_id',
  'outcome', 'severity', 'correlation_id', 'metadata',
];

describeIfPg('unified.* view layer (integration — requires BFF_PG_URL)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
  });

  afterAll(async () => {
    await pool.end();
  });

  // ----------------------------------------------------------------------
  // Existence tests — one per view. Will FAIL until Tasks 4-7 add the
  // CREATE VIEW statements to 035_unified_views.sql.
  // ----------------------------------------------------------------------

  test('unified schema exists', async () => {
    const r = await pool.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'unified'`,
    );
    expect(r.rowCount).toBe(1);
  });

  test('unified.customer_360 exists with declared columns', async () => {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'unified' AND table_name = 'customer_360'
         ORDER BY ordinal_position`,
    );
    expect(r.rows.map((row) => row.column_name)).toEqual(COLS_CUSTOMER_360);
  });

  test('unified.alerts exists with declared columns', async () => {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'unified' AND table_name = 'alerts'
         ORDER BY ordinal_position`,
    );
    expect(r.rows.map((row) => row.column_name)).toEqual(COLS_ALERTS);
  });

  test('unified.cases exists with declared columns', async () => {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'unified' AND table_name = 'cases'
         ORDER BY ordinal_position`,
    );
    expect(r.rows.map((row) => row.column_name)).toEqual(COLS_CASES);
  });

  test('unified.audit_activity exists with declared columns', async () => {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'unified' AND table_name = 'audit_activity'
         ORDER BY ordinal_position`,
    );
    expect(r.rows.map((row) => row.column_name)).toEqual(COLS_AUDIT_ACTIVITY);
  });

  // --------------------------------------------------------------------
  // Data-correctness tests per spec §10 items 2, 3, 10
  // --------------------------------------------------------------------

  test('customer_360: BANK_DEMO has rows from the 10k-customer seed', async () => {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM unified.customer_360 WHERE tenant_id = $1`,
      [TENANT_BANK],
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });

  test('customer_360: open_alerts_count aggregate matches direct count', async () => {
    const fromView = await pool.query(
      `SELECT COALESCE(SUM(open_alerts_count), 0)::int AS n
         FROM unified.customer_360 WHERE tenant_id = $1`,
      [TENANT_BANK],
    );
    const direct = await pool.query(
      `SELECT COUNT(*)::int AS n FROM app_alerts.alerts
         WHERE tenant_id = $1 AND status = 'open'
           AND customer_id IN (SELECT customer_id FROM mart.customer_360 WHERE tenant_id = $1)`,
      [TENANT_BANK],
    );
    // Sum of per-customer open alert counts equals the count of open
    // alerts whose customer is present in the mart for that tenant.
    // (Orphan alerts on customers not in the mart don't show up in
    // the view, so we constrain the direct count likewise.)
    expect(fromView.rows[0].n).toBe(direct.rows[0].n);
  });

  test('customer_360: tenant isolation — BIL ∩ BANK_DEMO customer_ids empty when both have data (spec §10 item #3)', async () => {
    const bilCount = await pool.query(
      `SELECT COUNT(*)::int AS n FROM unified.customer_360 WHERE tenant_id = $1`,
      [TENANT_BIL],
    );
    if (bilCount.rows[0].n === 0) {
      // Current state per spec §10 item #3 + §11: mart.customer_360
      // has BANK_DEMO seed only; BIL synthetic data is a T4.24
      // standalone follow-up. Test logs + passes vacuously.
      // eslint-disable-next-line no-console
      console.log(
        'customer_360 tenant isolation: BIL has 0 rows in the view; ' +
          'skipping intersection check (T4.24 follow-up will seed BIL data).',
      );
      return;
    }
    // Both tenants have data — the intersection MUST be empty.
    const intersection = await pool.query(
      `SELECT b.customer_id FROM unified.customer_360 b
         JOIN unified.customer_360 d
              ON d.customer_id = b.customer_id AND d.tenant_id = $1
        WHERE b.tenant_id = $2 LIMIT 1`,
      [TENANT_BANK, TENANT_BIL],
    );
    expect(intersection.rowCount).toBe(0);
  });
});
