// Unit + integration tests for the CAS + CAP additions (T4.19,
// BAC-A manual §3.1.5).
//
// Unit tests run unconditionally against the in-memory CaseStore.
// Pg integration tests are gated on CASES_PG_URL.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import request from 'supertest';
import { Pool } from 'pg';
import { CaseService } from '../src/service';
import { OutboxCaseProducer } from '../src/producer';
import { CaseStore } from '../src/store';
import { PgCaseStore } from '../src/pg_store';
import { makeApp } from '../src/server';
import type { AlertSummary } from '../src/types';

const PG_URL = process.env.CASES_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-cas-cap-'));
}

function alert(overrides: Partial<AlertSummary> = {}): AlertSummary {
  return {
    alert_id: 'alert-cas-001',
    customer_id: 'cust-cas-1',
    loan_id: 'loan-cas-1',
    severity: 'high',
    rule_id: 'CRD-006-v1',
    raised_at: '2026-05-03T10:00:00.000Z',
    reason_summary: 'Bureau drop with rising DPD',
    ...overrides,
  };
}

function makeService(rootDir: string) {
  const store = new CaseStore(path.join(rootDir, 'cases.ndjson'));
  const producer = new OutboxCaseProducer(path.join(rootDir, '.outbox'));
  let t = Date.parse('2026-05-03T10:00:00.000Z');
  const now = () => new Date((t += 1000));
  const service = new CaseService({ store, producer, now });
  return { service, store, producer };
}

