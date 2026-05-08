// services/bff/src/analytics/pd_distribution.ts
//
// PD Distribution sub-dashboard — T4.1 4c, EWS.docx §5.5 / §8.
//
// The prototype doesn't carry a per-customer PD field yet. As a
// well-defined stand-in we use `app_alerts.alerts.criticality_score`,
// which is numeric(8,2) in roughly [1, 10] for the SmartQueue. Latest
// score per customer drives the histogram. When real PD lands the
// resolver swaps to that column without changing the public shape.

import { Pool } from 'pg';

export type RiskBand = 'low' | 'medium' | 'high';

/** Resolver input — one row per (customer × `as_of` snapshot). */
export interface PdSnapshotRow {
  customer_id: string;
  /** PD proxy: latest criticality_score for the customer at this snapshot. */
  pd_proxy: number;
}

export interface PdDistributionFilter {
  /** ISO timestamp the "current" snapshot is taken at. Defaults to now(). */
  as_of?: string;
  /** ISO timestamp for the prior snapshot used in the delta line. */
  prior_as_of?: string;
  /** Customer-segment filter; honoured only when segment_lookup is wired. */
  segment?: string;
}

export interface HistogramBin {
  /** Inclusive lower edge. */
  lower: number;
  /** Exclusive upper edge (inclusive on the last bin). */
  upper: number;
  label: string;
  count: number;
  /** Same bin in the prior snapshot. null = prior snapshot wasn't loaded. */
  prior_count: number | null;
  delta: number | null;
}

export interface RiskBandSlice {
  band: RiskBand;
  /** Inclusive lower edge of the band on the PD-proxy axis. */
  lower: number;
  /** Inclusive upper edge of the band. */
  upper: number;
  count: number;
}

export interface PdDistributionReport {
  bins: HistogramBin[];
  bands: RiskBandSlice[];
  totals: {
    customer_count: number;
    prior_customer_count: number | null;
    mean_pd_proxy: number | null;
    high_band_share: number;
  };
  /** Lower / upper edge the histogram is spread across. */
  range: { lower: number; upper: number; bin_count: number };
  generated_at: string;
  tenant_id: string;
  filters_applied: PdDistributionFilter;
}

// ── Pure resolver ──────────────────────────────────────────────────────

const DEFAULT_RANGE = { lower: 0, upper: 10, bins: 10 };
// Risk bands tied to the criticality_score scale. When real PD lands the
// `[low/med/high]` cuts will be on probability space (0-1).
const BAND_CUTS: { band: RiskBand; lower: number; upper: number }[] = [
  { band: 'low',    lower: 0, upper: 3  }, // [0, 3)
  { band: 'medium', lower: 3, upper: 5  }, // [3, 5)
  { band: 'high',   lower: 5, upper: 10 }, // [5, 10]
];

