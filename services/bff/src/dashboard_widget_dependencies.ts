// services/bff/src/dashboard_widget_dependencies.ts
// T6 M11.27 — Dashboard widget dependency analysis.

import {
  defaultCustomDashboardStore,
  type CustomDashboardStore,
  WIDGET_TYPES,
  type WidgetType,
} from './custom_dashboards';

export interface WidgetCoOccurrence {
  widget_a: WidgetType;
  widget_b: WidgetType;
  count: number;
}

export interface DashboardWidgetDependenciesResult {
  tenant_id: string;
  generated_at: string;
  total_dashboards: number;
  co_occurrences: WidgetCoOccurrence[];
  isolated_widget_types: WidgetType[];
  most_paired_widget: WidgetType | null;
}

export function buildDashboardWidgetDependencies(
  tenant_id: string,
  now: Date,
  store: CustomDashboardStore = defaultCustomDashboardStore,
): DashboardWidgetDependenciesResult {
  if (!tenant_id) throw new Error('tenant_id required');

  const dashboards = store.list(tenant_id);

  // co-occurrence matrix
  const coMap = new Map<string, number>();
  const appearsIn = new Map<WidgetType, number>();

  for (const dashboard of dashboards) {
    const widgetTypeSet = new Set(dashboard.widgets.map((w) => w.widget_type as WidgetType));
    const types = [...widgetTypeSet].sort();

    for (const t of types) {
      appearsIn.set(t, (appearsIn.get(t) ?? 0) + 1);
    }

    for (let i = 0; i < types.length; i++) {
      for (let j = i + 1; j < types.length; j++) {
        const key = `${types[i]}|${types[j]}`;
        coMap.set(key, (coMap.get(key) ?? 0) + 1);
      }
    }
  }

  const co_occurrences: WidgetCoOccurrence[] = [...coMap.entries()]
    .map(([key, count]) => {
      const [widget_a, widget_b] = key.split('|') as [WidgetType, WidgetType];
      return { widget_a, widget_b, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const isolated_widget_types = (WIDGET_TYPES as readonly WidgetType[]).filter(
    (t) => !appearsIn.has(t),
  );

  // most_paired_widget: appears in most co-occurrence pairs
  const pairCount = new Map<WidgetType, number>();
  for (const { widget_a, widget_b } of co_occurrences) {
    pairCount.set(widget_a, (pairCount.get(widget_a) ?? 0) + 1);
    pairCount.set(widget_b, (pairCount.get(widget_b) ?? 0) + 1);
  }
  let most_paired_widget: WidgetType | null = null;
  let maxPairs = 0;
  for (const [wt, cnt] of pairCount.entries()) {
    if (cnt > maxPairs) {
      maxPairs = cnt;
      most_paired_widget = wt;
    }
  }

  return {
    tenant_id,
    generated_at: now.toISOString(),
    total_dashboards: dashboards.length,
    co_occurrences,
    isolated_widget_types,
    most_paired_widget,
  };
}
