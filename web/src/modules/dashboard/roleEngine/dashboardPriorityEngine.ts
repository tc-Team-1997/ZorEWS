// dashboardPriorityEngine.ts
//
// Phase: Dynamic Dashboard Intelligence Layer — Priority Engine
//
// Scores every widget on a 0-100 scale using 6 weighted axes:
//   Role Weight       — how relevant is this widget for the viewer's role?
//   Risk Weight       — does current risk elevation demand this widget?
//   Activity Weight   — does the user's workload make this urgent?
//   Workload Weight   — is there pending work this widget surfaces?
//   Domain Weight     — is this widget domain-appropriate?
//   Trend Weight      — is the metric trending in the wrong direction?
//
// Pure-function: takes context + widget list → scored + sorted list.
// No I/O, deterministic, unit-testable.

import type { WidgetDef, WidgetRole, WidgetDomain } from './widgetRegistry';
import type { FullDashboardContext, RiskElevation } from './dashboardContextResolver';

// ─── Types ────────────────────────────────────────────────────────────────

export interface ScoredWidget extends WidgetDef {
  priorityScore: number;       // 0-100 composite
  scoreBreakdown: {
    role:     number;
    risk:     number;
    activity: number;
    workload: number;
    domain:   number;
    trend:    number;
  };
  urgencyBadge: 'critical' | 'high' | 'elevated' | null;
  isPromoted:   boolean;   // risk/workload elevated it above its default position
}

// ─── Role relevance matrix ────────────────────────────────────────────────

// Maps widget category → role → relevance weight (0-1)
const ROLE_CATEGORY_WEIGHTS: Record<string, Partial<Record<WidgetRole, number>>> = {
  executive_kpi:    { executive: 1.0, super_admin: 1.0, country_admin: 0.9, bank_admin: 0.9, insurance_admin: 0.9, risk_analyst: 0.7, supervisor: 0.8, admin: 0.8 },
  banking:          { risk_analyst: 1.0, fraud_analyst: 0.8, bank_admin: 1.0, collection_officer: 0.9, supervisor: 0.8, admin: 0.8, executive: 0.7 },
  insurance:        { insurance_admin: 1.0, risk_analyst: 0.9, auditor: 0.7, executive: 0.7 },
  governance:       { auditor: 1.0, super_admin: 1.0, country_admin: 0.9, executive: 0.7, admin: 0.8 },
  security:         { auditor: 1.0, super_admin: 0.9, fraud_analyst: 0.9, admin: 0.8 },
  recovery:         { collection_officer: 1.0, supervisor: 0.8, bank_admin: 0.8, admin: 0.7 },
  ai:               { risk_analyst: 1.0, fraud_analyst: 0.9, executive: 0.8, supervisor: 0.7 },
  audit:            { auditor: 1.0, super_admin: 0.9, country_admin: 0.8, admin: 0.8 },
  role_specialised: { risk_analyst: 0.9, fraud_analyst: 0.9, collection_officer: 0.9, auditor: 0.9, supervisor: 0.9 },
};

function roleWeight(widget: WidgetDef, role: WidgetRole): number {
  const categoryWeights = ROLE_CATEGORY_WEIGHTS[widget.category];
  if (!categoryWeights) return 0.5;
  return categoryWeights[role] ?? 0.5;
}

// ─── Risk elevation boosts ────────────────────────────────────────────────

const RISK_BOOST_WIDGETS: Record<string, RiskElevation[]> = {
  // These widget ids get boosted when risk is elevated/high/critical
  npa_forecast:          ['elevated', 'high', 'critical'],
  fraud_signals:         ['elevated', 'high', 'critical'],
  fraud_case_list:       ['high', 'critical'],
  critical_alert_strip:  ['elevated', 'high', 'critical'],
  sla_breach_panel:      ['elevated', 'high', 'critical'],
  compliance_checklist:  ['elevated', 'high', 'critical'],
  fraud_cluster_map:     ['high', 'critical'],
  npa_early_warning:     ['elevated', 'high', 'critical'],
  aml_watchlist:         ['high', 'critical'],
};

function riskWeight(widget: WidgetDef, elevation: RiskElevation): number {
  const boostElevations = RISK_BOOST_WIDGETS[widget.id];
  if (!boostElevations) return 0.4;  // neutral
  if (boostElevations.includes(elevation)) {
    const multiplier = elevation === 'critical' ? 1.0 : elevation === 'high' ? 0.85 : 0.7;
    return multiplier;
  }
  return 0.3;
}

// ─── Activity weight (recent user behaviour) ──────────────────────────────

function activityWeight(widget: WidgetDef, frequentWidgets: string[]): number {
  if (frequentWidgets.includes(widget.id)) return 0.9;
  return 0.4;
}