describe('CaseService — CAS submit + review (in-memory)', () => {
  test('submitCas appends a pending CAS record + emits case.cas_submitted', async () => {
    const { service } = makeService(tmp());
    const { case: c } = await service.createFromAlert(alert());
    const cas = await service.submitCas(c.case_id, {
      cause_type: 'borrower_specific',
      cause_summary: 'Lost main supplier contract',
      severity_assessment: 'material',
      decision: 'proceed_to_cap',
      submitted_by: 'rm.alice',
    });
    expect(cas.cas_id).toMatch(/^cas_/);
    expect(cas.review_status).toBe('pending');
    expect(cas.attachments).toEqual([]);

    const reloaded = service.get(c.case_id)!;
    expect(reloaded.cas_records).toHaveLength(1);
    expect(reloaded.cas_records[0].decision).toBe('proceed_to_cap');
  });

  test('reviewCas approves the CAS', async () => {
    const { service } = makeService(tmp());
    const { case: c } = await service.createFromAlert(alert({ alert_id: 'a-cas-2' }));
    const cas = await service.submitCas(c.case_id, {
      cause_type: 'data_quality',
      cause_summary: 'Missing collateral revaluation',
      severity_assessment: 'minor',
      decision: 'close_case',
      submitted_by: 'rm.bob',
    });
    const reviewed = await service.reviewCas(c.case_id, cas.cas_id, {
      reviewed_by: 'sup.carol',
      review_status: 'approved',
      review_comments: 'Confirmed data fix already shipped',
    });
    expect(reviewed.review_status).toBe('approved');
    expect(reviewed.reviewed_by).toBe('sup.carol');
    expect(reviewed.review_comments).toMatch(/data fix/);
  });

  test('reviewCas rejects double-review with 409', async () => {
    const { service } = makeService(tmp());
    const { case: c } = await service.createFromAlert(alert({ alert_id: 'a-cas-3' }));
    const cas = await service.submitCas(c.case_id, {
      cause_type: 'fraud_suspected',
      cause_summary: 'Unusual third-party transfers',
      severity_assessment: 'severe',
      decision: 'proceed_to_cap',
      submitted_by: 'rm.dan',
    });
    await service.reviewCas(c.case_id, cas.cas_id, {
      reviewed_by: 'sup.eve',
      review_status: 'rework',
      review_comments: 'Need bank statements',
    });
    await expect(
      service.reviewCas(c.case_id, cas.cas_id, {
        reviewed_by: 'sup.eve',
        review_status: 'approved',
      }),
    ).rejects.toThrow(/already reviewed/);
  });

  test('reviewCas 404s an unknown cas_id', async () => {
    const { service } = makeService(tmp());
    const { case: c } = await service.createFromAlert(alert({ alert_id: 'a-cas-4' }));
    await expect(
      service.reviewCas(c.case_id, 'cas_nonexistent', {
        reviewed_by: 'sup.x',
        review_status: 'approved',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('CaseService — CAP propose + approve + close (in-memory)', () => {
  test('proposeCap appends an open CAP', async () => {
    const { service } = makeService(tmp());
    const { case: c } = await service.createFromAlert(alert({ alert_id: 'a-cap-1' }));
    const cap = await service.proposeCap(c.case_id, {
      cap_item: 'Initiate legal action',
      issue_owner_group: 'legal',
      issue_owner: 'legal.frank',
      issue_priority: 'high_risk',
      target_completion_date: '2026-06-15',
      proposed_by: 'rm.alice',
    });
    expect(cap.status).toBe('open');
    expect(cap.cap_id).toMatch(/^cap_/);
    expect(cap.target_completion_date).toBe('2026-06-15');
    expect(service.get(c.case_id)!.caps).toHaveLength(1);
  });

  test('approveCap with approve=true moves CAP to in_progress', async () => {
    const { service } = makeService(tmp());
    const { case: c } = await service.createFromAlert(alert({ alert_id: 'a-cap-2' }));
    const cap = await service.proposeCap(c.case_id, {
      cap_item: 'Freeze ad-hoc limits',
      issue_owner_group: 'credit',
      issue_owner: 'credit.gina',
      issue_priority: 'medium_risk',
      target_completion_date: '2026-05-30',
      proposed_by: 'rm.bob',
    });
    const approved = await service.approveCap(c.case_id, cap.cap_id, {
      approved_by: 'sup.carol',
      approve: true,
    });
    expect(approved.status).toBe('in_progress');
    expect(approved.approved_by).toBe('sup.carol');
    expect(approved.approved_at).not.toBeNull();
  });

  test('approveCap with approve=false leaves CAP open + records reason', async () => {
    const { service } = makeService(tmp());
    const { case: c } = await service.createFromAlert(alert({ alert_id: 'a-cap-3' }));
    const cap = await service.proposeCap(c.case_id, {
      cap_item: 'Restructure loan',
      issue_owner_group: 'credit',
      issue_owner: 'credit.harry',
      issue_priority: 'low_risk',
      target_completion_date: '2026-07-01',
      proposed_by: 'rm.alice',
    });
    const rejected = await service.approveCap(c.case_id, cap.cap_id, {
      approved_by: 'sup.eve',
      approve: false,
      comments: 'Need senior underwriting sign-off first',
    });
    expect(rejected.status).toBe('open');
    expect(rejected.approved_by).toBeNull();
    expect(rejected.closure_comments).toMatch(/sign-off/);
  });

  test('closeCap from in_progress marks closed', async () => {
    const { service } = makeService(tmp());
    const { case: c } = await service.createFromAlert(alert({ alert_id: 'a-cap-4' }));
    const cap = await service.proposeCap(c.case_id, {
      cap_item: 'Increase monitoring frequency',
      issue_owner_group: 'issue_owner',
      issue_owner: 'rm.alice',
      issue_priority: 'low_risk',
      target_completion_date: '2026-05-30',
      proposed_by: 'rm.alice',
    });
    await service.approveCap(c.case_id, cap.cap_id, {
      approved_by: 'sup.carol',
      approve: true,
    });
    const closed = await service.closeCap(c.case_id, cap.cap_id, {
      closed_by: 'rm.alice',
      closure_comments: 'Weekly RM check-in scheduled',
    });
    expect(closed.status).toBe('closed');
    expect(closed.closed_at).not.toBeNull();
  });

  test('closeCap on an open (un-approved) CAP returns 409', async () => {
    const { service } = makeService(tmp());
    const { case: c } = await service.createFromAlert(alert({ alert_id: 'a-cap-5' }));
    const cap = await service.proposeCap(c.case_id, {
      cap_item: 'x',
      issue_owner_group: 'g',
      issue_owner: 'u',
      issue_priority: 'low_risk',
      target_completion_date: '2026-06-01',
      proposed_by: 'p',
    });
    await expect(
      service.closeCap(c.case_id, cap.cap_id, { closed_by: 'u' }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('CaseService — close case is gated on open CAPs', () => {
  test('close() throws 409 when at least one CAP is open or in_progress', async () => {
    const { service } = makeService(tmp());
    const { case: c } = await service.createFromAlert(alert({ alert_id: 'a-gate-1' }));
    await service.assign(c.case_id, 'rm.alice');
    const cap = await service.proposeCap(c.case_id, {
      cap_item: 'Initiate legal action',
      issue_owner_group: 'legal',
      issue_owner: 'legal.frank',
      issue_priority: 'high_risk',
      target_completion_date: '2026-06-15',
      proposed_by: 'rm.alice',
    });
    await service.approveCap(c.case_id, cap.cap_id, {
      approved_by: 'sup.carol',
      approve: true,
    });
    // CAP in in_progress — close should refuse
    await expect(
      service.close(c.case_id, { outcome: 'cured', note: 'fine' }),
    ).rejects.toMatchObject({ status: 409 });

    // Close the CAP, then case can close
    await service.closeCap(c.case_id, cap.cap_id, { closed_by: 'legal.frank' });
    const closed = await service.close(c.case_id, { outcome: 'cured', note: 'fine' });
    expect(closed.state).toBe('closed');
  });

  test('close() allowed when all CAPs are closed (or there are none)', async () => {
    const { service } = makeService(tmp());
    const { case: c } = await service.createFromAlert(alert({ alert_id: 'a-gate-2' }));
    await service.assign(c.case_id, 'rm.alice');
    // No CAPs at all — close is allowed.
    const closed = await service.close(c.case_id, { outcome: 'defaulted', note: '' });
    expect(closed.state).toBe('closed');
  });
});

describe('CAS + CAP HTTP routes (in-memory store)', () => {
  function makeAppForTest() {
    const dir = tmp();
    const { app } = makeApp({
      store: new CaseStore(path.join(dir, 'cases.ndjson')),
      producer: new OutboxCaseProducer(path.join(dir, '.outbox')),
      getRole: () => 'admin',
    });
    return app;
  }

  test('POST /cases/:id/cas → 201 with the created record', async () => {
    const app = makeAppForTest();
    const create = await request(app)
      .post('/cases')
      .set('x-apex-role', 'admin')
      .send(alert({ alert_id: 'a-route-1' }));
    const caseId = create.body.case.case_id;

    const r = await request(app)
      .post(`/cases/${caseId}/cas`)
      .set('x-apex-role', 'admin')
      .send({
        cause_type: 'borrower_specific',
        cause_summary: 'Lost main contract',
        severity_assessment: 'material',
        decision: 'proceed_to_cap',
        submitted_by: 'rm.alice',
      });
    expect(r.status).toBe(201);
    expect(r.body.cas_id).toMatch(/^cas_/);
    expect(r.body.review_status).toBe('pending');
  });

  test('POST /cases/:id/cas → 400 on invalid cause_type', async () => {
    const app = makeAppForTest();
    const create = await request(app)
      .post('/cases')
      .set('x-apex-role', 'admin')
      .send(alert({ alert_id: 'a-route-2' }));
    const caseId = create.body.case.case_id;
    const r = await request(app)
      .post(`/cases/${caseId}/cas`)
      .set('x-apex-role', 'admin')
      .send({
        cause_type: 'made_up_value',
        cause_summary: 'x',
        severity_assessment: 'minor',
        decision: 'close_case',
        submitted_by: 'rm.alice',
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/cause_type/);
  });

  test('POST /cases/:id/caps + /approve + /close end-to-end', async () => {
    const app = makeAppForTest();
    const create = await request(app)
      .post('/cases')
      .set('x-apex-role', 'admin')
      .send(alert({ alert_id: 'a-route-3' }));
    const caseId = create.body.case.case_id;

    const propose = await request(app)
      .post(`/cases/${caseId}/caps`)
      .set('x-apex-role', 'admin')
      .send({
        cap_item: 'Freeze ad-hoc limits',
        issue_owner_group: 'credit',
        issue_owner: 'credit.gina',
        issue_priority: 'high_risk',
        target_completion_date: '2026-06-30',
        proposed_by: 'rm.alice',
      });
    expect(propose.status).toBe(201);
    const capId = propose.body.cap_id;

    const approve = await request(app)
      .post(`/cases/${caseId}/caps/${capId}/approve`)
      .set('x-apex-role', 'admin')
      .send({ approved_by: 'sup.carol', approve: true });
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe('in_progress');

    const close = await request(app)
      .post(`/cases/${caseId}/caps/${capId}/close`)
      .set('x-apex-role', 'admin')
      .send({ closed_by: 'credit.gina', closure_comments: 'Limits frozen' });
    expect(close.status).toBe(200);
    expect(close.body.status).toBe('closed');
  });

  test('POST /cases/:id/close → 409 while a CAP is in_progress', async () => {
    const app = makeAppForTest();
    const create = await request(app)
      .post('/cases')
      .set('x-apex-role', 'admin')
      .send(alert({ alert_id: 'a-route-4' }));
    const caseId = create.body.case.case_id;
    await request(app).post(`/cases/${caseId}/assign`).set('x-apex-role', 'admin').send({ user_id: 'rm.alice' });

    const propose = await request(app)
      .post(`/cases/${caseId}/caps`)
      .set('x-apex-role', 'admin')
      .send({
        cap_item: 'Restructure loan',
        issue_owner_group: 'credit',
        issue_owner: 'credit.harry',
        issue_priority: 'medium_risk',
        target_completion_date: '2026-07-15',
        proposed_by: 'rm.alice',
      });
    await request(app)
      .post(`/cases/${caseId}/caps/${propose.body.cap_id}/approve`)
      .set('x-apex-role', 'admin')
      .send({ approved_by: 'sup.carol', approve: true });

    const closeAttempt = await request(app)
      .post(`/cases/${caseId}/close`)
      .set('x-apex-role', 'admin')
      .send({ outcome: 'cured', note: '' });
    expect(closeAttempt.status).toBe(409);
    expect(closeAttempt.body.error).toMatch(/CAP/);
  });
});

describeIfPg('PgCaseStore — CAS + CAP persistence (integration, requires CASES_PG_URL)', () => {
  let pool: Pool;
  let store: PgCaseStore;

  beforeAll(() => {
    pool = new Pool({ connectionString: PG_URL, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    store = new PgCaseStore(pool, () => undefined);
    await store.init();
    await store.reset();
  });

  test('full CAS lifecycle persists + rehydrates after restart', async () => {
    const dir = tmp();
    const producer = new OutboxCaseProducer(path.join(dir, '.outbox'));
    const service = new CaseService({ store, producer });

    const { case: c } = await service.createFromAlert(
      alert({ alert_id: 'a-pg-cas-1' }),
    );
    await new Promise((r) => setTimeout(r, 50));
    const cas = await service.submitCas(c.case_id, {
      cause_type: 'borrower_specific',
      cause_summary: 'Lost contract',
      severity_assessment: 'material',
      decision: 'proceed_to_cap',
      submitted_by: 'rm.alice',
    });
    await new Promise((r) => setTimeout(r, 50));
    await service.reviewCas(c.case_id, cas.cas_id, {
      reviewed_by: 'sup.carol',
      review_status: 'approved',
      review_comments: 'Confirmed',
    });
    await new Promise((r) => setTimeout(r, 250));

    const r = await pool.query(
      `SELECT review_status, reviewed_by, review_comments, decision
         FROM app_cases.cas_records WHERE cas_id = $1`,
      [cas.cas_id],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].review_status).toBe('approved');
    expect(r.rows[0].reviewed_by).toBe('sup.carol');
    expect(r.rows[0].decision).toBe('proceed_to_cap');

    // Restart simulation — fresh store rebuilds the cas_records map.
    const fresh = new PgCaseStore(pool, () => undefined);
    await fresh.init();
    const recovered = fresh.get(c.case_id);
    expect(recovered?.cas_records).toHaveLength(1);
    expect(recovered?.cas_records[0].review_status).toBe('approved');
  });

  test('full CAP lifecycle (propose → approve → close) persists', async () => {
    const dir = tmp();
    const producer = new OutboxCaseProducer(path.join(dir, '.outbox'));
    const service = new CaseService({ store, producer });

    const { case: c } = await service.createFromAlert(
      alert({ alert_id: 'a-pg-cap-1' }),
    );
    await new Promise((r) => setTimeout(r, 50));
    const cap = await service.proposeCap(c.case_id, {
      cap_item: 'Initiate legal action',
      issue_owner_group: 'legal',
      issue_owner: 'legal.frank',
      issue_priority: 'high_risk',
      target_completion_date: '2026-06-15',
      proposed_by: 'rm.alice',
    });
    await new Promise((r) => setTimeout(r, 50));
    await service.approveCap(c.case_id, cap.cap_id, {
      approved_by: 'sup.carol',
      approve: true,
    });
    await new Promise((r) => setTimeout(r, 50));
    await service.closeCap(c.case_id, cap.cap_id, {
      closed_by: 'legal.frank',
      closure_comments: 'Filed in court',
    });
    await new Promise((r) => setTimeout(r, 300));

    const r = await pool.query(
      `SELECT status, approved_by, closed_at, closure_comments,
              target_completion_date::text AS target
         FROM app_cases.caps WHERE cap_id = $1`,
      [cap.cap_id],
    );
    expect(r.rows[0].status).toBe('closed');
    expect(r.rows[0].approved_by).toBe('sup.carol');
    expect(r.rows[0].closed_at).not.toBeNull();
    expect(r.rows[0].closure_comments).toMatch(/court/);
    expect(r.rows[0].target).toBe('2026-06-15');

    // Restart — caps come back too.
    const fresh = new PgCaseStore(pool, () => undefined);
    await fresh.init();
    const recovered = fresh.get(c.case_id);
    expect(recovered?.caps).toHaveLength(1);
    expect(recovered?.caps[0].status).toBe('closed');
    expect(recovered?.caps[0].target_completion_date).toBe('2026-06-15');
  });

  test('case.close blocked while pg-persisted CAP is in_progress', async () => {
    const dir = tmp();
    const producer = new OutboxCaseProducer(path.join(dir, '.outbox'));
    const service = new CaseService({ store, producer });

    const { case: c } = await service.createFromAlert(
      alert({ alert_id: 'a-pg-gate-1' }),
    );
    await new Promise((r) => setTimeout(r, 50));
    await service.assign(c.case_id, 'rm.alice');
    await new Promise((r) => setTimeout(r, 50));
    const cap = await service.proposeCap(c.case_id, {
      cap_item: 'Restructure',
      issue_owner_group: 'credit',
      issue_owner: 'credit.harry',
      issue_priority: 'medium_risk',
      target_completion_date: '2026-07-01',
      proposed_by: 'rm.alice',
    });
    await new Promise((r) => setTimeout(r, 50));
    await service.approveCap(c.case_id, cap.cap_id, {
      approved_by: 'sup.carol',
      approve: true,
    });
    await new Promise((r) => setTimeout(r, 50));
    // close should refuse with 409.
    await expect(
      service.close(c.case_id, { outcome: 'cured', note: '' }),
    ).rejects.toMatchObject({ status: 409 });
    // After closing the CAP, close succeeds.
    await service.closeCap(c.case_id, cap.cap_id, { closed_by: 'credit.harry' });
    await new Promise((r) => setTimeout(r, 50));
    const closed = await service.close(c.case_id, { outcome: 'cured', note: '' });
    expect(closed.state).toBe('closed');
  });
});
