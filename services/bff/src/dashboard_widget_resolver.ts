// services/bff/src/dashboard_widget_resolver.ts
//
// T6 M11.8 — Custom dashboard widget data resolver.
//
// M11.7 shipped the layout builder; the SPA could render widget
// SHELLS but each widget then had to call its own backend route to
// fill itself (7 routes for 12 widgets = up to 12 round-trips per
// dashboard load). M11.8 closes the loop with a single route that
// resolves every widget on a dashboard in one shot.
//
// Design:
//  - Pure-function resolver per widget_type. Each takes
//    (tenant_id, widget, now) and returns a typed payload.
//  - Deterministic synth via FNV-1a + Mulberry32 seeded by
//    (tenant, widget_type, config-hash, day) — same pattern as
//    M14 adapters. SPA renders the same numbers within a day.
//  - Cross-tenant isolation: every resolver derives its seed from
//    `tenant_id` so BIL and BANK_DEMO see different but stable
//    numbers.
//  - resolver() is a single dispatch entry that routes to the
//    right per-widget-type function. Keeps the route handler thin.

import {
  type DashboardWidget,
  type CustomDashboard,
  WIDGET_TYPES,
  type WidgetType,
} from './custom_dashboards';

// ─── Public types per widget_type ────────────────────────────────────

export interface RiskScoreHistogramPayload {
  buckets: Array<{ from: number; to: number; count: number }>;
  total_customers: number;
  vertical: 'banking' | 'insurance' | 'all';
}

export interface AlertsByClassPayload {
  red: number;
  orange: number;
  yellow: number;
  green: number;
  total: number;
  since_hours: number;
}

export interface OpenCasesPayload {
  items: Array<{
    case_id: string;
    customer_id: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    sla_progress_pct: number;
    age_hours: number;
  }>;
  total: number;
}

export interface ConnectorHealthPayload {
  connectors: Array<{
    connector_id: string;
    status: 'healthy' | 'degraded' | 'down' | 'paused';
    last_run_at: string;
    success_rate_pct: number;
  }>;
  fleet_status: 'healthy' | 'degraded' | 'down';
}

export interface TopBreachesPayload {
  customers: Array<{
    customer_id: string;
    red_count: number;
    orange_count: number;
    worst_class: 'red' | 'orange' | 'yellow' | 'green';
  }>;
}

export interface AuditRecentPayload {
  items: Array<{
    event_id: string;
    ts: string;
    actor_username: string;
    action: string;
    resource_id: string;
    severity: 'info' | 'warning' | 'critical';
  }>;
  total: number;
}

export interface TenantKpiPayload {
  metric: string;
  value: number;
  unit: string;
  delta_pct_vs_window: number;
  window: string;
}

export type WidgetPayload =
  | { widget_type: 'risk_score_histogram'; data: RiskScoreHistogramPayload }
  | { widget_type: 'alerts_by_class'; data: AlertsByClassPayload }
  | { widget_type: 'open_cases'; data: OpenCasesPayload }
  | { widget_type: 'connector_health'; data: ConnectorHealthPayload }
  | { widget_type: 'top_breaches'; data: TopBreachesPayload }
  | { widget_type: 'audit_recent'; data: AuditRecentPayload }
  | { widget_type: 'tenant_kpi'; data: TenantKpiPayload };

export interface ResolvedWidget {
  widget: DashboardWidget;
  payload: WidgetPayload;
  /** Wall-clock cost — exposed for SPA perf monitoring. */
  resolved_at: string;
}

export interface ResolvedDashboard {
  dashboard_id: string;
  tenant_id: string;
  resolved_at: string;
  widgets: ResolvedWidget[];
}

export class WidgetResolverError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'WidgetResolverError';
  }
}

// ─── Deterministic PRNG (FNV-1a + Mulberry32) ────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a widget's config object into a stable string for seeding. */
function configHash(config: Record<string, unknown>): string {
  const keys = Object.keys(config).sort();
  return keys.map((k) => `${k}=${JSON.stringify(config[k])}`).join('|');
}

/** Build the per-widget seed used by every synth. */
function widgetSeed(
  tenant_id: string,
  widget_type: WidgetType,
  config: Record<string, unknown>,
  day: string,
): number {
  return fnv1a(`m11.8|${tenant_id}|${widget_type}|${configHash(config)}|${day}`);
}

function dayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// ─── Per-widget-type resolvers ───────────────────────────────────────

