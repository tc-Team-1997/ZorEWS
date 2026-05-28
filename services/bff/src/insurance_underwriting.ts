// services/bff/src/insurance_underwriting.ts
//
// Insurance EWS — Module 6: Underwriting Deviation.
//
// Surfaces policies approved against underwriting guidelines — premium
// deviations, medical-waiver concessions, sum-assured violations, and
// generic rule violations — plus per-underwriter risk scoring and an
// approval-exception view. Pure-function builders over deterministic
// synthesis (FNV-1a seed + Mulberry32), same template as Modules 1–5.
// Swap builder bodies to app_insurance.{underwriting_deviations,
// approval_exceptions,underwriter_scores} when the policy-admin feed lands.
//
// Surfaces:
//   buildUnderwritingDashboard(tenant, now)   → UnderwritingDashboard (4 widgets)
//   analyzeProposal(input, now)               → ProposalAnalysis (ad-hoc check)
//   listDeviations(tenant, now, opts)         → DeviationList

// ─── deterministic synthesis helpers ───────────────────────────────────

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
function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ─── domain enums ───────────────────────────────────────────────────────

export const DEVIATION_TYPES = ['premium', 'medical_waiver', 'sum_assured', 'rule_violation'] as const;
export type DeviationType = (typeof DEVIATION_TYPES)[number];

export const UW_CHANNELS = ['agent', 'broker', 'bancassurance', 'direct', 'online'] as const;
export type UwChannel = (typeof UW_CHANNELS)[number];

export const UW_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type UwSeverity = (typeof UW_SEVERITIES)[number];

export const DEVIATION_STATUSES = ['open', 'reviewed', 'accepted', 'reversed'] as const;
export type DeviationStatus = (typeof DEVIATION_STATUSES)[number];

export function severityFor(score: number): UwSeverity {
  if (score >= 0.75) return 'critical';
  if (score >= 0.5) return 'high';
  if (score >= 0.25) return 'medium';
  return 'low';
}

export class UnderwritingError extends Error {
  constructor(
    public code: 'invalid_input' | 'invalid_deviation_type' | 'invalid_value',
    message: string,
  ) {
    super(message);
    this.name = 'UnderwritingError';
  }
}

// ─── shapes ─────────────────────────────────────────────────────────────

export interface DeviationRow {
  deviation_id: string;
  policy_id: string;
  underwriter_id: string;
  underwriter_name: string;
  channel: UwChannel;
  deviation_type: DeviationType;
  rule_code: string;
  expected_value: number;
  actual_value: number;
  deviation_pct: number; // signed; (actual-expected)/expected
  severity: UwSeverity;
  status: DeviationStatus;
  detected_at: string;
}
export interface UnderwriterScore {
  underwriter_id: string;
  underwriter_name: string;
  risk_score: number; // 0..1
  deviation_count_90d: number;
  policies_underwritten: number;
  deviation_rate: number; // deviations / policies
  rank: number;
}
export interface DeviationHeatCell {
  deviation_type: DeviationType;
  channel: UwChannel;
  count: number;
  mean_deviation_pct: number;
}
export interface MedicalWaiverRow {
  band: string; // e.g. "under_35" | "35_50" | "over_50"
  waivers_granted: number;
  waiver_rate: number; // waivers / proposals
  high_sum_assured_waivers: number;
}
export interface UnderwritingDashboard {
  tenant_id: string;
  generated_at: string;
  totals: {
    proposals_reviewed: number;
    total_deviations: number;
    open_deviations: number;
    critical_deviations: number;
    medical_waivers: number;
    high_risk_underwriters: number;
  };
  high_risk_underwriters: UnderwriterScore[]; // top 10 by risk
  deviation_heatmap: DeviationHeatCell[]; // type × channel
  medical_waiver_analysis: MedicalWaiverRow[];
  rule_violation_alerts: DeviationRow[]; // open, worst-first, top 12
  model_version: string;
}

export interface AnalyzeProposalInput {
  policy_id?: string;
  underwriter_id?: string;
  channel?: string;
  // Deviation signals
  premium_vs_guideline_ratio?: number; // 1 = on guideline; <1 = under-priced
  sum_assured_vs_limit_ratio?: number; // 1 = at limit; >1 = over limit
  medical_waiver_granted?: boolean;
  applicant_age?: number;
  rule_overrides?: number; // count of manual rule overrides
}
export interface DetectedDeviation {
  deviation_type: DeviationType;
  rule_code: string;
  detail: string;
  contribution: number;
}
export interface ProposalAnalysis {
  policy_id: string;
  underwriter_id: string;
  deviation_score: number; // 0..1
  severity: UwSeverity;
  deviations: DetectedDeviation[];
  requires_exception_approval: boolean;
  recommended_action: string;
  model_version: string;
  analyzed_at: string;
}

