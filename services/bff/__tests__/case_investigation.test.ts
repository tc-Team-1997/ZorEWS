// services/bff/__tests__/case_investigation.test.ts
//
// T6 M9.1 — BIL Case Investigation tracker.

import request from 'supertest';
import {
  InMemoryCaseInvestigationStore,
  InvestigationError,
  canTransition,
  defaultSteps,
  isInvestigationDecision,
  isInvestigationStatus,
} from '../src/case_investigation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-04T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

function makeInvApp(role: string = 'admin', store?: InMemoryCaseInvestigationStore) {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
    caseInvestigationStore: store ?? new InMemoryCaseInvestigationStore(),
  });
}

// ─── Schema + helpers ──────────────────────────────────────────────────

describe('Investigation schema', () => {
  test('defaultSteps returns 8 BIL standard steps', () => {
    const s = defaultSteps();
    expect(s.length).toBe(8);
    const ids = s.map((x) => x.step_id);
    expect(ids).toEqual([
      'verify_identity',
      'pull_policy_history',
      'aml_screen',
      'review_documents',
      'check_red_flags',
      'interview_claimant',
      'site_inspection',
      'final_recommendation',
    ]);
    for (const step of s) {
      expect(step.completed).toBe(false);
      expect(step.completed_at).toBeNull();
      expect(step.completed_by).toBeNull();
      expect(step.evidence_link).toBeNull();
    }
  });

  test('defaultSteps returns fresh arrays (mutating one does not affect another)', () => {
    const a = defaultSteps();
    const b = defaultSteps();
    a[0]!.completed = true;
    expect(b[0]!.completed).toBe(false);
  });

  test('isInvestigationStatus / isInvestigationDecision', () => {
    expect(isInvestigationStatus('triage')).toBe(true);
    expect(isInvestigationStatus('closed')).toBe(true);
    expect(isInvestigationStatus('TRIAGE')).toBe(false);
    expect(isInvestigationStatus('done')).toBe(false);
    expect(isInvestigationDecision('fraud_confirmed')).toBe(true);
    expect(isInvestigationDecision('null')).toBe(false);
  });
});

describe('canTransition state machine', () => {
  test('triage → gathering_evidence allowed; → review forbidden', () => {
    expect(canTransition('triage', 'gathering_evidence')).toBe(true);
    expect(canTransition('triage', 'review')).toBe(false);
  });
  test('review → decision allowed; → triage forbidden (no rewind)', () => {
    expect(canTransition('review', 'decision')).toBe(true);
    expect(canTransition('review', 'triage')).toBe(false);
  });
  test('decision → closed allowed; → review allowed (re-deliberate)', () => {
    expect(canTransition('decision', 'closed')).toBe(true);
    expect(canTransition('decision', 'review')).toBe(true);
  });
  test('closed → gathering_evidence allowed (re-open)', () => {
    expect(canTransition('closed', 'gathering_evidence')).toBe(true);
  });
  test('closed → triage forbidden (re-open must go through evidence)', () => {
    expect(canTransition('closed', 'triage')).toBe(false);
  });
  test('awaiting_response → gathering_evidence allowed (loop back)', () => {
    expect(canTransition('awaiting_response', 'gathering_evidence')).toBe(true);
  });
});

// ─── Store — open + get + list ─────────────────────────────────────────

