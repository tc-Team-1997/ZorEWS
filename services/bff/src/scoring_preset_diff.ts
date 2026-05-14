// services/bff/src/scoring_preset_diff.ts
//
// T6 M6.9 — Weight preset definition diff.
//
// M6.3 ships the library presets; M6.4 the per-tenant custom store.
// M6.7 already compares the SCORES two presets produce on the same
// items — i.e. an outcome-level comparison. What's missing is a
// simpler DEFINITION-level diff: "before I apply either preset, how
// do their multiplier maps actually differ?". That's the question a
// risk officer asks while authoring a new custom preset that's a
// tweak of an existing one.
//
// Design:
//  - Pure function. Takes two resolved WeightPreset objects + returns
//    a structural diff. No store coupling — the route resolves both
//    presets via getEffectiveWeightPreset (library + custom) and
//    hands them off.
//  - The multiplier map is sparse — entries not in the map mean
//    "use catalog default (multiplier 1.0)". The diff treats an entry
//    that exists in A but not B (or vice versa) as `added`/`removed`,
//    NOT as a "change from 1.0 → x" — because the SPA cares about
//    which entries the operator typed, not the inferred default.
//  - Header diffs (name/description/vertical/mode) surface as
//    boolean changes plus from/to values.

import type { WeightPreset } from './scoring_presets';

// ─── Public types ─────────────────────────────────────────────────────

export interface MultiplierAdded {
  indicator_id: string;
  to: number;
}

export interface MultiplierRemoved {
  indicator_id: string;
  from: number;
}

export interface MultiplierChanged {
  indicator_id: string;
  from: number;
  to: number;
  /** to - from. Positive = stricter on this indicator, negative = looser. */
  delta: number;
}

export interface HeaderDiff<T> {
  changed: boolean;
  from: T;
  to: T;
}

export interface WeightPresetDiff {
  from_id: string;
  to_id: string;
  identical: boolean;
  header: {
    name: HeaderDiff<string>;
    description: HeaderDiff<string>;
    vertical: HeaderDiff<string>;
    mode: HeaderDiff<string>;
  };
  multipliers: {
    /** Indicators present in `to` but not in `from`. Sorted by indicator_id asc. */
    added: MultiplierAdded[];
    /** Indicators present in `from` but not in `to`. Sorted by indicator_id asc. */
    removed: MultiplierRemoved[];
    /** Indicators in both with a different value. Sorted by abs(delta) desc, then indicator_id asc. */
    changed: MultiplierChanged[];
    /** Indicators in both with the same value (count only — list withheld to keep payloads small). */
    unchanged_count: number;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function header<T>(a: T, b: T): HeaderDiff<T> {
  return { changed: a !== b, from: a, to: b };
}

// ─── Pure diff ────────────────────────────────────────────────────────

/**
 * Structural diff between two WeightPresets. Pure-function; no I/O,
 * no store coupling. Caller resolves both presets via
 * `getEffectiveWeightPreset` (library + custom) before calling.
 */
export function diffWeightPresets(
  from: WeightPreset,
  to: WeightPreset,
): WeightPresetDiff {
  const added: MultiplierAdded[] = [];
  const removed: MultiplierRemoved[] = [];
  const changed: MultiplierChanged[] = [];
  let unchanged_count = 0;

  const aKeys = Object.keys(from.weight_multipliers);
  const bKeys = Object.keys(to.weight_multipliers);
  const allKeys = new Set([...aKeys, ...bKeys]);

  for (const key of allKeys) {
    const av = from.weight_multipliers[key];
    const bv = to.weight_multipliers[key];
    if (av === undefined && bv !== undefined) {
      added.push({ indicator_id: key, to: bv });
    } else if (av !== undefined && bv === undefined) {
      removed.push({ indicator_id: key, from: av });
    } else if (av !== undefined && bv !== undefined) {
      if (av === bv) {
        unchanged_count += 1;
      } else {
        changed.push({ indicator_id: key, from: av, to: bv, delta: bv - av });
      }
    }
  }

  added.sort((a, b) => (a.indicator_id < b.indicator_id ? -1 : a.indicator_id > b.indicator_id ? 1 : 0));
  removed.sort((a, b) => (a.indicator_id < b.indicator_id ? -1 : a.indicator_id > b.indicator_id ? 1 : 0));
  changed.sort((a, b) => {
    const ad = Math.abs(a.delta);
    const bd = Math.abs(b.delta);
    if (ad !== bd) return bd - ad;
    return a.indicator_id < b.indicator_id ? -1 : a.indicator_id > b.indicator_id ? 1 : 0;
  });

  const headerBlock = {
    name: header(from.name, to.name),
    description: header(from.description, to.description),
    vertical: header(from.vertical, to.vertical),
    mode: header(from.mode, to.mode),
  };

  const headerChanged = Object.values(headerBlock).some((h) => h.changed);
  const multipliersChanged =
    added.length > 0 || removed.length > 0 || changed.length > 0;

  return {
    from_id: from.id,
    to_id: to.id,
    identical: !headerChanged && !multipliersChanged,
    header: headerBlock,
    multipliers: { added, removed, changed, unchanged_count },
  };
}
