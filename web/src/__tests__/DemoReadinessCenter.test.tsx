// Demo Readiness Center — page render + role gate + pure-resolver suites.

import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { DemoReadinessCenterPage } from '@/modules/demoReadiness/DemoReadinessCenterPage';
import {
  CHECK_SEVERITIES, DEMO_READINESS_ROLES, READINESS_DIMENSIONS,
  READINESS_STATUSES, RELEASE_STATUSES, VALIDATION_OUTCOMES,
  buildOverallReadiness, canAccessDemoReadinessCenter, computeOverallScore,
  generateRecommendations, listUatScenarioCoverage, releaseStatusFromScore,
  statusFromScore, summarizeUatCoverage, weightForDimension,
  type ReadinessDimensionScore,
} from '@/modules/demoReadiness/readinessEngine';
import {
  summarizeFlowAndRoles, validateBankingFlow, validateFlows,
  validateInsuranceFlow, validateRoleAccess,
} from '@/modules/demoReadiness/flowAndRoleValidator';
import {
  summarizeDashboardAndData, validateDashboards, validateDataQuality,
} from '@/modules/demoReadiness/dashboardAndDataValidator';
import {
  summarizeAlertCaseCompliance, validateAlerts, validateCompliance,
  validateInvestigations,
} from '@/modules/demoReadiness/alertCaseComplianceValidator';
import {
  buildReleaseReadinessReport, summarizeSecurityAndRelease, validateSecurity,
} from '@/modules/demoReadiness/securityAndReleaseReporter';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

type AnyRole =
  | 'admin' | 'supervisor' | 'risk_analyst' | 'fraud_analyst' | 'auditor'
  | 'compliance_officer' | 'field_officer' | 'investigator';

function setUser(role: AnyRole) {
  const user = { id: 'u-001', username: `t.${role}`, roles: [role] as AnyRole[] };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'mock');
  useAuth.setState({ status: 'authenticated', user: user as never, token: 'mock' });
}

function renderRoute() {
  return renderWithProviders(
    <Routes>
      <Route path="/demo-readiness-center" element={<DemoReadinessCenterPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: '/demo-readiness-center' },
  );
}

beforeEach(() => { localStorage.clear(); });

const TENANT = 'BANK_DEMO';
const ASOF = new Date('2026-05-31T08:00:00Z');

// ───────────────────────────────────────────────────────────────────────────
// Role gate + closed enums
// ───────────────────────────────────────────────────────────────────────────

describe('canAccessDemoReadinessCenter', () => {
  it('grants admin / supervisor / risk_analyst', () => {
    expect(canAccessDemoReadinessCenter(['admin'])).toBe(true);
    expect(canAccessDemoReadinessCenter(['supervisor'])).toBe(true);
    expect(canAccessDemoReadinessCenter(['risk_analyst'])).toBe(true);
  });
  it('grants the 16 enterprise personas in DEMO_READINESS_ROLES', () => {
    for (const role of DEMO_READINESS_ROLES) {
      expect(canAccessDemoReadinessCenter([role])).toBe(true);
    }
  });
  it('refuses field_officer / investigator / empty', () => {
    expect(canAccessDemoReadinessCenter(['field_officer'])).toBe(false);
    expect(canAccessDemoReadinessCenter([])).toBe(false);
    expect(canAccessDemoReadinessCenter(undefined)).toBe(false);
  });
});

describe('Closed enums', () => {
  it('READINESS_STATUSES = 4', () => {
    expect(READINESS_STATUSES).toEqual(['critical', 'at_risk', 'ready', 'production_ready']);
  });
  it('READINESS_DIMENSIONS = 7', () => {
    expect(READINESS_DIMENSIONS).toEqual([
      'functional', 'data', 'security', 'compliance',
      'integration', 'uat_coverage', 'release',
    ]);
  });
  it('CHECK_SEVERITIES = info..critical (4)', () => {
    expect(CHECK_SEVERITIES.length).toBe(4);
  });
  it('VALIDATION_OUTCOMES = passed | warning | failed', () => {
    expect(VALIDATION_OUTCOMES).toEqual(['passed', 'warning', 'failed']);
  });
  it('RELEASE_STATUSES = 4', () => {
    expect(RELEASE_STATUSES).toEqual(['not_ready', 'uat_ready', 'demo_ready', 'production_ready']);
  });
});

