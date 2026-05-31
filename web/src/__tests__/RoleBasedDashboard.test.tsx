// Role-Based Dashboard Engine smoke tests + pure-resolver invariants.

import { describe, expect, it, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { RoleBasedDashboardPage } from '@/modules/dashboard/roleEngine/RoleBasedDashboardPage';
import {
  WIDGET_REGISTRY,
  getWidget,
  widgetsByCategory,
  ALL_WIDGET_KINDS,
} from '@/modules/dashboard/roleEngine/widgetRegistry';
import {
  resolveDashboardWidgets,
  resolveRoleDefaultDashboard,
  resolvePresetWidgets,
  ROLE_PRESETS,
  type DashboardContext,
} from '@/modules/dashboard/roleEngine/roleDashboardEngine';
import {
  generateAiInsights,
  ALL_AI_INSIGHT_SEVERITIES,
} from '@/modules/dashboard/roleEngine/aiInsights';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

function setUser(role: 'admin' | 'supervisor' | 'risk_analyst' | 'field_officer') {
  const user = {
    id: 'u-001',
    username: `test.${role}`,
    roles: [role] as ('admin' | 'supervisor' | 'risk_analyst' | 'field_officer')[],
  };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'mock.test.token');
  useAuth.setState({ status: 'authenticated', user: user as never, token: 'mock.test.token' });
}

function renderRoute() {
  return renderWithProviders(
    <Routes>
      <Route path="/dashboards/role-based" element={<RoleBasedDashboardPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: '/dashboards/role-based' },
  );
}

beforeEach(() => {
  localStorage.clear();
});

// ─── Widget registry invariants ─────────────────────────────────────────

describe('widgetRegistry', () => {
  it('has ≥40 widgets across the 4 source arrays', () => {
    expect(WIDGET_REGISTRY.length).toBeGreaterThanOrEqual(40);
  });

  it('every widget has a unique id', () => {
    const ids = WIDGET_REGISTRY.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every widget kind is in the canonical enum', () => {
    for (const w of WIDGET_REGISTRY) {
      expect(ALL_WIDGET_KINDS).toContain(w.kind);
    }
  });

  it('groups widgets by category', () => {
    const groups = widgetsByCategory();
    expect(Object.keys(groups).length).toBeGreaterThan(0);
    // executive_kpi category has 8 KPIs per the brief
    expect(groups['executive_kpi']?.length).toBeGreaterThanOrEqual(8);
    // banking category has 8 dedicated widgets
    expect(groups['banking']?.length).toBeGreaterThanOrEqual(8);
    // insurance category has 8 dedicated widgets
    expect(groups['insurance']?.length).toBeGreaterThanOrEqual(8);
  });

  it('getWidget returns the right entry by id', () => {
    expect(getWidget('kpi_total_alerts')?.kind).toBe('kpi');
    expect(getWidget('non-existent')).toBeUndefined();
  });
});

// ─── Pure resolver ──────────────────────────────────────────────────────

describe('resolveDashboardWidgets', () => {
  const baseCtx: DashboardContext = {
    role: 'risk_analyst',
    domain: 'banking',
    country: null,
    tenant_id: 'BANK_DEMO',
    branch_id: null,
  };

  it('risk_analyst + banking sees banking widgets, no insurance widgets', () => {
    const r = resolveDashboardWidgets(baseCtx);
    const insuranceWidgets = r.widgets.filter((w) => w.default_domain === 'insurance');
    expect(insuranceWidgets).toHaveLength(0);
    const bankingWidgets = r.widgets.filter((w) => w.default_domain === 'banking');
    expect(bankingWidgets.length).toBeGreaterThan(0);
  });

  it('risk_analyst + insurance sees insurance widgets, no banking-only', () => {
    const r = resolveDashboardWidgets({ ...baseCtx, domain: 'insurance' });
    const banking = r.widgets.filter((w) => w.default_domain === 'banking');
    expect(banking).toHaveLength(0);
  });

  it('field_officer sees fewer widgets than admin (RBAC narrowing)', () => {
    const fieldOfficer = resolveDashboardWidgets({ ...baseCtx, role: 'field_officer' });
    const admin = resolveDashboardWidgets({ ...baseCtx, role: 'admin' });
    expect(fieldOfficer.widgets.length).toBeLessThan(admin.widgets.length);
  });

  it('super_admin sees ALL widgets (registry size)', () => {
    const r = resolveDashboardWidgets({ ...baseCtx, role: 'super_admin', domain: 'both' });
    expect(r.widgets.length).toBe(WIDGET_REGISTRY.length);
    expect(r.excluded).toHaveLength(0);
  });

  it('excluded widgets carry a reason', () => {
    const r = resolveDashboardWidgets({ ...baseCtx, role: 'field_officer' });
    expect(r.excluded.length).toBeGreaterThan(0);
    for (const w of r.excluded) {
      expect(r.exclusion_reasons[w.id]).toBeTruthy();
    }
  });

  it('hidden user preference removes a widget', () => {
    const r = resolveDashboardWidgets({ ...baseCtx, role: 'super_admin', domain: 'both' }, [
      { widget_id: 'kpi_total_alerts', pinned: false, hidden: true, sort_order: null },
    ]);
    const ids = r.widgets.map((w) => w.id);
    expect(ids).not.toContain('kpi_total_alerts');
  });

  it('pinned preference wins over hidden (defensive)', () => {
    const r = resolveDashboardWidgets({ ...baseCtx, role: 'super_admin', domain: 'both' }, [
      { widget_id: 'kpi_total_alerts', pinned: true, hidden: true, sort_order: 0 },
    ]);
    const ids = r.widgets.map((w) => w.id);
    expect(ids).toContain('kpi_total_alerts');
  });

  it('pinned widgets float to position 0', () => {
    const r = resolveDashboardWidgets({ ...baseCtx, role: 'super_admin', domain: 'both' }, [
      { widget_id: 'rs_audit_exceptions', pinned: true, hidden: false, sort_order: 0 },
    ]);
    expect(r.widgets[0]?.id).toBe('rs_audit_exceptions');
  });
});

