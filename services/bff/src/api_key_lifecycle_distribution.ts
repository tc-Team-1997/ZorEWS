// services/bff/src/api_key_lifecycle_distribution.ts
//
// T6 M1.10 — API key lifecycle stage distribution.
//
// M1.4 ships per-key usage analytics with discrete flags (expires_soon,
// is_dormant, is_idle_never_used, is_expired). M1.5/M1.6/M1.8 ship
// pivots by scope/creator/status. M1.9 ships daily volume of creations.
//
// M1.10 lands a different lens: bucket each key into ONE OF 6 canonical
// lifecycle stages so ops can see at a glance "how many keys are in
// each operational state?":
//   fresh             active + < 7 days old + never used (waiting for first call)
//   mature_active     active + ever used + ≥ 1 use within 30d
//   dormant           active + ever used + last use > 30d ago
//   idle_never_used   active + never used + ≥ 30 days old (forgotten)
//   expiring_soon     active + expires_at within 30d window
//   expired           active + expires_at in the past
//   revoked           status=revoked (terminal)
//
// Note: a single key could match multiple flags (e.g. dormant AND
// expiring_soon). To produce a single-bucket classification, we apply
// the stages in priority order: revoked > expired > expiring_soon >
// idle_never_used > dormant > fresh > mature_active. Revoked is
// terminal, so it always wins. expired captures keys that should be
// rotated NOW. expiring_soon captures keys to plan rotation for.
// dormant warns about access keys no one is using. fresh is the
// default for new keys. mature_active is the steady-state.
//
// Mirror of M9.11 (case age buckets) / M4.15 (indicator weight
// histogram) / M7.15 (latency histogram) bucketing pattern for the
// API key surface.
//
// Pure resolver — reads the M1.2 redacted ApiKeyEntry list directly.

import type { ApiKeyEntry } from './api_keys';

// ─── Canonical stages (priority order — first match wins) ────────────

export type ApiKeyLifecycleStage =
  | 'revoked'
  | 'expired'
  | 'expiring_soon'
  | 'idle_never_used'
  | 'dormant'
  | 'fresh'
  | 'mature_active';

export const ALL_API_KEY_LIFECYCLE_STAGES: readonly ApiKeyLifecycleStage[] = [
  'revoked',
  'expired',
  'expiring_soon',
  'idle_never_used',
  'dormant',
  'fresh',
  'mature_active',
] as const;

const STAGE_LABELS: Record<ApiKeyLifecycleStage, string> = {
  revoked: 'Revoked (terminal)',
  expired: 'Expired (active + past expires_at)',
  expiring_soon: 'Expiring within 30 days',
  idle_never_used: 'Idle — never used',
  dormant: 'Dormant — no use > 30 days',
  fresh: 'Fresh (< 7d, never used)',
  mature_active: 'Mature active',
};

// ─── Thresholds ────────────────────────────────────────────────────────

export const EXPIRING_SOON_DAYS = 30;
export const DORMANT_DAYS = 30;
export const IDLE_NEVER_USED_DAYS = 30;
export const FRESH_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Public types ──────────────────────────────────────────────────────

export interface ApiKeyLifecycleRow {
  stage: ApiKeyLifecycleStage;
  label: string;
  count: number;
  /** Sample key_ids in this stage, cap 5, sorted asc. */
  sample_key_ids: string[];
  /** Sample names alongside key_ids for SPA rendering. */
  sample_names: string[];
}

export interface ApiKeyLifecycleDistributionSummary {
  tenant_id: string;
  generated_at: string;
  total_keys: number;
  stages: ApiKeyLifecycleRow[];
  /** Highest-count stage; canonical iteration tie-break (revoked
   *  wins over expired at tied); null on empty. */
  peak_stage: ApiKeyLifecycleStage | null;
  peak_count: number;
  /** Stages with count=0 in canonical order. */
  empty_stages: ApiKeyLifecycleStage[];
  /** Subset of stages that should be acted on (revoked excluded —
   *  terminal; mature_active + fresh excluded — healthy): expired
   *  + expiring_soon + idle_never_used + dormant. Sorted by count
   *  desc + canonical stage order tie-break. */
  attention_stages: ApiKeyLifecycleStage[];
}

const ATTENTION_STAGES: readonly ApiKeyLifecycleStage[] = [
  'expired',
  'expiring_soon',
  'idle_never_used',
  'dormant',
] as const;

// ─── Helpers ───────────────────────────────────────────────────────────

