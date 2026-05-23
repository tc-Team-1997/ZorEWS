// services/bff/__tests__/investigation_duration_histogram.test.ts
//
// T6 M9.19 — Investigation duration histogram.

import request from 'supertest';
import {
  ALL_INVESTIGATION_DURATION_BUCKETS,
  SAMPLE_INVESTIGATIONS_CAP,
  bucketForDurationMs,
  buildInvestigationDurationHistogram,
  buildInvestigationDurationHistogramFromStore,
} from '../src/investigation_duration_histogram';
import {
  type CaseInvestigation,
  InMemoryCaseInvestigationStore,
} from '../src/case_investigation';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-23T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ─── helpers ────────────────────────────────────────────────────────

function mkInvestigation(opts: {
  investigation_id: string;
  opened_at_ms?: number; // relative to NOW
  closed_at_ms?: number | null; // relative to NOW; null = still_open
  status?: 'closed' | 'triage' | 'gathering_evidence' | 'awaiting_response' | 'review' | 'decision';
  case_id?: string;
  customer_id?: string;
}): CaseInvestigation {
  const opened = new Date(NOW.getTime() - (opts.opened_at_ms ?? 60 * DAY_MS));
  const closed =
    opts.closed_at_ms === null || opts.closed_at_ms === undefined
      ? null
      : new Date(NOW.getTime() - opts.closed_at_ms);
  const status =
    opts.status ?? (closed === null ? 'triage' : 'closed');
  return {
    investigation_id: opts.investigation_id,
    tenant_id: 'BIL',
    case_id: opts.case_id ?? `case-${opts.investigation_id}`,
    customer_id: opts.customer_id ?? `cust-${opts.investigation_id}`,
    status,
    decision: status === 'closed' ? 'fraud_confirmed' : null,
    opened_at: opened.toISOString(),
    opened_by: 'admin',
    last_updated_at: (closed ?? opened).toISOString(),
    last_updated_by: 'admin',
    closed_at: closed ? closed.toISOString() : null,
    steps: [],
    notes_count: 0,
    checklist_template_id: 'BUILT_IN',
  };
}

// ─── enum + helper invariants ───────────────────────────────────────

describe('M9.19 — canonical enum + helper', () => {
  test('ALL_INVESTIGATION_DURATION_BUCKETS has 6 values in canonical order', () => {
    expect([...ALL_INVESTIGATION_DURATION_BUCKETS]).toEqual([
      'under_1h',
      '1_to_24h',
      '1_to_7d',
      '7_to_30d',
      '30d_plus',
      'still_open',
    ]);
  });

  test('SAMPLE_INVESTIGATIONS_CAP is 3', () => {
    expect(SAMPLE_INVESTIGATIONS_CAP).toBe(3);
  });

  test('bucketForDurationMs canonical mapping', () => {
    expect(bucketForDurationMs(0)).toBe('under_1h');
    expect(bucketForDurationMs(30 * 60 * 1000)).toBe('under_1h'); // 30min
    expect(bucketForDurationMs(HOUR_MS)).toBe('1_to_24h'); // exactly 1h
    expect(bucketForDurationMs(2 * HOUR_MS)).toBe('1_to_24h');
    expect(bucketForDurationMs(DAY_MS)).toBe('1_to_7d'); // exactly 24h
    expect(bucketForDurationMs(3 * DAY_MS)).toBe('1_to_7d');
    expect(bucketForDurationMs(7 * DAY_MS)).toBe('7_to_30d'); // exactly 7d
    expect(bucketForDurationMs(15 * DAY_MS)).toBe('7_to_30d');
    expect(bucketForDurationMs(30 * DAY_MS)).toBe('30d_plus'); // exactly 30d
    expect(bucketForDurationMs(90 * DAY_MS)).toBe('30d_plus');
  });

  test('bucketForDurationMs defensive rejects', () => {
    expect(bucketForDurationMs(-1)).toBeNull();
    expect(bucketForDurationMs(NaN)).toBeNull();
    expect(bucketForDurationMs(Infinity)).toBeNull();
  });

  test('boundary semantics — strict-< upper bound', () => {
    expect(bucketForDurationMs(HOUR_MS - 1)).toBe('under_1h');
    expect(bucketForDurationMs(HOUR_MS)).toBe('1_to_24h');
    expect(bucketForDurationMs(DAY_MS - 1)).toBe('1_to_24h');
    expect(bucketForDurationMs(DAY_MS)).toBe('1_to_7d');
    expect(bucketForDurationMs(7 * DAY_MS - 1)).toBe('1_to_7d');
    expect(bucketForDurationMs(7 * DAY_MS)).toBe('7_to_30d');
    expect(bucketForDurationMs(30 * DAY_MS - 1)).toBe('7_to_30d');
    expect(bucketForDurationMs(30 * DAY_MS)).toBe('30d_plus');
  });
});

