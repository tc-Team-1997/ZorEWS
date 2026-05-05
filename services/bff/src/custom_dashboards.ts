// services/bff/src/custom_dashboards.ts
//
// T6 M11.7 — Custom dashboard builder.
//
// Operator-authored dashboard layouts. M11.1-M11.6 ship the
// platform-static dashboards (Claims, Underwriting, Agent,
// Operational, Executive, per-customer-360). M11.7 lets a tenant
// operator pick from a fixed widget catalog and lay them out on
// a 12-column grid, save the layout under a name, and have the
// SPA render that exact layout.
//
// Design:
//  - The widget CATALOG is platform-static — operators don't get
//    to define new widget types, only choose from the 7 we ship.
//    Each catalog entry declares default span (rows × cols) and
//    a recommended config schema; the dashboard layout snapshots
//    a position + caller-overridden config.
//  - Layout validation: non-overlapping rectangles on a 12-col
//    grid (rows are unbounded — operators scroll). Catches the
//    classic "two widgets stacked at row=0,col=0" bug at save
//    time, not at render time.
//  - Per-tenant cap of 10 dashboards (operator-managed dashboards
//    are a small set; production swap can lift this).
//  - Per-dashboard cap of 12 widgets. Empty dashboards are
//    rejected — saving an empty layout is almost certainly a UX
//    bug, not intent.

import { randomUUID } from 'node:crypto';

// ─── Widget catalog ──────────────────────────────────────────────────

export const WIDGET_TYPES = [
  'risk_score_histogram',
  'alerts_by_class',
  'open_cases',
  'connector_health',
  'top_breaches',
  'audit_recent',
  'tenant_kpi',
] as const;

export type WidgetType = (typeof WIDGET_TYPES)[number];

export interface WidgetCatalogEntry {
  widget_type: WidgetType;
  display_name: string;
  description: string;
  default_span: { rows: number; cols: number };
  /** Allowed config keys + their JSON-Schema-ish hints. The widget
   *  store only validates that supplied keys are in this list. */
  config_keys: string[];
}

export const WIDGET_CATALOG: Record<WidgetType, WidgetCatalogEntry> = {
  risk_score_histogram: {
    widget_type: 'risk_score_histogram',
    display_name: 'Risk score distribution',
    description: 'Histogram of customer risk scores in the selected segment.',
    default_span: { rows: 2, cols: 6 },
    config_keys: ['vertical', 'bucket_count', 'segment_filter'],
  },
  alerts_by_class: {
    widget_type: 'alerts_by_class',
    display_name: 'Alerts by BIL class',
    description: 'Count of open alerts bucketed red/orange/yellow/green.',
    default_span: { rows: 1, cols: 6 },
    config_keys: ['since_hours'],
  },
  open_cases: {
    widget_type: 'open_cases',
    display_name: 'Open cases',
    description: 'Investigations in non-terminal states with SLA progress.',
    default_span: { rows: 2, cols: 6 },
    config_keys: ['status_filter', 'limit'],
  },
  connector_health: {
    widget_type: 'connector_health',
    display_name: 'Connector fleet health',
    description: 'Per-connector status (healthy/degraded/down) with last-run timestamp.',
    default_span: { rows: 2, cols: 6 },
    config_keys: ['show_paused'],
  },
  top_breaches: {
    widget_type: 'top_breaches',
    display_name: 'Top KRI breaches',
    description: 'Customers with the most red/orange indicator breaches.',
    default_span: { rows: 2, cols: 6 },
    config_keys: ['vertical', 'limit'],
  },
  audit_recent: {
    widget_type: 'audit_recent',
    display_name: 'Recent audit events',
    description: 'Last N audit-trail entries across all resource types.',
    default_span: { rows: 3, cols: 6 },
    config_keys: ['limit', 'severity_filter'],
  },
  tenant_kpi: {
    widget_type: 'tenant_kpi',
    display_name: 'Tenant KPI tile',
    description: 'Single big-number KPI (customer count, alert volume, etc).',
    default_span: { rows: 1, cols: 3 },
    config_keys: ['metric', 'comparison_window'],
  },
};

export function isWidgetType(s: unknown): s is WidgetType {
  return typeof s === 'string' && (WIDGET_TYPES as readonly string[]).includes(s);
}

export function getWidgetCatalogEntry(t: WidgetType): WidgetCatalogEntry {
  return WIDGET_CATALOG[t];
}

// ─── Public types ─────────────────────────────────────────────────────

export interface DashboardWidget {
  widget_type: WidgetType;
  /** 0-based grid position. */
  position: { row: number; col: number };
  /** 1-based span. cols cap at 12 (the grid width). */
  span: { rows: number; cols: number };
  config: Record<string, unknown>;
}

export interface CustomDashboardInput {
  name: string;
  description?: string;
  widgets: DashboardWidget[];
}

