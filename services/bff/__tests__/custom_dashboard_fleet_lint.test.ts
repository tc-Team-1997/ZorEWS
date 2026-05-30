// services/bff/__tests__/custom_dashboard_fleet_lint.test.ts
//
// T6 M11.14 — Custom dashboard fleet lint summary.

import request from 'supertest';
import { buildFleetLintSummary } from '../src/custom_dashboard_fleet_lint';
import {
  type CustomDashboard,
  type CustomDashboardStore,
} from '../src/custom_dashboards';
import { InMemoryCustomDashboardStore } from '../src/custom_dashboards';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-15T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function buildDashboard(
  dashboard_id: string,
  name: string,
  widgets: CustomDashboard['widgets'],
): CustomDashboard {
  return {
    dashboard_id,
    tenant_id: 'BIL',
    name,
    description: '',
    widgets,
    created_by: 'alice',
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    version: 1,
  };
}

class FakeStore implements CustomDashboardStore {
  constructor(private readonly items: CustomDashboard[]) {}
  list(tenant_id: string): CustomDashboard[] {
    return this.items.filter((d) => d.tenant_id === tenant_id);
  }
  get(tenant_id: string, dashboard_id: string): CustomDashboard | null {
    return this.list(tenant_id).find((d) => d.dashboard_id === dashboard_id) ?? null;
  }
  create(): CustomDashboard {
    throw new Error('not implemented in FakeStore');
  }
  replace(): CustomDashboard {
    throw new Error('not implemented in FakeStore');
  }
  delete(): boolean {
    return false;
  }
  restore(): boolean {
    // Phase 9 T3 — fleet-lint tests don't exercise restore; satisfy the
    // CustomDashboardStore interface with a no-op false return.
    return false;
  }
}

// Helpers — minimal widget shapes that exercise specific M11.10 issues.
const cleanWidget = () =>
  ({
    widget_type: 'alerts_by_class' as const,
    position: { row: 0, col: 0 },
    span: { rows: 4, cols: 6 },
    config: {},
  });

const overlappingWidget = () =>
  ({
    widget_type: 'risk_score_histogram' as const,
    position: { row: 0, col: 0 },
    span: { rows: 4, cols: 6 },
    config: {},
  });

const unknownWidget = () =>
  ({
    widget_type: 'not_a_real_widget' as unknown as 'alerts_by_class',
    position: { row: 0, col: 0 },
    span: { rows: 4, cols: 6 },
    config: {},
  });

const tallWidget = () =>
  ({
    widget_type: 'alerts_by_class' as const,
    position: { row: 0, col: 0 },
    span: { rows: 60, cols: 6 },
    config: {},
  });

// ─── buildFleetLintSummary — pure ────────────────────────────────────

describe('M11.14 — empty fleet', () => {
  test('zero dashboards → zero everything', () => {
    const store = new FakeStore([]);
    const s = buildFleetLintSummary(store, 'BIL', NOW);
    expect(s.tenant_id).toBe('BIL');
    expect(s.generated_at).toBe(NOW.toISOString());
    expect(s.total_dashboards).toBe(0);
    expect(s.passing_count).toBe(0);
    expect(s.failing_count).toBe(0);
    expect(s.with_warnings_count).toBe(0);
    expect(s.total_errors).toBe(0);
    expect(s.total_warnings).toBe(0);
    expect(s.total_infos).toBe(0);
    expect(s.dashboards).toEqual([]);
    expect(s.dashboards_with_errors).toEqual([]);
    expect(s.worst_dashboard).toBeNull();
  });
});

describe('M11.14 — clean dashboard', () => {
  test('passing dashboard counts toward passing_count', () => {
    const store = new FakeStore([buildDashboard('d1', 'Clean', [cleanWidget()])]);
    const s = buildFleetLintSummary(store, 'BIL', NOW);
    expect(s.total_dashboards).toBe(1);
    expect(s.passing_count).toBe(1);
    expect(s.failing_count).toBe(0);
    expect(s.total_errors).toBe(0);
    expect(s.worst_dashboard).toBeNull();
    expect(s.dashboards_with_errors).toEqual([]);
  });
});

describe('M11.14 — unknown widget type', () => {
  test('1 error bumps total_errors + by_issue_type.unknown_widget_type', () => {
    const store = new FakeStore([buildDashboard('d1', 'Broken', [unknownWidget()])]);
    const s = buildFleetLintSummary(store, 'BIL', NOW);
    expect(s.total_errors).toBeGreaterThan(0);
    expect(s.by_issue_type.unknown_widget_type).toBeGreaterThan(0);
    expect(s.failing_count).toBe(1);
    expect(s.worst_dashboard).not.toBeNull();
    expect(s.worst_dashboard!.dashboard_id).toBe('d1');
  });
});

describe('M11.14 — overlapping widgets error', () => {
  test('two overlapping widgets surface in by_issue_type', () => {
    const store = new FakeStore([
      buildDashboard('d1', 'Overlap', [cleanWidget(), overlappingWidget()]),
    ]);
    const s = buildFleetLintSummary(store, 'BIL', NOW);
    expect(s.by_issue_type.overlapping_widgets).toBeGreaterThan(0);
    expect(s.failing_count).toBe(1);
  });
});

describe('M11.14 — tall widget warning', () => {
  test('warning bumps total_warnings + with_warnings_count', () => {
    const store = new FakeStore([buildDashboard('d1', 'Tall', [tallWidget()])]);
    const s = buildFleetLintSummary(store, 'BIL', NOW);
    expect(s.by_issue_type.widget_extends_beyond_max_rows).toBeGreaterThan(0);
    expect(s.with_warnings_count).toBe(1);
    expect(s.total_warnings).toBeGreaterThan(0);
  });
});

