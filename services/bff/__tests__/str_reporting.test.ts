// services/bff/__tests__/str_reporting.test.ts
//
// Phase C.1 — AML STR Reporting workflow.

import request from 'supertest';
import {
  ALL_STR_REASONS,
  ALL_STR_STATUSES,
  buildStrSummary,
  canTransition,
  defaultStrReportStore,
  InMemoryStrReportStore,
  isStrReason,
  isStrStatus,
  STR_REPORT_CAP_PER_TENANT,
  STR_SUPPORTING_DOCS_CAP,
  StrError,
} from '../src/aml/str_reporting';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';
import { InMemoryRecoveryStore } from '../src/recovery/store';

const NOW = new Date('2026-05-21T09:00:00.000Z');
const TH_BIL_ALICE = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'alice.maker' };
const TH_BIL_BOB = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API', 'X-APEX-USER': 'bob.checker' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API', 'X-APEX-USER': 'admin' };

function makeStrApp(role: string = 'admin', overrides: {
  strReportStore?: InMemoryStrReportStore;
  recoveryStore?: InMemoryRecoveryStore;
} = {}) {
  const { app } = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    strReportStore: overrides.strReportStore ?? new InMemoryStrReportStore(),
    recoveryStore: overrides.recoveryStore ?? new InMemoryRecoveryStore(),
  });
  return app;
}

const validInput = (over: Record<string, unknown> = {}) => ({
  str_id: 'STR-BIL-2026-00001',
  customer_id: 'CUST_BIL_00001',
  reasons: ['unusual_pattern' as const],
  total_amount_kes: 1_500_000,
  transaction_count: 7,
  date_range_start: '2026-04-01T00:00:00.000Z',
  date_range_end: '2026-04-30T23:59:59.000Z',
  narrative:
    'Customer made 7 cash deposits just below the structuring threshold within 30 days.',
  supporting_doc_refs: ['dms://doc/abc-123'],
  ...over,
});

// ─── 1. Enums + transitions ──────────────────────────────────────────

describe('STR enums', () => {
  test('5 statuses incl. terminals', () => {
    expect(ALL_STR_STATUSES).toEqual([
      'draft', 'ready_for_review', 'submitted', 'acknowledged', 'rejected',
    ]);
  });
  test('10 FIU-IND reasons', () => {
    expect(ALL_STR_REASONS.length).toBe(10);
    expect(ALL_STR_REASONS).toContain('sanctions_hit');
    expect(ALL_STR_REASONS).toContain('structuring');
  });
  test('type guards', () => {
    for (const s of ALL_STR_STATUSES) expect(isStrStatus(s)).toBe(true);
    expect(isStrStatus('approved')).toBe(false);
    for (const r of ALL_STR_REASONS) expect(isStrReason(r)).toBe(true);
    expect(isStrReason('weird')).toBe(false);
  });
});

describe('canTransition', () => {
  test('draft → ready_for_review only', () => {
    expect(canTransition('draft', 'ready_for_review')).toBe(true);
    expect(canTransition('draft', 'submitted')).toBe(false);
    expect(canTransition('draft', 'acknowledged')).toBe(false);
  });
  test('ready_for_review → submitted OR back to draft', () => {
    expect(canTransition('ready_for_review', 'submitted')).toBe(true);
    expect(canTransition('ready_for_review', 'draft')).toBe(true);
    expect(canTransition('ready_for_review', 'acknowledged')).toBe(false);
  });
  test('submitted → acknowledged / rejected', () => {
    expect(canTransition('submitted', 'acknowledged')).toBe(true);
    expect(canTransition('submitted', 'rejected')).toBe(true);
    expect(canTransition('submitted', 'draft')).toBe(false);
  });
  test('terminal states forbid further transitions', () => {
    for (const t of ALL_STR_STATUSES) {
      expect(canTransition('acknowledged', t)).toBe(false);
      expect(canTransition('rejected', t)).toBe(false);
    }
  });
});

// ─── 2. Validation ──────────────────────────────────────────────────

