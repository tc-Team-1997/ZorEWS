// web/src/__tests__/CmsCaseListPage.test.tsx
//
// CMS-5 — list page smoke tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { CmsCaseListPage } from '@/modules/cms/CmsCaseListPage';
import { http } from '@/lib/http';

vi.mock('@/lib/http');

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const SAMPLE_CASE = {
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
};

const STATS = {
  total: 1,
  by_status: { OPEN: 1, ASSIGNED: 0, INVESTIGATING: 0, PENDING_APPROVAL: 0, ESCALATED: 0, CLOSED: 0, REOPENED: 0 },
  by_priority: { P1: 1, P2: 0, P3: 0, P4: 0 },
  sla_breached_count: 0,
  sla_warning_count: 0,
  avg_resolution_hours: null,
};

describe('CmsCaseListPage', () => {
  beforeEach(() => {
    (http.get as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/v1/cms/cases')
        return Promise.resolve({ data: { body: { items: [SAMPLE_CASE], total: 1 } } });
      if (url === '/v1/cms/cases/stats')
        return Promise.resolve({ data: { body: STATS } });
      if (url === '/v1/cms/cases/sla-breaches')
        return Promise.resolve({ data: { body: { items: [], total: 0 } } });
      return Promise.reject(new Error(`unmocked ${url}`));
    });
  });
  afterEach(() => vi.clearAllMocks());

  it('renders header + sample case row', async () => {
    wrap(<CmsCaseListPage />);
    await waitFor(() => {
      expect(screen.getByText('Case Management')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('Customer cust-001 RED breach')).toBeInTheDocument();
    });
    expect(screen.getByText('EWS-2026-00001')).toBeInTheDocument();
  });

  it('shows stat cards', async () => {
    wrap(<CmsCaseListPage />);
    await waitFor(() => screen.getByText('Total'));
    expect(screen.getByText('SLA Breached')).toBeInTheDocument();
    expect(screen.getByText('SLA Warning')).toBeInTheDocument();
  });

  it('toggles row selection', async () => {
    const user = userEvent.setup();
    wrap(<CmsCaseListPage />);
    await waitFor(() => screen.getByText('EWS-2026-00001'));
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBeGreaterThanOrEqual(2); // header + row
    await user.click(checkboxes[1]!); // first row
    await waitFor(() => {
      expect(screen.getByText('1 selected')).toBeInTheDocument();
    });
  });

  it('search input filters by typing (filter goes to query)', async () => {
    const user = userEvent.setup();
    wrap(<CmsCaseListPage />);
    await waitFor(() => screen.getByText('EWS-2026-00001'));
    const input = screen.getByPlaceholderText(/Search title/);
    await user.type(input, 'mumbai');
    // No new mock necessary — just verifies the input is wired
    expect((input as HTMLInputElement).value).toBe('mumbai');
  });

  it('renders empty state when no cases', async () => {
    (http.get as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/v1/cms/cases')
        return Promise.resolve({ data: { body: { items: [], total: 0 } } });
      if (url === '/v1/cms/cases/stats')
        return Promise.resolve({ data: { body: { ...STATS, total: 0, by_priority: { P1: 0, P2: 0, P3: 0, P4: 0 } } } });
      if (url === '/v1/cms/cases/sla-breaches')
        return Promise.resolve({ data: { body: { items: [], total: 0 } } });
      return Promise.reject(new Error(`unmocked ${url}`));
    });
    wrap(<CmsCaseListPage />);
    await waitFor(() => {
      expect(screen.getByText(/No cases match these filters/)).toBeInTheDocument();
    });
  });
});
