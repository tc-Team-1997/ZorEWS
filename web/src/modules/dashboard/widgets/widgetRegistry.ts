// Phase 3 — Dashboard Foundation: the widget registry.
//
// SINGLE SOURCE OF TRUTH for every dashboard widget's metadata. Pages
// must NOT hardcode widgets — they resolve from here via resolveWidgets.
// Adding a widget = add one entry here + (optionally) a layout slot in
// dashboardConfig + a category in roleWidgetMapping. The React component
// binding is a separate map wired in the renderer increment.
//
// Banking + Insurance share the SAME widget SYSTEM but expose DIFFERENT
// widgets (per the Phase 3 brief). `dataSource` records where each widget
// will read once wired — every endpoint below already exists on the BFF.

import type { WidgetDef } from './types';

// ── Banking domain (7 widgets per the brief) ─────────────────────────────
const BANKING_WIDGETS: WidgetDef[] = [
  {
    id: 'bank_portfolio_health',
    title: 'Portfolio Health',
    description: 'Top-line portfolio KPIs — exposure, high-risk share, watchlist size.',
    domain: 'banking',
    category: 'overview',
    requiredPermissions: [],
    defaultSpan: 3,
    aiReady: true,
    dataSource: '/api/dashboard/summary',
  },
  {
    id: 'bank_sma_summary',
    title: 'SMA Summary',
    description: 'Special Mention Account distribution (SMA-0/1/2) + movement.',
    domain: 'banking',
    category: 'risk',
    requiredPermissions: [],
    defaultSpan: 1,
    aiReady: true,
    dataSource: '/banking/sma',
  },
  {
    id: 'bank_npa_trend',
    title: 'NPA Trend',
    description: 'Non-performing-asset trend + predicted slippage.',
    domain: 'banking',
    category: 'risk',
    requiredPermissions: [],
    defaultSpan: 1,
    aiReady: true,
    dataSource: '/banking/npa-prediction',
  },
  {
    id: 'bank_fraud_alerts',
    title: 'Fraud Alerts',
    description: 'Open fraud-suspicion signals across transactions + accounts.',
    domain: 'banking',
    category: 'fraud',
    requiredPermissions: [],
    defaultSpan: 1,
    aiReady: true,
    dataSource: '/v1/alerts/by-class/red',
  },
  {
    id: 'bank_sector_risk',
    title: 'Sector Risk',
    description: 'Sector-wise concentration + watch ranking.',
    domain: 'banking',
    category: 'risk',
    requiredPermissions: [],
    defaultSpan: 1,
    aiReady: true,
    dataSource: '/banking/sectors',
  },
  {
    id: 'bank_collections_summary',
    title: 'Collections Summary',
    description: 'Recovery pipeline + collection-officer workload.',
    domain: 'banking',
    category: 'collections',
    requiredPermissions: [],
    defaultSpan: 1,
    aiReady: true,
    dataSource: '/admin/recovery-analytics',
  },
  {
    id: 'bank_borrower_watch',
    title: 'Borrower Watch Summary',
    description: 'Borrowers trending toward stress — early-warning roll-up.',
    domain: 'banking',
    category: 'risk',
    requiredPermissions: [],
    defaultSpan: 2,
    aiReady: true,
    dataSource: '/borrower-watch',
  },
];

// ── Insurance domain (7 widgets per the brief) ───────────────────────────
const INSURANCE_WIDGETS: WidgetDef[] = [
  {
    id: 'ins_policy_lapse',
    title: 'Policy Lapse Risk',
    description: 'Policies trending toward lapse + premium at risk.',
    domain: 'insurance',
    category: 'risk',
    requiredPermissions: [],
    defaultSpan: 2,
    aiReady: true,
    dataSource: '/insurance/policy-lapse',
  },
  {
    id: 'ins_claims_anomaly',
    title: 'Claims Anomaly Alerts',
    description: 'Anomalous claim patterns flagged for review.',
    domain: 'insurance',
    category: 'fraud',
    requiredPermissions: [],
    defaultSpan: 1,
    aiReady: true,
    dataSource: '/insurance/claims-anomaly',
  },
  {
    id: 'ins_solvency_watch',
    title: 'Solvency Watch',
    description: 'Solvency-ratio headroom vs IRDAI threshold.',
    domain: 'insurance',
    category: 'overview',
    requiredPermissions: [],
    defaultSpan: 1,
    aiReady: true,
    dataSource: '/insurance/solvency',
  },
  {
    id: 'ins_persistency_summary',
    title: 'Persistency Summary',
    description: 'Renewal-persistency by cohort + lapse recovery.',
    domain: 'insurance',
    category: 'collections',
    requiredPermissions: [],
    defaultSpan: 1,
    aiReady: true,
    dataSource: '/insurance/persistency',
  },
  {
    id: 'ins_underwriting_deviations',
    title: 'Underwriting Deviations',
    description: 'Underwriting exceptions + deviation approvals.',
    domain: 'insurance',
    category: 'risk',
    requiredPermissions: [],
    defaultSpan: 1,
    aiReady: true,
    dataSource: '/insurance/underwriting',
  },
  {
    id: 'ins_channel_risk',
    title: 'Channel Risk',
    description: 'Agent/broker composite risk + mis-selling signals.',
    domain: 'insurance',
    category: 'collections',
    requiredPermissions: [],
    defaultSpan: 1,
    aiReady: true,
    dataSource: '/insurance/channel-risk',
  },
  {
    id: 'ins_claim_fraud_alerts',
    title: 'Claim Fraud Alerts',
    description: 'Suspected claim-fraud cases pending investigation.',
    domain: 'insurance',
    category: 'fraud',
    requiredPermissions: [],
    defaultSpan: 2,
    aiReady: true,
    dataSource: '/insurance/fraud',
  },
];

/** The full registry — frozen so consumers can't mutate the source. */
export const WIDGET_REGISTRY: readonly WidgetDef[] = Object.freeze([
  ...BANKING_WIDGETS,
  ...INSURANCE_WIDGETS,
]);

/** Lookup by id. Returns null when unknown. */
export function getWidgetDef(id: string): WidgetDef | null {
  return WIDGET_REGISTRY.find((w) => w.id === id) ?? null;
}

/** Every widget for a domain ('both'-domain widgets always included). */
export function widgetsForDomain(domain: 'banking' | 'insurance'): WidgetDef[] {
  return WIDGET_REGISTRY.filter((w) => w.domain === domain || w.domain === 'both');
}