describe('InMemoryStrReportStore.create validation', () => {
  test('happy path returns populated entry in draft', () => {
    const s = new InMemoryStrReportStore();
    const e = s.create('BIL', validInput(), 'alice.maker', NOW);
    expect(e.status).toBe('draft');
    expect(e.maker_username).toBe('alice.maker');
    expect(e.checker_username).toBeNull();
    expect(e.reasons).toEqual(['unusual_pattern']);
    expect(e.tenant_id).toBe('BIL');
  });

  test('invalid str_id format rejected', () => {
    const s = new InMemoryStrReportStore();
    expect(() =>
      s.create('BIL', validInput({ str_id: 'lower-case' }), 'a', NOW),
    ).toThrow(StrError);
  });

  test('empty reasons rejected', () => {
    const s = new InMemoryStrReportStore();
    expect(() => s.create('BIL', validInput({ reasons: [] }), 'a', NOW)).toThrow(StrError);
  });

  test('unknown reason rejected', () => {
    const s = new InMemoryStrReportStore();
    expect(() =>
      s.create('BIL', validInput({ reasons: ['foo'] }), 'a', NOW),
    ).toThrow(StrError);
  });

  test('duplicate reasons rejected', () => {
    const s = new InMemoryStrReportStore();
    expect(() =>
      s.create('BIL', validInput({ reasons: ['structuring', 'structuring'] }), 'a', NOW),
    ).toThrow(StrError);
  });

  test('non-positive amount rejected', () => {
    const s = new InMemoryStrReportStore();
    expect(() =>
      s.create('BIL', validInput({ total_amount_kes: 0 }), 'a', NOW),
    ).toThrow(StrError);
    expect(() =>
      s.create('BIL', validInput({ total_amount_kes: -100 }), 'a', NOW),
    ).toThrow(StrError);
  });

  test('non-integer / non-positive transaction_count rejected', () => {
    const s = new InMemoryStrReportStore();
    expect(() =>
      s.create('BIL', validInput({ transaction_count: 0 }), 'a', NOW),
    ).toThrow(StrError);
    expect(() =>
      s.create('BIL', validInput({ transaction_count: 1.5 }), 'a', NOW),
    ).toThrow(StrError);
  });

  test('inverted date range rejected', () => {
    const s = new InMemoryStrReportStore();
    expect(() =>
      s.create(
        'BIL',
        validInput({
          date_range_start: '2026-04-30T00:00:00.000Z',
          date_range_end: '2026-04-01T00:00:00.000Z',
        }),
        'a',
        NOW,
      ),
    ).toThrow(StrError);
  });

  test('narrative below regulatory minimum (20 chars) rejected', () => {
    const s = new InMemoryStrReportStore();
    expect(() =>
      s.create('BIL', validInput({ narrative: 'too short' }), 'a', NOW),
    ).toThrow(StrError);
  });

  test('narrative > 1000 chars rejected', () => {
    const s = new InMemoryStrReportStore();
    expect(() =>
      s.create('BIL', validInput({ narrative: 'x'.repeat(1001) }), 'a', NOW),
    ).toThrow(StrError);
  });

  test('supporting_doc_refs over cap rejected', () => {
    const s = new InMemoryStrReportStore();
    const tooMany = Array(STR_SUPPORTING_DOCS_CAP + 1).fill('dms://d');
    expect(() =>
      s.create('BIL', validInput({ supporting_doc_refs: tooMany }), 'a', NOW),
    ).toThrow(StrError);
  });

  test('overlong supporting_doc_ref entry rejected', () => {
    const s = new InMemoryStrReportStore();
    expect(() =>
      s.create('BIL', validInput({ supporting_doc_refs: ['x'.repeat(201)] }), 'a', NOW),
    ).toThrow(StrError);
  });

  test('missing maker rejected', () => {
    const s = new InMemoryStrReportStore();
    expect(() => s.create('BIL', validInput(), '', NOW)).toThrow(StrError);
  });

  test('duplicate str_id rejected', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput(), 'a', NOW);
    expect(() => s.create('BIL', validInput(), 'a', NOW)).toThrow(StrError);
  });
});

// ─── 3. Update + immutability ────────────────────────────────────────

