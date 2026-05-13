// web/src/__tests__/CmsCaseDetailPage.test.tsx
//
// CMS-5 — detail page smoke tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

  it('Related tab renders dispatches fired for this case', async () => {
    (http.get as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/v1/cms/cases/cs-1')
        return Promise.resolve({ data: { body: DETAIL } });
      if (url === '/v1/cms/cases/cs-1/notes')
        return Promise.resolve({ data: { body: { items: [], total: 0 } } });
      if (url === '/v1/cms/cases/cs-1/attachments')
        return Promise.resolve({ data: { body: { items: [], total: 0 } } });
      if (url === '/v1/cms/cases/cs-1/history')
        return Promise.resolve({ data: { body: { items: [], total: 0 } } });
      if (url === '/v1/admin/notification-templates/dispatches') {
        // api.notificationDispatchesList does `.then((r) => r.data)`
        // directly (no body unwrap), so the mock returns the dispatch
        // shape at r.data — not r.data.body.
        return Promise.resolve({
          data: {
            items: [
              {
                dispatch_id: 'd-1',
                tenant_id: 'BANK_DEMO',
                template_id: 'tpl-seed-bank_demo-case-opened-rm-email',
                template_name: 'Case Opened — RM email',
                channel: 'EMAIL',
                recipient: 'rm@bank.test',
                trigger: 'case_create_pipeline',
                reference: 'case:cs-1',
                rendered_subject: 'New case CMS-001',
                rendered_body: 'Hi RM, …',
                missing_vars: [],
                status: 'sent',
                status_reason: null,
                performed_by: 'system:case-pipeline',
                performed_at: new Date().toISOString(),
              },
            ],
            total: 1,
            page: 1,
            page_size: 50,
          },
        });
      }
      return Promise.reject(new Error(`unmocked ${url}`));
    });
    wrap('/cms/cases/cs-1?tab=Related');
    const list = await screen.findByTestId('related-dispatches-list');
    expect(within(list).getByText(/Case Opened — RM email/)).toBeInTheDocument();
    // "View full log" deep-links to /admin/notification-dispatches with the
    // reference filter pre-applied
    expect(screen.getByTestId('related-dispatches-viewall').getAttribute('href'))
      .toMatch(/^\/admin\/notification-dispatches\?reference=case%3Acs-1/);
  });

  it('Related tab shows the empty state when no dispatches exist', async () => {
    (http.get as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/v1/cms/cases/cs-1')
        return Promise.resolve({ data: { body: DETAIL } });
      if (url === '/v1/cms/cases/cs-1/notes')
        return Promise.resolve({ data: { body: { items: [], total: 0 } } });
      if (url === '/v1/cms/cases/cs-1/attachments')
        return Promise.resolve({ data: { body: { items: [], total: 0 } } });
      if (url === '/v1/cms/cases/cs-1/history')
        return Promise.resolve({ data: { body: { items: [], total: 0 } } });
      if (url === '/v1/admin/notification-templates/dispatches')
        return Promise.resolve({ data: { items: [], total: 0, page: 1, page_size: 50 } });
      return Promise.reject(new Error(`unmocked ${url}`));
    });
    wrap('/cms/cases/cs-1?tab=Related');
    expect(await screen.findByTestId('related-dispatches-empty')).toBeInTheDocument();
  });
});

