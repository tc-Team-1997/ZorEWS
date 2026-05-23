// services/bff/src/tenant_onboarding_velocity.ts
//
// T6 M2.19 — Tenant onboarding velocity rollup.
//
// Per-tenant velocity view: how fast did each tenant move from their
// first onboarding action to either completion or "still in progress"?
// Drives SaaS admin governance: "which tenants stalled? which onboarded
// in under a week? what's the median time-to-onboard across the fleet?"
//
// 5 canonical velocity buckets in completion-speed order:
//   fast        — completed in < 7 days (smooth rollout)
//   normal      — completed in [7d, 30d)
//   slow        — completed in [30d, 90d) (concerning)
//   stalled     — > 90d (whether complete or in-progress)
//   not_started — no completed/skipped steps yet
//
// Strict-< upper bound semantics on every non-stalled completion
// bucket (7d exactly → normal, 30d → slow, 90d → stalled; matches
// the M9.19 / M8.12 boundary convention).
//
// Distinct from:
//   M2.6  — readiness score (snapshot completeness; no time axis)
//   M2.8  — projected ETA (forward-looking projection per tenant)
//   M2.11 — milestone (categorical stage; not velocity)
//   M2.12 — fleet overview (per-tenant snapshot; no velocity bucket)
//   M2.13 — per-step completion ranking (which step is the bottleneck)
//   M2.15 — fleet actor activity (per-actor pivot)
//   M2.16 — completion daily timeline (cross-tenant trend over time)
//   M2.17 — stage × vertical matrix
//   M2.18 — skip-reason analytics
//
// Mirror of M9.19 (investigation duration histogram) for the tenant
// onboarding surface — answers "what's our typical time-to-onboard
// and where do tenants stall?" in one round-trip.

import {
  ONBOARDING_STEPS,
  type OnboardingState,
} from './tenant_onboarding';
import type { Tenant } from './tenant';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

export type OnboardingVelocityBucket =
  | 'fast'
  | 'normal'
  | 'slow'
  | 'stalled'
  | 'not_started';

