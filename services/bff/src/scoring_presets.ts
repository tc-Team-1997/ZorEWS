// services/bff/src/scoring_presets.ts
//
// T6 M6.3 — Scoring weight presets.
//
// M6.1 ships the Σ(W×V) scorer with explicit weights. M6.2 ships
// the catalog-lookup convenience layer (resolves weights from the
// platform-default indicator catalog). M6.3 adds a small library
// of NAMED weight bundles tenants can apply when the catalog
// defaults don't match their risk appetite:
//
//   conservative — bias TOWARD higher weights (catch more risk;
//                  more alerts, higher recall, lower precision)
//   balanced     — catalog defaults (multiplier 1.0 across the
//                  board; SPA still uses this preset for "use the
//                  platform default" UX)
//   aggressive   — bias DOWN on selected indicators (fewer false
//                  positives, accepts lower recall — useful for
//                  ops teams who can't keep up with the alert
//                  volume)
//
// Design:
//  - Pure data + 1 pure-function "score by preset" entry point.
//    No store, no AppDeps slot. Future M6.4 will land per-tenant
//    custom presets with a CRUD store.
//  - Multipliers are SPARSE — only indicators the preset wants to
//    bias appear in `weight_multipliers`. Indicators not in the map
//    use the unmodified catalog default (multiplier 1.0).
//  - Conservative preset multipliers ≥ 1 on the "bad signals"
//    (fraud history, repeat claims, DPD). Aggressive ≤ 1.

import {
  IndicatorLookupError,
  scoreFromIndicators,
  type ByIndicatorItem,
  type IndicatorWeight,
  type IndicatorWeightLookup,
  type ScoringByIndicatorsResult,
  type ScoringVertical,
} from './bil_scoring_v2';

// ─── Public types ─────────────────────────────────────────────────────

export type WeightPresetMode = 'conservative' | 'balanced' | 'aggressive';

export const VALID_PRESET_MODES: readonly WeightPresetMode[] = [
  'conservative',
  'balanced',
  'aggressive',
] as const;

export interface WeightPreset {
  id: string;
  name: string;
  description: string;
  vertical: ScoringVertical;
  mode: WeightPresetMode;
  /** Sparse map: indicator_id → multiplier. Indicators not listed
   *  default to 1.0 (catalog weight passes through unchanged). */
  weight_multipliers: Readonly<Record<string, number>>;
}

export interface ScoreByPresetInput {
  preset_id: string;
  items: ByIndicatorItem[];
}

export interface ScoreByPresetResult extends ScoringByIndicatorsResult {
  preset_id: string;
  preset_name: string;
  preset_mode: WeightPresetMode;
  /** Per-indicator details: catalog weight, applied multiplier,
   *  effective weight = catalog × multiplier. Useful for the SPA
   *  to show a "why this score?" breakdown. */
  effective_weights: Array<{
    indicator_id: string;
    catalog_weight: number;
    multiplier: number;
    effective_weight: number;
  }>;
}

export class WeightPresetError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'WeightPresetError';
  }
}

// ─── Seed library — 6 presets (3 modes × 2 verticals) ─────────────────

