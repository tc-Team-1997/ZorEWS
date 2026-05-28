// STEP 4 — Admin user creation form.
//
// Dense data form. Section-banded into:
//   1. Identity          (name, email, mobile, employee id)
//   2. Location          (country, state, city)
//   3. Tenant            (organisation, branch, department)
//   4. Role & access     (role + 9-capability live preview)
//   5. Operational       (domain, user type, language, timezone)
//
// The 16-role enterprise catalogue is rendered via ENTERPRISE_ROLES,
// filtered to the chosen domain (domain==='both' roles always show);
// the SPA submits the mapped backend_role to auth-svc /auth/register
// (which currently supports the 5 core roles). The richer payload
// lives client-side until auth-svc grows the enum.

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '@/store/auth';
import {
  AlertCircle,
  ArrowLeft,
  BadgeCheck,
  Building2,
  CheckCircle2,
  IdCard,
  Languages,
  MapPin,
  Phone,
  Save,
  ShieldCheck,
  UserPlus,
  X,
} from 'lucide-react';
import { Button, Input, Panel } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  ENTERPRISE_ROLES,
  CAPABILITY_LABELS,
  getEnterpriseRole,
  type EnterpriseRoleId,
} from '@/lib/enterpriseRoles';
import { COUNTRIES, type CountryCode, getCountry } from '@/lib/countries';
import { ORGANIZATIONS, getOrganization } from '@/lib/organizations';
import { cn } from '@/lib/cn';
import { HttpError } from '@/lib/http';

const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी (Hindi)' },
  { code: 'dz', label: 'རྫོང་ཁ་ (Dzongkha)' },
  { code: 'ne', label: 'नेपाली (Nepali)' },
];

const USER_TYPES = ['Permanent', 'Contract', 'Intern', 'Consultant'];

interface FormState {
  // Identity
  full_name: string;
  email: string;
  mobile: string;
  employee_id: string;
  // Location
  country: CountryCode | '';
  state: string;
  city: string;
  // Tenant
  organization_id: string;
  branch: string;
  department: string;
  // Access
  role_id: EnterpriseRoleId | '';
  user_type: string;
  // Operational
  domain: 'banking' | 'insurance' | '';
  language: string;
  timezone: string;
}

const EMPTY: FormState = {
  full_name: '',
  email: '',
  mobile: '',
  employee_id: '',
  country: '',
  state: '',
  city: '',
  organization_id: '',
  branch: '',
  department: '',
  role_id: '',
  user_type: 'Permanent',
  domain: '',
  language: 'en',
  timezone: '',
};

