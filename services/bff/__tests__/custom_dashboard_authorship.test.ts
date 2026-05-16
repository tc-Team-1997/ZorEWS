// services/bff/__tests__/custom_dashboard_authorship.test.ts
//
// T6 M11.15 — Custom dashboard authorship rollup.

import request from 'supertest';
import { summarizeDashboardAuthorship } from '../src/custom_dashboard_authorship';
import {
  InMemoryCustomDashboardStore,
  type CustomDashboard,
} from '../src/custom_dashboards';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-16T12:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

const widget = (widget_type: string, col = 0) => ({
  widget_type: widget_type as 'alerts_by_class',
  position: { row: 0, col },
  span: { rows: 2, cols: 6 },
  config: {},
});

function dashboard(overrides: Partial<CustomDashboard> = {}): CustomDashboard {
  return {
    dashboard_id: 'd-1',
    tenant_id: 'BIL',
    name: 'test',
    description: '',
    widgets: [widget('alerts_by_class')],
    created_by: 'alice',
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    version: 1,
    ...overrides,
  };
}

function makeAuthApp(role: string = 'admin') {
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

// ─── summarizeDashboardAuthorship — pure ─────────────────────────────

describe('M11.15 — empty input', () => {
  test('zero dashboards → empty envelope', () => {
    const s = summarizeDashboardAuthorship('BIL', [], NOW);
    expect(s.total_authors).toBe(0);
    expect(s.total_dashboards).toBe(0);
    expect(s.total_widgets_across_fleet).toBe(0);
    expect(s.authors).toEqual([]);
    expect(s.most_prolific_author).toBeNull();
    expect(s.most_widgets_author).toBeNull();
  });
});

describe('M11.15 — single author single dashboard', () => {
  test('1 dashboard → 1 row with dashboard_count=1', () => {
    const d = dashboard({ dashboard_id: 'd-1', created_by: 'alice', widgets: [widget('alerts_by_class'), widget('open_cases', 6)] });
    const s = summarizeDashboardAuthorship('BIL', [d], NOW);
    expect(s.total_authors).toBe(1);
    expect(s.authors[0]!.created_by).toBe('alice');
    expect(s.authors[0]!.dashboard_count).toBe(1);
    expect(s.authors[0]!.total_widgets).toBe(2);
    expect(s.authors[0]!.distinct_widget_types).toBe(2);
    expect(s.authors[0]!.dashboard_ids).toEqual(['d-1']);
  });
});

describe('M11.15 — multi-author cohort', () => {
  test('3 authors with varying dashboard counts', () => {
    const ds: CustomDashboard[] = [
      dashboard({ dashboard_id: 'd1', created_by: 'alice' }),
      dashboard({ dashboard_id: 'd2', created_by: 'alice' }),
      dashboard({ dashboard_id: 'd3', created_by: 'bob' }),
      dashboard({ dashboard_id: 'd4', created_by: 'carol' }),
      dashboard({ dashboard_id: 'd5', created_by: 'carol' }),
      dashboard({ dashboard_id: 'd6', created_by: 'carol' }),
    ];
    const s = summarizeDashboardAuthorship('BIL', ds, NOW);
    expect(s.total_authors).toBe(3);
    expect(s.total_dashboards).toBe(6);
    const byAuthor = Object.fromEntries(s.authors.map((r) => [r.created_by, r]));
    expect(byAuthor['alice']!.dashboard_count).toBe(2);
    expect(byAuthor['bob']!.dashboard_count).toBe(1);
    expect(byAuthor['carol']!.dashboard_count).toBe(3);
  });
});

describe('M11.15 — total_widgets sum invariant', () => {
  test('Σ author.total_widgets = total_widgets_across_fleet', () => {
    const ds: CustomDashboard[] = [
      dashboard({ dashboard_id: 'd1', created_by: 'a', widgets: [widget('alerts_by_class'), widget('open_cases', 6)] }),
      dashboard({ dashboard_id: 'd2', created_by: 'b', widgets: [widget('audit_recent')] }),
    ];
    const s = summarizeDashboardAuthorship('BIL', ds, NOW);
    const sum = s.authors.reduce((acc, r) => acc + r.total_widgets, 0);
    expect(sum).toBe(s.total_widgets_across_fleet);
    expect(s.total_widgets_across_fleet).toBe(3);
  });
});

describe('M11.15 — distinct_widget_types dedup', () => {
  test('same widget_type across dashboards counts once per author', () => {
    const ds: CustomDashboard[] = [
      dashboard({ dashboard_id: 'd1', created_by: 'alice', widgets: [widget('alerts_by_class'), widget('alerts_by_class', 6)] }),
      dashboard({ dashboard_id: 'd2', created_by: 'alice', widgets: [widget('alerts_by_class'), widget('open_cases', 6)] }),
    ];
    const s = summarizeDashboardAuthorship('BIL', ds, NOW);
    expect(s.authors[0]!.distinct_widget_types).toBe(2);
  });
});

describe('M11.15 — sort order', () => {
  test('authors sorted dashboard_count desc + created_by asc tie-break', () => {
    const ds: CustomDashboard[] = [
      dashboard({ dashboard_id: 'd1', created_by: 'zoe' }),
      dashboard({ dashboard_id: 'd2', created_by: 'alice' }),
      dashboard({ dashboard_id: 'd3', created_by: 'alice' }),
      dashboard({ dashboard_id: 'd4', created_by: 'bob' }),
      dashboard({ dashboard_id: 'd5', created_by: 'bob' }),
    ];
    const s = summarizeDashboardAuthorship('BIL', ds, NOW);
    // alice + bob both at 2 → alice wins canonical; zoe at 1 last.
    expect(s.authors.map((r) => r.created_by)).toEqual(['alice', 'bob', 'zoe']);
  });
});

describe('M11.15 — dashboard_ids sorted asc per author', () => {
  test('per-author dashboard_ids sorted asc regardless of input order', () => {
    const ds: CustomDashboard[] = [
      dashboard({ dashboard_id: 'z-1', created_by: 'alice' }),
      dashboard({ dashboard_id: 'a-1', created_by: 'alice' }),
      dashboard({ dashboard_id: 'm-1', created_by: 'alice' }),
    ];
    const s = summarizeDashboardAuthorship('BIL', ds, NOW);
    expect(s.authors[0]!.dashboard_ids).toEqual(['a-1', 'm-1', 'z-1']);
  });
});

describe('M11.15 — most_recent_at = max across author dashboards', () => {
  test('most_recent_created_at / updated_at take newest', () => {
    const t1 = new Date(NOW.getTime() - 10 * 86400_000).toISOString();
    const t2 = new Date(NOW.getTime() - 3 * 86400_000).toISOString();
    const ds: CustomDashboard[] = [
      dashboard({ dashboard_id: 'd1', created_by: 'alice', created_at: t1, updated_at: t1 }),
      dashboard({ dashboard_id: 'd2', created_by: 'alice', created_at: t2, updated_at: t2 }),
    ];
    const s = summarizeDashboardAuthorship('BIL', ds, NOW);
    expect(s.authors[0]!.most_recent_created_at).toBe(t2);
    expect(s.authors[0]!.most_recent_updated_at).toBe(t2);
  });
});

describe('M11.15 — most_prolific_author', () => {
  test('points at top row of authors[]', () => {
    const ds: CustomDashboard[] = [
      dashboard({ dashboard_id: 'd1', created_by: 'alice' }),
      dashboard({ dashboard_id: 'd2', created_by: 'bob' }),
      dashboard({ dashboard_id: 'd3', created_by: 'bob' }),
      dashboard({ dashboard_id: 'd4', created_by: 'bob' }),
    ];
    const s = summarizeDashboardAuthorship('BIL', ds, NOW);
    expect(s.most_prolific_author!.created_by).toBe('bob');
    expect(s.most_prolific_author!.dashboard_count).toBe(3);
  });

  test('null when no dashboards', () => {
    const s = summarizeDashboardAuthorship('BIL', [], NOW);
    expect(s.most_prolific_author).toBeNull();
  });
});

describe('M11.15 — most_widgets_author', () => {
  test('points at author with highest total_widgets (not necessarily most prolific)', () => {
    const ds: CustomDashboard[] = [
      // alice: 3 dashboards × 1 widget each = 3 widgets
      dashboard({ dashboard_id: 'd1', created_by: 'alice' }),
      dashboard({ dashboard_id: 'd2', created_by: 'alice' }),
      dashboard({ dashboard_id: 'd3', created_by: 'alice' }),
      // bob: 1 dashboard × 5 widgets = 5 widgets
      dashboard({
        dashboard_id: 'd4',
        created_by: 'bob',
        widgets: [
          widget('alerts_by_class'),
          widget('open_cases', 6),
          widget('connector_health', 12),
          widget('audit_recent', 0),
          widget('top_breaches', 6),
        ],
      }),
    ];
    const s = summarizeDashboardAuthorship('BIL', ds, NOW);
    expect(s.most_prolific_author!.created_by).toBe('alice'); // 3 dashboards
    expect(s.most_widgets_author!.created_by).toBe('bob');    // 5 widgets
    expect(s.most_widgets_author!.total_widgets).toBe(5);
  });

  test('canonical tie-break: alphabetical when total_widgets ties', () => {
    const ds: CustomDashboard[] = [
      dashboard({ dashboard_id: 'd1', created_by: 'zoe' }),
      dashboard({ dashboard_id: 'd2', created_by: 'alice' }),
    ];
    const s = summarizeDashboardAuthorship('BIL', ds, NOW);
    // Both at 1 widget → alice wins canonical.
    expect(s.most_widgets_author!.created_by).toBe('alice');
  });

  test('null when no dashboards', () => {
    const s = summarizeDashboardAuthorship('BIL', [], NOW);
    expect(s.most_widgets_author).toBeNull();
  });
});

describe('M11.15 — tenant_id echoed', () => {
  test('envelope carries tenant_id passed by caller', () => {
    const s = summarizeDashboardAuthorship('BANK_DEMO', [], NOW);
    expect(s.tenant_id).toBe('BANK_DEMO');
  });
});

// ─── GET /v1/dashboards/custom/authorship ────────────────────────────

describe('M11.15 — GET /v1/dashboards/custom/authorship', () => {
  test('admin → 200 with empty rollup on fresh tenant', async () => {
    const { app } = makeAuthApp('admin');
    const r = await request(app).get('/v1/dashboards/custom/authorship').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_authors).toBe(0);
    expect(r.body.body.authors).toEqual([]);
    expect(r.body.body.most_prolific_author).toBeNull();
  });

  test('populated rollup reflects created dashboards', async () => {
    const { app, customDashboardStore } = makeAuthApp('admin');
    customDashboardStore.create(
      'BIL',
      { name: 'Alice 1', widgets: [widget('alerts_by_class')] },
      'alice',
      NOW,
    );
    customDashboardStore.create(
      'BIL',
      { name: 'Alice 2', widgets: [widget('open_cases')] },
      'alice',
      NOW,
    );
    customDashboardStore.create(
      'BIL',
      { name: 'Bob 1', widgets: [widget('audit_recent')] },
      'bob',
      NOW,
    );
    const r = await request(app).get('/v1/dashboards/custom/authorship').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.total_authors).toBe(2);
    expect(r.body.body.total_dashboards).toBe(3);
    expect(r.body.body.most_prolific_author.created_by).toBe('alice');
    expect(r.body.body.most_prolific_author.dashboard_count).toBe(2);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeAuthApp('case_owner');
    const r = await request(app).get('/v1/dashboards/custom/authorship').set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('cross-tenant: BIL dashboards invisible to BANK_DEMO', async () => {
    const { app, customDashboardStore } = makeAuthApp('admin');
    customDashboardStore.create(
      'BIL',
      { name: 'Bil only', widgets: [widget('alerts_by_class')] },
      'alice',
      NOW,
    );
    const bank = await request(app)
      .get('/v1/dashboards/custom/authorship')
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(bank.status).toBe(200);
    expect(bank.body.body.total_authors).toBe(0);
  });

  test('literal /authorship not captured by :dashboard_id wildcard', async () => {
    const { app } = makeAuthApp('admin');
    const r = await request(app).get('/v1/dashboards/custom/authorship').set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.tenant_id).toBe('BIL');
  });

  test('M11.14 /v1/dashboards/custom/fleet-lint still works (sibling regression)', async () => {
    const { app } = makeAuthApp('admin');
    const r = await request(app).get('/v1/dashboards/custom/fleet-lint').set(TH_BIL);
    expect(r.status).toBe(200);
  });
});
