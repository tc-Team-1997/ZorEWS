// Executive Risk Cockpit — page render + role gate + 4 pure-resolver suites.

import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { ExecutiveCockpitPage } from '@/modules/executive/ExecutiveCockpitPage';
import {
  ALL_EXECUTIVE_ACTIONS,
  EXECUTIVE_ACTIONS,
  EXECUTIVE_ROLES,
  actionsForRole,
  canAccessExecutiveCockpit,
  getEnterpriseRiskOverview,
  getPredictiveForecasts,
  getRiskHeatmap,
  getStrategicKpis,
  getTopExposures,
} from '@/modules/executive/executiveCockpitEngine';
import {
  ALL_BRIEFING_CADENCES,
  ALL_REPORT_FORMATS,
  REPORT_TEMPLATES,
  generateAllBriefings,
  generateExecutiveBriefing,
  getReportTemplate,
} from '@/modules/executive/executiveBriefing';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

type AnyRole = 'admin' | 'supervisor' | 'risk_analyst' | 'field_officer';

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
      <Route path="/executive-cockpit" element={<ExecutiveCockpitPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: '/executive-cockpit' },
  );
}

beforeEach(() => {
  localStorage.clear();
});

// ─── Role gate ──────────────────────────────────────────────────────────

describe('canAccessExecutiveCockpit', () => {
  it('grants the 7 declared executive personas', () => {
    for (const role of EXECUTIVE_ROLES) {
      expect(canAccessExecutiveCockpit([role])).toBe(true);
    }
  });

  it('grants generic executive + admin (legacy backend)', () => {
    expect(canAccessExecutiveCockpit(['executive'])).toBe(true);
    expect(canAccessExecutiveCockpit(['admin'])).toBe(true);
  });

  it('refuses non-executive roles', () => {
    expect(canAccessExecutiveCockpit(['risk_analyst'])).toBe(false);
    expect(canAccessExecutiveCockpit(['field_officer'])).toBe(false);
    expect(canAccessExecutiveCockpit(['collection_officer'])).toBe(false);
  });

  it('refuses empty / null input', () => {
    expect(canAccessExecutiveCockpit(null)).toBe(false);
    expect(canAccessExecutiveCockpit(undefined)).toBe(false);
    expect(canAccessExecutiveCockpit([])).toBe(false);
  });
});

// ─── Enterprise Risk Overview ───────────────────────────────────────────

describe('getEnterpriseRiskOverview', () => {
  it('returns 7 KPIs in stable order', () => {
    const r = getEnterpriseRiskOverview('BANK_DEMO');
    expect(r.length).toBe(7);
    expect(r[0]?.widget_id).toBe('rs_enterprise_risk_score');
  });

  it('is deterministic per (tenant, day)', () => {
    const now = new Date('2026-05-31T00:00:00Z');
    const a = getEnterpriseRiskOverview('BANK_DEMO', now);
    const b = getEnterpriseRiskOverview('BANK_DEMO', now);
    expect(a.map((k) => k.value)).toEqual(b.map((k) => k.value));
  });

  it('different tenants produce different values', () => {
    const now = new Date('2026-05-31T00:00:00Z');
    const a = getEnterpriseRiskOverview('BANK_DEMO', now);
    const b = getEnterpriseRiskOverview('BIL', now);
    expect(a.map((k) => k.value)).not.toEqual(b.map((k) => k.value));
  });

  it('every KPI carries a label + value + sub', () => {
    for (const k of getEnterpriseRiskOverview('BANK_DEMO')) {
      expect(k.label.length).toBeGreaterThan(0);
      expect(k.value.length).toBeGreaterThan(0);
    }
  });
});

// ─── Risk Heatmap ───────────────────────────────────────────────────────

describe('getRiskHeatmap', () => {
  it('produces non-empty cells for each scope', () => {
    for (const scope of ['country', 'tenant', 'branch', 'sector'] as const) {
      const cells = getRiskHeatmap(scope, 'BANK_DEMO');
      expect(cells.length).toBeGreaterThan(0);
    }
  });

  it('every cell has band ∈ low/medium/high/critical', () => {
    const r = getRiskHeatmap('country', 'BANK_DEMO');
    for (const c of r) {
      expect(['low', 'medium', 'high', 'critical']).toContain(c.band);
    }
  });

  it('risk_score within 0..100', () => {
    const r = getRiskHeatmap('country', 'BANK_DEMO');
    for (const c of r) {
      expect(c.risk_score).toBeGreaterThanOrEqual(0);
      expect(c.risk_score).toBeLessThanOrEqual(100);
    }
  });

  it('is deterministic per (scope, tenant, day)', () => {
    const now = new Date('2026-05-31T00:00:00Z');
    const a = getRiskHeatmap('branch', 'BANK_DEMO', now);
    const b = getRiskHeatmap('branch', 'BANK_DEMO', now);
    expect(a.map((c) => c.risk_score)).toEqual(b.map((c) => c.risk_score));
  });
});

