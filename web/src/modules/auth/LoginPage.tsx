import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Clock, RefreshCw, ShieldCheck, KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth, type CaptchaChallenge } from '@/store/auth';
import { HttpError } from '@/lib/http';
import { Button, Input } from '@/components/ui';
import { cn } from '@/lib/cn';
import { EnterpriseShell } from './EnterpriseShell';
import { CountrySelector } from './CountrySelector';
import {
  useCountry,
  useDomain,
  useTenantContext,
} from '@/lib/useOnboardingContext';
import { COUNTRIES, type CountryCode } from '@/lib/countries';
import {
  organizationsFor,
  ORGANIZATIONS,
  getOrganization,
  type OrganizationDef,
} from '@/lib/organizations';
import type { DomainChoice } from '@/lib/useOnboardingContext';

const schema = z.object({
  username: z.string().min(1, 'Username required'),
  password: z.string().min(1, 'Password required'),
  captcha_answer: z.string().optional(),
});
type FormData = z.infer<typeof schema>;

const REMEMBER_KEY = 'zorews.rememberMe';
const MFA_PREF_KEY = 'zorews.mfaToggle';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const idleSignOut = searchParams.get('reason') === 'idle';
  const login = useAuth((s) => s.login);
  const fetchCaptcha = useAuth((s) => s.fetchCaptcha);
  const status = useAuth((s) => s.status);
  const [serverError, setServerError] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState<CaptchaChallenge | null>(null);
  const [country, setCountry] = useCountry();
  const [domain, setDomain] = useDomain();
  const [tenantCtx, setTenantCtx] = useTenantContext();
  const [countryError, setCountryError] = useState<string | null>(null);
  const [remember, setRemember] = useState<boolean>(
    () => typeof window !== 'undefined' && window.localStorage.getItem(REMEMBER_KEY) === '1',
  );
  const [mfaPreferred, setMfaPreferred] = useState<boolean>(
    () => typeof window !== 'undefined' && window.localStorage.getItem(MFA_PREF_KEY) === '1',
  );
  // Inline domain + tenant selection (optional). When the user picks
  // both on the login form, we skip the post-login onboarding redirect.
  const [inlineDomain, setInlineDomain] = useState<DomainChoice | ''>(domain ?? '');
  const [inlineOrgId, setInlineOrgId] = useState<string>(tenantCtx?.organization_id ?? '');
  const { t } = useTranslation();

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  const fromPath =
    (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/';

  if (status === 'authenticated') {
    return <Navigate to={resumeTarget(domain, tenantCtx, fromPath)} replace />;
  }

  // ── tenant picker driven by country + domain ──────────────────
  const tenantOptions = useMemo<OrganizationDef[]>(() => {
    if (!country || !inlineDomain) return [];
    const scoped = organizationsFor(country, inlineDomain);
    return scoped.length > 0 ? scoped : ORGANIZATIONS.filter((o) => o.domain === inlineDomain);
  }, [country, inlineDomain]);

  const refreshCaptcha = async () => {
    try {
      const c = await fetchCaptcha();
      setCaptcha(c);
      setValue('captcha_answer', '');
    } catch {
      /* let the next submit re-trigger captcha_required */
    }
  };

  const onSubmit = handleSubmit(async ({ username, password, captcha_answer }) => {
    setServerError(null);
    setCountryError(null);
    if (!country) {
      setCountryError(t('login.country_required'));
      return;
    }
    const captchaPayload =
      captcha && captcha_answer && captcha_answer.trim()
        ? { id: captcha.id, answer: Number(captcha_answer.trim()) }
        : undefined;
    try {
      await login(username, password, captchaPayload);
      setCaptcha(null);
      try {
        if (remember) window.localStorage.setItem(REMEMBER_KEY, '1');
        else window.localStorage.removeItem(REMEMBER_KEY);
        if (mfaPreferred) window.localStorage.setItem(MFA_PREF_KEY, '1');
        else window.localStorage.removeItem(MFA_PREF_KEY);
      } catch {
        /* private mode — ignore */
      }
      // If the user filled in domain + tenant on the login form, persist
      // them so the resume target skips the onboarding pages.
      if (inlineDomain && inlineOrgId) {
        const org = getOrganization(inlineOrgId);
        if (org) {
          setDomain(inlineDomain);
          setTenantCtx({
            country,
            domain: inlineDomain,
            organization_id: org.id,
            region: org.regions[0] ?? '',
            branch: org.branches[org.regions[0]]?.[0] ?? '',
            tenant_id: org.tenant_id,
          });
        }
      } else if (inlineDomain) {
        setDomain(inlineDomain);
      }
      navigate(
        resumeTarget(inlineDomain || domain, inlineOrgId && inlineDomain ? { tenant_id: '' } : tenantCtx, fromPath),
        { replace: true },
      );
    } catch (err) {
      if (import.meta.env.DEV) console.error('login failed:', err);
      if (err instanceof HttpError) {
        const body = err.body as { error?: string; message?: string } | undefined;
        if (body?.error === 'captcha_required' || body?.error === 'captcha_failed') {
          await refreshCaptcha();
          setServerError(
            body.error === 'captcha_failed'
              ? t('login.captcha_failed')
              : t('login.captcha_required'),
          );
          return;
        }
        if (err.status === 0) setServerError(t('login.network_unreachable'));
        else if (err.status === 401) setServerError(t('login.invalid_credentials'));
        else if (err.status === 403) setServerError(t('login.locked_account'));
        else if (err.status === 429) setServerError(t('login.rate_limited'));
        else {
          const backendMsg = body?.message;
          setServerError(backendMsg ? `${t('login.generic_error')} (${backendMsg})` : t('login.generic_error'));
        }
      } else {
        setServerError(t('login.generic_error'));
      }
    }
  });

  function startSso(provider: 'okta' | 'azure_ad') {
    // OIDC backend isn't wired yet (Year-2 Theme A — see TASKS.md
    // T0.6 + docs/vendor-accounts.md). Surface a clear message so
    // the operator knows to use credentials for now.
    setServerError(
      provider === 'okta'
        ? 'Okta SSO is configured — contact your administrator to enable for your account.'
        : 'Azure AD SSO is configured — contact your administrator to enable for your account.',
    );
  }

  return (
    <EnterpriseShell tagline="AI-powered risk intelligence platform for Banking and Insurance">
      <div>
        <div className="mb-6">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-ews-orangeDeep mb-2">
            Sign in
          </p>
          <h2 className="font-display text-[26px] font-semibold text-ink tracking-tight leading-[1.1]">
            {t('login.heading')}
          </h2>
          <p className="text-[12.5px] text-sub mt-1.5">{t('login.subtitle')}</p>
        </div>

        {idleSignOut && (
          <div
            role="status"
            data-testid="idle-signout-banner"
            className="flex items-start gap-2 mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900"
          >
            <Clock size={14} className="mt-0.5 shrink-0 text-amber-600" strokeWidth={2} />
            <p>{t('login.idle_signed_out')}</p>
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-3" noValidate>
          {/* Country — mandatory */}
          <div>
            <FieldLabel required>{t('login.country_label')}</FieldLabel>
            <CountrySelector
              value={country}
              onChange={(c) => {
                setCountry(c);
                setCountryError(null);
              }}
              variant="light"
              invalid={!!countryError}
            />
            {countryError && (
              <p role="alert" data-testid="country-error" className="text-[11px] text-danger mt-1">
                {countryError}
              </p>
            )}
            {country && <CountryHint code={country} />}
          </div>

          {/* Domain + Tenant — paired row */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <FieldLabel>{t('login.domain_label')}</FieldLabel>
              <SelectField
                value={inlineDomain}
                onChange={(v) => {
                  setInlineDomain(v as DomainChoice | '');
                  setInlineOrgId('');
                }}
                options={[
                  { value: '', label: '— Auto —' },
                  { value: 'banking', label: 'Banking' },
                  { value: 'insurance', label: 'Insurance' },
                ]}
                testId="login-domain"
              />
            </div>
            <div>
              <FieldLabel>{t('login.tenant_label')}</FieldLabel>
              <SelectField
                value={inlineOrgId}
                disabled={!country || !inlineDomain}
                onChange={(v) => setInlineOrgId(v)}
                options={[
                  {
                    value: '',
                    label:
                      country && inlineDomain
                        ? '— Choose later —'
                        : 'Pick country + domain first',
                  },
                  ...tenantOptions.map((o) => ({ value: o.id, label: o.name })),
                ]}
                testId="login-tenant"
              />
            </div>
          </div>

          <Input
            {...register('username')}
            label={t('login.email_or_emp_id')}
            autoComplete="username"
            placeholder="alice.admin · or EMP-001234"
            error={errors.username?.message ?? ''}
            required
          />
          <Input
            {...register('password')}
            type="password"
            label={t('common.password')}
            autoComplete="current-password"
            placeholder="••••••••"
            error={errors.password?.message ?? ''}
            required
          />

          {/* MFA toggle + Remember + Forgot */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-0.5">
            <label className="inline-flex items-center gap-2 text-[12px] text-ink cursor-pointer select-none">
              <input
                type="checkbox"
                data-testid="remember-me"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-borderMed text-ews-orange focus:ring-ews-orange/40"
              />
              {t('login.remember_me')}
            </label>
            <label
              data-testid="mfa-toggle"
              className="inline-flex items-center gap-2 text-[12px] text-ink cursor-pointer select-none"
            >
              <input
                type="checkbox"
                data-testid="mfa-toggle-input"
                checked={mfaPreferred}
                onChange={(e) => setMfaPreferred(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-borderMed text-ews-orange focus:ring-ews-orange/40"
              />
              <span className="inline-flex items-center gap-1">
                <KeyRound size={11} className="text-ews-orangeDeep" />
                {t('login.mfa_preferred')}
              </span>
            </label>
            <Link
              to="/forgot-password"
              className="ml-auto text-[12px] text-ews-orangeDeep font-medium hover:underline focus:outline-none focus:ring-2 focus:ring-ews-orange/40 rounded"
            >
              {t('login.forgot_password')}
            </Link>
          </div>

          {serverError && (
            <p
              role="alert"
              className="text-[11px] text-danger bg-danger-bg border border-danger/20 rounded px-3 py-1.5"
            >
              {serverError}
            </p>
          )}

          {captcha && (
            <div
              data-testid="captcha-block"
              className="rounded border border-divider bg-surface-alt p-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-[12px] text-ink font-medium">{captcha.question}</p>
                <button
                  type="button"
                  onClick={refreshCaptcha}
                  aria-label={t('login.captcha_refresh')}
                  data-testid="captcha-refresh"
                  className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded border border-divider hover:bg-divider/60 transition-colors"
                >
                  <RefreshCw size={12} className="text-muted" />
                </button>
              </div>
              <Input
                {...register('captcha_answer')}
                type="number"
                inputMode="numeric"
                label={t('login.captcha_answer_label')}
                placeholder="…"
                error={errors.captcha_answer?.message ?? ''}
                data-testid="captcha-answer"
                required
              />
            </div>
          )}

          <Button
            type="submit"
            className="w-full !bg-ews-orange hover:!bg-ews-orangeDeep !text-white !border-ews-orangeDeep mt-1 font-semibold tracking-wide"
            loading={isSubmitting}
          >
            <ShieldCheck size={14} className="mr-2" strokeWidth={2.25} />
            {t('login.sign_in_secure')}
          </Button>

          {/* SSO row */}
          <div className="pt-3">
            <div className="flex items-center gap-3 text-[10.5px] uppercase tracking-[0.18em] text-muted">
              <span className="h-px flex-1 bg-ews-mist" />
              <span>{t('login.or_continue_with')}</span>
              <span className="h-px flex-1 bg-ews-mist" />
            </div>
            <div className="grid grid-cols-2 gap-2 mt-3">
              <SsoButton provider="okta" onClick={() => startSso('okta')} />
              <SsoButton provider="azure_ad" onClick={() => startSso('azure_ad')} />
            </div>
          </div>

          <p className="text-[10.5px] text-muted text-center pt-1 font-mono">
            {t('login.mfa_hint')}
          </p>
        </form>

        <p className="mt-5 text-center text-[12px] text-sub">
          {t('login.new_to_apex')}{' '}
          <Link
            to="/signup"
            className="text-ews-orangeDeep font-semibold hover:underline focus:outline-none focus:ring-2 focus:ring-ews-orange/40 rounded"
          >
            {t('login.create_account')}
          </Link>
        </p>

        <div className="mt-5 pt-4 border-t border-ews-mist">
          <p className="text-center text-[10.5px] text-muted font-mono">
            <span className="text-ink/60">{t('login.demo_accounts_label')} · </span>
            alice.admin · ravi.risk · fiona.field
          </p>
        </div>
      </div>
    </EnterpriseShell>
  );
}

// ── helpers ──────────────────────────────────────────────────────

function FieldLabel({
  children,
  required,
}: {
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <label className="text-[11px] font-medium text-ink mb-1.5 inline-flex items-center gap-1">
      {children}
      {required && (
        <span className="text-danger" aria-hidden>
          *
        </span>
      )}
    </label>
  );
}

function SelectField({
  value,
  onChange,
  options,
  disabled,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <select
      data-testid={testId}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'w-full h-11 px-2.5 rounded-input border border-border bg-white text-[12.5px] text-ink',
        'focus:outline-none focus:ring-2 focus:ring-ews-orange/40 focus:border-ews-orange',
        disabled && 'bg-divider/30 text-muted cursor-not-allowed',
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function SsoButton({
  provider,
  onClick,
}: {
  provider: 'okta' | 'azure_ad';
  onClick: () => void;
}) {
  const label = provider === 'okta' ? 'Okta SSO' : 'Azure AD';
  const initials = provider === 'okta' ? 'O' : 'A';
  return (
    <button
      type="button"
      data-testid={`sso-${provider}`}
      onClick={onClick}
      className={cn(
        'h-10 rounded-input border border-border bg-white text-[12.5px] text-ink font-medium',
        'flex items-center justify-center gap-2 transition-colors',
        'hover:border-ews-orangeDeep hover:bg-ews-orange/[0.04]',
        'focus:outline-none focus:ring-2 focus:ring-ews-orange/40',
      )}
    >
      <span
        className={cn(
          'h-5 w-5 rounded-sm flex items-center justify-center font-bold text-[10px]',
          provider === 'okta' ? 'bg-[#007DC1] text-white' : 'bg-[#0078D4] text-white',
        )}
      >
        {initials}
      </span>
      {label}
    </button>
  );
}

/** Renders the regulatory + locale hint under the country field. */
function CountryHint({ code }: { code: CountryCode }) {
  const c = COUNTRIES.find((x) => x.code === code);
  if (!c) return null;
  return (
    <p
      data-testid="country-hint"
      className="mt-1.5 text-[10.5px] font-mono text-muted leading-snug"
    >
      <span className="text-ink/70">{c.currency.code}</span>
      <span className="text-muted/70"> · </span>
      <span>{c.timezone.label}</span>
      <span className="text-muted/70"> · </span>
      <span>{c.regulators.banking[0]}</span>
      <span className="text-muted/70"> · </span>
      <span>{c.regulators.insurance[0]}</span>
    </p>
  );
}

/** Routing helper — figures out where to land after login based on
 *  whichever step of the 4-step onboarding the user has already
 *  completed (either inline on the login form or on a prior visit). */
function resumeTarget(
  domain: 'banking' | 'insurance' | null | '' | undefined,
  tenantCtx: { tenant_id: string } | null | undefined,
  fromPath: string,
): string {
  if (fromPath && fromPath !== '/' && fromPath !== '/login') return fromPath;
  if (!domain) return '/onboarding/domain';
  if (!tenantCtx || !tenantCtx.tenant_id) return '/onboarding/tenant';
  return '/';
}
