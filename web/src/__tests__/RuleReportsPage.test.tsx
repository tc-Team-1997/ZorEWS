// Phase 9 T10 — Rule Engine Reports page test.
//
// Covers the MSW-backed report load + KPI grid + cohort chips + tables.

import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { RuleReportsPage } from '@/modules/rules/RuleReportsPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

function setAdmin() {
  const user = { id: 'u-001', username: 'alice.admin', roles: ['admin'] };
  localStorage.setItem('apex.ews.user', JSON.stringify(user));
  localStorage.setItem('apex.ews.token', 'mock.test.token');
  useAuth.setState({ status: 'authenticated', user, token: 'mock.test.token' });
}

function renderReports() {
  return renderWithProviders(
    <Routes>
      <Route path="/rules/reports" element={<RuleReportsPage />} />
    </Routes>,
    { route: '/rules/reports' },
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('RuleReportsPage', () => {
  it('renders KPI cards + page header after data loads', async () => {
    setAdmin();
    renderReports();
    await waitFor(() => {
      expect(screen.getByTestId('rule-reports-page')).toBeInTheDocument();
    });
    expect(screen.getByText(/Rule Engine Reports/i)).toBeInTheDocument();
    expect(screen.getByTestId('kpi-total-rules')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-active-rules')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-alerts-12mo')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-triggers-month')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-mean-precision')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-mean-fp')).toBeInTheDocument();
  });

  it('renders the 3 ranked tables (top firing / underperforming / silent)', async () => {
    setAdmin();
    renderReports();
    await waitFor(() => {
      expect(screen.getByTestId('top-firing-table')).toBeInTheDocument();
    });
    expect(screen.getByTestId('top-firing-table')).toBeInTheDocument();
    expect(screen.getByTestId('underperforming-table')).toBeInTheDocument();
    expect(screen.getByTestId('silent-rules-table')).toBeInTheDocument();
  });

  it('Export dropdown opens on click + lists CSV/PDF/Excel options', async () => {
    setAdmin();
    const user = userEvent.setup();
    renderReports();
    await waitFor(() => {
      expect(screen.getByTestId('rule-reports-export')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('rule-reports-export'));
    expect(screen.getByTestId('rule-reports-export-csv')).toBeInTheDocument();
    expect(screen.getByTestId('rule-reports-export-pdf')).toBeInTheDocument();
    expect(screen.getByTestId('rule-reports-export-xlsx')).toBeInTheDocument();
  });

  it('Export menu closes on Escape', async () => {
    setAdmin();
    const user = userEvent.setup();
    renderReports();
    await waitFor(() => {
      expect(screen.getByTestId('rule-reports-export')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('rule-reports-export'));
    expect(screen.getByTestId('rule-reports-export-csv')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('rule-reports-export-csv')).not.toBeInTheDocument();
    });
  });
});
