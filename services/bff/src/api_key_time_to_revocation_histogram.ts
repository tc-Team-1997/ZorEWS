// services/bff/src/api_key_time_to_revocation_histogram.ts
//
// T6 M1.18 — API key time-to-revocation distribution histogram.
//
// Bucketed view of the revoked-key lifespan distribution
// (revoked_at − created_at). Answers: "what's our typical key
// lifespan? are we revoking keys prematurely (suggests over-
// provisioning)? are most revocations cleanup of never-used keys?"
//
// Distinct from:
//   M1.13 — usage RECENCY histogram (last_used_at vs now; covers
//           active keys' recency; M1.18 covers revoked keys' lifespan)
//   M1.15 — revocation DAILY VOLUME (time-axis trend by date; not a
//           lifespan distribution)
//   M1.17 — per-REVOKER rollup (actor pivot; no lifespan axis)
//
// Mirror of M1.13 / M9.11 / M8.12 / M7.15 bucketing pattern.
// Surfaces 3 key signals for governance:
//   - peak_bucket          → modal key lifespan
//   - shortest_lived       → suspect "rapid revocation" pattern
//   - unused_at_revocation → cleanup-of-stale-keys signal

import {
  type ApiKeyEntry,
  type ApiKeyScope,
  isApiKeyScope,
  VALID_SCOPES,
} from './api_keys';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

export const SAMPLE_KEYS_CAP = 5;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** 5 canonical buckets ordered shortest-first. Each bucket's upper
 *  bound is strict-< (so a key revoked at exactly 7 days lifespan
 *  falls into 7_to_30d, not 1_to_7d). The terminal 90d_plus has no
 *  upper bound. */
export type TimeToRevocationBucket =
  | 'under_1d'
  | '1_to_7d'
  | '7_to_30d'
  | '30_to_90d'
  | '90d_plus';

export const ALL_TIME_TO_REVOCATION_BUCKETS: readonly TimeToRevocationBucket[] = [
  'under_1d',
  '1_to_7d',
  '7_to_30d',
  '30_to_90d',
  '90d_plus',
] as const;

const BUCKET_LABEL: Record<TimeToRevocationBucket, string> = {
  under_1d: 'Under 1 day (rapid revocation — likely incident response)',
  '1_to_7d': '1–7 days (short-term key)',
  '7_to_30d': '7–30 days',
  '30_to_90d': '30–90 days',
  '90d_plus': '90 days or more (long-lived key)',
};

const BUCKET_MIN_DAYS: Record<TimeToRevocationBucket, number> = {
  under_1d: 0,
  '1_to_7d': 1,
  '7_to_30d': 7,
  '30_to_90d': 30,
  '90d_plus': 90,
};

const BUCKET_MAX_DAYS_EXCLUSIVE: Record<TimeToRevocationBucket, number | null> = {
  under_1d: 1,
  '1_to_7d': 7,
  '7_to_30d': 30,
  '30_to_90d': 90,
  '90d_plus': null,
};

/** Pure helper exported for tests. Lifetime in days → bucket. */
export function bucketForLifetime(lifetime_days: number): TimeToRevocationBucket {
  if (lifetime_days < 1) return 'under_1d';
  if (lifetime_days < 7) return '1_to_7d';
  if (lifetime_days < 30) return '7_to_30d';
  if (lifetime_days < 90) return '30_to_90d';
  return '90d_plus';
}

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface SampleKey {
  key_id: string;
  /** Lifetime in days, rounded to 2 decimal places for display. */
  lifetime_days: number;
  revoked_by: string;
  /** When the key was revoked (ISO). */
  revoked_at: string;
  /** Whether the key was ever used before revocation
   *  (last_used_at !== null). */
  ever_used: boolean;
}