describe('M11.14 — sort order', () => {
  test('dashboards sorted by errors_count desc with warnings_count desc tie-break', () => {
    const store = new FakeStore([
      buildDashboard('clean', 'Z-clean', [cleanWidget()]),
      buildDashboard('broken', 'Broken', [unknownWidget()]),
      buildDashboard('overlap', 'A-overlap', [cleanWidget(), overlappingWidget()]),
    ]);
    const s = buildFleetLintSummary(store, 'BIL', NOW);
    // Broken + overlap both have errors. clean has zero. So clean is last.
    const ids = s.dashboards.map((d) => d.dashboard_id);
    expect(ids[ids.length - 1]).toBe('clean');
  });
});

describe('M11.14 — passing_count + failing_count sum', () => {
  test('partition equals total_dashboards', () => {
    const store = new FakeStore([
      buildDashboard('d1', 'Clean', [cleanWidget()]),
      buildDashboard('d2', 'Broken', [unknownWidget()]),
      buildDashboard('d3', 'Tall', [tallWidget()]),
    ]);
    const s = buildFleetLintSummary(store, 'BIL', NOW);
    expect(s.passing_count + s.failing_count).toBe(s.total_dashboards);
  });
});

describe('M11.14 — by_issue_type has every key', () => {
  test('all 5 LintIssueType keys present even when zero', () => {
    const store = new FakeStore([buildDashboard('d1', 'Clean', [cleanWidget()])]);
    const s = buildFleetLintSummary(store, 'BIL', NOW);
    expect(s.by_issue_type).toHaveProperty('unknown_widget_type');
    expect(s.by_issue_type).toHaveProperty('overlapping_widgets');
    expect(s.by_issue_type).toHaveProperty('widget_extends_beyond_max_rows');
    expect(s.by_issue_type).toHaveProperty('unrecognized_config_key');
    expect(s.by_issue_type).toHaveProperty('empty_grid_region');
  });
});

describe('M11.14 — dashboards_with_errors filter', () => {
  test('only failing dashboards appear in the subset', () => {
    const store = new FakeStore([
      buildDashboard('d1', 'Clean', [cleanWidget()]),
      buildDashboard('d2', 'Broken', [unknownWidget()]),
    ]);
    const s = buildFleetLintSummary(store, 'BIL', NOW);
    expect(s.dashboards_with_errors.length).toBe(1);
    expect(s.dashboards_with_errors[0]!.dashboard_id).toBe('d2');
    for (const d of s.dashboards_with_errors) {
      expect(d.errors_count).toBeGreaterThan(0);
    }
  });
});

describe('M11.14 — worst_dashboard', () => {
  test('points at highest errors_count row', () => {
    const store = new FakeStore([
      buildDashboard('d1', 'OneError', [unknownWidget()]),
      buildDashboard('d2', 'TwoErrors', [unknownWidget(), unknownWidget()]),
    ]);
    const s = buildFleetLintSummary(store, 'BIL', NOW);
    // d2 has two widgets, both unknown → 2 errors. d1 has 1.
    expect(s.worst_dashboard!.dashboard_id).toBe('d2');
  });

  test('null when no failing dashboards', () => {
    const store = new FakeStore([buildDashboard('d1', 'Clean', [cleanWidget()])]);
    const s = buildFleetLintSummary(store, 'BIL', NOW);
    expect(s.worst_dashboard).toBeNull();
  });
});

describe('M11.14 — cross-tenant isolation', () => {
  test('BIL dashboards invisible to BANK_DEMO', () => {
    const store = new FakeStore([buildDashboard('d1', 'Broken', [unknownWidget()])]);
    const bank = buildFleetLintSummary(store, 'BANK_DEMO', NOW);
    expect(bank.total_dashboards).toBe(0);
    expect(bank.total_errors).toBe(0);
  });
});

// ─── GET /v1/dashboards/custom/fleet-lint ────────────────────────────

function makeFleetLintApp(role = 'admin') {
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

describe('M11.14 — GET /v1/dashboards/custom/fleet-lint', () => {
  test('admin → 200 with empty summary for fresh tenant', async () => {
    const { app } = makeFleetLintApp('admin');
    const r = await request(app).get('/v1/dashboards/custom/fleet-lint').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_dashboards).toBe(0);
    expect(r.body.body.worst_dashboard).toBeNull();
  });

  test('populated summary reflects stored dashboards', async () => {
    const { app, customDashboardStore } = makeFleetLintApp('admin');
    customDashboardStore.create(
      'BIL',
      { name: 'Clean', widgets: [cleanWidget()] },
      'alice',
      NOW,
    );
    const r = await request(app).get('/v1/dashboards/custom/fleet-lint').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_dashboards).toBe(1);
    expect(r.body.body.passing_count).toBe(1);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeFleetLintApp('case_owner');
    const r = await request(app).get('/v1/dashboards/custom/fleet-lint').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL dashboards invisible to BANK_DEMO via route', async () => {
    const { app, customDashboardStore } = makeFleetLintApp('admin');
    customDashboardStore.create(
      'BIL',
      { name: 'Clean', widgets: [cleanWidget()] },
      'alice',
      NOW,
    );
    const bank = await request(app)
      .get('/v1/dashboards/custom/fleet-lint')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_dashboards).toBe(0);
  });
});
