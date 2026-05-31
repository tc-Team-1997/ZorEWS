/**
 * Demo Readiness Center — core scoring + readiness aggregation engine.
 *
 * Pure-function engine: no I/O, no React, no stores. Composes optional
 * per-dimension inputs from sibling validator modules and produces an
 * overall readiness verdict + UAT coverage rollup.
 */

import { BANK_CATALOG } from '@/modules/enterpriseDemo/enterpriseBankingEngine';
import { INSURER_CATALOG } from '@/modules/enterpriseDemo/enterpriseInsuranceEngine';

// ---------- Local helpers ----------

/** Returns the current Date (single canonical time source for this module). */
function currentTime(): Date {
  return new Date();
}

/** FNV-1a 32-bit hash for deterministic synthesis seeds. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/** Mulberry32 PRNG seeded from a 32-bit integer. */
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

/** YYYY-MM-DD UTC slice for deterministic per-day seeds. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Round to a fixed number of decimal places. */
function round(value: number, decimals = 0): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/** Clamp a numeric score to [0, 100]. */
function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score < 0) return 0;
  if (score > 100) return 100;
  return score;
}

// ---------- Closed enums ----------

/** Canonical readiness status values, worst-first then best. */
export const READINESS_STATUSES = ['critical', 'at_risk', 'ready', 'production_ready'] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

/** Canonical readiness dimensions in display + weighting order. */
export const READINESS_DIMENSIONS = [
  'functional',
  'data',
  'security',
  'compliance',
  'integration',
  'uat_coverage',
  'release',
] as const;
export type ReadinessDimension = (typeof READINESS_DIMENSIONS)[number];

/** Severity vocabulary for individual readiness checks. */
export const CHECK_SEVERITIES = ['info', 'warning', 'error', 'critical'] as const;
export type CheckSeverity = (typeof CHECK_SEVERITIES)[number];

/** Outcome vocabulary for validation runs (UAT scenarios, etc.). */
export const VALIDATION_OUTCOMES = ['passed', 'warning', 'failed'] as const;
export type ValidationOutcome = (typeof VALIDATION_OUTCOMES)[number];

/** Release-readiness ladder. */
export const RELEASE_STATUSES = ['not_ready', 'uat_ready', 'demo_ready', 'production_ready'] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

// ---------- Role gating ----------

/** Roles permitted to view the Demo Readiness Center overlay. */
export const DEMO_READINESS_ROLES: readonly string[] = [
  'admin',
  'supervisor',
  'risk_analyst',
  'super_admin',
  'country_admin',
  'bank_admin',
  'insurance_admin',
  'fraud_analyst',
  'auditor',
  'compliance_officer',
  'operations_user',
  'executive',
  'cdo',
  'cro',
  'ceo',
  'board_member',
];

/** True when any of the viewer's roles grants access to the Readiness Center. */
export function canAccessDemoReadinessCenter(roles: readonly string[] | undefined): boolean {
  if (!roles || roles.length === 0) return false;
  const allowed = new Set(DEMO_READINESS_ROLES);
  for (const r of roles) {
    if (allowed.has(r)) return true;
  }
  return false;
}

// ---------- Scoring primitives ----------

/** Map a 0..100 score to a ReadinessStatus per the standard banding. */
export function statusFromScore(score: number): ReadinessStatus {
  const s = clampScore(score);
  if (s < 50) return 'critical';
  if (s < 70) return 'at_risk';
  if (s < 90) return 'ready';
  return 'production_ready';
}

/** Per-dimension weight used by the overall composite score (sums to 1.0). */
export function weightForDimension(dim: ReadinessDimension): number {
  switch (dim) {
    case 'functional':
      return 0.2;
    case 'data':
      return 0.18;
    case 'security':
      return 0.15;
    case 'compliance':
      return 0.15;
    case 'integration':
      return 0.12;
    case 'uat_coverage':
      return 0.1;
    case 'release':
      return 0.1;
  }
}

