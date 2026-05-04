// services/bff/src/bil_dashboards.ts
//
// BIL dashboard payload builders (T6 M11.1 onwards).
//
// The DataNetworks-EWS-Ver1.pdf §14 calls out 5 BIL dashboards:
//   1. Executive  — already covered by the existing /api/dashboards
//   2. Claims     — this module (M11.1)
//   3. Underwriting — future M11.2
//   4. Agent     — future M11.3
//   5. Operational — future M11.4
//
// Each dashboard takes a tenant_id and an "as of" Date and returns a
// deterministic payload. We deliberately use seeded synthesis here
// rather than querying mart.* / regulatory-svc directly because:
//   - mart.claim_360 / policy_360 / agent_360 don't materialise yet
//     (they ship with the BIL synthetic-data follow-up)
//   - the SPA + downstream consumers can start integrating against the
//     stable response shape today
//
// When the BIL data lands, swap each builder's body for real queries —
// the response shape stays.

/**
 * Cheap deterministic hash → numeric seed. Same input always produces
 * the same output, so a given tenant sees a stable dashboard across
 * calls (until the underlying data changes for real).
 */
function seedFrom(...parts: string[]): number {
  let h = 2166136261 >>> 0;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h >>> 0;
}

/** Mulberry32 PRNG. Pure function of the seed; no global state. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Claims Dashboard (T6 M11.1) ───────────────────────────────────────

export interface AbnormalClaimPattern {
  pattern: string;
  description: string;
  count_30d: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  delta_pct_vs_baseline: number;
}

export interface FlaggedHospital {
  provider_id: string;
  provider_name: string;
  total_claims_30d: number;
  total_amount_kes: number;
  fraud_score: number;
  rank: number;
}

export interface TurnaroundAnomaly {
  claim_id: string;
  policy_id: string;
  reason_code: string;
  filed_at: string;
  expected_tat_hours: number;
  actual_tat_hours: number;
  status: 'pending' | 'investigating' | 'escalated';
}

export interface ClaimsDashboard {
  tenant_id: string;
  as_of: string;
  totals: {
    claims_filed_30d: number;
    claims_closed_30d: number;
    open_investigations: number;
    fraud_flagged_pct: number;
    average_tat_hours: number;
  };
  abnormal_claim_patterns: AbnormalClaimPattern[];
  flagged_hospitals: FlaggedHospital[];
  turnaround_anomalies: TurnaroundAnomaly[];
}

const PATTERNS: Array<{ pattern: string; description: string; severity: AbnormalClaimPattern['severity'] }> = [
  { pattern: 'WAITING_PERIOD_BREACH', description: 'Claim filed within policy waiting period', severity: 'critical' },
  { pattern: 'REPEAT_REASON_180D', description: 'Same customer, same reason code ≥3× in 180d', severity: 'high' },
  { pattern: 'AMOUNT_DEVIATION_30PCT', description: 'Claim amount deviates >30% from benchmark', severity: 'high' },
  { pattern: 'MISSING_DOCS', description: 'Required supporting documents missing or incomplete', severity: 'medium' },
  { pattern: 'OFF_TEMPLATE_DOCS', description: 'Document layout matches known fraudulent submissions', severity: 'high' },
  { pattern: 'RAPID_POLICY_CLAIM', description: 'Claim filed <30d after policy issuance', severity: 'medium' },
];

const HOSPITAL_PROVIDERS = [
  { provider_id: 'PRV-091', provider_name: 'Karen Hospital — Annex' },
  { provider_id: 'PRV-204', provider_name: 'Mediplus Diagnostic' },
  { provider_id: 'PRV-318', provider_name: 'Eastside Wellness Centre' },
  { provider_id: 'PRV-447', provider_name: 'Riverdale Medi-Care' },
  { provider_id: 'PRV-562', provider_name: 'Premier Surgical Hub' },
];

const REASON_CODES = ['ILL-001', 'ACC-014', 'SURG-208', 'OBS-039', 'EME-082'];

/**
 * Build the Claims dashboard payload for a tenant.
 *
 * Deterministic — same (tenant_id, day-of-asOf) input produces the same
 * output. When the BIL synthetic dataset ships, swap the synthesis below
 * for real queries against `mart.claim_360`, `mart.provider_fraud_scores`,
 * and the regulatory-svc/cases TAT data.
 */
