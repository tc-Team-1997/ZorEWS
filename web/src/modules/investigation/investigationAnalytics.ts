// Investigation Analytics — pure resolvers. Backs the Investigation Center analytics + executive sections.

import {
  InvestigationDomain,
  InvestigationSeverity,
  listInvestigations,
} from './investigationEngine';

export interface ProductivityRow {
  investigator_username: string;
  closed_cases_30d: number;
  avg_close_days: number;
  reopened_count: number;
  satisfaction_score: number;
}

export interface VolumeTrendPoint {
  week_offset: number;
  date_label: string;
  opened: number;
  closed: number;
  escalated: number;
}

export interface InvestigationAnalytics {
  tenant_id: string;
  generated_at: string;
  average_resolution_time_days: number;
  median_resolution_time_days: number;
  investigator_productivity: ProductivityRow[];
  case_volume_trend: VolumeTrendPoint[];
  fraud_detection_rate: number;
  recovery_success_rate: number;
  sla_compliance_rate: number;
  escalation_rate: number;
}

export interface ExecutiveCaseRow {
  investigation_id: string;
  title: string;
  severity: InvestigationSeverity;
  domain: InvestigationDomain;
  exposure_kes: number;
  assignee_username: string | null;
  age_days: number;
}

export interface ExecutiveInvestigationView {
  tenant_id: string;
  generated_at: string;
  top_open_cases: ExecutiveCaseRow[];
  critical_investigations: ExecutiveCaseRow[];
  fraud_exposure_kes: number;
  recovery_impact_kes: number;
  investigation_performance: {
    sla_compliance_rate: number;
    avg_resolution_days: number;
    closure_rate_30d: number;
  };
}

function fnv1a(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayIndex(asOf: Date): number {
  return Math.floor(asOf.getTime() / 86_400_000);
}

function toIso(asOf: Date): string {
  const y = asOf.getUTCFullYear();
  const m = String(asOf.getUTCMonth() + 1).padStart(2, '0');
  const d = String(asOf.getUTCDate()).padStart(2, '0');
  const hh = String(asOf.getUTCHours()).padStart(2, '0');
  const mm = String(asOf.getUTCMinutes()).padStart(2, '0');
  const ss = String(asOf.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function pickInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pickFloat(rng: () => number, min: number, max: number): number {
  return rng() * (max - min) + min;
}

export function buildInvestigationAnalytics(
  tenant_id: string,
  asOf?: Date,
): InvestigationAnalytics {
  const ts = asOf ?? new Date();
  const day = dayIndex(ts);
  const seed = fnv1a(`${tenant_id}|analytics|${day}`);
  const rng = mulberry32(seed);

  const avg = round2(pickFloat(rng, 4, 12));
  const medianRaw = pickFloat(rng, 3, 10);
  const median = round2(Math.min(medianRaw, avg));

  const productivity: ProductivityRow[] = [];
  for (let i = 0; i < 6; i++) {
    const username = `investigator.${String(i + 1).padStart(2, '0')}`;
    const closed = pickInt(rng, 5, 40);
    const avgClose = round2(pickFloat(rng, 2, 14));
    const reopened = pickInt(rng, 0, 5);
    const satisfaction = round2(pickFloat(rng, 3.2, 5.0));
    productivity.push({
      investigator_username: username,
      closed_cases_30d: closed,
      avg_close_days: avgClose,
      reopened_count: reopened,
      satisfaction_score: satisfaction,
    });
  }
  productivity.sort((a, b) => b.closed_cases_30d - a.closed_cases_30d);

  const trend: VolumeTrendPoint[] = [];
  for (let offset = -11; offset <= 0; offset++) {
    const label = `WK-${String(offset + 12).padStart(2, '0')}`;
    const opened = pickInt(rng, 8, 45);
    const closed = pickInt(rng, 5, Math.max(5, opened));
    const escalated = pickInt(rng, 0, Math.max(1, Math.floor(opened / 4)));
    trend.push({
      week_offset: offset,
      date_label: label,
      opened,
      closed,
      escalated,
    });
  }

  const fraud_detection_rate = round4(pickFloat(rng, 0.55, 0.92));
  const recovery_success_rate = round4(pickFloat(rng, 0.45, 0.85));
  const sla_compliance_rate = round4(pickFloat(rng, 0.7, 0.98));
  const escalation_rate = round4(pickFloat(rng, 0.05, 0.25));

  return {
    tenant_id,
    generated_at: toIso(ts),
    average_resolution_time_days: avg,
    median_resolution_time_days: median,
    investigator_productivity: productivity,
    case_volume_trend: trend,
    fraud_detection_rate,
    recovery_success_rate,
    sla_compliance_rate,
    escalation_rate,
  };
}

const OPEN_LIKE_STATUSES = new Set([
  'open',
  'assigned',
  'in_review',
  'pending_approval',
  'escalated',
]);

export function buildExecutiveInvestigationView(
  tenant_id: string,
  asOf?: Date,
): ExecutiveInvestigationView {
  const ts = asOf ?? new Date();
  const day = dayIndex(ts);
  const seed = fnv1a(`${tenant_id}|exec|${day}`);
  const rng = mulberry32(seed);

  const investigations = listInvestigations(tenant_id, ts);

  const rows: ExecutiveCaseRow[] = investigations.map((inv) => {
    const openedAt = new Date(inv.opened_at);
    const ageMs = Math.max(0, ts.getTime() - openedAt.getTime());
    const age_days = Math.floor(ageMs / 86_400_000);
    return {
      investigation_id: inv.investigation_id,
      title: inv.title,
      severity: inv.severity,
      domain: inv.domain,
      exposure_kes: inv.exposure_kes,
      assignee_username: inv.assignee_username ?? null,
      age_days,
    };
  });

  const openCandidates = investigations
    .map((inv, i) => ({ inv, row: rows[i] }))
    .filter(({ inv }) => OPEN_LIKE_STATUSES.has(inv.status));
  openCandidates.sort((a, b) => b.row.exposure_kes - a.row.exposure_kes);
  const top_open_cases = openCandidates.slice(0, 5).map((x) => x.row);

  const criticalCandidates = investigations
    .map((inv, i) => ({ inv, row: rows[i] }))
    .filter(({ inv }) => inv.severity === 'critical');
  criticalCandidates.sort((a, b) => b.row.exposure_kes - a.row.exposure_kes);
  const critical_investigations = criticalCandidates.slice(0, 5).map((x) => x.row);

  let fraud_exposure_kes = 0;
  let recovery_impact_kes = 0;
  for (const inv of investigations) {
    if (inv.fraud_indicator === true) {
      fraud_exposure_kes += inv.exposure_kes;
    }
    if (inv.status === 'closed') {
      recovery_impact_kes += inv.exposure_kes;
    }
  }

  const sla_compliance_rate = round4(pickFloat(rng, 0.7, 0.98));
  const avg_resolution_days = round2(pickFloat(rng, 4, 12));
  const closure_rate_30d = round4(pickFloat(rng, 0.4, 0.85));

  return {
    tenant_id,
    generated_at: toIso(ts),
    top_open_cases,
    critical_investigations,
    fraud_exposure_kes: Math.round(fraud_exposure_kes),
    recovery_impact_kes: Math.round(recovery_impact_kes),
    investigation_performance: {
      sla_compliance_rate,
      avg_resolution_days,
      closure_rate_30d,
    },
  };
}