describe('InMemoryStrReportStore.update', () => {
  test('happy update in draft', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput(), 'alice', NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const u = s.update(
      'BIL',
      'STR-BIL-2026-00001',
      { total_amount_kes: 2_500_000, narrative: 'Updated narrative — clear pattern of structuring.' },
      'alice',
      later,
    );
    expect(u.total_amount_kes).toBe(2_500_000);
    expect(u.narrative).toBe('Updated narrative — clear pattern of structuring.');
    expect(u.updated_by).toBe('alice');
  });

  test('update of submitted STR rejected (immutable)', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput(), 'alice', NOW);
    s.transition('BIL', 'STR-BIL-2026-00001', { to: 'ready_for_review' }, 'alice', NOW);
    s.transition(
      'BIL',
      'STR-BIL-2026-00001',
      { to: 'submitted', checker_username: 'bob.checker' },
      'bob.checker',
      NOW,
    );
    expect(() =>
      s.update('BIL', 'STR-BIL-2026-00001', { total_amount_kes: 5_000_000 }, 'bob', NOW),
    ).toThrow(StrError);
  });

  test('merged-effective date-range validation on patch', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput(), 'alice', NOW);
    // Patch start later than existing end → should fail.
    expect(() =>
      s.update(
        'BIL',
        'STR-BIL-2026-00001',
        { date_range_start: '2026-05-15T00:00:00.000Z' },
        'alice',
        NOW,
      ),
    ).toThrow(StrError);
    // Patch both consistently → OK.
    const u = s.update(
      'BIL',
      'STR-BIL-2026-00001',
      {
        date_range_start: '2026-05-01T00:00:00.000Z',
        date_range_end: '2026-05-31T00:00:00.000Z',
      },
      'alice',
      NOW,
    );
    expect(u.date_range_start).toBe('2026-05-01T00:00:00.000Z');
  });
});

// ─── 4. Workflow transitions ─────────────────────────────────────────

describe('InMemoryStrReportStore.transition', () => {
  test('happy: draft → ready_for_review', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput(), 'alice', NOW);
    const r = s.transition('BIL', 'STR-BIL-2026-00001', { to: 'ready_for_review' }, 'alice', NOW);
    expect(r.status).toBe('ready_for_review');
  });

  test('illegal: draft → submitted (must go via ready_for_review)', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput(), 'alice', NOW);
    expect(() =>
      s.transition(
        'BIL',
        'STR-BIL-2026-00001',
        { to: 'submitted', checker_username: 'bob' },
        'bob',
        NOW,
      ),
    ).toThrow(StrError);
  });

  test('ready_for_review → submitted requires checker_username', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput(), 'alice', NOW);
    s.transition('BIL', 'STR-BIL-2026-00001', { to: 'ready_for_review' }, 'alice', NOW);
    expect(() =>
      s.transition('BIL', 'STR-BIL-2026-00001', { to: 'submitted' }, 'bob', NOW),
    ).toThrow(StrError);
  });

  test('self-approval (maker = checker) refused with CRITICAL severity hint', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput(), 'alice', NOW);
    s.transition('BIL', 'STR-BIL-2026-00001', { to: 'ready_for_review' }, 'alice', NOW);
    expect(() =>
      s.transition(
        'BIL',
        'STR-BIL-2026-00001',
        { to: 'submitted', checker_username: 'alice' },
        'alice',
        NOW,
      ),
    ).toThrow(StrError);
  });

  test('submitted → acknowledged requires ack_reference', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput(), 'alice', NOW);
    s.transition('BIL', 'STR-BIL-2026-00001', { to: 'ready_for_review' }, 'alice', NOW);
    s.transition(
      'BIL',
      'STR-BIL-2026-00001',
      { to: 'submitted', checker_username: 'bob' },
      'bob',
      NOW,
    );
    expect(() =>
      s.transition('BIL', 'STR-BIL-2026-00001', { to: 'acknowledged' }, 'admin', NOW),
    ).toThrow(StrError);
    const r = s.transition(
      'BIL',
      'STR-BIL-2026-00001',
      { to: 'acknowledged', ack_reference: 'FIU-2026-ACK-789' },
      'admin',
      NOW,
    );
    expect(r.status).toBe('acknowledged');
    expect(r.ack_reference).toBe('FIU-2026-ACK-789');
    expect(r.ack_received_at).toBeDefined();
  });

  test('submitted → rejected requires rejection_reason', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput(), 'alice', NOW);
    s.transition('BIL', 'STR-BIL-2026-00001', { to: 'ready_for_review' }, 'alice', NOW);
    s.transition(
      'BIL',
      'STR-BIL-2026-00001',
      { to: 'submitted', checker_username: 'bob' },
      'bob',
      NOW,
    );
    expect(() =>
      s.transition('BIL', 'STR-BIL-2026-00001', { to: 'rejected' }, 'admin', NOW),
    ).toThrow(StrError);
    const r = s.transition(
      'BIL',
      'STR-BIL-2026-00001',
      { to: 'rejected', rejection_reason: 'Insufficient supporting documentation.' },
      'admin',
      NOW,
    );
    expect(r.status).toBe('rejected');
    expect(r.rejection_reason).toBe('Insufficient supporting documentation.');
  });

  test('ready_for_review → draft (checker sends back to maker)', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput(), 'alice', NOW);
    s.transition('BIL', 'STR-BIL-2026-00001', { to: 'ready_for_review' }, 'alice', NOW);
    const r = s.transition('BIL', 'STR-BIL-2026-00001', { to: 'draft' }, 'bob', NOW);
    expect(r.status).toBe('draft');
  });

  test('acknowledged is terminal', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput(), 'alice', NOW);
    s.transition('BIL', 'STR-BIL-2026-00001', { to: 'ready_for_review' }, 'alice', NOW);
    s.transition('BIL', 'STR-BIL-2026-00001', { to: 'submitted', checker_username: 'bob' }, 'bob', NOW);
    s.transition('BIL', 'STR-BIL-2026-00001', { to: 'acknowledged', ack_reference: 'X' }, 'admin', NOW);
    for (const t of ALL_STR_STATUSES) {
      expect(() => s.transition('BIL', 'STR-BIL-2026-00001', { to: t }, 'admin', NOW)).toThrow(StrError);
    }
  });
});