export interface CustomDashboard {
  dashboard_id: string;
  tenant_id: string;
  name: string;
  description: string;
  widgets: DashboardWidget[];
  created_by: string;
  created_at: string;
  updated_at: string;
  /** Bumped on every PUT. Lets the SPA cache-bust. */
  version: number;
}

export class DashboardError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DashboardError';
  }
}

// ─── Constants ────────────────────────────────────────────────────────

const NAME_CAP = 80;
const DESC_CAP = 500;
const GRID_COLS = 12;
const MAX_WIDGETS = 12;
const CAP_PER_TENANT = 10;

// ─── Validation ───────────────────────────────────────────────────────

function checkInt(name: string, v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new DashboardError('invalid_input', `${name} must be an integer`);
  }
  if (v < min || v > max) {
    throw new DashboardError('invalid_input', `${name} must be in [${min}, ${max}]`);
  }
  return v;
}

function validateWidget(input: unknown, idx: number): DashboardWidget {
  if (!input || typeof input !== 'object') {
    throw new DashboardError('invalid_input', `widget[${idx}] must be an object`);
  }
  const i = input as Record<string, unknown>;
  if (!isWidgetType(i.widget_type)) {
    throw new DashboardError(
      'invalid_input',
      `widget[${idx}].widget_type must be one of ${WIDGET_TYPES.join(', ')}`,
    );
  }
  if (!i.position || typeof i.position !== 'object') {
    throw new DashboardError('invalid_input', `widget[${idx}].position required`);
  }
  const p = i.position as Record<string, unknown>;
  const row = checkInt(`widget[${idx}].position.row`, p.row, 0, 999);
  const col = checkInt(`widget[${idx}].position.col`, p.col, 0, GRID_COLS - 1);

  if (!i.span || typeof i.span !== 'object') {
    throw new DashboardError('invalid_input', `widget[${idx}].span required`);
  }
  const s = i.span as Record<string, unknown>;
  const rows = checkInt(`widget[${idx}].span.rows`, s.rows, 1, 999);
  const cols = checkInt(`widget[${idx}].span.cols`, s.cols, 1, GRID_COLS);
  if (col + cols > GRID_COLS) {
    throw new DashboardError(
      'invalid_input',
      `widget[${idx}] overflows the ${GRID_COLS}-col grid (col=${col} + cols=${cols})`,
    );
  }

  let config: Record<string, unknown> = {};
  if (i.config !== undefined && i.config !== null) {
    if (typeof i.config !== 'object' || Array.isArray(i.config)) {
      throw new DashboardError('invalid_input', `widget[${idx}].config must be an object`);
    }
    const allowed = new Set(WIDGET_CATALOG[i.widget_type as WidgetType].config_keys);
    for (const key of Object.keys(i.config)) {
      if (!allowed.has(key)) {
        throw new DashboardError(
          'invalid_input',
          `widget[${idx}].config has unknown key '${key}' for widget type ${i.widget_type} (allowed: ${[...allowed].join(', ')})`,
        );
      }
    }
    config = { ...(i.config as Record<string, unknown>) };
  }

  return {
    widget_type: i.widget_type as WidgetType,
    position: { row, col },
    span: { rows, cols },
    config,
  };
}

/** Pure: rejects any pair of widgets whose grid rectangles overlap. */
export function detectOverlaps(widgets: readonly DashboardWidget[]): { a: number; b: number } | null {
  for (let i = 0; i < widgets.length; i++) {
    for (let j = i + 1; j < widgets.length; j++) {
      const A = widgets[i]!;
      const B = widgets[j]!;
      const aRow0 = A.position.row;
      const aRow1 = A.position.row + A.span.rows - 1;
      const aCol0 = A.position.col;
      const aCol1 = A.position.col + A.span.cols - 1;
      const bRow0 = B.position.row;
      const bRow1 = B.position.row + B.span.rows - 1;
      const bCol0 = B.position.col;
      const bCol1 = B.position.col + B.span.cols - 1;
      const overlap =
        aRow0 <= bRow1 && bRow0 <= aRow1 && aCol0 <= bCol1 && bCol0 <= aCol1;
      if (overlap) return { a: i, b: j };
    }
  }
  return null;
}