describe('InMemoryCaseInvestigationStore — open', () => {
  test('creates a triage-state investigation with the 8 default steps', () => {
    const s = new InMemoryCaseInvestigationStore();
    const inv = s.open('BIL', { case_id: 'CASE-1', customer_id: 'c-1' }, 'taniya', NOW);
    expect(inv.investigation_id).toMatch(/^inv-/);
    expect(inv.tenant_id).toBe('BIL');
    expect(inv.status).toBe('triage');
    expect(inv.decision).toBeNull();
    expect(inv.opened_by).toBe('taniya');
    expect(inv.last_updated_by).toBe('taniya');
    expect(inv.closed_at).toBeNull();
    expect(inv.steps.length).toBe(8);
    expect(inv.notes_count).toBe(0);
  });

  test('rejects 2nd open on the same case (must close first)', () => {
    const s = new InMemoryCaseInvestigationStore();
    s.open('BIL', { case_id: 'CASE-1', customer_id: 'c-1' }, 'a', NOW);
    try {
      s.open('BIL', { case_id: 'CASE-1', customer_id: 'c-1' }, 'b', NOW);
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(InvestigationError);
      expect((e as InvestigationError).code).toBe('investigation_already_open');
    }
  });

  test('allows reopening after a previous one is closed', () => {
    const s = new InMemoryCaseInvestigationStore();
    const a = s.open('BIL', { case_id: 'CASE-1', customer_id: 'c-1' }, 'x', NOW);
    s.updateStatus('BIL', a.investigation_id, 'closed', null, 'x', NOW);
    const b = s.open('BIL', { case_id: 'CASE-1', customer_id: 'c-1' }, 'y', NOW);
    expect(b.investigation_id).not.toBe(a.investigation_id);
  });

  test('rejects missing case_id / customer_id', () => {
    const s = new InMemoryCaseInvestigationStore();
    expect(() => s.open('BIL', { case_id: '', customer_id: 'c' }, 'x', NOW)).toThrow(
      /case_id is required/,
    );
    expect(() => s.open('BIL', { case_id: 'C', customer_id: '' }, 'x', NOW)).toThrow(
      /customer_id is required/,
    );
  });

  test('tenant isolation — BIL open invisible to BANK_DEMO list', () => {
    const s = new InMemoryCaseInvestigationStore();
    s.open('BIL', { case_id: 'CASE-1', customer_id: 'c-1' }, 'x', NOW);
    expect(s.list('BIL', {}).total).toBe(1);
    expect(s.list('BANK_DEMO', {}).total).toBe(0);
  });
});

describe('InMemoryCaseInvestigationStore — list', () => {
  function seed(s: InMemoryCaseInvestigationStore): void {
    s.open('BIL', { case_id: 'CASE-1', customer_id: 'c-1' }, 'a', new Date('2026-05-01T10:00:00Z'));
    s.open('BIL', { case_id: 'CASE-2', customer_id: 'c-2' }, 'b', new Date('2026-05-02T10:00:00Z'));
    s.open('BIL', { case_id: 'CASE-3', customer_id: 'c-1' }, 'c', new Date('2026-05-03T10:00:00Z'));
  }

  test('newest-first by opened_at', () => {
    const s = new InMemoryCaseInvestigationStore();
    seed(s);
    const out = s.list('BIL', {});
    expect(out.total).toBe(3);
    for (let i = 1; i < out.items.length; i++) {
      expect(out.items[i - 1]!.opened_at >= out.items[i]!.opened_at).toBe(true);
    }
  });

  test('filter by customer_id narrows to that customer', () => {
    const s = new InMemoryCaseInvestigationStore();
    seed(s);
    expect(s.list('BIL', { customer_id: 'c-1' }).total).toBe(2);
    expect(s.list('BIL', { customer_id: 'c-2' }).total).toBe(1);
  });

  test('filter by case_id narrows to that case', () => {
    const s = new InMemoryCaseInvestigationStore();
    seed(s);
    expect(s.list('BIL', { case_id: 'CASE-2' }).total).toBe(1);
  });

  test('pagination disjoint, page_size clamped', () => {
    const s = new InMemoryCaseInvestigationStore();
    seed(s);
    const p1 = s.list('BIL', { page: 1, page_size: 2 });
    const p2 = s.list('BIL', { page: 2, page_size: 2 });
    expect(p1.items.length).toBe(2);
    expect(p2.items.length).toBe(1);
    const ids1 = new Set(p1.items.map((x) => x.investigation_id));
    for (const inv of p2.items) expect(ids1.has(inv.investigation_id)).toBe(false);
    expect(s.list('BIL', { page_size: 99999 }).page_size).toBe(200);
  });
});

// ─── Store — updateStatus ──────────────────────────────────────────────