export function buildClaimsDashboard(tenant_id: string, asOf: Date): ClaimsDashboard {
  const dayKey = asOf.toISOString().slice(0, 10); // tenant + day → stable seed
  const r = rng(seedFrom(tenant_id, dayKey));

  // BIL operates at smaller scale than the BANK_DEMO dataset.
  const scale = tenant_id === 'BIL' ? 0.6 : 1.0;
  const claims_filed_30d = Math.floor((180 + r() * 220) * scale);
  const claims_closed_30d = Math.floor(claims_filed_30d * (0.7 + r() * 0.18));
  const open_investigations = Math.floor((8 + r() * 24) * scale);
  const fraud_flagged_pct = Math.round((4 + r() * 8) * 100) / 100;
  const average_tat_hours = Math.round((42 + r() * 36) * 10) / 10;

  // Abnormal patterns — sample 4 of the 6 with synthesised counts.
  const patternCount = 4;
  const shuffled = PATTERNS.slice().sort(() => r() - 0.5);
  const abnormal_claim_patterns = shuffled.slice(0, patternCount).map((p) => ({
    pattern: p.pattern,
    description: p.description,
    count_30d: Math.floor((3 + r() * 24) * scale),
    severity: p.severity,
    delta_pct_vs_baseline: Math.round((r() * 180 - 30) * 10) / 10,
  }));

  // Flagged hospitals — top 5, deterministic ordering by rank.
  const flagged_hospitals = HOSPITAL_PROVIDERS.map((h, i) => ({
    provider_id: h.provider_id,
    provider_name: h.provider_name,
    total_claims_30d: Math.floor((40 - i * 6 + r() * 10) * scale),
    total_amount_kes: Math.floor((15_000_000 - i * 2_500_000 + r() * 4_000_000) * scale),
    fraud_score: Math.round((0.9 - i * 0.1 + r() * 0.08) * 100) / 100,
    rank: i + 1,
  }));

  // Turnaround anomalies — 6 sample rows.
  const turnaround_anomalies: TurnaroundAnomaly[] = [];
  for (let i = 0; i < 6; i++) {
    const expected = 24 + Math.floor(r() * 48);
    const actual = expected + 24 + Math.floor(r() * 120);
    const filed = new Date(asOf);
    filed.setHours(filed.getHours() - actual - Math.floor(r() * 12));
    const statusOptions: TurnaroundAnomaly['status'][] = ['pending', 'investigating', 'escalated'];
    turnaround_anomalies.push({
      claim_id: `CLM-${String(Math.floor(r() * 99999)).padStart(5, '0')}`,
      policy_id: `POL-${String(Math.floor(r() * 99999)).padStart(5, '0')}`,
      reason_code: REASON_CODES[Math.floor(r() * REASON_CODES.length)]!,
      filed_at: filed.toISOString(),
      expected_tat_hours: expected,
      actual_tat_hours: actual,
      status: statusOptions[Math.floor(r() * statusOptions.length)]!,
    });
  }

  return {
    tenant_id,
    as_of: asOf.toISOString(),
    totals: {
      claims_filed_30d,
      claims_closed_30d,
      open_investigations,
      fraud_flagged_pct,
      average_tat_hours,
    },
    abnormal_claim_patterns,
    flagged_hospitals,
    turnaround_anomalies,
  };
}

// ─── Underwriting Dashboard (T6 M11.2) ─────────────────────────────────

export interface HighRiskProposal {
  proposal_id: string;
  customer_id: string;
  product: string;
  premium_kes: number;
  uw_risk_band: 'critical' | 'high' | 'medium';
  risk_factors: string[];
}

export interface ChurnRow {
  month: string; // YYYY-MM
  policies_issued: number;
  policies_cancelled: number;
  policies_lapsed: number;
  net_change: number;
}

export interface LapsePrediction {
  policy_id: string;
  customer_id: string;
  product: string;
  lapse_probability_30d: number;
  premium_kes: number;
  driver: string;
}

export interface UnderwritingDashboard {
  tenant_id: string;
  as_of: string;
  totals: {
    proposals_30d: number;
    approved: number;
    declined: number;
    pending: number;
    average_decision_hours: number;
  };
  high_risk_proposals: HighRiskProposal[];
  churn_trend: ChurnRow[];
  lapse_predictions: LapsePrediction[];
}

const PRODUCTS = ['HOME_LOAN_LIFE', 'AUTO_COMP', 'HEALTH_FAMILY', 'TERM_LIFE_25Y', 'CRITICAL_ILLNESS'];
const RISK_FACTORS = [
  'pre_existing_condition_undisclosed',
  'occupation_high_risk',
  'sum_assured_above_band',
  'address_proxy_match',
  'recent_claim_history_third_party',
  'medical_underwriting_flagged',
];
const LAPSE_DRIVERS = [
  'premium_arrears_60d',
  'declining_inflows_90d',
  'policy_modification_recent',
  'claim_dispute_open',
  'engagement_drop',
];

