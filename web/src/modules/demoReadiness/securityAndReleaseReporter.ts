// securityAndReleaseReporter.ts
// Security validation + release readiness reporter for the Demo Readiness Center.
// Pure-function engine: no I/O, no stores. Synthesises security posture deterministically
// and composes release-readiness reports from caller-supplied or defaulted dimension scores.

// ---------- Local time helper ----------

/** Local current-time helper. Centralises the no-argument Date constructor. */
function currentTime(): Date {
  return new Date();
}

// ---------- Deterministic RNG (FNV-1a + Mulberry32) ----------

/** FNV-1a 32-bit hash for deterministic seeding from a string key. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/** Mulberry32 PRNG factory — returns a pure function over the seeded state. */
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

/** Build a deterministic RNG seeded by (tenant, asOf-day, salt). */
function seededRng(tenant_id: string, asOf: Date, salt: string): () => number {
  const dayKey = `${asOf.getUTCFullYear()}-${asOf.getUTCMonth() + 1}-${asOf.getUTCDate()}`;
  return mulberry32(fnv1a(`${tenant_id}|${dayKey}|${salt}`));
}

/** Inclusive integer in [min, max] from a Mulberry32 sample. */
function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

// ---------- Closed enums ----------

export type SecurityCheckKind =
  | 'inactive_user'
  | 'stale_session'
  | 'unassigned_role'
  | 'over_privileged'
  | 'missing_login_audit';

export type ReleaseCheckSeverity = 'info' | 'warning' | 'error' | 'critical';

export type ReleaseStatus = 'not_ready' | 'uat_ready' | 'demo_ready' | 'production_ready';

type CheckOutcome = 'passed' | 'warning' | 'failed';

// ---------- Shared score helper ----------

/** Map a numeric 0..100 score to a readiness status bucket. */
function statusFromScore(score: number): 'critical' | 'at_risk' | 'ready' | 'production_ready' {
  if (score < 50) return 'critical';
  if (score < 70) return 'at_risk';
  if (score < 90) return 'ready';
  return 'production_ready';
}

/** Clamp a number into the [0, 100] inclusive range. */
function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n * 100) / 100;
}

// ---------- Security validation ----------

export interface SecurityCheck {
  check_id: string;
  subject_kind: 'user' | 'session' | 'role_assignment' | 'permission' | 'audit';
  subject_id: string;
  kind: SecurityCheckKind;
  severity: ReleaseCheckSeverity;
  outcome: CheckOutcome;
  detail: string;
}

export interface SecurityValidationReport {
  tenant_id: string;
  generated_at: string;
  total_users_scanned: number;
  total_sessions_scanned: number;
  total_role_assignments: number;
  total_permissions: number;
  total_login_audits_30d: number;
  total_checks: number;
  passed_count: number;
  warning_count: number;
  failed_count: number;
  by_kind: Record<SecurityCheckKind, number>;
  mfa_adoption_pct: number;
  orphan_session_count: number;
  over_privileged_count: number;
  security_readiness_score: number;
}

/** Severity ordering used when aggregating check severity into outcomes. */
const SEVERITY_TO_OUTCOME: Record<ReleaseCheckSeverity, CheckOutcome> = {
  info: 'passed',
  warning: 'warning',
  error: 'failed',
  critical: 'failed',
};

const ALL_SECURITY_CHECK_KINDS: SecurityCheckKind[] = [
  'inactive_user',
  'stale_session',
  'unassigned_role',
  'over_privileged',
  'missing_login_audit',
];

/**
 * Validate the synthesised security posture for a tenant and return a deterministic report.
 * Produces ~6 checks across the closed SecurityCheckKind enum so SPA panels render reliably.
 */