// ─── 5. Soft-delete invariant ────────────────────────────────────────

describe('InMemoryStrReportStore.softDelete', () => {
  test('draft can be soft-deleted', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput(), 'alice', NOW);
    const t = s.softDelete('BIL', 'STR-BIL-2026-00001', 'admin', NOW);
    expect(t.deleted_at).toBe(NOW.toISOString());
    expect(s.get('BIL', 'STR-BIL-2026-00001')).toBeNull();
  });

  test('submitted STR cannot be soft-deleted (FIU-IND retention)', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput(), 'alice', NOW);
    s.transition('BIL', 'STR-BIL-2026-00001', { to: 'ready_for_review' }, 'alice', NOW);
    s.transition('BIL', 'STR-BIL-2026-00001', { to: 'submitted', checker_username: 'bob' }, 'bob', NOW);
    expect(() => s.softDelete('BIL', 'STR-BIL-2026-00001', 'admin', NOW)).toThrow(StrError);
  });

  test('restore round-trip', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput(), 'alice', NOW);
    const t = s.softDelete('BIL', 'STR-BIL-2026-00001', 'admin', NOW);
    expect(s.restore(t)).toBe(true);
    expect(s.get('BIL', 'STR-BIL-2026-00001')?.deleted_at).toBeNull();
  });
});

// ─── 6. Tenant scoping + list filters ────────────────────────────────

describe('InMemoryStrReportStore.list', () => {
  test('tenant scoping', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput(), 'alice', NOW);
    s.create('BANK_DEMO', validInput({ str_id: 'STR-BANK-001' }), 'admin', NOW);
    expect(s.list('BIL').map((e) => e.str_id)).toEqual(['STR-BIL-2026-00001']);
    expect(s.list('BANK_DEMO').map((e) => e.str_id)).toEqual(['STR-BANK-001']);
  });

  test('?status filter narrows', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput(), 'alice', NOW);
    s.create('BIL', validInput({ str_id: 'STR-002' }), 'alice', NOW);
    s.transition('BIL', 'STR-002', { to: 'ready_for_review' }, 'alice', NOW);
    expect(s.list('BIL', { status: 'draft' }).length).toBe(1);
    expect(s.list('BIL', { status: 'ready_for_review' }).length).toBe(1);
  });

  test('newest-first sort', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput({ str_id: 'STR-A' }), 'alice', NOW);
    s.create('BIL', validInput({ str_id: 'STR-B' }), 'alice', new Date(NOW.getTime() + 1000));
    s.create('BIL', validInput({ str_id: 'STR-C' }), 'alice', new Date(NOW.getTime() + 2000));
    expect(s.list('BIL').map((e) => e.str_id)).toEqual(['STR-C', 'STR-B', 'STR-A']);
  });
});

