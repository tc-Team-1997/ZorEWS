// services/bff/src/insurance_claims_anomaly.ts
//
// Insurance EWS — Module 2: Claims Anomaly.
//
// Scores claims for suspicion (0.00–1.00) across frequency spikes, amount
// spikes, signature mismatch, duplicate/rapid-refile, and off-template
// patterns; auto-queues high scorers into the SIU (Special Investigation
// Unit). Pure-function builders over deterministic synthesis (FNV-1a seed
// + Mulberry32), same template as insurance_policy_lapse.ts — a given
// (tenant, day) yields a stable claim book today; swap builder bodies to
// app_insurance.claim_anomalies / siu_cases / fraud_scores when the
// insurer's claims feed lands. Response shapes stay frozen.
//
// Surfaces:
//   buildClaimsAnomalyDashboard(tenant, now)   → ClaimsAnomalyDashboard (4 widgets)
//   listSuspiciousClaims(tenant, now, opts)    → SuspiciousClaimsList
//   analyzeClaim(input, now)                   → ClaimAnalysisResult (ad-hoc scoring)

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

export const ANOMALY_REASONS = [
  'frequency_spike',
  'amount_spike',
  'signature_mismatch',
  'duplicate_claim',
  'rapid_refile',
  'off_template',
] as const;
export type AnomalyReason = (typeof ANOMALY_REASONS)[number];

export const CLAIM_TYPES = ['health', 'motor', 'life', 'property', 'travel'] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export const CLAIM_REGIONS = ['North', 'South', 'East', 'West', 'Central'] as const;
export type ClaimRegion = (typeof CLAIM_REGIONS)[number];

export const ANOMALY_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type AnomalySeverity = (typeof ANOMALY_SEVERITIES)[number];

export const SIU_STATES = ['queued', 'investigating', 'escalated', 'closed'] as const;
export type SiuState = (typeof SIU_STATES)[number];

/** Map an anomaly score to a severity band. */
export function severityFor(score: number): AnomalySeverity {
  if (score >= 0.75) return 'critical';
  if (score >= 0.5) return 'high';
  if (score >= 0.25) return 'medium';
  return 'low';
}

export class ClaimsAnomalyError extends Error {
  constructor(
    public code: 'invalid_input' | 'invalid_amount' | 'invalid_severity',
    message: string,
  ) {
    super(message);
    this.name = 'ClaimsAnomalyError';
  }
}

// ─── shapes ─────────────────────────────────────────────────────────────

export interface ClaimAnomalyRow {
  claim_id: string;
  policy_id: string;
  customer_id: string;
  customer_name: string;
  claim_type: ClaimType;
  region: ClaimRegion;
  claim_amount_kes: number;
  anomaly_score: number; // 0..1
  severity: AnomalySeverity;
  anomaly_reasons: AnomalyReason[];
  fraud_probability: number; // 0..1
  cluster_id: string | null;
  status: 'open' | 'siu_queued' | 'cleared' | 'confirmed_fraud';
  filed_at: string;
  model_version: string;
}

export interface FraudScoreBucket {
  range: string; // e.g. "0.0–0.2"
  min: number;
  max: number;
  count: number;
}

export interface ClaimsHeatCell {
  claim_type: ClaimType;
  region: ClaimRegion;
  suspicious_count: number;
  mean_anomaly_score: number;
}

export interface SiuCaseRow {
  siu_case_id: string;
  claim_id: string;
  priority: AnomalySeverity;
  state: SiuState;
  assigned_to: string | null;
  fraud_probability: number;
  opened_at: string;
}

export interface ClaimsAnomalyDashboard {
  tenant_id: string;
  generated_at: string;
  totals: {
    claims_scored: number;
    suspicious_claims: number; // severity ∈ {high, critical}
    critical_count: number;
    high_count: number;
    siu_open_cases: number;
    suspicious_amount_kes: number;
    mean_anomaly_score: number;
  };
  suspicious_claims_queue: ClaimAnomalyRow[]; // top 10 by anomaly_score
  fraud_score_distribution: FraudScoreBucket[]; // 5 buckets across [0,1]
  claims_heatmap: ClaimsHeatCell[]; // claim_type × region (suspicious only)
  siu_investigation_queue: SiuCaseRow[]; // open SIU cases, worst-first
  model_version: string;
}

export interface SuspiciousClaimsList {
  tenant_id: string;
  generated_at: string;
  severity_filter: AnomalySeverity | 'all';
  total: number;
  claims: ClaimAnomalyRow[];
}

