// services/bff/__tests__/audit_activity_benchmark_pg.test.ts
//
// B7 of v1.5+ unified.* consumer migration: pg + hermetic tests for
// the audit_activity benchmark + materialize-promotion gate.

import { Pool } from 'pg';
import {
  PgUnifiedAuditActivityBenchmark,
  InMemoryUnifiedAuditActivityBenchmark,
  makeUnifiedAuditActivityBenchmark,
  buildBenchmarkResult,
  classifyPromotionVerdict,
  promotionRationale,
  DEFAULT_BENCHMARK_RUNS,
  MAX_BENCHMARK_RUNS,
  PRE_WARM_RUNS,
  PROMOTION_THRESHOLD_MONITOR_MS,
  PROMOTION_THRESHOLD_MATERIALIZE_MS,
  type BenchmarkResult,
  type IUnifiedAuditActivityBenchmark,
} from '../src/audit_activity_benchmark';

const PG_URL = process.env.BFF_PG_URL ?? process.env.ADMIN_PG_URL;
const describeIfPg = PG_URL ? describe : describe.skip;

describeIfPg('PgUnifiedAuditActivityBenchmark (pg integration — requires BFF_PG_URL)', () => {
  let pool: Pool;
  let bench: PgUnifiedAuditActivityBenchmark;
  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    bench = new PgUnifiedAuditActivityBenchmark(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  test('run returns BenchmarkResult with the full shape', async () => {
    // Use a small query_count to keep the test fast
    const r = await bench.run('BANK_DEMO', 10);
    expect(r.query_count).toBe(10);
    expect(r.pre_warm_runs).toBe(PRE_WARM_RUNS);
    expect(typeof r.total_ms).toBe('number');
    expect(typeof r.mean_ms).toBe('number');
    expect(typeof r.p50_ms).toBe('number');
    expect(typeof r.p95_ms).toBe('number');
    expect(typeof r.p99_ms).toBe('number');
    expect(typeof r.max_ms).toBe('number');
    expect(typeof r.min_ms).toBe('number');
    expect(typeof r.rows_per_query).toBe('number');
    expect(typeof r.run_at).toBe('string');
    expect(r.samples).toHaveLength(10);
    // Distribution invariants
    expect(r.min_ms).toBeLessThanOrEqual(r.p50_ms);
    expect(r.p50_ms).toBeLessThanOrEqual(r.p95_ms);
    expect(r.p95_ms).toBeLessThanOrEqual(r.p99_ms);
    expect(r.p99_ms).toBeLessThanOrEqual(r.max_ms);
    expect(r.mean_ms).toBeGreaterThan(0);
    expect(r.min_ms).toBeGreaterThanOrEqual(0);
    // All samples positive
    for (const s of r.samples) {
      expect(s).toBeGreaterThan(0);
    }
  });

  test('run rejects empty tenant_id', async () => {
    await expect(bench.run('')).rejects.toThrow(/tenant_id/);
  });

  test('run with query_count > MAX is clamped', async () => {
    const r = await bench.run('BANK_DEMO', 999_999);
    expect(r.query_count).toBe(MAX_BENCHMARK_RUNS);
  }, 30_000); // allow up to 30s for 500 queries

  test('run with query_count < 1 is clamped to 1', async () => {
    const r = await bench.run('BANK_DEMO', 0);
    expect(r.query_count).toBe(1);
    expect(r.samples).toHaveLength(1);
  });

  test('run with default query_count', async () => {
    // Skip the slow default if the seed is very large — clamp our use
    const r = await bench.run('BANK_DEMO');
    expect(r.query_count).toBe(DEFAULT_BENCHMARK_RUNS);
  }, 30_000);

  test('benchmark rows_per_query reflects actual query output', async () => {
    const r = await bench.run('BANK_DEMO', 5);
    // BANK_DEMO seed has ample audit events — query LIMIT 200
    expect(r.rows_per_query).toBeGreaterThan(0);
    expect(r.rows_per_query).toBeLessThanOrEqual(200);
  });

  test('makeUnifiedAuditActivityBenchmark returns instance when view exists', async () => {
    const made = await makeUnifiedAuditActivityBenchmark(pool);
    expect(made).toBeInstanceOf(PgUnifiedAuditActivityBenchmark);
  });

  test('makeUnifiedAuditActivityBenchmark returns undefined on null pool', async () => {
    const made = await makeUnifiedAuditActivityBenchmark(null);
    expect(made).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Hermetic — pure helpers
// ---------------------------------------------------------------------

describe('buildBenchmarkResult', () => {
  test('correct percentiles on canonical 10-sample set [1..10]', () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const total_ms = 55;
    const r = buildBenchmarkResult({
      samples,
      total_ms,
      query_count: 10,
      rows_per_query: 100,
      run_at: '2026-05-21T12:00:00Z',
    });
    expect(r.mean_ms).toBe(5.5);
    expect(r.min_ms).toBe(1);
    expect(r.max_ms).toBe(10);
    // Linear interpolation on sorted [1..10]:
    //   p50 → rank = 0.5 × 9 = 4.5 → 0.5×5 + 0.5×6 = 5.5
    expect(r.p50_ms).toBe(5.5);
    //   p95 → rank = 0.95 × 9 = 8.55 → 0.45×9 + 0.55×10 = 9.55
    expect(r.p95_ms).toBeCloseTo(9.55, 2);
    //   p99 → rank = 0.99 × 9 = 8.91 → 0.09×9 + 0.91×10 = 9.91
    expect(r.p99_ms).toBeCloseTo(9.91, 2);
  });

  test('single-sample edge: all stats equal the sample', () => {
    const r = buildBenchmarkResult({
      samples: [42],
      total_ms: 42,
      query_count: 1,
      rows_per_query: 50,
      run_at: '2026-05-21T12:00:00Z',
    });
    expect(r.mean_ms).toBe(42);
    expect(r.min_ms).toBe(42);
    expect(r.max_ms).toBe(42);
    expect(r.p50_ms).toBe(42);
    expect(r.p95_ms).toBe(42);
    expect(r.p99_ms).toBe(42);
  });

  test('throws on empty samples', () => {
    expect(() =>
      buildBenchmarkResult({
        samples: [],
        total_ms: 0,
        query_count: 0,
        rows_per_query: 0,
        run_at: '2026-05-21T12:00:00Z',
      }),
    ).toThrow(/at least 1 sample/);
  });

  test('does not mutate the input samples array', () => {
    const samples = [10, 1, 5, 3, 8];
    const original = [...samples];
    buildBenchmarkResult({
      samples,
      total_ms: 27,
      query_count: 5,
      rows_per_query: 0,
      run_at: '2026-05-21T12:00:00Z',
    });
    expect(samples).toEqual(original);
  });
});

describe('classifyPromotionVerdict', () => {
  test('p95 < 200ms → no_action', () => {
    expect(classifyPromotionVerdict(0)).toBe('no_action');
    expect(classifyPromotionVerdict(50)).toBe('no_action');
    expect(classifyPromotionVerdict(199.99)).toBe('no_action');
  });

  test('p95 == 200ms boundary → monitor', () => {
    expect(classifyPromotionVerdict(200)).toBe('monitor');
  });

  test('200ms ≤ p95 < 1000ms → monitor', () => {
    expect(classifyPromotionVerdict(500)).toBe('monitor');
    expect(classifyPromotionVerdict(999.99)).toBe('monitor');
  });

  test('p95 ≥ 1000ms → materialize_required', () => {
    expect(classifyPromotionVerdict(1000)).toBe('materialize_required');
    expect(classifyPromotionVerdict(5000)).toBe('materialize_required');
  });

  test('threshold constants match spec §6.5', () => {
    expect(PROMOTION_THRESHOLD_MONITOR_MS).toBe(200);
    expect(PROMOTION_THRESHOLD_MATERIALIZE_MS).toBe(1000);
  });
});

describe('promotionRationale', () => {
  test('no_action rationale mentions plain VIEW', () => {
    const r = promotionRationale('no_action', 50);
    expect(r).toContain('plain VIEW');
    expect(r).toContain('50');
  });

  test('monitor rationale mentions growth + weekly cadence', () => {
    const r = promotionRationale('monitor', 500);
    expect(r).toMatch(/watch|growth/);
    expect(r).toContain('500');
  });

  test('materialize_required rationale points at migration file', () => {
    const r = promotionRationale('materialize_required', 2000);
    expect(r).toContain('035_unified_views.sql');
    expect(r).toContain('REFRESH');
    expect(r).toContain('2000');
  });
});

describe('InMemoryUnifiedAuditActivityBenchmark', () => {
  test('returns the canned samples in result', async () => {
    const bench = new InMemoryUnifiedAuditActivityBenchmark([10, 20, 30, 40, 50]);
    const r = await bench.run('BANK_DEMO');
    expect(r.samples).toEqual([10, 20, 30, 40, 50]);
    expect(r.query_count).toBe(5);
    expect(r.mean_ms).toBe(30);
  });

  test('respects explicit query_count by cycling through canned samples', async () => {
    const bench = new InMemoryUnifiedAuditActivityBenchmark([100, 200]);
    const r = await bench.run('BANK_DEMO', 5);
    expect(r.samples).toEqual([100, 200, 100, 200, 100]);
  });

  test('rejects empty tenant_id', async () => {
    const bench = new InMemoryUnifiedAuditActivityBenchmark([10]);
    await expect(bench.run('')).rejects.toThrow(/tenant_id/);
  });

  test('clamps query_count > MAX', async () => {
    const bench = new InMemoryUnifiedAuditActivityBenchmark([5]);
    const r = await bench.run('BANK_DEMO', 999_999);
    expect(r.query_count).toBe(MAX_BENCHMARK_RUNS);
  });

  test('use case — fast samples produce no_action verdict', async () => {
    const bench = new InMemoryUnifiedAuditActivityBenchmark([50, 60, 70, 80, 90, 100]);
    const r = await bench.run('BANK_DEMO');
    expect(classifyPromotionVerdict(r.p95_ms)).toBe('no_action');
  });

  test('use case — slow samples produce materialize_required verdict', async () => {
    const bench = new InMemoryUnifiedAuditActivityBenchmark([
      900, 1100, 1200, 1500, 1800, 2200,
    ]);
    const r = await bench.run('BANK_DEMO');
    expect(classifyPromotionVerdict(r.p95_ms)).toBe('materialize_required');
  });

  test('use case — borderline samples produce monitor verdict', async () => {
    const bench = new InMemoryUnifiedAuditActivityBenchmark([
      150, 200, 250, 300, 400, 500,
    ]);
    const r = await bench.run('BANK_DEMO');
    expect(classifyPromotionVerdict(r.p95_ms)).toBe('monitor');
  });

  test('IUnifiedAuditActivityBenchmark interface conformance', () => {
    const b: IUnifiedAuditActivityBenchmark = new InMemoryUnifiedAuditActivityBenchmark([1]);
    expect(typeof b.run).toBe('function');
  });

  test('result.run_at is the injected clock', async () => {
    const bench = new InMemoryUnifiedAuditActivityBenchmark(
      [10],
      100,
      () => new Date('2099-12-31T23:59:59Z'),
    );
    const r = await bench.run('BANK_DEMO');
    expect(r.run_at).toBe('2099-12-31T23:59:59.000Z');
  });
});

// ---------------------------------------------------------------------
// HTTP route tests
// ---------------------------------------------------------------------

import request from 'supertest';
import { makeApp } from '../src/server';

const HEADERS = {
  'X-Tenant-ID': 'BANK_DEMO',
  'X-Channel': 'API',
  'X-APEX-USER': 'alice.admin',
  'X-Apex-Role': 'admin',
};

describe('POST /v1/admin/audit-activity/benchmark', () => {
  test('200 envelope with benchmark + verdict (no_action path)', async () => {
    const audit_activity_benchmark = new InMemoryUnifiedAuditActivityBenchmark([
      50, 60, 70, 80,
    ]);
    const { app } = makeApp({ auditActivityBenchmark: audit_activity_benchmark });
    const r = await request(app)
      .post('/v1/admin/audit-activity/benchmark')
      .set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.header.status).toBe('SUCCESS');
    const b = r.body.body as BenchmarkResult & {
      promotion_verdict: string;
      promotion_rationale: string;
    };
    expect(b.query_count).toBe(4);
    expect(b.promotion_verdict).toBe('no_action');
    expect(b.promotion_rationale).toContain('plain VIEW');
  });

  test('200 envelope with verdict=monitor (borderline)', async () => {
    const audit_activity_benchmark = new InMemoryUnifiedAuditActivityBenchmark([
      300, 400, 500, 600,
    ]);
    const { app } = makeApp({ auditActivityBenchmark: audit_activity_benchmark });
    const r = await request(app)
      .post('/v1/admin/audit-activity/benchmark')
      .set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.promotion_verdict).toBe('monitor');
  });

  test('200 envelope with verdict=materialize_required (slow)', async () => {
    const audit_activity_benchmark = new InMemoryUnifiedAuditActivityBenchmark([
      900, 1200, 1500, 2000,
    ]);
    const { app } = makeApp({ auditActivityBenchmark: audit_activity_benchmark });
    const r = await request(app)
      .post('/v1/admin/audit-activity/benchmark')
      .set(HEADERS);
    expect(r.status).toBe(200);
    expect(r.body.body.promotion_verdict).toBe('materialize_required');
    expect(r.body.body.promotion_rationale).toContain('035_unified_views.sql');
  });

  test('501 when no benchmark wired (in-memory BFF mode)', async () => {
    const { app } = makeApp({}); // no auditActivityBenchmark
    const r = await request(app)
      .post('/v1/admin/audit-activity/benchmark')
      .set(HEADERS);
    expect(r.status).toBe(501);
    expect(r.body.error.code).toBe('EWS_501_not_available');
  });

  test('403 when role lacks audit:read', async () => {
    const audit_activity_benchmark = new InMemoryUnifiedAuditActivityBenchmark([10]);
    const { app } = makeApp({ auditActivityBenchmark: audit_activity_benchmark });
    const r = await request(app)
      .post('/v1/admin/audit-activity/benchmark')
      .set({ ...HEADERS, 'X-Apex-Role': 'field_officer' });
    expect(r.status).toBe(403);
  });

  test('?queries=N forwarded to benchmark', async () => {
    let observed_count: number | undefined;
    const audit_activity_benchmark: IUnifiedAuditActivityBenchmark = {
      async run(_tenant_id: string, query_count?: number) {
        observed_count = query_count;
        return buildBenchmarkResult({
          samples: [10],
          total_ms: 10,
          query_count: query_count ?? 1,
          rows_per_query: 50,
          run_at: '2026-05-21T12:00:00Z',
        });
      },
    };
    const { app } = makeApp({ auditActivityBenchmark: audit_activity_benchmark });
    await request(app)
      .post('/v1/admin/audit-activity/benchmark?queries=42')
      .set(HEADERS);
    expect(observed_count).toBe(42);
  });

  test('?queries=NaN → 400 EWS_400_invalid_input', async () => {
    const audit_activity_benchmark = new InMemoryUnifiedAuditActivityBenchmark([10]);
    const { app } = makeApp({ auditActivityBenchmark: audit_activity_benchmark });
    const r = await request(app)
      .post('/v1/admin/audit-activity/benchmark?queries=not_a_number')
      .set(HEADERS);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_invalid_input');
  });

  test('BIL tenant routed correctly (cross-tenant via HTTP)', async () => {
    let observed_tenant: string | undefined;
    const audit_activity_benchmark: IUnifiedAuditActivityBenchmark = {
      async run(tenant_id: string) {
        observed_tenant = tenant_id;
        return buildBenchmarkResult({
          samples: [10],
          total_ms: 10,
          query_count: 1,
          rows_per_query: 0,
          run_at: '2026-05-21T12:00:00Z',
        });
      },
    };
    const { app } = makeApp({ auditActivityBenchmark: audit_activity_benchmark });
    await request(app)
      .post('/v1/admin/audit-activity/benchmark')
      .set({ ...HEADERS, 'X-Tenant-ID': 'BIL' });
    expect(observed_tenant).toBe('BIL');
  });
});