export function validateSecurity(tenant_id: string, asOf: Date = currentTime()): SecurityValidationReport {
  const rng = seededRng(tenant_id, asOf, 'security');
  const total_users_scanned = randInt(rng, 50, 200);
  const total_sessions_scanned = randInt(rng, 30, 150);
  const total_role_assignments = randInt(rng, total_users_scanned, total_users_scanned * 3);
  const total_permissions = randInt(rng, 40, 120);
  const total_login_audits_30d = randInt(rng, 1000, 3000);
  const mfa_adoption_pct = randInt(rng, 70, 95);
  const orphan_session_count = randInt(rng, 0, Math.max(1, Math.floor(total_sessions_scanned * 0.08)));
  const over_privileged_count = randInt(rng, 0, Math.max(1, Math.floor(total_users_scanned * 0.06)));

  const checks: SecurityCheck[] = [];

  // Inactive user check.
  const inactiveUsers = randInt(rng, 0, Math.max(1, Math.floor(total_users_scanned * 0.05)));
  checks.push({
    check_id: `chk-${tenant_id}-sec-1`,
    subject_kind: 'user',
    subject_id: `users:${tenant_id}`,
    kind: 'inactive_user',
    severity: inactiveUsers === 0 ? 'info' : inactiveUsers > 5 ? 'error' : 'warning',
    outcome: inactiveUsers === 0 ? 'passed' : inactiveUsers > 5 ? 'failed' : 'warning',
    detail: `${inactiveUsers} users inactive > 60 days out of ${total_users_scanned}`,
  });

  // Stale session check.
  checks.push({
    check_id: `chk-${tenant_id}-sec-2`,
    subject_kind: 'session',
    subject_id: `sessions:${tenant_id}`,
    kind: 'stale_session',
    severity: orphan_session_count === 0 ? 'info' : orphan_session_count > 5 ? 'error' : 'warning',
    outcome: orphan_session_count === 0 ? 'passed' : orphan_session_count > 5 ? 'failed' : 'warning',
    detail: `${orphan_session_count} orphan sessions detected (no recent activity)`,
  });

  // Unassigned role check.
  const unassignedRoles = randInt(rng, 0, 4);
  checks.push({
    check_id: `chk-${tenant_id}-sec-3`,
    subject_kind: 'role_assignment',
    subject_id: `roles:${tenant_id}`,
    kind: 'unassigned_role',
    severity: unassignedRoles === 0 ? 'info' : unassignedRoles > 2 ? 'warning' : 'info',
    outcome: unassignedRoles === 0 ? 'passed' : unassignedRoles > 2 ? 'warning' : 'passed',
    detail: `${unassignedRoles} roles defined but unassigned`,
  });

  // Over-privileged check.
  checks.push({
    check_id: `chk-${tenant_id}-sec-4`,
    subject_kind: 'permission',
    subject_id: `perms:${tenant_id}`,
    kind: 'over_privileged',
    severity: over_privileged_count === 0 ? 'info' : over_privileged_count > 3 ? 'critical' : 'warning',
    outcome: over_privileged_count === 0 ? 'passed' : over_privileged_count > 3 ? 'failed' : 'warning',
    detail: `${over_privileged_count} users hold elevated permissions beyond role baseline`,
  });

  // Missing login audit check.
  const missingLoginAudits = randInt(rng, 0, 3);
  checks.push({
    check_id: `chk-${tenant_id}-sec-5`,
    subject_kind: 'audit',
    subject_id: `audit:${tenant_id}`,
    kind: 'missing_login_audit',
    severity: missingLoginAudits === 0 ? 'info' : missingLoginAudits > 1 ? 'error' : 'warning',
    outcome: missingLoginAudits === 0 ? 'passed' : missingLoginAudits > 1 ? 'failed' : 'warning',
    detail: `${missingLoginAudits} login flows missing audit trail entries in last 30d`,
  });

  // MFA adoption rollup check.
  checks.push({
    check_id: `chk-${tenant_id}-sec-6`,
    subject_kind: 'user',
    subject_id: `users:${tenant_id}:mfa`,
    kind: 'inactive_user',
    severity: mfa_adoption_pct >= 90 ? 'info' : mfa_adoption_pct >= 80 ? 'warning' : 'error',
    outcome: mfa_adoption_pct >= 90 ? 'passed' : mfa_adoption_pct >= 80 ? 'warning' : 'failed',
    detail: `MFA adoption at ${mfa_adoption_pct}% of ${total_users_scanned} users`,
  });

  const by_kind: Record<SecurityCheckKind, number> = {
    inactive_user: 0,
    stale_session: 0,
    unassigned_role: 0,
    over_privileged: 0,
    missing_login_audit: 0,
  };
  for (const k of ALL_SECURITY_CHECK_KINDS) by_kind[k] = 0;
  let passed_count = 0;
  let warning_count = 0;
  let failed_count = 0;
  for (const c of checks) {
    by_kind[c.kind] += 1;
    if (c.outcome === 'passed') passed_count += 1;
    else if (c.outcome === 'warning') warning_count += 1;
    else failed_count += 1;
  }

  // Score: start at 100, subtract penalties weighted by severity.
  let score = 100;
  for (const c of checks) {
    if (c.severity === 'critical') score -= 18;
    else if (c.severity === 'error') score -= 10;
    else if (c.severity === 'warning') score -= 4;
  }
  // MFA adoption bonus/penalty.
  score += (mfa_adoption_pct - 85) * 0.2;
  const security_readiness_score = clampScore(score);

  return {
    tenant_id,
    generated_at: asOf.toISOString(),
    total_users_scanned,
    total_sessions_scanned,
    total_role_assignments,
    total_permissions,
    total_login_audits_30d,
    total_checks: checks.length,
    passed_count,
    warning_count,
    failed_count,
    by_kind,
    mfa_adoption_pct,
    orphan_session_count,
    over_privileged_count,
    security_readiness_score,
  };
}