describe('Scoring primitives', () => {
  it('statusFromScore boundaries', () => {
    expect(statusFromScore(0)).toBe('critical');
    expect(statusFromScore(49)).toBe('critical');
    expect(statusFromScore(50)).toBe('at_risk');
    expect(statusFromScore(69)).toBe('at_risk');
    expect(statusFromScore(70)).toBe('ready');
    expect(statusFromScore(89)).toBe('ready');
    expect(statusFromScore(90)).toBe('production_ready');
    expect(statusFromScore(100)).toBe('production_ready');
  });
  it('weightForDimension sums to 1.0 across all 7', () => {
    let sum = 0;
    for (const d of READINESS_DIMENSIONS) sum += weightForDimension(d);
    expect(sum).toBeCloseTo(1.0, 2);
  });
  it('releaseStatusFromScore handles criticals override', () => {
    expect(releaseStatusFromScore(95, 0)).toBe('production_ready');
    expect(releaseStatusFromScore(95, 1)).toBe('not_ready');
    expect(releaseStatusFromScore(85, 0)).toBe('demo_ready');
    expect(releaseStatusFromScore(70, 0)).toBe('uat_ready');
    expect(releaseStatusFromScore(40, 0)).toBe('not_ready');
  });
  it('computeOverallScore weighted average', () => {
    const dims: ReadinessDimensionScore[] = READINESS_DIMENSIONS.map((dim) => ({
      dimension: dim,
      label: dim,
      score: 80,
      status: 'ready',
      checks_passed: 10, checks_failed: 0, checks_warning: 0,
      weight: weightForDimension(dim),
    }));
    expect(computeOverallScore(dims)).toBe(80);
  });
});

describe('UAT coverage', () => {
  it('listUatScenarioCoverage returns 20 scenarios', () => {
    const list = listUatScenarioCoverage(TENANT, ASOF);
    expect(list.length).toBe(20);
    for (const s of list) {
      expect(['banking', 'insurance', 'cross_domain', 'admin']).toContain(s.module);
      expect(VALIDATION_OUTCOMES).toContain(s.outcome);
    }
  });
  it('summarizeUatCoverage partitions', () => {
    const sum = summarizeUatCoverage(TENANT, ASOF);
    expect(sum.total_scenarios).toBe(20);
    expect(sum.passed + sum.warning + sum.failed).toBe(20);
    expect(sum.coverage_pct).toBeGreaterThanOrEqual(0);
    expect(sum.coverage_pct).toBeLessThanOrEqual(100);
  });
});

describe('buildOverallReadiness', () => {
  it('produces 7 dimension scores with overall composite', () => {
    const r = buildOverallReadiness(TENANT, ASOF);
    expect(r.dimensions.length).toBe(7);
    expect(r.overall_score).toBeGreaterThanOrEqual(0);
    expect(r.overall_score).toBeLessThanOrEqual(100);
    expect(READINESS_STATUSES).toContain(r.overall_status);
    expect(RELEASE_STATUSES).toContain(r.release_status);
  });
  it('respects dimensionInputs override', () => {
    const r = buildOverallReadiness(TENANT, ASOF, {
      functional: { score: 95, passed: 50, failed: 0, warning: 2 },
      data: { score: 92, passed: 40, failed: 0, warning: 3 },
      security: { score: 90, passed: 30, failed: 0, warning: 1 },
      compliance: { score: 88, passed: 25, failed: 1, warning: 4 },
      integration: { score: 87, passed: 20, failed: 0, warning: 2 },
      uat_coverage: { score: 80, passed: 15, failed: 1, warning: 4 },
      release: { score: 85, passed: 12, failed: 0, warning: 3 },
    });
    expect(r.overall_score).toBeGreaterThanOrEqual(80);
  });
});

