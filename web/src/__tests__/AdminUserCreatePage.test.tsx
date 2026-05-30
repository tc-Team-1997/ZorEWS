// AdminUserCreatePage — RBAC create flow.
//
// Pins the two behaviours the enterprise RBAC work added:
//   1. admin-only gate (non-admin sees no form);
//   2. domain-aware 16-role filter (insurance-only personas appear only
//      when domain=insurance; banking-only personas only when banking;
//      domain==='both' personas always; the 041 additions surface);
//   3. the 9-capability RBAC live preview renders for a chosen role.

import { describe, test, expect, beforeEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderWithProviders } from './utils';
import { useAuth } from '@/store/auth';
import { AdminUserCreatePage } from '@/modules/admin/AdminUserCreatePage';

function authenticateAs(roles: string[]) {
  useAuth.setState({
    status: 'authenticated',
    token: 't',
    user: { id: 'u-001', username: 'alice.admin', roles: roles as never[] },
  });
}

function roleOptionLabels(): string[] {
  const select = screen.getByTestId('user-role') as HTMLSelectElement;
  return within(select)
    .queryAllByRole('option')
    .map((o) => o.textContent ?? '');
}

beforeEach(() => {
  useAuth.setState({ status: 'idle', token: null, user: null });
});

describe('AdminUserCreatePage — admin gate', () => {
  test('non-admin sees no create form (bounced)', () => {
    authenticateAs(['risk_analyst']);
    renderWithProviders(<AdminUserCreatePage />);
    expect(screen.queryByTestId('user-role')).not.toBeInTheDocument();
    expect(screen.queryByText('Create user')).not.toBeInTheDocument();
  });

  test('admin sees the create form', () => {
    authenticateAs(['admin']);
    renderWithProviders(<AdminUserCreatePage />);
    expect(screen.getByTestId('user-role')).toBeInTheDocument();
    expect(screen.getByTestId('user-domain')).toBeInTheDocument();
  });
});

describe('AdminUserCreatePage — domain-aware 16-role filter', () => {
  beforeEach(() => {
    authenticateAs(['admin']);
    renderWithProviders(<AdminUserCreatePage />);
  });

  test('domain unset → only cross-domain (both) roles; no domain-specific personas', () => {
    const labels = roleOptionLabels();
    // 'both' personas present
    expect(labels).toContain('Super Admin');
    expect(labels).toContain('Risk Analyst');
    expect(labels).toContain('Platform Auditor'); // 041 addition, domain='both'
    // domain-specific personas absent until a domain is chosen
    expect(labels).not.toContain('Claims Investigator'); // insurance-only
    expect(labels).not.toContain('Credit Officer'); // banking-only
  });

  test('domain=insurance surfaces the insurance personas (incl. 041 additions)', () => {
    fireEvent.change(screen.getByTestId('user-domain'), { target: { value: 'insurance' } });
    const labels = roleOptionLabels();
    expect(labels).toContain('Insurance Admin');
    expect(labels).toContain('Claims Investigator'); // 041
    expect(labels).toContain('Underwriting Officer'); // 041
    expect(labels).toContain('Persistency Manager'); // 041
    expect(labels).toContain('Compliance Officer'); // 041
    expect(labels).toContain('Platform Auditor'); // both → still present
    // banking-only persona must NOT leak into the insurance domain
    expect(labels).not.toContain('Credit Officer');
  });

  test('domain=banking surfaces banking personas and hides insurance ones', () => {
    fireEvent.change(screen.getByTestId('user-domain'), { target: { value: 'banking' } });
    const labels = roleOptionLabels();
    expect(labels).toContain('Bank Admin');
    expect(labels).toContain('Credit Officer');
    expect(labels).toContain('Platform Auditor'); // both → present
    expect(labels).not.toContain('Claims Investigator'); // insurance-only hidden
    expect(labels).not.toContain('Underwriting Officer');
  });
});

describe('AdminUserCreatePage — RBAC capability preview', () => {
  test('selecting a role renders its capability matrix', () => {
    authenticateAs(['admin']);
    renderWithProviders(<AdminUserCreatePage />);
    // placeholder before a role is chosen
    expect(
      screen.getByText('Select a role to preview the granted capabilities.'),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('user-role'), { target: { value: 'risk_analyst' } });
    // capability label from CAPABILITY_LABELS surfaces in the preview
    expect(screen.getByText('Author and edit rules')).toBeInTheDocument();
    expect(screen.getByText('Read audit trail')).toBeInTheDocument();
    // backend mapping line for risk_analyst
    expect(screen.getByText('risk_analyst')).toBeInTheDocument();
  });
});

describe('AdminUserCreatePage — Phase 9 T8 extra-fields sections', () => {
  beforeEach(() => {
    authenticateAs(['admin']);
    renderWithProviders(<AdminUserCreatePage />);
  });

  test('renders 3 new optional sections (Extended profile / Contact / Address)', () => {
    expect(screen.getByText(/6\. Extended profile/i)).toBeInTheDocument();
    expect(screen.getByText(/7\. Contact details/i)).toBeInTheDocument();
    expect(screen.getByText(/8\. Postal address/i)).toBeInTheDocument();
  });

  test('Extended profile section exposes DOB / gender / joining_date / reporting_manager / secondary_skills inputs', () => {
    expect(screen.getByTestId('user-dob')).toBeInTheDocument();
    expect(screen.getByTestId('user-gender')).toBeInTheDocument();
    expect(screen.getByTestId('user-joining-date')).toBeInTheDocument();
    expect(screen.getByTestId('user-reporting-manager')).toBeInTheDocument();
    expect(screen.getByTestId('user-secondary-skills')).toBeInTheDocument();
  });

  test('Contact details section exposes alternate_email / secondary_mobile / emergency fields', () => {
    expect(screen.getByTestId('user-alternate-email')).toBeInTheDocument();
    expect(screen.getByTestId('user-secondary-mobile')).toBeInTheDocument();
    expect(screen.getByTestId('user-emergency-contact-name')).toBeInTheDocument();
    expect(screen.getByTestId('user-emergency-contact-phone')).toBeInTheDocument();
  });

  test('Postal address section exposes line1 / line2 / postal_code inputs', () => {
    expect(screen.getByTestId('user-address-line1')).toBeInTheDocument();
    expect(screen.getByTestId('user-address-line2')).toBeInTheDocument();
    expect(screen.getByTestId('user-postal-code')).toBeInTheDocument();
  });

  test('Gender select offers the 4 canonical options + an empty default', () => {
    const select = screen.getByTestId('user-gender') as HTMLSelectElement;
    const options = within(select).queryAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['', 'male', 'female', 'other', 'prefer_not_to_say']);
  });

  test('DOB field accepts a typed value (input state mutation)', () => {
    const dob = screen.getByTestId('user-dob') as HTMLInputElement;
    fireEvent.change(dob, { target: { value: '1990-05-15' } });
    expect(dob.value).toBe('1990-05-15');
  });
});
