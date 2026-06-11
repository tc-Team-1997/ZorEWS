// services/bff/src/config_value_range_validation.ts
// T6 M13.27 — Config key value range validation.

import { defaultConfigStore, type ConfigStore } from './admin_config';

export type ValidationHealth = 'pass' | 'warn' | 'fail';

export interface ConfigRangeValidation {
  key: string;
  value: unknown;
  in_range: boolean;
  suggested_min: number | null;
  suggested_max: number | null;
  suggested_correction: string | null;
}

export interface ConfigValueRangeValidationResult {
  tenant_id: string;
  generated_at: string;
  total_overrides_checked: number;
  in_range_count: number;
  out_of_range_count: number;
  validations: ConfigRangeValidation[];
  validation_health: ValidationHealth;
}

const SAFE_RANGES: Record<string, { min: number; max: number }> = {
  'alerts.red_sla_hours': { min: 1, max: 24 },
  'alerts.orange_sla_hours': { min: 4, max: 72 },
  'alerts.yellow_sla_hours': { min: 12, max: 168 },
  'scoring.default_thresholds.low_max': { min: 20, max: 40 },
  'scoring.default_thresholds.medium_max': { min: 50, max: 80 },
  'reporting.retention_days': { min: 30, max: 3650 },
};

export function buildConfigValueRangeValidation(
  tenant_id: string,
  now: Date,
  store: ConfigStore = defaultConfigStore,
): ConfigValueRangeValidationResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const overrides = store.list(tenant_id).filter((e) => !e.is_default);
  const validations: ConfigRangeValidation[] = [];

  for (const entry of overrides) {
    const range = SAFE_RANGES[entry.key];
    if (!range) {
      validations.push({
        key: entry.key,
        value: entry.value,
        in_range: true,
        suggested_min: null,
        suggested_max: null,
        suggested_correction: null,
      });
      continue;
    }

    const val = typeof entry.value === 'number' ? entry.value : NaN;
    const in_range = !isNaN(val) && val >= range.min && val <= range.max;
    const suggested_correction = in_range
      ? null
      : `Value ${val} is outside safe range [${range.min}, ${range.max}]. Suggested: ${Math.max(range.min, Math.min(range.max, isNaN(val) ? range.min : val))}`;

    validations.push({
      key: entry.key,
      value: entry.value,
      in_range,
      suggested_min: range.min,
      suggested_max: range.max,
      suggested_correction,
    });
  }

  const in_range_count = validations.filter((v) => v.in_range).length;
  const out_of_range_count = validations.filter((v) => !v.in_range).length;

  const validation_health: ValidationHealth =
    out_of_range_count === 0 ? 'pass' : out_of_range_count <= 2 ? 'warn' : 'fail';

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_overrides_checked: overrides.length,
    in_range_count,
    out_of_range_count,
    validations,
    validation_health,
  };
}
