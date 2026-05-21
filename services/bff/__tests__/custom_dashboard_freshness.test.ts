// T6 M11.18 — Custom dashboard freshness rollup tests.

import request from 'supertest';
import {
  DEFAULT_FRESH_DAYS,
  DEFAULT_STALE_DAYS,
  DashboardFreshnessError,
  STALE_DASHBOARDS_CAP,
  summarizeDashboardFreshness,
} from '../src/custom_dashboard_freshness';
import type { CustomDashboard } from '../src/custom_dashboards';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-21T18:00:00.000Z');
const H_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function dash(
  id: string,
  updated_at: string,
  overrides: Partial<CustomDashboard> = {},
): CustomDashboard {
  return {
    dashboard_id: id,
    tenant_id: 'BIL',
    name: `Dashboard ${id}`,
    description: '',
    widgets: [],
    created_by: 'alice',
    created_at: updated_at,
    updated_at,
    version: 1,
    ...overrides,
  };
}

describe('summarizeDashboardFreshness — validation', () => {
  test('rejects negative fresh_days', () => {
    expect(() =>
      summarizeDashboardFreshness('BIL', [], NOW, -1, 90),
    ).toThrow(DashboardFreshnessError);
  });

  test('rejects negative stale_days', () => {
    expect(() =>
      summarizeDashboardFreshness('BIL', [], NOW, 30, -1),
    ).toThrow(DashboardFreshnessError);
  });

  test('rejects non-integer fresh_days', () => {
    expect(() =>
      summarizeDashboardFreshness('BIL', [], NOW, 30.5, 90),
    ).toThrow(DashboardFreshnessError);
  });

  test('rejects stale_days < fresh_days', () => {
    expect(() =>
      summarizeDashboardFreshness('BIL', [], NOW, 90, 30),
    ).toThrow(DashboardFreshnessError);
  });

  test('accepts stale_days = fresh_days', () => {
    expect(() =>
      summarizeDashboardFreshness('BIL', [], NOW, 30, 30),
    ).not.toThrow();
  });

  test('threshold constants exported', () => {
    expect(DEFAULT_FRESH_DAYS).toBe(30);
    expect(DEFAULT_STALE_DAYS).toBe(90);
    expect(STALE_DASHBOARDS_CAP).toBe(20);
  });
});

describe('summarizeDashboardFreshness — empty input', () => {
  test('zero counts + null leaderboards', () => {
    const r = summarizeDashboardFreshness('BIL', [], NOW);
    expect(r.tenant_id).toBe('BIL');
    expect(r.total_dashboards).toBe(0);
    expect(r.recent_count).toBe(0);
    expect(r.stable_count).toBe(0);
    expect(r.stale_count).toBe(0);
    expect(r.mean_days_since_updated).toBeNull();
    expect(r.oldest_updated).toBeNull();
    expect(r.newest_updated).toBeNull();
    expect(r.dashboards).toEqual([]);
    expect(r.stale_dashboards).toEqual([]);
  });

  test('echoes thresholds', () => {
    const r = summarizeDashboardFreshness('BIL', [], NOW, 14, 60);
    expect(r.fresh_days).toBe(14);
    expect(r.stale_days).toBe(60);
  });
});

