// services/bff/__tests__/investigation_age_status_matrix.test.ts
//
// T6 M9.13 — Investigation age × status cross-tab matrix.

import request from 'supertest';
import {
  buildInvestigationAgeStatusMatrix,
  AGE_BUCKETS,
  type AgeBucketKey,
} from '../src/investigation_age_status_matrix';
import {
  InMemoryCaseInvestigationStore,
  INVESTIGATION_STATUSES,
  type CaseInvestigation,
  type InvestigationStatus,
} from '../src/case_investigation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-16T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const MS_PER_HOUR = 60 * 60 * 1000;

function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * MS_PER_HOUR);
}

function inv(overrides: Partial<CaseInvestigation> = {}): CaseInvestigation {
  return {
    investigation_id: 'inv-1',
    tenant_id: 'BIL',
    case_id: 'C-1',
    customer_id: 'cust-1',
    status: 'triage',
    decision: null,
    opened_at: hoursAgo(1).toISOString(),
    opened_by: 'alice',
    last_updated_at: hoursAgo(1).toISOString(),
    last_updated_by: 'alice',
    closed_at: null,
    steps: [],
    notes_count: 0,
    checklist_template_id: 'BUILT_IN',
    ...overrides,
  };
}

function makeMatrixApp(role = 'admin') {
  const caseInvestigationStore = new InMemoryCaseInvestigationStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    caseInvestigationStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, caseInvestigationStore };
}

function rowFor(matrix: ReturnType<typeof buildInvestigationAgeStatusMatrix>, status: InvestigationStatus) {
  return matrix.matrix.find((r) => r.status === status)!;
}

// ─── buildInvestigationAgeStatusMatrix — pure ────────────────────────

describe('M9.13 — empty input', () => {
  test('zero investigations → every row × bucket emitted at 0', () => {
    const m = buildInvestigationAgeStatusMatrix('BIL', [], NOW);
    expect(m.tenant_id).toBe('BIL');
    expect(m.total_investigations).toBe(0);
    expect(m.matrix.length).toBe(INVESTIGATION_STATUSES.length);
    for (const row of m.matrix) {
      expect(row.row_total).toBe(0);
      expect(Object.keys(row.by_age_bucket).length).toBe(5);
      for (const b of AGE_BUCKETS) expect(row.by_age_bucket[b]).toBe(0);
    }
    expect(m.by_age_bucket_total.length).toBe(5);
    for (const col of m.by_age_bucket_total) expect(col.count).toBe(0);
    expect(m.peak_cell).toBeNull();
    expect(m.oldest_open_status).toBeNull();
  });
});

describe('M9.13 — canonical row + col order', () => {
  test('matrix[] in canonical INVESTIGATION_STATUSES order', () => {
    const m = buildInvestigationAgeStatusMatrix('BIL', [], NOW);
    expect(m.matrix.map((r) => r.status)).toEqual([...INVESTIGATION_STATUSES]);
  });

  test('by_age_bucket_total[] in canonical AGE_BUCKETS order', () => {
    const m = buildInvestigationAgeStatusMatrix('BIL', [], NOW);
    expect(m.by_age_bucket_total.map((c) => c.bucket)).toEqual([...AGE_BUCKETS]);
  });
});

describe('M9.13 — single placement', () => {
  test('one triage investigation aged 50h → triage × 1_to_3d bucket', () => {
    const i = inv({ status: 'triage', opened_at: hoursAgo(50).toISOString() });
    const m = buildInvestigationAgeStatusMatrix('BIL', [i], NOW);
    const triage = rowFor(m, 'triage');
    expect(triage.by_age_bucket['1_to_3d']).toBe(1);
    expect(triage.by_age_bucket.under_24h).toBe(0);
    expect(triage.row_total).toBe(1);
  });

  test('one closed investigation aged 800h → closed × 30d_plus bucket', () => {
    const i = inv({ status: 'closed', opened_at: hoursAgo(800).toISOString() });
    const m = buildInvestigationAgeStatusMatrix('BIL', [i], NOW);
    const closed = rowFor(m, 'closed');
    expect(closed.by_age_bucket['30d_plus']).toBe(1);
    expect(closed.row_total).toBe(1);
  });
});

describe('M9.13 — boundary semantics', () => {
  test('exact 24h → 1_to_3d (strict-< upper)', () => {
    const i = inv({ opened_at: hoursAgo(24).toISOString() });
    const m = buildInvestigationAgeStatusMatrix('BIL', [i], NOW);
    expect(rowFor(m, 'triage').by_age_bucket['1_to_3d']).toBe(1);
    expect(rowFor(m, 'triage').by_age_bucket.under_24h).toBe(0);
  });

  test('exact 72h → 3_to_7d', () => {
    const i = inv({ opened_at: hoursAgo(72).toISOString() });
    const m = buildInvestigationAgeStatusMatrix('BIL', [i], NOW);
    expect(rowFor(m, 'triage').by_age_bucket['3_to_7d']).toBe(1);
  });

  test('exact 168h → 7_to_30d', () => {
    const i = inv({ opened_at: hoursAgo(168).toISOString() });
    const m = buildInvestigationAgeStatusMatrix('BIL', [i], NOW);
    expect(rowFor(m, 'triage').by_age_bucket['7_to_30d']).toBe(1);
  });

  test('exact 720h → 30d_plus', () => {
    const i = inv({ opened_at: hoursAgo(720).toISOString() });
    const m = buildInvestigationAgeStatusMatrix('BIL', [i], NOW);
    expect(rowFor(m, 'triage').by_age_bucket['30d_plus']).toBe(1);
  });
});

