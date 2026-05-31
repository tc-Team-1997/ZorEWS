// Enterprise Governance Center smoke tests.

import { describe, expect, it, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { GovernanceCenterPage, GOVERNANCE_CARDS } from '@/modules/admin/governance/GovernanceCenterPage';
import { OrganizationGovernancePage, ORG_CARDS } from '@/modules/admin/governance/OrganizationGovernancePage';
import { DomainGovernancePage, DOMAIN_CARDS } from '@/modules/admin/governance/DomainGovernancePage';
import { RoleGovernancePage, ROLE_TEMPLATES } from '@/modules/admin/governance/RoleGovernancePage';
import { RiskAndAlertGovernancePage } from '@/modules/admin/governance/RiskAndAlertGovernancePage';
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

function renderRoute(path: string, element: React.ReactElement) {
  return renderWithProviders(
    <Routes>
      <Route path={path} element={element} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: path },
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('GovernanceCenterPage', () => {
  it('admin sees all 11 governance cards', () => {
    setUser('admin');
    renderRoute('/admin/governance', <GovernanceCenterPage />);
    expect(screen.getByTestId('governance-center-page')).toBeInTheDocument();
    for (const card of GOVERNANCE_CARDS) {
      expect(screen.getByTestId(`governance-center-card-${card.id}`)).toBeInTheDocument();
    }
  });

  it('supervisor can see the page', () => {
    setUser('supervisor');
    renderRoute('/admin/governance', <GovernanceCenterPage />);
    expect(screen.getByTestId('governance-center-page')).toBeInTheDocument();
  });

  it('risk_analyst is bounced', () => {
    setUser('risk_analyst');
    renderRoute('/admin/governance', <GovernanceCenterPage />);
    expect(screen.queryByTestId('governance-center-page')).not.toBeInTheDocument();
  });

  it('exports exactly 11 cards in canonical brief order', () => {
    expect(GOVERNANCE_CARDS.map((c) => c.id)).toEqual([
      'organization', 'domain', 'tenant', 'role', 'risk', 'alert',
      'escalation', 'sla', 'notification', 'calendar', 'audit',
    ]);
  });

  it('legacy-URL panel renders', () => {
    setUser('admin');
    renderRoute('/admin/governance', <GovernanceCenterPage />);
    expect(screen.getByTestId('governance-center-legacy-links')).toBeInTheDocument();
  });

  it('every card targets a real admin route', () => {
    for (const card of GOVERNANCE_CARDS) {
      expect(card.to.startsWith('/admin/') || card.to.startsWith('/audit-center/')).toBe(true);
    }
  });
});

describe('OrganizationGovernancePage', () => {
  it('admin sees 4 sub-section cards', () => {
    setUser('admin');
    renderRoute('/admin/governance/organization', <OrganizationGovernancePage />);
    expect(screen.getByTestId('org-governance-page')).toBeInTheDocument();
    for (const c of ORG_CARDS) {
      expect(screen.getByTestId(`org-governance-card-${c.id}`)).toBeInTheDocument();
    }
  });

  it('exports 4 cards in canonical order', () => {
    expect(ORG_CARDS.map((c) => c.id)).toEqual(['countries', 'regions', 'branches', 'departments']);
  });

  it('risk_analyst is bounced', () => {
    setUser('risk_analyst');
    renderRoute('/admin/governance/organization', <OrganizationGovernancePage />);
    expect(screen.queryByTestId('org-governance-page')).not.toBeInTheDocument();
  });
});

describe('DomainGovernancePage', () => {
  it('admin sees both domain cards', () => {
    setUser('admin');
    renderRoute('/admin/governance/domains', <DomainGovernancePage />);
    expect(screen.getByTestId('domain-governance-page')).toBeInTheDocument();
    expect(screen.getByTestId('domain-governance-card-banking')).toBeInTheDocument();
    expect(screen.getByTestId('domain-governance-card-insurance')).toBeInTheDocument();
  });

  it('exports 2 domains', () => {
    expect(DOMAIN_CARDS.map((d) => d.id)).toEqual(['banking', 'insurance']);
  });

  it('risk_analyst is bounced', () => {
    setUser('risk_analyst');
    renderRoute('/admin/governance/domains', <DomainGovernancePage />);
    expect(screen.queryByTestId('domain-governance-page')).not.toBeInTheDocument();
  });
});

describe('RoleGovernancePage', () => {
  it('admin sees all 10 role templates', () => {
    setUser('admin');
    renderRoute('/admin/governance/roles', <RoleGovernancePage />);
    expect(screen.getByTestId('role-governance-page')).toBeInTheDocument();
    for (const r of ROLE_TEMPLATES) {
      expect(screen.getByTestId(`role-governance-template-${r.id}`)).toBeInTheDocument();
    }
  });

  it('exports exactly 10 role templates', () => {
    expect(ROLE_TEMPLATES.length).toBe(10);
  });

  it('every template carries a valid scope', () => {
    for (const r of ROLE_TEMPLATES) {
      expect(['platform', 'country', 'tenant']).toContain(r.scope);
    }
  });

  it('risk_analyst is bounced', () => {
    setUser('risk_analyst');
    renderRoute('/admin/governance/roles', <RoleGovernancePage />);
    expect(screen.queryByTestId('role-governance-page')).not.toBeInTheDocument();
  });
});

describe('RiskAndAlertGovernancePage', () => {
  it('admin sees risk + alert card sections', () => {
    setUser('admin');
    renderRoute('/admin/governance/risk', <RiskAndAlertGovernancePage />);
    expect(screen.getByTestId('risk-alert-governance-page')).toBeInTheDocument();
    expect(screen.getByTestId('risk-cards')).toBeInTheDocument();
    expect(screen.getByTestId('alert-cards')).toBeInTheDocument();
  });

  it('risk_analyst is bounced', () => {
    setUser('risk_analyst');
    renderRoute('/admin/governance/risk', <RiskAndAlertGovernancePage />);
    expect(screen.queryByTestId('risk-alert-governance-page')).not.toBeInTheDocument();
  });
});
