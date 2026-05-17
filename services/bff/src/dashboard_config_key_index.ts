// services/bff/src/dashboard_config_key_index.ts
//
// T6 M11.16 — Dashboard widget config-key cross-reference.
//
// M11.7 ships the saved-dashboard CRUD. M11.11 ships per-widget-type
// usage analytics (which widget is most popular). M11.12 ships widget
// defaults. M11.16 lands the INVERTED index over the WIDGET_CATALOG's
// `config_keys[]`: for each distinct config-key across the 7 BIL
// widget types, list which widget_types declare it.
//
// Mirror of M10.13 (template-variable cross-reference) for the
// dashboard widget catalog surface. Drives the SPA "config builder"
// flow — "when I add a `limit` config, which widget_types will pick
// it up?" + "are there config_keys used by ONLY one widget_type
// (refactor candidates)?".
//
// Pure resolver — operates entirely on the static WIDGET_CATALOG
// (M11.7). Platform-static — same response across tenants.

import {
  WIDGET_CATALOG,
  WIDGET_TYPES,
  type WidgetType,
  type WidgetCatalogEntry,
} from './custom_dashboards';

// ─── Public types ─────────────────────────────────────────────────────

export interface ConfigKeyRow {
  config_key: string;
  /** Widget types declaring this config_key, sorted asc for stable
   *  rendering. */
  widget_types: WidgetType[];
  reference_count: number;
  /** Sample display_names for the widget_types — handy for SPA
   *  rendering. Sorted asc. */
  widget_display_names: string[];
}

export interface DashboardConfigKeyIndex {
  generated_at: string;
  total_widget_types: number;
  total_config_keys: number;
  /** Sorted by reference_count desc with config_key asc tie-break.
   *  Most-shared keys float to the top. */
  config_keys: ConfigKeyRow[];
  /** Config keys with reference_count === 1 — refactor candidates
   *  (might be inlined or renamed for consistency). Sorted asc. */
  single_use_keys: ConfigKeyRow[];
  /** Config keys that every widget_type declares (reference_count =
   *  total_widget_types) — well-established cross-cutting concepts.
   *  Sorted asc. */
  universal_keys: ConfigKeyRow[];
  /** Top config-key by reference_count; canonical tie-break by
   *  config_key asc. null when no config_keys exist. */
  most_shared_key: { config_key: string; reference_count: number } | null;
}

// ─── Pure resolver ────────────────────────────────────────────────────

export function buildDashboardConfigKeyIndex(now: Date): DashboardConfigKeyIndex {
  // Map config_key → Set<widget_type>. Defensive intra-widget dedup
  // (a duplicate config_key on one widget counts once).
  const byKey = new Map<string, Set<WidgetType>>();
  for (const widget_type of WIDGET_TYPES) {
    const entry: WidgetCatalogEntry = WIDGET_CATALOG[widget_type];
    for (const key of entry.config_keys) {
      let s = byKey.get(key);
      if (!s) {
        s = new Set();
        byKey.set(key, s);
      }
      s.add(widget_type);
    }
  }

  const config_keys: ConfigKeyRow[] = [];
  for (const [key, types] of byKey) {
    const widget_types = [...types].sort((a, z) => a.localeCompare(z));
    config_keys.push({
      config_key: key,
      widget_types,
      reference_count: widget_types.length,
      widget_display_names: widget_types
        .map((t) => WIDGET_CATALOG[t].display_name)
        .sort((a, z) => a.localeCompare(z)),
    });
  }

  // Sort: reference_count desc, config_key asc tie-break.
  config_keys.sort((a, z) => {
    if (z.reference_count !== a.reference_count) return z.reference_count - a.reference_count;
    return a.config_key.localeCompare(z.config_key);
  });

  const single_use_keys = config_keys
    .filter((r) => r.reference_count === 1)
    .sort((a, z) => a.config_key.localeCompare(z.config_key));

  const universal_keys = config_keys
    .filter((r) => r.reference_count === WIDGET_TYPES.length)
    .sort((a, z) => a.config_key.localeCompare(z.config_key));

  // most_shared_key — top row of config_keys; canonical asc tie-break
  // via existing sort.
  const most_shared_key = config_keys.length > 0
    ? { config_key: config_keys[0]!.config_key, reference_count: config_keys[0]!.reference_count }
    : null;

  return {
    generated_at: now.toISOString(),
    total_widget_types: WIDGET_TYPES.length,
    total_config_keys: config_keys.length,
    config_keys,
    single_use_keys,
    universal_keys,
    most_shared_key,
  };
}