export function computePdDistribution(input: {
  tenant_id: string;
  current: PdSnapshotRow[];
  prior?: PdSnapshotRow[] | null;
  filter?: PdDistributionFilter;
  asOf: Date;
  /** Optional segment lookup; when filter.segment is set, rows whose
   *  customer maps to a different segment are dropped. */
  segmentOf?: (customer_id: string) => string | null;
}): PdDistributionReport {
  const filter = input.filter ?? {};
  const segmentFilterFn = (rows: PdSnapshotRow[]) => {
    if (!filter.segment) return rows;
    const seg = filter.segment;
    return rows.filter((r) => (input.segmentOf ? input.segmentOf(r.customer_id) === seg : false));
  };
  const current = segmentFilterFn(input.current);
  const prior = input.prior ? segmentFilterFn(input.prior) : null;

  const range = DEFAULT_RANGE;
  const binWidth = (range.upper - range.lower) / range.bins;

  const binIndex = (v: number): number => {
    if (!Number.isFinite(v)) return -1;
    if (v < range.lower) return 0;
    if (v >= range.upper) return range.bins - 1;
    return Math.floor((v - range.lower) / binWidth);
  };

  const tally = (rows: PdSnapshotRow[]): number[] => {
    const counts = new Array<number>(range.bins).fill(0);
    for (const r of rows) {
      const idx = binIndex(r.pd_proxy);
      if (idx >= 0) counts[idx] += 1;
    }
    return counts;
  };

  const curCounts = tally(current);
  const priorCounts = prior ? tally(prior) : null;

  const bins: HistogramBin[] = curCounts.map((count, i) => {
    const lower = range.lower + i * binWidth;
    const upper = i === range.bins - 1 ? range.upper : range.lower + (i + 1) * binWidth;
    const priorCount = priorCounts ? priorCounts[i] : null;
    return {
      lower,
      upper,
      label: `${lower.toFixed(1)}–${upper.toFixed(1)}`,
      count,
      prior_count: priorCount,
      delta: priorCount == null ? null : count - priorCount,
    };
  });

  // Risk-band buckets — sum bins that fall inside each band's [lower, upper).
  const bands: RiskBandSlice[] = BAND_CUTS.map((b) => {
    let count = 0;
    for (const r of current) {
      if (r.pd_proxy >= b.lower && r.pd_proxy < b.upper) count += 1;
      else if (b.upper === range.upper && r.pd_proxy === range.upper) count += 1; // edge
    }
    return { band: b.band, lower: b.lower, upper: b.upper, count };
  });

  const sum = current.reduce((acc, r) => acc + r.pd_proxy, 0);
  const high = bands.find((b) => b.band === 'high')!.count;

  return {
    bins,
    bands,
    totals: {
      customer_count: current.length,
      prior_customer_count: prior ? prior.length : null,
      mean_pd_proxy:
        current.length === 0 ? null : Math.round((sum / current.length) * 100) / 100,
      high_band_share:
        current.length === 0 ? 0 : Math.round((high / current.length) * 10000) / 10000,
    },
    range: { lower: range.lower, upper: range.upper, bin_count: range.bins },
    generated_at: input.asOf.toISOString(),
    tenant_id: input.tenant_id,
    filters_applied: filter,
  };
}

// ── Pg source ──────────────────────────────────────────────────────────

export interface PdDistributionSource {
  /** Latest pd_proxy per customer at-or-before the given snapshot. */
  loadSnapshot(tenant_id: string, asOf: Date): Promise<PdSnapshotRow[]>;
}

export class PgPdDistributionSource implements PdDistributionSource {
  constructor(private readonly pool: Pool) {}

  async loadSnapshot(tenant_id: string, asOf: Date): Promise<PdSnapshotRow[]> {
    // Latest alert per customer at-or-before asOf — DISTINCT ON keeps
    // the row with MAX(created_at).
    const sql = `
      SELECT DISTINCT ON (customer_id)
             customer_id,
             criticality_score::float8 AS pd_proxy
        FROM app_alerts.alerts
       WHERE tenant_id = $1 AND created_at <= $2
       ORDER BY customer_id, created_at DESC
    `;
    const out = await this.pool.query(sql, [tenant_id, asOf]);
    return out.rows.map((r) => ({
      customer_id: String(r.customer_id),
      pd_proxy: Number(r.pd_proxy),
    }));
  }
}

export class InMemoryPdDistributionSource implements PdDistributionSource {
  constructor(private readonly snapshotsByDate: (asOf: Date) => PdSnapshotRow[]) {}
  async loadSnapshot(_tenant_id: string, asOf: Date): Promise<PdSnapshotRow[]> {
    return this.snapshotsByDate(asOf);
  }
}

export async function makePdDistributionSource(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ source: PdDistributionSource; pool: Pool | null }> {
  const url = env.BFF_PG_URL ?? env.ADMIN_PG_URL;
  if (!url) {
    return {
      source: new InMemoryPdDistributionSource(() => []),
      pool: null,
    };
  }
  const pool = new Pool({ connectionString: url, max: 4 });
  return { source: new PgPdDistributionSource(pool), pool };
}