describe('InMemoryCaseInvestigationStore — updateStatus', () => {
  test('legal walk: triage → gathering_evidence → review → decision → closed', () => {
    const s = new InMemoryCaseInvestigationStore();
    const inv = s.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    let cur = s.updateStatus('BIL', inv.investigation_id, 'gathering_evidence', null, 'x', NOW);
    expect(cur.status).toBe('gathering_evidence');
    cur = s.updateStatus('BIL', inv.investigation_id, 'review', null, 'x', NOW);
    expect(cur.status).toBe('review');
    cur = s.updateStatus('BIL', inv.investigation_id, 'decision', 'fraud_confirmed', 'x', NOW);
    expect(cur.status).toBe('decision');
    expect(cur.decision).toBe('fraud_confirmed');
    cur = s.updateStatus('BIL', inv.investigation_id, 'closed', 'fraud_confirmed', 'x', NOW);
    expect(cur.status).toBe('closed');
    expect(cur.closed_at).toBe(NOW.toISOString());
    expect(cur.decision).toBe('fraud_confirmed');
  });

  test('illegal transition triage→review throws invalid_transition', () => {
    const s = new InMemoryCaseInvestigationStore();
    const inv = s.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    try {
      s.updateStatus('BIL', inv.investigation_id, 'review', null, 'x', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as InvestigationError).code).toBe('invalid_transition');
    }
  });

  test('closing from decision without a decision throws decision_required', () => {
    const s = new InMemoryCaseInvestigationStore();
    const inv = s.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    s.updateStatus('BIL', inv.investigation_id, 'gathering_evidence', null, 'x', NOW);
    s.updateStatus('BIL', inv.investigation_id, 'review', null, 'x', NOW);
    s.updateStatus('BIL', inv.investigation_id, 'decision', null, 'x', NOW);
    try {
      s.updateStatus('BIL', inv.investigation_id, 'closed', null, 'x', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as InvestigationError).code).toBe('decision_required');
    }
  });

  test('closing from triage with null decision allowed (case dismissed pre-review)', () => {
    const s = new InMemoryCaseInvestigationStore();
    const inv = s.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    const closed = s.updateStatus('BIL', inv.investigation_id, 'closed', null, 'x', NOW);
    expect(closed.status).toBe('closed');
    expect(closed.decision).toBeNull();
  });

  test('re-opening clears closed_at', () => {
    const s = new InMemoryCaseInvestigationStore();
    const inv = s.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    s.updateStatus('BIL', inv.investigation_id, 'closed', null, 'x', NOW);
    const reopened = s.updateStatus(
      'BIL',
      inv.investigation_id,
      'gathering_evidence',
      null,
      'x',
      NOW,
    );
    expect(reopened.status).toBe('gathering_evidence');
    expect(reopened.closed_at).toBeNull();
  });

  test('invalid status throws invalid_status', () => {
    const s = new InMemoryCaseInvestigationStore();
    const inv = s.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    try {
      s.updateStatus('BIL', inv.investigation_id, 'foo' as never, null, 'x', NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as InvestigationError).code).toBe('invalid_status');
    }
  });

  test('unknown id throws unknown_investigation', () => {
    const s = new InMemoryCaseInvestigationStore();
    expect(() => s.updateStatus('BIL', 'inv-nope', 'closed', null, 'x', NOW)).toThrow(
      /unknown investigation/,
    );
  });
});

// ─── Store — completeStep ──────────────────────────────────────────────

describe('InMemoryCaseInvestigationStore — completeStep', () => {
  test('completes a step with metadata', () => {
    const s = new InMemoryCaseInvestigationStore();
    const inv = s.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    const updated = s.completeStep(
      'BIL',
      inv.investigation_id,
      'verify_identity',
      'taniya',
      'docs:KYC-42',
      NOW,
    );
    const step = updated.steps.find((x) => x.step_id === 'verify_identity')!;
    expect(step.completed).toBe(true);
    expect(step.completed_at).toBe(NOW.toISOString());
    expect(step.completed_by).toBe('taniya');
    expect(step.evidence_link).toBe('docs:KYC-42');
  });

  test('other steps remain incomplete', () => {
    const s = new InMemoryCaseInvestigationStore();
    const inv = s.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    const updated = s.completeStep('BIL', inv.investigation_id, 'verify_identity', 't', null, NOW);
    expect(updated.steps.filter((x) => x.completed).length).toBe(1);
  });

  test('completing same step twice throws step_already_completed', () => {
    const s = new InMemoryCaseInvestigationStore();
    const inv = s.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    s.completeStep('BIL', inv.investigation_id, 'verify_identity', 't', null, NOW);
    try {
      s.completeStep('BIL', inv.investigation_id, 'verify_identity', 't', null, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as InvestigationError).code).toBe('step_already_completed');
    }
  });

  test('unknown step_id throws unknown_step', () => {
    const s = new InMemoryCaseInvestigationStore();
    const inv = s.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    try {
      s.completeStep('BIL', inv.investigation_id, 'no.such', 't', null, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as InvestigationError).code).toBe('unknown_step');
    }
  });

  test('completing on a closed investigation throws closed', () => {
    const s = new InMemoryCaseInvestigationStore();
    const inv = s.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    s.updateStatus('BIL', inv.investigation_id, 'closed', null, 'x', NOW);
    try {
      s.completeStep('BIL', inv.investigation_id, 'verify_identity', 't', null, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as InvestigationError).code).toBe('closed');
    }
  });
});

