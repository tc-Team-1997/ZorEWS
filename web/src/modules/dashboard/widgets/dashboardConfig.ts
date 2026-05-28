// Phase 3 — Dashboard Foundation: per-domain layout config.
//
// Declares the canonical ORDER widgets appear in for each domain (and the
// workspace grid width). resolveWidgets uses this to order the visible
// set; widgets not listed here sort last (by id) so a newly-registered
// widget still shows up without a config edit. Config-driven layout: a
// product owner re-orders a dashboard by editing this list, no code.

import type { DomainChoice } from '@/lib/useOnboardingContext';

export interface DomainDashboardConfig {
  domain: DomainChoice;
  /** Display label for the workspace header. */
  label: string;
  /** Columns in the workspace grid (widgets span 1..gridColumns). */
  gridColumns: number;
  /** Canonical widget order (widget ids from widgetRegistry). */
  layout: string[];
}

export const DASHBOARD_CONFIG: Record<DomainChoice, DomainDashboardConfig> = {
  banking: {
    domain: 'banking',
    label: 'Banking — Risk Workspace',
    gridColumns: 3,
    layout: [
      'bank_portfolio_health',
      'bank_sma_summary',
      'bank_npa_trend',
      'bank_fraud_alerts',
      'bank_sector_risk',
      'bank_borrower_watch',
      'bank_collections_summary',
    ],
  },
  insurance: {
    domain: 'insurance',
    label: 'Insurance — Risk Workspace',
    gridColumns: 3,
    layout: [
      'ins_solvency_watch',
      'ins_policy_lapse',
      'ins_persistency_summary',
      'ins_underwriting_deviations',
      'ins_claims_anomaly',
      'ins_claim_fraud_alerts',
      'ins_channel_risk',
    ],
  },
};

/** Layout order index for a widget id within a domain; widgets absent
 *  from the layout return Infinity so they sort last. */
export function layoutOrder(domain: DomainChoice, widgetId: string): number {
  const idx = DASHBOARD_CONFIG[domain].layout.indexOf(widgetId);
  return idx === -1 ? Number.POSITIVE_INFINITY : idx;
}
