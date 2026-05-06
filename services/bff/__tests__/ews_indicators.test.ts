// services/bff/__tests__/ews_indicators.test.ts
//
// EWS-1 — indicator catalog tests.

import {
  EWS_INDICATOR_CATALOG,
  EWS_INDICATOR_COUNT,
  getEwsIndicator,
  isEwsIndicatorName,
  listEwsIndicatorDomains,
  type EwsIndicatorDomain,
} from '../src/ews_indicators';

describe('EWS-1 — indicator catalog', () => {
  test('catalog has at least 15 indicators', () => {
    expect(EWS_INDICATOR_COUNT).toBeGreaterThanOrEqual(15);
  });

  test('every entry has matching key === name', () => {
    for (const [key, ind] of Object.entries(EWS_INDICATOR_CATALOG)) {
      expect(ind.name).toBe(key);
    }
  });

  test('every entry has an id with EWS- prefix', () => {
    for (const ind of Object.values(EWS_INDICATOR_CATALOG)) {
      expect(ind.id).toMatch(/^EWS-[A-Z]+-\d{3}$/);
    }
  });

  test('every entry declares domain, type, refresh, description', () => {
    for (const ind of Object.values(EWS_INDICATOR_CATALOG)) {
      expect(typeof ind.domain).toBe('string');
      expect(typeof ind.type).toBe('string');
      expect(typeof ind.refresh).toBe('string');
      expect(typeof ind.description).toBe('string');
      expect(ind.description.length).toBeGreaterThan(8);
    }
  });

  test('numeric indicators carry a range', () => {
    for (const ind of Object.values(EWS_INDICATOR_CATALOG)) {
      if (
        ind.type === 'count' ||
        ind.type === 'percent' ||
        ind.type === 'ratio' ||
        ind.type === 'days' ||
        ind.type === 'amount' ||
        ind.type === 'flag'
      ) {
        expect(ind.range).toBeDefined();
        expect(ind.range!.min).toBeLessThanOrEqual(ind.range!.max);
      }
    }
  });

  test('enum indicators carry enum_values', () => {
    for (const ind of Object.values(EWS_INDICATOR_CATALOG)) {
      if (ind.type === 'enum') {
        expect(Array.isArray(ind.enum_values)).toBe(true);
        expect(ind.enum_values!.length).toBeGreaterThan(0);
      }
    }
  });

  test('id prefixes are disjoint from regulatory-svc (no FIN-/BEH-/TXN-/CRD-)', () => {
    for (const ind of Object.values(EWS_INDICATOR_CATALOG)) {
      // EWS- prefix already enforced above. Sanity-check no leak.
      expect(ind.id.startsWith('FIN-')).toBe(false);
      expect(ind.id.startsWith('BEH-')).toBe(false);
      expect(ind.id.startsWith('TXN-')).toBe(false);
      expect(ind.id.startsWith('CRD-')).toBe(false);
    }
  });

  test('all 10 brief-required indicators present', () => {
    const required = [
      'emi_bounce_count_90d',
      'premium_overdue_days',
      'claim_to_avg_ratio',
      'policy_age_days_at_claim',
      'kyc_doc_expiry_days',
      'txn_amount_to_avg_ratio',
      'agent_portfolio_lapse_pct',
      'login_new_country_24h',
      'customer_exposure_pct_of_portfolio',
      'txn_freq_drop_30d_pct',
      'risk_score_delta_7d',
    ];
    for (const name of required) {
      expect(getEwsIndicator(name)).not.toBeNull();
    }
  });

  test('getEwsIndicator returns null for unknown', () => {
    expect(getEwsIndicator('no_such_indicator')).toBeNull();
  });

  test('isEwsIndicatorName guard', () => {
    expect(isEwsIndicatorName('emi_bounce_count_90d')).toBe(true);
    expect(isEwsIndicatorName('no_such')).toBe(false);
    expect(isEwsIndicatorName('')).toBe(false);
    expect(isEwsIndicatorName(null)).toBe(false);
    expect(isEwsIndicatorName(42)).toBe(false);
  });

  test('listEwsIndicatorDomains covers expected domains', () => {
    const domains = listEwsIndicatorDomains();
    const expected: EwsIndicatorDomain[] = [
      'agent',
      'behaviour',
      'credit',
      'fraud',
      'insurance',
      'kyc',
      'operational',
      'portfolio',
      'risk_score',
      'transaction',
    ];
    for (const d of expected) expect(domains).toContain(d);
  });
});
