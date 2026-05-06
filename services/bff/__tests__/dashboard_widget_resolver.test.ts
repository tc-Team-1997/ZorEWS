// services/bff/__tests__/dashboard_widget_resolver.test.ts
//
// T6 M11.8 — dashboard widget data resolver.

import request from 'supertest';
import {
  WIDGET_TYPES,
  type DashboardWidget,
  InMemoryCustomDashboardStore,
} from '../src/custom_dashboards';
import {
  WidgetResolverError,
  resolveDashboard,
  resolveWidget,
} from '../src/dashboard_widget_resolver';
import { makeApp } from '../src/server';
import { StaticSource } from '../src/source';
import { StubEvaluator } from '../src/score';
import { StubRiskProfileSource } from '../src/risk_profile';
import { UnavailableCaseActionSink } from '../src/case_action';

const NOW = new Date('2026-05-06T10:00:00.000Z');
const TH_BIL = { 'X-Tenant-ID': 'BIL', 'X-Channel': 'API' };

function w(type: typeof WIDGET_TYPES[number], config: Record<string, unknown> = {}): DashboardWidget {
  return {
    widget_type: type,
    position: { row: 0, col: 0 },
    span: { rows: 2, cols: 6 },
    config,
  };
}

function makeApp_(role = 'admin') {
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

// ─── Pure resolver per widget_type ───────────────────────────────────

describe('M11.8 — resolveWidget per type', () => {
  test('risk_score_histogram: buckets sum to total_customers', () => {
    const out = resolveWidget('BIL', w('risk_score_histogram', { bucket_count: 10 }), NOW);
    if (out.widget_type !== 'risk_score_histogram') throw new Error('shape');
    expect(out.data.buckets.length).toBe(10);
    const sum = out.data.buckets.reduce((s, b) => s + b.count, 0);
    expect(sum).toBe(out.data.total_customers);
  });

  test('risk_score_histogram: vertical defaults to all', () => {
    const out = resolveWidget('BIL', w('risk_score_histogram'), NOW);
    if (out.widget_type !== 'risk_score_histogram') throw new Error('shape');
    expect(out.data.vertical).toBe('all');
  });

  test('alerts_by_class: sums to total', () => {
    const out = resolveWidget('BIL', w('alerts_by_class', { since_hours: 24 }), NOW);
    if (out.widget_type !== 'alerts_by_class') throw new Error('shape');
    expect(out.data.red + out.data.orange + out.data.yellow + out.data.green).toBe(out.data.total);
    expect(out.data.since_hours).toBe(24);
  });

  test('open_cases: respects limit', () => {
    const out = resolveWidget('BIL', w('open_cases', { limit: 5 }), NOW);
    if (out.widget_type !== 'open_cases') throw new Error('shape');
    expect(out.data.items).toHaveLength(5);
  });

  test('connector_health: fleet_status reflects degraded count', () => {
    const out = resolveWidget('BIL', w('connector_health', { show_paused: true }), NOW);
    if (out.widget_type !== 'connector_health') throw new Error('shape');
    expect(['healthy', 'degraded', 'down']).toContain(out.data.fleet_status);
  });

  test('connector_health: show_paused=false hides paused entries', () => {
    const out = resolveWidget('BIL', w('connector_health', { show_paused: false }), NOW);
    if (out.widget_type !== 'connector_health') throw new Error('shape');
    expect(out.data.connectors.every((c) => c.status !== 'paused')).toBe(true);
  });

  test('top_breaches: sorted worst-class first', () => {
    const out = resolveWidget('BIL', w('top_breaches', { limit: 8 }), NOW);
    if (out.widget_type !== 'top_breaches') throw new Error('shape');
    const order = { red: 0, orange: 1, yellow: 2, green: 3 };
    for (let i = 1; i < out.data.customers.length; i++) {
      expect(order[out.data.customers[i]!.worst_class]).toBeGreaterThanOrEqual(
        order[out.data.customers[i - 1]!.worst_class],
      );
    }
  });

  test('audit_recent: items decreasing by ts', () => {
    const out = resolveWidget('BIL', w('audit_recent', { limit: 10 }), NOW);
    if (out.widget_type !== 'audit_recent') throw new Error('shape');
    expect(out.data.items).toHaveLength(10);
    for (let i = 1; i < out.data.items.length; i++) {
      expect(out.data.items[i]!.ts <= out.data.items[i - 1]!.ts).toBe(true);
    }
  });

  test('tenant_kpi: delta_pct_vs_window in [-20, 20]', () => {
    const out = resolveWidget('BIL', w('tenant_kpi', { metric: 'customer_count' }), NOW);
    if (out.widget_type !== 'tenant_kpi') throw new Error('shape');
    expect(out.data.metric).toBe('customer_count');
    expect(out.data.delta_pct_vs_window).toBeGreaterThanOrEqual(-20);
    expect(out.data.delta_pct_vs_window).toBeLessThanOrEqual(20);
  });
});

// ─── Determinism + cross-tenant + cross-day ──────────────────────────

describe('M11.8 — determinism + isolation', () => {
  test('same (tenant, widget, config, day) → same payload', () => {
    const a = resolveWidget('BIL', w('alerts_by_class', { since_hours: 24 }), NOW);
    const b = resolveWidget('BIL', w('alerts_by_class', { since_hours: 24 }), NOW);
    expect(a).toEqual(b);
  });

  test('different tenant → different payload', () => {
    const a = resolveWidget('BIL', w('alerts_by_class', { since_hours: 24 }), NOW);
    const b = resolveWidget('BANK_DEMO', w('alerts_by_class', { since_hours: 24 }), NOW);
    expect(a).not.toEqual(b);
  });

  test('different config → different payload', () => {
    const a = resolveWidget('BIL', w('alerts_by_class', { since_hours: 24 }), NOW);
    const b = resolveWidget('BIL', w('alerts_by_class', { since_hours: 168 }), NOW);
    expect(a).not.toEqual(b);
  });

  test('different day → different payload (across midnight UTC)', () => {
    const tomorrow = new Date('2026-05-07T10:00:00.000Z');
    const a = resolveWidget('BIL', w('alerts_by_class'), NOW);
    const b = resolveWidget('BIL', w('alerts_by_class'), tomorrow);
    expect(a).not.toEqual(b);
  });
});

// ─── Errors ──────────────────────────────────────────────────────────

describe('M11.8 — resolveWidget errors', () => {
  test('unknown widget_type → unknown_widget_type', () => {
    try {
      resolveWidget('BIL', { ...w('alerts_by_class'), widget_type: 'iframe_embed' as never }, NOW);
      fail('expected throw');
    } catch (e) {
      expect((e as WidgetResolverError).code).toBe('unknown_widget_type');
    }
  });

  test('missing tenant_id → invalid_input', () => {
    expect(() => resolveWidget('', w('alerts_by_class'), NOW)).toThrow(/tenant_id/);
  });
});

// ─── resolveDashboard ────────────────────────────────────────────────

describe('M11.8 — resolveDashboard', () => {
  test('resolves every widget on the dashboard', () => {
    const dashboard = {
      dashboard_id: 'dsh-1',
      tenant_id: 'BIL',
      name: 'Ops daily',
      description: '',
      widgets: [
        w('alerts_by_class', { since_hours: 24 }),
        w('open_cases', { limit: 5 }),
        w('tenant_kpi', { metric: 'customer_count' }),
      ],
      created_by: 'admin',
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      version: 1,
    };
    const r = resolveDashboard(dashboard, NOW);
    expect(r.widgets).toHaveLength(3);
    expect(r.widgets[0]!.payload.widget_type).toBe('alerts_by_class');
    expect(r.widgets[1]!.payload.widget_type).toBe('open_cases');
    expect(r.widgets[2]!.payload.widget_type).toBe('tenant_kpi');
  });

  test('empty widgets array → empty payload list', () => {
    const r = resolveDashboard(
      {
        dashboard_id: 'dsh-x',
        tenant_id: 'BIL',
        name: 'empty',
        description: '',
        widgets: [],
        created_by: 'admin',
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
        version: 1,
      },
      NOW,
    );
    expect(r.widgets).toEqual([]);
  });
});

// ─── Routes ──────────────────────────────────────────────────────────

describe('M11.8 — POST /v1/dashboards/widgets/resolve', () => {
  test('happy: returns resolved payload', async () => {
    const { app } = makeApp_('admin');
    const r = await request(app)
      .post('/v1/dashboards/widgets/resolve')
      .set(TH_BIL)
      .send(w('alerts_by_class', { since_hours: 24 }));
    expect(r.status).toBe(200);
    expect(r.body.body.widget_type).toBe('alerts_by_class');
    expect(r.body.body.data.total).toBeGreaterThanOrEqual(0);
  });

  test('missing widget_type → 400', async () => {
    const { app } = makeApp_('admin');
    const r = await request(app)
      .post('/v1/dashboards/widgets/resolve')
      .set(TH_BIL)
      .send({ position: { row: 0, col: 0 }, span: { rows: 1, cols: 6 } });
    expect(r.status).toBe(400);
  });

  test('unknown widget_type → 400 unknown_widget_type', async () => {
    const { app } = makeApp_('admin');
    const r = await request(app)
      .post('/v1/dashboards/widgets/resolve')
      .set(TH_BIL)
      .send({ ...w('alerts_by_class'), widget_type: 'iframe_embed' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('EWS_400_unknown_widget_type');
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeApp_('case_owner');
    const r = await request(app)
      .post('/v1/dashboards/widgets/resolve')
      .set(TH_BIL)
      .send(w('alerts_by_class'));
    expect(r.status).toBe(403);
  });
});

describe('M11.8 — POST /v1/dashboards/custom/:id/resolve', () => {
  async function seedDashboard(app: Parameters<typeof request>[0]) {
    const r = await request(app)
      .post('/v1/dashboards/custom')
      .set(TH_BIL)
      .send({
        name: 'Resolver test',
        description: 'd',
        widgets: [
          w('alerts_by_class', { since_hours: 24 }),
          { ...w('open_cases', { limit: 3 }), position: { row: 0, col: 6 } },
        ],
      });
    return r.body.body.dashboard_id as string;
  }

  test('happy: resolves all widgets in saved dashboard', async () => {
    const { app } = makeApp_('admin');
    const id = await seedDashboard(app);
    const r = await request(app)
      .post(`/v1/dashboards/custom/${id}/resolve`)
      .set(TH_BIL);
    expect(r.status).toBe(200);
    expect(r.body.body.dashboard_id).toBe(id);
    expect(r.body.body.widgets).toHaveLength(2);
    expect(r.body.body.widgets[0].payload.widget_type).toBe('alerts_by_class');
    expect(r.body.body.widgets[1].payload.widget_type).toBe('open_cases');
  });

  test('unknown dashboard → 404', async () => {
    const { app } = makeApp_('admin');
    const r = await request(app)
      .post('/v1/dashboards/custom/dsh-nope/resolve')
      .set(TH_BIL);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('EWS_404_unknown_dashboard');
  });

  test('cross-tenant: BANK_DEMO cannot resolve BIL dashboard', async () => {
    const { app } = makeApp_('admin');
    const id = await seedDashboard(app);
    const r = await request(app)
      .post(`/v1/dashboards/custom/${id}/resolve`)
      .set('X-Tenant-ID', 'BANK_DEMO')
      .set('X-Channel', 'API');
    expect(r.status).toBe(404);
  });

  test('non-allowed role → 403', async () => {
    const { app } = makeApp_('case_owner');
    const r = await request(app)
      .post('/v1/dashboards/custom/anything/resolve')
      .set(TH_BIL);
    expect(r.status).toBe(403);
  });

  test('M11.7 single dashboard GET still works (literal /resolve no shadow)', async () => {
    const { app } = makeApp_('admin');
    const id = await seedDashboard(app);
    const g = await request(app).get(`/v1/dashboards/custom/${id}`).set(TH_BIL);
    expect(g.status).toBe(200);
    expect(g.body.body.dashboard_id).toBe(id);
  });
});
