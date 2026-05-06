// web/src/__tests__/EwsRuleDiffViewer.test.tsx
//
// RP-2 — diff viewer modal tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EwsRuleDiffViewer } from '@/modules/rules/EwsRuleDiffViewer';
import { http } from '@/lib/http';

vi.mock('@/lib/http');

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const VERSIONS = [
  {
    version_id: 'v-2',
    rule_id: 'RULE_X_001',
    tenant_id: 'BIL',
    semver: '0.2.0',
    snapshot: { name: 'New name' },
    created_by: 'jane',
    created_at: '2026-05-04T00:00:00Z',
    reason: null,
  },
  {
    version_id: 'v-1',
    rule_id: 'RULE_X_001',
    tenant_id: 'BIL',
    semver: '0.1.0',
    snapshot: { name: 'Old name' },
    created_by: 'jane',
    created_at: '2026-05-01T00:00:00Z',
    reason: null,
  },
];

describe('EwsRuleDiffViewer (RP-2)', () => {
  beforeEach(() => {
    (http.get as unknown as ReturnType<typeof vi.fn>) = vi.fn().mockImplementation(
      (url: string) => {
        if (url.endsWith('/versions')) {
          return Promise.resolve({
            data: {
              body: {
                items: VERSIONS,
                total: 2,
                latest_semver: '0.2.0',
              },
            },
          });
        }
        return Promise.reject(new Error(`unmocked GET ${url}`));
      },
    );
    (http.post as unknown as ReturnType<typeof vi.fn>) = vi.fn().mockResolvedValue({
      data: {
        body: {
          rule_id: 'RULE_X_001',
          from: '0.1.0',
          to: '0.2.0',
          diff: [
            { field: 'name', before: 'Old name', after: 'New name', kind: 'changed' },
          ],
          change_count: 1,
        },
      },
    });
  });
  afterEach(() => vi.clearAllMocks());

  it('renders default From/To (newest → previous) and shows changed field', async () => {
    const onClose = vi.fn();
    wrap(<EwsRuleDiffViewer ruleId="RULE_X_001" onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getByText('Diff Viewer — RULE_X_001')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText(/changed/i)).toBeInTheDocument();
    });
    expect(screen.getByText('name')).toBeInTheDocument();
    // Both before + after pre blocks rendered
    expect(screen.getByText('"Old name"')).toBeInTheDocument();
    expect(screen.getByText('"New name"')).toBeInTheDocument();
  });

  it('Esc closes the modal', async () => {
    const onClose = vi.fn();
    wrap(<EwsRuleDiffViewer ruleId="RULE_X_001" onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('Close button calls onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    wrap(<EwsRuleDiffViewer ruleId="RULE_X_001" onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: /Close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows "No version snapshots" when empty', async () => {
    (http.get as unknown as ReturnType<typeof vi.fn>) = vi.fn().mockResolvedValue({
      data: { body: { items: [], total: 0, latest_semver: null } },
    });
    wrap(<EwsRuleDiffViewer ruleId="RULE_X_001" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/No version snapshots/)).toBeInTheDocument();
    });
  });
});