/** Human-friendly label for a readiness dimension. */
function labelForDimension(dim: ReadinessDimension): string {
  switch (dim) {
    case 'functional':
      return 'Functional Coverage';
    case 'data':
      return 'Data Quality & Fabric';
    case 'security':
      return 'Security & IAM';
    case 'compliance':
      return 'Regulatory Compliance';
    case 'integration':
      return 'Integration Health';
    case 'uat_coverage':
      return 'UAT Scenario Coverage';
    case 'release':
      return 'Release Governance';
  }
}

/** Weighted-average composite of dimension scores, rounded to whole number. */
export function computeOverallScore(dimensions: ReadinessDimensionScore[]): number {
  if (dimensions.length === 0) return 0;
  let totalWeight = 0;
  let weighted = 0;
  for (const d of dimensions) {
    const w = d.weight > 0 ? d.weight : weightForDimension(d.dimension);
    weighted += clampScore(d.score) * w;
    totalWeight += w;
  }
  if (totalWeight <= 0) return 0;
  return round(weighted / totalWeight, 0);
}

/** Map an overall score + critical-issue count to a release-readiness state. */
export function releaseStatusFromScore(score: number, criticals: number): ReleaseStatus {
  if (criticals > 0) return 'not_ready';
  const s = clampScore(score);
  if (s >= 90) return 'production_ready';
  if (s >= 80) return 'demo_ready';
  if (s >= 60) return 'uat_ready';
  return 'not_ready';
}

// ---------- Public shapes ----------

export interface ReadinessDimensionScore {
  dimension: ReadinessDimension;
  label: string;
  score: number;
  status: ReadinessStatus;
  checks_passed: number;
  checks_failed: number;
  checks_warning: number;
  weight: number;
}

export interface OverallReadiness {
  tenant_id: string;
  generated_at: string;
  overall_score: number;
  overall_status: ReadinessStatus;
  dimensions: ReadinessDimensionScore[];
  critical_issues_count: number;
  warnings_count: number;
  total_checks: number;
  recommended_next_steps: string[];
  release_status: ReleaseStatus;
}

export interface UatScenarioCoverage {
  scenario_id: string;
  name: string;
  module: 'banking' | 'insurance' | 'cross_domain' | 'admin';
  outcome: ValidationOutcome;
  last_run_at: string;
  owner: string;
}

type DimensionInput = {
  score: number;
  passed: number;
  failed: number;
  warning: number;
};

// ---------- Synthesis helpers ----------

/** Deterministic placeholder dimension score when no injected input is provided. */
function synthesiseDimension(
  tenant_id: string,
  asOf: Date,
  dim: ReadinessDimension,
): DimensionInput {
  const rng = mulberry32(fnv1a(`${tenant_id}|${dayKey(asOf)}|${dim}`));
  // Anchor scores in a healthy-but-imperfect band so the overlay reads as
  // "ready, with attention items" by default.
  const base = 70 + rng() * 25; // 70..95
  const score = round(base, 0);
  const totalChecks = 12 + Math.floor(rng() * 9); // 12..20
  // Distribute checks proportional to the score band.
  const failedRatio = score >= 90 ? 0 : score >= 80 ? 0.05 : score >= 70 ? 0.12 : 0.25;
  const warnRatio = score >= 90 ? 0.05 : score >= 80 ? 0.1 : score >= 70 ? 0.18 : 0.25;
  const failed = Math.min(totalChecks, Math.round(totalChecks * failedRatio));
  const warning = Math.min(totalChecks - failed, Math.round(totalChecks * warnRatio));
  const passed = Math.max(0, totalChecks - failed - warning);
  return { score, passed, failed, warning };
}

/** Build a ReadinessDimensionScore row from a raw DimensionInput. */
function buildDimensionScore(dim: ReadinessDimension, input: DimensionInput): ReadinessDimensionScore {
  const score = clampScore(input.score);
  return {
    dimension: dim,
    label: labelForDimension(dim),
    score,
    status: statusFromScore(score),
    checks_passed: Math.max(0, Math.round(input.passed)),
    checks_failed: Math.max(0, Math.round(input.failed)),
    checks_warning: Math.max(0, Math.round(input.warning)),
    weight: weightForDimension(dim),
  };
}

