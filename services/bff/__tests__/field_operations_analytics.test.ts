// services/bff/__tests__/field_operations_analytics.test.ts
//
// T6 M14.19 — Field-operations analytics.

import request from 'supertest';
import {
  SUCCESS_OUTCOMES,
  summarizeFieldOperations,
} from '../src/field_operations_analytics';
import {
  InMemoryFieldVisitStore,
  type FieldVisit,
  type VisitOutcome,
} from '../src/field_officer';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

let id = 0;
function mkVisit(o: Partial<FieldVisit> & { officer_id: string; customer_id: string; outcome: VisitOutcome }): FieldVisit {
  id += 1;
  return {
    visit_id: `vst-${id}`,
    tenant_id: o.tenant_id ?? 'BIL',
    officer_id: o.officer_id,
    customer_id: o.customer_id,
    visit_at: o.visit_at ?? NOW.toISOString(),
    outcome: o.outcome,
    note: o.note ?? '',
    location: o.location ?? null,
    created_at: o.created_at ?? NOW.toISOString(),
    created_by: o.created_by ?? 'alice',
  };
}

beforeEach(() => {
  id = 0;
});

// ─── summarizeFieldOperations ────────────────────────────────────────

describe('M14.19 — summarizeFieldOperations — empty + shape', () => {
  test('empty visits → zero envelope, null rate fields, outcome_mix populated', () => {
    const a = summarizeFieldOperations([]);
    expect(a.sample_size).toBe(0);
    expect(a.distinct_officers).toBe(0);
    expect(a.distinct_customers).toBe(0);
    expect(a.success_count).toBe(0);
    expect(a.success_rate).toBeNull();
    expect(a.mean_visits_per_officer).toBeNull();
    expect(a.per_officer).toEqual([]);
    // outcome_mix still has all 6 keys at zero.
    expect(a.outcome_mix.total).toBe(0);
    expect(a.outcome_mix.by_outcome.met_customer).toBe(0);
    expect(a.outcome_mix.by_outcome.dispute).toBe(0);
  });

  test('SUCCESS_OUTCOMES is the canonical "collections-success" trio', () => {
    expect([...SUCCESS_OUTCOMES].sort()).toEqual(
      ['met_customer', 'partial_payment', 'promised_to_pay'].sort(),
    );
  });
});

describe('M14.19 — outcome mix + success rate', () => {
  test('success_rate counts only the 3 success outcomes', () => {
    const visits: FieldVisit[] = [
      mkVisit({ officer_id: 'o1', customer_id: 'c1', outcome: 'met_customer' }),
      mkVisit({ officer_id: 'o1', customer_id: 'c2', outcome: 'partial_payment' }),
      mkVisit({ officer_id: 'o1', customer_id: 'c3', outcome: 'promised_to_pay' }),
      mkVisit({ officer_id: 'o1', customer_id: 'c4', outcome: 'no_response' }),
      mkVisit({ officer_id: 'o1', customer_id: 'c5', outcome: 'dispute' }),
      mkVisit({ officer_id: 'o1', customer_id: 'c6', outcome: 'escalation_needed' }),
    ];
    const a = summarizeFieldOperations(visits);
    expect(a.sample_size).toBe(6);
    expect(a.success_count).toBe(3);
    expect(a.success_rate).toBe(0.5);
  });

  test('outcome_mix.by_outcome counts each outcome exactly once per visit', () => {
    const visits: FieldVisit[] = [
      mkVisit({ officer_id: 'o1', customer_id: 'c1', outcome: 'dispute' }),
      mkVisit({ officer_id: 'o1', customer_id: 'c1', outcome: 'dispute' }),
      mkVisit({ officer_id: 'o2', customer_id: 'c2', outcome: 'met_customer' }),
    ];
    const a = summarizeFieldOperations(visits);
    expect(a.outcome_mix.by_outcome.dispute).toBe(2);
    expect(a.outcome_mix.by_outcome.met_customer).toBe(1);
    expect(a.outcome_mix.by_outcome.no_response).toBe(0);
  });
});

