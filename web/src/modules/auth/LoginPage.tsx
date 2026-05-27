import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ShieldCheck, Clock, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth, type CaptchaChallenge } from '@/store/auth';
import { HttpError } from '@/lib/http';
import { Button, Input } from '@/components/ui';
import { CarouselPanel } from './CarouselPanel';

const schema = z.object({
  username: z.string().min(1, 'Username required'),
  password: z.string().min(1, 'Password required'),
  captcha_answer: z.string().optional(),
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
  // CAPTCHA challenge from the backend, surfaced after 2+ failed attempts.
  // Cleared when the user successfully signs in.
  const [captcha, setCaptcha] = useState<CaptchaChallenge | null>(null);
  const { t } = useTranslation();

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  // RequireAuth pushes the user to /login with state={from: <originalLocation>}
  // when they hit a protected route while logged out. Send them back there
  // after authenticating instead of dropping them on the dashboard.
  const fromPath =
    (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/';

  if (status === 'authenticated') return <Navigate to={fromPath} replace />;

  const refreshCaptcha = async () => {
    try {
      const c = await fetchCaptcha();
      setCaptcha(c);
      setValue('captcha_answer', '');
    } catch {
      // Backend down — let the user retry by submitting again; the next
      // captcha_required will trigger a fresh fetch.
    }
  };

  const onSubmit = handleSubmit(async ({ username, password, captcha_answer }) => {
    setServerError(null);
    const captchaPayload =
      captcha && captcha_answer && captcha_answer.trim()
        ? { id: captcha.id, answer: Number(captcha_answer.trim()) }
        : undefined;
    try {
      await login(username, password, captchaPayload);
      setCaptcha(null);
      navigate(fromPath, { replace: true });
    } catch (err) {
      // In dev, surface the actual failure to the console so the user
      // can debug — the inline message is intentionally short.
      if (import.meta.env.DEV) console.error('login failed:', err);
      if (err instanceof HttpError) {
        const body = err.body as { error?: string; message?: string } | undefined;
        if (body?.error === 'captcha_required' || body?.error === 'captcha_failed') {
          // Backend wants a (fresh) captcha — fetch and render. The
          // existing typed creds stay in the form so the user only has
          // to add the answer and resubmit.
          await refreshCaptcha();
          setServerError(
            body.error === 'captcha_failed'
              ? t('login.captcha_failed')
              : t('login.captcha_required'),
          );
          return;
        }
        // status 0 means the request never reached a backend (MSW worker
        // not registered, dev server stopped, etc.) — generic_error is
        // misleading here since the credentials weren't even checked.
        if (err.status === 0) {
          setServerError(t('login.network_unreachable'));
        } else if (err.status === 401) {
          setServerError(t('login.invalid_credentials'));
        } else if (err.status === 403) {
          setServerError(t('login.locked_account'));
        } else if (err.status === 429) {
          setServerError(t('login.rate_limited'));
        } else {
          // Last-resort: include the backend's own message if present so
          // the user has SOMETHING actionable rather than a stock string.
          const backendMsg = body?.message;
          setServerError(backendMsg ? `${t('login.generic_error')} (${backendMsg})` : t('login.generic_error'));
        }
      } else {
        setServerError(t('login.generic_error'));
      }
    }
  });

  return (
    <div className="min-h-screen flex bg-white">
      <div className="hidden lg:block lg:w-1/2">
        <CarouselPanel />
      </div>

      <div className="w-full lg:w-1/2 flex items-center justify-center px-6 py-4 relative bg-white overflow-hidden">
        <div
          className="absolute top-0 left-0 right-0 h-[46%] pointer-events-none opacity-60"
          style={{
            backgroundImage:
              'radial-gradient(circle, rgba(13,43,106,0.07) 1px, transparent 1px)',
            backgroundSize: '14px 14px',
            WebkitMaskImage:
              'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.9) 40%, rgba(0,0,0,0) 100%)',
            maskImage:
              'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.9) 40%, rgba(0,0,0,0) 100%)',
          }}
        />

        <div className="w-full max-w-[360px] relative">
          <div className="flex items-center gap-2.5 mb-5 lg:hidden">
            <div className="w-8 h-8 bg-action rounded flex items-center justify-center">
              <ShieldCheck size={14} className="text-white" strokeWidth={2.25} />
            </div>
            <div>
              <p className="text-ink text-sm font-semibold leading-tight">ZorEWS</p>
              <p className="text-muted text-[11px]">Early Warning System</p>
            </div>
          </div>

          <div className="hidden lg:flex w-10 h-10 bg-brand-blue rounded-xl items-center justify-center mb-4 shadow-sm">
            <ShieldCheck size={18} className="text-white" strokeWidth={2} />
          </div>

          <h2 className="text-xl font-semibold text-ink mb-1 tracking-tight">{t('login.heading')}</h2>
          <p className="text-[13px] text-sub mb-5">{t('login.subtitle')}</p>

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

          <div className="mt-4 pt-4 border-t border-divider">
            <p className="text-center text-[11px] text-muted">
              {t('login.demo_accounts_label')} · <span className="font-mono">alice.admin</span>{' '}
              · <span className="font-mono">ravi.risk</span>{' '}
              · <span className="font-mono">fiona.field</span> · {t('login.demo_passwords_in_seed')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
