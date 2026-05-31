// web/src/modules/predictive/predictiveSignals.ts
//
// Early Warning Signals library + signal observation resolver.
//
// Distinct from M4 indicators (which compute against `mart.indicator_values`).
// Signals are *forward-looking* warning events that feed prediction features —
// SPA renders a Signal Explorer panel listing the currently-active signals per
// tenant. Each signal carries severity + recommended_action + linked predictions
// so analysts pivot from "what's flagged" to "what's predicted" in one click.

import type { PredictionKind, PredictiveDomain, RiskLevel } from './predictiveRiskEngine';
import { BANKING_PREDICTIONS, INSURANCE_PREDICTIONS, PREDICTIVE_DOMAINS } from './predictiveRiskEngine';

export const SIGNAL_SEVERITIES = ['low', 'moderate', 'high', 'severe', 'critical'] as const;
export type SignalSeverity = (typeof SIGNAL_SEVERITIES)[number];

export interface SignalDef {
  signal_id: string;
  label: string;
  domain: PredictiveDomain;
  description: string;
  default_severity: SignalSeverity;
  feeds_predictions: PredictionKind[];
}

/**
 * Platform-static signal catalog. Production swap = backend `predictive_signals`
 * table seeded from this list. SPA renders the catalog as the picker source.
 */
export const SIGNAL_LIBRARY: readonly SignalDef[] = [
  // Banking — credit
  {
    signal_id: 'missed_emi',
    label: 'Missed EMI',
    domain: 'banking',
    description: 'Borrower missed scheduled EMI on at least one tradeline in the trailing 30 days.',
    default_severity: 'high',
    feeds_predictions: ['emi_default_risk', 'npa_probability', 'sma_migration_risk', 'borrower_stress_index'],
  },
  {
    signal_id: 'multiple_bounce_events',
    label: 'Multiple Bounce Events',
    domain: 'banking',
    description: '≥ 3 cheque or direct-debit bounces in trailing 30 days.',
    default_severity: 'severe',
    feeds_predictions: ['emi_default_risk', 'collection_failure_risk', 'npa_probability'],
  },
  {
    signal_id: 'falling_cash_flow',
    label: 'Falling Cash Flow',
    domain: 'banking',
    description: 'Average operating cash inflow dropped > 25% vs trailing 90-day mean.',
    default_severity: 'moderate',
    feeds_predictions: ['borrower_stress_index', 'sma_migration_risk', 'emi_default_risk'],
  },
  {
    signal_id: 'utilisation_spike',
    label: 'Credit Utilisation Spike',
    domain: 'banking',
    description: 'Revolving-credit utilisation crossed 85% with rising 7-day trend.',
    default_severity: 'high',
    feeds_predictions: ['emi_default_risk', 'borrower_stress_index'],
  },
  {
    signal_id: 'branch_risk_spike',
    label: 'Branch Risk Spike',
    domain: 'banking',
    description: 'Branch-aggregate risk score rose > 8pp week-over-week.',
    default_severity: 'high',
    feeds_predictions: ['portfolio_risk_forecast', 'sector_deterioration_risk'],
  },
  {
    signal_id: 'sector_concentration_alert',
    label: 'Sector Concentration Alert',
    domain: 'banking',
    description: 'Exposure to a single sector crossed the 22% concentration limit.',
    default_severity: 'severe',
    feeds_predictions: ['sector_deterioration_risk', 'portfolio_risk_forecast'],
  },
  {
    signal_id: 'bureau_score_drop',
    label: 'Bureau Score Drop',
    domain: 'banking',
    description: 'CIBIL/Bureau score fell > 40 points in trailing 60 days.',
    default_severity: 'high',
    feeds_predictions: ['npa_probability', 'borrower_stress_index'],
  },
  // Insurance
  {
    signal_id: 'high_claim_frequency',
    label: 'High Claim Frequency',
    domain: 'insurance',
    description: 'Claim count for one customer crossed 4 in trailing 180 days.',
    default_severity: 'severe',
    feeds_predictions: ['claim_fraud_probability', 'persistency_decline_risk'],
  },
  {
    signal_id: 'premium_delay',
    label: 'Premium Delay',
    domain: 'insurance',
    description: 'Renewal premium overdue by > 15 days (grace nearing exhaustion).',
    default_severity: 'high',
    feeds_predictions: ['policy_lapse_probability', 'persistency_decline_risk', 'premium_collection_risk'],
  },
  {
    signal_id: 'channel_deterioration',
    label: 'Channel Deterioration',
    domain: 'insurance',
    description: 'Distribution channel persistency dropped > 6pp vs trailing 12-month mean.',
    default_severity: 'high',
    feeds_predictions: ['persistency_decline_risk', 'agent_risk_escalation'],
  },
  {
    signal_id: 'agent_cancellation_cluster',
    label: 'Agent Cancellation Cluster',
    domain: 'insurance',
    description: 'Single agent generated ≥ 4 cancellations in trailing 90 days.',
    default_severity: 'severe',
    feeds_predictions: ['agent_risk_escalation', 'persistency_decline_risk'],
  },
  {
    signal_id: 'solvency_ratio_drop',
    label: 'Solvency Ratio Drop',
    domain: 'insurance',
    description: 'IRDAI solvency ratio fell below the 1.65 watch threshold.',
    default_severity: 'critical',
    feeds_predictions: ['solvency_pressure_risk'],
  },
  {
    signal_id: 'rapid_policy_claim',
    label: 'Rapid Post-Issuance Claim',
    domain: 'insurance',
    description: 'Claim filed within 60 days of policy issuance (anti-fraud red flag).',
    default_severity: 'severe',
    feeds_predictions: ['claim_fraud_probability'],
  },
  {
    signal_id: 'customer_engagement_drop',
    label: 'Customer Engagement Drop',
    domain: 'insurance',
    description: 'Portal logins dropped > 60% vs trailing 90-day mean — churn precursor.',
    default_severity: 'moderate',
    feeds_predictions: ['customer_churn_probability', 'persistency_decline_risk'],
  },
];

