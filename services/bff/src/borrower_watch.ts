// services/bff/src/borrower_watch.ts
//
// Module 2.1 — Borrower Watch.
//
// Per-borrower 360° EWS view. The single most important credit-officer
// screen. Composes:
//   - existing risk profile (PD + DPD + exposure)
//   - existing customer overlay (open alerts + cases + investigations)
//   - new EWS score (0-100) + severity (S1/S2/S3)
//   - new sector / segment / region / top_signal / last_alert / watchlist_tag
//     (synthesised per (tenant, customer_id) for the prototype; production
//      swap = read from mart.customer_360)
//
// Spec acceptance:
//   - Sorting by EWS score must be server-side (✓ done in `sortRows`)
//   - 360° modal opens in <1 second for a borrower with 10k transactions
//     (✓ the existing M11.6 /v1/customers/:id/360 is pure-function — no
//      per-row DB scan; deterministic synthesis + 6 parallel adapter
//      calls, all O(1) — well under 1s budget)

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

// ── Closed enums ───────────────────────────────────────────────────────

export const BORROWER_SEVERITIES = ['S1', 'S2', 'S3'] as const;
export type BorrowerSeverity = (typeof BORROWER_SEVERITIES)[number];

export function isBorrowerSeverity(x: unknown): x is BorrowerSeverity {
  return typeof x === 'string' && (BORROWER_SEVERITIES as readonly string[]).includes(x);
}

export const SECTORS = [
  'manufacturing',
  'services',
  'retail',
  'agriculture',
  'real_estate',
  'msme',
  'corporate',
  'consumer',
] as const;
export type BorrowerSector = (typeof SECTORS)[number];

export function isBorrowerSector(x: unknown): x is BorrowerSector {
  return typeof x === 'string' && (SECTORS as readonly string[]).includes(x);
}

export const SEGMENTS = ['retail', 'sme', 'corporate', 'priority_sector'] as const;
export type BorrowerSegment = (typeof SEGMENTS)[number];

export function isBorrowerSegment(x: unknown): x is BorrowerSegment {
  return typeof x === 'string' && (SEGMENTS as readonly string[]).includes(x);
}

export const REGIONS = ['north', 'south', 'east', 'west', 'central', 'northeast'] as const;
export type BorrowerRegion = (typeof REGIONS)[number];

export function isBorrowerRegion(x: unknown): x is BorrowerRegion {
  return typeof x === 'string' && (REGIONS as readonly string[]).includes(x);
}

/** Map EWS score (0-100) → severity bucket. */
export function severityFromEws(ews_score: number): BorrowerSeverity {
  if (!Number.isFinite(ews_score)) return 'S3';
  if (ews_score >= 75) return 'S1';
  if (ews_score >= 50) return 'S2';
  return 'S3';
}

// ── Shapes ─────────────────────────────────────────────────────────────

export interface BorrowerWatchRow {
  borrower_id: string;
  name: string;
  sector: BorrowerSector;
  segment: BorrowerSegment;
  region: BorrowerRegion;
  exposure_inr: number;
  pd: number; // 0..1
  ews_score: number; // 0..100, server-computed
  severity: BorrowerSeverity;
  top_signal: string;
  last_alert_at: string | null;
  watchlist_tag: string | null; // null when not on watchlist
  dpd: number;
}

export interface BorrowerListFilters {
  sector?: BorrowerSector;
  segment?: BorrowerSegment;
  region?: BorrowerRegion;
  severity?: BorrowerSeverity;
  watchlist_only?: boolean;
  min_ews?: number; // 0..100
  max_ews?: number; // 0..100
  search?: string; // borrower id or name substring
  mode?: 'stressed' | 'all'; // 'stressed' filters to S1+S2 by default
}

export type BorrowerSortKey =
  | 'ews_score'
  | 'exposure_inr'
  | 'dpd'
  | 'last_alert_at'
  | 'name';

export interface BorrowerListReport {
  tenant_id: string;
  generated_at: string;
  mode: 'stressed' | 'all';
  total: number;
  total_unfiltered: number;
  sort: { key: BorrowerSortKey; order: 'desc' | 'asc' };
  by_severity: Record<BorrowerSeverity, number>;
  by_sector: Partial<Record<BorrowerSector, number>>;
  items: BorrowerWatchRow[];
}

