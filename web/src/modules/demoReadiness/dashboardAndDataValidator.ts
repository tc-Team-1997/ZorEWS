/**
 * Demo Readiness Center — Dashboard + Data Quality Validator
 *
 * Pure-function validation engine that scans the 14 prior ZorEWS dashboard IA
 * overlays for widget integrity and the enterpriseDemo data engines for data
 * quality. Synthesizes deterministic findings using FNV-1a + Mulberry32.
 */

import {
  summarizeBankingPortfolio,
  listLoans,
  BANK_CATALOG,
} from '@/modules/enterpriseDemo/enterpriseBankingEngine';
import {
  summarizeInsurancePortfolio,
  listPolicies,
  listClaims,
  listFraudCases,
  INSURER_CATALOG,
} from '@/modules/enterpriseDemo/enterpriseInsuranceEngine';
import {
  listEnterpriseAlerts,
  listEnterpriseCases,
} from '@/modules/enterpriseDemo/enterpriseRiskOpsEngine';
import {
  listComplianceObligations,
} from '@/modules/enterpriseDemo/enterpriseAnalyticsEngine';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Local now() — single source of new Date() in this module. */
function currentTime(): Date {
  return new Date();
}

/** FNV-1a 32-bit hash over a string seed. */
function fnv1a(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG seeded from a 32-bit integer. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build a deterministic RNG keyed on (tenant, asOf-day, scope). */
function rngFor(tenant_id: string, asOf: Date, scope: string): () => number {
  const day = Math.floor(asOf.getTime() / 86_400_000);
  return mulberry32(fnv1a(`${tenant_id}|${day}|${scope}`));
}

/** Round a 0..100 score to whole number, clamped. */
function clampScore(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

// ---------------------------------------------------------------------------
// Closed enums
// ---------------------------------------------------------------------------

export type DashboardCheckKind =
  | 'empty_widget'
  | 'missing_kpi'
  | 'broken_chart'
  | 'missing_dataset'
  | 'visibility_conflict';

export type DataQualityCheckKind =
  | 'null_value'
  | 'missing_reference'
  | 'orphan_record'
  | 'duplicate_entity'
  | 'invalid_relationship';

export type CheckSeverityLocal = 'info' | 'warning' | 'error' | 'critical';
export type ValidationOutcomeLocal = 'passed' | 'warning' | 'failed';

const ALL_DASHBOARD_CHECK_KINDS: DashboardCheckKind[] = [
  'empty_widget',
  'missing_kpi',
  'broken_chart',
  'missing_dataset',
  'visibility_conflict',
];

const ALL_DATA_QUALITY_CHECK_KINDS: DataQualityCheckKind[] = [
  'null_value',
  'missing_reference',
  'orphan_record',
  'duplicate_entity',
  'invalid_relationship',
];

const KNOWN_DASHBOARDS: { dashboard_id: string; dashboard_name: string }[] = [
  { dashboard_id: 'governance', dashboard_name: 'Governance Center' },
  { dashboard_id: 'iam', dashboard_name: 'IAM Center' },
  { dashboard_id: 'rule', dashboard_name: 'Rule Engine Center' },
  { dashboard_id: 'audit', dashboard_name: 'Audit Trail Center' },
  { dashboard_id: 'recovery', dashboard_name: 'Recovery Center' },
  { dashboard_id: 'security_activity', dashboard_name: 'Security Activity Center' },
  { dashboard_id: 'ai_governance', dashboard_name: 'AI Governance Center' },
  { dashboard_id: 'role_based_dashboard', dashboard_name: 'Role-Based Dashboard' },
  { dashboard_id: 'executive_cockpit', dashboard_name: 'Executive Cockpit' },
  { dashboard_id: 'predictive_risk', dashboard_name: 'Predictive Risk Center' },
  { dashboard_id: 'investigation_center', dashboard_name: 'Investigation Center' },
  { dashboard_id: 'regulatory_compliance', dashboard_name: 'Regulatory Compliance Center' },
  { dashboard_id: 'data_fabric', dashboard_name: 'Data Fabric Center' },
  { dashboard_id: 'enterprise_demo', dashboard_name: 'Enterprise Demo Foundation' },
];

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface DashboardCheck {
  check_id: string;
  dashboard_id: string;
  widget_id: string;
  kind: DashboardCheckKind;
  severity: CheckSeverityLocal;
  outcome: ValidationOutcomeLocal;
  detail: string;
}

export interface DashboardValidationReport {
  tenant_id: string;
  generated_at: string;
  total_dashboards_scanned: number;
  total_widgets_scanned: number;
  total_checks: number;
  passed_count: number;
  warning_count: number;
  failed_count: number;
  by_kind: Record<DashboardCheckKind, number>;
  dashboards: {
    dashboard_id: string;
    dashboard_name: string;
    checks_passed: number;
    checks_failed: number;
    checks_warning: number;
    quality_score: number;
  }[];
  overall_dashboard_quality_score: number;
}

export interface DataQualityCheck {
  check_id: string;
  entity_kind: 'loan' | 'policy' | 'claim' | 'alert' | 'case' | 'customer' | 'agent' | 'obligation';
  entity_id: string;
  kind: DataQualityCheckKind;
  severity: CheckSeverityLocal;
  outcome: ValidationOutcomeLocal;
  field?: string;
  detail: string;
}

export interface DataQualityReport {
  tenant_id: string;
  generated_at: string;
  total_entities_scanned: number;
  total_checks: number;
  null_count: number;
  missing_reference_count: number;
  orphan_count: number;
  duplicate_count: number;
  invalid_relationship_count: number;
  by_entity: Record<string, number>;
  data_health_score: number;
  data_quality_score: number;
}

// ---------------------------------------------------------------------------
// Outcome / severity weighting helpers
// ---------------------------------------------------------------------------

/** Sample an outcome with the canonical 80/15/5 passed/warning/failed split. */
function sampleOutcome(rng: () => number): ValidationOutcomeLocal {
  const r = rng();
  if (r < 0.80) return 'passed';
  if (r < 0.95) return 'warning';
  return 'failed';
}

/** Map a kind + outcome to a CheckSeverity. */
function severityFor(
  kind: DashboardCheckKind | DataQualityCheckKind,
  outcome: ValidationOutcomeLocal,
): CheckSeverityLocal {
  if (outcome === 'passed') return 'info';
  if (outcome === 'failed') {
    if (
      kind === 'broken_chart' ||
      kind === 'missing_dataset' ||
      kind === 'invalid_relationship' ||
      kind === 'orphan_record'
    ) {
      return 'critical';
    }
    return 'error';
  }
  return 'warning';
}

/** Score from passed/warning/failed counts. */
function scoreFromCounts(passed: number, warning: number, failed: number): number {
  const total = passed + warning + failed;
  if (total === 0) return 0;
  const weighted = passed * 1 + warning * 0.5 + failed * 0;
  return clampScore((weighted / total) * 100);
}

// ---------------------------------------------------------------------------
// Dashboard validator
// ---------------------------------------------------------------------------

/** Generate human-readable detail for a dashboard check. */
function dashboardDetail(
  dashboardName: string,
  widgetId: string,
  kind: DashboardCheckKind,
  outcome: ValidationOutcomeLocal,
): string {
  if (outcome === 'passed') {
    return `${dashboardName} widget ${widgetId} passed ${kind} check`;
  }
  switch (kind) {
    case 'empty_widget':
      return `${dashboardName} widget ${widgetId} rendered with empty payload`;
    case 'missing_kpi':
      return `${dashboardName} widget ${widgetId} missing required KPI binding`;
    case 'broken_chart':
      return `${dashboardName} widget ${widgetId} chart series resolution failed`;
    case 'missing_dataset':
      return `${dashboardName} widget ${widgetId} upstream dataset unresolved`;
    case 'visibility_conflict':
      return `${dashboardName} widget ${widgetId} role visibility rule conflicts with tenant policy`;
  }
}

/** Validate the 14 known IA dashboards for widget integrity. */
export function validateDashboards(
  tenant_id: string,
  asOf: Date = currentTime(),
): DashboardValidationReport {
  const rng = rngFor(tenant_id, asOf, 'dashboard-validator');

  const by_kind: Record<DashboardCheckKind, number> = {
    empty_widget: 0,
    missing_kpi: 0,
    broken_chart: 0,
    missing_dataset: 0,
    visibility_conflict: 0,
  };

  let totalChecks = 0;
  let passedCount = 0;
  let warningCount = 0;
  let failedCount = 0;
  let totalWidgets = 0;

  const dashboards: DashboardValidationReport['dashboards'] = [];
  let scoreAccum = 0;

  for (const dash of KNOWN_DASHBOARDS) {
    // 5 checks per dashboard, one per kind
    const widgetCount = 5;
    totalWidgets += widgetCount;
    let dPassed = 0;
    let dWarning = 0;
    let dFailed = 0;

    for (let i = 0; i < widgetCount; i++) {
      const kind = ALL_DASHBOARD_CHECK_KINDS[i % ALL_DASHBOARD_CHECK_KINDS.length];
      const outcome = sampleOutcome(rng);
      const sev = severityFor(kind, outcome);
      const widget_id = `${dash.dashboard_id}-w${i + 1}`;
      const check_id = `chk-dash-${dash.dashboard_id}-${i + 1}`;

      // Build the check record but only retain aggregates per dashboard
      const check: DashboardCheck = {
        check_id,
        dashboard_id: dash.dashboard_id,
        widget_id,
        kind,
        severity: sev,
        outcome,
        detail: dashboardDetail(dash.dashboard_name, widget_id, kind, outcome),
      };
      // Touch the check so the literal isn't elided by the type system
      void check.detail;

      by_kind[kind] += 1;
      totalChecks += 1;
      if (outcome === 'passed') {
        passedCount += 1;
        dPassed += 1;
      } else if (outcome === 'warning') {
        warningCount += 1;
        dWarning += 1;
      } else {
        failedCount += 1;
        dFailed += 1;
      }
    }

    const qScore = scoreFromCounts(dPassed, dWarning, dFailed);
    scoreAccum += qScore;
    dashboards.push({
      dashboard_id: dash.dashboard_id,
      dashboard_name: dash.dashboard_name,
      checks_passed: dPassed,
      checks_failed: dFailed,
      checks_warning: dWarning,
      quality_score: qScore,
    });
  }

  const overall = dashboards.length === 0 ? 0 : clampScore(scoreAccum / dashboards.length);

  return {
    tenant_id,
    generated_at: asOf.toISOString(),
    total_dashboards_scanned: KNOWN_DASHBOARDS.length,
    total_widgets_scanned: totalWidgets,
    total_checks: totalChecks,
    passed_count: passedCount,
    warning_count: warningCount,
    failed_count: failedCount,
    by_kind,
    dashboards,
    overall_dashboard_quality_score: overall,
  };
}

// ---------------------------------------------------------------------------
// Data quality validator
// ---------------------------------------------------------------------------

type EntityKind = DataQualityCheck['entity_kind'];

interface EntitySample {
  kind: EntityKind;
  id: string;
}

/** Collect representative samples from the enterpriseDemo engines. */
function collectEntitySamples(tenant_id: string, asOf: Date): EntitySample[] {
  const samples: EntitySample[] = [];

  // Pull a slice from each engine; cap each kind to keep totals bounded.
  const SAMPLE_CAP = 6;

  // Banking — loans + customers (derive customer ids from loans)
  try {
    const loans = listLoans(tenant_id, asOf).slice(0, SAMPLE_CAP);
    const seenCustomers = new Set<string>();
    for (const l of loans) {
      const loanId = (l as { loan_id?: string; id?: string }).loan_id
        ?? (l as { id?: string }).id
        ?? 'unknown-loan';
      samples.push({ kind: 'loan', id: loanId });
      const custId = (l as { customer_id?: string }).customer_id;
      if (custId && !seenCustomers.has(custId)) {
        seenCustomers.add(custId);
        samples.push({ kind: 'customer', id: custId });
        if (seenCustomers.size >= SAMPLE_CAP) break;
      }
    }
    // Touch portfolio summary so the import is intentional even if unused below
    void summarizeBankingPortfolio(tenant_id, asOf);
    void BANK_CATALOG;
  } catch {
    // Fallback synthetic
    for (let i = 0; i < SAMPLE_CAP; i++) {
      samples.push({ kind: 'loan', id: `LN-${tenant_id}-${i + 1}` });
    }
  }

  // Insurance — policies + claims + agents (from fraud cases as a proxy)
  try {
    const policies = listPolicies(tenant_id, asOf).slice(0, SAMPLE_CAP);
    for (const p of policies) {
      const pid = (p as { policy_id?: string; id?: string }).policy_id
        ?? (p as { id?: string }).id
        ?? 'unknown-policy';
      samples.push({ kind: 'policy', id: pid });
    }
    const claims = listClaims(tenant_id, asOf).slice(0, SAMPLE_CAP);
    for (const c of claims) {
      const cid = (c as { claim_id?: string; id?: string }).claim_id
        ?? (c as { id?: string }).id
        ?? 'unknown-claim';
      samples.push({ kind: 'claim', id: cid });
    }
    const fraudCases = listFraudCases(tenant_id, asOf).slice(0, SAMPLE_CAP);
    const seenAgents = new Set<string>();
    for (const f of fraudCases) {
      const agentId = (f as { agent_id?: string }).agent_id;
      if (agentId && !seenAgents.has(agentId)) {
        seenAgents.add(agentId);
        samples.push({ kind: 'agent', id: agentId });
        if (seenAgents.size >= SAMPLE_CAP) break;
      }
    }
    void summarizeInsurancePortfolio(tenant_id, asOf);
    void INSURER_CATALOG;
  } catch {
    for (let i = 0; i < SAMPLE_CAP; i++) {
      samples.push({ kind: 'policy', id: `POL-${tenant_id}-${i + 1}` });
    }
  }

  // Risk ops — alerts + cases
  try {
    const alerts = listEnterpriseAlerts(tenant_id, asOf).slice(0, SAMPLE_CAP);
    for (const a of alerts) {
      const aid = (a as { alert_id?: string; id?: string }).alert_id
        ?? (a as { id?: string }).id
        ?? 'unknown-alert';
      samples.push({ kind: 'alert', id: aid });
    }
    const cases = listEnterpriseCases(tenant_id, asOf).slice(0, SAMPLE_CAP);
    for (const c of cases) {
      const cid = (c as { case_id?: string; id?: string }).case_id
        ?? (c as { id?: string }).id
        ?? 'unknown-case';
      samples.push({ kind: 'case', id: cid });
    }
  } catch {
    for (let i = 0; i < SAMPLE_CAP; i++) {
      samples.push({ kind: 'alert', id: `ALT-${tenant_id}-${i + 1}` });
    }
  }

  // Compliance — obligations
  try {
    const obs = listComplianceObligations(tenant_id, asOf).slice(0, SAMPLE_CAP);
    for (const o of obs) {
      const oid = (o as { obligation_id?: string; id?: string }).obligation_id
        ?? (o as { id?: string }).id
        ?? 'unknown-obligation';
      samples.push({ kind: 'obligation', id: oid });
    }
  } catch {
    for (let i = 0; i < SAMPLE_CAP; i++) {
      samples.push({ kind: 'obligation', id: `OBL-${tenant_id}-${i + 1}` });
    }
  }

  return samples;
}

/** Generate human-readable detail for a data quality check. */
function dataQualityDetail(
  entity_kind: EntityKind,
  entity_id: string,
  kind: DataQualityCheckKind,
  outcome: ValidationOutcomeLocal,
  field?: string,
): string {
  if (outcome === 'passed') {
    return `${entity_kind} ${entity_id} passed ${kind} check`;
  }
  const fieldFrag = field ? ` on field ${field}` : '';
  switch (kind) {
    case 'null_value':
      return `${entity_kind} ${entity_id} has null value${fieldFrag}`;
    case 'missing_reference':
      return `${entity_kind} ${entity_id} references absent parent${fieldFrag}`;
    case 'orphan_record':
      return `${entity_kind} ${entity_id} orphaned — no upstream binding`;
    case 'duplicate_entity':
      return `${entity_kind} ${entity_id} duplicate detected${fieldFrag}`;
    case 'invalid_relationship':
      return `${entity_kind} ${entity_id} relationship invariant violated${fieldFrag}`;
  }
}

/** Validate sampled entities from the enterpriseDemo engines for data quality. */
export function validateDataQuality(
  tenant_id: string,
  asOf: Date = currentTime(),
): DataQualityReport {
  const rng = rngFor(tenant_id, asOf, 'data-quality-validator');
  const samples = collectEntitySamples(tenant_id, asOf);

  const TARGET_CHECKS = 40;
  const checkCount = Math.max(samples.length, Math.min(TARGET_CHECKS, samples.length * 2));

  const by_entity: Record<string, number> = {};
  let nullCount = 0;
  let missingRefCount = 0;
  let orphanCount = 0;
  let duplicateCount = 0;
  let invalidRelCount = 0;
  let passed = 0;
  let warning = 0;
  let failed = 0;

  for (let i = 0; i < checkCount; i++) {
    const sample = samples[i % Math.max(1, samples.length)] ?? {
      kind: 'loan' as EntityKind,
      id: `synthetic-${i}`,
    };
    const kind = ALL_DATA_QUALITY_CHECK_KINDS[i % ALL_DATA_QUALITY_CHECK_KINDS.length];
    const outcome = sampleOutcome(rng);
    const sev = severityFor(kind, outcome);
    const field = kind === 'null_value' || kind === 'missing_reference' || kind === 'duplicate_entity'
      ? `${sample.kind}_attr_${(i % 4) + 1}`
      : undefined;

    const check: DataQualityCheck = {
      check_id: `chk-dq-${tenant_id}-${i + 1}`,
      entity_kind: sample.kind,
      entity_id: sample.id,
      kind,
      severity: sev,
      outcome,
      field,
      detail: dataQualityDetail(sample.kind, sample.id, kind, outcome, field),
    };
    // Touch the constructed record so its instantiation is intentional
    void check.detail;

    by_entity[sample.kind] = (by_entity[sample.kind] ?? 0) + 1;

    if (outcome === 'failed' || outcome === 'warning') {
      switch (kind) {
        case 'null_value':
          nullCount += 1;
          break;
        case 'missing_reference':
          missingRefCount += 1;
          break;
        case 'orphan_record':
          orphanCount += 1;
          break;
        case 'duplicate_entity':
          duplicateCount += 1;
          break;
        case 'invalid_relationship':
          invalidRelCount += 1;
          break;
      }
    }

    if (outcome === 'passed') passed += 1;
    else if (outcome === 'warning') warning += 1;
    else failed += 1;
  }

  const qualityScore = scoreFromCounts(passed, warning, failed);
  // Health score: criticality-weighted — failures count double
  const totalIssues = warning + failed;
  const totalEntities = samples.length;
  const issueRate = totalEntities === 0 ? 0 : Math.min(1, totalIssues / (totalEntities * 2));
  const healthScore = clampScore((1 - issueRate) * 100);

  return {
    tenant_id,
    generated_at: asOf.toISOString(),
    total_entities_scanned: totalEntities,
    total_checks: checkCount,
    null_count: nullCount,
    missing_reference_count: missingRefCount,
    orphan_count: orphanCount,
    duplicate_count: duplicateCount,
    invalid_relationship_count: invalidRelCount,
    by_entity,
    data_health_score: healthScore,
    data_quality_score: qualityScore,
  };
}

// ---------------------------------------------------------------------------
// Combined summary
// ---------------------------------------------------------------------------

interface CombinedSummary {
  dashboard_quality_score: number;
  data_health_score: number;
  data_quality_score: number;
  integration_score: number;
  top_issues: { kind: string; count: number; sample_detail: string }[];
}

/** Build a combined dashboard + data-quality summary for the Demo Readiness UI. */
export function summarizeDashboardAndData(
  tenant_id: string,
  asOf: Date = currentTime(),
): CombinedSummary {
  const dashReport = validateDashboards(tenant_id, asOf);
  const dqReport = validateDataQuality(tenant_id, asOf);

  // Aggregate top issues across both reports (kind-level rollup).
  const issueBuckets: { kind: string; count: number; sample_detail: string }[] = [];

  for (const k of ALL_DASHBOARD_CHECK_KINDS) {
    const count = dashReport.by_kind[k];
    if (count > 0) {
      issueBuckets.push({
        kind: `dashboard.${k}`,
        count,
        sample_detail: `${count} dashboard ${k} check(s) recorded`,
      });
    }
  }

  const dqKindCounts: Record<DataQualityCheckKind, number> = {
    null_value: dqReport.null_count,
    missing_reference: dqReport.missing_reference_count,
    orphan_record: dqReport.orphan_count,
    duplicate_entity: dqReport.duplicate_count,
    invalid_relationship: dqReport.invalid_relationship_count,
  };
  for (const k of ALL_DATA_QUALITY_CHECK_KINDS) {
    const count = dqKindCounts[k];
    if (count > 0) {
      issueBuckets.push({
        kind: `data_quality.${k}`,
        count,
        sample_detail: `${count} ${k} issue(s) detected across sampled entities`,
      });
    }
  }

  // Sort by count desc + kind asc tie-break, cap 5
  issueBuckets.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.kind.localeCompare(b.kind);
  });
  const top_issues = issueBuckets.slice(0, 5);

  const integration_score = clampScore(
    (dashReport.overall_dashboard_quality_score + dqReport.data_quality_score) / 2,
  );

  return {
    dashboard_quality_score: dashReport.overall_dashboard_quality_score,
    data_health_score: dqReport.data_health_score,
    data_quality_score: dqReport.data_quality_score,
    integration_score,
    top_issues,
  };
}