export const WEIGHT_PRESETS: readonly WeightPreset[] = [
  // ─── banking ──────────────────────────────────────────────────────
  {
    id: 'preset_banking_conservative',
    name: 'Banking — Conservative',
    description:
      'High-recall posture. Boosts DPD, credit utilisation, and balance run-down signals. Use when alert volume is preferable to missed risk.',
    vertical: 'banking',
    mode: 'conservative',
    weight_multipliers: {
      'FIN-001': 1.15, // DPD ≥ 30 — boost
      'FIN-002': 1.1,  // Credit utilisation
      'BEH-001': 1.2,  // Balance run-down
      'TXN-002': 1.1,  // Cross-border outflow
    },
  },
  {
    id: 'preset_banking_balanced',
    name: 'Banking — Balanced',
    description:
      'Catalog defaults pass through unchanged. Reference posture for new tenants.',
    vertical: 'banking',
    mode: 'balanced',
    weight_multipliers: {},
  },
  {
    id: 'preset_banking_aggressive',
    name: 'Banking — Aggressive',
    description:
      'Lower-volume posture. Tones down softer behavioural signals so only severe DPD + utilisation events drive alerts.',
    vertical: 'banking',
    mode: 'aggressive',
    weight_multipliers: {
      'BEH-002': 0.7,  // Login frequency drop — tone down
      'TXN-001': 0.85, // Transaction velocity spike
      'FIN-003': 0.85, // Income volatility
    },
  },

  // ─── insurance ────────────────────────────────────────────────────
  {
    id: 'preset_insurance_conservative',
    name: 'Insurance — Conservative',
    description:
      'High-recall posture for fraud-heavy environments. Boosts repeat-claim, claim-deviation, and claim-history signals.',
    vertical: 'insurance',
    mode: 'conservative',
    weight_multipliers: {
      'CLM-001': 1.2,  // Repeat-claim 180d — boost
      'CLM-002': 1.15, // Claim amount deviation > 30%
      'CUS-INS-001': 1.15, // Customer claim history — high
      'POL-002': 1.1,  // Premium arrears
    },
  },
  {
    id: 'preset_insurance_balanced',
    name: 'Insurance — Balanced',
    description:
      'Catalog defaults pass through unchanged. Reference posture for new tenants.',
    vertical: 'insurance',
    mode: 'balanced',
    weight_multipliers: {},
  },
  {
    id: 'preset_insurance_aggressive',
    name: 'Insurance — Aggressive',
    description:
      'Lower-volume posture. Tones down agent persistency + UW operational signals so only direct claim/policy events drive alerts.',
    vertical: 'insurance',
    mode: 'aggressive',
    weight_multipliers: {
      'AGT-001': 0.7,    // Agent persistency drop — tone down
      'OPS-001': 0.6,    // Underwriting p95 delay
      'CUS-INS-002': 0.85, // KYC nearing expiry
    },
  },
] as const;

const PRESETS_BY_ID = new Map<string, WeightPreset>(
  WEIGHT_PRESETS.map((p) => [p.id, p]),
);

// ─── Type guards ──────────────────────────────────────────────────────

export function isWeightPresetMode(s: unknown): s is WeightPresetMode {
  return typeof s === 'string' && VALID_PRESET_MODES.includes(s as WeightPresetMode);
}

// ─── Read API ──────────────────────────────────────────────────────────

export interface PresetListFilter {
  vertical?: ScoringVertical;
  mode?: WeightPresetMode;
}

export function listWeightPresets(filter: PresetListFilter = {}): WeightPreset[] {
  return WEIGHT_PRESETS.filter(
    (p) =>
      (filter.vertical === undefined || p.vertical === filter.vertical) &&
      (filter.mode === undefined || p.mode === filter.mode),
  );
}

export function getWeightPreset(id: string): WeightPreset | null {
  return PRESETS_BY_ID.get(id) ?? null;
}

// ─── Score-by-preset entry ────────────────────────────────────────────

/** Wraps a base lookup, applying the preset's multiplier on top. */
class PresetScopedLookup implements IndicatorWeightLookup {
  constructor(
    private readonly base: IndicatorWeightLookup,
    private readonly preset: WeightPreset,
  ) {}

  getWeight(indicator_id: string, vertical?: ScoringVertical): IndicatorWeight | null {
    // Force vertical to the preset's vertical — a banking preset
    // shouldn't successfully resolve insurance indicators.
    const target = vertical ?? this.preset.vertical;
    if (target !== this.preset.vertical) return null;
    const base = this.base.getWeight(indicator_id, this.preset.vertical);
    if (!base) return null;
    const multiplier = this.preset.weight_multipliers[indicator_id] ?? 1;
    // Clamp to M6.1's required [0, 1] range. Conservative multipliers
    // can push the effective weight above the catalog default; the
    // upstream Σ(W×V) engine treats 1.0 as max severity so clipping
    // there preserves the contract without losing signal.
    const effective = Math.max(0, Math.min(1, base.weight * multiplier));
    return { ...base, weight: effective };
  }
}

/**
 * Optional callback to extend resolution beyond the platform
 * library — M6.5 wires the customWeightPresetStore so tenant-
 * authored ids resolve too. Defaults to library-only.
 */