describe('summarizeDashboardFreshness — bucket classification', () => {
  test('updated today → recent', () => {
    const r = summarizeDashboardFreshness(
      'BIL',
      [dash('d-1', NOW.toISOString())],
      NOW,
    );
    expect(r.dashboards[0].days_since_updated).toBe(0);
    expect(r.dashboards[0].freshness).toBe('recent');
    expect(r.recent_count).toBe(1);
  });

  test('updated 60 days ago → stable (between 30 + 90)', () => {
    const sixtyDaysAgo = new Date(NOW.getTime() - 60 * 86_400_000).toISOString();
    const r = summarizeDashboardFreshness(
      'BIL',
      [dash('d-1', sixtyDaysAgo)],
      NOW,
    );
    expect(r.dashboards[0].days_since_updated).toBe(60);
    expect(r.dashboards[0].freshness).toBe('stable');
    expect(r.stable_count).toBe(1);
  });

  test('updated 120 days ago → stale', () => {
    const oneTwentyDaysAgo = new Date(NOW.getTime() - 120 * 86_400_000).toISOString();
    const r = summarizeDashboardFreshness(
      'BIL',
      [dash('d-1', oneTwentyDaysAgo)],
      NOW,
    );
    expect(r.dashboards[0].days_since_updated).toBe(120);
    expect(r.dashboards[0].freshness).toBe('stale');
    expect(r.stale_count).toBe(1);
  });

  test('boundary: exactly fresh_days → stable (strict-< on fresh)', () => {
    const thirtyDaysAgo = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();
    const r = summarizeDashboardFreshness(
      'BIL',
      [dash('d-1', thirtyDaysAgo)],
      NOW,
    );
    expect(r.dashboards[0].freshness).toBe('stable');
  });

  test('boundary: exactly stale_days → stable (strict-> on stale)', () => {
    const ninetyDaysAgo = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
    const r = summarizeDashboardFreshness(
      'BIL',
      [dash('d-1', ninetyDaysAgo)],
      NOW,
    );
    expect(r.dashboards[0].freshness).toBe('stable');
  });

  test('Σ recent + stable + stale = total_dashboards', () => {
    const recent = dash('d-recent', NOW.toISOString());
    const stable = dash('d-stable', new Date(NOW.getTime() - 60 * 86_400_000).toISOString());
    const stale = dash('d-stale', new Date(NOW.getTime() - 200 * 86_400_000).toISOString());
    const r = summarizeDashboardFreshness('BIL', [recent, stable, stale], NOW);
    expect(r.total_dashboards).toBe(3);
    expect(r.recent_count).toBe(1);
    expect(r.stable_count).toBe(1);
    expect(r.stale_count).toBe(1);
  });
});

describe('summarizeDashboardFreshness — sort + leaderboards', () => {
  test('dashboards sorted oldest-first (days_since_updated desc)', () => {
    const recent = dash('d-recent', NOW.toISOString());
    const old = dash(
      'd-old',
      new Date(NOW.getTime() - 200 * 86_400_000).toISOString(),
    );
    const middle = dash(
      'd-mid',
      new Date(NOW.getTime() - 50 * 86_400_000).toISOString(),
    );
    const r = summarizeDashboardFreshness('BIL', [recent, old, middle], NOW);
    expect(r.dashboards[0].dashboard_id).toBe('d-old');
    expect(r.dashboards[1].dashboard_id).toBe('d-mid');
    expect(r.dashboards[2].dashboard_id).toBe('d-recent');
  });

  test('oldest_updated + newest_updated formulas', () => {
    const recent = dash('d-recent', NOW.toISOString());
    const old = dash(
      'd-old',
      new Date(NOW.getTime() - 200 * 86_400_000).toISOString(),
    );
    const r = summarizeDashboardFreshness('BIL', [recent, old], NOW);
    expect(r.oldest_updated?.dashboard_id).toBe('d-old');
    expect(r.newest_updated?.dashboard_id).toBe('d-recent');
  });

  test('dashboard_id asc tie-break at same days_since_updated', () => {
    const ts = new Date(NOW.getTime() - 100 * 86_400_000).toISOString();
    const r = summarizeDashboardFreshness(
      'BIL',
      [dash('zebra', ts), dash('alpha', ts)],
      NOW,
    );
    expect(r.dashboards[0].dashboard_id).toBe('alpha');
    expect(r.dashboards[1].dashboard_id).toBe('zebra');
  });

  test('mean_days_since_updated = round(Σ / total)', () => {
    const day_10 = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();
    const day_20 = new Date(NOW.getTime() - 20 * 86_400_000).toISOString();
    const day_30 = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();
    const r = summarizeDashboardFreshness(
      'BIL',
      [dash('d-1', day_10), dash('d-2', day_20), dash('d-3', day_30)],
      NOW,
    );
    expect(r.mean_days_since_updated).toBe(20);
  });

  test('stale_dashboards filter + cap 20', () => {
    const stale: CustomDashboard[] = [];
    for (let i = 0; i < 25; i += 1) {
      stale.push(
        dash(
          `d-${String(i).padStart(3, '0')}`,
          new Date(NOW.getTime() - (100 + i) * 86_400_000).toISOString(),
        ),
      );
    }
    const r = summarizeDashboardFreshness('BIL', stale, NOW);
    expect(r.stale_count).toBe(25);
    expect(r.stale_dashboards).toHaveLength(20);
    // Oldest first
    for (let i = 1; i < r.stale_dashboards.length; i += 1) {
      expect(
        r.stale_dashboards[i - 1].days_since_updated >=
          r.stale_dashboards[i].days_since_updated,
      ).toBe(true);
    }
  });

  test('stale_dashboards empty when no stale', () => {
    const r = summarizeDashboardFreshness('BIL', [dash('d-1', NOW.toISOString())], NOW);
    expect(r.stale_dashboards).toEqual([]);
  });

  test('row carries total_widgets + version', () => {
    const d: CustomDashboard = {
      ...dash('d-1', NOW.toISOString()),
      version: 5,
      widgets: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { widget_type: 'risk_score_histogram' as any, config: {}, position: { row: 0, col: 0 }, span: { rows: 1, cols: 1 } },
      ],
    };
    const r = summarizeDashboardFreshness('BIL', [d], NOW);
    expect(r.dashboards[0].total_widgets).toBe(1);
    expect(r.dashboards[0].version).toBe(5);
  });
});

