// Vitest coverage for the routable EWS Rule Diff page.
//
// Layered:
//   1. Initial render — page mounts at the route, dropdowns hydrate,
//      defaults set From=2nd-newest, To=newest via URL params.
//   2. Swap button flips From + To in the URL.
//   3. Reverse-version warning appears when From >= To.
//   4. Revert flow opens confirm modal, posts to /revert, advances "to"
//      to the new version after success.
//   5. Non-admin (risk_analyst) does not see the Revert button.

import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EwsRuleDiffPage } from '@/modules/rules/EwsRuleDiffPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

const RULE_ID = 'RULE_CREDIT_001';

function renderAt(initialPath: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/rules/ews/:rule_id/diff" element={<EwsRuleDiffPage />} />
    </Routes>,
    { route: initialPath },
  );
}

function asAdmin() {
  useAuth.setState({
    status: 'authenticated',
    user: {
      id: 'u-admin',
      username: 'taniya',
      display_name: 'Taniya',
      roles: ['admin'],
    },
    token: 'tok',
  });
}

function asAnalyst() {
  useAuth.setState({
    status: 'authenticated',
    user: {
      id: 'u-an',
      username: 'analyst',
      display_name: 'A',
      roles: ['risk_analyst'],
    },
    token: 'tok',
  });
}

describe('EwsRuleDiffPage — initial render', () => {
  it('mounts the page header + the From/To dropdowns', async () => {
    asAdmin();
    renderAt(`/rules/ews/${RULE_ID}/diff`);
    expect(
      await screen.findByRole('heading', { name: /Diff Viewer — RULE_CREDIT_001/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('diff-from')).toBeInTheDocument();
    expect(screen.getByTestId('diff-to')).toBeInTheDocument();
  });

  it('defaults to From=second-newest, To=newest via URL params', async () => {
    asAdmin();
    renderAt(`/rules/ews/${RULE_ID}/diff`);
    await waitFor(() => {
      const from = screen.getByTestId('diff-from') as HTMLSelectElement;
      const to = screen.getByTestId('diff-to') as HTMLSelectElement;
      expect(to.value).toBe('1.2.0'); // newest
      expect(from.value).toBe('1.1.0'); // second-newest
    });
  });

  it('renders side-by-side snapshot panes once the diff loads', async () => {
    asAdmin();
    renderAt(`/rules/ews/${RULE_ID}/diff`);
    await waitFor(() => {
      expect(screen.getByTestId('diff-snapshot-from')).toBeInTheDocument();
      expect(screen.getByTestId('diff-snapshot-to')).toBeInTheDocument();
    });
  });

  it('honours ?from=&to= URL params', async () => {
    asAdmin();
    renderAt(`/rules/ews/${RULE_ID}/diff?from=0.1.0&to=1.2.0`);
    await waitFor(() => {
      const from = screen.getByTestId('diff-from') as HTMLSelectElement;
      const to = screen.getByTestId('diff-to') as HTMLSelectElement;
      expect(from.value).toBe('0.1.0');
      expect(to.value).toBe('1.2.0');
    });
  });
});

describe('EwsRuleDiffPage — swap', () => {
  it('clicking Swap flips From and To', async () => {
    asAdmin();
    const user = userEvent.setup();
    renderAt(`/rules/ews/${RULE_ID}/diff?from=0.1.0&to=1.2.0`);
    await waitFor(() => {
      expect((screen.getByTestId('diff-from') as HTMLSelectElement).value).toBe('0.1.0');
    });
    await user.click(screen.getByTestId('diff-swap'));
    await waitFor(() => {
      expect((screen.getByTestId('diff-from') as HTMLSelectElement).value).toBe('1.2.0');
      expect((screen.getByTestId('diff-to') as HTMLSelectElement).value).toBe('0.1.0');
    });
  });
});

describe('EwsRuleDiffPage — reverse-order warning', () => {
  it('shows the warning banner when From >= To', async () => {
    asAdmin();
    renderAt(`/rules/ews/${RULE_ID}/diff?from=1.2.0&to=0.1.0`);
    expect(await screen.findByTestId('diff-reversed-warning')).toBeInTheDocument();
  });

  it('does NOT show the banner when From < To', async () => {
    asAdmin();
    renderAt(`/rules/ews/${RULE_ID}/diff?from=0.1.0&to=1.2.0`);
    await waitFor(() => {
      expect(screen.getByTestId('diff-from')).toHaveValue('0.1.0');
    });
    expect(screen.queryByTestId('diff-reversed-warning')).not.toBeInTheDocument();
  });
});

describe('EwsRuleDiffPage — revert', () => {
  it('admin sees Revert button + opens confirm modal', async () => {
    asAdmin();
    const user = userEvent.setup();
    renderAt(`/rules/ews/${RULE_ID}/diff?from=0.1.0&to=1.2.0`);
    const revertBtn = await screen.findByTestId('diff-revert');
    expect(revertBtn).toHaveTextContent(/Revert to From \(v0\.1\.0\)/);
    await user.click(revertBtn);
    expect(screen.getByTestId('revert-confirm-modal')).toBeInTheDocument();
  });

  it('confirm posts to /revert + advances To to the new version', async () => {
    asAdmin();
    const user = userEvent.setup();
    renderAt(`/rules/ews/${RULE_ID}/diff?from=0.1.0&to=1.2.0`);
    await user.click(await screen.findByTestId('diff-revert'));
    await user.click(screen.getByTestId('revert-confirm'));
    await waitFor(() => {
      // After revert, modal closes
      expect(screen.queryByTestId('revert-confirm-modal')).not.toBeInTheDocument();
    });
    // To dropdown advanced to the patch-bumped version (1.2.0 → 1.2.1)
    await waitFor(() => {
      expect((screen.getByTestId('diff-to') as HTMLSelectElement).value).toBe('1.2.1');
    });
  });

  it('cancel closes the modal without firing /revert', async () => {
    asAdmin();
    const user = userEvent.setup();
    renderAt(`/rules/ews/${RULE_ID}/diff?from=0.1.0&to=1.2.0`);
    await user.click(await screen.findByTestId('diff-revert'));
    expect(screen.getByTestId('revert-confirm-modal')).toBeInTheDocument();
    await user.click(screen.getByTestId('revert-cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('revert-confirm-modal')).not.toBeInTheDocument();
    });
    // To dropdown unchanged
    expect((screen.getByTestId('diff-to') as HTMLSelectElement).value).toBe('1.2.0');
  });
});

describe('EwsRuleDiffPage — RBAC', () => {
  it('risk_analyst does NOT see the Revert button', async () => {
    asAnalyst();
    renderAt(`/rules/ews/${RULE_ID}/diff?from=0.1.0&to=1.2.0`);
    await waitFor(() => {
      expect(screen.getByTestId('diff-from')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('diff-revert')).not.toBeInTheDocument();
  });
});
