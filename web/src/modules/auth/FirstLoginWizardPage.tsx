import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Navigate, useNavigate } from 'react-router-dom';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/store/auth';
import { HttpError } from '@/lib/http';
import { Button, Input, PasswordStrength } from '@/components/ui';

function makeSchema(t: (key: string) => string) {
  return z
    .object({
      password: z
        .string()
        .min(8, 'Password must be at least 8 characters')
        .regex(/[a-z]/, 'Must include a lowercase letter')
        .regex(/[A-Z]/, 'Must include an uppercase letter')
        .regex(/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/, 'Must include a digit or symbol'),
      confirm_password: z.string(),
      accept_terms: z.literal(true, {
        errorMap: () => ({ message: t('first_login.must_accept_terms') }),
      }),
    })
    .refine((d) => d.password === d.confirm_password, {
      message: 'Passwords do not match',
      path: ['confirm_password'],
    });
}

type FormData = z.infer<ReturnType<typeof makeSchema>>;

export function FirstLoginWizardPage() {
  const navigate = useNavigate();
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  const completeFirstLogin = useAuth((s) => s.completeFirstLogin);
  const [serverError, setServerError] = useState<string | null>(null);
  const { t } = useTranslation();
  const schema = makeSchema(t);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });
  const newPassword = watch('password') ?? '';

  // The route is reachable only via RequireAuth's redirect, but defend
  // against direct navigation when not signed in OR when the wizard is
  // not actually required.
  if (status !== 'authenticated') return <Navigate to="/login" replace />;
  if (!user?.must_change_password) return <Navigate to="/" replace />;

  const onSubmit = handleSubmit(async ({ password }) => {
    setServerError(null);
    try {
      await completeFirstLogin(password);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof HttpError) {
        const body = err.body as { error?: string; message?: string } | undefined;
        if (body?.error === 'password_reused') {
          setServerError(body.message ?? t('first_login.password_reused'));
        } else if (body?.message) {
          setServerError(body.message);
        } else {
          setServerError(t('first_login.generic_error'));
        }
      } else {
        setServerError(t('first_login.generic_error'));
      }
    }
  });

  return (
    <div className="min-h-screen aurora-canvas flex items-center justify-center px-6 py-10">
      <div
        className="glass-card aurora-rise w-full max-w-[440px] p-8"
        data-testid="first-login-wizard"
      >
        <div className="flex items-center gap-2.5 mb-5">
          <div className="w-9 h-9 bg-brand-blue rounded-lg flex items-center justify-center shadow-sm">
            <ShieldCheck size={16} className="text-white" strokeWidth={2.25} />
          </div>
          <div>
            <p className="text-ink text-sm font-semibold leading-tight">ZorEWS</p>
            <p className="text-muted text-[11px]">{t('first_login.welcome')} {user.display_name ?? user.username}</p>
          </div>
        </div>

        <h1 className="text-xl font-semibold text-ink mb-1 tracking-tight">
          {t('first_login.heading')}
        </h1>
        <p className="text-[13px] text-sub mb-5">{t('first_login.subtitle')}</p>

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

          <label className="flex items-start gap-2 mt-2 cursor-pointer">
            <input
              {...register('accept_terms')}
              type="checkbox"
              className="mt-0.5 accent-action"
              data-testid="accept-terms"
            />
            <span className="text-[12px] text-sub leading-snug">
              {t('first_login.accept_terms')}
            </span>
          </label>
          {errors.accept_terms && (
            <span className="field-error block">{errors.accept_terms.message}</span>
          )}

          {serverError && (
            <p
              role="alert"
              className="text-[11px] text-danger bg-danger-bg border border-danger/20 rounded px-3 py-1.5"
            >
              {serverError}
            </p>
          )}

          <Button
            type="submit"
            className="w-full mt-2"
            loading={isSubmitting}
            data-testid="first-login-submit"
          >
            <CheckCircle2 size={14} className="mr-1.5" />
            {t('first_login.submit')}
          </Button>
        </form>
      </div>
    </div>
  );
}
