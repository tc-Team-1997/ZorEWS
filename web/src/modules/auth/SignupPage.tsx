import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { useAuth, type Role, type SignupResult } from '@/store/auth';
import { HttpError } from '@/lib/http';
import { Button, Input, PasswordStrength } from '@/components/ui';
import { CarouselPanel } from './CarouselPanel';

const ROLES: { value: Role; label: string; description: string }[] = [
  { value: 'risk_analyst', label: 'Risk analyst', description: 'Triage alerts, manage rules' },
  { value: 'field_officer', label: 'Field officer', description: 'Customer visits, GPS-stamped actions' },
  { value: 'collection_officer', label: 'Collection officer', description: 'Collection workflow + callbacks' },
  { value: 'supervisor', label: 'Supervisor', description: 'Approves cases, oversight (admin-approval in prod)' },
  { value: 'admin', label: 'Administrator', description: 'Full system access (admin-approval in prod)' },
];

const schema = z
  .object({
    display_name: z.string().min(2, 'Full name required'),
    username: z
      .string()
      .min(3, 'Username must be at least 3 characters')
      .max(32, 'Username must be 32 characters or fewer')
      .regex(/^[a-z][a-z0-9._-]+$/, 'Lowercase, start with a letter, [a-z0-9._-]'),
    email: z
      .string()
      .min(1, 'Email required')
      .email('Enter a valid email address'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[a-z]/, 'Must include a lowercase letter')
      .regex(/[A-Z]/, 'Must include an uppercase letter')
      .regex(/[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/, 'Must include a digit or symbol'),
    confirm_password: z.string(),
    role: z.enum(['admin', 'risk_analyst', 'supervisor', 'collection_officer', 'field_officer']),
  })
  .refine((d) => d.password === d.confirm_password, {
    message: 'Passwords do not match',
    path: ['confirm_password'],
  });

type FormData = z.infer<typeof schema>;

export function SignupPage() {
  const navigate = useNavigate();
  const signup = useAuth((s) => s.signup);
  const status = useAuth((s) => s.status);
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<SignupResult | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { role: 'risk_analyst' },
  });
  const newPassword = watch('password') ?? '';

  if (status === 'authenticated') return <Navigate to="/" replace />;

  const onSubmit = handleSubmit(async (data) => {
    setServerError(null);
    try {
      const res = await signup({
        username: data.username,
        email: data.email,
        password: data.password,
        display_name: data.display_name,
        role: data.role,
      });
      setResult(res);
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        setServerError('That username is already taken. Try a different one.');
      } else if (err instanceof HttpError && err.status === 400) {
        const body = err.body as { error?: string; message?: string } | undefined;
        setServerError(body?.message ?? 'Please check the form and try again.');
      } else {
        setServerError('Sign-up failed. Please try again.');
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
              <h2 className="text-xl font-semibold text-ink mb-1 tracking-tight">Account created</h2>
              <p className="text-[13px] text-sub mb-5">
                Welcome, <span className="font-medium text-ink">{result.user.display_name}</span>.
                Sign in with your username and password to continue.
              </p>

              <div className="rounded border border-divider bg-surface-alt p-4 mb-4">
                <p className="text-[11px] uppercase tracking-wide text-muted mb-1">Username</p>
                <p
                  data-testid="created-username"
                  className="font-mono text-[13px] text-ink break-all"
                >
                  {result.user.username}
                </p>
              </div>

              <Button type="button" className="w-full" onClick={() => navigate('/login', { replace: true })}>
                Continue to sign in
              </Button>
            </div>
          ) : (
            <>
              <h2 className="text-xl font-semibold text-ink mb-1 tracking-tight">Create account</h2>
              <p className="text-[13px] text-sub mb-5">
                Self-service sign-up — admin/supervisor accounts require approval in production.
              </p>

              <form onSubmit={onSubmit} className="space-y-3" noValidate>
                <Input
                  {...register('display_name')}
                  label="Full name"
                  autoComplete="name"
                  placeholder="Tina Tester"
                  error={errors.display_name?.message ?? ''}
                  required
                />
                <Input
                  {...register('username')}
                  label="Username"
                  autoComplete="username"
                  placeholder="your.username"
                  error={errors.username?.message ?? ''}
                  required
                />
                <Input
                  {...register('email')}
                  type="email"
                  label="Email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  error={errors.email?.message ?? ''}
                  required
                />

                <label className="block">
                  <span className="label">Role</span>
                  <select
                    {...register('role')}
                    className="input"
                    aria-invalid={errors.role ? 'true' : 'false'}
                  >
                    {ROLES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label} — {r.description}
                      </option>
                    ))}
                  </select>
                  {errors.role && <span className="field-error">{errors.role.message}</span>}
                </label>

                <div className="space-y-1.5">
                  <Input
                    {...register('password')}
                    type="password"
                    label="Password"
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
                  label="Confirm password"
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
                  Create account
                </Button>
              </form>

              <p className="mt-4 text-center text-[12px] text-sub">
                Already have an account?{' '}
                <Link
                  to="/login"
                  className="text-action font-medium hover:underline focus:outline-none focus:ring-2 focus:ring-action/40 rounded"
                >
                  Sign in
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
