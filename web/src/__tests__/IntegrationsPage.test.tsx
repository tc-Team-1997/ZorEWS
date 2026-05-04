import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { IntegrationsPage } from '@/modules/admin/IntegrationsPage';
import { renderWithProviders } from './utils';
import { server } from '@/mocks/server';

describe('IntegrationsPage', () => {
  it('renders the page header and connectivity matrix', async () => {
    renderWithProviders(<IntegrationsPage />);
    expect(screen.getByRole('heading', { name: /^Integrations$/i })).toBeInTheDocument();

    const table = await screen.findByTestId('integrations-table');
    expect(table).toBeInTheDocument();
    expect(await screen.findByTestId('integration-row-cbs')).toBeInTheDocument();
    expect(screen.getByTestId('integration-row-aml')).toBeInTheDocument();
    expect(screen.getByTestId('integration-row-ifrs9')).toBeInTheDocument();
    expect(screen.getByTestId('integration-row-collection')).toBeInTheDocument();
  });

  it('shows the up-count card after loading', async () => {
    renderWithProviders(<IntegrationsPage />);
    await screen.findByTestId('integrations-table');
    // MSW default: 3 up + 1 down
    expect(screen.getByText(/Upstreams up/i)).toBeInTheDocument();
    expect(screen.getByText('3 / 4')).toBeInTheDocument();
  });

  it('renders the down-state badge with the failure message', async () => {
    renderWithProviders(<IntegrationsPage />);
    const ifrs9Row = await screen.findByTestId('integration-row-ifrs9');
    expect(ifrs9Row).toHaveTextContent(/Down/i);
    expect(ifrs9Row).toHaveTextContent(/timed out/i);
  });

  it('refresh button re-runs the probe', async () => {
    const user = userEvent.setup();
    renderWithProviders(<IntegrationsPage />);
    await screen.findByTestId('integrations-table');
    const refresh = screen.getByRole('button', { name: /refresh/i });
    await user.click(refresh);
    // After click the table should still be present (no errors)
    expect(await screen.findByTestId('integrations-table')).toBeInTheDocument();
  });

  it('surfaces a backend error inline', async () => {
    server.use(
      http.get('/v1/integrations/health', () =>
        HttpResponse.json({ error: 'forbidden' }, { status: 403 }),
      ),
    );
    renderWithProviders(<IntegrationsPage />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});
