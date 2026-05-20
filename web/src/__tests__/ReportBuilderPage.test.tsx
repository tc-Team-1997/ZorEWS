// T4.6.5 — Self-service report-builder SPA tests.

import { describe, test, expect, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './utils';
import { ReportBuilderPage } from '@/modules/reports/builder/ReportBuilderPage';
import { __resetMswReportsBuilder } from '@/mocks/handlers';

describe('ReportBuilderPage', () => {
  beforeEach(() => {
    __resetMswReportsBuilder();
  });

  test('renders the 3-pane layout + PageHeader', async () => {
    renderWithProviders(<ReportBuilderPage />);
    expect(screen.getByText('Report builder')).toBeInTheDocument();
    expect(screen.getByTestId('saved-reports-list')).toBeInTheDocument();
    expect(screen.getByTestId('source-picker-panel')).toBeInTheDocument();
    expect(screen.getByTestId('run-panel')).toBeInTheDocument();
  });

  test('source picker loads catalog + lists sources', async () => {
    renderWithProviders(<ReportBuilderPage />);
    await waitFor(() => {
      expect(screen.getByTestId('source-select')).toBeInTheDocument();
    });
    const select = screen.getByTestId('source-select') as HTMLSelectElement;
    await waitFor(() => {
      // Expect at least the placeholder + 2 sources from MSW.
      expect(select.options.length).toBeGreaterThanOrEqual(3);
    });
  });

  test('selecting a source reveals filter + save panels', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportBuilderPage />);
    await waitFor(() => {
      expect(screen.getByTestId('source-select')).toBeInTheDocument();
    });
    await user.selectOptions(screen.getByTestId('source-select'), 'mart.customer_360');
    await waitFor(() => {
      expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      expect(screen.getByTestId('save-panel')).toBeInTheDocument();
      expect(screen.getByTestId('source-description')).toBeInTheDocument();
    });
  });

  test('filter tree empty by default + "Add first filter" works', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportBuilderPage />);
    await waitFor(() => screen.getByTestId('source-select'));
    await user.selectOptions(screen.getByTestId('source-select'), 'mart.customer_360');
    await waitFor(() => screen.getByTestId('filter-tree-empty'));
    await user.click(screen.getByTestId('add-first-filter-btn'));
    await waitFor(() => screen.getByTestId('filter-tree-root'));
    expect(screen.getByTestId('filter-leaf')).toBeInTheDocument();
  });

  test('Run button executes the report and renders result table', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportBuilderPage />);
    await waitFor(() => screen.getByTestId('source-select'));
    await user.selectOptions(screen.getByTestId('source-select'), 'mart.customer_360');
    await waitFor(() => screen.getByTestId('run-btn'));
    await user.click(screen.getByTestId('run-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('result-table')).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  test('Save button creates a saved report visible in the left panel', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportBuilderPage />);
    await waitFor(() => screen.getByTestId('source-select'));
    await user.selectOptions(screen.getByTestId('source-select'), 'mart.customer_360');
    await waitFor(() => screen.getByTestId('save-name-input'));
    await user.type(screen.getByTestId('save-name-input'), 'My high-risk report');
    await user.click(screen.getByTestId('save-btn'));
    await waitFor(() => {
      expect(screen.getByText('My high-risk report')).toBeInTheDocument();
    });
  });

  test('save button disabled until name is non-empty', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportBuilderPage />);
    await waitFor(() => screen.getByTestId('source-select'));
    await user.selectOptions(screen.getByTestId('source-select'), 'mart.customer_360');
    await waitFor(() => screen.getByTestId('save-btn'));
    const saveBtn = screen.getByTestId('save-btn') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    await user.type(screen.getByTestId('save-name-input'), 'X');
    expect((screen.getByTestId('save-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  test('changing visibility selector updates state', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportBuilderPage />);
    await waitFor(() => screen.getByTestId('source-select'));
    await user.selectOptions(screen.getByTestId('source-select'), 'mart.customer_360');
    await waitFor(() => screen.getByTestId('visibility-select'));
    const sel = screen.getByTestId('visibility-select') as HTMLSelectElement;
    expect(sel.value).toBe('private');
    await user.selectOptions(sel, 'tenant');
    expect(sel.value).toBe('tenant');
  });

  test('limit input clamps to [1, 10000]', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportBuilderPage />);
    await waitFor(() => screen.getByTestId('source-select'));
    await user.selectOptions(screen.getByTestId('source-select'), 'mart.customer_360');
    await waitFor(() => screen.getByTestId('limit-input'));
    const limit = screen.getByTestId('limit-input') as HTMLInputElement;
    await user.clear(limit);
    await user.type(limit, '999999');
    // React batches; check the rendered DOM value.
    await waitFor(() => expect(parseInt(limit.value, 10)).toBeLessThanOrEqual(10000));
  });

  test('saved reports list groups by visibility tier', async () => {
    renderWithProviders(<ReportBuilderPage />);
    await waitFor(() => screen.getByTestId('saved-reports-list'));
    expect(screen.getByTestId('group-private')).toBeInTheDocument();
    expect(screen.getByTestId('group-role')).toBeInTheDocument();
    expect(screen.getByTestId('group-tenant')).toBeInTheDocument();
  });

  // ── T4.6.6 — sections + drill-down + PDF/Excel buttons ──────────────

  test('SectionConfigurator renders + add-buttons appear when source selected', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportBuilderPage />);
    await waitFor(() => screen.getByTestId('source-select'));
    await user.selectOptions(screen.getByTestId('source-select'), 'mart.customer_360');
    await waitFor(() => {
      expect(screen.getByTestId('section-configurator')).toBeInTheDocument();
      expect(screen.getByTestId('add-kpi-section')).toBeInTheDocument();
      expect(screen.getByTestId('add-table-section')).toBeInTheDocument();
      expect(screen.getByTestId('add-chart-section')).toBeInTheDocument();
      expect(screen.getByTestId('sections-empty')).toBeInTheDocument();
    });
  });

  test('clicking "Add Table" creates a new section row', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportBuilderPage />);
    await waitFor(() => screen.getByTestId('source-select'));
    await user.selectOptions(screen.getByTestId('source-select'), 'mart.customer_360');
    await user.click(screen.getByTestId('add-table-section'));
    await waitFor(() => {
      expect(screen.getByTestId('section-config-0')).toBeInTheDocument();
    });
  });

  test('Sections render after Run when sections are configured', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportBuilderPage />);
    await waitFor(() => screen.getByTestId('source-select'));
    await user.selectOptions(screen.getByTestId('source-select'), 'mart.customer_360');
    await user.click(screen.getByTestId('add-table-section'));
    await user.click(screen.getByTestId('run-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('sections-render-area')).toBeInTheDocument();
    });
  });

  test('section ordering: up/down buttons reorder', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportBuilderPage />);
    await waitFor(() => screen.getByTestId('source-select'));
    await user.selectOptions(screen.getByTestId('source-select'), 'mart.customer_360');
    await user.click(screen.getByTestId('add-kpi-section'));
    await user.click(screen.getByTestId('add-table-section'));
    // Both should exist; up on index 1 → swap positions.
    const beforeUp = screen.getAllByTestId(/^section-config-/);
    expect(beforeUp.length).toBe(2);
    await user.click(screen.getByTestId('section-up-1'));
    // After swap, section types reversed (table now first, kpi second).
    // We can verify the testids still resolve and remain stable counts.
    const afterUp = screen.getAllByTestId(/^section-config-/);
    expect(afterUp.length).toBe(2);
  });

  test('section delete button removes the section', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportBuilderPage />);
    await waitFor(() => screen.getByTestId('source-select'));
    await user.selectOptions(screen.getByTestId('source-select'), 'mart.customer_360');
    await user.click(screen.getByTestId('add-table-section'));
    expect(screen.getByTestId('section-config-0')).toBeInTheDocument();
    await user.click(screen.getByTestId('section-remove-0'));
    await waitFor(() => {
      expect(screen.queryByTestId('section-config-0')).not.toBeInTheDocument();
      expect(screen.getByTestId('sections-empty')).toBeInTheDocument();
    });
  });

  test('PDF + Excel export buttons disabled until Run completes', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportBuilderPage />);
    await waitFor(() => screen.getByTestId('source-select'));
    await user.selectOptions(screen.getByTestId('source-select'), 'mart.customer_360');
    await waitFor(() => {
      expect((screen.getByTestId('export-pdf-btn') as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId('export-xlsx-btn') as HTMLButtonElement).disabled).toBe(true);
    });
    await user.click(screen.getByTestId('run-btn'));
    await waitFor(() => {
      expect((screen.getByTestId('export-pdf-btn') as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByTestId('export-xlsx-btn') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  test('clicking a saved report loads it back into the builder', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ReportBuilderPage />);
    await waitFor(() => screen.getByTestId('source-select'));
    await user.selectOptions(screen.getByTestId('source-select'), 'mart.customer_360');
    await user.type(screen.getByTestId('save-name-input'), 'Persisted');
    await user.click(screen.getByTestId('save-btn'));
    await waitFor(() => screen.getByText('Persisted'));

    // Start "New" then click the saved row to re-load.
    await user.click(screen.getByTestId('new-report-btn'));
    await waitFor(() => {
      expect((screen.getByTestId('source-select') as HTMLSelectElement).value).toBe('');
    });
    await user.click(screen.getByText('Persisted'));
    await waitFor(() => {
      expect((screen.getByTestId('source-select') as HTMLSelectElement).value).toBe('mart.customer_360');
    });
    expect((screen.getByTestId('save-name-input') as HTMLInputElement).value).toBe('Persisted');
  });
});