// ── Synthesis helpers ──────────────────────────────────────────────────

const TOP_SIGNALS = [
  'DPD 30+ in last 60 days',
  'EMI bounce streak (3 of last 5)',
  'Account dormancy detected',
  'Bureau score dropped 50+ pts',
  'Utilisation crossed 95%',
  'Geographic risk flag (collateral region)',
  'High-velocity withdrawals',
  'Sector exposure concentration',
  'Repeat overdraft requests',
  'Salary credit ceased',
];

const NAME_FIRST = ['Aarav', 'Ananya', 'Vikram', 'Priya', 'Rohan', 'Meera', 'Karan', 'Neha', 'Arjun', 'Sneha', 'Vivaan', 'Ishaan', 'Kiara', 'Riya', 'Dev', 'Tara'];
const NAME_LAST = ['Sharma', 'Patel', 'Reddy', 'Kumar', 'Iyer', 'Banerjee', 'Singh', 'Mehta', 'Joshi', 'Nair', 'Shah', 'Verma', 'Bose', 'Kapoor'];

/** Deterministic per (tenant, customer_id) attribute synthesis. */
export function synthesiseBorrowerAttrs(
  tenant_id: string,
  customer_id: string,
): { sector: BorrowerSector; segment: BorrowerSegment; region: BorrowerRegion; name: string; top_signal: string } {
  const rng = mulberry32(fnv1a(`${tenant_id}|${customer_id}|borrower_watch`));
  const sector = SECTORS[Math.floor(rng() * SECTORS.length)] ?? 'services';
  const segment = SEGMENTS[Math.floor(rng() * SEGMENTS.length)] ?? 'retail';
  const region = REGIONS[Math.floor(rng() * REGIONS.length)] ?? 'central';
  const first = NAME_FIRST[Math.floor(rng() * NAME_FIRST.length)] ?? 'Aarav';
  const last = NAME_LAST[Math.floor(rng() * NAME_LAST.length)] ?? 'Sharma';
  const name = `${first} ${last}`;
  const top_signal = TOP_SIGNALS[Math.floor(rng() * TOP_SIGNALS.length)] ?? TOP_SIGNALS[0];
  return { sector, segment, region, name, top_signal };
}

/** Synthesise last_alert_at per (tenant, customer_id). Some borrowers
 *  return null (no recent alert). */
export function synthesiseLastAlertAt(
  tenant_id: string,
  customer_id: string,
  now: Date,
): string | null {
  const rng = mulberry32(fnv1a(`${tenant_id}|${customer_id}|last_alert`));
  if (rng() < 0.3) return null; // ~30% no recent alert
  const daysBack = Math.floor(rng() * 60);
  const hoursBack = Math.floor(rng() * 24);
  return new Date(now.getTime() - daysBack * 86_400_000 - hoursBack * 3_600_000).toISOString();
}

/** Compute EWS score from the existing PD + DPD signals. */
export function computeEwsScore(pd: number, dpd: number): number {
  // Heavily weight PD; DPD bumps when ≥ 30 days.
  const pdComponent = Math.max(0, Math.min(1, pd)) * 70;
  const dpdComponent = Math.max(0, Math.min(180, dpd)) / 180 * 30;
  return Math.round((pdComponent + dpdComponent) * 10) / 10;
}

// ── List composer ──────────────────────────────────────────────────────

/** Caller-supplied minimal customer row (matches /api/customers shape). */
export interface BorrowerInput {
  id: string;
  name?: string;
  pd: number;
  exposure: number;
  dpd: number;
}

/** Caller-supplied watchlist row. */
export interface WatchlistEntry {
  customer_id: string;
  tag: string | null;
  added_at: string;
}

