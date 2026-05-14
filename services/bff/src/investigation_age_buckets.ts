// services/bff/src/investigation_age_buckets.ts
//
// T6 M9.11 — Investigation age-bucket distribution.
//
// M9.8 ships cohort means; M9.9 ships step-level progress. M9.11
// surfaces age distribution: how many investigations are in each
// of the 5 standard age buckets (0-24h / 1-3d / 3-7d / 7-30d /
// 30d+). Lets the SPA render an aging-pyramid bar chart with
// drill-through samples per bucket ("here are the 3 oldest cases
// in the 30+d bucket → click to investigate").
//
// Pure — no I/O. Caller passes the loaded investigations.

import type { CaseInvestigation } from './case_investigation';

// ─── Public types ─────────────────────────────────────────────────────

export type AgeBucketKey =
  | 'under_24h'
  | '1_to_3d'
  | '3_to_7d'
  | '7_to_30d'
  | '30d_plus';

export interface AgeBucketSample {
  investigation_id: string;
  case_id: string;
  opened_at: string;
  age_hours: number;
}

export interface AgeBucket {
  bucket: AgeBucketKey;
  /** Human-readable label for SPA. */
  label: string;
  /** Inclusive hour-of-age lower bound. 0 for the 0-24h bucket. */
  min_hours: number;
  /** Exclusive hour-of-age upper bound. null for the open-ended
   *  30d+ bucket. */
  max_hours: number | null;
  count: number;
  /** Up to 3 oldest investigations in the bucket — drill-through
   *  pointers. Empty when count=0. */
  samples: AgeBucketSample[];
}

export interface InvestigationAgeDistribution {
  generated_at: string;
  /** Number of investigations classified (open + closed; both have
   *  an opened_at). */
  total_investigations: number;
  /** Sample = the 3 oldest per bucket; cap honoured even when
   *  count > 3. */
  sample_cap_per_bucket: number;
  buckets: AgeBucket[];
}

const SAMPLE_CAP = 3;

const BUCKET_DEFS: ReadonlyArray<
  Omit<AgeBucket, 'count' | 'samples'>
> = [
  { bucket: 'under_24h', label: '< 24h', min_hours: 0, max_hours: 24 },
  { bucket: '1_to_3d', label: '1-3 days', min_hours: 24, max_hours: 72 },
  { bucket: '3_to_7d', label: '3-7 days', min_hours: 72, max_hours: 168 },
  { bucket: '7_to_30d', label: '7-30 days', min_hours: 168, max_hours: 720 },
  { bucket: '30d_plus', label: '30+ days', min_hours: 720, max_hours: null },
];

// ─── Pure binner ──────────────────────────────────────────────────────

function bucketFor(age_hours: number): AgeBucketKey {
  if (age_hours < 24) return 'under_24h';
  if (age_hours < 72) return '1_to_3d';
  if (age_hours < 168) return '3_to_7d';
  if (age_hours < 720) return '7_to_30d';
  return '30d_plus';
}

export function bucketInvestigationsByAge(
  investigations: readonly CaseInvestigation[],
  now: Date,
): InvestigationAgeDistribution {
  // Initialise buckets with empty counts + samples.
  const buckets: AgeBucket[] = BUCKET_DEFS.map((def) => ({
    ...def,
    count: 0,
    samples: [],
  }));
  const byKey = new Map<AgeBucketKey, AgeBucket>();
  for (const b of buckets) byKey.set(b.bucket, b);

  // Track all candidates per bucket so we can pick top-3 oldest.
  const candidates = new Map<AgeBucketKey, AgeBucketSample[]>();
  for (const k of byKey.keys()) candidates.set(k, []);

  const nowMs = now.getTime();
  for (const inv of investigations) {
    const openedMs = new Date(inv.opened_at).getTime();
    const age_hours = Math.max(0, (nowMs - openedMs) / 3_600_000);
    const key = bucketFor(age_hours);
    const bucket = byKey.get(key)!;
    bucket.count += 1;
    candidates.get(key)!.push({
      investigation_id: inv.investigation_id,
      case_id: inv.case_id,
      opened_at: inv.opened_at,
      age_hours,
    });
  }

  // For each bucket, pick the top-SAMPLE_CAP oldest (highest age).
  for (const [key, list] of candidates) {
    list.sort((a, b) => {
      if (b.age_hours !== a.age_hours) return b.age_hours - a.age_hours;
      return a.investigation_id < b.investigation_id ? -1 : 1;
    });
    byKey.get(key)!.samples = list.slice(0, SAMPLE_CAP);
  }

  return {
    generated_at: now.toISOString(),
    total_investigations: investigations.length,
    sample_cap_per_bucket: SAMPLE_CAP,
    buckets,
  };
}