describe('summarizeDashboardFreshness — custom thresholds', () => {
  test('tighter thresholds shift bucketing', () => {
    const fortyDaysAgo = new Date(NOW.getTime() - 40 * 86_400_000).toISOString();
    // Default: 40 days → stable (between 30 + 90)
    const def = summarizeDashboardFreshness('BIL', [dash('d-1', fortyDaysAgo)], NOW);
    expect(def.dashboards[0].freshness).toBe('stable');
    // Tighter: fresh=14, stale=30 → 40 days → stale
    const tight = summarizeDashboardFreshness(
      'BIL',
      [dash('d-1', fortyDaysAgo)],
      NOW,
      14,
      30,
    );
    expect(tight.dashboards[0].freshness).toBe('stale');
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

function makeRouteApp(role: string = 'admin') {
  return makeApp({
    source: new StaticSource([]),
    evaluator: new StubEvaluator(),
    riskProfile: new StubRiskProfileSource(),
    caseAction: new UnavailableCaseActionSink(),
    now: () => NOW,
    getRole: () => role,
  });
}

describe('GET /v1/dashboards/custom/freshness', () => {
  test('admin happy path with empty store', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app).get('/v1/dashboards/custom/freshness').set(H_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_dashboards).toBe(0);
    expect(r.body.body.fresh_days).toBe(30);
    expect(r.body.body.stale_days).toBe(90);
  });

  test('?fresh_days + ?stale_days reflected in envelope', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app)
      .get('/v1/dashboards/custom/freshness?fresh_days=14&stale_days=60')
      .set(H_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.fresh_days).toBe(14);
    expect(r.body.body.stale_days).toBe(60);
  });

  test('?fresh_days=-1 → 400 EWS_400_invalid_input', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app)
      .get('/v1/dashboards/custom/freshness?fresh_days=-1')
      .set(H_BIL);
    expect(r.status).toBe(400);
    expect(r.body.error?.code).toBe('EWS_400_invalid_input');
  });

  test('?stale_days < fresh_days → 400', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app)
      .get('/v1/dashboards/custom/freshness?fresh_days=60&stale_days=30')
      .set(H_BIL);
    expect(r.status).toBe(400);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeRouteApp('field_officer');
    const r = await request(app).get('/v1/dashboards/custom/freshness').set(H_BIL);
    expect(r.status).toBe(403);
  });

  test('missing tenant header → 400', async () => {
    const { app } = makeRouteApp('admin');
    const r = await request(app).get('/v1/dashboards/custom/freshness');
    expect(r.status).toBe(400);
  });
});