export interface AnalyzeClaimInput {
  claim_id?: string;
  policy_id?: string;
  customer_id: string;
  claim_type?: string;
  claim_amount_kes?: number;
  // Suspicion signals
  claims_in_90d?: number; // frequency spike driver
  amount_vs_policy_avg?: number; // ratio; >1 = above average
  signature_match_score?: number; // 0..1; lower = mismatch
  is_duplicate?: boolean;
  days_since_last_claim?: number; // very small → rapid refile
  documents_off_template?: number;
}

export interface ClaimAnalysisResult {
  claim_id: string;
  customer_id: string;
  anomaly_score: number;
  severity: AnomalySeverity;
  fraud_probability: number;
  anomaly_reasons: AnomalyReason[];
  siu_recommended: boolean;
  drivers: { signal: string; contribution: number }[];
  recommended_action: string;
  model_version: string;
  scored_at: string;
}

const MODEL_VERSION = 'claim-anomaly-stub-v1';

const FIRST_NAMES = [
  'Aarav', 'Diya', 'Kabir', 'Ananya', 'Vivaan', 'Ishika', 'Reyansh', 'Myra',
  'Arjun', 'Saanvi', 'Aditya', 'Kiara', 'Vihaan', 'Anika', 'Rohan', 'Tara',
];
const LAST_NAMES = [
  'Sharma', 'Patel', 'Reddy', 'Iyer', 'Khan', 'Nair', 'Mehta', 'Das',
  'Gupta', 'Bose', 'Rao', 'Joshi', 'Menon', 'Verma', 'Pillai', 'Shetty',
];
function synthName(r: () => number): string {
  return `${FIRST_NAMES[Math.floor(r() * FIRST_NAMES.length)]} ${LAST_NAMES[Math.floor(r() * LAST_NAMES.length)]}`;
}

function tenantScale(tenant_id: string): number {
  return tenant_id === 'BANK_DEMO' ? 1.0 : 0.6;
}

function siuAction(siu: boolean, severity: AnomalySeverity): string {
  if (siu) {
    return severity === 'critical'
      ? 'Auto-queue to SIU — freeze payout pending investigation'
      : 'Queue to SIU — request supporting documents before settlement';
  }
  if (severity === 'medium') return 'Flag for adjuster review before approval';
  return 'Proceed — within normal claim parameters';
}

/** Synthesise the scored claim book for a tenant on a given day. */
function synthClaimBook(tenant_id: string, now: Date): ClaimAnomalyRow[] {
  const day = utcDay(now);
  const scale = tenantScale(tenant_id);
  const count = Math.max(20, Math.round(70 * scale));
  const out: ClaimAnomalyRow[] = [];
  for (let i = 0; i < count; i++) {
    const r = rng(seedFrom(tenant_id, day, 'claim', String(i)));
    const claim_type = CLAIM_TYPES[Math.floor(r() * CLAIM_TYPES.length)];
    const region = CLAIM_REGIONS[Math.floor(r() * CLAIM_REGIONS.length)];
    // Anomaly score biased toward the low end; ~25% high/critical.
    const score = round4(Math.min(1, r() ** 1.5));
    const severity = severityFor(score);
    const amount = round2((20000 + r() * 480000) * (claim_type === 'health' ? 1.4 : claim_type === 'property' ? 2.0 : 1));
    // Reasons: pick a subset proportional to score.
    const reasons: AnomalyReason[] = [];
    const pool = [...ANOMALY_REASONS];
    const nReasons = score >= 0.75 ? 3 : score >= 0.5 ? 2 : score >= 0.25 ? 1 : 0;
    for (let k = 0; k < nReasons; k++) {
      const idx = Math.floor(r() * pool.length);
      reasons.push(pool.splice(idx, 1)[0]);
    }
    const status: ClaimAnomalyRow['status'] = severity === 'critical' || severity === 'high' ? 'siu_queued' : 'open';
    out.push({
      claim_id: `CLM-${tenant_id}-${String(300000 + i)}`,
      policy_id: `POL-${tenant_id}-${String(100000 + i)}`,
      customer_id: `CUST-${tenant_id}-${String(200000 + i)}`,
      customer_name: synthName(r),
      claim_type,
      region,
      claim_amount_kes: amount,
      anomaly_score: score,
      severity,
      anomaly_reasons: reasons,
      fraud_probability: round4(Math.min(1, score * 0.9 + r() * 0.1)),
      cluster_id: score >= 0.5 && r() > 0.5 ? `CLUSTER-${tenant_id}-${Math.floor(r() * 6)}` : null,
      status,
      filed_at: new Date(now.getTime() - Math.floor(r() * 30) * 86400000).toISOString(),
      model_version: MODEL_VERSION,
    });
  }
  return out;
}

