// services/bff/src/audit_activity_benchmark.ts
//
// B7 of v1.5+ unified.* consumer migration: observability primitive
// that lets ops know WHEN to flip `unified.audit_activity` from a
// plain VIEW to a MATERIALIZED VIEW (per spec §6.5).
//
// Today the view is a plain VIEW — each query against
// /v1/admin/audit-activity executes the UNION of 3 underlying tables
// at read time. As app_audit.approvals + audit.event_log + app_iam.
// audit_events grow, the UNION cost grows linearly. At some point
// the materialized-view template at the bottom of 035_unified_views.
// sql Section 9 should be activated (cron'd REFRESH every N minutes
// for read-mostly workloads).
//
// **The promotion decision needs DATA, not vibes.** This primitive
// runs the canonical /v1/admin/audit-activity query N times against
// pg, captures actual latency distribution, and produces a typed
// `BenchmarkResult` with mean/p50/p95/p99/max. The route layer
// (B7.2) exposes this + adds a `promotion_verdict` field that
// classifies the result against the spec's promotion thresholds:
//
//   p95 < 200 ms                  → no_action       (plain VIEW fine)
//   200 ≤ p95 < 1000 ms           → monitor         (watch growth)
//   p95 ≥ 1000 ms                 → materialize     (promote now)
//
// **Pre-warm pass**: the first query against a cold view pays
// connection-init + plan-cache + buffer-pool warmup costs that are
// unrepresentative of steady-state. The benchmark runs PRE_WARM_RUNS
// (default 3) queries that are NOT timed before starting the
// measurement loop. This is the same technique pg_stat_statements
// uses to bias toward steady-state numbers.

import { Pool, type PoolClient } from 'pg';

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

export const DEFAULT_BENCHMARK_RUNS = 50;
export const MAX_BENCHMARK_RUNS = 500;
export const PRE_WARM_RUNS = 3;

/** p95 ms thresholds for the materialize-promotion verdict (spec §6.5). */
export const PROMOTION_THRESHOLD_MONITOR_MS = 200;
export const PROMOTION_THRESHOLD_MATERIALIZE_MS = 1000;

export type PromotionVerdict =
  | 'no_action'        // p95 < 200ms — plain VIEW is fine
  | 'monitor'          // 200 <= p95 < 1000ms — watch growth
  | 'materialize_required'; // p95 >= 1000ms — promote now

export interface BenchmarkResult {
  query_count: number;
  pre_warm_runs: number;
  total_ms: number;
  mean_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  max_ms: number;
  min_ms: number;
  /** Number of rows returned by each query (constant across runs). */
  rows_per_query: number;
  /** ISO timestamp of when the benchmark completed. */
  run_at: string;
  /** ms timing samples per query (cap 500 — same as MAX_BENCHMARK_RUNS). */
  samples: number[];
}

export interface IUnifiedAuditActivityBenchmark {
  /**
   * Run N timed queries against unified.audit_activity (after a
   * PRE_WARM_RUNS warmup pass). Returns the distribution.
   */
  run(tenant_id: string, query_count?: number): Promise<BenchmarkResult>;
}

// ---------------------------------------------------------------------
// Pg implementation
// ---------------------------------------------------------------------

const CANONICAL_QUERY = `
  SELECT source, tenant_id, event_id, ts, actor, action,
         resource_type, resource_id, outcome, severity,
         correlation_id, metadata
    FROM unified.audit_activity
   WHERE tenant_id = $1
   ORDER BY ts DESC NULLS LAST, source ASC, event_id ASC
   LIMIT 200
`;

export class PgUnifiedAuditActivityBenchmark implements IUnifiedAuditActivityBenchmark {
  constructor(
    private readonly pool: Pool | PoolClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(
    tenant_id: string,
    query_count: number = DEFAULT_BENCHMARK_RUNS,
  ): Promise<BenchmarkResult> {
    if (!tenant_id || tenant_id.trim() === '') {
      throw new Error('PgUnifiedAuditActivityBenchmark.run: tenant_id required');
    }
    const n = Math.min(
      Math.max(1, Math.floor(query_count)),
      MAX_BENCHMARK_RUNS,
    );

    // Pre-warm: prime connection-pool + plan cache + buffer pool
    // (results discarded). Without this the first sample is always
    // unrepresentative and skews p95 high.
    let warmed_rowcount = 0;
    for (let i = 0; i < PRE_WARM_RUNS; i++) {
      const r = await this.pool.query(CANONICAL_QUERY, [tenant_id]);
      warmed_rowcount = r.rowCount ?? 0;
    }

    // Timed loop
    const samples: number[] = [];
    let total_ms = 0;
    for (let i = 0; i < n; i++) {
      const start = process.hrtime.bigint();
      await this.pool.query(CANONICAL_QUERY, [tenant_id]);
      const end = process.hrtime.bigint();
      // Convert nanoseconds → milliseconds with sub-ms precision.
      const ms = Number(end - start) / 1_000_000;
      samples.push(ms);
      total_ms += ms;
    }

    return buildBenchmarkResult({
      samples,
      total_ms,
      query_count: n,
      rows_per_query: warmed_rowcount,
      run_at: this.now().toISOString(),
    });
  }
}

// ---------------------------------------------------------------------
// Pure helpers (used by both impls + the route layer)
// ---------------------------------------------------------------------

export function buildBenchmarkResult(opts: {
  samples: number[];
  total_ms: number;
  query_count: number;
  rows_per_query: number;
  run_at: string;
}): BenchmarkResult {
  const sorted = [...opts.samples].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    throw new Error('buildBenchmarkResult: at least 1 sample required');
  }
  return {
    query_count: opts.query_count,
    pre_warm_runs: PRE_WARM_RUNS,
    total_ms: opts.total_ms,
    mean_ms: opts.total_ms / n,
    p50_ms: percentile(sorted, 0.5),
    p95_ms: percentile(sorted, 0.95),
    p99_ms: percentile(sorted, 0.99),
    max_ms: sorted[n - 1],
    min_ms: sorted[0],
    rows_per_query: opts.rows_per_query,
    run_at: opts.run_at,
    samples: opts.samples,
  };
}

