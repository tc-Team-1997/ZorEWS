// services/bff/src/insurance_policy_timeline.ts
//
// Insurance EWS — Module 9: Policy Timeline.
//
// A per-policy chronological RISK + LIFECYCLE event stream — premium history,
// claims, alerts, anomaly flags, underwriting events, retention actions, lapse
// warnings, reinstatements and surrenders — assembled into one view for the
// retention / SIU analyst. This is the insurance analog of the banking
// Borrower Timeline (banking_borrower_timeline.ts); distinct from the CMS
// case timelines (single-case state ladder).
//
// Surface:
//   GET /v1/insurance/policies/:policy_id/timeline?event_type=&since=&limit=
//
// The timeline is TOTAL over policies: any non-empty policy_id yields a
// deterministic populated lifecycle (FNV-1a + Mulberry32 per (tenant, policy))
// — matching the drill-through pattern (the analyst always arrives with a real
// policy id from the lapse / claims / fraud lists). Builder bodies swap to
// app_insurance.policy_timelines when the insurer's feeds land; the response
// shape stays frozen.

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

export type PolicyEventType =
  | 'policy_issued'
  | 'premium_paid'
  | 'premium_missed'
  | 'grace_period'
  | 'renewal'
  | 'claim_filed'
  | 'claim_settled'
  | 'claim_rejected'
  | 'anomaly_flagged'
  | 'alert_raised'
  | 'underwriting_event'
  | 'retention_action'
  | 'lapse_warning'
  | 'reinstatement'
  | 'surrender';

export const ALL_POLICY_EVENT_TYPES: readonly PolicyEventType[] = [
  'policy_issued',
  'premium_paid',
  'premium_missed',
  'grace_period',
  'renewal',
  'claim_filed',
  'claim_settled',
  'claim_rejected',
  'anomaly_flagged',
  'alert_raised',
  'underwriting_event',
  'retention_action',
  'lapse_warning',
  'reinstatement',
  'surrender',
];

export type PolicyEventSeverity = 'info' | 'warning' | 'critical';
export const ALL_POLICY_EVENT_SEVERITIES: readonly PolicyEventSeverity[] = ['info', 'warning', 'critical'];

export type PolicyStatus = 'in_force' | 'lapsed' | 'surrendered' | 'matured';
export type LapseRiskBand = 'low' | 'medium' | 'high' | 'critical';
export type PersistencyTrajectory = 'improving' | 'stable' | 'deteriorating';

export interface PolicyEvent {
  event_id: string;
  occurred_at: string; // ISO
  event_type: PolicyEventType;
  severity: PolicyEventSeverity;
  title: string;
  description: string;
  linked_ref: string | null; // claim_id / alert_id / siu_case_id when applicable
  metadata: Record<string, string | number>;
}

export interface PolicyTimeline {
  tenant_id: string;
  policy_id: string;
  policyholder_name: string;
  product: string;
  channel: string;
  generated_at: string;
  policy_status: PolicyStatus;
  lapse_risk_band: LapseRiskBand;
  persistency_trajectory: PersistencyTrajectory;
  total_premium_paid_kes: number;
  claims_filed: number;
  claims_settled: number;
  peak_anomaly_score: number; // 0..1
  total_events: number;
  returned_count: number;
  by_type: Record<PolicyEventType, number>;
  by_severity: Record<PolicyEventSeverity, number>;
  first_event_at: string | null;
  last_event_at: string | null;
  filters_applied: { event_type: PolicyEventType | null; since: string | null; limit: number };
  events: PolicyEvent[]; // newest-first (already filtered)
}

export class PolicyTimelineError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PolicyTimelineError';
  }
}

const FIRST = ['Asha', 'Ravi', 'Priya', 'Mohan', 'Vikram', 'Meera', 'Arjun', 'Kavya', 'Sunil', 'Deepa'];
const LAST = ['Patel', 'Kumar', 'Sharma', 'Singh', 'Reddy', 'Nair', 'Iyer', 'Bose'];
const PRODUCTS = ['Term Life', 'Endowment', 'ULIP', 'Health Indemnity', 'Critical Illness', 'Money-Back'];
const CHANNELS = ['Agency', 'Bancassurance', 'Broker', 'Direct', 'Corporate'];

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DAY_MS = 86_400_000;

function lapseBand(score: number): LapseRiskBand {
  if (score >= 0.75) return 'critical';
  if (score >= 0.5) return 'high';
  if (score >= 0.25) return 'medium';
  return 'low';
}

