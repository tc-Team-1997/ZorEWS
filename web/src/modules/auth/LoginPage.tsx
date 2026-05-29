import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ShieldCheck, Clock, RefreshCw, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth, type CaptchaChallenge } from '@/store/auth';
import { HttpError } from '@/lib/http';
import { Button, GlassCard, Input } from '@/components/ui';
import { AuroraIntelPanel } from './AuroraIntelPanel';
import { COUNTRIES, type CountryCode } from '@/lib/countries';
import {
  ORGANIZATIONS,
  organizationsFor,
  getOrganization,
} from '@/lib/organizations';
import { useCountry, useDomain, useTenantContext } from '@/lib/useOnboardingContext';

const schema = z.object({
  username: z.string().min(1, 'Username required'),
  password: z.string().min(1, 'Password required'),
  captcha_answer: z.string().optional(),
  country: z.string().min(1, 'Country required'),
  domain: z.enum(['banking', 'insurance']),
  tenant_id: z.string().min(1, 'Organization required'),
  remember: z.boolean().optional(),
});
type FormData = z.infer<typeof schema>;

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
  const { t } = useTranslation();

  // Context selectors are stored via the same hooks the rest of the app +
  // the RequireOnboarding gate read — so setting them here on a successful
  // sign-in means the gate passes immediately and no separate onboarding
  // screen is shown. Everything stays on this one card.
  const [storedCountry, setCountry] = useCountry();
  const [storedDomain, setDomain] = useDomain();
  const [storedTenant, setTenantCtx] = useTenantContext();

  const defaultCountry = (storedCountry ?? 'IN') as CountryCode;
  const defaultDomain: 'banking' | 'insurance' = storedDomain ?? 'banking';
  const defaultTenant =
    storedTenant?.organization_id ??
    organizationsFor(defaultCountry, defaultDomain)[0]?.id ??
    '';

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      country: defaultCountry,
      domain: defaultDomain,
      tenant_id: defaultTenant,
      remember: true,
    },
  });

  const country = watch('country');
  const domain = watch('domain');

  // Tenant options follow the chosen domain (+ country). Falls back to the
  // global domain catalogue when a country has no tenant configured.
  const tenantOptions = useMemo(() => {
    const scoped = organizationsFor(country as CountryCode, domain);
    return scoped.length > 0 ? scoped : ORGANIZATIONS.filter((o) => o.domain === domain);
  }, [country, domain]);

  // Keep the tenant selection valid as domain/country change.
  useEffect(() => {
    const current = getValues('tenant_id');
    if (!tenantOptions.some((o) => o.id === current)) {
      setValue('tenant_id', tenantOptions[0]?.id ?? '', { shouldValidate: true });
    }
  }, [tenantOptions, getValues, setValue]);

  const fromPath =
    (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/';

  if (status === 'authenticated') {
    // Already signed in → honour a deep-link return, else route to the
    // stored domain workspace (gate handles the rest when context is unset).
    const target =
      fromPath !== '/'
        ? fromPath
        : storedDomain === 'insurance'
          ? '/insurance/dashboard'
          : storedDomain === 'banking'
            ? '/banking/dashboard'
            : '/';
    return <Navigate to={target} replace />;
  }

  const refreshCaptcha = async () => {
    try {
      const c = await fetchCaptcha();
      setCaptcha(c);
      setValue('captcha_answer', '');
    } catch {
      /* backend down — next captcha_required retriggers a fetch */
    }
  };

  const onSubmit = handleSubmit(
    async ({ username, password, captcha_answer, country, domain, tenant_id, remember }) => {
      setServerError(null);
      const captchaPayload =
        captcha && captcha_answer && captcha_answer.trim()
          ? { id: captcha.id, answer: Number(captcha_answer.trim()) }
          : undefined;
      try {
        await login(username, password, captchaPayload);
        setCaptcha(null);

        // Persist the chosen context (same storage the gate + app read).
        setCountry(country as CountryCode);
        setDomain(domain);
        const org = getOrganization(tenant_id);
        if (org) {
          const region = org.regions[0] ?? 'HQ';
          const branch = org.branches[region]?.[0] ?? 'HQ';
          setTenantCtx({
            country: country as CountryCode,
            domain,
            organization_id: org.id,
            region,
            branch,
            tenant_id: org.tenant_id,
          });
        }
        try {
          window.localStorage.setItem('zorews.rememberMe', remember ? '1' : '0');
        } catch {
          /* private mode — best effort */
        }

        // Domain-aware redirect; deep-link return wins when present.
        const dest =
          fromPath !== '/'
            ? fromPath
            : domain === 'insurance'
              ? '/insurance/dashboard'
              : '/banking/dashboard';
        navigate(dest, { replace: true });
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
          if (err.status === 0) {
            setServerError(t('login.network_unreachable'));
          } else if (err.status === 401) {
            setServerError(t('login.invalid_credentials'));
          } else if (err.status === 403) {
            setServerError(t('login.locked_account'));
          } else if (err.status === 429) {
            setServerError(t('login.rate_limited'));
          } else {
            const backendMsg = body?.message;
            setServerError(
              backendMsg ? `${t('login.generic_error')} (${backendMsg})` : t('login.generic_error'),
            );
          }
        } else {
          setServerError(t('login.generic_error'));
        }
      }
    },
  );

  return (
    <div className="min-h-screen flex aurora-canvas">
      <div className="hidden lg:block lg:w-[52%]">
        <AuroraIntelPanel />
      </div>

      <div className="w-full lg:w-[48%] flex items-center justify-center px-6 py-8">
        <GlassCard rise className="w-full max-w-[400px] p-7 sm:p-9">
          <div className="flex items-center gap-2.5 mb-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-aurora-indigo to-aurora-violet shadow-glow">
              <ShieldCheck size={18} className="text-white" strokeWidth={2} />
            </div>
            <div>
              <p className="text-[14px] font-semibold text-aurora-ink leading-tight">ZorEWS</p>
              <p className="text-[11px] text-aurora-ink-sub">Early Warning System</p>
            </div>
          </div>

          <span className="aurora-chip mb-3">
            <Sparkles size={12} /> Secure access
          </span>
          <h2 className="text-[22px] font-semibold text-aurora-ink mb-1 tracking-tight">{t('login.heading')}</h2>
          <p className="text-[13px] text-aurora-ink-sub mb-5">{t('login.subtitle')}</p>

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

            {/* Country */}
            <label className="block">
              <span className="label">{t('login.country_label')}</span>
              <select {...register('country')} className="input" data-testid="login-country">
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.flag} {c.name}
                  </option>
                ))}
              </select>
            </label>

            {/* Domain + Tenant side by side */}
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="label">{t('login.domain_label')}</span>
                <select {...register('domain')} className="input" data-testid="login-domain">
                  <option value="banking">Banking</option>
                  <option value="insurance">Insurance</option>
                </select>
              </label>
              <label className="block">
                <span className="label">{t('login.tenant_label')}</span>
                <select {...register('tenant_id')} className="input" data-testid="login-tenant">
                  {tenantOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.short_name}
                    </option>
                  ))}
                </select>
              </label>
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

            {/* Remember me */}
            <label className="flex items-center gap-2 text-[12.5px] text-sub select-none">
              <input
                type="checkbox"
                {...register('remember')}
                data-testid="login-remember"
                className="h-3.5 w-3.5 rounded border-divider text-action focus:ring-action/40"
              />
              {t('login.remember_me')}
            </label>

            <Button type="submit" className="w-full" loading={isSubmitting}>
              {t('common.sign_in')}
            </Button>
          </form>

          <p className="mt-3 text-center text-[12px] text-sub">
            <Link
              to="/forgot-password"
              className="text-action font-medium hover:underline focus:outline-none focus:ring-2 focus:ring-action/40 rounded"
            >
              {t('login.forgot_password')}
            </Link>
          </p>

          <p className="mt-2 text-center text-[12px] text-sub">
            {t('login.new_to_apex')}{' '}
            <Link
              to="/signup"
              className="text-action font-medium hover:underline focus:outline-none focus:ring-2 focus:ring-action/40 rounded"
            >
              {t('login.create_account')}
            </Link>
          </p>

          <div className="mt-4 pt-4 border-t border-aurora-line">
            <p className="text-center text-[11px] text-muted">
              {t('login.demo_accounts_label')} · <span className="font-mono">alice.admin</span>{' '}
              · <span className="font-mono">ravi.risk</span>{' '}
              · <span className="font-mono">fiona.field</span> · {t('login.demo_passwords_in_seed')}
            </p>
          </div>
        </GlassCard>
      </div>
    </div>
  );
}