// ---------- Overall readiness composition ----------

/**
 * Compose the overall readiness verdict from per-dimension inputs.
 * Any dimension missing from `dimensionInputs` is synthesised deterministically
 * per (tenant_id, day, dimension).
 */
export function buildOverallReadiness(
  tenant_id: string,
  asOf: Date = currentTime(),
  dimensionInputs?: Partial<Record<ReadinessDimension, DimensionInput>>,
): OverallReadiness {
  const dimensions: ReadinessDimensionScore[] = READINESS_DIMENSIONS.map((dim) => {
    const provided = dimensionInputs?.[dim];
    const input = provided ?? synthesiseDimension(tenant_id, asOf, dim);
    return buildDimensionScore(dim, input);
  });

  const overall_score = computeOverallScore(dimensions);
  const overall_status = statusFromScore(overall_score);

  let criticals = 0;
  let warnings = 0;
  let totalChecks = 0;
  for (const d of dimensions) {
    criticals += d.checks_failed;
    warnings += d.checks_warning;
    totalChecks += d.checks_passed + d.checks_failed + d.checks_warning;
  }

  const release_status = releaseStatusFromScore(overall_score, criticals);
  const recommended_next_steps = generateRecommendations(dimensions);

  return {
    tenant_id,
    generated_at: asOf.toISOString(),
    overall_score,
    overall_status,
    dimensions,
    critical_issues_count: criticals,
    warnings_count: warnings,
    total_checks: totalChecks,
    recommended_next_steps,
    release_status,
  };
}

// ---------- UAT coverage ----------

const UAT_MODULES: ReadonlyArray<UatScenarioCoverage['module']> = [
  'banking',
  'banking',
  'banking',
  'banking',
  'banking',
  'banking',
  'insurance',
  'insurance',
  'insurance',
  'insurance',
  'insurance',
  'insurance',
  'cross_domain',
  'cross_domain',
  'cross_domain',
  'cross_domain',
  'admin',
  'admin',
  'admin',
  'admin',
];

const UAT_NAMES: readonly string[] = [
  'Retail loan origination — happy path',
  'NPA staging migration end-to-end',
  'Suspicious wire transfer alert routing',
  'Mortgage prepayment churn flow',
  'CBS reconciliation break detection',
  'Cross-bank exposure aggregation',
  'Life policy lapse intervention',
  'Health claim fast-track approval',
  'Motor claim fraud ring detection',
  'Renewal premium dunning cycle',
  'Bancassurance cross-sell scoring',
  'Reinsurance recovery posting',
  'Customer 360 across bank + insurer',
  'Cross-domain fraud correlation',
  'Joint risk score for VIP segment',
  'Group-level regulatory rollup',
  'Admin tenant provisioning',
  'Role-based access overlay sanity',
  'Audit trail integrity verification',
  'Release manifest sign-off workflow',
];

/** Owner pool for synthetic UAT scenario assignment. */
const UAT_OWNERS: readonly string[] = [
  'qa.alice',
  'qa.bob',
  'qa.carol',
  'qa.dinesh',
  'qa.evelyn',
  'qa.farhan',
];

