// IAM Center + sub-page smoke tests.
//
// Pattern: same as Rule Center / Audit Center / AI Governance tests.

import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { IamCenterPage, IAM_CENTER_CARDS } from '@/modules/admin/iam/IamCenterPage';
import { UserLifecyclePage } from '@/modules/admin/iam/UserLifecyclePage';
import { UserApprovalsInboxPage } from '@/modules/admin/iam/UserApprovalsInboxPage';
import { UserAccessReviewPage } from '@/modules/admin/iam/UserAccessReviewPage';
import { UserAuditHistoryPage } from '@/modules/admin/iam/UserAuditHistoryPage';
import { PasswordPolicyPage } from '@/modules/admin/iam/PasswordPolicyPage';
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

describe('IamCenterPage', () => {
  it('admin sees all 6 cards', () => {
    setUser('admin');
    renderRoute('/admin/iam', <IamCenterPage />);
    expect(screen.getByTestId('iam-center-page')).toBeInTheDocument();
    for (const card of IAM_CENTER_CARDS) {
      expect(screen.getByTestId(`iam-center-card-${card.id}`)).toBeInTheDocument();
    }
  });

  it('supervisor can see the page', () => {
    setUser('supervisor');
    renderRoute('/admin/iam', <IamCenterPage />);
    expect(screen.getByTestId('iam-center-page')).toBeInTheDocument();
  });

  it('risk_analyst is bounced (below admin+supervisor gate)', () => {
    setUser('risk_analyst');
    renderRoute('/admin/iam', <IamCenterPage />);
    expect(screen.queryByTestId('iam-center-page')).not.toBeInTheDocument();
  });

  it('field_officer is bounced', () => {
    setUser('field_officer');
    renderRoute('/admin/iam', <IamCenterPage />);
    expect(screen.queryByTestId('iam-center-page')).not.toBeInTheDocument();
  });

  it('exports 6 cards in canonical order', () => {
    const ids = IAM_CENTER_CARDS.map((c) => c.id);
    expect(ids).toEqual(['lifecycle', 'access-review', 'approvals', 'audit', 'sessions', 'password-policy']);
  });

  it('legacy-URL panel renders', () => {
    setUser('admin');
    renderRoute('/admin/iam', <IamCenterPage />);
    expect(screen.getByTestId('iam-center-legacy-links')).toBeInTheDocument();
  });

  it('every card declares a /admin/* target', () => {
    for (const card of IAM_CENTER_CARDS) {
      expect(card.to.startsWith('/admin/')).toBe(true);
    }
  });
});

describe('UserLifecyclePage', () => {
  it('admin sees the page + KPI strip', async () => {
    setUser('admin');
    renderRoute('/admin/iam/lifecycle', <UserLifecyclePage />);
    expect(screen.getByTestId('user-lifecycle-page')).toBeInTheDocument();
    expect(screen.getByTestId('user-lifecycle-kpis')).toBeInTheDocument();
    expect(screen.getByTestId('user-lifecycle-kpi-active')).toBeInTheDocument();
    expect(screen.getByTestId('user-lifecycle-kpi-locked')).toBeInTheDocument();
  });

  it('risk_analyst is bounced', () => {
    setUser('risk_analyst');
    renderRoute('/admin/iam/lifecycle', <UserLifecyclePage />);
    expect(screen.queryByTestId('user-lifecycle-page')).not.toBeInTheDocument();
  });
});

describe('UserApprovalsInboxPage', () => {
  it('admin sees the pending tab + KPIs', async () => {
    setUser('admin');
    renderRoute('/admin/iam/approvals', <UserApprovalsInboxPage />);
    expect(screen.getByTestId('user-approvals-inbox-page')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('approvals-tabs')).toBeInTheDocument());
    expect(screen.getByTestId('approvals-tab-pending')).toBeInTheDocument();
  });

  it('risk_analyst is bounced', () => {
    setUser('risk_analyst');
    renderRoute('/admin/iam/approvals', <UserApprovalsInboxPage />);
    expect(screen.queryByTestId('user-approvals-inbox-page')).not.toBeInTheDocument();
  });
});

describe('UserAccessReviewPage', () => {
  it('admin sees the list view', () => {
    setUser('admin');
    renderRoute('/admin/iam/access-review', <UserAccessReviewPage />);
    expect(screen.getByTestId('user-access-review-page')).toBeInTheDocument();
  });

  it('risk_analyst is bounced', () => {
    setUser('risk_analyst');
    renderRoute('/admin/iam/access-review', <UserAccessReviewPage />);
    expect(screen.queryByTestId('user-access-review-page')).not.toBeInTheDocument();
  });
});

describe('UserAuditHistoryPage', () => {
  it('admin sees the page + filters', () => {
    setUser('admin');
    renderRoute('/admin/iam/audit', <UserAuditHistoryPage />);
    expect(screen.getByTestId('user-audit-history-page')).toBeInTheDocument();
    expect(screen.getByTestId('audit-history-filters')).toBeInTheDocument();
  });

  it('risk_analyst is bounced', () => {
    setUser('risk_analyst');
    renderRoute('/admin/iam/audit', <UserAuditHistoryPage />);
    expect(screen.queryByTestId('user-audit-history-page')).not.toBeInTheDocument();
  });
});

describe('PasswordPolicyPage', () => {
  it('admin sees the page + KPI strip', () => {
    setUser('admin');
    renderRoute('/admin/iam/password-policy', <PasswordPolicyPage />);
    expect(screen.getByTestId('password-policy-page')).toBeInTheDocument();
    expect(screen.getByTestId('password-policy-kpis')).toBeInTheDocument();
  });

  it('supervisor is bounced (admin-only — destructive surface)', () => {
    setUser('supervisor');
    renderRoute('/admin/iam/password-policy', <PasswordPolicyPage />);
    expect(screen.queryByTestId('password-policy-page')).not.toBeInTheDocument();
  });

  it('risk_analyst is bounced', () => {
    setUser('risk_analyst');
    renderRoute('/admin/iam/password-policy', <PasswordPolicyPage />);
    expect(screen.queryByTestId('password-policy-page')).not.toBeInTheDocument();
  });
});
