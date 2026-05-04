import { FINANCIAL_REGISTRY } from '../../src/compute/financial';
import { loadCatalog } from '../../src/catalog';
import { ComputeInputs } from '../../src/types';
import { baseCustomer, baseLoan, baseTxn } from '../fixtures';

const catalog = loadCatalog();
const def = (id: string) => catalog.indicators.find((i) => i.id === id)!;

const mkInputs = (over: Partial<ComputeInputs> = {}): ComputeInputs => ({
  customer: baseCustomer(),
  loans: [baseLoan()],
  txn: baseTxn(),
  catalogEntry: def('FIN-001'),
  snapshotDate: '2026-04-26',
  ...over,
});

describe('Financial family compute fns', () => {
  test('FIN-001 — balance drop: negative case (flat balance)', () => {
    const r = FINANCIAL_REGISTRY['FIN-001'](mkInputs({ catalogEntry: def('FIN-001') }));
    expect(r.breached).toBe(false);
    expect(r.value).toBeCloseTo(0, 2);
  });

  test('FIN-001 — balance drop: positive case (50% drop)', () => {
    const dailies = [...Array.from({ length: 30 }, () => 100_000),
                     ...Array.from({ length: 30 }, () => 50_000)];
    const r = FINANCIAL_REGISTRY['FIN-001'](mkInputs({
      txn: baseTxn({ daily_balance: dailies }),
      catalogEntry: def('FIN-001'),
    }));
    expect(r.breached).toBe(true);
    expect(r.value).toBeCloseTo(0.5, 2);
    expect(r.severity).toBe('high'); // weight 0.7
  });

  test('FIN-002 — min balance breach count: negative', () => {
    const r = FINANCIAL_REGISTRY['FIN-002'](mkInputs({ catalogEntry: def('FIN-002') }));
    expect(r.breached).toBe(false);
  });

  test('FIN-002 — min balance breach count: positive (10 days under min)', () => {
    const eod = [...Array.from({ length: 10 }, () => 1_000),
                 ...Array.from({ length: 20 }, () => 50_000)];
    const r = FINANCIAL_REGISTRY['FIN-002'](mkInputs({
      txn: baseTxn({ eod_balance_30d: eod }),
      customer: baseCustomer({ min_op_balance: 5_000 }),
      catalogEntry: def('FIN-002'),
    }));
    expect(r.breached).toBe(true);
    expect(r.value).toBe(10);
  });

  test('FIN-003 — savings/loan ratio: negative', () => {
    const r = FINANCIAL_REGISTRY['FIN-003'](mkInputs({ catalogEntry: def('FIN-003') }));
    expect(r.breached).toBe(false);
  });

  test('FIN-003 — savings/loan ratio: positive (savings drained)', () => {
    const r = FINANCIAL_REGISTRY['FIN-003'](mkInputs({
      customer: baseCustomer({ savings_balance: 5_000 }),
      catalogEntry: def('FIN-003'),
    }));
    expect(r.breached).toBe(true);
  });

  test('FIN-004 — income volatility: negative (flat income)', () => {
    const r = FINANCIAL_REGISTRY['FIN-004'](mkInputs({ catalogEntry: def('FIN-004') }));
    expect(r.breached).toBe(false);
  });

  test('FIN-004 — income volatility: positive (high CV)', () => {
    const r = FINANCIAL_REGISTRY['FIN-004'](mkInputs({
      txn: baseTxn({ monthly_income_history: Array(9).fill(100_000).concat([10_000, 200_000, 5_000]) }),
      catalogEntry: def('FIN-004'),
    }));
    expect(r.breached).toBe(true);
  });

  test('FIN-005 — net cashflow / EMI: negative (positive headroom)', () => {
    const r = FINANCIAL_REGISTRY['FIN-005'](mkInputs({ catalogEntry: def('FIN-005') }));
    expect(r.breached).toBe(false);
  });

  test('FIN-005 — net cashflow / EMI: positive (negative cashflow)', () => {
    const r = FINANCIAL_REGISTRY['FIN-005'](mkInputs({
      txn: baseTxn({ inflow_30d: 50_000, outflow_30d: 80_000 }),
      catalogEntry: def('FIN-005'),
    }));
    expect(r.breached).toBe(true);
  });

  test('FIN-006 — salary skipped months: negative', () => {
    const r = FINANCIAL_REGISTRY['FIN-006'](mkInputs({ catalogEntry: def('FIN-006') }));
    expect(r.breached).toBe(false);
  });

  test('FIN-006 — salary skipped months: positive (3-month gap)', () => {
    const r = FINANCIAL_REGISTRY['FIN-006'](mkInputs({
      txn: baseTxn({ salary_inflow_history: [100_000, 100_000, 0, 0, 0, 100_000] }),
      catalogEntry: def('FIN-006'),
    }));
    expect(r.breached).toBe(true);
    expect(r.value).toBe(3);
  });

  test('FIN-007 — loan/income ratio: negative', () => {
    const r = FINANCIAL_REGISTRY['FIN-007'](mkInputs({ catalogEntry: def('FIN-007') }));
    // outstanding 200k / annual income 1.2m = 0.166 -> not breached
    expect(r.breached).toBe(false);
  });

  test('FIN-007 — loan/income ratio: positive (highly leveraged)', () => {
    const r = FINANCIAL_REGISTRY['FIN-007'](mkInputs({
      loans: [baseLoan({ outstanding_amount: 1_000_000 })],
      customer: baseCustomer({ total_outstanding: 1_000_000 }),
      catalogEntry: def('FIN-007'),
    }));
    expect(r.breached).toBe(true);
  });

  test('FIN-008 — overdraft util: negative', () => {
    const r = FINANCIAL_REGISTRY['FIN-008'](mkInputs({ catalogEntry: def('FIN-008') }));
    expect(r.breached).toBe(false);
  });

  test('FIN-008 — overdraft util: positive (95% utilised)', () => {
    const r = FINANCIAL_REGISTRY['FIN-008'](mkInputs({
      customer: baseCustomer({ overdraft_used: 95_000, overdraft_limit: 100_000 }),
      catalogEntry: def('FIN-008'),
    }));
    expect(r.breached).toBe(true);
  });
});