// ─── 7. Summary helper ───────────────────────────────────────────────

describe('buildStrSummary', () => {
  test('empty', () => {
    const s = new InMemoryStrReportStore();
    const sum = buildStrSummary(s, 'BIL', NOW);
    expect(sum.total_strs).toBe(0);
    expect(sum.pending_review_count).toBe(0);
    expect(sum.unacked_submitted_count).toBe(0);
  });

  test('rollup with mixed statuses', () => {
    const s = new InMemoryStrReportStore();
    s.create('BIL', validInput({ str_id: 'STR-1' }), 'alice', NOW);
    s.create('BIL', validInput({ str_id: 'STR-2', total_amount_kes: 500_000 }), 'alice', NOW);
    s.transition('BIL', 'STR-2', { to: 'ready_for_review' }, 'alice', NOW);
    s.create('BIL', validInput({ str_id: 'STR-3', total_amount_kes: 2_000_000, reasons: ['sanctions_hit'] }), 'alice', NOW);
    s.transition('BIL', 'STR-3', { to: 'ready_for_review' }, 'alice', NOW);
    s.transition('BIL', 'STR-3', { to: 'submitted', checker_username: 'bob' }, 'bob', NOW);
    const sum = buildStrSummary(s, 'BIL', NOW);
    expect(sum.total_strs).toBe(3);
    expect(sum.by_status.draft).toBe(1);
    expect(sum.by_status.ready_for_review).toBe(1);
    expect(sum.by_status.submitted).toBe(1);
    expect(sum.pending_review_count).toBe(1);
    expect(sum.unacked_submitted_count).toBe(1);
    expect(sum.total_amount_kes_submitted).toBe(2_000_000);
    expect(sum.by_reason.unusual_pattern).toBe(2);
    expect(sum.by_reason.sanctions_hit).toBe(1);
  });
});

// ─── 8. Routes ─────────────────────────────────────────────────────────

describe('GET /v1/aml/str-reports/taxonomy', () => {
  test('admin happy', async () => {
    const app = makeStrApp('admin');
    const r = await request(app).get('/v1/aml/str-reports/taxonomy').set(TH_BIL_ALICE);
    expect(r.status).toBe(200);
    expect(r.body.body.statuses).toEqual([...ALL_STR_STATUSES]);
    expect(r.body.body.reasons).toEqual([...ALL_STR_REASONS]);
  });
  test('non-admin → 403', async () => {
    const app = makeStrApp('field_officer');
    expect((await request(app).get('/v1/aml/str-reports/taxonomy').set(TH_BIL_ALICE)).status).toBe(403);
  });
});

