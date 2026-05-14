// services/bff/__tests__/investigation_age_buckets.test.ts
//
// T6 M9.11 — Investigation age-bucket distribution.

import request from 'supertest';
import { bucketInvestigationsByAge } from '../src/investigation_age_buckets';
import {
  InMemoryCaseInvestigationStore,
  type CaseInvestigation,
} from '../src/case_investigation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkInv(o: Partial<CaseInvestigation> & { case_id: string; opened_at: string }): CaseInvestigation {
  return {
    investigation_id: o.investigation_id ?? `inv-${o.case_id}`,
    tenant_id: o.tenant_id ?? 'BIL',
    case_id: o.case_id,
    customer_id: o.customer_id ?? 'cust-1',
    status: o.status ?? 'triage',
    decision: o.decision ?? null,
    opened_at: o.opened_at,
    opened_by: o.opened_by ?? 'alice',
    last_updated_at: o.last_updated_at ?? o.opened_at,
    last_updated_by: o.last_updated_by ?? 'alice',
    closed_at: o.closed_at ?? null,
    steps: o.steps ?? [],
    notes_count: o.notes_count ?? 0,
    checklist_template_id: o.checklist_template_id ?? 'BUILT_IN',
  };
}

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}

// ─── bucketInvestigationsByAge — pure ────────────────────────────────

describe('M9.11 — empty', () => {
  test('zero investigations → 5 empty buckets', () => {
    const r = bucketInvestigationsByAge([], NOW);
    expect(r.total_investigations).toBe(0);
    expect(r.buckets).toHaveLength(5);
    for (const b of r.buckets) {
      expect(b.count).toBe(0);
      expect(b.samples).toEqual([]);
    }
  });
});

describe('M9.11 — bucket placement', () => {
  test('investigation opened 5h ago → under_24h', () => {
    const r = bucketInvestigationsByAge([
      mkInv({ case_id: 'C1', opened_at: hoursAgo(5) }),
    ], NOW);
    expect(r.buckets.find((b) => b.bucket === 'under_24h')!.count).toBe(1);
    expect(r.buckets.find((b) => b.bucket === '1_to_3d')!.count).toBe(0);
  });

  test('opened 50h ago → 1_to_3d', () => {
    const r = bucketInvestigationsByAge([
      mkInv({ case_id: 'C1', opened_at: hoursAgo(50) }),
    ], NOW);
    expect(r.buckets.find((b) => b.bucket === '1_to_3d')!.count).toBe(1);
  });

  test('opened 100h ago → 3_to_7d', () => {
    const r = bucketInvestigationsByAge([
      mkInv({ case_id: 'C1', opened_at: hoursAgo(100) }),
    ], NOW);
    expect(r.buckets.find((b) => b.bucket === '3_to_7d')!.count).toBe(1);
  });

  test('opened 14 days ago → 7_to_30d', () => {
    const r = bucketInvestigationsByAge([
      mkInv({ case_id: 'C1', opened_at: hoursAgo(14 * 24) }),
    ], NOW);
    expect(r.buckets.find((b) => b.bucket === '7_to_30d')!.count).toBe(1);
  });

  test('opened 45 days ago → 30d_plus', () => {
    const r = bucketInvestigationsByAge([
      mkInv({ case_id: 'C1', opened_at: hoursAgo(45 * 24) }),
    ], NOW);
    expect(r.buckets.find((b) => b.bucket === '30d_plus')!.count).toBe(1);
  });
});

describe('M9.11 — bucket boundaries', () => {
  test('exactly 24h → 1_to_3d (boundary inclusive on min)', () => {
    const r = bucketInvestigationsByAge([
      mkInv({ case_id: 'C1', opened_at: hoursAgo(24) }),
    ], NOW);
    expect(r.buckets.find((b) => b.bucket === '1_to_3d')!.count).toBe(1);
  });

  test('exactly 72h → 3_to_7d', () => {
    const r = bucketInvestigationsByAge([
      mkInv({ case_id: 'C1', opened_at: hoursAgo(72) }),
    ], NOW);
    expect(r.buckets.find((b) => b.bucket === '3_to_7d')!.count).toBe(1);
  });

  test('exactly 720h (30d) → 30d_plus', () => {
    const r = bucketInvestigationsByAge([
      mkInv({ case_id: 'C1', opened_at: hoursAgo(720) }),
    ], NOW);
    expect(r.buckets.find((b) => b.bucket === '30d_plus')!.count).toBe(1);
  });
});