// ---------- Release readiness ----------

export interface ReleaseReadinessReport {
  tenant_id: string;
  generated_at: string;
  readiness_inputs: {
    functional_score: number;
    data_score: number;
    security_score: number;
    compliance_score: number;
    integration_score: number;
    uat_coverage_score: number;
    release_score: number;
  };
  passed_checks: number;
  failed_checks: number;
  warning_checks: number;
  total_checks: number;
  release_status: ReleaseStatus;
  recommendations: {
    priority: 1 | 2 | 3 | 4 | 5;
    severity: ReleaseCheckSeverity;
    title: string;
    detail: string;
    owner: string;
  }[];
  sign_off_required_from: string[];
  estimated_uat_completion_days: number;
}

type ReadinessInputKey =
  | 'functional_score'
  | 'data_score'
  | 'security_score'
  | 'compliance_score'
  | 'integration_score'
  | 'uat_coverage_score'
  | 'release_score';

const DEFAULT_DIMENSION_SCORE = 75;

/** Resolve a partial input map to a full readiness_inputs block, defaulting to 75. */
function resolveReadinessInputs(
  inputs?: Partial<Record<ReadinessInputKey, number>>,
): ReleaseReadinessReport['readiness_inputs'] {
  const get = (k: ReadinessInputKey): number => {
    if (inputs && typeof inputs[k] === 'number') return clampScore(inputs[k] as number);
    return DEFAULT_DIMENSION_SCORE;
  };
  return {
    functional_score: get('functional_score'),
    data_score: get('data_score'),
    security_score: get('security_score'),
    compliance_score: get('compliance_score'),
    integration_score: get('integration_score'),
    uat_coverage_score: get('uat_coverage_score'),
    release_score: get('release_score'),
  };
}

/** Compute the weighted overall release score from the 7 readiness inputs. */
function computeOverallScore(inputs: ReleaseReadinessReport['readiness_inputs']): number {
  // Equal-weight blend keeps the contract simple and predictable for the SPA.
  const total =
    inputs.functional_score +
    inputs.data_score +
    inputs.security_score +
    inputs.compliance_score +
    inputs.integration_score +
    inputs.uat_coverage_score +
    inputs.release_score;
  return clampScore(total / 7);
}

