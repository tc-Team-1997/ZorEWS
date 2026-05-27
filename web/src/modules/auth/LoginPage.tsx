import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Clock, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth, type CaptchaChallenge } from '@/store/auth';
import { HttpError } from '@/lib/http';
import { Button, Input } from '@/components/ui';
import { EnterpriseShell } from './EnterpriseShell';
import { CountrySelector } from './CountrySelector';
import { useCountry, useDomain, useTenantContext } from '@/lib/useOnboardingContext';
import { COUNTRIES, type CountryCode } from '@/lib/countries';

const schema = z.object({
  username: z.string().min(1, 'Username required'),
  password: z.string().min(1, 'Password required'),
  captcha_answer: z.string().optional(),
});
type FormData = z.infer<typeof schema>;

const REMEMBER_KEY = 'zorews.rememberMe';

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
  const [domain] = useDomain();
  const [tenantCtx] = useTenantContext();
  const [countryError, setCountryError] = useState<string | null>(null);
  const [remember, setRemember] = useState<boolean>(
    () => typeof window !== 'undefined' && window.localStorage.getItem(REMEMBER_KEY) === '1',
  );
  const { t } = useTranslation();

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  const fromPath =
    (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/';

  if (status === 'authenticated') return <Navigate to={resumeTarget(domain, tenantCtx, fromPath)} replace />;

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
      } catch {
        /* private mode — ignore */
      }
      navigate(resumeTarget(domain, tenantCtx, fromPath), { replace: true });
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

  return (
    <EnterpriseShell tagline="AI-Powered Risk Intelligence Platform">
      <div>
        <div className="mb-8">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-ews-orangeDeep mb-3">
            Sign in
          </p>
          <h2 className="font-display text-[28px] font-semibold text-ink tracking-tight leading-[1.1]">
            {t('login.heading')}
          </h2>
          <p className="text-[13px] text-sub mt-2">{t('login.subtitle')}</p>
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

        <form onSubmit={onSubmit} className="space-y-3.5" noValidate>
          {/* Country — mandatory, first field */}
          <div>
            <label
              htmlFor="country-selector-trigger"
              className="text-[11px] font-medium text-ink mb-1.5 inline-flex items-center gap-1"
            >
              {t('login.country_label')}
              <span className="text-danger" aria-hidden>*</span>
            </label>
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

          <Input
            {...register('username')}
            label={t('common.username')}
            autoComplete="username"
            placeholder="your.username"
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

          <div className="flex items-center justify-between pt-1">
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
            <Link
              to="/forgot-password"
              className="text-[12px] text-ews-orangeDeep font-medium hover:underline focus:outline-none focus:ring-2 focus:ring-ews-orange/40 rounded"
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
            className="w-full !bg-ews-orange hover:!bg-ews-orangeDeep !text-white !border-ews-orangeDeep mt-2 font-semibold tracking-wide"
            loading={isSubmitting}
          >
            {t('login.sign_in_secure')}
          </Button>

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

        <div className="mt-6 pt-5 border-t border-ews-mist">
          <p className="text-center text-[10.5px] text-muted font-mono">
            <span className="text-ink/60">{t('login.demo_accounts_label')} · </span>
            alice.admin · ravi.risk · fiona.field
          </p>
        </div>
      </div>
    </EnterpriseShell>
  );
}

/** Renders the regulatory + locale hint under the country field once
 *  a country has been chosen — keeps the selector feeling alive. */
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
 *  completed in a prior session. */
function resumeTarget(
  domain: 'banking' | 'insurance' | null,
  tenantCtx: ReturnType<typeof useTenantContext>[0],
  fromPath: string,
): string {
  // If the user was deep-linked into a protected page, ALWAYS prefer
  // sending them there. Onboarding redirect runs once on a clean
  // /login → / round trip.
  if (fromPath && fromPath !== '/' && fromPath !== '/login') return fromPath;
  if (!domain) return '/onboarding/domain';
  if (!tenantCtx) return '/onboarding/tenant';
  return '/';
}
