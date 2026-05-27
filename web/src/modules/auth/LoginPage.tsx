import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Clock, RefreshCw, ShieldCheck, KeyRound, Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth, type CaptchaChallenge } from '@/store/auth';
import { HttpError } from '@/lib/http';
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
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState<boolean>(
    () => typeof window !== 'undefined' && window.localStorage.getItem(REMEMBER_KEY) === '1',
  );
  const [mfaPreferred, setMfaPreferred] = useState<boolean>(
    () => typeof window !== 'undefined' && window.localStorage.getItem(MFA_PREF_KEY) === '1',
  );
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
    setServerError(
      provider === 'okta'
        ? 'Okta SSO is configured — contact your administrator to enable for your account.'
        : 'Azure AD SSO is configured — contact your administrator to enable for your account.',
    );
  }

  return (
    <EnterpriseShell tagline="Spot stress signals before they become NPAs, claims spikes, or solvency breaches. AI-powered early-warning for banks and insurers — one platform, two domains.">
      <div>
        <div className="mb-6">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-ews-orange mb-2">
            Sign in
          </p>
          <h2 className="text-[26px] font-bold text-ews-warmWhite tracking-tight leading-[1.1]">
            {t('login.heading')}
          </h2>
          <p className="text-[12.5px] text-ews-warmWhite/65 mt-1.5">{t('login.subtitle')}</p>
        </div>

        {idleSignOut && (
          <div
            role="status"
            data-testid="idle-signout-banner"
            className="flex items-start gap-2 mb-4 rounded border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-[12px] text-amber-200"
          >
            <Clock size={14} className="mt-0.5 shrink-0 text-amber-300" strokeWidth={2} />
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
              variant="dark"
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
              <DarkSelect
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
              <DarkSelect
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

          <DarkInput
            label={t('login.email_or_emp_id')}
            placeholder="alice.admin · or EMP-001234"
            autoComplete="username"
            error={errors.username?.message}
            required
            registerProps={register('username')}
          />
          <DarkInput
            label={t('common.password')}
            type={showPassword ? 'text' : 'password'}
            placeholder="••••••••"
            autoComplete="current-password"
            error={errors.password?.message}
            required
            registerProps={register('password')}
            trailingIcon={
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center w-7 h-7 rounded text-ews-warmWhite/60 hover:text-ews-warmWhite hover:bg-white/10 transition-colors"
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            }
          />

          {/* MFA toggle + Remember + Forgot */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-0.5">
            <label className="inline-flex items-center gap-2 text-[12px] text-ews-warmWhite/85 cursor-pointer select-none">
              <input
                type="checkbox"
                data-testid="remember-me"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-white/30 bg-ews-deepNavy text-ews-orange focus:ring-ews-orange/40"
              />
              {t('login.remember_me')}
            </label>
            <label
              data-testid="mfa-toggle"
              className="inline-flex items-center gap-2 text-[12px] text-ews-warmWhite/85 cursor-pointer select-none"
            >
              <input
                type="checkbox"
                data-testid="mfa-toggle-input"
                checked={mfaPreferred}
                onChange={(e) => setMfaPreferred(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-white/30 bg-ews-deepNavy text-ews-orange focus:ring-ews-orange/40"
              />
              <span className="inline-flex items-center gap-1">
                <KeyRound size={11} className="text-ews-orange" />
                {t('login.mfa_preferred')}
              </span>
            </label>
            <Link
              to="/forgot-password"
              className="ml-auto text-[12px] text-ews-orange font-medium hover:underline focus:outline-none focus:ring-2 focus:ring-ews-orange/40 rounded"
            >
              {t('login.forgot_password')}
            </Link>
          </div>

          {serverError && (
            <p
              role="alert"
              className="text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded px-3 py-1.5"
            >
              {serverError}
            </p>
          )}

          {captcha && (
            <div
              data-testid="captcha-block"
              className="rounded border border-white/12 bg-white/[0.04] p-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-[12px] text-ews-warmWhite font-medium">{captcha.question}</p>
                <button
                  type="button"
                  onClick={refreshCaptcha}
                  aria-label={t('login.captcha_refresh')}
                  data-testid="captcha-refresh"
                  className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded border border-white/15 text-ews-warmWhite/70 hover:text-ews-warmWhite hover:bg-white/10 transition-colors"
                >
                  <RefreshCw size={12} />
                </button>
              </div>
              <DarkInput
                label={t('login.captcha_answer_label')}
                type="number"
                inputMode="numeric"
                placeholder="…"
                error={errors.captcha_answer?.message}
                required
                testId="captcha-answer"
                registerProps={register('captcha_answer')}
              />
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className={cn(
              'w-full h-11 mt-1 rounded-input bg-ews-orange hover:bg-ews-orangeDeep',
              'text-white font-semibold tracking-wide text-[13px]',
              'inline-flex items-center justify-center gap-2',
              'shadow-[0_8px_22px_-10px_rgba(255,107,53,0.7)]',
              'focus:outline-none focus:ring-2 focus:ring-ews-orange/40',
              'disabled:opacity-50 disabled:cursor-not-allowed transition-colors',
            )}
          >
            <ShieldCheck size={14} strokeWidth={2.25} />
            {isSubmitting ? '…' : t('login.sign_in_secure')}
          </button>

          {/* SSO row */}
          <div className="pt-3">
            <div className="flex items-center gap-3 text-[10.5px] uppercase tracking-[0.18em] text-ews-warmWhite/55">
              <span className="h-px flex-1 bg-white/12" />
              <span>{t('login.or_continue_with')}</span>
              <span className="h-px flex-1 bg-white/12" />
            </div>
            <div className="grid grid-cols-2 gap-2 mt-3">
              <SsoButton provider="okta" onClick={() => startSso('okta')} />
              <SsoButton provider="azure_ad" onClick={() => startSso('azure_ad')} />
            </div>
          </div>

          <p className="text-[10.5px] text-ews-warmWhite/50 text-center pt-1 font-mono">
            {t('login.mfa_hint')}
          </p>
        </form>

        <p className="mt-5 text-center text-[12px] text-ews-warmWhite/65">
          {t('login.new_to_apex')}{' '}
          <Link
            to="/signup"
            className="text-ews-orange font-semibold hover:underline focus:outline-none focus:ring-2 focus:ring-ews-orange/40 rounded"
          >
            {t('login.create_account')}
          </Link>
        </p>

        <div className="mt-5 pt-4 border-t border-white/8">
          <p className="text-center text-[10.5px] text-ews-warmWhite/45 font-mono">
            <span className="text-ews-warmWhite/65">{t('login.demo_accounts_label')} · </span>
            alice.admin · ravi.risk · fiona.field
          </p>
        </div>
      </div>
    </EnterpriseShell>
  );
}

// ── form primitives — dark theme local to LoginPage ────────────────

// Renders as <span> (not <label>) so the wrapping <label> in DarkInput
// stays the single label element associated with the input — keeps
// `getByLabelText(/^password$/i)` matching the input cleanly. The
// required asterisk is a CSS `::after` pseudo so it shows visually
// but never appears in the label's textContent (testing-library's
// getByLabelText walks textContent, so a real `*` would break exact
// regex matches).
function FieldLabel({
  children,
  required,
}: {
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <span
      className={cn(
        'block text-[11px] font-medium text-ews-warmWhite/85 mb-1.5',
        required && "after:content-['*'] after:text-rose-400 after:ml-1",
      )}
    >
      {children}
    </span>
  );
}

interface DarkInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'ref'> {
  label?: string;
  error?: string;
  /** Pre-wired props from react-hook-form's register(). */
  registerProps?: ReturnType<
    ReturnType<typeof useForm<FormData>>['register']
  >;
  testId?: string;
  trailingIcon?: React.ReactNode;
}

function DarkInput({
  label,
  error,
  registerProps,
  testId,
  trailingIcon,
  className,
  ...rest
}: DarkInputProps) {
  return (
    <label className="block">
      {label && <FieldLabel required={rest.required}>{label}</FieldLabel>}
      <div className="relative">
        <input
          data-testid={testId}
          {...registerProps}
          {...rest}
          className={cn(
            'w-full h-11 px-3 text-[13px] rounded-input',
            'bg-ews-deepNavy/60 border border-white/12 text-ews-warmWhite',
            'placeholder:text-ews-warmWhite/35',
            'focus:outline-none focus:ring-2 focus:ring-ews-orange/30 focus:border-ews-orange/50',
            trailingIcon && 'pr-10',
            error && 'border-rose-400/60 focus:border-rose-400 focus:ring-rose-400/20',
            className,
          )}
        />
        {trailingIcon}
      </div>
      {error && <p className="text-[11px] text-rose-300 mt-1">{error}</p>}
    </label>
  );
}

function DarkSelect({
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
        'w-full h-11 px-2.5 rounded-input text-[12.5px]',
        'bg-ews-deepNavy/60 border border-white/12 text-ews-warmWhite',
        'focus:outline-none focus:ring-2 focus:ring-ews-orange/30 focus:border-ews-orange/50',
        disabled && 'opacity-50 cursor-not-allowed',
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-ews-deepNavy text-ews-warmWhite">
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
        'h-10 rounded-input border border-white/12 bg-white/[0.04]',
        'text-[12.5px] text-ews-warmWhite font-medium',
        'flex items-center justify-center gap-2 transition-colors',
        'hover:border-ews-orange/40 hover:bg-white/[0.08]',
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

/** Regulatory + locale hint under the country field. */
function CountryHint({ code }: { code: CountryCode }) {
  const c = COUNTRIES.find((x) => x.code === code);
  if (!c) return null;
  return (
    <p
      data-testid="country-hint"
      className="mt-1.5 text-[10.5px] font-mono text-ews-warmWhite/55 leading-snug"
    >
      <span className="text-ews-warmWhite/85">{c.currency.code}</span>
      <span className="text-ews-warmWhite/40"> · </span>
      <span>{c.timezone.label}</span>
      <span className="text-ews-warmWhite/40"> · </span>
      <span>{c.regulators.banking[0]}</span>
      <span className="text-ews-warmWhite/40"> · </span>
      <span>{c.regulators.insurance[0]}</span>
    </p>
  );
}

/** Resume target based on what step of onboarding is already complete. */
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