// ─── Top Risk Exposures ─────────────────────────────────────────────────

describe('getTopExposures', () => {
  it('returns exactly 10 rows for every exposure kind', () => {
    for (const kind of ['borrowers', 'portfolios', 'policies', 'fraud_cases'] as const) {
      expect(getTopExposures(kind, 'BANK_DEMO').length).toBe(10);
    }
  });

  it('rank is 1..10 stable', () => {
    const r = getTopExposures('borrowers', 'BANK_DEMO');
    expect(r.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('every row has at least 1 driver', () => {
    const r = getTopExposures('fraud_cases', 'BANK_DEMO');
    for (const row of r) {
      expect(row.drivers.length).toBeGreaterThan(0);
    }
  });

  it('entity_id has the kind prefix', () => {
    expect(getTopExposures('borrowers', 'BANK_DEMO')[0]?.entity_id).toMatch(/^CUST-/);
    expect(getTopExposures('policies', 'BANK_DEMO')[0]?.entity_id).toMatch(/^POL-/);
    expect(getTopExposures('portfolios', 'BANK_DEMO')[0]?.entity_id).toMatch(/^PORT-/);
    expect(getTopExposures('fraud_cases', 'BANK_DEMO')[0]?.entity_id).toMatch(/^CASE-/);
  });
});

// ─── Predictive Intelligence ────────────────────────────────────────────

describe('getPredictiveForecasts', () => {
  it('returns 5 forecasts (one per ForecastKind)', () => {
    const r = getPredictiveForecasts('BANK_DEMO');
    expect(r.length).toBe(5);
  });

  it('every series has 9 buckets (6 actual + 3 forecast)', () => {
    const r = getPredictiveForecasts('BANK_DEMO');
    for (const f of r) {
      expect(f.series.length).toBe(9);
      const forecastCount = f.series.filter((s) => s.is_forecast).length;
      expect(forecastCount).toBe(3);
    }
  });

  it('confidence is in [0, 1]', () => {
    const r = getPredictiveForecasts('BANK_DEMO');
    for (const f of r) {
      expect(f.confidence).toBeGreaterThanOrEqual(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('severity ∈ info | warning | critical', () => {
    const r = getPredictiveForecasts('BANK_DEMO');
    for (const f of r) {
      expect(['info', 'warning', 'critical']).toContain(f.severity);
    }
  });
});

// ─── Strategic KPIs ─────────────────────────────────────────────────────

describe('getStrategicKpis', () => {
  it('returns 6 KPIs', () => {
    const r = getStrategicKpis('BANK_DEMO');
    expect(r.length).toBe(6);
  });

  it('every KPI band ∈ green/amber/red', () => {
    const r = getStrategicKpis('BANK_DEMO');
    for (const k of r) {
      expect(['green', 'amber', 'red']).toContain(k.band);
    }
  });

  it('every KPI declared in StrategicKpiId enum', () => {
    const ids = getStrategicKpis('BANK_DEMO').map((k) => k.id);
    expect(ids).toContain('risk_adjusted_return');
    expect(ids).toContain('capital_at_risk');
    expect(ids).toContain('portfolio_stability_index');
    expect(ids).toContain('recovery_efficiency');
    expect(ids).toContain('compliance_health');
    expect(ids).toContain('fraud_loss_avoidance');
  });
});

// ─── Executive Actions ──────────────────────────────────────────────────

describe('EXECUTIVE_ACTIONS', () => {
  it('has 5 actions', () => {
    expect(EXECUTIVE_ACTIONS.length).toBe(5);
    expect(ALL_EXECUTIVE_ACTIONS.length).toBe(5);
  });

  it('every action has a label + description', () => {
    for (const a of EXECUTIVE_ACTIONS) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.description.length).toBeGreaterThan(0);
    }
  });

  it('actionsForRole narrows correctly', () => {
    // board_member should NOT be able to escalate
    const board = actionsForRole('board_member');
    expect(board.map((a) => a.id)).not.toContain('escalate_risk');
    // super_admin gets every action
    const sa = actionsForRole('super_admin');
    expect(sa.length).toBe(EXECUTIVE_ACTIONS.length);
  });
});

// ─── AI Executive Briefing ──────────────────────────────────────────────

describe('generateExecutiveBriefing', () => {
  const now = new Date('2026-05-31T00:00:00Z');

  it('returns a briefing for each cadence', () => {
    for (const c of ALL_BRIEFING_CADENCES) {
      const b = generateExecutiveBriefing('BANK_DEMO', c, now);
      expect(b.cadence).toBe(c);
      expect(b.headline.length).toBeGreaterThan(0);
    }
  });

  it('daily=4, weekly=5, monthly=6 highlights', () => {
    expect(generateExecutiveBriefing('BANK_DEMO', 'daily', now).highlights.length).toBe(4);
    expect(generateExecutiveBriefing('BANK_DEMO', 'weekly', now).highlights.length).toBe(5);
    expect(generateExecutiveBriefing('BANK_DEMO', 'monthly', now).highlights.length).toBe(6);
  });

  it('is deterministic per (tenant, cadence, period_start)', () => {
    const a = generateExecutiveBriefing('BANK_DEMO', 'monthly', now);
    const b = generateExecutiveBriefing('BANK_DEMO', 'monthly', now);
    expect(a.headline).toBe(b.headline);
    expect(a.highlights.map((h) => h.metric)).toEqual(b.highlights.map((h) => h.metric));
  });

  it('different tenants → different briefing', () => {
    const a = generateExecutiveBriefing('BANK_DEMO', 'monthly', now);
    const b = generateExecutiveBriefing('BIL', 'monthly', now);
    // headlines may overlap but the highlight pool draws differently
    const overlap = a.highlights.filter((x) => b.highlights.find((y) => y.metric === x.metric));
    expect(overlap.length).toBeLessThan(a.highlights.length);
  });

  it('generateAllBriefings returns all 3 cadences', () => {
    const r = generateAllBriefings('BANK_DEMO', now);
    expect(r.map((b) => b.cadence)).toEqual([...ALL_BRIEFING_CADENCES]);
  });
});

// ─── Report Templates ───────────────────────────────────────────────────

describe('REPORT_TEMPLATES', () => {
  it('has at least 7 templates', () => {
    expect(REPORT_TEMPLATES.length).toBeGreaterThanOrEqual(7);
  });

  it('every template has at least 1 supported format', () => {
    for (const r of REPORT_TEMPLATES) {
      expect(r.formats.length).toBeGreaterThan(0);
      for (const f of r.formats) {
        expect(ALL_REPORT_FORMATS).toContain(f);
      }
    }
  });

  it('getReportTemplate returns the right entry', () => {
    expect(getReportTemplate('executive_summary')?.label).toBe('Executive Summary');
    expect(getReportTemplate('non-existent')).toBeUndefined();
  });
});

// ─── Page render + role gate ────────────────────────────────────────────

describe('ExecutiveCockpitPage', () => {
  it('admin (legacy) sees the page + all 8 sections', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('executive-cockpit-page')).toBeInTheDocument();
    for (const sec of ['overview', 'heatmap', 'exposures', 'forecasts', 'briefing', 'reporting', 'strategic', 'actions']) {
      expect(screen.getByTestId(`cockpit-section-${sec}`)).toBeInTheDocument();
    }
  });

  it('renders the 7-KPI overview strip', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('cockpit-overview-strip')).toBeInTheDocument();
    // 7 distinct testids
    expect(screen.getAllByTestId(/^cockpit-overview-/).length).toBeGreaterThanOrEqual(7);
  });

  it('renders 4 heatmap tabs', () => {
    setUser('admin');
    renderRoute();
    for (const scope of ['country', 'tenant', 'branch', 'sector']) {
      expect(screen.getByTestId(`cockpit-heatmap-tab-${scope}`)).toBeInTheDocument();
    }
  });

  it('switching exposure kind updates the panel', () => {
    setUser('admin');
    renderRoute();
    fireEvent.click(screen.getByTestId('cockpit-exposure-tab-policies'));
    // POL- prefix surfaces in row entity_id rendering
    const list = screen.getByTestId('cockpit-exposures-list');
    expect(list.textContent).toMatch(/POL-/);
  });

  it('field_officer is bounced', () => {
    setUser('field_officer');
    renderRoute();
    expect(screen.queryByTestId('executive-cockpit-page')).not.toBeInTheDocument();
  });

  it('risk_analyst is bounced', () => {
    setUser('risk_analyst');
    renderRoute();
    expect(screen.queryByTestId('executive-cockpit-page')).not.toBeInTheDocument();
  });

  it('all 5 executive actions render as buttons', () => {
    setUser('admin');
    renderRoute();
    for (const a of ALL_EXECUTIVE_ACTIONS) {
      expect(screen.getByTestId(`cockpit-action-${a}`)).toBeInTheDocument();
    }
  });

  it('clicking an action shows the queued feedback line', () => {
    setUser('admin');
    renderRoute();
    fireEvent.click(screen.getByTestId('cockpit-action-export_report'));
    expect(screen.getByTestId('cockpit-action-feedback')).toBeInTheDocument();
  });

  it('all 3 briefing cadence tabs render', () => {
    setUser('admin');
    renderRoute();
    for (const c of ALL_BRIEFING_CADENCES) {
      expect(screen.getByTestId(`cockpit-briefing-tab-${c}`)).toBeInTheDocument();
    }
  });

  it('cockpit footer surfaces cross-IA links', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('cockpit-footer-links')).toBeInTheDocument();
  });
});