export function buildUnderwritingDashboard(tenant_id: string, asOf: Date): UnderwritingDashboard {
  const dayKey = asOf.toISOString().slice(0, 10);
  const r = rng(seedFrom(tenant_id, dayKey, 'uw'));
  const scale = tenant_id === 'BIL' ? 0.6 : 1.0;

  const proposals_30d = Math.floor((480 + r() * 320) * scale);
  const approved = Math.floor(proposals_30d * (0.65 + r() * 0.12));
  const declined = Math.floor(proposals_30d * (0.05 + r() * 0.08));
  const pending = proposals_30d - approved - declined;
  const average_decision_hours = Math.round((26 + r() * 22) * 10) / 10;

  const high_risk_proposals: HighRiskProposal[] = [];
  const bands: HighRiskProposal['uw_risk_band'][] = ['critical', 'high', 'medium'];
  for (let i = 0; i < 8; i++) {
    const factorCount = 2 + Math.floor(r() * 2);
    const factors: string[] = [];
    for (let j = 0; j < factorCount; j++) {
      const f = RISK_FACTORS[Math.floor(r() * RISK_FACTORS.length)]!;
      if (!factors.includes(f)) factors.push(f);
    }
    high_risk_proposals.push({
      proposal_id: `PROP-${String(20000 + Math.floor(r() * 9999)).padStart(5, '0')}`,
      customer_id: `c-${String(Math.floor(r() * 9999)).padStart(4, '0')}`,
      product: PRODUCTS[Math.floor(r() * PRODUCTS.length)]!,
      premium_kes: Math.floor((25_000 + r() * 480_000) * scale),
      uw_risk_band: bands[Math.floor(r() * bands.length)]!,
      risk_factors: factors,
    });
  }

  // 6 months trailing churn trend.
  const churn_trend: ChurnRow[] = [];
  const start = new Date(asOf);
  for (let i = 5; i >= 0; i--) {
    const d = new Date(start);
    d.setMonth(d.getMonth() - i);
    const issued = Math.floor((360 + r() * 180) * scale);
    const cancelled = Math.floor((30 + r() * 60) * scale);
    const lapsed = Math.floor((20 + r() * 50) * scale);
    churn_trend.push({
      month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      policies_issued: issued,
      policies_cancelled: cancelled,
      policies_lapsed: lapsed,
      net_change: issued - cancelled - lapsed,
    });
  }

  const lapse_predictions: LapsePrediction[] = [];
  for (let i = 0; i < 10; i++) {
    const p = 0.45 + r() * 0.5;
    lapse_predictions.push({
      policy_id: `POL-${String(50000 + Math.floor(r() * 9999)).padStart(5, '0')}`,
      customer_id: `c-${String(Math.floor(r() * 9999)).padStart(4, '0')}`,
      product: PRODUCTS[Math.floor(r() * PRODUCTS.length)]!,
      lapse_probability_30d: Math.round(p * 1000) / 1000,
      premium_kes: Math.floor((8_000 + r() * 92_000) * scale),
      driver: LAPSE_DRIVERS[Math.floor(r() * LAPSE_DRIVERS.length)]!,
    });
  }
  // Highest probability first.
  lapse_predictions.sort((a, b) => b.lapse_probability_30d - a.lapse_probability_30d);

  return {
    tenant_id,
    as_of: asOf.toISOString(),
    totals: { proposals_30d, approved, declined, pending, average_decision_hours },
    high_risk_proposals,
    churn_trend,
    lapse_predictions,
  };
}

// ─── Agent Dashboard (T6 M11.3) ────────────────────────────────────────

export interface AgentLeaderboardRow {
  agent_id: string;
  agent_name: string;
  branch: string;
  policies_30d: number;
  premium_kes: number;
  rank: number;
}

export interface AgentRiskContribution {
  agent_id: string;
  agent_name: string;
  portfolio_size: number;
  claim_payout_ratio: number;
  high_risk_share: number;
  risk_score: number;
}

export interface CancellationCluster {
  cluster_id: string;
  branch: string;
  product: string;
  agent_count: number;
  cancellation_rate: number;
  total_premium_at_risk_kes: number;
}

export interface AgentDashboard {
  tenant_id: string;
  as_of: string;
  totals: {
    active_agents: number;
    new_agents_30d: number;
    suspended_agents: number;
    average_payout_ratio: number;
    average_lapse_ratio: number;
  };
  agent_leaderboard: AgentLeaderboardRow[];
  risk_contribution: AgentRiskContribution[];
  cancellation_clusters: CancellationCluster[];
}

