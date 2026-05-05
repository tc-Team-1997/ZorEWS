// services/bff/src/scenario_diff.ts
//
// T6 M16.3 — Scenario diff.
//
// M16.1 ships the BIL named scenario library (10 presets). M16.2
// ships bulk-run aggregation. M16.3 closes the SPA-side comparison
// story: "show me what's different between RBI Baseline and RBI
// Adverse." A pure-function field-by-field diff over two
// `ScenarioPreset` records — categorical fields surfaced as before/
// after string pairs, numeric shock fields surfaced with absolute
// + percent deltas, sorted by magnitude.
//
// Design:
//  - Pure function. No store, no AppDeps slot. The library is
//    already module-level static.
//  - Diff entries cover every visible field on `ScenarioPreset` so
//    the SPA can render them in a unified table without per-field
//    branching. `changed=true` flags drive the "only changed"
//    toggle; `delta_abs`/`delta_pct` only populate for numeric
//    fields.
//  - Comparing the same preset to itself is rejected as a 400
//    `same_preset` — diff of N to N is a no-op the SPA shouldn't
//    issue. Comparing baseline=zero-shocks to itself is the obvious
//    accidental case.
//  - The output `entries[]` carries every field in declared order;
//    `changed_entries[]` is the filtered subset, sorted by
//    |delta_abs| desc for numerics, then by name for categoricals.

import {
  type ScenarioPreset,
  type ScenarioShocks,
  getScenarioPreset,
} from './scenario_library';

// ─── Public types ─────────────────────────────────────────────────────

export type DiffFieldKind = 'numeric' | 'enum' | 'string';

export interface DiffEntry {
  field: string;
  kind: DiffFieldKind;
  left: number | string;
  right: number | string;
  /** Populated only for kind='numeric'. right - left. */
  delta_abs?: number;
  /** Populated only for kind='numeric' AND left !== 0. (right - left) / |left|. */
  delta_pct?: number;
  /** True iff `left !== right` (string equality for non-numerics). */
  changed: boolean;
}

export interface ScenarioDiffResult {
  left: ScenarioPreset;
  right: ScenarioPreset;
  /** Every comparable field, in declared order. */
  entries: DiffEntry[];
  /** Subset filtered to changed=true. Numeric fields sorted by
   *  |delta_abs| desc; categoricals by field name asc. Numeric
   *  block precedes the categorical block. */
  changed_entries: DiffEntry[];
  /** Flat shock delta — convenient for the SPA to drive a small
   *  bar chart without re-walking entries[]. */
  shocks_delta: ScenarioShocks;
  /** generated_at ISO. */
  generated_at: string;
}

export class ScenarioDiffError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ScenarioDiffError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function numericEntry(
  field: string,
  left: number,
  right: number,
): DiffEntry {
  const delta_abs = right - left;
  const entry: DiffEntry = {
    field,
    kind: 'numeric',
    left,
    right,
    delta_abs,
    changed: left !== right,
  };
  if (left !== 0) {
    entry.delta_pct = delta_abs / Math.abs(left);
  }
  return entry;
}

function categoricalEntry(
  field: string,
  kind: DiffFieldKind,
  left: string,
  right: string,
): DiffEntry {
  return {
    field,
    kind,
    left,
    right,
    changed: left !== right,
  };
}

// ─── Main entry ───────────────────────────────────────────────────────

/**
 * Pure-function field-by-field diff between two scenario presets.
 *
 * Fields covered (declared order):
 *   1. category         (enum)
 *   2. regulator        (enum)
 *   3. severity         (enum)
 *   4. shocks.gdp       (numeric)
 *   5. shocks.rate      (numeric)
 *   6. shocks.fx        (numeric)
 *   7. source_doc       (string)
 *   8. name             (string)
 *
 * `id` and `description` are intentionally excluded — `id` is the
 * lookup key (always different here by construction since same-id
 * is a 400) and `description` is free-text prose that adds noise
 * to the diff without operational signal.
 */
export function diffScenarios(left: ScenarioPreset, right: ScenarioPreset, now: Date): ScenarioDiffResult {
  const entries: DiffEntry[] = [
    categoricalEntry('category', 'enum', left.category, right.category),
    categoricalEntry('regulator', 'enum', left.regulator, right.regulator),
    categoricalEntry('severity', 'enum', left.severity, right.severity),
    numericEntry('shocks.gdp', left.shocks.gdp, right.shocks.gdp),
    numericEntry('shocks.rate', left.shocks.rate, right.shocks.rate),
    numericEntry('shocks.fx', left.shocks.fx, right.shocks.fx),
    categoricalEntry('source_doc', 'string', left.source_doc, right.source_doc),
    categoricalEntry('name', 'string', left.name, right.name),
  ];

  const changed = entries.filter((e) => e.changed);
  const numericChanged = changed
    .filter((e) => e.kind === 'numeric')
    .sort((a, b) => Math.abs(b.delta_abs!) - Math.abs(a.delta_abs!));
  const categoricalChanged = changed
    .filter((e) => e.kind !== 'numeric')
    .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));

  return {
    left,
    right,
    entries,
    changed_entries: [...numericChanged, ...categoricalChanged],
    shocks_delta: {
      gdp: right.shocks.gdp - left.shocks.gdp,
      rate: right.shocks.rate - left.shocks.rate,
      fx: right.shocks.fx - left.shocks.fx,
    },
    generated_at: now.toISOString(),
  };
}

/**
 * Optional lookup callback to extend resolution beyond the M16.1
 * platform library (M16.5 — wires the customPresetStore so
 * tenant-authored ids resolve too).
 */
export type DiffPresetLookup = (id: string) => ScenarioPreset | null;

/**
 * Resolve preset ids to ScenarioPreset records and run the diff.
 * Code-routed validation:
 *   - missing/blank left_id|right_id → invalid_input (400)
 *   - left_id === right_id           → same_preset (400)
 *   - either id not in library       → unknown_preset (404)
 */
export function diffScenariosByIds(
  left_id: unknown,
  right_id: unknown,
  now: Date,
  lookup: DiffPresetLookup = getScenarioPreset,
): ScenarioDiffResult {
  if (typeof left_id !== 'string' || !left_id.trim()) {
    throw new ScenarioDiffError('invalid_input', 'left_id is required');
  }
  if (typeof right_id !== 'string' || !right_id.trim()) {
    throw new ScenarioDiffError('invalid_input', 'right_id is required');
  }
  if (left_id === right_id) {
    throw new ScenarioDiffError(
      'same_preset',
      'left_id and right_id are the same preset — diff would be empty',
    );
  }
  const left = lookup(left_id);
  if (!left) {
    throw new ScenarioDiffError('unknown_preset', `unknown preset: ${left_id}`);
  }
  const right = lookup(right_id);
  if (!right) {
    throw new ScenarioDiffError('unknown_preset', `unknown preset: ${right_id}`);
  }
  return diffScenarios(left, right, now);
}
