// Phase 4 — Case Management: role-based case queue resolver contract.
//
// Pins the config-driven, role-aware, NON-BREAKING queue resolution the
// CMS case list depends on. Pure logic — no React. The key invariant is
// that live backend roles never lose full-visibility (all_cases stays
// their default) while enterprise roles get the brief's narrow queues.

import { describe, test, expect } from 'vitest';
import {
  resolveCaseQueues,
  caseMatchesQueue,
  getCaseQueue,
  CASE_QUEUE_REGISTRY,
  type CaseQueueDef,
} from '@/modules/cms/caseQueues';
import type { CmsCase } from '@/modules/cms/api';

const caseWith = (case_category: string | null): Pick<CmsCase, 'case_category'> => ({
  case_category,
});

describe('case queue registry', () => {
  test('every queue id is unique', () => {
    const ids = CASE_QUEUE_REGISTRY.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every queue carries the required metadata', () => {
    for (const q of CASE_QUEUE_REGISTRY) {
      expect(q.id).toBeTruthy();
      expect(q.label).toBeTruthy();
      expect(q.description).toBeTruthy();
      expect(q.categories === '*' || Array.isArray(q.categories)).toBe(true);
      expect(Array.isArray(q.roles)).toBe(true);
      expect(typeof q.readOnly).toBe('boolean');
    }
  });

  test('all_cases is the first registry entry (default-first for oversight)', () => {
    expect(CASE_QUEUE_REGISTRY[0].id).toBe('all_cases');
  });

  test('exactly one queue is read-only (audit_review)', () => {
    const ro = CASE_QUEUE_REGISTRY.filter((q) => q.readOnly);
    expect(ro.map((q) => q.id)).toEqual(['audit_review']);
  });

  test('getCaseQueue resolves a known id and returns undefined for nonsense', () => {
    expect(getCaseQueue('fraud_investigation')?.label).toBe('Fraud investigation');
    expect(getCaseQueue('nonsense_queue')).toBeUndefined();
  });
});

describe('resolveCaseQueues — oversight roles', () => {
  test('admin → whole registry, all_cases first', () => {
    const out = resolveCaseQueues(['admin']);
    expect(out.map((q) => q.id)).toEqual(CASE_QUEUE_REGISTRY.map((q) => q.id));
    expect(out[0].id).toBe('all_cases');
  });

  test('supervisor → whole registry', () => {
    expect(resolveCaseQueues(['supervisor'])).toHaveLength(CASE_QUEUE_REGISTRY.length);
  });

  test('enterprise admin ids (bank_admin) → whole registry', () => {
    expect(resolveCaseQueues(['bank_admin'])).toHaveLength(CASE_QUEUE_REGISTRY.length);
  });
});

describe('resolveCaseQueues — live backend roles stay non-breaking', () => {
  test('risk_analyst → all_cases default + borrower_risk lens', () => {
    const out = resolveCaseQueues(['risk_analyst']);
    expect(out[0].id).toBe('all_cases'); // default unchanged
    expect(out.map((q) => q.id)).toContain('borrower_risk');
  });

  test('collection_officer → all_cases default + collections lens', () => {
    const out = resolveCaseQueues(['collection_officer']);
    expect(out[0].id).toBe('all_cases');
    expect(out.map((q) => q.id)).toContain('collections');
  });

  test('field_officer → all_cases default + borrower_risk lens', () => {
    const out = resolveCaseQueues(['field_officer']);
    expect(out[0].id).toBe('all_cases');
    expect(out.map((q) => q.id)).toContain('borrower_risk');
  });

  test('live backend default never narrows below all_cases (full visibility preserved)', () => {
    for (const role of ['risk_analyst', 'collection_officer', 'field_officer']) {
      expect(resolveCaseQueues([role])[0].id).toBe('all_cases');
    }
  });
});

describe('resolveCaseQueues — pure enterprise roles get the brief defaults', () => {
  test('fraud_analyst → fraud_investigation only (narrow per brief)', () => {
    expect(resolveCaseQueues(['fraud_analyst']).map((q) => q.id)).toEqual([
      'fraud_investigation',
    ]);
  });

  test('claims_investigator → insurance_claims only', () => {
    expect(resolveCaseQueues(['claims_investigator']).map((q) => q.id)).toEqual([
      'insurance_claims',
    ]);
  });

  test('credit_officer → borrower_risk only', () => {
    expect(resolveCaseQueues(['credit_officer']).map((q) => q.id)).toEqual(['borrower_risk']);
  });

  test('auditor → audit_review only, read-only', () => {
    const out = resolveCaseQueues(['auditor']);
    expect(out.map((q) => q.id)).toEqual(['audit_review']);
    expect(out[0].readOnly).toBe(true);
  });

  test('enterprise role with no backend role does NOT get all_cases', () => {
    expect(resolveCaseQueues(['fraud_analyst']).map((q) => q.id)).not.toContain('all_cases');
  });
});

describe('resolveCaseQueues — safe defaults', () => {
  test('empty roles → [all_cases] (never blank)', () => {
    expect(resolveCaseQueues([]).map((q) => q.id)).toEqual(['all_cases']);
  });

  test('unknown role → [all_cases]', () => {
    expect(resolveCaseQueues(['nonsense_role']).map((q) => q.id)).toEqual(['all_cases']);
  });

  test('multi-role unions lenses; live backend role keeps all_cases first', () => {
    const out = resolveCaseQueues(['risk_analyst', 'collection_officer']);
    expect(out[0].id).toBe('all_cases');
    const ids = out.map((q) => q.id);
    expect(ids).toContain('borrower_risk');
    expect(ids).toContain('collections');
  });

  test('output is deterministic across calls', () => {
    const a = resolveCaseQueues(['risk_analyst']).map((q) => q.id);
    const b = resolveCaseQueues(['risk_analyst']).map((q) => q.id);
    expect(a).toEqual(b);
  });
});

describe('caseMatchesQueue', () => {
  const fraud = getCaseQueue('fraud_investigation') as CaseQueueDef;
  const borrower = getCaseQueue('borrower_risk') as CaseQueueDef;
  const all = getCaseQueue('all_cases') as CaseQueueDef;

  test("'*' queue matches every category, including null", () => {
    expect(caseMatchesQueue(all, caseWith('fraud'))).toBe(true);
    expect(caseMatchesQueue(all, caseWith('credit_risk'))).toBe(true);
    expect(caseMatchesQueue(all, caseWith(null))).toBe(true);
  });

  test('themed queue matches only its categories', () => {
    expect(caseMatchesQueue(fraud, caseWith('fraud'))).toBe(true);
    expect(caseMatchesQueue(fraud, caseWith('credit_risk'))).toBe(false);
  });

  test('borrower_risk matches credit_risk / kyc / repayment', () => {
    expect(caseMatchesQueue(borrower, caseWith('credit_risk'))).toBe(true);
    expect(caseMatchesQueue(borrower, caseWith('kyc'))).toBe(true);
    expect(caseMatchesQueue(borrower, caseWith('repayment'))).toBe(true);
    expect(caseMatchesQueue(borrower, caseWith('lapse'))).toBe(false);
  });

  test('null category never matches a themed queue', () => {
    expect(caseMatchesQueue(fraud, caseWith(null))).toBe(false);
    expect(caseMatchesQueue(borrower, caseWith(null))).toBe(false);
  });

  test('undefined case_category behaves like null', () => {
    expect(caseMatchesQueue(fraud, {})).toBe(false);
    expect(caseMatchesQueue(all, {})).toBe(true);
  });
});