const BRANCHES = ['NBO_CBD', 'NBO_WEST', 'MOMBASA', 'KISUMU', 'NAKURU', 'ELDORET'];
const FIRST_NAMES = ['Achieng', 'Brian', 'Carol', 'Dennis', 'Esther', 'Frank', 'Grace', 'Hassan', 'Imani', 'James'];
const LAST_NAMES = ['Otieno', 'Mwangi', 'Wanjiru', 'Kamau', 'Achieng', 'Mutua', 'Kariuki', 'Onyango', 'Njoroge', 'Cheruiyot'];

function syntheticName(r: () => number): string {
  return `${FIRST_NAMES[Math.floor(r() * FIRST_NAMES.length)]} ${LAST_NAMES[Math.floor(r() * LAST_NAMES.length)]}`;
}

export function buildAgentDashboard(tenant_id: string, asOf: Date): AgentDashboard {
  const dayKey = asOf.toISOString().slice(0, 10);
  const r = rng(seedFrom(tenant_id, dayKey, 'agent'));
  const scale = tenant_id === 'BIL' ? 0.6 : 1.0;

  const active_agents = Math.floor((120 + r() * 80) * scale);
  const new_agents_30d = Math.floor((4 + r() * 12) * scale);
  const suspended_agents = Math.floor((1 + r() * 4) * scale);
  const average_payout_ratio = Math.round((0.55 + r() * 0.25) * 1000) / 1000;
  const average_lapse_ratio = Math.round((0.06 + r() * 0.08) * 1000) / 1000;

  const agent_leaderboard: AgentLeaderboardRow[] = [];
  for (let i = 0; i < 8; i++) {
    agent_leaderboard.push({
      agent_id: `AGT-${String(1000 + Math.floor(r() * 8999)).padStart(4, '0')}`,
      agent_name: syntheticName(r),
      branch: BRANCHES[Math.floor(r() * BRANCHES.length)]!,
      policies_30d: Math.floor((40 - i * 3 + r() * 6) * scale),
      premium_kes: Math.floor((4_500_000 - i * 350_000 + r() * 800_000) * scale),
      rank: i + 1,
    });
  }

  const risk_contribution: AgentRiskContribution[] = [];
  for (let i = 0; i < 6; i++) {
    const pr = 0.7 + i * 0.05 + r() * 0.18;
    risk_contribution.push({
      agent_id: `AGT-${String(2000 + Math.floor(r() * 8999)).padStart(4, '0')}`,
      agent_name: syntheticName(r),
      portfolio_size: Math.floor((180 - i * 18 + r() * 24) * scale),
      claim_payout_ratio: Math.round(pr * 1000) / 1000,
      high_risk_share: Math.round((0.15 + i * 0.05 + r() * 0.1) * 1000) / 1000,
      risk_score: Math.round((0.6 + i * 0.06 + r() * 0.12) * 100) / 100,
    });
  }
  // Highest risk first.
  risk_contribution.sort((a, b) => b.risk_score - a.risk_score);

  const cancellation_clusters: CancellationCluster[] = [];
  for (let i = 0; i < 4; i++) {
    cancellation_clusters.push({
      cluster_id: `CLU-${String(i + 1).padStart(3, '0')}`,
      branch: BRANCHES[Math.floor(r() * BRANCHES.length)]!,
      product: PRODUCTS[Math.floor(r() * PRODUCTS.length)]!,
      agent_count: 2 + Math.floor(r() * 5),
      cancellation_rate: Math.round((0.18 + r() * 0.22) * 1000) / 1000,
      total_premium_at_risk_kes: Math.floor((3_500_000 + r() * 9_000_000) * scale),
    });
  }

  return {
    tenant_id,
    as_of: asOf.toISOString(),
    totals: {
      active_agents,
      new_agents_30d,
      suspended_agents,
      average_payout_ratio,
      average_lapse_ratio,
    },
    agent_leaderboard,
    risk_contribution,
    cancellation_clusters,
  };
}

// ─── Operational Dashboard (T6 M11.4) ──────────────────────────────────

export interface UwDelayBreakdown {
  branch: string;
  underwriter_id: string;
  underwriter_name: string;
  pending_count: number;
  avg_delay_hours: number;
  p95_delay_hours: number;
}

export interface LoginAnomaly {
  occurred_at: string;
  username: string;
  ip: string;
  reason: 'geo_velocity' | 'device_change' | 'after_hours_admin' | 'failed_attempts_spike';
  severity: 'critical' | 'high' | 'medium';
}

export interface OverrideEntry {
  ts: string;
  manager: string;
  resource_type: 'underwriting' | 'claim' | 'payout' | 'kyc';
  resource_id: string;
  reason: string;
}

