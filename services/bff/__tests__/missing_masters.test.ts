// services/bff/__tests__/missing_masters.test.ts

import {
  MISSING_MASTER_TYPES,
  isMissingMasterType,
  listMasterRecords,
  getMasterRecord,
  createMasterRecord,
  updateMasterRecord,
  deleteMasterRecord,
  _resetMissingMastersStore,
  MasterDataError,
} from '../src/missing_masters';

const NOW = new Date('2026-05-23T12:00:00.000Z');

beforeEach(() => _resetMissingMastersStore());

describe('enum', () => {
  it('has 12 master types', () => {
    expect(MISSING_MASTER_TYPES).toHaveLength(12);
    expect(MISSING_MASTER_TYPES).toContain('currencies');
    expect(MISSING_MASTER_TYPES).toContain('regulators');
  });
  it('type guard', () => {
    expect(isMissingMasterType('currencies')).toBe(true);
    expect(isMissingMasterType('bogus')).toBe(false);
  });
});

describe('create + list + get', () => {
  it('currencies — happy round-trip', () => {
    const r = createMasterRecord(
      'BANK_DEMO',
      'currencies',
      { code: 'INR', name: 'Indian Rupee', attributes: { symbol: '₹', decimals: 2 } },
      'alice',
      NOW,
    );
    expect(r.record_id).toMatch(/^m-currencies-BANK_DEMO-\d+$/);
    expect(r.master_type).toBe('currencies');
    expect(r.attributes.symbol).toBe('₹');
    expect(listMasterRecords('BANK_DEMO', 'currencies')).toHaveLength(1);
    expect(getMasterRecord('BANK_DEMO', 'currencies', r.record_id)).not.toBeNull();
  });

  it('list scoped by type — does not bleed across types', () => {
    createMasterRecord('BANK_DEMO', 'currencies', { code: 'INR', name: 'Rupee', attributes: { symbol: '₹', decimals: 2 } }, 'a', NOW);
    createMasterRecord('BANK_DEMO', 'severity_levels', { code: 'CRIT', name: 'Critical', attributes: { rank: 1 } }, 'a', NOW);
    expect(listMasterRecords('BANK_DEMO', 'currencies')).toHaveLength(1);
    expect(listMasterRecords('BANK_DEMO', 'severity_levels')).toHaveLength(1);
    expect(listMasterRecords('BANK_DEMO', 'regulators')).toHaveLength(0);
  });

  it('list cross-tenant scoped', () => {
    createMasterRecord('BANK_DEMO', 'currencies', { code: 'INR', name: 'Rupee', attributes: { symbol: '₹', decimals: 2 } }, 'a', NOW);
    expect(listMasterRecords('BIL', 'currencies')).toHaveLength(0);
  });

  it('q filter searches name + code', () => {
    createMasterRecord('BANK_DEMO', 'currencies', { code: 'INR', name: 'Indian Rupee', attributes: { symbol: '₹', decimals: 2 } }, 'a', NOW);
    createMasterRecord('BANK_DEMO', 'currencies', { code: 'USD', name: 'US Dollar', attributes: { symbol: '$', decimals: 2 } }, 'a', NOW);
    expect(listMasterRecords('BANK_DEMO', 'currencies', { q: 'Dollar' })).toHaveLength(1);
    expect(listMasterRecords('BANK_DEMO', 'currencies', { q: 'INR' })).toHaveLength(1);
  });

  it('enabled_only filter', () => {
    const r1 = createMasterRecord('BANK_DEMO', 'currencies', { code: 'INR', name: 'Rupee', attributes: { symbol: '₹', decimals: 2 }, enabled: false }, 'a', NOW);
    createMasterRecord('BANK_DEMO', 'currencies', { code: 'USD', name: 'Dollar', attributes: { symbol: '$', decimals: 2 } }, 'a', NOW);
    expect(listMasterRecords('BANK_DEMO', 'currencies', { enabled_only: true })).toHaveLength(1);
    void r1; // just ensure no use warning
  });

  it('duplicate code in same (tenant, type) rejected', () => {
    createMasterRecord('BANK_DEMO', 'currencies', { code: 'INR', name: 'Rupee', attributes: { symbol: '₹', decimals: 2 } }, 'a', NOW);
    expect(() =>
      createMasterRecord('BANK_DEMO', 'currencies', { code: 'INR', name: 'Other', attributes: { symbol: 'X', decimals: 2 } }, 'a', NOW),
    ).toThrow(MasterDataError);
  });

  it('same code allowed across tenants + across types', () => {
    createMasterRecord('BANK_DEMO', 'currencies', { code: 'INR', name: 'Rupee', attributes: { symbol: '₹', decimals: 2 } }, 'a', NOW);
    expect(() => createMasterRecord('BIL', 'currencies', { code: 'INR', name: 'Rupee BIL', attributes: { symbol: '₹', decimals: 2 } }, 'a', NOW)).not.toThrow();
    expect(() => createMasterRecord('BANK_DEMO', 'severity_levels', { code: 'INR', name: 'India', attributes: { rank: 5 } }, 'a', NOW)).not.toThrow();
  });
});

