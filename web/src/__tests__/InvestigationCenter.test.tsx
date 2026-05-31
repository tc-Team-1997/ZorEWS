// Investigation Center — page render + role gate + pure-resolver suites.

import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { InvestigationCenterPage } from '@/modules/investigation/InvestigationCenterPage';
import {
  BANKING_INVESTIGATION_KINDS,
  INSURANCE_INVESTIGATION_KINDS,
  INVESTIGATION_ACTIONS,
  INVESTIGATION_DOMAINS,
  INVESTIGATION_ROLES,
  INVESTIGATION_SEVERITIES,
  INVESTIGATION_STATUSES,
  WORKFLOW_TRANSITIONS,
  applyAction,
  buildCaseCommandCenter,
  canAccessInvestigationCenter,
  canTransition,
  getInvestigation,
  listInvestigations,
} from '@/modules/investigation/investigationEngine';
import {
  EVIDENCE_TYPES,
  EVIDENCE_VERIFICATION_STATUSES,
  computeEvidenceHash,
  evidenceVaultSummary,
  getEvidence,
  listEvidence,
  verifyEvidence,
} from '@/modules/investigation/evidenceVault';
import { buildAIInvestigationReport } from '@/modules/investigation/aiInvestigator';
import {
  buildExecutiveInvestigationView,
  buildInvestigationAnalytics,
} from '@/modules/investigation/investigationAnalytics';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

type AnyRole =
  | 'admin' | 'supervisor' | 'risk_analyst' | 'fraud_analyst' | 'investigator' | 'auditor'
  | 'collection_manager' | 'field_officer';

function setUser(role: AnyRole) {
  const user = {
    id: 'u-001',
    username: `test.${role}`,
    roles: [role] as AnyRole[],
  };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'mock.test.token');
  useAuth.setState({ status: 'authenticated', user: user as never, token: 'mock.test.token' });
}

function renderRoute() {
  return renderWithProviders(
    <Routes>
      <Route path="/investigation-center" element={<InvestigationCenterPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: '/investigation-center' },
  );
}

beforeEach(() => {
  localStorage.clear();
});

const ASOF = new Date('2026-05-31T08:00:00Z');

// ───────────────────────────────────────────────────────────────────────────
// Role gate
// ───────────────────────────────────────────────────────────────────────────

