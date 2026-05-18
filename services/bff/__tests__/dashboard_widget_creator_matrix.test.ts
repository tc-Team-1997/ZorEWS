// services/bff/__tests__/dashboard_widget_creator_matrix.test.ts
//
// T6 M11.17 — Dashboard widget × creator cross-tab matrix.

import request from 'supertest';
import { buildDashboardWidgetCreatorMatrix } from '../src/dashboard_widget_creator_matrix';
import {
  InMemoryCustomDashboardStore,
  WIDGET_TYPES,
  type CustomDashboard,
} from '../src/custom_dashboards';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-19T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };
const TH_BANK = { 'X-Tenant-ID': 'BANK_DEMO', 'X-Channel': 'API' };

const widget = (widget_type: string, col = 0) => ({
  widget_type: widget_type as 'alerts_by_class',
  position: { row: 0, col },
  span: { rows: 2, cols: 6 },
  config: {},
});

function dashboard(overrides: Partial<CustomDashboard> = {}): CustomDashboard {
  return {
    dashboard_id: 'd-' + Math.random().toString(36).slice(2, 10),
    tenant_id: 'BIL',
    name: 'Test Dashboard',
    description: '',
    widgets: [widget('alerts_by_class')],
    created_by: 'alice',
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    version: 1,
    ...overrides,
  };
}

