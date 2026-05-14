// services/bff/__tests__/custom_dashboard_lint.test.ts
//
// T6 M11.10 — Custom dashboard layout linting.

import request from 'supertest';
import {
  EMPTY_REGION_ROWS,
  MAX_REASONABLE_ROWS,
  lintDashboardLayout,
} from '../src/custom_dashboard_lint';
import {
  InMemoryCustomDashboardStore,
  type CustomDashboard,
  type DashboardWidget,
} from '../src/custom_dashboards';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-14T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function mkWidget(o: Partial<DashboardWidget> = {}): DashboardWidget {
  return {
    widget_type: o.widget_type ?? 'alerts_by_class',
    position: o.position ?? { row: 0, col: 0 },
    span: o.span ?? { rows: 1, cols: 6 },
    config: o.config ?? {},
  };
}

function mkDashboard(widgets: DashboardWidget[]): CustomDashboard {
  return {
    dashboard_id: 'dsh-test',
    tenant_id: 'BIL',
    name: 'Test',
    description: '',
    widgets,
    created_by: 'alice',
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    version: 1,
  };
}

// ─── lintDashboardLayout — pure ──────────────────────────────────────

describe('M11.10 — empty + clean layouts', () => {
  test('empty widgets → passes, no issues', () => {
    const r = lintDashboardLayout(mkDashboard([]));
    expect(r.passes).toBe(true);
    expect(r.total_widgets).toBe(0);
    expect(r.errors_count).toBe(0);
    expect(r.warnings_count).toBe(0);
    expect(r.info_count).toBe(0);
    expect(r.issues).toEqual([]);
  });

  test('two clean widgets, adjacent rows → passes', () => {
    const r = lintDashboardLayout(
      mkDashboard([
        mkWidget({ position: { row: 0, col: 0 }, span: { rows: 2, cols: 6 } }),
        mkWidget({ position: { row: 2, col: 0 }, span: { rows: 2, cols: 6 } }),
      ]),
    );
    expect(r.passes).toBe(true);
  });
});

describe('M11.10 — unknown_widget_type (error)', () => {
  test('widget_type not in catalog → error with widget_index', () => {
    const r = lintDashboardLayout(
      mkDashboard([
        mkWidget({ widget_type: 'made_up_widget' as unknown as DashboardWidget['widget_type'] }),
      ]),
    );
    expect(r.passes).toBe(false);
    expect(r.errors_count).toBe(1);
    expect(r.issues[0]!.type).toBe('unknown_widget_type');
    expect(r.issues[0]!.widget_index).toBe(0);
  });
});

describe('M11.10 — overlapping_widgets (error)', () => {
  test('two widgets sharing a cell → error with widget_index + widget_index_b', () => {
    const r = lintDashboardLayout(
      mkDashboard([
        mkWidget({ position: { row: 0, col: 0 }, span: { rows: 2, cols: 6 } }),
        mkWidget({ position: { row: 1, col: 2 }, span: { rows: 2, cols: 4 } }),
      ]),
    );
    expect(r.passes).toBe(false);
    expect(r.issues.some((i) => i.type === 'overlapping_widgets' && i.widget_index === 0 && i.widget_index_b === 1)).toBe(true);
  });
});

describe('M11.10 — widget_extends_beyond_max_rows (warning)', () => {
  test('widget reaching past MAX_REASONABLE_ROWS surfaces a warning, layout still passes', () => {
    const r = lintDashboardLayout(
      mkDashboard([
        mkWidget({ position: { row: MAX_REASONABLE_ROWS, col: 0 }, span: { rows: 1, cols: 6 } }),
      ]),
    );
    expect(r.warnings_count).toBe(1);
    expect(r.issues[0]!.type).toBe('widget_extends_beyond_max_rows');
    // Warning doesn't gate `passes`.
    expect(r.passes).toBe(true);
  });

  test('widget bottoming at MAX_REASONABLE_ROWS-1 is fine (boundary)', () => {
    const r = lintDashboardLayout(
      mkDashboard([
        mkWidget({ position: { row: 0, col: 0 }, span: { rows: MAX_REASONABLE_ROWS, cols: 6 } }),
      ]),
    );
    expect(r.issues.filter((i) => i.type === 'widget_extends_beyond_max_rows')).toEqual([]);
  });
});

describe('M11.10 — unrecognized_config_key (warning)', () => {
  test('config carries a key not in the widget\'s catalog whitelist → warning', () => {
    const r = lintDashboardLayout(
      mkDashboard([
        mkWidget({
          widget_type: 'alerts_by_class',
          config: { since_hours: 24, made_up_key: true },
        }),
      ]),
    );
    expect(r.warnings_count).toBe(1);
    expect(r.issues[0]!.type).toBe('unrecognized_config_key');
    expect(r.issues[0]!.widget_index).toBe(0);
  });

  test('skipped when widget_type is unknown (already errored)', () => {
    const r = lintDashboardLayout(
      mkDashboard([
        mkWidget({
          widget_type: 'fake' as unknown as DashboardWidget['widget_type'],
          config: { anything: 1 },
        }),
      ]),
    );
    // Only the unknown_widget_type error, no unrecognized_config_key warning.
    expect(r.issues.filter((i) => i.type === 'unrecognized_config_key')).toEqual([]);
  });
});