/** Filter + sort the raw customer rows into the borrower-watch shape. */
export function buildBorrowerList(
  tenant_id: string,
  customers: ReadonlyArray<BorrowerInput>,
  watchlist: ReadonlyArray<WatchlistEntry>,
  filters: BorrowerListFilters,
  sort: { key: BorrowerSortKey; order: 'desc' | 'asc' },
  now: Date,
): BorrowerListReport {
  if (!tenant_id) throw new Error('tenant_id required');
  // O(1) lookup of watchlist tags by customer_id.
  const wlMap = new Map<string, WatchlistEntry>();
  for (const w of watchlist) wlMap.set(w.customer_id, w);

  // Build per-borrower rows.
  const allRows: BorrowerWatchRow[] = customers.map((c) => {
    const attrs = synthesiseBorrowerAttrs(tenant_id, c.id);
    const ews_score = computeEwsScore(c.pd, c.dpd);
    const severity = severityFromEws(ews_score);
    const wl = wlMap.get(c.id) ?? null;
    return {
      borrower_id: c.id,
      name: c.name && c.name.trim() ? c.name : attrs.name,
      sector: attrs.sector,
      segment: attrs.segment,
      region: attrs.region,
      exposure_inr: c.exposure,
      pd: Math.max(0, Math.min(1, c.pd)),
      ews_score,
      severity,
      top_signal: attrs.top_signal,
      last_alert_at: synthesiseLastAlertAt(tenant_id, c.id, now),
      watchlist_tag: wl?.tag ?? null,
      dpd: c.dpd,
    };
  });

  const total_unfiltered = allRows.length;

  // Apply filters.
  let items = allRows;
  const mode = filters.mode ?? 'stressed';
  if (mode === 'stressed') {
    // Default to S1+S2 only (the "stressed" cohort).
    items = items.filter((r) => r.severity === 'S1' || r.severity === 'S2');
  }
  if (filters.sector) items = items.filter((r) => r.sector === filters.sector);
  if (filters.segment) items = items.filter((r) => r.segment === filters.segment);
  if (filters.region) items = items.filter((r) => r.region === filters.region);
  if (filters.severity) items = items.filter((r) => r.severity === filters.severity);
  if (filters.watchlist_only) items = items.filter((r) => r.watchlist_tag !== null);
  if (filters.min_ews !== undefined) {
    const lo = filters.min_ews;
    items = items.filter((r) => r.ews_score >= lo);
  }
  if (filters.max_ews !== undefined) {
    const hi = filters.max_ews;
    items = items.filter((r) => r.ews_score <= hi);
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    items = items.filter((r) =>
      r.borrower_id.toLowerCase().includes(q) || r.name.toLowerCase().includes(q),
    );
  }

  // Server-side sort (spec acceptance). Default: EWS score desc.
  items = sortRows(items, sort);

  // Severity counts on the FILTERED set (drives chip badges).
  const by_severity: Record<BorrowerSeverity, number> = { S1: 0, S2: 0, S3: 0 };
  const by_sector: Partial<Record<BorrowerSector, number>> = {};
  for (const r of items) {
    by_severity[r.severity]++;
    by_sector[r.sector] = (by_sector[r.sector] ?? 0) + 1;
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    mode,
    total: items.length,
    total_unfiltered,
    sort,
    by_severity,
    by_sector,
    items,
  };
}

/** Pure deterministic sort. Exposed for unit tests + the route layer. */
export function sortRows(
  rows: BorrowerWatchRow[],
  sort: { key: BorrowerSortKey; order: 'desc' | 'asc' },
): BorrowerWatchRow[] {
  const out = [...rows];
  const mul = sort.order === 'desc' ? -1 : 1;
  out.sort((a, b) => {
    if (sort.key === 'ews_score') {
      if (a.ews_score === b.ews_score) return a.borrower_id.localeCompare(b.borrower_id);
      return (a.ews_score - b.ews_score) * mul;
    }
    if (sort.key === 'exposure_inr') {
      if (a.exposure_inr === b.exposure_inr) return a.borrower_id.localeCompare(b.borrower_id);
      return (a.exposure_inr - b.exposure_inr) * mul;
    }
    if (sort.key === 'dpd') {
      if (a.dpd === b.dpd) return a.borrower_id.localeCompare(b.borrower_id);
      return (a.dpd - b.dpd) * mul;
    }
    if (sort.key === 'last_alert_at') {
      const av = a.last_alert_at ?? '';
      const bv = b.last_alert_at ?? '';
      if (av === bv) return a.borrower_id.localeCompare(b.borrower_id);
      return av < bv ? -1 * mul : 1 * mul;
    }
    if (sort.key === 'name') {
      return a.name.localeCompare(b.name) * mul;
    }
    return 0;
  });
  return out;
}

