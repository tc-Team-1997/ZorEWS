// services/bff/src/api_key_usage_recency_histogram.ts
//
// T6 M1.13 — API key usage recency histogram.
//
// M1.4 ships per-key usage analytics. M1.9 ships daily creation volume.
// M1.10 ships lifecycle stage distribution (priority-ordered first-match
// classification: revoked > expired > expiring_soon > idle > dormant >
// fresh > mature). M1.11/M1.12 ship 2D cross-tabs.
//
// M1.13 ships a purely TIME-BASED recency histogram orthogonal to the
// rule-based M1.10 classifier. 6 canonical buckets in priority order
// of operational concern:
//
//   - revoked        (status='revoked' — usage history irrelevant)
//   - never_used     (active + last_used_at=null — provisioned but
//                     never called; rotation candidate after some time)
//   - used_within_7d (active + last_used_at < 7d ago — hot keys)
//   - used_within_30d(active + 7d ≤ last_used < 30d)
//   - used_within_90d(active + 30d ≤ last_used < 90d)
//   - stale          (active + last_used_at ≥ 90d ago — likely
//                     forgotten / cleanup candidate)
//
// Per-bucket: {count, by_scope (every VALID_SCOPES at 0), distinct_creators,
// sample_key_ids cap 5 sorted asc}. Envelope: peak_bucket (canonical
// iteration tie-break: revoked wins at tied count), unused_buckets[]
// (zero-count subset in canonical order), total_active_keys,
// total_revoked_keys.
//
// Companion to M1.10 (rule-based first-match buckets) — M1.13 is the
// pure recency view answering "what's our actual usage SHAPE?"
//
// Mirror of M9.11 / M8.12 / M7.15 / M4.15 / M5.18 histogram pattern.

import {
  VALID_SCOPES,
  type ApiKeyEntry,
  type ApiKeyScope,
} from './api_keys';

const MS_PER_DAY = 86_400_000;

// ─── Public types ──────────────────────────────────────────────────────

export type UsageRecencyBucket =
  | 'revoked'
  | 'never_used'
  | 'used_within_7d'
  | 'used_within_30d'
  | 'used_within_90d'
  | 'stale';

export const ALL_USAGE_RECENCY_BUCKETS: readonly UsageRecencyBucket[] = [
  'revoked',
  'never_used',
  'used_within_7d',
  'used_within_30d',
  'used_within_90d',
  'stale',
] as const;

export interface UsageRecencyBucketRow {
  bucket: UsageRecencyBucket;
  label: string;
  count: number;
  /** Per-scope counts — every VALID_SCOPES at 0 when absent. Multi-scope
   *  keys contribute to every listed scope. */
  by_scope: Record<ApiKeyScope, number>;
  /** Distinct creators (deduped) contributing to this bucket. */
  distinct_creators: number;
  /** Sample key_ids cap 5 sorted asc (deterministic display). */
  sample_key_ids: string[];
}

export interface ApiKeyUsageRecencyHistogram {
  tenant_id: string;
  generated_at: string;
  total_keys: number;
  total_active_keys: number;
  total_revoked_keys: number;
  buckets: UsageRecencyBucketRow[];
  /** Highest-count bucket; canonical iteration tie-break: revoked wins
   *  over never_used at tied count; null when zero keys. */
  peak_bucket: UsageRecencyBucket | null;
  peak_count: number;
  /** Zero-count buckets in canonical order. */
  unused_buckets: UsageRecencyBucket[];
  /** Active-only "attention" buckets (never_used + used_within_90d /
   *  stale partition — surfaces "what fraction of active keys are
   *  ACTUALLY being used recently?"). */
  total_active_used_recently_count: number; // used_within_7d + 30d + 90d
  total_active_stale_or_never_count: number; // never_used + stale
}

// ─── Bucket boundaries ─────────────────────────────────────────────────

