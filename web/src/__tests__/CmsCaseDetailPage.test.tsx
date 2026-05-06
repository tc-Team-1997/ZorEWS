// web/src/__tests__/CmsCaseDetailPage.test.tsx
//
// CMS-5 — detail page smoke tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CmsCaseDetailPage } from '@/modules/cms/CmsCaseDetailPage';
import { http } from '@/lib/http';

vi.mock('@/lib/http');

function wrap(initialPath: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/cms/cases/:id" element={<CmsCaseDetailPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const DETAIL = {
  case_id: 'cs-1',
  case_number: 'EWS-2026-00001',
  tenant_id: 'BIL',
  title: 'Customer cust-001 RED breach',
  description: 'EMI bounces',
  alert_id: 'alrt-001',
  status: 'OPEN',
  priority: 'P1',
  assigned_to: null,
  created_by: 'system',
  sla_due_at: '2026-05-06T14:00:00.000Z',
  resolved_at: null,
  resolution_category: null,
  resolution_notes: '',
  tags: ['credit'],
  is_locked: false,
  created_at: '2026-05-06T10:00:00.000Z',
  updated_at: '2026-05-06T10:00:00.000Z',
  assignments: [],
  notes_count: 0,
  attachments_count: 0,
  sla: { due_at: '2026-05-06T14:00:00.000Z', progress_pct: 50, breached: false, warning: false },
};

const LOCKED = { ...DETAIL, status: 'CLOSED', is_locked: true, resolution_category: 'mitigated', resolution_notes: 'paid' };

describe('CmsCaseDetailPage', () => {
  beforeEach(() => {
    (http.get as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/v1/cms/cases/cs-1')
        return Promise.resolve({ data: { body: DETAIL } });
      if (url === '/v1/cms/cases/cs-1/notes')
        return Promise.resolve({ data: { body: { items: [], total: 0 } } });
      if (url === '/v1/cms/cases/cs-1/attachments')
        return Promise.resolve({ data: { body: { items: [], total: 0 } } });
      if (url === '/v1/cms/cases/cs-1/history')
        return Promise.resolve({ data: { body: { items: [], total: 0 } } });
      if (url === '/v1/cms/cases/cs-locked')
        return Promise.resolve({ data: { body: LOCKED } });
      if (url === '/v1/cms/cases/cs-locked/notes')
        return Promise.resolve({ data: { body: { items: [], total: 0 } } });
      if (url === '/v1/cms/cases/cs-locked/attachments')
        return Promise.resolve({ data: { body: { items: [], total: 0 } } });
      return Promise.reject(new Error(`unmocked ${url}`));
    });
    (http.post as unknown as ReturnType<typeof vi.fn>) = vi.fn();
    (http.patch as unknown as ReturnType<typeof vi.fn>) = vi.fn();
    (http.delete as unknown as ReturnType<typeof vi.fn>) = vi.fn();
  });
  afterEach(() => vi.clearAllMocks());

  it('renders header + tabs + sidebar', async () => {
    wrap('/cms/cases/cs-1');
    await waitFor(() => {
      expect(screen.getByText(/EWS-2026-00001/)).toBeInTheDocument();
    });
    // Overview / Investigation / Timeline / Related render as tab buttons
    // AND panel headers, so use getAllByText.
    expect(screen.getAllByText('Overview').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Investigation')).toBeInTheDocument();
    expect(screen.getByText('Timeline')).toBeInTheDocument();
    expect(screen.getByText('Related')).toBeInTheDocument();
    expect(screen.getByText('Quick actions')).toBeInTheDocument();
  });

  it('switches to Investigation tab', async () => {
    const user = userEvent.setup();
    wrap('/cms/cases/cs-1');
    await waitFor(() => screen.getByText('Investigation'));
    await user.click(screen.getByText('Investigation'));
    await waitFor(() => {
      expect(screen.getByText(/Notes/)).toBeInTheDocument();
      expect(screen.getByText(/Attachments/)).toBeInTheDocument();
    });
  });

  it('locked case shows ONLY Reopen button in sidebar', async () => {
    wrap('/cms/cases/cs-locked');
    await waitFor(() => screen.getByText(/LOCKED/));
    expect(screen.getByText('Reopen case')).toBeInTheDocument();
    // Quick-action buttons (assign / transition / escalate / close) hidden
    expect(screen.queryByPlaceholderText('username')).not.toBeInTheDocument();
  });

  it('non-locked case shows quick-action sidebar', async () => {
    wrap('/cms/cases/cs-1');
    await waitFor(() => screen.getByText('Quick actions'));
    expect(screen.getByPlaceholderText('username')).toBeInTheDocument();
    expect(screen.getByText('Close case')).toBeInTheDocument();
  });

  it('shows SLA badge', async () => {
    wrap('/cms/cases/cs-1');
    await waitFor(() => screen.getByText(/SLA 50%/));
  });
});
