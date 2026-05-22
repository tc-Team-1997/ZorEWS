// services/bff/__tests__/custom_dashboard_widget_count_histogram.test.ts
//
// T6 M11.19 — Custom dashboard widget-count histogram.

import request from 'supertest';
import {
  ALL_DASHBOARD_WIDGET_COUNT_BUCKETS,
  SAMPLE_DASHBOARDS_CAP,
  bucketForWidgetCount,
  buildDashboardWidgetCountHistogram,
  buildDashboardWidgetCountHistogramFromStore,
} from '../src/custom_dashboard_widget_count_histogram';
import {
  type CustomDashboard,
  type CustomDashboardStore,
  type DashboardWidget,
  InMemoryCustomDashboardStore,
} from '../src/custom_dashboards';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-23T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

// ─── helpers ────────────────────────────────────────────────────────

function mkWidget(idx: number): DashboardWidget {
  // 4 widgets per row (span = 3 cols × 4 = 12); wrap rows so the
  // grid stays within col [0, 11].
  const widgetsPerRow = 4;
  return {
    widget_type: 'alerts_by_class',
    position: {
      row: Math.floor(idx / widgetsPerRow),
      col: (idx % widgetsPerRow) * 3,
    },
    span: { rows: 1, cols: 3 },
    config: {},
  };
}

function mkDashboard(
  dashboard_id: string,
  widget_count: number,
  opts: Partial<CustomDashboard> = {},
): CustomDashboard {
  return {
    dashboard_id,
    tenant_id: 'BIL',
    name: opts.name ?? `dash-${dashboard_id}`,
    description: opts.description ?? '',
    widgets: Array.from({ length: widget_count }, (_, i) => mkWidget(i)),
    created_by: opts.created_by ?? 'admin',
    created_at: opts.created_at ?? NOW.toISOString(),
    updated_at: opts.updated_at ?? NOW.toISOString(),
    version: opts.version ?? 1,
  };
}

// ─── enum + helper invariants ───────────────────────────────────────

describe('M11.19 — canonical enum + helper', () => {
  test('ALL_DASHBOARD_WIDGET_COUNT_BUCKETS has 6 canonical values in canonical order', () => {
    expect([...ALL_DASHBOARD_WIDGET_COUNT_BUCKETS]).toEqual([
      'empty',
      'minimal',
      'small',
      'medium',
      'large',
      'x_large',
    ]);
  });

  test('SAMPLE_DASHBOARDS_CAP is 3', () => {
    expect(SAMPLE_DASHBOARDS_CAP).toBe(3);
  });

  test('bucketForWidgetCount canonical mapping', () => {
    expect(bucketForWidgetCount(0)).toBe('empty');
    expect(bucketForWidgetCount(1)).toBe('minimal');
    expect(bucketForWidgetCount(2)).toBe('small');
    expect(bucketForWidgetCount(3)).toBe('small');
    expect(bucketForWidgetCount(4)).toBe('medium');
    expect(bucketForWidgetCount(6)).toBe('medium');
    expect(bucketForWidgetCount(7)).toBe('large');
    expect(bucketForWidgetCount(12)).toBe('large');
    expect(bucketForWidgetCount(13)).toBe('x_large');
    expect(bucketForWidgetCount(99)).toBe('x_large');
  });

  test('bucketForWidgetCount defensive rejects', () => {
    expect(bucketForWidgetCount(-1)).toBeNull();
    expect(bucketForWidgetCount(1.5)).toBeNull();
    expect(bucketForWidgetCount(NaN)).toBeNull();
    expect(bucketForWidgetCount(Infinity)).toBeNull();
  });

  test('bucket boundaries — strict-< upper bound semantics', () => {
    // small upper bound is 3 (inclusive); 4 jumps to medium
    expect(bucketForWidgetCount(3)).toBe('small');
    expect(bucketForWidgetCount(4)).toBe('medium');
    // medium upper bound is 6 inclusive; 7 jumps to large
    expect(bucketForWidgetCount(6)).toBe('medium');
    expect(bucketForWidgetCount(7)).toBe('large');
    // large upper bound is 12 inclusive; 13 jumps to x_large
    expect(bucketForWidgetCount(12)).toBe('large');
    expect(bucketForWidgetCount(13)).toBe('x_large');
  });
});

// ─── empty input ────────────────────────────────────────────────────

