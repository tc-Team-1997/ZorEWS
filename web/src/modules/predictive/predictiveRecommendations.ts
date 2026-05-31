// web/src/modules/predictive/predictiveRecommendations.ts
//
// Prescriptive action framework.
//
// Each prediction's explanation references one or more action_ids; the SPA
// resolves the descriptor here. Production POST /predictive-recommendations
// records the action issuance against `predictive_recommendations` table for
// the maker-checker audit trail.

import type { PredictionExplanation } from './predictiveExplanations';
import type { PredictiveDomain } from './predictiveRiskEngine';

export const RECOMMENDATION_ACTIONS = [
  'contact_borrower',
  'increase_monitoring',
  'launch_investigation',
  'escalate_review',
  'freeze_exposure',
  'trigger_retention_campaign',
] as const;
export type RecommendationActionId = (typeof RECOMMENDATION_ACTIONS)[number];

export interface RecommendationDef {
  action_id: RecommendationActionId;
  label: string;
  description: string;
  domains: PredictiveDomain[]; // which surfaces it applies to
  severity_floor: 'moderate' | 'high' | 'severe' | 'critical';
  requires_maker_checker: boolean;
  default_assignee_role: 'risk_analyst' | 'collection_officer' | 'fraud_analyst' | 'supervisor';
}

export const RECOMMENDATION_CATALOG: readonly RecommendationDef[] = [
  {
    action_id: 'contact_borrower',
    label: 'Contact Borrower',
    description: 'Reach out to customer via call / SMS / branch visit to confirm intent + capture commitment date.',
    domains: ['banking', 'insurance'],
    severity_floor: 'moderate',
    requires_maker_checker: false,
    default_assignee_role: 'collection_officer',
  },
  {
    action_id: 'increase_monitoring',
    label: 'Increase Monitoring',
    description: 'Add customer to active watchlist + raise alert sensitivity for 30 days.',
    domains: ['banking', 'insurance'],
    severity_floor: 'moderate',
    requires_maker_checker: false,
    default_assignee_role: 'risk_analyst',
  },
  {
    action_id: 'launch_investigation',
    label: 'Launch Investigation',
    description: 'Open a case in CMS with BIL §17 checklist seeded; assign to fraud / risk analyst.',
    domains: ['banking', 'insurance'],
    severity_floor: 'high',
    requires_maker_checker: false,
    default_assignee_role: 'fraud_analyst',
  },
  {
    action_id: 'escalate_review',
    label: 'Escalate Review',
    description: 'Push to head-of-risk / supervisor review queue with SLA budget shortened.',
    domains: ['banking', 'insurance'],
    severity_floor: 'high',
    requires_maker_checker: true,
    default_assignee_role: 'supervisor',
  },
  {
    action_id: 'freeze_exposure',
    label: 'Freeze Exposure',
    description: 'Pause new disbursements / policy issuance against the customer or portfolio segment until review clears.',
    domains: ['banking', 'insurance'],
    severity_floor: 'severe',
    requires_maker_checker: true,
    default_assignee_role: 'supervisor',
  },
  {
    action_id: 'trigger_retention_campaign',
    label: 'Trigger Retention Campaign',
    description: 'Enroll customer in retention workflow — relationship manager outreach + tailored offer.',
    domains: ['insurance'],
    severity_floor: 'moderate',
    requires_maker_checker: false,
    default_assignee_role: 'risk_analyst',
  },
];

export function getRecommendation(action_id: string): RecommendationDef | undefined {
  return RECOMMENDATION_CATALOG.find((r) => r.action_id === action_id);
}

export function listRecommendations(domain?: PredictiveDomain): readonly RecommendationDef[] {
  if (!domain) return RECOMMENDATION_CATALOG;
  return RECOMMENDATION_CATALOG.filter((r) => r.domains.includes(domain));
}

/**
 * Materialise the explanation's recommended_action_ids into full
 * RecommendationDef objects — used by the SPA action panel.
 */
export function recommendationsFor(explanation: PredictionExplanation): RecommendationDef[] {
  return explanation.recommended_action_ids
    .map((id) => getRecommendation(id))
    .filter((r): r is RecommendationDef => Boolean(r));
}
