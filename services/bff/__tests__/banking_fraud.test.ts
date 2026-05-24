// services/bff/__tests__/banking_fraud.test.ts

import {
  ALL_FRAUD_CASE_STATUSES,
  ALL_FRAUD_PRIORITIES,
  ALL_FRAUD_CATEGORIES,
  listFraudCases,
  getFraudCase,
  createFraudCase,
  updateFraudCase,
  listFraudRules,
  createFraudRule,
  updateFraudRule,
  deleteFraudRule,
  submitSar,
  referToVigilance,
  _resetFraudStore,
  FraudError,
} from '../src/banking_fraud';

const NOW = new Date('2026-05-23T12:00:00.000Z');

beforeEach(() => _resetFraudStore());

describe('enums', () => {
  it('5 statuses / 4 priorities / 8 categories', () => {
    expect(ALL_FRAUD_CASE_STATUSES).toHaveLength(5);
    expect(ALL_FRAUD_PRIORITIES).toHaveLength(4);
    expect(ALL_FRAUD_CATEGORIES).toHaveLength(8);
  });
});

describe('fraud case CRUD', () => {
  it('create + list + get + tenant scoping', () => {
    const c = createFraudCase(
      'BANK_DEMO',
      { customer_id: 'c-100001', category: 'cheque_fraud', priority: 'high', amount_kes: 125000, description: 'Forged endorsement on instrument 12345' },
      'alice',
      NOW,
    );
    expect(c.case_id).toMatch(/^frd-BANK_DEMO-\d+-\d+$/);
    expect(c.status).toBe('open');
    expect(listFraudCases('BANK_DEMO')).toHaveLength(1);
    expect(getFraudCase('BANK_DEMO', c.case_id)).not.toBeNull();
    expect(getFraudCase('BIL', c.case_id)).toBeNull();
  });

  it('list sorted by priority desc then updated_at desc', () => {
    createFraudCase('BANK_DEMO', { category: 'card_fraud', priority: 'low', amount_kes: 100, description: 'minor card chargeback', customer_id: 'c-1' }, 'alice', NOW);
    createFraudCase('BANK_DEMO', { category: 'cyber_fraud', priority: 'critical', amount_kes: 500000, description: 'large unauthorised transfer abroad', customer_id: 'c-2' }, 'alice', NOW);
    createFraudCase('BANK_DEMO', { category: 'identity_theft', priority: 'medium', amount_kes: 50000, description: 'suspicious id verification', customer_id: 'c-3' }, 'alice', NOW);
    const out = listFraudCases('BANK_DEMO');
    expect(out[0].priority).toBe('critical');
    expect(out[1].priority).toBe('medium');
    expect(out[2].priority).toBe('low');
  });

  it('filters narrow', () => {
    createFraudCase('BANK_DEMO', { category: 'cyber_fraud', priority: 'high', amount_kes: 10000, description: 'suspicious activity logged', customer_id: 'c-1' }, 'alice', NOW);
    createFraudCase('BANK_DEMO', { category: 'card_fraud', priority: 'low', amount_kes: 100, description: 'chargeback', customer_id: 'c-2' }, 'alice', NOW);
    expect(listFraudCases('BANK_DEMO', { priority: 'high' })).toHaveLength(1);
    expect(listFraudCases('BANK_DEMO', { status: 'investigating' })).toHaveLength(0);
  });

  it('update status + assignee + priority', () => {
    const c = createFraudCase('BANK_DEMO', { category: 'cyber_fraud', priority: 'high', amount_kes: 10000, description: 'something fishy', customer_id: 'c-1' }, 'alice', NOW);
    const u = updateFraudCase('BANK_DEMO', c.case_id, { status: 'investigating', assignee: 'bob.investigator' }, new Date(NOW.getTime() + 1000));
    expect(u.status).toBe('investigating');
    expect(u.assignee).toBe('bob.investigator');
  });

  it('closed status sets closed_at + is immutable', () => {
    const c = createFraudCase('BANK_DEMO', { category: 'cyber_fraud', priority: 'high', amount_kes: 10000, description: 'something fishy', customer_id: 'c-1' }, 'alice', NOW);
    const u = updateFraudCase('BANK_DEMO', c.case_id, { status: 'closed' }, NOW);
    expect(u.closed_at).not.toBeNull();
    expect(() => updateFraudCase('BANK_DEMO', c.case_id, { status: 'open' }, NOW)).toThrow(/closed/);
  });

  it('rejects invalid category/priority/amount/description + unknown case', () => {
    expect(() => createFraudCase('BANK_DEMO', { category: 'bogus' as 'cyber_fraud', priority: 'high', amount_kes: 100, description: 'long enough', customer_id: 'c' }, 'a', NOW)).toThrow(FraudError);
    expect(() => createFraudCase('BANK_DEMO', { category: 'cyber_fraud', priority: 'urgent' as 'high', amount_kes: 100, description: 'long enough', customer_id: 'c' }, 'a', NOW)).toThrow(FraudError);
    expect(() => createFraudCase('BANK_DEMO', { category: 'cyber_fraud', priority: 'high', amount_kes: -1, description: 'long enough', customer_id: 'c' }, 'a', NOW)).toThrow(FraudError);
    expect(() => createFraudCase('BANK_DEMO', { category: 'cyber_fraud', priority: 'high', amount_kes: 100, description: 'x', customer_id: 'c' }, 'a', NOW)).toThrow(FraudError);
    expect(() => updateFraudCase('BANK_DEMO', 'bogus', { status: 'closed' }, NOW)).toThrow(FraudError);
  });
});