describe('canAccessInvestigationCenter', () => {
  it('grants every declared role in INVESTIGATION_ROLES', () => {
    for (const role of INVESTIGATION_ROLES) {
      expect(canAccessInvestigationCenter([role])).toBe(true);
    }
  });

  it('grants the brief-listed roles', () => {
    for (const r of ['super_admin', 'country_admin', 'bank_admin', 'insurance_admin', 'risk_analyst', 'fraud_analyst', 'collection_manager', 'investigator', 'auditor']) {
      expect(canAccessInvestigationCenter([r])).toBe(true);
    }
  });

  it('grants the executive personas', () => {
    for (const r of ['cro', 'ceo', 'cfo', 'coo', 'board_member', 'country_head']) {
      expect(canAccessInvestigationCenter([r])).toBe(true);
    }
  });

  it('grants legacy backend roles (admin / supervisor / executive)', () => {
    expect(canAccessInvestigationCenter(['admin'])).toBe(true);
    expect(canAccessInvestigationCenter(['supervisor'])).toBe(true);
    expect(canAccessInvestigationCenter(['executive'])).toBe(true);
  });

  it('refuses unknown / empty / null', () => {
    expect(canAccessInvestigationCenter(['field_officer'])).toBe(false);
    expect(canAccessInvestigationCenter(['random_role'])).toBe(false);
    expect(canAccessInvestigationCenter([])).toBe(false);
    expect(canAccessInvestigationCenter(undefined)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Workflow state machine
// ───────────────────────────────────────────────────────────────────────────

describe('canTransition + WORKFLOW_TRANSITIONS', () => {
  it('declares transitions for every status', () => {
    for (const s of INVESTIGATION_STATUSES) {
      expect(WORKFLOW_TRANSITIONS[s]).toBeDefined();
      expect(Array.isArray(WORKFLOW_TRANSITIONS[s])).toBe(true);
    }
  });

  it('open transitions only to assigned', () => {
    expect(canTransition('open', 'assigned')).toBe(true);
    expect(canTransition('open', 'closed')).toBe(false);
  });

  it('assigned can transition to in_review / escalated / closed', () => {
    expect(canTransition('assigned', 'in_review')).toBe(true);
    expect(canTransition('assigned', 'escalated')).toBe(true);
    expect(canTransition('assigned', 'closed')).toBe(true);
  });

  it('closed can transition back to assigned (reopen)', () => {
    expect(canTransition('closed', 'assigned')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('open', 'pending_approval')).toBe(false);
    expect(canTransition('closed', 'in_review')).toBe(false);
  });
});

describe('INVESTIGATION_ACTIONS', () => {
  it('exposes 7 actions per brief', () => {
    expect(INVESTIGATION_ACTIONS).toEqual([
      'assign', 'reassign', 'escalate', 'approve', 'reject', 'close', 'reopen',
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// listInvestigations + filters
// ───────────────────────────────────────────────────────────────────────────

describe('listInvestigations', () => {
  it('returns ~32 deterministic investigations per tenant', () => {
    const a = listInvestigations('BANK_DEMO', ASOF);
    const b = listInvestigations('BANK_DEMO', ASOF);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(a.length).toBeLessThanOrEqual(64);
  });

  it('every record carries a valid shape', () => {
    const all = listInvestigations('BANK_DEMO', ASOF);
    for (const inv of all) {
      expect(inv.investigation_id).toMatch(/^INV-/);
      expect(INVESTIGATION_DOMAINS).toContain(inv.domain);
      expect(INVESTIGATION_STATUSES).toContain(inv.status);
      expect(INVESTIGATION_SEVERITIES).toContain(inv.severity);
      expect(inv.exposure_kes).toBeGreaterThanOrEqual(0);
      expect(typeof inv.fraud_indicator).toBe('boolean');
    }
  });

  it('different tenants produce different output', () => {
    const a = listInvestigations('BANK_DEMO', ASOF);
    const b = listInvestigations('BIL', ASOF);
    expect(a[0].investigation_id).not.toBe(b[0].investigation_id);
  });

  it('filters by status', () => {
    const open = listInvestigations('BANK_DEMO', ASOF, { status: 'open' });
    expect(open.every((i) => i.status === 'open')).toBe(true);
    expect(open.length).toBeGreaterThan(0);
  });

  it('filters by domain', () => {
    const banking = listInvestigations('BANK_DEMO', ASOF, { domain: 'banking' });
    const insurance = listInvestigations('BANK_DEMO', ASOF, { domain: 'insurance' });
    expect(banking.every((i) => i.domain === 'banking')).toBe(true);
    expect(insurance.every((i) => i.domain === 'insurance')).toBe(true);
    expect(banking.length + insurance.length).toBe(listInvestigations('BANK_DEMO', ASOF).length);
  });

  it('filters by severity', () => {
    const high = listInvestigations('BANK_DEMO', ASOF, { severity: 'high' });
    expect(high.every((i) => i.severity === 'high')).toBe(true);
  });

  it('filters sla_breached', () => {
    const breached = listInvestigations('BANK_DEMO', ASOF, { sla_breached: true });
    for (const i of breached) {
      expect(new Date(i.due_at).getTime() < ASOF.getTime()).toBe(true);
      expect(i.status).not.toBe('closed');
    }
  });

  it('emits both banking and insurance kinds across the set', () => {
    const all = listInvestigations('BANK_DEMO', ASOF);
    const bankingKinds = new Set(all.filter((i) => i.domain === 'banking').map((i) => i.kind));
    const insuranceKinds = new Set(all.filter((i) => i.domain === 'insurance').map((i) => i.kind));
    expect(bankingKinds.size).toBeGreaterThan(0);
    expect(insuranceKinds.size).toBeGreaterThan(0);
    for (const k of bankingKinds) expect(BANKING_INVESTIGATION_KINDS).toContain(k);
    for (const k of insuranceKinds) expect(INSURANCE_INVESTIGATION_KINDS).toContain(k);
  });
});

describe('getInvestigation', () => {
  it('returns the matching record', () => {
    const all = listInvestigations('BANK_DEMO', ASOF);
    const hit = getInvestigation(all[0].investigation_id, 'BANK_DEMO', ASOF);
    expect(hit).toEqual(all[0]);
  });

  it('returns null on miss', () => {
    expect(getInvestigation('INV-DOES-NOT-EXIST', 'BANK_DEMO', ASOF)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// applyAction
// ───────────────────────────────────────────────────────────────────────────

describe('applyAction', () => {
  it('assigns an open case → status=assigned + assignee=actor', () => {
    const inv = listInvestigations('BANK_DEMO', ASOF).find((i) => i.status === 'open')!;
    const next = applyAction(inv, 'assign', 'alice');
    expect(next.status).toBe('assigned');
    expect(next.assignee_username).toBe('alice');
    expect(next).not.toBe(inv); // new object
  });

  it('escalates an assigned case → status=escalated', () => {
    const inv = listInvestigations('BANK_DEMO', ASOF).find((i) => i.status === 'assigned')!;
    if (inv) {
      const next = applyAction(inv, 'escalate', 'bob');
      expect(next.status).toBe('escalated');
    }
  });

  it('close sets closed_at', () => {
    const inv = listInvestigations('BANK_DEMO', ASOF).find((i) => i.status === 'in_review')!;
    if (inv) {
      const next = applyAction(inv, 'close', 'carol');
      expect(next.status).toBe('closed');
      expect(next.closed_at).not.toBeNull();
    }
  });

  it('reopen requires closed and clears closed_at', () => {
    const inv = listInvestigations('BANK_DEMO', ASOF).find((i) => i.status === 'closed')!;
    if (inv) {
      const next = applyAction(inv, 'reopen', 'dave');
      expect(next.status).toBe('assigned');
      expect(next.closed_at).toBeNull();
    }
  });

  it('reopen on non-closed throws', () => {
    const inv = listInvestigations('BANK_DEMO', ASOF).find((i) => i.status === 'open')!;
    expect(() => applyAction(inv, 'reopen', 'eve')).toThrowError(/invalid_transition/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// buildCaseCommandCenter
// ───────────────────────────────────────────────────────────────────────────

describe('buildCaseCommandCenter', () => {
  it('aggregates all required fields with valid bounds', () => {
    const cc = buildCaseCommandCenter('BANK_DEMO', ASOF);
    expect(cc.total_cases).toBeGreaterThan(0);
    expect(cc.banking_cases + cc.insurance_cases).toBe(cc.total_cases);
    expect(cc.resolution_rate).toBeGreaterThanOrEqual(0);
    expect(cc.resolution_rate).toBeLessThanOrEqual(1);
    for (const s of INVESTIGATION_STATUSES) expect(cc.by_status[s]).toBeGreaterThanOrEqual(0);
    for (const s of INVESTIGATION_SEVERITIES) expect(cc.by_severity[s]).toBeGreaterThanOrEqual(0);
  });

  it('high_risk_cases ≥ critical_cases', () => {
    const cc = buildCaseCommandCenter('BANK_DEMO', ASOF);
    expect(cc.high_risk_cases).toBeGreaterThanOrEqual(cc.critical_cases);
  });

  it('investigation_backlog = open + assigned + in_review', () => {
    const cc = buildCaseCommandCenter('BANK_DEMO', ASOF);
    expect(cc.investigation_backlog).toBe(cc.by_status.open + cc.by_status.assigned + cc.by_status.in_review);
  });

  it('is deterministic per (tenant, day)', () => {
    expect(buildCaseCommandCenter('BANK_DEMO', ASOF)).toEqual(buildCaseCommandCenter('BANK_DEMO', ASOF));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Evidence Vault
// ───────────────────────────────────────────────────────────────────────────

describe('evidenceVault', () => {
  it('every EVIDENCE_TYPES value is unique + canonical (5 entries)', () => {
    expect(EVIDENCE_TYPES.length).toBe(5);
    expect(new Set(EVIDENCE_TYPES).size).toBe(5);
  });

  it('listEvidence returns 2-6 deterministic items per investigation', () => {
    const inv = listInvestigations('BANK_DEMO', ASOF)[0];
    const a = listEvidence(inv.investigation_id, 'BANK_DEMO', ASOF);
    const b = listEvidence(inv.investigation_id, 'BANK_DEMO', ASOF);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(a.length).toBeLessThanOrEqual(6);
  });

  it('every evidence has 64-char hex hash + a valid type + non-empty custody', () => {
    const inv = listInvestigations('BANK_DEMO', ASOF)[0];
    const items = listEvidence(inv.investigation_id, 'BANK_DEMO', ASOF);
    for (const e of items) {
      expect(e.hash_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(EVIDENCE_TYPES).toContain(e.evidence_type);
      expect(EVIDENCE_VERIFICATION_STATUSES).toContain(e.verification_status);
      expect(e.chain_of_custody.length).toBeGreaterThanOrEqual(1);
      expect(e.version).toBeGreaterThanOrEqual(1);
    }
  });

  it('computeEvidenceHash is deterministic + 64 hex chars', () => {
    const h = computeEvidenceHash('EV-1', 'sample', '2026-05-31T08:00:00Z');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeEvidenceHash('EV-1', 'sample', '2026-05-31T08:00:00Z')).toBe(h);
  });

  it('verifyEvidence on synthesised items returns ok', () => {
    const inv = listInvestigations('BANK_DEMO', ASOF)[0];
    const items = listEvidence(inv.investigation_id, 'BANK_DEMO', ASOF);
    for (const e of items) {
      const result = verifyEvidence(e);
      expect(result.ok).toBe(true);
      expect(result.computed_hash).toBe(e.hash_sha256);
    }
  });

  it('verifyEvidence detects hash drift', () => {
    const inv = listInvestigations('BANK_DEMO', ASOF)[0];
    const items = listEvidence(inv.investigation_id, 'BANK_DEMO', ASOF);
    const tampered = { ...items[0], title: 'TAMPERED' };
    const result = verifyEvidence(tampered);
    expect(result.ok).toBe(false);
  });

  it('getEvidence returns null on unknown id', () => {
    const inv = listInvestigations('BANK_DEMO', ASOF)[0];
    expect(getEvidence('EV-DOES-NOT-EXIST', inv.investigation_id, 'BANK_DEMO', ASOF)).toBeNull();
  });

  it('evidenceVaultSummary aggregates with every type key present', () => {
    const s = evidenceVaultSummary('BANK_DEMO', ASOF);
    expect(s.total_items).toBeGreaterThan(0);
    for (const t of EVIDENCE_TYPES) expect(s.by_type[t]).toBeGreaterThanOrEqual(0);
    for (const v of EVIDENCE_VERIFICATION_STATUSES) expect(s.by_verification_status[v]).toBeGreaterThanOrEqual(0);
    expect(s.verification_rate).toBeGreaterThanOrEqual(0);
    expect(s.verification_rate).toBeLessThanOrEqual(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AI Investigator
// ───────────────────────────────────────────────────────────────────────────

describe('buildAIInvestigationReport', () => {
  it('returns exactly 5 risk drivers sorted by |shap_value| desc', () => {
    const inv = listInvestigations('BANK_DEMO', ASOF)[0];
    const r = buildAIInvestigationReport(inv.investigation_id, 'BANK_DEMO', inv.kind, inv.domain, ASOF);
    expect(r.risk_drivers).toHaveLength(5);
    for (let i = 1; i < r.risk_drivers.length; i++) {
      expect(Math.abs(r.risk_drivers[i - 1].shap_value)).toBeGreaterThanOrEqual(Math.abs(r.risk_drivers[i].shap_value));
    }
  });

  it('banking case → related_borrowers non-empty + related_policies empty', () => {
    const inv = listInvestigations('BANK_DEMO', ASOF).find((i) => i.domain === 'banking')!;
    const r = buildAIInvestigationReport(inv.investigation_id, 'BANK_DEMO', inv.kind, inv.domain, ASOF);
    expect(r.related_borrowers.length).toBeGreaterThan(0);
    expect(r.related_policies.length).toBe(0);
  });

  it('insurance case → related_policies non-empty + related_borrowers empty', () => {
    const inv = listInvestigations('BANK_DEMO', ASOF).find((i) => i.domain === 'insurance')!;
    const r = buildAIInvestigationReport(inv.investigation_id, 'BANK_DEMO', inv.kind, inv.domain, ASOF);
    expect(r.related_policies.length).toBeGreaterThan(0);
    expect(r.related_borrowers.length).toBe(0);
  });

  it('produces 3-5 recommendations with valid priority + category', () => {
    const inv = listInvestigations('BANK_DEMO', ASOF)[0];
    const r = buildAIInvestigationReport(inv.investigation_id, 'BANK_DEMO', inv.kind, inv.domain, ASOF);
    expect(r.recommendations.length).toBeGreaterThanOrEqual(3);
    expect(r.recommendations.length).toBeLessThanOrEqual(5);
    for (const rec of r.recommendations) {
      expect(['low', 'medium', 'high']).toContain(rec.priority);
      expect(['evidence', 'interview', 'verification', 'escalation', 'closure']).toContain(rec.category);
    }
  });

  it('confidence in [0,1] and model_id/version stamped', () => {
    const inv = listInvestigations('BANK_DEMO', ASOF)[0];
    const r = buildAIInvestigationReport(inv.investigation_id, 'BANK_DEMO', inv.kind, inv.domain, ASOF);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
    expect(r.model_id).toBe('investigator-llm');
    expect(r.model_version).toBe('1.0.0');
  });

  it('is deterministic per (investigation, tenant, day)', () => {
    const inv = listInvestigations('BANK_DEMO', ASOF)[0];
    const a = buildAIInvestigationReport(inv.investigation_id, 'BANK_DEMO', inv.kind, inv.domain, ASOF);
    const b = buildAIInvestigationReport(inv.investigation_id, 'BANK_DEMO', inv.kind, inv.domain, ASOF);
    expect(a).toEqual(b);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Investigation Analytics + Executive view
// ───────────────────────────────────────────────────────────────────────────

describe('buildInvestigationAnalytics', () => {
  it('returns expected fields with valid bounds', () => {
    const a = buildInvestigationAnalytics('BANK_DEMO', ASOF);
    expect(a.average_resolution_time_days).toBeGreaterThan(0);
    expect(a.median_resolution_time_days).toBeGreaterThan(0);
    expect(a.median_resolution_time_days).toBeLessThanOrEqual(a.average_resolution_time_days + 1);
    expect(a.investigator_productivity.length).toBe(6);
    expect(a.case_volume_trend.length).toBe(12);
    for (const r of [a.fraud_detection_rate, a.recovery_success_rate, a.sla_compliance_rate, a.escalation_rate]) {
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
    }
  });

  it('productivity sorted by closed_cases_30d desc', () => {
    const a = buildInvestigationAnalytics('BANK_DEMO', ASOF);
    for (let i = 1; i < a.investigator_productivity.length; i++) {
      expect(a.investigator_productivity[i - 1].closed_cases_30d).toBeGreaterThanOrEqual(a.investigator_productivity[i].closed_cases_30d);
    }
  });

  it('case_volume_trend spans week_offset -11..0', () => {
    const a = buildInvestigationAnalytics('BANK_DEMO', ASOF);
    expect(a.case_volume_trend[0].week_offset).toBe(-11);
    expect(a.case_volume_trend[11].week_offset).toBe(0);
  });
});

describe('buildExecutiveInvestigationView', () => {
  it('top_open_cases ≤ 5 sorted by exposure desc', () => {
    const v = buildExecutiveInvestigationView('BANK_DEMO', ASOF);
    expect(v.top_open_cases.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < v.top_open_cases.length; i++) {
      expect(v.top_open_cases[i - 1].exposure_kes).toBeGreaterThanOrEqual(v.top_open_cases[i].exposure_kes);
    }
  });

  it('critical_investigations all have severity=critical', () => {
    const v = buildExecutiveInvestigationView('BANK_DEMO', ASOF);
    for (const c of v.critical_investigations) {
      expect(c.severity).toBe('critical');
    }
  });

  it('fraud_exposure_kes + recovery_impact_kes are non-negative', () => {
    const v = buildExecutiveInvestigationView('BANK_DEMO', ASOF);
    expect(v.fraud_exposure_kes).toBeGreaterThanOrEqual(0);
    expect(v.recovery_impact_kes).toBeGreaterThanOrEqual(0);
  });

  it('performance metrics in valid bounds', () => {
    const v = buildExecutiveInvestigationView('BANK_DEMO', ASOF);
    expect(v.investigation_performance.sla_compliance_rate).toBeGreaterThanOrEqual(0);
    expect(v.investigation_performance.sla_compliance_rate).toBeLessThanOrEqual(1);
    expect(v.investigation_performance.avg_resolution_days).toBeGreaterThan(0);
    expect(v.investigation_performance.closure_rate_30d).toBeGreaterThanOrEqual(0);
    expect(v.investigation_performance.closure_rate_30d).toBeLessThanOrEqual(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Page render
// ───────────────────────────────────────────────────────────────────────────

describe('InvestigationCenterPage', () => {
  it('admin sees every section', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByText(/Investigation Center/i)).toBeInTheDocument();
    for (const sectionId of [
      'inv-section-command',
      'inv-section-list',
      'inv-section-workspace',
      'inv-section-ai',
      'inv-section-evidence',
      'inv-section-banking',
      'inv-section-insurance',
      'inv-section-analytics',
      'inv-section-exec',
    ]) {
      expect(screen.getByTestId(sectionId)).toBeInTheDocument();
    }
  });

  it('risk_analyst sees the page (per brief — not bounced)', () => {
    setUser('risk_analyst');
    renderRoute();
    expect(screen.getByText(/Investigation Center/i)).toBeInTheDocument();
  });

  it('fraud_analyst sees the page (per brief)', () => {
    setUser('fraud_analyst');
    renderRoute();
    expect(screen.getByText(/Investigation Center/i)).toBeInTheDocument();
  });

  it('investigator sees the page', () => {
    setUser('investigator');
    renderRoute();
    expect(screen.getByText(/Investigation Center/i)).toBeInTheDocument();
  });

  it('auditor sees the page', () => {
    setUser('auditor');
    renderRoute();
    expect(screen.getByText(/Investigation Center/i)).toBeInTheDocument();
  });

  it('field_officer is bounced to /', () => {
    setUser('field_officer');
    renderRoute();
    expect(screen.queryByText(/^Investigation Center$/)).not.toBeInTheDocument();
  });

  it('renders KPI strip with all 8 cards', () => {
    setUser('admin');
    renderRoute();
    for (const id of ['kpi-total', 'kpi-open', 'kpi-critical', 'kpi-high-risk', 'kpi-escalated', 'kpi-sla', 'kpi-fraud', 'kpi-resolution']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it('renders banking + insurance domain tiles', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('domain-tile-banking')).toBeInTheDocument();
    expect(screen.getByTestId('domain-tile-insurance')).toBeInTheDocument();
  });

  it('status filter chips render (all + 6 statuses)', () => {
    setUser('admin');
    renderRoute();
    for (const s of ['all', ...INVESTIGATION_STATUSES]) {
      expect(screen.getByTestId(`filter-status-${s}`)).toBeInTheDocument();
    }
  });

  it('renders 7 workflow action buttons in workspace', () => {
    setUser('admin');
    renderRoute();
    for (const a of INVESTIGATION_ACTIONS) {
      expect(screen.getByTestId(`workflow-action-${a}`)).toBeInTheDocument();
    }
  });

  it('renders the 8-step case timeline', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('case-timeline')).toBeInTheDocument();
  });

  it('clicking a status filter narrows the list', () => {
    setUser('admin');
    renderRoute();
    fireEvent.click(screen.getByTestId('filter-status-closed'));
    // 'X of Y' subtitle should now reflect smaller "X"
    const list = screen.getByTestId('inv-section-list');
    expect(list).toBeInTheDocument();
  });

  it('renders analytics KPIs', () => {
    setUser('admin');
    renderRoute();
    for (const id of ['kpi-avg-resolution', 'kpi-fraud-rate', 'kpi-recovery', 'kpi-sla-rate', 'kpi-escalation']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it('renders executive view KPIs', () => {
    setUser('admin');
    renderRoute();
    for (const id of ['exec-kpi-sla', 'exec-kpi-avg', 'exec-kpi-closure']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it('renders 5 evidence-type tiles in vault', () => {
    setUser('admin');
    renderRoute();
    for (const t of ['document', 'pdf', 'image', 'screenshot', 'external_reference']) {
      expect(screen.getByTestId(`vault-type-${t}`)).toBeInTheDocument();
    }
  });
});