describe('M14.19 — per-officer rollup', () => {
  test('per_officer tracks distinct customers, success rate, last_visit_at', () => {
    const visits: FieldVisit[] = [
      mkVisit({
        officer_id: 'alice',
        customer_id: 'c1',
        outcome: 'met_customer',
        visit_at: '2026-05-14T08:00:00.000Z',
      }),
      mkVisit({
        officer_id: 'alice',
        customer_id: 'c1', // dup customer for alice
        outcome: 'partial_payment',
        visit_at: '2026-05-14T10:00:00.000Z',
      }),
      mkVisit({
        officer_id: 'alice',
        customer_id: 'c2',
        outcome: 'no_response',
        visit_at: '2026-05-14T11:00:00.000Z',
      }),
    ];
    const a = summarizeFieldOperations(visits);
    expect(a.per_officer.length).toBe(1);
    const alice = a.per_officer[0]!;
    expect(alice.officer_id).toBe('alice');
    expect(alice.visit_count).toBe(3);
    expect(alice.distinct_customers).toBe(2);
    // 2 success / 3 total = 0.666…
    expect(alice.success_rate).toBeCloseTo(2 / 3, 5);
    // Latest of the 3 timestamps.
    expect(alice.last_visit_at).toBe('2026-05-14T11:00:00.000Z');
    expect(alice.by_outcome.met_customer).toBe(1);
    expect(alice.by_outcome.partial_payment).toBe(1);
    expect(alice.by_outcome.no_response).toBe(1);
  });

  test('per_officer sorted by visit_count desc, then success_rate desc, then officer_id asc', () => {
    const visits: FieldVisit[] = [
      // alice: 3 visits, all success → success_rate=1
      ...[1, 2, 3].map((i) =>
        mkVisit({ officer_id: 'alice', customer_id: `c${i}`, outcome: 'met_customer' }),
      ),
      // bob: 2 visits, all success → success_rate=1
      ...[1, 2].map((i) =>
        mkVisit({ officer_id: 'bob', customer_id: `c${i}`, outcome: 'met_customer' }),
      ),
      // carol: 2 visits, mix → success_rate=0.5 (loses to bob on tie-break)
      mkVisit({ officer_id: 'carol', customer_id: 'c1', outcome: 'met_customer' }),
      mkVisit({ officer_id: 'carol', customer_id: 'c2', outcome: 'dispute' }),
    ];
    const a = summarizeFieldOperations(visits);
    expect(a.per_officer.map((o) => o.officer_id)).toEqual(['alice', 'bob', 'carol']);
  });

  test('ties on both visit_count and success_rate broken by officer_id asc', () => {
    const visits: FieldVisit[] = [
      mkVisit({ officer_id: 'zeta', customer_id: 'c1', outcome: 'met_customer' }),
      mkVisit({ officer_id: 'alpha', customer_id: 'c1', outcome: 'met_customer' }),
      mkVisit({ officer_id: 'mike', customer_id: 'c1', outcome: 'met_customer' }),
    ];
    const a = summarizeFieldOperations(visits);
    expect(a.per_officer.map((o) => o.officer_id)).toEqual(['alpha', 'mike', 'zeta']);
  });

  test('distinct_officers + mean_visits_per_officer derived correctly', () => {
    const visits: FieldVisit[] = [
      mkVisit({ officer_id: 'a', customer_id: 'c1', outcome: 'met_customer' }),
      mkVisit({ officer_id: 'a', customer_id: 'c2', outcome: 'dispute' }),
      mkVisit({ officer_id: 'b', customer_id: 'c3', outcome: 'met_customer' }),
      mkVisit({ officer_id: 'b', customer_id: 'c4', outcome: 'met_customer' }),
      mkVisit({ officer_id: 'b', customer_id: 'c5', outcome: 'met_customer' }),
    ];
    const a = summarizeFieldOperations(visits);
    expect(a.distinct_officers).toBe(2);
    // 5 visits / 2 officers = 2.5
    expect(a.mean_visits_per_officer).toBe(2.5);
  });
});