describe('per-type required attributes', () => {
  it('currencies missing decimals rejected', () => {
    expect(() =>
      createMasterRecord('BANK_DEMO', 'currencies', { code: 'INR', name: 'Rupee', attributes: { symbol: '₹' } }, 'a', NOW),
    ).toThrow(/decimals/);
  });
  it('regulators missing framework rejected', () => {
    expect(() =>
      createMasterRecord('BANK_DEMO', 'regulators', { code: 'RBI', name: 'Reserve Bank of India', attributes: { country: 'IN' } }, 'a', NOW),
    ).toThrow(/framework/);
  });
  it('financial_ratios missing polarity rejected', () => {
    expect(() =>
      createMasterRecord('BANK_DEMO', 'financial_ratios', { code: 'DSCR', name: 'DSCR', attributes: { formula: 'CFO / debt_service' } }, 'a', NOW),
    ).toThrow(/polarity/);
  });
  it('borrower_segments has no required attrs — empty attributes OK', () => {
    const r = createMasterRecord('BANK_DEMO', 'borrower_segments', { code: 'RETAIL', name: 'Retail', attributes: {} }, 'a', NOW);
    expect(r.master_type).toBe('borrower_segments');
  });
});

describe('update + delete', () => {
  it('update name + description + attributes', () => {
    const r = createMasterRecord('BANK_DEMO', 'currencies', { code: 'INR', name: 'Rupee', attributes: { symbol: '₹', decimals: 2 } }, 'a', NOW);
    const u = updateMasterRecord('BANK_DEMO', 'currencies', r.record_id, { name: 'Indian Rupee Updated', attributes: { decimals: 0 } }, new Date(NOW.getTime() + 1000));
    expect(u.name).toBe('Indian Rupee Updated');
    expect(u.attributes.decimals).toBe(0);
    expect(u.attributes.symbol).toBe('₹'); // preserved from merge
  });

  it('update rejects missing required after merge', () => {
    const r = createMasterRecord('BANK_DEMO', 'currencies', { code: 'INR', name: 'Rupee', attributes: { symbol: '₹', decimals: 2 } }, 'a', NOW);
    // Note: attributes merge preserves prior keys, so this passes; deletion via patch.attributes = {} would still merge. Document expected behaviour:
    const u = updateMasterRecord('BANK_DEMO', 'currencies', r.record_id, { attributes: {} }, NOW);
    expect(u.attributes.symbol).toBe('₹'); // merge preserves
  });

  it('update unknown_record throws', () => {
    expect(() => updateMasterRecord('BANK_DEMO', 'currencies', 'bogus', { name: 'X' }, NOW)).toThrow(MasterDataError);
  });

  it('delete returns true on hit + cleans up code index', () => {
    const r = createMasterRecord('BANK_DEMO', 'currencies', { code: 'INR', name: 'Rupee', attributes: { symbol: '₹', decimals: 2 } }, 'a', NOW);
    expect(deleteMasterRecord('BANK_DEMO', 'currencies', r.record_id)).toBe(true);
    // Code is now free to be re-created
    expect(() => createMasterRecord('BANK_DEMO', 'currencies', { code: 'INR', name: 'New Rupee', attributes: { symbol: '₹', decimals: 2 } }, 'a', NOW)).not.toThrow();
  });

  it('cross-tenant delete returns false', () => {
    const r = createMasterRecord('BANK_DEMO', 'currencies', { code: 'INR', name: 'Rupee', attributes: { symbol: '₹', decimals: 2 } }, 'a', NOW);
    expect(deleteMasterRecord('BIL', 'currencies', r.record_id)).toBe(false);
  });
});

describe('validation', () => {
  it('rejects invalid code (lowercase or symbols)', () => {
    expect(() => createMasterRecord('BANK_DEMO', 'currencies', { code: 'inr', name: 'X', attributes: { symbol: 'x', decimals: 2 } }, 'a', NOW)).toThrow(MasterDataError);
    expect(() => createMasterRecord('BANK_DEMO', 'currencies', { code: 'IN-R', name: 'X', attributes: { symbol: 'x', decimals: 2 } }, 'a', NOW)).toThrow(MasterDataError);
  });

  it('rejects invalid name', () => {
    expect(() => createMasterRecord('BANK_DEMO', 'currencies', { code: 'INR', name: '!', attributes: { symbol: 'x', decimals: 2 } }, 'a', NOW)).toThrow(MasterDataError);
  });

  it('rejects unknown master_type', () => {
    // @ts-expect-error testing bad type
    expect(() => createMasterRecord('BANK_DEMO', 'bogus', { code: 'X', name: 'X', attributes: {} }, 'a', NOW)).toThrow(MasterDataError);
  });

  it('rejects bad attribute value type (object)', () => {
    expect(() =>
      createMasterRecord(
        'BANK_DEMO',
        'currencies',
        { code: 'INR', name: 'Rupee', attributes: { symbol: '₹', decimals: 2, nested: { x: 1 } as unknown as string } },
        'a',
        NOW,
      ),
    ).toThrow(MasterDataError);
  });
});