describe('M9.11 — samples = top-3 oldest per bucket', () => {
  test('5 investigations in same bucket → samples are top 3 by age desc', () => {
    const r = bucketInvestigationsByAge([
      mkInv({ case_id: 'C1', opened_at: hoursAgo(40) }),
      mkInv({ case_id: 'C2', opened_at: hoursAgo(50) }),
      mkInv({ case_id: 'C3', opened_at: hoursAgo(60) }),
      mkInv({ case_id: 'C4', opened_at: hoursAgo(45) }),
      mkInv({ case_id: 'C5', opened_at: hoursAgo(70) }),
    ], NOW);
    const bucket = r.buckets.find((b) => b.bucket === '1_to_3d')!;
    expect(bucket.count).toBe(5);
    expect(bucket.samples).toHaveLength(3);
    // Top 3 by age desc → C5 (70h), C3 (60h), C2 (50h)
    expect(bucket.samples.map((s) => s.case_id)).toEqual(['C5', 'C3', 'C2']);
  });
});

describe('M9.11 — bucket order + metadata', () => {
  test('5 buckets in canonical order with correct bounds', () => {
    const r = bucketInvestigationsByAge([], NOW);
    expect(r.buckets.map((b) => b.bucket)).toEqual([
      'under_24h',
      '1_to_3d',
      '3_to_7d',
      '7_to_30d',
      '30d_plus',
    ]);
    expect(r.buckets[0]!.min_hours).toBe(0);
    expect(r.buckets[0]!.max_hours).toBe(24);
    expect(r.buckets[4]!.min_hours).toBe(720);
    expect(r.buckets[4]!.max_hours).toBeNull();
  });

  test('every bucket carries a label', () => {
    const r = bucketInvestigationsByAge([], NOW);
    for (const b of r.buckets) {
      expect(typeof b.label).toBe('string');
      expect(b.label.length).toBeGreaterThan(0);
    }
  });
});

describe('M9.11 — sample stability', () => {
  test('tie on age_hours → sorted by investigation_id asc', () => {
    const sameTs = hoursAgo(40);
    const r = bucketInvestigationsByAge([
      mkInv({ investigation_id: 'inv-zeta', case_id: 'CZ', opened_at: sameTs }),
      mkInv({ investigation_id: 'inv-alpha', case_id: 'CA', opened_at: sameTs }),
      mkInv({ investigation_id: 'inv-beta', case_id: 'CB', opened_at: sameTs }),
      mkInv({ investigation_id: 'inv-delta', case_id: 'CD', opened_at: sameTs }),
    ], NOW);
    const bucket = r.buckets.find((b) => b.bucket === '1_to_3d')!;
    expect(bucket.count).toBe(4);
    expect(bucket.samples.map((s) => s.investigation_id)).toEqual([
      'inv-alpha',
      'inv-beta',
      'inv-delta',
    ]);
  });
});

// ─── GET /v1/investigations/age-distribution ─────────────────────────

function makeAgeApp(role = 'admin') {
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

describe('M9.11 — GET /v1/investigations/age-distribution', () => {
  test('empty tenant → 200 with 5 empty buckets', async () => {
    const { app } = makeAgeApp('admin');
    const r = await request(app).get('/v1/investigations/age-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_investigations).toBe(0);
    expect(r.body.body.buckets).toHaveLength(5);
  });

  test('records bucketed correctly via the route', async () => {
    const { app, caseInvestigationStore } = makeAgeApp('admin');
    caseInvestigationStore.open(
      'BIL',
      { case_id: 'C1', customer_id: 'cust-1' },
      'alice',
      new Date(NOW.getTime() - 50 * 3_600_000),
    );
    const r = await request(app).get('/v1/investigations/age-distribution').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_investigations).toBe(1);
    const bucket = r.body.body.buckets.find((b: { bucket: string }) => b.bucket === '1_to_3d');
    expect(bucket.count).toBe(1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAgeApp('case_owner');
    const r = await request(app).get('/v1/investigations/age-distribution').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL invisible to BANK_DEMO', async () => {
    const { app, caseInvestigationStore } = makeAgeApp('admin');
    caseInvestigationStore.open(
      'BIL',
      { case_id: 'C1', customer_id: 'cust-1' },
      'alice',
      NOW,
    );
    const r = await request(app)
      .get('/v1/investigations/age-distribution')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.total_investigations).toBe(0);
  });
});
