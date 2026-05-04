import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link } from 'react-router-dom';
import { Check, Copy, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth, type PasswordResetRequestResult } from '@/store/auth';
import { HttpError } from '@/lib/http';
import { Button, Input } from '@/components/ui';
import { CarouselPanel } from './CarouselPanel';

const schema = z.object({
  // Accepts either a username or an email — the SPA auto-detects '@' and
  // posts the right field to the backend.
  identifier: z
    .string()
    .min(1, 'Username or email required')
    .max(254, 'Too long'),
});
type FormData = z.infer<typeof schema>;

export function ForgotPasswordPage() {
  const requestReset = useAuth((s) => s.requestPasswordReset);
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<PasswordResetRequestResult | null>(null);
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async ({ identifier }) => {
    setServerError(null);
    try {
      const res = await requestReset(identifier);
      setResult(res);
    } catch (err) {
      if (err instanceof HttpError) {
        setServerError(err.message || t('forgot.failure'));
      } else {
        setServerError(t('forgot.failure'));
      }
    }
  });

  const copyLink = async () => {
    const link = result?.debug?.reset_link;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked (e.g. http context) — leave the on-screen link as the fallback.
    }
  };

  return (
    <div className="min-h-screen flex bg-white">
      <div className="hidden lg:block lg:w-1/2">
        <CarouselPanel />
      </div>

      <div className="w-full lg:w-1/2 flex items-center justify-center px-6 py-6 relative bg-white overflow-hidden">
        <div
          className="absolute top-0 left-0 right-0 h-[46%] pointer-events-none opacity-60"
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(13,43,106,0.07) 1px, transparent 1px)',
            backgroundSize: '14px 14px',
            WebkitMaskImage:
              'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.9) 40%, rgba(0,0,0,0) 100%)',
            maskImage:
              'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0.9) 40%, rgba(0,0,0,0) 100%)',
          }}
        />

        <div className="w-full max-w-[400px] relative">
          <div className="flex items-center gap-2.5 mb-5 lg:hidden">
            <div className="w-8 h-8 bg-action rounded flex items-center justify-center">
              <ShieldCheck size={14} className="text-white" strokeWidth={2.25} />
            </div>
            <div>
              <p className="text-ink text-sm font-semibold leading-tight">APEX EWS</p>
              <p className="text-muted text-[11px]">Early Warning System</p>
            </div>
          </div>

          <div className="hidden lg:flex w-10 h-10 bg-brand-blue rounded-xl items-center justify-center mb-4 shadow-sm">
            <ShieldCheck size={18} className="text-white" strokeWidth={2} />
          </div>

          {result ? (
            <div>
              <h2 className="text-xl font-semibold text-ink mb-1 tracking-tight">{t('forgot.inbox_heading')}</h2>
              <p className="text-[13px] text-sub mb-5">{result.message}</p>

              {result.debug?.reset_link && (
                <div
                  data-testid="debug-reset-link"
                  className="rounded border border-divider bg-surface-alt p-4 mb-4"
                >
                  <p className="text-[11px] uppercase tracking-wide text-muted mb-2">
                    {t('forgot.prototype_link_label')}
                  </p>
                  <div className="flex items-center gap-2">
                    <a
                      href={result.debug.reset_link.replace(/^https?:\/\/[^/]+/, '')}
                      className="font-mono text-[12px] text-action break-all flex-1 hover:underline"
                    >
                      {result.debug.reset_link}
                    </a>
                    <button
                      type="button"
                      onClick={copyLink}
                      aria-label={t('forgot.copy_link')}
                      className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded border border-divider hover:bg-divider/60 transition-colors"
                    >
                      {copied ? (
                        <Check size={14} className="text-success" />
                      ) : (
                        <Copy size={14} className="text-muted" />
                      )}
                    </button>
                  </div>
                  <p className="text-[11px] text-muted mt-2 leading-relaxed">
                    {result.debug.expires_at
                      ? new Date(result.debug.expires_at).toLocaleString()
                      : t('forgot.expires_default')}
                    .
                  </p>
                </div>
              )}

              <Link to="/login" className="block">
                <Button type="button" variant="ghost" className="w-full">
                  {t('forgot.back_to_signin')}
                </Button>
              </Link>
            </div>
          ) : (
            <>
              <h2 className="text-xl font-semibold text-ink mb-1 tracking-tight">
                {t('forgot.heading')}
              </h2>
              <p className="text-[13px] text-sub mb-5">{t('forgot.subtitle')}</p>

              <form onSubmit={onSubmit} className="space-y-3" noValidate>
                <Input
                  {...register('identifier')}
                  label={t('forgot.identifier_label')}
                  autoComplete="username"
                  placeholder="your.username or you@example.com"
                  error={errors.identifier?.message ?? ''}
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

                <Button type="submit" className="w-full" loading={isSubmitting}>
                  {t('forgot.send_link')}
                </Button>
              </form>

              <p className="mt-4 text-center text-[12px] text-sub">
                {t('forgot.remember_it')}{' '}
                <Link
                  to="/login"
                  className="text-action font-medium hover:underline focus:outline-none focus:ring-2 focus:ring-action/40 rounded"
                >
                  {t('common.sign_in')}
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