// ─── empty input ────────────────────────────────────────────────────

describe('M9.19 — empty input', () => {
  test('no investigations → 6 zero buckets + null leaderboards', () => {
    const h = buildInvestigationDurationHistogram('BIL', [], NOW);
    expect(h.tenant_id).toBe('BIL');
    expect(h.generated_at).toBe(NOW.toISOString());
    expect(h.total_investigations).toBe(0);
    expect(h.total_closed).toBe(0);
    expect(h.total_still_open).toBe(0);
    expect(h.peak_bucket).toBeNull();
    expect(h.peak_count).toBe(0);
    expect(h.mean_duration_ms).toBeNull();
    expect(h.median_duration_ms).toBeNull();
    expect(h.p95_duration_ms).toBeNull();
    expect(h.longest_closed).toBeNull();
    expect(h.oldest_open).toBeNull();
    expect(h.empty_buckets).toEqual([...ALL_INVESTIGATION_DURATION_BUCKETS]);
    for (const row of h.buckets) {
      expect(row.count).toBe(0);
      expect(row.samples).toEqual([]);
    }
  });

  test('throws on empty tenant_id', () => {
    expect(() => buildInvestigationDurationHistogram('', [], NOW)).toThrow();
    expect(() => buildInvestigationDurationHistogram('   ', [], NOW)).toThrow();
  });
});

// ─── bucket placement ──────────────────────────────────────────────

