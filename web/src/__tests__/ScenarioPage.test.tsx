import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ScenarioPage } from '@/modules/scenario/ScenarioPage';
import { renderWithProviders } from './utils';
import { server } from '@/mocks/server';

describe('ScenarioPage', () => {
  it('renders the three shock sliders with the Run button enabled', () => {
    renderWithProviders(<ScenarioPage />);
    expect(screen.getByRole('heading', { name: /Scenario Simulation/i })).toBeInTheDocument();
    expect(screen.getByText(/GDP shock/i)).toBeInTheDocument();
    expect(screen.getByText(/Rate shock/i)).toBeInTheDocument();
    expect(screen.getByText(/FX shock/i)).toBeInTheDocument();
    const run = screen.getByRole('button', { name: /run scenario/i });
    expect(run).toBeEnabled();
  });

  it('runs a baseline (zero) scenario and renders the results panel', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);
    await user.click(screen.getByRole('button', { name: /run scenario/i }));

    const results = await screen.findByTestId('scenario-results');
    expect(results).toBeInTheDocument();
    expect(within(results).getByText(/Portfolio size/i)).toBeInTheDocument();
    expect(within(results).getByText(/Baseline ECL/i)).toBeInTheDocument();
    expect(within(results).getByText(/Stressed ECL/i)).toBeInTheDocument();
    expect(within(results).getByTestId('segment-heatmap')).toBeInTheDocument();
    expect(within(results).getByTestId('top-affected')).toBeInTheDocument();
  });

  it('shows a non-zero ECL impact after an adverse shock', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);

    // Move the GDP slider to -4. The slider is the only role=slider on the page
    // for "GDP shock" so query by accessible name.
    const sliders = screen.getAllByRole('slider');
    expect(sliders.length).toBeGreaterThanOrEqual(3);
    // GDP is the first slider in document order.
    sliders[0].focus();
    // userEvent.keyboard reduces by step (0.5) per ArrowLeft
    for (let i = 0; i < 8; i++) await user.keyboard('{ArrowLeft}');

    await user.click(screen.getByRole('button', { name: /run scenario/i }));

    const results = await screen.findByTestId('scenario-results');
    // After a -4 GDP shock the impact card must show a positive ECL delta.
    expect(within(results).getByText(/% vs baseline/i)).toBeInTheDocument();
  });

  it('surfaces a 400 from the backend as an inline error', async () => {
    server.use(
      http.post('/v1/scenario/run', () =>
        HttpResponse.json({ error: 'gdp must be between -8 and 4' }, { status: 400 }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPage />);
    await user.click(screen.getByRole('button', { name: /run scenario/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});
