// dashboardContextResolver.ts
//
// Phase: Dynamic Dashboard Intelligence Layer
// Resolves the full runtime context that drives widget prioritization.
// Pure-function — no I/O. All inputs passed by the caller.
//
// Extends the existing DashboardContext with:
//   - workload signals (my alerts, cases, investigations, approvals)
//   - risk elevation signals (critical-alert burst, NPA spike, fraud cluster)
//   - domain-specific risk focus
//   - user behaviour signals (last-visited page, most-used widgets)
//   - personalization overrides

import type { WidgetRole, WidgetDomain } from './widgetRegistry';
import type { DashboardContext } from './roleDashboardEngine';

// ─── Workload context ────────────────────────────────────────────────────

export interface WorkloadContext {
  myAlerts:          number;
  myCases:           number;
  myInvestigations:  number;
  myEscalations:     number;
  myRecoveries:      number;
  myApprovals:       number;
  myRegulatoryTasks: number;
  mySlaBreaches:     number;
}

// ─── Risk elevation signals ───────────────────────────────────────────────

export type RiskElevation = 'normal' | 'elevated' | 'high' | 'critical';

export interface RiskSignal {
  elevation:        RiskElevation;
  criticalAlerts:   number;
  fraudClusters:    number;
  npaDeteriorations: number;
  complianceBreaches: number;
  slaBreaches:       number;
}

// ─── User behaviour ───────────────────────────────────────────────────────

export interface BehaviourSignal {
  /** Widget IDs the user has visited most in the last 7 days. */
  frequentWidgets: string[];
  /** Most recent module visited (for context-aware briefing). */
  lastVisitedModule: string | null;
  /** ISO date of last login. */
  lastLoginAt: string | null;
}

// ─── Resolved full context ────────────────────────────────────────────────

export interface FullDashboardContext extends DashboardContext {
  workload:  WorkloadContext;
  risk:      RiskSignal;
  behaviour: BehaviourSignal;
  /** ISO date string (YYYY-MM-DD) used for deterministic synthesis. */
  dayKey:    string;
}

// ─── Risk elevation thresholds ────────────────────────────────────────────

function computeElevation(r: Omit<RiskSignal, 'elevation'>): RiskElevation {
  if (r.criticalAlerts >= 5 || r.fraudClusters >= 3 || r.complianceBreaches >= 4) return 'critical';
  if (r.criticalAlerts >= 3 || r.fraudClusters >= 1 || r.npaDeteriorations >= 5) return 'high';
  if (r.criticalAlerts >= 1 || r.slaBreaches >= 3 || r.npaDeteriorations >= 2)   return 'elevated';
  return 'normal';
}

// ─── PRNG (same as commandCenterEngine) ──────────────────────────────────

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function rng(scope: string) { return mulberry32(fnv1a(scope)); }

// ─── Synthetic workload (deterministic per role+day) ─────────────────────