describe('M9.19 — bucket placement', () => {
  test('one investigation per bucket lands correctly', () => {
    const invs: CaseInvestigation[] = [
      // closed under_1h: opened 90m ago, closed 60m ago → duration 30min
      mkInvestigation({
        investigation_id: 'i-fast',
        opened_at_ms: 90 * 60 * 1000, // opened 90min ago
        closed_at_ms: 60 * 60 * 1000, // closed 60min ago → duration 30min
      }),
      // closed 1_to_24h: opened 5h ago, closed 1h ago → 4h
      mkInvestigation({
        investigation_id: 'i-day',
        opened_at_ms: 5 * HOUR_MS,
        closed_at_ms: HOUR_MS,
      }),
      // closed 1_to_7d: opened 4d ago, closed 1d ago → 3d
      mkInvestigation({
        investigation_id: 'i-week',
        opened_at_ms: 4 * DAY_MS,
        closed_at_ms: DAY_MS,
      }),
      // closed 7_to_30d: opened 20d ago, closed 5d ago → 15d
      mkInvestigation({
        investigation_id: 'i-month',
        opened_at_ms: 20 * DAY_MS,
        closed_at_ms: 5 * DAY_MS,
      }),
      // closed 30d_plus: opened 100d ago, closed 30d ago → 70d
      mkInvestigation({
        investigation_id: 'i-old',
        opened_at_ms: 100 * DAY_MS,
        closed_at_ms: 30 * DAY_MS,
      }),
      // still_open: opened 5d ago, status triage
      mkInvestigation({
        investigation_id: 'i-open',
        opened_at_ms: 5 * DAY_MS,
        closed_at_ms: null,
        status: 'triage',
      }),
    ];
    const h = buildInvestigationDurationHistogram('BIL', invs, NOW);
    const findCount = (b: string) => h.buckets.find((r) => r.bucket === b)!.count;
    expect(findCount('under_1h')).toBe(1);
    expect(findCount('1_to_24h')).toBe(1);
    expect(findCount('1_to_7d')).toBe(1);
    expect(findCount('7_to_30d')).toBe(1);
    expect(findCount('30d_plus')).toBe(1);
    expect(findCount('still_open')).toBe(1);
    expect(h.total_investigations).toBe(6);
    expect(h.total_closed).toBe(5);
    expect(h.total_still_open).toBe(1);
    expect(h.empty_buckets).toEqual([]);
  });

  test('buckets emitted in canonical order regardless of input', () => {
    const h = buildInvestigationDurationHistogram(
      'BIL',
      [mkInvestigation({ investigation_id: 'i-1', opened_at_ms: 100 * DAY_MS, closed_at_ms: 30 * DAY_MS })],
      NOW,
    );
    expect(h.buckets.map((r) => r.bucket)).toEqual([
      ...ALL_INVESTIGATION_DURATION_BUCKETS,
    ]);
  });

  test('bucket metadata (min_ms/max_ms/label) correct', () => {
    const h = buildInvestigationDurationHistogram('BIL', [], NOW);
    const under1h = h.buckets.find((r) => r.bucket === 'under_1h')!;
    expect(under1h).toMatchObject({ min_ms: 0, max_ms: HOUR_MS, label: '< 1 hour' });
    const oneTo24 = h.buckets.find((r) => r.bucket === '1_to_24h')!;
    expect(oneTo24).toMatchObject({ min_ms: HOUR_MS, max_ms: DAY_MS });
    const oneTo7d = h.buckets.find((r) => r.bucket === '1_to_7d')!;
    expect(oneTo7d).toMatchObject({ min_ms: DAY_MS, max_ms: 7 * DAY_MS });
    const sevTo30 = h.buckets.find((r) => r.bucket === '7_to_30d')!;
    expect(sevTo30).toMatchObject({ min_ms: 7 * DAY_MS, max_ms: 30 * DAY_MS });
    const thirtyPlus = h.buckets.find((r) => r.bucket === '30d_plus')!;
    expect(thirtyPlus).toMatchObject({ min_ms: 30 * DAY_MS, max_ms: null });
    const open = h.buckets.find((r) => r.bucket === 'still_open')!;
    expect(open).toMatchObject({ min_ms: null, max_ms: null });
  });
});

// ─── sample sort + cap ─────────────────────────────────────────────

