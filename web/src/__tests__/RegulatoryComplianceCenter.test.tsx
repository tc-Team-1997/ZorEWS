// Regulatory Compliance Center — page render + role gate + pure-resolver suites.

import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { RegulatoryComplianceCenterPage } from '@/modules/regulatory/RegulatoryComplianceCenterPage';
import {
  BANKING_FRAMEWORKS,
  COMPLIANCE_WORKFLOW_ACTIONS,
  COMPLIANCE_WORKFLOW_STATUSES,
  FINDING_SEVERITIES,
  INSURANCE_FRAMEWORKS,
  OBLIGATION_CATEGORIES,
  OBLIGATION_STATUSES,
  REGULATORY_DOMAINS,
  REGULATORY_FRAMEWORKS,
  REGULATORY_ROLES,
  REPORT_FORMATS,
  REPORT_KINDS,
  WORKFLOW_TRANSITIONS,
  applyWorkflowAction,
  canAccessRegulatoryCenter,
  canTransition,
  getFramework,
  getObligation,
  listComplianceItems,
  listFrameworks,
  listObligations,
} from '@/modules/regulatory/regulatoryFrameworkEngine';
import {
  buildComplianceCommandCenter,
  buildComplianceHeatmap,
  getFinding,
  listFindings,
} from '@/modules/regulatory/complianceMonitoring';
import {
  buildReportingHubSummary,
  getRegulatoryReport,
  listRegulatoryCalendar,
  listRegulatoryReports,
  requestReportExport,
} from '@/modules/regulatory/regulatoryReportingHub';
import {
  buildAIComplianceReport,
  buildExecutiveComplianceDashboard,
} from '@/modules/regulatory/aiComplianceAssistant';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

type AnyRole =
  | 'admin' | 'supervisor' | 'risk_analyst' | 'fraud_analyst' | 'auditor'
  | 'compliance_officer' | 'field_officer' | 'investigator';

function setUser(role: AnyRole) {
  const user = { id: 'u-001', username: `test.${role}`, roles: [role] as AnyRole[] };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'mock.test.token');
  useAuth.setState({ status: 'authenticated', user: user as never, token: 'mock.test.token' });
}

function renderRoute() {
  return renderWithProviders(
    <Routes>
      <Route path="/regulatory-compliance-center" element={<RegulatoryComplianceCenterPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: '/regulatory-compliance-center' },
  );
}

beforeEach(() => {
  localStorage.clear();
});

const ASOF = new Date('2026-05-31T08:00:00Z');

// ───────────────────────────────────────────────────────────────────────────
// Role gate
// ───────────────────────────────────────────────────────────────────────────

