import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CaseService, CASE_TOPIC } from '../src/service';
import { OutboxCaseProducer } from '../src/producer';
import { CaseStore } from '../src/store';
import { IllegalTransition } from '../src/state_machine';
import { deterministicCaseId } from '../src/case_id';
import type { AlertSummary } from '../src/types';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-cases-'));
}

function alert(overrides: Partial<AlertSummary> = {}): AlertSummary {
  return {
    alert_id: 'alert-001',
    customer_id: 'cust-42',
    loan_id: 'loan-9',
    severity: 'high',
    rule_id: 'CRD-006-v1',
    raised_at: '2026-04-27T10:00:00.000Z',
    reason_summary: 'Bureau drop with rising DPD',
    ...overrides,
  };
}

function makeService(rootDir: string) {
  const store = new CaseStore(path.join(rootDir, 'cases.ndjson'));
  const producer = new OutboxCaseProducer(path.join(rootDir, '.outbox'));
  let t = Date.parse('2026-04-27T10:00:00.000Z');
  const now = () => new Date((t += 1000));
  const service = new CaseService({ store, producer, now });
  return { service, store, producer };
}

describe('CaseService — end-to-end lifecycle', () => {
  test('create yields stable deterministic case_id', async () => {
    const { service } = makeService(tmp());
    const a = alert();
    const r1 = await service.createFromAlert(a);
    expect(r1.created).toBe(true);
    expect(r1.case.case_id).toBe(deterministicCaseId(a.alert_id, a.customer_id));
    expect(r1.case.state).toBe('open');
    expect(r1.case.actions).toEqual([]);
  });

  test('createFromAlert is idempotent on alert_id', async () => {
    const { service, producer } = makeService(tmp());
    const a = alert();
    const r1 = await service.createFromAlert(a);
    const r2 = await service.createFromAlert(a);
    expect(r1.case.case_id).toBe(r2.case.case_id);
    expect(r2.created).toBe(false);
    // Only one case.created event was emitted.
    const events = producer.readAll(CASE_TOPIC).filter((e) => e.event_type === 'case.created');
    expect(events).toHaveLength(1);
  });

  test('full lifecycle: open -> assigned -> in_action -> monitored -> closed', async () => {
    const { service, producer } = makeService(tmp());
    const a = alert({ alert_id: 'alert-lc' });
    const { case: c0 } = await service.createFromAlert(a);

    const c1 = await service.assign(c0.case_id, 'analyst.bob');
    expect(c1.state).toBe('assigned');
    expect(c1.assignee).toBe('analyst.bob');

    const c2 = await service.logAction(c0.case_id, {
      kind: 'call',
      officer_id: 'fo.alice',
      outcome_note: 'Customer promised to pay by Friday',
    });
    expect(c2.state).toBe('in_action');
    expect(c2.actions).toHaveLength(1);
    expect(c2.actions[0].kind).toBe('call');

    const c3 = await service.logAction(c0.case_id, {
      kind: 'visit',
      officer_id: 'fo.alice',
      gps: { lat: -1.29, lng: 36.82, accuracy_m: 8 },
    });
    expect(c3.state).toBe('in_action');
    expect(c3.actions).toHaveLength(2);
    expect(c3.actions[1].gps).toEqual({ lat: -1.29, lng: 36.82, accuracy_m: 8 });

    const c4 = await service.monitor(c0.case_id);
    expect(c4.state).toBe('monitored');

    const c5 = await service.close(c0.case_id, { outcome: 'cured', note: 'Paid in full' });
    expect(c5.state).toBe('closed');
    expect(c5.outcome).toBe('cured');
    expect(c5.closed_at).not.toBeNull();

    const events = producer.readAll(CASE_TOPIC).map((e) => e.event_type);
    expect(events).toEqual([
      'case.created',
      'case.assigned',
      'case.action_logged',
      'case.action_logged',
      'case.monitored',
      'case.closed',
    ]);
  });

  test('logAction during monitored re-engages to in_action', async () => {
    const { service } = makeService(tmp());
    const { case: c0 } = await service.createFromAlert(alert({ alert_id: 'alert-re' }));
    await service.assign(c0.case_id, 'u');
    await service.logAction(c0.case_id, { kind: 'call', officer_id: 'fo' });
    await service.monitor(c0.case_id);
    const after = await service.logAction(c0.case_id, { kind: 'note', officer_id: 'fo' });
    expect(after.state).toBe('in_action');
    expect(after.actions).toHaveLength(2);
  });

  test('illegal transitions throw IllegalTransition (409)', async () => {
    const { service } = makeService(tmp());
    const { case: c0 } = await service.createFromAlert(alert({ alert_id: 'alert-bad' }));
    // can't logAction without assignment
    await expect(
      service.logAction(c0.case_id, { kind: 'call', officer_id: 'fo' }),
    ).rejects.toBeInstanceOf(IllegalTransition);
    // can't monitor before action
    await service.assign(c0.case_id, 'u');
    await expect(service.monitor(c0.case_id)).rejects.toBeInstanceOf(IllegalTransition);
    // can't assign after close
    await service.close(c0.case_id, { outcome: 'defaulted' });
    await expect(service.assign(c0.case_id, 'u2')).rejects.toBeInstanceOf(IllegalTransition);
  });

  test('store survives restart (NDJSON replay)', async () => {
    const dir = tmp();
    const ndjson = path.join(dir, 'cases.ndjson');
    {
      const store1 = new CaseStore(ndjson);
      const producer1 = new OutboxCaseProducer(path.join(dir, '.outbox'));
      const svc1 = new CaseService({ store: store1, producer: producer1 });
      const { case: c } = await svc1.createFromAlert(alert({ alert_id: 'alert-persist' }));
      await svc1.assign(c.case_id, 'analyst.x');
    }
    // Fresh store reads the same file.
    const store2 = new CaseStore(ndjson);
    const list = store2.list();
    expect(list.total).toBe(1);
    expect(list.items[0].state).toBe('assigned');
    expect(list.items[0].assignee).toBe('analyst.x');
  });

  test('list filters by state / assignee / customer', async () => {
    const { service } = makeService(tmp());
    const a1 = await service.createFromAlert(alert({ alert_id: 'a1', customer_id: 'c1' }));
    const a2 = await service.createFromAlert(alert({ alert_id: 'a2', customer_id: 'c2' }));
    await service.createFromAlert(alert({ alert_id: 'a3', customer_id: 'c1' }));
    await service.assign(a1.case.case_id, 'u1');
    await service.assign(a2.case.case_id, 'u2');

    expect(service.list({ state: 'open' }).total).toBe(1);
    expect(service.list({ state: 'assigned' }).total).toBe(2);
    expect(service.list({ assignee: 'u1' }).total).toBe(1);
    expect(service.list({ customer_id: 'c1' }).total).toBe(2);
  });

  test('close on open case (no assignment, no action) is allowed and records outcome', async () => {
    const { service } = makeService(tmp());
    const { case: c0 } = await service.createFromAlert(alert({ alert_id: 'alert-fast-close' }));
    const closed = await service.close(c0.case_id, { outcome: 'cured_temp' });
    expect(closed.state).toBe('closed');
    expect(closed.outcome).toBe('cured_temp');
  });
});
