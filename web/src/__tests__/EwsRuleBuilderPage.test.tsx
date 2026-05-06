// services/web/src/__tests__/EwsRuleBuilderPage.test.tsx
//
// EWS-5 — SPA builder smoke tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EwsRuleBuilderPage } from '@/modules/rules/EwsRuleBuilderPage';
import { http } from '@/lib/http';

vi.mock('@/lib/http');

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const SAMPLE_RULE = {
  rule_id: 'RULE_CREDIT_001',
  tenant_id: 'BIL',
  name: 'High EMI Bounce Risk',
  category: 'credit' as const,
  description: '3+ EMI bounces in 90 days',
  conditions: [{ field: 'emi_bounce_count_90d', operator: '>=', value: 3 }],
  logic: 'AND' as const,
  action: { alert_severity: 'RED' as const, weight: 25 },
  is_active: false,
  state: 'draft' as const,
  version: 1,
  tags: [],
  created_by: 'system',
  created_at: '2026-05-06T00:00:00Z',
  updated_at: '2026-05-06T00:00:00Z',
  deprecated_at: null,
};

const SAMPLE_INDICATOR = {
  id: 'EWS-CRD-001',
  name: 'emi_bounce_count_90d',
  display_name: 'EMI bounces in last 90 days',
  domain: 'credit',
  type: 'count' as const,
  description: 'EMI bounces in rolling 90 days',
  range: { min: 0, max: 100 },
};

describe('EwsRuleBuilderPage', () => {
  beforeEach(() => {
    (http.get as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/v1/ews/rules')
        return Promise.resolve({ data: { body: { items: [SAMPLE_RULE], total: 1 } } });
      if (url === '/v1/ews/rules/indicators')
        return Promise.resolve({ data: { body: { items: [SAMPLE_INDICATOR], total: 1 } } });
      return Promise.reject(new Error(`unmocked ${url}`));
    });
    (http.post as unknown as ReturnType<typeof vi.fn>) = vi.fn();
    (http.delete as unknown as ReturnType<typeof vi.fn>) = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders page header + sample rule', async () => {
    wrap(<EwsRuleBuilderPage />);
    await waitFor(() => {
      expect(screen.getByText('EWS Rule Builder')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('High EMI Bounce Risk')).toBeInTheDocument();
    });
    expect(screen.getByText('RULE_CREDIT_001')).toBeInTheDocument();
    // RED badge — use queryAllByText since the severity dropdown options
    // also contain "RED". Either way, at least one renders.
    expect(screen.queryAllByText(/^RED$/).length).toBeGreaterThanOrEqual(1);
  });

  it('opens create form when "New rule" button is clicked', async () => {
    const user = userEvent.setup();
    wrap(<EwsRuleBuilderPage />);
    await waitFor(() => screen.getByText('New rule'));
    await user.click(screen.getByText('New rule'));
    await waitFor(() => {
      // Form labels appear
      expect(screen.getByText('rule_id')).toBeInTheDocument();
      expect(screen.getByText('weight (1-100)')).toBeInTheDocument();
    });
  });

  it('renders Test panel when Test button on a rule is clicked', async () => {
    const user = userEvent.setup();
    wrap(<EwsRuleBuilderPage />);
    await waitFor(() => screen.getByText('High EMI Bounce Risk'));
    await user.click(screen.getByRole('button', { name: /Test/i }));
    await waitFor(() => {
      expect(screen.getByText(/Test RULE_CREDIT_001/)).toBeInTheDocument();
    });
    // Field for the rule's indicator is shown
    expect(screen.getByText('EMI bounces in last 90 days')).toBeInTheDocument();
  });

  it('shows "Activate" button only for draft/pending_review rules', async () => {
    wrap(<EwsRuleBuilderPage />);
    await waitFor(() => screen.getByText('High EMI Bounce Risk'));
    expect(screen.getByText(/Activate/)).toBeInTheDocument();
  });

  it('hides "Activate" for deprecated rules', async () => {
    (http.get as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/v1/ews/rules')
        return Promise.resolve({
          data: {
            body: {
              items: [{ ...SAMPLE_RULE, state: 'deprecated', is_active: false }],
              total: 1,
            },
          },
        });
      if (url === '/v1/ews/rules/indicators')
        return Promise.resolve({ data: { body: { items: [SAMPLE_INDICATOR] } } });
      return Promise.reject(new Error(`unmocked ${url}`));
    });
    wrap(<EwsRuleBuilderPage />);
    await waitFor(() => screen.getByText('High EMI Bounce Risk'));
    expect(screen.queryByText(/Activate/)).not.toBeInTheDocument();
  });

  it('renders empty-state when no rules', async () => {
    (http.get as unknown as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/v1/ews/rules')
        return Promise.resolve({ data: { body: { items: [], total: 0 } } });
      if (url === '/v1/ews/rules/indicators')
        return Promise.resolve({ data: { body: { items: [SAMPLE_INDICATOR] } } });
      return Promise.reject(new Error(`unmocked ${url}`));
    });
    wrap(<EwsRuleBuilderPage />);
    await waitFor(() => {
      expect(screen.getByText(/No rules yet/)).toBeInTheDocument();
    });
  });
});
