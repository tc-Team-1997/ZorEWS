// Unit + integration tests for the cross-cutting approvals fan-out
// (T4.20, BAC-A §3.1.4 maker-checker generic infrastructure).
//
// Unit tests run unconditionally with the no-op ApprovalsClient.
// Pg integration tests require CASES_PG_URL.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Pool } from 'pg';
import { ApprovalsClient } from '../src/approvals';
import { CaseService } from '../src/service';
import { OutboxCaseProducer } from '../src/producer';
import { CaseStore } from '../src/store';
import { PgCaseStore } from '../src/pg_store';
import type { AlertSummary } from '../src/types';

const PG_URL = process.env.CASES_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-approvals-'));
}

function alert(overrides: Partial<AlertSummary> = {}): AlertSummary {
  return {
    alert_id: 'alert-appr-001',
    customer_id: 'cust-appr-1',
    loan_id: null,
    severity: 'high',
    rule_id: 'CRD-006-v1',
    raised_at: '2026-05-03T12:00:00.000Z',
    reason_summary: 'approvals fan-out test',
    ...overrides,
  };
}

describe('ApprovalsClient — noop instance', () => {
  test('noop().propose() resolves without throwing (no pool)', async () => {
    const client = ApprovalsClient.noop();
    await expect(
      client.propose({
        subject_type: 'cas',
        subject_id: 'cas_x',
        action: 'submit',
        maker: 'rm.alice',
        payload: {},
      }),
    ).resolves.toBeUndefined();
  });

  test('noop().review() resolves without throwing', async () => {
    const client = ApprovalsClient.noop();
    await expect(
      client.review({
        subject_type: 'cap',
        subject_id: 'cap_x',
        checker: 'sup.bob',
        decision: 'approved',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('CaseService with no-op approvals — existing flow unchanged', () => {
  test('CAS + CAP lifecycle still works without an approvals client', async () => {
    // The default (no `approvals` in deps) = no-op client. Sanity check
    // that wiring the new ServiceDep didn't break anything.
    const dir = tmp();
    const store = new CaseStore(path.join(dir, 'cases.ndjson'));
    const producer = new OutboxCaseProducer(path.join(dir, '.outbox'));
    const service = new CaseService({ store, producer });

    const { case: c } = await service.createFromAlert(alert());
    const cas = await service.submitCas(c.case_id, {
      cause_type: 'borrower_specific',
      cause_summary: 'Lost contract',
      severity_assessment: 'material',
      decision: 'proceed_to_cap',
      submitted_by: 'rm.alice',
    });
    await service.reviewCas(c.case_id, cas.cas_id, {
      reviewed_by: 'sup.bob',
      review_status: 'approved',
    });
    expect(service.get(c.case_id)?.cas_records[0].review_status).toBe('approved');
  });
});

describeIfPg('ApprovalsClient + CaseService fan-out (integration)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: PG_URL, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE app_audit.approvals`);
    // Cases tables get truncated by the cases store reset later.
  });

  test('propose() inserts a pending row keyed by (subject_type, subject_id)', async () => {
    const client = new ApprovalsClient(pool, () => undefined);
    await client.propose({
      subject_type: 'cas',
      subject_id: 'cas_test_1',
      action: 'submit',
      maker: 'rm.alice',
      payload: { foo: 'bar' },
      correlation_id: 'case-123',
    });
    const r = await pool.query(
      `SELECT subject_type, subject_id, action, maker, status,
              correlation_id, payload->>'foo' AS foo
         FROM app_audit.approvals WHERE subject_id = $1`,
      ['cas_test_1'],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].subject_type).toBe('cas');
    expect(r.rows[0].action).toBe('submit');
    expect(r.rows[0].maker).toBe('rm.alice');
    expect(r.rows[0].status).toBe('pending');
    expect(r.rows[0].correlation_id).toBe('case-123');
    expect(r.rows[0].foo).toBe('bar');
  });

  test('review() flips the pending row to terminal status', async () => {
    const client = new ApprovalsClient(pool, () => undefined);
    await client.propose({
      subject_type: 'cap',
      subject_id: 'cap_test_2',
      action: 'propose',
      maker: 'rm.alice',
      payload: {},
    });
    await client.review({
      subject_type: 'cap',
      subject_id: 'cap_test_2',
      checker: 'sup.bob',
      decision: 'approved',
      comments: 'Looks good',
    });
    const r = await pool.query(
      `SELECT status, checker, comments, reviewed_at
         FROM app_audit.approvals WHERE subject_id = $1`,
      ['cap_test_2'],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].status).toBe('approved');
    expect(r.rows[0].checker).toBe('sup.bob');
    expect(r.rows[0].comments).toBe('Looks good');
    expect(r.rows[0].reviewed_at).not.toBeNull();
  });

  test('review() on missing pending row is a no-op (does not throw)', async () => {
    const client = new ApprovalsClient(pool, () => undefined);
    await expect(
      client.review({
        subject_type: 'cap',
        subject_id: 'cap_does_not_exist',
        checker: 'sup.bob',
        decision: 'approved',
      }),
    ).resolves.toBeUndefined();
    const r = await pool.query(`SELECT count(*)::int AS n FROM app_audit.approvals`);
    expect(r.rows[0].n).toBe(0);
  });

  test('CaseService.submitCas + reviewCas fans out to app_audit.approvals', async () => {
    // Truncate the cases tables so the test starts from a clean slate.
    const store = new PgCaseStore(pool, () => undefined);
    await store.init();
    await store.reset();

    const dir = tmp();
    const producer = new OutboxCaseProducer(path.join(dir, '.outbox'));
    const approvals = new ApprovalsClient(pool, () => undefined);
    const service = new CaseService({ store, producer, approvals });

    const { case: c } = await service.createFromAlert(
      alert({ alert_id: 'alert-fanout-cas-1' }),
    );
    await new Promise((r) => setTimeout(r, 50));
    const cas = await service.submitCas(c.case_id, {
      cause_type: 'industry_downturn',
      cause_summary: 'Sector-wide PD spike',
      severity_assessment: 'material',
      decision: 'proceed_to_cap',
      submitted_by: 'rm.alice',
    });
    await new Promise((r) => setTimeout(r, 200));

    // After submit, a pending approval exists.
    const pending = await pool.query(
      `SELECT status, action, maker, correlation_id
         FROM app_audit.approvals WHERE subject_id = $1`,
      [cas.cas_id],
    );
    expect(pending.rowCount).toBe(1);
    expect(pending.rows[0].status).toBe('pending');
    expect(pending.rows[0].action).toBe('submit');
    expect(pending.rows[0].maker).toBe('rm.alice');
    expect(pending.rows[0].correlation_id).toBe(c.case_id);

    // After review, it's flipped to approved.
    await service.reviewCas(c.case_id, cas.cas_id, {
      reviewed_by: 'sup.bob',
      review_status: 'approved',
      review_comments: 'OK',
    });
    await new Promise((r) => setTimeout(r, 200));
    const reviewed = await pool.query(
      `SELECT status, checker, comments
         FROM app_audit.approvals WHERE subject_id = $1`,
      [cas.cas_id],
    );
    expect(reviewed.rows[0].status).toBe('approved');
    expect(reviewed.rows[0].checker).toBe('sup.bob');
    expect(reviewed.rows[0].comments).toBe('OK');
  });

  test('CaseService.proposeCap + approveCap fans out to app_audit.approvals', async () => {
    const store = new PgCaseStore(pool, () => undefined);
    await store.init();
    await store.reset();

    const dir = tmp();
    const producer = new OutboxCaseProducer(path.join(dir, '.outbox'));
    const approvals = new ApprovalsClient(pool, () => undefined);
    const service = new CaseService({ store, producer, approvals });

    const { case: c } = await service.createFromAlert(
      alert({ alert_id: 'alert-fanout-cap-1' }),
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
    await new Promise((r) => setTimeout(r, 200));

    const pending = await pool.query(
      `SELECT status, action, maker, payload->>'cap_item' AS cap_item
         FROM app_audit.approvals WHERE subject_id = $1`,
      [cap.cap_id],
    );
    expect(pending.rowCount).toBe(1);
    expect(pending.rows[0].status).toBe('pending');
    expect(pending.rows[0].action).toBe('propose');
    expect(pending.rows[0].cap_item).toBe('Initiate legal action');

    // approve=true → maps to 'approved' in the approvals row.
    await service.approveCap(c.case_id, cap.cap_id, {
      approved_by: 'sup.bob',
      approve: true,
    });
    await new Promise((r) => setTimeout(r, 200));
    const approved = await pool.query(
      `SELECT status, checker FROM app_audit.approvals WHERE subject_id = $1`,
      [cap.cap_id],
    );
    expect(approved.rows[0].status).toBe('approved');
    expect(approved.rows[0].checker).toBe('sup.bob');
  });

  test('CAP rejection (approve=false) records as rework in approvals', async () => {
    const store = new PgCaseStore(pool, () => undefined);
    await store.init();
    await store.reset();

    const dir = tmp();
    const producer = new OutboxCaseProducer(path.join(dir, '.outbox'));
    const approvals = new ApprovalsClient(pool, () => undefined);
    const service = new CaseService({ store, producer, approvals });

    const { case: c } = await service.createFromAlert(
      alert({ alert_id: 'alert-fanout-cap-2' }),
    );
    await new Promise((r) => setTimeout(r, 50));
    const cap = await service.proposeCap(c.case_id, {
      cap_item: 'Restructure loan',
      issue_owner_group: 'credit',
      issue_owner: 'credit.harry',
      issue_priority: 'medium_risk',
      target_completion_date: '2026-07-01',
      proposed_by: 'rm.alice',
    });
    await new Promise((r) => setTimeout(r, 50));
    await service.approveCap(c.case_id, cap.cap_id, {
      approved_by: 'sup.eve',
      approve: false,
      comments: 'Need underwriting sign-off first',
    });
    await new Promise((r) => setTimeout(r, 200));

    const r = await pool.query(
      `SELECT status, checker, comments FROM app_audit.approvals WHERE subject_id = $1`,
      [cap.cap_id],
    );
    expect(r.rows[0].status).toBe('rework');
    expect(r.rows[0].checker).toBe('sup.eve');
    expect(r.rows[0].comments).toMatch(/sign-off/);
  });

  test('"all pending approvals" admin query — the cross-cutting use case', async () => {
    // The whole point of T4.20 — one query returns every pending
    // approval across cas + cap (and future rule-promotion / user-create).
    const store = new PgCaseStore(pool, () => undefined);
    await store.init();
    await store.reset();

    const dir = tmp();
    const producer = new OutboxCaseProducer(path.join(dir, '.outbox'));
    const approvals = new ApprovalsClient(pool, () => undefined);
    const service = new CaseService({ store, producer, approvals });

    const { case: c1 } = await service.createFromAlert(
      alert({ alert_id: 'alert-pending-1', customer_id: 'C1' }),
    );
    const { case: c2 } = await service.createFromAlert(
      alert({ alert_id: 'alert-pending-2', customer_id: 'C2' }),
    );
    await new Promise((r) => setTimeout(r, 50));

    // 2 CASs (one per case) + 1 CAP on c1.
    await service.submitCas(c1.case_id, {
      cause_type: 'borrower_specific',
      cause_summary: 'x',
      severity_assessment: 'material',
      decision: 'proceed_to_cap',
      submitted_by: 'rm.alice',
    });
    await service.submitCas(c2.case_id, {
      cause_type: 'data_quality',
      cause_summary: 'y',
      severity_assessment: 'minor',
      decision: 'close_case',
      submitted_by: 'rm.bob',
    });
    await service.proposeCap(c1.case_id, {
      cap_item: 'Freeze ad-hoc limits',
      issue_owner_group: 'credit',
      issue_owner: 'credit.gina',
      issue_priority: 'high_risk',
      target_completion_date: '2026-06-20',
      proposed_by: 'rm.alice',
    });
    await new Promise((r) => setTimeout(r, 200));

    const r = await pool.query(
      `SELECT subject_type, count(*)::int AS n
         FROM app_audit.approvals
        WHERE status = 'pending'
        GROUP BY subject_type`,
    );
    const by = Object.fromEntries(r.rows.map((row) => [row.subject_type, row.n]));
    expect(by['cas']).toBe(2);
    expect(by['cap']).toBe(1);
  });
});