export type WeightPresetLookup = (id: string) => WeightPreset | null;

/**
 * Score using a named preset's multipliers on top of the base
 * lookup. Code-routed:
 *   - bad input shape         → invalid_input (400)
 *   - unknown preset id       → unknown_preset (404)
 *   - lookup throws below     → bubbled with its own code
 */
export function scoreByPreset(
  input: ScoreByPresetInput,
  baseLookup: IndicatorWeightLookup,
  presetLookup: WeightPresetLookup = getWeightPreset,
): ScoreByPresetResult {
  if (!input || typeof input !== 'object') {
    throw new WeightPresetError('invalid_input', 'request body required');
  }
  if (typeof input.preset_id !== 'string' || !input.preset_id.trim()) {
    throw new WeightPresetError('invalid_input', 'preset_id is required');
  }
  if (!Array.isArray(input.items)) {
    throw new WeightPresetError('invalid_input', 'items must be an array');
  }
  const preset = presetLookup(input.preset_id);
  if (!preset) {
    throw new WeightPresetError('unknown_preset', `unknown preset: ${input.preset_id}`);
  }

  const scopedLookup = new PresetScopedLookup(baseLookup, preset);
  const inner = scoreFromIndicators(input.items, scopedLookup, {
    vertical: preset.vertical,
  });

  // Build the effective_weights breakdown — caller-friendly transparency.
  // Re-resolve catalog weights directly from the base lookup (rather
  // than reverse-engineering from r.weight, which is unreliable once
  // the [0, 1] clamp engages on conservative multipliers).
  const effective_weights = inner.resolved.map((r) => {
    const multiplier = preset.weight_multipliers[r.indicator_id] ?? 1;
    const catalog = baseLookup.getWeight(r.indicator_id, preset.vertical);
    const catalog_weight = catalog?.weight ?? r.weight;
    return {
      indicator_id: r.indicator_id,
      catalog_weight,
      multiplier,
      effective_weight: r.weight,
    };
  });

  return {
    ...inner,
    preset_id: preset.id,
    preset_name: preset.name,
    preset_mode: preset.mode,
    effective_weights,
  };
}

// Re-export so the route handler doesn't need a separate import.
export { IndicatorLookupError };

// ─── M6.6 — Batch score by preset across N customers ─────────────────

export interface ScoreBatchCustomerInput {
  customer_id: string;
  items: ByIndicatorItem[];
}

export interface ScoreBatchInput {
  preset_id: string;
  customers: ScoreBatchCustomerInput[];
}

export interface ScoreBatchRow {
  customer_id: string;
  score: number;
  category: 'low' | 'medium' | 'high';
}

export interface ScoreBatchAggregate {
  count: number;
  mean_score: number;
  low_count: number;
  medium_count: number;
  high_count: number;
}

export interface ScoreBatchResult {
  preset_id: string;
  preset_name: string;
  preset_mode: WeightPresetMode;
  results: ScoreBatchRow[];
  aggregate: ScoreBatchAggregate;
  scored_at: string;
}

const MAX_BATCH = 50;

/**
 * Pure-function batch score. Calls scoreByPreset per customer and
 * aggregates. Bounded at 50 customers per call.
 */
