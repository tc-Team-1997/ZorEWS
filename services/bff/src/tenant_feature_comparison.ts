/**
 * M2.25 — Tenant feature flag comparison
 * Compares the 3 feature flags across BANK_DEMO and BIL tenants.
 */

import { defaultConfigStore } from './admin_config';

const KNOWN_TENANTS = ['BANK_DEMO', 'BIL'] as const;

const FEATURE_KEYS = [
  'features.scenario_simulation_enabled',
  'features.copilot_enabled',
  'features.maker_checker_enabled',
] as const;

export interface FeatureComparison {
  feature_key: string;
  default_value: boolean;
  values_by_tenant: Record<string, boolean>;
  divergent: boolean;
}

export interface TenantFeatureComparisonReport {
  generated_at: string;
  tenants: readonly string[];
  features: FeatureComparison[];
  divergent_features: string[];
}

export function buildTenantFeatureComparison(
  now: Date = new Date(),
): TenantFeatureComparisonReport {
  const features: FeatureComparison[] = [];
  const divergent_features: string[] = [];

  for (const key of FEATURE_KEYS) {
    const values_by_tenant: Record<string, boolean> = {};
    for (const tenant of KNOWN_TENANTS) {
      const entry = defaultConfigStore.get(tenant, key);
      values_by_tenant[tenant] = entry ? Boolean(entry.value) : false;
    }

    const def = defaultConfigStore.get('BANK_DEMO', key);
    const default_value = def ? Boolean(def.value) : false;

    const vals = Object.values(values_by_tenant);
    const divergent = vals.length > 0 && !vals.every((v) => v === vals[0]);

    features.push({ feature_key: key, default_value, values_by_tenant, divergent });
    if (divergent) divergent_features.push(key);
  }

  return {
    generated_at: now.toISOString(),
    tenants: KNOWN_TENANTS,
    features,
    divergent_features,
  };
}