describe('M9.19 — sample sort + cap', () => {
  test('closed bucket: samples sorted by duration desc + investigation_id asc tie-break, cap 3', () => {
    // 5 closed in '1_to_7d' (1-7d duration each)
    const invs: CaseInvestigation[] = [
      mkInvestigation({
        investigation_id: 'i-a',
        opened_at_ms: 5 * DAY_MS,
        closed_at_ms: 3 * DAY_MS, // dur 2d
      }),
      mkInvestigation({
        investigation_id: 'i-b',
        opened_at_ms: 6 * DAY_MS,
        closed_at_ms: DAY_MS, // dur 5d
      }),
      mkInvestigation({
        investigation_id: 'i-c',
        opened_at_ms: 5 * DAY_MS,
        closed_at_ms: 2 * DAY_MS, // dur 3d
      }),
      mkInvestigation({
        investigation_id: 'i-d',
        opened_at_ms: 6 * DAY_MS,
        closed_at_ms: DAY_MS, // dur 5d (tied with i-b)
      }),
      mkInvestigation({
        investigation_id: 'i-e',
        opened_at_ms: 2 * DAY_MS,
        closed_at_ms: DAY_MS, // dur 1d (still in 1_to_7d boundary)
      }),
    ];
    const h = buildInvestigationDurationHistogram('BIL', invs, NOW);
    const oneTo7d = h.buckets.find((r) => r.bucket === '1_to_7d')!;
    expect(oneTo7d.count).toBe(5);
    expect(oneTo7d.samples).toHaveLength(3);
    // Top 3 by duration desc, with id tie-break on equal duration
    expect(oneTo7d.samples[0]!.duration_ms).toBe(5 * DAY_MS);
    expect(oneTo7d.samples[0]!.investigation_id).toBe('i-b');
    expect(oneTo7d.samples[1]!.duration_ms).toBe(5 * DAY_MS);
    expect(oneTo7d.samples[1]!.investigation_id).toBe('i-d');
    expect(oneTo7d.samples[2]!.duration_ms).toBe(3 * DAY_MS);
    expect(oneTo7d.samples[2]!.investigation_id).toBe('i-c');
  });

  test('still_open bucket: samples sorted by opened_at asc (oldest first), cap 3', () => {
    const invs: CaseInvestigation[] = [
      mkInvestigation({
        investigation_id: 'open-a',
        opened_at_ms: 10 * DAY_MS,
        closed_at_ms: null,
        status: 'triage',
      }),
      mkInvestigation({
        investigation_id: 'open-b',
        opened_at_ms: 30 * DAY_MS,
        closed_at_ms: null,
        status: 'review',
      }),
      mkInvestigation({
        investigation_id: 'open-c',
        opened_at_ms: 5 * DAY_MS,
        closed_at_ms: null,
        status: 'gathering_evidence',
      }),
      mkInvestigation({
        investigation_id: 'open-d',
        opened_at_ms: 20 * DAY_MS,
        closed_at_ms: null,
        status: 'triage',
      }),
    ];
    const h = buildInvestigationDurationHistogram('BIL', invs, NOW);
    const open = h.buckets.find((r) => r.bucket === 'still_open')!;
    expect(open.count).toBe(4);
    expect(open.samples).toHaveLength(3);
    // Oldest-first: opened 30d ago > 20d ago > 10d ago > 5d ago
    expect(open.samples[0]!.investigation_id).toBe('open-b'); // 30d
    expect(open.samples[1]!.investigation_id).toBe('open-d'); // 20d
    expect(open.samples[2]!.investigation_id).toBe('open-a'); // 10d
    // duration_ms null for still_open
    expect(open.samples[0]!.duration_ms).toBeNull();
  });

  test('sample carries investigation_id + case_id + customer_id + status + timestamps', () => {
    const inv = mkInvestigation({
      investigation_id: 'i-1',
      opened_at_ms: 3 * DAY_MS,
      closed_at_ms: DAY_MS,
      case_id: 'CASE-FRAUD-1',
      customer_id: 'CUST-100001',
    });
    const h = buildInvestigationDurationHistogram('BIL', [inv], NOW);
    const oneTo7d = h.buckets.find((r) => r.bucket === '1_to_7d')!;
    expect(oneTo7d.samples[0]).toMatchObject({
      investigation_id: 'i-1',
      case_id: 'CASE-FRAUD-1',
      customer_id: 'CUST-100001',
      status: 'closed',
      duration_ms: 2 * DAY_MS,
    });
    expect(oneTo7d.samples[0]!.opened_at).toBeDefined();
    expect(oneTo7d.samples[0]!.closed_at).toBeDefined();
  });
});

// ─── partition invariants ──────────────────────────────────────────

