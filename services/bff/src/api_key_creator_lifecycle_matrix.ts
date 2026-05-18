// services/bff/src/api_key_creator_lifecycle_matrix.ts
//
// T6 M1.11 — API key creator × lifecycle stage cross-tab matrix.
//
// M1.6 ships per-creator rollup (1D, by creator). M1.8 ships scope ×
// status matrix. M1.10 ships lifecycle stage distribution (1D, by
// stage). M1.11 lands the proper 2D cross-tab combining the two
// open-axis-vs-closed-axis dimensions: rows = creators (open set,
// sorted by total_keys desc) × cols = 7 canonical lifecycle stages
// (closed enum in M1.10 priority order).
//
// Each key in the M1.2 redacted entry list lives in exactly one cell
// (its creator × its lifecycle stage). The cross-tab surfaces
// "alice has 3 dormant keys to revoke" forensic view + "did bob
// provision the expired keys?" governance answer.
//
// Lifecycle classification re-uses the M1.10 classifyKey logic to
// keep stage semantics consistent — re-implemented inline since
// M1.10's classifyKey isn't exported. Updates to M1.10 thresholds
// should be mirrored here.
//
// Mirror of M14.28 / M12.14 / M3.14 / M15.14 / M8.14 matrix pattern
// for the API key creator surface.
//
// Pure resolver — reads the M1.2 redacted ApiKeyEntry list directly.

import type { ApiKeyEntry } from './api_keys';
import {
  ALL_API_KEY_LIFECYCLE_STAGES,
  type ApiKeyLifecycleStage,
} from './api_key_lifecycle_distribution';

// ─── Thresholds (mirror M1.10) ────────────────────────────────────────

const EXPIRING_SOON_DAYS = 30;
const DORMANT_DAYS = 30;
const IDLE_NEVER_USED_DAYS = 30;
const FRESH_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function classifyKey(entry: ApiKeyEntry, now: Date): ApiKeyLifecycleStage {
  if (entry.status === 'revoked') return 'revoked';

  const nowMs = now.getTime();

  if (entry.expires_at) {
    const expiresMs = new Date(entry.expires_at).getTime();
    if (Number.isFinite(expiresMs) && expiresMs <= nowMs) return 'expired';
  }

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
    ? Math.floor((nowMs - createdMs) / MS_PER_DAY)
    : 0;
  const everUsed = entry.last_used_at !== null;

  if (!everUsed && ageDays >= IDLE_NEVER_USED_DAYS) return 'idle_never_used';

  if (everUsed) {
    const lastUsedMs = new Date(entry.last_used_at!).getTime();
    if (Number.isFinite(lastUsedMs)) {
      const daysSinceUse = (nowMs - lastUsedMs) / MS_PER_DAY;
      if (daysSinceUse > DORMANT_DAYS) return 'dormant';
    }
  }

  if (!everUsed && ageDays < FRESH_DAYS) return 'fresh';

  return 'mature_active';
}

// ─── Public types ──────────────────────────────────────────────────────

export interface ApiKeyCreatorLifecycleRow {
  created_by: string;
  total_keys: number;
  /** Per-stage counts; every ApiKeyLifecycleStage at 0 when absent. */
  by_stage: Record<ApiKeyLifecycleStage, number>;
  /** Stages with by_stage=0 for this creator (canonical order —
   *  coverage gap per creator). */
  stages_without: ApiKeyLifecycleStage[];
  /** Count of keys in any attention-needed stage (expired +
   *  expiring_soon + idle_never_used + dormant). Surfaces creators
   *  with the most rotation/cleanup work. */
  attention_count: number;
}

export interface ApiKeyCreatorLifecycleColumn {
  stage: ApiKeyLifecycleStage;
  total: number;
  /** Creators with > 0 keys in this stage (sorted by count desc +
   *  username asc tie-break, cap 10). */
  top_creators: Array<{ created_by: string; count: number }>;
  /** Number of distinct creators with ≥ 1 key in this stage. */
  distinct_creators: number;
}

export interface ApiKeyCreatorLifecycleMatrix {
  tenant_id: string;
  generated_at: string;
  total_keys: number;
  total_creators: number;
  total_stages: number;
  rows: ApiKeyCreatorLifecycleRow[];
  columns: ApiKeyCreatorLifecycleColumn[];
  /** Top creator by total attention_count — needs the most cleanup
   *  attention. Canonical username asc tie-break; null when no
   *  attention-needed keys. */
  top_attention_creator: string | null;
  /** Highest-count cell across the matrix; canonical iteration tie-
   *  break (creator total_keys desc → username asc → stage canonical);
   *  null on empty. */
  peak_cell: {
    created_by: string;
    stage: ApiKeyLifecycleStage;
    count: number;
  } | null;
}

