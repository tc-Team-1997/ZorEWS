import { SmartQueue } from '../src/queue';
import type { CanonicalAlert, WireSeverity } from '../src/types';

let counter = 0;
function makeAlert(severity: WireSeverity, customer = 'C1'): CanonicalAlert {
  counter += 1;
  const id = `0000000${counter}`.slice(-8);
  return {
    alert_id: `${id}-1111-4111-8111-111111111111`,
    raised_at: new Date(2026, 3, 26, 8, counter, 0).toISOString(),
    ts: new Date(2026, 3, 26, 8, counter, 0).toISOString(),
    customer_id: customer,
    severity,
    rule_id: 'RULE-014',
    indicators_fired: ['TXN-003'],
    pd: null,
    risk_level: null,
    top_reasons: [],
    reason_summary: 'x',
    rule_firings: [
      {
        rule_id: 'RULE-014',
        rule_version: 1,
        matched_at: new Date(2026, 3, 26).toISOString(),
        indicator_value_ids: [],
      },
    ],
    scoring: { pd: null, risk_band: null, shap_top: [] },
  };
}

beforeEach(() => {
  counter = 0;
});

describe('SmartQueue', () => {
  test('bucket placement: critical/high → critical, medium → medium, low → low', () => {
    const q = new SmartQueue();
    const c = q.enqueue(makeAlert('CRITICAL'));
    const h = q.enqueue(makeAlert('HIGH'));
    const m = q.enqueue(makeAlert('MEDIUM'));
    const l = q.enqueue(makeAlert('LOW'));
    expect(c.bucket).toBe('critical');
    expect(h.bucket).toBe('critical');
    expect(m.bucket).toBe('medium');
    expect(l.bucket).toBe('low');
  });

  test('FIFO within bucket; pull priority is critical → medium → low', () => {
    const q = new SmartQueue();
    const m1 = q.enqueue(makeAlert('MEDIUM'));
    const m2 = q.enqueue(makeAlert('MEDIUM'));
    const c1 = q.enqueue(makeAlert('CRITICAL'));
    const l1 = q.enqueue(makeAlert('LOW'));

    const order: string[] = [];
    while (true) {
      const e = q.pullNext('BANK_DEMO', 'any-user');
      if (!e || e.state !== 'assigned') break;
      order.push(e.alert.alert_id);
      // stop after we've drained these four
      if (order.length === 4) break;
    }
    expect(order).toEqual([c1.alert.alert_id, m1.alert.alert_id, m2.alert.alert_id, l1.alert.alert_id]);
  });

  test('round-robin across analysts when no user supplied', () => {
    const q = new SmartQueue(undefined, ['ana', 'bob', 'cleo']);
    q.enqueue(makeAlert('CRITICAL'));
    q.enqueue(makeAlert('HIGH'));
    q.enqueue(makeAlert('MEDIUM'));
    q.enqueue(makeAlert('LOW'));

    const out = [
      q.pullNext()?.assignee,
      q.pullNext()?.assignee,
      q.pullNext()?.assignee,
      q.pullNext()?.assignee,
    ];
    expect(out).toEqual(['ana', 'bob', 'cleo', 'ana']);
  });

  test('assign / ack / close happy path', () => {
    const q = new SmartQueue();
    const e = q.enqueue(makeAlert('HIGH'));
    q.assign(e.alert.alert_id, 'analyst-1');
    expect(q.get(e.alert.alert_id)?.state).toBe('assigned');
    q.ack(e.alert.alert_id);
    expect(q.get(e.alert.alert_id)?.state).toBe('acked');
    q.close(e.alert.alert_id, { outcome: 'cured', note: 'paid in full' });
    const closed = q.get(e.alert.alert_id);
    expect(closed?.state).toBe('closed');
    expect(closed?.outcome).toBe('cured');
  });

  test('close requires outcome; closed alerts cannot be re-assigned', () => {
    const q = new SmartQueue();
    const e = q.enqueue(makeAlert('LOW'));
    expect(() => q.close(e.alert.alert_id, { outcome: '' })).toThrow(/outcome/);
    q.close(e.alert.alert_id, { outcome: 'no_action' });
    expect(() => q.assign(e.alert.alert_id, 'x')).toThrow(/already closed/);
  });

  test('list filters by bucket and assignee', () => {
    const q = new SmartQueue();
    const a = q.enqueue(makeAlert('CRITICAL'));
    q.enqueue(makeAlert('LOW'));
    q.assign(a.alert.alert_id, 'analyst-1');

    const critical = q.list({ bucket: 'critical' });
    expect(critical.items).toHaveLength(1);

    const mine = q.list({ assignee: 'analyst-1' });
    expect(mine.items.map((e) => e.alert.alert_id)).toEqual([a.alert.alert_id]);
  });

  test('enqueue is idempotent on alert_id', () => {
    const q = new SmartQueue();
    const a = makeAlert('MEDIUM');
    q.enqueue(a);
    q.enqueue(a);
    expect(q.snapshot()).toHaveLength(1);
  });

  // T4.24 Phase 6 — cross-tenant isolation. Alerts created under one
  // tenant are invisible to another via every read path; mutations
  // (assign / ack / close / pullNext) only act on the caller's tenant.
  describe('cross-tenant isolation (T4.24 Phase 6)', () => {
    test('list / get / pullNext / assign / ack / close are tenant-scoped', () => {
      const q = new SmartQueue();
      const bank = q.enqueue(makeAlert('CRITICAL'), 'BANK_DEMO');
      const bil = q.enqueue(makeAlert('CRITICAL'), 'BIL');
      expect(bank.tenant_id).toBe('BANK_DEMO');
      expect(bil.tenant_id).toBe('BIL');

      // list — each tenant sees only its own
      expect(q.list({ tenant_id: 'BANK_DEMO' }).total).toBe(1);
      expect(q.list({ tenant_id: 'BANK_DEMO' }).items[0].alert.alert_id).toBe(bank.alert.alert_id);
      expect(q.list({ tenant_id: 'BIL' }).total).toBe(1);
      expect(q.list({ tenant_id: 'BIL' }).items[0].alert.alert_id).toBe(bil.alert.alert_id);

      // get — cross-tenant returns undefined (no enumeration leak)
      expect(q.get(bank.alert.alert_id, 'BIL')).toBeUndefined();
      expect(q.get(bil.alert.alert_id, 'BANK_DEMO')).toBeUndefined();

      // pullNext is tenant-scoped — BIL puller never gets a BANK_DEMO alert
      const bilNext = q.pullNext('BIL', 'bil.analyst');
      expect(bilNext?.alert.alert_id).toBe(bil.alert.alert_id);
      expect(bilNext?.tenant_id).toBe('BIL');
      // BANK_DEMO puller still gets the BANK_DEMO alert
      const bankNext = q.pullNext('BANK_DEMO', 'bank.analyst');
      expect(bankNext?.alert.alert_id).toBe(bank.alert.alert_id);

      // assign — cross-tenant 404 (the BIL puller can't reassign the BANK alert)
      expect(() => q.assign(bank.alert.alert_id, 'bil.someone', 'BIL')).toThrow(/not found/);
      // close — cross-tenant 404
      expect(() => q.close(bank.alert.alert_id, { outcome: 'cured' }, 'BIL')).toThrow(/not found/);

      // ack within own tenant works
      q.ack(bil.alert.alert_id, 'BIL');
      expect(q.get(bil.alert.alert_id, 'BIL')?.state).toBe('acked');
    });

    test('default tenant (BANK_DEMO) preserves backward compat with pre-Phase-6 callers', () => {
      const q = new SmartQueue();
      // No tenant_id supplied — defaults to BANK_DEMO.
      const e = q.enqueue(makeAlert('LOW'));
      expect(e.tenant_id).toBe('BANK_DEMO');
      expect(q.list().total).toBe(1);
      expect(q.get(e.alert.alert_id)).toBeDefined();
    });
  });
});
