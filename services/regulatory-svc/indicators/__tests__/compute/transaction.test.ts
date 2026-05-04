import { TRANSACTION_REGISTRY } from '../../src/compute/transaction';
import { loadCatalog } from '../../src/catalog';
import { ComputeInputs } from '../../src/types';
import { baseCustomer, baseLoan, baseTxn } from '../fixtures';

const catalog = loadCatalog();
const def = (id: string) => catalog.indicators.find((i) => i.id === id)!;

const mkInputs = (over: Partial<ComputeInputs> = {}): ComputeInputs => ({
  customer: baseCustomer(),
  loans: [baseLoan()],
  txn: baseTxn(),
  catalogEntry: def('TXN-001'),
  snapshotDate: '2026-04-26',
  ...over,
});

describe('Transaction family compute fns', () => {
  test('TXN-001 — outflow/inflow ratio: negative', () => {
    const r = TRANSACTION_REGISTRY['TXN-001'](mkInputs({ catalogEntry: def('TXN-001') }));
    expect(r.breached).toBe(false); // 80k/100k = 0.8 < 1.2
  });

  test('TXN-001 — positive (overspending)', () => {
    const r = TRANSACTION_REGISTRY['TXN-001'](mkInputs({
      txn: baseTxn({ inflow_30d: 50_000, outflow_30d: 75_000 }),
      catalogEntry: def('TXN-001'),
    }));
    expect(r.breached).toBe(true);
  });

  test('TXN-002 — large outflow anomaly: negative', () => {
    const r = TRANSACTION_REGISTRY['TXN-002'](mkInputs({ catalogEntry: def('TXN-002') }));
    expect(r.breached).toBe(false);
  });

  test('TXN-002 — positive (z-score >= 3)', () => {
    // Baseline needs non-zero variance for the z-score to be defined; a flat
    // 80k baseline + a spike returns value=0 because stddev(baseline)=0 and
    // the compute fn short-circuits. Use a small +/-2k jitter around 80k —
    // that gives non-zero stddev so the 200k spike scores z well over 3.
    const baseline = Array.from({ length: 89 }, (_, i) => 80_000 + ((i % 5) - 2) * 1_000);
    const series = [...baseline, 200_000]; // huge spike
    const r = TRANSACTION_REGISTRY['TXN-002'](mkInputs({
      txn: baseTxn({ rolling_outflow_30d_history: series }),
      catalogEntry: def('TXN-002'),
    }));
    expect(r.breached).toBe(true);
    expect(r.value).toBeGreaterThanOrEqual(3);
  });

  test('TXN-003 — cash share: negative', () => {
    const r = TRANSACTION_REGISTRY['TXN-003'](mkInputs({ catalogEntry: def('TXN-003') }));
    expect(r.breached).toBe(false);
  });

  test('TXN-003 — positive (mostly cash)', () => {
    const r = TRANSACTION_REGISTRY['TXN-003'](mkInputs({
      txn: baseTxn({ outflow_by_channel_30d: { cash: 70_000, non_cash: 10_000 } }),
      catalogEntry: def('TXN-003'),
    }));
    expect(r.breached).toBe(true);
  });

  test('TXN-004 — merchant diversity drop: negative', () => {
    const r = TRANSACTION_REGISTRY['TXN-004'](mkInputs({ catalogEntry: def('TXN-004') }));
    expect(r.breached).toBe(false);
  });

  test('TXN-004 — positive (merchant count halved+)', () => {
    const r = TRANSACTION_REGISTRY['TXN-004'](mkInputs({
      txn: baseTxn({ merchant_unique_30d: 3, merchant_unique_30_60d: 12 }),
      catalogEntry: def('TXN-004'),
    }));
    expect(r.breached).toBe(true);
  });

  test('TXN-005 — bounced payments: negative', () => {
    const r = TRANSACTION_REGISTRY['TXN-005'](mkInputs({ catalogEntry: def('TXN-005') }));
    expect(r.breached).toBe(false);
  });

  test('TXN-005 — positive', () => {
    const r = TRANSACTION_REGISTRY['TXN-005'](mkInputs({
      txn: baseTxn({ bounced_payment_count_60d: 2 }),
      catalogEntry: def('TXN-005'),
    }));
    expect(r.breached).toBe(true);
    expect(r.severity).toBe('critical'); // 0.85
  });

  test('TXN-006 — inflow concentration HHI: negative', () => {
    const r = TRANSACTION_REGISTRY['TXN-006'](mkInputs({ catalogEntry: def('TXN-006') }));
    expect(r.breached).toBe(false);
  });

  test('TXN-006 — positive (single source)', () => {
    const r = TRANSACTION_REGISTRY['TXN-006'](mkInputs({
      txn: baseTxn({ inflow_by_source_90d: { salary: 300_000, freelance: 0 } }),
      catalogEntry: def('TXN-006'),
    }));
    expect(r.breached).toBe(true);
    expect(r.value).toBeGreaterThanOrEqual(0.7);
  });

  test('TXN-007 — p2p outflow spike: negative', () => {
    const r = TRANSACTION_REGISTRY['TXN-007'](mkInputs({ catalogEntry: def('TXN-007') }));
    expect(r.breached).toBe(false);
  });

  test('TXN-007 — positive (3x spike)', () => {
    const baseline = Array.from({ length: 89 }, () => 5_000);
    const series = [...baseline, 30_000];
    const r = TRANSACTION_REGISTRY['TXN-007'](mkInputs({
      txn: baseTxn({ rolling_p2p_outflow_30d_history: series }),
      catalogEntry: def('TXN-007'),
    }));
    expect(r.breached).toBe(true);
  });

  test('TXN-008 — weekend share change: negative', () => {
    const r = TRANSACTION_REGISTRY['TXN-008'](mkInputs({ catalogEntry: def('TXN-008') }));
    expect(r.breached).toBe(false);
  });

  test('TXN-008 — positive (large weekend shift)', () => {
    const r = TRANSACTION_REGISTRY['TXN-008'](mkInputs({
      txn: baseTxn({ weekend_txn_share_30d: 0.5, weekend_txn_share_30_60d: 0.2 }),
      catalogEntry: def('TXN-008'),
    }));
    expect(r.breached).toBe(true);
  });
});
