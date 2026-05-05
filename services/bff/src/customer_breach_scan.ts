// services/bff/src/customer_breach_scan.ts
//
// T6 M4.5 — Customer breach scan.
//
// Closes the EWS detection chain shipped in M4.1–M4.4:
//
//   M4.1 KRI catalog (17 indicators)
//   M4.3 thresholds  (3-zone yellow/orange/red)
//   M4.4 overrides   (per-tenant tuning)
//   M4.5 scan        ← this slice — scan ALL indicators for a customer
//
// Drives the SPA's "customer health check" panel: pick a customer,
// see every breach across every applicable indicator, ranked
// red→green with summary counts.
//
// Design:
//  - Pure function. Deterministic per (tenant, customer_id, day)
//    via FNV-1a + Mulberry32 — same scheme as M14 stub adapters
//    so the SPA renders the same numbers within a day.
//  - Filters by vertical: callers can scan only banking or only
//    insurance indicators. Default = all 17.
//  - Returns breach[] sorted: red first, then orange, yellow,
//    green. Within a class, ordered by indicator catalog position
//    (FIN-001 first, etc.) for deterministic SPA layout.
//  - Summary block carries 4-class counts + worst_class for the
//    dashboard badge.

import {
  type ScoringVertical,
  STUB_CATALOG as INDICATOR_CATALOG,
} from './bil_scoring_v2';
import {
  type BreachClass,
  type BreachResult,
  type IndicatorThreshold,
  type ThresholdOverrideStore,
  checkBreach,
} from './indicator_thresholds';

// ─── Public types ─────────────────────────────────────────────────────

export interface BreachScanInput {
  tenant_id: string;
  customer_id: string;
  vertical?: ScoringVertical;
}

export interface BreachScanSummary {
  red_count: number;
  orange_count: number;
  yellow_count: number;
  green_count: number;
  total: number;
  /** Highest breach class observed across the scan; null when no
   *  indicators applied (cross-vertical with no matching ids). */
  worst_class: BreachClass | null;
}

export interface BreachScanResult {
  tenant_id: string;
  customer_id: string;
  vertical: ScoringVertical | 'all';
  scanned_at: string;
  breaches: BreachResult[];
  summary: BreachScanSummary;
}

export class BreachScanError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BreachScanError';
  }
}

// ─── Deterministic PRNG (FNV-1a + Mulberry32) ─────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic synthesis of an indicator value for (tenant,
 * customer, indicator, day). Returns a value in [0, 1] uniformly
 * distributed — production swap would compute the real KRI from
 * the customer's transaction stream.
 */
function synthValue(
  tenant_id: string,
  customer_id: string,
  indicator_id: string,
  day: string,
): number {
  const seed = fnv1a(`scan|${tenant_id}|${customer_id}|${indicator_id}|${day}`);
  return rng(seed)();
}

// ─── Sorting ──────────────────────────────────────────────────────────

const CLASS_ORDER: Record<BreachClass, number> = {
  red: 0,
  orange: 1,
  yellow: 2,
  green: 3,
};

const CATALOG_ORDER = new Map<string, number>(
  Object.keys(INDICATOR_CATALOG).map((id, idx) => [id, idx]),
);

function compareBreaches(a: BreachResult, b: BreachResult): number {
  const cls = CLASS_ORDER[a.breach_class] - CLASS_ORDER[b.breach_class];
  if (cls !== 0) return cls;
  // Same class — preserve catalog order for deterministic SPA layout.
  return (
    (CATALOG_ORDER.get(a.indicator_id) ?? 99) -
    (CATALOG_ORDER.get(b.indicator_id) ?? 99)
  );
}

function worstOf(breaches: readonly BreachResult[]): BreachClass | null {
  if (breaches.length === 0) return null;
  let worst: BreachClass = 'green';
  for (const b of breaches) {
    if (CLASS_ORDER[b.breach_class] < CLASS_ORDER[worst]) worst = b.breach_class;
  }
  return worst;
}

// ─── Main entry ───────────────────────────────────────────────────────

/**
 * Pure-function customer breach scanner. Synthesises per-indicator
 * values for the given (tenant, customer, day) and runs each
 * through the effective threshold (M4.4 store falls through to
 * M4.3 platform defaults).
 *
 * `vertical` filter: 'banking' or 'insurance' to scan a subset;
 * omit (or 'all') to scan everything.
 */
