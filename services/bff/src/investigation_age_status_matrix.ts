// services/bff/src/investigation_age_status_matrix.ts
//
// T6 M9.13 — Investigation age × status cross-tab matrix.
//
// M9.8 ships cohort by_status counts. M9.11 ships the age-bucket
// distribution. M9.13 combines them into a 2D pivot: each cell is
// (status, age_bucket) → count. Drives "which status has the most
// stuck cases?" — a triage tool for the case-management dashboard.
//
// E.g. if 30d_plus × gathering_evidence has 12 cases, that's
// suspicious — evidence collection is bottlenecked there. If
// 30d_plus × review has 8, the reviewers are the bottleneck.
//
// Mirror of M3.11 type-matrix pattern (rows × cols, every cell
// emitted at 0 when absent, per-row + per-col totals + envelope
// peak_cell + tie-broken canonical order).
//
// Pure rollup. Tenant-scoped at the caller layer.

import {
  INVESTIGATION_STATUSES,
  type CaseInvestigation,
  type InvestigationStatus,
} from './case_investigation';

// ─── Constants ────────────────────────────────────────────────────────

export type AgeBucketKey =
  | 'under_24h'
  | '1_to_3d'
  | '3_to_7d'
  | '7_to_30d'
  | '30d_plus';

export const AGE_BUCKETS: readonly AgeBucketKey[] = [
  'under_24h',
  '1_to_3d',
  '3_to_7d',
  '7_to_30d',
  '30d_plus',
] as const;

const BUCKET_LABEL: Record<AgeBucketKey, string> = {
  under_24h: '< 24h',
  '1_to_3d': '1-3 days',
  '3_to_7d': '3-7 days',
  '7_to_30d': '7-30 days',
  '30d_plus': '30+ days',
};

const STALE_BUCKETS: readonly AgeBucketKey[] = ['7_to_30d', '30d_plus'];

const MS_PER_HOUR = 60 * 60 * 1000;

// ─── Public types ─────────────────────────────────────────────────────

export interface MatrixRow {
  status: InvestigationStatus;
  /** Per-age-bucket count; every AGE_BUCKETS key present at 0 when absent. */
  by_age_bucket: Record<AgeBucketKey, number>;
  /** Σ over by_age_bucket (= count of investigations in this status). */
  row_total: number;
}

export interface AgeBucketColumnTotal {
  bucket: AgeBucketKey;
  label: string;
  count: number;
}

export interface PeakCell {
  status: InvestigationStatus;
  bucket: AgeBucketKey;
  count: number;
}

export interface InvestigationAgeStatusMatrix {
  tenant_id: string;
  generated_at: string;
  total_investigations: number;
  /** Rows in canonical INVESTIGATION_STATUSES order even when zero-count. */
  matrix: MatrixRow[];
  /** Per-column totals (Σ rows for each age bucket). Always 5 entries
   *  in canonical AGE_BUCKETS order. */
  by_age_bucket_total: AgeBucketColumnTotal[];
  /** Highest-count cell. Tie-broken by (status canonical order, bucket
   *  canonical order). null when no investigations. */
  peak_cell: PeakCell | null;
  /** Status with the most cases in stale buckets (7_to_30d + 30d_plus).
   *  Tie-broken by INVESTIGATION_STATUSES canonical order (triage wins
   *  over gathering_evidence at same count — earlier-in-workflow stale
   *  cases are the more pressing). null when zero stale across all
   *  statuses. */
  oldest_open_status: {
    status: InvestigationStatus;
    stale_count: number;
  } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function emptyByAgeBucket(): Record<AgeBucketKey, number> {
  return {
    under_24h: 0,
    '1_to_3d': 0,
    '3_to_7d': 0,
    '7_to_30d': 0,
    '30d_plus': 0,
  };
}

function bucketFor(age_hours: number): AgeBucketKey {
  if (age_hours < 24) return 'under_24h';
  if (age_hours < 72) return '1_to_3d';
  if (age_hours < 168) return '3_to_7d';
  if (age_hours < 720) return '7_to_30d';
  return '30d_plus';
}

function ageHours(opened_at: string, now: Date): number {
  const opened = new Date(opened_at).getTime();
  if (!Number.isFinite(opened)) return 0;
  return Math.max(0, (now.getTime() - opened) / MS_PER_HOUR);
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildInvestigationAgeStatusMatrix(
  tenant_id: string,
  investigations: readonly CaseInvestigation[],
  now: Date,
): InvestigationAgeStatusMatrix {
  // Initialise rows in canonical status order with every bucket at 0.
  const rowByStatus = new Map<InvestigationStatus, MatrixRow>();
  for (const status of INVESTIGATION_STATUSES) {
    rowByStatus.set(status, {
      status,
      by_age_bucket: emptyByAgeBucket(),
      row_total: 0,
    });
  }

  // Per-column totals.
  const colTotals: Record<AgeBucketKey, number> = emptyByAgeBucket();

  for (const inv of investigations) {
    const row = rowByStatus.get(inv.status);
    if (!row) continue; // unknown status — shouldn't happen
    const bucket = bucketFor(ageHours(inv.opened_at, now));
    row.by_age_bucket[bucket]++;
    row.row_total++;
    colTotals[bucket]++;
  }

  const matrix: MatrixRow[] = INVESTIGATION_STATUSES.map((s) => rowByStatus.get(s)!);

  const by_age_bucket_total: AgeBucketColumnTotal[] = AGE_BUCKETS.map((b) => ({
    bucket: b,
    label: BUCKET_LABEL[b],
    count: colTotals[b],
  }));

  // peak_cell: highest cell value with canonical status × bucket
  // iteration order tie-break (earlier status / earlier bucket wins).
  let peak_cell: PeakCell | null = null;
  let peakCount = 0;
  for (const status of INVESTIGATION_STATUSES) {
    const row = rowByStatus.get(status)!;
    for (const bucket of AGE_BUCKETS) {
      const v = row.by_age_bucket[bucket];
      if (v > peakCount) {
        peakCount = v;
        peak_cell = { status, bucket, count: v };
      }
    }
  }
  if (peakCount === 0) peak_cell = null;

  // oldest_open_status: status with most cases in STALE_BUCKETS.
  // Canonical-order tie-break.
  let oldest_open_status: InvestigationAgeStatusMatrix['oldest_open_status'] = null;
  let mostStale = 0;
  for (const status of INVESTIGATION_STATUSES) {
    const row = rowByStatus.get(status)!;
    const stale = STALE_BUCKETS.reduce((acc, b) => acc + row.by_age_bucket[b], 0);
    if (stale > mostStale) {
      mostStale = stale;
      oldest_open_status = { status, stale_count: stale };
    }
  }
  if (mostStale === 0) oldest_open_status = null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_investigations: investigations.length,
    matrix,
    by_age_bucket_total,
    peak_cell,
    oldest_open_status,
  };
}