export interface DeviationList {
  tenant_id: string;
  generated_at: string;
  type_filter: DeviationType | 'all';
  status_filter: DeviationStatus | 'all';
  total: number;
  deviations: DeviationRow[];
}

const MODEL_VERSION = 'underwriting-stub-v1';

const UW_NAMES = [
  'R. Sharma', 'P. Iyer', 'A. Khan', 'M. Nair', 'S. Reddy', 'V. Mehta',
  'K. Das', 'N. Gupta', 'T. Bose', 'D. Rao', 'L. Joshi', 'B. Menon',
];

function tenantScale(tenant_id: string): number {
  return tenant_id === 'BANK_DEMO' ? 1.0 : 0.6;
}

const RULE_CODES: Record<DeviationType, string> = {
  premium: 'PREMIUM_BELOW_GUIDELINE',
  medical_waiver: 'MEDICAL_WAIVER_GRANTED',
  sum_assured: 'SUM_ASSURED_OVER_LIMIT',
  rule_violation: 'MANUAL_RULE_OVERRIDE',
};

/** Synthesise the deviation book for a tenant on a given day. */
function synthDeviations(tenant_id: string, now: Date): DeviationRow[] {
  const day = utcDay(now);
  const scale = tenantScale(tenant_id);
  const count = Math.max(20, Math.round(70 * scale));
  const out: DeviationRow[] = [];
  for (let i = 0; i < count; i++) {
    const r = rng(seedFrom(tenant_id, day, 'deviation', String(i)));
    const deviation_type = DEVIATION_TYPES[Math.floor(r() * DEVIATION_TYPES.length)];
    const channel = UW_CHANNELS[Math.floor(r() * UW_CHANNELS.length)];
    const uwIdx = Math.floor(r() * UW_NAMES.length);
    const score = round4(Math.min(1, r() ** 1.4));
    const severity = severityFor(score);
    // Expected/actual + signed deviation_pct per type.
    let expected: number;
    let actual: number;
    if (deviation_type === 'premium') {
      expected = round2(50000 + r() * 200000);
      actual = round2(expected * (0.6 + r() * 0.35)); // under-priced
    } else if (deviation_type === 'sum_assured') {
      expected = round2(5_000_000 + r() * 10_000_000); // limit
      actual = round2(expected * (1.05 + r() * 0.5)); // over limit
    } else if (deviation_type === 'medical_waiver') {
      expected = 0;
      actual = 1;
    } else {
      expected = 0;
      actual = 1 + Math.floor(r() * 3);
    }
    const deviation_pct = expected !== 0 ? round4((actual - expected) / expected) : 1;
    const statuses: DeviationStatus[] = ['open', 'reviewed', 'accepted', 'reversed'];
    out.push({
      deviation_id: `UWD-${tenant_id}-${String(900000 + i)}`,
      policy_id: `POL-${tenant_id}-${String(100000 + i)}`,
      underwriter_id: `UW-${tenant_id}-${String(10 + uwIdx)}`,
      underwriter_name: UW_NAMES[uwIdx],
      channel,
      deviation_type,
      rule_code: RULE_CODES[deviation_type],
      expected_value: expected,
      actual_value: actual,
      deviation_pct,
      severity,
      status: statuses[Math.floor(r() * (r() > 0.6 ? 4 : 2))], // bias toward open/reviewed
      detected_at: new Date(now.getTime() - Math.floor(r() * 60) * 86400000).toISOString(),
    });
  }
  return out;
}

// ─── builders ─────────────────────────────────────────────────────────────

