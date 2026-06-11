// services/bff/src/adapter_data_freshness.ts
//
// T6 M14.33 — Adapter data freshness comparison.
//
// For each of the 8 M14 adapters, synthesises a deterministic
// "last_refreshed_at" per (tenant, adapter, day) and classifies
// the freshness relative to the adapter's expected refresh interval.

// ─── Public types ──────────────────────────────────────────────────────

export type AdapterFreshnessStatus = 'fresh' | 'aging' | 'stale';

export interface AdapterFreshnessRow {
  adapter_id: string;
  label: string;
  last_refreshed_at: string;
  age_hours: number;
  expected_interval_hours: number;
  freshness_status: AdapterFreshnessStatus;
  /** age_hours / expected_interval_hours, rounded 4 decimals. */
  age_vs_sla_pct: number;
}

export interface AdapterDataFreshness {
  tenant_id: string;
  generated_at: string;
  adapters: AdapterFreshnessRow[];
  stale_count: number;
  aging_count: number;
  fresh_count: number;
  most_stale: { adapter_id: string; label: string; age_hours: number } | null;
}

// ─── Adapter catalog ──────────────────────────────────────────────────

interface AdapterFreshnessMeta {
  adapter_id: string;
  label: string;
  /** Expected refresh interval in hours. */
  expected_interval_hours: number;
  /** Deterministic age multiplier seeded by adapter position. */
  age_seed_factor: number;
}

const ADAPTER_META: AdapterFreshnessMeta[] = [
  { adapter_id: 'insurance', label: 'Core Insurance', expected_interval_hours: 1 / 12, age_seed_factor: 0.1 },
  { adapter_id: 'ifrs9', label: 'IFRS9 Stage', expected_interval_hours: 1, age_seed_factor: 0.5 },
  { adapter_id: 'aml', label: 'AML Watchlist', expected_interval_hours: 0.5, age_seed_factor: 0.3 },
  { adapter_id: 'dms', label: 'Document Management', expected_interval_hours: 1, age_seed_factor: 0.7 },
  { adapter_id: 'bureau', label: 'Credit Bureau', expected_interval_hours: 24, age_seed_factor: 3.0 },
  { adapter_id: 'agent', label: 'Agent Productivity', expected_interval_hours: 1, age_seed_factor: 0.8 },
  { adapter_id: 'finance', label: 'Finance/Treasury', expected_interval_hours: 0.25, age_seed_factor: 0.2 },
  { adapter_id: 'hr', label: 'HR', expected_interval_hours: 24, age_seed_factor: 5.0 },
];

// ─── Deterministic synthesis ───────────────────────────────────────────
//
// FNV-1a variant without Math.imul (use arithmetic multiplication)

function fnv32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // FNV prime 0x01000193 = 16777619
    hash = (hash * 16777619) >>> 0;
  }
  return hash;
}

// Mulberry32 — pure arithmetic, no Math.imul
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let z = s;
    z = (((z ^ (z >>> 15)) * ((z | 1) >>> 0)) >>> 0);
    z ^= z + (((z ^ (z >>> 7)) * ((z | 61) >>> 0)) >>> 0);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Pure function ─────────────────────────────────────────────────────

/**
 * buildAdapterDataFreshness
 *
 * @param tenant_id  caller's tenant
 * @param now        current Date
 */
export function buildAdapterDataFreshness(
  tenant_id: string,
  now: Date,
): AdapterDataFreshness {
  const dayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

  const rows: AdapterFreshnessRow[] = [];

  for (const meta of ADAPTER_META) {
    // Deterministic age in hours per (tenant, adapter, day)
    const seed = fnv32(`${tenant_id}::${meta.adapter_id}::${dayStr}`);
    const rng = mulberry32(seed);
    // age = 0.5x..1.5x of the age_seed_factor * expected_interval_hours
    const ageHours = Math.round(
      meta.age_seed_factor * meta.expected_interval_hours * (0.5 + rng()) * 100,
    ) / 100;

    const last_refreshed_at = new Date(now.getTime() - ageHours * 3600000).toISOString();

    // Freshness: < interval → fresh; < 2x → aging; else stale
    let freshness_status: AdapterFreshnessStatus;
    if (ageHours < meta.expected_interval_hours) {
      freshness_status = 'fresh';
    } else if (ageHours < meta.expected_interval_hours * 2) {
      freshness_status = 'aging';
    } else {
      freshness_status = 'stale';
    }

    const age_vs_sla_pct =
      meta.expected_interval_hours > 0
        ? Math.round((ageHours / meta.expected_interval_hours) * 10000) / 10000
        : 0;

    rows.push({
      adapter_id: meta.adapter_id,
      label: meta.label,
      last_refreshed_at,
      age_hours: ageHours,
      expected_interval_hours: meta.expected_interval_hours,
      freshness_status,
      age_vs_sla_pct,
    });
  }

  // Sort: age_hours desc (most stale first)
  rows.sort((a, b) => b.age_hours - a.age_hours);

  const stale_count = rows.filter((r) => r.freshness_status === 'stale').length;
  const aging_count = rows.filter((r) => r.freshness_status === 'aging').length;
  const fresh_count = rows.filter((r) => r.freshness_status === 'fresh').length;

  const staleRow = rows.find((r) => r.freshness_status === 'stale');
  const most_stale = staleRow
    ? { adapter_id: staleRow.adapter_id, label: staleRow.label, age_hours: staleRow.age_hours }
    : null;

  return {
    tenant_id,
    generated_at: now.toISOString(),
    adapters: rows,
    stale_count,
    aging_count,
    fresh_count,
    most_stale,
  };
}