// ─── Store — notes ─────────────────────────────────────────────────────

describe('InMemoryCaseInvestigationStore — notes', () => {
  test('addNote appends + bumps notes_count', () => {
    const s = new InMemoryCaseInvestigationStore();
    const inv = s.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    const r = s.addNote('BIL', inv.investigation_id, 'taniya', 'first note', NOW);
    expect(r.note.note_id).toMatch(/^note-/);
    expect(r.note.body).toBe('first note');
    expect(r.note.author).toBe('taniya');
    expect(r.investigation.notes_count).toBe(1);
  });

  test('listNotes returns newest-first', () => {
    const s = new InMemoryCaseInvestigationStore();
    const inv = s.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    s.addNote('BIL', inv.investigation_id, 'a', 'first', new Date(NOW.getTime() + 1000));
    s.addNote('BIL', inv.investigation_id, 'b', 'second', new Date(NOW.getTime() + 2000));
    s.addNote('BIL', inv.investigation_id, 'c', 'third', new Date(NOW.getTime() + 3000));
    const notes = s.listNotes('BIL', inv.investigation_id);
    expect(notes.map((n) => n.body)).toEqual(['third', 'second', 'first']);
  });

  test('empty body rejected', () => {
    const s = new InMemoryCaseInvestigationStore();
    const inv = s.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    expect(() => s.addNote('BIL', inv.investigation_id, 'x', '   ', NOW)).toThrow(
      /body is required/,
    );
  });

  test('body > 4000 chars rejected', () => {
    const s = new InMemoryCaseInvestigationStore();
    const inv = s.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    expect(() => s.addNote('BIL', inv.investigation_id, 'x', 'a'.repeat(4001), NOW)).toThrow(
      /≤ 4000/,
    );
  });

  test('listNotes on unknown id throws unknown_investigation', () => {
    const s = new InMemoryCaseInvestigationStore();
    expect(() => s.listNotes('BIL', 'inv-nope')).toThrow(/unknown investigation/);
  });
});

// ─── Routes ────────────────────────────────────────────────────────────