export function AdminUserCreatePage() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const adminCreateUser = useAuth((s) => s.adminCreateUser);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [successUsername, setSuccessUsername] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Admin-only gate.
  if (!user) return <Navigate to="/login" replace />;
  if (!user.roles.includes('admin')) return <Navigate to="/" replace />;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError(null);
  };

  // Derived: when country changes, default timezone + clear org/branch.
  useEffect(() => {
    if (!form.country) return;
    const c = getCountry(form.country);
    if (c && !form.timezone) {
      setForm((p) => ({ ...p, timezone: c.timezone.tz }));
    }
  }, [form.country, form.timezone]);

  // Org list scoped by (country, domain) — falls back to all orgs of
  // the chosen domain if country has no listed tenants in our catalog.
  const eligibleOrgs = useMemo(() => {
    if (!form.country || !form.domain) return [];
    const exact = ORGANIZATIONS.filter(
      (o) => o.country === form.country && o.domain === form.domain,
    );
    return exact.length > 0
      ? exact
      : ORGANIZATIONS.filter((o) => o.domain === form.domain);
  }, [form.country, form.domain]);

  const chosenOrg = getOrganization(form.organization_id);
  const branches = chosenOrg ? chosenOrg.branches[form.state] ?? [] : [];

  // When country/domain changes, drop the org/state/branch.
  useEffect(() => {
    setForm((p) => ({ ...p, organization_id: '', state: '', branch: '' }));
  }, [form.country, form.domain]);

  // When org changes, drop state/branch (states list is derived from
  // org.regions, since BIL "state" maps to a region in our model).
  useEffect(() => {
    setForm((p) => ({ ...p, state: '', branch: '' }));
  }, [form.organization_id]);

  const enterpriseRole = getEnterpriseRole(form.role_id);

  function validate(): string | null {
    if (form.full_name.trim().length < 2) return 'Full name is required.';
    if (!/.+@.+\..+/.test(form.email)) return 'Valid email is required.';
    if (form.mobile.trim().length < 7) return 'Mobile number is required.';
    if (!form.employee_id.trim()) return 'Employee ID is required.';
    if (!form.country) return 'Country is required.';
    if (!form.domain) return 'Domain is required.';
    if (!form.organization_id) return 'Organisation is required.';
    if (!form.state) return 'Region / State is required.';
    if (!form.city.trim()) return 'City is required.';
    if (!form.branch) return 'Branch is required.';
    if (!form.department.trim()) return 'Department is required.';
    if (!form.role_id) return 'Role is required.';
    if (!form.user_type) return 'User type is required.';
    if (!form.timezone) return 'Timezone is required.';
    return null;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    if (!enterpriseRole) {
      setError('Role is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      // Derive a username from email (auth-svc requires a username).
      const username = form.email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '.');
      const tempPassword = `Welcome!${Math.floor(Math.random() * 9000 + 1000)}#`;
      await adminCreateUser({
        username,
        email: form.email.toLowerCase(),
        password: tempPassword,
        display_name: form.full_name,
        role: enterpriseRole.backend_role,
      });
      setSuccessUsername(username);
    } catch (caught) {
      if (caught instanceof HttpError) {
        const body = caught.body as { error?: string; message?: string } | undefined;
        setError(body?.message || body?.error || `Server returned ${caught.status}.`);
      } else {
        setError((caught as Error).message || 'Failed to create user.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Successful submit → render the confirmation card.
  if (successUsername) {
    return (
      <div>
        <PageHeader
          title="User created"
          subtitle="A welcome email with temporary credentials has been queued."
        />
        <Panel className="p-6 max-w-[640px]">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-md bg-success-bg border border-success/30 flex items-center justify-center shrink-0">
              <CheckCircle2 size={18} className="text-success" />
            </div>
            <div>
              <p className="font-display text-[18px] font-semibold text-ink">
                {form.full_name} added to {chosenOrg?.name}
              </p>
              <p className="text-[12.5px] text-sub mt-1">
                Username <span className="font-mono text-ink">{successUsername}</span> · role{' '}
                <span className="font-mono text-ink">{enterpriseRole?.label}</span>
              </p>
            </div>
          </div>
          <div className="flex gap-2 mt-5">
            <Button onClick={() => navigate('/admin/users')}>Back to users</Button>
            <Button
              variant="ghost"
              onClick={() => {
                setSuccessUsername(null);
                setForm(EMPTY);
              }}
            >
              Create another
            </Button>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Create user"
        subtitle="Provision an operator account. Access is scoped by country, domain, tenant, role, branch, and department."
        actions={
          <Button variant="ghost" onClick={() => navigate('/admin/users')}>
            <ArrowLeft size={14} className="mr-1" />
            Back
          </Button>
        }
      />

      <form onSubmit={onSubmit} className="grid grid-cols-1 xl:grid-cols-[1fr,360px] gap-5">
        {/* ── LEFT — form sections ─────────────────────────────── */}
        <div className="space-y-5">
          <FormSection
            icon={<IdCard size={13} />}
            title="Identity"
            subtitle="Personal details the operator signs in with."
          >
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Full name *"
                value={form.full_name}
                onChange={(e) => set('full_name', e.target.value)}
                placeholder="Alice Mwangi"
                data-testid="user-full-name"
              />
              <Input
                label="Email *"
                type="email"
                value={form.email}
                onChange={(e) => set('email', e.target.value.toLowerCase())}
                placeholder="alice.mwangi@bank.example"
                data-testid="user-email"
              />
              <Input
                label="Mobile number *"
                value={form.mobile}
                onChange={(e) => set('mobile', e.target.value)}
                placeholder="+91 98765 43210"
                data-testid="user-mobile"
              />
              <Input
                label="Employee ID *"
                value={form.employee_id}
                onChange={(e) => set('employee_id', e.target.value)}
                placeholder="EMP-001234"
                data-testid="user-employee-id"
              />
            </div>
          </FormSection>

          <FormSection
            icon={<MapPin size={13} />}
            title="Location"
            subtitle="Drives default timezone and date format."
          >
            <div className="grid grid-cols-3 gap-3">
              <SelectField
                label="Country *"
                value={form.country}
                onChange={(v) => set('country', v as CountryCode | '')}
                options={[
                  { value: '', label: '— Select —' },
                  ...COUNTRIES.map((c) => ({
                    value: c.code,
                    label: `${c.flag} ${c.name}`,
                  })),
                ]}
                testId="user-country"
              />
              <Input
                label="State / Region"
                value={form.state}
                onChange={(e) => set('state', e.target.value)}
                placeholder="Maharashtra"
                data-testid="user-state"
              />
              <Input
                label="City *"
                value={form.city}
                onChange={(e) => set('city', e.target.value)}
                placeholder="Mumbai"
                data-testid="user-city"
              />
            </div>
          </FormSection>

          <FormSection
            icon={<Building2 size={13} />}
            title="Tenant"
            subtitle="Which organisation, division and branch the user belongs to."
          >
            <div className="grid grid-cols-2 gap-3">
              <SelectField
                label="Domain *"
                value={form.domain}
                onChange={(v) => set('domain', v as 'banking' | 'insurance' | '')}
                options={[
                  { value: '', label: '— Select —' },
                  { value: 'banking', label: 'Banking' },
                  { value: 'insurance', label: 'Insurance' },
                ]}
                testId="user-domain"
              />
              <SelectField
                label="Organisation *"
                value={form.organization_id}
                onChange={(v) => set('organization_id', v)}
                disabled={!form.country || !form.domain}
                options={[
                  { value: '', label: form.country && form.domain ? '— Select —' : 'Pick country + domain first' },
                  ...eligibleOrgs.map((o) => ({ value: o.id, label: o.name })),
                ]}
                testId="user-org"
              />
              <SelectField
                label="Branch *"
                value={form.branch}
                onChange={(v) => set('branch', v)}
                disabled={!chosenOrg || !form.state}
                options={[
                  { value: '', label: chosenOrg && form.state ? '— Select —' : 'Pick organisation + region first' },
                  ...branches.map((b) => ({ value: b, label: b })),
                ]}
                testId="user-branch"
              />
              <Input
                label="Department *"
                value={form.department}
                onChange={(e) => set('department', e.target.value)}
                placeholder="Credit Risk"
                data-testid="user-department"
              />
            </div>
            {chosenOrg && (
              <p className="mt-2 font-mono text-[10.5px] text-muted">
                Tenant ID at request time → <span className="text-ink">{chosenOrg.tenant_id}</span>
              </p>
            )}
          </FormSection>

          <FormSection
            icon={<ShieldCheck size={13} />}
            title="Role & access"
            subtitle="The role determines which capabilities are unlocked across the platform."
          >
            <SelectField
              label="Role *"
              value={form.role_id}
              onChange={(v) => set('role_id', v as EnterpriseRoleId | '')}
              options={[
                { value: '', label: '— Select —' },
                ...ENTERPRISE_ROLES.filter(
                  (r) => r.domain === 'both' || (form.domain && r.domain === form.domain),
                ).map((r) => ({ value: r.id, label: r.label })),
              ]}
              testId="user-role"
            />
            {enterpriseRole && (
              <p className="text-[12px] text-sub mt-2 leading-relaxed">
                {enterpriseRole.description}
              </p>
            )}
            <div className="grid grid-cols-2 gap-3 mt-3">
              <SelectField
                label="User type *"
                value={form.user_type}
                onChange={(v) => set('user_type', v)}
                options={USER_TYPES.map((t) => ({ value: t, label: t }))}
                testId="user-type"
              />
              <SelectField
                label="Preferred language"
                value={form.language}
                onChange={(v) => set('language', v)}
                options={LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
                testId="user-language"
                icon={<Languages size={13} />}
              />
            </div>
          </FormSection>

          <FormSection
            icon={<Phone size={13} />}
            title="Operational context"
            subtitle="Timezone the user operates in — drives session windows and SLA timers."
          >
            <SelectField
              label="Timezone *"
              value={form.timezone}
              onChange={(v) => set('timezone', v)}
              options={[
                { value: '', label: '— Select —' },
                ...COUNTRIES.map((c) => ({
                  value: c.timezone.tz,
                  label: `${c.flag} ${c.timezone.label} (${c.timezone.tz})`,
                })),
              ]}
              testId="user-timezone"
            />
          </FormSection>

          {error && (
            <div
              role="alert"
              data-testid="user-create-error"
              className="flex items-start gap-2 rounded border border-danger/30 bg-danger-bg px-3 py-2"
            >
              <AlertCircle size={14} className="mt-0.5 text-danger shrink-0" />
              <p className="text-[12.5px] text-danger leading-snug">{error}</p>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" type="button" onClick={() => navigate('/admin/users')}>
              <X size={14} className="mr-1" />
              Cancel
            </Button>
            <Button
              type="submit"
              loading={submitting}
              className="font-semibold tracking-wide !bg-ews-orange hover:!bg-ews-orangeDeep !text-white !border-ews-orangeDeep"
              data-testid="user-create-submit"
            >
              <Save size={14} className="mr-1.5" />
              Create user
            </Button>
          </div>
        </div>

        {/* ── RIGHT — sticky RBAC live preview ─────────────────── */}
        <aside className="xl:sticky xl:top-4 self-start space-y-3">
          <Panel className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <BadgeCheck size={14} className="text-ews-orangeDeep" />
              <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted">
                RBAC preview
              </p>
            </div>
            {enterpriseRole ? (
              <>
                <p className="font-display text-[18px] font-semibold text-ink leading-tight">
                  {enterpriseRole.label}
                </p>
                <p className="text-[11.5px] text-sub mt-1 leading-snug">{enterpriseRole.description}</p>
                <p className="font-mono text-[10px] text-muted mt-2">
                  Backend mapping → <span className="text-ink">{enterpriseRole.backend_role}</span>
                </p>
                <ul className="mt-4 space-y-1.5">
                  {(Object.entries(enterpriseRole.capabilities) as [
                    keyof typeof enterpriseRole.capabilities,
                    boolean,
                  ][]).map(([cap, ok]) => (
                    <li key={cap} className="flex items-center gap-2 text-[11.5px]">
                      <span
                        className={cn(
                          'inline-flex h-4 w-4 rounded-sm items-center justify-center',
                          ok ? 'bg-success/15 text-success' : 'bg-divider/60 text-muted',
                        )}
                      >
                        {ok ? '✓' : '×'}
                      </span>
                      <span className={ok ? 'text-ink' : 'text-muted'}>
                        {CAPABILITY_LABELS[cap]}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-[12.5px] text-muted">
                Select a role to preview the granted capabilities.
              </p>
            )}
          </Panel>

          <Panel className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <UserPlus size={14} className="text-ews-orangeDeep" />
              <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted">
                Access scope
              </p>
            </div>
            <ScopeRow label="Country" value={form.country ? getCountry(form.country)?.name ?? '—' : '—'} />
            <ScopeRow label="Domain" value={form.domain || '—'} />
            <ScopeRow label="Tenant" value={chosenOrg?.tenant_id || '—'} />
            <ScopeRow label="Organisation" value={chosenOrg?.name || '—'} />
            <ScopeRow label="Region" value={form.state || '—'} />
            <ScopeRow label="Branch" value={form.branch || '—'} />
            <ScopeRow label="Department" value={form.department || '—'} />
          </Panel>
        </aside>
      </form>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────

function FormSection({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <Panel className="p-4">
      <div className="flex items-start gap-2 pb-3 border-b border-divider mb-3">
        <div className="h-7 w-7 rounded-md bg-ews-orange/10 border border-ews-orange/30 flex items-center justify-center shrink-0 text-ews-orangeDeep">
          {icon}
        </div>
        <div>
          <p className="font-display text-[15px] font-semibold text-ink leading-tight">{title}</p>
          <p className="text-[11.5px] text-sub mt-0.5 leading-snug">{subtitle}</p>
        </div>
      </div>
      {children}
    </Panel>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
  testId,
  icon,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  testId?: string;
  icon?: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[11px] font-medium text-ink mb-1 inline-flex items-center gap-1">
        {icon && <span className="text-muted">{icon}</span>}
        {label}
      </span>
      <select
        data-testid={testId}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'w-full h-9 px-2.5 rounded-input border border-border bg-white text-[12.5px] text-ink',
          'focus:outline-none focus:ring-2 focus:ring-action/40 focus:border-action',
          disabled && 'bg-divider/30 text-muted cursor-not-allowed',
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ScopeRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-divider/70 last:border-0">
      <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">{label}</span>
      <span className="text-[11.5px] text-ink font-medium truncate ml-2 text-right">{value}</span>
    </div>
  );
}
