import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { screen, waitFor, within } from '@testing-library/react';
import { CustomerRiskProfilePage } from '@/modules/customers/CustomerRiskProfilePage';
import { renderWithProviders } from './utils';

function renderProfile(id: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/customers/:id" element={<CustomerRiskProfilePage />} />
    </Routes>,
    { route: `/customers/${id}` },
  );
}

describe('CustomerRiskProfilePage', () => {
  it('renders PD score, level, and the SHAP top-5 panel', async () => {
    renderProfile('c-101');
    await waitFor(() => {
      expect(screen.getByText(/Achieng Otieno/)).toBeInTheDocument();
    });
    expect(screen.getByText(/PD score/i)).toBeInTheDocument();
    // Level surfaces both as page-header badge and as `level: High` sub-label.
    expect(screen.getAllByText(/High/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/SHAP top 5/i)).toBeInTheDocument();
  });

  it('SHAP rows are sorted by |shap_value|, sign-coloured, and feature-named', async () => {
    renderProfile('c-101');
    const list = await screen.findByLabelText('shap top reasons');
    const items = within(list).getAllByRole('listitem');
    // Expect 5 rows, in this order (by abs(shap)): dpd_max_90d (+0.41),
    // utilization (+0.32), bureau_score (+0.18), repayment_delay_streak (+0.11),
    // tenure_months (-0.08).
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent(/Max DPD/);
    expect(items[0]).toHaveTextContent(/\+0\.41/);
    expect(items[1]).toHaveTextContent(/Utilisation/);
    expect(items[4]).toHaveTextContent(/Tenure/);
    expect(items[4]).toHaveTextContent(/-0\.08/);
  });

  it('shows the model name@version footer (pd_xgboost@0.1.0)', async () => {
    renderProfile('c-101');
    expect(await screen.findByText(/pd_xgboost@0\.1\.0/)).toBeInTheDocument();
  });

  it('humanises encoded categorical features (product_type=credit_card)', async () => {
    renderProfile('c-102');
    const list = await screen.findByLabelText('shap top reasons');
    expect(within(list).getByText(/product type = credit card/i)).toBeInTheDocument();
  });

  // ─── Linked alerts + cases (spec §5.3 360-view) ──────────────────

  it('Linked Alerts panel renders alerts for the customer (c-101 has a-1001)', async () => {
    renderProfile('c-101');
    const list = await screen.findByTestId('linked-alerts-list');
    // c-101 is referenced by a-1001 (Salary inflow stopped 60d) in mock seed.
    expect(within(list).getByText(/Salary inflow stopped 60d/)).toBeInTheDocument();
    // Severity badge present.
    expect(within(list).getByText(/critical/i)).toBeInTheDocument();
  });

  it('Linked Cases panel renders cases for the customer with a click-through link', async () => {
    renderProfile('c-101');
    const list = await screen.findByTestId('linked-cases-list');
    // c-101 has case-501 in mock seed.
    const link = within(list).getByTestId('linked-case-link-case-501');
    expect(link.getAttribute('href')).toBe('/cases/case-501');
  });

  it('Linked Alerts panel shows empty state when the customer has none', async () => {
    // c-104 (Daniel Mwangi) has alert a-1004; let's use a customer with NO
    // alerts. None of c-108..c-112 are referenced by any alert in the seed.
    renderProfile('c-108');
    expect(await screen.findByTestId('linked-alerts-empty')).toBeInTheDocument();
  });

  it('Linked Cases panel shows empty state when the customer has none', async () => {
    // c-108 has no case in the seed (caseDetails only references c-101/102/106).
    renderProfile('c-108');
    expect(await screen.findByTestId('linked-cases-empty')).toBeInTheDocument();
  });

  // ── T3.3 AML correlation panel ────────────────────────────────────

  it('AML correlation panel shows the open match for the customer', async () => {
    // c-101 has a single seeded AML match in the MSW fixture.
    renderProfile('c-101');
    const block = await screen.findByTestId('aml-matches');
    expect(block).toBeInTheDocument();
    expect(screen.getByText(/Sample Watchlist Entity/)).toBeInTheDocument();
    expect(screen.getByTestId('correlate-aml-m-101')).toBeInTheDocument();
  });

  it('AML correlation panel shows empty state for customers with no matches', async () => {
    renderProfile('c-108');
    expect(await screen.findByTestId('aml-empty')).toBeInTheDocument();
  });
});