export interface TimeToRevocationBucketRow {
  bucket: TimeToRevocationBucket;
  label: string;
  /** Lower bound in days (inclusive). */
  min_days: number;
  /** Upper bound in days (exclusive). null for the terminal 90d_plus. */
  max_days_exclusive: number | null;
  count: number;
  /** Every ApiKeyScope at 0 when absent (stable SPA grid).
   *  Multi-scope keys contribute to each scope independently. */
  by_scope: Record<ApiKeyScope, number>;
  /** Compact map keyed by revoker_username — only revokers with
   *  count > 0 in this bucket appear. */
  by_revoker: Record<string, number>;
  /** Sample keys for SPA drill-into. Cap SAMPLE_KEYS_CAP=5,
   *  sorted lifetime_days asc within bucket (shortest first). */
  sample_keys: SampleKey[];
}

export interface TopLifespanKey {
  key_id: string;
  lifetime_days: number;
  revoked_by: string;
  revoked_at: string;
}

export interface ApiKeyTimeToRevocationHistogram {
  tenant_id: string;
  generated_at: string;
  /** Total revoked keys analyzed (eligible — have valid created + revoked timestamps). */
  total_revoked_analyzed: number;
  /** Revoked keys excluded due to invalid timestamps (defensive count). */
  total_excluded_malformed: number;
  /** Number of distinct revokers across the analyzed keys. */
  total_distinct_revokers: number;
  /** Per-bucket rows in canonical ALL_TIME_TO_REVOCATION_BUCKETS order
   *  — every bucket always emitted even at 0. */
  buckets: TimeToRevocationBucketRow[];
  /**
   * Highest-count bucket. Canonical iteration tie-break (under_1d
   * wins over 1_to_7d at tied count via earlier-bucket-priority).
   * null when total_revoked_analyzed = 0.
   */
  peak_bucket: TimeToRevocationBucket | null;
  peak_count: number;
  /** Mean lifetime across analyzed keys, rounded to 2 decimal places.
   *  null when no analyzed keys. */
  mean_lifetime_days: number | null;
  /** Median (p50). null when no analyzed keys. */
  median_lifetime_days: number | null;
  /** p95. null when no analyzed keys. */
  p95_lifetime_days: number | null;
  /** Shortest-lived revoked key (sample for "rapid revocation"
   *  forensics). null on empty. */
  shortest_lived: TopLifespanKey | null;
  /** Longest-lived revoked key (legacy / "should-have-been-rotated"
   *  signal). null on empty. */
  longest_lived: TopLifespanKey | null;
  /**
   * Count of revoked keys that were NEVER used before revocation
   * (last_used_at === null). Surfaces the cleanup-of-stale-keys
   * pattern — high values suggest over-provisioning.
   */
  unused_at_revocation_count: number;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function zeroByScope(): Record<ApiKeyScope, number> {
  const out = {} as Record<ApiKeyScope, number>;
  for (const s of VALID_SCOPES) out[s] = 0;
  return out;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Linear-interpolation percentile (matches numpy.percentile default
 *  + the M3.5 / M7.15 / B7 audit-activity benchmark convention). */
function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

// ---------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------

export function summarizeApiKeyTimeToRevocation(
  tenant_id: string,
  entries: readonly ApiKeyEntry[],
  now: Date,
): ApiKeyTimeToRevocationHistogram {
  if (!tenant_id || tenant_id.trim() === '') {
    throw new Error('summarizeApiKeyTimeToRevocation: tenant_id required');
  }

  // Pre-build 5 empty bucket states + per-bucket revoker maps + sample arrays
  type BucketState = {
    count: number;
    by_scope: Record<ApiKeyScope, number>;
    by_revoker: Record<string, number>;
    sample_keys: SampleKey[];
  };
  const buckets: Record<TimeToRevocationBucket, BucketState> = {} as never;
  for (const b of ALL_TIME_TO_REVOCATION_BUCKETS) {
    buckets[b] = {
      count: 0,
      by_scope: zeroByScope(),
      by_revoker: {},
      sample_keys: [],
    };
  }

  const lifetimes: number[] = [];
  const revokersSet = new Set<string>();
  let total_revoked_analyzed = 0;
  let total_excluded_malformed = 0;
  let unused_at_revocation_count = 0;
  let shortest_lived: TopLifespanKey | null = null;
  let longest_lived: TopLifespanKey | null = null;

  for (const entry of entries) {
    if (entry.status !== 'revoked') continue;
    if (!entry.revoked_at || !entry.revoked_by) {
      total_excluded_malformed += 1;
      continue;
    }
    const createdMs = Date.parse(entry.created_at);
    const revokedMs = Date.parse(entry.revoked_at);
    if (!Number.isFinite(createdMs) || !Number.isFinite(revokedMs)) {
      total_excluded_malformed += 1;
      continue;
    }
    // Defensive: revoked-before-created is nonsensical → exclude.
    if (revokedMs < createdMs) {
      total_excluded_malformed += 1;
      continue;
    }

    const lifetime_days_raw = (revokedMs - createdMs) / DAY_MS;
    const lifetime_days = round2(lifetime_days_raw);
    const bucket = bucketForLifetime(lifetime_days_raw);
    const state = buckets[bucket];

    state.count += 1;
    for (const s of entry.scopes ?? []) {
      if (isApiKeyScope(s)) state.by_scope[s] += 1;
    }
    state.by_revoker[entry.revoked_by] =
      (state.by_revoker[entry.revoked_by] ?? 0) + 1;

    const ever_used = entry.last_used_at !== null;
    if (!ever_used) unused_at_revocation_count += 1;

    state.sample_keys.push({
      key_id: entry.key_id,
      lifetime_days,
      revoked_by: entry.revoked_by,
      revoked_at: entry.revoked_at,
      ever_used,
    });

    lifetimes.push(lifetime_days_raw);
    revokersSet.add(entry.revoked_by);
    total_revoked_analyzed += 1;

    // Track shortest + longest lived
    const topLife: TopLifespanKey = {
      key_id: entry.key_id,
      lifetime_days,
      revoked_by: entry.revoked_by,
      revoked_at: entry.revoked_at,
    };
    if (!shortest_lived || lifetime_days_raw < shortest_lived.lifetime_days) {
      shortest_lived = topLife;
    }
    if (!longest_lived || lifetime_days_raw > longest_lived.lifetime_days) {
      longest_lived = topLife;
    }
  }

  // Finalize per-bucket: sort + cap sample_keys
  const bucketRows: TimeToRevocationBucketRow[] = ALL_TIME_TO_REVOCATION_BUCKETS.map(
    (bucket) => {
      const state = buckets[bucket];
      const sorted_samples = [...state.sample_keys].sort(
        (a, b) => a.lifetime_days - b.lifetime_days,
      );
      return {
        bucket,
        label: BUCKET_LABEL[bucket],
        min_days: BUCKET_MIN_DAYS[bucket],
        max_days_exclusive: BUCKET_MAX_DAYS_EXCLUSIVE[bucket],
        count: state.count,
        by_scope: state.by_scope,
        by_revoker: state.by_revoker,
        sample_keys: sorted_samples.slice(0, SAMPLE_KEYS_CAP),
      };
    },
  );

  // peak_bucket: canonical iteration tie-break (earlier wins at tied)
  let peak_bucket: TimeToRevocationBucket | null = null;
  let peak_count = 0;
  if (total_revoked_analyzed > 0) {
    for (const row of bucketRows) {
      if (row.count > peak_count) {
        peak_count = row.count;
        peak_bucket = row.bucket;
      }
    }
  }

  // Percentiles
  const sortedLifetimes = [...lifetimes].sort((a, b) => a - b);
  const mean_lifetime_days =
    sortedLifetimes.length === 0
      ? null
      : round2(sortedLifetimes.reduce((a, b) => a + b, 0) / sortedLifetimes.length);
  const median_lifetime_days =
    sortedLifetimes.length === 0 ? null : round2(percentile(sortedLifetimes, 0.5));
  const p95_lifetime_days =
    sortedLifetimes.length === 0 ? null : round2(percentile(sortedLifetimes, 0.95));

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_revoked_analyzed,
    total_excluded_malformed,
    total_distinct_revokers: revokersSet.size,
    buckets: bucketRows,
    peak_bucket,
    peak_count,
    mean_lifetime_days,
    median_lifetime_days,
    p95_lifetime_days,
    shortest_lived,
    longest_lived,
    unused_at_revocation_count,
  };
}
