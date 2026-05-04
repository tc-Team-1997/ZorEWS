// Integration tests for PgSmartQueue.
//
// Skipped when ALERTS_PG_URL is unset (the default — keeps `npm test`
// hermetic in CI). Run locally with the `apex-ews-pg` container up:
//
//   ALERTS_PG_URL=postgres://apex:apex@localhost:55432/apex_ews \
//     npm test -- alerts_pg
//
// Each test calls queue.reset() in beforeEach which TRUNCATEs both
// app_alerts tables — so this suite WILL wipe app_alerts.* manually.

import { Pool } from 'pg';
import { PgSmartQueue } from '../src/pg_queue';
import type { CanonicalAlert, WireSeverity } from '../src/types';

const PG_URL = process.env.ALERTS_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

let counter = 0;
function makeAlert(severity: WireSeverity, customer = 'C1'): CanonicalAlert {
  counter += 1;
  const id = `pgsm${`000${counter}`.slice(-3)}`;
  return {
    alert_id: `${id}-1111-4111-8111-111111111111`,
    raised_at: new Date(2026, 4, 3, 8, counter, 0).toISOString(),
    ts: new Date(2026, 4, 3, 8, counter, 0).toISOString(),
    customer_id: customer,
    severity,
    rule_id: 'RULE-014',
    indicators_fired: ['TXN-003', 'BEH-007'],
    pd: null,
    risk_level: null,
    top_reasons: [],
    reason_summary: 'pg-test',
    rule_firings: [
      {
        rule_id: 'RULE-014',
        rule_version: 1,
        matched_at: new Date(2026, 4, 3).toISOString(),
        indicator_value_ids: [],
      },
    ],
    scoring: { pd: null, risk_band: null, shap_top: [] },
  };
}

describeIfPg('PgSmartQueue (integration — requires ALERTS_PG_URL)', () => {
  let pool: Pool;
  let queue: PgSmartQueue;

  beforeAll(() => {
    pool = new Pool({ connectionString: PG_URL, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    counter = 0;
    queue = new PgSmartQueue(pool, [], () => undefined);
    await queue.init();
    await queue.reset();
  });

  test('enqueue() persists to app_alerts.alerts + writes initial assignment row', async () => {
    const a = queue.enqueue(makeAlert('CRITICAL'));
    expect(a.bucket).toBe('critical');
    expect(a.state).toBe('queued');

    await new Promise((r) => setTimeout(r, 200));

    const alerts = await pool.query(
      `SELECT alert_id, severity, customer_id, status, indicators FROM app_alerts.alerts`,
    );
    expect(alerts.rowCount).toBe(1);
    expect(alerts.rows[0].severity).toBe('critical');
    expect(alerts.rows[0].status).toBe('open');
    expect(alerts.rows[0].indicators).toEqual(['TXN-003', 'BEH-007']);

    const assignments = await pool.query(
      `SELECT alert_id, queue, assigned_to, assigned_by FROM app_alerts.queue_assignments`,
    );
    expect(assignments.rowCount).toBe(1);
    expect(assignments.rows[0].queue).toBe('critical');
    expect(assignments.rows[0].assigned_to).toBeNull();
    expect(assignments.rows[0].assigned_by).toBe('system');
  });

  test('lifecycle (enqueue → assign → ack → close) updates status + appends assignments', async () => {
    const a = queue.enqueue(makeAlert('HIGH'));
    await new Promise((r) => setTimeout(r, 80));

    queue.assign(a.alert.alert_id, 'risk-officer-9');
    await new Promise((r) => setTimeout(r, 80));

    queue.ack(a.alert.alert_id);
    await new Promise((r) => setTimeout(r, 80));

    queue.close(a.alert.alert_id, { outcome: 'cured', note: 'paid' });
    await new Promise((r) => setTimeout(r, 200));

    const r = await pool.query(
      `SELECT status, assignee, acked_at, closed_at FROM app_alerts.alerts WHERE alert_id = $1`,
      [a.alert.alert_id],
    );
    expect(r.rows[0].status).toBe('closed');
    expect(r.rows[0].assignee).toBe('risk-officer-9');
    expect(r.rows[0].acked_at).not.toBeNull();
    expect(r.rows[0].closed_at).not.toBeNull();

    // queue_assignments has 2 rows: initial 'system' + assign('risk-officer-9').
    const ass = await pool.query(
      `SELECT assigned_to FROM app_alerts.queue_assignments
        WHERE alert_id = $1 ORDER BY assigned_at ASC`,
      [a.alert.alert_id],
    );
    expect(ass.rowCount).toBe(2);
    expect(ass.rows[0].assigned_to).toBeNull();
    expect(ass.rows[1].assigned_to).toBe('risk-officer-9');
  });

  test('init() rebuilds bucket order from created_at after a "restart"', async () => {
    queue.enqueue(makeAlert('LOW', 'C1'));
    queue.enqueue(makeAlert('CRITICAL', 'C2'));
    const m = queue.enqueue(makeAlert('MEDIUM', 'C3'));
    queue.assign(m.alert.alert_id, 'risk-officer-x');
    await new Promise((r) => setTimeout(r, 250));

    // Restart simulation — fresh queue rebuilds from pg.
    const fresh = new PgSmartQueue(pool, [], () => undefined);
    await fresh.init();
    const snap = fresh.snapshot();
    // priority order: critical first, then medium, then low.
    expect(snap.length).toBe(3);
    expect(snap[0].bucket).toBe('critical');
    expect(snap[1].bucket).toBe('medium');
    expect(snap[1].state).toBe('assigned'); // status='open' + assignee set → assigned
    expect(snap[1].assignee).toBe('risk-officer-x');
    expect(snap[2].bucket).toBe('low');
  });

  test('pullNext respects priority (critical → medium → low)', async () => {
    queue.enqueue(makeAlert('LOW', 'C1'));
    queue.enqueue(makeAlert('MEDIUM', 'C2'));
    queue.enqueue(makeAlert('CRITICAL', 'C3'));
    queue.setAnalysts(['risk.a']);

    const first = queue.pullNext();
    expect(first?.bucket).toBe('critical');
    expect(first?.assignee).toBe('risk.a');

    await new Promise((r) => setTimeout(r, 200));
    const r = await pool.query(
      `SELECT assignee, status FROM app_alerts.alerts WHERE alert_id = $1`,
      [first!.alert.alert_id],
    );
    expect(r.rows[0].assignee).toBe('risk.a');
    expect(r.rows[0].status).toBe('open');
  });

  test('enqueue() is idempotent on alert_id (no duplicate row)', async () => {
    const a1 = queue.enqueue(makeAlert('CRITICAL'));
    const a2 = queue.enqueue(a1.alert);
    expect(a1).toBe(a2);
    await new Promise((r) => setTimeout(r, 200));
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM app_alerts.alerts WHERE alert_id = $1`,
      [a1.alert.alert_id],
    );
    expect(r.rows[0].n).toBe(1);
  });
});