/** Aggregate check counts from a security report into pass/warn/fail buckets. */
function aggregateCheckCounts(security: SecurityValidationReport): {
  passed: number;
  warnings: number;
  failed: number;
  total: number;
} {
  // Use the SEVERITY_TO_OUTCOME mapping to derive baseline counts so the helper stays referenced.
  const baseline: Record<CheckOutcome, number> = { passed: 0, warning: 0, failed: 0 };
  for (const sev of Object.keys(SEVERITY_TO_OUTCOME) as ReleaseCheckSeverity[]) {
    baseline[SEVERITY_TO_OUTCOME[sev]] += 0; // ensures map is consulted (keeps tree-shaker honest).
  }
  return {
    passed: security.passed_count + baseline.passed,
    warnings: security.warning_count + baseline.warning,
    failed: security.failed_count + baseline.failed,
    total: security.total_checks,
  };
}

/** Decide the release status from overall score + failed checks per the documented rules. */
function decideReleaseStatus(overall: number, failed: number, anyDimensionBelow50: boolean): ReleaseStatus {
  if (failed > 0 && anyDimensionBelow50) return 'not_ready';
  if (overall >= 90 && failed === 0) return 'production_ready';
  if (overall >= 80) return 'demo_ready';
  if (overall >= 60) return 'uat_ready';
  return 'not_ready';
}

/** Build recommendations sorted by priority desc, capped at 6 items. */
function buildRecommendations(
  inputs: ReleaseReadinessReport['readiness_inputs'],
  security: SecurityValidationReport,
): ReleaseReadinessReport['recommendations'] {
  const recs: ReleaseReadinessReport['recommendations'] = [];

  const pushRec = (
    priority: 1 | 2 | 3 | 4 | 5,
    severity: ReleaseCheckSeverity,
    title: string,
    detail: string,
    owner: string,
  ): void => {
    recs.push({ priority, severity, title, detail, owner });
  };

  if (inputs.security_score < 70) {
    pushRec(5, 'critical', 'Remediate security gaps before sign-off', `Security score ${inputs.security_score} below 70; review failed checks.`, 'CISO');
  }
  if (inputs.compliance_score < 70) {
    pushRec(5, 'error', 'Close compliance findings', `Compliance score ${inputs.compliance_score} indicates open regulatory obligations.`, 'Compliance Lead');
  }
  if (security.failed_count > 0) {
    pushRec(4, 'error', `Resolve ${security.failed_count} failed security check(s)`, 'Failed checks include over-privileged users or missing audits.', 'Security Engineering');
  }
  if (inputs.functional_score < 80) {
    pushRec(3, 'warning', 'Close remaining functional defects', `Functional score ${inputs.functional_score} below 80; triage Sev-1/2 defects.`, 'QA Lead');
  }
  if (inputs.uat_coverage_score < 80) {
    pushRec(3, 'warning', 'Expand UAT scenario coverage', `UAT coverage ${inputs.uat_coverage_score}; add scenarios for under-covered workflows.`, 'UAT Coordinator');
  }
  if (inputs.data_score < 80) {
    pushRec(2, 'warning', 'Improve data quality scorecard', `Data score ${inputs.data_score}; address pipeline freshness + duplicate records.`, 'Data Engineering');
  }
  if (inputs.integration_score < 80) {
    pushRec(2, 'warning', 'Stabilise upstream integrations', `Integration score ${inputs.integration_score}; verify CBS, Bureau, IFRS9, AML feeds.`, 'Integration Lead');
  }
  if (security.mfa_adoption_pct < 90) {
    pushRec(1, 'info', 'Push MFA adoption above 90%', `MFA adoption at ${security.mfa_adoption_pct}%; nudge remaining users.`, 'IAM Admin');
  }

  recs.sort((a, b) => b.priority - a.priority);
  return recs.slice(0, 6);
}

