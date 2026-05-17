// Integration tests for PgCaseStore.
//
// Skipped when CASES_PG_URL is unset (the default — keeps `npm test`
// hermetic in CI). Run locally with the `zorews-pg` container up:
//
//   CASES_PG_URL=postgres://zorews_user:apex@localhost:55432/zorews \
//     npm test -- cases_pg
//
// Each test calls store.reset() in beforeEach which TRUNCATEs both
// app_cases tables — so this suite WILL wipe app_cases.* manually.
// That's a feature, not a bug; tests need a clean table to assert on counts.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Pool } from 'pg';
import { PgCaseStore } from '../src/pg_store';
import { CaseService } from '../src/service';
import { OutboxCaseProducer } from '../src/producer';
import type { AlertSummary } from '../src/types';

const PG_URL = process.env.CASES_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-cases-pg-'));
}

function alert(overrides: Partial<AlertSummary> = {}): AlertSummary {
  return {
    alert_id: 'alert-pg-001',
    customer_id: 'cust-pg-42',
    loan_id: 'loan-pg-9',
    severity: 'high',
    rule_id: 'CRD-006-v1',
    raised_at: '2026-05-03T10:00:00.000Z',
    reason_summary: 'Bureau drop with rising DPD',
    ...overrides,
  };
}