// Build the policy's full coherent lifecycle (chronological; the public
// builder returns newest-first).
function buildFullLifecycle(
  tenant_id: string,
  policy_id: string,
  now: Date,
): { events: PolicyEvent[]; status: PolicyStatus; peakAnomaly: number; premiumPaid: number; claimsFiled: number; claimsSettled: number; lapseScore: number } {
  const rng = mulberry32(fnv1a(`${tenant_id}|${policy_id}|timeline`));
  const events: PolicyEvent[] = [];
  let seq = 0;
  const mk = (
    daysAgo: number,
    event_type: PolicyEventType,
    severity: PolicyEventSeverity,
    title: string,
    description: string,
    metadata: Record<string, string | number> = {},
    linked_ref: string | null = null,
  ) => {
    events.push({
      event_id: `pt-${policy_id}-${String(seq).padStart(3, '0')}`,
      occurred_at: new Date(now.getTime() - daysAgo * DAY_MS).toISOString(),
      event_type,
      severity,
      title,
      description,
      linked_ref,
      metadata,
    });
    seq++;
  };

  const span = 1095; // ~3 years
  const annualPremium = Math.round(20_000 + rng() * 480_000); // KES
  const product = PRODUCTS[Math.floor(rng() * PRODUCTS.length)];

  // 1) Issued.
  mk(span, 'policy_issued', 'info', 'Policy issued', `${product} policy underwritten and issued.`, {
    annual_premium_kes: annualPremium,
    sum_assured_kes: annualPremium * Math.round(15 + rng() * 25),
  });
  // 1b) Underwriting event at issue (sometimes a loading / waiver).
  if (rng() < 0.4) {
    mk(span - 2, 'underwriting_event', 'info', 'Underwriting decision', 'Medical loading applied at underwriting.', {
      loading_pct: Math.round(10 + rng() * 40),
    });
  }

  // 2) Quarterly premium cadence over ~3 years; deterioration ramps later.
  let premiumPaid = 0;
  let missedStreak = 0;
  let peakAnomaly = 0;
  let claimsFiled = 0;
  let claimsSettled = 0;
  const quarters = 12;
  for (let q = quarters - 1; q >= 0; q--) {
    const daysAgo = q * 90 + Math.floor(rng() * 10);
    const stress = q <= 5 ? (5 - q) / 5 : 0; // ramps in over the last ~6 quarters
    const missed = rng() < 0.1 + stress * 0.5;
    if (missed) {
      missedStreak++;
      mk(daysAgo, 'premium_missed', missedStreak >= 2 ? 'critical' : 'warning', 'Premium missed', `Quarterly premium not received (streak ${missedStreak}).`, {
        amount_due_kes: Math.round(annualPremium / 4),
        missed_streak: missedStreak,
      });
      if (missedStreak === 1) {
        mk(daysAgo - 3, 'grace_period', 'warning', 'Grace period started', '30-day grace period in effect.', { grace_days: 30 });
      }
    } else {
      if (missedStreak > 0) {
        mk(daysAgo + 1, 'reinstatement', 'info', 'Policy reinstated', 'Arrears cleared; policy reinstated.', { cleared_kes: Math.round((annualPremium / 4) * missedStreak) });
      }
      missedStreak = 0;
      premiumPaid += Math.round(annualPremium / 4);
      mk(daysAgo, 'premium_paid', 'info', 'Premium paid', 'Quarterly premium received on schedule.', { amount_kes: Math.round(annualPremium / 4) });
    }
    // Annual renewal marker.
    if (q % 4 === 0 && q !== 0) {
      mk(daysAgo - 1, 'renewal', 'info', 'Policy renewed', 'Annual renewal processed.', { renewal_year: Math.floor(q / 4) });
    }
  }

  // 3) Claims — 0-2 over the life; one may be anomalous.
  const nClaims = rng() < 0.5 ? 0 : rng() < 0.85 ? 1 : 2;
  for (let c = 0; c < nClaims; c++) {
    claimsFiled++;
    const daysAgo = 200 - c * 90 + Math.floor(rng() * 30);
    const claimRef = `CLM-${Math.floor(800000 + rng() * 9999)}`;
    const amount = Math.round(annualPremium * (1 + rng() * 6));
    mk(daysAgo, 'claim_filed', 'info', 'Claim filed', `Claim submitted for ${product}.`, { amount_kes: amount }, claimRef);
    const anomalous = rng() < 0.35;
    if (anomalous) {
      const score = Math.round((0.55 + rng() * 0.4) * 100) / 100;
      if (score > peakAnomaly) peakAnomaly = score;
      mk(daysAgo - 2, 'anomaly_flagged', score >= 0.75 ? 'critical' : 'warning', 'Claim anomaly flagged', `Anomaly score ${score} — amount/frequency deviation.`, { anomaly_score: score }, claimRef);
      mk(daysAgo - 3, 'alert_raised', score >= 0.75 ? 'critical' : 'warning', 'EWS alert raised', 'Early-warning alert generated for claims review.', { severity_in: score >= 0.75 ? 'CRITICAL' : 'HIGH' }, `a-${Math.floor(700000 + rng() * 9999)}`);
      if (score >= 0.75) {
        mk(daysAgo - 5, 'claim_rejected', 'warning', 'Claim rejected', 'Claim repudiated pending SIU review.', { amount_kes: amount }, claimRef);
      } else {
        claimsSettled++;
        mk(daysAgo - 10, 'claim_settled', 'info', 'Claim settled', 'Claim approved and paid.', { amount_kes: amount }, claimRef);
      }
    } else {
      claimsSettled++;
      mk(daysAgo - 8, 'claim_settled', 'info', 'Claim settled', 'Claim approved and paid.', { amount_kes: amount }, claimRef);
    }
  }

  // 4) Lapse-risk path when the missed streak / stress is high.
  let lapseScore = Math.min(0.95, 0.1 + missedStreak * 0.25 + rng() * 0.2);
  let status: PolicyStatus = 'in_force';
  if (missedStreak >= 1) {
    mk(25, 'lapse_warning', missedStreak >= 2 ? 'critical' : 'warning', 'Lapse warning', `Lapse probability ${Math.round(lapseScore * 100)}% — retention review triggered.`, { lapse_probability: Math.round(lapseScore * 100) / 100 });
    mk(18, 'retention_action', 'info', 'Retention call', 'Retention specialist outreach logged.', { outcome: rng() < 0.5 ? 'promised_payment' : 'no_response' });
  }
  if (missedStreak >= 3) {
    if (rng() < 0.5) {
      status = 'lapsed';
      lapseScore = Math.max(lapseScore, 0.8);
    } else {
      status = 'surrendered';
      mk(6, 'surrender', 'critical', 'Policy surrendered', 'Policyholder surrendered for cash value.', { surrender_value_kes: Math.round(premiumPaid * 0.6) });
    }
  }

  return { events, status, peakAnomaly, premiumPaid, claimsFiled, claimsSettled, lapseScore };
}

