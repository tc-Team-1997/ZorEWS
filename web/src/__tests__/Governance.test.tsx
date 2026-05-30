// Tenant Governance SPA smoke test.
// Covers BranchesPage + ComplianceRulesPage + useGovernance + useCanAccessBranch.

import { describe, expect, it, beforeEach } from 'vitest';
import { renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';
import { BranchesPage } from '@/modules/admin/governance/BranchesPage';
import { ComplianceRulesPage } from '@/modules/admin/governance/ComplianceRulesPage';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { useGovernance, useCanAccessBranch } from '@/lib/useGovernance';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';
import { __resetMswGovernance } from '@/mocks/handlers';

function setUser(role: 'admin' | 'risk_analyst') {
  const user = {
    id: 'u-001',
    username: role === 'admin' ? 'alice.admin' : 'test.risk_analyst',
    roles: [role] as ('admin' | 'risk_analyst')[],
  };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'mock.test.token');
  useAuth.setState({ status: 'authenticated', user: user as never, token: 'mock.test.token' });
}

function renderBranches() {
  return renderWithProviders(
    <Routes>
      <Route path="/admin/governance/branches" element={<BranchesPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: '/admin/governance/branches' },
  );
}

function renderRules() {
  return renderWithProviders(
    <Routes>
      <Route path="/admin/governance/compliance-rules" element={<ComplianceRulesPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: '/admin/governance/compliance-rules' },
  );
}

function hookWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function W({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  localStorage.clear();
  __resetMswGovernance();
  Object.defineProperty(window, 'confirm', { value: () => true, writable: true });
});

describe('BranchesPage', () => {
  it('redirects non-admin', () => {
    setUser('risk_analyst');
    renderBranches();
    expect(screen.queryByTestId('branches-page')).not.toBeInTheDocument();
  });

  it('admin sees the seeded branches', async () => {
    setUser('admin');
    renderBranches();
    await waitFor(() => expect(screen.getByTestId('branches-table')).toBeInTheDocument());
    expect(screen.getByText('HDFC Bank Fort Branch')).toBeInTheDocument();
    expect(screen.getByText('BIL Thimphu Head Office')).toBeInTheDocument();
  });

  it('renders create form when New is clicked', async () => {
    setUser('admin');
    renderBranches();
    await waitFor(() => expect(screen.getByTestId('branches-new-row')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('branches-new-row'));
    expect(screen.getByTestId('branches-form')).toBeInTheDocument();
    expect(screen.getByTestId('branches-field-tenant_id')).toBeInTheDocument();
    expect(screen.getByTestId('branches-field-country_code')).toBeInTheDocument();
  });
});

describe('ComplianceRulesPage', () => {
  it('redirects non-admin', () => {
    setUser('risk_analyst');
    renderRules();
    expect(screen.queryByTestId('compliance-rules-page')).not.toBeInTheDocument();
  });

  it('admin sees seeded compliance rules', async () => {
    setUser('admin');
    renderRules();
    await waitFor(() => expect(screen.getByTestId('rules-table')).toBeInTheDocument());
    expect(screen.getByText('RBI-MD-NPA-2024')).toBeInTheDocument();
    expect(screen.getByText('IRDAI-CG-2016')).toBeInTheDocument();
  });

  it('create form exposes domain + requirement_kind + severity selects', async () => {
    setUser('admin');
    renderRules();
    await waitFor(() => expect(screen.getByTestId('rules-new-row')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('rules-new-row'));
    expect(screen.getByTestId('rules-field-domain')).toBeInTheDocument();
    expect(screen.getByTestId('rules-field-requirement_kind')).toBeInTheDocument();
    expect(screen.getByTestId('rules-field-severity')).toBeInTheDocument();
  });
});

describe('useGovernance hook', () => {
  it('admin in BANK_DEMO gets full context with banking vertical', async () => {
    setUser('admin');
    const { result } = renderHook(() => useGovernance(), { wrapper: hookWrapper() });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.tenant_id).toBe('BANK_DEMO');
    expect(result.current?.tenant_vertical).toBe('banking');
  });

  it('useCanAccessBranch — admin sees every branch', async () => {
    setUser('admin');
    const W = hookWrapper();
    const { result } = renderHook(() => useCanAccessBranch('any-branch-id'), { wrapper: W });
    await waitFor(() => expect(result.current).toBe(true));
  });
});