/** Deterministic list of 20 UAT scenarios across banking / insurance / cross-domain / admin. */
export function listUatScenarioCoverage(
  tenant_id: string,
  asOf: Date = currentTime(),
): UatScenarioCoverage[] {
  const rng = mulberry32(fnv1a(`${tenant_id}|uat|${dayKey(asOf)}`));
  // Anchor cohort sizing roughly against the imported catalogs so the
  // synthesis feels proportional to the demo dataset.
  const bankAnchor = BANK_CATALOG.length;
  const insurerAnchor = INSURER_CATALOG.length;
  const anchor = Math.max(1, bankAnchor + insurerAnchor);
  const results: UatScenarioCoverage[] = [];
  for (let i = 0; i < UAT_MODULES.length; i++) {
    const moduleId = UAT_MODULES[i]!;
    const name = UAT_NAMES[i] ?? `Scenario ${i + 1}`;
    const roll = rng();
    // 70 / 20 / 10 split for passed / warning / failed.
    let outcome: ValidationOutcome;
    if (roll < 0.7) outcome = 'passed';
    else if (roll < 0.9) outcome = 'warning';
    else outcome = 'failed';
    const ownerIdx = Math.floor(rng() * UAT_OWNERS.length);
    const ageHours = Math.floor(rng() * 72); // last 3 days
    const lastRun = new Date(asOf.getTime() - ageHours * 3600_000);
    const scenario_id = `UAT-${moduleId.toUpperCase().slice(0, 3)}-${String(
      (i + 1) * 11 + (anchor % 7),
    ).padStart(4, '0')}`;
    results.push({
      scenario_id,
      name,
      module: moduleId,
      outcome,
      last_run_at: lastRun.toISOString(),
      owner: UAT_OWNERS[ownerIdx]!,
    });
  }
  return results;
}

/** Rollup of the deterministic UAT scenario list — counts + per-module breakdown. */
export function summarizeUatCoverage(
  tenant_id: string,
  asOf: Date = currentTime(),
): {
  total_scenarios: number;
  passed: number;
  warning: number;
  failed: number;
  coverage_pct: number;
  by_module: Record<'banking' | 'insurance' | 'cross_domain' | 'admin', number>;
} {
  const scenarios = listUatScenarioCoverage(tenant_id, asOf);
  const by_module: Record<'banking' | 'insurance' | 'cross_domain' | 'admin', number> = {
    banking: 0,
    insurance: 0,
    cross_domain: 0,
    admin: 0,
  };
  let passed = 0;
  let warning = 0;
  let failed = 0;
  for (const s of scenarios) {
    by_module[s.module] += 1;
    if (s.outcome === 'passed') passed += 1;
    else if (s.outcome === 'warning') warning += 1;
    else failed += 1;
  }
  const total_scenarios = scenarios.length;
  // Coverage % counts passed at full weight and warnings at half.
  const coverage_pct =
    total_scenarios === 0 ? 0 : round(((passed + warning * 0.5) / total_scenarios) * 100, 0);
  return { total_scenarios, passed, warning, failed, coverage_pct, by_module };
}

// ---------- Recommendations ----------

/** Recommendation copy per dimension, surfaced when that dimension underperforms. */
function recommendationForDimension(dim: ReadinessDimension): string {
  switch (dim) {
    case 'functional':
      return 'Close out remaining functional defects flagged by the validator suite before the next demo gate.';
    case 'data':
      return 'Run a data fabric quality refresh and resolve outstanding quality scorecard failures.';
    case 'security':
      return 'Address IAM + security activity warnings — review privileged role assignments and MFA coverage.';
    case 'compliance':
      return 'Clear open regulatory findings and re-attest outstanding compliance obligations.';
    case 'integration':
      return 'Re-test upstream integrations (CBS, IFRS9, AML, bureau) — degraded pipelines lower the overall score.';
    case 'uat_coverage':
      return 'Boost UAT scenario coverage — rerun failed scenarios and add cross-domain happy + edge paths.';
    case 'release':
      return 'Walk the release governance checklist with the change advisory board before flipping to demo_ready.';
  }
}

/**
 * Generate up to 6 prioritised recommendations sorted by lowest-scoring
 * dimensions. Dimensions already at production_ready are skipped.
 */
export function generateRecommendations(dimensions: ReadinessDimensionScore[]): string[] {
  const candidates = dimensions.filter((d) => d.status !== 'production_ready');
  candidates.sort((a, b) => a.score - b.score);
  const top = candidates.slice(0, 6);
  return top.map((d) => recommendationForDimension(d.dimension));
}
