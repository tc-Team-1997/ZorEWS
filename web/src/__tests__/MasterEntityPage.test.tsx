// Phase 9 T11 — MasterEntityPage + MasterMenuPage tests.
//
// Covers the reusable master-entity framework's SPA half: admin-only gate,
// catalog menu render, dynamic CRUD page rendering off the schema, and
// per-row edit/delete actions.

import { describe, expect, it, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { MasterMenuPage } from '@/modules/admin/masters/MasterMenuPage';
import { MasterEntityPage } from '@/modules/admin/masters/MasterEntityPage';
import { DashboardPage } from '@/modules/dashboard/DashboardPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

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

function renderMenu() {
  return renderWithProviders(
    <Routes>
      <Route path="/admin/masters" element={<MasterMenuPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: '/admin/masters' },
  );
}

function renderEntity(entity: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/admin/masters/:entity" element={<MasterEntityPage />} />
      <Route path="/" element={<DashboardPage />} />
    </Routes>,
    { route: `/admin/masters/${entity}` },
  );
}

beforeEach(() => {
  localStorage.clear();
  // suppress jsdom confirm dialog during delete; default to yes
  Object.defineProperty(window, 'confirm', { value: () => true, writable: true });
});

describe('MasterMenuPage', () => {
  it('rejects non-admin', () => {
    setUser('risk_analyst');
    renderMenu();
    expect(screen.queryByTestId('master-menu-page')).not.toBeInTheDocument();
  });

  it('admin sees the catalog with entity links', async () => {
    setUser('admin');
    renderMenu();
    await waitFor(() =>
      expect(screen.getByTestId('master-menu-link-countries')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('master-menu-link-departments')).toBeInTheDocument();
    expect(screen.getByTestId('master-menu-link-risk-categories')).toBeInTheDocument();
  });
});

describe('MasterEntityPage', () => {
  it('rejects non-admin', () => {
    setUser('risk_analyst');
    renderEntity('countries');
    expect(screen.queryByTestId(/master-entity-page/)).not.toBeInTheDocument();
  });

  it('admin sees rows for countries (platform-static)', async () => {
    setUser('admin');
    renderEntity('countries');
    await waitFor(() => expect(screen.getByTestId('master-table')).toBeInTheDocument());
    expect(screen.getByText('India')).toBeInTheDocument();
    expect(screen.getByText('Bhutan')).toBeInTheDocument();
  });

  it('admin can open the create form which renders dynamic fields from schema', async () => {
    setUser('admin');
    renderEntity('countries');
    await waitFor(() => expect(screen.getByTestId('master-table')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('master-new-row'));
    await waitFor(() => expect(screen.getByTestId('master-form')).toBeInTheDocument());
    // The countries schema declares code/name/region/active fields.
    expect(screen.getByTestId('master-field-code')).toBeInTheDocument();
    expect(screen.getByTestId('master-field-name')).toBeInTheDocument();
    expect(screen.getByTestId('master-field-region')).toBeInTheDocument();
    expect(screen.getByTestId('master-field-active')).toBeInTheDocument();
  });

  it('admin can edit an existing row (opens form pre-filled)', async () => {
    setUser('admin');
    renderEntity('countries');
    await waitFor(() => expect(screen.getByText('India')).toBeInTheDocument());
    // Click the first Edit button (any row).
    const editButtons = screen.getAllByText('Edit');
    await userEvent.click(editButtons[0]);
    await waitFor(() => expect(screen.getByTestId('master-form')).toBeInTheDocument());
    // The name input should be pre-populated with the row value.
    const nameField = screen.getByTestId('master-field-name') as HTMLInputElement;
    expect(nameField.value.length).toBeGreaterThan(0);
  });

  it('admin can navigate to a different entity (departments — tenant-scoped)', async () => {
    setUser('admin');
    renderEntity('departments');
    await waitFor(() => expect(screen.getByTestId('master-table')).toBeInTheDocument());
    expect(screen.getByText('Credit Risk')).toBeInTheDocument();
    expect(screen.getByText('Operations')).toBeInTheDocument();
  });
});