describe('M9.13 — multi-status spread', () => {
  test('different statuses + ages bucket independently', () => {
    const items: CaseInvestigation[] = [
      inv({ investigation_id: 'a', status: 'triage', opened_at: hoursAgo(10).toISOString() }),
      inv({ investigation_id: 'b', status: 'gathering_evidence', opened_at: hoursAgo(50).toISOString() }),
      inv({ investigation_id: 'c', status: 'review', opened_at: hoursAgo(200).toISOString() }),
      inv({ investigation_id: 'd', status: 'closed', opened_at: hoursAgo(800).toISOString() }),
    ];
    const m = buildInvestigationAgeStatusMatrix('BIL', items, NOW);
    expect(m.total_investigations).toBe(4);
    expect(rowFor(m, 'triage').by_age_bucket.under_24h).toBe(1);
    expect(rowFor(m, 'gathering_evidence').by_age_bucket['1_to_3d']).toBe(1);
    expect(rowFor(m, 'review').by_age_bucket['7_to_30d']).toBe(1);
    expect(rowFor(m, 'closed').by_age_bucket['30d_plus']).toBe(1);
  });
});

describe('M9.13 — partition invariants', () => {
  test('Σ row_total = total_investigations', () => {
    const items: CaseInvestigation[] = [
      inv({ investigation_id: 'a', status: 'triage', opened_at: hoursAgo(10).toISOString() }),
      inv({ investigation_id: 'b', status: 'triage', opened_at: hoursAgo(50).toISOString() }),
      inv({ investigation_id: 'c', status: 'review', opened_at: hoursAgo(800).toISOString() }),
    ];
    const m = buildInvestigationAgeStatusMatrix('BIL', items, NOW);
    const sum = m.matrix.reduce((acc, r) => acc + r.row_total, 0);
    expect(sum).toBe(m.total_investigations);
  });

  test('Σ by_age_bucket_total.count = total_investigations', () => {
    const items: CaseInvestigation[] = [
      inv({ investigation_id: 'a', status: 'triage', opened_at: hoursAgo(10).toISOString() }),
      inv({ investigation_id: 'b', status: 'gathering_evidence', opened_at: hoursAgo(50).toISOString() }),
      inv({ investigation_id: 'c', status: 'closed', opened_at: hoursAgo(800).toISOString() }),
    ];
    const m = buildInvestigationAgeStatusMatrix('BIL', items, NOW);
    const colSum = m.by_age_bucket_total.reduce((acc, c) => acc + c.count, 0);
    expect(colSum).toBe(m.total_investigations);
  });

  test('Σ row by_age_bucket = row_total per row', () => {
    const items: CaseInvestigation[] = [
      inv({ investigation_id: 'a', status: 'triage', opened_at: hoursAgo(10).toISOString() }),
      inv({ investigation_id: 'b', status: 'triage', opened_at: hoursAgo(50).toISOString() }),
    ];
    const m = buildInvestigationAgeStatusMatrix('BIL', items, NOW);
    for (const row of m.matrix) {
      const rowSum = Object.values(row.by_age_bucket).reduce((a, b) => a + b, 0);
      expect(rowSum).toBe(row.row_total);
    }
  });
});

describe('M9.13 — peak_cell', () => {
  test('points at the highest-count cell', () => {
    const items: CaseInvestigation[] = [
      inv({ investigation_id: 'a', status: 'review', opened_at: hoursAgo(10).toISOString() }),
      inv({ investigation_id: 'b', status: 'review', opened_at: hoursAgo(11).toISOString() }),
      inv({ investigation_id: 'c', status: 'review', opened_at: hoursAgo(12).toISOString() }),
      inv({ investigation_id: 'd', status: 'closed', opened_at: hoursAgo(800).toISOString() }),
    ];
    const m = buildInvestigationAgeStatusMatrix('BIL', items, NOW);
    expect(m.peak_cell).toEqual({ status: 'review', bucket: 'under_24h', count: 3 });
  });

  test('canonical tie-break: earlier status × earlier bucket wins at same count', () => {
    const items: CaseInvestigation[] = [
      inv({ investigation_id: 'a', status: 'triage', opened_at: hoursAgo(10).toISOString() }),
      inv({ investigation_id: 'b', status: 'closed', opened_at: hoursAgo(800).toISOString() }),
    ];
    const m = buildInvestigationAgeStatusMatrix('BIL', items, NOW);
    // Both at 1. Canonical: triage (first status) × under_24h (first bucket).
    expect(m.peak_cell).toEqual({ status: 'triage', bucket: 'under_24h', count: 1 });
  });

  test('null when no investigations', () => {
    const m = buildInvestigationAgeStatusMatrix('BIL', [], NOW);
    expect(m.peak_cell).toBeNull();
  });
});

