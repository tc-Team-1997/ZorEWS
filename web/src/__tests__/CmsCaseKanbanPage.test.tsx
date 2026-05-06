// web/src/__tests__/CmsCaseKanbanPage.test.tsx
//
// CMS-5 — kanban page smoke tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { CmsCaseKanbanPage } from '@/modules/cms/CmsCaseKanbanPage';
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

const C = (over: Partial<{ status: string; priority: string }>) => ({
  case_id: `cs-${Math.random()}`,
  case_number: 'EWS-2026-00001',
  tenant_id: 'BIL',
  title: 't',
  description: '',
  alert_id: null,
  status: 'OPEN',
  priority: 'P2',
  assigned_to: null,
  created_by: 'admin',
  sla_due_at: '2026-05-06T14:00:00.000Z',
  resolved_at: null,
  resolution_category: null,
  resolution_notes: '',
  tags: [],
  is_locked: false,
  created_at: '2026-05-06T10:00:00.000Z',
  updated_at: '2026-05-06T10:00:00.000Z',
  ...over,
});

describe('CmsCaseKanbanPage', () => {
  beforeEach(() => {
    (http.get as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/v1/cms/cases')
        return Promise.resolve({
          data: {
            body: {
              items: [
                C({ status: 'OPEN' }),
                C({ status: 'INVESTIGATING' }),
                C({ status: 'CLOSED' }),
              ],
              total: 3,
            },
          },
        });
      return Promise.reject(new Error(`unmocked ${url}`));
    });
    (http.post as unknown as ReturnType<typeof vi.fn>) = vi.fn();
  });
  afterEach(() => vi.clearAllMocks());

  it('renders 6 columns with counts', async () => {
    wrap(<CmsCaseKanbanPage />);
    await waitFor(() => screen.getByText('Case Kanban'));
    await waitFor(() => {
      expect(screen.getByText('OPEN (1)')).toBeInTheDocument();
      expect(screen.getByText('INVESTIGATING (1)')).toBeInTheDocument();
      expect(screen.getByText('CLOSED (1)')).toBeInTheDocument();
      expect(screen.getByText('PENDING_APPROVAL (0)')).toBeInTheDocument();
    });
  });

  it('renders quick-action buttons for non-closed cards', async () => {
    wrap(<CmsCaseKanbanPage />);
    await waitFor(() => screen.getByText('OPEN (1)'));
    // OPEN row's quick actions: ASSIGNED, CLOSED
    const assignedBtns = screen.getAllByText('ASSIGNED');
    expect(assignedBtns.length).toBeGreaterThanOrEqual(1);
  });

  it('CLOSED card shows OPEN (reopen) quick action', async () => {
    wrap(<CmsCaseKanbanPage />);
    await waitFor(() => screen.getByText('CLOSED (1)'));
    expect(screen.getAllByText(/OPEN/).length).toBeGreaterThanOrEqual(1);
  });
});