// ─── Workload weight ──────────────────────────────────────────────────────

type WorkloadKey = keyof {
  myAlerts: number; myCases: number; myInvestigations: number;
  myEscalations: number; myRecoveries: number; myApprovals: number;
  myRegulatoryTasks: number; mySlaBreaches: number;
};

const WIDGET_WORKLOAD_MAP: Record<string, WorkloadKey> = {
  my_alerts_feed:       'myAlerts',
  case_queue:           'myCases',
  investigation_queue:  'myInvestigations',
  escalation_panel:     'myEscalations',
  recovery_actions:     'myRecoveries',
  approval_queue:       'myApprovals',
  regulatory_tasks:     'myRegulatoryTasks',
  sla_breach_panel:     'mySlaBreaches',
};

function workloadWeight(widget: WidgetDef, ctx: FullDashboardContext): number {
  const key = WIDGET_WORKLOAD_MAP[widget.id];
  if (!key) return 0.4;
  const value = ctx.workload[key];
  if (value === 0) return 0.2;
  if (value >= 10) return 1.0;
  if (value >= 5)  return 0.8;
  if (value >= 2)  return 0.65;
  return 0.5;
}

// ─── Domain weight ────────────────────────────────────────────────────────

function domainWeight(widget: WidgetDef, domain: WidgetDomain): number {
  if (widget.default_domain === 'both') return 0.7;
  if (widget.default_domain === domain) return 1.0;
  return 0.1;  // wrong domain — already filtered, but score low just in case
}

// ─── Trend weight (widget category adversity signals) ─────────────────────

function trendWeight(widget: WidgetDef, ctx: FullDashboardContext): number {
  const { npaDeteriorations, fraudClusters, complianceBreaches, slaBreaches } = ctx.risk;
  const isBanking = ctx.domain === 'banking';
  const isInsurance = ctx.domain === 'insurance';

  if (widget.category === 'banking' && isBanking && (npaDeteriorations >= 3 || fraudClusters >= 1)) return 0.9;
  if (widget.category === 'insurance' && isInsurance && (fraudClusters >= 1))                        return 0.9;
  if (widget.category === 'governance' && complianceBreaches >= 2)                                   return 0.85;
  if (widget.category === 'recovery' && slaBreaches >= 3)                                            return 0.8;
  return 0.4;
}

// ─── Axis weights (sum to 1.0) ────────────────────────────────────────────

const AXIS_WEIGHTS = {
  role:     0.28,
  risk:     0.22,
  activity: 0.12,
  workload: 0.18,
  domain:   0.12,
  trend:    0.08,
} as const;

// ─── Main scoring function ────────────────────────────────────────────────

export function scoreWidget(widget: WidgetDef, ctx: FullDashboardContext): ScoredWidget {
  const rW  = roleWeight(widget, ctx.role);
  const riW = riskWeight(widget, ctx.risk.elevation);
  const aW  = activityWeight(widget, ctx.behaviour.frequentWidgets);
  const wW  = workloadWeight(widget, ctx);
  const dW  = domainWeight(widget, ctx.domain);
  const tW  = trendWeight(widget, ctx);

  const score = Math.round(
    (rW  * AXIS_WEIGHTS.role +
     riW * AXIS_WEIGHTS.risk +
     aW  * AXIS_WEIGHTS.activity +
     wW  * AXIS_WEIGHTS.workload +
     dW  * AXIS_WEIGHTS.domain +
     tW  * AXIS_WEIGHTS.trend) * 100
  );

  const urgencyBadge =
    ctx.risk.elevation === 'critical' && riW >= 0.8 ? 'critical' :
    ctx.risk.elevation === 'high'     && riW >= 0.7 ? 'high'     :
    ctx.risk.elevation === 'elevated' && riW >= 0.6 ? 'elevated' :
    null;

  return {
    ...widget,
    priorityScore: Math.min(100, Math.max(0, score)),
    scoreBreakdown: { role: rW, risk: riW, activity: aW, workload: wW, domain: dW, trend: tW },
    urgencyBadge,
    isPromoted: riW >= 0.7 || wW >= 0.8,
  };
}

// ─── Sort + prioritize the full widget list ───────────────────────────────

export function prioritizeWidgets(
  widgets: readonly WidgetDef[],
  ctx: FullDashboardContext,
): ScoredWidget[] {
  return widgets
    .map(w => scoreWidget(w, ctx))
    .sort((a, b) => {
      // Promoted (urgent) widgets always float above non-promoted
      if (a.isPromoted !== b.isPromoted) return a.isPromoted ? -1 : 1;
      // Then sort by score descending
      if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
      // Tie-break: label asc for stability
      return a.label.localeCompare(b.label);
    });
}
