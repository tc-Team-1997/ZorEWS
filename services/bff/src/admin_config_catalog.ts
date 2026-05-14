// services/bff/src/admin_config_catalog.ts
//
// T6 M13.10 — Admin config schema catalog introspection.
//
// M13.1 ships the registry + DEFAULTS schema. Each tenant route
// (`GET /v1/admin/config`) returns the CURRENT values (override or
// default) which is the right shape for the value view. M13.10 ships
// the orthogonal SCHEMA view: per-key metadata (type, default,
// description) grouped by category — what the SPA needs to render
// a type-appropriate form control (numeric stepper for `number`,
// toggle for `boolean`, textarea for `json`, etc.).
//
// Pure — derives entirely from the static DEFAULTS array. Platform-
// static (same response for every tenant).

import {
  DEFAULTS,
  listCategories,
  type ConfigCategory,
  type ConfigDef,
  type ConfigType,
} from './admin_config';

// ─── Public types ─────────────────────────────────────────────────────

export interface ConfigCategoryGroup {
  category: ConfigCategory;
  key_count: number;
  keys: ConfigDef[];
}

export interface ConfigCatalog {
  total_keys: number;
  by_type: Record<ConfigType, number>;
  categories: ConfigCategoryGroup[];
}

// ─── Pure introspector ────────────────────────────────────────────────

export function introspectConfigCatalog(): ConfigCatalog {
  const by_type: Record<ConfigType, number> = {
    number: 0,
    string: 0,
    boolean: 0,
    json: 0,
  };
  const byCategory = new Map<ConfigCategory, ConfigDef[]>();
  for (const def of DEFAULTS) {
    by_type[def.type] += 1;
    let bucket = byCategory.get(def.category);
    if (!bucket) {
      bucket = [];
      byCategory.set(def.category, bucket);
    }
    bucket.push(def);
  }

  // Emit groups in the canonical category order, alphabetically
  // within each category for stable rendering.
  const categories: ConfigCategoryGroup[] = [];
  for (const cat of listCategories()) {
    const keys = byCategory.get(cat);
    if (!keys || keys.length === 0) continue;
    const sorted = [...keys].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    categories.push({
      category: cat,
      key_count: sorted.length,
      keys: sorted,
    });
  }

  return {
    total_keys: DEFAULTS.length,
    by_type,
    categories,
  };
}