const BUCKET_LABEL: Record<UsageRecencyBucket, string> = {
  revoked: 'Revoked',
  never_used: 'Never used',
  used_within_7d: 'Used within 7d',
  used_within_30d: 'Used 7-30d ago',
  used_within_90d: 'Used 30-90d ago',
  stale: 'Stale (90d+)',
};

/** Pure helper — classify an API key by its usage recency. */
export function bucketForUsageRecency(
  entry: ApiKeyEntry,
  now: Date,
): UsageRecencyBucket {
  if (entry.status === 'revoked') return 'revoked';
  if (!entry.last_used_at) return 'never_used';
  const ageMs = now.getTime() - new Date(entry.last_used_at).getTime();
  const ageDays = ageMs / MS_PER_DAY;
  if (ageDays < 7) return 'used_within_7d';
  if (ageDays < 30) return 'used_within_30d';
  if (ageDays < 90) return 'used_within_90d';
  return 'stale';
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByScope(): Record<ApiKeyScope, number> {
  const out = {} as Record<ApiKeyScope, number>;
  for (const s of VALID_SCOPES) out[s] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildApiKeyUsageRecencyHistogram(
  tenant_id: string,
  entries: readonly ApiKeyEntry[],
  now: Date,
): ApiKeyUsageRecencyHistogram {
  type BucketAgg = {
    keys: ApiKeyEntry[];
    by_scope: Record<ApiKeyScope, number>;
    creators: Set<string>;
  };
  const buckets: Record<UsageRecencyBucket, BucketAgg> = {} as never;
  for (const b of ALL_USAGE_RECENCY_BUCKETS) {
    buckets[b] = {
      keys: [],
      by_scope: emptyByScope(),
      creators: new Set<string>(),
    };
  }

  let total_active_keys = 0;
  let total_revoked_keys = 0;

  for (const entry of entries) {
    const bucket = bucketForUsageRecency(entry, now);
    const agg = buckets[bucket];
    agg.keys.push(entry);
    if (entry.created_by) agg.creators.add(entry.created_by);

    // Defensive intra-key scope dedup + closed-enum filter.
    const seen = new Set<ApiKeyScope>();
    for (const scope of entry.scopes) {
      if (VALID_SCOPES.includes(scope) && !seen.has(scope)) {
        seen.add(scope);
        agg.by_scope[scope]++;
      }
    }

    if (entry.status === 'revoked') total_revoked_keys++;
    else total_active_keys++;
  }

  const bucketRows: UsageRecencyBucketRow[] = ALL_USAGE_RECENCY_BUCKETS.map(
    (b) => {
      const agg = buckets[b];
      const sample_key_ids = agg.keys
        .map((k) => k.key_id)
        .sort((a, c) => a.localeCompare(c))
        .slice(0, 5);
      return {
        bucket: b,
        label: BUCKET_LABEL[b],
        count: agg.keys.length,
        by_scope: agg.by_scope,
        distinct_creators: agg.creators.size,
        sample_key_ids,
      };
    },
  );

  // peak_bucket — highest count; canonical iteration tie-break.
  let peak_bucket: UsageRecencyBucket | null = null;
  let peak_count = 0;
  for (const row of bucketRows) {
    if (row.count > peak_count) {
      peak_count = row.count;
      peak_bucket = row.bucket;
    }
  }

  const unused_buckets = bucketRows
    .filter((r) => r.count === 0)
    .map((r) => r.bucket);

  // Convenience active-only partitions for attention surface.
  const get = (b: UsageRecencyBucket) => buckets[b].keys.length;
  const total_active_used_recently_count =
    get('used_within_7d') + get('used_within_30d') + get('used_within_90d');
  const total_active_stale_or_never_count =
    get('never_used') + get('stale');

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_keys: entries.length,
    total_active_keys,
    total_revoked_keys,
    buckets: bucketRows,
    peak_bucket,
    peak_count,
    unused_buckets,
    total_active_used_recently_count,
    total_active_stale_or_never_count,
  };
}
