// dashboardPersonalizationEngine.ts
//
// Phase: Dynamic Dashboard Intelligence Layer — Personalization Engine
//
// Manages user layout preferences:
//   - Pinned widgets (always shown first)
//   - Hidden widgets (removed from view)
//   - Custom sort order
//   - Named personal views (Collections, Fraud, Compliance…)
//   - Layout persistence (localStorage in prototype; app_iam.* in production)

import type { ScoredWidget } from './dashboardPriorityEngine';

// ─── Types ────────────────────────────────────────────────────────────────

export interface WidgetPersonalization {
  widgetId:  string;
  pinned:    boolean;
  hidden:    boolean;
  sortOrder: number | null;  // null = use priority engine order
}

export type NamedViewId =
  | 'default'
  | 'collections'
  | 'fraud'
  | 'compliance'
  | 'executive'
  | 'recovery'
  | 'investigation'
  | 'operational';

export interface NamedView {
  id:          NamedViewId;
  label:       string;
  description: string;
  /** Widget ids to include (null = all resolved by engine). */
  widgetIds:   string[] | null;
  /** Icons (lucide name string) */
  icon:        string;
}

export interface PersonalizationState {
  activeView:    NamedViewId;
  preferences:   WidgetPersonalization[];
  /** Whether the user dismissed the "Try personalizing" banner. */
  bannerDismissed: boolean;
}

// ─── Persistence key ──────────────────────────────────────────────────────

const STORAGE_KEY = 'zorews.dashboard.personalization';

export function loadPersonalization(): PersonalizationState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as PersonalizationState;
  } catch { /* corrupt blob */ }
  return { activeView: 'default', preferences: [], bannerDismissed: false };
}

export function savePersonalization(state: PersonalizationState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* quota */ }
}

// ─── Named views catalog ──────────────────────────────────────────────────

export const NAMED_VIEWS: readonly NamedView[] = [
  { id: 'default',       label: 'My Dashboard',      description: 'AI-prioritized view for your role and current workload.',          icon: 'layout-dashboard',  widgetIds: null },
  { id: 'collections',   label: 'Collections View',   description: 'Recovery queues, SLA status, and borrower risk segmentation.',     icon: 'banknote',          widgetIds: ['collections_queue','recovery_actions','sla_breach_panel','borrower_watch','npa_early_warning'] },
  { id: 'fraud',         label: 'Fraud View',         description: 'Fraud signals, AML watchlist, investigation queue, clusters.',     icon: 'shield-alert',      widgetIds: ['fraud_signals','fraud_case_list','aml_watchlist','fraud_cluster_map','investigation_queue'] },
  { id: 'compliance',    label: 'Compliance View',    description: 'Regulatory obligations, deadlines, audit status.',                 icon: 'file-check',        widgetIds: ['compliance_checklist','regulatory_tasks','audit_trail','governance_overview'] },
  { id: 'executive',     label: 'Executive View',     description: 'Board-ready KPIs, portfolio health, risk appetite.',              icon: 'bar-chart-2',       widgetIds: ['enterprise_risk_score','executive_briefing','board_readiness','portfolio_health'] },
  { id: 'recovery',      label: 'Recovery View',      description: 'NPA recovery, write-off tracking, legal case status.',            icon: 'rotate-ccw',        widgetIds: ['recovery_actions','npa_forecast','collections_queue','sla_breach_panel'] },
  { id: 'investigation', label: 'Investigation View', description: 'Active investigations, escalations, evidence vault.',             icon: 'search',            widgetIds: ['investigation_queue','escalation_panel','case_queue','fraud_case_list'] },
  { id: 'operational',   label: 'Operational View',   description: 'Daily alerts, case queue, SLA monitoring, live feed.',            icon: 'activity',          widgetIds: ['my_alerts_feed','case_queue','sla_breach_panel','approval_queue','my_alerts_feed'] },
];

export function getNamedView(id: NamedViewId): NamedView {
  return NAMED_VIEWS.find(v => v.id === id) ?? NAMED_VIEWS[0]!;
}

// ─── Apply personalization to scored widget list ──────────────────────────

export function applyPersonalization(
  widgets: ScoredWidget[],
  state: PersonalizationState,
): ScoredWidget[] {
  const prefs = state.preferences;
  const prefMap = new Map(prefs.map(p => [p.widgetId, p]));

  // 1. Filter hidden widgets
  const visible = widgets.filter(w => !prefMap.get(w.id)?.hidden);

  // 2. Apply named view filter (when not in default view)
  const view = getNamedView(state.activeView);
  const viewFiltered = (view.widgetIds === null)
    ? visible
    : visible.filter(w => view.widgetIds!.includes(w.id));

  // 3. Apply pinned + sort_order overrides
  const pinned    = viewFiltered.filter(w => prefMap.get(w.id)?.pinned);
  const unpinned  = viewFiltered.filter(w => !prefMap.get(w.id)?.pinned);

  const sortedUnpinned = [...unpinned].sort((a, b) => {
    const ao = prefMap.get(a.id)?.sortOrder ?? null;
    const bo = prefMap.get(b.id)?.sortOrder ?? null;
    if (ao !== null && bo !== null) return ao - bo;
    if (ao !== null) return -1;
    if (bo !== null) return 1;
    // Fall back to priority engine order
    return b.priorityScore - a.priorityScore;
  });

  return [...pinned, ...sortedUnpinned];
}

// ─── Preference mutation helpers ──────────────────────────────────────────

export function togglePin(state: PersonalizationState, widgetId: string): PersonalizationState {
  const existing = state.preferences.find(p => p.widgetId === widgetId);
  const next = existing
    ? state.preferences.map(p => p.widgetId === widgetId ? { ...p, pinned: !p.pinned } : p)
    : [...state.preferences, { widgetId, pinned: true, hidden: false, sortOrder: null }];
  return { ...state, preferences: next };
}

export function toggleHide(state: PersonalizationState, widgetId: string): PersonalizationState {
  const existing = state.preferences.find(p => p.widgetId === widgetId);
  const next = existing
    ? state.preferences.map(p => p.widgetId === widgetId ? { ...p, hidden: !p.hidden, pinned: false } : p)
    : [...state.preferences, { widgetId, pinned: false, hidden: true, sortOrder: null }];
  return { ...state, preferences: next };
}

export function resetLayout(state: PersonalizationState): PersonalizationState {
  return { ...state, preferences: [], activeView: 'default' };
}

export function setActiveView(state: PersonalizationState, view: NamedViewId): PersonalizationState {
  return { ...state, activeView: view };
}
