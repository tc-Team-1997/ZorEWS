/**
 * Insurance AI Agents Engine — Claims + Fraud + Policy Retention + Solvency.
 * Pure-function. Deterministic via FNV-1a + Mulberry32. Phase 18 overlay.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dayKey(d: Date): string { return d.toISOString().slice(0, 10); }
function round(v: number, dec = 0): number { return Math.round(v * Math.pow(10, dec)) / Math.pow(10, dec); }
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }
function pick<T>(arr: T[], rng: () => number): T { return arr[Math.floor(rng() * arr.length)]; }

// ─── 1. Claims Agent ───────────────────────────────────────────────────────────

export interface ClaimsAgentReport {
  generated_at: string;
  total_claims_under_review: number;
  suspicious_claims_count: number;
  fast_track_eligible: number;
  complex_investigation_needed: number;
  claims_amount_at_risk_cr: number;
  avg_processing_days: number;
  sla_breach_count: number;
  confidence_score: number;
  top_suspicious_claims: Array<{
    claim_id: string;
    policy_id: string;
    claim_type: string;
    amount_cr: number;
    suspicion_reasons: string[];
    recommended_action: string;
    risk_level: string;
  }>;
  key_findings: string[];
  recommended_actions: string[];
}

const CLAIM_TYPES = ['health', 'motor', 'life', 'property', 'travel', 'marine'];
const SUSPICION_REASONS = [
  'Multiple claims within 90 days',
  'Claim filed shortly after policy inception',
  'Inconsistent medical records',
  'Provider flagged for collusion history',
  'Claim amount exceeds policy limit pattern',
  'Geographic anomaly in incident location',
  'Unusual claim frequency vs peer group',
  'Documentation irregularities detected',
  'Claimant linked to prior fraud network',
  'Rapid policy upgrade before claim',
];
const CLAIM_ACTIONS = ['Fast-track settlement', 'Desk review required', 'Field investigation', 'SIU referral', 'Legal review'];
const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];

export function buildClaimsAgentReport(tenant: string, asOf: Date): ClaimsAgentReport {
  const rng = mulberry32(fnv1a(`claims-${tenant}-${dayKey(asOf)}`));

  const total = round(2500 + rng() * 5500);
  const suspicious = round(80 + rng() * 320);
  const fast_track = round(total * (0.35 + rng() * 0.25));
  const complex = round(suspicious * (0.3 + rng() * 0.4));
  const amount_at_risk = round(suspicious * (0.08 + rng() * 0.15), 2);
  const avg_days = round(8 + rng() * 22, 1);
  const sla_breach = round(suspicious * (0.05 + rng() * 0.15));
  const confidence = round(0.80 + rng() * 0.15, 2);

  const top_suspicious_claims = Array.from({ length: 5 }, (_, i) => {
    const claimRng = mulberry32(fnv1a(`claim-item-${tenant}-${i}-${dayKey(asOf)}`));
    const numReasons = 2 + Math.floor(claimRng() * 3);
    const reasons: string[] = [];
    const usedIdx = new Set<number>();
    while (reasons.length < numReasons) {
      const idx = Math.floor(claimRng() * SUSPICION_REASONS.length);
      if (!usedIdx.has(idx)) { usedIdx.add(idx); reasons.push(SUSPICION_REASONS[idx]); }
    }
    const rl = pick(RISK_LEVELS, claimRng);
    return {
      claim_id: `CLM-${tenant.slice(0, 3).toUpperCase()}-${100000 + Math.floor(claimRng() * 899999)}`,
      policy_id: `POL-${tenant.slice(0, 3).toUpperCase()}-${200000 + Math.floor(claimRng() * 799999)}`,
      claim_type: pick(CLAIM_TYPES, claimRng),
      amount_cr: round(0.5 + claimRng() * 24.5, 2),
      suspicion_reasons: reasons,
      recommended_action: pick(CLAIM_ACTIONS, claimRng),
      risk_level: rl,
    };
  });

  return {
    generated_at: asOf.toISOString(),
    total_claims_under_review: total,
    suspicious_claims_count: suspicious,
    fast_track_eligible: fast_track,
    complex_investigation_needed: complex,
    claims_amount_at_risk_cr: amount_at_risk,
    avg_processing_days: avg_days,
    sla_breach_count: sla_breach,
    confidence_score: confidence,
    top_suspicious_claims,
    key_findings: [
      `${suspicious} claims flagged as suspicious out of ${total} under review — ${round((suspicious / total) * 100, 1)}% flag rate`,
      `Claims amount at risk: ₹${amount_at_risk} Cr across suspicious pool`,
      `Average claim processing time is ${avg_days} days; ${sla_breach} claims in SLA breach`,
      `${complex} claims require complex investigation beyond standard desk review`,
      `${fast_track} low-risk claims eligible for immediate fast-track settlement`,
    ],
    recommended_actions: [
      'Deploy AI-assisted triage to reduce avg processing time below 15 days',
      'Escalate top 5 suspicious claims to SIU for field investigation',
      'Fast-track approve the low-risk cohort to improve customer NPS',
      'Review SLA breach cases with operations lead within 48 hours',
      'Update provider blacklist with newly identified collusion signals',
    ],
  };
}

// ─── 2. Insurance Fraud Agent ──────────────────────────────────────────────────

export interface InsuranceFraudAgentReport {
  generated_at: string;
  organized_fraud_rings_detected: number;
  provider_collusion_cases: number;
  identity_fraud_cases: number;
  total_fraud_amount_at_risk_cr: number;
  auto_rejected_claims: number;
  investigation_queue: number;
  siu_capacity_pct: number;
  confidence_score: number;
  fraud_patterns: Array<{
    pattern_name: string;
    instances: number;
    loss_estimate_cr: number;
    detection_method: string;
    risk_level: string;
  }>;
  key_findings: string[];
  immediate_actions: string[];
}

const FRAUD_PATTERNS = [
  { name: 'Staged accident networks', method: 'Graph anomaly detection' },
  { name: 'Ghost provider billing', method: 'Provider network analysis' },
  { name: 'Identity recycling — synthetic policies', method: 'Document forensics AI' },
  { name: 'Premium manipulation via broker collusion', method: 'Transaction pattern analysis' },
  { name: 'Exaggerated disability claims', method: 'Medical record NLP scan' },
  { name: 'Backdating policy inception', method: 'Timestamp integrity check' },
  { name: 'Multiple claim submissions — same incident', method: 'Duplicate detection engine' },
];

export function buildInsuranceFraudReport(tenant: string, asOf: Date): InsuranceFraudAgentReport {
  const rng = mulberry32(fnv1a(`ins-fraud-${tenant}-${dayKey(asOf)}`));

  const rings = round(3 + rng() * 9);
  const collusion = round(5 + rng() * 25);
  const identity = round(12 + rng() * 48);
  const amount_at_risk = round(rings * (8 + rng() * 20) + collusion * (2 + rng() * 8) + identity * (0.5 + rng() * 3), 2);
  const auto_rejected = round(200 + rng() * 800);
  const inv_queue = round(rings * 8 + collusion + identity * 0.5);
  const siu_capacity = round(65 + rng() * 27, 1);
  const confidence = round(0.82 + rng() * 0.13, 2);

  const numPatterns = 4 + Math.floor(rng() * 3);
  const shuffled = [...FRAUD_PATTERNS].sort(() => rng() - 0.5).slice(0, numPatterns);
  const fraud_patterns = shuffled.map((p, i) => {
    const pRng = mulberry32(fnv1a(`fp-${tenant}-${i}-${dayKey(asOf)}`));
    return {
      pattern_name: p.name,
      instances: round(2 + pRng() * 28),
      loss_estimate_cr: round(1 + pRng() * 45, 2),
      detection_method: p.method,
      risk_level: pick(['high', 'critical', 'medium', 'high', 'critical'], pRng),
    };
  });

  return {
    generated_at: asOf.toISOString(),
    organized_fraud_rings_detected: rings,
    provider_collusion_cases: collusion,
    identity_fraud_cases: identity,
    total_fraud_amount_at_risk_cr: amount_at_risk,
    auto_rejected_claims: auto_rejected,
    investigation_queue: inv_queue,
    siu_capacity_pct: siu_capacity,
    confidence_score: confidence,
    fraud_patterns,
    key_findings: [
      `${rings} organized fraud rings detected — ${rings > 8 ? 'ALERT: above normal threshold' : 'within manageable range'}`,
      `${collusion} provider collusion cases identified; estimated loss ₹${round(collusion * 3.5, 1)} Cr`,
      `${identity} identity fraud cases in pipeline; synthetic identity detection model active`,
      `Total fraud amount at risk: ₹${amount_at_risk} Cr across all fraud typologies`,
      `SIU operating at ${siu_capacity}% capacity — ${siu_capacity > 85 ? 'near saturation, escalate staffing' : 'manageable load'}`,
      `${auto_rejected} claims auto-rejected by AI fraud engine in current cycle`,
    ],
    immediate_actions: [
      `Coordinate with law enforcement on ${rings > 6 ? 'top 3' : 'top ' + Math.min(rings, 2)} fraud ring investigations`,
      'Issue provider suspension notices for confirmed collusion cases within 72 hours',
      'Escalate identity fraud cases to IRDAI fraud monitoring cell',
      siu_capacity > 85 ? 'Approve emergency SIU capacity expansion — hire 3 additional investigators' : 'Maintain current SIU staffing levels',
      'Deploy updated ML fraud scoring model — v2.3 ready for production push',
    ],
  };
}

// ─── 3. Policy Retention Agent ─────────────────────────────────────────────────

export interface PolicyRetentionAgentReport {
  generated_at: string;
  policies_at_lapse_risk: number;
  high_risk_policies: number;
  total_premium_at_risk_cr: number;
  predicted_lapse_rate_30d: number;
  persistency_13m: number;
  confidence_score: number;
  lapse_triggers: Array<{
    trigger: string;
    policy_count: number;
    premium_cr: number;
    recommended_intervention: string;
  }>;
  retention_campaign_opportunities: Array<{
    segment: string;
    policies: number;
    action: string;
    potential_save_cr: number;
  }>;
  key_findings: string[];
  retention_actions: string[];
}

const LAPSE_TRIGGERS = [
  { trigger: 'Premium due date missed >15 days', intervention: 'Immediate agent outreach + payment link' },
  { trigger: 'Customer financial stress signal', intervention: 'Offer premium holiday or flexible pay plan' },
  { trigger: 'Agent attrition — orphan policy', intervention: 'Re-assign to active agent within 7 days' },
  { trigger: 'Policy anniversary without review', intervention: 'Trigger annual review meeting via WhatsApp' },
  { trigger: 'Low engagement — no claims, no logins', intervention: 'Re-engagement campaign with product benefits reminder' },
  { trigger: 'Competitive offer received (NLP signal)', intervention: 'Counter-offer with loyalty bonus or benefit enhancement' },
];

const RETENTION_SEGMENTS = [
  { segment: 'Young Urban Professionals (25-35)', action: 'Digital nudge + loyalty reward' },
  { segment: 'High Net Worth Individuals', action: 'Dedicated RM outreach + enhanced coverage review' },
  { segment: 'SME Group Policy Holders', action: 'Group renewal incentive + admin support' },
  { segment: 'Rural Micro-Insurance Holders', action: 'Regional language SMS + agent visit' },
  { segment: 'Senior Citizens (60+)', action: 'Family helpline + health benefit reminder' },
];

export function buildPolicyRetentionReport(tenant: string, asOf: Date): PolicyRetentionAgentReport {
  const rng = mulberry32(fnv1a(`retention-${tenant}-${dayKey(asOf)}`));

  const at_risk = round(5000 + rng() * 13000);
  const high_risk = round(at_risk * (0.18 + rng() * 0.22));
  const premium_at_risk = round(at_risk * (0.004 + rng() * 0.008), 2);
  const lapse_rate_30d = round(0.025 + rng() * 0.055, 4);
  const persistency = round(clamp(78 + rng() * 9, 78, 87), 1);
  const confidence = round(0.84 + rng() * 0.11, 2);

  const lapse_triggers = LAPSE_TRIGGERS.slice(0, 5).map((lt, i) => {
    const tRng = mulberry32(fnv1a(`lt-${tenant}-${i}-${dayKey(asOf)}`));
    const pct = 0.08 + tRng() * 0.22;
    const count = round(at_risk * pct);
    return {
      trigger: lt.trigger,
      policy_count: count,
      premium_cr: round(count * (0.003 + tRng() * 0.007), 2),
      recommended_intervention: lt.intervention,
    };
  });

  const retention_campaign_opportunities = RETENTION_SEGMENTS.slice(0, 4).map((seg, i) => {
    const sRng = mulberry32(fnv1a(`seg-${tenant}-${i}-${dayKey(asOf)}`));
    const policies = round(300 + sRng() * 2200);
    return {
      segment: seg.segment,
      policies,
      action: seg.action,
      potential_save_cr: round(policies * (0.003 + sRng() * 0.008), 2),
    };
  });

  return {
    generated_at: asOf.toISOString(),
    policies_at_lapse_risk: at_risk,
    high_risk_policies: high_risk,
    total_premium_at_risk_cr: premium_at_risk,
    predicted_lapse_rate_30d: lapse_rate_30d,
    persistency_13m: persistency,
    confidence_score: confidence,
    lapse_triggers,
    retention_campaign_opportunities,
    key_findings: [
      `${at_risk.toLocaleString()} policies at lapse risk — ${high_risk.toLocaleString()} classified as high-risk`,
      `₹${premium_at_risk} Cr in annual premium at risk of lapsation within 30 days`,
      `13-month persistency at ${persistency}% — ${persistency < 82 ? 'below target of 82%; intervention required' : 'within acceptable range'}`,
      `Predicted 30-day lapse rate: ${round(lapse_rate_30d * 100, 2)}%`,
      `${lapse_triggers[0].policy_count} policies with missed premium payments — top lapse trigger`,
    ],
    retention_actions: [
      'Launch automated WhatsApp + SMS reminder campaign for payment-overdue segment',
      'Deploy retention-specialist team to high-risk HNI policies immediately',
      `Priority: contact ${high_risk} high-risk policyholders within 5 business days`,
      'Offer premium payment flexibility to customers showing financial stress signals',
      'Activate loyalty reward program for policies completing 3+ year anniversaries',
    ],
  };
}

// ─── 4. Solvency Agent ─────────────────────────────────────────────────────────

export interface SolvencyAgentReport {
  generated_at: string;
  current_solvency_ratio: number;
  required_ratio: number;
  margin_pp: number;
  solvency_trend_90d: number;
  capital_adequacy_status: 'adequate' | 'watch' | 'breach_risk';
  regulatory_breach_predicted: boolean;
  days_to_potential_breach: number | null;
  confidence_score: number;
  stress_scenarios: Array<{
    scenario: string;
    projected_solvency: number;
    breach_probability_pct: number;
    risk_level: string;
  }>;
  key_findings: string[];
  capital_actions: string[];
}

const STRESS_SCENARIOS = [
  { scenario: 'RBI Base Rate +250 bps', delta: -18 },
  { scenario: 'Catastrophic CAT event — ₹500 Cr loss', delta: -32 },
  { scenario: 'Equity market -35% correction', delta: -22 },
  { scenario: 'Mass lapse event — 20% policy surrender', delta: -15 },
  { scenario: 'IRDAI Severely Adverse Composite Shock', delta: -45 },
];

function deriveCapitalStatus(ratio: number, required: number): 'adequate' | 'watch' | 'breach_risk' {
  const margin = ratio - required;
  if (margin >= 30) return 'adequate';
  if (margin >= 10) return 'watch';
  return 'breach_risk';
}

export function buildSolvencyReport(tenant: string, asOf: Date): SolvencyAgentReport {
  const rng = mulberry32(fnv1a(`solvency-${tenant}-${dayKey(asOf)}`));

  const current_ratio = round(165 + rng() * 30, 1);
  const required_ratio = 150;
  const margin_pp = round(current_ratio - required_ratio, 1);
  const trend_90d = round((rng() > 0.45 ? 1 : -1) * (0.5 + rng() * 8), 1);
  const status = deriveCapitalStatus(current_ratio, required_ratio);
  const breach_predicted = status === 'breach_risk';
  const days_to_breach = breach_predicted
    ? round(15 + rng() * 60)
    : status === 'watch' ? round(90 + rng() * 120) : null;
  const confidence = round(0.86 + rng() * 0.10, 2);

  const stress_scenarios = STRESS_SCENARIOS.map((s, i) => {
    const sRng = mulberry32(fnv1a(`sol-stress-${tenant}-${i}-${dayKey(asOf)}`));
    const projected = round(current_ratio + s.delta * (0.85 + sRng() * 0.3), 1);
    const breach_prob = projected < required_ratio
      ? round(60 + sRng() * 35, 1)
      : round(sRng() * 25, 1);
    const rl = projected < required_ratio ? 'critical' : projected < required_ratio + 15 ? 'high' : 'medium';
    return {
      scenario: s.scenario,
      projected_solvency: projected,
      breach_probability_pct: breach_prob,
      risk_level: rl,
    };
  });

  const findings: string[] = [
    `Current solvency ratio: ${current_ratio}% vs IRDAI minimum of ${required_ratio}% — margin of ${margin_pp} pp`,
    `90-day trend: ${trend_90d > 0 ? '+' : ''}${trend_90d} pp — ${trend_90d < -3 ? 'deteriorating trend, requires monitoring' : 'stable'}`,
    `Capital adequacy status: ${status.toUpperCase().replace('_', ' ')}`,
  ];
  if (breach_predicted) {
    findings.push(`ALERT: Breach predicted within ${days_to_breach} days — immediate capital action required`);
  } else if (days_to_breach) {
    findings.push(`Potential breach in ${days_to_breach} days under current trend — proactive monitoring advised`);
  }
  const criticalStress = stress_scenarios.filter(s => s.risk_level === 'critical');
  if (criticalStress.length > 0) {
    findings.push(`${criticalStress.length} stress scenario(s) project solvency breach — most severe: ${criticalStress[0].scenario}`);
  }

  const actions: string[] = [];
  if (status === 'breach_risk') {
    actions.push('URGENT: Convene Capital Management Committee within 24 hours');
    actions.push('Initiate emergency capital raise — target ₹200 Cr tier-1 infusion');
    actions.push('Notify IRDAI Solvency Monitoring Cell per regulatory obligation');
  } else if (status === 'watch') {
    actions.push('Schedule Capital Management Committee review within 5 business days');
    actions.push('Evaluate reinsurance opportunities to reduce capital strain');
    actions.push('Pause new high-risk product launches pending capital stabilisation');
  } else {
    actions.push('Maintain current capital deployment strategy — ratio comfortable');
    actions.push('Conduct quarterly ORSA review aligned to IRDAI circular timeline');
  }
  actions.push('Update internal capital model with latest CAT loss estimates');
  actions.push('Review investment portfolio duration mismatch vs liability profile');

  return {
    generated_at: asOf.toISOString(),
    current_solvency_ratio: current_ratio,
    required_ratio,
    margin_pp,
    solvency_trend_90d: trend_90d,
    capital_adequacy_status: status,
    regulatory_breach_predicted: breach_predicted,
    days_to_potential_breach: days_to_breach,
    confidence_score: confidence,
    stress_scenarios,
    key_findings: findings,
    capital_actions: actions,
  };
}

// ─── 5. Insurance Agents Summary ──────────────────────────────────────────────

export interface InsuranceAgentsSummary {
  generated_at: string;
  tenant: string;
  overall_risk_level: 'low' | 'medium' | 'high' | 'critical';
  claims: ClaimsAgentReport;
  fraud: InsuranceFraudAgentReport;
  retention: PolicyRetentionAgentReport;
  solvency: SolvencyAgentReport;
  cross_cutting_insights: string[];
  priority_actions: Array<{
    priority: number;
    domain: string;
    action: string;
    urgency: 'immediate' | '48h' | '1week' | 'quarterly';
  }>;
}

function deriveOverallRisk(
  claims: ClaimsAgentReport,
  fraud: InsuranceFraudAgentReport,
  retention: PolicyRetentionAgentReport,
  solvency: SolvencyAgentReport,
): 'low' | 'medium' | 'high' | 'critical' {
  if (
    solvency.capital_adequacy_status === 'breach_risk' ||
    fraud.organized_fraud_rings_detected > 10 ||
    (retention.predicted_lapse_rate_30d > 0.07 && solvency.capital_adequacy_status === 'watch')
  ) return 'critical';
  if (
    solvency.capital_adequacy_status === 'watch' ||
    fraud.organized_fraud_rings_detected > 7 ||
    retention.predicted_lapse_rate_30d > 0.06 ||
    (claims.suspicious_claims_count / claims.total_claims_under_review) > 0.08
  ) return 'high';
  if (
    fraud.siu_capacity_pct > 85 ||
    retention.persistency_13m < 80 ||
    claims.sla_breach_count > claims.suspicious_claims_count * 0.1
  ) return 'medium';
  return 'low';
}

export function buildInsuranceAgentsSummary(tenant: string, asOf: Date): InsuranceAgentsSummary {
  const claims = buildClaimsAgentReport(tenant, asOf);
  const fraud = buildInsuranceFraudReport(tenant, asOf);
  const retention = buildPolicyRetentionReport(tenant, asOf);
  const solvency = buildSolvencyReport(tenant, asOf);
  const overall_risk_level = deriveOverallRisk(claims, fraud, retention, solvency);

  const cross_cutting_insights: string[] = [
    `Fraud ring activity (${fraud.organized_fraud_rings_detected} rings) correlates with elevated claims suspicion rate — joint SIU + Claims review recommended`,
    `Persistency at ${retention.persistency_13m}% compounds capital pressure — lapsed policy reserves must be re-estimated in ORSA`,
    `Solvency margin of ${solvency.margin_pp} pp under concurrent stress (CAT + market) could breach IRDAI minimum — scenario correlation analysis critical`,
    `${claims.fast_track_eligible.toLocaleString()} fast-track eligible claims represent quick-win NPS improvement without additional capital strain`,
    `AI model confidence scores (avg ${round((claims.confidence_score + fraud.confidence_score + retention.confidence_score + solvency.confidence_score) / 4, 2)}) suggest high signal reliability — decision automation expansion viable`,
  ];

  const priority_actions: InsuranceAgentsSummary['priority_actions'] = [];

  if (solvency.capital_adequacy_status !== 'adequate') {
    priority_actions.push({ priority: 1, domain: 'Solvency', action: solvency.capital_actions[0], urgency: 'immediate' });
  }
  if (fraud.organized_fraud_rings_detected > 6) {
    priority_actions.push({ priority: 2, domain: 'Fraud', action: fraud.immediate_actions[0], urgency: 'immediate' });
  }
  priority_actions.push({ priority: 3, domain: 'Claims', action: claims.recommended_actions[0], urgency: '48h' });
  priority_actions.push({ priority: 4, domain: 'Retention', action: retention.retention_actions[0], urgency: '48h' });
  priority_actions.push({ priority: 5, domain: 'Fraud', action: fraud.immediate_actions[4], urgency: '1week' });
  priority_actions.push({ priority: 6, domain: 'Solvency', action: 'Conduct quarterly ORSA including cross-domain stress correlation', urgency: 'quarterly' });

  return {
    generated_at: asOf.toISOString(),
    tenant,
    overall_risk_level,
    claims,
    fraud,
    retention,
    solvency,
    cross_cutting_insights,
    priority_actions,
  };
}