/** Linear-interpolation percentile (matches numpy.percentile default). */
function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/** Classify a p95 ms value into the materialize-promotion verdict. */
export function classifyPromotionVerdict(p95_ms: number): PromotionVerdict {
  if (p95_ms < PROMOTION_THRESHOLD_MONITOR_MS) return 'no_action';
  if (p95_ms < PROMOTION_THRESHOLD_MATERIALIZE_MS) return 'monitor';
  return 'materialize_required';
}

/** Human-readable rationale for the verdict — shown in the route response. */
export function promotionRationale(verdict: PromotionVerdict, p95_ms: number): string {
  const p = p95_ms.toFixed(2);
  switch (verdict) {
    case 'no_action':
      return `p95=${p}ms < ${PROMOTION_THRESHOLD_MONITOR_MS}ms — plain VIEW is fine; no action needed.`;
    case 'monitor':
      return (
        `p95=${p}ms in [${PROMOTION_THRESHOLD_MONITOR_MS}ms, ${PROMOTION_THRESHOLD_MATERIALIZE_MS}ms) — ` +
        `watch growth; benchmark weekly. Consider materialization when p95 trends past ` +
        `${PROMOTION_THRESHOLD_MATERIALIZE_MS}ms.`
      );
    case 'materialize_required':
      return (
        `p95=${p}ms >= ${PROMOTION_THRESHOLD_MATERIALIZE_MS}ms — materialization required. ` +
        `Run the template at the bottom of data/schema/035_unified_views.sql Section 9 to ` +
        `promote unified.audit_activity to a MATERIALIZED VIEW + schedule cron'd REFRESH.`
      );
  }
}

// ---------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------

/**
 * Probe for unified.audit_activity view; return benchmark when found.
 * Mirrors makeUnifiedAuditActivityReader from B3 — same probe target.
 */
export async function makeUnifiedAuditActivityBenchmark(
  pool: Pool | PoolClient | null | undefined,
): Promise<IUnifiedAuditActivityBenchmark | undefined> {
  if (!pool) return undefined;
  try {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.views
        WHERE table_schema = 'unified' AND table_name = 'audit_activity' LIMIT 1`,
    );
    if (r.rowCount === 1) return new PgUnifiedAuditActivityBenchmark(pool);
    return undefined;
  } catch {
    return undefined;
  }
}

/** Env-aware bootstrap factory. */
export async function makeUnifiedAuditActivityBenchmarkFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<IUnifiedAuditActivityBenchmark | undefined> {
  const url = env.BFF_PG_URL ?? env.ADMIN_PG_URL;
  if (!url) return undefined;
  const pool = new Pool({ connectionString: url, max: 2 });
  return makeUnifiedAuditActivityBenchmark(pool);
}

// ---------------------------------------------------------------------
// Test stub
// ---------------------------------------------------------------------

/**
 * Deterministic benchmark stub. `mock_samples` is the canned latency
 * distribution returned per run — drives the route tests asserting
 * each promotion verdict.
 */
export class InMemoryUnifiedAuditActivityBenchmark
  implements IUnifiedAuditActivityBenchmark
{
  constructor(
    private readonly mock_samples: number[],
    private readonly rows_per_query: number = 100,
    private readonly now: () => Date = () => new Date('2026-05-21T12:00:00Z'),
  ) {}

  async run(
    tenant_id: string,
    query_count?: number,
  ): Promise<BenchmarkResult> {
    if (!tenant_id || tenant_id.trim() === '') {
      throw new Error('InMemoryUnifiedAuditActivityBenchmark.run: tenant_id required');
    }
    const n = Math.min(
      Math.max(1, Math.floor(query_count ?? this.mock_samples.length)),
      MAX_BENCHMARK_RUNS,
    );
    // Take the first n samples (cycling if fewer than n provided).
    const samples: number[] = [];
    for (let i = 0; i < n; i++) {
      samples.push(this.mock_samples[i % this.mock_samples.length]);
    }
    const total_ms = samples.reduce((a, b) => a + b, 0);
    return buildBenchmarkResult({
      samples,
      total_ms,
      query_count: n,
      rows_per_query: this.rows_per_query,
      run_at: this.now().toISOString(),
    });
  }
}