function resolveRiskScoreHistogram(
  tenant_id: string,
  widget: DashboardWidget,
  now: Date,
): RiskScoreHistogramPayload {
  const r = rng(widgetSeed(tenant_id, 'risk_score_histogram', widget.config, dayOf(now)));
  const bucketCount = Math.min(20, Math.max(3, Number(widget.config.bucket_count) || 10));
  const total = 800 + Math.floor(r() * 200); // ~800-1000 customers
  const vertical =
    widget.config.vertical === 'banking' || widget.config.vertical === 'insurance'
      ? widget.config.vertical
      : 'all';
  // Approx normal-ish distribution: peak near the middle bucket.
  const peakIdx = Math.floor(bucketCount / 2);
  const buckets: Array<{ from: number; to: number; count: number }> = [];
  let assigned = 0;
  for (let i = 0; i < bucketCount; i++) {
    const dist = Math.abs(i - peakIdx);
    const weight = Math.max(1, bucketCount - dist * 2);
    const noise = 0.6 + r() * 0.8;
    const count = Math.floor((total / bucketCount) * (weight / bucketCount) * 4 * noise);
    buckets.push({
      from: Math.round((i / bucketCount) * 100),
      to: Math.round(((i + 1) / bucketCount) * 100),
      count,
    });
    assigned += count;
  }
  // Reconcile against `total_customers` so the buckets sum exactly to total.
  buckets[peakIdx]!.count += total - assigned;
  return { buckets, total_customers: total, vertical };
}

function resolveAlertsByClass(
  tenant_id: string,
  widget: DashboardWidget,
  now: Date,
): AlertsByClassPayload {
  const since_hours = Math.min(720, Math.max(1, Number(widget.config.since_hours) || 24));
  const r = rng(widgetSeed(tenant_id, 'alerts_by_class', widget.config, dayOf(now)));
  const red = Math.floor(r() * 10);
  const orange = Math.floor(r() * 30);
  const yellow = Math.floor(r() * 60);
  const green = Math.floor(r() * 200);
  return { red, orange, yellow, green, total: red + orange + yellow + green, since_hours };
}

function resolveOpenCases(
  tenant_id: string,
  widget: DashboardWidget,
  now: Date,
): OpenCasesPayload {
  const limit = Math.min(50, Math.max(1, Number(widget.config.limit) || 10));
  const r = rng(widgetSeed(tenant_id, 'open_cases', widget.config, dayOf(now)));
  const severities: Array<'critical' | 'high' | 'medium' | 'low'> = [
    'critical', 'high', 'medium', 'low',
  ];
  const items: OpenCasesPayload['items'] = [];
  for (let i = 0; i < limit; i++) {
    const sevIdx = Math.floor(r() * severities.length);
    items.push({
      case_id: `CAS-${tenant_id}-${String(i + 1).padStart(4, '0')}`,
      customer_id: `cust-${String(Math.floor(r() * 9999)).padStart(4, '0')}`,
      severity: severities[sevIdx]!,
      sla_progress_pct: Math.floor(r() * 100),
      age_hours: Math.floor(r() * 96),
    });
  }
  return { items, total: items.length };
}

function resolveConnectorHealth(
  tenant_id: string,
  widget: DashboardWidget,
  now: Date,
): ConnectorHealthPayload {
  const r = rng(widgetSeed(tenant_id, 'connector_health', widget.config, dayOf(now)));
  const ids = [
    'cbs_loan_book',
    'core_insurance_policy_master',
    'claims_master',
    'agent_master',
    'aml_watchlist',
    'bureau_cibil',
    'ifrs9_stages',
  ];
  const showPaused = widget.config.show_paused === true;
  const statuses: Array<'healthy' | 'degraded' | 'down' | 'paused'> = [
    'healthy', 'healthy', 'healthy', 'healthy', 'degraded', 'down', 'paused',
  ];
  const out: ConnectorHealthPayload['connectors'] = [];
  let degradedOrDown = 0;
  for (const id of ids) {
    const s = statuses[Math.floor(r() * statuses.length)]!;
    if (s === 'paused' && !showPaused) continue;
    if (s === 'degraded' || s === 'down') degradedOrDown += 1;
    out.push({
      connector_id: id,
      status: s,
      last_run_at: new Date(now.getTime() - Math.floor(r() * 6 * 3_600_000)).toISOString(),
      success_rate_pct: Math.floor(60 + r() * 40),
    });
  }
  const fleet_status: 'healthy' | 'degraded' | 'down' =
    degradedOrDown === 0 ? 'healthy' : degradedOrDown >= 3 ? 'down' : 'degraded';
  return { connectors: out, fleet_status };
}

function resolveTopBreaches(
  tenant_id: string,
  widget: DashboardWidget,
  now: Date,
): TopBreachesPayload {
  const limit = Math.min(50, Math.max(1, Number(widget.config.limit) || 10));
  const r = rng(widgetSeed(tenant_id, 'top_breaches', widget.config, dayOf(now)));
  const items: TopBreachesPayload['customers'] = [];
  for (let i = 0; i < limit; i++) {
    const red_count = Math.floor(r() * 6);
    const orange_count = Math.floor(r() * 8);
    const worst_class: 'red' | 'orange' | 'yellow' | 'green' =
      red_count > 0 ? 'red' : orange_count > 0 ? 'orange' : r() > 0.5 ? 'yellow' : 'green';
    items.push({
      customer_id: `cust-${tenant_id}-${String(i + 1).padStart(4, '0')}`,
      red_count,
      orange_count,
      worst_class,
    });
  }
  // Sort: worst-class first.
  const order = { red: 0, orange: 1, yellow: 2, green: 3 };
  items.sort((a, b) => order[a.worst_class] - order[b.worst_class]);
  return { customers: items };
}

