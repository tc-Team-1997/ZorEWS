// Phase 4 — Case Management: role-based case queues.
//
// Config-driven, additive lens over the EXISTING CMS case list. Each
// role lands on the queue the operational brief assigns it:
//   Fraud Analyst       → fraud investigation queue
//   Claims Investigator → insurance claim / policy-lifecycle queue
//   Credit Officer      → borrower risk queue
//   Collection Manager  → collections queue
//   Auditor             → read-only audit access (every case)
//   Admin / Supervisor  → all cases (oversight, every queue tab)
//
// Mirrors the Phase 3 dashboard widget resolver (registry + role
// mapping + pure resolver) and is keyed on BOTH the 5 live backend
// roles (admin / supervisor / risk_analyst / collection_officer /
// field_officer) and the 16 enterprise role ids so it behaves
// correctly the moment enterprise roles flow through to the SPA.
//
// NON-BREAKING contract: a user carrying any live backend role keeps
// the `all_cases` queue as their DEFAULT landing view (renders exactly
// as today), with themed lenses offered as additional tabs. Only pure
// enterprise roles get the spec's narrow default — and those aren't
// live in the SPA yet, so nothing current users see changes.

import type { CmsCase } from './api';

export type CaseQueueId =
  | 'all_cases'
  | 'fraud_investigation'
  | 'insurance_claims'
  | 'borrower_risk'
  | 'collections'
  | 'audit_review';

export interface CaseQueueDef {
  id: CaseQueueId;
  label: string;
  description: string;
  /** case_category values this queue surfaces; '*' = every category. */
  categories: readonly string[] | '*';
  /** Roles for whom this queue is a default landing queue. */
  roles: readonly string[];
  /** Read-only queues hide selection + bulk affordances (auditor). */
  readOnly: boolean;
}

// The real case_category vocabulary used across the codebase:
//   banking:   fraud, credit_risk, kyc, recovery, repayment
//   insurance: lapse, renewal, surrender, underwriting
//   fallback:  default_fallback
export const CASE_QUEUE_REGISTRY: readonly CaseQueueDef[] = [
  {
    id: 'all_cases',
    label: 'All cases',
    description: 'Every case across both domains — oversight view.',
    categories: '*',
    roles: [
      'admin',
      'supervisor',
      'super_admin',
      'country_admin',
      'bank_admin',
      'insurance_admin',
      'operations_user',
    ],
    readOnly: false,
  },
  {
    id: 'fraud_investigation',
    label: 'Fraud investigation',
    description: 'Suspected-fraud cases for investigation.',
    categories: ['fraud'],
    roles: ['fraud_analyst'],
    readOnly: false,
  },
  {
    id: 'insurance_claims',
    label: 'Insurance claims',
    description: 'Policy-lifecycle + claim cases (lapse, surrender, renewal, underwriting).',
    categories: ['lapse', 'surrender', 'renewal', 'underwriting'],
    roles: ['claims_investigator', 'underwriting_officer', 'persistency_manager'],
    readOnly: false,
  },
  {
    id: 'borrower_risk',
    label: 'Borrower risk',
    description: 'Credit + KYC + repayment-risk borrower cases.',
    categories: ['credit_risk', 'kyc', 'repayment'],
    roles: ['credit_officer', 'risk_analyst', 'field_officer'],
    readOnly: false,
  },
  {
    id: 'collections',
    label: 'Collections',
    description: 'Recovery + repayment collection cases.',
    categories: ['recovery', 'repayment'],
    roles: ['collection_officer', 'collection_manager'],
    readOnly: false,
  },
  {
    id: 'audit_review',
    label: 'Audit review',
    description: 'Read-only review of every case for compliance + audit.',
    categories: '*',
    roles: ['auditor', 'platform_auditor', 'compliance_officer', 'read_only_user'],
    readOnly: true,
  },
] as const;

const QUEUE_BY_ID = new Map<string, CaseQueueDef>(
  CASE_QUEUE_REGISTRY.map((q) => [q.id, q]),
);

/** Live backend roles the SPA auth store carries today. These keep the
 *  `all_cases` default so the case list renders unchanged for current
 *  users — queues are an additive lens, not a behaviour change. */
const LIVE_BACKEND_ROLES = new Set([
  'admin',
  'supervisor',
  'risk_analyst',
  'collection_officer',
  'field_officer',
]);

/** Oversight roles see the whole registry (every queue tab). */
const OVERSIGHT_ROLES = new Set([
  'admin',
  'supervisor',
  'super_admin',
  'country_admin',
  'bank_admin',
  'insurance_admin',
]);

export function getCaseQueue(id: string): CaseQueueDef | undefined {
  return QUEUE_BY_ID.get(id);
}

/**
 * Resolve the queues a viewer with these roles may see, default-first.
 *
 * - Oversight roles (admin/supervisor/*_admin) → the whole registry,
 *   `all_cases` first → default view is everything (unchanged).
 * - Any other live backend role → `all_cases` first (non-breaking full
 *   visibility) followed by the themed lens(es) that role maps to.
 * - Pure enterprise roles (no live backend role) → only their themed
 *   queue(s) per the brief — narrow default, forward-compatible.
 * - Empty / unknown roles → `[all_cases]` (safe, non-empty, never blank).
 *
 * The FIRST entry is the default landing queue.
 */
export function resolveCaseQueues(roles: readonly string[]): CaseQueueDef[] {
  const roleSet = new Set(roles);

  if (roles.some((r) => OVERSIGHT_ROLES.has(r))) {
    return [...CASE_QUEUE_REGISTRY];
  }

  const themed = CASE_QUEUE_REGISTRY.filter(
    (q) => q.id !== 'all_cases' && q.roles.some((r) => roleSet.has(r)),
  );

  const allCases = getCaseQueue('all_cases')!;

  // Live backend role → keep full-visibility default, offer themed lenses.
  if (roles.some((r) => LIVE_BACKEND_ROLES.has(r))) {
    return [allCases, ...themed];
  }

  // Pure enterprise role → narrow per the brief.
  if (themed.length > 0) return themed;

  // Unknown / empty roles → safe non-empty default.
  return [allCases];
}

/**
 * Does a case belong to the given queue? '*' matches every category.
 * A null/undefined case_category only matches the '*' queues (it can't
 * be claimed by a themed queue it was never tagged for).
 */
export function caseMatchesQueue(
  queue: CaseQueueDef,
  c: Pick<CmsCase, 'case_category'>,
): boolean {
  if (queue.categories === '*') return true;
  const cat = c.case_category ?? null;
  if (cat === null) return false;
  return queue.categories.includes(cat);
}