export function scanCustomerBreaches(
  input: BreachScanInput,
  store: ThresholdOverrideStore,
  asOf: Date,
): BreachScanResult {
  if (!input || typeof input !== 'object') {
    throw new BreachScanError('invalid_input', 'request body required');
  }
  if (typeof input.tenant_id !== 'string' || !input.tenant_id.trim()) {
    throw new BreachScanError('invalid_input', 'tenant_id required');
  }
  if (typeof input.customer_id !== 'string' || !input.customer_id.trim()) {
    throw new BreachScanError('invalid_input', 'customer_id required');
  }
  if (
    input.vertical !== undefined &&
    input.vertical !== 'banking' &&
    input.vertical !== 'insurance'
  ) {
    throw new BreachScanError(
      'invalid_input',
      "vertical must be 'banking' or 'insurance'",
    );
  }

  const day = asOf.toISOString().slice(0, 10);
  const breaches: BreachResult[] = [];

  for (const [indicator_id, entry] of Object.entries(INDICATOR_CATALOG)) {
    if (input.vertical && entry.vertical !== input.vertical) continue;
    const t: IndicatorThreshold | null = store.effective(input.tenant_id, indicator_id);
    if (!t) continue;
    const value = synthValue(input.tenant_id, input.customer_id, indicator_id, day);
    const result = checkBreach(t, value);
    breaches.push(result);
  }

  breaches.sort(compareBreaches);

  const summary: BreachScanSummary = {
    red_count: breaches.filter((b) => b.breach_class === 'red').length,
    orange_count: breaches.filter((b) => b.breach_class === 'orange').length,
    yellow_count: breaches.filter((b) => b.breach_class === 'yellow').length,
    green_count: breaches.filter((b) => b.breach_class === 'green').length,
    total: breaches.length,
    worst_class: worstOf(breaches),
  };

  return {
    tenant_id: input.tenant_id,
    customer_id: input.customer_id,
    vertical: input.vertical ?? 'all',
    scanned_at: asOf.toISOString(),
    breaches,
    summary,
  };
}

// ─── M4.6 — Bulk customer breach scan ────────────────────────────────

export interface BulkBreachScanInput {
  tenant_id: string;
  customer_ids: string[];
  vertical?: ScoringVertical;
}

export interface BulkBreachScanRow {
  customer_id: string;
  summary: BreachScanSummary;
}

export interface BulkBreachScanAggregate {
  customer_count: number;
  red_total: number;
  orange_total: number;
  yellow_total: number;
  green_total: number;
  /** Customers with ≥ 1 red breach. */
  customers_with_red: number;
  /** Customers with ≥ 1 orange OR red breach. */
  customers_attention_required: number;
}

export interface BulkBreachScanResult {
  tenant_id: string;
  vertical: ScoringVertical | 'all';
  scanned_at: string;
  results: BulkBreachScanRow[];
  aggregate: BulkBreachScanAggregate;
}

const MAX_BATCH = 50;

const ROW_CLASS_ORDER: Record<BreachClass, number> = CLASS_ORDER;

function compareRows(a: BulkBreachScanRow, b: BulkBreachScanRow): number {
  // Worst-class first; null worst (no indicators) sorts last.
  const aw = a.summary.worst_class;
  const bw = b.summary.worst_class;
  if (aw === null && bw === null) return 0;
  if (aw === null) return 1;
  if (bw === null) return -1;
  return ROW_CLASS_ORDER[aw] - ROW_CLASS_ORDER[bw];
}

/**
 * Pure-function bulk scan. Iterates scanCustomerBreaches per id;
 * surfaces a slim per-customer summary + portfolio aggregate.
 * Cap 50 customers per call; duplicates rejected.
 */
export function scanCustomerBreachesBulk(
  input: BulkBreachScanInput,
  store: ThresholdOverrideStore,
  asOf: Date,
): BulkBreachScanResult {
  if (!input || typeof input !== 'object') {
    throw new BreachScanError('invalid_input', 'request body required');
  }
  if (typeof input.tenant_id !== 'string' || !input.tenant_id.trim()) {
    throw new BreachScanError('invalid_input', 'tenant_id required');
  }
  if (!Array.isArray(input.customer_ids) || input.customer_ids.length === 0) {
    throw new BreachScanError('invalid_input', 'customer_ids[] must be non-empty');
  }
  if (input.customer_ids.length > MAX_BATCH) {
    throw new BreachScanError(
      'invalid_input',
      `customer_ids exceeds batch cap of ${MAX_BATCH}`,
    );
  }
  if (
    input.vertical !== undefined &&
    input.vertical !== 'banking' &&
    input.vertical !== 'insurance'
  ) {
    throw new BreachScanError(
      'invalid_input',
      "vertical must be 'banking' or 'insurance'",
    );
  }
  const seen = new Set<string>();
  for (const cid of input.customer_ids) {
    if (typeof cid !== 'string' || !cid.trim()) {
      throw new BreachScanError(
        'invalid_input',
        'every customer_id must be a non-empty string',
      );
    }
    if (seen.has(cid)) {
      throw new BreachScanError('invalid_input', `duplicate customer_id: ${cid}`);
    }
    seen.add(cid);
  }

  const results: BulkBreachScanRow[] = input.customer_ids.map((cid) => {
    const r = scanCustomerBreaches(
      { tenant_id: input.tenant_id, customer_id: cid, vertical: input.vertical },
      store,
      asOf,
    );
    return { customer_id: cid, summary: r.summary };
  });

  results.sort(compareRows);

  let red = 0;
  let orange = 0;
  let yellow = 0;
  let green = 0;
  let withRed = 0;
  let attention = 0;
  for (const row of results) {
    red += row.summary.red_count;
    orange += row.summary.orange_count;
    yellow += row.summary.yellow_count;
    green += row.summary.green_count;
    if (row.summary.red_count > 0) withRed += 1;
    if (row.summary.red_count > 0 || row.summary.orange_count > 0) attention += 1;
  }

  return {
    tenant_id: input.tenant_id,
    vertical: input.vertical ?? 'all',
    scanned_at: asOf.toISOString(),
    results,
    aggregate: {
      customer_count: results.length,
      red_total: red,
      orange_total: orange,
      yellow_total: yellow,
      green_total: green,
      customers_with_red: withRed,
      customers_attention_required: attention,
    },
  };
}
