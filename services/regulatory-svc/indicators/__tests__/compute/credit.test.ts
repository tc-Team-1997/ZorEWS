import { CREDIT_REGISTRY } from '../../src/compute/credit';
import { loadCatalog } from '../../src/catalog';
import { ComputeInputs } from '../../src/types';
import { baseCustomer, baseLoan, baseTxn } from '../fixtures';

const catalog = loadCatalog();
const def = (id: string) => catalog.indicators.find((i) => i.id === id)!;

const mkInputs = (over: Partial<ComputeInputs> = {}): ComputeInputs => ({
  customer: baseCustomer(),
  loans: [baseLoan()],
  txn: baseTxn(),
  catalogEntry: def('CRD-001'),
  snapshotDate: '2026-04-26',
  ...over,
});

describe('Credit family compute fns', () => {
  test('CRD-001 — bureau drop: negative', () => {
    const r = CREDIT_REGISTRY['CRD-001'](mkInputs({ catalogEntry: def('CRD-001') }));
    expect(r.breached).toBe(false);
  });

  test('CRD-001 — positive (60-pt drop)', () => {
    const r = CREDIT_REGISTRY['CRD-001'](mkInputs({
      customer: baseCustomer({ bureau_score: 660, bureau_score_prior_60d: 720 }),
      catalogEntry: def('CRD-001'),
    }));
    expect(r.breached).toBe(true);
    expect(r.value).toBe(60);
  });

  test('CRD-002 — bureau inquiries: negative', () => {
    const r = CREDIT_REGISTRY['CRD-002'](mkInputs({ catalogEntry: def('CRD-002') }));
    expect(r.breached).toBe(false);
  });

  test('CRD-002 — positive (4 inquiries in 90d)', () => {
    const r = CREDIT_REGISTRY['CRD-002'](mkInputs({
      customer: baseCustomer({ bureau_inquiries_90d: 4 }),
      catalogEntry: def('CRD-002'),
    }));
    expect(r.breached).toBe(true);
  });

  test('CRD-003 — external dpd max 90d: negative', () => {
    const r = CREDIT_REGISTRY['CRD-003'](mkInputs({ catalogEntry: def('CRD-003') }));
    expect(r.breached).toBe(false);
  });

  test('CRD-003 — positive', () => {
    const r = CREDIT_REGISTRY['CRD-003'](mkInputs({
      customer: baseCustomer({ bureau_external_dpd_max_90d: 45 }),
      catalogEntry: def('CRD-003'),
    }));
    expect(r.breached).toBe(true);
  });

  test('CRD-004 — external exposure growth: negative', () => {
    const r = CREDIT_REGISTRY['CRD-004'](mkInputs({ catalogEntry: def('CRD-004') }));
    expect(r.breached).toBe(false);
  });

  test('CRD-004 — positive (50% growth)', () => {
    const r = CREDIT_REGISTRY['CRD-004'](mkInputs({
      customer: baseCustomer({ bureau_ext_outstanding: 150_000, bureau_ext_outstanding_90d_ago: 100_000 }),
      catalogEntry: def('CRD-004'),
    }));
    expect(r.breached).toBe(true);
  });

  test('CRD-005 — IFRS9 stage move: negative', () => {
    const r = CREDIT_REGISTRY['CRD-005'](mkInputs({ catalogEntry: def('CRD-005') }));
    expect(r.breached).toBe(false);
  });

  test('CRD-005 — positive (1->2)', () => {
    const r = CREDIT_REGISTRY['CRD-005'](mkInputs({
      loans: [baseLoan({ ifrs9_stage: 2, ifrs9_stage_90d_ago: 1 })],
      catalogEntry: def('CRD-005'),
    }));
    expect(r.breached).toBe(true);
    expect(r.value).toBe(1);
  });

  test('CRD-006 — internal DPD: negative', () => {
    const r = CREDIT_REGISTRY['CRD-006'](mkInputs({ catalogEntry: def('CRD-006') }));
    expect(r.breached).toBe(false);
  });

  test('CRD-006 — positive', () => {
    const r = CREDIT_REGISTRY['CRD-006'](mkInputs({
      loans: [baseLoan({ days_past_due: 45 })],
      catalogEntry: def('CRD-006'),
    }));
    expect(r.breached).toBe(true);
    expect(r.severity).toBe('critical'); // weight 0.95
  });

  test('CRD-007 — collateral coverage: negative (well-covered)', () => {
    const r = CREDIT_REGISTRY['CRD-007'](mkInputs({ catalogEntry: def('CRD-007') }));
    expect(r.breached).toBe(false);
  });

  test('CRD-007 — positive (under-collateralised)', () => {
    const r = CREDIT_REGISTRY['CRD-007'](mkInputs({
      loans: [baseLoan({ collateral_fmv: 100_000, outstanding_amount: 200_000 })],
      catalogEntry: def('CRD-007'),
    }));
    expect(r.breached).toBe(true);
  });

  test('CRD-008 — guarantor default: negative', () => {
    const r = CREDIT_REGISTRY['CRD-008'](mkInputs({ catalogEntry: def('CRD-008') }));
    expect(r.breached).toBe(false);
  });

  test('CRD-008 — positive', () => {
    const r = CREDIT_REGISTRY['CRD-008'](mkInputs({
      customer: baseCustomer({ guarantor_default_180d: true }),
      catalogEntry: def('CRD-008'),
    }));
    expect(r.breached).toBe(true);
  });
});