describe('M9.19 — partition invariants', () => {
  test('Σ buckets.count = total_investigations', () => {
    const invs = [
      mkInvestigation({ investigation_id: 'i1', opened_at_ms: 2 * HOUR_MS, closed_at_ms: 30 * 60 * 1000 }),
      mkInvestigation({ investigation_id: 'i2', opened_at_ms: 100 * DAY_MS, closed_at_ms: 30 * DAY_MS }),
      mkInvestigation({ investigation_id: 'i3', opened_at_ms: 5 * DAY_MS, closed_at_ms: null, status: 'triage' }),
    ];
    const h = buildInvestigationDurationHistogram('BIL', invs, NOW);
    const sum = h.buckets.reduce((acc, r) => acc + r.count, 0);
    expect(sum).toBe(h.total_investigations);
  });

  test('total_closed + total_still_open = total_investigations', () => {
    const invs = [
      mkInvestigation({ investigation_id: 'c1', opened_at_ms: 5 * DAY_MS, closed_at_ms: DAY_MS }),
      mkInvestigation({ investigation_id: 'c2', opened_at_ms: 10 * DAY_MS, closed_at_ms: 2 * DAY_MS }),
      mkInvestigation({ investigation_id: 'o1', opened_at_ms: 3 * DAY_MS, closed_at_ms: null, status: 'review' }),
      mkInvestigation({ investigation_id: 'o2', opened_at_ms: 8 * DAY_MS, closed_at_ms: null, status: 'triage' }),
    ];
    const h = buildInvestigationDurationHistogram('BIL', invs, NOW);
    expect(h.total_closed).toBe(2);
    expect(h.total_still_open).toBe(2);
    expect(h.total_closed + h.total_still_open).toBe(h.total_investigations);
  });

  test('aggregate stats computed over closed only (still_open excluded)', () => {
    const invs = [
      // closed: 1d / 3d / 5d → mean 3d, median 3d, p95 ≈ 4.6d
      mkInvestigation({ investigation_id: 'c1', opened_at_ms: 2 * DAY_MS, closed_at_ms: DAY_MS }), // dur 1d
      mkInvestigation({ investigation_id: 'c2', opened_at_ms: 4 * DAY_MS, closed_at_ms: DAY_MS }), // dur 3d
      mkInvestigation({ investigation_id: 'c3', opened_at_ms: 6 * DAY_MS, closed_at_ms: DAY_MS }), // dur 5d
      // open: should NOT influence aggregate stats
      mkInvestigation({ investigation_id: 'o1', opened_at_ms: 60 * DAY_MS, closed_at_ms: null, status: 'triage' }),
    ];
    const h = buildInvestigationDurationHistogram('BIL', invs, NOW);
    expect(h.mean_duration_ms).toBe(3 * DAY_MS);
    expect(h.median_duration_ms).toBe(3 * DAY_MS);
    expect(h.p95_duration_ms).toBeGreaterThan(3 * DAY_MS);
    expect(h.p95_duration_ms).toBeLessThanOrEqual(5 * DAY_MS);
  });

  test('aggregate stats null when no closed', () => {
    const invs = [
      mkInvestigation({ investigation_id: 'o1', opened_at_ms: 5 * DAY_MS, closed_at_ms: null, status: 'triage' }),
    ];
    const h = buildInvestigationDurationHistogram('BIL', invs, NOW);
    expect(h.mean_duration_ms).toBeNull();
    expect(h.median_duration_ms).toBeNull();
    expect(h.p95_duration_ms).toBeNull();
  });
});

// ─── peak_bucket ───────────────────────────────────────────────────