describe('M9.13 — oldest_open_status', () => {
  test('= status with most cases in stale buckets (7_to_30d + 30d_plus)', () => {
    const items: CaseInvestigation[] = [
      inv({ investigation_id: 'a', status: 'review', opened_at: hoursAgo(200).toISOString() }), // 7_to_30d
      inv({ investigation_id: 'b', status: 'review', opened_at: hoursAgo(800).toISOString() }), // 30d_plus
      inv({ investigation_id: 'c', status: 'closed', opened_at: hoursAgo(900).toISOString() }), // 30d_plus
    ];
    const m = buildInvestigationAgeStatusMatrix('BIL', items, NOW);
    expect(m.oldest_open_status).toEqual({ status: 'review', stale_count: 2 });
  });

  test('canonical tie-break: triage wins over gathering_evidence at same stale count', () => {
    const items: CaseInvestigation[] = [
      inv({ investigation_id: 'a', status: 'gathering_evidence', opened_at: hoursAgo(800).toISOString() }),
      inv({ investigation_id: 'b', status: 'triage', opened_at: hoursAgo(800).toISOString() }),
    ];
    const m = buildInvestigationAgeStatusMatrix('BIL', items, NOW);
    expect(m.oldest_open_status!.status).toBe('triage');
    expect(m.oldest_open_status!.stale_count).toBe(1);
  });

  test('null when no investigations in stale buckets', () => {
    const items: CaseInvestigation[] = [
      inv({ investigation_id: 'a', status: 'triage', opened_at: hoursAgo(10).toISOString() }),
    ];
    const m = buildInvestigationAgeStatusMatrix('BIL', items, NOW);
    expect(m.oldest_open_status).toBeNull();
  });

  test('null when empty', () => {
    const m = buildInvestigationAgeStatusMatrix('BIL', [], NOW);
    expect(m.oldest_open_status).toBeNull();
  });
});

describe('M9.13 — by_age_bucket_total carries labels', () => {
  test('every column has label string', () => {
    const m = buildInvestigationAgeStatusMatrix('BIL', [], NOW);
    for (const col of m.by_age_bucket_total) {
      expect(typeof col.label).toBe('string');
      expect(col.label.length).toBeGreaterThan(0);
    }
  });
});

// ─── GET /v1/investigations/age-status-matrix ────────────────────────

describe('M9.13 — GET /v1/investigations/age-status-matrix', () => {
  test('admin → 200 with empty matrix on fresh tenant', async () => {
    const { app } = makeMatrixApp('admin');
    const r = await request(app).get('/v1/investigations/age-status-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_investigations).toBe(0);
    expect(r.body.body.matrix.length).toBe(INVESTIGATION_STATUSES.length);
    expect(r.body.body.peak_cell).toBeNull();
  });

  test('populated matrix reflects investigations', async () => {
    const { app, caseInvestigationStore } = makeMatrixApp('admin');
    caseInvestigationStore.open(
      'BIL',
      { case_id: 'C1', customer_id: 'cust-1' },
      'alice',
      hoursAgo(800),
    );
    const r = await request(app).get('/v1/investigations/age-status-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_investigations).toBe(1);
    const triageRow = r.body.body.matrix.find((row: { status: string }) => row.status === 'triage');
    expect(triageRow.by_age_bucket['30d_plus']).toBe(1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeMatrixApp('case_owner');
    const r = await request(app).get('/v1/investigations/age-status-matrix').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL investigations invisible to BANK_DEMO', async () => {
    const { app, caseInvestigationStore } = makeMatrixApp('admin');
    caseInvestigationStore.open(
      'BIL',
      { case_id: 'C1', customer_id: 'cust-1' },
      'alice',
      hoursAgo(10),
    );
    const bank = await request(app)
      .get('/v1/investigations/age-status-matrix')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_investigations).toBe(0);
  });

  test('literal /age-status-matrix not captured by :id wildcard', async () => {
    const { app } = makeMatrixApp('admin');
    const r = await request(app).get('/v1/investigations/age-status-matrix').set(TH_BIL);
    expect(r.status).toBe(200);
    // Sanity: confirm :id route still works for unknown.
    const r2 = await request(app).get('/v1/investigations/inv-deadbeef').set(TH_BIL);
    // M9.1 returns 404 for unknown — accept either 404 or 200 depending on store behavior.
    expect([200, 404]).toContain(r2.status);
  });

  test('M9.11 /v1/investigations/age-distribution still works (sibling regression)', async () => {
    const { app } = makeMatrixApp('admin');
    const r = await request(app).get('/v1/investigations/age-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