export function buildUnderwritingDashboard(tenant_id: string, now: Date): UnderwritingDashboard {
  if (!tenant_id) throw new UnderwritingError('invalid_input', 'tenant_id required');
  const book = synthDeviations(tenant_id, now);
  const scale = tenantScale(tenant_id);
  const proposals_reviewed = Math.round(800 * scale);

  // Per-underwriter scores.
  const byUw = new Map<string, DeviationRow[]>();
  for (const d of book) {
    if (!byUw.has(d.underwriter_id)) byUw.set(d.underwriter_id, []);
    byUw.get(d.underwriter_id)!.push(d);
  }
  const high_risk_underwriters: UnderwriterScore[] = [...byUw.entries()]
    .map(([uwId, rows]) => {
      const r = rng(seedFrom(tenant_id, utcDay(now), 'uwscore', uwId));
      const policies = 30 + Math.floor(r() * 120);
      const critHigh = rows.filter((d) => d.severity === 'high' || d.severity === 'critical').length;
      const risk = round4(Math.min(1, (rows.length * 0.05 + critHigh * 0.12) * (0.7 + r() * 0.6)));
      return {
        underwriter_id: uwId,
        underwriter_name: rows[0].underwriter_name,
        risk_score: risk,
        deviation_count_90d: rows.length,
        policies_underwritten: policies,
        deviation_rate: round4(rows.length / policies),
        rank: 0,
      };
    })
    .sort((a, b) => b.risk_score - a.risk_score || a.underwriter_id.localeCompare(b.underwriter_id))
    .slice(0, 10)
    .map((u, i) => ({ ...u, rank: i + 1 }));

  // Deviation heatmap — type × channel.
  const deviation_heatmap: DeviationHeatCell[] = [];
  for (const dt of DEVIATION_TYPES) {
    for (const ch of UW_CHANNELS) {
      const cell = book.filter((d) => d.deviation_type === dt && d.channel === ch);
      deviation_heatmap.push({
        deviation_type: dt,
        channel: ch,
        count: cell.length,
        mean_deviation_pct: cell.length ? round4(cell.reduce((a, d) => a + Math.abs(d.deviation_pct), 0) / cell.length) : 0,
      });
    }
  }

  // Medical waiver analysis by age band.
  const waivers = book.filter((d) => d.deviation_type === 'medical_waiver');
  const medical_waiver_analysis: MedicalWaiverRow[] = ['under_35', '35_50', 'over_50'].map((band, idx) => {
    const r = rng(seedFrom(tenant_id, utcDay(now), 'waiver', band));
    const granted = Math.round((waivers.length / 3) * (0.6 + r()));
    const proposals = Math.round(proposals_reviewed / 3);
    return {
      band,
      waivers_granted: granted,
      waiver_rate: round4(granted / Math.max(1, proposals)),
      high_sum_assured_waivers: Math.round(granted * (0.1 + idx * 0.12)),
    };
  });

  const rule_violation_alerts = [...book]
    .filter((d) => d.status === 'open')
    .sort((a, b) => {
      const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
      return rank[a.severity] - rank[b.severity] || a.deviation_id.localeCompare(b.deviation_id);
    })
    .slice(0, 12);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    totals: {
      proposals_reviewed,
      total_deviations: book.length,
      open_deviations: book.filter((d) => d.status === 'open').length,
      critical_deviations: book.filter((d) => d.severity === 'critical').length,
      medical_waivers: waivers.length,
      high_risk_underwriters: high_risk_underwriters.filter((u) => u.risk_score >= 0.5).length,
    },
    high_risk_underwriters,
    deviation_heatmap,
    medical_waiver_analysis,
    rule_violation_alerts,
    model_version: MODEL_VERSION,
  };
}

export interface DeviationOpts {
  deviation_type?: string;
  status?: string;
  limit?: number;
}

export function listDeviations(tenant_id: string, now: Date, opts: DeviationOpts = {}): DeviationList {
  if (!tenant_id) throw new UnderwritingError('invalid_input', 'tenant_id required');
  let type_filter: DeviationType | 'all' = 'all';
  if (opts.deviation_type !== undefined && opts.deviation_type !== 'all') {
    if (!DEVIATION_TYPES.includes(opts.deviation_type as DeviationType)) {
      throw new UnderwritingError('invalid_deviation_type', `deviation_type must be one of ${DEVIATION_TYPES.join(', ')} or 'all'`);
    }
    type_filter = opts.deviation_type as DeviationType;
  }
  let status_filter: DeviationStatus | 'all' = 'all';
  if (opts.status !== undefined && opts.status !== 'all') {
    if (!DEVIATION_STATUSES.includes(opts.status as DeviationStatus)) {
      throw new UnderwritingError('invalid_value', `status must be one of ${DEVIATION_STATUSES.join(', ')} or 'all'`);
    }
    status_filter = opts.status as DeviationStatus;
  }
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));

  let rows = synthDeviations(tenant_id, now);
  if (type_filter !== 'all') rows = rows.filter((d) => d.deviation_type === type_filter);
  if (status_filter !== 'all') rows = rows.filter((d) => d.status === status_filter);
  rows.sort((a, b) => {
    const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    return rank[a.severity] - rank[b.severity] || a.deviation_id.localeCompare(b.deviation_id);
  });

  return {
    tenant_id,
    generated_at: now.toISOString(),
    type_filter,
    status_filter,
    total: rows.length,
    deviations: rows.slice(0, limit),
  };
}