function daysBetween(a: number, b: number): number {
  return Math.floor(Math.abs(a - b) / MS_PER_DAY);
}

function classifyKey(entry: ApiKeyEntry, now: Date): ApiKeyLifecycleStage {
  if (entry.status === 'revoked') return 'revoked';

  const nowMs = now.getTime();

  // expired: active + expires_at in the past
  if (entry.expires_at) {
    const expiresMs = new Date(entry.expires_at).getTime();
    if (Number.isFinite(expiresMs) && expiresMs <= nowMs) return 'expired';
  }

  // expiring_soon: active + expires_at within EXPIRING_SOON_DAYS days
  if (entry.expires_at) {
    const expiresMs = new Date(entry.expires_at).getTime();
    if (Number.isFinite(expiresMs)) {
      const daysUntilExpiry = (expiresMs - nowMs) / MS_PER_DAY;
      if (daysUntilExpiry > 0 && daysUntilExpiry <= EXPIRING_SOON_DAYS) {
        return 'expiring_soon';
      }
    }
  }

  const createdMs = new Date(entry.created_at).getTime();
  const ageDays = Number.isFinite(createdMs)
    ? daysBetween(nowMs, createdMs)
    : 0;
  const everUsed = entry.last_used_at !== null;

  // idle_never_used: active + never used + ≥ 30 days old
  if (!everUsed && ageDays >= IDLE_NEVER_USED_DAYS) return 'idle_never_used';

  // dormant: active + ever used + last use > 30 days ago
  if (everUsed) {
    const lastUsedMs = new Date(entry.last_used_at!).getTime();
    if (Number.isFinite(lastUsedMs)) {
      const daysSinceUse = (nowMs - lastUsedMs) / MS_PER_DAY;
      if (daysSinceUse > DORMANT_DAYS) return 'dormant';
    }
  }

  // fresh: active + < FRESH_DAYS old + never used
  if (!everUsed && ageDays < FRESH_DAYS) return 'fresh';

  // mature_active: everything else (steady-state healthy keys)
  return 'mature_active';
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function summarizeApiKeyLifecycleDistribution(
  tenant_id: string,
  entries: readonly ApiKeyEntry[],
  now: Date,
): ApiKeyLifecycleDistributionSummary {
  type Bucket = {
    count: number;
    samples: Array<{ key_id: string; name: string }>;
  };
  const buckets: Record<ApiKeyLifecycleStage, Bucket> = {} as never;
  for (const s of ALL_API_KEY_LIFECYCLE_STAGES) {
    buckets[s] = { count: 0, samples: [] };
  }

  for (const entry of entries) {
    const stage = classifyKey(entry, now);
    buckets[stage].count++;
    buckets[stage].samples.push({ key_id: entry.key_id, name: entry.name });
  }

  // Finalise rows.
  const stages: ApiKeyLifecycleRow[] = ALL_API_KEY_LIFECYCLE_STAGES.map((s) => {
    const b = buckets[s];
    const sorted = [...b.samples].sort((a, b2) =>
      a.key_id.localeCompare(b2.key_id),
    );
    return {
      stage: s,
      label: STAGE_LABELS[s],
      count: b.count,
      sample_key_ids: sorted.slice(0, 5).map((x) => x.key_id),
      sample_names: sorted.slice(0, 5).map((x) => x.name),
    };
  });

  // peak_stage — highest count + canonical iteration tie-break.
  let peak_stage: ApiKeyLifecycleStage | null = null;
  let peak_count = 0;
  for (const s of ALL_API_KEY_LIFECYCLE_STAGES) {
    if (buckets[s].count > peak_count) {
      peak_count = buckets[s].count;
      peak_stage = s;
    }
  }
  if (peak_count === 0) peak_stage = null;

  // empty_stages — canonical-order subset.
  const empty_stages = ALL_API_KEY_LIFECYCLE_STAGES.filter(
    (s) => buckets[s].count === 0,
  );

  // attention_stages — subset filter sorted by count desc + canonical order.
  const attention_stages = [...ATTENTION_STAGES]
    .filter((s) => buckets[s].count > 0)
    .sort((a, b) => {
      const ca = buckets[a].count;
      const cb = buckets[b].count;
      if (cb !== ca) return cb - ca;
      return ATTENTION_STAGES.indexOf(a) - ATTENTION_STAGES.indexOf(b);
    });

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_keys: entries.length,
    stages,
    peak_stage,
    peak_count,
    empty_stages,
    attention_stages,
  };
}
