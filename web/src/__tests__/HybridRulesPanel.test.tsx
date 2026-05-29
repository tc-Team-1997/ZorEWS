import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { AiWorkbenchPage } from '@/modules/ai/AiWorkbenchPage';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';

// Hybrid-rule authoring is gated on rules:create (analyst+). Seed an analyst
// so the create / activate / dry-run paths are exercised.
function asAnalyst() {
  useAuth.setState({
    status: 'authenticated',
    token: 't',
    user: { username: 'alice.analyst', roles: ['risk_analyst'], tenant_id: 'BANK_DEMO' } as never,
  });
}

async function openHybridTab() {
  renderWithProviders(<AiWorkbenchPage />);
  fireEvent.click(await screen.findByTestId('aiwb-tab-hybrid'));
  await waitFor(() => expect(screen.getByTestId('aiwb-hybrid-list')).toBeInTheDocument());
}

describe('AI Workbench — Hybrid Rules tab', () => {
  it('renders the tab, KPIs, and the 2 seeded rules with rendered expressions', async () => {
    asAnalyst();
    await openHybridTab();
    expect(screen.getByTestId('aiwb-hybrid-kpi-total')).toBeInTheDocument();
    expect(screen.getByTestId('aiwb-hybrid-kpi-active')).toBeInTheDocument();
    expect(screen.getByTestId('aiwb-hybrid-kpi-draft')).toBeInTheDocument();
    expect(screen.getByTestId('aiwb-hybrid-kpi-disabled')).toBeInTheDocument();
    const rows = await screen.findAllByTestId(/^aiwb-hybrid-row-/);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // The seeded banking rule renders its IF…THEN expression.
    expect(screen.getByText('High-DPD + high-PD → critical alert')).toBeInTheDocument();
    const expr = screen.getAllByTestId(/^aiwb-hybrid-expr-/)[0];
    expect(expr.textContent).toMatch(/IF .* THEN .* \(/);
  });

  it('domain filter narrows the list to insurance', async () => {
    asAnalyst();
    await openHybridTab();
    fireEvent.change(screen.getByTestId('aiwb-hybrid-filter-domain'), {
      target: { value: 'insurance' },
    });
    await waitFor(() => {
      expect(screen.getByText('Lapse-likely + grace → notify retention')).toBeInTheDocument();
    });
    expect(screen.queryByText('High-DPD + high-PD → critical alert')).not.toBeInTheDocument();
  });

  it('dry-run shows per-condition pass/fail + WOULD FIRE verdict', async () => {
    asAnalyst();
    await openHybridTab();
    const dryBtn = (await screen.findAllByTestId(/^aiwb-hybrid-dryrun-hyb-/))[0];
    fireEvent.click(dryBtn);
    await waitFor(() => expect(screen.getByTestId('aiwb-hybrid-dryrun-modal')).toBeInTheDocument());
    const modal = screen.getByTestId('aiwb-hybrid-dryrun-modal');
    // The banking rule has DPD metric + pd_xgb_v3 ai_score inputs — supply
    // matching values so AND evaluates true.
    fireEvent.change(within(modal).getByTestId('aiwb-hybrid-dryrun-metric-DPD'), {
      target: { value: '120' },
    });
    fireEvent.change(within(modal).getByTestId('aiwb-hybrid-dryrun-score-pd_xgb_v3'), {
      target: { value: '0.9' },
    });
    fireEvent.click(within(modal).getByTestId('aiwb-hybrid-dryrun-run'));
    await waitFor(() =>
      expect(within(modal).getByTestId('aiwb-hybrid-dryrun-verdict')).toBeInTheDocument(),
    );
    expect(within(modal).getByTestId('aiwb-hybrid-dryrun-verdict').textContent).toMatch(/WOULD FIRE/);
    expect(within(modal).getAllByTestId(/^aiwb-hybrid-dryrun-cond-/).length).toBe(2);
  });

  it('dry-run with a value below threshold yields WOULD NOT FIRE', async () => {
    asAnalyst();
    await openHybridTab();
    fireEvent.click((await screen.findAllByTestId(/^aiwb-hybrid-dryrun-hyb-/))[0]);
    const modal = await screen.findByTestId('aiwb-hybrid-dryrun-modal');
    fireEvent.change(within(modal).getByTestId('aiwb-hybrid-dryrun-metric-DPD'), {
      target: { value: '10' },
    });
    fireEvent.change(within(modal).getByTestId('aiwb-hybrid-dryrun-score-pd_xgb_v3'), {
      target: { value: '0.9' },
    });
    fireEvent.click(within(modal).getByTestId('aiwb-hybrid-dryrun-run'));
    await waitFor(() =>
      expect(within(modal).getByTestId('aiwb-hybrid-dryrun-verdict').textContent).toMatch(
        /WOULD NOT FIRE/,
      ),
    );
  });

  it('creates a new hybrid rule (lands as draft) via the builder', async () => {
    asAnalyst();
    await openHybridTab();
    fireEvent.click(screen.getByTestId('aiwb-hybrid-new-btn'));
    const modal = await screen.findByTestId('aiwb-hybrid-form-modal');
    fireEvent.change(within(modal).getByTestId('aiwb-hybrid-form-name'), {
      target: { value: 'Util spike + fraud score → escalate' },
    });
    // Default seeded conditions (DPD metric + pd_xgb_v3 ai_score) already
    // satisfy validity — a live expression preview should render.
    await waitFor(() => expect(within(modal).getByTestId('aiwb-hybrid-form-expr')).toBeInTheDocument());
    fireEvent.click(within(modal).getByTestId('aiwb-hybrid-form-save'));
    await waitFor(() =>
      expect(screen.getByText('Util spike + fraud score → escalate')).toBeInTheDocument(),
    );
    // New rule lands as draft → the draft KPI is now ≥ 1.
    expect(Number(screen.getByTestId('aiwb-hybrid-kpi-draft').textContent?.match(/\d+/)?.[0])).toBeGreaterThanOrEqual(1);
  });

  it('save is disabled until the rule name is ≥ 3 chars', async () => {
    asAnalyst();
    await openHybridTab();
    fireEvent.click(screen.getByTestId('aiwb-hybrid-new-btn'));
    const modal = await screen.findByTestId('aiwb-hybrid-form-modal');
    // Name starts empty → save disabled despite valid seeded conditions.
    expect(within(modal).getByTestId('aiwb-hybrid-form-save')).toBeDisabled();
    fireEvent.change(within(modal).getByTestId('aiwb-hybrid-form-name'), {
      target: { value: 'ab' },
    });
    expect(within(modal).getByTestId('aiwb-hybrid-form-save')).toBeDisabled();
    fireEvent.change(within(modal).getByTestId('aiwb-hybrid-form-name'), {
      target: { value: 'abc' },
    });
    expect(within(modal).getByTestId('aiwb-hybrid-form-save')).not.toBeDisabled();
  });

  it('non-editing roles see no create button', async () => {
    useAuth.setState({
      status: 'authenticated',
      token: 't',
      user: { username: 'val.auditor', roles: ['auditor'], tenant_id: 'BANK_DEMO' } as never,
    });
    await openHybridTab();
    expect(screen.queryByTestId('aiwb-hybrid-new-btn')).not.toBeInTheDocument();
    // Read-only roles still get dry-run.
    expect((await screen.findAllByTestId(/^aiwb-hybrid-dryrun-hyb-/)).length).toBeGreaterThanOrEqual(2);
  });
});
