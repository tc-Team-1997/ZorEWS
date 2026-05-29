import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { AlertClassificationConfigPage } from '@/modules/admin/AlertClassificationConfigPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

function asAdmin() {
  useAuth.setState({
    status: 'authenticated',
    token: 't',
    user: { username: 'alice.admin', roles: ['admin'], tenant_id: 'BANK_DEMO' } as never,
  });
}
function asViewer() {
  useAuth.setState({
    status: 'authenticated',
    token: 't',
    user: { username: 'val.viewer', roles: ['risk_analyst'], tenant_id: 'BANK_DEMO' } as never,
  });
}

describe('AlertClassificationConfigPage', () => {
  it('renders the 3 RAG band cards with seeded ranges', async () => {
    asAdmin();
    renderWithProviders(<AlertClassificationConfigPage />);
    expect(screen.getByRole('heading', { name: /Alert Classification Setup/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('acc-band-cards')).toBeInTheDocument());
    expect(screen.getByTestId('acc-band-green')).toBeInTheDocument();
    expect(screen.getByTestId('acc-band-amber')).toBeInTheDocument();
    expect(screen.getByTestId('acc-band-red')).toBeInTheDocument();
    expect(screen.getByTestId('acc-range-green').textContent).toBe('< 60');
    expect(screen.getByTestId('acc-range-amber').textContent).toBe('60–100');
    expect(screen.getByTestId('acc-range-red').textContent).toBe('≥ 100');
  });

  it('editing boundaries re-derives the band ranges', async () => {
    asAdmin();
    renderWithProviders(<AlertClassificationConfigPage />);
    await waitFor(() => expect(screen.getByTestId('acc-band-cards')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('acc-amber-min'), { target: { value: '40' } });
    fireEvent.change(screen.getByTestId('acc-red-min'), { target: { value: '75' } });
    fireEvent.click(screen.getByTestId('acc-boundaries-save'));
    await waitFor(() => expect(screen.getByTestId('acc-range-green').textContent).toBe('< 40'));
    expect(screen.getByTestId('acc-range-amber').textContent).toBe('40–75');
    expect(screen.getByTestId('acc-range-red').textContent).toBe('≥ 75');
  });

  it('invalid boundaries (red ≤ amber) disable Save + show the hint', async () => {
    asAdmin();
    renderWithProviders(<AlertClassificationConfigPage />);
    await waitFor(() => expect(screen.getByTestId('acc-band-cards')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('acc-amber-min'), { target: { value: '80' } });
    fireEvent.change(screen.getByTestId('acc-red-min'), { target: { value: '50' } });
    expect(screen.getByTestId('acc-boundaries-save')).toBeDisabled();
    expect(screen.getByTestId('acc-boundaries-invalid')).toBeInTheDocument();
  });

  it('editing a band action persists', async () => {
    asAdmin();
    renderWithProviders(<AlertClassificationConfigPage />);
    await waitFor(() => expect(screen.getByTestId('acc-band-red')).toBeInTheDocument());
    const redCard = screen.getByTestId('acc-band-red');
    fireEvent.change(within(redCard).getByTestId('acc-action-red'), { target: { value: 'Page on-call now' } });
    fireEvent.click(within(redCard).getByTestId('acc-action-save-red'));
    await waitFor(() =>
      expect((within(screen.getByTestId('acc-band-red')).getByTestId('acc-action-red') as HTMLInputElement).value).toBe('Page on-call now'),
    );
  });

  it('test-a-score classifies into the right band', async () => {
    asAdmin();
    renderWithProviders(<AlertClassificationConfigPage />);
    await waitFor(() => expect(screen.getByTestId('acc-band-cards')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('acc-test-score'), { target: { value: '150' } });
    fireEvent.click(screen.getByTestId('acc-test-run'));
    await waitFor(() => expect(screen.getByTestId('acc-test-band').textContent).toBe('Red'));
    fireEvent.change(screen.getByTestId('acc-test-score'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('acc-test-run'));
    await waitFor(() => expect(screen.getByTestId('acc-test-band').textContent).toBe('Green'));
  });

  it('non-admin sees read-only bands + no boundary editor / reset', async () => {
    asViewer();
    renderWithProviders(<AlertClassificationConfigPage />);
    await waitFor(() => expect(screen.getByTestId('acc-band-cards')).toBeInTheDocument());
    expect(screen.queryByTestId('acc-amber-min')).not.toBeInTheDocument();
    expect(screen.queryByTestId('acc-action-red')).not.toBeInTheDocument();
    expect(screen.queryByTestId('acc-reset')).not.toBeInTheDocument();
    // test-a-score stays available read-only.
    expect(screen.getByTestId('acc-test-run')).toBeInTheDocument();
  });
});