/** Synthesise the SIU case queue from the suspicious subset of the book. */
function synthSiuQueue(tenant_id: string, now: Date, book: ClaimAnomalyRow[]): SiuCaseRow[] {
  const officers = ['siu.alice', 'siu.bob', 'siu.carol', null];
  return book
    .filter((c) => c.severity === 'high' || c.severity === 'critical')
    .map((c, i) => {
      const r = rng(seedFrom(tenant_id, utcDay(now), 'siu', c.claim_id));
      const state = SIU_STATES[Math.floor(r() * 3)]; // queued | investigating | escalated (open states)
      return {
        siu_case_id: `SIU-${tenant_id}-${String(400000 + i)}`,
        claim_id: c.claim_id,
        priority: c.severity,
        state,
        assigned_to: officers[Math.floor(r() * officers.length)],
        fraud_probability: c.fraud_probability,
        opened_at: c.filed_at,
      };
    });
}

// ─── builders ─────────────────────────────────────────────────────────────

export function buildClaimsAnomalyDashboard(tenant_id: string, now: Date): ClaimsAnomalyDashboard {
  if (!tenant_id) throw new ClaimsAnomalyError('invalid_input', 'tenant_id required');
  const book = synthClaimBook(tenant_id, now);
  const suspicious = book.filter((c) => c.severity === 'high' || c.severity === 'critical');
  const critical = book.filter((c) => c.severity === 'critical');
  const high = book.filter((c) => c.severity === 'high');
  const siu = synthSiuQueue(tenant_id, now, book);

  const suspicious_claims_queue = [...book]
    .sort((a, b) => b.anomaly_score - a.anomaly_score || a.claim_id.localeCompare(b.claim_id))
    .slice(0, 10);

  // Fraud score distribution — 5 fixed buckets across [0,1].
  const buckets: FraudScoreBucket[] = [
    { range: '0.0–0.2', min: 0, max: 0.2, count: 0 },
    { range: '0.2–0.4', min: 0.2, max: 0.4, count: 0 },
    { range: '0.4–0.6', min: 0.4, max: 0.6, count: 0 },
    { range: '0.6–0.8', min: 0.6, max: 0.8, count: 0 },
    { range: '0.8–1.0', min: 0.8, max: 1.0001, count: 0 },
  ];
  for (const c of book) {
    const b = buckets.find((bk) => c.fraud_probability >= bk.min && c.fraud_probability < bk.max);
    if (b) b.count++;
  }

  // Claims heatmap — claim_type × region grid over the suspicious subset.
  const claims_heatmap: ClaimsHeatCell[] = [];
  for (const ct of CLAIM_TYPES) {
    for (const rg of CLAIM_REGIONS) {
      const cell = suspicious.filter((c) => c.claim_type === ct && c.region === rg);
      claims_heatmap.push({
        claim_type: ct,
        region: rg,
        suspicious_count: cell.length,
        mean_anomaly_score: cell.length
          ? round4(cell.reduce((a, c) => a + c.anomaly_score, 0) / cell.length)
          : 0,
      });
    }
  }

  const siu_investigation_queue = [...siu]
    .sort((a, b) => b.fraud_probability - a.fraud_probability || a.siu_case_id.localeCompare(b.siu_case_id))
    .slice(0, 12);

  return {
    tenant_id,
    generated_at: now.toISOString(),
    totals: {
      claims_scored: book.length,
      suspicious_claims: suspicious.length,
      critical_count: critical.length,
      high_count: high.length,
      siu_open_cases: siu.length,
      suspicious_amount_kes: round2(suspicious.reduce((a, c) => a + c.claim_amount_kes, 0)),
      mean_anomaly_score: book.length
        ? round4(book.reduce((a, c) => a + c.anomaly_score, 0) / book.length)
        : 0,
    },
    suspicious_claims_queue,
    fraud_score_distribution: buckets,
    claims_heatmap,
    siu_investigation_queue,
    model_version: MODEL_VERSION,
  };
}

export interface SuspiciousOpts {
  severity?: string;
  limit?: number;
}