describe('CmsCaseDetailPage — Investigation deep-link (note/attachment)', () => {
  // The CaseTrackingTimeline navigates to
  // /cms/cases/:id?tab=Investigation&note=<id> (or &attachment=<id>) when
  // a COMMENT/ATTACHMENT card is clicked. The detail page should:
  //   1. open the Investigation tab automatically
  //   2. scroll the matching row into view
  //   3. flash a highlight ring on the row, then strip the URL param
  const NOTE = {
    note_id: 'n-001',
    case_id: 'cs-1',
    user_id: 'alice',
    note_text: 'Customer confirms hardship',
    is_internal: false,
    created_at: '2026-05-09T12:00:00.000Z',
  };
  const ATT = {
    attachment_id: 'a-001',
    case_id: 'cs-1',
    file_name: 'kyc.pdf',
    file_size: 4096,
    mime_type: 'application/pdf',
    virus_scan_status: 'clean',
    uploaded_by: 'alice',
    uploaded_at: '2026-05-09T12:00:00.000Z',
  };

  beforeEach(() => {
    // jsdom doesn't implement scrollIntoView — the effect would throw
    // without this stub.
    Element.prototype.scrollIntoView = vi.fn();
    (http.get as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/v1/cms/cases/cs-1') return Promise.resolve({ data: { body: DETAIL } });
      if (url === '/v1/cms/cases/cs-1/notes')
        return Promise.resolve({ data: { body: { items: [NOTE], total: 1 } } });
      if (url === '/v1/cms/cases/cs-1/attachments')
        return Promise.resolve({ data: { body: { items: [ATT], total: 1 } } });
      return Promise.reject(new Error(`unmocked ${url}`));
    });
  });
  afterEach(() => vi.clearAllMocks());

  it('opens Investigation tab + flashes the matching note row', async () => {
    wrap('/cms/cases/cs-1?tab=Investigation&note=n-001');
    const row = await screen.findByTestId('investigation-note-n-001');
    expect(row.className).toMatch(/ring-2/);
    expect(row.className).toMatch(/bg-blue-50/);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('opens Investigation tab + flashes the matching attachment row', async () => {
    wrap('/cms/cases/cs-1?tab=Investigation&attachment=a-001');
    const row = await screen.findByTestId('investigation-attachment-a-001');
    expect(row.className).toMatch(/ring-2/);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('non-deep-link visit does not flash any row', async () => {
    const user = userEvent.setup();
    wrap('/cms/cases/cs-1');
    await waitFor(() => screen.getByText('Investigation'));
    await user.click(screen.getByText('Investigation'));
    const row = await screen.findByTestId('investigation-note-n-001');
    expect(row.className).not.toMatch(/ring-2/);
  });
});

describe('CmsCaseDetailPage — re-categorise flow', () => {
  beforeEach(async () => {
    // Auth: admin so the Edit button is visible.
    const user = { id: 'u-001', username: 'alice.admin', roles: ['admin'] as const };
    localStorage.setItem('apex.ews.user', JSON.stringify(user));
    localStorage.setItem('apex.ews.token', 'test-token');
    const { useAuth } = await import('@/store/auth');
    useAuth.setState({ status: 'authenticated', user, token: 'test-token' });

    (http.get as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/v1/cms/cases/cs-1') return Promise.resolve({ data: { body: DETAIL } });
      if (url === '/v1/cms/cases/cs-1/notes') return Promise.resolve({ data: { body: { items: [], total: 0 } } });
      if (url === '/v1/cms/cases/cs-1/attachments') return Promise.resolve({ data: { body: { items: [], total: 0 } } });
      if (url === '/v1/cms/cases/cs-1/history') return Promise.resolve({ data: { body: { items: [], total: 0 } } });
      if (url === '/v1/admin/sla-config')
        return Promise.resolve({
          data: {
            body: {
              items: [
                { sla_config_id: '1', tenant_id: 'BIL', case_category: 'fraud', priority: 'P1', business_unit: null, sla_target_days: 0.5, status: 'ACTIVE', effective_from: '', effective_till: null, notes: null, created_by: 's', updated_by: null, superseded_by: null, created_at: '', updated_at: '' },
                { sla_config_id: '2', tenant_id: 'BIL', case_category: 'kyc',   priority: 'P1', business_unit: null, sla_target_days: 2,   status: 'ACTIVE', effective_from: '', effective_till: null, notes: null, created_by: 's', updated_by: null, superseded_by: null, created_at: '', updated_at: '' },
                { sla_config_id: '3', tenant_id: 'BIL', case_category: 'default_fallback', priority: 'P1', business_unit: null, sla_target_days: 2, status: 'ACTIVE', effective_from: '', effective_till: null, notes: null, created_by: 's', updated_by: null, superseded_by: null, created_at: '', updated_at: '' },
              ],
              total: 3,
              page: 1,
              page_size: 100,
            },
          },
        });
      return Promise.reject(new Error(`unmocked ${url}`));
    });
    (http.post as unknown as ReturnType<typeof vi.fn>) = vi.fn();
    (http.patch as unknown as ReturnType<typeof vi.fn>) = vi
      .fn()
      .mockResolvedValue({ data: { body: { ...DETAIL, case_category: 'fraud' } } });
    (http.delete as unknown as ReturnType<typeof vi.fn>) = vi.fn();
  });

  afterEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders the Edit button on Category for admin', async () => {
    wrap('/cms/cases/cs-1');
    await waitFor(() => {
      expect(screen.getByTestId('cms-set-category-btn')).toBeInTheDocument();
    });
  });

  it('opens the SetCategoryModal and submits a new category', async () => {
    const user = userEvent.setup();
    wrap('/cms/cases/cs-1');
    await waitFor(() => screen.getByTestId('cms-set-category-btn'));
    await user.click(screen.getByTestId('cms-set-category-btn'));
    expect(screen.getByRole('dialog', { name: /Re-categorise/i })).toBeInTheDocument();
    await user.type(screen.getByTestId('set-category-input'), 'fraud');
    await user.click(screen.getByTestId('set-category-save'));
    await waitFor(() => {
      // PATCH was issued with the new category
      expect(http.patch).toHaveBeenCalledWith(
        '/v1/cms/cases/cs-1/category',
        expect.objectContaining({ case_category: 'fraud' }),
      );
    });
  });

  it('rejects "no change" submit', async () => {
    const user = userEvent.setup();
    wrap('/cms/cases/cs-1');
    await waitFor(() => screen.getByTestId('cms-set-category-btn'));
    await user.click(screen.getByTestId('cms-set-category-btn'));
    // The modal opens with current value (null → empty input). Save without typing.
    await user.click(screen.getByTestId('set-category-save'));
    expect(await screen.findByTestId('set-category-error')).toHaveTextContent(/No change/);
  });
});
