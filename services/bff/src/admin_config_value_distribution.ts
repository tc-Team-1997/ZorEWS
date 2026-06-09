// services/bff/src/admin_config_value_distribution.ts
//
// T6 M13.20 — Admin config value distribution by type.
//
// Per-tenant analytics over the effective config values (overrides +
// platform defaults). Answers "what's the spread of numeric values?
// how many booleans are overridden to true vs false? what strings
// does this tenant use?"
//
// Distinct from:
//   M13.11 — override age tracker (time dimension; actual overrides only)
//   M13.12 — category override-rate (structural; per-category override rate)
//   M13.15 — category × type matrix (2D cross-tab; platform schema only)
//   M13.16 — per-actor rollup (who changed configs, not the values themselves)
//
// Pure rollup over the existing ConfigStore interface.

import type { ConfigEntry, ConfigStore, ConfigType } from './admin_config';

// ─── Public types ─────────────────────────────────────────────────────

export interface NumberTypeStats {
  count: number;
  override_count: number;
  default_count: number;
  min_value: number | null;
  max_value: number | null;
  mean_value: number | null;
}

export interface BooleanTypeStats {
  count: number;
  /** Number of keys whose effective value is true. */
  true_count: number;
  /** Number of keys whose effective value is false. */
  false_count: number;
  /** true_count / count (0..1). 0 when count=0. */
  true_pct: number;
}

export interface StringTypeStats {
  count: number;
  /** Number of distinct effective string values. */
  distinct_values: number;
  /** Length of the longest effective string value. */
  max_length: number;
}

export interface JsonTypeStats {
  count: number;
  /** Number of keys with a tenant override for json type. */
  override_count: number;
}

export interface ConfigValueDistribution {
  tenant_id: string;
  generated_at: string;
  total_keys: number;
  by_type: {
    number: NumberTypeStats;
    boolean: BooleanTypeStats;
    string: StringTypeStats;
    json: JsonTypeStats;
  };
  /** Type with the most overrides. null when no overrides exist. */
  most_customized_type: ConfigType | null;
}

// ─── Pure function ────────────────────────────────────────────────────

export function buildConfigValueDistribution(
  entries: ConfigEntry[],
  tenant_id: string,
  now: Date,
): ConfigValueDistribution {
  if (!tenant_id) throw new Error('tenant_id is required');

  const total_keys = entries.length;

  // Number stats
  let numCount = 0, numOverride = 0, numDefault = 0;
  const numValues: number[] = [];

  // Boolean stats
  let boolCount = 0, boolTrue = 0, boolFalse = 0;

  // String stats
  let strCount = 0, strMaxLen = 0;
  const strDistinctValues = new Set<string>();

  // JSON stats
  let jsonCount = 0, jsonOverride = 0;

  // Override count per type for most_customized_type
  const overridesByType = new Map<ConfigType, number>([
    ['number', 0], ['boolean', 0], ['string', 0], ['json', 0],
  ]);

  for (const entry of entries) {
    if (!entry.is_default) {
      overridesByType.set(entry.type, (overridesByType.get(entry.type) ?? 0) + 1);
    }

    switch (entry.type) {
      case 'number': {
        numCount++;
        if (entry.is_default) numDefault++; else numOverride++;
        if (typeof entry.value === 'number' && Number.isFinite(entry.value)) {
          numValues.push(entry.value as number);
        }
        break;
      }
      case 'boolean': {
        boolCount++;
        if (entry.value === true) boolTrue++;
        else boolFalse++;
        break;
      }
      case 'string': {
        strCount++;
        const s = String(entry.value);
        strDistinctValues.add(s);
        if (s.length > strMaxLen) strMaxLen = s.length;
        break;
      }
      case 'json': {
        jsonCount++;
        if (!entry.is_default) jsonOverride++;
        break;
      }
    }
  }

  // Number aggregates
  let numMin: number | null = null;
  let numMax: number | null = null;
  let numMean: number | null = null;
  if (numValues.length > 0) {
    numMin = Math.min(...numValues);
    numMax = Math.max(...numValues);
    numMean = Math.round((numValues.reduce((s, v) => s + v, 0) / numValues.length) * 1000) / 1000;
  }

  // Most customized type (highest override count; null when no overrides)
  let most_customized_type: ConfigType | null = null;
  let maxOverrides = 0;
  // Canonical type order for tie-breaking
  const typeOrder: ConfigType[] = ['number', 'string', 'boolean', 'json'];
  for (const t of typeOrder) {
    const cnt = overridesByType.get(t) ?? 0;
    if (cnt > maxOverrides) {
      maxOverrides = cnt;
      most_customized_type = t;
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_keys,
    by_type: {
      number: {
        count: numCount,
        override_count: numOverride,
        default_count: numDefault,
        min_value: numMin,
        max_value: numMax,
        mean_value: numMean,
      },
      boolean: {
        count: boolCount,
        true_count: boolTrue,
        false_count: boolFalse,
        true_pct: boolCount > 0 ? Math.round((boolTrue / boolCount) * 10000) / 10000 : 0,
      },
      string: {
        count: strCount,
        distinct_values: strDistinctValues.size,
        max_length: strMaxLen,
      },
      json: {
        count: jsonCount,
        override_count: jsonOverride,
      },
    },
    most_customized_type,
  };
}

// ─── Store adapter ────────────────────────────────────────────────────

export function buildConfigValueDistributionFromStore(
  store: ConfigStore,
  tenant_id: string,
  now: Date,
): ConfigValueDistribution {
  const entries = store.list(tenant_id);
  return buildConfigValueDistribution(entries, tenant_id, now);
}
