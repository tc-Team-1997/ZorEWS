import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth, type PasswordResetConfirmResult } from '@/store/auth';
import { HttpError } from '@/lib/http';
import { Button, Input, PasswordStrength } from '@/components/ui';
import { CarouselPanel } from './CarouselPanel';

const schema = z
  .object({
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[a-z]/, 'Must include a lowercase letter')
      .regex(/[A-Z]/, 'Must include an uppercase letter')
      .regex(/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/, 'Must include a digit or symbol'),
    confirm_password: z.string(),
  })
  .refine((d) => d.password === d.confirm_password, {
    message: 'Passwords do not match',
    path: ['confirm_password'],
  });

type FormData = z.infer<typeof schema>;

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const confirmReset = useAuth((s) => s.confirmPasswordReset);
  const token = params.get('token') ?? '';
  const { t } = useTranslation();

  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<PasswordResetConfirmResult | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });
  const newPassword = watch('password') ?? '';

  if (!token) {
    return <Navigate to="/forgot-password" replace />;
  }

  const onSubmit = handleSubmit(async ({ password }) => {
    setServerError(null);
    try {
      const res = await confirmReset(token, password);
      setResult(res);
    } catch (err) {
      if (err instanceof HttpError) {
        const body = err.body as { error?: string; message?: string } | undefined;
        if (err.status === 400 && body?.error === 'invalid_or_expired_token') {
          setServerError(t('reset.expired'));
        } else if (body?.message) {
          setServerError(body.message);
        } else {
          setServerError(t('reset.generic_error'));
        }
      } else {
        setServerError(t('reset.generic_error'));
      }
    }
  });

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
              <h2 className="text-xl font-semibold text-ink mb-1 tracking-tight">
                {t('reset.success_heading')}
              </h2>
              <p className="text-[13px] text-sub mb-5">{result.message}</p>
              <Button
                type="button"
                className="w-full"
                onClick={() => navigate('/login', { replace: true })}
              >
                {t('reset.continue_to_signin')}
              </Button>
            </div>
          ) : (
            <>
              <h2 className="text-xl font-semibold text-ink mb-1 tracking-tight">
                {t('reset.heading')}
              </h2>
              <p className="text-[13px] text-sub mb-5">{t('reset.subtitle')}</p>

              <form onSubmit={onSubmit} className="space-y-3" noValidate>
                <div className="space-y-1.5">
                  <Input
                    {...register('password')}
                    type="password"
                    label={t('reset.new_password')}
                    autoComplete="new-password"
                    placeholder="••••••••"
                    error={errors.password?.message ?? ''}
                    required
                  />
                  <PasswordStrength password={newPassword} />
                </div>
                <Input
                  {...register('confirm_password')}
                  type="password"
                  label={t('reset.confirm_new_password')}
                  autoComplete="new-password"
                  placeholder="••••••••"
                  error={errors.confirm_password?.message ?? ''}
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
                  {t('reset.submit')}
                </Button>
              </form>

              <p className="mt-4 text-center text-[12px] text-sub">
                {t('reset.need_new_link')}{' '}
                <Link
                  to="/forgot-password"
                  className="text-action font-medium hover:underline focus:outline-none focus:ring-2 focus:ring-action/40 rounded"
                >
                  {t('reset.request_another')}
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
