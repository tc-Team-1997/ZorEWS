// services/bff/src/customer_360.ts
//
// T6 M11.6 — Per-customer 360 drill-through dashboard.
//
// Single endpoint that orchestrates all the per-customer adapters
// shipped through Module 14 plus M9 investigations into one consolidated
// view. The SPA renders this on the "customer detail" page — one
// network call gives ops the full risk picture without N round-trips.
//
// Adapters consulted:
//   - InsuranceAdapter   (M14.1) — policies + claims
//   - Ifrs9Adapter       (M14.2) — stage classification
//   - AmlAdapter         (M14.3) — match list (best-effort screen on demand)
//   - DmsAdapter         (M14.4) — document register
//   - BureauAdapter      (M14.5) — latest report (no fresh pull — M14.5
//                                  has explicit `pull` semantics; we
//                                  surface what's already in the ledger)
//   - FinanceAdapter     (M14.7) — accounts
//   - CaseInvestigationStore (M9.1) — investigations for the customer
//
// **Panel-level degradation**: if any adapter throws, that panel comes
// back null + the panel name is added to `degraded[]`. The whole call
// stays 200 — partial answers beat a hard failure when the SPA needs
// to show *something* on the customer page even when one upstream is
// flaky.

import type { InsuranceAdapter, Policy, Claim } from './integrations/insurance';
import type { Ifrs9Adapter, Ifrs9Stage } from './integrations/ifrs9';
import type { AmlAdapter, AmlMatch } from './integrations/aml';
import type { DmsAdapter, DmsDocument } from './integrations/dms';
import type { BureauAdapter, BureauReport } from './integrations/bureau';
import type { FinanceAdapter, FinanceAccount } from './integrations/finance';
import type {
  CaseInvestigationStore,
  CaseInvestigation,
} from './case_investigation';

// ─── Public types ──────────────────────────────────────────────────────

export type DegradedPanel =
  | 'policies'
  | 'claims'
  | 'finance'
  | 'aml'
  | 'dms'
  | 'bureau'
  | 'ifrs9'
  | 'investigations';

export interface Customer360 {
  customer_id: string;
  generated_at: string;
  /** Names of panels that failed to assemble (adapter throw). null fields
   *  in `panels` correspond 1-to-1 with entries here. Empty array on a
   *  fully-healthy call. */
  degraded: DegradedPanel[];
  /** Headline numbers — null when the panels they depend on degraded. */
  summary: {
    /** Highest AML severity across open matches. null when AML degraded
     *  or no open matches. */
    aml_highest_severity: 'high' | 'medium' | 'low' | null;
    /** Number of open investigations. null when investigations panel degraded. */
    open_investigations: number | null;
    /** IFRS9 stage. null when ifrs9 degraded or customer not in book. */
    ifrs9_stage: 1 | 2 | 3 | null;
    /** Latest bureau score. null when bureau degraded or no report. */
    bureau_score: number | null;
    /** Sum of finance account balances (in KES, signed). null when finance degraded. */
    total_finance_balance_kes: number | null;
    /** Count of in-force policies. null when policies degraded. */
    in_force_policies: number | null;
    /** Count of open claims (non-paid, non-rejected, non-withdrawn). null when claims degraded. */
    open_claims: number | null;
  };
  panels: {
    policies: Policy[] | null;
    claims: Claim[] | null;
    finance_accounts: FinanceAccount[] | null;
    aml_matches: AmlMatch[] | null;
    dms_documents: DmsDocument[] | null;
    bureau_latest: BureauReport | null;
    ifrs9_stage: Ifrs9Stage | null;
    investigations: CaseInvestigation[] | null;
  };
}

export interface Customer360Deps {
  insuranceAdapter: InsuranceAdapter;
  ifrs9Adapter: Ifrs9Adapter;
  amlAdapter: AmlAdapter;
  dmsAdapter: DmsAdapter;
  bureauAdapter: BureauAdapter;
  financeAdapter: FinanceAdapter;
  caseInvestigationStore: CaseInvestigationStore;
}

export class Customer360Error extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'Customer360Error';
  }
}

// ─── Orchestrator ──────────────────────────────────────────────────────

/**
 * Helper that catches errors per panel + records them in `degraded[]`
 * without bubbling. Each panel returns null on failure so the
 * SPA can render "data unavailable" while the rest of the page works.
 */
