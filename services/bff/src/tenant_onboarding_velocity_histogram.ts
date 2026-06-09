// tenant_onboarding_velocity_histogram.ts
//
// T6 M2.20 — Tenant onboarding velocity histogram.
// Buckets tenants by how many days they took to complete onboarding.
// Mirror of M9.19 (investigation duration) + M7.15 (promotion latency) pattern
// for the onboarding surface.


// ─── Types ─────────────────────────────────────────────────────────────────

export type VelocityBucket = 'same_day' | 'within_3d' | 'within_7d' | 'within_30d' | 'beyond_30d' | 'incomplete';

export const ALL_VELOCITY_BUCKETS: readonly VelocityBucket[] = [
  'same_day', 'within_3d', 'within_7d', 'within_30d', 'beyond_30d', 'incomplete',
];

export interface VelocityBucketMeta {
  bucket:    VelocityBucket;
  label:     string;
  min_days:  number | null;
  max_days:  number | null;
}

export const VELOCITY_BUCKET_META: Record<VelocityBucket, VelocityBucketMeta> = {
  same_day:    { bucket: 'same_day',    label: 'Same Day',        min_days: 0,    max_days: 0 },
  within_3d:   { bucket: 'within_3d',   label: 'Within 3 Days',   min_days: 1,    max_days: 3 },
  within_7d:   { bucket: 'within_7d',   label: 'Within 7 Days',   min_days: 4,    max_days: 7 },
  within_30d:  { bucket: 'within_30d',  label: 'Within 30 Days',  min_days: 8,    max_days: 30 },
  beyond_30d:  { bucket: 'beyond_30d',  label: 'Beyond 30 Days',  min_days: 31,   max_days: null },
  incomplete:  { bucket: 'incomplete',  label: 'Not Completed',   min_days: null, max_days: null },
};

export interface VelocityHistogramBucket {
  bucket:       VelocityBucket;
  label:        string;
  min_days:     number | null;
  max_days:     number | null;
  count:        number;
  sample_tenant_ids: string[];  // cap 3
}

export interface TenantOnboardingVelocityHistogram {
  generated_at:   string;
  total_tenants:  number;
  completed_count: number;
  incomplete_count: number;
  mean_days:      number | null;  // across completed only
  median_days:    number | null;
  fastest_days:   number | null;
  slowest_days:   number | null;
  buckets:        VelocityHistogramBucket[];  // 6 in canonical order
  peak_bucket:    VelocityBucket | null;
  peak_count:     number;
}

// ─── Tenant input shape ─────────────────────────────────────────────────────

export interface TenantVelocityInput {
  tenant_id:     string;
  provisioned_at: string;  // ISO
  completed_at:  string | null;  // null if not completed
}

// ─── Bucket function ────────────────────────────────────────────────────────

export function bucketForVelocityDays(days: number | null): VelocityBucket {
  if (days === null) return 'incomplete';
  if (days <= 0)  return 'same_day';
  if (days <= 3)  return 'within_3d';
  if (days <= 7)  return 'within_7d';
  if (days <= 30) return 'within_30d';
  return 'beyond_30d';
}

// ─── Percentile ────────────────────────────────────────────────────────────

function p50(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 100) / 100
    : sorted[mid]!;
}

// ─── Main function ──────────────────────────────────────────────────────────

export function buildTenantOnboardingVelocityHistogram(
  tenants: TenantVelocityInput[],
  now: Date,
): TenantOnboardingVelocityHistogram {
  const generated_at = now.toISOString();
  const SAMPLE_CAP = 3;

  const counts: Record<VelocityBucket, number> = {
    same_day: 0, within_3d: 0, within_7d: 0, within_30d: 0, beyond_30d: 0, incomplete: 0,
  };
  const samples: Record<VelocityBucket, string[]> = {
    same_day: [], within_3d: [], within_7d: [], within_30d: [], beyond_30d: [], incomplete: [],
  };
  const completedDays: number[] = [];

  for (const t of tenants) {
    let days: number | null = null;
    if (t.completed_at) {
      const prov = new Date(t.provisioned_at).getTime();
      const comp = new Date(t.completed_at).getTime();
      if (!isNaN(prov) && !isNaN(comp)) {
        days = Math.max(0, Math.floor((comp - prov) / 86_400_000));
        completedDays.push(days);
      }
    }
    const bucket = bucketForVelocityDays(days);
    counts[bucket]++;
    if (samples[bucket].length < SAMPLE_CAP) samples[bucket].push(t.tenant_id);
  }

  const sortedDays = [...completedDays].sort((a, b) => a - b);
  const mean = sortedDays.length > 0
    ? Math.round((sortedDays.reduce((s, d) => s + d, 0) / sortedDays.length) * 100) / 100
    : null;

  // Peak bucket (canonical order, strict >)
  let peakBucket: VelocityBucket | null = null;
  let peakCount = 0;
  for (const b of ALL_VELOCITY_BUCKETS) {
    if (counts[b] > peakCount) { peakBucket = b; peakCount = counts[b]; }
  }

  const buckets: VelocityHistogramBucket[] = ALL_VELOCITY_BUCKETS.map(b => ({
    ...VELOCITY_BUCKET_META[b],
    count: counts[b],
    sample_tenant_ids: samples[b],
  }));

  return {
    generated_at,
    total_tenants:    tenants.length,
    completed_count:  completedDays.length,
    incomplete_count: counts.incomplete,
    mean_days:        mean,
    median_days:      p50(sortedDays),
    fastest_days:     sortedDays[0] ?? null,
    slowest_days:     sortedDays[sortedDays.length - 1] ?? null,
    buckets,
    peak_bucket:      peakBucket,
    peak_count:       peakCount,
  };
}