describe('fraud rule CRUD', () => {
  it('happy path — create + update + delete round-trip', () => {
    const r = createFraudRule('BANK_DEMO', { name: 'Card velocity rule', category: 'card_fraud', condition_pseudocode: 'txns_per_hour > threshold', threshold: 10 }, 'alice', NOW);
    expect(r.rule_id).toMatch(/^frrl-BANK_DEMO-\d+$/);
    expect(r.enabled).toBe(true);
    expect(listFraudRules('BANK_DEMO')).toHaveLength(1);
    const u = updateFraudRule('BANK_DEMO', r.rule_id, { enabled: false, threshold: 5 }, NOW);
    expect(u.enabled).toBe(false);
    expect(u.threshold).toBe(5);
    expect(listFraudRules('BANK_DEMO', true)).toHaveLength(0); // enabled_only
    expect(deleteFraudRule('BANK_DEMO', r.rule_id)).toBe(true);
    expect(deleteFraudRule('BANK_DEMO', r.rule_id)).toBe(false);
  });

  it('cross-tenant delete is false', () => {
    const r = createFraudRule('BANK_DEMO', { name: 'AlphaRule', category: 'cyber_fraud', condition_pseudocode: 'something', threshold: 1 }, 'alice', NOW);
    expect(deleteFraudRule('BIL', r.rule_id)).toBe(false);
  });

  it('rejects invalid name/threshold/category', () => {
    expect(() => createFraudRule('BANK_DEMO', { name: 'AlphaRule', category: 'cyber_fraud', condition_pseudocode: 'something', threshold: NaN }, 'a', NOW)).toThrow(FraudError);
    expect(() => createFraudRule('BANK_DEMO', { name: '', category: 'cyber_fraud', condition_pseudocode: 'something', threshold: 1 }, 'a', NOW)).toThrow(FraudError);
    expect(() => createFraudRule('BANK_DEMO', { name: 'NameOK', category: 'bogus' as 'cyber_fraud', condition_pseudocode: 'x', threshold: 1 }, 'a', NOW)).toThrow(FraudError);
  });
});

describe('SAR + Vigilance', () => {
  it('submitSar attaches sar_id + flips status to reported', () => {
    const c = createFraudCase('BANK_DEMO', { category: 'cyber_fraud', priority: 'critical', amount_kes: 1000000, description: 'large unauthorised transfer abroad', customer_id: 'c-1' }, 'alice', NOW);
    const sar = submitSar('BANK_DEMO', c.case_id, 'alice', 'Customer reports unauthorised SWIFT transfer of $5000 to an unknown beneficiary', NOW);
    expect(sar.sar_id).toMatch(/^sar-BANK_DEMO-\d+-\d+$/);
    expect(sar.fiu_reference).toMatch(/^FIU-IND-/);
    const refetched = getFraudCase('BANK_DEMO', c.case_id)!;
    expect(refetched.sar_id).toBe(sar.sar_id);
    expect(refetched.status).toBe('reported');
  });

  it('SAR rejects: empty summary, summary < 20 chars, double-submission, unknown case', () => {
    const c = createFraudCase('BANK_DEMO', { category: 'cyber_fraud', priority: 'critical', amount_kes: 1, description: 'something fishy here', customer_id: 'c-1' }, 'alice', NOW);
    expect(() => submitSar('BANK_DEMO', c.case_id, 'alice', 'short', NOW)).toThrow(/20 chars/);
    submitSar('BANK_DEMO', c.case_id, 'alice', 'first submission with valid long enough summary content', NOW);
    expect(() => submitSar('BANK_DEMO', c.case_id, 'alice', 'second submission with valid long enough summary content', NOW)).toThrow(/already/);
    expect(() => submitSar('BANK_DEMO', 'bogus', 'alice', 'long enough summary content here', NOW)).toThrow(FraudError);
  });

  it('referToVigilance attaches vigilance_ref + can co-exist with SAR', () => {
    const c = createFraudCase('BANK_DEMO', { category: 'staff_collusion', priority: 'critical', amount_kes: 250000, description: 'staff collusion with borrower in disbursement', customer_id: 'c-1' }, 'alice', NOW);
    const vig = referToVigilance('BANK_DEMO', c.case_id, 'alice', 'Internal staff member colluded with borrower in misuse of funds', NOW);
    expect(vig.vigilance_ref).toMatch(/^vig-BANK_DEMO-\d+-\d+$/);
    const refetched = getFraudCase('BANK_DEMO', c.case_id)!;
    expect(refetched.vigilance_ref).toBe(vig.vigilance_ref);
  });

  it('referToVigilance double-referral rejected', () => {
    const c = createFraudCase('BANK_DEMO', { category: 'staff_collusion', priority: 'high', amount_kes: 1, description: 'something fishy here', customer_id: 'c-1' }, 'alice', NOW);
    referToVigilance('BANK_DEMO', c.case_id, 'alice', 'first referral with valid reason text', NOW);
    expect(() => referToVigilance('BANK_DEMO', c.case_id, 'alice', 'second referral with valid reason text', NOW)).toThrow(/already/);
  });

  it('cross-tenant SAR/Vigilance rejected', () => {
    const c = createFraudCase('BANK_DEMO', { category: 'cyber_fraud', priority: 'high', amount_kes: 1, description: 'something fishy here', customer_id: 'c-1' }, 'alice', NOW);
    expect(() => submitSar('BIL', c.case_id, 'alice', 'long enough summary content here', NOW)).toThrow(/unknown/);
    expect(() => referToVigilance('BIL', c.case_id, 'alice', 'long enough reason text', NOW)).toThrow(/unknown/);
  });
});