async function tryPanel<T>(
  panel: DegradedPanel,
  fn: () => Promise<T> | T,
  degraded: DegradedPanel[],
): Promise<T | null> {
  try {
    return await fn();
  } catch {
    degraded.push(panel);
    return null;
  }
}

/**
 * Build the consolidated customer-360 payload. Concurrent panel
 * fetches keep the round-trip cost ~one slow adapter rather than the
 * sum of all of them.
 */
export async function buildCustomer360(
  tenant_id: string,
  customer_id: string,
  deps: Customer360Deps,
  now: () => Date,
): Promise<Customer360> {
  if (!tenant_id || !customer_id) {
    throw new Customer360Error('invalid_input', 'tenant_id and customer_id are required');
  }
  const asOf = now();
  const degraded: DegradedPanel[] = [];

  // Concurrent panel fetches — none of them depend on each other so
  // running them in parallel keeps tail latency low.
  const [policies, claims, finance_accounts, dms_documents, ifrs9_stage] = await Promise.all([
    tryPanel('policies', () => deps.insuranceAdapter.listPolicies(tenant_id, customer_id, asOf), degraded),
    tryPanel('claims', () => deps.insuranceAdapter.listClaims(tenant_id, customer_id, asOf), degraded),
    tryPanel(
      'finance',
      () => deps.financeAdapter.listAccountsForCustomer(tenant_id, customer_id, asOf),
      degraded,
    ),
    tryPanel('dms', () => deps.dmsAdapter.listByCustomer(tenant_id, customer_id, asOf), degraded),
    tryPanel('ifrs9', () => deps.ifrs9Adapter.getStage(tenant_id, customer_id, asOf), degraded),
  ]);

  // AML: list existing matches first; if none, that's fine — the SPA
  // can decide whether to fire a fresh screen via the M14.3 endpoint.
  const aml_matches = await tryPanel(
    'aml',
    () => deps.amlAdapter.listMatches(tenant_id, customer_id),
    degraded,
  );

  // Bureau: surface what's already in the ledger; M14.5 has explicit
  // pull semantics (idempotent per day). The 360 view doesn't trigger
  // a fresh pull — that would be cost.
  const bureau_latest = await tryPanel(
    'bureau',
    async () => {
      const list = await deps.bureauAdapter.listByCustomer(tenant_id, customer_id);
      return list.length > 0 ? list[0]! : null;
    },
    degraded,
  );

  // Investigations: filter the store by customer_id.
  const investigations_raw = await tryPanel(
    'investigations',
    () => deps.caseInvestigationStore.list(tenant_id, { customer_id, page_size: 50 }),
    degraded,
  );
  const investigations = investigations_raw ? investigations_raw.items : null;

  // ── Summary derivations ──
  const aml_highest_severity = aml_matches
    ? aml_matches
        .filter((m) => m.status === 'open')
        .reduce<Customer360['summary']['aml_highest_severity']>((acc, m) => {
          const rank = (s: AmlMatch['severity']): number =>
            s === 'high' ? 3 : s === 'medium' ? 2 : 1;
          if (!acc) return m.severity;
          return rank(m.severity) > rank(acc) ? m.severity : acc;
        }, null)
    : null;

  const open_investigations = investigations
    ? investigations.filter((i) => i.status !== 'closed').length
    : null;

  const total_finance_balance_kes = finance_accounts
    ? finance_accounts.reduce((s, a) => s + a.balance_kes, 0)
    : null;

  const in_force_policies = policies
    ? policies.filter((p) => p.status === 'in_force').length
    : null;

  const open_claims = claims
    ? claims.filter((c) => c.status !== 'paid' && c.status !== 'rejected' && c.status !== 'withdrawn')
        .length
    : null;

  return {
    customer_id,
    generated_at: asOf.toISOString(),
    degraded,
    summary: {
      aml_highest_severity,
      open_investigations,
      ifrs9_stage: ifrs9_stage ? ifrs9_stage.stage : null,
      bureau_score: bureau_latest ? bureau_latest.score : null,
      total_finance_balance_kes,
      in_force_policies,
      open_claims,
    },
    panels: {
      policies,
      claims,
      finance_accounts,
      aml_matches,
      dms_documents,
      bureau_latest,
      ifrs9_stage,
      investigations,
    },
  };
}