export interface OperationalDashboard {
  tenant_id: string;
  as_of: string;
  totals: {
    pending_underwriting: number;
    average_uw_delay_hours: number;
    suspicious_logins_30d: number;
    overrides_30d: number;
    data_modifications_anomalous_7d: number;
  };
  uw_delay_breakdown: UwDelayBreakdown[];
  login_anomalies: LoginAnomaly[];
  override_log: OverrideEntry[];
}

const LOGIN_REASONS: LoginAnomaly['reason'][] = [
  'geo_velocity',
  'device_change',
  'after_hours_admin',
  'failed_attempts_spike',
];
const RESOURCE_TYPES: OverrideEntry['resource_type'][] = [
  'underwriting',
  'claim',
  'payout',
  'kyc',
];
const OVERRIDE_REASONS = [
  'customer_VIP_relationship',
  'documentation_provided_offline',
  'compliance_review_clear',
  'sales_team_escalation',
  'reciprocity_with_partner',
];

export function buildOperationalDashboard(tenant_id: string, asOf: Date): OperationalDashboard {
  const dayKey = asOf.toISOString().slice(0, 10);
  const r = rng(seedFrom(tenant_id, dayKey, 'ops'));
  const scale = tenant_id === 'BIL' ? 0.6 : 1.0;

  const pending_underwriting = Math.floor((40 + r() * 120) * scale);
  const average_uw_delay_hours = Math.round((28 + r() * 24) * 10) / 10;
  const suspicious_logins_30d = Math.floor((6 + r() * 18) * scale);
  const overrides_30d = Math.floor((10 + r() * 22) * scale);
  const data_modifications_anomalous_7d = Math.floor((2 + r() * 8) * scale);

  const uw_delay_breakdown: UwDelayBreakdown[] = [];
  for (let i = 0; i < 5; i++) {
    const avg = 18 + r() * 36;
    uw_delay_breakdown.push({
      branch: BRANCHES[Math.floor(r() * BRANCHES.length)]!,
      underwriter_id: `UW-${String(100 + Math.floor(r() * 899)).padStart(3, '0')}`,
      underwriter_name: syntheticName(r),
      pending_count: Math.floor((4 + r() * 16) * scale),
      avg_delay_hours: Math.round(avg * 10) / 10,
      p95_delay_hours: Math.round((avg + 18 + r() * 24) * 10) / 10,
    });
  }
  uw_delay_breakdown.sort((a, b) => b.p95_delay_hours - a.p95_delay_hours);

  const login_anomalies: LoginAnomaly[] = [];
  for (let i = 0; i < 7; i++) {
    const ts = new Date(asOf);
    ts.setHours(ts.getHours() - Math.floor(r() * 168)); // last 7 days
    const sevs: LoginAnomaly['severity'][] = ['critical', 'high', 'medium'];
    login_anomalies.push({
      occurred_at: ts.toISOString(),
      username: `${FIRST_NAMES[Math.floor(r() * FIRST_NAMES.length)]!.toLowerCase()}.${
        ['admin', 'risk', 'super', 'collect', 'field'][Math.floor(r() * 5)]
      }`,
      ip: `41.${Math.floor(r() * 256)}.${Math.floor(r() * 256)}.${Math.floor(r() * 256)}`,
      reason: LOGIN_REASONS[Math.floor(r() * LOGIN_REASONS.length)]!,
      severity: sevs[Math.floor(r() * sevs.length)]!,
    });
  }
  login_anomalies.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));

  const override_log: OverrideEntry[] = [];
  for (let i = 0; i < 8; i++) {
    const ts = new Date(asOf);
    ts.setHours(ts.getHours() - Math.floor(r() * 720)); // last 30 days
    override_log.push({
      ts: ts.toISOString(),
      manager: syntheticName(r),
      resource_type: RESOURCE_TYPES[Math.floor(r() * RESOURCE_TYPES.length)]!,
      resource_id: `RES-${String(Math.floor(r() * 99999)).padStart(5, '0')}`,
      reason: OVERRIDE_REASONS[Math.floor(r() * OVERRIDE_REASONS.length)]!,
    });
  }
  override_log.sort((a, b) => (a.ts < b.ts ? 1 : -1));

  return {
    tenant_id,
    as_of: asOf.toISOString(),
    totals: {
      pending_underwriting,
      average_uw_delay_hours,
      suspicious_logins_30d,
      overrides_30d,
      data_modifications_anomalous_7d,
    },
    uw_delay_breakdown,
    login_anomalies,
    override_log,
  };
}