export function synthesiseWorkload(role: WidgetRole, dayKey: string): WorkloadContext {
  const r = rng(`wl:${role}:${dayKey}`);

  // Role-appropriate workload ranges
  const ROLE_WORKLOAD: Record<WidgetRole, () => WorkloadContext> = {
    super_admin:        () => ({ myAlerts: Math.round(r() * 6),  myCases: Math.round(r() * 4),  myInvestigations: Math.round(r() * 2),  myEscalations: Math.round(r() * 3),  myRecoveries: Math.round(r() * 2),  myApprovals: Math.round(r() * 8),  myRegulatoryTasks: Math.round(r() * 5),  mySlaBreaches: Math.round(r() * 2) }),
    country_admin:      () => ({ myAlerts: Math.round(r() * 8),  myCases: Math.round(r() * 6),  myInvestigations: Math.round(r() * 3),  myEscalations: Math.round(r() * 4),  myRecoveries: Math.round(r() * 3),  myApprovals: Math.round(r() * 10), myRegulatoryTasks: Math.round(r() * 6),  mySlaBreaches: Math.round(r() * 3) }),
    bank_admin:         () => ({ myAlerts: Math.round(r() * 10), myCases: Math.round(r() * 8),  myInvestigations: Math.round(r() * 4),  myEscalations: Math.round(r() * 5),  myRecoveries: Math.round(r() * 4),  myApprovals: Math.round(r() * 12), myRegulatoryTasks: Math.round(r() * 8),  mySlaBreaches: Math.round(r() * 4) }),
    insurance_admin:    () => ({ myAlerts: Math.round(r() * 8),  myCases: Math.round(r() * 6),  myInvestigations: Math.round(r() * 3),  myEscalations: Math.round(r() * 4),  myRecoveries: Math.round(r() * 2),  myApprovals: Math.round(r() * 10), myRegulatoryTasks: Math.round(r() * 7),  mySlaBreaches: Math.round(r() * 3) }),
    risk_analyst:       () => ({ myAlerts: Math.round(12 + r() * 20), myCases: Math.round(4 + r() * 8), myInvestigations: Math.round(1 + r() * 5), myEscalations: Math.round(r() * 4), myRecoveries: Math.round(r() * 2), myApprovals: Math.round(r() * 3), myRegulatoryTasks: Math.round(r() * 4), mySlaBreaches: Math.round(1 + r() * 4) }),
    fraud_analyst:      () => ({ myAlerts: Math.round(8 + r() * 15),  myCases: Math.round(3 + r() * 6), myInvestigations: Math.round(2 + r() * 8), myEscalations: Math.round(1 + r() * 4), myRecoveries: Math.round(r() * 2), myApprovals: Math.round(r() * 2), myRegulatoryTasks: Math.round(r() * 3), mySlaBreaches: Math.round(r() * 3) }),
    auditor:            () => ({ myAlerts: Math.round(r() * 4),  myCases: Math.round(r() * 3),  myInvestigations: Math.round(r() * 2),  myEscalations: Math.round(r() * 2),  myRecoveries: Math.round(r() * 1),  myApprovals: Math.round(r() * 5),  myRegulatoryTasks: Math.round(5 + r() * 10), mySlaBreaches: Math.round(r() * 2) }),
    executive:          () => ({ myAlerts: Math.round(r() * 3),  myCases: Math.round(r() * 2),  myInvestigations: Math.round(r() * 1),  myEscalations: Math.round(r() * 2),  myRecoveries: Math.round(r() * 1),  myApprovals: Math.round(r() * 6),  myRegulatoryTasks: Math.round(r() * 4),  mySlaBreaches: Math.round(r() * 1) }),
    admin:              () => ({ myAlerts: Math.round(6 + r() * 12),  myCases: Math.round(4 + r() * 8),  myInvestigations: Math.round(r() * 3),  myEscalations: Math.round(r() * 4),  myRecoveries: Math.round(r() * 3),  myApprovals: Math.round(r() * 8),  myRegulatoryTasks: Math.round(r() * 6),  mySlaBreaches: Math.round(r() * 3) }),
    supervisor:         () => ({ myAlerts: Math.round(4 + r() * 10),  myCases: Math.round(6 + r() * 12), myInvestigations: Math.round(1 + r() * 4), myEscalations: Math.round(2 + r() * 5), myRecoveries: Math.round(r() * 3), myApprovals: Math.round(4 + r() * 8), myRegulatoryTasks: Math.round(r() * 4), mySlaBreaches: Math.round(1 + r() * 5) }),
    collection_officer: () => ({ myAlerts: Math.round(3 + r() * 8),  myCases: Math.round(8 + r() * 16), myInvestigations: Math.round(r() * 2), myEscalations: Math.round(1 + r() * 4), myRecoveries: Math.round(4 + r() * 10), myApprovals: Math.round(r() * 3), myRegulatoryTasks: Math.round(r() * 2), mySlaBreaches: Math.round(2 + r() * 6) }),
    field_officer:      () => ({ myAlerts: Math.round(2 + r() * 6),  myCases: Math.round(3 + r() * 8),  myInvestigations: Math.round(r() * 2), myEscalations: Math.round(r() * 2), myRecoveries: Math.round(r() * 3), myApprovals: Math.round(r() * 2), myRegulatoryTasks: Math.round(r() * 2), mySlaBreaches: Math.round(r() * 3) }),
  };
  return (ROLE_WORKLOAD[role] ?? ROLE_WORKLOAD.field_officer)();
}

// ─── Synthetic risk signal ────────────────────────────────────────────────

export function synthesiseRiskSignal(role: WidgetRole, domain: WidgetDomain, dayKey: string): RiskSignal {
  const r = rng(`rs:${role}:${domain}:${dayKey}`);
  const critical   = Math.round(r() * (role === 'risk_analyst' || role === 'fraud_analyst' ? 6 : 3));
  const fraud      = Math.round(r() * (domain === 'banking' ? 3 : 2));
  const npa        = Math.round(r() * (domain === 'banking' ? 5 : 2));
  const compliance = Math.round(r() * 4);
  const sla        = Math.round(r() * 5);
  return {
    elevation:         computeElevation({ criticalAlerts: critical, fraudClusters: fraud, npaDeteriorations: npa, complianceBreaches: compliance, slaBreaches: sla }),
    criticalAlerts:    critical,
    fraudClusters:     fraud,
    npaDeteriorations: npa,
    complianceBreaches: compliance,
    slaBreaches:       sla,
  };
}

// ─── Default behaviour signal (no real telemetry in prototype) ────────────

export function defaultBehaviourSignal(role: WidgetRole): BehaviourSignal {
  const ROLE_FREQUENT: Partial<Record<WidgetRole, string[]>> = {
    risk_analyst:       ['npa_forecast', 'sma_classification', 'fraud_signals'],
    fraud_analyst:      ['fraud_signals', 'fraud_case_list', 'aml_watchlist'],
    collection_officer: ['collections_queue', 'recovery_actions', 'borrower_watch'],
    supervisor:         ['case_escalations', 'approval_queue', 'sla_status'],
    executive:          ['enterprise_risk_score', 'executive_briefing', 'board_readiness'],
    auditor:            ['compliance_checklist', 'audit_trail', 'regulatory_deadlines'],
  };
  return {
    frequentWidgets:   ROLE_FREQUENT[role] ?? [],
    lastVisitedModule: null,
    lastLoginAt:       null,
  };
}

// ─── Main resolver ────────────────────────────────────────────────────────

export function resolveFullContext(
  base: DashboardContext,
  overrides?: Partial<{ workload: WorkloadContext; risk: RiskSignal; behaviour: BehaviourSignal }>,
): FullDashboardContext {
  const dayKey = new Date().toISOString().slice(0, 10);
  return {
    ...base,
    dayKey,
    workload:  overrides?.workload  ?? synthesiseWorkload(base.role, dayKey),
    risk:      overrides?.risk      ?? synthesiseRiskSignal(base.role, base.domain, dayKey),
    behaviour: overrides?.behaviour ?? defaultBehaviourSignal(base.role),
  };
}