describe('M9.19 — peak_bucket', () => {
  test('peak_bucket = bucket with most investigations', () => {
    const invs = [
      mkInvestigation({ investigation_id: 'c1', opened_at_ms: 5 * DAY_MS, closed_at_ms: DAY_MS }), // 1_to_7d (4d)
      mkInvestigation({ investigation_id: 'c2', opened_at_ms: 6 * DAY_MS, closed_at_ms: DAY_MS }), // 1_to_7d (5d)
      mkInvestigation({ investigation_id: 'c3', opened_at_ms: 7 * DAY_MS, closed_at_ms: DAY_MS }), // 1_to_7d (6d)
      mkInvestigation({ investigation_id: 'o1', opened_at_ms: 3 * DAY_MS, closed_at_ms: null, status: 'triage' }),
    ];
    const h = buildInvestigationDurationHistogram('BIL', invs, NOW);
    expect(h.peak_bucket).toBe('1_to_7d');
    expect(h.peak_count).toBe(3);
  });

  test('canonical iteration tie-break — earlier bucket wins on tied count', () => {
    // 1 under_1h + 1 still_open (both count=1) → under_1h wins
    const invs = [
      // opened 90min ago, closed 60min ago → duration 30min → under_1h
      mkInvestigation({ investigation_id: 'fast', opened_at_ms: 90 * 60 * 1000, closed_at_ms: 60 * 60 * 1000 }),
      mkInvestigation({ investigation_id: 'open', opened_at_ms: 5 * DAY_MS, closed_at_ms: null, status: 'triage' }),
    ];
    const h = buildInvestigationDurationHistogram('BIL', invs, NOW);
    expect(h.peak_bucket).toBe('under_1h');
    expect(h.peak_count).toBe(1);
  });

  test('peak_bucket null when all 0', () => {
    const h = buildInvestigationDurationHistogram('BIL', [], NOW);
    expect(h.peak_bucket).toBeNull();
    expect(h.peak_count).toBe(0);
  });
});

// ─── longest_closed + oldest_open ──────────────────────────────────

describe('M9.19 — leaderboards', () => {
  test('longest_closed = highest duration_ms among closed', () => {
    const invs = [
      mkInvestigation({ investigation_id: 'short', opened_at_ms: 5 * HOUR_MS, closed_at_ms: HOUR_MS }), // 4h
      mkInvestigation({ investigation_id: 'long', opened_at_ms: 100 * DAY_MS, closed_at_ms: 30 * DAY_MS }), // 70d
      mkInvestigation({ investigation_id: 'mid', opened_at_ms: 10 * DAY_MS, closed_at_ms: 5 * DAY_MS }), // 5d
    ];
    const h = buildInvestigationDurationHistogram('BIL', invs, NOW);
    expect(h.longest_closed!.investigation_id).toBe('long');
    expect(h.longest_closed!.duration_ms).toBe(70 * DAY_MS);
  });

  test('oldest_open = earliest opened_at among still-open', () => {
    const invs = [
      mkInvestigation({ investigation_id: 'open-new', opened_at_ms: 2 * DAY_MS, closed_at_ms: null, status: 'triage' }),
      mkInvestigation({ investigation_id: 'open-old', opened_at_ms: 50 * DAY_MS, closed_at_ms: null, status: 'review' }),
      mkInvestigation({ investigation_id: 'open-mid', opened_at_ms: 10 * DAY_MS, closed_at_ms: null, status: 'triage' }),
    ];
    const h = buildInvestigationDurationHistogram('BIL', invs, NOW);
    expect(h.oldest_open!.investigation_id).toBe('open-old');
  });

  test('longest_closed null when no closed', () => {
    const invs = [
      mkInvestigation({ investigation_id: 'o1', opened_at_ms: 5 * DAY_MS, closed_at_ms: null, status: 'triage' }),
    ];
    const h = buildInvestigationDurationHistogram('BIL', invs, NOW);
    expect(h.longest_closed).toBeNull();
  });

  test('oldest_open null when no still-open', () => {
    const invs = [
      mkInvestigation({ investigation_id: 'c1', opened_at_ms: 5 * DAY_MS, closed_at_ms: DAY_MS }),
    ];
    const h = buildInvestigationDurationHistogram('BIL', invs, NOW);
    expect(h.oldest_open).toBeNull();
  });
});

// ─── empty_buckets ─────────────────────────────────────────────────

describe('M9.19 — empty_buckets', () => {
  test('every empty bucket appears in canonical order', () => {
    // Only populate 1_to_7d
    const h = buildInvestigationDurationHistogram(
      'BIL',
      [mkInvestigation({ investigation_id: 'i1', opened_at_ms: 3 * DAY_MS, closed_at_ms: DAY_MS })],
      NOW,
    );
    expect(h.empty_buckets).toEqual([
      'under_1h',
      '1_to_24h',
      '7_to_30d',
      '30d_plus',
      'still_open',
    ]);
  });
});