describe('POST /v1/investigations', () => {
  test('admin: 201 with triage-state investigation', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const { app } = makeInvApp('admin', store);
    const r = await request(app)
      .post('/v1/investigations')
      .set(TH_BIL)
      .set('x-apex-user', 'taniya')
      .send({ case_id: 'CASE-1', customer_id: 'c-1' });
    expect(r.status).toBe(201);
    expect(r.body.body.status).toBe('triage');
    expect(r.body.body.opened_by).toBe('taniya');
    expect(r.body.body.steps.length).toBe(8);
  });

  test('accepts an enveloped request body', async () => {
    const { app } = makeInvApp('admin');
    const r = await request(app)
      .post('/v1/investigations')
      .set(TH_BIL)
      .send({ header: { requestId: 'r-1' }, body: { case_id: 'CASE-1', customer_id: 'c-1' } });
    expect(r.status).toBe(201);
  });

  test('409 EWS_409_investigation_already_open', async () => {
    const { app } = makeInvApp('admin');
    await request(app)
      .post('/v1/investigations')
      .set(TH_BIL)
      .send({ case_id: 'CASE-1', customer_id: 'c-1' });
    const r = await request(app)
      .post('/v1/investigations')
      .set(TH_BIL)
      .send({ case_id: 'CASE-1', customer_id: 'c-1' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_investigation_already_open');
  });

  test('400 EWS_400_invalid_input on missing fields', async () => {
    const { app } = makeInvApp('admin');
    const r = await request(app).post('/v1/investigations').set(TH_BIL).send({});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('unknown role → 403 (fail-closed)', async () => {
    const { app } = makeInvApp('case_owner'); // not in the matrix
    const r = await request(app)
      .post('/v1/investigations')
      .set(TH_BIL)
      .send({ case_id: 'CASE-1', customer_id: 'c-1' });
    expect(r.status).toBe(403);
  });
});

describe('GET /v1/investigations + /:id', () => {
  test('list newest-first; single 404 on miss', async () => {
    const { app } = makeInvApp('admin');
    await request(app)
      .post('/v1/investigations')
      .set(TH_BIL)
      .send({ case_id: 'CASE-1', customer_id: 'c-1' });
    await request(app)
      .post('/v1/investigations')
      .set(TH_BIL)
      .send({ case_id: 'CASE-2', customer_id: 'c-2' });
    const list = await request(app).get('/v1/investigations').set(TH_BIL);
    expect(list.status).toBe(200);
    expect(list.body.body.total).toBe(2);
    const single404 = await request(app).get('/v1/investigations/inv-nope').set(TH_BIL);
    expect(single404.status).toBe(404);
    expect(single404.body.error.code).toBe('EWS_404_unknown_investigation');
  });

  test('?status=closed filter', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const opened = store.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    store.updateStatus('BIL', opened.investigation_id, 'closed', null, 'x', NOW);
    const { app } = makeInvApp('admin', store);
    const r = await request(app).get('/v1/investigations?status=closed').set(TH_BIL);
    expect(r.body.body.total).toBe(1);
  });

  test('?status=invalid → 400', async () => {
    const { app } = makeInvApp('admin');
    const r = await request(app).get('/v1/investigations?status=DONE').set(TH_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_status');
  });

  test('cross-tenant lookup → 404 (tenant scoping)', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    const { app } = makeInvApp('admin', store);
    const r = await request(app).get(`/v1/investigations/${inv.investigation_id}`).set(TH_BANK);
    expect(r.status).toBe(404);
  });
});

describe('PATCH /v1/investigations/:id/status', () => {
  test('legal transition triage → gathering_evidence', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    const { app } = makeInvApp('admin', store);
    const r = await request(app)
      .patch(`/v1/investigations/${inv.investigation_id}/status`)
      .set(TH_BIL)
      .send({ status: 'gathering_evidence' });
    expect(r.status).toBe(200);
    expect(r.body.body.status).toBe('gathering_evidence');
  });

  test('illegal transition triage→review → 400 EWS_400_invalid_transition', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    const { app } = makeInvApp('admin', store);
    const r = await request(app)
      .patch(`/v1/investigations/${inv.investigation_id}/status`)
      .set(TH_BIL)
      .send({ status: 'review' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_transition');
  });

  test('invalid status enum → 400 EWS_400_invalid_status', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    const { app } = makeInvApp('admin', store);
    const r = await request(app)
      .patch(`/v1/investigations/${inv.investigation_id}/status`)
      .set(TH_BIL)
      .send({ status: 'BOGUS' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_status');
  });

  test('decision_required when closing from decision with null', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    store.updateStatus('BIL', inv.investigation_id, 'gathering_evidence', null, 'x', NOW);
    store.updateStatus('BIL', inv.investigation_id, 'review', null, 'x', NOW);
    store.updateStatus('BIL', inv.investigation_id, 'decision', null, 'x', NOW);
    const { app } = makeInvApp('admin', store);
    const r = await request(app)
      .patch(`/v1/investigations/${inv.investigation_id}/status`)
      .set(TH_BIL)
      .send({ status: 'closed' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_decision_required');
  });

  test('unknown id → 404 EWS_404_unknown_investigation', async () => {
    const { app } = makeInvApp('admin');
    const r = await request(app)
      .patch('/v1/investigations/inv-nope/status')
      .set(TH_BIL)
      .send({ status: 'closed' });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_investigation');
  });
});

describe('POST /v1/investigations/:id/steps/:step_id/complete', () => {
  test('completes a step', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    const { app } = makeInvApp('admin', store);
    const r = await request(app)
      .post(`/v1/investigations/${inv.investigation_id}/steps/verify_identity/complete`)
      .set(TH_BIL)
      .set('x-apex-user', 'taniya')
      .send({ evidence_link: 'docs:KYC-42' });
    expect(r.status).toBe(200);
    const step = (r.body.body.steps as Array<{ step_id: string; completed: boolean; evidence_link: string | null; completed_by: string | null }>).find(
      (x) => x.step_id === 'verify_identity',
    )!;
    expect(step.completed).toBe(true);
    expect(step.evidence_link).toBe('docs:KYC-42');
    expect(step.completed_by).toBe('taniya');
  });

  test('unknown step_id → 404 EWS_404_unknown_step', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    const { app } = makeInvApp('admin', store);
    const r = await request(app)
      .post(`/v1/investigations/${inv.investigation_id}/steps/no_such/complete`)
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_step');
  });

  test('completing same step twice → 409 EWS_409_step_already_completed', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    const { app } = makeInvApp('admin', store);
    await request(app)
      .post(`/v1/investigations/${inv.investigation_id}/steps/verify_identity/complete`)
      .set(TH_BIL)
      .send({});
    const r = await request(app)
      .post(`/v1/investigations/${inv.investigation_id}/steps/verify_identity/complete`)
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_step_already_completed');
  });

  test('completing on closed investigation → 409 EWS_409_closed', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    store.updateStatus('BIL', inv.investigation_id, 'closed', null, 'x', NOW);
    const { app } = makeInvApp('admin', store);
    const r = await request(app)
      .post(`/v1/investigations/${inv.investigation_id}/steps/verify_identity/complete`)
      .set(TH_BIL)
      .send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EWS_409_closed');
  });
});