export function scoreByPresetBatch(
  input: ScoreBatchInput,
  baseLookup: IndicatorWeightLookup,
  presetLookup: WeightPresetLookup = getWeightPreset,
  asOf: Date = new Date(),
): ScoreBatchResult {
  if (!input || typeof input !== 'object') {
    throw new WeightPresetError('invalid_input', 'request body required');
  }
  if (typeof input.preset_id !== 'string' || !input.preset_id.trim()) {
    throw new WeightPresetError('invalid_input', 'preset_id is required');
  }
  if (!Array.isArray(input.customers) || input.customers.length === 0) {
    throw new WeightPresetError('invalid_input', 'customers[] must be non-empty');
  }
  if (input.customers.length > MAX_BATCH) {
    throw new WeightPresetError(
      'invalid_input',
      `customers exceeds batch cap of ${MAX_BATCH}`,
    );
  }
  const seen = new Set<string>();
  for (const c of input.customers) {
    if (!c || typeof c !== 'object') {
      throw new WeightPresetError('invalid_input', 'each customer entry must be an object');
    }
    if (typeof c.customer_id !== 'string' || !c.customer_id.trim()) {
      throw new WeightPresetError('invalid_input', 'customer_id is required for every entry');
    }
    if (seen.has(c.customer_id)) {
      throw new WeightPresetError('invalid_input', `duplicate customer_id: ${c.customer_id}`);
    }
    seen.add(c.customer_id);
    if (!Array.isArray(c.items)) {
      throw new WeightPresetError('invalid_input', `items must be an array (customer ${c.customer_id})`);
    }
  }

  // Resolve preset once (avoid N lookups for the same id).
  const preset = presetLookup(input.preset_id);
  if (!preset) {
    throw new WeightPresetError('unknown_preset', `unknown preset: ${input.preset_id}`);
  }

  const results: ScoreBatchRow[] = [];
  for (const c of input.customers) {
    const r = scoreByPreset(
      { preset_id: preset.id, items: c.items },
      baseLookup,
      // Reuse the resolved preset for every row instead of re-looking-up.
      () => preset,
    );
    results.push({
      customer_id: c.customer_id,
      score: r.score,
      category: r.category,
    });
  }

  let scoreSum = 0;
  let low = 0;
  let medium = 0;
  let high = 0;
  for (const r of results) {
    scoreSum += r.score;
    if (r.category === 'low') low += 1;
    else if (r.category === 'medium') medium += 1;
    else if (r.category === 'high') high += 1;
  }

  return {
    preset_id: preset.id,
    preset_name: preset.name,
    preset_mode: preset.mode,
    results,
    aggregate: {
      count: results.length,
      mean_score: scoreSum / results.length,
      low_count: low,
      medium_count: medium,
      high_count: high,
    },
    scored_at: asOf.toISOString(),
  };
}

// ─── M6.7 — Preset comparison ────────────────────────────────────────

export interface CompareByPresetsInput {
  left_preset_id: string;
  right_preset_id: string;
  items: ByIndicatorItem[];
}

export interface CompareByPresetsResult {
  left: ScoreByPresetResult;
  right: ScoreByPresetResult;
  /** right.score - left.score (positive = right is more severe). */
  score_delta: number;
  /** True iff both presets bucketed into the same category. */
  category_match: boolean;
  /** True iff both presets share the same vertical (else compare is
   *  not really apples-to-apples). */
  vertical_match: boolean;
  compared_at: string;
}

/**
 * Apply two presets to the same items[] and return a side-by-side
 * comparison. Validation matches scoreByPreset (composes it twice).
 */
export function compareByPresets(
  input: CompareByPresetsInput,
  baseLookup: IndicatorWeightLookup,
  presetLookup: WeightPresetLookup = getWeightPreset,
  asOf: Date = new Date(),
): CompareByPresetsResult {
  if (!input || typeof input !== 'object') {
    throw new WeightPresetError('invalid_input', 'request body required');
  }
  if (typeof input.left_preset_id !== 'string' || !input.left_preset_id.trim()) {
    throw new WeightPresetError('invalid_input', 'left_preset_id is required');
  }
  if (typeof input.right_preset_id !== 'string' || !input.right_preset_id.trim()) {
    throw new WeightPresetError('invalid_input', 'right_preset_id is required');
  }
  if (input.left_preset_id === input.right_preset_id) {
    throw new WeightPresetError(
      'invalid_input',
      'left_preset_id and right_preset_id must differ',
    );
  }

  const left = scoreByPreset(
    { preset_id: input.left_preset_id, items: input.items },
    baseLookup,
    presetLookup,
  );
  const right = scoreByPreset(
    { preset_id: input.right_preset_id, items: input.items },
    baseLookup,
    presetLookup,
  );

  // Resolve presets again to inspect verticals (cheap — already cached).
  const leftPreset = presetLookup(left.preset_id);
  const rightPreset = presetLookup(right.preset_id);

  return {
    left,
    right,
    score_delta: right.score - left.score,
    category_match: left.category === right.category,
    vertical_match:
      leftPreset !== null &&
      rightPreset !== null &&
      leftPreset.vertical === rightPreset.vertical,
    compared_at: asOf.toISOString(),
  };
}