function resolveAuditRecent(
  tenant_id: string,
  widget: DashboardWidget,
  now: Date,
): AuditRecentPayload {
  const limit = Math.min(50, Math.max(1, Number(widget.config.limit) || 20));
  const r = rng(widgetSeed(tenant_id, 'audit_recent', widget.config, dayOf(now)));
  const actions = [
    'rule.create',
    'rule.update',
    'rule.activate',
    'config.update',
    'scenario.update',
    'login.success',
    'login.failure',
  ];
  const actors = ['compliance.lead', 'admin', 'risk.analyst', 'fraud.officer'];
  const severities: Array<'info' | 'warning' | 'critical'> = ['info', 'info', 'warning', 'critical'];
  const items: AuditRecentPayload['items'] = [];
  for (let i = 0; i < limit; i++) {
    items.push({
      event_id: `evt-${tenant_id}-${i}`,
      ts: new Date(now.getTime() - i * 7 * 60_000).toISOString(),
      actor_username: actors[Math.floor(r() * actors.length)]!,
      action: actions[Math.floor(r() * actions.length)]!,
      resource_id: `res-${Math.floor(r() * 9999)}`,
      severity: severities[Math.floor(r() * severities.length)]!,
    });
  }
  return { items, total: items.length };
}

function resolveTenantKpi(
  tenant_id: string,
  widget: DashboardWidget,
  now: Date,
): TenantKpiPayload {
  const metric = typeof widget.config.metric === 'string' ? widget.config.metric : 'customer_count';
  const window =
    typeof widget.config.comparison_window === 'string'
      ? widget.config.comparison_window
      : '7d';
  const r = rng(widgetSeed(tenant_id, 'tenant_kpi', widget.config, dayOf(now)));
  const base = metric === 'customer_count'
    ? 8000 + Math.floor(r() * 4000)
    : metric === 'alert_count_24h'
      ? 30 + Math.floor(r() * 80)
      : 100 + Math.floor(r() * 200);
  return {
    metric,
    value: base,
    unit: metric === 'customer_count' ? 'count' : metric.includes('count') ? 'count' : 'units',
    delta_pct_vs_window: Math.round((r() * 40 - 20) * 10) / 10, // -20%..+20%
    window,
  };
}

// ─── Dispatcher ──────────────────────────────────────────────────────

export function resolveWidget(
  tenant_id: string,
  widget: DashboardWidget,
  now: Date,
): WidgetPayload {
  if (!tenant_id || !tenant_id.trim()) {
    throw new WidgetResolverError('invalid_input', 'tenant_id required');
  }
  if (!widget || typeof widget !== 'object') {
    throw new WidgetResolverError('invalid_input', 'widget required');
  }
  if (!(WIDGET_TYPES as readonly string[]).includes(widget.widget_type)) {
    throw new WidgetResolverError(
      'unknown_widget_type',
      `widget_type ${widget.widget_type} not in WIDGET_TYPES`,
    );
  }
  switch (widget.widget_type) {
    case 'risk_score_histogram':
      return { widget_type: 'risk_score_histogram', data: resolveRiskScoreHistogram(tenant_id, widget, now) };
    case 'alerts_by_class':
      return { widget_type: 'alerts_by_class', data: resolveAlertsByClass(tenant_id, widget, now) };
    case 'open_cases':
      return { widget_type: 'open_cases', data: resolveOpenCases(tenant_id, widget, now) };
    case 'connector_health':
      return { widget_type: 'connector_health', data: resolveConnectorHealth(tenant_id, widget, now) };
    case 'top_breaches':
      return { widget_type: 'top_breaches', data: resolveTopBreaches(tenant_id, widget, now) };
    case 'audit_recent':
      return { widget_type: 'audit_recent', data: resolveAuditRecent(tenant_id, widget, now) };
    case 'tenant_kpi':
      return { widget_type: 'tenant_kpi', data: resolveTenantKpi(tenant_id, widget, now) };
    default: {
      const _exhaustive: never = widget.widget_type;
      throw new WidgetResolverError('unknown_widget_type', `unhandled widget_type ${_exhaustive as string}`);
    }
  }
}

/** Resolve every widget on a dashboard in one shot. */
export function resolveDashboard(
  dashboard: CustomDashboard,
  now: Date,
): ResolvedDashboard {
  const widgets: ResolvedWidget[] = dashboard.widgets.map((w) => ({
    widget: w,
    payload: resolveWidget(dashboard.tenant_id, w, now),
    resolved_at: now.toISOString(),
  }));
  return {
    dashboard_id: dashboard.dashboard_id,
    tenant_id: dashboard.tenant_id,
    resolved_at: now.toISOString(),
    widgets,
  };
}
