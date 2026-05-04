// services/bff/src/bil_scoring_v2.ts
//
// T6 M6.2 — BIL scoring with catalog weight lookup.
//
// M6.1 shipped the pure Σ(W×V) formula taking explicit weights:
//
//     POST /v1/scoring/risk { items: [{indicator_id, weight, value}] }
//
// That works for callers who already know the weights, but most BIL
// workflows want to just say "score these indicators that fired" and
// let the platform look up the weights from the catalog. M6.2 adds:
//
//     POST /v1/scoring/risk/by-indicators
//         body: { items: [{indicator_id, value}], vertical?, thresholds? }
//
// The engine looks up `severity_weight` from the indicator catalog
// (M4.1 insurance + the existing banking catalog), packs full M6.1
// items, and delegates to `computeRiskScore`.
//
// Catalog access is pluggable via `IndicatorWeightLookup`. The default
// stub holds an in-memory mirror of the production catalogue's
// `(id, vertical, severity_weight)` tuples — enough for the prototype
// without taking a cross-service file dependency. Production swaps in
// an HTTP-backed adapter that calls
// `regulatory-svc/indicators/by-vertical?vertical=insurance|banking`.

import {
  computeRiskScore,
  ScoringInputError,
  type ScoringResult,
  type ScoringThresholds,
} from './bil_scoring';

// ─── Public types ──────────────────────────────────────────────────────

export type ScoringVertical = 'banking' | 'insurance';

export interface IndicatorWeight {
  weight: number;
  name: string;
}

export interface IndicatorWeightLookup {
  /** Returns the indicator's severity_weight + name, or null when the
   *  id is unknown / not in the requested vertical's catalog. When
   *  `vertical` is undefined, callers should fall back to platform-
   *  default behaviour (search both verticals). */
  getWeight(indicator_id: string, vertical?: ScoringVertical): IndicatorWeight | null;
}

export interface ByIndicatorItem {
  indicator_id: string;
  /** Indicator value 0..1 — same semantics as M6.1's value field. */
  value: number;
}

export class IndicatorLookupError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'IndicatorLookupError';
  }
}

// ─── Stub lookup ───────────────────────────────────────────────────────
//
// Mirrors a useful slice of the production catalogues. The values come
// directly from `services/regulatory-svc/indicators/catalog.json` and
// `catalog_insurance.json` — keep this small, well-known set in sync
// with the canonical catalogue when those evolve. The exhaustive
// production lookup is the HTTP adapter (out of scope for M6.2).

interface StubEntry {
  vertical: ScoringVertical;
  weight: number;
  name: string;
}

/** Catalog mirror — production swap is the HTTP-backed adapter. */
export const STUB_CATALOG: Readonly<Record<string, StubEntry>> = {
  // banking — from catalog.json
  'FIN-001': { vertical: 'banking', weight: 0.9, name: 'DPD ≥ 30 days' },
  'FIN-002': { vertical: 'banking', weight: 0.7, name: 'Credit utilisation > 90%' },
  'FIN-003': { vertical: 'banking', weight: 0.6, name: 'Income volatility — 90d' },
  'BEH-001': { vertical: 'banking', weight: 0.5, name: 'Account-balance run-down' },
  'BEH-002': { vertical: 'banking', weight: 0.4, name: 'Login frequency drop' },
  'TXN-001': { vertical: 'banking', weight: 0.6, name: 'Transaction velocity spike' },
  'TXN-002': { vertical: 'banking', weight: 0.55, name: 'Cross-border outflow' },
  'CRD-001': { vertical: 'banking', weight: 0.65, name: 'Credit-card cash advance ratio' },

  // insurance — from catalog_insurance.json (BIL T6 M4.1)
  'POL-001': { vertical: 'insurance', weight: 0.7, name: 'Policy lapse imminent' },
  'POL-002': { vertical: 'insurance', weight: 0.6, name: 'Premium arrears 60+ days' },
  'CUS-INS-001': { vertical: 'insurance', weight: 0.8, name: 'Customer claim history — high' },
  'CUS-INS-002': { vertical: 'insurance', weight: 0.5, name: 'KYC nearing expiry' },
  'AGT-001': { vertical: 'insurance', weight: 0.6, name: 'Agent persistency drop' },
  'CLM-001': { vertical: 'insurance', weight: 0.85, name: 'Repeat-claim 180d' },
  'CLM-002': { vertical: 'insurance', weight: 0.75, name: 'Claim amount deviation > 30%' },
  'CLM-003': { vertical: 'insurance', weight: 0.7, name: 'Off-template documents' },
  'OPS-001': { vertical: 'insurance', weight: 0.5, name: 'Underwriting p95 delay breach' },
};

