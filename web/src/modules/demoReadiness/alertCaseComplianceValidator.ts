/**
 * Demo Readiness Center — Alert + Investigation + Compliance Validator
 *
 * Pure-function engine. No I/O, no fetch, no store. All validation functions
 * accept (tenant_id, asOf?) and synthesize reports on demand by draining
 * prior IA engines.
 */

import {
  listEnterpriseAlerts,
  listEnterpriseCases,
  summarizeAlertOps,
  summarizeInvestigationOps,
  listCaseTimeline,
  listEvidence,
} from '@/modules/enterpriseDemo/enterpriseRiskOpsEngine';
import {
  listComplianceObligations,
  listComplianceFindings,
  summarizeCompliancePosture,
} from '@/modules/enterpriseDemo/enterpriseAnalyticsEngine';

// ---------------------------------------------------------------------------
// Local time helper (rule 5)
// ---------------------------------------------------------------------------

/** Returns the current wall-clock Date — single point of `new Date()` use. */
function currentTime(): Date {
  return new Date();
}

// ---------------------------------------------------------------------------
// Deterministic RNG (FNV-1a + Mulberry32) — used only for jitter
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash over a string seed. */
function fnv1a(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Mulberry32 PRNG factory seeded by a 32-bit integer. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build a deterministic RNG from (tenant_id, asOf, salt). */
function rngFor(tenant_id: string, asOf: Date, salt: string): () => number {
  const dayKey = Math.floor(asOf.getTime() / 86_400_000);
  return mulberry32(fnv1a(`${tenant_id}|${dayKey}|${salt}`));
}

// ---------------------------------------------------------------------------
// Closed enums
// ---------------------------------------------------------------------------

export type ReadinessStatus = 'critical' | 'at_risk' | 'ready' | 'production_ready';
export type ReadinessDimension =
  | 'functional'
  | 'data'
  | 'security'
  | 'compliance'
  | 'integration'
  | 'uat_coverage'
  | 'release';
export type CheckSeverity = 'info' | 'warning' | 'error' | 'critical';
export type ValidationOutcome = 'passed' | 'warning' | 'failed';
export type ReleaseStatus = 'not_ready' | 'uat_ready' | 'demo_ready' | 'production_ready';

export type AlertCheckKind =
  | 'severity_missing'
  | 'unassigned'
  | 'no_escalation_path'
  | 'sla_breach'
  | 'no_investigation_link';

export type InvestigationCheckKind =
  | 'no_evidence'
  | 'incomplete_timeline'
  | 'no_closure_reason'
  | 'orphan_case'
  | 'escalation_stuck';

export type ComplianceCheckKind =
  | 'obligation_overdue'
  | 'missing_finding'
  | 'missing_report'
  | 'no_audit_link'
  | 'regulatory_gap';

const ALERT_CHECK_KINDS: readonly AlertCheckKind[] = [
  'severity_missing',
  'unassigned',
  'no_escalation_path',
  'sla_breach',
  'no_investigation_link',
];

const INVESTIGATION_CHECK_KINDS: readonly InvestigationCheckKind[] = [
  'no_evidence',
  'incomplete_timeline',
  'no_closure_reason',
  'orphan_case',
  'escalation_stuck',
];

const COMPLIANCE_CHECK_KINDS: readonly ComplianceCheckKind[] = [
  'obligation_overdue',
  'missing_finding',
  'missing_report',
  'no_audit_link',
  'regulatory_gap',
];

const ALERT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

// ---------------------------------------------------------------------------
// Scoring helper (rule 9)
// ---------------------------------------------------------------------------

/** Maps a 0..100 score to a ReadinessStatus bucket. */
export function statusFromScore(score: number): ReadinessStatus {
  if (score < 50) return 'critical';
  if (score < 70) return 'at_risk';
  if (score < 90) return 'ready';
  return 'production_ready';
}

/** Clamp a number into [lo, hi]. */
function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** Round to integer with NaN guard. */
function roundInt(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** Initialize an enum-keyed counter at 0. */
function zeroCounter<K extends string>(keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of keys) {
    out[k] = 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public report shapes
// ---------------------------------------------------------------------------

export interface AlertValidationReport {
  tenant_id: string;
  generated_at: string;
  total_alerts_scanned: number;
  banking_alerts_scanned: number;
  insurance_alerts_scanned: number;
  total_checks: number;
  passed_count: number;
  warning_count: number;
  failed_count: number;
  by_kind: Record<AlertCheckKind, number>;
  severity_distribution: Record<AlertSeverity, number>;
  alert_health_score: number;
}

export interface InvestigationValidationReport {
  tenant_id: string;
  generated_at: string;
  total_cases_scanned: number;
  open_count: number;
  in_progress_count: number;
  escalated_count: number;
  closed_count: number;
  total_checks: number;
  passed_count: number;
  warning_count: number;
  failed_count: number;
  by_kind: Record<InvestigationCheckKind, number>;
  evidence_integrity_score: number;
  timeline_completeness_score: number;
  investigation_quality_score: number;
}

export interface ComplianceValidationReport {
  tenant_id: string;
  generated_at: string;
  total_obligations_scanned: number;
  total_findings_scanned: number;
  total_reports_scanned: number;
  total_checks: number;
  passed_count: number;
  warning_count: number;
  failed_count: number;
  by_kind: Record<ComplianceCheckKind, number>;
  by_framework: Record<string, number>;
  regulatory_coverage_pct: number;
  compliance_readiness_score: number;
}

export interface TopBlocker {
  dimension: 'alert' | 'investigation' | 'compliance';
  detail: string;
  severity: CheckSeverity;
}

export interface AlertCaseComplianceSummary {
  alert_health_score: number;
  investigation_quality_score: number;
  compliance_readiness_score: number;
  combined_operational_score: number;
  top_blockers: TopBlocker[];
}

// ---------------------------------------------------------------------------
// Internal helpers for safe property reads (engines may evolve)
// ---------------------------------------------------------------------------

/** Read a string-ish field from an unknown row; defaults to ''. */
function readStr(row: unknown, key: string): string {
  if (row && typeof row === 'object' && key in (row as Record<string, unknown>)) {
    const v = (row as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return '';
}

/** Read an array length field from an unknown row; defaults to 0. */
function readArrayLen(row: unknown, key: string): number {
  if (row && typeof row === 'object' && key in (row as Record<string, unknown>)) {
    const v = (row as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v.length;
  }
  return 0;
}

/** Detect whether an alert record looks insurance-flavoured. */
function isInsuranceAlert(row: unknown): boolean {
  const domain = readStr(row, 'domain').toLowerCase();
  if (domain === 'insurance') return true;
  const product = readStr(row, 'product_line').toLowerCase();
  if (product.includes('policy') || product.includes('claim')) return true;
  const id = readStr(row, 'id').toLowerCase();
  return id.startsWith('ins-') || id.startsWith('clm-');
}

/** Normalize a severity-ish string into the closed AlertSeverity enum. */
function normalizeSeverity(raw: string): AlertSeverity | null {
  const s = raw.trim().toLowerCase();
  if (s === 'low' || s === 'medium' || s === 'high' || s === 'critical') return s;
  return null;
}

// ---------------------------------------------------------------------------
// validateAlerts
// ---------------------------------------------------------------------------

/** Validate alert hygiene across the tenant — severity, assignment, SLA, linkage. */
export function validateAlerts(tenant_id: string, asOf = currentTime()): AlertValidationReport {
  const generated_at = asOf.toISOString();
  const alerts = listEnterpriseAlerts(tenant_id, asOf) as unknown as unknown[];
  // Drain ops summary so any downstream signal is included in deterministic seeding.
  const ops = summarizeAlertOps(tenant_id, asOf) as unknown;
  const opsJitterSeed = readStr(ops, 'generated_at') || generated_at;
  const rng = rngFor(tenant_id, asOf, `alert-checks|${opsJitterSeed}`);

  const by_kind = zeroCounter<AlertCheckKind>(ALERT_CHECK_KINDS);
  const severity_distribution = zeroCounter<AlertSeverity>(ALERT_SEVERITIES);

  let banking = 0;
  let insurance = 0;
  let totalChecks = 0;
  let failedChecks = 0;
  let warningChecks = 0;

  for (const alert of alerts) {
    if (isInsuranceAlert(alert)) insurance += 1;
    else banking += 1;

    const sevRaw = readStr(alert, 'severity');
    const sev = normalizeSeverity(sevRaw);
    if (sev) severity_distribution[sev] += 1;

    // Check 1: severity_missing
    totalChecks += 1;
    if (!sev) {
      by_kind.severity_missing += 1;
      failedChecks += 1;
    }

    // Check 2: unassigned
    totalChecks += 1;
    const assignee = readStr(alert, 'assignee') || readStr(alert, 'owner');
    if (!assignee) {
      by_kind.unassigned += 1;
      // critical alerts unassigned → failed; lower severities → warning
      if (sev === 'critical' || sev === 'high') failedChecks += 1;
      else warningChecks += 1;
    }

    // Check 3: no_escalation_path (critical alerts must declare an escalation_path)
    totalChecks += 1;
    const escalation = readStr(alert, 'escalation_path');
    if (sev === 'critical' && !escalation) {
      by_kind.no_escalation_path += 1;
      failedChecks += 1;
    } else if (sev === 'high' && !escalation && rng() < 0.4) {
      by_kind.no_escalation_path += 1;
      warningChecks += 1;
    }

    // Check 4: sla_breach
    totalChecks += 1;
    const slaStatus = readStr(alert, 'sla_status').toLowerCase();
    const breached =
      slaStatus === 'breached' ||
      slaStatus === 'overdue' ||
      readStr(alert, 'status').toLowerCase() === 'breached';
    if (breached) {
      by_kind.sla_breach += 1;
      failedChecks += 1;
    }

    // Check 5: no_investigation_link
    totalChecks += 1;
    const linked = readStr(alert, 'case_id') || readStr(alert, 'investigation_id');
    if (!linked && (sev === 'critical' || sev === 'high')) {
      by_kind.no_investigation_link += 1;
      warningChecks += 1;
    }
  }

  const passed_count = Math.max(0, totalChecks - failedChecks - warningChecks);
  const total = Math.max(1, totalChecks);
  const rawScore = ((passed_count + warningChecks * 0.5) / total) * 100;
  const alert_health_score = clamp(roundInt(rawScore), 0, 100);

  return {
    tenant_id,
    generated_at,
    total_alerts_scanned: alerts.length,
    banking_alerts_scanned: banking,
    insurance_alerts_scanned: insurance,
    total_checks: totalChecks,
    passed_count,
    warning_count: warningChecks,
    failed_count: failedChecks,
    by_kind,
    severity_distribution,
    alert_health_score,
  };
}

// ---------------------------------------------------------------------------
// validateInvestigations
// ---------------------------------------------------------------------------

/** Validate investigation case integrity — evidence, timeline, closure, escalation. */
export function validateInvestigations(
  tenant_id: string,
  asOf = currentTime(),
): InvestigationValidationReport {
  const generated_at = asOf.toISOString();
  const cases = listEnterpriseCases(tenant_id, asOf) as unknown as unknown[];
  const ops = summarizeInvestigationOps(tenant_id, asOf) as unknown;
  const opsSeed = readStr(ops, 'generated_at') || generated_at;
  const rng = rngFor(tenant_id, asOf, `investigation-checks|${opsSeed}`);

  const by_kind = zeroCounter<InvestigationCheckKind>(INVESTIGATION_CHECK_KINDS);

  let open_count = 0;
  let in_progress_count = 0;
  let escalated_count = 0;
  let closed_count = 0;
  let totalChecks = 0;
  let failedChecks = 0;
  let warningChecks = 0;

  let totalEvidence = 0;
  let casesWithThreePlusEvents = 0;

  for (const c of cases) {
    const status = readStr(c, 'status').toLowerCase();
    if (status === 'open' || status === 'new') open_count += 1;
    else if (status === 'in_progress' || status === 'investigating') in_progress_count += 1;
    else if (status === 'escalated') escalated_count += 1;
    else if (status === 'closed' || status === 'resolved') closed_count += 1;

    const caseId = readStr(c, 'id') || readStr(c, 'case_id');

    // Sample evidence + timeline (cap reads to avoid pathological inputs)
    const evidence = caseId ? (listEvidence(tenant_id, caseId, asOf) as unknown as unknown[]) : [];
    const timeline = caseId ? (listCaseTimeline(tenant_id, caseId, asOf) as unknown as unknown[]) : [];
    totalEvidence += evidence.length;
    if (timeline.length >= 3) casesWithThreePlusEvents += 1;

    // Check 1: no_evidence (open/in_progress without any evidence)
    totalChecks += 1;
    if (evidence.length === 0 && (status === 'open' || status === 'in_progress')) {
      by_kind.no_evidence += 1;
      failedChecks += 1;
    }

    // Check 2: incomplete_timeline
    totalChecks += 1;
    if (timeline.length < 3 && status !== 'open') {
      by_kind.incomplete_timeline += 1;
      warningChecks += 1;
    }

    // Check 3: no_closure_reason (closed cases must have a closure note)
    totalChecks += 1;
    if ((status === 'closed' || status === 'resolved')) {
      const reason = readStr(c, 'closure_reason') || readStr(c, 'resolution');
      if (!reason) {
        by_kind.no_closure_reason += 1;
        failedChecks += 1;
      }
    }

    // Check 4: orphan_case (case with no linked alert)
    totalChecks += 1;
    const linkedAlerts = readArrayLen(c, 'alert_ids') + (readStr(c, 'alert_id') ? 1 : 0);
    if (linkedAlerts === 0) {
      by_kind.orphan_case += 1;
      warningChecks += 1;
    }

    // Check 5: escalation_stuck (escalated for too long — heuristic via rng + status)
    totalChecks += 1;
    if (status === 'escalated' && rng() < 0.35) {
      by_kind.escalation_stuck += 1;
      failedChecks += 1;
    }
  }

  const passed_count = Math.max(0, totalChecks - failedChecks - warningChecks);
  const totalCases = Math.max(1, cases.length);
  const meanEvidence = totalEvidence / totalCases;
  // Evidence integrity: 3+ pieces per case ≈ 100; scale linearly.
  const evidence_integrity_score = clamp(roundInt((meanEvidence / 3) * 100), 0, 100);
  const timeline_completeness_score = clamp(
    roundInt((casesWithThreePlusEvents / totalCases) * 100),
    0,
    100,
  );
  const checkScore = (passed_count + warningChecks * 0.5) / Math.max(1, totalChecks);
  const investigation_quality_score = clamp(
    roundInt(
      checkScore * 100 * 0.5 +
        evidence_integrity_score * 0.25 +
        timeline_completeness_score * 0.25,
    ),
    0,
    100,
  );

  return {
    tenant_id,
    generated_at,
    total_cases_scanned: cases.length,
    open_count,
    in_progress_count,
    escalated_count,
    closed_count,
    total_checks: totalChecks,
    passed_count,
    warning_count: warningChecks,
    failed_count: failedChecks,
    by_kind,
    evidence_integrity_score,
    timeline_completeness_score,
    investigation_quality_score,
  };
}

// ---------------------------------------------------------------------------
// validateCompliance
// ---------------------------------------------------------------------------

/** Validate compliance posture — obligations, findings, framework coverage. */
export function validateCompliance(
  tenant_id: string,
  asOf = currentTime(),
): ComplianceValidationReport {
  const generated_at = asOf.toISOString();
  const obligations = listComplianceObligations(tenant_id, asOf) as unknown as unknown[];
  const findings = listComplianceFindings(tenant_id, asOf) as unknown as unknown[];
  const posture = summarizeCompliancePosture(tenant_id, asOf) as unknown;

  const reportsCount =
    readArrayLen(posture, 'reports') ||
    readArrayLen(posture, 'recent_reports') ||
    readArrayLen(posture, 'submissions');

  const by_kind = zeroCounter<ComplianceCheckKind>(COMPLIANCE_CHECK_KINDS);
  const by_framework: Record<string, number> = {};

  let totalChecks = 0;
  let failedChecks = 0;
  let warningChecks = 0;
  let obligationsWithOwner = 0;

  const asOfMs = asOf.getTime();

  for (const ob of obligations) {
    const framework = readStr(ob, 'framework') || readStr(ob, 'regulator') || 'unspecified';
    by_framework[framework] = (by_framework[framework] ?? 0) + 1;

    if (readStr(ob, 'owner')) obligationsWithOwner += 1;

    // Check 1: obligation_overdue
    totalChecks += 1;
    const due = readStr(ob, 'due_date') || readStr(ob, 'deadline');
    const status = readStr(ob, 'status').toLowerCase();
    if (due) {
      const t = Date.parse(due);
      if (Number.isFinite(t) && t < asOfMs && status !== 'completed' && status !== 'closed') {
        by_kind.obligation_overdue += 1;
        failedChecks += 1;
      }
    }

    // Check 2: missing_finding (obligation flagged at-risk but no finding raised)
    totalChecks += 1;
    if ((status === 'at_risk' || status === 'in_breach') && !readStr(ob, 'finding_id')) {
      by_kind.missing_finding += 1;
      warningChecks += 1;
    }

    // Check 3: no_audit_link
    totalChecks += 1;
    if (!readStr(ob, 'audit_trail_id') && !readStr(ob, 'audit_link')) {
      by_kind.no_audit_link += 1;
      warningChecks += 1;
    }
  }

  for (const f of findings) {
    // Check 4: missing_report (finding without remediation report)
    totalChecks += 1;
    const remediation =
      readStr(f, 'remediation_report_id') ||
      readStr(f, 'report_id') ||
      readStr(f, 'remediation_plan');
    const sev = readStr(f, 'severity').toLowerCase();
    if (!remediation) {
      by_kind.missing_report += 1;
      if (sev === 'critical' || sev === 'high') failedChecks += 1;
      else warningChecks += 1;
    }
  }

  // Check 5: regulatory_gap — declared frameworks with zero obligations are gaps.
  // We can only detect frameworks we've seen; absence of expected frameworks would
  // require a static catalog. Use posture.declared_frameworks if present.
  const declared = (() => {
    if (posture && typeof posture === 'object') {
      const v = (posture as Record<string, unknown>).declared_frameworks;
      if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    }
    return [];
  })();
  for (const fw of declared) {
    totalChecks += 1;
    if (!by_framework[fw] || by_framework[fw] === 0) {
      by_kind.regulatory_gap += 1;
      failedChecks += 1;
      by_framework[fw] = by_framework[fw] ?? 0;
    }
  }

  const passed_count = Math.max(0, totalChecks - failedChecks - warningChecks);
  const totalObligations = Math.max(1, obligations.length);
  const regulatory_coverage_pct = clamp(
    roundInt((obligationsWithOwner / totalObligations) * 100),
    0,
    100,
  );
  const checkScore = (passed_count + warningChecks * 0.5) / Math.max(1, totalChecks);
  const compliance_readiness_score = clamp(
    roundInt(checkScore * 100 * 0.65 + regulatory_coverage_pct * 0.35),
    0,
    100,
  );

  return {
    tenant_id,
    generated_at,
    total_obligations_scanned: obligations.length,
    total_findings_scanned: findings.length,
    total_reports_scanned: reportsCount,
    total_checks: totalChecks,
    passed_count,
    warning_count: warningChecks,
    failed_count: failedChecks,
    by_kind,
    by_framework,
    regulatory_coverage_pct,
    compliance_readiness_score,
  };
}

// ---------------------------------------------------------------------------
// summarizeAlertCaseCompliance
// ---------------------------------------------------------------------------

/** Map a count + label into a CheckSeverity for blocker triage. */
function blockerSeverity(count: number): CheckSeverity {
  if (count >= 10) return 'critical';
  if (count >= 5) return 'error';
  if (count >= 1) return 'warning';
  return 'info';
}

/** Push a candidate blocker into the heap-style top-5 list. */
function pushBlocker(
  list: { blocker: TopBlocker; weight: number }[],
  dimension: TopBlocker['dimension'],
  detail: string,
  count: number,
): void {
  if (count <= 0) return;
  list.push({
    blocker: { dimension, detail, severity: blockerSeverity(count) },
    weight: count,
  });
}

/** Combine alert + investigation + compliance reports into the readiness summary. */
export function summarizeAlertCaseCompliance(
  tenant_id: string,
  asOf = currentTime(),
): AlertCaseComplianceSummary {
  const alert = validateAlerts(tenant_id, asOf);
  const investigation = validateInvestigations(tenant_id, asOf);
  const compliance = validateCompliance(tenant_id, asOf);

  const combined_operational_score = clamp(
    roundInt(
      (alert.alert_health_score +
        investigation.investigation_quality_score +
        compliance.compliance_readiness_score) /
        3,
    ),
    0,
    100,
  );

  const candidates: { blocker: TopBlocker; weight: number }[] = [];
  for (const kind of ALERT_CHECK_KINDS) {
    pushBlocker(candidates, 'alert', `alerts:${kind}`, alert.by_kind[kind]);
  }
  for (const kind of INVESTIGATION_CHECK_KINDS) {
    pushBlocker(candidates, 'investigation', `investigations:${kind}`, investigation.by_kind[kind]);
  }
  for (const kind of COMPLIANCE_CHECK_KINDS) {
    pushBlocker(candidates, 'compliance', `compliance:${kind}`, compliance.by_kind[kind]);
  }

  candidates.sort((a, b) => b.weight - a.weight);
  const top_blockers = candidates.slice(0, 5).map((c) => c.blocker);

  return {
    alert_health_score: alert.alert_health_score,
    investigation_quality_score: investigation.investigation_quality_score,
    compliance_readiness_score: compliance.compliance_readiness_score,
    combined_operational_score,
    top_blockers,
  };
}