describe('POST /v1/aml/str-reports', () => {
  test('happy 201 with maker = X-APEX-USER', async () => {
    const app = makeStrApp('admin');
    const r = await request(app).post('/v1/aml/str-reports').set(TH_BIL_ALICE).send(validInput());
    expect(r.status).toBe(201);
    expect(r.body.body.str_id).toBe('STR-BIL-2026-00001');
    expect(r.body.body.maker_username).toBe('alice.maker');
    expect(r.body.body.status).toBe('draft');
  });

  test('duplicate → 409', async () => {
    const store = new InMemoryStrReportStore();
    const app = makeStrApp('admin', { strReportStore: store });
    await request(app).post('/v1/aml/str-reports').set(TH_BIL_ALICE).send(validInput());
    const r = await request(app).post('/v1/aml/str-reports').set(TH_BIL_ALICE).send(validInput());
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_duplicate_str_id');
  });

  test('invalid reason → 400', async () => {
    const app = makeStrApp('admin');
    const r = await request(app)
      .post('/v1/aml/str-reports')
      .set(TH_BIL_ALICE)
      .send(validInput({ reasons: ['weird'] }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_reasons');
  });

  test('non-admin → 403', async () => {
    const app = makeStrApp('field_officer');
    expect((await request(app).post('/v1/aml/str-reports').set(TH_BIL_ALICE).send(validInput())).status).toBe(403);
  });
});

describe('POST /v1/aml/str-reports/:str_id/transition', () => {
  function setup() {
    const store = new InMemoryStrReportStore();
    const app = makeStrApp('admin', { strReportStore: store });
    return { store, app };
  }

  test('full lifecycle: draft → ready_for_review → submitted → acknowledged', async () => {
    const { app } = setup();
    await request(app).post('/v1/aml/str-reports').set(TH_BIL_ALICE).send(validInput());
    const r1 = await request(app)
      .post('/v1/aml/str-reports/STR-BIL-2026-00001/transition')
      .set(TH_BIL_ALICE)
      .send({ to: 'ready_for_review' });
    expect(r1.status).toBe(200);
    expect(r1.body.body.status).toBe('ready_for_review');
    const r2 = await request(app)
      .post('/v1/aml/str-reports/STR-BIL-2026-00001/transition')
      .set(TH_BIL_BOB)
      .send({ to: 'submitted', checker_username: 'bob.checker' });
    expect(r2.status).toBe(200);
    expect(r2.body.body.status).toBe('submitted');
    const r3 = await request(app)
      .post('/v1/aml/str-reports/STR-BIL-2026-00001/transition')
      .set(TH_BIL_BOB)
      .send({ to: 'acknowledged', ack_reference: 'FIU-2026-ACK-789' });
    expect(r3.status).toBe(200);
    expect(r3.body.body.ack_reference).toBe('FIU-2026-ACK-789');
  });

  test('self-approval → 409 EWS_409_self_approval_forbidden with CRITICAL severity', async () => {
    const { app } = setup();
    await request(app).post('/v1/aml/str-reports').set(TH_BIL_ALICE).send(validInput());
    await request(app)
      .post('/v1/aml/str-reports/STR-BIL-2026-00001/transition')
      .set(TH_BIL_ALICE)
      .send({ to: 'ready_for_review' });
    const r = await request(app)
      .post('/v1/aml/str-reports/STR-BIL-2026-00001/transition')
      .set(TH_BIL_ALICE)
      .send({ to: 'submitted', checker_username: 'alice.maker' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_self_approval_forbidden');
    expect(r.body.error.severity).toBe('CRITICAL');
  });

  test('illegal transition → 409 EWS_409_invalid_transition', async () => {
    const { app } = setup();
    await request(app).post('/v1/aml/str-reports').set(TH_BIL_ALICE).send(validInput());
    const r = await request(app)
      .post('/v1/aml/str-reports/STR-BIL-2026-00001/transition')
      .set(TH_BIL_ALICE)
      .send({ to: 'submitted', checker_username: 'bob' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_invalid_transition');
  });

  test('unknown → 404', async () => {
    const app = makeStrApp('admin');
    const r = await request(app)
      .post('/v1/aml/str-reports/GHOST/transition')
      .set(TH_BIL_ALICE)
      .send({ to: 'ready_for_review' });
    expect(r.status).toBe(404);
  });

  test('invalid status in body → 400', async () => {
    const app = makeStrApp('admin');
    const r = await request(app)
      .post('/v1/aml/str-reports/STR-BIL-2026-00001/transition')
      .set(TH_BIL_ALICE)
      .send({ to: 'approved' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_status');
  });
});

describe('GET list / single / summary / DELETE', () => {
  test('GET list happy', async () => {
    const store = new InMemoryStrReportStore();
    const app = makeStrApp('admin', { strReportStore: store });
    await request(app).post('/v1/aml/str-reports').set(TH_BIL_ALICE).send(validInput());
    const r = await request(app).get('/v1/aml/str-reports').set(TH_BIL_ALICE);
    expect(r.body.body.items.length).toBe(1);
  });

  test('GET list ?status=bogus → 400', async () => {
    const app = makeStrApp('admin');
    expect((await request(app).get('/v1/aml/str-reports?status=bogus').set(TH_BIL_ALICE)).status).toBe(400);
  });

  test('GET single happy + unknown 404 + cross-tenant 404', async () => {
    const store = new InMemoryStrReportStore();
    const app = makeStrApp('admin', { strReportStore: store });
    await request(app).post('/v1/aml/str-reports').set(TH_BIL_ALICE).send(validInput());
    expect((await request(app).get('/v1/aml/str-reports/STR-BIL-2026-00001').set(TH_BIL_ALICE)).status).toBe(200);
    expect((await request(app).get('/v1/aml/str-reports/GHOST').set(TH_BIL_ALICE)).status).toBe(404);
    expect((await request(app).get('/v1/aml/str-reports/STR-BIL-2026-00001').set(TH_BANK)).status).toBe(404);
  });

  test('GET summary populated', async () => {
    const store = new InMemoryStrReportStore();
    const app = makeStrApp('admin', { strReportStore: store });
    await request(app).post('/v1/aml/str-reports').set(TH_BIL_ALICE).send(validInput());
    const r = await request(app).get('/v1/aml/str-reports/summary').set(TH_BIL_ALICE);
    expect(r.body.body.total_strs).toBe(1);
    expect(r.body.body.by_status.draft).toBe(1);
  });

  test('PATCH submitted → 409 immutable', async () => {
    const store = new InMemoryStrReportStore();
    const app = makeStrApp('admin', { strReportStore: store });
    await request(app).post('/v1/aml/str-reports').set(TH_BIL_ALICE).send(validInput());
    await request(app)
      .post('/v1/aml/str-reports/STR-BIL-2026-00001/transition')
      .set(TH_BIL_ALICE)
      .send({ to: 'ready_for_review' });
    await request(app)
      .post('/v1/aml/str-reports/STR-BIL-2026-00001/transition')
      .set(TH_BIL_BOB)
      .send({ to: 'submitted', checker_username: 'bob.checker' });
    const r = await request(app)
      .patch('/v1/aml/str-reports/STR-BIL-2026-00001')
      .set(TH_BIL_BOB)
      .send({ total_amount_kes: 999_999_999 });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_immutable');
  });

  test('DELETE draft + archive', async () => {
    const store = new InMemoryStrReportStore();
    const recovery = new InMemoryRecoveryStore();
    const app = makeStrApp('admin', { strReportStore: store, recoveryStore: recovery });
    await request(app).post('/v1/aml/str-reports').set(TH_BIL_ALICE).send(validInput());
    const r = await request(app).delete('/v1/aml/str-reports/STR-BIL-2026-00001').set(TH_BIL_ALICE);
    expect(r.status).toBe(204);
    const archived = await recovery.list({ tenant_id: 'BIL', entity_type: 'str_report' });
    expect(archived.items.length).toBe(1);
    expect(archived.items[0].original_table).toBe('app_aml.str_reports');
  });

  test('DELETE submitted → 409 immutable', async () => {
    const store = new InMemoryStrReportStore();
    const app = makeStrApp('admin', { strReportStore: store });
    await request(app).post('/v1/aml/str-reports').set(TH_BIL_ALICE).send(validInput());
    await request(app)
      .post('/v1/aml/str-reports/STR-BIL-2026-00001/transition')
      .set(TH_BIL_ALICE)
      .send({ to: 'ready_for_review' });
    await request(app)
      .post('/v1/aml/str-reports/STR-BIL-2026-00001/transition')
      .set(TH_BIL_BOB)
      .send({ to: 'submitted', checker_username: 'bob.checker' });
    const r = await request(app).delete('/v1/aml/str-reports/STR-BIL-2026-00001').set(TH_BIL_BOB);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_immutable');
  });
});

describe('singleton + cap', () => {
  test('cap exported sensibly', () => {
    expect(STR_REPORT_CAP_PER_TENANT).toBeGreaterThan(0);
  });
  test('default store interface', () => {
    expect(typeof defaultStrReportStore.create).toBe('function');
    expect(typeof defaultStrReportStore.restore).toBe('function');
    expect(typeof defaultStrReportStore.transition).toBe('function');
  });
});