export class StubIndicatorWeightLookup implements IndicatorWeightLookup {
  getWeight(indicator_id: string, vertical?: ScoringVertical): IndicatorWeight | null {
    const entry = STUB_CATALOG[indicator_id];
    if (!entry) return null;
    if (vertical !== undefined && entry.vertical !== vertical) return null;
    return { weight: entry.weight, name: entry.name };
  }
}

/** Module-level singleton used by routes when no override is supplied. */
export const defaultIndicatorWeightLookup: IndicatorWeightLookup = new StubIndicatorWeightLookup();

// ─── Public entry point ───────────────────────────────────────────────

const VALID_VERTICALS: ScoringVertical[] = ['banking', 'insurance'];

export function isScoringVertical(s: unknown): s is ScoringVertical {
  return typeof s === 'string' && VALID_VERTICALS.includes(s as ScoringVertical);
}

export interface ScoringByIndicatorsResult extends ScoringResult {
  /** Echo of the vertical filter applied (or null when not filtered). */
  vertical: ScoringVertical | null;
  /** Resolved indicator names per id — populated for the SPA so it
   *  doesn't need to round-trip back to the catalog. Same order as
   *  the input items. */
  resolved: { indicator_id: string; name: string; weight: number }[];
}

/**
 * Resolve weights from the catalog and delegate to M6.1's
 * `computeRiskScore`. When an indicator is unknown / out-of-vertical,
 * throws IndicatorLookupError with code `unknown_indicator`. When
 * `items` is empty, defers to M6.1's empty-items error path.
 */
export function scoreFromIndicators(
  items: readonly ByIndicatorItem[],
  lookup: IndicatorWeightLookup,
  opts: { vertical?: ScoringVertical; thresholds?: Partial<ScoringThresholds> } = {},
): ScoringByIndicatorsResult {
  if (!Array.isArray(items)) {
    throw new IndicatorLookupError('invalid_input', 'items must be an array');
  }
  // Resolve all weights first — fail fast on the first unknown id so
  // the caller sees a deterministic 400 instead of an inconsistent
  // partial computation.
  const resolved: { indicator_id: string; name: string; weight: number; value: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (!it || typeof it.indicator_id !== 'string' || !it.indicator_id.trim()) {
      throw new IndicatorLookupError('invalid_input', `items[${i}].indicator_id is required`);
    }
    if (typeof it.value !== 'number' || !Number.isFinite(it.value)) {
      throw new IndicatorLookupError(
        'invalid_input',
        `items[${i}] (${it.indicator_id}): value must be a finite number`,
      );
    }
    const w = lookup.getWeight(it.indicator_id, opts.vertical);
    if (!w) {
      const where = opts.vertical ? ` in vertical '${opts.vertical}'` : '';
      throw new IndicatorLookupError(
        'unknown_indicator',
        `indicator_id '${it.indicator_id}' not found in catalog${where}`,
      );
    }
    resolved.push({
      indicator_id: it.indicator_id,
      name: w.name,
      weight: w.weight,
      value: it.value,
    });
  }

  // Delegate to M6.1.
  const m61 = computeRiskScore(
    resolved.map((r) => ({
      indicator_id: r.indicator_id,
      weight: r.weight,
      value: r.value,
    })),
    opts.thresholds,
  );

  return {
    ...m61,
    vertical: opts.vertical ?? null,
    resolved: resolved.map((r) => ({
      indicator_id: r.indicator_id,
      name: r.name,
      weight: r.weight,
    })),
  };
}

/** Re-export so the route can route ScoringInputError 400s the same
 *  way as M6.1's primary endpoint. */
export { ScoringInputError };
