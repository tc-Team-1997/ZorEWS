import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CaseEventSchemaError,
  loadEventValidator,
  validateOrThrow,
} from '../src/event_validator';
import { CaseService, CASE_TOPIC } from '../src/service';
import { OutboxCaseProducer } from '../src/producer';
import { CaseStore } from '../src/store';
import type { CaseEvent } from '../src/types';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-cases-validator-'));
}

describe('apex.case.events schema validator', () => {
  test('accepts a well-formed case.created event', () => {
    const ev: CaseEvent = {
      event_id: 'evt_xy_0001',
      event_type: 'case.created',
      ts: '2026-04-27T10:00:00.000Z',
      case_id: 'case-1',
      alert_id: 'alert-1',
      customer_id: 'cust-1',
      prior_state: null,
      new_state: 'open',
      payload: { severity: 'critical' },
    };
    expect(() => validateOrThrow(ev)).not.toThrow();
  });

  test('rejects an event missing required fields', () => {
    const validate = loadEventValidator();
    expect(validate({ event_id: 'x' })).toBe(false);
    expect(validate.errors?.length).toBeGreaterThan(0);
  });

  test('rejects an event with an unknown event_type', () => {
    const ev = {
      event_id: 'evt_xy_0001',
      event_type: 'case.escalated',
      ts: '2026-04-27T10:00:00.000Z',
      case_id: 'c',
      alert_id: 'a',
      customer_id: 'u',
      prior_state: null,
      new_state: 'open',
      payload: {},
    };
    expect(() => validateOrThrow(ev as never)).toThrow(CaseEventSchemaError);
  });

  test('rejects an event with an extra top-level key', () => {
    const ev = {
      event_id: 'evt_xy_0001',
      event_type: 'case.created',
      ts: '2026-04-27T10:00:00.000Z',
      case_id: 'c',
      alert_id: 'a',
      customer_id: 'u',
      prior_state: null,
      new_state: 'open',
      payload: {},
      extra_field: 'not allowed',
    };
    expect(() => validateOrThrow(ev as never)).toThrow(CaseEventSchemaError);
  });
});

describe('CaseService emits schema-valid events', () => {
  test('every event written by a full lifecycle passes the schema', async () => {
    const dir = tmp();
    const store = new CaseStore(path.join(dir, 'cases.ndjson'));
    const producer = new OutboxCaseProducer(path.join(dir, '.outbox'));
    const service = new CaseService({ store, producer });
    const { case: c } = await service.createFromAlert({
      alert_id: 'a-validator',
      customer_id: 'cust-v',
      loan_id: 'loan-v',
      severity: 'critical',
      rule_id: 'r-1',
      raised_at: '2026-04-27T10:00:00.000Z',
    });
    await service.assign(c.case_id, 'analyst.x');
    await service.logAction(c.case_id, { kind: 'call', officer_id: 'fo' });
    await service.monitor(c.case_id);
    await service.close(c.case_id, { outcome: 'cured' });

    const events = producer.readAll(CASE_TOPIC);
    expect(events).toHaveLength(5);
    for (const ev of events) {
      // The emitter has already validated; this is a belt-and-braces re-check
      // against the registered schema to guard against future code paths
      // that bypass `service.emit`.
      expect(() => validateOrThrow(ev as CaseEvent)).not.toThrow();
    }
  });
});