describe('M11.19 — empty input', () => {
  test('no dashboards → 6 zero buckets + null leaderboards', () => {
    const h = buildDashboardWidgetCountHistogram('BIL', [], NOW);
    expect(h.tenant_id).toBe('BIL');
    expect(h.generated_at).toBe(NOW.toISOString());
    expect(h.total_dashboards).toBe(0);
    expect(h.total_widgets).toBe(0);
    expect(h.peak_bucket).toBeNull();
    expect(h.peak_count).toBe(0);
    expect(h.mean_widgets).toBeNull();
    expect(h.min_widgets).toBeNull();
    expect(h.max_widgets).toBeNull();
    expect(h.empty_buckets).toEqual([...ALL_DASHBOARD_WIDGET_COUNT_BUCKETS]);
    for (const row of h.buckets) {
      expect(row.count).toBe(0);
      expect(row.sample_dashboards).toEqual([]);
    }
  });

  test('throws on empty tenant_id', () => {
    expect(() => buildDashboardWidgetCountHistogram('', [], NOW)).toThrow();
    expect(() => buildDashboardWidgetCountHistogram('   ', [], NOW)).toThrow();
  });
});

// ─── bucket placement ──────────────────────────────────────────────

describe('M11.19 — bucket placement', () => {
  test('one dashboard per bucket lands correctly', () => {
    const dashboards: CustomDashboard[] = [
      mkDashboard('d-empty', 0),
      mkDashboard('d-min', 1),
      mkDashboard('d-small', 3),
      mkDashboard('d-medium', 5),
      mkDashboard('d-large', 10),
      mkDashboard('d-xlarge', 20),
    ];
    const h = buildDashboardWidgetCountHistogram('BIL', dashboards, NOW);
    const findCount = (b: string) =>
      h.buckets.find((r) => r.bucket === b)!.count;
    expect(findCount('empty')).toBe(1);
    expect(findCount('minimal')).toBe(1);
    expect(findCount('small')).toBe(1);
    expect(findCount('medium')).toBe(1);
    expect(findCount('large')).toBe(1);
    expect(findCount('x_large')).toBe(1);
    expect(h.total_dashboards).toBe(6);
    expect(h.total_widgets).toBe(0 + 1 + 3 + 5 + 10 + 20); // 39
    expect(h.min_widgets).toBe(0);
    expect(h.max_widgets).toBe(20);
    expect(h.empty_buckets).toEqual([]);
  });

  test('buckets emitted in canonical order regardless of input', () => {
    const h = buildDashboardWidgetCountHistogram(
      'BIL',
      [mkDashboard('d-large', 10), mkDashboard('d-min', 1)],
      NOW,
    );
    expect(h.buckets.map((r) => r.bucket)).toEqual([
      ...ALL_DASHBOARD_WIDGET_COUNT_BUCKETS,
    ]);
  });

  test('bucket metadata (min/max/max_inclusive/label) correct per bucket', () => {
    const h = buildDashboardWidgetCountHistogram('BIL', [], NOW);
    const empty = h.buckets.find((r) => r.bucket === 'empty')!;
    expect(empty).toMatchObject({ min: 0, max: 0, max_inclusive: true, label: '0 widgets' });
    const minimal = h.buckets.find((r) => r.bucket === 'minimal')!;
    expect(minimal).toMatchObject({ min: 1, max: 1, max_inclusive: true });
    const small = h.buckets.find((r) => r.bucket === 'small')!;
    expect(small).toMatchObject({ min: 2, max: 3 });
    const medium = h.buckets.find((r) => r.bucket === 'medium')!;
    expect(medium).toMatchObject({ min: 4, max: 6 });
    const large = h.buckets.find((r) => r.bucket === 'large')!;
    expect(large).toMatchObject({ min: 7, max: 12 });
    const xl = h.buckets.find((r) => r.bucket === 'x_large')!;
    expect(xl).toMatchObject({ min: 13, max: null, max_inclusive: false });
  });
});

// ─── sample_dashboards cap + sort ──────────────────────────────────

describe('M11.19 — sample_dashboards', () => {
  test('sample_dashboards cap 3 sorted widget_count desc + dashboard_id asc tie-break', () => {
    // 5 dashboards in 'medium' bucket (4-6 widgets each)
    const dashboards: CustomDashboard[] = [
      mkDashboard('d-a', 4),
      mkDashboard('d-b', 6),
      mkDashboard('d-c', 5),
      mkDashboard('d-d', 6),
      mkDashboard('d-e', 4),
    ];
    const h = buildDashboardWidgetCountHistogram('BIL', dashboards, NOW);
    const medium = h.buckets.find((r) => r.bucket === 'medium')!;
    expect(medium.count).toBe(5);
    expect(medium.sample_dashboards).toHaveLength(3);
    // Top by widget_count desc: 6, 6, 5 (then d-a/d-e w/4 truncated)
    // Tie-break on widget_count=6: d-b vs d-d → d-b asc first
    expect(medium.sample_dashboards[0]!.widget_count).toBe(6);
    expect(medium.sample_dashboards[0]!.dashboard_id).toBe('d-b');
    expect(medium.sample_dashboards[1]!.widget_count).toBe(6);
    expect(medium.sample_dashboards[1]!.dashboard_id).toBe('d-d');
    expect(medium.sample_dashboards[2]!.widget_count).toBe(5);
    expect(medium.sample_dashboards[2]!.dashboard_id).toBe('d-c');
  });

  test('sample carries dashboard_id + name + created_by + widget_count', () => {
    const dashboards: CustomDashboard[] = [
      mkDashboard('d-x', 5, { name: 'My Dashboard', created_by: 'alice' }),
    ];
    const h = buildDashboardWidgetCountHistogram('BIL', dashboards, NOW);
    const medium = h.buckets.find((r) => r.bucket === 'medium')!;
    expect(medium.sample_dashboards[0]).toEqual({
      dashboard_id: 'd-x',
      name: 'My Dashboard',
      created_by: 'alice',
      widget_count: 5,
    });
  });
});