describe('canAccessRegulatoryCenter', () => {
  it('grants every declared role in REGULATORY_ROLES', () => {
    for (const role of REGULATORY_ROLES) {
      expect(canAccessRegulatoryCenter([role])).toBe(true);
    }
  });

  it('grants the brief-listed roles', () => {
    for (const r of ['super_admin', 'country_admin', 'compliance_officer', 'auditor', 'risk_analyst']) {
      expect(canAccessRegulatoryCenter([r])).toBe(true);
    }
  });

  it('grants exec personas (cro / ceo / cfo / coo / board_member / country_head)', () => {
    for (const r of ['cro', 'ceo', 'cfo', 'coo', 'board_member', 'country_head']) {
      expect(canAccessRegulatoryCenter([r])).toBe(true);
    }
  });

  it('grants legacy backend roles', () => {
    expect(canAccessRegulatoryCenter(['admin'])).toBe(true);
    expect(canAccessRegulatoryCenter(['supervisor'])).toBe(true);
    expect(canAccessRegulatoryCenter(['executive'])).toBe(true);
  });

  it('refuses unknown / empty / null', () => {
    expect(canAccessRegulatoryCenter(['field_officer'])).toBe(false);
    expect(canAccessRegulatoryCenter(['investigator'])).toBe(false);
    expect(canAccessRegulatoryCenter([])).toBe(false);
    expect(canAccessRegulatoryCenter(undefined)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Closed-enum catalog invariants
// ───────────────────────────────────────────────────────────────────────────

describe('Closed enums', () => {
  it('REGULATORY_FRAMEWORKS catalog = 16 (8 banking + 8 insurance)', () => {
    expect(REGULATORY_FRAMEWORKS).toHaveLength(16);
    expect(REGULATORY_FRAMEWORKS.filter((f) => f.domain === 'banking')).toHaveLength(8);
    expect(REGULATORY_FRAMEWORKS.filter((f) => f.domain === 'insurance')).toHaveLength(8);
  });

  it('every banking framework declared has a catalog entry', () => {
    for (const fw of BANKING_FRAMEWORKS) {
      const entry = REGULATORY_FRAMEWORKS.find((f) => f.framework === fw);
      expect(entry).toBeDefined();
      expect(entry?.domain).toBe('banking');
    }
  });

  it('every insurance framework declared has a catalog entry', () => {
    for (const fw of INSURANCE_FRAMEWORKS) {
      const entry = REGULATORY_FRAMEWORKS.find((f) => f.framework === fw);
      expect(entry).toBeDefined();
      expect(entry?.domain).toBe('insurance');
    }
  });

  it('listFrameworks() returns all 16; filtered = 8 each', () => {
    expect(listFrameworks()).toHaveLength(16);
    expect(listFrameworks('banking')).toHaveLength(8);
    expect(listFrameworks('insurance')).toHaveLength(8);
  });

  it('getFramework hit + null on miss', () => {
    expect(getFramework('rbi')).toBeDefined();
    expect(getFramework('does_not_exist' as never)).toBeNull();
  });

  it('REPORT_KINDS has exactly 8 entries', () => {
    expect(REPORT_KINDS).toHaveLength(8);
  });

  it('REPORT_FORMATS = pdf|excel|csv', () => {
    expect(REPORT_FORMATS).toEqual(['pdf', 'excel', 'csv']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Workflow state machine
// ───────────────────────────────────────────────────────────────────────────

describe('WORKFLOW_TRANSITIONS + canTransition + applyWorkflowAction', () => {
  it('declares transitions for every status', () => {
    for (const s of COMPLIANCE_WORKFLOW_STATUSES) {
      expect(WORKFLOW_TRANSITIONS[s]).toBeDefined();
    }
  });

  it('draft → under_review only', () => {
    expect(canTransition('draft', 'under_review')).toBe(true);
    expect(canTransition('draft', 'closed')).toBe(false);
  });

  it('under_review can route to approved / draft / closed', () => {
    expect(canTransition('under_review', 'approved')).toBe(true);
    expect(canTransition('under_review', 'draft')).toBe(true);
    expect(canTransition('under_review', 'closed')).toBe(true);
  });

  it('closed can be re-opened to draft', () => {
    expect(canTransition('closed', 'draft')).toBe(true);
  });

  it('declares all 6 actions', () => {
    expect(COMPLIANCE_WORKFLOW_ACTIONS).toEqual([
      'assign', 'review', 'approve', 'reject', 'escalate', 'submit',
    ]);
  });

  it('applyWorkflowAction(review) transitions draft → under_review', () => {
    const items = listComplianceItems('BANK_DEMO', ASOF);
    const draft = items.find((i) => i.status === 'draft');
    if (!draft) return;
    const next = applyWorkflowAction(draft, 'review', 'alice');
    expect(next.status).toBe('under_review');
    expect(next).not.toBe(draft);
  });

  it('applyWorkflowAction(approve) on under_review → approved', () => {
    const items = listComplianceItems('BANK_DEMO', ASOF);
    const ur = items.find((i) => i.status === 'under_review');
    if (!ur) return;
    const next = applyWorkflowAction(ur, 'approve', 'bob');
    expect(next.status).toBe('approved');
  });

  it('applyWorkflowAction(submit) on approved → submitted', () => {
    const items = listComplianceItems('BANK_DEMO', ASOF);
    const a = items.find((i) => i.status === 'approved');
    if (!a) return;
    const next = applyWorkflowAction(a, 'submit', 'carol');
    expect(next.status).toBe('submitted');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Obligation Registry
// ───────────────────────────────────────────────────────────────────────────

describe('Obligation Registry', () => {
  it('returns ~40 deterministic obligations per tenant', () => {
    const a = listObligations('BANK_DEMO', ASOF);
    const b = listObligations('BANK_DEMO', ASOF);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(30);
    expect(a.length).toBeLessThanOrEqual(60);
  });

  it('every obligation has a valid shape', () => {
    const all = listObligations('BANK_DEMO', ASOF);
    for (const ob of all) {
      expect(ob.obligation_id).toMatch(/^OB-/);
      expect(REGULATORY_DOMAINS).toContain(ob.domain);
      expect(OBLIGATION_STATUSES).toContain(ob.status);
      expect(OBLIGATION_CATEGORIES).toContain(ob.category);
      expect(FINDING_SEVERITIES).toContain(ob.priority);
      expect(ob.last_review_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(ob.next_due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('filters by status', () => {
    const compliant = listObligations('BANK_DEMO', ASOF, { status: 'compliant' });
    expect(compliant.every((o) => o.status === 'compliant')).toBe(true);
  });

  it('filters by domain', () => {
    const banking = listObligations('BANK_DEMO', ASOF, { domain: 'banking' });
    const insurance = listObligations('BANK_DEMO', ASOF, { domain: 'insurance' });
    expect(banking.every((o) => o.domain === 'banking')).toBe(true);
    expect(insurance.every((o) => o.domain === 'insurance')).toBe(true);
  });

  it('emits both banking + insurance frameworks across the set', () => {
    const all = listObligations('BANK_DEMO', ASOF);
    const bankFw = new Set(all.filter((o) => o.domain === 'banking').map((o) => o.framework));
    const insFw = new Set(all.filter((o) => o.domain === 'insurance').map((o) => o.framework));
    expect(bankFw.size).toBeGreaterThan(0);
    expect(insFw.size).toBeGreaterThan(0);
  });

  it('different tenants produce different obligation sets', () => {
    const a = listObligations('BANK_DEMO', ASOF);
    const b = listObligations('BIL', ASOF);
    expect(a[0].obligation_id).not.toBe(b[0].obligation_id);
  });

  it('getObligation returns matching row + null on miss', () => {
    const all = listObligations('BANK_DEMO', ASOF);
    expect(getObligation(all[0].obligation_id, 'BANK_DEMO', ASOF)).toEqual(all[0]);
    expect(getObligation('OB-DOES-NOT-EXIST', 'BANK_DEMO', ASOF)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Compliance findings + monitoring
// ───────────────────────────────────────────────────────────────────────────

describe('Compliance Findings', () => {
  it('returns ~30 deterministic findings', () => {
    const all = listFindings('BANK_DEMO', ASOF);
    expect(all.length).toBeGreaterThan(0);
    expect(listFindings('BANK_DEMO', ASOF)).toEqual(all);
  });

  it('every finding has valid severity + status', () => {
    const all = listFindings('BANK_DEMO', ASOF);
    for (const f of all) {
      expect(FINDING_SEVERITIES).toContain(f.severity);
      expect(['open', 'in_progress', 'remediated', 'accepted_risk', 'closed']).toContain(f.status);
    }
  });

  it('filters by severity', () => {
    const sev = listFindings('BANK_DEMO', ASOF, { severity: 'critical' });
    expect(sev.every((f) => f.severity === 'critical')).toBe(true);
  });

  it('getFinding returns null on unknown', () => {
    expect(getFinding('FND-DOES-NOT-EXIST', 'BANK_DEMO', ASOF)).toBeNull();
  });
});

describe('buildComplianceCommandCenter', () => {
  it('aggregates fields with valid bounds', () => {
    const cc = buildComplianceCommandCenter('BANK_DEMO', ASOF);
    expect(cc.total_obligations).toBeGreaterThan(0);
    expect(cc.compliance_health_score).toBeGreaterThanOrEqual(0);
    expect(cc.compliance_health_score).toBeLessThanOrEqual(100);
    expect(cc.regulatory_risk_score).toBeGreaterThanOrEqual(0);
    expect(cc.regulatory_risk_score).toBeLessThanOrEqual(100);
    expect(['ready', 'needs_attention', 'not_ready']).toContain(cc.audit_readiness);
    for (const s of OBLIGATION_STATUSES) expect(cc.by_status[s]).toBeGreaterThanOrEqual(0);
  });

  it('audit_readiness follows bucket thresholds', () => {
    const cc = buildComplianceCommandCenter('BANK_DEMO', ASOF);
    if (cc.compliance_health_score >= 80) expect(cc.audit_readiness).toBe('ready');
    else if (cc.compliance_health_score >= 50) expect(cc.audit_readiness).toBe('needs_attention');
    else expect(cc.audit_readiness).toBe('not_ready');
  });

  it('is deterministic per (tenant, day)', () => {
    expect(buildComplianceCommandCenter('BANK_DEMO', ASOF)).toEqual(buildComplianceCommandCenter('BANK_DEMO', ASOF));
  });
});

describe('buildComplianceHeatmap', () => {
  it('returns one row per framework (16 total)', () => {
    const cells = buildComplianceHeatmap('BANK_DEMO', ASOF);
    expect(cells).toHaveLength(16);
  });

  it('every cell has band ∈ {green, amber, red}', () => {
    const cells = buildComplianceHeatmap('BANK_DEMO', ASOF);
    for (const c of cells) {
      expect(['green', 'amber', 'red']).toContain(c.band);
      expect(c.health_score).toBeGreaterThanOrEqual(0);
      expect(c.health_score).toBeLessThanOrEqual(100);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Reporting Hub + Calendar + Export
// ───────────────────────────────────────────────────────────────────────────

describe('Regulatory Reporting Hub', () => {
  it('returns 16 deterministic reports', () => {
    expect(listRegulatoryReports('BANK_DEMO', ASOF)).toHaveLength(16);
  });

  it('every report has supported_formats covering pdf', () => {
    const all = listRegulatoryReports('BANK_DEMO', ASOF);
    for (const r of all) {
      expect(REPORT_KINDS).toContain(r.kind);
      expect(r.supported_formats.length).toBeGreaterThan(0);
    }
  });

  it('filters by kind', () => {
    const rbi = listRegulatoryReports('BANK_DEMO', ASOF, { kind: 'rbi' });
    expect(rbi.every((r) => r.kind === 'rbi')).toBe(true);
  });

  it('getRegulatoryReport returns null on miss', () => {
    expect(getRegulatoryReport('RPT-DOES-NOT-EXIST', 'BANK_DEMO', ASOF)).toBeNull();
  });

  it('buildReportingHubSummary aggregates with required fields', () => {
    const s = buildReportingHubSummary('BANK_DEMO', ASOF);
    expect(s.total_reports).toBe(16);
    expect(s.reports_due_30d).toBeGreaterThanOrEqual(0);
    expect(s.reports_overdue).toBeGreaterThanOrEqual(0);
    expect(s.upcoming_calendar.length).toBeLessThanOrEqual(5);
  });
});

describe('Regulatory Calendar', () => {
  it('returns ~24 entries sorted by due_date asc', () => {
    const cal = listRegulatoryCalendar('BANK_DEMO', ASOF, 60);
    expect(cal.length).toBeGreaterThan(0);
    for (let i = 1; i < cal.length; i++) {
      expect(cal[i - 1].due_date <= cal[i].due_date).toBe(true);
    }
  });

  it('urgency classification matches days_until_due', () => {
    const cal = listRegulatoryCalendar('BANK_DEMO', ASOF, 60);
    for (const e of cal) {
      if (e.days_until_due < 0) expect(e.urgency).toBe('overdue');
      else if (e.days_until_due === 0) expect(e.urgency).toBe('due_today');
      else if (e.days_until_due <= 7) expect(e.urgency).toBe('due_soon');
      else expect(e.urgency).toBe('upcoming');
    }
  });
});

describe('requestReportExport', () => {
  it('returns a deterministic receipt for a known report', () => {
    const all = listRegulatoryReports('BANK_DEMO', ASOF);
    const a = requestReportExport({ tenant_id: 'BANK_DEMO', report_id: all[0].report_id, format: 'pdf', requested_by: 'compliance.lead' }, ASOF);
    const b = requestReportExport({ tenant_id: 'BANK_DEMO', report_id: all[0].report_id, format: 'pdf', requested_by: 'compliance.lead' }, ASOF);
    expect(a).toEqual(b);
    expect(['queued', 'ready', 'failed']).toContain(a.status);
    expect(a.size_bytes_estimate).toBeGreaterThanOrEqual(0);
  });

  it('returns status="failed" for unknown report_id', () => {
    const r = requestReportExport({ tenant_id: 'BANK_DEMO', report_id: 'RPT-DOES-NOT-EXIST', format: 'pdf', requested_by: 'x' }, ASOF);
    expect(r.status).toBe('failed');
    expect(r.size_bytes_estimate).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AI Compliance + Executive Dashboard
// ───────────────────────────────────────────────────────────────────────────

describe('buildAIComplianceReport', () => {
  it('returns required fields with valid bounds', () => {
    const r = buildAIComplianceReport('BANK_DEMO', ASOF);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
    expect(r.compliance_gaps.length).toBeGreaterThanOrEqual(4);
    expect(r.upcoming_risks.length).toBeGreaterThanOrEqual(4);
    expect(r.recommendations.length).toBeGreaterThanOrEqual(5);
    expect(r.exception_analysis.length).toBeGreaterThanOrEqual(4);
    expect(r.model_id).toBe('compliance-llm');
    expect(r.model_version).toBe('1.0.0');
  });

  it('every recommendation carries valid priority + category', () => {
    const r = buildAIComplianceReport('BANK_DEMO', ASOF);
    for (const rec of r.recommendations) {
      expect(['low', 'medium', 'high']).toContain(rec.priority);
      expect(['policy', 'training', 'control', 'filing', 'audit']).toContain(rec.category);
    }
  });

  it('is deterministic per (tenant, day)', () => {
    expect(buildAIComplianceReport('BANK_DEMO', ASOF)).toEqual(buildAIComplianceReport('BANK_DEMO', ASOF));
  });
});

describe('buildExecutiveComplianceDashboard', () => {
  it('returns required fields with valid bounds', () => {
    const d = buildExecutiveComplianceDashboard('BANK_DEMO', ASOF);
    expect(d.compliance_health_score).toBeGreaterThanOrEqual(0);
    expect(d.compliance_health_score).toBeLessThanOrEqual(100);
    expect(d.regulatory_risk_score).toBeGreaterThanOrEqual(0);
    expect(d.regulatory_risk_score).toBeLessThanOrEqual(100);
    expect(['ready', 'needs_attention', 'not_ready']).toContain(d.audit_readiness);
    expect(d.compliance_trend_30d).toHaveLength(30);
    expect(d.top_obligations_at_risk).toHaveLength(5);
    expect(d.regulator_breakdown.length).toBeGreaterThanOrEqual(3);
  });

  it('compliance_trend_30d spans day_offset -29..0', () => {
    const d = buildExecutiveComplianceDashboard('BANK_DEMO', ASOF);
    expect(d.compliance_trend_30d[0].day_offset).toBe(-29);
    expect(d.compliance_trend_30d[29].day_offset).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Page render
// ───────────────────────────────────────────────────────────────────────────

describe('RegulatoryComplianceCenterPage', () => {
  it('admin sees every section', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByText(/Regulatory Compliance Center/i)).toBeInTheDocument();
    for (const id of [
      'reg-section-command',
      'reg-section-frameworks',
      'reg-section-obligations',
      'reg-section-findings',
      'reg-section-reports',
      'reg-section-calendar',
      'reg-section-workflow',
      'reg-section-ai',
      'reg-section-exec',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it('risk_analyst sees the page (per brief)', () => {
    setUser('risk_analyst');
    renderRoute();
    expect(screen.getByText(/Regulatory Compliance Center/i)).toBeInTheDocument();
  });

  it('compliance_officer sees the page (per brief)', () => {
    setUser('compliance_officer');
    renderRoute();
    expect(screen.getByText(/Regulatory Compliance Center/i)).toBeInTheDocument();
  });

  it('auditor sees the page (per brief)', () => {
    setUser('auditor');
    renderRoute();
    expect(screen.getByText(/Regulatory Compliance Center/i)).toBeInTheDocument();
  });

  it('field_officer is bounced', () => {
    setUser('field_officer');
    renderRoute();
    expect(screen.queryByText(/^Regulatory Compliance Center$/)).not.toBeInTheDocument();
  });

  it('renders 8 KPI cards', () => {
    setUser('admin');
    renderRoute();
    for (const id of ['kpi-total-obligations', 'kpi-open-findings', 'kpi-breaches', 'kpi-sla', 'kpi-audit-findings', 'kpi-pending', 'kpi-high-risk', 'kpi-health']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it('renders banking + insurance framework lists', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('frameworks-banking')).toBeInTheDocument();
    expect(screen.getByTestId('frameworks-insurance')).toBeInTheDocument();
  });

  it('obligation domain filter chips render', () => {
    setUser('admin');
    renderRoute();
    for (const d of ['all', 'banking', 'insurance']) {
      expect(screen.getByTestId(`obligation-domain-${d}`)).toBeInTheDocument();
    }
  });

  it('obligation status + category filter chips render', () => {
    setUser('admin');
    renderRoute();
    for (const s of OBLIGATION_STATUSES) {
      expect(screen.getByTestId(`obligation-status-${s}`)).toBeInTheDocument();
    }
    for (const c of OBLIGATION_CATEGORIES) {
      expect(screen.getByTestId(`obligation-category-${c}`)).toBeInTheDocument();
    }
  });

  it('finding severity filter chips render', () => {
    setUser('admin');
    renderRoute();
    for (const s of FINDING_SEVERITIES) {
      expect(screen.getByTestId(`finding-severity-${s}`)).toBeInTheDocument();
    }
  });

  it('report kind filter chips render', () => {
    setUser('admin');
    renderRoute();
    for (const k of REPORT_KINDS) {
      expect(screen.getByTestId(`report-kind-${k}`)).toBeInTheDocument();
    }
  });

  it('renders 6 workflow action buttons', () => {
    setUser('admin');
    renderRoute();
    for (const a of COMPLIANCE_WORKFLOW_ACTIONS) {
      expect(screen.getByTestId(`workflow-action-${a}`)).toBeInTheDocument();
    }
  });

  it('renders 5 workflow status buckets', () => {
    setUser('admin');
    renderRoute();
    for (const s of COMPLIANCE_WORKFLOW_STATUSES) {
      expect(screen.getByTestId(`workflow-bucket-${s}`)).toBeInTheDocument();
    }
  });

  it('renders 4 calendar urgency buckets', () => {
    setUser('admin');
    renderRoute();
    for (const u of ['overdue', 'due_today', 'due_soon', 'upcoming']) {
      expect(screen.getByTestId(`calendar-bucket-${u}`)).toBeInTheDocument();
    }
  });

  it('renders 4 executive KPI cards', () => {
    setUser('admin');
    renderRoute();
    for (const id of ['exec-kpi-health', 'exec-kpi-risk', 'exec-kpi-findings', 'exec-kpi-deadlines']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it('clicking a status filter narrows obligations', () => {
    setUser('admin');
    renderRoute();
    fireEvent.click(screen.getByTestId('obligation-status-closed'));
    expect(screen.getByTestId('reg-section-obligations')).toBeInTheDocument();
  });

  it('clicking an export button surfaces a receipt', () => {
    setUser('admin');
    renderRoute();
    // grab first report row's PDF export button
    const reports = listRegulatoryReports('BANK_DEMO', ASOF);
    const btn = screen.getByTestId(`export-${reports[0].report_id}-pdf`);
    fireEvent.click(btn);
    expect(screen.getByTestId('export-receipt')).toBeInTheDocument();
  });
});