// ─── store adapter ─────────────────────────────────────────────────

describe('M9.19 — buildInvestigationDurationHistogramFromStore', () => {
  test('drains via store.list(tenant) with tenant scoping', () => {
    const store = new InMemoryCaseInvestigationStore();
    // Use store.open() to add — only need BIL data
    store.open(
      'BIL',
      { case_id: 'case-1', customer_id: 'cust-1' },
      'admin',
      new Date(NOW.getTime() - 5 * DAY_MS),
    );
    const bilHist = buildInvestigationDurationHistogramFromStore(store, 'BIL', NOW);
    const bankHist = buildInvestigationDurationHistogramFromStore(store, 'BANK_DEMO', NOW);
    expect(bilHist.total_investigations).toBe(1);
    expect(bilHist.total_still_open).toBe(1);
    expect(bankHist.total_investigations).toBe(0);
  });

  test('throws on empty tenant_id', () => {
    const store = new InMemoryCaseInvestigationStore();
    expect(() => buildInvestigationDurationHistogramFromStore(store, '', NOW)).toThrow();
  });
});

// ─── HTTP route ─────────────────────────────────────────────────────

function makeHistApp(role = 'admin') {
  const caseInvestigationStore = new InMemoryCaseInvestigationStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    caseInvestigationStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, caseInvestigationStore };
}

describe('M9.19 — GET /v1/investigations/duration-histogram', () => {
  test('admin → 200 with envelope shape (empty store)', async () => {
    const { app } = makeHistApp('admin');
    const r = await request(app)
      .get('/v1/investigations/duration-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.total_investigations).toBe(0);
    expect(r.body.body.buckets).toHaveLength(6);
    expect(r.body.body.peak_bucket).toBeNull();
  });

  test('populated → reflects one open investigation', async () => {
    const { app, caseInvestigationStore } = makeHistApp('admin');
    caseInvestigationStore.open(
      'BIL',
      { case_id: 'case-1', customer_id: 'cust-1' },
      'admin',
      new Date(NOW.getTime() - 3 * DAY_MS),
    );
    const r = await request(app)
      .get('/v1/investigations/duration-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_investigations).toBe(1);
    expect(r.body.body.total_still_open).toBe(1);
    expect(r.body.body.peak_bucket).toBe('still_open');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeHistApp('case_owner');
    const r = await request(app)
      .get('/v1/investigations/duration-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL invisible to BANK_DEMO via HTTP', async () => {
    const { app, caseInvestigationStore } = makeHistApp('admin');
    caseInvestigationStore.open(
      'BIL',
      { case_id: 'case-1', customer_id: 'cust-1' },
      'admin',
      new Date(NOW.getTime() - 3 * DAY_MS),
    );
    const bank = await request(app)
      .get('/v1/investigations/duration-histogram')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_investigations).toBe(0);
  });

  test('400 when no tenant header', async () => {
    const { app } = makeHistApp('admin');
    const r = await request(app).get('/v1/investigations/duration-histogram');
    expect(r.status).toBe(400);
  });

  test('literal /duration-histogram not captured by /:id wildcard', async () => {
    const { app } = makeHistApp('admin');
    const r = await request(app)
      .get('/v1/investigations/duration-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    // Envelope carries buckets[] of length 6, not single investigation
    expect(Array.isArray(r.body.body.buckets)).toBe(true);
    expect(r.body.body.buckets).toHaveLength(6);
  });

  test('M9.18 /notes/daily-volume sibling still works', async () => {
    const { app } = makeHistApp('admin');
    const r = await request(app)
      .get('/v1/investigations/notes/daily-volume')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M9.14 /note-authorship sibling still works', async () => {
    const { app } = makeHistApp('admin');
    const r = await request(app)
      .get('/v1/investigations/note-authorship')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