export const ALL_ONBOARDING_VELOCITY_BUCKETS: readonly OnboardingVelocityBucket[] = [
  'fast',
  'normal',
  'slow',
  'stalled',
  'not_started',
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const FAST_DAYS = 7;
const NORMAL_DAYS = 30;
const STALLED_DAYS = 90;

export const SAMPLE_TENANTS_CAP = 3;

interface BucketMeta {
  bucket: OnboardingVelocityBucket;
  label: string;
  /** Inclusive lower bound in days; null for not_started. */
  min_days: number | null;
  /** Exclusive upper bound in days; null for stalled (open-ended)
   *  and not_started (no completion in scope). */
  max_days: number | null;
}

const BUCKET_DEFS: readonly BucketMeta[] = [
  { bucket: 'fast', label: '< 7 days', min_days: 0, max_days: FAST_DAYS },
  { bucket: 'normal', label: '7-30 days', min_days: FAST_DAYS, max_days: NORMAL_DAYS },
  { bucket: 'slow', label: '30-90 days', min_days: NORMAL_DAYS, max_days: STALLED_DAYS },
  { bucket: 'stalled', label: '90 days+', min_days: STALLED_DAYS, max_days: null },
  { bucket: 'not_started', label: 'No activity', min_days: null, max_days: null },
] as const;

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Days between two ISO timestamps. Returns null if either is
 *  unparseable. Always non-negative (clamped). */
function daysBetween(earlier: string | null, later: string | null): number | null {
  if (!earlier || !later) return null;
  const e = Date.parse(earlier);
  const l = Date.parse(later);
  if (!Number.isFinite(e) || !Number.isFinite(l)) return null;
  return Math.max(0, (l - e) / DAY_MS);
}

/** Bucket a duration in days. is_complete distinguishes velocity for
 *  completed tenants vs in-progress.
 *  - in-progress + ≥ STALLED_DAYS → 'stalled'
 *  - in-progress + < STALLED_DAYS → null (in progress but not yet
 *    stalled — caller treats this as having no velocity yet) */
export function bucketForVelocity(
  days: number | null,
  is_complete: boolean,
): OnboardingVelocityBucket {
  if (days === null) return 'not_started';
  if (!is_complete) {
    // In-progress: only 'stalled' or no-bucket (we treat <stalled as
    // 'not_started' for the cohort summary so they don't pollute
    // completion-speed buckets, but their elapsed days still show)
    return days >= STALLED_DAYS ? 'stalled' : 'not_started';
  }
  // Completed
  if (days < FAST_DAYS) return 'fast';
  if (days < NORMAL_DAYS) return 'normal';
  if (days < STALLED_DAYS) return 'slow';
  return 'stalled';
}

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface TenantVelocityRow {
  tenant_id: string;
  tenant_name: string | null;
  is_complete: boolean;
  /** ISO of earliest completed_at across the tenant's completed
   *  steps. null when no completed step has a timestamp. */
  first_action_at: string | null;
  /** ISO of newest completed_at. null when no completed step has
   *  a timestamp. */
  last_action_at: string | null;
  /** Days between first_action_at and last_action_at (for complete
   *  tenants) OR first_action_at → now (for in-progress with
   *  activity). null when never_started OR no timestamped actions. */
  duration_days: number | null;
  /** Velocity bucket per the bucketing helper. */
  velocity_bucket: OnboardingVelocityBucket;
  /** Count of completed steps. */
  completed_steps: number;
  /** Count of skipped steps. */
  skipped_steps: number;
}

export interface VelocityBucketRow {
  bucket: OnboardingVelocityBucket;
  label: string;
  min_days: number | null;
  max_days: number | null;
  count: number;
  /** Cap 3 tenant ids in this bucket. For complete buckets sorted by
   *  duration_days asc (fastest first). For stalled sorted by
   *  duration_days desc (worst first). For not_started sorted by
   *  tenant_id asc. */
  sample_tenant_ids: string[];
}

export interface OnboardingVelocityRollup {
  generated_at: string;
  total_tenants: number;
  total_complete: number;
  total_in_progress: number;
  total_not_started: number;
  buckets: VelocityBucketRow[];
  tenants: TenantVelocityRow[];
  /** Mean days-to-complete across COMPLETED tenants only. null when
   *  no tenant has completed. Rounded to 2 decimals. */
  mean_completion_days: number | null;
  /** Min days-to-complete (= fastest tenant); null when no completed. */
  min_completion_days: number | null;
  /** Max days-to-complete (= slowest completed tenant). */
  max_completion_days: number | null;
  /** Fastest completed tenant. null when no completed. */
  fastest_tenant: TenantVelocityRow | null;
  /** Slowest completed tenant. null when no completed. */
  slowest_tenant: TenantVelocityRow | null;
  /** Most-stalled in-progress tenant (highest duration_days among
   *  in-progress + ≥ STALLED_DAYS). null when no stalled. */
  most_stalled_tenant: TenantVelocityRow | null;
  /** peak_bucket via canonical iteration; null when no tenants. */
  peak_bucket: OnboardingVelocityBucket | null;
  peak_count: number;
}

// ---------------------------------------------------------------------
// Pure resolver
// ---------------------------------------------------------------------

/** Compute (first_action_at, last_action_at) from the state's steps. */
function bookendTimestamps(state: OnboardingState): {
  first: string | null;
  last: string | null;
  completed: number;
  skipped: number;
} {
  let first: string | null = null;
  let firstMs = Infinity;
  let last: string | null = null;
  let lastMs = -Infinity;
  let completed = 0;
  let skipped = 0;
  for (const step of state.steps) {
    if (step.status === 'completed') completed += 1;
    else if (step.status === 'skipped') skipped += 1;
    if (!step.completed_at) continue;
    const ms = Date.parse(step.completed_at);
    if (!Number.isFinite(ms)) continue;
    if (ms < firstMs) {
      firstMs = ms;
      first = step.completed_at;
    }
    if (ms > lastMs) {
      lastMs = ms;
      last = step.completed_at;
    }
  }
  return { first, last, completed, skipped };
}

/** Required-only completion check (mirror of M2.6 logic — every
 *  required step in 'completed' status). */
function isFullyComplete(state: OnboardingState): boolean {
  const requiredIds = new Set(
    ONBOARDING_STEPS.filter((s) => s.required).map((s) => s.id),
  );
  for (const step of state.steps) {
    if (!requiredIds.has(step.step_id)) continue;
    if (step.status !== 'completed') return false;
  }
  return true;
}

export function summarizeOnboardingVelocity(
  fleet: readonly { tenant: Tenant; state: OnboardingState }[],
  now: Date,
): OnboardingVelocityRollup {
  const rows: TenantVelocityRow[] = [];
  const completedDurations: number[] = [];

  for (const { tenant, state } of fleet) {
    const { first, last, completed, skipped } = bookendTimestamps(state);
    const is_complete = isFullyComplete(state);
    // duration_days:
    //   if completed: last - first (when both present), else null
    //   if in progress with timestamped actions: now - first
    //   otherwise: null
    let duration_days: number | null = null;
    if (is_complete) {
      duration_days = daysBetween(first, last);
    } else if (first) {
      duration_days = daysBetween(first, now.toISOString());
    }
    const velocity_bucket = bucketForVelocity(duration_days, is_complete);
    const row: TenantVelocityRow = {
      tenant_id: tenant.tenant_id,
      tenant_name: tenant.name ?? null,
      is_complete,
      first_action_at: first,
      last_action_at: last,
      duration_days: duration_days === null ? null : Math.round(duration_days * 100) / 100,
      velocity_bucket,
      completed_steps: completed,
      skipped_steps: skipped,
    };
    rows.push(row);
    if (is_complete && duration_days !== null) {
      completedDurations.push(duration_days);
    }
  }

  // Build per-bucket counts + sample tenant_ids
  const bucketCounts = new Map<OnboardingVelocityBucket, number>();
  const bucketSamples = new Map<OnboardingVelocityBucket, TenantVelocityRow[]>();
  for (const b of BUCKET_DEFS) {
    bucketCounts.set(b.bucket, 0);
    bucketSamples.set(b.bucket, []);
  }
  for (const row of rows) {
    bucketCounts.set(row.velocity_bucket, (bucketCounts.get(row.velocity_bucket) ?? 0) + 1);
    bucketSamples.get(row.velocity_bucket)!.push(row);
  }

  // Per-bucket sample sort + cap
  for (const [bucket, arr] of bucketSamples.entries()) {
    if (bucket === 'not_started') {
      arr.sort((a, b) => a.tenant_id.localeCompare(b.tenant_id));
    } else if (bucket === 'stalled') {
      arr.sort((a, b) => {
        const da = a.duration_days ?? 0;
        const db = b.duration_days ?? 0;
        if (db !== da) return db - da;
        return a.tenant_id.localeCompare(b.tenant_id);
      });
    } else {
      // fast / normal / slow — fastest first
      arr.sort((a, b) => {
        const da = a.duration_days ?? 0;
        const db = b.duration_days ?? 0;
        if (da !== db) return da - db;
        return a.tenant_id.localeCompare(b.tenant_id);
      });
    }
    if (arr.length > SAMPLE_TENANTS_CAP) arr.length = SAMPLE_TENANTS_CAP;
  }

  const buckets: VelocityBucketRow[] = BUCKET_DEFS.map((meta) => ({
    bucket: meta.bucket,
    label: meta.label,
    min_days: meta.min_days,
    max_days: meta.max_days,
    count: bucketCounts.get(meta.bucket) ?? 0,
    sample_tenant_ids: (bucketSamples.get(meta.bucket) ?? []).map((r) => r.tenant_id),
  }));

  // peak_bucket via canonical iteration (strict > so first wins on ties)
  let peak_bucket: OnboardingVelocityBucket | null = null;
  let peak_count = 0;
  for (const row of buckets) {
    if (row.count > peak_count) {
      peak_count = row.count;
      peak_bucket = row.bucket;
    }
  }
  if (peak_count === 0) peak_bucket = null;

  // Aggregate stats over completed durations
  let mean_completion_days: number | null = null;
  let min_completion_days: number | null = null;
  let max_completion_days: number | null = null;
  let fastest_tenant: TenantVelocityRow | null = null;
  let slowest_tenant: TenantVelocityRow | null = null;

  if (completedDurations.length > 0) {
    const sum = completedDurations.reduce((acc, d) => acc + d, 0);
    mean_completion_days = Math.round((sum / completedDurations.length) * 100) / 100;
    min_completion_days = Math.round(Math.min(...completedDurations) * 100) / 100;
    max_completion_days = Math.round(Math.max(...completedDurations) * 100) / 100;
    for (const row of rows) {
      if (!row.is_complete || row.duration_days === null) continue;
      if (fastest_tenant === null || row.duration_days < (fastest_tenant.duration_days ?? Infinity)) {
        fastest_tenant = row;
      }
      if (slowest_tenant === null || row.duration_days > (slowest_tenant.duration_days ?? -Infinity)) {
        slowest_tenant = row;
      }
    }
  }

  // Most stalled in-progress tenant
  let most_stalled_tenant: TenantVelocityRow | null = null;
  for (const row of rows) {
    if (row.is_complete) continue;
    if (row.velocity_bucket !== 'stalled') continue;
    if (row.duration_days === null) continue;
    if (
      most_stalled_tenant === null ||
      row.duration_days > (most_stalled_tenant.duration_days ?? -Infinity)
    ) {
      most_stalled_tenant = row;
    }
  }

  const total_complete = rows.filter((r) => r.is_complete).length;
  const total_not_started = rows.filter(
    (r) => r.velocity_bucket === 'not_started' && !r.is_complete,
  ).length;
  const total_in_progress = rows.length - total_complete - total_not_started;

  return {
    generated_at: now.toISOString(),
    total_tenants: rows.length,
    total_complete,
    total_in_progress,
    total_not_started,
    buckets,
    tenants: rows,
    mean_completion_days,
    min_completion_days,
    max_completion_days,
    fastest_tenant,
    slowest_tenant,
    most_stalled_tenant,
    peak_bucket,
    peak_count,
  };
}