export interface PolicyTimelineFilters {
  event_type?: PolicyEventType;
  since?: string;
  limit?: number;
}

function deriveTrajectory(events: PolicyEvent[], now: Date): PersistencyTrajectory {
  const recentCut = now.getTime() - 180 * DAY_MS;
  const priorCut = now.getTime() - 360 * DAY_MS;
  const weight: Record<PolicyEventSeverity, number> = { info: -1, warning: 2, critical: 4 };
  let recent = 0;
  let prior = 0;
  for (const e of events) {
    const t = new Date(e.occurred_at).getTime();
    if (t >= recentCut) recent += weight[e.severity];
    else if (t >= priorCut) prior += weight[e.severity];
  }
  if (recent > prior + 2) return 'deteriorating';
  if (recent < prior - 2) return 'improving';
  return 'stable';
}

export function buildPolicyTimeline(
  tenant_id: string,
  policy_id: string,
  filters: PolicyTimelineFilters,
  now: Date,
): PolicyTimeline {
  if (!tenant_id) throw new PolicyTimelineError('invalid_input', 'tenant_id required');
  if (!policy_id) throw new PolicyTimelineError('invalid_input', 'policy_id required');
  if (filters.event_type && !ALL_POLICY_EVENT_TYPES.includes(filters.event_type))
    throw new PolicyTimelineError('invalid_event_type', `unknown event_type ${filters.event_type}`);
  let sinceMs: number | null = null;
  if (filters.since) {
    const t = new Date(filters.since).getTime();
    if (!Number.isFinite(t)) throw new PolicyTimelineError('invalid_since', `invalid since ${filters.since}`);
    sinceMs = t;
  }
  const limit =
    filters.limit == null ? DEFAULT_LIMIT : Math.max(1, Math.min(MAX_LIMIT, Math.floor(filters.limit)));

  const nameRng = mulberry32(fnv1a(`${tenant_id}|${policy_id}|meta`));
  const policyholder_name = `${FIRST[Math.floor(nameRng() * FIRST.length)]} ${LAST[Math.floor(nameRng() * LAST.length)]}`;
  const product = PRODUCTS[Math.floor(nameRng() * PRODUCTS.length)];
  const channel = CHANNELS[Math.floor(nameRng() * CHANNELS.length)];

  const { events: full, status, peakAnomaly, premiumPaid, claimsFiled, claimsSettled, lapseScore } =
    buildFullLifecycle(tenant_id, policy_id, now);

  full.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());

  const by_type = Object.fromEntries(ALL_POLICY_EVENT_TYPES.map((t) => [t, 0])) as Record<PolicyEventType, number>;
  const by_severity: Record<PolicyEventSeverity, number> = { info: 0, warning: 0, critical: 0 };
  for (const e of full) {
    by_type[e.event_type]++;
    by_severity[e.severity]++;
  }

  let view = full;
  if (filters.event_type) view = view.filter((e) => e.event_type === filters.event_type);
  if (sinceMs != null) view = view.filter((e) => new Date(e.occurred_at).getTime() >= sinceMs!);
  const events = view.slice(0, limit);

  return {
    tenant_id,
    policy_id,
    policyholder_name,
    product,
    channel,
    generated_at: now.toISOString(),
    policy_status: status,
    lapse_risk_band: lapseBand(lapseScore),
    persistency_trajectory: deriveTrajectory(full, now),
    total_premium_paid_kes: premiumPaid,
    claims_filed: claimsFiled,
    claims_settled: claimsSettled,
    peak_anomaly_score: peakAnomaly,
    total_events: full.length,
    returned_count: events.length,
    by_type,
    by_severity,
    first_event_at: full.length ? full[full.length - 1].occurred_at : null,
    last_event_at: full.length ? full[0].occurred_at : null,
    filters_applied: { event_type: filters.event_type ?? null, since: filters.since ?? null, limit },
    events,
  };
}
