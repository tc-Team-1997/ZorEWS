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