// ─── partition invariants ──────────────────────────────────────────

describe('M11.19 — partition invariants', () => {
  test('Σ buckets.count = total_dashboards', () => {
    const dashboards = [
      mkDashboard('d1', 0),
      mkDashboard('d2', 2),
      mkDashboard('d3', 2),
      mkDashboard('d4', 5),
      mkDashboard('d5', 10),
    ];
    const h = buildDashboardWidgetCountHistogram('BIL', dashboards, NOW);
    const sum = h.buckets.reduce((acc, r) => acc + r.count, 0);
    expect(sum).toBe(h.total_dashboards);
  });

  test('total_widgets = Σ dashboards.widgets.length', () => {
    const dashboards = [mkDashboard('d1', 3), mkDashboard('d2', 5), mkDashboard('d3', 7)];
    const h = buildDashboardWidgetCountHistogram('BIL', dashboards, NOW);
    expect(h.total_widgets).toBe(3 + 5 + 7);
  });

  test('min/max formula across observed dashboards', () => {
    const dashboards = [mkDashboard('d1', 4), mkDashboard('d2', 1), mkDashboard('d3', 9)];
    const h = buildDashboardWidgetCountHistogram('BIL', dashboards, NOW);
    expect(h.min_widgets).toBe(1);
    expect(h.max_widgets).toBe(9);
  });

  test('mean_widgets = round(total / count) × 100 / 100', () => {
    const dashboards = [mkDashboard('d1', 1), mkDashboard('d2', 4), mkDashboard('d3', 7)];
    const h = buildDashboardWidgetCountHistogram('BIL', dashboards, NOW);
    expect(h.mean_widgets).toBe(4); // round((1+4+7)/3) = round(4) = 4
  });

  test('mean_widgets rounded to 2 decimals', () => {
    const dashboards = [mkDashboard('d1', 1), mkDashboard('d2', 2), mkDashboard('d3', 6)];
    const h = buildDashboardWidgetCountHistogram('BIL', dashboards, NOW);
    // (1+2+6)/3 = 3 exactly → 3
    expect(h.mean_widgets).toBe(3);
  });
});

// ─── peak_bucket ───────────────────────────────────────────────────

describe('M11.19 — peak_bucket', () => {
  test('peak_bucket = bucket with most dashboards', () => {
    const dashboards = [
      mkDashboard('d1', 5),
      mkDashboard('d2', 5),
      mkDashboard('d3', 5),
      mkDashboard('d4', 10),
    ];
    const h = buildDashboardWidgetCountHistogram('BIL', dashboards, NOW);
    expect(h.peak_bucket).toBe('medium');
    expect(h.peak_count).toBe(3);
  });

  test('canonical iteration tie-break — earlier bucket wins on tied count', () => {
    // 1 empty + 1 minimal (both count=1) → empty wins via canonical iteration
    const dashboards = [mkDashboard('d-empty', 0), mkDashboard('d-min', 1)];
    const h = buildDashboardWidgetCountHistogram('BIL', dashboards, NOW);
    expect(h.peak_bucket).toBe('empty');
    expect(h.peak_count).toBe(1);
  });

  test('peak_bucket null when all counts are 0', () => {
    const h = buildDashboardWidgetCountHistogram('BIL', [], NOW);
    expect(h.peak_bucket).toBeNull();
    expect(h.peak_count).toBe(0);
  });
});

// ─── empty_buckets ─────────────────────────────────────────────────

describe('M11.19 — empty_buckets', () => {
  test('every empty bucket appears in canonical order', () => {
    // Only populate 'medium'
    const h = buildDashboardWidgetCountHistogram(
      'BIL',
      [mkDashboard('d1', 5)],
      NOW,
    );
    expect(h.empty_buckets).toEqual(['empty', 'minimal', 'small', 'large', 'x_large']);
  });

  test('empty_buckets is empty when every bucket has ≥ 1', () => {
    const dashboards = [
      mkDashboard('d-empty', 0),
      mkDashboard('d-min', 1),
      mkDashboard('d-small', 2),
      mkDashboard('d-medium', 4),
      mkDashboard('d-large', 8),
      mkDashboard('d-xl', 15),
    ];
    const h = buildDashboardWidgetCountHistogram('BIL', dashboards, NOW);
    expect(h.empty_buckets).toEqual([]);
  });
});

