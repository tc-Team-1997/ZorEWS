// Phase 4 — Alert Center: domain classifier contract.
//
// Pins the indicator-prefix → domain derivation the alert-list domain
// filter depends on. Pure logic — no React.

import { describe, test, expect } from 'vitest';
import {
  indicatorPrefix,
  classifyIndicatorDomain,
  classifyAlertDomain,
  alertMatchesDomain,
  asAlertDomainFilter,
} from '@/modules/alerts/alertDomain';

const alert = (indicators: string[]) => ({ indicators });

describe('indicatorPrefix', () => {
  test('extracts the family prefix from a catalog id', () => {
    expect(indicatorPrefix('FIN-001')).toBe('FIN');
    expect(indicatorPrefix('CLM-002')).toBe('CLM');
    expect(indicatorPrefix('FRD-003')).toBe('FRD');
  });

  test('keeps multi-segment prefixes intact', () => {
    expect(indicatorPrefix('CUS-INS-001')).toBe('CUS-INS');
  });

  test('uppercases + trims', () => {
    expect(indicatorPrefix('  fin-007 ')).toBe('FIN');
  });

  test('handles the SPA mock IND_<FAMILY>_<NN> shape', () => {
    expect(indicatorPrefix('IND_BEH_03')).toBe('BEH');
    expect(indicatorPrefix('IND_TXN_07')).toBe('TXN');
    expect(indicatorPrefix('IND_FIN_02')).toBe('FIN');
    expect(indicatorPrefix('IND_CRD_01')).toBe('CRD');
  });

  test('non-indicator tokens → null', () => {
    expect(indicatorPrefix('bank_sma')).toBeNull();
    expect(indicatorPrefix('')).toBeNull();
    expect(indicatorPrefix('FIN')).toBeNull();
  });
});

describe('classifyIndicatorDomain', () => {
  test('banking prefixes', () => {
    for (const id of ['FIN-001', 'BEH-002', 'TXN-001', 'CRD-003', 'FRD-001']) {
      expect(classifyIndicatorDomain(id)).toBe('banking');
    }
  });

  test('insurance prefixes', () => {
    for (const id of ['POL-001', 'CUS-INS-001', 'CUS-001', 'AGT-002', 'CLM-005', 'OPS-001']) {
      expect(classifyIndicatorDomain(id)).toBe('insurance');
    }
  });

  test('SPA mock IND_ ids classify by family (banking)', () => {
    for (const id of ['IND_BEH_03', 'IND_TXN_07', 'IND_FIN_02', 'IND_CRD_01']) {
      expect(classifyIndicatorDomain(id)).toBe('banking');
    }
  });

  test('unknown prefix / non-catalog token → unknown', () => {
    expect(classifyIndicatorDomain('XYZ-001')).toBe('unknown');
    expect(classifyIndicatorDomain('bank_demo')).toBe('unknown');
  });
});

describe('classifyAlertDomain', () => {
  test('all-banking indicators → banking', () => {
    expect(classifyAlertDomain(alert(['FIN-001', 'TXN-001']))).toBe('banking');
  });

  test('all-insurance indicators → insurance', () => {
    expect(classifyAlertDomain(alert(['CLM-001', 'POL-002']))).toBe('insurance');
  });

  test('both books present → mixed', () => {
    expect(classifyAlertDomain(alert(['FIN-001', 'CLM-002']))).toBe('mixed');
  });

  test('no classifiable indicators → unknown', () => {
    expect(classifyAlertDomain(alert(['bank_sma', 'XYZ-9']))).toBe('unknown');
    expect(classifyAlertDomain(alert([]))).toBe('unknown');
  });

  test('unknown indicators alongside banking still resolve to banking', () => {
    expect(classifyAlertDomain(alert(['XYZ-9', 'FIN-001']))).toBe('banking');
  });
});

describe('alertMatchesDomain', () => {
  test("'all' passes everything", () => {
    expect(alertMatchesDomain(alert(['FIN-001']), 'all')).toBe(true);
    expect(alertMatchesDomain(alert(['CLM-001']), 'all')).toBe(true);
    expect(alertMatchesDomain(alert(['bank_sma']), 'all')).toBe(true);
  });

  test('themed filter matches its own domain', () => {
    expect(alertMatchesDomain(alert(['FIN-001']), 'banking')).toBe(true);
    expect(alertMatchesDomain(alert(['FIN-001']), 'insurance')).toBe(false);
    expect(alertMatchesDomain(alert(['CLM-001']), 'insurance')).toBe(true);
    expect(alertMatchesDomain(alert(['CLM-001']), 'banking')).toBe(false);
  });

  test('mixed alert shows under both themed filters', () => {
    const mixed = alert(['FIN-001', 'CLM-002']);
    expect(alertMatchesDomain(mixed, 'banking')).toBe(true);
    expect(alertMatchesDomain(mixed, 'insurance')).toBe(true);
  });

  test('unknown-domain alert only shows under all', () => {
    const u = alert(['bank_sma']);
    expect(alertMatchesDomain(u, 'all')).toBe(true);
    expect(alertMatchesDomain(u, 'banking')).toBe(false);
    expect(alertMatchesDomain(u, 'insurance')).toBe(false);
  });
});

describe('asAlertDomainFilter', () => {
  test('narrows valid values, defaults to all', () => {
    expect(asAlertDomainFilter('banking')).toBe('banking');
    expect(asAlertDomainFilter('insurance')).toBe('insurance');
    expect(asAlertDomainFilter('all')).toBe('all');
    expect(asAlertDomainFilter(null)).toBe('all');
    expect(asAlertDomainFilter('nonsense')).toBe('all');
  });
});