describe('generateRecommendations', () => {
  it('returns hints when scores low', () => {
    const dims: ReadinessDimensionScore[] = READINESS_DIMENSIONS.map((dim) => ({
      dimension: dim,
      label: dim,
      score: dim === 'security' ? 40 : 90,
      status: 'ready',
      checks_passed: 0, checks_failed: 0, checks_warning: 0,
      weight: weightForDimension(dim),
    }));
    const recs = generateRecommendations(dims);
    expect(recs.length).toBeGreaterThan(0);
  });
  it('returns empty / minimal when all high', () => {
    const dims: ReadinessDimensionScore[] = READINESS_DIMENSIONS.map((dim) => ({
      dimension: dim, label: dim, score: 95, status: 'production_ready',
      checks_passed: 0, checks_failed: 0, checks_warning: 0,
      weight: weightForDimension(dim),
    }));
    const recs = generateRecommendations(dims);
    expect(recs.length).toBeLessThanOrEqual(6);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Flow + role validators
// ───────────────────────────────────────────────────────────────────────────

describe('Flow validation', () => {
  it('validateBankingFlow returns ≥ 1 check', () => {
    const checks = validateBankingFlow(TENANT, ASOF);
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) expect(c.kind).toBe('banking');
  });
  it('validateInsuranceFlow returns ≥ 1 check', () => {
    const checks = validateInsuranceFlow(TENANT, ASOF);
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) expect(c.kind).toBe('insurance');
  });
  it('validateFlows summary partitions + score', () => {
    const r = validateFlows(TENANT, ASOF);
    expect(r.total_checks).toBe(r.passed_count + r.warning_count + r.failed_count);
    expect(r.flow_health_score).toBeGreaterThanOrEqual(0);
    expect(r.flow_health_score).toBeLessThanOrEqual(100);
  });
  it('summarizeFlowAndRoles composes flow + role scores', () => {
    const s = summarizeFlowAndRoles(TENANT, ASOF);
    expect(s.combined_functional_score).toBeGreaterThanOrEqual(0);
    expect(s.combined_functional_score).toBeLessThanOrEqual(100);
  });
});

describe('Role access validation', () => {
  it('validateRoleAccess returns all 9 personas × 5 axes = 45 rows', () => {
    const r = validateRoleAccess(TENANT, ASOF);
    expect(r.total_personas).toBe(9);
    expect(r.total_checks).toBe(45);
    expect(r.passed_count + r.warning_count + r.failed_count).toBe(45);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Dashboard + data quality validators
// ───────────────────────────────────────────────────────────────────────────

describe('Dashboard + data quality', () => {
  it('validateDashboards scans 14 known dashboards', () => {
    const r = validateDashboards(TENANT, ASOF);
    expect(r.total_dashboards_scanned).toBe(14);
    expect(r.total_widgets_scanned).toBeGreaterThan(0);
    expect(r.overall_dashboard_quality_score).toBeGreaterThanOrEqual(0);
    expect(r.overall_dashboard_quality_score).toBeLessThanOrEqual(100);
  });
  it('validateDataQuality returns finite scores', () => {
    const r = validateDataQuality(TENANT, ASOF);
    expect(r.data_health_score).toBeGreaterThanOrEqual(0);
    expect(r.data_quality_score).toBeGreaterThanOrEqual(0);
    expect(r.total_entities_scanned).toBeGreaterThan(0);
  });
  it('summarizeDashboardAndData composes integration score', () => {
    const s = summarizeDashboardAndData(TENANT, ASOF);
    expect(s.integration_score).toBeGreaterThanOrEqual(0);
    expect(s.integration_score).toBeLessThanOrEqual(100);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Alert + investigation + compliance validators
// ───────────────────────────────────────────────────────────────────────────

describe('Alert + investigation + compliance', () => {
  it('validateAlerts: banking + insurance partitions', () => {
    const r = validateAlerts(TENANT, ASOF);
    expect(r.banking_alerts_scanned + r.insurance_alerts_scanned).toBe(r.total_alerts_scanned);
    expect(r.alert_health_score).toBeGreaterThanOrEqual(0);
  });
  it('validateInvestigations: open/in_progress/escalated/closed partition', () => {
    const r = validateInvestigations(TENANT, ASOF);
    expect(r.open_count + r.in_progress_count + r.escalated_count + r.closed_count).toBe(r.total_cases_scanned);
    expect(r.evidence_integrity_score).toBeGreaterThanOrEqual(0);
    expect(r.timeline_completeness_score).toBeGreaterThanOrEqual(0);
  });
  it('validateCompliance: regulatory coverage in [0,100]', () => {
    const r = validateCompliance(TENANT, ASOF);
    expect(r.regulatory_coverage_pct).toBeGreaterThanOrEqual(0);
    expect(r.regulatory_coverage_pct).toBeLessThanOrEqual(100);
    expect(r.compliance_readiness_score).toBeGreaterThanOrEqual(0);
  });
  it('summarizeAlertCaseCompliance composes 3 scores', () => {
    const s = summarizeAlertCaseCompliance(TENANT, ASOF);
    expect(s.combined_operational_score).toBeGreaterThanOrEqual(0);
    expect(s.combined_operational_score).toBeLessThanOrEqual(100);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Security + release reporter
// ───────────────────────────────────────────────────────────────────────────

describe('Security validation', () => {
  it('validateSecurity returns realistic posture', () => {
    const r = validateSecurity(TENANT, ASOF);
    expect(r.total_users_scanned).toBeGreaterThan(0);
    expect(r.total_sessions_scanned).toBeGreaterThan(0);
    expect(r.total_login_audits_30d).toBeGreaterThan(0);
    expect(r.mfa_adoption_pct).toBeGreaterThanOrEqual(0);
    expect(r.mfa_adoption_pct).toBeLessThanOrEqual(100);
    expect(r.security_readiness_score).toBeGreaterThanOrEqual(0);
  });
});

describe('Release readiness report', () => {
  it('buildReleaseReadinessReport with all-high scores → demo_ready or production_ready', () => {
    const r = buildReleaseReadinessReport(TENANT, ASOF, {
      functional_score: 95,
      data_score: 92,
      security_score: 90,
      compliance_score: 88,
      integration_score: 87,
      uat_coverage_score: 95,
      release_score: 92,
    });
    expect(['demo_ready', 'production_ready']).toContain(r.release_status);
  });
  it('buildReleaseReadinessReport with low scores → uat_ready or not_ready', () => {
    const r = buildReleaseReadinessReport(TENANT, ASOF, {
      functional_score: 40,
      data_score: 45,
      security_score: 35,
      compliance_score: 50,
      integration_score: 55,
      uat_coverage_score: 30,
      release_score: 25,
    });
    expect(['not_ready', 'uat_ready']).toContain(r.release_status);
  });
  it('summarizeSecurityAndRelease has top recommendations', () => {
    const s = summarizeSecurityAndRelease(TENANT, ASOF);
    expect(s.security_readiness_score).toBeGreaterThanOrEqual(0);
    expect(s.release_score).toBeGreaterThanOrEqual(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SPA page render
// ───────────────────────────────────────────────────────────────────────────

describe('DemoReadinessCenterPage render', () => {
  it('bounces field_officer back to dashboard', () => {
    setUser('field_officer');
    renderRoute();
    expect(screen.queryByTestId('drc-section-overall')).toBeNull();
  });
  it('renders all 10 sections for admin', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('drc-section-overall')).toBeInTheDocument();
    expect(screen.getByTestId('drc-section-flows')).toBeInTheDocument();
    expect(screen.getByTestId('drc-section-roles')).toBeInTheDocument();
    expect(screen.getByTestId('drc-section-dashboards')).toBeInTheDocument();
    expect(screen.getByTestId('drc-section-data-quality')).toBeInTheDocument();
    expect(screen.getByTestId('drc-section-alert-validation')).toBeInTheDocument();
    expect(screen.getByTestId('drc-section-investigation-validation')).toBeInTheDocument();
    expect(screen.getByTestId('drc-section-compliance-validation')).toBeInTheDocument();
    expect(screen.getByTestId('drc-section-security-validation')).toBeInTheDocument();
    expect(screen.getByTestId('drc-section-release')).toBeInTheDocument();
  });
  it('renders for risk_analyst + supervisor', () => {
    setUser('supervisor');
    renderRoute();
    expect(screen.getByTestId('drc-section-overall')).toBeInTheDocument();
    fireEvent.click(document.body);
  });
});

describe('Overall readiness dimension chips', () => {
  it('renders one chip per dimension', () => {
    setUser('admin');
    renderRoute();
    for (const d of READINESS_DIMENSIONS) {
      expect(screen.getByTestId(`drc-dim-${d}`)).toBeInTheDocument();
    }
  });
});

describe('Role validation table', () => {
  it('renders 9 persona rows', () => {
    setUser('admin');
    renderRoute();
    const personas = [
      'super_admin', 'country_admin', 'bank_admin', 'insurance_admin',
      'risk_analyst', 'fraud_analyst', 'auditor', 'operations_user', 'executive',
    ];
    for (const p of personas) {
      expect(screen.getByTestId(`role-row-${p}`)).toBeInTheDocument();
    }
  });
});

describe('Data quality KPI tiles', () => {
  it('renders 5 data-quality tiles', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('drc-dq-null')).toBeInTheDocument();
    expect(screen.getByTestId('drc-dq-missing-ref')).toBeInTheDocument();
    expect(screen.getByTestId('drc-dq-orphan')).toBeInTheDocument();
    expect(screen.getByTestId('drc-dq-duplicate')).toBeInTheDocument();
    expect(screen.getByTestId('drc-dq-invalid-rel')).toBeInTheDocument();
  });
});

describe('Investigation validation KPIs', () => {
  it('renders evidence + timeline + quality KPI tiles', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('drc-kpi-evidence')).toBeInTheDocument();
    expect(screen.getByTestId('drc-kpi-timeline')).toBeInTheDocument();
    expect(screen.getByTestId('drc-kpi-investigation-quality')).toBeInTheDocument();
  });
});

describe('Security validation KPIs', () => {
  it('renders 4 security KPI tiles', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('drc-kpi-users')).toBeInTheDocument();
    expect(screen.getByTestId('drc-kpi-sessions')).toBeInTheDocument();
    expect(screen.getByTestId('drc-kpi-orphan-sessions')).toBeInTheDocument();
    expect(screen.getByTestId('drc-kpi-over-priv')).toBeInTheDocument();
  });
});
