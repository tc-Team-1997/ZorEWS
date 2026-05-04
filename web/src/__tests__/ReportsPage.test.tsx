import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ReportsPage } from '@/modules/reports/ReportsPage';
import { renderWithProviders } from './utils';
import { server } from '@/mocks/server';

describe('ReportsPage', () => {
  it('renders the selector with report type and period dropdowns', async () => {
    renderWithProviders(<ReportsPage />);
    expect(screen.getByRole('heading', { name: /Reports & Analytics/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/report type/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/period/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
    expect(screen.getByTestId('download-menu-trigger')).toBeInTheDocument();
  });

  it('opens the download menu and reveals PDF + Excel + CSV options', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportsPage />);
    await screen.findByTestId('report-body');
    expect(screen.queryByTestId('download-menu')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('download-menu-trigger'));
    const menu = screen.getByTestId('download-menu');
    expect(within(menu).getByTestId('download-pdf')).toBeInTheDocument();
    expect(within(menu).getByTestId('download-xlsx')).toBeInTheDocument();
    expect(within(menu).getByTestId('download-csv')).toBeInTheDocument();
  });

  it('loads the snapshot report by default and shows portfolio KPIs', async () => {
    renderWithProviders(<ReportsPage />);
    const body = await screen.findByTestId('report-body');
    expect(within(body).getByText(/Customers monitored/i)).toBeInTheDocument();
    expect(within(body).getByText(/Expected credit loss/i)).toBeInTheDocument();
    expect(within(body).getByText(/IFRS-9 stage distribution/i)).toBeInTheDocument();
  });

  it('switches to alert activity when the dropdown changes', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportsPage />);
    await screen.findByTestId('report-body');
    await user.selectOptions(screen.getByLabelText(/report type/i), 'alerts');
    await waitFor(() => {
      const body = screen.getByTestId('report-body');
      expect(within(body).getByText(/Alerts raised/i)).toBeInTheDocument();
    });
    const body = screen.getByTestId('report-body');
    expect(within(body).getByText(/Top firing rules/i)).toBeInTheDocument();
    expect(within(body).getByText(/Salary inflow stopped 60d/i)).toBeInTheDocument();
  });

  it('switches to case outcomes report', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportsPage />);
    await screen.findByTestId('report-body');
    await user.selectOptions(screen.getByLabelText(/report type/i), 'cases');
    await waitFor(() => {
      const body = screen.getByTestId('report-body');
      expect(within(body).getByText(/Cases opened/i)).toBeInTheDocument();
    });
    const body = screen.getByTestId('report-body');
    expect(within(body).getByText(/Top officers/i)).toBeInTheDocument();
    expect(within(body).getByText(/officer\.alpha/i)).toBeInTheDocument();
  });

  it('switches to RBI summary and shows sector exposure', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportsPage />);
    await screen.findByTestId('report-body');
    await user.selectOptions(screen.getByLabelText(/report type/i), 'rbi');
    await waitFor(() => {
      const body = screen.getByTestId('report-body');
      expect(within(body).getByText(/Sector exposure/i)).toBeInTheDocument();
    });
    const body = screen.getByTestId('report-body');
    expect(within(body).getByText(/Top single-name concentrations/i)).toBeInTheDocument();
    // Top concentration name appears twice — once in the metric card sub,
    // once in the concentrations table — so query for "all".
    expect(within(body).getAllByText(/Grace Mutua/i).length).toBeGreaterThanOrEqual(1);
  });

  it('surfaces a backend error inline', async () => {
    server.use(
      http.get('/v1/reports/:type', () =>
        HttpResponse.json({ error: 'unknown report type' }, { status: 400 }),
      ),
    );
    renderWithProviders(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});
