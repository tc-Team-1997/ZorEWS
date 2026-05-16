// services/bff/src/admin_config_feature_adoption.ts
//
// T6 M13.14 — Feature flag adoption across tenants.
//
// M13.1 ships the 13-key config registry with 3 `features.*` boolean
// toggles (scenario_simulation_enabled, copilot_enabled,
// maker_checker_enabled). M13.12 ships the per-tenant category
// override-rate snapshot. M13.14 is the cross-tenant pivot
// answering "which tenants have feature X enabled?" — a SaaS
// admin's adoption tracker.
//
// For each features.* boolean: walk every tenant in the registry,
// read the effective value via configStore.get, bucket into
// enabled/disabled, capture which tenants overrode the default.
//
// Mirror of M2.12 fleet overview shape (cross-tenant rollup) +
// M13.12 override-rate shape (per-category counts).
//
// Pure rollup. Caller passes the tenant list + configStore.

import type { Tenant } from './tenant';
import { type ConfigStore, DEFAULTS } from './admin_config';

// ─── Public types ─────────────────────────────────────────────────────

export interface FeatureAdoptionRow {
  key: string;
  description: string;
  /** Platform default (true or false). */
  default_value: boolean;
  total_tenants: number;
  /** Tenants where the effective value resolves to true. */
  enabled_count: number;
  /** Tenants where the effective value resolves to false. */
  disabled_count: number;
  /** Tenants that have an explicit override (regardless of value).
   *  override_count ≤ total_tenants. */
  override_count: number;
  /** Tenant IDs (sorted asc) where the feature is enabled. */
  enabled_tenant_ids: string[];
  /** Tenant IDs (sorted asc) where the feature is disabled. */
  disabled_tenant_ids: string[];
  /** enabled_count / total_tenants; 0 when total_tenants=0. */
  adoption_rate: number;
}

export interface FeatureAdoptionSummary {
  generated_at: string;
  total_features: number;
  total_tenants: number;
  /** Per features.* key in canonical schema order. */
  features: FeatureAdoptionRow[];
  /** Highest adoption_rate. Tie-broken by canonical key order
   *  (first feature in DEFAULTS wins at same rate). null when no
   *  tenants OR no features. */
  most_adopted_feature: {
    key: string;
    adoption_rate: number;
    enabled_count: number;
  } | null;
  /** Lowest adoption_rate. Tie-broken by canonical key order.
   *  null when no tenants OR no features. */
  least_adopted_feature: {
    key: string;
    adoption_rate: number;
    enabled_count: number;
  } | null;
  /** Features where at least one tenant has an override. Sorted by
   *  canonical key order. */
  features_with_overrides: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** All features.* keys in canonical DEFAULTS order. */
function featureKeys(): string[] {
  return DEFAULTS
    .filter((d) => d.category === 'features' && d.type === 'boolean')
    .map((d) => d.key);
}

function featureDef(key: string) {
  return DEFAULTS.find((d) => d.key === key && d.category === 'features');
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function summarizeFeatureAdoption(
  tenants: readonly Tenant[],
  configStore: ConfigStore,
  now: Date,
): FeatureAdoptionSummary {
  const keys = featureKeys();
  const rows: FeatureAdoptionRow[] = [];

  for (const key of keys) {
    const def = featureDef(key)!;
    const enabled: string[] = [];
    const disabled: string[] = [];
    let override_count = 0;
    for (const t of tenants) {
      const entry = configStore.get(t.tenant_id, key);
      if (!entry) continue; // shouldn't happen — schema is platform-static
      const value = entry.value as boolean;
      if (value === true) enabled.push(t.tenant_id);
      else disabled.push(t.tenant_id);
      if (!entry.is_default) override_count++;
    }
    enabled.sort();
    disabled.sort();
    const total_tenants = tenants.length;
    const adoption_rate = total_tenants > 0 ? enabled.length / total_tenants : 0;
    rows.push({
      key,
      description: def.description,
      default_value: def.default_value as boolean,
      total_tenants,
      enabled_count: enabled.length,
      disabled_count: disabled.length,
      override_count,
      enabled_tenant_ids: enabled,
      disabled_tenant_ids: disabled,
      adoption_rate,
    });
  }

  // most_adopted_feature / least_adopted_feature: canonical key order
  // tie-break via iteration order (first key wins).
  let most_adopted_feature: FeatureAdoptionSummary['most_adopted_feature'] = null;
  let least_adopted_feature: FeatureAdoptionSummary['least_adopted_feature'] = null;
  if (rows.length > 0 && tenants.length > 0) {
    let mostRate = -1;
    let leastRate = 2;
    for (const row of rows) {
      if (row.adoption_rate > mostRate) {
        mostRate = row.adoption_rate;
        most_adopted_feature = {
          key: row.key,
          adoption_rate: row.adoption_rate,
          enabled_count: row.enabled_count,
        };
      }
      if (row.adoption_rate < leastRate) {
        leastRate = row.adoption_rate;
        least_adopted_feature = {
          key: row.key,
          adoption_rate: row.adoption_rate,
          enabled_count: row.enabled_count,
        };
      }
    }
  }

  const features_with_overrides = rows
    .filter((r) => r.override_count > 0)
    .map((r) => r.key);

  return {
    generated_at: now.toISOString(),
    total_features: rows.length,
    total_tenants: tenants.length,
    features: rows,
    most_adopted_feature,
    least_adopted_feature,
    features_with_overrides,
  };
}