/**
 * Ad-hoc underwriting-deviation check for a single proposal. Deterministic
 * weighted blend of the deviation signals, clamped to [0,1], with a list of
 * detected deviations + an exception-approval flag.
 */
export function analyzeProposal(input: AnalyzeProposalInput, now: Date): ProposalAnalysis {
  if (!input || typeof input !== 'object') throw new UnderwritingError('invalid_input', 'request body required');

  const premiumRatio = numOr(input.premium_vs_guideline_ratio, 1);
  const sumAssuredRatio = numOr(input.sum_assured_vs_limit_ratio, 1);
  const medicalWaiver = input.medical_waiver_granted === true;
  const age = numOr(input.applicant_age, 40);
  const overrides = numOr(input.rule_overrides, 0);
  if (premiumRatio < 0 || sumAssuredRatio < 0 || age < 0 || overrides < 0) {
    throw new UnderwritingError('invalid_value', 'signals must be non-negative');
  }

  const deviations: DetectedDeviation[] = [];
  // Premium under-pricing: ratio < 0.9 is a deviation; deeper → bigger.
  const dPremium = premiumRatio < 0.9 ? Math.min(0.35, (0.9 - premiumRatio) * 1.2) : 0;
  if (dPremium > 0) {
    deviations.push({ deviation_type: 'premium', rule_code: RULE_CODES.premium, detail: `Premium at ${(premiumRatio * 100).toFixed(0)}% of guideline`, contribution: round4(dPremium) });
  }
  // Sum assured over limit: ratio > 1.0 is a deviation.
  const dSum = sumAssuredRatio > 1.0 ? Math.min(0.35, (sumAssuredRatio - 1.0) * 0.7) : 0;
  if (dSum > 0) {
    deviations.push({ deviation_type: 'sum_assured', rule_code: RULE_CODES.sum_assured, detail: `Sum assured at ${(sumAssuredRatio * 100).toFixed(0)}% of limit`, contribution: round4(dSum) });
  }
  // Medical waiver — heavier for older applicants.
  const dWaiver = medicalWaiver ? Math.min(0.3, 0.12 + Math.max(0, (age - 45) / 100)) : 0;
  if (dWaiver > 0) {
    deviations.push({ deviation_type: 'medical_waiver', rule_code: RULE_CODES.medical_waiver, detail: `Medical waiver granted at age ${age}`, contribution: round4(dWaiver) });
  }
  // Manual rule overrides.
  const dOverride = Math.min(0.3, overrides * 0.1);
  if (dOverride > 0) {
    deviations.push({ deviation_type: 'rule_violation', rule_code: RULE_CODES.rule_violation, detail: `${overrides} manual rule override(s)`, contribution: round4(dOverride) });
  }

  const raw = deviations.reduce((a, d) => a + d.contribution, 0);
  const score = round4(Math.max(0, Math.min(1, raw)));
  const severity = severityFor(score);
  deviations.sort((a, b) => b.contribution - a.contribution);

  const requires_exception_approval = severity === 'high' || severity === 'critical';

  return {
    policy_id: input.policy_id ?? 'POL-ADHOC',
    underwriter_id: input.underwriter_id ?? 'UW-ADHOC',
    deviation_score: score,
    severity,
    deviations,
    requires_exception_approval,
    recommended_action: action(severity, deviations[0]?.deviation_type),
    model_version: MODEL_VERSION,
    analyzed_at: now.toISOString(),
  };
}

function action(severity: UwSeverity, top?: DeviationType): string {
  if (severity === 'critical') return 'Block issuance — route to senior UW + compliance for exception approval';
  if (severity === 'high') {
    return top === 'sum_assured'
      ? 'Hold for sum-assured limit review + reinsurance check'
      : 'Route to approval-exception workflow before issuance';
  }
  if (severity === 'medium') return 'Flag for UW supervisor review';
  return 'Within underwriting tolerance — proceed';
}

function numOr(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new UnderwritingError('invalid_value', 'numeric signal must be finite');
  return n;
}