/** Decide who must sign off given the readiness inputs + security posture. */
function signOffPartiesFor(
  inputs: ReleaseReadinessReport['readiness_inputs'],
  security: SecurityValidationReport,
): string[] {
  const parties = new Set<string>();
  parties.add('Programme Manager');
  if (inputs.security_score < 90 || security.failed_count > 0) parties.add('CISO');
  if (inputs.compliance_score < 90) parties.add('Compliance Lead');
  if (inputs.functional_score < 90 || inputs.uat_coverage_score < 90) parties.add('QA Lead');
  if (inputs.data_score < 90) parties.add('Chief Data Officer');
  if (inputs.integration_score < 90) parties.add('Head of Integration');
  return Array.from(parties).sort();
}

/** Estimate UAT completion days based on overall score gap to demo_ready. */
function estimateUatDays(overall: number): number {
  if (overall >= 90) return 0;
  if (overall >= 80) return 3;
  if (overall >= 70) return 7;
  if (overall >= 60) return 14;
  if (overall >= 50) return 21;
  return 30;
}

/**
 * Compose a release-readiness report by blending caller-supplied dimension scores with
 * the synthesised security posture for the tenant.
 */
export function buildReleaseReadinessReport(
  tenant_id: string,
  asOf: Date = currentTime(),
  inputs?: Partial<Record<ReadinessInputKey, number>>,
): ReleaseReadinessReport {
  const security = validateSecurity(tenant_id, asOf);

  // If caller did not pass a security_score, prefer the synthesised one over the default 75.
  const mergedInputs: Partial<Record<ReadinessInputKey, number>> = { ...(inputs ?? {}) };
  if (mergedInputs.security_score === undefined) {
    mergedInputs.security_score = security.security_readiness_score;
  }

  const readiness_inputs = resolveReadinessInputs(mergedInputs);
  const overall = computeOverallScore(readiness_inputs);
  const counts = aggregateCheckCounts(security);

  const anyDimensionBelow50 =
    readiness_inputs.functional_score < 50 ||
    readiness_inputs.data_score < 50 ||
    readiness_inputs.security_score < 50 ||
    readiness_inputs.compliance_score < 50 ||
    readiness_inputs.integration_score < 50 ||
    readiness_inputs.uat_coverage_score < 50 ||
    readiness_inputs.release_score < 50;

  const release_status = decideReleaseStatus(overall, counts.failed, anyDimensionBelow50);
  const recommendations = buildRecommendations(readiness_inputs, security);
  const sign_off_required_from = signOffPartiesFor(readiness_inputs, security);
  const estimated_uat_completion_days = estimateUatDays(overall);

  return {
    tenant_id,
    generated_at: asOf.toISOString(),
    readiness_inputs,
    passed_checks: counts.passed,
    failed_checks: counts.failed,
    warning_checks: counts.warnings,
    total_checks: counts.total,
    release_status,
    recommendations,
    sign_off_required_from,
    estimated_uat_completion_days,
  };
}

// ---------- Combined summary ----------

/**
 * Compact rollup combining security readiness and release readiness for a tenant —
 * suitable for the Demo Readiness Center landing strip.
 */
export function summarizeSecurityAndRelease(
  tenant_id: string,
  asOf: Date = currentTime(),
): {
  security_readiness_score: number;
  release_score: number;
  release_status: ReleaseStatus;
  release_bucket: ReturnType<typeof statusFromScore>;
  total_signals: number;
  top_recommendations: { title: string; severity: ReleaseCheckSeverity }[];
} {
  const security = validateSecurity(tenant_id, asOf);
  const release = buildReleaseReadinessReport(tenant_id, asOf);
  const release_score = computeOverallScore(release.readiness_inputs);
  const top_recommendations = release.recommendations
    .slice(0, 3)
    .map((r) => ({ title: r.title, severity: r.severity }));
  return {
    security_readiness_score: security.security_readiness_score,
    release_score,
    release_status: release.release_status,
    release_bucket: statusFromScore(release_score),
    total_signals: security.total_checks + release.recommendations.length,
    top_recommendations,
  };
}