export function listSuspiciousClaims(
  tenant_id: string,
  now: Date,
  opts: SuspiciousOpts = {},
): SuspiciousClaimsList {
  if (!tenant_id) throw new ClaimsAnomalyError('invalid_input', 'tenant_id required');

  let severity: AnomalySeverity | 'all' = 'all';
  if (opts.severity !== undefined && opts.severity !== 'all') {
    if (!ANOMALY_SEVERITIES.includes(opts.severity as AnomalySeverity)) {
      throw new ClaimsAnomalyError('invalid_severity', `severity must be one of ${ANOMALY_SEVERITIES.join(', ')} or 'all'`);
    }
    severity = opts.severity as AnomalySeverity;
  }
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));

  const book = synthClaimBook(tenant_id, now);
  let rows = book.filter((c) => c.severity === 'high' || c.severity === 'critical');
  if (severity !== 'all') rows = rows.filter((c) => c.severity === severity);
  rows.sort((a, b) => b.anomaly_score - a.anomaly_score || a.claim_id.localeCompare(b.claim_id));

  return {
    tenant_id,
    generated_at: now.toISOString(),
    severity_filter: severity,
    total: rows.length,
    claims: rows.slice(0, limit),
  };
}

/**
 * Ad-hoc claim anomaly scoring from explicit suspicion signals. Deterministic
 * weighted blend of the drivers, clamped to [0,1]. Same inputs → same score.
 */
export function analyzeClaim(input: AnalyzeClaimInput, now: Date): ClaimAnalysisResult {
  if (!input || typeof input !== 'object') {
    throw new ClaimsAnomalyError('invalid_input', 'request body required');
  }
  if (!input.customer_id || typeof input.customer_id !== 'string') {
    throw new ClaimsAnomalyError('invalid_input', 'customer_id required');
  }

  const claims90 = numOr(input.claims_in_90d, 1);
  const amountRatio = numOr(input.amount_vs_policy_avg, 1);
  const sigMatch = clamp01OrThrow(input.signature_match_score, 1);
  const isDup = input.is_duplicate === true;
  const daysSince = numOr(input.days_since_last_claim, 90);
  const offTemplate = numOr(input.documents_off_template, 0);
  if (claims90 < 0 || amountRatio < 0 || daysSince < 0 || offTemplate < 0) {
    throw new ClaimsAnomalyError('invalid_input', 'signals must be non-negative');
  }

  // Driver contributions (each clamped) → anomaly score.
  const dFreq = Math.min(0.3, Math.max(0, (claims90 - 2) * 0.08)); // >2 claims/90d ramps
  const dAmount = Math.min(0.3, Math.max(0, (amountRatio - 1) * 0.25)); // above policy avg
  const dSig = Math.min(0.25, (1 - sigMatch) * 0.25); // mismatch
  const dDup = isDup ? 0.3 : 0;
  const dRapid = daysSince < 14 ? Math.min(0.2, (14 - daysSince) / 70) : 0;
  const dTemplate = Math.min(0.15, offTemplate * 0.05);

  const raw = 0.05 + dFreq + dAmount + dSig + dDup + dRapid + dTemplate;
  const score = round4(Math.max(0, Math.min(1, raw)));
  const fraud = round4(Math.max(0, Math.min(1, score * 0.9 + (isDup ? 0.1 : 0))));
  const severity = severityFor(score);

  const reasons: AnomalyReason[] = [];
  if (dFreq > 0.05) reasons.push('frequency_spike');
  if (dAmount > 0.05) reasons.push('amount_spike');
  if (dSig > 0.05) reasons.push('signature_mismatch');
  if (isDup) reasons.push('duplicate_claim');
  if (dRapid > 0) reasons.push('rapid_refile');
  if (dTemplate > 0.05) reasons.push('off_template');

  const drivers = [
    { signal: 'frequency_spike', contribution: round4(dFreq) },
    { signal: 'amount_spike', contribution: round4(dAmount) },
    { signal: 'signature_mismatch', contribution: round4(dSig) },
    { signal: 'duplicate_claim', contribution: round4(dDup) },
    { signal: 'rapid_refile', contribution: round4(dRapid) },
    { signal: 'off_template', contribution: round4(dTemplate) },
  ]
    .filter((d) => d.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution);

  const siu = severity === 'high' || severity === 'critical';

  return {
    claim_id: input.claim_id ?? `CLM-${input.customer_id}`,
    customer_id: input.customer_id,
    anomaly_score: score,
    severity,
    fraud_probability: fraud,
    anomaly_reasons: reasons,
    siu_recommended: siu,
    drivers,
    recommended_action: siuAction(siu, severity),
    model_version: MODEL_VERSION,
    scored_at: now.toISOString(),
  };
}

function numOr(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new ClaimsAnomalyError('invalid_input', 'numeric signal must be finite');
  return n;
}
function clamp01OrThrow(v: unknown, fallback: number): number {
  const n = numOr(v, fallback);
  if (n < 0 || n > 1) throw new ClaimsAnomalyError('invalid_input', 'signature_match_score must be in [0,1]');
  return n;
}