describe('M14.19 — distinct customers', () => {
  test('distinct_customers counts customer_id once across all officers', () => {
    const visits: FieldVisit[] = [
      mkVisit({ officer_id: 'a', customer_id: 'c1', outcome: 'met_customer' }),
      mkVisit({ officer_id: 'b', customer_id: 'c1', outcome: 'dispute' }),
      mkVisit({ officer_id: 'b', customer_id: 'c2', outcome: 'no_response' }),
    ];
    const a = summarizeFieldOperations(visits);
    expect(a.distinct_customers).toBe(2);
  });
});

// ─── GET /v1/field/operations/analytics ──────────────────────────────

function makeOpsApp(role = 'admin', store?: InMemoryFieldVisitStore) {
  const visitStore = store ?? new InMemoryFieldVisitStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    fieldVisitStore: visitStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, visitStore };
}

describe('M14.19 — GET /v1/field/operations/analytics', () => {
  test('empty ledger → 200 with zero envelope', async () => {
    const { app } = makeOpsApp('admin');
    const r = await request(app)
      .get('/v1/field/operations/analytics')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.analytics.sample_size).toBe(0);
    expect(r.body.body.analytics.success_rate).toBeNull();
  });

  test('visits in store surface in the analytics roll-up', async () => {
    const store = new InMemoryFieldVisitStore();
    store.log(
      'BIL',
      {
        officer_id: 'alice',
        customer_id: 'c1',
        visit_at: new Date(NOW.getTime() - 2 * HOUR_MS).toISOString(),
        outcome: 'met_customer',
        note: 'paid',
      },
      'alice',
      NOW,
    );
    store.log(
      'BIL',
      {
        officer_id: 'alice',
        customer_id: 'c2',
        visit_at: new Date(NOW.getTime() - 1 * HOUR_MS).toISOString(),
        outcome: 'dispute',
        note: 'argued',
      },
      'alice',
      NOW,
    );
    const { app } = makeOpsApp('admin', store);
    const r = await request(app)
      .get('/v1/field/operations/analytics')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.analytics.sample_size).toBe(2);
    expect(r.body.body.analytics.distinct_officers).toBe(1);
    expect(r.body.body.analytics.per_officer[0].officer_id).toBe('alice');
    expect(r.body.body.analytics.per_officer[0].visit_count).toBe(2);
    expect(r.body.body.analytics.per_officer[0].success_rate).toBe(0.5);
  });

  test('?officer_id= filter narrows the window', async () => {
    const store = new InMemoryFieldVisitStore();
    store.log(
      'BIL',
      { officer_id: 'alice', customer_id: 'c1', visit_at: NOW.toISOString(), outcome: 'met_customer', note: 'visited'},
      'alice',
      NOW,
    );
    store.log(
      'BIL',
      { officer_id: 'bob', customer_id: 'c2', visit_at: NOW.toISOString(), outcome: 'no_response', note: 'no answer'},
      'bob',
      NOW,
    );
    const { app } = makeOpsApp('admin', store);
    const r = await request(app)
      .get('/v1/field/operations/analytics?officer_id=alice')
      .set(TH_BIL);
    expect(r.body.body.analytics.sample_size).toBe(1);
    expect(r.body.body.analytics.per_officer.map((o: { officer_id: string }) => o.officer_id)).toEqual(['alice']);
  });

  test('?outcome=invalid → 400 invalid_input', async () => {
    const { app } = makeOpsApp('admin');
    const r = await request(app)
      .get('/v1/field/operations/analytics?outcome=banana')
      .set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeOpsApp('case_owner');
    const r = await request(app)
      .get('/v1/field/operations/analytics')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant isolation: BANK_DEMO does not see BIL visits', async () => {
    const store = new InMemoryFieldVisitStore();
    store.log(
      'BIL',
      { officer_id: 'alice', customer_id: 'c1', visit_at: NOW.toISOString(), outcome: 'met_customer', note: 'visited'},
      'alice',
      NOW,
    );
    const { app } = makeOpsApp('admin', store);
    const r = await request(app)
      .get('/v1/field/operations/analytics')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(200);
    expect(r.body.body.analytics.sample_size).toBe(0);
  });
});
