// services/bff/src/admin_config_actor_rollup.ts
//
// T6 M13.16 — Config override per-actor rollup.
//
// M13.1 ships the admin config registry. M13.2 audits every PUT/DELETE
// with an actor (X-APEX-USER). M13.11 has override-age tracker.
// M13.12 has category override-rate snapshot. M13.15 has category × type
// cross-tab matrix.
//
// M13.16 lands the per-actor pivot — who has been changing config?
// Pivots overrides by `updated_by` (the actor that last touched each
// key). Per-actor row carries total overrides + distinct keys +
// per-category breakdown + most-recent-at.
//
// Mirror of M2.15 (onboarding actor fleet) + M15.8 (audit per-actor) +
// M9.14 (note authorship) + M11.15 (dashboard authorship) per-actor
// pattern for the admin config surface.
//
// Drives ops quarterly access review: "alice has changed 8 different
// config keys across alerts + scoring + features in the last month —
// does that match her assigned scope?". Security-flag side-channel:
// `actors_with_features_overrides[]` surfaces operators that have
// touched the `features.*` toggle category (the highest-impact knobs
// since flipping a feature can disable maker-checker enforcement etc).
//
// Pure resolver — caller passes the tenant's full ConfigEntry list
// (which already carries only overrides via the is_default=false
// filter applied here).

import {
  listCategories,
  type ConfigCategory,
  type ConfigEntry,
} from './admin_config';

// ─── Public types ──────────────────────────────────────────────────────

export interface ConfigActorRow {
  updated_by: string;
  total_overrides: number;
  /** Distinct keys this actor has touched, sorted asc. */
  distinct_keys: string[];
  /** Distinct categories this actor has touched, sorted asc. */
  distinct_categories: ConfigCategory[];
  /** Per-category count breakdown (every category at 0 when absent). */
  by_category: Record<ConfigCategory, number>;
  /** Newest updated_at across this actor's overrides; null when no
   *  timestamped overrides (shouldn't happen but defensive). */
  most_recent_at: string | null;
}

export interface ConfigActorRollupSummary {
  tenant_id: string;
  generated_at: string;
  total_overrides: number;
  total_actors: number;
  actors: ConfigActorRow[];
  /** Top row from actors[] (sorted total_overrides desc); null on empty. */
  most_active_actor: string | null;
  /** Subset of actor_usernames who have at least one features.*
   *  override — security signal. Sorted asc. */
  actors_with_features_overrides: string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────

function emptyByCategory(): Record<ConfigCategory, number> {
  const out = {} as Record<ConfigCategory, number>;
  for (const cat of listCategories()) {
    out[cat] = 0;
  }
  return out;
}

// ─── Pure resolver ─────────────────────────────────────────────────────

export function summarizeConfigActorRollup(
  tenant_id: string,
  entries: readonly ConfigEntry[],
  now: Date,
): ConfigActorRollupSummary {
  type Bucket = {
    total_overrides: number;
    keys: Set<string>;
    categories: Set<ConfigCategory>;
    by_category: Record<ConfigCategory, number>;
    most_recent_at: string | null;
    has_features_override: boolean;
  };
  const buckets = new Map<string, Bucket>();

  let total_overrides = 0;

  for (const entry of entries) {
    // Defaults: skip — only count actual overrides.
    if (entry.is_default) continue;
    const actor = entry.updated_by;
    if (!actor) continue;

    let b = buckets.get(actor);
    if (!b) {
      b = {
        total_overrides: 0,
        keys: new Set<string>(),
        categories: new Set<ConfigCategory>(),
        by_category: emptyByCategory(),
        most_recent_at: null,
        has_features_override: false,
      };
      buckets.set(actor, b);
    }
    b.total_overrides++;
    total_overrides++;
    b.keys.add(entry.key);
    b.categories.add(entry.category);
    b.by_category[entry.category]++;
    if (entry.category === 'features') {
      b.has_features_override = true;
    }
    if (entry.updated_at && (!b.most_recent_at || entry.updated_at > b.most_recent_at)) {
      b.most_recent_at = entry.updated_at;
    }
  }

  const actors: ConfigActorRow[] = [...buckets.entries()]
    .map(([actor, b]) => ({
      updated_by: actor,
      total_overrides: b.total_overrides,
      distinct_keys: [...b.keys].sort(),
      distinct_categories: [...b.categories].sort() as ConfigCategory[],
      by_category: { ...b.by_category },
      most_recent_at: b.most_recent_at,
    }))
    .sort((a, b) => {
      if (b.total_overrides !== a.total_overrides) {
        return b.total_overrides - a.total_overrides;
      }
      return a.updated_by.localeCompare(b.updated_by);
    });

  const most_active_actor = actors.length > 0 ? actors[0].updated_by : null;

  const actors_with_features_overrides = [...buckets.entries()]
    .filter(([, b]) => b.has_features_override)
    .map(([actor]) => actor)
    .sort();

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_overrides,
    total_actors: actors.length,
    actors,
    most_active_actor,
    actors_with_features_overrides,
  };
}