describeIfPg('PgCaseStore (integration — requires CASES_PG_URL)', () => {
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

  test('createFromAlert persists to app_cases.cases', async () => {
    const producer = new OutboxCaseProducer(path.join(tmp(), '.outbox'));
    const service = new CaseService({ store, producer });
    const a = alert({ alert_id: 'alert-pg-create' });
    const { case: c, created } = await service.createFromAlert(a);
    expect(created).toBe(true);

    await new Promise((r) => setTimeout(r, 150));
    const r = await pool.query(
      `SELECT case_id, alert_id, customer_id, severity, rule_id, state, sla_status
         FROM app_cases.cases WHERE case_id = $1`,
      [c.case_id],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].alert_id).toBe('alert-pg-create');
    expect(r.rows[0].customer_id).toBe('cust-pg-42');
    expect(r.rows[0].state).toBe('open');
    expect(r.rows[0].sla_status).toBe('on_track');
  });

  test('lifecycle (assign → action → close) persists state + actions', async () => {
    const producer = new OutboxCaseProducer(path.join(tmp(), '.outbox'));
    const service = new CaseService({ store, producer });

    // Space the transitions so the fire-and-forget UPDATEs land in order
    // — in production the gap is real (officer takes seconds to log each
    // action). Synchronous bursts race on a small pool; cache stays correct
    // but pg sees a non-deterministic final value. 50ms spacing mirrors a
    // realistic dispatch + database round-trip.
    const { case: c } = await service.createFromAlert(
      alert({ alert_id: 'alert-pg-lifecycle' }),
    );
    await new Promise((r) => setTimeout(r, 50));
    await service.assign(c.case_id, 'risk-officer-1');
    await new Promise((r) => setTimeout(r, 50));
    await service.logAction(c.case_id, {
      kind: 'call',
      officer_id: 'risk-officer-1',
      outcome_note: 'left voicemail',
      gps: null,
    });
    await new Promise((r) => setTimeout(r, 50));
    await service.logAction(c.case_id, {
      kind: 'visit',
      officer_id: 'field-officer-3',
      outcome_note: 'spoke with spouse',
      gps: { lat: -1.286389, lng: 36.817223, accuracy_m: 12.5 },
    });
    await new Promise((r) => setTimeout(r, 50));
    await service.close(c.case_id, { outcome: 'cured', note: 'paid in full' });

    await new Promise((r) => setTimeout(r, 250));

    const cRow = await pool.query(
      `SELECT state, assignee, outcome, sla_status, closed_at
         FROM app_cases.cases WHERE case_id = $1`,
      [c.case_id],
    );
    expect(cRow.rows[0].state).toBe('closed');
    expect(cRow.rows[0].assignee).toBe('risk-officer-1');
    expect(cRow.rows[0].outcome).toBe('cured');
    expect(cRow.rows[0].sla_status).toBe('closed');
    expect(cRow.rows[0].closed_at).not.toBeNull();

    const aRows = await pool.query(
      `SELECT kind, officer_id, gps_lat::text AS gps_lat,
              gps_lng::text AS gps_lng, gps_accuracy_m::text AS gps_accuracy_m
         FROM app_cases.actions WHERE case_id = $1
         ORDER BY occurred_at ASC`,
      [c.case_id],
    );
    expect(aRows.rowCount).toBe(2);
    expect(aRows.rows[0].kind).toBe('call');
    expect(aRows.rows[0].gps_lat).toBeNull();
    expect(aRows.rows[1].kind).toBe('visit');
    expect(Number(aRows.rows[1].gps_lat)).toBeCloseTo(-1.286389, 5);
    expect(Number(aRows.rows[1].gps_lng)).toBeCloseTo(36.817223, 5);
    expect(Number(aRows.rows[1].gps_accuracy_m)).toBeCloseTo(12.5, 1);
  });

  test('init() rebuilds cache (cases + actions) after a "restart"', async () => {
    const producer = new OutboxCaseProducer(path.join(tmp(), '.outbox'));
    const service = new CaseService({ store, producer });
    const { case: c } = await service.createFromAlert(
      alert({ alert_id: 'alert-pg-restart' }),
    );
    await new Promise((r) => setTimeout(r, 50));
    await service.assign(c.case_id, 'risk-officer-2');
    await new Promise((r) => setTimeout(r, 50));
    await service.logAction(c.case_id, {
      kind: 'sms',
      officer_id: 'risk-officer-2',
      outcome_note: 'reminder sent',
      gps: null,
    });
    await new Promise((r) => setTimeout(r, 250));

    // Simulate restart: fresh store, init() should rehydrate everything.
    const fresh = new PgCaseStore(pool, () => undefined);
    await fresh.init();
    const recovered = fresh.get(c.case_id);
    expect(recovered).toBeDefined();
    expect(recovered?.state).toBe('in_action');
    expect(recovered?.assignee).toBe('risk-officer-2');
    expect(recovered?.actions).toHaveLength(1);
    expect(recovered?.actions[0].kind).toBe('sms');
    // getByAlert also works against the rehydrated cache.
    const byAlert = fresh.getByAlert('alert-pg-restart');
    expect(byAlert?.case_id).toBe(c.case_id);
  });

  test('createFromAlert is idempotent on alert_id (no duplicate row)', async () => {
    const producer = new OutboxCaseProducer(path.join(tmp(), '.outbox'));
    const service = new CaseService({ store, producer });
    const a = alert({ alert_id: 'alert-pg-idempotent' });
    const r1 = await service.createFromAlert(a);
    const r2 = await service.createFromAlert(a);
    expect(r1.case.case_id).toBe(r2.case.case_id);
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);

    await new Promise((r) => setTimeout(r, 150));
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM app_cases.cases WHERE alert_id = $1`,
      ['alert-pg-idempotent'],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  test('list() filters work against the cached map', async () => {
    const producer = new OutboxCaseProducer(path.join(tmp(), '.outbox'));
    const service = new CaseService({ store, producer });
    await service.createFromAlert(
      alert({ alert_id: 'a-1', customer_id: 'c-A' }),
    );
    await service.createFromAlert(
      alert({ alert_id: 'a-2', customer_id: 'c-B' }),
    );
    const c3 = (
      await service.createFromAlert(
        alert({ alert_id: 'a-3', customer_id: 'c-A' }),
      )
    ).case;
    await service.assign(c3.case_id, 'risk-officer-99');

    const byCust = store.list({ customer_id: 'c-A' });
    expect(byCust.total).toBe(2);
    const byAssignee = store.list({ assignee: 'risk-officer-99' });
    expect(byAssignee.total).toBe(1);
    expect(byAssignee.items[0].case_id).toBe(c3.case_id);
  });
});
