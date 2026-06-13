import { describe, test, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExportButton } from '@/components/export/ExportButton';
import type { ReportData } from '@/lib/export/types';

const data: ReportData = {
  report_type: 'customer', module: 'customer_360', title: 't',
  meta: { tenant_id: 'BANK_DEMO', generated_by: 'a', role: 'admin', generated_at: '', report_id: 'EXP-1' },
  sections: {}, record_count: 0,
};
function setUser(roles: string[]) {
  localStorage.setItem('apex.ews.user', JSON.stringify({ username: 'alice.admin', roles }));
}
beforeEach(() => localStorage.clear());

describe('ExportButton', () => {
  test('renders for admin (has reports:export)', () => {
    setUser(['admin']);
    render(<ExportButton adapter={() => data} module="customer_360" reportType="customer" />);
    expect(screen.getByTestId('export-button')).toBeTruthy();
  });

  test('hidden for field_officer (no reports:export)', () => {
    setUser(['field_officer']);
    const { container } = render(<ExportButton adapter={() => data} module="customer_360" reportType="customer" />);
    expect(container.querySelector('[data-testid="export-button"]')).toBeNull();
  });

  test('clicking opens the modal', () => {
    setUser(['risk_analyst']);
    render(<ExportButton adapter={() => data} module="customer_360" reportType="customer" />);
    fireEvent.click(screen.getByTestId('export-button'));
    expect(screen.getByTestId('export-modal')).toBeTruthy();
  });
});