function makeCmApp(role: string = 'admin') {
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

// ─── Pure resolver tests ─────────────────────────────────────────────

describe('M11.17 — empty input', () => {
  test('zero dashboards → empty rows + 7 cols at 0 + null peak', () => {
    const s = buildDashboardWidgetCreatorMatrix('BIL', [], NOW);
    expect(s.total_dashboards).toBe(0);
    expect(s.total_creators).toBe(0);
    expect(s.total_widgets).toBe(0);
    expect(s.total_widget_types).toBe(7);
    expect(s.rows).toEqual([]);
    expect(s.columns.length).toBe(7);
    for (const c of s.columns) {
      expect(c.total_instances).toBe(0);
      expect(c.top_creators).toEqual([]);
      expect(c.distinct_creators).toBe(0);
    }
    expect(s.peak_cell).toBeNull();
    expect(s.most_versatile_creator).toBeNull();
  });
});

describe('M11.17 — canonical column order', () => {
  test('columns[] in canonical WidgetType order', () => {
    const s = buildDashboardWidgetCreatorMatrix('BIL', [], NOW);
    expect(s.columns.map((c) => c.widget_type)).toEqual([...WIDGET_TYPES]);
  });

  test('every column has display_name', () => {
    const s = buildDashboardWidgetCreatorMatrix('BIL', [], NOW);
    for (const c of s.columns) {
      expect(c.display_name.length).toBeGreaterThan(0);
    }
  });
});

describe('M11.17 — single dashboard single creator', () => {
  test('alice with 1 dashboard 1 widget → 1 row', () => {
    const d = dashboard({ widgets: [widget('alerts_by_class')] });
    const s = buildDashboardWidgetCreatorMatrix('BIL', [d], NOW);
    expect(s.total_creators).toBe(1);
    expect(s.rows[0].created_by).toBe('alice');
    expect(s.rows[0].total_widgets).toBe(1);
    expect(s.rows[0].total_dashboards).toBe(1);
    expect(s.rows[0].by_widget_type.alerts_by_class).toBe(1);
    expect(s.rows[0].by_widget_type.open_cases).toBe(0);
    expect(s.rows[0].distinct_widget_types).toBe(1);
  });
});

describe('M11.17 — multi-creator cohort sorted desc', () => {
  test('alice 5 widgets + bob 2 → alice first', () => {
    const d1 = dashboard({
      created_by: 'alice',
      widgets: [
        widget('alerts_by_class', 0),
        widget('open_cases', 6),
      ],
    });
    const d2 = dashboard({
      created_by: 'alice',
      widgets: [
        widget('audit_recent', 0),
        widget('tenant_kpi', 6),
        widget('top_breaches', 0),
      ],
    });
    const d3 = dashboard({
      created_by: 'bob',
      widgets: [widget('connector_health', 0), widget('risk_score_histogram', 6)],
    });
    const s = buildDashboardWidgetCreatorMatrix('BIL', [d1, d2, d3], NOW);
    expect(s.rows[0].created_by).toBe('alice');
    expect(s.rows[0].total_widgets).toBe(5);
    expect(s.rows[1].created_by).toBe('bob');
    expect(s.rows[1].total_widgets).toBe(2);
  });

  test('canonical username asc tie-break', () => {
    const d1 = dashboard({ created_by: 'zoe', widgets: [widget('alerts_by_class')] });
    const d2 = dashboard({ created_by: 'alice', widgets: [widget('alerts_by_class')] });
    const s = buildDashboardWidgetCreatorMatrix('BIL', [d1, d2], NOW);
    expect(s.rows[0].created_by).toBe('alice');
    expect(s.rows[1].created_by).toBe('zoe');
  });
});

describe('M11.17 — widgets_without per row', () => {
  test('alice with only alerts_by_class → other 6 in widgets_without', () => {
    const d = dashboard({ widgets: [widget('alerts_by_class')] });
    const s = buildDashboardWidgetCreatorMatrix('BIL', [d], NOW);
    expect(s.rows[0].widget_types_without.length).toBe(6);
    expect(s.rows[0].widget_types_without).not.toContain('alerts_by_class');
  });
});

describe('M11.17 — per-column rollup', () => {
  test('alerts_by_class column counts across creators', () => {
    const d1 = dashboard({
      created_by: 'alice',
      widgets: [widget('alerts_by_class', 0), widget('alerts_by_class', 6)],
    });
    const d2 = dashboard({
      created_by: 'bob',
      widgets: [widget('alerts_by_class')],
    });
    const s = buildDashboardWidgetCreatorMatrix('BIL', [d1, d2], NOW);
    const col = s.columns.find((c) => c.widget_type === 'alerts_by_class')!;
    expect(col.total_instances).toBe(3);
    expect(col.distinct_creators).toBe(2);
    expect(col.top_creators[0]).toEqual({ created_by: 'alice', count: 2 });
    expect(col.top_creators[1]).toEqual({ created_by: 'bob', count: 1 });
  });

  test('top_creators canonical username asc at tied counts', () => {
    const d1 = dashboard({ created_by: 'zoe', widgets: [widget('open_cases')] });
    const d2 = dashboard({ created_by: 'alice', widgets: [widget('open_cases')] });
    const s = buildDashboardWidgetCreatorMatrix('BIL', [d1, d2], NOW);
    const col = s.columns.find((c) => c.widget_type === 'open_cases')!;
    expect(col.top_creators[0].created_by).toBe('alice');
  });

  test('top_creators cap 10', () => {
    const dashboards: CustomDashboard[] = [];
    for (let i = 0; i < 15; i++) {
      dashboards.push(
        dashboard({
          created_by: `user-${String(i).padStart(2, '0')}`,
          widgets: [widget('audit_recent')],
        }),
      );
    }
    const s = buildDashboardWidgetCreatorMatrix('BIL', dashboards, NOW);
    const col = s.columns.find((c) => c.widget_type === 'audit_recent')!;
    expect(col.distinct_creators).toBe(15);
    expect(col.top_creators.length).toBe(10);
  });
});

describe('M11.17 — peak_cell', () => {
  test('finds highest cell across matrix', () => {
    const d1 = dashboard({
      created_by: 'alice',
      widgets: [
        widget('alerts_by_class', 0),
        widget('alerts_by_class', 6),
      ],
    });
    const d2 = dashboard({
      created_by: 'alice',
      widgets: [widget('alerts_by_class')],
    });
    const d3 = dashboard({
      created_by: 'bob',
      widgets: [widget('open_cases')],
    });
    const s = buildDashboardWidgetCreatorMatrix('BIL', [d1, d2, d3], NOW);
    expect(s.peak_cell?.created_by).toBe('alice');
    expect(s.peak_cell?.widget_type).toBe('alerts_by_class');
    expect(s.peak_cell?.count).toBe(3);
  });

  test('null on empty', () => {
    const s = buildDashboardWidgetCreatorMatrix('BIL', [], NOW);
    expect(s.peak_cell).toBeNull();
  });
});

describe('M11.17 — most_versatile_creator', () => {
  test('creator with most distinct widget_types wins', () => {
    const d1 = dashboard({
      created_by: 'alice',
      widgets: [
        widget('alerts_by_class', 0),
        widget('open_cases', 6),
        widget('audit_recent', 0),
      ],
    });
    const d2 = dashboard({
      created_by: 'bob',
      widgets: [widget('alerts_by_class')],
    });
    const s = buildDashboardWidgetCreatorMatrix('BIL', [d1, d2], NOW);
    expect(s.most_versatile_creator).toBe('alice');
  });

  test('canonical username asc tie-break', () => {
    const d1 = dashboard({ created_by: 'zoe', widgets: [widget('alerts_by_class')] });
    const d2 = dashboard({ created_by: 'alice', widgets: [widget('open_cases')] });
    const s = buildDashboardWidgetCreatorMatrix('BIL', [d1, d2], NOW);
    expect(s.most_versatile_creator).toBe('alice');
  });

  test('null on empty', () => {
    const s = buildDashboardWidgetCreatorMatrix('BIL', [], NOW);
    expect(s.most_versatile_creator).toBeNull();
  });
});

describe('M11.17 — partition invariants', () => {
  test('Σ row.total_widgets = total_widgets', () => {
    const d1 = dashboard({
      created_by: 'alice',
      widgets: [widget('alerts_by_class', 0), widget('open_cases', 6)],
    });
    const d2 = dashboard({
      created_by: 'bob',
      widgets: [widget('audit_recent')],
    });
    const s = buildDashboardWidgetCreatorMatrix('BIL', [d1, d2], NOW);
    const sum = s.rows.reduce((acc, r) => acc + r.total_widgets, 0);
    expect(sum).toBe(s.total_widgets);
  });

  test('Σ row.by_widget_type = row.total_widgets per row', () => {
    const d = dashboard({
      created_by: 'alice',
      widgets: [widget('alerts_by_class', 0), widget('open_cases', 6)],
    });
    const s = buildDashboardWidgetCreatorMatrix('BIL', [d], NOW);
    const row = s.rows[0];
    const sum = WIDGET_TYPES.reduce((acc, w) => acc + row.by_widget_type[w], 0);
    expect(sum).toBe(row.total_widgets);
  });

  test('Σ col.total_instances = total_widgets', () => {
    const d1 = dashboard({
      created_by: 'alice',
      widgets: [widget('alerts_by_class', 0), widget('open_cases', 6)],
    });
    const s = buildDashboardWidgetCreatorMatrix('BIL', [d1], NOW);
    const sum = s.columns.reduce((acc, c) => acc + c.total_instances, 0);
    expect(sum).toBe(s.total_widgets);
  });

  test('cell cross-check: row[creator].by_widget_type[w] === col[w].top_creators[creator]', () => {
    const d = dashboard({
      created_by: 'alice',
      widgets: [
        widget('alerts_by_class', 0),
        widget('alerts_by_class', 6),
      ],
    });
    const s = buildDashboardWidgetCreatorMatrix('BIL', [d], NOW);
    const aliceRow = s.rows.find((r) => r.created_by === 'alice')!;
    const col = s.columns.find((c) => c.widget_type === 'alerts_by_class')!;
    const aliceTop = col.top_creators.find((t) => t.created_by === 'alice')!;
    expect(aliceRow.by_widget_type.alerts_by_class).toBe(aliceTop.count);
  });
});

describe('M11.17 — most_recent_at per row', () => {
  test('newest updated_at across creator\'s dashboards', () => {
    const d1 = dashboard({
      created_by: 'alice',
      updated_at: '2026-05-10T00:00:00.000Z',
    });
    const d2 = dashboard({
      created_by: 'alice',
      updated_at: '2026-05-15T00:00:00.000Z',
    });
    const s = buildDashboardWidgetCreatorMatrix('BIL', [d1, d2], NOW);
    expect(s.rows[0].most_recent_at).toBe('2026-05-15T00:00:00.000Z');
  });
});

describe('M11.17 — null created_by defensively skipped', () => {
  test('dashboard with empty created_by not counted', () => {
    const d1 = dashboard({ created_by: '' });
    const d2 = dashboard({ created_by: 'alice' });
    const s = buildDashboardWidgetCreatorMatrix('BIL', [d1, d2], NOW);
    expect(s.total_dashboards).toBe(1);
    expect(s.total_creators).toBe(1);
  });
});

describe('M11.17 — tenant_id + generated_at echo', () => {
  test('envelope echoes', () => {
    const s = buildDashboardWidgetCreatorMatrix('BIL', [], NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
  });
});

// ─── Route tests ─────────────────────────────────────────────────────

describe('M11.17 — GET /v1/dashboards/custom/widget-creator-matrix', () => {
  test('admin → 200 with empty store', async () => {
    const { app } = makeCmApp('admin');
    const r = await request(app)
      .get('/v1/dashboards/custom/widget-creator-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_dashboards).toBe(0);
    expect(r.body.body.columns.length).toBe(7);
  });

  test('populated → reflects dashboards', async () => {
    const { app, customDashboardStore } = makeCmApp('admin');
    customDashboardStore.create(
      'BIL',
      { name: 'Alice', widgets: [widget('alerts_by_class')] },
      'alice',
      NOW,
    );
    customDashboardStore.create(
      'BIL',
      { name: 'Bob', widgets: [widget('open_cases')] },
      'bob',
      NOW,
    );
    const r = await request(app)
      .get('/v1/dashboards/custom/widget-creator-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_widgets).toBe(2);
    expect(r.body.body.total_creators).toBe(2);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeCmApp('case_owner');
    const r = await request(app)
      .get('/v1/dashboards/custom/widget-creator-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant invisibility via HTTP', async () => {
    const { app, customDashboardStore } = makeCmApp('admin');
    customDashboardStore.create(
      'BIL',
      { name: 'BIL D', widgets: [widget('alerts_by_class')] },
      'alice',
      NOW,
    );
    const bankR = await request(app)
      .get('/v1/dashboards/custom/widget-creator-matrix')
      .set(TH_BANK);
    expect(bankR.status).toBe(200);
    expect(bankR.body.body.total_dashboards).toBe(0);
  });

  test('M11.15 /v1/dashboards/custom/authorship sibling regression still 200', async () => {
    const { app } = makeCmApp('admin');
    const r = await request(app)
      .get('/v1/dashboards/custom/authorship')
      .set(TH_BIL);
    expect(r.status).toBe(200);
  });

  test('literal `/widget-creator-matrix` not captured by `:dashboard_id` wildcard', async () => {
    const { app } = makeCmApp('admin');
    const r = await request(app)
      .get('/v1/dashboards/custom/widget-creator-matrix')
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.rows).toBeDefined();
  });
});