function validate(input: unknown): CustomDashboardInput {
  if (!input || typeof input !== 'object') {
    throw new DashboardError('invalid_input', 'request body required');
  }
  const i = input as Record<string, unknown>;
  if (typeof i.name !== 'string' || !i.name.trim()) {
    throw new DashboardError('invalid_input', 'name is required');
  }
  if (i.name.length > NAME_CAP) {
    throw new DashboardError('invalid_input', `name ≤ ${NAME_CAP} chars`);
  }
  if (i.description !== undefined && typeof i.description !== 'string') {
    throw new DashboardError('invalid_input', 'description must be a string');
  }
  if (typeof i.description === 'string' && i.description.length > DESC_CAP) {
    throw new DashboardError('invalid_input', `description ≤ ${DESC_CAP} chars`);
  }
  if (!Array.isArray(i.widgets)) {
    throw new DashboardError('invalid_input', 'widgets[] is required');
  }
  if (i.widgets.length === 0) {
    throw new DashboardError('invalid_input', 'dashboard must have at least 1 widget');
  }
  if (i.widgets.length > MAX_WIDGETS) {
    throw new DashboardError(
      'invalid_input',
      `at most ${MAX_WIDGETS} widgets per dashboard`,
    );
  }
  const widgets = i.widgets.map((w, idx) => validateWidget(w, idx));
  const overlap = detectOverlaps(widgets);
  if (overlap) {
    throw new DashboardError(
      'invalid_input',
      `widgets[${overlap.a}] and widgets[${overlap.b}] overlap on the grid`,
    );
  }
  return {
    name: i.name.trim(),
    description: typeof i.description === 'string' ? i.description.trim() : '',
    widgets,
  };
}

// ─── Store ────────────────────────────────────────────────────────────

export interface CustomDashboardStore {
  list(tenant_id: string): CustomDashboard[];
  get(tenant_id: string, dashboard_id: string): CustomDashboard | null;
  create(
    tenant_id: string,
    input: unknown,
    created_by: string,
    now: Date,
  ): CustomDashboard;
  replace(
    tenant_id: string,
    dashboard_id: string,
    input: unknown,
    updated_by: string,
    now: Date,
  ): CustomDashboard;
  delete(tenant_id: string, dashboard_id: string): boolean;
}

function clone(d: CustomDashboard): CustomDashboard {
  return {
    ...d,
    widgets: d.widgets.map((w) => ({
      widget_type: w.widget_type,
      position: { ...w.position },
      span: { ...w.span },
      config: { ...w.config },
    })),
  };
}

export class InMemoryCustomDashboardStore implements CustomDashboardStore {
  private readonly perTenant = new Map<string, CustomDashboard[]>();

  private bucket(tenant_id: string): CustomDashboard[] {
    let arr = this.perTenant.get(tenant_id);
    if (!arr) {
      arr = [];
      this.perTenant.set(tenant_id, arr);
    }
    return arr;
  }

  list(tenant_id: string): CustomDashboard[] {
    return (this.perTenant.get(tenant_id) ?? []).map(clone);
  }

  get(tenant_id: string, dashboard_id: string): CustomDashboard | null {
    const d = this.perTenant.get(tenant_id)?.find((x) => x.dashboard_id === dashboard_id);
    return d ? clone(d) : null;
  }

  create(
    tenant_id: string,
    input: unknown,
    created_by: string,
    now: Date,
  ): CustomDashboard {
    if (!created_by || !created_by.trim()) {
      throw new DashboardError('invalid_input', 'created_by required');
    }
    const valid = validate(input);
    const arr = this.bucket(tenant_id);
    if (arr.length >= CAP_PER_TENANT) {
      throw new DashboardError(
        'cap_reached',
        `tenant ${tenant_id} already has ${CAP_PER_TENANT} custom dashboards`,
      );
    }
    const dashboard: CustomDashboard = {
      dashboard_id: `dsh-${randomUUID()}`,
      tenant_id,
      name: valid.name,
      description: valid.description ?? '',
      widgets: valid.widgets,
      created_by: created_by.trim(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      version: 1,
    };
    arr.push(dashboard);
    return clone(dashboard);
  }

  replace(
    tenant_id: string,
    dashboard_id: string,
    input: unknown,
    updated_by: string,
    now: Date,
  ): CustomDashboard {
    if (!updated_by || !updated_by.trim()) {
      throw new DashboardError('invalid_input', 'updated_by required');
    }
    const arr = this.bucket(tenant_id);
    const idx = arr.findIndex((d) => d.dashboard_id === dashboard_id);
    if (idx < 0) {
      throw new DashboardError(
        'unknown_dashboard',
        `dashboard ${dashboard_id} not found`,
      );
    }
    const valid = validate(input);
    const cur = arr[idx]!;
    const next: CustomDashboard = {
      ...cur,
      name: valid.name,
      description: valid.description ?? '',
      widgets: valid.widgets,
      updated_at: now.toISOString(),
      version: cur.version + 1,
    };
    arr[idx] = next;
    return clone(next);
  }

  delete(tenant_id: string, dashboard_id: string): boolean {
    const arr = this.perTenant.get(tenant_id);
    if (!arr) return false;
    const idx = arr.findIndex((d) => d.dashboard_id === dashboard_id);
    if (idx < 0) return false;
    arr.splice(idx, 1);
    return true;
  }
}

export const defaultCustomDashboardStore: CustomDashboardStore =
  new InMemoryCustomDashboardStore();

export {
  CAP_PER_TENANT as DASHBOARD_CAP_PER_TENANT,
  MAX_WIDGETS as DASHBOARD_MAX_WIDGETS,
  GRID_COLS as DASHBOARD_GRID_COLS,
};