const ATTENTION_STAGES: readonly ApiKeyLifecycleStage[] = [
  'expired',
  'expiring_soon',
  'idle_never_used',
  'dormant',
] as const;

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByStage(): Record<ApiKeyLifecycleStage, number> {
  const out = {} as Record<ApiKeyLifecycleStage, number>;
  for (const s of ALL_API_KEY_LIFECYCLE_STAGES) out[s] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildApiKeyCreatorLifecycleMatrix(
  tenant_id: string,
  entries: readonly ApiKeyEntry[],
  now: Date,
): ApiKeyCreatorLifecycleMatrix {
  type Bucket = {
    total_keys: number;
    by_stage: Record<ApiKeyLifecycleStage, number>;
  };
  const creatorBuckets = new Map<string, Bucket>();

  // Per-stage totals + per-creator-per-stage cells for top_creators.
  const colTotals: Record<ApiKeyLifecycleStage, number> = emptyByStage();
  const colCreators: Record<ApiKeyLifecycleStage, Map<string, number>> = {} as never;
  for (const s of ALL_API_KEY_LIFECYCLE_STAGES) {
    colCreators[s] = new Map<string, number>();
  }

  for (const entry of entries) {
    if (!entry.created_by) continue;
    const stage = classifyKey(entry, now);

    let bucket = creatorBuckets.get(entry.created_by);
    if (!bucket) {
      bucket = { total_keys: 0, by_stage: emptyByStage() };
      creatorBuckets.set(entry.created_by, bucket);
    }
    bucket.total_keys++;
    bucket.by_stage[stage]++;

    colTotals[stage]++;
    colCreators[stage].set(
      entry.created_by,
      (colCreators[stage].get(entry.created_by) ?? 0) + 1,
    );
  }

  // Rows — sort by total_keys desc + created_by asc tie-break.
  const rows: ApiKeyCreatorLifecycleRow[] = [...creatorBuckets.entries()]
    .map(([created_by, b]) => {
      const stages_without = ALL_API_KEY_LIFECYCLE_STAGES.filter(
        (s) => b.by_stage[s] === 0,
      );
      const attention_count = ATTENTION_STAGES.reduce(
        (acc, s) => acc + b.by_stage[s],
        0,
      );
      return {
        created_by,
        total_keys: b.total_keys,
        by_stage: { ...b.by_stage },
        stages_without,
        attention_count,
      };
    })
    .sort((a, b) => {
      if (b.total_keys !== a.total_keys) return b.total_keys - a.total_keys;
      return a.created_by.localeCompare(b.created_by);
    });

  // Columns — every canonical stage; per-column top_creators.
  const columns: ApiKeyCreatorLifecycleColumn[] = ALL_API_KEY_LIFECYCLE_STAGES.map((stage) => {
    const map = colCreators[stage];
    const top = [...map.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .slice(0, 10)
      .map(([created_by, count]) => ({ created_by, count }));
    return {
      stage,
      total: colTotals[stage],
      top_creators: top,
      distinct_creators: map.size,
    };
  });

  // top_attention_creator — highest attention_count + canonical username asc.
  let top_attention_creator: string | null = null;
  let bestAttention = 0;
  const sortedByAttention = [...rows].sort((a, b) => {
    if (b.attention_count !== a.attention_count) {
      return b.attention_count - a.attention_count;
    }
    return a.created_by.localeCompare(b.created_by);
  });
  if (sortedByAttention.length > 0 && sortedByAttention[0].attention_count > 0) {
    top_attention_creator = sortedByAttention[0].created_by;
    bestAttention = sortedByAttention[0].attention_count;
  }
  void bestAttention;

  // peak_cell — highest cell count across the matrix.
  let peak_cell:
    | { created_by: string; stage: ApiKeyLifecycleStage; count: number }
    | null = null;
  let peakCount = 0;
  for (const row of rows) {
    for (const stage of ALL_API_KEY_LIFECYCLE_STAGES) {
      const c = row.by_stage[stage];
      if (c > peakCount) {
        peakCount = c;
        peak_cell = { created_by: row.created_by, stage, count: c };
      }
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_keys: entries.filter((e) => !!e.created_by).length,
    total_creators: rows.length,
    total_stages: ALL_API_KEY_LIFECYCLE_STAGES.length,
    rows,
    columns,
    top_attention_creator,
    peak_cell,
  };
}