describe('M11.10 — empty_grid_region (info)', () => {
  test('gap > EMPTY_REGION_ROWS between consecutive widgets → info', () => {
    const r = lintDashboardLayout(
      mkDashboard([
        mkWidget({ position: { row: 0, col: 0 }, span: { rows: 1, cols: 6 } }),
        mkWidget({
          position: { row: EMPTY_REGION_ROWS + 5, col: 0 },
          span: { rows: 1, cols: 6 },
        }),
      ]),
    );
    expect(r.info_count).toBe(1);
    expect(r.issues[0]!.type).toBe('empty_grid_region');
    // Info doesn't gate passes.
    expect(r.passes).toBe(true);
  });

  test('small gap → no info', () => {
    const r = lintDashboardLayout(
      mkDashboard([
        mkWidget({ position: { row: 0, col: 0 }, span: { rows: 1, cols: 6 } }),
        mkWidget({ position: { row: 3, col: 0 }, span: { rows: 1, cols: 6 } }),
      ]),
    );
    expect(r.info_count).toBe(0);
  });

  test('multiple gaps each surface independently', () => {
    const r = lintDashboardLayout(
      mkDashboard([
        mkWidget({ position: { row: 0, col: 0 }, span: { rows: 1, cols: 6 } }),
        mkWidget({ position: { row: 12, col: 0 }, span: { rows: 1, cols: 6 } }),
        mkWidget({ position: { row: 25, col: 0 }, span: { rows: 1, cols: 6 } }),
      ]),
    );
    expect(r.info_count).toBe(2);
  });
});

describe('M11.10 — passes vs counts', () => {
  test('warnings + info do NOT gate passes; only errors do', () => {
    const r = lintDashboardLayout(
      mkDashboard([
        mkWidget({
          widget_type: 'alerts_by_class',
          position: { row: 0, col: 0 },
          span: { rows: 1, cols: 6 },
          config: { unknown: 1 }, // warning
        }),
        mkWidget({
          position: { row: 20, col: 0 }, // gap > 5 → info
          span: { rows: 1, cols: 6 },
        }),
      ]),
    );
    expect(r.warnings_count).toBeGreaterThan(0);
    expect(r.info_count).toBeGreaterThan(0);
    expect(r.errors_count).toBe(0);
    expect(r.passes).toBe(true);
  });

  test('any error gates passes=false', () => {
    const r = lintDashboardLayout(
      mkDashboard([
        mkWidget({ position: { row: 0, col: 0 }, span: { rows: 2, cols: 6 } }),
        mkWidget({ position: { row: 1, col: 0 }, span: { rows: 2, cols: 6 } }), // overlap
      ]),
    );
    expect(r.errors_count).toBeGreaterThan(0);
    expect(r.passes).toBe(false);
  });
});

// ─── GET /v1/dashboards/custom/:dashboard_id/lint ────────────────────

function makeLintApp(role = 'admin', store?: InMemoryCustomDashboardStore) {
  const customDashboardStore = store ?? new InMemoryCustomDashboardStore();
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

describe('M11.10 — GET /v1/dashboards/custom/:dashboard_id/lint', () => {
  test('200 with LintReport for an existing dashboard', async () => {
    const store = new InMemoryCustomDashboardStore();
    const d = store.create(
      'BIL',
      {
        name: 'OK Layout',
        description: '',
        widgets: [
          {
            widget_type: 'alerts_by_class',
            position: { row: 0, col: 0 },
            span: { rows: 1, cols: 6 },
            config: { since_hours: 24 },
          },
        ],
      },
      'alice',
      NOW,
    );
    const { app } = makeLintApp('admin', store);
    const r = await request(app)
      .get(`/v1/dashboards/custom/${d.dashboard_id}/lint`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.passes).toBe(true);
    expect(r.body.body.dashboard_id).toBe(d.dashboard_id);
    expect(r.body.body.total_widgets).toBe(1);
  });

  test('unknown dashboard → 404', async () => {
    const { app } = makeLintApp('admin');
    const r = await request(app)
      .get('/v1/dashboards/custom/dsh-does-not-exist/lint')
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_dashboard');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeLintApp('case_owner');
    const r = await request(app)
      .get('/v1/dashboards/custom/anything/lint')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BANK_DEMO does not see BIL dashboards', async () => {
    const store = new InMemoryCustomDashboardStore();
    const d = store.create(
      'BIL',
      {
        name: 'BIL-only',
        description: '',
        widgets: [
          {
            widget_type: 'alerts_by_class',
            position: { row: 0, col: 0 },
            span: { rows: 1, cols: 6 },
            config: {},
          },
        ],
      },
      'alice',
      NOW,
    );
    const { app } = makeLintApp('admin', store);
    const r = await request(app)
      .get(`/v1/dashboards/custom/${d.dashboard_id}/lint`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(404);
  });

  test('M11.7 GET /v1/dashboards/custom/:id still works (lint route is additive)', async () => {
    const store = new InMemoryCustomDashboardStore();
    const d = store.create(
      'BIL',
      {
        name: 'X',
        description: '',
        widgets: [
          {
            widget_type: 'alerts_by_class',
            position: { row: 0, col: 0 },
            span: { rows: 1, cols: 6 },
            config: {},
          },
        ],
      },
      'alice',
      NOW,
    );
    const { app } = makeLintApp('admin', store);
    const r = await request(app)
      .get(`/v1/dashboards/custom/${d.dashboard_id}`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.dashboard_id).toBe(d.dashboard_id);
  });
});