describe('POST + GET /v1/investigations/:id/notes', () => {
  test('add + list round-trip; notes_count bumps', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    const { app } = makeInvApp('admin', store);
    const post = await request(app)
      .post(`/v1/investigations/${inv.investigation_id}/notes`)
      .set(TH_BIL)
      .set('x-apex-user', 'taniya')
      .send({ body: 'noted' });
    expect(post.status).toBe(201);
    expect(post.body.body.note.body).toBe('noted');
    expect(post.body.body.investigation.notes_count).toBe(1);
    const list = await request(app)
      .get(`/v1/investigations/${inv.investigation_id}/notes`)
      .set(TH_BIL);
    expect(list.body.body.total).toBe(1);
    expect(list.body.body.items[0].author).toBe('taniya');
  });

  test('empty body → 400 EWS_400_invalid_input', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    const { app } = makeInvApp('admin', store);
    const r = await request(app)
      .post(`/v1/investigations/${inv.investigation_id}/notes`)
      .set(TH_BIL)
      .send({ body: '   ' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('body > 4000 → 400 EWS_400_note_too_long', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const inv = store.open('BIL', { case_id: 'C', customer_id: 'c-1' }, 'x', NOW);
    const { app } = makeInvApp('admin', store);
    const r = await request(app)
      .post(`/v1/investigations/${inv.investigation_id}/notes`)
      .set(TH_BIL)
      .send({ body: 'a'.repeat(4001) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_note_too_long');
  });

  test('unknown id on listNotes → 404', async () => {
    const { app } = makeInvApp('admin');
    const r = await request(app).get('/v1/investigations/inv-nope/notes').set(TH_BIL);
    expect(r.status).toBe(404);
  });
});

describe('Tenant isolation through routes', () => {
  test('BIL investigation does not leak to BANK_DEMO', async () => {
    const store = new InMemoryCaseInvestigationStore();
    const { app } = makeInvApp('admin', store);
    await request(app)
      .post('/v1/investigations')
      .set(TH_BIL)
      .send({ case_id: 'CASE-1', customer_id: 'c-1' });
    const bil = await request(app).get('/v1/investigations').set(TH_BIL);
    const bank = await request(app).get('/v1/investigations').set(TH_BANK);
    expect(bil.body.body.total).toBe(1);
    expect(bank.body.body.total).toBe(0);
  });
});