export function listSignalDefs(domain?: PredictiveDomain): readonly SignalDef[] {
  if (!domain) return SIGNAL_LIBRARY;
  return SIGNAL_LIBRARY.filter((s) => s.domain === domain);
}

export function getSignalDef(signal_id: string): SignalDef | undefined {
  return SIGNAL_LIBRARY.find((s) => s.signal_id === signal_id);
}

// ───────────────────────────────────────────────────────────────────────────
// Observation resolver — synthesises "which signals are active right now"
// per tenant. Production swap = SELECT from `predictive_signals` WHERE tenant
// AND active_until > now.
// ───────────────────────────────────────────────────────────────────────────

export interface SignalObservation {
  observation_id: string;
  signal_id: string;
  label: string;
  domain: PredictiveDomain;
  tenant_id: string;
  severity: SignalSeverity;
  observed_at: string; // ISO
  description: string;
  entity_id: string; // borrower / policy / agent / branch id
  feeds_predictions: PredictionKind[];
  band: RiskLevel; // mirror of severity (for SPA badge colour)
}

function fnv1a(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function rng(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bumpSeverity(rng: () => number, base: SignalSeverity): SignalSeverity {
  // 60% stay; 25% bump up one notch; 15% bump down one notch
  const r = rng();
  const idx = SIGNAL_SEVERITIES.indexOf(base);
  if (r < 0.6) return base;
  if (r < 0.85) return SIGNAL_SEVERITIES[Math.min(SIGNAL_SEVERITIES.length - 1, idx + 1)];
  return SIGNAL_SEVERITIES[Math.max(0, idx - 1)];
}

function entityForSignal(rng: () => number, def: SignalDef, idx: number): string {
  const num = Math.floor(rng() * 9000 + 1000);
  if (def.domain === 'banking') {
    if (def.signal_id.startsWith('branch_')) return `BRANCH-${num}`;
    if (def.signal_id.startsWith('sector_')) return `SECTOR-${idx + 1}`;
    return `BORROWER-${num}`;
  }
  if (def.signal_id.startsWith('agent_')) return `AGENT-${num}`;
  if (def.signal_id.startsWith('channel_')) return `CHANNEL-${idx + 1}`;
  if (def.signal_id.startsWith('solvency_')) return 'PORTFOLIO-LIFE';
  return `POLICY-${num}`;
}

/**
 * Build a list of currently-active signal observations for a tenant.
 * Each domain produces ~2-4 active observations per day (deterministic).
 */
export function listActiveSignals(
  tenant_id: string,
  asOf: Date = new Date(),
  filters?: { domain?: PredictiveDomain; severity?: SignalSeverity; signal_id?: string },
): SignalObservation[] {
  const day = Math.floor(asOf.getTime() / 86_400_000);
  const out: SignalObservation[] = [];

  for (const domain of PREDICTIVE_DOMAINS) {
    if (filters?.domain && filters.domain !== domain) continue;
    const defs = listSignalDefs(domain);
    const rngCount = mulberry32(fnv1a([tenant_id, day, domain, 'cnt'].join('|')));
    const count = 2 + Math.floor(rngCount() * 4); // 2..5 active per domain

    for (let i = 0; i < count; i++) {
      const rng = mulberry32(fnv1a([tenant_id, day, domain, 'obs', i].join('|')));
      const def = defs[Math.floor(rng() * defs.length) % defs.length];
      if (filters?.signal_id && def.signal_id !== filters.signal_id) continue;
      const severity = bumpSeverity(rng, def.default_severity);
      if (filters?.severity && severity !== filters.severity) continue;
      const observedDay = day - Math.floor(rng() * 4); // 0..3 days ago
      const observedAt = new Date(observedDay * 86_400_000 + Math.floor(rng() * 86_400_000));
      out.push({
        observation_id: `OBS-${tenant_id}-${domain}-${day}-${i}`,
        signal_id: def.signal_id,
        label: def.label,
        domain: def.domain,
        tenant_id,
        severity,
        observed_at: observedAt.toISOString(),
        description: def.description,
        entity_id: entityForSignal(rng, def, i),
        feeds_predictions: def.feeds_predictions,
        band: severity as RiskLevel,
      });
    }
  }

  // newest-first
  out.sort((a, b) => (a.observed_at > b.observed_at ? -1 : a.observed_at < b.observed_at ? 1 : a.observation_id.localeCompare(b.observation_id)));
  return out;
}

// Re-exports for downstream callers
export { BANKING_PREDICTIONS, INSURANCE_PREDICTIONS };