// ─── store adapter ─────────────────────────────────────────────────

describe('M11.19 — buildDashboardWidgetCountHistogramFromStore', () => {
  test('drains via store.list(tenant) with tenant scoping', () => {
    const store = new InMemoryCustomDashboardStore();
    // Use the store directly (BIL has 2 dashboards; BANK_DEMO has 0)
    store.create('BIL', { name: 'd1', widgets: [mkWidget(0), mkWidget(1)] }, 'admin', NOW);
    store.create('BIL', { name: 'd2', widgets: [mkWidget(0)] }, 'admin', NOW);
    const bilHist = buildDashboardWidgetCountHistogramFromStore(store, 'BIL', NOW);
    const bankHist = buildDashboardWidgetCountHistogramFromStore(store, 'BANK_DEMO', NOW);
    expect(bilHist.total_dashboards).toBe(2);
    expect(bankHist.total_dashboards).toBe(0);
  });

  test('throws on empty tenant_id', () => {
    const store = new InMemoryCustomDashboardStore();
    expect(() => buildDashboardWidgetCountHistogramFromStore(store, '', NOW)).toThrow();
  });
});

// ─── HTTP route ─────────────────────────────────────────────────────

function makeHistApp(role = 'admin') {
  const customDashboardStore = new InMemoryCustomDashboardStore();
  const built = makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    customDashboardStore,
    now: () => NOW,
    getRole: () => role,
  });
  return { ...built, customDashboardStore };
}

describe('M11.19 — GET /v1/dashboards/custom/widget-count-histogram', () => {
  test('admin → 200 with envelope shape (empty store)', async () => {
    const { app } = makeHistApp('admin');
    const r = await request(app)
      .get('/v1/dashboards/custom/widget-count-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
    expect(r.body.body.total_dashboards).toBe(0);
    expect(r.body.body.buckets).toHaveLength(6);
    expect(r.body.body.peak_bucket).toBeNull();
  });

  test('populated → reflects dashboards in correct buckets', async () => {
    const { app, customDashboardStore } = makeHistApp('admin');
    customDashboardStore.create(
      'BIL',
      { name: 'small-d', widgets: [mkWidget(0), mkWidget(1)] },
      'admin',
      NOW,
    );
    customDashboardStore.create(
      'BIL',
      {
        name: 'medium-d',
        widgets: [mkWidget(0), mkWidget(1), mkWidget(2), mkWidget(3), mkWidget(4)],
      },
      'admin',
      NOW,
    );
    const r = await request(app)
      .get('/v1/dashboards/custom/widget-count-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_dashboards).toBe(2);
    expect(r.body.body.total_widgets).toBe(7);
    const findCount = (b: string) =>
      r.body.body.buckets.find((row: { bucket: string; count: number }) => row.bucket === b).count;
    expect(findCount('small')).toBe(1);
    expect(findCount('medium')).toBe(1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeHistApp('case_owner');
    const r = await request(app)
      .get('/v1/dashboards/custom/widget-count-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL dashboards invisible to BANK_DEMO via HTTP', async () => {
    const { app, customDashboardStore } = makeHistApp('admin');
    customDashboardStore.create(
      'BIL',
      { name: 'bil-d', widgets: [mkWidget(0), mkWidget(1)] },
      'admin',
      NOW,
    );
    const bank = await request(app)
      .get('/v1/dashboards/custom/widget-count-histogram')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_dashboards).toBe(0);
  });

  test('400 when no tenant header', async () => {
    const { app } = makeHistApp('admin');
    const r = await request(app)
      .get('/v1/dashboards/custom/widget-count-histogram');
    expect(r.status).toBe(400);
  });

  test('literal /widget-count-histogram not captured by /:dashboard_id wildcard', async () => {
    const { app } = makeHistApp('admin');
    const r = await request(app)
      .get('/v1/dashboards/custom/widget-count-histogram')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    // Envelope shape (body.body.buckets is 6-element array), not single dashboard
    expect(Array.isArray(r.body.body.buckets)).toBe(true);
    expect(r.body.body.buckets).toHaveLength(6);
  });

  test('M11.18 /freshness sibling route still works', async () => {
    const { app } = makeHistApp('admin');
    const r = await request(app)
      .get('/v1/dashboards/custom/freshness')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('M11.15 /authorship sibling route still works', async () => {
    const { app } = makeHistApp('admin');
    const r = await request(app)
      .get('/v1/dashboards/custom/authorship')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
