// services/bff/src/admin_config_category_actor_matrix.ts
//
// T6 M13.17 — Config override category × actor cross-tab matrix.
//
// M13.12 ships 1D category override-rate. M13.16 ships 1D per-actor
// rollup. M13.15 ships category × type cross-tab over the SCHEMA
// (platform-static).
//
// M13.17 ships the 2D pivot over per-tenant OVERRIDES combining the
// M13.12 category axis × the M13.16 actor axis. Each override lives
// in exactly one (category, actor) cell. Category axis is CLOSED
// (5 canonical: alerts/notifications/reporting/scoring/features);
// actor axis is OPEN (any updated_by username seen on an override).
//
// Per-row {category, total_overrides, by_actor (compact — only
// actors with > 0 overrides in this category), distinct_actors,
// top_actors[] cap 3 sorted count desc + asc tie-break}. Per-col
// {actor_username, total_overrides, by_category (every category at
// 0 — stable 5-key grid), categories_without[] canonical, distinct_categories}.
//
// Envelope: peak_cell + most_versatile_actor (highest distinct_categories
// + canonical asc tie-break) + most_active_category (highest
// distinct_actors + canonical category-order tie-break) +
// empty_cells[] canonical category × actor row-major order.
//
// Default entries (is_default=true) excluded — only actual overrides
// contribute. Defensive null updated_by skipped.
//
// Mirror of M1.11 / M14.28 / M12.14 / M3.14 / M15.14 / M15.17 matrix
// pattern combining CLOSED axis (5 categories) × OPEN axis (actors).
// Drives BIL ops "which categories does each actor touch? are there
// actors who span every category vs single-domain specialists?" view.

import {
  listCategories,
  type ConfigCategory,
  type ConfigEntry,
} from './admin_config';

// ─── Public types ──────────────────────────────────────────────────────

export interface ConfigCategoryRow {
  category: ConfigCategory;
  total_overrides: number;
  /** Per-actor counts; compact — only actors with > 0 appear. */
  by_actor: Record<string, number>;
  /** Distinct actors with overrides in this category. */
  distinct_actors: number;
  /** Top-3 actors by override count; canonical username asc tie-break. */
  top_actors: Array<{ actor_username: string; count: number }>;
}

export interface ConfigActorColumn {
  actor_username: string;
  total_overrides: number;
  /** Per-category counts; every ConfigCategory key at 0 when absent. */
  by_category: Record<ConfigCategory, number>;
  /** Categories with by_category=0 (canonical listCategories order). */
  categories_without: ConfigCategory[];
  /** Distinct categories this actor has touched (0..5). */
  distinct_categories: number;
}

export interface ConfigCategoryActorMatrix {
  tenant_id: string;
  generated_at: string;
  total_overrides: number;
  total_actors: number;
  total_categories: number; // = 5
  /** Distinct actor usernames (sorted asc). */
  actors: string[];
  rows: ConfigCategoryRow[];
  columns: ConfigActorColumn[];
  /** Highest cell across the matrix; canonical iteration tie-break —
   *  categories in listCategories order × actors in asc order; null
   *  on empty. */
  peak_cell: {
    category: ConfigCategory;
    actor_username: string;
    count: number;
  } | null;
  /** Actor with most distinct_categories touched; canonical username
   *  asc tie-break; null on empty. */
  most_versatile_actor: string | null;
  /** Category with most distinct_actors touching it; canonical
   *  listCategories order tie-break; null on empty. */
  most_active_category: ConfigCategory | null;
  /** (category, actor) cells with count=0 — canonical category ×
   *  actor row-major order. */
  empty_cells: Array<{ category: ConfigCategory; actor_username: string }>;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByCategory(): Record<ConfigCategory, number> {
  const out = {} as Record<ConfigCategory, number>;
  for (const c of listCategories()) out[c] = 0;
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function buildConfigCategoryActorMatrix(
  tenant_id: string,
  entries: readonly ConfigEntry[],
  now: Date,
): ConfigCategoryActorMatrix {
  const categories = listCategories();
  // cellCounts[category][actor] = count
  const cellCounts: Record<ConfigCategory, Map<string, number>> =
    {} as never;
  for (const c of categories) cellCounts[c] = new Map<string, number>();

  const actorsSet = new Set<string>();
  let total_overrides = 0;

  for (const entry of entries) {
    if (entry.is_default) continue;
    if (typeof entry.updated_by !== 'string' || !entry.updated_by) continue;
    total_overrides++;
    actorsSet.add(entry.updated_by);
    const map = cellCounts[entry.category];
    map.set(entry.updated_by, (map.get(entry.updated_by) ?? 0) + 1);
  }

  const actors = [...actorsSet].sort((a, b) => a.localeCompare(b));

  // Build rows in canonical category order.
  const rows: ConfigCategoryRow[] = categories.map((category) => {
    const map = cellCounts[category];
    const by_actor: Record<string, number> = {};
    let total = 0;
    for (const [actor, c] of map.entries()) {
      by_actor[actor] = c;
      total += c;
    }
    const top_actors = [...map.entries()]
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .slice(0, 3)
      .map(([actor_username, count]) => ({ actor_username, count }));
    return {
      category,
      total_overrides: total,
      by_actor,
      distinct_actors: map.size,
      top_actors,
    };
  });

  // Build columns in canonical actor asc order.
  const columns: ConfigActorColumn[] = actors.map((actor) => {
    const by_category = emptyByCategory();
    let total = 0;
    for (const category of categories) {
      const c = cellCounts[category].get(actor) ?? 0;
      by_category[category] = c;
      total += c;
    }
    const categories_without = categories.filter(
      (c) => by_category[c] === 0,
    );
    return {
      actor_username: actor,
      total_overrides: total,
      by_category,
      categories_without,
      distinct_categories: categories.length - categories_without.length,
    };
  });

  // peak_cell — canonical iteration: categories × actors asc.
  let peak_cell:
    | { category: ConfigCategory; actor_username: string; count: number }
    | null = null;
  let peakCount = 0;
  for (const category of categories) {
    for (const actor of actors) {
      const c = cellCounts[category].get(actor) ?? 0;
      if (c > peakCount) {
        peakCount = c;
        peak_cell = { category, actor_username: actor, count: c };
      }
    }
  }

  // most_versatile_actor — highest distinct_categories + canonical asc.
  let most_versatile_actor: string | null = null;
  if (columns.length > 0) {
    const sortedVersatile = [...columns].sort((a, b) => {
      if (b.distinct_categories !== a.distinct_categories) {
        return b.distinct_categories - a.distinct_categories;
      }
      return a.actor_username.localeCompare(b.actor_username);
    });
    if (sortedVersatile[0].distinct_categories > 0) {
      most_versatile_actor = sortedVersatile[0].actor_username;
    }
  }

  // most_active_category — highest distinct_actors + canonical category order.
  let most_active_category: ConfigCategory | null = null;
  let bestActive = 0;
  for (const row of rows) {
    if (row.distinct_actors > bestActive) {
      bestActive = row.distinct_actors;
      most_active_category = row.category;
    }
  }

  // empty_cells — canonical category × actor row-major order.
  const empty_cells: Array<{
    category: ConfigCategory;
    actor_username: string;
  }> = [];
  for (const category of categories) {
    for (const actor of actors) {
      const c = cellCounts[category].get(actor) ?? 0;
      if (c === 0) empty_cells.push({ category, actor_username: actor });
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_overrides,
    total_actors: actors.length,
    total_categories: categories.length,
    actors,
    rows,
    columns,
    peak_cell,
    most_versatile_actor,
    most_active_category,
    empty_cells,
  };
}