// ── Cohort CMA pack ────────────────────────────────────────────────────

export interface CohortCmaPack {
  pack_id: string;
  tenant_id: string;
  generated_at: string;
  generated_by: string;
  cohort_size: number;
  borrowers: ReadonlyArray<{
    borrower_id: string;
    name: string;
    sector: BorrowerSector;
    exposure_inr: number;
    ews_score: number;
    severity: BorrowerSeverity;
  }>;
  totals: {
    exposure_inr: number;
    mean_ews_score: number;
    by_severity: Record<BorrowerSeverity, number>;
    by_sector: Partial<Record<BorrowerSector, number>>;
  };
  /** Download URL (client builds the actual XLSX/PDF; the BFF returns
   *  metadata + an identifier the SPA uses to call /v1/reports/builder
   *  for the binary). */
  download_filename: string;
}

export class CohortError extends Error {
  constructor(public code: 'invalid_input' | 'too_many_borrowers' | 'unknown_borrower', message: string) {
    super(message);
    this.name = 'CohortError';
  }
}

export const COHORT_CAP = 1000;

/** Build a CMA (Credit Monitoring Arrangement) pack from a cohort of
 *  borrower_ids. Pure function — caller (route) supplies the full row
 *  array; this composes the metadata for the SPA to render/export. */
export function buildCohortCmaPack(
  tenant_id: string,
  rows: ReadonlyArray<BorrowerWatchRow>,
  cohort_ids: ReadonlyArray<string>,
  actor: string,
  now: Date,
): CohortCmaPack {
  if (!tenant_id) throw new CohortError('invalid_input', 'tenant_id required');
  if (!actor) throw new CohortError('invalid_input', 'actor required');
  if (!Array.isArray(cohort_ids) || cohort_ids.length === 0) {
    throw new CohortError('invalid_input', 'cohort_ids must be a non-empty array');
  }
  if (cohort_ids.length > COHORT_CAP) {
    throw new CohortError('too_many_borrowers', `cohort cap exceeded (${COHORT_CAP})`);
  }
  // Dedupe.
  const unique = Array.from(new Set(cohort_ids));
  const rowsById = new Map<string, BorrowerWatchRow>();
  for (const r of rows) rowsById.set(r.borrower_id, r);
  const missing: string[] = [];
  const found: BorrowerWatchRow[] = [];
  for (const id of unique) {
    const r = rowsById.get(id);
    if (!r) {
      missing.push(id);
      continue;
    }
    found.push(r);
  }
  if (missing.length > 0) {
    throw new CohortError(
      'unknown_borrower',
      `unknown borrower_ids: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`,
    );
  }
  // Totals.
  let exposureSum = 0;
  let ewsSum = 0;
  const by_severity: Record<BorrowerSeverity, number> = { S1: 0, S2: 0, S3: 0 };
  const by_sector: Partial<Record<BorrowerSector, number>> = {};
  for (const r of found) {
    exposureSum += r.exposure_inr;
    ewsSum += r.ews_score;
    by_severity[r.severity]++;
    by_sector[r.sector] = (by_sector[r.sector] ?? 0) + 1;
  }
  const mean_ews_score = found.length > 0
    ? Math.round((ewsSum / found.length) * 10) / 10
    : 0;
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  const seq = Math.floor(now.getTime() / 1000) % 100000;
  return {
    pack_id: `cma-${tenant_id}-${day}-${String(seq).padStart(5, '0')}`,
    tenant_id,
    generated_at: now.toISOString(),
    generated_by: actor,
    cohort_size: found.length,
    borrowers: found.map((r) => ({
      borrower_id: r.borrower_id,
      name: r.name,
      sector: r.sector,
      exposure_inr: r.exposure_inr,
      ews_score: r.ews_score,
      severity: r.severity,
    })),
    totals: {
      exposure_inr: exposureSum,
      mean_ews_score,
      by_severity,
      by_sector,
    },
    download_filename: `cma-pack-${tenant_id}-${day}.xlsx`,
  };
}