describe('resolvePresetWidgets', () => {
  it('drops unknown ids defensively', () => {
    const ctx: DashboardContext = { role: 'super_admin', domain: 'both', country: null, tenant_id: null, branch_id: null };
    const r = resolvePresetWidgets(['bogus_id', 'kpi_total_alerts'], ctx);
    expect(r.map((w) => w.id)).toEqual(['kpi_total_alerts']);
  });

  it('respects role + domain even for presets', () => {
    const ctx: DashboardContext = { role: 'field_officer', domain: 'insurance', country: null, tenant_id: null, branch_id: null };
    // bw_npa_prediction is banking-only — should drop
    const r = resolvePresetWidgets(['bw_npa_prediction'], ctx);
    expect(r).toHaveLength(0);
  });
});

describe('resolveRoleDefaultDashboard', () => {
  it('uses ROLE_PRESETS when no user prefs supplied', () => {
    const ctx: DashboardContext = { role: 'auditor', domain: 'both', country: null, tenant_id: null, branch_id: null };
    const r = resolveRoleDefaultDashboard(ctx);
    // auditor preset includes audit exceptions
    const ids = r.widgets.map((w) => w.id);
    expect(ids).toContain('rs_audit_exceptions');
  });

  it('falls back to generic resolver when role has no preset', () => {
    const ctx: DashboardContext = { role: 'admin', domain: 'both', country: null, tenant_id: null, branch_id: null };
    const r = resolveRoleDefaultDashboard(ctx);
    // admin (backend role) has empty preset → falls through, gets all admin-tagged widgets
    expect(r.widgets.length).toBeGreaterThan(10);
  });

  it('preferences override presets', () => {
    const ctx: DashboardContext = { role: 'auditor', domain: 'both', country: null, tenant_id: null, branch_id: null };
    const r = resolveRoleDefaultDashboard(ctx, [
      { widget_id: 'rs_audit_exceptions', pinned: false, hidden: true, sort_order: null },
    ]);
    const ids = r.widgets.map((w) => w.id);
    expect(ids).not.toContain('rs_audit_exceptions');
  });
});

describe('ROLE_PRESETS', () => {
  it('has all 8 declared roles + 4 fallback backend roles', () => {
    expect(Object.keys(ROLE_PRESETS).length).toBeGreaterThanOrEqual(8);
    expect(ROLE_PRESETS.super_admin.length).toBeGreaterThan(0);
    expect(ROLE_PRESETS.executive.length).toBeGreaterThan(0);
  });

  it('each preset entry points at a real widget id', () => {
    for (const role of Object.keys(ROLE_PRESETS) as Array<keyof typeof ROLE_PRESETS>) {
      for (const wid of ROLE_PRESETS[role]) {
        expect(getWidget(wid), `${role} preset references unknown widget ${wid}`).toBeDefined();
      }
    }
  });
});

// ─── AI Insights ────────────────────────────────────────────────────────

describe('generateAiInsights', () => {
  const now = new Date('2026-05-31T00:00:00Z');

  it('returns exactly 5 cards', () => {
    const r = generateAiInsights('risk_analyst', 'banking', now);
    expect(r).toHaveLength(5);
  });

  it('is deterministic per (role, domain, day)', () => {
    const a = generateAiInsights('risk_analyst', 'banking', now);
    const b = generateAiInsights('risk_analyst', 'banking', now);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });

  it('differs by domain', () => {
    const banking = generateAiInsights('admin', 'banking', now);
    const insurance = generateAiInsights('admin', 'insurance', now);
    // Different pools → at least one differing title
    const overlap = banking.filter((b) => insurance.find((i) => i.title === b.title));
    expect(overlap.length).toBeLessThan(5);
  });

  it('every card has a severity in the canonical enum', () => {
    const r = generateAiInsights('super_admin', 'both', now);
    for (const c of r) {
      expect(ALL_AI_INSIGHT_SEVERITIES).toContain(c.severity);
    }
  });

  it('id encodes day + role + domain', () => {
    const r = generateAiInsights('risk_analyst', 'banking', now);
    expect(r[0]?.id).toContain('2026-05-31');
    expect(r[0]?.id).toContain('risk_analyst');
    expect(r[0]?.id).toContain('banking');
  });
});

// ─── SPA Page render ────────────────────────────────────────────────────

describe('RoleBasedDashboardPage', () => {
  it('admin sees the page + KPI strip + insights panel + widget grid', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('role-based-dashboard-page')).toBeInTheDocument();
    expect(screen.getByTestId('role-dashboard-kpi-strip')).toBeInTheDocument();
    expect(screen.getByTestId('role-dashboard-ai-insights')).toBeInTheDocument();
    expect(screen.getByTestId('role-dashboard-widget-grid')).toBeInTheDocument();
  });

  it('renders the governance banner', () => {
    setUser('admin');
    renderRoute();
    expect(screen.getByTestId('role-dashboard-governance-banner')).toBeInTheDocument();
  });

  it('field_officer sees a narrower set (still renders the page — no bounce)', () => {
    setUser('field_officer');
    renderRoute();
    // role-based dashboard does NOT gate on role; it composes whatever widgets
    // the role IS entitled to see. Page renders for every role.
    expect(screen.getByTestId('role-based-dashboard-page')).toBeInTheDocument();
  });
});
