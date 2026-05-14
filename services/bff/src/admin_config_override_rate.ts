// services/bff/src/admin_config_override_rate.ts
//
// T6 M13.12 — Config category override-rate snapshot.
//
// M13.1 ships the admin config registry; M13.11 tracks per-override
// age (recent/stable/stale). M13.12 ships the CATEGORY-pivoted view:
// per category, count keys at the platform default vs keys with a
// tenant override + an override_rate (0..1) summarising "how much
// has ops customised this category?".
//
// Lets the SPA render the admin config page header with category
// chips colour-coded by override density. Surfaces pristine
// categories (zero overrides — defaults are doing the job) and the
// most-customised category for at-a-glance ops review.
//
// Pure rollup. Companion to M13.11 (age axis) — same store input,
// different lens.

import {
  type ConfigCategory,
  type ConfigEntry,
  type ConfigStore,
  listCategories,
} from './admin_config';

// ─── Public types ─────────────────────────────────────────────────────

export interface CategoryOverrideRow {
  category: ConfigCategory;
  total_keys: number;
  default_count: number;
  override_count: number;
  /** override_count / total_keys; 0 when total_keys=0 (no schema keys
   *  in that category — shouldn't happen for declared categories but
   *  defensive). 0..1 inclusive. */
  override_rate: number;
  /** Keys overridden in this category, sorted asc. */
  override_keys: string[];
}

export interface ConfigOverrideRateSnapshot {
  tenant_id: string;
  generated_at: string;
  total_keys: number;
  total_overrides: number;
  /** total_overrides / total_keys; 0 when no schema keys. */
  overall_override_rate: number;
  /** Per-category rows. Always present for every declared category
   *  (even zero-override categories). Sorted by override_count desc
   *  with category asc tie-break — most-customised floats to the top. */
  categories: CategoryOverrideRow[];
  /** Highest override_rate among categories with ≥1 schema key.
   *  null when no schema keys exist. Tie-broken by override_count
   *  desc then category asc. */
  most_customised_category: {
    category: ConfigCategory;
    override_count: number;
    override_rate: number;
  } | null;
  /** Categories with zero overrides. Sorted asc. */
  pristine_categories: ConfigCategory[];
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildConfigOverrideRateSnapshot(
  store: ConfigStore,
  tenant_id: string,
  now: Date,
): ConfigOverrideRateSnapshot {
  const entries = store.list(tenant_id);
  // Bucket by category; pre-populate every declared category so the
  // SPA always sees a stable row count.
  const byCategory = new Map<ConfigCategory, CategoryOverrideRow>();
  for (const category of listCategories()) {
    byCategory.set(category, {
      category,
      total_keys: 0,
      default_count: 0,
      override_count: 0,
      override_rate: 0,
      override_keys: [],
    });
  }

  for (const entry of entries) {
    const row = byCategory.get(entry.category);
    if (!row) continue; // unknown category — shouldn't happen for declared schema
    row.total_keys++;
    if (entry.is_default) {
      row.default_count++;
    } else {
      row.override_count++;
      row.override_keys.push(entry.key);
    }
  }

  let total_keys = 0;
  let total_overrides = 0;
  for (const row of byCategory.values()) {
    row.override_keys.sort();
    row.override_rate = row.total_keys > 0 ? row.override_count / row.total_keys : 0;
    total_keys += row.total_keys;
    total_overrides += row.override_count;
  }

  const categories = [...byCategory.values()].sort((a, b) => {
    if (b.override_count !== a.override_count) return b.override_count - a.override_count;
    return a.category.localeCompare(b.category);
  });

  // most_customised: highest override_rate among non-empty categories;
  // ties broken by override_count desc then category asc.
  let most_customised_category: ConfigOverrideRateSnapshot['most_customised_category'] = null;
  for (const row of categories) {
    if (row.total_keys === 0) continue;
    if (!most_customised_category) {
      most_customised_category = {
        category: row.category,
        override_count: row.override_count,
        override_rate: row.override_rate,
      };
      continue;
    }
    if (row.override_rate > most_customised_category.override_rate) {
      most_customised_category = {
        category: row.category,
        override_count: row.override_count,
        override_rate: row.override_rate,
      };
    } else if (row.override_rate === most_customised_category.override_rate) {
      if (row.override_count > most_customised_category.override_count) {
        most_customised_category = {
          category: row.category,
          override_count: row.override_count,
          override_rate: row.override_rate,
        };
      } else if (
        row.override_count === most_customised_category.override_count
        && row.category.localeCompare(most_customised_category.category) < 0
      ) {
        most_customised_category = {
          category: row.category,
          override_count: row.override_count,
          override_rate: row.override_rate,
        };
      }
    }
  }

  const pristine_categories = categories
    .filter((r) => r.override_count === 0)
    .map((r) => r.category)
    .sort();

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_keys,
    total_overrides,
    overall_override_rate: total_keys > 0 ? total_overrides / total_keys : 0,
    categories,
    most_customised_category,
    pristine_categories,
  };
}

// Avoid TS unused-import warning when the consumer doesn't reference
// `ConfigEntry` directly (it's part of the store interface).
type _Unused = ConfigEntry;
