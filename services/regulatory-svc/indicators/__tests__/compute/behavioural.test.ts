import { BEHAVIOURAL_REGISTRY } from '../../src/compute/behavioural';
import { loadCatalog } from '../../src/catalog';
import { ComputeInputs } from '../../src/types';
import { baseCustomer, baseLoan, baseTxn } from '../fixtures';

const catalog = loadCatalog();
const def = (id: string) => catalog.indicators.find((i) => i.id === id)!;

const mkInputs = (over: Partial<ComputeInputs> = {}): ComputeInputs => ({
  customer: baseCustomer(),
  loans: [baseLoan()],
  txn: baseTxn(),
  catalogEntry: def('BEH-001'),
  snapshotDate: '2026-04-26',
  ...over,
});

describe('Behavioural family compute fns', () => {
  test('BEH-001 — repayment_delay_days_avg_90d: negative', () => {
    const r = BEHAVIOURAL_REGISTRY['BEH-001'](mkInputs({ catalogEntry: def('BEH-001') }));
    expect(r.breached).toBe(false);
  });

  test('BEH-001 — positive (avg 15 days late on last 3)', () => {
    const r = BEHAVIOURAL_REGISTRY['BEH-001'](mkInputs({
      loans: [baseLoan({
        repayment_history: [
          { due_date: '2026-02-26', paid_date: '2026-03-12', amount_due: 25_000, amount_paid: 25_000, days_late: 14 },
          { due_date: '2026-03-26', paid_date: '2026-04-10', amount_due: 25_000, amount_paid: 25_000, days_late: 15 },
          { due_date: '2026-04-26', paid_date: '2026-05-10', amount_due: 25_000, amount_paid: 25_000, days_late: 14 },
        ],
      })],
      catalogEntry: def('BEH-001'),
    }));
    expect(r.breached).toBe(true);
    expect(r.value).toBeGreaterThanOrEqual(7);
  });

  test('BEH-002 — repayment_delay_streak: negative', () => {
    const r = BEHAVIOURAL_REGISTRY['BEH-002'](mkInputs({ catalogEntry: def('BEH-002') }));
    expect(r.breached).toBe(false);
  });

  test('BEH-002 — positive (3 trailing late)', () => {
    const r = BEHAVIOURAL_REGISTRY['BEH-002'](mkInputs({
      loans: [baseLoan({
        repayment_history: [
          { due_date: '2026-01-26', paid_date: '2026-01-26', amount_due: 25_000, amount_paid: 25_000, days_late: 0 },
          { due_date: '2026-02-26', paid_date: '2026-03-05', amount_due: 25_000, amount_paid: 25_000, days_late: 7 },
          { due_date: '2026-03-26', paid_date: '2026-04-05', amount_due: 25_000, amount_paid: 25_000, days_late: 10 },
          { due_date: '2026-04-26', paid_date: '2026-05-10', amount_due: 25_000, amount_paid: 25_000, days_late: 14 },
        ],
      })],
      catalogEntry: def('BEH-002'),
    }));
    expect(r.breached).toBe(true);
    expect(r.value).toBe(3);
  });

  test('BEH-003 — partial repayment ratio: negative', () => {
    const r = BEHAVIOURAL_REGISTRY['BEH-003'](mkInputs({ catalogEntry: def('BEH-003') }));
    expect(r.breached).toBe(false);
  });

  test('BEH-003 — partial repayment ratio: positive', () => {
    const r = BEHAVIOURAL_REGISTRY['BEH-003'](mkInputs({
      loans: [baseLoan({
        repayment_history: [
          { due_date: '2026-02-26', paid_date: '2026-02-26', amount_due: 25_000, amount_paid: 10_000, days_late: 0 },
          { due_date: '2026-03-26', paid_date: '2026-03-26', amount_due: 25_000, amount_paid: 12_000, days_late: 0 },
          { due_date: '2026-04-26', paid_date: '2026-04-26', amount_due: 25_000, amount_paid: 25_000, days_late: 0 },
        ],
      })],
      catalogEntry: def('BEH-003'),
    }));
    expect(r.breached).toBe(true);
    expect(r.value).toBeCloseTo(2 / 3, 3);
  });

  test('BEH-004 — channel login drop: negative', () => {
    const r = BEHAVIOURAL_REGISTRY['BEH-004'](mkInputs({ catalogEntry: def('BEH-004') }));
    expect(r.breached).toBe(false);
  });

  test('BEH-004 — channel login drop: positive (logins fell 80%)', () => {
    const r = BEHAVIOURAL_REGISTRY['BEH-004'](mkInputs({
      customer: baseCustomer({ channel_logins_30d: 6, channel_logins_90d: 90 }),
      catalogEntry: def('BEH-004'),
    }));
    expect(r.breached).toBe(true);
  });

  test('BEH-005 — complaints: negative', () => {
    const r = BEHAVIOURAL_REGISTRY['BEH-005'](mkInputs({ catalogEntry: def('BEH-005') }));
    expect(r.breached).toBe(false);
  });

  test('BEH-005 — complaints: positive', () => {
    const r = BEHAVIOURAL_REGISTRY['BEH-005'](mkInputs({
      customer: baseCustomer({ complaints_60d: 3 }),
      catalogEntry: def('BEH-005'),
    }));
    expect(r.breached).toBe(true);
  });

  test('BEH-006 — kyc expiry: negative', () => {
    const r = BEHAVIOURAL_REGISTRY['BEH-006'](mkInputs({ catalogEntry: def('BEH-006') }));
    expect(r.breached).toBe(false);
  });

  test('BEH-006 — kyc expiry: positive (expires in 7 days)', () => {
    const r = BEHAVIOURAL_REGISTRY['BEH-006'](mkInputs({
      customer: baseCustomer({ kyc_expiry_days: 7 }),
      catalogEntry: def('BEH-006'),
    }));
    expect(r.breached).toBe(true);
    expect(r.value).toBe(7);
  });

  test('BEH-007 — restructure flag: negative', () => {
    const r = BEHAVIOURAL_REGISTRY['BEH-007'](mkInputs({ catalogEntry: def('BEH-007') }));
    expect(r.breached).toBe(false);
  });

  test('BEH-007 — restructure flag: positive', () => {
    const r = BEHAVIOURAL_REGISTRY['BEH-007'](mkInputs({
      loans: [baseLoan({
        restructure_requests: [{ requested_at: '2026-04-01', reason: 'cashflow' }],
      })],
      catalogEntry: def('BEH-007'),
    }));
    expect(r.breached).toBe(true);
    expect(r.value).toBe(1);
  });

  test('BEH-008 — unreachable contact: negative', () => {
    const r = BEHAVIOURAL_REGISTRY['BEH-008'](mkInputs({ catalogEntry: def('BEH-008') }));
    expect(r.breached).toBe(false);
  });

  test('BEH-008 — unreachable contact: positive', () => {
    const r = BEHAVIOURAL_REGISTRY['BEH-008'](mkInputs({
      customer: baseCustomer({ contact_failures_30d: 5 }),
      catalogEntry: def('BEH-008'),
    }));
    expect(r.breached).toBe(true);
  });
});
