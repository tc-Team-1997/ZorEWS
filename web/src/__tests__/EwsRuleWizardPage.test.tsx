// web/src/__tests__/EwsRuleWizardPage.test.tsx
//
// RP-2 — wizard SPA tests: step navigation, auto-save draft persistence,
// keyboard shortcuts (Cmd+S save / Cmd+Enter advance / Esc cancel),
// inline Test Rule preview, submit-then-redirect flow.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EwsRuleWizardPage } from '@/modules/rules/EwsRuleWizardPage';
import { http } from '@/lib/http';

vi.mock('@/lib/http');

const SAMPLE_INDICATOR = {
  id: 'EWS-CRD-001',
  name: 'emi_bounce_count_90d',
  display_name: 'EMI bounces in last 90 days',
  domain: 'credit',
  type: 'count' as const,
  description: 'EMI bounces in rolling 90 days',
  range: { min: 0, max: 100 },
};

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function wrap(initial = '/rules/ews/wizard') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/rules/ews/wizard" element={<EwsRuleWizardPage />} />
          <Route path="/rules/ews" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('EwsRuleWizardPage (RP-2)', () => {
  beforeEach(() => {
    localStorage.clear();
    (http.get as unknown as ReturnType<typeof vi.fn>) = vi.fn().mockImplementation(
      (url: string) => {
        if (url === '/v1/ews/rules/indicators') {
          return Promise.resolve({ data: { body: { items: [SAMPLE_INDICATOR] } } });
        }
        return Promise.reject(new Error(`unmocked GET ${url}`));
      },
    );
    (http.post as unknown as ReturnType<typeof vi.fn>) = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('renders the 4-step stepper and starts on Basic Info', async () => {
    wrap();
    expect(screen.getByText('Add EWS Rule (4-step wizard)')).toBeInTheDocument();
    expect(screen.getByText('1. Basic Info')).toBeInTheDocument();
    expect(screen.getByText('Basic Info')).toBeInTheDocument();
    expect(screen.getByText('Conditions')).toBeInTheDocument();
    expect(screen.getByText('Action')).toBeInTheDocument();
    expect(screen.getByText('Lifecycle')).toBeInTheDocument();
  });

  it('navigates Next → Back through all 4 steps', async () => {
    const user = userEvent.setup();
    wrap();
    expect(screen.getByText('1. Basic Info')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Next/i }));
    expect(screen.getByText('2. Conditions')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Next/i }));
    expect(screen.getByText('3. Action')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Next/i }));
    expect(screen.getByText('4. Lifecycle')).toBeInTheDocument();
    // last step shows Save rule, not Next
    expect(screen.queryByRole('button', { name: /^Next$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save rule/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Back/i }));
    expect(screen.getByText('3. Action')).toBeInTheDocument();
  });

  it('Cmd+S on a non-final step saves a draft to localStorage', async () => {
    const user = userEvent.setup();
    wrap();
    const idInput = screen.getAllByPlaceholderText(/RULE_</)[0]!;
    await user.type(idInput, 'RULE_FOO_001');
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    await waitFor(() => {
      const raw = localStorage.getItem('apex.ews.rules.wizard.draft');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!) as { draft: { rule_id: string } };
      expect(parsed.draft.rule_id).toBe('RULE_FOO_001');
    });
  });

  it('Esc cancels and navigates to /rules/ews', async () => {
    wrap();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toBe('/rules/ews');
    });
  });

  it('Cmd+Enter advances to next step', async () => {
    wrap();
    expect(screen.getByText('1. Basic Info')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(screen.getByText('2. Conditions')).toBeInTheDocument();
    });
  });

  it('reloads the saved draft on remount', async () => {
    localStorage.setItem(
      'apex.ews.rules.wizard.draft',
      JSON.stringify({
        draft: {
          rule_id: 'RULE_RELOAD_001',
          name: 'Reloaded',
          description: '',
          category: 'credit',
          conditions: [{ field: 'emi_bounce_count_90d', operator: '>=', value: 3 }],
          logic: 'AND',
          alert_severity: 'YELLOW',
          weight: 15,
          recommended_action: '',
          activate_after_create: false,
        },
        savedAt: 1714000000000,
      }),
    );
    wrap();
    expect(screen.getByDisplayValue('RULE_RELOAD_001')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Reloaded')).toBeInTheDocument();
  });

  it('runs client-side test on step 2 and shows MATCH banner', async () => {
    const user = userEvent.setup();
    wrap();
    // Step 2
    await user.click(screen.getByRole('button', { name: /Next/i }));
    await waitFor(() =>
      expect(screen.getByText('2. Conditions')).toBeInTheDocument(),
    );
    // Pick the first indicator from the dropdown
    const fieldSelect = (await screen.findAllByRole('combobox'))[1]!;
    await user.selectOptions(fieldSelect, 'emi_bounce_count_90d');
    // Type a test value of 5 (rule defaults to >= 0 — always matches if non-zero)
    const valueInput = await screen.findByPlaceholderText('test value');
    await user.type(valueInput, '5');
    await user.click(screen.getByRole('button', { name: /Run test/i }));
    await waitFor(() => {
      expect(screen.getByText(/^MATCH/)).toBeInTheDocument();
    });
  });

  it('Save rule POSTs to /v1/ews/rules + clears draft + navigates back', async () => {
    const user = userEvent.setup();
    (http.post as unknown as ReturnType<typeof vi.fn>) = vi
      .fn()
      .mockResolvedValue({
        data: { body: { rule_id: 'RULE_FOO_001' } },
      });
    wrap();
    // fill rule_id then jump to last step
    await user.type(
      screen.getAllByPlaceholderText(/RULE_</)[0]!,
      'RULE_FOO_001',
    );
    await user.click(screen.getByRole('button', { name: /Next/i }));
    await user.click(screen.getByRole('button', { name: /Next/i }));
    await user.click(screen.getByRole('button', { name: /Next/i }));
    expect(screen.getByText('4. Lifecycle')).toBeInTheDocument();
    // pre-stash draft so we can verify clearDraft fires
    localStorage.setItem('apex.ews.rules.wizard.draft', '{"draft":{},"savedAt":1}');
    await user.click(screen.getByRole('button', { name: /Save rule/i }));
    await waitFor(() => {
      const calls = (http.post as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]![0]).toBe('/v1/ews/rules');
    });
    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toBe('/rules/ews');
    });
    expect(localStorage.getItem('apex.ews.rules.wizard.draft')).toBeNull();
  });

  it('Clear draft button wipes localStorage + resets fields', async () => {
    const user = userEvent.setup();
    wrap();
    await user.type(
      screen.getAllByPlaceholderText(/RULE_</)[0]!,
      'RULE_KEEP_001',
    );
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    await waitFor(() =>
      expect(localStorage.getItem('apex.ews.rules.wizard.draft')).toBeTruthy(),
    );
    await user.click(screen.getByRole('button', { name: /Clear draft/i }));
    expect(localStorage.getItem('apex.ews.rules.wizard.draft')).toBeNull();
    // input should be empty after reset
    expect(
      (screen.getAllByPlaceholderText(/RULE_</)[0]! as HTMLInputElement).value,
    ).toBe('');
  });

  it('auto-save fires every 30s after typing data', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    wrap();
    await user.type(
      screen.getAllByPlaceholderText(/RULE_</)[0]!,
      'RULE_AUTO_001',
    );
    expect(localStorage.getItem('apex.ews.rules.wizard.draft')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(localStorage.getItem('apex.ews.rules.wizard.draft')).toBeTruthy();
    const parsed = JSON.parse(
      localStorage.getItem('apex.ews.rules.wizard.draft')!,
    ) as { draft: { rule_id: string } };
    expect(parsed.draft.rule_id).toBe('RULE_AUTO_001');
  });
});
